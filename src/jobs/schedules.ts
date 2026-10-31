/**
 * Schedules (Part 18.2). Each tick claims a (name, period) row so a schedule runs once per period even with
 * several worker instances.
 */
import { getDb } from '../db/index.ts';
import { enqueue, registerHandler } from './queue.ts';
import { createRecord } from '../chain/records.ts';
import { notifyAdmins } from '../integrations/viasocket.ts';
import { relayerBalance, chainEnabled } from '../chain/eas.ts';
import { config } from '../config.ts';
import { log } from '../util.ts';
import { cleanupRateLimits, volumeSweep } from '../core/limits.ts';
import * as tg from '../integrations/tigergraph.ts';

const iso = (d: Date) => d.toISOString();
const SCHEDULES: { name: string; period: (d: Date) => string; topic: string; payload?: any }[] = [
  { name: 'unlock', period: (d) => iso(d).slice(0, 16), topic: 'sched.unlock' },
  // Every minute: anchorBatch() itself decides from BATCH_INTERVAL_SECONDS / BATCH_SIZE whether a batch is due.
  { name: 'anchor', period: (d) => iso(d).slice(0, 16), topic: 'records.anchor' },
  { name: 'hourly', period: (d) => iso(d).slice(0, 13), topic: 'sched.hourly' },
  { name: 'daily', period: (d) => iso(d).slice(0, 10), topic: 'cm.daily' },
  { name: 'weekly', period: (d) => { const w = new Date(d); w.setUTCDate(d.getUTCDate() - d.getUTCDay()); return iso(w).slice(0, 10); }, topic: 'cm.weekly' },
];

export async function tick(now = new Date()) {
  const db = await getDb();
  for (const s of SCHEDULES) {
    const claimed = await db.query('INSERT INTO schedule_runs(name, period) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING name', [s.name, s.period(now)]);
    if (claimed.length) await enqueue(db, s.topic, s.payload ?? {});
  }
}

let timer: NodeJS.Timeout | null = null;
export function startScheduler() {
  if (timer) return;
  tick().catch((e) => log('error', 'scheduler', { err: e.message }));
  timer = setInterval(() => tick().catch((e) => log('error', 'scheduler', { err: e.message })), 20_000);
}
export function stopScheduler() { if (timer) clearInterval(timer); timer = null; }

/** Every minute: timed embargoes that lifted → 'unlock' record + notification. */
export async function unlocks() {
  const db = await getDb();
  const due = await db.query(`SELECT r.* FROM rules r WHERE r.embargo_until IS NOT NULL AND r.embargo_until <= now() AND r.unlock_record_id IS NULL
     AND r.created_at = (SELECT MAX(created_at) FROM rules r2 WHERE r2.target_type=r.target_type AND r2.target_id=r.target_id) LIMIT 200`);
  for (const r of due) {
    await db.tx(async (q) => {
      const rec = await createRecord(q, { workspace_id: r.workspace_id, event: 'unlock', subject: { type: r.target_type, id: r.target_id }, effective_at: new Date(r.embargo_until) });
      await q.query('UPDATE rules SET unlock_record_id=$2 WHERE id=$1', [r.id, rec]);
      if (r.target_type === 'block') {
        const b = (await q.query('SELECT title FROM blocks WHERE id=$1', [r.target_id]))[0];
        await notifyAdmins(q, r.workspace_id, 'suggestion.created', 'unlock', `"${b?.title ?? 'A block'}" is no longer embargoed`, `/app#blocks/${r.target_id}`);
      }
    });
  }
}

/** Hourly: review deadlines + reminders, card expiry records, retention, anomaly sweep, graph catch-up, relayer balance. */
export async function hourly() {
  const db = await getDb();
  await enqueue(db, 'consent.deadlines', {});
  await enqueue(db, 'consent.reminders', {});
  if (tg.enabled()) await enqueue(db, 'graph.sync', { catch_up: true });
  for (const c of await db.query(`SELECT * FROM cards WHERE expires_at IS NOT NULL AND expires_at <= now() AND NOT expiry_recorded AND revoked_at IS NULL AND recipient_type <> 'user'`)) {
    await db.tx(async (q) => {
      await createRecord(q, { workspace_id: c.source_workspace_id, event: 'share_revoke', subject: { type: 'card', id: c.id }, recipient: { kind: c.recipient_type, id: c.recipient_workspace_id ?? c.id }, effective_at: new Date(c.expires_at), note: 'Card expired' });
      await q.query('UPDATE cards SET expiry_recorded=true WHERE id=$1', [c.id]);
    });
  }
  await db.query(`DELETE FROM access_logs WHERE created_at < now() - ($1 || ' days')::interval`, [String(config.limits.accessLogRetentionDays)]);
  await db.query(`DELETE FROM webauthn_challenges WHERE expires_at < now()`);
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await cleanupRateLimits(db);
  await db.query(`DELETE FROM schedule_runs WHERE ran_at < now() - interval '8 days'`);
  await volumeSweep(db).catch((e) => log('warn', 'anomaly.sweep', { err: e.message }));
  if (chainEnabled()) {
    const bal = await relayerBalance().catch(() => null);
    if (bal !== null && bal < 1_000_000_000_000_000n / 1000n) log('error', 'relayer.low_balance', { wei: bal.toString() }); // < 0.001 ETH
  }
}

registerHandler('sched.unlock', unlocks);
registerHandler('sched.hourly', hourly);
