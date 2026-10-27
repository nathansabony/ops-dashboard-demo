// The Delinquency tab's collections brief (dqrBuildReport and its two renderers
// in public/index.html): canned collections in, sentences out.
//
// What this holds the report to:
//   * the headline numbers are the data's numbers (latest month, vs last month,
//     the latest month to reach +2 against the goal)
//   * the ranking is lowest share collected to date first, properties billing
//     under the floor are left out, and a property at goal is not listed
//   * each driver (few large vs many small balances, slow vs stalled, worse vs
//     steady) is the one the canned numbers say, with the numbers in the words
//   * Central Ohio reads before Northern Ohio and each line names its weakest entity
//   * no "undefined" or "NaN" in any sentence, in the page card or in the PDF,
//     including with no months, no tenant list, a single month, nothing billed
//   * every interpolated string is escaped (a property named <b>, a tenant with
//     a quote and a tag in the name)
//   * the PDF carries the as-of date, the source and the Cedar Ridge-estimate stamp
//   * the page wires it: the top card, the repaint hook, the print button
//   * the workflow runs this check, and no step name has an unquoted ": " (an
//     unquoted one made GitHub run no jobs at all on 2026-10-22)
//
// The functions are lifted out of the page by name and run in a vm sandbox with
// nothing else in scope, so a page global sneaking into them would throw here.
//
// Run: npm run check:delinquency-report

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let failures = 0;
function check(what, fn) {
  try { fn(); console.log('  ok   ' + what); }
  catch (err) { failures++; console.log('  FAIL ' + what + '\n       ' + err.message); }
}

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function lift(name) {
  const start = PAGE.indexOf('function ' + name + '(');
  assert.ok(start > 0, 'could not find function ' + name + ' in public/index.html');
  let i = PAGE.indexOf('{', start), depth = 0, inStr = null, prev = '';
  for (; i < PAGE.length; i++) {
    const c = PAGE[i];
    if (inStr) {
      if (c === inStr && prev !== '\\') inStr = null;
    } else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return PAGE.slice(start, i + 1); }
    prev = prev === '\\' ? '' : c;
  }
  throw new Error('could not find the end of ' + name);
}

const NAMES = ['dqrEsc', 'dqrPct', 'dqrMoney', 'dqrPts', 'dqrPlural', 'dqrBuildReport', 'dqrCardHtml', 'dqrPrintHtml'];
const ctx = vm.createContext({});
vm.runInContext(NAMES.map(lift).join('\n\n'), ctx);
const build = inp => vm.runInContext('dqrBuildReport', ctx)(inp);
const card = (m, o) => vm.runInContext('dqrCardHtml', ctx)(m, o);
const print = (m, p) => vm.runInContext('dqrPrintHtml', ctx)(m, p);
// the model comes out of another realm; copy it so assert and JSON behave
const plain = x => JSON.parse(JSON.stringify(x));

// ── canned collections ─────────────────────────────────────────────────────
// [charged, m0, m1, m2, now] per property per month, newest first. A bucket that
// has not matured holds a meaningless number on purpose: if the report used it,
// the expected figures below would be off.
const MATURE = [{ m0: true, m1: false, m2: false }, { m0: true, m1: true, m2: false }, { m0: true, m1: true, m2: true }, { m0: true, m1: true, m2: true }];
const LABELS = ['Sep 2026', 'Aug 2026', 'Jul 2026', 'Jun 2026'];
const EVIL = '<b>Evil & "Co"</b>';
const PROPS = {
  'Bad Hill':   { entity: 'Willow Creek', rows: [[100000, 60000, 0, 0, 62000], [100000, 70000, 75000, 0, 80000], [100000, 80000, 82000, 84000, 85000], [100000, 85000, 86000, 87000, 90000]] },
  'Ocean View': { entity: 'Birchwood Commons', rows: [[100000, 70000, 0, 0, 75000], [100000, 72000, 90000, 0, 95000], [100000, 70000, 90000, 99000, 99000], [100000, 71000, 92000, 99500, 99500]] },
  'Few Large':  { entity: 'Cedar Ridge', rows: [[80000, 76000, 0, 0, 77000], [80000, 77000, 78000, 0, 79000], [80000, 77000, 78000, 78000, 78500], [80000, 77000, 78000, 78000, 78500]] },
  'Good':       { entity: 'Maple Court', rows: [[100000, 99000, 0, 0, 99500], [100000, 99000, 99600, 0, 99800], [100000, 99100, 99600, 99900, 99900], [100000, 99000, 99600, 99900, 99900]] },
  'Tiny':       { entity: 'The Alder', rows: [[1000, 400, 0, 0, 400], [1000, 400, 400, 0, 400], [1000, 400, 400, 400, 400], [1000, 400, 400, 400, 400]] },
};
PROPS[EVIL] = { entity: 'Summit Lofts', rows: [[50000, 40000, 0, 0, 44000], [50000, 44000, 45000, 0, 46000], [50000, 45000, 46000, 47000, 47000], [50000, 45000, 46000, 47000, 47000]] };

function monthsFrom(props, keep) {
  return LABELS.slice(0, keep || 4).map((label, i) => {
    const byProperty = {}, byEntity = {};
    const totals = { charged: 0, m0: 0, m1: 0, m2: 0, now: 0 };
    Object.keys(props).forEach(name => {
      const p = props[name], r = p.rows[i];
      const v = { charged: r[0], m0: r[1], m1: r[2], m2: r[3], now: r[4], entity: p.entity };
      byProperty[name] = v;
      const e = byEntity[p.entity] || (byEntity[p.entity] = { charged: 0, m0: 0, m1: 0, m2: 0, now: 0 });
      ['charged', 'm0', 'm1', 'm2', 'now'].forEach((k, j) => { e[k] += r[j]; totals[k] += r[j]; });
    });
    return { key: '2026-0' + (9 - i), label, mature: MATURE[i], current: { totals, byEntity, byProperty }, allIn: null };
  });
}
const TENANTS = [];
for (let i = 0; i < 10; i++) TENANTS.push({ tenant: 'Tenant ' + String.fromCharCode(65 + i), unit: String(100 + i), property: 'Bad Hill', entity: 'Willow Creek', amount: 1000 });
TENANTS.push({ tenant: 'Big Debtor', unit: '200', property: 'Bad Hill', entity: 'Willow Creek', amount: 1500 });
TENANTS.push({ tenant: 'Ocean One', unit: '12', property: 'Ocean View', entity: 'Birchwood Commons', amount: 9000 });
TENANTS.push({ tenant: 'Ocean Two', unit: '14', property: 'Ocean View', entity: 'Birchwood Commons', amount: 6000 });
[8000, 3000, 500, 400].forEach((a, i) => TENANTS.push({ tenant: 'Large ' + (i + 1), unit: String(i + 1), property: 'Few Large', entity: 'Cedar Ridge', amount: a }));
TENANTS.push({ tenant: "O'Brien <img src=x onerror=alert(1)>", unit: '4<B>', property: EVIL, entity: 'Summit Lofts', amount: 2500 });
TENANTS.push({ tenant: 'Credit Only', unit: '1', property: 'Good', entity: 'Maple Court', amount: -50 });   // never a delinquent tenant
const UNITS = { 'Bad Hill': 110, 'Ocean View': 200, 'Few Large': 60 };   // the others have no unit count on purpose
const INPUT = {
  months: monthsFrom(PROPS), goal: 0.98, floor: 5000, regionOf: e => (e === 'Birchwood Commons' ? 'Central Ohio' : 'Northern Ohio'),
  units: UNITS, tenants: TENANTS, graceDays: 5, asOf: '2026-10-21', refreshedAt: '10/21/2026, 11:32:39 PM',
};
const pct = x => (x * 100).toFixed(1) + '%';
const sum = (i, k) => Object.keys(PROPS).reduce((s, n) => s + PROPS[n].rows[i][k], 0);
const R = plain(build(INPUT));

console.log('\nThe headline reads the data');
check('the latest month: billed, month-end rate, to date, still owed', () => {
  const s = R.headline[0];
  assert.ok(s.startsWith('Sep 2026: we billed $' + sum(0, 0).toLocaleString('en-US')), s);
  assert.ok(s.includes('collected ' + pct(sum(0, 1) / sum(0, 0)) + ' by month end'), s);
  assert.ok(s.includes(pct(sum(0, 4) / sum(0, 0)) + ' to date'), s);
  assert.ok(s.includes('$' + (sum(0, 0) - sum(0, 4)).toLocaleString('en-US') + ' still owed'), s);
});
check('against last month, in points, in the right direction', () => {
  const d = sum(0, 1) / sum(0, 0) - sum(1, 1) / sum(1, 0);
  const s = R.headline[0];
  assert.ok(s.includes((d > 0 ? 'up ' : 'down ') + (Math.abs(d) * 100).toFixed(1) + ' points on Aug 2026 (' + pct(sum(1, 1) / sum(1, 0)) + ')'), s);
});
check('the goal is judged at +2 on the latest month that reached it, not on a young month', () => {
  const s = R.headline[1], g = sum(2, 3) / sum(2, 0);
  assert.ok(s.includes('latest month to reach that mark, Jul 2026'), s);
  assert.ok(s.includes('finished at ' + pct(g)), s);
  assert.ok(s.includes((Math.abs(g - 0.98) * 100).toFixed(1) + ' points ' + (g > 0.98 ? 'over' : 'under')), s);
});
check('the count of properties under goal uses only properties billing over the floor', () => {
  // judged (billing >= $5k and a month at +2): Bad Hill, Ocean View, Few Large, Good, Evil. Under at +2: Bad Hill 84%, Few Large 97.5%, Evil 94%.
  assert.ok(R.headline[2].includes('3 of 5 properties billing $5k or more finished under 98% at +2 months'), R.headline[2]);
});

console.log('\nThe ranking');
check('lowest share collected to date first; the floor and a property at goal are left out', () => {
  assert.deepStrictEqual(R.struggling.map(p => p.name), ['Bad Hill', 'Ocean View', EVIL, 'Few Large']);
  assert.deepStrictEqual(R.struggling.map(p => p.rank), [1, 2, 3, 4]);
  assert.strictEqual(R.strugglingTotal, 4);
});
check('a property at goal everywhere is not listed even though it has a credit row', () => {
  assert.ok(!R.struggling.some(p => p.name === 'Good'));
});
check('to-date rate and dollars still owed are the three-month sums', () => {
  const b = R.struggling[0];
  assert.ok(Math.abs(b.rate.now - 227000 / 300000) < 1e-9, String(b.rate.now));
  assert.strictEqual(b.owed, 73000);
  assert.ok(b.headline.includes('75.7% of $300,000 collected to date, $73,000 still owed'), b.headline);
  assert.strictEqual(b.region, 'Northern Ohio');
  assert.strictEqual(R.struggling[1].region, 'Central Ohio');
});
check('each mark counts only the months that reached it, and says how many', () => {
  const b = R.struggling[0];
  assert.ok(Math.abs(b.rate.m0 - 210000 / 300000) < 1e-9);   // all three months
  assert.ok(Math.abs(b.rate.m1 - 157000 / 200000) < 1e-9);   // Aug and Jul
  assert.ok(Math.abs(b.rate.m2 - 84000 / 100000) < 1e-9);    // Jul only
  assert.ok(b.ratesText.includes('By month end 70.0% (3 of 3 months)') && b.ratesText.includes('by +1 month 78.5% (2 of 3 months)') && b.ratesText.includes('by +2 months 84.0% (1 of 3 months)'), b.ratesText);
});
check('a top-N cut says how many there are in all', () => {
  const r = plain(build(Object.assign({}, INPUT, { top: 2 })));
  assert.strictEqual(r.struggling.length, 2);
  assert.strictEqual(r.strugglingTotal, 4);
  assert.ok(card(r).includes('Showing 2 of 4'));
});

console.log('\nWhat drives it, and who to pursue');
check('many small balances: count, median and the biggest one as a share', () => {
  const d = R.struggling[0].drivers.find(x => x.key === 'spread');
  assert.ok(d, JSON.stringify(R.struggling[0].drivers));
  assert.ok(d.text.includes('11 tenants, median $1,000') && d.text.includes('biggest ($1,500) is only 13% of the total'), d.text);
});
check('a few large balances: two tenants, and three-of-four holding nearly all of it', () => {
  assert.ok(R.struggling[1].drivers[0].key === 'concentrated' && R.struggling[1].drivers[0].text.includes('2 tenants hold all $15,000'), R.struggling[1].drivers[0].text);
  const f = R.struggling[3].drivers[0];
  assert.ok(f.key === 'concentrated' && f.text.includes('the three biggest hold 97% of the $11,900 owed'), f.text);
});
check('does not catch up: month end barely moves by +2', () => {
  const d = R.struggling[0].drivers.find(x => x.key === 'stalled');
  assert.ok(d && /Does not catch up: 82\.[45]% by month end and only 85\.5% by \+2 months across the 2 months that reached \+2/.test(d.text), JSON.stringify(R.struggling[0].drivers));
});
check('slow, then pays: low at month end, at goal by +2', () => {
  const d = R.struggling[1].drivers.find(x => x.key === 'slow');
  assert.ok(d && /Slow, then pays: 70\.[05]% by month end but 99\.[0-9]% by \+2 months/.test(d.text), JSON.stringify(R.struggling[1].drivers));
});
check('getting worse vs steady, from the month-end series, with the numbers listed', () => {
  const w = R.struggling[0].drivers.find(x => x.key === 'worse');
  assert.ok(w && w.text.includes('fell 15.0 points') && w.text.includes('Sep 2026 60.0%, Aug 2026 70.0%, Jul 2026 80.0%'), JSON.stringify(R.struggling[0].drivers));
  assert.ok(R.struggling[1].drivers.some(x => x.key === 'steady'), JSON.stringify(R.struggling[1].drivers));
});
check('improving is called improving', () => {
  const props = JSON.parse(JSON.stringify(PROPS));
  props['Bad Hill'].rows[0][1] = 95000; props['Bad Hill'].rows[0][4] = 95000;   // Sep month end jumps from 60% to 95%
  const r = plain(build(Object.assign({}, INPUT, { months: monthsFrom(props) })));
  const bh = r.struggling.find(p => p.name === 'Bad Hill');
  assert.ok(bh.drivers.some(x => x.key === 'better' && x.text.includes('rose')), JSON.stringify(bh && bh.drivers));
});
check('the biggest balances come first, ties by name, three at most', () => {
  assert.deepStrictEqual(R.struggling[0].pursue.map(t => t.tenant), ['Big Debtor', 'Tenant A', 'Tenant B']);
  assert.deepStrictEqual(R.struggling[0].pursue.map(t => t.amount), [1500, 1000, 1000]);
  assert.strictEqual(R.struggling[0].pursue[0].unit, '200');
});
check('share of units when the unit count is known, and not invented when it is not', () => {
  assert.ok(R.struggling[0].tenantText.includes('11 delinquent tenants owe $11,500, 10% of its 110 units'), R.struggling[0].tenantText);
  assert.ok(R.struggling[2].tenantText.includes('1 delinquent tenant owes $2,500.') && !R.struggling[2].tenantText.includes('units'), R.struggling[2].tenantText);
});
check('a credit row is never a delinquent tenant', () => {
  const good = plain(build(Object.assign({}, INPUT, { floor: 0, goal: 0.9999, top: 20 }))).struggling.find(p => p.name === 'Good');
  assert.ok(good && good.tenants.count === 0 && good.tenantText.includes('No current tenant is 5+ days past due'), JSON.stringify(good && good.tenants));
});

console.log('\nRegions');
check('Central Ohio reads first, then Northern Ohio, each with its numbers and weakest entity', () => {
  assert.deepStrictEqual(R.regions.map(r => r.region), ['Central Ohio', 'Northern Ohio']);
  const central = R.regions[0].line, north = R.regions[1].line;
  assert.ok(central.startsWith('Central Ohio: ') && central.includes('of $300,000 collected to date') && central.includes('Weakest entity: Birchwood Commons at 89.7%'), central);
  assert.ok(central.includes('2 delinquent tenants owe $15,000 (1% of 200 units)'), central);
  assert.ok(north.startsWith('Northern Ohio: ') && north.includes('Weakest entity: Willow Creek at 75.7%'), north);
  assert.ok(north.includes('3 of 4 properties finished under goal at +2 months'), north);
});

console.log('\nNo undefined, no NaN, nothing raw');
const EDGES = {
  'the full data': INPUT,
  'no months at all': Object.assign({}, INPUT, { months: [] }),
  'no input at all': undefined,
  'tenant list not loaded': Object.assign({}, INPUT, { tenants: null }),
  'one month only': Object.assign({}, INPUT, { months: monthsFrom(PROPS, 1) }),
  'two months, none at +2': Object.assign({}, INPUT, { months: monthsFrom(PROPS, 2) }),
  'nothing billed': Object.assign({}, INPUT, { months: monthsFrom({ Z: { entity: 'The Alder', rows: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] } }) }),
  'no unit counts, no as-of': Object.assign({}, INPUT, { units: {}, asOf: '', refreshedAt: '' }),
  'a month that errored': Object.assign({}, INPUT, { months: [{ key: 'x', label: 'Bad', error: 'RM down' }].concat(monthsFrom(PROPS)) }),
};
Object.keys(EDGES).forEach(name => {
  check(name, () => {
    const m = plain(build(EDGES[name]));
    const text = JSON.stringify(m) + card(m) + card(m, { folded: true }) + print(m, 'Oct 22, 2026');
    ['undefined', 'NaN', 'Infinity', '[object'].forEach(bad => assert.ok(!text.includes(bad), 'found "' + bad + '" in: ' + text.slice(Math.max(0, text.indexOf(bad) - 80), text.indexOf(bad) + 80)));
    assert.ok(m.headline.length >= 1);
  });
});
check('no months says so plainly and builds no ranking', () => {
  const m = plain(build({ months: [] }));
  assert.ok(m.empty && m.struggling.length === 0 && /No closed billing month/.test(m.headline[0]));
});
check('with the tenant list locked, the report says so instead of showing zero tenants', () => {
  const m = plain(build(EDGES['tenant list not loaded']));
  assert.ok(m.struggling.every(p => /tenant list is not loaded/.test(p.tenantText)) && m.struggling.every(p => p.pursue.length === 0));
  assert.ok(m.notes.some(n => /locked or still loading/.test(n)));
});
check('a month that errored is skipped, not read', () => {
  const m = plain(build(EDGES['a month that errored']));
  assert.ok(m.headline[0].startsWith('Sep 2026:'), m.headline[0]);
});
check('every interpolated string is escaped in the page card and the PDF', () => {
  for (const html of [card(R), print(R, 'Oct 22, 2026')]) {
    assert.ok(!html.includes('<b>Evil') && !html.includes('<img') && !html.includes("O'Brien") && !html.includes('4<B>'), 'raw markup got through');
    assert.ok(html.includes('&lt;b&gt;Evil &amp; &quot;Co&quot;&lt;/b&gt;'), 'the escaped property name is missing');
    assert.ok(html.includes('O&#39;Brien &lt;img src=x onerror=alert(1)&gt;') && html.includes('(unit 4&lt;B&gt;)'), 'the escaped tenant is missing');
  }
});

console.log('\nThe PDF and the card');
check('the PDF carries the as-of date, both sources, the estimate stamp, and no buttons', () => {
  const h = print(R, 'Oct 22, 2026, 9:00 AM');
  assert.ok(h.startsWith('<!doctype html>') && h.includes('@page') && h.includes('page-break-inside:avoid'));
  assert.ok(h.includes('tenants as of 2026-10-21') && h.includes('Prepared Oct 22, 2026, 9:00 AM'));
  assert.ok(h.includes('Rent Manager report 30 (Charge Detail)') && h.includes('report 85 (Delinquency)'));
  assert.ok(/Cedar Ridge estimate/.test(h) && !h.includes('onclick'));
  ['Struggling most with collecting rent', 'By region', 'Pursue first.', 'What drives it.'].forEach(t => assert.ok(h.includes(t), t));
});
check('the card has the PDF button and a fold that hides the detail but keeps the headline', () => {
  const open = card(R), folded = card(R, { folded: true });
  assert.ok(open.includes('⎙ PDF report') && open.includes('dqrPrint()') && open.includes('Cedar Ridge estimates'));
  assert.ok(open.includes('Pursue first.') && !folded.includes('Pursue first.') && folded.includes('Sep 2026: we billed'));
});

console.log('\nThe page wires it');
check('the report sits above the controls and the flags, and dqpRender repaints it', () => {
  const r = PAGE.indexOf('id="dqr-report"'), c = PAGE.indexOf('id="dqp-controls"'), f = PAGE.indexOf('id="dqp-flags"');
  assert.ok(r > 0 && r < c && c < f, 'order is report, controls, flags');
  const render = PAGE.slice(PAGE.indexOf('function dqpRender() {'));
  assert.ok(render.slice(0, 400).includes('dqrRender()'), 'dqpRender must call dqrRender first');
});
check('the print button opens the window inside the click, then prints', () => {
  const p = PAGE.slice(PAGE.indexOf('window.dqrPrint = function'));
  const body = p.slice(0, p.indexOf('};') + 2);
  assert.ok(body.indexOf('window.open') > 0 && body.indexOf('window.open') < body.indexOf('dqrPrintHtml'), 'window.open must come before the document is built');
  assert.ok(body.includes('w.print()') && body.includes('w.document.write(doc)'));
});

console.log('\nThe workflow');
check('package.json and checks.yml both run this check', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['check:delinquency-report'], 'node scripts/checkDelinquencyReport.js');
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'checks.yml'), 'utf8');
  assert.ok(yml.includes('npm run check:delinquency-report'), 'checks.yml does not run it');
});
check('no step name in checks.yml has an unquoted ": " or " #" (GitHub rejects the whole file)', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'checks.yml'), 'utf8');
  const bad = yml.split(/\r?\n/).map((l, i) => ({ l, n: i + 1 })).filter(x => {
    const m = /^\s*-?\s*name:\s*(.*)$/.exec(x.l);
    if (!m) return false;
    const v = m[1].trim();
    return !/^["']/.test(v) && (v.includes(': ') || v.includes(' #'));
  });
  assert.strictEqual(bad.length, 0, bad.map(x => 'line ' + x.n + ': ' + x.l.trim()).join(' | '));
});

console.log(failures ? '\n' + failures + ' check(s) failed.' : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
