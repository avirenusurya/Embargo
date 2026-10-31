/**
 * Limits and abuse controls (Parts 17.6, 19.3, 22.1): Postgres-backed rate limiter (shared by every API/worker
 * instance), monthly plan metering, and anomaly alerts (unusual token volume, new IP range per connection).
 */
import net from 'node:net';
import type { Queryable } from '../db/index.ts';
import { config } from '../config.ts';
import { HttpError, uuidv7, log } from '../util.ts';
import { inApp, notify, getConfig } from '../integrations/viasocket.ts';

/** Sliding window over two fixed 1-minute windows (previous window weighted by the unelapsed fraction). */
export async function rateLimit(q: Queryable, key: string, perMin: number): Promise<{ ok: boolean; retryAfter: number }> {
  const now = Date.now();
  const win = Math.floor(now / 60000);
  const elapsed = (now % 60000) / 60000;
  const r = (await q.query(`WITH up AS (INSERT INTO rate_limits(key, window_start, count) VALUES ($1,$2,1)
      ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count)
    SELECT (SELECT count FROM up) AS cur, COALESCE((SELECT count FROM rate_limits WHERE key=$1 AND window_start=$3), 0) AS prev`, [key, win, win - 1]))[0];
  const cur = Number(r.cur), prev = Number(r.prev);
  if (prev * (1 - elapsed) + cur <= perMin) return { ok: true, retryAfter: 0 };
  // Rejected calls don't consume quota.
  await q.query('UPDATE rate_limits SET count = count - 1 WHERE key=$1 AND window_start=$2', [key, win]);
  const c = cur - 1;
  const wait = c + 1 > perMin || !prev ? (1 - elapsed) * 60 : Math.max(0, (1 - (perMin - c - 1) / prev - elapsed) * 60);
  return { ok: false, retryAfter: Math.max(1, Math.ceil(wait)) };
}

export async function enforceRate(q: Queryable, key: string, perMin: number) {
  const rl = await rateLimit(q, key, perMin);
  if (!rl.ok) throw new HttpError(429, 'rate_limited', `Retry after ${rl.retryAfter}s`, { retry_after: rl.retryAfter });
}

export async function cleanupRateLimits(q: Queryable) {
  await q.query('DELETE FROM rate_limits WHERE window_start < $1', [Math.floor(Date.now() / 60000) - 5]);
}

/** Monthly plan metering (usage_counters). Throws 402 plan_limit when the plan allowance is used up. */
export async function meter(q: Queryable, ws: string, metric: 'sealedCalls', n = 1) {
  const plan = (await q.query('SELECT plan FROM workspaces WHERE id=$1', [ws]))[0]?.plan ?? 'free';
  const limit = (config.plans[plan] ?? config.plans.free)[metric];
  const period = new Date().toISOString().slice(0, 7);
  const v = Number((await q.query(`INSERT INTO usage_counters(workspace_id, metric, period, value) VALUES ($1,$2,$3,$4)
    ON CONFLICT (workspace_id, metric, period) DO UPDATE SET value = usage_counters.value + $4 RETURNING value`, [ws, metric, period, n]))[0].value);
  if (v > limit) {
    await q.query('UPDATE usage_counters SET value = value - $4 WHERE workspace_id=$1 AND metric=$2 AND period=$3', [ws, metric, period, n]);
    throw new HttpError(402, 'plan_limit', `Plan limit reached for ${metric} (${limit}/month). Upgrade to continue.`, { limit });
  }
  return { used: v, limit };
}

// ---------------- anomaly alerts ----------------
export function ipRange(ip: string) {
  const a = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(a)) return a.split('.').slice(0, 3).join('.') + '.0/24';
  if (net.isIPv6(a)) {
    const full = a.includes('::') ? (() => { const [h, t] = a.split('::'); const hs = h ? h.split(':') : [], ts = t ? t.split(':') : []; return [...hs, ...Array(8 - hs.length - ts.length).fill('0'), ...ts]; })() : a.split(':');
    return full.slice(0, 3).map((x) => x || '0').join(':') + '::/48';
  }
  return a;
}

async function raise(q: Queryable, ws: string, connectionId: string | null, kind: string, dedupeKey: string, hint: string, detail: Record<string, unknown>) {
  const ins = await q.query('INSERT INTO anomaly_alerts(id, workspace_id, connection_id, kind, detail, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id', [uuidv7(), ws, connectionId, kind, JSON.stringify(detail), dedupeKey]);
  if (!ins.length) return false;
  for (const a of await q.query(`SELECT user_id FROM memberships WHERE workspace_id=$1 AND role IN ('owner','context_admin')`, [ws])) await inApp(q, ws, a.user_id, 'anomaly', hint, '/app#connections');
  const flows = (await getConfig(q, ws)).flows ?? {};
  const key = (flows as any)['security.alert']?.url ? 'security.alert' : 'suggestion.created';
  await notify(q, ws, key as any, { summary_hint: hint, link: `${config.appUrl}/app#connections`, alert: kind, connection_id: connectionId }).catch((e) => log('warn', 'anomaly.notify_failed', { err: e.message }));
  log('warn', 'anomaly.alert', { ws, kind, connection_id: connectionId });
  return true;
}

/** New IP range (/24 v4, /48 v6) for a connection that has been used before → alert admins. */
export async function noteConnectionIp(q: Queryable, c: { id: string; workspace_id: string; tool_label?: string }, ip: string | undefined) {
  if (!ip) return;
  const range = ipRange(ip);
  const ex = (await q.query('SELECT last_seen FROM connection_ips WHERE connection_id=$1 AND ip_range=$2', [c.id, range]))[0];
  if (ex) {
    if (Date.now() - new Date(ex.last_seen).getTime() > 5 * 60000) await q.query('UPDATE connection_ips SET last_seen=now(), last_ip=$3 WHERE connection_id=$1 AND ip_range=$2', [c.id, range, ip]);
    return;
  }
  const prior = Number((await q.query('SELECT COUNT(*)::int AS n FROM connection_ips WHERE connection_id=$1', [c.id]))[0].n);
  const ins = await q.query('INSERT INTO connection_ips(connection_id, ip_range, last_ip) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING connection_id', [c.id, range, ip]);
  if (ins.length && prior > 0) {
    const label = c.tool_label ?? (await q.query('SELECT tool_label FROM connections WHERE id=$1', [c.id]))[0]?.tool_label ?? 'A connection';
    await raise(q, c.workspace_id, c.id, 'new_ip_range', `ip:${c.id}:${range}`, `"${label}" was used from a new network (${range}). Revoke the token if this wasn't expected.`, { ip_range: range });
  }
}

const lastVolumeCheck = new Map<string, number>(); // per-instance throttle only; alerts are deduped in Postgres
/** Tokens served in the last hour vs. the 7-day hourly average for one connection. */
export async function checkVolume(q: Queryable, connectionId: string, force = false) {
  if (!force && Date.now() - (lastVolumeCheck.get(connectionId) ?? 0) < 5 * 60000) return false;
  lastVolumeCheck.set(connectionId, Date.now());
  const r = (await q.query(`SELECT c.workspace_id, c.tool_label,
      COALESCE((SELECT SUM(tokens_served) FROM access_logs WHERE connection_id=$1 AND created_at > now() - interval '1 hour'), 0)::bigint AS last_hour,
      COALESCE((SELECT SUM(tokens_served) FROM access_logs WHERE connection_id=$1 AND created_at <= now() - interval '1 hour' AND created_at > now() - interval '169 hours'), 0)::bigint AS week
    FROM connections c WHERE c.id=$1`, [connectionId]))[0];
  if (!r) return false;
  const lastHour = Number(r.last_hour), avg = Number(r.week) / 168;
  if (lastHour < config.anomaly.tokensPerHour || lastHour < config.anomaly.volumeFactor * avg) return false;
  return raise(q, r.workspace_id, connectionId, 'token_volume', `volume:${connectionId}:${new Date().toISOString().slice(0, 13)}`,
    `"${r.tool_label}" received ${lastHour.toLocaleString('en')} tokens in the last hour (7-day average ${Math.round(avg).toLocaleString('en')}/hour). Check for a leaked token.`, { last_hour: lastHour, hourly_avg: Math.round(avg) });
}

/** Hourly sweep over connections active in the last hour. */
export async function volumeSweep(q: Queryable) {
  for (const c of await q.query(`SELECT DISTINCT connection_id FROM access_logs WHERE connection_id IS NOT NULL AND created_at > now() - interval '1 hour'`)) await checkVolume(q, c.connection_id, true);
}
