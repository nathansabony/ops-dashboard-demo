// Per-property monthly P&L pipeline — the live source for the Variance tab.
//
// Pulls Rent Manager Report #45 "ProfitLossRecapMonth" (the report the management site's
// hardcoded M24/M25/M26 numbers were originally exported from), which returns GL
// accounts as rows with one column per month (JAN2026, FEB2026, …). We run it once
// per property (PropOwnerIDs = a single PropertyID) so each property's own monthly
// series is exact, then roll properties up to entities and the portfolio.
//
// Verified against live RM 2026-07-16 (see scripts/_probe*.js, since removed):
//   • Basis=1 is Accrual. (2026-10-06: this said Basis=2, which is CASH — see BASIS_ACCRUAL.)
//   • Water&Sewer Jan-2026 = 338,573, ties to the hardcoded value to the dollar.
//   • A single-PropertyID filter returns just that property's P&L.
//   • RM does NOT emit Total Income / NOI / Net Income as grid rows — we compute
//     them by summing leaf posting rows by GL account type.

const fs = require('fs');
const path = require('path');
const rentManager = require('./rentManagerClient');
const { buildPropertyEntityMap } = require('./entityMap');

const REPORT_ID = 45;          // ProfitLossRecapMonth
// Report 45's Basis parameter: 1 = Accrual, 2 = Cash.
//
// 2026-10-06 (the owner): this was 2 from the start, under a note saying "Basis=2 ==
// Accrual", verified against one Water & Sewer figure. It is Cash. Run side by
// side with Rent Manager's own Accrual 12-Month Recap export for 2301 Willow Creek Rd
// (Oct 25 – Sep 26): Basis=1 matched all 101 accounts in all 12 months; Basis=2
// matched 15. Every "close but not matching" reconciliation on the Variance tab
// traces here — the tab was showing cash-basis books labelled accrual. Earlier
// notes that blamed a mismatch on someone's export being "run on CASH" had it the
// wrong way round. scripts/checkBasisMatchesExport.js holds the check.
const BASIS_ACCRUAL = 1;
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MON_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Category → GL account reference number(s) ────────────────────────────────
// Reference numbers are stable in RM's chart of accounts (unlike account names),
// so we key off them. A category may map to several refs (they're summed). For a
// ref with a hierarchy (e.g. 5402 has child rows plus a "Total" row), valueForRef
// takes the combined row so children aren't double-counted (see classifyRows).
const CATEGORY_REFS = {
  propTax:      ['5301'],           // Total Property Taxes
  mgmtFees:     ['5000'],           // Management Fees Expense
  insurance:    ['5050', '5051'],   // Total Insurance Expense + Car Insurance
  heatingGas:   ['5401'],           // Utilities Heating Gas
  waterSewer:   ['5402'],           // Total Water & Sewer
  // Water & Sewer children — RM splits 5402 into these leaf accounts. Pulled as
  // their own series so the Variance drill-down can show WHICH bill drove a spike
  // (water vs sewer vs solid waste). Sum(5402-1..3) == 5402's IsTotal row.
  waterSubWater: ['5402-1'],        // Utilities Water
  waterSubSewer: ['5402-2'],        // Utilities Sewer
  waterSubWaste: ['5402-3'],        // Solid Waste Charges
  electric:     ['5404'],           // Utilities Electric
  repairsMaint: ['5100'],           // Total Repairs & Maintenance Expense
  turnover:     ['5106'],           // Turnover
  payroll:      ['5700'],           // Total Payroll Expenses
  mgmtWages:    ['5710'],           // Management Wages, Salary (non-operating)
  mortgage:     ['6230'],           // Mortgage Interest Expense (non-operating)
  renCapital:   ['6100'],           // Total REN - Capital Expense (non-operating)
  majRepairs:   ['5150'],           // Total Major - Repair & Maint (non-operating)
  commissions:  ['5040'],           // Commissions Expense (non-operating)
  advertising:  ['5001'],           // Advertising
};

// The derived summary keys we compute rather than read from a report row.
const SUMMARY_KEYS = ['totalIncome', 'totalExpense', 'noi'];
const CATEGORY_KEYS = Object.keys(CATEGORY_REFS);
const ALL_KEYS = [...SUMMARY_KEYS, ...CATEGORY_KEYS];

// Account types RM tags rows with. Operating income vs operating expense drive
// totalIncome / totalExpense / NOI; non-operating rows sit below NOI and are only
// surfaced through their specific categories (mortgage, mgmtWages, …).
//
// Only the 'Income' type counts toward operating Total Income. 'Other Income' is
// deliberately EXCLUDED: it holds one-time, below-the-line items like account 4504
// "Gain on Property Sales" (e.g. $18.8M in Nov-2024 from property sales), which the
// curated P&L excludes from operating income. Including it made totalIncome spike
// 5× in sale months and diverge from the source report. 'N/O INCOME' is likewise
// non-operating and excluded.
const INCOME_TYPES = new Set(['income']);
const OPERATING_EXPENSE_TYPES = new Set(['expense']);

// ── helpers ─────────────────────────────────────────────────────────────────
// The one RM figure parser (services/rmAmount.js). This file's own copy was the
// CORRECT one — accounting parentheses and all — but three other services carried
// weaker versions that silently zeroed a credit, so the copies are gone and there
// is one implementation to be right or wrong.
const { parseAmount: num } = require('./rmAmount');
function truthy(v) { return v === true || v === 'True' || v === 'true'; }
function gridRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const grids = Object.entries(payload)
    .filter(([k, v]) => /^Grid\d+$/i.test(k) && Array.isArray(v))
    .flatMap(([, v]) => v);
  if (grids.length) return grids;
  return payload.Results || payload.Items || payload.Data || [];
}

// Enumerate months from "YYYY-MM" to "YYYY-MM" inclusive.
// Returns [{ year, m0, colKey:'JAN2026', label:'Jan 26' }, ...].
function enumerateMonths(fromYM, toYM) {
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const out = [];
  let y = fy, m = fm; // m is 1-based
  while (y < ty || (y === ty && m <= tm)) {
    const m0 = m - 1;
    out.push({ year: y, m0, colKey: `${MON[m0]}${y}`, label: `${MON_LABEL[m0]} ${String(y).slice(2)}` });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
function lastDayOfMonth(year, m1) { return new Date(year, m1, 0).getDate(); }

// Run Report 45 for one scope (PropOwnerIDs) over a date range. Returns raw rows.
async function runReport45(propOwnerIds, startDate, endDate, opts = {}) {
  const p = {
    StartDate: startDate, EndDate: endDate, PropOwnerIDs: String(propOwnerIds),
    SHOWINACTIVEPROPS: 'False', GroupID: '0', INCLUDEINACTIVEOWNERS: 'False',
    RUNBYOWNER: 'False', Basis: String(BASIS_ACCRUAL), CHARTMAPID: '0',
    COLLAPSEPARENTS: 'False', LEGALPAPER: 'False', SHOWWHOLEDOLLAR: 'False',
    BatchPropsOrUnits: '', RestrictByOwnerContractDates: 'false',
    // Period adjustments are IN by default, which is what makes the snapshot the
    // accrual truth. Rent Manager's own P&L export leaves them out, so the same
    // month can differ between the two by an accrual and its later reversal —
    // which is exactly the Birchwood Commons insurance gap (March +$139,009, April -$138,118
    // against the export). Being able to run it the other way is how that gets
    // proved rather than argued about.
    ExcludePeriodAdjustments: opts.excludePeriodAdjustments ? 'True' : 'False',
    StartPeriodID: '0', EndPeriodID: '0',
    RunByPeriod: 'false', AmountBasis: '0',
  };
  const params = {};
  Object.keys(p).forEach((id, i) => {
    params[`parameters[${i}].Parameter`] = id;
    params[`parameters[${i}].Value`] = p[id];
    params[`parameters[${i}].InListItemMode`] = 'false';
  });
  const body = await rentManager.RunReport(REPORT_ID, params);
  return gridRows(body);
}

// ── Which rows are subtotals ────────────────────────────────────────────────
// 2026-09-22 (the owner / a team member review): the tab was "close but not matching" Rent
// Manager, and the collapsed P&L tied where the expanded one didn't. The expanded
// (COLLAPSEPARENTS=False) report prints a parent account's children AND a combined
// row for the parent — water, sewer and solid waste, then Total Water & Sewer.
// Adding every row counts those dollars twice, and it is not only water: every
// parent with children has the same shape.
//
// This used to trust RM's IsTotal flag alone to tell the two apart. That flag is
// not the only way a subtotal shows up, so a row is now a subtotal if ANY of:
//   • RM flags it IsTotal;
//   • its name starts with "Total" (how the printed report labels them);
//   • it closes a block — it carries the reference of a header that is still open
//     AND equals the sum of the rows inside that block;
//   • it is a parent's row (ref R, with R-1, R-2… children present) whose every
//     month equals the sum of those children — a combined line by arithmetic,
//     whatever it is called. A parent row that does NOT equal its children is
//     money posted directly on the parent, and stays a leaf.
// A subtotal with no reference inherits the ref of the header it closes, so the
// category lookup below can still find it.
//
// The result is what the collapsed report gives: every dollar counted exactly
// once in Total Income / Total Expense, and each category read from its combined
// line. scripts/checkPLSubtotals.js pins every one of these shapes.
function rowRef(r) { return String(r.GLAccountReference != null ? r.GLAccountReference : r.ref || '').trim(); }
function rowName(r) { return String(r.GLAccountName != null ? r.GLAccountName : r.name || '').trim(); }
const TOTAL_NAME_RE = /^total\b/i;

function classifyRows(rows, colKeys) {
  const out = rows.map(r => ({
    row: r, ref: rowRef(r),
    isHeader: truthy(r.IsHeader != null ? r.IsHeader : r.isHeader),
    isSubtotal: false,
    hidden: truthy(r.HideRow),
  }));
  const cols = colKeys && colKeys.length ? colKeys
    : [...new Set(rows.flatMap(r => Object.keys(r)).filter(k => /^[A-Z]{3}\d{4}$/.test(k)))];
  // Does row c carry exactly the sum of `parts` in every month (and some money)?
  const sumsTo = (c, parts) => cols.length && parts.length &&
    cols.some(k => num(c.row[k]) !== 0) &&
    cols.every(k => Math.abs(num(c.row[k]) - parts.reduce((s, x) => s + num(x.row[k]), 0)) < 0.005);

  const open = [];                        // { ref, at } for headers not yet closed
  out.forEach((c, i) => {
    if (c.isHeader) { open.push({ ref: c.ref, at: i }); return; }
    const flagged = truthy(c.row.IsTotal != null ? c.row.IsTotal : c.row.isTotal);
    const named = TOTAL_NAME_RE.test(rowName(c.row));
    const blockIdx = c.ref ? open.map(b => b.ref).lastIndexOf(c.ref) : -1;
    // An unlabelled row that shares an open header's ref is only a total if the
    // arithmetic says so — otherwise it is money posted directly on the parent.
    const closes = blockIdx >= 0 && !flagged && !named &&
      sumsTo(c, out.slice(open[blockIdx].at + 1, i).filter(x => !x.isHeader && !x.isSubtotal));
    if (!(flagged || named || closes)) return;
    c.isSubtotal = true;
    // Close the block this row ends: the matching ref if it has one, else the
    // innermost open header — whose ref an unreferenced total inherits.
    const at = blockIdx >= 0 ? blockIdx : open.length - 1;
    if (at >= 0) {
      if (!c.ref) c.ref = open[at].ref;
      open.length = at;
    }
  });
  // Parent rows that are the arithmetic sum of their `<ref>-N` children.
  const leaves = out.filter(c => !c.isHeader && !c.isSubtotal);
  for (const c of leaves) {
    if (!c.ref) continue;
    const kids = leaves.filter(k => k !== c && k.ref.startsWith(`${c.ref}-`));
    if (sumsTo(c, kids)) c.isSubtotal = true;
  }
  return out;
}

// Pull the value of a GL reference for a given month column: the account's own
// combined line when it has one, else the sum of its posting rows — its own and
// its `<ref>-N` children's — which is the same figure the collapsed report prints.
function valueForRef(classified, ref, colKey) {
  const sub = classified.find(c => c.isSubtotal && c.ref === ref);
  if (sub) return num(sub.row[colKey]);
  return classified
    .filter(c => !c.isHeader && !c.isSubtotal && (c.ref === ref || c.ref.startsWith(`${ref}-`)))
    .reduce((s, c) => s + num(c.row[colKey]), 0);
}

// ── Which accounts a total row actually contains ────────────────────────────
// Report 45 is a tree flattened into rows: a header opens a block, the Total row
// with the same reference closes it, and everything in between belongs to it —
// sub-blocks included. valueForRef above already READS those totals; this records
// what they are made of, so a consumer comparing against one of these lines can
// tell whether an account is inside it.
//
// It matters because the chart nests by position, not by number:
// majRepairs:['5150'] contains 5151, 5220, 5119-1 and a dozen more that share no
// prefix with 5150. Reading it from the report rather than hard-coding a list
// means a new account under Major is picked up the day it is added.
function blockMembersFromRows(rows, refs) {
  const out = {};
  const norm = rows.map(r => ({
    ref: String(r.GLAccountReference != null ? r.GLAccountReference : r.ref || '').trim(),
    isHeader: truthy(r.IsHeader != null ? r.IsHeader : r.isHeader),
    isTotal: truthy(r.IsTotal != null ? r.IsTotal : r.isTotal),
  }));
  for (const ref of refs.map(String)) {
    const start = norm.findIndex(r => r.ref === ref && r.isHeader);
    if (start < 0) continue;
    const end = norm.findIndex((r, i) => i > start && r.ref === ref && r.isTotal);
    if (end < 0) continue;   // an unclosed block is not a block we can vouch for
    const members = new Set([ref]);
    for (let i = start + 1; i < end; i++) if (norm[i].ref) members.add(norm[i].ref);
    out[ref] = [...members];
  }
  return out;
}

// Accumulated across a snapshot build. Report 45 only prints accounts the scope
// actually posted to, so one property's rows are a partial view of the chart —
// the union over every property in the run is the whole of it, and it costs no
// extra request because these rows are already in hand.
let _blockAcc = null;
function recordBlockMembers(rows) {
  if (!_blockAcc) return;
  const roots = [...new Set(Object.values(CATEGORY_REFS).flat().map(String))];
  const found = blockMembersFromRows(rows, roots);
  for (const [ref, members] of Object.entries(found)) {
    const into = _blockAcc[ref] || (_blockAcc[ref] = []);
    for (const m of members) if (!into.includes(m)) into.push(m);
  }
}

// Parse one scope's report rows into { key: [monthly numbers aligned to `months`] }.
function parseSeries(rows, months) {
  const series = {};
  for (const k of ALL_KEYS) series[k] = months.map(() => 0);
  const classified = classifyRows(rows, months.map(m => m.colKey));

  months.forEach((mo, i) => {
    // Categories: each account's combined line (see classifyRows).
    for (const [key, refs] of Object.entries(CATEGORY_REFS)) {
      series[key][i] = refs.reduce((s, ref) => s + valueForRef(classified, ref, mo.colKey), 0);
    }
    // Summary income/expense: posting rows only — headers, subtotals and hidden
    // rows skipped — by account type, so each dollar is counted exactly once.
    let income = 0, expense = 0;
    for (const c of classified) {
      if (c.isHeader || c.isSubtotal || c.hidden) continue;
      const type = String(c.row.GLAccountTypeName || '').trim().toLowerCase();
      const amt = num(c.row[mo.colKey]);
      if (INCOME_TYPES.has(type)) income += amt;
      else if (OPERATING_EXPENSE_TYPES.has(type)) expense += amt;
    }
    series.totalIncome[i] = income;
    series.totalExpense[i] = expense;
    series.noi[i] = income - expense;
  });

  for (const l of topLevelLines(classified, months.map(m => m.colKey))) {
    series[l.key] = l.values;
    if (_lineMeta && !_lineMeta[l.key]) _lineMeta[l.key] = { key: l.key, ref: l.ref, label: l.label, group: l.group };
  }
  return series;
}

// ── Every other line on the P&L (2026-10-06, the owner) ─────────────────────────
// "Make sure every variance is actually being tracked." The categories above are
// the 15 lines the tab was built around; the P&L has more — Exterminating, Office,
// Bank Fees, Legal, Computer & IT, Travel, Internet, Rental Income, Laundry,
// Commercial, Interest Income… — and none of them was pulled, so none could flag.
//
// Every TOP-LEVEL line of the report (a posting account outside any block, or a
// block read off its own total row — exactly the lines the collapsed P&L prints)
// becomes its own series under key `gl:<ref>`, unless it already IS a category.
// A block that contains a category account is skipped as a whole rather than
// double-counting that account. The report's own account type decides the group:
// Income / Other Income / Expense / Non Operating Expense.
const LINE_GROUP = { 'income': 'income', 'other income': 'otherIncome', 'n/o income': 'otherIncome',
                     'expense': 'expense', 'non operating expense': 'nonop' };
// Rent Manager's type names vary ("Non Operating Expense", "N/O Expense",
// "N/O Income", "Other Income"), so read them by meaning rather than exact text.
function lineGroupOf(type) {
  const t = String(type || '').trim().toLowerCase();
  if (LINE_GROUP[t]) return LINE_GROUP[t];
  const nonOp = /\bn\/o\b|non[- ]?operating/.test(t);
  if (/income/.test(t)) return (nonOp || /other/.test(t)) ? 'otherIncome' : 'income';
  if (/expense/.test(t)) return nonOp ? 'nonop' : 'expense';
  return null;
}
const LINE_GROUP_ORDER = { income: 0, otherIncome: 1, expense: 2, nonop: 3 };
const CATEGORY_REF_SET = new Set(Object.values(CATEGORY_REFS).flat().map(String));
let _lineMeta = null;      // key → { key, ref, label, group }, accumulated across a build
function lineLabel(name) {
  return String(name || '').replace(/\s*\(non[- ]?posting\)\s*/ig, ' ').replace(/^Total\s+/i, '').replace(/\s+/g, ' ').trim();
}
function topLevelLines(classified, colKeys) {
  const out = [];
  const open = [];                                  // { ref, header, members:Set }
  for (const c of classified) {
    if (c.isHeader) {
      open.push({ ref: c.ref, header: c, members: new Set() });
      continue;
    }
    for (const b of open) if (c.ref) b.members.add(c.ref);
    if (c.isSubtotal) {
      const at = c.ref ? open.map(b => b.ref).lastIndexOf(c.ref) : -1;
      if (at >= 0) {
        const block = open[at];
        open.length = at;
        if (at === 0) out.push({ ref: block.ref, row: c.row, name: rowName(block.header.row),
                                 type: block.header.row.GLAccountTypeName, members: block.members });
      } else if (!open.length && c.ref) {
        // a parent row that is the arithmetic sum of its <ref>-N children
        out.push({ ref: c.ref, row: c.row, name: rowName(c.row), type: c.row.GLAccountTypeName, members: new Set([c.ref]), parentSum: true });
      }
      continue;
    }
    if (!open.length && c.ref) out.push({ ref: c.ref, row: c.row, name: rowName(c.row), type: c.row.GLAccountTypeName, members: new Set([c.ref]) });
  }
  // Children of a parent-sum row are inside it, not lines of their own.
  const parents = out.filter(l => l.parentSum).map(l => l.ref);
  const lines = out.filter(l => l.parentSum || !parents.some(p => l.ref.startsWith(`${p}-`)));
  const res = [];
  for (const l of lines) {
    if (CATEGORY_REF_SET.has(l.ref) || [...l.members].some(m => CATEGORY_REF_SET.has(m))) continue;
    const group = lineGroupOf(l.type);
    if (!group) continue;
    res.push({ key: `gl:${l.ref}`, ref: l.ref, label: lineLabel(l.name), group,
               values: colKeys.map(k => num(l.row[k])) });
  }
  return res;
}

// ── The accounts inside each line (2026-09-24, the owner) ──────────────────────
// The expanded report already carries every account under a line — 5402-1 Water,
// 5402-2 Sewer, 5402-3 Solid Waste under Water & Sewer; 5102 Windows … and the
// nested 5200 Materials block under Repairs — and the tab used to keep only the
// line's total. This keeps the tree, in the report's own order, so the grid can
// open a line into the same breakdown Rent Manager prints.
//
// Row kinds: 'head' (a sub-block's opening label, no figures), 'leaf' (a posting
// account), 'total' (a sub-block's own total). depth 1 = directly under the line.
// Only lines whose account has children get a tree; a single-account line has
// nothing to open.
const TREE_KEYS = CATEGORY_KEYS.filter(k => !k.startsWith('waterSub'));
function rowId(c, kind) { return `${kind[0]}:${c.ref || rowName(c.row)}`; }
function parseAccountTree(rows, months) {
  const classified = classifyRows(rows, months.map(m => m.colKey));
  const out = {};
  for (const key of TREE_KEYS) {
    const lines = [];
    for (const ref of CATEGORY_REFS[key]) {
      const start = classified.findIndex(c => c.isHeader && c.ref === ref);
      if (start < 0) {
        // No block this time: the account printed as one plain row. That happens
        // to a line made of several accounts (5051 Car Insurance beside the 5050
        // block) and to a parent whose children had no activity in the pulled
        // months (5040 Commissions in a quiet year). Record it as its own row —
        // same id as the "other" posting row the block form carries, so the months
        // from both forms land on one row and the tree still adds up to the line.
        // pruneTree drops a line that turns out to be nothing but this one row.
        const own = classified.find(c => !c.isHeader && !c.isSubtotal && c.ref === ref);
        if (own) lines.push({ id: rowId(own, 'leaf'), kind: 'leaf', ref, name: rowName(own.row), depth: 1,
          s: months.map(m => valueForRef(classified, ref, m.colKey)) });
        continue;
      }
      let depth = 1;
      for (let i = start + 1; i < classified.length; i++) {
        const c = classified[i];
        if (c.isSubtotal && c.ref === ref) break;              // the line's own total
        const name = rowName(c.row);
        if (c.isHeader) { lines.push({ id: rowId(c, 'head'), kind: 'head', ref: c.ref, name, depth }); depth++; continue; }
        if (c.isSubtotal) depth = Math.max(1, depth - 1);
        const kind = c.isSubtotal ? 'total' : 'leaf';
        lines.push({ id: rowId(c, kind), kind, ref: c.ref, name, depth,
          s: months.map(m => num(c.row[m.colKey])) });
      }
    }
    if (lines.length) out[key] = lines;
  }
  return out;
}

// Fold `src` (one property's, or one chunk's, tree) into `into`, placing each
// row's figures at global month indices. Rows are matched by id; a row `into`
// has not seen goes in right after the row that precedes it in `src`, so the
// union keeps the chart's order even when properties use different accounts.
function mergeTree(into, src, nMonths, idxOf) {
  for (const [key, lines] of Object.entries(src)) {
    const dst = into[key] || (into[key] = []);
    let prev = -1;
    for (const l of lines) {
      let at = dst.findIndex(d => d.id === l.id);
      if (at < 0) {
        at = prev + 1;
        dst.splice(at, 0, { id: l.id, kind: l.kind, ref: l.ref, name: l.name, depth: l.depth,
          ...(l.kind === 'head' ? {} : { s: new Array(nMonths).fill(0) }) });
      }
      if (l.s) l.s.forEach((v, j) => { const gi = idxOf(j); if (gi != null) dst[at].s[gi] += v; });
      prev = at;
    }
  }
  return into;
}
// A line whose whole tree is its own single account has nothing to open.
function pruneTree(tree) {
  for (const [key, lines] of Object.entries(tree)) {
    const refs = CATEGORY_REFS[key] || [];
    if (lines.length === 1 && lines[0].kind === 'leaf' && refs.length === 1 && lines[0].ref === refs[0]) delete tree[key];
  }
  return tree;
}
function roundTree(tree) {
  pruneTree(tree);
  for (const lines of Object.values(tree)) for (const l of lines) if (l.s) l.s = l.s.map(v => Math.round(v * 100) / 100);
  return tree;
}

function emptySeries(months) {
  const s = {};
  for (const k of ALL_KEYS) s[k] = months.map(() => 0);
  return s;
}

// RM's ProfitLossRecapMonth returns at most 12 month columns per call (a >12-month
// range silently returns only the first 12 months). So a longer range has to be
// split across calls and stitched back together.
//
// 2026-08-13 (the owner): chunk from the NEWEST month BACKWARDS, not by calendar year.
//
// To be clear about what this does and does not buy, because it was asked as a
// correctness question: both schemes are exact. Verified against RM on 2026-08-13,
// every category, every month, worst cell difference $0.00
// (scripts/reconcileVariancePL.js check C). Stitching was never shifting months —
// results are placed by RM's own column key (JAN2026, …), never by position.
//
// What changes is where the seam falls. Calendar-year chunking split the most
// recent 12 months across two report runs (Sep–Dec 25 in one, Jan–Aug 26 in
// another). Chunking backwards puts those 12 — the whole of 2026 plus the tail of
// 2025, i.e. every month anyone reconciles against a T12 P&L export — in a single
// report run. Only the two oldest context columns on the grid (the same-month-last-
// year column and the one beside it) now come from the second call.
//
// A cross-calendar-year 12-month range in one call is supported: 2025-09-01 →
// 2026-08-31 returns exactly SEP2025…AUG2026 (check A). It also costs fewer calls —
// a 21-month window is 2 runs instead of 3.
const MAX_MONTH_COLS = 12;
// 2026-10-07: chunks never span a gap. A report run is requested by its first and
// last month, so a chunk holding [Feb 24 … Nov 24, Sep 25, Oct 25] asked Rent
// Manager for 21 calendar months; RM returns at most 12 columns, and Sep/Oct 25
// came back empty. That happened on the first incremental refresh after the pull
// window grew to 36 months (the new year was missing, the middle was not), and it
// zeroed two months of the trailing 12 until a full rebuild. Now the list is first
// split into runs of consecutive months, and each run is chunked from its newest
// end — so every request covers at most MAX_MONTH_COLS consecutive months.
function chunkTrailing(months) {
  const key = m => m.year * 12 + m.m0;
  const runs = [];
  months.forEach((m, i) => {
    if (i === 0 || key(m) !== key(months[i - 1]) + 1) runs.push([]);
    runs[runs.length - 1].push(m);
  });
  const chunks = [];
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r];
    for (let end = run.length; end > 0; end -= MAX_MONTH_COLS) {
      chunks.push(run.slice(Math.max(0, end - MAX_MONTH_COLS), end));
    }
  }
  return chunks; // newest chunk first
}

// The window the tab DISPLAYS: a trailing 12 complete months plus the in-progress
// month. The refresh window below is derived from it, and scripts/checkVarianceWindow.js
// asserts the two stay in step with the frontend's own slice (t12Window).
const DISPLAYED_MONTHS = 13;

// Which months an incremental refresh has to re-pull, given the baseline snapshot
// it is seeded from. Everything the grid can display is always in here — that is
// the whole point (see the 2026-08-13 note above: replaying displayed months from a
// stale baseline is exactly how the tab came to disagree with a fresh P&L export).
// Extracted from pullPortfolioMonthly so it can be tested without an RM call.
function refreshWindow(months, baselineLabels, nowYear) {
  if (!baselineLabels || !baselineLabels.length) return months.slice(); // no baseline → pull everything
  const have = new Set(baselineLabels);
  const freshFromIdx = Math.max(0, months.length - DISPLAYED_MONTHS);
  const lyIdx = months.length - 1 - DISPLAYED_MONTHS;   // the same-month-last-year column
  return months.filter((m, i) => i >= freshFromIdx || i === lyIdx || m.year >= nowYear || !have.has(m.label));
}

// Pull one scope's (PropOwnerIDs) full series. `months` need not be contiguous —
// each chunk is requested by its own first/last month, and results are stitched
// back by RM's own column key (JAN2026, …), never by position, so a chunk that
// comes back short can only ever leave a zero, never shift a neighbouring month.
async function pullScopeSeries(propOwnerIds, months, opts = {}) {
  const series = emptySeries(months);
  const tree = {};
  const idxByColKey = new Map(months.map((m, i) => [m.colKey, i]));
  for (const ym of chunkTrailing(months)) {
    const first = ym[0];
    const last = ym[ym.length - 1];
    const start = `${first.year}-${String(first.m0 + 1).padStart(2, '0')}-01`;
    const lastM1 = last.m0 + 1;
    const end = `${last.year}-${String(lastM1).padStart(2, '0')}-${String(lastDayOfMonth(last.year, lastM1)).padStart(2, '0')}`;
    const rows = await runReport45(propOwnerIds, start, end);
    recordBlockMembers(rows);
    const sub = parseSeries(rows, ym);
    ym.forEach((m, j) => {
      const gi = idxByColKey.get(m.colKey);
      for (const k of Object.keys(sub)) {
        if (!series[k]) series[k] = months.map(() => 0);
        series[k][gi] = sub[k][j];
      }
    });
    if (opts.tree) mergeTree(tree, parseAccountTree(rows, ym), months.length, j => idxByColKey.get(ym[j].colKey));
  }
  if (opts.tree) opts.tree.result = tree;
  return series;
}
function addInto(target, src) {
  for (const k of Object.keys(src)) {
    if (!Array.isArray(src[k])) continue;
    if (!target[k]) target[k] = src[k].map(() => 0);
    for (let i = 0; i < src[k].length; i++) target[k][i] += src[k][i];
  }
}
function round(series) {
  const out = {};
  for (const k of Object.keys(series)) if (Array.isArray(series[k])) out[k] = series[k].map(v => Math.round(v * 100) / 100);
  return out;
}

// ── main entry: pull the whole portfolio, per property, rolled up ────────────
// Returns the response payload consumed by the Variance tab (see server.js route).
//
// Incremental mode: pass `baseline` (the previous cached payload) and only the
// CURRENT calendar year is re-pulled from RM — prior years are seeded from the
// baseline (they only move when RM restates old books, which a manual full
// recompute picks up). Cuts a routine refresh from ~267 RM calls to ~89.
//
// Concurrency: RM's ~8-session cap is on LOGINS, not requests — every call here
// shares one cached token (rentManagerClient), so a small parallel pool is safe.
const PULL_CONCURRENCY = 4;

async function pullPortfolioMonthly(fromYM, toYM, { onProgress, baseline } = {}) {
  const months = enumerateMonths(fromYM, toYM);
  const [ty, tm] = toYM.split('-').map(Number);

  const { byId } = await buildPropertyEntityMap(rentManager);
  const propertyIds = [...byId.keys()];
  // Seeded from the previous snapshot, not started empty.
  //
  // A refresh does not re-read every month — chunkTrailing pulls the recent ones
  // plus a baseline — so the rows this build sees are a slice of the ledger, and
  // an account used only in an older month (5164 Major - Sidewalk Repair: four
  // charges, May 2025, one property) appears in none of them. Rebuilding the
  // index from scratch each time therefore dropped those accounts, and the
  // renovation cross-check read that as "this account is outside the P&L" and
  // switched itself off over $16,600 that was never outside anything.
  //
  // The nesting is a property of the chart of accounts, which is stable, so the
  // union across refreshes is the honest reading rather than the latest slice.
  _blockAcc = {};
  // Every P&L line seen in this run (see topLevelLines), seeded from the last
  // snapshot for the same reason as the block index: an account used only in an
  // old month must not vanish from the rules screen because this pull skipped it.
  _lineMeta = {};
  try {
    const prevLines = (loadSnapshot() || {}).lineMeta;
    if (Array.isArray(prevLines)) for (const l of prevLines) if (l && l.key) _lineMeta[l.key] = l;
  } catch (err) { /* start clean */ }
  try {
    const prev = loadSnapshot();
    const prevMembers = prev && (prev.categoryMembers || (prev.data && prev.data.categoryMembers));
    if (prevMembers) for (const [ref, members] of Object.entries(prevMembers)) {
      if (Array.isArray(members)) _blockAcc[ref] = [...members];
    }
  } catch (err) { /* no previous snapshot — start clean */ }

  const properties = {};
  const entities = {};
  const portfolio = emptySeries(months);
  // The account trees behind each line, per scope (see parseAccountTree).
  const trees = { properties: {}, entities: {}, portfolio: {} };
  const baseTrees = baseline && baseline.accounts && baseline.accounts.properties;

  // Which months actually need a live pull?
  //
  // 2026-08-13: this used to be "the current calendar year, plus anything the
  // baseline doesn't cover" — and that was a real source of numbers that would not
  // tie to a freshly-run P&L. The grid displays a TRAILING 12 months, which in
  // August 2026 reaches back to Sep 2025. Those four prior-year columns were never
  // re-pulled by an incremental refresh; they were replayed from a snapshot that
  // could be weeks old. Any month accounting restated after that snapshot was taken
  // stayed wrong on the tab indefinitely, and no amount of pressing Refresh fixed
  // it — only a manual full recompute did.
  //
  // So the refresh window is now the whole DISPLAYED window (trailing 12 + the
  // in-progress month) plus the same month a year earlier for the last-year column,
  // unioned with the current calendar year. Everything older is baseline-only
  // history that the detector reads and nobody looks at, and RM restating a month
  // that old is what the full recompute is for. Cost is unchanged in practice: the
  // displayed window is one report call per property (see chunkTrailing).
  const nowYear = new Date().getFullYear();
  const baseOk = baseline && Array.isArray(baseline.months) && baseline.properties;
  const baseIdxByLabel = baseOk ? new Map(baseline.months.map((l, i) => [l, i])) : null;
  const monthsToPull = refreshWindow(months, baseOk ? baseline.months : null, nowYear);
  const idxByColKey = new Map(months.map((m, i) => [m.colKey, i]));

  let done = 0;
  let next = 0;
  async function pullOne() {
    while (true) {
      const i = next++;
      if (i >= propertyIds.length) return;
      const pid = propertyIds[i];
      const meta = byId.get(pid);

      // Seed every month we can from the baseline snapshot first.
      const series = emptySeries(months);
      if (baseOk && baseline.properties[pid]) {
        const bp = baseline.properties[pid];
        months.forEach((m, gi) => {
          const bi = baseIdxByLabel.get(m.label);
          if (bi === undefined) return;
          for (const k of Object.keys(bp)) {
            if (!Array.isArray(bp[k])) continue;
            if (!series[k]) series[k] = months.map(() => 0);
            series[k][gi] = bp[k][bi] || 0;
          }
        });
      }
      // Tree: seeded from the baseline the same way (months only it covers),
      // then the pulled months written over it.
      const tree = {};
      if (baseOk && baseTrees && baseTrees[pid]) {
        const pulled = new Set(monthsToPull.map(m => m.label));
        const seed = {};
        for (const [key, lines] of Object.entries(baseTrees[pid])) {
          seed[key] = lines.map(l => l.s ? { ...l, s: l.s.map((v, bi) => (pulled.has(baseline.months[bi]) ? 0 : v)) } : l);
        }
        mergeTree(tree, seed, months.length, bi => {
          const gi = months.findIndex(m => m.label === baseline.months[bi]);
          return gi < 0 ? null : gi;
        });
      }
      try {
        if (monthsToPull.length) {
          const treeOut = {};
          const sub = await pullScopeSeries(pid, monthsToPull, { tree: treeOut });
          monthsToPull.forEach((m, j) => {
            const gi = idxByColKey.get(m.colKey);
            for (const k of Object.keys(sub)) {
              if (!series[k]) series[k] = months.map(() => 0);
              series[k][gi] = sub[k][j];
            }
          });
          // treeOut is indexed by position in monthsToPull — map each to its
          // global month. (2026-10-06: this passed the index straight through, so
          // after an incremental refresh — which pulls a SUBSET of months — every
          // breakdown row sat under the wrong month: Willow Creek Rd Aug 26 tax bill
          // showed in Nov 25. A full build pulls every month, which hid it.)
          mergeTree(tree, treeOut.result || {}, months.length, j => idxByColKey.get(monthsToPull[j].colKey));
        }
      } catch (err) {
        // A single property failing shouldn't sink the whole pull — keep whatever
        // the baseline seeded (or zeros) and note it, so the total is transparently
        // short rather than aborted.
        meta.error = err.message;
      }
      properties[pid] = { name: meta.name, entity: meta.entity, ...round(series) };
      trees.properties[pid] = tree;       // rounded + pruned on output, after the roll-ups
      mergeTree(trees.entities[meta.entity] || (trees.entities[meta.entity] = {}), tree, months.length, gi => gi);
      mergeTree(trees.portfolio, tree, months.length, gi => gi);

      // Aggregation is synchronous JS — no race across the pool.
      if (!entities[meta.entity]) entities[meta.entity] = emptySeries(months);
      addInto(entities[meta.entity], series);
      addInto(portfolio, series);

      done += 1;
      if (onProgress) onProgress(done, propertyIds.length, meta.name);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PULL_CONCURRENCY, propertyIds.length) }, pullOne));

  // Round entity/portfolio aggregates.
  const entitiesOut = {};
  for (const [name, s] of Object.entries(entities)) entitiesOut[name] = round(s);

  const now = new Date();
  const asOfMonth = months[months.length - 1] ? `${months[months.length - 1].year}-${String(months[months.length - 1].m0 + 1).padStart(2, '0')}` : toYM;
  const partialCurrentMonth = (ty === now.getFullYear() && tm === now.getMonth() + 1);

  return {
    configured: true,
    refreshedAt: now.toISOString(),
    asOfMonth,
    partialCurrentMonth,
    basis: 'Accrual',
    months: months.map(m => m.label),
    categories: ALL_KEYS,
    portfolio: round(portfolio),
    // What each category's total row is made of, unioned over every property in
    // this run. Consumers that compare their own account set against one of these
    // P&L lines need it to tell an account that is inside the line from one that
    // is genuinely outside it.
    categoryMembers: _blockAcc || {},
    // Every other top-level P&L line pulled as its own series (key gl:<ref>), in
    // report order within each group — the Variance tab's "every line" coverage.
    lineMeta: Object.values(_lineMeta || {}).sort((a, b) =>
      (LINE_GROUP_ORDER[a.group] - LINE_GROUP_ORDER[b.group]) || String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true })),
    entities: entitiesOut,
    properties,
    // Served separately (/api/financials/property-monthly/accounts) — it is the
    // bulk of the payload and the grid only needs it when a line is opened.
    accounts: {
      properties: Object.fromEntries(Object.entries(trees.properties).map(([k, t]) => [k, roundTree(t)])),
      entities: Object.fromEntries(Object.entries(trees.entities).map(([k, t]) => [k, roundTree(t)])),
      portfolio: roundTree(trees.portfolio),
    },
    sources: { reportId: REPORT_ID, report: 'ProfitLossRecapMonth', propertyCount: propertyIds.length },
  };
}

// ── Cache + background build ─────────────────────────────────────────────────
// The full per-property backfill is ~267 RM calls and takes a minute or two, so it
// must never run inside a page-load request. Instead we cache the built payload
// (in memory + a disk snapshot) and only rebuild on an explicit recompute, or the
// first time the cache is empty. Closed months never change once a month is booked,
// so an on-demand rebuild model is enough — we don't auto-poll.
const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'property-pl-cache.json');
// 2026-10-07 (the owner): three years. The multi-year payroll trend from the
// 2026-10-06 meeting compares the last 12 months with the 12 before AND the 12
// before that, which needs 36 complete months — and it needs them all year round.
// The old window ("December two years back") shrank to ~13 months every January,
// so the year-over-year check only had a full prior year from about September on.
// So the window is now ROLLING: the 36 months before the current one, plus the
// current month. It still covers what the old one did — the trailing 12 the grid
// shows, the same-month-last-year column, and the January flag that reaches back
// to the previous December for its seasonal panel.
//
// Basis is untouched: every month, old or new, goes through runReport45 with
// Basis=BASIS_ACCRUAL. An incremental refresh pulls the months the snapshot does
// not have yet (refreshWindow: `!have.has(m.label)`), so the extra year arrives
// once, on accrual, in the next scheduled refresh — no parse-version bump.
// services/moveActivity.js uses the same window (pullWindowFrom).
const PULL_HISTORY_MONTHS = 36;
function pullWindowFrom(now = new Date()) {
  const idx = now.getFullYear() * 12 + now.getMonth() - PULL_HISTORY_MONTHS;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}
const DEFAULT_FROM = () => pullWindowFrom();
const DEFAULT_TO = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

let _cache = null;        // last successfully built payload
let _building = null;     // in-flight build promise (dedupes concurrent recompute)
let _progress = null;     // { done, total, current } while building
let _lastError = null;

function loadSnapshot() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch {
    _cache = null; // no snapshot on disk yet
  }
  return _cache;
}

function saveSnapshot(payload) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(payload));
  } catch (err) {
    // The host's free tier has no persistent disk, so a write failure here is
    // non-fatal — the in-memory cache still serves until the next deploy.
    _lastError = `snapshot write failed: ${err.message}`;
  }
}

// Kick off (or return the in-flight) build. Non-blocking for callers that don't
// await it. Range defaults to the standard two-years-plus-YTD window.
//
// mode 'incremental' (the default when a snapshot exists): prior years come from
// the cached snapshot, only the current year is re-pulled (~89 RM calls, well
// under a minute with the parallel pool). mode 'full': everything re-pulled
// (~267 calls) — use when RM restates old books or the category map changes.
// Bumped whenever the way rows are READ changes (not just which are pulled). An
// incremental build seeds prior years from the snapshot, so without this a parse
// fix would only reach the months it happens to re-pull; a snapshot from an older
// parse is instead rebuilt in full, once, automatically.
//   2 — 2026-09-22: subtotal rows detected by name / arithmetic, not IsTotal alone.
//   3 — 2026-09-24: per-line account trees (the breakdown under each grid line).
//   4 — 2026-10-06: Basis 2 → 1 (cash → accrual) and the breakdown month fix; every
//       cached month was pulled on the wrong basis, so nothing may be seeded from it.
//   5 — 2026-10-06: every top-level P&L line pulled as its own series (gl:<ref>).
const PARSE_VERSION = 5;

function startBuild(fromYM = DEFAULT_FROM(), toYM = DEFAULT_TO(), mode) {
  if (_building) return _building;
  const baseline = loadSnapshot();
  const baselineCurrent = Boolean(baseline) && baseline.parseVersion === PARSE_VERSION;
  const useBaseline = mode !== 'full' && baselineCurrent;
  _progress = { done: 0, total: null, current: null, mode: useBaseline ? 'incremental' : 'full' };
  _lastError = null;
  _building = pullPortfolioMonthly(fromYM, toYM, {
    baseline: useBaseline ? baseline : null,
    onProgress: (done, total, current) => { _progress = { done, total, current, mode: useBaseline ? 'incremental' : 'full' }; },
  })
    .then(payload => {
      payload.parseVersion = PARSE_VERSION;
      _cache = payload;
      saveSnapshot(payload);
      return payload;
    })
    .catch(err => { _lastError = err.message; throw err; })
    .finally(() => { _building = null; _progress = null; });
  return _building;
}

// ── Auto-refresh: OFF by default, and deliberately so ────────────────────────
// This pulls RM Report 45 — monthly, accrual, per property. A CLOSED month's
// numbers do not change; only the current month moves, and only as postings land,
// which is a once-a-day event at most. There is nothing here that justifies
// re-pulling on a timer.
//
// It used to refresh whenever the snapshot was over 30 minutes old, triggered
// both by the cache warmer and by any page hit. At ~89 report runs a refresh and
// 48 refreshes a day that was ~4,300 report runs daily, running around the clock
// whether or not a single person opened the site — to re-fetch numbers that were
// already correct.
//
// So there is no timer at all. The site shows the LAST PULL until someone presses
// the refresh button — one visible control for every cache, rather than six
// invisible ones each deciding to spend API budget on their own.
//
// The only automatic build left is the first one, when no snapshot exists, so a
// fresh container doesn't serve an empty site forever.
//
// 2026-08-15 — the default is no longer 0. The owner's requirement is that the
// Variance tab always agrees with a P&L pulled from RM that morning, and a
// snapshot that only moves on a schedule cannot promise that: a sweep on
// 2026-08-15 against a 69-hour-old snapshot found 613 disagreeing cells, most of
// them mortgage interest that posted after it was taken.
//
// So there is a top-up, and it is deliberately narrow. Everything the original
// decision objected to still holds — what made the old design cost ~4,600 report
// runs a day was SIX caches each deciding to poll, on a 30-minute threshold,
// around the clock, whether or not anyone was looking. This is one cache, on a
// 6-hour threshold, and it can only fire while someone is actually loading the
// page. An idle site still makes zero calls; a day of heavy use adds at most
// three rebuilds on top of the 5am scheduled one (server.js, dailyScheduleTick).
//
// The refresh is INCREMENTAL, so it re-pulls the displayed window rather than
// every year — ~196 report runs. Set PL_AUTO_REFRESH_MS=0 to turn it off again.
const REFRESH_STALE_MS = Number(process.env.PL_AUTO_REFRESH_MS ?? 6 * 60 * 60 * 1000);

// Minimum gap between two AUTOMATIC build attempts, whatever the outcome.
//
// This exists because staleness is measured from the snapshot's `refreshedAt`,
// and a build that FAILS never advances it. Without a floor here, a failing
// build leaves the cache permanently over the threshold, so every request
// re-triggers it — and the Variance tab polls every 8 seconds while a build is in
// flight, so a single outage (RM down, auth cooldown, session cap) turns into a
// rebuild attempt every 8 seconds, indefinitely. That is a worse version of the
// hammering the auto-refresh was switched off for in the first place.
//
// The gap is on ATTEMPTS, not successes, so a run of failures backs off instead
// of accelerating. The manual Refresh button and the daily schedule call
// startBuild() directly and are deliberately not rate-limited by this — a person
// pressing Refresh should always get a refresh.
const AUTO_BUILD_MIN_GAP_MS = Number(process.env.PL_AUTO_REFRESH_MIN_GAP_MS || 15 * 60 * 1000);
let _lastAutoBuildAt = 0;

// What the GET route returns: cached data if present, plus build status. Triggers a
// first build in the background if the cache is empty, or a cheap incremental
// refresh if the snapshot's current-month data has gone stale.
function getStatus() {
  const cache = loadSnapshot();
  const age = cache ? Date.now() - Date.parse(cache.refreshedAt || 0) : Infinity;
  const sinceLastAttempt = Date.now() - _lastAutoBuildAt;
  if (!_building && rentManager.isConfigured() && sinceLastAttempt > AUTO_BUILD_MIN_GAP_MS) {
    const noSnapshot = !cache;
    const stale = REFRESH_STALE_MS > 0 && (!Number.isFinite(age) || age > REFRESH_STALE_MS);
    const oldParse = Boolean(cache) && cache.parseVersion !== PARSE_VERSION;
    if (noSnapshot || stale || oldParse) {
      // noSnapshot: a fresh container would otherwise serve an empty site forever.
      // stale: the top-up described above.
      _lastAutoBuildAt = Date.now();
      startBuild().catch(() => {});
    }
  }
  return {
    cache,
    building: Boolean(_building),
    progress: _progress,
    lastError: _lastError,
    ageMs: Number.isFinite(age) ? age : null,
    autoRefreshMs: REFRESH_STALE_MS,
  };
}

// Passive check — unlike getStatus, never triggers a build.
function isBuilding() {
  return Boolean(_building);
}

module.exports = {
  PULL_HISTORY_MONTHS, pullWindowFrom,
  REPORT_ID,
  BASIS_ACCRUAL,
  CATEGORY_REFS,
  CATEGORY_KEYS,
  SUMMARY_KEYS,
  ALL_KEYS,
  enumerateMonths,
  chunkTrailing,
  refreshWindow,
  DISPLAYED_MONTHS,
  MAX_MONTH_COLS,
  runReport45,
  blockMembersFromRows,
  classifyRows,
  valueForRef,
  parseAccountTree,
  mergeTree,
  topLevelLines,
  parseSeries,
  pullScopeSeries,
  pullPortfolioMonthly,
  startBuild,
  getStatus,
  isBuilding,
  loadSnapshot,
  SNAPSHOT_FILE,
  PARSE_VERSION,
};
