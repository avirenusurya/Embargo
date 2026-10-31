/**
 * Ingestion pipeline (Part 11): encrypt original → extract → compress / split statements → facts →
 * sensitivity → embed → version → events (context manager, consent, graph sync).
 * Raw inputs are stashed encrypted in object storage; outbox payloads never carry plaintext.
 */
import { getDb, vec, type Queryable } from '../db/index.ts';
import { KeyRing } from '../crypto/keys.ts';
import { getWorkspaceKey } from '../core/workspaceKeys.ts';
import { writeVersion, addStatementFacts, getBlock, createBlock, renderStructured, type StatementIn } from '../core/content.ts';
import { compressBlock, splitStatements, splitTurns, extractFacts, classifySensitivity } from '../ai/tasks.ts';
import { embed, countTokens, transcribe } from '../ai/llm.ts';
import { maxSeverity } from '../ai/sensitivity.ts';
import type { Structured, Flag } from '../ai/schemas.ts';
import { extractFile, extractUrl } from './extract.ts';
import { fetchMeeting, type Turn } from './wispr.ts';
import { githubToken, listRepoFiles, fetchRepoFile, DEFAULT_PATHS } from './github.ts';
import { putObject, getObject, deleteObject } from '../storage.ts';
import { enqueue, registerHandler } from '../jobs/queue.ts';
import { uuidv7, log } from '../util.ts';
import { tracePrompts, currentPromptVersions } from '../ai/prompts.ts';
import * as tg from '../integrations/tigergraph.ts';

// ---------- encrypted stash for raw inputs ----------
export async function stashInput(q: Queryable, ws: string, data: Buffer | string) {
  const keyId = await getWorkspaceKey(q, ws, 'upload');
  const key = `ws/${ws}/stash/${uuidv7()}.bin`;
  const kr = new KeyRing(q);
  const e = await kr.encrypt(keyId, 'objects', key, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
  kr.wipe();
  await putObject(key, Buffer.concat([e.nonce, e.ct]));
  return { stash: key, key_id: keyId };
}
async function unstash(q: Queryable, s: { stash: string; key_id: string }) {
  const obj = await getObject(s.stash);
  if (!obj) throw new Error('stashed input missing');
  const kr = new KeyRing(q);
  try { return await kr.decryptBuf(s.key_id, 'objects', s.stash, obj.subarray(12), obj.subarray(0, 12)); } finally { kr.wipe(); }
}

// ---------- speakers ----------
async function mapSpeakers(q: Queryable, ws: string, labels: string[], attendees: { name: string; email?: string }[] = []) {
  const persons = await q.query(`SELECT p.id, p.display_name, p.user_id, p.is_external, u.email FROM persons p LEFT JOIN users u ON u.id = p.user_id WHERE p.workspace_id=$1`, [ws]);
  const out = new Map<string, { id: string | null; external: boolean }>();
  const kr = new KeyRing(q);
  for (const label of new Set(labels)) {
    if (!label || /^(unknown|unassigned|speaker ?\d*)$/i.test(label)) { out.set(label, { id: null, external: true }); continue; }
    const att = attendees.find((a) => a.name?.toLowerCase() === label.toLowerCase());
    const l = label.toLowerCase();
    let p = persons.find((x) => (att?.email && x.email?.toLowerCase() === att.email.toLowerCase()) || x.display_name.toLowerCase() === l)
      ?? persons.find((x) => x.display_name.toLowerCase().split(/\s+/)[0] === l.split(/\s+/)[0] && !x.is_external);
    if (!p) {
      const id = uuidv7();
      let ct = null, nonce = null, keyId = null;
      if (att?.email) { keyId = await getWorkspaceKey(q, ws, 'contact'); const e = await kr.encrypt(keyId, 'persons', id, att.email); ct = e.ct; nonce = e.nonce; }
      await q.query('INSERT INTO persons(id, workspace_id, display_name, contact_channel, contact_address_ct, contact_nonce, data_key_id, is_external) VALUES ($1,$2,$3,$4,$5,$6,$7,true)',
        [id, ws, label, att?.email ? 'email' : null, ct, nonce, keyId]);
      p = { id, display_name: label, is_external: true };
      persons.push(p);
    }
    out.set(label, { id: p.id, external: !!p.is_external });
  }
  kr.wipe();
  return out;
}

function statusFor(flags: Flag[], external: boolean, unassigned: boolean, reviewAll: boolean): string {
  if (reviewAll) return 'held';
  const sev = maxSeverity(flags);
  if (sev === 'high') return 'held';
  if (sev === 'medium' && (external || unassigned)) return 'held';
  return 'allowed';
}

async function pmap<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

export interface IngestPayload {
  block_id: string; workspace_id: string; user_id: string | null; auto_publish?: boolean; change_note?: string;
  source: { type: string; stash?: string; key_id?: string; filename?: string; mime?: string; url?: string; repo?: string; path?: string; ref?: string; meeting_id?: string; title?: string; structured?: boolean; keep_facts?: boolean };
}

export async function runIngest(p: IngestPayload) {
  const db = await getDb();
  const block = await getBlock(db, p.block_id);
  if (block.status === 'revoked') return;
  await db.query(`UPDATE blocks SET processing_state='processing', processing_error=NULL WHERE id=$1`, [p.block_id]);
  try {
    const s = p.source;
    const ws = p.workspace_id;
    const settings = (await db.query('SELECT settings FROM workspaces WHERE id=$1', [ws]))[0]?.settings ?? {};
    let text = '', title = s.title, originalBuf: Buffer | undefined;
    let turns: Turn[] | null = null; let attendees: { name: string; email?: string }[] = [];
    let structuredDirect: Structured | null = null;

    switch (s.type) {
      case 'text': case 'agent': originalBuf = await unstash(db, s as any); text = originalBuf.toString('utf8'); break;
      case 'structured': originalBuf = await unstash(db, s as any); structuredDirect = JSON.parse(originalBuf.toString('utf8')); break;
      case 'file': { originalBuf = await unstash(db, s as any); const r = await extractFile(originalBuf, s.filename ?? 'upload.txt', s.mime); text = r.text; title ??= r.title; break; }
      case 'url': { const r = await extractUrl(s.url!); text = r.text; title ??= r.title; originalBuf = Buffer.from(text); break; }
      case 'github_file': { const token = await githubToken(db, ws); text = await fetchRepoFile(token, s.repo!, s.path!, s.ref!); originalBuf = Buffer.from(text); title ??= `${s.repo}: ${s.path}`; break; }
      case 'transcript': originalBuf = await unstash(db, s as any); text = originalBuf.toString('utf8'); turns = []; break;
      case 'wispr': {
        const m = await fetchMeeting(db, ws, s.meeting_id!);
        title ??= m.title; attendees = m.attendees;
        turns = m.turns; text = m.turns.length ? m.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n') : (m.rawText ?? '');
        originalBuf = Buffer.from(JSON.stringify(m)); break;
      }
      case 'audio': {
        originalBuf = await unstash(db, s as any);
        const r = await transcribe(originalBuf, s.filename ?? 'audio.m4a', s.mime ?? 'audio/mpeg');
        turns = r.segments.map((x) => ({ speaker: 'Unassigned', text: x.text, start_ms: x.start_ms })); text = turns.map((t) => t.text).join('\n'); break;
      }
      default: throw new Error(`unknown source type ${s.type}`);
    }

    const isConversation = turns !== null;
    let structured: Structured;
    let statements: StatementIn[] = [];
    const sectionFlags: Flag[][] = [];

    if (isConversation) {
      // Statements are the consent-governed unit: conversation blocks carry no derived summary sections
      // so held/blocked lines can never leak through a summary.
      let split: { speaker_label: string; text: string; start_ms?: number | null }[];
      if (s.type === 'audio') split = turns!.map((t) => ({ speaker_label: t.speaker, text: t.text, start_ms: t.start_ms }));
      // Wispr turns are already structured (speaker, text, start time): build statements from them directly.
      else if (s.type === 'wispr' && turns!.length) split = splitTurns(turns!).statements;
      else split = (await splitStatements(text)).statements;
      const speakers = await mapSpeakers(db, ws, split.map((x) => x.speaker_label), attendees);
      const externalNames = [...speakers.entries()].filter(([, v]) => v.external).map(([k]) => k).filter((k) => !/^(unknown|unassigned)$/i.test(k));
      statements = await pmap(split, 4, async (st) => {
        const sp = speakers.get(st.speaker_label) ?? { id: null, external: true };
        const flags = await classifySensitivity(st.text, { externalSpeaker: sp.external, externalNames: externalNames.filter((n) => n !== st.speaker_label) });
        return {
          speaker_label: st.speaker_label, speaker_person_id: sp.id, text: st.text, start_ms: st.start_ms ?? null,
          status: statusFor(flags, sp.external, !sp.id, settings.review_mode === 'all'),
          flags: flags.map((f) => `${f.category}:${f.severity}`), flag_reasons: flags.map((f) => f.reason),
        };
      });
      structured = { title: title || 'Conversation', summary: '', sections: [], facts: [], decisions: [], open_questions: [] };
    } else {
      structured = structuredDirect ?? await compressBlock(text, s.type, title);
      if (structuredDirect) {
        // Edited/merged/approved content: re-derive facts from the text so stale values can't linger,
        // unless a person edited the facts list directly (keep_facts).
        const body = [structuredDirect.summary, ...structuredDirect.sections.map((x) => x.text), ...structuredDirect.decisions].join('\n');
        structured = { ...structuredDirect, facts: s.keep_facts ? structuredDirect.facts ?? [] : await extractFacts(body) };
        text = renderStructured(structured);
      }
      if (title && s.type !== 'text') structured.title = title;
      for (const sec of [structured.summary, ...structured.sections.map((x) => `${x.heading}\n${x.text}`)]) sectionFlags.push(sec ? await classifySensitivity(sec) : []);
    }

    const kr = new KeyRing(db);
    const written = await db.tx((q) => writeVersion(q, kr, {
      blockId: p.block_id, workspaceId: ws, structured, statements, original: originalBuf, originalTokens: countTokens(text || JSON.stringify(structured)),
      createdBy: p.user_id, changeNote: p.change_note ?? `Imported from ${s.type}`, sourceType: s.type,
    }));
    // Section flags (summary first, then sections, matching write order)
    const flaggedSections = written.sections.filter((x) => x.kind === 'summary' || x.kind === 'section');
    let fi = structured.summary ? 0 : 1;
    for (const sec of flaggedSections) { const f = sectionFlags[fi++] ?? []; if (f.length) await db.query('UPDATE block_sections SET flags=$2 WHERE id=$1', [sec.id, f.map((x) => `${x.category}:${x.severity}`)]); }
    // Statement facts (one pass over the transcript, linked to the statement containing the value)
    if (isConversation && written.statements.length) {
      const facts = await extractFacts(written.statements.map((x) => x.text).join('\n'));
      for (const f of facts) {
        const st = written.statements.find((x) => x.text.includes(f.value));
        if (st) await addStatementFacts(db, kr, ws, p.block_id, written.versionId, written.dekId, st.id, [f]);
      }
    }
    kr.wipe();
    // Embeddings
    const units = [
      ...written.sections.map((x) => ({ type: 'section', id: x.id, text: `${structured.title} — ${x.heading}\n${x.text}` })),
      ...written.statements.map((x, i) => ({ type: 'statement', id: x.id, text: `${statements[i].speaker_label}: ${x.text}` })),
    ];
    const blockText = [structured.title, structured.summary, ...structured.sections.map((x) => x.text), ...statements.map((x) => x.text)].join('\n').slice(0, 24000);
    const vecs = await embed([...units.map((u) => u.text), blockText]);
    await db.tx(async (q) => {
      await q.query(`DELETE FROM embeddings WHERE owner_type='block' AND owner_id=$1`, [p.block_id]);
      for (let i = 0; i < units.length; i++) await q.query('INSERT INTO embeddings(id, workspace_id, owner_type, owner_id, block_id, vector) VALUES ($1,$2,$3,$4,$5,$6::vector)', [uuidv7(), ws, units[i].type, units[i].id, p.block_id, vec(vecs[i])]);
      await q.query(`INSERT INTO embeddings(id, workspace_id, owner_type, owner_id, block_id, vector) VALUES ($1,$2,'block',$3,$3,$4::vector)`, [uuidv7(), ws, p.block_id, vec(vecs[units.length])]);
      const publish = p.auto_publish || isConversation || block.status === 'active';
      await q.query(`UPDATE blocks SET processing_state='ready', status = CASE WHEN status='draft' AND $2 THEN 'active' ELSE status END, updated_at=now() WHERE id=$1`, [p.block_id, publish]);
      await enqueue(q, 'cm.on_change', { block_id: p.block_id, version_id: written.versionId, workspace_id: ws });
      if (statements.some((x) => x.status === 'held')) await enqueue(q, 'consent.dispatch', { block_id: p.block_id, version_id: written.versionId, workspace_id: ws });
      if (tg.enabled()) await enqueue(q, 'graph.sync', { entity: 'block', id: p.block_id });
      const pv = currentPromptVersions();
      if (pv) await q.query('UPDATE block_versions SET prompt_versions=$2 WHERE id=$1', [written.versionId, JSON.stringify(pv)]);
    });
    if (s.stash) await deleteObject(s.stash).catch(() => {});
    log('info', 'ingest.done', { block_id: p.block_id, version: written.versionNo, sections: written.sections.length, statements: written.statements.length });
  } catch (e: any) {
    await db.query(`UPDATE blocks SET processing_state='failed', processing_error=$2 WHERE id=$1`, [p.block_id, String(e.message).slice(0, 500)]);
    throw e;
  }
}

/** GitHub import: one block per selected file. */
export async function runGithubImport(p: { workspace_id: string; user_id: string; repo: string; ref?: string; paths?: string[]; auto_publish?: boolean }) {
  const db = await getDb();
  const token = await githubToken(db, p.workspace_id);
  const { commit, files } = await listRepoFiles(token, p.repo, p.ref ?? 'HEAD', p.paths?.length ? p.paths : DEFAULT_PATHS);
  for (const f of files.slice(0, 50)) {
    const existing = (await db.query(`SELECT id FROM blocks WHERE workspace_id=$1 AND source_ref->>'type'='github' AND source_ref->>'repo'=$2 AND source_ref->>'path'=$3 AND status <> 'revoked'`, [p.workspace_id, p.repo, f.path]))[0];
    const sourceRef = { type: 'github', repo: p.repo, path: f.path, commit, content_sha: f.sha, ref: p.ref ?? 'HEAD' };
    await db.tx(async (q) => {
      const id = existing?.id ?? await createBlock(q, { workspaceId: p.workspace_id, ownerId: p.user_id, kind: 'repo', title: `${p.repo}: ${f.path}`, sourceRef, processing: 'queued' });
      if (existing) await q.query('UPDATE blocks SET source_ref=$2 WHERE id=$1', [id, JSON.stringify(sourceRef)]);
      await enqueue(q, 'ingest.run', { block_id: id, workspace_id: p.workspace_id, user_id: p.user_id, auto_publish: p.auto_publish, source: { type: 'github_file', repo: p.repo, path: f.path, ref: commit, title: `${p.repo}: ${f.path}` } } satisfies IngestPayload);
    });
  }
  return { commit, files: files.length };
}

registerHandler('ingest.run', (p) => tracePrompts(() => runIngest(p)));
registerHandler('github.import', (p) => runGithubImport(p).then(() => {}));
