#!/usr/bin/env node
// Build the budget set ONCE: every entity's 12-month budget plus one Excel
// workbook each, written to data/budget/.
//
//   npm run budget:build
//
// After this runs, the Budget tab and every download are pure file reads — no
// Rent Manager calls, no recomputation, and the numbers on screen can't drift
// away from workbooks already sent out. Re-run it only when you actually want the
// budgets rebuilt.
//
// It reads the P&L snapshot PASSIVELY and will refuse to run rather than trigger a
// Rent Manager pull behind your back. If the snapshot is stale and you want fresh
// actuals, refresh them deliberately first:
//
//   curl -X POST 'localhost:3000/api/financials/property-monthly/recompute'
//
// The one exception is unit counts: if they've never been pulled, this fetches
// them once (a single cheap /Units sweep) because the $/unit benchmark checks are
// meaningless without them. Pass --no-units to skip even that.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const propertyFinancials = require('../services/propertyFinancials');
const unitCounts = require('../services/unitCounts');
const budgetStore = require('../services/budgetStore');
const rentManager = require('../services/rentManagerClient');

function fmt(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  const v = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : `$${Math.round(a).toLocaleString()}`;
  return n < 0 ? `(${v})` : v;
}

async function main() {
  const allowUnits = !process.argv.includes('--no-units');

  const snapshot = propertyFinancials.loadSnapshot();
  if (!snapshot) {
    console.error('✗ No P&L snapshot on disk (data/property-pl-cache.json).');
    console.error('  The budget projects from live actuals, and this script will not');
    console.error('  pull them itself. Refresh them first:');
    console.error('    curl -X POST "http://localhost:3000/api/financials/property-monthly/recompute"');
    process.exit(1);
  }
  const age = Date.now() - Date.parse(snapshot.refreshedAt || 0);
  const ageHrs = Number.isFinite(age) ? (age / 3.6e6).toFixed(1) : '?';
  console.log(`Actuals: ${snapshot.months[0]} → ${snapshot.months[snapshot.months.length - 1]}`
    + ` · refreshed ${ageHrs}h ago · ${snapshot.sources ? snapshot.sources.propertyCount : '?'} properties`);

  if (!unitCounts.loadSnapshot()) {
    if (allowUnits && rentManager.isConfigured()) {
      console.log('Unit counts not cached — pulling once from Rent Manager (/Units)…');
      try {
        const u = await unitCounts.startBuild();
        console.log(`  ${u.total.toLocaleString()} units across ${Object.keys(u.byEntity).length} entities`
          + (u.unmapped ? ` (${u.unmapped} on unmapped properties)` : ''));
      } catch (err) {
        console.warn(`  ! unit pull failed: ${err.message}`);
        console.warn('  Continuing without them — per-unit benchmark checks will be skipped.');
      }
    } else {
      console.warn('! No unit counts cached — per-unit benchmark checks will be skipped.');
    }
  }

  console.log('\nBuilding budgets + workbooks…');
  const { payload, manifest } = await budgetStore.build({
    onProgress: (done, total, scope) => {
      process.stdout.write(`  [${String(done).padStart(2)}/${total}] ${scope}\n`);
    },
  });

  const p = payload.portfolio;
  console.log(`\nBase window   ${p.baseWindow.from} → ${p.baseWindow.to}  (actuals)`);
  console.log(`Budget window ${manifest.budgetWindow.from} → ${manifest.budgetWindow.to}`
    + `  (Year 1 = ${p.anchor === 'calendarYear' ? 'calendar year' : 'rolling'})`);
  console.log('');
  p.years.forEach(y => console.log(
    `  ${y.label} (${y.months})  EGI ${fmt(y.egi)}  OpEx ${fmt(y.totalOpex)}  `
    + `NOI ${fmt(y.noi)}  margin ${(y.noi / y.egi * 100).toFixed(1)}%`));

  console.log(`\n${manifest.workbooks.length} workbooks in ${path.relative(process.cwd(), budgetStore.STORE_DIR)}/`);
  const w = Math.max(...manifest.workbooks.map(x => x.scope.length));
  manifest.workbooks.forEach(x => console.log(
    `  ${x.scope.padEnd(w)}  ${String(x.units || '—').padStart(5)} units  `
    + `Y1 NOI ${fmt(x.year1NOI).padStart(9)}  ${(x.size / 1024).toFixed(0)}KB  ${x.file}`));

  console.log('\n✓ Budget set built. The tab and every download now serve these files —'
    + '\n  no Rent Manager calls, no recomputation, until you run this again.');
}

main().catch(err => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
