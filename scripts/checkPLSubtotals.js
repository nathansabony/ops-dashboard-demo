// Offline check (no Rent Manager call) that the Variance tab's P&L parse counts
// every dollar once — the "numbers close but not matching" bug from the
// 2026-09-22 review, where water, sewer and solid waste were added AND their
// combined Total Water & Sewer row on top. Each case below is one way RM's
// expanded (COLLAPSEPARENTS=False) Report 45 can print a parent account; every
// one must give the figure the collapsed report prints.
//
//   node scripts/checkPLSubtotals.js
const pf = require('../services/propertyFinancials');

const months = pf.enumerateMonths('2026-01', '2026-02');
const [JAN, FEB] = months.map(m => m.colKey);
let failures = 0;
function eq(label, got, want) {
  const ok = Math.abs(got - want) < 0.005;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${label}${ok ? '' : `  got ${got}, want ${want}`}`);
}
const row = (ref, name, jan, feb, extra = {}) => ({
  GLAccountReference: ref, GLAccountName: name, GLAccountTypeName: 'Expense',
  [JAN]: jan, [FEB]: feb, ...extra,
});
const kids = () => [
  row('5402-1', 'Utilities Water', 100, 110),
  row('5402-2', 'Utilities Sewer', 50, 55),
  row('5402-3', 'Solid Waste Charges', 25, 30),
];
const other = () => row('5404', 'Utilities Electric', 40, 40);
// Collapsed truth: water & sewer 175 / 195, total expense 215 / 235.
function expect(label, rows, { ws = [175, 195], exp = [215, 235] } = {}) {
  console.log(label);
  const s = pf.parseSeries(rows, months);
  eq('Water & Sewer, Jan', s.waterSewer[0], ws[0]);
  eq('Water & Sewer, Feb', s.waterSewer[1], ws[1]);
  eq('Total Expense, Jan', s.totalExpense[0], exp[0]);
  eq('Total Expense, Feb', s.totalExpense[1], exp[1]);
  eq('Water sub-line still split out', s.waterSubWater[0], 100);
}

expect('1. RM flags header and total', [
  row('5402', 'Water & Sewer', '', '', { IsHeader: 'True' }), ...kids(),
  row('5402', 'Total Water & Sewer', 175, 195, { IsTotal: 'True' }), other(),
]);
expect('2. Total row NOT flagged, named "Total …"', [
  row('5402', 'Water & Sewer', '', '', { IsHeader: 'True' }), ...kids(),
  row('5402', 'Total Water & Sewer', 175, 195), other(),
]);
expect('3. Total row has no reference', [
  row('5402', 'Water & Sewer', '', '', { IsHeader: 'True' }), ...kids(),
  row('', 'Total Water & Sewer', 175, 195, { IsTotal: 'True' }), other(),
]);
expect('4. Children then an unflagged, unnamed combined parent row', [
  ...kids(), row('5402', 'Water & Sewer', 175, 195), other(),
]);
expect('5. Money posted directly on the parent is kept, not mistaken for a total', [
  row('5402', 'Water & Sewer', '', '', { IsHeader: 'True' }), ...kids(),
  row('5402', 'Water & Sewer (direct)', 10, 0),
  row('5402', 'Total Water & Sewer', 185, 195, { IsTotal: 'True' }), other(),
], { ws: [185, 195], exp: [225, 235] });
expect('6. No combined row at all — children summed', [
  row('5402', 'Water & Sewer', '', '', { IsHeader: 'True' }), ...kids(), other(),
]);
expect('7. Nested block (parent inside a larger section total)', [
  row('5400', 'Utilities', '', '', { IsHeader: 'True' }),
  row('5402', 'Water & Sewer', '', '', { IsHeader: 'True' }), ...kids(),
  row('5402', 'Total Water & Sewer', 175, 195, { IsTotal: 'True' }), other(),
  row('5400', 'Total Utilities', 215, 235),
]);

// The breakdown under a line (the grid's ▸) must add up to the line, nested
// blocks included, whichever way RM printed the combined row.
console.log('8. Account tree under a line adds up to the line');
{
  const rows = [
    row('5100', 'Repairs & Maintenance', '', '', { IsHeader: 'True' }),
    row('5102', 'Windows', 6, 0),
    row('5200', 'Materials & Supplies', '', '', { IsHeader: 'True' }),
    row('5201', 'Appliances', 4, 0), row('5200', 'Other Materials', 116, 52),
    row('5200', 'Total Materials & Supplies', 120, 52, { IsTotal: 'True' }),
    row('5100', 'Total Repairs & Maintenance', 126, 52, { IsTotal: 'True' }),
    row('5402', 'Water & Sewer', '', '', { IsHeader: 'True' }), ...kids(),
    row('5402', 'Total Water & Sewer', 175, 195),
  ];
  const s = pf.parseSeries(rows, months);
  const t = pf.parseAccountTree(rows, months);
  for (const key of ['repairsMaint', 'waterSewer']) months.forEach((m, i) =>
    eq(`${key} ${m.label}: leaves = line`, (t[key] || []).filter(l => l.kind === 'leaf').reduce((a, l) => a + l.s[i], 0), s[key][i]));
  eq('nested block kept as head + total', (t.repairsMaint || []).filter(l => l.kind !== 'leaf').length, 2);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll P&L subtotal checks passed.');
process.exit(failures ? 1 : 0);
