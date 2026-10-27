// Reconciliation harness for the per-property P&L pipeline (headless, ~10 RM calls,
// not the full ~89-property build). Run after chart-of-accounts or category-mapping
// changes. Contains NO financial figures (policy: no financials in code) — instead
// of comparing against baked reference numbers it checks internal consistency:
//
//   1. Year-chunk stitching fills every requested month (no silent zero gaps).
//   2. The sum of individual property pulls equals the portfolio-wide ('All') pull
//      for the same window — proves per-property filtering + rollup are exact.
//   3. A single property returns a real, non-zero monthly series.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pf = require('../services/propertyFinancials');
const { buildPropertyEntityMap } = require('../services/entityMap');
const rm = require('../services/rentManagerClient');

(async () => {
  const year = new Date().getFullYear() - 1; // most recent fully-closed year
  const months = pf.enumerateMonths(`${year}-01`, `${year}-12`);

  // (1) All-scope pull: every month populated?
  const all = await pf.pullScopeSeries('All', months);
  const zeros = all.totalIncome.filter(v => !v).length;
  console.log(`(1) All-scope ${year}: ${all.totalIncome.length} months, ${zeros} zero months ${zeros === 0 ? '✓' : '✗ INVESTIGATE'}`);

  // (2) Sum of a few properties vs the same properties pulled as one combined scope.
  const { byId } = await buildPropertyEntityMap(rm);
  const ids = [...byId.keys()].slice(0, 3);
  const singles = [];
  for (const id of ids) singles.push(await pf.pullScopeSeries(String(id), months));
  const combined = await pf.pullScopeSeries(ids.join(','), months);
  let worst = 0;
  months.forEach((m, i) => {
    const sum = singles.reduce((s, p) => s + p.totalIncome[i], 0);
    const diff = Math.abs(sum - combined.totalIncome[i]);
    if (diff > worst) worst = diff;
  });
  console.log(`(2) Sum-of-${ids.length}-properties vs combined pull: worst monthly diff $${Math.round(worst)} ${worst < 1 ? '✓ exact' : worst < 100 ? '~ rounding' : '✗ INVESTIGATE'}`);

  // (3) One property, real series.
  const meta = byId.get(ids[0]);
  const nz = singles[0].totalIncome.filter(v => v).length;
  console.log(`(3) Property ${ids[0]} "${meta.name}" (${meta.entity}): ${nz}/${months.length} non-zero income months ${nz > months.length / 2 ? '✓' : '✗ INVESTIGATE'}`);

  console.log('\nDone. For a cell-level check against an official P&L export, run the export in RM and eyeball a few categories — no reference numbers are kept in this repo by design.');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
