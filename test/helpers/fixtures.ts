/** Direct-to-database fixtures for unit tests (import only after setupEnv()). */
import type { Queryable } from '../../src/db/index.ts';

export async function mkUser(q: Queryable, name = 'User') {
  const { uuidv7 } = await import('../../src/util.ts');
  const id = uuidv7();
  await q.query('INSERT INTO users(id, display_name, email) VALUES ($1,$2,$3)', [id, name, `${id}@test.local`]);
  return id;
}

export async function mkWorkspace(q: Queryable, ownerId: string, name = 'WS') {
  const { uuidv7 } = await import('../../src/util.ts');
  const id = uuidv7();
  await q.query('INSERT INTO workspaces(id, name, owner_id, settings) VALUES ($1,$2,$3,$4)', [id, name, ownerId, JSON.stringify({ review_mode: 'flagged', unreviewed_default: 'blocked', review_deadline_hours: 48 })]);
  await q.query(`INSERT INTO memberships(user_id, workspace_id, role) VALUES ($1,$2,'owner')`, [ownerId, id]);
  return id;
}

export async function addMember(q: Queryable, ws: string, userId: string, role: string) {
  await q.query('INSERT INTO memberships(user_id, workspace_id, role) VALUES ($1,$2,$3) ON CONFLICT (user_id, workspace_id) DO UPDATE SET role=EXCLUDED.role', [userId, ws, role]);
}

/** Creates an active block with a structured version written through the real encrypting writer. */
export async function mkBlock(q: Queryable, o: {
  ws: string; owner: string; title: string; sections?: { heading: string; text: string }[]; summary?: string; decisions?: string[];
  facts?: { entity: string; attribute: string; value: string }[]; access_mode?: 'viewable' | 'agent_only' | 'sealed_use'; visibility?: string;
  pinned?: boolean; status?: string; statements?: { speaker_label: string; text: string; status?: string; speaker_person_id?: string | null }[];
  embed?: boolean;
}) {
  const { createBlock, writeVersion } = await import('../../src/core/content.ts');
  const { KeyRing } = await import('../../src/crypto/keys.ts');
  const { embed } = await import('../../src/ai/llm.ts');
  const { vec } = await import('../../src/db/index.ts');
  const { uuidv7 } = await import('../../src/util.ts');
  const id = await createBlock(q, { workspaceId: o.ws, ownerId: o.owner, kind: o.statements ? 'conversation' : 'note', title: o.title, accessMode: o.access_mode, visibility: o.visibility, status: o.status ?? 'active' });
  if (o.pinned) await q.query('UPDATE blocks SET pinned=true WHERE id=$1', [id]);
  const kr = new KeyRing(q);
  const w = await writeVersion(q, kr, {
    blockId: id, workspaceId: o.ws, createdBy: o.owner, statements: o.statements,
    structured: { title: o.title, summary: o.summary ?? '', sections: o.sections ?? [], facts: o.facts ?? [], decisions: o.decisions ?? [], open_questions: [] },
  });
  kr.wipe();
  if (o.embed !== false) {
    const units = [
      ...w.sections.map((s) => ({ type: 'section', id: s.id, text: `${o.title} — ${s.heading}\n${s.text}` })),
      ...w.statements.map((s, i) => ({ type: 'statement', id: s.id, text: `${o.statements![i].speaker_label}: ${s.text}` })),
    ];
    const vs = await embed(units.map((u) => u.text));
    for (let i = 0; i < units.length; i++) await q.query('INSERT INTO embeddings(id, workspace_id, owner_type, owner_id, block_id, vector) VALUES ($1,$2,$3,$4,$5,$6::vector)', [uuidv7(), o.ws, units[i].type, units[i].id, id, vec(vs[i])]);
  }
  return { id, versionId: w.versionId, dekId: w.dekId, sections: w.sections, statements: w.statements };
}

export async function setRule(q: Queryable, ws: string, blockId: string, r: Record<string, any>) {
  const { uuidv7 } = await import('../../src/util.ts');
  await q.query(`INSERT INTO rules(id, workspace_id, target_type, target_id, visibility, partner_workspace_id, allowed_connection_ids, purposes, expires_at, embargo_until, answer_policy)
    VALUES ($1,$2,'block',$3,$4,$5,$6,$7,$8,$9,$10)`, [uuidv7(), ws, blockId, r.visibility ?? 'team', r.partner_workspace_id ?? null, r.allowed_connection_ids ?? null, r.purposes ?? null, r.expires_at ?? null, r.embargo_until ?? null, r.answer_policy ?? 'facts_only']);
}
