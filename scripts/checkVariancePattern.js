// "The pattern this month" — the card under the Top 5 on the Variances dashboard.
//
// Decided with the owner (2026-10-21): three groupings of the scoped, owned
// variance flags are scored on every render —
//
//   line      the same P&L line at several buildings
//   building  one building on several lines
//   month     one month across the portfolio
//
// — and only the ONE with the most dollars (Σ |impact|) is featured, in plain
// English, with a button into the board showing exactly those rows. A grouping
// needs ≥3 flags. Nothing qualifies → null → no card.
//
// What is worth protecting:
//   • the biggest-dollar axis wins, whichever axis it is;
//   • a grouping of two is not a pattern;
//   • a varGroup card (one jump across an entity's buildings, already grouped by
//     the scan) is counted by its BUILDINGS, and a member that also shows up on
//     its own is not counted twice — "6 buildings" means six buildings;
//   • the ids handed to the board are its rows (the varGroup's id, not the
//     members', which are not rows).
//
// The page is a single HTML file, so varPatternPick (and the page's own
// varFlagId, so ids are built exactly the way the board builds them) are lifted
// out of it and run in a sandbox with stubbed flags.
//
// Run: npm run check:variance-pattern

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let failures = 0;
function check(what, fn) {
  try { fn(); console.log('  ok   ' + what); }
  catch (err) { failures++; console.log('  FAIL ' + what + '\n       ' + err.message); }
}

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function lift(name) {
  const start = PAGE.indexOf('function ' + name + '(');
  assert.ok(start > 0, `could not find function ${name} in public/index.html`);
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
  throw new Error(`could not find the end of ${name}`);
}

// fmtExact is the page's whole-dollar formatter; stubbed to the same output.
function sandbox() {
  const ctx = { fmtExact: n => '$' + Math.round(n).toLocaleString('en-US') };
  vm.createContext(ctx);
  vm.runInContext(lift('varFlagId'), ctx);
  vm.runInContext(lift('varPatternPick'), ctx);
  return ctx;
}

const MONTHS = ['Jan 26', 'Feb 26', 'Mar 26', 'Apr 26', 'May 26', 'Jun 26', 'Jul 26', 'Aug 26', 'Sep 26'];
// One property-level variance flag.
const flag = (prop, line, month, impact, entity = 'Cedar Ridge') => ({
  category: 'variance', reason: 'mom', key: line.toLowerCase().replace(/\W+/g, '_'), label: line,
  scope: { key: 'prop:' + prop.toLowerCase().replace(/\W+/g, '-'), label: prop, type: 'Property', entity },
  monthLabel: month, giMonth: MONTHS.indexOf(month), impact,
});
// A varGroup card built the way varGroupJumpFlags builds one: members are { f },
// the impact is the sum of theirs, and the scope key is the group's.
const varGroup = (members) => {
  const f0 = members[0];
  return {
    category: 'variance', reason: 'varGroup', key: f0.key, label: f0.label,
    scope: { key: `group:${f0.key}:${f0.monthLabel}:${f0.scope.entity}`, label: `${members.length} properties`, type: 'Property', entity: f0.scope.entity },
    monthLabel: f0.monthLabel, giMonth: f0.giMonth,
    impact: members.reduce((t, f) => t + Math.abs(f.impact), 0),
    members: members.map(f => ({ f })),
  };
};

console.log('\nThe biggest-dollar grouping is the one featured');

check('same line wins when its buildings carry the most money', () => {
  const ctx = sandbox();
  const flags = [
    // Water & Sewer, Aug, four Cedar Ridge buildings: $400K
    flag('2301 Willow Creek Rd', 'Water & Sewer', 'Aug 26', 100000),
    flag('15 Summit Avenue', 'Water & Sewer', 'Aug 26', 100000),
    flag('108 60th Street', 'Water & Sewer', 'Aug 26', 100000),
    flag('Washington', 'Water & Sewer', 'Aug 26', 100000),
    // a building with three small lines in Jul: $30K
    flag('Birchwood Commons', 'Insurance', 'Jul 26', 10000, 'Birchwood Commons'),
    flag('Birchwood Commons', 'Payroll', 'Jul 26', 10000, 'Birchwood Commons'),
    flag('Birchwood Commons', 'Repairs', 'Jul 26', 10000, 'Birchwood Commons'),
  ];
  const p = ctx.varPatternPick(flags);
  assert.ok(p, 'expected a pattern');
  assert.strictEqual(p.axis, 'line');
  assert.strictEqual(p.impact, 400000);
  assert.strictEqual(p.n, 4);
  assert.strictEqual(p.headline, 'Water & Sewer moved at 4 Cedar Ridge buildings in Aug');
  assert.ok(/^\$400,000\/yr at stake · /.test(p.sub), 'sub should lead with the money: ' + p.sub);
  assert.ok(/one billing change, not four problems/.test(p.reading), 'same line + entity + month reads as one change: ' + p.reading);
  assert.strictEqual(p.ids.length, 4, 'four board rows');
});

check('same building wins when one property carries the most money', () => {
  const ctx = sandbox();
  const flags = [
    flag('2301 Willow Creek Rd', 'Insurance', 'Aug 26', 90000),
    flag('2301 Willow Creek Rd', 'Payroll', 'Aug 26', 90000),
    flag('2301 Willow Creek Rd', 'Repairs', 'Aug 26', 90000),
    flag('2301 Willow Creek Rd', 'Gas', 'Aug 26', 90000),
    flag('2301 Willow Creek Rd', 'Electric', 'Aug 26', 90000),
    // same line elsewhere, smaller
    flag('Birchwood Commons', 'Water & Sewer', 'Jul 26', 20000, 'Birchwood Commons'),
    flag('Willow Creek', 'Water & Sewer', 'Jun 26', 20000, 'Willow Creek'),
    flag('Washington', 'Water & Sewer', 'May 26', 20000),
  ];
  const p = ctx.varPatternPick(flags);
  assert.strictEqual(p.axis, 'building');
  assert.strictEqual(p.headline, '2301 Willow Creek Rd: 5 lines jumped in Aug');
  assert.strictEqual(p.impact, 450000);
  assert.ok(/look at that property's month first/.test(p.reading), p.reading);
});

check('same month wins when one month spans the most money across properties', () => {
  const ctx = sandbox();
  // Every flag is a different line at a different property, all in August — so
  // no line or building grouping qualifies, and the month is the pattern.
  const flags = ['A', 'B', 'C', 'D', 'E'].map((p, i) => flag('Prop ' + p, 'Line ' + i, 'Aug 26', 50000));
  flags.push(flag('Prop F', 'Line 9', 'Jul 26', 999999));   // big, but alone in its month
  const p = ctx.varPatternPick(flags);
  assert.strictEqual(p.axis, 'month');
  assert.strictEqual(p.headline, 'August: 5 variances across 5 properties');
  assert.strictEqual(p.impact, 250000);
  assert.ok(/posting batch landed late/.test(p.reading), p.reading);
  assert.strictEqual(p.ids.length, 5);
});

check('dollars decide, not counts: three big flags beat six small ones', () => {
  const ctx = sandbox();
  const flags = [
    ...['A', 'B', 'C', 'D', 'E', 'F'].map(p => flag('Prop ' + p, 'Gas', 'Jun 26', 1000)),
    flag('Prop Z', 'Taxes', 'Sep 26', 80000), flag('Prop Z', 'Insurance', 'Sep 26', 80000), flag('Prop Z', 'Payroll', 'Sep 26', 80000),
  ];
  const p = ctx.varPatternPick(flags);
  assert.strictEqual(p.axis, 'building', `expected the $240K building, got ${p.axis} ($${p.impact})`);
});

console.log('\nA grouping of two is not a pattern');

check('two flags on a line, two at a building, two in a month: no card', () => {
  const ctx = sandbox();
  const flags = [
    flag('Prop A', 'Gas', 'Jun 26', 50000), flag('Prop B', 'Gas', 'Jun 26', 50000),
    flag('Prop C', 'Taxes', 'Aug 26', 50000), flag('Prop C', 'Payroll', 'Sep 26', 50000),
  ];
  assert.strictEqual(ctx.varPatternPick(flags), null);
});

check('fewer than three flags at all is null, and so is an empty list', () => {
  const ctx = sandbox();
  assert.strictEqual(ctx.varPatternPick([flag('Prop A', 'Gas', 'Jun 26', 50000), flag('Prop B', 'Gas', 'Jun 26', 50000)]), null);
  assert.strictEqual(ctx.varPatternPick([]), null);
  assert.strictEqual(ctx.varPatternPick(null), null);
});

check('only variances count: three zeros on one line are not this card', () => {
  const ctx = sandbox();
  const zs = ['A', 'B', 'C'].map(p => Object.assign(flag('Prop ' + p, 'Gas', 'Jun 26', 50000), { category: 'zero', reason: 'zero' }));
  assert.strictEqual(ctx.varPatternPick(zs), null);
});

console.log('\nA varGroup is counted by its buildings, once');

check('a varGroup of three is a qualifying line pattern on its own, with one board row', () => {
  const ctx = sandbox();
  const g = varGroup(['2301 Willow Creek Rd', '15 Summit Avenue', 'Washington'].map(p => flag(p, 'Water & Sewer', 'Aug 26', 30000)));
  const p = ctx.varPatternPick([g]);
  assert.ok(p, 'a varGroup of three buildings should qualify');
  assert.strictEqual(p.axis, 'line');
  assert.strictEqual(p.n, 3, 'three buildings, not one card');
  assert.strictEqual(p.impact, 90000, 'the members, summed once');
  assert.deepStrictEqual(Array.from(p.ids), [ctx.varFlagId(g)], 'the board row is the group card');
  assert.strictEqual(p.headline, 'Water & Sewer moved at 3 Cedar Ridge buildings in Aug');
});

check('a varGroup listed beside its own members is not double counted', () => {
  const ctx = sandbox();
  const members = ['2301 Willow Creek Rd', '15 Summit Avenue', 'Washington'].map(p => flag(p, 'Water & Sewer', 'Aug 26', 30000));
  const g = varGroup(members);
  // Both orders: the group first, and the members first.
  [[g, ...members], [...members, g]].forEach(list => {
    const p = ctx.varPatternPick(list);
    assert.strictEqual(p.n, 3, `expected 3 buildings, got ${p.n}`);
    assert.strictEqual(p.impact, 90000, `expected $90,000 once, got ${p.impact}`);
    assert.deepStrictEqual(Array.from(p.ids), [ctx.varFlagId(g)], 'members fold into the group row');
  });
});

check('a varGroup plus a fourth building on the same line counts four buildings, two rows', () => {
  const ctx = sandbox();
  const g = varGroup(['2301 Willow Creek Rd', '15 Summit Avenue', 'Washington'].map(p => flag(p, 'Water & Sewer', 'Aug 26', 30000)));
  const lone = flag('Birchwood Commons', 'Water & Sewer', 'Aug 26', 30000, 'Birchwood Commons');
  const p = ctx.varPatternPick([g, lone]);
  assert.strictEqual(p.n, 4);
  assert.strictEqual(p.ids.length, 2);
  assert.strictEqual(p.headline, 'Water & Sewer moved at 4 buildings in Aug', 'two entities: no entity name');
  assert.ok(!/one billing change/.test(p.reading), 'two entities is not "one billing change"');
});

console.log('\nThe page wires it the way it was decided');

check('the card is last in the left column: Top 5, then Going well, then the pattern', () => {
  assert.ok(PAGE.includes('${topCard}${goodCard}${patternCard}'), 'left column order changed');
});
check('no qualifying grouping → no card (empty string, not an empty card)', () => {
  assert.ok(/const patternCard = pat \? `/.test(PAGE) && /<\/section>` : '';/.test(PAGE));
});
check('the board honours the exact set, and every reset that clears the query clears it too', () => {
  assert.ok(/function varBoardFilter\(f\) \{\s*return varMatchesScope\(f\) && varMatchesQuery\(f\) && \(!_varSetFilter/.test(PAGE), 'varBoardFilter ignores _varSetFilter');
  const clears = (PAGE.match(/(?<!let )_varQuery = '';/g) || []).length;   // not the declaration
  const setClears = (PAGE.match(/_varQuery = '';\s*\n\s*_varSetFilter = null;/g) || []).length;
  // varOpenPattern clears the query and then SETS the filter — the one exception.
  assert.strictEqual(setClears, clears - 1, `${clears} query clears, ${setClears} followed by a set clear`);
  assert.ok(/_varQuery = it\.q \|\| '';\s*\n\s*_varSetFilter = null;/.test(PAGE), 'varDigestJump must clear the set');
  assert.ok(PAGE.includes('class="vt-setline"'), 'the board must say when the set is on');
});

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll pattern checks passed.');
process.exit(failures ? 1 : 0);
