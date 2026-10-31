import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, type Queryable } from '../../db/index.ts';
import { config } from '../../config.ts';
import { requireUser, requireRole, parse, ADMIN, ANY, EDITOR, enforceLimit } from '../http.ts';
import { ensurePersonForUser } from '../../core/content.ts';
import { deleteWorkspace } from '../../core/revoke.ts';
import { latestRules } from '../../core/policy.ts';
import { SUGGESTION_TYPES, autoApplyThreshold } from '../../core/contextManager.ts';
import { sealJson, openJson } from '../../core/workspaceKeys.ts';
import { createRecord } from '../../chain/records.ts';
import { sendTransactionalEmail } from './auth.ts';
import { enqueue } from '../../jobs/queue.ts';
import { HttpError, uuidv7, randomToken, hashToken, isUuid } from '../../util.ts';
import * as tg from '../../integrations/tigergraph.ts';

export const DEFAULT_SETTINGS = { review_mode: 'flagged', unreviewed_default: 'blocked', review_deadline_hours: 48, auto_apply: {} as Record<string, boolean>, auto_apply_threshold: config.contextManager.autoApplyThreshold };
const SCOPES = ['read', 'write_blocks', 'request_access', 'ask_sealed', 'perform_action'] as const;
const withDefaults = (s: any) => { const m = { ...DEFAULT_SETTINGS, ...(s ?? {}) }; m.auto_apply_threshold = autoApplyThreshold(m); return m; };

/** Invite links are re-copyable by admins: the token is stored encrypted (plus its hash for lookup). */
async function createInvite(q: Queryable, ws: string, userId: string, role: string, email: string | null) {
  const token = randomToken('inv');
  const id = uuidv7();
  const s = await sealJson(q, ws, 'invite', 'invites', id, token);
  await q.query(`INSERT INTO invites(id, workspace_id, email, role, token_hash, expires_at, token_ct, token_nonce, data_key_id, created_by) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days',$6,$7,$8,$9)`,
    [id, ws, email, role, hashToken(token), s.ct, s.nonce, s.keyId, userId]);
  const link = `${config.appUrl}/app#invite/${token}`;
  const w = (await q.query('SELECT name FROM workspaces WHERE id=$1', [ws]))[0];
  const emailed = email ? await sendTransactionalEmail(email, `You're invited to ${w?.name ?? 'an Embargo workspace'}`, `Join ${w?.name ?? 'the workspace'} on Embargo as ${role}: ${link}\nThis link expires in 7 days.`).catch(() => false) : false;
  return { id, token, link, emailed };
}

/** A collection shared by card to another workspace or link: scope changes produce a fresh share record (M1). */
async function recordCollectionShare(q: Queryable, collectionId: string, note: string) {
  const cards = await q.query(`SELECT * FROM cards WHERE collection_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND recipient_type <> 'user'`, [collectionId]);
  if (!cards.length) return;
  const ids = (await q.query('SELECT block_id FROM collection_blocks WHERE collection_id=$1', [collectionId])).map((x) => x.block_id).sort();
  for (const c of cards) await createRecord(q, { workspace_id: c.source_workspace_id, event: 'share', subject: { type: 'card', id: c.id, version: ids.length, content_hash: ids.join(',') }, recipient: { kind: c.recipient_type, id: c.recipient_workspace_id ?? c.id }, scope: { expiry: !!c.expires_at }, note });
  if (tg.enabled()) for (const c of cards) await enqueue(q, 'graph.sync', { entity: 'card', id: c.id });
}

export async function addMember(q: any, ws: string, userId: string, role: string) {
  await q.query('INSERT INTO memberships(user_id, workspace_id, role) VALUES ($1,$2,$3) ON CONFLICT (user_id, workspace_id) DO UPDATE SET role=EXCLUDED.role', [userId, ws, role]);
  await ensurePersonForUser(q, ws, userId);
  await enqueue(q, 'cm.onboarding', { workspace_id: ws, user_id: userId, role });
  if (tg.enabled()) await enqueue(q, 'graph.sync', { entity: 'membership', id: `${userId}:${ws}` });
}

export function setupInstructions(token: string) {
  return {
    local_stdio: { command: 'npx', args: ['-y', 'embargo-mcp', '--token', token, '--api', config.apiUrl] },
    remote_http: { url: `${config.apiUrl}/mcp`, headers: { Authorization: `Bearer ${token}` } },
    claude_desktop_json: { mcpServers: { embargo: { command: 'npx', args: ['-y', 'embargo-mcp', '--token', token, '--api', config.apiUrl] } } },
    claude_code_cli: `claude mcp add --transport http embargo ${config.apiUrl}/mcp --header "Authorization: Bearer ${token}"`,
    cursor_json: { mcpServers: { embargo: { url: `${config.apiUrl}/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
  };
}

export default async function workspaceRoutes(app: FastifyInstance) {
  app.get('/workspaces', async (req) => {
    const u = await requireUser(req);
    return (await getDb()).query('SELECT w.id, w.name, w.plan, m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.created_at', [u.id]);
  });

  app.post('/workspaces', async (req) => {
    const u = await requireUser(req);
    const { name } = parse(z.object({ name: z.string().min(1).max(100) }), req.body);
    const db = await getDb();
    const id = uuidv7();
    await db.tx(async (q) => {
      await q.query('INSERT INTO workspaces(id, name, owner_id, settings) VALUES ($1,$2,$3,$4)', [id, name, u.id, JSON.stringify(DEFAULT_SETTINGS)]);
      await q.query(`INSERT INTO billing(workspace_id, plan, status) VALUES ($1,'free','active')`, [id]);
      await addMember(q, id, u.id, 'owner');
    });
    return { id, name };
  });

  app.get('/workspaces/:ws', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    const role = await requireRole(db, u.id, ws, ANY);
    const w = (await db.query('SELECT id, name, plan, settings, owner_id, created_at FROM workspaces WHERE id=$1', [ws]))[0];
    const counts = (await db.query(`SELECT (SELECT COUNT(*)::int FROM blocks WHERE workspace_id=$1 AND status='active') AS active_blocks, (SELECT COUNT(*)::int FROM memberships WHERE workspace_id=$1) AS members,
      (SELECT COUNT(*)::int FROM suggestions WHERE workspace_id=$1 AND status='open') AS open_suggestions, (SELECT COUNT(*)::int FROM connections WHERE workspace_id=$1 AND revoked_at IS NULL) AS connections,
      (SELECT COUNT(*)::int FROM held_actions WHERE workspace_id=$1 AND status='held') AS held_actions`, [ws]))[0];
    return { ...w, settings: withDefaults(w.settings), role, counts, limits: config.plans[w.plan] ?? config.plans.free };
  });

  app.patch('/workspaces/:ws', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    const b = parse(z.object({
      name: z.string().min(1).max(100).optional(),
      settings: z.object({
        review_mode: z.enum(['flagged', 'all']).optional(), unreviewed_default: z.enum(['blocked', 'held']).optional(),
        review_deadline_hours: z.number().int().min(1).max(24 * 30).optional(),
        auto_apply: z.partialRecord(z.enum(SUGGESTION_TYPES as [string, ...string[]]), z.boolean()).optional(),
        auto_apply_threshold: z.number().min(0.5).max(1).optional(),
      }).optional(),
    }), req.body);
    const cur = (await db.query('SELECT settings FROM workspaces WHERE id=$1', [ws]))[0].settings ?? {};
    const next = { ...cur, ...(b.settings ?? {}), auto_apply: { ...(cur.auto_apply ?? {}), ...(b.settings?.auto_apply ?? {}) } };
    await db.query('UPDATE workspaces SET name=COALESCE($2,name), settings=$3, updated_at=now() WHERE id=$1', [ws, b.name ?? null, JSON.stringify(next)]);
    return { ok: true, settings: withDefaults(next) };
  });

  /** Workspace deletion (owner only, typed confirmation): crypto-shreds every data key of the workspace. */
  app.delete('/workspaces/:ws', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const { confirm } = parse(z.object({ confirm: z.string() }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, ['owner']);
    const w = (await db.query('SELECT name FROM workspaces WHERE id=$1', [ws]))[0];
    if (confirm !== w.name) throw new HttpError(400, 'confirm_mismatch', 'Type the workspace name exactly to confirm deletion');
    return db.tx((q) => deleteWorkspace(q, ws, u.id));
  });

  app.get('/workspaces/:ws/members', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    return db.query('SELECT u.id, u.display_name, u.email, m.role, p.id AS person_id FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN persons p ON p.user_id=u.id AND p.workspace_id=m.workspace_id WHERE m.workspace_id=$1 ORDER BY m.created_at', [ws]);
  });

  app.post('/workspaces/:ws/members', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const b = parse(z.object({ email: z.string().email(), role: z.enum(['context_admin', 'editor', 'viewer']) }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    await enforceLimit(db, ws, 'members');
    const existing = (await db.query('SELECT id FROM users WHERE lower(email)=lower($1)', [b.email]))[0];
    if (existing) { await db.tx((q) => addMember(q, ws, existing.id, b.role)); return { added: true, user_id: existing.id }; }
    const inv = await createInvite(db, ws, u.id, b.role, b.email.toLowerCase());
    return { added: false, invite_link: inv.link, invite_id: inv.id, emailed: inv.emailed };
  });

  app.post('/workspaces/:ws/invites', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const b = parse(z.object({ email: z.string().email().optional(), role: z.enum(['context_admin', 'editor', 'viewer']) }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    const inv = await createInvite(db, ws, u.id, b.role, b.email?.toLowerCase() ?? null);
    return { invite_link: inv.link, token: inv.token, id: inv.id, emailed: inv.emailed };
  });

  app.get('/workspaces/:ws/invites', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    const rows = await db.query(`SELECT i.*, us.display_name AS created_by_name FROM invites i LEFT JOIN users us ON us.id=i.created_by
      WHERE i.workspace_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`, [ws]);
    const invites = [];
    for (const r of rows) {
      const token = r.token_ct ? await openJson<string>(db, r.data_key_id, 'invites', r.id, r.token_ct, r.token_nonce).catch(() => null) : null;
      invites.push({ id: r.id, email: r.email, role: r.role, expires_at: r.expires_at, created_at: r.created_at, created_by: r.created_by_name ?? null, link: token ? `${config.appUrl}/app#invite/${token}` : null });
    }
    return { invites };
  });

  app.delete('/invites/:id', async (req) => {
    const u = await requireUser(req);
    const id = (req.params as any).id;
    if (!isUuid(id)) throw new HttpError(400, 'bad_id');
    const db = await getDb();
    const inv = (await db.query('SELECT workspace_id, accepted_at FROM invites WHERE id=$1', [id]))[0];
    if (!inv) throw new HttpError(404, 'not_found');
    await requireRole(db, u.id, inv.workspace_id, ADMIN);
    if (inv.accepted_at) throw new HttpError(409, 'already_accepted', 'Invite was already accepted; remove the member instead');
    await db.query('UPDATE invites SET revoked_at=now(), token_ct=NULL, token_nonce=NULL WHERE id=$1', [id]);
    return { ok: true };
  });

  app.post('/invites/:token/accept', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    return db.tx(async (q) => {
      const inv = (await q.query(`UPDATE invites SET accepted_at=now(), token_ct=NULL, token_nonce=NULL WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING *`, [hashToken((req.params as any).token)]))[0];
      if (!inv) throw new HttpError(410, 'invite_expired');
      if (inv.email && u.email && inv.email !== u.email.toLowerCase()) throw new HttpError(403, 'wrong_account', 'This invite is for a different email');
      await enforceLimit(q, inv.workspace_id, 'members');
      await addMember(q, inv.workspace_id, u.id, inv.role);
      return { workspace_id: inv.workspace_id, role: inv.role };
    });
  });

  app.patch('/workspaces/:ws/members/:userId', async (req) => {
    const u = await requireUser(req);
    const { ws, userId } = req.params as any;
    const { role } = parse(z.object({ role: z.enum(['context_admin', 'editor', 'viewer']) }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, ['owner']);
    const w = (await db.query('SELECT owner_id FROM workspaces WHERE id=$1', [ws]))[0];
    if (w.owner_id === userId) throw new HttpError(400, 'owner_role', 'Cannot change the owner role');
    await db.query('UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2', [ws, userId, role]);
    if (tg.enabled()) await enqueue(db, 'graph.sync', { entity: 'membership', id: `${userId}:${ws}` });
    return { ok: true };
  });

  app.delete('/workspaces/:ws/members/:userId', async (req) => {
    const u = await requireUser(req);
    const { ws, userId } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    const w = (await db.query('SELECT owner_id FROM workspaces WHERE id=$1', [ws]))[0];
    if (w.owner_id === userId) throw new HttpError(400, 'owner', 'Cannot remove the owner');
    await db.tx(async (q) => {
      await q.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [ws, userId]);
      await q.query('UPDATE connections SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL', [ws, userId]);
      if (tg.enabled()) await enqueue(q, 'graph.sync', { entity: 'membership', id: `${userId}:${ws}` });
    });
    return { ok: true };
  });

  // ----- Connections (MCP tokens) -----
  app.get('/workspaces/:ws/connections', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    const role = await requireRole(db, u.id, ws, ANY);
    const all = ADMIN.includes(role);
    return db.query(`SELECT c.id, c.tool_label, c.scopes, c.last_used_at, c.revoked_at, c.created_at, c.user_id, u.display_name AS user FROM connections c JOIN users u ON u.id=c.user_id WHERE c.workspace_id=$1 ${all ? '' : 'AND c.user_id=$2'} ORDER BY c.created_at DESC`, all ? [ws] : [ws, u.id]);
  });

  app.post('/workspaces/:ws/connections', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const b = parse(z.object({ tool_label: z.string().min(1).max(80), scopes: z.array(z.enum(SCOPES)).default(['read']) }), req.body);
    const db = await getDb();
    const role = await requireRole(db, u.id, ws, ANY);
    if (role === 'viewer' && b.scopes.some((s) => s !== 'read' && s !== 'ask_sealed')) throw new HttpError(403, 'forbidden', 'Viewers can only create read connections');
    await enforceLimit(db, ws, 'connections');
    const token = randomToken('emb');
    const id = uuidv7();
    const scopes = [...new Set(['read', ...b.scopes])];
    await db.query('INSERT INTO connections(id, workspace_id, user_id, tool_label, token_hash, scopes) VALUES ($1,$2,$3,$4,$5,$6)', [id, ws, u.id, b.tool_label, hashToken(token), scopes]);
    if (tg.enabled()) await enqueue(db, 'graph.sync', { entity: 'connection', id });
    return { id, token, scopes, note: 'This token is shown once. Store it in your AI tool config.', setup: setupInstructions(token) };
  });

  app.delete('/connections/:id', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const c = (await db.query('SELECT * FROM connections WHERE id=$1', [(req.params as any).id]))[0];
    if (!c) throw new HttpError(404, 'not_found');
    if (c.user_id !== u.id) await requireRole(db, u.id, c.workspace_id, ADMIN);
    await db.query('UPDATE connections SET revoked_at=now() WHERE id=$1', [c.id]);
    if (tg.enabled()) await enqueue(db, 'graph.sync', { entity: 'connection', id: c.id });
    return { ok: true };
  });

  // ----- Collections & tags -----
  app.get('/workspaces/:ws/collections', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    return db.query('SELECT c.id, c.name, array_remove(array_agg(cb.block_id), NULL) AS block_ids FROM collections c LEFT JOIN collection_blocks cb ON cb.collection_id=c.id WHERE c.workspace_id=$1 GROUP BY c.id ORDER BY c.created_at', [ws]);
  });
  app.post('/workspaces/:ws/collections', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const b = parse(z.object({ name: z.string().min(1).max(100), block_ids: z.array(z.string().uuid()).default([]) }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, EDITOR);
    const id = uuidv7();
    await db.tx(async (q) => {
      await q.query('INSERT INTO collections(id, workspace_id, name) VALUES ($1,$2,$3)', [id, ws, b.name]);
      for (const bid of b.block_ids) await q.query('INSERT INTO collection_blocks(collection_id, block_id) SELECT $1, id FROM blocks WHERE id=$2 AND workspace_id=$3 ON CONFLICT DO NOTHING', [id, bid, ws]);
    });
    return { id };
  });

  const collectionFor = async (db: any, userId: string, id: string, roles: typeof ANY) => {
    if (!isUuid(id)) throw new HttpError(400, 'bad_id');
    const c = (await db.query('SELECT * FROM collections WHERE id=$1', [id]))[0];
    if (!c) throw new HttpError(404, 'not_found');
    const role = await requireRole(db, userId, c.workspace_id, roles);
    return { c, role };
  };
  /** Editing a collection that is shared by card widens/narrows what the recipient gets, so it needs a context admin. */
  const assertCanEdit = async (db: any, c: any, role: string) => {
    const shared = (await db.query(`SELECT COUNT(*)::int AS n FROM cards WHERE collection_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [c.id]))[0].n;
    if (shared && !ADMIN.includes(role as any)) throw new HttpError(403, 'forbidden', 'This collection is shared by card; only a context admin can change it');
  };

  app.get('/collections/:id', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const { c } = await collectionFor(db, u.id, (req.params as any).id, ANY);
    const blocks = await db.query(`SELECT b.id, b.title, b.kind, b.status, b.access_mode, b.pinned, b.updated_at, v.version_no FROM collection_blocks cb JOIN blocks b ON b.id=cb.block_id
      LEFT JOIN block_versions v ON v.id=b.current_version_id WHERE cb.collection_id=$1 AND b.status <> 'revoked' AND (b.status <> 'draft' OR b.owner_id=$2) ORDER BY b.pinned DESC, b.title`, [c.id, u.id]);
    const cards = await db.query(`SELECT id, recipient_type, recipient_workspace_id, expires_at, revoked_at, share_record_id FROM cards WHERE collection_id=$1 ORDER BY created_at DESC`, [c.id]);
    return { id: c.id, workspace_id: c.workspace_id, name: c.name, created_at: c.created_at, blocks, cards };
  });

  app.post('/collections/:id/blocks', async (req) => {
    const u = await requireUser(req);
    const { block_id } = parse(z.object({ block_id: z.string().uuid() }), req.body);
    const db = await getDb();
    const { c, role } = await collectionFor(db, u.id, (req.params as any).id, EDITOR);
    await assertCanEdit(db, c, role);
    const b = (await db.query('SELECT id, owner_id, status, workspace_id FROM blocks WHERE id=$1 AND workspace_id=$2', [block_id, c.workspace_id]))[0];
    if (!b || b.status === 'revoked') throw new HttpError(404, 'block_not_found', 'Block not found in this workspace');
    const vis = (await latestRules(db, 'block', [b.id])).get(b.id)?.visibility;
    if (vis === 'private' && b.owner_id !== u.id) throw new HttpError(403, 'forbidden', 'Private blocks can only be added by their owner');
    return db.tx(async (q) => {
      const ins = await q.query('INSERT INTO collection_blocks(collection_id, block_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING block_id', [c.id, b.id]);
      if (ins.length) await recordCollectionShare(q, c.id, 'Block added to a shared collection');
      return { ok: true, added: ins.length > 0 };
    });
  });

  app.delete('/collections/:id/blocks/:blockId', async (req) => {
    const u = await requireUser(req);
    const { id, blockId } = req.params as any;
    if (!isUuid(blockId)) throw new HttpError(400, 'bad_id');
    const db = await getDb();
    const { c, role } = await collectionFor(db, u.id, id, EDITOR);
    await assertCanEdit(db, c, role);
    return db.tx(async (q) => {
      const del = await q.query('DELETE FROM collection_blocks WHERE collection_id=$1 AND block_id=$2 RETURNING block_id', [c.id, blockId]);
      if (del.length) await recordCollectionShare(q, c.id, 'Block removed from a shared collection');
      return { ok: true, removed: del.length > 0 };
    });
  });

  app.delete('/collections/:id', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const { c, role } = await collectionFor(db, u.id, (req.params as any).id, EDITOR);
    await assertCanEdit(db, c, role);
    await db.tx(async (q) => {
      // Cards sharing this collection stop working, so revoke them on the record.
      for (const k of await q.query(`UPDATE cards SET revoked_at=now() WHERE collection_id=$1 AND revoked_at IS NULL RETURNING id, recipient_type, recipient_workspace_id`, [c.id]))
        if (k.recipient_type !== 'user') await createRecord(q, { workspace_id: c.workspace_id, event: 'share_revoke', subject: { type: 'card', id: k.id }, recipient: { kind: k.recipient_type, id: k.recipient_workspace_id ?? k.id }, note: 'Shared collection deleted' });
      await q.query('DELETE FROM collections WHERE id=$1', [c.id]);
    });
    return { ok: true };
  });

  app.get('/workspaces/:ws/tags', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    return db.query('SELECT t.name, COUNT(bt.block_id)::int AS blocks FROM tags t LEFT JOIN block_tags bt ON bt.tag_id=t.id WHERE t.workspace_id=$1 GROUP BY t.name ORDER BY t.name', [ws]);
  });
}
