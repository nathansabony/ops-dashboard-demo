// Rent Manager emulation for the books: the chart of accounts and the accounting reports.
//   /GLAccounts                  chart of accounts
//   Report 45  ProfitLossRecapMonth   (per scope, up to 12 month columns, like the real one)
//   Report 51  GeneralLedger          (one row per posting; IsSummary=False)
//   Report 54  Cash Flow              (the YTD P&L rows the portfolio overview reads)
//   Report 38  Balance Sheet          (bank and loan balances)
//   /Reports/{id}/ReportParameters
// /GLTransactions is deliberately NOT emulated: the real instance 404s on it and the site
// already knows (see services/glTransactions.js).
//
// All amounts come from services/demo/financials.js.

const fin = require('../financials');
const { collection, reportParams } = require('../rmQuery');

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// RM prints accounting-formatted figures: 1,234.56 and (1,234.56).
function money(v) {
  const n = Math.round(Number(v || 0) * 100) / 100;
  const t = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${t})` : t;
}
const ids = s => String(s == null ? '' : s).split(',').map(x => Number(String(x).trim())).filter(n => Number.isFinite(n) && n !== 0);
const scope = p => {
  const want = ids(p.PropOwnerIDs || p.PropertyIDs);
  const pids = want.filter(id => fin.propertyIds.includes(id));
  return want.length ? pids : fin.propertyIds;       // blank / 0 = every property
};
const monthRange = (start, end) => {
  const out = [];
  let i = fin.ymToIdx(String(start).slice(0, 7));
  const last = fin.ymToIdx(String(end).slice(0, 7));
  for (; i <= last; i++) out.push(fin.idxToYM(i));
  return out;
};
const colKey = ym => `${MON[Number(ym.slice(5)) - 1]}${ym.slice(0, 4)}`;

// ── Report 45 ───────────────────────────────────────────────────────────────
function profitLoss(p) {
  const pids = scope(p);
  const months = monthRange(p.StartDate, p.EndDate).slice(0, 12);       // RM returns at most 12 columns
  const sums = new Map();      // ref → [value per month]
  for (const n of fin.leafNodes) {
    sums.set(n.ref, months.map(ym => Math.round(pids.reduce((s, pid) => s + (fin.monthly(pid, ym)[n.ref] || 0), 0) * 100) / 100));
  }
  const active = n => sums.get(n.ref).some(v => v !== 0);
  const rows = [];
  const base = (acct, type, extra) => {
    const r = {
      GLAccountID: acct.id, GLAccountReference: acct.ref, GLAccountName: acct.name, GLAccountTypeName: type,
      IsHeader: false, IsTotal: false, HideRow: false, ...extra,
    };
    return r;
  };
  const cols = (arr) => Object.fromEntries(months.map((ym, i) => [colKey(ym), money(arr[i])]));
  const emit = (items) => {
    for (const it of items) {
      if (it.leaf) {
        if (!active(it.leaf)) continue;
        rows.push(base(fin.accountByRef(it.leaf.ref), it.leaf.type, cols(sums.get(it.leaf.ref))));
      } else {
        const sub = [];
        const collect = (xs) => xs.forEach(x => (x.leaf ? sub.push(x.leaf) : collect(x.children)));
        collect(it.children);
        if (!sub.some(active)) continue;
        const b = it.block;
        const acct = fin.accountByRef(b.ref);
        rows.push(base(acct, b.type, { IsHeader: true }));
        emit(it.children);
        const tot = months.map((_, i) => sub.reduce((s, n) => s + sums.get(n.ref)[i], 0));
        rows.push(base({ id: acct.id, ref: b.ref, name: b.totalName }, b.type, { IsTotal: true, ...cols(tot) }));
      }
    }
  };
  emit(fin.layout);
  return { Grid1: rows };
}

// ── Report 51 ───────────────────────────────────────────────────────────────
// Report 51 prints Rent Manager's line-level transaction codes: a bill line is BILLITM, a check
// line CHKITM, a vendor credit CRDITM, a card swipe CC CHG. The books carry friendlier names.
function rmTxnType(e) {
  if (e.txnType === 'Bill') return e.amount < 0 ? 'CRDITM' : 'BILLITM';
  if (e.txnType === 'Check') return 'CHKITM';
  if (e.txnType === 'Payroll') return 'JE';
  if (e.txnType === 'Charge') return 'CHG';
  return e.txnType;
}
const isoT = d => `${d}T00:00:00`;
function generalLedger(p) {
  const pids = scope(p);
  const acctIds = ids(p.GLAccountIDs);
  const accts = (acctIds.length ? acctIds.map(fin.accountById).filter(Boolean) : fin.chart);
  const refs = accts.map(a => a.ref);
  const start = String(p.StartDate).slice(0, 10), end = String(p.EndDate).slice(0, 10);
  const entries = fin.glEntries(start, end, pids, { refs });
  const byAcct = new Map();
  for (const e of entries) (byAcct.get(e.accountId) || byAcct.set(e.accountId, []).get(e.accountId)).push(e);
  const rows = [];
  for (const a of accts) {
    const list = byAcct.get(a.id) || [];
    if (!list.length) {
      rows.push({ GLAccountID: a.id, GLAccountName: a.name, GLAccountReference: a.ref, TransactionDate: '0001-01-01T00:00:00',
        Description: 'No activity in the period', Debit: money(0), Credit: money(0), PropertyShortName: '' });
      continue;
    }
    for (const e of list) {
      rows.push({
        GLAccountID: a.id, GLAccountName: a.name, GLAccountReference: a.ref,
        PropertyShortName: e.propertyShortName, PropertyID: e.propertyId,
        TransactionDate: isoT(e.date), TransactionType: rmTxnType(e), TransactionReference: e.reference,
        Description: e.description, Memo: e.memo,
        CustomerName: e.vendor, CustomerID: e.vendorId,
        ...(e.unitName ? { UnitName: e.unitName } : {}),
        Debit: money(e.debit), Credit: money(e.credit), Hyperlink: e.hyperlink,
      });
    }
    // RM closes each account with a balance row that carries no date and is not a posting.
    const net = list.reduce((s, e) => s + e.debit - e.credit, 0);
    rows.push({ GLAccountID: a.id, GLAccountName: a.name, GLAccountReference: a.ref, Description: 'End Balance',
      Debit: money(0), Credit: money(0), EndBalance: money(net) });
  }
  return { Grid1: rows };
}

// ── Report 54 (Cash Flow) ───────────────────────────────────────────────────
// Per property, the year-to-date figures the portfolio overview reads (income, operating
// expense, NOI, mortgage interest, net), then the portfolio's own summary lines last.
function cashFlow(p) {
  const months = monthRange(p.StartDate, p.EndDate).filter(ym => fin.MONTHS.includes(ym));
  const rows = [];
  const mk = (label, type, amount, property, accountRef) => ({
    GLAccountName: label, GLAccountTypeName: type, ...(accountRef ? { GLAccountReference: accountRef } : {}),
    ...(property ? { PropertyName: property } : {}), IsHeader: false, IsTotal: false, HideRow: false,
    Amount: Math.round(amount * 100) / 100, RawAmount: Math.round(amount * 100) / 100,
  });
  const tot = { income: 0, opex: 0, noi: 0, net: 0 };
  for (const pid of fin.propertyIds) {
    let income = 0, opex = 0, interest = 0, nonop = 0;
    for (const ym of months) {
      const t = fin.totals(pid, ym);
      income += t.income; opex += t.opex; interest += t.interest; nonop += t.nonop;
    }
    const name = fin.shortName(pid);
    const noi = income - opex;
    const net = noi - nonop;
    rows.push(mk('Total Income', 'Income', income, name));
    rows.push(mk('Total Operating Expenses', 'Expense', opex, name));
    rows.push(mk('Net Operating Income', 'Income', noi, name));
    rows.push(mk('Mortgage Interest Expense', 'Non Operating Expense', interest, name, '6230'));
    rows.push(mk('Net Income', 'Income', net, name));
    tot.income += income; tot.opex += opex; tot.noi += noi; tot.net += net;
  }
  // portfolio lines last — they win over the per-building lines above in the reader
  rows.push(mk('Total Income', 'Income', tot.income));
  rows.push(mk('Total Operating Expenses', 'Expense', tot.opex));
  rows.push(mk('Net Operating Income', 'Income', tot.noi));
  rows.push(mk('Net Income', 'Income', tot.net));
  return { Grid1: rows };
}

// ── Report 38 (Balance Sheet) ───────────────────────────────────────────────
function balanceSheet(p) {
  const asOf = String(p.AsOfDate || p.EndDate || new Date().toISOString()).slice(0, 10);
  const pids = scope(p);
  const rows = [];
  for (const r of fin.balanceSheet(asOf, pids)) {
    rows.push({
      GLAccountID: r.accountId, GLAccountReference: r.ref, GLAccountName: r.name, GLAccountTypeName: r.type,
      IsHeader: false, IsTotal: false, HideRow: false, Amount: r.amount, RawAmount: r.raw,
    });
  }
  return { Grid1: rows };
}

const REPORT_PARAMS = {
  45: ['StartDate', 'EndDate', 'PropOwnerIDs', 'SHOWINACTIVEPROPS', 'GroupID', 'INCLUDEINACTIVEOWNERS', 'RUNBYOWNER', 'Basis', 'CHARTMAPID', 'COLLAPSEPARENTS', 'LEGALPAPER', 'SHOWWHOLEDOLLAR', 'BatchPropsOrUnits', 'RestrictByOwnerContractDates', 'ExcludePeriodAdjustments', 'StartPeriodID', 'EndPeriodID', 'RunByPeriod', 'AmountBasis'],
  51: ['StartDate', 'EndDate', 'PropOwnerIDs', 'GLAccountIDs', 'Basis', 'IsSummary', 'SHOWINACTIVEPROPS', 'GroupID', 'INCLUDEINACTIVEOWNERS', 'RUNBYOWNER', 'CHARTMAPID', 'CombineReceivableTypes', 'UNITID', 'SHOWDEPOSITBREAKDOWN', 'ZeroAmountExclusion', 'BatchPropsOrUnits', 'RestrictByOwnerContractDates', 'ExcludePeriodAdjustments', 'StartPeriodID', 'EndPeriodID', 'RunByPeriod'],
  54: ['StartDate', 'EndDate', 'Basis', 'COLLAPSEPARENTS', 'SHOWWHOLEDOLLAR', 'IsSummary'],
  38: ['AsOfDate', 'Basis', 'COLLAPSEPARENTS', 'SHOWWHOLEDOLLAR'],
};

function register(router) {
  const glRows = () => fin.chart.map(a => ({
    GLAccountID: a.id, ParentGLAccountID: a.parentId, Name: a.name, Description: a.name, Reference: a.ref,
    GLAccountType: a.type, SortOrder: a.sortOrder, IsActive: true,
  }));
  router.get('/GLAccounts', ({ query }) => collection(glRows(), query));
  router.get(/^\/GLAccounts\/(\d+)$/i, ({ query, match }) => collection(glRows().filter(r => r.GLAccountID === Number(match[1])), query));

  router.get(/^\/Reports\/(\d+)\/ReportParameters$/i, ({ match }) => {
    const names = REPORT_PARAMS[Number(match[1])];
    if (!names) return { __status: 404, __body: 'unknown report' };
    return names.map((n, i) => ({ ReportParameterID: i + 1, Name: n, Parameter: n, DefaultValue: '' }));
  });

  const run = fn => ({ query }) => fn(reportParams(query));
  router.get(/^\/Reports\/45\/RunReport$/i, run(profitLoss));
  router.get(/^\/Reports\/51\/RunReport$/i, run(generalLedger));
  router.get(/^\/Reports\/54\/RunReport$/i, run(cashFlow));
  router.get(/^\/Reports\/38\/RunReport$/i, run(balanceSheet));
}

module.exports = { rmTxnType, register, profitLoss, generalLedger, cashFlow, balanceSheet };
