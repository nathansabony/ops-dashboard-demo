// % Collected per entity — the Delinquency tab's "charged vs actually paid"
// analysis (the owner + the regional manager, 2026-07-22 meeting).
//
// Source: RM report 30 "ChargeDetail". Its Grid2 is the SUMMARY the meeting
// asked for (per charge type: AmountCharged / AmountPaid / Balance for every
// charge whose transaction date falls in the window) — we never render the
// 200-page Grid1 detail. Verified live 2026-07-22 on The Alder: Grid2 rows carry
// ReportSummaryChargeType / AmountCharged / AmountPaid.
//
// EXCLUSIONS (per the meeting, noted in the UI): charge types TAX (property
// taxes, ChargeTypeID 53) and LD (liquidated damages, 62) are excluded from
// the % — we track what tenants owe us for occupancy, not tax pass-throughs or
// damage settlements. The excluded dollars are still reported so the note can
// say what was left out.
//
// Windows: last 30 / 60 / 90 days, the last COMPLETE calendar quarter, and the
// last 12 months (rolling 365 days). % collected = paid / charged. Goal ≥98%.
//
// Cost: one report run per entity per window (Grid2 is per-run — RM offers no
// per-entity grouping inside a single run) = ~13×5 = 65 runs. That's minutes,
// so this builds in the background behind a stale-while-revalidate cache with
// a disk snapshot (survives restarts / the host deploys on the persistent disk).

const fs = require('fs');
const path = require('path');
const rentManager = require('./rentManagerClient');
const { buildPropertyEntityMap } = require('./entityMap');
const delinquencyReport = require('./delinquencyReport');

const EXCLUDED_CHARGE_TYPES = ['TAX', 'LD'];
const GOAL_PCT = 0.98;
const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'charged-collections-cache.json');
// No timer: the site serves the last pull until the refresh button is pressed.
// ~78 report runs a refresh, so this is not a cheap thing to do on a schedule
// nobody asked for. Set COLLECTIONS_AUTO_REFRESH_MS to re-enable a timer.
const STALE_MS = Number(process.env.COLLECTIONS_AUTO_REFRESH_MS || 0);
const RUN_CONCURRENCY = 3;           // stay well under RM's ~8-session cap

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The five windows, all ending today except the complete calendar quarter.
function buildWindows(now) {
  const daysAgo = n => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };
  const qEndMonth = Math.floor(now.getMonth() / 3) * 3; // start month of current quarter
  const qEnd = new Date(now.getFullYear(), qEndMonth, 0);            // last day of previous quarter
  const qStart = new Date(qEnd.getFullYear(), qEnd.getMonth() - 2, 1);
  return [
    { key: 'd30', label: 'Last 30 days', start: ymd(daysAgo(30)), end: ymd(now) },
    { key: 'd60', label: 'Last 60 days', start: ymd(daysAgo(60)), end: ymd(now) },
    { key: 'd90', label: 'Last 90 days', start: ymd(daysAgo(90)), end: ymd(now) },
    { key: 'quarter', label: `Last quarter (${qStart.toLocaleString('en-US', { month: 'short' })}–${qEnd.toLocaleString('en-US', { month: 'short' })} ${qEnd.getFullYear()})`, start: ymd(qStart), end: ymd(qEnd) },
    { key: 'y1', label: 'Last 12 months', start: ymd(daysAgo(365)), end: ymd(now) },
  ];
}

function reportParamQuery(pairs) {
  const params = {};
  pairs.forEach(([k, v], i) => {
    params[`parameters[${i}].Parameter`] = k;
    params[`parameters[${i}].Value`] = v;
    params[`parameters[${i}].InListItemMode`] = 'false';
  });
  return params;
}

// One parser for every RM figure — see services/rmAmount.js. The local one this
// replaced stripped commas ONLY, so a currency-formatted figure came through as 0
// and a parenthesised credit was discarded instead of subtracted.
const { parseAmount: num } = require('./rmAmount');

// Report 85 (Delinquency) used to be run here, once per entity plus once for the
// portfolio. It now lives in services/delinquencyReport as a single all-property
// run shared with /api/delinquency — see the note in buildCollections below.

// One ChargeDetail run → { charged, paid, excludedCharged, byType } from Grid2.
async function runGrid2(propertyIds, start, end, customerStatus) {
  const body = await rentManager.RunReport(30, reportParamQuery([
    ['StartDate', start],
    ['EndDate', end],
    ['PropertyIDs', propertyIds.join(',')],
    ['SHOWINACTIVEPROPS', 'False'],
    ['GroupID', '0'],
    ['BatchProps', 'False'],
    ['CHARGESTOINCLUDE', 'All'],
    ['SORTOPTIONS', '0'],
    ['CustomerStatus', String(customerStatus)],
  ]));
  return (body && body.Grid2) || [];
}

// ── the tenants this card leaves out ────────────────────────────────────────
// CustomerStatus is a bitmask: 1 = former, 2 = current + notice, 3 = both
// (billingCohorts verified 2's rows + 1's rows == 3's rows exactly). This card
// has always run status 2, which matches what the regional manager pulls — and quietly drops
// every charge belonging to someone who has since moved out.
//
// That is the "$50, $60 off on one unit" from the 2026-08-25 meeting. The guess
// in the room was mid-month move-in proration; proration is inside RM's own
// AmountCharged and there is no proration arithmetic on this side to get wrong.
// What the report actually shows, measured on Willow Creek over 180 days: status 1
// carries $2,200 of CLEAN and DAMAGE — move-out cleaning and damage billed to a
// departing tenant, absent from the card and present in a wider-scope export.
//
// The headline stays on status 2 so the card still ties to the export the regional manager
// runs. What changes is that the omission is reported instead of invisible.
const FORMER_TENANT_STATUS = 1;

async function runWindow(propertyIds, start, end) {
  const rows = await runGrid2(propertyIds, start, end, 2);
  let charged = 0, paid = 0, excludedCharged = 0, excludedPaid = 0;
  const byType = [];
  for (const r of rows) {
    const type = String(r.ReportSummaryChargeType || '').trim();
    const c = num(r.ReportSummaryAmountCharged);
    const p = num(r.ReportSummaryAmountPaid);
    if (EXCLUDED_CHARGE_TYPES.includes(type)) { excludedCharged += c; excludedPaid += p; continue; }
    charged += c; paid += p;
    byType.push({ type, description: r.ReportSummaryDescription || '', charged: c, paid: p });
  }
  byType.sort((a, b) => b.charged - a.charged);

  // Cheap: former-tenant rows are a handful and the run is under a second.
  let former;
  try {
    let fc = 0, fp = 0;
    const fTypes = [];
    for (const r of await runGrid2(propertyIds, start, end, FORMER_TENANT_STATUS)) {
      const type = String(r.ReportSummaryChargeType || '').trim();
      if (EXCLUDED_CHARGE_TYPES.includes(type)) continue;
      const c = num(r.ReportSummaryAmountCharged);
      const p = num(r.ReportSummaryAmountPaid);
      if (!c && !p) continue;
      fc += c; fp += p;
      fTypes.push({ type, description: r.ReportSummaryDescription || '', charged: c, paid: p });
    }
    fTypes.sort((a, b) => b.charged - a.charged);
    former = { charged: Math.round(fc * 100) / 100, paid: Math.round(fp * 100) / 100, byType: fTypes };
  } catch (err) {
    // A scope we could not read is unknown, not zero — better to say so than to
    // imply nothing was left out.
    former = { error: String(err && err.message ? err.message : err).slice(0, 160) };
  }

  return {
    // Charges belonging to tenants who have since moved out. Deliberately not in
    // the headline — that ties to the export — but no longer invisible.
    formerTenants: former,
    charged: Math.round(charged * 100) / 100,
    paid: Math.round(paid * 100) / 100,
    pct: charged > 0 ? paid / charged : null,
    excludedCharged: Math.round(excludedCharged * 100) / 100,
    excludedPaid: Math.round(excludedPaid * 100) / 100,
    // EVERY charge type, not the top 12 (2026-08-25). The truncation was there to
    // keep a drill-down short, but it also meant the breakdown could not be added
    // up: RM's own Report Summary for a month lists ~20 charge types, so a person
    // reconciling this card against that page was summing 12 of them against 20
    // and finding a gap that was never a defect. The list is ~20 short rows; the
    // UI can show as few as it likes, but what we serve has to tie to the total.
    byType,
  };
}

// Portfolio totals are DERIVED by summing the per-entity results for a window,
// NOT by a separate combined-all-properties run. The entities partition the
// portfolio, so the sum is identical to what a combined run returns (verified
// 2026-07-29: both give $67,269,940.07 charged for the last 12 months) — but it
// skips the one giant all-ids ChargeDetail call per window, which is by far the
// slowest and most failure-prone RM request. The 365-day combined run takes
// ~3.5 minutes and RM's gateway 502s it, which used to blank the whole
// Portfolio row AND the KPI tiles above the table (they read the selected
// window, which defaults to last-12-months) even though all 13 entity runs had
// succeeded. Summing means the portfolio is present whenever any entity loaded.
function sumWindowResults(cells) {
  const ok = cells.filter(c => c && !c.error);
  if (!ok.length) return null;
  let charged = 0, paid = 0, excludedCharged = 0, excludedPaid = 0;
  const typeMap = new Map();
  for (const c of ok) {
    charged += c.charged || 0;
    paid += c.paid || 0;
    excludedCharged += c.excludedCharged || 0;
    excludedPaid += c.excludedPaid || 0;
    for (const t of (c.byType || [])) {
      const agg = typeMap.get(t.type) || { type: t.type, description: t.description || '', charged: 0, paid: 0 };
      agg.charged += t.charged || 0;
      agg.paid += t.paid || 0;
      if (!agg.description && t.description) agg.description = t.description;
      typeMap.set(t.type, agg);
    }
  }
  const byType = [...typeMap.values()]
    .map(t => ({ ...t, charged: Math.round(t.charged * 100) / 100, paid: Math.round(t.paid * 100) / 100 }))
    .sort((a, b) => b.charged - a.charged);
  return {
    charged: Math.round(charged * 100) / 100,
    paid: Math.round(paid * 100) / 100,
    pct: charged > 0 ? paid / charged : null,
    excludedCharged: Math.round(excludedCharged * 100) / 100,
    excludedPaid: Math.round(excludedPaid * 100) / 100,
    byType,
    derived: true, // portfolio = sum of entities, not a combined RM run
    partial: ok.length < cells.length, // one or more entity runs failed
  };
}

async function buildCollections() {
  const now = new Date();
  const windows = buildWindows(now);
  const { entities } = await buildPropertyEntityMap(rentManager);

  // work list: one run per entity per window. The portfolio row is summed from
  // those afterwards (see sumWindowResults) — no combined all-ids run.
  const allIds = Object.values(entities).flat();
  const jobs = [];
  for (const [name, ids] of Object.entries(entities)) {
    for (const w of windows) jobs.push({ scope: name, ids, w });
  }

  // The "Owed now (RM official)" column no longer runs report 85 itself — it
  // reads services/delinquencyReport, which serves the SAME single run that
  // feeds the tab's KPI tiles and tenant table. That's what stops this card and
  // the tiles above it from showing two different delinquency numbers, and it
  // drops 14 report runs from this build.
  const results = {};
  const asOf = ymd(now);
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      try {
        const r = await runWindow(job.ids, job.w.start, job.w.end);
        (results[job.scope] = results[job.scope] || {})[job.w.key] = r;
      } catch (err) {
        (results[job.scope] = results[job.scope] || {})[job.w.key] = { error: err.message };
      }
    }
  };
  await Promise.all(Array.from({ length: RUN_CONCURRENCY }, worker));

  let rmDelinq = { portfolio: null, entities: {}, asOf };
  try {
    const d = await delinquencyReport.getDelinquency();
    if (d && d.configured !== false) {
      rmDelinq = {
        asOf: d.asOf,
        portfolio: { amount: d.totals.amount, tenants: d.totals.tenants },
        entities: Object.fromEntries(Object.entries(d.byEntity || {})
          .map(([e, v]) => [e, { amount: v.amount, tenants: v.tenants }])),
      };
    }
  } catch (err) {
    rmDelinq = { asOf, portfolio: { error: err.message }, entities: {} };
  }

  // If literally nothing succeeded (e.g. RM's concurrent-session cap rejected
  // every login), fail the build instead of caching 6 hours of error cells —
  // the stale-while-revalidate layer keeps serving the previous good snapshot.
  const okRuns = Object.values(results).reduce(
    (n, scope) => n + Object.values(scope).filter(c => !c.error).length, 0);
  if (okRuns === 0) {
    throw new Error('Every ChargeDetail run failed (RM auth/session cap?) — kept the previous snapshot.');
  }

  // Roll the per-entity results up into the Portfolio row, window by window.
  const portfolio = {};
  for (const w of windows) {
    const summed = sumWindowResults(Object.values(results).map(scope => scope[w.key]));
    if (summed) portfolio[w.key] = summed;
  }

  const payload = {
    configured: true,
    refreshedAt: now.toISOString(),
    goalPct: GOAL_PCT,
    excludedChargeTypes: EXCLUDED_CHARGE_TYPES,
    windows: windows.map(w => ({ key: w.key, label: w.label, start: w.start, end: w.end })),
    portfolio,
    entities: results,
    rmDelinquency: {
      ...rmDelinq,
      note: "RM report 85 Delinquency — the same single run that feeds this tab's KPI tiles and tenant table, so every delinquency figure on the page agrees.",
    },
    source: 'RM report 30 ChargeDetail (Grid2 summary) + report 85 Delinquency (shared, via delinquencyReport)',
  };
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(payload));
  } catch (e) { /* disk snapshot is best-effort */ }
  return payload;
}

// ── stale-while-revalidate cache (moveActivity pattern + disk restore) ────────
let _cache = null;
let _building = null;
let _lastError = null;

try {
  if (fs.existsSync(SNAPSHOT_FILE)) _cache = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
} catch (e) { /* corrupt snapshot → rebuild */ }

function refresh() {
  if (_building) return _building;
  _lastError = null;
  _building = buildCollections()
    .then(payload => { _cache = payload; return payload; })
    .catch(err => { _lastError = err.message; throw err; })
    .finally(() => { _building = null; });
  return _building;
}

function getStatus() {
  if (rentManager.isConfigured()) {
    const age = _cache ? Date.now() - Date.parse(_cache.refreshedAt || 0) : Infinity;
    // Always build when there's nothing cached; only refresh on staleness when
    // periodic refreshing is switched on.
    const stale = STALE_MS > 0 && (!Number.isFinite(age) || age > STALE_MS);
    if (!_building && (!_cache || stale)) refresh().catch(() => {});
  }
  return { cache: _cache, building: Boolean(_building), lastError: _lastError };
}

module.exports = { buildCollections, getStatus, refresh, GOAL_PCT, EXCLUDED_CHARGE_TYPES };
