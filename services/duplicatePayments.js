// Payments that charged a bill to expense a second time.
//
// The case that found it (508-10 67th Street, Sep 2026, flagged by the regional manager as
// "Heating gas $4,774 — not sure what this is"): PSE&G's May–Aug bills were in
// Rent Manager and AvidPay paid them correctly on 9/11 (AV1362, $2,838.14). The
// same payment was ALSO keyed by hand twice, on 9/9 and 9/14, as checks written
// straight to the expense accounts rather than against the bills. Each of those
// spent the four bills again. A $5,676.28 credit then cancelled both, but all of
// it to Electric, so Gas read $4.4K high and Electric $4.5K low. The same entry
// habit showed up the same month at 410 Alder Street, 77 Birchwood Lane and 15 Summit Avenue,
// without the cancelling credit.
//
// The test is exact, which is why it can be a flag rather than a hunch: a check
// line posted to an expense account (Report 51 type CHKITM) is by construction
// NOT paying a bill — paying a bill posts to AP, not expense. So when a check
// line and a bill line land on the same property, the same GL account, and name
// the same utility service period (or the same vendor invoice number), that
// service has been expensed twice. Amounts are not required to match: 5004
// Willow Creek check carried $265.24 against a $165.24 bill line, a typo on top of
// the duplicate.
//
// Credits from the same vendor at the same property inside the window are
// carried along, because a credit is how someone usually tries to undo this —
// and whether it went to the right account is the next question.

const glTransactions = require('./glTransactions');
const propertyFinancials = require('./propertyFinancials');
const { buildPropertyEntityMap } = require('./entityMap');
const { makeSnapshotCache } = require('./snapshotCache');

// The lines whose bills name a service period or an invoice number. Utilities
// are where the habit was found; repairs and turnover bills carry invoice numbers.
const LINE_KEYS = ['heatingGas', 'electric', 'waterSewer', 'repairsMaint', 'turnover'];
const WINDOW_MONTHS = 6;

// "01/05/26" and "1/5/2026" are the same day.
function normDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const yy = m[3].length === 4 ? m[3].slice(2) : m[3];
  return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${yy}`;
}

// The service period anywhere in the description, not only at the end:
// "PSE&G : 7379602209 -04/01/26 - 05/01/26".
const PERIOD_ANY = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/;
function periodOf(p) {
  const m = PERIOD_ANY.exec(String(p.description || ''));
  if (!m) return null;
  const a = normDate(m[1]), b = normDate(m[2]);
  return a && b ? `${a}-${b}` : null;
}

// The utility account number ahead of the period — "7379602209", or "73 771 969
// 04" as some bills key it. A building can carry two meters on the same GL account
// and the same dates (67th St has 7379602209 and 7858776703), and those are two
// bills, not one bill twice.
function utilityAccountOf(p) {
  const d = String(p.description || '');
  const m = PERIOD_ANY.exec(d);
  const head = (m ? d.slice(0, m.index) : d).split(':').pop();
  const digits = head.replace(/[\s-]/g, '');
  return /^\d{6,}$/.test(digits) ? digits : '';
}

function matchKeys(p) {
  const keys = [];
  const per = periodOf(p);
  if (per) keys.push(`per|${p.property}|${p.accountId}|${utilityAccountOf(p)}|${per}`);
  if (p.invoiceNo) keys.push(`inv|${p.property}|${p.vendorId}|${String(p.invoiceNo).toUpperCase()}`);
  return keys;
}

const round2 = v => Math.round(v * 100) / 100;

// Pure: postings in, findings out. One finding per (check, bill) pair, with every
// line of that check that repeats a line of that bill.
function findDuplicates(postings, { propertyIdByShort = new Map() } = {}) {
  const bills = new Map(); // key -> [bill posting]
  const billNet = new Map(); // key -> what the bills for that service net to
  for (const p of postings) {
    if (p.txnType !== 'BILLITM' && p.txnType !== 'CRDITM') continue;
    for (const k of matchKeys(p)) {
      billNet.set(k, (billNet.get(k) || 0) + (p.amount || 0));
      if (p.txnType !== 'BILLITM' || !(p.amount > 0)) continue;
      if (!bills.has(k)) bills.set(k, []);
      bills.get(k).push(p);
    }
  }
  // A bill reversed by a bill credit for the same service no longer charges it,
  // so a check for that service is the only charge, not a second one.
  for (const [k, net] of billNet) if (net < 0.01) bills.delete(k);
  const byPair = new Map();
  for (const c of postings) {
    if (c.txnType !== 'CHKITM' || !(c.amount > 0)) continue;
    const hits = new Map();
    for (const k of matchKeys(c)) for (const b of bills.get(k) || []) hits.set(b.txnId, b);
    for (const b of hits.values()) {
      const pair = `${c.txnId}|${b.txnId}`;
      if (!byPair.has(pair)) byPair.set(pair, { check: c, bill: b, lines: [] });
      byPair.get(pair).lines.push({
        account: c.account, accountId: c.accountId, description: c.description,
        servicePeriod: periodOf(c), checkAmount: round2(c.amount), billAmount: round2(b.amount),
      });
    }
  }

  const credits = postings.filter(p => (p.txnType === 'CREDIT' || p.txnType === 'CRDITM') && p.amount < 0);
  const out = [];
  for (const { check, bill, lines } of byPair.values()) {
    const dupAmount = round2(lines.reduce((s, l) => s + Math.min(l.checkAmount, l.billAmount), 0));
    const near = credits.filter(cr => cr.property === check.property && cr.vendorId === check.vendorId
      && Math.abs(Date.parse(cr.date) - Date.parse(check.date)) <= 31 * 86400000);
    out.push({
      id: `${check.txnId}-${bill.txnId}`,
      property: check.property,
      propertyId: propertyIdByShort.get(String(check.property || '').trim().toUpperCase()) ?? null,
      vendor: check.vendor,
      check: { id: check.txnId, date: check.date, reference: check.reference },
      bill: { id: bill.txnId, date: bill.date, reference: bill.reference },
      lines,
      duplicateAmount: dupAmount,
      // A cent is rounding (410 Alder Street: 348.06 vs 348.05); a dollar is a typo.
      amountsDiffer: lines.some(l => Math.abs(l.checkAmount - l.billAmount) >= 1),
      credits: [...new Map(near.map(cr => [cr.txnId, cr])).values()].map(cr => ({
        id: cr.txnId, date: cr.date, amount: round2(cr.amount), account: cr.account,
      })),
    });
  }
  // A check that repeats several bills (67th St: four) is one problem — keep the
  // pairs, but sort so a check's pairs sit together, biggest check first.
  const perCheck = new Map();
  out.forEach(f => perCheck.set(f.check.id, (perCheck.get(f.check.id) || 0) + f.duplicateAmount));
  out.sort((a, b) => (perCheck.get(b.check.id) - perCheck.get(a.check.id)) || a.check.id.localeCompare(b.check.id) || a.bill.date.localeCompare(b.bill.date));
  return out;
}

function windowDates(now = new Date(), months = WINDOW_MONTHS) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

async function build() {
  const rentManager = require('./rentManagerClient');
  const { byId } = await buildPropertyEntityMap(rentManager);
  const propertyIdByShort = new Map();
  for (const [id, m] of byId) if (m.shortName) propertyIdByShort.set(String(m.shortName).trim().toUpperCase(), id);
  const members = (propertyFinancials.loadSnapshot() || {}).categoryMembers || {};
  const refs = [...new Set(LINE_KEYS.flatMap(k => (propertyFinancials.CATEGORY_REFS[k] || [])
    .flatMap(r => [String(r), ...(members[r] || []).map(String)])))];
  const { startDate, endDate } = windowDates();
  const payload = await glTransactions.getGLDetail({ propOwnerIds: [...byId.keys()].join(','), refs, startDate, endDate });
  const findings = findDuplicates(payload.postings || [], { propertyIdByShort });
  return { startDate, endDate, scanned: (payload.postings || []).length, lines: LINE_KEYS, findings };
}

const cache = makeSnapshotCache({ name: 'duplicate payments', file: 'duplicate-payments-cache.json', build: () => build() });

module.exports = {
  LINE_KEYS, findDuplicates, periodOf, utilityAccountOf, windowDates, build,
  refresh: cache.refresh, status: cache.status, getFresh: cache.getFresh,
};
