/**
 * Eval helpers: statistics, an independent token counter / verbatim-overlap check (so a bug in
 * src/core/checks.ts cannot hide a leak), needle matching and console tables.
 */
import { getEncoding } from 'js-tiktoken';

// ---------------- statistics ----------------
export interface Dist { n: number; mean: number; p50: number; p90: number; p95: number; p99: number; max: number; min: number }
/** Linear-interpolated percentile (same as numpy's default). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
export function dist(xs: number[]): Dist {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
  return { n: s.length, mean, p50: percentile(s, 0.5), p90: percentile(s, 0.9), p95: percentile(s, 0.95), p99: percentile(s, 0.99), max: s[s.length - 1] ?? NaN, min: s[0] ?? NaN };
}
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const ratio = (a: number, b: number) => (b ? a / b : NaN);

// ---------------- tokens & verbatim overlap (independent of src/core/checks.ts) ----------------
const enc = getEncoding('o200k_base');
export const countTokens = (s: string) => (s ? enc.encode(s).length : 0);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function longestRun(a: number[], b: number[]): number {
  let best = 0; let prev = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}
const grams = (t: number[], n: number) => { const s = new Set<string>(); for (let i = 0; i + n <= t.length; i++) s.add(t.slice(i, i + n).join(',')); return s; };

/** 12.6 rule 1: longest common token run and 8-gram overlap ratio of `answer` against `sources`. */
export function verbatim(answer: string, sources: string[]) {
  const a = Array.from(enc.encode(norm(answer)));
  let run = 0; const src = new Set<string>();
  for (const s of sources) { const t = Array.from(enc.encode(norm(s))); run = Math.max(run, longestRun(a, t)); for (const g of grams(t, 8)) src.add(g); }
  const ag = grams(a, 8); let hit = 0; for (const g of ag) if (src.has(g)) hit++;
  return { run, ngram: ag.size ? hit / ag.size : 0, tokens: a.length };
}

// ---------------- needles ----------------
/** Case-, whitespace- and dash-insensitive containment. */
const fold = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, ' ');
export const containsNeedle = (hay: string, needle: string) => fold(hay).includes(fold(needle));

// ---------------- console table ----------------
export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const w = all[0].map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => (c ?? '').padEnd(w[i])).join('  ');
  const out = all.map(line);
  if (header) out.splice(1, 0, w.map((n) => '-'.repeat(n)).join('  '));
  return out.join('\n');
}
export const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : 'n/a');
export const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
export const ms = (x: number) => (Number.isFinite(x) ? `${x.toFixed(x < 10 ? 1 : 0)} ms` : 'n/a');

export const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
