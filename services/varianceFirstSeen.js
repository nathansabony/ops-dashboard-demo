// When each variance flag was first seen — the shared record behind the
// Variances dashboard's "still open since {Mon}" tag.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The owner's pre-mortem for the dashboard (2026-10-21): "the Top 5 stopped
// changing — same five flags for weeks". A list that never moves stops being
// read. So a flag that has stayed open past one review cycle drops below FRESH
// flags of the same score in the Top 5 and wears a grey "still open since Aug"
// chip. The score still dominates — a stale 5 stays above a fresh 4 — the tag
// only breaks ties, so a big problem nobody has fixed never hides.
//
// Flags are computed in the browser from the live P&L; nothing on the server
// knew when one first appeared (resolutions record when one was CLOSED, not
// when it opened). So the page posts the ids it is showing, once per P&L pull,
// and this file keeps the first date each id was ever posted. It is shared for
// the same reason resolutions are: "first seen" is the team's date, not the
// date one laptop happened to open the tab.
//
// Same shape as services/varianceResolutions.js, on purpose:
//   • sync load / save, so load → mutate → save inside one request is atomic on
//     Node's single thread (two tabs posting at once cannot lose a date);
//   • write-then-rename, so a half-written file is never read as "nothing seen"
//     (which would reset every flag to fresh — harmless, but wrong);
//   • every input sanitized — ids are browser input, so they must look like a
//     varFlagId() string and are length-capped; junk is dropped, never stored;
//   • a corrupt file degrades to empty, and nothing here throws into the tab.
//     Losing the dates only means no tags show; a 500 would be an outage.
//
// Bounded: at most 2,000 ids per call (the portfolio raises a few hundred) and
// 20,000 entries in the file — past that the OLDEST dates are dropped, which are
// the flags most likely long gone.

const fs = require('fs');
const path = require('path');

const STORE_DIR = path.join(__dirname, '..', 'data');
// VARIANCE_FIRST_SEEN_FILE: the check script points this at a scratch file.
const FILE = process.env.VARIANCE_FIRST_SEEN_FILE || path.join(STORE_DIR, 'variance-first-seen.json');

// varFlagId(f) in public/index.html is `${scope.key}|${key}|${monthLabel}|${reason}`:
//   scope.key   'prop:<id>', an entity name, 'ALL', or 'group:<line>:<month>[:<entity>]'
//   key         the P&L line key
//   monthLabel  'Aug 26', 'Jun–Jul 26', or '' (a trend / move flag may have none)
//   reason      'mom', 'singleMonth', 'varGroup', 'zeroRun', … — a word
// Exactly three pipes, no control characters, a non-empty scope and line. Anything
// else can never match a rendered flag, so storing it would only grow the file.
const ID_RE = /^[^|\u0000-\u001f]{1,200}\|[^|\u0000-\u001f]{1,120}\|[^|\u0000-\u001f]{0,40}\|[A-Za-z0-9_-]{0,40}$/;
const MAX_ID = 300;
const MAX_PER_CALL = 2000;
const MAX_ENTRIES = 20000;

function validId(id) {
  return typeof id === 'string' && id.length <= MAX_ID && ID_RE.test(id);
}

function validIso(s) {
  return typeof s === 'string' && s.length <= 40 && Number.isFinite(Date.parse(s));
}

// Drops junk ids and junk dates, then — if the map is over the cap — keeps the
// newest MAX_ENTRIES (ISO strings sort by time).
function sanitize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const src = o.seen && typeof o.seen === 'object' && !Array.isArray(o.seen) ? o.seen : {};
  let entries = Object.entries(src).filter(([k, v]) => validId(k) && validIso(v))
    .map(([k, v]) => [k, new Date(v).toISOString()]);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
    entries = entries.slice(0, MAX_ENTRIES);
  }
  const seen = {};
  entries.forEach(([k, v]) => { seen[k] = v; });
  return {
    version: 1,
    seen,
    updatedAt: validIso(o.updatedAt) ? o.updatedAt : null,
  };
}

function empty() { return sanitize({}); }

// ── disk ─────────────────────────────────────────────────────────────────────
function load() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    return empty();
  }
}

function save(state) {
  const clean = sanitize(state);
  clean.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // Write-then-rename: see the note at the top.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, FILE);
  return clean;
}

// ── the one mutation ─────────────────────────────────────────────────────────
// Record these ids: any not seen before get `now`; any already seen keep their
// first date (that is the whole point). Returns { [id]: iso } for the valid ids
// asked about — never the whole file, which the page has no use for. Writes only
// when something new was added, so the page posting the same set on every pull
// costs a read and no write. A failed write still answers with what is known:
// the tags are a nicety and must never take the tab down.
function record(ids, now) {
  const list = Array.isArray(ids) ? ids : [];
  const want = [...new Set(list.slice(0, MAX_PER_CALL).filter(validId))];
  const state = load();
  const at = validIso(now) ? new Date(now).toISOString() : new Date().toISOString();
  let added = 0;
  want.forEach(id => {
    if (!state.seen[id]) { state.seen[id] = at; added++; }
  });
  let saved = state;
  if (added) {
    try { saved = save(state); } catch { saved = state; }
  }
  const out = {};
  // `saved` may have dropped the oldest entries to stay under the cap; fall back
  // to the in-memory date so an id asked about always gets an answer.
  want.forEach(id => { out[id] = saved.seen[id] || state.seen[id]; });
  return out;
}

module.exports = {
  FILE,
  MAX_PER_CALL,
  MAX_ENTRIES,
  load,
  save,
  record,
  sanitize,
  empty,
  validId,
};
