/**
 * Sealed use (Part 12.3) + answer check (12.6). Sealed text is decrypted only in this process, in memory,
 * for one request. The caller only ever receives the checked answer and a source count.
 */
import type { Queryable } from '../db/index.ts';
import { vec } from '../db/index.ts';
import { allowedItems, type Requester } from './policy.ts';
import { embed, embedOne } from '../ai/llm.ts';
import { sealedAnswer, judgeAnswer, sentences, type AnswerPolicy } from '../ai/tasks.ts';
import { KeyRing } from '../crypto/keys.ts';
import { verbatimOverlap } from './checks.ts';
import { cosine, uuidv7, sha256, HttpError } from '../util.ts';
import { currentPromptVersions, tracePrompts } from '../ai/prompts.ts';
import { inc } from './metrics.ts';

export const ANSWER_CHECK = { maxQuotedTokens: 12, maxNgramOverlap: 0.2, minTokensForNgram: 20, semanticThreshold: 0.75, neededSim: 0.3, factsOnlyMaxSentences: 2 };
const POLICY_RANK: Record<AnswerPolicy, number> = { yes_no: 0, facts_only: 1, summary: 2 };

export interface CheckResult { pass: boolean; failures: string[] }

export async function answerCheck(question: string, answer: string, policy: AnswerPolicy, all: { text: string; vector?: number[]; qsim: number }[]): Promise<CheckResult> {
  const failures: string[] = [];
  // 4. Policy shape
  if (policy === 'yes_no' && !/^(yes|no|unknown)\.?$/i.test(answer.trim())) failures.push('shape:yes_no');
  if (policy === 'facts_only' && sentences(answer).length > ANSWER_CHECK.factsOnlyMaxSentences) failures.push('shape:too_long');
  // 1. Verbatim overlap
  const v = verbatimOverlap(answer, all.map((s) => s.text));
  if (v.longestRun > ANSWER_CHECK.maxQuotedTokens) failures.push(`verbatim:run_${v.longestRun}`);
  // The 8-gram ratio is only meaningful once an answer is long enough to quote; a minimal fact answer
  // necessarily overlaps the block's own "Key facts" line, and is bounded by the 12-token run rule above.
  if (v.answerTokens >= ANSWER_CHECK.minTokensForNgram && v.ngramOverlap > ANSWER_CHECK.maxNgramOverlap) failures.push(`verbatim:ngram_${v.ngramOverlap.toFixed(2)}`);
  // 2. Semantic over-disclosure against sections not needed for the question
  const unneeded = all.filter((s) => s.qsim < ANSWER_CHECK.neededSim && s.vector);
  if (unneeded.length && answer.trim()) {
    const av = await embedOne(answer);
    for (const s of unneeded) if (cosine(av, s.vector!) >= ANSWER_CHECK.semanticThreshold) { failures.push('semantic:unrelated_section'); break; }
  }
  // 3. LLM judge
  if (!failures.length && policy !== 'yes_no') {
    const j = await judgeAnswer(question, answer, all.map((s) => s.text), policy);
    if (j.reveals_more_than_needed) failures.push('judge');
  }
  return { pass: !failures.length, failures };
}

export async function askSealed(q: Queryable, r: Requester, question: string) {
  return tracePrompts(() => askSealedInner(q, r, question));
}
async function askSealedInner(q: Queryable, r: Requester, question: string) {
  const t0 = Date.now();
  if (!r.scopes.includes('ask_sealed')) throw new HttpError(403, 'forbidden_scope', 'Token lacks ask_sealed scope');
  // Probing guard: many refusals in a short window → refuse further questions for a while.
  if (r.kind === 'connection') {
    const recent = (await q.query(`SELECT COUNT(*)::int AS n FROM access_logs WHERE connection_id=$1 AND channel='sealed' AND created_at > now() - interval '10 minutes' AND (decision->>'refused')::boolean = true`, [r.id]))[0].n;
    if (recent >= 6) return { answer: '', refused: true, sources: '0 sealed block(s)', refusal_reason: 'Too many refused questions; try again later.' };
  }
  const A = await allowedItems(q, r, 'sealed', new Date());
  // Sealed use answers only from sealed_use material (12.3); viewable/agent-only items are allowed as text but not used here.
  const items = A.items.filter((i) => i.form === 'sealed_input');
  const finish = async (res: { answer: string; refused: boolean; refusal_reason?: string }, blockIds: string[], failures: string[] = []) => {
    const versions = blockIds.length ? Object.fromEntries((await q.query('SELECT b.id, v.version_no FROM blocks b JOIN block_versions v ON v.id=b.current_version_id WHERE b.id = ANY($1::uuid[])', [blockIds])).map((x) => [x.id, x.version_no])) : {};
    await q.query(`INSERT INTO access_logs(id, workspace_id, connection_id, user_id, channel, tool, request_hash, block_ids, withheld_count, decision, latency_ms, block_versions) VALUES ($1,$2,$3,$4,'sealed','ask_sealed',$5,$6,$7,$8,$9,$10)`,
      [uuidv7(), r.workspace_id, r.kind === 'connection' ? r.id : null, r.user_id ?? null, sha256(question), blockIds, A.withheld.length,
        JSON.stringify({ refused: res.refused, failures, prompt_versions: currentPromptVersions() ?? undefined }), Date.now() - t0, JSON.stringify(versions)]);
    inc('embargo_sealed_answers_total', { outcome: res.refused ? (failures.length ? 'refused_by_check' : 'refused') : 'answered' }, 1, 'ask_sealed outcomes (answer check)');
    return { answer: res.refused ? '' : res.answer, refused: res.refused, sources: `${blockIds.length} sealed block(s)`, ...(res.refused ? { refusal_reason: res.refusal_reason ?? 'Cannot answer from sealed material.' } : {}) };
  };
  if (!items.length) return finish({ answer: '', refused: true, refusal_reason: 'No sealed material available to you.' }, []);
  const qv = await embedOne(question);
  const ids = items.map((i) => i.id);
  const rows = await q.query(`SELECT owner_id, owner_type, vector::text AS v, 1 - (vector <=> $1::vector) AS sim FROM embeddings WHERE owner_id = ANY($2::uuid[]) ORDER BY vector <=> $1::vector LIMIT 8`, [vec(qv), ids]);
  const kr = new KeyRing(q);
  const material: { id: string; block_id: string; text: string; vector: number[]; qsim: number }[] = [];
  try {
    for (const row of rows) {
      const it = items.find((i) => i.id === row.owner_id)!;
      const tbl = row.owner_type === 'section' ? 'block_sections' : 'statements';
      const rec = (await q.query(`SELECT text_ct, nonce, data_key_id FROM ${tbl} WHERE id=$1`, [row.owner_id]))[0];
      material.push({ id: row.owner_id, block_id: it.block_id, text: await kr.decrypt(rec.data_key_id, tbl, row.owner_id, rec.text_ct, rec.nonce), vector: JSON.parse(row.v), qsim: Number(row.sim) });
    }
    const relevant = material.filter((m) => m.qsim >= 0.1).slice(0, 5);
    if (!relevant.length) return finish({ answer: '', refused: true, refusal_reason: 'The sealed material does not cover this question.' }, []);
    // Answer only from the material relevant enough to answer (the answer check's "needed" threshold); when nothing
    // clears it, from the best-matching block. answer_policy is the strictest among exactly those blocks, so unrelated
    // blocks cannot change the answer's shape, and no block's text is ever used under a looser policy than its own.
    const needed = relevant.filter((m) => m.qsim >= ANSWER_CHECK.neededSim);
    const used = needed.length ? needed : relevant.filter((m) => m.block_id === relevant[0].block_id);
    const blockIds = [...new Set(used.map((m) => m.block_id))];
    const policy = blockIds.map((b) => (A.rules.get(b)?.answer_policy ?? 'facts_only') as AnswerPolicy).sort((a, b) => POLICY_RANK[a] - POLICY_RANK[b])[0];
    let failures: string[] = [];
    for (const strict of [false, true]) {
      const a = await sealedAnswer(question, used.map((m) => m.text), policy, strict);
      if (a.refused) return finish({ answer: '', refused: true, refusal_reason: a.refusal_reason ?? undefined }, blockIds, failures);
      const chk = await answerCheck(question, a.answer, policy, material);
      if (chk.pass) return finish({ answer: a.answer.trim(), refused: false }, blockIds, failures);
      failures = failures.concat(chk.failures);
    }
    return finish({ answer: '', refused: true, refusal_reason: 'An answer could not be given without revealing restricted material.' }, blockIds, failures);
  } finally {
    for (const m of material) m.text = '';
    kr.wipe();
  }
}
