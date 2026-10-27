#!/usr/bin/env node
// The four chips at the top of a backup panel.
//
// They exist because nobody reads a column of label/value rows in a meeting —
// they look for four things: is there an invoice, was it approved, who paid it,
// did it clear. The chips answer those before the detail that proves them.
//
// The whole risk is a chip that says something the rows below contradict. A green
// "Approved" on a bill nobody approved, or a bank name on a payment that has
// none, is worse than no chip at all — it is a confident wrong statement on a
// document somebody hands an owner. So every branch is pinned here.
//
//   node scripts/checkVerdictStrip.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function lift(name) {
  const at = html.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`checkVerdictStrip: ${name}() not found in index.html`);
  let i = html.indexOf('{', at), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
  }
  throw new Error(`checkVerdictStrip: ${name}() has no closing brace`);
}

const sandbox = {
  console,
  esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  money: n => `$${Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-US')}`,
};
vm.createContext(sandbox);
vm.runInContext(lift('renoVerdictStrip'), sandbox);
const strip = sandbox.renoVerdictStrip;

let fails = 0, checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
};
const has = (s, t) => s.includes(t);

const FULL = {
  attachments: [{ id: 'a1', name: 'inv.pdf' }],
  bill: { amount: 11000, approval: { approved: true, by: 'Dana Okoye', on: '2026-07-02' },
          allocated: { amount: 11000, inFull: true } },
  payment: { reconciled: true, bank: { known: true, label: '1037 Willow CreekFC Group 1 LLC' } },
};

console.log('\nThe four questions, answered in order');
{
  const s = strip(FULL);
  check('invoice, approval, bank and clearance all appear',
    has(s, 'Invoice attached') && has(s, 'Approved') && has(s, 'Willow CreekFC Group 1') && has(s, 'Cleared the bank'), s);
  check('...in that order, because that is the order they are asked in',
    s.indexOf('Invoice attached') < s.indexOf('Approved')
    && s.indexOf('Approved') < s.indexOf('Willow CreekFC Group 1')
    && s.indexOf('Willow CreekFC Group 1') < s.indexOf('Cleared the bank'));
  check('the approver is named, not just the fact', has(s, 'Dana Okoye'), s);
  check('a fully settled bill says so', has(s, 'Paid in full'));
}

console.log('\nNo chip can claim something the panel does not hold');
{
  const noAppr = strip({ ...FULL, bill: { ...FULL.bill, approval: { approved: false } } });
  check('an unapproved bill is never shown as approved',
    has(noAppr, 'Not approved') && !/✓ Approved/.test(noAppr), noAppr);

  const noBillAppr = strip({ ...FULL, bill: { amount: 10, allocated: null } });
  check('a bill with no approval field gets no approval chip at all',
    !/Approved/.test(noBillAppr), noBillAppr);

  const noBank = strip({ ...FULL, payment: { reconciled: true, bank: { known: false, label: 'BankID 3 — not named' } } });
  check('an unnamed account is flagged, never invented',
    has(noBank, 'Account not named') && !has(noBank, 'Willow CreekFC'), noBank);

  const unrec = strip({ ...FULL, payment: { reconciled: false, bank: { known: true, label: 'X' } } });
  check('an uncleared payment is never shown as cleared',
    has(unrec, 'Not yet reconciled') && !has(unrec, 'Cleared the bank'), unrec);

  const part = strip({ ...FULL, bill: { ...FULL.bill, allocated: { amount: 500, inFull: false } } });
  check('a partly settled bill shows the shortfall rather than "in full"',
    !has(part, 'Paid in full') && has(part, '$500'), part);
}

console.log('\nThe cases that are not failures must not look like failures');
{
  // A permit fee paid straight to a municipality has no invoice and never will.
  // Six of the fifty sampled charges are exactly this.
  const direct = strip({ attachments: [], bill: null,
    payment: { direct: true, reconciled: true, bank: { known: true, label: '1095 Demo Portfolio - First Commerce' } } });
  check('a directly-paid charge says "no invoice — paid directly", not a warning',
    has(direct, 'No invoice — paid directly') && !has(direct, 'No scan'), direct);
  check('...and still names the account and the clearance',
    has(direct, 'First Commerce') && has(direct, 'Cleared the bank'), direct);

  const missingScan = strip({ attachments: [], bill: { amount: 10 }, payment: null });
  check('a bill whose scan was never uploaded is marked, not silently blank',
    has(missingScan, 'No scan on this bill'), missingScan);

  check('an empty payload renders nothing rather than an empty box', strip({}) === '');
  check('...and a card charge with nothing resolved does not throw',
    typeof strip({ creditCard: { charge: { found: false } } }) === 'string');
}

console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
