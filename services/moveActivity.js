// Move-in / move-out activity per property per month — the Variance tab's
// leasing-signal source.
//
// Source: RM /Leases, which carries the ACTUAL MoveInDate / MoveOutDate per lease
// (verified live 2026-07-20: rows expose MoveInDate, MoveOutDate,
// ExpectedMoveOutDate, NoticeDate, IsMoveOutConfirmed, PropertyID). We count
// move-ins and move-outs by calendar month per property, then roll up to entities
// and the portfolio — same scope keys as the P&L payload so the frontend can align
// them ("Jan 24"-style labels).
//
// Why it exists (the owner's July-2026 spec): see when move-outs spike (maybe an
// issue), praise leasing when move-ins surge, and flag occupancy declining
// (net move activity negative) 2+ months in a row.

const rentManager = require('./rentManagerClient');
const { buildPropertyEntityMap } = require('./entityMap');

const MON_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabels(fromYM, toYM) {
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const out = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ label: `${MON_LABEL[m - 1]} ${String(y).slice(2)}`, y, m });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.Results || payload.Items || payload.Data || [];
}

async function loadAllLeases() {
  const pageSize = 1000;
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const rows = asRows(await rentManager.Leases({ pagesize: pageSize, pagenumber: page }));
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

// "2026-07-03T00:00:00" → month index within `months`, or -1.
function monthIndexOf(dateStr, idxByYM) {
  if (!dateStr) return -1;
  const m = String(dateStr).match(/^(\d{4})-(\d{2})/);
  if (!m) return -1;
  const key = `${m[1]}-${m[2]}`;
  return idxByYM.has(key) ? idxByYM.get(key) : -1;
}

function emptyCounts(n) {
  return { moveIns: Array(n).fill(0), moveOuts: Array(n).fill(0) };
}
function addCounts(t, s) {
  for (let i = 0; i < s.moveIns.length; i++) { t.moveIns[i] += s.moveIns[i]; t.moveOuts[i] += s.moveOuts[i]; }
}

// Build the full payload. Window: the same rolling 36 months + current month as
// the P&L pull (propertyFinancials.pullWindowFrom) — kept identical so the move
// rows line up with the P&L months. (The page matches them by label, but one
// definition of the window is still the safer contract.)
async function buildMoveActivity() {
  const now = new Date();
  const fromYM = require('./propertyFinancials').pullWindowFrom(now);
  const toYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const months = monthLabels(fromYM, toYM);
  const idxByYM = new Map(months.map((m, i) => [`${m.y}-${String(m.m).padStart(2, '0')}`, i]));
  const n = months.length;

  const [{ byId }, leases] = await Promise.all([
    buildPropertyEntityMap(rentManager),
    loadAllLeases(),
  ]);

  const properties = {};
  const entities = {};
  const portfolio = emptyCounts(n);
  for (const [pid, meta] of byId) properties[pid] = { name: meta.name, entity: meta.entity, ...emptyCounts(n) };

  const todayYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (const lease of leases) {
    const pid = Number(lease.PropertyID);
    const prop = properties[pid];
    if (!prop) continue; // outside the mapped portfolio (sold/former/unmapped)
    const mi = monthIndexOf(lease.MoveInDate, idxByYM);
    if (mi >= 0) prop.moveIns[mi] += 1;
    // Actual move-outs only: a date in the future is a scheduled/expected move-out,
    // not one that happened — don't count it yet.
    const moDate = String(lease.MoveOutDate || '').slice(0, 10);
    const mo = monthIndexOf(lease.MoveOutDate, idxByYM);
    if (mo >= 0 && moDate <= todayYM) prop.moveOuts[mo] += 1;
  }

  for (const prop of Object.values(properties)) {
    if (!entities[prop.entity]) entities[prop.entity] = emptyCounts(n);
    addCounts(entities[prop.entity], prop);
    addCounts(portfolio, prop);
  }

  return {
    configured: true,
    refreshedAt: now.toISOString(),
    partialCurrentMonth: true, // window always ends at the in-progress month
    months: months.map(m => m.label),
    portfolio,
    entities,
    properties,
    sources: { resource: '/Leases', leases: leases.length, propertyCount: Object.keys(properties).length },
  };
}

// Cache: in-memory, stale-while-revalidate (same model as the live overview).
// A full /Leases pull is a handful of paged calls — cheap enough to refresh on
// a 30-minute staleness check, no disk snapshot needed.
// No timer — the site serves the last pull until the refresh button is pressed.
// Set MOVES_AUTO_REFRESH_MS to a millisecond interval to bring one back.
const STALE_MS = Number(process.env.MOVES_AUTO_REFRESH_MS || 0);
let _cache = null;
let _building = null;
let _lastError = null;

function refresh() {
  if (_building) return _building;
  _lastError = null;
  _building = buildMoveActivity()
    .then(payload => { _cache = payload; return payload; })
    .catch(err => { _lastError = err.message; throw err; })
    .finally(() => { _building = null; });
  return _building;
}

// Serve cache immediately; kick a background refresh when empty or stale.
function getStatus() {
  if (rentManager.isConfigured()) {
    const age = _cache ? Date.now() - Date.parse(_cache.refreshedAt || 0) : Infinity;
    const stale = STALE_MS > 0 && (!Number.isFinite(age) || age > STALE_MS);
    if (!_building && (!_cache || stale)) refresh().catch(() => {});
  }
  return { cache: _cache, building: Boolean(_building), lastError: _lastError };
}

module.exports = { buildMoveActivity, getStatus, refresh };
