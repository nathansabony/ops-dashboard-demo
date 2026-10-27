#!/usr/bin/env python3
"""
Builds the demo's fictional showcase deal: Riverbend Apartments (96 units, Dayton OH).

Everything here is invented. Nothing comes from a real property, owner or resident.

What it writes (all tracked in git, so a fresh clone has the demo deal):

  underwriting/sample/Riverbend Apartments - Rent Roll.xlsx     a Rent Manager style "Rent Roll" export
  underwriting/sample/Riverbend Apartments - T12.xlsx           a "12 Month Trailing Income Statement" export
  underwriting/sample/Riverbend Apartments - Offering Memorandum.pdf
  underwriting/sample/riverbend-om-extracted.json   what Claude would read out of that OM (used when
                                                     DEMO_MODE=1 and there is no ANTHROPIC_API_KEY)
  underwriting/sample/riverbend-lookups.json        canned county-tax and area-occupancy answers
  underwriting/sample/riverbend-deal.json           the reviewed deal the generator is fed

The sample files go through the REAL parsers (underwriting/parsers.py) to make the deal, so the
deal JSON is exactly what the tab would build from dropping them.

    python3 scripts/buildDemoUnderwriting.py            # writes the files above
    node scripts/seedDemoUnderwriting.js                # then builds the model/PDF/card through the real server code
"""
import json
import random
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

import warnings
warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
UW = ROOT / "underwriting"
OUT = UW / "sample"
sys.path.insert(0, str(UW))

from openpyxl import Workbook  # noqa: E402
from openpyxl.styles import Font, Alignment  # noqa: E402

NAME = "Riverbend Apartments"
ADDRESS = "4100 Millrace Pointe Drive, Dayton, OH 45415"
AS_OF = date(2026, 10, 15)
RNG = random.Random(20261015)

# ---------------------------------------------------------------- the building
# 8 garden buildings x 12 units, built 1987, renovated common areas 2016.
TYPES = {   # code: (label, sqft, market rent, count)
    "A1": ("1 Bed / 1 Bath", 712, 975, 36),
    "B1": ("2 Bed / 1 Bath", 924, 1150, 30),
    "B2": ("2 Bed / 2 Bath", 1038, 1245, 20),
    "C1": ("3 Bed / 2 Bath", 1204, 1450, 10),
}
OCCUPIED = 90          # of 96 -> 93.75%

FIRST = ["Marisol", "Devon", "Priya", "Tyrone", "Hannah", "Luis", "Keisha", "Owen", "Mei", "Andre", "Sofia", "Caleb",
         "Naomi", "Ravi", "Tessa", "Marcus", "Elena", "Jamal", "Bridget", "Tomas", "Aaliyah", "Grant", "Imani", "Felix",
         "Rosa", "Dante", "Hye-jin", "Walter", "Camila", "Isaiah", "Leah", "Omar", "Paige", "Victor", "Yolanda", "Zane"]
LAST = ["Alvarez", "Brennan", "Coleman", "Dunmore", "Espinoza", "Fairchild", "Gutierrez", "Hawkins", "Iverson", "Jernigan",
        "Kowalski", "Lindqvist", "Mbeki", "Nakamura", "Okafor", "Pruitt", "Quill", "Rasmussen", "Sandoval", "Thatcher",
        "Underhill", "Vasquez", "Whitlock", "Yoder", "Zimmerman", "Abernathy", "Banerjee", "Castellano", "Delacroix", "Ellison"]


def build_units():
    codes = []
    for code, (_, _, _, n) in TYPES.items():
        codes += [code] * n
    RNG.shuffle(codes)
    vacant = set(RNG.sample(range(96), 96 - OCCUPIED))
    units = []
    i = 0
    for b in "ABCDEFGH":
        for floor in (1, 2, 3):
            for k in range(1, 5):
                code = codes[i]
                label, sqft, mkt, _ = TYPES[code]
                num = f"{b}{floor}0{k}"
                u = {"unit_number": num, "unit_type": code, "sqft": sqft + RNG.choice([-6, 0, 0, 0, 8]), "market_rent": float(mkt + RNG.choice([-10, 0, 0, 5, 10]))}
                if i in vacant:
                    u.update(resident_id="VACANT", resident_name="VACANT", rent_charge=0.0, total_charges=0.0, occupied_flag=0, balance=0.0)
                    if RNG.random() < 0.5:
                        u["move_out"] = (AS_OF - timedelta(days=RNG.randint(5, 40))).isoformat()
                else:
                    disc = RNG.choice([0.90, 0.92, 0.94, 0.95, 0.96, 0.97, 0.98, 1.0, 1.0])
                    rent = round(u["market_rent"] * disc / 5) * 5
                    mi = AS_OF - timedelta(days=RNG.randint(20, 1100))
                    start = date(mi.year + (1 if mi.month > 10 else 0), 1, 1) if False else mi
                    # lease runs 12 months from the latest anniversary of move-in
                    ls = mi
                    while ls + timedelta(days=365) <= AS_OF:
                        ls += timedelta(days=365)
                    exp = ls + timedelta(days=364)
                    u.update(resident_id=f"R{100200 + i * 7}", resident_name=f"{RNG.choice(LAST)}, {RNG.choice(FIRST)}",
                             rent_charge=float(rent), total_charges=float(rent), occupied_flag=1,
                             move_in=mi.isoformat(), lease_from=ls.isoformat(), lease_expiration=exp.isoformat(),
                             balance=float(RNG.choice([0] * 12 + [35, 75, 150, 320, 640])))
                units.append(u)
                i += 1
    return units


# ---------------------------------------------------------------- rent roll export
def write_rent_roll(units, path):
    wb = Workbook()
    ws = wb.active
    ws.title = "Rent Roll"
    ws["A1"] = "Rent Roll"
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = NAME
    ws["A3"] = f"As Of = {AS_OF.strftime('%m/%d/%Y')}"
    ws["A4"] = "Cedar Ridge Capital (demo) - fictional sample data"
    hdr = ["Unit", "Unit Type", "Sq Ft", "Resident ID", "Name", "Market Rent", "Actual", "Resident Deposit", "Other Deposit",
           "Move In", "Lease From", "Lease Expiration", "Move Out", "Balance"]
    ws.append([])  # row 5 is the header, rows 3/4 above
    for c, h in enumerate(hdr, start=1):
        cell = ws.cell(row=5, column=c, value=h)
        cell.font = Font(bold=True)
    ws.cell(row=5, column=7).value = "Actual"
    ws.cell(row=6, column=7).value = "Rent"
    ws["A7"] = "Current/Notice/Vacant Residents"
    ws["A7"].font = Font(bold=True)
    r = 8
    for u in units:
        d = lambda k: date.fromisoformat(u[k]) if u.get(k) else None
        row = [u["unit_number"], u["unit_type"], u["sqft"], u["resident_id"], u["resident_name"], u["market_rent"], u["rent_charge"],
               u["market_rent"] if u["occupied_flag"] else 0, 0, d("move_in"), d("lease_from"), d("lease_expiration"), d("move_out"), u["balance"]]
        for c, v in enumerate(row, start=1):
            cell = ws.cell(row=r, column=c, value=v)
            if isinstance(v, date):
                cell.number_format = "mm/dd/yyyy"
        r += 1
    r += 1
    ws.cell(row=r, column=1, value="Future Residents/Applicants").font = Font(bold=True)
    r += 3
    ws.cell(row=r, column=1, value="Summary Groups").font = Font(bold=True)
    r += 1
    occ = sum(u["occupied_flag"] for u in units)
    ws.cell(row=r, column=1, value="Current/Notice/Vacant Residents")
    ws.cell(row=r, column=10, value=len(units))
    ws.cell(row=r, column=12, value=round(100.0 * occ / len(units), 2))
    r += 1
    ws.cell(row=r, column=1, value="Occupied Units")
    ws.cell(row=r, column=10, value=occ)
    r += 1
    ws.cell(row=r, column=1, value="Total Vacant Units")
    ws.cell(row=r, column=10, value=len(units) - occ)
    for col, w in zip("ABCDEFGHIJKLMN", [9, 10, 8, 12, 26, 12, 10, 14, 12, 12, 12, 16, 12, 10]):
        ws.column_dimensions[col].width = w
    wb.save(path)


# ---------------------------------------------------------------- T12 export
MONTHS = ["Oct 2025", "Nov 2025", "Dec 2025", "Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026"]


def spread(annual, shape="flat", noise=0.0, growth=0.0):
    """12 whole-dollar months that add to `annual` exactly."""
    w = []
    for m in range(12):
        x = 1.0 + growth * (m - 5.5)
        if shape == "summer":     # utilities peak in summer
            x *= 1.0 + 0.18 * (1 if 5 <= m <= 9 else -0.12)
        elif shape == "winter":
            x *= 1.0 + 0.35 * (1 if m in (2, 3, 4) else -0.1)
        elif shape == "spring":   # turnover and marketing
            x *= 1.0 + 0.25 * (1 if 7 <= m <= 10 else -0.1)
        elif shape == "q":        # paid quarterly / semi-annually
            x = 1.0 if m in (2, 8) else 0.0
        x *= 1.0 + RNG.uniform(-noise, noise)
        w.append(max(x, 0.0))
    tot = sum(w) or 1
    vals = [int(round(annual * v / tot)) for v in w]
    vals[vals.index(max(vals))] += int(round(annual)) - sum(vals)
    return vals


# (account, label, annual, shape, noise, growth) - income lines positive, deductions negative
T12_SPEC = {
    "gpr": [("4000-00", "Gross Potential Rent", 1_305_600, "flat", 0.0, 0.006)],
    "ded": [("4510-00", "Vacancy Loss", -84_900, "flat", 0.22, 0), ("4510-01", "Vacancy - Model/Down Units", 0, "flat", 0, 0),
            ("4520-00", "Loss to Lease", -57_400, "flat", 0.05, 0), ("4530-00", "Concessions", -11_800, "spring", 0.3, 0),
            ("4535-00", "Concessions - Other", 0, "flat", 0, 0), ("4540-00", "Bad Debt Write-offs", -15_300, "flat", 0.4, 0),
            ("4545-00", "Bad Debt Recovery", 2_900, "flat", 0.5, 0)],
    "oth": [("4700-00", "Utility Reimbursement (RUBS)", 49_800, "summer", 0.04, 0), ("4710-00", "Late Fees", 9_300, "flat", 0.2, 0),
            ("4720-00", "Application and Admin Fees", 6_900, "spring", 0.2, 0), ("4730-00", "Pet Rent and Fees", 13_200, "flat", 0.08, 0.01),
            ("4740-00", "Laundry and Vending", 4_100, "flat", 0.1, 0), ("4750-00", "Parking, Storage and Other", 8_600, "flat", 0.15, 0)],
    "rm": [("6110-00", "Repairs - Supplies", 22_300, "flat", 0.2, 0), ("6120-00", "Contract Services (HVAC, plumbing, appliance)", 26_900, "flat", 0.25, 0),
           ("6130-00", "Grounds and Landscaping", 15_400, "summer", 0.1, 0), ("6140-00", "Snow Removal and Common Area", 6_100, "winter", 0.3, 0)],
    "to": [("6210-00", "Make-Ready - Flooring", 11_200, "spring", 0.2, 0), ("6220-00", "Make-Ready - Paint and Cleaning", 10_100, "spring", 0.2, 0),
           ("6230-00", "Make-Ready - Appliances", 5_300, "spring", 0.3, 0)],
    "lab": [("6310-00", "On-Site Salaries", 101_600, "flat", 0.02, 0), ("6320-00", "Payroll Taxes and Benefits", 21_400, "flat", 0.05, 0)],
    "adv": [("6410-00", "Internet Listings and Marketing", 15_800, "spring", 0.15, 0)],
    "ga": [("6510-00", "Office and Supplies", 7_300, "flat", 0.15, 0), ("6520-00", "Software and Telephone", 9_900, "flat", 0.05, 0),
           ("6530-00", "Legal and Professional", 7_100, "flat", 0.5, 0), ("6540-00", "Licenses and Fees", 3_400, "flat", 0.1, 0)],
    "util": [("6610-00", "Electric - Common Area", 24_600, "summer", 0.05, 0), ("6620-00", "Water and Sewer", 70_400, "summer", 0.05, 0.004),
             ("6630-00", "Gas - Common Area", 3_700, "winter", 0.2, 0), ("6640-00", "Trash Removal", 22_800, "flat", 0.02, 0)],
    "mgmt": [("6700-00", "Management Fee", 40_900, "flat", 0.02, 0)],
    "ins": [("6800-00", "Property and Liability Insurance", 91_800, "q", 0, 0)],
    "tax": [("6900-00", "Real Estate Taxes", 165_400, "q", 0, 0)],
    "opx": [("7010-00", "Pest Control", 7_200, "flat", 0.05, 0), ("7020-00", "Security and Courtesy Patrol", 9_600, "flat", 0.05, 0),
            ("7030-00", "Other Property Expenses", 5_200, "flat", 0.3, 0)],
}


def write_t12(path):
    wb = Workbook()
    ws = wb.active
    ws.title = "12 Month Trailing Income Statement"
    ws["A1"] = NAME
    ws["A2"] = "12 Month Trailing Income Statement"
    ws["A3"] = "Period = Oct 2025-Sep 2026"
    ws["A4"] = "Book = Accrual   (fictional sample data - Cedar Ridge Capital demo)"
    for c, h in enumerate(["Account", "Description"] + MONTHS + ["Total"], start=1):
        ws.cell(row=6, column=c, value=h).font = Font(bold=True)
    row = [7]
    sums = {}

    def put(label, vals=None, account=None, bold=False, indent=0):
        r = row[0]
        if account:
            ws.cell(row=r, column=1, value=account)
        c = ws.cell(row=r, column=2, value=("   " * indent) + label)
        if bold:
            c.font = Font(bold=True)
        if vals is not None:
            for j, v in enumerate(vals):
                ws.cell(row=r, column=3 + j, value=v)
            ws.cell(row=r, column=15, value=sum(vals))
            if bold:
                for cc in range(3, 16):
                    ws.cell(row=r, column=cc).font = Font(bold=True)
        row[0] += 1

    def block(key):
        tot = [0] * 12
        for acct, label, annual, shape, noise, growth in T12_SPEC[key]:
            vals = spread(annual, shape, noise, growth)
            put(label, vals, acct, indent=2)
            tot = [a + b for a, b in zip(tot, vals)]
        return tot

    def add(*arrs):
        return [sum(x) for x in zip(*arrs)]

    put("INCOME", bold=True)
    put("Rental Income", bold=True, indent=1)
    gpr = block("gpr")
    put("Total Gross Potential Rent", gpr, bold=True, indent=1)
    ded = block("ded")
    put("Total Deductions", ded, bold=True, indent=1)
    nri = add(gpr, ded)
    put("Net Rental Income", nri, bold=True)
    put("Other Income", bold=True, indent=1)
    oth = block("oth")
    put("Total Other Income", oth, bold=True, indent=1)
    egi = add(nri, oth)
    put("Total Income", egi, bold=True)
    row[0] += 1
    put("EXPENSES", bold=True)
    put("Controllable Expenses", bold=True, indent=1)
    parts = []
    for key, tot_label in (("rm", "Total Repairs and Maintenance"), ("to", "Total Turnover Costs"), ("lab", "Total Labor Costs"),
                           ("adv", "Total Advertising and Promotions"), ("ga", "Total General and Administrative Costs")):
        v = block(key)
        put(tot_label, v, bold=True, indent=1)
        parts.append(v)
    ctrl = add(*parts)
    put("Total Controllable Expenses", ctrl, bold=True)
    util = block("util")
    put("Total Utility Costs", util, bold=True)
    mg = block("mgmt")
    # the management fee line follows the income it is charged on
    mgmt = [int(round(0.035 * e)) for e in egi]
    ws.cell(row=row[0] - 1, column=2)   # (label row already written; overwrite values below)
    r = row[0] - 1
    for j, v in enumerate(mgmt):
        ws.cell(row=r, column=3 + j, value=v)
    ws.cell(row=r, column=15, value=sum(mgmt))
    put("Total Management Fees", mgmt, bold=True)
    ins = block("ins")
    put("Total Insurance and Bonds", ins, bold=True)
    tax = block("tax")
    put("Total Property Taxes", tax, bold=True)
    opx = block("opx")
    put("Total Other Property Expenses", opx, bold=True)
    opex = add(ctrl, util, mgmt, ins, tax, opx)
    put("Total Operating Expenses", opex, bold=True)
    noi = [a - b for a, b in zip(egi, opex)]
    put("Net Operating Income", noi, bold=True)
    ws.column_dimensions["A"].width = 10
    ws.column_dimensions["B"].width = 44
    for col in "CDEFGHIJKLMNO":
        ws.column_dimensions[col].width = 11
    wb.save(path)
    return {"egi": sum(egi), "opex": sum(opex), "noi": sum(noi)}


# ---------------------------------------------------------------- OM facts (what Claude would extract)
OM_PROPERTY = {"name": NAME, "address": ADDRESS, "city": "Dayton, OH", "year_built": 1987, "site_acres": 7.4, "units": 96, "avg_unit_size_sf": 945}

RENT_COMPS = [
    {"property_name": "Stillwater Crossing", "address_market": "Dayton, OH - Northridge", "units": 112, "year_built": 1989, "avg_unit_size_sf": 930,
     "market_rent": 1165, "achieved_rent": 1130, "rent_psf": 1.22, "occupancy": 0.94, "source_status": "OM p.9", "notes": "Renovated interiors, similar finishes"},
    {"property_name": "The Oaks at Miamisburg Pike", "address_market": "Miamisburg, OH", "units": 88, "year_built": 1985, "avg_unit_size_sf": 905,
     "market_rent": 1140, "achieved_rent": 1105, "rent_psf": 1.22, "occupancy": 0.95, "source_status": "OM p.9", "notes": "Partial interior upgrades"},
    {"property_name": "Kettering Green", "address_market": "Kettering, OH", "units": 120, "year_built": 1991, "avg_unit_size_sf": 960,
     "market_rent": 1235, "achieved_rent": 1200, "rent_psf": 1.25, "occupancy": 0.93, "source_status": "OM p.9", "notes": "Fully renovated, pool and fitness"},
    {"property_name": "Brookhaven Terrace", "address_market": "Huber Heights, OH", "units": 104, "year_built": 1988, "avg_unit_size_sf": 915,
     "market_rent": 1090, "achieved_rent": 1060, "rent_psf": 1.19, "occupancy": 0.92, "source_status": "OM p.9", "notes": "Classic finishes, no renovation"},
    {"property_name": "Westbrook Landing", "address_market": "Centerville, OH", "units": 96, "year_built": 1993, "avg_unit_size_sf": 985,
     "market_rent": 1295, "achieved_rent": 1255, "rent_psf": 1.28, "occupancy": 0.95, "source_status": "OM p.9", "notes": "Newer vintage, attached garages"},
]
SALE_COMPS = [
    {"property_name": "Stillwater Crossing", "location": "Dayton, OH", "units": 112, "year_built": 1989, "sale_date": "2026-03", "sale_price": 9_520_000, "price_per_unit": 85_000, "source": "OM p.10", "notes": "6.4% cap, value-add"},
    {"property_name": "Pine Hollow Apartments", "location": "Springboro, OH", "units": 80, "year_built": 1990, "sale_date": "2025-11", "sale_price": 7_440_000, "price_per_unit": 93_000, "source": "OM p.10", "notes": "6.1% cap"},
    {"property_name": "Courtyard at Wolf Creek", "location": "Trotwood, OH", "units": 128, "year_built": 1984, "sale_date": "2025-09", "sale_price": 9_730_000, "price_per_unit": 76_016, "source": "OM p.10", "notes": "6.8% cap, light value-add"},
    {"property_name": "Kettering Green", "location": "Kettering, OH", "units": 120, "year_built": 1991, "sale_date": "2026-06", "sale_price": 12_000_000, "price_per_unit": 100_000, "source": "OM p.10", "notes": "5.9% cap, renovated"},
]

OM_EXTRACTED = {
    "property": OM_PROPERTY,
    "value_add": {"value_add_units": 72, "value_add_premium_per_unit_month": 170,
                  "plan_note": "Interior renovation of 72 classic units at turnover (plank flooring, quartz-look counters, stainless appliances, lighting) for a $170 monthly premium, plus a clubhouse refresh and new monument signage."},
    "tax": {"county_pin": "R72 00811 0006, R72 00811 0007", "current_taxable_value": 6_900_000, "current_millage_rate": 23.97, "non_ad_valorem_tax": 0},
    "properties": [{"name": NAME, "address": ADDRESS, "units": 96, "year_built": 1987, "source_page": 3}],
    "asking_price": 8_950_000,
    "rent_comps": RENT_COMPS,
    "sale_comps": SALE_COMPS,
    "confidence": {"property.name": 1.0, "property.address": 1.0, "property.year_built": 1.0, "property.units": 1.0, "property.site_acres": 0.95,
                   "value_add.value_add_units": 0.9, "value_add.value_add_premium_per_unit_month": 0.85, "tax.current_taxable_value": 0.8,
                   "tax.current_millage_rate": 0.8, "tax.county_pin": 0.9},
    "source_pages": {"property.name": 1, "property.address": 1, "property.year_built": 3, "property.units": 3, "property.site_acres": 3,
                     "value_add.value_add_units": 7, "value_add.value_add_premium_per_unit_month": 7, "tax.current_taxable_value": 11,
                     "tax.current_millage_rate": 11, "tax.county_pin": 11},
}

# What the review screen pre-fills when the sample OM is loaded: the showcase deal's house terms. See DEMO_ASSUMPTIONS in
# the deal below - the same dictionary, so dropping the sample files and pressing Generate rebuilds this deal.
DEMO_ASSUMPTIONS = {
    "purchase_cap_rate": 0.062, "purchase_price_override": 0,
    "ltv": 0.70, "loan_interest_rate": 0.055, "hold_period_years": 5, "exit_cap_rate": 0.060,
    "income_growth": 0.03, "expense_growth": 0.03, "tax_growth": 0.03,
    "stabilized_occupancy_target": 0.96,
    "value_add_units": 72, "value_add_premium_per_unit_month": 170,
    "interior_renovation_cost_per_unit": 8800, "common_exterior_capex": 250000, "misc_expense_annual": 10000,
    "units_renovated_per_month": 6, "max_opex_pct_egi": 0.56,
    "irr_target": 0.16, "refi_cap_rate": 0.0595, "refi_interest_rate": 0.0545,
}

LOOKUPS = {
    "tax": {
        "found": True, "county": "Montgomery County, OH", "current_taxable_value": 6_900_000, "current_millage_rate": 23.97,
        "millage_breakdown": {"county": 6.8, "municipal": 4.4, "school": 12.77, "other": 0.0}, "non_ad_valorem_tax": 0, "current_annual_tax": 165_393,
        "reassessment_on_sale_pct": 0.5,
        "reassessment_rule": "Ohio re-appraises on a county cycle and a sale alone does not reset the assessment, but a school district can file a complaint citing the sale price; modeled as half the step-up to the purchase price. Values here are the appraised (market) value with the effective rate on it.",
        "sources": [{"field": "current_millage_rate", "url": "https://example.com/demo/montgomery-county-millage", "title": "Demo data: Montgomery County millage table (fictional)"}],
        "confidence": 0.8, "warnings": ["Demo mode: this is sample data for a fictional property, not a live county lookup."],
        "usage": {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "searches": 0},
    },
    "occupancy": {
        "found": True, "market": "Dayton, OH metro", "occupancy": 0.934, "as_of": "Q3 2026",
        "sources": [{"url": "https://example.com/demo/dayton-multifamily-report", "title": "Demo data: Dayton multifamily market report (fictional)"}],
        "notes": "Demo mode: sample figure for a fictional market. Class B garden stock is tight, with limited new supply under construction.",
        "confidence": 0.7, "warnings": [], "usage": {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "searches": 0},
    },
}


# ---------------------------------------------------------------- OM pdf
def build_om_pdf(path, rr_units, t12tot):
    import pymupdf as fitz
    mix_rows = "".join(
        f"<tr><td>{c}</td><td>{lab}</td><td class='r'>{n}</td><td class='r'>{sf:,}</td><td class='r'>${m:,}</td></tr>"
        for c, (lab, sf, m, n) in TYPES.items())
    comp_rows = "".join(
        f"<tr><td>{c['property_name']}</td><td>{c['address_market']}</td><td class='r'>{c['units']}</td><td class='r'>{c['year_built']}</td>"
        f"<td class='r'>{c['avg_unit_size_sf']}</td><td class='r'>${c['market_rent']:,}</td><td class='r'>${c['achieved_rent']:,}</td><td class='r'>{c['occupancy']:.0%}</td></tr>"
        for c in RENT_COMPS)
    sale_rows = "".join(
        f"<tr><td>{c['property_name']}</td><td>{c['location']}</td><td class='r'>{c['units']}</td><td class='r'>{c['year_built']}</td>"
        f"<td>{c['sale_date']}</td><td class='r'>${c['sale_price']:,}</td><td class='r'>${c['price_per_unit']:,}</td></tr>" for c in SALE_COMPS)

    def page(title, body):
        return f"<div style='page-break-after:always'><h2>{title}</h2>{body}</div>"

    pages = [
        "<div style='page-break-after:always'><p style='margin-top:150pt;font-size:11pt;color:#555'>CONFIDENTIAL OFFERING MEMORANDUM</p>"
        f"<h1 style='font-size:34pt'>{NAME}</h1><p style='font-size:14pt'>96-Unit Garden-Style Community &middot; Dayton, Ohio</p>"
        f"<p style='font-size:11pt'>{ADDRESS}</p><p style='margin-top:120pt;font-size:9pt;color:#555'>Exclusively offered by Larkin &amp; Pryce Multifamily Advisors (fictional broker)<br>"
        "This document is invented sample material for a product demonstration. No such property, seller or broker exists.</p></div>",
        page("Confidentiality and disclaimer", "<p>This Confidential Offering Memorandum is furnished solely to evaluate the acquisition of the property described. All names, figures and "
             "market data are fictional and were generated for a software demonstration. Nothing here is an offer to sell.</p>"),
        page("Executive summary", f"<p><b>{NAME}</b> is a 96-unit garden-style apartment community on 7.4 acres in southwest Dayton, Ohio, built in 1987 and "
             "maintained by a single long-term owner. Eight three-story buildings hold a balanced mix of one, two and three bedroom homes, 93.8% occupied.</p>"
             "<p>The asking price is <b>$8,950,000</b> ($93,229 per unit). 72 units retain original finishes and offer an interior renovation program at a measured $170 monthly premium.</p>"),
        page("Property overview", "<p>Year built: <b>1987</b> &middot; Site: <b>7.4 acres</b> &middot; Buildings: 8 three-story walk-ups &middot; Units: <b>96</b> &middot; Average unit size: 945 SF.</p>"
             "<p>Amenities: leasing office and clubhouse, fitness room, swimming pool, playground, laundry in 24 units, 164 open parking spaces. "
             "Parcel IDs R72 00811 0006 and R72 00811 0007, Montgomery County.</p><h3>Unit mix</h3><table><tr><th>Plan</th><th>Type</th><th class='r'>Units</th><th class='r'>SF</th><th class='r'>Market rent</th></tr>" + mix_rows + "</table>"),
        page("Investment highlights", "<ul><li>Stable Dayton submarket, 93%+ occupancy across the comp set</li><li>Value-add: 72 classic units at a $170 premium</li>"
             "<li>In-place rents average about 4% under market</li><li>Seller-prepared T12 NOI of "
             f"${t12tot['noi']:,.0f}</li><li>Assumable-quality construction, recent roofs on 5 of 8 buildings</li></ul>"),
        page("Rent roll summary", f"<p>As of {AS_OF.strftime('%B %d, %Y')}: 96 units, {OCCUPIED} occupied, {96 - OCCUPIED} vacant (93.75% occupancy). The full rent roll accompanies this memorandum.</p>"),
        page("Value-add plan", "<p>Renovate 72 classic units at turnover: plank flooring, countertops, stainless appliances, lighting and hardware, at an estimated "
             "$8,800 per unit. Premium achieved on the renovated units at nearby comparables is $150 to $190 per month; we underwrite $170.</p>"
             "<p>Exterior: clubhouse refresh and signage, about $250,000.</p>"),
        page("Financial summary", f"<p>Trailing twelve months ended September 2026: effective gross income <b>${t12tot['egi']:,.0f}</b>, operating expenses "
             f"<b>${t12tot['opex']:,.0f}</b>, net operating income <b>${t12tot['noi']:,.0f}</b>. The full T12 statement accompanies this memorandum.</p>"),
        page("Market overview", "<p>Dayton is a steady, affordable Midwest metro anchored by Wright-Patterson Air Force Base, healthcare systems and logistics employers. "
             "Class B garden stock in the submarket is 93 to 95 percent occupied with limited new supply, supporting modest annual rent growth.</p>"),
        page("Rent comparables", "<table><tr><th>Property</th><th>Market</th><th class='r'>Units</th><th class='r'>Built</th><th class='r'>Avg SF</th><th class='r'>Market rent</th><th class='r'>Achieved</th><th class='r'>Occ</th></tr>" + comp_rows + "</table>"),
        page("Sale comparables", "<table><tr><th>Property</th><th>Location</th><th class='r'>Units</th><th class='r'>Built</th><th>Sold</th><th class='r'>Price</th><th class='r'>Per unit</th></tr>" + sale_rows + "</table>"),
        page("Property tax summary", "<p>Parcel IDs R72 00811 0006, R72 00811 0007. Appraised (market) value: <b>$6,900,000</b>. Effective rate: <b>23.97</b> per $1,000 of appraised value. "
             "Current annual real estate tax: about $165,400.</p>"),
        page("Location", "<p>Four miles from downtown Dayton, with quick access to I-75 and US-35. Retail, grocery and healthcare within two miles.</p>"),
        page("Contact", "<p>Larkin &amp; Pryce Multifamily Advisors (fictional). Offers are due 30 days from release. Call for the data room.</p>"),
    ]
    html = "<html><body style='font-family:sans-serif;font-size:10pt'>" + "".join(pages) + "</body></html>"
    css = "h1{margin:0} h2{color:#14532D;border-bottom:1px solid #14532D} table{width:100%;border-collapse:collapse} th{text-align:left;border-bottom:1px solid #999} td{padding:2pt 4pt;border-bottom:1px solid #ddd} .r{text-align:right}"
    story = fitz.Story(html=html, user_css=css)
    mediabox = fitz.paper_rect("letter")
    where = mediabox + (54, 54, -54, -54)
    writer = fitz.DocumentWriter(str(path))
    more = 1
    while more:
        dev = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
    writer.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    units = build_units()
    rr_path = OUT / f"{NAME} - Rent Roll.xlsx"
    t12_path = OUT / f"{NAME} - T12.xlsx"
    write_rent_roll(units, rr_path)
    t12tot = write_t12(t12_path)
    build_om_pdf(OUT / f"{NAME} - Offering Memorandum.pdf", units, t12tot)

    import parsers
    rr, rr_meta, rr_warn = parsers.parse_rent_roll(str(rr_path))
    t12, t12_meta, t12_warn = parsers.parse_t12(str(t12_path))

    import pymupdf as fitz
    pdf = fitz.open(str(OUT / f"{NAME} - Offering Memorandum.pdf"))
    om = dict(OM_EXTRACTED)
    om["demo_assumptions"] = DEMO_ASSUMPTIONS
    om["_meta"] = {"pages": pdf.page_count, "chars": sum(len(pg.get_text()) for pg in pdf)}
    pdf.close()
    deal = {
        "property": {**{k: OM_PROPERTY[k] for k in ("name", "address", "year_built", "site_acres")}, "units": rr["official_units"],
                     "om_source_file": f"{NAME} - Offering Memorandum.pdf"},
        "assumptions": dict(DEMO_ASSUMPTIONS),
        "t12": t12,
        "tax": {"county_pin": OM_EXTRACTED["tax"]["county_pin"], "current_taxable_value": 6_900_000, "current_millage_rate": 23.97,
                "non_ad_valorem_tax": 0, "reassessment_on_sale_pct": 0.5, "t12_property_tax_expense": t12["property_taxes_actual"],
                "county_source_url": LOOKUPS["tax"]["sources"][0]["url"], "tax_rule_note": LOOKUPS["tax"]["reassessment_rule"]},
        "rent_roll": {k: rr[k] for k in rr if k != "units"} | {"units": rr["units"]},
        "rent_comps": RENT_COMPS,
        "sale_comps": SALE_COMPS,
        "market": {"occupancy": LOOKUPS["occupancy"]["occupancy"], "market": LOOKUPS["occupancy"]["market"], "as_of": LOOKUPS["occupancy"]["as_of"],
                   "source_url": LOOKUPS["occupancy"]["sources"][0]["url"]},
    }
    (OUT / "riverbend-om-extracted.json").write_text(json.dumps(om, indent=1))
    (OUT / "riverbend-lookups.json").write_text(json.dumps(LOOKUPS, indent=1))
    (OUT / "riverbend-deal.json").write_text(json.dumps(deal, indent=1))
    print(json.dumps({"units": len(units), "occupied": sum(u["occupied_flag"] for u in units), "t12": t12tot,
                      "rr_warnings": rr_warn, "t12_warnings": t12_warn, "gpr_market_monthly": sum(u["market_rent"] for u in units)}))


if __name__ == "__main__":
    main()
