// 05 CLEARANCE: pinned horizontal scroll through the four ways a block can be held. Each panel's document changes
// its redaction as the panel arrives; sealed use and blocked panels type out what a tool actually gets back.
import { $, $$, MQ, reduced, type } from './_util.js';

const IMG = { viewable: '#62731f', agent_only: '#7a5a20', sealed_use: '#6f6c62', blocked: '#6a2416' };

export async function init({ gsap, motion, sound, dither }) {
  const sec = $('#clearance'); if (!sec) return;
  const ST = motion.ScrollTrigger;
  const track = $('#clrTrack'), panels = $$('.clr-p', sec), idx = $('#clrIdx'), bar = $('#clrBar');
  const modes = $$('#modeRail span'), vis = $$('#visRail span');

  // dithered plates, redrawn on resize
  const plates = () => panels.forEach((p) => { const c = $('.cl-img', p); dither(c, c.dataset.k, { seed: Number(c.dataset.seed) || 1, scale: 3, fg: IMG[p.dataset.mode], bg: '#0e0e0b' }); });
  plates();
  let rt = 0; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(plates, 200); }).observe(track);

  // per-panel behaviour
  let active = -1, aoTimer = 0;
  const typed = new WeakSet();
  async function typeQA(p) {
    if (typed.has(p)) return; typed.add(p);
    for (const q of $$('.qa', p)) { await type(q, q.dataset.t, { speed: 12, sound }); if (q.classList.contains('no')) sound.deny(); if (q.classList.contains('ok')) sound.ok(); }
  }
  function enter(i) {
    if (i === active) return; active = i;
    const p = panels[i], mode = p.dataset.mode, doc = $('.cl-doc', p);
    idx.textContent = String(i + 1).padStart(2, '0');
    modes.forEach((m, k) => { m.classList.toggle('on', k === i); m.classList.toggle('red', k === i && mode === 'blocked'); });
    vis.forEach((v) => v.classList.toggle('on', v.dataset.v === p.dataset.vis));
    if (!ST || reduced() || !gsap) bar.style.transform = `scaleX(${(i + 1) / panels.length})`;
    clearInterval(aoTimer);
    if (!reduced()) panels.forEach((q, k) => { if (k !== i) { $('.cl-doc', q).classList.remove('clear', 'shut'); } });
    if (mode === 'viewable') setTimeout(() => doc.classList.add('clear'), 250);
    if (mode === 'agent_only') {
      const tabs = $$('.ao-tabs span', p), who = $('.ao-who', p);
      let mcp = false;
      const flip = () => { mcp = !mcp; doc.classList.toggle('clear', mcp); tabs[0].classList.toggle('on', !mcp); tabs[1].classList.toggle('on', mcp); who.textContent = mcp ? 'AN AI TOOL' : 'THE APP'; sound.tick(); };
      aoTimer = setInterval(flip, 2100); setTimeout(flip, 500);
    }
    if (mode === 'sealed_use') typeQA(p);
    if (mode === 'blocked') { setTimeout(() => { doc.classList.add('shut'); sound.stamp(); }, 300); typeQA(p); }
  }
  // the agent-only tabs are clickable too
  $$('.clr-p[data-mode="agent_only"] .ao-tabs span').forEach((t, k, all) => t.addEventListener('click', () => {
    clearInterval(aoTimer); const doc = t.closest('.cl-doc'); doc.classList.toggle('clear', k === 1);
    all.forEach((x, j) => x.classList.toggle('on', j === k)); $('.ao-who', doc).textContent = k ? 'AN AI TOOL' : 'THE APP';
  }));

  if (!gsap || !ST) { panels.forEach((p, i) => enter(i)); return; }
  const mm = gsap.matchMedia();
  mm.add({ h: MQ.pin.replace(' and (min-height: 600px)', ''), flow: MQ.flow, rm: MQ.rm }, (c) => {
    const { h, rm } = c.conditions;
    active = -1;
    if (h && !rm) {
      const dist = () => Math.max(0, track.scrollWidth - innerWidth);
      const tween = gsap.to(track, {
        x: () => -dist(), ease: 'none',
        scrollTrigger: { trigger: sec, start: 'top top', end: () => `+=${dist()}`, pin: true, scrub: 1, invalidateOnRefresh: true, anticipatePin: 1, onUpdate: (s) => { bar.style.transform = `scaleX(${.25 + s.progress * .75})`; } },
      });
      panels.forEach((p, i) => {
        ST.create({ trigger: p, containerAnimation: tween, start: 'left 62%', end: 'right 38%', onToggle: (s) => s.isActive && enter(i) });
        gsap.fromTo($('.cl-w', p), { x: 140 }, { x: -50, ease: 'none', scrollTrigger: { trigger: p, containerAnimation: tween, start: 'left right', end: 'right left', scrub: true } });
        gsap.fromTo($('.cl-img', p), { xPercent: 8, scale: 1.12 }, { xPercent: -8, scale: 1.12, ease: 'none', scrollTrigger: { trigger: p, containerAnimation: tween, start: 'left right', end: 'right left', scrub: true } });
        gsap.fromTo($('.cl-doc', p), { rotate: 6, y: 40 }, { rotate: -2.5, y: 0, ease: 'none', scrollTrigger: { trigger: p, containerAnimation: tween, start: 'left right', end: 'left 30%', scrub: true } });
      });
      ST.create({ trigger: sec, start: 'top 60%', onEnter: () => enter(0) });
    } else {
      gsap.set(track, { x: 0 });
      panels.forEach((p, i) => ST.create({ trigger: p, start: 'top 60%', end: 'bottom 40%', onToggle: (s) => s.isActive && enter(i) }));
      if (rm) panels.forEach((p) => { const d = $('.cl-doc', p); if (p.dataset.mode === 'viewable') d.classList.add('clear'); if (p.dataset.mode === 'blocked') d.classList.add('shut'); $$('.qa', p).forEach((q) => (q.textContent = q.dataset.t)); typed.add(p); });
    }
    return () => clearInterval(aoTimer);
  });
}
