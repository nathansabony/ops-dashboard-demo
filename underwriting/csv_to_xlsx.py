"""
CSV / TSV export -> a one-tab .xlsx the rent-roll / T12 pipeline already reads.

The owner, 2026-10-21: "it accepts all forms of it — we have to make it accept all
forms." Rent Manager, Yardi and AppFolio all offer CSV as an export choice, and
before today a CSV dropped on the tab was refused outright. Rather than teach
every downstream script (parsers, sheet_sample, mapped_extract, sheet_text) a
second input format, convert once here and hand them the workbook they expect.

    python csv_to_xlsx.py <in.csv> <out.xlsx>

Numbers stay numbers: "$1,250.00", "(310.00)" and "12.5%" become 1250, -310 and
0.125, because the column-mapping fast path sums cells and a string "$1,250"
would read as zero. Anything that is not cleanly a number is kept as text.

Emits JSON: {"rows": N, "cols": N, "delimiter": ","} or {"error": "..."}.
"""
import csv
import io
import json
import re
import sys

_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

NUM_RE = re.compile(r"^\(?-?\$?\s*[\d,]*\.?\d+\s*%?\)?$")


def to_cell(raw):
    s = (raw or "").strip()
    if not s:
        return None
    if NUM_RE.match(s) and re.search(r"\d", s):
        neg = s.startswith("(") and s.endswith(")")
        pct = s.endswith("%") or s.endswith("%)")
        t = s.strip("()").replace("$", "").replace(",", "").replace("%", "").strip()
        try:
            v = float(t)
        except ValueError:
            return s
        if neg:
            v = -abs(v)
        if pct:
            v = v / 100
        return int(v) if v.is_integer() and not pct and "." not in t else v
    return s


def read_text(path):
    data = open(path, "rb").read()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def main(src, out):
    from openpyxl import Workbook
    text = read_text(src)
    sample = text[:20000]
    try:
        delim = csv.Sniffer().sniff(sample, delimiters=",\t;|").delimiter
    except csv.Error:
        delim = "\t" if sample.count("\t") > sample.count(",") else ","
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    rows = cols = 0
    for rec in csv.reader(io.StringIO(text), delimiter=delim):
        ws.append([to_cell(c) for c in rec])
        rows += 1
        cols = max(cols, len(rec))
    if rows == 0:
        _REAL_STDOUT.write(json.dumps({"error": "The CSV file is empty."}) + "\n")
        return
    wb.save(out)
    _REAL_STDOUT.write(json.dumps({"rows": rows, "cols": cols, "delimiter": delim}) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        _REAL_STDOUT.write(json.dumps({"error": "Usage: python csv_to_xlsx.py <in.csv> <out.xlsx>"}) + "\n")
        sys.exit(1)
    try:
        main(sys.argv[1], sys.argv[2])
    except Exception as e:
        _REAL_STDOUT.write(json.dumps({"error": f"Could not read the CSV: {e}"}) + "\n")
