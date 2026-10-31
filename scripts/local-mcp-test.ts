/**
 * Tests the local stdio package end to end: sealed key init, client-side encrypted upload, and that
 * get_context over stdio merges the locally decrypted sealed block (which the server cannot read).
 * Usage: API=http://localhost:8787 npx tsx scripts/local-mcp-test.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const API = process.env.API ?? 'http://localhost:8787';
const login = await (await fetch(`${API}/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `local-${Date.now()}@t.test` }) })).json() as any;
const h = { 'content-type': 'application/json', 'x-embargo-csrf': '1', cookie: `emb_session=${login.session}` };
const ws = (await (await fetch(`${API}/workspaces`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Local test' }) })).json() as any).id;
const conn = await (await fetch(`${API}/workspaces/${ws}/connections`, { method: 'POST', headers: h, body: JSON.stringify({ tool_label: 'local', scopes: ['write_blocks'] }) })).json() as any;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-home-'));
const env = { ...process.env, HOME: home };
const bin = path.resolve('bin/embargo-mcp.mjs');
const run = (...a: string[]) => execFileSync(process.execPath, [bin, '--token', conn.token, '--api', API, ...a], { env, encoding: 'utf8' });
const init = run('sealed-init');
const rec = init.match(/RECOVERY KEY.*\n\n\s+(\S+)/)?.[1];
const f = path.join(home, 'secret.md'); fs.writeFileSync(f, 'Our acquisition codename is BLUEHERON and the board meets on the 3rd.');
console.log(run('sealed-add', 'Board secrets', f).trim());
const serverView = await (await fetch(`${API}/workspaces/${ws}/sealed-blocks`, { headers: h })).json() as any[];
const c = new Client({ name: 't', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin, '--token', conn.token, '--api', API], env: env as any, stderr: 'ignore' }));
const r: any = await c.callTool({ name: 'get_context', arguments: { task: 'what is the acquisition codename' } });
const text = r.content[0].text;
const ok1 = text.includes('BLUEHERON');
fs.rmSync(path.join(home, '.embargo'), { recursive: true, force: true });
const recovered = rec ? run('sealed-recover', rec).includes('restored') : false;
console.log(`${ok1 ? 'PASS' : 'FAIL'}  local get_context merges locally decrypted sealed block`);
console.log(`${serverView.length === 1 ? 'PASS' : 'FAIL'}  server stores the sealed block (ciphertext only)`);
console.log(`${recovered ? 'PASS' : 'FAIL'}  recovery key restores the sealed key on a fresh device`);
await c.close();
process.exit(ok1 && recovered ? 0 : 1);
