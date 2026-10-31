/**
 * Evaluation harness (Part 21). Reproducible: `npm run eval` (full) · `npm run eval -- --quick`.
 *
 * Suites
 *   policy     200k randomized policy cases (20k with --quick) + boundary pass; 0 violations is a hard invariant
 *   unit       pre-existing regression checks (answer-check unit cases, heuristic sensitivity, fact keys)
 *   retrieval  labelled tasks through get_context: P@k / R@k / MRR, forbidden-content check, token savings,
 *              budget adherence, compile latency            (aliases: tokens, latency)
 *   sealed     ask_sealed answer check: leak rate, false refusals, accuracy, probing guard, latency
 *   actions    perform_action action check: confusion matrix, block rate, false positives, latency
 *   detection  statement hold decisions and contradiction suggestions vs labels
 *
 * Flags: --quick · --only a,b · --rounds N (latency repeats; default 3, quick 1) · --policy-cases N · --keep
 *        (keep the temp data dir) · --data-dir DIR · --out DIR (default src/eval/out) · --verbose (server logs)
 *
 * The world (users, workspaces, 50 blocks, rules, cards, reviews, connections) is built in-process in an isolated
 * DATA_DIR through the REST API (Fastify inject), the MCP gateway and the job queue. Works in heuristic AI mode
 * (no key) and with LLM_API_KEY set. Exit 1 if a hard invariant fails, 2 if the harness itself fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { RunData } from './report.ts';

// ---------------- args ----------------
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (i < 0) return undefined; return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1]; };
const quick = flag('quick');
const ALIASES: Record<string, string[]> = { tokens: ['retrieval'], latency: ['retrieval', 'sealed', 'actions'], answer: ['sealed'], action: ['actions'] };
const ALL = ['policy', 'unit', 'retrieval', 'sealed', 'actions', 'detection'];
const only = opt('only');
const suites = only ? [...new Set(only.split(',').map((s) => s.trim()).flatMap((s) => ALIASES[s] ?? [s]))] : ALL;
const unknown = suites.filter((s) => !ALL.includes(s));
if (unknown.length) { console.error(`Unknown suite(s): ${unknown.join(', ')}. Valid: ${ALL.join(', ')}, aliases: ${Object.keys(ALIASES).join(', ')}`); process.exit(2); }
const rounds = Math.max(1, Number(opt('rounds') ?? (quick ? 1 : 3)));
const policyCases = Number(opt('policy-cases') ?? (quick ? 20_000 : 200_000));
const verbose = flag('verbose');
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(opt('out') ?? path.join(here, 'out'));

// ---------------- isolated environment (must be set before any src module loads config) ----------------
const autoDir = !opt('data-dir');
const dataDir = path.resolve(opt('data-dir') ?? path.join(os.tmpdir(), `emb-eval-${Date.now()}-${process.pid}`));
const repoData = path.resolve(here, '..', '..', 'data');
if (dataDir === repoData || dataDir.startsWith(repoData + path.sep)) { console.error('Refusing to run the eval inside the project data directory.'); process.exit(2); }
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL; // always embedded PGlite in the isolated dir
process.env.RATE_LIMIT_MCP_PER_MIN = '1000000';
process.env.RATE_LIMIT_SEALED_PER_MIN = '1000000';
process.env.DODO_WEBHOOK_SECRET ??= `whsec_${crypto.randomBytes(24).toString('base64')}`;
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'development'; // dev-login is needed to create eval users

// Server modules log structured JSON lines; keep them out of the report output unless --verbose.
const out = console.log.bind(console);
const logs = { warn: 0, error: 0, samples: [] as string[] };
const intercept = (orig: (...a: any[]) => void) => (...a: any[]) => {
  if (typeof a[0] === 'string' && a[0].startsWith('{"t":')) {
    const lvl = /"level":"(\w+)"/.exec(a[0])?.[1];
    if (lvl === 'warn' || lvl === 'error') { logs[lvl]++; if (logs.samples.length < 30) logs.samples.push(a[0].slice(0, 300)); }
    if (verbose) orig(...a);
    return;
  }
  orig(...a);
};
console.log = intercept(console.log.bind(console));
console.error = intercept(console.error.bind(console));

// ---------------- run ----------------
const t0 = Date.now();
const phaseMs: Record<string, number> = {};
const phase = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => { const s = Date.now(); out(`▶ ${name}`); try { return await fn(); } finally { phaseMs[name] = Date.now() - s; } };
const data: RunData = {
  meta: { startedAt: new Date().toISOString(), mode: quick ? 'quick' : 'full', suites, phaseMs, aiMode: 'heuristic', dataDir, node: process.version, rounds, policyCases },
  logs,
};
let crashed: unknown = null;
let world: Awaited<ReturnType<typeof import('./world.ts').buildWorld>> | null = null;
try {
  const { llmEnabled } = await import('../ai/llm.ts');
  data.meta.aiMode = llmEnabled() ? 'llm' : 'heuristic';
  out(`Embargo eval · ${data.meta.mode} · suites ${suites.join(',')} · AI ${data.meta.aiMode} · data ${dataDir}`);
  if (suites.includes('policy')) { const { runPolicySuite } = await import('./policy.ts'); data.policy = await phase('policy', () => runPolicySuite(policyCases)); }
  if (suites.includes('unit')) { const { runUnitChecks } = await import('./unit.ts'); data.unit = await phase('unit', () => runUnitChecks()); }
  const needWorld = ['retrieval', 'sealed', 'actions', 'detection'].some((s) => suites.includes(s));
  if (needWorld) {
    const W = await import('./world.ts');
    const lint = W.lintFixtures();
    data.setup = { warnings: [], lint };
    if (lint.length) throw new Error(`fixture lint failed:\n  ${lint.join('\n  ')}`);
    world = await phase('setup', () => W.buildWorld((s) => out(s)));
    data.setup.warnings = world.warnings; data.setup.setupMs = world.setupMs;
    for (const w of world.warnings) out(`  ! ${w}`);
    if (suites.includes('detection')) { const { runDetection } = await import('./detection.ts'); data.detection = await phase('detection', () => runDetection(world!)); }
    if (suites.includes('retrieval')) { const { runRetrieval } = await import('./retrieval.ts'); data.retrieval = await phase('retrieval', () => runRetrieval(world!, { rounds, log: out })); }
    if (suites.includes('sealed')) { const { runSealed } = await import('./sealedEval.ts'); data.sealed = await phase('sealed', () => runSealed(world!, { rounds, log: out })); }
    if (suites.includes('actions')) { const { runActions } = await import('./actionsEval.ts'); data.actions = await phase('actions', () => runActions(world!, { rounds, log: out })); }
  }
} catch (e: any) {
  crashed = e;
  if (data.setup && !data.setup.error) data.setup.error = String(e?.message ?? e);
  out(`\nHARNESS ERROR: ${e?.stack ?? e}`);
} finally {
  await world?.close().catch(() => {});
}

data.meta.finishedAt = new Date().toISOString();
data.meta.durationMs = Date.now() - t0;
const { rows, consoleTable, hardFailures, writeReports } = await import('./report.ts');
const rs = rows(data);
out('\n' + consoleTable(rs));
writeReports(outDir, data, rs);
const hard = hardFailures(rs);
out(`\nReports: ${path.join(outDir, 'report.json')} · ${path.join(outDir, 'REPORT.md')}`);
out(`Done in ${(data.meta.durationMs / 1000).toFixed(1)}s (${Object.entries(phaseMs).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(', ')}). Server logs: ${logs.warn} warn, ${logs.error} error.`);
out(crashed ? 'Harness failed (exit 2).' : hard.length ? `${hard.length} hard invariant(s) FAILED: ${hard.map((r) => r.metric).join('; ')}` : 'All hard invariants passed.');

if (autoDir && !flag('keep') && path.basename(dataDir).startsWith('emb-eval-') && dataDir.startsWith(os.tmpdir())) fs.rmSync(dataDir, { recursive: true, force: true });
else out(`Data dir kept: ${dataDir}`);
process.exit(crashed ? 2 : hard.length ? 1 : 0);
