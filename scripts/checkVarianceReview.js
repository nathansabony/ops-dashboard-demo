#!/usr/bin/env node
// The review every flag gets (services/varianceReview.js), against canned postings,
// bill lookups and payee history — no network, no Rent Manager.
//
// The owner, 2026-11-02: the hand-reviewed format "should be expanded to every single
// variance as an automatic thing". The rules came from the first eleven hand reviews,
// so each fixture below is the SHAPE of one of those findings, with made-up figures
// (repo policy: no real financials). What this guards:
//   • each kind of mistake is named on a fixture built for it — a bill entered twice,
//     a wire coded to expense, a year of premium in one month, a back-dated bill, one
//     big bill on one building, bills past due — and a quiet month names none;
//   • the conclusion carries the figures it cites (every dollar in the headline is on a
//     posting, a bill or a payee line in the fixture);
//   • a financed premium is not called past due; a bill settled by a credit is not open;
//   • a much bigger problem outranks a small specific one;
//   • a run-rate flag splits the change by payee and names journal entries as such;
//   • nothing here claims a cause the data does not show ("because", "due to").
//
//   node scripts/checkVarianceReview.js

const review = require('../services/varianceReview');

let failed = 0, n = 0;
function check(name, ok, detail) {
  n += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failed += 1; if (detail) console.log(`        ${detail}`); }
}

let seq = 1;
const P = o => ({
  id: `p${seq}`, date: '2026-09-10', description: '', reference: '', vendor: 'Acme Supply', vendorId: 7, property: '101Main',
  account: '5114 Repairs & Maintenance', amount: 100, txnType: 'BILLITM', txnId: `t${seq++}`, invoiceNo: null, ...o,
});
const MONTH = '2026-09';
const flag = { scopeLabel: '101 Main St', scopeToken: 'prop:101', line: { key: 'repairsMaint', label: 'Repairs & Maint.' }, month: MONTH };
const TODAY = '2026-11-02';
const quiet = [-5, -4, -3, -2, -1].map((n, i) => P({ date: `2026-0${4 + i}-10`, amount: 1000, vendor: 'Steady Co', vendorId: 2, txnId: `q${i}` }));
const INV = (cur, extra) => ({ mode: 'change', target: cur, totals: { cur, prev: 1000 }, findings: [], checked: ['postings'], limits: [], summary: 'summary', next: 'next', ...extra });
// The lookup's own shape: the bill's comment lives in other[], not on the bill.
const BACKUP = o => ({
  bill: { id: 1, date: '2026-09-10', dueDate: '2026-10-10', amount: 0, number: 'X', enteredBy: 'A. Clerk', enteredOn: '2026-09-12',
    approval: { approved: true, by: 'A. Boss', on: '2026-09-13' }, allocated: { amount: 0, inFull: false }, lines: [], lineCount: 0,
    other: o.bill && o.bill.comment ? [{ field: 'Comment', label: 'Comment', value: o.bill.comment }] : [], ...(o.bill || {}) },
  payment: o.payment === undefined ? null : o.payment, attachments: o.attachments || [],
});
const lk = (p, o) => ({ posting: p, backup: BACKUP({ ...o, bill: { amount: p.amount, ...(o.bill || {}) } }) });
const run = (A, inv, lookups, payee) => review.build({ inv, A: [...quiet, ...A], lookups: lookups || [], payee: payee || null, flag, today: TODAY });
const NO_CAUSAL = /\b(because|due to|caused by)\b/i;

// ── 1. the same bill entered twice ─────────────────────────────────────────────
{
  const a = P({ vendor: 'State of NJ', reference: '4525460', amount: 3866, date: '2026-09-02' });
  const b = P({ vendor: 'State Of New Jersey-DORES', vendorId: 8, reference: '4525460', amount: 3866, date: '2026-09-02' });
  const r = run([a, b], INV(3866), [lk(a, { attachments: [{ id: 5, name: 'inv.pdf' }] }), lk(b, {})]);
  check('same reference and amount on two bills → "Same bill entered twice"', r.verdict === 'duplicate', r.verdict);
  check('…naming both vendor names and the amount', /\$3,866/.test(r.headline) && /State of NJ/.test(r.headline) && /State Of New Jersey-DORES/.test(r.headline), r.headline);
  check('…and counting one copy as the money at issue', r.atIssue === 3866, String(r.atIssue));
  check('…keeping the copy that has the invoice, voiding the other', r.actions.some(x => /Void the extra copy/.test(x.do) && /one with the invoice/.test(x.do)));
  check('…and marking both rows red', r.bills.filter(x => x.tone === 'bad').length === 2);
  const c = P({ vendor: 'Acme Supply', reference: 'Sep-26-101', amount: 500 });
  const d = P({ vendor: 'Acme Supply', reference: 'Aug-26-101', amount: 500, date: '2026-08-10' });
  const r2 = run([c, d], INV(500), []);
  check('a monthly bill with a different reference each month is not a duplicate', r2.verdict !== 'duplicate', r2.verdict);
  const e = P({ vendor: 'Water Co', reference: 'IN259852', amount: 219, description: 'Water Co : 22581' });
  const g = P({ vendor: 'Water Co', reference: 'IN260587', amount: 219, description: 'Water Co : 22581', date: '2026-08-12' });
  check('the same account number in the memo is not an invoice number', run([e, g], INV(219), []).verdict !== 'duplicate');
}

// ── 2. a payment with no bill, to a payee whose money goes elsewhere ──────────────
{
  const w = P({ vendor: 'Optco LLC', vendorId: 9, txnType: 'CHKITM', amount: 13000, reference: 'ACH', description: 'Optco LLC : OUTGOING WIRE #512', account: '5000 Management Fees' });
  const history = new Map([['id:9', { total: 700000, offExpense: 535000, items: [{ name: '2007-40 Loans - Demo', type: 'OtherCurrentLiability', amount: 535000 }, { name: '5055 Health Insurance', type: 'Expense', amount: 111000 }] }]]);
  const r = run([w], INV(13000), [{ posting: w, backup: { bill: null, payment: { direct: true, paidOn: '2026-09-10', reference: 'ACH', reconciled: true }, attachments: [] } }], history);
  check('a check with no bill to a payee booked mostly to a liability → "wrong kind of account"', r.verdict === 'wrong-account' && /High/.test(r.confidence), `${r.verdict} ${r.confidence}`);
  check('…citing the payee\'s own history and the account it normally goes to', /76%/.test(r.headline) && /2007-40 Loans - Demo/.test(r.headline), r.headline);
  const r2 = run([w], INV(13000), [], null);
  check('without payee history a wire is a question, not a finding', r2.verdict === 'wrong-account' && /Medium/.test(r2.confidence) && /history was not read/.test(r2.whatHappened.join(' ')), r2.confidence);
  const plain = P({ vendor: 'Acme', txnType: 'CHKITM', amount: 13000, reference: '1042', description: 'repairs' });
  const rp = run([plain], INV(13000), [], null);
  check('an ordinary check with no wire wording is "paid with no bill", not a wrong account', rp.verdict === 'paperwork' && /no bill behind it/.test(rp.headline), rp.verdict);
  const ach = P({ vendor: 'City Water', txnType: 'CHKITM', amount: 8000, reference: 'ACH', description: 'City Water : July' });
  check('a bare "ACH" reference is not read as a wire', run([ach], INV(8000), [], null).verdict !== 'wrong-account');
}

// ── 3. a year of cost in one month ──────────────────────────────────────────────────
{
  const prem = P({ vendor: 'AFCO', amount: 12000, date: '2026-09-29', description: 'AFCO : Policy 06/13/26 - 06/13/27', reference: '2026-27', account: '5053 Liability Insurance' });
  const r = run([prem], INV(12000), [lk(prem, { bill: { comment: 'Policy is financed for 9 Months', allocated: { amount: 4000, inFull: false } }, attachments: [{ id: 1, name: 'a.pdf' }] })]);
  check('a 12-month policy booked in one month → "A year of cost booked in one month"', r.verdict === 'timing' && /12 months/.test(r.headline) && /\$1,000 a month/.test(r.headline), r.headline);
  check('a financed premium is not called past due', !r.bills.some(b => /past due/.test(b.status)) && r.bills.some(b => /Financed/.test(b.status)), JSON.stringify(r.bills.map(b => b.status)));
  const back = P({ vendor: 'City MUA', amount: 36000, description: 'City MUA : 06/06/21 - 08/14/26', reference: 'Oct 26' });
  const r2 = run([back], INV(36000), [lk(back, { bill: { allocated: { amount: 36000, inFull: true } } })]);
  check('a bill for five years of usage is called a catch-up covering years', r2.verdict === 'timing' && /5\.\d years/.test(r2.headline), r2.headline);
  check('a bill fully allocated with no check is "settled by a credit", not open', /Settled by a credit/.test(r2.bills[0].status) && r2.bills[0].tone !== 'bad', r2.bills[0].status);
}

// ── 4. back-dated and corrected bills ───────────────────────────────────────────────
{
  const b = P({ vendor: 'Cleaner', amount: 4000, date: '2026-09-04' });
  const r = run([b], INV(4000), [lk(b, { bill: { date: '2026-09-04', enteredOn: '2027-02-20', enteredBy: 'R. Clerk' } })]);
  check('a bill keyed months after its date → "Back-dated bill"', r.verdict === 'correction' && /changed after it had closed/.test(r.headline), r.headline);
  const c = P({ vendor: 'City MUA', amount: 8000, description: 'City MUA : 04/01/26 - 07/14/26', reference: 'COR-26' });
  const r2 = run([c], INV(8000), [lk(c, { bill: { comment: '04/01/26 - 07/14/26 - CORRECTED BILL' } })]);
  check('a bill marked CORRECTED → "A corrected bill"', r2.verdict === 'correction' && /corrected bill/.test(r2.headline), r2.headline);
}

// ── 5. one big bill on one building ───────────────────────────────────────────────────
{
  const big = P({ vendor: 'Supply Inc', amount: 27000, reference: 'ORD1' });
  const r = run([big], INV(27000), [lk(big, { bill: { lines: [{ propertyId: 5 }, { propertyId: 5 }, { propertyId: 5 }], lineCount: 3, allocated: { amount: 27000, inFull: true } }, payment: { paidOn: '2026-10-09' } })]);
  check('a bill that is most of the move, all lines on one property, no invoice → "One big bill on one building"', r.verdict === 'concentration' && /no invoice attached/.test(r.headline), `${r.verdict}: ${r.headline}`);
  check('…and asks who ordered it before suggesting any change', r.actions.some(a => /Ask who ordered it/.test(a.do)));
  const regularQuiet = [0, 1, 2, 3, 4].map(i => P({ date: `2026-0${4 + i}-10`, amount: 1000, vendor: 'Payroll Co', vendorId: 3, txnId: `rq${i}` }));
  const payrun = P({ vendor: 'Payroll Co', vendorId: 3, amount: 24000, reference: 'RUN9' });
  const rr = review.build({ inv: INV(24000), A: [...regularQuiet, payrun], lookups: [lk(payrun, { bill: { lines: [{ propertyId: 5 }, { propertyId: 5 }], lineCount: 2, allocated: { amount: 24000, inFull: true } } })], flag, today: TODAY });
  check('a vendor that bills most months is not "one big bill on one building"', rr.verdict !== 'concentration', rr.verdict);
  const split = P({ vendor: 'Supply Inc', amount: 27000, reference: 'ORD2' });
  const r2 = run([split], INV(27000), [lk(split, { bill: { lines: [{ propertyId: 5 }, { propertyId: 6 }, { propertyId: 7 }], lineCount: 3 }, attachments: [{ id: 1, name: 'i.pdf' }] })]);
  check('the same bill split across buildings is not "one building"', r2.verdict !== 'concentration', r2.verdict);
}

// ── 6. bills past due; a bigger problem outranks a small specific one ──────────────────────
{
  const bills = [3000, 2500, 2000].map((a, i) => P({ vendor: `Painter ${i}`, vendorId: 20 + i, amount: a, reference: `inv-${i}-x`, date: '2026-09-05' }));
  const r = run(bills, INV(7500), bills.map(b => lk(b, { bill: { dueDate: '2026-09-25' } })));
  check('three open bills past their due date → "Unpaid or past due" with the total', r.verdict === 'unpaid' && /\$7,500/.test(r.headline) && /past due/.test(r.headline), r.headline);
  const old = P({ vendor: 'Painter 0', vendorId: 20, amount: 900, date: '2026-09-05' });
  const r2 = run([...bills.slice(1), old], INV(5400), [...bills.slice(1).map(b => lk(b, { bill: { dueDate: '2026-09-25' } })), lk(old, { bill: { date: '2026-09-05', enteredOn: '2027-03-01' } })]);
  check('a much bigger unpaid total outranks one small back-dated bill', r2.verdict === 'unpaid', r2.verdict);
}

// ── 7. nothing wrong → says so, and does not invent ───────────────────────────────────────────
{
  const ok = P({ vendor: 'Boiler Co', amount: 3000, reference: 'B-77' });
  const f = { kind: 'vendor-more', confidence: 'high', dollars: 3000, vendor: 'Boiler Co', headline: 'Boiler Co billed $3,000 against $1,000 a month before', evidence: ['Sep 10 $3,000.'], next: 'Open the bill.' };
  const r = run([ok], INV(3000, { findings: [f] }), [lk(ok, { bill: { dueDate: '2026-12-01', allocated: { amount: 3000, inFull: true } }, attachments: [{ id: 1, name: 'b.pdf' }], payment: { paidOn: '2026-09-20', reconciled: true } })]);
  check('a larger bill with its invoice, paid, nothing odd → "Looks like a real cost"', r.verdict === 'real', `${r.verdict}: ${r.headline}`);
  const r2 = run([P({ vendor: 'Mystery Co', amount: 2000, reference: 'M-1' })], INV(2000), []);
  check('with no rule firing and no findings the answer is "the postings do not say why"', r2.verdict === 'unexplained', r2.verdict);
  const r3 = run([], { mode: 'no-change', target: 0, totals: { cur: 1000 }, findings: [], checked: [], limits: [], summary: 'The postings agree with last month.' }, []);
  check('a month with no change in the postings says there is nothing to explain', r3.verdict === 'unexplained' && /no change/.test(r3.headline), r3.headline);
  const every = [r, r2, r3].flatMap(x => [x.headline, x.bottomLine, ...(x.whatHappened || [])]);
  check('no sentence asserts a cause the data does not show', every.every(s => !NO_CAUSAL.test(s)), every.find(s => NO_CAUSAL.test(s)));
}

// ── 8. every conclusion has the same parts ────────────────────────────────────────────────────────
{
  const a = P({ vendor: 'State of NJ', reference: '4525460', amount: 3866, date: '2026-09-02' });
  const b = P({ vendor: 'State Of New Jersey-DORES', vendorId: 8, reference: '4525460', amount: 3866, date: '2026-09-02' });
  const r = run([a, b], INV(3866), [lk(a, {}), lk(b, {})]);
  const need = ['verdict', 'verdictLabel', 'headline', 'bottomLine', 'atIssue', 'confidence', 'whatHappened', 'bills', 'actions', 'questions', 'checked', 'reviewed'];
  check('a review carries every field the page and the PDF print', need.every(k => r[k] != null), need.filter(k => r[k] == null).join(', '));
  check('every bill row names its month and the posting the invoice link is built from', r.bills.every(x => x.month === MONTH && x.posting));
  check('what was looked at is listed, and lookups that failed are named, not hidden', r.checked.length >= 3
    && /did not finish/.test(run([a], INV(3866), [{ posting: a, error: 'took longer than 90 seconds' }]).limits.join(' ')));
}

// ── 8b. a small mistake inside a big month names the big bill too ────────────────────────────────
{
  const fine = P({ vendor: 'Municipal Court', amount: 5400, reference: 'DPW-1' });
  const late = P({ vendor: 'Contractor', amount: 3400, date: '2026-09-06' });
  const r = run([fine, late], INV(10000), [lk(fine, { bill: { allocated: { amount: 5000, inFull: false } }, attachments: [{ id: 1, name: 'c.pdf' }] }),
    lk(late, { bill: { date: '2026-09-06', enteredOn: '2026-11-01' } })]);
  check('a back-dated bill that is a third of the move is named, and so is the biggest bill', r.verdict === 'correction' && /biggest bill in Sep 26 is Municipal Court \(\$5,400/.test(r.headline), r.headline);
}

// ── 9. a run-rate (12 months to X) flag ────────────────────────────────────────────────────────────────
{
  const mk = (ym, amt, o) => P({ date: `${ym}-15`, amount: amt, account: '5701 Wages', ...o });
  const A = [];
  const months = []; for (let m = 0; m < 24; m++) { const d = new Date(Date.UTC(2024, 10 + m, 1)); months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`); }
  months.forEach((ym, i) => {
    A.push(mk(ym, 4000, { vendor: 'Payroll Co', vendorId: 3, txnId: `pc${i}` }));
    if (i < 12) A.push(mk(ym, -3000, { txnType: 'JOURNL', vendor: '', vendorId: null, description: 'Journal Entry', txnId: `j${i}` }));   // earlier year: journals took $36,000 off
  });
  const r = review.buildTrend({ A, flag: { ...flag, month: '2026-10', line: { key: 'payroll', label: 'Payroll' } }, today: TODAY });
  check('a run-rate rise that is last year\'s journal entries → "Last year\'s books look low"', r.verdict === 'timing' && /last year looking low/.test(r.headline) && /\$36,000/.test(r.headline), r.headline);
  check('…and the split by payee is printed with journals as one line', r.decomposition.some(d => d.kind === 'journal' && d.change === 36000) && r.decomposition.length === 1, JSON.stringify(r.decomposition));
  const B = months.map((ym, i) => mk(ym, i < 12 ? 1000 : 1000, { vendor: 'Steady Co', vendorId: 4, txnId: `s${i}` })).concat(months.slice(12).map((ym, i) => mk(ym, 500, { vendor: 'Newcomer Co', vendorId: 5, txnId: `n${i}` })));
  const r2 = review.buildTrend({ A: B, flag: { ...flag, month: '2026-10', line: { key: 'payroll', label: 'Payroll' } }, today: TODAY });
  check('a payee that did not bill in the earlier year is named as new', r2.verdict === 'concentration' && /Newcomer Co/.test(r2.headline) && /did not appear/.test(r2.headline), r2.headline);
  const C = months.map((ym, i) => mk(ym, i < 12 ? 1000 : 1500, { vendor: 'Steady Co', vendorId: 4, txnId: `g${i}` }));
  const r3 = review.buildTrend({ A: C, flag: { ...flag, month: '2026-10', line: { key: 'payroll', label: 'Payroll' } }, today: TODAY });
  check('a payee up 50% is ordinary growth; one that more than doubles is a question', r3.verdict === 'real' && /50%/.test(r3.headline));
  const D = months.map((ym, i) => mk(ym, i < 12 ? 1000 : 2500, { vendor: 'Steady Co', vendorId: 4, txnId: `d${i}` }));
  check('…and more than doubled is not called ordinary', review.buildTrend({ A: D, flag: { ...flag, month: '2026-10', line: { key: 'payroll', label: 'Payroll' } }, today: TODAY }).verdict === 'concentration');
}

// ── 10. the pack read on 2026-11-03: no "nothing explains it" beside an explanation, no repeated headline ─
{
  const tiles = [1, 2, 3, 4].map(i => P({ vendor: 'Marga Tile INC', vendorId: 9, amount: 2425, txnId: `t${i}` }));   // several invoices: not "one big bill"
  const r = run(tiles, INV(9700, { findings: [{ kind: 'new-vendor', dollars: 9700, vendor: 'Marga Tile INC', headline: 'Marga Tile INC is new on this line: no postings in the 5 months before Sep 26', evidence: ['Sep 26: $9,700.'], next: 'Ask what the tile work was.' }] }), []);
  check('a new vendor with no bill looked up reads as a new vendor, not "the postings do not say why"', r.verdict === 'real' && r.verdictLabel === 'A new vendor on this line' && /^Low/.test(r.confidence), `${r.verdict} ${r.verdictLabel}`);
  const fee = run([], INV(-800, { totals: { cur: 0, prev: 800 }, findings: [{ kind: 'missing-bill', dollars: 800, vendor: 'Demo Management LLC', headline: 'Demo Management LLC posted in 5 of the 5 months before (about $797 a month) and has nothing in Sep 26', evidence: [] }] }), []);
  check('a regular charge that did not post → "A regular charge did not post"', fee.verdict === 'timing' && fee.verdictLabel === 'A regular charge did not post', fee.verdictLabel);
  const late = P({ vendor: 'Contractor', amount: 9000, date: '2026-09-06' });
  const b = run([late], INV(9000), [lk(late, { bill: { date: '2026-09-06', enteredOn: '2026-11-01' } })]);
  check('the bottom line does not repeat the headline', b.bottomLine.indexOf(b.headline) !== 0 && !b.bottomLine.includes(b.headline), b.bottomLine);
}

console.log(`\n${failed ? `${failed} of ${n} checks FAILED` : `All ${n} checks passed`}`);
process.exit(failed ? 1 : 0);
