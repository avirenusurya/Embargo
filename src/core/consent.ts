/** Consent flow for conversations (Part 12.5). */
import { getDb, type Queryable } from '../db/index.ts';
import { KeyRing } from '../crypto/keys.ts';
import { createRecord } from '../chain/records.ts';
import { notify, inApp, notifyAdmins } from '../integrations/viasocket.ts';
import { enqueue, registerHandler } from '../jobs/queue.ts';
import { config, isDev } from '../config.ts';
import { randomToken, hashToken, uuidv7, HttpError, log } from '../util.ts';
import * as tg from '../integrations/tigergraph.ts';

const RANK: Record<string, number> = { allowed: 3, team_only: 2, held: 1, blocked: 0 };

export async function issueReviewLink(q: Queryable, personId: string, versionId: string, hours: number) {
  const token = randomToken('rv');
  await q.query('INSERT INTO review_tokens(token_hash, person_id, block_version_id, expires_at) VALUES ($1,$2,$3, now() + ($4 || \' hours\')::interval)', [hashToken(token), personId, versionId, String(hours)]);
  return `${config.appUrl}/review/${token}`;
}

export async function dispatchConsent(p: { block_id: string; version_id: string; workspace_id: string }) {
  const q = await getDb();
  const ws = (await q.query('SELECT settings FROM workspaces WHERE id=$1', [p.workspace_id]))[0];
  const hours = Number(ws?.settings?.review_deadline_hours ?? 48);
  const block = (await q.query('SELECT title, owner_id FROM blocks WHERE id=$1', [p.block_id]))[0];
  const groups = await q.query(`SELECT speaker_person_id AS pid, COUNT(*)::int AS n FROM statements WHERE block_version_id=$1 AND status='held' GROUP BY speaker_person_id`, [p.version_id]);
  const kr = new KeyRing(q);
  try {
    for (const g of groups) {
      if (!g.pid) { await inApp(q, p.workspace_id, block.owner_id, 'assign_speakers', `${g.n} flagged lines in "${block.title}" need a speaker assigned before review`, `/app#blocks/${p.block_id}`); continue; }
      const open = (await q.query(`SELECT 1 FROM review_tokens WHERE person_id=$1 AND block_version_id=$2 AND used_at IS NULL AND expires_at > now()`, [g.pid, p.version_id]))[0];
      if (open) continue;
      const person = (await q.query('SELECT * FROM persons WHERE id=$1', [g.pid]))[0];
      const link = await issueReviewLink(q, g.pid, p.version_id, hours);
      const member = person.user_id ? (await q.query('SELECT 1 FROM memberships WHERE user_id=$1 AND workspace_id=$2', [person.user_id, p.workspace_id]))[0] : null;
      if (member) {
        await inApp(q, p.workspace_id, person.user_id, 'review', `${g.n} of your lines in "${block.title}" need your decision`, link);
        await notify(q, p.workspace_id, 'member.notify', { user_id: person.user_id, hint: `${g.n} of your lines need review`, link }).catch(() => {});
      } else {
        const contact = person.contact_address_ct ? await kr.decrypt(person.data_key_id, 'persons', person.id, person.contact_address_ct, person.contact_nonce) : null;
        const r = await notify(q, p.workspace_id, 'review.requested', { person_name: person.display_name, person_contact: contact, contact_channel: person.contact_channel, link, block_title_hint: block.title, count: g.n })
          .catch((e) => { log('warn', 'consent.notify_failed', { err: e.message }); return { delivered: false }; });
        if (!r.delivered) await notifyAdmins(q, p.workspace_id, 'suggestion.created', 'review_undelivered', `Could not send a review link to ${person.display_name}; share it manually from the conversation page`, `/app#blocks/${p.block_id}`);
      }
      if (isDev) log('info', 'consent.review_link', { person: person.display_name, link });
    }
  } finally { kr.wipe(); }
}

export async function reviewView(q: Queryable, token: string) {
  const t = (await q.query('SELECT * FROM review_tokens WHERE token_hash=$1', [hashToken(token)]))[0];
  if (!t || t.used_at || new Date(t.expires_at) < new Date()) throw new HttpError(410, 'link_expired', 'This review link has expired or was already used');
  const person = (await q.query('SELECT id, display_name FROM persons WHERE id=$1', [t.person_id]))[0];
  const ver = (await q.query('SELECT v.id, b.title, b.workspace_id, b.status FROM block_versions v JOIN blocks b ON b.id=v.block_id WHERE v.id=$1', [t.block_version_id]))[0];
  if (ver.status === 'revoked') throw new HttpError(410, 'revoked');
  const rows = await q.query(`SELECT * FROM statements WHERE block_version_id=$1 AND speaker_person_id=$2 AND revoked_at IS NULL AND (status='held' OR array_length(flags,1) > 0) ORDER BY ordinal`, [t.block_version_id, t.person_id]);
  const kr = new KeyRing(q);
  try {
    const statements = [];
    for (const r of rows) statements.push({
      id: r.id, text: await kr.decrypt(r.data_key_id, 'statements', r.id, r.text_ct, r.nonce), status: r.status,
      reasons: r.flag_reasons_ct ? await kr.decryptJson(r.data_key_id, 'statements.flag_reasons', r.id, r.flag_reasons_ct, r.flag_reasons_nonce) : [],
    });
    return { person: person.display_name, conversation: ver.title, expires_at: t.expires_at, statements };
  } finally { kr.wipe(); }
}

export type DecisionIn = { statement_id: string; status: 'allowed' | 'team_only' | 'blocked'; embargo_until?: string | null };

/** Applies speaker decisions; creates consent / consent_withdraw records. */
export async function applyDecisions(q: Queryable, ctx: { personId: string; versionId: string; userId: string | null; via: 'link' | 'app'; signature?: { address: `0x${string}`; signatures: Record<string, `0x${string}`> } | null }, decisions: DecisionIn[]) {
  if (!decisions.length) throw new HttpError(400, 'empty');
  const ver = (await q.query('SELECT v.id, v.block_id, v.version_no, v.content_hash, b.workspace_id FROM block_versions v JOIN blocks b ON b.id=v.block_id WHERE v.id=$1', [ctx.versionId]))[0];
  const out = [];
  for (const d of decisions) {
    if (!['allowed', 'team_only', 'blocked'].includes(d.status)) throw new HttpError(400, 'bad_status');
    const st = (await q.query('SELECT id, status FROM statements WHERE id=$1 AND block_version_id=$2 AND speaker_person_id=$3 AND revoked_at IS NULL', [d.statement_id, ctx.versionId, ctx.personId]))[0];
    if (!st) throw new HttpError(403, 'not_your_statement');
    const emb = d.embargo_until ? new Date(d.embargo_until) : null;
    if (emb && isNaN(emb.getTime())) throw new HttpError(400, 'bad_date');
    await q.query('UPDATE statements SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1', [st.id, d.status, ctx.userId]);
    if (emb || st.status !== 'held') {
      await q.query(`INSERT INTO rules(id, workspace_id, target_type, target_id, visibility, embargo_until, set_by) VALUES ($1,$2,'statement',$3,$4,$5,$6)`,
        [uuidv7(), ver.workspace_id, st.id, 'team', emb, ctx.userId]);
    }
    const withdraw = d.status === 'blocked' || (st.status !== 'held' && RANK[d.status] < RANK[st.status]);
    const sig = ctx.signature?.signatures?.[st.id];
    const recordId = await createRecord(q, {
      workspace_id: ver.workspace_id, event: withdraw ? 'consent_withdraw' : 'consent',
      subject: { type: 'statement', id: st.id, version: ver.version_no, content_hash: ver.content_hash },
      scope: { statement_status: emb ? 'embargo' : d.status, embargo: !!emb }, effective_at: emb ?? new Date(),
      user: sig && ctx.signature ? { address: ctx.signature.address, signature: sig } : null,
      note: ctx.via === 'link' ? 'Decision made through a single-use review link; recorded and signed by Embargo on the speaker\'s behalf' : 'Decision made in app',
    });
    out.push({ statement_id: st.id, status: d.status, record_id: recordId });
  }
  await enqueue(q, 'cm.on_change', { block_id: ver.block_id, version_id: ver.id, workspace_id: ver.workspace_id });
  if (tg.enabled()) await enqueue(q, 'graph.sync', { entity: 'block', id: ver.block_id });
  return out;
}

export async function submitReview(token: string, decisions: DecisionIn[], signature?: any) {
  const db = await getDb();
  return db.tx(async (q) => {
    // Lock + single use: the UPDATE succeeds only once.
    const t = (await q.query(`UPDATE review_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING *`, [hashToken(token)]))[0];
    if (!t) throw new HttpError(410, 'link_expired', 'This review link has expired or was already used');
    const person = (await q.query('SELECT user_id FROM persons WHERE id=$1', [t.person_id]))[0];
    return applyDecisions(q, { personId: t.person_id, versionId: t.block_version_id, userId: person?.user_id ?? null, via: 'link', signature }, decisions);
  });
}

/** Hourly: held statements past the deadline → workspace.unreviewed_default. */
export async function enforceDeadlines() {
  const q = await getDb();
  for (const w of await q.query('SELECT id, settings FROM workspaces')) {
    const def = w.settings?.unreviewed_default ?? 'blocked';
    if (def === 'held') continue;
    const hours = Number(w.settings?.review_deadline_hours ?? 48);
    await q.query(`UPDATE statements s SET status=$2, decided_at=now() FROM block_versions v JOIN blocks b ON b.id=v.block_id
                   WHERE s.block_version_id=v.id AND b.workspace_id=$1 AND s.status='held' AND s.speaker_person_id IS NOT NULL AND v.created_at < now() - ($3 || ' hours')::interval`, [w.id, def, String(hours)]);
  }
}

/** Hourly: reviewers who haven't acted by half the deadline get one reminder with a fresh single-use link (same deadline). */
export async function reviewReminders() {
  const q = await getDb();
  const rows = await q.query(`SELECT DISTINCT ON (t.person_id, t.block_version_id) t.person_id, t.block_version_id, t.expires_at, b.id AS block_id, b.workspace_id, b.title
    FROM review_tokens t JOIN block_versions v ON v.id=t.block_version_id JOIN blocks b ON b.id=v.block_id AND b.current_version_id=v.id
    WHERE t.used_at IS NULL AND t.reminded_at IS NULL AND t.expires_at > now() AND b.status <> 'revoked'
      AND now() > t.created_at + (t.expires_at - t.created_at) / 2
      AND EXISTS (SELECT 1 FROM statements s WHERE s.block_version_id=t.block_version_id AND s.speaker_person_id=t.person_id AND s.status='held' AND s.revoked_at IS NULL)
    ORDER BY t.person_id, t.block_version_id, t.expires_at DESC LIMIT 200`);
  const kr = new KeyRing(q);
  let sent = 0;
  try {
    for (const r of rows) {
      const hours = Math.max(1, Math.ceil((new Date(r.expires_at).getTime() - Date.now()) / 3600000));
      const link = await issueReviewLink(q, r.person_id, r.block_version_id, hours);
      // Marks the old and the new link as reminded, so each review gets one reminder.
      await q.query('UPDATE review_tokens SET reminded_at=now() WHERE person_id=$1 AND block_version_id=$2 AND used_at IS NULL', [r.person_id, r.block_version_id]);
      const person = (await q.query('SELECT * FROM persons WHERE id=$1', [r.person_id]))[0];
      const n = (await q.query(`SELECT COUNT(*)::int AS n FROM statements WHERE block_version_id=$1 AND speaker_person_id=$2 AND status='held'`, [r.block_version_id, r.person_id]))[0].n;
      const member = person.user_id ? (await q.query('SELECT 1 FROM memberships WHERE user_id=$1 AND workspace_id=$2', [person.user_id, r.workspace_id]))[0] : null;
      if (member) {
        await inApp(q, r.workspace_id, person.user_id, 'review_reminder', `Reminder: ${n} of your lines in "${r.title}" still need your decision`, link);
        await notify(q, r.workspace_id, 'member.notify', { user_id: person.user_id, hint: `Reminder: ${n} of your lines need review`, link, reminder: true }).catch(() => {});
      } else {
        const contact = person.contact_address_ct ? await kr.decrypt(person.data_key_id, 'persons', person.id, person.contact_address_ct, person.contact_nonce) : null;
        await notify(q, r.workspace_id, 'review.requested', { person_name: person.display_name, person_contact: contact, contact_channel: person.contact_channel, link, block_title_hint: r.title, count: n, reminder: true }).catch(() => {});
      }
      sent++;
    }
  } finally { kr.wipe(); }
  return sent;
}

registerHandler('consent.dispatch', dispatchConsent);
registerHandler('consent.deadlines', enforceDeadlines);
registerHandler('consent.reminders', async () => { await reviewReminders(); });
