// Rent Manager emulation: accounts payable and the evidence under a P&L posting.
//   /Bills (+ /Bills/{id}; embeds Attachments, BillDetails)     the vendor bill behind a posting
//   /Checks (+ /Checks/{id}), /CheckDetails                     the money that settled it
//   /CreditCardTransactions (+ /{id}; embed Attachments), /CreditCards
//   /Credits, /PurchaseOrders, /BankReconciliations, /Vendors, /Reports (the catalogue)
//   raw: invoice / receipt files, served from the DownloadURL each attachment carries
//
// As on the real instance: /Attachments, /Files, /Documents, /Images, /BankAccounts, /Banks and
// /BillDetails are NOT resources (404) — documents ride on the bill as an embed — and
// An unknown filter column or embed name is a 400.
// All records come from services/demo/payables.js, which derives them from the GL postings.

const P = require('../payables');
const fin = require('../financials');
const world = require('../world');
const pdf = require('../invoicePdf');
const { collection, parseFilters, q } = require('../rmQuery');

const clean = rows => rows.map(r => {
  const o = {};
  for (const k of Object.keys(r)) if (!k.startsWith('__')) o[k] = r[k];
  return o;
});

// RM writes list filters as `ID,in,(1,2,3)`; rmQuery wants `ID,in,1|2|3`.
const normQuery = query => {
  const out = { ...query };
  for (const k of Object.keys(out)) {
    if (/^filters?$/i.test(k) && typeof out[k] === 'string') {
      out[k] = out[k].replace(/,in,\(([^)]*)\)/gi, (m, inner) => `,in,${inner.split(',').map(s => s.trim()).join('|')}`);
    }
  }
  return out;
};

// 400 on a filter column or embed the resource does not have, like the real API.
function validate(query, columns, embeds) {
  for (const f of parseFilters(q(normQuery(query), 'filters', 'filter'))) {
    if (!columns.has(f.field.toLowerCase())) return { __status: 400, __body: `Invalid filter: no such column '${f.field}'` };
  }
  const asked = String(q(query, 'embeds') || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const e of asked) if (!embeds.has(e.toLowerCase())) return { __status: 400, __body: `Invalid embed: '${e}'` };
  return null;
}
const colSet = rows => new Set(Object.keys(rows[0] || {}).map(k => k.toLowerCase()));

function register(router) {
  let cache = null;
  const data = () => {
    if (cache) return cache;
    const m = P.model();
    const billRows = clean(m.bills);
    const hiddenBill = new Map(m.bills.map(b => [b.BillID, b]));
    const checkRows = m.checks;
    const cardRows = clean(m.cards);
    const hiddenCard = new Map(m.cards.map(c => [c.ID, c]));
    const detailLines = (b) => b.__entries.map(e => ({
      BillDetailID: e.txnId * 10 + 1, BillID: b.BillID, Amount: e.amount, GLAccountID: e.accountId, GLAccountName: e.accountName,
      PropertyID: e.propertyId, ...(e.unitName ? { UnitName: e.unitName } : {}), Comment: e.memo || '', Description: e.memo || '',
      AmountAllocated: b.AmountAllocated ? e.amount : 0,
    }));
    const embedBill = (r, e) => {
      const b = hiddenBill.get(r.BillID);
      const out = { ...r };
      if (e.has('Attachments')) out.Attachments = P.billAttachments(b);
      if (e.has('BillDetails')) out.BillDetails = detailLines(b);
      return out;
    };
    const embedCard = (r, e) => {
      const c = hiddenCard.get(r.ID);
      return e.has('Attachments') ? { ...r, Attachments: P.cardAttachments(c) } : r;
    };
    // purchase orders: the approval trail behind the larger bills
    const poRows = m.bills.filter(b => b.PurchaseOrderID).map(b => ({
      PurchaseOrderID: b.PurchaseOrderID, ID: b.PurchaseOrderID, Number: `PO-${b.PurchaseOrderID}`, VendorID: b.AccountID, VendorName: b.VendorName,
      Description: b.__entry.memo || b.__entry.accountName, Amount: b.Amount, PropertyID: b.__entry.propertyId,
      CreateDate: P.T(P.addDays(String(b.TransactionDate).slice(0, 10), -6)), CreateUserID: 3,
      ApprovedByUserID: 1, ApprovedDate: P.T(P.addDays(String(b.TransactionDate).slice(0, 10), -5)), IsClosed: true,
    }));
    const hiddenPO = new Map(m.bills.filter(b => b.PurchaseOrderID).map(b => [b.PurchaseOrderID, b]));
    // one reconciliation per bank account per month that has closed out
    const recs = [];
    for (const ym of fin.MONTHS) {
      const end = `${ym}-${String(fin.lastDay(ym)).padStart(2, '0')}`;
      if (end > P.addDays(P.todayISO, -50)) continue;
      for (const bank of [P.BANK_OPERATING, P.BANK_RESERVE]) {
        recs.push({ BankReconciliationID: m.recId(bank, ym), ID: m.recId(bank, ym), BankID: bank, GLAccountID: bank, StatementDate: P.T(end),
          BeginningBalance: 0, EndingBalance: Math.round(150000 * (0.8 + P.HASH('rb', bank, ym) * 0.4) * 100) / 100,
          IsReconciled: true, ReconciledDate: P.T(P.addDays(end, 6)), ReconciledByUserID: 4 });
      }
    }
    const vendors = fin.vendors.map(v => ({
      VendorID: v.id, ID: v.id, Name: v.name, AccountNumber: v.acctNo, Reference: v.acctNo, IsActive: true, Is1099: P.HASH('1099', v.id) < 0.35,
      PaymentMethod: /water|electric|gas|insurance|bank|capital|lending/i.test(v.name) ? 'ACH' : 'Check',
    }));
    const reports = [
      [30, 'Charge Detail', 'Receivables'], [38, 'Balance Sheet', 'Financial'], [45, 'Profit & Loss Recap by Month', 'Financial'],
      [51, 'General Ledger', 'Financial'], [54, 'Cash Flow', 'Financial'], [85, 'Delinquency', 'Receivables'],
      [12, 'Rent Roll', 'Receivables'], [61, 'Aged Payables', 'Payables'], [62, 'Vendor Ledger', 'Payables'], [70, 'Check Register', 'Payables'],
    ].map(([id, name, cat]) => ({ ReportID: id, ID: id, Name: name, Category: cat, Description: name }));

    cache = {
      m, billRows, billCols: colSet(billRows), checkRows, checkCols: colSet(checkRows),
      lineRows: m.checkLines, lineCols: colSet(m.checkLines), cardRows, cardCols: colSet(cardRows),
      embedBill, embedCard, poRows, poCols: colSet(poRows), hiddenPO, recs, vendors, reports,
      creditRows: clean(m.credits).map(b => ({ CreditID: b.BillID, ID: b.BillID, AccountID: b.AccountID, AccountType: 'Vendor', Reference: b.Reference,
        Amount: b.Amount, TransactionDate: b.TransactionDate, VendorName: b.VendorName, Comment: b.Comment })),
      cards: m.cardsMaster,
    };
    return cache;
  };

  const BILL_EMBEDS = new Set(['attachments', 'billdetails']);
  const one = (rows, idField, id, query, opts, cols, embeds) => {
    const bad = validate(query, cols || new Set(), embeds || new Set());
    if (bad && /embed/i.test(bad.__body)) return bad;
    const hit = rows.filter(r => Number(r[idField]) === Number(id));
    if (!hit.length) return { __status: 404, __body: 'Not found' };
    return collection(hit, query, opts)[0];
  };

  // ── bills ──
  router.get('/Bills', ({ query }) => {
    const d = data();
    const bad = validate(query, d.billCols, BILL_EMBEDS); if (bad) return bad;
    return collection(d.billRows, normQuery(query), { embed: d.embedBill });
  });
  router.get(/^\/Bills\/(\d+)$/i, ({ query, match }) => { const d = data(); return one(d.billRows, 'BillID', match[1], query, { embed: d.embedBill }, d.billCols, BILL_EMBEDS); });

  // ── checks ──
  const NO_EMBEDS = new Set();
  router.get('/Checks', ({ query }) => {
    const d = data();
    const bad = validate(query, d.checkCols, NO_EMBEDS); if (bad) return bad;
    return collection(d.checkRows, normQuery(query));
  });
  router.get(/^\/Checks\/(\d+)$/i, ({ query, match }) => { const d = data(); return one(d.checkRows, 'ID', match[1], query, {}, d.checkCols, NO_EMBEDS); });
  router.get('/CheckDetails', ({ query }) => {
    const d = data();
    const bad = validate(query, d.lineCols, NO_EMBEDS); if (bad) return bad;
    return collection(d.lineRows, normQuery(query));
  });

  // ── credit cards ──
  const CARD_EMBEDS = new Set(['attachments']);
  router.get('/CreditCards', ({ query }) => collection(data().cards, query));
  router.get('/CreditCardTransactions', ({ query }) => {
    const d = data();
    const bad = validate(query, d.cardCols, CARD_EMBEDS); if (bad) return bad;
    return collection(d.cardRows, normQuery(query), { embed: d.embedCard });
  });
  router.get(/^\/CreditCardTransactions\/(\d+)$/i, ({ query, match }) => { const d = data(); return one(d.cardRows, 'ID', match[1], query, { embed: d.embedCard }, d.cardCols, CARD_EMBEDS); });

  // ── credits, purchase orders, reconciliations, vendors, report catalogue ──
  router.get('/Credits', ({ query }) => collection(data().creditRows, normQuery(query)));
  const PO_EMBEDS = new Set(['purchaseorderdetails', 'details']);
  const embedPO = (r, e) => {
    if (!(e.has('PurchaseOrderDetails') || e.has('Details'))) return r;
    const b = data().hiddenPO.get(r.PurchaseOrderID);
    const lines = [{ PurchaseOrderDetailID: r.PurchaseOrderID * 10 + 1, PurchaseOrderID: r.PurchaseOrderID, Amount: r.Amount, GLAccountID: b.__entry.accountId, PropertyID: b.__entry.propertyId, Description: r.Description }];
    const out = { ...r };
    if (e.has('PurchaseOrderDetails')) out.PurchaseOrderDetails = lines;
    if (e.has('Details')) out.Details = lines;
    return out;
  };
  router.get('/PurchaseOrders', ({ query }) => {
    const d = data(); const bad = validate(query, d.poCols, PO_EMBEDS); if (bad) return bad;
    return collection(d.poRows, normQuery(query), { embed: embedPO });
  });
  router.get(/^\/PurchaseOrders\/(\d+)$/i, ({ query, match }) => { const d = data(); return one(d.poRows, 'PurchaseOrderID', match[1], query, { embed: embedPO }, d.poCols, PO_EMBEDS); });
  router.get('/BankReconciliations', ({ query }) => collection(data().recs, normQuery(query)));
  router.get('/Vendors', ({ query }) => collection(data().vendors, normQuery(query)));
  router.get(/^\/Vendors\/(\d+)$/i, ({ query, match }) => one(data().vendors, 'VendorID', match[1], query, {}));
  router.get('/Reports', ({ query }) => collection(data().reports, normQuery(query)));

  // ── resources this Rent Manager simply does not have: a plain 404, as the real API answers ──
  const ABSENT = ['Attachments', 'Files', 'Documents', 'Images', 'ImageFiles', 'FileAttachments', 'BillAttachments',
    'BillDetails', 'BillAllocations', 'RecurringBills', 'VendorInvoices', 'PurchaseOrderDetails',
    'BankAccounts', 'Banks', 'BankTransactions', 'BankDeposits', 'Reconciliations', 'ReconciliationItems', 'ClearedTransactions',
    'Statements', 'BankStatements', 'GLTransactions', 'GLDetails', 'JournalEntries', 'JournalEntryDetails',
    'APChecks', 'BillCharges', 'CreditCardCharges', 'CardCharges', 'CardTransactions'];
  router.get(new RegExp(`^/(${ABSENT.join('|')})(/.*)?$`, 'i'), () => ({ __status: 404, __body: 'Not Found' }));

  // ── files ──
  const send = (buffer, name) => ({ ok: true, status: 200, contentType: 'application/pdf', contentDisposition: `inline; filename="${name}.pdf"`, buffer });
  router.raw(/^\/filereader\/download\/([A-Za-z0-9_-]+)$/i, async ({ match }) => {
    const t = P.unToken(match[1]);
    const miss = { ok: false, status: 404, contentType: '', contentDisposition: '', buffer: Buffer.alloc(0) };
    if (!t) return miss;
    const d = data();
    if (t.kind === 'bill') {
      const bill = d.m.billsById.get(t.id);
      if (!bill || !bill.__hasInvoice) return miss;
      const name = P.billAttachments(bill)[t.n - 1];
      if (!name) return miss;
      return send(t.n === 2 ? await pdf.proposalBuffer(bill) : await pdf.invoiceBuffer(bill), name.Name);
    }
    if (t.kind === 'card') {
      const card = d.m.cardsById.get(t.id);
      if (!card || !card.__hasReceipt) return miss;
      return send(await pdf.receiptBuffer(card), `receipt-${t.id}`);
    }
    return miss;
  });
}

module.exports = { register };
