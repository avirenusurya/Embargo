/**
 * Versioned prompt files (Part 10.4): prompts/<task>.v<N>.md. The highest version wins unless PROMPT_<TASK>=vN pins one.
 * A per-job trace records which prompt version (or 'heuristic') produced each output, so it can be stored with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');
const cache = new Map<string, { text: string; version: string }>();

const versionCache = new Map<string, string>();
export function promptVersion(task: string): string {
  const pinned = process.env[`PROMPT_${task.toUpperCase()}`];
  if (pinned) return pinned;
  const hit = versionCache.get(task);
  if (hit) return hit;
  const re = new RegExp(`^${task}\\.v(\\d+)\\.md$`);
  const versions = fs.readdirSync(DIR).map((f) => f.match(re)?.[1]).filter(Boolean).map(Number);
  if (!versions.length) throw new Error(`No prompt file for task ${task} in ${DIR}`);
  const v = `v${Math.max(...versions)}`;
  versionCache.set(task, v);
  return v;
}

export function prompt(task: string, vars: Record<string, string> = {}) {
  const version = promptVersion(task);
  const k = `${task}.${version}`;
  let p = cache.get(k);
  if (!p) {
    const text = fs.readFileSync(path.join(DIR, `${k}.md`), 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
    p = { text, version }; cache.set(k, p);
  }
  return { version: p.version, id: `${task}@${p.version}`, text: p.text.replace(/\{\{(\w+)\}\}/g, (_, n) => vars[n] ?? '') };
}

const trace = new AsyncLocalStorage<Record<string, string>>();
export const notePrompt = (task: string, version: string) => { const t = trace.getStore(); if (t) t[task] = version; };
export const currentPromptVersions = () => { const t = trace.getStore(); return t && Object.keys(t).length ? { ...t } : null; };
/** Runs fn with a fresh prompt-version trace (nested calls share the outer trace). */
export function tracePrompts<T>(fn: () => Promise<T>): Promise<T> { return trace.getStore() ? fn() : trace.run({}, fn); }
