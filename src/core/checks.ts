/** Shared leakage checks: verbatim overlap (token LCS + 8-gram), used by answer check and action check. */
import { tokenize } from '../ai/llm.ts';

export function longestCommonRun(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  let best = 0; let prev = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}
const grams = (t: number[], n: number) => { const s = new Set<string>(); for (let i = 0; i + n <= t.length; i++) s.add(t.slice(i, i + n).join(',')); return s; };

/** Normalise before tokenising so case/spacing tricks don't evade the check. */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function verbatimOverlap(answer: string, sources: string[]) {
  const a = Array.from(tokenize(norm(answer)));
  let maxRun = 0; const srcGrams = new Set<string>();
  for (const s of sources) {
    const t = Array.from(tokenize(norm(s)));
    maxRun = Math.max(maxRun, longestCommonRun(a, t));
    for (const g of grams(t, 8)) srcGrams.add(g);
  }
  const ag = grams(a, 8);
  let hit = 0; for (const g of ag) if (srcGrams.has(g)) hit++;
  return { longestRun: maxRun, ngramOverlap: ag.size ? hit / ag.size : 0, answerTokens: a.length };
}
