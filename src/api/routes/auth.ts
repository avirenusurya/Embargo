/** Auth (Part 19.2): passkeys via SimpleWebAuthn, magic-link fallback, dev login (development only). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { getDb } from '../../db/index.ts';
import { config, isDev } from '../../config.ts';
import { createSession, currentUser, requireUser, parse, SESSION_COOKIE } from '../http.ts';
import { HttpError, uuidv7, randomToken, hashToken, log } from '../../util.ts';

async function sendEmail(to: string, subject: string, text: string) {
  return sendTransactionalEmail(to, subject, text);
}
export async function sendTransactionalEmail(to: string, subject: string, text: string) {
  if (!config.email.apiKey) { if (isDev) log('info', 'email.dev', { to: '[redacted]', subject }); return false; }
  // Resend-compatible transactional email API.
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${config.email.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: config.email.from, to, subject, text }) });
  if (!r.ok) log('warn', 'email.failed', { status: r.status });
  return r.ok;
}

async function findOrCreateUser(email: string | null, displayName: string) {
  const q = await getDb();
  if (email) { const u = (await q.query('SELECT id FROM users WHERE lower(email)=lower($1)', [email]))[0]; if (u) return u.id as string; }
  const id = uuidv7();
  await q.query('INSERT INTO users(id, display_name, email) VALUES ($1,$2,$3)', [id, displayName.slice(0, 100), email]);
  return id;
}

export default async function authRoutes(app: FastifyInstance) {
  const rp = config.webauthn;

  app.post('/auth/passkey/register/options', async (req) => {
    const body = parse(z.object({ display_name: z.string().min(1).max(100).optional(), email: z.string().email().optional() }), req.body);
    const existing = await currentUser(req);
    const q = await getDb();
    const userId = existing?.id ?? uuidv7();
    const creds = existing ? await q.query('SELECT credential_id, transports FROM passkey_credentials WHERE user_id=$1', [userId]) : [];
    const opts = await generateRegistrationOptions({
      rpName: rp.rpName, rpID: rp.rpId, userName: body.email ?? existing?.email ?? body.display_name ?? 'user', userDisplayName: body.display_name ?? existing?.display_name ?? '',
      userID: new TextEncoder().encode(userId), attestationType: 'none',
      excludeCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports ?? undefined })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    const cid = uuidv7();
    await q.query(`INSERT INTO webauthn_challenges(id, challenge, user_id, kind, expires_at) VALUES ($1,$2,$3,$4, now() + interval '5 minutes')`,
      [cid, opts.challenge, userId, JSON.stringify({ kind: 'register', existing: !!existing, display_name: body.display_name ?? 'User', email: body.email ?? null })]);
    return { challenge_id: cid, options: opts };
  });

  app.post('/auth/passkey/register/verify', async (req, reply) => {
    const body = parse(z.object({ challenge_id: z.string().uuid(), response: z.any() }), req.body);
    const q = await getDb();
    const ch = (await q.query(`DELETE FROM webauthn_challenges WHERE id=$1 AND expires_at > now() RETURNING *`, [body.challenge_id]))[0];
    if (!ch) throw new HttpError(400, 'challenge_expired');
    const meta = JSON.parse(ch.kind);
    const v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: ch.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpId }).catch((e) => { throw new HttpError(400, 'passkey_invalid', e.message); });
    if (!v.verified || !v.registrationInfo) throw new HttpError(400, 'passkey_invalid');
    const cred = v.registrationInfo.credential;
    if (!meta.existing) {
      if (meta.email && (await q.query('SELECT 1 FROM users WHERE lower(email)=lower($1)', [meta.email]))[0]) throw new HttpError(409, 'email_taken', 'Sign in with your existing passkey or magic link first');
      await q.query('INSERT INTO users(id, display_name, email) VALUES ($1,$2,$3)', [ch.user_id, meta.display_name, meta.email]);
    }
    await q.query('INSERT INTO passkey_credentials(id, user_id, credential_id, public_key, counter, transports) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv7(), ch.user_id, cred.id, Buffer.from(cred.publicKey), cred.counter, cred.transports ?? []]);
    await createSession(q, reply, ch.user_id);
    return { ok: true, user_id: ch.user_id };
  });

  app.post('/auth/passkey/login/options', async () => {
    const q = await getDb();
    const opts = await generateAuthenticationOptions({ rpID: rp.rpId, userVerification: 'preferred' });
    const cid = uuidv7();
    await q.query(`INSERT INTO webauthn_challenges(id, challenge, kind, expires_at) VALUES ($1,$2,'login', now() + interval '5 minutes')`, [cid, opts.challenge]);
    return { challenge_id: cid, options: opts };
  });

  app.post('/auth/passkey/login/verify', async (req, reply) => {
    const body = parse(z.object({ challenge_id: z.string().uuid(), response: z.any() }), req.body);
    const q = await getDb();
    const ch = (await q.query(`DELETE FROM webauthn_challenges WHERE id=$1 AND expires_at > now() RETURNING *`, [body.challenge_id]))[0];
    if (!ch) throw new HttpError(400, 'challenge_expired');
    const c = (await q.query('SELECT * FROM passkey_credentials WHERE credential_id=$1', [body.response?.id]))[0];
    if (!c) throw new HttpError(400, 'unknown_passkey');
    const v = await verifyAuthenticationResponse({
      response: body.response, expectedChallenge: ch.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpId,
      credential: { id: c.credential_id, publicKey: new Uint8Array(c.public_key), counter: Number(c.counter), transports: c.transports ?? undefined },
    }).catch((e) => { throw new HttpError(400, 'passkey_invalid', e.message); });
    if (!v.verified) throw new HttpError(400, 'passkey_invalid');
    await q.query('UPDATE passkey_credentials SET counter=$2 WHERE id=$1', [c.id, v.authenticationInfo.newCounter]);
    await createSession(q, reply, c.user_id);
    return { ok: true, user_id: c.user_id };
  });

  app.post('/auth/magic-link', async (req) => {
    const { email } = parse(z.object({ email: z.string().email() }), req.body);
    const q = await getDb();
    const token = randomToken('ml');
    await q.query(`INSERT INTO magic_links(token_hash, email, expires_at) VALUES ($1,$2, now() + interval '15 minutes')`, [hashToken(token), email.toLowerCase()]);
    const link = `${config.apiUrl}/auth/magic-link/${token}`;
    const sent = await sendEmail(email, 'Your Embargo sign-in link', `Sign in to Embargo: ${link}\nThis link expires in 15 minutes.`);
    return { ok: true, ...(isDev && !sent ? { dev_link: link } : {}) };
  });

  app.get('/auth/magic-link/:token', async (req, reply) => {
    const { token } = req.params as any;
    const q = await getDb();
    const ml = (await q.query(`UPDATE magic_links SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING email`, [hashToken(token)]))[0];
    if (!ml) throw new HttpError(410, 'link_expired');
    const uid = await findOrCreateUser(ml.email, ml.email.split('@')[0]);
    await createSession(q, reply, uid);
    return reply.redirect('/app');
  });

  if (isDev) app.post('/auth/dev-login', async (req, reply) => {
    const body = parse(z.object({ email: z.string().email(), display_name: z.string().min(1).max(100).optional() }), req.body);
    const uid = await findOrCreateUser(body.email.toLowerCase(), body.display_name ?? body.email.split('@')[0]);
    const q = await getDb();
    const token = await createSession(q, reply, uid);
    return { ok: true, user_id: uid, session: token };
  });

  app.post('/auth/logout', async (req, reply) => {
    const tok = req.cookies?.[SESSION_COOKIE];
    if (tok) await (await getDb()).query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(tok)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const u = await requireUser(req);
    const q = await getDb();
    const workspaces = await q.query('SELECT w.id, w.name, w.plan, m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.created_at', [u.id]);
    const notifications = await q.query('SELECT id, workspace_id, kind, hint, link, read_at, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [u.id]);
    return { user: u, workspaces, notifications };
  });
  app.post('/notifications/:id/read', async (req) => {
    const u = await requireUser(req);
    await (await getDb()).query('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2', [(req.params as any).id, u.id]);
    return { ok: true };
  });
  app.patch('/me', async (req) => {
    const u = await requireUser(req);
    const b = parse(z.object({ display_name: z.string().min(1).max(100).optional(), wallet_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() }), req.body);
    await (await getDb()).query('UPDATE users SET display_name=COALESCE($2, display_name), wallet_address=COALESCE($3, wallet_address) WHERE id=$1', [u.id, b.display_name ?? null, b.wallet_address ?? null]);
    return { ok: true };
  });
}
