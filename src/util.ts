import crypto from 'node:crypto';

/** UUIDv7: 48-bit ms timestamp + random. Sortable by creation time. */
export function uuidv7(): string {
  const b = crypto.randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (prefix: string) => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
export const hashToken = (t: string) => sha256(t);

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra?: Record<string, unknown>) {
    super(message ?? code);
  }
}

export const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  // Structured logs. Never pass plaintext content or tokens here (Part 22.3).
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line); else console.log(line);
}
// Rate limiting is Postgres-backed so it holds across instances: see core/limits.ts.

export function wordTokens(s: string): string[] {
  return s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}₹$€%.@/-]+/gu)?.map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, '')).filter(Boolean) ?? [];
}
