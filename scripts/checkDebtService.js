// Debt service (services/debtService.js) against a stand-in chart, P&L and
// Report 51: the failures that left the old snapshot empty, and what replaced it.

const ds = require('../services/debtService');

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

// 600 filler accounts first, so the loans sit past the old 500 cut-off.
const chart = Array.from({ length: 600 }, (_, i) => ({ GLAccountID: 1000 + i, Reference: `9${i}`, Name: `Filler ${i}`, GLAccountType: 'Expense' }));
chart.push(
  { GLAccountID: 46, Reference: '2300', Name: 'Mortgage Loan', GLAccountType: 'LongTermLiability' },
  { GLAccountID: 777, ParentGLAccountID: 46, Reference: '2314', Name: 'Mortagage Loan- PNC Bank Willow Creek', GLAccountType: 'LongTermLiability' },
  { GLAccountID: 802, ParentGLAccountID: 46, Reference: '2317', Name: 'Mortgage Loan - Trimont Willow Creek', GLAccountType: 'LongTermLiability' },
  { GLAccountID: 22, Reference: '2007', Name: 'Loans', GLAccountType: 'OtherCurrentLiability' },
  { GLAccountID: 761, ParentGLAccountID: 22, Reference: '2020', Name: 'Loans - Genco Birchwood Commons LLC', GLAccountType: 'OtherCurrentLiability' },
);
const pl = {
  months: ['Nov 25', 'Dec 25', 'Jan 26', 'Feb 26', 'Mar 26'], partialCurrentMonth: true,
  properties: {
    1: { name: '410 Alder Street', entity: 'Willow Creek', mortgage: [999, 999, 100, 100, 50] },
    12: { name: '88-92 Maple Court', entity: 'Maple Court', mortgage: [0, 0, 40, 40, 0] },
    5: { name: 'Willow Creek', entity: 'Birchwood Commons', mortgage: [0, 0, 0, 0, 0] },
  },
};
const map = { byId: new Map([[1, { entity: 'Willow Creek', name: '410 Alder Street', shortName: '169Ma' }], [12, { entity: 'Maple Court', name: '88 Maple Court', shortName: '126Co' }], [13, { entity: 'Maple Court', name: '90 Maple Court', shortName: '130Co' }], [5, { entity: 'Birchwood Commons', name: 'Willow Creek', shortName: 'CC' }]]) };
let glArgs = null;
const deps = {
  now: () => new Date('2026-03-15T12:00:00Z'),
  rentManager: { allGLAccounts: async () => chart },
  loadPL: () => pl,
  primaryOf: pid => (pid === 13 ? 12 : pid),
  propertyEntityMap: async () => map,
  glDetail: async args => { glArgs = args; return { postings: [
    { property: '169Ma', debit: 500, credit: 0 },
    { property: '130Co', debit: 70, credit: 0 },        // the split side of 88-92 Maple Court
    { property: 'CC', debit: 0, credit: 20000 },        // new borrowing, not a payment
    { property: 'Nowhere', debit: 30, credit: 0 },
    { property: '169Ma', debit: 164347911, credit: 0, txnType: 'JOURNL', reference: 'J4948', description: 'Net Payoff of Existing Arbor Loan to Arbor Realty SR, Inc' },
    { property: 'CC', debit: 653102, credit: 0, txnType: 'JOURNL', reference: 'J4943', description: 'Payoff Letter Birchwood Commons - Arbor' },
    { property: 'CC', debit: 2500000, credit: 0, txnType: 'JOURNL', reference: 'J9', description: 'Loan transfer' },
  ] }; },
};

(async () => {
  const d = await ds.build(deps);
  check('loan accounts past the first 500 are found', glArgs.refs.includes('2314') && glArgs.refs.includes('2317'));
  check('the misspelled "Mortagage" loan is found (by parent, not name)', glArgs.refs.includes('2314'));
  check('member and intercompany loans are left out', !glArgs.refs.includes('2020') && !glArgs.refs.includes('2007'));
  check('the window is this calendar year to date', glArgs.startDate === '2026-01-01' && glArgs.endDate === '2026-03-15');
  const m = d.by_property.find(r => r.property === '410 Alder Street');
  check('interest is this year\'s P&L mortgage line only', m.interest === 250);
  check('principal is the debits to the loan accounts', m.principal === 500 && m.total === 750);
  const c = d.by_property.find(r => r.property === '88-92 Maple Court');
  check('a split side\'s paydown lands on its building', c && c.principal === 70 && c.interest === 80);
  check('a credit (new borrowing) is not counted as a payment', !d.by_property.find(r => r.property === 'Willow Creek'));
  check('paydowns outside the entity map are named in the notes', d.notes.some(n => /\$30 posted to buildings outside/.test(n)));
  check('the month in progress is noted', d.notes.some(n => /Mar 26 is month to date/.test(n)));
  check('a refinance payoff is not principal', m.principal === 500 && d.payoffs.some(p => p.reference === 'J4948'));
  check('a payoff named in its description is left out at any size', d.payoffs.some(p => p.reference === 'J4943') && !d.by_property.find(r => r.property === 'Willow Creek'));
  check('a single entry of $1M or more is held out too', d.payoffs.some(p => p.reference === 'J9'));
  check('the payoffs are named in the notes', d.notes.some(n => /3 loan payoffs this year .* are refinancing, not debt service/.test(n)));
  check('entity totals add up', d.byEntity['Willow Creek'].total === 750 && d.total === 900);
  check('a new snapshot is current; an old one is outdated', !ds.isOutdated(d) && ds.isOutdated({ from: '2026-01-01', by_property: [] }) && ds.isOutdated({ version: 3 }));

  const broken = await ds.build({ ...deps, glDetail: async () => { throw new Error('Insufficient privileges'); } });
  check('a Report 51 failure keeps interest and says why principal is missing', broken.interest === 330 && broken.principal === 0 && broken.notes.some(n => /Principal could not be read: Insufficient privileges/.test(n)));
  const noPl = await ds.build({ ...deps, loadPL: () => null });
  check('no P&L snapshot is said, not shown as $0 interest', noPl.notes.some(n => /P&L snapshot has not been built/.test(n)));

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll debt service checks pass');
  process.exit(failed ? 1 : 0);
})();
