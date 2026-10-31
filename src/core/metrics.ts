/** In-process Prometheus metrics (Part 22.3). Per-instance counters/histograms; DB-derived gauges are added at scrape time. */
type Labels = Record<string, string | number>;
const counters = new Map<string, Map<string, number>>();
const help = new Map<string, [string, 'counter' | 'histogram' | 'gauge']>();
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const hist = new Map<string, { buckets: number[]; sum: number; count: number }>();

const key = (l: Labels) => Object.entries(l).sort().map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`).join(',');

export function inc(name: string, labels: Labels = {}, by = 1, desc = '') {
  if (!help.has(name)) help.set(name, [desc || name, 'counter']);
  const m = counters.get(name) ?? new Map<string, number>(); counters.set(name, m);
  const k = key(labels); m.set(k, (m.get(k) ?? 0) + by);
}

export function observe(name: string, ms: number, desc = '') {
  if (!help.has(name)) help.set(name, [desc || name, 'histogram']);
  const h = hist.get(name) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; hist.set(name, h);
  BUCKETS.forEach((b, i) => { if (ms <= b) h.buckets[i]++; });
  h.sum += ms; h.count++;
}

export function render(gauges: { name: string; help: string; value: number; labels?: Labels; type?: 'gauge' | 'counter' }[] = []) {
  const out: string[] = [];
  for (const [name, m] of counters) {
    out.push(`# HELP ${name} ${help.get(name)![0]}`, `# TYPE ${name} counter`);
    for (const [k, v] of m) out.push(`${name}${k ? `{${k}}` : ''} ${v}`);
  }
  for (const [name, h] of hist) {
    out.push(`# HELP ${name} ${help.get(name)![0]}`, `# TYPE ${name} histogram`);
    BUCKETS.forEach((b, i) => out.push(`${name}_bucket{le="${b}"} ${h.buckets[i]}`));
    out.push(`${name}_bucket{le="+Inf"} ${h.count}`, `${name}_sum ${h.sum}`, `${name}_count ${h.count}`);
  }
  const seen = new Set<string>();
  for (const g of gauges) {
    if (!seen.has(g.name)) { out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} ${g.type ?? 'gauge'}`); seen.add(g.name); }
    out.push(`${g.name}${g.labels ? `{${key(g.labels)}}` : ''} ${g.value}`);
  }
  return out.join('\n') + '\n';
}
