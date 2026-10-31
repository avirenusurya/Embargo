/** Rate limits (19.3 sealed-use extraction, token theft), SSRF on URL import, webhook signature verification. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupEnv, teardown, rand } from '../helpers/env.ts';

const DODO_RAW = 'dodo-test-secret';
setupEnv({ RATE_LIMIT_MCP_PER_MIN: '5', RATE_LIMIT_SEALED_PER_MIN: '2', GITHUB_WEBHOOK_SECRET: 'gh-test-secret', DODO_WEBHOOK_SECRET: 'whsec_' + Buffer.from(DODO_RAW).toString('base64') });
const H = await import('../helpers/server.ts');
const { safeFetch, isPrivateAddress, normaliseIp } = await import('../../src/ingest/extract.ts');
const srv = await H.startServer();
const internal = http.createServer((_q, r) => r.end('INTERNAL-ONLY')); // stands in for a metadata service / intranet host
await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
const IPORT = (internal.address() as any).port;
after(async () => { internal.close(); await srv.close(); await teardown(); });

const owner = await H.login(srv.app, `owner-${rand()}@x.test`, 'Owner');
const ws = await H.mkWorkspace(owner, 'Abuse');
await H.mkTextBlock(owner, ws, 'Security internals', '# Security internals\n\nAPI rate limit is 100 requests per minute per key.', { access_mode: 'sealed_use' });

// ---------- rate limits ----------
// Remote /mcp answers over-limit tool calls with HTTP 429 + Retry-After (15.5); the SDK client surfaces that as a
// StreamableHTTPError carrying the status and the JSON-RPC error body.
const rateLimited = async (p: Promise<unknown>) => {
  const e: any = await p.then(() => null, (x) => x);
  assert.ok(e, 'call refused');
  assert.equal(e.code, 429, String(e.message));
  const body = JSON.parse(String(e.message).slice(String(e.message).indexOf('{')));
  assert.equal(body.error.data.error, 'rate_limited');
  assert.ok(Number(body.error.data.retry_after) >= 1, `retry_after ${body.error.data.retry_after}`);
  return body;
};

test('MCP tool calls are rate limited per connection with a retry_after hint', async () => {
  const c = await H.mkConnection(owner, ws, [], 'Busy tool');
  const other = await H.mkConnection(owner, ws, [], 'Quiet tool');
  const m = await H.mcpClient(srv.url, c.token);
  const m2 = await H.mcpClient(srv.url, other.token);
  try {
    for (let i = 0; i < 5; i++) assert.ok(!(await m.call('list_blocks', {})).isError, `call ${i + 1} allowed`);
    await rateLimited(m.call('list_blocks', {}));
    assert.ok(!(await m2.call('list_blocks', {})).isError, 'other connections are unaffected');
  } finally { await m.close(); await m2.close(); }
});

test('ask_sealed has its own, lower limit', async () => {
  const c = await H.mkConnection(owner, ws, ['ask_sealed'], 'Prober');
  const m = await H.mcpClient(srv.url, c.token);
  try {
    for (let i = 0; i < 2; i++) assert.ok(!(await m.call('ask_sealed', { question: "What's the API rate limit?" })).isError);
    await rateLimited(m.call('ask_sealed', { question: "What's the API rate limit?" }));
    assert.ok(!(await m.call('list_blocks', {})).isError, 'other tools still work under the general limit');
  } finally { await m.close(); }
});

test('rate-limited MCP requests answer HTTP 429 with a Retry-After header', async () => {
  const c = await H.mkConnection(owner, ws, [], 'Raw');
  const call = (id: number) => H.rawMcp(srv.url, c.token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_blocks', arguments: {} } });
  for (let i = 0; i < 5; i++) assert.equal((await call(i + 1)).status, 200, `call ${i + 1} allowed`);
  const r = await call(99);
  assert.equal(r.status, 429);
  const retry = Number(r.headers.get('retry-after'));
  assert.ok(retry >= 1 && retry <= 60, `retry-after ${retry}`);
  assert.equal(r.json?.jsonrpc, '2.0');
  assert.equal(r.json?.id, 99, 'error answers the request id');
  assert.equal(r.json?.error?.data?.error, 'rate_limited');
  assert.equal(r.json?.error?.data?.retry_after, retry, 'body and header agree');
  // Only tool-running messages are charged: discovery keeps working while tool calls are limited.
  const list = await H.rawMcp(srv.url, c.token, { jsonrpc: '2.0', id: 100, method: 'tools/list' });
  assert.equal(list.status, 200, list.text);
});

test('local stdio keeps the in-tool rate_limited result (the remote 429 is translated)', async () => {
  const c = await H.mkConnection(owner, ws, [], 'Local stdio');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-home-'));
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const bin = fileURLToPath(new URL('../../bin/embargo-mcp.mjs', import.meta.url));
  const client = new Client({ name: 'stdio-rate-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, '--token', c.token, '--api', srv.url], env: { ...process.env, HOME: home } as any, stderr: 'ignore' }));
  try {
    for (let i = 0; i < 5; i++) assert.ok(!((await client.callTool({ name: 'list_blocks', arguments: {} })) as any).isError, `call ${i + 1} allowed`);
    const r: any = await client.callTool({ name: 'list_blocks', arguments: {} });
    assert.ok(r.isError, 'call 6 refused in-band');
    const err = JSON.parse(r.content[0].text);
    assert.equal(err.error, 'rate_limited');
    assert.ok(Number(err.retry_after) >= 1, `retry_after ${err.retry_after}`);
  } finally { await client.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

// ---------- SSRF ----------
const blocked = async (u: string) => {
  await assert.rejects(safeFetch(u, { timeoutMs: 3000 }), (e: any) => ['blocked_url', 'bad_url'].includes(e.code), u);
};
test('URL import refuses loopback, private, link-local, metadata and non-http targets', async () => {
  for (const u of [`http://127.0.0.1:${IPORT}/`, `http://localhost:${IPORT}/`, `http://127.1:${IPORT}/`, `http://0x7f000001:${IPORT}/`, `http://2130706433:${IPORT}/`,
    'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/', 'http://0.0.0.0/',
    `http://[::1]:${IPORT}/`, 'http://[fd00::1]/', 'http://[fe80::1]/', 'file:///etc/passwd', 'gopher://127.0.0.1/', 'ftp://example.com/']) await blocked(u);
});

// Regression (src/ingest/extract.ts isPrivate): WHATWG URL normalises "[::ffff:127.0.0.1]" to "[::ffff:7f00:1]", and Node skips the
// lookup hook for IP literals, so embedded-IPv4 forms must be normalised and checked before connecting.
test('URL import refuses IPv4-mapped IPv6 loopback literals', async () => {
  for (const u of [`http://[::ffff:127.0.0.1]:${IPORT}/`, `http://[::ffff:7f00:1]:${IPORT}/`, `http://[0:0:0:0:0:ffff:127.0.0.1]:${IPORT}/`, 'http://[::ffff:169.254.169.254]/']) await blocked(u);
});

test('URL import refuses other IPv4-embedding and reserved IPv6 literals', async () => {
  for (const u of [`http://[::127.0.0.1]:${IPORT}/`, `http://[::ffff:0:127.0.0.1]:${IPORT}/`, 'http://[::ffff:a9fe:a9fe]/', `http://[64:ff9b::7f00:1]:${IPORT}/`,
    `http://[2002:7f00:1::]:${IPORT}/`, 'http://[::]/', 'http://[fec0::1]/', 'http://[ff02::1]/', 'http://[2001:db8::1]/', 'http://198.18.0.1/', 'http://224.0.0.1/']) await blocked(u);
});

test('address classification: public addresses stay allowed, every private form is blocked', () => {
  for (const a of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPrivateAddress(a), false, a);
  for (const a of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '255.255.255.255', '::1', '::', 'fe80::1%eth0',
    'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', '2002:0808:0808::1', 'not-an-ip']) assert.equal(isPrivateAddress(a), true, a);
  assert.deepEqual(normaliseIp('0:0:0:0:0:ffff:127.0.0.1'), { address: '127.0.0.1', family: 'ipv4' });
  assert.deepEqual(normaliseIp('::ffff:a9fe:a9fe'), { address: '169.254.169.254', family: 'ipv4' });
});

test('a URL block pointing at an internal address fails ingestion without storing the response', async () => {
  const r = await owner.ok('POST', `/workspaces/${ws}/blocks`, { source: { type: 'url', url: `http://127.0.0.1:${IPORT}/` }, title: 'internal' });
  await H.drain();
  const d = await owner.ok('GET', `/blocks/${r.block_id}`);
  assert.equal(d.processing_state, 'failed');
  assert.match(String(d.processing_error), /private/i);
  assert.ok(!JSON.stringify(d).includes('INTERNAL-ONLY'));
});

// ---------- webhooks ----------
test('GitHub webhook requires a valid X-Hub-Signature-256', async () => {
  const body = JSON.stringify({ zen: 'hi' });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'gh-test-secret').update(body).digest('hex');
  const send = (s?: string) => srv.app.inject({ method: 'POST', url: '/webhooks/github', payload: body, headers: { 'content-type': 'application/json', 'x-github-event': 'ping', ...(s ? { 'x-hub-signature-256': s } : {}) } });
  assert.equal((await send()).statusCode, 401);
  assert.equal((await send('sha256=' + '0'.repeat(64))).statusCode, 401);
  assert.equal((await send(sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a'))).statusCode, 401);
  assert.equal((await send(sig)).statusCode, 200);
});

test('Dodo webhook: standard-webhooks signature, 5-minute timestamp window, idempotent by webhook-id', async () => {
  const body = JSON.stringify({ type: 'payment.succeeded', data: { metadata: {} } });
  const sign = (id: string, ts: number, b = body) => 'v1,' + crypto.createHmac('sha256', Buffer.from(DODO_RAW)).update(`${id}.${ts}.${b}`).digest('base64');
  const send = (h: Record<string, string>, b = body) => srv.app.inject({ method: 'POST', url: '/webhooks/dodo', payload: b, headers: { 'content-type': 'application/json', ...h } });
  const now = Math.floor(Date.now() / 1000);
  const id = `msg_${rand()}`;
  assert.equal((await send({})).statusCode, 401, 'no headers');
  assert.equal((await send({ 'webhook-id': id, 'webhook-timestamp': String(now), 'webhook-signature': 'v1,AAAA' })).statusCode, 401, 'bad signature');
  assert.equal((await send({ 'webhook-id': id, 'webhook-timestamp': String(now - 600), 'webhook-signature': sign(id, now - 600) })).statusCode, 401, 'stale timestamp');
  assert.equal((await send({ 'webhook-id': id, 'webhook-timestamp': String(now), 'webhook-signature': sign(id, now, '{}') })).statusCode, 401, 'signature for a different body');
  const ok = await send({ 'webhook-id': id, 'webhook-timestamp': String(now), 'webhook-signature': `v1,old ${sign(id, now)}` });
  assert.equal(ok.statusCode, 200, ok.body);
  const again = await send({ 'webhook-id': id, 'webhook-timestamp': String(now), 'webhook-signature': sign(id, now) });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().duplicate, true, 'replayed webhook ignored');
});
