"""
Deal JSON + Underwriting Model TEMPLATE.xlsx -> filled underwriting model.

No underwriting math lives here - every formula (NOI, IRR, exit scenarios, the
price solver, comp fairness scoring) already lives in the template. This
script's only job is writing deal data into the right cells. See SCHEMA.md
for the full field-to-cell mapping this implements.

Usage:
    python generator.py sample_deal.json "Elms of Brook Park.xlsx"
"""
import json
import sys
from datetime import date, datetime
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

HERE = Path(__file__).parent
TEMPLATE_PATH = HERE.parent / "Underwriting Model TEMPLATE.xlsx"

# ---------- scalar field -> named range ----------
SCALAR_MAP = {
    ("property", "name"): "PropertyName",
    ("property", "address"): "Address",
    ("property", "year_built"): "YearBuilt",
    ("property", "site_acres"): "SiteAcres",
    ("property", "units"): "Units",

    ("assumptions", "purchase_cap_rate"): "PurchaseCapRate",
    ("assumptions", "purchase_price_override"): "PriceOverride",
    ("assumptions", "value_add_units"): "ValueAddUnits",
    ("assumptions", "value_add_premium_per_unit_month"): "PremiumPerUnit",
    ("assumptions", "ltv"): "Ltv",
    ("assumptions", "loan_interest_rate"): "LoanInterestRate",
    ("assumptions", "hold_period_years"): "HoldPeriodYears",
    ("assumptions", "exit_cap_rate"): "ExitCapRate",
    ("assumptions", "income_growth"): "IncomeGrowth",
    ("assumptions", "expense_growth"): "ExpenseGrowth",
    ("assumptions", "tax_growth"): "TaxGrowth",
    ("assumptions", "bad_debt_pct"): "BadDebt",
    ("assumptions", "management_fee_pct_egi"): "ManagementFeeOfEgi",
    ("assumptions", "asset_management_fee_pct_egi"): "AssetManagementFeeOfEgi",
    ("assumptions", "additional_other_income"): "AdditionalOtherIncome",
    ("assumptions", "stabilized_occupancy_target"): "StabilizedOccupancyTarget",
    # NOTE: concessions are now a model-computed dollar amount (Inputs "Concessions
    # (annual $)"), driven by the two adjustable factor rows — so we deliberately do
    # NOT map a deal-supplied other_rental_deduction_pct here; writing it would clobber
    # the formula. The "Year Occupancy Stabilizes" input row was removed on 2026-07-20.
    ("assumptions", "interior_renovation_cost_per_unit"): "InteriorRenovationCostUnit",
    ("assumptions", "common_exterior_capex"): "CommonExteriorCapex",
    ("assumptions", "misc_expense_annual"): "MiscellaneousExpenseAnnual",
    ("assumptions", "units_renovated_per_month"): "UnitsRenovatedPerMonth",
    ("assumptions", "irr_target"): "IrrTarget",

    ("t12", "gross_potential_rent"): "T12_GPR",
    ("t12", "net_operating_income"): "T12_NOI",
    ("t12", "effective_gross_income"): "T12_EGI",
    ("t12", "total_operating_expenses"): "T12_OpEx",
    ("t12", "other_income"): "T12_OtherIncome",
    ("t12", "insurance"): "T12_Insurance",
    ("t12", "utilities"): "T12_Utilities",
    ("t12", "controllable_expenses"): "T12_Controllable",
    ("t12", "property_taxes_actual"): "T12_Taxes",

    ("tax", "current_taxable_value"): "Tax_TaxableValue",
    ("tax", "current_millage_rate"): "Tax_Millage",
    ("tax", "non_ad_valorem_tax"): "Tax_NonAdValorem",
    ("tax", "county_pin"): "Tax_PIN",
    ("tax", "reassessment_on_sale_pct"): "Tax_ReassessPct",

    ("rent_roll", "as_of_date"): "RR_AsOf",
    ("rent_roll", "official_units"): "RR_OfficialUnits",
    ("rent_roll", "official_occupied_units"): "RR_OfficialOccupied",
    ("rent_roll", "official_vacant_units"): "RR_OfficialVacant",
    ("rent_roll", "official_occupancy"): "RR_OfficialOccupancy",
}

# assumptions fields without a "matching camel-case" named range are covered
# above explicitly; remaining Inputs assumptions (refi terms, targets, etc.)
ASSUMPTIONS_LABEL_MAP = {
    "refi_cap_rate": "Refi Cap Rate",
    "refi_ltv": "Refi LTV",
    "refi_closing_cost_pct": "Refi Closing Cost %",
    "refi_interest_rate": "Refi Interest Rate",
    "loss_to_lease_capture_year1_pct": "Loss-to-Lease Capture in Year 1 %",
    "amortization_period_years": "Amortization Period",
    "upfront_closing_cost_pct": "Closing Cost",
    "disposition_cost_pct": "Disposition / Closing Cost at Exit",
    "year2_cash_on_cash_target": "Year 2 Cash-on-Cash Target",
    # 2026-07-22: single downtime input (Inputs row 32) replaced the old
    # "Renovation Duration (months)" + "Extra Downtime Months per Renovated Unit"
    # pair — the duration row never touched a dollar, downtime was the only one
    # charged. Old deal JSONs are normalized in write_scalars().
    "renovation_downtime_months": "Renovation Downtime (months of rent lost per renovated unit)",
    "renovation_online_start_month": "Renovation Online Start Month",
    # 2026-08-10 house benchmarks that don't fit the Pro Forma benchmark column.
    # Turnover is quoted per TURNED unit, so it lives on Inputs and the Pro Forma
    # converts it with the turn share; reserves are a below-NOI capital item with
    # no operating line; the opex cap is a Checks ceiling, not an input to a
    # formula. See scripts/applyHouseBenchmarks.py for the reasoning.
    "benchmark_turnover_per_turned_unit": "Turnover / Make-Ready Benchmark ($ per TURNED unit)",
    "unit_turnover_rate": "Share of Units Turning / Year",
    "replacement_reserves_per_unit_yr": "Replacement Reserves ($/unit/yr)",
    "max_opex_pct_egi": "Max Total Opex as % of EGI",
}

# Benchmarks (2026-07-22, the team; 2026-08-03 switched to per YEAR): OUR
# $/unit/year numbers. 0 = unused, so the line falls back to the T12 figure; a
# value > 0 makes the model use benchmark x units from Year 1 on. Kept in
# deal.assumptions as benchmark_* so the review-screen form pipeline carries
# them for free. Written by Pro Forma row label -> the benchmark column, which
# the 8-year layout moved off the middle of the sheet to the right of Year 8 —
# so it's found by header text, not a hardcoded column letter.
#
# 2026-08-13: the template now SHIPS the house numbers (R&M 750, payroll 1250,
# insurance 1100 — the team 2026-08-10) in that column, so "field absent" and
# "field set to 0" stopped meaning the same thing. Absent leaves the house
# number alone; an explicit 0 clears the cell and puts the line back on T12.
#
# Turnover is deliberately NOT in this map. the house quotes it per TURNED unit
# ($330), and the column multiplies by total units — so the template holds a
# formula there (Inputs turnover benchmark x share of units turning) and the
# deal drives it through benchmark_turnover_per_turned_unit on Inputs instead.
# Writing a plain number here would overwrite that formula.
PROFORMA_BENCHMARK_MAP = {
    "benchmark_repairs_maintenance": "Repairs & Maintenance",
    "benchmark_labor": "Labor Costs (Payroll)",
    "benchmark_advertising": "Advertising & Promotions",
    "benchmark_general_admin": "General & Administrative",
    "benchmark_utilities": "Utility Costs",
    "benchmark_insurance": "Insurance and Bonds",
    "benchmark_property_taxes": "Property Taxes",
    "benchmark_other_property_expenses": "Other Property Expenses",
    "benchmark_management_fee": "Management Fee",
    "benchmark_asset_management_fee": "Asset Management Fee",
}

# T12 fields with no named range: located by exact row label. Most are
# reference-only, but other_property_expenses IS formula-driven — Pro Forma
# grows it 3%/yr (gap caught by the reference acceptance test, 2026-07-13).
# Controllable sub-sections (2026-07-22 split): each is written to its T12
# Actuals sub row whenever the parsed deal carries it — partial breakdowns
# included. The Controllable total is always written as a value from
# T12_Controllable (SCALAR_MAP), so the Pro Forma's "Other Controllable
# (unallocated)" line absorbs whatever the sub rows don't cover.
T12_SUB_LABEL_MAP = {
    "repairs_maintenance": "Repairs & Maintenance",
    "turnover_costs": "Turnover Costs",
    "labor_costs": "Labor Costs (Payroll)",
    "advertising_promotions": "Advertising & Promotions",
    "general_admin": "General & Administrative",
}

T12_LABEL_MAP = {
    "vacancy_concessions_bad_debt": "Less: vacancy, concessions, bad debt",
    "net_rental_income": "Net Rental Income",
    "management_fee_actual": "Management Fee - actual T12",
    "other_property_expenses": "Other Property Expenses",
    "actual_vacancy_loss": "Actual Vacancy Loss",
    "actual_bad_debt": "Actual Bad Debt - net",
    "actual_concessions": "Actual Concessions - net",
}

# Tax tab fields with no named range: located by exact row label.
TAX_LABEL_MAP = {
    "site_address": "Site Address",
    "t12_property_tax_expense": "T12 Property Tax Expense",
}

RENT_ROLL_COLUMNS = [
    "unit_number", "unit_type", "sqft", "resident_id", "resident_name",
    "market_rent", "rent_charge", "total_charges", "move_in",
    "lease_expiration", "move_out", "balance", "occupied_flag",
]


def find_row(ws, text, col=1, max_row=250, exact=False, required=True):
    for r in range(1, max_row + 1):
        v = ws.cell(row=r, column=col).value
        if v is None:
            continue
        v = str(v)
        if (v == text) if exact else (text in v):
            return r
    if required:
        raise ValueError(f"label '{text}' not found on {ws.title}")
    return None


def find_col(ws, text, row=5, max_col=40, required=True):
    for c in range(1, max_col + 1):
        v = ws.cell(row=row, column=c).value
        if v is not None and text in str(v):
            return c
    if required:
        raise ValueError(f"header '{text}' not found on row {row} of {ws.title}")
    return None


def resolve_named_range(wb, name):
    dn = wb.defined_names[name]
    dests = list(dn.destinations)
    if not dests:
        raise ValueError(f"named range '{name}' has no destination")
    sheet_name, coord = dests[0]
    return wb[sheet_name], coord.replace("$", "")


def to_excel_value(v):
    """openpyxl wants real date objects, not ISO strings, for date-typed cells."""
    if isinstance(v, str) and len(v) == 10 and v[4] == "-" and v[7] == "-":
        try:
            return datetime.strptime(v, "%Y-%m-%d").date()
        except ValueError:
            return v
    return v


def write_scalars(wb, deal, warnings):
    # Any controllable sub-section the deal carries gets written (2026-08-03: it
    # used to be all-five-or-nothing, which silently blanked Pro Forma rows 16-20
    # whenever one section was missing). The Controllable total is then written as
    # a VALUE rather than left as =SUM(subs), so whatever the sections don't
    # account for lands on the Pro Forma's "Other Controllable (unallocated)" line
    # instead of quietly vanishing from total opex.
    has_sub_breakdown = any(
        deal.get("t12", {}).get(f) is not None for f in T12_SUB_LABEL_MAP)
    for (section, field), range_name in SCALAR_MAP.items():
        if section not in deal or field not in deal[section]:
            continue
        ws, coord = resolve_named_range(wb, range_name)
        ws[coord] = to_excel_value(deal[section][field])

    assumptions = deal.get("assumptions", {})
    if assumptions:
        # back-compat: pre-2026-07-22 deals carried extra_downtime_months_per_unit
        # (the charged number) + renovation_duration_months (display only). The
        # charged number IS the new single downtime input, so old deals reproduce
        # their economics exactly.
        if ("renovation_downtime_months" not in assumptions
                and "extra_downtime_months_per_unit" in assumptions):
            assumptions["renovation_downtime_months"] = \
                assumptions["extra_downtime_months_per_unit"]
        inp = wb["Inputs"]
        for field, label in ASSUMPTIONS_LABEL_MAP.items():
            if field in assumptions:
                # try an exact row-label match first so short labels (e.g. "Closing
                # Cost") don't accidentally match a longer label that contains them
                # as a substring (e.g. "Disposition / Closing Cost at Exit").
                r = find_row(inp, label, exact=True, required=False)
                if r is None:
                    r = find_row(inp, label, exact=False, required=False)
                if r is None:
                    # a renamed/removed Inputs row must not sink the whole model —
                    # leave the template default in place and flag it for review.
                    warnings.append(f"Inputs row '{label}' not found — kept template "
                                    f"default, skipped assumption '{field}'.")
                    continue
                inp.cell(row=r, column=2).value = assumptions[field]

    if assumptions:
        pf = wb["Pro Forma"]
        bench_col = find_col(pf, "Benchmark", required=False)
        if bench_col is None:
            warnings.append("Pro Forma benchmark column not found — every expense "
                            "benchmark was skipped and the model ran on T12 figures.")
        else:
            for field, label in PROFORMA_BENCHMARK_MAP.items():
                if field not in assumptions:
                    continue  # not reviewed → keep the template's house number
                val = assumptions[field]
                r = find_row(pf, label, exact=True, required=False)
                if r is None:
                    warnings.append(f"Pro Forma row '{label}' not found — skipped "
                                    f"benchmark '{field}'.")
                    continue
                # $/unit/YEAR; an explicit 0 empties the cell so the Pro Forma's
                # IF($M..>0, ...) falls back to the T12 figure for that line.
                pf.cell(row=r, column=bench_col).value = val if val else None

    t12_data = deal.get("t12", {})
    if t12_data:
        t12 = wb["T12 Actuals"]
        if has_sub_breakdown:
            for field, label in T12_SUB_LABEL_MAP.items():
                if t12_data.get(field) is None:
                    continue
                r = find_row(t12, label, exact=True, required=False)
                if r is None:
                    warnings.append(f"T12 Actuals row '{label}' not found — "
                                    f"skipped '{field}'.")
                    continue
                t12.cell(row=r, column=2).value = t12_data[field]
            missing = [f for f in T12_SUB_LABEL_MAP if t12_data.get(f) is None]
            if missing:
                warnings.append(
                    "T12 controllable breakdown is partial (missing: "
                    + ", ".join(missing)
                    + "). The unbroken remainder shows on the Pro Forma's "
                      "'Other Controllable (unallocated)' line.")
        for field, label in T12_LABEL_MAP.items():
            if field in t12_data:
                r = find_row(t12, label, exact=True, required=False)
                if r is None:
                    warnings.append(f"T12 Actuals row '{label}' not found — "
                                    f"skipped '{field}'.")
                    continue
                t12.cell(row=r, column=2).value = t12_data[field]

    tax_data = deal.get("tax", {})
    if tax_data:
        tax = wb["Tax"]
        for field, label in TAX_LABEL_MAP.items():
            if field in tax_data:
                r = find_row(tax, label, exact=True, required=False)
                if r is None:
                    warnings.append(f"Tax row '{label}' not found — skipped '{field}'.")
                    continue
                tax.cell(row=r, column=2).value = tax_data[field]


def write_rent_roll(wb, deal):
    units = deal.get("rent_roll", {}).get("units", [])
    if not units:
        return
    rr = wb["Rent Roll"]
    _, anchor = resolve_named_range(wb, "RentRoll_FirstDataRow")
    first_row = int("".join(ch for ch in anchor if ch.isdigit()))
    for i, u in enumerate(units):
        row = first_row + i
        for j, col in enumerate(RENT_ROLL_COLUMNS, start=1):
            rr.cell(row=row, column=j).value = to_excel_value(u.get(col))
    return first_row, len(units)


def write_unit_mix(wb, deal):
    """Derive Unit Mix from rent_roll.units grouped by unit_type - not a JSON field."""
    units = deal.get("rent_roll", {}).get("units", [])
    if not units:
        return
    groups = {}
    for u in units:
        t = u.get("unit_type", "?")
        g = groups.setdefault(t, {"units": 0, "occupied": 0, "sqft_sum": 0.0,
                                   "market_rent_sum": 0.0, "inplace_rent_sum": 0.0})
        g["units"] += 1
        occ = int(u.get("occupied_flag") or 0)
        g["occupied"] += occ
        g["sqft_sum"] += float(u.get("sqft") or 0)
        g["market_rent_sum"] += float(u.get("market_rent") or 0)
        g["inplace_rent_sum"] += float(u.get("rent_charge") or 0)

    um = wb["Unit Mix"]
    _, anchor = resolve_named_range(wb, "UnitMix_FirstDataRow")
    first_row = int("".join(ch for ch in anchor if ch.isdigit()))
    for i, (unit_type, g) in enumerate(sorted(groups.items())):
        row = first_row + i
        vacant = g["units"] - g["occupied"]
        avg_sqft = g["sqft_sum"] / g["units"] if g["units"] else 0
        avg_market = g["market_rent_sum"] / g["units"] if g["units"] else 0
        avg_inplace = g["inplace_rent_sum"] / g["occupied"] if g["occupied"] else 0
        um.cell(row=row, column=1).value = unit_type
        um.cell(row=row, column=2).value = g["units"]
        um.cell(row=row, column=3).value = g["occupied"]
        um.cell(row=row, column=4).value = vacant
        um.cell(row=row, column=5).value = round(avg_sqft, 1)
        um.cell(row=row, column=6).value = round(avg_market, 2)
        um.cell(row=row, column=7).value = round(avg_inplace, 2)
        um.cell(row=row, column=8).value = round(g["market_rent_sum"], 2)
        um.cell(row=row, column=9).value = round(g["inplace_rent_sum"], 2)
        um.cell(row=row, column=10).value = (
            "Calculated by grouping unit-level rent roll rows by unit type."
        )
    # The template's summary row sums B6:B25 - the first 20 unit types. A property with more types
    # (Overlook Sandy Run 39, Estates at Fairway Green 64, 2026-10-22) got a TOTAL UNITS of 351 / 102
    # and a blended size and rent computed on part of the building, which also fed the Dashboard's average
    # unit size and the subject row on Rent Comps. The summary now spans every type row written.
    last_row = max(first_row + len(groups) - 1, first_row + 19)
    rng = lambda col: f"{col}{first_row}:{col}{last_row}"
    um["A2"].value = f"=SUM({rng('B')})"
    for cell, col in (("B2", "E"), ("C2", "F"), ("D2", "G")):
        um[cell].value = f"=IFERROR(SUMPRODUCT({rng('B')},{rng(col)})/SUM({rng('B')}),0)"
    return first_row, len(groups)


def write_t12_raw_detail(wb, deal):
    rows = deal.get("t12", {}).get("raw_monthly_detail", [])
    if not rows:
        return
    t12 = wb["T12 Actuals"]
    _, anchor = resolve_named_range(wb, "T12_RawFirstRow")
    first_row = int("".join(ch for ch in anchor if ch.isdigit()))
    # month labels: the template header row ships with static placeholder months,
    # so overwrite with the statement's own labels when the parse supplied them
    headers = deal.get("t12", {}).get("month_headers") or []
    for j, h in enumerate(headers[:12], start=4):
        if h:
            t12.cell(row=first_row - 1, column=j).value = h
    for i, item in enumerate(rows):
        row = first_row + i
        t12.cell(row=row, column=1).value = item.get("source_row")
        t12.cell(row=row, column=2).value = item.get("account")
        t12.cell(row=row, column=3).value = item.get("label")
        for j, m in enumerate(item.get("months", []), start=4):
            t12.cell(row=row, column=j).value = m
        # Total column (P): formula, not Python math, per the no-math rule
        t12.cell(row=row, column=16).value = f"=SUM(D{row}:O{row})"


def write_comp_table(ws, header_label, stop_label_or_row, comps, columns, stop_exact=True):
    hdr = find_row(ws, header_label, exact=True)
    if isinstance(stop_label_or_row, str):
        stop_row = find_row(ws, stop_label_or_row, exact=stop_exact)
    else:
        stop_row = stop_label_or_row
    available = stop_row - (hdr + 1)
    if len(comps) > available:
        raise ValueError(
            f"{ws.title}: {len(comps)} comps supplied but only {available} "
            f"placeholder rows exist between row {hdr+1} and {stop_row}"
        )
    for i, comp in enumerate(comps):
        row = hdr + 1 + i
        for j, col in enumerate(columns, start=1):
            if col in comp:
                ws.cell(row=row, column=j).value = to_excel_value(comp[col])


def write_rent_comps(wb, deal):
    comps = deal.get("rent_comps", [])
    if not comps:
        return
    rc = wb["Rent Comps"]
    subj = find_row(rc, "(subject)", exact=False)
    columns = ["property_name", "address_market", "units", "year_built",
               "avg_unit_size_sf", "market_rent", "achieved_rent", "rent_psf",
               None, "source_status", "notes", "occupancy", "fair_comp_verdict"]
    hdr = subj  # comps start right after the subject row
    stop = find_row(rc, "COMP SET AVERAGE", exact=False)
    for i, comp in enumerate(comps):
        row = subj + 1 + i
        if row >= stop:
            raise ValueError(f"Rent Comps: {len(comps)} comps supplied but only "
                              f"{stop - subj - 1} placeholder rows exist")
        for j, col in enumerate(columns, start=1):
            if col and col in comp:
                rc.cell(row=row, column=j).value = to_excel_value(comp[col])


def write_sale_comps(wb, deal):
    comps = deal.get("sale_comps", [])
    if not comps:
        return
    sc = wb["Sale Comps"]
    columns = ["property_name", "location", "units", "year_built", "sale_date",
               "sale_price", "price_per_unit", "buyer_seller", "source",
               "fair_comp_verdict", "notes"]
    write_comp_table(sc, "Property", "Subject (for reference)", comps, columns, stop_exact=True)


def fill_display_gaps(wb, deal, warnings):
    """No template placeholder survives into a model someone is sent.

    2026-09-24, Harbor Row (two buildings): the model went out with
    "[YEAR]" on the Dashboard, "[PIN]" / "[ADDRESS]" on Tax, and a market
    occupancy of 0% — each a field that is simply absent for a portfolio (two
    build years, two parcels) or for an OM whose comps carry no occupancy.
    """
    prop = deal.get("property", {}) or {}
    tax = deal.get("tax", {}) or {}
    # Year built: display-only (Dashboard B4, comp subject rows), so a portfolio
    # can carry a label such as "1924 (210-216 Elm St) / 1962 (Ridge)".
    if prop.get("year_built") in (None, ""):
        ws, coord = resolve_named_range(wb, "YearBuilt")
        ws[coord] = prop.get("year_built_label") or "—"
    if prop.get("address") in (None, ""):
        ws, coord = resolve_named_range(wb, "Address")
        ws[coord] = "—"
    t = wb["Tax"]
    if str(t["B6"].value or "").startswith("["):
        t["B6"] = tax.get("county_pin") or "Not in OM — confirm with the county"
    if str(t["B7"].value or "").startswith("["):
        t["B7"] = tax.get("site_address") or prop.get("address") or "—"
    # Market occupancy: the Dashboard reads the comp-set average. With no comp
    # occupancy that average was IFERROR(…,0) = "0%" — a claim, not a gap. Use
    # the online area search when there is one, and say so; otherwise "n/a".
    # Unused comp rows keep the template's "[Comp 4]" / "[Sale comp 5]" labels.
    import re as _re
    for name in ("Rent Comps", "Sale Comps"):
        ws_c = wb[name]
        for r in range(1, 40):
            v = ws_c.cell(row=r, column=1).value
            if isinstance(v, str) and _re.fullmatch(r"\[(Sale )?[Cc]omp \d+\]", v.strip()):
                ws_c.cell(row=r, column=1).value = None
    rc = wb["Rent Comps"]
    avg_row = find_row(rc, "COMP SET AVERAGE", exact=False, required=False)
    comps_have_occ = any((c or {}).get("occupancy") not in (None, "", 0) for c in deal.get("rent_comps", []) or [])
    if avg_row and not comps_have_occ:
        mkt = deal.get("market", {}) or {}
        dash = wb["Dashboard"]
        label_row = find_row(dash, "Market Avg Occupancy", exact=False, required=False)
        if isinstance(mkt.get("occupancy"), (int, float)) and mkt["occupancy"] > 0:
            rc.cell(row=avg_row, column=12).value = float(mkt["occupancy"])
            src = mkt.get("market") or "area search"
            for r in range(1, 12):   # the headline tile's caption
                for c in range(1, 9):
                    if dash.cell(row=r, column=c).value == "MARKET OCC (OM COMPS)":
                        dash.cell(row=r, column=c).value = "MARKET OCC (AREA SEARCH)"
            if label_row:
                dash.cell(row=label_row, column=1).value = "Market Avg Occupancy (area search)"
                dash.cell(row=label_row, column=3).value = (
                    f"OM comps publish no occupancy — online area figure: {src}"
                    + (f", {mkt['as_of']}" if mkt.get("as_of") else "")
                    + (f". Source: {mkt['source_url']}" if mkt.get("source_url") else "."))
        else:
            rc.cell(row=avg_row, column=12).value = '=IFERROR(AVERAGE(L7:L11),"n/a")'


PB_T12_ROWS = [
    # (label, t12 field, is_subtotal)
    ("Gross Potential Rent", "gross_potential_rent", False),
    ("Less: vacancy, concessions, bad debt", "vacancy_concessions_bad_debt", False),
    ("Net Rental Income", "net_rental_income", True),
    ("Other Income", "other_income", False),
    ("Effective Gross Income (EGI)", "effective_gross_income", True),
    ("Controllable Expenses", "controllable_expenses", False),
    ("Utilities", "utilities", False),
    ("Management Fee - actual T12", "management_fee_actual", False),
    ("Insurance", "insurance", False),
    ("Property Taxes - actual T12", "property_taxes_actual", False),
    ("Other Property Expenses", "other_property_expenses", False),
    ("Total Operating Expenses", "total_operating_expenses", True),
    ("Net Operating Income (NOI)", "net_operating_income", True),
]


def write_portfolio_breakdown(wb, deal, warnings):
    """One column per property + a Total, for a deal made of several buildings.

    2026-09-25 (The owner): a multi-property deal generated one combined model, so
    nothing showed what each building contributes. The rent-roll half is live
    formulas over the Rent Roll tab (units there are labelled "<property> · <unit>"),
    so it moves if a unit row is edited; the T12 half is each owner statement as
    read. Both halves tie their Total column back to the model's own tabs.
    """
    props = [p for p in (deal.get("properties") or []) if p and p.get("name")]
    if len(props) < 2:
        return
    ws = wb.create_sheet("Portfolio Breakdown", index=1)
    navy, pale, grey = "1F4E78", "F0F5FA", "F2F2F2"
    thin = Side(style="thin", color="D9D9D9")
    money = '$#,##0;[Red]($#,##0);-'
    n = len(props)
    tot_col = 2 + n
    chk_col = tot_col + 1
    last = 1 + n                      # last property column index

    ws["A1"] = "Portfolio Breakdown - by property"
    ws["A1"].font = Font(name="Carlito", size=18, bold=True, color="FFFFFF")
    for c in range(1, chk_col + 1):
        ws.cell(row=1, column=c).fill = PatternFill("solid", fgColor=navy)
    ws["A2"] = ("Each building on its own, then the portfolio. Rent-roll lines are live formulas over the "
                "Rent Roll tab; T12 lines are each owner's statement as uploaded. The Check column ties "
                "every Total back to the model's own tabs.")
    ws["A2"].alignment = Alignment(wrap_text=True, vertical="top")
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=chk_col)
    ws.row_dimensions[2].height = 30

    def header(row, text):
        ws.cell(row=row, column=1, value=text).font = Font(bold=True, color="FFFFFF")
        for c in range(1, chk_col + 1):
            ws.cell(row=row, column=c).fill = PatternFill("solid", fgColor=navy)

    r = 4
    ws.cell(row=r, column=1, value="Metric")
    for i, p in enumerate(props):
        ws.cell(row=r, column=2 + i, value=p["name"])
    ws.cell(row=r, column=tot_col, value="Portfolio Total")
    ws.cell(row=r, column=chk_col, value="Check vs model")
    for c in range(1, chk_col + 1):
        cell = ws.cell(row=r, column=c)
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor=pale)
        cell.alignment = Alignment(horizontal="center" if c > 1 else "left", wrap_text=True)
        cell.border = Border(bottom=thin)

    # ── Property facts ───────────────────────────────────────────────
    r += 1
    header(r, "Property")
    for label, key in (("Address", "address"), ("Year built", "year_built"),
                       ("Rent roll source", "rent_roll_file"), ("T12 source", "t12_file"),
                       ("T12 period / basis", "t12_period")):
        r += 1
        ws.cell(row=r, column=1, value=label)
        for i, p in enumerate(props):
            v = p.get(key)
            ws.cell(row=r, column=2 + i, value=to_excel_value(v) if v not in (None, "") else "—")
            ws.cell(row=r, column=2 + i).alignment = Alignment(wrap_text=True, horizontal="center")

    # ── Rent roll, live off the Rent Roll tab ─────────────────────────
    _, anchor_cell = resolve_named_range(wb, "RentRoll_FirstDataRow")
    first = int("".join(ch for ch in anchor_cell if ch.isdigit()))
    n_units = len((deal.get("rent_roll") or {}).get("units") or [])
    lastrow = first + max(n_units, 1) + 50
    rng = lambda col: f"'Rent Roll'!${col}${first}:${col}${lastrow}"
    r += 2
    header(r, "Rent roll (live from the Rent Roll tab)")
    rr_rows = {}
    def rr_line(label, fmt, per_prop, total, check=None):
        nonlocal r
        r += 1
        rr_rows[label] = r
        ws.cell(row=r, column=1, value=label)
        for i, p in enumerate(props):
            key = f'"{p["name"]} · *"'
            ws.cell(row=r, column=2 + i, value=per_prop(key, 2 + i)).number_format = fmt
        ws.cell(row=r, column=tot_col, value=total).number_format = fmt
        ws.cell(row=r, column=tot_col).font = Font(bold=True)
        if check:
            ws.cell(row=r, column=chk_col, value=check)
    L = lambda c: ws.cell(row=1, column=c).column_letter
    span = lambda row: f"{L(2)}{row}:{L(last)}{row}"
    rr_line("Units", "0", lambda k, c: f"=COUNTIF({rng('A')},{k})", None)
    ws.cell(row=r, column=tot_col, value=f"=SUM({span(r)})")
    ws.cell(row=r, column=chk_col, value=f'=IF({L(tot_col)}{r}=COUNTA({rng("A")}),"OK - ties to Rent Roll","CHECK: "&COUNTA({rng("A")})&" on Rent Roll")')
    u = r
    rr_line("Occupied units", "0", lambda k, c: f"=SUMIFS({rng('M')},{rng('A')},{k})", None)
    ws.cell(row=r, column=tot_col, value=f"=SUM({span(r)})")
    o = r
    rr_line("Occupancy", "0.0%", lambda k, c: f"=IFERROR({L(c)}{o}/{L(c)}{u},0)", f"=IFERROR({L(tot_col)}{o}/{L(tot_col)}{u},0)")
    rr_line("In-place rent / month", money, lambda k, c: f"=SUMIFS({rng('G')},{rng('A')},{k})", None)
    ws.cell(row=r, column=tot_col, value=f"=SUM({span(r)})")
    ws.cell(row=r, column=chk_col, value=f'=IF(ABS({L(tot_col)}{r}-SUM({rng("G")}))<1,"OK - ties to Rent Roll","CHECK")')
    ip = r
    rr_line("Market rent / month", money, lambda k, c: f"=SUMIFS({rng('F')},{rng('A')},{k})", None)
    ws.cell(row=r, column=tot_col, value=f"=SUM({span(r)})")
    mk = r
    rr_line("Loss-to-lease / month", money, lambda k, c: f"={L(c)}{mk}-{L(c)}{ip}", f"={L(tot_col)}{mk}-{L(tot_col)}{ip}")
    rr_line("Avg in-place rent / occupied unit", money, lambda k, c: f"=IFERROR({L(c)}{ip}/{L(c)}{o},0)", f"=IFERROR({L(tot_col)}{ip}/{L(tot_col)}{o},0)")
    rr_line("Rentable SF", "#,##0", lambda k, c: f"=SUMIFS({rng('C')},{rng('A')},{k})", None)
    ws.cell(row=r, column=tot_col, value=f"=SUM({span(r)})")
    rr_line("Share of portfolio units", "0.0%", lambda k, c: f"=IFERROR({L(c)}{u}/{L(tot_col)}{u},0)", f"=IFERROR({L(tot_col)}{u}/{L(tot_col)}{u},0)")

    # ── T12, each owner statement ─────────────────────────────────────
    r += 2
    header(r, "T12 (each owner statement as uploaded)")
    t12 = wb["T12 Actuals"]
    t12_rows = {}
    for label, field, bold in PB_T12_ROWS:
        r += 1
        t12_rows[field] = r
        ws.cell(row=r, column=1, value=label)
        for i, p in enumerate(props):
            v = (p.get("t12") or {}).get(field)
            ws.cell(row=r, column=2 + i, value=v if isinstance(v, (int, float)) else 0).number_format = money
        ws.cell(row=r, column=tot_col, value=f"=SUM({span(r)})").number_format = money
        src = find_row(t12, label, exact=True, required=False)
        if src:
            ws.cell(row=r, column=chk_col,
                    value=f'=IF(ABS({L(tot_col)}{r}-\'T12 Actuals\'!$B${src})<1,"OK - ties to T12 tab","CHECK: T12 tab "&TEXT(\'T12 Actuals\'!$B${src},"$#,##0"))')
        if bold:
            for c in range(1, tot_col + 1):
                ws.cell(row=r, column=c).font = Font(bold=True)
                ws.cell(row=r, column=c).border = Border(top=thin)
    noi, opex, egi = t12_rows["net_operating_income"], t12_rows["total_operating_expenses"], t12_rows["effective_gross_income"]
    for label, fn, fmt in (
        ("NOI / unit", lambda c: f"=IFERROR({L(c)}{noi}/{L(c)}{u},0)", money),
        ("OpEx / unit", lambda c: f"=IFERROR({L(c)}{opex}/{L(c)}{u},0)", money),
        ("Expense ratio (OpEx / EGI)", lambda c: f"=IFERROR({L(c)}{opex}/{L(c)}{egi},0)", "0.0%"),
        ("Share of portfolio NOI", lambda c: f"=IFERROR({L(c)}{noi}/{L(tot_col)}{noi},0)", "0.0%"),
    ):
        r += 1
        ws.cell(row=r, column=1, value=label)
        for c in range(2, tot_col + 1):
            ws.cell(row=r, column=c, value=fn(c)).number_format = fmt

    r += 2
    ws.cell(row=r, column=1, value=("Returns, pricing and the pro forma are underwritten on the portfolio as one deal "
                                     "(Dashboard, Pro Forma, Exit Scenarios). Per-property T12 lines are the owners' "
                                     "figures; the model's Year 1 expenses use house benchmarks on the combined units."))
    ws.cell(row=r, column=1).alignment = Alignment(wrap_text=True, vertical="top")
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=chk_col)
    ws.row_dimensions[r].height = 32

    ws.column_dimensions["A"].width = 36
    for c in range(2, tot_col + 1):
        ws.column_dimensions[L(c)].width = 22
    ws.column_dimensions[L(chk_col)].width = 26
    ws.freeze_panes = "B5"
    for row in ws.iter_rows(min_row=5, max_row=r):
        for cell in row:
            if cell.column > 1 and cell.alignment.horizontal is None:
                cell.alignment = Alignment(horizontal="right")


def patch_template_guardrails(wb, warnings):
    """Patch stale template text/formulas that must be deal-agnostic.

    Since 2026-07-15 every tab has a SINGLE Notes column (Inputs/T12/Tax/D&E
    use C, Checks uses D) — write merged where/how/why text there only.
    """
    inp = wb["Inputs"]
    inp["C10"] = "OM / public record. Text label only."
    inp["C23"] = "Modeling assumption; verify local tax limits. Tax forecast grows by this rate after reassessment."
    inp["C25"] = "Calculated from rent roll. Vacancy % = 1 - official rent-roll occupancy."

    tax = wb["Tax"]
    tax["A1"] = "Property Tax Forecast"
    tax["C6"] = "County / public tax record. Used to verify parcel."
    tax["C7"] = "County / public tax record. Used to confirm subject property."
    tax["C8"] = "County tax record / OM tax page. Current county taxable value."
    tax["C9"] = "County tax record / OM tax page. Ad valorem tax = taxable value x millage / 1,000 where applicable."
    tax["C10"] = "County tax record / OM tax page. Added to ad valorem tax estimate."
    tax["B11"] = '=IF(OR($B$8<=0,$B$9<=0),$B$13,$B$8*$B$9/1000)'
    tax["B12"] = '=IF(OR($B$8<=0,$B$9<=0),$B$13,$B$11+$B$10)'
    tax["B15"] = '=IF(OR($B$8<=0,$B$9<=0),$B$13,$B$14*$B$9/1000)'
    tax["B16"] = '=IF(OR($B$8<=0,$B$9<=0),$B$13,$B$15+$B$10)'
    tax["A18"] = "Tax Rule Note"
    tax["B18"] = (
        "Reassessment on sale varies by state - set B19 accordingly. Some states "
        "reset to market value on a change of ownership (e.g. Florida non-homestead "
        "commercial, FS 193.1555): use 100%. Others do not - New Jersey bars "
        "reassessing a property solely because it sold (Township of West Milford v. "
        "Van Decker), so assessments move only on a district-wide revaluation: use 0% "
        "for the base case, or 100% together with the EQUALIZED value and the "
        "EFFECTIVE (equalized) millage to model a revaluation landing at market. "
        "If taxable value/millage are unavailable, the model uses actual T12 property "
        "tax grown by the tax-growth assumption instead of assuming $0."
    )
    tax["C18"] = ("Confirm the rule for THIS jurisdiction before relying on Year 1 tax. "
                  "The automated tax lookup writes its finding into B26.")
    # Reassessment policy, added 2026-08-20. Default 100% reproduces the old
    # hardcoded reset-to-purchase-price behaviour, so Florida deals are unchanged.
    # write_scalars runs BEFORE this patch, so only fill a blank — never clobber a
    # policy the deal actually specified.
    if tax["B19"].value is None:
        tax["B19"] = 1.0
    tax["A19"] = "Reassessment on Sale (% of Price)"
    tax["B19"].number_format = "0%"
    tax["C19"] = ("INPUT. 100% = assessment resets to the purchase price on sale. "
                  "0% = no reset; Year 1 tax holds at today's taxable value and only "
                  "grows by the tax-growth assumption. Drives this tab AND every "
                  "column of the Max Price Solver.")
    tax["B22"] = "=$B$16"
    # the forecast now runs Year 1-8 across B:I, so the note sits in J
    tax["J22"] = (
        "Year 1 applies the reassessment policy in B19 to the purchase price, then "
        "grows by tax growth through Year 8. With no taxable value or millage on "
        "file it falls back to T12 tax grown forward."
    )
    tax["A25"] = "County source URL"
    tax["B25"] = ""
    tax["A26"] = "Tax rule/source URL"
    tax["B26"] = ""

    solver = wb["Max Price Solver"]
    solver["A4"] = (
        "Each column reprices the whole deal at a different purchase cap rate: "
        "price, loan, equity, debt service, and property tax. If county tax inputs "
        "are missing, taxes fall back to actual T12 property tax grown forward. "
        "All other assumptions come from the Inputs tab."
    )
    # Solver sweep ends at the 8.00% cap column (L); higher caps are unrealistic.
    for col in range(2, 13):
        letter = solver.cell(row=13, column=col).column_letter
        solver.cell(row=13, column=col).value = (
            f'=IF(OR(Tax!$B$8<=0,Tax!$B$9<=0),Tax!$B$13,'
            f'{letter}8*Tax!$B$9/1000+Tax!$B$10)'
        )
    # IRR target via its NAMED RANGE — a hardcoded Inputs!$B$48 broke silently
    # when the 2026-07-22 row-38 deletion shifted IRR Target to B47 (B48 became
    # the Yr-2 CoC target, so the solver interpolated against 3%).
    # Located by row LABEL, not a hardcoded coordinate: the 8-year rebuild pushed
    # this block down three rows (Years 6-8 NOI), and the last time these moved
    # the hardcoded refs kept writing to whatever happened to be there.
    solved_cap = find_row(solver, "Solved Purchase Cap Rate", required=False)
    helper = find_row(solver, "Columns failing", required=False)
    irr_row = find_row(solver, "Levered IRR", exact=True, required=False)
    if solved_cap and helper and irr_row:
        h = f"B{helper}"
        solver.cell(row=solved_cap, column=2).value = (
            f'=IF({h}=0,"Below 5.50% - expand range",'
            f'IF({h}>=11,"Above 8.00% - not achievable in range",'
            f'INDEX(B7:L7,{h})+(INDEX(B7:L7,{h}+1)-INDEX(B7:L7,{h}))*'
            f'(IrrTarget-INDEX(B{irr_row}:L{irr_row},{h}))/'
            f'(INDEX(B{irr_row}:L{irr_row},{h}+1)-INDEX(B{irr_row}:L{irr_row},{h}))))'
        )
        solver.cell(row=solved_cap, column=4).value = (
            "Linear interpolation between the two caps bracketing the IRR target; "
            "if every column passes, expand the range to lower cap rates.")
    else:
        warnings.append("Max Price Solver solve block not found — kept the template's "
                        "own interpolation formula.")
    for label, note in (
        ("Max Price Per Unit", "Solved price / total units."),
        ("Discount vs Current",
         "How far below the current cap-rate-derived basis the offer must be to "
         "clear the IRR target."),
    ):
        r = find_row(solver, label, required=False)
        if r:
            solver.cell(row=r, column=4).value = note

    checks = wb["Checks"]
    checks["A12"] = "Property tax modeled"
    checks["B12"] = '=IF(Tax!$B$22>0,"OK","WARN")'
    checks["D12"] = ("Checks projected Year 1 property tax is nonzero. If only T12 tax is "
                     "available, replace with county-specific estimate when diligence supports it.")

    sale = wb["Sale Comps"]
    sale["B3"] = "MARKET MEDIAN/DOOR"
    sale["A13"] = (
        "2. Free supplemental source: county property records or recorder data "
        "can verify a known comp property's recorded sale price/date where available."
    )
    sale["A14"] = (
        "3. Broker relationships: ask active multifamily brokers and lenders for "
        "recent transaction comps in the subject submarket."
    )
    sale["A15"] = (
        "4. Public search is a supplement only; full closed-comp pricing, cap "
        "rates, buyer/seller, and financing usually require CoStar, Yardi Matrix, "
        "Crexi, broker packages, or county records."
    )


def write_tax_sources(wb, deal):
    """County-record citations from the automated tax lookup -> Tax tab.

    Runs after patch_template_guardrails (which writes the labels and blanks
    the cells) so the deal's values land on the final layout.
    """
    tax = deal.get("tax", {})
    ws = wb["Tax"]
    if tax.get("county_source_url"):
        ws["B25"] = tax["county_source_url"]
    if tax.get("tax_rule_note"):
        ws["B26"] = tax["tax_rule_note"]


# -- Exit Scenarios presentation ---------------------------------------------
# The template ships this tab with fills and number formats that drifted out of
# alignment with the data: dollar cash-flow rows carried a "0.0%" format, header
# cells were formatted as percentages, the pale-yellow fill was sprayed across
# the whole block including the Notes column, and two data rows (26 and 38)
# carried the dark-blue HEADER fill. The PASS/FLAG table - the part anyone
# actually reads - sat at the bottom with no formatting at all.
#
# This repaints the tab on every generation, so the source of truth is here in
# code rather than inside the binary template.
EXIT_HDR_FILL = PatternFill("solid", fgColor="1F4E78")
EXIT_HDR_FONT = Font(bold=True, color="FFFFFF", size=11)
EXIT_KPI_FILL = PatternFill("solid", fgColor="F0F5FA")
EXIT_NOTE_FONT = Font(italic=True, size=9, color="6B6B6B")
EXIT_PASS_FILL = PatternFill("solid", fgColor="D4EDDA")
EXIT_PASS_FONT = Font(bold=True, color="155724")
EXIT_FLAG_FILL = PatternFill("solid", fgColor="F8D7DA")
EXIT_FLAG_FONT = Font(bold=True, color="721C24")
EXIT_BEST_FILL = PatternFill("solid", fgColor="FFF2CC")
NO_FILL = PatternFill(fill_type=None)

MONEY_FMT = '$#,##0;[Red]($#,##0)'
PCT_FMT = '0.0%;[Red](0.0%)'
MULT_FMT = '0.00"x"'


def format_exit_scenarios(wb, warnings):
    """Repaint Exit Scenarios so the numbers read correctly and PASS/FLAG leads."""
    if "Exit Scenarios" not in wb.sheetnames:
        return
    ws = wb["Exit Scenarios"]
    thin = Side(style="thin", color="D9D9D9")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    # 1. wipe the scattered fills/formats across the whole used block
    for row in ws.iter_rows(min_row=1, max_row=56, min_col=1, max_col=10):
        for c in row:
            c.fill = NO_FILL
            c.number_format = "General"
            c.font = Font()
            c.alignment = Alignment(vertical="center")

    # 2. title + KPI band
    ws["A1"].fill = EXIT_HDR_FILL
    ws["A1"].font = Font(bold=True, color="FFFFFF", size=12)
    for ref in ("B2", "C2", "D2"):
        ws[ref].number_format = PCT_FMT
    for col in "ABCD":
        ws[col + "2"].fill = EXIT_KPI_FILL
        ws[col + "2"].font = Font(bold=True, size=14)
        ws[col + "2"].alignment = Alignment(horizontal="center")
        ws[col + "3"].fill = EXIT_KPI_FILL
        ws[col + "3"].font = Font(bold=True, size=9, color="1F4E78")
        ws[col + "3"].alignment = Alignment(horizontal="center")

    # 3. scenario table header
    for col in "ABCDEFGH":
        c = ws[col + "5"]
        c.fill = EXIT_HDR_FILL
        c.font = EXIT_HDR_FONT
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    # 4. scenario table body - one format per ROW, which is what was wrong before
    # Row 19 is the per-door row added 2026-08-25 — dollars, like row 8 it divides.
    row_fmt = {6: None, 7: "#,##0", 8: MONEY_FMT, 9: MONEY_FMT, 10: MONEY_FMT,
               11: MONEY_FMT, 12: MONEY_FMT, 13: MONEY_FMT, 14: PCT_FMT,
               15: MULT_FMT, 16: PCT_FMT, 17: PCT_FMT, 18: None, 19: MONEY_FMT}
    for r, fmt in row_fmt.items():
        ws.cell(row=r, column=1).font = Font(bold=True)
        for col_i in range(2, 8):
            c = ws.cell(row=r, column=col_i)
            c.border = border
            c.alignment = Alignment(horizontal="right")
            if fmt:
                c.number_format = fmt
            if r == 6 and col_i <= 4:
                c.number_format = PCT_FMT      # B6:D6 numeric; E6:G6 are text
            if r in (14, 15):
                c.font = Font(bold=True)
        ws.cell(row=r, column=8).font = EXIT_NOTE_FONT
        ws.cell(row=r, column=8).alignment = Alignment(wrap_text=True, vertical="top")

    # 5. equity cash flow block
    for col_i in range(1, 11):
        c = ws.cell(row=20, column=col_i)
        c.fill = EXIT_HDR_FILL
        c.font = EXIT_HDR_FONT
        c.alignment = Alignment(horizontal="center")
    for r in range(21, 27):
        ws.cell(row=r, column=1).font = Font(bold=True)
        for col_i in range(2, 11):
            c = ws.cell(row=r, column=col_i)
            c.number_format = MONEY_FMT
            c.border = border

    # 6. supporting calcs - all dollars, incl. B37/B38 which were formatted as %
    for ref in ("A28", "H28"):
        ws[ref].fill = EXIT_HDR_FILL
        ws[ref].font = EXIT_HDR_FONT
    for r in range(29, 40):
        ws.cell(row=r, column=2).number_format = MONEY_FMT
        ws.cell(row=r, column=8).font = EXIT_NOTE_FONT
    ws["A40"].font = Font(bold=True)
    for col_i in range(2, 10):
        c = ws.cell(row=41, column=col_i)
        c.font = Font(bold=True, size=9, color="1F4E78")
        c.alignment = Alignment(horizontal="right")
    for r in range(42, 45):
        ws.cell(row=r, column=1).font = Font(bold=True)
        for col_i in range(2, 10):
            ws.cell(row=r, column=col_i).number_format = MONEY_FMT
    ws["H40"].font = EXIT_NOTE_FONT

    # 7. RETURNS vs TARGETS - promoted to a real table with PASS/FLAG colour
    ws["A46"] = "DECISION SUMMARY - DOES EACH EXIT CLEAR OUR TARGETS?"
    for col_i in range(1, 6):
        ws.cell(row=46, column=col_i).fill = EXIT_HDR_FILL
    ws["A46"].font = Font(bold=True, color="FFFFFF", size=12)
    for col_i in range(1, 6):
        c = ws.cell(row=47, column=col_i)
        c.fill = PatternFill("solid", fgColor="DCE6F1")
        c.font = Font(bold=True, size=10, color="1F4E78")
        c.alignment = Alignment(horizontal="center")
        c.border = border
    for r in range(48, 54):
        ws.cell(row=r, column=1).font = Font(bold=True)
        ws.cell(row=r, column=2).number_format = PCT_FMT
        ws.cell(row=r, column=4).number_format = PCT_FMT
        for col_i in range(1, 6):
            ws.cell(row=r, column=col_i).border = border
            if col_i in (2, 4):
                ws.cell(row=r, column=col_i).alignment = Alignment(horizontal="right")
            if col_i in (3, 5):
                ws.cell(row=r, column=col_i).alignment = Alignment(horizontal="center")
    for col in ("C", "E"):
        rng = "%s48:%s53" % (col, col)
        ws.conditional_formatting.add(rng, FormulaRule(
            formula=['EXACT(%s48,"PASS")' % col],
            fill=EXIT_PASS_FILL, font=EXIT_PASS_FONT))
        ws.conditional_formatting.add(rng, FormulaRule(
            formula=['EXACT(%s48,"FLAG")' % col],
            fill=EXIT_FLAG_FILL, font=EXIT_FLAG_FONT))
    ws.conditional_formatting.add("A48:E53", FormulaRule(
        formula=["$B48=MAX($B$48:$B$53)"], fill=EXIT_BEST_FILL))

    ws["A55"] = "How to read this"
    ws["A55"].font = Font(bold=True)
    ws["B55"] = ("IRR is an ANNUALISED return, so a later sale can earn more total profit at a "
                 "lower IRR. Where the renovation programme finishes before the hold ends, NOI "
                 "flattens to inflation and every extra year dilutes the IRR - which is why an "
                 "early sale, or a refinance that pulls cash out at the top of the lift and "
                 "keeps the asset, usually scores best. Read IRR and Equity Multiple together, "
                 "never alone.")
    ws["B55"].font = EXIT_NOTE_FONT
    ws["B55"].alignment = Alignment(wrap_text=True, vertical="top")
    ws.row_dimensions[55].height = 46

    for col, w in (("A", 34), ("B", 17), ("C", 17), ("D", 17),
                   ("E", 19), ("F", 19), ("G", 19), ("H", 52)):
        ws.column_dimensions[col].width = w
    ws.row_dimensions[5].height = 30
    ws.freeze_panes = "B6"


# -- Renovation pace: model the whole hold, not just 24 months -----------------
# The template's Reno Pace tab scheduled only months 1-24 and then handed the
# Pro Forma a flat "Stabilized Annual Gross Premium" from Year 3 onward. Two
# things were wrong with that on any programme longer than two years:
#   1. the FULL rent premium was credited from Year 3 even when the renovation
#      was nowhere near finished (722 units at 25/month needs 29 months; at
#      15/month it needs 48), and
#   2. renovation downtime stopped being charged after month 24, so units
#      renovated later got their premium for free.
# Net effect: renovation pace barely moved the answer, which made the model
# blind to exactly the risk the pace input exists to express - and it left the
# refinance case incoherent, since a Year-3 refi is premised on there being
# more renovation still to come.
#
# This extends the monthly schedule to 96 months and drives all eight pro forma
# years off the actual ramp, downtime included. Growth convention is unchanged
# from the template: Years 1-2 in today's dollars, income growth compounding
# from Year 3.
RENO_FIRST_ROW = 6           # month 1
RENO_MONTHS = 96             # 8 years
RENO_LAST_ROW = RENO_FIRST_ROW + RENO_MONTHS - 1        # 101
RENO_SUMMARY_ROW = RENO_LAST_ROW + 2                    # 103


def extend_reno_pace(wb, warnings):
    """Schedule renovations across the full 8-year hold and rewire the Pro Forma."""
    if "Reno Pace" not in wb.sheetnames:
        return
    ws = wb["Reno Pace"]
    last = RENO_LAST_ROW

    # 1. clear everything below the existing 24-month table so the old summary
    #    block (rows 31-38) cannot survive underneath the extended schedule
    for r in range(30, last + 40):
        for c in range(1, 11):
            ws.cell(row=r, column=c).value = None

    # 2. extend the monthly schedule to 96 months
    for r in range(RENO_FIRST_ROW, last + 1):
        month = r - RENO_FIRST_ROW + 1
        ws.cell(row=r, column=1, value=month)
        ws.cell(row=r, column=2, value=(
            "=IF(A{r}<Inputs!$B$33,0,MAX(0,MIN(Inputs!$B$45,"
            "Inputs!$B$30-SUM($B$5:B{prev}))))").format(r=r, prev=r - 1))
        ws.cell(row=r, column=3, value=(
            '=SUMIFS($B${f}:$B${l},$A${f}:$A${l},">"&A{r},'
            '$A${f}:$A${l},"<="&A{r}+Inputs!$B$32)').format(f=RENO_FIRST_ROW, l=last, r=r))
        ws.cell(row=r, column=4, value="=SUM($B${f}:B{r})".format(f=RENO_FIRST_ROW, r=r))
        ws.cell(row=r, column=5, value="=D{r}*Inputs!$B$31".format(r=r))
        ws.cell(row=r, column=6, value=(
            "=IFERROR(B{r}*('Rent Roll'!$B$16/Inputs!$B$13)*Inputs!$B$32,0)").format(r=r))
        ws.cell(row=r, column=7, value="=E{r}-F{r}".format(r=r))
        for c in range(2, 8):
            ws.cell(row=r, column=c).number_format = (
                "#,##0.0" if c in (2, 3, 4) else '$#,##0;[Red]($#,##0)')

    # 3. per-year summary driven off the real ramp
    s = RENO_SUMMARY_ROW
    ws.cell(row=s, column=1,
            value="Renovation Schedule Summary - months 1-%d" % RENO_MONTHS)
    ws.cell(row=s, column=1).font = Font(bold=True, color="FFFFFF")
    ws.cell(row=s, column=1).fill = PatternFill("solid", fgColor="1F4E78")
    for c in range(2, 8):
        ws.cell(row=s, column=c).fill = PatternFill("solid", fgColor="1F4E78")
    for y in range(1, 9):
        r = s + y
        top = RENO_FIRST_ROW + (y - 1) * 12
        bot = top + 11
        ws.cell(row=r, column=1, value="Year %d Net Rent Impact" % y).font = Font(bold=True)
        ws.cell(row=r, column=2, value="=SUM(G{t}:G{b})".format(t=top, b=bot))
        ws.cell(row=r, column=2).number_format = '$#,##0;[Red]($#,##0)'
        ws.cell(row=r, column=3, value="=SUM(E{t}:E{b})".format(t=top, b=bot))
        ws.cell(row=r, column=3).number_format = '$#,##0;[Red]($#,##0)'
        ws.cell(row=r, column=4, value="=SUM(F{t}:F{b})".format(t=top, b=bot))
        ws.cell(row=r, column=4).number_format = '$#,##0;[Red]($#,##0)'
        ws.cell(row=r, column=5, value="=D{b}".format(b=bot))
        ws.cell(row=r, column=5).number_format = "#,##0.0"
    hdr = s + 0
    for c, label in ((2, "Net impact"), (3, "Gross premium"),
                     (4, "Downtime charged"), (5, "Units online at year end")):
        ws.cell(row=hdr, column=c, value=label)
        ws.cell(row=hdr, column=c).font = Font(bold=True, color="FFFFFF", size=9)
        ws.cell(row=hdr, column=c).alignment = Alignment(horizontal="center", wrap_text=True)

    extra = s + 10
    ws.cell(row=extra, column=1, value="Months to complete the programme").font = Font(bold=True)
    ws.cell(row=extra, column=2, value=(
        '=IFERROR(MATCH(Inputs!$B$30,$D${f}:$D${l},0),"more than {m}")'
    ).format(f=RENO_FIRST_ROW, l=last, m=RENO_MONTHS))
    ws.cell(row=extra + 1, column=1, value="Stabilised annual gross premium (reference)")
    ws.cell(row=extra + 1, column=2, value="=Inputs!$B$30*Inputs!$B$31*12")
    ws.cell(row=extra + 1, column=2).number_format = '$#,##0'
    ws.cell(row=extra + 2, column=1, value="Year 1 rent downtime")
    ws.cell(row=extra + 2, column=2, value="=SUM(F{f}:F{e})".format(f=RENO_FIRST_ROW,
                                                                   e=RENO_FIRST_ROW + 11))
    ws.cell(row=extra + 2, column=2).number_format = '$#,##0'
    ws.cell(row=extra + 3, column=1, value="Total rent downtime, Years 1-8")
    ws.cell(row=extra + 3, column=2, value="=SUM(F{f}:F{l})".format(f=RENO_FIRST_ROW, l=last))
    ws.cell(row=extra + 3, column=2).number_format = '$#,##0'
    ws.cell(row=extra + 5, column=1, value=(
        "Each pro forma year now reads its own 12 months from the schedule above, so a slower "
        "pace genuinely delays the premium and keeps charging downtime while units are offline. "
        "If 'months to complete' exceeds the hold period, the programme never finishes inside "
        "the model and the exit NOI reflects that."))
    ws.cell(row=extra + 5, column=1).font = Font(italic=True, size=9, color="6B6B6B")
    ws.cell(row=extra + 5, column=1).alignment = Alignment(wrap_text=True, vertical="top")
    ws.row_dimensions[extra + 5].height = 40
    ws.column_dimensions["A"].width = 44

    # 4. rewire the Pro Forma: Years 1-2 flat, income growth from Year 3 (unchanged
    #    convention), but every year now sourced from its own months
    pf = wb["Pro Forma"]
    for i, col in enumerate("DEFGHIJK"):          # Year 1 .. Year 8
        yr = i + 1
        ref = "'Reno Pace'!$B${r}".format(r=s + yr)
        if yr <= 2:
            pf["%s7" % col] = "=%s" % ref
        elif yr == 3:
            pf["%s7" % col] = "=%s*(1+Inputs!$B$21)" % ref
        else:
            pf["%s7" % col] = "=%s*(1+Inputs!$B$21)^%d" % (ref, yr - 2)

    # 5. repoint the Checks tab at the relocated Year-1 downtime cell
    if "Checks" in wb.sheetnames:
        wb["Checks"]["B17"] = '=IF(\'Reno Pace\'!$B${r}>0,"OK","WARN")'.format(r=extra + 2)


def generate(deal_path, output_path, template_path=TEMPLATE_PATH):
    with open(deal_path, encoding="utf-8") as f:
        deal = json.load(f)

    wb = load_workbook(template_path)
    warnings = []

    write_scalars(wb, deal, warnings)
    write_rent_roll(wb, deal)
    write_unit_mix(wb, deal)
    write_t12_raw_detail(wb, deal)
    # comps are optional supporting data — a comp-section layout change must warn,
    # never block the model from generating.
    for writer, name in ((write_rent_comps, "Rent Comps"), (write_sale_comps, "Sale Comps")):
        try:
            writer(wb, deal)
        except Exception as e:
            warnings.append(f"{name} tab: {e} — comps skipped, model generated without them.")
    patch_template_guardrails(wb, warnings)
    import model_fixes
    model_fixes.apply_all(wb)          # wider max-price solver, 'n/a' IRR on the Dashboard (2026-10-22 audit)
    import model_style
    model_style.apply_all(wb)          # presentation: palette, tab colours, Price Tool (never moves a formula)
    write_tax_sources(wb, deal)
    try:
        fill_display_gaps(wb, deal, warnings)
    except Exception as e:
        warnings.append(f"Display gap fill skipped: {e}")
    try:
        write_portfolio_breakdown(wb, deal, warnings)
    except Exception as e:
        warnings.append(f"Portfolio Breakdown tab skipped: {e}")
    try:
        extend_reno_pace(wb, warnings)
    except Exception as e:
        warnings.append(f"Reno Pace extension skipped: {e}")
    try:
        format_exit_scenarios(wb, warnings)
    except Exception as e:
        warnings.append(f"Exit Scenarios formatting skipped: {e}")

    wb.save(output_path)
    return output_path, warnings


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        print("Usage: python generator.py <deal.json> <output.xlsx> [template.xlsx]")
        sys.exit(1)
    tpl = sys.argv[3] if len(sys.argv) == 4 else TEMPLATE_PATH
    if not Path(tpl).exists():  # dashboard runtime keeps the template beside this script
        sibling = HERE / "Underwriting Model TEMPLATE.xlsx"
        if sibling.exists():
            tpl = sibling
    out, warns = generate(sys.argv[1], sys.argv[2], tpl)
    print(json.dumps({"file": str(out), "warnings": warns}))
