// 04 COMPRESSION: pinned + scrubbed. Filler is struck out, small talk is redacted and collapses, the guest's lines
// are held for consent, the useful parts light up and the structured block assembles while the token counter drops.
import { $, $$, MQ } from './_util.js';

const RAW = 4812, BLOCK = 1146;
const fmt = (v) => Math.round(v).toLocaleString('en-US');

export async function init({ gsap, motion, sound }) {
  const sec = $('#compression'); if (!sec) return;
  const ST = motion.ScrollTrigger; if (!gsap || !ST) return;
  const lines = $$('.ln', sec), noise = lines.filter((l) => l.classList.contains('n')), guest = lines.filter((l) => l.classList.contains('g')), keep = lines.filter((l) => l.classList.contains('k'));
  noise.forEach((l) => l.insertAdjacentHTML('beforeend', '<i class="bar" aria-hidden="true"></i>'));
  const tok = $('#cpTok'), rail = $('#cpRail'), save = $('#cpSave'), phase = $('#cpPhase'), more = $('#cpMore');
  const fields = $$('.cb-f', sec), stamp = $('#cbStamp');
  const PHASES = [[0, 'RAW TRANSCRIPT'], [.08, 'STRIKING FILLER'], [.25, 'REDACTING SMALL TALK'], [.38, 'HOLDING GUEST LINES'], [.5, 'EXTRACTING FACTS'], [.62, 'WRITING THE BLOCK'], [.97, 'FILED']];

  function build() {
    const o = { v: RAW, n: 0 };
    let lastPhase = '', stamped = false;
    const tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
    // 1. filler struck through and squeezed out
    tl.to($$('s', sec), { '--k': 1, color: '#4d4b44', duration: 1.6, stagger: .08, ease: 'power1.inOut' }, 0)
      .to($$('s', sec), { fontSize: 0, opacity: 0, duration: 1.2, stagger: .05, ease: 'power2.in' }, 1.8);
    // 2. small talk: redaction bar, then the line collapses
    tl.to($$('.bar', sec), { scaleX: 1, duration: .8, stagger: .25, ease: 'power2.inOut' }, 2.2)
      .to(noise, { height: 0, paddingTop: 0, paddingBottom: 0, borderBottomWidth: 0, opacity: 0, duration: 1, stagger: .15, ease: 'power2.inOut' }, 3.3);
    // 3. guest lines held
    tl.to(guest, { '--h': 1, duration: .6, stagger: .2 }, 3.8)
      .fromTo($$('.hold', sec), { opacity: 0, x: 16 }, { opacity: 1, x: 0, duration: .6, stagger: .2, ease: 'expo.out' }, 3.9)
      .to(guest.map((g) => g.children[2]), { color: '#7d7a70', duration: .6 }, 4);
    // 4. the useful parts light up
    tl.to($$('mark', sec), { '--m': 1, color: '#0a0a08', duration: .6, stagger: .3, ease: 'power2.out' }, 5);
    // 5. the block assembles, counter drops
    tl.fromTo(fields.map((f) => f.children[1]), { clipPath: 'inset(0% 100% 0% 0%)', opacity: .2 }, { clipPath: 'inset(0% 0% 0% 0%)', opacity: 1, duration: .8, stagger: .55, ease: 'power2.out' }, 6.2)
      .to(o, { v: BLOCK, n: 186, duration: 3.6, ease: 'power1.inOut' }, 6)
      .to(rail, { scaleX: BLOCK / RAW, duration: 3.6, ease: 'power1.inOut' }, 6)
      .to(keep, { opacity: .5, duration: .8 }, 8.6)
      .fromTo(stamp, { opacity: 0, scale: 2.4, rotate: -24 }, { opacity: .92, scale: 1, rotate: -9, duration: .4, ease: 'expo.in' }, 9.6)
      .to({}, { duration: .5 });
    tl.eventCallback('onUpdate', () => {
      tok.textContent = fmt(o.v);
      save.textContent = `SAVED ${Math.round((1 - o.v / RAW) * 100)}%`;
      more.textContent = `COMPRESSING ${String(Math.round(o.n)).padStart(3, '0')}/186`;
      const p = tl.progress();
      const ph = PHASES.filter(([t]) => p >= t).pop()[1];
      if (ph !== lastPhase) { lastPhase = ph; phase.textContent = ph; }
      if (p > .96 && !stamped) { stamped = true; sound.stamp(); } else if (p < .9) stamped = false;
    });
    return tl;
  }

  const mm = gsap.matchMedia();
  mm.add({ pin: MQ.pin, flow: MQ.flow, rm: MQ.rm }, (c) => {
    const { pin, rm } = c.conditions;
    const tl = build();
    if (rm) { tl.progress(1); return; }
    if (pin) ST.create({ trigger: sec, start: 'top top', end: () => `+=${Math.round(innerHeight * 2.6)}`, pin: true, scrub: 1, animation: tl, invalidateOnRefresh: true, anticipatePin: 1 });
    else ST.create({ trigger: $('.cp-stage', sec), start: 'top 75%', end: 'bottom 80%', scrub: 1, animation: tl });
    return () => tl.kill();
  });
}
