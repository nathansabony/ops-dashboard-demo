"""
Repair a finished underwriting model into a corrected COPY (never in place).

    python repair_model.py <in.xlsx> <out.xlsx> [--note "text"]

Written 2026-10-22 after auditing every model on the live board. Three defects had reached models that were
already on the Render disk, and the source files for most of them are not available to re-run:

  1. Invalid cached values. An older bake wrote the text "empty" into numeric cells (Pro Forma D16..D20, 11 cells)
     of Station Heights and Harbor City Apartments (2026-08-02): neither openpyxl nor Excel could open
     them, so they never appeared on the board. The bad <v> elements are removed and Excel recalculates them.
  2. Unit Mix totals that sum only the first 20 unit types (the template's B6:B25). Extended to every type row.
  3. An "official" occupancy that the unit rows contradict (100-106 Maple Court: 0 of 56 occupied while 54
     units pay rent), which the model had used as its occupancy. Reconciled with the same rule the page and server
     now apply (services/underwritingDeals.js reconcileOfficialCounts).

Then the copy is recalculated (Excel when this machine has it, else the pure-Python engine) and its values baked in,
so every viewer shows numbers. The repaired copy says what was changed on its Checks tab. Emits JSON.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import warnings
import zipfile

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

from openpyxl import load_workbook


def strip_invalid_cached_values(src, dst):
    """Copy src to dst, dropping any <v> that is not a number inside a numeric (or untyped) cell."""
    removed = 0
    cell_re = re.compile(r'(<c r="[A-Z]+\d+"([^>]*?)(?<!/)>)((?:(?!</c>).)*?)(</c>)', re.DOTALL)

    def fix(m):
        nonlocal removed
        open_tag, attrs, inner, close = m.group(1), m.group(2), m.group(3), m.group(4)
        t = re.search(r't="(\w+)"', attrs)
        if t and t.group(1) not in ("n",):
            return m.group(0)
        v = re.search(r"<v>([^<]*)</v>", inner)
        if not v:
            return m.group(0)
        try:
            float(v.group(1))
            return m.group(0)
        except ValueError:
            removed += 1
            return open_tag + inner.replace(v.group(0), "") + close

    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if re.match(r"xl/worksheets/sheet\d+\.xml$", item.filename):
                data = cell_re.sub(fix, data.decode("utf-8")).encode("utf-8")
            zout.writestr(item, data)
    return removed


def find_row(ws, label, col=1, start=1, end=None):
    want = label.lower()
    for r in range(start, (end or ws.max_row) + 1):
        v = ws.cell(r, col).value
        if v is not None and str(v).strip().lower().startswith(want):
            return r
    return None


def main(src, out, note):
    changes = []
    tmp = tempfile.mkdtemp(prefix="repair-")
    cleaned = os.path.join(tmp, "cleaned.xlsx")
    removed = strip_invalid_cached_values(src, cleaned)
    if removed:
        changes.append(f"Removed {removed} invalid cached value(s) that stopped the workbook from opening; Excel recalculates them.")

    wb = load_workbook(cleaned)                       # formulas
    cached = load_workbook(cleaned, data_only=True)   # whatever values survived (parsed-occupied counts are baked)

    # 2. Unit Mix totals over every type row
    um = wb["Unit Mix"]
    hdr = find_row(um, "Unit Type", 1, 1, 12) or 5
    first = hdr + 1
    last = first
    for r in range(first, um.max_row + 1):
        if um.cell(r, 1).value not in (None, ""):
            last = r
    last = max(last, first + 19)
    a2 = str(um["A2"].value or "")
    m = re.match(r"=SUM\(B(\d+):B(\d+)\)", a2)
    if m and int(m.group(2)) < last:
        rng = lambda col: f"{col}{first}:{col}{last}"
        um["A2"].value = f"=SUM({rng('B')})"
        for cell, col in (("B2", "E"), ("C2", "F"), ("D2", "G")):
            um[cell].value = f"=IFERROR(SUMPRODUCT({rng('B')},{rng(col)})/SUM({rng('B')}),0)"
        changes.append(f"Unit Mix totals now cover all unit types (rows {first}-{last}); they summed only rows {m.group(1)}-{m.group(2)}.")

    # 3. an official occupancy the unit rows contradict
    rr = wb["Rent Roll"]; rc = cached["Rent Roll"]
    # start BELOW the header: the KPI tiles in rows 2-3 carry the label "OFFICIAL OCCUPANCY" too, and a search from
    # row 1 matched that tile and wrote the value into it instead of the table cell (caught verifying the first repair)
    top = (find_row(rr, "Metric", 1, 1, 12) or 5) + 1
    r_units, r_occ, r_vac, r_pct = (find_row(rr, l, 1, top, 30) for l in ("Official Units", "Official Occupied Units", "Official Vacant Units", "Official Occupancy"))
    r_pun, r_pocc = find_row(rr, "Parsed Unit Count", 1, top, 30), find_row(rr, "Parsed Occupied Units", 1, top, 30)
    if all((r_units, r_occ, r_vac, r_pct, r_pun, r_pocc)):
        off_u, off_o = rc.cell(r_units, 2).value, rc.cell(r_occ, 2).value
        par_u, par_o = rc.cell(r_pun, 2).value, rc.cell(r_pocc, 2).value
        isnum = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
        if isnum(par_o) and isnum(par_u) and par_u > 0 and par_o > 0 and (not isnum(off_o) or off_o == 0 or (isnum(off_u) and off_o > off_u)):
            units = off_u if isnum(off_u) and off_u > 0 else par_u
            rr.cell(r_units, 2).value = units
            rr.cell(r_occ, 2).value = par_o
            rr.cell(r_vac, 2).value = max(0, units - par_o)
            rr.cell(r_pct, 2).value = par_o / par_u
            changes.append(f"Official occupancy was {off_o} of {off_u} while the unit rows show {int(par_o)} of {int(par_u)} occupied; the model now uses the unit rows ({par_o / par_u:.1%}).")

    import model_fixes
    changes += model_fixes.apply_all(wb)       # wider max-price solver, 'n/a' IRR on the Dashboard
    import model_style
    changes += model_style.apply_all(wb)       # presentation: palette, tab colours, Price Tool
    if not changes:
        changes.append("Nothing needed repair; the copy was only recalculated.")
    ck = wb["Checks"]
    r = ck.max_row + 2
    ck.cell(r, 1).value = "Repaired copy (2026-10-22)"
    ck.cell(r, 4).value = " ".join(changes) + (" " + note if note else "")
    wb.save(out)

    # recalculate + bake: Excel when available (finish_model tries it first), else the pure-Python engine
    res = subprocess.run([sys.executable, os.path.join(HERE, "finish_model.py"), out], capture_output=True, text=True, timeout=900)
    finish = None
    for line in reversed(res.stdout.strip().splitlines()):
        if line.startswith("{"):
            finish = json.loads(line)
            break
    shutil.rmtree(tmp, ignore_errors=True)
    return {"changes": changes, "finish": {k: finish.get(k) for k in ("recalc", "engine", "baked_cells", "recalc_error", "bake_error")} if finish else None,
            "computed": bool(finish and finish.get("facts") and finish["facts"].get("computed"))}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        _REAL_STDOUT.write(json.dumps({"error": "Usage: python repair_model.py <in.xlsx> <out.xlsx> [--note text]"}) + "\n")
        sys.exit(1)
    note = sys.argv[sys.argv.index("--note") + 1] if "--note" in sys.argv else ""
    try:
        _REAL_STDOUT.write(json.dumps(main(sys.argv[1], sys.argv[2], note), default=str) + "\n")
    except Exception as e:
        _REAL_STDOUT.write(json.dumps({"error": f"Could not repair this model: {e}"}) + "\n")
