// EMBARGO web app — THE BLACK ARCHIVE. Vanilla ES modules, no build step. Every screen from embargo.md Part 6.6.
// app.js: boot, auth, shell (sidebar + live Warden status), router, shortcuts, notifications. Screens live in app-*.js.
import { boot as brandBoot, wordmark, dither, soundButton, sound, motion } from '/static/assets/brand.js';
import { $, $$, esc, api, S, AGENT, icon, toast, wrap, modal, view, enhance, cleanup, loading, isAdmin, ago, initials, go, eye, scramble, busy } from '/static/assets/app-core.js';
import * as L from '/static/assets/app-blocks.js';
import * as D from '/static/assets/app-desk.js';
import * as O from '/static/assets/app-ops.js';
import * as V from '/static/assets/app-sealed.js';

await brandBoot({ smooth: true, cursor: true, grain: true, preloader: false });

// Lenis' anchor helper in brand.js runs document.querySelector(href) for every a[href^="#"]; app routes like
// "#blocks/<id>" are not selectors. Stop those clicks at <body> (after our own handlers ran) so only the router sees them.
document.body.addEventListener('click', (e) => { const a = e.target.closest?.('a[href^="#"]'); if (a && a.getAttribute('href').length > 1) e.stopPropagation(); });

// ---------------------------------------------------------------- boot / auth
let wm = null;
async function start() {
  // Session probe. After an explicit sign-out the next load skips it (no pointless 401); redirects (magic link) always probe.
  const redirected = performance.getEntriesByType('navigation')[0]?.redirectCount > 0;
  const skip = localStorage['emb.out'] === '1' && !redirected && !S.forceProbe;
  S.forceProbe = false;
  S.me = null;
  if (!skip) { try { S.me = await api('/me', { quiet: true }); } catch { S.me = null; } }
  if (!S.me) return authView();
  localStorage.removeItem('emb.out');
  if (location.hash.startsWith('#invite/')) {
    try { const r = await api(`/invites/${location.hash.slice(8)}/accept`, { body: {} }); S.ws = r.workspace_id; localStorage.ws = S.ws; toast(`Clearance granted: you joined as ${r.role.replace('_', ' ')}`); S.me = await api('/me', { quiet: true }); }
    catch (e) { toast(e.message, 'err'); }
    history.replaceState(null, '', '#library');
  }
  if (localStorage.ws && localStorage.ws !== S.ws && S.me.workspaces.some((w) => w.id === localStorage.ws)) S.ws = localStorage.ws;
  if (!S.me.workspaces.find((w) => w.id === S.ws)) S.ws = S.me.workspaces[0]?.id || null;
  if (!S.ws) return onboardingView();
  localStorage.ws = S.ws;
  await loadWorkspace();
  shell(); route();
}
async function loadWorkspace() {
  const [w, members, persons] = await Promise.all([api(`/workspaces/${S.ws}`), api(`/workspaces/${S.ws}/members`).catch(() => []), api(`/workspaces/${S.ws}/persons`).catch(() => [])]);
  S.wsInfo = w; S.members = members; S.persons = persons;
  S.myPerson = persons.find((p) => p.user_id === S.me.user.id) ?? null;
  S.pendingRequests = 0;
  if (isAdmin()) S.pendingRequests = (await api(`/workspaces/${S.ws}/access-requests`, { quiet: true }).catch(() => [])).filter((r) => r.status === 'pending').length;
}
S.hooks.reloadWorkspace = async () => { await loadWorkspace(); shell(); route(); };
S.hooks.restart = start;

function killAuthArt() { wm?.destroy(); wm = null; cleanup($('#root')); }
function authFrame(right, { h1, h2, p }) {
  killAuthArt();
  $('#root').innerHTML = `<div class="auth">
    <section class="auth-l">
      <div class="auth-meta"><span class="lbl"><b>00</b>ACCESS TERMINAL</span><span>EMBARGO // THE BLACK ARCHIVE</span><span class="hm">${esc(AGENT.id)} · ${esc(AGENT.name)} ON DUTY</span></div>
      <canvas class="wm" id="wm" aria-label="EMBARGO" role="img"></canvas>
      <div><h1 class="auth-h">${h1}<span class="acid">${h2}</span></h1><p class="auth-p" style="margin-top:18px">${p}</p></div>
      <div class="auth-desk" aria-hidden="true">
        <div class="paper"><div class="dh"><span class="ph">Pricing decision</span><span class="did">N-3A91F0</span></div><canvas data-d="mountains" data-s="9"></canvas><div>Pro launches at <span class="rd">₹499/month</span>. Embargo until <span class="rd">15 Nov</span>.</div></div>
        <div class="paper"><div class="dh"><span class="ph">Security internals</span><span class="did">N-62E646</span></div><canvas data-d="blueprint" data-s="6"></canvas><div>Sealed use. Tools may <span class="rd">answer from this</span>; never the text.</div></div>
        <div class="paper"><div class="dh"><span class="ph">Tuesday standup</span><span class="did">C-463AB8</span></div><canvas data-d="galaxy" data-s="4"></canvas><div>Line 03 held: <span class="rd">speaker decides</span>.</div></div>
      </div>
    </section>
    <section class="auth-r">${right}</section></div>`;
  wm = wordmark($('#wm'), { intro: true });
  $('#wm').addEventListener('click', () => { wm?.burst(); sound.stamp(); });
  requestAnimationFrame(() => { for (const c of $$('canvas[data-d]')) dither(c, c.dataset.d, { seed: Number(c.dataset.s), scale: 2 }); });
  enhance($('#root'));
}

function authView() {
  const inv = location.hash.startsWith('#invite/');
  authFrame(`<form class="term" id="f" onsubmit="return false" autocomplete="on">
    <div class="term-h"><span>Present clearance</span><b>FORM 00-A</b></div>
    <div class="term-b">
      ${inv ? '<div class="invite-note">You hold an invite. Sign in or create an account and you will join the workspace with the role on the invite.</div>' : ''}
      <h2>Sign in.</h2>
      <label class="field"><span>Name <i>(new accounts)</i></span><input id="dn" placeholder="Asha Rao" autocomplete="name"></label>
      <label class="field"><span>Email</span><input id="em" type="email" placeholder="asha@company.com" autocomplete="email"></label>
      <button class="bt acid full" id="pkLogin" type="button" data-cursor="PASSKEY">${icon('fingerprint', 14)}<span>Sign in with passkey</span><span class="ar">→</span></button>
      <button class="bt full" id="pkReg" type="button">Create account with passkey</button>
      <div class="or">or</div>
      <button class="bt ghost full" id="ml" type="button">${icon('mail', 13)}Email me a magic link</button>
      <button class="bt quiet full" id="dev" type="button" data-cursor="DEV">Developer sign-in · no email needed</button>
      <div id="out" class="out"></div>
    </div>
    <div class="wd">${eye('watch', '', true)}<span>No passwords and no wallet setup. Your passkey also signs your consent and sharing records.</span></div>
  </form>`, { h1: 'The archive is sealed.', h2: 'Present clearance.', p: `Embargo is one governed memory that every AI tool your team uses reads through MCP. ${esc(AGENT.name)} keeps it: files what comes in, proposes changes, answers sealed questions without quoting and holds actions that would leak.` });
  const em = () => $('#em').value.trim(), dn = () => $('#dn').value.trim();
  $('#pkReg').onclick = wrap(async () => {
    if (!window.PublicKeyCredential) throw new Error('This browser has no passkey support. Use the magic link.');
    const { challenge_id, options } = await api('/auth/passkey/register/options', { body: { display_name: dn() || undefined, email: em() || undefined } });
    const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
    await api('/auth/passkey/register/verify', { body: { challenge_id, response: cred.toJSON() } }); enter();
  });
  $('#pkLogin').onclick = wrap(async () => {
    if (!window.PublicKeyCredential) throw new Error('This browser has no passkey support. Use the magic link.');
    const { challenge_id, options } = await api('/auth/passkey/login/options', { body: {} });
    const cred = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
    await api('/auth/passkey/login/verify', { body: { challenge_id, response: cred.toJSON() } }); enter();
  });
  $('#ml').onclick = wrap(async () => {
    if (!em()) throw new Error('Enter your email first');
    const r = await api('/auth/magic-link', { body: { email: em() } });
    $('#out').innerHTML = r.dev_link ? `Development link: <a class="u" href="${esc(r.dev_link)}">open the sign-in link</a>` : 'Check your inbox for a one-time sign-in link.';
  });
  $('#dev').onclick = wrap(async () => {
    if (!em()) throw new Error('Enter an email for the developer sign-in');
    const restore = busy($('#dev'), 'Opening archive');
    try { await api('/auth/dev-login', { body: { email: em(), display_name: dn() || undefined } }); } finally { restore(); }
    enter();
  });
  $('#em').onkeydown = (e) => { if (e.key === 'Enter') $('#dev').click(); };
}
function enter() { sound.ok(); killAuthArt(); S.forceProbe = true; start(); }

function onboardingView() {
  authFrame(`<form class="term" onsubmit="return false"><div class="term-h"><span>New archive</span><b>FORM 00-B</b></div>
    <div class="term-b"><h2>Name your workspace.</h2><p class="hint">Usually your company. You can invite your team next and give your founder's office the context admin role.</p>
      <label class="field"><span>Workspace</span><input id="wn" placeholder="Acme" autofocus></label>
      <button class="bt acid full" id="wc">Open the archive<span class="ar">→</span></button>
      <button class="bt quiet full" id="lo" type="button">Sign out</button></div></form>`,
  { h1: 'Open a new', h2: 'archive.', p: `${esc(AGENT.name)} will file everything you add, keep versions, and propose changes for you to approve.` });
  $('#wc').onclick = wrap(async () => { const w = await api('/workspaces', { body: { name: $('#wn').value.trim() || 'My team' } }); S.ws = w.id; localStorage.ws = w.id; history.replaceState(null, '', '#library'); enter(); });
  $('#lo').onclick = wrap(async () => { await api('/auth/logout', { body: {} }); localStorage['emb.out'] = '1'; killAuthArt(); start(); });
}

// ---------------------------------------------------------------- shell
const NAV = [
  ['Archive'],
  ['library', 'Library', 'L'], ['inbox', `${AGENT.name}'s desk`, 'D', true], ['collections', 'Collections', 'C'], ['sealed', 'Sealed vault', 'V'],
  ['Distribution'],
  ['connections', 'Connections', 'T'], ['sharing', 'Sharing', 'S'],
  ['Audit'],
  ['activity', 'Activity', 'A'], ['savings', 'Savings', 'K'], ['people', 'People', 'P'], ['records', 'Records', 'R'],
  ['System'],
  ['integrations', 'Integrations', 'I'], ['settings', 'Workspace', 'W'],
];
const GO = Object.fromEntries(NAV.filter((n) => n.length > 1).map(([k, , key]) => [key.toLowerCase(), k]));
const TITLES = Object.fromEntries(NAV.filter((n) => n.length > 1).map(([k, l]) => [k, l]));

function shell() {
  killAuthArt();
  const u = S.me.user;
  let i = 0;
  const nav = NAV.map((n) => {
    if (n.length === 1) return `<div class="grp">${esc(n[0])}</div>`;
    const [k, l, key, adminOnly] = n;
    if (adminOnly && !isAdmin()) return '';
    i++;
    return `<a href="#${k}" data-k="${k}" data-scramble><span class="n">${String(i).padStart(2, '0')}</span><span class="lb scr">${esc(l)}</span><span class="nb" data-badge="${k}"></span><kbd class="kk">G ${key}</kbd></a>`;
  }).join('');
  $('#root').innerHTML = `<div class="shell">
    <aside class="side" id="side">
      <a class="logo" href="/" data-shutter data-cursor="SITE"><span class="mk"><i></i><i></i></span>EMBARGO<small>ARCHIVE ${esc(AGENT.id)}</small></a>
      <div class="ws"><select id="wsSel" aria-label="Workspace">${S.me.workspaces.map((w) => `<option value="${w.id}" ${w.id === S.ws ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}<option value="__new">+ New workspace</option></select>
        <div class="chips"><span class="chip ${isAdmin() ? 'acid' : 'ink'}">${esc((S.wsInfo?.role || '').replace('_', ' '))}</span><span class="chip dim">${esc(S.wsInfo?.plan || 'free')} plan</span></div></div>
      <div class="wcell" id="wcell" data-state="idle" role="status" tabindex="0" data-cursor="${isAdmin() ? 'DESK' : 'WARDEN'}">${eye('idle', '', true)}<div><div class="w1" id="w1">${esc(AGENT.name)} · WATCHING</div><div class="w2" id="w2">&nbsp;</div></div></div>
      <nav class="nav" id="nav" aria-label="Sections">${nav}</nav>
      <div class="newb"><button class="bt acid" id="newBlock" data-cursor="NEW">${icon('plus', 13)}New block<kbd style="margin-left:auto;border-color:rgba(10,10,8,.3);color:inherit">C</kbd></button></div>
      <div class="me"><span class="av">${esc(initials(u.display_name))}</span><div style="min-width:0"><div class="nm">${esc(u.display_name)}</div><div class="sub" id="sndSlot"></div></div>
        <button class="bt xs quiet icon" id="out" title="Sign out" aria-label="Sign out" data-cursor="SIGN OUT">${icon('logout', 13)}</button></div>
    </aside>
    <div class="scrim" id="scrim"></div>
    <div class="main">
      <div class="top" id="top">
        <button class="bt xs quiet icon mb-only" id="menu" aria-label="Menu">${icon('menu', 15)}</button>
        <a class="tlogo" href="#library">${eye('watch', '', true)}EMBARGO</a>
        <div class="crumbs" id="crumbs"></div>
        <div class="sp"><span class="clock tnum" id="clock"></span><button class="keys" id="keys" type="button" data-cursor="KEYS">${icon('keyboard', 13)} ?</button>
          <button class="bt xs ghost icon bell" id="bell" aria-label="Notifications" data-cursor="NOTICES">${icon('bell', 13)}<span class="cnt" id="bellN" hidden></span></button></div>
      </div>
      <main class="view" id="view"></main>
    </div></div>`;
  $('#sndSlot').appendChild(soundButton());
  enhance($('#root'));
  $('#wsSel').onchange = wrap(async (e) => {
    if (e.target.value === '__new') {
      e.target.value = S.ws;
      return newWorkspace();
    }
    S.ws = e.target.value; localStorage.ws = S.ws; history.replaceState(null, '', '#library');
    await loadWorkspace(); shell(); route();
  });
  $('#newBlock').onclick = () => L.composer();
  $('#out').onclick = wrap(async () => { await api('/auth/logout', { body: {} }); stopPolling(); localStorage['emb.out'] = '1'; start(); });
  $('#bell').onclick = notificationsModal;
  $('#keys').onclick = shortcutsModal;
  $('#wcell').onclick = () => go(isAdmin() ? 'inbox' : 'activity');
  $('#wcell').onkeydown = (e) => { if (e.key === 'Enter') $('#wcell').click(); };
  const side = $('#side'), scrim = $('#scrim');
  const drawer = (on) => { side.classList.toggle('open', on); scrim.classList.toggle('on', on); };
  $('#menu').onclick = () => drawer(!side.classList.contains('open'));
  scrim.onclick = () => drawer(false);
  $('#nav').addEventListener('click', () => drawer(false));
  tickClock(); clearInterval(S.clockT); S.clockT = setInterval(tickClock, 1000);
  status(); startPolling();
}
function newWorkspace() {
  modal(`<div class="md-t">Open a new archive</div><div class="md-d">A separate workspace with its own members, blocks, keys and records.</div>
    <label class="field"><span>Workspace name</span><input id="nwn" placeholder="Acme Labs"></label><div class="md-f"><button class="bt sm acid" id="nwc">Create workspace</button></div>`, (el, close) => {
    $('#nwc', el).onclick = wrap(async () => { const w = await api('/workspaces', { body: { name: $('#nwn', el).value.trim() || 'New workspace' } }); close(); S.ws = w.id; localStorage.ws = w.id; S.me = await api('/me'); history.replaceState(null, '', '#library'); await loadWorkspace(); shell(); route(); toast(`Archive "${w.name}" opened`); });
    $('#nwn', el).onkeydown = (e) => { if (e.key === 'Enter') $('#nwc', el).click(); };
  }, { label: 'New workspace', code: 'FORM 00-B', width: 480 });
}
function tickClock() { const c = $('#clock'); if (c) c.textContent = `LOCAL ${new Date().toTimeString().slice(0, 8)}`; }

// ---------------------------------------------------------------- Warden status (sidebar cell)
function wardenState() {
  const c = S.wsInfo?.counts ?? {};
  const unread = (S.me?.notifications || []).filter((n) => !n.read_at && n.workspace_id === S.ws);
  const anomalies = unread.filter((n) => n.kind === 'anomaly').length;
  const held = isAdmin() ? c.held_actions || 0 : 0;
  const desk = isAdmin() ? (c.open_suggestions || 0) + (S.pendingRequests || 0) + held : 0;
  const s = (n) => (n === 1 ? '' : 'S');
  if (S.processing || S.busy) return ['think', S.processing ? `FILING ${S.processing} BLOCK${s(S.processing)}` : 'WORKING ON IT'];
  if (held || anomalies) return ['alert', held ? `${held} ACTION${s(held)} HELD` : `${anomalies} ANOMAL${anomalies === 1 ? 'Y' : 'IES'} FLAGGED`];
  if (desk) return ['held', `${desk} ITEM${s(desk)} ON YOUR DESK`];
  return ['idle', isAdmin() ? 'ARCHIVE QUIET' : 'WATCHING THE ARCHIVE'];
}
let lastStatus = '';
function status() {
  const cell = $('#wcell'); if (!cell) return;
  const [st, text] = wardenState();
  const c = S.wsInfo?.counts ?? {};
  cell.dataset.state = st;
  const cv = $('canvas', cell); if (cv?._warden) cv._warden.state = st === 'idle' ? 'watch' : st;
  const tcv = $('.tlogo canvas'); if (tcv?._warden) tcv._warden.state = st === 'idle' ? 'watch' : st;
  const line = `${AGENT.name} · ${text}`;
  if (line !== lastStatus) { lastStatus = line; scramble($('#w1'), line, { duration: .5 }); }
  $('#w2').textContent = `${c.active_blocks ?? 0} BLOCKS · ${c.connections ?? 0} TOOL${c.connections === 1 ? '' : 'S'} · ${c.members ?? 0} CLEARED`;
  // nav badges + bell
  const setB = (k, n, cls = '') => { const b = $(`[data-badge="${k}"]`); if (b) { b.textContent = n ? String(n) : ''; b.className = `nb ${cls}`; } };
  setB('inbox', isAdmin() ? (c.open_suggestions || 0) + (S.pendingRequests || 0) + (c.held_actions || 0) : 0, c.held_actions ? 'red' : '');
  const unread = (S.me?.notifications || []).filter((n) => !n.read_at && n.workspace_id === S.ws).length;
  const bn = $('#bellN'); if (bn) { bn.hidden = !unread; bn.textContent = unread > 9 ? '9+' : String(unread); }
  document.title = `${unread ? `(${unread}) ` : ''}EMBARGO — ${TITLES[curTab] ?? 'Archive'}`;
}
S.hooks.status = status;
let pollT = 0;
async function poll() {
  if (document.hidden || !S.ws || !S.me) return;
  try {
    const [w, me] = await Promise.all([api(`/workspaces/${S.ws}`, { quiet: true }), api('/me', { quiet: true })]);
    S.wsInfo = { ...S.wsInfo, ...w }; S.me = me;
    if (isAdmin()) S.pendingRequests = (await api(`/workspaces/${S.ws}/access-requests`, { quiet: true }).catch(() => [])).filter((r) => r.status === 'pending').length;
    if (S.processing) S.processing = (await api(`/workspaces/${S.ws}/blocks`, { quiet: true })).filter((b) => ['queued', 'processing'].includes(b.processing_state)).length;
    status();
  } catch (e) { if (e.status === 401) { stopPolling(); localStorage['emb.out'] = '1'; start(); } }
}
S.hooks.poll = poll;
function startPolling() { stopPolling(); pollT = setInterval(poll, 20000); }
function stopPolling() { clearInterval(pollT); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

// ---------------------------------------------------------------- router
let curTab = 'library';
const ROUTES = {
  library: () => L.libraryView(), blocks: (id) => (id ? L.blockView(id) : L.libraryView()),
  collections: (id) => (id ? L.collectionView(id) : L.collectionsView()),
  inbox: (...a) => D.deskView(...a), desk: (...a) => D.deskView(...a), requests: () => D.deskView('requests'),
  sealed: (id) => V.vaultView(id), vault: (id) => V.vaultView(id),
  connections: () => O.connectionsView(), sharing: () => O.sharingView(), activity: () => O.activityView(), savings: () => O.savingsView(),
  people: (id) => (id ? O.personView(id) : O.peopleView()), records: () => O.recordsView(),
  integrations: () => O.integrationsView(), settings: () => O.settingsView(), billing: () => O.settingsView(), workspace: () => O.settingsView(),
};
const ALIAS = { blocks: 'library', desk: 'inbox', requests: 'inbox', vault: 'sealed', billing: 'settings', workspace: 'settings' };
async function route() {
  if (!S.me || !S.ws || !$('#view')) return;
  const raw = location.hash.slice(1);
  const [path, query] = raw.split('?');
  const [tab, ...args] = path.split('/');
  const k = ROUTES[tab] ? tab : 'library';
  curTab = ALIAS[k] ?? k;
  if (query) { const q = new URLSearchParams(query); if (q.get('wispr') === 'connected') toast('Wispr Notetaker connected'); if (q.get('wispr_error')) toast(`Wispr: ${q.get('wispr_error')}`, 'err'); }
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.k === curTab));
  $('#crumbs').innerHTML = `<span>${esc(S.wsInfo?.name ?? '')}</span><i>/</i>${args[0] && ['blocks', 'collections', 'people', 'sealed'].includes(tab) ? `<a href="#${curTab}">${esc(TITLES[curTab])}</a><i>/</i><b id="crumbX">${esc(args[0].slice(-6).toUpperCase())}</b>` : `<b>${esc(TITLES[curTab] ?? 'Library')}</b>`}`;
  if (motion.lenis) motion.lenis.scrollTo(0, { immediate: true, force: true }); else scrollTo(0, 0);
  const v = $('#view');
  cleanup(v); v.innerHTML = loading();
  try { await ROUTES[k](...args); }
  catch (e) {
    console.warn(e);
    view(`<div class="empty">${eye('alert', 'l', false)}<div class="px">${e.status === 404 ? 'File not found' : e.status === 403 ? 'Not cleared' : 'Something went sideways'}</div><p>${esc(e.message)}</p><a class="bt sm" href="#library">Back to the library</a></div>`);
  }
  status();
}
S.hooks.route = route;
window.addEventListener('hashchange', () => { if (S.me && S.ws && $('#view')) route(); });

// ---------------------------------------------------------------- notifications
const NK = { anomaly: 'red', held_action: 'red', digest: 'acid', reminder: 'amber', review_reminder: 'amber', deletion_certificate: 'ink', integration: 'ink', suggestion: 'amber', review_undelivered: 'red' };
function openLink(link) {
  if (!link) return;
  if (link.startsWith('/app#')) location.hash = link.slice(5);
  else if (link.startsWith('#')) location.hash = link.slice(1);
  else if (/^https?:/.test(link)) window.open(link, '_blank', 'noopener');
  else location.href = link;
}
function notificationsModal() {
  const list = (S.me.notifications || []).filter((n) => n.workspace_id === S.ws || !n.workspace_id);
  modal(`<div class="md-t">Notices</div>
    <div>${list.length ? list.map((n) => `<div class="notif ${n.read_at ? '' : 'unread'}"><span class="chip ${NK[n.kind] ?? 'dim'}">${esc(n.kind.replace(/_/g, ' '))}</span>
      <div class="tx">${esc(n.hint)}<small>${ago(n.created_at)}${n.read_at ? ' · read' : ''}</small></div>${n.link ? `<button class="bt xs" data-open="${n.id}">Open<span class="ar">→</span></button>` : `<span></span>`}</div>`).join('') : `<p class="hint">Nothing yet. ${esc(AGENT.name)} posts notices here.</p>`}</div>
    <div class="md-f"><button class="bt sm ghost" id="mar" ${list.some((n) => !n.read_at) ? '' : 'disabled'}>Mark all read</button></div>`, (el, close) => {
    const mark = (n) => { if (n.read_at) return; n.read_at = new Date().toISOString(); return api(`/notifications/${n.id}/read`, { body: {}, quiet: true }).catch(() => {}); };
    $$('[data-open]', el).forEach((b) => (b.onclick = () => { const n = list.find((x) => x.id === b.dataset.open); mark(n); close(); status(); openLink(n.link); }));
    $('#mar', el).onclick = wrap(async () => { await Promise.all(list.map(mark)); status(); close(); toast('All notices marked read', 'info'); });
  }, { label: 'Notices', code: `${list.filter((n) => !n.read_at).length} UNREAD`, width: 620 });
}

// ---------------------------------------------------------------- keyboard shortcuts
function shortcutsModal() {
  const row = (k, d) => `<div><span>${esc(d)}</span><span>${k.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join('')}</span></div>`;
  modal(`<div class="md-t">Shortcuts</div><div class="shortcuts">
    ${row('C', 'New block')}${row('/', 'Search the library')}${row('?', 'This list')}${row('Esc', 'Close a panel')}
    ${NAV.filter((n) => n.length > 1 && (!n[3] || isAdmin())).map(([, l, key]) => row(`G ${key}`, `Go to ${l}`)).join('')}</div>`, null, { label: 'Keyboard', code: 'KEYS', width: 600 });
}
let gPending = 0;
document.addEventListener('keydown', (e) => {
  if (!S.me || !$('#view') || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable="true"]')) { if (e.key === 'Escape') t.blur(); return; }
  if (document.querySelector('.mb')) return;
  const key = e.key.toLowerCase();
  if (gPending) { gPending = 0; const r = GO[key]; if (r && (r !== 'inbox' || isAdmin())) { e.preventDefault(); go(r); } return; }
  if (key === 'g') { gPending = setTimeout(() => (gPending = 0), 1200); return; }
  if (key === 'c') { e.preventDefault(); L.composer(); }
  else if (e.key === '/') { e.preventDefault(); if (curTab !== 'library' || location.hash.startsWith('#blocks/')) { location.hash = 'library'; setTimeout(() => $('#q')?.focus(), 350); } else $('#q')?.focus(); }
  else if (e.key === '?') { e.preventDefault(); shortcutsModal(); }
});

start();
