import { config } from './config.ts';
import { getDb } from './db/index.ts';
import './jobs/index.ts';
import { startDispatcher, stopDispatcher } from './jobs/queue.ts';
import { startScheduler, stopScheduler } from './jobs/schedules.ts';
import { buildServer } from './api/server.ts';
import { log } from './util.ts';
import { llmEnabled } from './ai/llm.ts';
import { chainEnabled, relayer } from './chain/eas.ts';

const db = await getDb();
const role = config.role;
let app: Awaited<ReturnType<typeof buildServer>> | null = null;

if (role === 'all' || role === 'api') {
  app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
}
if (role === 'all' || role === 'worker') {
  await startDispatcher();
  startScheduler();
}
log('info', 'embargo.started', {
  role, url: config.apiUrl, db: db.kind, ai: llmEnabled() ? 'llm' : 'heuristic (set LLM_API_KEY for model-quality output)',
  chain: chainEnabled() ? `EAS on chain ${config.chain.chainId}` : 'records signed off-chain (set RPC_URL + EAS_SCHEMA_UID to anchor)', relayer: relayer.address,
});

const shutdown = async () => {
  stopScheduler(); stopDispatcher();
  await app?.close().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
