"""
Put the regional manager's house expense benchmarks into the underwriting template.

Source: the house, 2026-08-10, answering the 2026-07-20 request for a house
number on each expense line. What he gave, verbatim:

    1. Repairs & maintenance          $750  per unit
    2. On-site payroll                $1,250 per unit
    3. Turnover / make-ready          $330  PER TURNED UNIT
    4. Contract services              (no number given)
    5. Admin & marketing              (no number given)
    6. Insurance                      $1,100
    7. Utilities                      (no number given)
    8. Other property expenses        (no number given)
    9. Replacement reserves           $250  per unit
    10. Total opex                    50%

Three of those don't fit the Pro Forma's benchmark column as written, which is
why this script exists rather than a one-line edit to the defaults:

  * TURNOVER is quoted per *turned* unit, not per unit in the property. The
    benchmark column multiplies by total units, so typing 330 there would charge
    every unit a turn and overstate the line by ~3x. The model already carries
    the share of units turning each year (Inputs B50, used for concessions), so
    turnover is entered as $/turned unit and the benchmark cell derives
    $/unit/yr from it: 330 x 33.3% = $110/unit/yr.

  * REPLACEMENT RESERVES have no Pro Forma line at all. Reserves are a capital
    item, not an operating expense — folding them into opex would cut NOI and,
    through the cap rate, the purchase price and every exit value in the model.
    They go BELOW NOI instead: a reserve line plus a cash-flow-after-reserves
    line and its own cash-on-cash, leaving NOI, the IRR and the exit maths
    untouched.

  * TOTAL OPEX 50% is a ceiling, not an input — nothing to type it into. It
    becomes a Checks row that scores Year 1 opex against it.

The four lines the regional manager left blank stay blank, which the model already reads as
"use the T12 figure".

DECLARATIVE AND IDEMPOTENT, same contract as upgradeUnderwritingTemplate.py:
every cell is written from scratch each run, so re-running is a no-op.

Usage:
    python scripts/applyHouseBenchmarks.py [template.xlsx]
"""
import shutil
import sys
from copy import copy
from pathlib import Path

from openpyxl import load_workbook

HERE = Path(__file__).parent
DEFAULT_TEMPLATE = HERE.parent / "underwriting" / "Underwriting Model TEMPLATE.xlsx"

PF = ["D", "E", "F", "G", "H", "I", "J", "K"]   # Pro Forma Year 1-8
PF_BENCH = "M"
EXPENSE_GROWTH = "Inputs!$B$22"
EQUITY = "'Debt & Exit'!$B$12"

# New Inputs rows. 52 is the section header; 50 is the existing turn-share row,
# relabelled below because it now drives turnover cost as well as concessions.
TURN_SHARE = "Inputs!$B$50"
IN_TURNOVER = 53      # $ per turned unit
IN_RESERVES = 54      # $ per unit per year
IN_OPEX_CAP = 55      # max total opex as a share of EGI

# Pro Forma rows added below the line.
PF_RESERVES = 37
PF_CF_AFTER = 38
PF_COC_AFTER = 39
PF_NOTE = 41

# House benchmarks that ARE a plain $/unit/yr number, by Pro Forma row.
HOUSE_BENCHMARKS = {
    16: 750,     # Repairs & Maintenance
    18: 1250,    # Labor Costs (Payroll)
    23: 1100,    # Insurance and Bonds
}


def style_from(ws, src, dst):
    ws[dst]._style = copy(ws[src]._style)


# ── Inputs ────────────────────────────────────────────────────────────────────

def upgrade_inputs(wb):
    ws = wb["Inputs"]

    # B50 is no longer only about concessions — the turnover benchmark reads the
    # same share. One number for one fact beats two that have to be kept equal.
    ws["A50"] = "Share of Units Turning / Year"
    ws["C50"] = ("Modeling assumption. Fraction of units that turn each year. Drives "
                 "BOTH the concession estimate above and the turnover benchmark below.")

    ws["A52"] = "ADDED - HOUSE EXPENSE BENCHMARKS (house numbers, 2026-08-10)"
    style_from(ws, "A39", "A52")

    for r in (IN_TURNOVER, IN_RESERVES, IN_OPEX_CAP):
        style_from(ws, "A45", f"A{r}")
        style_from(ws, "B45", f"B{r}")
        style_from(ws, "C45", f"C{r}")

    ws[f"A{IN_TURNOVER}"] = "Turnover / Make-Ready Benchmark ($ per TURNED unit)"
    ws[f"B{IN_TURNOVER}"] = 330
    ws[f"C{IN_TURNOVER}"] = ("House benchmark. Quoted per unit that TURNS, not per unit "
                             "in the property — the Pro Forma benchmark cell converts it "
                             "with the turn share above. 0 = use the T12 turnover figure.")

    ws[f"A{IN_RESERVES}"] = "Replacement Reserves ($/unit/yr)"
    ws[f"B{IN_RESERVES}"] = 250
    ws[f"C{IN_RESERVES}"] = ("House benchmark. Charged BELOW NOI on the Pro Forma, so it "
                             "does not change NOI, the purchase price, the exit values or "
                             "the IRR — only cash flow after reserves. Grows with expense "
                             "growth. 0 = no reserve line.")

    ws[f"A{IN_OPEX_CAP}"] = "Max Total Opex as % of EGI"
    ws[f"B{IN_OPEX_CAP}"] = 0.50
    ws[f"C{IN_OPEX_CAP}"] = ("House ceiling. Year 1 total operating expenses are scored "
                             "against this on the Checks tab. 0 = not scored.")
    ws[f"B{IN_OPEX_CAP}"].number_format = "0.0%"


# ── Pro Forma ─────────────────────────────────────────────────────────────────

def upgrade_pro_forma(wb):
    ws = wb["Pro Forma"]

    # Benchmark column: the house numbers ship in the template, so an analyst who
    # opens the raw file underwrites to them without having to remember them.
    for row, value in HOUSE_BENCHMARKS.items():
        ws[f"{PF_BENCH}{row}"] = value

    # Turnover: $/turned unit x share turning = the $/unit/yr the column expects.
    # Left as a formula rather than a baked 110 so the derivation is visible and
    # either factor can be flexed per deal.
    ws[f"{PF_BENCH}17"] = f"=Inputs!$B${IN_TURNOVER}*{TURN_SHARE}"

    ws["A4"] = ("Benchmark column sits at the right, just past Year 8: OUR number in "
                "$ per unit per YEAR. Blank = the model uses the T12-based figure. "
                "Enter a value and that line switches to benchmark x units from Year 1 "
                "on, then grows with expense growth. Turnover is the exception: it is "
                "entered on Inputs as $ per TURNED unit and converted here.")

    # ── below the line: replacement reserves ─────────────────────────────────
    for r in (PF_RESERVES, PF_CF_AFTER, PF_COC_AFTER):
        style_from(ws, "A35", f"A{r}")
        for c in PF:
            style_from(ws, f"{c}35", f"{c}{r}")
    for c in PF:
        style_from(ws, f"{c}36", f"{c}{PF_COC_AFTER}")

    ws[f"A{PF_RESERVES}"] = "Replacement Reserves (below the line)"
    ws[f"A{PF_CF_AFTER}"] = "Net Cash Flow After Reserves"
    ws[f"A{PF_COC_AFTER}"] = "Cash-on-Cash After Reserves %"

    ws[f"{PF[0]}{PF_RESERVES}"] = f"=Inputs!$B${IN_RESERVES}*Units"
    for i in range(1, len(PF)):
        ws[f"{PF[i]}{PF_RESERVES}"] = f"={PF[i - 1]}{PF_RESERVES}*(1+{EXPENSE_GROWTH})"
    for c in PF:
        ws[f"{c}{PF_CF_AFTER}"] = f"={c}35-{c}{PF_RESERVES}"
        ws[f"{c}{PF_COC_AFTER}"] = f"={c}{PF_CF_AFTER}/{EQUITY}"

    ws[f"A{PF_NOTE}"] = (
        "Reserves sit below NOI on purpose. NOI is what the purchase cap rate, the exit "
        "cap rate and every scenario value are applied to, so charging reserves into "
        "operating expenses would quietly change the price of the deal. The lines above "
        "show what the reserve costs in cash without touching that."
    )


# ── Checks ────────────────────────────────────────────────────────────────────

def upgrade_checks(wb):
    ws = wb["Checks"]
    row = 20
    for col in "ABCD":
        style_from(ws, f"{col}19", f"{col}{row}")

    ws[f"A{row}"] = "Year 1 total opex within house cap"
    ws[f"B{row}"] = (f'=IF(Inputs!$B${IN_OPEX_CAP}<=0,"NEEDS INPUT",'
                     f'IF(\'Pro Forma\'!$D$29<=\'Pro Forma\'!$D$15*Inputs!$B${IN_OPEX_CAP},'
                     f'"OK","WARN"))')
    ws[f"C{row}"] = "High"
    ws[f"D{row}"] = ("House ceiling from the 2026-08-10 benchmarks: total operating "
                     "expenses no more than 50% of effective gross income in Year 1. "
                     "WARN means the deal is underwritten above the house cap.")

    # the tally at the top has to cover the new row or it stops counting checks
    ws["A2"] = f'=COUNTIF(B6:B{row},"OK")'
    ws["B2"] = f'=COUNTIF(B6:B{row},"NEEDS INPUT")'
    ws["C2"] = f'=COUNTIF(B6:B{row},"WARN")'
    ws["D2"] = f'=COUNTIF(B6:B{row},"PARTIAL")+COUNTIF(B6:B{row},"REVIEW")'


def main(path):
    path = Path(path)
    backup = path.with_name(path.stem + " BACKUP-pre-benchmarks.xlsx")
    if not backup.exists():
        shutil.copy2(path, backup)
    wb = load_workbook(path)
    upgrade_inputs(wb)
    upgrade_pro_forma(wb)
    upgrade_checks(wb)
    wb.save(path)
    print(f"applied house benchmarks to {path} (backup at {backup.name})")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TEMPLATE)
