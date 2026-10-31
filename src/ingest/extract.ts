/** Text extraction for documents and URLs (Parts 11.2, 11.3). */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { HttpError } from '../util.ts';

export async function extractFile(buf: Buffer, filename: string, mime = ''): Promise<{ text: string; title?: string }> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf' || mime === 'application/pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    const t = String(text).trim();
    if (!t) throw new HttpError(422, 'no_text_found', 'No text found in PDF (scanned PDFs need OCR, which is not supported)');
    return { text: t, title: filename.replace(/\.[^.]+$/, '') };
  }
  if (ext === 'docx' || mime.includes('wordprocessingml')) {
    const mammoth = await import('mammoth');
    const r = await (mammoth as any).default.convertToMarkdown?.({ buffer: buf }) ?? await (mammoth as any).default.extractRawText({ buffer: buf });
    return { text: r.value, title: filename.replace(/\.[^.]+$/, '') };
  }
  if (ext === 'html' || ext === 'htm' || mime.includes('html')) return extractHtml(buf.toString('utf8'));
  if (['md', 'markdown', 'txt', 'text', 'csv', 'json', 'yaml', 'yml', 'toml', 'ts', 'js', 'py', 'go', 'rs', ''].includes(ext) || mime.startsWith('text/'))
    return { text: buf.toString('utf8'), title: filename.replace(/\.[^.]+$/, '') };
  throw new HttpError(415, 'unsupported_type', `Unsupported file type .${ext}`);
}

export async function extractHtml(html: string, url?: string): Promise<{ text: string; title?: string }> {
  const { parseHTML } = await import('linkedom');
  const { Readability } = await import('@mozilla/readability');
  const { document } = parseHTML(html);
  const art = new Readability(document as any).parse();
  const text = (art?.textContent ?? document.body?.textContent ?? '').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  if (!text) throw new HttpError(422, 'no_text_found', 'No readable text on page');
  return { text, title: art?.title || document.title || url };
}

// ---------- SSRF-safe fetch ----------
/** Non-public destinations (Part 19.3 "block private ranges"): private, loopback, link-local, CGNAT, multicast, reserved,
 *  documentation/benchmark nets, and IPv6 ranges that embed or translate IPv4 (mapped, NAT64, 6to4, Teredo). */
const BLOCKED4 = new net.BlockList(), BLOCKED6 = new net.BlockList(); // separate lists: Node matches IPv4 against IPv6 rules via ::ffff:0:0/96
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const)
  BLOCKED4.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 96] /* ::, ::1 and IPv4-compatible */, ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 32] /* Teredo */, ['2001:db8::', 32], ['2002::', 16] /* 6to4 */, ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const)
  BLOCKED6.addSubnet(a, p, 'ipv6');

/** Eight 16-bit words of an IPv6 address (accepts embedded dotted quads and zone ids), or null if it is not IPv6. */
function ipv6Words(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!net.isIPv6(s)) return null;
  const dotted = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) { const [a, b, c, d] = dotted.slice(2).map(Number); s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`; }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const words = [...h, ...(tail === null ? [] : Array(8 - h.length - t.length).fill('0')), ...t].map((x) => parseInt(x, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/** Canonical form for policy checks: IPv4-mapped (::ffff:a.b.c.d / ::ffff:7f00:1), IPv4-compatible (::a.b.c.d),
 *  IPv4-translated (::ffff:0:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses become the IPv4 address they reach. */
export function normaliseIp(ip: string): { address: string; family: 'ipv4' | 'ipv6' } | null {
  const raw = ip.trim().replace(/^\[|\]$/g, '');
  if (net.isIPv4(raw)) return { address: raw, family: 'ipv4' };
  const w = ipv6Words(raw);
  if (!w) return null;
  const v4 = () => `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && (w[5] === 0xffff || w[5] === 0)) return { address: v4(), family: 'ipv4' };
  if (zero(0, 4) && w[4] === 0xffff && w[5] === 0) return { address: v4(), family: 'ipv4' };
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return { address: v4(), family: 'ipv4' };
  return { address: w.map((x) => x.toString(16)).join(':'), family: 'ipv6' };
}

/** True for any address an import must not reach. Unparseable input fails closed. */
export function isPrivateAddress(ip: string) {
  const raw = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const n = normaliseIp(raw);
  if (!n) return true;
  if (n.family === 'ipv4' ? BLOCKED4.check(n.address, 'ipv4') : BLOCKED6.check(n.address, 'ipv6')) return true;
  // Also check the original IPv6 form, so the embedding prefixes (mapped, NAT64, 6to4…) stay blocked as whole ranges.
  return net.isIPv6(raw) && BLOCKED6.check(raw, 'ipv6');
}
const isPrivate = isPrivateAddress;
/** Validates the resolved address at connect time, so DNS rebinding cannot swap in a private IP. */
const safeLookup: net.LookupFunction = (host, opts, cb) => {
  dns.lookup(host, { ...opts, all: true }, (err, addrs: any) => {
    if (err) return cb(err, '', 4);
    const list = (Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }]) as dns.LookupAddress[];
    const bad = list.find((a) => isPrivate(a.address));
    if (bad || !list.length) return cb(Object.assign(new Error('Blocked private address'), { code: 'EBLOCKED' }), '', 4);
    if ((opts as any).all) return (cb as any)(null, list);
    cb(null, list[0].address, list[0].family);
  });
};

export function safeFetch(rawUrl: string, opts: { maxBytes?: number; timeoutMs?: number; redirects?: number } = {}): Promise<{ body: Buffer; contentType: string; url: string }> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024, timeoutMs = opts.timeoutMs ?? 15000, redirects = opts.redirects ?? 3;
  let u: URL;
  try { u = new URL(rawUrl); } catch { return Promise.reject(new HttpError(400, 'bad_url')); }
  if (!['http:', 'https:'].includes(u.protocol)) return Promise.reject(new HttpError(400, 'bad_url', 'Only http(s) URLs are allowed'));
  // IP literals: Node skips the lookup hook for them, so they are checked here (in canonical form) on every hop.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivate(host)) return Promise.reject(new HttpError(400, 'blocked_url', 'Private addresses are not allowed'));
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(u, { lookup: safeLookup, timeout: timeoutMs, headers: { 'user-agent': 'EmbargoBot/1.0 (+context import)', accept: 'text/html,text/plain,application/pdf,*/*' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new HttpError(400, 'too_many_redirects'));
        return resolve(safeFetch(new URL(res.headers.location, u).toString(), { maxBytes, timeoutMs, redirects: redirects - 1 }));
      }
      if (!res.statusCode || res.statusCode >= 400) { res.resume(); return reject(new HttpError(422, 'fetch_failed', `URL returned ${res.statusCode}`)); }
      const chunks: Buffer[] = []; let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n > maxBytes) { req.destroy(); reject(new HttpError(413, 'too_large', 'Page exceeds size cap')); } else chunks.push(c); });
      res.on('end', () => resolve({ body: Buffer.concat(chunks), contentType: String(res.headers['content-type'] ?? ''), url: u.toString() }));
    });
    req.on('timeout', () => req.destroy(new HttpError(504, 'timeout', 'URL fetch timed out')));
    req.on('error', (e: any) => reject(e.code === 'EBLOCKED' ? new HttpError(400, 'blocked_url', 'URL resolves to a private address') : e instanceof HttpError ? e : new HttpError(422, 'fetch_failed', e.message)));
  });
}

export async function extractUrl(url: string) {
  const r = await safeFetch(url);
  if (r.contentType.includes('pdf')) return extractFile(r.body, 'page.pdf', 'application/pdf');
  if (r.contentType.includes('html') || !r.contentType) return extractHtml(r.body.toString('utf8'), r.url);
  return { text: r.body.toString('utf8'), title: url };
}
