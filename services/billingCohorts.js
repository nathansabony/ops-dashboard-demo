// Billing-month cohorts — "of what we billed in June, how much had we collected
// by the end of June / July / August?"
//
// Replaces the old rolling 30/60/90-day windows, which the owner and the regional manager found
// unusable: those windows slide with today's date and their "paid" figure is
// as-of-right-now, so a June charge paid in July silently inflated whatever
// window happened to still cover late June. There was no way to compare one
// month against another.
//
// A cohort is FIXED the moment its month closes: June's charges are a locked
// pile of money, and we watch that pile get paid down. Once a cutoff date
// passes, that cell never changes again — which is what makes month-over-month
// comparison mean anything.
//
// ── Source ──────────────────────────────────────────────────────────────────
// RM report 30 "ChargeDetail", Grid1 (the DETAIL grid). chargedCollections has
// only ever read Grid2, the per-charge-type summary; Grid1 turns out to carry
// one row per charge-payment ALLOCATION:
//     ChargesChargeID, ChargesTransactionDate, ChargesAmount,
//     PaymentsTransactionDate, AllocationsAmount, + property/unit/tenant/type
// A charge settled in two installments is two rows. RM gives us the allocation
// directly, so there is no FIFO guessing about which payment retired which
// charge, and the whole history is computable retroactively.
//
// Verified live 2026-07-31, all 92 properties, June 2026:
//   - 6.1s per month-run; 11,294 Grid1 rows over 9,838 distinct charges.
//   - Grid1 charges deduped by ChargeID sum EXACTLY to Grid2's authoritative
//     AmountCharged ($5,769,799.87), and fully-unpaid charges appear (502 rows
//     with no payment) — so Grid1 alone gives numerator AND denominator, at
//     property level, which Grid2 cannot do.
//   - Allocations (ex-TAX/LD) with a payment date on or before the run date sum
//     to Grid2's AmountPaid.
//
// ── The decisions behind the maths (the owner, 2026-07-30) ─────────────────────
// * Cohort = every charge with a transaction date in the month, minus TAX and
//   LD (same exclusions as the % Collected card), expandable by charge type.
// * The clock starts on the 1st of the billing month, so the cutoffs land on
//   month ends: June's marks are Jun 30 / Jul 31 / Aug 31. Rent is due on the
//   1st and is ~92% of the dollars, so the 1st IS the billing date for almost
//   everything in the pile. Labelled by month end rather than "30/60/90 days",
//   because that is what is actually being measured.
// * Payments dated BEFORE the charge (prepaid rent, credits applied forward)
//   count as collected at day 0 — they fall on or before every cutoff, so the
//   plain "paid on or before X" test handles them with no special case. These
//   are not an edge case: 2,948 rows / $1.36M of June's $5.77M.
// * Two tenant scopes. `current` (CustomerStatus=2, current + notice) is the
//   headline and matches what the regional manager pulls from RM. `allIn` adds former
//   tenants, so money owed by someone who was evicted stops silently vanishing
//   from the collection rate. CustomerStatus is a bitmask — 1 = former,
//   2 = current+notice, 3 = both (verified: 2's rows + 1's rows == 3's rows
//   exactly), so allIn is built as run(2) + run(1) rather than a third run.
//
// Cost: 2 runs per month (the CustomerStatus=1 former-tenant run is tiny, ~0.8s)
// × 12 months ≈ 80s of report time, drained 3 at a time.

const fs = require('fs');
const path = require('path');
const rentManager = require('./rentManagerClient');
const { buildPropertyEntityMap } = require('./entityMap');

const EXCLUDED_CHARGE_TYPES = ['TAX', 'LD'];
const GOAL_PCT = 0.98;
const MONTHS_BACK = Number(process.env.COHORT_MONTHS || 12);
const RUN_CONCURRENCY = 3;              // stay well under RM's ~8-session cap
const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'billing-cohorts-cache.json');

// One parser for every RM figure — see services/rmAmount.js. The local one this
// replaced read a parenthesised credit as 0, which is precisely the "no credits
// reach us / our billed is higher than RM's" case the note above predicts.
const { parseAmount: num } = require('./rmAmount');
const r2 = n => Math.round(n * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Last day of the month `offset` months after (year, monthIdx).
function monthEnd(year, monthIdx, offset = 0) {
  return new Date(year, monthIdx + offset + 1, 0);
}

// The cohorts we track: the last MONTHS_BACK COMPLETE billing months, newest
// first. The current month is excluded — it is still being billed, so its
// denominator isn't final and a percentage off it would be meaningless.
function buildCohortMonths(now) {
  const out = [];
  for (let i = 1; i <= MONTHS_BACK; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear(), m = d.getMonth();
    const cutoffs = { m0: ymd(monthEnd(y, m, 0)), m1: ymd(monthEnd(y, m, 1)), m2: ymd(monthEnd(y, m, 2)) };
    const today = ymd(now);
    out.push({
      key: `${y}-${pad(m + 1)}`,
      label: `${MONTH_NAMES[m]} ${y}`,
      start: ymd(new Date(y, m, 1)),
      end: cutoffs.m0,
      cutoffs,
      // A bucket is only real once its cutoff has passed. Anything else would be
      // a partial number masquerading as a final one.
      mature: { m0: cutoffs.m0 <= today, m1: cutoffs.m1 <= today, m2: cutoffs.m2 <= today },
      cutoffLabels: {
        m0: `by ${MONTH_NAMES[m]} end`,
        m1: `by ${MONTH_NAMES[monthEnd(y, m, 1).getMonth()]} end`,
        m2: `by ${MONTH_NAMES[monthEnd(y, m, 2).getMonth()]} end`,
      },
    });
  }
  return out;
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

async function runChargeDetail(propertyIds, start, end, customerStatus) {
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
  return (body && body.Grid1) || [];
}

// Empty accumulator. `charged` is booked once per distinct charge; the bucket
// figures accumulate allocation amounts.
//
// `creditCount` / `creditAmount` track the charges that came through NEGATIVE.
// They are not a separate bucket — a negative charge is already summed into
// `charged` like any other, so `charged` is net of them. They are counted so the
// card can SAY whether credits reach us, which is the question the regional manager asked on
// 2026-08-07: he sees Rent Manager's total billed coming in lower than ours and
// suspects credits are the difference. Two possibilities, and this tells them
// apart on the next real refresh without anyone guessing:
//
//   creditAmount != 0  -> credits arrive as negative charge rows and we ALREADY
//                         net them. The gap is something else (most likely the
//                         report or the tenant scope he pulled — see the probe
//                         in scripts/probeCreditsVsBilled.js).
//   creditAmount == 0  -> nothing negative reaches the ChargeDetail rows at all,
//                         so any credit RM applies is invisible here and our
//                         denominator is gross where RM's is net. That is the
//                         bug he is describing, and it needs a second source
//                         (RM's own credit ledger) to fix, not a tweak here.
const blank = () => ({ charged: 0, m0: 0, m1: 0, m2: 0, now: 0, creditCount: 0, creditAmount: 0 });

function addInto(target, key, extra) {
  if (!target[key]) target[key] = { ...blank(), ...(extra || {}) };
  return target[key];
}

// Fold one run's Grid1 rows into cohort totals.
//
// Continuation rows (a second allocation against the same charge) come back
// with ChargesAmount / ChargeTypesName blank and the value only in the *Clone
// fields — read both, or the denominator silently loses those charges and the
// percentages come out above 100%.
function foldRows(rows, propertyMap, cutoffs, acc) {
  const seenCharges = acc._seen;
  for (const row of rows) {
    const type = String(row.ChargeTypesName || row.ChargeTypesNameClone || '').trim();
    if (EXCLUDED_CHARGE_TYPES.includes(type)) continue;

    const propertyId = Number(row.EntitiesEntityID);
    const mapped = propertyMap.get(propertyId);
    if (!mapped) { acc.unmappedRows += 1; continue; }
    const entity = mapped.entity;
    const property = row.EntitiesName || mapped.name || String(propertyId);
    const description = row.ChargeTypesDescription || type;

    const entityRow = addInto(acc.byEntity, entity);
    const propRow = addInto(acc.byProperty, property, { entity, propertyId });
    const typeRow = addInto(acc.byType, type, { description });

    // ── denominator: once per distinct ChargeID ──
    const chargeId = row.ChargesChargeID;
    if (chargeId != null && !seenCharges.has(chargeId)) {
      seenCharges.add(chargeId);
      const amt = num(row.ChargesAmount || row.ChargesAmountClone);
      acc.totals.charged += amt;
      entityRow.charged += amt;
      propRow.charged += amt;
      typeRow.charged += amt;
      if (amt < 0) {
        for (const t of [acc.totals, entityRow, propRow, typeRow]) {
          t.creditCount += 1;
          t.creditAmount += amt;   // stays negative: it is a reduction
        }
      }
    }

    // ── numerator: one allocation per row, bucketed by PAYMENT date ──
    const paid = row.PaymentsTransactionDate;
    if (!paid) continue;
    const on = String(paid).slice(0, 10);
    const amt = num(row.AllocationsAmount);
    if (!amt) continue;
    for (const b of ['m0', 'm1', 'm2']) {
      if (on <= cutoffs[b]) {
        acc.totals[b] += amt; entityRow[b] += amt; propRow[b] += amt; typeRow[b] += amt;
      }
    }
    acc.totals.now += amt; entityRow.now += amt; propRow.now += amt; typeRow.now += amt;
  }
}

function newAcc() {
  return { totals: blank(), byEntity: {}, byProperty: {}, byType: {}, unmappedRows: 0, _seen: new Set() };
}

function finish(acc) {
  const roundAll = o => { for (const k of ['charged', 'm0', 'm1', 'm2', 'now', 'creditAmount']) o[k] = r2(o[k]); return o; };
  roundAll(acc.totals);
  for (const k of Object.keys(acc.byEntity)) roundAll(acc.byEntity[k]);
  for (const k of Object.keys(acc.byProperty)) roundAll(acc.byProperty[k]);
  const byType = Object.entries(acc.byType)
    .map(([type, v]) => ({ type, ...roundAll(v) }))
    .sort((a, b) => b.charged - a.charged);
  return {
    totals: acc.totals,
    byEntity: acc.byEntity,
    byProperty: acc.byProperty,
    byType,
    unmappedRows: acc.unmappedRows,
  };
}

async function buildCohorts() {
  const now = new Date();
  const months = buildCohortMonths(now);
  const { byId } = await buildPropertyEntityMap(rentManager);
  const propertyIds = [...byId.keys()];
  if (!propertyIds.length) throw new Error('property→entity map came back empty');

  // Two runs per month: current+notice (2) and former-only (1). allIn = 2 + 1.
  const jobs = [];
  for (const m of months) {
    jobs.push({ month: m, status: 2 });
    jobs.push({ month: m, status: 1 });
  }

  const raw = {};   // key -> { 2: rows, 1: rows }
  const errors = {};
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      try {
        const rows = await runChargeDetail(propertyIds, job.month.start, job.month.end, job.status);
        (raw[job.month.key] = raw[job.month.key] || {})[job.status] = rows;
      } catch (err) {
        (errors[job.month.key] = errors[job.month.key] || {})[job.status] = err.message;
      }
    }
  };
  await Promise.all(Array.from({ length: RUN_CONCURRENCY }, worker));

  // If nothing came back at all, keep the previous snapshot rather than caching
  // a wall of error cells (same guard as chargedCollections).
  if (!Object.keys(raw).length) {
    throw new Error('Every ChargeDetail run failed (RM auth/session cap?) — kept the previous snapshot.');
  }

  const out = [];
  for (const m of months) {
    const got = raw[m.key];
    if (!got || !got[2]) {
      out.push({ ...m, error: (errors[m.key] && (errors[m.key][2] || errors[m.key][1])) || 'no data' });
      continue;
    }
    const cur = newAcc();
    foldRows(got[2], byId, m.cutoffs, cur);

    // allIn re-folds BOTH row sets into a fresh accumulator — it is not the sum
    // of two finished scopes, because a charge must only be counted once and the
    // two runs are disjoint sets of tenants.
    const all = newAcc();
    foldRows(got[2], byId, m.cutoffs, all);
    if (got[1]) foldRows(got[1], byId, m.cutoffs, all);

    out.push({ ...m, current: finish(cur), allIn: finish(all), formerTenantsMissing: !got[1] });
  }

  const payload = {
    configured: true,
    refreshedAt: now.toISOString(),
    goalPct: GOAL_PCT,
    excludedChargeTypes: EXCLUDED_CHARGE_TYPES,
    monthsBack: MONTHS_BACK,
    bucketKeys: ['m0', 'm1', 'm2'],
    months: out,
    source: 'RM report 30 ChargeDetail Grid1 (per-charge payment allocations), CustomerStatus 2 + 1',
  };
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(payload));
  } catch (e) { /* disk snapshot is best-effort */ }
  return payload;
}

// ── stale-while-revalidate cache with disk restore ───────────────────────────
let _cache = null;
let _building = null;
let _lastError = null;

try {
  if (fs.existsSync(SNAPSHOT_FILE)) _cache = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
} catch (e) { /* a corrupt snapshot must not stop the server booting */ }

function startBuild() {
  if (_building) return _building;
  _building = buildCohorts()
    .then(d => { _cache = d; _lastError = null; return d; })
    .catch(err => { _lastError = err.message || String(err); throw err; })
    .finally(() => { _building = null; });
  return _building;
}

function getStatus() {
  // Closed months never change, so there is no timer — the cache is rebuilt by
  // the Delinquency tab's refresh button or the weekly schedule. Only a
  // completely empty cache triggers a build on its own.
  if (!_cache && !_building && rentManager.isConfigured()) startBuild().catch(() => {});
  return { cache: _cache, building: Boolean(_building), lastError: _lastError };
}

function refresh() { _cache = null; return startBuild(); }

module.exports = { buildCohorts, getStatus, refresh, GOAL_PCT, EXCLUDED_CHARGE_TYPES };
