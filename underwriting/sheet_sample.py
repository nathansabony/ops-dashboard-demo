"""
Excel workbook (.xlsx or legacy .xls) -> compact sample for Claude COLUMN MAPPING.

Unlike sheet_text.py (which flattens the whole workbook for full extraction),
this emits only headers + a handful of data rows per sheet, each labeled with
its 1-based row number, cells joined with " | " so commas inside values (e.g.
"Lastname, Firstname") stay unambiguous. Claude reads this and returns a
column mapping; mapped_extract.py then walks every real row deterministically.

Sheets that look like a T12 (a header row of >= 8 month-like columns) get a
different treatment: the head rows plus EVERY row's text labels and row total
— but no monthly numbers — so Claude can map GL lines to the deal buckets
without retyping (or even seeing) the amounts.

Row numbers here MUST match mapped_extract.py exactly, so both read the
workbook the same way: pandas.read_excel(header=None, dtype=object) — R1 is
the first row pandas sees.

Emits JSON: {"format": "xlsx"|"xls", "sheets": [{"name", "rows", "cols"}],
"text": "...", "chars": N}
"""
import json
import math
import re
import sys
from datetime import date, datetime

HEAD_ROWS = 30
MID_ROWS = 4
TAIL_ROWS = 15
MAX_COLS = 40
T12_HEAD_ROWS = 12
T12_MAX_LABEL_ROWS = 500

MONTH_PAT = re.compile(
    r"^((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[ .\-/]*'?\d{2,4}"
    r"|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}[/-]\d{4})$", re.IGNORECASE)


def _cell(v):
    if v is None:
        return ""
    if isinstance(v, float) and math.isnan(v):
        return ""
    if isinstance(v, (datetime, date)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, float) and v == int(v) and abs(v) < 1e15:
        return str(int(v))
    return " ".join(str(v).split())


def _is_monthish(v):
    if isinstance(v, (datetime, date)):
        return True
    return bool(MONTH_PAT.match(_cell(v)))


def _month_header_row(df):
    """1-based index of the first row with >= 8 month-like cells, else None."""
    import pandas as pd
    for i in range(min(20, len(df))):
        hits = sum(1 for v in df.iloc[i, :MAX_COLS] if not pd.isna(v) and _is_monthish(v))
        if hits >= 8:
            return i + 1
    return None


def _t12_lines(df, header_row):
    """Head rows full-width, then every row as labels + row total only."""
    import pandas as pd
    lines = []
    # the month header row is always shown in full, wherever it sits: Orchard Village's statement has it on row 13, one past the
    # 12 head rows, so it was cut to "Account Name | Aug 2025 | Sep 2025" and the reader mapped two month columns
    # (T12 NOI $305K against the statement's own $1,869K)
    head = max(T12_HEAD_ROWS, header_row)
    for i in range(min(head, len(df))):
        row = [_cell(v) for v in df.iloc[i, :MAX_COLS]]
        while row and row[-1] == "":
            row.pop()
        lines.append(f"R{i + 1}: " + " | ".join(row))
    lines.append("--- every remaining row, labels + row total only "
                 "(monthly numbers omitted) ---")
    for i in range(head, min(len(df), head + T12_MAX_LABEL_ROWS)):
        labels, total = [], ""
        for v in df.iloc[i, :MAX_COLS]:
            if pd.isna(v) or _cell(v) == "":
                continue
            if isinstance(v, (int, float)):
                total = _cell(v)  # last numeric wins = the Total column
            elif len(labels) < 3:
                labels.append(_cell(v))
        if not labels and not total:
            continue
        lines.append(f"R{i + 1}: " + " | ".join(labels)
                     + (f" | rowtotal={total}" if total else ""))
    return lines


def sample(path):
    import pandas as pd

    frames = pd.read_excel(path, sheet_name=None, header=None, dtype=object)
    fmt = "xls" if str(path).lower().endswith(".xls") else "xlsx"

    parts, meta = [], []
    for name, df in frames.items():
        nrows, ncols = df.shape
        meta.append({"name": name, "rows": int(nrows), "cols": int(ncols)})
        if nrows == 0:
            continue

        t12_header = _month_header_row(df)
        if t12_header:
            parts.append(
                f"=== SHEET {name} (rows={nrows}, cols={ncols}, "
                f"T12-style: month columns detected on row {t12_header}) ===\n"
                + "\n".join(_t12_lines(df, t12_header)))
            continue

        picks = list(range(min(HEAD_ROWS, nrows)))
        tail_start = max(nrows - TAIL_ROWS, 0)
        if tail_start > HEAD_ROWS:
            span = tail_start - HEAD_ROWS
            picks += sorted({HEAD_ROWS + (span * k) // (MID_ROWS + 1)
                             for k in range(1, MID_ROWS + 1)})
        picks += list(range(tail_start, nrows))
        picks = sorted(set(p for p in picks if 0 <= p < nrows))

        lines, prev = [], None
        for i in picks:
            if prev is not None and i != prev + 1:
                lines.append(f"... (rows {prev + 2}-{i} omitted) ...")
            row = [_cell(v) for v in df.iloc[i, :MAX_COLS]]
            while row and row[-1] == "":
                row.pop()
            lines.append(f"R{i + 1}: " + " | ".join(row))
            prev = i
        parts.append(f"=== SHEET {name} (rows={nrows}, cols={ncols}) ===\n"
                     + "\n".join(lines))

    text = "\n\n".join(parts)
    return {"format": fmt, "sheets": meta, "text": text, "chars": len(text)}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Usage: python sheet_sample.py <file.xlsx|file.xls>"}))
        sys.exit(1)
    try:
        print(json.dumps(sample(sys.argv[1])))
    except Exception as e:
        print(json.dumps({"error": f"Could not read workbook: {e}"}))
        sys.exit(0)
