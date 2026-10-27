"""
Step 3 (deterministic half): Rent Manager Excel exports -> deal-schema JSON
sections.

parse_rent_roll()  "Rent Roll with Lease Charges" export -> rent_roll section
parse_t12()        "12 Month Trailing Income Statement" export -> t12 section
detect_file()      sniff which kind an uploaded workbook is

Everything returns (data, warnings). Warnings are surfaced on the dashboard
review screen — no silent generation. Ground truth: parsing the original reference
source files must reproduce the sample_deal.json acceptance fixture exactly.
"""
import re
from datetime import datetime, date

from openpyxl import load_workbook


def _iso(v):
    if isinstance(v, (datetime, date)):
        return v.strftime("%Y-%m-%d")
    return v


def _num(v, default=0):
    if v is None:
        return default
    if isinstance(v, (int, float)):
        return v
    s = str(v).replace(",", "").replace("$", "").strip()
    try:
        return float(s)
    except ValueError:
        return default


MONTH_RE = re.compile(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$")


# ─────────────────────────── detection ───────────────────────────

def detect_file(path):
    """Return 'rent_roll' | 't12' | 'unknown' for an Excel file."""
    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        ws = wb[wb.sheetnames[0]]
        head = []
        for row in ws.iter_rows(min_row=1, max_row=8, max_col=14, values_only=True):
            head.append([str(v) if v is not None else "" for v in row])
        flat = " | ".join(c for r in head for c in r if c)
        # header labels wrap across two rows ("Charge" / "Code"), so sniff the
        # report title + the As Of stamp instead of a single joined cell
        if "Rent Roll" in flat and ("As Of =" in flat or "Charge" in flat):
            return "rent_roll"
        month_hits = sum(1 for r in head for c in r if MONTH_RE.match(c.strip()))
        if "12 Month Trailing" in flat or "Trailing Income Statement" in flat or month_hits >= 10:
            return "t12"
        return "unknown"
    finally:
        wb.close()


# ─────────────────────────── rent roll ───────────────────────────

def _rr_header_row(ws):
    """Row where the column headers live (col 1 == 'Unit'). Defaults to 5."""
    for r in range(1, 12):
        if str(ws.cell(r, 1).value or "").strip().lower() == "unit":
            return r
    return 5


def _rr_is_summary_format(ws, hdr_row):
    """Tell the two standard RM rent-roll reports apart by the col-7 header.

    'Rent Roll with Lease Charges' -> col 7 = 'Charge' (Code), col 8 = Amount,
        with multi-row charge blocks per unit.
    'Rent Roll' (summary)          -> col 7 = 'Actual' (Rent), one row per unit.
    Defaults to the Lease-Charges path when ambiguous (existing behavior).
    """
    h = (str(ws.cell(hdr_row, 7).value or "") + " " +
         str(ws.cell(hdr_row + 1, 7).value or "")).lower()
    if "charge" in h:
        return False
    return "actual" in h


def _parse_rr_summary(ws, warnings):
    """RM plain 'Rent Roll' report: one row per unit, Actual Rent in col 7.

    Columns: 1 Unit, 2 Unit Type, 3 Sq Ft, 4 Resident ID, 5 Name, 6 Market Rent,
    7 Actual Rent, 8 Resident Deposit, 9 Other Deposit, 10 Move In, 11 Lease From,
    12 Lease Expiration, 13 Move Out, 14 Balance. The whole layout sits one column
    left of the Lease-Charges report (no 'Amount' column), including the Summary
    Groups block where unit counts live in col 10 (vs col 11 there).
    """
    property_name = str(ws.cell(2, 1).value or "").strip()
    as_of = None
    for r in range(1, 8):
        m = re.search(r"As Of\s*=\s*(\d{2})/(\d{2})/(\d{4})", str(ws.cell(r, 1).value or ""))
        if m:
            as_of = f"{m.group(3)}-{m.group(1)}-{m.group(2)}"
            break
    if not as_of:
        warnings.append("Could not find 'As Of =' date in the report header.")

    start_row = stop_row = None
    for r in range(1, ws.max_row + 1):
        a = str(ws.cell(r, 1).value or "")
        if start_row is None and a.startswith("Current/Notice/Vacan"):
            start_row = r + 1
        elif start_row and a.startswith("Future Residents"):
            stop_row = r
            break
    if start_row is None:
        raise ValueError("Not a 'Rent Roll' export: no 'Current/Notice/Vacant "
                         "Residents' section found.")
    if stop_row is None:
        stop_row = ws.max_row + 1
        warnings.append("No 'Future Residents/Applicants' section found — "
                        "parsed to end of sheet.")

    units = []
    for r in range(start_row, stop_row):
        unit_no, sqft = ws.cell(r, 1).value, ws.cell(r, 3).value
        if unit_no is None or sqft is None:
            continue
        rid = str(ws.cell(r, 4).value or "").strip()
        name = " ".join(str(ws.cell(r, 5).value or "").split())
        vacant = rid.upper() == "VACANT" or name.upper() == "VACANT"
        actual_rent = _num(ws.cell(r, 7).value)
        u = {
            "unit_number": str(unit_no).strip(),
            "unit_type": str(ws.cell(r, 2).value or "").strip(),
            "sqft": _num(sqft),
            "market_rent": _num(ws.cell(r, 6).value),
            "rent_charge": actual_rent,
            "total_charges": actual_rent,
            "occupied_flag": 0 if vacant else (1 if actual_rent > 0 else 0),
        }
        if not vacant:
            if rid:
                u["resident_id"] = rid
            if name:
                u["resident_name"] = name
        for key, col in (("move_in", 10), ("lease_expiration", 12), ("move_out", 13)):
            v = _iso(ws.cell(r, col).value)
            if v is not None:
                u[key] = v
        u["balance"] = _num(ws.cell(r, 14).value)
        units.append(u)

    official = {}
    for r in range(stop_row, ws.max_row + 1):
        a = str(ws.cell(r, 1).value or "").strip()
        if a.startswith("Current/Notice/Vacan"):
            official["official_units"] = int(_num(ws.cell(r, 10).value))
            occ = _num(ws.cell(r, 12).value)
            official["official_occupancy"] = round(occ / 100, 6) if occ else None
        elif a.startswith("Occupied Units"):
            official["official_occupied_units"] = int(_num(ws.cell(r, 10).value))
        elif a.startswith("Total Vacant Uni"):
            official["official_vacant_units"] = int(_num(ws.cell(r, 10).value))
    if "official_units" not in official:
        warnings.append("Summary Groups block not found — official unit counts "
                        "missing; the model's Checks tab will flag this.")

    data = {"as_of_date": as_of, **official, "units": units}
    meta = {"property_name": property_name, "parsed_units": len(units)}
    if official.get("official_units") and official["official_units"] != len(units):
        warnings.append(f"Parsed {len(units)} units but report summary says "
                        f"{official['official_units']} — investigate before generating.")
    return data, meta, warnings


# ── 'Rent Roll with Lease Charges', header-driven variant ─────────────────────
# Pinecrest Village (2026-10-22): a Rent Manager "Rent Roll with Lease Charges" export whose columns sit at
# different positions from the layout parse_rent_roll() reads by number (sqft in col 4, resident in col 5,
# name in col 9, market rent in col 12, "Charge Code" in col 14 and "Amount" in col 15), with charge codes
# like "conrent"/"concess", no "Total" label on a unit's last row, and a section called "Current/Notice
# Residents" (no "/Vacant"). The standard parser rejected it, so the file went to the full AI read, which
# has to retype every unit and cannot finish 996 of them inside its 5-minute limit. This variant finds
# every column from the header row's own labels instead of assuming where it is.

_RR_HEADED_LABELS = {
    "unit": "unit", "unit type": "type", "unit sqft": "sqft", "resident": "rid", "name": "name",
    "market rent": "mkt", "charge code": "code", "amount": "amt", "move in": "move_in",
    "lease expiration": "lease", "move out": "move_out", "balance": "bal",
}


def _rr_find_headed(ws):
    """(header_row, {field: col}) when the sheet carries its own single-cell 'Charge Code' header."""
    for r in range(1, 12):
        cells = {c: str(ws.cell(r, c).value or "").strip().lower() for c in range(1, min(ws.max_column, 40) + 1)}
        if "charge code" in cells.values() and "unit" in cells.values():
            cols = {}
            for c, label in cells.items():
                if label in _RR_HEADED_LABELS and _RR_HEADED_LABELS[label] not in cols:
                    cols[_RR_HEADED_LABELS[label]] = c
            if all(k in cols for k in ("unit", "sqft", "mkt", "code", "amt")):
                return r, cols
    return None


def _parse_rr_headed(ws, hdr, warnings):
    hdr_row, col = hdr
    as_of = None
    for r in range(1, hdr_row + 1):
        m = re.search(r"As Of\s*=\s*(\d{2})/(\d{2})/(\d{4})", str(ws.cell(r, 1).value or ""))
        if m:
            as_of = f"{m.group(3)}-{m.group(1)}-{m.group(2)}"
    if not as_of:
        warnings.append("No 'As Of =' date in the report header - the rent roll's as-of date is blank.")
    property_name = str(ws.cell(2, 1).value or "").strip()

    start_row = stop_row = None
    for r in range(hdr_row + 1, ws.max_row + 1):
        a = str(ws.cell(r, 1).value or "").strip()
        if start_row is None and a.startswith("Current/Notice"):
            start_row = r + 1
        elif start_row and (a.startswith("Future Residents") or a.startswith("Current/Notice Res") or a.startswith("Summary")):
            stop_row = r
            break
    if start_row is None:
        raise ValueError("Not a 'Rent Roll with Lease Charges' export: no 'Current/Notice' residents section found.")
    if stop_row is None:
        stop_row = ws.max_row + 1

    get = lambda r, k: ws.cell(r, col[k]).value if k in col else None
    units = []
    r = start_row
    while r < stop_row:
        unit, sqft = get(r, "unit"), get(r, "sqft")
        if unit in (None, "") or sqft in (None, ""):
            r += 1
            continue
        u = {"unit_number": str(unit).strip(), "unit_type": str(get(r, "type") or "").strip(),
             "sqft": _num(sqft), "market_rent": _num(get(r, "mkt"))}
        rid, rname = get(r, "rid"), get(r, "name")
        if rid not in (None, ""):
            u["resident_id"] = str(rid).strip()
        if rname not in (None, ""):
            u["resident_name"] = " ".join(str(rname).split())
        for key in ("move_in", "lease", "move_out"):
            v = _iso(get(r, key))
            if v is not None:
                u[{"lease": "lease_expiration"}.get(key, key)] = v
        u["balance"] = _num(get(r, "bal"))
        # the block: this row, then charge rows, then a last row that carries only an amount (the unit's total)
        rent_named, others, last_amount, last_had_code = 0, [], 0, False
        rr_ = r
        while rr_ < stop_row:
            if rr_ > r and get(rr_, "unit") not in (None, "") and get(rr_, "sqft") not in (None, ""):
                break                                           # next unit
            code = str(get(rr_, "code") or "").strip().lower()
            amt = get(rr_, "amt")
            if amt not in (None, ""):
                last_amount, last_had_code = _num(amt), bool(code)
                if code:
                    if code == "rent" or code.endswith("rent"):   # "rent", "conrent"
                        rent_named += _num(amt)
                    else:
                        others.append(_num(amt))
            rr_ += 1
        rent_charge = rent_named if rent_named > 0 else (max([o for o in others if o > 0], default=0))
        u["rent_charge"] = rent_charge
        u["total_charges"] = last_amount if not last_had_code else rent_charge + sum(others)
        # occupied = pays rent, OR is a real resident whose rent line happened to be $0 (a concession month).
        # "Down", "Model", "Vacant" and the like are not residents (Pinecrest: 357 Down + 2 Model = the report's 359 non-revenue).
        who = str(u.get("resident_name") or "").strip().lower()
        real_resident = bool(who) and not re.match(r"^(vacant|down|model|office|admin|employee|non[\s-]?rev|storage|maint)", who)
        u["occupied_flag"] = 1 if (rent_charge > 0 or real_resident) else 0
        units.append(u)
        r = rr_

    # official counts from the summary block: its header row names a "# of Units" column
    official = {}
    unit_col = occ_col = None
    # the "# of Units" header sits a few rows above the first summary row; the charge summary further down has its own "Total"
    for rr_ in range(max(hdr_row + 1, stop_row - 8), ws.max_row + 1):
        a = str(ws.cell(rr_, 1).value or "").strip().lower()
        if a.startswith("summary of charges"):
            break
        for c in range(1, min(ws.max_column, 40) + 1):
            label = str(ws.cell(rr_, c).value or "").strip().lower()
            if label == "# of units":
                unit_col = c
            elif label == "unit occupancy":
                occ_col = c
        if unit_col and a == "total" and "official_units" not in official:
            official["official_units"] = int(_num(ws.cell(rr_, unit_col).value))
        elif unit_col and a == "occupied units":
            official["official_occupied_units"] = int(_num(ws.cell(rr_, unit_col).value))
            if occ_col:
                occ = _num(ws.cell(rr_, occ_col).value)
                official["official_occupancy"] = round(occ / 100, 6) if occ else None
        elif unit_col and a.startswith("total non rev"):
            official["_non_rev"] = int(_num(ws.cell(rr_, unit_col).value))
    non_rev = official.pop("_non_rev", 0)
    if "official_units" in official and "official_occupied_units" in official:
        # every unit that is not a current, rent-paying lease is unoccupied today: vacant and non-revenue (down, model, employee)
        official["official_vacant_units"] = official["official_units"] - official["official_occupied_units"]
        if non_rev:
            warnings.append(f"{non_rev} of the {official['official_units']} units are non-revenue (down, model or employee units) "
                            f"and count as unoccupied here, so occupancy is the rent-paying units only.")
    else:
        warnings.append("Summary block (# of Units) not found - official unit counts are missing; the model's Checks tab will flag this.")

    data = {"as_of_date": as_of, **official, "units": units}
    meta = {"property_name": property_name, "parsed_units": len(units), "layout": "Rent Manager lease-charges (header-driven)"}
    if official.get("official_units") and official["official_units"] != len(units):
        warnings.append(f"Parsed {len(units)} units but report summary says {official['official_units']} - investigate before generating.")
    occ_n = sum(1 for u in units if u["occupied_flag"])
    if official.get("official_occupied_units") is not None and occ_n != official["official_occupied_units"]:
        warnings.append(f"{occ_n} units carry a rent charge but the summary says {official['official_occupied_units']} are occupied.")
    return data, meta, warnings


def parse_rent_roll(path):
    """RM rent-roll export -> deal rent_roll section.

    Handles both standard Rent Manager reports — the multi-row 'Rent Roll with
    Lease Charges' layout and the one-row-per-unit 'Rent Roll' (summary) layout —
    dispatched on the column-7 header.
    """
    warnings = []
    wb = load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]

    if _rr_is_summary_format(ws, _rr_header_row(ws)):
        return _parse_rr_summary(ws, warnings)

    headed = _rr_find_headed(ws)
    if headed:                                     # a variant that names its own columns ('Charge Code' in one cell)
        return _parse_rr_headed(ws, headed, warnings)

    # property name + as-of date live in the report header rows
    property_name = str(ws.cell(2, 1).value or "").strip()
    as_of = None
    for r in range(1, 8):
        m = re.search(r"As Of\s*=\s*(\d{2})/(\d{2})/(\d{4})", str(ws.cell(r, 1).value or ""))
        if m:
            as_of = f"{m.group(3)}-{m.group(1)}-{m.group(2)}"
            break
    if not as_of:
        warnings.append("Could not find 'As Of =' date in the report header.")

    # find the resident section start and the future-residents cutoff
    start_row = stop_row = None
    for r in range(1, ws.max_row + 1):
        a = str(ws.cell(r, 1).value or "")
        if start_row is None and a.startswith("Current/Notice/Vacan"):
            start_row = r + 1
        elif start_row and a.startswith("Future Residents"):
            stop_row = r
            break
    if start_row is None:
        raise ValueError("Not a 'Rent Roll with Lease Charges' export: no "
                         "'Current/Notice/Vacant Residents' section found.")
    if stop_row is None:
        stop_row = ws.max_row + 1
        warnings.append("No 'Future Residents/Applicants' section found — "
                        "parsed to end of sheet.")

    # walk unit blocks: main row (unit # + sqft), charge rows, then 'Total' row
    units = []
    r = start_row
    while r < stop_row:
        a, sqft = ws.cell(r, 1).value, ws.cell(r, 3).value
        if a is None or sqft is None:
            r += 1
            continue
        u = {
            "unit_number": str(a).strip(),
            "unit_type": str(ws.cell(r, 2).value or "").strip(),
            "sqft": _num(sqft),
            "market_rent": _num(ws.cell(r, 6).value),
        }
        rid = ws.cell(r, 4).value
        rname = ws.cell(r, 5).value
        if rid is not None:
            u["resident_id"] = str(rid).strip()
        if rname is not None:
            u["resident_name"] = " ".join(str(rname).split())
        for key, col in (("move_in", 11), ("lease_expiration", 12), ("move_out", 13)):
            v = _iso(ws.cell(r, col).value)
            if v is not None:
                u[key] = v
        u["balance"] = _num(ws.cell(r, 14).value)

        # charge rows for this unit (starting with the main row itself).
        # RM properties code the rent line inconsistently: some emit a literal
        # "rent" charge code, others use a numeric code (e.g. "1030" at St.
        # Bay). Sum any explicit "rent" rows; if the property uses numeric
        # codes, fall back to the largest single charge in the block — base
        # rent reliably dominates the ancillary fees.
        rent_named, other_charges, total_charges = 0, [], 0
        rr_ = r
        while rr_ < stop_row:
            code = str(ws.cell(rr_, 7).value or "").strip()
            amt = ws.cell(rr_, 8).value
            if code == "Total":
                total_charges = _num(amt)
                break
            if code:
                if code.lower() == "rent":
                    rent_named += _num(amt)
                else:
                    other_charges.append(_num(amt))
            rr_ += 1
            # a new unit main row without a Total row would be a malformed block
            if ws.cell(rr_, 1).value is not None and ws.cell(rr_, 3).value is not None:
                warnings.append(f"Unit {u['unit_number']}: no 'Total' charges row found.")
                rr_ -= 1
                break
        rent_charge = rent_named if rent_named > 0 else (max(other_charges) if other_charges else 0)
        u["rent_charge"] = rent_charge
        u["total_charges"] = total_charges
        u["occupied_flag"] = 1 if rent_charge > 0 else 0
        units.append(u)
        r = rr_ + 1

    # official numbers from the Summary Groups block
    official = {}
    for r in range(stop_row, ws.max_row + 1):
        a = str(ws.cell(r, 1).value or "").strip()
        if a.startswith("Current/Notice/Vacan"):
            official["official_units"] = int(_num(ws.cell(r, 11).value))
            occ = _num(ws.cell(r, 12).value)
            official["official_occupancy"] = round(occ / 100, 6) if occ else None
        elif a.startswith("Occupied Units"):
            official["official_occupied_units"] = int(_num(ws.cell(r, 11).value))
        elif a.startswith("Total Vacant Uni"):
            official["official_vacant_units"] = int(_num(ws.cell(r, 11).value))
    if "official_units" not in official:
        warnings.append("Summary Groups block not found — official unit counts "
                        "missing; the model's Checks tab will flag this.")

    data = {"as_of_date": as_of, **official, "units": units}
    meta = {"property_name": property_name, "parsed_units": len(units)}
    if official.get("official_units") and official["official_units"] != len(units):
        warnings.append(f"Parsed {len(units)} units but report summary says "
                        f"{official['official_units']} — investigate before generating.")
    return data, meta, warnings


# ─────────────────────────── t12 ───────────────────────────

# stripped section-total label -> deal t12 field
T12_TOTALS = {
    "Total Gross Potential Rent": "gross_potential_rent",
    "Total Deductions": "vacancy_concessions_bad_debt",
    "Net Rental Income": "net_rental_income",
    "Total Other Income": "other_income",
    "Total Income": "effective_gross_income",
    "Total Controllable Expenses": "controllable_expenses",
    "Total Utility Costs": "utilities",
    "Total Management Fees": "management_fee_actual",
    "Total Insurance and Bonds": "insurance",
    "Total Property Taxes": "property_taxes_actual",
    "Total Other Property Expenses": "other_property_expenses",
    "Total Operating Expenses": "total_operating_expenses",
    "Net Operating Income": "net_operating_income",
}

# Controllable sub-sections (2026-07-22 split). OPTIONAL — absence is not a
# warning (non-RM statements may not break these out); presence lets the model
# show/grow each line separately instead of one merged Controllable number.
T12_SUB_TOTALS = {
    "Total Repairs and Maintenance": "repairs_maintenance",
    "Total Turnover Costs": "turnover_costs",
    "Total Labor Costs": "labor_costs",
    "Total Advertising and Promotions": "advertising_promotions",
    "Total General and Administrative Costs": "general_admin",
}

# actuals derived from GL account codes (net of recoveries/chargebacks)
T12_ACCOUNT_SUMS = {
    "actual_vacancy_loss": ("4510-00", "4510-01"),
    "actual_bad_debt": ("4540-00", "4545-00"),
    "actual_concessions": ("4530-00", "4535-00"),
}


def parse_t12(path):
    """RM '12 Month Trailing Income Statement' export -> deal t12 section."""
    warnings = []
    wb = load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]

    property_name = str(ws.cell(1, 1).value or "").strip()
    period = ""
    for r in range(1, 8):
        m = re.search(r"Period\s*=\s*(.+)", str(ws.cell(r, 1).value or ""))
        if m:
            period = m.group(1).strip()
            break

    # month header row: first row with >= 10 month-named cells
    header_row = None
    for r in range(1, 15):
        hits = sum(1 for c in range(1, ws.max_column + 1)
                   if MONTH_RE.match(str(ws.cell(r, c).value or "").strip()))
        if hits >= 10:
            header_row = r
            break
    if header_row is None:
        raise ValueError("Not a T12 export: no row of monthly column headers found.")
    month_cols = [c for c in range(1, ws.max_column + 1)
                  if MONTH_RE.match(str(ws.cell(header_row, c).value or "").strip())]
    if len(month_cols) != 12:
        warnings.append(f"Expected 12 monthly columns, found {len(month_cols)} — "
                        "partial-year statement?")

    def row_total(r):
        # prefer the export's own Total column (just right of the last month)
        total_col = month_cols[-1] + 1
        v = ws.cell(r, total_col).value
        if isinstance(v, (int, float)):
            return v
        return sum(_num(ws.cell(r, c).value) for c in month_cols)

    data = {}
    raw = []
    found = set()
    for r in range(header_row + 1, ws.max_row + 1):
        label = ws.cell(r, 2).value
        if label is None:
            continue
        stripped = str(label).strip()
        account = str(ws.cell(r, 1).value or "").strip()
        raw.append({
            "source_row": r,
            "account": account or None,
            "label": stripped,
            "months": [ws.cell(r, c).value for c in month_cols],
        })
        if stripped in T12_TOTALS and T12_TOTALS[stripped] not in found:
            data[T12_TOTALS[stripped]] = row_total(r)
            found.add(T12_TOTALS[stripped])
        if stripped in T12_SUB_TOTALS and T12_SUB_TOTALS[stripped] not in found:
            data[T12_SUB_TOTALS[stripped]] = row_total(r)
            found.add(T12_SUB_TOTALS[stripped])
        for field, accounts in T12_ACCOUNT_SUMS.items():
            if account in accounts:
                data[field] = data.get(field, 0) + row_total(r)

    missing = [f for f in T12_TOTALS.values() if f not in data]
    if missing:
        warnings.append(f"T12 lines not found (statement layout differs from the "
                        f"RM standard): {', '.join(missing)}")
    if "net_operating_income" not in data:
        raise ValueError("Could not find Net Operating Income in the T12 — "
                         "cannot underwrite without it.")

    # Tie-out check: unlike the AI extraction path, label/account-code matching
    # here is blind — a duplicate header row or a total landing under the wrong
    # bucket would otherwise sail through with zero warnings. $2 tolerance covers
    # float/rounding noise in the export, not a real mismatch.
    TOL = 2.0
    if "effective_gross_income" in data and "total_operating_expenses" in data:
        computed_noi = data["effective_gross_income"] - data["total_operating_expenses"]
        diff = computed_noi - data["net_operating_income"]
        if abs(diff) > TOL:
            warnings.append(
                f"T12 does not tie out: EGI (${data['effective_gross_income']:,.0f}) - "
                f"OpEx (${data['total_operating_expenses']:,.0f}) = ${computed_noi:,.0f}, "
                f"but the statement's NOI is ${data['net_operating_income']:,.0f} "
                f"(off by ${diff:,.0f}) — verify the parsed T12 before generating.")

    EXPENSE_BUCKETS = ["controllable_expenses", "utilities", "management_fee_actual",
                       "insurance", "property_taxes_actual", "other_property_expenses"]
    if all(b in data for b in EXPENSE_BUCKETS) and "total_operating_expenses" in data:
        bucket_sum = sum(data[b] for b in EXPENSE_BUCKETS)
        diff = bucket_sum - data["total_operating_expenses"]
        if abs(diff) > TOL:
            warnings.append(
                f"T12 expense buckets sum to ${bucket_sum:,.0f} but Total Operating "
                f"Expenses is ${data['total_operating_expenses']:,.0f} "
                f"(off by ${diff:,.0f}) — verify the parsed T12 before generating.")

    SUB_BUCKETS = list(T12_SUB_TOTALS.values())
    if all(b in data for b in SUB_BUCKETS) and "controllable_expenses" in data:
        sub_sum = sum(data[b] for b in SUB_BUCKETS)
        diff = sub_sum - data["controllable_expenses"]
        if abs(diff) > TOL:
            warnings.append(
                f"Controllable sub-sections sum to ${sub_sum:,.0f} but Total "
                f"Controllable Expenses is ${data['controllable_expenses']:,.0f} "
                f"(off by ${diff:,.0f}) — verify the parsed T12 before generating.")

    data["raw_monthly_detail"] = raw
    data["month_headers"] = [str(ws.cell(header_row, c).value or "").strip()
                             for c in month_cols]
    meta = {"property_name": property_name, "period": period,
            "detail_rows": len(raw)}
    return data, meta, warnings


# ─────────────────────── generic raw monthly dump ───────────────────────

# Looser than MONTH_RE: matches "Jun 2025", "JAN 22", "Jan-25", "Jun.2025",
# plus real date cells. Used only to FIND month columns for the audit dump —
# never to classify buckets.
GEN_MONTH_RE = re.compile(
    r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-/.']*\d{2,4}$",
    re.IGNORECASE)


def dump_raw_monthly(path):
    """Best-effort GL-level monthly grid from ANY T12-shaped workbook.

    Zero classification — just finds the sheet/row of month headers and emits
    every row beneath that has a text label plus at least one numeric month.
    Fills the T12 Actuals audit table when the bucket extraction came from a
    path that produces no raw detail (the full-Claude fallback) — the reason
    a generated model's "raw monthly account detail" section could come out
    empty even though the summary numbers landed (Gardens of Pine Ranch,
    2026-07-22).
    """
    from datetime import datetime as _dt, date as _date
    wb = load_workbook(path, data_only=True)

    def month_label(v):
        if isinstance(v, (_dt, _date)):
            return v.strftime("%b %Y")
        s = str(v or "").strip()
        return s if GEN_MONTH_RE.match(s) else None

    best = None  # (row_count, sheet, header_row, month_cols)
    for ws in wb.worksheets:
        header_row, month_cols = None, []
        for r in range(1, min(ws.max_row, 20) + 1):
            cols = [c for c in range(1, ws.max_column + 1)
                    if month_label(ws.cell(r, c).value)]
            # require 10+ DISTINCT months — an allocations sheet repeating the
            # same quarter across blocks must not beat the real statement
            if len(cols) >= 10 and len({month_label(ws.cell(r, c).value) for c in cols}) >= 10:
                header_row, month_cols = r, cols[:12]
                break
        if header_row is None:
            continue
        rows = 0
        for r in range(header_row + 1, ws.max_row + 1):
            has_label = any(
                isinstance(ws.cell(r, c).value, str) and str(ws.cell(r, c).value).strip()
                for c in range(1, month_cols[0]))
            has_num = any(isinstance(ws.cell(r, c).value, (int, float))
                          for c in month_cols)
            if has_label and has_num:
                rows += 1
        if rows and (best is None or rows > best[0]):
            best = (rows, ws, header_row, month_cols)

    if best is None:
        return {"month_headers": [], "raw_monthly_detail": []}

    _, ws, header_row, month_cols = best
    headers = [month_label(ws.cell(header_row, c).value) or "" for c in month_cols]
    raw = []
    for r in range(header_row + 1, ws.max_row + 1):
        label_cells = [str(ws.cell(r, c).value).strip()
                       for c in range(1, month_cols[0])
                       if isinstance(ws.cell(r, c).value, str)
                       and str(ws.cell(r, c).value).strip()]
        months = [ws.cell(r, c).value if isinstance(ws.cell(r, c).value, (int, float))
                  else None for c in month_cols]
        if not label_cells or not any(m is not None for m in months):
            continue
        label = label_cells[-1]
        account = None
        # RM-style: GL code in its own column left of the label
        if len(label_cells) >= 2 and re.match(r"^\d[\d\-.]*$", label_cells[0]):
            account = label_cells[0]
        else:
            # QB-style: a leading code token inside the label ("5301 Property Taxes")
            m = re.match(r"^(\d[\d\-.]*)\s+(.*)$", label)
            if m:
                account, label = m.group(1), m.group(2)
        raw.append({"source_row": r, "account": account, "label": label,
                    "months": months})
    return {"month_headers": headers, "raw_monthly_detail": raw,
            "sheet": ws.title, "detail_rows": len(raw)}


# ─────────────────────────── CLI ───────────────────────────

if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 2:
        print(json.dumps({"kind": "unknown",
                          "error": "Usage: python parsers.py <file.xlsx> [--kind rent_roll|t12]"}))
        sys.exit(2)
    path = sys.argv[1]
    # --dump-raw: generic monthly-grid dump only (no bucket parsing). Used by the
    # server to fill the audit table when extraction came from a path with no
    # raw detail. Always exits 0 with JSON (empty lists when nothing found).
    if "--dump-raw" in sys.argv:
        try:
            print(json.dumps(dump_raw_monthly(path), default=str))
        except Exception as e:
            print(json.dumps({"month_headers": [], "raw_monthly_detail": [],
                              "error": f"dump failed: {e}"}))
        sys.exit(0)
    # Always emit clean JSON — the server treats a non-rent_roll/t12 result (or
    # any failure) as "not a fixed-layout export" and falls through to the model
    # extraction paths. A raw traceback would just become opaque server noise.
    try:
        kind = sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--kind" else detect_file(path)
        if kind == "rent_roll":
            data, meta, warns = parse_rent_roll(path)
        elif kind == "t12":
            data, meta, warns = parse_t12(path)
        else:
            print(json.dumps({"kind": "unknown", "error": "Unrecognized file format"}))
            sys.exit(2)
    except Exception as e:
        print(json.dumps({"kind": "unknown", "error": f"Deterministic parse failed: {e}"}))
        sys.exit(2)
    print(json.dumps({"kind": kind, "meta": meta, "warnings": warns, "data": data},
                     default=str))
