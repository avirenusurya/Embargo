/**
 * Context compiler (Part 9): policy → embed task → candidates → score → dedupe → pack → order → annotate →
 * decrypt selected only → log. Learns from usage via Beta priors per task cluster (9.4).
 */
import type { Queryable } from '../db/index.ts';
import { vec, parseVec } from '../db/index.ts';
import { config } from '../config.ts';
import { allowedItems, type Requester, type AllowedItem } from './policy.ts';
import { embedOne, countTokens } from '../ai/llm.ts';
import { KeyRing } from '../crypto/keys.ts';
import { getWorkspaceKey } from './workspaceKeys.ts';
import { sentences } from '../ai/tasks.ts';
import { cosine, uuidv7, sha256 } from '../util.ts';
import { inc, observe } from './metrics.ts';

const W = config.compiler;

export interface CompiledItem {
  id: string; block_id: string; version: number; section_id?: string; statement_ids?: string[]; title: string; heading?: string;
  text: string; why_included: string; warnings: string[]; tokens: number;
}
export interface CompileResult {
  compile_id: string; items: CompiledItem[]; withheld_count: number; tokens_total: number; tokens_saved_estimate: number;
  task_cluster_id: string | null; more_available: boolean;
}

export async function nearestTaskCluster(q: Queryable, ws: string, v: number[], create = true): Promise<string | null> {
  const r = (await q.query(`SELECT id, size, centroid::text AS c, 1 - (centroid <=> $2::vector) AS sim FROM task_clusters WHERE workspace_id=$1 ORDER BY centroid <=> $2::vector LIMIT 1`, [ws, vec(v)]))[0];
  if (r && Number(r.sim) >= W.clusterJoin) {
    const c = parseVec(r.c); const n = Number(r.size);
    const next = c.map((x, i) => (x * n + v[i]) / (n + 1));
    await q.query('UPDATE task_clusters SET centroid=$2::vector, size=size+1 WHERE id=$1', [r.id, vec(next)]);
    return r.id;
  }
  if (!create) return r?.id ?? null;
  const id = uuidv7();
  await q.query('INSERT INTO task_clusters(id, workspace_id, centroid) VALUES ($1,$2,$3::vector)', [id, ws, vec(v)]);
  return id;
}

const KIND_ORDER: Record<string, number> = { decisions: 1, facts: 2, summary: 3, section: 3, open_questions: 3, statement: 4 };

export async function compile(q: Queryable, r: Requester, input: { task: string; max_tokens?: number; purpose?: string | null; now?: Date; channelTool?: string }): Promise<CompileResult> {
  const t0 = Date.now();
  const now = input.now ?? new Date();
  const maxTokens = Math.max(200, Math.min(20000, input.max_tokens ?? 2000));
  const ws = r.workspace_id!;
  // 1. Allowed set (only text form is deliverable over MCP)
  const A = await allowedItems(q, r, 'mcp', now, input.purpose);
  const allowed = A.items.filter((i) => i.form === 'text');
  const byId = new Map<string, AllowedItem>(allowed.map((i) => [i.id, i]));
  const withheldCount = A.withheld.length;
  // 2. Task vector + cluster
  const qv = await embedOne(input.task);
  const clusterId = await nearestTaskCluster(q, ws, qv);
  // 3. Candidates: vector search within allowed ids ∪ pinned
  const ids = [...byId.keys()];
  const cand = ids.length ? await q.query(
    `SELECT owner_id, owner_type, vector::text AS v, 1 - (vector <=> $1::vector) AS sim FROM embeddings
     WHERE owner_type IN ('section','statement') AND owner_id = ANY($2::uuid[]) ORDER BY vector <=> $1::vector LIMIT ${Number(W.topK)}`, [vec(qv), ids]) : [];
  const pinnedBlocks = new Set([...A.blocks.values()].filter((b) => b.pinned).map((b) => b.id));
  const have = new Set(cand.map((c) => c.owner_id));
  const pinnedExtra = allowed.filter((i) => pinnedBlocks.has(i.block_id) && !have.has(i.id)).map((i) => i.id);
  if (pinnedExtra.length) cand.push(...await q.query(`SELECT owner_id, owner_type, vector::text AS v, 1 - (vector <=> $1::vector) AS sim FROM embeddings WHERE owner_id = ANY($2::uuid[])`, [vec(qv), pinnedExtra]));
  // 4. Score
  const blockIds = [...new Set(cand.map((c) => byId.get(c.owner_id)!.block_id))];
  const priors = new Map((await q.query('SELECT block_id, alpha, beta FROM usage_priors WHERE workspace_id=$1 AND task_cluster_id=$2 AND block_id = ANY($3::uuid[])', [ws, clusterId, blockIds])).map((p) => [p.block_id, p]));
  const open = await q.query(`SELECT type, target_block_ids FROM suggestions WHERE workspace_id=$1 AND status='open' AND type IN ('stale','contradiction')`, [ws]);
  const stale = new Set(open.filter((s) => s.type === 'stale').flatMap((s) => s.target_block_ids));
  const conflict = new Set(open.filter((s) => s.type === 'contradiction').flatMap((s) => s.target_block_ids));
  const meta = new Map<string, { tokens: number; kind: string; ordinal: number }>();
  const secIds = cand.filter((c) => c.owner_type === 'section').map((c) => c.owner_id);
  const stIds = cand.filter((c) => c.owner_type === 'statement').map((c) => c.owner_id);
  for (const s of await q.query('SELECT id, tokens, kind, ordinal FROM block_sections WHERE id = ANY($1::uuid[])', [secIds])) meta.set(s.id, s);
  // Statements are delivered as "Speaker: text" lines, so their cost includes the label and the newline.
  for (const s of await q.query(`SELECT id, tokens, speaker_label, 'statement' AS kind, ordinal FROM statements WHERE id = ANY($1::uuid[])`, [stIds]))
    meta.set(s.id, { ...s, tokens: Number(s.tokens) + countTokens(`${s.speaker_label ?? 'Unknown'}: `) + 1 });
  const versionCreated = new Map((await q.query('SELECT id, created_at, version_no, tokens_original FROM block_versions WHERE id = ANY($1::uuid[])', [[...new Set(cand.map((c) => byId.get(c.owner_id)!.version_id))]])).map((v) => [v.id, v]));
  const scored = cand.map((c) => {
    const it = byId.get(c.owner_id)!;
    const b = A.blocks.get(it.block_id);
    const sim = Number(c.sim);
    const pin = b.pinned ? 1 : 0;
    const age = (now.getTime() - new Date(versionCreated.get(it.version_id)?.created_at ?? now).getTime()) / 86400000;
    const recency = Math.exp(-age / 30);
    const p = priors.get(it.block_id); const prior = p ? p.alpha / (p.alpha + p.beta) : 0.5;
    const st = stale.has(it.block_id) ? 1 : 0, cf = conflict.has(it.block_id) ? 1 : 0;
    const score = W.wSim * sim + W.wPin * pin + W.wRecency * recency + W.wPrior * prior - W.wStale * st - W.wConflict * cf;
    const factors: [string, number][] = [['relevant to task', W.wSim * sim], ['pinned', W.wPin * pin], ['frequently used for similar tasks', W.wPrior * (prior - 0.5) * 2], ['recently updated', W.wRecency * recency * 0.5]];
    const why = factors.sort((a, b) => b[1] - a[1])[0][0];
    const m = meta.get(c.owner_id) ?? { tokens: 50, kind: 'section', ordinal: 0 };
    return { item: it, vector: parseVec(c.v), sim, score, pinned: !!pin, why, tokens: m.tokens, kind: m.kind, ordinal: m.ordinal, stale: !!st, conflict: !!cf };
  }).sort((a, b) => b.score - a.score);
  // 5. Relevance gate + deduplicate. Pinned items always stay. Unpinned candidates must reach an absolute floor and a
  //    fraction of the best unpinned match, so a compile carries what the task needs rather than filling the budget
  //    with unrelated blocks (9.1 "picks what's needed"). Then drop candidates whose embedding is > dedupe threshold
  //    to a higher-scored kept item.
  const bestSim = scored.reduce((m, c) => (c.pinned ? m : Math.max(m, c.sim)), 0);
  const gate = Math.max(W.minSim, W.relSim * bestSim);
  const kept: typeof scored = [];
  for (const c of scored) {
    if (!c.pinned && c.sim < gate) continue;
    if (!kept.some((s) => cosine(s.vector, c.vector) > W.dedupe)) kept.push(c);
  }
  // 6. Pack: pinned first if they fit, then greedy by score/tokens. A section that doesn't fit falls back to its
  //    block's one-line summary (if allowed and it fits), else to the section's first sentence.
  const density = (c: typeof scored[number]) => c.score / Math.max(1, c.tokens);
  kept.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || density(b) - density(a));
  const summaryOf = new Map(allowed.filter((i) => i.type === 'section' && i.kind === 'summary').map((i) => [i.block_id, i.id]));
  const kr = new KeyRing(q);
  const firstLine = async (sectionId: string, suffix = '') => {
    const row = (await q.query('SELECT heading, text_ct, nonce, data_key_id FROM block_sections WHERE id=$1', [sectionId]))[0];
    const first = sentences(await kr.decrypt(row.data_key_id, 'block_sections', sectionId, row.text_ct, row.nonce))[0];
    return first ? { text: first + suffix, tokens: countTokens(`${row.heading}\n${first}${suffix}`) } : null;
  };
  type Sel = typeof scored[number] & { truncatedText?: string; note?: string };
  const selected: Sel[] = [];
  const chosen = new Set<string>();
  let used = 0, moreAvailable = false;
  for (const c of kept) {
    if (chosen.has(c.item.id)) continue;
    if (used + c.tokens <= maxTokens) { selected.push(c); chosen.add(c.item.id); used += c.tokens; continue; }
    moreAvailable = true;
    if (c.item.type !== 'section') continue;
    const sid = summaryOf.get(c.item.block_id);
    if (sid && !chosen.has(sid) && sid !== c.item.id) {
      const l = await firstLine(sid);
      if (l && used + l.tokens <= maxTokens) {
        selected.push({ ...c, item: byId.get(sid)!, kind: 'summary', tokens: l.tokens, truncatedText: l.text, note: 'summary only; full section did not fit' });
        chosen.add(sid); used += l.tokens; continue;
      }
    }
    if (sid && chosen.has(sid)) continue; // the block's summary line is already in
    const l = await firstLine(c.item.id, ' …');
    if (l && used + l.tokens <= maxTokens) { selected.push({ ...c, tokens: l.tokens, truncatedText: l.text, note: 'trimmed to fit' }); chosen.add(c.item.id); used += l.tokens; }
  }
  // 7. Order: pinned → decisions → facts → other sections → statements
  selected.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3) || b.score - a.score);
  // 8+9. Decrypt only selected, annotate
  const items: CompiledItem[] = [];
  const stmtGroups = new Map<string, typeof selected>();
  for (const c of selected) if (c.item.type === 'statement') stmtGroups.set(c.item.block_id, [...(stmtGroups.get(c.item.block_id) ?? []), c]);
  const emitted = new Set<string>();
  for (const c of selected) {
    const b = A.blocks.get(c.item.block_id);
    const v = versionCreated.get(c.item.version_id);
    const warnings = [...(c.conflict ? ['This block has an unresolved contradiction with another block; verify before relying on it.'] : []), ...(c.stale ? ['This block may be out of date.'] : [])];
    if (c.item.type === 'section') {
      const row = (await q.query('SELECT heading, text_ct, nonce, data_key_id FROM block_sections WHERE id=$1', [c.item.id]))[0];
      const text = c.truncatedText ?? await kr.decrypt(row.data_key_id, 'block_sections', c.item.id, row.text_ct, row.nonce);
      items.push({ id: c.item.id, block_id: b.id, version: v?.version_no, section_id: c.item.id, title: b.title, heading: row.heading, text, why_included: c.note ? `${c.why} (${c.note})` : c.why, warnings, tokens: c.tokens });
    } else if (!emitted.has(b.id)) {
      emitted.add(b.id);
      const group = stmtGroups.get(b.id)!.sort((x, y) => x.ordinal - y.ordinal);
      const rows = await q.query('SELECT id, speaker_label, text_ct, nonce, data_key_id FROM statements WHERE id = ANY($1::uuid[]) ORDER BY ordinal', [group.map((g) => g.item.id)]);
      const lines = [];
      for (const r0 of rows) lines.push(`${r0.speaker_label ?? 'Unknown'}: ${await kr.decrypt(r0.data_key_id, 'statements', r0.id, r0.text_ct, r0.nonce)}`);
      const text = lines.join('\n');
      // Declared tokens = what is actually delivered (the per-line estimate used for packing is an upper bound).
      items.push({ id: rows[0].id, block_id: b.id, version: v?.version_no, statement_ids: rows.map((x) => x.id), title: b.title, text, why_included: group[0].why, warnings, tokens: countTokens(text) });
    }
  }
  kr.wipe();
  const tokensTotal = items.reduce((s, i) => s + i.tokens, 0);
  const servedVersions = new Set(selected.map((s) => s.item.version_id));
  const original = [...servedVersions].reduce((s, id) => s + Number(versionCreated.get(id)?.tokens_original ?? 0), 0);
  const saved = Math.max(0, original - tokensTotal);
  const versionsServed = Object.fromEntries(items.map((i) => [i.block_id, i.version]));
  // 10. Log
  const logId = uuidv7();
  const maxSim = scored.length ? Math.max(...scored.map((s) => s.sim)) : 0;
  const latency = Date.now() - t0;
  await q.query(`INSERT INTO access_logs(id, workspace_id, connection_id, user_id, channel, tool, request_hash, block_ids, section_ids, statement_ids, withheld_count, decision, tokens_served, latency_ms, task_cluster_id, block_versions, tokens_original, tokens_saved)
                 VALUES ($1,$2,$3,$4,'mcp',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [logId, ws, r.kind === 'connection' ? r.id : null, r.user_id ?? null, input.channelTool ?? 'get_context', sha256(input.task), [...new Set(items.map((i) => i.block_id))],
      items.filter((i) => i.section_id).map((i) => i.section_id), items.flatMap((i) => i.statement_ids ?? []), withheldCount,
      JSON.stringify({ items: items.map((i) => ({ id: i.id, block_id: i.block_id, version: i.version, ids: i.statement_ids ?? [i.id] })), withheld: A.withheld.map((w) => ({ id: w.id, block_id: w.block_id, reason: w.reason })) }),
      tokensTotal, latency, clusterId, JSON.stringify(versionsServed), original, saved]);
  observe('embargo_compile_latency_ms', latency, 'get_context compile latency in milliseconds');
  inc('embargo_tokens_served_total', {}, tokensTotal, 'Tokens served to AI tools by the compiler');
  inc('embargo_tokens_saved_total', {}, saved, 'Tokens saved versus reading the original sources');
  const qk = await getWorkspaceKey(q, ws, 'query_log');
  const qid = uuidv7();
  const kr2 = new KeyRing(q);
  const enc = await kr2.encrypt(qk, 'query_log_embeddings', qid, input.task.slice(0, 2000));
  kr2.wipe();
  await q.query('INSERT INTO query_log_embeddings(id, workspace_id, access_log_id, task_cluster_id, vector, max_score, query_ct, query_nonce, data_key_id) VALUES ($1,$2,$3,$4,$5::vector,$6,$7,$8,$9)',
    [qid, ws, logId, clusterId, vec(qv), maxSim, enc.ct, enc.nonce, qk]);
  return { compile_id: logId, items, withheld_count: withheldCount, tokens_total: tokensTotal, tokens_saved_estimate: saved, task_cluster_id: clusterId, more_available: moreAvailable };
}

/** Learning loop (9.4). */
export async function bumpPrior(q: Queryable, ws: string, blockId: string, clusterId: string | null, dAlpha: number, dBeta: number) {
  if (!clusterId) return;
  await q.query(`INSERT INTO usage_priors(workspace_id, block_id, task_cluster_id, alpha, beta) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (workspace_id, block_id, task_cluster_id) DO UPDATE SET alpha = usage_priors.alpha + $6, beta = usage_priors.beta + $7`,
    [ws, blockId, clusterId, 1 + dAlpha, 1 + dBeta, dAlpha, dBeta]);
}

export async function reportUse(q: Queryable, r: Requester, input: { compile_id: string; used_ids: string[]; ignored_ids: string[]; helpful?: boolean }, source: 'agent' | 'human' = 'agent') {
  const log = (await q.query('SELECT * FROM access_logs WHERE id=$1 AND workspace_id=$2', [input.compile_id, r.workspace_id]))[0];
  if (!log) return { ok: false, error: 'unknown compile_id' };
  if (source === 'agent' && r.kind === 'connection' && log.connection_id !== r.id) return { ok: false, error: 'compile_id belongs to another connection' };
  const decision = typeof log.decision === 'string' ? JSON.parse(log.decision) : log.decision;
  const map = new Map<string, string>();
  for (const it of decision?.items ?? []) { map.set(it.id, it.block_id); for (const x of it.ids ?? []) map.set(x, it.block_id); map.set(it.block_id, it.block_id); }
  const usedBlocks = new Set(input.used_ids.map((i) => map.get(i)).filter(Boolean) as string[]);
  const ignoredBlocks = new Set(input.ignored_ids.map((i) => map.get(i)).filter((b) => b && !usedBlocks.has(b)) as string[]);
  for (const b of usedBlocks) await bumpPrior(q, log.workspace_id, b, log.task_cluster_id, 1, 0);
  for (const b of ignoredBlocks) await bumpPrior(q, log.workspace_id, b, log.task_cluster_id, 0, 1);
  if (source === 'human' && input.helpful !== undefined) for (const it of decision?.items ?? []) await bumpPrior(q, log.workspace_id, it.block_id, log.task_cluster_id, input.helpful ? 1 : 0, input.helpful ? 0 : 1);
  const uuidOk = (x: string) => /^[0-9a-f-]{36}$/i.test(x);
  await q.query('INSERT INTO context_use_reports(id, access_log_id, used_ids, ignored_ids, helpful, source) VALUES ($1,$2,$3,$4,$5,$6)',
    [uuidv7(), log.id, input.used_ids.filter(uuidOk), input.ignored_ids.filter(uuidOk), input.helpful ?? null, source]);
  return { ok: true };
}

/** "Expanded" signal: read_block shortly after a compile that included the block → alpha += 0.5 */
export async function noteExpansion(q: Queryable, r: Requester, blockId: string) {
  if (r.kind !== 'connection') return;
  const last = (await q.query(`SELECT workspace_id, task_cluster_id FROM access_logs WHERE connection_id=$1 AND channel='mcp' AND tool='get_context' AND created_at > now() - interval '15 minutes' AND $2 = ANY(block_ids) ORDER BY created_at DESC LIMIT 1`, [r.id, blockId]))[0];
  if (last) await bumpPrior(q, last.workspace_id, blockId, last.task_cluster_id, 0.5, 0);
}
