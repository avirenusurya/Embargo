/** Object storage for encrypted originals. S3-compatible (R2/S3) when configured, local disk otherwise. */
import fs from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.ts';
import { sigv4Fetch } from './integrations/sigv4.ts';

const s3 = config.objectStorage;
const useS3 = !!(s3.endpoint && s3.bucket && s3.key && s3.secret);
const localDir = path.join(DATA_DIR, 'objects');
const safe = (key: string) => { if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes('..')) throw new Error('bad object key'); return key; };
const url = (key: string) => `${s3.endpoint.replace(/\/$/, '')}/${s3.bucket}/${safe(key)}`;
const sign = (method: string, key: string, body?: Buffer) =>
  sigv4Fetch({ method, url: url(key), service: 's3', region: s3.region, accessKey: s3.key, secretKey: s3.secret, body });

export async function putObject(key: string, data: Buffer) {
  if (useS3) { const r = await sign('PUT', key, data); if (!r.ok) throw new Error(`object put failed ${r.status}`); return; }
  const p = path.join(localDir, safe(key));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
export async function getObject(key: string): Promise<Buffer | null> {
  if (useS3) { const r = await sign('GET', key); if (r.status === 404) return null; if (!r.ok) throw new Error(`object get failed ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
  const p = path.join(localDir, safe(key));
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}
export async function deleteObject(key: string) {
  if (useS3) { await sign('DELETE', key); return; }
  fs.rmSync(path.join(localDir, safe(key)), { force: true });
}
