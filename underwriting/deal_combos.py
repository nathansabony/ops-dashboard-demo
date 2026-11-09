"""
Deal Combinations tab, for a deal made of several buildings.

2026-10-30 (Lakeview, 3 buildings): the model underwrites the portfolio as one
deal, and at the broker's ask it does not work. The useful question is whether a
smaller piece does: each building alone, each pair, and all of them. Every mix
goes through the full model (generator.py then finish_model.py in a temp folder),
priced at the sum of the broker's per-building asks, and the results land on one
tab ranked by how close the ask is to what the model supports.

Usage: python deal_combos.py <deal.json> <model.xlsx>
    Adds the "Deal Combinations" tab to <model.xlsx> (run BEFORE finish_model on it).
    Prints {"combos": n, "warnings": [...]} as JSON.
"""
import copy
import itertools
import json
import os
import shutil
import sys
import tempfile
import warnings as _warnings

_warnings.filterwarnings("ignore")
# generator / finish_model point sys.stdout at stderr when imported (so library chatter never corrupts their JSON);
# keep the real stdout for this script's own result - without it the Generate route never saw the mix count
# and reported "Deal Combinations tab skipped" for a tab that was written (found 2026-11-01)
_REAL_STDOUT = sys.stdout

from openpyxl import load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

SEP = " · "
IRR_TARGET_DEFAULT = 0.16
# T12 lines that are plain dollars and add across buildings
T12_SUM_SKIP = {"month_headers", "raw_monthly_detail"}


def _props(deal):
    return [p for p in (deal.get("properties") or []) if p and p.get("name")]


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def mix_label(names):
    return " + ".join(names)


def all_mixes(names):
    """Every non-empty subset, singles first, then pairs, then the whole deal."""
    out = []
    for k in range(1, len(names) + 1):
        out.extend(itertools.combinations(names, k))
    return [list(m) for m in out]


def subset_deal(deal, names):
    """The deal restricted to the named buildings, ready for generator.py.

    Rent-roll units are picked by their "<property> · " label prefix and the
    official counts recomputed from them; the T12 is the sum of each building's
    own statement; the county taxable value is split by each building's share of
    T12 tax and the value-add units by unit share.
    """
    props = _props(deal)
    keep = [p for p in props if p["name"] in names]
    if not keep:
        raise ValueError("no matching properties: " + ", ".join(names))
    d = copy.deepcopy(deal)
    d["properties"] = copy.deepcopy(keep)

    prefixes = tuple(p["name"] + SEP for p in keep)
    units = [u for u in (deal.get("rent_roll") or {}).get("units") or []
             if str(u.get("unit_number", "")).startswith(prefixes)]
    if not units:
        raise ValueError("no rent-roll units for " + mix_label(names))
    occ = sum(1 for u in units if int(u.get("occupied_flag") or 0) == 1)
    rr = d["rent_roll"]
    rr["units"] = units
    rr["official_units"] = len(units)
    rr["official_occupied_units"] = occ
    rr["official_vacant_units"] = len(units) - occ
    rr["official_occupancy"] = occ / len(units)

    # T12: sum the buildings' own statements; where one building lacks a line the
    # whole line is dropped rather than understated.
    t12 = {}
    fields = {k for p in keep for k in (p.get("t12") or {}) if k not in T12_SUM_SKIP}
    for k in fields:
        vals = [_num((p.get("t12") or {}).get(k)) for p in keep]
        if all(v is not None for v in vals):
            t12[k] = sum(vals)
    if "net_operating_income" not in t12:
        raise ValueError("a building in " + mix_label(names) + " has no T12 NOI")
    d["t12"] = t12                       # raw monthly detail dropped: it belongs to the whole deal

    # shares of the deal-level figures that cannot be read per building
    def share_by(getter):
        tot = sum((_num(getter(p)) or 0) for p in props)
        mine = sum((_num(getter(p)) or 0) for p in keep)
        return mine / tot if tot > 0 else None
    tax_share = share_by(lambda p: (p.get("t12") or {}).get("property_taxes_actual"))
    unit_share = share_by(lambda p: p.get("units")) or len(units) / max(1, len((deal.get("rent_roll") or {}).get("units") or []))
    tax = d.setdefault("tax", {})
    if _num(tax.get("current_taxable_value")) and tax_share is not None:
        tax["current_taxable_value"] = tax["current_taxable_value"] * tax_share
    if _num(tax.get("non_ad_valorem_tax")):
        tax["non_ad_valorem_tax"] = tax["non_ad_valorem_tax"] * (tax_share if tax_share is not None else unit_share)
    if _num(tax.get("t12_property_tax_expense")):
        tax["t12_property_tax_expense"] = t12.get("property_taxes_actual", tax["t12_property_tax_expense"] * unit_share)
    a = d.setdefault("assumptions", {})
    if _num(a.get("value_add_units")):
        a["value_add_units"] = int(round(a["value_add_units"] * unit_share))
    # units renovated per month scales with the building count so the pace is per-unit comparable
    if _num(a.get("units_renovated_per_month")):
        a["units_renovated_per_month"] = max(1, int(round(a["units_renovated_per_month"] * unit_share)))

    asks = [_num(p.get("asking_price")) for p in keep]
    ask = sum(asks) if all(x is not None and x > 0 for x in asks) else None
    # the whole deal at the package price when the broker quotes one (Lakeview: $78M for all three, $80M separately)
    package = _num((deal.get("assumptions") or {}).get("purchase_price_override"))
    if len(keep) == len(props) and package and package > 0:
        ask = package
    if ask:
        a["purchase_price_override"] = ask
    d["property"] = dict(d.get("property") or {})
    d["property"]["name"] = mix_label(names)
    d["property"]["units"] = len(units)
    return d, ask, len(units)


def _find(get_rows, label):
    """Value next to a label in the Dashboard (row above for the tile strips)."""
    label = label.upper()
    for r, c, v in get_rows:
        if isinstance(v, str) and v.strip().upper() == label:
            return r, c
    return None


def read_results(path, hold_years):
    wb = load_workbook(path, data_only=True)
    dash = wb["Dashboard"]
    cells = [(c.row, c.column, c.value) for row in dash.iter_rows(min_row=1, max_row=60) for c in row if c.value is not None]
    out = {}

    def tile(label):
        pos = _find(cells, label)
        return dash.cell(pos[0] - 1, pos[1]).value if pos else None
    out["t12_noi"] = tile("T12 NOI")
    out["year1_noi"] = tile("YEAR 1 NOI")
    out["price"] = tile("PURCHASE PRICE")
    out["occupancy"] = tile("OCCUPANCY")
    out["coc2"] = tile("YR2 CASH-ON-CASH")
    out["dscr"] = tile("YEAR 1 DSCR")
    # IRR for the hold: the "Sale Year N" row of the scenarios table, else the 8-year sale
    irr = None
    for want in (f"Sale Year {hold_years}", "Sale Year 8"):
        for r, c, v in cells:
            if c == 1 and isinstance(v, str) and v.strip().lower() == want.lower():
                x = dash.cell(r, 2).value
                if isinstance(x, (int, float)):
                    irr = x
                    break
        if irr is not None:
            break
    out["irr"] = irr
    # our bid, solved exactly on the mix's own cash flows (levers.py), as the main model's card and report state it;
    # the solver's interpolated price where the rebuild cannot tie
    from levers import exact_bid
    bid = exact_bid(wb)
    out["max_price"] = bid if bid is not None else wb["Max Price Solver"]["B42"].value
    if not isinstance(out["max_price"], (int, float)):
        out["max_price"] = None
    for k in ("coc2", "dscr"):
        if not isinstance(out[k], (int, float)):
            out[k] = None
    return out


def run_mix(deal, names, work):
    import generator
    import finish_model
    sub, ask, n_units = subset_deal(deal, names)
    tag = "mix" + str(len(os.listdir(work)))
    dpath = os.path.join(work, tag + ".json")
    xpath = os.path.join(work, tag + ".xlsx")
    with open(dpath, "w", encoding="utf-8") as f:
        json.dump(sub, f)
    generator.generate(dpath, xpath, os.path.join(HERE, "Underwriting Model TEMPLATE.xlsx"))
    # finish_model prints JSON to stdout; call its engines directly instead
    ok, _ = finish_model.try_recalc_com(xpath)
    if not ok:
        getter, lookup, err = finish_model.try_compute_formulas(xpath)
        if not getter:
            raise RuntimeError("could not compute " + mix_label(names) + ": " + str(err))
        finish_model.bake_values_into_xlsx(xpath, lookup)
    hold = int((sub.get("assumptions") or {}).get("hold_period_years") or 8)
    res = read_results(xpath, hold)
    res.update(names=names, units=n_units, ask=ask)
    return res


def build_combos(deal, work=None, warnings=None):
    warnings = warnings if warnings is not None else []
    names = [p["name"] for p in _props(deal)]
    own = work is None
    work = work or tempfile.mkdtemp(prefix="combos-")
    results = []
    try:
        for m in all_mixes(names):
            try:
                results.append(run_mix(deal, m, work))
            except Exception as e:
                warnings.append(f"{mix_label(m)}: {str(e)[:160]}")
    finally:
        if own:
            shutil.rmtree(work, ignore_errors=True)
    return results


def rank(results, target):
    """Best value first: the mixes whose ask the model can nearly support.

    Score = max price at the IRR target / ask (1.0 = the ask already clears the
    target); where no max price solved, Year 1 NOI / ask. Mixes with no ask go last.
    """
    def cover(r):
        if r.get("ask") and r.get("max_price"):
            return r["max_price"] / r["ask"]
        return None
    def y1cap(r):
        return r["year1_noi"] / r["ask"] if r.get("ask") and _num(r.get("year1_noi")) else None
    # when no max price solved (the ask is far out of range), the Year 1 cap at ask still orders the mixes
    scored = [(cover(r), r) for r in results]
    scored.sort(key=lambda t: (t[1].get("ask") is None, t[0] is None, -(t[0] or 0), -(y1cap(t[1]) if y1cap(t[1]) is not None else -9)))
    out = []
    for i, (c, r) in enumerate(scored):
        r = dict(r)
        r["coverage"] = c
        r["rank"] = i + 1 if r.get("ask") else None
        r["discount_needed"] = (1 - c) if c is not None and c < 1 else (0.0 if c is not None else None)
        out.append(r)
    return out


def write_tab(wb, ranked, target, whole_label=None):
    if "Deal Combinations" in wb.sheetnames:
        del wb["Deal Combinations"]
    ws = wb.create_sheet("Deal Combinations", index=2 if len(wb.sheetnames) > 2 else len(wb.sheetnames))
    navy, pale = "1F4E78", "F0F5FA"
    green = PatternFill("solid", fgColor="E2F0D9")
    thin = Side(style="thin", color="D9D9D9")
    money = '$#,##0;[Red]($#,##0);-'
    cols = [
        ("Rank", None, "0"), ("Mix", None, "@"), ("Units", None, "#,##0"), ("Broker ask", None, money),
        ("Ask / unit", None, money), ("T12 NOI", None, money), ("Year 1 NOI", None, money),
        ("Cap rate at ask (T12)", None, "0.00%"), ("Year 1 cap at ask", None, "0.00%"),
        ("IRR at ask", None, "0.0%"), ("Year 1 DSCR", None, "0.00"), ("Yr 2 cash-on-cash", None, "0.0%"),
        (f"Max price @ {target:.0%} IRR", None, money), ("Max price / unit", None, money),
        ("Discount needed from ask", None, "0.0%"),
    ]
    n = len(cols)
    ws["A1"] = "Deal Combinations - every mix of the buildings, underwritten on its own"
    ws["A1"].font = Font(name="Carlito", size=18, bold=True, color="FFFFFF")
    for c in range(1, n + 1):
        ws.cell(row=1, column=c).fill = PatternFill("solid", fgColor=navy)
    ws["A2"] = ("Each row is a separate run of the full model: that mix's rent roll and T12, priced at the sum of the "
                "broker's per-building asks, with the county taxable value split by T12 tax share and value-add units "
                "by unit share. Ranked by max price at the IRR target divided by the ask (best first); the green row is "
                "the best value. Values are computed when the model is built, not live formulas - the model's other tabs "
                "stay live. These are house estimates, not broker figures.")
    ws["A2"].alignment = Alignment(wrap_text=True, vertical="top")
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=n)
    ws.row_dimensions[2].height = 58
    hr = 4
    for i, (h, _, _) in enumerate(cols, start=1):
        c = ws.cell(row=hr, column=i, value=h)
        c.font = Font(bold=True)
        c.fill = PatternFill("solid", fgColor=pale)
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = Border(bottom=thin)
    ws.row_dimensions[hr].height = 34
    for k, r in enumerate(ranked):
        row = hr + 1 + k
        ask, units = r.get("ask"), r.get("units")
        t12, y1, mx = r.get("t12_noi"), r.get("year1_noi"), r.get("max_price")
        vals = [
            r.get("rank") or "—", mix_label(r["names"]), units, ask if ask else "—",
            (ask / units) if ask and units else "—", t12, y1,
            (t12 / ask) if ask and _num(t12) else "—", (y1 / ask) if ask and _num(y1) else "—",
            r.get("irr") if _num(r.get("irr")) else "n/a", r.get("dscr") if _num(r.get("dscr")) else "—",
            r.get("coc2") if _num(r.get("coc2")) else "—",
            mx if mx else "not achievable", (mx / units) if mx and units else "—",
            r["discount_needed"] if r.get("discount_needed") is not None else "—",
        ]
        for i, v in enumerate(vals, start=1):
            c = ws.cell(row=row, column=i, value=v)
            c.number_format = cols[i - 1][2]
            c.alignment = Alignment(horizontal="left" if i == 2 else "right", wrap_text=(i == 2))
            c.border = Border(bottom=thin)
            if r.get("rank") == 1:
                c.fill = green
                c.font = Font(bold=True)
    end = hr + len(ranked)
    ws.cell(row=end + 2, column=1, value=(
        "How to read it: Discount needed is how far the ask must fall for that mix to reach the IRR target "
        "(0% = the ask already clears it). Cap rate at ask uses the T12 NOI; Year 1 reflects the sale-reset taxes, "
        "benchmarked expenses and fees. A mix priced without every building's ask shows '—' and ranks last."))
    ws.cell(row=end + 2, column=1).alignment = Alignment(wrap_text=True, vertical="top")
    ws.merge_cells(start_row=end + 2, start_column=1, end_row=end + 2, end_column=n)
    ws.row_dimensions[end + 2].height = 44
    widths = [7, 40, 8, 15, 12, 14, 14, 13, 13, 11, 11, 12, 18, 14, 14]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = w
    ws.freeze_panes = "C5"
    ws.sheet_properties.tabColor = "548235"


def add_to_model(deal, model_path):
    warns = []
    if len(_props(deal)) < 2:
        return 0, warns
    target = _num((deal.get("assumptions") or {}).get("irr_target")) or IRR_TARGET_DEFAULT
    results = build_combos(deal, warnings=warns)
    if not results:
        warns.append("Deal Combinations tab skipped: no mix could be underwritten.")
        return 0, warns
    ranked = rank(results, target)
    wb = load_workbook(model_path)
    write_tab(wb, ranked, target)
    wb.save(model_path)
    return len(ranked), warns


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python deal_combos.py <deal.json> <model.xlsx>")
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        deal = json.load(f)
    n, w = add_to_model(deal, sys.argv[2])
    _REAL_STDOUT.write(json.dumps({"combos": n, "warnings": w}) + "\n")
