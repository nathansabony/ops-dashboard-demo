"""
Finished underwriting model(s) -> the numbers a past-deal card promotes.

The owner, 2026-10-21: the Underwriting tab shows "the past deals that were run and
the numbers that we found based on the property", with the Excel model attached.
Those numbers already sit in every model the generator wrote: finish_model.py
bakes the computed values into the saved workbook, so the Dashboard tab reads
back without Excel. This reads them back; nothing is recalculated here.

    python deal_card.py <model.xlsx> [<model2.xlsx> ...]

Emits JSON {"cards": {"<path>": {...}}} - one entry per file. A file that is not
a house underwriting model (no Dashboard/Inputs tab) gets {"error": "..."}
instead, so importing a random workbook is refused, not silently shown.
A model that was never computed (no baked values) comes back computed=false;
the card then says so rather than showing zeros.
"""
import json
import re
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
warnings.filterwarnings("ignore")

_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

from openpyxl import load_workbook
from levers import exact_bid

# finish_model.grab_facts is the one place that knows where the Dashboard's
# fast-fact strips and scenario table live (it finds the scenario table by its
# header, because the 8-year rebuild moved it). Reuse it, don't copy it.
from finish_model import grab_facts


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def named_cell(wb, name):
    """Value of a one-cell defined name, or None."""
    try:
        dn = wb.defined_names[name]
        dest = next(iter(dn.destinations))
        sheet, ref = dest
        return wb[sheet][ref.replace("$", "")].value
    except Exception:
        return None


# A unit whose "resident" is Down, Model, Office, Employee... is not a vacant unit that could lease: it earns nothing and
# is not in the market. Pinecrest Village (2026-10-22): 359 of 996 units, so its occupancy of 39.8% is 62.2% of the units that can
# actually rent. The card and the report show both rather than letting the smaller one stand alone.
NON_REVENUE_NAME = re.compile(r"^(down|model|office|admin|employee|non[\s-]?rev|storage|maint|guest|corporate)", re.I)


def non_revenue_units(wb):
    try:
        ws = wb["Rent Roll"]
        hdr = next(r for r in range(14, 40) if str(ws.cell(r, 1).value or "").strip().lower() == "unit")
        name_col = next(c for c in range(2, 12) if "name" in str(ws.cell(hdr, c).value or "").lower())
        return sum(1 for r in range(hdr + 1, ws.max_row + 1)
                   if ws.cell(r, 1).value and NON_REVENUE_NAME.match(str(ws.cell(r, name_col).value or "").strip()))
    except Exception:
        return None


def uncomputed_formulas(path, wb_values):
    """Formula cells whose value was never saved with the file (a model written by openpyxl and never opened in Excel
    shows nothing in them until someone recalculates). Returns how many, so the board can say a model is not finished."""
    try:
        wb_f = load_workbook(path, data_only=False)
        n = 0
        for ws in wb_f.worksheets:
            if ws.title not in wb_values.sheetnames:
                continue
            wv = wb_values[ws.title]
            for row in ws.iter_rows():
                for c in row:
                    if isinstance(c.value, str) and c.value.startswith("=") and wv[c.coordinate].value is None:
                        n += 1
        return n
    except Exception:
        return None


def card_for(path):
    wb = load_workbook(path, data_only=True)
    if "Dashboard" not in wb.sheetnames or "Inputs" not in wb.sheetnames:
        return {"error": "Not a house underwriting model (no Dashboard / Inputs tab)."}
    def get(sheet, row, col):
        return wb[sheet].cell(row, col).value
    facts = grab_facts(get)
    by_label = {}
    for strip in (facts.get("strip1") or []) + (facts.get("strip2") or []):
        by_label[strip["label"].upper()] = strip["value"]
    # the third strip (returns) is not in grab_facts: labels in row 11, values row 10
    for c in range(1, 7):
        label, value = get("Dashboard", 11, c), get("Dashboard", 10, c)
        if label:
            by_label[str(label).upper()] = value

    def pick(prefix):
        for k, v in by_label.items():
            if k.startswith(prefix):
                return v
        return None

    irr_target = num(named_cell(wb, "IrrTarget"))
    year_built = pick("YEAR BUILT")
    price = num(pick("PURCHASE PRICE"))
    card = {
        "computed": bool(facts.get("computed")) and price is not None,
        "name": str(get("Inputs", 9, 2) or facts.get("property") or "").strip(),
        "address": str(get("Inputs", 10, 2) or "").strip(),
        "year_built": year_built if isinstance(year_built, (int, float)) else (str(year_built) if year_built else None),
        "units": num(pick("UNITS")),
        "occupancy": num(pick("OCCUPANCY")),
        "avg_rent": num(pick("AVG RENT")),
        "price": price,
        "price_per_door": num(pick("PRICE PER DOOR")),
        "t12_noi": num(pick("T12 NOI")),
        "year1_noi": num(pick("YEAR 1 NOI")),
        "capex": num(pick("TOTAL CAPEX")),
        "max_price": num(pick("MAX PRICE")),
        "irr": num(pick("LEVERED IRR")),
        # the IRR tile of the earlier template shows the text "NM" when the model could not solve one (Summit Heights,
        # equity multiple -0.45x); the current template shows 0%. Either way the equity was not recovered.
        "irr_failed": False,
        "equity_multiple": num(pick("EQUITY MULTIPLE")),
        "dscr": num(pick("YEAR 1 DSCR")),
        "coc": num(pick("YR2 CASH-ON-CASH")),      # The owner 2026-10-22: rank on IRR, then cash-on-cash
        "irr_target": irr_target,
        "hold_years": num(named_cell(wb, "HoldPeriodYears")),
        "scenarios": facts.get("scenarios") or [],
        "checks": facts.get("checks") or {},
    }
    irr_raw = pick("LEVERED IRR")
    em = card["equity_multiple"]
    card["irr_failed"] = bool((isinstance(irr_raw, str) and irr_raw.strip().upper() in ("NM", "N/M", "N/A", "#NUM!", "#DIV/0!", "#VALUE!"))
                              or (card["irr"] == 0 and em is not None and abs(em - 1) > 1e-9))
    card["non_revenue_units"] = non_revenue_units(wb)
    card["uncomputed_formulas"] = uncomputed_formulas(path, wb)
    m = re.search(r"LEVERED IRR \(SALE YR(\d+)\)", next((k for k in by_label if k.startswith("LEVERED IRR")), ""))
    if m and card["hold_years"] is None:
        card["hold_years"] = int(m.group(1))
    # where the price came from (2026-10-31): a typed price / broker ask in the override cell, else T12 NOI / cap rate
    override = num(get("Inputs", 6, 2))
    card["price_from_ask"] = bool(override and override > 0)
    card["purchase_cap"] = num(named_cell(wb, "PurchaseCapRate"))
    card["buildings"] = buildings(wb)
    card["combos"] = combos(wb)
    # our bid (2026-11-01): solved exactly on the model's own cash flows, as the PDF prints it; the workbook's solver
    # interpolates between cap-rate columns (about $0.1M off). Kept only when the rebuild ties to the model's IRR.
    # how the files were read, when the model came from the no-API intake (scripts/underwriteLocal.js stamps a hidden tab)
    try:
        if "Provenance" in wb.sheetnames:
            card["provenance"] = json.loads(wb["Provenance"]["A2"].value)
    except Exception:
        pass
    # a lease-up (2026-11-02): the model carries its own occupancy ramp on Inputs, so a 40%-occupied building is underwritten
    # as what it will become, not mistaken for an in-place deal
    try:
        ws = wb["Inputs"]
        lu = {}
        for r in range(50, 75):
            lab = str(ws.cell(r, 1).value or "").strip().lower()
            if lab.startswith("lease-up: starting occupancy"): lu["start"] = num(ws.cell(r, 2).value)
            elif lab.startswith("lease-up: stabilized occupancy"): lu["target"] = num(ws.cell(r, 2).value)
            elif lab.startswith("lease-up: months to stabilize"): lu["months"] = num(ws.cell(r, 2).value)
        if len(lu) == 3 and None not in lu.values():
            card["lease_up"] = lu
            card["price_from_ask"] = False     # the typed price is the OM-implied one, our inference, not an ask
    except Exception:
        pass
    card["max_price_solver"] = card["max_price"]
    bid = exact_bid(wb)
    if bid is not None:
        card["max_price"] = bid
    return card


# A deal of several buildings (2026-10-30, the owner: "when I open it ... show that it's 3 properties and break it down"):
# one row per building from the model's Portfolio Breakdown tab, read by its row labels.
BUILDING_ROWS = {
    "address": "Address", "year_built": "Year built", "units": "Units", "occupancy": "Occupancy",
    "avg_rent": "Avg in-place rent / occupied unit", "egi": "Effective Gross Income (EGI)",
    "t12_noi": "Net Operating Income (NOI)", "noi_per_unit": "NOI / unit", "expense_ratio": "Expense ratio (OpEx / EGI)",
    "ask": "Asking price (broker)", "ask_per_unit": "Asking price / unit", "cap_at_ask": "Going-in cap at ask (T12 NOI)",
    "max_price": "Max price at the IRR target, split by NOI share",
}


def buildings(wb):
    if "Portfolio Breakdown" not in wb.sheetnames:
        return []
    ws = wb["Portfolio Breakdown"]
    head = next((r for r in range(1, 12) if ws.cell(r, 1).value == "Metric"), None)
    if not head:
        return []
    cols = []
    for c in range(2, ws.max_column + 1):
        v = ws.cell(head, c).value
        if not v or str(v).startswith("Portfolio Total"):
            break
        cols.append((c, str(v).strip()))
    rows = {str(ws.cell(r, 1).value).strip(): r for r in range(head + 1, ws.max_row + 1) if ws.cell(r, 1).value}
    out = []
    for c, name in cols:
        b = {"name": name}
        for key, label in BUILDING_ROWS.items():
            v = ws.cell(rows[label], c).value if label in rows else None
            b[key] = (str(v).strip() if v not in (None, "—") else None) if key == "address" else num(v) if key != "year_built" else (v if isinstance(v, (int, float)) else None)
        out.append(b)
    return out if len(out) >= 2 else []


# Every mix of the buildings, as the Deal Combinations tab ranked them.
def combos(wb):
    if "Deal Combinations" not in wb.sheetnames:
        return []
    ws = wb["Deal Combinations"]
    head = next((r for r in range(1, 10) if ws.cell(r, 1).value == "Rank"), None)
    if not head:
        return []
    labels = {str(ws.cell(head, c).value).strip(): c for c in range(1, ws.max_column + 1) if ws.cell(head, c).value}
    want = {"rank": "Rank", "mix": "Mix", "units": "Units", "ask": "Broker ask", "t12_noi": "T12 NOI", "year1_noi": "Year 1 NOI",
            "cap_at_ask": "Cap rate at ask (T12)", "irr": "IRR at ask", "max_price": None, "discount": "Discount needed from ask"}
    max_col = next((c for l, c in labels.items() if l.startswith("Max price @") and "/ unit" not in l), None)
    out = []
    for r in range(head + 1, ws.max_row + 1):
        mix = ws.cell(r, labels.get("Mix", 2)).value
        if not mix or not isinstance(ws.cell(r, 1).value, (int, float)):
            continue
        row = {}
        for key, label in want.items():
            c = max_col if key == "max_price" else labels.get(label)
            v = ws.cell(r, c).value if c else None
            row[key] = str(mix).strip() if key == "mix" else num(v)
        out.append(row)
    return out


def main(paths):
    cards = {}
    for p in paths:
        try:
            cards[p] = card_for(p)
        except Exception as e:
            cards[p] = {"error": f"Could not read this workbook: {e}"}
    _REAL_STDOUT.write(json.dumps({"cards": cards}, default=str) + "\n")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        _REAL_STDOUT.write(json.dumps({"error": "Usage: python deal_card.py <model.xlsx> ..."}) + "\n")
        sys.exit(1)
    main(sys.argv[1:])
