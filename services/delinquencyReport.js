// Delinquency — SINGLE SOURCE OF TRUTH for "who owes us right now".
//
// Source: RM report 85 "Delinquency", IsSummary=True, one run across every
// mapped property, AsOfDate = today.
//
// Why this replaced the old /Tenants-balance approach (the owner, 2026-07-30):
// the tab used to show two different delinquency numbers side by side — the KPI
// tiles summed live per-tenant balances from /Tenants (with a hand-rolled
// netting step to remove next month's early-posted rent), while the % Collected
// card showed RM report 85. They disagreed by ~$38k and ~54 tenants because
// they measure different things: net account balance vs. aged open charges.
//
// Report 85 wins on three counts, all verified live 2026-07-30:
//   1. It's the system of record — anyone can reproduce it inside RM.
//   2. Its Grid1 (one row per tenant) sums EXACTLY to its Grid2 official
//      "Delinquent Amount" — $694,243.19 over 388 tenants. Headline and
//      drill-down reconcile by construction, so the tab cannot disagree with
//      itself again.
//   3. It ages open charges as of a date, so next month's rent (RM posts it
//      ~5 days early) is excluded automatically — 0 rows dated after the
//      as-of date. The old manual netting hack is no longer needed.
//
// GRACE PERIOD (added 2026-08-03). Point 3 above only held because it was
// verified on July 30: August's rent was dated Aug 1, i.e. AFTER the as-of
// date, so it fell out for free. On the 1st of the month that protection
// disappears — the charge is now dated on/before today and counts in full,
// with DelinquentDaysToInclude empty meaning "no minimum age". Measured live,
// same portfolio, same report:
//
//     as-of        no grace              5-day grace
//     2026-07-20     426  $846,176         418  $837,993
//     2026-07-30     388  $694,641         375  $689,801
//     2026-08-03   1,185  $2,538,578       315  $635,365   <-- August rent
//
// So with no grace period the tab tripled overnight for a reason that has
// nothing to do with anyone being late — rent posted two days earlier. A
// tenant who owes August rent on August 3rd is not delinquent; they are
// inside the grace period. Passing the grace period to RM makes the series
// continuous across the month boundary and matches how the number is used
// in practice ("past due", not "billed").
//
// Set DELINQUENCY_GRACE_DAYS to change it; 0/'' restores RM's raw behaviour.
//
// Cost: ONE report run, ~13s for the whole portfolio (92 properties, verified).
// That also replaces the 14 separate report-85 runs chargedCollections used to
// make for its "Owed now" column — it now reads the per-entity roll-up here.
//
// PII: the report also returns tenant phone numbers and street addresses. We
// deliberately do NOT read those fields — nothing downstream needs them, and
// the less tenant PII that leaves the server the better.

const fs = require('fs');
const path = require('path');
const rentManager = require('./rentManagerClient');
const { buildPropertyEntityMap } = require('./entityMap');

const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'delinquency-cache.json');
const STALE_MS = Number(process.env.DELINQUENCY_STALE_MS || 15 * 60 * 1000);

// Days a charge must be past due before it counts as delinquent. See the
// grace-period note in the header for the measurements behind the default.
const GRACE_DAYS = process.env.DELINQUENCY_GRACE_DAYS !== undefined
  ? Number(process.env.DELINQUENCY_GRACE_DAYS)
  : 5;

// One parser for every RM figure — see services/rmAmount.js. The local one this
// replaced dropped parenthesised credits to zero.
const { parseAmount: num } = require('./rmAmount');
const round2 = n => Math.round(n * 100) / 100;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

// One row per delinquent tenant (IsSummary=True), plus RM's own summary block.
async function runDelinquencyReport(propertyIds, asOf) {
  return rentManager.RunReport(85, reportParamQuery([
    ['AsOfDate', asOf],
    ['METHOD', ''],
    ['PropertyIDs', propertyIds.join(',')],
    ['SHOWINACTIVEPROPS', 'False'],
    ['GroupID', '0'],
    ['BatchProps', 'False'],
    ['CHARGESTOINCLUDE', 'All'],
    ['CUSTOMERVALUESTOINCLUDETEXT', ''],
    ['IsSummary', 'True'],
    ['SEPRENT', 'False'],
    ['SHOWPERDAYLATE', 'False'],
    ['SORTOPTIONS', '0'],
    ['DelinquentDaysToInclude', GRACE_DAYS > 0 ? String(GRACE_DAYS) : ''],
    ['CustomersToInclude', 'Current'],
    ['IncludeProspects', 'False'],
  ]));
}

async function buildDelinquency() {
  const asOf = ymd(new Date());
  const map = await buildPropertyEntityMap(rentManager);
  const propertyIds = [...map.byId.keys()];
  if (!propertyIds.length) throw new Error('property→entity map came back empty');

  const body = await runDelinquencyReport(propertyIds, asOf);
  const grid1 = (body && body.Grid1) || [];
  const grid2 = (body && body.Grid2) || [];

  // RM's own summary — the number the regional manager sees when he runs this in Rent Manager
  // with the same grace period.
  //
  // Note on official.tenants: with a grace period set, RM's Grid2 "Tenants:"
  // line counts a wider population than the Grid1 detail rows (386 vs 315 on
  // 2026-08-03) — it appears to be the denominator behind "percent delinquent"
  // rather than a count of delinquent tenants. The AMOUNT still ties exactly,
  // which is what tiesToOfficial checks. Headline tenant counts therefore come
  // from items.length (the rows we can actually show), never official.tenants.
  const official = { amount: null, tenants: null, percentDelinquent: null };
  for (const r of grid2) {
    const label = String(r.ReportSummaryDetail || '').toLowerCase();
    if (label.includes('delinquent amount')) official.amount = num(r.ReportSummaryValue);
    else if (label === 'tenants:') official.tenants = num(r.ReportSummaryValue);
    else if (label.includes('percent delinquent')) official.percentDelinquent = num(r.ReportSummaryValue) / 100;
  }

  const items = [];
  const byEntity = {};
  const byProperty = {};
  let unmapped = 0;

  for (const r of grid1) {
    const propertyId = Number(r.EntitiesEntityID);
    const mapped = map.byId.get(propertyId);
    // A property outside the entity map (e.g. a Demo Portfolio property not on the
    // confirmed whitelist) is counted in `unmapped` rather than silently
    // dropped — otherwise the roll-ups would quietly stop tying to `official`.
    if (!mapped) { unmapped += 1; continue; }
    // CREDITS (the regional manager asked to confirm this, 2026-08-07). A tenant whose report-85
    // row nets to zero or a credit — a move-in credit, a concession, a write-off —
    // is dropped here rather than listed with a negative or zero balance: they have
    // nothing past due, so they are not delinquent. Note this only ever removes a
    // row; one tenant's credit is never subtracted from another tenant's balance.
    // Whether the credit reduced the row in the first place is RM's call, not ours,
    // and tiesToOfficial below is the guard: if these positive rows ever stop
    // summing to RM's own Delinquent Amount, the tab says so instead of quietly
    // showing a number Rent Manager disagrees with.
    const amount = round2(num(r.ChargesAmount));
    if (!(amount > 0)) continue;

    const entity = mapped.entity;
    const property = r.EntitiesName || mapped.name || String(propertyId);
    items.push({
      tenant: r.AccountsName || [r.AccountsFirstName, r.AccountsLastName].filter(Boolean).join(' ') || '—',
      tenantId: r.AccountsAccountID != null ? String(r.AccountsAccountID) : null,
      account: r.CustomersCustomerDisplayID != null ? String(r.CustomersCustomerDisplayID) : null,
      unit: r.SubEntitiesName || '',
      property,
      propertyId,
      entity,
      status: 'current',
      amount,
      // Kept for API compatibility with the old /Tenants-derived shape. Report
      // 85 ages charges as of today, so nothing here is a not-yet-due charge.
      futureChargeAmount: 0,
    });

    byEntity[entity] = byEntity[entity] || { amount: 0, tenants: 0 };
    byEntity[entity].amount += amount;
    byEntity[entity].tenants += 1;

    byProperty[property] = byProperty[property] || { amount: 0, tenants: 0, entity, propertyId };
    byProperty[property].amount += amount;
    byProperty[property].tenants += 1;
  }

  for (const k of Object.keys(byEntity)) byEntity[k].amount = round2(byEntity[k].amount);
  for (const k of Object.keys(byProperty)) byProperty[k].amount = round2(byProperty[k].amount);

  const total = round2(items.reduce((s, i) => s + i.amount, 0));
  // The whole point of this service is that the detail ties to RM's own total.
  // If it ever stops tying, say so loudly in the payload rather than shipping a
  // number that quietly disagrees with Rent Manager.
  const tiesToOfficial = official.amount == null || Math.abs(total - official.amount) < 0.5;

  return {
    configured: true,
    asOf,
    graceDays: GRACE_DAYS,
    refreshedAt: new Date().toISOString(),
    source: `RM report 85 Delinquency (IsSummary=True, one run, all properties, ${GRACE_DAYS}-day grace)`,
    official,
    tiesToOfficial,
    unmappedRows: unmapped,
    totals: {
      amount: total,
      tenants: items.length,
      // Report 85 is scoped to current customers, so these mirror the totals.
      // Kept so existing callers don't have to special-case the shape.
      currentAmount: total,
      currentTenants: items.length,
      pastAmount: 0,
      pastTenants: 0,
      futureExcludedAmount: 0,
      futureExcludedTenants: 0,
    },
    byEntity,
    byProperty,
    items: items.sort((a, b) => b.amount - a.amount),
  };
}

// ── stale-while-revalidate cache, mirroring chargedCollections ───────────────
let cache = null;
let building = null;
let lastError = null;

try {
  if (fs.existsSync(SNAPSHOT_FILE)) {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    // Only reuse a snapshot measured the same way. The host keeps data/ on a
    // persistent disk, so without this check a deploy that changes the grace
    // period would keep serving the previous definition's numbers (stale-
    // while-revalidate means they'd be the first thing on screen) until a
    // refresh completed. A definition change must invalidate, not linger.
    if (snapshot && snapshot.graceDays === GRACE_DAYS) cache = snapshot;
  }
} catch (e) { /* a corrupt snapshot must not stop the server booting */ }

function persist(data) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data));
  } catch (e) { /* disk is best-effort; memory cache still serves */ }
}

function startBuild() {
  if (building) return building;
  building = buildDelinquency()
    .then(data => { cache = data; lastError = null; persist(data); return data; })
    .catch(err => { lastError = err.message || String(err); throw err; })
    .finally(() => { building = null; });
  return building;
}

// Serve the cache immediately and refresh behind it when stale. Only the very
// first call (empty cache) has to wait for the report run.
async function getDelinquency() {
  if (!rentManager.isConfigured()) return { configured: false };
  if (!cache) return startBuild();
  const age = Date.now() - new Date(cache.refreshedAt).getTime();
  if (STALE_MS > 0 && age > STALE_MS) startBuild().catch(() => {});
  return cache;
}

function refresh() {
  cache = null;
  return startBuild();
}

function getStatus() {
  return { cache, building: Boolean(building), lastError };
}

module.exports = { buildDelinquency, getDelinquency, refresh, getStatus };
