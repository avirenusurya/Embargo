/** Context compiler (Part 9.3): budget packing, pinned-first, ordering, dedupe, summary fallback, withheld counts, learning loop. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, teardown } from '../helpers/env.ts';

setupEnv();
const { compile, reportUse } = await import('../../src/core/compiler.ts');
const { countTokens } = await import('../../src/ai/llm.ts');
const { getDb } = await import('../../src/db/index.ts');
const { uuidv7 } = await import('../../src/util.ts');
const { mkUser, mkWorkspace, mkBlock, addMember } = await import('../helpers/fixtures.ts');
after(() => teardown());

const db = await getDb();
const owner = await mkUser(db, 'Owner');
const dev = await mkUser(db, 'Dev');
const ws = await mkWorkspace(db, owner);
await addMember(db, ws, dev, 'editor');
const conn = { kind: 'connection' as const, id: uuidv7(), workspace_id: ws, user_id: dev, scopes: ['read'] };

const para = (topic: string, n: number) => Array.from({ length: n }, (_, i) => `The ${topic} deployment pipeline step ${i + 1} runs migrations, builds containers and checks health for the ${topic} service.`).join(' ');
const pinned = await mkBlock(db, { ws, owner, title: 'Product summary', pinned: true, summary: 'Acme Notes is a fast shared notebook for small teams.' });
const deploy = await mkBlock(db, {
  ws, owner, title: 'Deploy guide', summary: 'How we deploy the deployment pipeline.',
  sections: [{ heading: 'Pipeline', text: para('api', 6) }], decisions: ['Deploy pipeline runs from main only'], facts: [{ entity: 'deployment pipeline', attribute: 'branch', value: 'main' }],
});
const fillers: { id: string }[] = [];
for (const t of ['billing', 'search', 'auth', 'sync']) fillers.push(await mkBlock(db, { ws, owner, title: `${t} deploy`, sections: [{ heading: `${t} pipeline`, text: para(t, 5) }] }));
const dupA = await mkBlock(db, { ws, owner, title: 'Rollback runbook', sections: [{ heading: 'Rollback', text: 'To roll back the deployment pipeline, redeploy the previous container tag and rerun health checks.' }] });
const dupB = await mkBlock(db, { ws, owner, title: 'Rollback runbook copy', sections: [{ heading: 'Rollback', text: 'To roll back the deployment pipeline, redeploy the previous container tag and rerun health checks.' }] });
const sealed = await mkBlock(db, { ws, owner, title: 'Deploy secrets', access_mode: 'sealed_use', sections: [{ heading: 'Keys', text: 'The deployment pipeline secret is hunter2-deploy-key.' }] });
const priv = await mkBlock(db, { ws, owner, title: 'Owner private deploy notes', visibility: 'private', sections: [{ heading: 'Notes', text: 'Private deployment pipeline musings.' }] });
const TASK = 'Fix the deployment pipeline so containers pass health checks';

test('respects max_tokens and reports more_available; pinned content goes first', async () => {
  const r = await compile(db, conn, { task: TASK, max_tokens: 250 });
  assert.ok(r.tokens_total <= 250, `tokens_total ${r.tokens_total} <= 250`);
  assert.equal(r.tokens_total, r.items.reduce((s, i) => s + i.tokens, 0));
  assert.equal(r.more_available, true);
  assert.ok(r.items.length > 0);
  assert.equal(r.items[0].block_id, pinned.id, 'pinned first');
  assert.equal(r.items[0].why_included, 'pinned');
  for (const i of r.items) assert.ok(i.tokens > 0);
});

test('budget below the floor is clamped to 200 tokens; a huge budget is capped at 20000', async () => {
  const r = await compile(db, conn, { task: TASK, max_tokens: 10 });
  assert.ok(r.tokens_total <= 200 && r.items.length > 0, `clamped: ${r.tokens_total}`);
  const big = await compile(db, conn, { task: TASK, max_tokens: 10_000_000 });
  assert.ok(big.tokens_total <= 20000);
});

test('sections that do not fit fall back to their first sentence ("trimmed to fit")', async () => {
  const text = Array.from({ length: 14 }, (_, i) => `Kafka ingestion consumer group ${i + 1} replays partitions, commits offsets and alerts on lag.`).join(' ');
  await mkBlock(db, { ws, owner, title: 'Kafka ingestion', sections: [{ heading: 'Consumers', text }] });
  assert.ok(countTokens(`Consumers\n${text}`) > 200, 'section larger than the minimum budget');
  const r = await compile(db, conn, { task: 'kafka ingestion consumer group partitions offsets lag', max_tokens: 200 });
  const trimmed = r.items.filter((i) => i.why_included.includes('trimmed to fit'));
  assert.ok(trimmed.length >= 1, JSON.stringify(r.items.map((i) => [i.title, i.heading, i.tokens, i.why_included])));
  for (const t of trimmed) { assert.ok(t.text.endsWith('…')); assert.ok(t.tokens < 50); }
  assert.ok(r.tokens_total <= 200);
  assert.equal(r.more_available, true);
});

test('sealed_use, private and other-workspace content is never compiled; withheld count reflects it', async () => {
  const r = await compile(db, conn, { task: TASK, max_tokens: 20000 });
  const blocks = new Set(r.items.map((i) => i.block_id));
  assert.ok(!blocks.has(sealed.id) && !blocks.has(priv.id));
  const all = r.items.map((i) => i.text).join('\n');
  assert.ok(!all.includes('hunter2') && !all.includes('musings'));
  assert.ok(r.withheld_count >= 2, `withheld ${r.withheld_count}`);
  const other = await mkWorkspace(db, owner, 'Other');
  const otherConn = { kind: 'connection' as const, id: uuidv7(), workspace_id: other, user_id: owner, scopes: ['read'] };
  const r2 = await compile(db, otherConn, { task: TASK, max_tokens: 20000 });
  assert.equal(r2.items.length, 0, 'no cross-workspace leakage');
});

test('ordering: pinned → decisions → facts → other sections; near-duplicates are dropped', async () => {
  const r = await compile(db, conn, { task: TASK, max_tokens: 20000 });
  const rank = (h?: string) => (h === 'Decisions' ? 1 : h === 'Key facts' ? 2 : 3);
  const rest = r.items.filter((i) => i.block_id !== pinned.id);
  for (let k = 1; k < rest.length; k++) assert.ok(rank(rest[k - 1].heading) <= rank(rest[k].heading), rest.map((i) => i.heading).join(' | '));
  const dups = r.items.filter((i) => i.block_id === dupA.id || i.block_id === dupB.id);
  assert.equal(dups.length, 1, 'identical rollback sections collapse to one');
  assert.ok(r.items.some((i) => i.block_id === deploy.id && i.heading === 'Decisions'));
  assert.ok(r.items.every((i) => i.why_included.length > 0));
});

test('every compile is logged; reported usage feeds the per-cluster priors', async () => {
  const r = await compile(db, conn, { task: TASK, max_tokens: 1000 });
  const log = (await db.query('SELECT * FROM access_logs WHERE id=$1', [r.compile_id]))[0];
  assert.equal(log.connection_id, conn.id);
  assert.equal(log.channel, 'mcp');
  assert.equal(log.tokens_served, r.tokens_total);
  assert.equal(log.withheld_count, r.withheld_count);
  assert.ok(r.task_cluster_id);
  const used = r.items.find((i) => i.block_id !== pinned.id)!;
  const ignored = r.items.find((i) => i.block_id !== used.block_id && i.block_id !== pinned.id);
  const res = await reportUse(db, conn, { compile_id: r.compile_id, used_ids: [used.id], ignored_ids: ignored ? [ignored.id] : [] });
  assert.deepEqual(res, { ok: true });
  const p = (await db.query('SELECT alpha, beta FROM usage_priors WHERE block_id=$1 AND task_cluster_id=$2', [used.block_id, r.task_cluster_id]))[0];
  assert.ok(Number(p.alpha) > Number(p.beta), 'used block gains alpha');
  const other = { ...conn, id: uuidv7() };
  assert.equal((await reportUse(db, other, { compile_id: r.compile_id, used_ids: [], ignored_ids: [] })).ok, false, 'another connection cannot report on this compile');
});

test('fillers are reachable when the budget allows', async () => {
  const r = await compile(db, conn, { task: 'billing search auth sync deployment pipeline containers', max_tokens: 20000 });
  assert.ok(fillers.filter((f) => r.items.some((i) => i.block_id === f.id)).length >= 2);
});

// Regression (src/core/compiler.ts): the only relevance gate was sim < 0.05, so with a large budget every loosely
// related block was packed (eval set precision 0.14). Unpinned candidates must now also reach COMPILER_REL_SIM × the
// best unpinned similarity; pinned items always stay.
test('relevance gate: weakly related blocks are not packed even when the budget allows; pinned stays', async () => {
  const { config } = await import('../../src/config.ts');
  const weak = await mkBlock(db, { ws, owner, title: 'Hiring process', sections: [{ heading: 'Stages', text: 'The hiring pipeline has a phone screen, a take-home task and a final interview.' }] });
  assert.ok(config.compiler.relSim > 0, 'gate on by default');
  const r = await compile(db, conn, { task: TASK, max_tokens: 20000 });
  assert.ok(!r.items.some((i) => i.block_id === weak.id), 'weak match dropped');
  assert.equal(r.items[0].block_id, pinned.id, 'pinned first, regardless of similarity');
  assert.ok(r.items.some((i) => i.block_id === deploy.id), 'the relevant block is kept');
  const saved = config.compiler.relSim;
  config.compiler.relSim = 0;
  try {
    const loose = await compile(db, conn, { task: TASK, max_tokens: 20000 });
    assert.ok(loose.items.some((i) => i.block_id === weak.id), 'with the gate off the weak match is packed (the gate is what drops it)');
  } finally { config.compiler.relSim = saved; }
});
