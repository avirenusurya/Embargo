// EMBARGO · THE BLACK ARCHIVE — identity + motion runtime (ES module, no build step).
// Shared by the website, the app and the external pages. GSAP + Lenis are served from /vendor (node_modules).
//   import { boot, AGENT } from '/static/assets/brand.js'; await boot({ ... });

/** Embargo's AI agent. Rename here and everything (site, app, promo copy) follows. */
export const AGENT = { name: 'WARDEN', id: 'W-01', tagline: 'The agent that keeps your archive.', verb: 'filed by Warden' };

const isTouch = () => matchMedia('(hover: none), (pointer: coarse)').matches;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------------------------------------------------------------- loaders
const loaded = new Map();
function script(src) {
  if (!loaded.has(src)) loaded.set(src, new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }));
  return loaded.get(src);
}
export async function loadGsap(plugins = ['ScrollTrigger']) {
  await script('/vendor/gsap/gsap.min.js');
  for (const p of plugins) await script(`/vendor/gsap/${p}.min.js`);
  const g = window.gsap;
  g.registerPlugin(...plugins.map((p) => window[p]).filter(Boolean));
  if (window.CustomEase) {
    window.CustomEase.create('arch', 'M0,0 C0.2,0.7 0.1,1 1,1');
    window.CustomEase.create('snap', 'M0,0 C0.85,0 0.15,1 1,1');
  }
  return g;
}
async function loadLenis() { const m = await import('/vendor/lenis/lenis.mjs'); return m.default ?? m.Lenis; }

// ---------------------------------------------------------------- seeded noise
export function rng(seed = 1) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function noise2(seed = 7) {
  const r = rng(seed), P = new Uint8Array(512), G = new Float32Array(256);
  for (let i = 0; i < 256; i++) { P[i] = i; G[i] = r(); }
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [P[i], P[j]] = [P[j], P[i]]; }
  for (let i = 0; i < 256; i++) P[i + 256] = P[i];
  const v = (x, y) => G[P[(P[x & 255] + y) & 255]];
  const f = (t) => t * t * (3 - 2 * t);
  const n = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = f(x - xi), yf = f(y - yi); return lerp(lerp(v(xi, yi), v(xi + 1, yi), xf), lerp(v(xi, yi + 1), v(xi + 1, yi + 1), xf), yf); };
  n.fbm = (x, y, o = 5) => { let s = 0, a = .5, fr = 1, t = 0; for (let i = 0; i < o; i++) { s += a * n(x * fr, y * fr); t += a; a *= .5; fr *= 2.03; } return s / t; };
  return n;
}

// ---------------------------------------------------------------- paper texture
let paperURL = null;
/** Distressed archive paper (fibres, toner speckle, stains, creases, burnt edges) as a JPEG data URL. */
export function paperTexture({ w = 640, h = 840, seed = 3 } = {}) {
  if (paperURL && seed === 3) return paperURL;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'), r = rng(seed), n = noise2(seed);
  x.fillStyle = '#ddd6c2'; x.fillRect(0, 0, w, h);
  const img = x.getImageData(0, 0, w, h), d = img.data;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = (j * w + i) * 4, f = n.fbm(i / 90, j / 90, 4), g = (r() - .5) * 18, edge = Math.min(i, j, w - i, h - j);
    const burn = edge < 26 ? (26 - edge) * 1.6 * n(i / 9, j / 9) : 0;
    const v = (f - .5) * 26 + g - burn;
    d[k] += v; d[k + 1] += v * .96; d[k + 2] += v * .86;
  }
  x.putImageData(img, 0, 0);
  for (let i = 0; i < 9; i++) { // stains
    const cx = r() * w, cy = r() * h, rad = 30 + r() * 140, g = x.createRadialGradient(cx, cy, rad * .2, cx, cy, rad);
    g.addColorStop(0, `rgba(120,92,40,${.03 + r() * .05})`); g.addColorStop(.8, `rgba(120,92,40,${.02 + r() * .04})`); g.addColorStop(1, 'rgba(120,92,40,0)');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, rad, 0, 7); x.fill();
  }
  x.lineCap = 'round';
  for (let i = 0; i < 900; i++) { // fibres
    const a = r() * 7, l = 3 + r() * 12, px = r() * w, py = r() * h;
    x.strokeStyle = `rgba(${r() > .5 ? '60,52,38' : '255,250,235'},${.05 + r() * .1})`; x.lineWidth = .6;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
  }
  for (let i = 0; i < 2600; i++) { x.fillStyle = `rgba(20,18,12,${r() * .35})`; x.fillRect(r() * w, r() * h, r() < .9 ? 1 : 2, r() < .9 ? 1 : 2); } // toner
  for (let i = 0; i < 3; i++) { // creases
    const vert = r() > .5, p = (vert ? w : h) * (.25 + r() * .5);
    for (const [off, col] of [[0, 'rgba(255,252,240,.35)'], [1.5, 'rgba(40,34,24,.16)']]) {
      x.strokeStyle = col; x.lineWidth = 1.2; x.beginPath();
      for (let t = 0; t <= 1; t += .02) { const q = (vert ? h : w) * t, wob = (n(t * 8, i) - .5) * 6; vert ? x.lineTo(p + off + wob, q) : x.lineTo(q, p + off + wob); }
      x.stroke();
    }
  }
  const url = c.toDataURL('image/jpeg', .82);
  if (seed === 3) paperURL = url;
  return url;
}

// ---------------------------------------------------------------- dithered imagery
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + .5) / 16);
/**
 * Procedural 1-bit images in the archive style. kind: galaxy | mountains | topo | wireframe | blueprint | moon | static
 * Returns the canvas. Colours default to paper ink on paper.
 */
export function dither(canvas, kind = 'galaxy', { seed = 11, scale = 2, fg = '#1a1914', bg = '#d9d2bd', t = 0 } = {}) {
  const W = canvas.width = canvas.clientWidth * (devicePixelRatio > 1 ? 1.5 : 1) || canvas.width || 320;
  const H = canvas.height = canvas.clientHeight * (devicePixelRatio > 1 ? 1.5 : 1) || canvas.height || 220;
  const w = Math.ceil(W / scale), h = Math.ceil(H / scale);
  const n = noise2(seed), r = rng(seed);
  const L = new Float32Array(w * h);
  const set = (i, j, v) => { if (i >= 0 && j >= 0 && i < w && j < h) L[j * w + i] = Math.max(L[j * w + i], v); };
  if (kind === 'galaxy') {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const dx = (i - w / 2) / w, dy = (j - h / 2) / h; L[j * w + i] = Math.exp(-(dx * dx + dy * dy) * 60) * .9 + n.fbm(i / 30, j / 30) * .08; }
    for (let k = 0; k < w * h * .35; k++) {
      const arm = k % 3, d = Math.pow(r(), 1.6), a = arm * 2.094 + d * 7 + t + (r() - .5) * .6;
      const px = w / 2 + Math.cos(a) * d * w * .48, py = h / 2 + Math.sin(a) * d * h * .42;
      set(Math.round(px), Math.round(py), .45 + (1 - d) * .55);
    }
    for (let k = 0; k < 70; k++) set(Math.floor(r() * w), Math.floor(r() * h), 1);
  } else if (kind === 'mountains') {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) L[j * w + i] = .1 + (1 - j / h) * .22;
    for (let layer = 0; layer < 4; layer++) {
      const base = h * (.38 + layer * .15), amp = h * (.32 - layer * .05), shade = .78 - layer * .2;
      for (let i = 0; i < w; i++) {
        const ridge = base - amp * Math.pow(n.fbm(i / (w * .28) + layer * 9, layer * 3.1, 6), 1.4) * 1.4;
        for (let j = Math.max(0, Math.floor(ridge)); j < h; j++) { const lit = n.fbm(i / 14 + layer, j / 14, 3) * .35 + (i / w) * .1; L[j * w + i] = clamp(shade - (j - ridge) / h * .4 + lit - .17, 0, 1); }
      }
    }
  } else if (kind === 'topo') {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const v = n.fbm(i / (w * .35), j / (w * .35), 5) * 14; const fr = v - Math.floor(v); L[j * w + i] = fr < .09 ? .95 : (Math.floor(v) % 5 === 0 && fr < .16 ? .9 : .06 + v / 14 * .12); }
  } else if (kind === 'wireframe') {
    const ctx = document.createElement('canvas'); ctx.width = w; ctx.height = h; const g = ctx.getContext('2d');
    g.strokeStyle = '#fff'; g.lineWidth = 1;
    const proj = (x, y, z) => { const cz = z + 3.2, f = h * 1.25; return [w / 2 + x * f / cz, h * .62 + y * f / cz]; };
    for (let gx = -10; gx <= 10; gx++) { g.beginPath(); for (let gz = 0; gz <= 20; gz++) { const X = gx * .3, Z = gz * .3, Y = -n.fbm(X + 4, Z + t, 4) * 1.3 + .7; const [px, py] = proj(X, Y, Z); gz ? g.lineTo(px, py) : g.moveTo(px, py); } g.stroke(); }
    for (let gz = 0; gz <= 20; gz++) { g.beginPath(); for (let gx = -10; gx <= 10; gx++) { const X = gx * .3, Z = gz * .3, Y = -n.fbm(X + 4, Z + t, 4) * 1.3 + .7; const [px, py] = proj(X, Y, Z); gx > -10 ? g.lineTo(px, py) : g.moveTo(px, py); } g.stroke(); }
    const id = g.getImageData(0, 0, w, h).data; for (let k = 0; k < w * h; k++) L[k] = id[k * 4] / 255 * .95 + .04;
  } else if (kind === 'blueprint') {
    const ctx = document.createElement('canvas'); ctx.width = w; ctx.height = h; const g = ctx.getContext('2d');
    g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 1;
    for (let i = 0; i < w; i += 8) { g.globalAlpha = .18; g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); }
    for (let j = 0; j < h; j += 8) { g.beginPath(); g.moveTo(0, j); g.lineTo(w, j); g.stroke(); }
    g.globalAlpha = 1; const cx = w * .45, cy = h * .52, R = Math.min(w, h) * .3;
    g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke(); g.beginPath(); g.arc(cx, cy, R * .55, 0, 7); g.stroke(); g.beginPath(); g.arc(cx, cy, R * .18, 0, 7); g.stroke();
    for (let k = 0; k < 12; k++) { const a = k / 12 * 6.283; g.beginPath(); g.moveTo(cx + Math.cos(a) * R * .55, cy + Math.sin(a) * R * .55); g.lineTo(cx + Math.cos(a) * R * 1.12, cy + Math.sin(a) * R * 1.12); g.stroke(); }
    g.beginPath(); g.moveTo(cx - R * 1.4, cy); g.lineTo(cx + R * 1.6, cy); g.moveTo(cx, cy - R * 1.3); g.lineTo(cx, cy + R * 1.3); g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]);
    g.strokeRect(w * .74, h * .14, w * .2, h * .3); g.beginPath(); g.moveTo(w * .74, h * .14); g.lineTo(w * .94, h * .44); g.stroke();
    g.font = `${Math.max(6, h / 22)}px monospace`; g.fillText('FIG.2', w * .06, h * .12); g.fillText('R-314-A', w * .7, h * .92);
    g.beginPath(); g.moveTo(cx - R, h * .9); g.lineTo(cx + R, h * .9); g.moveTo(cx - R, h * .87); g.lineTo(cx - R, h * .93); g.moveTo(cx + R, h * .87); g.lineTo(cx + R, h * .93); g.stroke();
    const id = g.getImageData(0, 0, w, h).data; for (let k = 0; k < w * h; k++) L[k] = id[k * 4] / 255 * .95 + .05;
  } else if (kind === 'moon') {
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * .4;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const dx = (i - cx) / R, dy = (j - cy) / R, d2 = dx * dx + dy * dy;
      if (d2 > 1) { L[j * w + i] = r() < .004 ? 1 : .03; continue; }
      const z = Math.sqrt(1 - d2), lit = clamp(dx * -.55 + dy * -.35 + z * .75, 0, 1), cr = n.fbm(dx * 3 + 9, dy * 3, 5);
      L[j * w + i] = clamp(lit * (.55 + cr * .6) - (cr > .62 ? .25 : 0), 0, 1);
    }
  } else { for (let k = 0; k < w * h; k++) L[k] = r() * .7 + n.fbm((k % w) / 20, Math.floor(k / w) / 20) * .3; }
  const c = canvas.getContext('2d'); c.fillStyle = bg; c.fillRect(0, 0, W, H); c.fillStyle = fg;
  // light == ink on paper (inverted print), dithered with a 4x4 Bayer matrix
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (L[j * w + i] > BAYER[(j & 3) * 4 + (i & 3)]) c.fillRect(i * scale, j * scale, scale, scale);
  return canvas;
}

// ---------------------------------------------------------------- the distressed wordmark
const GLYPHS = {
  E: ['########', '########', '##......', '#######.', '#######.', '##......', '##......', '########', '########'],
  M: ['##......##', '###....###', '####..####', '##.####.##', '##..##..##', '##......##', '##......##', '##......##', '##......##'],
  B: ['#######.', '########', '##....##', '#######.', '#######.', '##....##', '##....##', '########', '#######.'],
  A: ['..####..', '.######.', '##....##', '##....##', '########', '########', '##....##', '##....##', '##....##'],
  R: ['#######.', '########', '##....##', '##....##', '#######.', '######..', '##..###.', '##...###', '##....##'],
  G: ['.#######', '########', '##......', '##......', '##..####', '##..####', '##....##', '########', '.######.'],
  O: ['.######.', '########', '##....##', '##....##', '##....##', '##....##', '##....##', '########', '.######.'],
  N: ['##....##', '###...##', '####..##', '##.##.##', '##..####', '##...###', '##....##', '##....##', '##....##'],
  W: ['##......##', '##......##', '##......##', '##......##', '##..##..##', '##.####.##', '####..####', '###....###', '##......##'],
  D: ['######..', '#######.', '##...###', '##....##', '##....##', '##....##', '##...###', '#######.', '######..'],
  ' ': ['....', '....', '....', '....', '....', '....', '....', '....', '....'],
};
/**
 * Giant blocky EMBARGO with worn print texture and moving redaction bars. Cells scatter away from the cursor and
 * spring back; bars sweep across on a loop. Returns { redact(), destroy() }.
 */
export function wordmark(canvas, { text = 'EMBARGO', color = '#e8e4d6', accent = '#d4f53c', ink = '#0a0a08', seed = 5, bars = [[1, 2, .03, .41], [6, 1, .5, .985], [4, 1, .28, .6]], interactive = true, intro = true } = {}) {
  const rows = 9, gap = 2;
  const glyphs = [...text.toUpperCase()].map((ch) => GLYPHS[ch] ?? GLYPHS[' ']);
  const cols = glyphs.reduce((s, g) => s + g[0].length, 0) + gap * (glyphs.length - 1);
  const cells = [];
  let ox = 0;
  for (const g of glyphs) { g.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') cells.push({ x: ox + x, y, dx: 0, dy: 0, vx: 0, vy: 0, a: 0, hot: 0 }); })); ox += g[0].length + gap; }
  const ctx = canvas.getContext('2d');
  const n = noise2(seed), r = rng(seed);
  let cs = 10, W = 0, H = 0, tex = null, raf = 0, alive = true, visible = true;
  const mouse = { x: -1e4, y: -1e4, on: false };
  const barState = bars.map(([row, h, a, b], i) => ({ row, h, a, b, p: intro ? 0 : 1, t: i * 1.7, flash: 0 }));
  function build() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = canvas.clientWidth; cs = W / cols; H = cs * rows;
    canvas.style.height = `${H}px`; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // texture: each cell is a 4x4 grid of worn sub-blocks
    tex = document.createElement('canvas'); tex.width = Math.ceil(W * dpr); tex.height = Math.ceil(H * dpr);
    const t = tex.getContext('2d'); t.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sub = 4, ss = cs / sub;
    for (const c of cells) for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) {
      const gx = c.x * sub + i, gy = c.y * sub + j, wear = n.fbm(gx / 7, gy / 7, 4), speck = r();
      if (wear < .22 && speck < .55) continue; // worn away
      if (speck < .02) continue;
      const tone = 220 + Math.floor((wear - .5) * 22 + (r() - .5) * 7);
      t.fillStyle = `rgb(${tone + 18},${tone + 14},${tone})`;
      t.fillRect(c.x * cs + i * ss, c.y * cs + j * ss, ss + .4, ss + .4);
    }
    t.globalCompositeOperation = 'destination-out'; // scratches
    for (let k = 0; k < cols * .55; k++) { t.lineWidth = .5 + r() * 1.1; t.beginPath(); const sx = r() * W, sy = r() * H; t.moveTo(sx, sy); t.lineTo(sx + (r() - .5) * cs * 6, sy + (r() - .5) * cs * 1.2); t.stroke(); }
    for (let k = 0; k < cols * 18; k++) t.fillRect(r() * W, r() * H, r() * 2, r() * 2);
    t.globalCompositeOperation = 'source-over';
  }
  function frame(now) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    const time = now / 1000;
    ctx.clearRect(0, 0, W, H);
    let moving = false;
    for (const c of cells) {
      const cx = (c.x + .5) * cs, cy = (c.y + .5) * cs;
      if (intro && c.a < 1) { c.a = Math.min(1, c.a + .035 + (c.x / cols) * .01); moving = true; }
      if (interactive && mouse.on) {
        const ddx = cx + c.dx - mouse.x, ddy = cy + c.dy - mouse.y, d2 = ddx * ddx + ddy * ddy, R = cs * 5.5;
        if (d2 < R * R) { const d = Math.sqrt(d2) || 1, f = (1 - d / R) * cs * .9; c.vx += ddx / d * f * .18; c.vy += ddy / d * f * .18; c.hot = 1; }
      }
      c.vx += -c.dx * .09; c.vy += -c.dy * .09; c.vx *= .78; c.vy *= .78; c.dx += c.vx; c.dy += c.vy; c.hot *= .95;
      if (Math.abs(c.dx) + Math.abs(c.dy) > .05 || c.hot > .02) moving = true;
      const a = intro ? Math.min(1, Math.max(0, c.a * 2 - (c.x / cols))) : 1;
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      const dpr = tex.width / W;
      ctx.drawImage(tex, c.x * cs * dpr, c.y * cs * dpr, cs * dpr, cs * dpr, c.x * cs + c.dx, c.y * cs + c.dy, cs, cs);
      if (c.hot > .05) { ctx.globalAlpha = c.hot * .9; ctx.fillStyle = accent; ctx.fillRect(c.x * cs + c.dx + cs * .2, c.y * cs + c.dy + cs * .2, cs * .6, cs * .6); }
    }
    ctx.globalAlpha = 1;
    for (const b of barState) { // redaction bars
      b.t += 1 / 60;
      const cyc = (b.t % 9) / 9; // 9 s loop: hold, retract, re-redact
      const target = cyc < .7 ? 1 : cyc < .8 ? 0 : 1;
      b.p += (target - b.p) * (target ? .07 : .12);
      if (Math.abs(target - b.p) > .002) moving = true;
      const x0 = b.a * W, x1 = lerp(x0, b.b * W, b.p);
      if (x1 - x0 < 1) continue;
      const by = b.row * cs + cs * .06, bh = b.h * cs - cs * .12;
      ctx.fillStyle = ink; ctx.fillRect(x0, by, x1 - x0, bh);
      ctx.fillStyle = 'rgba(232,228,214,.10)'; ctx.fillRect(x0, by, x1 - x0, 1); ctx.fillRect(x0, by + bh - 1, x1 - x0, 1);
      if (b.p < .995) { ctx.fillStyle = accent; ctx.fillRect(x1 - 3, by, 3, bh); }
    }
    if (!moving && !mouse.on && time > 4) { /* idle: keep loop for bars, cheap */ }
  }
  const onMove = (e) => { const rc = canvas.getBoundingClientRect(); mouse.x = e.clientX - rc.left; mouse.y = e.clientY - rc.top; mouse.on = mouse.x > -cs * 4 && mouse.y > -cs * 4 && mouse.x < W + cs * 4 && mouse.y < H + cs * 4; };
  const onLeave = () => { mouse.on = false; };
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
  io.observe(canvas);
  const ro = new ResizeObserver(() => build());
  ro.observe(canvas);
  build();
  if (reduced()) { cells.forEach((c) => (c.a = 1)); barState.forEach((b) => (b.p = 1)); }
  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', onLeave);
  raf = requestAnimationFrame(frame);
  return {
    redact() { barState.forEach((b) => { b.t = 0; b.p = 0; }); },
    burst() { for (const c of cells) { c.vx += (r() - .5) * cs * 2.4; c.vy += (r() - .5) * cs * 2.4; c.hot = r() < .2 ? 1 : 0; } },
    destroy() { alive = false; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); window.removeEventListener('pointermove', onMove); },
  };
}

// ---------------------------------------------------------------- WARDEN sigil: a pixel eye whose pupil is a keyhole
const EYE = ['....#####....', '..##.....##..', '.#.........#.', '#...........#', '#...........#', '#...........#', '.#.........#.', '..##.....##..', '....#####....'];
const IRIS = ['AAAAA', 'AKKKA', 'AKKKA', 'AAKAA', 'AAKAA'];
const WARDEN_COLORS = { idle: '#d4f53c', watch: '#d4f53c', think: '#e8e4d6', alert: '#ff4b2b', held: '#f3b23a', sleep: '#7d7a70' };
/**
 * Draws Warden on a canvas and keeps it alive: the iris follows the pointer (or a target), it blinks, and states
 * change colour/behaviour: idle | watch | think (scans) | alert | held | sleep. Returns a controller.
 */
export function warden(canvas, { state = 'idle', follow = true, glow = true, lid = '#e8e4d6', size } = {}) {
  const ctx = canvas.getContext('2d');
  const W = 13, H = 9, pad = 1;
  const S = { state, o: 1, blinkAt: performance.now() + 1500 + Math.random() * 3000, lx: 0, ly: 0, tx: 0, ty: 0, scan: 0, alive: true, gaze: null };
  function fit() {
    const px = size ?? canvas.clientWidth ?? 64, dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(px * dpr); canvas.height = Math.round(px * dpr * (H + pad * 2) / (W + pad * 2));
    if (!canvas.style.height && canvas.clientWidth) canvas.style.height = `${canvas.clientWidth * (H + pad * 2) / (W + pad * 2)}px`;
  }
  fit();
  const onMove = (e) => {
    if (!follow || S.gaze) return;
    const rc = canvas.getBoundingClientRect(); if (!rc.width) return;
    const nx = (e.clientX - (rc.left + rc.width / 2)) / Math.max(200, innerWidth * .35), ny = (e.clientY - (rc.top + rc.height / 2)) / Math.max(160, innerHeight * .35);
    S.tx = clamp(nx * 2.4, -2, 2); S.ty = clamp(ny * 1.6, -1.2, 1.2);
  };
  window.addEventListener('pointermove', onMove, { passive: true });
  let raf = 0;
  function draw(now) {
    if (!S.alive) return;
    raf = requestAnimationFrame(draw);
    if (!canvas.isConnected) return;
    // blink
    if (now > S.blinkAt) { S.blinking = now; S.blinkAt = now + 2600 + Math.random() * 4200; }
    let o = S.state === 'sleep' ? .08 : 1;
    if (S.blinking) { const p = (now - S.blinking) / 170; o = p < 1 ? 1 - p : p < 2 ? p - 1 : 1; if (p >= 2) S.blinking = 0; }
    S.o = o;
    if (S.state === 'think') { S.scan += .045; S.tx = Math.sin(S.scan) * 2; S.ty = Math.sin(S.scan * .5) * .6; }
    else if (S.gaze) { S.tx = S.gaze[0]; S.ty = S.gaze[1]; }
    S.lx = lerp(S.lx, S.tx, .14); S.ly = lerp(S.ly, S.ty, .14);
    const cw = canvas.width / (W + pad * 2), chh = canvas.height / (H + pad * 2), c = Math.min(cw, chh);
    const offX = (canvas.width - c * W) / 2, offY = (canvas.height - c * H) / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const col = WARDEN_COLORS[S.state] ?? WARDEN_COLORS.idle;
    const mid = 4;
    const ry = (y) => Math.round(mid + (y - mid) * o);
    // iris (clipped to the eye interior)
    const ix = Math.round(6 + S.lx), iy = Math.round(mid + S.ly);
    const inside = (x, y) => { const row = EYE[y]; if (!row) return false; const first = row.indexOf('#'), last = row.lastIndexOf('#'); return x > first && x < last && y > 0 && y < H - 1; };
    if (glow) { ctx.shadowColor = col; ctx.shadowBlur = c * 1.6; }
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
      const x = ix - 2 + i, y = iy - 2 + j; if (!inside(x, y)) continue;
      const yy = ry(y); if (Math.abs(yy - mid) >= Math.max(1, Math.round(4 * o))) continue;
      const k = IRIS[j][i]; if (k === 'K') continue;
      ctx.fillStyle = col; ctx.fillRect(offX + x * c, offY + yy * c, c + .5, c + .5);
    }
    ctx.shadowBlur = 0;
    // lids
    ctx.fillStyle = lid;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (EYE[y][x] === '#') ctx.fillRect(offX + x * c, offY + ry(y) * c, c + .5, c + .5);
    if (o < .25) { ctx.fillStyle = lid; ctx.fillRect(offX + c, offY + mid * c, c * (W - 2), c); }
    if (S.state === 'think') { ctx.fillStyle = 'rgba(212,245,60,.25)'; const sy = (Math.sin(S.scan * 2) * .5 + .5) * H; ctx.fillRect(offX, offY + sy * c, c * W, c * .5); }
  }
  raf = requestAnimationFrame(draw);
  return {
    set state(s) { S.state = s; }, get state() { return S.state; },
    blink() { S.blinking = performance.now(); },
    look(x, y) { S.gaze = x == null ? null : [clamp(x, -2, 2), clamp(y ?? 0, -1.2, 1.2)]; },
    fit, destroy() { S.alive = false; cancelAnimationFrame(raf); window.removeEventListener('pointermove', onMove); },
  };
}
/** Small inline Warden mark: <canvas class="warden" data-warden="watch"> anywhere is brought to life by boot(). */
export function wakeWardens(root = document) { for (const c of $$('canvas[data-warden]:not([data-awake])', root)) { c.dataset.awake = '1'; c._warden = warden(c, { state: c.dataset.warden || 'idle', glow: c.dataset.glow !== '0', follow: c.dataset.follow !== '0' }); } }

// ---------------------------------------------------------------- scramble text
const GLYPH_SET = '█▓▒░#/\\<>_[]{}=+*0123456789ABCDEFX';
export function scramble(el, to = el.dataset.text ?? el.textContent, { duration = .7, chars = GLYPH_SET, delay = 0 } = {}) {
  if (reduced()) { el.textContent = to; return Promise.resolve(); }
  el.dataset.text = to;
  const from = el.textContent, len = Math.max(from.length, to.length), start = performance.now() + delay * 1000;
  cancelAnimationFrame(el._scr);
  return new Promise((res) => {
    const step = (now) => {
      const p = clamp((now - start) / (duration * 1000), 0, 1);
      let out = '';
      for (let i = 0; i < len; i++) {
        const settle = (i / len) * .7 + .3;
        if (p >= settle) out += to[i] ?? '';
        else if (p > settle - .45 && (to[i] ?? ' ') !== ' ') out += chars[Math.floor(Math.random() * chars.length)];
        else out += now < start ? (from[i] ?? '') : (to[i] === ' ' ? ' ' : (from[i] ?? ''));
      }
      el.textContent = out;
      if (p < 1) el._scr = requestAnimationFrame(step); else { el.textContent = to; res(); }
    };
    el._scr = requestAnimationFrame(step);
  });
}
function bindScramble(root = document) {
  for (const el of $$('[data-scramble]:not([data-scr-bound])', root)) {
    el.dataset.scrBound = '1';
    const target = el.querySelector('.scr') ?? el;
    const text = target.textContent;
    el.addEventListener('pointerenter', () => { scramble(target, text, { duration: .45 }); sound.tick(); });
  }
}

// ---------------------------------------------------------------- sound (default off)
export const sound = (() => {
  let ac = null, on = localStorage.getItem('emb.sound') === '1', master = null;
  const ctx = () => { if (!ac) { ac = new (window.AudioContext || window.webkitAudioContext)(); master = ac.createGain(); master.gain.value = .22; master.connect(ac.destination); } if (ac.state === 'suspended') ac.resume(); return ac; };
  const blip = (f, d = .03, type = 'square', v = .25) => { if (!on) return; const a = ctx(), o = a.createOscillator(), g = a.createGain(); o.type = type; o.frequency.value = f; g.gain.setValueAtTime(v, a.currentTime); g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + d); o.connect(g).connect(master); o.start(); o.stop(a.currentTime + d + .02); };
  const noise = (d = .06, v = .3, hp = 1800) => { if (!on) return; const a = ctx(), b = a.createBuffer(1, a.sampleRate * d, a.sampleRate), ch = b.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length); const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(); f.type = 'highpass'; f.frequency.value = hp; g.gain.value = v; s.buffer = b; s.connect(f).connect(g).connect(master); s.start(); };
  let last = 0;
  return {
    get on() { return on; },
    toggle() { on = !on; localStorage.setItem('emb.sound', on ? '1' : '0'); if (on) { ctx(); blip(880, .05); setTimeout(() => blip(1320, .06), 60); } document.dispatchEvent(new CustomEvent('emb:sound', { detail: on })); return on; },
    tick() { const t = performance.now(); if (t - last < 40) return; last = t; blip(2400 + Math.random() * 400, .012, 'square', .08); },
    click() { noise(.04, .35, 2500); blip(140, .06, 'sine', .4); },
    stamp() { noise(.12, .5, 300); blip(70, .18, 'sine', .7); },
    type() { noise(.012, .12, 4000); },
    whoosh() { if (!on) return; const a = ctx(), o = a.createOscillator(), g = a.createGain(); o.type = 'sawtooth'; o.frequency.setValueAtTime(90, a.currentTime); o.frequency.exponentialRampToValueAtTime(1400, a.currentTime + .35); g.gain.setValueAtTime(.08, a.currentTime); g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + .4); o.connect(g).connect(master); o.start(); o.stop(a.currentTime + .42); },
    ok() { blip(660, .05, 'square', .12); setTimeout(() => blip(990, .08, 'square', .12), 70); },
    deny() { blip(220, .09, 'square', .14); setTimeout(() => blip(150, .14, 'square', .14), 90); },
  };
})();
export function soundButton() {
  const b = document.createElement('button'); b.className = `sndbtn${sound.on ? ' on' : ''}`; b.type = 'button'; b.setAttribute('aria-pressed', String(sound.on));
  b.innerHTML = '<span class="bars"><i></i><i></i><i></i><i></i></span><span class="scr">SOUND ' + (sound.on ? 'ON' : 'OFF') + '</span>';
  b.dataset.cursor = 'TOGGLE';
  b.addEventListener('click', () => { const v = sound.toggle(); b.classList.toggle('on', v); b.setAttribute('aria-pressed', String(v)); scramble(b.querySelector('.scr'), `SOUND ${v ? 'ON' : 'OFF'}`, { duration: .35 }); });
  return b;
}

// ---------------------------------------------------------------- cursor
let cursorState = null;
export function cursor() {
  if (cursorState || isTouch()) return cursorState;
  const dot = document.createElement('div'); dot.className = 'cur cur-dot';
  const ring = document.createElement('div'); ring.className = 'cur cur-ring'; ring.innerHTML = '<i></i><i></i><i></i><i></i>';
  const lbl = document.createElement('div'); lbl.className = 'cur-lbl';
  document.body.append(ring, dot, lbl);
  document.documentElement.classList.add('has-cursor');
  const p = { x: innerWidth / 2, y: innerHeight / 2 }, r = { x: p.x, y: p.y }, l = { x: p.x, y: p.y };
  let shown = false, label = '';
  addEventListener('pointermove', (e) => { p.x = e.clientX; p.y = e.clientY; if (!shown) { shown = true; r.x = l.x = p.x; r.y = l.y = p.y; [dot, ring].forEach((x) => x.classList.remove('hide')); } }, { passive: true });
  document.addEventListener('pointerleave', () => { shown = false; [dot, ring, lbl].forEach((x) => x.classList.add('hide')); });
  addEventListener('pointerdown', () => { ring.classList.add('press'); sound.click(); });
  addEventListener('pointerup', () => ring.classList.remove('press'));
  const INTERACTIVE = 'a, button, [role="button"], [data-cursor], input[type="checkbox"], input[type="radio"], select, label[for], summary';
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.(INTERACTIVE);
    ring.classList.toggle('hov', !!t);
    const text = t?.dataset?.cursor ?? (t?.matches?.('a[href^="http"]') ? 'OPEN ↗' : '');
    if (text !== label) { label = text; lbl.textContent = text; lbl.classList.toggle('on', !!text); }
  });
  const tick = () => {
    r.x = lerp(r.x, p.x, .16); r.y = lerp(r.y, p.y, .16); l.x = lerp(l.x, p.x, .11); l.y = lerp(l.y, p.y, .11);
    dot.style.transform = `translate3d(${p.x}px,${p.y}px,0)`;
    ring.style.transform = `translate3d(${r.x}px,${r.y}px,0)`;
    lbl.style.transform = `translate3d(${l.x + 22}px,${l.y + 20}px,0)`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  cursorState = { dot, ring, lbl };
  return cursorState;
}

// ---------------------------------------------------------------- magnetic
function magnetic(root = document) {
  if (isTouch()) return;
  for (const el of $$('[data-magnetic]:not([data-mag-bound])', root)) {
    el.dataset.magBound = '1';
    const s = Number(el.dataset.magnetic) || .3;
    el.addEventListener('pointermove', (e) => { const rc = el.getBoundingClientRect(); const x = (e.clientX - rc.left - rc.width / 2) * s, y = (e.clientY - rc.top - rc.height / 2) * s; el.style.transform = `translate(${x}px,${y}px)`; });
    el.addEventListener('pointerleave', () => { el.style.transition = 'transform .6s cubic-bezier(.2,.7,0,1)'; el.style.transform = ''; setTimeout(() => (el.style.transition = ''), 600); });
  }
}

// ---------------------------------------------------------------- grain
function grain() {
  if (document.querySelector('.grain') || reduced()) return;
  const c = document.createElement('canvas'); c.width = c.height = 160;
  const x = c.getContext('2d'), urls = [];
  for (let k = 0; k < 6; k++) { const d = x.createImageData(160, 160); for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; } x.putImageData(d, 0, 0); urls.push(c.toDataURL()); }
  const g = document.createElement('div'); g.className = 'grain'; g.setAttribute('aria-hidden', 'true');
  document.body.appendChild(g);
  let k = 0, last = 0;
  const step = (t) => { if (t - last > 90) { last = t; g.style.backgroundImage = `url(${urls[k++ % urls.length]})`; g.style.transform = `translate(${(Math.random() * 10 - 5) | 0}%,${(Math.random() * 10 - 5) | 0}%)`; } requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- split + reveals
export function split(el, mode = el.dataset.split || 'lines') {
  if (el.dataset.splitDone) return $$('.split-l > span', el);
  el.dataset.splitDone = '1';
  if (mode === 'chars') {
    const walk = (node) => { for (const ch of [...node.childNodes]) { if (ch.nodeType === 3) { const frag = document.createDocumentFragment(); for (const c of ch.textContent) { if (c === ' ') { frag.append(' '); continue; } const o = document.createElement('span'); o.className = 'split-l'; const i = document.createElement('span'); i.textContent = c; o.append(i); frag.append(o); } ch.replaceWith(frag); } else if (ch.nodeType === 1 && !ch.classList.contains('rd')) walk(ch); } };
    walk(el);
  } else if (mode === 'words' || mode === 'lines') {
    const walk = (node) => { for (const ch of [...node.childNodes]) { if (ch.nodeType === 3) { const frag = document.createDocumentFragment(); ch.textContent.split(/(\s+)/).forEach((w) => { if (!w) return; if (/^\s+$/.test(w)) { frag.append(w); return; } const o = document.createElement('span'); o.className = 'split-l'; const i = document.createElement('span'); i.textContent = w; o.append(i); frag.append(o); }); ch.replaceWith(frag); } else if (ch.nodeType === 1 && ch.tagName !== 'BR') { if (ch.classList.contains('rd') || ch.classList.contains('nosplit')) { const o = document.createElement('span'); o.className = 'split-l'; ch.replaceWith(o); const i = document.createElement('span'); i.append(ch); o.append(i); } else walk(ch); } } };
    walk(el);
  }
  return $$('.split-l > span', el);
}

let G = null, ST = null, LENIS = null;
function revealOne(el) {
  if (el.classList.contains('rv-in')) return;
  const kind = el.dataset.reveal;
  el.classList.add('rv-in');
  if (reduced() || !G) return;
  if (kind === 'up' || kind === 'fade') { G.fromTo(el, { y: kind === 'up' ? 40 : 0, opacity: 0 }, { y: 0, opacity: 1, duration: 1.1, ease: 'expo.out', delay: Number(el.dataset.delay) || 0 }); return; }
  if (kind === 'split') { const parts = split(el); G.fromTo(parts, { yPercent: 115 }, { yPercent: 0, duration: 1.05, ease: 'expo.out', stagger: el.dataset.split === 'chars' ? .018 : .04, delay: Number(el.dataset.delay) || 0 }); return; }
  if (kind === 'scramble') { scramble(el, el.dataset.text ?? el.textContent, { duration: Number(el.dataset.dur) || .9, delay: Number(el.dataset.delay) || 0 }); return; }
  if (kind === 'stagger') { G.fromTo(el.children, { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: .9, ease: 'expo.out', stagger: .06, delay: Number(el.dataset.delay) || 0 }); return; }
  // default: redaction wipe — bar sweeps in, content declassified underneath, bar leaves
  const bar = document.createElement('span'); bar.className = `rv-bar${kind === 'ink' ? ' ink' : ''}`; el.appendChild(bar);
  const kids = [...el.children].filter((c) => c !== bar);
  G.set(kids, { opacity: 0 });
  G.timeline({ delay: Number(el.dataset.delay) || 0, onComplete: () => bar.remove() })
    .fromTo(bar, { scaleX: 0, transformOrigin: 'left' }, { scaleX: 1, duration: .5, ease: 'expo.inOut' })
    .set(kids, { opacity: 1 })
    .set(bar, { transformOrigin: 'right' })
    .to(bar, { scaleX: 0, duration: .55, ease: 'expo.inOut' });
}
export function reveals(root = document) {
  const els = $$('[data-reveal]:not(.rv-in)', root);
  if (!els.length) return;
  const io = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) { io.unobserve(e.target); revealOne(e.target); } }, { rootMargin: '0px 0px -8% 0px', threshold: .05 });
  els.forEach((el) => io.observe(el));
}
export function counters(root = document) {
  const io = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) {
      io.unobserve(e.target);
      const el = e.target, to = Number(el.dataset.count), dec = Number(el.dataset.dec || 0), pad = Number(el.dataset.pad || 0), dur = Number(el.dataset.dur || 1.6) * 1000, t0 = performance.now();
      const f = (v) => { let s = v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }); if (pad) s = s.padStart(pad, '0'); return (el.dataset.pre || '') + s + (el.dataset.suf || ''); };
      const step = (now) => { const p = clamp((now - t0) / dur, 0, 1), k = 1 - Math.pow(1 - p, 4); el.textContent = f(to * k); if (p < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }
  }, { threshold: .3 });
  $$('[data-count]', root).forEach((el) => io.observe(el));
}

// ---------------------------------------------------------------- shutter transitions
export function shutter(mode = 'in', cols = 8) {
  let el = document.querySelector('.shutter');
  if (!el) { el = document.createElement('div'); el.className = 'shutter'; el.style.setProperty('--cols', cols); el.innerHTML = '<i></i>'.repeat(cols); document.body.appendChild(el); }
  const bars = [...el.children];
  if (!G || reduced()) { bars.forEach((b) => (b.style.transform = mode === 'in' ? 'scaleY(1)' : 'scaleY(0)')); return Promise.resolve(); }
  sound.whoosh();
  return new Promise((res) => {
    G.killTweensOf(bars); // a reveal that starts while the cover is still running must win, or the last bar stays down
    if (mode === 'in') G.fromTo(bars, { scaleY: 0, transformOrigin: 'bottom' }, { scaleY: 1, duration: .55, ease: 'expo.inOut', stagger: { each: .04, from: 'start' }, onComplete: res });
    else G.fromTo(bars, { scaleY: 1, transformOrigin: 'top' }, { scaleY: 0, duration: .7, ease: 'expo.inOut', stagger: { each: .045, from: 'end' }, onComplete: res });
  });
}
function transitions() {
  if (sessionStorage.getItem('emb.shutter')) { sessionStorage.removeItem('emb.shutter'); shutter('in'); requestAnimationFrame(() => setTimeout(() => shutter('out'), 60)); }
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-shutter]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
    e.preventDefault();
    sessionStorage.setItem('emb.shutter', '1');
    shutter('in').then(() => { location.href = a.href; });
  });
}

// ---------------------------------------------------------------- preloader
/** Archive boot sequence: DECLASSIFYING 000→100 with log lines, then a shutter exit. Once per session. */
export function preloader({ lines = [], force = false, minMs = 1700 } = {}) {
  if ((!force && sessionStorage.getItem('emb.booted')) || reduced()) return Promise.resolve();
  sessionStorage.setItem('emb.booted', '1');
  const el = document.createElement('div');
  el.className = 'pre';
  el.innerHTML = `<style>
    .pre{position:fixed;inset:0;z-index:9998;background:var(--ink);color:var(--bone);display:grid;grid-template-rows:auto 1fr auto;padding:var(--pad);font:400 11px/1.7 var(--mono);letter-spacing:.08em;text-transform:uppercase}
    .pre .top,.pre .bot{display:flex;justify-content:space-between;color:var(--bone-3)}
    .pre .mid{display:grid;place-items:center;align-content:center;gap:26px}
    .pre .num{font:900 clamp(90px,16vw,240px)/.8 var(--dot);color:var(--bone);letter-spacing:-.02em}
    .pre .num b{color:var(--acid);font-weight:900}
    .pre .bar{width:min(520px,80vw);height:10px;border:1px solid var(--line-3);position:relative}
    .pre .bar i{position:absolute;inset:1px auto 1px 1px;background:var(--acid);width:0}
    .pre .log{height:7.2em;overflow:hidden;width:min(520px,80vw);color:var(--bone-3)}
    .pre .log div b{color:var(--acid);font-weight:500}
    .pre canvas{width:84px}
  </style>
  <div class="top"><span>EMBARGO // THE BLACK ARCHIVE</span><span>ACCESS TERMINAL ${AGENT.id}</span></div>
  <div class="mid"><canvas class="warden" data-warden="think" data-follow="0"></canvas><div class="lbl">DECLASSIFYING</div><div class="num"><span>000</span><b>%</b></div><div class="bar"><i></i></div><div class="log"></div></div>
  <div class="bot"><span>${AGENT.name} IS OPENING THE ARCHIVE</span><span>CLICK TO SKIP</span></div>`;
  document.body.appendChild(el);
  wakeWardens(el);
  const num = el.querySelector('.num span'), bar = el.querySelector('.bar i'), log = el.querySelector('.log');
  const L = lines.length ? lines : ['mounting archive', 'loading clearance rules', 'verifying signatures', 'sealing the vault', 'waking ' + AGENT.name.toLowerCase()];
  let done = false;
  return new Promise((res) => {
    const t0 = performance.now();
    let li = 0;
    const finish = async () => {
      if (done) return; done = true;
      num.textContent = '100'; bar.style.width = 'calc(100% - 2px)';
      const w = el.querySelector('canvas')?._warden; if (w) w.state = 'watch';
      await new Promise((r) => setTimeout(r, 260));
      if (G) await new Promise((r) => G.to(el, { clipPath: 'inset(0 0 100% 0)', duration: .9, ease: 'expo.inOut', onComplete: r }));
      el.querySelector('canvas')?._warden?.destroy(); el.remove(); res();
    };
    el.addEventListener('click', finish);
    const step = (now) => {
      if (done) return;
      const p = clamp((now - t0) / minMs, 0, 1), e = p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const v = Math.floor(e * 100);
      num.textContent = String(v).padStart(3, '0');
      bar.style.width = `calc(${e * 100}% - 2px)`;
      if (li < L.length && p > li / L.length) { const d = document.createElement('div'); d.innerHTML = `<b>[${String(v).padStart(3, '0')}]</b> ${L[li++]}`; log.appendChild(d); while (log.children.length > 4) log.firstChild.remove(); sound.type(); }
      if (p < 1) requestAnimationFrame(step); else finish();
    };
    requestAnimationFrame(step);
  });
}

// ---------------------------------------------------------------- boot
/**
 * Brings a page to life. Options: smooth (Lenis), cursor, grain, scan, plugins (GSAP plugins), preloader (lines|false).
 * Returns { gsap, ScrollTrigger, lenis }.
 */
export async function boot({ smooth = true, cursor: useCursor = true, grain: useGrain = true, scan = false, plugins = ['ScrollTrigger', 'CustomEase'], preloader: pre = false, paper = true } = {}) {
  document.documentElement.classList.add('js');
  if (paper) document.documentElement.style.setProperty('--paper-tex', `url(${paperTexture()})`);
  try { G = await loadGsap(plugins); ST = window.ScrollTrigger ?? null; } catch { G = null; }
  if (smooth && !reduced()) {
    try {
      const Lenis = await loadLenis();
      LENIS = new Lenis({ lerp: .085, smoothWheel: true, wheelMultiplier: .95, touchMultiplier: 1.4 });
      if (G) { if (ST) LENIS.on('scroll', ST.update); G.ticker.add((t) => LENIS.raf(t * 1000)); G.ticker.lagSmoothing(0); }
      else { const raf = (t) => { LENIS.raf(t); requestAnimationFrame(raf); }; requestAnimationFrame(raf); }
      document.addEventListener('click', (e) => { const a = e.target.closest?.('a[href^="#"]'); if (!a || a.getAttribute('href').length < 2) return; const t = document.querySelector(a.getAttribute('href')); if (t) { e.preventDefault(); LENIS.scrollTo(t, { offset: -60, duration: 1.4 }); } });
    } catch (e) { console.warn('lenis', e); }
  }
  if (useCursor) cursor();
  if (useGrain) grain();
  if (scan && !document.querySelector('.scan')) { const s = document.createElement('div'); s.className = 'scan'; document.body.appendChild(s); }
  transitions();
  if (pre) await preloader(Array.isArray(pre) ? { lines: pre } : {});
  refresh();
  return { gsap: G, ScrollTrigger: ST, lenis: LENIS };
}
/** Re-scan a (re-rendered) subtree for reveals, scramble hovers, magnetic elements, counters and Warden marks. */
export function refresh(root = document) { reveals(root); bindScramble(root); magnetic(root); counters(root); wakeWardens(root); }
export const motion = { get gsap() { return G; }, get ScrollTrigger() { return ST; }, get lenis() { return LENIS; } };
