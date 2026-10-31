/** Envelope encryption, AAD binding and crypto-shredding (Parts 13.2–13.3). */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, teardown } from '../helpers/env.ts';

setupEnv();
const keys = await import('../../src/crypto/keys.ts');
const { getDb } = await import('../../src/db/index.ts');
const { HttpError, uuidv7 } = await import('../../src/util.ts');
const { mkUser, mkWorkspace, mkBlock } = await import('../helpers/fixtures.ts');
const { revokeBlock } = await import('../../src/core/revoke.ts');
const { readVersion } = await import('../../src/core/content.ts');
const db = await getDb();
after(() => teardown());

const owner = await mkUser(db, 'Owner');
const ws = await mkWorkspace(db, owner);
const ws2 = await mkWorkspace(db, owner, 'Other');

test('encrypt → decrypt round trip; ciphertext reveals nothing and uses a fresh 96-bit nonce', async () => {
  const dek = await keys.createDataKey(db, ws);
  const kr = new keys.KeyRing(db);
  const row = uuidv7();
  const a = await kr.encrypt(dek, 'block_sections', row, 'Launch price is ₹499/month');
  const b = await kr.encrypt(dek, 'block_sections', row, 'Launch price is ₹499/month');
  assert.equal(a.nonce.length, 12);
  assert.notDeepEqual(a.nonce, b.nonce, 'random nonce per ciphertext');
  assert.notDeepEqual(a.ct, b.ct);
  assert.ok(!a.ct.toString('utf8').includes('499'));
  assert.equal(await kr.decrypt(dek, 'block_sections', row, a.ct, a.nonce), 'Launch price is ₹499/month');
  kr.wipe();
});

test('DEKs are stored only wrapped; the wrapped form is bound to its workspace and key id', async () => {
  const dek = await keys.createDataKey(db, ws);
  const row = (await db.query('SELECT * FROM data_keys WHERE id=$1', [dek]))[0];
  assert.equal(row.status, 'active');
  assert.equal(row.kek_id, `local:v1:${ws}`);
  assert.equal(Buffer.from(row.wrapped_key).length, 12 + 32 + 16, 'nonce + AES-GCM(32-byte DEK) + tag');
  // Moving the wrapped key to another workspace (or id) must not unwrap.
  const moved = uuidv7();
  await db.query('INSERT INTO data_keys(id, workspace_id, wrapped_key, kek_id) VALUES ($1,$2,$3,$4)', [moved, ws2, row.wrapped_key, row.kek_id]);
  await assert.rejects(new keys.KeyRing(db).dek(moved));
});

test('AAD mismatch (different table, row or workspace) fails authentication', async () => {
  const dek = await keys.createDataKey(db, ws);
  const kr = new keys.KeyRing(db);
  const row = uuidv7();
  const e = await kr.encrypt(dek, 'statements', row, 'secret line');
  await assert.rejects(kr.decrypt(dek, 'block_sections', row, e.ct, e.nonce), 'ciphertext swapped into another table');
  await assert.rejects(kr.decrypt(dek, 'statements', uuidv7(), e.ct, e.nonce), 'ciphertext swapped into another row');
  const flipped = Buffer.from(e.ct); flipped[0] ^= 1;
  await assert.rejects(kr.decrypt(dek, 'statements', row, flipped, e.nonce), 'tampered ciphertext');
  assert.equal(await kr.decrypt(dek, 'statements', row, e.ct, e.nonce), 'secret line');
  kr.wipe();
});

test('destroyed key ⇒ content permanently undecryptable, even from a backup of the ciphertext', async () => {
  const dek = await keys.createDataKey(db, ws);
  const kr = new keys.KeyRing(db);
  const row = uuidv7();
  const backup = await kr.encrypt(dek, 'facts', row, 'value 42');
  kr.wipe();
  assert.equal(await keys.destroyDataKeys(db, [dek]), 1);
  assert.equal(await keys.destroyDataKeys(db, [dek]), 0, 'idempotent');
  const k = (await db.query('SELECT wrapped_key, status, destroyed_at FROM data_keys WHERE id=$1', [dek]))[0];
  assert.equal(k.wrapped_key, null, 'wrapped key overwritten');
  assert.equal(k.status, 'destroyed');
  assert.ok(k.destroyed_at);
  await assert.rejects(new keys.KeyRing(db).decrypt(dek, 'facts', row, backup.ct, backup.nonce), (e: any) => e instanceof HttpError && e.status === 410 && e.code === 'key_destroyed');
});

test('a KeyRing that cached the DEK still refuses after destruction (status re-checked every use)', async () => {
  const dek = await keys.createDataKey(db, ws);
  const kr = new keys.KeyRing(db);
  const row = uuidv7();
  const e = await kr.encrypt(dek, 'facts', row, 'cached');
  await keys.destroyDataKeys(db, [dek]);
  await assert.rejects(kr.decrypt(dek, 'facts', row, e.ct, e.nonce), (x: any) => x.code === 'key_destroyed');
  kr.wipe();
});

test('revoking a block destroys every version key and derived data (crypto-shredding end to end)', async () => {
  const b = await mkBlock(db, { ws, owner, title: 'Secret plan', summary: 'Plan summary', sections: [{ heading: 'Body', text: 'The acquisition price is 5 crore.' }], facts: [{ entity: 'acquisition', attribute: 'price', value: '5 crore' }] });
  const kr = new keys.KeyRing(db);
  assert.match(JSON.stringify((await readVersion(db, kr, b.versionId)).sections), /5 crore/);
  kr.wipe();
  const out = await db.tx((q) => revokeBlock(q, b.id, owner));
  assert.ok(out.record_id, 'revoke record');
  const { drain } = await import('../../src/jobs/queue.ts');
  await import('../../src/jobs/index.ts');
  await drain();
  const k = (await db.query('SELECT status, wrapped_key FROM data_keys WHERE id=$1', [b.dekId]))[0];
  assert.equal(k.status, 'destroyed');
  assert.equal(k.wrapped_key, null);
  await assert.rejects(readVersion(db, new keys.KeyRing(db), b.versionId), (e: any) => e.code === 'key_destroyed');
  assert.equal(Number((await db.query('SELECT COUNT(*)::int AS n FROM embeddings WHERE block_id=$1', [b.id]))[0].n), 0, 'embeddings deleted');
  assert.equal(Number((await db.query('SELECT COUNT(*)::int AS n FROM facts WHERE block_id=$1', [b.id]))[0].n), 0, 'facts deleted');
  const recs = await db.query('SELECT event FROM records WHERE workspace_id=$1 ORDER BY created_at', [ws]);
  assert.ok(recs.some((r) => r.event === 'revoke') && recs.some((r) => r.event === 'key_destroyed'), 'revoke + key_destroyed records');
});

test('fact value hashes: equality without plaintext, normalised, keyed per workspace', () => {
  assert.equal(keys.factValueHash(ws, 'The ₹499/month.'), keys.factValueHash(ws, 'the  ₹499/MONTH'));
  assert.notEqual(keys.factValueHash(ws, '₹499/month'), keys.factValueHash(ws, '₹599/month'));
  assert.notEqual(keys.factValueHash(ws, '₹499/month'), keys.factValueHash(ws2, '₹499/month'), 'keyed: no cross-workspace comparison');
  assert.equal(keys.normaliseValue('An  Indigo.'), 'indigo');
});

// Regression (src/crypto/keys.ts normaliseValue): trim() used to run last, so leading/trailing whitespace stopped the
// article and trailing-punctuation rules from matching.
test('fact value normalisation ignores surrounding whitespace', () => {
  assert.equal(keys.normaliseValue('  The ₹499/month. '), '₹499/month');
  assert.equal(keys.normaliseValue('\t₹499.\n'), '₹499');
  assert.equal(keys.factValueHash(ws, '  The ₹499. '), keys.factValueHash(ws, '₹499'));
});

test('fact value normalisation is unchanged for values without surrounding whitespace (stored hashes stay valid)', () => {
  const previous = (v: string) => v.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').replace(/[.,;!]+$/, '').replace(/^(the|a|an)\s+/, '').trim();
  for (const v of ['₹499/month', 'The ₹499/month.', 'An  Indigo.', '20 Nov', 'the  launch!!', 'A', 'the .', 'a,', 'ﬁve ＄5', 'Mixed CASE; value;', '₹599/month now', 'the'])
    assert.equal(keys.normaliseValue(v), previous(v), v);
});
