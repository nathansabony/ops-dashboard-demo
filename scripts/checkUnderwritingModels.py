"""Checks on the Excel side of the underwriting tab.

1. The template fixes (underwriting/model_fixes.py) really change the template: the Max Price Solver spans 3%-12%
   in 19 columns, and the Dashboard's IRR tile reads "n/a" when the model could not solve one (it used to show 0.0%).
2. No model on a disk has formulas saved without a value. A model written by the generator and never recalculated opens
   with blank tabs in any viewer that does not recalculate. Pass the folder as the first argument (or set
   UNDERWRITING_DIR); without one, only the template checks run.

Run: python scripts/checkUnderwritingModels.py [folder-of-models]
"""
import os
import sys
import shutil
import tempfile
import json

HERE = os.path.dirname(os.path.abspath(__file__))
UW = os.path.join(HERE, "..", "underwriting")
sys.path.insert(0, UW)

from openpyxl import load_workbook  # noqa: E402
import model_fixes  # noqa: E402
from deal_card import uncomputed_formulas  # noqa: E402

failed = 0


def check(label, ok, detail=""):
    global failed
    print(("PASS  " if ok else "FAIL  ") + label + (("  -> " + str(detail)) if detail and not ok else ""))
    if not ok:
        failed += 1


print("The template fixes")
wb = load_workbook(os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))
changes = model_fixes.apply_all(wb)
check("the fixes report what they changed (solver, n/a IRR, Year-1 rent, downtime rent, renovation pace, unallocated overlap, cost floor, NOI convention, labels)", len(changes) == 9, changes)
ws = wb["Max Price Solver"]
caps = [ws.cell(7, c).value for c in range(2, 2 + model_fixes.SOLVER_COLS)]
check("the solver tries 19 cap rates", all(isinstance(v, (int, float)) for v in caps) and len(caps) == 19, caps)
check("...from 3.00% up to 12.00% in half-point steps", abs(caps[0] - 0.03) < 1e-9 and abs(caps[-1] - 0.12) < 1e-9
      and all(abs((b - a) - 0.005) < 1e-9 for a, b in zip(caps, caps[1:])), caps)
check("a price above or below the range says so instead of 'no solve'", "not achievable in range" in str(ws["B41"].value), ws["B41"].value)
a10 = str(wb["Dashboard"]["A10"].value)
check("the Dashboard IRR tile shows n/a when the IRR could not be solved (equity not 1.0x), not 0.0%", '"n/a"' in a10 and "$B$25=0" in a10, a10)
old = load_workbook(os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))
old["Dashboard"]["A10"].value = "='Exit Scenarios'!$C$14"
model_fixes.apply_all(old)
check("an older-template Dashboard (IRR read from Exit Scenarios) also shows n/a, not NM", '"n/a"' in str(old["Dashboard"]["A10"].value) and "ISNUMBER" in str(old["Dashboard"]["A10"].value), old["Dashboard"]["A10"].value)
again = model_fixes.apply_all(wb)
check("the fixes are safe to apply twice", again == [] or all(isinstance(x, str) for x in again), again)

print("\nA T12 is told apart from a rent roll")
import sheet_pick  # noqa: E402
MONTHS = ["Oct 2025", "Nov 2025", "Dec 2025", "Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026", "Total"]


def statement(book):
    return [("Some Property (123)",), ("Statement (12 months)",), ("Period = Oct 2025-Sep 2026",), (book,), tuple(MONTHS),
            ("4000", "REVENUE"), ("4100", "Rental Income", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 78), ("6200", "Insurance"), ("6300", "Repairs & Maintenance"),
            ("", "NET OPERATING INCOME", 1, 2, 3)]


rent_roll = [("Unit Rent Roll",), ("Unit", "Tenant", "Rent", "Lease From", "Lease To", "Move In")] + [(f"{100 + i}", "Resident", 1200, "2026-01-01", "2026-12-31", "2026-01-01") for i in range(20)]
check("a tab called 'Report1' with twelve month columns and income / expense lines is a T12", sheet_pick.classify("Report1", statement("Book = Accrual"))[0] == "t12")
check("a tab called '12 Month Statement' is a T12 by its name", sheet_pick.classify("12 Month Statement-3avonda", statement("Book = Accrual"))[0] == "t12")
check("'Book = Accrual,Budget (BA)' is a ledger name, not a budget: still a T12", sheet_pick.classify("Report1", statement("Book = Accrual,Budget (BA) ; Tree = x"))[0] == "t12")
check("a statement titled pro forma is still a pro forma", sheet_pick.classify("Report1", [("Pro Forma Operating Statement",)] + statement("Book = Accrual")[1:])[0] == "proforma")
check("a unit-per-row rent roll is still a rent roll", sheet_pick.classify("Report1", rent_roll)[0] == "rent_roll")

print("\nA rent roll's own summary lines are not units")
import tempfile  # noqa: E402
from openpyxl import Workbook  # noqa: E402
import mapped_extract  # noqa: E402
tmpd = tempfile.mkdtemp()
wbk = Workbook()
wsk = wbk.active
wsk.title = "Sheet1"
for r in [("Rent Roll",), ("Exported On: 08/24/2026",), ("Unit", "Tenant", "Status", "Sqft", "Market Rent", "Rent"),
          ("1269-1", "A Smith", "Current", 950, 1155, 1055), ("1269-2", "B Jones", "Notice-Unrented", 950, 1350, 1350), ("1269-3", "", "Vacant", 950, 1350, 0),
          ("3 Units", "66.7% Occupied", None, 2850, 3855, 2405), (None,), ("Total 3 Units", "66.7% Occupied", None, 2850, 3855, 2405)]:
    wsk.append(list(r))
xl = os.path.join(tmpd, "rr.xlsx")
wbk.save(xl)
mp = {"kind": "rent_roll", "mappable": True, "official": {"official_units": 3, "official_occupied_units": 2},
      "mapping": {"columns": {"unit_number": 1, "resident_name": 2, "status": 3, "sqft": 4, "market_rent": 5, "rent_charge": 6},
                  "status_rules": {"vacant_contains": ["vacant", "notice-unrented"]}, "occupancy_source": "status", "sheets": [{"name": "Sheet1", "data_start_row": 4}]}}
got = mapped_extract.extract(xl, mp)
check("a 'N Units' summary line under the data is not read as a unit (3 units, 2 occupied, no count-mismatch warning)",
      len(got["data"]["units"]) == 3 and sum(u["occupied_flag"] for u in got["data"]["units"]) == 2 and not any("report summary says" in w for w in got["warnings"]),
      [len(got["data"]["units"]), got["warnings"]])
check("a resident on notice is occupied even when the mapping lists the notice status as vacant", sum(u["occupied_flag"] for u in got["data"]["units"]) == 2)
check("...and the skipped summary line is counted in the read's notes", got["meta"].get("summary_rows_skipped") == 2, got["meta"])

print("\nA T12 whose header sits low, and a mapping that misses month columns")
import sheet_sample  # noqa: E402
mon = ["Aug 2025", "Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025", "Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026"]
wt = Workbook()
wst = wt.active
wst.title = "Sheet1"
for i in range(12):
    wst.append(["Income Statement - 12 Month" if i == 0 else None])
wst.append(["Account Name"] + mon + ["Total"])                      # row 13: one past the 12 head rows
for lab, base in (("Gross Potential Rent", 225000), ("Total Operating Income", 232000), ("Total Operating Expense", 85000)):
    vals = [base + k * 100 for k in range(12)]
    wst.append([lab] + vals + [sum(vals)])
noi = [232000 + k * 100 - 85000 - k * 100 for k in range(12)]
wst.append(["NOI - Net Operating Income"] + noi + [sum(noi)])
xt = os.path.join(tmpd, "t12.xlsx")
wt.save(xt)
smp = sheet_sample.sample(xt)
hdr_line = next(l for l in str(smp["text"] if isinstance(smp, dict) else smp).split("\n") if l.startswith("R13:"))
check("the month header row is shown in full to the mapping model even when it is below the head rows (all 12 months)", hdr_line.count("2025") + hdr_line.count("2026") == 12, hdr_line)
tm = lambda cols: {"kind": "t12", "mappable": True, "t12_mapping": {"sheet": "Sheet1", "month_header_row": 13, "month_columns": cols, "total_column": None, "label_columns": [1],
                   "fields": {"gross_potential_rent": {"row": 14}, "effective_gross_income": {"row": 15}, "total_operating_expenses": {"row": 16}, "net_operating_income": {"row": 17}}}}
bad = mapped_extract.extract(xt, tm([2, 3]))
good = mapped_extract.extract(xt, tm(list(range(2, 14))))
check("a mapping that took 2 of 12 month columns says it does not tie out to the statement's own NOI total", any(w.startswith("Tie-out:") and "month columns" in w for w in bad["warnings"]), bad["warnings"])
check("a mapping of all 12 months reproduces the statement's NOI and raises no tie-out warning", abs(good["data"]["net_operating_income"] - sum(noi)) < 1 and not any(w.startswith("Tie-out:") for w in good["warnings"]), good["warnings"])

print("\nProperty tax after a sale follows the county's rule (Summit Heights, Ohio)")


def tax_book(rule):
    wbt = Workbook()
    t = wbt.active
    t.title = "Tax"
    t["B8"], t["B9"], t["B10"], t["B13"] = 31484740, 58.44, 0, 1839811.74
    t["B14"] = "='Debt & Exit'!$B$6"
    t["B26"] = rule
    sv = wbt.create_sheet("Max Price Solver")
    for c in range(2, 21):
        sv.cell(13, c).value = f"=IF(OR(Tax!$B$8<=0,Tax!$B$9<=0),Tax!$B$13,{get_column_letter(c)}8*Tax!$B$9/1000+Tax!$B$10)"
    return wbt


from openpyxl.utils import get_column_letter  # noqa: E402
oh = tax_book("Example County reappraises every 3 years; a sale itself does not automatically trigger reassessment to sale price.")
n_oh = model_fixes.reassessment_policy(oh)
check("an old-template Tax tab gains the Reassessment on Sale input, and a county rule saying a sale does not trigger reassessment sets it to 0%",
      oh["Tax"]["A19"].value == model_fixes.POLICY_LABEL and oh["Tax"]["B19"].value == 0 and "$B$19" in oh["Tax"]["B14"].value and n_oh, n_oh)
check("the Max Price Solver applies the policy at every candidate price (all 19 columns)",
      all("Tax!$B$19" in str(oh["Max Price Solver"].cell(13, c).value) for c in range(2, 21)))
fl = tax_book("Florida reassesses property near the sale price after a sale.")
model_fixes.reassessment_policy(fl)
check("a county that does reset on sale keeps 100%, so Florida-style deals are unchanged", fl["Tax"]["B19"].value == 1.0)
check("the fix is safe to apply twice", model_fixes.reassessment_policy(oh) is None or "gained" not in model_fixes.reassessment_policy(oh))

print("\nYear-1 defaults that cut every deal (2026-10-31 review)")


def default_book(address, units=56, taxable=0, bill=90000):
    b = load_workbook(os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))
    b["Inputs"]["B10"], b["Inputs"]["B13"], b["Tax"]["B8"], b["Tax"]["B13"] = address, units, taxable, bill
    return b


pa = default_book("100 Lancaster Ave, Fairview, PA 19335")
n_pa = model_fixes.tax_reset_by_state(pa)
check("a Pennsylvania deal does not reset its tax to the price (0%), and says why on the Tax tab",
      pa["Tax"]["B19"].value == 0 and "Pennsylvania" in str(pa["Tax"]["C19"].value) and n_pa, n_pa)
check("...with no assessed value, today's value is implied from the T12 bill so the tax holds, not drops to $0",
      "B13" in str(pa["Tax"]["B8"].value) and "house estimate" in str(pa["Tax"]["C8"].value), pa["Tax"]["B8"].value)
blind = default_book("9 Oak St, Wilmington, DE 19801", bill=0)
check("with neither an assessed value nor a T12 tax bill, the reset stays at 100% (0% would mean no tax at all)",
      model_fixes.tax_reset_by_state(blind) is None and blind["Tax"]["B19"].value == 1)
tx = default_book("5 Elm St, Dallas, TX 75201")
model_fixes.tax_reset_by_state(tx)
check("a Texas deal keeps the 100% reset", tx["Tax"]["B19"].value == 1)
nj = default_book("431 Maple Blvd, Fairview, NJ 07002", taxable=5_000_000)
model_fixes.tax_reset_by_state(nj)
check("a New Jersey deal with an assessed value keeps that value", nj["Tax"]["B19"].value == 0 and nj["Tax"]["B8"].value == 5_000_000)
set_by_hand = default_book("1 Main St, Media, PA 19063")
set_by_hand["Tax"]["B19"] = 0.5
check("a reset someone typed is left alone", model_fixes.tax_reset_by_state(set_by_hand) is None and set_by_hand["Tax"]["B19"].value == 0.5)
check("the state fix is safe to apply twice", model_fixes.tax_reset_by_state(pa) is None)
model_fixes.misc_per_unit(pa)
check("the flat $100,000 one-time misc becomes $250 a unit (56 units = $14,000)", pa["Inputs"]["B37"].value == 14000, pa["Inputs"]["B37"].value)
check("...and only once", model_fixes.misc_per_unit(pa) is None and pa["Inputs"]["B37"].value == 14000)
typed = default_book("1 Main St, Tampa, FL 33601")
typed["Inputs"]["B37"] = 40000
check("a misc amount someone typed is left alone", model_fixes.misc_per_unit(typed) is None and typed["Inputs"]["B37"].value == 40000)

ew = default_book("1 Bay Dr, Tampa, FL 33601")
ew["Rent Roll"]["B10"], ew["Inputs"]["B26"] = 0.9733, 0.71
n_ew = model_fixes.occupancy_target(ew)
check("an occupancy target typed far under the rent roll's (Emerald Waters: 71% vs 97.3%) goes back to the rent roll, and says so",
      ew["Inputs"]["B26"].value == "='Rent Roll'!$B$10" and n_ew and "71.0%" in n_ew, ew["Inputs"]["B26"].value)
lift = default_book("1 Bay Dr, Tampa, FL 33601")
lift["Rent Roll"]["B10"], lift["Inputs"]["B26"] = 0.887, 0.94
check("a target above today's occupancy (Elmhurst: 94% vs 88.7%) is a lease-up plan and is left alone",
      model_fixes.occupancy_target(lift) is None and lift["Inputs"]["B26"].value == 0.94)
near = default_book("1 Bay Dr, Tampa, FL 33601")
near["Rent Roll"]["B10"], near["Inputs"]["B26"] = 0.95, 0.93
check("a target a couple of points under today's is left alone", model_fixes.occupancy_target(near) is None)

print("\nThe 2026-10-31 hand review's template fixes")
hr = default_book("1 Bay Dr, Tampa, FL 33601")
model_fixes.year1_rent_vacants(hr)
y1 = str(hr["Pro Forma"]["D6"].value)
check("Year-1 rent starts from vacant units at market (Rent Roll B19), not in-place with vacants at $0",
      "'Rent Roll'!$B$19*12" in y1 and "'Rent Roll'!$B$16*12)+" not in y1, y1)
check("...and only once", model_fixes.year1_rent_vacants(hr) is None)
rrw = hr["Rent Roll"]
first = next(r for r in range(10, 40) if str(rrw.cell(r, 1).value or "").strip().lower() == "unit") + 1
for i, (typ, mkt, occ) in enumerate([("a1", 1200, 1), ("a1", 1300, 1), ("a1", 0, 0), ("b2", 1600, 1), ("b2", None, 0)]):
    rrw.cell(first + i, 1).value, rrw.cell(first + i, 2).value, rrw.cell(first + i, 6).value, rrw.cell(first + i, 13).value = f"u{i}", typ, mkt, occ
for r in range(first + 5, first + 450):
    rrw.cell(r, 1).value = None
n_v = model_fixes.vacant_market_rent(hr)
check("a vacant unit read with $0 market rent takes its unit type's average (Eastern Pines: 32 units)",
      rrw.cell(first + 2, 6).value == 1250 and rrw.cell(first + 4, 6).value == 1600 and n_v and n_v.startswith("2 "), (rrw.cell(first + 2, 6).value, n_v))
um = hr["Pro Forma"]
ru = next(r for r in range(5, 45) if str(um.cell(r, 1).value or "").startswith("Other Controllable"))
model_fixes.unallocated_overlap(hr)
check("Year 1's unallocated controllable gives up the benchmarks charged on lines the T12 had at $0 (Harbor: payroll twice)",
      str(um.cell(ru, 4).value).startswith("=MAX(0,") and "IF(N($B$" in str(um.cell(ru, 4).value), um.cell(ru, 4).value)
check("...and only once", model_fixes.unallocated_overlap(hr) is None)
fl = default_book("6601 S Westshore Blvd, Tampa, FL 33616", bill=1109486)
n_t = model_fixes.tax_rate_missing(fl)
check("a Florida deal with no county rate resets its tax on an estimated rate (labelled ours) instead of keeping today's bill",
      fl["Tax"]["B9"].value == 17.0 and "house estimate" in str(fl["Tax"]["C9"].value) and n_t, n_t)
nj = default_book("431 Maple Blvd, Fairview, NJ 07002")
nj["Tax"]["B19"] = 0
check("...but not where the state does not reset on sale", model_fixes.tax_rate_missing(nj) is None)
fl["Tax"]["B16"] = "=IF(OR($B$8<=0,$B$9<=0),$B$13,$B$15+$B$10)"     # the live models' older formula
fl["Tax"]["B15"] = "=IF(OR($B$8<=0,$B$9<=0),$B$13,$B$14*$B$9/1000)"
for c in range(2, 21):
    fl["Max Price Solver"].cell(13, c).value = f"=IF(OR(Tax!$B$8<=0,Tax!$B$9<=0),Tax!$B$13,(Tax!$B$8+({get_column_letter(c)}8-Tax!$B$8)*Tax!$B$19)*Tax!$B$9/1000+Tax!$B$10)"
model_fixes.tax_full_reset(fl)
check("a full reset to the price runs with no taxable value on file (Year-1 tax and every solver column)",
      "AND($B$8<=0,$B$19<1)" in str(fl["Tax"]["B16"].value) and "AND($B$8<=0,$B$19<1)" in str(fl["Tax"]["B15"].value)
      and all("AND(Tax!$B$8<=0,Tax!$B$19<1)" in str(fl["Max Price Solver"].cell(13, c).value) for c in range(2, 21)),
      (fl["Tax"]["B16"].value, fl["Max Price Solver"]["B13"].value))
check("...and only once", model_fixes.tax_full_reset(fl) is None)
ov = default_book("1 Main St, Media, PA 19063")
ov["Inputs"]["B9"] = "The Manor at Fairview"
tmpo = tempfile.mkdtemp()
try:
    po = os.path.join(tmpo, "o.json")
    with open(po, "w", encoding="utf-8") as f:
        json.dump({"themanoratfairview": {"cells": [{"cell": "Inputs!B31", "value": 126, "why": "Premium from the rent roll."}]}}, f)
    n_o = model_fixes.deal_overrides(ov, po)
    check("a reviewed correction for this property is applied, with its reason beside the cell",
          ov["Inputs"]["B31"].value == 126 and "Premium from the rent roll" in str(ov["Inputs"]["C31"].value) and n_o, n_o)
    check("...and only once", model_fixes.deal_overrides(ov, po) is None)
    other = default_book("1 Main St, Media, PA 19063")
    other["Inputs"]["B9"] = "Some Other Deal"
    check("a deal with no reviewed corrections is untouched", model_fixes.deal_overrides(other, po) is None)
finally:
    shutil.rmtree(tmpo, ignore_errors=True)
with open(os.path.join(HERE, "..", "config", "underwriting-overrides.json"), encoding="utf-8") as f:
    table = json.load(f)
check("every reviewed correction names a sheet!cell and gives a reason",
      all(all("!" in c["cell"] and c.get("why") for c in v.get("cells", [])) for k, v in table.items() if not k.startswith("_")))

bf = load_workbook(os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))
n_bf = model_fixes.benchmark_floor_actual(bf)
pfb = bf["Pro Forma"]
rows_bf = {str(pfb.cell(r, 1).value).strip(): r for r in range(6, 40) if pfb.cell(r, 1).value}
ins = str(pfb.cell(rows_bf["Insurance and Bonds"], 4).value)
check("a house cost standard is a floor: Year-1 insurance is the higher of the standard and the T12 cost (Villa Serena: $2,497 vs $1,100)",
      "MAX($M" in ins and "*Units,B" in ins and n_bf, ins)
rmf, tnf = str(pfb.cell(rows_bf["Repairs & Maintenance"], 4).value), str(pfb.cell(rows_bf["Turnover Costs"], 4).value)
check("repairs and turnover are floored as one pair, so make-ready filed under either line is counted once (Lakeview)",
      "+B" in rmf and "-D" in rmf and "MAX(" not in tnf, (rmf, tnf))
check("...the fee lines (a % of income) are not touched", "MAX(" not in str(pfb.cell(rows_bf["Management Fee"], 4).value))
check("...and only once", model_fixes.benchmark_floor_actual(bf) is None)

print("\nThe 2026-11-01 fixes (Meadow Green voucher rent, phased loss-to-lease, renovation pace)")
import parsers  # noqa: E402
check("a voucher's share of the rent ('Subsidy') and short-term-rental rent count as rent, beside the tenant's share",
      {"rent", "subsidy", "strrent"} <= parsers.RENT_CODES, parsers.RENT_CODES)
vb = default_book("13300 Meadow Green Dr, Meadow Hills, FL 33414")
vb["Inputs"]["B9"] = "The Estates at Meadow Green"
vrr = vb["Rent Roll"]
vfirst = next(r for r in range(10, 40) if str(vrr.cell(r, 1).value or "").strip().lower() == "unit") + 1
vrr.cell(vfirst, 1).value, vrr.cell(vfirst, 6).value, vrr.cell(vfirst, 7).value, vrr.cell(vfirst, 13).value = "04-00109", 2600, 45, 1
tmpv = tempfile.mkdtemp()
try:
    pv = os.path.join(tmpv, "o.json")
    with open(pv, "w", encoding="utf-8") as f:
        json.dump({"theestatesatmeadowgreen": {
            "cells": [{"cell": "T12 Actuals!B18", "value": 1000, "why": "A fee the T12 left out."}],
            "unit_rents": {"04-00109": 2452}, "unit_rents_why": "Voucher rent.",
            "ltl_capture": [0.25, 0.5]}}, f)
    n_v2 = model_fixes.deal_overrides(vb, pv)
    check("a unit's corrected rent is set by unit number (04-00109: $45 tenant share + $2,407 voucher)",
          vrr.cell(vfirst, 7).value == 2452 and "Voucher rent" in str(n_v2), n_v2)
    check("a correction outside Inputs carries its reason as a cell comment",
          vb["T12 Actuals"]["B18"].value == 1000 and "left out" in (vb["T12 Actuals"]["B18"].comment.text if vb["T12 Actuals"]["B18"].comment else ""))
    pfv = vb["Pro Forma"]
    gr = next(r for r in range(5, 45) if str(pfv.cell(r, 1).value or "").startswith("Base Gross Potential Rent"))
    ycols = model_fixes._year_cols(pfv)
    y2, y3, y8 = (str(pfv.cell(gr, ycols[i]).value) for i in (1, 2, 7))
    check("loss-to-lease is captured year by year as listed (rent control): 25% in Year 1, 50% in Year 2, all of it after",
          vb["Inputs"]["B44"].value == 0.25 and "*0.5)*(1+Inputs!$B$21)^1" in y2 and "*1)*(1+Inputs!$B$21)^2" in y3 and "^7" in y8, (y2, y3))
finally:
    shutil.rmtree(tmpv, ignore_errors=True)
rp = load_workbook(os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))
pfr = rp["Pro Forma"]
vr = next(r for r in range(5, 45) if str(pfr.cell(r, 1).value or "").startswith("Value-Add Rent Impact"))
rcols = model_fixes._year_cols(pfr)
pfr.cell(vr, rcols[2]).value = "='Reno Pace'!$B$106*(1+Inputs!$B$21)"      # generator.extend_reno_pace (96 months)
check("a model whose Reno Pace already runs 96 months is left alone", model_fixes.reno_pace_years(rp) is None)
pfr.cell(vr, rcols[2]).value = "='Reno Pace'!$B$37*(1+Inputs!$B$21)"      # the 24-month template (Metro Central)
for c in rcols[3:]:
    pfr.cell(vr, c).value = f"={get_column_letter(c - 1)}{vr}*(1+Inputs!$B$21)"
n_rp = model_fixes.reno_pace_years(rp)
y3r, y4r = str(pfr.cell(vr, rcols[2]).value), str(pfr.cell(vr, rcols[3]).value)
check("Years 3-8 of the renovation premium count the units online each month, not every unit as done (Metro Central)",
      n_rp and y3r.count("MIN(Inputs!$B$30") == 14 and "(25-Inputs!$B$33+1)*Inputs!$B$45" in y3r and "(36-Inputs!$B$33+1)" in y3r
      and "^1-" in y3r and "^2-" in y4r and "'Rent Roll'!$B$16" in y3r, y3r[:200])
check("...and only once", model_fixes.reno_pace_years(rp) is None)
old_t = load_workbook(os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))      # the oldest layout: pace in B46, downtime B38
old_t["Pro Forma"].cell(vr, rcols[2]).value = "='Reno Pace'!$B$37*(1+Inputs!$B$21)"
old_t["Reno Pace"]["B6"] = "=IF(A6<Inputs!$B$33,0,MAX(0,MIN(Inputs!$B$46,Inputs!$B$30-SUM($B$5:B5))))"
old_t["Reno Pace"]["E6"] = "=D6*Inputs!$B$31"
old_t["Reno Pace"]["F6"] = "=IFERROR(B6*('Rent Roll'!$B$16/Inputs!$B$13)*Inputs!$B$38,0)"
model_fixes.reno_pace_years(old_t)
y3o = str(old_t["Pro Forma"].cell(vr, rcols[2]).value)
check("...reading the pace and downtime from the model's own schedule (Gardens, Fairview: pace in B46, B45 is the loss-to-lease share)",
      "*Inputs!$B$46))" in y3o and "Inputs!$B$45" not in y3o and "*Inputs!$B$38" in y3o, y3o[:200])
lt = load_workbook(os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))
model_fixes.apply_all(lt)
check("renovation downtime charges the average rent with vacant units at market, not in-place rent over all units (Meadow: $2,358 vs $2,466)",
      all("'Rent Roll'!$B$16/Inputs!$B$13" not in str(c.value) for row in lt["Reno Pace"].iter_rows() for c in row)
      and "'Rent Roll'!$B$19+" in str(lt["Dashboard"]["B31"].value), lt["Dashboard"]["B31"].value)
check("labels say what the model does: price override on Inputs B6, an average called an average, refinances not called cash-out",
      "Inputs (B6)" in str(lt["Debt & Exit"]["C6"].value) and "MEDIAN" not in str(lt["Sale Comps"]["B3"].value)
      and "Cash-out" not in str(lt["Exit Scenarios"]["E18"].value) and lt["Checks"]["B15"].value == "HOUSE RULE", lt["Debt & Exit"]["C6"].value)
check("...and only once", model_fixes.presentation_text(lt) is None and model_fixes.downtime_rent_basis(lt) is None)
um_b = default_book("13300 Meadow Green Dr, Meadow Hills, FL 33414")
urr, uum = um_b["Rent Roll"], um_b["Unit Mix"]
ufirst = next(r for r in range(10, 40) if str(urr.cell(r, 1).value or "").strip().lower() == "unit") + 1
for r in range(ufirst, ufirst + 600):
    urr.cell(r, 1).value = None
for k, (typ, mkt, rent, occ) in enumerate([("a1", 2000, 2452, 1), ("a1", 2100, 0, 0), ("b2", 2600, 2500, 1)]):
    for c, v in ((1, f"u{k}"), (2, typ), (3, 900), (6, mkt), (7, rent), (13, occ)):
        urr.cell(ufirst + k, c).value = v
for r in range(6, uum.max_row + 1):
    for c in range(1, 11):
        uum.cell(r, c).value = None
uum["A6"], uum["A7"] = "a1", "b2"
n_um = model_fixes.unit_mix_live(um_b)
check("the Unit Mix is regrouped from the Rent Roll tab by floor plan, so a corrected rent reaches it and the rent comps (Meadow voucher rent)",
      n_um and (uum["B6"].value, uum["C6"].value, uum["H6"].value, uum["I6"].value, uum["G6"].value) == (2, 1, 4100, 2452, 2452), [uum.cell(6, c).value for c in range(2, 10)])
check("...as values, not lookups the live server's formula engine runs out of memory on", not str(uum["I6"].value).startswith("="))
nc = load_workbook(os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))
model_fixes.apply_all(nc)
npf = nc["Pro Forma"]
nrows = {str(npf.cell(r, 1).value or "").strip(): r for r in range(5, 45)}
ncols = model_fixes._year_cols(npf)
check("replacement reserves are an operating expense above NOI, as lenders and buyers count them; the asset-management fee is not",
      "Replacement Reserves" in nrows and "Asset Management Fee" not in nrows and nrows["Replacement Reserves"] < nrows["Total Operating Expenses"]
      and "*Inputs!$B$13" in str(npf.cell(nrows["Replacement Reserves"], ncols[0]).value), sorted(nrows)[:5])
cf_row = nrows["Cash Flow After Debt Service and Asset Management Fee"]
check("...the fee is still paid every year from cash flow: Pro Forma, Debt & Exit, every exit scenario and every solver column",
      "*Inputs!$B$28" in str(npf.cell(cf_row, ncols[0]).value) and "*Inputs!$B$28" in str(nc["Debt & Exit"]["C22"].value)
      and "*Inputs!$B$28" in str(nc["Exit Scenarios"]["I44"].value) and "*Inputs!$B$28" in str(nc["Max Price Solver"]["T33"].value),
      (npf.cell(cf_row, ncols[0]).value, nc["Debt & Exit"]["C22"].value))
check("...and only once", model_fixes.noi_convention(nc) is None)
uum["A8"] = "zz9"
check("...but not where the tab lists a floor plan the rent roll does not have", model_fixes.unit_mix_live(um_b) is None)

print("\nThe workbook's look (underwriting/model_style.py)")
import model_style  # noqa: E402
sty = load_workbook(os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))
model_fixes.apply_all(sty)
before = {(ws.title, c.coordinate): c.value for ws in sty.worksheets for row in ws.iter_rows() for c in row if isinstance(c.value, str) and c.value.startswith("=")}
notes1 = model_style.apply_all(sty)
formulas_changed = [k for k, v in before.items() if sty[k[0]][k[1]].value != v]
check("styling only reads and writes presentation: the only existing formulas it rewrites are the comps KPI tiles and the Reno Pace note and tiles",
      all(k[0] in ("Rent Comps", "Sale Comps", "Reno Pace") for k in formulas_changed), formulas_changed[:6])
check("the Reno Pace Year-1 impact tile reads the summary row, not a stale table cell", sty["Reno Pace"]["C2"].value == "=IFERROR(B%d,0)" % next(r for r in range(20, 200) if str(sty["Reno Pace"].cell(r, 1).value or "").strip().lower() == "year 1 net rent impact")
      , [sty["Reno Pace"]["C2"].value, sty["Reno Pace"]["D2"].value])
tc = {ws.title: (ws.sheet_properties.tabColor.rgb if ws.sheet_properties.tabColor else None) for ws in sty.worksheets}
check("only the important tabs are coloured: Pro Forma green, Exit Scenarios red, Inputs gold; documents, Tax, Reno Pace, comps and Checks have no colour",
      tc["Pro Forma"].endswith("14532D") and tc["Exit Scenarios"].endswith("C00000") and tc["Inputs"].endswith("B98A2E") and all(tc[n] is None for n in ("T12 Actuals", "Rent Roll", "Unit Mix", "Tax", "Reno Pace", "Rent Comps", "Sale Comps", "Checks", "Max Price Solver")), tc)
check("gridlines are off on every sheet", all(ws.sheet_view.showGridLines is False for ws in sty.worksheets))
legacy_navy = [ws.title for ws in sty.worksheets for row in ws.iter_rows() for c in row if c.fill and c.fill.fill_type == "solid" and str(c.fill.fgColor.rgb)[-6:] in ("1F4E78", "0F243E", "FFF2CC")]
check("no old navy or 'calculated' yellow fill is left anywhere", not legacy_navy, legacy_navy[:3])
pt = sty["Price Tool"]
check("the Pro Forma gets Year-1 $ per unit and % of EGI columns to the right, as formulas", sty["Pro Forma"]["N5"].value == "Yr-1 $ / Unit" and any(str(sty["Pro Forma"].cell(r, 15).value or "").startswith("=IFERROR($E") for r in range(6, 31)), sty["Pro Forma"]["N5"].value)
check("a Price Tool tab sits after the Max Price Solver with a cap-rate list", sty.sheetnames.index("Price Tool") == sty.sheetnames.index("Max Price Solver") + 1
      and any("Max Price Solver" in (dv.formula1 or "") for dv in pt.data_validations.dataValidation) and 0.03 <= pt["B3"].value <= 0.12)
check("...whose figures all read from the solver grid (nothing is typed in)", all("Max Price Solver" in str(pt.cell(r, 2).value) for r in (5, 6, 7, 8, 9)))
snap = {(ws.title, c.coordinate): c.value for ws in sty.worksheets for row in ws.iter_rows() for c in row if c.value is not None}
model_style.apply_all(sty)
check("applying the style twice changes nothing", {(ws.title, c.coordinate): c.value for ws in sty.worksheets for row in ws.iter_rows() for c in row if c.value is not None} == snap)

print("\nResMan exports and multi-property T12s (Lakeview portfolio, 2026-10-29)")
import re as _re  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402
import zipfile  # noqa: E402
from openpyxl import Workbook  # noqa: E402
import parsers  # noqa: E402
import sheet_sample  # noqa: E402
import sheet_text  # noqa: E402
import mapped_extract  # noqa: E402

tmpd = tempfile.mkdtemp()


def unsized(path):
    """Strip the <dimension> record, as ResMan's exports have none (read-only openpyxl then reports no size)."""
    out = path.replace(".xlsx", "-unsized.xlsx")
    with zipfile.ZipFile(path) as zi, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zi.infolist():
            data = zi.read(item.filename)
            if item.filename.startswith("xl/worksheets/sheet"):
                data = _re.sub(rb"<dimension[^>]*/>", b"", data)
            zo.writestr(item, data)
    return out


# A synthetic ResMan rent roll: unit numbers under the left half of a merged "Unit" header, each unit a block of
# charge rows ending in "Total", vacant units with no status, and the Property Occupancy summary block.
rr = Workbook()
ws = rr.active
for r, v in ((2, "Test Gardens Apartments"), (4, "Rent Roll"), (5, "9/1/2026"), (8, "Current")):
    ws.cell(r, 1, v)
for c, v in ((2, "Unit"), (3, "Type"), (5, "Sq. Feet"), (6, "Residents"), (11, "Status"), (13, "Market Rent"), (20, "Description"),
             (23, "Amount"), (27, "Move In"), (30, "Lease End"), (34, "Move Out"), (39, "Balance")):
    ws.cell(9, c, v)
blocks = [("101", "A1", 700, "Pat Doe", "C", 1000, [("Resident Rent", 1050), ("Trash Service Fee", 5), ("Total", 1055)]),
          ("102", "A1", 700, "Vacant Unit", None, 1000, [("Total", 0)]),
          ("103", "B1", 900, "Sam Roe", "NTV", 1200, [("Resident Rent", 1150), ("Valet Trash", 18), ("Total", 1168)])]
r = 10
for unit, typ, sf, name, st, mkt, charges in blocks:
    ws.cell(r, 1, unit); ws.cell(r, 3, typ); ws.cell(r, 5, sf); ws.cell(r, 6, name); ws.cell(r, 13, mkt)
    if st:
        ws.cell(r, 11, st)
    for desc, amt in charges:
        ws.cell(r, 20, desc); ws.cell(r, 23, amt); r += 1
    r += 1
ws.cell(r, 1, "Total Charges"); r += 2
ws.cell(r, 1, "Property Occupancy"); r += 1
ws.cell(r, 1, "Type"); ws.cell(r, 4, "Status"); ws.cell(r, 16, "Units"); r += 1
ws.cell(r, 1, "Total"); ws.cell(r, 4, "Occupied"); ws.cell(r, 16, 2); r += 1
ws.cell(r, 1, "Total"); ws.cell(r, 4, "Vacant"); ws.cell(r, 16, 1)
rr.save(os.path.join(tmpd, "rr.xlsx"))
rr_path = unsized(os.path.join(tmpd, "rr.xlsx"))
check("an unsized workbook still reads as text (it read as 'empty')", any("Pat Doe" in " ".join(row) for _, rows in sheet_text.read_xlsx(rr_path) for row in rows))
check("a ResMan rent roll is recognised by the zero-token parser", parsers.detect_file(rr_path) == "rent_roll", parsers.detect_file(rr_path))
data, meta, warns = parsers.parse_rent_roll(rr_path)
units = data["units"]
check("...every unit block becomes one unit, numbers from the column left of the 'Unit' header", [u["unit_number"] for u in units] == ["101", "102", "103"], [u["unit_number"] for u in units])
check("...rent is the Resident Rent line, total charges the block's Total", [u["rent_charge"] for u in units] == [1050, 0, 1150] and [u["total_charges"] for u in units] == [1055, 0, 1168])
check("...a resident on notice is occupied, 'Vacant Unit' with no status is not", [u["occupied_flag"] for u in units] == [1, 0, 1])
check("...official counts come from the Property Occupancy block", (data.get("official_units"), data.get("official_occupied_units"), data["as_of_date"]) == (3, 2, "2026-09-01"), data)
check("...and it ties, so no warning", warns == [], warns)

# A ResMan T12: months headed "Sep 2025 Actual", an "Adjusted Total" and then a Variance column.
t = Workbook()
ws = t.active
hdr = ["Account", "", ""] + [f"{mo} Actual" for mo in ("Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025", "Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026", "Aug 2026")] + ["Adjusted Total", "Variance"]
ws.append(["Test Gardens"])
ws.append(hdr)
for k in range(12):      # GL detail lines, so the totals below sit past the sampler's full-width head rows
    ws.append([f"41{k:02d} Detail line {k}", "", ""] + [1] * 12 + [12, 0])
lines = [("TOTAL INCOME", 100), ("6100 Total ADMINISTRATION", 10), ("6200 Total LEGAL / FINANCE & INSURANCE", 8), ("6235 Property Insurance", 6),
         ("6400 Total PAYROLL", 20), ("TOTAL EXPENSE", 38), ("NET OPERATING INCOME", 62)]
row_of = {}
for label, monthly in lines:
    ws.append([label, "", ""] + [monthly] * 12 + [monthly * 12, -999])
    row_of[label.split()[0] if label[0].isdigit() else label] = ws.max_row
t12_path = os.path.join(tmpd, "t12.xlsx")
t.save(t12_path)
s = sheet_sample.sample(t12_path)["text"]
check("'Sep 2025 Actual' month headers make a T12-style sample (every line listed)", "T12-style" in s, s[:200])
check("...whose row totals are the Total column, not the Variance after it", "rowtotal=744" in s and "rowtotal=-999" not in s, _re.findall(r"rowtotal=[-\d.]+", s)[:4])
R = row_of
m = {"kind": "t12", "t12_mapping": {"sheet": t.active.title, "month_header_row": 2, "month_columns": list(range(4, 16)), "total_column": 16, "label_columns": [1],
     "fields": {"effective_gross_income": {"row": R["TOTAL INCOME"]}, "controllable_expenses": {"sum_rows": [R["6100"], R["6400"]]},
                "insurance": {"row": R["6235"]}, "labor_costs": {"row": R["6400"]},
                "total_operating_expenses": {"row": R["TOTAL EXPENSE"]}, "net_operating_income": {"row": R["NET OPERATING INCOME"]}}}}
out = mapped_extract.extract_t12(t12_path, m)
check("sub-sections that leave a remainder (contract services, carried as other controllable) pass quietly", not any("sub-sections" in w for w in out["warnings"]), out["warnings"])
m["t12_mapping"]["fields"].update({"repairs_maintenance": {"row": R["6235"]}, "turnover_costs": {"row": R["6235"]}, "advertising_promotions": {"row": R["6235"]}})
out = mapped_extract.extract_t12(t12_path, m)
check("controllable sub-sections that add up to MORE than controllable raise a Tie-out (so the server re-maps once)",
      any(w.startswith("Tie-out:") and "sub-sections" in w for w in out["warnings"]), out["warnings"])
shutil.rmtree(tmpd, ignore_errors=True)

print("\nDeal Combinations (every mix of a multi-building deal)")
import deal_combos  # noqa: E402


def two_building_deal():
    def prop(name, n, ask, noi):
        t = dict(gross_potential_rent=n * 13200, vacancy_concessions_bad_debt=-n * 900, other_income=n * 600,
                 effective_gross_income=n * 12900, controllable_expenses=n * 1500, utilities=n * 500, insurance=n * 900,
                 property_taxes_actual=n * 1200, other_property_expenses=n * 100, management_fee_actual=n * 400,
                 total_operating_expenses=n * 12900 - noi, net_operating_income=noi)
        return dict(name=name, address=name + " St", year_built=1990, units=n, asking_price=ask, t12=t)
    props = [prop("Alpha", 20, 3_000_000, 150_000), prop("Beta", 10, 1_500_000, 80_000)]
    units = [dict(unit_number=f"{p['name']} · {i:03d}", unit_type="a1", sqft=800, market_rent=1100,
                  rent_charge=1050 if i % 10 else 0, occupied_flag=1 if i % 10 else 0)
             for p in props for i in range(p["units"])]
    t12 = {k: sum(p["t12"][k] for p in props) for k in props[0]["t12"]}
    return dict(property=dict(name="Two", address="1 Main", units=30, year_built=1990),
                assumptions=dict(value_add_units=15), t12=t12,
                tax=dict(current_taxable_value=400000, current_millage_rate=30, non_ad_valorem_tax=300),
                rent_roll=dict(as_of_date="2026-10-01", official_units=30, units=units), properties=props,
                rent_comps=[], sale_comps=[])


cd = two_building_deal()
check("2 buildings make 3 mixes, singles first", [m for m in deal_combos.all_mixes(["Alpha", "Beta"])] == [["Alpha"], ["Beta"], ["Alpha", "Beta"]])
sub, ask, n = deal_combos.subset_deal(cd, ["Beta"])
check("a mix keeps only its own rent-roll units and recounts the official figures",
      n == 10 and sub["rent_roll"]["official_units"] == 10 and sub["rent_roll"]["official_occupied_units"] == 9
      and all(u["unit_number"].startswith("Beta · ") for u in sub["rent_roll"]["units"]), sub["rent_roll"]["official_units"])
check("a mix is priced at the sum of its buildings' asks", ask == 1_500_000 and sub["assumptions"]["purchase_price_override"] == 1_500_000, ask)
check("a mix's T12 is its own buildings' statements", sub["t12"]["net_operating_income"] == 80_000, sub["t12"]["net_operating_income"])
_pk = json.loads(json.dumps(cd))
_pk.setdefault("assumptions", {})["purchase_price_override"] = 3_900_000
_all = [p["name"] for p in _pk["properties"]]
check("the whole deal is priced at the broker's package price when there is one (Lakeview: $78M, not the $80M sum)",
      deal_combos.subset_deal(_pk, _all)[1] == 3_900_000 and deal_combos.subset_deal(_pk, _all[:1])[1] != 3_900_000)
check("taxable value and value-add units are split by T12 tax / unit share",
      abs(sub["tax"]["current_taxable_value"] - 400000 / 3) < 1 and sub["assumptions"]["value_add_units"] == 5, (sub["tax"], sub["assumptions"]))
check("the original deal is not changed by building a mix", len(cd["rent_roll"]["units"]) == 30 and cd["t12"]["net_operating_income"] == 230_000)
both, ask2, _ = deal_combos.subset_deal(cd, ["Alpha", "Beta"])
check("all buildings together ask the sum of every ask", ask2 == 4_500_000 and both["rent_roll"]["official_units"] == 30, ask2)
tmpc = tempfile.mkdtemp()
try:
    shutil.copy(os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"), os.path.join(tmpc, "t.xlsx"))
    gen = os.path.join(tmpc, "model.xlsx")
    import generator  # noqa: E402
    with open(os.path.join(tmpc, "d.json"), "w", encoding="utf-8") as f:
        json.dump(cd, f)
    _, gwarn = generator.generate(os.path.join(tmpc, "d.json"), gen, os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))
    gi = load_workbook(gen)["Inputs"]
    check("a deal whose buildings all carry an ask is priced at the sum of the asks, not NOI / cap",
          gi["B6"].value == 4_500_000 and any("broker's ask" in w for w in gwarn), (gi["B6"].value, gwarn))
    check("its one-time misc expense is per unit (30 units x $250), not $100,000", gi["B37"].value == 7500, gi["B37"].value)
    pb = load_workbook(gen)
    pb["Inputs"]["B6"] = 0
    check("a portfolio model already on the disk at NOI / cap is repriced at its asks on repair",
          model_fixes.price_from_ask(pb) and pb["Inputs"]["B6"].value == 4_500_000, pb["Inputs"]["B6"].value)
    dbl = json.loads(json.dumps(cd))
    t = dbl["t12"]
    t["controllable_expenses"] += t["utilities"]          # a T12 whose controllable total already holds utilities (Pinecrest)
    t["total_operating_expenses"] = sum(t[k] for k in ("controllable_expenses", "insurance", "property_taxes_actual",
                                                      "other_property_expenses", "management_fee_actual"))
    with open(os.path.join(tmpc, "dbl.json"), "w", encoding="utf-8") as f:
        json.dump(dbl, f)
    _, dwarn = generator.generate(os.path.join(tmpc, "dbl.json"), os.path.join(tmpc, "dbl.xlsx"), os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))
    check("utilities already inside a T12's controllable total are counted once, and the run says so",
          any("already included utilities" in w for w in dwarn), dwarn)
    _, nwarn = generator.generate(os.path.join(tmpc, "d.json"), os.path.join(tmpc, "n.xlsx"), os.path.join(UW, "Underwriting Model TEMPLATE.xlsx"))
    check("...and a T12 that lists them separately is left alone", not any("already included utilities" in w for w in nwarn), nwarn)
    made, warns = deal_combos.add_to_model(cd, gen)
    check("every mix is underwritten (3 of 3, no warnings)", made == 3 and not warns, (made, warns))
    ws = load_workbook(gen)["Deal Combinations"]
    rows = [[c.value for c in r] for r in ws.iter_rows(min_row=5, max_row=7)]
    check("the tab lists each mix once, ranked 1..3", sorted(r[0] for r in rows) == [1, 2, 3] and {r[1] for r in rows} == {"Alpha", "Beta", "Alpha + Beta"}, rows)
    check("each mix shows units, ask, T12 NOI and a max price (or says none is achievable)", all(isinstance(r[2], int) and r[3] and r[5] and (isinstance(r[12], (int, float)) or r[12] == "not achievable") for r in rows), rows)
    check("the best-ranked row is the one with the smallest discount needed",
          min(rows, key=lambda r: r[0])[14] == min(r[14] for r in rows), rows)
    import openpyxl as _ox
    check("the main model's other tabs are untouched (Dashboard still present)", "Dashboard" in _ox.load_workbook(gen).sheetnames)
finally:
    shutil.rmtree(tmpc, ignore_errors=True)

print("\nOur bid and the levers (levers.py)")
import levers  # noqa: E402
from openpyxl import Workbook  # noqa: E402


def lever_model(path, model_irr=None):
    """A 5-year, 100-unit model with baked values only, laid out as the template lays them out."""
    wb = Workbook()
    wb.remove(wb.active)
    i = wb.create_sheet("Inputs")
    for r, (lab, v) in enumerate([("Units", 100), ("Purchase Cap Rate", 0.055), ("LTV", 0.7), ("Loan Interest Rate", 0.06),
                                  ("Hold Period (years)", 5), ("Exit Cap Rate", 0.055), ("Disposition / Closing Cost at Exit", 0.05),
                                  ("Closing Cost", 0.03), ("Income Growth", 0.03), ("Expense Growth", 0.03), ("Tax Growth", 0.03),
                                  ("Management Fee % of EGI", 0.03), ("Asset Management Fee % of EGI", 0.02),
                                  ("Amortization Period (yrs, 0=Interest-Only)", 0), ("IRR Target", 0.16)], start=13):
        i.cell(r, 1, lab), i.cell(r, 2, v)
    pf = wb.create_sheet("Pro Forma")
    pf.cell(5, 1, "Line Item"), pf.cell(5, 2, "T12 / Source")
    egi = [2_000_000 * 1.03 ** k for k in range(5)]
    noi = [1_000_000 * 1.03 ** k for k in range(5)]
    pf.cell(15, 1, "Effective Gross Income"), pf.cell(30, 1, "Net Operating Income")
    for k in range(5):
        pf.cell(5, 4 + k, f"Year {k + 1}"), pf.cell(15, 4 + k, egi[k]), pf.cell(30, 4 + k, noi[k])
    price = 1_000_000 / 0.055
    de = wb.create_sheet("Debt & Exit")
    de["A6"], de["B6"], de["A10"], de["B10"] = "Purchase Price", price, "Total Capex", 500_000
    loan = price * 0.7
    cfs = [-(price - loan + 500_000 + price * 0.03)] + [noi[k] - loan * 0.06 - egi[k] * 0.02 for k in range(5)]
    cfs[-1] += noi[4] / 0.055 * 0.95 - loan
    de["A25"], de["B25"] = "Levered IRR", levers.irr(cfs) if model_irr is None else model_irr
    tx = wb.create_sheet("Tax")      # Florida-style: re-set to the price at 18 mills
    tx["B8"], tx["B9"], tx["B10"], tx["B13"], tx["B19"] = 9_000_000, 18.0, 0, 162_000, 1
    wb.create_sheet("T12 Actuals")["B23"] = 1_000_000
    wb.save(path)
    return levers.irr(cfs)


tmpl = tempfile.mkdtemp()
try:
    p = os.path.join(tmpl, "m.xlsx")
    base = lever_model(p)
    lv = levers.levers(p)
    check("the rebuilt cash flows tie to the model's own IRR", "error" not in lv and abs(lv["irr"] - base) < 1e-6, lv)
    d = levers.Deal(p)
    check("our bid is the price that makes exactly the 16% target", abs(d.run(price=lv["bid"]["price"]) - 0.16) < 1e-4, lv["bid"])
    check("...below the price run, and its tax re-sets with it (a lower price pays less tax)",
          lv["bid"]["price"] < d.price and d.tax1(lv["bid"]["price"]) < d.tax1(d.price), (lv["bid"], d.tax1(d.price)))
    by = {x["key"]: x for x in lv["levers"]}
    check("every lever we control raises the IRR and the bid", all(by[k]["change"] > 0 and by[k]["bid"] > lv["bid"]["price"] for k in ("rate", "opex", "income")), by)
    check("borrowing less is shown at the price run only, never as a bid (it cuts both ways)", by["ltv"]["bid"] is None and "ltv" in by)
    check("...and 'together' leaves out the exit cap and the borrowing", lv["together"]["bid"] > max(by[k]["bid"] for k in ("rate", "opex", "income")), lv["together"])
    lever_model(p, model_irr=base + 0.01)
    check("a model whose IRR the rebuild cannot tie gets no levers, not wrong ones", "error" in levers.levers(p))
finally:
    shutil.rmtree(tmpl, ignore_errors=True)

print("\nThe no-API intake reader (intake_read.py)")
import intake_read  # noqa: E402
_ti = tempfile.mkdtemp()
try:
    _wb = Workbook(); _ws = _wb.active
    for _ in range(5):
        _ws.append([])
    _ws.append(["Account", "Jan", "Adjusted Total"])
    for r in (["4100 Total Gross Possible Rent", 0, 1000.0], ["4200 Total DEDUCTIONS", 0, -100.0], ["4300 Total OTHER INCOME", 0, 50.0],
              ["6100 Total ADMINISTRATION", 0, 80.0], ["6200 Total LEGAL / FINANCE & INSURANCE", 0, 120.0], ["6235 Property Insurance", 0, 100.0],
              ["7100 Total Property Taxes", 0, 150.0], ["NET OPERATING INCOME", 0, 600.0]):
        _ws.append(r)
    _x = os.path.join(_ti, "t12.xlsx"); _wb.save(_x)
    _m = {"column": "^Adjusted Total$", "lines": [["^4100 Total", "gross_potential_rent"], ["^4200 Total", "vacancy_concessions_bad_debt"],
          ["^4300 Total", "other_income"], ["^6100 Total", "general_admin"], ["^6200 Total", "general_admin"],
          ["^6235 Property Insurance", "insurance"], ["^6235 Property Insurance", "-general_admin"], ["^7100 Total", "property_taxes_actual"]],
          "noi_label": "^NET OPERATING INCOME"}
    _mp = os.path.join(_ti, "map.json"); json.dump(_m, open(_mp, "w"))
    _r = intake_read.read_t12(_x, _mp)["data"]
    check("a T12 read with an account map ties to the statement's NOI, and a line inside a group total can be moved out of it",
          _r["net_operating_income"] == 600 and _r["insurance"] == 100 and _r["general_admin"] == 100, _r)
    _m["lines"].pop()
    json.dump(_m, open(_mp, "w"))
    try:
        intake_read.read_t12(_x, _mp); _ok = False
    except ValueError as e:
        _ok = "statement says" in str(e)
    check("a map that misses a line is refused, naming the NOI gap, never guessed", _ok)
    _rw = Workbook(); _rs = _rw.active
    _rs.append(["Rent Roll"]); _rs.append([])
    _rs.append(["Unit", "Sqft", "Market Rent", "Rent", "Status"])
    for row in (["1-A", 900, 1000, 950, "Current"], ["1-B", 900, 1000, 1000, "Notice-Rented"], ["1-C", 900, 1000, 0, "Vacant-Unrented"], ["3 Units", None, 3000, 1950, "66.7% Occupied"]):
        _rs.append(row)
    _rx = os.path.join(_ti, "rr.xlsx"); _rw.save(_rx)
    _rm = os.path.join(_ti, "rrmap.json")
    json.dump({"columns": {"unit_number": "Unit", "sqft": "Sqft", "market_rent": "Market Rent", "rent_charge": "Rent", "status": "Status"},
               "occupied": ["Current", "Notice-Rented"], "skip_units_matching": "units?$"}, open(_rm, "w"))
    _rr = intake_read.read_rr(_rx, _rm)["data"]
    check("a rent roll read with a column map: units counted, notice-rented is occupied, the summary row is not a unit",
          len(_rr["units"]) == 3 and _rr["official_occupied_units"] == 2 and _rr["units"][2]["rent_charge"] == 0, _rr)
    _mx = os.path.join(_ti, "m.xlsx"); lever_model(_mx)
    json.dump({"sources": []}, open(_mp, "w"))
    intake_read.stamp(_mx, _mp)
    check("the stamp writes a hidden Provenance tab the card reader can find", load_workbook(_mx)["Provenance"].sheet_state == "hidden")
finally:
    shutil.rmtree(_ti, ignore_errors=True)

folder = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("UNDERWRITING_DIR")
if folder and os.path.isdir(folder):
    print("\nModels in " + folder)
    for f in sorted(os.listdir(folder)):
        if not f.lower().endswith(".xlsx") or f.startswith("~$") or "TEMPLATE" in f:
            continue
        p = os.path.join(folder, f)
        try:
            n = uncomputed_formulas(p, load_workbook(p, data_only=True))
        except Exception as e:
            check(f + " opens", False, e)
            continue
        check(f + ": no formula without a value", n == 0, f"{n} formula cells have no saved value")
else:
    print("\n(no model folder given: the on-disk scan was skipped)")

print("\nAll Excel-model checks passed." if not failed else f"\n{failed} check(s) FAILED")
sys.exit(1 if failed else 0)
