/**
 * viaSocket (Part 17.3). Outbound notifications and agent actions go to per-workspace viaSocket flow
 * webhook URLs (stored encrypted). Payloads carry hints and links only, never protected content.
 * Verify webhook-trigger specifics against viaSocket docs (Part 26 #3).
 */
import crypto from 'node:crypto';
import type { Queryable } from '../db/index.ts';
import { config, isDev } from '../config.ts';
import { getIntegration } from './store.ts';
import { log, HttpError, uuidv7 } from '../util.ts';

export type FlowKey = 'review.requested' | 'suggestion.created' | 'access_request.created' | 'digest.weekly' | 'member.notify' | 'security.alert';
export interface FlowConfig { url: string; secret?: string; audience?: 'public' | 'team' | 'external'; description?: string }
export interface ViaSocketConfig { flows?: Partial<Record<FlowKey, FlowConfig>>; actions?: Record<string, FlowConfig> }

export async function getConfig(q: Queryable, ws: string): Promise<ViaSocketConfig> {
  return ((await getIntegration(q, ws, 'viasocket'))?.credentials as ViaSocketConfig) ?? {};
}

async function postFlow(flow: FlowConfig, body: any) {
  const raw = JSON.stringify(body);
  const secret = flow.secret || config.viasocket.defaultSecret;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) { headers['x-embargo-secret'] = secret; headers['x-embargo-signature'] = crypto.createHmac('sha256', secret).update(raw).digest('hex'); }
  const r = await fetch(flow.url, { method: 'POST', headers, body: raw, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new HttpError(502, 'viasocket_error', `viaSocket flow returned ${r.status}`);
  return r.text().catch(() => '');
}

/** Sends a notification. Without a configured flow, dev mode logs it so links are usable locally. */
export async function notify(q: Queryable, ws: string, key: FlowKey, body: Record<string, any>) {
  const cfg = await getConfig(q, ws);
  const flow = cfg.flows?.[key];
  if (!flow?.url) {
    if (isDev) log('info', 'notify.dev', { key, ...body, contact: body.person_contact ? '[redacted]' : undefined });
    return { delivered: false };
  }
  await postFlow(flow, { event: key, workspace_id: ws, ...body });
  return { delivered: true };
}

export async function inApp(q: Queryable, ws: string, userId: string, kind: string, hint: string, link?: string) {
  await q.query('INSERT INTO notifications(id, workspace_id, user_id, kind, hint, link) VALUES ($1,$2,$3,$4,$5,$6)', [uuidv7(), ws, userId, kind, hint.slice(0, 300), link ?? null]);
}

/** Notify all context_admins/owners of a workspace (in-app + viaSocket). */
export async function notifyAdmins(q: Queryable, ws: string, key: FlowKey, kind: string, hint: string, link: string, extra: Record<string, any> = {}) {
  for (const a of await q.query(`SELECT user_id FROM memberships WHERE workspace_id=$1 AND role IN ('owner','context_admin')`, [ws])) await inApp(q, ws, a.user_id, kind, hint, link);
  return notify(q, ws, key, { summary_hint: hint, link, ...extra }).catch((e) => { log('warn', 'notify.failed', { key, err: e.message }); return { delivered: false }; });
}

export async function runActionFlow(q: Queryable, ws: string, action: string, target: string, payload: any) {
  const flow = (await getConfig(q, ws)).actions?.[action];
  if (!flow?.url) throw new HttpError(400, 'action_not_configured', `No viaSocket flow configured for action "${action}"`);
  return postFlow(flow, { action, target, payload, workspace_id: ws });
}
export async function actionAudience(q: Queryable, ws: string, action: string, target: string): Promise<'public' | 'team' | 'external'> {
  const flow = (await getConfig(q, ws)).actions?.[action];
  if (flow?.audience) return flow.audience;
  if (action === 'send_email') return 'external';
  if (/post_(tweet|x|public)|publish/.test(action)) return 'public';
  return 'team';
}
