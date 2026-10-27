#!/usr/bin/env node
// The Renovations drill page — the tab's main surface, run rather than eyeballed.
//
// The owner, 2026-09-02: *"At the top, having the total number … and show the
// breakdown by entity … when you click on a certain entity, then another whole
// page opens with each property broken down."* The strip of cards this replaced
// spent ~250px before a single figure of spend appeared and pushed the breakdown
// seven hundred pixels down the page.
//
// What can go wrong here is quiet: a bar that encodes nothing, a list that stops
// at twelve without saying so, a property name from Rent Manager landing in the
// page as markup. So the render functions are lifted out of index.html and
// executed against known inputs.
//
//   node scripts/checkRenoDrill.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
// Counting braces from the first "{" lifts the wrong thing when the parameter
// list is destructured — renoHeroHtml({ total, label … }) closes on the
// parameter object and hands back half a function. So the body is found after
// the parameter list's own closing paren.
function lift(decl) {
  const at = html.indexOf(decl);
  if (at === -1) throw new Error(`checkRenoDrill: ${decl} not found in index.html`);
  let i = html.indexOf('(', at), paren = 0;
  for (; i < html.length; i++) {
    if (html[i] === '(') paren++;
    else if (html[i] === ')' && --paren === 0) { i++; break; }
  }
  i = html.indexOf('{', i);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
  }
  throw new Error(`checkRenoDrill: ${decl} has no closing brace`);
}

const COMMON = '__common__';
const sandbox = {
  console, COMMON,
  esc: (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
};
vm.createContext(sandbox);
// The real formatter, not a stand-in for it. A stub that renders "$-4,200" where
// the page renders "-$4,200" tests the stub.
{
  const at = html.indexOf("const money = n => (n < 0");
  if (at === -1) throw new Error('checkRenoDrill: the money formatter moved');
  sandbox.money = null;
  vm.createContext(sandbox);
  vm.runInContext(html.slice(at, html.indexOf('\n', at)).replace('const money', 'money'), sandbox);
}
for (const decl of [
  'const BAR_HUE =', 'const BAR_TRACK =', 'const UNIT_ROWS_SHOWN =', 'const PROP_ROWS_SHOWN =',
]) {
  const at = html.indexOf(decl);
  vm.runInContext(html.slice(at, html.indexOf(';', at) + 1), sandbox);
}
for (const fn of ['function renoBar(', 'function renoHeroHtml(', 'function renoRankRow(',
                  'function renoRankListHtml(', 'function renoPickerHtml(',
                  'function renoUnitPickerHtml(', 'function renoPropPickerHtml(',
                  'function renoCapFooter(', 'function renoSplitBarHtml(',
                  'function renoCatSplitRows(', 'function renoSearchRowHtml(']) {
  vm.runInContext(lift(fn), sandbox);
}

let fails = 0, checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
};
const widthOf = (h) => { const m = /width:([\d.]+)%/.exec(h); return m ? Number(m[1]) : null; };

console.log('\nThe bar encodes length, and only length');
// A value-ramp on nominal categories double-encodes bar length as hue, spends the
// only free channel on information the bar already carries, and is meaningless
// for categories with no natural order — a property is not "more" than another
// property, it just spent more.
{
  const big = sandbox.renoBar(1000, 1000);
  const small = sandbox.renoBar(50, 1000);
  const hues = [big, small].map(h => (h.match(/background:(#[0-9A-Fa-f]{6})/g) || []).join('|'));
  check('every bar is the same colour, whatever its value', hues[0] === hues[1], hues.join(' vs '));
  check('the leader fills the track', widthOf(big) === 100, String(widthOf(big)));
  check('a small value draws a proportional bar', widthOf(small) === 5, String(widthOf(small)));
}
check('a value bigger than the scale cannot overflow the track',
  widthOf(sandbox.renoBar(5000, 1000)) === 100, 'a bar wider than its rail breaks the row');
check('a near-zero value still draws something visible rather than nothing',
  widthOf(sandbox.renoBar(1, 1000000)) === 2, 'an invisible bar reads as a missing row');
check('a zero scale does not divide by zero', widthOf(sandbox.renoBar(0, 0)) === 2);
check('a credit draws on the same scale as a charge, not backwards',
  widthOf(sandbox.renoBar(-500, 1000)) === 50, String(widthOf(sandbox.renoBar(-500, 1000))));

console.log('\nThe ranked list');
const ROWS = [
  { label: 'Willow Creek', value: 200000, note: '11 properties', onclick: "renoPickEntity('Willow Creek')" },
  { label: 'Cedar Ridge', value: 50000, note: '36 properties', onclick: "renoPickEntity('Cedar Ridge')" },
];
{
  const out = sandbox.renoRankListHtml('Spend by entity', ROWS, 250000);
  check('every row carries its own click target', (out.match(/renoPickEntity/g) || []).length === 2);
  check('the share is of the whole, not of the leader', /80%/.test(out) && /20%/.test(out),
    'the bar is scaled to the leader; the percentage must still be the true share');
  check('the heading says how many rows there are', /Spend by entity/.test(out) && /2 · click to open/.test(out));
  check('an empty list renders nothing rather than an empty card',
    sandbox.renoRankListHtml('Spend by entity', [], 0) === '');
}
{
  // A share below half a percent rounds to 0% and reads as "spent nothing".
  const out = sandbox.renoRankListHtml('x', [{ label: 'tiny', value: 10, onclick: 'x' }], 1000000);
  check('a share too small to round is shown as <1%, never as 0%',
    /&lt;1%/.test(out) || /<1%/.test(out), out.slice(0, 200));
}
{
  const out = sandbox.renoRankListHtml('x', [
    { label: 'refund', value: -4200, onclick: 'x' }], -4200);
  check('a credit shows in the credit colour, not as ordinary spend', /#8C2020/.test(out));
  check('...and reads as a negative figure', /-\$4,200/.test(out), out.slice(0, 300));
}

console.log('\nNames come from Rent Manager and are not ours to trust');
{
  const out = sandbox.renoRankListHtml('x', [
    { label: '<img src=x onerror=alert(1)>', note: '<b>note</b>', value: 1, onclick: 'x' }], 1);
  check('a property name is escaped', !/<img src=x/.test(out) && /&lt;img/.test(out));
  check('...and so is the line under it', !/<b>note<\/b>/.test(out));
}
{
  const hero = sandbox.renoHeroHtml({ total: 6111297, label: '<script>', meta: 'x', crumb: 'y' });
  check('the hero label is escaped', !/<script>/.test(hero));
  check('the hero states the money large enough to read across a desk',
    /font-size:44px/.test(hero) && /\$6,111,297/.test(hero));
}

console.log('\nA property with sixty units is a scroll, not a list');
const unitsFor = (n) => ({
  name: 'X', unitList: Array.from({ length: n }, (_, i) => ({
    name: `${i}A`, isCommon: false, total: 1000 - i, count: 1,
  })),
});
check('a short property gets no picker — it is already all on screen',
  sandbox.renoUnitPickerHtml(unitsFor(sandbox.UNIT_ROWS_SHOWN)) === '');
{
  const picker = sandbox.renoUnitPickerHtml(unitsFor(40));
  check('a long one gets a picker', /<select/.test(picker));
  check('...and the picker holds EVERY unit, not just the ones the list showed',
    (picker.match(/<option/g) || []).length === 41, 'one placeholder + 40 units');
  check('...each with what it cost, so the choice is informed', /— \$1,000/.test(picker));
  check('...and it says how many there are', /40 units here/.test(picker));
}
{
  // A list that quietly stops at twelve is one somebody reads as the whole property.
  const out = sandbox.renoRankListHtml('Units in X', ROWS, 250000,
    '<div>Showing the 12 biggest of 15 · the other 3 are in the picker above.</div>');
  check('the cap is stated on the list, not left for the reader to notice',
    /Showing the 12 biggest of 15/.test(out));
  check('...and the note sits inside the card it belongs to',
    out.trim().endsWith('</div>') && out.indexOf('Showing the 12') < out.lastIndexOf('</div>'));
}

console.log('\nHow much of it is actually a unit\'s');
// The owner, looking at Birchwood Commons: "it's three point eight million, but the unit
// breakdown is all in the thousands. I doubt that it adds up." It does add up —
// 86% of it is booked with no unit named, so the per-unit figures are small
// because most of the money never reached a unit label. That is the row this
// draws, at every level, rather than leaving it to be inferred from a hole.
{
  const rows = [
    { amount: 100, unitName: '2R', propertyId: 1 },
    { amount: 300, unitName: null, propertyId: 1 },
  ];
  const out = sandbox.renoSplitBarHtml(rows);
  check('the split states both halves in money, not only a percentage',
    /\$100/.test(out) && /\$300/.test(out), out.slice(0, 300));
  check('...and the percentages are of the total', /25%/.test(out) && /75%/.test(out));
  check('...and it counts the named units, not the charges', /1 named unit\b/.test(out));
}
check('a scope with no spend draws no split rather than a divide-by-zero bar',
  sandbox.renoSplitBarHtml([{ amount: 0, unitName: null }]) === '');
{
  // The Birchwood Commons case: a total that looks fine and a unit breakdown that cannot
  // possibly reach it. Worth a flag, because the accounts underneath are Kitchen
  // Cabinets and Doors — unit work that was never tagged to a unit.
  const mostly = sandbox.renoSplitBarHtml([
    { amount: 100, unitName: '2R', propertyId: 1 },
    { amount: 900, unitName: null, propertyId: 1 },
  ]);
  check('a scope that is mostly untagged says so', /mostly untagged/.test(mostly));
  const fine = sandbox.renoSplitBarHtml([
    { amount: 900, unitName: '2R', propertyId: 1 },
    { amount: 100, unitName: null, propertyId: 1 },
  ]);
  check('...and a well-tagged one is not flagged', !/mostly untagged/.test(fine));
}

console.log('\nAn account opens into the level below, not into the raw ledger');
// Opening "REN- Plumbing" inside an entity used to list 246 charges across 36
// buildings. That is the ledger, not an answer: inside an entity the next cut is
// per property, inside a property it is per unit.
const CAT = {
  key: 'k', name: 'REN- Plumbing',
  charges: [
    { amount: 500, propertyId: 7, propertyName: '15 Summit Avenue', unitName: '2R' },
    { amount: 300, propertyId: 7, propertyName: '15 Summit Avenue', unitName: '3B' },
    { amount: 200, propertyId: 9, propertyName: '88 Maple Court', unitName: null },
  ],
};
{
  const byProp = sandbox.renoCatSplitRows(CAT, 'entity');
  check('inside an entity the account splits by property',
    /15 Summit Avenue/.test(byProp) && /88 Maple Court/.test(byProp));
  check('...summing each property\'s charges rather than listing them',
    /\$800/.test(byProp) && !/2R/.test(byProp), byProp.slice(0, 400));
  check('...biggest first', byProp.indexOf('15 Summit Avenue') < byProp.indexOf('88 Maple Court'));
  check('...and each row drills into that property',
    /renoPickProperty\('7'\)/.test(byProp));
}
{
  const byUnit = sandbox.renoCatSplitRows(CAT, 'property');
  check('inside a property the same account splits by unit',
    /Unit 2R/.test(byUnit) && /Unit 3B/.test(byUnit));
  check('...and a charge with no unit is shown as building-level, not dropped',
    /Building \/ no unit named/.test(byUnit));
  check('...and each row drills into that unit', /renoPickUnit\('2R'\)/.test(byUnit));
}
{
  // An unattributed posting has no property to drill into. It still holds real
  // money, so it gets a row — just not a click that goes nowhere.
  const orphan = sandbox.renoCatSplitRows({
    key: 'k', name: 'x', charges: [{ amount: 50, propertyId: null, propertyName: null, unitName: null }],
  }, 'entity');
  check('an unattributed posting is listed but not clickable',
    /Unattributed/.test(orphan) && !/renoPickProperty/.test(orphan));
}
{
  // A long tail of one-charge buildings under one account is noise. It is folded,
  // and the fold states what it holds so the column still adds up.
  const many = { key: 'k', name: 'x', charges: [] };
  for (let i = 1; i <= 20; i++) many.charges.push({ amount: 100 - i, propertyId: i, propertyName: `P${i}`, unitName: null });
  const out = sandbox.renoCatSplitRows(many, 'entity');
  check('a long tail is folded rather than scrolled', /\+ 5 more properties/.test(out));
  check('...and the fold says what it holds, so the column still ties',
    /\$410/.test(out), 'the 5 smallest of 99..80 are 84+83+82+81+80');
}

console.log('\nOne search box for everything on the tab');
// It was units only, so the two things anyone actually hunts for — a vendor's
// name and an invoice number — had no way in.
{
  const kinds = ['entity', 'property', 'unit', 'vendor', 'bill'];
  const rendered = kinds.map(kind => sandbox.renoSearchRowHtml({
    kind, name: 'X', total: 100, charges: 2, propertyId: 7, property: 'P', entity: 'E', vendor: 'V',
  }));
  check('an entity result drills to that entity', /renoPickEntity/.test(rendered[0]));
  check('a property result drills to that property', /renoPickProperty\('7'\)/.test(rendered[1]));
  check('a unit result opens that unit', /renoOpenUnit\(7,/.test(rendered[2]));
  // A vendor and an invoice number are not places in the hierarchy. They cannot
  // be drilled to, so they filter the ledger to themselves instead of offering a
  // click that goes nowhere.
  check('a vendor result filters the ledger to it rather than dead-ending',
    /renoSearchAsFilter/.test(rendered[3]));
  check('an invoice number does the same', /renoSearchAsFilter/.test(rendered[4]));
  check('every result closes the dropdown on the way out',
    rendered.every(r => /renoSearchPick\(\)/.test(r)));
  check('every result carries what it cost, so the choice is informed',
    rendered.every(r => /\$100/.test(r)));
}
{
  // Vendor names and unit labels come out of Rent Manager.
  const out = sandbox.renoSearchRowHtml({
    kind: 'vendor', name: "<img src=x onerror=alert(1)>", total: 1, charges: 1,
  });
  check('a vendor name out of Rent Manager is escaped, not parsed',
    !/<img src=x/.test(out) && /&lt;img/.test(out));
}
{
  // A name with an apostrophe — O'Brien Plumbing — would otherwise close the
  // string in the onclick and break the row.
  const out = sandbox.renoSearchRowHtml({
    kind: 'entity', name: "O'Brien Holdings", total: 1, charges: 1,
  });
  check('an apostrophe in a name does not break the click handler',
    /renoPickEntity\('O\\'Brien Holdings'\)/.test(out), out.slice(0, 260));
}
check('the search still finds units — the thing it used to do is not lost',
  /renoOpenUnit/.test(html) && /Search anything/.test(html));
check('...and it is out in the open, not behind the Filters button',
  html.indexOf('id="reno-unit-search"') < html.indexOf('id="reno-filters"'));

console.log('\nThe page survives the server not answering JSON');
// The owner, mid-demo: "Unexpected token '<', \"<!DOCTYPE\"... is not valid JSON."
// The host serves its own HTML error page while a deploy rolls out, and calling
// .json() on that produces a message that says nothing about what to do.
{
  // 'function kv(' also exists in an earlier tab, so the end bound has to be
  // searched FROM the start bound — otherwise the slice runs backwards and every
  // assertion against it passes or fails for the wrong reason.
  const at = html.indexOf('window.renoLoadBackup');
  const src = html.slice(at, html.indexOf('function kv(', at));
  check('the backup call reads text first, so HTML cannot throw a parse error',
    /r\.text\(\)/.test(src) && !/\br\.json\(\)/.test(src), 'r.json() on an HTML body is the bug');
  check('...and a mid-deploy page tells you to wait and retry',
    /restarting/i.test(src) && /DOCTYPE/i.test(src));
  check('...and a dropped session tells you to reload and re-enter the PIN',
    /401/.test(src) && /PIN again/i.test(src));
}
{
  // The guard that keeps one bad request from taking the site down with it.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('the server survives an unhandled rejection instead of exiting',
    /process\.on\('unhandledRejection'/.test(server),
    'Node terminates the process by default, which is a site outage per stray promise');
  check('...and an uncaught exception', /process\.on\('uncaughtException'/.test(server));
}

console.log('\nThe page leads with the money');
{
  // The regression that prompted all of this: the scope picker taking the top of
  // the page and pushing the spend below the fold.
  const strip = html.indexOf('id="reno-entity-strip"');
  const board = html.indexOf('id="reno-board-card"');
  check('the drill page comes before the ledger in the document', strip > 0 && board > strip);
  check('the entity and property dropdowns are gone — the drill IS the scope picker',
    !/id="reno-f-entity"/.test(html) && !/id="reno-f-property"/.test(html));
  check('...and no handler is left reading .value off an element that no longer exists',
    !/renoOnEntityChange = function/.test(html) && !/renoOnPropertyChange = function/.test(html));
  check('the total is not also printed by the old summary block',
    !/id="reno-summary"/.test(html), 'two totals on one screen invite the question which is right');
  check('the rows answer the cursor, or a clickable list reads as a static table',
    /\.reno-rank-row:hover/.test(html));
}

console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
