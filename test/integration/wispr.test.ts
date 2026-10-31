/**
 * Wispr Notetaker import (Parts 11.5, 17.2) against a mock remote MCP server built with the MCP SDK.
 * The mock implements the MCP authorization flow (protected-resource + authorization-server metadata, dynamic
 * client registration, PKCE token exchange) so the real connect → OAuth callback → tools/list → import path runs.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { setupEnv, teardown, rand } from '../helpers/env.ts';

// ---------- mock Wispr MCP server ----------
const MEETINGS = [
  { id: 'm-100', title: 'Pricing sync', date: '2026-10-20T10:00:00Z', attendees: [{ name: 'Priya', email: 'priya@acme.test' }, { name: 'Meera Guest', email: 'meera@client.test' }], has_transcript: true },
  { id: 'm-200', title: 'Retro', date: '2026-10-21T10:00:00Z', attendees: ['Rohan'], has_transcript: true },
];
const TRANSCRIPTS: Record<string, any[]> = {
  'm-100': [
    { speaker: 'Priya', speaker_email: 'priya@acme.test', text: 'The launch price is ₹599/month now.', start: 1.5 },
    { speaker: 'Meera Guest', speaker_email: 'meera@client.test', text: 'Our budget for this deal is 5 lakh.', start: 20 },
    { speaker: 'Rohan', text: 'I will write the deploy checklist this week.', start: 41.25 },
    { speaker: 'Priya', text: '   ', start: 50 },
  ],
};
const calls: { tool: string; args: any }[] = [];
let issued = new Set<string>(['seeded-token']);
let codeChallenge = '';

function mcpServer() {
  const s = new McpServer({ name: 'wispr-mock', version: '1.0.0' });
  s.registerTool('list_meetings', { description: 'List recent Notetaker meetings', inputSchema: { limit: z.number().optional(), query: z.string().optional() } }, async (args) => {
    calls.push({ tool: 'list_meetings', args });
    return { content: [{ type: 'text', text: JSON.stringify({ meetings: MEETINGS.slice(0, args.limit ?? 25) }) }] };
  });
  s.registerTool('get_meeting', { description: 'Get meeting details', inputSchema: { meeting_id: z.string() } }, async (args) => {
    calls.push({ tool: 'get_meeting', args });
    const m = MEETINGS.find((x) => x.id === args.meeting_id);
    return m ? { content: [{ type: 'text', text: JSON.stringify({ meeting: m }) }] } : { isError: true, content: [{ type: 'text', text: 'not found' }] };
  });
  s.registerTool('get_transcript', { description: 'Get the transcript of a meeting', inputSchema: { meeting_id: z.string() } }, async (args) => {
    calls.push({ tool: 'get_transcript', args });
    return { content: [{ type: 'text', text: JSON.stringify({ transcript: TRANSCRIPTS[args.meeting_id] ?? [] }) }] };
  });
  return s;
}

const readBody = (req: http.IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const mock = http.createServer(async (req, res) => {
  const base = `http://127.0.0.1:${(mock.address() as any).port}`;
  const url = new URL(req.url!, base);
  const json = (code: number, body: any, h: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(body)); };
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
  if (url.pathname === '/.well-known/oauth-authorization-server')
    return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  if (url.pathname === '/register' && req.method === 'POST') return json(201, { ...JSON.parse(await readBody(req)), client_id: 'mock-client-id', client_id_issued_at: Math.floor(Date.now() / 1000) });
  if (url.pathname === '/token' && req.method === 'POST') {
    const p = new URLSearchParams(await readBody(req));
    const verifier = p.get('code_verifier') ?? '';
    const ok = p.get('code') === 'good-code' && crypto.createHash('sha256').update(verifier).digest('base64url') === codeChallenge;
    if (!ok) return json(400, { error: 'invalid_grant' });
    const t = `tok-${rand()}`; issued.add(t);
    return json(200, { access_token: t, token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
  }
  if (url.pathname === '/mcp') {
    const auth = String(req.headers.authorization ?? '');
    if (!issued.has(auth.replace(/^Bearer\s+/i, ''))) return json(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
    const server = mcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    return transport.handleRequest(req, res, body);
  }
  json(404, { error: 'not_found' });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${(mock.address() as any).port}`;

// ---------- Embargo under test, pointed at the mock ----------
setupEnv({ WISPR_MCP_URL: `${MOCK}/mcp` });
const H = await import('../helpers/server.ts');
const { getDb } = await import('../../src/db/index.ts');
const { saveIntegration, getIntegration } = await import('../../src/integrations/store.ts');
const srv = await H.startServer();
after(async () => { mock.close(); await srv.close(); await teardown(); });
const db = await getDb();

const priya = await H.login(srv.app, `priya-${rand()}@acme.test`, 'Priya');
const ws = await H.mkWorkspace(priya, 'Acme');

test('connect without credentials starts the MCP authorization flow (PKCE + dynamic client registration)', async () => {
  const r = await priya.ok('POST', `/workspaces/${ws}/integrations/wispr/connect`, {});
  assert.ok(r.authorize_url, JSON.stringify(r));
  const u = new URL(r.authorize_url);
  assert.equal(u.origin + u.pathname, `${MOCK}/authorize`);
  assert.equal(u.searchParams.get('client_id'), 'mock-client-id');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(u.searchParams.get('state')?.startsWith(`${ws}.`), 'state binds the workspace');
  codeChallenge = u.searchParams.get('code_challenge')!;
  const integ = await getIntegration(db, ws, 'wispr');
  assert.equal(integ?.status, 'pending');
  assert.ok(integ?.credentials?.verifier, 'PKCE verifier stored (encrypted)');
  const raw = (await db.query(`SELECT credentials_ct FROM integrations WHERE workspace_id=$1 AND provider='wispr'`, [ws]))[0];
  assert.ok(!Buffer.from(raw.credentials_ct).toString('utf8').includes(integ!.credentials.verifier), 'credentials encrypted at rest');

  // A forged state is rejected.
  const bad = await priya.req('GET', `/integrations/wispr/callback?code=good-code&state=${ws}.forged`);
  assert.equal(bad.status, 400);

  // Browser comes back from Wispr with the code → token exchange → tools discovered.
  const cb = await priya.req('GET', `/integrations/wispr/callback?code=good-code&state=${encodeURIComponent(u.searchParams.get('state')!)}`);
  assert.equal(cb.status, 302, cb.text);
  assert.match(String(cb.headers.location), /wispr=connected/);
  const after = await getIntegration(db, ws, 'wispr');
  assert.equal(after?.status, 'active');
  assert.ok(after?.credentials?.tokens?.access_token?.startsWith('tok-'));
  assert.deepEqual([...after!.meta.tools].sort(), ['get_meeting', 'get_transcript', 'list_meetings'], 'tool names discovered via tools/list');
});

test('lists meetings through the discovered list tool', async () => {
  const list = await priya.ok('GET', `/workspaces/${ws}/integrations/wispr/meetings`);
  assert.deepEqual(list.map((m: any) => m.id), ['m-100', 'm-200']);
  assert.deepEqual(list[0].attendees, ['Priya', 'Meera Guest']);
  assert.equal(list[1].attendees[0], 'Rohan');
  assert.equal(calls.find((c) => c.tool === 'list_meetings')?.args.limit, 25);
});

test('importing a meeting creates a conversation block with speakers, statements and consent holds', async () => {
  const r = await priya.ok('POST', `/workspaces/${ws}/integrations/wispr/import`, { meeting_id: 'm-100' });
  await H.drain();
  assert.ok(calls.some((c) => c.tool === 'get_meeting' && c.args.meeting_id === 'm-100'));
  assert.ok(calls.some((c) => c.tool === 'get_transcript' && c.args.meeting_id === 'm-100'));
  const b = await priya.ok('GET', `/blocks/${r.block_id}`);
  assert.equal(b.processing_state, 'ready', b.processing_error);
  assert.equal(b.kind, 'conversation');
  assert.equal(b.title, 'Pricing sync', 'title from the meeting detail');
  assert.deepEqual(b.source_ref, { type: 'wispr', meeting_id: 'm-100' });
  assert.equal(b.sections.length, 0, 'conversations carry no derived summary sections');
  const st = b.statements;
  assert.deepEqual(st.map((s: any) => s.speaker_label), ['Priya', 'Meera Guest', 'Rohan'], 'blank turns dropped, order kept');
  const by = (n: string) => st.find((s: any) => s.speaker_label === n);
  assert.equal(by('Meera Guest').status, 'held', 'outsider deal talk is held for consent');
  assert.equal(by('Rohan').status, 'allowed');
  assert.match(by('Rohan').text ?? '', /deploy checklist/);
  const persons = await priya.ok('GET', `/workspaces/${ws}/persons`);
  const meera = persons.find((p: any) => p.display_name === 'Meera Guest');
  assert.equal(meera?.is_external, true);
  assert.equal(meera?.contact_channel, 'email', 'attendee email stored (encrypted) for the review link');
  const me = persons.find((p: any) => p.display_name === 'Priya');
  assert.equal(by('Priya').speaker_person_id, me.id, 'member speaker mapped to the member person');
  const links = await priya.ok('GET', `/blocks/${r.block_id}/review-links`);
  assert.ok(links.some((l: any) => l.person === 'Meera Guest'), 'consent flow started for the held speaker');
});

test('turn timestamps and speakers from Wispr are kept on statements', async () => {
  const r = await priya.ok('POST', `/workspaces/${ws}/integrations/wispr/import`, { meeting_id: 'm-100', title: 'Again' });
  await H.drain();
  const b = await priya.ok('GET', `/blocks/${r.block_id}`);
  assert.equal(b.processing_state, 'ready', b.processing_error);
  assert.deepEqual(b.statements.map((s: any) => s.started_at_ms), [1500, 20000, 41250]);
  assert.deepEqual(b.statements.map((s: any) => s.speaker_label), ['Priya', 'Meera Guest', 'Rohan']);
  assert.deepEqual(b.statements.map((s: any) => s.text), ['The launch price is ₹599/month now.', 'Our budget for this deal is 5 lakh.', 'I will write the deploy checklist this week.'],
    'turn text is not re-parsed as "speaker: text"');
});

test('expired Wispr credentials mark the integration needs_reconnect and fail the import cleanly', async () => {
  issued = new Set(); // the mock forgets every token
  const r = await priya.ok('POST', `/workspaces/${ws}/integrations/wispr/import`, { meeting_id: 'm-100', title: 'Expired' });
  await H.drain();
  const b = await priya.ok('GET', `/blocks/${r.block_id}`);
  assert.equal(b.processing_state, 'failed');
  assert.ok(b.statements.length === 0);
  const integ = await getIntegration(db, ws, 'wispr');
  assert.ok(['needs_reconnect', 'pending'].includes(integ!.status), integ!.status);
});

test('a pre-provisioned token (e.g. after reconnect) works without the browser flow', async () => {
  const ws2 = await H.mkWorkspace(priya, 'Second');
  issued = new Set(['seeded-token']);
  await saveIntegration(db, ws2, 'wispr', { tokens: { access_token: 'seeded-token', token_type: 'Bearer' } }, { mcp_url: `${MOCK}/mcp` });
  const r = await priya.ok('POST', `/workspaces/${ws2}/integrations/wispr/connect`, {});
  assert.deepEqual([...r.tools].sort(), ['get_meeting', 'get_transcript', 'list_meetings']);
  const imp = await priya.ok('POST', `/workspaces/${ws2}/integrations/wispr/import`, { meeting_id: 'm-100' });
  await H.drain();
  const b = await priya.ok('GET', `/blocks/${imp.block_id}`);
  assert.equal(b.statements.length, 3);
});

test('editors only: viewers cannot connect or import', async () => {
  const v = await H.login(srv.app, `viewer-${rand()}@acme.test`, 'Viewer');
  await priya.ok('POST', `/workspaces/${ws}/members`, { email: v.email, role: 'viewer' });
  assert.equal((await v.post(`/workspaces/${ws}/integrations/wispr/connect`, {})).status, 403);
  assert.equal((await v.post(`/workspaces/${ws}/integrations/wispr/import`, { meeting_id: 'm-100' })).status, 403);
});
