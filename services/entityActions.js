// Handled entity action items — the shared record of "the team has this one."
//
// ── WHY THIS EXISTS (2026-10-21) ─────────────────────────────────────────────
// The Entities tab now lists, under the grades, what each entity should work on
// (public/index.html, eaFlags): the metric that cost it points, the number
// behind it, and who owns it. The owner asked for those items to be markable as
// done by the team, and "done" only means something if everyone sees the same
// mark — the same lesson services/varianceResolutions.js records, where a
// localStorage note on one laptop left every other browser's list untouched.
// So a handled mark lives here, on the host's persistent disk (data/ is a mounted
// disk — see render.yaml), with who and when.
//
// An item is NOT a stored fact; it is recomputed from the live numbers on every
// load. What is stored is the mark, and the metric's value at the moment it was
// marked. The page compares that to the live value: an item marked handled at
// 91.2% occupancy stays quiet while occupancy holds or improves, and comes back
// on its own — "handled Oct 21 at 91.2%, now 89.0%" — if the number gets worse.
// Marking something handled must never hide a problem that has since grown.
//
// Everything crossing this boundary is browser input, so nothing is trusted:
// keys must match the one namespace the page generates, notes are length-capped,
// the value must be a finite number or nothing, and a file that fails to parse
// degrades to "nothing handled" rather than taking the Entities tab down.

const fs = require('fs');
const path = require('path');

const STORE_DIR = path.join(__dirname, '..', 'data');
// ENTITY_ACTIONS_FILE: the check script points this at a scratch file.
const FILE = process.env.ENTITY_ACTIONS_FILE || path.join(STORE_DIR, 'entity-actions.json');

// The page builds one key per entity per rule: EA:<entity name>:<rule>. The rule
// set is closed (the five below) so a junk key can never match a rendered item
// and keeping it would only grow the file forever.
const RULES = ['occupancy', 'delinquency', 'pl', 'dscr', 'cfPerUnit'];
const KEY_RE = new RegExp(`^EA:[^:]{1,80}:(${RULES.join('|')})$`);
const MAX_NOTE = 500;
const MAX_WHO = 120;

function validKey(k) {
  return typeof k === 'string' && KEY_RE.test(k);
}

// A single stored mark. `at` is ISO (sortable); `date` is the human string the
// page prints; `value` is the metric's figure when it was marked, or null when
// the page had none (a data flag, say), in which case it never reopens itself.
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
  const value = Number.isFinite(Number(o.value)) && o.value !== null && o.value !== '' ? Number(o.value) : null;
  return { note, by, at, date, value };
}

function sanitize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const src = o.handled && typeof o.handled === 'object' ? o.handled : {};
  const handled = {};
  for (const [k, v] of Object.entries(src)) {
    if (!validKey(k)) continue;
    handled[k] = cleanEntry(v, null);
  }
  return {
    version: 1,
    handled,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
    updatedBy: typeof o.updatedBy === 'string' ? o.updatedBy.slice(0, MAX_WHO) : null,
  };
}

function empty() { return sanitize({}); }

// ── disk ─────────────────────────────────────────────────────────────────────
// Sync on purpose: every mutation is load → mutate → save inside one request
// handler, which Node's single thread makes atomic against other requests. An
// async read-modify-write would let two people marking at the same moment lose
// one of the two marks.
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
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // Write-then-rename: a half-written file read by another request would look
  // like "nothing is handled" and put every item back on everyone's list.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, FILE);
  return clean;
}

// ── mutations ────────────────────────────────────────────────────────────────
// Mark one item handled. Marking an already-handled key overwrites it, which is
// how editing the note (or re-marking a reopened item at its new value) works.
function handle(key, note, value, who) {
  if (!validKey(key)) {
    const err = new Error('Unrecognized action key.');
    err.code = 'BAD_KEY';
    throw err;
  }
  const state = load();
  state.handled[key] = cleanEntry({ note, by: who, value }, who);
  return save(state, who);
}

function unhandle(key, who) {
  const state = load();
  delete state.handled[key];
  return save(state, who);
}

// Has the figure moved the wrong way since the mark? `better` is the metric's
// direction ('higher' | 'lower'); `tolerance` is the smallest move worth
// reopening for, in the metric's own unit, so a rounding wobble does not undo
// someone's mark. Shared with the page through the check script, which lifts the
// page's copy and compares it to this one.
function reopened(entry, nowValue, better, tolerance) {
  if (!entry || entry.value == null || nowValue == null || !Number.isFinite(nowValue)) return false;
  const worse = better === 'lower' ? nowValue - entry.value : entry.value - nowValue;
  return worse > (Number.isFinite(tolerance) ? tolerance : 0);
}

module.exports = {
  FILE,
  RULES,
  load,
  save,
  handle,
  unhandle,
  reopened,
  sanitize,
  empty,
  validKey,
};
