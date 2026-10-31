// Library, block documents (paper), structured editor, originals, statements, versions, block activity/records, collections, tags, composer.
import {
  $, $$, esc, fmt, compact, pad, ago, when, date, iso, localDT, api, S, AGENT, icon, toast, wrap, busy, modal, confirmBox, view, enhance, cleanup, head, eye, eyeInk, wsay, empty,
  isAdmin, canEdit, go, status, working, MODE, modeChip, VIS, STATUS_CHIP, docId, shortId, barcode, redactBars, memberName, copy, b64file, tw, errMsg, motion,
} from '/static/assets/app-core.js';
import { countersign } from '/static/assets/app-wallet.js';

const isProc = (b) => ['queued', 'processing'].includes(b.processing_state);
const KIND_ICON = { doc: 'filetext', note: 'filetext', url: 'link', repo: 'github', conversation: 'chat', agent: 'terminal' };
const pendingVersion = new Map(); // block id → version number before an edit, to announce the new one

// ================================================================ library
const F = { q: '', mode: '', tag: '', collection: '', status: '' };
export async function libraryView() {
  view(`${head({ n: '01', title: 'Library', desc: `Everything your AI tools know about the team. Every file has an owner, a clearance rule and a record. ${esc(AGENT.name)} files and compresses what comes in.`,
    actions: `<button class="bt sm" id="imp">${icon('upload', 12)}Import</button><button class="bt sm acid" id="nb">${icon('plus', 12)}New block</button>` })}
    <div class="cmdbar"><span class="who">${eye('watch')}TELL ${esc(AGENT.name)}</span><input id="rc" placeholder="Embargo the pricing block until Friday 10 AM" aria-label="Natural-language rule"><button class="bt acid" id="rcgo" data-cursor="FILE ORDER">File order<span class="ar">→</span></button></div>
    <div class="stats mt" style="--n:4" id="libStats"><div><b>—</b><span>Active blocks</span></div><div><b>—</b><span>Tokens saved per full read</span></div><div><b>—</b><span>Lines awaiting consent</span></div><div><b>—</b><span>Connected tools</span></div></div>
    <div class="toolbar"><label class="search">${icon('search', 13)}<input type="search" id="q" placeholder="Search by meaning or title   ( / )" value="${esc(F.q)}" aria-label="Search blocks"></label>
      <div class="seg" id="seg">${[['', 'All'], ['viewable', 'Viewable'], ['agent_only', 'Agent only'], ['sealed_use', 'Sealed use']].map(([v, l]) => `<button data-v="${v}" class="${F.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <select id="fcol" aria-label="Collection"><option value="">All collections</option></select>
      <select id="fst" aria-label="Status">${[['', 'Active + drafts'], ['active', 'Active'], ['draft', 'Drafts'], ['archived', 'Archived'], ['revoked', 'Revoked']].map(([v, l]) => `<option value="${v}" ${F.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="tagrow" id="tagrow"></div>
    <div id="libList"><div class="ld"></div></div>`);
  $('#nb').onclick = () => composer();
  $('#imp').onclick = () => composer('file');
  $('#rcgo').onclick = () => ruleCommand($('#rc').value);
  $('#rc').onkeydown = (e) => { if (e.key === 'Enter') ruleCommand(e.target.value); };
  let t; $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { F.q = e.target.value.trim(); renderList(); }, 320); };
  $$('#seg button').forEach((b) => (b.onclick = () => { F.mode = b.dataset.v; $$('#seg button').forEach((x) => x.classList.toggle('on', x === b)); renderList(); }));
  $('#fst').onchange = (e) => { F.status = e.target.value; renderList(); };
  $('#fcol').onchange = (e) => { F.collection = e.target.value; renderList(); };
  const [tags, colls] = await Promise.all([api(`/workspaces/${S.ws}/tags`).catch(() => []), api(`/workspaces/${S.ws}/collections`).catch(() => [])]);
  S.collections = colls;
  $('#fcol').innerHTML = `<option value="">All collections</option>${colls.map((c) => `<option value="${c.id}" ${F.collection === c.id ? 'selected' : ''}>${esc(c.name)} (${c.block_ids.length})</option>`).join('')}`;
  const tr = $('#tagrow');
  tr.innerHTML = tags.length ? `<span class="lab">Tags</span>${tags.map((x) => `<button class="chip tag btn ${F.tag === x.name ? 'on' : ''}" data-tag="${esc(x.name)}">${esc(x.name)} <span class="faint">${x.blocks}</span></button>`).join('')}${F.tag ? '<button class="chip plain btn" data-tag="">Clear ✕</button>' : ''}` : '';
  $$('[data-tag]', tr).forEach((b) => (b.onclick = () => { F.tag = F.tag === b.dataset.tag ? '' : b.dataset.tag; $$('[data-tag]', tr).forEach((x) => x.classList.toggle('on', x.dataset.tag === F.tag && !!F.tag)); renderList(); }));
  await renderList(true);
}
let listTimer = 0;
async function renderList(first = false) {
  const qs = new URLSearchParams();
  for (const [k, p] of [['q', 'query'], ['mode', 'mode'], ['tag', 'tag'], ['collection', 'collection'], ['status', 'status']]) if (F[k]) qs.set(p, F[k]);
  const list = await api(`/workspaces/${S.ws}/blocks?${qs}`);
  const box = $('#libList'); if (!box) return;
  S.processing = list.filter(isProc).length; status();
  const saved = list.reduce((s, b) => s + Math.max(0, (b.tokens_original || 0) - (b.tokens_compressed || 0)), 0);
  const st = $('#libStats');
  if (st) st.innerHTML = `<div><b>${list.filter((b) => b.status === 'active').length}</b><span>Active blocks</span></div><div><b class="acid">${compact(saved)}</b><span>Tokens saved per full read</span></div><div><b class="${list.some((b) => b.held_statements) ? 'amber' : ''}">${list.reduce((s, b) => s + (b.held_statements || 0), 0)}</b><span>Lines awaiting consent</span></div><div><b>${S.wsInfo?.counts?.connections ?? 0}</b><span>Connected tools</span></div>`;
  const filtered = F.q || F.mode || F.tag || F.collection || F.status;
  cleanup(box);
  box.innerHTML = list.length ? tw(`<table class="ledger"><thead><tr><th class="n">No</th><th class="hs">File</th><th>Title</th><th>Clearance</th><th class="hm">Ver</th><th class="hm r">Tokens / read</th><th class="r">Updated</th></tr></thead><tbody>
    ${list.map((b, i) => blockRow(b, i)).join('')}</tbody></table>`)
    : filtered ? empty('No files match', 'Nothing in the archive matches these filters.', '<button class="bt sm" id="clr">Clear filters</button>')
      : empty('The archive is empty', 'Paste your product description, import a document or a meeting, or connect a repo. Warden files and compresses it.', '<button class="bt sm acid" id="nb2">Create your first block</button>');
  enhance(box);
  if ($('#nb2')) $('#nb2').onclick = () => composer();
  if ($('#clr')) $('#clr').onclick = () => { Object.assign(F, { q: '', mode: '', tag: '', collection: '', status: '' }); libraryView(); };
  if (!first && motion.gsap) motion.gsap.fromTo($$('tbody tr', box).slice(0, 14), { opacity: 0 }, { opacity: 1, duration: .2, stagger: .015 });
  clearTimeout(listTimer);
  if (S.processing) listTimer = setTimeout(() => { if (location.hash === '#library' || location.hash === '' || location.hash === '#') renderList(); }, 2500);
}
function blockRow(b, i) {
  const sealed = b.access_mode === 'sealed_use' || b.storage_mode === 'sealed_block';
  const pct = b.tokens_original > b.tokens_compressed && b.tokens_compressed ? Math.round((1 - b.tokens_compressed / b.tokens_original) * 100) : 0;
  const chips = [
    b.pinned ? '<span class="chip acid plain">Pinned</span>' : '',
    isProc(b) ? `<span class="chip ink"><span class="blink">Filing</span></span>` : b.processing_state === 'failed' ? '<span class="chip red">Failed</span>' : '',
    b.status !== 'active' ? `<span class="chip ${STATUS_CHIP[b.status] ?? ''}">${esc(b.status)}</span>` : '',
    b.agent_written ? '<span class="chip dim">Agent-written</span>' : '',
    b.held_statements ? `<span class="chip amber">${b.held_statements} awaiting consent</span>` : '',
    ...(b.tags || []).slice(0, 3).map((t) => `<span class="chip tag dim">${esc(t)}</span>`),
  ].filter(Boolean).join('');
  const href = b.storage_mode === 'sealed_block' ? `#sealed/${b.id}` : `#blocks/${b.id}`;
  return `<tr><td class="n">${pad(i + 1)}</td><td class="hs"><span class="fid ${sealed ? 'sealed' : ''}">${docId(b)}</span></td>
    <td><div class="btitle"><a href="${href}" data-cursor="OPEN FILE">${esc(b.title)}</a>${chips ? `<div class="chips">${chips}</div>` : ''}</div></td>
    <td>${modeChip(b)}</td><td class="hm">v${b.version_no ?? '–'}</td>
    <td class="hm r tok">${b.tokens_compressed ? `${fmt(b.tokens_compressed)}${pct ? `<span class="sv">−${pct}%</span>` : ''}` : '—'}</td><td class="r nowrap">${ago(b.updated_at)}</td></tr>`;
}

// ================================================================ composer
const SOURCES = [['text', 'Paste', 'or dictate', 'filetext'], ['transcript', 'Transcript', 'Speaker: line', 'chat'], ['wispr', 'Wispr', 'Notetaker', 'wave'], ['url', 'Web page', 'any URL', 'link'], ['file', 'Document', 'PDF DOCX MD', 'file'], ['github', 'GitHub', 'repo files', 'github'], ['audio', 'Audio', 'Whisper', 'mic']];
export function composer(pre = 'text') {
  if (!canEdit()) return toast('Viewers cannot create blocks', 'err');
  let src = pre, file = null;
  modal(`<div class="md-t">What should your AI tools know?</div>
    <div class="srcs" id="srcs">${SOURCES.map(([k, l, s, ic]) => `<button type="button" class="src ${k === src ? 'on' : ''}" data-k="${k}">${icon(ic, 15)}<span><b>${l}</b><span>${s}</span></span></button>`).join('')}</div>
    <div id="srcBody"></div>
    <div class="fgrid c3"><label class="field"><span>Title <i>(optional)</i></span><input id="ct" placeholder="Warden names it if empty"></label>
      <label class="field"><span>Access mode</span><select id="cm"><option value="viewable">Viewable</option><option value="agent_only">Agent only</option><option value="sealed_use">Sealed use</option></select></label>
      <label class="field"><span>Visibility</span><select id="cv"><option>team</option><option>private</option><option>partner</option><option>public</option></select></label></div>
    <label class="field"><span>Tags <i>(comma separated)</i></span><input id="ctg" placeholder="pricing, launch"></label>
    <div class="md-f" style="justify-content:space-between;align-items:center"><div class="btns"><label class="check"><input type="checkbox" id="cp" checked> Publish when filed</label><label class="check"><input type="checkbox" id="cpin"> Pin</label></div><button class="bt sm acid" id="go" data-cursor="FILE IT">File block<span class="ar">→</span></button></div>`, (el, close) => {
    const body = () => {
      const b = $('#srcBody', el); file = null;
      if (src === 'text') b.innerHTML = `<textarea id="cx" placeholder="Paste a doc or notes, or click here and dictate with Wispr Flow…" style="min-height:180px"></textarea>`;
      else if (src === 'transcript') b.innerHTML = `<textarea id="cx" style="min-height:180px" placeholder="[00:01] Priya: The launch price is ₹599/month now.\n[00:20] Rohan: We moved launch to 20 Nov."></textarea><p class="hint">Lines are split by speaker. Sensitive lines are held until their speaker decides.</p>`;
      else if (src === 'url') b.innerHTML = `<label class="field"><span>URL</span><input id="cx" placeholder="https://docs.example.com/how-we-deploy"></label>`;
      else if (src === 'github') b.innerHTML = `<div class="fgrid c2"><label class="field"><span>Repository</span><input id="cx" placeholder="owner/repo"></label><label class="field"><span>Paths <i>(optional)</i></span><input id="cpaths" placeholder="README*, docs/**"></label></div><p class="hint">Connect GitHub under Integrations first. One block per file; pushes flag stale blocks.</p>`;
      else if (src === 'wispr') {
        b.innerHTML = `<div class="loading" style="padding:20px 0"><div class="ld"></div><span>Asking Wispr Notetaker for meetings</span></div>`;
        api(`/workspaces/${S.ws}/integrations/wispr/meetings`).then((m) => { if (!b.isConnected || src !== 'wispr') return; b.innerHTML = m.length ? `<div class="coll-list" data-lenis-prevent style="max-height:240px">${m.map((x) => `<label class="check" style="padding:9px 10px;border:1px solid var(--line-2)"><input type="radio" name="mt" value="${esc(x.id)}" data-t="${esc(x.title)}"><span><b>${esc(x.title)}</b><br><span class="dim">${esc(x.date ?? '')} · ${(x.attendees || []).length} attendees</span></span></label>`).join('')}</div>` : '<p class="hint">No meetings found in Wispr.</p>'; })
          .catch((e) => { if (b.isConnected) b.innerHTML = `<div class="wsay amber">${eye('held', 'm')}<div><span class="who">${esc(AGENT.name)}</span><p>${esc(e.message)}. <a class="u" href="#integrations">Connect Wispr under Integrations</a>.</p></div></div>`; enhance(b); });
      } else b.innerHTML = `<div class="drop" id="dz" tabindex="0">${icon('upload', 18)}<span>Drop a file or click to choose</span><input type="file" id="cf" hidden ${src === 'audio' ? 'accept="audio/*,video/*"' : 'accept=".pdf,.docx,.md,.txt,.html,.csv,.json"'}></div>${src === 'audio' ? '<p class="hint">Uploaded audio is transcribed with OpenAI Whisper. For meetings, prefer Wispr Notetaker.</p>' : ''}`;
      const dz = $('#dz', el);
      if (dz) {
        const fi = $('#cf', el); const set = (f) => { file = f; dz.classList.add('has'); dz.innerHTML = `${icon('check', 18)}<span>${esc(f.name)} · ${(f.size / 1024).toFixed(0)} KB</span>`; dz.appendChild(fi); };
        dz.onclick = () => fi.click(); dz.onkeydown = (e) => { if (e.key === 'Enter') fi.click(); }; fi.onchange = () => fi.files[0] && set(fi.files[0]);
        dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('has'); }; dz.ondrop = (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) set(e.dataTransfer.files[0]); };
      }
      enhance(b);
    };
    body();
    $$('.src', el).forEach((b) => (b.onclick = () => { src = b.dataset.k; $$('.src', el).forEach((x) => x.classList.toggle('on', x === b)); body(); }));
    $('#go', el).onclick = wrap(async () => {
      const x = $('#cx', el)?.value?.trim();
      const tags = $('#ctg', el).value.split(',').map((s) => s.trim()).filter(Boolean);
      let source;
      if (src === 'text' || src === 'transcript') { if (!x) throw new Error('Paste some text first'); source = { type: src, text: x }; }
      else if (src === 'url') { if (!x) throw new Error('Enter a URL'); source = { type: 'url', url: x }; }
      else if (src === 'github') { if (!x) throw new Error('Enter owner/repo'); source = { type: 'github', repo: x, paths: $('#cpaths', el).value ? $('#cpaths', el).value.split(',').map((s) => s.trim()).filter(Boolean) : undefined }; }
      else if (src === 'wispr') { const r = $('input[name=mt]:checked', el); if (!r) throw new Error('Pick a meeting'); const out = await api(`/workspaces/${S.ws}/integrations/wispr/import`, { body: { meeting_id: r.value, title: $('#ct', el).value || r.dataset.t } }); close(); toast('Meeting import queued. Warden is filing it.'); return go(`blocks/${out.block_id}`); }
      else { if (!file) throw new Error('Choose a file'); source = { type: src, filename: file.name, mime: file.type || undefined, data_base64: await b64file(file) }; }
      const restore = busy($('#go', el), 'Filing');
      try {
        const r = await api(`/workspaces/${S.ws}/blocks`, { body: { source, title: $('#ct', el).value.trim() || undefined, access_mode: $('#cm', el).value, visibility: $('#cv', el).value, auto_publish: $('#cp', el).checked, pinned: $('#cpin', el).checked, tags: tags.length ? tags : undefined } });
        close(); S.processing++; status();
        toast(r.block_id ? `${AGENT.name} is compressing it. It appears in a moment.` : 'Repo import queued: one block per file.');
        if (r.block_id) go(`blocks/${r.block_id}`); else go('library');
      } finally { restore(); }
    });
  }, { label: 'New context block', code: 'FORM 01-A', width: 820 });
}

// ================================================================ natural-language rule ("Tell Warden")
export function ruleCommand(text) {
  text = String(text || '').trim();
  if (text.length < 3) { $('#rc')?.focus(); return toast('Say what should happen, e.g. "Embargo the pricing block until Friday 10 AM"', 'info'); }
  modal(`<div class="loading" style="padding:30px 0"><div class="ld"></div><span>${esc(AGENT.name)} is reading the order</span></div>`, async (el, close) => {
    const b = $('.md-b', el.parentElement) ?? el.querySelector('.md-b');
    try {
      const r = await api('/rule-commands/parse', { body: { text, workspace_id: S.ws } });
      const p = r.parsed;
      const changes = [p.embargo_until && `<span class="stamp red thunk">Embargo until ${esc(when(p.embargo_until))}</span>`, p.expires_at && `<span class="stamp amber thunk">Expires ${esc(when(p.expires_at))}</span>`,
        p.visibility && `<span class="stamp ink thunk">Visibility ${esc(p.visibility)}</span>`, p.access_mode && `<span class="stamp red thunk">${esc(MODE[p.access_mode]?.[1] ?? p.access_mode)}</span>`].filter(Boolean);
      b.innerHTML = r.target ? `<div class="md-t">Standing order</div><div class="md-d">“${esc(text)}”</div>
        <div class="kv"><span>Target file</span><span><select id="tgt">${[r.target, ...(r.alternatives || [])].map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}</select></span><span>Changes</span><span class="doc-stamps" style="margin:0">${changes.join('') || '<i>No rule change recognised</i>'}</span></div>
        <div class="md-f"><button class="bt sm" data-x>Cancel</button><button class="bt sm acid" id="ap" ${changes.length ? '' : 'disabled'}>Apply order</button></div>`
        : `<div class="md-t">No matching file</div><div class="md-d">${esc(AGENT.name)} couldn't match a block for “${esc(p.target_ref)}”. Name the block more exactly.</div><div class="md-f"><button class="bt sm" data-x>Close</button></div>`;
      enhance(b);
      $$('[data-x]', b).forEach((x) => (x.onclick = close));
      if (r.target) $('#ap', b).onclick = wrap(async () => {
        const id = $('#tgt', b).value;
        const cw = r.confirm_with;
        if (Object.keys(cw.body).length) await api(`/blocks/${id}/rules`, { body: cw.body });
        if (cw.access_mode) await api(`/blocks/${id}/access-mode`, { body: { access_mode: cw.access_mode } });
        close(); toast('Order filed. The rule is in force on the next request.'); if ($('#rc')) $('#rc').value = '';
        go(`blocks/${id}`);
      });
    } catch (e) { b.innerHTML = `<div class="md-t">Order not understood</div><div class="md-d">${esc(errMsg(e))}</div>`; }
  }, { kind: 'paper', label: 'Rule order', code: 'FORM 04-R', width: 600 });
}

// ================================================================ block document
let blockTimer = 0;
export async function blockView(id, { keepTab } = {}) {
  clearTimeout(blockTimer);
  const [b, versions, conns, colls] = await Promise.all([api(`/blocks/${id}`), api(`/blocks/${id}/versions`).catch(() => []), api(`/workspaces/${S.ws}/connections`).catch(() => []), api(`/workspaces/${S.ws}/collections`).catch(() => [])]);
  if (b.storage_mode === 'sealed_block') return go(`sealed/${id}`);
  const rule = b.rule || {};
  const editor = b.your_role && b.your_role !== 'viewer';
  const ruleEditor = editor && (b.owner_id === S.me.user.id || isAdmin());
  const processing = b.processing_state !== 'ready';
  const fieldsOk = editor && !processing && b.kind !== 'conversation' && b.status !== 'revoked' && b.access_mode === 'viewable' && !b.content_hidden && b.sections.every((s) => s.text !== undefined);
  const inColl = new Set(colls.filter((c) => c.block_ids.includes(id)).map((c) => c.id));
  S.collections = colls;
  if (processing) { S.processing = Math.max(S.processing, 1); status(); }
  const prev = pendingVersion.get(id);
  if (!processing && prev != null && (b.version?.version_no ?? 0) > prev) { pendingVersion.delete(id); toast(`v${b.version.version_no} filed by ${AGENT.name}: ${b.version.change_note || 'new version'}`); }
  const crumb = document.getElementById('crumbX'); if (crumb) crumb.textContent = docId(b);

  view(`<a class="back" href="#library">${icon('arrowleft', 12)}Library</a>
  <div class="bd"><div class="bd-main">
    ${docHtml(b, { processing })}
    <section class="dledger" id="ledgerTabs">
      <div class="tabs" role="tablist">
        <button class="on" data-tab="versions">Versions <span class="n">${versions.length}</span></button>
        <button data-tab="activity">Activity <span class="n" id="nAct">·</span></button>
        <button data-tab="records">Records <span class="n" id="nRec">·</span></button>
        ${b.access_mode === 'sealed_use' ? `<button data-tab="sealed">${esc(AGENT.name)}'s answers <span class="n" id="nSeal">·</span></button>` : ''}
      </div><div id="tabBody"></div>
    </section>
  </div>
  <aside class="bd-side">
    <div class="pane"><div class="pane-h"><span>File actions</span><i>${docId(b)}</i></div><div class="pane-b">
      ${b.status === 'draft' && !processing ? `<button class="bt sm acid full" id="pub">${icon('check', 12)}Publish to connected tools</button>` : ''}
      <div class="acts-grid">
        <button class="bt sm" id="edf" ${fieldsOk ? '' : 'disabled'} data-cursor="EDIT">${icon('edit', 12)}Edit fields</button>
        <button class="bt sm" id="orig" ${b.access_mode === 'viewable' && b.status !== 'revoked' ? '' : 'disabled'}>${icon('file', 12)}Original</button>
        <button class="bt sm" id="pin" ${editor ? '' : 'disabled'}>${icon('pin', 12)}${b.pinned ? 'Unpin' : 'Pin'}</button>
        <button class="bt sm" id="arch" ${editor && b.status === 'active' ? '' : 'disabled'}>${icon('archive', 12)}Archive</button>
      </div>
      <button class="bt sm red full" id="rev" ${ruleEditor && b.status !== 'revoked' ? '' : 'disabled'} data-cursor="DESTROY">${icon('trash', 12)}Revoke &amp; shred keys</button>
    </div></div>
    <div class="pane"><div class="pane-h"><span>Clearance</span><i>${esc(rule.visibility || 'team')}</i></div><div class="pane-b">
      <div class="seg full" id="am">${Object.entries(MODE).map(([k, [, l]]) => `<button data-v="${k}" class="${b.access_mode === k ? 'on' : ''}" ${!ruleEditor || b.status === 'revoked' ? 'disabled' : ''}>${l}</button>`).join('')}</div>
      <p class="hint">${b.access_mode === 'agent_only' ? 'Agent only: connected tools receive the text, Embargo screens hide it. Soft protection.' : b.access_mode === 'sealed_use' ? `Sealed use: nobody receives the text. Agents ask ${esc(AGENT.name)} through <span class="code-i">ask_sealed</span> and get checked answers.` : 'Viewable: people and tools the rules allow can read the text.'}</p>
      <div class="fgrid c2"><label class="field"><span>Visibility</span><select id="rv" ${ruleEditor ? '' : 'disabled'}>${['team', 'private', 'partner', 'public'].map((v) => `<option ${rule.visibility === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>Sealed answers</span><select id="rap" ${ruleEditor ? '' : 'disabled'}>${[['facts_only', 'Facts only'], ['yes_no', 'Yes / no'], ['summary', 'Summary']].map(([v, l]) => `<option ${rule.answer_policy === v ? 'selected' : ''} value="${v}">${l}</option>`).join('')}</select></label></div>
      <label class="field"><span>Embargo until</span><input type="datetime-local" id="re" value="${localDT(rule.embargo_until)}" ${ruleEditor ? '' : 'disabled'}></label>
      <label class="field"><span>Expires</span><input type="datetime-local" id="rx" value="${localDT(rule.expires_at)}" ${ruleEditor ? '' : 'disabled'}></label>
      <label class="field"><span>Allowed tools <i>(none selected = all)</i></span><select id="rt" multiple size="${Math.min(4, Math.max(2, conns.filter((c) => !c.revoked_at).length))}" ${ruleEditor ? '' : 'disabled'}>${conns.filter((c) => !c.revoked_at).map((c) => `<option value="${c.id}" ${(rule.allowed_connection_ids || []).includes(c.id) ? 'selected' : ''}>${esc(c.tool_label)} · ${esc(c.user)}</option>`).join('')}</select></label>
      <label class="field"><span>Purposes</span><input id="rp" placeholder="support, marketing" value="${esc((rule.purposes || []).join(', '))}" ${ruleEditor ? '' : 'disabled'}></label>
      <label class="field"><span>Partner workspace id</span><input id="rpw" placeholder="for partner visibility" value="${esc(rule.partner_workspace_id || '')}" ${ruleEditor ? '' : 'disabled'}></label>
      <button class="bt sm acid full" id="rs" ${ruleEditor ? '' : 'disabled'}>Save clearance rules</button>
    </div></div>
    <div class="pane"><div class="pane-h"><span>Tags</span><i>${b.tags.length}</i></div><div class="pane-b">
      <div class="tags-ed" id="tagEd">${b.tags.map((t) => `<span class="chip tag ink">${esc(t)}${editor ? `<span class="x" data-rmtag="${esc(t)}" role="button" aria-label="Remove tag">✕</span>` : ''}</span>`).join('')}${editor ? '<input id="tagIn" placeholder="+ tag, Enter" aria-label="Add tag">' : b.tags.length ? '' : '<span class="hint">No tags</span>'}</div>
    </div></div>
    <div class="pane"><div class="pane-h"><span>Collections</span><i>${inColl.size}</i></div><div class="pane-b">
      ${colls.length ? `<div class="coll-list" data-lenis-prevent>${colls.map((c) => `<label class="check"><input type="checkbox" data-coll="${c.id}" ${inColl.has(c.id) ? 'checked' : ''} ${editor ? '' : 'disabled'}><span>${esc(c.name)} <span class="faint">${c.block_ids.length}</span></span></label>`).join('')}</div>` : '<p class="hint">No collections yet.</p>'}
      ${editor ? `<div class="inrow"><input id="ncName" placeholder="New collection" aria-label="New collection name"><button class="bt sm" id="ncAdd">${icon('plus', 12)}Add</button></div>` : ''}
    </div></div>
    <div class="pane"><div class="pane-h"><span>Share as card</span><i>L1</i></div><div class="pane-b">
      <div class="fgrid c2"><label class="field"><span>Recipient</span><select id="ctp"><option value="workspace">Workspace</option><option value="user">Person (email)</option><option value="link">Anyone with link</option></select></label>
        <label class="field"><span>Expires</span><input type="datetime-local" id="cex"></label></div>
      <label class="field" id="ctoW"><span id="ctoL">Workspace id</span><input id="cto" placeholder="workspace uuid"></label>
      <label class="field"><span>Note <i>(scope)</i></span><input id="cnote" placeholder="For the launch partner"></label>
      <button class="bt sm full" id="csh" ${ruleEditor && b.status !== 'revoked' ? '' : 'disabled'}>${icon('share', 12)}Issue card &amp; record</button>
    </div></div>
    ${b.your_role && (b.owner_id === S.me.user.id || isAdmin()) ? `<div class="pane"><div class="pane-h"><span>Why withheld?</span><i>O3</i></div><div class="pane-b">
      <div class="inrow"><select id="wwc" aria-label="Connection">${conns.map((c) => `<option value="${c.id}">${esc(c.tool_label)}${c.revoked_at ? ' (revoked)' : ''}</option>`).join('')}</select><button class="bt sm" id="ww" ${conns.length ? '' : 'disabled'}>Explain</button></div><div id="wwo"></div>
    </div></div>` : ''}
  </aside></div>`, { key: `#blocks/${id}` });

  // ---- wiring
  if (processing) blockTimer = setTimeout(() => { if (location.hash === `#blocks/${id}`) blockView(id); }, 1800);
  const on = (s, f) => { const e = $(s); if (e) e.onclick = wrap(f); };
  const reload = () => blockView(id);
  on('#pub', async () => { await api(`/blocks/${id}/publish`, { body: {} }); toast('Published. Connected tools receive it on their next request.'); reload(); });
  $$('#am button').forEach((x) => (x.onclick = wrap(async () => { if (x.classList.contains('on')) return; await api(`/blocks/${id}/access-mode`, { body: { access_mode: x.dataset.v } }); toast(`Access mode: ${MODE[x.dataset.v][1]}`); reload(); })));
  on('#rs', async () => {
    const tools = $$('#rt option:checked').map((o) => o.value);
    const purposes = $('#rp').value.split(',').map((s) => s.trim()).filter(Boolean);
    await api(`/blocks/${id}/rules`, { body: { visibility: $('#rv').value, answer_policy: $('#rap').value, embargo_until: iso($('#re').value), expires_at: iso($('#rx').value), allowed_connection_ids: tools.length ? tools : null, purposes: purposes.length ? purposes : null, partner_workspace_id: $('#rpw').value.trim() || null } });
    toast('Clearance rules filed'); reload();
  });
  on('#pin', async () => { await api(`/blocks/${id}`, { method: 'PATCH', body: { pinned: !b.pinned } }); toast(b.pinned ? 'Unpinned' : 'Pinned: considered first by the compiler'); reload(); });
  on('#arch', async () => { if (!(await confirmBox({ title: 'Archive this file?', body: 'Archived blocks stop being served to tools. You can still read them here.', confirm: 'Archive' }))) return; await api(`/blocks/${id}/archive`, { body: {} }); toast('Archived'); reload(); });
  on('#rev', async () => revokeBlock(b));
  on('#edf', async () => fieldEditor(b));
  on('#orig', async () => originalModal(b));
  // tags
  const saveTags = async (tags) => { await api(`/blocks/${id}`, { method: 'PATCH', body: { tags } }); reload(); };
  $$('[data-rmtag]').forEach((x) => (x.onclick = wrap(() => saveTags(b.tags.filter((t) => t !== x.dataset.rmtag)))));
  const ti = $('#tagIn');
  if (ti) ti.onkeydown = wrap(async (e) => { if (e.key !== 'Enter' && e.key !== ',') return; e.preventDefault(); const v = ti.value.trim().replace(/^#/, ''); if (!v) return; if (b.tags.includes(v)) { ti.value = ''; return; } await saveTags([...b.tags, v]); toast(`Tagged #${v}`, 'info'); });
  // collections
  $$('[data-coll]').forEach((c) => (c.onchange = wrap(async () => {
    try {
      if (c.checked) { await api(`/collections/${c.dataset.coll}/blocks`, { body: { block_id: id } }); toast('Added to collection'); }
      else { await api(`/collections/${c.dataset.coll}/blocks/${id}`, { method: 'DELETE' }); toast('Removed from collection', 'info'); }
    } catch (e) { c.checked = !c.checked; throw e; }
  })));
  on('#ncAdd', async () => { const name = $('#ncName').value.trim(); if (!name) throw new Error('Name the collection'); await api(`/workspaces/${S.ws}/collections`, { body: { name, block_ids: [id] } }); toast(`Collection "${name}" created`); reload(); });
  // card
  const ctp = $('#ctp'); if (ctp) ctp.onchange = () => { const t = ctp.value; $('#ctoW').hidden = t === 'link'; $('#ctoL').textContent = t === 'user' ? 'Email' : 'Workspace id'; $('#cto').placeholder = t === 'user' ? 'person@company.com' : 'workspace uuid'; };
  on('#csh', async () => {
    const t = $('#ctp').value, v = $('#cto').value.trim();
    if (t !== 'link' && !v) throw new Error(t === 'user' ? 'Enter the recipient email' : 'Enter the recipient workspace id');
    const recipient = t === 'workspace' ? { type: t, workspace_id: v } : t === 'user' ? { type: t, email: v } : { type: 'link' };
    const note = $('#cnote').value.trim();
    const r = await api(`/blocks/${id}/cards`, { body: { recipient, expires_at: iso($('#cex').value), scope: note ? { note } : {} } });
    cardIssued(r);
  });
  on('#ww', async () => {
    const r = await api(`/blocks/${id}/why-withheld?connection_id=${$('#wwc').value}`);
    $('#wwo').innerHTML = r.reasons.length ? `<div class="stack" style="gap:6px">${r.reasons.map((x) => `<div class="quote red"><b class="red">${x.count}×</b> ${esc(x.explanation)}<cite>${esc(x.reason.replace(/_/g, ' '))}</cite></div>`).join('')}</div>`
      : `<div class="quote acid">${esc(r.connection)} can receive all ${r.allowed_items} item(s). Nothing withheld.</div>`;
  });
  // statements
  wireStatements(b, reload);
  // ledger tabs
  const tabs = { versions: () => versionsTab(b, versions, editor), activity: () => activityTab(b), records: () => recordsTab(b), sealed: () => sealedTab(b) };
  let cur = keepTab ?? 'versions';
  const show = wrap(async (k) => {
    cur = k; $$('#ledgerTabs .tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === k));
    const box = $('#tabBody'); cleanup(box); box.innerHTML = '<div class="pane-b"><div class="ld"></div></div>';
    box.innerHTML = await tabs[k](); enhance(box); wireTab(k, b, box, reload);
  });
  $$('#ledgerTabs .tabs button').forEach((x) => (x.onclick = () => show(x.dataset.tab)));
  show(cur);
  // counts in the tab labels (background)
  Promise.all([api(`/blocks/${id}/activity?limit=200`, { quiet: true }).catch(() => ({ items: [] })), api(`/blocks/${id}/records`, { quiet: true }).catch(() => ({ records: [] }))]).then(([a, r]) => {
    blockCache.set(id, { activity: a.items, records: r.records });
    if ($('#nAct')) $('#nAct').textContent = a.items.length; if ($('#nRec')) $('#nRec').textContent = r.records.length;
    if ($('#nSeal')) $('#nSeal').textContent = a.items.filter((x) => x.channel === 'sealed').length;
  });
}
const blockCache = new Map();

function docHtml(b, { processing }) {
  const rule = b.rule || {};
  const now = Date.now();
  const embargoed = rule.embargo_until && new Date(rule.embargo_until) > now;
  const expired = rule.expires_at && new Date(rule.expires_at) <= now;
  const expiring = rule.expires_at && !expired;
  const MODE_STAMP = { viewable: ['ink', 'Viewable'], agent_only: ['amber', 'Agent only'], sealed_use: ['red', 'Sealed use'] };
  const [mc, ml] = MODE_STAMP[b.access_mode] ?? ['ink', b.access_mode];
  const stamps = [
    `<span class="stamp ${mc} thunk">${esc(ml)}</span>`,
    `<span class="stamp ${rule.visibility === 'public' ? 'acid' : rule.visibility === 'private' ? 'red' : 'ink'} thunk">${esc(rule.visibility || 'team')}</span>`,
    b.status === 'draft' ? '<span class="stamp amber thunk">Draft</span>' : '',
    b.status === 'archived' ? '<span class="stamp ink thunk">Archived</span>' : '',
    b.status === 'revoked' ? '<span class="stamp red thunk" style="font-size:18px;border-width:3px">Revoked · keys destroyed</span>' : '',
    embargoed ? '<span class="stamp red thunk">Embargoed</span>' : '',
    expired ? '<span class="stamp red thunk">Expired</span>' : '',
    b.pinned ? '<span class="stamp acid thunk">Pinned</span>' : '',
    b.agent_written ? '<span class="stamp blue thunk">Agent-written</span>' : '',
  ].filter(Boolean).join('');
  const notes = [
    embargoed ? `<span class="doc-note red">Embargoed until ${esc(when(rule.embargo_until))}. Hold the line.</span>` : '',
    expiring ? `<span class="doc-note">Expires ${esc(when(rule.expires_at))}.</span>` : '',
    b.preview ? `<span class="doc-note">Draft preview: tools don't see this yet.</span>` : '',
  ].filter(Boolean).join('');
  const v = b.version;
  const owner = memberName(b.owner_id);
  let body;
  if (processing) body = `<div class="doc-proc">${eyeInk(b.processing_state === 'failed' ? 'alert' : 'think', '', false)}<div class="px">${b.processing_state === 'failed' ? 'Filing failed' : `${esc(AGENT.name)} is filing this`}</div><p>${esc(b.processing_error || 'Extracting, compressing, checking sensitivity, embedding. This page refreshes itself.')}</p></div>`;
  else if (b.kind === 'conversation' && b.statements.length) body = transcriptHtml(b);
  else if (b.content_hidden) body = `<div class="hidden-doc">${redactBars(b.id, 6)}<p>${b.access_mode === 'agent_only' ? 'Agent only: connected AI tools receive this text; Embargo screens never show it.' : b.access_mode === 'sealed_use' ? `Sealed use: nobody receives this text. Agents ask questions through <b>ask_sealed</b> and ${esc(AGENT.name)} answers without quoting.` : b.status === 'revoked' ? 'Revoked. The keys were destroyed; this content is permanently unreadable, including backups.' : 'Withheld from you by the current rules.'}</p></div>`;
  else body = b.sections.map((s, i) => `<div class="dsec k-${s.kind}"><div class="h"><span class="no">§${String(i + 1).padStart(2, '0')}</span>${esc(s.heading)}${s.flags.length ? `<div class="flags">${s.flags.map((f) => `<span class="flag ${f.endsWith(':high') ? '' : 'med'}">${esc(f.replace(/_/g, ' ').replace(':', ' · '))}</span>`).join('')}</div>` : ''}</div>
      <div class="body">${s.text !== undefined ? esc(s.text) : `${redactBars(s.id, 2)}<span class="rlab">Withheld from you</span>`}</div></div>`).join('') || '<div class="hidden-doc"><p>No sections.</p></div>';
  const withheld = b.withheld && Object.keys(b.withheld).length ? `<p class="withheld-note">Withheld from you: ${Object.entries(b.withheld).map(([k, n]) => `${n} × ${esc(k.replace(/_/g, ' '))}`).join(', ')}</p>` : '';
  return `<article class="paper doc" id="doc"><span class="pin"></span>
    <header class="doc-top"><div class="ph2">Embargo archive · ${esc(b.kind)} file<small>Owner ${esc(owner)} · ${esc(rule.visibility || 'team')} · ${b.tags.length ? b.tags.map((t) => `#${esc(t)}`).join(' ') : 'untagged'}</small></div><span class="did">${docId(b)}</span></header>
    <h1 class="doc-t">${esc(b.title)}</h1>
    <div class="doc-meta"><span>Version <b>${v?.version_no ?? '–'}</b></span><span>Filed <b>${esc(ago(v?.created_at))}</b></span>${v && !processing ? `<span><b>${fmt(v.tokens_original)}</b> → <b>${fmt(v.tokens_compressed)}</b> tokens</span>${v.tokens_saved_per_read ? `<span>Saves <b>${fmt(v.tokens_saved_per_read)}</b> per read</span>` : ''}` : ''}${v?.change_note ? `<span>${esc(v.change_note.replace(/^suggestion:.*/, 'from the desk'))}</span>` : ''}</div>
    <div class="doc-stamps">${stamps}</div>${notes}
    <div class="doc-body">${body}</div>${withheld}
    <footer class="doc-foot"><span class="by">${eyeInk('watch')}Filed by ${esc(AGENT.name)} · ${esc(AGENT.id)}</span><span>${shortId(b.id)}</span>${barcode(b.id)}</footer>
  </article>`;
}

// ---------------- conversation statements (K1 revoke, decisions, speaker correction)
const ST_STAMP = { allowed: ['acid', 'Allowed'], held: ['amber', 'Awaiting speaker'], team_only: ['blue', 'Team only'], blocked: ['red', 'Blocked'] };
function transcriptHtml(b) {
  const held = b.statements.filter((s) => s.status === 'held').length;
  const speakers = new Set(b.statements.map((s) => s.speaker_label)).size;
  const mine = S.myPerson?.id;
  const ownerOrAdmin = b.owner_id === S.me.user.id || isAdmin();
  return `<div class="ts-h"><span>${b.statements.length} statements · ${speakers} speakers · ${held} awaiting consent · ${b.statements.filter((s) => s.revoked_at).length} revoked</span>${held && isAdmin() ? `<button class="bt xs" id="links">${icon('link', 11)}Review links</button>` : ''}</div>
  ${b.statements.map((s) => {
    const [c, l] = s.revoked_at ? ['red', 'Revoked'] : ST_STAMP[s.status] ?? ['ink', s.status];
    const ms = s.started_at_ms;
    const isMine = mine && s.speaker_person_id === mine;
    const canRevoke = !s.revoked_at && b.status !== 'revoked' && (isMine || ownerOrAdmin);
    const text = s.revoked_at ? `${redactBars(s.id, 1)}<span class="rlab">Destroyed ${esc(ago(s.revoked_at))}</span>` : s.text !== undefined ? esc(s.text) : `${redactBars(s.id, 1)}<span class="rlab">${s.status === 'blocked' ? 'Blocked by the speaker' : s.status === 'team_only' ? 'Team only' : "Held for the speaker's decision"}</span>`;
    return `<div class="st-row ${s.revoked_at ? 'revoked' : ''}" data-st="${s.id}"><span class="t">${ms != null ? `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}` : `#${s.ordinal + 1}`}</span>
      <span class="who"><select data-sp="${s.id}" ${ownerOrAdmin && !s.revoked_at ? '' : 'disabled'} aria-label="Speaker"><option value="">${esc(s.speaker_label)}${isMine ? ' (you)' : ''}</option>${(S.persons || []).filter((p) => p.id !== s.speaker_person_id).map((p) => `<option value="${p.id}">${esc(p.display_name)}${p.is_external ? ' · guest' : ''}</option>`).join('')}</select></span>
      <div class="tx-w"><div class="tx">${text}</div>${s.flag_reasons?.length ? `<div class="why">⚑ ${esc(s.flag_reasons.join(' · '))}</div>` : ''}${s.decided_at ? `<div class="dec">Decided ${esc(ago(s.decided_at))}${s.decided_by ? ` by ${esc(memberName(s.decided_by))}` : ''}</div>` : ''}</div>
      <div class="sa"><span class="stamp ${c}">${esc(l)}</span><div class="ctl">${isMine && !s.revoked_at ? `<select data-dec="${s.id}" aria-label="Your decision"><option value="">Decide…</option><option value="allowed">Allow</option><option value="team_only">Team only</option><option value="blocked">Block</option><option value="embargo">Embargo until…</option></select>` : ''}${canRevoke ? `<button class="bt xs" data-srev="${s.id}" data-cursor="REVOKE LINE">Revoke</button>` : ''}</div></div></div>`;
  }).join('')}`;
}
function wireStatements(b, reload) {
  $$('[data-sp]').forEach((s) => (s.onchange = wrap(async () => { if (!s.value) return; await api(`/statements/${s.dataset.sp}/speaker`, { method: 'PATCH', body: { person_id: s.value } }); toast('Speaker corrected'); reload(); })));
  $$('[data-srev]').forEach((x) => (x.onclick = wrap(async () => {
    const st = b.statements.find((s) => s.id === x.dataset.srev);
    if (!(await confirmBox({ title: 'Revoke this line?', body: `Connected tools stop receiving it on their next request and its key material is destroyed. A signed record proves when.${st?.text ? `<div class="quote red" style="margin-top:12px">${esc(st.text)}<cite>${esc(st.speaker_label)}</cite></div>` : ''}`, confirm: 'Revoke line', danger: true }))) return;
    const r = await api(`/statements/${x.dataset.srev}/revoke`, { body: {} });
    toast(`Line revoked.${r.record_id ? ` <a href="/verify/${esc(r.record_id)}" target="_blank" rel="noopener">View record</a>` : ''}`, 'ok', { html: true }); reload();
  })));
  $$('[data-dec]').forEach((s) => (s.onchange = wrap(async () => {
    const v = s.value; if (!v) return;
    if (v === 'embargo') { s.value = ''; return decisionEmbargo(s.dataset.dec, reload); }
    await api(`/statements/${s.dataset.dec}/decision`, { body: { status: v } }); toast(`Your line is now ${v.replace('_', ' ')}. Consent recorded.`); reload();
  })));
  const links = $('#links');
  if (links) links.onclick = wrap(async () => {
    const l = await api(`/blocks/${b.id}/review-links`);
    modal(`<div class="md-t">Ask the speakers</div><div class="md-d">Single-use review links. Each speaker sees only their own held lines. Links are also sent via viaSocket where a contact is known.</div>
      ${l.length ? l.map((x, i) => `<label class="field"><span>${esc(x.person)} · ${x.held} line${x.held > 1 ? 's' : ''}</span><div class="secret"><code>${esc(x.link)}</code><button class="bt sm" data-cp="${i}">${icon('copy', 12)}Copy</button></div></label>`).join('') : '<p class="hint">No lines are awaiting review.</p>'}`,
    (el) => $$('[data-cp]', el).forEach((x) => (x.onclick = () => copy(l[x.dataset.cp].link, 'Review link copied'))), { label: 'Review links', code: 'J2', width: 620 });
  });
}
function decisionEmbargo(stId, reload) {
  modal(`<div class="md-t">Embargo your line</div><div class="md-d">Allowed for AI tools only after this time.</div><label class="field"><span>Embargo until</span><input type="datetime-local" id="deu"></label><div class="md-f"><button class="bt sm acid" id="dgo">Set embargo</button></div>`, (el, close) => {
    $('#dgo', el).onclick = wrap(async () => { const v = $('#deu', el).value; if (!v) throw new Error('Pick a date and time'); await api(`/statements/${stId}/decision`, { body: { status: 'allowed', embargo_until: iso(v) } }); close(); toast('Embargo set. Consent recorded.'); reload(); });
  }, { label: 'Consent', code: 'J3', width: 440 });
}

// ---------------- revoke block
function revokeBlock(b) {
  confirmBox({ title: `Revoke “${b.title}”?`, danger: true, type: b.title, confirm: 'Destroy keys & revoke', label: 'Irreversible',
    body: 'Connected tools stop receiving it on their next request. Its encryption keys are destroyed, so every stored copy, including backups, becomes permanently unreadable. A public deletion record proves when.<br><br><span class="dim">Honest limit: a chat that already read it still has it.</span>' })
    .then(wrap(async (ok) => {
      if (!ok) return;
      const r = await working(() => api(`/blocks/${b.id}/revoke`, { body: {} }));
      modal(`<div class="shk"><span class="stamp red thunk" style="font-size:26px;border-width:3px">Revoked</span><p class="md-d" style="margin-top:18px">Keys destroyed. A deletion certificate is in Records.</p>${r.record_id ? `<a class="bt sm" href="/verify/${esc(r.record_id)}" target="_blank" rel="noopener">View revoke record${icon('external', 12)}</a>` : ''}</div>`, null, { kind: 'paper', label: 'Deletion certificate', code: 'K4', width: 460 });
      blockView(b.id);
    }));
}

// ---------------- structured field editor (C3)
const stripDash = (t) => String(t || '').split('\n').map((l) => l.replace(/^\s*-\s?/, '').trim()).filter(Boolean);
function parseFacts(t) {
  return stripDash(t).map((l) => { const i = l.lastIndexOf(':'); const left = (i > 0 ? l.slice(0, i) : l).trim(); const value = i > 0 ? l.slice(i + 1).trim() : ''; const sp = left.indexOf(' '); return sp > 0 ? { entity: left.slice(0, sp), attribute: left.slice(sp + 1), value } : { entity: left, attribute: 'value', value }; });
}
function structuredOf(b) {
  const by = (k) => b.sections.filter((s) => s.kind === k);
  return { title: b.title, summary: by('summary')[0]?.text ?? '', sections: by('section').map((s) => ({ heading: s.heading, text: s.text ?? '' })), facts: by('facts').flatMap((s) => parseFacts(s.text)), decisions: by('decisions').flatMap((s) => stripDash(s.text)), open_questions: by('open_questions').flatMap((s) => stripDash(s.text)) };
}
function fieldEditor(b) {
  const orig = structuredOf(b);
  const st = JSON.parse(JSON.stringify(orig));
  let mode = 'fields';
  const listHtml = (key, ph) => `<div class="ed-list" data-list="${key}">${st[key].map((v, i) => `<div class="ed-item"><div class="fields"><input data-li="${key}" data-i="${i}" value="${esc(v)}" placeholder="${ph}"></div><div class="ctl"><button class="bt xs quiet icon" data-del="${key}" data-i="${i}" aria-label="Remove">${icon('x', 11)}</button></div></div>`).join('')}</div><button class="bt xs" data-add="${key}">${icon('plus', 11)}Add</button>`;
  const render = (el) => {
    const box = $('#edBody', el);
    cleanup(box);
    if (mode === 'text') {
      box.innerHTML = `<p class="hint">Raw text. ${esc(AGENT.name)} re-compresses it into fields as a new version.</p><textarea id="raw" style="min-height:340px"># ${esc(st.title)}\n\n${esc(st.summary)}\n\n${st.sections.map((s) => `## ${esc(s.heading)}\n${esc(s.text)}`).join('\n\n')}</textarea>`;
      enhance(box); return;
    }
    box.innerHTML = `<label class="field"><span>Title</span><input id="eTitle" value="${esc(st.title)}"></label>
      <label class="field"><span>Summary</span><textarea id="eSum" style="min-height:80px">${esc(st.summary)}</textarea></label>
      <div class="ed-sec"><div class="hd"><span class="lab">Sections <b>${st.sections.length}</b></span><button class="bt xs" data-add="sections">${icon('plus', 11)}Section</button></div>
        <div class="ed-list">${st.sections.map((s, i) => `<div class="ed-item"><div class="fields"><input data-sh="${i}" value="${esc(s.heading)}" placeholder="Heading"><textarea data-stx="${i}" style="min-height:90px" placeholder="Text">${esc(s.text)}</textarea></div>
          <div class="ctl"><button class="bt xs quiet icon" data-mv="${i}" data-d="-1" aria-label="Move up" ${i ? '' : 'disabled'}>${icon('up', 11)}</button><button class="bt xs quiet icon" data-mv="${i}" data-d="1" aria-label="Move down" ${i < st.sections.length - 1 ? '' : 'disabled'}>${icon('down', 11)}</button><button class="bt xs quiet icon" data-del="sections" data-i="${i}" aria-label="Remove">${icon('x', 11)}</button></div></div>`).join('')}</div></div>
      <div class="ed-sec"><div class="hd"><span class="lab">Facts <b>${st.facts.length}</b> · entity / attribute / value</span><button class="bt xs" data-add="facts">${icon('plus', 11)}Fact</button></div>
        <div class="ed-list">${st.facts.map((f, i) => `<div class="ed-item"><div class="fields f3"><input data-fe="${i}" value="${esc(f.entity)}" placeholder="Entity"><input data-fa="${i}" value="${esc(f.attribute)}" placeholder="Attribute"><input data-fv="${i}" value="${esc(f.value)}" placeholder="Value"></div><div class="ctl"><button class="bt xs quiet icon" data-del="facts" data-i="${i}" aria-label="Remove">${icon('x', 11)}</button></div></div>`).join('')}</div>
        ${st.facts.length ? '<p class="hint">Parsed from the filed “Key facts” section. Check where the entity ends and the attribute starts; facts drive contradiction checks.</p>' : ''}</div>
      <div class="ed-sec"><div class="hd"><span class="lab">Decisions <b>${st.decisions.length}</b></span></div>${listHtml('decisions', 'We decided…')}</div>
      <div class="ed-sec"><div class="hd"><span class="lab">Open questions <b>${st.open_questions.length}</b></span></div>${listHtml('open_questions', 'Who owns…?')}</div>`;
    enhance(box);
    const sync = () => {
      st.title = $('#eTitle', box).value; st.summary = $('#eSum', box).value;
      $$('[data-sh]', box).forEach((x) => (st.sections[x.dataset.sh].heading = x.value)); $$('[data-stx]', box).forEach((x) => (st.sections[x.dataset.stx].text = x.value));
      $$('[data-fe]', box).forEach((x) => (st.facts[x.dataset.fe].entity = x.value)); $$('[data-fa]', box).forEach((x) => (st.facts[x.dataset.fa].attribute = x.value)); $$('[data-fv]', box).forEach((x) => (st.facts[x.dataset.fv].value = x.value));
      $$('[data-li]', box).forEach((x) => (st[x.dataset.li][x.dataset.i] = x.value));
    };
    box.oninput = sync;
    $$('[data-add]', box).forEach((x) => (x.onclick = () => { sync(); const k = x.dataset.add; st[k].push(k === 'sections' ? { heading: '', text: '' } : k === 'facts' ? { entity: '', attribute: '', value: '' } : ''); render(el); }));
    $$('[data-del]', box).forEach((x) => (x.onclick = () => { sync(); st[x.dataset.del].splice(Number(x.dataset.i), 1); render(el); }));
    $$('[data-mv]', box).forEach((x) => (x.onclick = () => { sync(); const i = Number(x.dataset.mv), j = i + Number(x.dataset.d); [st.sections[i], st.sections[j]] = [st.sections[j], st.sections[i]]; render(el); }));
    el._sync = sync;
  };
  modal(`<div class="md-t">Edit fields</div><div class="md-d">Each save files a new version (v${(b.version?.version_no ?? 0) + 1}). Only the fields you change are sent.</div>
    <div class="tabs" id="edTabs"><button class="on" data-m="fields">Fields</button><button data-m="text">Raw text</button></div>
    <div id="edBody" class="stack"></div>
    <label class="field"><span>Change note</span><input id="cn" placeholder="What changed?" maxlength="300"></label>
    <div class="md-f"><button class="bt sm" data-x>Cancel</button><button class="bt sm acid" id="esave" data-cursor="FILE VERSION">File v${(b.version?.version_no ?? 0) + 1}<span class="ar">→</span></button></div>`, (el, close) => {
    render(el);
    $$('#edTabs button', el).forEach((x) => (x.onclick = () => { el._sync?.(); mode = x.dataset.m; $$('#edTabs button', el).forEach((y) => y.classList.toggle('on', y === x)); render(el); }));
    $('[data-x]', el).onclick = close;
    $('#esave', el).onclick = wrap(async () => {
      const note = $('#cn', el).value.trim() || undefined;
      let body;
      if (mode === 'text') { const t = $('#raw', el).value.trim(); if (!t) throw new Error('Text is empty'); body = { text: t, change_note: note }; }
      else {
        el._sync?.();
        const clean = {
          title: st.title.trim(), summary: st.summary.trim(),
          sections: st.sections.map((s) => ({ heading: s.heading.trim(), text: s.text.trim() })).filter((s) => s.heading || s.text),
          facts: st.facts.map((f) => ({ entity: f.entity.trim(), attribute: f.attribute.trim(), value: f.value.trim() })).filter((f) => f.entity || f.attribute || f.value),
          decisions: st.decisions.map((d) => d.trim()).filter(Boolean), open_questions: st.open_questions.map((d) => d.trim()).filter(Boolean),
        };
        if (!clean.title) throw new Error('Title cannot be empty');
        if (clean.facts.some((f) => !f.entity || !f.attribute || !f.value)) throw new Error('Every fact needs an entity, an attribute and a value');
        if (clean.sections.some((s) => !s.heading)) throw new Error('Every section needs a heading');
        body = { change_note: note };
        for (const k of ['summary', 'sections', 'facts', 'decisions', 'open_questions']) if (JSON.stringify(clean[k]) !== JSON.stringify(orig[k])) body[k] = clean[k];
        if (clean.title !== orig.title) body.title = clean.title;
        if (Object.keys(body).length === 1) throw new Error('Nothing changed');
      }
      const restore = busy($('#esave', el), 'Filing');
      try {
        const r = await api(`/blocks/${b.id}`, { method: 'PATCH', body });
        close();
        if (r.version_pending) { pendingVersion.set(b.id, b.version?.version_no ?? 0); S.processing = Math.max(1, S.processing); status(); toast(`${AGENT.name} is filing v${(b.version?.version_no ?? 0) + 1}…`, 'info'); }
        else toast('Saved');
        blockView(b.id);
      } finally { restore(); }
    });
  }, { label: `Edit ${docId(b)}`, code: 'FORM 03-C', width: 860 });
}

// ---------------- original (C4)
const ORIG_ERR = { sealed_block: 'Sealed blocks are encrypted on your devices. Embargo holds no original.', content_hidden: 'Originals are never shown for agent-only or sealed-use blocks.', consent_restricted: 'The original transcript includes lines speakers have not released.', revoked: 'The block was revoked and its original destroyed.', no_original: 'No original is stored for this block.', forbidden: 'You are not cleared to open this original.' };
export async function originalModal(b, version) {
  modal(`<div class="loading" style="padding:30px 0"><div class="ld"></div><span>Decrypting the original</span></div>`, async (el) => {
    const box = el.querySelector('.md-b');
    try {
      const o = await api(`/blocks/${b.id}/original${version ? `?version=${version}` : ''}`);
      box.innerHTML = `<div class="doc-top"><div class="ph2">Original source · v${o.version}<small>${esc(o.filename)} · ${esc(o.mime.split(';')[0])} · ${fmt(o.size)} bytes</small></div><span class="did">${docId(b)}</span></div>
        ${o.text != null ? `<pre class="code" data-lenis-prevent style="max-height:56vh">${esc(o.text)}</pre>` : `<div class="hidden-doc">${redactBars(b.id, 3)}<p>Binary file. Download it to open locally.</p></div>`}
        <div class="md-f"><span class="hint" style="margin-right:auto">Opening the original is logged in the block's activity.</span><a class="bt sm acid" href="${esc(o.download_url)}" download="${esc(o.filename)}" data-cursor="DOWNLOAD">${icon('download', 12)}Download</a></div>`;
    } catch (e) {
      box.innerHTML = `<div class="shk"><span class="stamp red thunk" style="font-size:18px">Unavailable</span><p class="md-d" style="margin-top:14px">${esc(ORIG_ERR[e.code] ?? e.message)}</p></div>`;
    }
    enhance(box);
  }, { kind: 'paper', label: 'Original', code: 'C4', width: 820 });
}

// ---------------- ledger tabs
function versionsTab(b, versions, editor) {
  const cur = b.version?.version_no;
  const canDiff = editor && b.access_mode === 'viewable';
  return tw(`<table class="ledger"><thead><tr><th>Ver</th><th>Filed</th><th class="hm">By</th><th class="hs">Source</th><th>Note</th><th class="hm r">Tokens</th><th class="r"></th></tr></thead><tbody>
    ${versions.map((v) => `<tr class="${v.version_no === cur ? 'hl' : ''}"><td><b>v${v.version_no}</b>${v.version_no === cur ? ' <span class="chip acid plain">current</span>' : ''}</td><td class="nowrap">${ago(v.created_at)}</td><td class="hm">${esc(memberName(v.created_by))}</td>
      <td class="hs"><span class="chip dim plain" title="${esc(JSON.stringify(v.prompt_versions || {}))}">${esc(v.source_type || 'text')}</span></td><td class="small">${esc((v.change_note || '').replace(/^suggestion:.*/, 'from the desk'))}</td>
      <td class="hm r nowrap">${fmt(v.tokens_original)} → ${fmt(v.tokens_compressed)}</td>
      <td class="act">${v.has_original && b.access_mode === 'viewable' && b.status !== 'revoked' ? `<button class="bt xs" data-orig="${v.version_no}">Original</button>` : ''}${v.version_no !== cur && canDiff ? `<button class="bt xs" data-diff="${v.version_no}">Diff</button>` : ''}${v.version_no !== cur && editor && b.kind !== 'conversation' && b.status !== 'revoked' ? `<button class="bt xs" data-rb="${v.version_no}">Restore</button>` : ''}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="7">No versions yet.</td></tr>'}
  </tbody></table>`, 'bare');
}
async function activityTab(b) {
  const items = blockCache.get(b.id)?.activity ?? (await api(`/blocks/${b.id}/activity?limit=200`)).items;
  return tw(`<table class="ledger"><thead><tr><th>When</th><th>Channel</th><th>Who</th><th class="hm">Ver</th><th class="r">Withheld</th><th class="r hm">Served</th><th class="r hs">Saved</th><th class="r hs">ms</th></tr></thead><tbody>
    ${items.map((e) => `<tr><td class="nowrap">${ago(e.at)}</td><td><span class="chip ${e.channel === 'sealed' ? 'blocked' : e.channel === 'action' ? 'restricted' : e.channel === 'web' ? 'dim' : 'ink'}">${esc(e.tool ?? e.channel)}</span>${e.outcome ? ` <span class="chip plain ${['blocked', 'refused'].includes(e.outcome) ? 'red' : 'acid'}">${esc(e.outcome)}</span>` : ''}${e.override ? ' <span class="chip plain amber">override</span>' : ''}</td>
      <td>${esc(e.connection ?? 'Web')} <span class="dim">${esc(e.user ?? '')}</span></td><td class="hm">${(e.blocks.find((x) => x.id === b.id)?.version) ? `v${e.blocks.find((x) => x.id === b.id).version}` : '—'}</td>
      <td class="r">${e.withheld_count ? `<span class="chip red plain" title="${esc(JSON.stringify(e.withheld_reasons || {}))}">${e.withheld_count}</span>` : '<span class="faint">0</span>'}</td><td class="r hm">${fmt(e.tokens_served)}</td><td class="r hs acid">${e.tokens_saved ? fmt(e.tokens_saved) : '—'}</td><td class="r hs faint">${e.latency_ms ?? '—'}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="8">No reads logged for this block yet.</td></tr>'}
  </tbody></table>`, 'bare');
}
const EVT = { share: 'acid', share_revoke: 'ink', consent: 'acid', consent_withdraw: 'amber', revoke: 'red', key_destroyed: 'red', unlock: 'amber' };
export const evtStamp = (e) => `<span class="stp ${EVT[e] ?? 'ink'}">${esc(e.replace(/_/g, ' '))}</span>`;
async function recordsTab(b) {
  const recs = blockCache.get(b.id)?.records ?? (await api(`/blocks/${b.id}/records`)).records;
  return tw(`<table class="ledger"><thead><tr><th>Event</th><th>Note</th><th class="hm">Signer</th><th class="hs">State</th><th>When</th><th class="r"></th></tr></thead><tbody>
    ${recs.map((r) => `<tr><td>${evtStamp(r.event)}</td><td class="small">${esc(r.note ?? r.subject_type ?? '')}</td><td class="hm">${r.signer_type === 'user' ? '<span class="chip acid plain">User-signed</span>' : '<span class="dim">Relayer</span>'}</td>
      <td class="hs"><span class="chip ${['onchain', 'anchored'].includes(r.state) ? 'acid' : 'dim'}">${esc(r.state)}</span></td><td class="nowrap">${ago(r.created_at)}</td>
      <td class="act"><a class="bt xs" href="/verify/${r.id}" target="_blank" rel="noopener" data-cursor="VERIFY">Verify${icon('external', 10)}</a><button class="bt xs" data-cs="${r.id}">${icon('pen', 10)}Countersign</button></td></tr>`).join('') || '<tr class="empty-row"><td colspan="6">No signed records for this block yet. Shares, consent decisions, unlocks and revokes create them.</td></tr>'}
  </tbody></table>`, 'bare');
}
async function sealedTab(b) {
  const items = (blockCache.get(b.id)?.activity ?? (await api(`/blocks/${b.id}/activity?limit=200`)).items).filter((x) => x.channel === 'sealed');
  const policy = { facts_only: 'facts only', yes_no: 'yes / no', summary: 'brief summary' }[b.rule?.answer_policy ?? 'facts_only'];
  return `<div class="pane-b">${wsay(`I keep this file behind the counter. Agents ask me through <span class="code-i">ask_sealed</span> and I answer with <b>${esc(policy)}</b>, never quoting. Every answer passes the verbatim, over-disclosure and judge checks first; if it fails twice I refuse.`, { state: 'watch' })}
    <div class="memos">${items.map((e) => `<div class="memo ${e.outcome === 'refused' ? 'held decided' : 'req'}"><div class="av-w">${eye(e.outcome === 'refused' ? 'alert' : 'watch')}</div><div><div class="from"><b>${esc(AGENT.name)}</b>${e.outcome === 'refused' ? 'Refused' : 'Answered'} ${esc(e.connection ?? 'a tool')} · ${esc(e.user ?? '')} · ${ago(e.at)}</div>
      <h3>${e.outcome === 'refused' ? 'The draft answer revealed more than needed. I refused.' : `Answered from ${e.blocks.length} sealed file${e.blocks.length === 1 ? '' : 's'} without releasing the text.`}</h3></div><span class="stp ${e.outcome === 'refused' ? 'red' : 'acid'}">${esc(e.outcome ?? 'answered')}</span></div>`).join('') || '<p class="hint">No sealed questions yet. Connect a tool with the ask_sealed scope and ask it about this topic.</p>'}</div>
    <pre class="code"><span class="k">tools/call</span> ask_sealed { "question": "What is our API rate limit?" }</pre></div>`;
}
function wireTab(k, b, box, reload) {
  $$('[data-orig]', box).forEach((x) => (x.onclick = () => originalModal(b, x.dataset.orig)));
  $$('[data-rb]', box).forEach((x) => (x.onclick = wrap(async () => {
    if (!(await confirmBox({ title: `Restore v${x.dataset.rb}?`, body: 'The old content is filed again as a new version. Nothing is deleted.', confirm: 'Restore as new version' }))) return;
    await api(`/blocks/${b.id}/rollback/${x.dataset.rb}`, { body: {} }); pendingVersion.set(b.id, b.version?.version_no ?? 0); toast(`Restoring v${x.dataset.rb} as a new version`, 'info'); setTimeout(reload, 900);
  })));
  $$('[data-diff]', box).forEach((x) => (x.onclick = wrap(async () => {
    const d = await api(`/blocks/${b.id}/versions/${x.dataset.diff}/diff/${b.version.version_no}`);
    const add = d.diff.filter((l) => l.op === '+').length, del = d.diff.filter((l) => l.op === '-').length;
    modal(`<div class="md-t">What changed</div><div class="md-d">v${d.from} → v${d.to} · <b>+${add}</b> / <b>−${del}</b> lines</div><div class="diff" data-lenis-prevent>${d.diff.map((l) => (l.op === '+' ? `<ins>+ ${esc(l.line)}</ins>` : l.op === '-' ? `<del>− ${esc(l.line)}</del>` : `<span>  ${esc(l.line)}</span>\n`)).join('')}</div>`, null, { kind: 'paper', label: `Diff ${docId(b)}`, code: 'D4', width: 820 });
  })));
  $$('[data-cs]', box).forEach((x) => (x.onclick = () => countersign(x.dataset.cs, () => { blockCache.delete(b.id); reload(); })));
}

// ---------------- card issued (block or collection)
export function cardIssued(r) {
  modal(`<div class="md-t">Card issued</div>
    ${r.share_record_id ? '<div class="md-d">A public, tamper-proof share record was written. It contains no content and no plain ids.</div><div><span class="stamp acid thunk" style="font-size:16px">Recorded</span></div>' : '<div class="md-d">Shared with the person directly. Person-to-person cards carry no public record.</div>'}
    ${r.link ? `<label class="field"><span>Card link · shown once</span><div class="secret"><code>${esc(r.link)}</code><button class="bt sm" id="cpl">${icon('copy', 12)}Copy</button></div></label>` : ''}
    <div class="md-f">${r.share_record_id ? `<a class="bt sm" href="/verify/${esc(r.share_record_id)}" target="_blank" rel="noopener">Verify record${icon('external', 12)}</a>` : ''}<a class="bt sm acid" href="#sharing">Open sharing ledger</a></div>`,
  (el, close) => { if ($('#cpl', el)) $('#cpl', el).onclick = () => copy(r.link, 'Card link copied'); $$('a[href^="#"]', el).forEach((a) => a.addEventListener('click', close)); }, { kind: 'paper', label: 'Card', code: 'L1', width: 560 });
}

// ================================================================ collections (D2)
export async function collectionsView() {
  const colls = await api(`/workspaces/${S.ws}/collections`);
  S.collections = colls;
  view(`${head({ n: '03', title: 'Collections', desc: 'Group blocks into folders for onboarding packs, partners or projects. Share a whole collection as one card; changes to a shared collection are recorded.' })}
    <div class="cols"><div>${tw(`<table class="ledger"><thead><tr><th class="n">No</th><th>Collection</th><th class="r">Blocks</th><th class="r"></th></tr></thead><tbody>
      ${colls.map((c, i) => `<tr><td class="n">${pad(i + 1)}</td><td><a class="rowlink" href="#collections/${c.id}" data-cursor="OPEN">${icon('folder', 12)} ${esc(c.name)}</a></td><td class="r">${c.block_ids.length}</td>
        <td class="act"><a class="bt xs" href="#collections/${c.id}">Open</a>${canEdit() ? `<button class="bt xs red" data-del="${c.id}">Delete</button>` : ''}</td></tr>`).join('') || `<tr class="empty-row"><td colspan="4">No collections yet. ${canEdit() ? 'Create one on the right.' : ''}</td></tr>`}
    </tbody></table>`)}</div>
    <aside class="pane"><div class="pane-h"><span>New collection</span><i>D2</i></div><div class="pane-b">
      <label class="field"><span>Name</span><input id="cname" placeholder="Launch partner pack" ${canEdit() ? '' : 'disabled'}></label>
      <button class="bt sm acid full" id="cmk" ${canEdit() ? '' : 'disabled'}>${icon('plus', 12)}Create collection</button>
      <p class="hint">Add blocks from the collection page or from any block's side panel.</p></div></aside></div>`);
  if ($('#cmk')) $('#cmk').onclick = wrap(async () => { const name = $('#cname').value.trim(); if (!name) throw new Error('Name the collection'); const r = await api(`/workspaces/${S.ws}/collections`, { body: { name } }); toast(`Collection "${name}" created`); go(`collections/${r.id}`); });
  $('#cname')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#cmk').click(); });
  $$('[data-del]').forEach((x) => (x.onclick = wrap(async () => { const c = colls.find((y) => y.id === x.dataset.del); if (await deleteCollection(c)) collectionsView(); })));
}
async function deleteCollection(c) {
  if (!(await confirmBox({ title: `Delete “${c.name}”?`, body: 'The blocks stay in the library. Cards sharing this collection are revoked, with a record.', confirm: 'Delete collection', danger: true }))) return false;
  await api(`/collections/${c.id}`, { method: 'DELETE' }); toast('Collection deleted'); return true;
}
export async function collectionView(id) {
  const [c, all] = await Promise.all([api(`/collections/${id}`), api(`/workspaces/${S.ws}/blocks`).catch(() => [])]);
  const crumb = document.getElementById('crumbX'); if (crumb) crumb.textContent = c.name.toUpperCase();
  const inIds = new Set(c.blocks.map((b) => b.id));
  const addable = all.filter((b) => !inIds.has(b.id) && b.status !== 'revoked');
  const live = c.cards.filter((k) => !k.revoked_at && (!k.expires_at || new Date(k.expires_at) > Date.now()));
  view(`<a class="back" href="#collections">${icon('arrowleft', 12)}Collections</a>${head({ n: '03', label: 'Collection', title: c.name, desc: `${c.blocks.length} block${c.blocks.length === 1 ? '' : 's'} · created ${date(c.created_at)}${live.length ? ` · shared by ${live.length} live card${live.length === 1 ? '' : 's'}: changes are recorded` : ''}`,
    actions: canEdit() ? `<button class="bt sm red" id="cdel">${icon('trash', 12)}Delete</button>` : '' })}
    <div class="cols w380"><div class="stack">
      ${tw(`<table class="ledger"><thead><tr><th class="n">No</th><th class="hs">File</th><th>Title</th><th>Clearance</th><th class="hm">Ver</th><th class="r"></th></tr></thead><tbody>
        ${c.blocks.map((b, i) => `<tr><td class="n">${pad(i + 1)}</td><td class="hs"><span class="fid">${docId(b)}</span></td><td><a class="rowlink" href="#blocks/${b.id}">${esc(b.title)}</a>${b.pinned ? ' <span class="chip acid plain">Pinned</span>' : ''}${b.status !== 'active' ? ` <span class="chip ${STATUS_CHIP[b.status] ?? ''}">${esc(b.status)}</span>` : ''}</td><td>${modeChip(b)}</td><td class="hm">v${b.version_no ?? '–'}</td>
          <td class="act">${canEdit() ? `<button class="bt xs" data-rm="${b.id}">Remove</button>` : ''}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="6">Empty. Add blocks on the right.</td></tr>'}
      </tbody></table>`)}
      <div class="sect-h"><h2><span class="n">L1</span>Cards sharing this collection</h2></div>
      ${tw(`<table class="ledger"><thead><tr><th>Recipient</th><th>Expires</th><th>State</th><th class="r"></th></tr></thead><tbody>
        ${c.cards.map((k) => `<tr class="${k.revoked_at ? 'off' : ''}"><td><span class="chip dim">${esc(k.recipient_type)}</span> <span class="small">${esc(k.recipient_workspace_id ? shortId(k.recipient_workspace_id) : k.recipient_type === 'link' ? 'Anyone with link' : '')}</span></td><td class="nowrap">${k.expires_at ? date(k.expires_at) : '—'}</td>
          <td>${k.revoked_at ? '<span class="stp red">Revoked</span>' : '<span class="chip acid">Live</span>'}</td><td class="act">${k.share_record_id ? `<a class="bt xs" href="/verify/${k.share_record_id}" target="_blank" rel="noopener">Verify</a>` : ''}${!k.revoked_at ? `<button class="bt xs red" data-rc="${k.id}">Revoke</button>` : ''}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="4">Not shared.</td></tr>'}
      </tbody></table>`)}
    </div><aside class="stack">
      <div class="pane"><div class="pane-h"><span>Add block</span><i>${addable.length}</i></div><div class="pane-b">
        <select id="addSel" ${canEdit() && addable.length ? '' : 'disabled'} aria-label="Block to add">${addable.map((b) => `<option value="${b.id}">${esc(b.title)} · ${docId(b)}</option>`).join('') || '<option>No other blocks</option>'}</select>
        <button class="bt sm acid full" id="addB" ${canEdit() && addable.length ? '' : 'disabled'}>${icon('plus', 12)}Add to collection</button></div></div>
      <div class="pane"><div class="pane-h"><span>Share collection as card</span><i>${isAdmin() ? 'ADMIN' : 'ADMIN ONLY'}</i></div><div class="pane-b">
        <div class="fgrid c2"><label class="field"><span>Recipient</span><select id="ctp"><option value="workspace">Workspace</option><option value="link">Anyone with link</option><option value="user">Person (email)</option></select></label><label class="field"><span>Expires</span><input type="datetime-local" id="cex"></label></div>
        <label class="field" id="ctoW"><span id="ctoL">Workspace id</span><input id="cto" placeholder="workspace uuid"></label>
        <label class="field"><span>Note</span><input id="cnote" placeholder="Partner onboarding pack"></label>
        <button class="bt sm full" id="csh" ${isAdmin() && c.blocks.length ? '' : 'disabled'}>${icon('share', 12)}Issue card &amp; record</button>
        ${isAdmin() ? '' : '<p class="hint">Only owners and context admins can share collections.</p>'}</div></div>
    </aside></div>`, { key: `#collections/${id}` });
  const reload = () => collectionView(id);
  if ($('#cdel')) $('#cdel').onclick = wrap(async () => { if (await deleteCollection(c)) go('collections'); });
  $('#addB').onclick = wrap(async () => { const r = await api(`/collections/${id}/blocks`, { body: { block_id: $('#addSel').value } }); toast(r.added ? 'Block added' : 'Already in the collection', r.added ? 'ok' : 'info'); reload(); });
  $$('[data-rm]').forEach((x) => (x.onclick = wrap(async () => { await api(`/collections/${id}/blocks/${x.dataset.rm}`, { method: 'DELETE' }); toast('Removed from collection', 'info'); reload(); })));
  $$('[data-rc]').forEach((x) => (x.onclick = wrap(async () => { if (!(await confirmBox({ title: 'Revoke this card?', body: 'The recipient stops receiving these blocks on their next request. A revoke record is written.', confirm: 'Revoke card', danger: true }))) return; await api(`/cards/${x.dataset.rc}`, { method: 'DELETE' }); toast('Card revoked and recorded'); reload(); })));
  const ctp = $('#ctp'); ctp.onchange = () => { const t = ctp.value; $('#ctoW').hidden = t === 'link'; $('#ctoL').textContent = t === 'user' ? 'Email' : 'Workspace id'; $('#cto').placeholder = t === 'user' ? 'person@company.com' : 'workspace uuid'; };
  $('#csh').onclick = wrap(async () => {
    const t = ctp.value, v = $('#cto').value.trim();
    if (t !== 'link' && !v) throw new Error(t === 'user' ? 'Enter the recipient email' : 'Enter the recipient workspace id');
    const note = $('#cnote').value.trim();
    const r = await api(`/collections/${id}/cards`, { body: { recipient: t === 'workspace' ? { type: t, workspace_id: v } : t === 'user' ? { type: t, email: v } : { type: 'link' }, expires_at: iso($('#cex').value), scope: note ? { note } : {} } });
    cardIssued(r); reload();
  });
}
