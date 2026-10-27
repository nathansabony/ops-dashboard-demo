// Targets for the Entity Scorecard on Overview (2026-10-20).
//
// The scorecard used to colour each figure against a cutoff written into the
// page, and each column had its own idea of what green meant: a 30% margin read
// red beside a 54% expense ratio reading green on the same row. Now every metric
// has a target and a red line, the same rule colours every cell — at or better
// than target is green, between target and red line is amber, past the red line
// is red — and an admin sets the numbers on the site.
//
// A portfolio default per metric, with per-entity overrides (a building in
// lease-up gets a lower occupancy target). Stored in data/ like the variance
// rules, so everyone sees the same targets.

const fs = require('fs');
const path = require('path');

// SCORECARD_TARGETS_FILE: the check script points this at a scratch file.
const FILE = process.env.SCORECARD_TARGETS_FILE || path.join(__dirname, '..', 'data', 'scorecard-targets.json');

// better: which way is good. target: green at or past it. floor: red past it.
// unit drives how the page prints it. Defaults: the margin, expense-ratio and
// DSCR cutoffs the scorecard already used (BUDGET-BENCHMARKS.md, the 1.25x
// lender floor); occupancy and delinquency match the Portfolio Health alerts.
const METRICS = [
  { key: 'occupancy', label: 'Occupancy', unit: '%', better: 'higher', target: 95, floor: 90 },
  { key: 'delinquency', label: 'Delinquency (% of a month\'s GPR)', unit: '%', better: 'lower', target: 5, floor: 15 },
  { key: 'margin', label: 'NOI margin', unit: '%', better: 'higher', target: 45, floor: 35 },
  { key: 'expRatio', label: 'Expense ratio', unit: '%', better: 'lower', target: 55, floor: 70 },
  { key: 'dscr', label: 'DSCR', unit: 'x', better: 'higher', target: 1.25, floor: 1.0 },
  { key: 'cfPerUnit', label: 'Cash flow per unit per month', unit: '$', better: 'higher', target: 50, floor: 0 },
];
const BY_KEY = Object.fromEntries(METRICS.map(m => [m.key, m]));

function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

// What the page reads: the metric list with the effective defaults, and the
// per-entity overrides as stored.
function load() {
  const saved = readFile();
  const defaults = saved.defaults || {};
  return {
    metrics: METRICS.map(m => ({ ...m, ...pick(defaults[m.key]), defaultTarget: m.target, defaultFloor: m.floor })),
    entities: saved.entities || {},
    updatedAt: saved.updatedAt || null,
    updatedBy: saved.updatedBy || null,
  };
}

function pick(v) {
  if (!v || typeof v !== 'object') return {};
  const out = {};
  if (Number.isFinite(v.target)) out.target = v.target;
  if (Number.isFinite(v.floor)) out.floor = v.floor;
  return out;
}

// A target past its own red line would colour everything wrong; refuse it.
function checkPair(key, t, f) {
  const m = BY_KEY[key];
  if (!Number.isFinite(t) || !Number.isFinite(f)) return `${m.label}: target and red line must both be numbers.`;
  if (m.better === 'higher' ? t < f : t > f) return `${m.label}: the target must be ${m.better === 'higher' ? 'at or above' : 'at or below'} the red line.`;
  return null;
}

// body: { defaults: { metric: {target, floor} }, entities: { name: { metric: {target, floor} } } }
// Replaces the stored targets. Returns { ok, error?, targets? }.
function save(body, who, entityNames) {
  const b = body || {};
  const defaults = {};
  for (const [k, v] of Object.entries(b.defaults || {})) {
    if (!BY_KEY[k]) return { ok: false, error: `Unknown metric "${k}".` };
    const p = { target: Number(v && v.target), floor: Number(v && v.floor) };
    const bad = checkPair(k, p.target, p.floor);
    if (bad) return { ok: false, error: bad };
    // Only what differs from the built-in default is stored, so a later change
    // to a default in code reaches every metric nobody has tuned.
    if (p.target !== BY_KEY[k].target || p.floor !== BY_KEY[k].floor) defaults[k] = p;
  }
  const known = new Set(entityNames || []);
  const entities = {};
  for (const [e, metrics] of Object.entries(b.entities || {})) {
    if (known.size && !known.has(e)) return { ok: false, error: `Unknown entity "${e}".` };
    for (const [k, v] of Object.entries(metrics || {})) {
      if (!BY_KEY[k]) return { ok: false, error: `Unknown metric "${k}".` };
      const p = { target: Number(v && v.target), floor: Number(v && v.floor) };
      const bad = checkPair(k, p.target, p.floor);
      if (bad) return { ok: false, error: `${e} · ${bad}` };
      (entities[e] ||= {})[k] = p;
    }
  }
  const payload = { defaults, entities, updatedAt: new Date().toISOString(), updatedBy: who || null };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(payload, null, 2));
  return { ok: true, targets: load() };
}

module.exports = { FILE, METRICS, load, save, checkPair };
