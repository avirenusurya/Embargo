/**
 * Pre-existing regression checks from the original harness, unchanged in substance:
 *  - answer-check unit cases (verbatim leaks caught, minimal answers not refused) against src/core/checks.ts
 *  - heuristic sensitivity layer on labelled lines incl. Hinglish (hold decision)
 *  - fact keys stable across phrasings (contradiction detection depends on it)
 */
import { verbatimOverlap } from '../core/checks.ts';
import * as sealedMod from '../core/sealed.ts';
import { regexFlags, keywordFlags, mergeFlags, maxSeverity } from '../ai/sensitivity.ts';
import { heuristicFacts } from '../ai/tasks.ts';

export interface UnitCheck { name: string; ok: boolean; detail: string }

/** Thresholds from src/core/sealed.ts when exported; spec 12.6 defaults otherwise. */
export function answerCheckConfig() {
  const c = (sealedMod as any).ANSWER_CHECK ?? {};
  return { maxQuotedTokens: c.maxQuotedTokens ?? 12, maxNgramOverlap: c.maxNgramOverlap ?? 0.2, minTokensForNgram: c.minTokensForNgram ?? 20 };
}

export function runUnitChecks(): UnitCheck[] {
  const out: UnitCheck[] = [];
  const AC = answerCheckConfig();
  const fails = (a: string, src: string) => { const v = verbatimOverlap(a, [src]); return v.longestRun > AC.maxQuotedTokens || (v.answerTokens >= AC.minTokensForNgram && v.ngramOverlap > AC.maxNgramOverlap); };
  {
    const sealed = 'API rate limit is 100 requests per minute per key. Admin panel lives behind the VPN at admin.internal.acme. Incident contact rotates weekly between Ravi and Sana. Database backups run nightly at 02:00 IST to a separate region.';
    const leaks = [
      sealed, sealed.toUpperCase(), sealed.replace(/\. /g, '.\n'),
      'Sure! Here it is: Admin panel lives behind the VPN at admin.internal.acme. Incident contact rotates weekly between Ravi and Sana.',
      'The document says: API rate limit is 100 requests per minute per key. Admin panel lives behind the VPN at admin.internal.acme.',
    ];
    const fine = ['Api rate limit: 100 requests per minute per key.', 'Backups run every night.', 'yes', 'The limit is 100 per minute.'];
    const caught = leaks.filter((a) => fails(a, sealed)).length;
    const falseRef = fine.filter((a) => fails(a, sealed)).length;
    out.push({ name: 'answer check unit: verbatim leaks caught', ok: caught === leaks.length, detail: `${caught}/${leaks.length} caught` });
    out.push({ name: 'answer check unit: minimal answers not refused', ok: falseRef === 0, detail: `${falseRef}/${fine.length} refused` });
  }
  {
    const labelled: [string, boolean][] = [
      ['Our budget for this deal is 5 lakh', true], ['Call me on +91 98765 43210', true], ['My email is meera@client.test', true],
      ['The key is sk-proj-abcdEFGH1234567890xyz', true], ['He was fired last week', true], ['Her salary is 18 LPA', true],
      ['PAN is ABCDE1234F', true], ['We are raising a seed round at 40 crore valuation', true], ['She is in hospital for surgery', true],
      ['Standup is at 10 am', false], ['We moved launch to 20 Nov', false], ['Use indigo for the brand color', false],
      ['I will write the deploy checklist', false], ['The docs live in the wiki', false], ['Let us ship the onboarding flow', false],
      ['Kal tak design ready ho jayega', false], ['Pricing page ka copy finalize karo', false], ['Client ka budget 3 lakh hai', true],
    ];
    let tp = 0, fp = 0, fn = 0;
    for (const [t, y] of labelled) { const pred = maxSeverity(mergeFlags(regexFlags(t), keywordFlags(t))) === 'high'; if (pred && y) tp++; else if (pred && !y) fp++; else if (!pred && y) fn++; }
    const p = tp / (tp + fp || 1), r = tp / (tp + fn || 1);
    out.push({ name: 'sensitivity unit (heuristic layer, high-severity holds)', ok: r >= 0.8, detail: `precision ${p.toFixed(2)}, recall ${r.toFixed(2)} on ${labelled.length} lines incl. Hinglish (gate: recall ≥ 0.8)` });
  }
  {
    const a = heuristicFacts('Launch price is ₹499/month.')[0], b = heuristicFacts('Quick update, the launch price is ₹599/month now.')[0];
    out.push({ name: 'facts unit: same key across phrasings', ok: !!a && !!b && a.entity === b.entity && a.attribute === b.attribute && a.value !== b.value, detail: JSON.stringify([a && [a.entity, a.attribute, a.value], b && [b.entity, b.attribute, b.value]]) });
  }
  return out;
}
