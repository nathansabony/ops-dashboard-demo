#!/usr/bin/env node
// Offline check for the invoice lookup behind a charge (services/rmDocuments.js).
//
// The renovation tab's backup drill-down kept answering "No AP bill match" on
// charges whose invoice was sitting in Rent Manager the whole time. Two reasons,
// both fixed 2026-08-25 and both pinned here:
//
//   1. A GL posting is ONE LINE of a bill. A contractor's invoice covering three
//      units, or one carrying labour and materials separately, posts several GL
//      lines and its TOTAL matches none of them — so matching only on the bill
//      total misses every split invoice, which on a renovation ledger is most of
//      the interesting ones.
//   2. "The API refused the request" and "this posting has no invoice" returned
//      the same empty answer, so a permissions problem read as a missing document
//      for weeks. The one worth emailing Rent Manager about was the invisible one.
//
// Rent Manager is stubbed, so this runs with an empty .env. It proves the MATCHING
// — not the shape RM actually returns, which needs credentials and is what
// scripts/probeRenovationApi.js is for.
//
//   node scripts/checkBillMatch.js

const path = require('path');

// ── stub Rent Manager before rmDocuments requires it ────────────────────────
const stub = {
  isConfigured: () => true,
  get: async () => { throw new Error('not stubbed'); },
};
require.cache[require.resolve(path.join(__dirname, '..', 'services', 'rentManagerClient.js'))] = {
  id: 'rmStub', filename: 'rmStub', loaded: true, exports: stub,
};
const docs = require('../services/rmDocuments');

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
}
const serveBills = rows => { stub.get = async () => rows; };

// A posting on 6100-1 at property 107, unit 2R. Invented figures.
const CHARGE = {
  id: 'c1', propertyId: 107, accountId: 901, accountRef: '6100-1',
  date: '2026-06-18', amount: 4200, vendor: 'Tiger Building Services', reference: 'INV-8841',
};

(async () => {
  console.log('\nMatching a GL posting to its AP bill');

  // 1. the plain case — a bill for exactly this amount, named vendor
  serveBills([{ BillID: 1, BillDate: '2026-06-18', PropertyID: 107, Amount: 4200, VendorName: 'Tiger Building Services', Reference: 'INV-8841' }]);
  let m = await docs.findBill(CHARGE);
  check('a bill matching amount + date + reference is exact', m && m.row && m.confidence === 'exact', JSON.stringify(m && m.confidence));

  // 2. amount and date only — right money, nothing that names it
  serveBills([{ BillID: 2, BillDate: '2026-06-17', PropertyID: 107, Amount: 4200, VendorName: 'Someone Else', Reference: 'X-1' }]);
  m = await docs.findBill(CHARGE);
  check('a bill matching amount + date alone is amount+date', m && m.confidence === 'amount+date', JSON.stringify(m && m.confidence));

  // 3. THE SPLIT INVOICE — the case that used to come back empty. One $11,000
  //    invoice, three GL lines, and the posting is the $4,200 one.
  serveBills([{
    BillID: 3, BillDate: '2026-06-16', PropertyID: 107, Amount: 11000,
    VendorName: 'Tiger Building Services', Reference: 'INV-8841',
    BillDetails: [
      { GLAccountID: 901, PropertyID: 107, UnitName: '2R', Amount: 4200, Description: 'Kitchen — unit 2R' },
      { GLAccountID: 902, PropertyID: 107, UnitName: '3B', Amount: 5300, Description: 'Bath — unit 3B' },
      { GLAccountID: 901, PropertyID: 107, UnitName: '1A', Amount: 1500, Description: 'Kitchen — unit 1A' },
    ],
  }]);
  m = await docs.findBill(CHARGE);
  check('a posting that is ONE LINE of a split invoice now finds its bill',
    m && m.row && m.confidence === 'bill-line', JSON.stringify(m && m.confidence));
  check('...and the matched line is carried back, so the tab can say which line it is',
    m && m.line && Math.abs(m.line.Amount - CHARGE.amount) < 0.01 && m.line.UnitName === '2R',
    JSON.stringify(m && m.line));

  // 4. a line on the WRONG GL account is not a match, however right the amount is
  serveBills([{
    BillID: 4, BillDate: '2026-06-16', PropertyID: 107, Amount: 9000, VendorName: 'Tiger Building Services',
    BillDetails: [{ GLAccountID: 902, PropertyID: 107, Amount: 4200, Description: 'Bath' }],
  }]);
  m = await docs.findBill(CHARGE);
  check('a same-amount line on a different GL account is NOT matched', !m.row, JSON.stringify(m && m.confidence));

  // 5. a whole-bill match outranks a line match
  serveBills([
    { BillID: 5, BillDate: '2026-06-18', PropertyID: 107, Amount: 4200, VendorName: 'Tiger Building Services', Reference: 'INV-8841' },
    { BillID: 6, BillDate: '2026-06-18', PropertyID: 107, Amount: 9000, BillDetails: [{ GLAccountID: 901, PropertyID: 107, Amount: 4200 }] },
  ]);
  m = await docs.findBill(CHARGE);
  check('a whole-bill match outranks a line match', m.confidence === 'exact' && m.row.BillID === 5, `${m.confidence} bill ${m.row && m.row.BillID}`);

  // 6. two bills, same money, same fortnight → the one nearest the posting date
  serveBills([
    { BillID: 7, BillDate: '2026-06-05', PropertyID: 107, Amount: 4200 },
    { BillID: 8, BillDate: '2026-06-17', PropertyID: 107, Amount: 4200 },
  ]);
  m = await docs.findBill(CHARGE);
  check('two equal candidates → the bill closest to the posting date', m.row.BillID === 8, `bill ${m.row && m.row.BillID}`);

  // 7. a bill for another property is not this charge's bill
  serveBills([{ BillID: 9, BillDate: '2026-06-18', PropertyID: 555, Amount: 4200, VendorName: 'Tiger Building Services' }]);
  m = await docs.findBill(CHARGE);
  check('a bill on another property is not matched', !m.row);

  // 8. the window: an invoice dated two weeks BEFORE the posting is still in range
  //    (AP posts late), one dated two weeks after is not (invoices do not).
  serveBills([{ BillID: 10, BillDate: '2026-06-06', PropertyID: 107, Amount: 4200 }]);
  m = await docs.findBill(CHARGE);
  check('an invoice dated 12 days before the posting is inside the window', !!m.row);
  serveBills([]);
  m = await docs.findBill(CHARGE);
  check('an empty window says so, rather than "no match"',
    !m.row && m.searched && m.searched.rows === 0, JSON.stringify(m));

  // 9. a refused request is reported AS a refusal
  stub.get = async () => { throw new Error('Rent Manager request failed (403): Forbidden'); };
  m = await docs.findBill(CHARGE);
  check('a refused request comes back as an error with its status, not as "no bill"',
    !m.row && m.error && m.error.status === 403, JSON.stringify(m));

  // 10. the attachment route that actually works on this instance, and the two
  //     ways it silently returns nothing.
  //
  //     /Attachments does not exist here — attachments hang off the bill and come
  //     back through an embed. A request for ONE record answers with the record
  //     itself, not {Results:[…]}, so code that only ever reads rows[0] finds an
  //     empty list on the one call that works. That is not a hypothetical: it is
  //     how a live run reported "documents are not exposed" while holding a bill
  //     whose embed had already returned a PDF's DownloadURL.
  const ATTACH = {
    FileID: 1542, Name: 'W.O. Montesdeoca CS CA - MO', Extension: '.pdf',
    Path: '201801\\W.O. Montesdeoca CS CA - MO.pdf', Token: 'zzz',
    DownloadURL: 'https://rm12filereader.rentmanager.com/files/get/?EID=x&FKey=y',
  };
  stub.get = async (p2, params) => {
    if (/^\/Attachments|^\/Files|^\/Documents|^\/Images/.test(p2)) throw new Error('Rent Manager request failed (404): No HTTP resource was found');
    if (/^\/Bills\/\d+/.test(p2) && params && params.embeds === 'Attachments') return { ID: 2, Attachments: [ATTACH] };
    throw new Error('Rent Manager request failed (404): No HTTP resource was found');
  };
  docs.__resetShapeCache && docs.__resetShapeCache();
  let att = await docs.attachmentsFor('Bill', 2);
  check('a bill embed returning ONE RECORD (not a Results array) still yields its attachments',
    att.list.length === 1, JSON.stringify(att));
  check('...the DownloadURL RM handed back is kept — it is the only thing that serves bytes',
    att.list[0] && att.list[0].url === ATTACH.DownloadURL, JSON.stringify(att.list[0]));
  check('...and the extension is put back on the name, which RM stores apart from it',
    att.list[0] && att.list[0].name === 'W.O. Montesdeoca CS CA - MO.pdf', att.list[0] && att.list[0].name);

  // A bill with no scan must not be mistaken for a route that does not work.
  stub.get = async (p2, params) => {
    if (/^\/Bills\/\d+/.test(p2) && params && params.embeds === 'Attachments') return { ID: 3, Attachments: [] };
    throw new Error('Rent Manager request failed (404): No HTTP resource was found');
  };
  docs.__resetShapeCache && docs.__resetShapeCache();
  att = await docs.attachmentsFor('Bill', 3);
  check('a bill with no attachment is an empty list, not a failure', att.tried && att.list.length === 0, JSON.stringify(att));

  // 11. the route this portfolio actually needs: vendor + invoice number.
  //
  //     Renovation postings here are CHECK ITEMS, not bills, so no bill carries
  //     the posting's reference or its amount — which is why a fortnight of 200
  //     bills matched nothing. What the GL row does carry is the vendor
  //     (CustomerID) and, written into the description, the vendor's invoice
  //     number: "Tubs Refinishing Services Inc.: 100134" is bill Reference 100134.
  const CHKITM = {
    id: 'c-chk', date: '2026-08-25', amount: 2445, propertyId: 184,
    reference: 'AV5475',                       // the Avid voucher, not a bill ref
    vendor: 'Tubs Refinishing Services Inc.',
    vendorId: 11501, invoiceNo: '100134', txnType: 'CHKITM',
  };
  const INVOICE = {
    ID: 257900, AccountID: 11501, Reference: '100134', Amount: 6000,
    TransactionDate: '2026-08-20',
    Attachments: [{ FileID: 9, Name: 'inv-100134', Extension: '.pdf', DownloadURL: 'https://depot/x' }],
  };
  let asked = [];
  stub.get = async (p2, params) => {
    if (/^\/Bills\b/.test(p2) && params && params.filters) {
      asked.push(params.filters);
      if (/AccountID,eq,11501/.test(params.filters) && /Reference,eq,100134/.test(params.filters)) return [INVOICE];
      return [];
    }
    if (/^\/Bills\/257900/.test(p2)) return INVOICE;
    throw new Error('Rent Manager request failed (404): No HTTP resource was found');
  };
  docs.__resetShapeCache();
  m = await docs.findBill(CHKITM);
  check('a check item finds its invoice by vendor + invoice number',
    m.row && m.row.ID === 257900, JSON.stringify({ asked, got: m.row && m.row.ID }));
  check('...and that is an exact match even though the totals differ (2445 vs 6000)',
    m.confidence === 'exact', `${m.confidence} — a split invoice must not be downgraded`);
  check('...and the invoice rides along with it',
    m.row && Array.isArray(m.row.Attachments) && m.row.Attachments[0].DownloadURL === 'https://depot/x');
  check('...and the vendor filter is asked before the fortnight-wide window',
    /AccountID,eq,11501/.test(asked[0] || ''), asked[0]);

  // A bill whose reference matches but whose VENDOR does not is a different
  // vendor's invoice that happens to share a number. Never that one.
  asked = [];
  stub.get = async (p2, params) => {
    if (/^\/Bills\b/.test(p2) && params && params.filters) {
      if (/Reference,eq,100134/.test(params.filters)) return [{ ...INVOICE, ID: 999, AccountID: 77777 }];
      return [];
    }
    throw new Error('Rent Manager request failed (404): No HTTP resource was found');
  };
  docs.__resetShapeCache();
  m = await docs.findBill(CHKITM);
  check('a matching reference on ANOTHER vendor is not accepted',
    !m.row || m.row.ID !== 999, JSON.stringify(m.row && { id: m.row.ID, acct: m.row.AccountID }));

  // 12. the worksheet cross-check on a SPLIT invoice — the real shape of
  //     FY Construction's MAJOR/Demo Portfolio/37Du, found on the tab 2026-08-26.
  //
  //     One $20,000 bill, ten lines, all on GL 5156, one per property. Filtering
  //     on the GL account alone summed all ten and compared $20,000 against a
  //     single $1,900 posting: an $18,100 "difference" on a charge that ties to
  //     the cent, shown in red, on exactly the charges where the invoice had just
  //     been found. It fired on every split invoice, which here is most of them.
  const SPLIT_BILL = {
    ID: 1, Reference: 'MAJOR/Demo Portfolio/37Du', Amount: 20000,
    BillDetails: [
      { GLAccountID: 466, PropertyID: 112, Amount: 1900 },
      { GLAccountID: 466, PropertyID: 115, Amount: 2100 },
      { GLAccountID: 466, PropertyID: 116, Amount: 2300 },
      { GLAccountID: 466, PropertyID: 148, Amount: 2000 },
      { GLAccountID: 466, PropertyID: 151, Amount: 1800 },
      { GLAccountID: 466, PropertyID: 158, Amount: 2200 },
      { GLAccountID: 466, PropertyID: 30, Amount: 1700 },
      { GLAccountID: 466, PropertyID: 209, Amount: 1900 },
      { GLAccountID: 466, PropertyID: 217, Amount: 2100 },
      { GLAccountID: 466, PropertyID: 141, Amount: 2000 },
    ],
  };
  let w = docs.worksheetCheck(SPLIT_BILL, { accountId: 466, propertyId: 112, amount: 1900, unitName: '22' });
  check('a split invoice ties against THIS property\'s line, not the whole bill',
    w.agrees === true && w.worksheetAmount === 1900 && w.diff === 0,
    `worksheet ${w.worksheetAmount} vs gl ${w.glAmount}, diff ${w.diff}`);
  check('...and it says the invoice is split rather than hiding it',
    w.splitAcrossProperties === true && w.invoiceAmountOnAccount === 20000 && w.linesOnAccount === 10,
    JSON.stringify({ split: w.splitAcrossProperties, onAccount: w.invoiceAmountOnAccount }));
  check('...and another property on the same invoice ties to ITS line',
    docs.worksheetCheck(SPLIT_BILL, { accountId: 466, propertyId: 116, amount: 2300 }).agrees === true);
  check('...and a posting that genuinely disagrees is still caught',
    docs.worksheetCheck(SPLIT_BILL, { accountId: 466, propertyId: 112, amount: 2500 }).agrees === false);

  // Worksheets that name no property must not become a $0 worksheet.
  const NO_PROP = { ID: 2, BillDetails: [{ GLAccountID: 466, Amount: 1900 }] };
  w = docs.worksheetCheck(NO_PROP, { accountId: 466, propertyId: 112, amount: 1900 });
  check('a worksheet line with no property is still counted, not filtered away',
    w.agrees === true && w.matchedLines === 1, JSON.stringify(w));

  // Narrowing to the unit must not empty the set when no line names a unit.
  const UNITED = { ID: 3, BillDetails: [
    { GLAccountID: 466, PropertyID: 112, UnitName: '22', Amount: 1200 },
    { GLAccountID: 466, PropertyID: 112, UnitName: '23', Amount: 700 },
  ] };
  check('when lines DO name units, the charge ties against its own unit',
    docs.worksheetCheck(UNITED, { accountId: 466, propertyId: 112, amount: 1200, unitName: '22' }).agrees === true);
  check('...and a charge whose unit names no line falls back to the property total',
    docs.worksheetCheck(UNITED, { accountId: 466, propertyId: 112, amount: 1900, unitName: '99' }).agrees === true);

  // 13. the check-line route — the one that reaches a posting whose description
  //     never named an invoice number (about 11,000 of them).
  const CHK_NO_INV = {
    id: 'c-noinv', date: '2026-08-25', amount: 2325, propertyId: 184, accountId: 466,
    reference: 'AV945', vendor: 'Tubs Refinishing Services Inc.',
    vendorId: 11501, invoiceNo: null, txnType: 'CHKITM', txnId: 158811,
  };
  const RIGHT = { ID: 500, AccountID: 11501, Reference: 'whatever the AP clerk typed', Amount: 9000,
    TransactionDate: '2026-08-20',
    BillDetails: [{ BillDetailID: 900001, BillID: 500, PropertyID: 184, GLAccountID: 466, Amount: 2325 }],
    Attachments: [{ FileID: 3, Name: 'inv', Extension: '.pdf', DownloadURL: 'https://depot/z' }] };
  const WRONG = { ID: 501, AccountID: 11501, Reference: 'another job', Amount: 2325,
    TransactionDate: '2026-08-25',
    BillDetails: [{ BillDetailID: 777777, BillID: 501, PropertyID: 999, GLAccountID: 466, Amount: 2325 }],
    Attachments: [] };
  stub.get = async (p2, params) => {
    const f = (params && params.filters) || '';
    if (/^\/CheckDetails/.test(p2)) {
      if (/CheckID,eq,158811/.test(f)) return [
        { CheckID: 158811, BillDetailID: 777777, PropertyID: 999, GLAccountID: 466 },
        { CheckID: 158811, BillDetailID: 900001, PropertyID: 184, GLAccountID: 466 },
      ];
      return [];
    }
    if (/^\/Bills\/500/.test(p2)) return RIGHT;
    if (/^\/Bills\/501/.test(p2)) return WRONG;
    if (/^\/Bills\b/.test(p2) && f) return [WRONG, RIGHT];
    throw new Error('Rent Manager request failed (404): No HTTP resource was found');
  };
  docs.__resetShapeCache();
  m = await docs.findBill(CHK_NO_INV);
  check('a posting with no invoice number finds its bill through the check lines',
    m.row && m.row.ID === 500, JSON.stringify(m.row && { id: m.row.ID }));
  check('...and it is the line for THIS property, not the other one on the same check',
    m.row && m.row.ID !== 501, 'bill 501 is property 999 and its amount matches exactly — the trap');
  check('...and that counts as an exact match, since a check line is one slice of an invoice',
    m.confidence === 'exact', String(m.confidence));
  check('...and the invoice comes with it', m.row && m.row.Attachments && m.row.Attachments.length === 1);

  // A check whose lines name a property, none of them ours: not our bill.
  stub.get = async (p2, params) => {
    const f = (params && params.filters) || '';
    if (/^\/CheckDetails/.test(p2)) return [{ CheckID: 158811, BillDetailID: 777777, PropertyID: 999, GLAccountID: 466 }];
    if (/^\/Bills\/501/.test(p2)) return WRONG;
    if (/^\/Bills\b/.test(p2) && f) return [WRONG];
    throw new Error('Rent Manager request failed (404): No HTTP resource was found');
  };
  docs.__resetShapeCache();
  m = await docs.findBill(CHK_NO_INV);
  check('a check that paid only OTHER properties does not hand us their invoice',
    !m.row || m.row.ID !== 501,
    'attaching another building\'s invoice is worse than showing none');

  // ── the money that settled the bill ───────────────────────────────────────
  // This whole side returned null on every bill for weeks. paymentFor asked
  // /Payments and /Checks for `BillID,eq,<id>`; neither resource has that field,
  // so both queries came back empty and "not paid by card" and "we asked the
  // wrong question" were the same answer on screen. The link is on the LINES.
  console.log('\nFinding the check that paid a bill');

  const PAID_BILL = { BillID: 700, Amount: 2500 };
  // The posting the panel is open on. Its line on the bill matches on property,
  // account and amount, which is what makes the applied figure exact.
  const PAID_CHARGE = { propertyId: 107, accountId: 901, amount: 2500 };
  const asCheck = (over = {}) => ({
    ID: 158563, Reference: '1347', TransactionDate: '2026-08-14T00:00:00',
    Payee: 'Optimized Engineering Associates', Amount: 5100, TransactionType: 'Check',
    BankID: 3, ReconcileID: 18911, ...over,
  });
  const servePayment = ({ details, checkDetails, check, banks, glAccounts }) => {
    docs.__resetBankDirectory();
    stub.get = async (p2, params) => {
      const f = (params && params.filters) || '';
      if (/^\/Bills\/700/.test(p2)) return [{ ...PAID_BILL, BillDetails: details }];
      if (/^\/CheckDetails/.test(p2)) {
        const m2 = /BillDetailID,eq,(\d+)/.exec(f);
        return m2 ? (checkDetails[m2[1]] || []) : [];
      }
      if (/^\/Checks\//.test(p2)) return check === null ? [] : [check || asCheck()];
      if (/^\/BankAccounts/.test(p2)) throw new Error('Rent Manager request failed (404)');
      if (/^\/Banks\b/.test(p2)) return banks === null ? [] : (banks || [
        { BankID: 3, Name: 'First Commerce Operating', AccountNumber: '0091234471', AccountType: 'Checking' },
      ]);
      if (/^\/GLAccounts/.test(p2)) return glAccounts === null ? [] : (glAccounts || []);
      if (/^\/CreditCards\b/.test(p2)) return [{ CreditCardID: 9, Name: 'Amex 1005' }];
      if (/^\/CreditCardTransactions/.test(p2)) {
        return [{ ID: 5, CreditCardID: 9, Amount: 5100, TransactionDate: '2026-08-20T00:00:00',
                  Comment: 'AMEX AUG', Reference: 'ST-77', ReconcileID: 44 }];
      }
      throw new Error('Rent Manager request failed (404)');
    };
  };

  servePayment({
    details: [{ BillDetailID: 1065871, PropertyID: 107, GLAccountID: 901, Amount: 2500 }],
    checkDetails: { 1065871: [{ CheckID: 158563, BillDetailID: 1065871, Amount: 2500 }] },
  });
  let pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('a bill names the check that paid it', pay && String(pay.reference) === '1347',
    JSON.stringify(pay));
  check('...with the date and the payee off the check itself',
    pay && pay.paidOn === '2026-08-14' && /Optimized/.test(pay.payee || ''), JSON.stringify(pay));
  check('...and a reconciled check is reported as cleared', pay && pay.reconciled === true);

  // A check pays several bills. Printing its total beside one invoice reads as
  // an overpayment, so the two numbers stay separate.
  check('the check total and this charge\'s share are different numbers',
    pay && pay.amount === 5100 && pay.appliedToChargeLine === 2500,
    JSON.stringify(pay && { amount: pay.amount, applied: pay.appliedToChargeLine }));

  servePayment({
    details: [{ BillDetailID: 1 }, { BillDetailID: 2 }],
    checkDetails: {},
  });
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('a bill no check has settled returns null, not an empty payment', pay === null,
    JSON.stringify(pay));

  servePayment({
    details: [{ BillDetailID: 1065871, PropertyID: 107, GLAccountID: 901, Amount: 2500 }],
    checkDetails: { 1065871: [{ CheckID: 158563, BillDetailID: 1065871, Amount: 2500 }] },
    check: asCheck({ ReconcileID: null }),
  });
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('an unreconciled check is paid but not cleared', pay && pay.reconciled === false);

  // ── the line has to be THIS charge's line ─────────────────────────────────
  // A consolidated vendor bill runs to 78 lines across a dozen buildings. Taking
  // the first few and reporting whichever check paid them answers a question
  // nobody asked: the first live run named a $113.93 check against a $1,215.81
  // bill, because that is what line 1 belonged to.
  const CHG = { propertyId: 107, accountId: 901, unitName: '2R', amount: 250 };
  const bigDetails = [];
  const bigChecks = {};
  for (let i = 1; i <= 40; i++) {
    bigDetails.push({ BillDetailID: i, PropertyID: 500 + i, GLAccountID: 800, Amount: 99 });
    bigChecks[i] = [{ CheckID: 900 + i, BillDetailID: i, Amount: 99 }];
  }
  // ...and somewhere down the list, the charge's own line.
  bigDetails.push({ BillDetailID: 77, PropertyID: 107, GLAccountID: 901, UnitName: '2R', Amount: 250 });
  bigChecks[77] = [{ CheckID: 158563, BillDetailID: 77, Amount: 250 }];
  servePayment({ details: bigDetails, checkDetails: bigChecks });
  pay = await docs.paymentFor(PAID_BILL, CHG);
  check('the charge\'s own line is found even when it is 41st on the bill',
    pay && pay.chargeLine && pay.chargeLine.billDetailId === 77,
    JSON.stringify(pay && pay.chargeLine));
  check('...and the amount applied to it is this charge\'s money',
    pay && pay.appliedToChargeLine === 250, JSON.stringify(pay && pay.appliedToChargeLine));
  check('...found by ranking, not by reading all 41 lines',
    pay && pay.linesExamined <= 4, `examined ${pay && pay.linesExamined}`);
  // Two counts, and conflating them made the panel say "this bill has 1 lines"
  // about a 78-line invoice: one is what survived the this-property filter, the
  // other is the invoice as it actually is.
  check('...and the bill\'s real line count survives the narrowing',
    pay && pay.linesOnBill === 41 && pay.candidateLines === 1,
    JSON.stringify(pay && { on: pay.linesOnBill, candidates: pay.candidateLines }));

  // Another building's line on the same invoice is not our money.
  const otherOnly = [{ BillDetailID: 9, PropertyID: 999, GLAccountID: 901, Amount: 250 }];
  servePayment({ details: otherOnly, checkDetails: { 9: [{ CheckID: 1, BillDetailID: 9, Amount: 250 }] } });
  pay = await docs.paymentFor(PAID_BILL, CHG);
  check('a bill whose only lines belong to another property returns nothing',
    pay === null, JSON.stringify(pay));

  // The line matched on property and account but NOT on amount — it is a line of
  // this bill, not provably this charge's, so the figure is withheld.
  servePayment({
    details: [{ BillDetailID: 5, PropertyID: 107, GLAccountID: 901, Amount: 88 },
              { BillDetailID: 6, PropertyID: 107, GLAccountID: 901, Amount: 77 }],
    checkDetails: { 5: [{ CheckID: 158563, BillDetailID: 5, Amount: 88 }],
                    6: [{ CheckID: 158563, BillDetailID: 6, Amount: 77 }] },
  });
  pay = await docs.paymentFor(PAID_BILL, CHG);
  check('a line that does not match on amount still names the check',
    pay && String(pay.reference) === '1347', JSON.stringify(pay && pay.reference));
  check('...but the share against this charge is withheld rather than guessed',
    pay && pay.appliedToChargeLine === null && pay.chargeLine === null,
    JSON.stringify(pay && { applied: pay.appliedToChargeLine, line: pay.chargeLine }));

  // Every line of a forty-line bill names the same check. Chasing all forty is
  // forty requests for one answer, and a click has to stay quick.
  const many = {};
  const details = [];
  for (let i = 1; i <= 40; i++) { details.push({ BillDetailID: i }); many[i] = [{ CheckID: 158563, BillDetailID: i, Amount: 10 }]; }
  let calls = 0;
  servePayment({ details, checkDetails: many });
  const inner = stub.get;
  stub.get = async (p2, params) => { if (/^\/CheckDetails/.test(p2)) calls++; return inner(p2, params); };
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('a forty-line bill does not make forty lookups to name one check', calls <= 4, `made ${calls}`);

  // The trap this has now fallen into twice. A request for ONE record comes back
  // as the record, not as a list holding it — so a list-shaped reader finds
  // nothing and the feature reports "Rent Manager has nothing". It cost the bill
  // embed once and the bill-to-check link again.
  stub.get = async (p2, params) => {
    const f = (params && params.filters) || '';
    // Bare object, exactly as RM answers /Bills/700.
    if (/^\/Bills\/700/.test(p2)) return { ...PAID_BILL, BillDetails: [{ BillDetailID: 1065871, PropertyID: 107, GLAccountID: 901, Amount: 2500 }] };
    if (/^\/CheckDetails/.test(p2)) return /1065871/.test(f) ? [{ CheckID: 158563, BillDetailID: 1065871, Amount: 2500 }] : [];
    if (/^\/Checks\//.test(p2)) return asCheck();      // also a bare object
    throw new Error('Rent Manager request failed (404)');
  };
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('a single record answered as itself, not as a list, is still read',
    pay && String(pay.reference) === '1347',
    'RM answers /Bills/700 with the bill, not with [the bill]');

  // ── which account the money left from ────────────────────────────────────
  // Sarah, 2026-09-03: the record says a check cleared the bank and does not say
  // WHICH bank, so there is nothing to look the check up with. The check row
  // carries only a BankID, and /BankAccounts is a 404 on this instance — so the
  // directory is looked for under RM's other name before the id is given up on.
  console.log('\nNaming the bank account a check was drawn on');

  const PAID = {
    details: [{ BillDetailID: 1065871, PropertyID: 107, GLAccountID: 901, Amount: 2500 }],
    checkDetails: { 1065871: [{ CheckID: 158563, BillDetailID: 1065871, Amount: 2500 }] },
  };

  servePayment(PAID);
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('the account is resolved from /Banks when /BankAccounts 404s',
    pay && pay.bank && pay.bank.name === 'First Commerce Operating',
    JSON.stringify(pay && pay.bank));
  check('...carrying the LAST FOUR of the account number and nothing more of it',
    pay && pay.bank.last4 === '4471' && !/0091234471/.test(JSON.stringify(pay)),
    JSON.stringify(pay && pay.bank));
  check('...as one line a PDF and a panel can both print',
    pay && pay.bank.label === 'First Commerce Operating ****4471', pay && pay.bank.label);
  check('...and the resolution says which resource answered, so a blank is answerable',
    pay && pay.bankDirectory && pay.bankDirectory.source === '/Banks',
    JSON.stringify(pay && pay.bankDirectory));
  // A check joins on BankID. A directory keyed on a different id space would name
  // the wrong account, which is worse than naming none — so which field it keyed
  // on is reported rather than assumed.
  check('...and which id field it keyed on, because a wrong join names a wrong account',
    pay && pay.bankDirectory.keyedOn === 'BankID', JSON.stringify(pay && pay.bankDirectory.keyedOn));

  // No directory at all: the id is still reported. "BankID 3" is a poor answer
  // and an honest one, and it is the answer that gets the permission asked for.
  servePayment({ ...PAID, banks: null });
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('with no bank directory the id is still named rather than left blank',
    pay && pay.bank.known === false && /BankID 3/.test(pay.bank.label),
    JSON.stringify(pay && pay.bank));

  // The route a resource list cannot find. /Attachments 404s here and invoices
  // are reachable anyway, because they ride on the bill as an embed — so the same
  // question is asked of a check before the directory is given up on.
  docs.__resetBankDirectory();
  {
    const base = stub.get;
    stub.get = async (p2, params) => {
      if (/^\/Checks\/\d+/.test(p2) && params && params.embeds === 'Bank') {
        return { ...asCheck(), Bank: { BankID: 3, Name: 'Willow Creek Operating', AccountNumber: '55559812' } };
      }
      return base(p2, params);
    };
    pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
    check('an account no directory exposes is still reached through the check embed',
      pay && pay.bank.name === 'Willow Creek Operating' && pay.bank.last4 === '9812',
      JSON.stringify(pay && pay.bank));
    check('...and the panel says which route answered, not just what it found',
      pay && /embeds=Bank/.test(pay.bank.via || ''), JSON.stringify(pay && pay.bank.via));
    stub.get = base;
  }

  // An embed nobody supports must not cost a request on every check for the rest
  // of the process.
  docs.__resetBankDirectory();
  {
    let embedCalls = 0;
    const base = stub.get;
    stub.get = async (p2, params) => {
      if (params && params.embeds && /^\/Checks\//.test(p2)) { embedCalls++; throw new Error('Rent Manager request failed (400)'); }
      return base(p2, params);
    };
    await docs.paymentFor(PAID_BILL, PAID_CHARGE);
    const afterFirst = embedCalls;
    await docs.paymentFor(PAID_BILL, PAID_CHARGE);
    check('an unsupported embed is tried once per process, not once per check',
      embedCalls === afterFirst, `${afterFirst} then ${embedCalls}`);
    stub.get = base;
  }
  docs.__resetBankDirectory();

  // ── the route that answers on the live instance ──────────────────────────
  // Measured 2026-09-03 against the deployed app: /BankAccounts and /Banks are
  // both absent, but a bank account here IS a GL account — 87 rows come back
  // GLAccountType "Bank" — and a check's BankID is that GL account's id. Of the
  // 21 distinct BankIDs on 500 real checks, all 13 that fell inside the page read
  // back are Bank-type GL accounts and none is anything else.
  docs.__resetBankDirectory();
  servePayment({ ...PAID, banks: null, glAccounts: [
    { GLAccountID: 3, Reference: '1043', Name: 'Birchwood Commons Reserve LLC - First Commerce Ops', GLAccountType: 'Bank' },
    { GLAccountID: 9, Reference: '5100', Name: 'Repairs & Maintenance', GLAccountType: 'Expense' },
  ] });
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('a bank account reached as a GL account is named, entity and all',
    pay && pay.bank.name === '1043 Birchwood Commons Reserve LLC - First Commerce Ops',
    JSON.stringify(pay && pay.bank));
  check('...which is the half of the ask that matters when RM holds no account number',
    pay && pay.bank.known === true && pay.bank.last4 === null, JSON.stringify(pay && pay.bank));
  check('...joined on the id a check actually carries',
    pay && pay.bankDirectory.keyedOn === 'GLAccountID' && pay.bankDirectory.source === '/GLAccounts',
    JSON.stringify(pay && pay.bankDirectory));

  // An expense account is not a bank account. Naming one on a payment record
  // would put the wrong thing in front of an owner.
  docs.__resetBankDirectory();
  servePayment({ ...PAID, banks: null, glAccounts: [
    { GLAccountID: 3, Reference: '5100', Name: 'Repairs & Maintenance', GLAccountType: 'Expense' },
  ] });
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('a non-bank GL account is never mistaken for the account that paid',
    pay && pay.bank.known === false, JSON.stringify(pay && pay.bank));

  // The accounts a check actually draws on run past the first page — one BankID
  // beyond row 500 paid 124 of 500 sampled checks. A single page would have
  // silently lost it.
  docs.__resetBankDirectory();
  {
    const big = Array.from({ length: 500 }, (_, i) => (
      { GLAccountID: 1000 + i, Reference: String(2000 + i), Name: `Filler ${i}`, GLAccountType: 'Expense' }));
    const page2 = [{ GLAccountID: 3, Reference: '1071', Name: 'Willow Creek MMTK LLC', GLAccountType: 'Bank' }];
    const base = stub.get;
    stub.get = async (p2, params) => {
      if (/^\/GLAccounts/.test(p2)) {
        if (params && params.filters) throw new Error('Rent Manager request failed (400)');
        return (params && params.pagenumber === 2) ? page2 : big;
      }
      if (/^\/Banks\b/.test(p2)) return [];
      return base(p2, params);
    };
    pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
    check('a filter RM refuses falls back to paging rather than losing the directory',
      pay && pay.bank.name === '1071 Willow Creek MMTK LLC', JSON.stringify(pay && pay.bank));
    stub.get = base;
  }

  // A debit-card account is a bank account. Reading it as a credit card sends the
  // panel hunting a statement charge that does not exist — which could not happen
  // before, because this map was always empty.
  docs.__resetBankDirectory();
  servePayment({ ...PAID, banks: null, glAccounts: [
    { GLAccountID: 3, Reference: '1017', Name: 'Demo Portfolio - TD Bank debit card', GLAccountType: 'Bank' },
  ] });
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('a debit-card account is a bank account, not a credit card',
    pay && pay.bank.known === true && pay.paidByCreditCard === false,
    JSON.stringify(pay && { name: pay.bank.name, card: pay.paidByCreditCard }));

  docs.__resetBankDirectory();
  // The common naming convention: the last four are already in the name. Printing
  // them twice ("Operating - 4471 ****4471") reads like two accounts.
  servePayment({ ...PAID, banks: [{ BankID: 3, Name: 'Willow Creek Operating - 4471' }] });
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('a name that already ends in the last four is not stamped with them twice',
    pay && pay.bank.label === 'Willow Creek Operating - 4471' && pay.bank.last4 === '4471',
    JSON.stringify(pay && pay.bank));

  // Digits in the middle of a name are a branch, a year or a property — not an
  // account. Reading them as the last four would send Sarah to the wrong account.
  check('digits in the middle of a name are not read as an account number',
    docs.lastFourFromName('2024 Renovation Escrow account') === null,
    String(docs.lastFourFromName('2024 Renovation Escrow account')));
  check('...and a number too short to be a last four is refused',
    docs.lastFour('12') === null && docs.lastFour('0091234471') === '4471');

  // A check on a card account still has to say which card account.
  servePayment({ ...PAID, banks: [{ BankID: 3, Name: 'Amex Corporate', AccountType: 'Credit Card' }] });
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('a card account is still named, and still recognised as a card',
    pay && pay.bank.name === 'Amex Corporate' && pay.paidByCreditCard === true,
    JSON.stringify(pay && { bank: pay.bank.name, card: pay.paidByCreditCard }));

  // ── the lines that were going missing ────────────────────────────────────
  // Measured on 13 live charges 2026-09-10: every one came back with no
  // BillDetails, and the worksheet cross-check answered "bill worksheet lines not
  // returned by the API" on all of them — while paymentFor, asking for the SAME
  // bill with embeds=BillDetails on its own, got 100 lines back. The lines were
  // always reachable; the combined BillDetails,Attachments embed is what this
  // instance will not serve, and the fallback that saved the attachments dropped
  // the lines without saying so.
  console.log('\nA bill whose lines the combined embed drops');
  {
    const LINES = [
      { BillDetailID: 1065871, PropertyID: 107, GLAccountID: 901, Amount: 2500, Comment: 'Kitchen 2R' },
      { BillDetailID: 1065872, PropertyID: 107, GLAccountID: 902, Amount: 900, Comment: 'Bath 3B' },
    ];
    const HEADER = { BillID: 700, Amount: 3400, BillDate: '2026-06-18', PropertyID: 107,
      VendorName: 'Tiger Building Services', Reference: 'INV-8841',
      Attachments: [{ AttachmentID: 5, Name: 'inv.pdf' }] };
    let narrowCalls = 0;
    stub.get = async (p2, params) => {
      const embeds = String((params && params.embeds) || '');
      // Exactly the live shape: the combined embed drops the lines, the narrow
      // one serves them.
      if (/^\/Bills\/700/.test(p2)) {
        if (/BillDetails/.test(embeds) && !/Attachments/.test(embeds)) {
          narrowCalls++;
          return { ...HEADER, BillDetails: LINES };
        }
        return { ...HEADER };
      }
      if (/^\/Bills\b/.test(p2)) return [{ ...HEADER }];
      if (/^\/CheckDetails/.test(p2)) return [{ CheckID: 158563, BillDetailID: 1065871, Amount: 2500 }];
      if (/^\/Checks\//.test(p2)) return asCheck();
      if (/^\/Banks\b/.test(p2)) return [{ BankID: 3, Name: 'First Commerce Operating' }];
      throw new Error('Rent Manager request failed (404)');
    };
    docs.__resetShapeCache();
    docs.__resetBankDirectory();
    const bk = await docs.backupFor({ id: 'lines-1', propertyId: 107, accountId: 901,
      date: '2026-06-18', amount: 3400, vendor: 'Tiger Building Services', reference: 'INV-8841' });
    check('the lines are recovered when the combined embed drops them',
      bk.bill && bk.bill.lineCount === 2, JSON.stringify(bk.bill && { lineCount: bk.bill.lineCount }));
    check('...so the worksheet cross-check runs instead of reporting the API missing',
      bk.worksheet && bk.worksheet.checked === true, JSON.stringify(bk.worksheet));
    check('...and what the invoice covers reaches the panel, line by line',
      (bk.bill.lines || []).map(l => l.comment).join('|') === 'Kitchen 2R|Bath 3B',
      JSON.stringify((bk.bill.lines || []).map(l => l.comment)));
    check('...without losing the attachment the combined embed was kept for',
      (bk.attachments || []).length === 1, JSON.stringify((bk.attachments || []).length));
    check('the recovery costs one request, not one per line', narrowCalls <= 2, `${narrowCalls} calls`);
  }

  // ── a charge with no bill still has a payment ────────────────────────────
  // Measured across 50 live charges 2026-09-14: 11 of 44 check-paid charges have
  // no AP bill, and none of them is a failure — six are permit fees paid straight
  // to the Town of West New York, five are small ACH reimbursements. A cheque
  // written to a municipality has no vendor invoice and never will. "No AP bill
  // matched this posting" was the panel's whole answer on a quarter of the
  // check-paid ledger, and it read like a defect.
  console.log('\nA charge with no bill, paid straight by check');
  {
    docs.__resetBankDirectory();
    stub.get = async (p2, params) => {
      if (/^\/Checks\/98765/.test(p2)) {
        return { ID: 98765, Reference: '10835', TransactionDate: '2026-07-02T00:00:00',
          Payee: 'Town of West New York', Amount: 125, TransactionType: 'Check',
          BankID: 3, ReconcileID: 4411 };
      }
      if (/^\/Banks\b/.test(p2)) return [{ BankID: 3, Name: 'Demo Portfolio - First Commerce Distr' }];
      // No bill exists anywhere for this posting.
      if (/^\/Bills/.test(p2)) return [];
      throw new Error('Rent Manager request failed (404)');
    };
    const CHG = { id: 'nobill-1', propertyId: 107, accountId: 901, accountRef: '6112',
      date: '2026-07-02', amount: 125, vendor: 'Town of West New York',
      txnType: 'CHKITM', txnId: 98765 };

    const pay = await docs.paymentFromCharge(CHG);
    check('the check behind a bill-less posting is found from the posting itself',
      pay && String(pay.reference) === '10835' && pay.payee === 'Town of West New York',
      JSON.stringify(pay && { ref: pay.reference, payee: pay.payee }));
    check('...naming the bank account it was drawn on',
      pay && pay.bank.name === 'Demo Portfolio - First Commerce Distr', JSON.stringify(pay && pay.bank.label));
    check('...and whether it cleared', pay && pay.reconciled === true);
    check('the applied figure is the posting\'s own amount, not a match',
      pay && pay.appliedToChargeLine === 125 && pay.direct === true,
      JSON.stringify(pay && { applied: pay.appliedToChargeLine, direct: pay.direct }));

    const bk = await docs.backupFor(CHG);
    check('the panel gets that payment even with no bill',
      bk.payment && bk.payment.direct === true && bk.bill === null,
      JSON.stringify({ hasPayment: !!bk.payment, bill: bk.bill }));
    check('...and says it was paid directly rather than reporting a failed lookup',
      (bk.unavailable || []).some(u => /paid directly/.test(u) && /no invoice to attach/.test(u)),
      JSON.stringify(bk.unavailable));
    check('...without the "No AP bill matched" line that read as a defect',
      !(bk.unavailable || []).some(u => /No AP bill matched/.test(u)),
      JSON.stringify(bk.unavailable));

    // A posting that is not a check line gets no invented payment.
    const cred = await docs.paymentFromCharge({ ...CHG, id: 'nobill-2', txnType: 'JOURNL' });
    check('a journal entry is not given a payment it does not have', cred === null);
    const noId = await docs.paymentFromCharge({ ...CHG, id: 'nobill-3', txnId: null });
    check('...nor is a posting with no transaction id', noId === null);
  }

  console.log('\nThe card side of a card-paid bill');
  // Was pointed at /BankTransactions, a 404 here, so it could never return
  // anything — and a failed lookup read exactly like "no card involved".
  servePayment({
    details: [{ BillDetailID: 1065871, PropertyID: 107, GLAccountID: 901, Amount: 2500 }],
    checkDetails: { 1065871: [{ CheckID: 158563, BillDetailID: 1065871, Amount: 2500 }] },
    check: asCheck({ TransactionType: 'Credit Card' }),
  });
  pay = await docs.paymentFor(PAID_BILL, PAID_CHARGE);
  check('a card payment is recognised as one', pay && pay.paidByCreditCard === true,
    JSON.stringify(pay && pay.method));
  const sc = await docs.creditCardStatementCharge(pay);
  check('...and the statement line comes back off /CreditCardTransactions',
    sc && sc.found === true && sc.amount === 5100, JSON.stringify(sc));
  check('...naming the card', sc && sc.card === 'Amex 1005', JSON.stringify(sc && sc.card));
  check('...and saying it was matched on amount and date, not on a key',
    sc && /amount and date/.test(sc.matchedOn || ''), JSON.stringify(sc && sc.matchedOn));

  const notCard = await docs.creditCardStatementCharge({ paidByCreditCard: false, paidOn: '2026-08-14', amount: 10 });
  check('a check payment does not go looking for a statement line', notCard === null);

  console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(1); });
