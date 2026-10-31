/** Layer 1 of sensitivity detection (Part 11.8): rules/regex. Layer 2 (LLM) lives in tasks.ts. */
import type { Flag } from './schemas.ts';

function luhn(d: string) {
  let s = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; }
  return s % 10 === 0;
}
function entropy(s: string) {
  const f = new Map<string, number>(); for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let e = 0; for (const n of f.values()) { const p = n / s.length; e -= p * Math.log2(p); } return e;
}

export function regexFlags(text: string): Flag[] {
  const out: Flag[] = [];
  const add = (category: Flag['category'], severity: Flag['severity'], reason: string) => { if (!out.some((f) => f.reason === reason)) out.push({ category, severity, reason }); };
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text)) add('personal_data', 'high', 'Contains an email address');
  if (/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/.test(text)) add('personal_data', 'high', 'Contains a phone number');
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) { const d = m[0].replace(/\D/g, ''); if (d.length >= 13 && luhn(d)) add('personal_data', 'high', 'Contains a payment card number'); }
  if (/\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/.test(text)) add('personal_data', 'high', 'Contains an Aadhaar-like number');
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(text)) add('personal_data', 'high', 'Contains a PAN-like identifier');
  if (/\b[A-Z]{4}0[A-Z0-9]{6}\b/.test(text)) add('personal_data', 'medium', 'Contains an IFSC-like bank code');
  if (/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/.test(text)) add('personal_data', 'medium', 'Contains an IBAN-like account number');
  // \b only applies to the word-prefixed keys: "-----BEGIN" starts with a non-word char, so a leading \b would never match it.
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text))
    add('credentials', 'high', 'Contains an API key or secret');
  else for (const m of text.matchAll(/\b[A-Za-z0-9+/_=-]{32,}\b/g)) if (entropy(m[0]) > 4.2 && /\d/.test(m[0]) && /[a-z]/.test(m[0]) && /[A-Z]/.test(m[0])) { add('credentials', 'high', 'Contains a high-entropy secret-like string'); break; }
  return out;
}

const KW: [Flag['category'], Flag['severity'], RegExp, string][] = [
  ['pricing', 'medium', /(₹|rs\.?\s?\d|\$\s?\d|€\s?\d|\bprice|\bpricing|per month|\/month|\/mo\b|discount|\bmrr\b|\barr\b)/i, 'Mentions pricing'],
  ['deal_or_fundraising', 'high', /(term sheet|valuation|fundrais|\binvestor|series [a-d]\b|seed round|acquisition|acquire|\bdeal\b|contract value|\blakh|\bcrore)/i, 'Mentions a deal or fundraising'],
  ['health', 'high', /(diagnos|medical|hospital|therapy|pregnan|surgery|illness)/i, 'Mentions health information'],
  ['hr', 'high', /(salary|salaries|\bfired\b|firing|layoff|performance review|resign|compensation|\bpip\b|appraisal)/i, 'Mentions HR matters'],
  ['legal', 'medium', /(lawsuit|litigation|\bnda\b|settlement|legal notice|breach of contract|subpoena)/i, 'Mentions legal matters'],
  ['security', 'medium', /(password|vulnerab|exploit|security incident|\bbreach\b|rate limit|private key|firewall|pentest)/i, 'Mentions security details'],
];

/** Heuristic stand-in for the LLM classifier, used when no LLM is configured or it fails. */
export function keywordFlags(text: string): Flag[] {
  return KW.filter(([, , re]) => re.test(text)).map(([category, severity, , reason]) => ({ category, severity, reason }));
}

export function mergeFlags(...lists: Flag[][]): Flag[] {
  const byCat = new Map<string, Flag>();
  const rank = { low: 0, medium: 1, high: 2 };
  for (const f of lists.flat()) { const e = byCat.get(f.category); if (!e || rank[f.severity] > rank[e.severity]) byCat.set(f.category, f); }
  return [...byCat.values()];
}
export const maxSeverity = (flags: Flag[]) => (flags.some((f) => f.severity === 'high') ? 'high' : flags.some((f) => f.severity === 'medium') ? 'medium' : flags.length ? 'low' : null);
