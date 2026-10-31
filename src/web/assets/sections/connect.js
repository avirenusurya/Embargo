// 09 CONNECT: real connection snippets (same shapes the Connections screen generates, see
// src/api/routes/workspaces.ts), pointed at this host. Tabs scramble on switch; copy buttons; auto-cycles in view.
import { $, $$, reduced, onView, once, type } from './_util.js';

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function hl(src) {
  return src.split('\n').map((line) => {
    const ci = line.indexOf('#') >= 0 && !line.trim().startsWith('"') ? line.search(/\s#\s|^#/) : -1;
    let code = ci >= 0 ? line.slice(0, ci) : line, cm = ci >= 0 ? line.slice(ci) : '';
    code = esc(code)
      .replace(/("[^"]*")(\s*:)/g, '<span class="k">$1</span>$2')
      .replace(/(:\s*|\[|,\s*)("[^"]*")/g, '$1<span class="s">$2</span>')
      .replace(/(^|\s)(--[a-z-]+)/g, '$1<span class="t">$2</span>')
      .replace(/(emb_…)/g, '<span class="k">$1</span>')
      .replace(/^(URL|Transport|Header)(\s)/, '<span class="p">$1</span>$2');
    return code + (cm ? `<span class="c">${esc(cm)}</span>` : '');
  }).join('\n');
}

export async function init({ gsap, sound, scramble }) {
  const sec = $('#connect'); if (!sec) return;
  const host = location.origin, T = 'emb_…';
  const J = (o) => JSON.stringify(o, null, 2);
  const SN = {
    cc: { file: 'terminal', code: `claude mcp add --transport http embargo ${host}/mcp \\\n  --header "Authorization: Bearer ${T}"`, note: 'Paste into a terminal. Claude Code talks to the remote endpoint over Streamable HTTP with this connection\u2019s token.' },
    cursor: { file: '~/.cursor/mcp.json', code: J({ mcpServers: { embargo: { url: `${host}/mcp`, headers: { Authorization: `Bearer ${T}` } } } }), note: 'Add to Cursor\u2019s MCP config. Same endpoint, same token format, its own revocable connection.' },
    desktop: { file: 'claude_desktop_config.json', code: J({ mcpServers: { embargo: { command: 'npx', args: ['-y', 'embargo-mcp', '--token', T, '--api', host] } } }), note: 'Claude Desktop runs the local package, which proxies to the API.' },
    remote: { file: 'remote MCP server', code: `URL        ${host}/mcp\nTransport  Streamable HTTP\nHeader     Authorization: Bearer ${T}`, note: 'For ChatGPT and any other client that speaks remote MCP: point it at the endpoint and send the connection token as a bearer header.' },
    stdio: { file: 'terminal', code: `npx embargo-mcp --token ${T} --api ${host}\n\n# sealed blocks, encrypted on this machine\nnpx embargo-mcp --token ${T} sealed-init   # prints a recovery key once\nnpx embargo-mcp --token ${T} sealed-add "Board notes" notes.md`, note: 'The local stdio package adds sealed blocks: encrypted on your device, unreadable to the Embargo server.' },
  };
  const tabs = $$('#cnTabs button'), code = $('#cnCode'), file = $('#cnFile'), note = $('#cnNote'), copy = $('#cnCopy');
  let cur = 'cc', user = false;
  function show(k, animate = true) {
    cur = k; const s = SN[k];
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.k === k)));
    if (!animate || reduced()) { code.innerHTML = hl(s.code); file.textContent = s.file; note.textContent = s.note; return; }
    scramble(file, s.file, { duration: .4 });
    scramble(note, s.note, { duration: .7 });
    scramble(code, s.code, { duration: .65 }).then(() => { if (cur === k) code.innerHTML = hl(s.code); });
    sound.tick();
  }
  tabs.forEach((t) => t.addEventListener('click', () => { user = true; show(t.dataset.k); }));
  $('#cnTabs').addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const i = tabs.findIndex((t) => t.dataset.k === cur), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    user = true; n.focus(); show(n.dataset.k);
  });
  copy.addEventListener('click', async () => {
    const text = SN[cur].code;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch {} ta.remove(); }
    copy.classList.toggle('ok', ok); scramble($('.scr', copy), ok ? 'COPIED' : 'SELECT + COPY', { duration: .3 }); ok ? sound.ok() : sound.deny();
    if (!ok) { const r = document.createRange(); r.selectNodeContents(code); getSelection().removeAllRanges(); getSelection().addRange(r); }
    setTimeout(() => { copy.classList.remove('ok'); scramble($('.scr', copy), 'COPY', { duration: .3 }); }, 1600);
  });
  show('cc', false);

  // cycle through the tools while the terminal is on screen, until someone clicks a tab
  let vis = false, timer = 0;
  const term = $('#cnTerm');
  term.addEventListener('pointerenter', () => (user = true));
  onView(term, (v) => {
    vis = v; clearInterval(timer);
    if (v && !reduced()) timer = setInterval(() => { if (!user && vis && !document.hidden) { const i = tabs.findIndex((t) => t.dataset.k === cur); show(tabs[(i + 1) % tabs.length].dataset.k); } }, 4200);
  }, { threshold: .4 });

  // the get_context exchange types itself out once
  const outLines = $$('#cnOut .ol');
  if (!reduced()) {
    const html = outLines.map((l) => l.innerHTML); outLines.forEach((l) => (l.textContent = ''));
    once($('#cnOut'), async () => {
      for (let i = 0; i < outLines.length; i++) {
        const tmp = document.createElement('div'); tmp.innerHTML = html[i];
        await type(outLines[i], tmp.textContent, { speed: 10, sound });
        outLines[i].innerHTML = html[i];
      }
    }, { threshold: .5 });
  }
  if (gsap && !reduced()) gsap.from(tabs, { y: -16, opacity: 0, stagger: .06, duration: .7, ease: 'expo.out', scrollTrigger: { trigger: term, start: 'top 80%', once: true } });
}
