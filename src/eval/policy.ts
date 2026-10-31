/**
 * Policy property test (Part 21.1 property-based row; Part 21.2 "0 withheld served").
 *  1. The original randomized test (seed 42, same distribution as before), N cases.
 *  2. A boundary pass: start from an allowed configuration and mutate one or two fields, so far more cases sit
 *     on the allow/withhold boundary (the random pass allows < 1% of cases).
 * Both use the same safety oracle: any allowed item that the rules say must be withheld is a violation.
 * Informational: agreement with a literal reading of the 8.3 pseudo-code (engine stricter / looser / other form).
 */
import { evaluate, type EvalInput } from '../core/policy.ts';

type Rnd = () => number;
const lcg = (s: number): Rnd => () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

/** Safety oracle (unchanged from the original harness). Returns a reason string if serving `d` is a violation. */
function violation(input: EvalInput, d: { allow: boolean; form?: string }): string | null {
  if (!d.allow) return null;
  const r = input.rule!; const b = input.block; const stmt = input.statement; const stRule = input.statementRule;
  const t = input.now.getTime();
  const scopes = input.requester.scopes; const channel = input.channel; const memberOf = input.memberOf;
  const effEmb = stRule?.embargo_until ?? r.embargo_until;
  const effExp = stRule?.expires_at ?? r.expires_at;
  if (b.status !== 'active') return 'status';
  if (b.storage_mode === 'sealed_block') return 'sealed_block';
  if (effExp && t >= +new Date(effExp)) return 'expired';
  if (effEmb && t < +new Date(effEmb)) return 'embargoed';
  if (stmt && (stmt.status === 'blocked' || stmt.status === 'held')) return 'statement_status';
  if (stmt?.status === 'team_only' && !memberOf.has(b.workspace_id)) return 'team_only_statement';
  if (r.visibility === 'private' && input.requester.user_id !== b.owner_id) return 'private';
  if (r.visibility === 'team' && !memberOf.has(b.workspace_id) && !input.viaCard) return 'team';
  if (r.visibility === 'partner' && !(memberOf.has(b.workspace_id) || (r.partner_workspace_id && input.requester.workspace_id === r.partner_workspace_id) || input.viaCard)) return 'partner';
  if (b.access_mode === 'sealed_use' && d.form !== 'sealed_input') return 'sealed_use_as_text';
  if (d.form === 'sealed_input' && (channel !== 'sealed' || !scopes.includes('ask_sealed'))) return 'sealed_scope_or_channel';
  if (channel === 'web' && b.access_mode === 'agent_only' && d.form !== 'hidden') return 'agent_only_on_web';
  const allowed = stRule?.allowed_connection_ids?.length ? stRule.allowed_connection_ids : r.allowed_connection_ids;
  if (allowed?.length && input.requester.kind === 'connection' && !allowed.includes(input.requester.id)) return 'tool_not_allowed';
  const purposes = stRule?.purposes?.length ? stRule.purposes : r.purposes;
  if (purposes?.length && !purposes.includes(input.purpose as string)) return 'purpose';
  return null;
}

/** Literal reading of the Part 8.3 pseudo-code (statement rules override timing/tools/purposes; statement
 *  visibility is carried by statement.status; sealed blocks are never served per 12.4). */
function spec(input: EvalInput): { allow: boolean; form?: string; reason?: string } {
  const r = input.rule!; const b = input.block; const s = input.statement; const sr = input.statementRule ?? {};
  const W = (reason: string) => ({ allow: false, reason });
  const member = input.memberOf.has(b.workspace_id);
  const t = input.now.getTime();
  const exp = sr.expires_at ?? r.expires_at, emb = sr.embargo_until ?? r.embargo_until;
  const conns = sr.allowed_connection_ids?.length ? sr.allowed_connection_ids : r.allowed_connection_ids;
  const purposes = sr.purposes?.length ? sr.purposes : r.purposes;
  if (['revoked', 'archived', 'draft'].includes(b.status)) return W('status');
  if (b.storage_mode === 'sealed_block') return W('sealed_block');
  if (s?.status === 'blocked') return W('blocked_by_speaker');
  if (s?.status === 'held') return W('awaiting_review');
  if (exp && t >= +new Date(exp)) return W('expired');
  if (emb && t < +new Date(emb)) return W('embargoed');
  if (r.visibility === 'private' && input.requester.user_id !== b.owner_id) return W('private');
  if (r.visibility === 'team' && !member && !input.viaCard) return W('team_only');
  if (r.visibility === 'partner' && !(member || (r.partner_workspace_id && input.requester.workspace_id === r.partner_workspace_id) || input.viaCard)) return W('partner_only');
  if (s?.status === 'team_only' && !member) return W('team_only_statement');
  if (conns?.length && input.requester.kind === 'connection' && !conns.includes(input.requester.id)) return W('tool_not_allowed');
  if (purposes?.length && !(input.purpose && purposes.includes(input.purpose))) return W('purpose_mismatch');
  let form: string;
  if (b.access_mode === 'viewable') form = 'text';
  else if (b.access_mode === 'agent_only') form = input.channel === 'web' ? 'hidden' : 'text';
  else if (b.access_mode === 'sealed_use') { if (input.channel !== 'sealed') return W('sealed_use_only'); form = 'sealed_input'; }
  else return W('unknown_mode');
  if (input.channel === 'sealed' && !input.requester.scopes.includes('ask_sealed')) return W('scope');
  return { allow: true, form };
}

function randomCase(rnd: Rnd, now: Date): EvalInput {
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  // Draw order matches the original harness so seed 42 reproduces the same 200k cases.
  const ws = pick(['A', 'B']); const reqWs = pick(['A', 'B', null]);
  const owner = pick(['u1', 'u2']); const user = pick(['u1', 'u2', 'u3', null]);
  const memberOf = new Set<string>(reqWs && user ? [reqWs] : []);
  const viaCard = rnd() < 0.2;
  const exp = pick([null, '2026-10-29T00:00:00Z', '2026-11-01T00:00:00Z']);
  const emb = pick([null, '2026-10-29T00:00:00Z', '2026-11-01T00:00:00Z']);
  const allowedConns = pick([null, ['c1'], ['c2']]);
  const purposes = pick([null, ['support']]);
  const purpose = pick([null, 'support', 'marketing']);
  const channel = pick(['mcp', 'web', 'sealed', 'action'] as const);
  const scopes = pick([['read'], ['read', 'ask_sealed']]);
  const stmt = rnd() < 0.5 ? { id: 's', status: pick(['allowed', 'held', 'team_only', 'blocked']) } : null;
  const stRule = stmt && rnd() < 0.3 ? { embargo_until: pick(['2026-10-29T00:00:00Z', '2026-11-01T00:00:00Z']), visibility: 'public' as const } : null;
  return {
    requester: { kind: pick(['connection', 'user', 'card_link'] as const), id: pick(['c1', 'c2', 'c3']), workspace_id: reqWs, user_id: user, scopes },
    channel, now, purpose,
    block: { id: 'b', workspace_id: ws, owner_id: owner, status: pick(['draft', 'active', 'active', 'archived', 'revoked']), access_mode: pick(['viewable', 'agent_only', 'sealed_use']), storage_mode: pick(['standard', 'standard', 'sealed_block']) },
    rule: { visibility: pick(['private', 'team', 'partner', 'public'] as const), partner_workspace_id: pick([null, 'B']), allowed_connection_ids: allowedConns, purposes, expires_at: exp, embargo_until: emb },
    statement: stmt, statementRule: stRule, memberOf, viaCard,
  };
}

/** Boundary case: an allowed base (active viewable team block, member requester) with 1–2 mutations. */
function boundaryCase(rnd: Rnd, now: Date): EvalInput {
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  const past = '2026-10-29T00:00:00Z', future = '2026-11-01T00:00:00Z';
  const i: EvalInput = {
    requester: { kind: 'connection', id: 'c1', workspace_id: 'A', user_id: 'u1', scopes: ['read', 'ask_sealed'] },
    channel: pick(['mcp', 'web', 'sealed', 'action'] as const), now, purpose: null,
    block: { id: 'b', workspace_id: 'A', owner_id: 'u2', status: 'active', access_mode: pick(['viewable', 'agent_only', 'sealed_use']), storage_mode: 'standard' },
    rule: { visibility: 'team', partner_workspace_id: null, allowed_connection_ids: null, purposes: null, expires_at: null, embargo_until: null },
    statement: rnd() < 0.4 ? { id: 's', status: 'allowed' } : null, statementRule: null, memberOf: new Set(['A']), viaCard: false,
  };
  const muts: (() => void)[] = [
    () => { i.block.status = pick(['draft', 'archived', 'revoked']); },
    () => { i.block.storage_mode = 'sealed_block'; },
    () => { i.rule!.expires_at = pick([past, future]); },
    () => { i.rule!.embargo_until = pick([past, future]); },
    () => { i.rule!.visibility = pick(['private', 'partner', 'public']); i.rule!.partner_workspace_id = pick([null, 'B']); },
    () => { i.memberOf = new Set(); i.requester.workspace_id = pick(['B', null]); },
    () => { i.viaCard = true; },
    () => { i.requester.user_id = pick(['u2', 'u3', null]); },
    () => { i.rule!.allowed_connection_ids = pick([['c1'], ['c2']]); },
    () => { i.requester.kind = pick(['user', 'card_link']); },
    () => { i.rule!.purposes = ['support']; i.purpose = pick([null, 'support', 'marketing']); },
    () => { i.requester.scopes = ['read']; },
    () => { i.statement = { id: 's', status: pick(['held', 'team_only', 'blocked']) }; },
    () => { i.statement ??= { id: 's', status: 'allowed' }; i.statementRule = pick([{ embargo_until: pick([past, future]) }, { expires_at: pick([past, future]) }, { allowed_connection_ids: ['c2'] }, { purposes: ['support'] }]); },
  ];
  const n = 1 + Math.floor(rnd() * 2);
  for (let k = 0; k < n; k++) pick(muts)();
  return i;
}

export interface PolicyResult {
  random: { cases: number; served: number; violations: number };
  boundary: { cases: number; served: number; violations: number };
  violations: number;
  examples: { pass: string; reason: string; input: any; decision: any }[];
  spec: { looser: number; stricter: number; formDiff: number; stricterBy: Record<string, number>; looserBy: Record<string, number> };
  ms: number;
}

export function runPolicySuite(N: number): PolicyResult {
  const t0 = Date.now();
  const now = new Date('2026-10-30T10:00:00Z');
  const out: PolicyResult = { random: { cases: N, served: 0, violations: 0 }, boundary: { cases: Math.floor(N / 2), served: 0, violations: 0 }, violations: 0, examples: [], spec: { looser: 0, stricter: 0, formDiff: 0, stricterBy: {}, looserBy: {} }, ms: 0 };
  const run = (pass: 'random' | 'boundary', input: EvalInput) => {
    const d = evaluate(input) as any;
    if (d.allow) out[pass].served++;
    const v = violation(input, d);
    if (v) { out[pass].violations++; if (out.examples.length < 5) out.examples.push({ pass, reason: v, input: { ...input, memberOf: [...input.memberOf] }, decision: d }); }
    const s = spec(input);
    if (d.allow && !s.allow) { out.spec.looser++; out.spec.looserBy[s.reason!] = (out.spec.looserBy[s.reason!] ?? 0) + 1; }
    else if (!d.allow && s.allow) { out.spec.stricter++; const k = `${d.reason} (channel=${input.channel}, mode=${input.block.access_mode})`; out.spec.stricterBy[k] = (out.spec.stricterBy[k] ?? 0) + 1; }
    else if (d.allow && s.allow && d.form !== s.form) out.spec.formDiff++;
  };
  const r1 = lcg(42); for (let i = 0; i < N; i++) run('random', randomCase(r1, now));
  const r2 = lcg(7); for (let i = 0; i < out.boundary.cases; i++) run('boundary', boundaryCase(r2, now));
  out.violations = out.random.violations + out.boundary.violations;
  out.ms = Date.now() - t0;
  return out;
}
