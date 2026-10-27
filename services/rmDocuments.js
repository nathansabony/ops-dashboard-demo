// Backup documents for a single renovation charge — the fourth and last level of
// the drill-down, and the only one whose availability is genuinely unknown.
//
// The brief is explicit about this: the stakeholder demoed the hierarchy in the
// CLASSIC Rent Manager UI (charge → attached invoice PDF → payment record → credit
// card statement charge when it was paid on a card), and the open question is
// whether the WAPI12 REST API this site is connected to exposes the same thing or
// only Express-style data. "If the classic-version detail isn't available via API,
// flag it — may need a fallback/manual-link approach for that piece."
//
// So this file is written to answer that question at runtime rather than assume it:
//
//   1. It PROBES the document-side resources once and remembers what came back.
//      A resource that 404s is recorded as unavailable, not retried per charge.
//   2. For a charge it walks whichever of those resources actually exist —
//      bill → bill attachments → payment → credit card statement charge — and
//      returns what it found.
//   3. When a level isn't reachable it says so in `unavailable` and returns a
//      `manualLookup` block: the exact fields to type into Rent Manager to find
//      the document by hand. That is the flagged fallback, and it is deliberately
//      a set of facts rather than a fabricated deep link — the classic client is a
//      desktop app and inventing a URL for it would just waste her click.
//
// The result of the probe is also what /api/renovations/capabilities serves, so
// the answer to the open item is on screen instead of in someone's notes.

const rentManager = require('./rentManagerClient');

// ── Capability probe ────────────────────────────────────────────────────────
// One cheap paged request per resource. We care about three outcomes: it exists
// and returned rows, it exists and is empty, or it isn't there. Cached for the
// life of the process (plus a TTL so a permission change eventually shows up) —
// an API's resource list does not change between two clicks.
const PROBE_TTL_MS = 6 * 60 * 60 * 1000;
let _probe = null;

// Ordered by what we would rather use. Names follow RM's documented resource
// convention (collection resources match entity names); the ones that don't exist
// on this instance simply fall out of the list at probe time.
const DOCUMENT_RESOURCES = [
  { key: 'bills',        path: '/Bills',              role: 'the AP bill behind a GL posting',
    probeParams: () => { const w = probeWindow(); return { filters: `TransactionDate,ge,${w.from};TransactionDate,le,${w.to}`, pageSize: 1 }; } },
  { key: 'billDetails',  path: '/BillDetails',        role: 'the bill worksheet — GL distribution lines' },
  // The document store is the open question (see scripts/probeAttachments.js), and
  // it is the one thing here nobody can answer from the outside — Rent Manager's
  // own client shows the scan, so the file exists; whether THIS API exposes it,
  // under which name, is what these probe. Naming a candidate here costs one cheap
  // request per refresh and is the difference between "attachments do not work"
  // and knowing which resource to ask support about.
  { key: 'attachments',  path: '/Attachments',        role: 'attached invoice PDFs / scans' },
  { key: 'files',        path: '/Files',              role: 'alternate attachment store' },
  { key: 'documents',    path: '/Documents',          role: 'document store (another name RM uses)' },
  { key: 'images',       path: '/Images',             role: 'scanned images / invoice captures' },
  { key: 'checks',       path: '/Checks',             role: 'check / EFT payment detail' },
  // The link from a bill to the money that settled it. It is on the LINES, not on
  // the headers: a check's CheckDetails name the BillDetailIDs they paid. Asking
  // /Checks or /Payments for a BillID — which is what this used to do — filters on
  // a field neither of them has.
  { key: 'checkDetails', path: '/CheckDetails',       role: 'which bill lines a check settled' },
  // Which ACCOUNT the check was drawn on. A check row carries only a BankID, so
  // without one of these the payment record can say a check cleared and not say
  // where from — which is the one thing somebody looking a check up at the bank
  // actually needs. /BankAccounts has always been a 404 here; /Banks is the other
  // name Rent Manager uses, and probing both is what turns "the row is blank" into
  // a permission to ask for.
  { key: 'bankAccounts', path: '/BankAccounts',      role: 'the bank account a check was drawn on' },
  { key: 'banks',        path: '/Banks',             role: 'the same directory under RM\'s other name' },
  // The credit side. Built originally on /BankAccounts and /BankTransactions,
  // both 404 here, so it never once ran and the failure read as "no card
  // involved". These are the names that do answer.
  { key: 'creditCards',            path: '/CreditCards',            role: 'the cards themselves' },
  { key: 'creditCardTransactions', path: '/CreditCardTransactions', role: 'card charges, receipts, and the statement line' },
  { key: 'vendors',      path: '/Vendors',            role: 'vendor names on bills' },
];

async function probeResource(res) {
  // Some WAPI resources refuse a bare list request and demand a filter (a bill
  // ledger is not something the server will page through for you). A 400 on the
  // unfiltered call is therefore not evidence the resource is missing, so each
  // probe gets a filtered second attempt before it is written off. Getting this
  // wrong would have been expensive: a false "no /Bills here" turns off the entire
  // invoice path for every charge on the tab.
  const attempts = [{ pageSize: 1 }, ...(res.probeParams ? [res.probeParams()] : [])];
  let lastErr = null;
  for (const params of attempts) {
    try {
      const body = await rentManager.get(res.path, params);
      const rows = Array.isArray(body) ? body : (body && (body.Results || body.Items || body.Data)) || [];
      return {
        ...res,
        available: true,
        sampleRows: Array.isArray(rows) ? rows.length : 0,
        // The field list is the useful part of the probe: it tells us (and the
        // person reading the capabilities panel) whether the row shape carries
        // what the drill-down needs — a ParentType, a unit, an attachment id.
        fields: Array.isArray(rows) && rows.length && typeof rows[0] === 'object' ? Object.keys(rows[0]).sort() : [],
      };
    } catch (err) {
      lastErr = err;
    }
  }
  const status = /\((\d{3})\)/.exec(lastErr ? lastErr.message : '');
  return {
    ...res,
    available: false,
    status: status ? Number(status[1]) : null,
    error: lastErr ? lastErr.message.slice(0, 300) : 'no response',
  };
}

// A date window recent enough to have rows but narrow enough to be cheap.
function probeWindow() {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - 1, 1);
  const iso = d => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

async function capabilities({ force = false } = {}) {
  if (_probe && !force && Date.now() - _probe.at < PROBE_TTL_MS) return _probe.payload;

  // Sequential, not parallel: Rent Manager caps concurrent sessions and this is a
  // background curiosity, not something a person is waiting on.
  const resources = [];
  for (const res of DOCUMENT_RESOURCES) resources.push(await probeResource(res));

  // The route that actually works here is not a resource at all, so probing
  // resource names can never find it: attachments ride on the bill as an embed.
  // Without this check the verdict reads "attached documents are not exposed by
  // this API" on an instance that just handed us a 288 KB PDF — the tab would be
  // telling the person to go open Rent Manager for a file it can fetch.
  resources.push(await probeBillAttachmentEmbed());

  const available = new Set(resources.filter(r => r.available).map(r => r.key));
  const payload = {
    probedAt: new Date().toISOString(),
    resources,
    // The plain-English answer to the brief's first open item.
    verdict: verdictFor(available),
  };
  _probe = { at: Date.now(), payload };
  return payload;
}

// Can a bill hand back its own attachments? One bill, one embed. An empty
// Attachments array still proves the embed is supported — which is the question —
// so the check is whether the FIELD comes back, not whether that bill has a scan.
async function probeBillAttachmentEmbed() {
  const out = { key: 'billAttachments', path: '/Bills/{id}?embeds=Attachments',
    role: 'invoice PDFs, reached through the bill (the route that works here)' };
  try {
    const bills = asRows(await rentManager.get('/Bills', { pageSize: 1 }));
    if (!bills.length) return { ...out, available: false, note: 'no bill to test against' };
    const id = pick(bills[0], ['BillID', 'BillId', 'ID', 'Id']);
    if (id == null) return { ...out, available: false, note: 'bill row carries no id' };
    const payload = await rentManager.get(`/Bills/${encodeURIComponent(id)}`, { embeds: 'Attachments' });
    const row = oneRow(payload);
    const ok = !!(row && Array.isArray(row.Attachments));
    return { ...out, available: ok, count: ok ? row.Attachments.length : null };
  } catch (err) {
    return { ...out, available: false, error: String(err && err.message ? err.message : err).slice(0, 200) };
  }
}

function verdictFor(available) {
  const hasBills = available.has('bills');
  const hasDocs = available.has('billAttachments') || available.has('attachments')
    || available.has('files') || available.has('documents') || available.has('images');
  const hasPay = available.has('checks') && available.has('checkDetails');

  if (hasBills && hasDocs && hasPay) {
    return {
      level: 'full',
      text: 'Bills, attachments and payment records are all reachable through the API — the same hierarchy as the classic Rent Manager client.',
    };
  }
  if (hasBills && hasDocs) {
    return {
      level: 'partial',
      text: 'Bills and attachments are reachable, but the payment record is not — credit card statement backup has to be pulled by hand in Rent Manager.',
    };
  }
  if (hasBills) {
    return {
      level: 'partial',
      text: 'The bill behind a charge is reachable, but attached documents are not exposed by this API. Every charge still shows exactly what to open in Rent Manager.',
    };
  }
  return {
    level: 'none',
    text: 'This Rent Manager API does not expose the document/attachment hierarchy from the classic client. The tab gives the full charge-level breakdown and, for each charge, the exact fields to look up the backup manually.',
  };
}

// ── Bill lookup ─────────────────────────────────────────────────────────────
// A GL posting and an AP bill are two views of the same event, but the GL report
// doesn't hand us a bill id. We match instead: same property, same day (± a small
// window, because RM posts a bill's GL entry on the bill date but a correction can
// land a day either side), same amount. A reference or vendor match on top of that
// raises confidence from 'amount+date' to 'exact'.
// The window is ASYMMETRIC (2026-08-25). An invoice is dated when the vendor wrote
// it and posted when AP got to it, so a bill's date is almost always at or BEFORE
// the GL posting date, sometimes by a week or two, and hardly ever after it. The
// old symmetric ±3 spent half its width on dates that barely happen and stopped
// short exactly where the misses are.
const BILL_DATE_SLACK_BEFORE = 14;
const BILL_DATE_SLACK_AFTER = 3;

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.Results || payload.Items || payload.Data || [];
}

// A request for ONE record — /Bills/700, /Checks/158563 — comes back as the
// record itself, not as a list containing it, so asRows finds nothing in it and
// hands back []. That has now cost two separate features: the bill embed that
// carries the invoice, and the bill-to-check link that carries the payment. Both
// looked like "Rent Manager has nothing" and both were this.
//
// So the unwrapping lives in one place. Anything fetching a single record by id
// goes through here.
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

// The one RM figure parser (services/rmAmount.js). The local one this replaced
// stripped accounting parentheses without applying the sign, so a credit memo of
// (250.00) matched a bill of +250.00.
const { parseAmount: money } = require('./rmAmount');
const backupIndex = require('./backupIndex');

async function findBill(charge) {
  const from = shiftDate(charge.date, -BILL_DATE_SLACK_BEFORE);
  const to = shiftDate(charge.date, BILL_DATE_SLACK_AFTER);
  const target = Math.abs(charge.amount);
  const ref = String(charge.reference || '').trim().toUpperCase();
  const vendor = String(charge.vendor || '').trim().toUpperCase();

  // Filter shapes differ across WAPI resources, so try the narrow one first and
  // fall back to the date window alone rather than giving up on a rejected filter.
  // Ask for the attachments ALONGSIDE the bill first. The live probe found that
  // this Rent Manager exposes /Bills but not /Attachments as a standalone
  // resource — and an embed is a different code path from a resource, so files
  // that cannot be listed on their own may still ride along on the bill. Worth one
  // attempt before falling back to a bill with no documents on it.
  //
  // THE COLUMN IS TransactionDate (confirmed live, 2026-08-26). A bill row here is
  //   ID, AccountID, Reference, Amount, TransactionDate, PostDate, DueDate, …
  // — there is no BillDate on it, and filtering by a column that does not exist is
  // a 400, not an empty result. Every attempt in this list used to name BillDate
  // or Date, so every attempt was refused, so findBill returned a 400 for every
  // charge on the tab and no bill was ever matched — which is the real reason no
  // invoice ever appeared, upstream of anything to do with attachments.
  //
  // TransactionDate leads now; the old names stay behind it because another RM
  // build may well use them, and the cost of a rejected filter is one request.
  //
  // ONE BAD EMBED NAME REJECTS THE WHOLE REQUEST, so the embeds degrade one at a
  // time rather than all at once. `Vendor` has never been confirmed on this
  // instance; `BillDetails` and `Attachments` both have. Bundling the unverified
  // name with the two that matter meant a single rejection dropped the lookup all
  // the way to a bare query — no BillDetails, so the split-invoice rung had
  // nothing to match on, and no Attachments, so the invoice never came along.
  // A bill's TOTAL rarely equals one GL line, so losing BillDetails loses most
  // matches on a renovation ledger.
  const dated = (col) => `${col},ge,${from};${col},le,${to}`;

  // ── what the CHECK says it paid ───────────────────────────────────────────
  // Asked first, because it is the only rung that is a lookup rather than a
  // guess: Rent Manager tells us which bill lines this check settled, so the
  // candidate set is "the bills containing one of those lines" instead of "every
  // bill this vendor billed near this date". It also reaches the ~11,000
  // postings whose description never named an invoice number at all.
  // Fetched lazily, below, only when the invoice number has not already found the
  // bill. Asking for it up front cost a round trip on every charge — including
  // the ~48% that carry an invoice number and resolve in one query — and on a
  // tab where somebody is clicking through charges live, that is the difference
  // between an answer and a wait.
  let lines = null;
  let wantedDetailIds = new Set();

  // ── ask for the bill we want, not for a fortnight of bills ─────────────────
  // The window alone returns 200 bills on this portfolio — the page cap — over
  // seventeen days, so the bill we are after may not even be in the page we get.
  // Both of the things that actually identify a posting are filterable, so use
  // them first and let the window be the fallback it was meant to be.
  //
  // A reference like "AV5475" is the invoice number and is worth a direct hit; a
  // reference like ACH, WIRE or EFT is a payment METHOD written in the reference
  // field and matches half the ledger, so those are skipped rather than trusted.
  const PAYMENT_WORDS = /^(ACH|WIRE|EFT|CHECK|CHK|CC|CARD|ONLINE|AUTO|BILLPAY|TRANSFER)$/i;
  const targeted = [];

  // ── vendor + invoice number: the pair that names one bill ─────────────────
  // A renovation posting on this portfolio is a CHECK ITEM, not a bill, so there
  // was never a bill with its reference or its amount to find — hence a fortnight
  // of 200 bills and nothing matching in it. But the GL row carries the vendor
  // (CustomerID, which a check confirms as AccountType "Vendor") and RM writes
  // the vendor's invoice number into the description: "Tubs Refinishing Services
  // Inc.: 100134" is bill Reference 100134.
  //
  // Filtering bills by that vendor turns 200 rows into a handful of their
  // invoices — and on the live check, twelve of the first twenty-five carried a
  // document. Adding the reference picks out one.
  const vendorId = charge.vendorId != null ? String(charge.vendorId) : null;
  const invoiceNo = String(charge.invoiceNo || '').trim();
  if (vendorId && invoiceNo) {
    targeted.push({ filters: `AccountID,eq,${vendorId};Reference,eq,${invoiceNo}`, embeds: 'Attachments', pageSize: 25 });
  }
  if (invoiceNo) {
    targeted.push({ filters: `Reference,eq,${invoiceNo}`, embeds: 'Attachments', pageSize: 25 });
  }
  if (vendorId) {
    // The vendor's invoices around the posting. Small enough that line detail is
    // worth fetching, which is what lets the split-invoice rung work at all.
    targeted.push({ filters: `AccountID,eq,${vendorId};${dated('TransactionDate')}`, embeds: 'Attachments', pageSize: 25 });
    targeted.push({ filters: `AccountID,eq,${vendorId};TransactionDate,ge,${shiftDate(charge.date, -120)};TransactionDate,le,${to}`, embeds: 'Attachments', pageSize: 25 });
  }
  if (ref && !PAYMENT_WORDS.test(ref) && ref.length >= 3) {
    targeted.push({ filters: `Reference,eq,${ref};${dated('TransactionDate')}`, pageSize: 50 });
    targeted.push({ filters: `Reference,eq,${ref}`, pageSize: 50 });
  }
  if (Number.isFinite(target) && target > 0) {
    // Both spellings: RM's filter comparison is not documented as to type, and
    // "2445" and "2445.00" are not the same string.
    targeted.push({ filters: `Amount,eq,${target.toFixed(2)};${dated('TransactionDate')}`, pageSize: 50 });
    targeted.push({ filters: `Amount,eq,${target};${dated('TransactionDate')}`, pageSize: 50 });
  }

  const attempts = [
    { filters: dated('TransactionDate'), embeds: 'BillDetails,Attachments,Vendor', pageSize: 200 },
    { filters: dated('TransactionDate'), embeds: 'BillDetails,Attachments', pageSize: 200 },
    { filters: dated('TransactionDate'), embeds: 'BillDetails', pageSize: 200 },
    { filters: dated('TransactionDate'), embeds: 'Attachments', pageSize: 200 },
    { filters: dated('TransactionDate'), pageSize: 200 },
    { filters: dated('PostDate'), embeds: 'BillDetails,Attachments', pageSize: 200 },
    { filters: dated('BillDate'), embeds: 'BillDetails,Attachments,Vendor', pageSize: 200 },
    // 2026-08-26: same request, other names for the same collection. An embed RM
    // does not recognise is rejected outright, so these cost nothing once one of
    // them works — and if one DOES work, the invoice arrives with the bill.
    { filters: dated('BillDate'), embeds: 'BillDetails,Documents,Vendor', pageSize: 200 },
    { filters: dated('BillDate'), embeds: 'BillDetails,Files,Vendor', pageSize: 200 },
    { filters: dated('BillDate'), embeds: 'BillDetails,Images,Vendor', pageSize: 200 },
    { filters: dated('BillDate'), embeds: 'BillDetails,Vendor', pageSize: 200 },
    { filters: dated('Date'), embeds: 'BillDetails', pageSize: 200 },
    { filters: dated('BillDate'), pageSize: 200 },
  ];

  let rows = null;
  let lastError = null;
  let used = null;
  // Every attempt and what it answered. Which filter and which embed this Rent
  // Manager will accept is not documented and differs between resources, so the
  // only way to know is to ask — and the only way to fix a miss without another
  // deploy is for the miss to say what it asked.
  const tried = [];
  for (const params of [...targeted, ...attempts]) {
    const note = { filters: params.filters, embeds: params.embeds || null };
    try {
      const got = asRows(await rentManager.get('/Bills', params));
      lastError = null;
      note.rows = got.length;
      tried.push(note);
      // A targeted filter that is ACCEPTED but finds nothing is not the answer —
      // the reference may be recorded differently, or the amount may be one line
      // of a larger bill. Only a query that actually returns bills ends the
      // search; otherwise fall through to the window scan.
      if (!got.length) continue;
      rows = got;
      used = params;
      break;
    } catch (err) {
      rows = null;   // the filter shape was rejected — try the next one
      lastError = err;
      const m = /\((\d{3})\)/.exec(String(err && err.message) || '');
      note.status = m ? Number(m[1]) : null;
      note.error = String(err && err.message ? err.message : err).slice(0, 160);
      tried.push(note);
    }
  }
  // Two very different failures used to return the same `null`: "there are no
  // bills in this window" and "every request for bills was REFUSED". The second is
  // the one worth an email to Rent Manager support, and it was invisible — the
  // charge just said no bill matched. The error now travels with the answer.
  if (lastError) {
    const status = /\((\d{3})\)/.exec(lastError.message || '');
    return { row: null, error: { status: status ? Number(status[1]) : null, message: String(lastError.message || '').slice(0, 300) } };
  }
  // The cheap answer first: a bill whose reference IS the invoice number written
  // into this posting's description. One comparison over rows we already have, no
  // further requests. When it hits — most of the time — everything below is
  // skipped.
  const refHit = invoiceNo
    ? (rows || []).find((b) => {
        const bRef = String(pick(b, ['Reference', 'InvoiceNumber', 'BillNumber', 'ReferenceNumber']) || '').trim();
        const bAcct = String(pick(b, ['AccountID', 'AccountId']) ?? '');
        return bRef && bRef.toUpperCase() === invoiceNo.toUpperCase()
          && (!vendorId || !bAcct || bAcct === vendorId);
      })
    : null;

  if (!refHit) {
    lines = await checkLines(charge);
    wantedDetailIds = new Set((lines && lines.billDetailIds) || []);
  }

  // ── line detail has to be fetched per bill ────────────────────────────────
  // embeds=BillDetails is accepted on ONE bill (/Bills/{id}?embeds=…) and refused
  // on a filtered LIST, which is why every windowed lookup came back with zero
  // bills carrying line detail and the split-invoice rung never once fired. When
  // the candidate set is small enough to be worth it, each bill is asked for its
  // own lines so that rung has something to match on; a 200-row window is not,
  // and falls back to matching on totals with the winner hydrated afterwards.
  // Raised when the check has told us which detail lines to look for: those
  // requests are no longer speculative, they are the difference between finding
  // the invoice and not.
  const HYDRATE_MAX = wantedDetailIds.size ? 25 : 12;
  if (!refHit && rows && rows.length && rows.length <= HYDRATE_MAX && !rows.some(r => Array.isArray(r.BillDetails))) {
    rows = await Promise.all(rows.map(async (r) => {
      const id = pick(r, ['BillID', 'BillId', 'ID', 'Id']);
      if (id == null) return r;
      const full = await billById(id);
      return full ? { ...r, ...full } : r;
    }));
  }

  // What the window actually held, when nothing in it matched. "No bill matched"
  // is unfalsifiable on its own; five real rows next to the posting make the
  // reason obvious — a reference recorded differently, a total that is the whole
  // invoice rather than this line, a vendor spelled another way.
  const sample = (rows || []).slice(0, 5).map(r => ({
    id: pick(r, ['BillID', 'BillId', 'ID', 'Id']),
    reference: pick(r, ['Reference', 'InvoiceNumber', 'BillNumber', 'ReferenceNumber']),
    amount: pick(r, ['Amount', 'TotalAmount', 'BillAmount', 'Total']),
    date: String(pick(r, ['TransactionDate', 'BillDate', 'Date', 'PostDate']) || '').slice(0, 10),
    vendor: pick(r, ['VendorName', 'Name', 'PayeeName']),
    fields: Object.keys(r),
  }));
  const searched = { tried, sample, from, to, rows: rows ? rows.length : 0,
    checkLines: lines ? { checkId: lines.checkId, lines: lines.total, mine: lines.mine } : null,
    filters: used ? used.filters : null, embeds: used ? (used.embeds || null) : null,
    withDetails: rows ? rows.filter(r => Array.isArray(r.BillDetails) && r.BillDetails.length).length : 0 };
  if (!rows || !rows.length) return { row: null, searched };

  const dayGap = b => {
    const d = String(pick(b, ['TransactionDate', 'BillDate', 'Date', 'PostDate']) || '').slice(0, 10);
    if (!d) return 999;
    return Math.abs((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${charge.date}T00:00:00Z`)) / 86400000);
  };

  // ── how a bill is matched, and why the total is not enough ─────────────────
  // A GL posting is ONE LINE of a bill. An invoice from a GC covering three units,
  // or one carrying both labour and materials, posts several GL lines and its
  // TOTAL matches none of them — so matching only on the bill total misses every
  // split invoice, which on a renovation ledger is most of the interesting ones.
  // That is the "No AP bill match" people were hitting on charges whose invoice
  // was sitting in Rent Manager the whole time.
  //
  // Ranked, best first. A weaker rung is only ever reached when the stronger ones
  // found nothing, so nothing that matched before can match differently now:
  //   exact       — bill total matches AND the reference or vendor agrees
  //   amount+date — bill total matches, inside the date window
  //   bill-line   — a LINE of the bill matches (the split-invoice case), with the
  //                 GL account agreeing when the worksheet names one
  const RANK = { exact: 3, 'amount+date': 2, 'bill-line': 1 };
  let best = null;
  const consider = (row, confidence, extra) => {
    const candidate = { row, confidence, ...(extra || {}) };
    if (!best) { best = candidate; return; }
    const better = RANK[confidence] - RANK[best.confidence];
    // Same rung → the bill closest to the posting date wins. Two bills for the
    // same amount in the same fortnight is not a hypothetical on a portfolio that
    // pays the same vendor monthly.
    if (better > 0 || (better === 0 && dayGap(row) < dayGap(best.row))) best = candidate;
  };

  // A bill that contains one of the check's own detail lines IS the bill — the
  // strongest identification available, and it does not care whether the amounts
  // agree, since a check line is one slice of an invoice.
  if (wantedDetailIds.size) {
    for (const b of rows) {
      const det = Array.isArray(b.BillDetails) ? b.BillDetails : [];
      const hit = det.find(d => wantedDetailIds.has(String(pick(d, ['BillDetailID', 'BillDetailId']))));
      if (hit) { consider(b, 'exact', { by: 'check line' }); break; }
    }
  }

  // A bill's header often carries no property at all — it is on the LINES. So a
  // bill whose lines are all for other buildings must be ruled out here, or the
  // amount rung will happily match one on nothing more than a matching total and
  // the same date. That is how another building's invoice ends up on this charge.
  const linesDisagree = (b) => {
    const det = Array.isArray(b.BillDetails) ? b.BillDetails : [];
    if (!det.length || charge.propertyId == null) return false;
    const withProp = det.filter(d => pick(d, ['PropertyID', 'PropertyId']) != null);
    if (!withProp.length) return false;
    return !withProp.some(d => String(pick(d, ['PropertyID', 'PropertyId'])) === String(charge.propertyId));
  };

  for (const b of rows) {
    if (linesDisagree(b)) continue;
    // The invoice number RM wrote into the posting's description, matched against
    // the bill's own Reference. This rung does NOT require the amounts to agree,
    // and that is the point: the posting is one GL line of an invoice that may
    // cover several units or both labour and materials, so its total routinely
    // differs. Vendor plus invoice number already names one bill; insisting on
    // the amount as well would throw away the identification we just made.
    const bReference = String(pick(b, ['Reference', 'InvoiceNumber', 'BillNumber', 'ReferenceNumber']) || '').trim();
    const bAccount = String(pick(b, ['AccountID', 'AccountId']) ?? '');
    if (invoiceNo && bReference && bReference.toUpperCase() === invoiceNo.toUpperCase()
      && (!vendorId || !bAccount || bAccount === vendorId)) {
      consider(b, 'exact', { by: 'vendor+invoice' });
      continue;
    }

    const bProp = Number(pick(b, ['PropertyID', 'PropertyId']) ?? NaN);
    const propertyDisagrees = Number.isFinite(bProp) && charge.propertyId != null && bProp !== Number(charge.propertyId);

    const bRef = String(pick(b, ['Reference', 'InvoiceNumber', 'BillNumber', 'ReferenceNumber']) || '').trim().toUpperCase();
    const bVendor = String(pick(b, ['VendorName', 'Name', 'PayeeName']) || '').trim().toUpperCase();
    const identified = (ref && bRef && ref === bRef) || (vendor && bVendor && vendor === bVendor);

    const amount = Math.abs(money(pick(b, ['Amount', 'TotalAmount', 'BillAmount', 'Total'])));
    if (!propertyDisagrees && Math.abs(amount - target) <= 0.01) {
      consider(b, identified ? 'exact' : 'amount+date');
      continue;
    }

    // The split-invoice rung. A bill whose PROPERTY field disagrees is still
    // eligible here: on a multi-property invoice the header carries one property
    // and the lines carry the rest, which is the whole reason the line is what
    // gets posted.
    const details = b.BillDetails || b.Details || b.LineItems;
    if (!Array.isArray(details) || !details.length) continue;
    const line = details.find(d => {
      if (Math.abs(Math.abs(money(pick(d, ['Amount', 'LineAmount', 'Total']))) - target) > 0.01) return false;
      const dAcct = pick(d, ['GLAccountID', 'GLAccountId', 'AccountID']);
      if (dAcct != null && charge.accountId != null && String(dAcct) !== String(charge.accountId)) return false;
      const dProp = Number(pick(d, ['PropertyID', 'PropertyId']) ?? NaN);
      if (Number.isFinite(dProp) && charge.propertyId != null && dProp !== Number(charge.propertyId)) return false;
      return true;
    });
    if (line) consider(b, 'bill-line', { line });
  }
  if (best && !Array.isArray(best.row.Attachments)) {
    const id = pick(best.row, ['BillID', 'BillId', 'ID', 'Id']);
    const full = id == null ? null : await billById(id);
    if (full) best = { ...best, row: { ...best.row, ...full } };
  }
  return best ? { ...best, searched } : { row: null, searched };
}

// One bill, with the things a list request will not carry. Never throws: a bill we
// cannot enrich is still a bill we matched.
function sameBill(row, id) {
  const got = pick(row, ['BillID', 'BillId', 'ID', 'Id']);
  return got != null && String(got) === String(id);
}

async function billById(id) {
  for (const embeds of ['BillDetails,Attachments', 'BillDetails', 'Attachments']) {
    try {
      const row = oneRow(await rentManager.get(`/Bills/${encodeURIComponent(id)}`, { embeds }));
      // Only accept a row that IS the bill we asked for. A build that ignores the
      // id and answers with a list would otherwise merge a different bill's lines
      // and attachments over the one we matched — the wrong invoice on the right
      // charge, which is worse than no invoice.
      if (row && sameBill(row, id)) return row;
    } catch (err) {
      // this embed combination is not supported here — try a narrower one
    }
  }
  return null;
}

// ── A credit card charge is not a bill ──────────────────────────────────────
// 3,555 renovation postings are card charges (TransactionType "CC CHG"), and no
// amount of looking through /Bills will ever find them: there is no bill. The
// receipt hangs off the card transaction itself.
//
// /CreditCardCharges, /CardCharges and /CardTransactions are all 404 here;
// /CreditCardTransactions answers, takes an Attachments embed, and the id the GL
// report puts in its Hyperlink IS that resource's id — checked against the record
// it returns rather than assumed, because an id that means something else would
// quietly attach another vendor's receipt to this charge.
// ── One read per card transaction (2026-10-16) ──────────────────────────────
// Rent Manager takes 8–14s to answer /CreditCardTransactions/{id}, and a card
// charge's backup used to ask twice (receipts here, card details in
// creditCardCharge) — about 40s a charge, so a month of hardware-store swipes
// took minutes to fill. Each transaction is now read once and the answer kept,
// and prefetchCardTransactions() reads a whole month's in ONE filtered request
// (22 transactions in ~13s, measured live). A batch row only stands in for the
// single read when it carries its Attachments; otherwise that id falls back to
// the single read, so a list that ignores the embed can never hide a receipt.
const CARD_TXN_TTL_MS = 10 * 60 * 1000;
const _cardTxn = new Map();   // id → { at, promise }
function cardTxnFresh(id) {
  const e = _cardTxn.get(String(id));
  return e && Date.now() - e.at < CARD_TXN_TTL_MS ? e : null;
}
function cardTxnSingle(id) {
  return rentManager.get(`/CreditCardTransactions/${encodeURIComponent(id)}`, { embeds: 'Attachments' }).then(oneRow);
}
function cardTxn(id) {
  const hit = cardTxnFresh(id);
  if (hit) return hit.promise;
  const entry = { at: Date.now() };
  entry.promise = cardTxnSingle(id).catch(err => { _cardTxn.delete(String(id)); throw err; });
  _cardTxn.set(String(id), entry);
  return entry.promise;
}
function prefetchCardTransactions(ids) {
  const want = [...new Set((ids || []).filter(v => v != null && /^\d+$/.test(String(v))).map(String))].filter(id => !cardTxnFresh(id));
  for (let i = 0; i < want.length; i += 50) {
    const chunk = want.slice(i, i + 50);
    const batch = rentManager.get('/CreditCardTransactions', { filters: `ID,in,(${chunk.join(',')})`, embeds: 'Attachments', pageSize: 100 })
      .then(asRows, () => []);
    for (const id of chunk) {
      const entry = { at: Date.now() };
      entry.promise = batch.then(rows => {
        const row = rows.find(r => String(pick(r, ['ID', 'Id', 'CreditCardTransactionID'])) === id);
        return row && Array.isArray(row.Attachments) ? row : cardTxnSingle(id);
      }).catch(err => { _cardTxn.delete(id); throw err; });
      _cardTxn.set(id, entry);
    }
  }
  return want.length;
}

async function cardChargeAttachments(charge) {
  const id = charge && charge.txnId;
  if (id == null) return { list: [], tried: false };
  let lastErr = null;
  for (const res of ['CreditCardTransactions', 'CreditCardCharges']) {
    try {
      const row = res === 'CreditCardTransactions'
        ? await cardTxn(id)
        : oneRow(await rentManager.get(`/${res}/${encodeURIComponent(id)}`, { embeds: 'Attachments' }));
      if (!row) continue;
      const rid = pick(row, ['ID', 'Id', 'CreditCardTransactionID']);
      // The record has to BE the one we asked for.
      if (rid != null && String(rid) !== String(id)) continue;
      const list = Array.isArray(row.Attachments) ? row.Attachments : [];
      return { list: list.map(normalizeAttachment), tried: true, resource: res, record: rid };
    } catch (err) {
      lastErr = err;
      // try the next name
    }
  }
  // "Could not read the transaction" and "the transaction has no receipt" look
  // identical from the outside and mean opposite things.
  return { list: [], tried: true, error: lastErr ? String(lastErr.message || lastErr).slice(0, 200) : null };
}

// ── From a check item to the bill it paid ───────────────────────────────────
// About 11,000 postings are check items whose description names no invoice
// number — "Cabinets Refinish" rather than "100134" — so there is nothing to look
// the bill up by. Those were written off as needing a data-entry habit change.
// They do not: Rent Manager will say which bills a check paid.
//
//   /CheckDetails?filters=CheckID,eq,{checkId}   ->  lines carrying BillDetailID
//
// The last hop is the awkward one. /BillDetails/{id} is a 404 and no filter
// reaches it, so a BillDetailID cannot be resolved forwards. It can be matched
// backwards: a bill lists its own detail lines through an embed, each carrying
// BillDetailID, so a candidate bill either contains one of the check's lines or
// it does not. That turns "which bill is this" into a lookup instead of a guess.
async function checkLines(charge) {
  const id = charge && charge.txnId;
  if (id == null) return null;
  try {
    const rows = asRows(await rentManager.get('/CheckDetails', { filters: `CheckID,eq,${id}`, pageSize: 200 }));
    if (!rows.length) return null;
    // Narrow to the lines that could be THIS posting: same property and same GL
    // account. A check paying eleven lines across four buildings would otherwise
    // put any of them against this charge.
    const mine = rows.filter(r => {
      const p = pick(r, ['PropertyID', 'PropertyId']);
      const g = pick(r, ['GLAccountID', 'GLAccountId']);
      if (p != null && charge.propertyId != null && String(p) !== String(charge.propertyId)) return false;
      if (g != null && charge.accountId != null && String(g) !== String(charge.accountId)) return false;
      return true;
    });
    // Same rule as the sweep: if the lines carry a property and none of them is
    // this posting's, the charge is not on this check — do not fall back to
    // somebody else's line and call it a match.
    const narrowable = rows.some(r => pick(r, ['PropertyID', 'PropertyId']) != null
      || pick(r, ['GLAccountID', 'GLAccountId']) != null);
    if (!mine.length && narrowable) return null;
    const use = mine.length ? mine : rows;
    return {
      checkId: id,
      total: rows.length,
      mine: mine.length,
      billDetailIds: use.map(r => pick(r, ['BillDetailID', 'BillDetailId'])).filter(v => v != null).map(String),
      // The line's own amount is a better key than the GL posting when they differ.
      amounts: use.map(r => Math.abs(money(pick(r, ['Amount'])))).filter(a => a > 0),
    };
  } catch (err) {
    return null;
  }
}

// ── Attachments ─────────────────────────────────────────────────────────────
// RM's attachment store is keyed by a parent record. Which field names it uses for
// that varies, so we try the plausible shapes and remember the one that worked —
// after the first success no charge pays for the guessing again.
let _attachmentShape = undefined;   // undefined = untried, null = none work

const ATTACHMENT_SHAPES = [
  // The shape that works on this instance, confirmed against the live API
  // 2026-08-26: a bill's attachments come back as an EMBED on the bill, not from a
  // store of their own. /Attachments, /Files, /Documents and /Images all 404 here
  // — attachments are not a resource, they hang off the record they belong to —
  // which is why every filter shape below this line came up empty for six runs.
  //
  //   GET /Bills/2?embeds=Attachments
  //   -> [{ FileID, Name, Description, IsDepotUsed, Path, Extension, Token,
  //         CreateDate, …, DownloadURL }]
  //
  // It is first because it is the answer; the rest stay because a different RM
  // build may well answer them, and the first success is remembered either way.
  (type, id) => ({ path: `/${type}s/${encodeURIComponent(id)}`, params: { embeds: 'Attachments' }, embed: 'Attachments' }),
  (type, id) => ({ path: '/Attachments', params: { filters: `ParentType,eq,${type};ParentID,eq,${id}`, pageSize: 50 } }),
  (type, id) => ({ path: '/Attachments', params: { filters: `ParentKeyType,eq,${type};ParentKeyID,eq,${id}`, pageSize: 50 } }),
  (type, id) => ({ path: '/Files', params: { filters: `ParentType,eq,${type};ParentID,eq,${id}`, pageSize: 50 } }),
  // Added 2026-08-26 alongside scripts/probeAttachments.js. Same idea as the two
  // above: the store may exist under a different name on this build, and the cost
  // of trying is one request the first time only (the working shape is remembered).
  (type, id) => ({ path: '/Documents', params: { filters: `ParentType,eq,${type};ParentID,eq,${id}`, pageSize: 50 } }),
  (type, id) => ({ path: '/Images', params: { filters: `ParentType,eq,${type};ParentID,eq,${id}`, pageSize: 50 } }),
  // Some WAPI builds hang the collection off the parent record instead of taking
  // a filter — a sub-resource rather than a queryable store.
  (type, id) => ({ path: `/${type}s/${encodeURIComponent(id)}/Attachments`, params: { pageSize: 50 } }),
];

function normalizeAttachment(a) {
  // Two attachment shapes on this instance, found 2026-08-26. A bill's comes back
  // flat, with Name / Extension / DownloadURL on the record itself. A credit card
  // transaction's is a wrapper —
  //   FileAttachmentID, FileID, Description, EntityType, EntityKeyID, File
  // — with the actual file nested under `File`. Reading only the outer record
  // gives an attachment with no name and no URL, which looks exactly like a
  // receipt that cannot be opened.
  if (a && typeof a === 'object' && a.File && typeof a.File === 'object') {
    a = { ...a.File, ...a, ...a.File };
  }
  const name = String(pick(a, ['Name', 'FileName', 'Description', 'Title']) || 'Attachment');
  const ext = String(pick(a, ['Extension']) || '');
  return {
    id: pick(a, ['AttachmentID', 'FileID', 'ID', 'Id']),
    // RM stores the name without its extension ("W.O. Montesdeoca CS CA - MO")
    // and the extension beside it (".pdf"). A download called "…CA - MO" with no
    // suffix opens in nothing, so they are put back together here.
    name: ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? `${name}${ext}` : name,
    contentType: pick(a, ['ContentType', 'MimeType', 'FileType']),
    extension: ext || null,
    size: pick(a, ['FileSize', 'Size', 'Length']),
    uploadedAt: pick(a, ['CreateDate', 'UploadDate', 'DateCreated', 'CreatedOn']),
    // Not a URL we invent — only one RM itself handed back. DownloadURL is the
    // field the live API actually uses, and it is the whole ballgame: it is a
    // complete, signed address for the file, and on this instance it is the ONLY
    // thing that returns bytes.
    url: pick(a, ['DownloadURL', 'DownloadUrl', 'Url', 'URL', 'Link']),
    path: pick(a, ['Path', 'FilePath']),
  };
}

async function attachmentsFor(parentType, parentId) {
  if (parentId == null) return { list: [], tried: false };
  const shapes = _attachmentShape === undefined ? ATTACHMENT_SHAPES
    : _attachmentShape === null ? []
    : [_attachmentShape];

  for (const shape of shapes) {
    const { path, params, embed } = shape(parentType, parentId);
    try {
      const payload = await rentManager.get(path, params);
      // A LIST request answers with {Results:[…]} or a bare array; a request for
      // ONE record answers with the record itself, and asRows quite correctly
      // finds no rows in it. An embed shape always asks for one record, so the
      // payload IS the row — miss that and the embed silently returns nothing on
      // the exact call that works.
      const rows = asRows(payload);
      const single = !rows.length && payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload : null;
      // An embed shape returns the PARENT record; the attachments are a field on
      // it. A parent that simply has no attachment is not a failed shape — but it
      // is not proof the shape works either, so it is not remembered as the
      // winner, or the first bill without a scan would pin the shape on a guess.
      if (embed) {
        const row = rows.length ? rows[0] : single;
        const list = row && Array.isArray(row[embed]) ? row[embed] : null;
        if (!list) continue;
        if (list.length) _attachmentShape = shape;
        return { list: list.map(normalizeAttachment), tried: true };
      }
      _attachmentShape = shape;
      return { list: rows.map(normalizeAttachment), tried: true };
    } catch (err) {
      // keep trying the remaining shapes
    }
  }
  if (_attachmentShape === undefined) _attachmentShape = null;
  return { list: [], tried: true };
}

// ── Fetching the attachment's actual bytes ──────────────────────────────────
// Listing an invoice is not the same as producing it. Rent Manager gates file
// downloads behind the same API token header as every other call, so a link
// straight to an RM attachment URL is dead in a browser — the server has to fetch
// the bytes and stream them out itself.
//
// Which path serves those bytes is not documented consistently across WAPI12
// builds, so we walk the plausible ones and remember the first that works. Same
// learn-once pattern as ATTACHMENT_SHAPES above, and for the same reason: after
// the first success nobody pays for the guessing again.
let _downloadShape = undefined;   // undefined = untried, null = none work

const DOWNLOAD_SHAPES = [
  id => `/Attachments/${encodeURIComponent(id)}/Download`,
  id => `/Attachments/${encodeURIComponent(id)}/File`,
  id => `/Attachments/${encodeURIComponent(id)}/Content`,
  id => `/Files/${encodeURIComponent(id)}/Download`,
  id => `/Documents/${encodeURIComponent(id)}/Download`,
  id => `/Images/${encodeURIComponent(id)}/Download`,
  id => `/Attachments/${encodeURIComponent(id)}`,
];

// An RM build that has no download route may still hand the file back inside the
// record as base64. Worth checking before giving up — it is the same bytes.
const BASE64_FIELDS = ['FileData', 'Data', 'Content', 'FileContents', 'Bytes', 'Base64'];

function fromJsonRecord(buffer, contentType) {
  if (!/json/i.test(contentType)) return null;
  let rec;
  try { rec = JSON.parse(buffer.toString('utf8')); } catch { return null; }
  const row = Array.isArray(rec) ? rec[0] : (rec && (rec.Results || rec.Items || rec.Data) || rec);
  const target = Array.isArray(row) ? row[0] : row;
  if (!target || typeof target !== 'object') return null;
  for (const f of BASE64_FIELDS) {
    const v = target[f];
    if (typeof v === 'string' && v.length > 64) {
      try {
        return {
          buffer: Buffer.from(v, 'base64'),
          contentType: target.ContentType || target.MimeType || 'application/octet-stream',
          fileName: target.Name || target.FileName || null,
        };
      } catch { /* not base64 after all */ }
    }
  }
  return null;
}

function fileNameFromDisposition(disposition) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition || '');
  return m ? decodeURIComponent(m[1].trim()) : null;
}

/**
 * The bytes behind one attachment id, or null if this Rent Manager will not serve
 * them. Never throws: the caller turns null into an honest "open it in Rent
 * Manager" message rather than an error page.
 */
async function fetchAttachment(attachment) {
  // Accepts the normalized attachment (preferred — it carries the URL) or a bare
  // id, which is what the older callers passed.
  const meta = attachment && typeof attachment === 'object' ? attachment : { id: attachment };
  const attachmentId = meta.id;

  // The address RM handed us, tried before anything we could assemble. On this
  // instance it is not merely the best route, it is the only one: the file lives
  // on a separate host (rm12filereader.rentmanager.com) behind a signed FKey, and
  // no path under the API's own base URL reaches it. Confirmed live 2026-08-26 —
  // 288 KB of application/pdf came back from a DownloadURL while all seven shapes
  // below returned 404.
  if (meta.url) {
    try {
      const res = await rentManager.getRaw(String(meta.url));
      if (res.ok && res.buffer.length && !/json/i.test(res.contentType)) {
        return {
          buffer: res.buffer,
          contentType: res.contentType || 'application/octet-stream',
          fileName: fileNameFromDisposition(res.contentDisposition) || meta.name || null,
        };
      }
      const embedded = res.ok && res.buffer.length ? fromJsonRecord(res.buffer, res.contentType) : null;
      if (embedded) return embedded;
    } catch (err) {
      // fall through to the shapes below
    }
  }

  if (attachmentId == null) return null;
  const shapes = _downloadShape === undefined ? DOWNLOAD_SHAPES
    : _downloadShape === null ? []
    : [_downloadShape];

  for (const shape of shapes) {
    let res;
    try {
      res = await rentManager.getRaw(shape(attachmentId));
    } catch (err) {
      continue;   // auth cooldown or transport failure — try the next shape
    }
    if (!res.ok || !res.buffer.length) continue;

    const embedded = fromJsonRecord(res.buffer, res.contentType);
    if (embedded) { _downloadShape = shape; return embedded; }
    // A JSON body with no file field is the record, not the file — keep looking.
    if (/json/i.test(res.contentType)) continue;

    _downloadShape = shape;
    return {
      buffer: res.buffer,
      contentType: res.contentType || 'application/octet-stream',
      fileName: fileNameFromDisposition(res.contentDisposition),
    };
  }
  if (_downloadShape === undefined) _downloadShape = null;
  return null;
}

// ── Payment + credit card ───────────────────────────────────────────────────
// "When a charge was paid by credit card, show the statement charge as the backup
// instead of/alongside the invoice." In Rent Manager a card-paid bill is still a
// bill; what makes it a card charge is the ACCOUNT it was paid from. So: find the
// payment, look at the account it drew on, and if that account is a credit card,
// report the statement charge that carries it.
const CARD_ACCOUNT_RE = /credit\s*card|\bcc\b|\bamex\b|visa|mastercard|master\s*card|discover|\bcard\b/i;

let _bankDirectoryCache = null;
const BANK_TTL_MS = 6 * 60 * 60 * 1000;

// ── Which bank account paid it ──────────────────────────────────────────────
// Sarah, 2026-09-03, holding a payment record: it says *"cleared by bank, method:
// check"* and does not say WHICH account, so there is nothing to type into the
// bank's search box. *"Need the last four digits of the bank account (or entity
// that paid) so Sarah can look up the check."*
//
// Rent Manager links every check to a bank account and the check row carries the
// id (`BankID`). What the check row does NOT carry is a name — and
// **/BankAccounts is a 404 on this instance**, which is why
// `account` has come back null on every payment this tab has ever drawn. The
// panel had a row for it and the row was always empty.
//
// So the directory is looked for under each name Rent Manager might expose it as,
// and whichever one answers becomes the map for the next six hours.
//
// ── what actually answers here, measured 2026-09-03 ──────────────────────────
// `/BankAccounts` and `/Banks` are both absent. **`/GLAccounts` is not**, and a
// bank account in this database IS a GL account: 87 rows come back with
// `GLAccountType: "Bank"` — "1043 Birchwood Commons Reserve LLC - First Commerce Ops",
// "1038 Willow CreekFC Group 2 LLC", "98 Maple Court - Customers operating".
//
// And a check's `BankID` is that GL account's id. Measured against 500 real
// checks: of the 21 distinct BankIDs they carry, every one that fell inside the
// page of GL accounts read back — 13 of 13 — is a `Bank`-type GL account, and
// none is anything else. So the join is `check.BankID → GLAccountID`, on a
// resource this instance has had all along.
//
// What those names carry is the ENTITY, which is the half of Sarah's ask that
// matters most here — *"the last four digits of the bank account (or entity that
// paid)"*. They do not carry account numbers, so on this instance the last four
// will usually be absent and the entity present. That is the honest outcome and
// the panel prints what it has.
//
// Where nothing answers the check's own fields are read, then the check is asked
// for its bank as an embed, and failing all of that the id is reported as an id:
// "BankID 3" is a poor answer and an honest one, and it is the answer that gets
// the permission asked for. A silent blank asks nobody for anything.
//
// **Only the last four digits ever leave here.** A full account number has no
// business on a PDF that gets emailed around, and four digits is what a bank's
// own search box takes.
const BANK_DIRECTORY_RESOURCES = [
  // Ordered by authority. The first two are the resources RM documents for this;
  // neither exists here, and if one is ever switched on it should win.
  { path: '/BankAccounts', params: { pageSize: 500 } },
  { path: '/Banks', params: { pageSize: 500 } },
  // The one that answers on this instance. Filtered server-side where RM accepts
  // the filter, and paged and filtered here where it does not — the accounts a
  // check actually draws on run past the first page (BankID 615 alone paid 124 of
  // 500 sampled checks and sits beyond row 500).
  { path: '/GLAccounts', params: { filters: 'GLAccountType,eq,Bank', pageSize: 500 },
    pages: 6, bankTypeOnly: true },
];

// Ordered by how directly the field answers "what does a check's BankID mean?".
// `GLAccountID` is on that list because on this instance it IS what BankID means
// (measured — see the note above), and it has to sit ahead of the bare `ID` a GL
// row also carries.
const BANK_ID_FIELDS = ['BankID', 'BankId', 'BankAccountID', 'BankAccountId',
  'GLAccountID', 'GLAccountId', 'ID', 'Id'];
const BANK_NAME_FIELDS = ['Name', 'AccountName', 'BankName', 'Description', 'ShortName'];
const BANK_NUMBER_FIELDS = ['AccountNumber', 'BankAccountNumber', 'AccountNo', 'AcctNumber', 'Number'];

function statusOf(err) {
  const m = /\((\d{3})\)/.exec(String((err && err.message) || ''));
  return m ? Number(m[1]) : null;
}

// The last four of whatever account number we were given, and nothing else.
function lastFour(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

// A bank account's NAME usually carries the last four already — "Operating -
// 4471", "First Commerce x4471" — because that is how a bookkeeper tells two
// accounts apart. Read only from the END of the name, where that convention puts
// it: digits in the middle of a name are as likely to be a branch, a year or a
// property number as an account.
function lastFourFromName(name) {
  const m = /(?:^|[\s\-–*xX#.•·…])(\d{4})\s*$/.exec(String(name == null ? '' : name).trim());
  return m ? m[1] : null;
}

// One page of a candidate directory, normalised. Returns the rows it could read
// as bank accounts; a resource that is not there throws and the caller records it.
async function bankDirectoryPage(res, pageNumber) {
  const params = { ...res.params };
  if (pageNumber > 1) params.pagenumber = pageNumber;
  const rows = asRows(await rentManager.get(res.path, params));
  const out = [];
  for (const b of rows) {
    // A GL-account pull that could not be filtered server-side comes back as the
    // whole chart of accounts; only the Bank-type rows are bank accounts, and
    // treating an expense account as one would name the wrong thing on a PDF.
    if (res.bankTypeOnly && String(pick(b, ['GLAccountType', 'AccountType']) || '') !== 'Bank') continue;
    const field = BANK_ID_FIELDS.find(f => b && b[f] != null && b[f] !== '');
    const id = field ? b[field] : null;
    if (id == null) continue;
    const rawName = String(pick(b, BANK_NAME_FIELDS) || '').trim();
    const reference = pick(b, ['Reference']);
    // These are named "1043 Birchwood Commons Reserve LLC - First Commerce Ops" about half the
    // time and "First Commerce ops" the rest, so the GL reference goes on the
    // front only when the name has not already got it.
    const name = reference && !String(rawName).startsWith(String(reference))
      ? `${reference} ${rawName}`.trim() : rawName;
    const type = String(pick(b, ['AccountType', 'BankAccountType', 'Type', 'GLAccountType']) || '');
    const fromNumber = lastFour(pick(b, BANK_NUMBER_FIELDS));
    out.push({ field, entry: {
      id, name, type, reference: reference || null,
      last4: fromNumber || lastFourFromName(name),
      last4From: fromNumber ? 'account number' : (lastFourFromName(name) ? 'account name' : null),
      // A debit-card account is still a bank account. Reading it as a credit card
      // sends the panel looking for a statement charge that does not exist —
      // which could not happen before, because this map was always empty.
      isCard: CARD_ACCOUNT_RE.test(`${name} ${type}`) && !/debit/i.test(`${name} ${type}`),
    } });
  }
  return { rows: rows.length, accounts: out };
}

async function bankDirectory() {
  if (_bankDirectoryCache && Date.now() - _bankDirectoryCache.at < BANK_TTL_MS) return _bankDirectoryCache.value;
  const byId = new Map();
  const tried = [];
  let source = null;
  // Which FIELD the directory is keyed on matters as much as whether it answered:
  // a check is looked up by its `BankID`, so a directory keyed on an id space
  // that is not that one would name the WRONG account — worse than naming none,
  // and the same mistake this codebase made once with bill lines. On this
  // instance the answer is GLAccountID, and that it IS what BankID means was
  // measured rather than assumed (see the note above).
  let keyedOn = null;

  for (const candidate of BANK_DIRECTORY_RESOURCES) {
    let res = candidate;
    let read = 0, seen = 0, failed = null;
    for (let page = 1; page <= (res.pages || 1); page++) {
      let got;
      try {
        got = await bankDirectoryPage(res, page);
      } catch (err) {
        // A server-side filter RM will not accept fails the whole request. Drop
        // it and page through instead rather than writing the resource off — the
        // Bank-type rows are then picked out here.
        if (page === 1 && res.params && res.params.filters) {
          res = { ...res, params: { pageSize: res.params.pageSize } };
          try {
            got = await bankDirectoryPage(res, page);
          } catch (err2) { failed = err2; break; }
        } else { failed = err; break; }
      }
      seen += got.rows;
      for (const { field, entry } of got.accounts) {
        if (!keyedOn) keyedOn = field;
        byId.set(String(entry.id), entry);
        read++;
      }
      if (got.rows < (res.params.pageSize || 500)) break;      // last page
    }
    if (failed) {
      const st = statusOf(failed);
      tried.push(`${res.path}: ${st ? `HTTP ${st}` : String((failed && failed.message) || failed).slice(0, 80)}`);
      continue;
    }
    tried.push(`${res.path}: ${seen} row(s), ${read} bank account(s)${keyedOn ? ` keyed on ${keyedOn}` : ''}`);
    if (read) { source = res.path; break; }
  }

  const value = { byId, source, keyedOn, tried };
  _bankDirectoryCache = { at: Date.now(), value };
  return value;
}

// ── the route a resource list cannot find ───────────────────────────────────
// The lesson this codebase already paid for once: `/Attachments` 404s here and
// invoices are reachable anyway, because they ride on the bill as an EMBED. An
// embed is a different code path from a resource, and probing resource names can
// never find it.
//
// So the same question is asked of a check. If `/Banks` and `/BankAccounts` are
// both absent, `/Checks/{id}?embeds=Bank` may still hand the account over. The
// working embed name is remembered after the first success and a name that comes
// back 400 is not tried again — one wasted request per process, not one per check.
const CHECK_BANK_EMBEDS = ['Bank', 'BankAccount'];
let _checkBankEmbed;          // undefined = untried · null = none of them work

async function bankFromCheckEmbed(checkId) {
  if (checkId == null || _checkBankEmbed === null) return null;
  const names = _checkBankEmbed ? [_checkBankEmbed] : CHECK_BANK_EMBEDS;
  for (const name of names) {
    try {
      const row = oneRow(await rentManager.get(`/Checks/${encodeURIComponent(checkId)}`, { embeds: name }));
      const nested = row && (row[name] || row[`${name}s`]);
      const b = Array.isArray(nested) ? nested[0] : nested;
      if (b && typeof b === 'object') {
        _checkBankEmbed = name;
        return {
          id: pick(b, BANK_ID_FIELDS),
          name: String(pick(b, BANK_NAME_FIELDS) || '').trim(),
          number: pick(b, BANK_NUMBER_FIELDS),
          via: `/Checks/{id}?embeds=${name}`,
        };
      }
    } catch (err) { /* this embed name is not supported — try the next */ }
  }
  if (!_checkBankEmbed) _checkBankEmbed = null;
  return null;
}

/**
 * Name the account a check was drawn on, from whatever the four sources between
 * them know: the directory (best), an embed on the check, the check row's own
 * fields, and the id.
 *
 * Never returns null — a payment always says something about where the money left
 * from, even when that something is "Rent Manager would not tell us".
 */
function describeBank({ id, account, embed, rowName, rowNumber }) {
  const name = String((account && account.name) || (embed && embed.name) || rowName || '').trim() || null;
  const fromRowNumber = lastFour(rowNumber) || lastFour(embed && embed.number);
  const last4 = fromRowNumber || (account && account.last4) || lastFourFromName(name);
  const last4From = fromRowNumber ? 'account number'
    : (account && account.last4 ? account.last4From : (last4 ? 'account name' : null));

  // One string, ASCII only, so the PDF (WinAnsi Helvetica) and the browser print
  // the same thing rather than two roughly-similar things.
  let label;
  if (name && last4 && !lastFourFromName(name)) label = `${name} ****${last4}`;
  else if (name) label = name;
  else if (last4) label = `****${last4}`;
  else if (id != null) label = `BankID ${id} — Rent Manager did not name this account to the API`;
  else label = 'Not recorded on the payment in Rent Manager';

  return {
    id: id == null ? null : String(id),
    name,
    last4,
    last4From,
    label,
    // Which of the four routes actually answered — the difference between "we
    // cannot get this" and "we get it, but only through the embed".
    via: account ? 'directory' : (embed ? embed.via : (rowName || rowNumber ? 'the check row' : null)),
    // Whether Sarah has something she can search a statement with.
    known: Boolean(name || last4),
  };
}

// How many of a bill's lines to chase before giving up on naming its check. The
// lines are tried in order of how well they match THIS charge, so four is four
// attempts at the right line rather than four arbitrary ones.
const MAX_DETAIL_LOOKUPS = 4;
const MAX_CHECKS_NAMED = 3;

/**
 * How much a bill line looks like the posting in front of us.
 *
 * A consolidated vendor bill runs to 78 lines across a dozen buildings. Taking
 * the first four and reporting whichever check paid them answers a question
 * nobody asked — the first live run named a $113.93 check against a $1,215.81
 * bill because that is what line 1 happened to belong to.
 *
 * The same narrowing the bill-worksheet cross-check uses: this property's line,
 * this unit's, this account's. A line naming a DIFFERENT property is somebody
 * else's money and is refused outright rather than ranked low.
 */
function detailRelevance(d, charge) {
  const propId = pick(d, ['PropertyID', 'PropertyId']);
  const acct = pick(d, ['GLAccountID', 'GLAccountId', 'AccountID']);
  const unit = pick(d, ['UnitName', 'UnitNumber', 'Unit']);
  const amt = money(pick(d, ['Amount', 'LineAmount', 'Total']));
  if (charge && charge.propertyId != null && propId != null
      && String(propId) !== String(charge.propertyId)) return -1;

  let score = 0;
  if (charge && charge.propertyId != null && propId != null) score += 2;
  if (charge && charge.accountId != null && acct != null
      && String(acct) === String(charge.accountId)) score += 2;
  if (charge && charge.unitName && unit
      && String(unit).trim().toUpperCase() === String(charge.unitName).trim().toUpperCase()) score += 1;
  // The strongest signal, and the only one that makes the applied figure exact.
  if (amt != null && charge && charge.amount != null
      && Math.abs(Math.abs(amt) - Math.abs(charge.amount)) < 0.01) score += 3;
  return score;
}

/**
 * The money that settled this charge's line of this bill.
 *
 * The first version asked /Payments and /Checks for `BillID,eq,<id>`. Neither
 * resource has that field — /Payments is the receivables side (PaymentID,
 * ReceiptID, tenant cash) and a /Checks row carries ID, AccountID, Reference,
 * Amount, TransactionDate, Payee, BankID and ReconcileID and no bill reference at
 * all. So both queries came back empty on every bill, and the whole credit side
 * of a bill charge silently showed nothing rather than showing something wrong.
 *
 * The link lives one level down, on the LINES: a check's CheckDetails name the
 * BillDetailIDs they settled. The coverage sweep already walks that backwards to
 * find bills; this walks it forwards, starting from the line that matches the
 * charge rather than from whichever line the bill happens to list first.
 */
async function paymentFor(bill, charge) {
  const billId = pick(bill, ['BillID', 'BillId', 'ID', 'Id']);
  if (billId == null) return null;

  let details = Array.isArray(bill.BillDetails) ? bill.BillDetails : null;
  if (!details || !details.length) {
    try {
      const one = oneRow(await rentManager.get(`/Bills/${encodeURIComponent(billId)}`,
        { embeds: 'BillDetails' })) || {};
      details = Array.isArray(one.BillDetails) ? one.BillDetails : [];
    } catch (err) {
      return null;
    }
  }

  const ranked = details
    .map(d => ({ id: pick(d, ['BillDetailID', 'BillDetailId']),
                 amount: money(pick(d, ['Amount', 'LineAmount', 'Total'])),
                 score: detailRelevance(d, charge) }))
    .filter(r => r.id != null && r.score >= 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  // Two different counts, and conflating them made the panel say "this bill has
  // 1 lines" about a 78-line invoice. `candidates` is what survived the
  // this-property filter; `linesOnBill` is the invoice as it actually is.
  const linesOnBill = details.length;

  // A line that matches the charge on amount as well as property and account is
  // this charge's line, and the amount a check applied to it is this charge's
  // money. Anything weaker is "a line of this bill", and the figure is withheld
  // rather than dressed up — see the note on chargeLine below.
  const EXACT_LINE = 7;   // property + account + amount, unit optional

  const applied = new Map();
  let examined = 0;
  let chargeLine = null;
  for (const line of ranked.slice(0, MAX_DETAIL_LOOKUPS)) {
    examined++;
    let rows = [];
    try {
      rows = asRows(await rentManager.get('/CheckDetails',
        { filters: `BillDetailID,eq,${line.id}`, pageSize: 10 }));
    } catch (err) {
      continue;
    }
    for (const cd of rows) {
      const cid = pick(cd, ['CheckID', 'CheckId']);
      if (cid == null) continue;
      const paid = Math.abs(money(pick(cd, ['Amount'])) || 0);
      applied.set(String(cid), (applied.get(String(cid)) || 0) + paid);
      if (!chargeLine && line.score >= EXACT_LINE) {
        chargeLine = { billDetailId: line.id, lineAmount: line.amount, paid };
      }
    }
    if (chargeLine || applied.size >= MAX_CHECKS_NAMED) break;
  }
  if (!applied.size) return null;

  const directory = await bankDirectory();
  const paidBy = [];
  for (const [cid, appliedAmount] of [...applied].slice(0, MAX_CHECKS_NAMED)) {
    let row = null;
    try {
      row = oneRow(await rentManager.get(`/Checks/${encodeURIComponent(cid)}`, {}));
    } catch (err) {
      row = null;
    }
    if (!row) continue;
    const bankId = pick(row, ['BankID', 'BankAccountID', 'BankAccountId']);
    const account = bankId != null ? directory.byId.get(String(bankId)) : null;
    const rowName = pick(row, ['BankName', 'BankAccountName', 'AccountName']);
    const rowNumber = pick(row, ['BankAccountNumber', 'AccountNumber']);
    // No directory and nothing on the row — ask the check for its bank as an
    // EMBED before giving up. That is the route that turned out to work for
    // invoices when /Attachments was a 404, and it costs one request per process
    // to find out rather than one per check.
    const embed = (!account && !rowName && !rowNumber) ? await bankFromCheckEmbed(cid) : null;
    const bank = describeBank({ id: bankId, account, embed, rowName, rowNumber });
    const methodText = String(pick(row, ['TransactionType', 'PaymentMethod', 'CheckType']) || '');
    paidBy.push({
      checkId: cid,
      reference: pick(row, ['Reference', 'CheckNumber', 'ReferenceNumber']),
      paidOn: String(pick(row, ['TransactionDate', 'CheckDate', 'Date']) || '').slice(0, 10),
      payee: pick(row, ['Payee', 'PayeeName', 'VendorName']),
      checkTotal: money(pick(row, ['Amount', 'CheckAmount'])),
      applied: Math.round(appliedAmount * 100) / 100,
      method: methodText,
      account: bank.name,
      // Which account the money left from, and the last four Sarah types into the
      // bank to find the check. Never the whole number.
      bank,
      // Rent Manager marks a check reconciled by stamping the bank rec it fell
      // into. Present means the bank statement has been matched against it, which
      // is the strongest proof of payment this API offers.
      reconciled: pick(row, ['ReconcileID', 'ReconcileId']) != null,
      paidByCreditCard: Boolean(account && account.isCard) || CARD_ACCOUNT_RE.test(methodText),
    });
  }
  if (!paidBy.length) return null;

  const first = paidBy[0];
  return {
    source: '/CheckDetails → /Checks',
    paidOn: first.paidOn,
    amount: first.checkTotal,
    // Present only when the line was identified as THIS charge's — matching the
    // property, the GL account and the amount. On a 78-line consolidated bill
    // anything less is a figure about some other line, and a number about the
    // wrong line is worse than no number.
    chargeLine,
    appliedToChargeLine: chargeLine ? chargeLine.paid : null,
    linesExamined: examined,
    candidateLines: ranked.length,
    linesOnBill,
    method: first.method,
    reference: first.reference,
    payee: first.payee,
    account: first.account,
    bank: first.bank,
    // How the directory was resolved, so a blank account is answerable ("which
    // resource did you ask?") instead of just blank.
    bankDirectory: { source: directory.source, keyedOn: directory.keyedOn, tried: directory.tried },
    reconciled: paidBy.some(p => p.reconciled),
    paidByCreditCard: paidBy.some(p => p.paidByCreditCard),
    // A bill settled by more than one payment is normal on a consolidated vendor
    // bill, and showing only the first reads as "this is what paid it".
    checks: paidBy,
  };
}

/**
 * Who paid a charge that has no bill at all.
 *
 * Measured across 50 live charges 2026-09-14: 11 of 44 check-paid charges have no
 * AP bill, and they are not failures — they are six permit fees to the Town of
 * West New York (each its own check) and five small ACH reimbursements. A cheque
 * written straight to a municipality has no vendor invoice and never will, so
 * "No AP bill matched this posting" was the panel's whole answer on a quarter of
 * the ledger, and it reads like a defect.
 *
 * It does not have to. A CHKITM posting IS a line of a check — `txnType` says
 * which kind and `txnId` says which one, which is exactly how the coverage sweep
 * resolves 24,490 charges without touching a bill. So the payment side is
 * answerable directly: the check, the payee, the bank account it was drawn on,
 * and whether it cleared.
 *
 * The applied figure here is stronger than the bill-line path's, not weaker: the
 * posting is the line, so the charge's own amount is what this check paid toward
 * it. No matching, nothing inferred.
 */
async function paymentFromCharge(charge) {
  if (String(charge.txnType || '').toUpperCase() !== 'CHKITM' || charge.txnId == null) return null;
  let row = null;
  try {
    row = oneRow(await rentManager.get(`/Checks/${encodeURIComponent(charge.txnId)}`, {}));
  } catch (err) {
    return null;
  }
  if (!row) return null;

  const directory = await bankDirectory();
  const bankId = pick(row, ['BankID', 'BankAccountID', 'BankAccountId']);
  const bank = describeBank({
    id: bankId,
    account: bankId != null ? directory.byId.get(String(bankId)) : null,
    rowName: pick(row, ['BankName', 'BankAccountName', 'AccountName']),
    rowNumber: pick(row, ['BankAccountNumber', 'AccountNumber']),
  });
  const methodText = String(pick(row, ['TransactionType', 'PaymentMethod', 'CheckType']) || '');
  return {
    source: '/Checks — this posting is a line of the payment',
    // What the panel leans on to word itself honestly: there is no bill here, and
    // that is a fact about how it was paid rather than a lookup that failed.
    direct: true,
    checkId: String(charge.txnId),
    reference: pick(row, ['Reference', 'CheckNumber', 'ReferenceNumber']),
    paidOn: String(pick(row, ['TransactionDate', 'CheckDate', 'Date']) || '').slice(0, 10),
    payee: pick(row, ['Payee', 'PayeeName', 'VendorName']),
    amount: money(pick(row, ['Amount', 'CheckAmount'])),
    // The posting IS the line, so this is exact rather than matched.
    appliedToChargeLine: Number(charge.amount) || null,
    method: methodText,
    account: bank.name,
    bank,
    bankDirectory: { source: directory.source, keyedOn: directory.keyedOn, tried: directory.tried },
    reconciled: pick(row, ['ReconcileID', 'ReconcileId']) != null,
    paidByCreditCard: false,
  };
}

/**
 * The card transaction behind a card-paid bill.
 *
 * Was written against /BankTransactions, which is a 404 on this instance, so it
 * could never return anything — and because a failed lookup reads the same as
 * "not paid by card", nobody could tell. /CreditCardTransactions is the resource
 * that exists, and it carries the card, the reference, the amount, the date and
 * the reconcile id.
 *
 * Matched on amount within a window around the payment rather than on an id,
 * because the bill side and the card side are not linked by a key here. That is a
 * weaker claim than the invoice match and is labelled as one: `matchedOn` says
 * what it was matched by, so nobody reads a date-and-amount hit as a keyed link.
 */
async function creditCardStatementCharge(payment) {
  if (!payment || !payment.paidByCreditCard || !payment.paidOn) return null;
  const day = String(payment.paidOn).slice(0, 10);
  const from = shiftDate(day, -5);
  const to = shiftDate(day, 35);      // a card charge lands on the statement that closes after it
  try {
    const rows = asRows(await rentManager.get('/CreditCardTransactions', {
      filters: `TransactionDate,ge,${from};TransactionDate,le,${to}`, pageSize: 500,
    }));
    const target = Math.abs(payment.amount);
    const hit = rows.find(r => Math.abs(Math.abs(money(pick(r, ['Amount']))) - target) < 0.01);
    if (!hit) return { found: false, searched: { from, to, resource: '/CreditCardTransactions' } };
    const cardId = pick(hit, ['CreditCardID', 'CreditCardId']);
    const card = cardId != null ? (await creditCards()).get(String(cardId)) : null;
    return {
      found: true,
      matchedOn: 'amount and date — the bill and the card line are not keyed together',
      date: String(pick(hit, ['TransactionDate', 'Date']) || '').slice(0, 10),
      amount: money(pick(hit, ['Amount'])),
      description: pick(hit, ['Comment', 'Description', 'Memo']),
      reference: pick(hit, ['Reference', 'ReferenceNumber']),
      card: card ? card.name : null,
      reconciled: pick(hit, ['ReconcileID', 'ReconcileId']) != null,
    };
  } catch (err) {
    return null;   // resource not exposed — the manualLookup block covers it
  }
}

// ── The credit side ─────────────────────────────────────────────────────────
// From the brief: *"when a charge was paid by credit card, show the statement
// charge as the backup"* — and she needs it beside the invoice, not instead of it.
//
// The original build asked /BankAccounts to tell a card account from a bank
// account, and /BankTransactions for the statement line. **/BankAccounts is a 404
// on this instance**, so the bank map was always empty, paidByCreditCard has
// always been false, and the statement lookup has never once executed. It failed
// silently and looked like "no card involved". (bankDirectory() now tries the
// other names Rent Manager might expose that directory under, and says which one
// answered — see the note above it.)
//
// What does answer is /CreditCards and /CreditCardTransactions. And for a posting
// whose TransactionType is CC CHG, the id in the GL report's Hyperlink IS the
// card transaction — so the card, the charge and its receipt are one request
// away, with no payment record to chase.
let _cardsCache = null;

async function creditCards() {
  if (_cardsCache && Date.now() - _cardsCache.at < BANK_TTL_MS) return _cardsCache.byId;
  const byId = new Map();
  try {
    for (const row of asRows(await rentManager.get('/CreditCards', { pageSize: 500 }))) {
      const id = pick(row, ['CreditCardID', 'CreditCardId', 'ID']);
      if (id != null) {
        byId.set(String(id), {
          id,
          name: String(pick(row, ['Name', 'Description']) || '').trim(),
          reference: pick(row, ['Reference']),
        });
      }
    }
  } catch (err) { /* not exposed — the caller reports the card without a name */ }
  _cardsCache = { at: Date.now(), byId };
  return byId;
}

/**
 * The card transaction behind a CC CHG posting: which card, what it says, and
 * whether a receipt is on it. Never throws — a card we cannot read is reported as
 * unknown rather than as a charge with no card.
 */
async function creditCardCharge(charge) {
  if (String(charge.txnType || '').toUpperCase() !== 'CC CHG' || charge.txnId == null) return null;
  try {
    const row = await cardTxn(charge.txnId);
    if (!row) return { found: false, reason: 'the card transaction did not come back' };
    const rid = pick(row, ['ID', 'Id', 'CreditCardTransactionID']);
    // The record has to BE the one asked for, or the id means something else here
    // and every field below would belong to another charge.
    if (rid != null && String(rid) !== String(charge.txnId)) {
      return { found: false, reason: 'the id did not resolve to that transaction' };
    }
    const cardId = pick(row, ['CreditCardID', 'CreditCardId']);
    const card = cardId != null ? (await creditCards()).get(String(cardId)) : null;
    const att = Array.isArray(row.Attachments) ? row.Attachments : [];
    return {
      found: true,
      transactionId: rid,
      card: card ? (card.name || `Card ${card.id}`) : (cardId != null ? `Card ${cardId}` : null),
      cardReference: card ? card.reference : null,
      date: String(pick(row, ['TransactionDate', 'Date']) || '').slice(0, 10),
      amount: money(pick(row, ['Amount'])),
      reference: pick(row, ['Reference']),
      comment: pick(row, ['Comment']),
      receipts: att.map(normalizeAttachment),
    };
  } catch (err) {
    return { found: false, error: String(err && err.message ? err.message : err).slice(0, 200) };
  }
}

// ── Bill worksheet cross-check ──────────────────────────────────────────────
// "Cross-check against the Rent Manager bill worksheet." The worksheet is the
// bill's GL distribution: which accounts the bill's dollars were split across.
// The check that matters is whether the line charged to THIS renovation account
// equals the GL posting the tab is showing. When they disagree, the number on the
// invoice and the number in the P&L are different numbers, and that is exactly the
// thing you do not want to discover after sending it to ownership.
function worksheetCheck(bill, charge) {
  const details = bill && (bill.BillDetails || bill.Details || bill.LineItems);
  if (!Array.isArray(details) || !details.length) {
    return { checked: false, reason: 'bill worksheet lines not returned by the API' };
  }
  const lines = details.map(d => ({
    accountId: pick(d, ['GLAccountID', 'GLAccountId', 'AccountID']),
    accountName: pick(d, ['GLAccountName', 'AccountName', 'Description']),
    propertyId: pick(d, ['PropertyID', 'PropertyId']),
    unit: pick(d, ['UnitName', 'UnitNumber', 'Unit']),
    amount: money(pick(d, ['Amount', 'LineAmount', 'Total'])),
    description: pick(d, ['Description', 'Memo', 'Comment']),
  }));

  // ── the line is this PROPERTY's line, not the whole invoice ───────────────
  // A renovation invoice is one bill split across the buildings it covers: FY
  // Construction's MAJOR/Cedar Ridge/37Du is $20,000 in ten lines, all on GL 5156, one per
  // property — 77 Birchwood Lane $1,900, 90 Maple Court $1,900, and so on.
  //
  // Filtering on the GL account alone summed all ten and compared $20,000 against
  // a single $1,900 posting, reporting an $18,100 discrepancy on a charge that
  // ties to the cent. It fired on every split invoice, which on this ledger is
  // most of them — a red warning across the tab, every one of them wrong, on the
  // charges where the backup had just been found.
  //
  // A line that names no property cannot be ruled out, so it stays in; one that
  // names a DIFFERENT property is somebody else's money.
  const sameProperty = (l) => l.propertyId == null || charge.propertyId == null
    || String(l.propertyId) === String(charge.propertyId);
  const sameUnit = (l) => !l.unit || !charge.unitName
    || String(l.unit).trim().toUpperCase() === String(charge.unitName).trim().toUpperCase();

  const onAccount = lines.filter(l => String(l.accountId) === String(charge.accountId));
  let mine = onAccount.filter(sameProperty);
  // Only narrow to the unit when doing so still leaves a line to check against —
  // these worksheets often carry no unit at all, and an empty set would read as a
  // $0 worksheet disagreeing with the posting.
  const byUnit = mine.filter(sameUnit);
  const narrowedToUnit = byUnit.length > 0 && byUnit.length < mine.length;
  if (byUnit.length) mine = byUnit;

  const total = mine.reduce((s, l) => s + l.amount, 0);
  const diff = Math.round((total - charge.amount) * 100) / 100;

  return {
    checked: true,
    lines,
    matchedLines: mine.length,
    // What the whole invoice carries on this account, so a split bill can say so
    // rather than looking like a mismatch.
    linesOnAccount: onAccount.length,
    invoiceAmountOnAccount: Math.round(onAccount.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    splitAcrossProperties: onAccount.length > mine.length,
    narrowedToUnit,
    worksheetAmount: total,
    glAmount: charge.amount,
    diff,
    agrees: Math.abs(diff) < 0.01,
    // A unit named on the worksheet line is RM stating the unit outright — better
    // evidence than anything the GL report or a description scan can give us.
    unitFromWorksheet: (mine.find(l => l.unit) || {}).unit || null,
  };
}

// ── Public entry ────────────────────────────────────────────────────────────
// Everything a person needs to prove one charge to ownership. Cached briefly:
// backups get opened, closed and reopened while someone works a list, and the
// answer cannot change in five minutes.
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;

// What she would type into Rent Manager to find this by hand. Present whether or
// not the API found the document — when it did, this is the audit trail; when it
// didn't, this IS the fallback the brief asked for.
// ── everything else Rent Manager holds on the bill ──────────────────────────
// The owner, 2026-09-10: *"Any extra information that can go with any of these
// bills, just add it in. Whatever Rent Manager gives us, put it in."*
//
// A bill record turned out to be carrying rather a lot that never reached the
// screen, and one field answers a question asked separately in the same call:
//
//   IsApproved / ApprovalUserID / ApprovalDate   the approval is ON THE BILL.
//     "Who approved this spend" needed no purchase-order join at all.
//   AmountAllocated / IsFullyAllocated           how much of the bill is settled,
//     which is the difference between "a check paid this" and "paid in full".
//   PostDate vs TransactionDate                  when AP got to it vs the
//     invoice's own date — the asymmetry the bill-match window is built on.
//   CreateUserID / CreateDate                    who entered it and when.
//
// Rather than hand-pick and quietly drop the rest, the named ones get labels and
// EVERYTHING else that is populated is carried through generically. The only
// things dropped are row plumbing that means nothing on a page.
const BILL_PLUMBING = new Set([
  'ID', 'BillID', 'BillId', 'Id', 'ConcurrencyID', 'UpdateUserID', 'UpdateDate',
  'AccountID', 'AccountType', 'TransactionType', 'CreateUserID', 'ApprovalUserID',
  // Named explicitly below, so they would otherwise appear twice.
  'Reference', 'Amount', 'TransactionDate', 'DueDate', 'PostDate', 'CreateDate',
  'IsApproved', 'ApprovalDate', 'AmountAllocated', 'IsFullyAllocated',
  'VendorName', 'Name', 'PayeeName',
  // Dropped on purpose (the owner, 2026-09-10). AvidInvoiceURL is an AvidXchange
  // invoice address on the bill record; it came back empty on all 13 live
  // charges sampled, and a row nobody in the room can explain is worse than a
  // row that is missing. Listed here so it does not reappear through the generic
  // block below — if AvidXchange is ever actually in use for AP, this is the one
  // line to delete.
  'AvidInvoiceURL', 'AvidInvoiceUrl',
]);

// "PurchaseOrderNumber" → "Purchase order number". A raw field name on a page
// somebody hands an owner reads like a database, which is what it is and what it
// should not look like.
function humanLabel(field) {
  return String(field)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\bID\b/g, 'id')
    .replace(/^./, c => c.toUpperCase());
}

function displayValue(v) {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
  if (v == null || v === '') return null;
  if (typeof v === 'object') return null;      // nested records render themselves
  return String(v);
}

function billExtras(row) {
  const out = [];
  for (const [field, value] of Object.entries(row || {})) {
    if (BILL_PLUMBING.has(field)) continue;
    const shown = displayValue(value);
    if (shown == null) continue;
    out.push({ field, label: humanLabel(field), value: shown });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// Staff names, so "approved by 41" reads as a person. Same shape as the bank
// directory: one pull, cached, and a failure degrades to the id rather than
// taking the panel down.
let _usersCache = null;
async function users() {
  if (_usersCache && Date.now() - _usersCache.at < BANK_TTL_MS) return _usersCache.byId;
  const byId = new Map();
  try {
    for (const u of asRows(await rentManager.get('/Users', { pageSize: 500 }))) {
      const id = pick(u, ['UserID', 'UserId', 'ID', 'Id']);
      if (id == null) continue;
      const name = String(pick(u, ['Name', 'FullName', 'UserName', 'FirstName']) || '').trim();
      if (name) byId.set(String(id), name);
    }
  } catch (err) { /* not exposed — ids stay ids */ }
  _usersCache = { at: Date.now(), byId };
  return byId;
}

function manualLookupFor(charge) {
  return {
    where: 'Rent Manager → Property → Unit-level P&L → non-operating expense category → this charge → Attachments',
    property: charge.propertyName || null,
    propertyId: charge.propertyId ?? null,
    unit: charge.unitName || null,
    date: charge.date,
    glAccount: `${charge.accountRef}${charge.accountName ? ` · ${charge.accountName}` : ''}`,
    vendor: charge.vendor || null,
    reference: charge.reference || null,
    amount: charge.amount,
  };
}

async function backupFor(charge, { force = false } = {}) {
  // A forced (explicitly re-searched) result is cached separately, so asking for
  // the slow path once does not pin its answer over the fast one, or vice versa.
  const key = (force ? 'f|' : '') + (charge.id || `${charge.propertyId}|${charge.date}|${charge.amount}|${charge.reference}`);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;

  const caps = await capabilities();
  const available = new Set(caps.resources.filter(r => r.available).map(r => r.key));

  const unavailable = [];
  let bill = null;
  let billMatch = null;
  let attachments = { list: [], tried: false };
  let payment = null;
  let statementCharge = null;
  let worksheet = { checked: false, reason: 'no matching bill found' };

  // The probe informs the WORDING below; it never gates the attempt. A probe is a
  // generic list request and the real lookup is a filtered one, so the real lookup
  // can succeed where the probe could not — and a charge's backup is exactly the
  // wrong place to be pessimistic on a technicality.
  // A card charge has no bill to find — 3,555 renovation postings — so it takes
  // its own route before any of the bill machinery runs.
  if (String(charge.txnType || '').toUpperCase() === 'CC CHG') {
    attachments = await cardChargeAttachments(charge);
    if (!attachments.list.length) {
      unavailable.push(attachments.error
        ? `This is a credit card charge. Rent Manager would not return the transaction, so whether a receipt is attached is unknown: ${attachments.error}`
        : 'This is a credit card charge, not a vendor bill. Rent Manager has the transaction but no receipt is attached to it.');
    }
    const cardSide = await creditCardCharge(charge);
    const payload = {
      chargeId: charge.id || null,
      billSearch: null,
      manualLookup: manualLookupFor(charge),
      bill: null,
      worksheet: { checked: false, reason: 'a credit card charge has no bill worksheet' },
      attachments: attachments.list,
      payment: null,
      creditCard: { isCardCharge: true, resource: attachments.resource || null, charge: cardSide },
      unavailable,
      capabilities: caps.verdict,
    };
    _cache.set(key, { at: Date.now(), payload });
    if (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
    return payload;
  }

  // The sweep has already placed this charge against a bill, across the vendor's
  // whole ledger rather than a fortnight of it. Read that back rather than
  // repeating a narrower search — this is what makes a click quick and what stops
  // the tab from finding less than the coverage number promises.
  const known = backupIndex.lookup(charge.id);
  if (known && known.billId) {
    const row = await billById(known.billId);
    if (row) {
      bill = row;
      billMatch = { row, confidence: 'exact', by: 'coverage sweep', searched: { fromIndex: true, billId: known.billId } };
    }
  }

  // The sweep has already been through this charge's vendor across the whole
  // window. When it came back with no bill at all, repeating that search on a
  // click costs a minute and reaches the same answer: a live measurement of the
  // fall-through found lookups of 57 seconds on charges the sweep had already
  // written off. So the sweep's "no" is answered instantly and the expensive
  // search becomes something you ask for, not something you wait through.
  //
  // Absent from the index still means "not indexed", never "no document" — a
  // charge the sweep has not seen falls through and searches as before.
  const sweptAndEmpty = known && !known.billId && known.kind !== 'card';
  if (!bill && sweptAndEmpty && !force) {
    unavailable.push('The coverage sweep found no bill for this posting anywhere in this vendor\'s ledger. '
      + 'Rather than repeat that search — which takes about a minute and reaches the same answer — '
      + 'use “Search anyway” below, or the Rent Manager lookup.');
  }
  if (!bill && !sweptAndEmpty) {
    billMatch = await findBill(charge);
    bill = billMatch ? billMatch.row : null;
  } else if (!bill && force) {
    billMatch = await findBill(charge);
    bill = billMatch ? billMatch.row : null;
  }
  if (!bill) {
    // No bill does not mean no answer. A CHKITM posting is a line of a check, so
    // who paid it — and out of which account — is one lookup away whether or not
    // a vendor ever sent an invoice. Measured across 50 live charges: this is a
    // quarter of the check-paid ledger, and it was showing nothing at all.
    payment = await paymentFromCharge(charge);

    // Three different failures, three different things to do about them. They all
    // used to print the same sentence, which is how "the API refused the request"
    // spent weeks looking like "this posting has no invoice".
    if (billMatch && billMatch.error) {
      const st = billMatch.error.status;
      unavailable.push(st === 401 || st === 403
        ? `Rent Manager refused the bill lookup (HTTP ${st}). The API user needs rights to Accounts Payable — this is a permissions question, not a missing document.`
        : `The bill lookup failed (${billMatch.error.status ? `HTTP ${billMatch.error.status}` : 'no response'}): ${billMatch.error.message}`);
    } else if (payment && payment.direct) {
      // The common shape behind this, measured: a permit fee paid straight to a
      // municipality, or a small ACH reimbursement. There is no invoice because
      // nobody ever sent one — which is a fact about the payment, not a gap in
      // the lookup, and the panel should not read like a failure.
      unavailable.push(`This was paid directly${payment.reference ? ` (${String(payment.method) === 'Check' ? 'check' : 'reference'} ${payment.reference})` : ''}`
        + ' rather than against a vendor bill, so there is no invoice to attach. Who paid it, from which account, and whether it cleared are below.');
    } else if (billMatch && billMatch.searched && billMatch.searched.rows === 0) {
      unavailable.push(`No bills at all are dated between ${billMatch.searched.from} and ${billMatch.searched.to}, so there is nothing to match this posting against.`);
    } else {
      unavailable.push(available.has('bills')
        ? `No AP bill matched this posting — not on the bill total, and not on any single line of a bill in the window.${
          billMatch && billMatch.searched
            ? ` (${billMatch.searched.rows} bill(s) in the window, ${billMatch.searched.withDetails} with line detail.)` : ''
        } It may be a journal entry or a period adjustment rather than a vendor bill.`
        : 'This Rent Manager API does not expose /Bills, so the invoice behind the posting cannot be located automatically.');
    }
  }

  if (bill) {
    // ── the lines, which had been going missing ───────────────────────────────
    // Measured on 13 live charges 2026-09-10: every one came back with no
    // BillDetails, and the worksheet cross-check had been answering "bill
    // worksheet lines not returned by the API" on all of them — while paymentFor,
    // asking for the SAME bill with `embeds=BillDetails` on its own, got 100
    // lines back. So the lines were always reachable; the combined
    // `BillDetails,Attachments` embed is what this instance will not serve, and
    // the fallback that kept the attachments dropped the lines silently.
    //
    // One extra request, only when they are absent, on a click somebody made.
    // paymentFor reuses what this attaches rather than asking again, so on the
    // common path it costs nothing.
    if (!Array.isArray(bill.BillDetails) || !bill.BillDetails.length) {
      const billId = pick(bill, ['BillID', 'BillId', 'ID', 'Id']);
      if (billId != null) {
        try {
          const withLines = oneRow(await rentManager.get(`/Bills/${encodeURIComponent(billId)}`,
            { embeds: 'BillDetails' }));
          if (withLines && sameBill(withLines, billId) && Array.isArray(withLines.BillDetails)) {
            bill.BillDetails = withLines.BillDetails;
          }
        } catch (err) { /* the worksheet says so for itself */ }
      }
    }
    worksheet = worksheetCheck(bill, charge);
    const billId = pick(bill, ['BillID', 'BillId', 'ID', 'Id']);
    // Attachments embedded on the bill are free; only go looking separately when
    // RM didn't hand them over with the bill.
    const embedded = bill.Attachments || bill.Files || bill.Documents || bill.Images;
    if (Array.isArray(embedded) && embedded.length) {
      attachments = { list: embedded.map(normalizeAttachment), tried: true };
    } else {
      attachments = await attachmentsFor('Bill', billId);
      if (!attachments.list.length) {
        // Documents ARE reachable here — through the bill, not through a document
        // store. /Attachments, /Files, /Documents and /Images all 404 on this
        // instance and always will, so their absence is not news and is certainly
        // not something to email support about. The message said exactly that for
        // weeks, and it was still saying it on a charge summary yesterday, long
        // after a bill embed had produced a 288 KB invoice.
        //
        // So the honest reading now: the route works, this bill simply has
        // nothing attached to it.
        unavailable.push(available.has('billAttachments')
          ? 'No invoice is attached to this bill in Rent Manager. The bill was found; the document was never uploaded against it.'
          : 'The attachment route could not be reached on this refresh, so whether a document exists on this bill is unknown.');
      }
    }

    payment = await paymentFor(bill, charge);
    if (!payment) {
      unavailable.push(available.has('checkDetails')
        ? 'No check or EFT has been applied to this bill. On an accrual basis this usually means the bill is entered but not yet paid.'
        : 'The bill-to-payment link could not be reached on this refresh, so whether this was paid has to be checked in Rent Manager.');
    } else if (payment.bank && !payment.bank.known) {
      // "Cleared the bank" without naming the bank is the gap Sarah hit: there is
      // nothing to search a statement with. Say which resources were asked, so
      // this reads as a permission to request rather than as a dead end.
      unavailable.push(`Rent Manager did not name the bank account this payment was drawn on${
        payment.bank.id ? ` (BankID ${payment.bank.id})` : ''}, so the last four digits are not available here. `
        + `The account directory was asked for as ${payment.bankDirectory.tried.join(' · ')} — granting the API user rights to it would put the account on this panel and on the PDF.`);
    }
    if (payment && payment.paidByCreditCard) {
      statementCharge = await creditCardStatementCharge(payment);
      if (!statementCharge || statementCharge.found === false) {
        unavailable.push('Paid by credit card, but the matching statement charge was not found through the API — open the card account in Rent Manager for the statement line.');
      }
    }
  }

  // Staff names for the two user ids on a bill, so "approved by 41" reads as a
  // person. One cached pull; an id we cannot resolve stays an id.
  let approvedBy = null, enteredBy = null;
  if (bill) {
    const approverId = pick(bill, ['ApprovalUserID', 'ApprovalUserId']);
    const creatorId = pick(bill, ['CreateUserID', 'CreateUserId']);
    if (approverId != null || creatorId != null) {
      const staff = await users();
      if (approverId != null) approvedBy = staff.get(String(approverId)) || `User ${approverId}`;
      if (creatorId != null) enteredBy = staff.get(String(creatorId)) || `User ${creatorId}`;
    }
  }

  const payload = {
    chargeId: charge.id || null,
    billSearch: billMatch ? billMatch.searched || null : null,
    // What she would type into Rent Manager to find this by hand. Present whether
    // or not the API found the document — when it did, this is the audit trail;
    // when it didn't, this IS the fallback the brief asked for.
    manualLookup: manualLookupFor(charge),
    bill: bill ? {
      id: pick(bill, ['BillID', 'BillId', 'ID', 'Id']),
      date: String(pick(bill, ['TransactionDate', 'BillDate', 'Date', 'PostDate']) || '').slice(0, 10),
      dueDate: String(pick(bill, ['DueDate']) || '').slice(0, 10) || null,
      // When AP got to it, as opposed to the date the vendor wrote on it. The two
      // differ by a week or two routinely — it is the asymmetry the bill-match
      // window is built on, and it belongs on the page rather than in a comment.
      postDate: String(pick(bill, ['PostDate']) || '').slice(0, 10) || null,
      number: pick(bill, ['Reference', 'InvoiceNumber', 'BillNumber', 'ReferenceNumber']),
      vendor: pick(bill, ['VendorName', 'Name', 'PayeeName']),
      amount: money(pick(bill, ['Amount', 'TotalAmount', 'BillAmount', 'Total'])),
      // "Who approved this spend" — asked as a separate question, and the answer
      // was on the bill the whole time. No purchase-order join required.
      approval: bill.IsApproved != null || pick(bill, ['ApprovalDate', 'ApprovalUserID']) ? {
        approved: bill.IsApproved === true,
        by: approvedBy,
        on: String(pick(bill, ['ApprovalDate']) || '').slice(0, 10) || null,
      } : null,
      // Paid, or paid IN FULL — two different claims, and only one of them is
      // what a check proves.
      allocated: pick(bill, ['AmountAllocated']) != null ? {
        amount: money(pick(bill, ['AmountAllocated'])),
        inFull: bill.IsFullyAllocated === true,
      } : null,
      enteredBy: enteredBy,
      enteredOn: String(pick(bill, ['CreateDate']) || '').slice(0, 10) || null,
      // Everything else the record carries and nothing above named. Rather than
      // hand-pick and quietly drop the rest.
      other: billExtras(bill),
      matchConfidence: billMatch ? billMatch.confidence : null,
      // Present when the match was made on ONE LINE of a split invoice — the
      // amount on screen is that line, not the invoice total, and saying so is the
      // difference between a backup that proves the charge and one that confuses it.
      matchedLine: billMatch && billMatch.line ? {
        amount: money(pick(billMatch.line, ['Amount', 'LineAmount', 'Total'])),
        account: pick(billMatch.line, ['GLAccountName', 'AccountName']),
        unit: pick(billMatch.line, ['UnitName', 'UnitNumber', 'Unit']),
        description: pick(billMatch.line, ['Description', 'Memo', 'Comment']),
      } : null,
      // The whole invoice, line by line, capped — a consolidated vendor bill runs
      // to 78 lines and the point is to show what the invoice covers, not to
      // reprint it. This charge's own line is marked.
      lines: Array.isArray(bill.BillDetails) ? bill.BillDetails.slice(0, 25).map(d => ({
        id: pick(d, ['BillDetailID', 'BillDetailId']),
        amount: money(pick(d, ['Amount', 'LineAmount', 'Total'])),
        allocated: money(pick(d, ['AmountAllocated'])),
        propertyId: pick(d, ['PropertyID', 'PropertyId']),
        accountId: pick(d, ['GLAccountID', 'GLAccountId']),
        unit: pick(d, ['UnitName', 'UnitNumber', 'Unit']),
        comment: pick(d, ['Comment', 'Description', 'Memo']),
        isThisCharge: billMatch && billMatch.line
          && String(pick(d, ['BillDetailID', 'BillDetailId'])) === String(pick(billMatch.line, ['BillDetailID', 'BillDetailId'])),
      })) : [],
      lineCount: Array.isArray(bill.BillDetails) ? bill.BillDetails.length : null,
    } : null,
    worksheet,
    attachments: attachments.list,
    payment,
    creditCard: payment && payment.paidByCreditCard ? {
      paid: true,
      account: payment.account,
      method: payment.method,
      statementCharge,
    } : { paid: false },
    unavailable,
    capabilities: caps.verdict,
  };

  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, { at: Date.now(), payload });
  return payload;
}

module.exports = {
  // Test seam: the working attachment and download shapes are remembered after
  // the first success, which is right in production and wrong in a check that
  // swaps Rent Managers between assertions.
  __resetShapeCache: () => { _attachmentShape = undefined; _downloadShape = undefined; },
  // Same seam for the bank directory: it is cached for six hours, which is right
  // in production and wrong in a check that swaps Rent Managers between asserts.
  __resetBankDirectory: () => { _bankDirectoryCache = null; _checkBankEmbed = undefined; _usersCache = null; },
  DOCUMENT_RESOURCES,
  capabilities,
  verdictFor,
  findBill,
  attachmentsFor,
  fetchAttachment,
  paymentFor,
  paymentFromCharge,
  bankDirectory,
  bankFromCheckEmbed,
  billExtras,
  humanLabel,
  describeBank,
  lastFour,
  lastFourFromName,
  creditCardStatementCharge,
  creditCardCharge,
  prefetchCardTransactions,
  __resetCardTxnCache: () => { _cardTxn.clear(); },
  worksheetCheck,
  backupFor,
};
