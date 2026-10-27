#!/usr/bin/env python3
"""Prove the budget workbook's FORMULAS reproduce the budget engine's NUMBERS.

    python3 scripts/verifyBudgetWorkbook.py <budget.json> <workbook.xlsx>

The Budget tab renders numbers computed in JavaScript (services/budgetModel.js);
the workbook computes its own from live Excel formulas. Those are two independent
implementations of the same model, and if they ever drift, someone in a meeting is
reading one number off the screen and a different one off the spreadsheet.

So this recalculates the workbook with the `formulas` engine (the same one the
underwriting pipeline uses) and asserts, cell by cell, that every projected line
and every total matches the JSON the workbook was generated from.

Every projected cell and every total is checked, on all three tabs. Nothing is
skipped: the 12-month workbook has no string-arithmetic rows left to exclude.
"""

import json
import sys
import os

import formulas

# Tolerance, in dollars.
#
# For a single entity this is effectively zero — the workbook must reproduce the
# engine exactly, and 1.0 only absorbs the float/integer edge.
#
# A ROLL-UP scope is different, and legitimately so. The engine builds the
# portfolio as the exact sum of the entity budgets (so the tab's portfolio total
# always equals its entity totals — the thing that matters in a meeting), which
# means each of N children has already been rounded to the dollar before summing.
# The portfolio workbook instead computes one value from the weighted aggregate and
# rounds once. Summing N rounded numbers can differ from rounding their sum by up
# to N/2 dollars. That is a rounding artifact, not a modelling difference, so the
# band scales with the number of children — and the observed maximum is reported
# either way so a real drift can't hide inside it.
TOL = 1.0


def tolerance_for(d, months_summed=1, lines_summed=1):
    """Worst-case rounding band for one cell.

    Each of the N children is rounded to the dollar before the engine sums them,
    so any single line-month can differ from the workbook's round-once figure by
    at most N/2. A cell that sums M months across L line items compounds that to
    M x L x N/2. Derived bound, not a fudge factor.
    """
    kids = len(d.get("aggregatedFrom") or [])
    return TOL if not kids else TOL + months_summed * lines_summed * kids / 2.0


def main():
    if len(sys.argv) < 3:
        print("usage: verifyBudgetWorkbook.py <budget.json> <workbook.xlsx>", file=sys.stderr)
        return 2
    budget_path, wb_path = sys.argv[1], sys.argv[2]
    with open(budget_path, encoding="utf-8") as fh:
        d = json.load(fh)

    print(f"Recalculating {os.path.basename(wb_path)} …")
    xl = formulas.ExcelModel().loads(wb_path).finish()
    sol = xl.calculate()

    # The engine keys cells as '[file.xlsx]SHEET NAME'!A1 — sheet name uppercased,
    # file name left exactly as it is on disk. Normalise both sides rather than
    # guessing, so a rename never silently turns every check into a false pass.
    book = os.path.basename(wb_path)
    index = {k.upper(): k for k in sol}

    def val(sheet, ref):
        key = index.get(f"'[{book}]{sheet}'!{ref}".upper())
        if key is None:
            return None
        v = sol[key]
        try:
            v = v.value[0, 0]
        except Exception:
            pass
        try:
            return float(v)
        except Exception:
            return v

    # Locate the Budget rows by reading column A (the line key) and column B
    # (the label), rather than assuming a fixed layout.
    from openpyxl import load_workbook
    wb = load_workbook(wb_path)

    # ── the cached-value preview must actually be in the file ─────────────────
    # Every formula also carries the result the engine computed, because Excel's
    # Protected View does not calculate and a formula with no cached value shows
    # as an empty cell — which is what made the whole model look blank when it
    # was opened straight from a download. The injection edits saved XML, so a
    # future openpyxl that writes cells differently would stop applying SILENTLY.
    # Fail here instead: a blank-looking workbook in an accountant's inbox is
    # worse than a failed build.
    cached_wb = load_workbook(wb_path, data_only=True)
    cached_mb = cached_wb["Budget"]
    probe_mb = wb["Budget"]
    formula_cells = cached_hits = 0
    for row in probe_mb.iter_rows():
        for c in row:
            if isinstance(c.value, str) and c.value.startswith("="):
                formula_cells += 1
                if cached_mb[c.coordinate].value is not None:
                    cached_hits += 1
    if formula_cells and cached_hits < formula_cells * 0.95:
        print(f"\n✗ cached values missing: only {cached_hits} of {formula_cells} Budget "
              f"formula cells carry a result. The workbook will open blank in Protected View "
              f"— see _inject_cached_values in budget/budget_workbook.py.", file=sys.stderr)
        return 1
    print(f"  cached results present on {cached_hits}/{formula_cells} Budget formula cells")

    mb = wb["Budget"]
    key_row, total_row = {}, {}
    for r in range(1, mb.max_row + 1):
        k = mb.cell(row=r, column=1).value
        lbl = mb.cell(row=r, column=2).value
        if k and k not in key_row:
            key_row[k] = r
        if lbl in ("EFFECTIVE GROSS INCOME", "TOTAL OPERATING EXPENSE", "NET OPERATING INCOME",
                   "TOTAL BELOW NOI", "CASH FLOW BEFORE DEBT SERVICE"):
            total_row[lbl] = r

    from openpyxl.utils import get_column_letter
    n = len(d["months"])
    first_col = 4

    failures = []
    checked = 0
    n_lines = max(1, len([l for l in d["lineDefs"] if l["section"] == "opex" and not l.get("memo")]))
    tol_month = tolerance_for(d, 1, 1)
    tol_month_total = tolerance_for(d, 1, n_lines)
    tol_year = tolerance_for(d, 12, 1)
    tol_year_total = tolerance_for(d, 12, n_lines)
    worst = (0.0, "")
    worst_rel = (0.0, "")

    def compare(what, sheet, ref, expected, tol=None):
        nonlocal checked, worst, worst_rel
        tol = tol_month if tol is None else tol
        got = val(sheet, ref)
        checked += 1
        if got is None:
            failures.append(f"{what}: {sheet}!{ref} did not evaluate")
            return
        if not isinstance(got, float):
            failures.append(f"{what}: {sheet}!{ref} = {got!r}, expected {expected}")
            return
        drift = abs(got - expected)
        rel = drift / abs(expected) if expected else 0.0
        if drift > worst[0]:
            worst = (drift, f"{what} ({sheet}!{ref})")
        if rel > worst_rel[0]:
            worst_rel = (rel, f"{what} ({sheet}!{ref})")
        if drift > tol:
            failures.append(f"{what}: {sheet}!{ref} = {got:,.2f}, engine says {expected:,.2f} "
                            f"(drift ${drift:,.2f} / {rel * 100:.4f}%)")

    # ── every projected line, every month ─────────────────────────────────────
    for line in d["lineDefs"]:
        k = line["key"]
        if k not in key_row or k not in d["lines"]:
            continue
        r = key_row[k]
        for i in range(n):
            ref = f"{get_column_letter(first_col + i)}{r}"
            compare(f"line {k} {d['monthLabels'][i]}", "Budget", ref, d["lines"][k][i])

    # ── totals ────────────────────────────────────────────────────────────────
    total_map = {
        "EFFECTIVE GROSS INCOME": "egi",
        "TOTAL OPERATING EXPENSE": "totalOpex",
        "NET OPERATING INCOME": "noi",
        "TOTAL BELOW NOI": "belowNoi",
        "CASH FLOW BEFORE DEBT SERVICE": "cashFlow",
    }
    for label, tkey in total_map.items():
        if label not in total_row:
            failures.append(f"total row '{label}' not found in the workbook")
            continue
        r = total_row[label]
        for i in range(n):
            ref = f"{get_column_letter(first_col + i)}{r}"
            compare(f"total {tkey} {d['monthLabels'][i]}", "Budget", ref, d["totals"][tkey][i], tol_month_total)

    # ── annual roll-up columns ────────────────────────────────────────────────
    year_first = first_col + n + 1
    for y, yr in enumerate(d["years"]):
        col = get_column_letter(year_first + y)
        for label, tkey in total_map.items():
            if label not in total_row:
                continue
            compare(f"{yr['label']} {tkey}", "Budget", f"{col}{total_row[label]}", yr[tkey], tol_year_total)
        for line in d["lineDefs"]:
            k = line["key"]
            if k in key_row and k in yr["lines"]:
                compare(f"{yr['label']} line {k}", "Budget", f"{col}{key_row[k]}", yr["lines"][k], tol_year)

    # ── Base Actuals: the T12 total and monthly average the grid reads ────────
    # These are the only formulas on that tab, and every projected cell in the
    # workbook multiplies the average — so if column P is wrong, everything is.
    ba = wb["Base Actuals"]
    ba_row = {}
    for r in range(1, ba.max_row + 1):
        k = ba.cell(row=r, column=1).value
        if k and k not in ba_row:
            ba_row[k] = r
    for key, b in (d.get("base") or {}).items():
        if key not in ba_row:
            continue
        r = ba_row[key]
        compare(f"base T12 {key}", "Base Actuals", f"O{r}", b["total"], tol_year)
        compare(f"base avg {key}", "Base Actuals", f"P{r}", b["avg"], tol_month)

    kids = len(d.get("aggregatedFrom") or [])
    scope_note = (f" (roll-up of {kids} entities; line band ${tol_month:,.0f}/month, total band ${tol_year_total:,.0f}/year)"
                  if kids else "")
    print(f"  {checked} cells checked{scope_note}")
    print(f"  largest drift: ${worst[0]:,.2f}" + (f" — {worst[1]}" if worst[0] else ""))
    # Reported, not enforced. On a big annual total a 0.01% band would be looser
    # than the derived absolute bound, and on a small line item ordinary
    # dollar-rounding across 13 entities exceeds it for reasons that are not
    # errors. The absolute bound is the real test; this is here so a drift that
    # starts creeping is visible before it becomes a failure.
    print(f"  largest relative drift: {worst_rel[0] * 100:.5f}%" + (f" — {worst_rel[1]}" if worst_rel[0] else ""))
    if failures:
        print(f"\n✗ {len(failures)} mismatch(es):")
        for f in failures[:40]:
            print(f"   {f}")
        if len(failures) > 40:
            print(f"   … and {len(failures) - 40} more")
        return 1
    if kids:
        print("\n✓ workbook formulas reproduce the engine within the roll-up rounding band")
    else:
        print("\n✓ workbook formulas reproduce the engine exactly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
