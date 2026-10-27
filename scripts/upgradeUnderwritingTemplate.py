"""
Rewrite the underwriting template's model tabs for the 8-year build.

July-2026 meeting (the owner):
  - every tab runs Year 1 -> Year 8, and the Inputs hold period drives where the
    sale lands (default flipped 5 -> 8)
  - refinance options carried across the extended views: six exit scenarios
    (sale Yr3/Yr5/Yr8, refi Yr3 -> sale Yr5/Yr8, refi Yr5 -> sale Yr8)
  - benchmarks are entered per unit per YEAR, not per month
  - the full-height benchmark column moves off the middle of the Pro Forma and
    becomes a narrow column at the right, just past Year 8
  - the Pro Forma's How/Why column is gone (that's what frees the room for
    Years 6-8; every other tab keeps its notes column)

August-2026 meeting (The owner):
  - Exit Scenarios carries a price-per-door row: gross sale value / unit count,
    labelled "(max price per door)". The scenario table prices the building; a
    buyer argues about the door, and around here ~$300K/door is the realistic
    ceiling — far easier to see per unit than off an eight-figure gross.

DECLARATIVE AND IDEMPOTENT: each affected sheet's cells are written from
scratch every run, so re-running on an already-upgraded template produces the
same file. No underwriting math lives in generator.py — it all lives here, in
the template, exactly as before.

Usage:
    python scripts/upgradeUnderwritingTemplate.py [template.xlsx]
"""
import shutil
import sys
from copy import copy
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.workbook.defined_name import DefinedName

import applyHouseBenchmarks

HERE = Path(__file__).parent
DEFAULT_TEMPLATE = HERE.parent / "underwriting" / "Underwriting Model TEMPLATE.xlsx"

# ── column maps ───────────────────────────────────────────────────────────────
# Pro Forma: A label | B T12 | C T12 $/unit/mo | D..K Year 1-8 | L spacer | M benchmark
PF = ["D", "E", "F", "G", "H", "I", "J", "K"]
PF_BENCH = "M"
# Tax forecast: B..I = Year 1-8, J = note
TAXC = ["B", "C", "D", "E", "F", "G", "H", "I"]
# Debt & Exit cash flow grid: B = Year 0, C..J = Year 1-8, K = note
DE = ["C", "D", "E", "F", "G", "H", "I", "J"]
# Exit Scenarios equity cash flow grid: B = Year 0, C..J = Year 1-8
ES = ["C", "D", "E", "F", "G", "H", "I", "J"]
# Exit Scenarios operating-cash-flow helper block: B..I = Year 1-8
ESOP = ["B", "C", "D", "E", "F", "G", "H", "I"]
# Max Price Solver candidate cap columns
SOLVER = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]

# Share of the purchase-price step-up that flows into the new assessment after a
# sale. Lives on the Tax tab, not Inputs: adding an Inputs row would shift the
# B-cell references every other sheet is pinned to.
REASSESS_PCT = "Tax!$B$19"

YEARS = 8

INCOME_GROWTH = "Inputs!$B$21"
EXPENSE_GROWTH = "Inputs!$B$22"
TAX_GROWTH = "Inputs!$B$23"
UNITS = "Inputs!$B$13"
HOLD = "Inputs!$B$17"
EXIT_CAP = "Inputs!$B$18"
DISPO_COST = "Inputs!$B$19"
LOAN_RATE = "Inputs!$B$16"
REFI_CAP = "Inputs!$B$40"
REFI_LTV = "Inputs!$B$41"
REFI_COST = "Inputs!$B$42"
REFI_RATE = "Inputs!$B$43"
AMORT = "Inputs!$B$46"
IRR_TARGET = "Inputs!$B$47"
COC_TARGET = "Inputs!$B$48"

EQUITY = "'Debt & Exit'!$B$12"


def pf_noi(year):
    """Pro Forma NOI for a model year, as an absolute cross-sheet reference."""
    return f"'Pro Forma'!${PF[year - 1]}$30"


def style_from(ws, src, dst):
    """Copy a cell's full style so new columns/rows don't render as plain text."""
    ws[dst]._style = copy(ws[src]._style)


def unmerge_all(ws):
    """Merged cells are read-only below their top-left, so every sheet we rewrite
    gets flattened first and re-merged afterwards."""
    for rng in list(ws.merged_cells.ranges):
        ws.unmerge_cells(str(rng))


def loan_balance(loan, service, rate, years):
    """Remaining principal after N years of level payments; exact for interest-only."""
    return (f"IF({rate}=0,{loan}-{service}*{years},"
            f"{loan}*(1+{rate})^{years}-{service}*((1+{rate})^{years}-1)/{rate})")


# ── Inputs ────────────────────────────────────────────────────────────────────

def upgrade_inputs(wb):
    ws = wb["Inputs"]
    ws["C10"] = "OM / public record. Text label only."
    ws["B17"] = YEARS
    ws["C17"] = ("Modeling assumption. THE hold-period switch: the model runs eight "
                 "years and the sale lands in this year on Debt & Exit, the Dashboard, "
                 "and the Max Price Solver. 1-8.")
    ws["C18"] = ("Modeling assumption - source needed. Exit value = the hold-period "
                 "year's NOI / exit cap rate.")
    ws["C21"] = "Income grows 3% YoY after value-add bump, Years 2-8."
    ws["C22"] = "Non-tax operating expenses grow 3% YoY, Years 2-8."
    ws["C23"] = ("Modeling assumption - verify the local cap on annual assessment "
                 "growth for THIS jurisdiction. The tax forecast grows by this rate "
                 "after any reassessment, through Year 8.")
    ws["C37"] = "One-time expense charged in Year 1 only. Does not recur or grow in Years 2-8."
    ws["A39"] = "ADDED - SCENARIOS, PHASING & DEBT STRUCTURE"
    ws["C40"] = ("Modeling assumption. Refi value = the refi year's NOI / this cap. "
                 "Exit Scenarios models a Year 3 and a Year 5 refinance.")
    ws["C41"] = "New loan = refi value x this LTV."
    ws["C43"] = ("Placeholder - needs quote. New debt service after refi, on both the "
                 "Year 3 and Year 5 refi cases.")


# ── Tax forecast ──────────────────────────────────────────────────────────────

def upgrade_tax(wb):
    ws = wb["Tax"]

    # The tab shipped hardcoded for Florida: B14 pulled the purchase price
    # unconditionally, so every deal was modeled as resetting to market value on
    # sale. That is Florida law for non-homestead commercial property; it is NOT
    # general. New Jersey bars reassessing a property solely because it sold
    # (Township of West Milford v. Van Decker - "welcome stranger" spot
    # assessment); NJ assessments move on district-wide revaluation instead.
    # Feeding a NJ deal its nominal millage returned roughly 2x the real bill.
    #
    # B19 now carries the policy. 1.0 reproduces the old behaviour exactly, so
    # existing Florida deals are unaffected.
    ws["A1"] = "Property Tax Forecast"
    ws["C6"] = "County / public tax record. Used to verify parcel."
    ws["C7"] = "County / public tax record. Used to confirm subject property."

    ws["A14"] = "Reassessment Basis After Sale"
    ws["B14"] = "=$B$8+('Debt & Exit'!$B$6-$B$8)*$B$19"
    ws["C14"] = ("Calculated by model. Current taxable value plus the share of the "
                 "step-up to purchase price allowed by the reassessment policy in "
                 "B19. At 100% this equals the purchase price; at 0% it stays at "
                 "today's taxable value.")

    ws["A15"] = "New Ad Valorem Tax After Sale"
    ws["B15"] = "=B14*B9/1000"
    ws["C15"] = "Calculated by model. Reassessment basis x current millage / 1,000."

    ws["A16"] = "New Year 1 Total Tax"
    ws["B16"] = "=IF(B9=0,B13*(1+B17),B15+B10)"
    ws["C16"] = ("Calculated by model. New ad valorem tax + non-ad valorem tax. With "
                 "no millage on file it falls back to T12 tax grown one year.")

    ws["A18"] = "Tax Rule Note"
    ws["B18"] = (
        "Reassessment on sale varies by state - set B19 accordingly. Some states "
        "reset to market value on a change of ownership (e.g. Florida non-homestead "
        "commercial, FS 193.1555): use 100%. Others do not - New Jersey bars "
        "reassessing a property solely because it sold (Township of West Milford v. "
        "Van Decker), so assessments move only on a district-wide revaluation: use 0% "
        "for the base case, or 100% together with the EQUALIZED value and the "
        "EFFECTIVE (equalized) millage to model a revaluation landing at market.")
    ws["C18"] = ("Confirm the rule for THIS jurisdiction before relying on Year 1 tax. "
                 "The automated tax lookup writes its finding into B26.")

    ws["A19"] = "Reassessment on Sale (% of Price)"
    ws["B19"] = 1.0
    ws["C19"] = ("INPUT. 100% = assessment resets to the purchase price on sale. "
                 "0% = no reset; Year 1 tax holds at today's taxable value and only "
                 "grows by the tax-growth assumption. Drives this tab AND every "
                 "column of the Max Price Solver.")
    style_from(ws, "A18", "A19")
    style_from(ws, "B13", "B19")
    style_from(ws, "C18", "C19")
    # AFTER style_from: it copies the whole style, currency format included, and
    # would render this rate as "$1" instead of "100%".
    ws["B19"].number_format = "0%"

    # named range so generator.write_scalars can set the policy per deal, the
    # same way it sets taxable value and millage
    if "Tax_ReassessPct" in wb.defined_names:
        del wb.defined_names["Tax_ReassessPct"]
    wb.defined_names.add(DefinedName("Tax_ReassessPct", attr_text="Tax!$B$19"))

    for i, c in enumerate(TAXC, start=1):
        if c not in ("B", "C"):
            style_from(ws, f"C21", f"{c}21")
            style_from(ws, f"C22", f"{c}22")
        ws[f"{c}21"] = f"Year {i}"
    ws["B22"] = "=B16"
    for i, c in enumerate(TAXC[1:], start=1):
        ws[f"{c}22"] = f"={TAXC[i - 1]}22*(1+$B$17)"
    ws["J21"] = "How/Why"
    ws["J22"] = ("Year 1 applies the reassessment policy in B19 to the purchase price, "
                 "then grows by the tax growth assumption through Year 8.")
    ws["A21"] = "Tax Forecast"

    # Deal-agnostic: the county URL and the jurisdiction's tax rule are written
    # per deal by generator.write_tax_sources. Shipping Florida values here made
    # every non-FL model cite a Hillsborough County parcel search.
    ws["A25"] = "County source URL"
    ws["B25"] = None
    ws["A26"] = "Tax rule / source URL"
    ws["B26"] = None


# ── Pro Forma ─────────────────────────────────────────────────────────────────

def upgrade_pro_forma(wb):
    ws = wb["Pro Forma"]

    # capture the styles we're about to spread across the new layout, before
    # anything is overwritten: old E = Year 1, old D = benchmark input.
    year_style = {r: copy(ws[f"E{r}"]._style) for r in range(5, 37)}
    bench_style = {r: copy(ws[f"D{r}"]._style) for r in range(5, 37)}

    unmerge_all(ws)
    ws.merge_cells("A1:M1")

    # wipe the old grid (E:J held Years 1-5 + How/Why; D held the benchmarks)
    for r in range(2, 37):
        for c in ("D", "E", "F", "G", "H", "I", "J", "K", "L", "M"):
            ws[f"{c}{r}"] = None

    for r in range(5, 37):
        for c in PF:
            ws[f"{c}{r}"]._style = copy(year_style[r])
        ws[f"{PF_BENCH}{r}"]._style = copy(bench_style[r])

    ws["A1"] = "Eight-Year Pro Forma - Company Underwriting Case"
    ws["A2"] = f"={PF[0]}30"
    ws["B2"] = f"={PF[7]}30"
    ws["C2"] = f"={PF[0]}36"
    ws["D2"] = f"={PF[1]}36"
    ws["A3"] = "YEAR 1 NOI"
    ws["B3"] = "YEAR 8 NOI"
    ws["C3"] = "YEAR 1 CASH-ON-CASH"
    ws["D3"] = "YEAR 2 CASH-ON-CASH"
    ws["A4"] = ("Benchmark column sits at the right, just past Year 8: OUR number in "
                "$ per unit per YEAR. Blank = the model uses the T12-based figure. "
                "Enter a value and that line switches to benchmark x units from Year 1 "
                "on, then grows with expense growth.")

    ws["A5"] = "Line Item"
    ws["B5"] = "T12 / Source"
    ws["C5"] = "T12 $/Unit/Mo"
    for i, c in enumerate(PF, start=1):
        ws[f"{c}5"] = f"Year {i}"
    ws[f"{PF_BENCH}5"] = "Benchmark ($/Unit/Yr)"

    y1, y2 = PF[0], PF[1]

    # ── income ────────────────────────────────────────────────────────────────
    ws[f"{y1}6"] = ("=('Rent Roll'!$B$16*12)+('Rent Roll'!$B$15*12-'Rent Roll'!$B$16*12)"
                    "*Inputs!$B$44")
    ws[f"{y2}6"] = f"=('Rent Roll'!$B$15*12)*(1+{INCOME_GROWTH})"
    for i in range(2, YEARS):
        ws[f"{PF[i]}6"] = f"={PF[i - 1]}6*(1+{INCOME_GROWTH})"

    ws[f"{y1}7"] = "='Reno Pace'!$B$33"
    ws[f"{y2}7"] = "='Reno Pace'!$B$36"
    ws[f"{PF[2]}7"] = f"='Reno Pace'!$B$37*(1+{INCOME_GROWTH})"
    for i in range(3, YEARS):
        ws[f"{PF[i]}7"] = f"={PF[i - 1]}7*(1+{INCOME_GROWTH})"

    for i, c in enumerate(PF):
        ws[f"{c}8"] = f"={c}6+{c}7"
        ws[f"{c}9"] = "=1-StabilizedOccupancyTarget"
        ws[f"{c}10"] = f"=-{c}8*{c}9"
        ws[f"{c}11"] = f"=-{c}8*Inputs!$B$24"
        ws[f"{c}13"] = f"=SUM({c}8:{c}12)"
        ws[f"{c}15"] = f"={c}13+{c}14"

    ws[f"{y1}12"] = "=-Inputs!$B$29"
    ws[f"{y1}14"] = f"=(B14+AdditionalOtherIncome)*(1+{INCOME_GROWTH})"
    for i in range(1, YEARS):
        ws[f"{PF[i]}12"] = f"={PF[i - 1]}12*(1+{INCOME_GROWTH})"
        ws[f"{PF[i]}14"] = f"={PF[i - 1]}14*(1+{INCOME_GROWTH})"

    # ── expenses ──────────────────────────────────────────────────────────────
    # benchmark-driven lines: benchmark x units in Year 1 (per unit per YEAR now,
    # so no x12), then grown with expense growth like every other expense line.
    for r in (16, 17, 18, 19, 20, 22, 23, 25):
        ws[f"{y1}{r}"] = (f"=IF(${PF_BENCH}{r}>0,${PF_BENCH}{r}*Units,"
                          f"B{r}*(1+{EXPENSE_GROWTH}))")
        for i in range(1, YEARS):
            ws[f"{PF[i]}{r}"] = f"={PF[i - 1]}{r}*(1+{EXPENSE_GROWTH})"

    ws[f"{y1}21"] = f"=B21*(1+{EXPENSE_GROWTH})"
    for i in range(1, YEARS):
        ws[f"{PF[i]}21"] = f"={PF[i - 1]}21*(1+{EXPENSE_GROWTH})"

    # property taxes: county forecast unless a benchmark overrides the line
    ws[f"{y1}24"] = f"=IF(${PF_BENCH}24>0,${PF_BENCH}24*Units,Tax!$B$22)"
    for i in range(1, YEARS):
        ws[f"{PF[i]}24"] = (f"=IF(${PF_BENCH}24>0,{PF[i - 1]}24*(1+{TAX_GROWTH}),"
                            f"Tax!${TAXC[i]}$22)")

    ws[f"{y1}26"] = "=Inputs!$B$37"
    for i in range(1, YEARS):
        ws[f"{PF[i]}26"] = "=0"

    for r, pct in ((27, "Inputs!$B$27"), (28, "Inputs!$B$28")):
        ws[f"{y1}{r}"] = (f"=IF(${PF_BENCH}{r}>0,${PF_BENCH}{r}*Units,"
                          f"{y1}15*{pct})")
        for i in range(1, YEARS):
            ws[f"{PF[i]}{r}"] = (f"=IF(${PF_BENCH}{r}>0,{PF[i - 1]}{r}*(1+{EXPENSE_GROWTH}),"
                                 f"{PF[i]}15*{pct})")

    for c in PF:
        ws[f"{c}29"] = f"=SUM({c}16:{c}28)"
        ws[f"{c}30"] = f"={c}15-{c}29"
        ws[f"{c}31"] = f"=IFERROR({c}30/{c}15,0)"
        ws[f"{c}34"] = "='Debt & Exit'!$B$17"
        ws[f"{c}35"] = f"={c}30-{c}34"
        ws[f"{c}36"] = f"={c}35/{EQUITY}"

    ws.column_dimensions["A"].width = 34
    for c in PF:
        ws.column_dimensions[c].width = 15
    ws.column_dimensions["L"].width = 3
    ws.column_dimensions[PF_BENCH].width = 22


# ── Debt & Exit ───────────────────────────────────────────────────────────────

def upgrade_debt_exit(wb):
    ws = wb["Debt & Exit"]
    year_style = {r: copy(ws[f"C{r}"]._style) for r in range(19, 29)}
    note_style = {r: copy(ws[f"H{r}"]._style) for r in range(19, 29)}

    for r in range(19, 29):
        for c in ("C", "D", "E", "F", "G", "H", "I", "J", "K"):
            ws[f"{c}{r}"] = None
        for c in DE:
            ws[f"{c}{r}"]._style = copy(year_style[r])
        ws[f"K{r}"]._style = copy(note_style[r])

    ws["C3"] = f'="LEVERED IRR ("&{HOLD}&"-YR)"'
    ws["B13"] = f"=INDEX('Pro Forma'!${PF[0]}$30:${PF[7]}$30,{HOLD})/{EXIT_CAP}"
    ws["C13"] = ("The hold-period year's NOI / exit cap rate. Change Hold Period on "
                 "Inputs and the sale moves with it. Sale proceeds before costs.")
    ws["C15"] = ("Loan balance at the end of the hold period; equals the original loan "
                 "when interest-only.")

    ws["B19"] = "Year 0"
    for i, c in enumerate(DE, start=1):
        ws[f"{c}19"] = f"Year {i}"
    ws["K19"] = "How/Why"

    for i, c in enumerate(DE, start=1):
        ws[f"{c}20"] = f"={pf_noi(i)}"
        ws[f"{c}21"] = f"=IF({HOLD}>={i},$B$17,0)"
        ws[f"{c}22"] = f"=IF({HOLD}>={i},{c}20-{c}21,0)"
        ws[f"{c}23"] = f"=IF({HOLD}={i},$B$16,0)"
        ws[f"{c}24"] = f"={c}22+{c}23"
        ws[f"{c}27"] = f"={c}22/$B$12"

    ws["B24"] = "=-$B$12"
    ws["B25"] = f"=IFERROR(IRR(B24:{DE[-1]}24),0)"
    ws["B26"] = f"=SUM({DE[0]}24:{DE[-1]}24)/ABS(B24)"
    ws["B28"] = f"=IFERROR(SUM({DE[0]}27:{DE[-1]}27)/{HOLD},0)"

    ws["K20"] = "Linked from the Pro Forma, Years 1-8."
    ws["K21"] = "Acquisition debt service; zero once the hold period is over."
    ws["K22"] = "NOI less debt service, through the hold period only."
    ws["K23"] = "Net sale proceeds, in whichever year the Inputs hold period says."
    ws["K24"] = ("Year 0 is initial equity; operating cash flow plus net sale proceeds "
                 "in the exit year.")
    ws["K25"] = "IRR of Year 0 through Year 8 total cash flows, including sale proceeds."
    ws["K26"] = "Total positive cash distributions / initial equity."
    ws["K27"] = "Annual cash flow after debt / initial equity. Shows distribution timing."
    ws["K28"] = "Average annual CoC across the hold period."

    for c in DE:
        ws.column_dimensions[c].width = 15
    ws.column_dimensions["K"].width = 58


# ── Exit Scenarios ────────────────────────────────────────────────────────────

SCENARIOS = [
    # label, sale year, refi year (None = no refi)
    ("Sale Year 3", 3, None),
    ("Sale Year 5", 5, None),
    ("Sale Year 8", 8, None),
    ("Refi Yr3 + Sale Yr5", 5, 3),
    ("Refi Yr3 + Sale Yr8", 8, 3),
    ("Refi Yr5 + Sale Yr8", 8, 5),
]
SC_COLS = ["B", "C", "D", "E", "F", "G"]

# supporting-calc rows
R_ACQ_DS = 29
R_ACQ_BAL = {3: 30, 5: 31, 8: 32}
R_REFI = {3: {"loan": 33, "ds": 34, "bal": {5: 35, 8: 36}},
          5: {"loan": 37, "ds": 38, "bal": {8: 39}}}
R_OPCF = {None: 42, 3: 43, 5: 44}   # operating cash flow by year, per debt stack


def es_opcf(ws_year, refi_year):
    """Cell holding operating cash flow for a model year on a given debt stack."""
    return f"${ESOP[ws_year - 1]}${R_OPCF[refi_year]}"


def upgrade_exit_scenarios(wb):
    ws = wb["Exit Scenarios"]
    metric_style = {r: copy(ws[f"B{r}"]._style) for r in range(5, 25)}
    note_style = copy(ws["F6"]._style)
    unmerge_all(ws)

    for r in range(1, 56):
        for c in ("B", "C", "D", "E", "F", "G", "H", "I", "J"):
            ws[f"{c}{r}"] = None
        if r >= 26:
            ws[f"A{r}"] = None
    for r in range(5, 25):
        for c in SC_COLS:
            ws[f"{c}{r}"]._style = copy(metric_style[r])
        ws[f"H{r}"]._style = copy(note_style)
    # Row 19 (price per door) had no style of its own to copy — it was a blank
    # spacer before 2026-08-25. It is dollars, so it borrows row 8's, the row it
    # divides. generator.py re-applies the same format on every generated model;
    # this is so the TEMPLATE reads correctly when someone opens it directly.
    for c in SC_COLS:
        ws[f"{c}19"]._style = copy(metric_style[8])

    ws["A1"] = "Exit Scenarios - Sale and Refinance Options Through Year 8"
    ws["A2"] = "=IFERROR(INDEX(B5:G5,MATCH(MAX(B14:G14),B14:G14,0)),0)"
    ws["B2"] = "=MAX(B14:G14)"
    ws["C2"] = "=C16"
    ws["D2"] = f"={IRR_TARGET}"
    ws["A3"] = "BEST IRR SCENARIO"
    ws["B3"] = "BEST IRR"
    ws["C3"] = "YEAR 2 CASH-ON-CASH"
    ws["D3"] = "IRR TARGET"

    ws["A5"] = "Metric"
    for c, (label, _, _) in zip(SC_COLS, SCENARIOS):
        ws[f"{c}5"] = label
    ws["H5"] = "Notes"

    for c, (_, sale, refi) in zip(SC_COLS, SCENARIOS):
        if refi:
            ws[f"{c}6"] = (f'=TEXT({REFI_CAP},"0.0%") & " refi / " & '
                           f'TEXT({EXIT_CAP},"0.0%") & " exit"')
        else:
            ws[f"{c}6"] = f"={EXIT_CAP}"
        ws[f"{c}7"] = sale
        ws[f"{c}8"] = f"={pf_noi(sale)}/{EXIT_CAP}"
        if refi:
            loan = f"$B${R_REFI[refi]['loan']}"
            ws[f"{c}9"] = f"={loan}-$B${R_ACQ_BAL[refi]}-{loan}*{REFI_COST}"
            ws[f"{c}11"] = f"=$B${R_REFI[refi]['bal'][sale]}"
        else:
            ws[f"{c}11"] = f"=$B${R_ACQ_BAL[sale]}"
        ws[f"{c}10"] = f"={c}8*{DISPO_COST}"
        ws[f"{c}12"] = f"={c}8-{c}10-{c}11"
        ws[f"{c}13"] = f"={EQUITY}"
        # Price per door (2026-08-25 meeting, The owner). The scenario table prices
        # the building; this prices the DOOR, which is the number a buyer argues
        # about. Around here roughly $300K/door is the realistic ceiling, so a
        # scenario that only works at $380K/door is not a scenario — it is a
        # marketing problem, and it is far easier to see per unit than off an
        # eight-figure gross. Sits at the foot of the metric table rather than
        # under Gross Sale Value on purpose: every row below 8 is referenced by
        # number from three places, and a per-door check is not worth renumbering
        # the IRR block for.
        ws[f"{c}19"] = f'=IFERROR({c}8/{UNITS},"n/a")'

    ws["A6"] = "Exit / Refi Cap Rate"
    ws["A7"] = "Hold Period (yrs)"
    ws["A8"] = "Gross Sale Value"
    ws["A9"] = "Net Refi Proceeds"
    ws["A10"] = "Disposition Cost (at sale)"
    ws["A11"] = "Loan Payoff at Sale"
    ws["A12"] = "Net Sale Proceeds"
    ws["A13"] = "Initial Equity"
    ws["A14"] = "Levered IRR"
    ws["A15"] = "Equity Multiple"
    ws["A16"] = "Year 2 Cash-on-Cash"
    ws["A17"] = "Avg Cash-on-Cash"
    ws["A18"] = "Refi Case Interpretation"
    ws["A19"] = "Gross Sale Value / Unit (max price per door)"

    ws["H6"] = ("Refi cases size the new loan on the refi cap in the refi year, then "
                "sell on the exit cap.")
    ws["H7"] = "Sale year for the scenario. Year 6-8 NOI is real Pro Forma NOI, not a stand-in."
    ws["H8"] = "That year's Pro Forma NOI / exit cap rate."
    ws["H9"] = ("Cash-out at refi: new loan less the acquisition balance and refi "
                "closing cost. Treated as an investor distribution, not added spend.")
    ws["H10"] = "Disposition / closing cost % of sale value."
    ws["H11"] = "Refi cases repay the new refi loan at sale; the others repay the acquisition loan."
    ws["H12"] = "Sale value - disposition cost - loan payoff."
    ws["H13"] = "Same day-one equity across scenarios."
    ws["H14"] = "IRR includes interim distributions, refi proceeds, and final net sale proceeds."
    ws["H15"] = "Total distributions / equity in."
    ws["H16"] = "Year 2 operating cash flow / equity - identical pre-refi across scenarios."
    ws["H17"] = "Average operating CoC over the scenario's hold, on whichever debt is in place."
    ws["H18"] = ("No incremental upgrades are modeled from refi proceeds unless a "
                 "separate use-of-proceeds budget and NOI ramp are added.")
    ws["H19"] = ("Gross sale value / unit count (Inputs). What the exit asks a buyer to "
                 "pay per door - the ceiling the local market will actually clear, "
                 "regardless of what the cap rate math says.")

    # ── equity cash flow grid ────────────────────────────────────────────────
    ws["A20"] = "Equity Cash Flow"
    ws["B20"] = "Year 0"
    for i, c in enumerate(ES, start=1):
        ws[f"{c}20"] = f"Year {i}"

    for idx, (label, sale, refi) in enumerate(SCENARIOS):
        row = 21 + idx
        col = SC_COLS[idx]
        ws[f"A{row}"] = label
        ws[f"B{row}"] = f"=-{EQUITY}"
        for year in range(1, sale + 1):
            cell = f"{ES[year - 1]}{row}"
            stack = refi if (refi and year > refi) else None
            expr = es_opcf(year, stack)
            if refi and year == refi:
                expr += f"+${col}$9"
            if year == sale:
                expr += f"+${col}$12"
            ws[cell] = f"={expr}"
        last = ES[sale - 1]
        ws[f"{col}14"] = f"=IFERROR(IRR(B{row}:{last}{row}),\"NM\")"
        ws[f"{col}15"] = f"=SUM(C{row}:{last}{row})/{EQUITY}"
        ws[f"{col}16"] = f"=$D$21/{EQUITY}"

        # average operating CoC: acquisition-debt years, then post-refi years
        pre_end = ESOP[(refi or sale) - 1]
        parts = [f"$B${R_OPCF[None]}:${pre_end}${R_OPCF[None]}"]
        if refi:
            parts.append(f"${ESOP[refi]}${R_OPCF[refi]}:${ESOP[sale - 1]}${R_OPCF[refi]}")
        ws[f"{col}17"] = f"=AVERAGE({','.join(parts)})/{EQUITY}"
        ws[f"{col}18"] = (f"Cash-out refinance in Year {refi}; sell Year {sale}"
                          if refi else "No refinance")

    # ── supporting calcs ─────────────────────────────────────────────────────
    ws["A28"] = "Supporting Calcs"
    ws["H28"] = "How calculated"
    ws[f"A{R_ACQ_DS}"] = "Annual acquisition debt service"
    ws[f"B{R_ACQ_DS}"] = "='Debt & Exit'!$B$17"
    ws[f"H{R_ACQ_DS}"] = "Linked from Debt & Exit."
    for year, row in R_ACQ_BAL.items():
        ws[f"A{row}"] = f"Acq loan balance @ Yr{year}"
        ws[f"B{row}"] = "=" + loan_balance("'Debt & Exit'!$B$8", f"$B${R_ACQ_DS}",
                                           LOAN_RATE, year)
        ws[f"H{row}"] = f"Acquisition loan balance after {year} years of debt service."

    for refi_year, spec in R_REFI.items():
        ws[f"A{spec['loan']}"] = f"Refi @ Yr{refi_year} - new loan"
        ws[f"B{spec['loan']}"] = f"=({pf_noi(refi_year)}/{REFI_CAP})*{REFI_LTV}"
        ws[f"H{spec['loan']}"] = f"Year {refi_year} NOI / refi cap rate x refi LTV."
        ws[f"A{spec['ds']}"] = f"Refi @ Yr{refi_year} - annual debt service"
        ws[f"B{spec['ds']}"] = (f"=IF({AMORT}=0,$B${spec['loan']}*{REFI_RATE},"
                                f"-PMT({REFI_RATE},{AMORT},$B${spec['loan']}))")
        ws[f"H{spec['ds']}"] = "Interest-only unless an amortization term is set on Inputs."
        for sale_year, row in spec["bal"].items():
            ws[f"A{row}"] = f"Refi @ Yr{refi_year} - balance @ Yr{sale_year}"
            ws[f"B{row}"] = "=" + loan_balance(f"$B${spec['loan']}", f"$B${spec['ds']}",
                                               REFI_RATE, sale_year - refi_year)
            ws[f"H{row}"] = f"New refi loan payoff if sold in Year {sale_year}."

    ws["A40"] = "Operating Cash Flow by Year (Pro Forma NOI less debt service)"
    for i, c in enumerate(ESOP, start=1):
        ws[f"{c}41"] = f"Year {i}"
    ws[f"A{R_OPCF[None]}"] = "On acquisition debt"
    for i, c in enumerate(ESOP, start=1):
        ws[f"{c}{R_OPCF[None]}"] = f"={pf_noi(i)}-$B${R_ACQ_DS}"
    for refi_year, spec in R_REFI.items():
        ws[f"A{R_OPCF[refi_year]}"] = f"On Yr{refi_year} refi debt"
        for i in range(refi_year + 1, YEARS + 1):
            ws[f"{ESOP[i - 1]}{R_OPCF[refi_year]}"] = f"={pf_noi(i)}-$B${spec['ds']}"
    ws["H40"] = ("Every scenario's cash flow is built from these rows, so the grid stays "
                 "independent of the Inputs hold period on Debt & Exit.")

    # ── returns vs targets ───────────────────────────────────────────────────
    ws["A46"] = "RETURNS vs TARGETS"
    ws["A47"] = "Scenario"
    ws["B47"] = "IRR"
    ws["C47"] = "vs IRR Target"
    ws["D47"] = "Yr2 CoC"
    ws["E47"] = "vs CoC Target"
    for idx, (label, _, _) in enumerate(SCENARIOS):
        row = 48 + idx
        col = SC_COLS[idx]
        ws[f"A{row}"] = label
        ws[f"B{row}"] = f"={col}14"
        ws[f"C{row}"] = f'=IF(AND(ISNUMBER({col}14),{col}14>={IRR_TARGET}),"PASS","FLAG")'
        ws[f"D{row}"] = f"={col}16"
        ws[f"E{row}"] = f'=IF({col}16>={COC_TARGET},"PASS","FLAG")'

    ws["A55"] = "Note"
    ws["B55"] = ("Refi cases model a longer hold on new debt, not a refi-funded "
                 "renovation. Years 6-8 use real Pro Forma NOI.")
    ws.merge_cells("B55:J55")

    for c in SC_COLS:
        ws.column_dimensions[c].width = 17
    ws.column_dimensions["H"].width = 58


# ── Max Price Solver ──────────────────────────────────────────────────────────

SOLVER_NOI_ROW0 = 14          # NOI Year 1 .. Year 8 -> rows 14-21
SOLVER_CF_ROW0 = 25           # Year 0 cash flow -> row 25, Years 1-8 -> 26-33


def upgrade_solver(wb):
    ws = wb["Max Price Solver"]
    body_style = {c: copy(ws[f"{c}18"]._style) for c in SOLVER}
    label_style = copy(ws["A18"]._style)
    note_style = copy(ws["D35"]._style)

    for r in range(14, 48):
        for c in SOLVER + ["A", "M", "N", "O", "P"]:
            ws[f"{c}{r}"] = None

    for r in range(SOLVER_NOI_ROW0, 38):
        ws[f"A{r}"]._style = copy(label_style)
        for c in SOLVER:
            ws[f"{c}{r}"]._style = copy(body_style[c])

    ws["A1"] = ("Max Price Solver - What Purchase Price Makes This Deal Work?  "
                "(sale in the Inputs hold-period year)")
    ws["A4"] = (
        "Each column reprices the whole deal at a different purchase cap rate: price, "
        "loan, equity, debt service, and property tax. Tax follows the reassessment "
        "policy on the Tax tab (B19): at 100% each column is taxed on its own "
        "candidate price; at 0% the tax line stays flat across the sweep, which is "
        "correct where a sale does not move the assessment. With no millage on file "
        "it falls back to the Tax tab's Year 1 figure. All other assumptions come "
        "from the Inputs tab. The summary block below interpolates the exact price "
        "that clears the IRR target.")

    # Row 13 carried the same hardcoded Florida reset as Tax!B14 — every column
    # taxed the candidate purchase price in full. It now honours the Tax tab's
    # reassessment policy, so at 0% the tax line correctly stays flat across the
    # cap-rate sweep instead of rising with price.
    #
    # It also guards millage = 0. Previously that made this row collapse to the
    # non-ad-valorem amount (usually 0) while row 14 still added Tax!B22 back,
    # cancelling property tax out of NOI altogether and overstating max price.
    # With no millage on file, fall back to the Tax tab's Year 1 figure, which is
    # price-independent — the honest answer when there is no county data.
    ws["A13"] = "Year 1 Property Tax (per reassessment policy)"
    for c in SOLVER:
        ws[f"{c}13"] = (
            f"=IF(Tax!$B$9=0,Tax!$B$16,"
            f"(Tax!$B$8+({c}8-Tax!$B$8)*{REASSESS_PCT})*Tax!$B$9/1000+Tax!$B$10)")

    for i in range(1, YEARS + 1):
        row = SOLVER_NOI_ROW0 + i - 1
        ws[f"A{row}"] = f"NOI Year {i} (tax-adjusted)"
        for c in SOLVER:
            grown = "" if i == 1 else f"*(1+{TAX_GROWTH})^{i - 1}"
            ws[f"{c}{row}"] = f"={pf_noi(i)}+Tax!${TAXC[i - 1]}$22-{c}$13{grown}"

    noi_first = f"{SOLVER_NOI_ROW0}"
    noi_last = f"{SOLVER_NOI_ROW0 + YEARS - 1}"
    ws["A22"] = "Gross Exit Value (hold-period NOI / exit cap)"
    ws["A23"] = "Loan Payoff at Exit"
    ws["A24"] = "Net Sale Proceeds (less disposition cost)"
    for c in SOLVER:
        ws[f"{c}22"] = f"=INDEX({c}${noi_first}:{c}${noi_last},{HOLD})/{EXIT_CAP}"
        ws[f"{c}23"] = ("=" + loan_balance(f"{c}$10", f"{c}$12", LOAN_RATE, HOLD))
        ws[f"{c}24"] = f"={c}22*(1-{DISPO_COST})-{c}23"

    ws[f"A{SOLVER_CF_ROW0}"] = "Equity Cash Flow - Year 0"
    for c in SOLVER:
        ws[f"{c}{SOLVER_CF_ROW0}"] = f"=-{c}11"
    for i in range(1, YEARS + 1):
        row = SOLVER_CF_ROW0 + i
        ws[f"A{row}"] = f"Equity Cash Flow - Year {i}"
        for c in SOLVER:
            noi = f"{c}{SOLVER_NOI_ROW0 + i - 1}"
            ws[f"{c}{row}"] = (f"=IF({HOLD}<{i},0,{noi}-{c}$12+IF({HOLD}={i},{c}$24,0))")

    cf_last = SOLVER_CF_ROW0 + YEARS
    ws["A34"] = "Levered IRR"
    ws["A35"] = "Year 2 Cash-on-Cash"
    ws["A36"] = "IRR vs Target"
    ws["A37"] = "Yr2 CoC vs Target"
    for c in SOLVER:
        ws[f"{c}34"] = f"=IFERROR(IRR({c}{SOLVER_CF_ROW0}:{c}{cf_last}),0)"
        ws[f"{c}35"] = f"={c}{SOLVER_CF_ROW0 + 2}/{c}11"
        ws[f"{c}36"] = f'=IF({c}34>={IRR_TARGET},"PASS","FLAG")'
        ws[f"{c}37"] = f'=IF({c}35>={COC_TARGET},"PASS","FLAG")'

    ws["A39"] = "SOLVED: MAXIMUM PRICE TO HIT THE IRR TARGET"
    ws["A40"] = "Columns failing the target (helper)"
    ws["B40"] = f'=COUNTIF(B34:L34,"<"&{IRR_TARGET})'
    ws["A41"] = "Solved Purchase Cap Rate @ IRR Target"
    # written here rather than left to the generator so the template is complete on
    # its own; generator.py re-patches it by label after filling a deal.
    ws["B41"] = ('=IF(B40=0,"Below 5.50% - expand range",'
                 'IF(B40>=11,"Above 8.00% - not achievable in range",'
                 'INDEX(B7:L7,B40)+(INDEX(B7:L7,B40+1)-INDEX(B7:L7,B40))*'
                 f'({IRR_TARGET}-INDEX(B34:L34,B40))/'
                 '(INDEX(B34:L34,B40+1)-INDEX(B34:L34,B40))))')
    ws["A42"] = "Max Purchase Price @ IRR Target"
    ws["B42"] = "=IF(ISNUMBER(B41),'T12 Actuals'!$B$23/B41,\"-\")"
    ws["A43"] = "Max Price Per Unit"
    ws["B43"] = '=IF(ISNUMBER(B42),B42/Inputs!$B$13,"-")'
    ws["A44"] = "Discount vs Current Cap-Rate Basis"
    ws["B44"] = "=IF(ISNUMBER(B42),1-B42/'Debt & Exit'!$B$6,\"-\")"
    ws["A45"] = "Year 2 Cash-on-Cash at Solved Price"
    ws["B45"] = ('=IF(ISNUMBER(B41),IF(B40=0,INDEX(B35:L35,1),'
                 'INDEX(B35:L35,B40)+(INDEX(B35:L35,B40+1)-INDEX(B35:L35,B40))*'
                 f'({IRR_TARGET}-INDEX(B34:L34,B40))/'
                 '(INDEX(B34:L34,B40+1)-INDEX(B34:L34,B40))),"-")')

    for r in (40, 41, 42, 43, 44, 45):
        ws[f"D{r}"]._style = copy(note_style)
    ws["D40"] = "Counts candidate caps whose IRR is below target; used to bracket the solve."
    ws["A47"] = ("Note: the solver sells in the Inputs hold-period year (Years 1-8 are "
                 "all modeled). Changing any Inputs assumption re-solves automatically.")

    # headline tiles
    ws["A2"] = "=B42"
    ws["B2"] = "=B43"
    ws["C2"] = "=B44"


# ── Dashboard ─────────────────────────────────────────────────────────────────

def upgrade_dashboard(wb):
    ws = wb["Dashboard"]
    detail_style = {c: copy(ws[f"{c}22"]._style) for c in ("A", "B", "C")}
    sc_style = {c: copy(ws[f"{c}40"]._style) for c in ("A", "B", "C", "D", "E")}
    unmerge_all(ws)
    ws.merge_cells("A1:F1")
    ws.merge_cells("A2:F2")

    for r in range(15, 50):
        for c in ("A", "B", "C", "D", "E", "F"):
            ws[f"{c}{r}"] = None

    ws["D7"] = f"=IFERROR({pf_noi(1)},0)"
    ws["F7"] = "='Max Price Solver'!$B$42"   # solver's solved-price row moved
    ws["A10"] = "='Debt & Exit'!$B$25"
    ws["B10"] = "=IFERROR('Debt & Exit'!$B$26,0)"
    ws["C10"] = "=IFERROR('Exit Scenarios'!$C$16,0)"
    ws["D10"] = f"=IFERROR({pf_noi(1)}/'Debt & Exit'!$C$21,0)"
    ws["A11"] = f'="LEVERED IRR (SALE YR"&{HOLD}&")"'

    details = [
        ("Units", "=Inputs!$B$13", "Linked to Inputs."),
        ("T12 NOI", "='T12 Actuals'!$B$23", "Actual trailing-12 NOI."),
        ("Purchase Price", "='Debt & Exit'!$B$6",
         "T12 NOI / purchase cap rate, unless an override price is entered on Inputs."),
        ("Price Per Unit", "=IFERROR('Debt & Exit'!$B$7,0)", "Purchase price / total units."),
        ("Loan Amount", "='Debt & Exit'!$B$8", "Purchase price x LTV."),
        ("Initial Equity Required", "='Debt & Exit'!$B$12", "Price + capex + closing - loan."),
        ("Year 1 NOI", f"=IFERROR({pf_noi(1)},0)",
         "In-place rent + partial loss-to-lease + reno premium net of downtime, less "
         "normalized expenses and reset taxes. Capex is NOT in NOI."),
        ("Year 5 NOI", f"={pf_noi(5)}", "Full reno premium + income growth, less reset taxes."),
        ("Year 8 NOI", f"={pf_noi(8)}", "Year 8 of the extended pro forma - drives the Year 8 exits."),
        ("Year 1 DSCR", f"=IFERROR({pf_noi(1)}/'Debt & Exit'!$C$21,0)",
         "Year 1 NOI / annual debt service."),
        ("Levered IRR (hold-period sale)", "='Debt & Exit'!$B$25",
         "Full equity cash flows through the Inputs hold period, incl. net sale proceeds."),
        ("Equity Multiple", "=IFERROR('Debt & Exit'!$B$26,0)",
         "Total distributions / initial equity."),
        ("Current County Tax", "=Tax!$B$12", "Taxable value x millage + non-ad valorem."),
        ("New Tax After Sale", "=Tax!$B$16",
         "Purchase price x millage + non-ad valorem (FL reassessment)."),
        ("Official Rent Roll Occupancy", "='Rent Roll'!$B$10", "From rent roll report summary."),
        ("Current Avg Rent / Unit", "=IFERROR('Rent Roll'!$B$19/Inputs!$B$13,0)",
         "In-place charges with vacant units counted at market rent, / total units."),
        ("Target Avg Rent Post-Reno",
         "=IFERROR(('Rent Roll'!$B$16+Inputs!$B$30*Inputs!$B$31)/Inputs!$B$13,0)",
         "Current in-place + value-add units x monthly premium, / total units."),
        ("Market Avg Occupancy (OM comp set)", "='Rent Comps'!$L$12",
         "Average of the comp set occupancy - compare to subject for occupancy upside."),
        ("Units to Renovate", "=Inputs!$B$30", "Value-add units from Inputs."),
        ("Total NOI Opportunity", "=Inputs!$B$30*Inputs!$B$31*12",
         "Value-add units x monthly premium x 12, before downtime."),
        ("Max Price to Hit IRR Target", "='Max Price Solver'!$B$42",
         "Interpolated on the Max Price Solver tab, selling in the hold-period year."),
        ("   ...same, per unit", "='Max Price Solver'!$B$43", "Solved max price / total units."),
    ]
    ws["A13"] = "DETAILS - HOW EACH NUMBER IS BUILT"
    ws["A14"] = "Metric"
    ws["B14"] = "Value"
    ws["C14"] = "How calculated"
    for i, (label, formula, how) in enumerate(details):
        r = 15 + i
        for c in ("A", "B", "C"):
            ws[f"{c}{r}"]._style = copy(detail_style[c])
        ws[f"A{r}"] = label
        ws[f"B{r}"] = formula
        ws[f"C{r}"] = how
        ws.merge_cells(f"C{r}:F{r}")

    head = 15 + len(details) + 1
    ws[f"A{head}"] = "RETURNS vs TARGETS  (detail on Exit Scenarios tab)"
    ws.merge_cells(f"A{head}:F{head}")
    ws.merge_cells("A13:F13")
    hdr = head + 1
    for c, label in zip(("A", "B", "C", "D", "E"),
                        ("Scenario", "IRR", "Equity Multiple", "IRR Target", "Status")):
        ws[f"{c}{hdr}"]._style = copy(sc_style[c])
        ws[f"{c}{hdr}"] = label
    for i, (label, _, _) in enumerate(SCENARIOS):
        r = hdr + 1 + i
        col = SC_COLS[i]
        for c in ("A", "B", "C", "D", "E"):
            ws[f"{c}{r}"]._style = copy(sc_style[c])
        ws[f"A{r}"] = label
        ws[f"B{r}"] = f"='Exit Scenarios'!{col}14"
        ws[f"C{r}"] = f"=IFERROR('Exit Scenarios'!{col}15,0)"
        ws[f"D{r}"] = f"={IRR_TARGET}"
        ws[f"E{r}"] = f"='Exit Scenarios'!$C${48 + i}"
    coc = hdr + 1 + len(SCENARIOS)
    for c in ("A", "B", "C", "D", "E"):
        ws[f"{c}{coc}"]._style = copy(sc_style[c])
    ws[f"A{coc}"] = "Year 2 Cash-on-Cash"
    ws[f"B{coc}"] = "=IFERROR('Exit Scenarios'!$C$16,0)"
    ws[f"D{coc}"] = f"={COC_TARGET}"
    ws[f"E{coc}"] = "=IFERROR('Exit Scenarios'!$E$49,0)"

    ws[f"A{coc + 2}"] = ("Color legend:  Green = source number   |   Blue = editable input   "
                         "|   Yellow = calculated   |   Red = needs verification")
    ws.merge_cells(f"A{coc + 2}:F{coc + 2}")


# ── Checks ────────────────────────────────────────────────────────────────────

def upgrade_checks(wb):
    ws = wb["Checks"]
    for c in ("A", "B", "C", "D"):
        ws[f"{c}19"]._style = copy(ws[f"{c}18"]._style)

    ws["A2"] = '=COUNTIF(B6:B19,"OK")'
    ws["B2"] = '=COUNTIF(B6:B19,"NEEDS INPUT")'
    ws["C2"] = '=COUNTIF(B6:B19,"WARN")'
    ws["D2"] = '=COUNTIF(B6:B19,"PARTIAL")+COUNTIF(B6:B19,"REVIEW")'

    # Was "Tax reset modeled" = IF(Tax!B9>0,"OK","WARN") — it only asked whether a
    # millage existed, and read OK while silently applying Florida's reset-on-sale
    # to states that do not do that. It now scores the policy itself.
    ws["A12"] = "Tax reassessment policy set"
    ws["B12"] = ('=IF(Tax!$B$9<=0,"NEEDS INPUT",'
                 'IF(AND(Tax!$B$19>=0,Tax!$B$19<=1),"OK","WARN"))')
    ws["C12"] = "High"
    ws["D12"] = ("Year 1 tax = current taxable value plus Tax!B19 of the step-up to "
                 "purchase price, times millage. Set Tax!B19 to 100% where the state "
                 "reassesses on sale (e.g. Florida non-homestead) and 0% where it does "
                 "not (e.g. New Jersey - Van Decker bars sale-triggered spot "
                 "assessment). NEEDS INPUT means no millage is on file, so Year 1 falls "
                 "back to T12 tax grown forward.")

    ws["A18"] = "IRR includes sale proceeds"
    ws["B18"] = (f"=IF(INDEX('Debt & Exit'!$C$24:$J$24,{HOLD})>"
                 f"INDEX('Debt & Exit'!$C$22:$J$22,{HOLD}),\"OK\",\"WARN\")")
    ws["C18"] = "High"
    ws["D18"] = ("Checks the exit-year cash flow includes net sale proceeds. OK if sale "
                 "proceeds land in the Inputs hold-period year.")

    ws["A19"] = "Hold period inside the modeled range"
    ws["B19"] = f'=IF(AND({HOLD}>=1,{HOLD}<=8),"OK","WARN")'
    ws["C19"] = "High"
    ws["D19"] = ("The pro forma runs Years 1-8. A hold period outside that range leaves "
                 "the sale unmodeled.")


def main(path):
    path = Path(path)
    # *BACKUP*.xlsx is already gitignored — keeps the pre-upgrade copy local
    backup = path.with_name(path.stem + " BACKUP-pre-8yr.xlsx")
    if not backup.exists():
        shutil.copy2(path, backup)
    wb = load_workbook(path)
    upgrade_inputs(wb)
    upgrade_tax(wb)
    upgrade_pro_forma(wb)
    upgrade_debt_exit(wb)
    upgrade_exit_scenarios(wb)
    upgrade_solver(wb)
    upgrade_dashboard(wb)
    upgrade_checks(wb)
    wb.save(path)
    print(f"upgraded {path} (backup at {backup.name})")

    # The house-benchmark layer (2026-08-10) was applied to the template
    # AFTER this script last ran, so this script no longer knew about it: the
    # Pro Forma benchmark column wipe blanked M16/M17/M18/M23 and upgrade_checks
    # reset the tally to B6:B19, dropping the opex-ceiling check on row 20.
    # Running this file alone therefore silently undid the house numbers. Chain
    # the two so the template stays reproducible from source in one command.
    applyHouseBenchmarks.main(path)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TEMPLATE)
