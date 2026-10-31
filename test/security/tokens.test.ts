/** Connection tokens (Part 19.2): scopes enforced per tool, revocation, bad/missing bearer → 401, membership required. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, teardown, rand } from '../helpers/env.ts';

setupEnv();
const H = await import('../helpers/server.ts');
const srv = await H.startServer();
after(async () => { await srv.close(); await teardown(); });

const owner = await H.login(srv.app, `owner-${rand()}@t.test`, 'Owner');
const viewer = await H.login(srv.app, `viewer-${rand()}@t.test`, 'Viewer');
const ws = await H.mkWorkspace(owner, 'Tokens');
await owner.ok('POST', `/workspaces/${ws}/members`, { email: viewer.email, role: 'viewer' });
const block = await H.mkTextBlock(owner, ws, 'Deploy guide', '# Deploy guide\n\nDeploys run from main via GitHub Actions.');
const readOnly = await H.mkConnection(owner, ws, [], 'Read only');
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

test('tokens are shown once, prefixed, stored hashed, and always include read', async () => {
  assert.match(readOnly.token, /^emb_[A-Za-z0-9_-]{40,}$/);
  assert.deepEqual(readOnly.scopes, ['read']);
  const list = await owner.ok('GET', `/workspaces/${ws}/connections`);
  assert.ok(!JSON.stringify(list).includes(readOnly.token), 'listing never shows the token again');
  const { getDb } = await import('../../src/db/index.ts');
  const { hashToken } = await import('../../src/util.ts');
  const row = (await (await getDb()).query('SELECT token_hash FROM connections WHERE id=$1', [readOnly.id]))[0];
  assert.equal(row.token_hash, hashToken(readOnly.token));
  assert.equal(row.token_hash.length, 64, 'SHA-256 hex');
});

test('a token without the needed scope is refused for every scoped tool', async () => {
  const m = await H.mcpClient(srv.url, readOnly.token);
  try {
    const cases: [string, any, string][] = [
      ['create_block', { title: 'x', content: 'y' }, 'write_blocks'], ['request_access', { target_id: block, reason: 'need it for the release' }, 'request_access'],
      ['ask_sealed', { question: 'What is the API rate limit?' }, 'ask_sealed'], ['perform_action', { action: 'post_message', target: '#x', payload: { text: 'hi' } }, 'perform_action'],
    ];
    for (const [tool, args, scope] of cases) {
      const r = await m.call(tool, args);
      assert.ok(r.isError, `${tool} should be refused`);
      assert.equal(r.err.error, 'forbidden_scope', `${tool}: ${r.text}`);
      assert.match(r.err.message, new RegExp(scope));
    }
    const ok = await m.call('get_context', { task: 'How do deploys work?' });
    assert.ok(!ok.isError && /GitHub Actions/.test(ok.text), 'read scope still works');
  } finally { await m.close(); }
});

test('local-MCP sealed-block upload requires write_blocks', async () => {
  const r = await H.inject(srv.app, 'POST', '/mcp-local/sealed-blocks', { ciphertext: 'c', wrapped_dek: 'w', nonce: 'n' }, { authorization: `Bearer ${readOnly.token}` });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden_scope');
});

test('missing, malformed and unknown bearer tokens get 401 with WWW-Authenticate', async () => {
  for (const tok of [null, '', 'garbage', 'emb_' + 'x'.repeat(43), `${readOnly.token}x`]) {
    const r = await H.rawMcp(srv.url, tok, INIT);
    assert.equal(r.status, 401, `token ${String(tok).slice(0, 12)}… → ${r.status}`);
    assert.match(String(r.headers.get('www-authenticate')), /Bearer/);
    assert.ok(r.json?.error, 'JSON-RPC error body');
  }
  const local = await H.inject(srv.app, 'GET', '/mcp-local/whoami', undefined, { authorization: 'Bearer nope' });
  assert.equal(local.status, 401);
  const basic = await H.rawMcp(srv.url, null, INIT);
  assert.equal(basic.status, 401);
});

test('revoked tokens are refused immediately (MCP and local-MCP endpoints)', async () => {
  const c = await H.mkConnection(owner, ws, ['write_blocks'], 'Soon revoked');
  assert.equal((await H.rawMcp(srv.url, c.token, INIT)).status, 200);
  await owner.ok('DELETE', `/connections/${c.id}`);
  assert.equal((await H.rawMcp(srv.url, c.token, INIT)).status, 401);
  assert.equal((await H.inject(srv.app, 'GET', '/mcp-local/whoami', undefined, { authorization: `Bearer ${c.token}` })).status, 401);
});

test('a token stops working when its owner leaves the workspace', async () => {
  const member = await H.login(srv.app, `member-${rand()}@t.test`, 'Member');
  await owner.ok('POST', `/workspaces/${ws}/members`, { email: member.email, role: 'editor' });
  const c = await H.mkConnection(member, ws, [], 'Member tool');
  assert.equal((await H.rawMcp(srv.url, c.token, INIT)).status, 200);
  await owner.ok('DELETE', `/workspaces/${ws}/members/${member.userId}`);
  assert.equal((await H.rawMcp(srv.url, c.token, INIT)).status, 401);
});

test('viewers can only create read (and ask_sealed) connections; users cannot revoke others’ tokens without admin', async () => {
  const bad = await viewer.post(`/workspaces/${ws}/connections`, { tool_label: 'x', scopes: ['write_blocks'] });
  assert.equal(bad.status, 403);
  const good = await viewer.post(`/workspaces/${ws}/connections`, { tool_label: 'x', scopes: ['ask_sealed'] });
  assert.equal(good.status, 200);
  const del = await viewer.req('DELETE', `/connections/${readOnly.id}`);
  assert.equal(del.status, 403, 'viewer cannot revoke the owner’s connection');
  const mine = await viewer.req('DELETE', `/connections/${good.json.id}`);
  assert.equal(mine.status, 200, 'but can revoke their own');
});

test('unknown scopes are rejected at creation', async () => {
  const r = await owner.post(`/workspaces/${ws}/connections`, { tool_label: 'x', scopes: ['admin'] });
  assert.equal(r.status, 400);
});
