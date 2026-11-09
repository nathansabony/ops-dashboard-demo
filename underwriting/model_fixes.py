"""
Template fixes that apply to a model workbook, shared by the generator (every new model) and
repair_model.py (models already on the disk). Each is idempotent and returns a plain-language note.

Found by the 2026-10-22 audit of the live board:

  widen_solver      The Max Price Solver sheet tried 11 candidate cap rates, 5.50% to 8.00%, and interpolated.
                    A deal that already clears the IRR target at 5.50% (Willow Bay, IRR 21.2%) read "Below 5.50% -
                    expand range", and one that needs a cap above 8% (Southern Pines, Club at Sandy Shores,
                    Gardens of Pine Ranch, Maple Court) read "Above 8.00% - not achievable": five of twelve board
                    deals showed "no solve" because the grid was too narrow, not because there was no price.
                    The grid is now 19 caps, 3.00% to 12.00%, and the summary formulas span all of them.
  dashboard_irr_na  Dashboard A10 showed 0.0% when the model could not solve an IRR (the IRR row is
                    IFERROR(IRR(...),0)); the board card and the PDF said n/a. It now says n/a too.
  reassessment_policy  Summit Heights (Ohio): Year-1 property tax jumped from $1.84M to $4.53M because the July template
                    always reset the assessment to the purchase price and applied the millage to all of it, while the
                    model's own county note said "a sale itself does not automatically trigger reassessment" (Example
                    County reappraises on a cycle). That one line took $2.7M off Year-1 NOI and made the deal unsolvable.
                    The newer template has a "Reassessment on Sale" input (Tax!B19); the July one did not, and the Max
                    Price Solver ignored it in both. It now exists everywhere, the solver uses it, and a county rule that
                    says a sale does not trigger reassessment sets it to 0%.
"""
import json
import os
import re
from copy import copy

from openpyxl.comments import Comment
from openpyxl.formula.translate import Translator
from openpyxl.utils import get_column_letter

SOLVER_FIRST_CAP = 0.03
SOLVER_STEP = 0.005
SOLVER_COLS = 19            # B..T


def widen_solver(wb):
    if "Max Price Solver" not in wb.sheetnames:
        return None
    ws = wb["Max Price Solver"]
    last = get_column_letter(1 + SOLVER_COLS)          # T
    if ws[f"{last}7"].value is not None:
        return None                                    # already wide
    src_col = 12                                       # L: the last of the original eleven
    for c in range(src_col + 1, 1 + SOLVER_COLS + 1):
        col = get_column_letter(c)
        for r in range(6, 38):
            s = ws.cell(r, src_col)
            d = ws.cell(r, c)
            if isinstance(s.value, str) and s.value.startswith("="):
                d.value = Translator(s.value, origin=s.coordinate).translate_formula(d.coordinate)
            d._style = copy(s._style)
        ws.column_dimensions[col].width = ws.column_dimensions["L"].width or ws.column_dimensions["B"].width or 13
    for i in range(SOLVER_COLS):
        c = 2 + i
        cap = round(SOLVER_FIRST_CAP + SOLVER_STEP * i, 4)
        ws.cell(7, c).value = cap
        ws.cell(6, c).value = f"Cap {cap:.2%}"
    lo, hi = f"{SOLVER_FIRST_CAP:.2%}", f"{SOLVER_FIRST_CAP + SOLVER_STEP * (SOLVER_COLS - 1):.2%}"
    irr, coc, caps = f"B34:{last}34", f"B35:{last}35", f"B7:{last}7"
    interp = lambda rng: (f"INDEX({rng},B40)+(INDEX({rng},B40+1)-INDEX({rng},B40))*(Inputs!$B$47-INDEX({irr},B40))"
                          f"/(INDEX({irr},B40+1)-INDEX({irr},B40))")
    ws["B40"].value = f'=COUNTIF({irr},"<"&Inputs!$B$47)'
    ws["B41"].value = (f'=IF(B40=0,"Below {lo} - not achievable in range",IF(B40>={SOLVER_COLS},"Above {hi} - not achievable in range",'
                       f"{interp(caps)}))")
    ws["B45"].value = f'=IF(ISNUMBER(B41),IF(B40=0,INDEX({coc},1),{interp(coc)}),"-")'
    return f"Max Price Solver now tries {SOLVER_COLS} cap rates ({lo} to {hi}); it tried 11 (5.50% to 8.00%) and showed no price for deals outside that."


def dashboard_irr_na(wb):
    if "Dashboard" not in wb.sheetnames:
        return None
    ws = wb["Dashboard"]
    want = "=IF(AND('Debt & Exit'!$B$25=0,'Debt & Exit'!$B$26<>1),\"n/a\",'Debt & Exit'!$B$25)"
    cur = str(ws["A10"].value or "")
    if cur == "='Exit Scenarios'!$C$14":
        # the July-era template reads the Exit Scenarios tab and shows the text "NM" when no IRR solves; same word as everywhere else
        ws["A10"].value = "=IF(ISNUMBER('Exit Scenarios'!$C$14),'Exit Scenarios'!$C$14,\"n/a\")"
        return "Dashboard levered IRR shows n/a, not NM, when the model could not solve an IRR."
    if cur != "='Debt & Exit'!$B$25":
        return None
    ws["A10"].value = want
    return "Dashboard levered IRR shows n/a, not 0.0%, when the model could not solve an IRR."


POLICY_LABEL = "Reassessment on Sale (% of Price)"
NO_RESET_RE = re.compile(r"(sale|sold)[^.]{0,60}\b(does not|doesn't|do not|not)\b[^.]{0,30}(trigger|reassess)", re.I)


def reassessment_policy(wb):
    if "Tax" not in wb.sheetnames:
        return None
    t = wb["Tax"]
    notes = []
    if str(t["A19"].value or "") != POLICY_LABEL:
        if str(t["B14"].value or "") != "='Debt & Exit'!$B$6":
            return None                                   # not a layout this fix knows
        t["A19"] = POLICY_LABEL
        t["B19"] = 1.0
        t["B19"].number_format = "0%"
        t["C19"] = ("INPUT. 100% = assessment resets to the purchase price on sale. 0% = no reset; Year 1 tax holds at today's "
                    "taxable value and only grows by the tax-growth assumption. Drives this tab AND every column of the Max Price Solver.")
        t["B14"] = "=$B$8+('Debt & Exit'!$B$6-$B$8)*$B$19"
        notes.append("Tax tab gained the Reassessment on Sale input (the July template always reset the assessment to the purchase price).")
    # the county rule the tax lookup recorded on this very tab
    rule = " ".join(str(t.cell(r, 2).value or "") for r in range(20, 32) if isinstance(t.cell(r, 2).value, str) and len(t.cell(r, 2).value) > 60)
    cur = t["B19"].value
    taxable = t["B8"].value
    if isinstance(cur, (int, float)) and cur == 1 and isinstance(taxable, (int, float)) and taxable > 0 and NO_RESET_RE.search(rule):
        t["B19"] = 0.0
        notes.append("Reassessment on Sale set to 0%: the county rule on the Tax tab says a sale does not trigger reassessment, so Year-1 tax "
                     "holds at today's taxable value instead of resetting to the purchase price.")
    # the Max Price Solver applies the same policy at every candidate price
    if "Max Price Solver" in wb.sheetnames:
        s = wb["Max Price Solver"]
        fixed = 0
        for c in range(2, 2 + SOLVER_COLS):
            col = get_column_letter(c)
            v = s.cell(13, c).value
            want = (f"=IF(OR(Tax!$B$8<=0,Tax!$B$9<=0),Tax!$B$13,(Tax!$B$8+({col}8-Tax!$B$8)*Tax!$B$19)*Tax!$B$9/1000+Tax!$B$10)")
            if isinstance(v, str) and v.startswith("=") and "Tax!$B$19" not in v and "Tax!$B$9/1000" in v:
                s.cell(13, c).value = want
                fixed += 1
        if fixed:
            s["A13"].value = "Year 1 Property Tax (per reassessment policy)"
            notes.append("The Max Price Solver now applies the Reassessment on Sale policy at every candidate price.")
    return " ".join(notes) or None


# ── 2026-10-31 review of every live deal (the owner: "fix them") ─────────────────────────────────────────────────────
# Year-1 NOI started 10-48% under the T12 on 12 of 16 deals, and the price was never the broker's ask. Three of the
# causes are defaults, not deals:
#
#   tax_reset_by_state  The tax tab reset the assessment to 100% of the price everywhere. In these states a sale does
#                       not by itself reassess the property (NJ: West Milford v. Van Decker; NY, PA, DE, OH: base-year
#                       or cyclical reappraisal), so Year-1 tax holds at today's bill. PA school districts can appeal
#                       after a sale: the note on the Tax tab says so, and 100% stays one cell away.
#   misc_per_unit       The one-time Year-1 misc expense was a flat $100,000 whatever the size: about $2,000 a unit
#                       on Harbor (49 units) and Maple (56), $177 on Lakeview. Now $250 a unit (house estimate;
#                       the same $100,000 at 400 units).
#   price_from_ask      A portfolio model that carries every building's broker ask (Portfolio Breakdown) but priced
#                       the deal at T12 NOI / cap now prices it at the sum of the asks.
NO_RESET_STATES = {"PA": "Pennsylvania", "NJ": "New Jersey", "NY": "New York", "DE": "Delaware", "OH": "Ohio"}
STATE_RE = re.compile(r",\s*([A-Z]{2})\s+\d{5}|,\s*([A-Z]{2})\s*$")
OLD_FLAT_MISC = 100000
MISC_PER_UNIT = 250


def deal_state(text):
    text = str(text or "")
    for m in STATE_RE.finditer(text):
        return m.group(1) or m.group(2)
    for code, name in NO_RESET_STATES.items():
        if re.search(r"\b" + name + r"\b", text):
            return code
    return None


def tax_reset_by_state(wb):
    if "Tax" not in wb.sheetnames or "Inputs" not in wb.sheetnames:
        return None
    t = wb["Tax"]
    if str(t["A19"].value or "") != POLICY_LABEL or t["B19"].value != 1:
        return None                                       # no policy cell, or someone already set it
    state = deal_state(wb["Inputs"]["B10"].value) or deal_state(t["B7"].value)
    if state not in NO_RESET_STATES:
        return None
    taxable, bill = t["B8"].value, t["B13"].value
    has = lambda v: isinstance(v, (int, float)) and v > 0
    if not has(taxable) and not has(bill):
        return None                                       # nothing to hold Year-1 tax at: 0% would mean $0 of tax
    t["B19"] = 0.0
    note = (f"Reassessment on Sale set to 0% because the property is in {NO_RESET_STATES[state]}, where a sale does not by "
            f"itself reassess it: Year-1 tax holds at today's bill and grows by the tax-growth rate.")
    t["C19"] = (note + (" Pennsylvania school districts can appeal an assessment after a sale; set this to 100% to "
                        "model that." if state == "PA" else " Set to 100% to model a revaluation at the price.") + " (House, 2026-10-31)")
    if not has(taxable):
        # no assessed value from the OM or the county: back it out of the T12 tax bill so 0% holds the bill, not $0
        t["B8"] = "=IFERROR(MAX(0,B13-B10)*1000/B9,0)"
        t["C8"] = "house estimate: implied from the T12 tax bill / the millage (no assessed value was supplied)."
        note += " With no assessed value supplied, today's taxable value is implied from the T12 tax bill."
    return note


def misc_per_unit(wb):
    if "Inputs" not in wb.sheetnames:
        return None
    i = wb["Inputs"]
    units = i["B13"].value
    if i["B37"].value != OLD_FLAT_MISC or not (isinstance(units, (int, float)) and units > 0) or MISC_PER_UNIT * units == OLD_FLAT_MISC:
        return None
    i["B37"] = MISC_PER_UNIT * units
    i["C37"] = (f"One-time Year-1 expense: ${MISC_PER_UNIT}/unit x {int(units):,} units (house estimate, 2026-10-31; "
                f"was a flat ${OLD_FLAT_MISC:,} whatever the size). Does not recur or grow.")
    return f"Year-1 one-time misc expense is ${MISC_PER_UNIT}/unit (${MISC_PER_UNIT * units:,.0f}), not a flat ${OLD_FLAT_MISC:,}."


def price_from_ask(wb):
    if "Inputs" not in wb.sheetnames or "Portfolio Breakdown" not in wb.sheetnames:
        return None
    i = wb["Inputs"]
    if isinstance(i["B6"].value, (int, float)) and i["B6"].value > 0:
        return None
    ws = wb["Portfolio Breakdown"]
    row = next((r for r in range(1, ws.max_row + 1) if str(ws.cell(r, 1).value or "").strip() == "Asking price (broker)"), None)
    head = next((r for r in range(1, 12) if ws.cell(r, 1).value == "Metric"), None)
    if not row or not head:
        return None
    asks = []
    for c in range(2, ws.max_column + 1):
        h = ws.cell(head, c).value
        if not h or str(h).startswith("Portfolio Total"):
            break
        asks.append(ws.cell(row, c).value)
    if len(asks) < 2 or not all(isinstance(a, (int, float)) and a > 0 for a in asks):
        return None
    i["B6"] = sum(asks)
    i["C6"] = "The broker's ask: the sum of every building's asking price on the Portfolio Breakdown tab. 0 = T12 NOI / cap rate."
    return f"Priced at the broker's ask (${sum(asks):,.0f}, the sum of the buildings' asks), not T12 NOI / cap rate."


# Club at Silver Lakes (2026-08-11 run, found 2026-10-31): the stabilized occupancy target was typed as 71% while the
# rent roll was 97.3% occupied, so Year 1 charged 29% vacancy (-$1.67M, 42% of T12 NOI). The target is meant to be today's
# occupancy or better; one more than this far under today's is a typo, and the model goes back to the rent roll's.
OCC_TARGET_SLACK = 0.05


def occupancy_target(wb):
    if "Inputs" not in wb.sheetnames or "Rent Roll" not in wb.sheetnames:
        return None
    tgt, occ = wb["Inputs"]["B26"].value, wb["Rent Roll"]["B10"].value
    isnum = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    if not (isnum(tgt) and isnum(occ)) or tgt >= occ - OCC_TARGET_SLACK:
        return None
    wb["Inputs"]["B26"] = "='Rent Roll'!$B$10"
    wb["Inputs"]["C26"] = (f"Was typed as {tgt:.1%}, {occ - tgt:.1%} under the rent roll's {occ:.1%} occupancy; reset to the rent "
                           f"roll (House, 2026-10-31). Type a higher target to model lease-up.")
    return (f"Stabilized occupancy target was {tgt:.1%}, under the rent roll's {occ:.1%}: Year 1 charged vacancy the property "
            f"does not have. It now uses the rent roll's occupancy.")


# ── 2026-10-31 hand review of every live deal (reviewers found the first one independently four times) ─────────────
#   year1_rent_vacants  Pro Forma Year-1 Base GPR was in-place rent (vacant units at $0) plus HALF of market less
#                       in-place, so a vacant unit counted at half its market rent, and the vacancy % was then charged
#                       on top: vacancy taken about 1.5 times. Year 1 now starts from vacants at market (Rent Roll B19)
#                       plus the loss-to-lease capture on the OCCUPIED units only. Worth 1-9% of T12 NOI (Elmhurst,
#                       Ridgeview, Stonebridge ~8-9%). Years 2+ were already on full market rent.
#   vacant_market_rent  A rent roll read with $0 market rent on vacant units (Eastern Pines: all 32) priced them at
#                       nothing. They take the average market rent of their unit type.
#   misc_once           The older 5-year template charged the misc line every year ("annual cushion"); the house rule
#                       since is one-time in Year 1, so Years 2+ are 0.
#   unallocated_overlap A T12 that gives one controllable total puts all of it on "Other Controllable (unallocated)";
#                       the payroll / repairs / turnover benchmarks were then charged on top of the same money (Harbor:
#                       payroll and R&M twice). Year 1's unallocated line now gives up what the benchmarks charge for
#                       lines the T12 had at $0, so controllable cost is the larger of the T12 and the benchmarks.
#   tax_rate_missing    A state that reassesses on sale with no county rate found kept today's bill, so the reset
#                       never happened (Villa Serena, Emerald Waters, Eastern Pines). An effective rate on the price
#                       stands in, labelled an house estimate, until the county rate is entered.
#   deal_overrides      Corrections found reading a specific deal's documents, kept in config/underwriting-overrides.json
#                       with the reason for each, so a rerun on the site applies them and the model says why.
OLD_Y1_RENT = "('Rent Roll'!$B$16*12)+('Rent Roll'!$B$15*12-'Rent Roll'!$B$16*12)"
NEW_Y1_RENT = "('Rent Roll'!$B$19*12)+(('Rent Roll'!$B$15-'Rent Roll'!$B$19)*12)"
# effective tax per $1,000 of price for apartments after a sale (house estimates, 2026-10-31, from the deals on the
# board that carry a county rate: FL ~85% of price x ~20 mills, TX ~21-22, GA 40% assessment x ~40 mills, SC ~18)
STATE_EFFECTIVE_MILLS = {"FL": 17.0, "TX": 21.5, "GA": 16.0, "SC": 18.0}
BENCHMARKED_LINES = ("Repairs & Maintenance", "Turnover", "Labor Costs")


def _pf_row(ws, prefix):
    return next((r for r in range(5, 45) if str(ws.cell(r, 1).value or "").strip().startswith(prefix)), None)


def _year_cols(ws):
    hdr = next((r for r in range(3, 8) if ws.cell(r, 1).value == "Line Item"), 5)
    return [c for c in range(2, ws.max_column + 1) if re.match(r"^Year \d+$", str(ws.cell(hdr, c).value or "").strip())]


def _unit_rows(rr):
    hdr = next((r for r in range(10, 40) if str(rr.cell(r, 1).value or "").strip().lower() == "unit"), None)
    return [r for r in range(hdr + 1, rr.max_row + 1) if rr.cell(r, 1).value not in (None, "")] if hdr else []


def year1_rent_vacants(wb):
    if "Pro Forma" not in wb.sheetnames:
        return None
    ws = wb["Pro Forma"]
    r, cols = _pf_row(ws, "Base Gross Potential Rent"), _year_cols(ws)
    if not r or not cols:
        return None
    cell = ws.cell(r, cols[0])
    if not (isinstance(cell.value, str) and OLD_Y1_RENT in cell.value):
        return None
    cell.value = cell.value.replace(OLD_Y1_RENT, NEW_Y1_RENT)
    return ("Year-1 rent starts from vacant units at market rent plus the loss-to-lease capture on occupied units; "
            "it had counted vacant units at half their market rent and then charged vacancy on top.")


def vacant_market_rent(wb):
    if "Rent Roll" not in wb.sheetnames:
        return None
    rr = wb["Rent Roll"]
    rows = _unit_rows(rr)
    isnum = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    by_type = {}
    for r in rows:
        f = rr.cell(r, 6).value
        if isnum(f) and f > 0:
            by_type.setdefault(rr.cell(r, 2).value, []).append(f)
    every = [x for xs in by_type.values() for x in xs]
    filled = 0
    for r in rows:
        if rr.cell(r, 6).value in (None, 0) and not rr.cell(r, 13).value:
            pool = by_type.get(rr.cell(r, 2).value) or every
            if pool:
                rr.cell(r, 6).value = round(sum(pool) / len(pool), 2)
                filled += 1
    if not filled:
        return None
    return f"{filled} vacant unit(s) had no market rent in the rent roll read; each now carries its unit type's average market rent."


def misc_once(wb):
    if "Pro Forma" not in wb.sheetnames:
        return None
    ws = wb["Pro Forma"]
    r, cols = _pf_row(ws, "Miscellaneous"), _year_cols(ws)
    if not r or len(cols) < 2:
        return None
    changed = 0
    for c in cols[1:]:
        v = ws.cell(r, c).value
        if isinstance(v, str) and v.startswith("=") and v != "=0":
            ws.cell(r, c).value = "=0"
            changed += 1
    if not changed:
        return None
    note = ws.cell(r, cols[-1] + 1)
    if isinstance(note.value, str) and "cushion" in note.value:
        note.value = "One-time, Year 1 only (the house rule); the older template repeated it every year."
    return "The one-time misc expense is charged in Year 1 only; this older model repeated it every year."


def reno_pace_years(wb):
    """Reno Pace tracks months 1-24 only; Year 3 then booked the full stabilized premium for every unit,
    grown a year. Metro Central (547 units at 15 a month from month 3) has only ~330 done by month 24,
    so Year 3 carried ~$650K of premium on units still being renovated and none of their downtime. Years 3-8
    now count the units online each month at the same pace, and charge downtime for the units finished that
    year. A program done by month 24 gives exactly the old figures."""
    if "Pro Forma" not in wb.sheetnames:
        return None
    ws = wb["Pro Forma"]
    r, cols = _pf_row(ws, "Value-Add Rent Impact"), _year_cols(ws)
    if not r or len(cols) < 3:
        return None
    y3 = str(ws.cell(r, cols[2]).value or "")
    if "'Reno Pace'!$B$37" not in y3 or "Reno Pace" not in wb.sheetnames:
        return None
    # the inputs move between template versions (the oldest keeps the pace in B46 and B45 is the
    # loss-to-lease share), so read them from the model's own month-1 schedule row
    rp = wb["Reno Pace"]
    sched = re.search(r"A6<(Inputs!\$B\$\d+),0,MAX\(0,MIN\((Inputs!\$B\$\d+),(Inputs!\$B\$\d+)-SUM", str(rp["B6"].value or ""))
    prem = re.fullmatch(r"=D6\*(Inputs!\$B\$\d+)", str(rp["E6"].value or ""))
    down = re.fullmatch(r"=IFERROR\(B6\*(.+),0\)", str(rp["F6"].value or ""))
    grow = re.search(r"\(1\+(Inputs!\$B\$\d+)\)", y3)
    if not (sched and prem and down and grow):
        return None
    start, pace, units = sched.groups()
    online = lambda m: f"MIN({units},MAX(0,({m}-{start}+1)*{pace}))"
    for n, c in enumerate(cols[2:], start=3):
        months = "+".join(online(m) for m in range(12 * (n - 1) + 1, 12 * n + 1))
        downtime = f"IFERROR(({online(12 * n)}-{online(12 * (n - 1))})*{down.group(1)},0)"
        ws.cell(r, c).value = f"={prem.group(1)}*({months})*(1+{grow.group(1)})^{n - 2}-{downtime}"
    return "Years 3-8 of the renovation premium follow the renovation pace; Year 3 had booked every unit as done."


def unallocated_overlap(wb):
    if "Pro Forma" not in wb.sheetnames:
        return None
    ws = wb["Pro Forma"]
    ru, cols = _pf_row(ws, "Other Controllable (unallocated)"), _year_cols(ws)
    if not ru or not cols:
        return None
    y1 = ws.cell(ru, cols[0])
    if not isinstance(y1.value, str) or not y1.value.startswith("=") or "MAX(0," in y1.value:
        return None
    L = get_column_letter(cols[0])
    # a benchmark line whose T12 was $0 is money the T12 kept inside the unallocated total; the formula decides from the
    # model's own numbers, so a T12 that does break the lines out (most) is unchanged
    terms = [f"IF(N($B${r})=0,{L}{r},0)" for r in (_pf_row(ws, x) for x in BENCHMARKED_LINES) if r]
    if not terms:
        return None
    y1.value = f"=MAX(0,{y1.value.lstrip('=')}-({'+'.join(terms)}))"
    return ("Year 1's unallocated controllable cost gives up what the payroll / repairs / turnover benchmarks charge for lines "
            "the T12 kept inside one controllable total, so the same cost is not counted twice.")


def tax_rate_missing(wb):
    if "Tax" not in wb.sheetnames or "Inputs" not in wb.sheetnames:
        return None
    t = wb["Tax"]
    if str(t["A19"].value or "") != POLICY_LABEL or t["B19"].value != 1:
        return None
    if isinstance(t["B9"].value, (int, float)) and t["B9"].value > 0:
        return None
    state = deal_state(wb["Inputs"]["B10"].value) or deal_state(t["B7"].value)
    mills = STATE_EFFECTIVE_MILLS.get(state)
    if not mills:
        return None
    t["B8"] = 0
    t["B9"] = mills
    t["C9"] = (f"house estimate: no county rate was found, so {mills} per $1,000 of the price stands in for a typical "
               f"{state} apartment tax bill after a sale (2026-10-31). Enter the county rate and taxable value to replace it.")
    return (f"No county tax rate was on file, so Year 1 kept today's tax bill and never applied {state}'s reset on sale; "
            f"it now uses an estimated {mills} per $1,000 of the price (house estimate).")


def tax_full_reset(wb):
    """A full reset to the price needs no taxable value, but the Year-1 tax (Tax!B16) and every Max Price Solver column fell
    back to today's bill whenever the taxable value was blank (B15, B16) (Villa Serena, Eastern Pines, Pinecrest), so the reset never ran."""
    if "Tax" not in wb.sheetnames:
        return None
    t, n = wb["Tax"], 0
    old, new = "OR($B$8<=0,$B$9<=0)", "OR($B$9<=0,AND($B$8<=0,$B$19<1))"
    for ref in ("B15", "B16"):                     # the tax after the sale, and the Year-1 total built on it
        if isinstance(t[ref].value, str) and old in t[ref].value:
            t[ref].value = t[ref].value.replace(old, new)
            n += 1
    if "Max Price Solver" in wb.sheetnames:
        s = wb["Max Price Solver"]
        for c in range(2, 2 + SOLVER_COLS):
            v = s.cell(13, c).value
            if isinstance(v, str) and "OR(Tax!$B$8<=0,Tax!$B$9<=0)" in v:
                s.cell(13, c).value = v.replace("OR(Tax!$B$8<=0,Tax!$B$9<=0)", "OR(Tax!$B$9<=0,AND(Tax!$B$8<=0,Tax!$B$19<1))")
                n += 1
    return "Year-1 tax resets to the price when the state resets on sale, even with no taxable value on file." if n else None


def benchmark_floor_actual(wb):
    """the owner, 2026-10-31: a house cost standard is a floor, not a replacement. Where a property already spends more than
    the standard (Villa Serena insurance $2,497/unit vs $1,100; Ridgeview repairs and payroll; Park and Meadow payroll),
    Year 1 keeps its own T12 cost grown one year; where it spends less, the standard still applies."""
    if "Pro Forma" not in wb.sheetnames:
        return None
    ws = wb["Pro Forma"]
    cols = _year_cols(ws)
    if not cols:
        return None
    # Repairs and turnover are one pair: sellers file the same make-ready spend under either (Lakeview: $144K repairs +
    # $224K turnover; Ridgeview: $951K repairs + $0 turnover), so a floor per line would count it twice. The pair costs the
    # higher of the two standards together or the two T12 lines together; turnover keeps its standard and repairs carries
    # any excess. Payroll and insurance are floored line by line.
    L = get_column_letter(cols[0])
    rm, turn = _pf_row(ws, "Repairs & Maintenance"), _pf_row(ws, "Turnover")
    n = 0
    for r in range(6, 45):
        if r == turn:
            continue
        v = ws.cell(r, cols[0]).value
        m = re.fullmatch(r"=IF\(\$(?P<b>[A-Z]+)(?P<r>\d+)>0,\$(?P=b)(?P=r)\*Units,(?P<t>B(?P=r)\*\(1\+Inputs!\$B\$22\))\)", str(v or ""))
        if not (m and int(m["r"]) == r):
            continue
        actual = m["t"]
        if r == rm and turn:
            actual = f"(B{r}+B{turn})*(1+Inputs!$B$22)-{L}{turn}"
        ws.cell(r, cols[0]).value = f"=IF(${m['b']}{r}>0,MAX(${m['b']}{r}*Units,{actual}),{m['t']})"
        n += 1
    return ("House cost standards are a floor: on any expense line that carries a standard, Year 1 uses the higher of the "
            "standard and the property's own T12 cost.") if n else None


OVERRIDES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "underwriting-overrides.json")


def _key(name):
    return re.sub(r"[^a-z0-9]+", "", re.sub(r"\([^)]*\)", " ", str(name or "").lower()))


def deal_overrides(wb, path=None):
    try:
        with open(path or OVERRIDES_FILE, encoding="utf-8") as f:
            table = json.load(f)
    except Exception:
        return None
    if "Inputs" not in wb.sheetnames:
        return None
    entry = table.get(_key(wb["Inputs"]["B9"].value))
    if not entry:
        return None
    notes = []
    for ch in entry.get("cells", []):
        sheet, ref = ch["cell"].split("!")
        if sheet not in wb.sheetnames or wb[sheet][ref].value == ch["value"]:
            continue
        c = wb[sheet][ref]
        c.value = ch["value"]
        if sheet == "Inputs":
            wb[sheet].cell(c.row, c.column + 1).value = ch["why"] + " (hand review, 2026-10-31)"
        else:
            # other sheets have no note column beside the value; the reason rides on the cell as a comment
            c.comment = Comment(ch["why"] + " (hand review)", "House")
        notes.append(ch["why"])
    # loss-to-lease captured year by year (Year 1 first; years past the list capture all of it), for a deal
    # where the gap cannot close in one year: rent control, or a soft market
    capture = entry.get("ltl_capture")
    if capture and "Pro Forma" in wb.sheetnames and "Inputs" in wb.sheetnames:
        ws = wb["Pro Forma"]
        r, cols = _pf_row(ws, "Base Gross Potential Rent"), _year_cols(ws)
        if r and len(cols) > 1 and str(wb["Inputs"]["A44"].value or "").startswith("Loss-to-Lease"):
            wb["Inputs"]["B44"].value = capture[0]
            for n, c in enumerate(cols[1:], start=2):
                share = capture[n - 1] if n - 1 < len(capture) else 1
                ws.cell(r, c).value = (f"=('Rent Roll'!$B$19*12+('Rent Roll'!$B$15-'Rent Roll'!$B$19)*12*{share})"
                                       f"*(1+Inputs!$B$21)^{n - 1}")
            notes.append(entry.get("ltl_capture_why") or "Loss-to-lease captured over several years.")
    if entry.get("market_rent_is_in_place") and "Rent Roll" in wb.sheetnames:
        rr = wb["Rent Roll"]
        moved = 0
        for r in _unit_rows(rr):
            f, g = rr.cell(r, 6).value, rr.cell(r, 7).value
            if rr.cell(r, 13).value and isinstance(g, (int, float)) and g > 0 and f != g:
                rr.cell(r, 6).value = g
                moved += 1
        if moved:
            notes.append(entry.get("market_rent_why") or f"Market rent set to in-place rent on {moved} occupied units.")
    # a unit's in-place rent the rent-roll read got wrong, keyed by unit number (rows differ between runs)
    rents = entry.get("unit_rents") or {}
    if rents and "Rent Roll" in wb.sheetnames:
        rr = wb["Rent Roll"]
        fixed = 0
        for r in _unit_rows(rr):
            want = rents.get(str(rr.cell(r, 1).value).strip())
            if want is not None and rr.cell(r, 7).value != want:
                rr.cell(r, 7).value = want
                rr.cell(r, 13).value = 1 if want > 0 else 0
                fixed += 1
        if fixed:
            notes.append(entry.get("unit_rents_why") or f"In-place rent corrected on {fixed} units.")
    return " ".join(notes) or None


def rent_roll_loss_to_lease(wb):
    """Models generated before 2026-10-29 carry the template's own per-unit Loss to Lease numbers in Rent
    Roll column N (unit 01-02325 showed 117 against $2,934 market and $3,000 rent). Nothing reads them,
    but they print. Each unit's own market less rent goes there, as generator.write_rent_roll now writes."""
    if "Rent Roll" not in wb.sheetnames:
        return None
    rr = wb["Rent Roll"]
    rows = _unit_rows(rr)
    if not rows or str(rr.cell(rows[0] - 1, 14).value or "").strip().lower() != "loss to lease":
        return None
    n = 0
    for r in rows:
        f = f"=IF(M{r}=1,F{r}-G{r},0)"
        if rr.cell(r, 14).value != f:
            rr.cell(r, 14).value = f
            n += 1
        rr.cell(r, 15).value = "Occupied" if rr.cell(r, 13).value == 1 else "Vacant"
    return f"Rent Roll loss-to-lease column rebuilt from each unit's market less rent ({n} rows)." if n else None


# Found by the two independent checks of Meadow Green (2026-11-01): nothing here moves the
# answer by more than a few thousand dollars of NOI, but each one prints something a reader would
# take as wrong.

def turnover_share_exact(wb):
    """Inputs B50 held 0.3333, not a third: concessions came out $16 a year low on a 400-unit deal."""
    if "Inputs" not in wb.sheetnames:
        return None
    i = wb["Inputs"]
    if not str(i["A50"].value or "").startswith("Share of Units Turning") or i["B50"].value != 0.3333:
        return None
    i["B50"].value = "=1/3"
    return "A third of units turning a year is exactly 1/3, not 0.3333."


DOWNTIME_RENT_OLD = "'Rent Roll'!$B$16/Inputs!$B$13"
DOWNTIME_RENT_NEW = "'Rent Roll'!$B$19/Inputs!$B$13"


def downtime_rent_basis(wb):
    """A unit offline for renovation loses about the average rent, but in-place rent / all units counts
    the vacant units at $0 (Meadow Green: $2,358 a month against $2,466 with vacants at market), so
    downtime was understated by ~$14K in Year 1. Downtime and the Dashboard's post-renovation rent now use
    the same average as the Dashboard's current rent: in-place with vacant units at market."""
    n = 0
    for name in ("Reno Pace", "Dashboard"):
        if name not in wb.sheetnames:
            continue
        for row in wb[name].iter_rows():
            for c in row:
                if isinstance(c.value, str) and c.value.startswith("=") and DOWNTIME_RENT_OLD in c.value:
                    c.value = c.value.replace(DOWNTIME_RENT_OLD, DOWNTIME_RENT_NEW)
                    n += 1
    if "Dashboard" in wb.sheetnames:
        d = wb["Dashboard"]
        b31 = str(d["B31"].value or "")
        if b31.startswith("=") and "'Rent Roll'!$B$16+" in b31:
            d["B31"].value = b31.replace("'Rent Roll'!$B$16+", "'Rent Roll'!$B$19+")
            d["C31"].value = "Current average rent (vacant units at market) + value-add units x monthly premium, / total units."
            n += 1
    return "Renovation downtime and the post-renovation average rent use the average rent with vacant units at market, not at $0." if n else None


def unit_mix_live(wb):
    """The Unit Mix tab was typed in from the rent-roll read, so a rent corrected afterwards (Meadow
    Green's voucher rent) never reached it, and Rent Comps showed the subject's achieved rent $60 low.
    Each floor plan's counts and rents are now formulas over the Rent Roll tab."""
    if "Unit Mix" not in wb.sheetnames or "Rent Roll" not in wb.sheetnames:
        return None
    um, rr = wb["Unit Mix"], wb["Rent Roll"]
    rows = _unit_rows(rr)
    if not rows or [str(um.cell(5, c).value or "") for c in (1, 2, 3, 9)] != ["Unit Type", "Units", "Occupied", "Monthly In-place Rent"]:
        return None
    num = lambda x: x if isinstance(x, (int, float)) else 0
    plans = {}
    for r in rows:
        p = plans.setdefault(str(rr.cell(r, 2).value or "").strip(), {"n": 0, "occ": 0, "sf": 0, "mkt": 0, "rent": 0})
        p["n"] += 1
        p["occ"] += 1 if rr.cell(r, 13).value == 1 else 0
        p["sf"] += num(rr.cell(r, 3).value)
        p["mkt"] += num(rr.cell(r, 6).value)
        p["rent"] += num(rr.cell(r, 7).value)
    mix = [r for r in range(6, um.max_row + 1) if um.cell(r, 1).value not in (None, "")]
    # only where every floor plan on the tab is one the rent roll uses, so nothing quietly reads 0
    if not mix or any(str(um.cell(r, 1).value).strip() not in plans for r in mix):
        return None
    # values, not SUMIF formulas: on the 1,000-unit deals the live server's formula engine ran out of
    # memory expanding a 2,000-row lookup per floor plan (Metro Central, Pinecrest, 2026-11-01)
    n = 0
    for r in mix:
        p = plans[str(um.cell(r, 1).value).strip()]
        want = {2: p["n"], 3: p["occ"], 4: p["n"] - p["occ"], 5: round(p["sf"] / p["n"], 2),
                6: round(p["mkt"] / p["n"], 2), 7: round(p["rent"] / p["occ"], 2) if p["occ"] else 0,
                8: round(p["mkt"], 2), 9: round(p["rent"], 2)}
        for c, v in want.items():
            if um.cell(r, c).value != v:
                um.cell(r, c).value = v
                n += 1
        um.cell(r, 10).value = "Grouped from the Rent Roll tab by floor plan."
    return "The Unit Mix tab is regrouped from the Rent Roll tab, so a corrected rent reaches it and the rent comps." if n else None


def noi_convention(wb):
    """NOI the way lenders, appraisers and buyers state it (the owner, 2026-11-01): replacement reserves are an
    operating expense, so they sit above NOI and every value built on NOI (exit price, refi loans, DSCR, the
    max-price solver) carries them; our 2% asset-management fee is the sponsor's fee to its investors, so it
    sits below NOI, still paid out of every year's cash flow but no longer capitalised into the sale price
    (about $4.5M off Meadow Green's exit). The fee's line among the expenses becomes the reserves line;
    the fee is charged in each cash-flow row instead. Works on all three template layouts."""
    need = ("Pro Forma", "Inputs", "Debt & Exit")
    if any(s not in wb.sheetnames for s in need):
        return None
    pf, inp = wb["Pro Forma"], wb["Inputs"]
    cols = _year_cols(pf)
    r_egi, r_tot, r_noi = _pf_row(pf, "Effective Gross Income"), _pf_row(pf, "Total Operating Expenses"), _pf_row(pf, "Net Operating Income")
    r_am = next((r for r in range(r_egi or 0, r_tot or 0) if str(pf.cell(r, 1).value or "").strip() == "Asset Management Fee"), None)
    r_cf = _pf_row(pf, "Net Income After Debt Service")
    if not (cols and r_egi and r_tot and r_noi and r_am and r_cf):
        return None
    am = re.search(r"\*(Inputs!\$B\$\d+)\)?$", str(pf.cell(r_am, cols[0]).value or ""))
    grow = re.search(r"\(1\+(Inputs!\$B\$\d+)\)", str(pf.cell(_pf_row(pf, "Utility Costs") or r_tot, cols[0]).value or ""))
    if not am or not grow:
        return None
    am, grow = am.group(1), grow.group(1)
    res_row = next((r for r in range(1, 80) if str(inp.cell(r, 1).value or "").startswith("Replacement Reserves")), None)
    res = f"Inputs!$B${res_row}" if res_row else "250"
    if res_row:
        inp.cell(res_row, 3).value = ("An operating expense above NOI (Pro Forma 'Replacement Reserves'), as lenders, appraisers and buyers count "
                                      "it: it lowers NOI, DSCR, exit and refi values and the IRR. The price, set from T12 NOI, does not change.")
    L = get_column_letter
    fee = lambda c: f"'Pro Forma'!${L(c)}${r_egi}*{am}"
    # Pro Forma: the fee's expense line becomes reserves (benchmark cell cleared: reserves have their own input)
    pf.cell(r_am, 1).value = "Replacement Reserves"
    pf.cell(r_am, 2).value = 0
    for c in range(cols[0] - 1, 1, -1):
        if pf.cell(5, c).value and "Benchmark" in str(pf.cell(5, c).value):
            pf.cell(r_am, c).value = None
    bm = next((c for c in range(cols[-1] + 1, pf.max_column + 1) if "Benchmark" in str(pf.cell(5, c).value or "")), None)
    if bm:
        pf.cell(r_am, bm).value = None
    for i, c in enumerate(cols):
        pf.cell(r_am, c).value = f"={res}*Inputs!$B$13" if i == 0 else f"={L(cols[i - 1])}{r_am}*(1+{grow})"
        dsr = re.search(r"-([A-Z]+\d+)$", str(pf.cell(r_cf, c).value or ""))
        if dsr:
            pf.cell(r_cf, c).value = f"={L(c)}{r_noi}-{dsr.group(1)}-{L(c)}{r_egi}*{am}"
    pf.cell(r_cf, 1).value = "Cash Flow After Debt Service and Asset Management Fee"
    # the newer layout's below-the-line reserve block now shows the fee instead
    r_rb = _pf_row(pf, "Replacement Reserves (below")
    if r_rb:
        pf.cell(r_rb, 1).value = "Asset Management Fee (in the line above: paid from cash flow, not in NOI)"
        for c in cols:
            pf.cell(r_rb, c).value = f"={L(c)}{r_egi}*{am}"
        for lab in ("Net Cash Flow After Reserves", "Cash-on-Cash After Reserves"):
            rr_ = _pf_row(pf, lab)
            if rr_:
                for c in range(1, pf.max_column + 1):
                    pf.cell(rr_, c).value = None
        note = next((r for r in range(r_rb, r_rb + 8) if str(pf.cell(r, 1).value or "").startswith("Reserves sit below NOI")), None)
        if note:
            pf.cell(note, 1).value = ("Replacement reserves are an operating expense, above NOI, as lenders, appraisers and buyers count them, so the "
                                      "exit price and DSCR carry them. The 2% asset-management fee is our fee to our investors: it is paid from "
                                      "each year's cash flow but kept out of NOI, so it does not lower the sale price.")
    n = 1
    # Debt & Exit: the hold-period cash flows
    de = wb["Debt & Exit"]
    r_den = next((r for r in range(15, 30) if str(de.cell(r, 1).value or "").strip() == "NOI"), None)
    r_dec = next((r for r in range(15, 30) if str(de.cell(r, 1).value or "").startswith("Cash Flow After Debt")), None)
    if r_den and r_dec:
        for c in range(3, 12):
            m = re.match(r"^='Pro Forma'!\$([A-Z]+)\$\d+$", str(de.cell(r_den, c).value or ""))
            v = str(de.cell(r_dec, c).value or "")
            core = f"{L(c)}{r_den}-{L(c)}{r_den + 1}"
            if m and core in v:
                de.cell(r_dec, c).value = v.replace(core, f"{core}-{fee(openpyxl_col(m.group(1)))}", 1)
                n += 1
        de.cell(r_dec, 1).value = "Cash Flow After Debt and Asset Mgmt Fee"
    # Exit Scenarios: operating cash flow on each debt case
    if "Exit Scenarios" in wb.sheetnames:
        es = wb["Exit Scenarios"]
        # the older 5-year layout carries Years 6-8 on 'Stabilized NOI YrN' cells grown from Year 5
        stab = {r: int(m_.group(1)) for r in range(1, 60)
                if (m_ := re.match(r"^Stabilized NOI Yr(\d+)$", str(es.cell(r, 1).value or "").strip()))}
        base = next((re.match(r"^='Pro Forma'!\$([A-Z]+)\$\d+\*\(1\+(Inputs!\$B\$\d+)\)", str(es.cell(r, 2).value or ""))
                     for r in sorted(stab)), None)
        for row in es.iter_rows():
            for cell in row:
                v = str(cell.value or "")
                m = re.match(rf"^(='Pro Forma'!\$([A-Z]+)\${r_noi}-\$B\$\d+)((?:\+\$[A-Z]+\$\d+)?)$", v)
                if m:
                    cell.value = f"{m.group(1)}-{fee(openpyxl_col(m.group(2)))}{m.group(3)}"
                    n += 1
                    continue
                m = re.match(r"^(=\$B\$(\d+)-\$B\$\d+)((?:\+\$[A-Z]+\$\d+)?)$", v)
                if m and int(m.group(2)) in stab and base:
                    src = openpyxl_col(base.group(1))
                    yrs = stab[int(m.group(2))] - (cols.index(src) + 1)
                    cell.value = f"{m.group(1)}-{fee(src)}*(1+{base.group(2)})^{yrs}{m.group(3)}"
                    n += 1
    # Max Price Solver: each candidate price's equity cash flows (the NOI rows there are price-adjusted NOI)
    if "Max Price Solver" in wb.sheetnames:
        ms = wb["Max Price Solver"]
        for r in range(20, 40):
            if not re.match(r"^Equity Cash Flow - Year [1-9]", str(ms.cell(r, 1).value or "")):
                continue
            for c in range(2, ms.max_column + 1):
                v = str(ms.cell(r, c).value or "")
                m = re.search(rf"\b{L(c)}(\d+)-{L(c)}\$?(\d+)\b", v)
                if not m:
                    continue
                src = re.match(r"^='Pro Forma'!\$([A-Z]+)\$", str(ms.cell(int(m.group(1)), c).value or ""))
                if src:
                    ms.cell(r, c).value = v.replace(m.group(0), f"{m.group(0)}-{fee(openpyxl_col(src.group(1)))}", 1)
                    n += 1
    return (f"NOI is stated as lenders and buyers state it: replacement reserves above NOI, the 2% asset-management fee "
            f"below it (still paid from cash flow every year, no longer cut from the sale price); {n} formulas changed.")


def openpyxl_col(letters):
    from openpyxl.utils import column_index_from_string
    return column_index_from_string(letters)


def presentation_text(wb):
    """Labels and notes that said something untrue about the model."""
    n = 0

    def put(sheet, ref, old, new):
        nonlocal n
        if sheet in wb.sheetnames and isinstance(wb[sheet][ref].value, str) and old in wb[sheet][ref].value:
            wb[sheet][ref].value = wb[sheet][ref].value.replace(old, new)
            n += 1

    put("Debt & Exit", "C6", "on Inputs (B30)", "on Inputs (B6)")
    if "AVERAGE(" in str(wb["Sale Comps"]["B2"].value if "Sale Comps" in wb.sheetnames else ""):
        put("Sale Comps", "B3", "MEDIAN", "AVERAGE")
    unpriced = "Inputs" in wb.sheetnames and not (isinstance(wb["Inputs"]["B6"].value, (int, float)) and wb["Inputs"]["B6"].value > 0)
    if unpriced:   # with no ask on file the 'ask' tiles show the model's own cap-rate price
        put("Sale Comps", "A3", "(ASK)", "(MODEL PRICE)")
        put("Max Price Solver", "C3", "vs ASK", "vs MODEL PRICE")
        put("Max Price Solver", "D3", "CURRENT ASK", "MODEL PRICE")
    for ref in ("E18", "F18", "G18"):
        put("Exit Scenarios", ref, "Cash-out refinance", "Refinance")
    put("Inputs", "C16", "Placeholder - source needed.", "House rule (no lender quote yet).")
    put("Inputs", "C18", "Modeling assumption - source needed.", "House rule: sell at the purchase cap.")
    put("Tax", "C16", "falls back to T12 tax grown one year", "falls back to the T12 tax bill")
    put("Tax", "A25", "County source URL", "Tax source")
    put("Dashboard", "E5", "AVG RENT (IN-PLACE)", "AVG RENT / UNIT")
    put("Inputs", "C35", "Prior model / needs confirmation.", "Template allowance for common areas and exteriors; bids replace it after the LOI.")
    put("Inputs", "C43", "Placeholder - needs quote.", "Assumption for the refinance scenarios only (no lender quote).")
    put("Inputs", "A49", "Additional Other Income (Annual $, e.g. parking, pet, storage not yet charged)",
        "Other Income Adjustment (Annual $: + income not yet charged, - recurring discounts)")
    put("Exit Scenarios", "H9", "Cash-out at refi: new loan less the acquisition balance and refi closing cost. Treated as an investor distribution, not added spend.",
        "Refinance proceeds: new loan less the acquisition balance and refi closing cost. Positive is paid to investors; negative is new equity the refinance needs.")
    if "Inputs" in wb.sheetnames and wb["Inputs"]["C26"].value in (None, "") and str(wb["Inputs"]["A26"].value or "").startswith("Stabilized Occupancy"):
        wb["Inputs"]["C26"].value = "Occupancy held every year (vacancy = 1 - this). The rent roll's occupancy unless a review set it."
        n += 1
    if "Checks" in wb.sheetnames:
        ck = wb["Checks"]
        if ck["B15"].value == "NEEDS INPUT" and str(ck["A15"].value or "").startswith("Debt quote"):
            ck["B15"].value = "HOUSE RULE"
            ck["D15"].value = "70% LTV, 6% interest-only (house rule). A lender quote replaces it after the LOI."
            n += 1
        if ck["B16"].value == "NEEDS INPUT" and str(ck["A16"].value or "").startswith("Capex scope"):
            ck["B16"].value = "ASSUMED"
            ck["D16"].value = "Interior cost per unit from the OM where it gives one; common/exterior is a template allowance. Bids replace both after the LOI."
            n += 1
    if "Rent Comps" in wb.sheetnames:
        rc = wb["Rent Comps"]
        if rc["B2"].value == '=IF(IFERROR(G12,0)=0,"n/a",G12)':   # comps publish market rent, rarely achieved rent
            rc["B2"].value = '=IF(IFERROR(G12,0)<>0,G12,IF(IFERROR(F12,0)<>0,F12,"n/a"))'
            rc["B3"].value = "COMP SET AVG RENT (ACHIEVED, ELSE MARKET)"
            n += 1
        if str(rc["J6"].value or "").startswith("OM p.") and "Unit Mix" in str(rc["G6"].value or ""):
            rc["J6"].value = "Rent roll (Unit Mix tab)"
            n += 1
        comp_rows = [r for r in range(7, 12) if rc.cell(r, 1).value not in (None, "")]
        if comp_rows and all(rc.cell(r, 9).value in (None, "") for r in comp_rows):   # no online rents were pulled
            put("Rent Comps", "A1", "OM Comp Set + Online Verification, Fairness-Checked", "OM comp set, not checked online")
            put("Rent Comps", "I5", "Apartments.com / Zillow Rent", "Online Rent (not pulled)")
            put("Checks", "A13", "Apartments.com/Zillow rent comps", "Rent comps")
            put("Checks", "D13", "Add OM comp set + online verification on Rent Comps tab. Paste verified comps or support from browser/CoStar.",
                "The OM's comp set is on the Rent Comps tab; online rents were not pulled.")
    if "Sale Comps" in wb.sheetnames:
        sc = wb["Sale Comps"]
        srcs = [str(sc.cell(r, 9).value or "") for r in range(6, 12) if sc.cell(r, 1).value not in (None, "")]
        if srcs and not any("http" in x for x in srcs):     # nothing came from the web search the notes describe
            put("Sale Comps", "A1", "(auto-searched online + OM when available; verify before relying on them)", "(from the source column; verify before relying on them)")
            notes = [r for r in range(12, sc.max_row + 1) if re.match(r"^[234]\. ", str(sc.cell(r, 1).value or ""))]
            if notes:
                sc.cell(notes[0], 1).value = ("Every comp here comes from the source shown (none from a web search). Check them against "
                                              "county records or broker reports before relying on them.")
                for r in notes[1:]:
                    sc.cell(r, 1).value = None
                n += 1
    return f"Corrected {n} labels and notes that described the model wrongly (price source, median vs average, 'ask' on an unpriced deal, 'cash-out' refinances that need equity, 'source needed' on house rules)." if n else None


def apply_all(wb):
    # a deal's reviewed corrections go first, so a corrected address reaches the state rules below
    return [n for n in (deal_overrides(wb), widen_solver(wb), dashboard_irr_na(wb), reassessment_policy(wb),
                        tax_reset_by_state(wb), misc_per_unit(wb), price_from_ask(wb), occupancy_target(wb),
                        year1_rent_vacants(wb), vacant_market_rent(wb), misc_once(wb), downtime_rent_basis(wb),
                        reno_pace_years(wb), unallocated_overlap(wb), tax_rate_missing(wb), tax_full_reset(wb),
                        benchmark_floor_actual(wb), rent_roll_loss_to_lease(wb), turnover_share_exact(wb),
                        unit_mix_live(wb), noi_convention(wb), presentation_text(wb)) if n]
