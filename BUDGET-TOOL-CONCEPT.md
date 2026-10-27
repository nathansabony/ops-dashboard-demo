# 12-Month Budget Tool — Status & Review List

*Built and live on the Budget tab as of 2026-07-27. This doc is now the review
list for the regional manager: what the tool does, what it assumed on your behalf, and the six
answers that turn it from "a reasonable default budget" into "matches how you
actually think about these buildings."*

---

## What's built

The Budget tab used to hold hand-typed numbers for 4 of 13 entities, with an
Actual column that was always empty. That's gone. It now generates a live
12-month budget for **every entity plus a portfolio roll-up**, projected from the
same Rent Manager feed (Report 45, accrual) that powers the Variance tab.

| Piece | Where |
|---|---|
| Assumptions layer — every rate, default and override | [`services/budgetAssumptions.js`](services/budgetAssumptions.js) |
| Projection engine | [`services/budgetModel.js`](services/budgetModel.js) |
| Excel model writer | [`budget/budget_workbook.py`](budget/budget_workbook.py) |
| Per-entity unit counts (for $/unit benchmarks) | [`services/unitCounts.js`](services/unitCounts.js) |
| Frozen set — build once, serve from disk | [`services/budgetStore.js`](services/budgetStore.js) |
| One-shot build | `npm run budget:build` ([`scripts/buildBudgetSet.js`](scripts/buildBudgetSet.js)) |
| API | `GET /api/budget`, `/api/budget/files`, `/api/budget/assumptions`, `/api/budget/:scope/excel`, `POST /api/budget/rebuild` |
| Tab | Budget — all numbers render on open, per-entity Excel download |

### This is a built set, not a live tool

The budgets and workbooks are generated **once** and served from disk. Opening the
tab recomputes nothing and calls Rent Manager zero times — enforced by
[`scripts/checkBudgetNoRmCalls.js`](scripts/checkBudgetNoRmCalls.js) (`npm run
check:budget-no-rm`), which counts every outbound request across 27 tab loads and
28 downloads and fails if a single one reaches RM.

That's deliberate, for two reasons. Opening a tab shouldn't spend API budget — an
earlier cut read the snapshot through a self-healing accessor that would kick off
a ~89-call refresh whenever the data was over 30 minutes old. And a budget under
review has to hold still: if the tab recomputed on every open, the numbers on
screen would drift away from workbooks already downloaded and emailed.

```
npm run budget:build     # ~11s — all 14 budgets + workbooks into data/budget/
```

Everything after that is a file read. Rebuilding is always explicit (the command
above, or `POST /api/budget/rebuild`), never a side effect of looking at it. The
build reads the P&L snapshot **passively** and refuses to run rather than trigger
an RM pull, so refreshing actuals stays a separate, deliberate act:

```
curl -X POST '<host>/api/financials/property-monthly/recompute'   # ~89 report runs
npm run budget:build                                              # 0 RM calls
```

### Refreshing data is one button, and it doesn't touch the budget

The same logic applies one level down. RM Report 45 returns monthly accrual
figures, and **a closed month's numbers never change** — only the current month
moves, as postings land, which is a once-a-day event at most.

It used to re-pull whenever the snapshot was over 30 minutes old, triggered both
by the cache warmer and by any page hit: ~89 report runs a refresh, 48 refreshes a
day, **~4,300 report runs daily** running around the clock whether or not anyone
opened the site — to re-fetch numbers that were already correct. It is now
**daily** (`PL_AUTO_REFRESH_MS`), which keeps the NOI figures on Overview and
Entity Detail current at ~89 runs a day instead of ~4,300.

For anything more immediate there's **one refresh button in the header**
(`POST /api/refresh`). The site reads six independent RM caches, each of which
used to decide on its own when to go back — which is how the P&L ended up pulling
48 times a day with nobody watching the total. Now they refresh together, so
"how current is this data" has a single answer, and the button's tooltip lists
each source, when it last pulled, and what it costs.

**The refresh button deliberately skips the budget set.** Refreshing data must
never silently move numbers already reviewed and emailed out, so rebuilding the
budgets is its own button on the Budget tab.

`npm run check:budget-no-rm` guards all of this against a deliberately stale
snapshot (it refuses to pass against a fresh one, where a zero result would prove
nothing): the budget paths make zero calls, page loads don't each trigger a
refresh, and the P&L cadence is daily or slower.

### How a number is built

```
  1. BASE        each line's own prior-calendar-year actuals, per entity
  2. SEASONALIZE that line's own within-year shape (August gas ≠ February gas)
  3. GROW        per-line annual rate, from the CENTRE of the base window
  4. EVENTS      reassessments / renewals / capital, on the month they hit
  5. DEBT        amortised P&I — the one input the P&L feed doesn't carry
```

Three decisions worth knowing, because they're the ones you'd otherwise have to
reverse-engineer from the numbers:

- **Year 1 is the calendar year, and the window holds still.** The obvious design
  — start the horizon after the last actual — produces a rolling *forecast*, and
  it silently kills budget-vs-actual forever: the window slides forward every
  refresh, so no month can ever close inside it. Anchoring Year 1 to the calendar
  year means closed months land inside the budget and **the Actual column fills
  itself in**. That's what kills the manual "closed and verified" entry.
- **No vacancy percentage.** The income base is *actual billed* income; vacant
  units are never billed, so the base already carries each building's real
  occupancy. Subtracting a vacancy % on top would double-count the loss. Bad debt
  (billed but uncollected) is separate, and *is* subtracted.
- **"Other Operating Expense" is a residual.** Actual total opex less every mapped
  line. Whatever RM books outside our account map lands there instead of
  disappearing, so the projection can't drift from the real total.

### The Excel model

One workbook per entity, download button on the tab. It is a **live model, not a
value dump** — every projected cell is a formula reading Base Actuals ×
seasonality × Assumptions. Change 8% to 11% on the Assumptions tab and all twelve
months, the Full Year column and the NOI margin move with it.

**Three tabs, as of the 2026-08-03 rewrite** (down from eight):

| Tab | What it's for |
|---|---|
| **Budget** | The model. Twelve months + a Full Year column. |
| **Assumptions** | The only tab meant to be typed in. Blue cells are inputs; each one carries its benchmark source. |
| **Base Actuals** | The real trailing twelve months everything is built on. |

Seasonality is still applied — each line keeps its own within-year shape — but the
factors are now written straight into the formulas as constants rather than
living on their own tab. Event Calendar, Debt Service, Budget vs Actual and
Summary are gone; see "What changed in the 12-month rewrite" below.

**The tab and the workbook cannot disagree.** They're two independent
implementations — JavaScript and Excel formulas — so
[`scripts/verifyBudgetWorkbook.py`](scripts/verifyBudgetWorkbook.py)
recalculates the generated workbook and asserts every cell against the engine.
Per-entity workbooks match to **$0.00** across 372 checked cells; the portfolio
matches within the roll-up rounding band. This now runs on every
`npm run budget:build` and a mismatch fails the build.
[`scripts/checkBudgetModel.js`](scripts/checkBudgetModel.js) (`npm run
check:budget`) separately enforces that every total equals the sum of its own
lines and that the portfolio equals the sum of its entities, exactly.

---

## What changed in the 12-month rewrite (2026-08-03)

The tool was built as a 36-month model. It is now a **12-month** model, and
simpler on purpose.

| Before | After |
|---|---|
| 36 months + Year 1/2/3 roll-ups | 12 months + one Full Year column |
| 8 workbook tabs | 3: Budget, Assumptions, Base Actuals |
| Seasonality on its own tab | Same factors, written into the formulas as constants |
| Event Calendar (`set` / `add` / `stepPct`) | Gone — type a one-off over the month's cell |
| Debt Service tab, amortised P&I | Gone — bottom line is Cash Flow BEFORE debt service |
| Budget vs Actual tab in the workbook | Gone from the workbook; still on the website tab |
| Summary tab | Gone; the "how to use this" note sits under the Budget grid |
| ~2,600 formula cells per workbook | ~420 |

Nothing about *how a number is built* changed: same base, same seasonality, same
growth-from-the-centre-of-the-window arithmetic, same tie-outs. `npm run
check:budget` passes unchanged.

Both removed features are recoverable — `git revert` the rewrite commit, or lift
`EVENT_CALENDAR` / `DEBT_SERVICE` out of the pre-rewrite
`services/budgetAssumptions.js`.

### Fixed: the portfolio workbook now ties to the portfolio tab

It didn't, for the tool's whole life. Three entities carry an income-growth
override (an entity in a hotter market at 6% vs the 5% default). The engine
builds the portfolio as the exact sum of the entity budgets, each grown at its own
rate — but a roll-up *workbook* has one Assumptions tab, so it grew the aggregate
base at a single `inc_growth`. The 36-month version drifted **$905,667 by Year 3
across 201 cells**; nobody knew, because `verifyBudgetWorkbook.py` was a manual
script and `budget:build` never called it.

Both halves are now fixed.

**1. Growth cohorts.** `growthCohorts()` in `services/budgetModel.js` groups a
roll-up's children by the rate they actually use for each line and emits one
weight per group per calendar month. The workbook writes the line as a sum of real
terms:

```
=ROUND('Base Actuals'!$P$5*(0.583852139*POWER(1+inc_growth,0.5417)
                           +0.410693153*POWER(1+inc_growth_2,0.5417)),0)
```

which is algebraically the engine's own Σₑ(avgₑ · idxₑ[m] · (1+gₑ)ᵗ). Both rates
stay live input cells — the portfolio Assumptions tab gains a **SPLIT GROWTH
RATES** block naming which entities each rate covers — so the workbook is still a
model, not a value dump. With one rate it collapses to the single-term form, so
uniform portfolios and all 13 entity workbooks are byte-for-byte unaffected.

Residual drift is now **$10 on a Full Year figure** — the arithmetic of summing 13
dollar-rounded children versus rounding once, which is what the verifier's derived
tolerance band ($8/month, $781/year at 13 entities) exists to allow.

**2. The check runs.** `budgetStore.runWorkbook()` verifies every workbook the
moment it generates it, and a mismatch fails the build. It costs ~1s per workbook.
A missing `formulas` package downgrades to a loud warning rather than a silent
pass — set `UNDERWRITING_PYTHON=./venv/bin/python3` (see `.env.example`).

---

## What the model does NOT know — the meeting agenda

Everything below is a real gap, not a rough edge. In rough order of how much
accuracy each one buys:

### 1. One-off dated items are not in the budget — biggest lever by far

Taxes, insurance and capital are **event-driven, not run-rate**. A projection
cannot know a reassessment is coming, so the budget quietly assumes nothing
happens all year.

The 36-month model had an Event Calendar tab for this. It shipped empty for its
whole life and cost more formula complexity than every other feature combined, so
the 12-month rewrite dropped it. Over a twelve-month window a one-off is simpler
to state than to model: **type the number straight over that month's cell** in the
workbook. Every total above it is a live SUM, so NOI and cash flow follow.

**What I need:** which properties have tax reassessments, insurance renewals, or
planned capital in the next twelve months — roughly when, roughly how much.

Related: **Major Repairs and Capital Expenditure are budgeted at $0** by design —
last March's roof is not a monthly run-rate. On the tab you'll see the base year's
real spend next to $0 in the budget year. That contrast is deliberate: it's the
"you spent this, and we've budgeted nothing because we don't know the plan"
prompt.

### 2. Rent control caps are not applied per entity

Income growth is one rate (default 3%). But the cap depends on the municipality:

- **A rent-stabilised city**, buildings 5+ units → lesser of CPI or a fixed cap (for example 4%)
- Newer construction / small owner-occupied → exempt

Until each entity is tagged to its municipality, **3% may exceed what is legally
collectable on in-place units.** For context, Yardi projects only ~0.5%
advertised-rent growth nationally in 2026, so 3% is already the optimistic end.

**What I need:** which entities sit under which ordinance. Then it's one line each
in `ENTITY_OVERRIDES`.

### 3. Debt service is out of scope

RM's P&L carries mortgage *interest* (GL 6230) but not principal, so P&I cannot be
derived from the feed. The 36-month model had a Debt Service tab that amortised
entered loan terms; it shipped empty for its whole life and the 12-month rewrite
removed it. The bottom line is now labelled **Cash Flow BEFORE Debt Service**, and
booked interest is shown as an unsummed memo line. NOI is unaffected either way.

**If this should come back:** current monthly P&I per entity, or balance / rate /
amortisation, and the tab can be restored from the pre-rewrite history.

### 4. Income has no rental / subsidised / commercial split

RM's account map gives one operating-income total per property. Splitting it needs
income GL reference numbers added to `CATEGORY_REFS` — a small change once we know
the account numbers, but not guessable.

### 5. Defaults I chose that you may want to move

| Assumption | Default | Why, and what I'd want confirmed |
|---|---|---|
| Income growth | 3% | House standard, or set separately from expenses? See rent control above. |
| Vacancy | budget each building at its **own** actual occupancy | Or budget everything to a portfolio target (e.g. 95%)? |
| Bad debt | 1% of billed | NAA national is 0.35%, but that's premium-managed stock. Tune against our own % Collected figures. |
| Insurance growth | 8%/yr | 7–10% is the industry range; do our renewals actually run that hot? |
| Management fee | grown from what RM books | Or recompute as a % of collections? (4–5% is the portfolio-scale benchmark; we're currently booking ~3%.) |
| Replacement reserves | $300/unit/yr | Agency minimum is $250; $300 reflects older stock. |
| Contingency | **0%** | Benchmarks suggest 3–5%, but that cushion absorbs *estimate* error and this model runs on real actuals. A hidden pad also blunts budget-vs-actual, which is the point of the tab. Ships visible and off. |
| Conservatism | budget to plan | Do you want a second, haircut version for lenders? |

### 6. Benchmark checks that are already flagging

The Summary tab compares Year 1 against `BUDGET-BENCHMARKS.md` and says where we
sit outside the published range. Outside isn't automatically wrong — an an older
walk-up genuinely spends more on R&M and insurance than the national average — but
each one is worth a sentence:

- **Insurance** runs above the $750–$1,100/unit/yr benchmark
- **Management fees** run below the 4–5% of collections benchmark
- **Marketing** runs below $150–$350/unit/yr (plausible: high retention means
  fewer units to re-market)
- **NOI margin** sits above the 45–52% target for older stock

---

## Changing anything

Every knob is in [`services/budgetAssumptions.js`](services/budgetAssumptions.js)
— edit and reload, the tab picks it up. Change it in the downloaded workbook
instead and only that workbook moves, which is the right way to test an idea
before making it everyone's default.
