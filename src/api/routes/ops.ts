/**
 * Operations (Part 22.3) and cross-cutting hooks: Prometheus /metrics, /admin/analytics (R3), request metrics,
 * and the remote-MCP auth gate (Part 15.5 error shape) that also records connection IP ranges for anomaly alerts.
 * Registered with skip-override so its hooks apply to every route.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDb } from '../../db/index.ts';
import { config } from '../../config.ts';
import { authenticateConnection } from '../../mcp/gateway.ts';
import { noteConnectionIp } from '../../core/limits.ts';
import { inc, observe, render } from '../../core/metrics.ts';
import { HttpError } from '../../util.ts';

const bearer = (req: FastifyRequest) => { const a = String(req.headers.authorization ?? ''); return a.startsWith('Bearer ') ? a.slice(7).trim() : ''; };
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function opsRoutes(app: FastifyInstance) {
  // Remote MCP gate: invalid/revoked tokens get the spec's `unauthorized` error before the MCP transport runs.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0] !== '/mcp') return;
    try {
      const db = await getDb();
      const r = await authenticateConnection(db, bearer(req));
      await noteConnectionIp(db, { id: r.id, workspace_id: r.workspace_id! }, req.ip).catch(() => {});
    } catch (e: any) {
      inc('embargo_mcp_unauthorized_total', {}, 1, 'Remote MCP requests rejected as unauthorized');
      return reply.code(401).header('www-authenticate', 'Bearer').send({ jsonrpc: '2.0', error: { code: -32001, message: e?.message ?? 'unauthorized', data: { error: 'unauthorized' } }, id: null });
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/static/') || req.url.startsWith('/vendor/') || req.url.startsWith('/media/')) return;
    const route = req.routeOptions?.url ?? 'unmatched';
    inc('embargo_http_requests_total', { method: req.method, route, status: `${Math.floor(reply.statusCode / 100)}xx` }, 1, 'HTTP requests');
    observe('embargo_http_request_duration_ms', reply.elapsedTime, 'HTTP request duration in milliseconds');
  });

  app.get('/metrics', async (req, reply) => {
    if (config.ops.metricsToken && !same(bearer(req), config.ops.metricsToken)) return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' });
    const db = await getDb();
    const g = (await db.query(`SELECT
        (SELECT COUNT(*)::int FROM outbox WHERE processed_at IS NULL AND dead=false) AS queue_depth,
        (SELECT COUNT(*)::int FROM outbox WHERE processed_at IS NULL AND dead=false AND last_error IS NOT NULL) AS retrying,
        (SELECT COUNT(*)::int FROM outbox WHERE dead=true) AS dead,
        (SELECT COALESCE(SUM(tokens_served),0)::bigint FROM access_logs) AS tokens_served,
        (SELECT COALESCE(SUM(tokens_saved),0)::bigint FROM access_logs) AS tokens_saved,
        (SELECT COALESCE(SUM(withheld_count),0)::bigint FROM access_logs) AS withheld,
        (SELECT COUNT(*)::int FROM records WHERE state='signed') AS records_signed,
        (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at)),0)::int FROM records WHERE state='signed' AND batch_id IS NULL AND event IN ('consent','consent_withdraw','unlock')) AS anchor_lag,
        (SELECT COUNT(*)::int FROM held_actions WHERE status='held') AS held_actions,
        (SELECT COUNT(*)::int FROM suggestions WHERE status='open') AS open_suggestions`))[0];
    const byTopic = await db.query(`SELECT topic, COUNT(*)::int AS n FROM outbox WHERE processed_at IS NULL AND dead=false GROUP BY topic`);
    const deadByTopic = await db.query(`SELECT topic, COUNT(*)::int AS n FROM outbox WHERE dead=true GROUP BY topic`);
    const checks = await db.query(`SELECT channel, COUNT(*)::int AS n FROM access_logs WHERE created_at > now() - interval '1 hour' GROUP BY channel`);
    const n = Number;
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return render([
      { name: 'embargo_queue_depth', help: 'Pending outbox jobs', value: n(g.queue_depth) },
      ...byTopic.map((t) => ({ name: 'embargo_queue_depth_by_topic', help: 'Pending outbox jobs by topic', value: n(t.n), labels: { topic: t.topic } })),
      { name: 'embargo_jobs_retrying', help: 'Pending jobs that failed at least once', value: n(g.retrying) },
      { name: 'embargo_jobs_dead', help: 'Dead-lettered jobs', value: n(g.dead) },
      ...deadByTopic.map((t) => ({ name: 'embargo_jobs_dead_by_topic', help: 'Dead-lettered jobs by topic', value: n(t.n), labels: { topic: t.topic } })),
      { name: 'embargo_tokens_served_stored_total', help: 'Tokens served (all retained access logs)', value: n(g.tokens_served), type: 'counter' as const },
      { name: 'embargo_tokens_saved_stored_total', help: 'Tokens saved versus originals (all retained access logs)', value: n(g.tokens_saved), type: 'counter' as const },
      { name: 'embargo_withheld_items_stored_total', help: 'Items withheld by policy (all retained access logs)', value: n(g.withheld), type: 'counter' as const },
      ...checks.map((c) => ({ name: 'embargo_requests_last_hour', help: 'Logged gateway requests in the last hour by channel', value: n(c.n), labels: { channel: c.channel } })),
      { name: 'embargo_records_signed_pending', help: 'Records signed but not yet anchored/on-chain', value: n(g.records_signed) },
      { name: 'embargo_anchor_lag_seconds', help: 'Age of the oldest unanchored batchable record', value: n(g.anchor_lag) },
      { name: 'embargo_held_actions_open', help: 'Agent actions held for a context admin', value: n(g.held_actions) },
      { name: 'embargo_suggestions_open', help: 'Open context inbox suggestions', value: n(g.open_suggestions) },
    ]);
  });

  /** Product analytics (R3). Counts only; no content, names or ids. Requires ADMIN_TOKEN; 404 when unset. */
  app.get('/admin/analytics', async (req, reply) => {
    if (!config.ops.adminToken) throw new HttpError(404, 'not_found', 'Not found');
    if (!same(bearer(req), config.ops.adminToken)) return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' });
    const db = await getDb();
    const r = (await db.query(`SELECT
        (SELECT COUNT(*)::int FROM workspaces WHERE deleted_at IS NULL) AS workspaces,
        (SELECT COUNT(*)::int FROM workspaces WHERE deleted_at IS NULL AND plan <> 'free') AS paid_workspaces,
        (SELECT COUNT(*)::int FROM workspaces WHERE deleted_at IS NOT NULL) AS deleted_workspaces,
        (SELECT COUNT(*)::int FROM users) AS users,
        (SELECT COUNT(*)::int FROM users WHERE created_at > now() - interval '7 days') AS new_users_7d,
        (SELECT COUNT(*)::int FROM blocks WHERE status <> 'revoked') AS blocks,
        (SELECT COUNT(*)::int FROM blocks WHERE created_at > now() - interval '7 days') AS blocks_created_7d,
        (SELECT COUNT(*)::int FROM connections WHERE revoked_at IS NULL) AS connections,
        (SELECT COUNT(*)::int FROM connections WHERE revoked_at IS NULL AND last_used_at > now() - interval '7 days') AS active_connections_7d,
        (SELECT COUNT(*)::int FROM access_logs WHERE channel='mcp' AND created_at > now() - interval '7 days') AS reads_7d,
        (SELECT COUNT(*)::int FROM access_logs WHERE created_at > now() - interval '7 days') AS calls_7d,
        (SELECT COUNT(*)::int FROM access_logs WHERE channel='sealed' AND created_at > now() - interval '7 days') AS sealed_calls_7d,
        (SELECT COUNT(*)::int FROM access_logs WHERE channel='action' AND created_at > now() - interval '7 days') AS actions_7d,
        (SELECT COALESCE(SUM(tokens_saved),0)::bigint FROM access_logs WHERE created_at > now() - interval '7 days') AS tokens_saved_7d,
        (SELECT COALESCE(SUM(tokens_served),0)::bigint FROM access_logs WHERE created_at > now() - interval '7 days') AS tokens_served_7d,
        (SELECT COUNT(DISTINCT workspace_id)::int FROM access_logs WHERE created_at > now() - interval '7 days') AS active_workspaces_7d,
        (SELECT COUNT(DISTINCT workspace_id)::int FROM access_logs WHERE created_at > now() - interval '14 days' AND created_at <= now() - interval '7 days') AS active_workspaces_prev_7d,
        (SELECT COUNT(*)::int FROM (SELECT DISTINCT workspace_id FROM access_logs WHERE created_at > now() - interval '14 days' AND created_at <= now() - interval '7 days'
            INTERSECT SELECT DISTINCT workspace_id FROM access_logs WHERE created_at > now() - interval '7 days') t) AS retained_workspaces,
        (SELECT COUNT(*)::int FROM records WHERE event IN ('consent','consent_withdraw') AND created_at > now() - interval '7 days') AS reviews_7d,
        (SELECT COUNT(*)::int FROM records WHERE event='revoke' AND created_at > now() - interval '7 days') AS revokes_7d,
        (SELECT COUNT(*)::int FROM records WHERE event='share' AND created_at > now() - interval '7 days') AS shares_7d,
        (SELECT COUNT(*)::int FROM suggestions WHERE status IN ('approved','auto_applied') AND decided_at > now() - interval '7 days') AS suggestions_applied_7d,
        (SELECT COUNT(*)::int FROM suggestions WHERE status='rejected' AND decided_at > now() - interval '7 days') AS suggestions_rejected_7d,
        (SELECT COUNT(*)::int FROM held_actions WHERE created_at > now() - interval '7 days') AS actions_held_7d`))[0];
    const out: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(r)) out[k] = Number(v);
    out.retention_wow = out.active_workspaces_prev_7d ? Math.round((out.retained_workspaces! / out.active_workspaces_prev_7d) * 1000) / 1000 : null;
    return { generated_at: new Date().toISOString(), ...out };
  });
}
(opsRoutes as any)[Symbol.for('skip-override')] = true;
export default opsRoutes;
