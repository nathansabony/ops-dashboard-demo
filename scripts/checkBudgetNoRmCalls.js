#!/usr/bin/env node
// Prove that BROWSING THE SITE costs ZERO Rent Manager calls once the snapshots
// are on disk.
//
//   node scripts/checkBudgetNoRmCalls.js
//
// The budget is a frozen set served off disk (services/budgetStore.js). That
// claim is only worth anything if it's enforced, because the failure mode is
// silent and expensive: an earlier cut read the P&L snapshot through
// propertyFinancials.getStatus(), which self-heals a >30-minute-old snapshot by
// kicking off a background refresh — so simply opening the tab spent ~89 report
// runs of API budget, and nothing on screen said so.
//
// The same reasoning now covers the P&L snapshot itself: it pulls RM Report 45
// monthly accrual figures, and a CLOSED month's numbers never change, so it no
// longer refreshes on a timer either (PL_AUTO_REFRESH_MS, off by default). That
// removed ~4,300 report runs a day of re-fetching numbers that were already
// correct.
//
// This intercepts node-fetch before the Rent Manager client loads, hammers every
// read path on the site, and fails if a single request went to Rent Manager.

const path = require('path');
const Module = require('module');

// ── intercept node-fetch before anything requires it ─────────────────────────
const rmCalls = [];
const otherCalls = [];
const realFetch = require('node-fetch');
const fetchPath = require.resolve('node-fetch');

function countingFetch(url, init) {
  const u = String(url);
  if (/rentmanager\.com/i.test(u)) rmCalls.push(u);
  else otherCalls.push(u);
  return realFetch(url, init);
}
countingFetch.default = countingFetch;
require.cache[fetchPath].exports = countingFetch;

// ── boot the server with RM "configured" so nothing is skipped for that reason ─
process.env.RENTMANAGER_COMPANY = process.env.RENTMANAGER_COMPANY || 'nocall-probe';
process.env.RENTMANAGER_USERNAME = process.env.RENTMANAGER_USERNAME || 'probe';
process.env.RENTMANAGER_PASSWORD = process.env.RENTMANAGER_PASSWORD || 'probe';
process.env.PORT = process.env.PORT || '3998';

const app = require(path.join(__dirname, '..', 'server.js'));

const PORT = Number(process.env.PORT);
const BASE = `http://127.0.0.1:${PORT}`;

async function get(p) {
  const res = await realFetch(BASE + p);
  return { status: res.status, body: await res.buffer() };
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  const server = app.listen(PORT);
  await new Promise(r => server.once('listening', r));

  // This test is only meaningful against a STALE snapshot. Against a fresh one
  // even the old 30-minute rule wouldn't have fired, so zero calls would prove
  // nothing. Assert the snapshot is old enough that the previous behaviour
  // definitely would have kicked off a refresh.
  const OLD_RULE_MS = 30 * 60 * 1000;
  const snap = require('../services/propertyFinancials').loadSnapshot();
  const snapAge = snap ? Date.now() - Date.parse(snap.refreshedAt || 0) : NaN;
  if (!snap) {
    console.error('✗ No P&L snapshot on disk — nothing to test against.');
    process.exit(1);
  }
  console.log(`P&L snapshot age: ${(snapAge / 3.6e6).toFixed(1)}h`);
  check('snapshot is stale enough for this test to mean something',
    snapAge > OLD_RULE_MS,
    `only ${(snapAge / 60000).toFixed(0)} min old — the old 30-min rule would not have fired either, so a zero result proves nothing`);

  // Anything the boot-time cache warm fired is not what we're measuring.
  await new Promise(r => setTimeout(r, 1500));
  const baseline = rmCalls.length;
  console.log(`Rent Manager calls during boot: ${baseline}\n`);

  console.log('Hammering the budget read paths…');
  const setRes = await get('/api/budget');
  check('GET /api/budget serves the built set', setRes.status === 200, `HTTP ${setRes.status}`);
  const payload = JSON.parse(setRes.body.toString());
  check('payload is marked as a built set', payload.built === true);
  check('every entity present', Object.keys(payload.entities || {}).length >= 13,
    `${Object.keys(payload.entities || {}).length} entities`);
  check('manifest attached', Boolean(payload.manifest && payload.manifest.workbooks));

  // 25 tab opens.
  for (let i = 0; i < 25; i++) await get('/api/budget');
  await get('/api/budget/files');
  await get('/api/budget/assumptions');

  // Download every workbook twice.
  const scopes = payload.manifest.scopes;
  for (const s of scopes) {
    const r = await get(`/api/budget/${encodeURIComponent(s)}/excel`);
    check(`download ${s}`, r.status === 200 && r.body.length > 10000,
      `HTTP ${r.status}, ${(r.body.length / 1024).toFixed(0)}KB`);
  }
  for (const s of scopes) await get(`/api/budget/${encodeURIComponent(s)}/excel`);

  const budgetSpent = rmCalls.length - baseline;
  console.log(`\nRent Manager calls from ${25 + 2} budget reads + ${scopes.length * 2} downloads: ${budgetSpent}`);
  check('budget read paths make ZERO Rent Manager calls', budgetSpent === 0,
    budgetSpent ? `${budgetSpent} call(s): ${[...new Set(rmCalls.slice(baseline))].slice(0, 3).join(', ')}` : undefined);

  // The whole-site claim: with every timer off, browsing costs nothing. This is
  // the property the refresh button depends on — if any page load can still pull,
  // "the site shows the last pull until you press refresh" is not true.
  console.log('\nHammering every page-data endpoint…');
  // One warm-up pass first. A cache with nothing in it builds once on demand
  // (a fresh install must not serve an empty site) — the claim under test is the
  // steady state AFTER data exists, which is what "shows the last pull" means.
  const warmPaths = ['/api/live-overview', '/api/issues?days=7&format=workorders', '/api/debt-service',
    '/api/variance/move-activity', '/api/delinquency/collections'];
  for (const p of warmPaths) await get(p);
  await new Promise(r => setTimeout(r, 500));
  const before = rmCalls.length;
  const otherPaths = [
    '/api/financials/property-monthly',
    '/api/variance/config',
    '/api/variance/move-activity',
    '/api/delinquency/collections',
    '/api/entities',
    '/api/overview',
    '/api/live-overview',
    '/api/issues?days=7&format=workorders',
    '/api/debt-service',
    '/api/status',
    '/api/refresh/status',
  ];
  for (let i = 0; i < 5; i++) {
    for (const p of otherPaths) await get(p);
  }
  const otherSpent = rmCalls.length - before;
  console.log(`Rent Manager calls from ${otherPaths.length * 5} page-data loads: ${otherSpent}`);
  check('browsing the site makes ZERO Rent Manager calls', otherSpent === 0,
    otherSpent ? `${otherSpent} call(s): ${[...new Set(rmCalls.slice(before))].slice(0, 4).join(', ')}` : undefined);

  // Every cache must be reachable from the one button. A source that isn't
  // registered can only be refreshed by restarting the server, which is exactly
  // the kind of invisible gap this whole design exists to remove.
  const st = JSON.parse((await get('/api/refresh/status')).body.toString());
  const registered = new Set((st.sources || []).map(x => x.key));
  const expected = ['liveOverview', 'tenantIndex', 'propertyPL', 'collections',
    'moveActivity', 'issues', 'debtService', 'unitCounts'];
  for (const key of expected) {
    check(`'${key}' is refreshable from the button`, registered.has(key));
  }

  // Timers must stay off, or the button stops being the only thing that pulls.
  const cadence = require('../services/propertyFinancials').getStatus().autoRefreshMs;
  check('P&L timer is off (button-only)', cadence === 0,
    cadence ? `PL_AUTO_REFRESH_MS is ${cadence}ms — a timer will pull without anyone asking` : undefined);

  const spent = rmCalls.length - baseline;

  server.close();
  if (failures) {
    console.error(`\n✗ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ Browsing the site costs nothing. Every cache is behind the one refresh button.');
  process.exit(0);
}

main().catch(err => { console.error('✗', err); process.exit(1); });
