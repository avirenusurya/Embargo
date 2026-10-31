/** Record hashing, field encoding, scope codes, EAS off-chain UID + signatures, relayer coordination (Part 14). */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupEnv, teardown } from '../helpers/env.ts';

setupEnv();
const { keccak256, encodePacked, decodeAbiParameters, zeroAddress, zeroHash, toHex } = await import('viem');
const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
const eas = await import('../../src/chain/eas.ts');
const rec = await import('../../src/chain/records.ts');
const keys = await import('../../src/crypto/keys.ts');
const { getDb } = await import('../../src/db/index.ts');
const { uuidv7, HttpError } = await import('../../src/util.ts');
const { config } = await import('../../src/config.ts');
const db = await getDb();
after(() => teardown());

const WS = uuidv7();

test('event codes follow the Part 14.2 enumeration order', () => {
  assert.deepEqual(rec.EVENT_CODE, { share: 1, share_revoke: 2, consent: 3, consent_withdraw: 4, revoke: 5, key_destroyed: 6, unlock: 7 });
  assert.deepEqual([...rec.ONCHAIN_EVENTS].sort(), ['key_destroyed', 'revoke', 'share', 'share_revoke']);
  assert.deepEqual([...rec.BATCHED_EVENTS].sort(), ['consent', 'consent_withdraw', 'unlock']);
});

test('scope codes: bit layout and round trip for every combination', () => {
  const vis = ['private', 'team', 'partner', 'public'], modes = ['viewable', 'agent_only', 'sealed_use'], st = [undefined, 'allowed', 'team_only', 'blocked', 'embargo'];
  for (const v of vis) for (const m of modes) for (const e of [false, true]) for (const x of [false, true]) for (const s of st) {
    const code = rec.scopeCode({ visibility: v, access_mode: m, expiry: e, embargo: x, statement_status: s });
    assert.ok(code >= 0 && code < 2 ** 16, 'fits uint16');
    assert.deepEqual(rec.decodeScope(code), { visibility: v, access_mode: m, expiry: e, embargo: x, statement_status: s ?? null });
  }
  assert.equal(rec.scopeCode({}), 1, 'defaults: team, viewable, nothing set');
  assert.equal(rec.scopeCode({ visibility: 'public', access_mode: 'sealed_use', expiry: true, embargo: true, statement_status: 'embargo' }), 3 | (2 << 2) | (1 << 4) | (1 << 5) | (4 << 6));
});

test('subject/workspace/recipient hashes are keyed HMACs of the documented preimages', () => {
  const subject = { type: 'statement', id: uuidv7(), version: 3, content_hash: 'abc' };
  assert.equal(rec.subjectPreimage(subject), `statement|${subject.id}|3|abc`);
  assert.equal(rec.subjectPreimage({ type: 'card', id: 'x' }), 'card|x||');
  const f = rec.recordFields({ workspace_id: WS, event: 'consent', subject, recipient: { kind: 'workspace', id: 'w2' }, effective_at: new Date('2026-01-02T03:04:05.678Z') });
  const wsKey = keys.workspaceRecordKey(WS);
  assert.equal(f.subjectHash, '0x' + crypto.createHmac('sha256', wsKey).update(rec.subjectPreimage(subject)).digest('hex'));
  const global = Buffer.from(config.keys.recordHmacGlobalKey, 'base64');
  assert.equal(f.workspaceHash, '0x' + crypto.createHmac('sha256', global).update(`workspace|${WS}`).digest('hex'));
  assert.equal(f.recipientHash, '0x' + crypto.createHmac('sha256', global).update('workspace|w2').digest('hex'));
  assert.equal(f.eventType, 3);
  assert.equal(f.effectiveAt, BigInt(Math.floor(Date.parse('2026-01-02T03:04:05.678Z') / 1000)), 'effectiveAt is whole seconds');
  assert.equal(rec.recordFields({ workspace_id: WS, event: 'unlock', subject }).recipientHash, zeroHash, 'no recipient → 0x0');
  assert.notEqual(keys.workspaceRecordKey(WS).toString('hex'), keys.workspaceRecordKey(uuidv7()).toString('hex'), 'record key differs per workspace');
  assert.notEqual(rec.recordFields({ workspace_id: uuidv7(), event: 'consent', subject }).subjectHash, f.subjectHash, 'same item in another workspace hashes differently');
});

test('attestation data is ABI-encoded in SCHEMA order', () => {
  const f = { ...rec.recordFields({ workspace_id: WS, event: 'share', subject: { type: 'card', id: '1' }, scope: { visibility: 'partner', expiry: true } }), userSigHash: keccak256('0x1234') };
  const data = eas.encodeRecordData(f);
  const types = eas.SCHEMA.split(',').map((p) => ({ type: p.trim().split(' ')[0] }));
  assert.deepEqual(types.map((t) => t.type), ['bytes32', 'bytes32', 'bytes32', 'uint8', 'uint16', 'uint64', 'bytes32']);
  const d = decodeAbiParameters(types, data);
  assert.deepEqual(d, [f.subjectHash, f.workspaceHash, f.recipientHash, f.eventType, f.scopeCode, f.effectiveAt, f.userSigHash]);
});

test('schema UID is keccak256(schema, resolver, revocable) as in the EAS SchemaRegistry', () => {
  assert.equal(eas.schemaUidFor(), keccak256(encodePacked(['string', 'address', 'bool'], [eas.SCHEMA, zeroAddress, false])));
  assert.notEqual(eas.schemaUidFor(eas.SCHEMA, zeroAddress, true), eas.schemaUidFor());
});

test('off-chain UID matches the EAS v2 formula and changes with any field', () => {
  const m = { version: 2, schema: keccak256('0x01'), recipient: zeroAddress, time: 1700000000n, expirationTime: 0n, revocable: false, refUID: zeroHash, data: '0xdeadbeef' as const, salt: keccak256('0x02') };
  const expected = keccak256(encodePacked(['uint16', 'bytes', 'address', 'address', 'uint64', 'uint64', 'bool', 'bytes32', 'bytes', 'bytes32', 'uint32'],
    [2, m.schema, zeroAddress, zeroAddress, m.time, 0n, false, zeroHash, m.data, m.salt, 0]));
  assert.equal(eas.offchainUid(m), expected);
  assert.notEqual(eas.offchainUid({ ...m, data: '0xdeadbeee' }), expected);
  assert.notEqual(eas.offchainUid({ ...m, salt: keccak256('0x03') }), expected);
  assert.notEqual(eas.offchainUid({ ...m, time: 1700000001n }), expected);
});

test('relayer-signed off-chain attestation verifies; tampering is detected', async () => {
  const f = { ...rec.recordFields({ workspace_id: WS, event: 'consent', subject: { type: 'statement', id: 's1' } }), userSigHash: zeroHash };
  const att = await eas.signOffchain(f, 1700000000n, toHex(crypto.randomBytes(32)));
  const ok = await eas.verifyOffchain(att);
  assert.equal(ok.signer, eas.relayer.address);
  assert.ok(ok.valid && ok.uidMatches);
  const json = JSON.parse(JSON.stringify(att)); // survives a JSON round trip (as stored in records.offchain)
  assert.ok((await eas.verifyOffchain(json)).valid);
  const tamperedData = { ...json, message: { ...json.message, data: eas.encodeRecordData({ ...f, eventType: 4 }) } };
  const t1 = await eas.verifyOffchain(tamperedData);
  assert.ok(!t1.valid && !t1.uidMatches, 'changed data → different signer and uid mismatch');
  const other = privateKeyToAccount(generatePrivateKey());
  const forged = { ...json, signer: other.address, signature: await other.signTypedData({ domain: att.domain as any, types: att.types, primaryType: 'Attest', message: { ...att.message, time: 1700000000n, expirationTime: 0n } as any }) };
  const t2 = await eas.verifyOffchain(forged);
  assert.equal(t2.signer, other.address, 'recovers the forger');
  assert.equal(t2.valid, false, 'a self-consistent attestation by a non-relayer key is rejected (signer claim in the blob is not trusted)');
});

test('user EIP-712 signature (passkey wallet path, ECDSA fallback without RPC)', async () => {
  const user = privateKeyToAccount(generatePrivateKey());
  const base = rec.recordFields({ workspace_id: WS, event: 'consent', subject: { type: 'statement', id: 's2' } });
  const td = eas.userTypedData(base);
  assert.equal(td.domain.name, 'Embargo Records');
  const sig = await user.signTypedData({ ...td, message: { ...td.message, effectiveAt: base.effectiveAt } } as any);
  assert.equal(await eas.verifyUserSignature(user.address, base, sig), true);
  assert.equal(await eas.verifyUserSignature(privateKeyToAccount(generatePrivateKey()).address, base, sig), false, 'wrong address');
  assert.equal(await eas.verifyUserSignature(user.address, { ...base, eventType: 4 }, sig), false, 'different record');
});

test('createRecord stores a verifiable record; user signatures are bound by userSigHash', async () => {
  const id = await db.tx((q) => rec.createRecord(q, { workspace_id: WS, event: 'consent', subject: { type: 'statement', id: uuidv7(), version: 1, content_hash: 'h' }, scope: { statement_status: 'allowed' }, note: 'test' }));
  const v = await rec.verifyRecord(db, id);
  assert.equal(v.record.state, 'signed');
  assert.equal(v.record.signer_type, 'server');
  assert.ok(v.checks.relayer_signature.valid);
  assert.equal(v.checks.data_matches_attestation, true);
  assert.equal(v.merkle_proof, null, 'not batched while the chain is off');
  const row = (await db.query('SELECT * FROM records WHERE id=$1', [id]))[0];
  assert.equal(row.leaf_hash, keccak256(row.offchain_uid), 'leaf = keccak256(offchain uid)');

  const user = privateKeyToAccount(generatePrivateKey());
  const input = { workspace_id: WS, event: 'consent_withdraw' as const, subject: { type: 'statement', id: uuidv7() }, effective_at: new Date() };
  const base = rec.recordFields(input);
  const td = eas.userTypedData(base);
  const sig = await user.signTypedData({ ...td, message: { ...td.message, effectiveAt: base.effectiveAt } } as any);
  const uid = await db.tx((q) => rec.createRecord(q, { ...input, user: { address: user.address, signature: sig } }));
  const uv = await rec.verifyRecord(db, uid);
  assert.equal(uv.record.signer_type, 'user');
  assert.deepEqual(uv.checks.user_signature, { valid: true, bound: true });
  assert.equal(uv.record.user_signature, sig, 'signature exposed so third parties can verify it');
  const d = decodeAbiParameters(eas.SCHEMA.split(',').map((p) => ({ type: p.trim().split(' ')[0] })), (uv.offchain_attestation as any).message.data);
  assert.equal(d[6], keccak256(sig), 'userSigHash in the attestation');

  await assert.rejects(db.tx((q) => rec.createRecord(q, { ...input, user: { address: privateKeyToAccount(generatePrivateKey()).address, signature: sig } })),
    (e: any) => e instanceof HttpError && e.status === 400 && e.code === 'bad_signature');
});

test('verifyRecord flags a database row whose fields no longer match the signed attestation', async () => {
  const id = await db.tx((q) => rec.createRecord(q, { workspace_id: WS, event: 'unlock', subject: { type: 'block', id: uuidv7() } }));
  await db.query('UPDATE records SET scope_code = scope_code + 1 WHERE id=$1', [id]);
  const v = await rec.verifyRecord(db, id);
  assert.equal(v.checks.data_matches_attestation, false);
  await assert.rejects(rec.verifyRecord(db, uuidv7()), (e: any) => e.status === 404);
});

test('proof bundle lets an owner recompute subjectHash; the global key is never included', async () => {
  const subject = { type: 'card', id: uuidv7(), version: 2, content_hash: 'b1,b2' };
  const id = await db.tx((q) => rec.createRecord(q, { workspace_id: WS, event: 'share', subject, recipient: { kind: 'workspace', id: 'partner-ws' } }));
  const pb = await rec.proofBundle(db, id);
  const recomputed = '0x' + crypto.createHmac('sha256', Buffer.from(pb.proof.workspace_record_key.slice(2), 'hex')).update(pb.proof.subject_preimage).digest('hex');
  assert.equal(recomputed, pb.record.subject_hash);
  assert.equal(pb.proof.workspace_preimage, `workspace|${WS}`);
  assert.equal(pb.proof.recipient_preimage, 'workspace|partner-ws');
  const s = JSON.stringify(pb);
  assert.ok(!s.includes(config.keys.recordHmacGlobalKey) && !s.includes(Buffer.from(config.keys.recordHmacGlobalKey, 'base64').toString('hex')), 'global record key not disclosed');
  assert.ok(!s.includes(config.keys.localMasterKey), 'master key not disclosed');
});

test('on-chain events enqueue a submit job; batched events do not', async () => {
  const before = Number((await db.query(`SELECT COUNT(*)::int AS n FROM outbox WHERE topic='records.submit'`))[0].n);
  await db.tx((q) => rec.createRecord(q, { workspace_id: WS, event: 'revoke', subject: { type: 'block', id: uuidv7() } }));
  await db.tx((q) => rec.createRecord(q, { workspace_id: WS, event: 'consent', subject: { type: 'statement', id: uuidv7() } }));
  const afterN = Number((await db.query(`SELECT COUNT(*)::int AS n FROM outbox WHERE topic='records.submit'`))[0].n);
  assert.equal(afterN - before, 1);
});

test('anchorBatch is a no-op when the chain is not configured (records stay signed off-chain)', async () => {
  assert.equal(eas.chainEnabled(), false);
  assert.equal(await rec.anchorBatch(true), null);
  assert.equal(await rec.anchorBatch(false), null);
  const n = Number((await db.query(`SELECT COUNT(*)::int AS n FROM records WHERE state <> 'signed'`))[0].n);
  assert.equal(n, 0);
});

// ---------- anchoring decision ----------
const base = { force: false, pending: 10, batchSize: 500, intervalSeconds: 600, now: 10_000_000, lastBatchAt: null, oldestPendingAt: null, failures: 0, lastFailureAt: null };
test('anchorDue: size trigger, interval since last batch, first batch waits for the oldest record', () => {
  assert.deepEqual(rec.anchorDue({ ...base, pending: 0, force: true }), { due: false, reason: 'nothing_pending' });
  assert.deepEqual(rec.anchorDue({ ...base, force: true, lastBatchAt: base.now }), { due: true, reason: 'forced' });
  assert.deepEqual(rec.anchorDue({ ...base, pending: 500, lastBatchAt: base.now - 1000 }), { due: true, reason: 'size' });
  assert.deepEqual(rec.anchorDue({ ...base, pending: 499, lastBatchAt: base.now - 1000 }), { due: false, reason: 'waiting' });
  assert.deepEqual(rec.anchorDue({ ...base, lastBatchAt: base.now - 600_000 }), { due: true, reason: 'interval' });
  assert.deepEqual(rec.anchorDue({ ...base, lastBatchAt: base.now - 599_999 }), { due: false, reason: 'waiting' });
  assert.deepEqual(rec.anchorDue({ ...base, oldestPendingAt: base.now - 30_000 }), { due: false, reason: 'waiting' }, 'never anchored: wait for the oldest record');
  assert.deepEqual(rec.anchorDue({ ...base, oldestPendingAt: base.now - 600_000 }), { due: true, reason: 'interval' });
  assert.deepEqual(rec.anchorDue({ ...base, lastBatchAt: base.now - 3600_000, oldestPendingAt: base.now - 1000 }), { due: true, reason: 'interval' }, 'interval counts from the last batch, not the newest record');
});

test('anchorDue: failed attempts back off exponentially (30 s, 60 s, …, capped at the interval)', () => {
  const f = (failures: number, ago: number) => rec.anchorDue({ ...base, pending: 600, failures, lastFailureAt: base.now - ago }).reason;
  assert.equal(f(1, 29_000), 'backoff');
  assert.equal(f(1, 30_000), 'size');
  assert.equal(f(2, 59_000), 'backoff');
  assert.equal(f(2, 60_000), 'size');
  assert.equal(f(30, 599_000), 'backoff');
  assert.equal(f(30, 600_000), 'size', 'cap = interval');
  assert.equal(rec.anchorDue({ ...base, force: true, failures: 5, lastFailureAt: base.now }).reason, 'forced', 'admins can force through backoff');
});

test('insufficient-funds detection walks viem error causes', () => {
  assert.ok(rec.isInsufficientFunds({ name: 'InsufficientFundsError' }));
  assert.ok(rec.isInsufficientFunds({ name: 'ContractFunctionExecutionError', cause: { name: 'TransactionExecutionError', cause: { details: 'insufficient funds for gas * price + value' } } }));
  assert.ok(rec.isInsufficientFunds(new Error('Insufficient funds for gas * price + value: balance 0')));
  assert.ok(!rec.isInsufficientFunds(new Error('nonce too low')));
  assert.ok(!rec.isInsufficientFunds(null));
});

test('needed balance = one tx of gas at current price, or the configured floor', () => {
  assert.equal(rec.neededBalanceWei(1_000_000_000n, 0n), 300_000n * 1_000_000_000n);
  assert.equal(rec.neededBalanceWei(1n, 10n ** 15n), 10n ** 15n);
});

// ---------- lease + pause state (database) ----------
test('relayer lease: one holder at a time, expiry lets another take over, release frees it', async () => {
  const a = await rec.acquireLease(db, 'test-lease', 60_000);
  assert.ok(a);
  assert.equal(await rec.acquireLease(db, 'test-lease', 60_000), null, 'second caller (even in the same process) is refused');
  const both = await Promise.all([rec.acquireLease(db, 'race', 60_000), rec.acquireLease(db, 'race', 60_000), rec.acquireLease(db, 'race', 60_000)]);
  assert.equal(both.filter(Boolean).length, 1, 'concurrent acquire: exactly one winner');
  await rec.releaseLease(db, 'test-lease', 'someone-else');
  assert.equal(await rec.acquireLease(db, 'test-lease', 60_000), null, 'only the holder can release');
  await rec.releaseLease(db, 'test-lease', a!);
  const b = await rec.acquireLease(db, 'test-lease', 1);
  assert.ok(b && b !== a, 'free after release');
  await new Promise((r) => setTimeout(r, 20));
  const c = await rec.acquireLease(db, 'test-lease', 60_000);
  assert.ok(c && c !== b, 'expired lease can be taken over');
});

test('pause/resume is recorded once per transition', async () => {
  assert.equal((await rec.relayerStatus(db)).paused, false);
  await rec.pauseRelayer(db, 'low_balance', { balance: 5n, needed: 100n });
  await rec.pauseRelayer(db, 'insufficient_funds', { balance: 4n });
  const s = await rec.relayerStatus(db);
  assert.equal(s.paused, true);
  assert.equal(s.reason, 'insufficient_funds');
  assert.equal(s.last_balance_wei, '4');
  assert.equal(s.needed_wei, '100');
  assert.equal(await rec.resumeRelayer(db, 1000n), true);
  assert.equal(await rec.resumeRelayer(db, 1000n), false, 'already running');
  const after = await rec.relayerStatus(db);
  assert.equal(after.paused, false);
  assert.ok(after.resumed_at);
  const ev = await db.query('SELECT kind FROM relayer_events ORDER BY created_at, id');
  assert.deepEqual(ev.map((e) => e.kind), ['paused', 'resumed']);
});
