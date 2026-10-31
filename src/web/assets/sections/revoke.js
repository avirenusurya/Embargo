// 08 REVOKE: the shredder. The block is stamped REVOKED, fed into the machine, comes out the bottom as strips that
// tumble away, the three data keys die one by one and a deletion certificate slides out. Scroll-scrubbed and pinned
// on desktop; elsewhere it plays when it comes into view, and the button replays it.
import { $, $$, MQ, reduced } from './_util.js';
import { rng } from '/static/assets/brand.js';

const N = 14;

export async function init({ gsap, motion, sound, dither }) {
  const sec = $('#revoke'); if (!sec) return;
  const ST = motion.ScrollTrigger;
  const doc = $('#rvDoc'), out = $('#rvOut'), img = $('#rvImg'), body = $('.sh-body', sec), led = $('#shLed'), state = $('#rvState');
  const keys = $$('#shKeys i'), count = $('#rvKeys'), cert = $('#rvCert'), dst = $('.rc-dst', cert), steps = $$('#rvSteps li'), stamp = $('#rvStamp');

  // static dithered plate as an <img> so the strips can carry it
  const plate = document.createElement('canvas');
  plate.style.cssText = 'position:absolute;left:-9999px;width:300px;height:110px';
  document.body.appendChild(plate);
  dither(plate, 'topo', { seed: 19, scale: 2 });
  img.src = plate.toDataURL('image/png'); plate.remove();

  let strips = [];
  function cut() {
    const clone = doc.cloneNode(true); clone.removeAttribute('id'); $$('[id]', clone).forEach((e) => e.removeAttribute('id'));
    const st = $('.rd-st', clone); st.style.cssText = 'opacity:.9;transform:rotate(-14deg)';
    out.innerHTML = '';
    // geometry is pure CSS (var(--dw)), so the strips stay aligned with the document at any width
    strips = Array.from({ length: N }, (_, i) => {
      const s = document.createElement('div'); s.className = 'shs';
      s.style.cssText = `left:calc(var(--dw) * ${i} / ${N});width:calc(var(--dw) / ${N} + .6px)`;
      const c = clone.cloneNode(true); c.style.left = `calc(var(--dw) * -${i} / ${N})`; s.appendChild(c); out.appendChild(s);
      return s;
    });
  }

  function build() {
    cut();
    const r = rng(7), dh = () => doc.offsetHeight;
    const tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
    let lastKeys = -1, lastState = '', sfx = { stamp: false, cert: false };
    const shredT = [1, 4.2], keysT = [2.2, 3.4, 4.2], certT = 5.6;
    tl.fromTo(stamp, { opacity: 0, scale: 2.4, rotate: -30 }, { opacity: .9, scale: 1, rotate: -14, duration: .4, ease: 'expo.in' }, .3)
      .fromTo(doc, { y: 0 }, { y: () => dh(), duration: shredT[1] - shredT[0], ease: 'power1.in' }, shredT[0])
      .fromTo(strips, { y: () => -dh() }, { y: 0, duration: shredT[1] - shredT[0], ease: 'power1.in' }, shredT[0])
      .to(strips, { x: (i) => (i - N / 2 + .5) * 3.2, rotate: () => (r() - .5) * 5, duration: 1.2, ease: 'power1.out' }, shredT[0] + 1.6)
      .to(strips, { y: () => `+=${innerHeight * (.5 + r() * .6)}`, x: (i) => `+=${(i - N / 2) * (8 + r() * 14)}`, rotate: () => (r() - .5) * 120, opacity: 0, duration: 1.6, ease: 'power2.in', stagger: { each: .05, from: 'random' } }, shredT[1] + .15)
      .fromTo(cert, { opacity: 0, y: 90, rotate: 9 }, { opacity: 1, y: 0, rotate: 2, duration: .9, ease: 'expo.out' }, certT)
      .fromTo(dst, { opacity: 0, scale: 2.8, rotate: -30 }, { opacity: .92, scale: 1, rotate: -10, duration: .35, ease: 'expo.in' }, certT + .7)
      .to({}, { duration: .4 });
    tl.eventCallback('onUpdate', () => {
      const t = tl.time();
      const k = keysT.filter((x) => t >= x).length;
      if (k !== lastKeys) { if (k > lastKeys && lastKeys >= 0 && k > 0) sound.deny(); lastKeys = k; keys.forEach((el, i) => el.classList.toggle('dead', i < k)); count.textContent = String(k); }
      const shredding = t > shredT[0] && t < shredT[1] + .2;
      body.style.transform = shredding ? `translate(${(Math.random() - .5) * 2.4}px,${(Math.random() - .5) * 1.6}px)` : '';
      const ns = t >= certT ? 'DESTROYED' : t >= keysT[0] ? 'DESTROYING KEYS' : shredding ? 'SHREDDING' : t > .3 ? 'REVOKED' : 'ARMED';
      if (ns !== lastState) {
        lastState = ns; state.textContent = ns;
        led.textContent = ns === 'DESTROYED' ? 'DONE' : shredding || ns === 'DESTROYING KEYS' ? 'SHREDDING' : 'ARMED';
        led.className = `sh-led ${ns === 'DESTROYED' ? 'done' : shredding || ns === 'DESTROYING KEYS' ? 'run' : ''}`;
      }
      const on = [t > .3, t >= keysT[0], t >= shredT[1], t >= shredT[1] + .4, t >= certT];
      steps.forEach((s, i) => s.classList.toggle('on', on[i]));
      if (t > .6 && !sfx.stamp) { sfx.stamp = true; sound.stamp(); } else if (t < .3) sfx.stamp = false;
      if (t > certT + 1 && !sfx.cert) { sfx.cert = true; sound.stamp(); } else if (t < certT) sfx.cert = false;
      if (shredding && Math.floor(t * 8) !== tl._g) { tl._g = Math.floor(t * 8); sound.tick(); }
    });
    return tl;
  }

  if (!gsap || !ST) return;
  let current = null, pinST = null;
  $('#rvGo').addEventListener('click', () => {
    if (!current) return;
    if (pinST && motion.lenis) { motion.lenis.scrollTo(pinST.end, { duration: 3.2, easing: (x) => 1 - Math.pow(1 - x, 2) }); return; }
    current.timeScale(1.5).restart(); sound.whoosh();
  });
  const mm = gsap.matchMedia();
  mm.add({ pin: MQ.pinWide, flow: MQ.flow, rm: MQ.rm }, (c) => {
    const { pin, rm } = c.conditions;
    const tl = build(); current = tl; pinST = null;
    if (rm) { tl.progress(1); return; }
    if (pin) pinST = ST.create({ trigger: sec, start: 'top top', end: () => `+=${Math.round(innerHeight * 2.2)}`, pin: true, scrub: 1, animation: tl, invalidateOnRefresh: true, anticipatePin: 1 });
    else ST.create({ trigger: $('.rv-c', sec), start: 'top 60%', once: true, onEnter: () => { tl.timeScale(1.5).play(0); sound.whoosh(); } });
    return () => { tl.kill(); body.style.transform = ''; gsap.set([doc, cert, dst, stamp], { clearProps: 'transform,opacity' }); };
  });
}
