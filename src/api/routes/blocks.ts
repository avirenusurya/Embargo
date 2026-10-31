import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, vec } from '../../db/index.ts';
import { config } from '../../config.ts';
import { requireUser, requireRole, parse, ADMIN, ANY, EDITOR, blockWorkspace, webRequester, enforceLimit } from '../http.ts';
import { createBlock, readVersion, renderStructured, getBlock } from '../../core/content.ts';
import { allowedItems, decideBlock, latestRules, memberships } from '../../core/policy.ts';
import { insertRule } from '../../core/contextManager.ts';
import { revokeBlock, revokeStatement } from '../../core/revoke.ts';
import { reviewView, submitReview, applyDecisions, issueReviewLink } from '../../core/consent.ts';
import { stashInput, type IngestPayload } from '../../ingest/pipeline.ts';
import { extractFile } from '../../ingest/extract.ts';
import { parseRuleCommand } from '../../ai/tasks.ts';
import { embedOne, countTokens } from '../../ai/llm.ts';
import { KeyRing } from '../../crypto/keys.ts';
import { getWorkspaceKey } from '../../core/workspaceKeys.ts';
import { getObject } from '../../storage.ts';
import { enqueue } from '../../jobs/queue.ts';
import { HttpError, uuidv7, cosine, isUuid } from '../../util.ts';
import * as tg from '../../integrations/tigergraph.ts';

const Source = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(500_000) }),
  z.object({ type: z.literal('file'), filename: z.string().min(1).max(200), mime: z.string().optional(), data_base64: z.string().min(1) }),
  z.object({ type: z.literal('url'), url: z.string().url() }),
  z.object({ type: z.literal('github'), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), ref: z.string().optional(), paths: z.array(z.string()).optional() }),
  z.object({ type: z.literal('transcript'), text: z.string().min(1).max(1_000_000) }),
  z.object({ type: z.literal('wispr'), meeting_id: z.string().min(1) }),
  z.object({ type: z.literal('audio'), filename: z.string().min(1), mime: z.string().optional(), data_base64: z.string().min(1) }),
]);
const KIND: Record<string, any> = { text: 'note', file: 'doc', url: 'url', transcript: 'conversation', wispr: 'conversation', audio: 'conversation' };
const Visibility = z.enum(['private', 'team', 'partner', 'public']);
const AccessMode = z.enum(['viewable', 'agent_only', 'sealed_use']);

async function setTags(q: any, ws: string, blockId: string, tags: string[]) {
  await q.query('DELETE FROM block_tags WHERE block_id=$1', [blockId]);
  for (const t of tags) {
    const tid = (await q.query(`INSERT INTO tags(id, workspace_id, name) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [uuidv7(), ws, t.slice(0, 50)]))[0].id;
    await q.query('INSERT INTO block_tags(block_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [blockId, tid]);
  }
}

function lineDiff(a: string[], b: string[]) {
  const m = a.length, n = b.length, L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { op: ' ' | '-' | '+'; line: string }[] = []; let i = 0, j = 0;
  while (i < m && j < n) { if (a[i] === b[j]) { out.push({ op: ' ', line: a[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', line: a[i++] }); else out.push({ op: '+', line: b[j++] }); }
  while (i < m) out.push({ op: '-', line: a[i++] }); while (j < n) out.push({ op: '+', line: b[j++] });
  return out;
}

/** Access for humans: members of the block's workspace, or a valid card. Returns role (null if via card). */
async function humanAccess(q: any, userId: string, b: any) {
  const m = (await q.query('SELECT role FROM memberships WHERE user_id=$1 AND workspace_id=$2', [userId, b.workspace_id]))[0];
  if (m) return m.role as string;
  const d = await decideBlock(q, webRequester(userId, null), 'web', new Date(), b.id);
  if (d.decision.allow) return null;
  throw new HttpError(404, 'not_found', 'Block not found');
}

const MIME: Record<string, string> = {
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'video/webm', mp4: 'video/mp4', mov: 'video/quicktime',
  yaml: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8', ts: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8', py: 'text/plain; charset=utf-8',
};

/** Web reads are logged like tool reads (O1): who, which block, which version, how many tokens. */
async function logWebRead(q: any, userId: string, b: any, versionNo: number, tool: string, tokens: number) {
  await q.query(`INSERT INTO access_logs(id, workspace_id, user_id, channel, tool, block_ids, block_versions, tokens_served) VALUES ($1,$2,$3,'web',$4,$5,$6,$7)`,
    [uuidv7(), b.workspace_id, userId, tool, [b.id], JSON.stringify({ [b.id]: versionNo }), tokens]);
}

/** Policy-filtered sections + statements for the web (shared by GET /blocks/:id and /blocks/:id/statements). */
async function detailContent(db: any, userId: string, b: any, role: string | null, rule: any) {
  const isAdmin = !!role && ADMIN.includes(role as any);
  const preview = b.status === 'draft' && (b.owner_id === userId || (isAdmin && rule?.visibility !== 'private'));
  const A = await allowedItems(db, webRequester(userId, b.workspace_id), 'web', new Date(), null, { blockIds: [b.id] });
  const textOk = new Set(A.items.filter((i) => i.form === 'text').map((i) => i.id));
  const hidden = A.items.some((i) => i.form === 'hidden') || b.access_mode !== 'viewable';
  const kr = new KeyRing(db);
  try {
    const v = await readVersion(db, kr, b.current_version_id);
    const served: string[] = []; let servedTokens = 0;
    const sections = v.sections.map((s) => {
      const show = (preview && b.access_mode === 'viewable') || textOk.has(s.id);
      if (show) { served.push(s.id); servedTokens += s.tokens; }
      return { id: s.id, kind: s.kind, heading: s.heading, flags: s.flags, tokens: s.tokens, text: show ? s.text : undefined };
    });
    const statements = v.statements.map((s) => {
      const canSee = !s.revoked_at && (textOk.has(s.id) || (s.status === 'held' && (isAdmin || b.owner_id === userId) && b.access_mode === 'viewable'));
      if (canSee) { served.push(s.id); servedTokens += s.tokens; }
      return { id: s.id, ordinal: s.ordinal, speaker_label: s.speaker_label, speaker_person_id: s.speaker_person_id, status: s.status, flags: s.flags, flag_reasons: s.flag_reasons, started_at_ms: s.started_at_ms,
        text: canSee ? s.text : undefined, revoked_at: s.revoked_at, decided_by: s.decided_by, decided_at: s.decided_at };
    });
    const withheld = A.withheld.reduce((acc: Record<string, number>, w) => ((acc[w.reason] = (acc[w.reason] ?? 0) + 1), acc), {});
    return { isAdmin, preview, hidden, sections, statements, withheld, served, servedTokens };
  } finally { kr.wipe(); }
}

export default async function blockRoutes(app: FastifyInstance) {
  app.get('/workspaces/:ws/blocks', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const qs = req.query as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    const params: any[] = [ws, u.id]; const where = [`b.workspace_id=$1`, `(b.status <> 'draft' OR b.owner_id=$2 OR NOT b.agent_written)`];
    if (qs.status) { params.push(qs.status); where.push(`b.status=$${params.length}`); } else where.push(`b.status <> 'revoked'`);
    if (qs.mode) { params.push(qs.mode); where.push(`b.access_mode=$${params.length}`); }
    if (qs.kind) { params.push(qs.kind); where.push(`b.kind=$${params.length}`); }
    if (qs.tag) { params.push(qs.tag); where.push(`EXISTS (SELECT 1 FROM block_tags bt JOIN tags t ON t.id=bt.tag_id WHERE bt.block_id=b.id AND t.name=$${params.length})`); }
    if (qs.collection) { params.push(qs.collection); where.push(`EXISTS (SELECT 1 FROM collection_blocks cb WHERE cb.block_id=b.id AND cb.collection_id::text=$${params.length})`); }
    let order = 'b.pinned DESC, b.updated_at DESC';
    if (qs.query) {
      const v = await embedOne(String(qs.query));
      params.push(vec(v), `%${qs.query}%`);
      order = `(b.title ILIKE $${params.length}) DESC, COALESCE((SELECT e.vector <=> $${params.length - 1}::vector FROM embeddings e WHERE e.owner_type='block' AND e.owner_id=b.id LIMIT 1), 2) ASC`;
    }
    return db.query(`SELECT b.id, b.title, b.kind, b.status, b.access_mode, b.storage_mode, b.pinned, b.processing_state, b.processing_error, b.agent_written, b.owner_id, b.updated_at,
        v.version_no, v.tokens_original, v.tokens_compressed, (SELECT array_agg(t.name) FROM block_tags bt JOIN tags t ON t.id=bt.tag_id WHERE bt.block_id=b.id) AS tags,
        (SELECT COUNT(*)::int FROM statements s WHERE s.block_version_id=b.current_version_id AND s.status='held') AS held_statements
      FROM blocks b LEFT JOIN block_versions v ON v.id=b.current_version_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`, params);
  });

  app.post('/workspaces/:ws/blocks', { bodyLimit: Math.ceil(config.limits.uploadBytes * 1.4) + 65536 }, async (req, reply) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const b = parse(z.object({
      source: Source, title: z.string().max(200).optional(), access_mode: AccessMode.optional(), visibility: Visibility.optional(),
      tags: z.array(z.string()).optional(), pinned: z.boolean().optional(), auto_publish: z.boolean().optional(),
    }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, EDITOR);
    await enforceLimit(db, ws, 'blocks');
    await enforceLimit(db, ws, 'monthlyImports');
    const s = b.source;
    if (s.type === 'github') {
      const jobId = await enqueue(db, 'github.import', { workspace_id: ws, user_id: u.id, repo: s.repo, ref: s.ref, paths: s.paths, auto_publish: b.auto_publish });
      return reply.code(202).send({ job_id: jobId, note: 'One block per selected file will be created' });
    }
    let payloadSrc: IngestPayload['source'];
    if (s.type === 'file' || s.type === 'audio') {
      const buf = Buffer.from(s.data_base64, 'base64');
      if (buf.length > config.limits.uploadBytes) throw new HttpError(413, 'too_large', `Max ${config.limits.uploadBytes} bytes`);
      payloadSrc = { type: s.type, filename: s.filename, mime: s.mime, title: b.title, ...(await stashInput(db, ws, buf)) };
    } else if (s.type === 'text' || s.type === 'transcript') payloadSrc = { type: s.type, title: b.title, ...(await stashInput(db, ws, s.text)) };
    else if (s.type === 'url') payloadSrc = { type: 'url', url: s.url, title: b.title };
    else payloadSrc = { type: 'wispr', meeting_id: s.meeting_id, title: b.title };
    const out = await db.tx(async (q) => {
      const id = await createBlock(q, { workspaceId: ws, ownerId: u.id, kind: KIND[s.type], title: b.title ?? (s.type === 'url' ? s.url : 'Untitled'), accessMode: b.access_mode, visibility: b.visibility, processing: 'queued',
        sourceRef: s.type === 'url' ? { type: 'url', url: s.url } : s.type === 'wispr' ? { type: 'wispr', meeting_id: s.meeting_id } : s.type === 'file' || s.type === 'audio' ? { type: s.type, filename: s.filename } : { type: s.type } });
      if (b.pinned) await q.query('UPDATE blocks SET pinned=true WHERE id=$1', [id]);
      if (b.tags?.length) await setTags(q, ws, id, b.tags);
      const jobId = await enqueue(q, 'ingest.run', { block_id: id, workspace_id: ws, user_id: u.id, auto_publish: b.auto_publish, source: payloadSrc } satisfies IngestPayload);
      return { block_id: id, job_id: jobId };
    });
    return reply.code(202).send(out);
  });

  app.get('/blocks/:id', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    const role = await humanAccess(db, u.id, b);
    const rule = (await latestRules(db, 'block', [b.id])).get(b.id) ?? null;
    const tags = (await db.query('SELECT t.name FROM block_tags bt JOIN tags t ON t.id=bt.tag_id WHERE bt.block_id=$1', [b.id])).map((x) => x.name);
    const ver = b.current_version_id ? (await db.query('SELECT version_no, created_at, tokens_original, tokens_compressed, change_note FROM block_versions WHERE id=$1', [b.current_version_id]))[0] : null;
    const base = {
      id: b.id, workspace_id: b.workspace_id, title: b.title, kind: b.kind, status: b.status, access_mode: b.access_mode, storage_mode: b.storage_mode, pinned: b.pinned,
      processing_state: b.processing_state, processing_error: b.processing_error, agent_written: b.agent_written, owner_id: b.owner_id, source_ref: b.source_ref, rule, tags, your_role: role,
      version: ver ? { ...ver, tokens_saved_per_read: Math.max(0, ver.tokens_original - ver.tokens_compressed) } : null,
    };
    if (!ver || b.status === 'revoked' || b.storage_mode === 'sealed_block') return { ...base, content_hidden: true, sections: [], statements: [] };
    const d = await detailContent(db, u.id, b, role, rule);
    if (d.served.length) await logWebRead(db, u.id, b, ver.version_no, 'block_detail', d.servedTokens);
    return { ...base, preview: d.preview, content_hidden: d.hidden && !d.preview, withheld: d.isAdmin ? d.withheld : undefined, sections: d.sections, statements: d.statements };
  });

  app.get('/blocks/:id/statements', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    const role = await humanAccess(db, u.id, b);
    if (!b.current_version_id || b.status === 'revoked' || b.storage_mode === 'sealed_block') return { statements: [] };
    const rule = (await latestRules(db, 'block', [b.id])).get(b.id) ?? null;
    const d = await detailContent(db, u.id, b, role, rule);
    return { statements: d.statements };
  });

  /** Encrypted original (C4): decrypted for authorised members only; never for sealed/agent-only/sealed-use/revoked blocks. */
  app.get('/blocks/:id/original', async (req, reply) => {
    const u = await requireUser(req);
    const qs = parse(z.object({ version: z.coerce.number().int().min(1).optional(), download: z.enum(['0', '1']).optional() }), req.query);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    const role = await requireRole(db, u.id, b.workspace_id, ANY);
    if (b.storage_mode === 'sealed_block') throw new HttpError(403, 'sealed_block', 'Sealed blocks are encrypted on your devices; Embargo has no original');
    if (b.status === 'revoked') throw new HttpError(410, 'revoked', 'Block was revoked and its original destroyed');
    if (b.access_mode !== 'viewable') throw new HttpError(403, 'content_hidden', 'Originals are not shown for agent-only or sealed-use blocks');
    const isOwner = b.owner_id === u.id, isAdmin = ADMIN.includes(role);
    if (role === 'viewer' && !isOwner) throw new HttpError(403, 'forbidden', 'Viewers cannot open originals');
    const rule = (await latestRules(db, 'block', [b.id])).get(b.id) ?? null;
    const dec = await decideBlock(db, webRequester(u.id, b.workspace_id), 'web', new Date(), b.id);
    const canSee = isOwner || (dec.decision.allow && dec.decision.form === 'text') || (isAdmin && b.status === 'draft' && rule?.visibility !== 'private');
    if (!canSee) throw new HttpError(403, 'forbidden', 'You cannot see this block');
    if (b.kind === 'conversation') {
      // The raw transcript contains every line: never show it once a speaker blocked or a line was revoked.
      const st = (await db.query(`SELECT COUNT(*) FILTER (WHERE status='blocked' OR revoked_at IS NOT NULL)::int AS blocked, COUNT(*) FILTER (WHERE status='held')::int AS held FROM statements WHERE block_version_id=$1`, [b.current_version_id]))[0];
      if (st.blocked || (st.held && !isAdmin && !isOwner)) throw new HttpError(403, 'consent_restricted', 'The original recording/transcript includes lines speakers have not released');
    }
    const v = (await db.query(`SELECT id, version_no, original_object_key, data_key_id, source_type FROM block_versions WHERE block_id=$1 AND original_object_key IS NOT NULL ${qs.version ? 'AND version_no=$2' : ''}
       ORDER BY (CASE WHEN source_type IS NULL THEN (change_note LIKE 'Imported from %') ELSE source_type NOT IN ('structured','copy') END) DESC, version_no DESC LIMIT 1`, qs.version ? [b.id, qs.version] : [b.id]))[0];
    if (!v) throw new HttpError(404, 'no_original', 'No original is stored for this block');
    const obj = await getObject(v.original_object_key);
    if (!obj) throw new HttpError(404, 'no_original', 'Original object missing');
    const kr = new KeyRing(db);
    let buf: Buffer;
    try { buf = await kr.decryptBuf(v.data_key_id, 'objects', v.original_object_key, obj.subarray(12), obj.subarray(0, 12)); } finally { kr.wipe(); }
    const sr = (typeof b.source_ref === 'string' ? JSON.parse(b.source_ref) : b.source_ref) ?? {};
    const st = v.source_type ?? sr.type ?? 'text';
    const slug = b.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'original';
    const filename: string = sr.filename ?? (st === 'github_file' && sr.path ? sr.path.split('/').pop() : `${slug}.${st === 'wispr' ? 'json' : st === 'text' || st === 'agent' ? 'md' : 'txt'}`);
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    const mime = MIME[ext] ?? (st === 'audio' ? 'application/octet-stream' : 'text/plain; charset=utf-8');
    const binary = !mime.startsWith('text/') && mime !== 'application/json';
    let text: string | null = binary ? null : buf.toString('utf8');
    if (binary && (ext === 'pdf' || ext === 'docx')) text = await extractFile(buf, filename, mime).then((r) => r.text).catch(() => null);
    await logWebRead(db, u.id, b, v.version_no, qs.download === '1' ? 'original_download' : 'original', text ? countTokens(text) : 0);
    if (qs.download === '1') {
      return reply.header('content-type', mime).header('cache-control', 'no-store')
        .header('content-disposition', `attachment; filename="${filename.replace(/[^\w.-]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`).send(buf);
    }
    return { filename, mime, size: buf.length, text, binary, version: v.version_no, download_url: `/blocks/${b.id}/original?download=1&version=${v.version_no}` };
  });

  app.patch('/blocks/:id', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    const role = await requireRole(db, u.id, b.workspace_id, EDITOR);
    if (b.status === 'revoked') throw new HttpError(410, 'revoked');
    if (b.agent_written && b.owner_id !== u.id && !ADMIN.includes(role)) throw new HttpError(403, 'forbidden');
    const Section = z.object({ heading: z.string().max(200), text: z.string().max(100_000) });
    const FactIn = z.object({ entity: z.string().min(1).max(100), attribute: z.string().min(1).max(100), value: z.string().min(1).max(500) });
    const body = parse(z.object({
      title: z.string().min(1).max(200).optional(), text: z.string().min(1).max(500_000).optional(),
      structured: z.object({ title: z.string(), summary: z.string(), sections: z.array(Section), facts: z.array(FactIn), decisions: z.array(z.string()), open_questions: z.array(z.string()) }).optional(),
      // C3: edit individual structured fields; each edit creates a new version (D4).
      summary: z.string().max(5000).optional(), sections: z.array(Section).max(200).optional(), facts: z.array(FactIn).max(500).optional(),
      decisions: z.array(z.string().max(2000)).max(200).optional(), open_questions: z.array(z.string().max(2000)).max(200).optional(),
      pinned: z.boolean().optional(), tags: z.array(z.string()).optional(), change_note: z.string().max(300).optional(),
    }), req.body);
    const FIELDS = ['summary', 'sections', 'facts', 'decisions', 'open_questions'] as const;
    const fieldEdit = FIELDS.some((k) => body[k] !== undefined);
    const contentEdit = !!(body.text || body.structured || fieldEdit);
    if (contentEdit && b.kind === 'conversation') throw new HttpError(400, 'conversation_edit', 'Conversation statements are edited via speaker decisions, not text edits');
    if (contentEdit && b.storage_mode === 'sealed_block') throw new HttpError(400, 'sealed_block', 'Sealed blocks are edited on your devices');
    if ([body.text, body.structured, fieldEdit || undefined].filter(Boolean).length > 1) throw new HttpError(400, 'invalid_request', 'Send one of: text, structured, or structured fields');
    // Title-only edits of a versioned, non-conversation block also create a version.
    const titleVersion = !contentEdit && !!body.title && !!b.current_version_id && b.kind !== 'conversation' && b.storage_mode === 'standard';
    let structured: any = body.structured ? { ...body.structured, title: body.title ?? body.structured.title } : null;
    if (fieldEdit || titleVersion) {
      if (!b.current_version_id) throw new HttpError(409, 'processing', 'Block has no content yet');
      const kr = new KeyRing(db);
      try { structured = { ...(await readVersion(db, kr, b.current_version_id)).structured }; } finally { kr.wipe(); }
      for (const k of FIELDS) if (body[k] !== undefined) structured[k] = body[k];
      if (body.title) structured.title = body.title;
    }
    return db.tx(async (q) => {
      if (body.pinned !== undefined) await q.query('UPDATE blocks SET pinned=$2, updated_at=now() WHERE id=$1', [b.id, body.pinned]);
      if (body.tags) await setTags(q, b.workspace_id, b.id, body.tags);
      let jobId: number | null = null;
      if (structured || body.text) {
        const st = await stashInput(q, b.workspace_id, structured ? JSON.stringify(structured) : body.text!);
        const note = body.change_note ?? (fieldEdit ? `Edited ${FIELDS.filter((k) => body[k] !== undefined).join(', ')}` : titleVersion ? 'Renamed' : 'Edited');
        // Facts a person typed are kept as-is; otherwise they are re-derived from the edited text.
        const keepFacts = !!body.structured || body.facts !== undefined || titleVersion;
        jobId = await enqueue(q, 'ingest.run', { block_id: b.id, workspace_id: b.workspace_id, user_id: u.id, change_note: note, source: { type: structured ? 'structured' : 'text', ...st, title: structured?.title ?? body.title ?? b.title, keep_facts: keepFacts } } satisfies IngestPayload);
        await q.query(`UPDATE blocks SET processing_state='queued' WHERE id=$1`, [b.id]);
      } else if (body.title) await q.query('UPDATE blocks SET title=$2, updated_at=now() WHERE id=$1', [b.id, body.title]);
      return { ok: true, job_id: jobId, version_pending: jobId !== null };
    });
  });

  app.post('/blocks/:id/publish', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    const role = await requireRole(db, u.id, b.workspace_id, EDITOR);
    if (b.agent_written && b.owner_id !== u.id) throw new HttpError(403, 'forbidden', 'Only the owner can publish an agent-written draft');
    if (b.status !== 'draft') throw new HttpError(409, 'not_draft');
    if (b.processing_state !== 'ready') throw new HttpError(409, 'processing', 'Block is still processing');
    await db.query(`UPDATE blocks SET status='active', updated_at=now() WHERE id=$1`, [b.id]);
    if (tg.enabled()) await enqueue(db, 'graph.sync', { entity: 'block', id: b.id });
    return { ok: true, role };
  });

  app.post('/blocks/:id/archive', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    await requireRole(db, u.id, b.workspace_id, EDITOR);
    await db.query(`UPDATE blocks SET status='archived', updated_at=now() WHERE id=$1 AND status <> 'revoked'`, [b.id]);
    return { ok: true };
  });

  app.get('/blocks/:id/versions', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    await requireRole(db, u.id, b.workspace_id, ANY);
    return db.query('SELECT version_no, created_at, created_by, change_note, tokens_original, tokens_compressed, content_hash, source_type, prompt_versions, (original_object_key IS NOT NULL) AS has_original FROM block_versions WHERE block_id=$1 ORDER BY version_no DESC', [b.id]);
  });

  app.get('/blocks/:id/versions/:v/diff/:v2', async (req) => {
    const u = await requireUser(req);
    const { id, v, v2 } = req.params as any;
    const db = await getDb();
    const b = await blockWorkspace(db, id);
    await requireRole(db, u.id, b.workspace_id, EDITOR);
    if (b.access_mode !== 'viewable') throw new HttpError(403, 'content_hidden', 'Diffs are not shown for agent-only or sealed blocks');
    const rows = await db.query('SELECT id, version_no FROM block_versions WHERE block_id=$1 AND version_no = ANY($2::int[])', [id, [Number(v), Number(v2)]]);
    const a = rows.find((r) => r.version_no === Number(v)), c = rows.find((r) => r.version_no === Number(v2));
    if (!a || !c) throw new HttpError(404, 'not_found');
    const kr = new KeyRing(db);
    try {
      const ta = renderStructured((await readVersion(db, kr, a.id)).structured).split('\n');
      const tb = renderStructured((await readVersion(db, kr, c.id)).structured).split('\n');
      return { from: Number(v), to: Number(v2), diff: lineDiff(ta, tb) };
    } finally { kr.wipe(); }
  });

  app.post('/blocks/:id/rollback/:v', async (req) => {
    const u = await requireUser(req);
    const { id, v } = req.params as any;
    const db = await getDb();
    const b = await blockWorkspace(db, id);
    await requireRole(db, u.id, b.workspace_id, EDITOR);
    if (b.kind === 'conversation') throw new HttpError(400, 'conversation_rollback');
    const row = (await db.query('SELECT id FROM block_versions WHERE block_id=$1 AND version_no=$2', [id, Number(v)]))[0];
    if (!row) throw new HttpError(404, 'not_found');
    const kr = new KeyRing(db);
    const structured = (await readVersion(db, kr, row.id)).structured; kr.wipe();
    const st = await stashInput(db, b.workspace_id, JSON.stringify(structured));
    const jobId = await enqueue(db, 'ingest.run', { block_id: id, workspace_id: b.workspace_id, user_id: u.id, change_note: `Rollback to v${v}`, source: { type: 'structured', ...st, title: structured.title } } satisfies IngestPayload);
    return { ok: true, job_id: jobId };
  });

  app.post('/blocks/:id/rules', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    const role = await requireRole(db, u.id, b.workspace_id, EDITOR);
    if (b.owner_id !== u.id && !ADMIN.includes(role)) throw new HttpError(403, 'forbidden', 'Only the block owner or a context admin can change rules');
    const body = parse(z.object({
      visibility: Visibility.optional(), partner_workspace_id: z.string().uuid().nullable().optional(), allowed_connection_ids: z.array(z.string().uuid()).nullable().optional(),
      purposes: z.array(z.string()).nullable().optional(), expires_at: z.string().datetime({ offset: true }).nullable().optional(), embargo_until: z.string().datetime({ offset: true }).nullable().optional(),
      answer_policy: z.enum(['facts_only', 'yes_no', 'summary']).optional(),
    }), req.body);
    const rule = await insertRule(db, b.workspace_id, b.id, u.id, body);
    if (tg.enabled()) await enqueue(db, 'graph.sync', { entity: 'block', id: b.id });
    return rule;
  });

  app.post('/blocks/:id/access-mode', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    const role = await requireRole(db, u.id, b.workspace_id, EDITOR);
    if (b.owner_id !== u.id && !ADMIN.includes(role)) throw new HttpError(403, 'forbidden');
    const { access_mode } = parse(z.object({ access_mode: AccessMode }), req.body);
    if (b.storage_mode === 'sealed_block' && access_mode === 'sealed_use') throw new HttpError(400, 'invalid', 'Sealed blocks cannot use sealed use (Embargo cannot read them)');
    await db.query('UPDATE blocks SET access_mode=$2, updated_at=now() WHERE id=$1', [b.id, access_mode]);
    if (tg.enabled()) await enqueue(db, 'graph.sync', { entity: 'block', id: b.id });
    return { ok: true, access_mode };
  });

  app.post('/blocks/:id/revoke', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    const role = await requireRole(db, u.id, b.workspace_id, EDITOR);
    if (b.owner_id !== u.id && !ADMIN.includes(role)) throw new HttpError(403, 'forbidden', 'Only the block owner or a context admin can revoke');
    return db.tx((q) => revokeBlock(q, b.id, u.id));
  });

  // ----- Dictated rule commands (Wispr Flow) -----
  app.post('/rule-commands/parse', async (req) => {
    const u = await requireUser(req);
    const { text, workspace_id } = parse(z.object({ text: z.string().min(3).max(500), workspace_id: z.string().uuid() }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, workspace_id, EDITOR);
    const parsed = await parseRuleCommand(text);
    const candidates = await db.query(`SELECT b.id, b.title, (SELECT e.vector::text FROM embeddings e WHERE e.owner_type='block' AND e.owner_id=b.id LIMIT 1) AS v FROM blocks b WHERE b.workspace_id=$1 AND b.status IN ('active','draft')`, [workspace_id]);
    const tv = await embedOne(`${parsed.target_ref}`);
    const ref = parsed.target_ref.toLowerCase();
    const scored = candidates.map((c) => ({ id: c.id, title: c.title, score: (c.title.toLowerCase().includes(ref) || ref.split(' ').every((w: string) => c.title.toLowerCase().includes(w)) ? 1 : 0) + (c.v ? cosine(tv, JSON.parse(c.v)) : 0) }))
      .sort((a, b) => b.score - a.score).slice(0, 3);
    return { parsed, target: scored[0] ?? null, alternatives: scored.slice(1), confirm_with: scored[0] ? { endpoint: `/blocks/${scored[0].id}/rules`, body: Object.fromEntries(Object.entries({ visibility: parsed.visibility, embargo_until: parsed.embargo_until, expires_at: parsed.expires_at }).filter(([, v]) => v)), access_mode: parsed.access_mode ?? undefined } : null };
  });

  // ----- Conversations & consent -----
  app.patch('/statements/:id/speaker', async (req) => {
    const u = await requireUser(req);
    const { person_id } = parse(z.object({ person_id: z.string().uuid() }), req.body);
    const db = await getDb();
    const st = (await db.query('SELECT s.id, s.status, s.block_version_id, b.id AS block_id, b.workspace_id, b.owner_id FROM statements s JOIN block_versions v ON v.id=s.block_version_id JOIN blocks b ON b.id=v.block_id WHERE s.id=$1', [(req.params as any).id]))[0];
    if (!st) throw new HttpError(404, 'not_found');
    const role = await requireRole(db, u.id, st.workspace_id, EDITOR);
    if (st.owner_id !== u.id && !ADMIN.includes(role)) throw new HttpError(403, 'forbidden');
    const p = (await db.query('SELECT id, display_name FROM persons WHERE id=$1 AND workspace_id=$2', [person_id, st.workspace_id]))[0];
    if (!p) throw new HttpError(404, 'person_not_found');
    await db.tx(async (q) => {
      await q.query('UPDATE statements SET speaker_person_id=$2, speaker_label=$3 WHERE id=$1', [st.id, p.id, p.display_name]);
      if (st.status === 'held') await enqueue(q, 'consent.dispatch', { block_id: st.block_id, version_id: st.block_version_id, workspace_id: st.workspace_id });
    });
    return { ok: true };
  });

  app.get('/blocks/:id/review-links', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const b = await blockWorkspace(db, (req.params as any).id);
    await requireRole(db, u.id, b.workspace_id, ADMIN);
    const w = (await db.query('SELECT settings FROM workspaces WHERE id=$1', [b.workspace_id]))[0];
    const groups = await db.query(`SELECT s.speaker_person_id AS pid, p.display_name, COUNT(*)::int AS n FROM statements s JOIN persons p ON p.id=s.speaker_person_id WHERE s.block_version_id=$1 AND s.status='held' GROUP BY 1,2`, [b.current_version_id]);
    const out = [];
    for (const g of groups) out.push({ person_id: g.pid, person: g.display_name, held: g.n, link: await issueReviewLink(db, g.pid, b.current_version_id, Number(w.settings?.review_deadline_hours ?? 48)) });
    return out;
  });

  app.get('/review/:token', async (req, reply) => {
    if (String(req.headers.accept ?? '').includes('text/html')) return reply.sendFile('review.html');
    return reviewView(await getDb(), (req.params as any).token);
  });
  app.post('/review/:token/decisions', async (req) => {
    const b = parse(z.object({
      decisions: z.array(z.object({ statement_id: z.string().uuid(), status: z.enum(['allowed', 'team_only', 'blocked']), embargo_until: z.string().datetime({ offset: true }).nullable().optional() })).min(1),
      signature: z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), signatures: z.record(z.string(), z.string().regex(/^0x[0-9a-fA-F]+$/)) }).optional(),
    }), req.body);
    return { results: await submitReview((req.params as any).token, b.decisions, b.signature) };
  });

  // Statement revoke (K1): speaker, block owner or context admin. Stops serving on the next request.
  app.post('/statements/:id/revoke', async (req) => {
    const u = await requireUser(req);
    const db = await getDb();
    const id = (req.params as any).id;
    if (!isUuid(id)) throw new HttpError(400, 'bad_id');
    const st = (await db.query(`SELECT s.id, p.user_id AS speaker_user, b.workspace_id, b.owner_id, b.status FROM statements s JOIN block_versions v ON v.id=s.block_version_id JOIN blocks b ON b.id=v.block_id
       LEFT JOIN persons p ON p.id=s.speaker_person_id WHERE s.id=$1`, [id]))[0];
    if (!st) throw new HttpError(404, 'not_found');
    if (st.status === 'revoked') throw new HttpError(410, 'revoked', 'The block was revoked');
    if (st.speaker_user !== u.id) {
      const role = await requireRole(db, u.id, st.workspace_id, EDITOR);
      if (st.owner_id !== u.id && !ADMIN.includes(role)) throw new HttpError(403, 'forbidden', 'Only the speaker, the block owner or a context admin can revoke a statement');
    }
    const r = await db.tx((q) => revokeStatement(q, id, u.id));
    return { ok: true, record_id: r.record_id };
  });

  // Speaker changing their own decision later (from the exposure view)
  app.post('/statements/:id/decision', async (req) => {
    const u = await requireUser(req);
    const b = parse(z.object({ status: z.enum(['allowed', 'team_only', 'blocked']), embargo_until: z.string().datetime({ offset: true }).nullable().optional(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/).optional() }), req.body);
    const db = await getDb();
    const st = (await db.query('SELECT s.id, s.block_version_id, s.speaker_person_id, p.user_id FROM statements s JOIN persons p ON p.id=s.speaker_person_id WHERE s.id=$1', [(req.params as any).id]))[0];
    if (!st || st.user_id !== u.id) throw new HttpError(403, 'not_your_statement');
    const sig = b.signature && u.wallet_address ? { address: u.wallet_address as `0x${string}`, signatures: { [st.id]: b.signature as `0x${string}` } } : null;
    return db.tx((q) => applyDecisions(q, { personId: st.speaker_person_id, versionId: st.block_version_id, userId: u.id, via: 'app', signature: sig }, [{ statement_id: st.id, status: b.status, embargo_until: b.embargo_until }]));
  });

  app.get('/workspaces/:ws/persons', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const db = await getDb();
    await requireRole(db, u.id, ws, ANY);
    return db.query('SELECT id, display_name, user_id, is_external, contact_channel FROM persons WHERE workspace_id=$1 ORDER BY display_name', [ws]);
  });
  app.post('/workspaces/:ws/persons', async (req) => {
    const u = await requireUser(req);
    const { ws } = req.params as any;
    const b = parse(z.object({ display_name: z.string().min(1).max(100), email: z.string().email().optional() }), req.body);
    const db = await getDb();
    await requireRole(db, u.id, ws, EDITOR);
    const id = uuidv7();
    const kr = new KeyRing(db);
    let ct = null, nonce = null, keyId = null;
    if (b.email) { keyId = await getWorkspaceKey(db, ws, 'contact'); const e = await kr.encrypt(keyId, 'persons', id, b.email); ct = e.ct; nonce = e.nonce; }
    kr.wipe();
    await db.query('INSERT INTO persons(id, workspace_id, display_name, contact_channel, contact_address_ct, contact_nonce, data_key_id, is_external) VALUES ($1,$2,$3,$4,$5,$6,$7,true)', [id, ws, b.display_name, b.email ? 'email' : null, ct, nonce, keyId]);
    return { id };
  });
}
