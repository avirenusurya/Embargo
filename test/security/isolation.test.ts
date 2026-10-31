/** Cross-workspace isolation: a user or token from workspace B cannot read or change anything in workspace A. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, teardown, rand } from '../helpers/env.ts';
import type { Res } from '../helpers/server.ts';

setupEnv();
const H = await import('../helpers/server.ts');
const srv = await H.startServer();
after(async () => { await srv.close(); await teardown(); });

const SECRET = `ZEBRA-${rand()}-SECRET`;
const TITLE = `Alpha roadmap ${rand()}`;
const alice = await H.login(srv.app, `alice-${rand()}@a.test`, 'Alice');
const bob = await H.login(srv.app, `bob-${rand()}@b.test`, 'Bob');
const wsA = await H.mkWorkspace(alice, 'Alpha');
const wsB = await H.mkWorkspace(bob, 'Bravo');
const blockA = await H.mkTextBlock(alice, wsA, TITLE, `# ${TITLE}\n\nThe launch codename is ${SECRET}.\nPricing is 499 per month.`);
const convA = await H.mkTranscript(alice, wsA, 'Client call', `[00:01] Alice: Hello everyone.\n[00:10] Meera Guest: Our budget for this deal is 5 lakh, mail meera@client.test`);
const connA = await H.mkConnection(alice, wsA, ['ask_sealed'], 'Alice tool');
const connB = await H.mkConnection(bob, wsB, ['write_blocks', 'request_access', 'ask_sealed', 'perform_action'], 'Bob tool');
const cardA = await alice.ok('POST', `/blocks/${blockA}/cards`, { recipient: { type: 'link' } });
const recordsA = await alice.ok('GET', `/workspaces/${wsA}/records`);
const recordA = recordsA[0].id as string;
const personA = (await alice.ok('GET', `/workspaces/${wsA}/persons`)).find((p: any) => p.display_name === 'Meera Guest').id as string;
const mA = await H.mcpClient(srv.url, connA.token);
const ctxA = await mA.call('get_context', { task: 'What is the launch codename?' });
await mA.close();

const denied = (r: Res, what: string) => {
  assert.ok([401, 403, 404].includes(r.status), `${what}: expected 403/404, got ${r.status} ${r.text.slice(0, 200)}`);
  assert.ok(!r.text.includes(SECRET) && !r.text.includes(TITLE), `${what}: response leaks workspace A data`);
};

test('sanity: alice can read her own data', async () => {
  assert.match(ctxA.text, new RegExp(SECRET));
  assert.equal((await alice.get(`/blocks/${blockA}`)).status, 200);
  assert.ok(recordsA.length >= 1);
});

test('bob cannot read workspace A blocks, versions, members, persons, connections or integrations', async () => {
  for (const p of [`/workspaces/${wsA}`, `/workspaces/${wsA}/blocks`, `/blocks/${blockA}`, `/blocks/${blockA}/versions`, `/blocks/${convA}`, `/workspaces/${wsA}/members`,
    `/workspaces/${wsA}/persons`, `/workspaces/${wsA}/connections`, `/workspaces/${wsA}/integrations`, `/workspaces/${wsA}/collections`, `/workspaces/${wsA}/tags`, `/workspaces/${wsA}/cards`])
    denied(await bob.get(p), `GET ${p}`);
});

test('bob cannot read workspace A records, proof bundles, activity, inbox or access requests', async () => {
  for (const p of [`/workspaces/${wsA}/records`, `/records/${recordA}`, `/records/${recordA}/typed-data`, `/workspaces/${wsA}/activity`, `/workspaces/${wsA}/suggestions`, `/workspaces/${wsA}/access-requests`])
    denied(await bob.get(p), `GET ${p}`);
  denied(await bob.post(`/activity/${ctxA.s.compile_id}/feedback`, { helpful: false }), 'feedback on A compile');
  denied(await bob.post(`/workspaces/${wsA}/records/anchor`, {}), 'anchor A');
  denied(await bob.post(`/records/${recordA}/countersign`, { address: '0x' + '1'.repeat(40), signature: '0x' + 'ab'.repeat(65) }), 'countersign A record');
});

test('bob cannot get review links, exposure or why-withheld for workspace A', async () => {
  denied(await bob.get(`/blocks/${convA}/review-links`), 'review links');
  denied(await bob.get(`/persons/${personA}/exposure`), 'exposure');
  denied(await bob.get(`/blocks/${blockA}/why-withheld?connection_id=${connB.id}`), 'why-withheld');
});

test('bob cannot modify workspace A', async () => {
  const attempts: [string, string, any][] = [
    ['PATCH', `/blocks/${blockA}`, { title: 'pwned' }], ['POST', `/blocks/${blockA}/rules`, { visibility: 'public' }], ['POST', `/blocks/${blockA}/access-mode`, { access_mode: 'viewable' }],
    ['POST', `/blocks/${blockA}/revoke`, {}], ['POST', `/blocks/${blockA}/archive`, {}], ['POST', `/blocks/${blockA}/cards`, { recipient: { type: 'workspace', workspace_id: wsB } }],
    ['POST', `/workspaces/${wsA}/blocks`, { source: { type: 'text', text: 'x' }, title: 'x' }], ['POST', `/workspaces/${wsA}/members`, { email: bob.email, role: 'context_admin' }],
    ['POST', `/workspaces/${wsA}/connections`, { tool_label: 'x', scopes: [] }], ['DELETE', `/connections/${connA.id}`, undefined], ['DELETE', `/cards/${cardA.card_id}`, undefined],
    ['PATCH', `/workspaces/${wsA}`, { name: 'pwned' }], ['POST', `/workspaces/${wsA}/persons`, { display_name: 'x' }],
  ];
  for (const [m, p, b] of attempts) denied(await bob.req(m, p, b), `${m} ${p}`);
  const still = await alice.ok('GET', `/blocks/${blockA}`);
  assert.equal(still.title, TITLE);
  assert.equal(still.status, 'active');
  assert.equal((await alice.ok('GET', `/workspaces/${wsA}/members`)).length, 1);
  assert.ok((await alice.ok('GET', `/workspaces/${wsA}/connections`)).find((c: any) => c.id === connA.id).revoked_at === null);
});

test("bob's MCP token sees nothing from workspace A", async () => {
  const m = await H.mcpClient(srv.url, connB.token);
  try {
    const ctx = await m.call('get_context', { task: 'What is the launch codename and pricing?' });
    assert.ok(!ctx.text.includes(SECRET));
    assert.equal(ctx.s.items.length, 0);
    const lb = await m.call('list_blocks', {});
    assert.ok(!lb.s.blocks.some((b: any) => b.block_id === blockA || b.block_id === convA));
    const rb = await m.call('read_block', { block_id: blockA });
    assert.ok(!rb.text.includes(SECRET) && !rb.text.includes(TITLE), rb.text);
    assert.ok(rb.isError || rb.s?.withheld === true, rb.text);
    assert.ok(!rb.s?.sections?.length, 'no sections served');
    const missing = '01a00000-0000-7000-8000-000000000000';
    const rm = await m.call('read_block', { block_id: missing });
    assert.equal(rb.text.replace(blockA, 'X'), rm.text.replace(missing, 'X'), 'another workspace’s block looks exactly like a missing one (no existence oracle)');
    const ra = await m.call('request_access', { target_id: blockA, reason: 'please' });
    assert.ok(ra.isError, 'cannot even request access to another workspace’s block');
    const rep = await m.call('report_context_use', { compile_id: ctxA.s.compile_id, used_ids: [], ignored_ids: [] });
    assert.ok(rep.isError, 'cannot report on another workspace’s compile');
    const sealed = await m.call('ask_sealed', { question: 'What is the launch codename?' });
    assert.ok(!JSON.stringify(sealed).includes(SECRET));
    const res = await m.client.readResource({ uri: `embargo://block/${blockA}` }).catch((e: any) => ({ error: String(e.message) }));
    assert.ok(!JSON.stringify(res).includes(SECRET), 'resource read');
  } finally { await m.close(); }
});

test("bob's token cannot use workspace A local-MCP endpoints", async () => {
  const r = await H.inject(srv.app, 'GET', '/mcp-local/sealed-blocks', undefined, { authorization: `Bearer ${connB.token}` });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(blockA));
  const w = await H.inject(srv.app, 'GET', '/mcp-local/whoami', undefined, { authorization: `Bearer ${connB.token}` });
  assert.equal(w.json.workspace_id, wsB);
});

test('public verification of an A record reveals no content, titles or identifiers', async () => {
  const r = await H.inject(srv.app, 'GET', `/verify/${recordA}`, undefined, { accept: 'application/json' });
  assert.equal(r.status, 200);
  for (const s of [SECRET, TITLE, wsA, blockA, alice.email]) assert.ok(!r.text.includes(s), `verify leaks ${s}`);
});
