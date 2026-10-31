/** Shared API helpers: sessions, CSRF, roles, validation, plan limits. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, type Queryable } from '../db/index.ts';
import { config, isDev } from '../config.ts';
import { HttpError, hashToken, randomToken, isUuid } from '../util.ts';
import type { Requester } from '../core/policy.ts';

export const SESSION_COOKIE = 'emb_session';
export type Role = 'owner' | 'context_admin' | 'editor' | 'viewer';
export const ADMIN: Role[] = ['owner', 'context_admin'];
export const EDITOR: Role[] = ['owner', 'context_admin', 'editor'];
export const ANY: Role[] = ['owner', 'context_admin', 'editor', 'viewer'];

export async function createSession(q: Queryable, reply: FastifyReply, userId: string) {
  const token = randomToken('ses');
  await q.query(`INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '30 days')`, [hashToken(token), userId]);
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: !isDev || config.apiUrl.startsWith('https'), maxAge: 30 * 86400, signed: false });
  return token;
}

export async function currentUser(req: FastifyRequest): Promise<{ id: string; display_name: string; email: string | null; wallet_address: string | null } | null> {
  const tok = req.cookies?.[SESSION_COOKIE];
  if (!tok) return null;
  const q = await getDb();
  return (await q.query(`SELECT u.id, u.display_name, u.email, u.wallet_address FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now()`, [hashToken(tok)]))[0] ?? null;
}

export async function requireUser(req: FastifyRequest) {
  const u = await currentUser(req);
  if (!u) throw new HttpError(401, 'unauthorized', 'Sign in required');
  // CSRF: cookie-authenticated state-changing requests must carry a custom header (not settable cross-site without CORS).
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-embargo-csrf'] !== '1') throw new HttpError(403, 'csrf', 'Missing x-embargo-csrf header');
  return u;
}

export async function requireRole(q: Queryable, userId: string, ws: string, roles: Role[]) {
  if (!isUuid(ws)) throw new HttpError(400, 'bad_id');
  const m = (await q.query('SELECT role FROM memberships WHERE user_id=$1 AND workspace_id=$2', [userId, ws]))[0];
  if (!m) throw new HttpError(404, 'not_found', 'Workspace not found');
  if (!roles.includes(m.role)) throw new HttpError(403, 'forbidden', `Requires role: ${roles.join(' or ')}`);
  return m.role as Role;
}

export async function blockWorkspace(q: Queryable, blockId: string) {
  if (!isUuid(blockId)) throw new HttpError(400, 'bad_id');
  const b = (await q.query('SELECT * FROM blocks WHERE id=$1', [blockId]))[0];
  if (!b) throw new HttpError(404, 'not_found', 'Block not found');
  return b;
}

export const webRequester = (userId: string, ws: string | null): Requester => ({ kind: 'user', id: userId, workspace_id: ws, user_id: userId, scopes: ['read'] });

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new HttpError(400, 'invalid_request', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

export async function planLimits(q: Queryable, ws: string) {
  const w = (await q.query('SELECT plan FROM workspaces WHERE id=$1', [ws]))[0];
  return config.plans[w?.plan ?? 'free'] ?? config.plans.free;
}
export async function enforceLimit(q: Queryable, ws: string, what: 'members' | 'blocks' | 'connections' | 'monthlyImports') {
  const lim = await planLimits(q, ws);
  const sql = {
    members: `SELECT COUNT(*)::int AS n FROM memberships WHERE workspace_id=$1`,
    blocks: `SELECT COUNT(*)::int AS n FROM blocks WHERE workspace_id=$1 AND status <> 'revoked'`,
    connections: `SELECT COUNT(*)::int AS n FROM connections WHERE workspace_id=$1 AND revoked_at IS NULL`,
    monthlyImports: `SELECT COUNT(*)::int AS n FROM blocks WHERE workspace_id=$1 AND created_at > date_trunc('month', now())`,
  }[what];
  const n = (await q.query(sql, [ws]))[0].n;
  if (n >= lim[what]) throw new HttpError(402, 'plan_limit', `Plan limit reached for ${what} (${lim[what]}). Upgrade to continue.`);
}
