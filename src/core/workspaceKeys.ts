/** Long-lived per-workspace DEKs for non-block data (integration credentials, contacts, query logs, suggestion payloads). */
import type { Queryable } from '../db/index.ts';
import { createDataKey, KeyRing } from '../crypto/keys.ts';

export async function getWorkspaceKey(q: Queryable, ws: string, purpose: string): Promise<string> {
  const r = (await q.query(`SELECT id FROM data_keys WHERE workspace_id=$1 AND purpose=$2 AND status='active' ORDER BY created_at DESC LIMIT 1`, [ws, purpose]))[0];
  return r ? r.id : createDataKey(q, ws, purpose);
}

export async function sealJson(q: Queryable, ws: string, purpose: string, table: string, rowId: string, value: unknown) {
  const keyId = await getWorkspaceKey(q, ws, purpose);
  const kr = new KeyRing(q);
  try { const e = await kr.encrypt(keyId, table, rowId, JSON.stringify(value)); return { ct: e.ct, nonce: e.nonce, keyId }; } finally { kr.wipe(); }
}
export async function openJson<T = any>(q: Queryable, keyId: string, table: string, rowId: string, ct: any, nonce: any): Promise<T> {
  const kr = new KeyRing(q);
  try { return await kr.decryptJson<T>(keyId, table, rowId, ct, nonce); } finally { kr.wipe(); }
}
