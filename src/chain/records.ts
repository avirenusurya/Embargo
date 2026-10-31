/**
 * Records + relayer (Parts 14.2–14.7). Content and plaintext ids never go on chain; only keyed hashes.
 * Low-volume events → individual on-chain attestations. High-volume → relayer-signed off-chain
 * attestations, batched into a Merkle root timestamped on EAS. Chain outages never affect the product.
 *
 * Relayer coordination: every transaction the relayer sends happens while holding the `relayer` lease
 * (one leader across all worker instances, which also keeps nonces sequential). If the wallet cannot pay
 * for gas, on-chain submission pauses (recorded in relayer_state, logged) and resumes by itself once funded;
 * off-chain signing continues regardless.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import { keccak256, toHex, zeroHash, type Hex } from 'viem';
import { getDb, type Queryable } from '../db/index.ts';
import { config } from '../config.ts';
import { workspaceRecordKey, hmacHex, recordWorkspaceHash, recordRecipientHash } from '../crypto/keys.ts';
import * as eas from './eas.ts';
import { buildTree, root, proof, verifyProof } from './merkle.ts';
import { enqueue, registerHandler } from '../jobs/queue.ts';
import { uuidv7, log, HttpError, sleep } from '../util.ts';

export type RecordEvent = 'share' | 'share_revoke' | 'consent' | 'consent_withdraw' | 'revoke' | 'key_destroyed' | 'unlock';
export const EVENT_CODE: Record<RecordEvent, number> = { share: 1, share_revoke: 2, consent: 3, consent_withdraw: 4, revoke: 5, key_destroyed: 6, unlock: 7 };
export const ONCHAIN_EVENTS: RecordEvent[] = ['share', 'share_revoke', 'revoke', 'key_destroyed'];
export const BATCHED_EVENTS: RecordEvent[] = ['consent', 'consent_withdraw', 'unlock'];

const VIS = { private: 0, team: 1, partner: 2, public: 3 } as Record<string, number>;
const MODE = { viewable: 0, agent_only: 1, sealed_use: 2 } as Record<string, number>;
const STMT = { allowed: 1, team_only: 2, blocked: 3, embargo: 4 } as Record<string, number>;
export function scopeCode(s: { visibility?: string; access_mode?: string; expiry?: boolean; embargo?: boolean; statement_status?: string }) {
  return (VIS[s.visibility ?? 'team'] ?? 1) | ((MODE[s.access_mode ?? 'viewable'] ?? 0) << 2) | ((s.expiry ? 1 : 0) << 4) | ((s.embargo ? 1 : 0) << 5) | ((STMT[s.statement_status ?? ''] ?? 0) << 6);
}
export function decodeScope(code: number) {
  const inv = (m: Record<string, number>, v: number) => Object.entries(m).find(([, x]) => x === v)?.[0] ?? null;
  return { visibility: inv(VIS, code & 3), access_mode: inv(MODE, (code >> 2) & 3), expiry: !!((code >> 4) & 1), embargo: !!((code >> 5) & 1), statement_status: inv(STMT, (code >> 6) & 7) };
}

export interface Subject { type: string; id: string; version?: number | string; content_hash?: string }
export const subjectPreimage = (s: Subject) => `${s.type}|${s.id}|${s.version ?? ''}|${s.content_hash ?? ''}`;

export interface CreateRecordInput {
  workspace_id: string; event: RecordEvent; subject: Subject; recipient?: { kind: string; id: string } | null;
  scope?: Parameters<typeof scopeCode>[0]; effective_at?: Date;
  user?: { address: Hex; signature: Hex } | null; // user-signed (passkey smart wallet)
  note?: string;
}

export function recordFields(i: CreateRecordInput) {
  const effectiveAt = i.effective_at ?? new Date();
  return {
    subjectHash: hmacHex(workspaceRecordKey(i.workspace_id), subjectPreimage(i.subject)) as Hex,
    workspaceHash: recordWorkspaceHash(i.workspace_id) as Hex,
    recipientHash: (i.recipient ? recordRecipientHash(i.recipient.kind, i.recipient.id) : zeroHash) as Hex,
    eventType: EVENT_CODE[i.event], scopeCode: scopeCode(i.scope ?? {}), effectiveAt: BigInt(Math.floor(effectiveAt.getTime() / 1000)),
  };
}

/** Record row → the attestation fields (what is signed and what goes on chain). */
function rowFields(r: any): eas.RecordFields {
  return {
    subjectHash: r.subject_hash, workspaceHash: r.workspace_hash, recipientHash: r.recipient_hash ?? zeroHash, eventType: EVENT_CODE[r.event as RecordEvent],
    scopeCode: r.scope_code, effectiveAt: BigInt(Math.floor(new Date(r.effective_at).getTime() / 1000)), userSigHash: (r.user_sig_hash ?? zeroHash) as Hex,
  };
}

/** Builds, verifies (if user-signed), signs and stores a record inside the caller's transaction. */
export async function createRecord(q: Queryable, i: CreateRecordInput): Promise<string> {
  const base = recordFields(i);
  let userSigHash: Hex = zeroHash;
  if (i.user) {
    const ok = await eas.verifyUserSignature(i.user.address, base, i.user.signature).catch(() => false);
    if (!ok) throw new HttpError(400, 'bad_signature', 'User signature does not match this record');
    userSigHash = keccak256(i.user.signature);
  }
  const fields = { ...base, userSigHash };
  const salt = toHex(crypto.randomBytes(32));
  const off = await eas.signOffchain(fields, BigInt(Math.floor(Date.now() / 1000)), salt);
  const id = uuidv7();
  await q.query(`INSERT INTO records(id, workspace_id, event, subject_hash, workspace_hash, recipient_hash, scope_code, effective_at, signer_type, signer_address, signature, user_sig_hash, subject_ref, offchain, offchain_uid, leaf_hash, state)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'signed')`,
    [id, i.workspace_id, i.event, fields.subjectHash, fields.workspaceHash, fields.recipientHash === zeroHash ? null : fields.recipientHash, fields.scopeCode,
      new Date(Number(fields.effectiveAt) * 1000), i.user ? 'user' : 'server', i.user ? i.user.address : eas.relayer.address, i.user ? i.user.signature : off.signature,
      userSigHash === zeroHash ? null : userSigHash, JSON.stringify({ ...i.subject, recipient: i.recipient ?? null, note: i.note ?? null }), JSON.stringify(off), off.uid, keccak256(off.uid)]);
  if (ONCHAIN_EVENTS.includes(i.event)) await enqueue(q, 'records.submit', { record_id: id });
  return id;
}

// ---------- Relayer coordination: lease ----------
export const RELAYER_LEASE = 'relayer';
const LEASE_TTL_MS = 5 * 60_000; // longer than the 120 s receipt wait, so a live holder never loses the lease mid-tx
const HOLDER_PREFIX = `${os.hostname()}:${process.pid}`;

/** Takes the named lease if it is free or expired. Every call gets its own holder id, so two calls in one process also exclude each other. */
export async function acquireLease(q: Queryable, name: string, ttlMs = LEASE_TTL_MS): Promise<string | null> {
  const holder = `${HOLDER_PREFIX}:${uuidv7()}`;
  const r = await q.query(
    `INSERT INTO chain_leases(name, holder, expires_at) VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)
     ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at, acquired_at = now()
       WHERE chain_leases.expires_at <= now()
     RETURNING holder`, [name, holder, String(ttlMs)]);
  return r.length && r[0].holder === holder ? holder : null;
}
export async function releaseLease(q: Queryable, name: string, holder: string) {
  await q.query('DELETE FROM chain_leases WHERE name=$1 AND holder=$2', [name, holder]);
}
async function acquireLeaseWithin(q: Queryable, name: string, waitMs: number) {
  const until = Date.now() + waitMs;
  for (;;) {
    const h = await acquireLease(q, name);
    if (h || Date.now() >= until) return h;
    await sleep(250);
  }
}

// ---------- Relayer coordination: funds, pause / resume ----------
const STATE_ID = 'relayer';
const GAS_PER_TX = 300_000n; // upper bound for an EAS attest/timestamp without a resolver

/** Balance needed before sending: one tx worth of gas at the current price, or RELAYER_MIN_BALANCE_WEI if higher. */
export function neededBalanceWei(gasPrice: bigint, floor = BigInt(process.env.RELAYER_MIN_BALANCE_WEI || '0')) {
  const est = gasPrice * GAS_PER_TX;
  return est > floor ? est : floor;
}
export async function relayerFunds() {
  const pc = eas.publicClient();
  const [balance, gasPrice] = await Promise.all([pc.getBalance({ address: eas.relayer.address }), pc.getGasPrice()]);
  const needed = neededBalanceWei(gasPrice);
  return { balance, needed, ok: balance >= needed };
}
/** True when a send failed because the relayer cannot pay (viem InsufficientFundsError or node message). */
export function isInsufficientFunds(e: any): boolean {
  for (let cur = e, i = 0; cur && i < 10; cur = cur.cause, i++) {
    if (cur.name === 'InsufficientFundsError') return true;
    const msg = `${cur.shortMessage ?? ''} ${cur.details ?? ''} ${cur.message ?? ''}`;
    if (/insufficient funds|exceeds the balance of the account|insufficient balance/i.test(msg)) return true;
  }
  return false;
}

export async function relayerStatus(q: Queryable) {
  const s = (await q.query('SELECT * FROM relayer_state WHERE id=$1', [STATE_ID]))[0];
  return {
    chain_enabled: eas.chainEnabled(), relayer: eas.relayer.address, paused: !!s?.paused_at, paused_at: s?.paused_at ?? null, reason: s?.pause_reason ?? null,
    last_balance_wei: s?.last_balance_wei ?? null, needed_wei: s?.needed_wei ?? null, resumed_at: s?.resumed_at ?? null,
  };
}
async function relayerEvent(q: Queryable, kind: string, detail: Record<string, unknown>) {
  await q.query('INSERT INTO relayer_events(id, kind, detail) VALUES ($1,$2,$3)', [uuidv7(), kind, JSON.stringify(detail)]);
}
export async function pauseRelayer(q: Queryable, reason: string, funds?: { balance?: bigint; needed?: bigint } | null) {
  const bal = funds?.balance?.toString() ?? null, need = funds?.needed?.toString() ?? null;
  const was = (await q.query('SELECT paused_at FROM relayer_state WHERE id=$1', [STATE_ID]))[0];
  await q.query(`INSERT INTO relayer_state(id, paused_at, pause_reason, last_balance_wei, needed_wei, updated_at) VALUES ($1, now(), $2, $3, $4, now())
    ON CONFLICT (id) DO UPDATE SET paused_at = COALESCE(relayer_state.paused_at, now()), pause_reason = $2, last_balance_wei = COALESCE($3, relayer_state.last_balance_wei),
      needed_wei = COALESCE($4, relayer_state.needed_wei), updated_at = now()`, [STATE_ID, reason, bal, need]);
  if (!was?.paused_at) {
    await relayerEvent(q, 'paused', { reason, balance_wei: bal, needed_wei: need });
    log('error', 'relayer.paused', { reason, relayer: eas.relayer.address, balance_wei: bal, needed_wei: need, note: 'On-chain submission paused; records stay signed off-chain. Fund the relayer to resume.' });
  }
}
export async function resumeRelayer(q: Queryable, balance?: bigint) {
  const r = await q.query(`UPDATE relayer_state SET paused_at = NULL, resumed_at = now(), last_balance_wei = COALESCE($2, last_balance_wei), updated_at = now() WHERE id=$1 AND paused_at IS NOT NULL RETURNING id`,
    [STATE_ID, balance?.toString() ?? null]);
  if (r.length) {
    await relayerEvent(q, 'resumed', { balance_wei: balance?.toString() ?? null });
    log('info', 'relayer.resumed', { relayer: eas.relayer.address, balance_wei: balance?.toString() ?? null });
  }
  return r.length > 0;
}
/** Pre-flight before sending: pauses when underfunded, resumes when funded. Returns true when sending may proceed. */
async function fundsGate(q: Queryable): Promise<{ ok: boolean; reason?: string }> {
  const status = await relayerStatus(q);
  let funds: Awaited<ReturnType<typeof relayerFunds>> | null = null;
  try { funds = await relayerFunds(); } catch (e: any) {
    // RPC unreachable: stay paused if paused; otherwise let the send fail and be retried.
    log('warn', 'relayer.rpc_unavailable', { err: String(e.shortMessage ?? e.message).slice(0, 200) });
    return status.paused ? { ok: false, reason: 'relayer_paused' } : { ok: true };
  }
  if (!funds.ok) { await pauseRelayer(q, 'low_balance', funds); return { ok: false, reason: 'relayer_low_balance' }; }
  if (status.paused) await resumeRelayer(q, funds.balance);
  return { ok: true };
}

// ---------- Anchoring decision (pure) ----------
export interface AnchorDueInput {
  force: boolean; pending: number; batchSize: number; intervalSeconds: number; now: number;
  lastBatchAt: number | null; oldestPendingAt: number | null; failures: number; lastFailureAt: number | null;
}
/**
 * Anchor when BATCH_SIZE records are pending (size trigger) or BATCH_INTERVAL_SECONDS have passed since the last
 * anchored batch (or since the oldest pending record when there has never been a batch). Failed attempts back off
 * exponentially from 30 s, capped at the interval. `force` anchors whatever is pending.
 */
export function anchorDue(o: AnchorDueInput): { due: boolean; reason: string } {
  if (o.pending <= 0) return { due: false, reason: 'nothing_pending' };
  if (o.force) return { due: true, reason: 'forced' };
  if (o.failures > 0 && o.lastFailureAt !== null) {
    const backoff = Math.min(o.intervalSeconds * 1000, 30_000 * 2 ** Math.min(o.failures - 1, 20));
    if (o.now - o.lastFailureAt < backoff) return { due: false, reason: 'backoff' };
  }
  if (o.pending >= o.batchSize) return { due: true, reason: 'size' };
  const ref = o.lastBatchAt ?? o.oldestPendingAt ?? o.now;
  if (o.now - ref >= o.intervalSeconds * 1000) return { due: true, reason: 'interval' };
  return { due: false, reason: 'waiting' };
}

const PENDING_SQL = `state='signed' AND batch_id IS NULL AND event = ANY($1::text[])`;
async function anchorInputs(q: Queryable, force: boolean): Promise<AnchorDueInput> {
  const p = (await q.query(`SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest FROM records WHERE ${PENDING_SQL}`, [BATCHED_EVENTS]))[0];
  const last = (await q.query(`SELECT MAX(anchored_at) AS t FROM record_batches WHERE state='anchored'`))[0];
  const fails = (await q.query(`SELECT COUNT(*)::int AS n, MAX(created_at) AS t FROM record_batches WHERE state='failed' AND created_at > COALESCE((SELECT MAX(anchored_at) FROM record_batches WHERE state='anchored'), 'epoch')`))[0];
  const ms = (d: any) => (d ? new Date(d).getTime() : null);
  return {
    force, pending: Number(p.n), batchSize: config.chain.batchSize, intervalSeconds: config.chain.batchIntervalSeconds, now: Date.now(),
    lastBatchAt: ms(last.t), oldestPendingAt: ms(p.oldest), failures: Number(fails.n), lastFailureAt: ms(fails.t),
  };
}

const errText = (e: any) => String(e?.shortMessage ?? e?.message ?? e).slice(0, 500);

// ---------- Relayer: individual on-chain attestations ----------
/** Sends one low-volume record on chain. Caller holds the relayer lease. Safe to call repeatedly. */
async function submitOne(q: Queryable, id: string): Promise<'onchain' | 'pending' | 'skipped'> {
  const r = (await q.query('SELECT * FROM records WHERE id=$1', [id]))[0];
  if (!r || r.state === 'onchain' || r.onchain_uid) return 'skipped';
  const pc = eas.publicClient();
  if (r.tx_hash) {
    // Sent before (e.g. the process died while waiting). Check the outcome before sending again.
    const rc = await pc.getTransactionReceipt({ hash: r.tx_hash }).catch(() => null);
    if (rc?.status === 'success') {
      const uid = eas.attestedUid(rc);
      if (uid) { await q.query(`UPDATE records SET onchain_uid=$2, state='onchain', last_error=NULL WHERE id=$1`, [r.id, uid]); return 'onchain'; }
    }
    if (!rc) {
      const tx = await pc.getTransaction({ hash: r.tx_hash }).catch(() => null);
      if (tx && tx.blockNumber == null) return 'pending';
    }
  }
  try {
    const { uid, tx } = await eas.attestOnchain(rowFields(r), { onSent: (h) => q.query('UPDATE records SET tx_hash=$2 WHERE id=$1', [r.id, h]) });
    await q.query(`UPDATE records SET onchain_uid=$2, tx_hash=$3, state='onchain', last_error=NULL WHERE id=$1`, [r.id, uid, tx]);
    log('info', 'records.onchain', { record: r.id, event: r.event, tx });
    return 'onchain';
  } catch (e: any) {
    await q.query('UPDATE records SET last_error=$2 WHERE id=$1', [r.id, errText(e)]);
    if (isInsufficientFunds(e)) await pauseRelayer(q, 'insufficient_funds', await relayerFunds().catch(() => null));
    throw e;
  }
}

/** Queue job for one record. If the chain is off or the relayer is paused it does nothing; the anchor tick sweeps it later. */
async function submitRecord(p: { record_id: string }) {
  if (!eas.chainEnabled()) return;
  const db = await getDb();
  if ((await relayerStatus(db)).paused) return;
  const holder = await acquireLeaseWithin(db, RELAYER_LEASE, 15_000);
  if (!holder) throw new HttpError(503, 'relayer_busy', 'Relayer lease held by another worker; will retry');
  try {
    if (!(await fundsGate(db)).ok) return;
    await submitOne(db, p.record_id);
  } finally { await releaseLease(db, RELAYER_LEASE, holder); }
}

// ---------- Relayer: Merkle batches ----------
const MAX_BATCHES_PER_RUN = 5;
const SWEEP_LIMIT = 20;

/**
 * Called every minute by the scheduler (force=false) and by admins (force=true). Decides internally whether a
 * batch is due, holds the relayer lease while sending, pauses when underfunded, and also re-sends low-volume
 * records that are still only signed (chain was off, relayer paused, or retries exhausted).
 * Returns null when there was nothing to do, `{ anchored: false, reason }` when work was skipped, or the batch.
 */
export async function anchorBatch(force = false) {
  if (!eas.chainEnabled()) return null;
  const db = await getDb();
  const holder = await acquireLease(db, RELAYER_LEASE);
  if (!holder) { log('info', 'records.anchor_skipped', { reason: 'lease_held' }); return force ? { anchored: false, reason: 'Another relayer instance is anchoring right now' } : null; }
  try {
    // Batches left half-done by a crashed holder: their records were never linked, so they are simply re-batched.
    await db.query(`UPDATE record_batches SET state='failed', last_error='abandoned' WHERE state='signed' AND created_at < now() - ($1 || ' milliseconds')::interval`, [String(LEASE_TTL_MS)]);
    let input = await anchorInputs(db, force);
    let decision = anchorDue(input);
    const stuck = await db.query(`SELECT id FROM records WHERE state='signed' AND onchain_uid IS NULL AND event = ANY($1::text[]) ${force ? '' : `AND created_at < now() - interval '2 minutes'`} ORDER BY created_at LIMIT ${SWEEP_LIMIT}`, [ONCHAIN_EVENTS]);
    const paused = (await relayerStatus(db)).paused;
    if (!decision.due && !stuck.length && !paused) return null;
    const gate = await fundsGate(db);
    if (!gate.ok) return { anchored: false, paused: true, reason: 'Relayer paused: balance too low to pay gas. Records stay signed off-chain until it is funded.' };
    if (!decision.due && !stuck.length) return null;

    for (const s of stuck) {
      try { await submitOne(db, s.id); } catch (e: any) {
        log('warn', 'records.submit_failed', { record: s.id, err: errText(e) });
        if (isInsufficientFunds(e)) return { anchored: false, paused: true, reason: 'Relayer paused: insufficient funds' };
      }
    }

    const done: { batch_id: string; root: Hex; tx: Hex; leaves: number; trigger: string }[] = [];
    while (decision.due && done.length < MAX_BATCHES_PER_RUN) {
      const pending = await db.query(`SELECT id, leaf_hash FROM records WHERE ${PENDING_SQL} ORDER BY created_at, id LIMIT $2`, [BATCHED_EVENTS, config.chain.batchSize]);
      if (!pending.length) break;
      const leaves = pending.map((p) => p.leaf_hash as Hex);
      const r = root(buildTree(leaves));
      const batchId = uuidv7();
      await db.query(`INSERT INTO record_batches(id, merkle_root, leaf_count, state) VALUES ($1,$2,$3,'signed')`, [batchId, r, pending.length]);
      try {
        const { tx } = await eas.timestampRoot(r, { onSent: (h) => db.query('UPDATE record_batches SET tx_hash=$2 WHERE id=$1', [batchId, h]) });
        await db.tx(async (q) => {
          await q.query(`UPDATE record_batches SET tx_hash=$2, state='anchored', anchored_at=now() WHERE id=$1`, [batchId, tx]);
          for (let i = 0; i < pending.length; i++) await q.query(`UPDATE records SET batch_id=$2, batch_index=$3, state='anchored' WHERE id=$1`, [pending[i].id, batchId, i]);
        });
        log('info', 'records.anchored', { batch: batchId, leaves: pending.length, tx, trigger: decision.reason });
        done.push({ batch_id: batchId, root: r, tx, leaves: pending.length, trigger: decision.reason });
      } catch (e: any) {
        await db.query(`UPDATE record_batches SET state='failed', last_error=$2 WHERE id=$1`, [batchId, errText(e)]);
        if (isInsufficientFunds(e)) {
          await pauseRelayer(db, 'insufficient_funds', await relayerFunds().catch(() => null));
          if (done.length) break;
          return { anchored: false, paused: true, reason: 'Relayer paused: insufficient funds' };
        }
        if (done.length) break;
        throw new HttpError(502, 'chain_unavailable', `Anchoring failed: ${errText(e)}`);
      }
      input = await anchorInputs(db, false);
      decision = { due: input.pending >= input.batchSize, reason: 'size' }; // keep going only while full batches remain
    }
    if (!done.length) return null;
    return { anchored: true, ...done[0], batches: done };
  } finally { await releaseLease(db, RELAYER_LEASE, holder); }
}

// ---------- Verification (14.7) ----------
export async function verifyRecord(q: Queryable, id: string) {
  const r = (await q.query('SELECT * FROM records WHERE id=$1', [id]))[0];
  if (!r) throw new HttpError(404, 'not_found');
  const off = typeof r.offchain === 'string' ? JSON.parse(r.offchain) : r.offchain;
  const checks: Record<string, any> = {};
  const v = await eas.verifyOffchain(off);
  checks.relayer_signature = { valid: v.valid && v.uidMatches, signer: v.signer, expected: v.expected, uid_matches: v.uidMatches };
  const fields = rowFields(r);
  checks.data_matches_attestation = eas.encodeRecordData(fields) === off.message.data;
  if (r.signer_type === 'user') {
    const { userSigHash, ...base } = fields;
    checks.user_signature = { valid: await eas.verifyUserSignature(r.signer_address, base, r.signature).catch(() => false), bound: keccak256(r.signature) === r.user_sig_hash };
  }
  let merkleProof: Hex[] | null = null, batch: any = null;
  if (r.batch_id) {
    batch = (await q.query('SELECT * FROM record_batches WHERE id=$1', [r.batch_id]))[0];
    const leaves = (await q.query('SELECT leaf_hash FROM records WHERE batch_id=$1 ORDER BY batch_index NULLS LAST, created_at, id', [r.batch_id])).map((x) => x.leaf_hash as Hex);
    const layers = buildTree(leaves);
    merkleProof = proof(layers, leaves.indexOf(r.leaf_hash));
    checks.merkle = { valid: verifyProof(r.leaf_hash, merkleProof, batch.merkle_root) && keccak256(off.uid) === r.leaf_hash, root: batch.merkle_root, tx: batch.tx_hash, leaf_count: leaves.length };
    if (eas.chainEnabled()) checks.merkle.onchain_timestamp = Number(await eas.getRootTimestamp(batch.merkle_root).catch(() => 0n));
  }
  if (r.onchain_uid && eas.chainEnabled()) {
    const a: any = await eas.getAttestation(r.onchain_uid).catch(() => null);
    checks.onchain = { found: !!a && a.uid === r.onchain_uid, data_matches: a ? a.data === eas.encodeRecordData(fields) : false, attester: a?.attester, attester_is_relayer: a ? String(a.attester).toLowerCase() === eas.relayer.address.toLowerCase() : false, time: a ? Number(a.time) : null };
  }
  return {
    record: {
      id: r.id, event: r.event, state: r.state, subject_hash: r.subject_hash, workspace_hash: r.workspace_hash, recipient_hash: r.recipient_hash, scope_code: r.scope_code, scope: decodeScope(r.scope_code),
      effective_at: r.effective_at, signer_type: r.signer_type, signer_address: r.signer_address, user_signature: r.signer_type === 'user' ? r.signature : undefined, user_sig_hash: r.user_sig_hash,
      onchain_uid: r.onchain_uid, tx_hash: r.tx_hash, chain_id: config.chain.chainId,
    },
    chain: { chain_id: config.chain.chainId, eas_address: config.chain.easAddress, schema: eas.SCHEMA, schema_uid: config.chain.schemaUid || null, relayer: eas.relayer.address, enabled: eas.chainEnabled() },
    offchain_attestation: off, merkle_leaf: r.leaf_hash,
    batch: batch ? { id: batch.id, merkle_root: batch.merkle_root, leaf_count: batch.leaf_count, tx_hash: batch.tx_hash, anchored_at: batch.anchored_at, state: batch.state } : null,
    merkle_proof: merkleProof, checks,
  };
}

/**
 * Proof bundle for owners: preimage + workspace record key to recompute subjectHash (dispute evidence).
 * workspaceHash/recipientHash use the global record key, which is never disclosed (it would let anyone test
 * guesses for every workspace); their preimages are included so a holder of that key (e.g. an auditor) can check them.
 */
export async function proofBundle(q: Queryable, id: string) {
  const v = await verifyRecord(q, id);
  const r = (await q.query('SELECT workspace_id, subject_ref FROM records WHERE id=$1', [id]))[0];
  const ref = typeof r.subject_ref === 'string' ? JSON.parse(r.subject_ref) : r.subject_ref;
  return {
    ...v,
    proof: {
      subject: ref, subject_preimage: subjectPreimage(ref), workspace_record_key: '0x' + workspaceRecordKey(r.workspace_id).toString('hex'),
      hash: 'subjectHash = HMAC-SHA256(workspace_record_key, subject_preimage)',
      workspace_preimage: `workspace|${r.workspace_id}`, recipient_preimage: ref.recipient ? `${ref.recipient.kind}|${ref.recipient.id}` : null,
      global_key_note: 'workspaceHash = HMAC-SHA256(global_record_key, workspace_preimage); recipientHash likewise. The global key is not disclosed.',
    },
  };
}

registerHandler('records.submit', submitRecord);
// The schedule fires every minute; the next tick is the retry, so failures are logged rather than re-queued.
registerHandler('records.anchor', async (p) => {
  try { await anchorBatch(!!p?.force); } catch (e: any) { log('warn', 'records.anchor_failed', { err: errText(e) }); }
});
