/** GET /ready (Part 22.3): readiness fields used by start.sh plus the relayer pause state (Part 20 "relayer out of gas"). */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, teardown } from '../helpers/env.ts';

setupEnv();
const H = await import('../helpers/server.ts');
const { getDb } = await import('../../src/db/index.ts');
const rec = await import('../../src/chain/records.ts');
const srv = await H.startServer();
after(async () => { await srv.close(); await teardown(); });

test('/ready keeps its existing fields and reports the relayer status', async () => {
  const r = await H.inject(srv.app, 'GET', '/ready');
  assert.equal(r.status, 200, r.text);
  for (const k of ['ok', 'db', 'llm', 'chain', 'relayer', 'tigergraph']) assert.ok(k in r.json, `field ${k}`);
  assert.equal(r.json.ok, true);
  assert.match(r.json.relayer, /^0x[0-9a-fA-F]{40}$/);
  assert.deepEqual(r.json.relayer_status, { paused: false, reason: null, paused_at: null });
});

test('a paused relayer shows in /ready without making the service unready', async () => {
  const db = await getDb();
  await rec.pauseRelayer(db, 'low_balance', { balance: 1n, needed: 100n });
  const r = await H.inject(srv.app, 'GET', '/ready');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, 'off-chain signing continues, so the API stays ready');
  assert.equal(r.json.relayer_status.paused, true);
  assert.equal(r.json.relayer_status.reason, 'low_balance');
  assert.ok(r.json.relayer_status.paused_at);
  await rec.resumeRelayer(db, 1000n);
  assert.equal((await H.inject(srv.app, 'GET', '/ready')).json.relayer_status.paused, false);
});
