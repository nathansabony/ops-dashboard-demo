// The Underwriting tab's past deals (2026-10-21).
//
// The owner: "underwriting shows the past deals that were run and the numbers that
// we found based on the property ... with the Excel model attached to open it
// right away." The numbers already sit in every model the generator wrote
// (finish_model.py bakes the computed Dashboard into the file), so a past deal is
// just a generated .xlsx on the Render disk (data/underwriting/) plus a little
// bookkeeping this file keeps in data/underwriting/deals.json:
//
//   models[file] = { card, mtime,          the numbers read back from the model
//                    sources, confirmed_by_hand,   what was dropped, what was judged
//                    hidden: {by, at}|null, imported }
//
// Why a sidecar and not a database: the disk is one 1 GB volume, the deal count
// is tens, and the models themselves are the source of truth - the card cache
// can be thrown away and rebuilt from them (it is, whenever a file's mtime moves).
//
// Everything that decides what a card SAYS lives here as pure functions so
// scripts/checkUnderwritingDeals.js can prove it without Python or Excel:
// the in-place cap rate, the gap to the max price, the grouping of repeat runs.

const fs = require('fs');
const path = require('path');

// A template left unfilled shows "[ADDRESS]" / "[YEAR]" in its Dashboard (the
// Sandy Shores and Willow Bay models do). Those are blanks, not facts.
const isPlaceholder = v => typeof v === 'string' && /^\s*\[[A-Z _]+\]\s*$/.test(v);
const clean = v => (v == null || v === '' || isPlaceholder(v) ? null : v);
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Run date: the generator stamps every file "<slug>-YYYY-MM-DD-HH-MM-SS.xlsx".
// A model copied from another machine keeps that stamp even though the file's
// own mtime is the copy time, so the name wins.
function runDate(file, mtimeMs) {
  file = String(file || '').replace(/(-repaired-[a-z0-9]+)+(?=\.xlsx$)/i, '');     // a repaired copy was RUN when its original was, not when it was repaired
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?=(?:\s*\(\d+\))?\.xlsx$)/i.exec(file);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(mtimeMs).toISOString();
}

// What the card promotes (the owner's "price-test six"): price, units and $/door,
// T12 NOI, in-place cap rate, levered IRR against its target, and the max price
// that still clears the target - with the gap to what the deal was priced at.
//
// The cap rate is OUR estimate: T12 NOI over the model's purchase price. The
// model's price is itself NOI / its purchase cap rate (or an override), so for a
// price-by-cap run this just hands the input back - the card says so (capNote).
// Older cards (and a model whose Dashboard tile is blank) carry cash-on-cash only as the
// scenario table's "Year 2 Cash-on-Cash" row.
function cocFromScenarios(scenarios) {
  const row = (Array.isArray(scenarios) ? scenarios : []).find(s => /cash-on-cash/i.test(String(s && s.scenario)));
  return row ? finite(row.irr) : null;
}

// ── the plausibility gate ───────────────────────────────────────────────────
// 2026-10-22: the board showed Pinecrest Village at 39.8% occupancy, $6,643 a door, Yr-1 NOI -$1.66M and a DSCR of -5.98x, and
// Maple Court at 0% occupied, as if they were deals. A model that builds without error can still be built on inputs that
// cannot support a decision, so every deal is checked against what a real building looks like. A deal that fails is
// marked NEEDS REVIEW with the reasons, on the board card and on the PDF's first page, ranked after every deal that passes,
// and its price and returns are shown as not reliable instead of as numbers.
const GATE = { minOccupancy: 0.5, minPricePerDoor: 30000, maxPricePerDoor: 400000 };
const gMoney = v => (v < 0 ? '−' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
const gPct = v => (v * 100).toFixed(1) + '%';

function reviewReasons(c) {
  const out = [];
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const occ = num(c.occupancy), units = num(c.units), nonRev = num(c.non_revenue_units);
  if (occ != null && occ < GATE.minOccupancy) {
    let t = `Occupancy is ${gPct(occ)}, under the ${Math.round(GATE.minOccupancy * 100)}% this tool treats as a stabilized building.`;
    if (nonRev && units && nonRev < units) {
      const occupied = Math.round(occ * units), rev = units - nonRev;
      t += ` ${nonRev} of the ${units} units are down, model or employee units (not for rent); ${occupied} of the ${rev} revenue units are occupied (${gPct(occupied / rev)}).`;
    }
    out.push(t);
  }
  const ppd = num(c.price_per_door) ?? (num(c.price) && units ? c.price / units : null);
  if (ppd != null && (ppd < GATE.minPricePerDoor || ppd > GATE.maxPricePerDoor)) {
    out.push(`The price run is ${gMoney(ppd)} per unit, outside the $${GATE.minPricePerDoor / 1000}K–$${GATE.maxPricePerDoor / 1000}K range where a price from NOI ÷ cap rate means anything.`);
  }
  const y1 = num(c.year1_noi), noi = num(c.t12_noi);
  if (y1 != null && noi != null && y1 < 0 && noi > 0) out.push(`Year-1 NOI is ${gMoney(y1)} while the T12 NOI is ${gMoney(noi)}: the underwriting turns a profitable T12 into a loss.`);
  const dscr = num(c.dscr);
  if (dscr != null && dscr < 0) out.push(`Year-1 debt coverage is negative (${dscr.toFixed(2)}x).`);
  const em = num(c.equity_multiple);
  if (em != null && em < 0) out.push(`The equity multiple is negative (${em.toFixed(2)}x): the equity is more than lost.`);
  return out;
}

// What would fix a flagged deal, in plain words, for the card, the PDF and Home (2026-10-22: Pinecrest's three flags said what was
// wrong but not what to send). Same inputs as the reasons; at most two lines.
function reviewFix(c) {
  const out = [];
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const occ = num(c.occupancy), units = num(c.units);
  const lowOcc = occ != null && occ < GATE.minOccupancy;
  const ppd = num(c.price_per_door) ?? (num(c.price) && units ? c.price / units : null);
  const oddPrice = ppd != null && (ppd < GATE.minPricePerDoor || ppd > GATE.maxPricePerDoor);
  const y1 = num(c.year1_noi), noi = num(c.t12_noi);
  if (lowOcc) {
    out.push('This is a lease-up, not an in-place deal, and the model prices a building at the income it earns today. To underwrite it, send the asking price and a stabilization plan (what it costs, and how many months, to put the down and vacant units back in service and lease them), or the broker\'s stabilized pro forma. The price shown is only NOI ÷ cap rate, not an ask.');
  } else if (oddPrice) {
    out.push('The price here is derived (T12 NOI ÷ cap rate), not an asking price. Enter the real asking price (Price override on the Inputs tab) and run it again.');
  }
  if (!lowOcc && y1 != null && noi != null && y1 < 0 && noi > 0) {
    out.push('Year-1 NOI falls far below the T12: look on the Pro Forma for a one-time cost, a tax reset or an expense line that does not fit this property, correct it on the Inputs tab, and run it again.');
  }
  const dscr = num(c.dscr), em = num(c.equity_multiple);
  if (!out.length && ((dscr != null && dscr < 0) || (em != null && em < 0))) {
    out.push('The income cannot repay the loan at these terms. Check the loan rate, loan-to-value and the asking price, and the Year-1 NOI on the Pro Forma, then run it again.');
  }
  return out.slice(0, 2);
}

// ── the deal score (2026-10-22) ──────────────────────────────────────────────
// The owner: "give each deal a score", on Home and on every card in the Underwriting
// tab. 0-100 from five things the model already computed, each earning up to its
// weight, using the same letter bands as the portfolio scorecard (A 90, B 80, C 70,
// D 60). The headline is the target IRR, so IRR and "how far over the max price we
// would be paying" carry 60 of the 100:
//   Levered IRR vs its target ........ 35   full marks at or above the target
//   Price against the max that clears  25   full marks at or under it; 0 at 30% over
//   Year-2 cash-on-cash ................ 20   full marks at 8%
//   Equity multiple .................... 10   0 points at 1.0x, full at 2.0x
//   Year-1 DSCR ........................ 10   0 at 1.0x, full at 1.25x
// A deal flagged NEEDS REVIEW gets no score at all: its numbers are not facts. A deal
// whose IRR the model cannot solve scores zero on that line and says it is unsolved.
const SCORE_CONFIG_FILE = path.join(__dirname, '..', 'config', 'deal-score.json');
const SCORE_DEFAULTS = {
  weights: { irr: 25, timing: 15, price: 15, coc: 15, em: 10, dscr: 10, risk: 10 },
  irr: { pointsBelowTargetForZero: 0.06, pointsAboveTargetForFull: 0.10 },
  timing: { byYear: { 3: 1, 4: 0.9, 5: 0.75, 6: 0.6, 7: 0.5, 8: 0.4 }, afterYear8: 0.3, onlyWithRefi: 0.25, neverClears: 0 },
  price: { headroomForFull: 0.2, overpayForZero: 0.3, noSolvedMaxButMeetsTarget: 0.7 },
  coc: { zeroAt: 0.02, fullAt: 0.10 }, em: { zeroAt: 1, fullAt: 2.5 }, dscr: { zeroAt: 1, fullAt: 1.5 },
  risk: { occupancyZeroAt: 0.7, occupancyFullAt: 0.93, needsInputPenaltyEach: 0.2, occupancyShare: 0.5 },
  grades: { A: 85, B: 75, C: 65, D: 55 },
};
let scoreCfgCache = null;
let scoreOverrideFile = null;         // set by the server: data/underwriting/score-config.json on the Render disk (shared, editable on the tab)
function useScoreOverride(file) { scoreOverrideFile = file || null; scoreCfgCache = null; }
const mergeCfg = (d, o) => { const out = {}; for (const k of Object.keys(d)) out[k] = (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k])) ? mergeCfg(d[k], (o && typeof o[k] === 'object' && o[k]) || {}) : (o && typeof o[k] === typeof d[k] && (typeof d[k] !== 'number' || Number.isFinite(o[k])) ? o[k] : d[k]); return out; };
const WEIGHT_KEYS = ['irr', 'timing', 'price', 'coc', 'em', 'dscr', 'risk'];
// Whatever arrives (a hand-edited file, a form) becomes a usable config: unknown keys dropped, bad numbers fall back, the weights
// are scaled to add up to 100 and the grade cut-offs kept in order. A broken input degrades to the defaults, never to a crash.
function sanitizeScoreConfig(input, base) {
  const cfg = mergeCfg(base || scoreBaseConfig(), input && typeof input === 'object' ? input : {});
  const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  for (const k of WEIGHT_KEYS) cfg.weights[k] = num(cfg.weights[k], 0, 100, SCORE_DEFAULTS.weights[k]);
  const sum = WEIGHT_KEYS.reduce((t, k) => t + cfg.weights[k], 0);
  if (sum <= 0) cfg.weights = { ...SCORE_DEFAULTS.weights };
  else if (Math.abs(sum - 100) > 0.001) { WEIGHT_KEYS.forEach(k => { cfg.weights[k] = Math.round(cfg.weights[k] * 100 / sum * 10) / 10; }); }
  const g = cfg.grades;
  if (!(g.A > g.B && g.B > g.C && g.C > g.D && g.D >= 0 && g.A <= 100)) cfg.grades = { ...SCORE_DEFAULTS.grades };
  for (const k of Object.keys(cfg.timing.byYear)) cfg.timing.byYear[k] = num(cfg.timing.byYear[k], 0, 1, 0);
  for (const k of ['afterYear8', 'onlyWithRefi', 'neverClears']) cfg.timing[k] = num(cfg.timing[k], 0, 1, SCORE_DEFAULTS.timing[k]);
  cfg.price.noSolvedMaxButMeetsTarget = num(cfg.price.noSolvedMaxButMeetsTarget, 0, 1, 0.7);
  cfg.risk.occupancyShare = num(cfg.risk.occupancyShare, 0, 1, 0.5);
  cfg.risk.needsInputPenaltyEach = num(cfg.risk.needsInputPenaltyEach, 0, 1, 0.2);
  // each "zero at / full at" pair must run upward, or the curve divides by zero
  for (const k of ['coc', 'em', 'dscr']) if (!(cfg[k].fullAt > cfg[k].zeroAt)) cfg[k] = { ...SCORE_DEFAULTS[k] };
  if (!(cfg.risk.occupancyFullAt > cfg.risk.occupancyZeroAt)) { cfg.risk.occupancyZeroAt = 0.7; cfg.risk.occupancyFullAt = 0.93; }
  if (!(cfg.irr.pointsBelowTargetForZero + cfg.irr.pointsAboveTargetForFull > 0)) cfg.irr = { ...SCORE_DEFAULTS.irr };
  if (!(cfg.price.headroomForFull + cfg.price.overpayForZero > 0)) cfg.price = { ...SCORE_DEFAULTS.price };
  return cfg;
}
// the shipped defaults: this file's built-ins under config/deal-score.json
function scoreBaseConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(SCORE_CONFIG_FILE, 'utf8')); } catch { /* built-ins */ }
  return mergeCfg(SCORE_DEFAULTS, file);
}
function readScoreOverride() {
  if (!scoreOverrideFile) return null;
  try { const j = JSON.parse(fs.readFileSync(scoreOverrideFile, 'utf8')); return j && typeof j === 'object' && j.config ? j : null; } catch { return null; }
}
function scoreConfig() {
  let m1 = 0, m2 = 0;
  try { m1 = fs.statSync(SCORE_CONFIG_FILE).mtimeMs; } catch { /* defaults */ }
  try { if (scoreOverrideFile) m2 = fs.statSync(scoreOverrideFile).mtimeMs; } catch { /* none */ }
  const stamp = m1 + ':' + m2 + ':' + (scoreOverrideFile || '');
  if (scoreCfgCache && scoreCfgCache.stamp === stamp) return scoreCfgCache.cfg;
  const base = scoreBaseConfig();
  const ov = readScoreOverride();
  const cfg = ov ? sanitizeScoreConfig(ov.config, base) : sanitizeScoreConfig(base, base);
  scoreCfgCache = { stamp, cfg };
  return cfg;
}
function scoreConfigInfo() {
  const ov = readScoreOverride();
  return { config: scoreConfig(), defaults: sanitizeScoreConfig(scoreBaseConfig(), scoreBaseConfig()), updated: ov && ov.by ? { by: ov.by, at: ov.at } : null };
}
// shared across everyone with the Underwriting tool: written beside the models on the persistent disk, write-then-rename
function saveScoreConfig(input, who) {
  if (!scoreOverrideFile) throw new Error('No place to save the scoring model');
  const clean = sanitizeScoreConfig(input, scoreBaseConfig());
  fs.mkdirSync(path.dirname(scoreOverrideFile), { recursive: true });
  const tmp = `${scoreOverrideFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ config: clean, by: String(who || 'someone').slice(0, 120), at: new Date().toISOString() }, null, 1));
  fs.renameSync(tmp, scoreOverrideFile);
  scoreCfgCache = null;
  return scoreConfigInfo();
}
function resetScoreConfig() {
  if (scoreOverrideFile) { try { fs.unlinkSync(scoreOverrideFile); } catch { /* already default */ } }
  scoreCfgCache = null;
  return scoreConfigInfo();
}
const SCORE_LABELS = {
  irr: 'Levered IRR vs target', timing: 'How soon the target is hit', price: 'Price vs max that clears target',
  coc: 'Year-2 cash-on-cash', em: 'Equity multiple', dscr: 'Year-1 DSCR', risk: 'Risk and data confidence',
};
const SCORE_ORDER = ['irr', 'timing', 'price', 'coc', 'em', 'dscr', 'risk'];
const SCORE_PARTS = SCORE_ORDER.map(key => ({ key, label: SCORE_LABELS[key], w: SCORE_DEFAULTS.weights[key] }));   // default weights; the live ones are in scoreConfig()
const clamp01 = v => Math.max(0, Math.min(1, v));
const ramp = (v, zero, full) => clamp01((v - zero) / (full - zero));
const dealGrade = (n, cfg) => {
  if (n == null) return null;
  const g = (cfg || scoreConfig()).grades;
  return n >= g.A ? 'A' : n >= g.B ? 'B' : n >= g.C ? 'C' : n >= g.D ? 'D' : 'F';
};

// The earliest plain sale year whose IRR clears the target. Clearing it only at year 8, or only with a refinance, means more
// money to raise, more work and more time, so it earns less than clearing it at year 3 (2026-10-22, The owner).
function timingFraction(c, target, irr, cfg) {
  const t = cfg.timing;
  const rows = (Array.isArray(c.scenarios) ? c.scenarios : []).filter(s => typeof s.irr === 'number' && !/cash-on-cash/i.test(String(s.scenario)));
  if (!rows.length) {
    if (irr == null || irr < target) return { frac: t.neverClears, why: 'the target is not reached' };
    const hy = typeof c.hold_years === 'number' ? c.hold_years : 5;
    return { frac: hy > 8 ? t.afterYear8 : (t.byYear[String(Math.round(hy))] ?? t.afterYear8), why: `reached at the ${hy}-year hold` };
  }
  const plain = rows.map(s => ({ y: (String(s.scenario).match(/^Sale Year (\d+)/i) || [])[1], irr: s.irr })).filter(x => x.y).map(x => ({ y: Number(x.y), irr: x.irr }));
  const hit = plain.filter(x => x.irr >= target).sort((a, b) => a.y - b.y)[0];
  if (hit) return { frac: hit.y > 8 ? t.afterYear8 : (t.byYear[String(hit.y)] ?? t.afterYear8), why: `a plain sale clears the target at year ${hit.y}` };
  if (rows.some(s => s.irr >= target)) return { frac: t.onlyWithRefi, why: 'the target is reached only with a refinance' };
  return { frac: t.neverClears, why: 'no sale or refinance scenario reaches the target' };
}

function scoreDeal(c, cfgOverride) {
  if (!c || c.computed === false) return { score: null, grade: null, parts: [], note: 'The model has no calculated values yet' };
  if (c.needs_review) return { score: null, grade: null, parts: [], note: 'Needs review: not scored' };
  const cfg = cfgOverride || scoreConfig();
  const f = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const target = f(c.irr_target) || 0.16;
  const irr = c.irr_failed ? null : f(c.irr), coc = f(c.coc), em = f(c.equity_multiple), dscr = f(c.dscr), gap = f(c.gap_pct), occ = f(c.occupancy);
  const tm = timingFraction(c, target, irr, cfg);
  const needsInput = f(c.checks && c.checks.needs_input) ?? 0;
  const occFrac = occ == null ? 0 : ramp(occ, cfg.risk.occupancyZeroAt, cfg.risk.occupancyFullAt);
  const chkFrac = clamp01(1 - needsInput * cfg.risk.needsInputPenaltyEach);
  const frac = {
    irr: irr == null ? 0 : ramp(irr, target - cfg.irr.pointsBelowTargetForZero, target + cfg.irr.pointsAboveTargetForFull),
    timing: tm.frac,
    // no solved max price: clearing the target at every price tried is good (not perfect: there is no measured headroom);
    // failing at every price tried is none
    price: gap == null ? (c.meets_target === true ? cfg.price.noSolvedMaxButMeetsTarget : 0)
      : clamp01((gap + cfg.price.overpayForZero) / (cfg.price.overpayForZero + cfg.price.headroomForFull)),
    coc: coc == null ? 0 : ramp(coc, cfg.coc.zeroAt, cfg.coc.fullAt),
    em: em == null ? 0 : ramp(em, cfg.em.zeroAt, cfg.em.fullAt),
    dscr: dscr == null ? 0 : ramp(dscr, cfg.dscr.zeroAt, cfg.dscr.fullAt),
    risk: cfg.risk.occupancyShare * occFrac + (1 - cfg.risk.occupancyShare) * chkFrac,
  };
  const why = {
    irr: irr == null ? 'IRR not solved' : `${(irr * 100).toFixed(1)}% against a ${Math.round(target * 100)}% target`,
    timing: tm.why,
    price: gap == null ? (c.meets_target === true ? 'clears the target at every price tested' : 'no price in the solver range clears the target') : gap >= 0 ? `${(gap * 100).toFixed(0)}% under the max price` : `${(Math.abs(gap) * 100).toFixed(0)}% over the max price`,
    coc: coc == null ? 'not available' : `${(coc * 100).toFixed(1)}% in year 2`,
    em: em == null ? 'not available' : `${em.toFixed(2)}x`,
    dscr: dscr == null ? 'not available' : `${dscr.toFixed(2)}x`,
    risk: `${occ == null ? 'occupancy unknown' : (occ * 100).toFixed(0) + '% occupied'}${needsInput ? `, ${needsInput} model check${needsInput > 1 ? 's' : ''} still need an input` : ', no model checks waiting on an input'}`,
  };
  const parts = SCORE_ORDER.map(key => ({ key, label: SCORE_LABELS[key], weight: cfg.weights[key], points: Math.round(frac[key] * cfg.weights[key] * 10) / 10, why: why[key] }));
  const score = Math.round(parts.reduce((t, p) => t + p.points, 0));
  return { score, grade: dealGrade(score, cfg), parts, note: irr == null ? 'IRR not solved: scored without it' : '' };
}

function shapeCard(raw) {
  if (!raw || raw.error) return { computed: false, error: (raw && raw.error) || 'No card' };
  const price = finite(raw.price), noi = finite(raw.t12_noi), units = finite(raw.units);
  const max = finite(raw.max_price) > 0 ? finite(raw.max_price) : null;   // the solver leaves 0 / "-" when it found none
  let irr = finite(raw.irr);
  const target = finite(raw.irr_target) ?? 0.16;
  // The template's levered IRR is IFERROR(IRR(cash flows), 0): when the equity is never recovered
  // Excel cannot solve for a rate and the model quietly shows 0%. An exact 0 with an equity
  // multiple that is not 1.0x is that failure, not a break-even - 100-106 Maple Court read "0.0%"
  // (and ranked above two deals with negative IRRs) with a cash-on-cash of -21%.
  const irrFailed = raw.irr_failed === true || (irr === 0 && !(finite(raw.equity_multiple) != null && Math.abs(finite(raw.equity_multiple) - 1) < 1e-9));
  if (irrFailed) irr = null;
  const gap = max != null && price ? max - price : null;
  const card = {
    computed: !!raw.computed,
    name: clean(raw.name) || '(unnamed deal)',
    address: clean(raw.address),
    year_built: clean(raw.year_built),
    units,
    occupancy: finite(raw.occupancy),
    avg_rent: finite(raw.avg_rent),
    price,
    price_per_door: finite(raw.price_per_door) ?? (price && raw.units ? price / raw.units : null),
    t12_noi: noi,
    year1_noi: finite(raw.year1_noi),
    capex: finite(raw.capex),
    cap_rate: price && noi != null ? noi / price : null,          // Cedar Ridge estimate
    cap_note: 'T12 NOI / the model\'s purchase price - a Cedar Ridge estimate, not a quoted cap rate',
    irr, irr_target: target, irr_failed: irrFailed,
    meets_target: irrFailed ? false : irr != null ? irr >= target : null,   // an IRR that cannot be solved is not a pass
    equity_multiple: finite(raw.equity_multiple),
    coc: finite(raw.coc) ?? cocFromScenarios(raw.scenarios),   // Year-2 cash-on-cash
    dscr: finite(raw.dscr),
    hold_years: finite(raw.hold_years),
    max_price: max,
    gap_to_max: gap,                                               // negative = priced above what clears the target
    gap_pct: gap != null && price ? gap / price : null,
    checks: raw.checks || {},
    scenarios: Array.isArray(raw.scenarios) ? raw.scenarios : [],
    non_revenue_units: finite(raw.non_revenue_units),
    uncomputed_formulas: finite(raw.uncomputed_formulas),     // formulas the file saved without a value: a model that is not finished
    revenue_units: finite(raw.non_revenue_units) != null && units != null ? units - raw.non_revenue_units : null,
    revenue_occupancy: finite(raw.non_revenue_units) && units && units > raw.non_revenue_units && finite(raw.occupancy) != null ? Math.round(raw.occupancy * units) / (units - raw.non_revenue_units) : null,
  };
  card.review_reasons = reviewReasons(card);
  card.needs_review = card.review_reasons.length > 0;
  card.review_fix = card.needs_review ? reviewFix(card) : [];
  return card;
}

// The same building is often run twice or three times (Willow Bay: three models in
// a day). One card per property, the newest run on it, the others behind a count.
function propertyKey(name) {
  return String(name || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '');
}

// "Best deal" (The owner, 2026-10-22: "ranked in best deal, meaning which had the highest IRR,
// and cash on cash"; then by the deal score, which weighs those two first): the model's headline levered IRR first, Year-2 cash-on-cash to break
// ties, newest run last. A deal with no IRR sorts after every deal that has one.
function bestOrder(a, b) {
  const x = a.latest.card, y = b.latest.card;
  const cmp = (p, q) => (p == null && q == null) ? 0 : p == null ? 1 : q == null ? -1 : q - p;
  if (!!x.needs_review !== !!y.needs_review) return x.needs_review ? 1 : -1;     // flagged deals last, whatever their IRR says
  if ((x.irr == null) !== (y.irr == null)) return x.irr == null ? 1 : -1;     // a deal whose IRR never solved sits after every deal that has one, whatever else it scores
  return cmp(scoreDeal(x).score, scoreDeal(y).score) || cmp(x.irr, y.irr) || cmp(x.coc, y.coc) || b.latest.created.localeCompare(a.latest.created);
}
// Numbers the live properties 1..n in best-deal order (hidden ones get none).
function rankProperties(props) {
  props.filter(p => !p.hidden).sort(bestOrder).forEach((p, i) => { p.rank = i + 1; });
  props.filter(p => p.hidden).forEach(p => { p.rank = null; });
  return props;
}

function groupByProperty(entries) {
  const byKey = new Map();
  for (const e of entries) {
    const key = propertyKey(e.card.name) || e.file;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  const props = [];
  for (const [key, runs] of byKey) {
    runs.sort((a, b) => b.created.localeCompare(a.created));
    const live = runs.filter(r => !r.hidden);
    const latest = (live[0] || runs[0]);
    props.push({
      key, name: latest.card.name, latest,
      runs,                                            // newest first, hidden ones included (the card greys them)
      run_count: live.length,
      hidden: live.length === 0,                       // every run hidden -> the property sits in Hidden deals
    });
  }
  props.sort((a, b) => b.latest.created.localeCompare(a.latest.created));
  return props;
}

// 2 = cards carry cash-on-cash; 3 = an unsolvable IRR (the model shows 0%) reads as n/a;
// 4 = the earlier template's "NM" IRR text reads as unsolved too (2026-10-22)
const CARD_VERSION = 6;

// A rent roll read can hand back "official" counts that its own unit rows contradict - 100-106 Maple Court
// Boulevard (2026-09-03): official occupied = 0 and occupancy = 0%, with 54 of its 56 unit rows carrying a rent
// charge. The generator wrote the 0 into the model as the occupancy, so the model priced a building it thought
// was empty: Year-1 NOI -$534K, IRR unsolvable, a card reading "0% occupied". An official count that is missing,
// is zero while unit rows are occupied, or exceeds the unit count is not an official count; the unit rows are used
// instead and the reader is told. Mutates the rent roll; returns { changed, note }. The page carries the same rule
// (uwOfficialCounts in public/index.html) so the review screen shows what the model will use, and
// scripts/checkUnderwritingDeals.js keeps the two identical.
function reconcileOfficialCounts(rr) {
  if (!rr || !Array.isArray(rr.units) || rr.units.length === 0) return { changed: false, note: null };
  const n = rr.units.length;
  const occN = rr.units.filter(u => u && Number(u.occupied_flag) === 1).length;
  const has = v => typeof v === 'number' && Number.isFinite(v);
  const notes = [];
  if (!has(rr.official_units) || rr.official_units <= 0) {
    rr.official_units = n;
    notes.push(`The rent roll gave no usable official unit count, so the ${n} unit rows are used.`);
  }
  const offOcc = rr.official_occupied_units;
  const occBad = !has(offOcc) || offOcc < 0 || offOcc > rr.official_units || (offOcc === 0 && occN > 0)
    || (has(rr.official_occupancy) && rr.official_occupancy === 0 && occN > 0);
  if (occBad) {
    const was = has(offOcc) ? `${offOcc} occupied` : 'no occupied count';
    rr.official_occupied_units = occN;
    rr.official_vacant_units = Math.max(0, rr.official_units - occN);
    rr.official_occupancy = occN / n;
    notes.push(`The rent roll's official figures (${was}) contradict its own unit rows, which show ${occN} of ${n} occupied; the model uses the unit rows (${(100 * occN / n).toFixed(1)}% occupancy).`);
  }
  return { changed: notes.length > 0, note: notes.length ? notes.join(' ') : null };
}

// "Could not read this workbook: ..." in the words a person can act on
function plainReason(e) {
  const t = String(e || '').replace(/^Could not read this workbook:\s*/i, '');
  if (/Dashboard \/ Inputs/.test(t)) return 'it is not one of the underwriting models (no Dashboard or Inputs tab)';
  if (/empty|not a valid|badzip|zip file|corrupt|xml/i.test(t)) return 'the workbook file is damaged (a cell value could not be read)';
  return t.slice(0, 160) || 'unknown';
}

function createStore({ dir, readCards }) {
  const metaFile = path.join(dir, 'deals.json');
  let meta = null;

  function load() {
    if (meta) return meta;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { meta = null; }
    if (!meta || typeof meta !== 'object' || !meta.models) meta = { version: 1, models: {} };
    return meta;
  }
  function save() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${metaFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 1));
    fs.renameSync(tmp, metaFile);
  }

  // Every .xlsx on the disk is a past deal. Cards are cached against the file's
  // mtime; anything new or changed is read in ONE Python call (openpyxl start-up
  // dominates, not the reading).
  let unreadable = [];
  async function list() {
    const m = load();
    unreadable = [];
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$')) : [];
    const stale = [];
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f));
      const rec = m.models[f];
      // CARD_VERSION: a card shaped by an older version of this file (before it carried cash-on-cash,
      // say) is rebuilt from its model, not served as it was
      if (!rec || rec.mtime !== st.mtimeMs || !rec.card || rec.v !== CARD_VERSION) stale.push({ f, mtime: st.mtimeMs });
    }
    if (stale.length) {
      let cards = {};
      try { cards = await readCards(stale.map(s => path.join(dir, s.f))); } catch (e) { cards = {}; console.error('deal cards:', e.message); }
      for (const s of stale) {
        const raw = cards[path.join(dir, s.f)];
        if (!raw) { unreadable.push({ file: s.f, reason: 'the card reader returned nothing for this file' }); continue; }   // try again next time
        const rec = m.models[s.f] || (m.models[s.f] = {});
        rec.mtime = s.mtime;
        rec.v = CARD_VERSION;
        rec.card = shapeCard(raw);
      }
      save();
    }
    const out = [];
    for (const f of files) {
      const rec = m.models[f];
      if (!rec || !rec.card) { if (!unreadable.some(u => u.file === f)) unreadable.push({ file: f, reason: 'the card reader could not read this file' }); continue; }
      if (rec.card.error) { unreadable.push({ file: f, reason: plainReason(rec.card.error) }); continue; }   // never shown as a deal; named in the board's "could not be read" list
      const st = fs.statSync(path.join(dir, f));
      out.push({
        file: f, size: st.size, created: runDate(f, st.mtimeMs),
        download: `/api/underwriting/download/${encodeURIComponent(f)}`,
        // the PDF report beside the model: the route builds it on first click if an older run never got one
        report: `/api/underwriting/report/${encodeURIComponent(f)}`,
        has_report: fs.existsSync(path.join(dir, f.replace(/\.xlsx$/i, '.pdf'))),
        card: { ...rec.card, deal_score: scoreDeal(rec.card) },
        sources: rec.sources || [],
        confirmed_by_hand: rec.confirmed_by_hand || 0,
        confirmed_fields: rec.confirmed_fields || [],
        imported: !!rec.imported,
        hidden: rec.hidden || null,
      });
    }
    return out;
  }

  function setHidden(file, hide, who) {
    const m = load();
    const rec = m.models[file] || (m.models[file] = {});
    rec.hidden = hide ? { by: who || 'someone', at: new Date().toISOString() } : null;
    save();
    return rec.hidden;
  }

  // What this run was built from, written when the model is generated so the card
  // can say "3 fields confirmed by hand" (The owner: show uncertainty, never guess).
  function setProvenance(file, p) {
    const m = load();
    const rec = m.models[file] || (m.models[file] = {});
    // what the PDF report prints as "how each file was read": kept small and plain on purpose
    rec.sources = (Array.isArray(p.sources) ? p.sources : []).slice(0, 20).map(s => ({
      kind: String((s && s.kind) || '').slice(0, 20), filename: String((s && s.filename) || '').slice(0, 200), method: String((s && s.method) || '').slice(0, 120),
      warnings: Number.isFinite(s && s.warnings) ? s.warnings : undefined, pages: Number.isFinite(s && s.pages) ? s.pages : undefined,
      notes: (Array.isArray(s && s.notes) ? s.notes : []).slice(0, 6).map(n => String(n).slice(0, 300)),
    }));
    rec.confirmed_by_hand = Math.max(0, Math.round(p.confirmed_by_hand || 0));
    rec.confirmed_fields = Array.isArray(p.confirmed_fields) ? p.confirmed_fields.slice(0, 40).map(String) : [];
    if (p.imported) rec.imported = true;
    save();
  }

  // A repaired copy is a new file, and its record used to say only "repaired copy of X" - the T12, rent roll and OM names the
  // original was built from were lost on the board and on the PDF (found 2026-10-22 after repairing 13 models). A repaired copy takes
  // its original's sources, and its PDF is rebuilt so it cites them. Safe to run at every boot; returns how many records it changed.
  const isRepairNote = s => !!s && s.kind === 'model' && /repaired copy/i.test(s.method || '');
  function inheritRepairedProvenance() {
    const m = load();
    let changed = 0;
    for (let pass = 0; pass < 4; pass++) {          // a copy of a copy takes its source's sources once those are healed
      let any = false;
      for (const rec of Object.values(m.models)) {
        const s = rec.sources || [];
        if (s.length !== 1 || !isRepairNote(s[0])) continue;
        const from = m.models[s[0].filename];
        const fromSources = (from && from.sources) || [];
        if (!fromSources.length || (fromSources.length === 1 && isRepairNote(fromSources[0]))) continue;
        rec.sources = fromSources.map(x => Object.assign({}, x));
        rec.repaired_from = s[0].filename;
        rec.confirmed_by_hand = from.confirmed_by_hand || 0;
        rec.confirmed_fields = (from.confirmed_fields || []).slice();
        rec.imported = !!from.imported;
        rec.report = { v: 0 };                       // the PDF was built from the old record: rebuild it
        changed++; any = true;
      }
      if (!any) break;
    }
    if (changed) save();
    return changed;
  }

  function provenanceOf(file) {
    const r = load().models[file];
    return r ? { sources: r.sources || [], confirmed_by_hand: r.confirmed_by_hand || 0, confirmed_fields: r.confirmed_fields || [], imported: !!r.imported } : null;
  }
  function reportMeta(file) { const r = load().models[file]; return (r && r.report) || null; }
  function markReport(file, meta) {
    const m = load();
    (m.models[file] || (m.models[file] = {})).report = meta;
    save();
  }

  function problems() { return unreadable.map(u => Object.assign({}, u, { hidden: !!((load().models[u.file] || {}).hidden) })).filter(u => !u.hidden); }
  return { list, problems, setHidden, setProvenance, inheritRepairedProvenance, provenanceOf, reportMeta, markReport, metaFile };
}

module.exports = { scoreDeal, dealGrade, scoreConfig, scoreConfigInfo, saveScoreConfig, resetScoreConfig, sanitizeScoreConfig, useScoreOverride, SCORE_PARTS, GATE, reviewReasons, reviewFix, reconcileOfficialCounts, shapeCard, bestOrder, rankProperties, cocFromScenarios, groupByProperty, propertyKey, runDate, createStore, isPlaceholder };
