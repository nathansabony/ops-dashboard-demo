// The demo's accounts-payable side: the bills, checks, card swipes and invoice files that sit
// underneath the P&L postings in services/demo/financials.js.
//
// Nothing here is invented independently of the books. Every record is derived from one GL
// entry (or a group of them), so the drill-down from a P&L cell -> posting -> bill -> invoice
// PDF -> check -> bank always ties to the cent.
//
//   bill        one per 'Bill' posting (a negative one is a vendor credit memo)
//   check       (a) one per 'Check' posting: a check/ACH keyed straight to expense, and
//               (b) one per vendor + pay date that settles one or more bills
//   card txn    one per 'CC CHG' posting
//   invoice     a PDF generated on demand (services/demo/invoicePdf.js) from the same posting
//
// Planted for the demo story (see also financials.planted):
//   - duplicate payments: financials relabels a second bill as a hand-keyed check that repeats
//     the first bill's invoice number
//   - a few bills with no invoice file, one bill not yet approved, recent bills not yet paid
//   - some card swipes with no receipt attached

const fin = require('./financials');
const world = require('./world');

const U = world.util;
const todayISO = U.ymd(world.today);
const HASH = (...k) => {
  const str = k.join('|');
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
  x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995); x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
};
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const round2 = n => Math.round(n * 100) / 100;
const T = d => (d ? `${d}T00:00:00` : null);

const BANK_OPERATING = 1070;
const BANK_RESERVE = 1071;
const ACH_VENDORS = /water|electric|gas|power|insurance|waste|internet|payroll|loan|bank|capital|lending|mutual|tax/i;

let _m = null;
function model() {
  if (_m) return _m;
  fin.ensurePlants();
  const first = `${fin.MONTHS[0]}-01`;
  const entries = fin.glEntries(first, todayISO);

  const bills = [];            // base rows
  const billEntry = new Map(); // posting txnId -> its bill
  const checks = [];           // check rows
  const checkLines = [];       // CheckDetails rows
  const checkMeta = new Map(); // checkId -> { entries:[...], kind }
  const cards = [];
  const cardEntry = new Map();
  const credits = [];

  const planted = fin.planted || { duplicates: [] };
  const dupBillIds = new Set(planted.duplicates.map(d => d.billTxnId));

  // ── which bills carry a flagged story ────────────────────────────────────
  // Largest bill for each scripted event month, so the Variances investigation has
  // something real to open. (Events are expressed as months-ago `a`.)
  const eventBills = new Set();
  const eventKey = (pid, ref, a) => `${pid}|${ref}|${a}`;
  const eventMonths = new Map();
  for (const e of fin.EVENTS) for (const r of e.refs) eventMonths.set(eventKey(e.pid, r, e.a), e);
  for (const s of fin.MAJOR_SCRIPT) eventMonths.set(eventKey(s.pid, s.ref, s.a), s);
  const bigByKey = new Map();
  for (const e of entries) {
    if (e.txnType !== 'Bill') continue;
    const a = fin.monthsAgo(e.month);
    const k = eventKey(e.propertyId, e.accountRef, a);
    if (!eventMonths.has(k)) continue;
    const cur = bigByKey.get(k);
    if (!cur || Math.abs(e.amount) > Math.abs(cur.amount)) bigByKey.set(k, e);
  }
  for (const e of bigByKey.values()) eventBills.add(e.txnId);
  // Two scripted housekeeping gaps for the story: Summit Lofts' turnover bill has no invoice
  // file; Maple Court's plumbing bill is entered but not yet approved.
  const noInvoice = new Set();
  let unapproved = null;
  for (const [k, e] of bigByKey) {
    const [pid, ref, a] = k.split('|');
    if (pid === '105' && ref === '5106' && Number(a) === 2) noInvoice.add(e.txnId);
    if (pid === '102' && ref === '5102' && Number(a) === 1) unapproved = e.txnId;
  }

  // ── bills ────────────────────────────────────────────────────────────────
  // One bill per vendor invoice. Almost always one posting; a utility's single statement
  // (water + sewer on the same account, date and reference) is ONE bill with a line each.
  const payGroups = new Map();   // `${vendorId}|${paidDate}` -> [entry]
  const groups0 = new Map();
  for (const e of entries) {
    if (e.txnType !== 'Bill') continue;
    const k = e.servicePeriod ? `${e.vendorId}|${e.propertyId}|${e.reference}|${e.date}` : `solo|${e.txnId}`;
    if (!groups0.has(k)) groups0.set(k, []);
    groups0.get(k).push(e);
  }
  for (const list of groups0.values()) {
    list.sort((x, y) => x.txnId - y.txnId);
    const e = list[0];
    const billId = e.txnId;
    const total = round2(list.reduce((sum, x) => sum + x.amount, 0));
    const credit = total < 0;
    const billDate = addDays(e.date, -Math.floor(HASH('bd', billId) * 7));
    const paid = !credit && e.paidDate && e.paidDate <= todayISO;
    const approvalUser = HASH('ap', billId) < 0.6 ? 2 : 4;
    const isApproved = billId !== unapproved;
    const reference = e.invoiceNo || e.reference;
    const bill = {
      BillID: billId, ID: billId, AccountID: e.vendorId, AccountType: 'Vendor', TransactionType: 'Bill',
      Reference: reference, Amount: total, TransactionDate: T(billDate), PostDate: T(e.date), DueDate: T(e.dueDate || addDays(e.date, 30)),
      VendorName: e.vendor, PayeeName: e.vendor,
      Comment: credit ? 'Vendor credit memo' : (e.memo || ''),
      IsApproved: isApproved, ApprovalUserID: isApproved ? approvalUser : 0, ApprovalDate: isApproved ? T(addDays(billDate, 2)) : null,
      AmountAllocated: paid ? total : 0, IsFullyAllocated: !!paid,
      CreateUserID: 4, CreateDate: T(addDays(billDate, 1)), UpdateUserID: 4, UpdateDate: T(addDays(billDate, 2)),
      PurchaseOrderID: !credit && total >= 1500 && HASH('po', billId) < 0.6 ? 3000 + (billId % 100000) : null,
      __entry: e, __entries: list,
    };
    bills.push(bill);
    for (const x of list) billEntry.set(x.txnId, bill);
    if (credit) credits.push(bill);
    else if (paid) {
      const key = `${e.vendorId}|${e.paidDate}`;
      if (!payGroups.has(key)) payGroups.set(key, []);
      payGroups.get(key).push(...list);
    }
  }

  // ── checks that settle bills ──────────────────────────────────────────────
  const recId = (bank, ymStr) => 3000 + fin.ymToIdx(ymStr) * 2 + (bank - BANK_OPERATING);
  const reconciledId = (bank, date) => {
    if (date > addDays(todayISO, -50)) return null;
    return recId(bank, date.slice(0, 7));
  };
  let ckSeq = 0;
  // check numbers run in date order, like a real register
  const groups = [...payGroups.values()].sort((a, b) => (a[0].paidDate < b[0].paidDate ? -1 : a[0].paidDate > b[0].paidDate ? 1 : a[0].txnId - b[0].txnId));
  for (const list of groups) {
    list.sort((a, b) => a.txnId - b.txnId);
    const e0 = list[0];
    const checkId = 8000000 + e0.txnId;
    const bank = list.some(x => /^51[5-9]|^61/.test(x.accountRef)) ? BANK_RESERVE : BANK_OPERATING;
    const ach = ACH_VENDORS.test(e0.vendor);
    const total = round2(list.reduce((s, x) => s + x.amount, 0));
    const ref = ach ? `ACH-${String(e0.txnId).slice(-5)}` : String(20100 + (ckSeq++));
    checks.push({
      ID: checkId, CheckID: checkId, AccountID: e0.vendorId, AccountType: 'Vendor', Reference: ref, Amount: total,
      TransactionDate: T(e0.paidDate), Payee: e0.vendor, BankID: bank, TransactionType: ach ? 'ACH' : 'Check',
      ReconcileID: reconciledId(bank, e0.paidDate), Comment: '', CreateUserID: 4, CreateDate: T(e0.paidDate),
    });
    checkMeta.set(checkId, { kind: 'bills', entries: list, bank });
    list.forEach((x, i) => {
      checkLines.push({ CheckDetailID: 90000000 + x.txnId, CheckID: checkId, BillDetailID: x.txnId * 10 + 1,
        Amount: x.amount, PropertyID: x.propertyId, GLAccountID: x.accountId, Comment: x.memo || '' });
    });
  }

  // ── checks keyed straight to expense (and loan ACH) ───────────────────────
  for (const e of entries) {
    if (e.txnType !== 'Check') continue;
    const bank = BANK_OPERATING;
    const ach = /^ACH/.test(e.reference);
    checks.push({
      ID: e.txnId, CheckID: e.txnId, AccountID: e.vendorId, AccountType: 'Vendor', Reference: e.reference, Amount: e.amount,
      TransactionDate: T(e.date), Payee: e.vendor, BankID: bank, TransactionType: ach ? 'ACH' : 'Check',
      ReconcileID: reconciledId(bank, e.date), Comment: e.memo || '', CreateUserID: 4, CreateDate: T(e.date),
    });
    checkMeta.set(e.txnId, { kind: 'direct', entries: [e], bank });
    checkLines.push({ CheckDetailID: 80000000 + e.txnId, CheckID: e.txnId, BillDetailID: null,
      Amount: e.amount, PropertyID: e.propertyId, GLAccountID: e.accountId, Comment: e.memo || '' });
  }

  // ── card swipes ───────────────────────────────────────────────────────────
  const CARD_OF_PROPERTY = { 101: 1, 102: 1, 103: 2, 104: 2, 105: 1 };
  for (const e of entries) {
    if (e.txnType !== 'CC CHG') continue;
    const cardId = CARD_OF_PROPERTY[e.propertyId] || 1;
    const hasReceipt = HASH('rcpt', e.txnId) > 0.14;
    const row = {
      ID: e.txnId, CreditCardTransactionID: e.txnId, CreditCardID: cardId, Reference: e.reference, Amount: e.amount,
      TransactionDate: T(e.date), PostDate: T(e.date), Comment: `${e.vendor} - ${e.memo || ''}`.trim(), AccountID: e.vendorId,
      AccountType: 'Vendor', ReconcileID: reconciledId(BANK_OPERATING, e.date), __entry: e, __hasReceipt: hasReceipt,
    };
    cards.push(row);
    cardEntry.set(e.txnId, row);
  }

  // ── which bills have an invoice file ──────────────────────────────────────
  const billHasInvoice = (b) => {
    const e = b.__entry;
    if (noInvoice.has(b.BillID)) return false;
    if (b.Amount < 0) return HASH('cmi', b.BillID) > 0.3;
    if (eventBills.has(b.BillID) || dupBillIds.has(b.BillID)) return true;
    if (/^6100|^51[5-9]/.test(e.accountRef)) return HASH('inv', b.BillID) > 0.2;   // renovation / major work
    return HASH('inv', b.BillID) > 0.07;
  };
  for (const b of bills) b.__hasInvoice = billHasInvoice(b);

  const byId = rows => new Map(rows.map(r => [Number(r.ID), r]));
  _m = {
    entries, bills, billsById: byId(bills), checks, checksById: byId(checks), checkLines, checkMeta,
    cards, cardsById: byId(cards), billOfTxn: billEntry, credits, planted, eventBills, noInvoice, unapproved,
    cardsMaster: [
      { CreditCardID: 1, Name: 'Demo Portfolio Maintenance Visa - 4417', Reference: '4417', Description: 'Maintenance purchasing card (Sam Whitfield)', IsActive: true, BankID: BANK_OPERATING },
      { CreditCardID: 2, Name: 'Demo Portfolio Office Mastercard - 9082', Reference: '9082', Description: 'Office and supplies card (Priya Natarajan)', IsActive: true, BankID: BANK_OPERATING },
    ],
    recId,
  };
  return _m;
}

// ── attachments ─────────────────────────────────────────────────────────────
const HOST = 'https://rm12filereader.example.test';
const token = (kind, id, n) => Buffer.from(`${kind}:${id}:${n}`).toString('base64url');
const unToken = t => { try { const [kind, id, n] = Buffer.from(String(t), 'base64url').toString().split(':'); return { kind, id: Number(id), n: Number(n) }; } catch (e) { return null; } };
const slug = s => String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function billAttachments(b) {
  if (!b.__hasInvoice) return [];
  const e = b.__entry;
  const out = [];
  const mk = (n, name, desc) => {
    const t = token('bill', b.BillID, n);
    return {
      FileID: 40000000 + b.BillID * 3 + n, AttachmentID: undefined, Name: name, Description: desc, IsDepotUsed: true,
      Path: `\\\\depot\\ap\\${e.month.slice(0, 4)}\\${slug(name)}.pdf`, Extension: '.pdf', Token: t, FileSize: 38000 + Math.floor(HASH('sz', b.BillID, n) * 40000),
      CreateDate: b.CreateDate, DownloadURL: `${HOST}/filereader/download/${t}?FKey=${Math.floor(HASH('fk', b.BillID, n) * 1e9).toString(36)}`,
    };
  };
  const credit = b.Amount < 0;
  out.push(mk(1, `${slug(e.vendor)}-${credit ? 'credit-memo' : 'invoice'}-${b.Reference}`, credit ? 'Vendor credit memo' : 'Vendor invoice'));
  if (!credit && b.Amount >= 5000) out.push(mk(2, `${slug(e.vendor)}-signed-proposal-${b.Reference}`, 'Signed proposal and scope of work'));
  out.forEach(a => delete a.AttachmentID);
  return out;
}

function cardAttachments(c) {
  if (!c.__hasReceipt) return [];
  const t = token('card', c.ID, 1);
  const file = {
    FileID: 50000000 + c.ID, Name: `receipt-${slug(c.__entry.vendor)}-${c.ID}`, Extension: '.pdf', IsDepotUsed: true,
    Path: `\\\\depot\\cards\\${c.__entry.month.slice(0, 4)}\\receipt-${c.ID}.pdf`, Token: t, CreateDate: c.TransactionDate,
    DownloadURL: `${HOST}/filereader/download/${t}?FKey=${Math.floor(HASH('fk', c.ID) * 1e9).toString(36)}`,
  };
  return [{ FileAttachmentID: 60000000 + c.ID, FileID: file.FileID, Description: 'Card receipt', EntityType: 'CreditCardTransaction', EntityKeyID: c.ID, File: file }];
}

module.exports = { model, billAttachments, cardAttachments, unToken, token, HOST, HASH, addDays, todayISO, T, round2, BANK_OPERATING, BANK_RESERVE };
