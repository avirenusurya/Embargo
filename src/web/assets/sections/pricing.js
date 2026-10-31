// 10 PRICING: limits from src/config.ts `plans`. Rows are declassified by sweeping bars, numbers count up (brand
// [data-count]), the recommended column carries a running tag, hovering a column lights it.
import { $, $$, reduced, once } from './_util.js';

export async function init({ gsap, sound }) {
  const tbl = $('#prTbl'); if (!tbl) return;
  const tag = $('.pr-tag', tbl); if (tag) { const track = document.createElement('span'); track.className = 'pr-track'; const a = tag.firstElementChild; track.append(a, a.cloneNode(true)); tag.appendChild(track); }
  tbl.addEventListener('pointerover', (e) => { const c = e.target.closest('[data-c]'); tbl.classList.toggle('hl-free', c?.dataset.c === 'free'); });
  tbl.addEventListener('pointerleave', () => tbl.classList.remove('hl-free'));
  if (!gsap || reduced()) return;
  const rows = $$('.pr-row', tbl);
  rows.forEach((r) => r.insertAdjacentHTML('beforeend', '<i class="bar" aria-hidden="true"></i>'));
  const cells = rows.flatMap((r) => [...r.children].filter((c) => !c.classList.contains('bar')));
  gsap.set(cells, { opacity: 0 });
  once(tbl, () => {
    const tl = gsap.timeline();
    rows.forEach((r, i) => {
      const bar = $('.bar', r), kids = [...r.children].filter((c) => c !== bar);
      tl.fromTo(bar, { scaleX: 0, transformOrigin: 'left center' }, { scaleX: 1, duration: .35, ease: 'expo.inOut' }, i * .08)
        .set(kids, { opacity: 1 }, i * .08 + .35)
        .set(bar, { transformOrigin: 'right center' }, i * .08 + .35)
        .to(bar, { scaleX: 0, duration: .4, ease: 'expo.inOut', onStart: () => sound.tick() }, i * .08 + .36);
    });
  }, { threshold: .15 });
}
