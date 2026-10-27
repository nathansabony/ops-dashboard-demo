// A check keyed to expense for a bill that was already entered
// (services/duplicatePayments.js), against the postings that found it: 508-10
// 67th St, Sep 2026, and the three buildings with the same entry the same month.

const dp = require('../services/duplicatePayments');

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

const P = (o) => ({ property: '50867', vendor: 'PSE&G', vendorId: 1516, invoiceNo: null, ...o });
const postings = [
  // The May–Aug bills, gas (125) and electric (219), house account 7379602209.
  P({ txnType: 'BILLITM', txnId: '251572', date: '2026-05-07', accountId: 125, account: '5401 Utilities Heating Gas', amount: 1016.41, description: 'PSE&G : 7379602209 -04/01/26 - 05/01/26' }),
  P({ txnType: 'BILLITM', txnId: '251572', date: '2026-05-07', accountId: 219, account: '5404 Utilities Electric', amount: 141.02, description: 'PSE&G : 7379602209 -04/01/26 - 05/01/26' }),
  P({ txnType: 'BILLITM', txnId: '261007', date: '2026-08-04', accountId: 125, account: '5401 Utilities Heating Gas', amount: 357.12, description: 'PSE&G : 7379602209 - 07/02/26-07/31/26' }),
  // The building's second meter, same GL account and same dates — a different bill.
  P({ txnType: 'BILLITM', txnId: '261006', date: '2026-08-04', accountId: 125, account: '5401 Utilities Heating Gas', amount: 9.67, description: 'PSE&G : 7858776703 - 07/02/26-07/31/26' }),
  // The hand-keyed check, 9/9: the same two periods again, straight to expense.
  P({ txnType: 'CHKITM', txnId: '160436', date: '2026-09-09', reference: 'ACH', accountId: 125, account: '5401 Utilities Heating Gas', amount: 1016.41, description: 'PSE&G : 7379602209 -04/01/26 - 05/01/26' }),
  P({ txnType: 'CHKITM', txnId: '160436', date: '2026-09-09', reference: 'ACH', accountId: 219, account: '5404 Utilities Electric', amount: 141.02, description: 'PSE&G : 7379602209 -4/1/2026 - 5/1/2026' }),
  P({ txnType: 'CHKITM', txnId: '160436', date: '2026-09-09', reference: 'ACH', accountId: 125, account: '5401 Utilities Heating Gas', amount: 357.12, description: 'PSE&G : 7379602209 - 07/02/26-07/31/26' }),
  // The credit that tried to undo it, all to Electric.
  P({ txnType: 'CREDIT', txnId: '160438', date: '2026-09-14', accountId: 219, account: '5404 Utilities Electric', amount: -5676.28, description: 'PSE&G' }),
  // A check that pays something no bill carries — not a duplicate.
  P({ txnType: 'CHKITM', txnId: '170000', date: '2026-09-20', accountId: 125, account: '5401 Utilities Heating Gas', amount: 50, description: 'PSE&G : 7379602209 - 09/01/26-09/30/26' }),
  // Another building, same period text — must not match 67th St's bill.
  P({ property: '33050', txnType: 'CHKITM', txnId: '160441', date: '2026-09-14', accountId: 125, account: '5401 Utilities Heating Gas', amount: 348.06, description: 'PSE&G : 7379700405 - 08/07/26-09/04/26' }),
  P({ property: '33050', txnType: 'BILLITM', txnId: '264791', date: '2026-09-10', accountId: 125, account: '5401 Utilities Heating Gas', amount: 348.05, description: 'PSE&G : 7379700405 - 08/07/26-09/04/26' }),
  // A bill reversed by a bill credit, then paid by check — one charge, not two.
  P({ property: '96Hi', txnType: 'BILLITM', txnId: '8001', date: '2026-06-01', accountId: 219, account: '5404 Utilities Electric', amount: 120, description: 'PSE&G : 7311112222 - 05/01/26-05/31/26' }),
  P({ property: '96Hi', txnType: 'CRDITM', txnId: '8002', date: '2026-06-05', accountId: 219, account: '5404 Utilities Electric', amount: -120, description: 'PSE&G : 7311112222 - 05/01/26-05/31/26' }),
  P({ property: '96Hi', txnType: 'CHKITM', txnId: '8003', date: '2026-06-10', accountId: 219, account: '5404 Utilities Electric', amount: 120, description: 'PSE&G : 7311112222 - 05/01/26-05/31/26' }),
  // A repair paid twice by invoice number.
  P({ property: '234Je', vendor: 'Tubs Inc.', vendorId: 77, txnType: 'BILLITM', txnId: '9001', date: '2026-08-01', accountId: 300, account: '5100 Repairs', amount: 900, description: 'Tubs Inc.: 100134', invoiceNo: '100134' }),
  P({ property: '234Je', vendor: 'Tubs Inc.', vendorId: 77, txnType: 'CHKITM', txnId: '9100', date: '2026-08-20', accountId: 300, account: '5100 Repairs', amount: 900, description: 'Tubs Inc.: 100134', invoiceNo: '100134' }),
];

const found = dp.findDuplicates(postings, { propertyIdByShort: new Map([['50867', 142], ['33050', 135]]) });
const pair = (c, b) => found.find(f => f.check.id === c && f.bill.id === b);

check('the 9/9 check repeats the May bill', !!pair('160436', '251572'));
check('…on both of its lines, gas and electric, despite "4/1/2026" vs "04/01/26"', (pair('160436', '251572') || {}).lines?.length === 2);
check('the 9/9 check repeats the Aug bill', !!pair('160436', '261007'));
check('a second meter on the same dates is a different bill, not a duplicate', !pair('160436', '261006'));
check('the duplicate is counted at the amount both carry', (pair('160436', '251572') || {}).duplicateAmount === 1157.43);
check('the credit that tried to undo it rides along', (pair('160436', '251572') || {}).credits?.[0]?.id === '160438');
check('the finding names the building by id', (pair('160436', '251572') || {}).propertyId === 142);
check('a check no bill carries is left alone', !found.some(f => f.check.id === '170000'));
check('a one-cent difference still matches, and is not called a typo (410 Alder Street)', !!pair('160441', '264791') && pair('160441', '264791').amountsDiffer === false);
check('a repair paid twice is found by invoice number', !!pair('9100', '9001'));
check('a bill reversed by a bill credit is not counted against the check that replaced it', !found.some(f => f.check.id === '8003'));
check('nothing pairs across buildings', found.every(f => postings.find(p => p.txnId === f.bill.id).property === f.property));
check('a check\'s pairs sit together, biggest check first', found[0].check.id === '160436' && found[1].check.id === '160436');

check('the period is read anywhere in the text', dp.periodOf({ description: 'PSE&G : 7379602209 -04/01/26 - 05/01/26' }) === '04/01/26-05/01/26');
check('a spaced utility account number reads as one', dp.utilityAccountOf({ description: 'PSE&G : 73 771 969 04 - 07/22/26-08/19/26' }) === '7377196904');
const w = dp.windowDates(new Date(Date.UTC(2026, 9, 19)));
check('the window is the last six months through this one', w.startDate === '2026-05-01' && w.endDate === '2026-10-31');

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nAll duplicate-payment checks passed.');
