import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.ts';
import { config } from '../../config.ts';
import { requireUser, requireRole, parse, ADMIN, ANY, EDITOR, blockWorkspace } from '../http.ts';
import { allowedItems, latestRules, type Requester } from '../../core/policy.ts';
import { readVersion } from '../../core/content.ts';
import { createRecord } from '../../chain/records.ts';
import { KeyRing } from '../../crypto/keys.ts';
import { enqueue } from '../../jobs/queue.ts';
import { HttpError, uuidv7, randomToken, hashToken } from '../../util.ts';
import * as tg from '../../integrations/tigergraph.ts';

const CardBody = z.object({
  recipient: z.discriminatedUnion('type', [
    z.object({ type: z.literal('user'), email: z.string().email().optional(), user_id: z.string().uuid().optional() }),
    z.object({ type: z.literal('workspace'), workspace_id: z.string().uuid() }),
    z.object({ type: z.literal('link') }),
  ]),
  scope: z.object({ note: z.string().max(300).optional(), purposes: z.array(z.string()).optional() }).default({}),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
});

async function createCard(userId: string, ws: string, target: { block_ids?: string[]; collection_id?: string }, body: z.infer<typeof CardBody>) {
  const db = await getDb();
  let recipientUser: string | null = null;
  const r = body.recipient;
  if (r.type === 'user') {
    const u = r.user_id ? (await db.query('SELECT id FROM users WHERE id=$1', [r.user_id]))[0] : r.email ? (await db.query('SELECT id FROM users WHERE lower(email)=lower($1)', [r.email]))[0] : null;
    if (!u) throw new HttpError(404, 'recipient_not_found', 'Recipient must have an Embargo account (or share by link)');
    recipientUser = u.id;
  }
  if (r.type === 'workspace') {
    if (r.workspace_id === ws) throw new HttpError(400, 'same_workspace');
    if (!(await db.query('SELECT 1 FROM workspaces WHERE id=$1', [r.workspace_id]))[0]) throw new HttpError(404, 'workspace_not_found');
  }
  const id = uuidv7();
  const token = r.type === 'link' ? randomToken('card') : null;
  const blockIds = target.block_ids ?? (await db.query('SELECT block_id FROM collection_blocks WHERE collection_id=$1', [target.collection_id])).map((x) => x.block_id);
  const rules = await latestRules(db, 'block', blockIds);
  const strictest = blockIds.map((b) => rules.get(b)?.visibility ?? 'team').sort((a, b) => ['private', 'team', 'partner', 'public'].indexOf(a) - ['private', 'team', 'partner', 'public'].indexOf(b))[0];
  return db.tx(async (q) => {
    await q.query(`INSERT INTO cards(id, source_workspace_id, recipient_type, recipient_user_id, recipient_workspace_id, link_token_hash, block_ids, collection_id, scope, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, ws, r.type, recipientUser, r.type === 'workspace' ? r.workspace_id : null, token ? hashToken(token) : null, target.block_ids ?? null, target.collection_id ?? null, JSON.stringify(body.scope), body.expires_at ?? null, userId]);
    if (body.scope.purposes?.length || body.expires_at) await q.query(`INSERT INTO rules(id, workspace_id, target_type, target_id, visibility, purposes, expires_at, set_by) VALUES ($1,$2,'card',$3,'partner',$4,$5,$6)`, [uuidv7(), ws, id, body.scope.purposes ?? null, body.expires_at ?? null, userId]);
    let recordId: string | null = null;
    if (r.type !== 'user') {
      recordId = await createRecord(q, {
        workspace_id: ws, event: 'share', subject: { type: 'card', id, version: blockIds.length, content_hash: blockIds.slice().sort().join(',') },
        recipient: { kind: r.type, id: r.type === 'workspace' ? r.workspace_id : id }, scope: { visibility: strictest, expiry: !!body.expires_at },
        note: `${blockIds.length} block(s) shared`,
      });
      await q.query('UPDATE cards SET share_record_id=$2 WHERE id=$1', [id, recordId]);
    }
    if (tg.enabled()) await enqueue(q, 'graph.sync', { entity: 'card', id });
    return { card_id: id, share_record_id: recordId, ...(token ? { link: `${config.appUrl}/c/${token}`, token } : {}) };
  });
}

export default async function sharingRoutes(app: FastifyInstance) {
  app.post('/blocks/:id/cards', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    const role = await requireRole(db, u.id, b.workspace_id, EDITOR);
    if (b.owner_id !== u.id && !ADMIN.includes(role)) throw new HttpError(403, 'forbidden');
    if (b.status === 'revoked') throw new HttpError(410, 'revoked');
    return createCard(u.id, b.workspace_id, { block_ids: [b.id] }, parse(CardBody, req.body));
  });
  app.post('/collections/:id/cards', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const c = (await db.query('SELECT * FROM collections WHERE id=$1', [(req.params as any).id]))[0];
    if (!c) throw new HttpError(404, 'not_found');
    await requireRole(db, u.id, c.workspace_id, ADMIN);
    return createCard(u.id, c.workspace_id, { collection_id: c.id }, parse(CardBody, req.body));
  });

  app.get('/workspaces/:ws/cards', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    const sent = await db.query(`SELECT c.id, c.recipient_type, c.recipient_user_id, c.recipient_workspace_id, w.name AS recipient_workspace, c.block_ids, c.collection_id, c.scope, c.expires_at, c.revoked_at, c.share_record_id, c.created_at
      FROM cards c LEFT JOIN workspaces w ON w.id=c.recipient_workspace_id WHERE c.source_workspace_id=$1 ORDER BY c.created_at DESC`, [ws]);
    const received = await db.query(`SELECT c.id, c.source_workspace_id, w.name AS source_workspace, c.block_ids, c.collection_id, c.expires_at, c.revoked_at, c.created_at FROM cards c JOIN workspaces w ON w.id=c.source_workspace_id
      WHERE c.recipient_workspace_id=$1 OR c.recipient_user_id=$2 ORDER BY c.created_at DESC`, [ws, u.id]);
    return { sent, received };
  });

  app.delete('/cards/:id', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const c = (await db.query('SELECT * FROM cards WHERE id=$1', [(req.params as any).id]))[0];
    if (!c) throw new HttpError(404, 'not_found');
    if (c.created_by !== u.id) await requireRole(db, u.id, c.source_workspace_id, ADMIN);
    if (c.revoked_at) return { ok: true, already: true };
    return db.tx(async (q) => {
      await q.query('UPDATE cards SET revoked_at=now() WHERE id=$1', [c.id]);
      const rec = c.recipient_type !== 'user' ? await createRecord(q, { workspace_id: c.source_workspace_id, event: 'share_revoke', subject: { type: 'card', id: c.id }, recipient: { kind: c.recipient_type, id: c.recipient_workspace_id ?? c.id } }) : null;
      if (tg.enabled()) await enqueue(q, 'graph.sync', { entity: 'card', id: c.id });
      return { ok: true, record_id: rec };
    });
  });

  /** Bind a link card to a workspace you administer, so that workspace's AI tools receive it. */
  app.post('/cards/accept/:token', async (req) => {
    const u = await requireUser(req);
    const { workspace_id } = parse(z.object({ workspace_id: z.string().uuid() }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, workspace_id, ADMIN);
    const c = (await db.query(`UPDATE cards SET recipient_workspace_id=$2 WHERE link_token_hash=$1 AND recipient_type='link' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND recipient_workspace_id IS NULL RETURNING id`, [hashToken((req.params as any).token), workspace_id]))[0];
    if (!c) throw new HttpError(410, 'card_unavailable', 'Card link is invalid, expired, revoked or already accepted');
    if (tg.enabled()) await enqueue(db, 'graph.sync', { entity: 'card', id: c.id });
    return { ok: true, card_id: c.id };
  });

  /** No-account card view: only viewable, permitted content of the shared blocks. */
  app.get('/c/:token', async (req, reply) => {
    if (String(req.headers.accept ?? '').includes('text/html')) return reply.sendFile('card.html');
    const db = await getDb();
    const c = (await db.query(`SELECT * FROM cards WHERE link_token_hash=$1 AND recipient_type='link'`, [hashToken((req.params as any).token)]))[0];
    if (!c || c.revoked_at || (c.expires_at && new Date(c.expires_at) < new Date())) throw new HttpError(410, 'card_unavailable');
    const r: Requester = { kind: 'card_link', id: c.id, card_id: c.id, workspace_id: null, user_id: null, scopes: ['read'] };
    const A = await allowedItems(db, r, 'web', new Date());
    const ok = A.items.filter((i) => i.form === 'text');
    const kr = new KeyRing(db);
    try {
      const blocks = [];
      for (const bid of new Set(ok.map((i) => i.block_id))) {
        const b = A.blocks.get(bid);
        const v = await readVersion(db, kr, b.current_version_id, { sectionIds: new Set(ok.filter((i) => i.type === 'section').map((i) => i.id)), statementIds: new Set(ok.filter((i) => i.type === 'statement').map((i) => i.id)) });
        blocks.push({ block_id: bid, title: b.title, version: v.versionNo, tokens: v.sections.reduce((s, x) => s + x.tokens, 0) + v.statements.reduce((s, x) => s + x.tokens, 0), sections: v.sections.map((s) => ({ heading: s.heading, text: s.text })), statements: v.statements.map((s) => ({ speaker: s.speaker_label, text: s.text })) });
      }
      await db.query(`INSERT INTO access_logs(id, workspace_id, channel, tool, block_ids, withheld_count, block_versions, tokens_served) VALUES ($1,$2,'web','card_link',$3,$4,$5,$6)`,
        [uuidv7(), c.source_workspace_id, blocks.map((b) => b.block_id), A.withheld.length, JSON.stringify(Object.fromEntries(blocks.map((b) => [b.block_id, b.version]))), blocks.reduce((s, b) => s + b.tokens, 0)]);
      return { card_id: c.id, expires_at: c.expires_at, blocks: blocks.map(({ tokens, ...b }) => b), withheld_count: A.withheld.length };
    } finally { kr.wipe(); }
  });
}
