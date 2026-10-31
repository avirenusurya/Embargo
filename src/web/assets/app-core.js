// Shared runtime for the Embargo app: API client, state, formatting, modals, stamped-slip toasts, view rendering + motion.
import { AGENT, refresh, scramble, motion, sound, warden } from '/static/assets/brand.js';
import { icon } from '/static/assets/icons.js';
export { AGENT, icon, motion, sound, scramble };

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
export const compact = (n) => { n = Number(n ?? 0); return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K` : fmt(n); };
export const pad = (n, w = 3) => String(n).padStart(w, '0');
export const initials = (n) => String(n ?? '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
export const iso = (v) => (v ? new Date(v).toISOString() : null);
export const localDT = (d) => (d ? new Date(new Date(d).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
export function ago(d) {
  if (!d) return '—';
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 0) return `in ${until(d)}`;
  if (s < 45) return 'just now'; if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).toUpperCase();
}
function until(d) { const s = (new Date(d) - Date.now()) / 1000; return s < 3600 ? `${Math.ceil(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; }
export const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const date = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
/** Archive file number for a block: kind letter + last six hex digits of its id (e.g. N-3C7A0E). */
export const KIND_L = { note: 'N', doc: 'D', url: 'U', repo: 'R', conversation: 'C', agent: 'A' };
export const docId = (b) => `${b.storage_mode === 'sealed_block' ? 'S' : KIND_L[b.kind] ?? 'X'}-${String(b.id || '').replace(/-/g, '').slice(-6).toUpperCase()}`;
export const shortId = (id) => String(id || '').replace(/-/g, '').slice(-8).toUpperCase();
/** Deterministic pseudo-random from a string (for redaction bar widths, barcodes). */
export function hashRand(str) { let h = 2166136261; for (const c of String(str)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1000) / 1000; }; }

// ---------------------------------------------------------------- API
export class ApiError extends Error { constructor(msg, status, code, body) { super(msg); this.status = status; this.code = code; this.body = body; } }
let inflight = 0;
const prog = () => document.getElementById('prog');
function progress(delta) {
  inflight = Math.max(0, inflight + delta);
  const p = prog(); if (!p) return;
  if (inflight > 0 && !p.classList.contains('on')) { p.classList.remove('done'); void p.offsetWidth; p.classList.add('on'); }
  if (inflight === 0 && p.classList.contains('on')) { p.classList.remove('on'); p.classList.add('done'); }
}
export async function api(path, opts = {}) {
  const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
  const headers = { accept: 'application/json', 'x-embargo-csrf': '1' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (!opts.quiet) progress(1);
  try {
    const r = await fetch(path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
    const isJson = r.headers.get('content-type')?.includes('json');
    const j = isJson ? await r.json().catch(() => null) : await r.text();
    if (!r.ok) throw new ApiError((j && (j.message || j.error)) || r.statusText || `HTTP ${r.status}`, r.status, j?.error, j);
    return j;
  } finally { if (!opts.quiet) progress(-1); }
}

// ---------------------------------------------------------------- state
export const S = { me: null, ws: localStorage.ws || null, wsInfo: null, busy: 0, processing: 0, pendingRequests: 0, myPerson: null, hooks: {} };
export const isAdmin = () => ['owner', 'context_admin'].includes(S.wsInfo?.role);
export const isOwner = () => S.wsInfo?.role === 'owner';
export const canEdit = () => S.wsInfo?.role && S.wsInfo.role !== 'viewer';
export const go = (hash) => { if (location.hash === `#${hash}`) S.hooks.route?.(); else location.hash = hash; };
export const status = () => S.hooks.status?.();
/** Mark a long-running operation so Warden shows `think` while it runs. */
export async function working(fn) { S.busy++; status(); try { return await fn(); } finally { S.busy--; status(); } }

// ---------------------------------------------------------------- toasts: stamped slips
const SLIP = { ok: 'FILED', err: 'REFUSED', held: 'HELD', info: 'NOTED' };
export function toast(msg, kind = 'ok', { html = false, ms = 5200 } = {}) {
  if (kind === true) kind = 'err';
  const box = document.getElementById('toasts'); if (!box) return;
  const d = document.createElement('div');
  d.className = `slip ${kind}`; d.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  d.innerHTML = `<span class="stamp ${kind}">${SLIP[kind] ?? 'NOTED'}</span><span class="t">${html ? msg : esc(msg)}</span>`;
  box.appendChild(d);
  (kind === 'err' ? sound.deny : sound.stamp)();
  const G = motion.gsap;
  if (G) G.fromTo(d, { y: 24, opacity: 0, rotate: kind === 'err' ? 3 : -4 }, { y: 0, opacity: 1, rotate: d.matches(':nth-child(even)') ? .9 : -1.2, duration: .35, ease: 'expo.out' });
  const kill = () => { if (!d.isConnected) return; if (G) G.to(d, { x: 40, opacity: 0, duration: .25, ease: 'expo.in', onComplete: () => d.remove() }); else d.remove(); };
  setTimeout(kill, ms);
  d.addEventListener('click', kill);
  while (box.children.length > 4) box.firstElementChild.remove();
}
export const errMsg = (e) => (e?.status === 403 ? `Not cleared: ${e.message}` : e?.message || String(e));
export const wrap = (fn) => async (...a) => { try { await fn(...a); } catch (e) { console.warn(e); toast(errMsg(e), 'err'); } };
/** Swap a button into a working state; returns a restore function. */
export function busy(btn, label = 'WORKING') {
  if (!btn) return () => {};
  const html = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${esc(label)}`;
  return () => { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } };
}
export async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(`${what} to clipboard`, 'info', { ms: 2200 }); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast(`${what} to clipboard`, 'info', { ms: 2200 }); }
}
export const b64file = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });

// ---------------------------------------------------------------- enhancement + cleanup
const SCROLLERS = 'textarea, select[multiple], pre, .diff, .nav, .coll-list, [data-scroll], .md, .mb';
const HSCROLLERS = '.tw, .tabs, .chips.scroll';
/** Bring a freshly rendered subtree to life: wardens, reveals, scramble hovers; keep nested scrollers native under Lenis. */
export function enhance(root) {
  if (!root) return;
  const all = (sel) => (root.matches?.(sel) ? [root, ...$$(sel, root)] : $$(sel, root));
  for (const el of all(SCROLLERS)) el.setAttribute('data-lenis-prevent', '');
  for (const el of all(HSCROLLERS)) el.setAttribute('data-lenis-prevent-horizontal', '');
  // Eyes printed on paper need ink lids (brand wakeWardens only knows bone lids).
  for (const c of all('canvas[data-warden][data-lid]:not([data-awake])')) { c.dataset.awake = '1'; c._warden = warden(c, { state: c.dataset.warden || 'watch', glow: false, follow: c.dataset.follow !== '0', lid: c.dataset.lid }); }
  refresh(root);
}
/** Stop the eye animations living inside a subtree that is about to be replaced. */
export function cleanup(root) { if (!root) return; for (const c of $$('canvas[data-awake]', root)) { c._warden?.destroy(); delete c._warden; } }

let lastRouteKey = '';
/** Render a screen into #view with a short staggered entrance (<400 ms) and scramble the pixel title on route change. */
export function view(html, { key = location.hash, animate } = {}) {
  const v = document.getElementById('view'); if (!v) return;
  const routeChanged = key.split('?')[0] !== lastRouteKey;
  lastRouteKey = key.split('?')[0];
  cleanup(v);
  v.innerHTML = html;
  enhance(v);
  const G = motion.gsap;
  if ((animate ?? routeChanged) && G && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const kids = [...v.children].slice(0, 8);
    G.fromTo(kids, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: .28, ease: 'expo.out', stagger: .035, clearProps: 'transform,opacity' });
    const rows = $$('.ledger tbody tr, .memo', v).slice(0, 12);
    if (rows.length) G.fromTo(rows, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: .22, ease: 'power2.out', stagger: .018, delay: .06, clearProps: 'transform,opacity' });
    const h1 = $('.phd h1', v);
    if (h1 && routeChanged) { const t = h1.textContent; h1.textContent = ''; scramble(h1, t, { duration: .42 }); }
  }
}
export function loading(label = 'Retrieving files') { return `<div class="loading"><div class="ld"></div><span>${esc(label)}</span></div>`; }

/** Page head: index label, pixel title, description, actions. */
export function head({ n = '', label, title, desc = '', actions = '', meta = '' }) {
  return `<header class="phd"><div class="phd-meta"><span class="lbl"><b>${esc(n)}</b>${esc(label ?? title)}</span><span>${meta || `${esc(S.wsInfo?.name ?? '')} · ${esc(AGENT.id)}`}</span></div>
    <div><h1>${esc(title)}</h1>${desc ? `<p>${desc}</p>` : ''}</div><div class="acts">${actions}</div></header>`;
}
export const eye = (state = 'idle', size = '', follow = true, lid = '') => `<canvas class="warden eye ${size}" data-warden="${state}" data-glow="0" ${follow ? '' : 'data-follow="0"'} ${lid ? `data-lid="${lid}"` : ''} aria-hidden="true"></canvas>`;
/** Warden printed on paper: ink lids. */
export const eyeInk = (state = 'watch', size = '', follow = true) => eye(state, size, follow, '#191813');
export const wsay = (text, { state = 'watch', tone = '' } = {}) => `<div class="wsay ${tone}">${eye(state, 'm')}<div><span class="who">${esc(AGENT.name)}</span><p>${text}</p></div></div>`;
export const empty = (title, text = '', action = '') => `<div class="empty">${eye('sleep', 'l', false)}<div class="px">${esc(title)}</div>${text ? `<p>${text}</p>` : ''}${action}</div>`;

// clearance vocabulary
export const MODE = { viewable: ['allowed', 'Viewable'], agent_only: ['restricted', 'Agent only'], sealed_use: ['blocked', 'Sealed use'] };
export const modeChip = (b) => b.storage_mode === 'sealed_block' ? '<span class="chip blocked">Sealed block</span>' : `<span class="chip ${MODE[b.access_mode]?.[0] ?? ''}">${MODE[b.access_mode]?.[1] ?? esc(b.access_mode)}</span>`;
export const VIS = { private: 'blocked', team: 'ink', partner: 'restricted', public: 'allowed' };
export const STATUS_CHIP = { active: '', draft: 'restricted', archived: 'dim', revoked: 'blocked' };

// ---------------------------------------------------------------- modals: paper or ink panels
let openModals = 0;
/**
 * Opens a modal. kind: 'ink' (forms) | 'paper' (documents). Returns close(). onMount(el, close) wires it.
 * The backdrop and dialog carry data-lenis-prevent so wheel/touch scroll stays native inside them.
 */
export function modal(html, onMount, { kind = 'ink', label = 'Archive terminal', code = AGENT.id, width = 680, onClose } = {}) {
  const bg = document.createElement('div');
  bg.className = 'mb'; bg.setAttribute('data-lenis-prevent', '');
  bg.innerHTML = `<div class="md ${kind === 'paper' ? 'paper' : 'ink'}" role="dialog" aria-modal="true" style="--mw:${width}px" data-lenis-prevent>
    <div class="md-h"><span>${esc(label)} · <b>${esc(code)}</b></span><button class="md-x" type="button" aria-label="Close" data-cursor="CLOSE">✕</button></div><div class="md-b">${html}</div></div>`;
  const prevFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey, true);
    const G = motion.gsap;
    const done = () => { cleanup(bg); bg.remove(); openModals--; if (!openModals) motion.lenis?.start(); onClose?.(); prevFocus?.focus?.({ preventScroll: true }); };
    if (G) G.to(bg, { opacity: 0, duration: .16, onComplete: done }); else done();
  };
  const onKey = (e) => { if (e.key === 'Escape' && bg === [...document.querySelectorAll('.mb')].pop()) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.querySelector('.md-x').onclick = close;
  document.body.appendChild(bg);
  openModals++; motion.lenis?.stop();
  enhance(bg);
  const md = bg.firstElementChild;
  const G = motion.gsap;
  if (G) { G.fromTo(bg, { opacity: 0 }, { opacity: 1, duration: .16 }); G.fromTo(md, { y: 18, opacity: 0, rotate: kind === 'paper' ? -1 : 0 }, { y: 0, opacity: 1, rotate: 0, duration: .32, ease: 'expo.out' }); }
  onMount?.(md, close);
  setTimeout(() => $('[autofocus], input:not([type=hidden]):not([readonly]), textarea', md)?.focus({ preventScroll: true }), 40);
  return close;
}
/** Confirmation dialog. With `type` the user must type that exact text. Resolves true/false. */
export function confirmBox({ title, body = '', confirm = 'Confirm', danger = false, type = null, kind = 'ink', label = 'Confirmation' }) {
  return new Promise((res) => {
    let ok = false;
    modal(`<div class="md-t">${esc(title)}</div>${body ? `<div class="md-d">${body}</div>` : ''}
      ${type ? `<label class="field"><span>Type <b class="${danger ? 'red' : 'acid'}">${esc(type)}</b> to confirm</span><input id="cfx" autocomplete="off" spellcheck="false"></label>` : ''}
      <div class="md-f"><button class="bt sm ghost" type="button" data-x>Cancel</button><button class="bt sm ${danger ? 'red' : 'acid'}" type="button" data-ok ${type ? 'disabled' : ''}>${esc(confirm)}</button></div>`,
    (el, close) => {
      const okb = $('[data-ok]', el);
      if (type) $('#cfx', el).oninput = (e) => { okb.disabled = e.target.value.trim() !== type.trim(); };
      $('[data-x]', el).onclick = close;
      okb.onclick = () => { ok = true; close(); };
      if (type) $('#cfx', el).onkeydown = (e) => { if (e.key === 'Enter' && !okb.disabled) okb.click(); };
    }, { kind, label, onClose: () => res(ok), width: 520 });
  });
}

// ---------------------------------------------------------------- small render helpers
export const memberName = (id) => S.members?.find((m) => m.id === id)?.display_name ?? (id ? shortId(id) : '—');
export function barcode(id, n = 38) { const r = hashRand(id); let s = ''; for (let i = 0; i < n; i++) s += `<i style="width:${1 + Math.floor(r() * 3)}px;opacity:${r() > .85 ? .35 : 1}"></i>`; return `<span class="barcode" aria-hidden="true">${s}</span>`; }
export function redactBars(id, n = 3) { const r = hashRand(id); let s = ''; for (let i = 0; i < n; i++) s += `<i style="width:${Math.round(48 + r() * 50)}%"></i>`; return `<div class="bars">${s}</div>`; }
export function confHtml(c) {
  const v = Math.round((Number(c) || 0) * 100); const on = Math.round(v / 10);
  return `<div class="conf" title="Warden's confidence"><b>${v}<small>%</small></b><div class="dots">${Array.from({ length: 10 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div><span>Confidence</span></div>`;
}
export function pbar(v, max, cells = 12) { const on = max ? Math.max(v > 0 ? 1 : 0, Math.round((v / max) * cells)) : 0; return `<span class="pbar">${Array.from({ length: cells }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</span>`; }
export const tw = (inner, cls = '') => `<div class="tw ${cls}" data-lenis-prevent-horizontal>${inner}</div>`;
