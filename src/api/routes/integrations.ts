import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.ts';
import { config } from '../../config.ts';
import { requireUser, requireRole, parse, ADMIN, EDITOR, ANY, enforceLimit } from '../http.ts';
import { connectWispr, finishWisprAuth, listMeetings } from '../../ingest/wispr.ts';
import { verifyGithubSignature } from '../../ingest/github.ts';
import { saveIntegration, getIntegration } from '../../integrations/store.ts';
import { createCheckout, verifyDodoWebhook } from '../../integrations/dodo.ts';
import { createBlock } from '../../core/content.ts';
import { enqueue } from '../../jobs/queue.ts';
import { HttpError, log, uuidv7 } from '../../util.ts';
import type { IngestPayload } from '../../ingest/pipeline.ts';

const Flow = z.object({ url: z.string().url(), secret: z.string().max(200).optional(), audience: z.enum(['public', 'team', 'external']).optional(), description: z.string().max(200).optional() });

export default async function integrationRoutes(app: FastifyInstance) {
  app.get('/workspaces/:ws/integrations', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    return db.query('SELECT provider, status, meta, updated_at FROM integrations WHERE workspace_id=$1', [ws]);
  });

  // ----- Wispr Notetaker (MCP client) -----
  app.post('/workspaces/:ws/integrations/wispr/connect', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, EDITOR);
    return connectWispr(db, ws);
  });
  app.get('/integrations/wispr/callback', async (req, reply) => {
    const { code, state, error } = req.query as any;
    if (error) return reply.redirect(`/app#integrations?wispr_error=${encodeURIComponent(error)}`);
    if (!code || !state) throw new HttpError(400, 'bad_callback');
    const u = await requireUser(req).catch(() => null);
    const db = await getDb();
    const ws = String(state).split('.')[0];
    if (u) await requireRole(db, u.id, ws, EDITOR);
    await finishWisprAuth(db, String(state), String(code));
    return reply.redirect('/app#integrations?wispr=connected');
  });
  app.get('/workspaces/:ws/integrations/wispr/meetings', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, EDITOR);
    return listMeetings(db, ws);
  });
  app.post('/workspaces/:ws/integrations/wispr/import', async (req, reply) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const b = parse(z.object({ meeting_id: z.string().min(1), title: z.string().max(200).optional() }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, EDITOR);
    await enforceLimit(db, ws, 'monthlyImports');
    const out = await db.tx(async (q) => {
      const id = await createBlock(q, { workspaceId: ws, ownerId: u.id, kind: 'conversation', title: b.title ?? 'Wispr meeting', sourceRef: { type: 'wispr', meeting_id: b.meeting_id }, processing: 'queued' });
      const job = await enqueue(q, 'ingest.run', { block_id: id, workspace_id: ws, user_id: u.id, source: { type: 'wispr', meeting_id: b.meeting_id, title: b.title } } satisfies IngestPayload);
      return { block_id: id, job_id: job };
    });
    return reply.code(202).send(out);
  });

  // ----- GitHub -----
  app.post('/workspaces/:ws/integrations/github/connect', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const b = parse(z.union([z.object({ token: z.string().min(10) }), z.object({ installation_id: z.union([z.string(), z.number()]) })]), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    const creds = 'token' in b ? { type: 'token', token: b.token } : { type: 'app', installation_id: String(b.installation_id) };
    if (creds.type === 'app' && !config.github.appId) throw new HttpError(400, 'app_not_configured', 'Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY');
    await saveIntegration(db, ws, 'github', creds, { mode: creds.type });
    return { ok: true, mode: creds.type };
  });
  app.post('/webhooks/github', async (req, reply) => {
    if (!verifyGithubSignature((req as any).rawBody ?? Buffer.from(''), req.headers['x-hub-signature-256'] as string)) return reply.code(401).send({ error: 'bad_signature' });
    const event = req.headers['x-github-event'];
    const body: any = req.body;
    if (event === 'push' && body?.repository?.full_name) {
      const db = await getDb();
      const wss = await db.query(`SELECT DISTINCT workspace_id FROM blocks WHERE source_ref->>'type'='github' AND source_ref->>'repo'=$1 AND status='active'`, [body.repository.full_name]);
      for (const w of wss) await enqueue(db, 'github.sync', { workspace_id: w.workspace_id, repo: body.repository.full_name });
      return { queued: wss.length };
    }
    return { ignored: event };
  });

  // ----- viaSocket -----
  app.post('/workspaces/:ws/integrations/viasocket', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const b = parse(z.object({
      flows: z.object({ 'review.requested': Flow.optional(), 'suggestion.created': Flow.optional(), 'access_request.created': Flow.optional(), 'digest.weekly': Flow.optional(), 'member.notify': Flow.optional(), 'security.alert': Flow.optional() }).default({}),
      actions: z.record(z.string().regex(/^[a-z_]+$/), Flow).default({}),
    }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    await saveIntegration(db, ws, 'viasocket', b, { flows: Object.keys(b.flows), actions: Object.keys(b.actions) });
    return { ok: true, flows: Object.keys(b.flows), actions: Object.keys(b.actions) };
  });

  // ----- Billing (Dodo Payments) -----
  app.post('/billing/checkout', async (req) => {
    const u = await requireUser(req);
    const { workspace_id } = parse(z.object({ workspace_id: z.string().uuid() }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, workspace_id, ['owner']);
    return createCheckout({ workspaceId: workspace_id, email: u.email, name: u.display_name, returnUrl: `${config.appUrl}/app#billing` });
  });
  app.get('/workspaces/:ws/billing', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ADMIN);
    const b = (await db.query('SELECT plan, status, current_period_end FROM billing WHERE workspace_id=$1', [ws]))[0];
    return { ...b, limits: config.plans[b?.plan ?? 'free'] };
  });
  app.post('/webhooks/dodo', async (req, reply) => {
    const raw = (req as any).rawBody as Buffer;
    if (!verifyDodoWebhook(raw, req.headers as any)) return reply.code(401).send({ error: 'bad_signature' });
    const db = await getDb();
    const id = String(req.headers['webhook-id']);
    if ((await db.query('INSERT INTO webhook_events(id, provider) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [id, 'dodo'])).length === 0) return { duplicate: true };
    const ev: any = req.body;
    const data = ev?.data ?? {};
    const ws = data.metadata?.workspace_id;
    if (!ws) { log('warn', 'dodo.no_workspace', { type: ev?.type }); return { ignored: true }; }
    const active = ['subscription.active', 'subscription.renewed', 'payment.succeeded', 'subscription.plan_changed'].includes(ev.type);
    const ended = ['subscription.cancelled', 'subscription.expired', 'subscription.failed', 'subscription.on_hold'].includes(ev.type);
    if (active || ended) {
      const plan = active ? 'team' : 'free';
      await db.tx(async (q) => {
        await q.query(`INSERT INTO billing(workspace_id, provider_customer_id, subscription_id, plan, status, current_period_end, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())
          ON CONFLICT (workspace_id) DO UPDATE SET provider_customer_id=COALESCE(EXCLUDED.provider_customer_id, billing.provider_customer_id), subscription_id=COALESCE(EXCLUDED.subscription_id, billing.subscription_id), plan=EXCLUDED.plan, status=EXCLUDED.status, current_period_end=COALESCE(EXCLUDED.current_period_end, billing.current_period_end), updated_at=now()`,
          [ws, data.customer?.customer_id ?? null, data.subscription_id ?? null, plan, active ? 'active' : ev.type.split('.')[1], data.next_billing_date ?? null]);
        await q.query('UPDATE workspaces SET plan=$2 WHERE id=$1', [ws, plan]);
      });
    }
    return { ok: true };
  });

  // ----- Sealed blocks (client-side encrypted; Embargo stores ciphertext only) -----
  app.post('/workspaces/:ws/sealed-blocks', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const b = parse(z.object({ ciphertext: z.string().min(1).max(30_000_000), wrapped_dek: z.string().min(1).max(2000), nonce: z.string().min(1).max(200), title: z.string().max(200).optional() }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, EDITOR);
    await enforceLimit(db, ws, 'blocks');
    return db.tx(async (q) => {
      const id = await createBlock(q, { workspaceId: ws, ownerId: u.id, kind: 'note', title: b.title || 'Sealed block', storageMode: 'sealed_block', status: 'active', visibility: 'team' });
      await q.query('INSERT INTO sealed_blocks(block_id, ciphertext, wrapped_dek, nonce) VALUES ($1,$2,$3,$4)', [id, b.ciphertext, b.wrapped_dek, b.nonce]);
      return { block_id: id };
    });
  });
  app.get('/workspaces/:ws/sealed-blocks', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    return db.query(`SELECT b.id, b.title, b.status, s.updated_at FROM blocks b JOIN sealed_blocks s ON s.block_id=b.id WHERE b.workspace_id=$1 AND b.status='active'`, [ws]);
  });
  app.get('/sealed-blocks/:id', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const r = (await db.query('SELECT s.*, b.workspace_id, b.title, b.status FROM sealed_blocks s JOIN blocks b ON b.id=s.block_id WHERE s.block_id=$1', [(req.params as any).id]))[0];
    if (!r || r.status !== 'active') throw new HttpError(404, 'not_found');
    await requireRole(db, u.id, r.workspace_id, ANY);
    return { block_id: r.block_id, title: r.title, ciphertext: r.ciphertext, wrapped_dek: r.wrapped_dek, nonce: r.nonce, updated_at: r.updated_at };
  });
  app.delete('/sealed-blocks/:id', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = (await db.query(`SELECT * FROM blocks WHERE id=$1 AND storage_mode='sealed_block'`, [(req.params as any).id]))[0];
    if (!b) throw new HttpError(404, 'not_found');
    const role = await requireRole(db, u.id, b.workspace_id, EDITOR);
    if (b.owner_id !== u.id && !ADMIN.includes(role)) throw new HttpError(403, 'forbidden');
    const { revokeBlock } = await import('../../core/revoke.ts');
    return db.tx(async (q) => { await q.query('DELETE FROM sealed_blocks WHERE block_id=$1', [b.id]); return revokeBlock(q, b.id, u.id); });
  });

  // Devices: WSK is encrypted by an existing device to the new device's X25519 public key after user approval.
  app.post('/workspaces/:ws/devices', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const b = parse(z.object({ label: z.string().min(1).max(80), public_key: z.string().min(20).max(500), wrapped_wsk: z.string().max(2000).optional() }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    const id = uuidv7();
    await db.query('INSERT INTO devices(id, workspace_id, user_id, label, public_key, wrapped_wsk, approved_by, approved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, ws, u.id, b.label, b.public_key, b.wrapped_wsk ?? null, b.wrapped_wsk ? u.id : null, b.wrapped_wsk ? new Date() : null]);
    return { device_id: id, approved: !!b.wrapped_wsk };
  });
  app.get('/workspaces/:ws/devices', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    return db.query('SELECT id, label, public_key, wrapped_wsk, approved_at, created_at FROM devices WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at', [ws, u.id]);
  });
  app.post('/workspaces/:ws/devices/:id/approve', async (req) => {
    const u = await requireUser(req);
    const { ws, id } = req.params as any;
    const { wrapped_wsk } = parse(z.object({ wrapped_wsk: z.string().min(20).max(2000) }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    const r = await db.query('UPDATE devices SET wrapped_wsk=$3, approved_by=$2, approved_at=now() WHERE id=$1 AND user_id=$2 AND workspace_id=$4 RETURNING id', [id, u.id, wrapped_wsk, ws]);
    if (!r.length) throw new HttpError(404, 'not_found');
    return { ok: true };
  });
}
