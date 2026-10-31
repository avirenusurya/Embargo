/**
 * Policy engine (Part 8). Deterministic, runs BEFORE any ranking or decryption.
 * `evaluate` is pure; `allowedItems` loads facts from Postgres (authoritative). TigerGraph may narrow the
 * candidate set, but every safety-critical field is always evaluated from Postgres (8.4). Errors fail closed.
 */
import type { Queryable } from '../db/index.ts';
import { HttpError, log } from '../util.ts';
import { inc } from './metrics.ts';
import * as tg from '../integrations/tigergraph.ts';

export type Channel = 'mcp' | 'web' | 'sealed' | 'action';
export interface Requester {
  kind: 'connection' | 'user' | 'card_link';
  id: string;               // connection id, user id, or card id
  workspace_id: string | null;
  user_id?: string | null;
  scopes: string[];
  card_id?: string;
}
export interface Rule {
  visibility: 'private' | 'team' | 'partner' | 'public'; partner_workspace_id?: string | null; allowed_connection_ids?: string[] | null;
  purposes?: string[] | null; expires_at?: string | Date | null; embargo_until?: string | Date | null; answer_policy?: string;
}
export type Form = 'text' | 'hidden' | 'sealed_input';
export type Decision = { allow: true; form: Form } | { allow: false; reason: string };

export interface EvalInput {
  requester: Requester; channel: Channel; now: Date; purpose?: string | null;
  block: { id: string; workspace_id: string; owner_id: string; status: string; access_mode: string; storage_mode: string };
  rule: Rule | null;
  statement?: { id: string; status: string; revoked_at?: string | Date | null } | null;
  statementRule?: Partial<Rule> | null;
  memberOf: Set<string>;    // workspaces the requester's user belongs to
  viaCard: boolean;         // an unexpired, unrevoked card covers this block for this requester
}

const t = (d: any) => (d ? new Date(d).getTime() : null);
const DEFAULT_RULE: Rule = { visibility: 'team' };

export function mergeRule(block: Rule | null, stmt?: Partial<Rule> | null): Rule {
  const base = { ...(block ?? DEFAULT_RULE) };
  // A statement rule narrows timing/tools/purposes; statement visibility is expressed by statement.status.
  if (stmt) for (const k of ['expires_at', 'embargo_until', 'allowed_connection_ids', 'purposes'] as const) {
    const v = (stmt as any)[k];
    if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) (base as any)[k] = v;
  }
  return base;
}

export function evaluate(i: EvalInput): Decision {
  const { requester: r, block, channel } = i;
  const rule = mergeRule(i.rule, i.statementRule);
  const W = (reason: string): Decision => ({ allow: false, reason });
  const member = i.memberOf.has(block.workspace_id);
  const now = i.now.getTime();

  if (['revoked', 'archived', 'draft'].includes(block.status)) return W('status');
  if (block.storage_mode === 'sealed_block') return W('sealed_block');
  if (i.statement?.revoked_at) return W('revoked');
  if (i.statement?.status === 'blocked') return W('blocked_by_speaker');
  if (i.statement?.status === 'held') return W('awaiting_review');

  const exp = t(rule.expires_at), emb = t(rule.embargo_until);
  if (exp !== null && now >= exp) return W('expired');
  if (emb !== null && now < emb) return W('embargoed');

  if (rule.visibility === 'private' && r.user_id !== block.owner_id) return W('private');
  if (rule.visibility === 'team' && !member && !i.viaCard) return W('team_only');
  if (rule.visibility === 'partner' && !(member || (rule.partner_workspace_id && r.workspace_id === rule.partner_workspace_id) || i.viaCard)) return W('partner_only');
  if (i.statement?.status === 'team_only' && !member) return W('team_only_statement');

  if (rule.allowed_connection_ids?.length && r.kind === 'connection' && !rule.allowed_connection_ids.includes(r.id)) return W('tool_not_allowed');
  if (rule.purposes?.length && !(i.purpose && rule.purposes.includes(i.purpose))) return W('purpose_mismatch');

  if (channel === 'sealed' && !r.scopes.includes('ask_sealed')) return W('scope');

  // Access mode vs channel (8.3): viewable is text on every channel; agent-only is hidden from the web UI;
  // sealed-use is only ever sealed-runtime input.
  switch (block.access_mode) {
    case 'viewable': return { allow: true, form: 'text' };
    case 'agent_only': return channel === 'web' ? { allow: true, form: 'hidden' } : { allow: true, form: 'text' };
    case 'sealed_use': return channel === 'sealed' ? { allow: true, form: 'sealed_input' } : W('sealed_use_only');
    default: return W('unknown_mode');
  }
}

// ---------------- Loaders (Postgres is authoritative) ----------------
export async function latestRules(q: Queryable, targetType: 'block' | 'statement' | 'card', ids: string[]): Promise<Map<string, Rule & { id: string; created_at: string }>> {
  if (!ids.length) return new Map();
  const rows = await q.query(`SELECT DISTINCT ON (target_id) * FROM rules WHERE target_type=$1 AND target_id = ANY($2::uuid[]) ORDER BY target_id, created_at DESC, id DESC`, [targetType, ids]);
  return new Map(rows.map((r) => [r.target_id, r]));
}

export async function memberships(q: Queryable, userId?: string | null): Promise<Map<string, string>> {
  if (!userId) return new Map();
  const rows = await q.query('SELECT workspace_id, role FROM memberships WHERE user_id=$1', [userId]);
  return new Map(rows.map((r) => [r.workspace_id, r.role]));
}

/** Valid cards for a requester → map block_id → card ids. */
export async function cardCoverage(q: Queryable, r: Requester, now: Date): Promise<Map<string, string[]>> {
  const conds: string[] = []; const params: any[] = [now];
  if (r.user_id) { params.push(r.user_id); conds.push(`(recipient_type='user' AND recipient_user_id=$${params.length})`); }
  if (r.workspace_id) { params.push(r.workspace_id); conds.push(`((recipient_type='workspace' OR recipient_type='link') AND recipient_workspace_id=$${params.length})`); }
  if (r.kind === 'card_link' && r.card_id) { params.push(r.card_id); conds.push(`(recipient_type='link' AND id=$${params.length})`); }
  if (!conds.length) return new Map();
  const cards = await q.query(`SELECT * FROM cards WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $1) AND (${conds.join(' OR ')})`, params);
  const cardRules = await latestRules(q, 'card', cards.map((c) => c.id));
  const out = new Map<string, string[]>();
  for (const c of cards) {
    const cr = cardRules.get(c.id);
    if (cr && ((cr.expires_at && now >= new Date(cr.expires_at)) || (cr.embargo_until && now < new Date(cr.embargo_until)))) continue;
    let ids: string[] = c.block_ids ?? [];
    if (c.collection_id) ids = ids.concat((await q.query('SELECT block_id FROM collection_blocks WHERE collection_id=$1', [c.collection_id])).map((x) => x.block_id));
    for (const b of ids) out.set(b, [...(out.get(b) ?? []), c.id]);
  }
  return out;
}

export interface AllowedItem { type: 'section' | 'statement'; id: string; block_id: string; version_id: string; form: Form; kind?: string }
export interface AllowedSet {
  items: AllowedItem[]; blocks: Map<string, any>; withheld: { type: string; id: string; block_id: string; reason: string }[];
  rules: Map<string, any>; memberOf: Map<string, string>;
}

export async function allowedItems(q: Queryable, r: Requester, channel: Channel, now: Date, purpose?: string | null, opts: { blockIds?: string[]; includeSections?: boolean } = {}): Promise<AllowedSet> {
  try {
    const memberOf = await memberships(q, r.user_id);
    const cards = await cardCoverage(q, r, now);
    let candidateIds: string[] | null = opts.blockIds ?? null;

    // Optional graph narrowing (Part 8.4 step 1). Postgres re-evaluates everything below regardless.
    if (!candidateIds && tg.enabled() && r.kind === 'connection') {
      const g = await tg.allowedBlocks(r.id, now, purpose).catch((e) => { log('warn', 'policy.graph_fallback', { err: String(e.message) }); inc('embargo_policy_graph_fallback_total', {}, 1, 'Policy evaluations that fell back from TigerGraph to Postgres'); return null; });
      if (g) candidateIds = g;
    }
    const wsIds = [...memberOf.keys()].filter((w) => !r.workspace_id || w === r.workspace_id || r.kind === 'user');
    // Candidates: own workspaces, blocks covered by a card, and blocks whose effective rule names the requester's
    // workspace as partner (Part 8.3 partner visibility).
    const partnerWs = r.workspace_id ?? '00000000-0000-0000-0000-000000000000';
    const blocks = await q.query(
      `SELECT id, workspace_id, owner_id, status, access_mode, storage_mode, pinned, current_version_id, kind, title, updated_at FROM blocks
       WHERE current_version_id IS NOT NULL AND ${candidateIds ? 'id = ANY($1::uuid[])' : `(workspace_id = ANY($2::uuid[]) OR id = ANY($1::uuid[]) OR id IN (
         SELECT ru.target_id FROM rules ru WHERE ru.target_type='block' AND ru.visibility='partner' AND ru.partner_workspace_id = $3::uuid
           AND ru.created_at = (SELECT MAX(r2.created_at) FROM rules r2 WHERE r2.target_type='block' AND r2.target_id = ru.target_id)))`}`,
      candidateIds ? [candidateIds] : [[...cards.keys()], wsIds, partnerWs]);
    const blockMap = new Map(blocks.map((b) => [b.id, b]));
    const rules = await latestRules(q, 'block', blocks.map((b) => b.id));
    const items: AllowedItem[] = [];
    const withheld: AllowedSet['withheld'] = [];
    const memberSet = new Set(memberOf.keys());
    const versionIds = blocks.map((b) => b.current_version_id);
    const sections = opts.includeSections === false ? [] : await q.query('SELECT id, block_version_id, kind FROM block_sections WHERE block_version_id = ANY($1::uuid[])', [versionIds]);
    const statements = await q.query('SELECT id, block_version_id, status, revoked_at FROM statements WHERE block_version_id = ANY($1::uuid[])', [versionIds]);
    const stmtRules = await latestRules(q, 'statement', statements.map((s) => s.id));
    const byVersion = new Map(blocks.map((b) => [b.current_version_id, b]));
    for (const s of sections) {
      const b = byVersion.get(s.block_version_id)!;
      const d = evaluate({ requester: r, channel, now, purpose, block: b, rule: rules.get(b.id) ?? null, memberOf: memberSet, viaCard: cards.has(b.id) });
      if (d.allow) items.push({ type: 'section', id: s.id, block_id: b.id, version_id: s.block_version_id, form: d.form, kind: s.kind });
      else withheld.push({ type: 'section', id: s.id, block_id: b.id, reason: d.reason });
    }
    for (const s of statements) {
      const b = byVersion.get(s.block_version_id)!;
      const d = evaluate({ requester: r, channel, now, purpose, block: b, rule: rules.get(b.id) ?? null, statement: s, statementRule: stmtRules.get(s.id) ?? null, memberOf: memberSet, viaCard: cards.has(b.id) });
      if (d.allow) items.push({ type: 'statement', id: s.id, block_id: b.id, version_id: s.block_version_id, form: d.form });
      else withheld.push({ type: 'statement', id: s.id, block_id: b.id, reason: d.reason });
    }
    return { items, blocks: blockMap, withheld, rules, memberOf };
  } catch (e: any) {
    if (e instanceof HttpError && e.status < 500) throw e;
    log('error', 'policy.fail_closed', { err: String(e.message) });
    inc('embargo_policy_fail_closed_total', {}, 1, 'Requests that failed closed because policy could not be evaluated');
    throw new HttpError(503, 'unavailable', 'Policy temporarily unavailable');
  }
}

/** Block-level decision (for read_block / web detail). */
export async function decideBlock(q: Queryable, r: Requester, channel: Channel, now: Date, blockId: string, purpose?: string | null) {
  const b = (await q.query('SELECT id, workspace_id, owner_id, status, access_mode, storage_mode, current_version_id FROM blocks WHERE id=$1', [blockId]))[0];
  if (!b) return { block: null, decision: { allow: false, reason: 'not_found' } as Decision };
  const memberOf = await memberships(q, r.user_id);
  const cards = await cardCoverage(q, r, now);
  const rule = (await latestRules(q, 'block', [blockId])).get(blockId) ?? null;
  return { block: b, rule, decision: evaluate({ requester: r, channel, now, purpose, block: b, rule, memberOf: new Set(memberOf.keys()), viaCard: cards.has(blockId) }) };
}
