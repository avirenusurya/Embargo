// FOOTER: second wordmark (cells scatter from the cursor, click to burst), the motto, the eye that goes to sleep
// once the footer is fully in view, and a Lenis back-to-top.
import { wordmark, warden } from '/static/assets/brand.js';
import { $, reduced } from './_util.js';

export async function init({ gsap, motion, AGENT, sound, scramble }) {
  const ft = $('#footer'); if (!ft) return;
  const mark = $('#ftMark');
  const wm = wordmark(mark, { bars: [[2, 1, .06, .46], [5, 2, .4, .96], [7, 1, .12, .7]], seed: 9 });
  mark.addEventListener('click', () => { wm.burst(); sound.stamp(); });

  const eyeC = $('#ftEye'); eyeC.style.height = 'auto';
  const eye = warden(eyeC, { state: 'watch' });
  const say = $('#ftSay'), box = eyeC.parentElement;
  const navEye = () => $('.nav-logo canvas')?._warden;
  const sleep = (on) => {
    eye.state = on ? 'sleep' : 'watch';
    const n = navEye(); if (n) n.state = on ? 'sleep' : 'watch';
    box.classList.toggle('zz', on);
    scramble(say, on ? `${AGENT.name} IS ASLEEP. THE ARCHIVE IS SEALED.` : `${AGENT.name} IS WATCHING`, { duration: .6 });
  };
  const ST = motion.ScrollTrigger;
  if (ST) ST.create({ trigger: ft, start: 'bottom-=8 bottom', end: 'max', onEnter: () => sleep(true), onLeaveBack: () => sleep(false), refreshPriority: -20 });
  else new IntersectionObserver(([e]) => sleep(e.intersectionRatio > .98), { threshold: [0, .98, 1] }).observe(ft);

  $('#toTop').addEventListener('click', () => {
    sound.whoosh();
    if (motion.lenis) motion.lenis.scrollTo(0, { duration: 2.4, easing: (x) => (x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2) });
    else scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
  });

  if (gsap && ST && !reduced()) {
    gsap.fromTo(mark, { yPercent: 30, opacity: .3 }, { yPercent: 0, opacity: 1, ease: 'none', scrollTrigger: { trigger: ft, start: 'top bottom', end: 'bottom bottom', scrub: 1, refreshPriority: -20 } });
  }
  window.__emb = Object.assign(window.__emb || {}, { footerEye: eye });
}
