/**
 * Detection metrics from the eval world (Part 21.2 rows "Sensitivity detection" and "Contradiction detection"):
 *  - statement hold decisions after ingest vs the hand labels on every transcript line
 *  - contradiction suggestions vs the seeded conflicting-fact pairs
 */
import { BLOCKS } from './fixtures/corpus.ts';
import { QUERIES } from './fixtures/queries.ts';
import { ratio } from './lib.ts';
import type { World } from './world.ts';

export interface DetectionResult {
  sensitivity: { lines: number; tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; misses: string[]; falseHolds: string[]; alignmentIssues: string[] };
  contradiction: { seeded: number; detected: number; recall: number; suggestions: number; matchingSeeded: number; precision: number; missed: string[]; extra: string[] };
}

export async function runDetection(w: World): Promise<DetectionResult> {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const misses: string[] = [], falseHolds: string[] = [], align: string[] = [];
  for (const b of BLOCKS.filter((x) => x.lines)) {
    const got = w.blocks.get(b.key)!.initialStatements.slice().sort((x, y) => x.ordinal - y.ordinal);
    if (got.length !== b.lines!.length) { align.push(`${b.key}: ${got.length} statements for ${b.lines!.length} lines (split differs; skipped)`); continue; }
    b.lines!.forEach((l, i) => {
      const held = got[i].status === 'held';
      if (l.expectHeld && held) tp++; else if (!l.expectHeld && held) { fp++; falseHolds.push(`${b.key}#${i} ${l.speaker}: ${l.text}`); }
      else if (l.expectHeld && !held) { fn++; misses.push(`${b.key}#${i} ${l.speaker}: ${l.text}`); } else tn++;
    });
  }
  // Seeded contradiction pairs come from the query labels.
  const seeded = [...new Map(QUERIES.filter((q) => q.contradiction).map((q) => { const p = [...q.contradiction!].sort(); return [p.join('|'), p] as const; })).values()];
  let sugg: any[] = [];
  for (const status of ['open', 'superseded', 'approved', 'rejected']) sugg = sugg.concat(await w.api('priya', 'GET', `/workspaces/${w.acme}/suggestions?type=contradiction&status=${status}`).catch(() => []));
  const keysOf = (s: any) => (s.target_block_ids ?? []).map((id: string) => w.keyById.get(id) ?? id).sort();
  const matches = (s: any, p: readonly string[]) => { const k = keysOf(s); return p.every((x) => k.includes(x)); };
  const detected = seeded.filter((p) => sugg.some((s) => matches(s, p)));
  const matching = sugg.filter((s) => seeded.some((p) => matches(s, p)));
  return {
    sensitivity: { lines: tp + fp + fn + tn, tp, fp, fn, tn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), misses, falseHolds, alignmentIssues: align },
    contradiction: {
      seeded: seeded.length, detected: detected.length, recall: ratio(detected.length, seeded.length), suggestions: sugg.length, matchingSeeded: matching.length, precision: ratio(matching.length, sugg.length),
      missed: seeded.filter((p) => !detected.includes(p)).map((p) => p.join(' vs ')),
      extra: sugg.filter((s) => !matching.includes(s)).map((s) => `${keysOf(s).join(' vs ')}: ${s.summary}`).slice(0, 10),
    },
  };
}
