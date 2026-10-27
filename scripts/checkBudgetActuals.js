// Live actuals over a frozen budget set (budgetModel.overlayActuals): a set
// built before any budget month closed still shows each month as it closes.

const bm = require('../services/budgetModel');

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

const labels = ['Jul 26', 'Aug 26', 'Sep 26', 'Oct 26', 'Nov 26'];
const budget = name => ({
  scope: name, months: ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'], monthLabels: labels,
  lines: { propTax: [100, 100, 100, 100, 100] }, totals: { noi: [500, 500, 500, 500, 500] },
  actuals: labels.map(() => null),   // as built on Jul 29: nothing closed yet
});
const set = { entities: { 'Maple Court': budget('Maple Court'), 'Willow Creek': budget('Willow Creek') }, portfolio: budget('Portfolio') };
const frozen = JSON.stringify(set);
const snap = {
  refreshedAt: '2026-10-20T06:00:00Z', asOfMonth: '2026-10', partialCurrentMonth: true,
  months: ['Jun 26', 'Jul 26', 'Aug 26', 'Sep 26', 'Oct 26'],
  entities: {
    'Maple Court': { totalIncome: [0, 1000, 1000, 1000, 400], totalExpense: [0, 400, 450, 500, 100], propTax: [0, 120, 130, 140, 10] },
    'Willow Creek':  { totalIncome: [0, 2000, 2000, 0, 0],      totalExpense: [0, 900, 950, 0, 0],    propTax: [0, 90, 95, 0, 0] },
  },
};

const out = bm.overlayActuals(set, snap);
const j = out.entities['Maple Court'].actuals;
check('months closed since the build fill in', j[0] && j[1] && j[2] && j[0].noi === 600 && j[2].lines.propTax === 140);
check('the month in progress stays empty', j[3] === null);
check('months the P&L does not reach stay empty', j[4] === null);
const p = out.portfolio.actuals;
check('the portfolio counts a month once every entity has it', p[0] && p[0].income === 3000 && p[0].lines.propTax === 210);
// An entity the snapshot does not carry keeps what it was built with (nothing),
// so no month is complete for the portfolio.
const partial = bm.overlayActuals(set, { ...snap, entities: { 'Maple Court': snap.entities['Maple Court'] } });
check('an entity missing from the P&L keeps its built actuals', partial.entities['Willow Creek'].actuals.every(a => a === null));
check('the portfolio leaves out a month any entity lacks', partial.portfolio.actuals.every(a => a === null));
check('the budget numbers are untouched', out.entities['Maple Court'].lines.propTax[0] === 100 && out.portfolio.totals.noi[0] === 500);
check('the stored set is not modified', JSON.stringify(set) === frozen);
check('the overlay says what it read', out.actualsLive.asOfMonth === '2026-10');
check('no snapshot leaves the set as it was', bm.overlayActuals(set, null) === set);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll budget actuals checks pass');
process.exit(failed ? 1 : 0);
