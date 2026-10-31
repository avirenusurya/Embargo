/** Revoke + crypto-shredding (Part 13.3), statement revoke (K1), workspace deletion (Part 19.5). */
import fs from 'node:fs';
import path from 'node:path';
import { getDb, type Queryable } from '../db/index.ts';
import { destroyDataKeys, KeyRing } from '../crypto/keys.ts';
import { createRecord } from '../chain/records.ts';
import { deleteObject } from '../storage.ts';
import { enqueue, registerHandler } from '../jobs/queue.ts';
import { inApp, notify } from '../integrations/viasocket.ts';
import { config, DATA_DIR } from '../config.ts';
import { HttpError, log } from '../util.ts';
import * as tg from '../integrations/tigergraph.ts';

async function revokeCards(q: Queryable, ws: string, where: string, params: any[], note: string) {
  const cards = await q.query(`UPDATE cards SET revoked_at=now() WHERE revoked_at IS NULL AND ${where} RETURNING id, source_workspace_id, recipient_type, recipient_workspace_id`, params);
  for (const c of cards) if (c.recipient_type !== 'user')
    await createRecord(q, { workspace_id: c.source_workspace_id ?? ws, event: 'share_revoke', subject: { type: 'card', id: c.id }, recipient: { kind: c.recipient_type, id: c.recipient_workspace_id ?? c.id }, note });
  return cards.length;
}

export async function revokeBlock(q: Queryable, blockId: string, userId: string) {
  const b = (await q.query('SELECT * FROM blocks WHERE id=$1', [blockId]))[0];
  if (!b) throw new HttpError(404, 'not_found');
  if (b.status === 'revoked') return { ok: true, already: true };
  // 1. Stop serving immediately (gateway checks status in Postgres on every request)
  await q.query(`UPDATE blocks SET status='revoked', updated_at=now() WHERE id=$1`, [blockId]);
  const cardsRevoked = await revokeCards(q, b.workspace_id, '$1 = ANY(block_ids)', [blockId], 'Card revoked because a shared block was revoked');
  // Collection cards keep sharing the rest of the collection, but no longer reach this block.
  await q.query('DELETE FROM collection_blocks WHERE block_id=$1', [blockId]);
  const recordId = await createRecord(q, { workspace_id: b.workspace_id, event: 'revoke', subject: { type: 'block', id: blockId }, note: `Revoked by user ${userId}` });
  await enqueue(q, 'revoke.purge', { block_id: blockId });
  if (tg.enabled()) await enqueue(q, 'graph.sync', { entity: 'block', id: blockId });
  return { ok: true, record_id: recordId, cards_revoked: cardsRevoked };
}

/** Deletion certificate (K4) is shown to affected persons: speakers whose statements were in the destroyed block. */
async function notifySpeakers(q: Queryable, ws: string, blockId: string, title: string, recordId: string) {
  const link = `${config.appUrl}/verify/${recordId}`;
  const people = await q.query(`SELECT DISTINCT p.* FROM statements s JOIN block_versions v ON v.id=s.block_version_id JOIN persons p ON p.id=s.speaker_person_id WHERE v.block_id=$1`, [blockId]);
  const kr = new KeyRing(q);
  try {
    for (const p of people) {
      if (p.user_id) { await inApp(q, ws, p.user_id, 'deletion_certificate', `"${title}" (with your statements) was destroyed. Deletion certificate available.`, link); continue; }
      const contact = p.contact_address_ct ? await kr.decrypt(p.data_key_id, 'persons', p.id, p.contact_address_ct, p.contact_nonce).catch(() => null) : null;
      if (contact) await notify(q, ws, 'member.notify', { person_name: p.display_name, person_contact: contact, contact_channel: p.contact_channel, hint: 'A conversation containing your statements was destroyed', link }).catch(() => {});
    }
  } finally { kr.wipe(); }
}

export async function purge(p: { block_id: string }) {
  const db = await getDb();
  await db.tx(async (q) => {
    const b = (await q.query('SELECT * FROM blocks WHERE id=$1', [p.block_id]))[0];
    if (!b || b.status !== 'revoked') return;
    const versions = await q.query('SELECT id, data_key_id, original_object_key FROM block_versions WHERE block_id=$1', [p.block_id]);
    const vids = versions.map((v) => v.id);
    // 2. Destroy DEKs for all versions (every ciphertext incl. backups becomes unreadable)
    const destroyed = await destroyDataKeys(q, versions.map((v) => v.data_key_id));
    // 3. Derived data
    const secIds = (await q.query('SELECT id FROM block_sections WHERE block_version_id = ANY($1::uuid[])', [vids])).map((x) => x.id);
    const stIds = (await q.query('SELECT id FROM statements WHERE block_version_id = ANY($1::uuid[])', [vids])).map((x) => x.id);
    await q.query(`DELETE FROM embeddings WHERE owner_id = ANY($1::uuid[]) OR block_id = $2`, [[...secIds, ...stIds, p.block_id], p.block_id]);
    await q.query('DELETE FROM facts WHERE block_id=$1', [p.block_id]);
    await q.query(`UPDATE suggestions SET payload_ct=NULL, payload_nonce=NULL, status = CASE WHEN status='open' THEN 'superseded' ELSE status END WHERE $1 = ANY(target_block_ids) OR evidence->>'source_block_id' = $1::text`, [p.block_id]);
    await q.query('DELETE FROM usage_priors WHERE block_id=$1', [p.block_id]);
    await q.query('DELETE FROM sealed_blocks WHERE block_id=$1', [p.block_id]);
    await q.query('DELETE FROM collection_blocks WHERE block_id=$1', [p.block_id]);
    // Ciphertext rows are kept only as unreadable husks for audit; blank them anyway.
    await q.query(`UPDATE block_sections SET text_ct='\\x'::bytea WHERE block_version_id = ANY($1::uuid[])`, [vids]);
    await q.query(`UPDATE statements SET text_ct='\\x'::bytea, flag_reasons_ct=NULL WHERE block_version_id = ANY($1::uuid[])`, [vids]);
    await q.query(`UPDATE block_versions SET structured_ct=NULL WHERE block_id=$1`, [p.block_id]);
    // 4. Originals
    for (const v of versions) if (v.original_object_key) await deleteObject(v.original_object_key);
    // 5. Deletion certificate
    const rec = await createRecord(q, { workspace_id: b.workspace_id, event: 'key_destroyed', subject: { type: 'block', id: p.block_id, version: versions.length }, note: `${destroyed} data key(s) destroyed` });
    if (b.kind === 'conversation') await notifySpeakers(q, b.workspace_id, p.block_id, b.title, rec);
    log('info', 'revoke.purged', { block_id: p.block_id, keys: destroyed });
  });
}

/**
 * Statement revoke (K1). The statement shares its version's DEK, so instead of key destruction its ciphertext and
 * derived data (embeddings, facts, suggestion payloads from that conversation) are deleted. Stops serving at once.
 */
export async function revokeStatement(q: Queryable, statementId: string, userId: string) {
  const st = (await q.query(`SELECT s.id, s.revoked_at, s.block_version_id, v.version_no, v.content_hash, b.id AS block_id, b.workspace_id FROM statements s
     JOIN block_versions v ON v.id=s.block_version_id JOIN blocks b ON b.id=v.block_id WHERE s.id=$1`, [statementId]))[0];
  if (!st) throw new HttpError(404, 'not_found');
  if (st.revoked_at) return { ok: true, already: true, record_id: null };
  await q.query(`UPDATE statements SET revoked_at=now(), revoked_by=$2, status='blocked', text_ct='\\x'::bytea, flag_reasons_ct=NULL, flag_reasons_nonce=NULL WHERE id=$1`, [st.id, userId]);
  await q.query(`DELETE FROM embeddings WHERE owner_type='statement' AND owner_id=$1`, [st.id]);
  await q.query('DELETE FROM facts WHERE statement_id=$1', [st.id]);
  // Suggestions derived from this conversation may quote the statement: supersede and wipe their payloads.
  await q.query(`UPDATE suggestions SET payload_ct=NULL, payload_nonce=NULL, status='superseded', decided_at=now() WHERE status='open' AND (evidence->>'source_block_id' = $1::text OR $1::uuid = ANY(target_block_ids))`, [st.block_id]);
  await q.query(`UPDATE review_tokens SET used_at=now() WHERE used_at IS NULL AND block_version_id=$1 AND NOT EXISTS (SELECT 1 FROM statements s WHERE s.block_version_id=$1 AND s.status='held' AND s.revoked_at IS NULL)`, [st.block_version_id]);
  const recordId = await createRecord(q, { workspace_id: st.workspace_id, event: 'revoke', subject: { type: 'statement', id: st.id, version: st.version_no, content_hash: st.content_hash }, note: `Statement revoked by user ${userId}` });
  // The block-level embedding includes statement text: rebuild it from the remaining statements.
  await enqueue(q, 'revoke.reembed', { block_id: st.block_id });
  if (tg.enabled()) await enqueue(q, 'graph.sync', { entity: 'block', id: st.block_id });
  return { ok: true, record_id: recordId };
}

async function reembed(p: { block_id: string }) {
  const db = await getDb();
  const b = (await db.query('SELECT id, workspace_id, title, current_version_id, status FROM blocks WHERE id=$1', [p.block_id]))[0];
  if (!b || b.status === 'revoked' || !b.current_version_id) return;
  const { embed } = await import('../ai/llm.ts');
  const { readVersion } = await import('./content.ts');
  const { vec } = await import('../db/index.ts');
  const kr = new KeyRing(db);
  try {
    const v = await readVersion(db, kr, b.current_version_id);
    const text = [b.title, ...v.sections.map((s) => s.text), ...v.statements.filter((s) => !s.revoked_at).map((s) => s.text)].join('\n').slice(0, 24000);
    const [vector] = await embed([text]);
    await db.query(`UPDATE embeddings SET vector=$2::vector WHERE owner_type='block' AND owner_id=$1`, [b.id, vec(vector)]);
  } finally { kr.wipe(); }
}

/**
 * Workspace deletion (owner only): every DEK of the workspace is destroyed (blocks, contacts, integrations,
 * query logs, suggestions), content and derived data deleted, connections and cards revoked, memberships removed.
 * Records stay (they contain no content); key_destroyed records are the deletion certificates.
 */
export async function deleteWorkspace(q: Queryable, ws: string, userId: string) {
  const w = (await q.query('SELECT * FROM workspaces WHERE id=$1', [ws]))[0];
  if (!w || w.deleted_at) throw new HttpError(404, 'not_found');
  const blocks = await q.query(`SELECT id, status FROM blocks WHERE workspace_id=$1`, [ws]);
  await q.query(`UPDATE blocks SET status='revoked', updated_at=now() WHERE workspace_id=$1 AND status <> 'revoked'`, [ws]);
  await q.query(`UPDATE connections SET revoked_at=now() WHERE workspace_id=$1 AND revoked_at IS NULL`, [ws]);
  await revokeCards(q, ws, '(source_workspace_id=$1 OR recipient_workspace_id=$1)', [ws], 'Card revoked because the workspace was deleted');
  const objects = await q.query(`SELECT v.original_object_key FROM block_versions v JOIN blocks b ON b.id=v.block_id WHERE b.workspace_id=$1 AND v.original_object_key IS NOT NULL`, [ws]);
  const keys = await q.query(`SELECT id FROM data_keys WHERE workspace_id=$1 AND status='active'`, [ws]);
  const shredded = await destroyDataKeys(q, keys.map((k) => k.id));
  const vids = `SELECT v.id FROM block_versions v JOIN blocks b ON b.id=v.block_id WHERE b.workspace_id=$1`;
  for (const sql of [
    'DELETE FROM embeddings WHERE workspace_id=$1', 'DELETE FROM query_log_embeddings WHERE workspace_id=$1', 'DELETE FROM task_clusters WHERE workspace_id=$1',
    'DELETE FROM usage_priors WHERE workspace_id=$1', 'DELETE FROM facts WHERE workspace_id=$1', `DELETE FROM sealed_blocks WHERE block_id IN (SELECT id FROM blocks WHERE workspace_id=$1)`,
    'DELETE FROM integrations WHERE workspace_id=$1', 'DELETE FROM devices WHERE workspace_id=$1', 'DELETE FROM invites WHERE workspace_id=$1',
    `DELETE FROM review_tokens WHERE block_version_id IN (${vids})`, 'DELETE FROM notifications WHERE workspace_id=$1', 'DELETE FROM held_actions WHERE workspace_id=$1',
    `UPDATE suggestions SET payload_ct=NULL, payload_nonce=NULL, status=CASE WHEN status='open' THEN 'superseded' ELSE status END WHERE workspace_id=$1`,
    `UPDATE persons SET contact_address_ct=NULL, contact_nonce=NULL WHERE workspace_id=$1`,
    `UPDATE block_sections SET text_ct='\\x'::bytea WHERE block_version_id IN (${vids})`,
    `UPDATE statements SET text_ct='\\x'::bytea, flag_reasons_ct=NULL WHERE block_version_id IN (${vids})`,
    `UPDATE block_versions SET structured_ct=NULL WHERE block_id IN (SELECT id FROM blocks WHERE workspace_id=$1)`,
    `UPDATE billing SET status='workspace_deleted', updated_at=now() WHERE workspace_id=$1`,
    'DELETE FROM memberships WHERE workspace_id=$1',
  ]) await q.query(sql, [ws]);
  await q.query(`UPDATE workspaces SET deleted_at=now(), settings='{}', updated_at=now() WHERE id=$1`, [ws]);
  const recordIds: string[] = [];
  for (const b of blocks.filter((x) => x.status !== 'revoked'))
    recordIds.push(await createRecord(q, { workspace_id: ws, event: 'key_destroyed', subject: { type: 'block', id: b.id }, note: 'Workspace deleted' }));
  recordIds.push(await createRecord(q, { workspace_id: ws, event: 'key_destroyed', subject: { type: 'workspace', id: ws }, note: `Workspace deleted by user ${userId}; ${shredded} data key(s) destroyed` }));
  // Objects are unreadable without their keys; delete them anyway (local disk: the whole workspace prefix).
  for (const o of objects) await deleteObject(o.original_object_key).catch(() => {});
  if (!config.objectStorage.endpoint) fs.rmSync(path.join(DATA_DIR, 'objects', 'ws', ws), { recursive: true, force: true });
  if (tg.enabled()) for (const b of blocks) await enqueue(q, 'graph.sync', { entity: 'block', id: b.id });
  log('info', 'workspace.deleted', { ws, keys: shredded });
  return { ok: true as const, shredded_keys: shredded, record_ids: recordIds };
}

registerHandler('revoke.purge', purge);
registerHandler('revoke.reembed', reembed);
