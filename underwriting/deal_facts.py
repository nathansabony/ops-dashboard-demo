"""
Finished underwriting model -> every fact the PDF report prints, as JSON.

The owner, 2026-10-22: every deal gets a PDF report next to its Excel model, so the
numbers can be read without opening the workbook - for new deals and for the
older ones. The older models were written before the 8-year rebuild and carry
different rows, so nothing here reads a fixed cell: each table is found by its
row label, and a section that cannot be read is named in "gaps" instead of being
guessed or silently dropped. The report prints those gaps.

    python deal_facts.py <model.xlsx>

Reads the values finish_model.py baked into the workbook (the same ones the
board's card reads); nothing is recalculated here.

Emits JSON: {"card": {...deal_card fields...}, "property": {...}, "inputs": [...],
"t12": {...}, "rent_roll": {...}, "unit_mix": [...], "pro_forma": {...},
"returns": {...}, "scenarios": [...], "solver": {...}, "tax": {...},
"checks": {...}, "gaps": [...]}
"""
import json
import re
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).parent))

_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

from openpyxl import load_workbook
from deal_card import card_for


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def txt(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def find_row(ws, label, col=1, start=1, end=None, exact=False):
    """First row whose column `col` starts with (or equals) `label`, case-insensitive."""
    want = label.lower()
    for r in range(start, (end or ws.max_row) + 1):
        v = ws.cell(r, col).value
        if v is None:
            continue
        s = str(v).strip().lower()
        if (s == want) if exact else s.startswith(want):
            return r
    return None


def labelled(ws, start, end, value_col=2, note_col=3):
    out = []
    for r in range(start, end + 1):
        label = txt(ws.cell(r, 1).value)
        if not label:
            continue
        out.append({"label": label, "value": ws.cell(r, value_col).value, "note": txt(ws.cell(r, note_col).value)})
    return out


def read(path):
    wb = load_workbook(path, data_only=True)
    gaps = []
    facts = {"card": card_for(path), "gaps": gaps}
    names = wb.sheetnames

    def section(name, fn):
        try:
            facts[name] = fn()
        except Exception as e:  # a layout this reader does not know: say so, never guess
            facts[name] = None
            gaps.append(f"{name.replace('_', ' ')} could not be read from this model ({type(e).__name__}).")

    # ---- property + assumptions (Inputs) ----
    def inputs():
        ws = wb["Inputs"]
        return labelled(ws, 6, min(ws.max_row, 90))
    section("inputs", inputs)

    def prop():
        ws = wb["Inputs"]
        def v(label):
            r = find_row(ws, label, exact=True)
            return ws.cell(r, 2).value if r else None
        return {"name": txt(v("Property Name")), "address": txt(v("Address")), "year_built": v("Year Built"),
                "site_acres": num(v("Site Acres")), "units": num(v("Units"))}
    section("property", prop)

    # ---- T12 summary (T12 Actuals) ----
    def t12():
        ws = wb["T12 Actuals"]
        top = find_row(ws, "Line", exact=True, end=12) or 5
        raw = find_row(ws, "Source Row", end=ws.max_row) or find_row(ws, "Raw monthly account", end=ws.max_row)
        end = (raw or ws.max_row + 1) - 1
        lines = [{"label": txt(ws.cell(r, 1).value), "amount": ws.cell(r, 2).value, "note": txt(ws.cell(r, 3).value)}
                 for r in range(top + 1, end + 1) if txt(ws.cell(r, 1).value) and ws.cell(r, 2).value is not None
                 and not str(ws.cell(r, 1).value).lower().startswith("raw monthly")]
        months = []
        if raw:
            for c in range(4, ws.max_column + 1):
                h = txt(ws.cell(raw, c).value)
                if not h or h.lower() in ("total", "category"):
                    break
                months.append(h)
        return {"lines": lines, "months": months,
                "kpis": {"noi": num(ws["A2"].value), "egi": num(ws["B2"].value), "opex": num(ws["C2"].value), "margin": num(ws["D2"].value)}}
    section("t12", t12)

    # ---- rent roll summary + unit mix ----
    def rent_roll():
        ws = wb["Rent Roll"]
        out = {}
        for r in range(5, 24):
            k, v = txt(ws.cell(r, 1).value), ws.cell(r, 2).value
            if k and v is not None and k.lower() != "metric":
                out[k] = v
        return {"metrics": out, "kpis": {"occupancy": num(ws["A2"].value), "adj_avg_rent": num(ws["B2"].value),
                                         "vacant": num(ws["C2"].value), "loss_to_lease_mo": num(ws["D2"].value)}}
    section("rent_roll", rent_roll)

    def unit_mix():
        ws = wb["Unit Mix"]
        hdr = find_row(ws, "Unit Type", exact=True, end=12) or 5
        rows = []
        for r in range(hdr + 1, ws.max_row + 1):
            if ws.cell(r, 2).value is None and ws.cell(r, 1).value is None:
                continue
            u = num(ws.cell(r, 2).value)
            if u is None:
                continue
            rows.append({"type": txt(ws.cell(r, 1).value), "units": u, "occupied": num(ws.cell(r, 3).value),
                         "vacant": num(ws.cell(r, 4).value), "avg_sf": num(ws.cell(r, 5).value),
                         "avg_market": num(ws.cell(r, 6).value), "avg_inplace": num(ws.cell(r, 7).value)})
        return rows
    section("unit_mix", unit_mix)

    # ---- pro forma by year ----
    def pro_forma():
        ws = wb["Pro Forma"]
        hdr = find_row(ws, "Line Item", exact=True, end=12) or 5
        cols = {}
        for c in range(2, ws.max_column + 1):
            m = re.match(r"^\s*year\s*(\d+)\s*$", str(ws.cell(hdr, c).value or ""), re.I)
            if m:
                cols[int(m.group(1))] = c
        def row(label):
            r = find_row(ws, label, start=hdr + 1)
            return {y: num(ws.cell(r, c).value) for y, c in cols.items()} if r else {}
        return {"years": sorted(cols), "egi": row("Effective Gross Income"), "opex": row("Total Operating Expenses"),
                "noi": row("Net Operating Income"), "debt_service": row("Annual Mortgage Payment"),
                "after_debt": row("Net Income After Debt Service"), "coc": row("Cash-on-Cash Return %"),
                "gpr": row("Adjusted Gross Potential Rent")}
    section("pro_forma", pro_forma)

    # ---- debt, exit, returns ----
    def returns():
        ws = wb["Debt & Exit"]
        want = ["Purchase Price", "Price Per Unit", "Loan Amount", "Equity Before Capex", "Total Capex", "Upfront Acquisition Closing Cost",
                "Initial Equity Required", "Gross Exit Value", "Disposition Cost at Exit", "Loan Payoff", "Net Sale Proceeds", "Annual Debt Service"]
        out = {}
        for w in want:
            r = find_row(ws, w, start=5, end=40)
            if r:
                out[w] = ws.cell(r, 2).value
        return out
    section("returns", returns)

    def scenarios():
        ws = wb["Exit Scenarios"]
        hdr = find_row(ws, "Metric", exact=True, end=12) or 5
        cols = [c for c in range(2, ws.max_column + 1) if txt(ws.cell(hdr, c).value)]
        def row(label):
            r = find_row(ws, label, start=hdr + 1, end=hdr + 30)
            return [ws.cell(r, c).value for c in cols] if r else [None] * len(cols)
        irr, em, coc = row("Levered IRR"), row("Equity Multiple"), row("Year 2 Cash-on-Cash")
        hold, sale = row("Hold Period"), row("Gross Sale Value")
        return [{"scenario": txt(ws.cell(hdr, c).value), "irr": num(irr[i]), "equity_multiple": num(em[i]), "coc": num(coc[i]),
                 "hold": num(hold[i]), "sale_value": num(sale[i])} for i, c in enumerate(cols)]
    section("scenarios", scenarios)

    def solver():
        ws = wb["Max Price Solver"]
        return {"max_price": num(ws["A2"].value), "per_unit": num(ws["B2"].value), "discount": num(ws["C2"].value), "ask": num(ws["D2"].value)}
    section("solver", solver)

    def tax():
        ws = wb["Tax"]
        out = {"current": num(ws["A2"].value), "after_sale": num(ws["B2"].value), "increase": num(ws["C2"].value)}
        for label, key in (("Current Millage Rate", "millage"), ("County PIN", "pin"), ("Reassessment on Sale", "reassess"), ("Tax Rule Note", "rule")):
            r = find_row(ws, label, start=5, end=40)
            if r:
                out[key] = ws.cell(r, 2).value
        return out
    section("tax", tax)

    def checks():
        ws = wb["Checks"]
        hdr = find_row(ws, "Check", exact=True, end=10) or 5
        items = []
        for r in range(hdr + 1, ws.max_row + 1):
            name, res = txt(ws.cell(r, 1).value), txt(ws.cell(r, 2).value)
            if name and res:
                items.append({"check": name, "result": res, "severity": txt(ws.cell(r, 3).value), "note": txt(ws.cell(r, 4).value)})
        return {"items": items, "counts": {"ok": num(ws["A2"].value), "needs_input": num(ws["B2"].value), "warn": num(ws["C2"].value), "review": num(ws["D2"].value)}}
    section("checks", checks)

    def comps():
        out = {}
        for sheet in ("Rent Comps", "Sale Comps"):
            if sheet in names:
                ws = wb[sheet]
                n = 0
                for r in range(1, ws.max_row + 1):
                    v = ws.cell(r, 1).value
                    if v and r > 8 and not re.match(r"^(total|average|avg|notes?|source)", str(v), re.I):
                        n += 1
                out[sheet] = n
        return out
    section("comps", comps)

    return facts


if __name__ == "__main__":
    if len(sys.argv) != 2:
        _REAL_STDOUT.write(json.dumps({"error": "Usage: python deal_facts.py <model.xlsx>"}) + "\n")
        sys.exit(1)
    try:
        out = read(sys.argv[1])
        if out["card"].get("error"):
            out = {"error": out["card"]["error"]}
    except Exception as e:
        out = {"error": f"Could not read this model: {e}"}
    _REAL_STDOUT.write(json.dumps(out, default=str) + "\n")
