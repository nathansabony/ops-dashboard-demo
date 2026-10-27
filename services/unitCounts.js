// Per-entity unit counts, pulled live from Rent Manager.
//
// The budget model expresses half its benchmark checks per unit ($/unit/yr for
// insurance, R&M, payroll, advertising, reserves — BUDGET-BENCHMARKS.md), and
// replacement reserves are literally computed as $/unit/yr, so a wrong unit count
// silently moves real dollars. The frontend has always carried a hardcoded map;
// this pulls the real thing from /Units joined to the same property→entity map
// the P&L pipeline uses, so both sides of the tab agree on what an entity is.
//
// Cheap (one paged /Units sweep) and cached to disk like the other snapshots —
// unit counts change a few times a year, not a few times an hour.

const fs = require('fs');
const path = require('path');
const rentManager = require('./rentManagerClient');
const { buildPropertyEntityMap, ENTITY_NAMES } = require('./entityMap');

const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'unit-counts-cache.json');
// No timer — the site serves the last pull until the refresh button is pressed.
// Set UNITS_AUTO_REFRESH_MS to a millisecond interval to bring one back.
const STALE_MS = Number(process.env.UNITS_AUTO_REFRESH_MS || 0); // half a day
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

let _cache = null;
let _building = null;
let _lastError = null;

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.Results || payload.Items || payload.Data || [];
}

async function loadAllUnits() {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = asRows(await rentManager.Units({
      pageSize: PAGE_SIZE,
      pageNumber: page,
      fields: 'UnitID,PropertyID,Name,IsActive',
    }));
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

async function build() {
  const { byId } = await buildPropertyEntityMap(rentManager);
  const units = await loadAllUnits();

  const byEntity = {};
  const byProperty = {};
  // Every property's units, entity or not (2026-10-22). byProperty above is the
  // entity view and deliberately skips properties outside the map, but the
  // Service Requests board prints open tickets per 100 units for any building,
  // and its second and third rows — 7112-7312 Boulevard East (352 units) and
  // Countryside (181) — belong to no tracked entity, so they read "no figure".
  // 1,460 of 4,894 units sat in that gap. Nothing else reads this field.
  const byPropertyAll = {};
  for (const name of ENTITY_NAMES) byEntity[name] = 0;

  let unmapped = 0;
  for (const u of units) {
    const pid = Number(u.PropertyID ?? u.PropertyId ?? u.propertyID);
    if (Number.isFinite(pid)) byPropertyAll[pid] = (byPropertyAll[pid] || 0) + 1;
    const meta = byId.get(pid);
    // A unit on a property outside the entity map (sold/former, or a billing LLC
    // we don't track) is counted as unmapped rather than dropped silently — a
    // large number here means the entity map needs a look.
    if (!meta) { unmapped += 1; continue; }
    byEntity[meta.entity] = (byEntity[meta.entity] || 0) + 1;
    byProperty[pid] = (byProperty[pid] || 0) + 1;
  }

  return {
    refreshedAt: new Date().toISOString(),
    total: Object.values(byEntity).reduce((s, v) => s + v, 0),
    unmapped,
    byEntity,
    byProperty,
    byPropertyAll,
    source: '/Units joined to the RM property→entity map (services/entityMap.js)',
  };
}

function loadSnapshot() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); } catch { _cache = null; }
  return _cache;
}

function saveSnapshot(payload) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(payload));
  } catch (err) {
    _lastError = `snapshot write failed: ${err.message}`;
  }
}

function startBuild() {
  if (_building) return _building;
  _lastError = null;
  _building = build()
    .then(payload => { _cache = payload; saveSnapshot(payload); return payload; })
    .catch(err => { _lastError = err.message; throw err; })
    .finally(() => { _building = null; });
  return _building;
}

// Serve the cache immediately; refresh in the background when stale. Never blocks
// a page load on an RM call.
function getStatus() {
  const cache = loadSnapshot();
  if (!_building && rentManager.isConfigured()) {
    const age = cache ? Date.now() - Date.parse(cache.refreshedAt || 0) : Infinity;
    if (STALE_MS > 0 && (!Number.isFinite(age) || age > STALE_MS)) startBuild().catch(() => {});
  }
  return { cache, building: Boolean(_building), lastError: _lastError };
}

// Convenience for the budget routes: { entityName: unitCount }. Empty object when
// nothing is cached yet — the budget still builds, it just skips per-unit checks.
function byEntity() {
  const { cache } = getStatus();
  return (cache && cache.byEntity) || {};
}

module.exports = { getStatus, startBuild, byEntity, loadSnapshot, SNAPSHOT_FILE };
