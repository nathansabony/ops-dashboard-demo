// Transaction-level GL detail — the "show me the actual invoices" drill-down
// behind a Variance flag.
//
// Report 45 (propertyFinancials.js) gives monthly TOTALS per GL account. That is
// the right shape for the heatmap, but it cannot answer the question a flag
// actually raises: WHY is this month $18K, or why is it $0? For that you need the
// individual postings.
//
// RM has no /GLTransactions resource (it 404s on this instance — verified
// 2026-07-29). The transaction detail lives in **Report 51 "GeneralLedger"** run
// with IsSummary=False, which returns one row per posting: date, type, vendor,
// description, debit, credit, running balance.
//
// Real example (88 Maple Court water, 2026) that shows why this matters: the
// monthly totals read Jan $0 / Feb $5.3K / Mar $16.8K, which looks like a January
// posting hole and a March explosion. The transactions show something different —
// every line is a Columbus Water autopay, and each one names the SERVICE PERIOD
// it covers ("30304039580321 - 01/05/26 - 02/02/26"). January's water was billed;
// it just posted in Feb and Mar. The month a charge lands in is the date it was
// PAID, not the month the water was used.

const rentManager = require('./rentManagerClient');

const REPORT_ID = 51;        // GeneralLedger
const BASIS_ACCRUAL = 1;     // 1 = Accrual (2 is Cash); matches propertyFinancials so the detail ties to the totals

// ── GL account resolution ────────────────────────────────────────────────────
// Report 51 filters by numeric GLAccountID, but everything else in this codebase
// keys off the stable GL *reference* string ('5402'). Resolve one to the other,
// including children: ref '5402' means 5402 itself plus 5402-1..5402-4, because a
// category's monthly total is the parent's IsTotal row.
let _acctCache = null;       // { at, byRef: Map<ref, {id, name}>, all: [...] }
const ACCT_TTL_MS = 60 * 60 * 1000; // the chart of accounts changes ~never

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const grids = Object.entries(payload)
    .filter(([k, v]) => /^Grid\d+$/i.test(k) && Array.isArray(v))
    .flatMap(([, v]) => v);
  if (grids.length) return grids;
  return payload.Results || payload.Items || payload.Data || [];
}

// The one RM figure parser (services/rmAmount.js). This file's own copy was the
// CORRECT one — accounting parentheses and all — but three other services carried
// weaker versions that silently zeroed a credit, so the copies are gone and there
// is one implementation to be right or wrong.
const { parseAmount: num } = require('./rmAmount');

async function loadAccounts() {
  if (_acctCache && Date.now() - _acctCache.at < ACCT_TTL_MS) return _acctCache;
  const rows = asRows(await rentManager.allGLAccounts());
  const all = rows
    .map(a => ({ id: a.GLAccountID, name: a.Name || '', ref: String(a.Reference || '').trim() }))
    .filter(a => a.id != null && a.ref);
  _acctCache = { at: Date.now(), all };
  return _acctCache;
}

// Every account id for a set of refs, including `<ref>-N` children.
async function accountIdsForRefs(refs) {
  const { all } = await loadAccounts();
  const out = new Map();
  for (const ref of refs) {
    for (const a of all) {
      if (a.ref === ref || a.ref.startsWith(`${ref}-`)) out.set(a.id, a);
    }
  }
  return [...out.values()];
}

// ── Report 51 ────────────────────────────────────────────────────────────────
async function runGeneralLedger({ propOwnerIds, glAccountIds, startDate, endDate }) {
  const p = {
    StartDate: startDate,
    EndDate: endDate,
    PropOwnerIDs: String(propOwnerIds),
    GLAccountIDs: glAccountIds.join(','),
    Basis: String(BASIS_ACCRUAL),
    IsSummary: 'False',          // the whole point — one row per posting
    SHOWINACTIVEPROPS: 'False',
    GroupID: '0',
    INCLUDEINACTIVEOWNERS: 'False',
    RUNBYOWNER: 'False',
    CHARTMAPID: '0',
    CombineReceivableTypes: 'False',
    UNITID: '-1',
    SHOWDEPOSITBREAKDOWN: 'False',
    ZeroAmountExclusion: '1',
    BatchPropsOrUnits: '',
    RestrictByOwnerContractDates: 'false',
    ExcludePeriodAdjustments: 'False',
    StartPeriodID: '0',
    EndPeriodID: '0',
    RunByPeriod: 'false',
  };
  const params = {};
  Object.keys(p).forEach((id, i) => {
    params[`parameters[${i}].Parameter`] = id;
    params[`parameters[${i}].Value`] = p[id];
    params[`parameters[${i}].InListItemMode`] = 'false';
  });
  return asRows(await rentManager.RunReport(REPORT_ID, params));
}

// RM appends per-account summary rows (BeginBalance/EndBalance, no date) and, for
// an account with nothing in the window, a placeholder row dated 0001-01-01 with
// the description "No activity in the period". Neither is a posting.
function isPosting(r) {
  const d = String(r.TransactionDate || '');
  if (!d || d.startsWith('0001-01-01')) return false;
  return num(r.Debit) !== 0 || num(r.Credit) !== 0;
}

// A charge's service period, when the vendor put it in the description — e.g.
// "Columbus Water: 30304039580321 - 01/05/26 - 02/02/26". This is the single
// most useful field for explaining a lumpy month, so it gets pulled out rather
// than left buried in free text.
const PERIOD_RE = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/;
function servicePeriod(description) {
  const m = PERIOD_RE.exec(String(description || '').trim());
  return m ? { from: m[1], to: m[2] } : null;
}

// "Tubs Refinishing Services Inc.: 100134" → "100134" — the vendor's invoice
// number, which is the bill's Reference. Same rule as the Renovations tab.
function invoiceNumberFrom(description) {
  const at = String(description || '').lastIndexOf(':');
  if (at < 0) return null;
  const tail = String(description).slice(at + 1).trim();
  if (!tail || tail.length > 24) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{2,}$/.test(tail) ? tail : null;
}

// A stable id for one posting, so the page can ask for its invoice without the
// server holding state between the two calls (it re-runs the cached report and
// finds the posting again). URL- and HTML-id-safe.
function postingId(p) {
  const parts = [p.property, p.date, p.accountId, p.reference, p.amount.toFixed(2), p.description, p.txnId || ''];
  return require('crypto').createHash('sha1').update(parts.join('|')).digest('base64url').slice(0, 20);
}

function parsePostings(rows) {
  return rows.filter(isPosting).map(r => {
    const debit = num(r.Debit);
    const credit = num(r.Credit);
    // 2026-10-13: the fields the invoice lookup (services/rmDocuments.backupFor)
    // matches a bill on — the vendor (CustomerID), the posting's own transaction
    // (Hyperlink "11:158810" → type code : id) and the invoice number.
    const hyperlink = String(r.Hyperlink || '');
    const p = {
      date: String(r.TransactionDate || '').slice(0, 10),
      type: r.TransactionType || '',
      reference: r.TransactionReference || '',
      description: r.Description || '',
      servicePeriod: servicePeriod(r.Description),
      vendor: r.CustomerName || '',
      property: r.PropertyShortName || '',
      account: r.GLAccountName || '',
      accountId: r.GLAccountID,
      debit,
      credit,
      // Signed amount: a debit is spend, a credit is money coming back. The UI
      // ranks by this, so credits sort to the bottom and read as negatives.
      amount: debit - credit,
      vendorId: r.CustomerID != null ? r.CustomerID : (r.CustomerId != null ? r.CustomerId : null),
      txnId: hyperlink.includes(':') ? hyperlink.split(':')[1] : null,
      txnType: r.TransactionType || '',
      invoiceNo: invoiceNumberFrom(r.Description),
    };
    p.id = postingId(p);
    return p;
  });
}

// ── Public entry ─────────────────────────────────────────────────────────────
// One RM report run. Returns the postings plus a small summary so the caller
// doesn't have to re-derive the totals it will display.
//
// Cached briefly: a flag drill-down is opened, closed and re-opened repeatedly
// while someone works the list, and the answer cannot change within a minute.
const _detailCache = new Map(); // key → { at, payload }
const DETAIL_TTL_MS = 5 * 60 * 1000;
const DETAIL_CACHE_MAX = 100;

// A card that is opened, redrawn and opened again asks for the same window while
// the first Report 51 run is still going; those callers share that run instead of
// each starting another one against Rent Manager.
const _detailInflight = new Map(); // key → promise

async function getGLDetail(args) {
  const { propOwnerIds, refs, startDate, endDate } = args;
  const key = `${propOwnerIds}|${refs.join(',')}|${startDate}|${endDate}`;
  const hit = _detailCache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.payload;
  if (_detailInflight.has(key)) return _detailInflight.get(key);
  const run = fetchGLDetail(key, args).finally(() => _detailInflight.delete(key));
  _detailInflight.set(key, run);
  return run;
}

async function fetchGLDetail(key, { propOwnerIds, refs, startDate, endDate }) {

  const accounts = await accountIdsForRefs(refs);
  if (!accounts.length) {
    return { postings: [], accounts: [], totals: { debit: 0, credit: 0, net: 0, count: 0 }, refs, startDate, endDate };
  }
  const rows = await runGeneralLedger({
    propOwnerIds, glAccountIds: accounts.map(a => a.id), startDate, endDate,
  });
  const postings = parsePostings(rows);
  postings.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : Math.abs(b.amount) - Math.abs(a.amount)));

  const totals = postings.reduce((t, p) => {
    t.debit += p.debit; t.credit += p.credit; t.net += p.amount; t.count += 1;
    return t;
  }, { debit: 0, credit: 0, net: 0, count: 0 });

  const payload = {
    postings,
    accounts: accounts.map(a => ({ id: a.id, ref: a.ref, name: a.name })),
    totals,
    refs, startDate, endDate,
    reportId: REPORT_ID,
    basis: 'Accrual',
  };

  if (_detailCache.size >= DETAIL_CACHE_MAX) _detailCache.delete(_detailCache.keys().next().value);
  _detailCache.set(key, { at: Date.now(), payload });
  return payload;
}

module.exports = {
  REPORT_ID,
  getGLDetail,
  accountIdsForRefs,
  parsePostings,
  servicePeriod,
  invoiceNumberFrom,
};
