/**
 * Action check eval (Part 12.7, 21.2 "Action check" row) through the real perform_action tool.
 * Each case gets a fresh connection so its 24h "received" history is exactly the labelled `received` blocks
 * (read via read_block first). Allowed actions go to the mock viaSocket receiver.
 * Outcome mapping: status 'sent' → allow; 'blocked' with a restricted-content reason → block;
 * 'held'/'hold'/'pending' → hold (the spec defines none); any other failure → error.
 */
import { blockByKey } from './fixtures/corpus.ts';
import { ACTIONS } from './fixtures/actions.ts';
import type { ActionExpect } from './fixtures/types.ts';
import { dist, ratio, type Dist } from './lib.ts';
import { CONN_OWNER, type World } from './world.ts';

type Outcome = ActionExpect | 'error';
export interface ActionCaseResult { id: string; expect: ActionExpect; outcome: Outcome; reason?: string; specScope: boolean; why: string; stable: boolean; ms: number }
export interface ActionResult {
  cases: number; scored: number; rounds: number;
  matrix: Record<ActionExpect, Record<Outcome, number>>;
  accuracy: number; blockRecall: number; blockPrecision: number; falsePositiveRate: number;
  rates: { allow: number; hold: number; block: number; error: number };
  misclassified: ActionCaseResult[]; specScope: ActionCaseResult[]; unstable: string[];
  forwarded: { sent: number; received: number };
  scopeCheck: { ok: boolean; detail: string };
  latency: Dist; errors: string[]; perCase: ActionCaseResult[];
}

function classify(r: { ok: boolean; structured: any; error?: { code: string; message: string } }): { outcome: Outcome; reason?: string } {
  if (!r.ok) return { outcome: 'error', reason: `${r.error?.code}: ${r.error?.message}` };
  const s = String(r.structured?.status ?? '');
  const reason = r.structured?.reason ? String(r.structured.reason) : undefined;
  if (s === 'sent' || s === 'allowed') return { outcome: 'allow', reason };
  if (['held', 'hold', 'pending', 'pending_review'].includes(s)) return { outcome: 'hold', reason };
  if (s === 'blocked') {
    // A delivery/config failure is also reported as blocked; that is not an action-check decision.
    if (reason && /no viasocket flow|action_not_configured|viasocket flow returned|fetch failed/i.test(reason)) return { outcome: 'error', reason };
    return { outcome: 'block', reason };
  }
  return { outcome: 'error', reason: `unexpected status ${s}` };
}

export async function runActions(w: World, opts: { rounds: number; log: (s: string) => void }): Promise<ActionResult> {
  const latencies: number[] = [];
  const errors: string[] = [];
  const per: ActionCaseResult[] = [];
  const sentBefore = w.mock.received.length;
  let sent = 0;
  for (const a of ACTIONS) {
    const o = CONN_OWNER[a.who];
    const conn = a.baseConnection ? w.conns[a.who] : await w.newConnection(o.user, `action eval ${a.id}`, ['perform_action']);
    for (const k of a.received ?? []) {
      const r = await w.tool(conn, 'read_block', { block_id: w.blocks.get(k)!.id });
      if (!r.ok) errors.push(`${a.id}: prior read_block(${k}) failed: ${r.error?.code} (${blockByKey.get(k)?.access_mode ?? 'viewable'})`);
    }
    let first: { outcome: Outcome; reason?: string } | null = null; let stable = true; let ms = 0;
    for (let round = 1; round <= opts.rounds; round++) {
      const r = await w.tool(conn, 'perform_action', { action: a.action, target: a.target, payload: a.payload });
      latencies.push(r.ms);
      const c = classify(r);
      if (c.outcome === 'allow') sent++;
      if (!first) { first = c; ms = r.ms; } else if (c.outcome !== first.outcome) stable = false;
      if (c.outcome === 'error' && round === 1) errors.push(`${a.id}: ${c.reason}`);
    }
    per.push({ id: a.id, expect: a.expect, outcome: first!.outcome, reason: first!.reason, specScope: !!a.specScope, why: a.why, stable, ms });
  }
  const scored = per.filter((p) => !p.specScope);
  const outs: Outcome[] = ['allow', 'hold', 'block', 'error'];
  const matrix = Object.fromEntries((['allow', 'hold', 'block'] as ActionExpect[]).map((e) => [e, Object.fromEntries(outs.map((o) => [o, scored.filter((p) => p.expect === e && p.outcome === o).length]))])) as ActionResult['matrix'];
  const correct = scored.filter((p) => p.expect === p.outcome).length;
  const expBlock = scored.filter((p) => p.expect === 'block'), expAllow = scored.filter((p) => p.expect === 'allow');
  const predBlock = scored.filter((p) => p.outcome === 'block');
  opts.log(`  actions: ${per.length} cases × ${opts.rounds}, accuracy ${(correct / scored.length * 100).toFixed(1)}%`);
  return {
    cases: per.length, scored: scored.length, rounds: opts.rounds, matrix,
    accuracy: ratio(correct, scored.length),
    blockRecall: ratio(expBlock.filter((p) => p.outcome === 'block').length, expBlock.length),
    blockPrecision: ratio(predBlock.filter((p) => p.expect === 'block').length, predBlock.length),
    falsePositiveRate: ratio(expAllow.filter((p) => p.outcome === 'block' || p.outcome === 'hold').length, expAllow.length),
    rates: Object.fromEntries(outs.map((o) => [o, ratio(scored.filter((p) => p.outcome === o).length, scored.length)])) as ActionResult['rates'],
    misclassified: scored.filter((p) => p.expect !== p.outcome), specScope: per.filter((p) => p.specScope), unstable: per.filter((p) => !p.stable).map((p) => p.id),
    forwarded: { sent, received: w.mock.received.length - sentBefore },
    scopeCheck: await scopeCheck(w), latency: dist(latencies), errors, perCase: per,
  };
}

/** perform_action without the perform_action scope must fail with forbidden_scope (15.3). */
async function scopeCheck(w: World) {
  const r = await w.tool(w.conns.cursor, 'perform_action', { action: 'post_slack', target: '#general', payload: { text: 'hello' } });
  const ok = !r.ok && r.error?.code === 'forbidden_scope';
  return { ok, detail: ok ? 'forbidden_scope returned' : `got ${r.ok ? JSON.stringify(r.structured) : r.error?.code}` };
}
