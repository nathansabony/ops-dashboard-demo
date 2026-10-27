// ── what the sweep already worked out ────────────────────────────────────────
//
// The coverage sweep resolves all 28,261 charges: which bill each one belongs to
// and whether that bill carries a document. The per-charge lookup then threw that
// away and searched again from scratch — and searched *less* widely, a fortnight
// either side of the posting rather than the vendor's whole ledger. So the tab
// found fewer documents than the headline claimed, and the number people could
// see was the weaker of the two.
//
// This reads the sweep's own answer back. A click becomes one request for a known
// bill instead of a dozen speculative ones, and the tab and the headline can no
// longer disagree.
//
// It is a cache of an answer, not a source of truth: a charge the sweep has not
// seen (added since the last run) is simply absent, and the caller falls back to
// searching. Absent means "not indexed", never "no document".

// Resolved on use, not at load. rmDocuments requires this, this needs the
// coverage sweep, and the sweep's own dependencies reach back — a top-level
// require in that cycle hands back a half-built module whose exports are not
// there yet, and the failure looks like "status is not a function" from a file
// that plainly exports one.
const coverage = () => require('./backupCoverage');

let _map = null;
let _builtFrom = null;

function payload() {
  const st = coverage().status();
  const cache = st && st.cache;
  return cache && cache.data ? { data: cache.data, at: cache.refreshedAt } : null;
}

// Rebuilt whenever the sweep behind it has been refreshed, so a re-run takes
// effect without a restart.
function index() {
  const p = payload();
  if (!p) return null;
  if (_map && _builtFrom === p.at) return _map;
  const m = new Map();
  for (const row of p.data.resolved || []) {
    const parts = String(row).split('|');
    if (parts.length < 3) continue;
    const billId = parts.pop();
    const kind = parts.pop();
    const chargeId = parts.join('|');   // ids can contain the separator
    if (chargeId) m.set(chargeId, { kind, billId: billId || null });
  }
  _map = m;
  _builtFrom = p.at;
  return _map;
}

// ── a statement is not an invoice ────────────────────────────────────────────
// An audit of 448 matches found 110 of them resolving to just four bills, all
// consolidated statements, at a median charge of $0.50. Those matches are not
// wrong — the check's own line id points at them — but the document behind them
// is a fifty-page statement covering hundreds of purchases, and offering that as
// "the invoice" for a 50c charge is true in a way that is useless, and looks
// broken to whoever clicks it.
//
// Fan-out is the tell, but fan-out ALONE is not: a single renovation invoice is
// routinely split across dozens of unit and account lines, so the first version
// of this rule — bill backs 25+ charges, therefore statement — labelled 13,214
// of the 15,280 documented charges a statement, against 111 the audit actually
// found. It demoted 251 matches whose document literally contains the charge's
// own invoice number.
//
// So the fan-out test only applies to charges that had no invoice number to
// begin with. A charge whose description carried an invoice number was matched
// BY that number, and the audit read the number back out of the document in 96%
// of them — that is a charge-level link, and no amount of fan-out on the bill
// changes it. What is left is the check-line route: no number to match on, the
// bill reached through the check that paid it, and a bill that hundreds of other
// charges also point at. That is the statement case, and on the audit sample the
// two conditions together agree with the read-the-document verdict 93% of the
// time where fan-out alone managed 51%.
const STATEMENT_FANOUT = 25;

function fanout() {
  const m = index();
  if (!m) return null;
  if (_fan && _fanFrom === m) return _fan;
  const perBill = new Map();
  for (const { billId } of m.values()) {
    if (billId) perBill.set(billId, (perBill.get(billId) || 0) + 1);
  }
  _fan = perBill;
  _fanFrom = m;   // the map itself, so a rebuilt index always recounts
  return _fan;
}
let _fan = null;
let _fanFrom = null;

// The invoice numbers live on the renovation snapshot, not in the sweep's own
// output, so this reads them across rather than forcing a two-hour re-sweep to
// carry one more field. Same lazy-require reason as the coverage module above.
const renovations = () => require('./renovationExpenses');
let _invoiced = null;
let _invoicedFrom = null;

function invoicedIds() {
  let snap = null;
  try {
    snap = renovations().status().cache;
  } catch (err) {
    return null;                       // no snapshot loaded; caller falls back
  }
  const rows = snap && snap.data && Array.isArray(snap.data.charges) ? snap.data.charges : null;
  if (!rows) return null;
  const stamp = snap.refreshedAt || rows.length;
  if (_invoiced && _invoicedFrom === stamp) return _invoiced;
  const set = new Set();
  for (const c of rows) {
    if (c && c.id && String(c.invoiceNo || '').trim()) set.add(c.id);
  }
  _invoiced = set;
  _invoicedFrom = stamp;
  return _invoiced;
}

/** Was this charge matched by an invoice number it carried itself? */
function invoiceLinked(chargeId) {
  const set = invoicedIds();
  return !!(set && chargeId && set.has(chargeId));
}

/** How many charges lean on this bill — hundreds means a statement. */
function chargesOnBill(billId) {
  const f = fanout();
  return (f && billId && f.get(String(billId))) || 0;
}

// chargeId is optional only so a caller without one still gets the old fan-out
// answer; pass it wherever it is known, because without it a split invoice is
// indistinguishable from a statement.
function isStatement(billId, chargeId) {
  if (chargeId && invoiceLinked(chargeId)) return false;
  return chargesOnBill(billId) >= STATEMENT_FANOUT;
}

/** What the sweep decided for this charge, or null if it has not seen it. */
function lookup(chargeId) {
  if (!chargeId) return null;
  const m = index();
  return (m && m.get(chargeId)) || null;
}

function status() {
  const p = payload();
  const m = index();
  return { entries: m ? m.size : 0, sweptAt: p ? p.at : null };
}

module.exports = {
  lookup, status, isStatement, chargesOnBill, invoiceLinked, STATEMENT_FANOUT,
  // Clears BOTH caches. The fan-out counts are derived from the index, so leaving
  // them behind hands back an answer about a sweep that is no longer loaded — and
  // it keys off the same timestamp, so two sweeps stamped alike would silently
  // reuse the first one's counts.
  __reset: () => {
    _map = null; _builtFrom = null; _fan = null; _fanFrom = null;
    _invoiced = null; _invoicedFrom = null;
  },
};
