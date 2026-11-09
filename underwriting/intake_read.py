"""
The file-reading half of the no-API intake (scripts/underwriteLocal.js).

the owner, 2026-11-01: deals he sends are underwritten "through Claude" - no API tokens. The site reads a file its
built-in readers do not know (a PDF, a T12 laid out by account groups) with a paid model; here Claude reads it
in the session and writes what it read into the deal's intake sheet, and this script applies it the same way
every time. Every figure that does not come from a built-in reader names where it came from.

    python intake_read.py rr  <rent-roll.xlsx|csv> [map.json]    -> {"data": {...}, "meta": {...}, "warnings": [...]}
    python intake_read.py t12 <t12.xlsx> [map.json]             -> {"data": {...}, "meta": {...}, "warnings": [...]}
    python intake_read.py stamp <model.xlsx> <provenance.json>   writes the hidden "Provenance" tab (before the bake)

A T12 the built-in reader refuses is read with a map (Claude writes it after reading the statement):
    {"column": "Adjusted Total",                 # header text of the 12-month total column
     "lines": [["^4100 Total", "gross_potential_rent"], ...],   # first row whose label matches -> field (summed;
                                                                # "-field" takes a line back out of a group total)
     "noi_label": "^NET OPERATING INCOME",        # the statement's own NOI, which the mapped lines must tie to
     "noi_tolerance": 1}                          # dollars of difference allowed (e.g. bank interest the model leaves out)
"""
import csv
import json
import re
import sys
import warnings as _w
from pathlib import Path

_w.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).parent))
_OUT = sys.stdout
sys.stdout = sys.stderr

from openpyxl import Workbook, load_workbook

UNIT_FIELDS = ["unit_number", "unit_type", "sqft", "resident_id", "resident_name", "market_rent", "rent_charge",
               "total_charges", "move_in", "lease_expiration", "move_out", "balance", "occupied_flag"]
T12_FIELDS = ["gross_potential_rent", "vacancy_concessions_bad_debt", "net_rental_income", "other_income",
              "effective_gross_income", "repairs_maintenance", "turnover_costs", "labor_costs", "advertising_promotions",
              "general_admin", "other_controllable", "utilities", "management_fee_actual", "insurance",
              "property_taxes_actual", "other_property_expenses", "actual_vacancy_loss", "actual_bad_debt",
              "actual_concessions"]
CONTROLLABLE = ["repairs_maintenance", "turnover_costs", "labor_costs", "advertising_promotions", "general_admin", "other_controllable"]


def _num(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    try:
        return float(str(v).replace(",", "").replace("$", "").strip())
    except (TypeError, ValueError):
        return None


def read_rr_mapped(path, map_path):
    """A one-row-per-unit rent roll the built-in reader does not know: Claude maps its columns.
    {"columns": {"unit_number": "Unit", "market_rent": "Market Rent", "rent_charge": "Rent", "status": "Status", ...},
     "occupied": ["Current", "Notice"],   # statuses that count as occupied; anything else (vacant, down, model) does not
     "skip_units_matching": "units?$"}    # summary rows to leave out (a regex on the unit column)"""
    mp = json.loads(Path(map_path).read_text(encoding="utf-8"))
    ws = load_workbook(path, data_only=True).active
    rows = list(ws.iter_rows(values_only=True))
    want = mp["columns"]
    hdr_i = next((i for i, r in enumerate(rows[:40]) if str(want["unit_number"]).lower() in [str(c or "").strip().lower() for c in r]), None)
    if hdr_i is None:
        raise ValueError(f"no header row with a {want['unit_number']!r} column in the first 40 rows")
    head = [str(c or "").strip().lower() for c in rows[hdr_i]]
    idx = {k: head.index(str(v).lower()) for k, v in want.items() if str(v).lower() in head}
    if "unit_number" not in idx or "status" not in idx:
        raise ValueError("the map needs the unit and status columns")
    occupied = {str(x).lower() for x in mp.get("occupied", ["current"])}
    units, warns = [], []
    for r in rows[hdr_i + 1:]:
        u = r[idx["unit_number"]]
        st = str(r[idx["status"]] or "").strip()
        if u in (None, "") or not st:
            continue                                  # property header / blank rows
        if mp.get("skip_units_matching") and re.search(mp["skip_units_matching"], str(u), re.I):
            continue                                  # a summary row such as "206 Units" / "Total 206 Units"
        rec = {"unit_number": str(u).strip(), "occupied_flag": 1 if st.lower() in occupied else 0}
        for k, i in idx.items():
            if k in ("unit_number", "status"):
                continue
            v = r[i]
            if v is None or v == "":
                continue
            if k in ("sqft", "market_rent", "rent_charge", "total_charges", "balance"):
                v = _num(v)
            elif hasattr(v, "date"):
                v = v.date().isoformat()
            rec[k] = v
        if not rec["occupied_flag"]:
            rec["rent_charge"] = 0
        units.append(rec)
    occ = sum(u["occupied_flag"] for u in units)
    import collections
    mix = collections.Counter(str(r[idx["status"]]).strip() for r in rows[hdr_i + 1:] if r[idx["unit_number"]] not in (None, "") and r[idx["status"]]
                              and not (mp.get("skip_units_matching") and re.search(mp["skip_units_matching"], str(r[idx["unit_number"]]), re.I)))
    warns.append("Statuses read: " + ", ".join(f"{k} {v}" for k, v in mix.most_common()))
    data = {"as_of_date": None, "official_units": len(units), "official_occupied_units": occ, "official_vacant_units": len(units) - occ,
            "official_occupancy": occ / len(units) if units else None, "units": units}
    return {"data": data, "meta": {"source_format": "one row per unit, read with a column map"}, "warnings": warns,
            "method": "read by Claude with a column map (no API)"}


def read_rr(path, map_path=None):
    if map_path:
        return read_rr_mapped(path, map_path)
    """A rent roll: the built-in reader, or a plain units table (CSV / one-tab xlsx with the schema's column names),
    which is what Claude writes when it reads a PDF rent roll by hand."""
    from parsers import parse_rent_roll
    try:
        data, meta, warns = parse_rent_roll(path)
        return {"data": data, "meta": meta, "warnings": warns, "method": "built-in reader (" + str(meta.get("source_format") or "rent roll") + ")"}
    except Exception as e:
        first_err = str(e)
    rows = []
    if path.lower().endswith(".csv"):
        with open(path, newline="", encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
    else:
        ws = load_workbook(path, data_only=True).active
        vals = list(ws.iter_rows(values_only=True))
        hdr = [str(h or "").strip() for h in vals[0]] if vals else []
        rows = [dict(zip(hdr, r)) for r in vals[1:]]
    if not rows or "unit_number" not in rows[0]:
        raise ValueError(f"the built-in reader could not read this rent roll ({first_err}) and it is not a units table "
                         f"with columns {', '.join(UNIT_FIELDS)}")
    units = []
    for r in rows:
        if r.get("unit_number") in (None, ""):
            continue
        u = {k: r.get(k) for k in UNIT_FIELDS if r.get(k) not in (None, "")}
        for k in ("sqft", "market_rent", "rent_charge", "total_charges", "balance"):
            if k in u:
                u[k] = _num(u[k])
        u["unit_number"] = str(u["unit_number"])
        u["occupied_flag"] = 1 if str(u.get("occupied_flag", "")).strip().lower() in ("1", "true", "yes", "y", "occupied") else 0
        units.append(u)
    occ = sum(u["occupied_flag"] for u in units)
    data = {"as_of_date": None, "official_units": len(units), "official_occupied_units": occ,
            "official_vacant_units": len(units) - occ, "official_occupancy": occ / len(units) if units else None, "units": units}
    return {"data": data, "meta": {"source_format": "units table typed from the document"}, "warnings": [],
            "method": "read by Claude into a units table (no API)"}


def read_t12(path, map_path=None):
    from parsers import parse_t12
    if not map_path:
        data, meta, warns = parse_t12(path)
        return {"data": data, "meta": meta, "warnings": warns, "method": "built-in reader"}
    mp = json.loads(Path(map_path).read_text(encoding="utf-8"))
    ws = load_workbook(path, data_only=True).active
    rows = list(ws.iter_rows(values_only=True))
    hdr_i, col = None, None
    for i, r in enumerate(rows[:30]):
        for j, h in enumerate(r):
            if h is not None and re.search(mp["column"], str(h), re.I):
                hdr_i, col = i, j
                break
        if col is not None:
            break
    if col is None:
        raise ValueError(f"no column header matching {mp['column']!r} in the first 30 rows")
    label = lambda r: " ".join(str(c) for c in r[:max(1, col)] if c is not None and not isinstance(c, (int, float))).strip()
    data = {k: 0.0 for k in T12_FIELDS}
    hits = {}
    for pat, field in mp["lines"]:
        sign = -1.0 if field.startswith("-") else 1.0     # "-general_admin": take a line back out of a group total
        field = field.lstrip("-")
        if field not in data:
            raise ValueError(f"unknown T12 field {field!r} in the map")
        found = [r for r in rows[hdr_i + 1:] if re.search(pat, label(r), re.I) and _num(r[col]) is not None]
        if not found:
            raise ValueError(f"no row matching {pat!r} with an amount in the total column")
        data[field] += sign * _num(found[0][col])
        hits[pat] = label(found[0])
    d = data
    if not d["net_rental_income"]:
        d["net_rental_income"] = d["gross_potential_rent"] + d["vacancy_concessions_bad_debt"]
    if not d["effective_gross_income"]:
        d["effective_gross_income"] = d["net_rental_income"] + d["other_income"]
    d["controllable_expenses"] = sum(d[k] for k in CONTROLLABLE)
    d["total_operating_expenses"] = d["controllable_expenses"] + d["utilities"] + d["management_fee_actual"] + d["insurance"] \
        + d["property_taxes_actual"] + d["other_property_expenses"]
    d["net_operating_income"] = d["effective_gross_income"] - d["total_operating_expenses"]
    stated = None
    if mp.get("noi_label"):
        found = [r for r in rows[hdr_i + 1:] if re.search(mp["noi_label"], label(r), re.I) and _num(r[col]) is not None]
        stated = _num(found[0][col]) if found else None
        if stated is None:
            raise ValueError(f"the statement's NOI line {mp['noi_label']!r} was not found")
        if abs(stated - d["net_operating_income"]) > float(mp.get("noi_tolerance", 1)):
            raise ValueError(f"the mapped lines give NOI {d['net_operating_income']:,.2f} but the statement says {stated:,.2f}: "
                             "a line is missing or counted twice in the map")
    d.pop("other_controllable")
    # the model's "Other Controllable (unallocated)" is controllable minus the named sub-lines (model_fixes.unallocated_overlap)
    d["month_headers"] = []
    d["raw_monthly_detail"] = []
    return {"data": d, "meta": {"period": None, "source_format": "statement read with an account map", "lines": hits,
                                "stated_noi": stated, "noi_tolerance": float(mp.get("noi_tolerance", 1))},
            "warnings": [], "method": "read by Claude with an account map (no API); NOI ties to the statement"}


def stamp(model, prov_path):
    prov = json.loads(Path(prov_path).read_text(encoding="utf-8"))
    wb = load_workbook(model)
    if "Provenance" in wb.sheetnames:
        del wb["Provenance"]
    ws = wb.create_sheet("Provenance")
    ws["A1"] = "How this model was built (read by the site when the model is imported)"
    ws["A2"] = json.dumps(prov)
    ws.sheet_state = "hidden"
    wb.save(model)
    return {"stamped": True}


if __name__ == "__main__":
    try:
        cmd = sys.argv[1]
        if cmd == "rr":
            out = read_rr(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
        elif cmd == "t12":
            out = read_t12(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
        elif cmd == "stamp":
            out = stamp(sys.argv[2], sys.argv[3])
        else:
            raise ValueError("usage: intake_read.py rr|t12|stamp ...")
    except Exception as e:
        out = {"error": str(e)}
    _OUT.write(json.dumps(out, default=str) + "\n")
