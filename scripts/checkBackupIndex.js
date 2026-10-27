#!/usr/bin/env node
// The index that lets a click read the sweep's answer instead of searching again.
//
// It exists because the two disagreed: the sweep searched a vendor's whole ledger
// and found 54%, the per-charge lookup searched a fortnight either side of the
// posting and found less — and the tab is the half people can see. The risk in
// fixing it that way is the opposite failure: an index that hands back the WRONG
// bill, confidently and instantly, on every click.
//
//   node scripts/checkBackupIndex.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const coverage = require('../services/backupCoverage');
const renovations = require('../services/renovationExpenses');
const index = require('../services/backupIndex');

let fails = 0, checks = 0;
const check = (name, fn) => {
  checks++;
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { fails++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

function withSweep(data, at) {
  coverage.status = () => ({ cache: { refreshedAt: at || '2026-08-27T10:00:00.000Z', data } });
  index.__reset();
}

// Which charges carried an invoice number of their own. The statement test reads
// this across from the renovation snapshot, so a test that does not set it is
// testing the no-snapshot fallback rather than the rule.
function withCharges(charges, at) {
  renovations.status = () => ({ cache: { refreshedAt: at || '2026-08-27T10:00:00.000Z', data: { charges } } });
  index.__reset();
}
withCharges([]);

console.log('\nReading the sweep back');
withSweep({ resolved: ['c1|doc|500', 'c2|none|501', 'c3|card|', 'c4|doc|502'] });
check('a documented charge resolves to its bill', () => {
  assert.deepStrictEqual(index.lookup('c1'), { kind: 'doc', billId: '500' });
});
check('a charge whose bill has no scan still resolves — the bill is known', () => {
  assert.deepStrictEqual(index.lookup('c2'), { kind: 'none', billId: '501' });
});
check('a card charge resolves with no bill, because none exists', () => {
  assert.deepStrictEqual(index.lookup('c3'), { kind: 'card', billId: null });
});

console.log('\nAbsent means "not indexed", never "no document"');
check('a charge the sweep has not seen returns null, so the caller falls back to searching', () => {
  assert.strictEqual(index.lookup('never-swept'), null);
});
check('no sweep at all returns null rather than an empty index', () => {
  coverage.status = () => ({ cache: null });
  index.__reset();
  assert.strictEqual(index.lookup('c1'), null);
});

console.log('\nIt tracks the sweep it came from');
check('a re-run replaces the index without a restart', () => {
  withSweep({ resolved: ['c1|doc|500'] }, '2026-08-27T10:00:00.000Z');
  assert.strictEqual(index.lookup('c1').billId, '500');
  // Same process, new sweep, different answer.
  coverage.status = () => ({ cache: { refreshedAt: '2026-08-27T18:00:00.000Z', data: { resolved: ['c1|doc|999'] } } });
  assert.strictEqual(index.lookup('c1').billId, '999', 'a stale index would still say 500');
});
check('...and an unchanged sweep is not re-parsed into a different answer', () => {
  withSweep({ resolved: ['c1|doc|500'] }, '2026-08-27T10:00:00.000Z');
  const a = index.lookup('c1');
  const b = index.lookup('c1');
  assert.deepStrictEqual(a, b);
});

console.log('\nCharge ids are not simple strings');
check('an id containing the separator is not truncated into the wrong charge', () => {
  // Charge ids are base64 and can contain anything; splitting naively on "|"
  // would map this row onto a different charge and hand back its bill.
  withSweep({ resolved: ['MTEy|fDIwMjY|doc|777'] });
  assert.strictEqual(index.lookup('MTEy|fDIwMjY').billId, '777');
  assert.strictEqual(index.lookup('MTEy'), null, 'the prefix is a different charge');
});
check('a malformed row is skipped rather than poisoning the index', () => {
  withSweep({ resolved: ['garbage', 'c1|doc|500'] });
  assert.strictEqual(index.lookup('garbage'), null);
  assert.strictEqual(index.lookup('c1').billId, '500');
});

console.log('\nA statement is not an invoice');
// An audit of 448 matches found 110 resolving to four bills — all consolidated
// statements, median charge $0.50. Those matches are right; the document is not
// an invoice, and showing it as one is the click that looks broken.
check('a bill hundreds of charges lean on is called a statement', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(`big${i}|doc|999`);
  rows.push('a|doc|1', 'b|doc|1');
  withSweep({ resolved: rows });
  withCharges([]);
  assert.strictEqual(index.chargesOnBill('999'), 40);
  assert.strictEqual(index.isStatement('999', 'big0'), true);
});
check('...and an ordinary invoice backing a couple of charges is not', () => {
  assert.strictEqual(index.isStatement('1', 'a'), false, 'two charges is a split invoice, not a statement');
});
check('a bill at the threshold is not off by one', () => {
  const rows = [];
  for (let i = 0; i < index.STATEMENT_FANOUT; i++) rows.push(`c${i}|doc|7`);
  withSweep({ resolved: rows });
  withCharges([]);
  assert.strictEqual(index.isStatement('7', 'c0'), true);
});
check('a charge with no bill is never a statement', () => {
  withSweep({ resolved: ['c1|card|'] });
  withCharges([]);
  assert.strictEqual(index.isStatement(null, 'c1'), false);
  assert.strictEqual(index.isStatement('', 'c1'), false);
});

console.log('\nFan-out alone cannot tell a split invoice from a statement');
// The rule shipped on fan-out alone and labelled 13,214 of 15,280 documented
// charges a statement — against the 111 the audit actually found. One renovation
// invoice is routinely split across dozens of unit and account lines, so the bill
// behind a perfectly ordinary PDF backs 40 charges just as a card statement does.
// The charge's own invoice number is what separates them.
const SPLIT = [];
for (let i = 0; i < 40; i++) SPLIT.push(`split${i}|doc|900`);
for (let i = 0; i < 40; i++) SPLIT.push(`card${i}|doc|901`);
check('a charge matched by its own invoice number is never demoted, whatever the fan-out', () => {
  withSweep({ resolved: SPLIT });
  withCharges(SPLIT.filter(r => r.startsWith('split')).map((r, i) => ({ id: `split${i}`, invoiceNo: 'INV-8842' })));
  assert.strictEqual(index.chargesOnBill('900'), 40, 'the fan-out is real');
  assert.strictEqual(index.isStatement('900', 'split0'), false,
    'the document contains this charge\'s invoice number — it is one invoice, split');
});
check('...while a charge with no invoice number on the same-sized bill still is', () => {
  assert.strictEqual(index.isStatement('901', 'card0'), true);
});
check('an invoice number of whitespace does not count as one', () => {
  withSweep({ resolved: SPLIT });
  withCharges([{ id: 'split0', invoiceNo: '   ' }]);
  assert.strictEqual(index.isStatement('900', 'split0'), true);
});
check('a charge the snapshot has not seen falls back to fan-out rather than passing', () => {
  withSweep({ resolved: SPLIT });
  withCharges([{ id: 'somebody-else', invoiceNo: 'INV-1' }]);
  assert.strictEqual(index.isStatement('900', 'split0'), true,
    'unknown must not read as "has an invoice number"');
});
check('no renovation snapshot at all degrades to fan-out, it does not throw', () => {
  withSweep({ resolved: SPLIT });
  renovations.status = () => ({ cache: null });
  index.__reset();
  assert.strictEqual(index.isStatement('900', 'split0'), true);
  assert.strictEqual(index.invoiceLinked('split0'), false);
});
check('a re-run of the renovation snapshot changes the answer without a restart', () => {
  withSweep({ resolved: SPLIT });
  withCharges([], '2026-08-27T10:00:00.000Z');
  assert.strictEqual(index.isStatement('900', 'split0'), true);
  renovations.status = () => ({ cache: { refreshedAt: '2026-08-27T18:00:00.000Z',
    data: { charges: [{ id: 'split0', invoiceNo: 'INV-9' }] } } });
  assert.strictEqual(index.isStatement('900', 'split0'), false,
    'a stale invoice-number set would still demote it');
});

console.log('\nThe endpoint hands the charge id over');
// The rule needs both ids and the second one is optional in the signature, so a
// call site that drops it fails silently — every split invoice quietly becomes a
// statement again and the tab looks exactly as broken as before.
check('/api/renovations/backup-coverage?ids=1 passes the charge id, not just the bill', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const calls = server.match(/backupIndex\.isStatement\([^)]*\)/g) || [];
  assert.ok(calls.length, 'no isStatement call found in server.js at all');
  for (const call of calls) {
    assert.ok(/,/.test(call), `isStatement called with the bill id alone: ${call}`);
  }
});

console.log('\nStatus');
check('it reports how much it holds and which sweep it came from', () => {
  withSweep({ resolved: ['c1|doc|500', 'c2|none|501'] }, '2026-08-27T12:00:00.000Z');
  const st = index.status();
  assert.strictEqual(st.entries, 2);
  assert.strictEqual(st.sweptAt, '2026-08-27T12:00:00.000Z');
});

console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
