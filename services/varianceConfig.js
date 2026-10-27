// Single source of truth for the Variance tab's flagging model (v4).
//
// ── WHY THIS MODEL ───────────────────────────────────────────────────────────
// v4 (July 2026) makes the trigger purely MONTH-OVER-MONTH. The client detector
// (see varCellSignal / scanLineFlags in public/index.html) scans every complete
// month of the current year and flags a line when a month moved against the month
// right before it — past that line's `pct` and `minImpact` gates. Trailing-12
// averages are still shown, but ONLY to justify a flag after the fact, never to
// raise one. Three flag kinds: month-over-month variance, any negative posting,
// and a normally-present line that dropped to ~$0. See VARIANCE-RULES.md.
//
// Fields the v4 client reads per item: `group` (income vs expense → good/bad
// direction), `direction` (drop/rise/both, for the Variances bucket), `pct` /
// `redPct` (% gates), `minImpact` ($ floor, scope-scaled by SCOPE_TUNING), and
// `label`/`key`. NOTE: `mode`, `seasonalTolerance`, `flagZero` and
// `EXPENSE_INFLATION` are INERT — kept for reference/rollback but no longer
// consulted by the detector. The "weird $0" test is data-driven (a line normally
// carrying a value that dropped to ~$0), controlled by ZERO_DROP, not `flagZero`.
// `postingGateDays` was REACTIVATED 2026-07-22 as a calendar-day quiet window
// (see POSTING_GATE_DAYS below). Newer per-item knobs the detector DOES read:
// `zeroRunMonths` (turnover), `monthAbs` (major repairs), `negCompareYoY`
// (insurance credits vs same month last year).
//
//   • MORTGAGE INTEREST is removed from all flagging (not tracked below).
//
// Every item is a KNOB — edit and reload; the tab picks it up. Values are tuned
// for the INDIVIDUAL-PROPERTY level; SCOPE_TUNING loosens % but demands more
// absolute dollars as you roll up to entity / portfolio (a single event is a tiny
// % of a big total, so aggregate scopes need a $ gate, not a % gate).

// ── Global model knobs ───────────────────────────────────────────────────────
// 2026-10-06 (the owner): "should only make variances on past 6 month items." Flags
// are raised only for the last N COMPLETE months (the in-progress month never
// flags). The rest of the history is still read — as the prior month for a
// month-over-month move and as the trailing-12 normal range for step 2 — it just
// cannot raise a card of its own. Editable on the rules screen.
const FLAG_WINDOW_MONTHS = 6;
const RECENT_MONTHS = 3;         // smoothing window for "recent normal" (washes single-month noise)
const BASELINE_MONTHS = 12;      // trailing-year window for scheduled/annual comparisons
const SEASONAL_YEARS = 2;        // how many prior years' same-month values to average for seasonal validation
const EXPENSE_INFLATION = 0.03;  // income must grow at least this YoY to hold NOI
// REACTIVATED 2026-07-22 (was inert in the first v4 cut): for lines that carry
// `postingGateDays`, a month whose month-END is fewer than this many calendar
// days ago is NOT flagged at all — no variance, no negative, no zero. Insurance,
// taxes and management fees get posted/fixed by accounting on a lag, so the tab
// gives them 60 days of quiet before tracking them (kills the June-26 negative
// noise that was all manual-fix timing).
const POSTING_GATE_DAYS = 60;
const FLAG_NEGATIVES = true;     // always flag a negative monthly value on a cost line
// 2026-07-27 (the owner): a negative smaller than this in absolute value is NOISE, not
// an accounting anomaly worth a Critical card — think a -$1 heating gas or a -$40
// insurance rounding credit. Below this floor the month is dropped ENTIRELY: no
// negative flag, no yellow heatmap cell, and it is NOT re-tested as a "zeroed out"
// month either. Raise to quiet the list further, lower to see more corrections.
// 2026-07-29 (the owner): raised 100 → 300. General rule — nothing under $300 flags.
const NEG_MIN_ABS = 300;

// Insurance credits: renewals post a big credit about once a year. For items
// with `negCompareYoY`, a negative month is compared to the SAME MONTH LAST
// YEAR — if last year had a similar credit (within maxRatio either way), it's
// the normal annual pattern and is NOT flagged; a credit that is way different
// (or has no prior-year counterpart) still flags.
const NEG_YOY = { maxRatio: 2.0 };

// STEP 2 of a variance flag: after a real month-over-month move (step 1), the new
// value must be at least this many standard deviations from the line's own
// trailing-12 mean (in the move's direction) to actually flag. This suppresses
// choppy-but-normal lines — a move that stays inside the line's usual range (e.g.
// Advertising bouncing $20K–$65K) is NOT flagged. Raise to loosen, lower to tighten.
const ABNORMAL_Z = 1.5;

// Percent displays are capped: a move beyond MAX_DISPLAY_PCT reads as noise
// ("+519%"), so the UI shows the DOLLAR change instead of the percent there.
const MAX_DISPLAY_PCT = 1.20;

// Materiality: a flag whose annualized $ impact is small relative to the scope's
// own operating budget (and below the absolute floor) is demoted one urgency
// tier and labeled minor — big % on small money shouldn't scream. Negative
// postings are exempt (an accounting anomaly is worth a look at any size).
const MATERIALITY = {
  minShareOfOpex: 0.015, // impact below 1.5% of the scope's annual opex → minor
  absFloor: 24000,       // ...unless it clears this $/yr regardless of share
};

// ── Categories (the owner's July-2026 split) ────────────────────────────────────
// The tab groups flags into four SEPARATE buckets behind a button bar, because
// three of them aren't really "the number swung" variances at all:
//   • variance — a real high/low run-rate move (the classic tracker).
//   • negative — a negative posting (insurance/overcharge CREDIT, reversal, refund
//                coming back as "over"). Not a variance — a correction/accounting
//                item. Collapsed behind one button instead of one flag per line.
//   • zero     — a line that SHOULD always be present dropped to ~$0 (e.g. a
//                management fee that went from a big number to zero). A mistake to
//                fix, not a swing to explain.
//   • move     — move-in / move-out activity, flagged on ABSOLUTE counts scaled to
//                property size (NOT the average — an average of 0.7 is meaningless).
const CATEGORIES = [
  { key: 'variance', label: 'Variances',          icon: '📈', hint: 'A line jumped or dropped versus its own normal.' },
  { key: 'negative', label: 'Negatives / Credits', icon: '➖', hint: 'Negative postings — credits, reversals, overcharge refunds. Not variances; corrections to review.' },
  { key: 'zero',     label: 'Zeroed Out',          icon: '⭕', hint: 'A line that should never be $0 dropped to zero — usually a posting error to fix.' },
  { key: 'move',     label: 'Move-ins / outs',     icon: '🚪', hint: 'Move-in / move-out activity, flagged at ENTITY level only, minimum 5 moves.' },
];

// "Zeroed out" detection. Runs ONLY on lines flagged `flagZero` below (things that
// should never legitimately be $0 for an occupied building). Lumpy/seasonal lines
// (insurance, taxes, quarterly water, summer gas) are intentionally excluded — a
// zero there is normal. Posting-gated lines still respect their gate, so a
// not-yet-posted month is never mistaken for "went to zero".
// 2026-07-27 (the owner): the point of this bucket is "somebody forgot to enter the
// number" — a BLANK month, not a small month. The old single $150 cutoff meant a
// real $54 insurance charge got listed as "dropped to $0", which is not what the
// bucket is for. So the two jobs the cutoff was doing are now separate knobs:
//   • zeroAbs      — what counts as NOTHING WAS ENTERED. Essentially $0. A real
//                    charge of any size is a real charge and never lands here; if
//                    it is a genuine collapse ($4K → $54) the VARIANCE detector
//                    catches it as a drop, which is the honest description.
//   • nearZeroAbs  — "too small to divide by": a prior month at/below this is not a
//                    usable base for month-over-month math (a $54 → $4K jump reads
//                    as +7,300% and means nothing). Unchanged at $150.
const ZERO_DROP = {
  zeroAbs: 1,            // a month at/below this $ is a blank — the "forgot to post it" case
  nearZeroAbs: 150,      // too small to serve as a month-over-month comparison base
  minPriorMonthly: 1000, // ...and the prior run rate must have been at least this to matter
};

// ── Is the jump a pattern this line already has? ────────────────────────────
// The owner, 2026-09-03, on the 2301 Willow Creek Rd water flag: *"it jumped a lot, but
// there was also a high number once every three, four months. So start checking
// patterns too."*
//
// This is the general form of the seasonal check, and it is what the water line
// taught. Two questions get run together in a meeting and they have different
// answers:
//
//   1. **Is this month unusual?** — the detector's job, and it is doing it.
//   2. **Is this line unusual?** — some lines spike on a schedule. A quarterly
//      water bill, a semi-annual tax instalment, an insurance renewal. On those,
//      "this month is three times last month" is a description of the billing
//      cycle, not a finding.
//
// The gates do not change: the flag is raised exactly as before. What is added is
// the answer to question 2 on the card, computed from the line's own history —
// so a spike that arrived on schedule and at the usual size says so, and a spike
// that is on schedule but HALF AGAIN AS BIG as the last few says that instead.
// That second case is the one this catches that no seasonal comparison would: a
// building whose quarterly bill is quietly climbing looks normal to a
// month-over-month test and normal to a same-month-last-year test.
//
// Every knob is here rather than in the page, and every one is read by
// `varSpikeCycle` in public/index.html — proved against synthetic series by
// `npm run check:variance-cycles`.
const CYCLE = {
  window: 24,        // months of history to look for a pattern in
  minPeaks: 3,       // two highs are two events; three are a pattern
  minPeriod: 2,      // months between peaks — below this it is choppiness
  maxPeriod: 6,      // above this a "cycle" is really annual seasonality (the YoY panel)
  slack: 1,          // 3, 3, 4 months apart is still a quarterly cycle
  peakOver: 1.35,    // a month is a "high" at this multiple of the window's median
  biggerPct: 0.15,   // this peak vs the average of the ones before it, before we say it grew
  trendPctPerYear: 0.08, // peak-over-peak drift worth naming
};

// ── Did the jump come back? (2026-10-06) ─────────────────────────────────────
// The owner: a Water & Sewer flag up ~$27K where the very next month is −$25K is not
// a $27K problem — most of it was credited back. Every jump flag (a month-over-
// month rise, or a big single month) now looks at the next `lookMonths` complete
// months for a credit (a negative month) or a month below the pre-jump level, and
// adds up how much of the jump that gave back.
//   • at `notePct` of the jump or more, the flag carries an Important note:
//     "$X credited back in <month> — net change $Y";
//   • at `mostPct` or more, the flag also drops one tier and is tagged
//     "credited back". It still flags — somebody should confirm the credit.
// Sub-accounts get the same reading in "⚑ Which account caused it", so the card
// names which account took the credit. Read by varCreditBack in public/index.html.
const CREDIT_BACK = {
  lookMonths: 2,   // how many months after the jump to look in
  notePct: 0.10,   // give-back at least this share of the jump → note on the card
  mostPct: 0.80,   // give-back at least this share → one tier lower, "credited back"
  // 2026-10-13 (the owner + the regional manager, the $36K water bill credited the next month):
  // a jump that was actually CREDITED back — a credit posted, and it gives back
  // between mostPct and 1/mostPct of the jump — is not a flag at all. It (and the
  // credit's own negative card) moves to Resolved as "cleared automatically". A
  // month that merely ran lower ("given back") still flags one tier lower.
  clears: true,
};

// ── The monthly review cycle (2026-10-13 meeting) ───────────────────────────
// Accounting posts the prior month through the 15th; the regional manager reviews the prior
// month's variances on the 18th. Before `closeDay`, the just-closed month is
// still being posted, so a blank or missed bill there is not raised yet and its
// other flags are marked "preliminary". The tab shows the next review date.
const REVIEW_CYCLE = { closeDay: 15, reviewDay: 18 };

// ── A new run rate, not a spike (2026-10-06) ─────────────────────────────────
// The owner: Property Taxes jumps and then the same new amount posts every month
// after — that is a rate / assessment change. It still flags once (the increase
// has to be noticed) but it is labelled "new run rate since <month>", lowered one
// tier, and explained as a rate change rather than sitting in the top 10 as an
// emergency. A month "repeats" when it is within `tolerancePct` of the jump
// month; `repeatMonths` straight repeats make it a step change. All lines.
// Read by varStepChange in public/index.html.
const STEP_CHANGE = {
  tolerancePct: 0.05, // ±5% of the new amount counts as the same amount
  repeatMonths: 2,    // this many following months at the new amount → a new run rate
};

// ── From the 2026-10-06 meeting with the regional manager ──────────────────────────────────
// The quarterly sewer bill (2301 Willow Creek Rd, Apr→May) was correctly read as
// "the billing cycle" on the card, yet still sat at #1 Critical — and "qtr sewer"
// is the most common note on a resolved flag. So a jump that is the line's usual
// cycle spike at the usual size (or a seasonal climb last year made too) drops one
// tier and says so. It still flags. And the opposite case: the cycle bill that was
// due and never posted (2301 Willow Creek Rd, Aug 26) is now a flag of its own.
const CYCLE_READINGS = {
  demoteOnCycle: true,   // on-schedule, usual-size cycle spike / seasonal climb → one tier lower
  flagMissedCycle: true, // the due cycle bill did not post (it, and the month after, stayed low)
};

// 96/98 Maple Court management fees: three months of irregular entries — an accrual
// error, not three separate events. The line raises ONE card (its biggest move),
// so the card now says when the same line moved abnormally in this many or more
// months of the window.
const IRREGULAR_MONTHS = 3;

// Multi-year trend (meeting suggestion, payroll first): the line's last 12 months
// against the 12 before, and the 12 before that when the history reaches. Flags a
// run rate that grew by at least `pct` a year and `minImpact` dollars a year
// (scope-scaled). Lines opt in with `trendYoY`. The P&L pull holds a rolling 36
// months (propertyFinancials PULL_HISTORY_MONTHS, 2026-10-07), so there are always
// three full years: two year-over-year steps, and "up two years running" is High.
const RUN_RATE_TREND = { pct: 0.15, minImpact: 25000 };

// ── Importance score, 1–5 (2026-10-07; 1–5 since 2026-10-16, the owner) ─────────────────────────────
// Every flag gets a number on how much it matters, read off its own history: size
// (dollars and share of the scope's OpEx), the month against its T12 average, its
// YTD average and its usual range, the same month last year (did last year make the
// same move? then it is seasonal and scores low), and how recent it is. Readings
// the card already explains (billing cycle, seasonal, credited back, new run rate)
// take points off; a line that keeps swinging adds them. The top 10 is ranked by
// it. Read by varScoreFlag in public/index.html.
// 2026-10-07 audit readings: a blank month followed by a month at this multiple of
// normal was caught up (timing, one tier lower); the same flag at this many
// properties of one entity in the same month is one entity-wide issue.
const CATCH_UP_MULT = 1.6;

// ── Limits sized to the building (2026-10-19, the owner) ───────────────────────
// Every line's yearly-$ minimum and % gate follow the scope's own size: its
// operating expense over the last 12 complete months, against `ref` (a building
// spending $1M a year keeps the line's own numbers). Dollars scale with
// √(size ÷ ref), percent with (size ÷ ref)^−¼, each held to its range. So the
// median building (~$111K/yr) needs about a third of the dollars and ~1.7× the
// percent (the dollar factor never drops below impactMin, ⅓); Birchwood Commons (~$8.2M/yr)
// ~2.9× the dollars and ~0.6× the percent. Entities
// and the portfolio use the same rule with their own size (this replaces the
// flat ×1.5 / ×2 of SCOPE_TUNING while it is on). Read by varTune in index.html.
const SIZE_SCALE = {
  enabled: true,
  ref: 1000000,
  impactPow: 0.5, impactMin: 0.33, impactMax: 5,
  pctPow: 0.25,   pctMin: 0.5,    pctMax: 2,
};
const ENTITY_WIDE_MIN = 3;

// 2026-10-16: the scale is 1–5. Adjustments are in score points on that scale.
// timing*: a low month next to the flagged one whose two-month average is within
// timingNear × the T12 average reads as a bill landing a month early or late.
// Calibrated on the 2026-10-16 audit (16 Variances, each checked against the
// ledger): the two duplicates score 5, the Maple Court tax increase 4, and credited-
// back / billing-cycle / tiny jumps land at 1–3.
const SCORE = {
  weights: { size: 4, normal: 3, lastYear: 2, recency: 1 },
  fullAt: 0.7,          // share of the parts that already earns a 5
  explainedPenalty: 1,
  repeatedBonus: 0.5,
  timingPenalty: 1,
  timingNear: 1.25,
  timingLow: 0.6,
  shareFull: 0.02,      // 2% of the building's yearly OpEx fills the size part
  smallShare: 0.005,    // under 0.5% of it: half a point off
};

// Move-in / move-out: each month's count is compared to THAT SCOPE'S OWN trailing-
// 12-month average (property → entity → portfolio, each vs its own average) — not a
// unit-size tier. `watchMult` = flag when count ≥ this × the 12-mo average (🟡/🟠);
// `criticalMult` = red (🔴); `minCount` is a floor so a ~0/mo building doesn't
// scream at 2 move-outs. We scan every current-year month and surface the biggest
// spike per scope.
// 2026-07-22 meeting: ENTITY level only (a couple of move-ins at a 20-unit
// property is noise), and nothing under 5 moves ever flags.
const MOVE_AVG = {
  entityOnly: true,   // move signals evaluate at Entity scope only (no property/portfolio)
  moveOut:     { watchMult: 2.0, criticalMult: 3.0, minCount: 5 },
  moveInSurge: { watchMult: 1.75, minCount: 5 }, // positive signal
  // Occupancy declining (net move-outs > move-ins) stays a run-based signal:
  // this many consecutive complete months net-negative.
  occupancyDecline: { watchMonths: 2, criticalMonths: 3, minNetOut: 5 },
};

// ── Rows with no rule of their own (2026-08-25) ──────────────────────────────
// The grid draws lines the model has no entry for — the Operating Expense
// roll-up, Total Income and NOI (display-only since 2026-10-06), and the categories that are pulled but not
// tracked (REN Capital, Commissions, Mortgage Interest). Until now the only thing
// that could ever mark one of those cells was a negative, so a $10K jump on REN
// Capital painted exactly like a quiet month.
//
// These gates give those rows a CONTEXT mark (MOM_CELL.noted in the grid) — never
// a flag, never a bucket, never a tier. They are deliberately blunter than a
// tracked line's gates, because there is no per-line knowledge behind them: a move
// has to clear a percentage, an annualized dollar floor, AND still land outside the
// line's own trailing-12 range (the same ABNORMAL_Z step 2 every tracked line
// passes) before it earns a mark.
const UNTRACKED_ROW = {
  pct: 0.50,          // month-over-month move must be at least this big, proportionally
  minImpact: 60000,   // ...and this many annualized dollars (scope-scaled by SCOPE_TUNING)
};

// Urgency tiers shown as grouped sections in the tab. Order = most→least urgent.
const URGENCY_TIERS = [
  { key: 'critical', label: 'Critical', dot: '🔴', hint: 'Same-day look — a negative posting, a line way outside its normal.' },
  { key: 'high',     label: 'High',     dot: '🟠', hint: 'This week — a real cost spike beyond the season, a fee/insurance/tax change.' },
  { key: 'watch',    label: 'Watch',    dot: '🟡', hint: 'Monitor — a moderate move worth confirming on the monthly review.' },
  { key: 'info',     label: 'Info',     dot: '🔵', hint: 'Context — small/discretionary lines and positive signals.' },
];

// At aggregate levels loosen the % gate but demand more absolute dollars.
const SCOPE_TUNING = {
  Portfolio: { pctMul: 0.5, impactMul: 2.0 },
  Entity:    { pctMul: 0.7, impactMul: 1.5 },
  Property:  { pctMul: 1.0, impactMul: 1.0 },
};

const YOY_DEFAULT = { pct: 0.50, floorPctOfScale: 0.08, minFloor: 750 };

// ── Comparison modes (interpreted by the client detector) ────────────────────
//   'income'    — latest recent-run-rate vs recent normal (drop) + YoY growth-floor
//   'operating' — latest recent-run-rate vs recent normal, both directions per item
//   'seasonal'  — latest month vs the SAME calendar month in prior years (+ prior
//                 quarter), so normal seasonality / quarterly billing is subtracted out
//   'scheduled' — trailing-12 vs prior-12 (timing-proof), posting-gated

const TRACKED_ITEMS = [
  // ── Summary roll-ups ────────────────────────────────────────────────────────
  // 2026-10-06 (the owner): Total Income and NOI stay on the grid and on the rules
  // screen, but are NOT tracked — no flag, no cell colouring, no "noted" mark
  // (the old negative-NOI red cell is gone too). `displayOnly` pins that: the rules
  // screen cannot switch them on (finalize forces enabled:false).
  {
    key: 'totalIncome', label: 'Total Income', group: 'income', summary: true, enabled: false, displayOnly: true,
    mode: 'operating', direction: 'drop', urgency: 'critical',
    pct: 0.05, redPct: 0.10, minImpact: 150000,
    why: 'Shown for reference only — not tracked. Income problems surface through the lines that cause them.',
  },
  {
    key: 'noi', label: 'NOI', group: 'income', summary: true, enabled: false, displayOnly: true,
    mode: 'operating', direction: 'drop', urgency: 'critical',
    pct: 0.15, redPct: 0.30, minImpact: 120000,
    why: 'Shown for reference only — not tracked. The expense lines carry the detail.',
  },
  {
    // 2026-07-29 (the owner): NOT flagged. As a roll-up of every operating line it
    // inherits all of their lumpiness at once, so a jump here is almost always a
    // timing artifact rather than cost creep. Still displayed on the heatmap; the
    // individual category lines below carry the real signal.
    key: 'totalExpense', label: 'Operating Expense', group: 'expense', summary: true, enabled: false,
    mode: 'operating', direction: 'rise', urgency: 'high',
    pct: 0.20, redPct: 0.40, minImpact: 120000,
    why: 'Not flagged — too lumpy as a roll-up. See the individual expense lines.',
  },

  // ── Utilities — MoM: recent quarter vs the immediately prior quarter ────────
  // (July-2026: dropped the same-month-last-year comparison — a jump vs a recent
  // prior month matters more than what happened a year ago.)
  {
    // 2026-08-25 (the owner): the gate comes down to 15% — "at least 15% month-over-
    // month increase". This is THE leak line, and a 25% floor was letting a real
    // usage climb sit under the bar for a month or two before anyone saw it; on
    // water, those are the months that cost money. The false positive it invites
    // is the quarterly billing pattern (a $34K March against ~$27K in the months
    // either side), and that is already handled twice over: step 2 tests the new
    // value against the line's OWN trailing-12 range, so a building that bills
    // quarterly has a range wide enough to swallow its own cycle, and the drill-
    // down splits water / sewer / solid waste so a cycle is visible on the card.
    // 2026-09-03 (the owner, from the variance review): 2301 Willow Creek Rd came up
    // +$12K in a month and the answer, after looking at it, was *"looks like a
    // seasonal jump, considered normal"*. Water is seasonal here the way heat is —
    // summer irrigation, cooling, and the sewer charge that rides on metered
    // usage — and the tab had no way to say so, so a normal July cost a meeting
    // the same attention a leak would have.
    //
    // It stays flagged. A gate loosened for a season is a gate that misses the
    // leak that starts in that season, and 15% is the leak gate on purpose. What
    // changes is that the card now carries the same two months a year earlier, so
    // "this is what July does here" and "this building is losing water" are told
    // apart on the card instead of by someone's memory.
    key: 'waterSewer', label: 'Water & Sewer', group: 'expense', glRefs: ['5402'], isLumpy: true,
    mode: 'operating', direction: 'rise', urgency: 'high',
    pct: 0.15, redPct: 0.50, minImpact: 40000,
    subRefs: { water: '5402-1', sewer: '5402-2', solidWaste: '5402-3' },
    // 2026-10-06: sewer is billed quarterly here, so the billing-cycle reading and
    // the missed-cycle-bill flag apply to this line (spaced spikes on a repairs
    // line are jobs, not a bill — those lines do not carry this).
    billsOnCycle: true,
    seasonalYoYContext: true,
    seasonalYoYTitle: 'Season, or a leak?',
    seasonalYoYExample: 'so "this is what summer does at this building" and "this building is losing water" can be told apart without leaving the flag',
    why: 'THE leak signal. A month that jumps against the month before it AND lands outside this line’s own trailing-12 range is a leak, a rate change or a meter problem until proven otherwise. Water is seasonal, so a flag carries the same two months last year — a summer climb the building made last year too is the season. Drill in to see whether Water, Sewer or Solid Waste drove it.',
  },
  {
    // 2026-07-29 (the owner): heat is off all summer, so a $0 in Jun/Jul/Aug is the
    // building working correctly, not a posting hole — exempt those calendar
    // months from the "Zeroed Out" check. Rises still flag normally year-round.
    // `seasonalYoYContext` (2026-07-29, the owner): heat is weather-driven, so a rise
    // means nothing until you know what the same months did last year. A flag on
    // this line carries the prior-year same-two-months comparison in the card, so
    // "it was a cold February" and "something is wrong with the boiler" can be
    // told apart without leaving the flag.
    key: 'heatingGas', label: 'Heating Gas', group: 'expense', glRefs: ['5401'],
    mode: 'operating', direction: 'rise', urgency: 'watch', zeroOkMonths: ['Jun', 'Jul', 'Aug'],
    seasonalYoYContext: true,
    seasonalYoYTitle: 'Weather, or ours?',
    seasonalYoYExample: 'so "it was a cold February" and "something is wrong with the boiler" can be told apart without leaving the flag',
    pct: 0.30, redPct: 0.60, minImpact: 40000,
    why: 'A rise against the month before it, beyond this line’s own normal range — a rate hike, or a boiler running when it should not be. Weather decides this line, so a flag carries the same two months last year for comparison. $0 in Jun/Jul/Aug is the heating season being over and is never flagged.',
  },
  {
    key: 'electric', label: 'Electric', group: 'expense', glRefs: ['5404'],
    mode: 'operating', direction: 'rise', urgency: 'watch',
    pct: 0.30, redPct: 0.60, minImpact: 30000,
    why: 'A rise against the month before it, beyond this line’s own normal range — usually a meter problem, a rate change, or equipment left running.',
  },

  // ── Operating expenses — MoM vs recent normal ────────────────────────────────
  {
    key: 'repairsMaint', label: 'Repairs & Maint.', group: 'expense', glRefs: ['5100'],
    mode: 'operating', direction: 'rise', urgency: 'watch',
    pct: 0.50, redPct: 1.00, minImpact: 60000,
    why: 'Naturally choppy, so we only flag a recent run rate well above the property’s own normal — a sustained burst worth explaining (a recurring problem, or invoices booked to the wrong building).',
  },
  {
    // 2026-07-22 meeting rewire: a single $0 month is NOT a flag (that's a fine
    // month with no turns). What flags: a HIGH swing (the variance gate below),
    // or $0 for 3 straight months (with normal turnover, three silent months
    // usually means costs are landing in another line).
    key: 'turnover', label: 'Turnover', group: 'expense', glRefs: ['5106'],
    mode: 'operating', direction: 'rise', urgency: 'watch', zeroRunMonths: 3,
    pct: 0.60, redPct: 1.20, minImpact: 40000,
    why: 'Tracks move-outs. Flags only when it swings HIGH (a cluster of vacancies at this building), or when it posts $0 for 3 straight months — a single quiet month is normal.',
  },
  {
    key: 'mgmtFees', label: 'Management Fees', group: 'expense', glRefs: ['5000'],
    mode: 'operating', direction: 'both', urgency: 'high', postingGateDays: POSTING_GATE_DAYS,
    pct: 0.25, redPct: 0.50, minImpact: 40000, flagZero: true,
    why: 'Fees should track collections. Months inside the posting window are left alone while accounting trues them up; after that a move either way — up without an income rise, or down unexpectedly — is usually a posting error, a lumped payment covering two months, or an unapproved fee change.',
  },
  {
    key: 'payroll', label: 'Payroll', group: 'expense', glRefs: ['5700'],
    mode: 'operating', direction: 'both', urgency: 'watch', trendYoY: true,
    pct: 0.25, redPct: 0.50, minImpact: 50000, flagZero: true,
    why: 'Staffing is steady. A shifted run rate means a hire, sustained overtime, or someone reallocated between properties — worth confirming it was intended.',
  },
  {
    key: 'propTax', label: 'Property Taxes', group: 'expense', glRefs: ['5301'], isLumpy: true,
    mode: 'scheduled', direction: 'rise', urgency: 'high', postingGateDays: POSTING_GATE_DAYS,
    pct: 0.20, redPct: 0.40, minImpact: 75000,
    why: 'Posts as one big annual bill, so recent months are left alone while accounting posts it. We flag INCREASES — a reassessment; a drop almost always just means this year’s bill has not landed yet. Switch “flag when it moves” to either way to catch appeal-win drops too.',
  },
  {
    key: 'insurance', label: 'Insurance', group: 'expense', glRefs: ['5050', '5051'], isLumpy: true,
    mode: 'scheduled', direction: 'rise', urgency: 'high', postingGateDays: POSTING_GATE_DAYS,
    negCompareYoY: true,
    pct: 0.25, redPct: 0.50, minImpact: 60000,
    why: 'Premiums post as big annual/semi-annual payments; months inside the 60-day posting window are left alone while accounting trues them up. A big CREDIT is compared to the same month last year — renewals repeat annually, so a similar credit is normal and only a way-different one flags.',
  },
  {
    key: 'advertising', label: 'Advertising', group: 'expense', glRefs: ['5001'],
    mode: 'operating', direction: 'rise', urgency: 'info',
    pct: 1.00, redPct: null, minImpact: 30000,
    why: 'Discretionary and small; only a large sustained overrun matters — usually a vacancy push that should line up with the turnover / move-out story. Info tier.',
  },

  // ── Non-operating (below NOI) ───────────────────────────────────────────────
  {
    key: 'mgmtWages', label: 'Management Wages', group: 'nonop', glRefs: ['5710'],
    mode: 'operating', direction: 'both', urgency: 'watch', trendYoY: true,
    pct: 0.30, redPct: 0.60, minImpact: 50000, flagZero: true,
    why: 'Like payroll — management salaries barely move legitimately. A shifted run rate is usually a reallocation between entities; confirm it was intended.',
  },
  {
    // 2026-07-22 meeting rewire: keeping major repairs LOW is a good thing, so
    // no averaging and no run-rate math for this line. It flags on exactly one
    // condition: a single month at/above `monthAbs` dollars (2× that → red).
    // Low months, zero months, and gradual drift never flag.
    key: 'majRepairs', label: 'Major Repairs', group: 'nonop', glRefs: ['5150'], isLumpy: true,
    mode: 'operating', direction: 'rise', urgency: 'watch', monthAbs: 20000,
    pct: 0.60, redPct: 1.20, minImpact: 75000,
    why: 'One big month = one big event (roof / boiler / elevator scale) worth a heads-up even when legitimate. No 12-month averaging on this line — keeping it low is good, so only a high single month flags.',
  },
  {
    key: 'renCapital', label: 'REN Capital', group: 'nonop', glRefs: ['6100'], isLumpy: true, enabled: false,
    mode: 'operating', direction: 'rise', urgency: 'info',
    pct: 1.00, redPct: null, minImpact: 100000,
    why: 'Renovation capex is planned project spend — variances are almost always intentional. OFF by default.',
  },
  {
    key: 'commissions', label: 'Commissions', group: 'nonop', glRefs: ['5040'], enabled: false,
    mode: 'operating', direction: 'rise', urgency: 'info',
    pct: 1.00, redPct: null, minImpact: 50000,
    why: 'Leasing commissions track new leases — a spike is usually good news (a leasing burst). OFF by default.',
  },

  {
    // Pulled and shown on the grid; OFF for flagging per the July-2026 spec. It is
    // listed here (2026-10-06) so the rules screen shows EVERY line on the P&L and
    // whoever wants it watched can switch it on rather than file a change.
    key: 'mortgage', label: 'Mortgage Interest', group: 'nonop', glRefs: ['6230'], isLumpy: true, enabled: false,
    mode: 'operating', direction: 'rise', urgency: 'info',
    pct: 0.25, redPct: null, minImpact: 60000,
    why: 'Debt service, set by the loan — not an operating variance. OFF by default; switch on to catch a rate reset or a missed/double payment.',
  },
];

// 2026-10-06 (the owner, later): the "every other line on the P&L" section is gone.
// Tracking is the main lines above only; the gl:<ref> series are still pulled
// (propertyFinancials.topLevelLines) but nothing here turns them into items.
// Totals are unaffected — Total Income / OpEx are summed from every leaf row in
// propertyFinancials.parseSeries, not from this list.
function rawItems() { return TRACKED_ITEMS.slice(); }

function finalize(item) {
  const defaultDir = item.group === 'income' ? 'drop' : 'rise';
  return {
    ...item,
    enabled: item.displayOnly ? false : item.enabled !== false,
    direction: item.direction || defaultDir,
    mode: item.mode || 'operating',
    urgency: item.urgency || 'watch',
    // Each check can now be switched off per line (rules screen); a negative on an
    // income line is off unless someone switches it on for that line.
    flagVariance: item.flagVariance !== false,
    flagNegative: item.flagNegative === true || (item.flagNegative !== false && FLAG_NEGATIVES && item.group !== 'income'),
    flagZero: !!item.flagZero && item.group !== 'income', // "went to zero" only on flagged non-income lines
    yoy: item.yoy || YOY_DEFAULT,
  };
}

const CONFIG = TRACKED_ITEMS.map(finalize);   // the named lines (static)

// The raw items, BEFORE finalize() fills in the derived fields. Rule overrides
// (services/varianceRuleOverrides.js) merge onto these and then re-finalize, so an
// edited rule goes through exactly the same derivation as a default one — an
// override that sets `group: 'income'`-adjacent behaviour cannot end up bypassing
// the rules finalize() enforces (income lines never flag zeros, and so on).
const RAW_ITEMS = TRACKED_ITEMS.slice();

function getConfig() {
  return {
    items: rawItems().map(finalize),
    model: {
      flagWindowMonths: FLAG_WINDOW_MONTHS,
      recentMonths: RECENT_MONTHS,
      baselineMonths: BASELINE_MONTHS,
      seasonalYears: SEASONAL_YEARS,
      expenseInflation: EXPENSE_INFLATION,
      postingGateDays: POSTING_GATE_DAYS,
      flagNegatives: FLAG_NEGATIVES,
      negMinAbs: NEG_MIN_ABS,
      maxDisplayPct: MAX_DISPLAY_PCT,
      materiality: MATERIALITY,
      scopeTuning: SCOPE_TUNING,
      urgencyTiers: URGENCY_TIERS,
      categories: CATEGORIES,
      zeroDrop: ZERO_DROP,
      cycle: CYCLE,
      moveAvg: MOVE_AVG,
      abnormalZ: ABNORMAL_Z,
      negYoY: NEG_YOY,
      untrackedRow: UNTRACKED_ROW,
      // Flat so the rules screen can edit them (varianceRuleOverrides MODEL_FIELDS).
      creditBackMonths: CREDIT_BACK.lookMonths,
      creditBackNotePct: CREDIT_BACK.notePct,
      creditBackMostPct: CREDIT_BACK.mostPct,
      creditBackClears: CREDIT_BACK.clears,
      closeDay: REVIEW_CYCLE.closeDay,
      reviewDay: REVIEW_CYCLE.reviewDay,
      stepTolerancePct: STEP_CHANGE.tolerancePct,
      stepRepeatMonths: STEP_CHANGE.repeatMonths,
      demoteOnCycle: CYCLE_READINGS.demoteOnCycle,
      flagMissedCycle: CYCLE_READINGS.flagMissedCycle,
      irregularMonths: IRREGULAR_MONTHS,
      trendPct: RUN_RATE_TREND.pct,
      trendMinImpact: RUN_RATE_TREND.minImpact,
      score: SCORE,
      sizeScale: SIZE_SCALE,
      catchUpMult: CATCH_UP_MULT,
      entityWideMin: ENTITY_WIDE_MIN,
    },
    defaults: { yoy: YOY_DEFAULT },
  };
}

module.exports = {
  TRACKED_ITEMS: CONFIG, RAW_ITEMS, rawItems, finalize, getConfig, FLAG_WINDOW_MONTHS,
  RECENT_MONTHS, BASELINE_MONTHS, SEASONAL_YEARS, EXPENSE_INFLATION,
  POSTING_GATE_DAYS, FLAG_NEGATIVES, NEG_MIN_ABS, MAX_DISPLAY_PCT, MATERIALITY,
  SCOPE_TUNING, URGENCY_TIERS, YOY_DEFAULT,
  CATEGORIES, ZERO_DROP, MOVE_AVG, ABNORMAL_Z, NEG_YOY, UNTRACKED_ROW, CREDIT_BACK, STEP_CHANGE, REVIEW_CYCLE,
  CYCLE_READINGS, IRREGULAR_MONTHS, RUN_RATE_TREND, SCORE, SIZE_SCALE, CATCH_UP_MULT, ENTITY_WIDE_MIN,
};
