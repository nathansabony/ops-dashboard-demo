// Single source of truth for the 12-month Budget model's ASSUMPTIONS layer.
//
// ── WHY THIS FILE ────────────────────────────────────────────────────────────
// The budget engine (services/budgetModel.js) is deliberately dumb: it takes each
// entity's real trailing-12 actuals out of the live Rent Manager P&L snapshot and
// projects them forward. Everything that makes the projection a *judgement* —
// growth rates, seasonality on/off, bad debt — lives HERE, in one place, so it
// can be argued about and changed without touching the engine.
//
// Defaults come from BUDGET-BENCHMARKS.md (NAA/IREM/BOMA 2024 Income/Expense IQ
// plus the OH-specific notes). Every one of them is a KNOB. The same numbers are
// written onto the Excel workbook's "Assumptions" tab as live input cells, so the
// model recalculates when the regional manager changes them there — this file is just where the
// defaults are seeded.
//
// ── THE ONE MODELLING DECISION WORTH KNOWING ─────────────────────────────────
// The income base is ACTUAL BILLED INCOME (RM Report 45, accrual). Vacant units
// are not billed, so that base ALREADY reflects each entity's real occupancy.
// We therefore do NOT subtract a vacancy percentage on top of it — that would
// double-count the loss. Instead:
//   • occupancyTargetPct (default null) lets you flex income from the entity's
//     own trailing occupancy up/down to a target. Null = budget the building as
//     it actually runs, which is the default BUDGET-TOOL-CONCEPT.md proposes.
//   • badDebtPct is a real, separate loss (billed but never collected) and IS
//     subtracted.
// See BUDGET-BENCHMARKS.md #2/#3 for the underlying vacancy/bad-debt research.

// ── Global model constants ───────────────────────────────────────────────────
const HORIZON_MONTHS = 12;   // one-year budget window
const BASE_MONTHS = 12;      // trailing window the base + seasonality are read from

// ── Line schema ──────────────────────────────────────────────────────────────
// `source` is the key in the propertyFinancials snapshot series (services/
// propertyFinancials.js CATEGORY_REFS). `growth` names the rate on ASSUMPTION
// DEFAULTS below. `section` drives grouping in both the tab and the workbook.
//
//   section 'income'      → builds to Effective Gross Income
//   section 'opex'        → builds to Total Operating Expense (NOI = EGI - OpEx)
//   section 'belowNoi'    → below the NOI line (capital, reserves, debt)
//   memo: true            → displayed for context, NEVER summed into a total
//                           (it is already inside its parent line)
//
// `plug: true` marks the one line computed as a residual so the projected expense
// total ties to the actual total exactly rather than drifting by whatever RM books
// outside our mapped accounts.
const BUDGET_LINES = [
  // ── INCOME ────────────────────────────────────────────────────────────────
  {
    key: 'baseIncome', label: 'Rental & Operating Income', section: 'income',
    source: 'totalIncome', growth: 'incomeGrowthPct', seasonal: true,
    note: 'Actual billed income (accrual). Already net of vacant units — they are never billed.',
  },
  {
    key: 'occupancyAdj', label: 'Occupancy Adjustment', section: 'income',
    source: null, growth: null, seasonal: false, derived: 'occupancy',
    note: 'Flexes income from the entity\'s trailing occupancy to occupancyTargetPct. Zero unless a target is set.',
  },
  {
    key: 'badDebt', label: 'Less: Bad Debt / Collection Loss', section: 'income',
    source: null, growth: null, seasonal: false, derived: 'badDebt', negative: true,
    note: 'Billed but uncollectable. % of billed income — BUDGET-BENCHMARKS.md #3.',
  },

  // ── OPERATING EXPENSES ────────────────────────────────────────────────────
  {
    key: 'propTax', label: 'Property Taxes', section: 'opex',
    source: 'propTax', growth: 'propTaxGrowthPct', seasonal: true,
    benchmark: null, // no national default — OH assessments are entity-specific
    note: 'Biggest OH line. Grow modestly; type a reassessment straight over the affected months in Excel.',
  },
  {
    key: 'insurance', label: 'Insurance', section: 'opex',
    source: 'insurance', growth: 'insuranceGrowthPct', seasonal: true,
    benchmark: { perUnitYr: [750, 1100], label: '$750–$1,100/unit/yr' },
    note: 'Structurally over-inflating (+55% nationally 2021→2024). Type a known renewal over the month it lands.',
  },
  {
    key: 'heatingGas', label: 'Utilities — Heating Gas', section: 'opex',
    source: 'heatingGas', growth: 'utilitiesGrowthPct', seasonal: true,
    note: 'Strongly seasonal — the seasonality index is what stops August gas reading like February.',
  },
  {
    key: 'waterSewer', label: 'Utilities — Water & Sewer', section: 'opex',
    source: 'waterSewer', growth: 'utilitiesGrowthPct', seasonal: true,
    note: 'Often billed quarterly; seasonality carries the billing cycle.',
  },
  {
    key: 'electric', label: 'Utilities — Electric', section: 'opex',
    source: 'electric', growth: 'utilitiesGrowthPct', seasonal: true,
  },
  {
    key: 'repairsMaint', label: 'Repairs & Maintenance', section: 'belowNoi',
    source: 'repairsMaint', growth: 'repairsGrowthPct', seasonal: true,
    benchmark: { perUnitYr: [1100, 1400], label: '$1,100–$1,400/unit/yr' },
    // RM books this GL account (5100) as operating expense, so it's still part of
    // the ACTUAL totalExpense the otherOpex plug ties out to (budgetModel.js
    // mappedOpexKeys) — operatingActual flags that despite living in the belowNoi
    // section for display/NOI purposes (2026-07-29 budget meeting: NOI should land
    // above R&M, not net of it).
    operatingActual: true,
  },
  {
    key: 'turnover', label: 'of which: Turnover / Make-Ready', section: 'opex',
    source: 'turnover', growth: 'repairsGrowthPct', seasonal: true, memo: true,
    note: 'A CHILD of Repairs & Maintenance (GL 5106 sits inside 5100) — shown for visibility, never added on top.',
  },
  {
    key: 'payroll', label: 'Payroll', section: 'opex',
    source: 'payroll', growth: 'payrollGrowthPct', seasonal: true,
    // Ceiling tightened from the $2,300 published national max to $1,500/unit/yr
    // per the 2026-07-29 budget meeting — a house-level cap, not a benchmark-doc
    // number. Flags entities projecting above it; does not clamp the projection.
    benchmark: { perUnitYr: [500, 1500], label: '$500–$1,500/unit/yr (house cap, 2026-07-29)' },
  },
  {
    key: 'mgmtFees', label: 'Management Fees', section: 'opex',
    source: 'mgmtFees', growth: 'generalGrowthPct', seasonal: true,
    mode: 'mgmtFee', // honours mgmtFeeMode below
    benchmark: { pctOfEgi: [0.04, 0.05], label: '4–5% of collected income' },
  },
  {
    key: 'advertising', label: 'Marketing / Advertising', section: 'opex',
    source: 'advertising', growth: 'generalGrowthPct', seasonal: true,
    benchmark: { perUnitYr: [150, 350], label: '$150–$350/unit/yr' },
  },
  {
    key: 'otherOpex', label: 'Other Operating Expense', section: 'opex',
    source: null, growth: 'generalGrowthPct', seasonal: true, plug: true,
    note: 'Residual: actual Total Operating Expense less every mapped line above. Keeps the projection tied to the real total.',
  },
  {
    key: 'contingency', label: 'Contingency', section: 'opex',
    source: null, growth: null, seasonal: false, derived: 'contingency',
    note: '% of controllable opex (everything except taxes and insurance). Defaults to 0 — see contingencyPct.',
  },

  // ── BELOW NOI ─────────────────────────────────────────────────────────────
  {
    key: 'majRepairs', label: 'Major Repairs', section: 'belowNoi',
    source: 'majRepairs', growth: null, seasonal: false, plannedOnly: true,
    note: 'Zero by default — lumpy and planned, so a run-rate would be fiction. Type real projects into the month they land.',
  },
  {
    key: 'renCapital', label: 'Capital Expenditure', section: 'belowNoi',
    source: 'renCapital', growth: null, seasonal: false, plannedOnly: true,
    note: 'Zero by default. Type planned capital into the month it lands.',
  },
  {
    key: 'reserves', label: 'Replacement Reserves', section: 'belowNoi',
    source: null, growth: 'generalGrowthPct', seasonal: false, derived: 'reserves',
    benchmark: { perUnitYr: [250, 300], label: '$250–$300/unit/yr (Fannie/Freddie)' },
  },
  {
    key: 'mgmtWages', label: 'Management Wages / Salary', section: 'belowNoi',
    source: 'mgmtWages', growth: 'payrollGrowthPct', seasonal: true,
    note: 'RM books this below the operating line (GL 5710) — kept there so NOI matches the P&L.',
  },
  {
    key: 'commissions', label: 'Commissions', section: 'belowNoi',
    source: 'commissions', growth: 'generalGrowthPct', seasonal: true,
  },
  {
    key: 'mortgageInterest', label: 'memo: Mortgage Interest (booked)', section: 'belowNoi',
    source: 'mortgage', growth: null, seasonal: true, memo: true,
    note: 'The interest RM actually books (GL 6230). Reference only, never summed — this budget stops at cash flow BEFORE debt service.',
  },
];

// ── Assumption defaults (BUDGET-BENCHMARKS.md) ───────────────────────────────
// Rates are ANNUAL and compounded monthly across the horizon.
const DEFAULT_ASSUMPTIONS = {
  // Growth
  //
  // 2026-07-29 budget meeting: 4-6% for OH, plugged at 6% for OH (see
  // ENTITY_OVERRIDES below) for now. OH default set to the midpoint of that range
  // as a placeholder — replace per entity with a real figure once rent-control
  // status is confirmed for each OH property (see the RENT CONTROL note below).
  incomeGrowthPct: 0.05,
  propTaxGrowthPct: 0.03,    // #10/#15 — 2–4%; type a known reassessment over the month
  insuranceGrowthPct: 0.08,  // #9/#15 — 7–10%, the structural over-inflation line
  utilitiesGrowthPct: 0.03,  // #11/#15 — volatile, use general inflation
  repairsGrowthPct: 0.03,    // #5
  payrollGrowthPct: 0.035,   // #8/#15 — 3–4%
  generalGrowthPct: 0.03,    // #15 — everything else

  // Income build
  occupancyTargetPct: null,  // null = budget at the entity's own trailing occupancy (#2)
  badDebtPct: 0.01,          // #3 — 1% of billed income for market-rate OH workforce stock

  // Per-unit / percentage-driven lines
  mgmtFeeMode: 'actual',     // 'actual' = grow the booked fee | 'pctOfEgi' = recompute off income
  mgmtFeePct: 0.04,          // #7 — only used when mgmtFeeMode === 'pctOfEgi'. House rate is 4%:
                             // the house budget workbooks (shared corporate folder) show Management Fee Rate 0.04.
                             // The 4.5% that used to sit here was the benchmark-doc midpoint,
                             // not Demo Portfolio's actual rate.
  reservesPerUnitYr: 300,    // #14 — top of the agency range, older OH stock
  contingencyPct: 0,         // #16 — see note below

  // Model behaviour
  //
  // anchor 'calendarYear' (default): the budget year IS the current calendar
  // year, built from the prior calendar year's actuals. A budget is a fixed
  // commitment you then track against, so the window must hold still — months
  // that have already closed land inside it and can be compared to actuals.
  //
  // anchor 'rolling': a 12-month look-ahead starting the month after the last
  // actual. Useful as a forecast, but the window slides every refresh, so nothing
  // ever closes inside it.
  anchor: 'calendarYear',
  seasonality: true,         // use each entity's own 12-month shape, not a flat 1/12
  seasonalityDamping: null,  // null = adaptive: 0.25 with 2 years of history, 0.5 with 1
                             // (see the damping note in budgetModel.js seasonalIndex)
  roundTo: 1,                // dollars

  // ── Why contingency defaults to 0 ──────────────────────────────────────────
  // BUDGET-BENCHMARKS.md #16 recommends a 3–5% cushion, but that cushion exists to
  // absorb ESTIMATE error — and this model is built on the entity's own real
  // actuals, not on benchmark estimates. A hidden pad would also blunt the thing
  // the Budget tab is actually for: month-by-month budget-vs-actual variance. So
  // it ships visible and off. Set contingencyPct to 0.03–0.05 to turn it on; it
  // renders as its own line, never folded into another.
};

// ── Per-entity overrides ─────────────────────────────────────────────────────
// Anything set here beats the defaults for that entity. This is the file the regional manager's
// answers land in. Two of the three items BUDGET-TOOL-CONCEPT.md flags as
// open questions live here (income growth / rent-control caps, and debt service).
//
// RENT CONTROL (BUDGET-BENCHMARKS.md) - the income growth cap depends on the
// municipality, so it cannot be defaulted portfolio-wide. Columbus, OH (the demo's
// market) has no rent control, so the demo sets no overrides. In a market that does:
//   - a rent-stabilised city, buildings 5+ units -> lesser of CPI or a fixed cap
//   - small or newer buildings                   -> often exempt, use the 3% default
// Set incomeGrowthPct per entity once you confirm which properties sit where.
const ENTITY_OVERRIDES = {
  // 'Demo Portfolio': { incomeGrowthPct: 0.04, note: 'Example: capped at the lesser of CPI or 4%' },
};

// ── One-off dated items: not modelled, typed ─────────────────────────────────
// The 36-month model carried an Event Calendar tab (dated tax reassessments,
// insurance renewals, planned capital) and a Debt Service tab that amortised
// entered loan terms. Both are gone as of the 12-month rewrite, deliberately:
// they were the bulk of the workbook's formula complexity and both shipped empty.
//
// Over a 12-month window a one-off is simpler to state than to model — type the
// number straight into that month's cell on the Budget tab. Every total above it
// is a live SUM, so NOI and cash flow move with it.
//
// Debt service is out of scope entirely now: this budget stops at CASH FLOW
// BEFORE DEBT SERVICE. Booked mortgage interest (GL 6230) is still shown as an
// unsummed memo line for reference. Restoring either is a `git revert` away —
// see the pre-rewrite history of this file.

// ── Lookup helpers ───────────────────────────────────────────────────────────
function assumptionsFor(entity, overrides) {
  return {
    ...DEFAULT_ASSUMPTIONS,
    ...(ENTITY_OVERRIDES[entity] || {}),
    ...(overrides || {}),
  };
}

// Lines that a contingency is calculated on: controllable opex only. Taxes and
// insurance are contractual/statutory — padding them is meaningless.
const UNCONTROLLABLE = new Set(['propTax', 'insurance']);

function lineByKey(key) {
  return BUDGET_LINES.find(l => l.key === key) || null;
}

// Everything the frontend and the Excel writer need to describe the model without
// re-deriving it. Serialisable — this is what GET /api/budget/assumptions returns.
function getConfig() {
  return {
    horizonMonths: HORIZON_MONTHS,
    baseMonths: BASE_MONTHS,
    lines: BUDGET_LINES,
    defaults: DEFAULT_ASSUMPTIONS,
    entityOverrides: ENTITY_OVERRIDES,
    uncontrollable: [...UNCONTROLLABLE],
  };
}

module.exports = {
  HORIZON_MONTHS,
  BASE_MONTHS,
  BUDGET_LINES,
  DEFAULT_ASSUMPTIONS,
  ENTITY_OVERRIDES,
  UNCONTROLLABLE,
  assumptionsFor,
  lineByKey,
  getConfig,
};
