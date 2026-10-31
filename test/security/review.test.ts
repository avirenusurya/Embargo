/** Review links (Parts 12.5, 19.2): bound to one person and one block version, single use, expiring, no replay. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, teardown, rand } from '../helpers/env.ts';

setupEnv();
const H = await import('../helpers/server.ts');
const { getDb } = await import('../../src/db/index.ts');
const { hashToken } = await import('../../src/util.ts');
const srv = await H.startServer();
after(async () => { await srv.close(); await teardown(); });
const db = await getDb();

const owner = await H.login(srv.app, `owner-${rand()}@rv.test`, 'Owner');
const ws = await H.mkWorkspace(owner, 'Review');
const conv = await H.mkTranscript(owner, ws, 'Client call', [
  '[00:01] Owner: Thanks for joining.',
  '[00:10] Meera Guest: Our budget for this deal is 5 lakh, mail meera@client.test',
  '[00:30] Ravi Outsider: My salary is 30 lakh and my phone is 98765 43210.',
].join('\n'));
const detail = await owner.ok('GET', `/blocks/${conv}`);
const held = detail.statements.filter((s: any) => s.status === 'held');
const links = await owner.ok('GET', `/blocks/${conv}/review-links`);
const tok = (name: string) => links.find((l: any) => l.person === name).link.split('/review/')[1] as string;
const meera = tok('Meera Guest');
const ravi = tok('Ravi Outsider');
const ravisStatement = held.find((s: any) => s.speaker_label === 'Ravi Outsider').id;
const meerasStatement = held.find((s: any) => s.speaker_label === 'Meera Guest').id;
const view = (t: string) => H.inject(srv.app, 'GET', `/review/${t}`, undefined, { accept: 'application/json' });
const decide = (t: string, decisions: any[]) => H.inject(srv.app, 'POST', `/review/${t}/decisions`, { decisions });

test('fixture: both outsiders have held lines and their own links', () => {
  assert.ok(held.length >= 2, JSON.stringify(detail.statements.map((s: any) => [s.speaker_label, s.status])));
  assert.ok(meera && ravi && meera !== ravi);
});

test('a review page shows only that speaker’s statements', async () => {
  const r = await view(meera);
  assert.equal(r.status, 200);
  assert.equal(r.json.person, 'Meera Guest');
  assert.ok(r.json.statements.length >= 1);
  assert.ok(r.json.statements.every((s: any) => s.id !== ravisStatement));
  assert.ok(!r.text.includes('30 lakh') && !r.text.includes('98765'), 'other speaker’s text never shown');
  assert.ok(!r.text.includes('Thanks for joining'), 'unflagged lines of others never shown');
});

test('a token cannot decide another speaker’s statement, and the failed attempt does not burn the token', async () => {
  const r = await decide(meera, [{ statement_id: ravisStatement, status: 'allowed' }]);
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'not_your_statement');
  const mixed = await decide(meera, [{ statement_id: meerasStatement, status: 'allowed' }, { statement_id: ravisStatement, status: 'allowed' }]);
  assert.equal(mixed.status, 403, 'mixed batch rejected as a whole');
  const st = (await db.query('SELECT status FROM statements WHERE id = ANY($1::uuid[])', [[ravisStatement, meerasStatement]])).map((x) => x.status);
  assert.deepEqual(st, ['held', 'held'], 'nothing applied');
  assert.equal((await view(meera)).status, 200, 'token still usable');
});

test('decisions are applied once, recorded, and the token cannot be replayed', async () => {
  const r = await decide(meera, [{ statement_id: meerasStatement, status: 'blocked' }]);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.results[0].record_id);
  const rec = await H.inject(srv.app, 'GET', `/verify/${r.json.results[0].record_id}`, undefined, { accept: 'application/json' });
  assert.equal(rec.json.record.event, 'consent_withdraw');
  assert.ok(rec.json.checks.relayer_signature.valid);
  const replay = await decide(meera, [{ statement_id: meerasStatement, status: 'allowed' }]);
  assert.equal(replay.status, 410);
  assert.equal((await view(meera)).status, 410, 'used link cannot be viewed again');
  assert.equal((await db.query('SELECT status FROM statements WHERE id=$1', [meerasStatement]))[0].status, 'blocked', 'replay changed nothing');
});

test('concurrent submissions with the same token: exactly one wins', async () => {
  const fresh = (await owner.ok('GET', `/blocks/${conv}/review-links`)).find((l: any) => l.person === 'Ravi Outsider').link.split('/review/')[1];
  const results = await Promise.all([1, 2, 3].map(() => decide(fresh, [{ statement_id: ravisStatement, status: 'team_only' }])));
  assert.equal(results.filter((x) => x.status === 200).length, 1, results.map((x) => x.status).join());
  assert.ok(results.filter((x) => x.status !== 200).every((x) => x.status === 410));
});

test('expired, unknown and revoked-block tokens are refused', async () => {
  await db.query(`UPDATE review_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash=$1`, [hashToken(ravi)]);
  assert.equal((await view(ravi)).status, 410);
  assert.equal((await decide(ravi, [{ statement_id: ravisStatement, status: 'allowed' }])).status, 410);
  assert.equal((await view('rv_' + 'x'.repeat(43))).status, 410);
  const conv2 = await H.mkTranscript(owner, ws, 'Second call', '[00:01] Zed Visitor: My salary is 12 lakh.');
  const l2 = (await owner.ok('GET', `/blocks/${conv2}/review-links`))[0].link.split('/review/')[1];
  await owner.ok('POST', `/blocks/${conv2}/revoke`, {});
  assert.equal((await view(l2)).status, 410, 'revoked conversation');
});

test('decisions are validated (unknown status rejected)', async () => {
  const conv3 = await H.mkTranscript(owner, ws, 'Third call', '[00:01] Yan Visitor: Our valuation is 40 crore.');
  const d3 = await owner.ok('GET', `/blocks/${conv3}`);
  const l3 = (await owner.ok('GET', `/blocks/${conv3}/review-links`))[0].link.split('/review/')[1];
  const r = await decide(l3, [{ statement_id: d3.statements[0].id, status: 'public' }]);
  assert.equal(r.status, 400);
  assert.equal((await view(l3)).status, 200, 'invalid request did not consume the token');
});
