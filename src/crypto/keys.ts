/**
 * Envelope encryption (Part 13.2) and crypto-shredding (13.3).
 * KEK per workspace (local HKDF from master, or AWS KMS). DEK per block version, stored wrapped.
 * AES-256-GCM, random 96-bit nonce, AAD = {workspace_id, table, row_id}.
 */
import crypto from 'node:crypto';
import { config } from '../config.ts';
import type { Queryable } from '../db/index.ts';
import { uuidv7, HttpError } from '../util.ts';
import { sigv4Fetch } from '../integrations/sigv4.ts';

const master = Buffer.from(config.keys.localMasterKey, 'base64');
if (master.length !== 32) throw new Error('LOCAL_MASTER_KEY must be base64 of 32 bytes');

const hkdf = (ikm: Buffer, salt: string, info: string) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from(salt), Buffer.from(info), 32));

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: string) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { ct, nonce };
}
function gcmDecrypt(key: Buffer, ct: Buffer, nonce: Buffer, aad: string) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

// ---------- Key providers ----------
interface KeyProvider {
  kekId(workspaceId: string): string;
  wrap(workspaceId: string, dekId: string, dek: Buffer): Promise<Buffer>;
  unwrap(workspaceId: string, dekId: string, wrapped: Buffer): Promise<Buffer>;
}

const localProvider: KeyProvider = {
  kekId: (ws) => `local:v1:${ws}`,
  async wrap(ws, dekId, dek) {
    const { ct, nonce } = gcmEncrypt(hkdf(master, ws, 'embargo-kek-v1'), dek, `dek:${dekId}`);
    return Buffer.concat([nonce, ct]);
  },
  async unwrap(ws, dekId, wrapped) {
    return gcmDecrypt(hkdf(master, ws, 'embargo-kek-v1'), wrapped.subarray(12), wrapped.subarray(0, 12), `dek:${dekId}`);
  },
};

async function kmsCall(target: string, body: any) {
  const res = await sigv4Fetch({
    method: 'POST', url: `https://kms.${config.keys.kmsRegion}.amazonaws.com/`, service: 'kms', region: config.keys.kmsRegion,
    accessKey: process.env.AWS_ACCESS_KEY_ID ?? '', secretKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `TrentService.${target}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(503, 'unavailable', `KMS ${target} failed: ${res.status}`);
  return res.json() as any;
}
const kmsProvider: KeyProvider = {
  kekId: () => `kms:${config.keys.kmsKeyId}`,
  async wrap(ws, dekId, dek) {
    const r = await kmsCall('Encrypt', { KeyId: config.keys.kmsKeyId, Plaintext: dek.toString('base64'), EncryptionContext: { workspace_id: ws, dek_id: dekId } });
    return Buffer.from(r.CiphertextBlob, 'base64');
  },
  async unwrap(ws, dekId, wrapped) {
    const r = await kmsCall('Decrypt', { CiphertextBlob: wrapped.toString('base64'), EncryptionContext: { workspace_id: ws, dek_id: dekId } });
    return Buffer.from(r.Plaintext, 'base64');
  },
};
const provider: KeyProvider = config.keys.provider === 'kms' ? kmsProvider : localProvider;

// ---------- Key service ----------
export async function createDataKey(q: Queryable, workspaceId: string, purpose = 'block'): Promise<string> {
  const w = (await q.query('SELECT deleted_at FROM workspaces WHERE id=$1', [workspaceId]))[0];
  if (w?.deleted_at) throw new HttpError(410, 'workspace_deleted', 'Workspace was deleted');
  const id = uuidv7();
  const dek = crypto.randomBytes(32);
  const wrapped = await provider.wrap(workspaceId, id, dek);
  await q.query('INSERT INTO data_keys(id, workspace_id, wrapped_key, kek_id, purpose) VALUES ($1,$2,$3,$4,$5)', [id, workspaceId, wrapped, provider.kekId(workspaceId), purpose]);
  return id;
}

/** Destroy DEKs: wrapped key overwritten (NULL) so every ciphertext under them, including backups, becomes unreadable. */
export async function destroyDataKeys(q: Queryable, ids: string[]) {
  if (!ids.length) return 0;
  const r = await q.query(`UPDATE data_keys SET wrapped_key = NULL, status='destroyed', destroyed_at=now() WHERE id = ANY($1::uuid[]) AND status='active' RETURNING id`, [ids]);
  return r.length;
}

/**
 * A KeyRing caches unwrapped DEKs for the lifetime of ONE request/job, then is discarded.
 * Plaintext keys and content never persist beyond the request.
 */
export class KeyRing {
  private cache = new Map<string, Buffer>();
  constructor(private q: Queryable) {}
  async dek(id: string): Promise<{ key: Buffer; ws: string }> {
    const row = (await this.q.query('SELECT workspace_id, wrapped_key, status FROM data_keys WHERE id=$1', [id]))[0];
    if (!row) throw new HttpError(500, 'key_missing');
    if (row.status !== 'active' || !row.wrapped_key) throw new HttpError(410, 'key_destroyed', 'Content was destroyed');
    let k = this.cache.get(id);
    if (!k) { k = await provider.unwrap(row.workspace_id, id, Buffer.from(row.wrapped_key)); this.cache.set(id, k); }
    return { key: k, ws: row.workspace_id };
  }
  async encrypt(dekId: string, table: string, rowId: string, plaintext: string | Buffer) {
    const { key, ws } = await this.dek(dekId);
    return gcmEncrypt(key, Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8'), aad(ws, table, rowId));
  }
  async decryptBuf(dekId: string, table: string, rowId: string, ct: Buffer | Uint8Array, nonce: Buffer | Uint8Array) {
    const { key, ws } = await this.dek(dekId);
    return gcmDecrypt(key, Buffer.from(ct), Buffer.from(nonce), aad(ws, table, rowId));
  }
  async decrypt(dekId: string, table: string, rowId: string, ct: Buffer | Uint8Array, nonce: Buffer | Uint8Array) {
    return (await this.decryptBuf(dekId, table, rowId, ct, nonce)).toString('utf8');
  }
  async decryptJson<T = any>(dekId: string, table: string, rowId: string, ct: any, nonce: any): Promise<T> {
    return JSON.parse(await this.decrypt(dekId, table, rowId, ct, nonce));
  }
  wipe() { for (const k of this.cache.values()) k.fill(0); this.cache.clear(); }
}
const aad = (ws: string, table: string, rowId: string) => JSON.stringify({ workspace_id: ws, table, row_id: rowId });

// ---------- Keyed hashes ----------
/** facts.value_hash: HMAC(workspace_fact_key, normalised_value) — equality without plaintext. */
export function factValueHash(workspaceId: string, value: string) {
  return crypto.createHmac('sha256', hkdf(master, workspaceId, 'embargo-fact-v1')).update(normaliseValue(value)).digest('hex');
}
export function normaliseValue(v: string) {
  // Collapse and trim whitespace first so the trailing-punctuation and leading-article rules see the value's real ends.
  // For values without surrounding whitespace the leading trim is a no-op, so their stored hashes are unchanged.
  return v.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/[.,;!]+$/, '').replace(/^(the|a|an)\s+/, '').trim();
}
const recordGlobal = Buffer.from(config.keys.recordHmacGlobalKey, 'base64');
export const workspaceRecordKey = (ws: string) => hkdf(recordGlobal, ws, 'embargo-record-v1');
export const hmacHex = (key: Buffer, data: string) => '0x' + crypto.createHmac('sha256', key).update(data).digest('hex');
export const recordWorkspaceHash = (ws: string) => hmacHex(recordGlobal, `workspace|${ws}`);
export const recordRecipientHash = (kind: string, id: string) => hmacHex(recordGlobal, `${kind}|${id}`);
