// ── Who paid it, for every charge in the window ──────────────────────────────
//
// The owner, 2026-09-02: *"there's a bill, and then there's the other side of it,
// which is who paid it and the receipt for the person paying it. She needs both.
// How many do we have on the bill side and how many on the paid side?"*
//
// The bill side is backupCoverage.js. This is the other half, and it turns out to
// be a far easier question than the bill side was, because the answer is already
// on the posting: a renovation charge in this ledger IS a line of a payment.
// `txnType` says which kind and `txnId` says which one —
//
//   CHKITM   24,620 charges (87%)   a line of a check or ACH run
//   CC CHG    3,555 charges (13%)   a line of a company-card transaction
//   the rest     86 charges          credits, journal entries, deposits
//
// So there is no matching to do and nothing to guess. 28,261 charges resolve to
// 1,920 checks and 834 card transactions, and reading those 2,754 records answers
// "who paid this" for the entire ledger.
//
// What it CANNOT answer is whether a picture of the payment exists, and those are
// two different claims that get run together in a meeting. A check has no scan
// and does not need one: Rent Manager stamps it with the bank reconciliation it
// cleared in, which is stronger evidence than an image. A card charge can carry a
// receipt, and almost never does. Both are reported, separately.

const rentManager = require('./rentManagerClient');
const renovationExpenses = require('./renovationExpenses');
const rmDocuments = require('./rmDocuments');
const { makeSnapshotCache } = require('./snapshotCache');

const PACE_MS = Number(process.env.PAYMENT_SWEEP_PACE_MS || 120);

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.Results || payload.Items || payload.Data || [];
}
function oneRow(payload) {
  const list = asRows(payload);
  if (list.length) return list[0];
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  return null;
}
function pick(row, names) {
  for (const n of names) if (row && row[n] != null && row[n] !== '') return row[n];
  return null;
}

// A charge is an expense to pay, or it is a credit/journal entry that never had a
// payment side. Counting the second kind as "unpaid" would invent a gap.
const PAYING_TYPES = new Set(['CHKITM', 'CC CHG']);

async function build({ onProgress } = {}) {
  const snap = renovationExpenses.status().cache;
  if (!snap || !snap.data || !Array.isArray(snap.data.charges)) {
    throw new Error('No renovation snapshot yet — build that first.');
  }
  const charges = snap.data.charges;
  const readErrors = [];
  const noteError = (what, err) => {
    if (readErrors.length < 20) readErrors.push({ what, error: String(err && err.message ? err.message : err).slice(0, 160) });
  };

  const checkIds = [...new Set(charges.filter(c => c.txnType === 'CHKITM' && c.txnId != null).map(c => String(c.txnId)))];
  const cardIds = [...new Set(charges.filter(c => c.txnType === 'CC CHG' && c.txnId != null).map(c => String(c.txnId)))];

  // null means "could not read", which is not the same as "does not exist" and is
  // counted separately — the sweep that reported every card charge undocumented
  // was really reporting that Rent Manager had rate-limited it.
  // ── read them in pages, not one at a time ─────────────────────────────────
  // The first version fetched /Checks/{id} for each of 1,920 checks and
  // /CreditCardTransactions/{id} for each of 834. Two and a half thousand round
  // trips inside one background build is enough load to take this instance down,
  // and it did — twice, with the site returning 502 while it ran.
  //
  // The same records page 500 at a time over a date range, which is how the bank
  // probe read them. 2,754 requests become about ten. Anything the pages do not
  // cover is simply absent and counted as unreadable rather than chased.
  const PAGE = 500;
  const MAX_PAGES = 24;
  const from = (snap.data.window && snap.data.window.from) || '2000-01-01';
  const to = (snap.data.window && snap.data.window.to) || '2100-01-01';

  /**
   * Page a resource and keep only the fields this sweep uses, for only the ids it
   * asked about.
   *
   * Holding the raw rows was the second way this took the instance down: paging
   * 500 at a time over two years is twelve thousand full Rent Manager records
   * retained in memory beside a 16 MB renovation snapshot, on a container with
   * 512 MB. Projecting at the point of read keeps at most a few thousand objects
   * of five fields, and the page itself is released each loop.
   */
  async function pageInto(path, label, wanted, project) {
    const out = new Map();
    for (let page = 1; page <= MAX_PAGES; page++) {
      let rows;
      try {
        rows = asRows(await rentManager.get(path, {
          filters: `TransactionDate,ge,${from};TransactionDate,le,${to}`,
          pageSize: PAGE, pageNumber: page,
        }));
      } catch (err) { noteError(`${label} page ${page}`, err); break; }
      const got = rows.length;
      for (const r of rows) {
        const id = pick(r, ['ID', 'Id', 'CheckID', 'CreditCardTransactionID']);
        if (id == null) continue;
        const key = String(id);
        if (!wanted.has(key) || out.has(key)) continue;
        out.set(key, project(r));
      }
      rows = null;
      if (onProgress) onProgress({ stage: label, done: out.size, total: wanted.size });
      // Every id we care about is accounted for; the rest of the ledger is not
      // this sweep's business.
      if (got < PAGE || out.size >= wanted.size) break;
      if (PACE_MS) await new Promise(r => setTimeout(r, PACE_MS));
    }
    for (const id of wanted) if (!out.has(id)) out.set(id, null);
    return out;
  }

  const wantChecks = new Set(checkIds);
  const wantCards = new Set(cardIds);

  // Every bank account, once, before the pages — a check names its account by id
  // only. Resolving that id per check would put back exactly the per-record
  // request pattern the paging above exists to remove; describeBank() below is
  // pure, so the pages stay as cheap as they are now.
  const directory = await rmDocuments.bankDirectory();

  const checks = await pageInto('/Checks', 'checks', wantChecks, (row) => {
    const bankId = pick(row, ['BankID', 'BankAccountID', 'BankAccountId']);
    return {
      reference: pick(row, ['Reference', 'CheckNumber']),
      date: String(pick(row, ['TransactionDate', 'CheckDate']) || '').slice(0, 10),
      payee: pick(row, ['Payee', 'PayeeName']),
      amount: Number(pick(row, ['Amount'])) || 0,
      type: String(pick(row, ['TransactionType']) || ''),
      cleared: pick(row, ['ReconcileID', 'ReconcileId']) != null,
      bank: rmDocuments.describeBank({
        id: bankId,
        account: bankId != null ? directory.byId.get(String(bankId)) : null,
        rowName: pick(row, ['BankName', 'BankAccountName', 'AccountName']),
        rowNumber: pick(row, ['BankAccountNumber', 'AccountNumber']),
      }),
    };
  });

  // The receipt count is the one thing paging cannot give: attachments only ride
  // along on a single-record request. It already has an answer from the bill-side
  // sweep, so this does not re-ask 834 times for it — a card transaction here is
  // read for its reconcile stamp, and whether it carries a receipt stays that
  // sweep's finding.
  const cards = await pageInto('/CreditCardTransactions', 'card transactions', wantCards, (row) => ({
    reference: pick(row, ['Reference']),
    date: String(pick(row, ['TransactionDate']) || '').slice(0, 10),
    amount: Number(pick(row, ['Amount'])) || 0,
    cleared: pick(row, ['ReconcileID', 'ReconcileId']) != null,
    receipts: 0,
  }));
  if (onProgress) onProgress({ stage: 'matched', done: checks.size + cards.size, total: null });

  // ── roll it up ────────────────────────────────────────────────────────────
  const blank = () => ({
    charges: 0, amount: 0,
    check: 0, checkAmount: 0, checkCleared: 0,
    card: 0, cardAmount: 0, cardCleared: 0,
    cardWithReceipt: 0,
    unreadable: 0, notAPayment: 0, notAPaymentAmount: 0,
  });
  const totals = blank();
  const byEntity = new Map();
  const byMethod = {};
  // Which accounts the renovation ledger was actually paid out of. Sarah's
  // question — "which account do I search for this check" — asked once for the
  // whole window instead of one charge at a time.
  const byBank = new Map();

  for (const c of charges) {
    const amt = Number(c.amount) || 0;
    const ekey = c.entity || 'No entity';
    if (!byEntity.has(ekey)) byEntity.set(ekey, { name: ekey, ...blank() });
    const E = byEntity.get(ekey);
    for (const row of [totals, E]) { row.charges++; row.amount += amt; }

    const t = c.txnType || '(none)';
    byMethod[t] = byMethod[t] || { type: t, charges: 0, amount: 0 };
    byMethod[t].charges++; byMethod[t].amount += amt;

    if (!PAYING_TYPES.has(t)) {
      for (const row of [totals, E]) { row.notAPayment++; row.notAPaymentAmount += amt; }
      continue;
    }
    const rec = t === 'CHKITM' ? checks.get(String(c.txnId)) : cards.get(String(c.txnId));
    if (rec === null || rec === undefined) {
      for (const row of [totals, E]) row.unreadable++;
      continue;
    }
    if (t === 'CHKITM') {
      for (const row of [totals, E]) {
        row.check++; row.checkAmount += amt;
        if (rec.cleared) row.checkCleared++;
      }
      const bank = rec.bank || { id: null, label: 'Not recorded on the payment in Rent Manager', known: false };
      const bkey = bank.id != null ? `id:${bank.id}` : `label:${bank.label}`;
      if (!byBank.has(bkey)) {
        byBank.set(bkey, { id: bank.id, label: bank.label, last4: bank.last4 || null,
          named: Boolean(bank.known), charges: 0, amount: 0, cleared: 0, checks: new Set() });
      }
      const B = byBank.get(bkey);
      B.charges++; B.amount += amt;
      if (rec.cleared) B.cleared++;
      B.checks.add(String(c.txnId));
    } else {
      for (const row of [totals, E]) {
        row.card++; row.cardAmount += amt;
        if (rec.cleared) row.cardCleared++;
        // receipts are the bill-side sweep's finding, not this one's
      }
    }
  }

  // How the checks themselves are labelled — "check" covers printed checks, ACH
  // and EFT here, and which one it was is on the record.
  const checkKinds = {};
  for (const v of checks.values()) {
    if (!v) continue;
    const k = /^\d+$/.test(String(v.reference || '')) ? 'Check (numbered)' : (v.reference || 'unlabelled');
    checkKinds[k] = (checkKinds[k] || 0) + 1;
  }

  return {
    window: snap.data.window || {},
    builtFrom: snap.refreshedAt || null,
    totals,
    byMethod: Object.values(byMethod).sort((a, b) => b.charges - a.charges),
    byEntity: [...byEntity.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    // Every bank account that paid a renovation charge in the window, biggest
    // first. `named: false` rows are accounts Rent Manager gave us an id for and
    // no name — the count of those is the size of the permission still to ask for.
    byBank: [...byBank.values()]
      .map(b => ({ ...b, checks: b.checks.size }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    bankDirectory: {
      source: directory.source,
      keyedOn: directory.keyedOn,
      tried: directory.tried,
      accounts: directory.byId.size,
    },
    checkKinds,
    paymentsRead: { checks: checkIds.length, cards: cardIds.length,
      checksUnreadable: [...checks.values()].filter(v => !v).length,
      cardsUnreadable: [...cards.values()].filter(v => !v).length },
    readErrors,
  };
}

const cache = makeSnapshotCache({
  name: 'payment coverage',
  file: 'payment-coverage-cache.json',
  build: () => build(),
});

module.exports = { build, refresh: cache.refresh, status: cache.status, getFresh: cache.getFresh };
