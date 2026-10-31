/**
 * Retrieval, token and compile-latency metrics through the real get_context path (gateway → compiler).
 * Every compiled response is also checked for forbidden content:
 *  - item from a block the requester may not receive (hand labels), or purpose-gated without matching purpose
 *  - item from a per-query forbidden block
 *  - section id that is not in the block's current version (stale/superseded content)
 *  - statement id whose status is held/blocked, or team_only for a non-member
 *  - any labelled "never" string in the delivered text
 */
import { BLOCKS, blockByKey } from './fixtures/corpus.ts';
import { QUERIES } from './fixtures/queries.ts';
import { TEAM, type QueryFixture, type Who } from './fixtures/types.ts';
import { containsNeedle, countTokens, dist, mean, ratio, type Dist } from './lib.ts';
import type { World } from './world.ts';

export interface Violation { query: string; who: Who; kind: string; detail: string }
interface Compiled { items: any[]; tokens_total: number; tokens_saved_estimate?: number; withheld_count?: number; more_available?: boolean }

const DEFAULT_BUDGET = 2000;
const TIGHT_BUDGET = 500;

function needlesFor(who: Who): { needle: string; from: string }[] {
  const out: { needle: string; from: string }[] = [];
  for (const b of BLOCKS) {
    for (const n of b.neverText ?? []) out.push({ needle: n, from: b.key });
    for (const n of b.neverTextFor?.[who] ?? []) out.push({ needle: n, from: b.key });
  }
  return out;
}

export function checkForbidden(w: World, q: QueryFixture, res: Compiled, tag: string): Violation[] {
  const v: Violation[] = [];
  const add = (kind: string, detail: string) => v.push({ query: `${q.id}${tag}`, who: q.who, kind, detail });
  const needles = needlesFor(q.who);
  for (const it of res.items ?? []) {
    const key = w.keyById.get(it.block_id);
    if (!key) { add('unknown_block', String(it.block_id)); continue; }
    const fx = blockByKey.get(key)!;
    if (!fx.visibleTo.includes(q.who)) add('not_visible_to_requester', `${key} (${fx.access_mode ?? 'viewable'}/${fx.visibility ?? 'team'}${fx.status ? '/' + fx.status : ''}${fx.embargo ? '/embargo:' + fx.embargo : ''}${fx.expires ? '/expires:' + fx.expires : ''})`);
    if (fx.purposes && !(q.purpose && fx.purposes.includes(q.purpose))) add('purpose_mismatch', `${key} requires purpose ${fx.purposes.join('|')}`);
    if (q.forbid?.includes(key)) add('query_forbidden', key);
    const st = w.blocks.get(key)!;
    if (it.section_id && !st.sectionIds.has(it.section_id)) add('stale_section', `${key} section ${it.section_id} is not in current version v${st.versionNo}`);
    for (const sid of it.statement_ids ?? []) {
      const s = w.statementById.get(sid);
      if (!s) { add('unknown_statement', `${key} ${sid}`); continue; }
      const ok = s.status === 'allowed' || (s.status === 'team_only' && TEAM.includes(q.who));
      if (!ok) add('statement_status', `${key} #${s.ordinal} status=${s.status}`);
    }
    for (const n of needles) if (containsNeedle(String(it.text ?? ''), n.needle)) add('never_text', `"${n.needle}" (from ${n.from}) in item of ${key}`);
  }
  return v;
}

/**
 * Negative control: feed the checker synthetic responses that each contain one kind of forbidden content.
 * If any is not flagged, a "0 forbidden returned" result would be meaningless, so this is a hard check.
 */
export function checkerSelfTest(w: World): { ok: boolean; detail: string } {
  const q: QueryFixture = { id: 'selftest', who: 'dev', task: 'x', relevant: [] };
  const sealed = w.blocks.get('security')!;
  const held = [...w.statementById.entries()].find(([, s]) => s.status === 'held' || s.status === 'blocked');
  const teamOnly = [...w.statementById.entries()].find(([, s]) => s.status === 'team_only');
  const old = w.supersededSectionIds.get('refund_policy')?.[0];
  const refund = w.blocks.get('refund_policy')!;
  const cases: [string, QueryFixture, any][] = [
    ['sealed_use block', q, { block_id: sealed.id, section_id: [...sealed.sectionIds][0], text: 'x' }],
    ['private block', q, { block_id: w.blocks.get('fundraise')!.id, section_id: [...w.blocks.get('fundraise')!.sectionIds][0], text: 'x' }],
    ['purpose-gated block without purpose', q, { block_id: w.blocks.get('support_macros')!.id, section_id: [...w.blocks.get('support_macros')!.sectionIds][0], text: 'x' }],
    ['superseded section', q, { block_id: refund.id, section_id: old, text: 'x' }],
    ['held/blocked statement', q, { block_id: w.blocks.get(held?.[1].blockKey ?? 'initech_call')!.id, statement_ids: [held?.[0]], text: 'x' }],
    ['team_only statement to partner', { ...q, who: 'partner' }, { block_id: w.blocks.get(teamOnly?.[1].blockKey ?? 'globex_sync')!.id, statement_ids: [teamOnly?.[0]], text: 'x' }],
    ['secret string in allowed block', q, { block_id: w.blocks.get('product')!.id, section_id: [...w.blocks.get('product')!.sectionIds][0], text: 'by the way DIWALI40 works' }],
  ];
  const missed = cases.filter(([, qq, item]) => checkForbidden(w, qq, { items: [item], tokens_total: 0 }, '').length === 0).map(([n]) => n);
  const clean = checkForbidden(w, q, { items: [{ block_id: w.blocks.get('product')!.id, section_id: [...w.blocks.get('product')!.sectionIds][0], text: 'Acme Notes is a shared notebook.' }], tokens_total: 0 }, '');
  const ok = !missed.length && !clean.length && !!held && !!teamOnly && !!old;
  return { ok, detail: ok ? `${cases.length}/${cases.length} planted violations flagged, clean item passes` : `missed: ${missed.join(', ') || '-'}; clean flagged: ${clean.length}; fixtures present: held=${!!held} team_only=${!!teamOnly} superseded=${!!old}` };
}

interface RankMetrics { p1: number; p3: number; p5: number; r3: number; r5: number; rr: number; rprec: number; setP: number; setR: number; setPnoPin: number; returned: number; ideal3: number }
function rankMetrics(ranked: string[], relevant: string[], pinned: Set<string>): RankMetrics {
  const R = new Set(relevant);
  const hits = (k: number) => ranked.slice(0, k).filter((x) => R.has(x)).length;
  const firstRel = ranked.findIndex((x) => R.has(x));
  const setHits = ranked.filter((x) => R.has(x)).length;
  const noPin = ranked.filter((x) => R.has(x) || !pinned.has(x));
  return {
    p1: hits(1), p3: hits(3) / 3, p5: hits(5) / 5, r3: hits(3) / R.size, r5: hits(5) / R.size, rr: firstRel >= 0 ? 1 / (firstRel + 1) : 0,
    rprec: hits(R.size) / R.size, setP: ratio(setHits, ranked.length), setR: setHits / R.size, setPnoPin: ratio(noPin.filter((x) => R.has(x)).length, noPin.length),
    returned: ranked.length, ideal3: Math.min(R.size, 3) / 3,
  };
}
const avgMetrics = (ms: RankMetrics[]) => {
  const keys = ['p1', 'p3', 'p5', 'r3', 'r5', 'rr', 'rprec', 'setP', 'setR', 'setPnoPin', 'returned', 'ideal3'] as const;
  return Object.fromEntries(keys.map((k) => [k === 'rr' ? 'mrr' : k, mean(ms.map((m) => m[k]).filter((x) => Number.isFinite(x)))])) as Record<string, number>;
};

export interface RetrievalResult {
  queries: number; withRelevant: number;
  atBudget: Record<string, number>; atTight: Record<string, number>;
  noAnswer: { queries: number; meanBlocksReturned: number; meanBlocksReturnedExPinned: number };
  byRequester: Record<string, Record<string, number>>;
  contradiction: { queries: number; withPairReturned: number; warned: number };
  perQuery: any[];
  forbidden: { compiles: number; violations: Violation[] };
  tokens: {
    requests: number; compiled: Dist; originalServed: Dist; library: Dist;
    savingsVsServed: Dist; savingsVsLibrary: Dist; envelope: Dist;
    budget: { checked: number; declaredOver: number; deliveredOver: number; itemSumMismatch: number; examples: string[] };
    savedEstimateMismatch: number;
  };
  latency: Dist;
  errors: string[];
  selfTest: { ok: boolean; detail: string };
}

export async function runRetrieval(w: World, opts: { rounds: number; log: (s: string) => void }): Promise<RetrievalResult> {
  const pinned = new Set(BLOCKS.filter((b) => b.pinned).map((b) => b.key));
  const latencies: number[] = [];
  const violations: Violation[] = [];
  const errors: string[] = [];
  let compiles = 0;
  const per: any[] = [];
  const mAt: RankMetrics[] = [], mTight: RankMetrics[] = [];
  const byWho = new Map<Who, RankMetrics[]>();
  const noAns: { n: number; ex: number }[] = [];
  const tok = { compiled: [] as number[], orig: [] as number[], lib: [] as number[], sServed: [] as number[], sLib: [] as number[], env: [] as number[] };
  const budget = { checked: 0, declaredOver: 0, deliveredOver: 0, itemSumMismatch: 0, examples: [] as string[] };
  let savedMismatch = 0;
  const contra = { queries: 0, withPairReturned: 0, warned: 0 };

  const library = (who: Who, purpose?: string) => BLOCKS.filter((b) => b.visibleTo.includes(who) && (!b.purposes || (purpose && b.purposes.includes(purpose))))
    .reduce((s, b) => s + (w.blocks.get(b.key)?.tokensOriginal ?? 0), 0);

  const itemTokens = (i: any) => countTokens(i.heading ? `${i.heading}\n${i.text}` : String(i.text ?? ''));
  /** Budget adherence is checked on every compile (labelled budget, 500-token pass and latency rounds). */
  const checkBudget = (q: QueryFixture, res: Compiled, max: number, tag: string) => {
    const compiled = Number(res.tokens_total ?? 0);
    const delivered = (res.items ?? []).reduce((s: number, i: any) => s + itemTokens(i), 0);
    const itemSum = (res.items ?? []).reduce((s: number, i: any) => s + Number(i.tokens ?? 0), 0);
    budget.checked++;
    if (compiled > max) { budget.declaredOver++; budget.examples.push(`${q.id}${tag}: tokens_total ${compiled} > max_tokens ${max}`); }
    if (delivered > max) {
      budget.deliveredOver++;
      // Attribute the gap per item: delivered heading+text tokens minus the item's declared tokens.
      const gaps = (res.items ?? []).map((i: any) => ({ d: itemTokens(i) - Number(i.tokens ?? 0), kind: i.statement_ids ? `statements×${i.statement_ids.length}` : /trimmed|summary only/.test(String(i.why_included)) ? 'trimmed section' : 'section', key: w.keyById.get(i.block_id) }))
        .filter((g: any) => g.d > 0).map((g: any) => `${g.key} ${g.kind} +${g.d}`);
      budget.examples.push(`${q.id}${tag}: delivered ${delivered} > max_tokens ${max} (declared ${compiled}); per-item excess: ${gaps.join(', ')}`);
    }
    if (itemSum !== compiled) budget.itemSumMismatch++;
  };

  const compile = async (q: QueryFixture, max: number | undefined, tag: string) => {
    const r = await w.tool(w.conns[q.who], 'get_context', { task: q.task, ...(max ? { max_tokens: max } : {}), ...(q.purpose ? { purpose: q.purpose } : {}) });
    compiles++;
    latencies.push(r.ms);
    if (!r.ok) { errors.push(`${q.id}${tag}: ${r.error?.code} ${r.error?.message}`); return null; }
    violations.push(...checkForbidden(w, q, r.structured, tag));
    checkBudget(q, r.structured, max ?? DEFAULT_BUDGET, tag);
    return r;
  };

  for (const q of QUERIES) {
    const max = q.max_tokens ?? DEFAULT_BUDGET;
    const r = await compile(q, q.max_tokens, '');
    if (!r) continue;
    const res: Compiled = r.structured;
    const ranked: string[] = [...new Set<string>((res.items ?? []).map((i: any) => w.keyById.get(i.block_id) ?? '?'))];
    // --- tokens ---
    const served = new Set(ranked);
    const original = [...served].reduce((s, k) => s + (w.blocks.get(k)?.tokensOriginal ?? 0), 0);
    const lib = library(q.who, q.purpose);
    const compiled = Number(res.tokens_total ?? 0);
    if (res.items?.length) {
      tok.compiled.push(compiled); tok.orig.push(original); tok.lib.push(lib); tok.env.push(countTokens(r.text));
      if (original > 0) tok.sServed.push(1 - compiled / original);
      if (lib > 0) tok.sLib.push(1 - compiled / lib);
      if (res.tokens_saved_estimate !== undefined && res.tokens_saved_estimate !== Math.max(0, original - compiled)) savedMismatch++;
    }
    // --- contradiction warnings ---
    if (q.contradiction) {
      contra.queries++;
      const pairItems = (res.items ?? []).filter((i: any) => q.contradiction!.includes(w.keyById.get(i.block_id) ?? ''));
      if (pairItems.length) { contra.withPairReturned++; if (pairItems.some((i: any) => (i.warnings ?? []).some((x: string) => /contradiction/i.test(x)))) contra.warned++; }
    }
    // --- relevance ---
    const row: any = { id: q.id, who: q.who, task: q.task, budget: max, relevant: q.relevant, returned: ranked, tokens: compiled, original, withheld: res.withheld_count, more: !!res.more_available };
    if (q.relevant.length) {
      const m = rankMetrics(ranked, q.relevant, pinned);
      mAt.push(m); byWho.set(q.who, [...(byWho.get(q.who) ?? []), m]);
      Object.assign(row, { p3: m.p3, r5: m.r5, rr: m.rr, setP: m.setP, setR: m.setR });
      if (!q.max_tokens) {
        const rt = await compile(q, TIGHT_BUDGET, '@500');
        if (rt) {
          const rk: string[] = [...new Set<string>((rt.structured.items ?? []).map((i: any) => w.keyById.get(i.block_id) ?? '?'))];
          const mt = rankMetrics(rk, q.relevant, pinned); mTight.push(mt);
          Object.assign(row, { tight: rk, tightP: mt.setP, tightR: mt.setR });
        }
      }
    } else {
      noAns.push({ n: ranked.length, ex: ranked.filter((k) => !pinned.has(k)).length });
    }
    per.push(row);
  }
  opts.log(`  retrieval: ${per.length} queries, ${compiles} compiles, ${violations.length} forbidden`);
  // --- extra latency rounds (each response is still checked for forbidden content) ---
  for (let round = 1; round < opts.rounds; round++) for (const q of QUERIES) await compile(q, q.max_tokens, `#r${round + 1}`);

  const whoAgg: Record<string, Record<string, number>> = {};
  for (const [k, ms] of byWho) whoAgg[k] = { queries: ms.length, ...avgMetrics(ms) };
  return {
    queries: QUERIES.length, withRelevant: mAt.length,
    atBudget: avgMetrics(mAt), atTight: avgMetrics(mTight),
    noAnswer: { queries: noAns.length, meanBlocksReturned: mean(noAns.map((x) => x.n)), meanBlocksReturnedExPinned: mean(noAns.map((x) => x.ex)) },
    byRequester: whoAgg, contradiction: contra, perQuery: per,
    forbidden: { compiles, violations },
    tokens: {
      requests: tok.compiled.length, compiled: dist(tok.compiled), originalServed: dist(tok.orig), library: dist(tok.lib),
      savingsVsServed: dist(tok.sServed), savingsVsLibrary: dist(tok.sLib), envelope: dist(tok.env),
      budget: { ...budget, examples: budget.examples.slice(0, 10) }, savedEstimateMismatch: savedMismatch,
    },
    latency: dist(latencies), errors, selfTest: checkerSelfTest(w),
  };
}
