// 06 CONSENT: the speaker review link, played out on a phone. A message arrives, the guest sees only their own held
// lines, a finger taps Team only / Block, submits, a stamp slams and the record ids appear. Fully tappable too.
import { $, $$, reduced, once, wait, uuid7 } from './_util.js';

const LABEL = { allowed: 'ALLOWED', team_only: 'TEAM ONLY', blocked: 'BLOCKED FROM AI' };
const EVENT = { allowed: 'consent', team_only: 'consent', blocked: 'consent_withdraw' };

export async function init({ gsap, sound, scramble }) {
  const sec = $('#consent'); if (!sec) return;
  const phone = $('#phone'), scr = $('#phScr'), cards = $$('.ph-card', sec), sub = $('#phSub'), done = $('#phDone'), stamp = $('#phStamp');
  const finger = $('#phFinger'), msg = $('#csMsg'), steps = $$('#csSteps li');
  const choice = [null, null];
  const anim = !!gsap && !reduced();
  let run = 0;

  const step = (n) => steps.forEach((s, i) => s.classList.toggle('on', i <= n));
  function sync() {
    cards.forEach((c, i) => {
      $$('.pc-ch button', c).forEach((b) => b.classList.toggle('on', b.dataset.v === choice[i]));
      $('.pc-s', c).innerHTML = choice[i] ? `<span class="chip plain">${LABEL[choice[i]]}</span>` : '';
    });
    const left = choice.filter((v) => !v).length;
    sub.disabled = left > 0; sub.classList.toggle('ready', !left);
    sub.textContent = left ? `${left} still to decide` : 'Submit decisions';
  }
  function choose(i, v) { choice[i] = v; sync(); sound.click(); if (choice.every(Boolean)) step(2); }
  function submit() {
    if (choice.some((v) => !v)) return;
    const recs = $$('.ph-rec', done);
    recs.forEach((r, i) => {
      const v = choice[i];
      r.firstElementChild.innerHTML = `LINE ${i + 1} · <b class="${v === 'blocked' ? 'red' : v === 'team_only' ? 'amber' : ''}">${LABEL[v]}</b>`;
      r.lastElementChild.textContent = `${EVENT[v]} · REC ${uuid7(i + 7).slice(0, 18)}…`;
    });
    done.classList.add('on'); step(3);
    if (!anim) return;
    gsap.fromTo(done, { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: .5, ease: 'expo.inOut' });
    gsap.fromTo(stamp, { scale: 3.2, opacity: 0, rotate: -28 }, { scale: 1, opacity: .92, rotate: -9, duration: .34, delay: .45, ease: 'expo.in', onComplete: () => { sound.stamp(); gsap.fromTo(phone, { x: -7, rotate: -.6 }, { x: 0, rotate: 0, duration: .7, ease: 'elastic.out(1.1,.3)' }); } });
    gsap.fromTo($$('.ph-rec, .ph-done p', done), { opacity: 0, y: 10 }, { opacity: 1, y: 0, stagger: .12, delay: .9, duration: .6, ease: 'expo.out' });
    $$('.ph-rec .tnum', done).forEach((el, i) => setTimeout(() => scramble(el, el.textContent, { duration: .8 }), 950 + i * 140));
  }
  function reset() {
    choice[0] = choice[1] = null; sync(); done.classList.remove('on'); step(-1);
    if (anim) gsap.set(finger, { opacity: 0 });
  }

  cards.forEach((c, i) => $$('.pc-ch button', c).forEach((b) => b.addEventListener('click', (e) => { if (e.isTrusted) { run++; if (anim) gsap.to(finger, { opacity: 0, duration: .2 }); } choose(i, b.dataset.v); })));
  sub.addEventListener('click', (e) => { if (e.isTrusted) run++; submit(); });
  done.addEventListener('click', () => { run++; reset(); step(2); });
  done.dataset.cursor = 'START OVER';

  // the scripted review
  async function tap(el, my) {
    const pr = phone.getBoundingClientRect(), r = el.getBoundingClientRect();
    await new Promise((res) => gsap.to(finger, { x: r.left - pr.left + r.width / 2, y: r.top - pr.top + r.height / 2, opacity: 1, duration: .75, ease: 'expo.inOut', onComplete: res }));
    if (my !== run) return false;
    el.classList.add('tap'); gsap.fromTo(finger, { scale: .7 }, { scale: 1, duration: .3, ease: 'back.out(3)' });
    await wait(160); el.classList.remove('tap');
    return my === run;
  }
  async function demo() {
    const my = ++run; reset();
    if (!anim) { choice[0] = 'team_only'; choice[1] = 'blocked'; sync(); submit(); return; }
    step(0);
    gsap.set(finger, { x: phone.clientWidth / 2, y: phone.clientHeight + 40 });
    await wait(500); if (my !== run) return;
    gsap.fromTo(msg, { opacity: 0, x: -60, rotate: -4 }, { opacity: 1, x: 0, rotate: -2, duration: .9, ease: 'expo.out' }); sound.tick(); step(1);
    await wait(900); if (my !== run) return;
    gsap.fromTo([...scr.children].filter((x) => x !== done), { opacity: 0, y: 24 }, { opacity: 1, y: 0, stagger: .08, duration: .7, ease: 'expo.out' });
    await wait(1100); if (my !== run) return;
    if (!(await tap($('[data-v="team_only"]', cards[0]), my))) return; choose(0, 'team_only');
    await wait(500); if (my !== run) return;
    if (!(await tap($('[data-v="blocked"]', cards[1]), my))) return; choose(1, 'blocked');
    await wait(600); if (my !== run) return;
    if (!(await tap(sub, my))) return;
    gsap.to(finger, { opacity: 0, duration: .4, delay: .2 });
    submit();
  }
  $('#csReplay').addEventListener('click', demo);
  sync();
  if (anim) gsap.set(msg, { opacity: 0 });
  once($('.cs-r', sec), demo, { threshold: .35 });
}
