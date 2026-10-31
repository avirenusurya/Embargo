/**
 * Test environment. Call setupEnv() BEFORE importing anything from src/ (src/config.ts reads env and creates
 * DATA_DIR on import), then import src modules dynamically. Each test file runs in its own process
 * (node --test default isolation) and gets its own temp DATA_DIR with its own PGlite database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Settings that would make tests depend on the network or on the developer's .env.
const NEUTRAL: Record<string, string> = {
  NODE_ENV: 'test', AI_MODE: 'heuristic', LLM_API_KEY: '', OPENAI_API_KEY: '', DATABASE_URL: '', RPC_URL: '', EAS_SCHEMA_UID: '',
  TIGERGRAPH_HOST: '', TIGERGRAPH_TOKEN: '', WISPR_MCP_URL: '', OBJECT_STORAGE_ENDPOINT: '', KEY_PROVIDER: 'local', EMAIL_PROVIDER_API_KEY: '',
  GITHUB_WEBHOOK_SECRET: '', DODO_WEBHOOK_SECRET: '', VIASOCKET_DEFAULT_SECRET: '', EMBARGO_ROLE: 'all',
};

let dataDir: string | null = null;

export function setupEnv(extra: Record<string, string> = {}): string {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-test-'));
  Object.assign(process.env, NEUTRAL, { DATA_DIR: dataDir, PORT: '0', API_URL: 'http://localhost:8799' }, extra);
  return dataDir;
}

/** Closes the database (if it was opened) and deletes the temp DATA_DIR. */
export async function teardown(opts: { db?: boolean } = { db: true }) {
  if (opts.db !== false) {
    const { getDb } = await import('../../src/db/index.ts');
    await (await getDb()).close().catch(() => {});
  }
  if (dataDir && dataDir.startsWith(os.tmpdir())) fs.rmSync(dataDir, { recursive: true, force: true });
}

export const rand = () => Math.random().toString(36).slice(2, 10);
