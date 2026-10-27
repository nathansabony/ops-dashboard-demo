#!/usr/bin/env node
// The "what we found in Rent Manager" analysis (services/varianceInvestigation.js),
// against canned Report 51 and /Bills payloads — no network, no Rent Manager.
//
// The owner, 2026-10-22: every variance report should go into Rent Manager and find
// the actual issue. The only thing worse than not finding it is naming a cause the
// postings do not show, so this check is mostly about restraint:
//   • each classification fires on a fixture built for it, and on nothing else;
//   • the change is attributed to the right postings, and the share explained adds up;
//   • when nothing explains a change, the answer is "could not determine";
//   • nothing in the output is invented — every dollar figure and every posting cited
//     traces back to the payload, and no sentence asserts a cause ("because", "due to");
//   • the Rent Manager budget holds (at most 4 Report 51 runs, 3 bill lookups) and an
//     answer is asked for once per (scope, line, month).
//
// Every figure here is made up to exercise a rule (repo policy: no real financials).
//
//   node scripts/checkVarianceInvestigation.js

const vi = require('../services/varianceInvestigation');

let failed = 0, n = 0;
function check(name, ok, detail) {
  n += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failed += 1; if (detail) console.log(`        ${detail}`); }
}

// ── a posting, as glTransactions.parsePostings hands it over ────────────────
let seq = 1;
const P = o => {
  const amount = o.amount;
  return {
    id: `p${seq}`, date: '2026-09-10', type: 'Bill', reference: '', description: '', servicePeriod: null,
    vendor: 'City Water Co', vendorId: 1, property: '101Main', account: '5402 Water & Sewer', accountId: 300,
    debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0, txnId: `t${seq++}`, txnType: 'BILLITM', invoiceNo: null,
    ...o,
  };
};
// Steady history: a vendor posting the same amount on the 5th of each named month.
const steady = (vendor, vendorId, amount, months, extra = {}) =>
  months.map(m => P({ date: `${m}-05`, vendor, vendorId, amount, description: `${vendor} monthly`, ...extra }));
const M = n => `2026-${String(n).padStart(2, '0')}`;
const APR_AUG = [4, 5, 6, 7, 8].map(M);
const base = () => steady('City Water Co', 1, 3000, [...APR_AUG, M(9)]);   // the line's steady cost, every month

const scope = { kind: 'property', label: '101 Main St', entity: 'Demo', ownShortNames: ['101Main'] };
const line = { key: 'waterSewer', label: 'Water & Sewer' };
const run = (win, extra = {}) => vi.analyze({ month: '2026-09', line, scope, window: win, lastYear: [], siblings: null, neighbours: null, ...extra });
const top = r => r.result.findings[0] || {};

// ── 1. one big bill ─────────────────────────────────────────────────────────
console.log('\nOne big bill');
{
  // A lumpy vendor on its usual size, landing this month; no other rule applies.
  const win = [...base(),
    P({ date: '2026-04-12', vendor: 'Roofing Co', vendorId: 7, amount: 4000, description: 'Roofing Co repair' }),
    P({ date: '2026-07-12', vendor: 'Roofing Co', vendorId: 7, amount: 4000, description: 'Roofing Co repair' }),
    P({ date: '2026-09-12', vendor: 'Roofing Co', vendorId: 7, amount: 4500, description: 'Roofing Co repair', reference: 'R-77' })];
  // City Water's own September is dropped so the month is the roofer's.
  const w = win.filter(p => !(p.vendorId === 1 && p.date.startsWith('2026-09')));
  const r = run(w);
  check('the largest mover is the roofer', top(r).vendor === 'Roofing Co', JSON.stringify(top(r).headline));
  check('classified as one big bill', top(r).kind === 'one-big-bill', top(r).kind);
  check('it cites the posting and its reference', top(r).postings.length === 1 && top(r).postings[0].reference === 'R-77');
  check('the change is the roofer\'s 4,500 against last month\'s 3,000 from the other vendor', r.result.target === 1500, String(r.result.target));
}

// ── 2. a new vendor ─────────────────────────────────────────────────────────
console.log('\nNew vendor');
{
  const win = [...base(), P({ date: '2026-09-14', vendor: 'Acme Plumbing', vendorId: 22, amount: 2500, description: 'Acme Plumbing: INV-1' })];
  const r = run(win);
  check('a vendor never seen on the line is called new', top(r).kind === 'new-vendor', top(r).kind);
  check('the evidence says what was searched', /Searched \d+ postings and 0 from last year/.test(top(r).evidence.join(' ')));
  check('the whole change is attributed to it', top(r).dollars === 2500 && r.result.explained.pct === 1);
  const r2 = run(win, { lastYear: null, lastYearNote: 'The same month last year could not be pulled (timeout).' });
  check('without last year it still says new, but only for the five months', top(r2).kind === 'new-vendor' && !/last year/.test(top(r2).headline));
  check('…and says last year was not looked at', r2.result.limits.some(l => /last year/i.test(l)));
}

// ── 3. a vendor billing more than usual ─────────────────────────────────────
console.log('\nVendor billing more than usual');
{
  const win = [...base(), ...steady('Boiler Co', 5, 1000, APR_AUG), P({ date: '2026-09-09', vendor: 'Boiler Co', vendorId: 5, amount: 2100 })];
  const r = run(win);
  check('fires on a vendor well above its own average', top(r).kind === 'vendor-more', top(r).kind);
  check('names the average and the months it was taken over', /about \$1,000 a month/.test(top(r).headline) && /Apr 26/.test(top(r).evidence[0]));
  check('dollars are the change vs last month (2,100 − 1,000)', top(r).dollars === 1100);
}

// ── 4. a catch-up ───────────────────────────────────────────────────────────
console.log('\nCatch-up of earlier months');
{
  const long = P({ date: '2026-09-09', vendor: 'Gas Co', vendorId: 9, amount: 9000, description: 'Gas Co : 555 - 06/30/26 - 09/28/26' });
  const r = run([...base(), ...steady('Gas Co', 9, 1000, APR_AUG, { description: 'Gas Co : 555 - 05/30/26 - 06/29/26' }), long]);
  check('a posting whose service period spans three months is a catch-up', top(r).kind === 'catch-up' && top(r).confidence === 'high', top(r).kind);
  check('it quotes the period it covers', /06\/30\/26 - 09\/28\/26/.test(top(r).evidence.join(' ')));

  const arrears = P({ date: '2026-09-09', vendor: 'Sewer Authority', vendorId: 10, amount: 1800, description: 'Sewer Authority : 77 - 05/01/26 - 05/31/26' });
  const r2 = run([...base(), arrears]);
  check('a posting for a period that ended before last month is a catch-up', top(r2).kind === 'catch-up', top(r2).kind);

  const skipped = [...base(), ...steady('Trash Co', 11, 1000, [4, 5, 6, 7].map(M)), P({ date: '2026-09-06', vendor: 'Trash Co', vendorId: 11, amount: 2000 })];
  const r3 = run(skipped);
  check('a skipped month billed together reads as a catch-up, at medium confidence', top(r3).kind === 'catch-up' && top(r3).confidence === 'medium', top(r3).kind);
  check('…and is worded as consistent with, not as a fact', /consistent with/.test(top(r3).evidence.join(' ')));

  // A vendor whose bills ALWAYS cover a quarter is on its cycle, not catching up.
  const q = [...base(), P({ date: '2026-06-09', vendor: 'Quarterly Water', vendorId: 12, amount: 3000, description: 'Quarterly Water : 9 - 03/01/26 - 05/31/26' }),
    P({ date: '2026-09-09', vendor: 'Quarterly Water', vendorId: 12, amount: 3000, description: 'Quarterly Water : 9 - 06/01/26 - 08/31/26' })];
  const r4 = run(q);
  check('a vendor that always bills a quarter is a cycle, not a catch-up', top(r4).kind === 'cycle', top(r4).kind);
}

// ── 5. a quarterly or annual bill ───────────────────────────────────────────
console.log('\nQuarterly or annual bill');
{
  const win = [...base(), P({ date: '2026-06-20', vendor: 'Insurer', vendorId: 13, amount: 3000 }), P({ date: '2026-09-20', vendor: 'Insurer', vendorId: 13, amount: 3300 })];
  const r = run(win);
  check('posted now and three months ago with nothing between is quarterly', top(r).kind === 'cycle', top(r).kind);
  check('…worded as consistent with, with the earlier amount and the size change', /consistent with a quarterly/.test(top(r).headline) && /10% more/.test(top(r).evidence.join(' ')));

  const ann = [...base(), P({ date: '2026-09-18', vendor: 'City Hall', vendorId: 14, amount: 2000 })];
  const ly = [P({ date: '2025-09-16', vendor: 'City Hall', vendorId: 14, amount: 1900 })];
  const r2 = run(ann, { lastYear: ly });
  check('posted now and a year ago with nothing between is annual', top(r2).kind === 'cycle' && /annual/.test(top(r2).headline), top(r2).kind);
  check('…and a year earlier it would have been called new', run(ann).result.findings[0].kind === 'new-vendor');
}

// ── 6. a duplicate payment ──────────────────────────────────────────────────
console.log('\nDuplicate payment');
{
  const bill = P({ date: '2026-05-07', vendor: 'PSE&G', vendorId: 1516, amount: 1000, txnType: 'BILLITM', txnId: 'B1', reference: 'AV1', description: 'PSE&G : 7379602209 -04/01/26 - 05/01/26' });
  const chk = P({ date: '2026-09-09', vendor: 'PSE&G', vendorId: 1516, amount: 1000, txnType: 'CHKITM', txnId: 'C1', reference: 'ACH', description: 'PSE&G : 7379602209 -04/01/26 - 05/01/26' });
  const credit = P({ date: '2026-09-14', vendor: 'PSE&G', vendorId: 1516, amount: -300, txnType: 'CREDIT', txnId: 'CR1', account: '5404 Electric', accountId: 219, description: 'PSE&G' });
  const r = run([...base(), bill, chk]);
  check('a check keyed to expense that repeats an entered bill is a duplicate', top(r).kind === 'duplicate' && top(r).confidence === 'high', top(r).kind);
  check('it names the check, the bill and the amount counted twice', /Check ACH/.test(top(r).evidence[0]) && /AV1/.test(top(r).evidence[0]) && /\$1,000 counted twice/.test(top(r).evidence[0]));
  check('the check line is what is cited', top(r).postings[0].txnType === 'CHKITM');
  const r2 = run([...base(), bill, chk, credit]);
  check('a credit posted against it rides along, and a different account is said', /credit of -\$300/.test(top(r2).evidence.join(' ')) && /nets out but the accounts do not/.test(top(r2).evidence.join(' ')));
  const chkOnly = run([...base(), chk]);
  check('a check with no bill behind it is not called a duplicate', top(chkOnly).kind !== 'duplicate');
}

// ── 7. a credit or reversal ─────────────────────────────────────────────────
console.log('\nCredit or reversal');
{
  const charge = P({ date: '2026-08-12', vendor: 'Boiler Co', vendorId: 5, amount: 1500, reference: 'B-9' });
  const rev = P({ date: '2026-09-12', vendor: 'Boiler Co', vendorId: 5, amount: -1500, txnType: 'CRDITM', reference: 'B-9 cr' });
  const win = [...steady('City Water Co', 1, 3000, [...APR_AUG, M(9)]), charge, rev];
  const r = run(win);
  check('a credit that cancels last month\'s charge is a reversal', top(r).kind === 'credit', top(r).kind);
  check('…and says which charge it reverses', /reverses the Aug 12 charge of \$1,500/.test(top(r).evidence[0]));
  check('the decrease (3,000 → 1,500 + 0, i.e. the charge gone AND the credit) is attributed to it in full', r.result.target === -3000 && top(r).dollars === 3000, `${r.result.target} / ${top(r).dollars}`);

  const stray = run([...base(), P({ date: '2026-09-12', vendor: 'Boiler Co', vendorId: 5, amount: -700, txnType: 'CRDITM' })]);
  check('a credit with no matching charge says exactly that, not "refund"', top(stray).kind === 'credit' && /no charge of that size/.test(top(stray).evidence[0]) && !/refund/i.test(JSON.stringify(stray.result)));

  // The other way round: last month was lowered by a credit, so this month looks like a jump.
  const lowered = [...base(), ...steady('Elevator Co', 15, 1500, [4, 5, 6, 7].map(M)),
    P({ date: '2026-08-05', vendor: 'Elevator Co', vendorId: 15, amount: 1500 }),
    P({ date: '2026-08-20', vendor: 'Elevator Co', vendorId: 15, amount: -1500, txnType: 'CRDITM' }),
    P({ date: '2026-09-05', vendor: 'Elevator Co', vendorId: 15, amount: 1500 })];
  const r2 = run(lowered);
  check('a rise that is last month\'s credit dropping out is read that way', top(r2).kind === 'credit' && /lowered by a credit of \$1,500/.test(top(r2).headline), top(r2).headline);

  // A month that nets negative.
  const neg = run([...steady('City Water Co', 1, 3000, APR_AUG), P({ date: '2026-09-02', vendor: 'City Water Co', vendorId: 1, amount: -2000, txnType: 'CRDITM' })]);
  check('a month that nets negative is investigated as credits', neg.result.mode === 'credit' && top(neg).kind === 'credit');
}

// ── 8. the wrong building or the wrong account ─────────────────────────────
console.log('\nWrong building or account');
{
  const mine = P({ date: '2026-09-14', vendor: 'Acme Plumbing', vendorId: 22, amount: 2000, invoiceNo: 'INV-9', description: 'Acme Plumbing: INV-9' });
  const sib = P({ date: '2026-09-14', vendor: 'Acme Plumbing', vendorId: 22, amount: 2000, invoiceNo: 'INV-9', property: '102Elm', description: 'Acme Plumbing: INV-9' });
  const r = run([...base(), mine], { siblings: [sib] });
  check('the same invoice number at a sibling building is wrong-place, high', top(r).kind === 'wrong-place' && top(r).confidence === 'high', top(r).kind);
  check('…and names the sibling', /102Elm/.test(top(r).evidence[0]));
  const sameAmt = P({ ...sib, invoiceNo: null, id: 'x', txnId: 'tx' });
  const r1 = run([...base(), P({ ...mine, invoiceNo: null })], { siblings: [sameAmt] });
  check('the same vendor and amount at a sibling is wrong-place at medium', top(r1).kind === 'wrong-place' && top(r1).confidence === 'medium', top(r1).kind);
  const own = P({ ...sib, property: '101Main' });
  const r1b = run([...base(), mine], { siblings: [own] });
  check('this building\'s own postings are never read as a sibling', top(r1b).kind !== 'wrong-place');

  // Found on the real pull 2026-10-22: these two read as the top cause on 7 of the top 20 flags.
  // A flat fee that also posts at a sibling ($543 of an $8,886 jump) is not why the line moved, and
  // one invoice number carrying different amounts is one invoice allocated over lines.
  const bigBill = P({ date: '2026-09-20', vendor: 'Acme Plumbing', vendorId: 22, amount: 9000, description: 'Acme Plumbing: big job' });
  const fee = P({ date: '2026-09-14', vendor: 'Acme Plumbing', vendorId: 22, amount: 543, description: 'Acme Plumbing: compliance fee' });
  const feeAtSibling = P({ ...fee, property: '102Elm', id: 'f2', txnId: 'f2t' });
  const rFee = run([...base(), bigBill, fee], { siblings: [feeAtSibling] });
  check('a small same-amount fee at a sibling is not read as the reason a big move happened', top(rFee).kind !== 'wrong-place', top(rFee).kind);
  const lineA = P({ date: '2026-09-14', vendor: 'Acme Plumbing', vendorId: 22, amount: 2000, invoiceNo: 'INV-7', description: 'Acme Plumbing: INV-7' });
  const lineB = P({ date: '2026-09-14', vendor: 'Acme Plumbing', vendorId: 22, amount: 549, invoiceNo: 'INV-7', property: '102Elm', id: 'l2', txnId: 'l2t', description: 'Acme Plumbing: INV-7' });
  const rInv = run([...base(), lineA], { siblings: [lineB] });
  check('one invoice number with different amounts at a sibling is an allocation, not a mis-posting', top(rInv).kind !== 'wrong-place', top(rInv).kind);

  // Shifted: the sibling carried the vendor last month, this building carries it now.
  const e1 = P({ date: '2026-09-04', vendor: 'Heat Co', vendorId: 31, amount: 1800 });
  const e0 = P({ date: '2026-08-04', vendor: 'Heat Co', vendorId: 31, amount: 1800, property: '102Elm' });
  const r2 = run([...base(), e1], { siblings: [e0] });
  check('a bill that moved from a sibling building is spotted', top(r2).kind === 'wrong-place' && /billed 102Elm/.test(top(r2).evidence[0]), top(r2).kind);

  // Another account at this building.
  const nbTwin = P({ date: '2026-09-14', vendor: 'Acme Plumbing', vendorId: 22, amount: 2000, invoiceNo: 'INV-9', account: '5404 Electric', accountId: 219, description: 'Acme Plumbing: INV-9' });
  const r3 = run([...base(), mine], { neighbours: [nbTwin] });
  check('the same invoice on a neighbouring account is wrong-place, high', top(r3).kind === 'wrong-place' && /5404 Electric/.test(top(r3).evidence[0]), top(r3).kind);
  const usual = [4, 5, 6].map(m => P({ date: `2026-0${m}-05`, vendor: 'Gas Supply', vendorId: 33, amount: 900, account: '5401 Heating Gas', accountId: 125 }));
  const r4 = run([...base(), P({ date: '2026-09-05', vendor: 'Gas Supply', vendorId: 33, amount: 900 })], { neighbours: usual });
  check('a vendor that always posts to another account and now posts here is flagged', top(r4).kind === 'wrong-place' && /5401 Heating Gas/.test(top(r4).evidence[0]), top(r4).kind);
  check('none of this is claimed when the other buildings were not pulled', run([...base(), mine], { siblings: null, siblingsNote: 'Sibling buildings could not be pulled (timeout).' }).result.limits.some(l => /Sibling buildings/.test(l)));
}

// ── 9. a regular bill that did not post ────────────────────────────────────
console.log('\nBlank month and drops');
{
  const hist = [...steady('City Water Co', 1, 3000, APR_AUG)];
  const r = run(hist);
  check('a month with no postings is investigated as blank', r.result.mode === 'blank');
  check('the regular vendor that stopped is named, with its months', top(r).kind === 'missing-bill' && /5 of the 5 months before/.test(top(r).headline), top(r).headline);
  check('the blank month\'s target is the usual month', r.result.target === -3000 && r.result.explained.pct === 1);
  const elsewhere = run(hist, { neighbours: [P({ date: '2026-09-08', vendor: 'City Water Co', vendorId: 1, amount: 3000, account: '5404 Electric', accountId: 219 })] });
  check('…unless the same vendor posted this month to a neighbouring account', top(elsewhere).kind === 'wrong-place' && /5404 Electric/.test(top(elsewhere).headline), top(elsewhere).kind);
  const oneOff = run([...hist, P({ date: '2026-08-15', vendor: 'Locksmith', vendorId: 40, amount: 900 })]);
  check('a one-off last month that did not repeat is said to be one', oneOff.result.findings.some(f => f.kind === 'one-off-gone' && f.vendor === 'Locksmith'));

  const gone = run([...base().filter(p => !p.date.startsWith('2026-09')), P({ date: '2026-08-15', vendor: 'Locksmith', vendorId: 40, amount: 900 }), P({ date: '2026-09-05', vendor: 'Other Co', vendorId: 41, amount: 100 })]);
  check('a drop explained by a vendor that did not repeat is a one-off', gone.result.findings.some(f => f.kind === 'one-off-gone'), JSON.stringify(gone.result.findings.map(f => f.kind)));
  const less = run([...base().filter(p => p.vendorId !== 1 || !p.date.startsWith('2026-09')), ...steady('Boiler Co', 5, 2000, [...APR_AUG]), P({ date: '2026-09-05', vendor: 'Boiler Co', vendorId: 5, amount: 800 }), P({ date: '2026-09-05', vendor: 'City Water Co', vendorId: 1, amount: 3000 })]);
  check('a vendor billing well under its average is reported as lower', less.result.findings.some(f => f.kind === 'vendor-less' && f.vendor === 'Boiler Co'));
}

// ── 10. "could not determine" ──────────────────────────────────────────────
console.log('\nCould not determine');
{
  const win = [...steady('City Water Co', 1, 3000, [...APR_AUG, M(9)]), ...steady('Misc Supplies', 50, 1000, APR_AUG), P({ date: '2026-09-05', vendor: 'Misc Supplies', vendorId: 50, amount: 1200 })];
  const r = run(win);
  check('a small drift in a regular vendor is not given a cause', r.result.couldNotDetermine === true && r.result.likely === null, JSON.stringify(r.result.likely));
  check('the summary says so in as many words', /Could not determine the cause/.test(r.result.summary));
  check('the finding is "other" and says nothing in the postings explains it', top(r).kind === 'other' && /nothing in the postings says why/.test(top(r).headline));
  check('the next step is to read the invoice, not a guess', /read the invoices/.test(r.result.next));
  check('the summary names no cause', !/(because|due to|caused|probably)/i.test(r.result.summary));

  const flat = run([...steady('City Water Co', 1, 3000, [...APR_AUG, M(9)])]);
  check('a month the same as last month has no change to explain', flat.result.mode === 'no-change' && flat.result.couldNotDetermine === false && /no change in the postings/.test(flat.result.summary));
  check('…and still carries its postings, so the report lists them without a second pull', flat.result.postings.cur.length === 1 && flat.result.postings.month === '2026-09');

  // Several small movers, none big enough to name.
  const smalls = [...base().filter(p => !p.date.startsWith('2026-09'))];
  for (let v = 0; v < 8; v++) { smalls.push(...steady(`Vendor ${v}`, 100 + v, 100, APR_AUG)); smalls.push(P({ date: '2026-09-05', vendor: `Vendor ${v}`, vendorId: 100 + v, amount: 115 })); }
  smalls.push(P({ date: '2026-09-05', vendor: 'City Water Co', vendorId: 1, amount: 3000 }));
  const rs = run(smalls);
  check('a rise spread across many small vendors is not attributed to one', rs.result.couldNotDetermine === true);

  // The first finding is classified but covers little of the change.
  const partial = [...base().filter(p => !p.date.startsWith('2026-09')), P({ date: '2026-09-05', vendor: 'City Water Co', vendorId: 1, amount: 3000 }),
    ...steady('Boiler Co', 5, 1000, APR_AUG), P({ date: '2026-09-09', vendor: 'Boiler Co', vendorId: 5, amount: 1400 }),
    ...steady('Misc Supplies', 50, 1000, APR_AUG), P({ date: '2026-09-05', vendor: 'Misc Supplies', vendorId: 50, amount: 1900 })].map(p => p);
  const rp = run(partial);
  check('a finding that covers under half of the change is not offered as the cause', rp.result.likely === null || rp.result.explained.pct >= 0.5, JSON.stringify(rp.result.likely && rp.result.likely.headline));
}

// ── 11. the delta is explained correctly ───────────────────────────────────
console.log('\nThe change, attributed');
{
  const win = [...base(), P({ date: '2026-09-14', vendor: 'Acme Plumbing', vendorId: 22, amount: 4000 }), P({ date: '2026-09-15', vendor: 'Pipe Works', vendorId: 23, amount: 1000 }),
    P({ date: '2026-08-15', vendor: 'Fix-It', vendorId: 24, amount: 300 })];
  const r = run(win);
  const t = r.result;
  check('the totals are the sums of the postings', t.totals.cur === 8000 && t.totals.prev === 3300 && t.totals.vsPrev === 4700, JSON.stringify(t.totals));
  check('the findings are ranked by dollars', t.findings.map(f => f.vendor).join() === 'Acme Plumbing,Pipe Works', t.findings.map(f => f.vendor).join());
  check('each finding\'s share is its dollars over the change (85% + 21%), and the explained share is capped at 100%',
    Math.abs(t.findings.reduce((s, f) => s + f.pctOfChange, 0) - 5000 / 4700) < 0.02 && t.explained.pct === 1, `${t.explained.pct}`);
  check('the explained amount is 5,000 of 4,700 — capped at the change', t.explained.amount === 4700 && t.offset === 300, JSON.stringify(t.explained) + ' offset ' + t.offset);
  const ly = [P({ date: '2025-09-12', vendor: 'City Water Co', vendorId: 1, amount: 2800 })];
  const r2 = run(win, { lastYear: ly });
  check('last year is read vendor by vendor', r2.result.totals.lastYear === 2800 && r2.result.lastYearReading.movers[0].vendor === 'Acme Plumbing', JSON.stringify(r2.result.lastYearReading));
  check('postings travel with the answer, biggest first', t.postings.cur[0].amount === 4000 && t.postings.cur.length === 3);
}

// ── 12. nothing invented ───────────────────────────────────────────────────
console.log('\nNothing invented');
{
  seq = 5000;
  // Each fixture is the window handed in; the answer is made from it and from nothing else.
  const fixtures = [
    [...base(), P({ date: '2026-09-14', vendor: 'Acme Plumbing', vendorId: 22, amount: 2500, description: 'Acme Plumbing: INV-1' })],
    [...base(), ...steady('Boiler Co', 5, 1000, APR_AUG), P({ date: '2026-09-09', vendor: 'Boiler Co', vendorId: 5, amount: 2100 })],
    [...base(), P({ date: '2026-09-09', vendor: 'Gas Co', vendorId: 9, amount: 9000, description: 'Gas Co : 555 - 06/30/26 - 09/28/26' })],
    steady('City Water Co', 1, 3000, APR_AUG),
    [...base(), P({ date: '2026-06-20', vendor: 'Insurer', vendorId: 13, amount: 3000 }), P({ date: '2026-09-20', vendor: 'Insurer', vendorId: 13, amount: 3300 })],
    [...steady('City Water Co', 1, 3000, [...APR_AUG, M(9)]), P({ date: '2026-08-12', vendor: 'Boiler Co', vendorId: 5, amount: 1500 }), P({ date: '2026-09-12', vendor: 'Boiler Co', vendorId: 5, amount: -1500, txnType: 'CRDITM' })],
    [...steady('City Water Co', 1, 3000, [...APR_AUG, M(9)]), ...steady('Misc Supplies', 50, 1000, APR_AUG), P({ date: '2026-09-05', vendor: 'Misc Supplies', vendorId: 50, amount: 1200 })],
  ];
  const cause = /\b(because|due to|caused by|probably|presumably|someone|forgot|mistake)\b/i;
  let strings = 0;
  const bad = [];
  for (const win of fixtures) {
    const r = run(win);
    // The figures a sentence may quote: a posting, what one vendor posted in one month, a month's
    // total, a vendor's average over the months it posted in, or the difference between two of those.
    const known = new Set();
    const add = v => known.add(Math.round(Math.abs(v)));
    win.forEach(p => add(p.amount));
    const vm = new Map(), mt = new Map();
    win.forEach(p => {
      const m = p.date.slice(0, 7), k = `${p.vendorId}|${m}`;
      vm.set(k, (vm.get(k) || 0) + p.amount);
      mt.set(m, (mt.get(m) || 0) + p.amount);
    });
    [...vm.values(), ...mt.values()].forEach(add);
    const perVendor = new Map();
    for (const [k, v] of vm) { const id = k.split('|')[0]; if (!perVendor.has(id)) perVendor.set(id, []); perVendor.get(id).push(v); }
    for (const list of perVendor.values()) add(list.reduce((a, b) => a + b, 0) / list.length);
    const first = [...known];
    first.forEach(a => first.forEach(b => add(a - b)));
    const texts = [r.result.summary, r.result.next, ...r.result.findings.flatMap(f => [f.headline, ...f.evidence, f.next])];
    for (const t of texts) {
      strings += 1;
      if (cause.test(t.replace(/^.*Most likely:/, ''))) bad.push(`asserts a cause: ${t}`);
      const dollars = /\$([\d,]+)/g;
      let m;
      while ((m = dollars.exec(t))) {
        const v = Number(m[1].replace(/,/g, ''));
        if (!known.has(v)) bad.push(`$${v} is not in the postings: ${t}`);
      }
    }
    // every posting the answer cites is one of the postings it was given
    const ids = new Set(win.map(p => p.id));
    for (const f of r.result.findings) for (const p of f.postings) if (!ids.has(p.id)) bad.push(`cites a posting that was not in the window: ${p.id}`);
  }
  const figures = bad.filter(b => /is not in the postings/.test(b));
  check(`${strings} sentences across ${fixtures.length} answers: every dollar figure traces to the postings`, figures.length === 0, figures.slice(0, 3).join('\n        '));
  check('…none asserts a cause the postings cannot show', !bad.some(b => /asserts a cause/.test(b)), bad.filter(b => /asserts a cause/.test(b)).slice(0, 2).join('\n        '));
  check('…and every posting cited is one that was given', !bad.some(b => /cites a posting/.test(b)));
}

// ── 13. the bills ──────────────────────────────────────────────────────────
console.log('\nBill status');
{
  const p = P({ date: '2026-09-14', vendor: 'Acme Plumbing', vendorId: 22, amount: 2500, txnType: 'BILLITM' });
  const backup = (o = {}) => ({ bill: { id: 700, number: 'A-1', approval: { approved: true }, ...(o.bill || {}) }, attachments: [{ id: 1 }], payment: { method: 'Check' }, unavailable: [], ...o, bill: { id: 700, number: 'A-1', approval: { approved: true }, ...(o.bill || {}) } });
  const none = vi.billFindings([{ posting: p, backup: backup() }]);
  check('a bill with its invoice, approval and payment raises nothing', none.items.length === 0 && none.limits.length === 0);
  const f1 = vi.billFindings([{ posting: p, backup: backup({ attachments: [] }) }]);
  check('a bill with no invoice attached', f1.items.length === 1 && f1.items[0].kind === 'no-invoice' && /A-1/.test(f1.items[0].headline));
  const f2 = vi.billFindings([{ posting: p, backup: backup({ bill: { approval: { approved: false } } }) }]);
  check('a bill that is not approved', f2.items.some(i => i.kind === 'unapproved'));
  const f3 = vi.billFindings([{ posting: p, backup: backup({ payment: null }) }]);
  check('a bill nothing has paid', f3.items.some(i => i.kind === 'unpaid'));
  const f3b = vi.billFindings([{ posting: p, backup: backup({ payment: null, unavailable: ['The bill-to-payment link could not be reached on this refresh'] }) }]);
  check('…but not when Rent Manager could not say whether it was paid', !f3b.items.some(i => i.kind === 'unpaid'));
  const f4 = vi.billFindings([{ posting: p, backup: { bill: null, payment: null, attachments: [], unavailable: ['No AP bill matched this posting'] } }]);
  check('a posting with no bill behind it', f4.items.length === 1 && f4.items[0].kind === 'no-bill');
  const f5 = vi.billFindings([{ posting: p, backup: { bill: null, payment: { direct: true }, attachments: [], unavailable: [] } }]);
  check('a posting paid straight to the payee is not a problem', f5.items.length === 0);
  const f6 = vi.billFindings([{ posting: p, error: 'The bill lookup took longer than 25 seconds' }]);
  check('a lookup that failed is a limit, never a finding', f6.items.length === 0 && /did not finish: The bill lookup took longer/.test(f6.limits[0]));
}

// ── 14. the Rent Manager budget and the cache ──────────────────────────────
(async () => {
  console.log('\nOrchestration');
  const calls = { gl: [], bills: 0, resolve: 0 };
  const mk = (over = {}) => ({
    now: () => new Date('2026-10-22T12:00:00Z'),
    snapshotStamp: () => 'snap-1',
    refsFor: k => ({ waterSewer: ['5402', '5402-1'], electric: ['5404'], heatingGas: ['5401'], insurance: ['5050'] }[k] || null),
    lineLabel: k => ({ waterSewer: 'Water & Sewer' }[k] || k),
    resolveScope: async s => { calls.resolve += 1; return s.startsWith('prop:') ? { ...scope, propOwnerIds: '101', siblingOwnerIds: [102, 103] } : { kind: 'entity', label: s, entity: s, propOwnerIds: '101,102', ownShortNames: [], siblingOwnerIds: [] }; },
    getGLDetail: async a => {
      calls.gl.push(a);
      if (over.failOn && over.failOn(a)) throw new Error('Rent Manager: boom');
      return { postings: [...base(), P({ date: '2026-09-14', vendor: 'Acme Plumbing', vendorId: 22, amount: 4000, txnType: 'BILLITM' })].filter(p => (a.startDate <= p.date && p.date <= a.endDate)) };
    },
    billBackup: async p => { calls.bills += 1; if (over.billFail) throw new Error('Rent Manager is slow'); return { bill: { id: 9, number: 'Z-1', approval: { approved: false } }, attachments: [], payment: null, unavailable: [] }; },
  });

  vi.__resetCache();
  const out = await vi.investigate({ scope: 'prop:101', key: 'waterSewer', month: '2026-09' }, mk());
  check('a property answer costs at most four General Ledger runs', calls.gl.length >= 1 && calls.gl.length <= 4, `${calls.gl.length}`);
  check('the main run is the six months ending in the flagged month', calls.gl[0].startDate === '2026-04-01' && calls.gl[0].endDate === '2026-09-30');
  check('the child accounts of the line travel with it', calls.gl[0].refs.join() === '5402,5402-1');
  check('last year is read around the same month, ±1', calls.gl.some(a => a.startDate === '2025-08-01' && a.endDate === '2025-10-31'));
  check('siblings are the entity\'s other buildings, last month and this', calls.gl.some(a => a.propOwnerIds === '102,103' && a.startDate === '2026-08-01'));
  check('neighbouring lines are asked for by their own accounts', calls.gl.some(a => a.refs.join() === '5401,5404'));
  check('at most three bill lookups, one per bill, biggest first', calls.bills >= 1 && calls.bills <= 3, `${calls.bills}`);
  check('the answer carries its label, time and report ids', out.label === 'Demo Portfolio analysis of Rent Manager data' && out.generatedAt === '2026-10-22T12:00:00.000Z' && out.reports.some(r => r.id === 51));
  check('unapproved, unpaid and unattached bills come back apart from the cause', out.housekeeping.map(h => h.kind).sort().join() === 'no-invoice,unapproved,unpaid', out.housekeeping.map(h => h.kind).join());
  const before = calls.gl.length, bBefore = calls.bills;
  const again = await vi.investigate({ scope: 'prop:101', key: 'waterSewer', month: '2026-09' }, mk());
  check('asking again costs Rent Manager nothing', calls.gl.length === before && calls.bills === bBefore && again.fromCache === true);
  const next = await vi.investigate({ scope: 'prop:101', key: 'waterSewer', month: '2026-09' }, { ...mk(), snapshotStamp: () => 'snap-2' });
  check('a refreshed P&L snapshot asks again', calls.gl.length > before && !next.fromCache);

  const par = mk(); vi.__resetCache(); calls.gl.length = 0;
  await Promise.all([1, 2, 3].map(() => vi.investigate({ scope: 'prop:101', key: 'waterSewer', month: '2026-09' }, par)));
  check('three requests at once share one set of runs', calls.gl.length <= 4, `${calls.gl.length}`);

  vi.__resetCache(); calls.gl.length = 0;
  const ent = await vi.investigate({ scope: 'Demo', key: 'waterSewer', month: '2026-09' }, mk());
  check('an entity answer reads no siblings and no neighbours', calls.gl.length === 2 && ent.limits.some(l => /already includes every building/.test(l)), `${calls.gl.length}`);

  vi.__resetCache();
  const part = await vi.investigate({ scope: 'prop:101', key: 'waterSewer', month: '2026-09' }, mk({ failOn: a => a.propOwnerIds === '102,103' }));
  check('a failed optional run narrows the answer and says so', part.ok && part.limits.some(l => /Sibling buildings could not be pulled \(boom\)/.test(l)));
  vi.__resetCache();
  let threw = null;
  try { await vi.investigate({ scope: 'prop:101', key: 'waterSewer', month: '2026-09' }, mk({ failOn: a => a.startDate === '2026-04-01' })); } catch (e) { threw = e; }
  check('a failed main run is an error (the report prints "not available")', !!threw && /boom/.test(threw.message));
  const again2 = await vi.investigate({ scope: 'prop:101', key: 'waterSewer', month: '2026-09' }, mk());
  check('…and a failure is not remembered', again2.ok === true);

  vi.__resetCache();
  const bf = await vi.investigate({ scope: 'prop:101', key: 'waterSewer', month: '2026-09' }, mk({ billFail: true }));
  check('a bill lookup that fails leaves the answer intact, with a limit', bf.ok && bf.findings.length > 0 && bf.limits.some(l => /did not finish: Rent Manager is slow/.test(l)));

  vi.__resetCache();
  const unmapped = await vi.investigate({ scope: 'prop:101', key: 'totalIncome', month: '2026-09' }, mk());
  check('a line with no GL accounts says so rather than guessing', unmapped.supported === false && /no GL accounts/.test(unmapped.reason));
  let bad = null;
  try { await vi.investigate({ scope: 'prop:101', key: 'waterSewer', month: 'Sep 26' }, mk()); } catch (e) { bad = e; }
  check('a bad month is refused before Rent Manager is touched', bad && bad.code === 'BAD_REQUEST');

  console.log(`\n${failed ? `${failed} of ${n} checks FAILED` : `All ${n} checks passed`}`);
  process.exit(failed ? 1 : 0);
})();
