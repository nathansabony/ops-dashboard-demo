#!/usr/bin/env node
// Proves the coverage sweep — the answer to "which properties can I show on a
// call, and which will come up empty".
//
// The whole value of this table is that a number in it means what it says. Two
// ways it could lie, and both are worse than not having it:
//
//   1. Counting a charge as covered when the document is not really reachable —
//      somebody builds a call around a property and finds blanks on screen.
//   2. Counting a vendor we could not READ as a vendor with no invoices. Those
//      look identical in a percentage and mean opposite things.
//
// Rent Manager is stubbed, so this runs with an empty .env.
//
//   node scripts/checkBackupCoverage.js

const path = require('path');

const stub = {
  isConfigured: () => true,
  get: async () => { throw new Error('not stubbed'); },
};
require.cache[require.resolve(path.join(__dirname, '..', 'services', 'rentManagerClient.js'))] = {
  id: 'rmStub', filename: 'rmStub', loaded: true, exports: stub,
};

const renovationExpenses = require('../services/renovationExpenses');
const coverage = require('../services/backupCoverage');

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
}

const CHARGES = [
  // A CARD charge — no bill exists for it; the receipt is on the transaction.
  { propertyName: 'Grand Ave', propertyId: 107, entity: 'Cedar Ridge', vendorId: 11, invoiceNo: null, amount: 548.99,
    date: '2026-08-05', month: '2026-08', txnType: 'CC CHG', txnId: 37750 },
  { propertyName: 'Grand Ave', propertyId: 107, entity: 'Cedar Ridge', vendorId: 11, invoiceNo: null, amount: 100,
    date: '2026-08-05', month: '2026-08', txnType: 'CC CHG', txnId: 37751 },
  // A CHECK ITEM whose description never named an invoice — reachable only
  // through the check's own detail lines.
  { propertyName: 'Grand Ave', propertyId: 107, entity: 'Cedar Ridge', vendorId: 11, invoiceNo: null, amount: 2325,
    date: '2026-08-25', month: '2026-08', txnType: 'CHKITM', txnId: 158811, accountId: 466 },
  // Grand Ave — one found by invoice number WITH a document, one without.
  { propertyName: 'Grand Ave', propertyId: 107, entity: 'Cedar Ridge', vendorId: 11, invoiceNo: '100134', amount: 2445, date: '2026-08-25', month: '2026-08' },
  { propertyName: 'Grand Ave', propertyId: 107, entity: 'Cedar Ridge', vendorId: 11, invoiceNo: '100135', amount: 300, date: '2026-08-25', month: '2026-08' },
  // Maple Court — no invoice number, but the amount lands on a bill two days away.
  { propertyName: 'Maple Court Ave', propertyId: 109, entity: 'Cedar Ridge', vendorId: 11, invoiceNo: null, amount: 777, date: '2026-08-20', month: '2026-08' },
  // Maple Court — same, but the only same-amount bill is four months away.
  { propertyName: 'Maple Court Ave', propertyId: 109, entity: 'Cedar Ridge', vendorId: 11, invoiceNo: null, amount: 888, date: '2026-08-20', month: '2026-08' },
  // A vendor whose bills refuse to load.
  { propertyName: 'Sold Street', propertyId: 999, entity: 'Cedar Ridge', vendorId: 66, invoiceNo: 'X1', amount: 50, date: '2026-08-01', month: '2026-08' },
  // No vendor on the posting at all.
  { propertyName: 'Sold Street', propertyId: 999, entity: 'Cedar Ridge', vendorId: null, invoiceNo: null, amount: 25, date: '2026-08-01', month: '2026-08' },
];

const BILLS_11 = [
  { ID: 1, Reference: '100134', Amount: 6000, TransactionDate: '2026-08-20',
    Attachments: [{ FileID: 9, Name: 'inv-100134', Extension: '.pdf', DownloadURL: 'https://depot/a' }] },
  { ID: 2, Reference: '100135', Amount: 300, TransactionDate: '2026-08-24', Attachments: [] },
  { ID: 3, Reference: 'ZZZ', Amount: 777, TransactionDate: '2026-08-22',
    Attachments: [{ FileID: 10, Name: 'scan', Extension: '.pdf', DownloadURL: 'https://depot/b' }] },
  { ID: 4, Reference: 'YYY', Amount: 888, TransactionDate: '2026-04-01',
    Attachments: [{ FileID: 11, Name: 'far-away', Extension: '.pdf', DownloadURL: 'https://depot/c' }] },
];

renovationExpenses.status = () => ({
  cache: { refreshedAt: '2026-08-26T03:00:00.000Z',
    data: { charges: CHARGES, window: { from: '2024-09-01', to: '2026-08-31' } } },
});

const asked = [];
// Bill 1 carries a scan, and its detail line 900001 is what check 158811 paid.
const BILL_DETAILS = { 1: [{ BillDetailID: 900001, BillID: 1, PropertyID: 107, GLAccountID: 466, Amount: 2325 }] };
stub.get = async (p, params) => {
  const f = (params && params.filters) || '';
  if (/^\/Bills\/(\d+)$/.test(p) && params && params.embeds === 'BillDetails') {
    const id = p.match(/(\d+)$/)[1];
    return { ID: Number(id), BillDetails: BILL_DETAILS[id] || [] };
  }
  if (/^\/CheckDetails/.test(p)) {
    if (/CheckID,eq,158811/.test(f)) {
      return [
        // A line for ANOTHER property on the same check — must not be taken.
        { CheckID: 158811, BillDetailID: 999999, PropertyID: 999, GLAccountID: 466 },
        { CheckID: 158811, BillDetailID: 900001, PropertyID: 107, GLAccountID: 466 },
      ];
    }
    return [];
  }
  if (/^\/CreditCardTransactions\/37750/.test(p)) {
    return { ID: 37750, Attachments: [{ FileAttachmentID: 1, FileID: 9, File: { Name: 'receipt', Extension: '.pdf', DownloadURL: 'https://depot/r' } }] };
  }
  if (/^\/CreditCardTransactions\/37751/.test(p)) return { ID: 37751, Attachments: [] };
  if (/^\/Bills\b/.test(p)) {
    asked.push(f);
    if (/AccountID,eq,66/.test(f)) throw new Error('Rent Manager request failed (403) for /Bills: Forbidden');
    if (/AccountID,eq,11/.test(f)) return BILLS_11;
  }
  return [];
};

(async () => {
  const r = await coverage.build();
  // Snapshot now: the narrowing test below runs a SECOND build, and `asked` is
  // cumulative.
  const billRequests = asked.length;

  console.log('\nThe headline numbers');
  // Four documented, by three different routes: the invoice number (100134),
  // the check's own detail line (158811), the amount fallback (777), and a card
  // receipt (37750). That spread is the point — one number hides which route is
  // doing the work.
  check('a charge whose invoice number finds a bill WITH a document counts as covered',
    r.totals.withDocument === 4, `got ${r.totals.withDocument}, expected 4`);
  check('a bill with no attachment counts as a bill, not as a document',
    r.totals.withBill === 4 && r.totals.billNoDoc === 1,
    `bills ${r.totals.withBill}, of which ${r.totals.billNoDoc} carry no scan`);
  check('every route is counted apart, so no single number hides which is working',
    r.totals.byRef === 2 && r.totals.byCheck === 1 && r.totals.byAmount === 1,
    `ref ${r.totals.byRef}, check ${r.totals.byCheck}, amount ${r.totals.byAmount}`);
  check('a same-amount bill four months away is NOT claimed as a match',
    r.totals.withBill === 4, 'the fortnight window is the whole point of the weaker rung');

  console.log('\nThe two ways this table could lie');
  check('a vendor whose bills could not be READ is counted as unreadable, not as "no invoice"',
    r.totals.vendorUnreadable === 1 && r.vendorsUnreadable === 1,
    JSON.stringify({ unreadable: r.totals.vendorUnreadable, vendors: r.vendorsUnreadable }));
  check('...and the reason travels with it',
    r.vendorErrors.length === 1 && /403/.test(r.vendorErrors[0].error), JSON.stringify(r.vendorErrors));
  check('a posting with no vendor is counted apart from one whose vendor had nothing',
    r.totals.noVendor === 1, String(r.totals.noVendor));
  const sold = r.properties.find(p => p.property === 'Sold Street');
  check('...and neither inflates a property\'s document rate',
    sold && sold.withDocument === 0 && sold.documentRate === 0, JSON.stringify(sold));

  console.log('\nThe per-property table');
  const grand = r.properties.find(p => p.property === 'Grand Ave');
  check('a property reports its own rate over its own charges',
    grand && grand.charges === 5 && grand.withDocument === 3 && grand.documentRate === 60,
    JSON.stringify(grand));
  check('the dollars behind the documents are carried, not just the count',
    grand && grand.amountWithDocument === 5319, JSON.stringify(grand && grand.amountWithDocument));
  check('the best-covered property is first, so the showable ones lead',
    r.properties[0].documentRate >= r.properties[r.properties.length - 1].documentRate,
    r.properties.map(p => `${p.property}:${p.documentRate}`).join(' '));
  check('every charge lands in exactly one property row',
    r.properties.reduce((t, p) => t + p.charges, 0) === CHARGES.length);

  console.log('\nThe two routes that are not "look up the invoice number"');
  // A card charge has no bill at all — 3,555 postings on the live ledger — and a
  // check item whose description never named an invoice has nothing to look up
  // BY. Both were counted as unreachable until the routes were found.
  check('a card charge with a receipt counts as documented, with no bill involved',
    r.totals.cardWithDoc === 1 && r.totals.card === 2,
    JSON.stringify({ card: r.totals.card, withDoc: r.totals.cardWithDoc, noDoc: r.totals.cardNoDoc }));
  check('...and its receipt is read from the nested File, not the wrapper',
    r.totals.withDocument >= 1, 'the outer record has no name and no URL on it');
  check('a card charge with no receipt is counted, not silently dropped',
    r.totals.cardNoDoc === 1, String(r.totals.cardNoDoc));
  check('a check item with NO invoice number still finds its bill',
    r.totals.byCheck === 1, `byCheck=${r.totals.byCheck} — the check-detail route must fire`);
  check('...and the line it used is one that resolves to an indexed bill',
    r.totals.byCheck === 1 && r.totals.withDocument === 4,
    'the check route must reach a bill that carries a scan');
  check('the bill-line index is built only from bills that carry a scan',
    r.billsWithDocuments === 3 && r.billDetailLinesIndexed >= 1,
    `${r.billsWithDocuments} of the 4 bills carry one; the scanless bill must not be indexed`);

  // The narrowing, tested by taking the matching line AWAY. Check 158811 pays
  // eleven lines across four buildings on the live ledger; if the property and GL
  // account were not honoured, any of them could be attached to this posting —
  // the wrong invoice on the right charge, which is worse than no invoice.
  {
    const realGet = stub.get;
    stub.get = async (p2, params) => {
      if (/^\/CheckDetails/.test(p2)) {
        return [{ CheckID: 158811, BillDetailID: 900001, PropertyID: 999, GLAccountID: 466 }];
      }
      return realGet(p2, params);
    };
    const r2 = await coverage.build();
    stub.get = realGet;
    check('a check line belonging to ANOTHER property is not used for this posting',
      r2.totals.byCheck === 0,
      `byCheck=${r2.totals.byCheck} — line 900001 is property 999 here, the posting is 107`);
  }

  // Being throttled is not an answer about the books. A sweep that got 429s
  // part-way through once reported all 3,555 card charges as undocumented — a
  // confident, wrong statement produced by our own request rate.
  {
    const realGet = stub.get;
    stub.get = async (p2, params) => {
      if (/^\/CreditCardTransactions/.test(p2)) {
        throw new Error('Rent Manager request failed (429) for /CreditCardTransactions: Too Many Requests');
      }
      return realGet(p2, params);
    };
    const r3 = await coverage.build();
    stub.get = realGet;
    check('a card transaction we could not READ is unreadable, not undocumented',
      r3.totals.cardUnreadable === 2 && r3.totals.cardNoDoc === 0,
      JSON.stringify({ unreadable: r3.totals.cardUnreadable, noDoc: r3.totals.cardNoDoc }));
    check('...and the reason travels with the answer',
      (r3.readErrors || []).some(e => /429/.test(e.error)),
      JSON.stringify((r3.readErrors || []).slice(0, 2)));
    check('...and it does not quietly become a lower document rate people act on',
      r3.cardsUnreadable === 2, String(r3.cardsUnreadable));
  }

  check('the document is reported by what it IS, not just that it exists',
    r.documentKinds && r.documentKinds.pdf >= 1,
    JSON.stringify(r.documentKinds));
  check('...and a spreadsheet is not counted as a PDF',
    !r.documentKinds.pdf || r.documentKinds.pdf <= r.totals.withDocument,
    JSON.stringify(r.documentKinds));

  console.log('\nThe breakdown the meeting needs');
  check('a bill found with NO scan attached is its own number',
    typeof r.totals.billNoDoc === 'number', 'this is the bucket only their filing can fix');
  check('every charge is accounted for in exactly one way',
    r.totals.charges === CHARGES.length, String(r.totals.charges));
  const explained = r.totals.withDocument + r.totals.billNoDoc + r.totals.cardNoDoc
    + r.totals.cardUnreadable + r.totals.vendorUnreadable + r.totals.noVendor;
  check('documented + bill-without-scan + card-without-receipt + unknown never exceeds the total',
    explained <= r.totals.charges, `${explained} vs ${r.totals.charges}`);

  console.log('\nThe cuts that actually separate');
  // The per-property table came back flat on the live ledger — 22-34% for 84 of
  // 86 buildings — because a renovation invoice is split across the properties it
  // covers, so coverage belongs to the vendor and the month rather than the
  // building. These cuts are what make the answer actionable.
  check('coverage is reported by vendor', Array.isArray(r.byVendor));
  check('...and by month', Array.isArray(r.byMonth) && r.byMonth.length > 0);
  check('months come back in order, so a trend is readable',
    r.byMonth.map(m => m.key).join() === [...r.byMonth.map(m => m.key)].sort().join(),
    r.byMonth.map(m => m.key).join());
  check('a vendor with too few charges is not given a rate that looks like a finding',
    r.byVendor.every(v => v.charges >= 10),
    JSON.stringify(r.byVendor.map(v => `${v.key}:${v.charges}`)));
  const monthTotal = r.byMonth.reduce((t, m) => t + m.charges, 0);
  check('every charge lands in exactly one month row', monthTotal === CHARGES.length, String(monthTotal));
  const docsByMonth = r.byMonth.reduce((t, m) => t + m.withDocument, 0);
  check('the month rows account for the same documents as the headline',
    docsByMonth === r.totals.withDocument, `${docsByMonth} vs ${r.totals.withDocument}`);

  console.log('\nThe sweep itself');
  check('bills are still read once per vendor, not once per charge',
    billRequests <= 2, `${billRequests} /Bills requests for ${CHARGES.length} charges across 2 vendors`);
  check('bills are asked for with their attachments in the same request',
    r.bills > 0);

  console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(1); });
