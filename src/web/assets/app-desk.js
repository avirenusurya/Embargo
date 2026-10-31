// <AGENT>'s desk (the context inbox): suggestions with evidence + confidence, access requests, held agent actions,
// "allow similar" bulk decisions, digest preview and context-manager runs.
import { $, $$, esc, fmt, compact, ago, date, api, S, AGENT, icon, toast, wrap, busy, modal, confirmBox, view, enhance, cleanup, head, eye, eyeInk, wsay, empty, isAdmin, go, status, working, confHtml, shortId, motion } from '/static/assets/app-core.js';

const SUGG = { update: ['acid', 'Update', 'think'], contradiction: ['red', 'Contradiction', 'alert'], stale: ['amber', 'Stale', 'held'], duplicate: ['ink', 'Duplicate', 'watch'], gap: ['acid', 'Gap', 'think'], rule: ['red', 'Rule', 'alert'], expiry: ['amber', 'Expiry', 'held'], onboarding: ['acid', 'Onboarding', 'watch'], quality: ['amber', 'Quality', 'watch'] };
let tab = 'open', heldFilter = 'held', typeFilter = '';

export async function deskView(sub, subId) {
  if (!isAdmin()) {
    return view(`${head({ n: '02', title: `${AGENT.name}'s desk`, desc: 'Only owners and context admins review what Warden proposes.' })}${wsay(`I draft every change for the founder's office to approve. Ask an owner or context admin if something looks wrong; you can still see your own activity and exposure.`, { state: 'watch' })}`);
  }
  let focus = null;
  if (sub === 'held') { tab = 'held'; focus = subId ? { kind: 'held', id: subId } : null; if (subId) heldFilter = ''; }
  else if (sub === 'requests') tab = 'open';
  else if (sub === 'digest') tab = 'digest';
  else if (sub && /^[0-9a-f-]{36}$/i.test(sub)) { tab = 'open'; focus = { kind: 'sugg', id: sub }; }
  const [sugg, reqs, held] = await Promise.all([api(`/workspaces/${S.ws}/suggestions`), api(`/workspaces/${S.ws}/access-requests`).catch(() => []), api(`/workspaces/${S.ws}/held-actions`).then((r) => r.items).catch(() => [])]);
  const pending = reqs.filter((r) => r.status === 'pending');
  const heldOpen = held.filter((h) => h.status === 'held');
  S.pendingRequests = pending.length;
  if (S.wsInfo?.counts) { S.wsInfo.counts.open_suggestions = sugg.length; S.wsInfo.counts.held_actions = heldOpen.length; }
  status();
  const total = sugg.length + pending.length + heldOpen.length;
  const st = heldOpen.length ? 'alert' : total ? 'held' : 'watch';
  const s = (n) => (n === 1 ? '' : 's');
  view(`${head({ n: '02', label: 'Context inbox', title: `${AGENT.name}'s desk`, desc: `${esc(AGENT.name)} reads every import, edit and push, and drafts the change here. Nothing changes until you approve it.` })}
    <section class="desk-h">${eye(st, '', true).replace('eye ', 'eye big ')}
      <div><div class="say">${total ? `<span class="${heldOpen.length ? 'red' : 'amber'}">${total} item${s(total)}</span> on your desk.` : '<span class="acid">Desk clear.</span> Nothing stale, nothing contradicts.'}</div>
        <div class="sub">${sugg.length} suggestion${s(sugg.length)} · ${pending.length} access request${s(pending.length)} · ${heldOpen.length} held action${s(heldOpen.length)}. Auto-apply threshold ${Math.round((S.wsInfo?.settings?.auto_apply_threshold ?? .85) * 100)}% (<a class="u" href="#settings">change</a>).</div></div>
      <div class="runs"><span class="lab">Run ${esc(AGENT.name)}</span>
        <button class="bt sm" data-run="daily" data-cursor="SWEEP">${icon('refresh', 12)}Daily sweep</button>
        <button class="bt sm" data-run="weekly">${icon('history', 12)}Weekly review</button>
        <div class="btns" style="gap:6px"><button class="bt xs ghost" data-run="clusters" style="flex:1">Clusters</button><button class="bt xs ghost" data-run="reminders" style="flex:1">Reminders</button></div></div>
    </section>
    <div class="tabs" id="dtabs" role="tablist">
      <button data-t="open">Open items <span class="n">${total}</span></button>
      <button data-t="held">Held actions <span class="n">${heldOpen.length}</span></button>
      <button data-t="digest">Digest</button>
      <button data-t="history">Filed</button>
    </div>
    <div id="deskBody" class="mt"></div>`, { key: '#inbox' });
  $$('[data-run]').forEach((b) => (b.onclick = wrap(() => runJob(b))));
  const show = async (t) => {
    tab = t; $$('#dtabs button').forEach((x) => x.classList.toggle('on', x.dataset.t === t));
    const box = $('#deskBody'); cleanup(box);
    box.innerHTML = '<div class="ld"></div>';
    try { box.innerHTML = await ({ open: () => openHtml(sugg, pending, heldOpen, reqs), held: () => heldHtml(held), digest: digestHtml, history: historyHtml })[t](); }
    catch (e) { box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
    enhance(box);
    wire(box, { sugg, reqs, held });
    if (motion.gsap) motion.gsap.fromTo($$('.memo', box).slice(0, 10), { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: .26, stagger: .03, ease: 'expo.out', clearProps: 'transform,opacity' });
    if (focus) {
      const el = $(`[data-${focus.kind === 'held' ? 'hid' : 'sid'}="${focus.id}"]`, box);
      if (el) { el.classList.add('hl'); setTimeout(() => (motion.lenis ? motion.lenis.scrollTo(el, { offset: -90, duration: .6 }) : el.scrollIntoView({ block: 'center' })), 80); }
      focus = null;
    }
  };
  $$('#dtabs button').forEach((x) => (x.onclick = () => show(x.dataset.t)));
  await show(tab);
}

async function runJob(b) {
  const job = b.dataset.run;
  const restore = busy(b, job === 'daily' ? 'Sweeping' : 'Running');
  try {
    const r = await working(() => api(`/workspaces/${S.ws}/context-manager/run`, { body: { job } }));
    if (job === 'digest') toast(`Digest ${r.digest?.delivered === false ? 'built (no delivery channel configured)' : 'sent to context admins'}`);
    else if (job === 'clusters') toast(`${r.clusters ?? 0} query cluster(s) from ${r.queries ?? 0} agent queries · ${r.stored ?? 0} stored`, 'info');
    else if (job === 'reminders') toast(`${r.review_reminders ?? 0} review reminder(s) sent`, 'info');
    else toast(`${AGENT.name} finished the ${job} ${job === 'daily' ? 'sweep' : 'review'}`);
    await S.hooks.poll?.();
    if (job !== 'reminders' && job !== 'clusters') deskView();
  } finally { restore(); }
}

// ---------------------------------------------------------------- open items
function openHtml(sugg, pending, heldOpen, reqs) {
  const types = [...new Set(sugg.map((x) => x.type))];
  const list = typeFilter ? sugg.filter((x) => x.type === typeFilter) : sugg;
  if (!sugg.length && !pending.length && !heldOpen.length) return empty('Desk clear', `Nothing stale. Nothing contradicts. ${esc(AGENT.name)} drafts changes here when meetings, edits or repo pushes make context outdated.`, '<button class="bt sm" data-run2="daily">Run the daily sweep</button>');
  return `${heldOpen.length ? `<div class="sect-h"><h2><span class="n">I2</span>Held actions</h2><span class="lab">Approve = admin override</span></div><div class="memos">${heldOpen.map(heldMemo).join('')}</div>` : ''}
    ${pending.length ? `<div class="sect-h"><h2><span class="n">E8</span>Access requests</h2></div><div class="memos">${pending.map((r) => reqMemo(r, pending)).join('')}</div>` : ''}
    ${sugg.length ? `<div class="sect-h"><h2><span class="n">F3</span>Suggestions</h2><div class="chips">${types.length > 1 ? `<button class="chip btn ${!typeFilter ? 'on' : ''}" data-tf="">All ${sugg.length}</button>${types.map((t) => `<button class="chip btn ${typeFilter === t ? 'on' : ''}" data-tf="${t}">${esc(SUGG[t]?.[1] ?? t)} ${sugg.filter((x) => x.type === t).length}</button>`).join('')}` : ''}</div></div>
      <div class="memos">${list.map((x) => suggMemo(x, sugg)).join('')}</div>` : ''}`;
}
function blockLink(id, label) { return `<a class="u" href="#blocks/${id}">${esc(label ?? shortId(id))}</a>`; }
function evidence(s) {
  const p = s.payload || {};
  const out = [];
  if (s.type === 'contradiction' && p.a && p.b) {
    out.push(`<div class="vs">${['a', 'b'].map((k) => `<button type="button" class="${p.preferred === k ? 'pref' : ''}" data-pick="${s.id}" data-pref="${k}" data-cursor="KEEP THIS">${esc(p[k].title)}<b>${esc(p[k].value)}</b>Keep this value</button>`).join('')}</div>`);
    if (p.explanation) out.push(`<div class="quote red">${esc(p.explanation)}<cite>${esc(p.key ?? 'conflicting fact')}</cite></div>`);
  } else if (s.type === 'update' && p.changes) {
    for (const ch of p.changes.slice(0, 3)) out.push(`<div class="quote acid">${esc(ch.new_text)}<cite>${esc(ch.op)} · ${esc(ch.heading || 'section')}</cite></div>`);
    if (p.rationale) out.push(`<div class="quote">${esc(p.rationale)}<cite>Why${p.source_block_id ? ` · source ${blockLink(p.source_block_id, 'block')}` : ''}</cite></div>`);
  } else if (s.type === 'gap' && p.draft) {
    out.push(`<div class="quote acid"><b>${esc(p.draft.title)}</b>${(p.draft.sections || []).slice(0, 3).map((x) => `<br>${esc(x.heading)}: ${esc(x.text)}`).join('')}<cite>Draft block</cite></div>`);
  } else if (s.type === 'rule') {
    out.push(`<div class="chips">${p.access_mode ? `<span class="chip blocked">Access → ${esc(p.access_mode.replace('_', ' '))}</span>` : ''}${p.visibility ? `<span class="chip ink">Visibility → ${esc(p.visibility)}</span>` : ''}</div>`);
    if (p.reason || p.rationale) out.push(`<div class="quote amber">${esc(p.reason || p.rationale)}<cite>Sensitive content</cite></div>`);
  } else if (s.type === 'duplicate') out.push(`<div class="quote">Merges into one block (${p.merged?.sections?.length ?? 0} sections) and archives the other.<cite>Duplicate merge</cite></div>`);
  else if (s.type === 'expiry') out.push(`<div class="quote amber">${p.action === 'archive' ? 'Archive the block' : `Set expiry to ${esc(date(p.expires_at))}`}<cite>Expiry</cite></div>`);
  else if (s.type === 'onboarding') out.push(`<div class="quote acid">Starter pack “${esc(p.collection_name ?? 'Starter pack')}” with ${(p.block_ids || []).length} block(s): ${(p.block_ids || []).slice(0, 4).map((id) => blockLink(id)).join(', ')}<cite>Onboarding</cite></div>`);
  const ev = Object.entries(s.evidence || {}).filter(([k, v]) => k !== 'prompt_versions' && v != null && typeof v !== 'object');
  if (ev.length) out.push(`<div class="chips">${ev.map(([k, v]) => `<span class="chip dim plain">${esc(k.replace(/_/g, ' '))}: ${esc(typeof v === 'number' && v < 1 ? v.toFixed(2) : k.endsWith('block_id') ? shortId(v) : v)}</span>`).join('')}</div>`);
  return out.join('');
}
function suggMemo(s, all) {
  const [c, l, st] = SUGG[s.type] ?? ['ink', s.type, 'watch'];
  const similar = all.filter((x) => x.id !== s.id && x.type === s.type).length;
  const pick = s.type === 'contradiction' && s.payload?.a;
  return `<article class="memo" data-sid="${s.id}"><div class="av-w">${eye(st)}</div>
    <div><div class="from"><b>${esc(AGENT.name)}</b><span>filed ${ago(s.created_at)}</span><span class="stp ${c}">${esc(l)}</span>${(s.target_block_ids || []).slice(0, 2).map((id, i) => `<a class="u" href="#blocks/${id}">${s.target_block_ids.length > 1 ? (i ? 'Second' : 'First') + ' file' : 'Open file'}</a>`).join('')}</div>
      <h3>${esc(s.summary)}</h3><div class="ev">${evidence(s)}</div></div>
    ${confHtml(s.confidence)}
    <div class="acts"><button class="bt sm acid" data-approve="${s.id}" data-cursor="APPROVE">${icon('check', 12)}${pick ? `Accept ${esc(AGENT.name)}'s pick` : 'Approve'}</button>
      <button class="bt sm" data-edit="${s.id}">${icon('edit', 12)}Edit &amp; approve</button>
      <button class="bt sm" data-similar="${s.id}" title="Approve this and every open ${esc(l.toLowerCase())} suggestion like it">${icon('layers', 12)}Allow similar${similar ? ` · up to ${similar + 1}` : ''}</button>
      <button class="bt sm quiet sp" data-reject="${s.id}">Reject</button></div></article>`;
}
function reqMemo(r, pending) {
  const similar = pending.filter((x) => x.id !== r.id && x.target_id === r.target_id).length;
  return `<article class="memo req" data-rid="${r.id}"><div class="av-w">${eye('watch')}</div>
    <div><div class="from"><b>${esc(AGENT.name)}</b><span>access request · ${ago(r.created_at)}</span><span class="stp acid">Request</span></div>
      <h3>${esc(r.tool_label)} (${esc(r.user_name)}) asks for ${r.title ? `“${blockLink(r.target_id, r.title)}”` : 'a block'}.</h3>
      <div class="ev"><div class="quote">${esc(r.reason)}<cite>Reason given by the agent</cite></div></div></div>
    <span></span>
    <div class="acts"><button class="bt sm acid" data-ar="${r.id}" data-a="approve">${icon('check', 12)}Grant</button><button class="bt sm" data-ar="${r.id}" data-a="deny">Deny</button>
      ${similar ? `<button class="bt sm" data-ar="${r.id}" data-a="approve" data-all="1">Grant all ${similar + 1} for this file</button><button class="bt sm quiet" data-ar="${r.id}" data-a="deny" data-all="1">Deny all ${similar + 1}</button>` : ''}</div></article>`;
}
const AUD = { public: 'blocked', external: 'restricted', team: 'ink' };
function heldMemo(h) {
  const open = h.status === 'held';
  return `<article class="memo held ${open ? '' : 'decided'}" data-hid="${h.id}"><div class="av-w">${eye(open ? 'alert' : 'sleep')}</div>
    <div><div class="from"><b>${esc(AGENT.name)}</b><span>${open ? 'held' : esc(h.status)} ${ago(h.created_at)}</span><span class="stp ${open ? 'red' : h.status === 'approved' ? 'amber' : 'ink'}">${open ? 'Held' : esc(h.status)}</span><span>${esc(h.tool_label ?? 'Unknown tool')}</span></div>
      <h3>${esc(h.summary)}</h3>
      <div class="kv"><span>Action</span><span><span class="code-i">${esc(h.action)}</span></span><span>Target</span><span>${esc(h.target || '—')}</span><span>Audience</span><span><span class="chip ${AUD[h.audience] ?? 'ink'}">${esc(h.audience)}</span></span>
        <span>Matched</span><span><b class="dot" style="font-size:18px">${h.restricted_count}</b> restricted item${h.restricted_count === 1 ? '' : 's'} · ${(h.reasons || []).map((r) => `<span class="chip red plain">${esc(r)}</span>`).join(' ')}</span>
        ${h.decided_at ? `<span>Decided</span><span>${ago(h.decided_at)}</span>` : ''}</div></div>
    <span></span>
    ${open ? `<div class="acts"><button class="bt sm acid" data-hd="${h.id}" data-a="deny" data-cursor="KEEP BLOCKED">${icon('shield', 12)}Keep blocked</button><button class="bt sm red" data-hd="${h.id}" data-a="approve" data-cursor="OVERRIDE">Override &amp; send</button></div>` : ''}</article>`;
}

// ---------------------------------------------------------------- held actions tab
function heldHtml(held) {
  const list = heldFilter ? held.filter((h) => h.status === heldFilter) : held;
  return `<div class="toolbar" style="margin-top:0"><div class="seg" id="hseg">${[['held', 'Held'], ['approved', 'Overridden'], ['denied', 'Denied'], ['', 'All']].map(([v, l]) => `<button data-v="${v}" class="${heldFilter === v ? 'on' : ''}">${l} ${v ? held.filter((h) => h.status === v).length : held.length}</button>`).join('')}</div>
    <span class="hint">Agent actions sent through <span class="code-i">perform_action</span> are checked against content the audience may not see. Matches are held here.</span></div>
    ${list.length ? `<div class="memos">${list.map(heldMemo).join('')}</div>` : empty('Nothing held', `No ${heldFilter || ''} actions. ${esc(AGENT.name)} holds an agent action when its payload matches restricted context.`)}`;
}

// ---------------------------------------------------------------- digest + history
async function digestHtml() {
  const d = await api(`/workspaces/${S.ws}/digest`);
  return `<div class="cols"><article class="paper digest"><div class="dh"><span>Weekly digest · preview<br><span style="font-weight:500;opacity:.7">${esc(date(d.period_start))} — ${esc(date(d.period_end))}</span></span><span class="did">F12</span></div>
      <div class="dg"><div><b>${d.changes.blocks_changed}</b><span>Blocks changed</span></div><div><b>${d.changes.new_blocks}</b><span>New blocks</span></div><div><b>${d.contradictions.open}</b><span>Open contradictions</span></div><div><b>${d.open_suggestions}</b><span>Open suggestions</span></div></div>
      ${d.changes.titles?.length ? `<ul>${d.changes.titles.slice(0, 8).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <div style="margin-top:12px">
        <div class="ln"><span>Contradictions</span><span>${d.contradictions.new} new · ${d.contradictions.open} open</span></div>
        <div class="ln"><span>Revokes</span><span>${d.revokes.blocks} blocks · ${d.revokes.statements} lines · ${d.revokes.cards} cards</span></div>
        <div class="ln"><span>Shares</span><span>${d.shares.cards} cards · ${d.shares.cross_org} cross-org</span></div>
        <div class="ln"><span>Consent decisions</span><span>${d.consent_decisions}</span></div>
        <div class="ln"><span>Held actions</span><span>${d.held_actions}</span></div>
        <div class="ln"><span>Tool requests</span><span>${fmt(d.usage.requests)} · ${compact(d.usage.tokens_served)} tokens served · ${compact(d.usage.tokens_saved)} saved</span></div>
        <div class="ln"><span>Active blocks</span><span>${d.usage.active_blocks}</span></div>
      </div>
      <div class="doc-foot"><span class="by">${eyeInk('watch')}Compiled by ${esc(AGENT.name)}</span><span>${d.last_sent ? `Last sent ${esc(ago(d.last_sent.created_at))}${d.last_sent.delivered === false ? ' · undelivered' : ''}` : 'Never sent'}</span></div></article>
    <aside class="pane"><div class="pane-h"><span>Send</span><i>F12</i></div><div class="pane-b"><p class="hint">The digest goes to context admins through the viaSocket <span class="code-i">digest.weekly</span> flow and as an in-app notice. It carries counts and titles only.</p>
      <button class="bt sm acid full" data-run2="digest">${icon('send', 12)}Send digest now</button></div></aside></div>`;
}
async function historyHtml() {
  const [ap, rj, au] = await Promise.all(['approved', 'rejected', 'auto_applied'].map((st) => api(`/workspaces/${S.ws}/suggestions?status=${st}`).catch(() => [])));
  const all = [...ap.map((x) => ({ ...x, st: 'approved' })), ...rj.map((x) => ({ ...x, st: 'rejected' })), ...au.map((x) => ({ ...x, st: 'auto-applied' }))].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return all.length ? `<div class="tw"><table class="ledger"><thead><tr><th>Type</th><th>Summary</th><th class="hm">Confidence</th><th>Decision</th><th class="r">Filed</th></tr></thead><tbody>${all.map((s) => `<tr><td><span class="stp ${SUGG[s.type]?.[0] ?? 'ink'}">${esc(SUGG[s.type]?.[1] ?? s.type)}</span></td><td class="small">${esc(s.summary)}</td><td class="hm dot">${Math.round(s.confidence * 100)}%</td><td><span class="chip ${s.st === 'rejected' ? 'dim' : 'acid'}">${esc(s.st)}</span></td><td class="r nowrap">${ago(s.created_at)}</td></tr>`).join('')}</tbody></table></div>`
    : empty('Nothing filed yet', 'Approved, rejected and auto-applied suggestions appear here.');
}

// ---------------------------------------------------------------- wiring
function stampMemo(el, text, cls = 'acid') {
  if (!el) return;
  el.insertAdjacentHTML('beforeend', `<span class="stp lg ${cls} thunk" style="position:absolute;right:22px;top:16px;--rot:-6deg">${esc(text)}</span>`);
  el.classList.add('done');
}
function wire(box, { sugg, reqs }) {
  const after = async (el, text, cls) => { stampMemo(el, text, cls); await S.hooks.poll?.(); setTimeout(() => deskView(), 420); };
  $$('[data-run2]', box).forEach((b) => { b.dataset.run = b.dataset.run2; b.onclick = wrap(() => runJob(b)); });
  $$('[data-tf]', box).forEach((b) => (b.onclick = () => { typeFilter = b.dataset.tf; deskView(); }));
  $$('#hseg button', box).forEach((b) => (b.onclick = () => { heldFilter = b.dataset.v; deskView('held'); }));
  $$('[data-approve]', box).forEach((b) => (b.onclick = wrap(async () => {
    const restore = busy(b, 'Approving');
    try { await working(() => api(`/suggestions/${b.dataset.approve}/approve`, { body: {} })); } finally { restore(); }
    toast('Approved. A new version is being filed.'); after(b.closest('.memo'), 'Approved');
  })));
  $$('[data-pick]', box).forEach((b) => (b.onclick = wrap(async () => {
    await working(() => api(`/suggestions/${b.dataset.pick}/approve`, { body: { edited_payload: { preferred: b.dataset.pref } } }));
    toast(`Kept “${b.querySelector('b')?.textContent ?? ''}”. The other file is being corrected.`); after(b.closest('.memo'), 'Resolved');
  })));
  $$('[data-similar]', box).forEach((b) => (b.onclick = wrap(async () => {
    const s = sugg.find((x) => x.id === b.dataset.similar);
    if (!(await confirmBox({ title: 'Allow similar?', body: `Approves this ${esc(SUGG[s.type]?.[1]?.toLowerCase() ?? s.type)} suggestion and every open suggestion ${esc(AGENT.name)} considers the same kind of change.`, confirm: 'Approve all similar' }))) return;
    const r = await working(() => api(`/suggestions/${s.id}/allow-similar`, { body: {} }));
    toast(`Approved ${r.applied} suggestion${r.applied === 1 ? '' : 's'}`); after(b.closest('.memo'), `Approved ×${r.applied}`);
  })));
  $$('[data-reject]', box).forEach((b) => (b.onclick = wrap(async () => { await api(`/suggestions/${b.dataset.reject}/reject`, { body: {} }); toast('Rejected', 'info'); after(b.closest('.memo'), 'Rejected', 'ink'); })));
  $$('[data-edit]', box).forEach((b) => (b.onclick = () => {
    const s = sugg.find((x) => x.id === b.dataset.edit);
    modal(`<div class="md-t">Edit before approving</div><div class="md-d">${esc(s.summary)}</div><label class="field"><span>Payload (JSON)</span><textarea id="pj" style="min-height:320px;font-size:11.5px">${esc(JSON.stringify(s.payload, null, 2))}</textarea></label><div id="pjErr" class="hint"></div>
      <div class="md-f"><label class="check" style="margin-right:auto"><input type="checkbox" id="pjs"> Also apply to similar</label><button class="bt sm acid" id="go">Approve edited</button></div>`, (el, close) => {
      $('#pj', el).oninput = (e) => { try { JSON.parse(e.target.value); $('#pjErr', el).textContent = ''; } catch (err) { $('#pjErr', el).textContent = `Invalid JSON: ${err.message}`; } };
      $('#go', el).onclick = wrap(async () => {
        let payload; try { payload = JSON.parse($('#pj', el).value); } catch { throw new Error('The payload is not valid JSON'); }
        const r = await working(() => api(`/suggestions/${s.id}/approve`, { body: { edited_payload: payload, apply_to_similar: $('#pjs', el).checked || undefined } }));
        close(); toast(`Approved${r.applied > 1 ? ` ${r.applied} suggestions` : ''}`); after(box.querySelector(`[data-sid="${s.id}"]`), 'Approved');
      });
    }, { label: `${SUGG[s.type]?.[1] ?? s.type} suggestion`, code: 'F3', width: 720 });
  }));
  $$('[data-ar]', box).forEach((b) => (b.onclick = wrap(async () => {
    const all = b.dataset.all === '1';
    const r = await api(`/access-requests/${b.dataset.ar}/${b.dataset.a}`, { body: all ? { apply_to_similar: true } : {} });
    toast(`${r.status === 'approved' ? 'Access granted' : 'Denied'}${r.applied > 1 ? ` for ${r.applied} requests` : ''}${r.note ? `. ${r.note}` : ''}`, r.status === 'approved' ? 'ok' : 'info');
    after(b.closest('.memo'), r.status === 'approved' ? 'Granted' : 'Denied', r.status === 'approved' ? 'acid' : 'ink');
  })));
  $$('[data-hd]', box).forEach((b) => (b.onclick = wrap(async () => {
    const approve = b.dataset.a === 'approve';
    if (approve && !(await confirmBox({ title: 'Override and send?', danger: true, confirm: 'Override & send', body: `The held payload is forwarded unchanged to your viaSocket flow and logged as an admin override in Activity. ${esc(AGENT.name)} held it because it matches restricted context for this audience.` }))) return;
    await working(() => api(`/held-actions/${b.dataset.hd}/${b.dataset.a}`, { body: {} }));
    toast(approve ? 'Overridden: the action was forwarded and logged' : 'Kept blocked. The payload was discarded.', approve ? 'held' : 'ok');
    after(b.closest('.memo'), approve ? 'Overridden' : 'Denied', approve ? 'amber' : 'acid');
  })));
}
