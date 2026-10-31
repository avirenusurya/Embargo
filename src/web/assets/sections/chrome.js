// Page chrome for the landing: agent naming, scroll progress (nav readout, top bar, index rail) and the
// redaction-bar transitions between sections.
import { $, $$, reduced } from './_util.js';

export async function init({ gsap, motion, AGENT, scramble }) {
  // Agent name everywhere (rename in brand.js and the whole page follows).
  const cap = AGENT.name[0] + AGENT.name.slice(1).toLowerCase();
  $$('[data-agent]').forEach((el) => (el.textContent = /[a-z]/.test(el.textContent) ? cap : AGENT.name));
  $$('[data-agent-cap]').forEach((el) => (el.textContent = cap));
  $$('[data-agent-id]').forEach((el) => (el.textContent = AGENT.id));
  const fs = $('#ftSay'); if (fs) fs.textContent = `${AGENT.name} IS WATCHING`;

  const ST = motion.ScrollTrigger;
  if (!gsap || !ST) return;

  // ---- progress: top bar + nav readout + nav underline
  const top = document.createElement('div'); top.className = 'sprog'; top.innerHTML = '<b></b>'; document.body.appendChild(top);
  const topBar = top.firstChild, navBar = $('#navBar'), pct = $('#navPct'), file = $('#navFile'), name = $('#navName');
  let lastPct = -1;
  ST.create({
    start: 0, end: 'max', refreshPriority: -10,
    onUpdate(self) {
      const p = self.progress;
      topBar.style.transform = `scaleX(${p})`;
      if (navBar) navBar.style.transform = `scaleX(${p})`;
      const v = Math.round(p * 100);
      if (v !== lastPct && pct) { lastPct = v; pct.textContent = `${String(v).padStart(3, '0')}%`; }
    },
  });

  // ---- which file are we in
  const FILES = [
    ['#top', '01', 'THE BLACK ARCHIVE'], ['#product', '02', 'CONTROL'],
    ...$$('[data-file]').map((el) => [`#${el.id}`, el.dataset.file, el.dataset.name]),
  ].filter(([s]) => $(s));
  const rail = document.createElement('nav'); rail.className = 'idx'; rail.setAttribute('aria-label', 'Sections');
  rail.innerHTML = FILES.map(([s, n, nm]) => `<a href="${s}" data-cursor="${n}"><span>${n} ${nm}</span></a>`).join('');
  document.body.appendChild(rail);
  const links = $$('a', rail);
  let cur = -1;
  const setCur = (i) => {
    if (i === cur) return; cur = i;
    links.forEach((a, k) => a.classList.toggle('cur', k === i));
    const [, n, nm] = FILES[i];
    if (file) scramble(file, `FILE ${n.padStart(4, '0')}`, { duration: .4 });
    if (name) scramble(name, nm, { duration: .5 });
  };
  // created once every section has set up its pins, so pinned sections are tracked through their pin-spacer
  const track = () => {
    FILES.forEach(([s], i) => {
      const el = $(s), t = el.parentElement?.classList.contains('pin-spacer') ? el.parentElement : el;
      ST.create({ trigger: t, start: 'top 55%', end: 'bottom 55%', refreshPriority: -10, onToggle: (self) => self.isActive && setCur(i) });
    });
  };
  document.addEventListener('emb:ready', track, { once: true });
  setCur(0);
  ST.create({ trigger: '#warden', start: 'top 80%', refreshPriority: -10, onEnter: () => rail.classList.add('on'), onLeaveBack: () => rail.classList.remove('on') });

  // ---- redaction transitions between sections
  for (const x of $$('.xfer')) {
    const bars = $$('i', x), label = $('span', x);
    if (reduced()) continue;
    const tl = gsap.timeline({ scrollTrigger: { trigger: x, start: 'top bottom', end: 'bottom top', scrub: .6, refreshPriority: -10 } });
    bars.forEach((b, i) => {
      tl.fromTo(b, { scaleX: 0, transformOrigin: 'left center' }, { scaleX: 1, duration: .45, ease: 'power2.inOut' }, i * .06)
        .set(b, { transformOrigin: 'right center' }, .52 + i * .03)
        .to(b, { scaleX: 0, duration: .4, ease: 'power2.inOut' }, .55 + i * .06);
    });
    tl.fromTo(label, { opacity: .25, letterSpacing: '.5em' }, { opacity: 1, letterSpacing: '.16em', duration: .9, ease: 'power2.out' }, 0);
    ST.create({ trigger: x, start: 'top 85%', refreshPriority: -10, onEnter: () => { const b = $('b', label); if (b) scramble(b, b.textContent, { duration: .6 }); } });
  }

  // fonts change metrics; re-measure every trigger once they are in
  document.fonts?.ready.then(() => ST.refresh());
}
