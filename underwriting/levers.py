"""
Finished underwriting model -> our bid and what would make the deal work, as JSON.

the owner, 2026-11-01: "instead of needing their asking price, we just give the
asking price that we would need to buy that property" and show "other ways to do
things that could raise the score". So every report leads with our bid (the
price that hits the IRR target) and lists the levers a buyer actually has, each
with what it does to the IRR at the model's price and to our bid.

Nothing here is a new assumption about the deal: the cash flows are rebuilt from
the values the model baked (Pro Forma NOI and EGI, Debt & Exit, Inputs, Tax),
exactly as the model's own Max Price Solver builds them (property tax re-set to
the new price where the state reassesses on sale, asset-management fee paid
below NOI, sale in the hold year at the exit cap). Before any lever is printed
the rebuilt IRR must tie to the model's own Levered IRR; a model that does not
tie gets {"error": ...} and the report leaves the section out.

The levers are sizes, not forecasts - "debt 0.5 pt cheaper", "$250/unit/yr of
expense savings" - so the reader can judge which ones are real for this deal.

    python levers.py <model.xlsx>
"""
import json
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).parent))

_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

from openpyxl import load_workbook

TIE = 0.0005   # rebuilt IRR within 0.05 pt of the model's


def num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def find_row(ws, label, start=1, end=None):
    want = label.lower()
    for r in range(start, (end or ws.max_row) + 1):
        v = ws.cell(r, 1).value
        if v is not None and str(v).strip().lower().startswith(want):
            return r
    return None


def irr(cfs):
    f = lambda r: sum(c / (1 + r) ** t for t, c in enumerate(cfs))
    lo, hi = -0.99, 3.0
    if f(lo) * f(hi) > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(lo) * f(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


class Deal:
    def __init__(self, path_or_wb):
        wb = path_or_wb if hasattr(path_or_wb, "sheetnames") else load_workbook(path_or_wb, data_only=True)
        i, pf, de, tx = wb["Inputs"], wb["Pro Forma"], wb["Debt & Exit"], wb["Tax"]

        def inp(label):
            r = find_row(i, label, 5, 70)
            return num(i.cell(r, 2).value) if r else None

        self.units = inp("Units")
        self.ltv, self.rate, self.hold = inp("LTV"), inp("Loan Interest Rate"), int(inp("Hold Period") or 0)
        self.exit_cap, self.sale_cost, self.close = inp("Exit Cap Rate"), inp("Disposition / Closing Cost at Exit"), inp("Closing Cost")
        self.am, self.amort = inp("Asset Management Fee") or 0.0, inp("Amortization Period") or 0.0
        self.target = inp("IRR Target") or 0.16
        self.inc_g, self.exp_g, self.tax_g = inp("Income Growth") or 0.0, inp("Expense Growth") or 0.0, inp("Tax Growth") or 0.0
        self.mgmt = inp("Management Fee") or 0.0
        self.price = num(de["B6"].value)
        self.capex = num(de.cell(find_row(de, "Total Capex", 5, 20), 2).value) or 0.0
        self.model_irr = num(de.cell(find_row(de, "Levered IRR", 18, 40), 2).value)
        self.t12_noi = num(wb["T12 Actuals"]["B23"].value)

        hdr = find_row(pf, "Line Item", 1, 12)
        cols = {}
        for c in range(2, pf.max_column + 1):
            h = str(pf.cell(hdr, c).value or "").strip()
            if h.lower().startswith("year ") and h[5:].strip().isdigit():
                cols[int(h[5:])] = c
        rows = lambda label: [num(pf.cell(find_row(pf, label, hdr + 1, hdr + 40), cols[y]).value) for y in sorted(cols)]
        self.noi, self.egi = rows("Net Operating Income"), rows("Effective Gross Income")

        # year-1 property tax as a function of price - the Max Price Solver's own rule
        self.tv, self.mill = num(tx["B8"].value) or 0.0, num(tx["B9"].value) or 0.0
        self.nonad, self.t12_tax = num(tx["B10"].value) or 0.0, num(tx["B13"].value) or 0.0
        self.reassess = num(tx["B19"].value) or 0.0

        missing = [k for k in ("units", "ltv", "rate", "exit_cap", "sale_cost", "close", "price") if getattr(self, k) is None]
        if missing or self.hold < 1 or len(self.noi) < self.hold or None in self.noi[:self.hold] or None in self.egi[:self.hold]:
            raise ValueError("this model's cash flows could not be read" + (f" ({', '.join(missing)} missing)" if missing else ""))

    def tax1(self, price):
        if self.mill <= 0 or (self.tv <= 0 and self.reassess < 1):
            return self.t12_tax
        return (self.tv + (price - self.tv) * self.reassess) * self.mill / 1000 + self.nonad

    def run(self, price=None, rate=None, ltv=None, exit_cap=None, opex_save=0.0, income_add=0.0):
        """Levered IRR. opex_save / income_add are $/unit/yr in Year 1, grown like the lines they touch."""
        price = self.price if price is None else price
        rate = self.rate if rate is None else rate
        ltv = self.ltv if ltv is None else ltv
        exit_cap = self.exit_cap if exit_cap is None else exit_cap
        loan = price * ltv
        if self.amort > 0 and rate > 0:
            n = self.amort
            ds = loan * rate / (1 - (1 + rate) ** -n)
            payoff = loan * (1 + rate) ** self.hold - ds * ((1 + rate) ** self.hold - 1) / rate
        else:
            ds, payoff = loan * rate, loan
        d_tax = self.tax1(self.price) - self.tax1(price)
        cfs = [-(price - loan + self.capex + price * self.close)]
        last_noi = None
        for t in range(1, self.hold + 1):
            extra_inc = income_add * self.units * (1 + self.inc_g) ** (t - 1)
            noi = (self.noi[t - 1] + d_tax * (1 + self.tax_g) ** (t - 1)
                   + opex_save * self.units * (1 + self.exp_g) ** (t - 1) + extra_inc * (1 - self.mgmt))
            egi = self.egi[t - 1] + extra_inc
            cfs.append(noi - ds - egi * self.am)
            last_noi = noi
        cfs[-1] += last_noi / exit_cap * (1 - self.sale_cost) - payoff
        return irr(cfs)

    def bid(self, **kw):
        """Price that hits the IRR target with these levers, or None when no price in the bracket does."""
        base = self.t12_noi if self.t12_noi and self.t12_noi > 0 else self.price * 0.055
        # a lease-up's T12 NOI says nothing about what it is worth (Pinecrest, 2026-11-02): the bracket also spans a tenth to one
        # and a half times the model's price, so a deal whose income arrives after the rebuild still gets a bid
        lo, hi = min(base / 0.15, self.price * 0.1), max(base / 0.02, self.price * 1.5)
        f = lambda p: (self.run(price=p, **kw) or -1) - self.target
        if f(lo) < 0 or f(hi) > 0:
            return None
        for _ in range(80):
            mid = (lo + hi) / 2
            if f(mid) >= 0:
                lo = mid
            else:
                hi = mid
        return lo


def exact_bid(wb):
    """Our bid on an open workbook (values), or None when the rebuild does not tie to the model's IRR."""
    try:
        d = Deal(wb)
        base = d.run()
        if base is None or d.model_irr is None or abs(base - d.model_irr) > TIE:
            return None
        return d.bid()
    except Exception:
        return None


def levers(path_or_wb):
    d = Deal(path_or_wb)
    base = d.run()
    if base is None or d.model_irr is None or abs(base - d.model_irr) > TIE:
        return {"error": f"rebuilt IRR {base} does not tie to the model's {d.model_irr}; levers left out"}

    bid = d.bid()
    out = {
        "price": d.price, "units": d.units, "irr": base, "target": d.target, "hold": d.hold, "t12_noi": d.t12_noi,
        "bid": None if bid is None else {
            "price": bid, "per_unit": bid / d.units, "vs_price": bid / d.price - 1,
            "cap_on_t12": (d.t12_noi / bid) if d.t12_noi else None},
        "levers": [],
    }

    lv = []
    lv.append(("rate", f"Debt 0.5 pt cheaper ({(d.rate - 0.005) * 100:.2f}% instead of {d.rate * 100:.2f}%)",
               "Agency or assumable debt, a rate buy-down, or a better lender quote.", {"rate": d.rate - 0.005}))
    # Leverage cuts both ways: at a price where the property yields less than the loan costs, borrowing less
    # raises the IRR, and at our bid it is usually the other way round. So it is shown at the model's price only
    # and kept out of the bid and of "together".
    alt_ltv = 0.60 if (d.run(ltv=0.60) or -1) > base else 0.75
    lv.append(("ltv", f"Borrow {alt_ltv * 100:.0f}% of the price instead of {d.ltv * 100:.0f}%",
               ("At this price the property yields less than the loan costs, so every borrowed dollar lowers the return."
                if alt_ltv < d.ltv else "The property yields more than the loan costs, so more debt raises the return."),
               {"ltv": alt_ltv}))
    lv.append(("opex", "Run it $250/unit a year cheaper",
               "Payroll, contracts, utilities billed back, insurance re-bid: savings every year, also worth more at sale.",
               {"opex_save": 250.0}))
    lv.append(("income", "$25/unit a month more other income",
               "Utility bill-back (RUBS), parking, storage, pet and admin fees, net of the 3% management fee.",
               {"income_add": 300.0}))
    lv.append(("exit", f"Sell at a {(d.exit_cap - 0.0025) * 100:.2f}% cap instead of {d.exit_cap * 100:.2f}%",
               "A quarter-point stronger market at sale. Not in our control - shown so it is not counted on.",
               {"exit_cap": d.exit_cap - 0.0025}))
    controllable = {}
    for key, label, how, kw in lv:
        r = d.run(**kw)
        b = None if key == "ltv" else d.bid(**kw)
        out["levers"].append({"key": key, "label": label, "how": how, "irr": r, "change": None if r is None else r - base,
                              "bid": b})
        if key not in ("exit", "ltv"):
            controllable.update(kw)
    r = d.run(**controllable)
    b = d.bid(**controllable)
    out["together"] = {"label": "Cheaper debt, lower costs and more income, together", "irr": r,
                       "change": None if r is None else r - base, "bid": b}
    return out


if __name__ == "__main__":
    if len(sys.argv) != 2:
        _REAL_STDOUT.write(json.dumps({"error": "Usage: python levers.py <model.xlsx>"}) + "\n")
        sys.exit(1)
    try:
        res = levers(sys.argv[1])
    except Exception as e:
        res = {"error": f"Could not read this model: {e}"}
    _REAL_STDOUT.write(json.dumps(res, default=str) + "\n")
