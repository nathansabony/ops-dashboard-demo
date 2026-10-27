// Buildings that Rent Manager now carries as two or three properties, read back
// as one on the Variance tab.
//
// The regional manager, 2026-10-19: "they recently split up a few buildings into separate
// buildings in RM. For example 88-90 Maple Court, so now some of the financials
// are being put on one vs the other and getting flagged." The split is real in
// RM — 90 Maple Court (209) collects its own rent — but the bills still land on
// whichever side the person entering them picks. Each side then swings against
// its own history every month and the tracker flags it, when the building as a
// whole did nothing unusual.
//
// So a merge group adds its members into the primary property, series by
// series, before the page sees the snapshot. The snapshot on disk is untouched
// (the budget and renovation tools still read the properties as RM has them);
// only what the Variance tab is served changes. A drill-down on the combined
// building asks Rent Manager for every member's postings, so the invoices still
// say which side they were booked to.
//
// The groups live in config/property-merges.json — hand-maintained, because which
// properties are "the same building" is a call a person makes, not something RM
// records.

const fs = require('fs');
const path = require('path');

// Not data/: on the host that folder is the persistent disk, mounted over the repo's
// copy, so a file committed there never reaches the live site.
const MERGES_FILE = path.join(__dirname, '..', 'config', 'property-merges.json');

function loadGroups(file = MERGES_FILE) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const g of (raw && raw.groups) || []) {
    const primary = Number(g.primary);
    const members = [...new Set((g.members || []).map(Number))].filter(m => Number.isFinite(m) && m !== primary);
    if (!Number.isFinite(primary) || !members.length) continue;
    // A property can only sit in one building; a second claim on it is ignored
    // rather than counting its dollars twice.
    if ([primary, ...members].some(id => seen.has(id))) continue;
    [primary, ...members].forEach(id => seen.add(id));
    out.push({ name: g.name ? String(g.name) : null, primary, members });
  }
  return out;
}

// Every property id a drill-down on `pid` should ask Rent Manager for.
function idsFor(pid, groups = loadGroups()) {
  const n = Number(pid);
  const g = groups.find(x => x.primary === n);
  return g ? [g.primary, ...g.members] : [n];
}

// The primary a member was folded into, or null.
function primaryOf(pid, groups = loadGroups()) {
  const n = Number(pid);
  const g = groups.find(x => x.members.includes(n));
  return g ? g.primary : null;
}

function addSeries(into, src) {
  for (const [k, v] of Object.entries(src)) {
    if (!Array.isArray(v)) continue;
    if (!Array.isArray(into[k])) { into[k] = v.slice(); continue; }
    v.forEach((x, i) => { into[k][i] = Math.round(((into[k][i] || 0) + (x || 0)) * 100) / 100; });
  }
}

// The account trees (what a line opens into) merge the same way, line by line.
function addTrees(into, src) {
  for (const [key, lines] of Object.entries(src || {})) {
    const dst = into[key] || (into[key] = []);
    let prev = -1;
    for (const l of lines) {
      let at = dst.findIndex(d => d.id === l.id);
      if (at < 0) {
        at = prev + 1;
        dst.splice(at, 0, { ...l, ...(l.s ? { s: l.s.slice() } : {}) });
      } else if (l.s) {
        if (!dst[at].s) dst[at].s = l.s.map(() => 0);
        l.s.forEach((v, j) => { dst[at].s[j] = Math.round(((dst[at].s[j] || 0) + (v || 0)) * 100) / 100; });
      }
      prev = at;
    }
  }
  return into;
}

// A copy of the snapshot with each group's members added into its primary.
// Entity and portfolio totals are already sums over every property, so they
// do not change.
function apply(cache, groups = loadGroups()) {
  if (!cache || !cache.properties || !groups.length) return cache;
  const properties = { ...cache.properties };
  const trees = cache.accounts && cache.accounts.properties ? { ...cache.accounts.properties } : null;
  const merges = [];
  for (const g of groups) {
    const base = properties[g.primary];
    const present = g.members.filter(m => properties[m]);
    if (!base || !present.length) continue;
    const combined = { ...base };
    for (const k of Object.keys(combined)) if (Array.isArray(combined[k])) combined[k] = combined[k].slice();
    for (const m of present) addSeries(combined, properties[m]);
    combined.name = g.name || base.name;
    combined.mergedFrom = [g.primary, ...present].map(id => ({ id, name: (cache.properties[id] || {}).name || String(id) }));
    properties[g.primary] = combined;
    present.forEach(m => { delete properties[m]; });
    if (trees) {
      const t = addTrees({}, trees[g.primary] || {});
      for (const m of present) addTrees(t, trees[m] || {});
      trees[g.primary] = t;
      present.forEach(m => { delete trees[m]; });
    }
    merges.push({ name: combined.name, primary: g.primary, members: present });
  }
  if (!merges.length) return cache;
  const out = { ...cache, properties, propertyMerges: merges };
  if (trees) out.accounts = { ...cache.accounts, properties: trees };
  return out;
}

module.exports = { MERGES_FILE, loadGroups, idsFor, primaryOf, apply };
