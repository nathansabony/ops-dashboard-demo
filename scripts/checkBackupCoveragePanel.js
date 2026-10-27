#!/usr/bin/env node
// The coverage panel, run for real against a coverage payload.
//
// The panel's whole job is to stop someone opening a property in front of
// ownership and finding blanks. A panel that renders a wrong number is worse than
// no panel — it would be trusted. So the functions are lifted out of index.html
// and executed, rather than eyeballed.
//
//   node scripts/checkBackupCoveragePanel.js [path/to/coverage.json]
//
// With no argument it uses a built-in payload shaped like the live one.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function lift(decl) {
  const at = html.indexOf(decl);
  if (at === -1) throw new Error(`checkBackupCoveragePanel: ${decl} not found in index.html`);
  let i = html.indexOf('{', at), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
  }
  throw new Error(`checkBackupCoveragePanel: ${decl} has no closing brace`);
}

const sandbox = {
  console,
  _renoDocIndex: new Map([['c1', 'pdf'], ['c2', 'spreadsheet'], ['c3', 'card'], ['c4', 'statement']]),
  DOC_MARK: {
    pdf:         { icon: '\u{1F4C4}', label: 'Invoice PDF ready to open', fg: '#14653B', bg: '#EDF3EE', bd: '#B9CDBE' },
    spreadsheet: { icon: '\u{1F4CA}', label: 'Backup spreadsheet ready to open', fg: '#6B4E16', bg: '#FBF3E7', bd: '#E3CFA3' },
    image:       { icon: '\u{1F5BC}', label: 'Scan or photo ready to open', fg: '#14653B', bg: '#EDF3EE', bd: '#B9CDBE' },
    card:        { icon: '\u{1F9FE}', label: 'Card receipt ready to open', fg: '#14653B', bg: '#EDF3EE', bd: '#B9CDBE' },
    statement:   { icon: '\u{1F4D1}', label: 'A consolidated statement covering many charges — not a single invoice',
                   fg: '#6B4E16', bg: '#FBF3E7', bd: '#E3CFA3' },
  },
  esc: (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  money: (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`,
};
vm.createContext(sandbox);
vm.runInContext([
  lift('function renoBcovBar'),
  lift('function renoBcovRows'),
  lift('function renoBcovTable'),
  lift('function renoBcovEntityHtml'),
  lift('function renoDocMark'),
  lift('function renoBackupCoverageHtml'),
].join('\n\n'), sandbox);

let fails = 0, checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
};

const FIXTURE = {
  totals: { charges: 28261, withBill: 13200, withDocument: 7660, byRef: 11836, byAmount: 1364,
    documentRate: 27, billRate: 47, vendorUnreadable: 0, noVendor: 0 },
  byVendor: [
    { key: '1', name: 'Marga Tile INC', charges: 188, documentRate: 93, billRate: 95, amountWithDocument: 100439, amount: 108000 },
    { key: '2', name: 'Decom Services Inc.', charges: 712, documentRate: 71, billRate: 80, amountWithDocument: 1106300, amount: 1500000 },
    { key: '3', name: 'Acme Heating', charges: 496, documentRate: 0, billRate: 12, amountWithDocument: 0, amount: 12947 },
    { key: '4', name: 'Segovia Cabinetry LLC', charges: 63, documentRate: 0, billRate: 5, amountWithDocument: 0, amount: 1750 },
  ],
  byMonth: [
    { key: '2025-11', charges: 842, documentRate: 77, billRate: 80, amountWithDocument: 50000, amount: 60000 },
    { key: '2026-01', charges: 2072, documentRate: 4, billRate: 79, amountWithDocument: 1000, amount: 400000 },
    { key: '2026-08', charges: 116, documentRate: 34, billRate: 41, amountWithDocument: 9000, amount: 20000 },
  ],
  byEntity: [
    { key: 'Cedar Ridge', entity: 'Cedar Ridge', charges: 322, withDocument: 106, documentRate: 33, billRate: 50, amountWithDocument: 12727, amount: 32000,
      properties: [
        { property: '90 Maple Court', charges: 22, documentRate: 45, billRate: 55, amountWithDocument: 9031, amount: 20000 },
        { property: '77 Birchwood Lane', charges: 300, documentRate: 31, billRate: 48, amountWithDocument: 3696, amount: 12000 },
      ] },
    { key: 'CC', entity: 'CC', charges: 673, withDocument: 36, documentRate: 5, billRate: 33, amountWithDocument: 83318, amount: 900010,
      properties: [
        { property: 'Willow Creek', charges: 670, documentRate: 5, billRate: 33, amountWithDocument: 83308, amount: 900000 },
        { property: 'Tiny Place', charges: 3, documentRate: 100, billRate: 100, amountWithDocument: 10, amount: 10 },
      ] },
  ],
  properties: [
    { property: '90 Maple Court', entity: 'Cedar Ridge', charges: 22, documentRate: 45, billRate: 55, amountWithDocument: 9031, amount: 20000 },
    { property: '77 Birchwood Lane', entity: 'Cedar Ridge', charges: 300, documentRate: 31, billRate: 48, amountWithDocument: 3696, amount: 12000 },
    { property: 'Willow Creek', entity: 'CC', charges: 670, documentRate: 5, billRate: 33, amountWithDocument: 83308, amount: 900000 },
    { property: 'Tiny Place', entity: 'CC', charges: 3, documentRate: 100, billRate: 100, amountWithDocument: 10, amount: 10 },
  ],
};

const arg = process.argv[2];
const payload = arg ? JSON.parse(fs.readFileSync(arg, 'utf8')) : FIXTURE;
const out = sandbox.renoBackupCoverageHtml(payload);

console.log(`\nThe panel renders (${arg ? path.basename(arg) : 'built-in fixture'})`);
check('it produces markup rather than throwing', typeof out === 'string' && out.length > 500);
check('no "undefined" or "NaN" reaches the screen',
  !/undefined|NaN/.test(out), (out.match(/.{0,60}(undefined|NaN).{0,60}/) || [])[0]);
check('the headline rate is the one the sweep computed',
  out.includes(`${payload.totals.documentRate}%`), `expected ${payload.totals.documentRate}%`);
check('the charge count is shown with separators, not raw',
  out.includes(payload.totals.charges.toLocaleString()));

console.log('\nEntity first, then the properties inside it');
const iEntity = out.indexOf('By entity');
const iVendor = out.indexOf('By vendor');
check('entities lead, vendors are folded away behind them',
  iEntity > -1 && iVendor > iEntity, `entity@${iEntity} vendor@${iVendor}`);
check('the month table is gone — it was not what anyone was choosing on',
  !/By month/.test(out));
for (const e of (payload.byEntity || []).slice(0, 3)) {
  check(`entity "${e.entity}" is on the page with its own rate`,
    out.includes(sandbox.esc(e.entity)) && out.includes(`>${e.documentRate}%<`),
    `expected ${e.documentRate}%`);
}
const firstEnt = (payload.byEntity || [])[0];
if (firstEnt && firstEnt.properties && firstEnt.properties.length) {
  check('its properties are nested inside it, not listed separately',
    out.includes(sandbox.esc(firstEnt.properties[0].property)),
    'a property must be reachable by opening its entity');
}
check('entities are ordered best-covered first',
  (payload.byEntity || []).every((e, i, a) => i === 0 || a[i - 1].documentRate >= e.documentRate),
  (payload.byEntity || []).map(e => `${e.entity}:${e.documentRate}`).join(' '));
// The trap in a nested table: an entity rate that is the AVERAGE of its
// properties' percentages rather than its own charges. Willow Creek at 5% over
// 670 charges beside a 3-charge property at 100% would read as 52%.
for (const e of (payload.byEntity || [])) {
  const own = e.charges ? Math.round((e.withDocument / e.charges) * 100) : 0;
  check(`entity "${e.entity}" is weighted by charges, not by averaging its properties`,
    e.documentRate === own, `panel shows ${e.documentRate}%, charges give ${own}%`);
}

console.log('\nIt does not overstate what it knows');
const empties = (payload.byVendor || []).filter(v => v.documentRate === 0);
if (empties.length) {
  check('vendors with nothing are named as such',
    /No invoices at all/.test(out) && out.includes(sandbox.esc(empties[0].name)),
    'a vendor with no invoices must be visible, not merely absent from the good list');
}
const gaps = (payload.byMonth || []).filter(m => m.charges >= 100 && m.billRate >= 50 && m.documentRate <= 15);
check(gaps.length ? 'a month with bills but no scans is called a filing gap' : 'no filing gap is claimed when none fits',
  gaps.length ? /filing gap/.test(out) && out.includes(gaps[0].key) : !/filing gap/.test(out),
  gaps.map(g => g.key).join(', '));

const unread = payload.totals.vendorUnreadable || 0;
check(unread ? 'unreadable vendors are flagged as unknown, not empty' : 'no unreadable-vendor warning when there are none',
  unread ? /unknown, not empty/.test(out) : !/could not be read/.test(out));

console.log('\nIt is honest about small numbers');
// A three-charge property at 100% is not a finding, and must not drag its entity
// upward either.
const tinyEnt = (payload.byEntity || []).find(e => (e.properties || []).some(p => p.charges < 5));
if (tinyEnt) {
  check('a tiny property inside an entity does not inflate the entity rate',
    tinyEnt.documentRate < 60,
    `${tinyEnt.entity} shows ${tinyEnt.documentRate}% — check it is not averaging percentages`);
}

// Escaping: vendor names come from Rent Manager and are not ours to trust.
const XSS = JSON.parse(JSON.stringify(payload));
XSS.byVendor = [{ key: 'x', name: '<img src=x onerror=alert(1)>', charges: 50, documentRate: 90, billRate: 90, amountWithDocument: 1, amount: 1 }];
const xssOut = sandbox.renoBackupCoverageHtml(XSS);
check('a vendor name is escaped — these come from Rent Manager, not from us',
  !/<img src=x/.test(xssOut) && /&lt;img/.test(xssOut));

console.log('\nThe per-charge marker');
// The whole point of the sweep from a user's seat: knowing which rows are worth
// clicking without clicking all of them.
check('a charge with a PDF is marked ready', /ready/.test(sandbox.renoDocMark('c1')));
check('...and the marker says WHICH kind, so a spreadsheet is not sold as an invoice',
  /Backup spreadsheet/.test(sandbox.renoDocMark('c2')) && /Invoice PDF/.test(sandbox.renoDocMark('c1')));
check('a card receipt gets its own mark', /Card receipt/.test(sandbox.renoDocMark('c3')));
check('a charge with nothing is left silent, not marked with a red cross',
  sandbox.renoDocMark('nope') === '',
  'most of these are bills whose scan was never attached — 13,000 red marks would read as 13,000 problems');
{
  // Before the index loads the board must render, just without marks.
  const saved = sandbox._renoDocIndex;
  sandbox._renoDocIndex = null;
  check('before the index loads, rows render with no marker rather than breaking',
    sandbox.renoDocMark('c1') === '');
  sandbox._renoDocIndex = saved;
}

check('a statement-backed charge is marked as a statement, not as ready',
  /statement/.test(sandbox.renoDocMark('c4')) && !/ready/.test(sandbox.renoDocMark('c4')),
  'a fifty-page consolidated bill offered as "the invoice" is the click that looks broken');

console.log('\nThe "only with an invoice" filter');
// The filter exists so a walkthrough opens charges that pull. A statement-backed
// charge DOES open — and opens to a consolidated bill covering hundreds of
// purchases, which is the one thing the filter is there to keep out of a demo.
// The rule lives inside a long predicate in index.html, so it is lifted and run
// rather than trusted to stay put.
const predicate = (() => {
  const at = html.indexOf('if (_renoDocOnly && _renoDocIndex) {');
  if (at === -1) throw new Error('the doc-only filter rule is no longer where the test looks for it');
  const end = html.indexOf('\n      }', at);
  const body = html.slice(at, end + 8);
  return new Function('c', '_renoDocOnly', '_renoDocIndex',
    `${body}\n return true;`);
})();

check('with the filter off, everything passes',
  predicate({ id: 'c4' }, false, sandbox._renoDocIndex) === true);
check('a charge with a real invoice passes the filter',
  predicate({ id: 'c1' }, true, sandbox._renoDocIndex) === true);
check('a card receipt passes too — it is that charge\'s own paperwork',
  predicate({ id: 'c3' }, true, sandbox._renoDocIndex) === true);
check('a STATEMENT-backed charge is excluded, even though it opens',
  predicate({ id: 'c4' }, true, sandbox._renoDocIndex) === false,
  'this is the whole point: every row left standing survives a click in front of ownership');
check('a charge with nothing at all is excluded',
  predicate({ id: 'nope' }, true, sandbox._renoDocIndex) === false);

// The note has to say what was HIDDEN, not only what is shown — a filter that
// quietly drops 6,970 charges is one somebody discovers mid-demo.
const noteSrc = html.slice(html.indexOf('function renoDocOnlyChrome'),
                           html.indexOf('const DOC_MARK'));
check('the filter tells you how many statement-backed charges it hid',
  /statement-backed charges hidden/.test(noteSrc));
check('...and with it off, says how many open an invoice vs a statement',
  /open their own invoice/.test(noteSrc) && /open a consolidated statement/.test(noteSrc));
check('the button says invoice, not document — it no longer means "anything opens"',
  /Only with an invoice/.test(html) && !/Only with a document/.test(html));

console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
