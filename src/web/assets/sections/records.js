// 07 RECORDS: a thermal receipt prints line by line (scroll-scrubbed, pinned on desktop) while the record's Merkle
// path lights up from its leaf to the anchored root; the standalone verifier signs off and VERIFIED is stamped.
import { $, $$, MQ, hex, short, barcode } from './_util.js';

// tree geometry (viewBox 400 × 250). Leaf 5 is ours.
const LEAF = 5;
function tree() {
  const lv = [[], [], [], []], ys = [214, 154, 94, 34];
  for (let i = 0; i < 8; i++) lv[0].push({ x: 25 + i * 50, y: ys[0], l: `L${i}` });
  for (let i = 0; i < 4; i++) lv[1].push({ x: 50 + i * 100, y: ys[1], l: `H${2 * i}${2 * i + 1}` });
  for (let i = 0; i < 2; i++) lv[2].push({ x: 100 + i * 200, y: ys[2], l: i ? 'H4-7' : 'H0-3' });
  lv[3].push({ x: 200, y: ys[3], l: 'ROOT' });
  return lv;
}

export async function init({ gsap, motion, sound }) {
  const sec = $('#records'); if (!sec) return;
  const ST = motion.ScrollTrigger;
  const rcpt = $('#rcpt'), lines = $$('.rl', rcpt), stamp = $('#rcStamp'), led = $('#prLed'), state = $('#rcState');
  // deterministic hashes
  const H = { subject: hex(11), ws: hex(12), uid: hex(13), root: hex(14), tx: hex(15) };
  $$('[data-hex]', rcpt).forEach((el) => (el.textContent = short(H[el.dataset.hex])));
  barcode($('.rl.bc', rcpt), 23, 70);
  rcpt.insertAdjacentHTML('beforeend', '<i class="head" aria-hidden="true"></i>');
  const head = $('.head', rcpt);

  // Merkle tree
  const svg = $('#mk'), lv = tree();
  const path = [LEAF, LEAF >> 1, LEAF >> 2, 0], sib = [LEAF ^ 1, (LEAF >> 1) ^ 1, (LEAF >> 2) ^ 1];
  let s = '';
  const edges = [];
  for (let L = 0; L < 3; L++) lv[L].forEach((n, i) => { const p = lv[L + 1][i >> 1]; const on = path[L] === i; edges.push({ L, on }); s += `<line x1="${n.x}" y1="${n.y - 9}" x2="${p.x}" y2="${p.y + 9}"${on ? ' class="p"' : ''}/>`; });
  lv.forEach((row, L) => row.forEach((n, i) => {
    const w = L === 3 ? 60 : L === 0 ? 34 : 44;
    s += `<g data-l="${L}" data-i="${i}" class="${L === 3 ? 'root' : ''}"><rect x="${n.x - w / 2}" y="${n.y - 9}" width="${w}" height="18"/><text x="${n.x}" y="${n.y + .5}">${n.l}</text></g>`;
  }));
  s += `<text class="lbl2" x="6" y="244">LEAF = keccak256(off-chain attestation)</text><text class="lbl2" x="244" y="20">${short(H.root, 6, 4)}</text>`;
  svg.innerHTML = s;
  const node = (L, i) => $(`g[data-l="${L}"][data-i="${i}"]`, svg);
  const pathLines = $$('line.p', svg);

  const fills = $$('.vl', sec);
  function build() {
    const tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
    const marks = [];
    const bottom = (el) => el.offsetTop + el.offsetHeight;
    gsap.set(rcpt, { clipPath: () => `inset(0px 0px ${rcpt.offsetHeight}px 0px)` });
    gsap.set(lines, { opacity: 0 });
    lines.forEach((ln, i) => {
      const t = i * .5;
      tl.to(rcpt, { clipPath: () => `inset(0px 0px ${rcpt.offsetHeight - bottom(ln) - 4}px 0px)`, duration: .45 }, t)
        .to(head, { y: () => bottom(ln) + 3, opacity: 1, duration: .45 }, t)
        .fromTo(ln, { opacity: 0, x: -4 }, { opacity: 1, x: 0, duration: .3 }, t + .12);
      marks.push(t);
    });
    const end = lines.length * .5;
    tl.to(rcpt, { clipPath: 'inset(0px 0px -14px 0px)', duration: .4 }, end).to(head, { opacity: 0, duration: .2 }, end);
    // Merkle: leaf lights with OFFCHAIN UID (line 10), climbs to ROOT with MERKLE ROOT (line 12)
    const tLeaf = marks[10], tRoot = marks[12];
    const steps = [
      { t: tLeaf, on: [[0, LEAF]], sib: [[0, sib[0]]] },
      { t: tLeaf + .35, on: [[1, path[1]]], sib: [[1, sib[1]]] },
      { t: tLeaf + .7, on: [[2, path[2]]], sib: [[2, sib[2]]] },
      { t: tRoot, on: [[3, 0]], sib: [] },
    ];
    pathLines.forEach((l) => { const len = l.getTotalLength(); gsap.set(l, { strokeDasharray: len, strokeDashoffset: len }); });
    // path lines go leaf → root in pairs per level (one line per level is on the path)
    pathLines.forEach((l, k) => tl.to(l, { strokeDashoffset: 0, duration: .35 }, tLeaf + k * .35));
    tl.fromTo(stamp, { opacity: 0, scale: 2.6, rotate: -30 }, { opacity: .92, scale: 1, rotate: -12, duration: .35, ease: 'expo.in' }, end + .9);
    tl.fromTo(fills, { opacity: 0, x: -8 }, { opacity: 1, x: 0, stagger: .3, duration: .3 }, end - 1.6);
    tl.to({}, { duration: .4 });
    let stamped = false, lastState = '';
    tl.eventCallback('onUpdate', () => {
      const t = tl.time(), p = tl.progress();
      for (const st of steps) { const on = t >= st.t; st.on.forEach(([L, i]) => node(L, i).classList.toggle('on', on)); st.sib.forEach(([L, i]) => node(L, i).classList.toggle('sib', on)); }
      led.className = `pr-led ${p >= .97 ? 'ok' : p > 0 ? 'on' : ''}`;
      const ns = p >= .97 ? 'VERIFIED' : t >= tRoot ? 'ANCHORED' : t >= tLeaf ? 'BATCHING' : p > 0 ? 'PRINTING' : 'IDLE';
      if (ns !== lastState) { lastState = ns; state.textContent = ns; }
      if (t >= end + 1.2 && !stamped) { stamped = true; sound.stamp(); } else if (t < end) stamped = false;
      if (p > 0 && p < .97 && Math.floor(t * 4) !== tl._tick) { tl._tick = Math.floor(t * 4); sound.type(); }
    });
    return tl;
  }

  if (!gsap || !ST) return;
  const mm = gsap.matchMedia();
  mm.add({ pin: MQ.pinWide, flow: MQ.flow, rm: MQ.rm }, (c) => {
    const { pin, rm } = c.conditions;
    const tl = build();
    if (rm) { tl.progress(1); return; }
    if (pin) ST.create({ trigger: sec, start: 'top top', end: () => `+=${Math.round(innerHeight * 2)}`, pin: true, scrub: 1, animation: tl, invalidateOnRefresh: true, anticipatePin: 1 });
    else ST.create({ trigger: $('.rc-c', sec), start: 'top 70%', endTrigger: $('.rc-r', sec), end: 'bottom 95%', scrub: 1, animation: tl, invalidateOnRefresh: true });
    return () => { tl.kill(); gsap.set([rcpt, head, lines, stamp, fills, pathLines], { clearProps: 'transform,opacity,clipPath,strokeDasharray,strokeDashoffset' }); };
  });
}
