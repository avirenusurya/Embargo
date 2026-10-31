// Vercel build: the marketing site is static, so Vercel serves it directly (fast, and it stays up while the Render
// backend sleeps). Everything that needs the server (/app, /auth, /mcp, the API, review/verify/card links) has no
// file here and falls through to the rewrite in vercel.json, which proxies it to Render.
import fs from 'node:fs';
import path from 'node:path';

const out = 'vercel-public';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync('src/web/landing.html', path.join(out, 'index.html'));          // GET /
fs.cpSync('src/web', path.join(out, 'static'), { recursive: true });            // GET /static/* (same as the server)
fs.rmSync(path.join(out, 'static', 'landing.html'));
fs.cpSync('node_modules/gsap/dist', path.join(out, 'vendor/gsap'), { recursive: true });
fs.cpSync('node_modules/lenis/dist', path.join(out, 'vendor/lenis'), { recursive: true });
console.log('vercel-public ready');
