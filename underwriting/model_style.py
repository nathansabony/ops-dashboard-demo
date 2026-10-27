"""
Presentation of a model workbook (2026-10-22, The owner: "launch a full UI of the Excel").

Shared by the generator (every new model) and repair_model.py (models already on the disk). It changes how cells LOOK and adds a
few helper cells and one new tab; it never moves a cell and never changes a formula another cell depends on, so every number in
the model is the number it was. Idempotent: running it twice leaves the same workbook.

  palette        the old navy / yellow / light-green fills become the site's Forest Ledger greens, paper and gold
  tabs           coloured by what the tab IS: documents (blue), inputs (gold), Pro Forma (green), Debt & Exit (light green),
                 Exit Scenarios (red), tools (teal), supporting sheets (grey)
  inputs         a gold box = a number you can change; a sage box = read from your documents; no box = calculated
  dashboard      the number formats on the details table were wrong ("$206" units, "$1" DSCR, "$2" equity multiple)
  pro forma      subtotals, a dark NOI line, a quiet benchmark column (the standard order: GPR, vacancy and credit loss,
                 EGI, operating expenses, NOI, debt service, cash flow)
  reno pace      a model with no renovation program says so instead of showing a page of zeros
  comps          KPI tiles read "n/a" instead of 0; an empty sale-comp table says it is empty
  price tool     NEW tab: pick a cap rate, read the price, loan, equity, NOI, IRR and cash-on-cash at it
"""
from copy import copy

from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

INK, GREEN, GREEN2, RED, GOLD = "14342A", "14532D", "2F7D5B", "8C2020", "B98A2E"
PAPER, SAGE, GOLD_FILL, LINE, MUTED = "F6F3EC", "EAF1EA", "FFF4D6", "E6E1D6", "6B645A"

# legacy fill (last six hex digits) -> new fill (None = no fill)
RECOLOR = {
    "1F4E78": GREEN, "0F243E": INK, "2E5F8F": GREEN2,
    "F0F5FA": PAPER, "D9E2EC": LINE, "DCE6F1": LINE, "EAF2F8": PAPER,
    "FFF2CC": None,                     # "calculated": no fill, so the numbers breathe
    "F2F2F2": "FAF8F3", "F7F7F7": None,
    "E2F0D9": SAGE, "DDEED3": SAGE, "EAF4E3": SAGE,
    "DDEBF7": GOLD_FILL,                # "editable input"
    "FCE4D6": "F7EDEC", "F4CCCC": "F7EDEC",
}
INPUT_LEGACY, SOURCE_LEGACY = {"DDEBF7"}, {"E2F0D9", "DDEED3", "EAF4E3"}

# only the tabs that matter are coloured (The owner, 2026-10-22: "not every tab gets a colour")
TAB_COLORS = {
    "Dashboard": INK, "Inputs": GOLD, "Pro Forma": GREEN, "Debt & Exit": GREEN2, "Exit Scenarios": "C00000", "Price Tool": "1F6F78",
}

MONEY = '$#,##0;($#,##0);"-"'
NUM = '#,##0;(#,##0);"-"'
PCT1 = '0.0%'
X2 = '0.00"x"'
DASH_FORMATS = {
    "units": NUM, "t12 noi": MONEY, "purchase price": MONEY, "price per unit": MONEY, "loan amount": MONEY,
    "initial equity": MONEY, "year 1 noi": MONEY, "year 5 noi": MONEY, "year 8 noi": MONEY, "year 1 dscr": X2,
    "levered irr": PCT1, "equity multiple": X2, "current county tax": MONEY, "new tax after sale": MONEY,
    "official rent roll occupancy": PCT1, "current avg rent": MONEY, "target avg rent": MONEY, "market avg occupancy": PCT1,
    "units to renovate": NUM, "total noi opportunity": MONEY, "max price to hit": MONEY, "...same, per unit": MONEY,
}


def _rgb6(c):
    v = getattr(getattr(c, "fgColor", None), "rgb", None)
    return v[-6:].upper() if isinstance(v, str) and len(v) >= 6 else None


def _fill(hex6):
    return PatternFill("solid", fgColor="FF" + hex6) if hex6 else PatternFill(fill_type=None)


def _font(cell, **kw):
    f = copy(cell.font)
    cell.font = Font(name=kw.get("name", f.name), size=kw.get("size", f.size), bold=kw.get("bold", f.bold), italic=kw.get("italic", f.italic),
                     color=kw.get("color", f.color), underline=f.underline)


def recolor(wb):
    """Old palette -> new, cell by cell; boxes for inputs and document-sourced numbers."""
    side = lambda hex6: Side(style="thin", color="FF" + hex6)
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                old = _rgb6(cell.fill) if cell.fill and cell.fill.fill_type == "solid" else None
                if old in RECOLOR:
                    cell.fill = _fill(RECOLOR[old])
                    if old in INPUT_LEGACY:
                        cell.border = Border(left=side(GOLD), right=side(GOLD), top=side(GOLD), bottom=side(GOLD))
                        _font(cell, bold=True)
                    elif old in SOURCE_LEGACY and ws.title in ("Inputs", "Tax"):
                        cell.border = Border(left=side("9DB89D"), right=side("9DB89D"), top=side("9DB89D"), bottom=side("9DB89D"))
                fc = cell.font.color.rgb if cell.font and cell.font.color and isinstance(cell.font.color.rgb, str) else None
                if fc and fc[-6:].upper() == "1F4E78":
                    _font(cell, color="FF" + GREEN)
    # an old section bar with nothing in it (the Dashboard has one under the details table) is just a stripe: remove it
    for ws in wb.worksheets:
        for r in range(1, ws.max_row + 1):
            cells = [ws.cell(r, c) for c in range(1, ws.max_column + 1)]
            if all(c.value in (None, "") for c in cells) and any(c.fill and c.fill.fill_type == "solid" and _rgb6(c.fill) in (GREEN, INK) for c in cells):
                for c in cells:
                    c.fill = _fill(None)
    return "Recoloured the workbook from the old navy / yellow / light-green fills to the site's green, paper and gold."


def tabs_and_view(wb):
    for ws in wb.worksheets:
        col = TAB_COLORS.get(ws.title)
        ws.sheet_properties.tabColor = ("FF" + col) if col else None
        ws.sheet_view.showGridLines = False
        ws.sheet_view.zoomScale = 90
    return "Tabs are coloured by what they are and gridlines are off."


def dashboard_formats(wb):
    if "Dashboard" not in wb.sheetnames:
        return None
    ws = wb["Dashboard"]
    for r in range(15, 37):
        label = str(ws.cell(r, 1).value or "").strip().lower()
        for key, fmt in DASH_FORMATS.items():
            if label.startswith(key):
                ws.cell(r, 2).number_format = fmt
                break
    for r in range(40, 47):
        if ws.cell(r, 2).value is not None:
            ws.cell(r, 2).number_format = PCT1
        if ws.cell(r, 3).value is not None and "cash-on-cash" not in str(ws.cell(r, 1).value or "").lower():
            ws.cell(r, 3).number_format = X2
    for r in range(44, 60):
        v = ws.cell(r, 1).value
        if isinstance(v, str) and v.lower().startswith("color legend"):
            ws.cell(r, 1).value = "Colour key:  gold box = a number you can change (Inputs tab)  |  sage = read from your documents  |  white = calculated  |  red = needs verification"
            if not any(str(m).startswith(f"A{r}:") for m in ws.merged_cells.ranges):
                ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=6)
            ws.cell(r, 1).alignment = Alignment(wrap_text=True, vertical="top")
            ws.row_dimensions[r].height = 28
    return "Dashboard details table now shows units, DSCR, equity multiple and occupancy in their own formats."


def inputs_headers(wb):
    if "Inputs" not in wb.sheetnames:
        return None
    ws = wb["Inputs"]
    for r in range(1, 12):
        if str(ws.cell(r, 1).value or "").strip() == "Input / Assumption":
            ws.cell(r, 2).value = "Value"
            ws.cell(r, 3).value = "Where it comes from  (gold box = you can change it, sage = read from your documents)"
            break
    ws.column_dimensions["A"].width = max(ws.column_dimensions["A"].width or 0, 46)
    ws.column_dimensions["B"].width = max(ws.column_dimensions["B"].width or 0, 20)
    for r in range(1, ws.max_row + 1):
        c = ws.cell(r, 2)
        if c.value is not None and c.fill is not None and c.fill.fill_type == "solid":
            isnum = isinstance(c.value, (int, float)) or (isinstance(c.value, str) and c.value.startswith("="))
            c.alignment = Alignment(horizontal="right" if isnum else "left", vertical="center", wrap_text=not isnum)
    return "Inputs: gold boxes are the numbers to change; sage boxes are read from the documents."


def pro_forma(wb):
    if "Pro Forma" not in wb.sheetnames:
        return None
    ws = wb["Pro Forma"]
    subtotal = ("net rental income", "effective gross income", "total operating expenses", "net income after debt service", "net cash flow after reserves")
    last_col = ws.max_column
    hdr = next((r for r in range(1, 12) if str(ws.cell(r, 1).value or "").strip() == "Line Item"), None)
    for r in range(1, ws.max_row + 1):
        label = str(ws.cell(r, 1).value or "").strip().lower()
        if label in subtotal:
            for c in range(1, last_col + 1):
                cell = ws.cell(r, c)
                cell.font = Font(name=cell.font.name, size=cell.font.size, bold=True, color=cell.font.color)
                cell.border = Border(top=Side(style="thin", color="FF" + GREEN), bottom=Side(style="hair", color="FF" + GREEN))
                cell.fill = _fill("F1F5F1")
        elif label == "net operating income":
            for c in range(1, last_col + 1):
                cell = ws.cell(r, c)
                cell.font = Font(name=cell.font.name, size=cell.font.size, bold=True, color="FFFFFFFF")
                cell.fill = _fill(GREEN)
        elif label.startswith("financing"):
            for c in range(1, last_col + 1):
                cell = ws.cell(r, c)
                cell.font = Font(name=cell.font.name, size=cell.font.size, bold=True, color="FFFFFFFF")
                cell.fill = _fill(GREEN2)
    note = ws["A4"].value
    if isinstance(note, str) and len(note) > 80 and not any(str(m).startswith("A4:") for m in ws.merged_cells.ranges):
        ws.merge_cells(start_row=4, start_column=1, end_row=4, end_column=min(last_col, 11))
        ws["A4"].alignment = Alignment(wrap_text=True, vertical="top")
        ws["A4"].font = Font(italic=True, size=9, color="FF" + MUTED)
        ws.row_dimensions[4].height = 36
    if hdr:
        ws.freeze_panes = ws.cell(hdr + 1, 2)
        for c in range(1, last_col + 1):
            ws.cell(hdr, c).alignment = Alignment(horizontal="center" if c > 1 else "left", vertical="center", wrap_text=True)
        ws.row_dimensions[hdr].height = 30
    ws.column_dimensions["A"].width = max(ws.column_dimensions["A"].width or 0, 36)
    return "Pro Forma: standard order with shaded subtotals, a dark NOI line and a quiet benchmark column."


def pro_forma_per_unit(wb):
    """Year-1 dollars per unit and as a share of EGI, to the right of the Pro Forma (the usual two extra columns)."""
    if "Pro Forma" not in wb.sheetnames:
        return None
    ws = wb["Pro Forma"]
    hdr = next((r for r in range(1, 12) if str(ws.cell(r, 1).value or "").strip() == "Line Item"), None)
    egi = next((r for r in range(1, ws.max_row + 1) if str(ws.cell(r, 1).value or "").strip().lower() == "effective gross income"), None)
    noi = next((r for r in range(1, ws.max_row + 1) if str(ws.cell(r, 1).value or "").strip().lower() == "net operating income"), None)
    if not (hdr and egi and noi) or ws.max_column > 13 or ws.cell(hdr, 14).value:
        return None
    for c, text in ((14, "Yr-1 $ / Unit"), (15, "Yr-1 % of EGI")):
        h = ws.cell(hdr, c)
        h.value = text
        src = ws.cell(hdr, 5)
        h.fill, h.font, h.alignment = copy(src.fill), copy(src.font), Alignment(horizontal="center", vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(c)].width = 14
    for r in range(hdr + 1, noi + 1):
        label = str(ws.cell(r, 1).value or "").strip()
        if not label or "%" in label or ws.cell(r, 5).value in (None, ""):
            continue
        a, b = ws.cell(r, 14), ws.cell(r, 15)
        a.value = f'=IFERROR($E{r}/Inputs!$B$13,"")'
        b.value = f'=IFERROR($E{r}/$E${egi},"")'
        a.number_format, b.number_format = MONEY, PCT1
        bold = label.lower() in ("net rental income", "effective gross income", "total operating expenses", "net operating income")
        for cell in (a, b):
            cell.font = Font(bold=bold, color="FFFFFFFF" if label.lower() == "net operating income" else None)
            cell.alignment = Alignment(horizontal="right")
            if label.lower() == "net operating income":
                cell.fill = _fill(GREEN)
            elif bold:
                cell.fill = _fill("F1F5F1")
    return "Pro Forma gained Year-1 $ per unit and % of EGI columns."


def source_sheets(wb):
    """Rent Roll summary: counts were showing as percentages ("Parsed Unit Count 20600.0%") and the text wrapped a word to a line."""
    notes = []
    if "Rent Roll" in wb.sheetnames:
        ws = wb["Rent Roll"]
        for r in range(4, 24):
            label = str(ws.cell(r, 1).value or "").strip().lower()
            if not label or label in ("unit", "metric"):
                continue
            if "occupancy" in label:
                fmt = PCT1
            elif "units" in label or "count" in label:
                fmt = NUM
            elif any(k in label for k in ("rent", "loss", "balance")):
                fmt = MONEY
            else:
                continue
            ws.cell(r, 2).number_format = fmt
        for col, w in (("C", 16), ("D", 28), ("E", 28), ("F", 24)):
            ws.column_dimensions[col].width = max(ws.column_dimensions[col].width or 0, w)
        for r in range(4, 24):
            for c in range(3, 7):
                cell = ws.cell(r, c)
                if isinstance(cell.value, str) and not cell.value.startswith("="):
                    cell.alignment = Alignment(wrap_text=True, vertical="top")
        notes.append("Rent Roll summary: counts and occupancy in their own formats, wider text columns.")
    if "T12 Actuals" in wb.sheetnames:
        ws = wb["T12 Actuals"]
        ws.column_dimensions["C"].width = max(ws.column_dimensions["C"].width or 0, 46)
        notes.append("T12 Actuals: wider notes column.")
    return " ".join(notes) or None


def exit_scenarios_red(wb):
    if "Exit Scenarios" not in wb.sheetnames:
        return None
    ws = wb["Exit Scenarios"]
    for row in ws.iter_rows():
        for cell in row:
            if cell.fill and cell.fill.fill_type == "solid" and _rgb6(cell.fill) == GREEN:
                cell.fill = _fill(RED)
    return "Exit Scenarios headers are red."


def reno_pace(wb):
    if "Reno Pace" not in wb.sheetnames:
        return None
    ws = wb["Reno Pace"]
    has_msg = str(ws["A4"].value or "").startswith("=IF($A$2=0")
    orig = str(ws["A4"].value or "").replace('"', '""')
    # the two tiles pointed at stale cells (B33, B38: table cells), so they read $0 beside a table of real numbers
    r_y1 = next((r for r in range(20, ws.max_row + 1) if str(ws.cell(r, 1).value or "").strip().lower() == "year 1 net rent impact"), None)
    r_prem = next((r for r in range(20, ws.max_row + 1) if str(ws.cell(r, 1).value or "").strip().lower().startswith("stabilised annual gross premium")), None)
    if r_y1 and r_prem:
        ws["C2"].value, ws["D2"].value = f"=IFERROR(B{r_y1},0)", f"=IFERROR(B{r_prem},0)"
    if str(ws["A103"].value or "").startswith("Renovation Schedule Summary"):
        ws["A103"].value = "Renovation Schedule Summary - Years 1-8"
    thin = Side(style="hair", color="FF" + LINE)
    for r in range(6, 102):
        for c in range(1, 8):
            cell = ws.cell(r, c)
            cell.fill = _fill(None)
            cell.font = Font(name=cell.font.name, size=cell.font.size, bold=False, color=cell.font.color)
            cell.border = Border(bottom=thin)
            cell.number_format = "0" if c == 1 else ('#,##0.0;(#,##0.0);"-"' if c in (2, 3, 4) else MONEY)
            cell.alignment = Alignment(horizontal="center" if c == 1 else "right")
    for r in range(104, 112):
        for c, f in ((2, MONEY), (3, MONEY), (4, MONEY), (5, NUM)):
            ws.cell(r, c).number_format = f
    for r, f in ((113, "0"), (114, MONEY), (115, MONEY), (116, MONEY)):
        ws.cell(r, 2).number_format = f
    ws.row_dimensions[5].height = 44
    for c in range(1, 8):
        ws.cell(5, c).alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws["C2"].number_format = ws["D2"].number_format = MONEY
    _a4 = ('=IF($A$2=0,"No renovation program is modeled: Value-Add Units is 0 on the Inputs tab, so every month below is zero. '
                      'Enter the number of units to renovate (and the pace) on Inputs to see the schedule.","' + orig + '")')
    if has_msg:
        return "Reno Pace tiles and table tidied."
    ws["A4"].value = _a4
    ws["A4"].alignment = Alignment(wrap_text=True, vertical="top")
    ws.row_dimensions[4].height = 32
    first = next((r for r in range(5, 12) if str(ws.cell(r, 1).value or "").strip().lower() == "month"), 5)
    rng = f"A{first + 1}:G{ws.max_row}"
    ws.conditional_formatting.add(rng, FormulaRule(formula=["$A$2=0"], font=Font(color="FFB5B0A5")))
    for row in ws.iter_rows(min_row=first + 1, max_row=ws.max_row, min_col=2, max_col=7):
        for cell in row:
            if cell.number_format in ("General", "0", "#,##0"):
                cell.number_format = NUM
    return "Reno Pace says so when no renovation program is modeled, instead of a page of zeros."


def comps(wb):
    notes = []
    for name in ("Rent Comps", "Sale Comps"):
        if name not in wb.sheetnames:
            continue
        ws = wb[name]
        wrapped = 0
        for c in range(1, 8):
            v = ws.cell(2, c).value
            if isinstance(v, str) and v.startswith("=") and "n/a" not in v:
                f = v[1:]
                ws.cell(2, c).value = f'=IF(IFERROR({f},0)=0,"n/a",{f})'
                wrapped += 1
        if wrapped:
            notes.append(f"{name}: empty figures read n/a, not 0.")
    if "Sale Comps" in wb.sheetnames:
        ws = wb["Sale Comps"]
        body = [r for r in range(6, ws.max_row + 1) if ws.cell(r, 6).value not in (None, "")]
        free = next((r for r in range(6, ws.max_row + 2) if all(ws.cell(r, c).value in (None, "") for c in range(1, 6))), None)
        if not body and free:
            ws.cell(free, 1).value = ("No sale comps were provided with this deal (they are not pulled automatically). Add recent sales in the rows "
                                      "below, or send the broker's sales comps, and the market figures above fill in.")
            ws.cell(free, 1).font = Font(italic=True, color="FF" + MUTED)
            notes.append("Sale Comps says it is empty.")
    return " ".join(notes) or None


def price_tool(wb):
    """A small tool on top of the Max Price Solver grid: pick a cap rate, read the price and returns."""
    if "Max Price Solver" not in wb.sheetnames or "Price Tool" in wb.sheetnames:
        return None
    sv = "'Max Price Solver'!"
    ws = wb.create_sheet("Price Tool", index=wb.sheetnames.index("Max Price Solver") + 1)
    ws.sheet_view.showGridLines = False
    ws.sheet_properties.tabColor = "FF" + TAB_COLORS["Price Tool"]
    ws.column_dimensions["A"].width = 44
    ws.column_dimensions["B"].width = 22
    ws.column_dimensions["C"].width = 70
    ws.merge_cells("A1:C1")
    ws["A1"].value = "Price Tool - pick a purchase cap rate, read the price and the returns"
    ws["A1"].font = Font(size=16, bold=True, color="FFFFFFFF")
    ws["A1"].fill = _fill(INK)
    ws["A1"].alignment = Alignment(vertical="center")
    ws.row_dimensions[1].height = 30
    ws["A3"].value = "Purchase cap rate (pick one)"
    start = 0.055
    inp = wb["Inputs"] if "Inputs" in wb.sheetnames else None
    if inp is not None:
        for rr in range(1, 40):
            if str(inp.cell(rr, 1).value or "").strip().lower() == "purchase cap rate" and isinstance(inp.cell(rr, 2).value, (int, float)):
                start = min(0.12, max(0.03, round(round(inp.cell(rr, 2).value / 0.005) * 0.005, 4)))
                break
    ws["B3"].value = start
    ws["B3"].number_format = "0.00%"
    ws["B3"].font = Font(size=14, bold=True)
    ws["B3"].fill = _fill(GOLD_FILL)
    ws["B3"].border = Border(*(Side(style="medium", color="FF" + GOLD),) * 4)
    ws["B3"].alignment = Alignment(horizontal="center")
    ws["C3"].value = "Click the box and choose from the list. The price is the T12 NOI divided by this cap rate; everything below reprices at it."
    ws["C3"].font = Font(italic=True, color="FF" + MUTED)
    dv = DataValidation(type="list", formula1=f"={sv}$B$7:$T$7", allow_blank=False, showDropDown=False)
    dv.error, dv.errorTitle = "Pick a cap rate from the list.", "Cap rate"
    ws.add_data_validation(dv)
    dv.add("B3")
    idx = f"MATCH(ROUND($B$3,4),{sv}$B$7:$T$7,0)"
    ws["D3"].value = f"={idx}"
    ws["D3"].font = Font(color="FFFFFFFF")                      # helper, hidden in plain sight
    rows = [
        ("Purchase price", 8, MONEY, ""), ("Price per unit", 9, MONEY, ""), ("Loan amount", 10, MONEY, "at the Inputs tab's loan-to-value"),
        ("Initial equity required", 11, MONEY, "price + capex + closing costs, less the loan"), ("Annual debt service", 12, MONEY, ""),
        ("Year-1 NOI (tax-adjusted)", 14, MONEY, "Pro Forma NOI with property tax repriced at this price"),
        ("Year-2 NOI (tax-adjusted)", 15, MONEY, ""),
        ("Gross exit value", 22, MONEY, "at the hold-period year"), ("Net sale proceeds", 24, MONEY, "after disposition cost and loan payoff"),
        ("Levered IRR", 34, "0.0%", ""), ("Year-2 cash-on-cash", 35, "0.0%", ""),
        ("Levered IRR vs target", 36, "General", ""), ("Year-2 cash-on-cash vs target", 37, "General", ""),
    ]
    r = 5
    for label, src, fmt, note in rows:
        ws.cell(r, 1).value = label
        ws.cell(r, 2).value = f"=IFERROR(INDEX({sv}$B${src}:$T${src},$D$3),\"n/a\")"
        ws.cell(r, 2).number_format = fmt
        ws.cell(r, 2).alignment = Alignment(horizontal="right")
        ws.cell(r, 2).font = Font(bold=label in ("Purchase price", "Levered IRR"), size=12 if label in ("Purchase price", "Levered IRR") else 11)
        ws.cell(r, 3).value = note
        ws.cell(r, 3).font = Font(italic=True, color="FF" + MUTED)
        for c in (1, 2, 3):
            ws.cell(r, c).border = Border(bottom=Side(style="hair", color="FF" + LINE))
        r += 1
    r += 1
    ws.cell(r, 1).value = "The price that just hits your IRR target"
    ws.cell(r, 1).font = Font(bold=True, color="FFFFFFFF")
    for c in (1, 2, 3):
        ws.cell(r, c).fill = _fill(GREEN)
    r += 1
    for label, ref, fmt in (("Max purchase price at the IRR target", "$B$42", MONEY), ("Max price per unit", "$B$43", MONEY),
                            ("Purchase cap rate that gives it", "$B$41", "0.00%"), ("Year-2 cash-on-cash at that price", "$B$45", "0.0%")):
        ws.cell(r, 1).value = label
        ws.cell(r, 2).value = f"={sv}{ref}"
        ws.cell(r, 2).number_format = fmt
        ws.cell(r, 2).alignment = Alignment(horizontal="right")
        ws.cell(r, 2).font = Font(bold=True)
        for c in (1, 2, 3):
            ws.cell(r, c).border = Border(bottom=Side(style="hair", color="FF" + LINE))
        r += 1
    ws.cell(r + 1, 1).value = "The full grid of 19 cap rates is on the Max Price Solver tab; this tab only reads from it."
    ws.cell(r + 1, 1).font = Font(italic=True, color="FF" + MUTED)
    return "New Price Tool tab: pick a cap rate and read the price and returns."


def apply_all(wb):
    notes = []
    for fn in (recolor, tabs_and_view, dashboard_formats, inputs_headers, pro_forma, pro_forma_per_unit, source_sheets, exit_scenarios_red, reno_pace, comps, price_tool):
        n = fn(wb)
        if n:
            notes.append(n)
    return notes
