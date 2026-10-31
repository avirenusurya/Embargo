/** Dictated rule commands (Wispr Flow → POST /rule-commands/parse), heuristic parser. Transcript splitting for conversations. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from '../helpers/env.ts';

setupEnv();
const { parseRuleCommand, heuristicSplit, heuristicFacts } = await import('../../src/ai/tasks.ts');
const tasks = await import('../../src/ai/tasks.ts');
const NOW = new Date('2026-10-01T09:00:00Z');

test('embargo with a date → embargo_until in the future, target extracted', async () => {
  const r = await parseRuleCommand('Embargo the launch plan until 15 November', NOW);
  assert.ok(r.embargo_until, JSON.stringify(r));
  const d = new Date(r.embargo_until!);
  assert.ok(d > NOW);
  assert.equal(d.getUTCMonth(), 10);
  assert.equal(r.expires_at, null);
  assert.match(r.target_ref, /launch plan/i);
});

test('visibility and access-mode words', async () => {
  assert.equal((await parseRuleCommand('Make the pricing doc private', NOW)).visibility, 'private');
  assert.equal((await parseRuleCommand('Make pricing team-only', NOW)).visibility, 'team');
  assert.equal((await parseRuleCommand('Share the brand guide with partners', NOW)).visibility, 'partner');
  assert.equal((await parseRuleCommand('Seal the security internals', NOW)).access_mode, 'sealed_use');
  assert.equal((await parseRuleCommand('Make the roadmap agent-only', NOW)).access_mode, 'agent_only');
});

test('expiry phrasing → expires_at, not embargo', async () => {
  const r = await parseRuleCommand('Expire the hiring notes on 1 December', NOW);
  assert.ok(r.expires_at && !r.embargo_until, JSON.stringify(r));
});

test('a command with no rule words returns nulls instead of guessing', async () => {
  const r = await parseRuleCommand('the onboarding guide', NOW);
  assert.deepEqual({ v: r.visibility, a: r.access_mode, e: r.embargo_until, x: r.expires_at }, { v: null, a: null, e: null, x: null });
});

test('transcript splitting keeps speakers and timestamps', () => {
  const s = heuristicSplit('[00:01] Priya: The launch price is ₹599/month now.\n[00:20] Rohan: We moved launch to 20 Nov. I will update the doc.\nno speaker line').statements;
  assert.deepEqual(s.map((x) => x.speaker_label), ['Priya', 'Rohan', 'Rohan', 'Rohan']);
  assert.equal(s[0].start_ms, 1000);
  assert.equal(s[1].start_ms, 20000);
});

test('heuristic facts: "X is Y" and "moved X to Y" patterns', () => {
  const f = heuristicFacts('The launch price is ₹499/month. We moved launch to 20 Nov.');
  assert.ok(f.some((x) => x.value === '₹499/month' && /price/.test(x.attribute)), JSON.stringify(f));
  assert.ok(f.some((x) => x.value === '20 Nov'), JSON.stringify(f));
});

test('structured turns keep speakers and start times; long turns split into sentence statements', () => {
  const { splitTurns } = tasks;
  const s = splitTurns([
    { speaker: 'Priya', text: 'The launch price is ₹599/month now. Um, I will update the doc.', start_ms: 1500 },
    { speaker: 'Meera Guest', text: 'Rohan: this is not a speaker label.', start_ms: 20000 },
    { speaker: 'Rohan', text: '   ', start_ms: 30000 },
  ]).statements;
  assert.deepEqual(s.map((x) => [x.speaker_label, x.start_ms]), [['Priya', 1500], ['Priya', 1500], ['Meera Guest', 20000]]);
  assert.equal(s[1].text, 'I will update the doc.', 'filler removed');
  assert.equal(s[2].text, 'Rohan: this is not a speaker label.', 'turn text is never re-parsed for speakers');
});

// Regression (src/ai/tasks.ts heuristicCompress): facts were extracted from the raw markdown, so a title such as
// "# Help center: Offline mode" became the fact help|center and produced false contradictions between help pages.
test('heuristic compression takes facts from body lines, not markdown headings', () => {
  const { heuristicCompress } = tasks;
  const a = heuristicCompress('# Help center: Offline mode\n\n## Sync: how it works\n- Offline mode is available on mobile.\n- Sync interval is 5 minutes.', 'text');
  const b = heuristicCompress('# Help center: Exporting notes\n\nExport format is Markdown.', 'text');
  const keys = (s: { facts: { entity: string; attribute: string }[] }) => s.facts.map((f) => `${f.entity}|${f.attribute}`);
  assert.ok(!keys(a).includes('help|center') && !keys(b).includes('help|center'), JSON.stringify([a.facts, b.facts]));
  assert.ok(!keys(a).includes('sync') && !a.facts.some((f) => f.value === 'how it works'), 'sub-headings are not facts either');
  assert.ok(a.facts.some((f) => f.value === '5 minutes'), 'list items still yield facts');
  assert.ok(b.facts.some((f) => f.value === 'Markdown'));
  assert.equal(a.title, 'Help center: Offline mode', 'headings still drive title and sections');
});
