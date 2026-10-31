/**
 * Outbox + job queue (Parts 18.1, 18.3). Domain changes and their outbox rows are written in the same
 * transaction; the dispatcher claims rows, runs the handler, retries with exponential backoff, and
 * dead-letters after MAX_ATTEMPTS. Postgres-backed (works on both PGlite and real Postgres).
 */
import { getDb, type Queryable } from '../db/index.ts';
import { log, sleep } from '../util.ts';
import { inc } from '../core/metrics.ts';

export type Handler = (payload: any, meta: { id: number; attempts: number }) => Promise<void>;
const handlers = new Map<string, Handler>();
const MAX_ATTEMPTS = 8;

export function registerHandler(topic: string, h: Handler) { handlers.set(topic, h); }

export async function enqueue(q: Queryable, topic: string, payload: any, delayMs = 0): Promise<number> {
  const r = await q.query<{ id: number }>(`INSERT INTO outbox(topic, payload, available_at) VALUES ($1,$2, now() + ($3 || ' milliseconds')::interval) RETURNING id`, [topic, JSON.stringify(payload), String(delayMs)]);
  return Number(r[0].id);
}

let running = false;
export async function runOnce(limit = 10): Promise<number> {
  const db = await getDb();
  const rows = await db.query(
    `UPDATE outbox SET locked_until = now() + interval '5 minutes', attempts = attempts + 1
     WHERE id IN (SELECT id FROM outbox WHERE processed_at IS NULL AND dead = false AND available_at <= now()
                  AND (locked_until IS NULL OR locked_until < now()) ORDER BY id LIMIT ${Number(limit)} FOR UPDATE SKIP LOCKED)
     RETURNING id, topic, payload, attempts`);
  for (const r of rows) {
    const h = handlers.get(r.topic);
    const id = Number(r.id);
    if (!h) { await db.query(`UPDATE outbox SET processed_at = now(), last_error = 'no handler' WHERE id=$1`, [id]); continue; }
    const t0 = Date.now();
    try {
      await h(typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload, { id, attempts: r.attempts });
      await db.query('UPDATE outbox SET processed_at = now(), last_error = NULL WHERE id=$1', [id]);
      log('info', 'job.done', { topic: r.topic, id, ms: Date.now() - t0 });
    } catch (e: any) {
      const dead = r.attempts >= MAX_ATTEMPTS;
      inc('embargo_job_failures_total', { topic: r.topic, dead: String(dead) }, 1, 'Job handler failures (dead=true when dead-lettered)');
      const backoffMs = Math.min(3600_000, 2000 * 2 ** (r.attempts - 1));
      await db.query(`UPDATE outbox SET last_error = $2, dead = $3, locked_until = NULL, available_at = now() + ($4 || ' milliseconds')::interval WHERE id=$1`,
        [id, String(e?.stack ?? e).slice(0, 2000), dead, String(backoffMs)]);
      log(dead ? 'error' : 'warn', dead ? 'job.dead' : 'job.retry', { topic: r.topic, id, attempts: r.attempts, err: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return rows.length;
}

/** Process jobs until the queue is empty (used by tests, seed and smoke scripts). */
export async function drain(maxRounds = 200) {
  for (let i = 0; i < maxRounds; i++) if ((await runOnce(25)) === 0) return;
}

export async function startDispatcher(intervalMs = 400) {
  if (running) return; running = true;
  (async () => {
    while (running) {
      try { const n = await runOnce(10); if (n === 0) await sleep(intervalMs); } catch (e: any) { log('error', 'dispatcher.error', { err: String(e.message) }); await sleep(2000); }
    }
  })();
}
export function stopDispatcher() { running = false; }
