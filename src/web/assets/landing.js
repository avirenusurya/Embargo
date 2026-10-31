// Landing page behaviour. Section scripts register themselves in SECTIONS (below) and run after boot.
import { boot, wordmark, dither, scramble, soundButton, sound, refresh, AGENT, motion } from '/static/assets/brand.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Tool glyphs: small pixel monograms instead of third-party logos.
const GLYPH = { ChatGPT: 'G', Claude: 'C', Notion: 'N', Figma: 'F', 'Claude Code': 'C', Cursor: 'K', 'Figma Make': 'F' };
for (const el of $$('.tg')) {
  const name = el.parentElement.textContent.trim().split(/\s{2,}|\n/)[0].trim();
  const s = document.createElement('span');
  s.style.cssText = 'display:inline-grid;place-items:center;width:15px;height:15px;background:var(--bone);color:var(--ink);font:700 9px/1 var(--px)';
  s.textContent = GLYPH[name] ?? name[0] ?? '?';
  el.replaceWith(s);
}

const { gsap } = await boot({ preloader: ['mounting the black archive', 'loading clearance rules', 'verifying record signatures', 'sealing sealed-use blocks', `waking ${AGENT.name.toLowerCase()}`] });

// ---------------------------------------------------------------- nav: clock, sound, hide on scroll down
$('#snd').appendChild(soundButton());
const clock = $('#clock');
const tickClock = () => { const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000); clock.textContent = `IST ${d.toTimeString().slice(0, 8)}`; };
tickClock(); setInterval(tickClock, 1000);
let lastY = 0;
const onScroll = (y) => { $('#nav').classList.toggle('hide', y > 300 && y > lastY); lastY = y; };
if (motion.lenis) motion.lenis.on('scroll', (l) => onScroll(l.scroll)); else addEventListener('scroll', () => onScroll(scrollY), { passive: true });

// ---------------------------------------------------------------- hero
const wm = wordmark($('#wordmark'));
$('#wordmark').addEventListener('click', () => { wm.burst(); sound.stamp(); });
for (const c of $$('canvas[data-dither]')) dither(c, c.dataset.dither, { seed: Number(c.dataset.seed) || 1, scale: 2 });

// Clearance demo: each tool sees a different version of the same desk.
const TOOLS = [
  { name: 'ChatGPT', state: 'allowed', scope: 'Research', docs: { d1: 'clear', d2: 'redact', d3: 'clear', d4: 'blocked' }, doc: 'DOC-7781', block: 'RESEARCH', mode: 'VIEWABLE', perm: 'ALLOWED', review: '90 DAYS', say: 'ChatGPT reads research and the appendix. Pricing stays redacted until 15 Nov.' },
  { name: 'Claude', state: 'restricted', scope: 'Strategy', docs: { d1: 'redact', d2: 'clear', d3: 'redact', d4: 'sealed' }, doc: 'DOC-7783', block: 'ARCHITECTURE', mode: 'SEALED USE', perm: 'RESTRICTED', review: 'PENDING', say: 'Claude may answer from Fig.2. It never receives the text.' },
  { name: 'Notion', state: 'allowed', scope: 'Docs', docs: { d1: 'redact', d2: 'redact', d3: 'clear', d4: 'blocked' }, doc: 'DOC-7790', block: 'TECH APPENDIX', mode: 'VIEWABLE', perm: 'ALLOWED', review: '30 DAYS', say: 'Notion gets the appendix only. Everything else is out of scope.' },
  { name: 'Figma', state: 'blocked', scope: 'Design', docs: { d1: 'blocked', d2: 'blocked', d3: 'blocked', d4: 'blocked' }, doc: 'DOC-7783', block: 'ALL BLOCKS', mode: 'NO ACCESS', perm: 'BLOCKED', review: 'REVOKED', say: 'Figma\u2019s token was revoked. The desk is closed to it.' },
];
const desk = $('#desk'), wires = $('#wires');
const toolEls = $$('.tool', desk);
let current = 1, auto = true;
function drawWires(active) {
  if (getComputedStyle(wires).display === 'none') return;
  const dr = desk.getBoundingClientRect();
  let out = '';
  toolEls.forEach((te, i) => {
    const t = TOOLS[i], tr = te.getBoundingClientRect();
    const tx = tr.left - dr.left + tr.width / 2, ty = tr.top - dr.top + tr.height / 2;
    for (const [id, how] of Object.entries(t.docs)) {
      if (how === 'blocked' && i !== active) continue;
      const d = $('#' + id).getBoundingClientRect();
      const dx = d.left - dr.left + d.width / 2, dy = d.top - dr.top + Math.min(40, d.height / 3);
      const midY = ty + (dy - ty) * .5;
      const on = i === active ? ` on ${how === 'clear' ? 'allowed' : how === 'blocked' ? 'blocked' : 'restricted'}` : '';
      if (i !== active && how !== 'clear') continue;
      out += `<path class="${on}" d="M${tx},${ty} L${tx},${midY} L${dx},${midY} L${dx},${dy}"/>`;
      out += `<rect class="${on}" x="${dx - 3}" y="${dy - 3}" width="6" height="6"/>`;
    }
  });
  wires.innerHTML = out;
  if (gsap && !reduced) for (const p of $$('path.on', wires)) { const L = p.getTotalLength(); gsap.fromTo(p, { strokeDasharray: L, strokeDashoffset: L }, { strokeDashoffset: 0, duration: .8, ease: 'expo.out' }); }
}
function select(i, user = false) {
  if (user) auto = false;
  current = i;
  const t = TOOLS[i];
  toolEls.forEach((te, k) => { te.classList.toggle('on', k === i); te.classList.remove('allowed', 'restricted', 'blocked'); if (k === i) te.classList.add(t.state); });
  for (const [id, how] of Object.entries(t.docs)) {
    const d = $('#' + id);
    d.classList.toggle('clear', how === 'clear');
    d.classList.toggle('blocked', how === 'blocked');
    d.classList.toggle('lift', how === 'clear' || how === 'sealed');
  }
  scramble($('#acpDoc'), t.doc); scramble($('#acpTool'), t.name.toUpperCase()); scramble($('#acpBlock'), t.block); scramble($('#acpMode'), t.mode); scramble($('#acpRev'), t.review);
  const perm = $('#acpPerm'); perm.className = `v-${t.state}`; scramble(perm, t.perm);
  scramble($('#acpSay'), `${AGENT.name[0]}${AGENT.name.slice(1).toLowerCase()}: ${t.say}`, { duration: 1.1 });
  const w = $('#acp canvas')?._warden; if (w) w.state = t.state === 'blocked' ? 'alert' : t.state === 'restricted' ? 'held' : 'watch';
  drawWires(i);
  if (user) t.state === 'blocked' ? sound.deny() : sound.ok();
}
toolEls.forEach((te, i) => { te.dataset.cursor = 'SWITCH CLEARANCE'; te.addEventListener('click', () => select(i, true)); te.addEventListener('pointerenter', () => { if (!auto) return; }); });
desk.addEventListener('pointerenter', () => (auto = false));
setTimeout(() => select(1), 400);
setInterval(() => { if (auto && !document.hidden) select((current + 1) % TOOLS.length); }, 4200);
new ResizeObserver(() => drawWires(current)).observe(desk);
// docs lean towards the cursor
if (!matchMedia('(hover: none)').matches && gsap && !reduced) {
  const docs = $$('.doc', desk);
  desk.addEventListener('pointermove', (e) => {
    const r = desk.getBoundingClientRect(), nx = (e.clientX - r.left) / r.width - .5, ny = (e.clientY - r.top) / r.height - .5;
    docs.forEach((d, i) => gsap.to(d, { x: nx * (10 + i * 5), y: ny * (8 + i * 4), duration: 1.2, ease: 'expo.out', overwrite: 'auto' }));
  });
}

// ---------------------------------------------------------------- 02 strip
for (const b of $$('[data-add]')) {
  b.dataset.cursor = 'APPROVE';
  b.addEventListener('click', () => {
    if (b.disabled) return;
    b.disabled = true; sound.stamp();
    scramble(b, 'FILED', { duration: .4 });
    b.closest('.sug').classList.add('added');
  });
}
const FEED = [
  ['Claude Code', 'read', 'Pricing decision v3', '412 tok', 'acid'],
  ['Cursor', 'get_context', '6 blocks · 2 withheld', '1,184 tok', 'acid'],
  [AGENT.name, 'filed', '3 facts from Tuesday standup', 'inbox', 'b2'],
  ['ChatGPT', 'ask_sealed', 'Security internals', 'answered', 'amber'],
  ['Figma Make', 'read', 'Brand rules', 'refused', 'red'],
  ['Claude Code', 'perform_action', 'post launch price', 'held', 'amber'],
  [AGENT.name, 'flagged', 'launch date contradiction', 'inbox', 'b2'],
  ['Priya', 'approved', 'standup statements 4/4', 'consent', 'acid'],
  ['Relayer', 'anchored', '41 records · Base', 'signed', 'acid'],
  ['Cursor', 'read', 'Tech stack v7', '388 tok', 'acid'],
  ['Rohan', 'revoked', 'old roadmap · keys shredded', 'shredded', 'red'],
];
const feed = $('#feed');
let fi = 0;
function feedLine() {
  const [who, what, obj, out, col] = FEED[fi++ % FEED.length];
  const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
  const el = document.createElement('div'); el.className = 'fl';
  el.innerHTML = `<time class="tnum">${d.toTimeString().slice(0, 8)}</time><span><b style="color:var(--bone);font-weight:500">${who}</b> ${what} · ${obj}</span><span class="o ${col}">${out.toUpperCase()}</span>`;
  feed.appendChild(el);
  while (feed.children.length > 9) feed.firstChild.remove();
  if (gsap && !reduced) gsap.from(el, { opacity: 0, x: -12, duration: .5, ease: 'expo.out' });
}
for (let i = 0; i < 5; i++) feedLine();
setInterval(() => { if (!document.hidden) feedLine(); }, 1900);

// marquee
const MQ = ['Clearance per block', 'Sealed use', 'Consent per speaker', 'Crypto-shredding', 'Signed records on Base', 'One MCP server', `Kept by ${AGENT.name}`];
const mqHTML = MQ.map((t, i) => `<span>${i % 2 ? `<em>${t}</em>` : t}<i></i></span>`).join('');
$('#mq1').innerHTML = mqHTML; $('#mq2').innerHTML = mqHTML;

// "Watch overview" is a plain link to the launch post on X.

// hero intro choreography
if (gsap && !reduced) {
  gsap.from('.doc', { y: 120, rotate: (i) => (i % 2 ? 14 : -14), opacity: 0, duration: 1.4, ease: 'expo.out', stagger: .09, delay: .15 });
  gsap.from('.tool, .acp', { opacity: 0, y: 20, duration: 1, ease: 'expo.out', stagger: .07, delay: .6 });
}

// ---------------------------------------------------------------- sections 03+ (each module exports init(ctx))
export const ctx = { gsap, motion, AGENT, sound, scramble, refresh, dither };
window.__emb = Object.assign(window.__emb || {}, ctx);
const mods = $$('script[type="emb/section"]').map((s) => s.dataset.src);
for (const src of mods) { try { const m = await import(src); await m.init?.(ctx); } catch (e) { console.error('section', src, e); } }
document.dispatchEvent(new Event('emb:ready'));
refresh();
window.ScrollTrigger?.refresh();
