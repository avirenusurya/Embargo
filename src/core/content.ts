/** Blocks, versions, sections, statements: write (encrypt) and read (decrypt). */
import type { Queryable } from '../db/index.ts';
import { createDataKey, KeyRing, factValueHash } from '../crypto/keys.ts';
import { countTokens } from '../ai/llm.ts';
import type { Structured } from '../ai/schemas.ts';
import { putObject } from '../storage.ts';
import { uuidv7, sha256, HttpError } from '../util.ts';

export type BlockKind = 'doc' | 'conversation' | 'repo' | 'url' | 'note' | 'agent';
export type AccessMode = 'viewable' | 'agent_only' | 'sealed_use';

export async function createBlock(q: Queryable, b: {
  workspaceId: string; ownerId: string; kind: BlockKind; title: string; accessMode?: AccessMode; storageMode?: 'standard' | 'sealed_block';
  sourceRef?: any; agentWritten?: boolean; status?: string; visibility?: string; processing?: string;
}) {
  const id = uuidv7();
  await q.query(`INSERT INTO blocks(id, workspace_id, owner_id, kind, title, status, access_mode, storage_mode, source_ref, agent_written, processing_state)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, b.workspaceId, b.ownerId, b.kind, b.title.slice(0, 200), b.status ?? 'draft', b.accessMode ?? 'viewable', b.storageMode ?? 'standard',
      b.sourceRef ? JSON.stringify(b.sourceRef) : null, !!b.agentWritten, b.processing ?? 'ready']);
  await q.query(`INSERT INTO rules(id, workspace_id, target_type, target_id, visibility, set_by) VALUES ($1,$2,'block',$3,$4,$5)`,
    [uuidv7(), b.workspaceId, id, b.visibility ?? (b.agentWritten ? 'private' : 'team'), b.ownerId]);
  return id;
}

export const renderFacts = (facts: Structured['facts']) => facts.map((f) => `- ${f.entity} ${f.attribute}: ${f.value}`).join('\n');
export function renderStructured(s: Structured) {
  return [s.title, s.summary, ...s.sections.map((x) => `${x.heading}\n${x.text}`), s.decisions.length ? 'Decisions\n' + s.decisions.map((d) => '- ' + d).join('\n') : '',
    s.facts.length ? 'Facts\n' + renderFacts(s.facts) : '', s.open_questions.length ? 'Open questions\n' + s.open_questions.map((d) => '- ' + d).join('\n') : ''].filter(Boolean).join('\n\n');
}

export type StatementIn = { speaker_label: string; speaker_person_id?: string | null; text: string; start_ms?: number | null; status?: string; flags?: string[]; flag_reasons?: string[] };

/** Writes a new encrypted version under a fresh DEK. Returns ids so enrichment can run. */
export async function writeVersion(q: Queryable, _kr: KeyRing, v: {
  blockId: string; workspaceId: string; structured: Structured; statements?: StatementIn[]; original?: Buffer; originalTokens?: number;
  createdBy?: string | null; changeNote?: string; sourceType?: string | null; promptVersions?: Record<string, string> | null;
}) {
  // Bind key access to the same connection/transaction as the writes (PGlite is single-connection).
  const kr = new KeyRing(q);
  try { return await writeVersionInner(q, kr, v); } finally { kr.wipe(); }
}
async function writeVersionInner(q: Queryable, kr: KeyRing, v: Parameters<typeof writeVersion>[2]) {
  const versionId = uuidv7();
  const dekId = await createDataKey(q, v.workspaceId);
  const prev = await q.query('SELECT COALESCE(MAX(version_no),0) AS n FROM block_versions WHERE block_id=$1', [v.blockId]);
  const versionNo = Number(prev[0].n) + 1;
  const rendered = renderStructured(v.structured) + (v.statements?.length ? '\n' + v.statements.map((s) => `${s.speaker_label}: ${s.text}`).join('\n') : '');
  const enc = await kr.encrypt(dekId, 'block_versions', versionId, JSON.stringify(v.structured));
  let objectKey: string | null = null;
  if (v.original) {
    objectKey = `ws/${v.workspaceId}/blocks/${v.blockId}/${versionId}.bin`;
    const o = await kr.encrypt(dekId, 'objects', objectKey, v.original);
    await putObject(objectKey, Buffer.concat([o.nonce, o.ct]));
  }
  const tokensCompressed = countTokens(rendered);
  await q.query(`INSERT INTO block_versions(id, block_id, version_no, structured_ct, structured_nonce, original_object_key, data_key_id, content_hash, tokens_original, tokens_compressed, created_by, change_note, source_type, prompt_versions)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [versionId, v.blockId, versionNo, enc.ct, enc.nonce, objectKey, dekId, sha256(rendered), v.originalTokens ?? tokensCompressed, tokensCompressed, v.createdBy ?? null, v.changeNote ?? null,
      v.sourceType ?? null, v.promptVersions ? JSON.stringify(v.promptVersions) : null]);

  const sections: { id: string; kind: string; heading: string; text: string }[] = [];
  const s = v.structured;
  if (s.summary) sections.push({ id: uuidv7(), kind: 'summary', heading: 'Summary', text: s.summary });
  for (const x of s.sections) sections.push({ id: uuidv7(), kind: 'section', heading: x.heading, text: x.text });
  if (s.decisions.length) sections.push({ id: uuidv7(), kind: 'decisions', heading: 'Decisions', text: s.decisions.map((d) => '- ' + d).join('\n') });
  if (s.facts.length) sections.push({ id: uuidv7(), kind: 'facts', heading: 'Key facts', text: renderFacts(s.facts) });
  if (s.open_questions.length) sections.push({ id: uuidv7(), kind: 'open_questions', heading: 'Open questions', text: s.open_questions.map((d) => '- ' + d).join('\n') });
  let ord = 0;
  for (const sec of sections) {
    const e = await kr.encrypt(dekId, 'block_sections', sec.id, sec.text);
    await q.query(`INSERT INTO block_sections(id, block_version_id, ordinal, kind, heading, text_ct, nonce, data_key_id, tokens) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [sec.id, versionId, ord++, sec.kind, sec.heading.slice(0, 200), e.ct, e.nonce, dekId, countTokens(`${sec.heading}\n${sec.text}`)]);
  }
  const statements: { id: string; text: string; speaker_person_id: string | null }[] = [];
  ord = 0;
  for (const st of v.statements ?? []) {
    const id = uuidv7();
    const e = await kr.encrypt(dekId, 'statements', id, st.text);
    const fr = st.flag_reasons?.length ? await kr.encrypt(dekId, 'statements.flag_reasons', id, JSON.stringify(st.flag_reasons)) : null;
    await q.query(`INSERT INTO statements(id, block_version_id, ordinal, speaker_person_id, speaker_label, text_ct, nonce, data_key_id, started_at_ms, tokens, status, flags, flag_reasons_ct, flag_reasons_nonce)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, versionId, ord++, st.speaker_person_id ?? null, st.speaker_label, e.ct, e.nonce, dekId, st.start_ms ?? null, countTokens(st.text), st.status ?? 'allowed', st.flags ?? [], fr?.ct ?? null, fr?.nonce ?? null]);
    statements.push({ id, text: st.text, speaker_person_id: st.speaker_person_id ?? null });
  }
  // Facts from the structured output, linked to the section that mentions the value.
  for (const f of s.facts) {
    const id = uuidv7();
    const sec = sections.find((x) => x.kind !== 'facts' && x.text.includes(f.value)) ?? sections.find((x) => x.kind === 'facts');
    const e = await kr.encrypt(dekId, 'facts', id, f.value);
    await q.query(`INSERT INTO facts(id, workspace_id, block_id, block_version_id, section_id, entity, attribute, value_ct, value_nonce, value_hash, data_key_id, confidence)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, v.workspaceId, v.blockId, versionId, sec?.id ?? null, f.entity.toLowerCase().trim(), f.attribute.toLowerCase().trim(), e.ct, e.nonce, factValueHash(v.workspaceId, f.value), dekId, f.confidence ?? 0.7]);
  }
  await q.query(`UPDATE blocks SET current_version_id=$2, title=$3, updated_at=now() WHERE id=$1`, [v.blockId, versionId, s.title.slice(0, 200)]);
  return { versionId, versionNo, dekId, sections, statements };
}

export async function addStatementFacts(q: Queryable, kr: KeyRing, ws: string, blockId: string, versionId: string, dekId: string, statementId: string, facts: { entity: string; attribute: string; value: string; confidence?: number }[]) {
  for (const f of facts) {
    const id = uuidv7();
    const e = await kr.encrypt(dekId, 'facts', id, f.value);
    await q.query(`INSERT INTO facts(id, workspace_id, block_id, block_version_id, statement_id, entity, attribute, value_ct, value_nonce, value_hash, data_key_id, confidence)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, ws, blockId, versionId, statementId, f.entity.toLowerCase(), f.attribute.toLowerCase(), e.ct, e.nonce, factValueHash(ws, f.value), dekId, f.confidence ?? 0.7]);
  }
}

export interface VersionContent {
  versionId: string; versionNo: number; createdAt: string; structured: Structured; dekId: string;
  sections: { id: string; kind: string; heading: string; text: string; tokens: number; flags: string[] }[];
  statements: { id: string; ordinal: number; speaker_person_id: string | null; speaker_label: string; text: string; status: string; flags: string[]; flag_reasons: string[]; started_at_ms: number | null; tokens: number;
    revoked_at: string | null; decided_by: string | null; decided_at: string | null }[];
}

/** Decrypts a full version. Callers MUST have passed the policy engine for what they return. Revoked statements are never decrypted. */
export async function readVersion(q: Queryable, kr: KeyRing, versionId: string, opts: { statementIds?: Set<string>; sectionIds?: Set<string> } = {}): Promise<VersionContent> {
  const v = (await q.query('SELECT * FROM block_versions WHERE id=$1', [versionId]))[0];
  if (!v) throw new HttpError(404, 'not_found');
  const structured = await kr.decryptJson(v.data_key_id, 'block_versions', v.id, v.structured_ct, v.structured_nonce);
  const secRows = await q.query('SELECT * FROM block_sections WHERE block_version_id=$1 ORDER BY ordinal', [versionId]);
  const sections = [];
  for (const r of secRows) if (!opts.sectionIds || opts.sectionIds.has(r.id))
    sections.push({ id: r.id, kind: r.kind, heading: r.heading, text: await kr.decrypt(r.data_key_id, 'block_sections', r.id, r.text_ct, r.nonce), tokens: r.tokens, flags: r.flags ?? [] });
  const stRows = await q.query('SELECT * FROM statements WHERE block_version_id=$1 ORDER BY ordinal', [versionId]);
  const statements = [];
  for (const r of stRows) if (!opts.statementIds || opts.statementIds.has(r.id)) {
    const revoked = !!r.revoked_at;
    statements.push({
      id: r.id, ordinal: r.ordinal, speaker_person_id: r.speaker_person_id, speaker_label: r.speaker_label, status: r.status, flags: r.flags ?? [], started_at_ms: r.started_at_ms, tokens: r.tokens,
      text: revoked ? '' : await kr.decrypt(r.data_key_id, 'statements', r.id, r.text_ct, r.nonce),
      flag_reasons: !revoked && r.flag_reasons_ct ? await kr.decryptJson(r.data_key_id, 'statements.flag_reasons', r.id, r.flag_reasons_ct, r.flag_reasons_nonce) : [],
      revoked_at: r.revoked_at ?? null, decided_by: r.decided_by ?? null, decided_at: r.decided_at ?? null,
    });
  }
  return { versionId, versionNo: v.version_no, createdAt: v.created_at, structured, dekId: v.data_key_id, sections, statements };
}

/**
 * New version with unchanged content (rule / archive / expiry changes applied from the inbox must still produce a
 * version, Part 10.3). Sections are re-encrypted under a fresh DEK; flags and embeddings are carried over by ordinal.
 * Not for conversations: statement ids carry consent decisions and review links.
 */
export async function copyVersion(q: Queryable, blockId: string, userId: string | null, changeNote: string) {
  const b = (await q.query('SELECT id, workspace_id, kind, current_version_id FROM blocks WHERE id=$1', [blockId]))[0];
  if (!b?.current_version_id || b.kind === 'conversation') return null;
  const kr = new KeyRing(q);
  try {
    const old = await readVersion(q, kr, b.current_version_id);
    const prev = (await q.query('SELECT tokens_original, source_type FROM block_versions WHERE id=$1', [b.current_version_id]))[0];
    const w = await writeVersion(q, kr, { blockId, workspaceId: b.workspace_id, structured: old.structured, createdBy: userId, changeNote, originalTokens: prev?.tokens_original, sourceType: 'copy' });
    const oldRows = await q.query(`SELECT s.ordinal, s.flags, e.vector::text AS v FROM block_sections s LEFT JOIN embeddings e ON e.owner_type='section' AND e.owner_id=s.id WHERE s.block_version_id=$1`, [old.versionId]);
    const newRows = await q.query('SELECT id, ordinal FROM block_sections WHERE block_version_id=$1', [w.versionId]);
    for (const n of newRows) {
      const o = oldRows.find((x) => x.ordinal === n.ordinal);
      if (!o) continue;
      if (o.flags?.length) await q.query('UPDATE block_sections SET flags=$2 WHERE id=$1', [n.id, o.flags]);
      if (o.v) await q.query(`INSERT INTO embeddings(id, workspace_id, owner_type, owner_id, block_id, vector) VALUES ($1,$2,'section',$3,$4,$5::vector)`, [uuidv7(), b.workspace_id, n.id, blockId, o.v]);
    }
    return w;
  } finally { kr.wipe(); }
}

export async function readFacts(q: Queryable, kr: KeyRing, versionId: string) {
  const rows = await q.query('SELECT * FROM facts WHERE block_version_id=$1', [versionId]);
  const out = [];
  for (const r of rows) out.push({ id: r.id, entity: r.entity, attribute: r.attribute, value: await kr.decrypt(r.data_key_id, 'facts', r.id, r.value_ct, r.value_nonce), value_hash: r.value_hash, section_id: r.section_id, statement_id: r.statement_id });
  return out;
}

export async function getBlock(q: Queryable, id: string) {
  const b = (await q.query('SELECT * FROM blocks WHERE id=$1', [id]))[0];
  if (!b) throw new HttpError(404, 'not_found', 'Block not found');
  return b;
}

/** Ensures every member has a person row so they can be mapped as speakers. */
export async function ensurePersonForUser(q: Queryable, ws: string, userId: string) {
  const p = (await q.query('SELECT id FROM persons WHERE workspace_id=$1 AND user_id=$2', [ws, userId]))[0];
  if (p) return p.id as string;
  const u = (await q.query('SELECT display_name FROM users WHERE id=$1', [userId]))[0];
  const id = uuidv7();
  await q.query('INSERT INTO persons(id, workspace_id, user_id, display_name, is_external) VALUES ($1,$2,$3,$4,false)', [id, ws, userId, u?.display_name ?? 'Member']);
  return id;
}
