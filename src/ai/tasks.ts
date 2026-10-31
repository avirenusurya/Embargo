/**
 * LLM tasks (Part 10.4). Each task uses the LLM when configured (AI Grants India credits) and falls back to a
 * deterministic heuristic otherwise, so the product works end to end without a key.
 * System prompts live in versioned files under prompts/ (see ai/prompts.ts).
 */
import * as chrono from 'chrono-node';
import { config } from '../config.ts';
import { chatJson, data, llmEnabled } from './llm.ts';
import * as S from './schemas.ts';
import { keywordFlags, mergeFlags, regexFlags } from './sensitivity.ts';
import { prompt, promptVersion, notePrompt } from './prompts.ts';
import { log, wordTokens } from '../util.ts';
import type { Flag, Structured } from './schemas.ts';

/** @deprecated per-task versions come from prompts/; kept for callers that print a global version. */
export const PROMPT_VERSION = 'v1';
const M = config.ai.models;

async function withFallback<T>(task: string, llm: () => Promise<T>, heuristic: () => T, strict = false): Promise<T> {
  if (!llmEnabled()) { notePrompt(task, 'heuristic'); return heuristic(); }
  try { const r = await llm(); notePrompt(task, promptVersion(task)); return r; } catch (e: any) {
    if (strict) throw e;
    log('warn', 'llm.fallback', { task, err: String(e.message).slice(0, 200) });
    notePrompt(task, 'heuristic');
    return heuristic();
  }
}

// ---------------- text helpers ----------------
const FILLER = /\b(um+|uh+|basically|actually|you know|i mean|kind of|sort of|literally|just|really|so yeah|okay so)\b,?\s*/gi;
export const sentences = (t: string) =>
  t.replace(/\r/g, '').split(/\n+|(?<=[.!?])\s+(?=[A-Z₹$"'(\d])/).map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter((s) => s.length > 1);
const clean = (s: string) => s.replace(FILLER, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const STOPW = new Set(['the', 'a', 'an', 'our', 'their', 'my', 'new', 'current', 'this', 'that', 'its', 'his', 'her', 'we', 'so', 'and', 'now', 'also', 'final']);

// ---------------- fact extraction ----------------
function normKey(words: string[]) { return words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => w && !STOPW.has(w)).map((w) => (w.length > 3 ? w.replace(/s$/, '') : w)); }
function classifyAttr(value: string) {
  if (/[₹$€]|\b(rs|inr|usd)\b/i.test(value)) return 'price';
  if (chrono.parseDate(value)) return 'date';
  if (/\d/.test(value)) return 'value';
  return 'value';
}
function factFrom(left: string, value: string, confidence: number) {
  value = value.replace(/\s+(because|since|but|so that|which)\b.*$/i, '').replace(/[.;,!]+$/, '').replace(/\s+(now|today|already|instead)$/i, '').trim();
  if (!value || value.split(/\s+/).length > 12 || value.length > 100) return null;
  // Keep only the clause nearest the verb ("Quick update, the launch price" → "the launch price").
  left = left.split(/[,;:—–]|\s-\s/).pop()!.trim();
  const k = normKey(left.split(/\s+/)).slice(-3);
  if (!k.length || k.join(' ').length > 50) return null;
  const entity = k.length > 1 ? k.slice(0, -1).join(' ') : k[0];
  const attribute = k.length > 1 ? k[k.length - 1] : classifyAttr(value);
  return { entity, attribute, value, confidence };
}
export function heuristicFacts(text: string) {
  const out: { entity: string; attribute: string; value: string; confidence: number }[] = [];
  for (const s0 of sentences(text)) {
    const s = s0.replace(/\*\*/g, '');
    let m = s.match(/^\s*([^:]{2,50}?):\s*(.{1,100})$/);
    let f = m ? factFrom(m[1], m[2], 0.6) : null;
    if (!f && (m = s.match(/^(.{2,60}?)\s+(?:is|are|was|will be|=|has been|is now|now is)\s+(.{1,100})$/i))) f = factFrom(m[1], m[2], 0.7);
    if (!f && (m = s.match(/\b(?:moved|changed|shifted|set|updated|pushed|raised|lowered|increased|decreased)\s+(?:the\s+)?(.{2,40}?)\s+to\s+(.{1,60})$/i))) f = factFrom(m[1], m[2], 0.75);
    if (!f && (m = s.match(/^(.{2,40}?)\s+(?:moved|changed|shifted|pushed|raised|lowered)\s+to\s+(.{1,60})$/i))) f = factFrom(m[1], m[2], 0.75);
    if (f && !out.some((o) => o.entity === f!.entity && o.attribute === f!.attribute && o.value === f!.value)) out.push(f);
  }
  return out;
}

// ---------------- compress_block ----------------
const DECISION = /\b(decided|decision|we will|we'll|agreed|going with|approved|chose|chosen|moving to|moved .* to|finali[sz]ed|locked)\b/i;
export function heuristicCompress(raw: string, sourceType: string, titleHint?: string): Structured {
  const text = raw.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const lines = text.split('\n');
  const sections: { heading: string; text: string }[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  let docTitle = titleHint ?? '';
  for (const l of lines) {
    const h = l.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (h) {
      if (!docTitle && /^\s{0,3}#\s/.test(l)) { docTitle = h[1]; continue; }
      if (cur && cur.lines.join('').trim()) sections.push({ heading: cur.heading, text: cur.lines.join('\n') });
      cur = { heading: h[1], lines: [] };
    } else { (cur ??= { heading: '', lines: [] }).lines.push(l); }
  }
  if (cur && cur.lines.join('').trim()) sections.push({ heading: cur.heading, text: cur.lines.join('\n') });
  // No headings: chunk paragraphs into ~120-word sections.
  let out = sections;
  const plain = text.replace(/^\s{0,3}#{1,6}\s+.*$/gm, '').trim();
  if (sections.length <= 1) {
    const paras = plain.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    out = []; let buf: string[] = [];
    const flush = () => { if (buf.length) { const t = buf.join('\n'); out.push({ heading: t.split(/\s+/).slice(0, 6).join(' ').replace(/[^\p{L}\p{N} ]/gu, '').trim(), text: t }); buf = []; } };
    for (const p of paras) { buf.push(p); if (buf.join(' ').split(/\s+/).length > 120) flush(); }
    flush();
    if (out.length === 1) out[0].heading = 'Details';
  }
  const seen = new Set<string>();
  const compressSection = (t: string) => sentences(t).map(clean).filter((s) => { const k = s.toLowerCase(); if (seen.has(k) || s.length < 3) return false; seen.add(k); return true; }).join('\n');
  const secs = out.map((s) => ({ heading: s.heading || 'Notes', text: compressSection(s.text) })).filter((s) => s.text);
  const all = sentences(plain).map(clean);
  const title = (docTitle || all[0] || 'Untitled').replace(/[#*_`]/g, '').slice(0, 80).trim();
  const summary = all.filter((s) => s !== title).slice(0, 2).join(' ').split(/\s+/).slice(0, 50).join(' ');
  // Headings are structure, not claims ("# Help center: Offline mode" is not the fact help|center = Offline mode):
  // facts come from body lines only, with list markers stripped.
  const factText = lines.filter((l) => !/^\s{0,3}#{1,6}(\s|$)/.test(l)).map((l) => l.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')).join('\n');
  return {
    title, summary, sections: secs,
    facts: heuristicFacts(factText),
    decisions: [...new Set(all.filter((s) => DECISION.test(s) && s.length < 300))].slice(0, 20),
    open_questions: [...new Set(all.filter((s) => /\?\s*$/.test(s) || /^(tbd|open question|todo)\b/i.test(s)))].slice(0, 20),
  };
}

export async function compressBlock(raw: string, sourceType: string, titleHint?: string): Promise<Structured> {
  return withFallback('compress_block', () => chatJson('compress_block', M.compress, prompt('compress_block').text,
    `Source type: ${sourceType}\n${titleHint ? `Suggested title: ${titleHint}\n` : ''}${data('source', raw.slice(0, 120000))}`, S.CompressOut),
  () => heuristicCompress(raw, sourceType, titleHint));
}

// ---------------- split_statements ----------------
const TURN = /^\s*(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*)?([A-Z\p{Lu}][\p{L}0-9 .'’-]{0,40}?)\s*(?:\(\d{1,2}:\d{2}(?::\d{2})?\))?\s*[:：]\s+(.+)$/u;
const toMs = (ts?: string) => { if (!ts) return null; const p = ts.split(':').map(Number); return (p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]) * 1000; };
export function heuristicSplit(transcript: string) {
  const statements: { speaker_label: string; text: string; start_ms: number | null }[] = [];
  let speaker = 'Unknown', ts: number | null = null;
  for (const line of transcript.replace(/\r/g, '').split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(TURN);
    let body = line.trim();
    if (m) { speaker = m[2].trim(); ts = toMs(m[1]); body = m[3]; }
    for (const s of sentences(body)) { const c = clean(s); if (c.length > 2) statements.push({ speaker_label: speaker, text: c, start_ms: ts }); }
  }
  return { statements };
}
export async function splitStatements(transcript: string) {
  return withFallback('split_statements', () => chatJson('split_statements', M.compress, prompt('split_statements').text,
    data('transcript', transcript.slice(0, 120000)), S.SplitOut), () => heuristicSplit(transcript));
}
/** Structured turns (Wispr Notetaker, Whisper segments) already carry speaker and start time: split each turn into
 *  sentence-level statements locally so neither can be lost or re-attributed by re-parsing "speaker: text" lines. */
export function splitTurns(turns: { speaker: string; text: string; start_ms: number | null }[]) {
  const statements: { speaker_label: string; text: string; start_ms: number | null }[] = [];
  for (const t of turns) for (const s of sentences(t.text)) { const c = clean(s); if (c.length > 2) statements.push({ speaker_label: t.speaker, text: c, start_ms: t.start_ms ?? null }); }
  return { statements };
}

// ---------------- extract_facts ----------------
export async function extractFacts(text: string) {
  return withFallback('extract_facts', async () => (await chatJson('extract_facts', M.classify, prompt('extract_facts').text, data('text', text), S.FactsOut)).facts, () => heuristicFacts(text));
}

// ---------------- classify_sensitivity ----------------
export async function classifySensitivity(text: string, ctx: { externalSpeaker?: boolean; externalNames?: string[] } = {}): Promise<Flag[]> {
  const re = regexFlags(text);
  const extra: Flag[] = [];
  for (const n of ctx.externalNames ?? []) if (n.length > 2 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) extra.push({ category: 'outsider_identity', severity: 'medium', reason: `Names an outside participant` });
  const llm = await withFallback('classify_sensitivity', async () => (await chatJson('classify_sensitivity', M.classify, prompt('classify_sensitivity').text,
    `${ctx.externalSpeaker ? 'Speaker is external to the team.\n' : ''}${data('text', text)}`, S.SensOut)).flags, () => keywordFlags(text));
  return mergeFlags(re, llm, extra);
}

// ---------------- verify_contradiction ----------------
export async function verifyContradiction(a: { text: string; value: string; when: string }, b: { text: string; value: string; when: string }, key: string) {
  return withFallback('verify_contradiction', () => chatJson('verify_contradiction', M.judge, prompt('verify_contradiction', { key }).text,
    `Fact A (${a.when}): ${a.value}\n${data('context_a', a.text)}\nFact B (${b.when}): ${b.value}\n${data('context_b', b.text)}`, S.ContradictionOut),
  () => ({ conflict: true, explanation: `Two blocks give different values for ${key}: "${a.value}" vs "${b.value}".`, preferred: (a.when > b.when ? 'a' : 'b') as 'a' | 'b' }));
}

// ---------------- propose_update ----------------
type Sec = { id: string; heading: string; text: string };
export async function proposeUpdate(target: { title: string; sections: Sec[]; facts: { entity: string; attribute: string; value: string }[] }, source: Structured & { text: string }) {
  return withFallback('propose_update', () => chatJson('propose_update', M.compress, prompt('propose_update').text,
    `Target block "${target.title}":\n${target.sections.map((s) => `[section_id=${s.id}] ${s.heading}\n${s.text}`).map((t) => data('target_section', t)).join('\n')}\nNewer source:\n${data('source', source.text.slice(0, 40000))}`, S.UpdateOut),
  () => {
    const changes: { section_id?: string | null; op: 'add' | 'edit' | 'remove'; heading?: string | null; new_text: string }[] = [];
    const notes: string[] = [];
    for (const nf of source.facts) {
      const old = target.facts.find((f) => f.entity === nf.entity && f.attribute === nf.attribute && f.value.toLowerCase() !== nf.value.toLowerCase());
      if (!old) continue;
      const secs = target.sections.filter((s) => s.text.includes(old.value));
      for (const sec of secs) {
        const existing = changes.find((c) => c.section_id === sec.id);
        const base = existing ? existing.new_text : sec.text;
        const nt = base.split(old.value).join(nf.value);
        if (existing) existing.new_text = nt; else changes.push({ section_id: sec.id, op: 'edit', heading: sec.heading, new_text: nt });
      }
      if (secs.length) notes.push(`${nf.entity} ${nf.attribute}: ${old.value} → ${nf.value}`);
    }
    return { changes, rationale: notes.length ? `Newer source changes ${notes.join('; ')}` : 'No outdated content found' };
  });
}

// ---------------- draft_block / merge / quality ----------------
export async function draftBlock(queries: string[], related: string[]): Promise<Structured> {
  return withFallback('draft_block', () => chatJson('draft_block', M.compress, prompt('draft_block').text,
    `Agent requests:\n${queries.map((q) => '- ' + q).join('\n')}\n${related.map((r) => data('related', r)).join('\n')}`, S.CompressOut),
  () => {
    const kw = topKeywords(queries.join(' '), 4);
    return {
      title: cap(kw.join(' ')) || 'New topic', summary: `Draft block: agents asked about this ${queries.length} times and no block covered it.`,
      sections: [{ heading: 'What agents asked', text: queries.slice(0, 10).map((q) => '- ' + q).join('\n') }, { heading: 'Answer', text: 'TODO: fill in the process, owners and links.' }],
      facts: [], decisions: [], open_questions: queries.slice(0, 5),
    };
  });
}
export function topKeywords(text: string, n: number) {
  const f = new Map<string, number>();
  for (const w of wordTokens(text)) if (w.length > 3 && !STOPW.has(w) && !/^(what|when|where|which|about|does|how|need|context|task|please|with|from|that|this|have)$/.test(w)) f.set(w, (f.get(w) ?? 0) + 1);
  return [...f.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}
export async function mergeBlocks(a: Structured, b: Structured) {
  return withFallback('merge_blocks', () => chatJson('merge_blocks', M.compress, prompt('merge_blocks').text,
    `${data('block_a', JSON.stringify(a))}\n${data('block_b', JSON.stringify(b))}`, S.MergeOut),
  () => {
    const secs = [...a.sections];
    for (const s of b.sections) if (!secs.some((x) => x.heading.toLowerCase() === s.heading.toLowerCase() && x.text === s.text)) secs.push(s);
    const facts = [...a.facts]; for (const f of b.facts) if (!facts.some((x) => x.entity === f.entity && x.attribute === f.attribute && x.value === f.value)) facts.push(f);
    return { title: a.title, summary: a.summary, sections: secs, facts, decisions: [...new Set([...a.decisions, ...b.decisions])], open_questions: [...new Set([...a.open_questions, ...b.open_questions])] };
  });
}
export async function rewriteForQuality(s: Structured, ignoredTasks: string[]) {
  return withFallback('quality_rewrite', () => chatJson('quality_rewrite', M.compress, prompt('quality_rewrite').text,
    `Tasks where it was ignored:\n${ignoredTasks.map((t) => '- ' + t).join('\n')}\n${data('block', JSON.stringify(s))}`, S.CompressOut),
  () => ({ ...s, sections: s.sections.map((x) => ({ ...x, text: sentences(x.text).slice(0, 3).join('\n') })) }));
}

// ---------------- sealed_answer / judge_answer ----------------
export type AnswerPolicy = 'facts_only' | 'yes_no' | 'summary';
const POLICY_TEXT: Record<AnswerPolicy, string> = {
  facts_only: 'Answer with only the minimal fact(s) needed, in at most 2 short sentences, in your own words. Never quote the material.',
  yes_no: 'Answer with exactly one word: yes, no, or unknown.',
  summary: 'Give a brief paraphrased summary (at most 3 sentences). Never quote the material.',
};
export async function sealedAnswer(question: string, sealed: string[], policy: AnswerPolicy, strict = false) {
  return withFallback('sealed_answer', () => chatJson('sealed_answer', M.sealed,
    prompt('sealed_answer', { policy_instructions: POLICY_TEXT[policy], strict: strict ? ' STRICT MODE: a previous answer revealed too much. Give the shortest possible answer, or refuse.' : '' }).text,
    `Question: ${question}\n${sealed.map((s) => data('confidential', s)).join('\n')}`, S.SealedOut),
  () => heuristicSealed(question, sealed, policy), true);
}
function overlapScore(q: string, s: string) {
  const qs = new Set(wordTokens(q).filter((w) => w.length > 2 && !STOPW.has(w)).map((w) => w.replace(/s$/, '')));
  const ss = wordTokens(s).map((w) => w.replace(/s$/, ''));
  let hit = 0; for (const w of new Set(ss)) if (qs.has(w)) hit++;
  return qs.size ? hit / qs.size : 0;
}
function heuristicSealed(question: string, sealed: string[], policy: AnswerPolicy) {
  const sents = sealed.flatMap(sentences);
  const best = sents.map((s) => ({ s, score: overlapScore(question, s) })).sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 0.34) return { answer: '', refused: true, refusal_reason: 'The sealed material does not cover this question.' };
  if (policy === 'yes_no') return { answer: /\b(no|not|never|don't|doesn't|isn't)\b/i.test(best.s) ? 'no' : 'yes', refused: false };
  const f = heuristicFacts(best.s)[0];
  if (f) return { answer: `${cap(`${f.entity} ${f.attribute}`.replace(/\bvalue$/, '').trim())}: ${f.value}.`, refused: false };
  return { answer: '', refused: true, refusal_reason: 'Cannot answer without quoting restricted material.' };
}
export async function judgeAnswer(question: string, answer: string, sealed: string[], policy: AnswerPolicy) {
  return withFallback('judge_answer', () => chatJson('judge_answer', M.judge, prompt('judge_answer', { policy }).text,
    `Question: ${question}\nAnswer: ${answer}\n${sealed.map((s) => data('confidential', s)).join('\n')}`, S.JudgeOut),
  () => ({ reveals_more_than_needed: sentences(answer).length > 3 || answer.split(/\s+/).length > 60, quoted_spans: [], reason: 'heuristic length check' }), true);
}

// ---------------- parse_rule_command ----------------
export async function parseRuleCommand(text: string, now = new Date()) {
  const heuristic = () => {
    const t = text.trim();
    let visibility: any = null, access_mode: any = null, embargo_until: string | null = null, expires_at: string | null = null;
    if (/\b(private|only me|just me)\b/i.test(t)) visibility = 'private';
    else if (/\bteam[- ]only\b|\bonly (the )?team\b/i.test(t)) visibility = 'team';
    else if (/\bpartners?\b/i.test(t)) visibility = 'partner';
    else if (/\bpublic\b/i.test(t)) visibility = 'public';
    if (/\bseal(ed)?\b/i.test(t)) access_mode = 'sealed_use';
    else if (/\bagent[- ]only\b/i.test(t)) access_mode = 'agent_only';
    else if (/\bviewable\b/i.test(t)) access_mode = 'viewable';
    const d = chrono.parse(t, now, { forwardDate: true })[0];
    if (d) { const iso = d.start.date().toISOString(); if (/\b(expire|expiry|delete|until.*then remove)\b/i.test(t) && !/\bembargo\b/i.test(t)) expires_at = iso; else embargo_until = iso; }
    let ref = t.replace(/^\s*(please\s+)?(embargo|hide|lock|seal|make|set|mark|expire|share)\s+/i, '');
    if (d) ref = ref.replace(d.text, '');
    ref = ref.replace(/\b(until|till|to|as|be|on|at|from|after|for|private|team[- ]only|partners?|public|sealed?|agent[- ]only|viewable|expire[sd]?)\b/gi, ' ')
      .replace(/\b(the|block|part|section|doc|document)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return { target_ref: ref, visibility, embargo_until, expires_at, access_mode };
  };
  const r = await withFallback('parse_rule_command', () => chatJson('parse_rule_command', M.classify, prompt('parse_rule_command', { now: now.toISOString() }).text,
    data('command', text), S.RuleCmdOut), heuristic);
  return r;
}
