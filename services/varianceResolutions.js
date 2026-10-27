// Resolved variance flags — the shared, server-side record of "we looked at this
// one and it's fine."
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Resolving a flag used to write to localStorage and nowhere else. That made it
// a private note: the regional manager could work through thirty flags on his laptop and the
// list the owner opened five minutes later was untouched, because the resolutions
// had never left the regional manager's browser. Same person on a second machine saw them all
// again. Clearing site data threw the work away silently.
//
// A variance review is a TEAM activity — the whole value of the flag list is
// that it shrinks as the month gets worked, and that only means something if
// everyone is looking at the same list. So resolutions live here, on the host's
// persistent disk (data/ is a mounted disk — see render.yaml), and every browser
// reads the same file.
//
// Two things follow from that, both deliberate:
//   • A resolution records WHO and WHEN, because a shared list needs an audit
//     trail. "Marked normal" is useless six weeks later; "the regional manager, Jul 29, tax
//     appeal refund posted in one lump" is the answer to the question someone
//     will actually ask.
//   • Nothing here is destructive by default. Restoring a flag deletes its
//     resolution, but the bulk clear is a separate, explicit call — a stray
//     click must never wipe a month of everyone's review work.
//
// Everything crossing this boundary is browser input, so nothing is trusted:
// keys must match the two known namespaces, notes are length-capped, and a file
// that fails to parse degrades to "nothing resolved" rather than taking the
// Variance tab down. Showing a flag that was already resolved is a nuisance;
// throwing a 500 into the tab is an outage.

const fs = require('fs');
const path = require('path');

const STORE_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(STORE_DIR, 'variance-resolutions.json');

// The two key namespaces the frontend generates (see public/index.html):
//   RR:<scope>:<lineKey>     month-over-month / run-rate flags + the heatmap
//   YOY:<scope>:<label>      the Year-over-Year table
// where <scope> is 'ALL', 'E:<entity name>', or 'prop:<id>'. Anything else is
// either a bug or someone poking the API, and is dropped rather than stored —
// junk keys can never match a rendered flag, so keeping them would only grow
// the file forever.
const KEY_RE = /^(RR|YOY):[^:]*(:[^:]*)?:.+$/;
const MAX_KEY = 300;
const MAX_NOTE = 500;
const MAX_WHO = 120;
const THROUGH_RE = /^[A-Z][a-z]{2} \d{2}$/;   // a P&L month label, e.g. "Sep 26"

// A single stored resolution. `at` is ISO (sortable, unambiguous); `date` is the
// human string the UI already prints, kept so an imported localStorage entry
// keeps the date it was actually resolved on rather than its import date.
function cleanEntry(raw, fallbackWho) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const note = typeof o.note === 'string' ? o.note.trim().slice(0, MAX_NOTE) : '';
  const by = typeof o.by === 'string' && o.by.trim()
    ? o.by.trim().slice(0, MAX_WHO)
    : (fallbackWho ? String(fallbackWho).slice(0, MAX_WHO) : null);
  const at = typeof o.at === 'string' && o.at ? o.at : new Date().toISOString();
  const date = typeof o.date === 'string' && o.date
    ? o.date.slice(0, 40)
    : new Date(at).toLocaleDateString('en-US');
  // Optional: the last month this resolution explains ("Sep 26"). Without it a
  // resolution silences the line for good, which is what "Mark normal" has always
  // done. With it, a later month on the same line flags again (2026-10-16:
  // resolving a one-off credit must not hide next year's real spike).
  const through = typeof o.through === 'string' && THROUGH_RE.test(o.through.trim()) ? o.through.trim() : null;
  return through ? { note, by, at, date, through } : { note, by, at, date };
}

function validKey(k) {
  return typeof k === 'string' && k.length <= MAX_KEY && KEY_RE.test(k);
}

function sanitize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const src = o.resolutions && typeof o.resolutions === 'object' ? o.resolutions : {};
  const resolutions = {};
  for (const [k, v] of Object.entries(src)) {
    if (!validKey(k)) continue;
    resolutions[k] = cleanEntry(v, null);
  }
  return {
    version: 1,
    resolutions,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
    updatedBy: typeof o.updatedBy === 'string' ? o.updatedBy.slice(0, MAX_WHO) : null,
  };
}

function empty() { return sanitize({}); }

// ── disk ─────────────────────────────────────────────────────────────────────
// Sync on purpose. Every mutation below is load → mutate → save inside a single
// request handler, and Node's single thread makes that sequence atomic with
// respect to other requests. Going async here would open a read-modify-write
// race where two people resolving at the same moment lose one of the two.
function load() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    return empty();
  }
}

function save(state, who) {
  const clean = sanitize(state);
  clean.updatedAt = new Date().toISOString();
  clean.updatedBy = who ? String(who).slice(0, MAX_WHO) : null;
  fs.mkdirSync(STORE_DIR, { recursive: true });
  // Write-then-rename: a half-written file read by another request would look
  // like "nothing is resolved" and put every flag back on everyone's list.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, FILE);
  return clean;
}

// ── mutations ────────────────────────────────────────────────────────────────
// Resolve one flag. Re-resolving an already-resolved key overwrites it, which is
// how editing a reason works from the UI.
function resolve(key, note, who, through) {
  if (!validKey(key)) {
    const err = new Error('Unrecognized flag key.');
    err.code = 'BAD_KEY';
    throw err;
  }
  const state = load();
  state.resolutions[key] = cleanEntry({ note, by: who, through }, who);
  return save(state, who);
}

function unresolve(key, who) {
  const state = load();
  delete state.resolutions[key];
  return save(state, who);
}

// Restore everything. Deliberately separate from unresolve() and never reachable
// from a single click in the UI — this throws away the whole team's review.
function clearAll(who) {
  return save(empty(), who);
}

// ── one-time migration off localStorage ──────────────────────────────────────
// Every browser that still holds pre-server resolutions pushes them here on its
// first load of the new build. Existing server entries WIN: a stale tab that
// somehow imports twice, or a second machine carrying an older copy of the same
// key, must never overwrite a resolution that is already shared. So this only
// ever adds keys nobody has resolved yet, which makes it safe to call on every
// page load — it converges and then does nothing.
function importMissing(map, who) {
  if (!map || typeof map !== 'object') return { added: 0, state: load() };
  const state = load();
  let added = 0;
  for (const [k, v] of Object.entries(map)) {
    if (!validKey(k) || state.resolutions[k]) continue;
    // Imported entries keep their original date but are attributed to whoever's
    // browser carried them — that browser IS the provenance we have.
    state.resolutions[k] = cleanEntry(v, who);
    added++;
  }
  if (!added) return { added: 0, state };
  return { added, state: save(state, who) };
}

module.exports = {
  FILE,
  load,
  save,
  resolve,
  unresolve,
  clearAll,
  importMissing,
  sanitize,
  empty,
  validKey,
};
