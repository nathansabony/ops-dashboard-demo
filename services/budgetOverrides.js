// Site-edited budget assumptions — the layer between the code defaults and the
// built set.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// budgetAssumptions.js holds the defaults and the reasoning behind them, and it
// is the durable record: a rate with a comment explaining WHY it is that rate is
// worth more in six months than a number in a JSON file. But changing it means a
// code edit and a deploy, which is useless in a meeting — the whole point of
// sitting with the regional manager is to move a rate, see NOI move, and agree on it there.
//
// So this file owns a thin override layer on the host's persistent disk:
//
//   defaults (code)  →  entity overrides (code)  →  global (site)  →  entity (site)
//
// The site always wins. Anything edited here is meant to be folded back into
// budgetAssumptions.js afterwards WITH the reasoning, at which point it can be
// cleared from this file — the panel marks every value as edited or default so
// it is always obvious which is which.
//
// Everything crossing this boundary is browser input that ends up driving money
// numbers, so nothing is trusted: unknown keys are dropped, every value is
// coerced and clamped to a sane band, and a file that fails to parse degrades to
// "no overrides" rather than taking the Budget tab down.

const fs = require('fs');
const path = require('path');

const A = require('./budgetAssumptions');

const STORE_DIR = path.join(__dirname, '..', 'data', 'budget');
const FILE = path.join(STORE_DIR, 'assumptions.json');

// ── the editable surface ─────────────────────────────────────────────────────
// Only these keys can be set from the browser, each with the band it is allowed
// to sit in. The bands are deliberately wider than anything sensible (someone
// stress-testing "what if insurance went up 40%" should be able to) but narrow
// enough that a fat-fingered 800 instead of 8 can't quietly produce a budget.
const RATE_FIELDS = {
  incomeGrowthPct: { type: 'pct', min: -0.25, max: 0.5, label: 'Income growth' },
  propTaxGrowthPct: { type: 'pct', min: -0.25, max: 0.5, label: 'Property tax growth' },
  insuranceGrowthPct: { type: 'pct', min: -0.25, max: 0.5, label: 'Insurance growth' },
  utilitiesGrowthPct: { type: 'pct', min: -0.25, max: 0.5, label: 'Utilities growth' },
  repairsGrowthPct: { type: 'pct', min: -0.25, max: 0.5, label: 'Repairs & maintenance growth' },
  payrollGrowthPct: { type: 'pct', min: -0.25, max: 0.5, label: 'Payroll growth' },
  generalGrowthPct: { type: 'pct', min: -0.25, max: 0.5, label: 'General expense growth' },
  badDebtPct: { type: 'pct', min: 0, max: 0.25, label: 'Bad debt / collection loss' },
  occupancyTargetPct: { type: 'pct', min: 0.5, max: 1, nullable: true, label: 'Target occupancy' },
  mgmtFeePct: { type: 'pct', min: 0, max: 0.15, label: 'Management fee %' },
  reservesPerUnitYr: { type: 'money', min: 0, max: 5000, label: 'Replacement reserves' },
  contingencyPct: { type: 'pct', min: 0, max: 0.2, label: 'Contingency' },
  mgmtFeeMode: { type: 'enum', values: ['actual', 'pctOfEgi'], label: 'Management fee mode' },
  anchor: { type: 'enum', values: ['calendarYear', 'rolling'], label: 'Budget window' },
  seasonality: { type: 'bool', label: 'Seasonality' },
};

// Lines that can carry a benchmark range or a pin. Derived lines are excluded:
// replacement reserves already IS an assumption ($/unit/yr in the panel), so
// pinning it to a benchmark would be two controls fighting over one number.
function pinnableLines() {
  return A.BUDGET_LINES.filter(l => l.benchmark && !l.derived && l.section !== 'income');
}
function benchmarkLines() {
  return A.BUDGET_LINES.filter(l => l.benchmark);
}

// ── coercion ─────────────────────────────────────────────────────────────────
function num(v) {
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

// Rates are stored as fractions (0.09), but a browser field — or anyone posting
// to the API — may well send "9%" or 9. Both mean nine percent, and clamping 9 to
// the 0.5 ceiling would silently budget 50% insurance inflation. Every rate this
// model uses lives well under 1.0, so anything above it is a percentage that
// hasn't been divided yet.
function pctValue(raw) {
  const looksPercent = typeof raw === 'string' && raw.includes('%');
  const n = num(raw);
  if (n === null) return null;
  return (looksPercent || Math.abs(n) > 1) ? n / 100 : n;
}

// Returns the cleaned value, or undefined when the field should be dropped.
function cleanField(key, raw) {
  const spec = RATE_FIELDS[key];
  if (!spec) return undefined;
  if (spec.type === 'enum') return spec.values.includes(raw) ? raw : undefined;
  if (spec.type === 'bool') return typeof raw === 'boolean' ? raw : undefined;
  if (raw === null || raw === '') return spec.nullable ? null : undefined;
  const n = spec.type === 'pct' ? pctValue(raw) : num(raw);
  if (n === null) return undefined;
  return clamp(n, spec.min, spec.max);
}

function cleanAssumptionBag(bag) {
  const out = {};
  if (!bag || typeof bag !== 'object') return out;
  for (const [k, v] of Object.entries(bag)) {
    const cleaned = cleanField(k, v);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return out;
}

// A benchmark range: [lo, hi] in $/unit/yr or as a fraction of EGI. Reversed
// bounds are swapped rather than rejected — "400 to 300" is a typo with an
// obvious intent, not a reason to throw away the edit.
function cleanRange(raw, metric) {
  if (!Array.isArray(raw) || raw.length !== 2) return undefined;
  let lo = metric === 'pctOfEgi' ? pctValue(raw[0]) : num(raw[0]);
  let hi = metric === 'pctOfEgi' ? pctValue(raw[1]) : num(raw[1]);
  if (lo === null || hi === null) return undefined;
  const cap = metric === 'pctOfEgi' ? 1 : 100000;
  lo = clamp(lo, 0, cap);
  hi = clamp(hi, 0, cap);
  return lo <= hi ? [lo, hi] : [hi, lo];
}

function cleanBenchmarks(bag) {
  const out = {};
  if (!bag || typeof bag !== 'object') return out;
  const byKey = new Map(benchmarkLines().map(l => [l.key, l]));
  for (const [key, val] of Object.entries(bag)) {
    const line = byKey.get(key);
    if (!line || !val || typeof val !== 'object') continue;
    const entry = {};
    if (line.benchmark.perUnitYr) {
      const r = cleanRange(val.perUnitYr, 'perUnitYr');
      if (r) entry.perUnitYr = r;
    }
    if (line.benchmark.pctOfEgi) {
      const r = cleanRange(val.pctOfEgi, 'pctOfEgi');
      if (r) entry.pctOfEgi = r;
    }
    if (Object.keys(entry).length) out[key] = entry;
  }
  return out;
}

// A pin: "stop projecting this line from history, budget it at THIS number".
// Mode has to match the metric the line is benchmarked in, so a $/unit line
// can't be pinned to a percentage.
function cleanPins(bag) {
  const out = {};
  if (!bag || typeof bag !== 'object') return out;
  const byKey = new Map(pinnableLines().map(l => [l.key, l]));
  for (const [key, val] of Object.entries(bag)) {
    const line = byKey.get(key);
    if (!line || !val || typeof val !== 'object') continue;
    const mode = val.mode === 'pctOfEgi' ? 'pctOfEgi' : 'perUnitYr';
    if (!line.benchmark[mode]) continue;
    const v = mode === 'pctOfEgi' ? pctValue(val.value) : num(val.value);
    if (v === null || v <= 0) continue;
    out[key] = { mode, value: clamp(v, 0, mode === 'pctOfEgi' ? 1 : 100000) };
  }
  return out;
}

function cleanEntities(bag) {
  const out = {};
  if (!bag || typeof bag !== 'object') return out;
  for (const [name, val] of Object.entries(bag)) {
    const entity = String(name).slice(0, 80);
    const cleaned = cleanAssumptionBag(val);
    if (val && typeof val.note === 'string' && val.note.trim()) {
      cleaned.note = val.note.trim().slice(0, 200);
    }
    // A bag holding nothing but a note is still worth keeping — it is how an
    // entity gets flagged "we discussed this one" before the number is settled.
    if (Object.keys(cleaned).length) out[entity] = cleaned;
  }
  return out;
}

function sanitize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    global: cleanAssumptionBag(o.global),
    entities: cleanEntities(o.entities),
    benchmarks: cleanBenchmarks(o.benchmarks),
    pins: cleanPins(o.pins),
    editedAt: typeof o.editedAt === 'string' ? o.editedAt : null,
    editedBy: typeof o.editedBy === 'string' ? o.editedBy.slice(0, 80) : null,
    note: typeof o.note === 'string' ? o.note.slice(0, 500) : null,
  };
}

function empty() { return sanitize({}); }

// ── disk ─────────────────────────────────────────────────────────────────────
function load() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    return empty();
  }
}

function save(raw, who) {
  const clean = sanitize(raw);
  clean.editedAt = new Date().toISOString();
  clean.editedBy = who ? String(who).slice(0, 80) : null;
  fs.mkdirSync(STORE_DIR, { recursive: true });
  // Write-then-rename: a half-written assumptions file read by a rebuild would
  // silently produce a budget nobody chose.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, FILE);
  return clean;
}

function clear() {
  try { fs.unlinkSync(FILE); } catch { /* already gone */ }
  return empty();
}

// ── resolution ───────────────────────────────────────────────────────────────
// The merge order the whole feature rests on. Site beats code, entity beats
// global — so a global 3% with a a rent-controlled city exception at 4% resolves the way
// anyone reading the panel would expect.
function assumptionsFor(entity, overrides) {
  const o = overrides || load();
  return A.assumptionsFor(entity, {
    ...(o.global || {}),
    ...((o.entities || {})[entity] || {}),
  });
}

// Effective benchmark range for a line, site edit beating the published default.
function benchmarkFor(line, overrides) {
  const o = overrides || load();
  const edit = (o.benchmarks || {})[line.key];
  if (!edit) return line.benchmark;
  const merged = { ...line.benchmark, ...edit };
  const parts = [];
  if (merged.perUnitYr) parts.push(`$${Math.round(merged.perUnitYr[0]).toLocaleString()}–$${Math.round(merged.perUnitYr[1]).toLocaleString()}/unit/yr`);
  if (merged.pctOfEgi) parts.push(`${(merged.pctOfEgi[0] * 100).toFixed(1).replace(/\.0$/, '')}–${(merged.pctOfEgi[1] * 100).toFixed(1).replace(/\.0$/, '')}% of EGI`);
  // The label is what the tab and the workbook print, so it has to follow the
  // edited numbers rather than keep quoting the published range.
  merged.label = parts.length ? `${parts.join(' · ')} (edited)` : merged.label;
  return merged;
}

// Which values differ from what the code would have produced — this is what the
// panel's "edited" markers read, and what tells you what to fold back into
// budgetAssumptions.js after a meeting.
function diffFromDefaults(overrides) {
  const o = overrides || load();
  const base = A.DEFAULT_ASSUMPTIONS;
  const changed = {};
  for (const [k, v] of Object.entries(o.global || {})) {
    if (base[k] !== v) changed[k] = { from: base[k], to: v };
  }
  return {
    global: changed,
    entities: o.entities || {},
    benchmarks: o.benchmarks || {},
    pins: o.pins || {},
    count: Object.keys(changed).length
      + Object.keys(o.entities || {}).length
      + Object.keys(o.benchmarks || {}).length
      + Object.keys(o.pins || {}).length,
  };
}

module.exports = {
  FILE,
  RATE_FIELDS,
  load,
  save,
  clear,
  sanitize,
  empty,
  assumptionsFor,
  benchmarkFor,
  diffFromDefaults,
  pinnableLines,
  benchmarkLines,
};
