// ── Which charges can actually show their invoice ────────────────────────────
//
// The owner, 2026-08-26: *"a lot of them don't have any bills. So what percentage
// actually have bills? ... I wanna know which properties have the bills, which
// don't so that when I'm showing them on a call, I don't show the bad ones."*
//
// That is a question about the whole ledger, and the per-charge lookup cannot
// answer it: pressing Backup on 28,261 charges to find out which ones are worth
// pressing is not a plan. But the work is far smaller than the charge count makes
// it look — those charges come from 208 vendors and 1,885 distinct invoices, and
// a vendor's bills arrive a page at a time.
//
// So: pull every renovation vendor's bills once, WITH their attachments, index
// them, and resolve every charge against that index in memory. One pass over the
// vendors answers it for every charge, and the answer is a property-by-property
// table of what will and will not have a document on screen.
//
// This never downloads a file. It records whether one EXISTS — the name, the
// size, the bill it hangs off — because that is what "can I show this on a call"
// depends on. The bytes are still fetched on click, which takes about a second
// and does not need a copy on disk that the host may wipe on every deploy.

const rentManager = require('./rentManagerClient');
const renovationExpenses = require('./renovationExpenses');
const { makeSnapshotCache } = require('./snapshotCache');

const PAGE = 500;          // bills per request
const MAX_PAGES = 12;      // a vendor with more than 6,000 bills in the window is a data problem, not a page problem
// Rent Manager answers 429 under load, and this sweep reads tens of thousands of
// records. The client now backs off and retries rather than reporting an empty
// result, but the cheaper fix is not to provoke it: two at a time, not three.
const CONCURRENCY = 2;
// A sweep is a background convenience; somebody clicking a charge is not. The
// sweep once ran while a demo was live and every click sat behind its queue, so
// it now pauses between batches and can be switched off entirely.
const PACE_MS = Number(process.env.BACKUP_SWEEP_PACE_MS || 120);

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.Results || payload.Items || payload.Data || [];
}
function pick(row, names) {
  for (const n of names) if (row && row[n] != null && row[n] !== '') return row[n];
  return null;
}
const norm = v => String(v == null ? '' : v).trim().toUpperCase();
const cents = v => Math.round(Math.abs(Number(v) || 0) * 100);

// Every bill this vendor has in the window, with whatever is attached to them.
async function billsForVendor(vendorId, from, to) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let rows;
    try {
      rows = asRows(await rentManager.get('/Bills', {
        filters: `AccountID,eq,${vendorId};TransactionDate,ge,${from};TransactionDate,le,${to}`,
        embeds: 'Attachments', pageSize: PAGE, pageNumber: page,
      }));
    } catch (err) {
      // A vendor we cannot read is reported as unknown rather than as "no
      // invoice" — the two look identical on screen and mean opposite things.
      return { rows: out, error: String(err && err.message ? err.message : err).slice(0, 160) };
    }
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { rows: out, error: null };
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      if (PACE_MS) await new Promise(r => setTimeout(r, PACE_MS));
    }
  });
  await Promise.all(workers);
  return out;
}

async function build({ onProgress } = {}) {
  const snap = renovationExpenses.status().cache;
  if (!snap || !snap.data || !Array.isArray(snap.data.charges)) {
    throw new Error('No renovation snapshot yet — build that first.');
  }
  const charges = snap.data.charges;
  const window = snap.data.window || {};
  const from = window.from || charges.reduce((m, c) => (c.date < m ? c.date : m), '9999-12-31');
  const to = window.to || charges.reduce((m, c) => (c.date > m ? c.date : m), '0000-01-01');

  const vendorIds = [...new Set(charges.map(c => c.vendorId).filter(v => v != null))];

  let done = 0;
  const perVendor = await mapWithConcurrency(vendorIds, CONCURRENCY, async (vid) => {
    const { rows, error } = await billsForVendor(vid, from, to);
    done++;
    if (onProgress) onProgress({ done, total: vendorIds.length });
    return { vid, rows, error };
  });

  // Index by the two things a charge can be matched on: the invoice number RM
  // wrote into the description, and failing that the amount on a nearby date.
  const byRef = new Map();      // `${vendorId}|${REFERENCE}` -> bill
  const byAmount = new Map();   // `${vendorId}|${cents}`     -> [bills]
  const vendorError = new Map();
  for (const { vid, rows, error } of perVendor) {
    if (error) vendorError.set(String(vid), error);
    for (const b of rows) {
      const ref = norm(pick(b, ['Reference', 'InvoiceNumber', 'BillNumber']));
      if (ref) {
        const k = `${vid}|${ref}`;
        if (!byRef.has(k)) byRef.set(k, b);
      }
      const k2 = `${vid}|${cents(pick(b, ['Amount', 'TotalAmount', 'Total']))}`;
      const list = byAmount.get(k2) || [];
      list.push(b);
      byAmount.set(k2, list);
    }
  }

  const attachmentsOf = b => (Array.isArray(b && b.Attachments) ? b.Attachments : []);

  // ── the two routes that are not "look the bill up by its number" ──────────
  //
  // 1. CARD CHARGES. 3,555 postings are credit card charges, and there is no bill
  //    behind them at all — the receipt hangs off the card transaction. 3,555
  //    charges turn out to be only 834 distinct transactions.
  //
  // 2. CHECK ITEMS WITH NO INVOICE NUMBER. About 11,000 postings whose
  //    description reads "Cabinets Refinish" rather than "100134", so there is
  //    nothing to look the bill up BY. Rent Manager will say which bills a check
  //    paid: /CheckDetails hands back lines carrying BillDetailID, and a bill will
  //    list its own detail lines. So the match becomes an index lookup instead of
  //    a guess. 11,123 charges are only 761 distinct checks.
  //
  // Only bills that CARRY a scan are worth indexing by detail line: a bill with
  // no attachment cannot make a charge documented, so fetching its lines would be
  // thousands of requests spent proving nothing.
  const billsWithDocs = [];
  for (const { rows } of perVendor) for (const b of rows) if (attachmentsOf(b).length) billsWithDocs.push(b);

  const billByDetailId = new Map();   // BillDetailID -> bill (that has a scan)
  let detailIndexed = 0, detailFailed = 0;
  const readErrors = [];
  const noteError = (what, err) => {
    if (readErrors.length < 20) readErrors.push({ what, error: String(err && err.message ? err.message : err).slice(0, 160) });
  };
  await mapWithConcurrency(billsWithDocs, CONCURRENCY, async (b) => {
    const id = pick(b, ['BillID', 'BillId', 'ID', 'Id']);
    if (id == null) return;
    try {
      const payload = await rentManager.get(`/Bills/${encodeURIComponent(id)}`, { embeds: 'BillDetails' });
      const rws = asRows(payload);
      const row = rws.length ? rws[0] : (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null);
      const det = row && Array.isArray(row.BillDetails) ? row.BillDetails : [];
      for (const d of det) {
        const bd = pick(d, ['BillDetailID', 'BillDetailId']);
        if (bd != null && !billByDetailId.has(String(bd))) billByDetailId.set(String(bd), b);
      }
      detailIndexed++;
    } catch (err) { detailFailed++; noteError(`bill lines ${id}`, err); }
  });
  if (onProgress) onProgress({ stage: 'bill lines', done: detailIndexed, total: billsWithDocs.length });

  // Every check behind a posting, and the bill lines it paid.
  const checkIds = [...new Set(charges.filter(c => c.txnType === 'CHKITM' && c.txnId != null).map(c => String(c.txnId)))];
  const checkDetails = new Map();   // checkId -> [{billDetailId, propertyId, glAccountId, amount}]
  await mapWithConcurrency(checkIds, CONCURRENCY, async (cid) => {
    try {
      const rws = asRows(await rentManager.get('/CheckDetails', { filters: `CheckID,eq,${cid}`, pageSize: 200 }));
      checkDetails.set(cid, rws.map(r => ({
        billDetailId: pick(r, ['BillDetailID', 'BillDetailId']),
        propertyId: pick(r, ['PropertyID', 'PropertyId']),
        glAccountId: pick(r, ['GLAccountID', 'GLAccountId']),
      })));
    } catch (err) { checkDetails.set(cid, null); noteError(`check ${cid}`, err); }
  });
  if (onProgress) onProgress({ stage: 'check lines', done: checkDetails.size, total: checkIds.length });

  // Every card transaction behind a posting, and whether it carries a receipt.
  const cardIds = [...new Set(charges.filter(c => c.txnType === 'CC CHG' && c.txnId != null).map(c => String(c.txnId)))];
  const cardDocs = new Map();   // txnId -> attachment count (null = could not read)
  await mapWithConcurrency(cardIds, CONCURRENCY, async (tid) => {
    try {
      const payload = await rentManager.get(`/CreditCardTransactions/${encodeURIComponent(tid)}`, { embeds: 'Attachments' });
      const rws = asRows(payload);
      const row = rws.length ? rws[0] : (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null);
      const rid = row && pick(row, ['ID', 'Id', 'CreditCardTransactionID']);
      // The record has to BE the one asked for, or the id means something else
      // here and every count from it would be fiction.
      if (!row || (rid != null && String(rid) !== String(tid))) { cardDocs.set(tid, null); return; }
      cardDocs.set(tid, Array.isArray(row.Attachments) ? row.Attachments.length : 0);
    } catch (err) { cardDocs.set(tid, null); noteError(`card ${tid}`, err); }
  });
  if (onProgress) onProgress({ stage: 'card receipts', done: cardDocs.size, total: cardIds.length });

  // The check's lines, narrowed to the ones that could be THIS posting.
  const billViaCheck = (c) => {
    const lines = checkDetails.get(String(c.txnId));
    if (!lines || !lines.length) return null;
    const mine = lines.filter(l =>
      (l.propertyId == null || c.propertyId == null || String(l.propertyId) === String(c.propertyId))
      && (l.glAccountId == null || c.accountId == null || String(l.glAccountId) === String(c.accountId)));
    // Falling back to every line when none matches is how the wrong property's
    // invoice ends up on this charge. A check pays eleven lines across four
    // buildings; if the lines DO carry a property and none of them is ours, this
    // posting is simply not among them. Only when no line names a property at all
    // is there nothing to narrow on, and then every line is fair game.
    const narrowable = lines.some(l => l.propertyId != null || l.glAccountId != null);
    if (!mine.length && narrowable) return null;
    for (const l of (mine.length ? mine : lines)) {
      if (l.billDetailId == null) continue;
      const b = billByDetailId.get(String(l.billDetailId));
      if (b) return b;
    }
    return null;
  };
  const dayGap = (b, date) => {
    const d = String(pick(b, ['TransactionDate', 'BillDate', 'PostDate']) || '').slice(0, 10);
    if (!d || !date) return 9999;
    return Math.abs((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
  };

  // Resolve every charge against the index. `how` records which rung answered,
  // because "found by invoice number" and "found by amount on a nearby date" are
  // not the same claim and should not be counted as one.
  const perProperty = new Map();
  // ── the cuts that actually decide what to show ────────────────────────────
  // The per-property table came back almost flat: 22–34% for 84 of 86 buildings.
  // That is not noise, it is the answer — a renovation invoice is one bill split
  // across the properties it covers (FY Construction's MAJOR/Cedar Ridge/37Du hits ten of
  // them), so whether a document exists is a property of the VENDOR and the
  // MONTH, not of the building. Every property therefore ends up with much the
  // same mix, and choosing between them barely moves what is on screen.
  //
  // Vendor and month are the cuts that separate. They are what turns "which
  // properties are safe" into an answer someone can act on.
  const perVendorCov = new Map();
  const perMonth = new Map();
  const byKind = {};
  const documented = [];
  const resolved = [];
  const totals = { charges: 0, withBill: 0, withDocument: 0, byRef: 0, byCheck: 0, byAmount: 0,
    billNoDoc: 0, card: 0, cardWithDoc: 0, cardNoDoc: 0, cardUnreadable: 0,
    vendorUnreadable: 0, noVendor: 0 };
  const bump = (map, key, extra) => {
    const row = map.get(key) || { key, charges: 0, amount: 0, withBill: 0, withDocument: 0, amountWithDocument: 0, ...extra };
    map.set(key, row);
    return row;
  };

  for (const c of charges) {
    totals.charges++;
    const pkey = c.propertyName || '(unattributed)';
    const p = perProperty.get(pkey) || {
      property: pkey, propertyId: c.propertyId ?? null, entity: c.entity || null,
      charges: 0, amount: 0, withBill: 0, withDocument: 0, amountWithDocument: 0,
      byRef: 0, byCheck: 0, byAmount: 0, billNoDoc: 0, unreadable: 0,
    };
    p.charges++; p.amount += c.amount || 0;
    const v = bump(perVendorCov, c.vendorId == null ? '(no vendor)' : String(c.vendorId), { name: c.vendor || null });
    if (!v.name && c.vendor) v.name = c.vendor;
    v.charges++; v.amount += c.amount || 0;
    const mo = bump(perMonth, c.month || '(no month)');
    mo.charges++; mo.amount += c.amount || 0;

    let bill = null; let how = null; let cardDoc = false;

    if (c.txnType === 'CC CHG') {
      // No bill exists for a card charge — the receipt is on the transaction.
      const n = cardDocs.get(String(c.txnId));
      totals.card++;
      if (n == null) { totals.cardUnreadable++; }
      else if (n > 0) { cardDoc = true; totals.cardWithDoc++; how = 'card'; }
      else { totals.cardNoDoc++; }
    } else if (c.vendorId == null) {
      totals.noVendor++;
    } else if (vendorError.has(String(c.vendorId))) {
      totals.vendorUnreadable++; p.unreadable++;
    } else {
      const ref = norm(c.invoiceNo);
      if (ref) { bill = byRef.get(`${c.vendorId}|${ref}`) || null; if (bill) how = 'ref'; }
      if (!bill) {
        // The check tells us which bills it paid. This is the rung that reaches
        // the postings whose description never named an invoice, and it is a
        // lookup rather than a guess — the bill either contains one of the
        // check's own detail lines or it does not.
        const viaCheck = billViaCheck(c);
        if (viaCheck) { bill = viaCheck; how = 'check'; }
      }
      if (!bill) {
        // The weakest rung, and deliberately strict about it: the same vendor, the
        // same amount to the cent, within a fortnight. A split invoice will not
        // be found this way, which is why it is counted separately rather than
        // folded into one headline number.
        const near = (byAmount.get(`${c.vendorId}|${cents(c.amount)}`) || [])
          .filter(b => dayGap(b, c.date) <= 14)
          .sort((a, b) => dayGap(a, c.date) - dayGap(b, c.date));
        if (near.length) { bill = near[0]; how = 'amount'; }
      }
    }

    if (bill) {
      p.withBill++; totals.withBill++; v.withBill++; mo.withBill++;
      if (how === 'ref') { p.byRef++; totals.byRef++; }
      else if (how === 'check') { p.byCheck++; totals.byCheck++; }
      else { p.byAmount++; totals.byAmount++; }
    }
    // WHAT the document is, not just that one exists. A verification sample found
    // spreadsheets among the PDFs — "Sol's CC- 04.04.25.xlsx" is the right backup
    // for a consolidated credit-card bill, but it is not an invoice, and a
    // headline that says "54% have an invoice" when some of them are workbooks is
    // a number that falls apart the first time somebody clicks one on a call.
    const firstDoc = cardDoc ? null : (bill ? attachmentsOf(bill)[0] : null);
    if (firstDoc || cardDoc) {
      const f = firstDoc && firstDoc.File && typeof firstDoc.File === 'object' ? firstDoc.File : firstDoc;
      const ext = String((f && (f.Extension || '')) || '').toLowerCase().replace(/^\.?/, '.') || '(none)';
      const kind = ext === '.pdf' ? 'pdf'
        : /^\.(xlsx?|xlsm|csv)$/.test(ext) ? 'spreadsheet'
        : /^\.(jpe?g|png|gif|tiff?|heic)$/.test(ext) ? 'image'
        : /^\.(docx?|txt|rtf)$/.test(ext) ? 'document'
        : cardDoc ? 'card receipt' : ext;
      byKind[kind] = (byKind[kind] || 0) + 1;
      // Which CHARGES have one, not just how many. Without this the tab can only
      // find out by pressing the button on each of 28,261 rows — which is the
      // thing the sweep exists to avoid.
      if (c.id) documented.push(c.id + '|' + (kind === 'card receipt' ? 'card' : kind));
    }
    // Every charge the sweep RESOLVED, documented or not, with the record it
    // resolved to.
    //
    // This is what makes a click cheap and, more importantly, consistent. The
    // sweep searches every one of a vendor's bills across the whole window; the
    // per-charge lookup searches a fortnight either side of the posting. So the
    // sweep reached bills the click never looked at, and the tab found less than
    // the headline promised — the two disagreed, and the visible one was the
    // weaker. Writing the answer down means the click reads it back instead of
    // repeating a narrower search.
    if (c.id && (bill || cardDoc || c.txnType === 'CC CHG')) {
      const bid = bill ? pick(bill, ['BillID', 'BillId', 'ID', 'Id']) : null;
      resolved.push(`${c.id}|${cardDoc ? 'card' : (bill && attachmentsOf(bill).length ? 'doc' : 'none')}|${bid == null ? '' : bid}`);
    }
    if ((bill && attachmentsOf(bill).length) || cardDoc) {
      p.withDocument++; totals.withDocument++; p.amountWithDocument += c.amount || 0;
      v.withDocument++; v.amountWithDocument += c.amount || 0;
      mo.withDocument++; mo.amountWithDocument += c.amount || 0;
    } else if (bill) {
      // The bill is in Rent Manager and nobody attached the invoice. This is the
      // bucket no code can reach, and the one worth reporting to whoever files
      // them — so it is counted rather than lumped in with "not found".
      p.billNoDoc++; totals.billNoDoc++;
    }
    perProperty.set(pkey, p);
  }

  const rows = [...perProperty.values()].map(p => ({
    ...p,
    amount: Math.round(p.amount),
    amountWithDocument: Math.round(p.amountWithDocument),
    documentRate: p.charges ? Math.round((p.withDocument / p.charges) * 100) : 0,
    billRate: p.charges ? Math.round((p.withBill / p.charges) * 100) : 0,
  }));
  // Worst last: the tab and the eye both want the showable ones first.
  rows.sort((a, b) => b.documentRate - a.documentRate || b.charges - a.charges);

  // ── entity, then the properties inside it ─────────────────────────────────
  // The shape the tab asks for: entities first, each opening onto its own
  // properties. An entity's rate is computed from its own charges rather than
  // averaged from its properties' percentages — a 700-charge building and a
  // 20-charge one are not each worth half of an entity.
  const byEntity = [];
  const entityMap = new Map();
  for (const p of rows) {
    const key = p.entity || '(no entity)';
    let e = entityMap.get(key);
    if (!e) {
      e = { key, entity: key, charges: 0, amount: 0, withBill: 0, withDocument: 0, amountWithDocument: 0, properties: [] };
      entityMap.set(key, e);
      byEntity.push(e);
    }
    e.charges += p.charges; e.amount += p.amount;
    e.withBill += p.withBill; e.withDocument += p.withDocument;
    e.amountWithDocument += p.amountWithDocument;
    e.properties.push(p);
  }
  for (const e of byEntity) {
    e.documentRate = e.charges ? Math.round((e.withDocument / e.charges) * 100) : 0;
    e.billRate = e.charges ? Math.round((e.withBill / e.charges) * 100) : 0;
    e.properties.sort((a, b) => b.documentRate - a.documentRate || b.charges - a.charges);
  }
  byEntity.sort((a, b) => b.documentRate - a.documentRate || b.charges - a.charges);

  const rate = (row) => ({
    ...row,
    amount: Math.round(row.amount),
    amountWithDocument: Math.round(row.amountWithDocument),
    documentRate: row.charges ? Math.round((row.withDocument / row.charges) * 100) : 0,
    billRate: row.charges ? Math.round((row.withBill / row.charges) * 100) : 0,
  });
  // Vendors worth naming: enough charges that the rate means something. A vendor
  // with three postings at 100% is not a finding.
  const vendors = [...perVendorCov.values()].map(rate)
    .filter(v => v.charges >= 10)
    .sort((a, b) => b.documentRate - a.documentRate || b.amount - a.amount);
  const months = [...perMonth.values()].map(rate).sort((a, b) => String(a.key).localeCompare(String(b.key)));

  return {
    window: { from, to },
    byEntity,
    // The 54% split by what the file actually is.
    documentKinds: byKind,
    // "chargeId|kind" for every charge with something to open. Served separately
    // from the summary — it is a megabyte and the panel does not need it.
    documented,
    // chargeId|kind|billId for every charge the sweep placed. Server-side only —
    // the tab is served the documented list, which is a third of the size.
    resolved,
    byVendor: vendors,
    // Kept in the payload but no longer tabled on the tab — it is what the
    // "bills exist, scans do not" warning is computed from.
    byMonth: months,
    builtFrom: snap.refreshedAt || null,
    vendors: vendorIds.length,
    vendorsUnreadable: vendorError.size,
    vendorErrors: [...vendorError.entries()].slice(0, 20).map(([id, error]) => ({ vendorId: id, error })),
    // A read that FAILED is not a record with nothing on it. Being throttled
    // part-way through a sweep once produced "all 3,555 card charges are
    // undocumented", which is a confident statement about the books generated by
    // our own request rate. The failures travel with the answer.
    readErrors,
    detailIndexFailed: detailFailed,
    checksUnreadable: [...checkDetails.values()].filter(v => v === null).length,
    cardsUnreadable: [...cardDocs.values()].filter(v => v === null).length,
    bills: byRef.size,
    billsWithDocuments: billsWithDocs.length,
    billDetailLinesIndexed: billByDetailId.size,
    checksRead: checkIds.length,
    cardTransactionsRead: cardIds.length,
    totals: {
      ...totals,
      documentRate: totals.charges ? Math.round((totals.withDocument / totals.charges) * 100) : 0,
      billRate: totals.charges ? Math.round((totals.withBill / totals.charges) * 100) : 0,
    },
    properties: rows,
  };
}

const cache = makeSnapshotCache({
  name: 'backup coverage',
  file: 'backup-coverage-cache.json',
  build: () => build(),
});

module.exports = { build, refresh: cache.refresh, status: cache.status, getFresh: cache.getFresh };
