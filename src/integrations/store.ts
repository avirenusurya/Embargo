/** Encrypted integration credentials (integrations table). */
import type { Queryable } from '../db/index.ts';
import { sealJson, openJson } from '../core/workspaceKeys.ts';
import { uuidv7 } from '../util.ts';

export type Provider = 'wispr' | 'github' | 'viasocket';

export async function getIntegration(q: Queryable, ws: string, provider: Provider) {
  const r = (await q.query('SELECT * FROM integrations WHERE workspace_id=$1 AND provider=$2', [ws, provider]))[0];
  if (!r) return null;
  const credentials = r.credentials_ct ? await openJson(q, r.data_key_id, 'integrations', r.id, r.credentials_ct, r.nonce) : null;
  return { id: r.id as string, status: r.status as string, meta: (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta) ?? {}, credentials };
}

export async function saveIntegration(q: Queryable, ws: string, provider: Provider, credentials: any, meta: any = {}, status = 'active') {
  const existing = (await q.query('SELECT id FROM integrations WHERE workspace_id=$1 AND provider=$2', [ws, provider]))[0];
  const id = existing?.id ?? uuidv7();
  const s = await sealJson(q, ws, 'integration', 'integrations', id, credentials);
  if (existing) await q.query('UPDATE integrations SET credentials_ct=$2, nonce=$3, data_key_id=$4, meta=$5, status=$6, updated_at=now() WHERE id=$1', [id, s.ct, s.nonce, s.keyId, JSON.stringify(meta), status]);
  else await q.query('INSERT INTO integrations(id, workspace_id, provider, credentials_ct, nonce, data_key_id, meta, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, ws, provider, s.ct, s.nonce, s.keyId, JSON.stringify(meta), status]);
  return id;
}

export async function setIntegrationStatus(q: Queryable, ws: string, provider: Provider, status: string) {
  await q.query('UPDATE integrations SET status=$3, updated_at=now() WHERE workspace_id=$1 AND provider=$2', [ws, provider, status]);
}
