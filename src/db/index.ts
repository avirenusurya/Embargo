import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, DATA_DIR } from '../config.ts';

export interface Queryable {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
}
export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'pglite' | 'pg';
}

let dbPromise: Promise<Db> | null = null;

async function openPglite(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const dir = path.join(DATA_DIR, 'pg');
  fs.mkdirSync(dir, { recursive: true });
  const pg = await PGlite.create(dir, { extensions: { vector } });
  // PGlite is single-connection: serialise work so concurrent requests don't interleave. Calls made while a
  // transaction is open in the same async context are routed into that transaction (no self-deadlock).
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const als = new AsyncLocalStorage<{ query: (s: string, p?: any[]) => Promise<any[]> }>();
  let chain: Promise<unknown> = Promise.resolve();
  const lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
  return {
    kind: 'pglite',
    query: (sql, params) => { const t = als.getStore(); return t ? t.query(sql, params) : lock(() => q(sql, params)); },
    tx: (fn) => {
      const t = als.getStore();
      if (t) return fn(t); // nested: join the open transaction
      return lock(() => pg.transaction(async (tr) => {
        const tq = { query: async (s: string, p: any[] = []) => (await tr.query(s, p)).rows as any[] };
        return als.run(tq, () => fn(tq));
      }));
    },
    close: () => pg.close(),
  };
}

async function openPg(): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  return {
    kind: 'pg',
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    tx: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn({ query: async (s, p = []) => (await c.query(s, p)).rows });
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

export function getDb(): Promise<Db> {
  if (!dbPromise) dbPromise = (config.databaseUrl ? openPg() : openPglite()).then(async (db) => { await migrate(db); return db; });
  return dbPromise;
}

export async function migrate(db: Db) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await db.tx(async (q) => {
      for (const stmt of splitSql(sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
  }
}

function splitSql(sql: string): string[] {
  return sql.split(/;\s*$/m).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
}

/** pgvector literal */
export const vec = (v: number[] | Float32Array) => '[' + Array.from(v).map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',') + ']';
export const parseVec = (s: string | number[]): number[] => (Array.isArray(s) ? s : JSON.parse(s));
