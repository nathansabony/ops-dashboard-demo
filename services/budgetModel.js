// 12-month budget engine.
//
// Takes each entity's REAL monthly actuals out of the live Rent Manager P&L
// snapshot (services/propertyFinancials.js — Report 45, accrual) and projects them
// forward line by line. Every judgement call it makes comes from
// services/budgetAssumptions.js; nothing is hardcoded here.
//
// The pipeline, in the order BUDGET-TOOL-CONCEPT.md lays it out:
//
//   1. BASE        — trailing-12 actuals per line, per entity (partial months dropped)
//   2. SEASONALIZE — each entity's own monthly shape, so August gas ≠ February gas
//   3. GROW        — per-line annual rate, compounded monthly across the 12 months
//   4. OUTPUT      — the payload the Budget tab renders and the Excel writer writes
//
// The dated Event Calendar and the amortised debt schedule that the 36-month
// model carried are gone — see the note in budgetAssumptions.js for why. A one-off
// over a 12-month window gets typed into the month it lands in.
//
// The output of this file and the Excel workbook are the same numbers: the
// workbook writes live formulas that reproduce exactly this arithmetic, so a
// number on the tab and the same number in the spreadsheet can never disagree
// unless someone edits an assumption in Excel — which is the point.

const A = require('./budgetAssumptions');

const MON_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── month-label plumbing ─────────────────────────────────────────────────────
// The snapshot labels months 'Jan 24'; everything downstream wants 'YYYY-MM'.
function labelToYM(label) {
  const m = /^([A-Za-z]{3})\s+(\d{2,4})$/.exec(String(label || '').trim());
  if (!m) return null;
  const mi = MON_LABEL.findIndex(x => x.toLowerCase() === m[1].toLowerCase());
  if (mi < 0) return null;
  const yr = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return `${yr}-${String(mi + 1).padStart(2, '0')}`;
}
function ymToLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MON_LABEL[m - 1]} ${String(y).slice(2)}`;
}
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
function monthOfYear(ym) { return Number(ym.split('-')[1]) - 1; } // 0-11

// ── small numeric helpers ────────────────────────────────────────────────────
function sum(a) { return a.reduce((s, v) => s + (Number(v) || 0), 0); }
function round(v, to) {
  const n = Number(v) || 0;
  if (!to || to === 1) return Math.round(n);
  return Math.round(n / to) * to;
}
function safeDiv(a, b) { return b ? a / b : 0; }

// ── 1. BASE + ANCHOR ─────────────────────────────────────────────────────────
// Two decisions live here: which months the projection is BUILT from, and which
// month the budget STARTS on.
//
// ── Why the start month matters more than it looks ───────────────────────────
// The obvious choice is to start the horizon the month after the last actual.
// That produces a rolling FORECAST — and it quietly breaks budget-vs-actual
// forever, because the window slides forward every time the snapshot refreshes.
// A month can never close *inside* a window whose start keeps outrunning it, so
// the Actual column would sit empty in perpetuity and we'd be back to typing
// numbers in by hand — the exact thing this tool exists to kill.
//
// A budget is a fixed commitment you then track against. So the default anchors
// Year 1 to the CURRENT CALENDAR YEAR and builds the projection from the prior
// calendar year's actuals: "from 2025's actuals, here is the 2026–2028 budget,
// and here is how 2026 is tracking against it month by month." Months that have
// already closed land inside the window and populate on their own.
//
// `anchor: 'rolling'` restores the forward-looking forecast behaviour for anyone
// who wants a pure look-ahead rather than something to track against.
//
// The current month is always dropped from the base when the snapshot flags it
// partial: a half-posted month reads low, and a low base under-budgets every
// month that follows it.
function resolveWindows(snapshot, baseMonths, anchorMode) {
  const labels = Array.isArray(snapshot.months) ? snapshot.months : [];
  const yms = labels.map(labelToYM);
  let lastComplete = labels.length - 1;
  if (snapshot.partialCurrentMonth) lastComplete -= 1;
  if (lastComplete < 0) return null;

  const idxByYM = new Map(yms.map((ym, i) => [ym, i]));
  let baseEndIdx = lastComplete;
  let startYM;

  if (anchorMode === 'rolling') {
    startYM = addMonths(yms[lastComplete], 1);
  } else {
    // Calendar-year anchor, taken from the DATA's own latest complete month
    // rather than the wall clock, so the same snapshot always builds the same
    // budget no matter when it is rendered.
    const anchorYear = Number(yms[lastComplete].split('-')[0]);
    startYM = `${anchorYear}-01`;
    // Base on the prior calendar year where the snapshot carries it; otherwise
    // fall back to whatever complete months we do have.
    const wantEnd = `${anchorYear - 1}-12`;
    const wantIdx = idxByYM.get(wantEnd);
    baseEndIdx = (wantIdx !== undefined && wantIdx >= 0) ? Math.min(wantIdx, lastComplete) : lastComplete;
    // Too little history before the anchor to build a base — use the trailing
    // window instead of projecting off two or three months.
    if (baseEndIdx < baseMonths - 1) baseEndIdx = lastComplete;
  }

  const firstIdx = Math.max(0, baseEndIdx - baseMonths + 1);
  return {
    firstIdx,
    lastIdx: baseEndIdx,
    lastCompleteIdx: lastComplete,
    indices: Array.from({ length: baseEndIdx - firstIdx + 1 }, (_, i) => firstIdx + i),
    months: yms.slice(firstIdx, baseEndIdx + 1),
    labels: labels.slice(firstIdx, baseEndIdx + 1),
    endYM: yms[baseEndIdx],
    startYM,
    anchorMode: anchorMode === 'rolling' ? 'rolling' : 'calendarYear',
    allYms: yms,
  };
}

// ── 2. SEASONALIZE ───────────────────────────────────────────────────────────
// A 12-element index (mean 1.0) describing the line's own within-year shape.
// Built from up to 24 trailing complete months so each calendar month has two
// observations where history allows — one lumpy year alone makes a jumpy index.
//
// Damping pulls every index toward 1.0. It exists because a single annual bill in
// one month produces a 12× index off one observation; halving the distance keeps
// the real shape (a February water bill still lands in February) while trimming
// the part of the spike that is just "we only saw it once". Damping never changes
// an annual total — the indices are renormalised to mean 1.0 afterwards.
function seasonalIndex(series, allYms, lastIdx, assumptions) {
  const flat = Array.from({ length: 12 }, () => 1);
  if (!assumptions.seasonality) return { index: flat, observations: 0, damping: 0 };

  const firstIdx = Math.max(0, lastIdx - 24 + 1);
  const buckets = Array.from({ length: 12 }, () => []);
  for (let i = firstIdx; i <= lastIdx; i++) {
    const ym = allYms[i];
    if (!ym) continue;
    buckets[monthOfYear(ym)].push(Number(series[i]) || 0);
  }
  const observed = buckets.filter(b => b.length).length;
  if (observed < 12) return { index: flat, observations: observed, damping: 0 };

  // A line that nets to ~zero (or negative) over the window has no meaningful
  // shape — credits and reversals would invert the index. Leave it flat.
  const means = buckets.map(b => safeDiv(sum(b), b.length));
  const overall = safeDiv(sum(means), 12);
  if (!(overall > 0)) return { index: flat, observations: observed, damping: 0 };

  const perMonthObs = Math.min(...buckets.map(b => b.length));
  const damping = assumptions.seasonalityDamping != null
    ? assumptions.seasonalityDamping
    : (perMonthObs >= 2 ? 0.25 : 0.5);

  // raw index → damp toward 1.0 → clamp at 0 → renormalise to mean exactly 1.0
  let idx = means.map(m => Math.max(0, safeDiv(m, overall)));
  idx = idx.map(v => 1 + (v - 1) * (1 - damping));
  const mean = safeDiv(sum(idx), 12);
  idx = mean > 0 ? idx.map(v => v / mean) : flat;

  return { index: idx, observations: observed, perMonthObs, damping };
}

// ── 3. GROW ──────────────────────────────────────────────────────────────────
// Growth is measured from the CENTRE of the base window, not its end. A 12-month
// average is the average of a year, so it sits 5.5 months before the last base
// month. Getting this wrong under-grows the whole horizon by about half a year of
// inflation.
//
// Measured as a real month distance rather than assuming the horizon starts the
// month after the base ends, because with a calendar-year anchor it may not.
function absMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + (m - 1);
}
function growthOffsetMonths(startYM, baseEndYM, baseMonths) {
  return absMonth(startYM) - (absMonth(baseEndYM) - (baseMonths - 1) / 2);
}
function growthYears(i, offsetMonths) {
  return (offsetMonths + i) / 12;
}

// ── totals + roll-ups, built from already-rounded lines ──────────────────────
// Shared by the per-entity build and the portfolio aggregation so both produce
// totals the same way.
function buildTotals(lines, n, opexKeys, belowKeys) {
  const at = (k, i) => (lines[k] ? Number(lines[k][i]) || 0 : 0);
  const egi = Array.from({ length: n }, (_, i) => at('baseIncome', i) + at('occupancyAdj', i) - at('badDebt', i));
  const totalOpex = Array.from({ length: n }, (_, i) => opexKeys.reduce((s, k) => s + at(k, i), 0));
  const belowNoi = Array.from({ length: n }, (_, i) => belowKeys.reduce((s, k) => s + at(k, i), 0));
  const noi = egi.map((v, i) => v - totalOpex[i]);
  const cashFlow = noi.map((v, i) => v - belowNoi[i]);
  return { egi, totalOpex, noi, belowNoi, cashFlow };
}

// At a 12-month horizon this produces exactly one entry, labelled 'Full Year' —
// the annual column that sits to the right of the twelve months. The loop is kept
// general so the horizon stays a single constant to change rather than a shape
// baked into the engine.
function rollUpYears(lines, totals, monthLabels, horizon) {
  const years = [];
  const single = horizon <= 12;
  for (let y = 0; y * 12 < horizon; y++) {
    const s = y * 12, e = Math.min(horizon, s + 12);
    const slice = arr => sum(arr.slice(s, e));
    const yearLines = {};
    for (const k of Object.keys(lines)) yearLines[k] = slice(lines[k]);
    years.push({
      label: single ? 'Full Year' : `Year ${y + 1}`,
      range: [s, e],
      months: `${monthLabels[s]} – ${monthLabels[e - 1]}`,
      lines: yearLines,
      egi: slice(totals.egi),
      totalOpex: slice(totals.totalOpex),
      noi: slice(totals.noi),
      belowNoi: slice(totals.belowNoi),
      cashFlow: slice(totals.cashFlow),
    });
  }
  return years;
}

// ── Benchmark checks (BUDGET-BENCHMARKS.md) ──────────────────────────────────
// Year-1 $/unit and % of EGI against the published range, so the model says out
// loud where it sits outside the benchmark rather than leaving it to be spotted
// across a printed page in a meeting.
//
// Only lines derived from ACTUALS are checked. A `derived` line (replacement
// reserves, contingency) IS the assumption — flagging $300/unit reserves as
// "above the $250–300 range" because a year of growth was applied to it is noise,
// not a finding.
// `benchmarks` overrides the published range per line (edited on the Budget tab);
// `pins` marks the lines that were budgeted TO their benchmark rather than
// projected from history, so a check can say "in range because you set it there"
// instead of quietly congratulating the model on hitting a number it was handed.
function buildChecks(y1, units, benchmarks, pins) {
  const checks = [];
  if (!y1) return checks;
  for (const line of A.BUDGET_LINES) {
    const bench = (benchmarks && benchmarks[line.key]) || line.benchmark;
    if (!bench || line.derived || !y1.lines[line.key]) continue;
    const amt = y1.lines[line.key];
    const pinned = Boolean(pins && pins[line.key]);
    if (bench.perUnitYr && units) {
      const perUnit = amt / units;
      const [lo, hi] = bench.perUnitYr;
      checks.push({
        key: line.key, label: line.label, metric: '$/unit/yr',
        value: Math.round(perUnit), range: [lo, hi], rangeLabel: bench.label,
        status: perUnit < lo ? 'below' : perUnit > hi ? 'above' : 'in-range',
        pinned,
      });
    }
    if (bench.pctOfEgi && y1.egi) {
      const p = amt / y1.egi;
      const [lo, hi] = bench.pctOfEgi;
      checks.push({
        key: line.key, label: line.label, metric: '% of EGI',
        value: Math.round(p * 1000) / 10, range: [lo * 100, hi * 100], rangeLabel: bench.label,
        status: p < lo ? 'below' : p > hi ? 'above' : 'in-range',
        pinned,
      });
    }
  }
  // NOI margin sanity check — BUDGET-BENCHMARKS.md targets 45–52% for older
  // the county stock; ceiling raised to 55% per the 2026-07-29 budget meeting.
  const margin = safeDiv(y1.noi, y1.egi);
  checks.push({
    key: 'noiMargin', label: 'NOI margin', metric: '% of EGI',
    value: Math.round(margin * 1000) / 10, range: [45, 55],
    rangeLabel: '45–55% target for older OH stock',
    status: margin < 0.45 ? 'below' : margin > 0.55 ? 'above' : 'in-range',
  });
  return checks;
}

// ── 3b. PINS — "budget this line TO this number, not from history" ───────────
// A benchmark is normally only a yardstick: the model projects from actuals and
// the check says whether the result landed inside the published range. A pin
// inverts that for one line — the regional manager says insurance should be running $450/unit,
// and the line becomes $450/unit. NOI moves.
//
// A pin sets the twelve-month TOTAL. The line keeps its own seasonal shape — a
// pinned gas line still spikes in February — and its own growth rate still tilts
// the months inside the year. That is what "we should be running $450" means in a
// budget conversation: a corrected level, not a flat twelfth every month.
//
// Mechanically it is one multiplier per line, chosen so the first twelve months
// add up to the target. Scaling rather than overwriting is what preserves the
// seasonality and the growth curve, and it leaves every tie-out intact: a scaled
// line is still a line, so Total OpEx still equals the sum of its parts and NOI
// still equals EGI − OpEx.
function applyPins(projected, pins, ctx) {
  const log = [];
  if (!pins) return log;
  for (const line of A.BUDGET_LINES) {
    const pin = pins[line.key];
    if (!pin || !projected[line.key]) continue;
    // Income lines are excluded: EGI is already assembled by the time pins run,
    // and pinning an expense to a share of an EGI that the pin itself moved is a
    // circle with no honest answer.
    if (line.section === 'income') continue;

    const value = Number(pin.value) || 0;
    const target = pin.mode === 'pctOfEgi' ? ctx.egiY1 * value : ctx.units * value;
    if (!target) {
      // $/unit with no unit count, or % of an EGI we don't have: say so rather
      // than applying a silent zero.
      log.push({
        key: line.key, label: line.label, mode: pin.mode, value,
        applied: false,
        reason: pin.mode === 'perUnitYr' ? 'no unit count for this entity' : 'no Year-1 EGI to take a percentage of',
      });
      continue;
    }

    let shape = projected[line.key];
    let y1 = sum(shape.slice(0, 12));
    if (!y1) {
      // Nothing to scale (the line is flat zero in the base year) — fall back to
      // the line's own growth curve so the pin still lands on the target.
      const rate = line.growth ? (Number(ctx.assumptions[line.growth]) || 0) : 0;
      shape = ctx.months.map((ym, i) => Math.pow(1 + rate, growthYears(i, ctx.growthOffset)));
      y1 = sum(shape.slice(0, 12));
    }
    if (!y1) continue;

    const scale = target / y1;
    projected[line.key] = shape.map(v => v * scale);
    log.push({
      key: line.key, label: line.label, mode: pin.mode, value,
      applied: true, target, scale,
      wasY1: sum((projected[line.key] || []).slice(0, 12)) / (scale || 1),
    });
  }
  return log;
}

// ── the build ────────────────────────────────────────────────────────────────
/**
 * Build one entity's 12-month budget.
 *
 * @param {object} snapshot  propertyFinancials payload (months/entities/portfolio)
 * @param {string} scopeName entity name, or 'Portfolio'
 * @param {object} opts      { series, units, assumptions, horizonMonths,
 *                             pins, benchmarks }
 */
function buildScopeBudget(snapshot, scopeName, opts = {}) {
  const assumptions = A.assumptionsFor(scopeName, opts.assumptions);
  const horizon = opts.horizonMonths || A.HORIZON_MONTHS;
  const baseMonths = A.BASE_MONTHS;
  const units = Number(opts.units) || 0;

  const series = opts.series
    || (scopeName === 'Portfolio' ? snapshot.portfolio : (snapshot.entities || {})[scopeName]);
  if (!series) return null;

  const win = resolveWindows(snapshot, baseMonths, assumptions.anchor);
  if (!win) return null;

  // Budget months: the horizon from the anchor (see resolveWindows).
  const startYM = win.startYM;
  const months = Array.from({ length: horizon }, (_, i) => addMonths(startYM, i));
  const monthLabels = months.map(ymToLabel);
  const growthOffset = growthOffsetMonths(startYM, win.endYM, baseMonths);

  const pick = key => (Array.isArray(series[key]) ? series[key] : null);
  const baseSlice = key => {
    const s = pick(key);
    return s ? win.indices.map(i => Number(s[i]) || 0) : win.indices.map(() => 0);
  };

  // ── Step 1: base totals + monthly averages, per mapped line ────────────────
  const baseByKey = {};
  for (const line of A.BUDGET_LINES) {
    if (!line.source) continue;
    const vals = baseSlice(line.source);
    baseByKey[line.key] = { monthly: vals, total: sum(vals), avg: safeDiv(sum(vals), vals.length) };
  }

  // The 'otherOpex' plug: actual Total Operating Expense less every mapped
  // operating line. Whatever RM books outside our chart-of-accounts map lands
  // here, so the projected total can never drift from the real total.
  // Repairs & Maintenance displays under belowNoi (2026-07-29 budget meeting) but
  // RM still books it as operating expense, so it's still inside the actual
  // totalExpense this plug ties out to — operatingActual pulls it back in here
  // even though its section moved, so it isn't double-counted (once via this
  // plug, once as its own belowNoi line).
  const mappedOpexKeys = A.BUDGET_LINES
    .filter(l => (l.section === 'opex' || l.operatingActual) && l.source && !l.memo && !l.plug)
    .map(l => l.key);
  {
    const totalExp = baseSlice('totalExpense');
    const plugMonthly = totalExp.map((v, i) =>
      v - mappedOpexKeys.reduce((s, k) => s + (baseByKey[k] ? baseByKey[k].monthly[i] : 0), 0));
    baseByKey.otherOpex = { monthly: plugMonthly, total: sum(plugMonthly), avg: safeDiv(sum(plugMonthly), plugMonthly.length) };
  }

  // ── Step 2 + 3: seasonal shape, then growth, per line ─────────────────────
  const seasonality = {};
  const projected = {};

  function projectLine(line) {
    const base = baseByKey[line.key];
    if (!base) return months.map(() => 0);

    // Planned-only lines (major repairs, capital) start at zero by design — a
    // one-off roof last March is not a monthly run-rate. Real plans get typed
    // into the month they land in.
    if (line.plannedOnly) {
      seasonality[line.key] = { index: Array.from({ length: 12 }, () => 1), observations: 0, damping: 0, plannedOnly: true };
      return months.map(() => 0);
    }

    const srcSeries = line.source ? (pick(line.source) || []) : null;
    const seas = srcSeries
      ? seasonalIndex(srcSeries, win.allYms, win.lastIdx, assumptions)
      : { index: Array.from({ length: 12 }, () => 1), observations: 0, damping: 0 };
    seasonality[line.key] = seas;

    const rate = line.growth ? (Number(assumptions[line.growth]) || 0) : 0;
    return months.map((ym, i) =>
      base.avg * (line.seasonal ? seas.index[monthOfYear(ym)] : 1) * Math.pow(1 + rate, growthYears(i, growthOffset)));
  }

  for (const line of A.BUDGET_LINES) {
    if (line.derived) continue;
    projected[line.key] = projectLine(line);
  }

  // ── Derived income lines ──────────────────────────────────────────────────
  // Occupancy adjustment: billed income already reflects the entity's real
  // occupancy, so this line only moves when a TARGET occupancy is set — it scales
  // income by (target / trailing actual). Null target ⇒ flat zero.
  const trailingOcc = opts.occupancyPct != null ? Number(opts.occupancyPct) : null;
  const targetOcc = assumptions.occupancyTargetPct;
  projected.occupancyAdj = months.map((ym, i) => {
    if (targetOcc == null || !trailingOcc) return 0;
    return projected.baseIncome[i] * (safeDiv(targetOcc, trailingOcc) - 1);
  });

  // Bad debt: positive here, subtracted when EGI is assembled.
  projected.badDebt = months.map((ym, i) =>
    (projected.baseIncome[i] + projected.occupancyAdj[i]) * (Number(assumptions.badDebtPct) || 0));

  const egi = months.map((ym, i) =>
    projected.baseIncome[i] + projected.occupancyAdj[i] - projected.badDebt[i]);

  // Management fee in 'pctOfEgi' mode is recomputed off income rather than grown
  // off the booked fee. 'actual' (the default) leaves the projection alone.
  if (assumptions.mgmtFeeMode === 'pctOfEgi') {
    projected.mgmtFees = egi.map(v => v * (Number(assumptions.mgmtFeePct) || 0));
  }

  // Pins run here — after the projection and after the management-fee mode (a pin
  // on that line beats the mode), but BEFORE contingency and reserves, so a
  // contingency computed off controllable opex is computed off the pinned values
  // rather than the ones the pin replaced.
  const pinLog = applyPins(projected, opts.pins, {
    units,
    egiY1: sum(egi.slice(0, 12)),
    months,
    assumptions,
    growthOffset,
  });

  // ── Derived expense / below-NOI lines ─────────────────────────────────────
  const controllableKeys = A.BUDGET_LINES
    .filter(l => l.section === 'opex' && !l.memo && !l.derived && !A.UNCONTROLLABLE.has(l.key))
    .map(l => l.key);
  projected.contingency = months.map((ym, i) =>
    controllableKeys.reduce((s, k) => s + (projected[k] ? projected[k][i] : 0), 0) * (Number(assumptions.contingencyPct) || 0));

  projected.reserves = months.map((ym, i) =>
    (units * (Number(assumptions.reservesPerUnitYr) || 0) / 12)
    * Math.pow(1 + (Number(assumptions.generalGrowthPct) || 0), growthYears(i, growthOffset)));

  // ── Rounding, THEN totals ─────────────────────────────────────────────────
  // Order matters. Round every line first and build every total by adding the
  // rounded lines, so the tab, the workbook and a hand-check on a printout all
  // agree to the dollar. Totalling first and rounding after leaves $1-$5 gaps
  // that read as a broken model in a meeting.
  const to = assumptions.roundTo;
  const lines = {};
  for (const line of A.BUDGET_LINES) {
    const vals = projected[line.key] || months.map(() => 0);
    lines[line.key] = vals.map(v => round(v, to));
  }

  const opexKeys = A.BUDGET_LINES.filter(l => l.section === 'opex' && !l.memo).map(l => l.key);
  const belowKeys = A.BUDGET_LINES.filter(l => l.section === 'belowNoi' && !l.memo).map(l => l.key);
  const totals = buildTotals(lines, months.length, opexKeys, belowKeys);

  // ── Annual roll-up (one 'Full Year' column at a 12-month horizon) ─────────
  const years = rollUpYears(lines, totals, monthLabels, horizon);

  // ── Base-year actuals, for the "budget vs the year it came from" comparison ──
  const baseYear = { lines: {}, months: win.labels };
  for (const line of A.BUDGET_LINES) {
    baseYear.lines[line.key] = baseByKey[line.key] ? round(baseByKey[line.key].total, to) : 0;
  }
  const baseIncomeTotal = baseByKey.baseIncome ? baseByKey.baseIncome.total : 0;
  const baseExpenseTotal = sum(baseSlice('totalExpense'));
  baseYear.totalIncome = round(baseIncomeTotal, to);
  baseYear.totalOpex = round(baseExpenseTotal, to);
  baseYear.noi = round(baseIncomeTotal - baseExpenseTotal, to);

  // ── Benchmark checks (BUDGET-BENCHMARKS.md) ───────────────────────────────
  // Year-1 $/unit and % of EGI against the published range, so the model says out
  // loud where it sits outside the benchmark rather than leaving it to be spotted.
  const y1 = years[0];
  const checks = buildChecks(y1, units, opts.benchmarks, opts.pins);

  // ── Actuals alignment, so budget-vs-actual fills itself in as months close ──
  // Every budget month that the live snapshot already carries gets its actual
  // NOI/income/expense attached. On day one this is all nulls (the horizon starts
  // next month); it populates on its own with each monthly refresh — which is the
  // whole point of killing the hand-typed "closed and verified" entry.
  const labelIdx = new Map((snapshot.months || []).map((l, i) => [l, i]));
  const actuals = months.map((ym, i) => {
    const idx = labelIdx.get(monthLabels[i]);
    if (idx === undefined) return null;
    if (snapshot.partialCurrentMonth && idx === (snapshot.months.length - 1)) return null;
    const inc = pick('totalIncome'), exp = pick('totalExpense');
    if (!inc || !exp) return null;
    // Per-line actuals too, so budget-vs-actual can be read line by line rather
    // than only at the NOI level — "we're over budget" is not an action, "we're
    // over budget on water & sewer" is.
    const lineActuals = {};
    for (const line of A.BUDGET_LINES) {
      if (!line.source) continue;
      const s = pick(line.source);
      if (s) lineActuals[line.key] = round(Number(s[idx]) || 0, to);
    }
    return {
      income: round(Number(inc[idx]) || 0, to),
      opex: round(Number(exp[idx]) || 0, to),
      noi: round((Number(inc[idx]) || 0) - (Number(exp[idx]) || 0), to),
      lines: lineActuals,
    };
  });

  // The base each projection was built from, exposed so the workbook's "Base
  // Actuals" tab and the tab's provenance tooltips can show the real trailing-12
  // months rather than asking anyone to take the projection on faith.
  //
  // Emitted UNROUNDED (the snapshot's own 2-decimal values). The workbook writes
  // these cells verbatim and rebuilds the monthly average from them with
  // =SUM(...)/12 — so rounding here would make every Excel formula start from a
  // slightly different base than the engine did, and the two would disagree by a
  // few dollars a month on every line. Display rounding belongs in the view.
  const base = {};
  for (const line of A.BUDGET_LINES) {
    const b = baseByKey[line.key];
    if (!b) continue;
    base[line.key] = {
      monthly: b.monthly,
      total: b.total,
      avg: b.avg,
      perUnitYr: units ? Math.round(b.total / units) : null,
    };
  }

  return {
    base,
    scope: scopeName,
    units,
    generatedAt: new Date().toISOString(),
    basis: 'Accrual',
    horizonMonths: horizon,
    months,
    monthLabels,
    baseWindow: { months: win.labels, from: win.labels[0], to: win.labels[win.labels.length - 1] },
    // Emitted so the workbook's Assumptions tab can fill in occ_trailing. Without
    // it that cell shipped blank, which made the occupancy adjustment a no-op even
    // when a target WAS set — the formula guards on a blank denominator, so it
    // failed quietly rather than visibly.
    occupancyPct: trailingOcc,
    anchor: win.anchorMode,
    growthOffsetMonths: growthOffset,
    assumptions,
    lines,
    totals,
    years,
    baseYear,
    seasonality,
    checks,
    pins: pinLog,
    actuals,
    perUnit: units ? {
      egiY1: Math.round(safeDiv(y1 ? y1.egi : 0, units)),
      opexY1: Math.round(safeDiv(y1 ? y1.totalOpex : 0, units)),
      noiY1: Math.round(safeDiv(y1 ? y1.noi : 0, units)),
    } : null,
  };
}

// ── Portfolio roll-up ────────────────────────────────────────────────────────
// The portfolio budget is the SUM OF THE ENTITY BUDGETS, not a fresh projection
// off the aggregate P&L. Running the engine on aggregate actuals would be
// marginally better statistically (more months, smoother seasonality) but it
// breaks the two things that matter more:
//   • Roll-up integrity — "the portfolio total doesn't equal my entity totals"
//     is the fastest way to lose a room.
//   • Per-entity overrides — a a rent-controlled city 4% rent-control cap or a another city
//     2.5% cap would be averaged away by an aggregate run.
// So: add up the children, then recompute the derived views (years, checks,
// per-unit) off the summed lines.
// Seasonality for a rolled-up scope, as the base-weighted average of the
// children's indices.
//
// This is not cosmetic. The portfolio's own workbook computes each month as
// base × index × growth, so if the index were left flat the workbook would show a
// smooth line while the tab (which sums the children's already-seasonal months)
// showed the real winter gas spike — the two would disagree on screen.
//
// The weighting makes them agree exactly whenever the children share one growth
// rate, because  Σₑ(avgₑ · idxₑ[m] · gᵗ) = gᵗ · Σₑ(avgₑ · idxₑ[m])  and the parent's
// base is Σₑ avgₑ. Per-entity growth overrides (a rent-control cap on one entity)
// break that identity — see growthCohorts() below, which restores it.
function aggregateSeasonality(kids, base) {
  const out = {};
  for (const line of A.BUDGET_LINES) {
    const contributors = kids.filter(b => b.seasonality && b.seasonality[line.key] && b.base && b.base[line.key]);
    if (!contributors.length) continue;
    const weights = contributors.map(b => b.base[line.key].avg || 0);
    const totalWeight = sum(weights);
    const plannedOnly = contributors.every(b => b.seasonality[line.key].plannedOnly);
    if (!totalWeight) {
      out[line.key] = { index: Array.from({ length: 12 }, () => 1), observations: 0, damping: 0, aggregated: true, plannedOnly };
      continue;
    }
    const index = Array.from({ length: 12 }, (_, m) =>
      contributors.reduce((s, b, i) => s + (b.seasonality[line.key].index[m] || 0) * weights[i], 0) / totalWeight);
    out[line.key] = {
      index,
      observations: Math.min(...contributors.map(b => b.seasonality[line.key].observations || 0)),
      damping: null,
      aggregated: true,
      plannedOnly,
    };
  }
  return out;
}

// ── Growth cohorts — what makes a roll-up workbook tie exactly ───────────────
// A roll-up workbook has ONE Assumptions tab, so it can only grow its aggregate
// base at one rate per line. The engine grows each child at ITS OWN rate and adds
// the results. When entities disagree — Willow Creek/Birchwood Commons/Willow Creek budget income at
// 6% against the 5% OH default — those are different numbers, and the gap
// compounds every month.
//
// The fix is to stop pretending there is one rate. Group the children by the rate
// they actually use for a line, and hand the workbook one constant per group per
// calendar month:
//
//     factor_g[m] = Σ_{e ∈ g} (avgₑ · idxₑ[m])  ÷  Σ_all avgₑ
//
// so the workbook can write the line as a sum of real terms:
//
//     base × ( 0.712·POWER(1+inc_growth,t) + 0.288·POWER(1+inc_growth_2,t) )
//
// which is algebraically the engine's own Σₑ(avgₑ · idxₑ[m] · (1+gₑ)ᵗ), exactly.
// Both rates stay live input cells, so the workbook is still a model rather than a
// value dump. With one rate this degenerates to a single term whose factor is the
// weighted index — i.e. exactly what the workbook already wrote — so uniform
// portfolios and every single-entity workbook are untouched.
//
// Emitted only where it is both needed and honest:
//   • the line must be plainly projected as base × index × growth — derived,
//     planned-only and sourceless lines have their own formulas
//   • a pinned line is skipped: each child carries its own pin scale, which is a
//     second per-entity factor this decomposition does not model
//   • management fees in 'pctOfEgi' mode are skipped: that line is recomputed off
//     EGI, not grown off its base
function growthCohorts(kids) {
  const out = {};
  for (const line of A.BUDGET_LINES) {
    if (!line.growth || !line.source || line.derived || line.plannedOnly || line.memo) continue;

    const contributors = kids.filter(b =>
      b.base && b.base[line.key] && b.seasonality && b.seasonality[line.key]
      && Array.isArray(b.seasonality[line.key].index));
    if (contributors.length < 2) continue;

    // Skip the cases where a child's line is not simply base × index × growth.
    const pinned = contributors.some(b => (b.pins || []).some(p => p.key === line.key && p.applied));
    const feeOverride = line.key === 'mgmtFees'
      && contributors.some(b => b.assumptions.mgmtFeeMode === 'pctOfEgi');
    if (pinned || feeOverride) continue;

    const rateOf = b => Number(b.assumptions[line.growth]) || 0;
    const rates = [...new Set(contributors.map(rateOf))];
    if (rates.length < 2) continue;            // uniform — the plain form is exact

    const totalAvg = sum(contributors.map(b => b.base[line.key].avg || 0));
    if (!totalAvg) continue;

    out[line.key] = {
      growthKey: line.growth,
      cohorts: rates.map(rate => {
        const members = contributors.filter(b => rateOf(b) === rate);
        return {
          rate,
          entities: members.map(b => b.scope),
          // One factor per CALENDAR month (0 = January), so the workbook can look
          // it up by the month a column lands on rather than by column order.
          factors: Array.from({ length: 12 }, (_, m) =>
            sum(members.map(b => (b.base[line.key].avg || 0) * (b.seasonality[line.key].index[m] || 0))) / totalAvg),
        };
      }),
    };
  }
  return out;
}

function aggregateBudgets(budgets, scopeName, opts = {}) {
  const kids = budgets.filter(Boolean);
  if (!kids.length) return null;
  const ref = kids[0];
  const n = ref.months.length;

  const lines = {};
  for (const line of A.BUDGET_LINES) {
    lines[line.key] = Array.from({ length: n }, (_, i) =>
      kids.reduce((s, b) => s + ((b.lines[line.key] || [])[i] || 0), 0));
  }

  const opexKeys = A.BUDGET_LINES.filter(l => l.section === 'opex' && !l.memo).map(l => l.key);
  const belowKeys = A.BUDGET_LINES.filter(l => l.section === 'belowNoi' && !l.memo).map(l => l.key);
  const totals = buildTotals(lines, n, opexKeys, belowKeys);
  const years = rollUpYears(lines, totals, ref.monthLabels, n);
  const units = kids.reduce((s, b) => s + (b.units || 0), 0);
  const y1 = years[0];

  const baseYear = { lines: {}, months: ref.baseYear.months };
  for (const line of A.BUDGET_LINES) {
    baseYear.lines[line.key] = kids.reduce((s, b) => s + (b.baseYear.lines[line.key] || 0), 0);
  }
  baseYear.totalIncome = kids.reduce((s, b) => s + (b.baseYear.totalIncome || 0), 0);
  baseYear.totalOpex = kids.reduce((s, b) => s + (b.baseYear.totalOpex || 0), 0);
  baseYear.noi = kids.reduce((s, b) => s + (b.baseYear.noi || 0), 0);

  // An actual month only counts for the portfolio once EVERY entity has closed
  // it — a partial roll-up would read as a portfolio-wide collapse.
  const actuals = Array.from({ length: n }, (_, i) => {
    if (kids.some(b => !b.actuals[i])) return null;
    const lineActuals = {};
    for (const line of A.BUDGET_LINES) {
      if (!line.source) continue;
      lineActuals[line.key] = kids.reduce((s, b) => s + ((b.actuals[i].lines || {})[line.key] || 0), 0);
    }
    return {
      income: kids.reduce((s, b) => s + b.actuals[i].income, 0),
      opex: kids.reduce((s, b) => s + b.actuals[i].opex, 0),
      noi: kids.reduce((s, b) => s + b.actuals[i].noi, 0),
      lines: lineActuals,
    };
  });

  const base = {};
  for (const line of A.BUDGET_LINES) {
    if (!kids.some(b => b.base && b.base[line.key])) continue;
    const monthly = (kids[0].base[line.key].monthly || []).map((_, i) =>
      kids.reduce((s, b) => s + (((b.base[line.key] || {}).monthly || [])[i] || 0), 0));
    const total = kids.reduce((s, b) => s + ((b.base[line.key] || {}).total || 0), 0);
    base[line.key] = {
      monthly, total,
      avg: safeDiv(total, monthly.length || 1),
      perUnitYr: units ? Math.round(total / units) : null,
    };
  }

  return {
    base,
    scope: scopeName,
    units,
    generatedAt: new Date().toISOString(),
    basis: 'Accrual',
    horizonMonths: n,
    months: ref.months,
    monthLabels: ref.monthLabels,
    baseWindow: ref.baseWindow,
    // Carried from the children, not defaulted: the workbook writes its growth
    // exponent from growthOffsetMonths, and the tab prints the anchor. A roll-up
    // that dropped these would silently describe itself as a rolling forecast and
    // grow off the wrong base centre.
    anchor: ref.anchor,
    growthOffsetMonths: ref.growthOffsetMonths,
    assumptions: ref.assumptions,
    aggregatedFrom: kids.map(b => b.scope),
    lines,
    totals,
    years,
    baseYear,
    seasonality: aggregateSeasonality(kids, base),
    // Per-line growth-rate decomposition, so the roll-up workbook reproduces this
    // roll-up exactly instead of growing everything at one child's rate.
    growthCohorts: growthCohorts(kids),
    assumptionsUniform: kids.every(b => JSON.stringify(b.assumptions) === JSON.stringify(ref.assumptions)),
    checks: buildChecks(y1, units, opts.benchmarks, opts.pins),
    // Pins are portfolio-wide, but they land per entity against that entity's own
    // units and EGI — so the roll-up reports the pin once, with the entities it
    // could not be applied to named rather than dropped.
    pins: (ref.pins || []).map(p => ({
      ...p,
      target: kids.reduce((s, b) => s + (((b.pins || []).find(x => x.key === p.key) || {}).target || 0), 0),
      skipped: kids.filter(b => ((b.pins || []).find(x => x.key === p.key) || {}).applied === false).map(b => b.scope),
    })),
    actuals,
    perUnit: units ? {
      egiY1: Math.round(safeDiv(y1 ? y1.egi : 0, units)),
      opexY1: Math.round(safeDiv(y1 ? y1.totalOpex : 0, units)),
      noiY1: Math.round(safeDiv(y1 ? y1.noi : 0, units)),
    } : null,
  };
}

// Build every entity plus the portfolio roll-up.
function buildAll(snapshot, opts = {}) {
  const unitsByEntity = opts.unitsByEntity || {};
  const occupancyByEntity = opts.occupancyByEntity || {};
  const entityAssumptions = opts.entityAssumptions || {};
  const out = { entities: {}, portfolio: null };

  for (const name of Object.keys(snapshot.entities || {})) {
    const b = buildScopeBudget(snapshot, name, {
      units: unitsByEntity[name],
      occupancyPct: occupancyByEntity[name],
      // Global edits first, then this entity's exception — the same precedence
      // the Budget tab's panel shows (see services/budgetOverrides.js).
      assumptions: { ...(opts.assumptions || {}), ...(entityAssumptions[name] || {}) },
      horizonMonths: opts.horizonMonths,
      pins: opts.pins,
      benchmarks: opts.benchmarks,
    });
    if (b) out.entities[name] = b;
  }

  out.portfolio = aggregateBudgets(Object.values(out.entities), 'Portfolio', {
    benchmarks: opts.benchmarks,
    pins: opts.pins,
  });

  return {
    generatedAt: new Date().toISOString(),
    basis: 'Accrual',
    source: { report: 'RM Report 45 ProfitLossRecapMonth', refreshedAt: snapshot.refreshedAt, asOfMonth: snapshot.asOfMonth },
    horizonMonths: opts.horizonMonths || A.HORIZON_MONTHS,
    ...out,
  };
}

// What budget/budget_workbook.py expects on stdin: one scope's budget plus the
// line schema it needs to lay out rows. Kept here rather than in the route so the
// workbook the tab downloads and the workbook a script generates are identical.
// `opts.benchmarks` carries any range edited on the Budget tab, so the workbook's
// benchmark column quotes the range the budget was actually judged against rather
// than the published default the tab has stopped using.
function toWorkbookPayload(budget, opts = {}) {
  const benchmarks = opts.benchmarks || {};
  return {
    ...budget,
    lineDefs: A.BUDGET_LINES.map(l => (benchmarks[l.key] ? { ...l, benchmark: benchmarks[l.key] } : l)),
    uncontrollable: [...A.UNCONTROLLABLE],
  };
}

// ── Live actuals over a frozen set (2026-10-20) ──────────────────────────────
// A budget set is built once and served from disk, and its actuals were filled
// in at build time only — so the set built on Jul 29 showed no actuals at all
// through October, though July, August and September had closed. This runs the
// same month alignment buildScopeBudget does, against the CURRENT snapshot, every
// time the set is served. The budget numbers never change; only the actuals
// beside them catch up. Rounding matches the build (each scope's roundTo).
function actualsFor(snapshot, series, monthLabels, to) {
  const labelIdx = new Map((snapshot.months || []).map((l, i) => [l, i]));
  const pick = key => (Array.isArray(series[key]) ? series[key] : null);
  return monthLabels.map(label => {
    const idx = labelIdx.get(label);
    if (idx === undefined) return null;
    if (snapshot.partialCurrentMonth && idx === snapshot.months.length - 1) return null;
    const inc = pick('totalIncome'), exp = pick('totalExpense');
    if (!inc || !exp) return null;
    const lines = {};
    for (const line of A.BUDGET_LINES) {
      if (!line.source) continue;
      const sr = pick(line.source);
      if (sr) lines[line.key] = round(Number(sr[idx]) || 0, to);
    }
    return {
      income: round(Number(inc[idx]) || 0, to),
      opex: round(Number(exp[idx]) || 0, to),
      noi: round((Number(inc[idx]) || 0) - (Number(exp[idx]) || 0), to),
      lines,
    };
  });
}

// Returns a copy of `set` with every entity's and the portfolio's actuals read
// from `snapshot`. The portfolio counts a month only once every entity has
// closed it, as aggregateBudgets does.
function overlayActuals(set, snapshot) {
  if (!set || !snapshot || !Array.isArray(snapshot.months)) return set;
  const entities = {};
  for (const [name, b] of Object.entries(set.entities || {})) {
    const series = (snapshot.entities || {})[name];
    if (!series || !Array.isArray(b.monthLabels)) { entities[name] = b; continue; }
    entities[name] = { ...b, actuals: actualsFor(snapshot, series, b.monthLabels, A.assumptionsFor(name).roundTo) };
  }
  let portfolio = set.portfolio;
  const kids = Object.values(entities);
  if (portfolio && kids.length && Array.isArray(portfolio.monthLabels)) {
    const actuals = portfolio.monthLabels.map((_, i) => {
      if (kids.some(b => !b.actuals || !b.actuals[i])) return null;
      const lines = {};
      for (const line of A.BUDGET_LINES) {
        if (!line.source) continue;
        lines[line.key] = kids.reduce((t, b) => t + ((b.actuals[i].lines || {})[line.key] || 0), 0);
      }
      return {
        income: kids.reduce((t, b) => t + b.actuals[i].income, 0),
        opex: kids.reduce((t, b) => t + b.actuals[i].opex, 0),
        noi: kids.reduce((t, b) => t + b.actuals[i].noi, 0),
        lines,
      };
    });
    portfolio = { ...portfolio, actuals };
  }
  return { ...set, entities, portfolio, actualsLive: { refreshedAt: snapshot.refreshedAt || null, asOfMonth: snapshot.asOfMonth || null } };
}

module.exports = {
  overlayActuals,
  actualsFor,
  buildScopeBudget,
  aggregateBudgets,
  buildAll,
  toWorkbookPayload,
  labelToYM,
  ymToLabel,
  addMonths,
  seasonalIndex,
  growthYears,
};
