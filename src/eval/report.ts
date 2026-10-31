/** Console table + JSON + Markdown report. Spec targets are quoted from embargo.md Part 21.2 / features.md. */
import fs from 'node:fs';
import path from 'node:path';
import type { PolicyResult } from './policy.ts';
import type { UnitCheck } from './unit.ts';
import type { RetrievalResult } from './retrieval.ts';
import type { SealedResult } from './sealedEval.ts';
import type { ActionResult } from './actionsEval.ts';
import type { DetectionResult } from './detection.ts';
import { f2, ms, pct, table, type Dist } from './lib.ts';

export interface RunData {
  meta: { startedAt: string; finishedAt?: string; mode: 'full' | 'quick'; suites: string[]; durationMs?: number; phaseMs: Record<string, number>; aiMode: string; dataDir: string; node: string; rounds: number; policyCases: number };
  policy?: PolicyResult; unit?: UnitCheck[]; retrieval?: RetrievalResult; sealed?: SealedResult; actions?: ActionResult; detection?: DetectionResult;
  setup?: { warnings: string[]; lint: string[]; error?: string; setupMs?: number };
  logs: { warn: number; error: number; samples: string[] };
}

export interface Row { group: string; metric: string; value: string; target: string; status: 'PASS' | 'FAIL' | 'info' | 'MISS' }
const T = {
  policy: 'Spec 21.2: "0 withheld served (hard requirement)"; 21.1: no withheld item ever served',
  retrieval: 'No numeric target in spec (21.2: "Tune compiler weights")',
  tokens: 'No numeric target in spec (21.2: "Report median and p90")',
  budget: 'features.md E4/F1: "within token budget"; 9.2 max_tokens default 2000',
  latency: 'No numeric target in spec (21.2: get_context, ask_sealed "p50/p95")',
  latencyAction: 'No target in spec (21.2 latency row lists only get_context, ask_sealed)',
  leak: 'Spec 21.2: "target 0 verbatim leaks"',
  needle: 'No numeric target in spec (12.6 rules 2-3: no over-disclosure); harness treats as hard',
  refusal: 'No numeric target in spec (21.2: report "false refusal rate")',
  action: 'No numeric target in spec (21.2: "Block rate, false positive rate")',
  sens: 'No numeric target in spec (21.2: "Report precision/recall per category")',
  contra: 'No numeric target in spec (21.2: "Precision/recall")',
};
const d3 = (d: Dist, f: (x: number) => string) => `p50 ${f(d.p50)} · p90 ${f(d.p90)} · p95 ${f(d.p95)} · p99 ${f(d.p99)} (n=${d.n}${d.n < 100 ? ', p99 low-n' : ''})`;
const tok = (x: number) => (Number.isFinite(x) ? String(Math.round(x)) : 'n/a');

export function rows(d: RunData): Row[] {
  const out: Row[] = [];
  const add = (group: string, metric: string, value: string, target: string, status: Row['status']) => out.push({ group, metric, value, target, status });
  if (d.setup?.lint.length) add('setup', 'fixture lint errors', String(d.setup.lint.length), 'must be 0 (labels inconsistent)', 'FAIL');
  if (d.setup?.error) add('setup', 'world setup', d.setup.error.slice(0, 80), 'must succeed', 'FAIL');
  if (d.policy) {
    const p = d.policy;
    add('policy', 'property test violations', `${p.violations} in ${p.random.cases + p.boundary.cases} cases (random ${p.random.cases}, served ${p.random.served}; boundary ${p.boundary.cases}, served ${p.boundary.served})`, T.policy, p.violations === 0 ? 'PASS' : 'FAIL');
    add('policy', 'engine vs literal 8.3 pseudo-code', `looser ${p.spec.looser} · stricter ${p.spec.stricter} · form differs ${p.spec.formDiff}`, 'info (looser must be 0; stricter = deliberate deviations)', p.spec.looser === 0 ? 'info' : 'FAIL');
  }
  for (const u of d.unit ?? []) add('unit', u.name, u.detail, 'pre-existing regression gate', u.ok ? 'PASS' : 'FAIL');
  if (d.retrieval) {
    const r = d.retrieval; const a = r.atBudget, t = r.atTight;
    add('retrieval', `forbidden items returned (get_context)`, `${r.forbidden.violations.length} in ${r.forbidden.compiles} compiles`, T.policy, r.forbidden.violations.length === 0 ? 'PASS' : 'FAIL');
    add('retrieval', 'forbidden-content checker self-test', r.selfTest.detail, 'negative control (harness validity)', r.selfTest.ok ? 'PASS' : 'FAIL');
    add('retrieval', `precision@3 / recall@3 (budget as labelled, ${r.withRelevant} queries)`, `${f2(a.p3)} (ceiling ${f2(a.ideal3)}) / ${f2(a.r3)}`, T.retrieval, 'info');
    add('retrieval', 'precision@1 · recall@5 · MRR', `${f2(a.p1)} · ${f2(a.r5)} · ${f2(a.mrr)}`, T.retrieval, 'info');
    add('retrieval', 'set precision / recall @ labelled budget (default 2000)', `${f2(a.setP)} / ${f2(a.setR)} (excl. pinned P ${f2(a.setPnoPin)}; ${f2(a.returned)} blocks/compile)`, T.retrieval, 'info');
    add('retrieval', 'set precision / recall @ 500 tokens', `${f2(t.setP)} / ${f2(t.setR)} (${f2(t.returned)} blocks/compile)`, T.retrieval, 'info');
    add('retrieval', 'no-answer queries: blocks returned', `${r.noAnswer.queries} queries, mean ${f2(r.noAnswer.meanBlocksReturned)} blocks (${f2(r.noAnswer.meanBlocksReturnedExPinned)} excl. pinned)`, 'No target in spec', 'info');
    add('retrieval', 'contradiction warnings shown', `${r.contradiction.warned}/${r.contradiction.withPairReturned} compiles that returned a conflicting block`, 'Spec 9.3 step 8: attach warnings for open contradictions', r.contradiction.warned === r.contradiction.withPairReturned ? 'info' : 'MISS');
    const k = r.tokens;
    add('tokens', 'compiled tokens per request', `p50 ${tok(k.compiled.p50)} · p90 ${tok(k.compiled.p90)} · mean ${tok(k.compiled.mean)} (n=${k.requests})`, T.tokens, 'info');
    add('tokens', 'original tokens of served blocks', `p50 ${tok(k.originalServed.p50)} · p90 ${tok(k.originalServed.p90)}`, T.tokens, 'info');
    add('tokens', 'savings vs served originals', `p50 ${pct(k.savingsVsServed.p50)} · p90 ${pct(k.savingsVsServed.p90)} · mean ${pct(k.savingsVsServed.mean)}`, T.tokens, 'info');
    add('tokens', 'savings vs whole permitted library', `p50 ${pct(k.savingsVsLibrary.p50)} · p90 ${pct(k.savingsVsLibrary.p90)} (library p50 ${tok(k.library.p50)} tokens)`, T.tokens, 'info');
    add('tokens', 'budget: tokens_total > max_tokens', `${k.budget.declaredOver}/${k.budget.checked}`, T.budget, k.budget.declaredOver === 0 ? 'PASS' : 'FAIL');
    add('tokens', 'budget: delivered heading+text > max_tokens', `${k.budget.deliveredOver}/${k.budget.checked}`, T.budget, k.budget.deliveredOver === 0 ? 'PASS' : 'FAIL');
    add('latency', 'get_context (auth + compile + format)', d3(r.latency, ms), T.latency, 'info');
  }
  if (d.sealed) {
    const s = d.sealed;
    add('sealed', 'verbatim leaks (12.6 rule 1, ≥20-token 8-gram floor)', `${s.leaks.verbatim}/${s.answers} answers (${pct(s.leaks.verbatim / (s.answers || 1))})`, T.leak, s.leaks.verbatim === 0 ? 'PASS' : 'FAIL');
    add('sealed', 'over-disclosure (labelled secret in answer)', `${s.leaks.needle}/${s.answers} answers`, T.needle, s.leaks.needle === 0 ? 'PASS' : 'FAIL');
    add('sealed', 'leak detector self-test', s.selfTest.detail, 'negative control (harness validity)', s.selfTest.ok ? 'PASS' : 'FAIL');
    add('sealed', 'false refusal rate', `${pct(s.falseRefusal.rate)} (${s.falseRefusal.refused}/${s.falseRefusal.of} answerable)`, T.refusal, 'info');
    add('sealed', 'answer accuracy (answered, graded)', `${pct(s.answerAccuracy.rate)} (${s.answerAccuracy.correct}/${s.answerAccuracy.of})`, 'No target in spec', 'info');
    add('sealed', 'adversarial questions refused / answered safely', `${s.adversarial.refused} / ${s.adversarial.answeredSafely} of ${s.adversarial.of}`, 'No numeric target in spec', 'info');
    add('sealed', 'answers passing only via the ≥20-token 8-gram floor', String(s.strictNgramWouldFail), 'Deviation from 12.6 rule 1 (intentional)', 'info');
    add('sealed', 'probing guard (19.3 "refusal on repeated probing")', s.probingGuard.detail, 'Spec 19.3 (no numeric target)', s.probingGuard.ok ? 'PASS' : 'MISS');
    add('latency', 'ask_sealed', d3(s.latency, ms), T.latency, 'info');
  }
  if (d.actions) {
    const a = d.actions;
    add('actions', `accuracy (${a.scored} labelled cases)`, pct(a.accuracy), T.action, 'info');
    add('actions', 'block rate on restricted payloads (recall)', pct(a.blockRecall), T.action, 'info');
    add('actions', 'false positive rate on clean payloads', pct(a.falsePositiveRate), T.action, 'info');
    add('actions', 'outcome rates allow / hold / block / error', `${pct(a.rates.allow)} / ${pct(a.rates.hold)} / ${pct(a.rates.block)} / ${pct(a.rates.error)}`, 'No target in spec (15.3 defines sent|blocked only)', a.rates.error ? 'MISS' : 'info');
    add('actions', 'scope enforcement (no perform_action scope)', a.scopeCheck.detail, 'Spec 15.3: requires scope perform_action', a.scopeCheck.ok ? 'PASS' : 'FAIL');
    add('latency', 'perform_action (action check)', d3(a.latency, ms), T.latencyAction, 'info');
  }
  if (d.detection) {
    const s = d.detection.sensitivity, c = d.detection.contradiction;
    add('detection', `statement holds vs labels (${s.lines} transcript lines)`, `precision ${f2(s.precision)} · recall ${f2(s.recall)}`, T.sens, 'info');
    add('detection', `contradictions (${c.seeded} seeded pairs)`, `recall ${f2(c.recall)} · precision ${f2(c.precision)} (${c.suggestions} suggestions)`, T.contra, 'info');
  }
  return out;
}

export const hardFailures = (rs: Row[]) => rs.filter((r) => r.status === 'FAIL');

export function consoleTable(rs: Row[]) {
  return table(rs.map((r) => [r.status, r.group, r.metric, r.value]), ['', 'group', 'metric', 'value']);
}

export function markdown(d: RunData, rs: Row[]): string {
  const L: string[] = [];
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  L.push('# Embargo evaluation report', '');
  L.push(`Generated ${d.meta.finishedAt} · mode **${d.meta.mode}** · ${(Number(d.meta.durationMs) / 1000).toFixed(1)} s · AI mode **${d.meta.aiMode}** · Node ${d.meta.node}`, '');
  L.push(`Reproduce: \`npm run eval\` (full) or \`npm run eval -- --quick\`. Fixtures: \`src/eval/fixtures/\`. Data dir: \`${d.meta.dataDir}\` (isolated, deleted after the run unless \`--keep\`).`, '');
  const hf = hardFailures(rs);
  L.push(hf.length ? `**Hard invariants: ${hf.length} FAILED** (${hf.map((r) => r.metric).join('; ')})` : '**Hard invariants: all passed.**', '');
  L.push('| Status | Group | Metric | Value | Spec target |', '|---|---|---|---|---|');
  for (const r of rs) L.push(`| ${r.status} | ${r.group} | ${esc(r.metric)} | ${esc(r.value)} | ${esc(r.target)} |`);
  L.push('');
  L.push('## Definitions', '');
  L.push('- **Retrieval** runs every labelled task through `get_context` (MCP gateway → policy → compiler). Returned blocks are ranked by first appearance in the delivered item order (pinned → decisions → facts → sections → statements, spec 9.3 step 7). P@k = relevant blocks in the top k / k ("ceiling" = best achievable P@3 given the number of relevant blocks); R@k = relevant in top k / relevant; MRR = 1 / rank of the first relevant block; set P/R over all returned blocks. Queries with no permitted relevant block are excluded from P/R and reported as "no-answer queries".');
  L.push('- **Forbidden** = an item from a block the requester may not receive (hand labels), purpose-gated without a matching purpose, per-query forbidden, a section not in the current version (superseded), a held/blocked statement (or team_only to a non-member), or any labelled secret string. Every compile is checked, including the 500-token and latency rounds.');
  L.push('- **Tokens**: compiled = `tokens_total`; original = `tokens_original` of the distinct blocks served (what pasting those documents would cost); library = `tokens_original` of every block the requester may receive. Savings = 1 − compiled / original. Delivered = o200k tokens of each item\'s heading + text as returned.');
  L.push('- **Latency** is wall time of `authenticateConnection` + `callTool` in-process (the code behind `/mcp`, without HTTP/MCP framing). Rate limits are raised for the run so they do not throttle measurement.');
  L.push('- **Sealed leak** = an answered question whose answer has a token run > 12 or (for answers ≥ 20 tokens) 8-gram overlap > 20% with the sealed source text, measured with an independent implementation; or contains a labelled must-not-contain string. Intentional deviation: the 8-gram rule only applies to answers of ≥ 20 tokens (a minimal fact necessarily overlaps the "Key facts" line).');
  L.push('- **Action check** cases use a fresh connection whose 24 h history is exactly the labelled `received` blocks. The spec (15.3) defines only `sent | blocked`; "hold" is supported by the matrix but no case is labelled hold.', '');
  if (d.retrieval) {
    const r = d.retrieval;
    L.push('## Retrieval by requester', '', '| Requester | Queries | P@3 | R@3 | R@5 | MRR | Set P | Set R |', '|---|---|---|---|---|---|---|---|');
    for (const [k, m] of Object.entries(r.byRequester)) L.push(`| ${k} | ${m.queries} | ${f2(m.p3)} | ${f2(m.r3)} | ${f2(m.r5)} | ${f2(m.mrr)} | ${f2(m.setP)} | ${f2(m.setR)} |`);
    L.push('');
    const worst = r.perQuery.filter((q) => q.relevant.length && q.setR < 1).slice(0, 25);
    if (worst.length) {
      L.push('### Queries that missed a relevant block', '', '| Query | Task | Relevant | Returned (delivered order) |', '|---|---|---|---|');
      for (const q of worst) L.push(`| ${q.id} (${q.who}, ${q.budget}) | ${esc(q.task)} | ${q.relevant.join(', ')} | ${q.returned.join(', ')} |`);
      L.push('');
    }
    if (r.forbidden.violations.length) {
      L.push('### Forbidden content returned', '', '| Query | Who | Kind | Detail |', '|---|---|---|---|');
      for (const v of r.forbidden.violations.slice(0, 50)) L.push(`| ${v.query} | ${v.who} | ${v.kind} | ${esc(v.detail)} |`);
      L.push('');
    }
    if (r.tokens.budget.examples.length) L.push('### Budget overruns', '', ...r.tokens.budget.examples.map((e) => `- ${e}`), '');
    if (r.errors.length) L.push('### get_context errors', '', ...r.errors.slice(0, 20).map((e) => `- ${e}`), '');
  }
  if (d.sealed) {
    const s = d.sealed;
    L.push('## Sealed use', '', '| Kind | Questions | Answered | Refused | Leaks |', '|---|---|---|---|---|');
    for (const [k, v] of Object.entries(s.byKind)) L.push(`| ${k} | ${v.n} | ${v.answered} | ${v.refused} | ${v.leaks} |`);
    L.push('');
    if (s.falseRefusal.ids.length) L.push(`False refusals: ${s.falseRefusal.ids.join(', ')}`, '');
    if (s.answerAccuracy.wrong.length) L.push('Wrong answers:', '', ...s.answerAccuracy.wrong.map((x) => `- ${esc(x)}`), '');
    if (s.leaks.examples.length) L.push('Leaks:', '', ...s.leaks.examples.map((x) => `- ${x.id} round ${x.round}: ${x.leak.join(', ')} → "${esc(String(x.answer).slice(0, 160))}"`), '');
    L.push('<details><summary>All sealed answers (round 1)</summary>', '', '| Id | Kind | Expect | Outcome | Answer / refusal |', '|---|---|---|---|---|');
    for (const c of s.perCase) L.push(`| ${c.id} | ${c.kind} | ${c.expect} | ${c.outcome} | ${esc(String(c.answer ?? c.refusal ?? c.error ?? '').slice(0, 120))} |`);
    L.push('', '</details>', '');
  }
  if (d.actions) {
    const a = d.actions;
    L.push('## Action check', '', 'Rows = expected, columns = actual (spec-scope cases excluded).', '', '| expected \\ actual | allow | hold | block | error |', '|---|---|---|---|---|');
    for (const e of ['allow', 'hold', 'block'] as const) L.push(`| ${e} | ${a.matrix[e].allow} | ${a.matrix[e].hold} | ${a.matrix[e].block} | ${a.matrix[e].error} |`);
    L.push('');
    if (a.misclassified.length) {
      L.push('### Misclassified actions', '', '| Case | Expected | Actual | Why labelled | Reason returned |', '|---|---|---|---|---|');
      for (const m of a.misclassified) L.push(`| ${m.id} | ${m.expect} | ${m.outcome} | ${esc(m.why)} | ${esc(m.reason ?? '')} |`);
      L.push('');
    }
    if (a.specScope.length) {
      L.push('### Spec-scope cases (informational)', '', '| Case | Labelled per 12.7 letter | Actual | Note |', '|---|---|---|---|');
      for (const m of a.specScope) L.push(`| ${m.id} | ${m.expect} | ${m.outcome} | ${esc(m.why)} |`);
      L.push('');
    }
    L.push(`Forwarded to viaSocket mock: ${a.forwarded.received} posts for ${a.forwarded.sent} allowed calls.${a.unstable.length ? ` Unstable across rounds: ${a.unstable.join(', ')}.` : ''}`, '');
    if (a.errors.length) L.push('Harness notes:', '', ...a.errors.map((e) => `- ${esc(e)}`), '');
  }
  if (d.detection) {
    const s = d.detection.sensitivity, c = d.detection.contradiction;
    L.push('## Detection', '');
    L.push(`Statement holds: TP ${s.tp}, FP ${s.fp}, FN ${s.fn}, TN ${s.tn}.`);
    if (s.misses.length) L.push('', 'Missed (should be held):', ...s.misses.map((x) => `- ${esc(x)}`));
    if (s.falseHolds.length) L.push('', 'Held but labelled safe:', ...s.falseHolds.map((x) => `- ${esc(x)}`));
    if (s.alignmentIssues.length) L.push('', ...s.alignmentIssues.map((x) => `- ${x}`));
    L.push('', `Contradictions: ${c.detected}/${c.seeded} seeded pairs detected; ${c.matchingSeeded}/${c.suggestions} suggestions match a seeded pair.`);
    if (c.missed.length) L.push('', 'Missed pairs:', ...c.missed.map((x) => `- ${x}`));
    if (c.extra.length) L.push('', 'Unseeded contradiction suggestions:', ...c.extra.map((x) => `- ${esc(x)}`));
    L.push('');
  }
  if (d.policy) {
    const p = d.policy;
    L.push('## Policy engine vs literal 8.3', '');
    L.push(`Engine stricter than the literal pseudo-code in ${p.spec.stricter} cases (not a safety issue):`, '');
    for (const [k, n] of Object.entries(p.spec.stricterBy).sort((a, b) => b[1] - a[1]).slice(0, 12)) L.push(`- ${n} × ${k}`);
    if (p.examples.length) L.push('', 'Violations:', '```json', JSON.stringify(p.examples, null, 1).slice(0, 4000), '```');
    L.push('');
  }
  if (d.setup?.warnings.length || d.setup?.lint.length) L.push('## Setup warnings', '', ...(d.setup?.lint ?? []).map((x) => `- LINT: ${x}`), ...(d.setup?.warnings ?? []).map((x) => `- ${x}`), '');
  L.push('## Run', '', `Phases (s): ${Object.entries(d.meta.phaseMs).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(' · ')}. Server logs during run: ${d.logs.warn} warn, ${d.logs.error} error.`, '');
  if (d.logs.samples.length) L.push('```', ...d.logs.samples.slice(0, 10), '```', '');
  return L.join('\n');
}

export function writeReports(dir: string, d: RunData, rs: Row[]) {
  fs.mkdirSync(dir, { recursive: true });
  const json = { ...d, summary: rs, hardFailures: hardFailures(rs).map((r) => r.metric) };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(json, (k, v) => (v instanceof Set ? [...v] : v), 2));
  fs.writeFileSync(path.join(dir, 'REPORT.md'), markdown(d, rs));
}
