/**
 * Connection-token endpoints used by the local MCP package for sealed blocks and device keys.
 * Only ciphertext and wrapped keys pass through here.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.ts';
import { authenticateConnection } from '../../mcp/gateway.ts';
import { createBlock } from '../../core/content.ts';
import { revokeBlock } from '../../core/revoke.ts';
import { parse } from '../http.ts';
import { HttpError, uuidv7 } from '../../util.ts';

async function conn(req: FastifyRequest) {
  const a = String(req.headers.authorization ?? '');
  return authenticateConnection(await getDb(), a.startsWith('Bearer ') ? a.slice(7) : '');
}

export default async function mcpLocalRoutes(app: FastifyInstance) {
  app.get('/mcp-local/whoami', async (req) => { const r = await conn(req); return { workspace_id: r.workspace_id, connection_id: r.id, scopes: r.scopes }; });

  app.get('/mcp-local/sealed-blocks', async (req) => {
    const r = await conn(req);
    const db = await getDb();
    return db.query(`SELECT b.id, b.title, s.ciphertext, s.wrapped_dek, s.nonce, s.updated_at FROM blocks b JOIN sealed_blocks s ON s.block_id=b.id
      WHERE b.workspace_id=$1 AND b.status='active' AND (b.owner_id=$2 OR NOT EXISTS (SELECT 1 FROM rules ru WHERE ru.target_type='block' AND ru.target_id=b.id AND ru.visibility='private'))`, [r.workspace_id, r.user_id]);
  });
  app.get('/mcp-local/sealed-blocks/revoked', async (req) => {
    const r = await conn(req);
    return (await getDb()).query(`SELECT id FROM blocks WHERE workspace_id=$1 AND storage_mode='sealed_block' AND status='revoked'`, [r.workspace_id]);
  });
  app.post('/mcp-local/sealed-blocks', async (req) => {
    const r = await conn(req);
    if (!r.scopes.includes('write_blocks')) throw new HttpError(403, 'forbidden_scope', 'Token lacks write_blocks scope');
    const b = parse(z.object({ ciphertext: z.string().min(1), wrapped_dek: z.string().min(1), nonce: z.string().min(1), title: z.string().max(200).optional() }), req.body);
    const db = await getDb();
    return db.tx(async (q) => {
      const id = await createBlock(q, { workspaceId: r.workspace_id!, ownerId: r.user_id!, kind: 'note', title: b.title || 'Sealed block', storageMode: 'sealed_block', status: 'active' });
      await q.query('INSERT INTO sealed_blocks(block_id, ciphertext, wrapped_dek, nonce) VALUES ($1,$2,$3,$4)', [id, b.ciphertext, b.wrapped_dek, b.nonce]);
      return { block_id: id };
    });
  });
  app.delete('/mcp-local/sealed-blocks/:id', async (req) => {
    const r = await conn(req);
    const db = await getDb();
    const b = (await db.query(`SELECT * FROM blocks WHERE id=$1 AND workspace_id=$2 AND storage_mode='sealed_block'`, [(req.params as any).id, r.workspace_id]))[0];
    if (!b || b.owner_id !== r.user_id) throw new HttpError(404, 'not_found');
    return db.tx(async (q) => { await q.query('DELETE FROM sealed_blocks WHERE block_id=$1', [b.id]); return revokeBlock(q, b.id, r.user_id!); });
  });

  app.get('/mcp-local/devices', async (req) => {
    const r = await conn(req);
    return (await getDb()).query('SELECT id, label, public_key, wrapped_wsk, approved_at FROM devices WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at', [r.workspace_id, r.user_id]);
  });
  app.post('/mcp-local/devices', async (req) => {
    const r = await conn(req);
    const b = parse(z.object({ label: z.string().min(1).max(80), public_key: z.string().min(1).max(500), wrapped_wsk: z.string().max(2000).optional() }), req.body);
    const id = uuidv7();
    await (await getDb()).query('INSERT INTO devices(id, workspace_id, user_id, label, public_key, wrapped_wsk, approved_by, approved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, r.workspace_id, r.user_id, b.label, b.public_key, b.wrapped_wsk ?? null, b.wrapped_wsk ? r.user_id : null, b.wrapped_wsk ? new Date() : null]);
    return { device_id: id };
  });
  app.post('/mcp-local/devices/:id/approve', async (req) => {
    const r = await conn(req);
    const { wrapped_wsk } = parse(z.object({ wrapped_wsk: z.string().min(20).max(2000) }), req.body);
    const rows = await (await getDb()).query('UPDATE devices SET wrapped_wsk=$3, approved_by=$2, approved_at=now() WHERE id=$1 AND user_id=$2 RETURNING id', [(req.params as any).id, r.user_id, wrapped_wsk]);
    if (!rows.length) throw new HttpError(404, 'not_found');
    return { ok: true };
  });
}
