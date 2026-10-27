#!/usr/bin/env node
// Tie-out checks for the 12-month budget engine (services/budgetModel.js).
//
// The Budget tab and the Excel workbook both claim to show the same numbers, and
// a budget that doesn't add up is worse than no budget — so these are the
// invariants that must hold for EVERY entity, every year:
//
//   1. EGI      = Rental & Operating Income + Occupancy Adj − Bad Debt
//   2. OpEx     = the sum of its own line items (nothing lost to rounding)
//   3. NOI      = EGI − OpEx
//   4. Cash Flow= NOI − below-NOI items
//   5. Portfolio= the exact sum of the entity budgets, line by line
//   6. Memo lines (Turnover, Mortgage Interest) are NEVER inside a total
//
// Runs against a synthetic snapshot by default so it needs no RM credentials;
// pass a path to a real property-pl-cache.json to check live data:
//
//   node scripts/checkBudgetModel.js [path/to/property-pl-cache.json]

const path = require('path');
const fs = require('fs');
const M = require('../services/budgetModel');
const A = require('../services/budgetAssumptions');

// ── synthetic snapshot ───────────────────────────────────────────────────────
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UNITS = {
  'Willow Creek': 183, 'Willow Creek': 207, 'Willow Creek': 174, 'Summit Lofts': 221, 'Maple Court': 202,
  'The Alder': 12, 'Birchwood Commons': 871, 'Willow Creek': 35, 'Demo Portfolio': 868, 'Willow Creek': 468,
  'Maple Court': 26, 'Birchwood Commons': 19, 'Summit Lofts': 12,
};

function syntheticSnapshot() {
  const labels = [];
  for (let y = 2024, m = 0, i = 0; i < 31; i++) {
    labels.push(`${MON[m]} ${String(y).slice(2)}`);
    if (++m > 11) { m = 0; y++; }
  }
  const GAS = [2.4, 2.3, 1.6, 0.9, 0.4, 0.2, 0.2, 0.2, 0.3, 0.7, 1.4, 2.4];
  const WATER = [0.3, 3.2, 0.3, 0.3, 3.2, 0.3, 0.3, 3.2, 0.3, 0.3, 3.2, 0.3]; // quarterly
  const FLAT = Array.from({ length: 12 }, () => 1);
  const gen = (base, shape, drift, seed) => labels.map((l, i) => {
    const m = MON.indexOf(l.slice(0, 3));
    const noise = 1 + (((seed * 9301 + i * 49297) % 233280) / 233280 - 0.5) * 0.08;
    return Math.round(base * shape[m] * Math.pow(1 + drift, i / 12) * noise * 100) / 100;
  });
  const entity = (scale, seed) => {
    const s = {
      totalIncome: gen(300000 * scale, FLAT, 0.03, seed + 1),
      propTax: gen(43000 * scale, FLAT, 0.02, seed + 2),
      insurance: gen(15000 * scale, FLAT, 0.09, seed + 3),
      heatingGas: gen(9000 * scale, GAS, 0.02, seed + 4),
      waterSewer: gen(14000 * scale, WATER, 0.03, seed + 5),
      electric: gen(5000 * scale, FLAT, 0.03, seed + 6),
      repairsMaint: gen(20000 * scale, FLAT, 0.03, seed + 7),
      turnover: gen(6000 * scale, FLAT, 0.03, seed + 8),
      payroll: gen(10000 * scale, FLAT, 0.035, seed + 9),
      mgmtFees: gen(9000 * scale, FLAT, 0.03, seed + 10),
      advertising: gen(1200 * scale, FLAT, 0.03, seed + 11),
      commissions: gen(800 * scale, FLAT, 0.03, seed + 12),
      mgmtWages: gen(4000 * scale, FLAT, 0.03, seed + 13),
      majRepairs: labels.map((_, i) => (i % 11 === 3 ? 42000 * scale : 0)),
      renCapital: labels.map((_, i) => (i % 17 === 5 ? 90000 * scale : 0)),
      mortgage: gen(48000 * scale, FLAT, 0, seed + 14),
    };
    s.totalExpense = labels.map((_, i) =>
      s.propTax[i] + s.insurance[i] + s.heatingGas[i] + s.waterSewer[i] + s.electric[i]
      + s.repairsMaint[i] + s.payroll[i] + s.mgmtFees[i] + s.advertising[i] + 7000 * scale);
    return s;
  };
  const scales = { 'Willow Creek': 1, 'Willow Creek': 1.15, 'Willow Creek': 0.95, 'Summit Lofts': 1.2, 'Maple Court': 1.1, 'The Alder': 0.07, 'Birchwood Commons': 4.6, 'Willow Creek': 0.2, 'Demo Portfolio': 4.5, 'Willow Creek': 2.4, 'Maple Court': 0.14, 'Birchwood Commons': 0.1, 'Summit Lofts': 0.07 };
  const entities = {};
  Object.keys(scales).forEach((n, i) => { entities[n] = entity(scales[n], i + 1); });
  const portfolio = {};
  for (const k of Object.keys(entities['Willow Creek'])) {
    portfolio[k] = labels.map((_, i) => Object.values(entities).reduce((s, e) => s + e[k][i], 0));
  }
  return {
    configured: true, refreshedAt: new Date().toISOString(), asOfMonth: '2026-07',
    partialCurrentMonth: true, basis: 'Accrual', months: labels,
    portfolio, entities, properties: {},
  };
}

// ── checks ───────────────────────────────────────────────────────────────────
let failures = 0;
function check(name, ok, detail) {
  if (ok) return;
  failures += 1;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function run() {
  const arg = process.argv[2];
  let snapshot, unitsByEntity, label;
  if (arg) {
    snapshot = JSON.parse(fs.readFileSync(path.resolve(arg), 'utf8'));
    unitsByEntity = UNITS;
    label = `live snapshot ${arg}`;
  } else {
    snapshot = syntheticSnapshot();
    unitsByEntity = UNITS;
    label = 'synthetic snapshot';
  }

  console.log(`Budget model tie-out — ${label}`);
  const all = M.buildAll(snapshot, { unitsByEntity });

  const opexKeys = A.BUDGET_LINES.filter(l => l.section === 'opex' && !l.memo).map(l => l.key);
  const belowKeys = A.BUDGET_LINES.filter(l => l.section === 'belowNoi' && !l.memo).map(l => l.key);
  const memoKeys = A.BUDGET_LINES.filter(l => l.memo).map(l => l.key);

  const scopes = [...Object.entries(all.entities), ['Portfolio', all.portfolio]];
  for (const [name, b] of scopes) {
    if (!b) { check(`${name} built`, false, 'engine returned null'); continue; }

    check(`${name} horizon`, b.months.length === A.HORIZON_MONTHS,
      `${b.months.length} months, expected ${A.HORIZON_MONTHS}`);

    // Monthly invariants
    for (let i = 0; i < b.months.length; i++) {
      const egi = b.lines.baseIncome[i] + b.lines.occupancyAdj[i] - b.lines.badDebt[i];
      check(`${name} ${b.monthLabels[i]} EGI`, egi === b.totals.egi[i], `${egi} vs ${b.totals.egi[i]}`);
      const opex = opexKeys.reduce((s, k) => s + b.lines[k][i], 0);
      check(`${name} ${b.monthLabels[i]} OpEx`, opex === b.totals.totalOpex[i], `${opex} vs ${b.totals.totalOpex[i]}`);
      check(`${name} ${b.monthLabels[i]} NOI`, b.totals.egi[i] - b.totals.totalOpex[i] === b.totals.noi[i]);
      const below = belowKeys.reduce((s, k) => s + b.lines[k][i], 0);
      check(`${name} ${b.monthLabels[i]} below-NOI`, below === b.totals.belowNoi[i]);
      check(`${name} ${b.monthLabels[i]} cash flow`, b.totals.noi[i] - b.totals.belowNoi[i] === b.totals.cashFlow[i]);
    }

    // Annual roll-ups must equal the sum of their own months
    b.years.forEach(y => {
      const [s, e] = y.range;
      const slice = arr => arr.slice(s, e).reduce((a, v) => a + v, 0);
      check(`${name} ${y.label} EGI roll-up`, y.egi === slice(b.totals.egi));
      check(`${name} ${y.label} OpEx roll-up`, y.totalOpex === slice(b.totals.totalOpex));
      check(`${name} ${y.label} NOI roll-up`, y.noi === slice(b.totals.noi));
      check(`${name} ${y.label} OpEx = its lines`, y.totalOpex === opexKeys.reduce((a, k) => a + y.lines[k], 0));
    });

    // Memo lines must never be inside a total
    for (const k of memoKeys) {
      check(`${name} memo '${k}' excluded from OpEx`, !opexKeys.includes(k));
      check(`${name} memo '${k}' excluded from below-NOI`, !belowKeys.includes(k));
    }
  }

  // Portfolio = exact sum of entities, every line, every month
  const ents = Object.values(all.entities);
  for (const line of A.BUDGET_LINES) {
    for (let i = 0; i < all.portfolio.months.length; i++) {
      const s = ents.reduce((a, e) => a + e.lines[line.key][i], 0);
      check(`Portfolio ${line.key} ${all.portfolio.monthLabels[i]}`,
        s === all.portfolio.lines[line.key][i], `${s} vs ${all.portfolio.lines[line.key][i]}`);
    }
  }
  ['egi', 'totalOpex', 'noi', 'belowNoi', 'cashFlow'].forEach(f => {
    const s = ents.reduce((a, e) => a + e.years[0][f], 0);
    check(`Portfolio Year 1 ${f}`, s === all.portfolio.years[0][f], `${s} vs ${all.portfolio.years[0][f]}`);
  });

  // The anchor invariant. Under the default calendar-year anchor the budget window
  // must HOLD STILL, which means months that have already closed fall inside it and
  // budget-vs-actual populates itself. Regression guard: an earlier cut started the
  // horizon the month after the last actual, so the window slid forward on every
  // refresh, no month could ever close inside it, and the Actual column would have
  // stayed empty forever — putting the manual data entry right back.
  for (const [name, b] of scopes) {
    if (!b || b.anchor !== 'calendarYear') continue;
    check(`${name} anchor starts in January`, b.months[0].endsWith('-01'), `starts ${b.months[0]}`);
    check(`${name} base ends before the budget starts`,
      b.baseWindow.to && M.labelToYM(b.baseWindow.to) < b.months[0],
      `base ends ${b.baseWindow.to}, budget starts ${b.months[0]}`);
    check(`${name} has closed months to track against`, b.actuals.some(Boolean),
      'no actual month falls inside the budget window — budget-vs-actual would never populate');
    check(`${name} growth offset is positive`, b.growthOffsetMonths > 0, `offset ${b.growthOffsetMonths}`);
  }

  // Seasonality indices must average 1.0 — otherwise the shape is silently
  // inflating or deflating the annual total it was supposed to leave alone.
  for (const [name, b] of Object.entries(all.entities)) {
    for (const [key, seas] of Object.entries(b.seasonality)) {
      const mean = seas.index.reduce((a, v) => a + v, 0) / 12;
      check(`${name} seasonality '${key}' mean 1.0`, Math.abs(mean - 1) < 1e-9, `mean ${mean.toFixed(6)}`);
    }
  }

  const p = all.portfolio;
  console.log(`\n  ${Object.keys(all.entities).length} entities + portfolio · base ${p.baseWindow.from} → ${p.baseWindow.to} · budget ${p.monthLabels[0]} → ${p.monthLabels[p.monthLabels.length - 1]}`);
  p.years.forEach(y => console.log(
    `  ${y.label} (${y.months})  EGI ${fmt(y.egi)}  OpEx ${fmt(y.totalOpex)}  NOI ${fmt(y.noi)}  margin ${(y.noi / y.egi * 100).toFixed(1)}%`));

  // ── 7. Edited assumptions must not break any of the above ─────────────────
  // The Budget tab can pin a line to a benchmark ($450/unit insurance) and edit
  // rates live. A pin scales a line, so the danger is that it lands on its target
  // while quietly desynchronising a total from its own parts — which would show up
  // as a budget that doesn't add up in front of the person who asked for the pin.
  const PIN_UNIT = 450;
  const PIN_PCT = 0.045;
  const edited = M.buildAll(snapshot, {
    unitsByEntity,
    assumptions: { insuranceGrowthPct: 0.11, badDebtPct: 0.02 },
    entityAssumptions: { 'Maple Court': { incomeGrowthPct: 0.04 } },
    pins: {
      insurance: { mode: 'perUnitYr', value: PIN_UNIT },
      mgmtFees: { mode: 'pctOfEgi', value: PIN_PCT },
    },
    benchmarks: { insurance: { perUnitYr: [400, 500], label: '$400–$500/unit/yr (edited)' } },
  });

  const eScopes = [...Object.entries(edited.entities), ['Portfolio', edited.portfolio]];
  for (const [name, b] of eScopes) {
    if (!b) { check(`${name} built with edits`, false, 'engine returned null'); continue; }
    for (let i = 0; i < b.months.length; i++) {
      const opex = opexKeys.reduce((s, k) => s + b.lines[k][i], 0);
      check(`${name} ${b.monthLabels[i]} OpEx ties with pins`, opex === b.totals.totalOpex[i],
        `${opex} vs ${b.totals.totalOpex[i]}`);
      check(`${name} ${b.monthLabels[i]} NOI ties with pins`,
        b.totals.egi[i] - b.totals.totalOpex[i] === b.totals.noi[i]);
    }
    // The pin has to actually land: Year-1 insurance = units × $450. Rounding is
    // per month, so allow a dollar of drift per month of the year.
    if (b.units) {
      const y1 = b.years[0].lines.insurance;
      check(`${name} insurance pin lands on $${PIN_UNIT}/unit`,
        Math.abs(y1 - b.units * PIN_UNIT) <= 12,
        `Year 1 ${fmt(y1)} vs target ${fmt(b.units * PIN_UNIT)} (${b.units} units)`);
      // ...and the pin must SCALE the line, not flatten it. Over a 12-month
      // horizon there is no Year 2 to grow into, so the invariant moves inside the
      // year: divide out the seasonal shape and what's left must still be rising
      // at the growth rate. A pin that overwrote the line with a flat twelfth
      // would land on the target and fail here — which is the point.
      const idx = ((b.seasonality || {}).insurance || {}).index;
      const vals = b.lines.insurance;
      if (idx && vals.some(v => v)) {
        const deseason = vals.map((v, i) => v / (idx[Number(b.months[i].split('-')[1]) - 1] || 1));
        check(`${name} pinned line still grows within the year`,
          deseason[deseason.length - 1] > deseason[0],
          `de-seasonalised ${fmt(deseason[0])} → ${fmt(deseason[deseason.length - 1])}`);
      }
    }
    const mgmtY1 = b.years[0].lines.mgmtFees;
    check(`${name} mgmt fee pin lands on ${(PIN_PCT * 100).toFixed(1)}% of EGI`,
      Math.abs(mgmtY1 - b.years[0].egi * PIN_PCT) <= 12,
      `${fmt(mgmtY1)} vs ${fmt(b.years[0].egi * PIN_PCT)}`);
  }

  // Portfolio still equals the sum of its children once entities carry different
  // assumptions — the roll-up integrity that per-entity exceptions could break.
  const eEnts = Object.values(edited.entities);
  for (const line of A.BUDGET_LINES) {
    for (let i = 0; i < edited.portfolio.months.length; i++) {
      const s = eEnts.reduce((a, e) => a + e.lines[line.key][i], 0);
      check(`Portfolio(edited) ${line.key} ${edited.portfolio.monthLabels[i]}`,
        s === edited.portfolio.lines[line.key][i]);
    }
  }

  // An edit has to move the number. A pin that silently no-ops would leave a
  // meeting believing a decision had been applied when it hadn't.
  check('editing assumptions changes NOI',
    edited.portfolio.years[0].noi !== all.portfolio.years[0].noi,
    'Year-1 NOI identical with and without edits');
  check('edited benchmark drives the check verdict',
    (edited.portfolio.checks.find(c => c.key === 'insurance') || {}).rangeLabel !== undefined
    && (edited.portfolio.checks.find(c => c.key === 'insurance') || {}).pinned === true,
    'insurance check is not reported as pinned');

  console.log(`  edited run · Year-1 NOI ${fmt(all.portfolio.years[0].noi)} → ${fmt(edited.portfolio.years[0].noi)}`
    + ` · insurance ${fmt(all.portfolio.years[0].lines.insurance)} → ${fmt(edited.portfolio.years[0].lines.insurance)}`);

  if (failures) {
    console.error(`\n✗ ${failures} tie-out failure(s)`);
    process.exit(1);
  }
  console.log('\n✓ all tie-outs pass');
}

function fmt(n) {
  const a = Math.abs(n);
  const v = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : `$${Math.round(a).toLocaleString()}`;
  return n < 0 ? `(${v})` : v;
}

run();
