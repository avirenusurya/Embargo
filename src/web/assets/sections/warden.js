// 03 WARDEN: the agent's introduction. A big eye that follows the cursor and reacts (blink on click, think while
// typing its log, alert on a leak attempt, held/think/watch per dossier entry), an ID card and a live log.
import { warden } from '/static/assets/brand.js';
import { $, $$, reduced, isTouch, onView, once, barcode, ist, wait, type } from './_util.js';

export async function init({ gsap, motion, AGENT, sound, scramble }) {
  const sec = $('#warden'); if (!sec) return;
  const cap = AGENT.name[0] + AGENT.name.slice(1).toLowerCase();
  const eyeC = $('#wdEye'), miniC = $('#wdMini'), stage = $('#wdStage');
  eyeC.style.height = 'auto'; miniC.style.height = 'auto';
  const eye = warden(eyeC, { state: 'watch' });
  const mini = warden(miniC, { state: 'watch', glow: false });
  new ResizeObserver(() => { eye.fit(); mini.fit(); }).observe(eyeC);

  // ---- state machine: leak (alert) > dossier hover > typing (think) > watch
  const stEl = $('#wdState'), sayEl = $('#wdSay');
  const DEFAULT_SAY = sayEl.textContent;
  let typing = false, hover = null, leak = false, inStage = false;
  const setState = () => {
    const s = leak ? 'alert' : hover ?? (typing && !inStage ? 'think' : 'watch');
    if (eye.state === s) return;
    eye.state = s; mini.state = s === 'think' ? 'watch' : s;
    stage.classList.remove('alert', 'held', 'think'); if (s !== 'watch') stage.classList.add(s);
    stEl.textContent = s.toUpperCase();
    if (gsap && !reduced()) gsap.fromTo(stEl, { opacity: .2 }, { opacity: 1, duration: .4, ease: 'steps(4)' });
  };
  const say = (t) => scramble(sayEl, t, { duration: .7 });

  // ---- crosshair + gaze readout
  const xh = $('.wd-xh.x', stage), yh = $('.wd-xh.y', stage), gz = $('#wdGaze');
  let raf = 0, px = 0, py = 0;
  const paint = () => {
    raf = 0;
    const r = stage.getBoundingClientRect(), x = px - r.left, y = py - r.top;
    xh.style.transform = `translateY(${y}px)`; yh.style.transform = `translateX(${x}px)`;
    const nx = (x / r.width - .5) * 2, ny = (y / r.height - .5) * 2;
    gz.textContent = `X ${nx >= 0 ? '+' : '−'}${Math.abs(nx).toFixed(2)} · Y ${ny >= 0 ? '+' : '−'}${Math.abs(ny).toFixed(2)}`;
  };
  if (!isTouch()) {
    stage.addEventListener('pointermove', (e) => { px = e.clientX; py = e.clientY; if (!raf) raf = requestAnimationFrame(paint); }, { passive: true });
    stage.addEventListener('pointerenter', () => { stage.classList.add('hot'); inStage = true; setState(); });
    stage.addEventListener('pointerleave', () => { stage.classList.remove('hot'); inStage = false; setState(); });
  }
  let blinks = 0;
  stage.addEventListener('click', () => {
    eye.blink(); mini.blink(); blinks++;
    say(blinks > 4 ? 'You can stop. I still saw that.' : blinks > 2 ? 'Blinking is not a security model.' : 'Blinked. Still watching.');
    clearTimeout(stage._t); stage._t = setTimeout(() => say(DEFAULT_SAY), 2600);
    if (gsap && !reduced()) gsap.fromTo(eyeC, { scaleY: .82 }, { scaleY: 1, duration: .5, ease: 'elastic.out(1,.4)' });
  });

  // ---- dossier: eye looks at the entry you hover and changes state
  for (const li of $$('#wdDos li')) {
    const enter = () => {
      hover = li.dataset.st === 'watch' ? null : li.dataset.st;
      const a = li.getBoundingClientRect(), b = eyeC.getBoundingClientRect();
      eye.look(((a.left + a.width / 2) - (b.left + b.width / 2)) / Math.max(200, innerWidth * .35) * 2.4, ((a.top + a.height / 2) - (b.top + b.height / 2)) / Math.max(160, innerHeight * .35) * 1.6);
      setState(); say(li.dataset.say); sound.tick();
    };
    const leave = () => { hover = null; eye.look(null); setState(); say(DEFAULT_SAY); };
    li.addEventListener('pointerenter', enter); li.addEventListener('pointerleave', leave);
    li.addEventListener('click', enter);
  }

  // ---- the leak attempt
  const lk = $('#wdLeak'), chip = $('#wdLeakChip'), verdict = $('#wdLeakV');
  const LEAK_IDLE = verdict.textContent;
  const hit = () => {
    if (leak) return; leak = true; setState();
    lk.classList.add('hit'); chip.className = 'chip blocked'; scramble(chip, 'BLOCKED', { duration: .3 });
    scramble(verdict, 'Blocked. The payload matches 1 restricted item (an embargoed price). Audience: public. The tool gets the reason, not the content.', { duration: .9 });
    say('That would leak an embargoed price. Held.'); sound.deny();
    if (gsap && !reduced()) gsap.fromTo(lk, { x: -8 }, { x: 0, duration: .6, ease: 'elastic.out(1.2,.3)' });
  };
  const unhit = () => {
    if (!leak) return; leak = false; setState();
    lk.classList.remove('hit'); chip.className = 'chip'; scramble(chip, 'PENDING', { duration: .3 });
    scramble(verdict, LEAK_IDLE, { duration: .5 }); say(DEFAULT_SAY);
  };
  lk.addEventListener('pointerenter', () => { if (!isTouch()) hit(); });
  lk.addEventListener('pointerleave', () => { if (!isTouch()) unhit(); });
  lk.addEventListener('focus', hit); lk.addEventListener('blur', unhit);
  lk.addEventListener('click', () => (leak && isTouch() ? unhit() : hit()));

  // ---- ID card barcode
  barcode($('.wd-code', sec), 17, 62);

  // ---- the log: typed while in view, the eye thinks while it types
  const log = $('#wdLog'), count = $('#wdTermN');
  const LINES = [
    ['inbox', 'bone', 'Wispr Notetaker · "Tuesday standup" · 24 min'],
    ['split', '', '186 statements · 4 speakers'],
    ['held', 'amber', '2 lines from a guest (Tom, Acme) · review link queued'],
    ['compress', '', '4,812 → 1,146 tok · 76% saved'],
    ['fact', '', 'launch.price = ₹599/month ↳ 04:02'],
    ['conflict', 'amber', '"Pricing decision" still says ₹499 → inbox'],
    ['sealed', '', 'contractor asked "API rate limit?" · answered · 0 quotes'],
    ['action', 'red', 'post_message #launch (public) · 1 restricted item · BLOCKED'],
    ['inbox', 'bone', '3 suggestions for Priya (context_admin)'],
    ['link', '', 'review link sent to Tom via WhatsApp'],
  ];
  let visible = false, running = false, n = 0;
  const token = { dead: false };
  async function run() {
    if (running) return; running = true;
    while (visible) {
      for (let i = 0; i < LINES.length && visible; i++) {
        const [tag, col, text] = LINES[i];
        const row = document.createElement('div'); row.className = 'tlg cur';
        row.innerHTML = `<time>${ist(i * 2)}</time><b class="${col}">${tag}</b><span></span>`;
        log.appendChild(row);
        while (log.scrollHeight > log.clientHeight + 2 && log.children.length > 1) log.firstChild.remove();
        typing = true; setState();
        await type(row.lastChild, text, { speed: 16, sound, token });
        row.classList.remove('cur'); typing = false; setState();
        count.textContent = String(++n).padStart(3, '0');
        if (col === 'red') { eye.state = 'alert'; await wait(500); setState(); }
        await wait(900 + Math.random() * 700);
      }
      await wait(2600);
      if (visible && gsap && !reduced()) await new Promise((r) => gsap.to(log.children, { opacity: 0, x: -10, stagger: .02, duration: .3, onComplete: r }));
      log.innerHTML = '';
    }
    running = false;
  }
  if (reduced()) { for (const [tag, col, text] of LINES.slice(0, 7)) log.insertAdjacentHTML('beforeend', `<div class="tlg"><time>${ist()}</time><b class="${col}">${tag}</b><span>${text}</span></div>`); }
  else onView($('#wdTerm'), (v) => { visible = v; token.dead = !v; if (v) { token.dead = false; run(); } }, { threshold: .25 });

  // ---- motion on entry
  const ST = motion.ScrollTrigger;
  if (!gsap || !ST || reduced()) return;
  gsap.fromTo(eyeC, { scale: .45, opacity: .2 }, { scale: 1, opacity: 1, ease: 'none', scrollTrigger: { trigger: stage, start: 'top bottom', end: 'center 60%', scrub: 1 } });
  gsap.to('.wd-rings', { rotate: 90, ease: 'none', scrollTrigger: { trigger: stage, start: 'top bottom', end: 'bottom top', scrub: 1 } });
  gsap.fromTo('#wdId', { y: 60 }, { y: -30, ease: 'none', scrollTrigger: { trigger: sec, start: 'top bottom', end: 'bottom top', scrub: 1 } });
  const card = $('#wdId'), stamp = $('.wd-stamp', card);
  gsap.set(card, { opacity: 0 }); gsap.set(stamp, { opacity: 0 });
  once(card, () => {
    gsap.timeline()
      .fromTo(card, { opacity: 0, rotate: -16, xPercent: -20 }, { opacity: 1, rotate: -2.5, xPercent: 0, duration: 1.1, ease: 'expo.out' })
      .fromTo(stamp, { opacity: 0, scale: 2.6, rotate: -30 }, { opacity: .9, scale: 1, rotate: -12, duration: .32, ease: 'expo.in', onComplete: () => { sound.stamp(); gsap.fromTo(card, { x: -4 }, { x: 0, duration: .4, ease: 'elastic.out(1,.3)' }); } }, '-=.35');
  });
  card.addEventListener('pointerenter', () => gsap.to(card, { rotate: 0, scale: 1.03, duration: .6, ease: 'expo.out', overwrite: 'auto' }));
  card.addEventListener('pointerleave', () => gsap.to(card, { rotate: -2.5, scale: 1, duration: .8, ease: 'expo.out', overwrite: 'auto' }));
  const side = $('.wd-side', sec);
  gsap.from(side.children, { opacity: 0, x: 40, stagger: .12, duration: 1, ease: 'expo.out', scrollTrigger: { trigger: side, start: 'top 80%', once: true } });
}
