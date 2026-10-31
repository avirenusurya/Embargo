/**
 * Action check (Part 12.7) for agent actions sent through Embargo (perform_action → viaSocket).
 * Matches hold the action for a context admin, who can deny it or override with an audit record (Part 20).
 */
import type { Queryable } from '../db/index.ts';
import { latestRules, type Requester } from './policy.ts';
import { KeyRing, factValueHash } from '../crypto/keys.ts';
import { sealJson, openJson } from './workspaceKeys.ts';
import { verbatimOverlap } from './checks.ts';
import { embed } from '../ai/llm.ts';
import { extractFacts, sentences } from '../ai/tasks.ts';
import { actionAudience, runActionFlow, notifyAdmins, inApp } from '../integrations/viasocket.ts';
import { inc } from './metrics.ts';
import { cosine, uuidv7, sha256, HttpError } from '../util.ts';

const RANK: Record<string, number> = { private: 0, team: 1, partner: 2, public: 3 };
const AUDIENCE_RANK = { team: 1, external: 3, public: 3 };
const strings = (v: any): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

export async function checkAction(q: Queryable, r: Requester, ws: string, audience: 'public' | 'team' | 'external', text: string) {
  const aRank = AUDIENCE_RANK[audience];
  // Restricted set: (a) content this requester received in the last 24h with stricter visibility than the audience;
  // (b) all sealed_use / agent_only content in the workspace. Revoked blocks and statements never count.
  const recent = await q.query(`SELECT section_ids, statement_ids FROM access_logs WHERE workspace_id=$1 AND ${r.kind === 'connection' ? 'connection_id=$2' : 'user_id=$2'} AND created_at > now() - interval '24 hours'`, [ws, r.id]);
  const recSec = [...new Set(recent.flatMap((x) => x.section_ids ?? []))];
  const recSt = [...new Set(recent.flatMap((x) => x.statement_ids ?? []))];
  const secRows = await q.query(`SELECT s.id, s.text_ct, s.nonce, s.data_key_id, b.id AS block_id, b.access_mode FROM block_sections s JOIN block_versions v ON v.id = s.block_version_id JOIN blocks b ON b.id = v.block_id
     WHERE b.workspace_id=$1 AND b.status <> 'revoked' AND b.storage_mode='standard' AND (s.id = ANY($2::uuid[]) OR (b.access_mode IN ('sealed_use','agent_only') AND b.current_version_id = v.id)) LIMIT 800`, [ws, recSec]);
  const stRows = await q.query(`SELECT s.id, s.text_ct, s.nonce, s.data_key_id, s.status, b.id AS block_id, b.access_mode FROM statements s JOIN block_versions v ON v.id = s.block_version_id JOIN blocks b ON b.id = v.block_id
     WHERE b.workspace_id=$1 AND b.status <> 'revoked' AND s.revoked_at IS NULL AND (s.id = ANY($2::uuid[]) OR (b.access_mode IN ('sealed_use','agent_only') AND b.current_version_id = v.id)) LIMIT 800`, [ws, recSt]);
  const rules = await latestRules(q, 'block', [...new Set([...secRows, ...stRows].map((x) => x.block_id))]);
  const restricted = [...secRows.map((x) => ({ ...x, tbl: 'block_sections' })), ...stRows.map((x) => ({ ...x, tbl: 'statements' }))].filter((x) => {
    if (x.access_mode !== 'viewable') return true;
    const vis = rules.get(x.block_id)?.visibility ?? 'team';
    if (RANK[vis] < aRank) return true;
    return x.tbl === 'statements' && x.status === 'team_only' && audience !== 'team';
  });
  const reasons: string[] = [];
  const matched = new Set<string>();
  const hit = (id: string, reason: string) => { matched.add(id); if (!reasons.includes(reason)) reasons.push(reason); };
  if (restricted.length && text.trim()) {
    const kr = new KeyRing(q);
    const texts: string[] = [];
    try {
      for (const x of restricted) texts.push(await kr.decrypt(x.data_key_id, x.tbl, x.id, x.text_ct, x.nonce));
      // 1. verbatim / 8-gram
      texts.forEach((t, i) => { const v = verbatimOverlap(text, [t]); if (v.longestRun > 12 || v.ngramOverlap > 0.2) hit(restricted[i].id, 'verbatim'); });
      // 2. fact match on the full (entity, attribute, value_hash) tuple
      const pf = await extractFacts(text);
      if (pf.length) {
        const rf = await q.query(`SELECT f.entity, f.attribute, f.value_hash, f.section_id, f.statement_id FROM facts f
           WHERE f.workspace_id=$1 AND (f.section_id = ANY($2::uuid[]) OR f.statement_id = ANY($2::uuid[]))
             AND (f.statement_id IS NULL OR NOT EXISTS (SELECT 1 FROM statements s WHERE s.id = f.statement_id AND s.revoked_at IS NOT NULL))`, [ws, restricted.map((x) => x.id)]);
        const keys = new Map(rf.map((x) => [`${x.entity}|${x.attribute}|${x.value_hash}`, x.section_id ?? x.statement_id]));
        for (const f of pf) {
          const id = keys.get(`${f.entity.toLowerCase().trim()}|${f.attribute.toLowerCase().trim()}|${factValueHash(ws, f.value)}`);
          if (id) hit(id, 'fact');
        }
      }
      // 3. embedding similarity per sentence ≥ 0.80
      const sents = sentences(text).slice(0, 40);
      if (sents.length) {
        const ev = await embed([...sents, ...texts]);
        const sv = ev.slice(0, sents.length), rv = ev.slice(sents.length);
        for (let i = 0; i < rv.length; i++) if (sv.some((v) => cosine(v, rv[i]) >= 0.8)) hit(restricted[i].id, 'semantic');
      }
    } finally { texts.fill(''); kr.wipe(); }
  }
  // Verbatim or fact matches block outright; similarity alone holds the action for review.
  const verdict: 'clean' | 'blocked' | 'review' = !matched.size ? 'clean' : reasons.some((x) => x !== 'semantic') ? 'blocked' : 'review';
  return { verdict, reasons, matched: matched.size };
}

export async function performAction(q: Queryable, r: Requester, input: { action: string; target: string; payload: any }) {
  if (!r.scopes.includes('perform_action')) throw new HttpError(403, 'forbidden_scope', 'Token lacks perform_action scope');
  const ws = r.workspace_id!;
  const t0 = Date.now();
  const audience = await actionAudience(q, ws, input.action, input.target);
  const text = strings(input.payload).join('\n').slice(0, 20000);
  const chk = await checkAction(q, r, ws, audience, text);
  let status: 'sent' | 'blocked' | 'held' = chk.verdict === 'clean' ? 'sent' : 'held';
  let error: string | undefined;
  if (status === 'sent') { try { await runActionFlow(q, ws, input.action, input.target, input.payload); } catch (e: any) { status = 'blocked'; error = e.message; } }
  const logId = uuidv7();
  await q.query(`INSERT INTO access_logs(id, workspace_id, connection_id, user_id, channel, tool, request_hash, withheld_count, decision, latency_ms) VALUES ($1,$2,$3,$4,'action',$5,$6,$7,$8,$9)`,
    [logId, ws, r.kind === 'connection' ? r.id : null, r.user_id ?? null, input.action, sha256(text), chk.matched,
      JSON.stringify({ status: status === 'held' ? 'blocked' : status, verdict: chk.verdict, audience, reasons: chk.reasons, restricted_count: chk.matched, error }), Date.now() - t0]);
  inc('embargo_action_checks_total', { verdict: chk.verdict }, 1, 'Action checks by verdict');
  if (status !== 'held') return error ? { status: 'blocked' as const, reason: error } : { status: 'sent' as const };

  // Hold for a context admin (inbox). The payload is kept encrypted so an override can forward it unchanged.
  const id = uuidv7();
  const sealed = await sealJson(q, ws, 'held_action', 'held_actions', id, { target: input.target, payload: input.payload });
  const summary = `${input.action} to a ${audience} audience ${chk.verdict === 'blocked' ? 'blocked' : 'held for review'}: matches ${chk.matched} restricted item(s) (${chk.reasons.join(', ')})`;
  await q.query(`INSERT INTO held_actions(id, workspace_id, connection_id, user_id, action, target_hint, audience, summary, reasons, restricted_count, payload_ct, payload_nonce, data_key_id, access_log_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, ws, r.kind === 'connection' ? r.id : null, r.user_id ?? null, input.action, String(input.target ?? '').slice(0, 120), audience, summary, chk.reasons, chk.matched, sealed.ct, sealed.nonce, sealed.keyId, logId]);
  for (const a of await q.query(`SELECT user_id FROM memberships WHERE workspace_id=$1 AND role IN ('owner','context_admin')`, [ws]))
    await inApp(q, ws, a.user_id, 'held_action', `An agent action (${input.action}) was held: it matches restricted context`, `/app#inbox/held/${id}`);
  if (r.kind === 'connection') {
    const n = (await q.query(`SELECT COUNT(*)::int AS n FROM held_actions WHERE connection_id=$1 AND created_at > now() - interval '24 hours'`, [r.id]))[0].n;
    if (n >= 3) await notifyAdmins(q, ws, 'suggestion.created', 'action_blocked', `A connected tool had ${n} actions held in 24h for containing restricted context`, `/app#inbox`);
  }
  const reason = chk.verdict === 'blocked'
    ? `Payload matches ${chk.matched} restricted item(s) (${chk.reasons.join(', ')}) not allowed for a ${audience} audience. A context admin can review it.`
    : `Held for review: payload is similar to ${chk.matched} restricted item(s) not allowed for a ${audience} audience.`;
  return { status: 'blocked' as const, reason, held_action_id: id };
}

export async function listHeldActions(q: Queryable, ws: string, status?: string) {
  const rows = await q.query(`SELECT h.*, c.tool_label FROM held_actions h LEFT JOIN connections c ON c.id=h.connection_id WHERE h.workspace_id=$1 ${status ? 'AND h.status=$2' : ''} ORDER BY h.created_at DESC LIMIT 200`, status ? [ws, status] : [ws]);
  return rows.map((h) => ({ id: h.id, connection_id: h.connection_id, tool_label: h.tool_label ?? null, action: h.action, target: h.target_hint, audience: h.audience, summary: h.summary, reasons: h.reasons ?? [], restricted_count: h.restricted_count, status: h.status, created_at: h.created_at, decided_by: h.decided_by, decided_at: h.decided_at }));
}

/** Context-admin decision. Approve = override: forward the held payload to viaSocket and log it as an override. */
export async function decideHeldAction(q: Queryable, id: string, userId: string, decision: 'approve' | 'deny') {
  const h = (await q.query('SELECT * FROM held_actions WHERE id=$1', [id]))[0];
  if (!h) throw new HttpError(404, 'not_found');
  if (h.status !== 'held') throw new HttpError(409, 'already_decided', `Action is ${h.status}`);
  if (decision === 'approve') {
    const p = await openJson(q, h.data_key_id, 'held_actions', h.id, h.payload_ct, h.payload_nonce);
    await runActionFlow(q, h.workspace_id, h.action, p.target, p.payload);
    await q.query(`INSERT INTO access_logs(id, workspace_id, connection_id, user_id, channel, tool, request_hash, withheld_count, decision) VALUES ($1,$2,$3,$4,'action',$5,$6,0,$7)`,
      [uuidv7(), h.workspace_id, h.connection_id, userId, h.action, sha256(JSON.stringify(p)), JSON.stringify({ status: 'sent', override: true, held_action_id: h.id, approved_by: userId, reasons: h.reasons })]);
  }
  await q.query(`UPDATE held_actions SET status=$2, decided_by=$3, decided_at=now(), payload_ct=CASE WHEN $2='denied' THEN NULL ELSE payload_ct END WHERE id=$1`, [id, decision === 'approve' ? 'approved' : 'denied', userId]);
  return { ok: true };
}
