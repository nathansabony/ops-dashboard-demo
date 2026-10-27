// Variance rules, edited from the tab instead of from a file.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The owner, 2026-08-26: *"each category has its own system, some are seasonal, you
// know, with all the previous rules that we had… I want the rules to be shown in
// the variance tab by each category, or a thing in the top right that says edit
// variance rules per category, and then it opens a new screen with all the
// categories, and you can edit the rules there."*
//
// Every knob in services/varianceConfig.js has always been described as "a knob —
// edit and reload; the tab picks it up". True, but only for whoever has the repo,
// a deploy, and ten minutes. Meanwhile the rules are the part of this tab that
// gets argued about in every review: is 15% right for water, should insurance
// still be quiet for 60 days, is a $0 turnover month worth a card. Those are
// The owner's and the regional manager's calls to make while looking at the list, not a pull
// request.
//
// So the DEFAULTS stay in varianceConfig.js — that file remains the documented
// model, and every value here is a diff against it — and this stores the edits.
// Shared on disk like variance-resolutions.json, for the same reason: a rule
// somebody tunes in their browser and nowhere else is not the tab's rule, it is
// their private opinion of it, and the next person's list disagrees.
//
// ── WHAT IS DELIBERATELY NOT EDITABLE ────────────────────────────────────────
// `glRefs` — which GL accounts a line IS. That is not a rule, it is the
// definition of the number, and changing it from a browser would silently
// re-base every figure on the tab against the P&L export it is reconciled to
//. It stays in code, where a change gets a full
// recompute and a check run. `key`, `label` and `group` are structural for the
// same reason.
//
// Everything crossing this boundary is browser input, so nothing is trusted:
// unknown fields are dropped, every value is range-checked, and a file that
// fails to parse degrades to "no overrides" rather than taking the tab down.
// Losing an edit is a nuisance; a 500 in the Variance tab is an outage.

const fs = require('fs');
const path = require('path');
const varianceConfig = require('./varianceConfig');

// Overridable so a test can point at a scratch file rather than the team's real
// tuning — scripts/checkVarianceRules.js runs the whole round-trip for real.
const FILE = process.env.VARIANCE_RULES_FILE || path.join(__dirname, '..', 'data', 'variance-rules.json');
const MAX_WHO = 120;
const MAX_WHY = 700;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── The editable surface ────────────────────────────────────────────────────
// This table is the single source of truth for what can be changed, what the
// bounds are, and how the field is described — the server validates against it
// and the editor screen is BUILT from it, so a new knob becomes editable by being
// added here and nowhere else. `label`/`help` are the words that appear on the
// editor and in the per-category rules box.
const FIELDS = {
  enabled: {
    type: 'bool', label: 'Tracked',
    help: 'Off means this line still shows on the grid and still ties to the P&L — it just never raises a flag.',
  },
  // Per-line checks (2026-10-06): each kind of flag can be switched off on its own
  // line — e.g. watch a line for negatives but not for month-over-month swings.
  flagVariance: {
    type: 'bool', label: 'Check: month-over-month variance',
    help: 'A real move against the month before it that also lands outside the line’s own 12-month range.',
  },
  flagNegative: {
    type: 'bool', label: 'Check: negative postings',
    help: 'A credit / reversal on this line (under the global “ignore credits under” floor is always ignored).',
  },
  direction: {
    type: 'enum', values: ['rise', 'drop', 'both'], label: 'Flag when it moves',
    valueLabels: { rise: 'up only', drop: 'down only', both: 'either way' },
    help: 'On a cost line a rise is the problem; a drop is usually a bill that has not posted yet.',
  },
  urgency: {
    type: 'enum', values: ['critical', 'high', 'watch', 'info'], label: 'Tier',
    valueLabels: { critical: '🔴 Critical', high: '🟠 High', watch: '🟡 Watch', info: '🔵 Info' },
    help: 'Where a flag on this line lands in the list before materiality demotes it.',
  },
  pct: {
    type: 'pct', min: 0.01, max: 5, label: 'Move of at least',
    help: 'Step 1: how far the month has to move against the month before it.',
  },
  redPct: {
    type: 'pct', min: 0.01, max: 10, nullable: true, label: 'Red at',
    help: 'A move this big is Critical rather than Watch. Blank = never red on percentage alone.',
  },
  minImpact: {
    type: 'money', min: 0, max: 5000000, label: 'And at least ($/yr)',
    help: 'The dollar floor, annualized (the monthly change × 12), so a big percentage of small money stays quiet.',
  },
  monthAbs: {
    type: 'money', min: 0, max: 5000000, nullable: true, label: 'Single month at or above',
    help: 'Major-repairs style: one big month is the whole test, with no month-over-month maths and no averaging.',
  },
  postingGateDays: {
    type: 'int', min: 0, max: 180, nullable: true, label: 'Quiet for (days after month-end)',
    help: 'Accounting posts and trues these up late, so a month inside this window is not tracked at all. 0 = track immediately.',
  },
  zeroRunMonths: {
    type: 'int', min: 0, max: 12, nullable: true, label: '$0 flags after (months in a row)',
    help: 'A single quiet month is fine on some lines; this many silent months in a row is not. Blank = a blank month is judged by the "normally present" test instead.',
  },
  flagZero: {
    type: 'bool', label: 'Flag a blank month',
    help: 'Only ever fires on a line that normally carries a value — read from the data, not assumed.',
  },
  negCompareYoY: {
    type: 'bool', label: 'Compare credits to last year',
    help: 'Renewal credits repeat annually. A credit close to the same month last year is the normal pattern and is not flagged; one way out of line still is.',
  },
  trendYoY: {
    type: 'bool', label: 'Check: year-over-year run-rate trend',
    help: 'The last 12 months against the 12 before, and the 12 before that — a multi-year view (the P&L pull holds a rolling 36 months). Flags a run rate that grew past the global trend threshold.',
  },
  billsOnCycle: {
    type: 'bool', label: 'Bills on a cycle (quarterly etc.)',
    help: 'Spikes on a schedule are this line’s bill, not an event: an on-schedule, usual-size spike is labelled the billing cycle (one tier lower), and a due bill that never posted is flagged.',
  },
  zeroOkMonths: {
    type: 'months', label: '$0 is normal in',
    help: 'Seasonal exemption — heat is off all summer, so a blank there is the building working, not a posting hole.',
  },
  why: {
    type: 'text', max: MAX_WHY, label: 'What this line is watching for',
    help: 'The sentence shown on the flag card and in the rules box. Say what a flag here usually turns out to be.',
  },
};

// Global knobs that apply to every line. Small on purpose: these are the ones
// that get retuned in a review ("nothing under $300 flags").
const MODEL_FIELDS = {
  flagWindowMonths: {
    type: 'int', min: 1, max: 24, label: 'Only flag the last … complete months',
    help: 'Flags are raised only inside this window. Older months still serve as the comparison and the normal range; they just never raise a card of their own.',
  },
  negMinAbs: {
    type: 'money', min: 0, max: 100000, label: 'Ignore credits under',
    help: 'A negative smaller than this is rounding noise: no flag, no colour, on any line.',
  },
  abnormalZ: {
    type: 'num', min: 0.25, max: 6, label: 'Step 2 — standard deviations from normal',
    help: 'After a real move, the new value must sit at least this far outside the line’s own trailing-12 range. Lower catches more; higher is quieter.',
  },
  // Credit-back and new-run-rate readings on jump flags (2026-10-06).
  creditBackMonths: {
    type: 'int', min: 1, max: 6, label: 'Credit back — look … months after a jump',
    help: 'After a jump flags, the following months are checked for a credit (a negative month) or a month below the pre-jump level that gives some of the jump back.',
  },
  creditBackNotePct: {
    type: 'pct', min: 0.01, max: 1, label: 'Credit back — note it at',
    help: 'When at least this share of the jump came back, the flag carries a note: “$X credited back in <month> — net change $Y”.',
  },
  creditBackMostPct: {
    type: 'pct', min: 0.05, max: 1, label: 'Credit back — one tier lower at',
    help: 'When at least this share of the jump came back, the flag drops one tier and is tagged “credited back”. It still shows, so the credit gets confirmed.',
  },
  creditBackClears: {
    type: 'bool', label: 'Credited back — clear the flag',
    help: 'When a credit posts in the months after a jump and roughly cancels it (it gives back the share above, up to 1 ÷ that share), the jump and the credit are one event: neither flags. Both are listed under Resolved as “cleared automatically”.',
  },
  closeDay: {
    type: 'int', min: 1, max: 28, label: 'Books close on day … of the next month',
    help: 'Accounting posts the prior month through this day. Before it, the just-closed month is still being posted: blank months and missed bills there are not raised yet, and its other flags are marked preliminary.',
  },
  reviewDay: {
    type: 'int', min: 1, max: 28, label: 'Monthly review on day …',
    help: 'The day the prior month’s variances are reviewed. Shown at the top of the tab.',
  },
  stepTolerancePct: {
    type: 'pct', min: 0.01, max: 0.5, label: 'New run rate — “same amount” within ±',
    help: 'A month after a jump counts as a repeat of the new amount when it is within this percentage of the jump month.',
  },
  stepRepeatMonths: {
    type: 'int', min: 1, max: 12, label: 'New run rate — after … repeat months',
    help: 'This many following months at the new amount make the jump a rate change (“new run rate since <month>”): it still flags once, one tier lower.',
  },
  demoteOnCycle: {
    type: 'bool', label: 'Billing cycle / season — one tier lower',
    help: 'A jump that is the line’s usual cycle spike at the usual size (quarterly sewer), or a seasonal climb last year made too, still flags — one tier lower, labelled as the cycle.',
  },
  flagMissedCycle: {
    type: 'bool', label: 'Flag a missed cycle bill',
    help: 'When a line bills on a regular cycle and the bill that was due did not post (that month and the next stayed low), flag it with the blank months.',
  },
  irregularMonths: {
    type: 'int', min: 2, max: 12, label: 'Repeated swings — note at … months',
    help: 'When the same line moved abnormally in this many months of the window, its card says so — repeated swings usually mean accrual entries posted and reversed.',
  },
  trendPct: {
    type: 'pct', min: 0.01, max: 2, label: 'Year-over-year trend — grew at least',
    help: 'Lines with the trend check on (payroll, management wages): the last 12 months’ run rate against the 12 before.',
  },
  trendMinImpact: {
    type: 'money', min: 0, max: 5000000, label: 'Year-over-year trend — and at least ($/yr)',
    help: 'The dollar floor for a trend flag (property level; scaled up for entity and portfolio).',
  },
};

// ── validation ──────────────────────────────────────────────────────────────
function coerce(spec, raw) {
  if (raw === null || raw === '' || raw === undefined) {
    if (spec.nullable) return { ok: true, value: null };
    if (spec.type === 'text') return { ok: true, value: '' };
    if (spec.type === 'months') return { ok: true, value: [] };
    return { ok: false, reason: 'this one cannot be left blank' };
  }
  switch (spec.type) {
    case 'bool':
      return { ok: true, value: raw === true || raw === 'true' || raw === 1 || raw === '1' };
    case 'enum':
      return spec.values.includes(String(raw))
        ? { ok: true, value: String(raw) }
        : { ok: false, reason: `must be one of ${spec.values.join(', ')}` };
    case 'months': {
      if (!Array.isArray(raw)) return { ok: false, reason: 'must be a list of months' };
      const out = raw.map(m => String(m).slice(0, 3)).filter(m => MONTHS.includes(m));
      return { ok: true, value: [...new Set(out)] };
    }
    case 'text':
      return { ok: true, value: String(raw).trim().slice(0, spec.max || MAX_WHY) };
    default: {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, reason: 'must be a number' };
      if (spec.type === 'int' && !Number.isInteger(n)) return { ok: false, reason: 'must be a whole number' };
      if (spec.min != null && n < spec.min) return { ok: false, reason: `must be at least ${spec.min}` };
      if (spec.max != null && n > spec.max) return { ok: false, reason: `must be at most ${spec.max}` };
      return { ok: true, value: n };
    }
  }
}

// Clean one browser-supplied patch against a field table. Unknown keys are
// dropped silently (a newer browser posting a field this server does not have is
// not an error), but a KNOWN field with a bad value is rejected loudly — that is
// somebody's edit not taking effect, and it must not fail quietly.
function cleanPatch(patch, fields) {
  const values = {};
  const rejected = [];
  for (const [k, v] of Object.entries(patch || {})) {
    const spec = fields[k];
    if (!spec) continue;
    const got = coerce(spec, v);
    if (!got.ok) { rejected.push(`${spec.label || k}: ${got.reason}`); continue; }
    values[k] = got.value;
  }
  return { values, rejected };
}

// ── store ───────────────────────────────────────────────────────────────────
function emptyStore() { return { items: {}, model: {}, updatedAt: null }; }

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    return {
      items: parsed.items && typeof parsed.items === 'object' ? parsed.items : {},
      model: parsed.model && typeof parsed.model === 'object' ? parsed.model : {},
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch {
    return emptyStore();   // no file yet, or a corrupt one — defaults, never a throw
  }
}

function save(store) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  return store;
}

const validKeys = () => new Set(varianceConfig.rawItems().map(i => i.key));

// Write one category's edits. Only the fields present in the patch move; the rest
// keep whatever they had, so the editor can save one row without resending the
// others and racing a colleague's edit on a different line.
function setItem(key, patch, who) {
  if (!validKeys().has(String(key))) {
    const err = new Error(`"${key}" is not a tracked line.`);
    err.code = 'BAD_KEY';
    throw err;
  }
  const { values, rejected } = cleanPatch(patch, FIELDS);
  if (rejected.length) {
    const err = new Error(rejected.join('; '));
    err.code = 'BAD_VALUE';
    throw err;
  }
  const store = load();
  const prev = store.items[key] || { values: {} };
  const merged = { ...prev.values, ...values };
  // A field set back to its default is not an override — drop it, so the file
  // stays a diff and "changed from default" keeps meaning something.
  const defaults = varianceConfig.rawItems().find(i => i.key === key) || {};
  for (const [k, v] of Object.entries(merged)) {
    if (sameAsDefault(k, v, defaults)) delete merged[k];
  }
  if (!Object.keys(merged).length) delete store.items[key];
  else store.items[key] = { values: merged, by: actor(who), at: new Date().toISOString() };
  store.updatedAt = new Date().toISOString();
  save(store);
  return store;
}

function setModel(patch, who) {
  const { values, rejected } = cleanPatch(patch, MODEL_FIELDS);
  if (rejected.length) {
    const err = new Error(rejected.join('; '));
    err.code = 'BAD_VALUE';
    throw err;
  }
  const store = load();
  const merged = { ...(store.model.values || {}), ...values };
  const defaults = varianceConfig.getConfig().model;
  for (const [k, v] of Object.entries(merged)) {
    if (Number(v) === Number(defaults[k])) delete merged[k];
  }
  if (!Object.keys(merged).length) store.model = {};
  else store.model = { values: merged, by: actor(who), at: new Date().toISOString() };
  store.updatedAt = new Date().toISOString();
  save(store);
  return store;
}

function sameAsDefault(field, value, defaults) {
  const spec = FIELDS[field];
  let base = defaults[field];
  // finalize() fills these in when the item does not carry them, so "same as
  // default" has to compare against the DERIVED default, not against undefined.
  if (field === 'enabled' && base === undefined) base = true;
  if (field === 'direction' && base === undefined) base = defaults.group === 'income' ? 'drop' : 'rise';
  if (field === 'urgency' && base === undefined) base = 'watch';
  if (field === 'flagZero' && base === undefined) base = false;
  if (field === 'negCompareYoY' && base === undefined) base = false;
  if (field === 'flagVariance' && base === undefined) base = true;
  if (field === 'flagNegative' && base === undefined) base = defaults.group !== 'income';
  if (field === 'trendYoY' && base === undefined) base = false;
  if (field === 'billsOnCycle' && base === undefined) base = false;
  if (spec && spec.type === 'months') {
    const a = Array.isArray(base) ? base : [];
    const b = Array.isArray(value) ? value : [];
    return a.length === b.length && a.every(m => b.includes(m));
  }
  if (spec && (spec.type === 'text')) return String(value || '') === String(base || '');
  if (base === undefined || base === null) return value === null || value === undefined;
  return value === base;
}

// Reset one category (or, with no key, everything) back to the file defaults.
function reset(key, who) {
  const store = load();
  if (key) delete store.items[String(key)];
  else { store.items = {}; store.model = {}; }
  store.updatedAt = new Date().toISOString();
  store.lastResetBy = actor(who);
  return save(store);
}

function actor(who) {
  const s = who == null ? '' : String(who).trim();
  return s ? s.slice(0, MAX_WHO) : 'site';
}

// ── the merge ───────────────────────────────────────────────────────────────
// Overrides land on the RAW items and are re-finalized, so an edited line is
// derived exactly like a default one. The payload also carries, per item, WHICH
// fields are overridden and what the default was — that is what lets the editor
// show "15% (was 25%)" and offer a reset, without the browser holding a second
// copy of the defaults that could drift.
function apply(config) {
  const store = load();
  const overridden = {};
  const items = varianceConfig.rawItems().map(raw => {
    const entry = store.items[raw.key];
    if (!entry || !entry.values) return varianceConfig.finalize(raw);
    const defaults = {};
    for (const k of Object.keys(entry.values)) defaults[k] = raw[k] === undefined ? null : raw[k];
    overridden[raw.key] = { fields: Object.keys(entry.values), defaults, by: entry.by || null, at: entry.at || null };
    return varianceConfig.finalize({ ...raw, ...entry.values });
  });

  const model = { ...config.model };
  const modelOverride = store.model && store.model.values ? store.model.values : null;
  if (modelOverride) {
    const defaults = {};
    for (const k of Object.keys(modelOverride)) defaults[k] = config.model[k];
    Object.assign(model, modelOverride);
    overridden._model = { fields: Object.keys(modelOverride), defaults, by: store.model.by || null, at: store.model.at || null };
  }

  return {
    ...config,
    items,
    model,
    // The editor is built from these, so the server stays the only place that
    // knows what is editable and within what bounds.
    editable: { fields: FIELDS, model: MODEL_FIELDS, months: MONTHS },
    overrides: overridden,
    overridesUpdatedAt: store.updatedAt || null,
  };
}

module.exports = { FIELDS, MODEL_FIELDS, MONTHS, load, apply, setItem, setModel, reset, cleanPatch, sameAsDefault, FILE };
