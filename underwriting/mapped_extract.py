"""
mapped_extract.py <workbook.xlsx|.xls> <mapping.json>

Deterministic rent-roll extraction driven by a Claude-produced column mapping
(see UW_MAP_SYSTEM_PROMPT in server.js). Claude reads a small sample and says
WHERE the data is (sheets, start row, stop markers, 1-based column indices,
occupancy rules); this script then walks EVERY row with pandas and builds the
rent_roll units straight from the real cell values — no LLM retyping, so it's
fast, byte-accurate, and immune to output-token ceilings on 1,000-unit files.

Output envelope matches the full-Claude extraction path exactly:
{"kind":"rent_roll","meta":{...},"warnings":[...],"data":{...,"units":[...]}}
so server.js and the review screen treat both paths identically.
"""
import json
import math
import re
import sys
from datetime import date, datetime

import pandas as pd


def norm_text(v):
    if v is None:
        return ""
    if isinstance(v, float) and math.isnan(v):
        return ""
    if isinstance(v, float) and v == int(v) and abs(v) < 1e15:
        return str(int(v))
    return " ".join(str(v).split())


def to_num(v, default=0):
    if v is None:
        return default
    if isinstance(v, bool):
        return default
    if isinstance(v, (int, float)):
        if isinstance(v, float) and math.isnan(v):
            return default
        return float(v)
    s = str(v).replace("$", "").replace(",", "").replace("%", "").strip()
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    if not s:
        return default
    try:
        n = float(s)
        return -n if neg else n
    except ValueError:
        return default


def to_iso(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    if isinstance(v, (datetime, date, pd.Timestamp)):
        if pd.isna(v):
            return None
        return v.strftime("%Y-%m-%d")
    s = str(v).strip()
    if not s:
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m-%d-%Y", "%m/%d/%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return None


def _clean_number(v):
    n = to_num(v)
    return int(n) if n == int(n) else round(n, 2)


T12_FIELDS = [
    "gross_potential_rent", "vacancy_concessions_bad_debt", "net_rental_income",
    "other_income", "effective_gross_income", "controllable_expenses",
    # optional controllable sub-sections (2026-07-22 split) — mapped when the
    # statement breaks them out, otherwise stay None and the model uses the
    # merged controllable total.
    "repairs_maintenance", "turnover_costs", "labor_costs",
    "advertising_promotions", "general_admin",
    "utilities", "management_fee_actual", "insurance", "property_taxes_actual",
    "other_property_expenses", "total_operating_expenses",
    "net_operating_income", "actual_vacancy_loss", "actual_bad_debt",
    "actual_concessions",
]


def extract_t12(book_path, m):
    tm = m["t12_mapping"]
    warnings = list(m.get("warnings") or [])
    frames = pd.read_excel(book_path, sheet_name=None, header=None, dtype=object)
    df = frames.get(tm.get("sheet"))
    if df is None:
        raise ValueError(f"mapped sheet '{tm.get('sheet')}' not found")

    month_cols = [c - 1 for c in (tm.get("month_columns") or [])]
    total_col = (tm.get("total_column") or 0) - 1
    label_cols = [c - 1 for c in (tm.get("label_columns") or [])]

    def row_total(r):
        i = r - 1
        if i < 0 or i >= len(df):
            raise ValueError(f"mapped row {r} is outside the sheet")
        if total_col >= 0 and total_col < df.shape[1]:
            v = df.iat[i, total_col]
            if isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)):
                return float(v)
        return sum(to_num(df.iat[i, c]) for c in month_cols if c < df.shape[1])

    data = {}
    for field in T12_FIELDS:
        spec = (tm.get("fields") or {}).get(field)
        if not spec:
            data[field] = None
            continue
        if spec.get("row"):
            v = row_total(int(spec["row"]))
        elif spec.get("sum_rows"):
            v = sum(row_total(int(r)) for r in spec["sum_rows"])
        else:
            data[field] = None
            continue
        if spec.get("flip_sign"):
            v = -v
        data[field] = round(v, 2)

    # A transition month. Pinecrest Village's statement (2026-10-22) carried Oct 2025 with $0 gross potential rent,
    # revenue at about half a normal month ($226K) and expenses at a fifth ($69K): the property was being set up in
    # the ledger, it did not earn and spend that little. The statement's 12-month Total includes it, so every bucket
    # was off. A month is flagged when it has no gross potential rent, or when BOTH its revenue and its expenses sit
    # far below the median month; at most two months. Those months are left out and every bucket is recomputed from
    # the clean months and annualized (x12/11), said so in the warnings, and marked as a Cedar Ridge estimate.
    def month_values(field):
        spec = (tm.get("fields") or {}).get(field) or {}
        rows = [int(spec["row"])] if spec.get("row") else [int(x) for x in (spec.get("sum_rows") or [])]
        if not rows:
            return None
        vals = [0.0] * len(month_cols)
        for r in rows:
            i = r - 1
            if i < 0 or i >= len(df):
                return None
            for k, c in enumerate(month_cols):
                vals[k] += to_num(df.iat[i, c]) if c < df.shape[1] else 0.0
        return vals

    def odd_months():
        n = len(month_cols)
        gpr = month_values("gross_potential_rent")
        rev = month_values("effective_gross_income") or month_values("net_rental_income")
        exp = month_values("total_operating_expenses")
        if n < 6 or exp is None or (gpr is None and rev is None):
            return []
        med = lambda v: sorted(abs(x) for x in v)[len(v) // 2]
        mg, mr, me = (med(gpr) if gpr else 0), (med(rev) if rev else 0), med(exp)
        if me <= 0 or (mg <= 0 and mr <= 0):
            return []
        odd = []
        for k in range(n):
            no_gpr = gpr is not None and mg > 0 and abs(gpr[k]) < 0.1 * mg
            both_low = rev is not None and mr > 0 and abs(rev[k]) < 0.6 * mr and abs(exp[k]) < 0.25 * me
            if no_gpr or both_low:
                odd.append(k)
        return odd if 0 < len(odd) <= 2 else []

    odd = odd_months()
    stub_info = {}
    if odd:
        n = len(month_cols)
        factor = n / (n - len(odd))
        hdrs = []
        hr = int(tm.get("month_header_row") or 0) - 1
        for k in odd:
            v = df.iat[hr, month_cols[k]] if hr >= 0 and month_cols[k] < df.shape[1] else None
            hdrs.append(v.strftime("%b %Y") if isinstance(v, (datetime, date, pd.Timestamp)) and not pd.isna(v) else (norm_text(v) or f"month {k + 1}"))
        for field in T12_FIELDS:
            spec = (tm.get("fields") or {}).get(field)
            vals = month_values(field) if spec else None
            if vals is None:
                continue
            v = sum(x for k, x in enumerate(vals) if k not in odd) * factor
            data[field] = round(-v if spec.get("flip_sign") else v, 2)
        warnings.insert(0, f"ADJUSTED MONTH: {', '.join(hdrs)} has no gross potential rent and far less revenue and expense than a normal month (a "
                           f"transition month in the ledger). It is left out and every T12 figure is recomputed from the other {n - len(odd)} months and "
                           f"annualized (x{n}/{n - len(odd)}). This is a Cedar Ridge estimate; the statement's own 12-month total is different.")
        stub_info = {"adjusted_months": hdrs, "annualized_from_months": n - len(odd)}

    # The mapped columns must reproduce the statement's own total for the NOI line. A mapping that took two of twelve month columns
    # (Orchard Village, 2026-10-22) tied out internally (EGI - OpEx = NOI) while being a sixth of the real year.
    nspec = (tm.get("fields") or {}).get("net_operating_income") or {}
    if nspec.get("row") and not odd and data.get("net_operating_income") is not None:
        try:
            nums = [float(v) for v in df.iloc[int(nspec["row"]) - 1].tolist()
                    if isinstance(v, (int, float)) and not isinstance(v, bool) and not (isinstance(v, float) and math.isnan(v))]
            if len(nums) >= 13 and abs(sum(nums[:-1]) - nums[-1]) <= 0.01 * abs(nums[-1]) + 2:      # the line has a Total column
                got, want = data["net_operating_income"] * (-1 if nspec.get("flip_sign") else 1), nums[-1]
                if abs(got - want) > 0.02 * abs(want) + 5:
                    warnings.append(f"Tie-out: the mapped columns give NOI {got:,.0f} but the statement's own total for that line is {want:,.0f} "
                                    f"- the month columns are not all mapped ({len(month_cols)} of {len(nums) - 1}).")
        except Exception:
            pass

    # tie-out checks: never plug, only warn (mirrors the full-extraction rules)
    egi, opex, noi = (data.get("effective_gross_income"),
                      data.get("total_operating_expenses"),
                      data.get("net_operating_income"))
    if None not in (egi, opex, noi) and abs(egi - opex - noi) > max(2, abs(noi) * 0.001):
        warnings.append(f"Tie-out: EGI ({egi:,.0f}) - OpEx ({opex:,.0f}) does not equal "
                        f"NOI ({noi:,.0f}) — check the bucket mapping.")
    buckets = [data.get(f) for f in ("controllable_expenses", "utilities",
               "management_fee_actual", "insurance", "property_taxes_actual",
               "other_property_expenses")]
    if opex is not None and None not in buckets and abs(sum(buckets) - opex) > max(2, abs(opex) * 0.001):
        warnings.append(f"Tie-out: expense buckets sum to {sum(buckets):,.0f} but total "
                        f"OpEx is {opex:,.0f} — check the bucket mapping.")
    vcb = data.get("vacancy_concessions_bad_debt")
    if vcb is not None and vcb > 0:
        warnings.append("vacancy_concessions_bad_debt came out positive — the model "
                        "expects rent deductions as a negative number.")
    if noi is None:
        raise ValueError("mapping produced no net_operating_income")

    # GL detail for the audit table — free here, byte-accurate
    header_row = min([r - 1 for r in [tm.get("month_header_row") or 0] if r] or [0])
    raw = []
    for i in range(header_row + 1, len(df)):
        labels = [norm_text(df.iat[i, c]) for c in label_cols if c < df.shape[1]]
        labels = [x for x in labels if x]
        months = [df.iat[i, c] if c < df.shape[1] else None for c in month_cols]
        if not labels or not any(isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)) for v in months):
            continue
        raw.append({"source_row": i + 1,
                    "account": labels[0] if len(labels) > 1 else None,
                    "label": labels[-1],
                    "months": [to_num(v) for v in months]})
    data["raw_monthly_detail"] = raw
    if header_row >= 0:
        def _hdr(v):
            if isinstance(v, (datetime, date, pd.Timestamp)) and not pd.isna(v):
                return v.strftime("%b %Y")
            return norm_text(v) or ""
        data["month_headers"] = [
            _hdr(df.iat[header_row, c]) if c < df.shape[1] else ""
            for c in month_cols]

    meta = dict(m.get("meta") or {})
    meta["detail_rows"] = len(raw)
    meta["extraction_method"] = "row-mapped (pandas)"
    meta.update(stub_info)
    return {"kind": "t12", "meta": meta, "warnings": warnings, "data": data}


# A summary line written in the unit column ("206 Units | 99.5% Occupied | 195,650 | 225,955 ..." above a "Total 206 Units" line, as
# Orchard Village's Rent Manager export has) carries sizes and rents, so it read as a 207th unit and one more "occupied" one.
SUMMARY_UNIT = re.compile(r"^\s*(sub[\s-]*)?totals?\b|^\s*grand\s+total|^\s*\d[\d,]*\s*(units?|apts?|apartments?|doors)\b", re.I)


def extract(book_path, m):
    if m.get("kind") == "t12":
        return extract_t12(book_path, m)
    mapping = m.get("mapping") or {}
    cols = mapping.get("columns") or {}
    rules = mapping.get("status_rules") or {}
    exclude_sub = [s.lower() for s in (rules.get("exclude_contains") or [])]
    # a resident on notice is still in the unit (Orchard Village: "Notice-Unrented" listed as vacant turned 99.5% into 95.6%)
    vacant_sub = [s.lower() for s in (rules.get("vacant_contains") or []) if "notice" not in s.lower()]
    vacant_names = {s.lower() for s in (mapping.get("vacant_resident_names") or [])} | {"vacant", "model", "office"}
    occ_source = mapping.get("occupancy_source") or ("status" if cols.get("status") else "rent_charge")
    sum_cols = mapping.get("total_charges_sum_columns") or None
    warnings = list(m.get("warnings") or [])

    frames = pd.read_excel(book_path, sheet_name=None, header=None, dtype=object)

    def cell(row, key):
        idx = cols.get(key)
        if not idx or idx - 1 >= len(row):
            return None
        return row.iloc[idx - 1]

    units, excluded, summary_rows = [], 0, 0
    for spec in mapping.get("sheets") or []:
        if spec.get("skip"):
            continue
        name = spec.get("name")
        df = frames.get(name)
        if df is None:
            warnings.append(f"Mapped sheet '{name}' not found in workbook — skipped.")
            continue
        start = max(int(spec.get("data_start_row") or 1) - 1, 0)
        stops = [s.lower() for s in (spec.get("stop_markers") or []) if s]

        ignored_stops = set()
        for i in range(start, len(df)):
            row = df.iloc[i]
            joined = " ".join(norm_text(v) for v in row).lower()
            unit_number = norm_text(cell(row, "unit_number"))
            sqft = to_num(cell(row, "sqft"))
            market_rent = to_num(cell(row, "market_rent"))
            rent_charge = to_num(cell(row, "rent_charge"))
            hit = [s for s in stops if s in joined] if stops else []
            if hit:
                # A stop marker ends the list only on a row that is not itself a
                # unit. Main St (2026-09-24): the marker matched the super's unit
                # ("B3 … Super … 900") and silently dropped B3-B9 — seven real
                # units with rent. A row with a unit number AND rent or size is a
                # unit, whatever else it says; the TOTAL / section rows markers
                # are meant for have neither.
                looks_like_unit = bool(unit_number) and (sqft > 0 or market_rent > 0 or rent_charge > 0) \
                    and not any(s in unit_number.lower() for s in hit)
                if not looks_like_unit:
                    break
                ignored_stops.update(hit)

            if not unit_number:
                continue
            if SUMMARY_UNIT.match(unit_number):
                summary_rows += 1
                continue
            # non-data row (section labels, repeated headers, totals without a
            # stop marker): nothing money- or size-shaped in the mapped columns
            if sqft <= 0 and market_rent <= 0 and rent_charge <= 0:
                continue

            status = norm_text(cell(row, "status")).lower()
            if status and any(s in status for s in exclude_sub):
                excluded += 1
                continue

            resident_name = norm_text(cell(row, "resident_name"))
            if resident_name.lower() in vacant_names:
                resident_name = ""
            resident_id = norm_text(cell(row, "resident_id"))
            if resident_id in ("", "0"):
                resident_id = None

            if occ_source == "status":
                occupied = 0 if any(s in status for s in vacant_sub) else (1 if status else 0)
            elif occ_source == "resident_name":
                occupied = 1 if resident_name else 0
            else:
                occupied = 1 if rent_charge > 0 else 0

            if sum_cols:
                total_charges = sum(
                    to_num(row.iloc[c - 1]) for c in sum_cols if c - 1 < len(row))
            else:
                total_charges = to_num(cell(row, "total_charges"))
            if not total_charges:
                total_charges = rent_charge

            units.append({
                "unit_number": unit_number,
                "unit_type": norm_text(cell(row, "unit_type")),
                "sqft": _clean_number(sqft),
                "resident_id": resident_id,
                "resident_name": resident_name or None,
                "market_rent": _clean_number(market_rent),
                "rent_charge": _clean_number(rent_charge if occupied else 0),
                "total_charges": _clean_number(total_charges if occupied else 0),
                "move_in": to_iso(cell(row, "move_in")),
                "lease_expiration": to_iso(cell(row, "lease_expiration")),
                "move_out": to_iso(cell(row, "move_out")),
                "balance": _clean_number(to_num(cell(row, "balance"))),
                "occupied_flag": occupied,
            })
        if ignored_stops:
            warnings.append(f"Sheet '{name}': stop marker(s) {sorted(ignored_stops)} matched a row that is a unit "
                            f"(unit number + rent) — kept reading rather than dropping the units below it.")

    official = {k: v for k, v in (m.get("official") or {}).items() if v is not None}
    occupied_n = sum(u["occupied_flag"] for u in units)
    if "official_units" not in official:
        official = {
            "official_units": len(units),
            "official_occupied_units": occupied_n,
            "official_vacant_units": len(units) - occupied_n,
            "official_occupancy": round(occupied_n / len(units), 6) if units else None,
        }
        warnings.append("No summary block reported — official counts derived from unit rows.")
    elif official.get("official_units") != len(units):
        warnings.append(
            f"Parsed {len(units)} units but the report summary says "
            f"{official['official_units']} — investigate before generating.")

    if not cols.get("sqft"):
        warnings.append("Report has no square-footage column — sqft is 0 for every unit.")

    meta = dict(m.get("meta") or {})
    meta["parsed_units"] = len(units)
    meta["extraction_method"] = "column-mapped (pandas)"
    if excluded:
        meta["excluded_rows"] = excluded
    if summary_rows:
        meta["summary_rows_skipped"] = summary_rows

    data = {"as_of_date": (m.get("meta") or {}).get("as_of_date"), **official, "units": units}
    return {"kind": "rent_roll", "meta": meta, "warnings": warnings, "data": data}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(json.dumps({"error": "Usage: python mapped_extract.py <workbook> <mapping.json>"}))
        sys.exit(1)
    try:
        with open(sys.argv[2], encoding="utf-8") as f:
            m = json.load(f)
        print(json.dumps(extract(sys.argv[1], m), default=str))
    except Exception as e:
        print(json.dumps({"error": f"Mapped extraction failed: {e}"}))
        sys.exit(0)
