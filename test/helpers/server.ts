/**
 * In-process API for HTTP-level tests: buildServer() listening on an ephemeral port (so the real MCP client SDK
 * can connect) plus app.inject for REST calls. Import only after setupEnv().
 */
import type { FastifyInstance } from 'fastify';

export interface Res { status: number; json: any; headers: Record<string, any>; text: string }
export interface Client {
  userId: string; email: string; cookie: string;
  req(method: string, path: string, body?: any, opts?: { csrf?: boolean; cookie?: boolean; headers?: Record<string, string> }): Promise<Res>;
  get(path: string): Promise<Res>;
  post(path: string, body?: any): Promise<Res>;
  /** Like post/get but asserts 2xx and returns the JSON. */
  ok(method: string, path: string, body?: any): Promise<any>;
}

export async function startServer() {
  await import('../../src/jobs/index.ts'); // registers job handlers so drain() can run ingestion etc.
  const { buildServer } = await import('../../src/api/server.ts');
  const app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as any;
  const url = `http://127.0.0.1:${addr.port}`;
  return { app, url, close: () => app.close() };
}

export async function inject(app: FastifyInstance, method: string, path: string, body?: any, headers: Record<string, string> = {}): Promise<Res> {
  const r = await app.inject({ method: method as any, url: path, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, payload: body !== undefined ? JSON.stringify(body) : undefined });
  let json: any = null; try { json = r.json(); } catch { /* not json */ }
  return { status: r.statusCode, json, headers: r.headers as any, text: r.body };
}

export async function login(app: FastifyInstance, email: string, name = email.split('@')[0]): Promise<Client> {
  const r = await inject(app, 'POST', '/auth/dev-login', { email, display_name: name });
  if (r.status !== 200) throw new Error(`dev-login failed ${r.status} ${r.text}`);
  const cookie = `emb_session=${r.json.session}`;
  const c: Client = {
    userId: r.json.user_id, email, cookie,
    req: (method, path, body, o = {}) => inject(app, method, path, body, {
      ...(o.cookie === false ? {} : { cookie }), ...(o.csrf === false ? {} : { 'x-embargo-csrf': '1' }), ...(o.headers ?? {}),
    }),
    get: (path) => c.req('GET', path),
    post: (path, body = {}) => c.req('POST', path, body),
    ok: async (method, path, body) => {
      const x = await c.req(method, path, body);
      if (x.status < 200 || x.status >= 300) throw new Error(`${method} ${path} → ${x.status} ${x.text.slice(0, 500)}`);
      return x.json;
    },
  };
  return c;
}

/** Runs queued jobs (ingestion, consent dispatch, records…) until the outbox is empty. */
export async function drain() {
  const { drain: d } = await import('../../src/jobs/queue.ts');
  await d();
}

export async function mkWorkspace(c: Client, name: string) {
  return (await c.ok('POST', '/workspaces', { name })).id as string;
}

/** Creates a text block, runs ingestion, and returns the block id. */
export async function mkTextBlock(c: Client, ws: string, title: string, text: string, extra: Record<string, any> = {}) {
  const r = await c.ok('POST', `/workspaces/${ws}/blocks`, { source: { type: 'text', text }, title, auto_publish: true, ...extra });
  await drain();
  return r.block_id as string;
}

export async function mkTranscript(c: Client, ws: string, title: string, text: string) {
  const r = await c.ok('POST', `/workspaces/${ws}/blocks`, { source: { type: 'transcript', text }, title });
  await drain();
  return r.block_id as string;
}

export async function mkConnection(c: Client, ws: string, scopes: string[] = [], label = 'Test tool') {
  return c.ok('POST', `/workspaces/${ws}/connections`, { tool_label: label, scopes }) as Promise<{ id: string; token: string; scopes: string[] }>;
}

export async function mcpClient(url: string, token: string) {
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new McpClient({ name: 'embargo-tests', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return {
    client,
    async call(name: string, args: any = {}) {
      const r: any = await client.callTool({ name, arguments: args });
      const text = r.content?.map((c: any) => c.text ?? '').join('\n') ?? '';
      let err: any = null; if (r.isError) { try { err = JSON.parse(text); } catch { err = { message: text }; } }
      return { isError: !!r.isError, text, s: r.structuredContent, err };
    },
    close: () => client.close(),
  };
}

/** Raw JSON-RPC POST to /mcp (no SDK), to observe HTTP status codes and headers. */
export async function rawMcp(url: string, token: string | null, body: any) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token !== null ? { authorization: `Bearer ${token}` } : {}) },
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* sse or empty */ }
  return { status: res.status, headers: res.headers, json, text };
}
