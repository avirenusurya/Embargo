import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { keccak256, type Hex } from 'viem';
import { getDb } from '../../db/index.ts';
import { requireUser, requireRole, parse, ADMIN, ANY, blockWorkspace, webRequester } from '../http.ts';
import { allowedItems, evaluate, latestRules, cardCoverage, memberships, type Requester } from '../../core/policy.ts';
import { reportUse } from '../../core/compiler.ts';
import { readSuggestion, approve, approveWithSimilar, daily, weekly, insertRule, sendDigest, buildDigest, recomputeClusters } from '../../core/contextManager.ts';
import { listHeldActions, decideHeldAction } from '../../core/actions.ts';
import { reviewReminders } from '../../core/consent.ts';
import { tracePrompts } from '../../ai/prompts.ts';
import { verifyRecord, proofBundle, recordFields, createRecord, EVENT_CODE, type RecordEvent } from '../../chain/records.ts';
import { userTypedData } from '../../chain/eas.ts';
import { anchorBatch } from '../../chain/records.ts';
import { KeyRing } from '../../crypto/keys.ts';
import { enqueue } from '../../jobs/queue.ts';
import { HttpError, uuidv7, isUuid } from '../../util.ts';
import * as tg from '../../integrations/tigergraph.ts';

/** Activity row shape shared by workspace and block activity feeds. */
async function activityEntries(db: any, rows: any[], admin: boolean) {
  const titles = new Map((await db.query('SELECT id, title FROM blocks WHERE id = ANY($1::uuid[])', [[...new Set(rows.flatMap((r) => r.block_ids))]])).map((b: any) => [b.id, b.title]));
  return rows.map((r) => {
    const d = typeof r.decision === 'string' ? JSON.parse(r.decision) : r.decision;
    const versions = (typeof r.block_versions === 'string' ? JSON.parse(r.block_versions) : r.block_versions) ?? {};
    const reasons = admin && d?.withheld ? d.withheld.reduce((a: any, w: any) => ((a[w.reason] = (a[w.reason] ?? 0) + 1), a), {}) : undefined;
    return {
      id: r.id, at: r.created_at, channel: r.channel, tool: r.tool, connection: r.tool_label, connection_id: r.connection_id, user: r.user_name,
      blocks: r.block_ids.map((b: string) => ({ id: b, title: titles.get(b), version: versions[b] ?? null })), withheld_count: r.withheld_count, withheld_reasons: reasons,
      tokens_served: r.tokens_served, tokens_original: r.tokens_original, tokens_saved: r.tokens_saved, latency_ms: r.latency_ms,
      outcome: d?.status ?? (d?.refused !== undefined ? (d.refused ? 'refused' : 'answered') : undefined), override: d?.override ? true : undefined,
    };
  });
}
const ACTIVITY_COLS = `l.id, l.channel, l.tool, l.created_at, l.block_ids, l.withheld_count, l.tokens_served, l.tokens_original, l.tokens_saved, l.latency_ms, l.decision, l.block_versions, l.connection_id, c.tool_label, u.display_name AS user_name`;
const RECORD_COLS = `id, event, state, signer_type, effective_at, onchain_uid, tx_hash, batch_id, subject_ref->>'type' AS subject_type, subject_ref->>'note' AS note, created_at`;

async function decideAccessRequest(q: any, r: any, action: 'approve' | 'deny', userId: string) {
  let grant: any = null;
  if (action === 'approve') {
    const rule = (await latestRules(q, 'block', [r.target_id])).get(r.target_id);
    const conn = (await q.query('SELECT user_id FROM connections WHERE id=$1', [r.connection_id]))[0];
    if (rule?.allowed_connection_ids?.length && !rule.allowed_connection_ids.includes(r.connection_id)) grant = await insertRule(q, r.workspace_id, r.target_id, userId, { allowed_connection_ids: [...rule.allowed_connection_ids, r.connection_id] });
    else if (rule?.visibility === 'private') { const id = uuidv7(); await q.query(`INSERT INTO cards(id, source_workspace_id, recipient_type, recipient_user_id, block_ids, scope, created_by) VALUES ($1,$2,'user',$3,$4,'{}',$5)`, [id, r.workspace_id, conn.user_id, [r.target_id], userId]); grant = { card_id: id }; }
    if (tg.enabled()) await enqueue(q, 'graph.sync', { entity: 'block', id: r.target_id });
  }
  await q.query('UPDATE access_requests SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1', [r.id, action === 'approve' ? 'approved' : 'denied', userId]);
  return grant;
}

export default async function activityRoutes(app: FastifyInstance) {
  app.get('/workspaces/:ws/activity', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const qs = req.query as any;
    const db = await getDb();
    const role = await requireRole(db, u.id, ws, ANY);
    const admin = ADMIN.includes(role);
    const params: any[] = [ws]; const where = ['l.workspace_id=$1'];
    if (!admin) { params.push(u.id); where.push(`l.user_id=$${params.length}`); }
    if (qs.channel) { params.push(qs.channel); where.push(`l.channel=$${params.length}`); }
    if (qs.connection_id) { params.push(qs.connection_id); where.push(`l.connection_id=$${params.length}`); }
    if (qs.block_id) { params.push(qs.block_id); where.push(`$${params.length}::uuid = ANY(l.block_ids)`); }
    const rows = await db.query(`SELECT ${ACTIVITY_COLS}
      FROM access_logs l LEFT JOIN connections c ON c.id=l.connection_id LEFT JOIN users u ON u.id=l.user_id WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT ${Math.min(500, Number(qs.limit ?? 100) || 100)}`, params);
    const summary = await db.query(`SELECT c.tool_label, u.display_name AS user_name, b.title, COUNT(*)::int AS reads FROM (SELECT connection_id, user_id, unnest(block_ids) AS bid FROM access_logs WHERE workspace_id=$1 AND channel='mcp' AND created_at > now() - interval '7 days') t
      JOIN blocks b ON b.id=t.bid LEFT JOIN connections c ON c.id=t.connection_id LEFT JOIN users u ON u.id=t.user_id GROUP BY 1,2,3 ORDER BY reads DESC LIMIT 20`, [ws]);
    return {
      week_summary: admin ? summary.map((s) => `${s.tool_label ?? 'Web'} (${s.user_name ?? 'link'}) read "${s.title}" ${s.reads} time(s) this week`) : undefined,
      entries: await activityEntries(db, rows, admin),
    };
  });

  /** Access log for one block (O1: includes the version served). Admins and the block owner see all reads. */
  app.get('/blocks/:id/activity', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    const role = await requireRole(db, u.id, b.workspace_id, ANY);
    const all = ADMIN.includes(role) || b.owner_id === u.id;
    const limit = Math.min(500, Number((req.query as any).limit ?? 100) || 100);
    const rows = await db.query(`SELECT ${ACTIVITY_COLS} FROM access_logs l LEFT JOIN connections c ON c.id=l.connection_id LEFT JOIN users u ON u.id=l.user_id
      WHERE l.workspace_id=$1 AND $2::uuid = ANY(l.block_ids) ${all ? '' : 'AND l.user_id=$3'} ORDER BY l.created_at DESC LIMIT ${limit}`, all ? [b.workspace_id, b.id] : [b.workspace_id, b.id, u.id]);
    return { items: await activityEntries(db, rows, ADMIN.includes(role)) };
  });

  /** Signed records about one block: its revoke/key_destroyed/unlock records, its statements' consent, cards sharing it. */
  app.get('/blocks/:id/records', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    await requireRole(db, u.id, b.workspace_id, ANY);
    const records = await db.query(`SELECT ${RECORD_COLS} FROM records r WHERE r.workspace_id=$1 AND (
        (r.subject_ref->>'type'='block' AND r.subject_ref->>'id'=$2::text)
        OR (r.subject_ref->>'type'='statement' AND r.subject_ref->>'id' IN (SELECT s.id::text FROM statements s JOIN block_versions v ON v.id=s.block_version_id WHERE v.block_id=$2::uuid))
        OR (r.subject_ref->>'type'='card' AND r.subject_ref->>'id' IN (SELECT c.id::text FROM cards c WHERE $2::uuid = ANY(c.block_ids) OR c.collection_id IN (SELECT collection_id FROM collection_blocks WHERE block_id=$2::uuid))))
      ORDER BY r.created_at DESC LIMIT 500`, [b.workspace_id, b.id]);
    return { records };
  });

  /** Token savings (R1): per request (activity items) and per workspace. */
  app.get('/workspaces/:ws/savings', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    const win = [ws, String(days)];
    const tot = (await db.query(`SELECT COALESCE(SUM(tokens_saved),0)::bigint AS saved, COUNT(*)::int AS requests, COALESCE(SUM(tokens_served),0)::bigint AS served, COALESCE(SUM(tokens_original),0)::bigint AS original
      FROM access_logs WHERE workspace_id=$1 AND channel='mcp' AND created_at > now() - ($2 || ' days')::interval`, win))[0];
    const all = (await db.query(`SELECT COALESCE(SUM(tokens_saved),0)::bigint AS saved, COUNT(*)::int AS requests FROM access_logs WHERE workspace_id=$1 AND channel='mcp'`, [ws]))[0];
    const perDay = await db.query(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COALESCE(SUM(tokens_original),0)::bigint AS tokens_original, COALESCE(SUM(tokens_served),0)::bigint AS tokens_served,
        COALESCE(SUM(tokens_saved),0)::bigint AS saved, COUNT(*)::int AS requests FROM access_logs WHERE workspace_id=$1 AND channel='mcp' AND created_at > now() - ($2 || ' days')::interval GROUP BY 1 ORDER BY 1`, win);
    const perConn = await db.query(`SELECT l.connection_id, c.tool_label, COALESCE(SUM(l.tokens_saved),0)::bigint AS saved, COUNT(*)::int AS requests FROM access_logs l LEFT JOIN connections c ON c.id=l.connection_id
        WHERE l.workspace_id=$1 AND l.channel='mcp' AND l.connection_id IS NOT NULL AND l.created_at > now() - ($2 || ' days')::interval GROUP BY 1,2 ORDER BY saved DESC`, win);
    const n = (x: any) => Number(x ?? 0);
    return {
      window_days: days, total_tokens_saved: n(tot.saved), requests: tot.requests, tokens_served: n(tot.served), tokens_original: n(tot.original),
      all_time: { total_tokens_saved: n(all.saved), requests: all.requests },
      per_day: perDay.map((d) => ({ day: d.day, tokens_original: n(d.tokens_original), tokens_served: n(d.tokens_served), saved: n(d.saved), requests: d.requests })),
      per_connection: perConn.map((c) => ({ connection_id: c.connection_id, tool_label: c.tool_label, saved: n(c.saved), requests: c.requests })),
    };
  });

  // ----- Held agent actions (action check → context admin) -----
  app.get('/workspaces/:ws/held-actions', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const { status } = parse(z.object({ status: z.enum(['held', 'approved', 'denied']).optional() }), req.query);
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    return { items: await listHeldActions(db, ws, status) };
  });
  for (const action of ['approve', 'deny'] as const) app.post(`/held-actions/:id/${action}`, async (req) => {
    const u = await requireUser(req);
    const id = (req.params as any).id;
    if (!isUuid(id)) throw new HttpError(400, 'bad_id');
    const db = await getDb();
    const h = (await db.query('SELECT workspace_id FROM held_actions WHERE id=$1', [id]))[0];
    if (!h) throw new HttpError(404, 'not_found');
    await requireRole(db, u.id, h.workspace_id, ADMIN);
    return decideHeldAction(db, id, u.id, action);
  });

  app.post('/activity/:id/feedback', async (req) => {
    const u = await requireUser(req);
    const b = parse(z.object({ helpful: z.boolean(), used_ids: z.array(z.string()).default([]), ignored_ids: z.array(z.string()).default([]) }), req.body);
    const db = await getDb();
    const log = (await db.query('SELECT workspace_id FROM access_logs WHERE id=$1', [(req.params as any).id]))[0];
    if (!log) throw new HttpError(404, 'not_found');
    await requireRole(db, u.id, log.workspace_id, ANY);
    return reportUse(db, webRequester(u.id, log.workspace_id), { compile_id: (req.params as any).id, ...b }, 'human');
  });

  app.get('/blocks/:id/why-withheld', async (req) => {
    const u = await requireUser(req);
    const { connection_id } = parse(z.object({ connection_id: z.string().uuid() }), req.query);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    const role = await requireRole(db, u.id, b.workspace_id, ANY);
    if (b.owner_id !== u.id && !ADMIN.includes(role)) throw new HttpError(403, 'forbidden');
    const c = (await db.query('SELECT * FROM connections WHERE id=$1', [connection_id]))[0];
    if (!c) throw new HttpError(404, 'connection_not_found');
    const r: Requester = { kind: 'connection', id: c.id, workspace_id: c.workspace_id, user_id: c.user_id, scopes: c.scopes };
    const now = new Date();
    const A = await allowedItems(db, r, 'mcp', now, null, { blockIds: [b.id] });
    const reasons = A.withheld.reduce((a: Record<string, number>, w) => ((a[w.reason] = (a[w.reason] ?? 0) + 1), a), {});
    const graph = tg.enabled() ? await tg.whyWithheld(c.id, b.id, now).catch((e) => ({ error: e.message })) : undefined;
    const rule = (await latestRules(db, 'block', [b.id])).get(b.id);
    const EXPLAIN: Record<string, string> = {
      status: `Block status is "${b.status}"`, sealed_block: 'Block is sealed on devices; Embargo cannot read it', blocked_by_speaker: 'Speaker blocked these lines from AI',
      awaiting_review: 'Lines are awaiting speaker review', expired: `Rule expired at ${rule?.expires_at}`, embargoed: `Embargoed until ${rule?.embargo_until}`,
      private: 'Block is private to its owner', team_only: 'Block is team-only and the tool is not a member or card recipient', partner_only: 'Block is partner-only',
      team_only_statement: 'Speaker allowed these lines for the team only', tool_not_allowed: 'Rule restricts which tools may receive this block',
      purpose_mismatch: `Rule requires purpose: ${(rule?.purposes ?? []).join(', ')}`, sealed_use_only: 'Block is sealed-use: answers via ask_sealed only', scope: 'Token lacks the needed scope',
      revoked: 'Lines were revoked and destroyed',
    };
    return { block_id: b.id, connection: c.tool_label, allowed_items: A.items.length, withheld_items: A.withheld.length, reasons: Object.entries(reasons).map(([k, n]) => ({ reason: k, count: n, explanation: EXPLAIN[k] ?? k })), rule, graph };
  });

  app.get('/persons/:id/exposure', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const p = (await db.query('SELECT * FROM persons WHERE id=$1', [(req.params as any).id]))[0];
    if (!p) throw new HttpError(404, 'not_found');
    if (p.user_id !== u.id) await requireRole(db, u.id, p.workspace_id, ADMIN);
    const now = new Date();
    const stmts = await db.query(`SELECT s.id, s.status, s.block_version_id, b.id AS block_id, b.title, b.workspace_id, b.owner_id, b.status AS bstatus, b.access_mode, b.storage_mode
      FROM statements s JOIN blocks b ON b.current_version_id=s.block_version_id WHERE s.speaker_person_id=$1 AND b.status <> 'revoked'`, [p.id]);
    const blockRules = await latestRules(db, 'block', [...new Set(stmts.map((s) => s.block_id))]);
    const stRules = await latestRules(db, 'statement', stmts.map((s) => s.id));
    const conns = await db.query(`SELECT c.*, u.display_name FROM connections c JOIN users u ON u.id=c.user_id WHERE c.workspace_id=$1 AND c.revoked_at IS NULL`, [p.workspace_id]);
    const cards = await db.query(`SELECT c.*, w.name AS wname FROM cards c LEFT JOIN workspaces w ON w.id=c.recipient_workspace_id WHERE c.source_workspace_id=$1 AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())`, [p.workspace_id]);
    const audiences: { audience: string; kind: string; statements: number }[] = [];
    const evalFor = async (r: Requester, label: string, kind: string) => {
      const mem = new Set((await memberships(db, r.user_id)).keys());
      const cov = await cardCoverage(db, r, now);
      let n = 0;
      for (const s of stmts) {
        const d = evaluate({ requester: r, channel: 'mcp', now, block: { id: s.block_id, workspace_id: s.workspace_id, owner_id: s.owner_id, status: s.bstatus, access_mode: s.access_mode, storage_mode: s.storage_mode }, rule: blockRules.get(s.block_id) ?? null, statement: s, statementRule: stRules.get(s.id) ?? null, memberOf: mem, viaCard: cov.has(s.block_id) });
        if (d.allow) n++;
      }
      if (n) audiences.push({ audience: label, kind, statements: n });
    };
    for (const c of conns) await evalFor({ kind: 'connection', id: c.id, workspace_id: c.workspace_id, user_id: c.user_id, scopes: c.scopes }, `${c.tool_label} (${c.display_name})`, 'connection');
    for (const c of cards) {
      if (c.recipient_type === 'workspace' || (c.recipient_type === 'link' && c.recipient_workspace_id)) await evalFor({ kind: 'user', id: 'x', workspace_id: c.recipient_workspace_id, user_id: null, scopes: ['read'] }, `Workspace ${c.wname ?? c.recipient_workspace_id} (card)`, 'workspace');
      else if (c.recipient_type === 'link') await evalFor({ kind: 'card_link', id: c.id, card_id: c.id, workspace_id: null, user_id: null, scopes: ['read'] }, 'Anyone with the card link', 'link');
      else await evalFor({ kind: 'user', id: c.recipient_user_id, workspace_id: null, user_id: c.recipient_user_id, scopes: ['read'] }, `User ${c.recipient_user_id} (card)`, 'user');
    }
    const graph = tg.enabled() ? await tg.exposure(p.id).catch(() => undefined) : undefined;
    let mine: any[] | undefined;
    if (p.user_id === u.id) {
      const kr = new KeyRing(db);
      try {
        mine = [];
        for (const s of await db.query(`SELECT s.*, b.title FROM statements s JOIN blocks b ON b.current_version_id=s.block_version_id WHERE s.speaker_person_id=$1 AND b.status <> 'revoked' ORDER BY s.block_version_id, s.ordinal LIMIT 500`, [p.id]))
          mine.push({ id: s.id, conversation: s.title, status: s.revoked_at ? 'revoked' : s.status, revoked_at: s.revoked_at, text: s.revoked_at ? null : await kr.decrypt(s.data_key_id, 'statements', s.id, s.text_ct, s.nonce) });
      } finally { kr.wipe(); }
    }
    const byStatus = stmts.reduce((a: Record<string, number>, s) => ((a[s.status] = (a[s.status] ?? 0) + 1), a), {});
    return { person: p.display_name, statements_total: stmts.length, by_status: byStatus, audiences, graph, your_statements: mine };
  });

  // ----- Records -----
  app.get('/workspaces/:ws/records', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    return db.query(`SELECT ${RECORD_COLS} FROM records WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 500`, [ws]);
  });
  app.get('/records/:id', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const r = (await db.query('SELECT workspace_id FROM records WHERE id=$1', [(req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'not_found');
    await requireRole(db, u.id, r.workspace_id, ADMIN);
    return proofBundle(db, (req.params as any).id);
  });
  app.get('/verify/:recordId', async (req, reply) => {
    if (String(req.headers.accept ?? '').includes('text/html')) return reply.sendFile('verify.html');
    return verifyRecord(await getDb(), (req.params as any).recordId);
  });

  /** Countersign an existing record with the user's passkey smart wallet (EIP-712). */
  app.get('/records/:id/typed-data', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const r = (await db.query('SELECT * FROM records WHERE id=$1', [(req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'not_found');
    await requireRole(db, u.id, r.workspace_id, ANY);
    return userTypedData({ subjectHash: r.subject_hash, workspaceHash: r.workspace_hash, recipientHash: r.recipient_hash ?? '0x' + '0'.repeat(64), eventType: EVENT_CODE[r.event as RecordEvent], scopeCode: r.scope_code, effectiveAt: BigInt(Math.floor(new Date(r.effective_at).getTime() / 1000)) } as any);
  });
  app.post('/records/:id/countersign', async (req) => {
    const u = await requireUser(req);
    const b = parse(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }), req.body);
    const db = await getDb();
    const r = (await db.query('SELECT * FROM records WHERE id=$1', [(req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'not_found');
    await requireRole(db, u.id, r.workspace_id, ANY);
    const ref = typeof r.subject_ref === 'string' ? JSON.parse(r.subject_ref) : r.subject_ref;
    const id = await db.tx((q) => createRecord(q, { workspace_id: r.workspace_id, event: r.event, subject: ref, recipient: ref.recipient, effective_at: new Date(r.effective_at), user: { address: b.address as Hex, signature: b.signature as Hex }, note: `Countersigns ${r.id}` }));
    await db.query('UPDATE users SET wallet_address=COALESCE(wallet_address,$2) WHERE id=$1', [u.id, b.address]);
    return { record_id: id, user_sig_hash: keccak256(b.signature as Hex) };
  });
  app.post('/workspaces/:ws/records/anchor', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    await requireRole(db, u.id, (req.params as any).ws, ADMIN);
    return (await anchorBatch(true)) ?? { anchored: false, reason: 'No pending records or chain not configured' };
  });

  // ----- Context inbox -----
  app.get('/workspaces/:ws/suggestions', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const qs = req.query as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    const params: any[] = [ws, qs.status ?? 'open']; let where = 'workspace_id=$1 AND status=$2';
    if (qs.type) { params.push(qs.type); where += ` AND type=$${params.length}`; }
    const rows = await db.query(`SELECT id FROM suggestions WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
    const out = [];
    for (const r of rows) { const s = await readSuggestion(db, r.id); out.push({ id: s.id, type: s.type, status: s.status, summary: s.summary, target_block_ids: s.target_block_ids, confidence: s.confidence, evidence: s.evidence, payload: s.payload, created_at: s.created_at }); }
    return out;
  });
  const approveSuggestion = async (req: any, similar?: boolean) => {
    const u = await requireUser(req);
    const b = parse(z.object({ edited_payload: z.any().optional(), apply_to_similar: z.boolean().optional() }), req.body);
    const db = await getDb();
    const s = (await db.query('SELECT workspace_id FROM suggestions WHERE id=$1', [(req.params as any).id]))[0];
    if (!s) throw new HttpError(404, 'not_found');
    await requireRole(db, u.id, s.workspace_id, ADMIN);
    if (similar ?? b.apply_to_similar) return approveWithSimilar(db, (req.params as any).id, u.id, b.edited_payload);
    return { ...(await approve(db, (req.params as any).id, u.id, b.edited_payload)), applied: 1 };
  };
  app.post('/suggestions/:id/approve', (req) => approveSuggestion(req));
  app.post('/suggestions/:id/allow-similar', (req) => approveSuggestion(req, true));
  app.post('/suggestions/:id/reject', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const s = (await db.query('SELECT workspace_id, status FROM suggestions WHERE id=$1', [(req.params as any).id]))[0];
    if (!s) throw new HttpError(404, 'not_found');
    await requireRole(db, u.id, s.workspace_id, ADMIN);
    if (s.status !== 'open') throw new HttpError(409, 'not_open');
    await db.query(`UPDATE suggestions SET status='rejected', decided_by=$2, decided_at=now() WHERE id=$1`, [(req.params as any).id, u.id]);
    return { ok: true };
  });
  app.post('/workspaces/:ws/context-manager/run', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const { job } = parse(z.object({ job: z.enum(['daily', 'weekly', 'digest', 'clusters', 'reminders']) }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    if (job === 'daily') await tracePrompts(() => daily(ws));
    else if (job === 'weekly') await tracePrompts(() => weekly(ws));
    else if (job === 'digest') return { ok: true, digest: await sendDigest(db, ws) };
    else if (job === 'clusters') return { ok: true, ...(await recomputeClusters(db, ws)) };
    else return { ok: true, review_reminders: await reviewReminders() };
    return { ok: true };
  });
  /** Preview of the next digest (changes, contradictions, revokes, shares since the last one). */
  app.get('/workspaces/:ws/digest', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    const last = (await db.query('SELECT created_at, delivered FROM digest_runs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1', [ws]))[0] ?? null;
    return { ...(await buildDigest(db, ws)), last_sent: last };
  });

  // ----- Access requests -----
  app.get('/workspaces/:ws/access-requests', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    return db.query(`SELECT r.*, c.tool_label, us.display_name AS user_name, b.title FROM access_requests r JOIN connections c ON c.id=r.connection_id JOIN users us ON us.id=c.user_id LEFT JOIN blocks b ON b.id=r.target_id WHERE r.workspace_id=$1 ORDER BY r.created_at DESC`, [ws]);
  });
  for (const action of ['approve', 'deny'] as const) app.post(`/access-requests/:id/${action}`, async (req) => {
    const u = await requireUser(req);
    const b = parse(z.object({ apply_to_similar: z.boolean().optional() }), req.body);
    const db = await getDb();
    const r = (await db.query('SELECT * FROM access_requests WHERE id=$1', [(req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'not_found');
    await requireRole(db, u.id, r.workspace_id, ADMIN);
    if (r.status !== 'pending') throw new HttpError(409, 'already_decided');
    return db.tx(async (q) => {
      const grant = await decideAccessRequest(q, r, action, u.id);
      let applied = 1;
      // "Allow similar": the same decision for every pending request for the same block.
      if (b.apply_to_similar) for (const o of await q.query(`SELECT * FROM access_requests WHERE workspace_id=$1 AND target_id=$2 AND status='pending' AND id <> $3`, [r.workspace_id, r.target_id, r.id])) { await decideAccessRequest(q, o, action, u.id); applied++; }
      return { ok: true, status: action === 'approve' ? 'approved' : 'denied', grant, applied, note: action === 'approve' && !grant ? 'No rule change was needed (block may be archived, embargoed, sealed, or expired; adjust its rules directly).' : undefined };
    });
  });
}
