/**
 * TigerGraph Savanna (Part 17.4): rights graph mirror. REST++ upserts + installed GSQL queries.
 * Optional: when TIGERGRAPH_HOST is unset, every caller falls back to the Postgres policy path.
 * Schema and queries: infra/tigergraph/schema.gsql (verify endpoints against Savanna docs, Part 26 #4).
 */
import { config } from '../config.ts';
import type { Queryable } from '../db/index.ts';
import { latestRules } from '../core/policy.ts';

const c = config.tigergraph;
export const enabled = () => !!(c.host && c.token);
const base = () => c.host.replace(/\/$/, '');

async function tgFetch(path: string, init: RequestInit = {}, timeoutMs = c.latencyBudgetMs) {
  const res = await fetch(`${base()}${path}`, {
    ...init, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`TigerGraph ${path} ${res.status}`);
  const j: any = await res.json();
  if (j.error) throw new Error(`TigerGraph error: ${j.message}`);
  return j;
}

export async function upsert(vertices: Record<string, Record<string, any>>, edges: Record<string, any>) {
  const v: any = {};
  for (const [type, items] of Object.entries(vertices)) {
    v[type] = {};
    for (const [id, attrs] of Object.entries(items)) v[type][id] = Object.fromEntries(Object.entries(attrs).map(([k, val]) => [k, { value: val ?? '' }]));
  }
  return tgFetch(`/restpp/graph/${c.graph}`, { method: 'POST', body: JSON.stringify({ vertices: v, edges }) }, 10000);
}
const edge = (fromType: string, from: string, e: string, toType: string, to: string, attrs: Record<string, any> = {}) =>
  ({ [fromType]: { [from]: { [e]: { [toType]: { [to]: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { value: v ?? '' }])) } } } } });
function mergeEdges(list: any[]) {
  const out: any = {};
  const deep = (a: any, b: any) => { for (const k of Object.keys(b)) a[k] = a[k] && typeof a[k] === 'object' && !('value' in a[k]) ? deep(a[k], b[k]) : b[k]; return a; };
  for (const e of list) deep(out, e);
  return out;
}
const ts = (d: any) => (d ? Math.floor(new Date(d).getTime() / 1000) : 0);

/** Graph-sync worker: mirror one entity from Postgres into TigerGraph. */
export async function syncEntity(q: Queryable, entity: string, id: string) {
  if (!enabled()) return;
  const V: Record<string, Record<string, any>> = {}; const E: any[] = [];
  const put = (t: string, vid: string, a: any) => ((V[t] ??= {})[vid] = a);
  if (entity === 'block') {
    const b = (await q.query('SELECT * FROM blocks WHERE id=$1', [id]))[0]; if (!b) return;
    put('Block', id, { status: b.status, access_mode: b.access_mode, storage_mode: b.storage_mode, owner_id: b.owner_id });
    E.push(edge('Block', id, 'OWNED_BY', 'Workspace', b.workspace_id));
    const r = (await latestRules(q, 'block', [id])).get(id);
    if (r) {
      put('Rule', r.id, { visibility: r.visibility, expires_at: ts(r.expires_at), embargo_until: ts(r.embargo_until), partner_workspace_id: r.partner_workspace_id ?? '', purposes: (r.purposes ?? []).join(',') });
      E.push(edge('Rule', r.id, 'GOVERNS', 'Block', id));
      for (const cid of r.allowed_connection_ids ?? []) E.push(edge('Rule', r.id, 'ALLOWS', 'Connection', cid));
    }
    if (b.current_version_id) {
      for (const s of await q.query('SELECT id FROM block_sections WHERE block_version_id=$1', [b.current_version_id])) { put('Section', s.id, {}); E.push(edge('Section', s.id, 'IN', 'Block', id)); }
      for (const s of await q.query('SELECT id, status, speaker_person_id FROM statements WHERE block_version_id=$1', [b.current_version_id])) {
        put('Statement', s.id, { status: s.status }); E.push(edge('Statement', s.id, 'IN', 'Block', id));
        if (s.speaker_person_id) E.push(edge('Person', s.speaker_person_id, 'SAID', 'Statement', s.id));
      }
    }
  } else if (entity === 'membership') {
    const [userId, ws] = id.split(':');
    const m = (await q.query('SELECT role FROM memberships WHERE user_id=$1 AND workspace_id=$2', [userId, ws]))[0];
    const p = (await q.query('SELECT id FROM persons WHERE user_id=$1 AND workspace_id=$2', [userId, ws]))[0];
    if (p) { put('Person', p.id, { user_id: userId }); E.push(edge('Person', p.id, 'MEMBER_OF', 'Workspace', ws, { role: m?.role ?? 'removed' })); }
  } else if (entity === 'connection') {
    const cn = (await q.query('SELECT * FROM connections WHERE id=$1', [id]))[0]; if (!cn) return;
    const p = (await q.query('SELECT id FROM persons WHERE user_id=$1 AND workspace_id=$2', [cn.user_id, cn.workspace_id]))[0];
    put('Connection', id, { revoked: !!cn.revoked_at });
    E.push(edge('Connection', id, 'IN', 'Workspace', cn.workspace_id));
    if (p) E.push(edge('Connection', id, 'OF', 'Person', p.id));
  } else if (entity === 'card') {
    const cd = (await q.query('SELECT * FROM cards WHERE id=$1', [id]))[0]; if (!cd) return;
    put('Card', id, { expires_at: ts(cd.expires_at), revoked: !!cd.revoked_at });
    for (const b of cd.block_ids ?? []) E.push(edge('Card', id, 'SHARES', 'Block', b));
    if (cd.recipient_workspace_id) E.push(edge('Card', id, 'TO', 'Workspace', cd.recipient_workspace_id));
  }
  await upsert(V, mergeEdges(E));
}

/**
 * Graph-sync worker (17.4): consumes `graph.sync` outbox events in id order from graph_sync_cursor, so a failed or
 * restarted sync resumes exactly where it stopped. Each entity is re-read from Postgres (authoritative) when synced.
 * No-op when TigerGraph is not configured.
 */
export async function syncFromCursor(q: Queryable, upTo?: number) {
  if (!enabled()) return 0;
  await q.query(`INSERT INTO graph_sync_cursor(id, last_outbox_id) VALUES ('tigergraph', 0) ON CONFLICT (id) DO NOTHING`);
  const lease = (await q.query(`UPDATE graph_sync_cursor SET locked_until = now() + interval '2 minutes' WHERE id='tigergraph' AND (locked_until IS NULL OR locked_until < now()) RETURNING last_outbox_id`))[0];
  if (!lease) throw new Error('graph sync in progress elsewhere'); // the queue retries with backoff
  let cursor = Number(lease.last_outbox_id), n = 0;
  try {
    for (;;) {
      const rows = await q.query(`SELECT id, payload FROM outbox WHERE topic='graph.sync' AND id > $1 ${upTo ? 'AND id <= $2' : ''} ORDER BY id LIMIT 200`, upTo ? [cursor, upTo] : [cursor]);
      if (!rows.length) break;
      const done = new Set<string>();
      for (const r of rows) {
        const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        const k = p?.entity && p?.id ? `${p.entity}:${p.id}` : null;
        if (k && !done.has(k)) { await syncEntity(q, p.entity, p.id); done.add(k); n++; }
        cursor = Number(r.id);
      }
      await q.query(`UPDATE graph_sync_cursor SET last_outbox_id=$1, locked_until = now() + interval '2 minutes' WHERE id='tigergraph'`, [cursor]);
    }
  } finally {
    await q.query(`UPDATE graph_sync_cursor SET last_outbox_id=$1, locked_until=NULL WHERE id='tigergraph'`, [cursor]);
  }
  return n;
}

/** Installed query allowed_items → candidate block ids (re-checked in Postgres by the caller). */
export async function allowedBlocks(connectionId: string, now: Date, purpose?: string | null): Promise<string[]> {
  const p = new URLSearchParams({ connection_id: connectionId, now: String(ts(now)), purpose: purpose ?? '' });
  const j = await tgFetch(`/restpp/query/${c.graph}/allowed_items?${p}`);
  const res = j.results?.[0] ?? {};
  return (res.block_ids ?? res.blocks ?? []).map((x: any) => (typeof x === 'string' ? x : x.v_id));
}
export async function whyWithheld(connectionId: string, itemId: string, now: Date) {
  const p = new URLSearchParams({ connection_id: connectionId, item_id: itemId, now: String(ts(now)) });
  return (await tgFetch(`/restpp/query/${c.graph}/why_withheld?${p}`)).results;
}
export async function exposure(personId: string) {
  return (await tgFetch(`/restpp/query/${c.graph}/exposure?person_id=${encodeURIComponent(personId)}`)).results;
}
