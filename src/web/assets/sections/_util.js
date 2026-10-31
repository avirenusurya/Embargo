// Shared helpers for the landing section modules.
import { rng } from '/static/assets/brand.js';

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isTouch = () => matchMedia('(hover: none), (pointer: coarse)').matches;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Media conditions shared by the pinned set pieces. */
export const MQ = {
  pin: '(min-width: 761px) and (min-height: 600px) and (prefers-reduced-motion: no-preference)',
  pinWide: '(min-width: 1101px) and (min-height: 640px) and (prefers-reduced-motion: no-preference)',
  flow: '(prefers-reduced-motion: no-preference)',
  rm: '(prefers-reduced-motion: reduce)',
};

/** Calls fn(visible) whenever el enters/leaves the viewport. Returns a disconnect function. */
export function onView(el, fn, { threshold = 0, rootMargin = '0px' } = {}) {
  const io = new IntersectionObserver(([e]) => fn(e.isIntersecting, e), { threshold, rootMargin });
  io.observe(el);
  return () => io.disconnect();
}
/** Calls fn once, the first time el is visible. */
export function once(el, fn, opts = {}) {
  const off = onView(el, (v) => { if (v) { off(); fn(); } }, { threshold: .2, ...opts });
  return off;
}

/** Deterministic hex string. */
export function hex(seed, n = 64) { const r = rng(seed); let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(r() * 16)]; return `0x${s}`; }
export const short = (h, a = 4, b = 4) => `${h.slice(0, 2 + a)}…${h.slice(-b)}`;

/** Fills a flex container with barcode bars. */
export function barcode(el, seed = 1, n = 54) {
  const r = rng(seed); let html = '';
  for (let i = 0; i < n; i++) { const w = [1, 1, 2, 3][Math.floor(r() * 4)], g = [1, 2, 2, 3][Math.floor(r() * 4)]; html += `<i style="width:${w}px;margin-right:${g}px"></i>`; }
  el.innerHTML = html;
}

/** A time-ordered uuidv7-looking id, like the ones Embargo issues for records. */
export function uuid7(seed = Date.now()) {
  const t = Date.now().toString(16).padStart(12, '0'), r = rng(seed); const h = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${h(3)}-${'89ab'[Math.floor(r() * 4)]}${h(3)}-${h(12)}`;
}

/** Typewriter. Resolves when done; cancelled if token.dead becomes true. */
export function type(el, text, { speed = 14, sound, token = {} } = {}) {
  if (reduced()) { el.textContent = text; return Promise.resolve(); }
  return new Promise((res) => {
    let i = 0;
    const step = () => {
      if (token.dead) return res();
      i = Math.min(text.length, i + (text.length > 90 ? 2 : 1));
      el.textContent = text.slice(0, i);
      if (sound && i % 3 === 0) sound.type();
      if (i < text.length) setTimeout(step, speed); else res();
    };
    step();
  });
}

/** Current time in IST as HH:MM:SS. */
export function ist(offsetSec = 0) { const d = new Date(Date.now() + offsetSec * 1000 + (330 + new Date().getTimezoneOffset()) * 60000); return d.toTimeString().slice(0, 8); }
