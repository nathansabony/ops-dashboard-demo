#!/usr/bin/env python3
"""Write the 12-month budget model workbook for one entity (or the portfolio).

    python3 budget_workbook.py <budget.json> <out.xlsx>

`budget.json` is exactly what services/budgetModel.js emits for a scope. This
script does no modelling of its own — it lays that payload out as a LIVE Excel
model.

── Three tabs, on purpose ───────────────────────────────────────────────────────
    Budget          the twelve months, every cell a live formula
    Assumptions     the input cells — the only tab meant to be typed into
    Base Actuals    the trailing-12 real numbers every projection grows out of

The 36-month version of this file also wrote Seasonality, Event Calendar, Debt
Service, Budget vs Actual and Summary tabs. They are gone as of the 12-month
rewrite. Seasonality survives as baked-in constants (see below); the rest were
complexity nobody was using.

── Why formulas and not a value dump ────────────────────────────────────────────
The point of handing someone a workbook rather than a PDF is that they can argue
with it. Every projected cell is a real formula reading from two places:

    'Base Actuals'  the entity's own trailing-12 months out of Rent Manager
    Assumptions     the growth rate / percentage driving it  (the INPUT cells)

Change 8% to 11% on the Assumptions tab and all twelve months, the Full Year
column, the NOI margin and every total move with it. Nothing is hardcoded except
the actuals, which are facts, and the seasonality factors.

── Why seasonality is a constant and not a tab ──────────────────────────────────
Each line has its own within-year shape (heating gas spikes in February, water in
summer), computed by the engine from up to 24 months of history. That shape used
to live on its own tab so it could be edited. In practice nobody edited it, and it
cost a tab plus a cross-sheet reference on every one of ~250 formulas.

So the factor is now written straight into the formula as a number:

    ='Base Actuals'!$P$12 * 1.412... * POWER(1+util_growth, 0.958)
                            ^^^^^^^^ February gas runs 41% above this line's average

It is still visible, still overwritable (type over the cell), and the months still
add up to the same year — the factors average 1.000 by construction.

Blue cells on a white background are INPUTS — the only cells meant to be typed
in. Everything else is derived and will be overwritten next time the model is
regenerated from live data.

Workbook is written with fullCalcOnLoad, so Excel / LibreOffice / Sheets / Numbers
recalculate the whole thing the moment it opens.

── Why the formulas ALSO carry a cached value ───────────────────────────────────
openpyxl writes `<f>` with an empty `<v/>`: a formula and no last-known result.
Excel normally fills that in on open — but not in Protected View, which is where
every workbook downloaded from a website lands. Protected View does not
calculate, so a formula with no cached value renders as an EMPTY CELL, and the
whole model looked blank until someone clicked "Enable Editing". Emailed to an
accountant, that reads as broken rather than as a security banner.

So each formula cell is also written with the value the engine already computed
for it (`cv=` on put(), injected into the saved XML by _inject_cached_values).
These are a preview, not a source of truth: fullCalcOnLoad still forces a real
recalculation the moment the file is trusted, and every number here comes from
the same services/budgetModel.js run that produced the tab — so what Excel
computes and what was cached are the same number.
"""

import json
import os
import re
import sys
import zipfile
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

# ── house style ──────────────────────────────────────────────────────────────
NAVY = "1F3864"
SLATE = "44546A"
LIGHT = "F2F5FA"
BAND = "EAEFF7"
INPUT_FILL = "DDEBF7"

F_TITLE = Font(name="Calibri", size=16, bold=True, color="FFFFFF")
F_SUB = Font(name="Calibri", size=10, color="FFFFFF")
F_H = Font(name="Calibri", size=10, bold=True, color="FFFFFF")
F_SECTION = Font(name="Calibri", size=10, bold=True, color=NAVY)
F_BODY = Font(name="Calibri", size=10)
F_BOLD = Font(name="Calibri", size=10, bold=True)
F_INPUT = Font(name="Calibri", size=10, bold=True, color="0B5394")
F_LINK = Font(name="Calibri", size=10, color="375623")      # cross-sheet reference
F_MEMO = Font(name="Calibri", size=10, italic=True, color="808080")
F_NOTE = Font(name="Calibri", size=9, italic=True, color="808080")
F_KEY = Font(name="Calibri", size=8, color="BFBFBF")

FILL_TITLE = PatternFill("solid", fgColor=NAVY)
FILL_HEAD = PatternFill("solid", fgColor=SLATE)
FILL_SECTION = PatternFill("solid", fgColor=BAND)
FILL_LIGHT = PatternFill("solid", fgColor=LIGHT)
FILL_INPUT = PatternFill("solid", fgColor=INPUT_FILL)

THIN = Side(style="thin", color="D0D7E5")
MED = Side(style="medium", color=NAVY)
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
TOP_RULE = Border(top=Side(style="thin", color=NAVY))
DBL_RULE = Border(top=Side(style="double", color=NAVY))

MONEY = '#,##0;[Red](#,##0);"—"'
MONEY0 = '#,##0;(#,##0);"—"'
PCT1 = "0.0%"
PCT2 = "0.00%"

MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ── cached formula results ───────────────────────────────────────────────────
# (sheet title, cell coordinate) -> the number Excel will compute there. Filled
# by put(cv=...) as the sheets are written, injected into the saved file by
# _inject_cached_values(). See the module docstring for why this exists.
_CACHE = {}


def _num(v):
    """A finite float, or None. Bools are not numbers here."""
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


# ── small helpers ────────────────────────────────────────────────────────────
def put(ws, row, col, value, font=F_BODY, fmt=None, fill=None,
        align=None, border=None, wrap=False, cv=None):
    c = ws.cell(row=row, column=col, value=value)
    if cv is not None and isinstance(value, str) and value.startswith("="):
        n = _num(cv)
        if n is not None:
            _CACHE[(ws.title, c.coordinate)] = n
    c.font = font
    if fmt:
        c.number_format = fmt
    if fill:
        c.fill = fill
    if align or wrap:
        c.alignment = Alignment(horizontal=align, vertical="center", wrap_text=wrap)
    if border:
        c.border = border
    return c


def banner(ws, title, subtitle, width):
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=width)
    put(ws, 1, 1, title, F_TITLE, fill=FILL_TITLE, align="left")
    ws.row_dimensions[1].height = 26
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=width)
    put(ws, 2, 1, subtitle, F_SUB, fill=FILL_TITLE, align="left")
    ws.row_dimensions[2].height = 16
    for c in range(1, width + 1):
        ws.cell(row=1, column=c).fill = FILL_TITLE
        ws.cell(row=2, column=c).fill = FILL_TITLE


def widths(ws, spec):
    for col, w in spec.items():
        ws.column_dimensions[col].width = w


def ym_label(ym):
    y, m = ym.split("-")
    return f"{MONTH_ABBR[int(m) - 1]}-{y[2:]}"


def cal_month(ym):
    return int(ym.split("-")[1])


# ── layout constants ─────────────────────────────────────────────────────────
# Shared by the Budget grid and Base Actuals so the two line up column-for-column
# when they are read side by side.
KEY_COL, LABEL_COL, BASE_COL = 1, 2, 3
FIRST_MONTH_COL = 4          # column D
YEAR_GAP = 1                 # a narrow spacer between the months and Full Year

# Base Actuals column map (12 months live in C..N)
BA_TOTAL_COL = 15            # O — T12 total
BA_AVG_COL = 16              # P — monthly average, what the Budget grid reads
BA_PERUNIT_COL = 17          # Q
BA_NOTE_COL = 18             # R


class Model:
    """Row/column bookkeeping shared across the sheets."""

    def __init__(self, data):
        self.d = data
        self.scope = data["scope"]
        self.months = data["months"]                 # ['2026-01', ...]
        self.month_labels = data["monthLabels"]
        self.n = len(self.months)
        self.lines = data["lineDefs"]                # injected by the caller
        self.units = data.get("units") or 0
        self.assump = data["assumptions"]
        self.base = data.get("base") or {}
        self.seasonality = data.get("seasonality") or {}
        # Roll-up scopes only: per-line growth-rate decomposition, so a portfolio
        # workbook reproduces the sum of its entities instead of growing the
        # aggregate at one child's rate. See growthCohorts() in budgetModel.js.
        self.cohorts = data.get("growthCohorts") or {}
        # rate -> defined name, per growth key. Assigned per KEY rather than per
        # line because one rate drives several lines (utilities growth covers gas,
        # water and electric), and those must all read the same input cell.
        self.cohort_names = {}
        for spec in self.cohorts.values():
            gk = spec["growthKey"]
            if gk in self.cohort_names:
                continue
            primary = _num(self.assump.get(gk))
            names, extra = {}, 1
            for c in spec["cohorts"]:
                rate = _num(c["rate"])
                if primary is not None and rate == primary and NAMED.get(gk) not in names.values():
                    names[rate] = NAMED[gk]
                else:
                    extra += 1
                    names[rate] = f"{NAMED[gk]}_{extra}"
            self.cohort_names[gk] = names
        # Lines budgeted TO a target rather than projected from history. Only the
        # ones that actually applied get a factor cell and a formula reference —
        # a pin that couldn't be applied (no unit count, say) must not leave a
        # dangling pin_<key> name behind in the formulas.
        self.pins = [p for p in (data.get("pins") or []) if p.get("applied")]
        self.pin_keys = {p["key"] for p in self.pins}
        # filled in as sheets are written
        self.base_row = {}
        self.mb_row = {}
        self.total_row = {}
        self.year_col = FIRST_MONTH_COL + self.n + YEAR_GAP
        self.growth_offset = data.get("growthOffsetMonths", 6.5)
        self.anchor = data.get("anchor", "calendarYear")
        # Engine results, read back by the cached-value helpers below.
        self.lines_v = data.get("lines") or {}
        self.totals_v = data.get("totals") or {}
        self.years_v = data.get("years") or []
        self.actuals = data.get("actuals") or []

    # month index -> Budget grid column
    def mcol(self, i):
        return FIRST_MONTH_COL + i

    def mletter(self, i):
        return get_column_letter(self.mcol(i))

    @property
    def year_letter(self):
        return get_column_letter(self.year_col)

    # Growth is measured from the CENTRE of the base window, not its end. The
    # offset is taken from the engine (growthOffsetMonths) rather than recomputed
    # here: with a calendar-year anchor the horizon does not necessarily start the
    # month after the base ends, and two implementations of that arithmetic would
    # be two chances for the workbook and the tab to disagree.
    def elapsed_years(self, i):
        return round((self.growth_offset + i) / 12, 12)

    def growth_name(self, line):
        return NAMED.get(line.get("growth"))

    # ── seasonality, as a baked constant ──────────────────────────────────────
    # The engine multiplies by seas.index[calendar month]. That index is written
    # into the formula as a literal rather than read off a tab.
    #
    # Precision is NOT cosmetic here. These were first written at 6dp on the
    # reasoning that a 1e-7 factor error cannot matter next to a result rounded to
    # the dollar. That is wrong at a rounding boundary: on a $21,000 line a 1e-7
    # relative error is about a cent, and a true value within a cent of x.50 flips
    # to the other integer — roughly a 2% chance per cell, which showed up as
    # single-dollar breaks on a handful of months per workbook and $2 on the annual
    # column that sums them. 12dp puts the flip probability around 1e-8 per cell.
    SEAS_DP = 12

    def seas_factor(self, line, i):
        if not line.get("seasonal"):
            return None
        seas = self.seasonality.get(line["key"])
        if not seas:
            return None
        idx = seas.get("index") or []
        m = cal_month(self.months[i]) - 1
        if m >= len(idx):
            return None
        f = _num(idx[m])
        if f is None:
            return None
        return round(f, self.SEAS_DP)

    # ── the engine's own results, for the cached-value preview ────────────────
    # Every formula in this workbook recomputes something services/budgetModel.js
    # already worked out. These read that back so a cell can carry the number
    # alongside the formula rather than instead of it.
    def line_v(self, key, i):
        s = self.lines_v.get(key)
        return _num(s[i]) if s and i < len(s) else None

    def total_v(self, key, i):
        s = self.totals_v.get(TOTAL_KEY.get(key, key))
        return _num(s[i]) if s and i < len(s) else None

    def line_year_v(self, key):
        vals = [self.line_v(key, i) for i in range(self.n)]
        return sum(v for v in vals if v is not None)

    def total_year_v(self, key):
        vals = [self.total_v(key, i) for i in range(self.n)]
        return sum(v for v in vals if v is not None)

    def base_avg(self, key):
        b = self.base.get(key)
        return _num(b["avg"]) if b else None


# Budget grid total-row key -> the key the engine publishes it under.
TOTAL_KEY = {"egi": "egi", "opex": "totalOpex", "noi": "noi",
             "below": "belowNoi", "cf": "cashFlow"}


# Assumption cell -> Excel defined name. Formulas read these names so the model is
# legible: `POWER(1+ins_growth, 0.79)` instead of `POWER(1+Assumptions!$C$9,0.79)`.
NAMED = {
    "incomeGrowthPct": "inc_growth",
    "propTaxGrowthPct": "tax_growth",
    "insuranceGrowthPct": "ins_growth",
    "utilitiesGrowthPct": "util_growth",
    "repairsGrowthPct": "rm_growth",
    "payrollGrowthPct": "payroll_growth",
    "generalGrowthPct": "gen_growth",
}

# Human label for a growth key, used by the split-rate rows on a roll-up.
GROWTH_LABEL = {
    "incomeGrowthPct": "Rent / income growth",
    "propTaxGrowthPct": "Property tax growth",
    "insuranceGrowthPct": "Insurance growth",
    "utilitiesGrowthPct": "Utilities growth",
    "repairsGrowthPct": "Repairs & maintenance growth",
    "payrollGrowthPct": "Payroll growth",
    "generalGrowthPct": "General expense growth",
}


# ══════════════════════════════════════════════════════════════════════════════
# 1. ASSUMPTIONS — the only tab anyone is meant to type into
# ══════════════════════════════════════════════════════════════════════════════
def sheet_assumptions(wb, M):
    ws = wb.create_sheet("Assumptions")
    a = M.assump
    banner(ws, f"Assumptions — {M.scope}",
           "Blue cells are inputs. Change one and every projected number in this workbook moves with it.", 6)
    widths(ws, {"A": 20, "B": 38, "C": 14, "D": 13, "E": 34, "F": 76})

    r = 4
    for i, h in enumerate(["Group", "Assumption", "Value", "Unit", "Drives", "Basis / rationale"], start=1):
        put(ws, r, i, h, F_H, fill=FILL_HEAD, align="center", border=BOX)
    ws.freeze_panes = "C5"
    r += 1

    def group(title):
        nonlocal r
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=6)
        put(ws, r, 1, title, F_SECTION, fill=FILL_SECTION, border=BOX)
        r += 1

    def row(group_lbl, label, value, fmt, unit, drives, why, name=None):
        nonlocal r
        put(ws, r, 1, group_lbl, F_NOTE, border=BOX)
        put(ws, r, 2, label, F_BODY, border=BOX)
        cell = put(ws, r, 3, value, F_INPUT, fmt=fmt, fill=FILL_INPUT, align="center", border=BOX)
        put(ws, r, 4, unit, F_NOTE, align="center", border=BOX)
        put(ws, r, 5, drives, F_NOTE, border=BOX, wrap=True)
        put(ws, r, 6, why, F_NOTE, border=BOX, wrap=True)
        ws.row_dimensions[r].height = 28
        if name:
            wb.defined_names.add(DefinedName(name, attr_text=f"Assumptions!$C${r}"))
        r += 1
        return cell

    group("GROWTH RATES — annual, compounded monthly across the 12-month budget year")
    row("Income", "Rent / income growth", a.get("incomeGrowthPct", 0), PCT2, "per year",
        "Rental & Operating Income",
        "BENCHMARK #1. 3% for non-rent-controlled units. CAP THIS PER ENTITY where rent control binds: "
        "a rent-controlled city Ch.260 (5+ units) = lesser of CPI or 4%; another city rent-leveling (1+ units) ≈ 2.5%, CPI-tied. "
        "Yardi projects only ~0.5% advertised-rent growth nationally in 2026, so 3% is already optimistic on in-place rents.",
        "inc_growth")
    row("Expense", "Property tax growth", a.get("propTaxGrowthPct", 0), PCT2, "per year",
        "Property Taxes",
        "BENCHMARK #10/#15. 2–4%/yr absent a revaluation. Effective rates vary widely by county and levy; "
        "pull the actual bill. A sale or municipal revaluation resets the assessment sharply — type that straight "
        "over the affected months on the Budget tab rather than burying it in this rate.",
        "tax_growth")
    row("Expense", "Insurance growth", a.get("insuranceGrowthPct", 0), PCT2, "per year",
        "Insurance",
        "BENCHMARK #9/#15. 7–10%/yr — the structural over-inflation line. National per-unit cost rose 55% "
        "(2021 $502 → 2024 $777). Never grow this at general inflation.",
        "ins_growth")
    row("Expense", "Utilities growth", a.get("utilitiesGrowthPct", 0), PCT2, "per year",
        "Heating Gas, Water & Sewer, Electric",
        "BENCHMARK #11/#15. Volatile; general inflation is the honest default. NAA 2024 utilities actually fell 3.2% "
        "on a gas pullback.",
        "util_growth")
    row("Expense", "Repairs & maintenance growth", a.get("repairsGrowthPct", 0), PCT2, "per year",
        "Repairs & Maintenance, Turnover",
        "BENCHMARK #5. National R&M +3.7% YoY (+28% since 2021).",
        "rm_growth")
    row("Expense", "Payroll growth", a.get("payrollGrowthPct", 0), PCT2, "per year",
        "Payroll, Management Wages",
        "BENCHMARK #8/#15. 3–4%/yr; NAA payroll +3.6% YoY.",
        "payroll_growth")
    row("Expense", "General expense growth", a.get("generalGrowthPct", 0), PCT2, "per year",
        "Management Fees, Advertising, Other Operating, Reserves, Commissions",
        "BENCHMARK #15. 3%/yr general opex. Opex growth peaked at 8.6% in 2023 and has eased back toward CPI.",
        "gen_growth")

    group("INCOME BUILD — how Effective Gross Income is assembled")
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=6)
    put(ws, r, 1,
        "READ THIS FIRST: the income base is ACTUAL BILLED income (accrual). Vacant units are never billed, so the base "
        "ALREADY carries this entity's real occupancy. That is why there is no vacancy % here — subtracting one would "
        "double-count the loss. To budget to a different occupancy, set a target below.",
        F_NOTE, fill=FILL_LIGHT, border=BOX, wrap=True)
    ws.row_dimensions[r].height = 42
    r += 1
    occ_t = a.get("occupancyTargetPct")
    row("Income", "Target occupancy (blank = as-is)", occ_t if occ_t is not None else None, PCT1, "% occupied",
        "Occupancy Adjustment",
        "BENCHMARK #2. Leave BLANK to budget each building at the occupancy it actually runs at — the default this "
        "model recommends. Set a target (e.g. 95%) to budget to a portfolio standard instead. Both this AND the "
        "trailing occupancy below must be filled in for the adjustment to do anything.",
        "occ_target")
    row("Income", "Trailing occupancy (actual)", _num(M.d.get("occupancyPct")), PCT1, "% occupied",
        "Occupancy Adjustment (denominator)",
        "This entity's own occupancy over the base window. Only used when a target above is set.",
        "occ_trailing")
    row("Income", "Bad debt / collection loss", a.get("badDebtPct", 0), PCT2, "% of billed",
        "Less: Bad Debt",
        "BENCHMARK #3. Billed but never collected — a real loss, separate from vacancy. NAA 2024 national bad debt was "
        "$75/unit (~0.35%) but that is premium-managed stock; 1% is prudent for urban OH workforce housing. Tune against "
        "the % Collected figures on the Delinquency tab.",
        "bad_debt")

    group("FEE, RESERVE & CUSHION INPUTS")
    mode_cell = row("Fees", "Management fee mode", a.get("mgmtFeeMode", "actual"), None, "actual | pctOfEgi",
                    "Management Fees",
                    'Type "actual" to grow the fee RM actually books, or "pctOfEgi" to recompute it as a percentage of '
                    "income. The Management Fees row switches live when you change this.",
                    "mgmt_mode")
    # A typo here silently falls back to "actual" — the formula tests for the
    # exact string. A dropdown removes the chance of that.
    dv = DataValidation(type="list", formula1='"actual,pctOfEgi"', allow_blank=False)
    ws.add_data_validation(dv)
    dv.add(mode_cell)
    row("Fees", "Management fee % of EGI", a.get("mgmtFeePct", 0), PCT2, "% of EGI",
        'Management Fees (only when mode = "pctOfEgi")',
        "BENCHMARK #7. 4–5% for a portfolio of this size; 8–12% is scattered-site pricing and does not apply here.",
        "mgmt_pct")
    row("Reserves", "Replacement reserves", a.get("reservesPerUnitYr", 0), MONEY0, "$/unit/yr",
        "Replacement Reserves (below NOI)",
        "BENCHMARK #14. Fannie requires $250/unit minimum (non-senior); Freddie $200–300. $300 reflects older OH stock — "
        "a PCA could justify more.",
        "reserves_unit")
    row("Cushion", "Contingency", a.get("contingencyPct", 0), PCT2, "% of controllable opex",
        "Contingency (excludes taxes & insurance)",
        "BENCHMARK #16 recommends 3–5%, but that cushion absorbs ESTIMATE error and this model is built on real actuals. "
        "It also blunts budget-vs-actual variance. Ships visible and OFF — turn it on if you want the pad.",
        "contingency_pct")

    # ── Split growth rates on a roll-up ─────────────────────────────────────
    # The portfolio does not run on one income growth rate: some entities carry an
    # override. Rather than pick one and quietly drift from the tab, every distinct
    # rate gets its own input cell here and the Budget tab's formula adds the
    # weighted terms. Each row names the entities it covers, so "why are there two
    # income growth rates" answers itself.
    if M.cohorts:
        group("SPLIT GROWTH RATES — entities in this roll-up do not all use the same rate")
        seen = set()
        for key, spec in M.cohorts.items():
            gk = spec["growthKey"]
            if gk in seen:
                continue
            seen.add(gk)
            base_label = GROWTH_LABEL.get(gk, gk)
            for c in spec["cohorts"]:
                rate = _num(c["rate"])
                name = M.cohort_names[gk][rate]
                ents = ", ".join(c["entities"])
                if name == NAMED.get(gk):
                    continue      # the portfolio default already has its cell above
                row("Growth", f"{base_label} — override", rate, PCT2, "per year",
                    f"{base_label} for: {ents}",
                    f"These entities budget this line at a different rate from the portfolio default. "
                    f"The Budget tab weights this rate against the default by each group's share of the base, "
                    f"so the roll-up equals the sum of the individual entity budgets exactly.",
                    name)

    group("PORTFOLIO FACTS")
    row("Facts", "Unit count", M.units, "#,##0", "units",
        "Replacement Reserves, every $/unit benchmark check",
        "Live from Rent Manager /Units joined to the property→entity map.",
        "unit_count")

    # ── Pinned lines ────────────────────────────────────────────────────────
    # A pin is a line that was budgeted TO a number rather than projected from
    # history — "insurance should be running $450/unit". The engine implements it
    # as one multiplier chosen so the year lands on the target, and the multiplier
    # is written here as a real input cell: seasonality and growth still apply on
    # top of it, so changing the factor in Excel moves all twelve months exactly
    # the way changing it on the Budget tab does.
    if M.pins:
        group("PINNED LINES — budgeted to a target, not projected from history")
        for p in M.pins:
            key = p["key"]
            mode = p.get("mode")
            target_txt = (f'${p.get("value", 0):,.0f}/unit/yr' if mode == "perUnitYr"
                          else f'{(p.get("value", 0) * 100):.2f}'.rstrip("0").rstrip(".") + "% of EGI")
            row("Pin", f'{p.get("label", key)} — pin factor', round(p.get("scale", 1), 6), "0.000000", "× base",
                f'{p.get("label", key)} (all 12 months)',
                f'PINNED to {target_txt}. The year totals {p.get("target", 0):,.0f}; the line keeps its seasonal shape '
                f'and its own growth rate still tilts the months inside the year. Set this factor to 1 to go back to '
                f'projecting the line from actuals.',
                f"pin_{key}")

    r += 1
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=6)
    put(ws, r, 1,
        "NOT SET HERE: one-off dated items — a tax reassessment, an insurance renewal, a planned roof. Over a "
        "twelve-month budget those are simpler to state than to model: type the number straight into that month's cell "
        "on the Budget tab. Every total above it is a live SUM, so NOI and cash flow move with it.",
        F_NOTE, fill=FILL_LIGHT, border=BOX, wrap=True)
    ws.row_dimensions[r].height = 32
    return ws


# ══════════════════════════════════════════════════════════════════════════════
# 2. BASE ACTUALS — the facts every projection is built on
# ══════════════════════════════════════════════════════════════════════════════
def sheet_base(wb, M):
    ws = wb.create_sheet("Base Actuals")
    bw = M.d["baseWindow"]
    banner(ws, f"Base Actuals — trailing 12 months ({bw['from']} → {bw['to']})",
           "Straight from Rent Manager Report 45 (ProfitLossRecapMonth, accrual basis). These are facts, not estimates — "
           "every projected number in this workbook grows out of the Monthly Avg column.", BA_NOTE_COL)
    widths(ws, {"A": 12, "B": 34, "O": 14, "P": 14, "Q": 13, "R": 70})
    for i in range(12):
        ws.column_dimensions[get_column_letter(3 + i)].width = 11

    r = 4
    put(ws, r, KEY_COL, "key", F_H, fill=FILL_HEAD, border=BOX)
    put(ws, r, LABEL_COL, "Line Item", F_H, fill=FILL_HEAD, border=BOX)
    for i, lbl in enumerate(bw["months"]):
        put(ws, r, 3 + i, lbl, F_H, fill=FILL_HEAD, align="center", border=BOX)
    put(ws, r, BA_TOTAL_COL, "T12 Total", F_H, fill=FILL_HEAD, align="center", border=BOX)
    put(ws, r, BA_AVG_COL, "Monthly Avg", F_H, fill=FILL_HEAD, align="center", border=BOX)
    put(ws, r, BA_PERUNIT_COL, "$/unit/yr", F_H, fill=FILL_HEAD, align="center", border=BOX)
    put(ws, r, BA_NOTE_COL, "Note", F_H, fill=FILL_HEAD, border=BOX)
    ws.freeze_panes = "C5"
    r += 1

    for line in M.lines:
        b = M.base.get(line["key"])
        if b is None:
            continue
        font = F_MEMO if line.get("memo") else F_BODY
        put(ws, r, KEY_COL, line["key"], F_KEY, border=BOX)
        put(ws, r, LABEL_COL, line["label"], font, border=BOX)
        for i, v in enumerate(b["monthly"]):
            put(ws, r, 3 + i, v, font, fmt=MONEY, border=BOX)
        put(ws, r, BA_TOTAL_COL, f"=SUM(C{r}:N{r})", F_BOLD, fmt=MONEY, border=BOX, cv=b.get("total"))
        put(ws, r, BA_AVG_COL, f"=O{r}/12", F_BOLD, fmt=MONEY, border=BOX, fill=FILL_LIGHT, cv=b.get("avg"))
        put(ws, r, BA_PERUNIT_COL, f"=IF(unit_count=0,\"\",O{r}/unit_count)", font, fmt=MONEY, border=BOX,
            cv=(_num(b.get("total")) / M.units if M.units and _num(b.get("total")) is not None else None))
        put(ws, r, BA_NOTE_COL, line.get("note", ""), F_NOTE, border=BOX, wrap=True)
        M.base_row[line["key"]] = r
        r += 1

    r += 1
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=BA_NOTE_COL)
    put(ws, r, 1,
        "The current month is deliberately excluded — a half-posted month reads low, and a low base would quietly "
        "under-budget every month ahead of it. 'Other Operating Expense' is a residual: actual Total Operating Expense "
        "less every mapped line above, so whatever RM books outside our account map still lands in the budget instead "
        "of vanishing from it.",
        F_NOTE, fill=FILL_LIGHT, border=BOX, wrap=True)
    ws.row_dimensions[r].height = 40
    return ws


# ══════════════════════════════════════════════════════════════════════════════
# 3. BUDGET — the model itself
# ══════════════════════════════════════════════════════════════════════════════
def sheet_budget(wb, M):
    ws = wb.create_sheet("Budget", 0)
    width = M.year_col
    banner(ws, f"12-Month Budget — {M.scope}",
           f"{M.month_labels[0]} → {M.month_labels[-1]} · accrual basis · every cell is a live formula reading "
           f"Base Actuals × seasonality × Assumptions.", width)

    widths(ws, {"A": 13, "B": 36, "C": 13})
    for i in range(M.n):
        ws.column_dimensions[M.mletter(i)].width = 12
    ws.column_dimensions[get_column_letter(M.year_col - 1)].width = 3
    ws.column_dimensions[M.year_letter].width = 15

    # ── header ────────────────────────────────────────────────────────────────
    r = 4
    put(ws, r, KEY_COL, "key", F_H, fill=FILL_HEAD, border=BOX)
    put(ws, r, LABEL_COL, "Line Item", F_H, fill=FILL_HEAD, border=BOX)
    put(ws, r, BASE_COL, "Base $/mo", F_H, fill=FILL_HEAD, align="center", border=BOX)
    for i, ym in enumerate(M.months):
        c = put(ws, r, M.mcol(i), ym_label(ym), F_H, fill=FILL_HEAD, align="center", border=BOX)
        if cal_month(ym) == 1:
            c.border = Border(left=MED, right=THIN, top=THIN, bottom=THIN)
    put(ws, r, M.year_col, "Full Year", F_H, fill=FILL_HEAD, align="center", border=BOX)
    ws.freeze_panes = "D5"
    r += 1

    first_m, last_m = M.mletter(0), M.mletter(M.n - 1)

    def section(title):
        nonlocal r
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=width)
        put(ws, r, 1, title, F_SECTION, fill=FILL_SECTION, border=BOX)
        r += 1

    def growth_formula(line, i, _key_cell=None):
        """The core projection: base × seasonality × growth [× pin].

        Seasonality is a literal (see the module docstring) and growth reads a
        named input cell on the Assumptions tab, so this is the whole model in one
        readable line rather than a nest of cross-sheet lookups.

        On a roll-up where the entities do not share one rate for this line, the
        seasonality × growth part becomes a sum of weighted terms — one per rate —
        which is what makes the portfolio workbook equal the sum of the entity
        workbooks rather than an approximation of it.
        """
        br = M.base_row.get(line["key"])
        if line.get("plannedOnly") or br is None:
            return "=0"
        t = M.elapsed_years(i)
        spec = M.cohorts.get(line["key"])
        if spec:
            m = cal_month(M.months[i]) - 1
            names = M.cohort_names[spec["growthKey"]]
            terms = []
            for c in spec["cohorts"]:
                f = _num(c["factors"][m])
                if f is None or f == 0:
                    continue
                terms.append(f"{round(f, M.SEAS_DP)}*POWER(1+{names[_num(c['rate'])]},{t})")
            growth_part = "(" + "+".join(terms) + ")"
            parts = [f"'Base Actuals'!$P${br}", growth_part]
        else:
            parts = [f"'Base Actuals'!$P${br}"]
            seas = M.seas_factor(line, i)
            if seas is not None and seas != 1:
                parts.append(f"{seas}")
            g = M.growth_name(line)
            if g:
                parts.append(f"POWER(1+{g},{t})")
        if line["key"] in M.pin_keys:
            parts.append(f"pin_{line['key']}")
        return "=ROUND(" + "*".join(parts) + ",0)"

    def line_row(line, formula_fn, font=None):
        nonlocal r
        f = font or (F_MEMO if line.get("memo") else F_BODY)
        put(ws, r, KEY_COL, line["key"], F_KEY, border=BOX)
        label = ("    " + line["label"]) if line.get("memo") else line["label"]
        put(ws, r, LABEL_COL, label, f, border=BOX)
        br = M.base_row.get(line["key"])
        put(ws, r, BASE_COL, (f"='Base Actuals'!$P${br}" if br else None), F_LINK, fmt=MONEY,
            align="center", border=BOX, cv=M.base_avg(line["key"]))
        M.mb_row[line["key"]] = r
        key = line["key"]
        for i in range(M.n):
            cell = put(ws, r, M.mcol(i), formula_fn(line, i, f"$A${r}"), f, fmt=MONEY, border=BOX,
                       cv=M.line_v(key, i))
            if cal_month(M.months[i]) == 1:
                cell.border = Border(left=MED, right=THIN, top=THIN, bottom=THIN)
        put(ws, r, M.year_col, f"=SUM({first_m}{r}:{last_m}{r})", F_BOLD, fmt=MONEY,
            fill=FILL_LIGHT, border=BOX, cv=M.line_year_v(key))
        r += 1

    def total_row(key, label, formula_fn, dbl=False):
        nonlocal r
        border = DBL_RULE if dbl else TOP_RULE
        put(ws, r, KEY_COL, "", F_KEY, border=border)
        put(ws, r, LABEL_COL, label, F_BOLD, border=border)
        put(ws, r, BASE_COL, "", F_BODY, border=border)
        M.total_row[key] = r
        for i in range(M.n):
            put(ws, r, M.mcol(i), formula_fn(i), F_BOLD, fmt=MONEY, border=border, fill=FILL_LIGHT,
                cv=M.total_v(key, i))
        put(ws, r, M.year_col, f"=SUM({first_m}{r}:{last_m}{r})", F_BOLD, fmt=MONEY,
            fill=FILL_LIGHT, border=border, cv=M.total_year_v(key))
        r += 1

    def cell(key, i):
        return f"{M.mletter(i)}{M.mb_row[key]}"

    by_section = lambda s: [l for l in M.lines if l["section"] == s]

    # ── INCOME ────────────────────────────────────────────────────────────────
    section("INCOME")
    for line in by_section("income"):
        if line["key"] == "baseIncome":
            line_row(line, growth_formula)
        elif line["key"] == "occupancyAdj":
            line_row(line, lambda l, i, kc: (
                f'=ROUND(IF(OR(occ_target="",occ_trailing="",occ_trailing=0),0,'
                f'{cell("baseIncome", i)}*(occ_target/occ_trailing-1)),0)'))
        elif line["key"] == "badDebt":
            line_row(line, lambda l, i, kc: (
                f'=ROUND(({cell("baseIncome", i)}+{cell("occupancyAdj", i)})*bad_debt,0)'))

    total_row("egi", "EFFECTIVE GROSS INCOME", lambda i: (
        f'={cell("baseIncome", i)}+{cell("occupancyAdj", i)}-{cell("badDebt", i)}'))

    # ── OPERATING EXPENSES ────────────────────────────────────────────────────
    section("OPERATING EXPENSES")
    opex_lines = by_section("opex")
    controllable = [l["key"] for l in opex_lines
                    if not l.get("memo") and not l.get("derived") and l["key"] not in M.d["uncontrollable"]]

    for line in opex_lines:
        if line["key"] == "mgmtFees":
            def mgmt(l, i, kc, _l=line):
                base = growth_formula(_l, i)[1:]               # drop the leading '='
                return (f'=ROUND(IF(mgmt_mode="pctOfEgi",'
                        f'{M.mletter(i)}{M.total_row["egi"]}*mgmt_pct,{base}),0)')
            line_row(line, mgmt)
        elif line["key"] == "contingency":
            def cont(l, i, kc):
                terms = "+".join(cell(k, i) for k in controllable)
                return f"=ROUND(({terms})*contingency_pct,0)"
            line_row(line, cont)
        else:
            line_row(line, growth_formula)

    summed_opex = [l["key"] for l in opex_lines if not l.get("memo")]
    total_row("opex", "TOTAL OPERATING EXPENSE", lambda i: (
        "=" + "+".join(cell(k, i) for k in summed_opex)))

    total_row("noi", "NET OPERATING INCOME", lambda i: (
        f'={M.mletter(i)}{M.total_row["egi"]}-{M.mletter(i)}{M.total_row["opex"]}'), dbl=True)

    # ── BELOW NOI ─────────────────────────────────────────────────────────────
    section("BELOW NOI — capital & reserves")
    for line in by_section("belowNoi"):
        if line["key"] == "reserves":
            line_row(line, lambda l, i, kc: (
                f"=ROUND(unit_count*reserves_unit/12*POWER(1+gen_growth,{M.elapsed_years(i)}),0)"))
        else:
            line_row(line, growth_formula)

    summed_below = [l["key"] for l in by_section("belowNoi") if not l.get("memo")]
    total_row("below", "TOTAL BELOW NOI", lambda i: (
        "=" + "+".join(cell(k, i) for k in summed_below)))
    total_row("cf", "CASH FLOW BEFORE DEBT SERVICE", lambda i: (
        f'={M.mletter(i)}{M.total_row["noi"]}-{M.mletter(i)}{M.total_row["below"]}'), dbl=True)

    # ── margin line ───────────────────────────────────────────────────────────
    put(ws, r, LABEL_COL, "NOI margin (% of EGI)", F_NOTE, border=BOX)
    for i in range(M.n):
        noi, egi_v = M.total_v("noi", i), M.total_v("egi", i)
        put(ws, r, M.mcol(i),
            f'=IFERROR({M.mletter(i)}{M.total_row["noi"]}/{M.mletter(i)}{M.total_row["egi"]},"")',
            F_NOTE, fmt=PCT1, border=BOX,
            cv=(noi / egi_v if noi is not None and egi_v else None))
    L = M.year_letter
    noi_y, egi_y = M.total_year_v("noi"), M.total_year_v("egi")
    put(ws, r, M.year_col,
        f'=IFERROR({L}{M.total_row["noi"]}/{L}{M.total_row["egi"]},"")',
        F_NOTE, fmt=PCT1, fill=FILL_LIGHT, border=BOX,
        cv=(noi_y / egi_y if noi_y is not None and egi_y else None))
    r += 2

    # ── how to use this ───────────────────────────────────────────────────────
    # The 36-month workbook carried a whole Summary tab to say this. At three tabs
    # it fits under the grid, where someone scrolling the budget will actually
    # meet it.
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=width)
    put(ws, r, 1, "HOW TO USE THIS WORKBOOK", F_SECTION, fill=FILL_SECTION, border=BOX)
    r += 1
    for text in [
        "Three tabs. ASSUMPTIONS is the only one meant to be typed into — the blue cells. Change income growth from 3% "
        "to 4% and every month here, the Full Year column and the NOI margin recalculate. BASE ACTUALS is the trailing "
        "twelve months out of Rent Manager that this budget grows from; it is fact, not estimate. This tab is the "
        "budget itself.",
        "Each projected cell reads: Base Actuals monthly average × that line's seasonal factor × growth. The seasonal "
        "factor is the number sitting in the formula (1.412 on February gas means gas runs 41% above that line's own "
        "average in February). The factors average 1.000 across the year, so they move months around without changing "
        "the annual total.",
        "A one-off — a reassessment, a renewal, a planned roof — is not modelled. Type the number straight over that "
        "month's cell. Everything below it is a live SUM, so the totals, NOI and cash flow all follow.",
        "This budget stops at CASH FLOW BEFORE DEBT SERVICE. Booked mortgage interest is shown as a grey memo line for "
        "reference and is never added into any total.",
    ]:
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=width)
        put(ws, r, 1, text, F_NOTE, fill=FILL_LIGHT, border=BOX, wrap=True)
        ws.row_dimensions[r].height = 30
        r += 1

    ws.sheet_properties.tabColor = NAVY
    return ws


# ══════════════════════════════════════════════════════════════════════════════
# Cached formula results, injected into the saved package
# ══════════════════════════════════════════════════════════════════════════════
# openpyxl gives no way to write a formula AND its last-known result, so the file
# is rewritten once after save. Everything here is defensive: a cell shape it does
# not recognise, a sheet it cannot resolve, a future openpyxl that emits another
# shape all fall through unchanged — the file stays exactly as valid as it was,
# just without the preview. verifyBudgetWorkbook.py asserts the injection actually
# landed, so a silent regression fails the build rather than shipping blank
# workbooks again.
#
# An empty cell is written self-closing (<c r="F6" s="9"/>), so the alternation
# is load-bearing: a pattern that only knew the <c>…</c> form matched the empty
# cell's opening tag and then ran on to the NEXT cell's </c>, swallowing a real
# formula cell inside its own match. Those cells were then never offered to the
# replacer at all.
_CELL_RE = re.compile(rb'<c r="([A-Z]+[0-9]+)"([^>]*?)(?:/>|>(.*?)</c>)', re.DOTALL)
_EMPTY_V_RE = re.compile(rb"<v\s*/>|<v></v>")


def _fmt_num(n):
    if n == int(n) and abs(n) < 1e15:
        return str(int(n))
    return repr(round(n, 10))


def _attr(tag, name):
    m = re.search(rf'\b{name}="([^"]*)"', tag)
    return m.group(1) if m else None


def _sheet_targets(zf):
    """Sheet title -> path inside the package, via the workbook relationships.

    Attributes are read one at a time rather than with a single ordered pattern:
    openpyxl writes Target before Id in the .rels, XML says attribute order is
    not significant, and a pattern that assumed one order silently matched
    nothing (and cached nothing) the first time round.
    """
    book = zf.read("xl/workbook.xml").decode("utf-8")
    rels = zf.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    by_rid = {}
    for tag in re.findall(r"<Relationship\b[^>]*>", rels):
        rid, target = _attr(tag, "Id"), _attr(tag, "Target")
        if rid and target:
            by_rid[rid] = target
    out = {}
    for tag in re.findall(r"<sheet\b[^>]*>", book):
        name, rid = _attr(tag, "name"), _attr(tag, "r:id")
        target = by_rid.get(rid) if rid else None
        if not name or not target:
            continue
        target = target.lstrip("/")
        title = name.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
        out[title] = target if target.startswith("xl/") else f"xl/{target}"
    return out


def _inject_sheet(xml, values):
    """Put each known result inside its formula cell's empty <v />."""
    hits = [0]

    def sub(m):
        coord, attrs, inner = m.group(1).decode(), m.group(2), m.group(3)
        if inner is None or b"<f" not in inner or coord not in values:
            return m.group(0)          # self-closing, no formula, or not ours
        v = _fmt_num(values[coord]).encode()
        if _EMPTY_V_RE.search(inner):
            inner = _EMPTY_V_RE.sub(b"<v>" + v + b"</v>", inner, count=1)
        elif b"<v>" in inner:
            return m.group(0)          # already has a result — leave it alone
        else:
            inner = inner + b"<v>" + v + b"</v>"
        hits[0] += 1
        return b'<c r="' + m.group(1) + b'"' + attrs + b">" + inner + b"</c>"

    return _CELL_RE.sub(sub, xml), hits[0]


def _inject_cached_values(path):
    """Rewrite the package with a cached result on every formula cell we know."""
    if not _CACHE:
        return 0
    by_sheet = {}
    for (sheet, coord), value in _CACHE.items():
        by_sheet.setdefault(sheet, {})[coord] = value

    src = Path(path)
    # Staged beside the target, then os.replace'd over it: same filesystem, so the
    # swap is atomic and a crash mid-rewrite cannot leave a half-written workbook
    # where a complete one used to be.
    staged = src.with_suffix(src.suffix + ".tmp")
    injected = 0
    try:
        with zipfile.ZipFile(src) as zin:
            targets = _sheet_targets(zin)
            paths = {targets[s]: v for s, v in by_sheet.items() if s in targets}
            with zipfile.ZipFile(staged, "w", zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    data = zin.read(item.filename)
                    if item.filename in paths:
                        data, n = _inject_sheet(data, paths[item.filename])
                        injected += n
                    zout.writestr(item, data)
        os.replace(staged, src)
    finally:
        if staged.exists():
            staged.unlink()
    return injected


# ══════════════════════════════════════════════════════════════════════════════
def build(data, out_path):
    _CACHE.clear()
    wb = Workbook()
    wb.remove(wb.active)

    M = Model(data)

    # Order matters: the Budget grid's formulas point at rows on Base Actuals, so
    # that sheet is written (and its rows recorded) first.
    sheet_assumptions(wb, M)
    sheet_base(wb, M)
    sheet_budget(wb, M)

    wb.move_sheet("Budget", offset=-wb.sheetnames.index("Budget"))
    wb.active = 0

    # The model is live formulas, so force a real recalculation the moment the
    # file is trusted. The cached values injected below are only what a reader
    # sees BEFORE that — in Protected View, or a preview pane that never
    # calculates at all.
    wb.calculation.fullCalcOnLoad = True

    wb.save(out_path)
    build.injected = _inject_cached_values(out_path)
    return out_path


def main():
    if len(sys.argv) < 3:
        print("usage: budget_workbook.py <budget.json> <out.xlsx>", file=sys.stderr)
        return 2
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
    out = build(data, sys.argv[2])
    print(json.dumps({"ok": True, "path": out, "cachedCells": getattr(build, "injected", 0)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
