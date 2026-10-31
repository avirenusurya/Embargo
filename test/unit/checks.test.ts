/**
 * Answer check (Part 12.6) and the shared verbatim-overlap primitives. Intentional deviation from the spec text:
 * the 8-gram ratio rule only applies to answers with ≥ 20 tokens (ANSWER_CHECK.minTokensForNgram); short answers
 * are still bounded by the 12-token quoted-run rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from '../helpers/env.ts';

setupEnv();
const { longestCommonRun, verbatimOverlap } = await import('../../src/core/checks.ts');
const { answerCheck, ANSWER_CHECK } = await import('../../src/core/sealed.ts');
const { tokenize, hashEmbed } = await import('../../src/ai/llm.ts');

const SEALED = 'API rate limit is 100 requests per minute per key. Admin panel lives behind the VPN at an internal hostname. Incident contact rotates weekly between the two backend engineers.';

test('thresholds match the spec (12-token run, 20% 8-gram, 0.75 semantic, 2 sentences) plus the 20-token n-gram floor', () => {
  assert.deepEqual({ ...ANSWER_CHECK }, { maxQuotedTokens: 12, maxNgramOverlap: 0.2, minTokensForNgram: 20, semanticThreshold: 0.75, neededSim: 0.3, factsOnlyMaxSentences: 2 });
});

test('longestCommonRun finds the longest shared contiguous token run', () => {
  assert.equal(longestCommonRun([], [1, 2]), 0);
  assert.equal(longestCommonRun([1, 2, 3, 4], [9, 2, 3, 4, 8]), 3);
  assert.equal(longestCommonRun([1, 2, 1, 2, 3], [1, 2, 3]), 3);
  assert.equal(longestCommonRun([5, 6], [7, 8]), 0);
});

test('verbatimOverlap is case/whitespace-insensitive and reports answer length in tokens', () => {
  const a = verbatimOverlap('ADMIN   PANEL lives behind the VPN', [SEALED]);
  const b = verbatimOverlap('admin panel lives behind the vpn', [SEALED]);
  assert.equal(a.longestRun, b.longestRun);
  assert.ok(a.longestRun >= 5);
  assert.equal(b.answerTokens, Array.from(tokenize('admin panel lives behind the vpn')).length);
  assert.equal(verbatimOverlap('', [SEALED]).ngramOverlap, 0);
  const copy = verbatimOverlap(SEALED, [SEALED]);
  assert.equal(copy.ngramOverlap, 1, 'full copy → 100% 8-gram overlap');
});

test('facts_only: a minimal paraphrased fact passes', async () => {
  const r = await answerCheck("What's our API rate limit?", 'The limit is 100 per minute.', 'facts_only', [{ text: SEALED, qsim: 0.9 }]);
  assert.deepEqual(r, { pass: true, failures: [] });
});

test('verbatim run longer than 12 tokens fails regardless of answer length', async () => {
  const quote = 'Admin panel lives behind the VPN at an internal hostname. Incident contact rotates';
  const v = verbatimOverlap(quote, [SEALED]);
  assert.ok(v.longestRun > 12);
  const r = await answerCheck('Where is the admin panel?', quote, 'summary', [{ text: SEALED, qsim: 0.9 }]);
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.startsWith('verbatim:run_')), r.failures.join());
});

test('8-gram rule: short (<20 token) answers are exempt; ≥20-token answers over 20% overlap fail', async () => {
  // Short answer that shares 8-grams with the source but no run over 12 tokens.
  const short = 'API rate limit is 100 requests per minute.';
  const vs = verbatimOverlap(short, [SEALED]);
  assert.ok(vs.answerTokens < ANSWER_CHECK.minTokensForNgram && vs.ngramOverlap > ANSWER_CHECK.maxNgramOverlap && vs.longestRun <= 12, JSON.stringify(vs));
  const rs = await answerCheck('rate limit?', short, 'facts_only', [{ text: SEALED, qsim: 0.9 }]);
  assert.ok(!rs.failures.some((f) => f.startsWith('verbatim:ngram')), 'short answers are not failed by the ratio rule');

  // Long answer stitched from source 8-grams (each run ≤ 12 tokens) → ratio rule fires.
  const long = 'So, the rate limit is 100 requests per minute per key. Also the admin panel lives behind the VPN at an internal place, and incident contact rotates weekly between the two backend folks.';
  const vl = verbatimOverlap(long, [SEALED]);
  assert.ok(vl.answerTokens >= ANSWER_CHECK.minTokensForNgram, `tokens ${vl.answerTokens}`);
  assert.ok(vl.longestRun <= 12, `run ${vl.longestRun}`);
  assert.ok(vl.ngramOverlap > ANSWER_CHECK.maxNgramOverlap, `ngram ${vl.ngramOverlap}`);
  const rl = await answerCheck('rate limit?', long, 'summary', [{ text: SEALED, qsim: 0.9 }]);
  assert.ok(rl.failures.some((f) => f.startsWith('verbatim:ngram_')), rl.failures.join());
});

test('policy shape: yes_no accepts only yes/no/unknown; facts_only allows at most 2 sentences', async () => {
  for (const ok of ['yes', 'No.', 'unknown']) assert.equal((await answerCheck('q', ok, 'yes_no', [{ text: SEALED, qsim: 0.9 }])).pass, true, ok);
  const bad = await answerCheck('q', 'Yes, it is 100 per minute.', 'yes_no', [{ text: SEALED, qsim: 0.9 }]);
  assert.ok(bad.failures.includes('shape:yes_no'));
  const tooLong = await answerCheck('q', 'It is 100. It is per key. It rotates weekly.', 'facts_only', [{ text: SEALED, qsim: 0.9 }]);
  assert.ok(tooLong.failures.includes('shape:too_long'));
});

test('semantic over-disclosure: answers close to a section unrelated to the question fail', async () => {
  const unrelated = 'Incident contact rotates weekly between the two backend engineers on call.';
  const answer = 'Incident contact rotates weekly between backend engineers on call.';
  const r = await answerCheck('What is the API rate limit?', answer, 'summary', [{ text: SEALED, qsim: 0.9 }, { text: unrelated, vector: hashEmbed(unrelated), qsim: 0.05 }]);
  assert.ok(r.failures.includes('semantic:unrelated_section'), r.failures.join());
});

test('judge (heuristic without an LLM): long multi-sentence answers are flagged as revealing too much', async () => {
  const long = 'One fact here. Another fact there. A third fact. And a fourth one too.';
  const r = await answerCheck('q', long, 'summary', [{ text: 'unrelated material entirely', qsim: 0.9 }]);
  assert.ok(r.failures.includes('judge'), r.failures.join());
});
