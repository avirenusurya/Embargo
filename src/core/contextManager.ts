/**
 * AI Context Manager (Part 10). Detects update / contradiction / stale / duplicate / gap / rule / expiry /
 * onboarding / quality suggestions, puts them in the context inbox, and applies them on approval
 * (or auto-applies per workspace setting and confidence threshold).
 */
import * as chrono from 'chrono-node';
import { getDb, vec, parseVec, type Queryable } from '../db/index.ts';
import { KeyRing } from '../crypto/keys.ts';
import { sealJson, openJson } from './workspaceKeys.ts';
import { readVersion, readFacts, getBlock, renderStructured, createBlock, copyVersion } from './content.ts';
import { latestRules } from './policy.ts';
import { proposeUpdate, verifyContradiction, mergeBlocks, draftBlock, rewriteForQuality, topKeywords } from '../ai/tasks.ts';
import type { Structured } from '../ai/schemas.ts';
import { stashInput, type IngestPayload } from '../ingest/pipeline.ts';
import { githubToken, listRepoFiles } from '../ingest/github.ts';
import { enqueue, registerHandler } from '../jobs/queue.ts';
import { notifyAdmins, notify, inApp } from '../integrations/viasocket.ts';
import { cosine, uuidv7, sha256, log, HttpError } from '../util.ts';
import { nearestTaskCluster } from './compiler.ts';
import { config } from '../config.ts';
import * as tg from '../integrations/tigergraph.ts';
import { tracePrompts, currentPromptVersions } from '../ai/prompts.ts';

export type SuggestionType = 'update' | 'contradiction' | 'stale' | 'duplicate' | 'gap' | 'rule' | 'expiry' | 'onboarding' | 'quality';
export const SUGGESTION_TYPES: SuggestionType[] = ['update', 'contradiction', 'stale', 'duplicate', 'gap', 'rule', 'expiry', 'onboarding', 'quality'];

/** Workspace auto-apply threshold (settings.auto_apply_threshold, 0.5–1.0), default from config (0.85). */
export const autoApplyThreshold = (settings: any) => {
  const t = Number(settings?.auto_apply_threshold);
  return Number.isFinite(t) && t >= 0.5 && t <= 1 ? t : config.contextManager.autoApplyThreshold;
};

async function versionsOf(q: Queryable, blockIds: string[]) {
  const rows = await q.query('SELECT id, current_version_id FROM blocks WHERE id = ANY($1::uuid[])', [blockIds]);
  return Object.fromEntries(rows.map((r) => [r.id, r.current_version_id]));
}

export async function createSuggestion(q: Queryable, s: { ws: string; type: SuggestionType; targets: string[]; summary: string; payload: any; evidence?: any; confidence?: number; dedupeKey?: string }) {
  const dedupe = s.dedupeKey ?? `${s.type}:${s.targets.slice().sort().join(',')}`;
  const dup = (await q.query(`SELECT id FROM suggestions WHERE workspace_id=$1 AND dedupe_key=$2 AND status IN ('open','rejected') AND created_at > now() - interval '30 days'`, [s.ws, dedupe]))[0];
  if (dup) return null;
  const id = uuidv7();
  const sealed = await sealJson(q, s.ws, 'suggestion', 'suggestions', id, s.payload);
  const pv = currentPromptVersions();
  const evidence = { ...(s.evidence ?? {}), ...(pv ? { prompt_versions: pv } : {}) };
  await q.query(`INSERT INTO suggestions(id, workspace_id, type, target_block_ids, target_versions, summary, payload_ct, payload_nonce, data_key_id, evidence, confidence, dedupe_key)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, s.ws, s.type, s.targets, JSON.stringify(await versionsOf(q, s.targets)), s.summary.slice(0, 300), sealed.ct, sealed.nonce, sealed.keyId, JSON.stringify(evidence), s.confidence ?? 0.6, dedupe]);
  const settings = (await q.query('SELECT settings FROM workspaces WHERE id=$1', [s.ws]))[0]?.settings ?? {};
  if (settings.auto_apply?.[s.type] && (s.confidence ?? 0) >= autoApplyThreshold(settings)) {
    await enqueue(q, 'cm.auto_apply', { suggestion_id: id });
  } else {
    await notifyAdmins(q, s.ws, 'suggestion.created', 'suggestion', s.summary, `/app#inbox/${id}`, { type: s.type });
  }
  return id;
}

export async function readSuggestion(q: Queryable, id: string) {
  const s = (await q.query('SELECT * FROM suggestions WHERE id=$1', [id]))[0];
  if (!s) throw new HttpError(404, 'not_found');
  const payload = s.payload_ct ? await openJson(q, s.data_key_id, 'suggestions', s.id, s.payload_ct, s.payload_nonce) : null;
  return { ...s, payload_ct: undefined, payload_nonce: undefined, payload };
}

// ---------------- helpers ----------------
async function blockSourceText(q: Queryable, kr: KeyRing, versionId: string) {
  const v = await readVersion(q, kr, versionId);
  if (v.statements.length) return { v, text: v.statements.filter((s) => s.status === 'allowed' || s.status === 'team_only').map((s) => `${s.speaker_label}: ${s.text}`).join('\n') };
  return { v, text: renderStructured(v.structured) };
}
async function relatedBlocks(q: Queryable, ws: string, blockId: string, limit = 5, minSim = 0.45) {
  const e = (await q.query(`SELECT vector::text AS v FROM embeddings WHERE owner_type='block' AND owner_id=$1`, [blockId]))[0];
  if (!e) return [];
  return q.query(`SELECT b.id, b.title, b.kind, b.current_version_id, 1 - (e.vector <=> $3::vector) AS sim, e.vector::text AS v FROM embeddings e JOIN blocks b ON b.id = e.owner_id
     WHERE e.owner_type='block' AND e.workspace_id=$1 AND b.id <> $2 AND b.status IN ('active','draft') AND b.storage_mode='standard'
     ORDER BY e.vector <=> $3::vector LIMIT ${limit}`, [ws, blockId, e.v]).then((r) => r.filter((x) => Number(x.sim) >= minSim));
}

// ---------------- on change: update, contradiction, duplicate, rule ----------------
export async function onChange(p: { block_id: string; version_id: string; workspace_id: string }) {
  const q = await getDb();
  const ws = p.workspace_id;
  const block = await getBlock(q, p.block_id);
  if (block.status === 'revoked' || block.current_version_id !== p.version_id) return;
  // Supersede open suggestions whose target changed since they were created
  for (const s of await q.query(`SELECT id, target_versions FROM suggestions WHERE workspace_id=$1 AND status='open' AND $2 = ANY(target_block_ids)`, [ws, p.block_id])) {
    const tv = typeof s.target_versions === 'string' ? JSON.parse(s.target_versions) : s.target_versions;
    if (tv?.[p.block_id] && tv[p.block_id] !== p.version_id) await q.query(`UPDATE suggestions SET status='superseded', decided_at=now() WHERE id=$1`, [s.id]);
  }
  const ver = (await q.query('SELECT change_note FROM block_versions WHERE id=$1', [p.version_id]))[0];
  const fromSuggestion = String(ver?.change_note ?? '').startsWith('suggestion:');
  const kr = new KeyRing(q);
  try {
    const { v, text } = await blockSourceText(q, kr, p.version_id);
    // Low similarity floor is safe: proposeUpdate only proposes edits when facts actually changed.
    const related = await relatedBlocks(q, ws, p.block_id, 6, 0.15);

    // update: newer source vs related blocks
    if (!fromSuggestion && text.trim()) {
      for (const t of related.filter((x) => x.kind !== 'conversation').slice(0, 6)) {
        const tv = await readVersion(q, kr, t.current_version_id);
        const tf = await readFacts(q, kr, t.current_version_id);
        const prop = await proposeUpdate({ title: t.title, sections: tv.sections.filter((s) => s.kind === 'section' || s.kind === 'summary').map((s) => ({ id: s.id, heading: s.heading, text: s.text })), facts: tf }, { ...v.structured, facts: (await readFacts(q, kr, p.version_id)), text });
        if (prop.changes.length) await createSuggestion(q, { ws, type: 'update', targets: [t.id], summary: `"${block.title}" may change "${t.title}". Update it?`, payload: { ...prop, source_block_id: p.block_id, source_version_id: p.version_id }, evidence: { source_block_id: p.block_id, similarity: Number(t.sim) }, confidence: 0.7, dedupeKey: `update:${t.id}:${p.version_id}` });
      }
    }

    // contradiction: same (entity, attribute), different value_hash, in other active blocks' current versions
    const mine = await readFacts(q, kr, p.version_id);
    const stmtStatus = new Map(v.statements.map((s) => [s.id, s.status]));
    for (const f of mine) {
      if (f.statement_id && !['allowed', 'team_only'].includes(stmtStatus.get(f.statement_id) ?? '')) continue;
      const others = await q.query(`SELECT f.*, b.title, b.id AS bid, v.created_at AS vcreated FROM facts f JOIN blocks b ON b.current_version_id = f.block_version_id JOIN block_versions v ON v.id = f.block_version_id
         WHERE f.workspace_id=$1 AND f.entity=$2 AND f.attribute=$3 AND f.value_hash <> $4 AND b.id <> $5 AND b.status='active' LIMIT 5`, [ws, f.entity, f.attribute, f.value_hash, p.block_id]);
      for (const o of others) {
        const ov = await kr.decrypt(o.data_key_id, 'facts', o.id, o.value_ct, o.value_nonce);
        const ctxA = (o.section_id ? (await readVersion(q, kr, o.block_version_id, { sectionIds: new Set([o.section_id]) })).sections[0]?.text : ov) ?? ov;
        const ctxB = (f.section_id ? v.sections.find((s) => s.id === f.section_id)?.text : v.statements.find((s) => s.id === f.statement_id)?.text) ?? f.value;
        const verdict = await verifyContradiction({ text: ctxA, value: ov, when: new Date(o.vcreated).toISOString() }, { text: ctxB, value: f.value, when: new Date(v.createdAt).toISOString() }, `${f.entity} ${f.attribute}`);
        if (!verdict.conflict) continue;
        await createSuggestion(q, {
          ws, type: 'contradiction', targets: [o.bid, p.block_id], summary: `"${o.title}" and "${block.title}" disagree on ${f.entity} ${f.attribute}. Which is right?`,
          payload: { key: `${f.entity} ${f.attribute}`, a: { block_id: o.bid, title: o.title, fact_id: o.id, value: ov }, b: { block_id: p.block_id, title: block.title, fact_id: f.id, value: f.value }, explanation: verdict.explanation, preferred: verdict.preferred },
          evidence: { entity: f.entity, attribute: f.attribute }, confidence: 0.75, dedupeKey: `contradiction:${[o.value_hash, f.value_hash].sort().join(':')}:${f.entity}:${f.attribute}`,
        });
      }
    }

    // duplicate: block similarity > 0.90 and fact overlap > 70%
    const myKeys = new Set(mine.map((f) => `${f.entity}|${f.attribute}|${f.value_hash}`));
    for (const t of related.filter((x) => Number(x.sim) > 0.9 && x.kind === block.kind)) {
      const tf = await q.query('SELECT entity, attribute, value_hash FROM facts WHERE block_version_id=$1', [t.current_version_id]);
      const tk = new Set(tf.map((f) => `${f.entity}|${f.attribute}|${f.value_hash}`));
      const inter = [...myKeys].filter((k) => tk.has(k)).length;
      const union = new Set([...myKeys, ...tk]).size;
      const overlap = union ? inter / union : Number(t.sim) > 0.95 ? 1 : 0;
      if (overlap <= 0.7) continue;
      const tv = await readVersion(q, kr, t.current_version_id);
      const merged = await mergeBlocks(tv.structured, v.structured);
      await createSuggestion(q, { ws, type: 'duplicate', targets: [t.id, p.block_id], summary: `"${t.title}" and "${block.title}" look like duplicates. Merge them?`, payload: { keep: t.id, archive: p.block_id, merged }, evidence: { similarity: Number(t.sim), fact_overlap: overlap }, confidence: 0.7 });
    }

    // rule: high-severity content in a permissively-ruled block
    const rule = (await latestRules(q, 'block', [p.block_id])).get(p.block_id);
    const high = v.sections.filter((s) => s.flags.some((f) => f.endsWith(':high')));
    if (high.length && block.access_mode === 'viewable' && block.kind !== 'conversation') {
      const cats = [...new Set(high.flatMap((s) => s.flags.filter((f) => f.endsWith(':high')).map((f) => f.split(':')[0])))];
      const proposal = ['public', 'partner'].includes(rule?.visibility ?? 'team') ? { visibility: 'team' } : { access_mode: 'sealed_use' };
      await createSuggestion(q, { ws, type: 'rule', targets: [p.block_id], summary: `"${block.title}" contains ${cats.join(', ').replace(/_/g, ' ')} content with permissive rules. Restrict it?`, payload: proposal, evidence: { categories: cats, sections: high.length }, confidence: 0.8, dedupeKey: `rule:${p.block_id}:${p.version_id}` });
    }
  } finally { kr.wipe(); }
}

// ---------------- daily: stale, gap, expiry, cluster recompute ----------------
export async function daily(wsFilter?: string) {
  const q = await getDb();
  const wss = wsFilter ? [{ id: wsFilter }] : await q.query('SELECT id FROM workspaces WHERE deleted_at IS NULL');
  for (const { id: ws } of wss) {
    await staleRepo(q, ws).catch((e) => log('warn', 'cm.stale_repo', { ws, err: e.message }));
    await staleGeneric(q, ws);
    await gaps(q, ws);
    await expiries(q, ws);
    await recomputeClusters(q, ws);
  }
}

export async function staleRepo(q: Queryable, ws: string, onlyRepo?: string) {
  const blocks = await q.query(`SELECT id, title, source_ref FROM blocks WHERE workspace_id=$1 AND status='active' AND source_ref->>'type'='github' ${onlyRepo ? `AND source_ref->>'repo'=$2` : ''}`, onlyRepo ? [ws, onlyRepo] : [ws]);
  if (!blocks.length) return;
  const token = await githubToken(q, ws);
  const byRepo = new Map<string, any[]>();
  for (const b of blocks) { const sr = typeof b.source_ref === 'string' ? JSON.parse(b.source_ref) : b.source_ref; byRepo.set(`${sr.repo}@${sr.ref ?? 'HEAD'}`, [...(byRepo.get(`${sr.repo}@${sr.ref ?? 'HEAD'}`) ?? []), { ...b, sr }]); }
  for (const [key, list] of byRepo) {
    const [repo, ref] = key.split('@');
    const { commit, files } = await listRepoFiles(token, repo, ref, list.map((b) => b.sr.path));
    for (const b of list) {
      const f = files.find((x) => x.path === b.sr.path);
      if (!f) await createSuggestion(q, { ws, type: 'stale', targets: [b.id], summary: `"${b.title}" was deleted from ${repo}. Archive it?`, payload: { action: 'archive' }, evidence: { reason: 'source_deleted', commit }, confidence: 0.85, dedupeKey: `stale:${b.id}:deleted` });
      else if (f.sha !== b.sr.content_sha) await createSuggestion(q, { ws, type: 'stale', targets: [b.id], summary: `"${b.title}" no longer matches the repo. Refresh?`, payload: { action: 'refresh', commit, content_sha: f.sha }, evidence: { reason: 'source_changed', old_sha: b.sr.content_sha, new_sha: f.sha }, confidence: 0.9, dedupeKey: `stale:${b.id}:${f.sha}` });
    }
  }
}

async function staleGeneric(q: Queryable, ws: string) {
  // (b) no edits for 30 days while related blocks changed in the last 7 days
  const old = await q.query(`SELECT id, title FROM blocks WHERE workspace_id=$1 AND status='active' AND kind NOT IN ('conversation','repo') AND updated_at < now() - interval '30 days' LIMIT 100`, [ws]);
  for (const b of old) {
    const rel = await relatedBlocks(q, ws, b.id, 5, 0.6);
    const changed = rel.length ? (await q.query(`SELECT COUNT(*)::int AS n FROM blocks WHERE id = ANY($1::uuid[]) AND updated_at > now() - interval '7 days'`, [rel.map((r) => r.id)]))[0].n : 0;
    if (changed > 0) await createSuggestion(q, { ws, type: 'stale', targets: [b.id], summary: `"${b.title}" hasn't been updated in 30+ days while related blocks changed. Review or archive?`, payload: { action: 'review' }, evidence: { related_changed: changed }, confidence: 0.55, dedupeKey: `stale:${b.id}:aging` });
  }
  // (c) frequently served but usually ignored
  for (const b of await servedIgnored(q, ws, 14, 10, 0.6)) await createSuggestion(q, { ws, type: 'stale', targets: [b.id], summary: `"${b.title}" is served often but agents usually ignore it. Refresh or archive?`, payload: { action: 'review' }, evidence: b, confidence: 0.55, dedupeKey: `stale:${b.id}:ignored` });
}

async function servedIgnored(q: Queryable, ws: string, days: number, minServed: number, minIgnore: number) {
  const served = await q.query(`SELECT bid AS id, COUNT(*)::int AS served FROM (SELECT unnest(block_ids) AS bid FROM access_logs WHERE workspace_id=$1 AND channel='mcp' AND created_at > now() - ($2 || ' days')::interval) t GROUP BY bid HAVING COUNT(*) >= $3`, [ws, String(days), minServed]);
  const out = [];
  for (const s of served) {
    const rep = await q.query(`SELECT r.used_ids, r.ignored_ids, l.decision FROM context_use_reports r JOIN access_logs l ON l.id = r.access_log_id WHERE l.workspace_id=$1 AND $2 = ANY(l.block_ids) AND r.created_at > now() - ($3 || ' days')::interval`, [ws, s.id, String(days)]);
    let used = 0, ignored = 0;
    for (const r of rep) {
      const d = typeof r.decision === 'string' ? JSON.parse(r.decision) : r.decision;
      const ids = new Set((d?.items ?? []).filter((i: any) => i.block_id === s.id).flatMap((i: any) => [i.id, ...(i.ids ?? [])]));
      if ((r.used_ids ?? []).some((x: string) => ids.has(x))) used++; else if ((r.ignored_ids ?? []).some((x: string) => ids.has(x))) ignored++;
    }
    const b = (await q.query('SELECT title FROM blocks WHERE id=$1', [s.id]))[0];
    if (used + ignored > 0 && ignored / (used + ignored) >= minIgnore) out.push({ id: s.id, title: b?.title, served: s.served, ignore_rate: ignored / (used + ignored) });
  }
  return out;
}

export async function gaps(q: Queryable, ws: string) {
  const rows = await q.query(`SELECT id, vector::text AS v, query_ct, query_nonce, data_key_id FROM query_log_embeddings WHERE workspace_id=$1 AND max_score < 0.45 AND created_at > now() - interval '14 days' ORDER BY created_at DESC LIMIT 500`, [ws]);
  const clusters: { centroid: number[]; members: any[] }[] = [];
  for (const r of rows) {
    const v = parseVec(r.v);
    const c = clusters.find((c) => cosine(c.centroid, v) >= 0.75);
    if (c) { c.members.push(r); c.centroid = c.centroid.map((x, i) => (x * (c.members.length - 1) + v[i]) / c.members.length); } else clusters.push({ centroid: v, members: [r] });
  }
  const kr = new KeyRing(q);
  try {
    for (const c of clusters.filter((c) => c.members.length >= 5)) {
      const queries = [];
      for (const m of c.members.slice(0, 15)) if (m.query_ct) queries.push(await kr.decrypt(m.data_key_id, 'query_log_embeddings', m.id, m.query_ct, m.query_nonce));
      const near = await q.query(`SELECT b.id, b.current_version_id FROM embeddings e JOIN blocks b ON b.id=e.owner_id WHERE e.owner_type='block' AND e.workspace_id=$1 AND b.status='active' AND b.access_mode='viewable' AND b.kind <> 'conversation' ORDER BY e.vector <=> $2::vector LIMIT 3`, [ws, vec(c.centroid)]);
      const related = [];
      for (const n of near) related.push(renderStructured((await readVersion(q, kr, n.current_version_id)).structured).slice(0, 6000));
      const draft = await draftBlock(queries, related);
      const label = topKeywords(queries.join(' '), 3).join(' ');
      await createSuggestion(q, { ws, type: 'gap', targets: [], summary: `Agents asked about "${label}" ${c.members.length} times; no block covers it. Draft one?`, payload: { draft, query_count: c.members.length }, evidence: { queries: c.members.length }, confidence: 0.6, dedupeKey: `gap:${label}` });
    }
  } finally { kr.wipe(); }
}

const TIME_BOUND = /\b(campaign|event|launch|sale|offer|promo|webinar|hackathon|conference|this week|this month|next week|deadline|q[1-4]\s?\d{2,4})\b/i;
async function expiries(q: Queryable, ws: string) {
  const blocks = await q.query(`SELECT id, title, current_version_id FROM blocks WHERE workspace_id=$1 AND status='active' AND kind <> 'conversation' AND storage_mode='standard' LIMIT 300`, [ws]);
  const rules = await latestRules(q, 'block', blocks.map((b) => b.id));
  const kr = new KeyRing(q);
  const now = new Date();
  try {
    for (const b of blocks) {
      if (rules.get(b.id)?.expires_at) continue;
      const text = renderStructured((await readVersion(q, kr, b.current_version_id)).structured);
      const dates = chrono.parse(text, now).map((d) => d.start.date()).filter((d) => d.getFullYear() > 2000);
      const latest = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
      const allPast = latest && latest.getTime() < now.getTime() - 86400000;
      if (allPast && TIME_BOUND.test(text)) await createSuggestion(q, { ws, type: 'expiry', targets: [b.id], summary: `"${b.title}" refers to dates that have passed. Archive it?`, payload: { action: 'archive' }, evidence: { latest_date: latest!.toISOString() }, confidence: 0.6, dedupeKey: `expiry:${b.id}` });
      else if (latest && latest > now && TIME_BOUND.test(text)) await createSuggestion(q, { ws, type: 'expiry', targets: [b.id], summary: `"${b.title}" is time-bound (${latest.toDateString()}). Set an expiry?`, payload: { action: 'set_expiry', expires_at: new Date(latest.getTime() + 7 * 86400000).toISOString() }, evidence: { latest_date: latest.toISOString() }, confidence: 0.6, dedupeKey: `expiry:${b.id}` });
    }
  } finally { kr.wipe(); }
}

/**
 * Nightly k-means over the last 30 days of query embeddings. The new clusters REPLACE the old ones; learned priors and
 * log references are carried over to the nearest new cluster so learning isn't lost.
 */
export async function recomputeClusters(q: Queryable, ws: string) {
  const rows = await q.query(`SELECT id, access_log_id, vector::text AS v FROM query_log_embeddings WHERE workspace_id=$1 AND created_at > now() - interval '30 days' ORDER BY created_at DESC LIMIT 3000`, [ws]);
  if (rows.length < 4) return { clusters: 0, queries: rows.length, stored: 0 };
  const X = rows.map((r) => parseVec(r.v));
  const k = Math.max(1, Math.min(50, Math.round(Math.sqrt(X.length / 2))));
  let C = X.filter((_, i) => i % Math.ceil(X.length / k) === 0).slice(0, k);
  let assign: number[] = [];
  const nearest = (x: number[], cs: number[][]) => { let bi = 0, bs = -2; cs.forEach((c, i) => { const s = cosine(c, x); if (s > bs) { bs = s; bi = i; } }); return bi; };
  for (let it = 0; it < 10; it++) {
    const sums = C.map(() => new Array(X[0].length).fill(0)); const n = C.map(() => 0);
    assign = X.map((x) => nearest(x, C));
    X.forEach((x, xi) => { const bi = assign[xi]; n[bi]++; x.forEach((v, j) => (sums[bi][j] += v)); });
    C = sums.map((s, i) => (n[i] ? s.map((v) => v / n[i]) : C[i]));
  }
  assign = X.map((x) => nearest(x, C));
  const sizes = C.map((_, i) => assign.filter((a) => a === i).length);
  const live = C.map((c, i) => ({ c, size: sizes[i], i })).filter((x) => x.size > 0);
  await (await getDb()).tx(async (t) => {
    const old = await t.query('SELECT id, centroid::text AS c FROM task_clusters WHERE workspace_id=$1', [ws]);
    const ids = live.map(() => uuidv7());
    for (const [j, x] of live.entries()) await t.query('INSERT INTO task_clusters(id, workspace_id, centroid, size, label) VALUES ($1,$2,$3::vector,$4,$5)', [ids[j], ws, vec(x.c), x.size, null]);
    const map = new Map<string, string>();
    for (const o of old) map.set(o.id, ids[nearest(parseVec(o.c), live.map((x) => x.c))]);
    // Carry learned priors: sum evidence (alpha-1, beta-1) of old clusters into their nearest new cluster.
    const priors = await t.query('SELECT block_id, task_cluster_id, alpha, beta FROM usage_priors WHERE workspace_id=$1', [ws]);
    await t.query('DELETE FROM usage_priors WHERE workspace_id=$1', [ws]);
    const merged = new Map<string, { block: string; cluster: string; a: number; b: number }>();
    for (const p of priors) {
      const cl = map.get(p.task_cluster_id); if (!cl) continue;
      const kk = `${p.block_id}:${cl}`; const m = merged.get(kk) ?? { block: p.block_id, cluster: cl, a: 1, b: 1 };
      m.a += Number(p.alpha) - 1; m.b += Number(p.beta) - 1; merged.set(kk, m);
    }
    for (const m of merged.values()) await t.query('INSERT INTO usage_priors(workspace_id, block_id, task_cluster_id, alpha, beta) VALUES ($1,$2,$3,$4,$5)', [ws, m.block, m.cluster, m.a, m.b]);
    // Re-point recent queries and logs at their new cluster.
    for (const [xi, r] of rows.entries()) {
      const cl = ids[live.findIndex((x) => x.i === assign[xi])];
      await t.query('UPDATE query_log_embeddings SET task_cluster_id=$2 WHERE id=$1', [r.id, cl]);
      await t.query('UPDATE access_logs SET task_cluster_id=$2 WHERE id=$1', [r.access_log_id, cl]);
    }
    for (const [from, to] of map) await t.query('UPDATE access_logs SET task_cluster_id=$3 WHERE workspace_id=$1 AND task_cluster_id=$2', [ws, from, to]);
    if (old.length) await t.query('DELETE FROM task_clusters WHERE id = ANY($1::uuid[])', [old.map((o) => o.id)]);
  });
  const stored = Number((await q.query('SELECT COUNT(*)::int AS n FROM task_clusters WHERE workspace_id=$1', [ws]))[0].n);
  return { clusters: live.length, queries: rows.length, stored };
}

// ---------------- weekly: quality + digest ----------------
export async function weekly(wsFilter?: string) {
  const q = await getDb();
  for (const { id: ws } of wsFilter ? [{ id: wsFilter }] : await q.query('SELECT id FROM workspaces WHERE deleted_at IS NULL')) {
    const kr = new KeyRing(q);
    try {
      for (const b of await servedIgnored(q, ws, 7, 10, 0.5)) {
        const blk = (await q.query('SELECT current_version_id, kind FROM blocks WHERE id=$1', [b.id]))[0];
        if (!blk || blk.kind === 'conversation') continue;
        const v = await readVersion(q, kr, blk.current_version_id);
        const rewrite = await rewriteForQuality(v.structured, []);
        await createSuggestion(q, { ws, type: 'quality', targets: [b.id], summary: `"${b.title}" is served often but ignored ${Math.round(b.ignore_rate * 100)}% of the time. Rewrite it?`, payload: { structured: rewrite }, evidence: b, confidence: 0.55, dedupeKey: `quality:${b.id}:${blk.current_version_id}` });
      }
    } finally { kr.wipe(); }
    await sendDigest(q, ws);
  }
}

// ---------------- digest (F12 / N1) ----------------
/** Changes, contradictions, revokes and shares since the last digest. Hints and counts only, never content. */
export async function buildDigest(q: Queryable, ws: string) {
  const last = (await q.query('SELECT period_end FROM digest_runs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1', [ws]))[0];
  const since = last ? new Date(last.period_end) : new Date(Date.now() - 7 * 86400000);
  const until = new Date();
  const p = [ws, since, until];
  const changed = await q.query(`SELECT b.id, b.title, COUNT(*)::int AS versions FROM block_versions v JOIN blocks b ON b.id=v.block_id
     WHERE b.workspace_id=$1 AND v.created_at > $2 AND v.created_at <= $3 AND b.status <> 'revoked' GROUP BY b.id, b.title ORDER BY MAX(v.created_at) DESC`, p);
  const c = (await q.query(`SELECT
      (SELECT COUNT(*)::int FROM blocks WHERE workspace_id=$1 AND created_at > $2 AND created_at <= $3) AS new_blocks,
      (SELECT COUNT(*)::int FROM suggestions WHERE workspace_id=$1 AND type='contradiction' AND created_at > $2 AND created_at <= $3) AS new_contradictions,
      (SELECT COUNT(*)::int FROM suggestions WHERE workspace_id=$1 AND type='contradiction' AND status='open') AS open_contradictions,
      (SELECT COUNT(*)::int FROM suggestions WHERE workspace_id=$1 AND status='open') AS open_suggestions,
      (SELECT COUNT(*)::int FROM records WHERE workspace_id=$1 AND event='revoke' AND subject_ref->>'type'='block' AND created_at > $2 AND created_at <= $3) AS blocks_revoked,
      (SELECT COUNT(*)::int FROM records WHERE workspace_id=$1 AND event='revoke' AND subject_ref->>'type'='statement' AND created_at > $2 AND created_at <= $3) AS statements_revoked,
      (SELECT COUNT(*)::int FROM cards WHERE source_workspace_id=$1 AND revoked_at > $2 AND revoked_at <= $3) AS cards_revoked,
      (SELECT COUNT(*)::int FROM cards WHERE source_workspace_id=$1 AND created_at > $2 AND created_at <= $3) AS shares,
      (SELECT COUNT(*)::int FROM cards WHERE source_workspace_id=$1 AND recipient_type <> 'user' AND created_at > $2 AND created_at <= $3) AS cross_org_shares,
      (SELECT COUNT(*)::int FROM records WHERE workspace_id=$1 AND event IN ('consent','consent_withdraw') AND created_at > $2 AND created_at <= $3) AS consent_decisions,
      (SELECT COUNT(*)::int FROM held_actions WHERE workspace_id=$1 AND status='held') AS held_actions,
      (SELECT COUNT(*)::int FROM access_logs WHERE workspace_id=$1 AND created_at > $2 AND created_at <= $3) AS requests,
      (SELECT COALESCE(SUM(tokens_served),0)::int FROM access_logs WHERE workspace_id=$1 AND created_at > $2 AND created_at <= $3) AS tokens_served,
      (SELECT COALESCE(SUM(tokens_saved),0)::int FROM access_logs WHERE workspace_id=$1 AND created_at > $2 AND created_at <= $3) AS tokens_saved,
      (SELECT COUNT(*)::int FROM blocks WHERE workspace_id=$1 AND status='active') AS active_blocks`, p))[0];
  return {
    period_start: since.toISOString(), period_end: until.toISOString(),
    changes: { blocks_changed: changed.length, new_blocks: c.new_blocks, titles: changed.slice(0, 10).map((x) => x.title) },
    contradictions: { new: c.new_contradictions, open: c.open_contradictions },
    revokes: { blocks: c.blocks_revoked, statements: c.statements_revoked, cards: c.cards_revoked },
    shares: { cards: c.shares, cross_org: c.cross_org_shares },
    consent_decisions: c.consent_decisions, open_suggestions: c.open_suggestions, held_actions: c.held_actions,
    usage: { requests: c.requests, tokens_served: c.tokens_served, tokens_saved: c.tokens_saved, active_blocks: c.active_blocks },
  };
}

export async function sendDigest(q: Queryable, ws: string) {
  const d = await buildDigest(q, ws);
  const hint = `Weekly digest: ${d.changes.blocks_changed} block(s) changed, ${d.contradictions.new} new contradiction(s), ${d.revokes.blocks + d.revokes.statements + d.revokes.cards} revoke(s), ${d.shares.cards} share(s)`;
  for (const a of await q.query(`SELECT user_id FROM memberships WHERE workspace_id=$1 AND role IN ('owner','context_admin')`, [ws])) await inApp(q, ws, a.user_id, 'digest', hint, '/app#activity');
  const r = await notify(q, ws, 'digest.weekly', { stats: d, summary_hint: hint, link: `${config.appUrl}/app#activity` }).catch((e) => { log('warn', 'digest.notify_failed', { err: e.message }); return { delivered: false }; });
  await q.query('INSERT INTO digest_runs(id, workspace_id, period_start, period_end, stats, delivered) VALUES ($1,$2,$3,$4,$5,$6)', [uuidv7(), ws, d.period_start, d.period_end, JSON.stringify(d), r.delivered]);
  return { ...d, delivered: r.delivered };
}

// ---------------- reminders (Part 20: reviewer unresponsive; inbox backlog) ----------------
export async function inboxReminders(q: Queryable) {
  const hours = String(config.contextManager.reminderAfterHours);
  for (const w of await q.query(`SELECT workspace_id, COUNT(*)::int AS n FROM suggestions WHERE status='open' AND created_at < now() - ($1 || ' hours')::interval GROUP BY workspace_id`, [hours])) {
    const held = (await q.query(`SELECT COUNT(*)::int AS n FROM held_actions WHERE workspace_id=$1 AND status='held'`, [w.workspace_id]))[0].n;
    await notifyAdmins(q, w.workspace_id, 'suggestion.created', 'reminder', `${w.n} context inbox item(s) have waited more than ${hours}h${held ? `; ${held} held agent action(s) need a decision` : ''}`, '/app#inbox', { reminder: true });
  }
}

// ---------------- onboarding ----------------
export async function onboarding(p: { workspace_id: string; user_id: string; role: string }) {
  const q = await getDb();
  const top = await q.query(`SELECT bid AS id, COUNT(*)::int AS n FROM (SELECT unnest(l.block_ids) AS bid FROM access_logs l JOIN memberships m ON m.user_id = l.user_id AND m.workspace_id = l.workspace_id
      WHERE l.workspace_id=$1 AND m.role=$2 AND l.user_id <> $3 AND l.created_at > now() - interval '60 days') t JOIN blocks b ON b.id = t.bid AND b.status='active' GROUP BY bid ORDER BY n DESC LIMIT 10`, [p.workspace_id, p.role, p.user_id]);
  const pinned = await q.query(`SELECT id FROM blocks WHERE workspace_id=$1 AND pinned AND status='active'`, [p.workspace_id]);
  const ids = [...new Set([...pinned.map((x) => x.id), ...top.map((x) => x.id)])];
  if (!ids.length) return;
  const u = (await q.query('SELECT display_name FROM users WHERE id=$1', [p.user_id]))[0];
  await createSuggestion(q, { ws: p.workspace_id, type: 'onboarding', targets: ids, summary: `${u?.display_name ?? 'A new member'} joined as ${p.role}. Share a starter pack of ${ids.length} blocks?`, payload: { user_id: p.user_id, block_ids: ids, collection_name: `Starter pack: ${u?.display_name ?? 'new member'}` }, confidence: 0.7, dedupeKey: `onboarding:${p.user_id}` });
}

// ---------------- apply ----------------
async function applyStructured(q: Queryable, blockId: string, ws: string, userId: string | null, structured: Structured, note: string) {
  const st = await stashInput(q, ws, JSON.stringify(structured));
  await enqueue(q, 'ingest.run', { block_id: blockId, workspace_id: ws, user_id: userId, change_note: note, source: { type: 'structured', ...st, title: structured.title } } satisfies IngestPayload);
}
function editStructured(v: Awaited<ReturnType<typeof readVersion>>, changes: { section_id?: string | null; op: string; heading?: string | null; new_text: string }[]): Structured {
  const s: Structured = JSON.parse(JSON.stringify(v.structured));
  const sectionRows = v.sections.filter((x) => x.kind === 'section');
  const removals = new Set<number>();
  for (const c of changes) {
    if (c.op === 'add') { s.sections.push({ heading: c.heading || 'Update', text: c.new_text }); continue; }
    if (c.section_id && v.sections.find((x) => x.id === c.section_id)?.kind === 'summary') { if (c.op === 'edit') s.summary = c.new_text; continue; }
    const idx = sectionRows.findIndex((x) => x.id === c.section_id);
    if (idx < 0) continue;
    if (c.op === 'edit') s.sections[idx] = { heading: c.heading || s.sections[idx].heading, text: c.new_text };
    if (c.op === 'remove') removals.add(idx);
  }
  s.sections = s.sections.filter((_, i) => !removals.has(i));
  return s;
}
const replaceValue = (s: Structured, from: string, to: string): Structured => {
  const r = (t: string) => t.split(from).join(to);
  return { ...s, summary: r(s.summary), sections: s.sections.map((x) => ({ heading: x.heading, text: r(x.text) })), decisions: s.decisions.map(r), facts: s.facts.map((f) => ({ ...f, value: f.value === from ? to : f.value })), open_questions: s.open_questions };
};

export async function approve(q: Queryable, id: string, userId: string | null, edited?: any, auto = false) {
  const s = await readSuggestion(q, id);
  if (s.status !== 'open') throw new HttpError(409, 'not_open', `Suggestion is ${s.status}`);
  const p = edited ? { ...s.payload, ...edited } : s.payload;
  const ws = s.workspace_id;
  const note = `suggestion:${id}`;
  const kr = new KeyRing(q);
  let result: any = {};
  try {
    switch (s.type as SuggestionType) {
      case 'update': case 'quality': {
        const b = await getBlock(q, s.target_block_ids[0]);
        const v = await readVersion(q, kr, b.current_version_id);
        const structured = s.type === 'quality' ? p.structured : (p.structured ?? editStructured(v, p.changes ?? []));
        await applyStructured(q, b.id, ws, userId, structured, note); break;
      }
      case 'contradiction': {
        const pref = p.preferred === 'a' || p.preferred === 'b' ? p.preferred : null;
        if (!pref) throw new HttpError(400, 'choose', 'Set preferred to "a" or "b"');
        const win = p[pref], lose = p[pref === 'a' ? 'b' : 'a'];
        const lb = await getBlock(q, lose.block_id);
        if (lb.kind !== 'conversation') {
          const v = await readVersion(q, kr, lb.current_version_id);
          await applyStructured(q, lb.id, ws, userId, replaceValue(v.structured, lose.value, win.value), note);
          result = { updated_block: lb.id };
        } else result = { note: 'Losing value is in a conversation; the conversation is left unchanged.' };
        break;
      }
      case 'duplicate': {
        await applyStructured(q, p.keep, ws, userId, p.merged, note);
        await q.query(`UPDATE blocks SET status='archived', updated_at=now() WHERE id=$1`, [p.archive]);
        result = { archived_version: (await copyVersion(q, p.archive, userId, note))?.versionNo ?? null };
        break;
      }
      case 'stale': case 'expiry': {
        const bid = s.target_block_ids[0];
        const action = p.action;
        if (action === 'archive') {
          await q.query(`UPDATE blocks SET status='archived', updated_at=now() WHERE id=$1`, [bid]);
          result = { version: (await copyVersion(q, bid, userId, note))?.versionNo ?? null };
        } else if (action === 'set_expiry') {
          await insertRule(q, ws, bid, userId, { expires_at: p.expires_at });
          result = { version: (await copyVersion(q, bid, userId, note))?.versionNo ?? null };
        } else if (action === 'refresh') {
          const b = await getBlock(q, bid);
          const sr = typeof b.source_ref === 'string' ? JSON.parse(b.source_ref) : b.source_ref;
          if (sr?.type !== 'github') throw new HttpError(400, 'not_refreshable');
          const nsr = { ...sr, commit: p.commit, content_sha: p.content_sha };
          await q.query('UPDATE blocks SET source_ref=$2 WHERE id=$1', [bid, JSON.stringify(nsr)]);
          await enqueue(q, 'ingest.run', { block_id: bid, workspace_id: ws, user_id: userId, change_note: note, source: { type: 'github_file', repo: sr.repo, path: sr.path, ref: p.commit, title: b.title } } satisfies IngestPayload);
        } else if (p.structured) await applyStructured(q, bid, ws, userId, p.structured, note);
        break;
      }
      case 'gap': {
        const owner = userId ?? (await q.query('SELECT owner_id FROM workspaces WHERE id=$1', [ws]))[0].owner_id;
        const bid = await createBlock(q, { workspaceId: ws, ownerId: owner, kind: 'note', title: p.draft.title, processing: 'queued' });
        const st = await stashInput(q, ws, JSON.stringify(p.draft));
        await enqueue(q, 'ingest.run', { block_id: bid, workspace_id: ws, user_id: userId, change_note: note, auto_publish: !!p.publish, source: { type: 'structured', ...st, title: p.draft.title } } satisfies IngestPayload);
        result = { block_id: bid }; break;
      }
      case 'rule': {
        const bid = s.target_block_ids[0];
        if (p.access_mode) await q.query('UPDATE blocks SET access_mode=$2, updated_at=now() WHERE id=$1', [bid, p.access_mode]);
        if (p.visibility) await insertRule(q, ws, bid, userId, { visibility: p.visibility });
        result = { version: (await copyVersion(q, bid, userId, note))?.versionNo ?? null };
        if (tg.enabled()) await enqueue(q, 'graph.sync', { entity: 'block', id: bid });
        break;
      }
      case 'onboarding': {
        const cid = uuidv7();
        await q.query('INSERT INTO collections(id, workspace_id, name) VALUES ($1,$2,$3)', [cid, ws, p.collection_name]);
        for (const b of p.block_ids) await q.query('INSERT INTO collection_blocks(collection_id, block_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [cid, b]);
        await q.query(`INSERT INTO cards(id, source_workspace_id, recipient_type, recipient_user_id, collection_id, scope, created_by) VALUES ($1,$2,'user',$3,$4,$5,$6)`, [uuidv7(), ws, p.user_id, cid, JSON.stringify({ onboarding: true }), userId ?? p.user_id]);
        await inApp(q, ws, p.user_id, 'onboarding', `You've been shared a starter pack of ${p.block_ids.length} blocks`, `/app#collections/${cid}`);
        result = { collection_id: cid }; break;
      }
    }
  } finally { kr.wipe(); }
  await q.query(`UPDATE suggestions SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [id, auto ? 'auto_applied' : 'approved', userId]);
  return { ok: true, ...result };
}

/** "Allow similar" (Part 20): bulk-approve open suggestions that propose the same kind of change. */
function similarityKey(s: any): string | null {
  const p = s.payload ?? {}, ev = typeof s.evidence === 'string' ? JSON.parse(s.evidence) : s.evidence ?? {};
  if (s.type === 'rule') return `rule:${p.visibility ?? ''}:${p.access_mode ?? ''}:${[...(ev.categories ?? [])].sort().join(',')}`;
  if (s.type === 'stale' || s.type === 'expiry') return p.action && p.action !== 'refresh' && p.action !== 'review' ? `${s.type}:${p.action}:${ev.reason ?? ''}` : null;
  return null;
}
export async function approveWithSimilar(q: Queryable, id: string, userId: string, edited?: any) {
  const s = await readSuggestion(q, id);
  const key = similarityKey(s);
  const first = await approve(q, id, userId, edited);
  let applied = 1;
  if (key) for (const r of await q.query(`SELECT id FROM suggestions WHERE workspace_id=$1 AND type=$2 AND status='open' AND id <> $3 ORDER BY created_at LIMIT 200`, [s.workspace_id, s.type, id])) {
    const o = await readSuggestion(q, r.id);
    if (similarityKey(o) !== key) continue;
    await approve(q, o.id, userId).then(() => applied++).catch((e) => log('warn', 'cm.similar_failed', { id: o.id, err: e.message }));
  }
  return { ...first, applied, similar_key: key };
}

export async function insertRule(q: Queryable, ws: string, blockId: string, userId: string | null, patch: Record<string, any>) {
  const cur = (await latestRules(q, 'block', [blockId])).get(blockId);
  const next = { visibility: cur?.visibility ?? 'team', partner_workspace_id: cur?.partner_workspace_id ?? null, allowed_connection_ids: cur?.allowed_connection_ids ?? null, purposes: cur?.purposes ?? null, expires_at: cur?.expires_at ?? null, embargo_until: cur?.embargo_until ?? null, answer_policy: cur?.answer_policy ?? 'facts_only', ...patch };
  const id = uuidv7();
  await q.query(`INSERT INTO rules(id, workspace_id, target_type, target_id, visibility, partner_workspace_id, allowed_connection_ids, purposes, expires_at, embargo_until, answer_policy, set_by) VALUES ($1,$2,'block',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, ws, blockId, next.visibility, next.partner_workspace_id, next.allowed_connection_ids, next.purposes, next.expires_at, next.embargo_until, next.answer_policy, userId]);
  return { id, ...next };
}

registerHandler('cm.on_change', (p) => tracePrompts(() => onChange(p)));
registerHandler('cm.daily', (p) => tracePrompts(async () => { await daily(p?.workspace_id); await inboxReminders(await getDb()); }));
registerHandler('cm.weekly', (p) => tracePrompts(async () => weekly(p?.workspace_id)));
registerHandler('cm.onboarding', onboarding);
registerHandler('cm.auto_apply', async (p) => { const q = await getDb(); await approve(q, p.suggestion_id, null, undefined, true); });
registerHandler('github.sync', async (p) => { const q = await getDb(); await staleRepo(q, p.workspace_id, p.repo); });
