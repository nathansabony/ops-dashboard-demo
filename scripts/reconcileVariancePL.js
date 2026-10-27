// Proof that the Variance tab's numbers ARE the P&L's numbers — same months, none
// dropped, none double-counted. Run it whenever someone says "this doesn't match":
//
//   node scripts/reconcileVariancePL.js            # 3 properties, trailing 12
//   node scripts/reconcileVariancePL.js 2          # one property by RM PropertyID
//   node scripts/reconcileVariancePL.js Willow Creek Rd    # or by name
//
// Contains NO financial figures (repo policy) — every check is an identity that
// must hold whatever the numbers happen to be, so the script stays valid as the
// books change and can be run against any property without leaking anything.
//
// Written 2026-08-13 after a review meeting where a Management Fees cell read $0
// against an export that read $1,328.93. The pipeline turned out to be exact; the
// export had been run on CASH and the tab is ACCRUAL. These checks exist so that
// question is answered in one command next time instead of an afternoon.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pf = require('../services/propertyFinancials');
const { buildPropertyEntityMap } = require('../services/entityMap');
const rm = require('../services/rentManagerClient');

function num(v) {
  if (v == null || v === '') return 0;
  const t = String(v).trim();
  const n = Number(t.replace(/[$,()]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return /\([^)]+\)/.test(t) ? -n : n;
}

// The window the tab displays: trailing 12 complete months + the in-progress one.
function trailingWindow(now) {
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = new Date(end.getFullYear(), end.getMonth() - 12, 1);
  const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return { fromYM: ym(start), toYM: ym(end) };
}
function dateRange(months) {
  const f = months[0], l = months[months.length - 1];
  const lastDay = new Date(l.year, l.m0 + 1, 0).getDate();
  return [`${f.year}-${String(f.m0 + 1).padStart(2, '0')}-01`,
          `${l.year}-${String(l.m0 + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`];
}

const EPS = 0.005; // half a cent — RM returns 2dp
let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

(async () => {
  const arg = process.argv[2];
  const { byId } = await buildPropertyEntityMap(rm);
  let targets;
  if (!arg) targets = [...byId.entries()].slice(0, 3);
  else if (/^\d+$/.test(arg)) targets = [...byId.entries()].filter(([id]) => id === Number(arg));
  else targets = [...byId.entries()].filter(([, m]) => m.name.toLowerCase().includes(arg.toLowerCase()));
  if (!targets.length) { console.error(`No property matched "${arg}".`); process.exit(1); }

  const { fromYM, toYM } = trailingWindow(new Date());
  const months = pf.enumerateMonths(fromYM, toYM).slice(-12); // the 12 the grid shows
  const [startDate, endDate] = dateRange(months);
  console.log(`Reconciling report ${pf.REPORT_ID} (ProfitLossRecapMonth, Basis=${pf.BASIS_ACCRUAL} Accrual)`);
  console.log(`Window ${startDate} → ${endDate} (${months.length} months)\n`);

  for (const [pid, meta] of targets) {
    console.log(`${meta.name} — PropertyID ${pid} (${meta.entity})`);

    // (A) The displayed window comes back from ONE report call, correctly labelled.
    const rows = await pf.runReport45(pid, startDate, endDate);
    const cols = rows.length ? Object.keys(rows[0]).filter(k => /^[A-Z]{3}\d{4}$/.test(k)) : [];
    const wanted = months.map(m => m.colKey);
    check('single call returns exactly the requested months, in RM\'s own column names',
      cols.length === wanted.length && wanted.every(w => cols.includes(w)),
      `got ${cols.length} cols${cols.length ? ` (${cols[0]}…${cols[cols.length - 1]})` : ''}`);

    // (B) Nothing dropped or double-counted: RM emits its own Total per row, and
    //     the monthly columns must add up to it. A month silently missing from the
    //     grid, or a hierarchy row counted twice, breaks this identity.
    let worstTotal = 0, worstRow = '';
    let rowsChecked = 0;
    for (const r of rows) {
      if (!('Total' in r)) continue;
      rowsChecked++;
      const d = Math.abs(wanted.reduce((s, c) => s + num(r[c]), 0) - num(r.Total));
      if (d > worstTotal) { worstTotal = d; worstRow = `${r.GLAccountReference} ${r.GLAccountName}`; }
    }
    check(`sum(monthly columns) === RM's own Total, all ${rowsChecked} rows`,
      worstTotal < EPS, worstTotal < EPS ? '' : `worst $${worstTotal.toFixed(2)} on ${worstRow}`);

    // (C) The pipeline's stitched multi-call pull equals the single-call pull, cell
    //     for cell. This is the "are chunked pulls shifting months?" question.
    const stitched = await pf.pullScopeSeries(String(pid), months);
    const single = pf.parseSeries(rows, months);
    let worstCell = 0, whereCell = '';
    for (const k of pf.ALL_KEYS) months.forEach((m, i) => {
      const d = Math.abs((stitched[k][i] || 0) - (single[k][i] || 0));
      if (d > worstCell) { worstCell = d; whereCell = `${k} ${m.label}`; }
    });
    check(`pipeline pull === single-call pull, ${pf.ALL_KEYS.length} categories × ${months.length} months`,
      worstCell < EPS, worstCell < EPS ? '' : `worst $${worstCell.toFixed(2)} at ${whereCell}`);

    // (D) Every category the tab draws maps to a GL reference that RM actually
    //     returned. A ref that has silently disappeared from the chart of accounts
    //     reads as a permanent $0 row — indistinguishable, on screen, from "nothing
    //     was posted". This is the "numbers just being forgotten" case.
    const refsPresent = new Set(rows.map(r => String(r.GLAccountReference || '').trim()).filter(Boolean));
    const missing = [];
    for (const [key, refs] of Object.entries(pf.CATEGORY_REFS)) {
      if (!refs.some(ref => refsPresent.has(ref))) missing.push(`${key}(${refs.join('/')})`);
    }
    check('every tracked category maps to a GL ref present in the report',
      missing.length === 0, missing.length ? `absent here: ${missing.join(', ')}` : '');

    // (E) Category totals must not exceed the report's own operating expense side —
    //     a cheap guard against a ref that starts double-counting a hierarchy.
    const expTotal = months.reduce((s, _, i) => s + single.totalExpense[i], 0);
    const opCats = ['propTax', 'mgmtFees', 'insurance', 'heatingGas', 'waterSewer', 'electric', 'repairsMaint', 'payroll'];
    const catSum = opCats.reduce((s, k) => s + months.reduce((t, _, i) => t + single[k][i], 0), 0);
    check('tracked operating categories sum to no more than Total Expense',
      catSum <= expTotal + EPS,
      catSum <= expTotal + EPS ? `(${expTotal ? Math.round(catSum / expTotal * 100) : 0}% of opex is on tracked lines)` : 'a category is double-counting');

    console.log('');
  }

  console.log(failures === 0
    ? 'All checks passed — the tab\'s months are RM\'s months, nothing dropped, nothing double-counted.'
    : `${failures} check(s) FAILED — investigate before trusting the tab.`);
  console.log('\nIf a figure still disagrees with a P&L export, check the export\'s "Cash or Accrual"');
  console.log('setting first. This tab is Accrual (Basis=1); a Cash export legitimately differs.');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
