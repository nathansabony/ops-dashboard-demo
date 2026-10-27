# Variance Flagging Model (v4) - how the Variances tab decides what to flag

*Reference for the Cedar Ridge Management demo. The numbers on the tab are fictional; the rules are the real ones the site runs.*

Report 45 (Rent Manager's monthly P&L) is pulled on **Basis 1 = Accrual**. To check any property, export its 12-Month Recap (Accrual, collapse parents off) and compare month by month; the tab matches it on every account.

## What changed in v4 (the month-over-month rewrite)

The flag **trigger is now purely month-over-month** — a line flags when a month
moved against the **immediately prior month**, full stop. No run-rate windows, no
same-month-last-year comparisons ("a lot changes in a year"). Historical averages
are still computed and shown, but **only to justify a flag after the fact, never
to raise one.** And the scan now covers **every complete month of the current
year (2026)**, not just the last three — a weird drop back in February surfaces
the same as one last month.

## Four categories, one button each

| Button | What lands here | How it fires |
|---|---|---|
| **📈 Variances** | A line jumped or dropped vs. the **prior month** | MoM change past the line's $ floor and % gate. The single biggest move per line per scope is bucketed; the heatmap colours any smaller ones. |
| **➖ Negatives / Credits** | Every negative **of $100 or more** on any line, any 2026 month | A negative was actually posted, so there's no data-lag exception — each one is its own flag to confirm (credit, reversal, refund, mis-post). Under $100 is rounding noise and is dropped entirely (`NEG_MIN_ABS`). |
| **⭕ Zeroed Out** | A **normally-present** line where **nothing was posted at all** | "Somebody forgot to enter it." Blank means blank (`zeroAbs` $1) — a real charge of any size is a real charge and never lands here. "Normally present" is read from the data (most of the trailing 12 months carry a real value), so lines legitimately $0 most months — sporadic management fees, quarterly bills, capex — never qualify. **One card per property per line**, listing every blank month. The just-closed month is skipped (the "June isn't entered yet" case). |
| **🚪 Move-ins / outs** | Move-in / move-out volume | Each month's count vs that scope's own trailing-12-month average (see below). |

Knobs live in [`services/varianceConfig.js`](services/varianceConfig.js): per-line
`direction` / `pct` / `redPct` / `minImpact` / `group`, plus `ZERO_DROP`
(`nearZeroAbs`, `minPriorMonthly`) and `MOVE_AVG`.

## How a variance flag is built — two steps (updated 2026-07-22)

1. **Step 1 — month-over-month move.** Compare each 2026 month to the month right
   before it. If the dollar change clears the line's `minImpact` (scope-scaled)
   **and** the % change clears its `pct` gate, it's a *candidate*.
2. **Step 2 — is that move actually abnormal?** The candidate only survives if the
   new value lands **outside the line's own normal range** — at least `ABNORMAL_Z`
   (default **1.5**) standard deviations from its trailing-12 mean, in the move's
   direction. A move that stays inside the line's usual swing is dropped. *Example:
   Advertising jumps $30K to $50K, but it normally bounces $20K–$65K (avg ~$36K),
   so $50K is inside normal → **not** flagged.* This is what clears the noise out
   of the list.
3. **Both steps are shown on the card.** "Step 1 — went up $30K this month to $50K.
   Step 2 — vs its own last 12 months (normal range ~$16K–$56K) that's inside
   normal / outside normal." So every flag explains *why the move mattered*, not
   just that it happened.
4. **Name the month + tier.** The card names the exact month; clicking it outlines
   that one cell. Direction rules + urgency tier: 🔴 Critical · 🟠 High · 🟡 Watch
   · 🔵 Info (a move ≥ 2× the abnormal-Z threshold is bumped to red).

Negatives and zeros skip step 2 — they're anomalies by definition (see their
buckets). Step 2 applies to the 📈 Variances bucket and to the heatmap colours, so
a normal-range move is neither flagged nor coloured.

## Color coding — every 2026 P&L cell

The heatmap now colours each current-year cell so the whole board reads at a glance:

- 🟨 **Yellow** — an anomaly: a **negative** number, or a **weird $0** (a
  normally-present line that dropped to ~$0).
- 🟥 **Red** — a **bad** month-over-month move: income **down**, or an expense
  **up** (an expense rising is really a negative, so it's red not green).
- 🟩 **Green** — a **good** move: income **up**, or an expense **down**.
- 🩶 **Noted** (2026-08-25) — the same anomaly on a cell the detector does not
  TRACK: a prior-year column, a month inside the posting gate, the in-progress
  month, or a row with no rule. Context, never a flag; see the 2026-08-25 section
  above. Prior-year cells are still never *flagged*, and never take a verdict
  colour.
- Cells with no material move stay uncoloured — and so does a cell the detector
  examined and judged normal. That silence is a verdict, which is what keeps the
  noted mark meaningful.

## Always-on rules

- **Every negative of $100+ flags**, on any line, any 2026 month — collected under
  the **➖ Negatives / Credits** button and coloured yellow in the grid. Smaller
  credits are dropped entirely (no flag, no colour).
- **Data-completeness guard on the just-closed month.** A partially-posted line
  reads *low*, and missing postings only ever understate, so on the newest
  complete month a **raw drop is suppressed** (it's usually "not fully entered
  yet") while a **rise still flags** (you can't post more than reality). This —
  plus the normally-present test on zeros — is what stopped the board from
  reading as one giant false-flag wave right after month-end. Concretely: right
  after July closes, a June drop/zero is held; once August closes and June is
  still off, it flags for real.
- **Mortgage Interest is removed from all flagging** (still displayed).
- **Trailing-12 view:** the heatmap shows each scope's rolling 12 months (plus
  MTD), so last winter is always on screen for context even though only 2026
  cells flag.

Trade-off worth watching: with no seasonal/annual normalization, a quarterly- or
annually-billed line (property taxes, insurance, some water/sewer e.g. 409-13-17
54th St) will now show a MoM flag each cycle it posts — the historical-average
line in the card is there to say "this is the normal annual bill."

## Automated drill-down (replaces "next step" text)

Opening an **entity** or **portfolio** flag computes the breakdown right in the
banner: which properties (or entities) drove it — each child's value **in the
flag's month vs the month before** and its share of the move, with reasoning
("X alone accounts for ~70% — start there"). Click any row to jump to that scope.

**Water & Sewer** also splits by sub-bill — **Water (5402-1) vs Sewer (5402-2)
vs Solid Waste (5402-3)** — so "which bill flew up" is answered directly.
(Vendor-level detail would need AP data — not wired.)

## Move-in / move-out signals (from /Leases actual dates)

Its own **🚪 Move-ins / outs** button. Each month's count is compared to **that
scope's OWN trailing-12-month average** — at **property, then entity, then
portfolio**, each vs its own average (updated 2026-07-22, replacing the unit-size
tiers). Knobs in `MOVE_AVG`:

- **Move-out spike** — a month's move-outs ≥ **2×** its trailing-12 average →
  🟠 High; ≥ **3×** → 🔴 Critical. A **min-count floor of 3** stops a building
  that averages ~0.5/mo from screaming at 2 move-outs. We scan every current-year
  month and surface the biggest spike per scope. Fires at property, entity, and
  portfolio (each vs its own average).
- **Occupancy declining** — move-outs exceed move-ins **2+ months in a row** →
  High; 3+ months → Critical (`MOVE_AVG.occupancyDecline`).
- **Move-in surge** — a month's move-ins ≥ **1.75×** the property's trailing-12
  average (min 3), **property level only** → 🔵 Info, a leasing compliment.
  (Entity/portfolio move-in totals were dropped — a portfolio-wide count isn't
  actionable; nobody can act on "143 move-ins across the whole portfolio.")
- Move-in/move-out **count rows** appear at the bottom of the heatmap, aligned
  to the same months as the dollar rows.


## Who to ask

Every flag card shows a contact for its category and entity (utility usage goes to the property manager, insurance and taxes to accounting, move-ins to the leasing team). The directory is display-only in the demo; in a live install it comes from the company's own contact sheet.

## Entities

The demo has one entity, `Cedar Ridge`, holding five properties (The Alder, Maple Court, Willow Creek, Birchwood Commons, Summit Lofts). A live install can group properties into any number of entities, and `config/property-merges.json` can read several Rent Manager properties as one building.

## Open questions for tuning

1. MoM `pct` gates and `minImpact` dollar floors per line - retune if flags feel too jumpy.
2. `ZERO_DROP` cutoffs and the "normally present" bar (>=60% of trailing-12 months carry a value).
3. Move-out multiples vs the trailing-12 average (2x High, 3x Critical, min count 3) and the 1.75x move-in surge.
4. Whether only the biggest MoM move per line should be bucketed, or every material one.
5. Which flags should auto-notify the contact shown.
