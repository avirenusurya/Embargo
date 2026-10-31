/**
 * Seeds a demo workspace through the API (server must be running; dev login must be enabled).
 * Usage: API=http://localhost:8787 npm run seed
 */
const API = (process.env.API ?? 'http://localhost:8787').replace(/\/$/, '');
async function login(email: string, name: string) {
  const j: any = await (await fetch(`${API}/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, display_name: name }) })).json();
  const h = { 'content-type': 'application/json', 'x-embargo-csrf': '1', cookie: `emb_session=${j.session}` };
  return async (p: string, body?: any) => { const r = await fetch(`${API}${p}`, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }); const o: any = await r.json(); if (!r.ok) throw new Error(`${p}: ${JSON.stringify(o)}`); return o; };
}
const api = await login('founder@demo.embargo', 'Asha Rao');
await login('priya@demo.embargo', 'Priya Nair');
await login('rohan@demo.embargo', 'Rohan Mehta');
// Idempotent: if the demo workspace already exists, only mint a fresh MCP token for it.
const existing = ((await api('/workspaces')) as any[]).find((w: any) => w.name === 'Acme Notes (demo)');
if (existing && !process.env.SEED_FORCE) {
  const conn = await api(`/workspaces/${existing.id}/connections`, { tool_label: 'Claude Code (demo)', scopes: ['write_blocks', 'request_access', 'ask_sealed', 'perform_action'] });
  console.log(`Demo workspace already exists: ${existing.id}\nSign in (dev login) as founder@demo.embargo, priya@demo.embargo (context_admin) or rohan@demo.embargo\n\nMCP token: ${conn.token}\n${conn.setup.claude_code_cli}`);
  process.exit(0);
}
const ws = (await api('/workspaces', { name: 'Acme Notes (demo)' })).id;
await api(`/workspaces/${ws}/members`, { email: 'priya@demo.embargo', role: 'context_admin' });
await api(`/workspaces/${ws}/members`, { email: 'rohan@demo.embargo', role: 'editor' });
const blocks: [string, string, any][] = [
  ['Product summary', '# Acme Notes\n\nAcme Notes is a shared notebook for small teams that every AI tool can read.\n\n## Who it is for\nStartups with 2 to 30 people.\n\n## Brand rules\nBrand color is indigo. Tone is plain and friendly.', { pinned: true }],
  ['Pricing decision', '# Pricing decision\n\nWe decided on a single Pro plan.\nLaunch price is ₹499/month.\nAnnual plan gets 2 months free.', {}],
  ['Launch plan', '# Launch plan\n\nLaunch date is 15 Nov.\nWe will announce on X and LinkedIn.\nThe launch campaign runs for one week.', {}],
  ['Tech stack', '# Tech stack\n\n## Backend\nTypeScript, Fastify, Postgres with pgvector.\n\n## Deploys\nDeploys run from main via GitHub Actions. Run migrations before rollout.', {}],
  ['Security internals', '# Security internals\n\nAPI rate limit is 100 requests per minute per key.\nAdmin panel lives behind the VPN.\nIncident contact rotates weekly.', { access_mode: 'sealed_use' }],
];
for (const [title, text, extra] of blocks) await api(`/workspaces/${ws}/blocks`, { source: { type: 'text', text }, title, auto_publish: true, ...extra });
await api(`/workspaces/${ws}/blocks`, { title: 'Tuesday standup', source: { type: 'transcript', text: '[00:01] Priya Nair: Quick update, the launch price is ₹599/month now.\n[00:20] Rohan Mehta: We moved launch to 20 Nov.\n[00:40] Meera Guest: Our budget for this deal is 5 lakh, you can reach me at meera@client.test.\n[01:05] Rohan Mehta: I will write the deploy checklist this week.' } });
const conn = await api(`/workspaces/${ws}/connections`, { tool_label: 'Claude Code (demo)', scopes: ['write_blocks', 'request_access', 'ask_sealed', 'perform_action'] });
console.log(`Seeded workspace ${ws}\nSign in (dev login) as founder@demo.embargo, priya@demo.embargo (context_admin) or rohan@demo.embargo\n\nMCP token: ${conn.token}\n${conn.setup.claude_code_cli}`);
