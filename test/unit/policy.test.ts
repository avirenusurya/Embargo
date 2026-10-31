/** Policy engine (Part 8.3): every rule branch, a randomized "no withheld item is ever served" property, and the Postgres loaders. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, teardown } from '../helpers/env.ts';

setupEnv();
const P = await import('../../src/core/policy.ts');
const { getDb } = await import('../../src/db/index.ts');
const { uuidv7, HttpError } = await import('../../src/util.ts');
const { mkUser, mkWorkspace, mkBlock, setRule, addMember } = await import('../helpers/fixtures.ts');
type EvalInput = import('../../src/core/policy.ts').EvalInput;
after(() => teardown());

// Database fixtures are created before any test is registered (the runner starts as soon as the module settles).
const db = await getDb();
const owner = await mkUser(db, 'Owner');
const member = await mkUser(db, 'Member');
const outsider = await mkUser(db, 'Outsider');
const wsA = await mkWorkspace(db, owner, 'A');
const wsB = await mkWorkspace(db, outsider, 'B');
await addMember(db, wsA, member, 'editor');
const conn = (ws: string, user: string, scopes = ['read']) => ({ kind: 'connection' as const, id: uuidv7(), workspace_id: ws, user_id: user, scopes });


const WS = 'ws-a', OTHER = 'ws-b', OWNER = 'u-owner';
const NOW = new Date('2026-06-01T12:00:00Z');
const H = 3600_000;
function input(o: Partial<EvalInput> & { mode?: string; status?: string; storage?: string } = {}): EvalInput {
  return {
    requester: { kind: 'connection', id: 'c1', workspace_id: WS, user_id: 'u-member', scopes: ['read'] },
    channel: 'mcp', now: NOW, purpose: null,
    block: { id: 'b1', workspace_id: WS, owner_id: OWNER, status: o.status ?? 'active', access_mode: o.mode ?? 'viewable', storage_mode: o.storage ?? 'standard' },
    rule: { visibility: 'team' }, statement: null, statementRule: null, memberOf: new Set([WS]), viaCard: false, ...o,
  };
}
const ev = (o: Parameters<typeof input>[0] = {}) => P.evaluate(input(o));
const W = (reason: string) => ({ allow: false, reason });

test('block status: revoked, archived and draft are withheld', () => {
  for (const s of ['revoked', 'archived', 'draft']) assert.deepEqual(ev({ status: s }), W('status'));
  assert.deepEqual(ev(), { allow: true, form: 'text' });
});

test('sealed blocks (client-side encrypted) are never served by the server', () => {
  assert.deepEqual(ev({ storage: 'sealed_block' }), W('sealed_block'));
});

test('statement status: blocked and held withheld; team_only only for members', () => {
  assert.deepEqual(ev({ statement: { id: 's', status: 'blocked' } }), W('blocked_by_speaker'));
  assert.deepEqual(ev({ statement: { id: 's', status: 'held' } }), W('awaiting_review'));
  assert.deepEqual(ev({ statement: { id: 's', status: 'allowed' } }), { allow: true, form: 'text' });
  assert.deepEqual(ev({ statement: { id: 's', status: 'team_only' } }), { allow: true, form: 'text' });
  assert.deepEqual(ev({ statement: { id: 's', status: 'team_only' }, memberOf: new Set(), viaCard: true }), W('team_only_statement'), 'card recipients do not get team-only lines');
});

test('expiry: withheld at and after expires_at', () => {
  assert.deepEqual(ev({ rule: { visibility: 'team', expires_at: new Date(NOW.getTime() + 1) } }), { allow: true, form: 'text' });
  assert.deepEqual(ev({ rule: { visibility: 'team', expires_at: NOW } }), W('expired'));
  assert.deepEqual(ev({ rule: { visibility: 'team', expires_at: new Date(NOW.getTime() - H).toISOString() } }), W('expired'));
});

test('embargo_until: withheld before, served at/after the unlock time', () => {
  assert.deepEqual(ev({ rule: { visibility: 'team', embargo_until: new Date(NOW.getTime() + H) } }), W('embargoed'));
  assert.deepEqual(ev({ rule: { visibility: 'team', embargo_until: NOW } }), { allow: true, form: 'text' });
  assert.deepEqual(ev({ rule: { visibility: 'team', embargo_until: new Date(NOW.getTime() - 1).toISOString() } }), { allow: true, form: 'text' });
});

test('statement rule overrides block timing (per-line embargo) but not block visibility', () => {
  const later = new Date(NOW.getTime() + H);
  assert.deepEqual(ev({ statement: { id: 's', status: 'allowed' }, statementRule: { embargo_until: later } }), W('embargoed'));
  assert.deepEqual(ev({ statement: { id: 's', status: 'allowed' }, statementRule: { expires_at: NOW } }), W('expired'));
  const merged = P.mergeRule({ visibility: 'private', purposes: ['a'] }, { visibility: 'public', purposes: [], allowed_connection_ids: ['x'] } as any);
  assert.equal(merged.visibility, 'private', 'statement rule cannot widen visibility');
  assert.deepEqual(merged.purposes, ['a'], 'empty statement list does not clear block list');
  assert.deepEqual(merged.allowed_connection_ids, ['x']);
  assert.deepEqual(P.mergeRule(null, null), { visibility: 'team' }, 'no rule → team default');
});

test('visibility private: only the block owner', () => {
  const rule = { visibility: 'private' as const };
  assert.deepEqual(ev({ rule }), W('private'));
  assert.deepEqual(ev({ rule, requester: { kind: 'user', id: OWNER, workspace_id: WS, user_id: OWNER, scopes: ['read'] } }), { allow: true, form: 'text' });
  assert.deepEqual(ev({ rule, viaCard: true }), W('private'), 'a card does not override private');
});

test('visibility team: members or card recipients only', () => {
  assert.deepEqual(ev({ memberOf: new Set([OTHER]) }), W('team_only'));
  assert.deepEqual(ev({ memberOf: new Set(), viaCard: true }), { allow: true, form: 'text' });
});

test('visibility partner: members, the named partner workspace, or a card', () => {
  const rule = { visibility: 'partner' as const, partner_workspace_id: OTHER };
  const outsider = { kind: 'connection' as const, id: 'c9', workspace_id: OTHER, user_id: 'u9', scopes: ['read'] };
  assert.deepEqual(ev({ rule, requester: outsider, memberOf: new Set([OTHER]) }), { allow: true, form: 'text' });
  assert.deepEqual(ev({ rule, requester: { ...outsider, workspace_id: 'ws-c' }, memberOf: new Set(['ws-c']) }), W('partner_only'));
  assert.deepEqual(ev({ rule: { visibility: 'partner', partner_workspace_id: null }, requester: outsider, memberOf: new Set([OTHER]) }), W('partner_only'), 'no partner named');
  assert.deepEqual(ev({ rule, requester: { ...outsider, workspace_id: 'ws-c' }, memberOf: new Set(), viaCard: true }), { allow: true, form: 'text' });
  assert.deepEqual(ev({ rule }), { allow: true, form: 'text' }, 'members still see partner blocks');
});

test('visibility public: anyone (still subject to status, timing and mode)', () => {
  assert.deepEqual(ev({ rule: { visibility: 'public' }, memberOf: new Set() }), { allow: true, form: 'text' });
  assert.deepEqual(ev({ rule: { visibility: 'public' }, memberOf: new Set(), status: 'revoked' }), W('status'));
});

test('allowed tools: only listed connections; users on the web are not tool-restricted', () => {
  const rule = { visibility: 'team' as const, allowed_connection_ids: ['c2'] };
  assert.deepEqual(ev({ rule }), W('tool_not_allowed'));
  assert.deepEqual(ev({ rule, requester: { kind: 'connection', id: 'c2', workspace_id: WS, user_id: 'u', scopes: ['read'] } }), { allow: true, form: 'text' });
  assert.deepEqual(ev({ rule, requester: { kind: 'user', id: 'u', workspace_id: WS, user_id: 'u', scopes: ['read'] }, channel: 'web' }), { allow: true, form: 'text' });
  assert.deepEqual(ev({ rule: { visibility: 'team', allowed_connection_ids: [] } }), { allow: true, form: 'text' }, 'empty list = no restriction');
});

test('purposes: must match one of the listed purposes', () => {
  const rule = { visibility: 'team' as const, purposes: ['support'] };
  assert.deepEqual(ev({ rule }), W('purpose_mismatch'));
  assert.deepEqual(ev({ rule, purpose: 'marketing' }), W('purpose_mismatch'));
  assert.deepEqual(ev({ rule, purpose: 'support' }), { allow: true, form: 'text' });
});

test('access modes × channels (Part 8.3 table)', () => {
  const table: [string, string, any][] = [
    ['viewable', 'mcp', { allow: true, form: 'text' }], ['viewable', 'web', { allow: true, form: 'text' }], ['viewable', 'action', { allow: true, form: 'text' }],
    ['agent_only', 'mcp', { allow: true, form: 'text' }], ['agent_only', 'web', { allow: true, form: 'hidden' }], ['agent_only', 'action', { allow: true, form: 'text' }],
    ['sealed_use', 'mcp', W('sealed_use_only')], ['sealed_use', 'web', W('sealed_use_only')], ['sealed_use', 'action', W('sealed_use_only')],
  ];
  for (const [mode, channel, want] of table) assert.deepEqual(ev({ mode, channel: channel as any }), want, `${mode}/${channel}`);
  const sealedReq = { kind: 'connection' as const, id: 'c1', workspace_id: WS, user_id: 'u', scopes: ['read', 'ask_sealed'] };
  assert.deepEqual(ev({ mode: 'sealed_use', channel: 'sealed', requester: sealedReq }), { allow: true, form: 'sealed_input' });
  assert.deepEqual(ev({ mode: 'sealed_use', channel: 'sealed' }), W('scope'), 'ask_sealed scope required');
  // Spec 8.3: viewable is ALLOW(text) whatever the channel; the sealed runtime only consumes form=sealed_input.
  assert.deepEqual(ev({ mode: 'viewable', channel: 'sealed', requester: sealedReq }), { allow: true, form: 'text' });
  assert.deepEqual(ev({ mode: 'weird' }), W('unknown_mode'), 'unknown modes fail closed');
});

test('revoked statements are withheld', () => {
  assert.deepEqual(ev({ statement: { id: 's', status: 'allowed', revoked_at: new Date().toISOString() } as any }), W('revoked'));
});

test('evaluation order: status beats everything, embargo beats visibility', () => {
  assert.deepEqual(ev({ status: 'revoked', statement: { id: 's', status: 'blocked' }, rule: { visibility: 'private', embargo_until: new Date(NOW.getTime() + H) } }), W('status'));
  assert.deepEqual(ev({ rule: { visibility: 'private', embargo_until: new Date(NOW.getTime() + H) } }), W('embargoed'));
});

// ---------- Property: random workspaces/rules/requests (Part 21.1) ----------
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
test('property: withheld conditions are never served, and sealed_use is never returned as text (5000 random cases)', () => {
  const r = rng(12345);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  for (let i = 0; i < 5000; i++) {
    const vis = pick(['private', 'team', 'partner', 'public'] as const);
    const ws = pick(['w1', 'w2', 'w3']);
    const reqWs = pick(['w1', 'w2', 'w3', null]);
    const user = pick(['u1', 'u2', 'u3']);
    const inp: EvalInput = {
      requester: { kind: pick(['connection', 'user', 'card_link'] as const), id: pick(['c1', 'c2']), workspace_id: reqWs, user_id: pick([user, null]), scopes: pick([['read'], ['read', 'ask_sealed']]) },
      channel: pick(['mcp', 'web', 'sealed', 'action'] as const), now: NOW, purpose: pick([null, 'a', 'b']),
      block: { id: 'b', workspace_id: ws, owner_id: pick(['u1', 'u2']), status: pick(['active', 'active', 'draft', 'archived', 'revoked']), access_mode: pick(['viewable', 'agent_only', 'sealed_use']), storage_mode: pick(['standard', 'standard', 'sealed_block']) },
      rule: pick([null, { visibility: vis, partner_workspace_id: pick([null, 'w2']), allowed_connection_ids: pick([null, ['c1']]), purposes: pick([null, ['a']]),
        expires_at: pick([null, new Date(NOW.getTime() - H), new Date(NOW.getTime() + H)]), embargo_until: pick([null, new Date(NOW.getTime() - H), new Date(NOW.getTime() + H)]) }]),
      statement: pick([null, { id: 's', status: pick(['allowed', 'held', 'team_only', 'blocked']) }]),
      statementRule: pick([null, { embargo_until: pick([null, new Date(NOW.getTime() + H)]) }]),
      memberOf: new Set(pick([[], ['w1'], ['w2'], ['w1', 'w2']])), viaCard: r() < 0.3,
    };
    const d = P.evaluate(inp);
    if (!d.allow) continue;
    const rule = P.mergeRule(inp.rule, inp.statementRule);
    const ctx = JSON.stringify(inp);
    assert.equal(inp.block.status, 'active', ctx);
    assert.equal(inp.block.storage_mode, 'standard', ctx);
    assert.ok(!['held', 'blocked'].includes(inp.statement?.status ?? ''), ctx);
    assert.ok(!rule.expires_at || NOW < new Date(rule.expires_at), 'expired never served ' + ctx);
    assert.ok(!rule.embargo_until || NOW >= new Date(rule.embargo_until), 'embargoed never served ' + ctx);
    if (rule.visibility === 'private') assert.equal(inp.requester.user_id, inp.block.owner_id, ctx);
    const member = inp.memberOf.has(inp.block.workspace_id);
    if (rule.visibility === 'team') assert.ok(member || inp.viaCard, ctx);
    if (inp.statement?.status === 'team_only') assert.ok(member, ctx);
    if (inp.block.access_mode === 'sealed_use') { assert.equal(d.form, 'sealed_input', ctx); assert.equal(inp.channel, 'sealed', ctx); }
    if (d.form === 'text') assert.notEqual(inp.block.access_mode, 'sealed_use', ctx);
    if (inp.channel === 'sealed') assert.ok(inp.requester.scopes.includes('ask_sealed'), ctx);
    if (d.form === 'sealed_input') { assert.equal(inp.channel, 'sealed', ctx); assert.equal(inp.block.access_mode, 'sealed_use', ctx); }
    if (inp.block.access_mode === 'agent_only' && inp.channel === 'web') assert.equal(d.form, 'hidden', ctx);
    if (rule.purposes?.length) assert.ok(rule.purposes.includes(inp.purpose as string), ctx);
    if (rule.allowed_connection_ids?.length && inp.requester.kind === 'connection') assert.ok(rule.allowed_connection_ids.includes(inp.requester.id), ctx);
  }
});

// ---------- Loaders against Postgres ----------
test('allowedItems: workspace isolation, private blocks, and withheld reasons', async () => {
  const team = await mkBlock(db, { ws: wsA, owner, title: 'Team doc', sections: [{ heading: 'A', text: 'team text' }] });
  const priv = await mkBlock(db, { ws: wsA, owner, title: 'Private doc', visibility: 'private', sections: [{ heading: 'A', text: 'private text' }] });
  const mine = await P.allowedItems(db, conn(wsA, member), 'mcp', new Date());
  const ids = new Set(mine.items.map((i) => i.block_id));
  assert.ok(ids.has(team.id));
  assert.ok(!ids.has(priv.id));
  assert.ok(mine.withheld.some((w) => w.block_id === priv.id && w.reason === 'private'));
  const own = await P.allowedItems(db, conn(wsA, owner), 'mcp', new Date());
  assert.ok(own.items.some((i) => i.block_id === priv.id), 'owner sees own private block');
  const other = await P.allowedItems(db, conn(wsB, outsider), 'mcp', new Date());
  assert.ok(!other.items.some((i) => i.block_id === team.id || i.block_id === priv.id), 'other workspace sees nothing of A');
  assert.ok(!other.withheld.some((w) => w.block_id === team.id), 'and is not even told about A blocks');
});

test('allowedItems: partner rule exposes the block to the named partner workspace only', async () => {
  const p = await mkBlock(db, { ws: wsA, owner, title: 'Partner brief', sections: [{ heading: 'A', text: 'partner text' }] });
  await setRule(db, wsA, p.id, { visibility: 'partner', partner_workspace_id: wsB });
  const b = await P.allowedItems(db, conn(wsB, outsider), 'mcp', new Date());
  assert.ok(b.items.some((i) => i.block_id === p.id));
  const third = await mkUser(db, 'Third');
  const wsC = await mkWorkspace(db, third, 'C');
  const c = await P.allowedItems(db, conn(wsC, third), 'mcp', new Date());
  assert.ok(!c.items.some((i) => i.block_id === p.id));
  // Later rule wins: tightening back to team removes partner access.
  await new Promise((r) => setTimeout(r, 5));
  await setRule(db, wsA, p.id, { visibility: 'team' });
  const b2 = await P.allowedItems(db, conn(wsB, outsider), 'mcp', new Date());
  assert.ok(!b2.items.some((i) => i.block_id === p.id), 'latest rule is effective');
});

test('allowedItems: cards grant access until revoked or expired; card-rule embargo respected', async () => {
  const blk = await mkBlock(db, { ws: wsA, owner, title: 'Shared doc', sections: [{ heading: 'A', text: 'shared text' }] });
  const cardId = uuidv7();
  await db.query(`INSERT INTO cards(id, source_workspace_id, recipient_type, recipient_workspace_id, block_ids, created_by) VALUES ($1,$2,'workspace',$3,$4,$5)`, [cardId, wsA, wsB, [blk.id], owner]);
  const has = async () => (await P.allowedItems(db, conn(wsB, outsider), 'mcp', new Date())).items.some((i) => i.block_id === blk.id);
  assert.equal(await has(), true);
  await db.query(`INSERT INTO rules(id, workspace_id, target_type, target_id, visibility, embargo_until) VALUES ($1,$2,'card',$3,'partner',$4)`, [uuidv7(), wsA, cardId, new Date(Date.now() + H)]);
  assert.equal(await has(), false, 'card embargo');
  await db.query(`INSERT INTO rules(id, workspace_id, target_type, target_id, visibility) VALUES ($1,$2,'card',$3,'partner')`, [uuidv7(), wsA, cardId]);
  assert.equal(await has(), true);
  await db.query('UPDATE cards SET expires_at=$2 WHERE id=$1', [cardId, new Date(Date.now() - 1000)]);
  assert.equal(await has(), false, 'expired card');
  await db.query('UPDATE cards SET expires_at=NULL, revoked_at=now() WHERE id=$1', [cardId]);
  assert.equal(await has(), false, 'revoked card');
});

test('allowedItems: held/blocked statements withheld, team_only hidden from card recipients', async () => {
  const c = await mkBlock(db, { ws: wsA, owner, title: 'Standup', statements: [
    { speaker_label: 'A', text: 'allowed line', status: 'allowed' }, { speaker_label: 'B', text: 'held line', status: 'held' },
    { speaker_label: 'C', text: 'blocked line', status: 'blocked' }, { speaker_label: 'D', text: 'team line', status: 'team_only' }] });
  const m = await P.allowedItems(db, conn(wsA, member), 'mcp', new Date());
  const got = new Set(m.items.filter((i) => i.type === 'statement' && i.block_id === c.id).map((i) => i.id));
  assert.deepEqual([...got].sort(), [c.statements[0].id, c.statements[3].id].sort());
  const reasons = m.withheld.filter((w) => w.block_id === c.id).map((w) => w.reason).sort();
  assert.deepEqual(reasons, ['awaiting_review', 'blocked_by_speaker']);
  await db.query(`INSERT INTO cards(id, source_workspace_id, recipient_type, recipient_workspace_id, block_ids, created_by) VALUES ($1,$2,'workspace',$3,$4,$5)`, [uuidv7(), wsA, wsB, [c.id], owner]);
  const b = await P.allowedItems(db, conn(wsB, outsider), 'mcp', new Date());
  assert.deepEqual(b.items.filter((i) => i.block_id === c.id).map((i) => i.id), [c.statements[0].id], 'card recipient gets only the allowed line');
});

test('allowedItems fails closed with 503 when the database errors', async () => {
  const broken = { query: async () => { throw new Error('connection reset'); } };
  await assert.rejects(P.allowedItems(broken as any, conn(wsA, member), 'mcp', new Date()), (e: any) => e instanceof HttpError && e.status === 503 && e.code === 'unavailable');
});

test('decideBlock: not_found for unknown ids, sealed_use_only over MCP', async () => {
  const s = await mkBlock(db, { ws: wsA, owner, title: 'Sealed', access_mode: 'sealed_use', sections: [{ heading: 'A', text: 'sealed text' }] });
  const d = await P.decideBlock(db, conn(wsA, member), 'mcp', new Date(), s.id);
  assert.deepEqual(d.decision, W('sealed_use_only'));
  const nf = await P.decideBlock(db, conn(wsA, member), 'mcp', new Date(), uuidv7());
  assert.equal(nf.block, null);
  assert.deepEqual(nf.decision, W('not_found'));
});
