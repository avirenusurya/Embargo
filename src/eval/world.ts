/**
 * Builds the evaluation world in-process, through the same entry points production uses:
 *  - REST API via Fastify `inject` (dev-login sessions, CSRF header, role checks, plan limits)
 *  - MCP tools via the gateway (`authenticateConnection` + `callTool`, the code behind /mcp)
 *  - background work via the real job queue, drained after each step (ingest, context manager, consent, revoke)
 * Requires process.env.DATA_DIR to point at an empty, isolated directory before this module is imported.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../api/server.ts';
import { getDb, type Db } from '../db/index.ts';
import '../jobs/index.ts';
import { drain } from '../jobs/queue.ts';
import { authenticateConnection, callTool } from '../mcp/gateway.ts';
import { BLOCKS } from './fixtures/corpus.ts';
import { ACTION_FLOWS, ALL_WHO, TEAM, type BlockFixture, type UserKey, type Who } from './fixtures/types.ts';
import { containsNeedle } from './lib.ts';

const USERS: Record<UserKey, { email: string; name: string }> = {
  asha: { email: 'asha@acme.test', name: 'Asha Rao' },
  priya: { email: 'priya@acme.test', name: 'Priya Nair' },
  rohan: { email: 'rohan@acme.test', name: 'Rohan Mehta' },
  kabir: { email: 'kabir@acme.test', name: 'Kabir Shah' },
  neha: { email: 'neha@acme.test', name: 'Neha Joshi' },
  devm: { email: 'dev@globex.test', name: 'Dev Malhotra' },
};
/** Which user owns each requester's connection, and its scopes. */
export const CONN_OWNER: Record<Who, { user: UserKey; label: string; scopes: string[] }> = {
  dev: { user: 'rohan', label: 'Claude Code (Rohan)', scopes: ['write_blocks', 'request_access', 'ask_sealed', 'perform_action'] },
  founder: { user: 'asha', label: 'Claude Desktop (Asha)', scopes: ['write_blocks', 'request_access', 'ask_sealed', 'perform_action'] },
  cursor: { user: 'kabir', label: 'Cursor (Kabir)', scopes: [] },
  contractor: { user: 'neha', label: 'Claude (Neha, contractor)', scopes: ['ask_sealed'] },
  partner: { user: 'devm', label: 'Globex Claude', scopes: ['ask_sealed'] },
};

export interface Conn { id: string; token: string; who?: Who }
export interface BlockState {
  key: string; id: string; fx: BlockFixture; status: string; processing: string;
  tokensOriginal: number; tokensCompressed: number; versionNo: number;
  sectionIds: Set<string>;
  statements: { id: string; ordinal: number; status: string; speaker: string }[];
  /** Statement statuses right after ingest (before speaker reviews): used for detection metrics. */
  initialStatements: { ordinal: number; status: string; speaker: string }[];
}
export interface ToolResult { ok: boolean; ms: number; text: string; structured: any; error?: { status: number; code: string; message: string } }

export interface World {
  app: FastifyInstance; db: Db; acme: string; globex: string;
  users: Record<UserKey, { id: string; cookie: string }>;
  conns: Record<Who, Conn>;
  blocks: Map<string, BlockState>;
  keyById: Map<string, string>;
  statementById: Map<string, { blockKey: string; status: string; ordinal: number }>;
  /** Section ids of versions that were later superseded by an edit (must never be served). */
  supersededSectionIds: Map<string, string[]>;
  mock: { url: string; received: { path: string; body: any }[] };
  warnings: string[];
  setupMs: number;
  api: (user: UserKey, method: string, url: string, body?: unknown) => Promise<any>;
  newConnection: (user: UserKey, label: string, scopes: string[]) => Promise<Conn>;
  /** MCP tool call exactly as the remote /mcp handler does it: authenticate the token, then callTool. Timed. */
  tool: (conn: Conn, name: string, args: any) => Promise<ToolResult>;
  close: () => Promise<void>;
}

export class ApiError extends Error { constructor(public status: number, public body: any, msg: string) { super(msg); } }

const sleepMs = (n: number) => new Promise((r) => setTimeout(r, n));

export async function buildWorld(log: (s: string) => void): Promise<World> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const db = await getDb();
  const app = await buildServer();
  await app.ready();

  // Mock viaSocket receiver (action flows post here when an action is allowed).
  const received: { path: string; body: any }[] = [];
  const mock = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { try { received.push({ path: req.url ?? '', body: JSON.parse(b || '{}') }); } catch { received.push({ path: req.url ?? '', body: b }); } res.end('ok'); });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${(mock.address() as any).port}`;

  const users = {} as World['users'];
  const api = async (user: UserKey | null, method: string, url: string, body?: unknown) => {
    const headers: Record<string, string> = { 'x-embargo-csrf': '1', accept: 'application/json' };
    if (user) headers.cookie = users[user].cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.inject({ method: method as any, url, headers, payload: body !== undefined ? JSON.stringify(body) : undefined });
    let out: any = null; try { out = res.json(); } catch { out = res.body; }
    if (res.statusCode >= 400) throw new ApiError(res.statusCode, out, `${method} ${url} → ${res.statusCode} ${JSON.stringify(out).slice(0, 300)}`);
    return out;
  };

  // ---- users (dev-login), workspaces, plan, members ----
  for (const [k, u] of Object.entries(USERS) as [UserKey, { email: string; name: string }][]) {
    const j = await api(null, 'POST', '/auth/dev-login', { email: u.email, display_name: u.name });
    users[k] = { id: j.user_id, cookie: `emb_session=${j.session}` };
  }
  const acme = (await api('asha', 'POST', '/workspaces', { name: 'Acme Notes (eval)' })).id as string;
  const globex = (await api('devm', 'POST', '/workspaces', { name: 'Globex (eval partner)' })).id as string;
  await upgradeToTeam(app, db, acme, warnings);
  for (const [u, role] of [['priya', 'context_admin'], ['rohan', 'editor'], ['kabir', 'editor'], ['neha', 'viewer']] as const)
    await api('asha', 'POST', `/workspaces/${acme}/members`, { email: USERS[u].email, role });
  const actions = Object.fromEntries(Object.entries(ACTION_FLOWS).map(([a, audience]) => [a, { url: `${mockUrl}/${a}`, audience }]));
  await api('asha', 'POST', `/workspaces/${acme}/integrations/viasocket`, { flows: {}, actions });

  const newConnection = async (user: UserKey, label: string, scopes: string[]): Promise<Conn> => {
    const ws = user === 'devm' ? globex : acme;
    const c = await api(user, 'POST', `/workspaces/${ws}/connections`, { tool_label: label, scopes });
    return { id: c.id, token: c.token };
  };
  const conns = {} as Record<Who, Conn>;
  for (const w of ALL_WHO) conns[w] = { ...(await newConnection(CONN_OWNER[w].user, CONN_OWNER[w].label, CONN_OWNER[w].scopes)), who: w };

  const tool = async (conn: Conn, name: string, args: any): Promise<ToolResult> => {
    const s = performance.now();
    try {
      const r = await authenticateConnection(db, conn.token);
      const out = await callTool(r, name as any, args);
      return { ok: true, ms: performance.now() - s, text: out.text, structured: out.structured };
    } catch (e: any) {
      return { ok: false, ms: performance.now() - s, text: '', structured: null, error: { status: e?.status ?? 500, code: e?.code ?? 'exception', message: String(e?.message ?? e) } };
    }
  };

  // ---- ingest the corpus through POST /workspaces/:ws/blocks (and create_block for the agent draft) ----
  const ids = new Map<string, string>();
  for (const fx of BLOCKS) {
    if (fx.createdVia === 'agent') {
      const r = await tool(conns.dev, 'create_block', { title: fx.title, content: fx.text });
      if (!r.ok) throw new Error(`create_block failed: ${r.error?.message}`);
      ids.set(fx.key, r.structured.block_id);
      continue;
    }
    const text = fx.source === 'transcript' ? fx.lines!.map((l) => `${l.speaker}: ${l.text}`).join('\n') : fx.text!;
    const body: any = { source: { type: fx.source, text }, title: fx.title, auto_publish: fx.status !== 'draft' };
    if (fx.access_mode) body.access_mode = fx.access_mode;
    if (fx.visibility && fx.visibility !== 'partner') body.visibility = fx.visibility;
    if (fx.pinned) body.pinned = true;
    const r = await api(fx.owner, 'POST', `/workspaces/${acme}/blocks`, body);
    ids.set(fx.key, r.block_id);
  }
  await drain();
  log(`  ingested ${ids.size} blocks`);

  // Statement statuses straight after ingest (before any speaker review) for the detection metric.
  const initial = new Map<string, BlockState['initialStatements']>();
  for (const fx of BLOCKS.filter((b) => b.source === 'transcript')) {
    const d = await api('asha', 'GET', `/blocks/${ids.get(fx.key)}`);
    initial.set(fx.key, (d.statements ?? []).map((s: any) => ({ ordinal: s.ordinal, status: s.status, speaker: s.speaker_label })));
  }

  // ---- rules (Part 8 inputs): partner visibility, allowed tools, purposes, embargo, expiry, answer policy ----
  const day = 86400_000;
  for (const fx of BLOCKS) {
    const patch: Record<string, unknown> = {};
    if (fx.partner) { patch.visibility = 'partner'; patch.partner_workspace_id = globex; }
    if (fx.allowedConnections) patch.allowed_connection_ids = fx.allowedConnections.map((w) => conns[w].id);
    if (fx.purposes) patch.purposes = fx.purposes;
    if (fx.embargo) patch.embargo_until = new Date(Date.now() + (fx.embargo === 'future' ? 30 * day : -day)).toISOString();
    if (fx.expires) patch.expires_at = new Date(Date.now() + (fx.expires === 'future' ? 30 * day : -day)).toISOString();
    if (fx.answer_policy) patch.answer_policy = fx.answer_policy;
    if (Object.keys(patch).length) {
      if (!patch.visibility) patch.visibility = fx.visibility ?? 'team';
      await api(fx.owner, 'POST', `/blocks/${ids.get(fx.key)}/rules`, patch);
    }
  }
  // ---- edits (superseded versions) ----
  const supersededSectionIds = new Map<string, string[]>();
  for (const fx of BLOCKS.filter((b) => b.editTo)) {
    const before = await api('asha', 'GET', `/blocks/${ids.get(fx.key)}`);
    supersededSectionIds.set(fx.key, (before.sections ?? []).map((s: any) => s.id));
    await api(fx.owner, 'PATCH', `/blocks/${ids.get(fx.key)}`, { text: fx.editTo, change_note: 'Policy update' });
  }
  await drain();
  // ---- cards to the partner workspace ----
  for (const fx of BLOCKS.filter((b) => b.cardToPartner)) await api(fx.owner, 'POST', `/blocks/${ids.get(fx.key)}/cards`, { recipient: { type: 'workspace', workspace_id: globex } });
  // ---- speaker reviews via the real review links (Part 12.5) ----
  for (const fx of BLOCKS.filter((b) => b.lines?.some((l) => l.review))) {
    const links: any[] = await api('asha', 'GET', `/blocks/${ids.get(fx.key)}/review-links`);
    for (const speaker of new Set(fx.lines!.filter((l) => l.review).map((l) => l.speaker))) {
      const link = links.find((l) => l.person === speaker);
      if (!link) { warnings.push(`review: no review link for ${speaker} in ${fx.key} (lines not held?)`); continue; }
      const token = String(link.link).split('/review/')[1];
      const view = await api(null, 'GET', `/review/${token}`);
      const decisions = [];
      for (const l of fx.lines!.filter((x) => x.review && x.speaker === speaker)) {
        const st = (view.statements as any[]).find((s) => containsNeedle(s.text, l.text.slice(0, 40)) || containsNeedle(l.text, s.text));
        if (st) decisions.push({ statement_id: st.id, status: l.review }); else warnings.push(`review: statement not found for "${l.text.slice(0, 40)}…"`);
      }
      if (decisions.length) await api(null, 'POST', `/review/${token}/decisions`, { decisions });
    }
  }
  // ---- lifecycle: archive, revoke ----
  for (const fx of BLOCKS.filter((b) => b.status === 'archived')) await api(fx.owner, 'POST', `/blocks/${ids.get(fx.key)}/archive`, {});
  for (const fx of BLOCKS.filter((b) => b.status === 'revoked')) await api(fx.owner, 'POST', `/blocks/${ids.get(fx.key)}/revoke`, {});
  await drain();

  // ---- snapshot ground-truth state the checks need (ids of current sections/statements, token counts) ----
  const blocks = new Map<string, BlockState>();
  const keyById = new Map<string, string>();
  const statementById: World['statementById'] = new Map();
  for (const fx of BLOCKS) {
    const id = ids.get(fx.key)!;
    keyById.set(id, fx.key);
    const d = await api('asha', 'GET', `/blocks/${id}`);
    const st = (d.statements ?? []).map((s: any) => ({ id: s.id, ordinal: s.ordinal, status: s.status, speaker: s.speaker_label }));
    for (const s of st) statementById.set(s.id, { blockKey: fx.key, status: s.status, ordinal: s.ordinal });
    blocks.set(fx.key, {
      key: fx.key, id, fx, status: d.status, processing: d.processing_state,
      tokensOriginal: Number(d.version?.tokens_original ?? 0), tokensCompressed: Number(d.version?.tokens_compressed ?? 0),
      versionNo: Number(d.version?.version_no ?? 0), sectionIds: new Set((d.sections ?? []).map((s: any) => s.id)), statements: st, initialStatements: initial.get(fx.key) ?? [],
    });
    const want = fx.status ?? (fx.createdVia === 'agent' ? 'draft' : 'active');
    if (d.status !== want) warnings.push(`block ${fx.key}: status ${d.status}, expected ${want} (processing ${d.processing_state}${d.processing_error ? `: ${d.processing_error}` : ''})`);
    if (fx.editTo && Number(d.version?.version_no) < 2) warnings.push(`block ${fx.key}: edit did not create a new version`);
  }
  log(`  world ready in ${((Date.now() - t0) / 1000).toFixed(1)}s (${blocks.size} blocks, ${statementById.size} statements, ${warnings.length} setup warnings)`);

  return {
    app, db, acme, globex, users, conns, blocks, keyById, statementById, supersededSectionIds, mock: { url: mockUrl, received }, warnings, setupMs: Date.now() - t0,
    api: (u, m, url, b) => api(u, m, url, b), newConnection, tool,
    close: async () => { await new Promise<void>((r) => mock.close(() => r())); await app.close().catch(() => {}); await sleepMs(50); await db.close().catch(() => {}); },
  };
}

/** Upgrade the eval workspace to the Team plan through the signed Dodo webhook (free plan allows 20 imports). */
async function upgradeToTeam(app: FastifyInstance, db: Db, ws: string, warnings: string[]) {
  const secret = process.env.DODO_WEBHOOK_SECRET ?? '';
  const body = JSON.stringify({ type: 'subscription.active', data: { metadata: { workspace_id: ws }, subscription_id: 'sub_eval', customer: { customer_id: 'cus_eval' } } });
  const id = `evt_${crypto.randomBytes(8).toString('hex')}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret);
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  const res = await app.inject({ method: 'POST', url: '/webhooks/dodo', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, payload: body });
  const plan = (await db.query('SELECT plan FROM workspaces WHERE id=$1', [ws]))[0]?.plan;
  if (res.statusCode !== 200 || plan !== 'team') {
    warnings.push(`plan upgrade via Dodo webhook failed (${res.statusCode}); set plan directly`);
    await db.query(`UPDATE workspaces SET plan='team' WHERE id=$1`, [ws]);
  }
}

/** Text of a block a requester could legitimately receive, per the hand labels (held/blocked lines excluded). */
export function servableText(b: BlockFixture, w: Who): string {
  if (!b.visibleTo.includes(w)) return '';
  if (b.lines) return b.lines.filter((l) => {
    const status = l.review ?? (l.expectHeld ? 'held' : 'allowed');
    return status === 'allowed' || (status === 'team_only' && TEAM.includes(w));
  }).map((l) => `${l.speaker}: ${l.text}`).join('\n');
  return b.editTo ?? b.text ?? '';
}

/** Fixture lint: a "never" needle must not appear in content the same requester may legitimately receive. */
export function lintFixtures(): string[] {
  const errs: string[] = [];
  for (const b of BLOCKS) {
    const checks: [string, Who[]][] = [
      ...(b.neverText ?? []).map((n): [string, Who[]] => [n, ALL_WHO]),
      ...Object.entries(b.neverTextFor ?? {}).flatMap(([w, ns]) => (ns ?? []).map((n): [string, Who[]] => [n, [w as Who]])),
    ];
    for (const [needle, whos] of checks) for (const o of BLOCKS) for (const w of whos) {
      if (containsNeedle(servableText(o, w), needle)) errs.push(`needle "${needle}" (from ${b.key}) appears in ${o.key}, which ${w} may receive`);
    }
  }
  const keys = BLOCKS.map((b) => b.key);
  for (const k of new Set(keys)) if (keys.filter((x) => x === k).length > 1) errs.push(`duplicate block key ${k}`);
  return errs;
}
