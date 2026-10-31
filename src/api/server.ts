import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getDb } from '../db/index.ts';
import { config } from '../config.ts';
import { HttpError, log } from '../util.ts';
import { buildMcpServer } from '../mcp/server.ts';
import { authenticateConnection, callTool, chargeMcpRequest, RATE_LIMITED_RPC_CODE } from '../mcp/gateway.ts';
import authRoutes from './routes/auth.ts';
import workspaceRoutes from './routes/workspaces.ts';
import blockRoutes from './routes/blocks.ts';
import sharingRoutes from './routes/sharing.ts';
import activityRoutes from './routes/activity.ts';
import integrationRoutes from './routes/integrations.ts';
import mcpLocalRoutes from './routes/mcpLocal.ts';
import opsRoutes from './routes/ops.ts';
import { chainEnabled, relayer } from '../chain/eas.ts';
import { relayerStatus } from '../chain/records.ts';
import { llmEnabled } from '../ai/llm.ts';
import * as tg from '../integrations/tigergraph.ts';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });

  // Keep the raw body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    (req as any).rawBody = body;
    if (!body.length) return done(null, {});
    try { done(null, JSON.parse(body.toString('utf8'))); } catch { done(new HttpError(400, 'invalid_json', 'Body is not valid JSON'), undefined); }
  });
  await app.register(cookie);
  await app.register(fstatic, { root: WEB_DIR, prefix: '/static/', index: false });
  // Motion libraries (GSAP, Lenis) are served straight from node_modules so the web UI needs no build step.
  await app.register(fstatic, { root: path.join(ROOT_DIR, 'node_modules', 'gsap', 'dist'), prefix: '/vendor/gsap/', index: false, decorateReply: false, maxAge: '1d' });
  await app.register(fstatic, { root: path.join(ROOT_DIR, 'node_modules', 'lenis', 'dist'), prefix: '/vendor/lenis/', index: false, decorateReply: false, maxAge: '1d' });
  // Rendered promo video (optional; 404 until `npm run promo` has been run).
  await app.register(fstatic, { root: path.join(ROOT_DIR, 'promo', 'out'), prefix: '/media/', index: false, decorateReply: false });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      if (err.code === 'rate_limited' && err.extra?.retry_after) reply.header('retry-after', String(err.extra.retry_after));
      return reply.code(err.status).send({ error: err.code, message: err.message, ...(err.extra ?? {}) });
    }
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: 'invalid_request', message: err.message });
    if (err.statusCode === 413) return reply.code(413).send({ error: 'too_large', message: err.message });
    log('error', 'http.error', { url: req.url, method: req.method, err: String(err.stack ?? err).slice(0, 1500) });
    return reply.code(500).send({ error: 'internal', message: 'Internal error' });
  });
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/static/')) return;
    log('info', 'http', { method: req.method, url: req.url.split('?')[0].replace(/\/(review|c|auth\/magic-link|invites|cards\/accept)\/[^/]+/, '/$1/:token'), status: reply.statusCode, ms: Math.round(reply.elapsedTime) });
  });

  // ----- Remote MCP (Streamable HTTP, stateless) -----
  await app.register(opsRoutes); // global hooks (MCP auth gate, request metrics) + /metrics, /admin/analytics
  const mcpHandler = async (req: any, reply: any) => {
    const auth = String(req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    let requester;
    try { requester = await authenticateConnection(await getDb(), token); } catch (e: any) {
      return reply.code(401).header('www-authenticate', 'Bearer').send({ jsonrpc: '2.0', error: { code: -32001, message: e.message ?? 'unauthorized' }, id: null });
    }
    if (req.method !== 'POST') return reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
    // Rate limits (15.5 `rate_limited`: "Retry after header provided"): over-limit tool calls get HTTP 429 + Retry-After
    // before the MCP transport runs. Charged calls skip the in-tool check, which still covers in-process callers.
    const charge = await chargeMcpRequest(await getDb(), requester, req.body);
    if (!charge.ok) {
      return reply.code(429).header('retry-after', String(charge.retryAfter)).send({
        jsonrpc: '2.0', id: charge.id, error: { code: RATE_LIMITED_RPC_CODE, message: `Rate limited. Retry after ${charge.retryAfter}s`, data: { error: 'rate_limited', retry_after: charge.retryAfter } },
      });
    }
    let prepaid = charge.charged;
    const server = buildMcpServer((name, args) => callTool(requester, name, args, { ratePrechecked: prepaid-- > 0 }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post('/mcp', mcpHandler);
  app.get('/mcp', mcpHandler);
  app.delete('/mcp', mcpHandler);

  await app.register(authRoutes);
  await app.register(workspaceRoutes);
  await app.register(blockRoutes);
  await app.register(sharingRoutes);
  await app.register(activityRoutes);
  await app.register(integrationRoutes);
  await app.register(mcpLocalRoutes);

  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async (req, reply) => {
    try {
      const db = await getDb();
      await db.query('SELECT 1');
      // Relayer pause (Part 20 "relayer out of gas") is reported, not treated as unready: off-chain signing continues.
      const rs = await relayerStatus(db).catch(() => null);
      return {
        ok: true, db: db.kind, llm: llmEnabled() ? 'llm' : 'heuristic', chain: chainEnabled() ? `chain ${config.chain.chainId}` : 'off-chain only', relayer: relayer.address, tigergraph: tg.enabled(),
        relayer_status: rs ? { paused: rs.paused, reason: rs.reason, paused_at: rs.paused_at } : { paused: null, reason: 'status_unavailable', paused_at: null },
      };
    } catch { return reply.code(503).send({ ok: false }); }
  });
  app.get('/', async (req, reply) => reply.sendFile('landing.html'));
  app.get('/app', async (req, reply) => reply.sendFile('index.html'));
  return app;
}
