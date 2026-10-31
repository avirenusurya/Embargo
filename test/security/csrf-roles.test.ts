/** CSRF protection on cookie-authenticated state-changing routes, session cookie flags, and role checks (Part 19.2). */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, teardown, rand } from '../helpers/env.ts';

setupEnv();
const H = await import('../helpers/server.ts');
const srv = await H.startServer();
after(async () => { await srv.close(); await teardown(); });

const owner = await H.login(srv.app, `owner-${rand()}@r.test`, 'Owner');
const admin = await H.login(srv.app, `admin-${rand()}@r.test`, 'Admin');
const editor = await H.login(srv.app, `editor-${rand()}@r.test`, 'Editor');
const viewer = await H.login(srv.app, `viewer-${rand()}@r.test`, 'Viewer');
const ws = await H.mkWorkspace(owner, 'Roles');
for (const [u, role] of [[admin, 'context_admin'], [editor, 'editor'], [viewer, 'viewer']] as const) await owner.ok('POST', `/workspaces/${ws}/members`, { email: u.email, role });
const block = await H.mkTextBlock(owner, ws, 'Owner doc', '# Owner doc\n\nOwner content for the roles test.');
const draft = (await owner.ok('POST', `/workspaces/${ws}/blocks`, { source: { type: 'text', text: 'Draft body text.' }, title: 'Draft' })).block_id as string;
await H.drain();
const conv = await H.mkTranscript(owner, ws, 'Call', `[00:01] Owner: Hi.\n[00:05] Guest Person: Our budget is 5 lakh.`);

test('session cookie is HttpOnly and SameSite', async () => {
  const r = await H.inject(srv.app, 'POST', '/auth/dev-login', { email: `c-${rand()}@r.test` });
  const sc = String(r.headers['set-cookie']);
  assert.match(sc, /emb_session=/);
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=(Lax|Strict)/i);
});

test('state-changing routes without the CSRF header are refused (403 csrf) and change nothing', async () => {
  const attempts: [string, string, any][] = [
    ['POST', '/workspaces', { name: 'csrf' }], ['PATCH', `/blocks/${block}`, { title: 'csrf' }], ['POST', `/blocks/${block}/rules`, { visibility: 'public' }],
    ['POST', `/blocks/${block}/access-mode`, { access_mode: 'agent_only' }], ['POST', `/blocks/${block}/revoke`, {}], ['POST', `/blocks/${block}/cards`, { recipient: { type: 'link' } }],
    ['POST', `/workspaces/${ws}/members`, { email: `x-${rand()}@r.test`, role: 'editor' }], ['POST', `/workspaces/${ws}/connections`, { tool_label: 'csrf', scopes: [] }],
    ['PATCH', '/me', { display_name: 'csrf' }], ['POST', `/workspaces/${ws}/blocks`, { source: { type: 'text', text: 'csrf' }, title: 'csrf' }],
  ];
  for (const [m, p, b] of attempts) {
    const r = await owner.req(m, p, b, { csrf: false });
    assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
    assert.equal(r.json?.error, 'csrf', `${m} ${p}`);
  }
  const d = await owner.ok('GET', `/blocks/${block}`);
  assert.equal(d.title, 'Owner doc');
  assert.equal(d.status, 'active');
  assert.equal(d.access_mode, 'viewable');
  assert.equal((await owner.ok('GET', '/me')).user.display_name, 'Owner');
});

test('a wrong CSRF header value is refused too; reads do not need it', async () => {
  const r = await owner.req('PATCH', `/blocks/${block}`, { title: 'x' }, { csrf: false, headers: { 'x-embargo-csrf': 'yes' } });
  assert.equal(r.status, 403);
  assert.equal((await owner.req('GET', `/workspaces/${ws}/blocks`, undefined, { csrf: false })).status, 200);
});

test('unauthenticated requests are 401', async () => {
  for (const [m, p] of [['GET', '/me'], ['GET', `/workspaces/${ws}/blocks`], ['POST', '/workspaces'], ['GET', `/blocks/${block}`]] as const) {
    const r = await H.inject(srv.app, m, p, m === 'POST' ? { name: 'x' } : undefined, { 'x-embargo-csrf': '1' });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test('viewers can read but cannot create, edit, publish, share, change rules or revoke', async () => {
  assert.equal((await viewer.get(`/blocks/${block}`)).status, 200);
  const attempts: [string, string, any][] = [
    ['POST', `/workspaces/${ws}/blocks`, { source: { type: 'text', text: 'v' }, title: 'v' }], ['PATCH', `/blocks/${block}`, { title: 'viewer' }],
    ['POST', `/blocks/${draft}/publish`, {}], ['POST', `/blocks/${block}/rules`, { visibility: 'private' }], ['POST', `/blocks/${block}/access-mode`, { access_mode: 'sealed_use' }],
    ['POST', `/blocks/${block}/revoke`, {}], ['POST', `/blocks/${block}/archive`, {}], ['POST', `/blocks/${block}/cards`, { recipient: { type: 'link' } }],
    ['POST', `/workspaces/${ws}/members`, { email: `y-${rand()}@r.test`, role: 'editor' }], ['GET', `/workspaces/${ws}/suggestions`, undefined],
    ['GET', `/blocks/${conv}/review-links`, undefined], ['POST', `/workspaces/${ws}/records/anchor`, {}],
  ];
  for (const [m, p, b] of attempts) {
    const r = await viewer.req(m, p, b);
    assert.equal(r.status, 403, `viewer ${m} ${p} → ${r.status} ${r.text.slice(0, 120)}`);
  }
  const d = await owner.ok('GET', `/blocks/${block}`);
  assert.equal(d.title, 'Owner doc');
  assert.equal(d.status, 'active');
  assert.equal((await owner.ok('GET', `/blocks/${draft}`)).status, 'draft');
});

test("editors cannot change rules on, share, or revoke someone else's block, nor open the inbox", async () => {
  for (const [m, p, b] of [['POST', `/blocks/${block}/rules`, { visibility: 'public' }], ['POST', `/blocks/${block}/access-mode`, { access_mode: 'viewable' }],
    ['POST', `/blocks/${block}/revoke`, {}], ['POST', `/blocks/${block}/cards`, { recipient: { type: 'link' } }], ['GET', `/workspaces/${ws}/suggestions`, undefined],
    ['GET', `/blocks/${conv}/review-links`, undefined], ['POST', `/workspaces/${ws}/members`, { email: `z-${rand()}@r.test`, role: 'viewer' }]] as const) {
    const r = await editor.req(m, p, b);
    assert.equal(r.status, 403, `editor ${m} ${p} → ${r.status}`);
  }
  const mine = await H.mkTextBlock(editor, ws, 'Editor doc', '# Editor doc\n\nEditor content.');
  assert.equal((await editor.post(`/blocks/${mine}/rules`, { visibility: 'team' })).status, 200, 'editors manage their own blocks');
});

test('context admins can manage any block and open the inbox, but only owners hold the owner role', async () => {
  assert.equal((await admin.post(`/blocks/${block}/rules`, { visibility: 'team' })).status, 200);
  assert.equal((await admin.get(`/workspaces/${ws}/suggestions`)).status, 200);
  const promote = await admin.req('PATCH', `/workspaces/${ws}/members/${viewer.userId}`, { role: 'owner' });
  assert.ok([400, 403].includes(promote.status), `admin cannot mint owners (${promote.status})`);
});

test("agent-written drafts can only be published by their owner", async () => {
  const c = await H.mkConnection(editor, ws, ['write_blocks'], 'Editor agent');
  const m = await H.mcpClient(srv.url, c.token);
  const cb = await m.call('create_block', { title: 'Agent notes', content: 'Deploys use blue/green.' });
  await m.close();
  await H.drain();
  const id = cb.s.block_id;
  assert.equal(cb.s.status, 'draft');
  assert.equal((await owner.post(`/blocks/${id}/publish`, {})).status, 403, 'even the workspace owner cannot publish another user’s agent draft');
  assert.equal((await editor.post(`/blocks/${id}/publish`, {})).status, 200);
});
