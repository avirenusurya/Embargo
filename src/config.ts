import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Minimal .env loader (no dependency). Existing process.env values win.
function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

const env = (k: string, d = '') => process.env[k] ?? d;
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);

export const DATA_DIR = path.resolve(env('DATA_DIR', './data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// Dev convenience: generate persistent local secrets once so the system runs with zero config.
// In production these MUST be provided via the host's secret manager.
function devSecret(name: string, bytes = 32): string {
  if (process.env[name]) return process.env[name]!;
  if (env('NODE_ENV') === 'production') throw new Error(`Missing required secret ${name}`);
  const file = path.join(DATA_DIR, '.dev-secrets.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!all[name]) {
    all[name] = name === 'RELAYER_PRIVATE_KEY'
      ? '0x' + crypto.randomBytes(32).toString('hex')
      : crypto.randomBytes(bytes).toString('base64');
    fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
  return all[name];
}

const port = num('PORT', 8787);
const apiUrl = env('API_URL', `http://localhost:${port}`);

export const config = {
  env: env('NODE_ENV', 'development'),
  role: env('EMBARGO_ROLE', 'all') as 'all' | 'api' | 'worker',
  port,
  host: env('HOST', '0.0.0.0'),
  apiUrl,
  appUrl: env('APP_URL', apiUrl),
  databaseUrl: env('DATABASE_URL'), // empty => embedded PGlite in DATA_DIR/pg
  sessionSecret: devSecret('SESSION_SECRET'),
  webauthn: {
    rpId: env('WEBAUTHN_RP_ID', new URL(apiUrl).hostname),
    rpName: env('WEBAUTHN_RP_NAME', 'Embargo'),
    origin: env('WEBAUTHN_ORIGIN', env('APP_URL', apiUrl)),
  },
  email: { apiKey: env('EMAIL_PROVIDER_API_KEY'), from: env('EMAIL_FROM', 'Embargo <noreply@embargo.local>') },
  objectStorage: {
    endpoint: env('OBJECT_STORAGE_ENDPOINT'),
    bucket: env('OBJECT_STORAGE_BUCKET'),
    key: env('OBJECT_STORAGE_KEY'),
    secret: env('OBJECT_STORAGE_SECRET'),
    region: env('OBJECT_STORAGE_REGION', 'auto'),
  },
  keys: {
    provider: env('KEY_PROVIDER', 'local') as 'local' | 'kms',
    localMasterKey: devSecret('LOCAL_MASTER_KEY'),
    kmsKeyId: env('KMS_KEY_ID'),
    kmsRegion: env('KMS_REGION'),
    recordHmacGlobalKey: devSecret('RECORD_HMAC_GLOBAL_KEY'),
  },
  ai: {
    apiKey: env('LLM_API_KEY', env('OPENAI_API_KEY')),
    baseUrl: env('LLM_BASE_URL', 'https://api.openai.com/v1'),
    models: {
      compress: env('MODEL_COMPRESS', 'gpt-4.1-mini'),
      classify: env('MODEL_CLASSIFY', 'gpt-4.1-mini'),
      judge: env('MODEL_JUDGE', 'gpt-4.1-mini'),
      sealed: env('MODEL_SEALED', 'gpt-4.1-mini'),
      embed: env('MODEL_EMBED', 'text-embedding-3-small'),
      transcribe: env('TRANSCRIBE_MODEL', 'whisper-1'),
    },
    embedDim: num('EMBED_DIM', 1536),
    // 'auto' uses the LLM when a key is configured, otherwise deterministic local heuristics.
    mode: env('AI_MODE', 'auto') as 'auto' | 'llm' | 'heuristic',
  },
  wispr: {
    mcpUrl: env('WISPR_MCP_URL'),
    clientId: env('WISPR_OAUTH_CLIENT_ID'),
    redirect: env('WISPR_OAUTH_REDIRECT', `${apiUrl}/integrations/wispr/callback`),
  },
  github: {
    appId: env('GITHUB_APP_ID'),
    appPrivateKey: env('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
    webhookSecret: env('GITHUB_WEBHOOK_SECRET'),
  },
  viasocket: { defaultSecret: env('VIASOCKET_DEFAULT_SECRET') },
  tigergraph: {
    host: env('TIGERGRAPH_HOST'),
    graph: env('TIGERGRAPH_GRAPH', 'Embargo'),
    token: env('TIGERGRAPH_TOKEN'),
    latencyBudgetMs: num('TIGERGRAPH_LATENCY_BUDGET_MS', 300),
  },
  dodo: {
    apiKey: env('DODO_API_KEY'),
    webhookSecret: env('DODO_WEBHOOK_SECRET'),
    productTeam: env('DODO_PRODUCT_TEAM'),
    baseUrl: env('DODO_BASE_URL', 'https://test.dodopayments.com'),
  },
  chain: {
    chainId: num('CHAIN_ID', 84532),
    rpcUrl: env('RPC_URL'),
    easAddress: env('EAS_CONTRACT_ADDRESS', '0x4200000000000000000000000000000000000021'),
    schemaRegistryAddress: env('EAS_SCHEMA_REGISTRY_ADDRESS', '0x4200000000000000000000000000000000000020'),
    schemaUid: env('EAS_SCHEMA_UID'),
    easVersion: env('EAS_VERSION', '1.0.1'),
    relayerPrivateKey: devSecret('RELAYER_PRIVATE_KEY') as `0x${string}`,
    batchIntervalSeconds: num('BATCH_INTERVAL_SECONDS', 600),
    batchSize: num('BATCH_SIZE', 500),
  },
  limits: {
    mcpPerMin: num('RATE_LIMIT_MCP_PER_MIN', 120),
    sealedPerMin: num('RATE_LIMIT_SEALED_PER_MIN', 20),
    uploadBytes: num('UPLOAD_LIMIT_BYTES', 20 * 1024 * 1024),
    accessLogRetentionDays: num('ACCESS_LOG_RETENTION_DAYS', 180),
  },
  // Anomaly alerts (Part 19.3): unusual token volume per connection, new IP range for a connection.
  anomaly: {
    tokensPerHour: num('ANOMALY_TOKENS_PER_HOUR', 200_000), // absolute floor before an hour counts as unusual
    volumeFactor: num('ANOMALY_VOLUME_FACTOR', 5), // ... and it must exceed this multiple of the 7-day hourly average
  },
  ops: {
    metricsToken: env('METRICS_TOKEN'), // if set, GET /metrics requires Authorization: Bearer <token>
    adminToken: env('ADMIN_TOKEN'), // enables GET /admin/analytics (404 when unset)
  },
  transcribe: {
    ffmpeg: env('FFMPEG_PATH', 'ffmpeg'),
    chunkSeconds: num('WHISPER_CHUNK_SECONDS', 600),
    maxBytes: num('WHISPER_MAX_BYTES', 24 * 1024 * 1024), // OpenAI transcription file limit is 25 MB (Part 26 #9)
  },
  contextManager: { autoApplyThreshold: num('AUTO_APPLY_THRESHOLD', 0.85), reminderAfterHours: num('INBOX_REMINDER_HOURS', 72) },
  // Compiler weights (Part 9.3), tunable via the eval harness.
  compiler: {
    wSim: num('W_SIM', 0.55), wPin: num('W_PIN', 0.15), wRecency: num('W_RECENCY', 0.1), wPrior: num('W_PRIOR', 0.2),
    wStale: num('W_STALE', 0.1), wConflict: num('W_CONFLICT', 0.05),
    dedupe: num('COMPILER_DEDUPE', 0.92), clusterJoin: num('CLUSTER_JOIN', 0.8), topK: num('COMPILER_TOPK', 50),
    // Relevance gate: unpinned candidates below max(minSim, relSim × best unpinned similarity) are not packed.
    minSim: num('COMPILER_MIN_SIM', 0.05), relSim: num('COMPILER_REL_SIM', 0.5),
  },
  plans: {
    free: { members: 5, blocks: 100, connections: 10, monthlyImports: 20, sealedCalls: 200 },
    team: { members: 30, blocks: 5000, connections: 200, monthlyImports: 1000, sealedCalls: 20000 },
  } as Record<string, { members: number; blocks: number; connections: number; monthlyImports: number; sealedCalls: number }>,
};

export const isDev = config.env !== 'production';
