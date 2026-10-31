/**
 * Wispr Notetaker import (Parts 11.5, 17.2). Embargo acts as an MCP client to Wispr's remote MCP server.
 * Auth uses the MCP authorization flow (OAuth 2.1 + PKCE + dynamic client registration) through the SDK.
 * Tool names are discovered at runtime via tools/list (never hard-coded).
 */
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { config } from '../config.ts';
import type { Queryable } from '../db/index.ts';
import { getIntegration, saveIntegration, setIntegrationStatus } from '../integrations/store.ts';
import { inApp } from '../integrations/viasocket.ts';
import { HttpError, log } from '../util.ts';

type Creds = { client?: any; tokens?: any; verifier?: string; state?: string; discovery?: any; tools?: { name: string; description?: string; inputSchema?: any }[] };

class WisprAuth implements OAuthClientProvider {
  authUrl: URL | null = null;
  constructor(private q: Queryable, private ws: string, public creds: Creds) {}
  private async persist(status = 'active') { await saveIntegration(this.q, this.ws, 'wispr', this.creds, { mcp_url: config.wispr.mcpUrl }, status); }
  get redirectUrl() { return config.wispr.redirect; }
  get clientMetadata() {
    return { client_name: 'Embargo', redirect_uris: [config.wispr.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } as any;
  }
  state() { this.creds.state = `${this.ws}.${crypto.randomBytes(16).toString('hex')}`; return this.creds.state; }
  clientInformation() { return this.creds.client ?? (config.wispr.clientId ? { client_id: config.wispr.clientId } : undefined); }
  async saveClientInformation(info: any) { this.creds.client = info; await this.persist('pending'); }
  tokens() { return this.creds.tokens; }
  async saveTokens(t: any) { this.creds.tokens = t; await this.persist('active'); }
  async redirectToAuthorization(url: URL) { this.authUrl = url; await this.persist('pending'); }
  async saveCodeVerifier(v: string) { this.creds.verifier = v; await this.persist('pending'); }
  codeVerifier() { if (!this.creds.verifier) throw new Error('missing PKCE verifier'); return this.creds.verifier; }
  async saveDiscoveryState(s: any) { this.creds.discovery = s; }
  discoveryState() { return this.creds.discovery; }
  async invalidateCredentials(scope: string) { if (scope === 'all' || scope === 'tokens') this.creds.tokens = undefined; if (scope === 'all' || scope === 'client') this.creds.client = undefined; await this.persist('needs_reconnect'); }
}

async function provider(q: Queryable, ws: string) {
  if (!config.wispr.mcpUrl) throw new HttpError(503, 'not_configured', 'WISPR_MCP_URL is not configured');
  const integ = await getIntegration(q, ws, 'wispr');
  return new WisprAuth(q, ws, (integ?.credentials as Creds) ?? {});
}

async function connectClient(q: Queryable, ws: string) {
  const auth = await provider(q, ws);
  const transport = new StreamableHTTPClientTransport(new URL(config.wispr.mcpUrl), { authProvider: auth });
  const client = new Client({ name: 'embargo', version: '1.0.0' });
  try { await client.connect(transport); } catch (e) {
    if (e instanceof UnauthorizedError || auth.authUrl) return { client: null, auth, transport };
    await setIntegrationStatus(q, ws, 'wispr', 'needs_reconnect');
    throw new HttpError(502, 'wispr_unavailable', `Wispr MCP connection failed: ${(e as Error).message}`);
  }
  return { client, auth, transport };
}

/** Start connect. Returns an authorization URL when the user must sign in to Wispr, else discovers tools. */
export async function connectWispr(q: Queryable, ws: string): Promise<{ authorize_url?: string; tools?: string[] }> {
  const { client, auth } = await connectClient(q, ws);
  if (!client) return { authorize_url: auth.authUrl?.toString() };
  const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  auth.creds.tools = tools;
  await saveIntegration(q, ws, 'wispr', auth.creds, { mcp_url: config.wispr.mcpUrl, tools: tools.map((t) => t.name) }, 'active');
  await client.close();
  return { tools: tools.map((t) => t.name) };
}

export async function finishWisprAuth(q: Queryable, state: string, code: string) {
  const ws = state.split('.')[0];
  const auth = await provider(q, ws);
  if (!auth.creds.state || auth.creds.state !== state) throw new HttpError(400, 'bad_state');
  const transport = new StreamableHTTPClientTransport(new URL(config.wispr.mcpUrl), { authProvider: auth });
  await transport.finishAuth(code);
  return { workspace_id: ws, ...(await connectWispr(q, ws)) };
}

function pickTool(tools: Creds['tools'], ...patterns: RegExp[]) {
  for (const p of patterns) { const t = tools?.find((x) => p.test(x.name) || p.test(x.description ?? '')); if (t) return t; }
  return null;
}
function idArg(tool: any, id: string) {
  const props = Object.keys(tool?.inputSchema?.properties ?? {});
  const k = props.find((p) => /meeting.?id/i.test(p)) ?? props.find((p) => /^id$/i.test(p)) ?? props.find((p) => /id/i.test(p)) ?? 'meeting_id';
  return { [k]: id };
}
function parseResult(r: any): any {
  if (r.structuredContent) return r.structuredContent;
  const texts = (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text);
  const joined = texts.join('\n');
  try { return JSON.parse(joined); } catch { return joined; }
}
const findArray = (o: any): any[] => (Array.isArray(o) ? o : o && typeof o === 'object' ? (Object.values(o).find(Array.isArray) as any[]) ?? [] : []);

async function withClient<T>(q: Queryable, ws: string, fn: (c: Client, tools: Creds['tools']) => Promise<T>) {
  const { client, auth } = await connectClient(q, ws);
  if (!client) {
    // Part 20: expired Wispr auth → integration needs_reconnect + notify the workspace's admins once.
    const prev = (await q.query(`SELECT status FROM integrations WHERE workspace_id=$1 AND provider='wispr'`, [ws]))[0]?.status;
    await setIntegrationStatus(q, ws, 'wispr', 'needs_reconnect');
    if (prev !== 'needs_reconnect') for (const a of await q.query(`SELECT user_id FROM memberships WHERE workspace_id=$1 AND role IN ('owner','context_admin')`, [ws]))
      await inApp(q, ws, a.user_id, 'integration', 'Wispr Notetaker sign-in expired. Reconnect Wispr to keep importing meetings.', '/app#integrations');
    throw new HttpError(401, 'needs_reconnect', 'Wispr sign-in expired. Reconnect Wispr.');
  }
  try {
    const tools = auth.creds.tools?.length ? auth.creds.tools : (await client.listTools()).tools as any;
    return await fn(client, tools);
  } finally { await client.close().catch(() => {}); }
}

export async function listMeetings(q: Queryable, ws: string) {
  return withClient(q, ws, async (c, tools) => {
    const t = pickTool(tools, /list.*meeting|meetings?_?list|search.*meeting/i, /meeting/i);
    if (!t) throw new HttpError(502, 'wispr_tools', 'No meeting list tool found on Wispr MCP');
    const props = t.inputSchema?.properties ?? {};
    const args: any = {}; if (props.limit) args.limit = 25; if (props.query && (t.inputSchema?.required ?? []).includes('query')) args.query = '';
    const items = findArray(parseResult(await c.callTool({ name: t.name, arguments: args })));
    return items.map((m: any) => ({
      id: String(m.id ?? m.meeting_id ?? m.uuid), title: m.title ?? m.name ?? 'Meeting', date: m.date ?? m.start_time ?? m.started_at ?? m.created_at ?? null,
      attendees: (m.attendees ?? m.participants ?? []).map((a: any) => (typeof a === 'string' ? a : a.name ?? a.email)),
      has_transcript: m.has_transcript ?? m.transcript_available ?? true,
    }));
  });
}

export type Turn = { speaker: string; email?: string | null; text: string; start_ms: number | null };
export async function fetchMeeting(q: Queryable, ws: string, meetingId: string): Promise<{ title: string; date: string | null; attendees: { name: string; email?: string }[]; turns: Turn[]; rawText?: string }> {
  return withClient(q, ws, async (c, tools) => {
    const dt = pickTool(tools, /get.*meeting|meeting.*detail|meeting_?summary/i);
    const tt = pickTool(tools, /transcript/i);
    if (!tt) throw new HttpError(502, 'wispr_tools', 'No transcript tool found on Wispr MCP');
    const detail = dt ? parseResult(await c.callTool({ name: dt.name, arguments: idArg(dt, meetingId) })) : {};
    const tr = parseResult(await c.callTool({ name: tt.name, arguments: idArg(tt, meetingId) }));
    const d = typeof detail === 'object' ? (detail.meeting ?? detail) : {};
    const attendees = (d.attendees ?? d.participants ?? []).map((a: any) => (typeof a === 'string' ? { name: a } : { name: a.name ?? a.email, email: a.email }));
    const segs = typeof tr === 'string' ? [] : findArray(tr.transcript ?? tr.segments ?? tr.utterances ?? tr);
    const turns: Turn[] = segs.map((s: any) => ({
      speaker: s.speaker ?? s.speaker_name ?? s.name ?? 'Unknown', email: s.speaker_email ?? s.email ?? null, text: String(s.text ?? s.content ?? ''),
      start_ms: s.start_ms ?? (s.start != null ? Math.round(Number(s.start) * 1000) : s.timestamp != null ? Math.round(Number(s.timestamp) * 1000) : null),
    })).filter((t: Turn) => t.text.trim());
    log('info', 'wispr.import', { ws, turns: turns.length });
    return { title: d.title ?? d.name ?? 'Meeting', date: d.date ?? d.start_time ?? null, attendees, turns, rawText: typeof tr === 'string' ? tr : (tr.text ?? undefined) };
  });
}
