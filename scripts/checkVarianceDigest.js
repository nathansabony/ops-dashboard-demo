// "Worth a look" — the digest of grouped findings on the Variances tab.
//
// It began (2026-10-21, morning) in the right half of the board's opening bar:
// the bar's middle was a long white gap, and the findings that tell you WHICH
// bucket to open were inside the buckets, where nobody looks until they already
// know. Later the same day the tab gained a dashboard it opens on, and the zero
// and negative findings moved onto its Posting problems card (varHomeHtml); the
// bar lost the panel (varDigestHtml is gone). The function under test —
// varDigestItems — is unchanged, and so is the index hand-off to varDigestJump.
//
// The thing worth protecting here is that the digest invents nothing. Every line
// is a flag the scan already grouped —
//
//   zeroGroup  one line at $0 across several properties (one missing entry)
//   zeroRun    one property blank on one line for months
//   varGroup   one jump across an entity's buildings at once
//
// — or, for negatives, a count of flags that already exist. If a future change
// starts computing a reading here instead of rolling up an existing one, these
// tests are the place that should fail, because a number on the landing screen
// that no flag stands behind is exactly the thing the tab must never show.
//
// Two behaviours matter as much as the content:
//
//   It counts across EVERY bucket, not the open one. The whole value is being
//   told "the zeros are one missing entry" while you are reading variances.
//
//   Queries reach the click handler by INDEX, never interpolated into the
//   onclick attribute — a property called "the regional manager's" would otherwise break out
//   of it. That one is asserted against the page text, not the lifted function.
//
// The page is a single HTML file, so the function under test is lifted out of it
// and run in a sandbox with stubbed flags.
//
// Run: npm run check:variance-digest

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

// varOwnsFlag (scope ownership) and fmtExact (money) are the page's own and have
// their own dependencies; the digest's logic is what is under test, so they are
// stubbed. Both are asserted to still exist, so a rename cannot pass silently.
function sandbox() {
  const ctx = {
    varOwnsFlag: () => true,
    fmtExact: n => '$' + Math.round(n).toLocaleString('en-US'),
    _varCategory: 'variance',
  };
  vm.createContext(ctx);
  vm.runInContext(lift('varDigestItems'), ctx);
  return ctx;
}

const zeroGroup = (label, props, impact, monthLabel) => ({
  category: 'zero', reason: 'zeroGroup', key: label.toLowerCase(), label,
  scope: { label: `${props} properties`, type: 'Property' },
  members: Array(props).fill({}), impact, monthLabel,
});
const zeroRun = (prop, label, months, impact) => ({
  category: 'zero', reason: 'zeroRun', key: label.toLowerCase(), label,
  scope: { label: prop, type: 'Property' },
  zeroMonthLabels: Array.from({ length: months }, (_, i) => 'M' + i),
  monthLabel: `M0–M${months - 1}`, impact,
});
const varGroup = (label, props, entity, impact) => ({
  category: 'variance', reason: 'varGroup', key: label.toLowerCase(), label,
  scope: { label: `${props} properties`, type: 'Property', entity },
  members: Array(props).fill({}), impact, monthLabel: 'Sep 26',
});
const negative = (label, prop, impact) => ({
  category: 'negative', reason: 'negative', key: label.toLowerCase(), label,
  scope: { label: prop, type: 'Property' }, impact, monthLabel: 'Aug 26',
});

console.log('\nEvery line stands on a flag the scan already grouped');

check('a zeroGroup flag becomes one line naming the line item and the property count', () => {
  const ctx = sandbox();
  const out = ctx.varDigestItems([zeroGroup('Water & Sewer', 13, 84000, 'Jun–Jul 26')], []);
  assert.strictEqual(out.length, 1, 'expected exactly one finding');
  assert.strictEqual(out[0].head, 'Water & Sewer is $0 at 13 properties');
  assert.strictEqual(out[0].cat, 'zero', 'must point at the Zeroed Out bucket');
  assert.strictEqual(out[0].q, 'Water & Sewer', 'must filter to the line item');
  assert.ok(/\$84,000/.test(out[0].sub), 'the reason should carry the money: ' + out[0].sub);
  assert.ok(/Jun–Jul 26/.test(out[0].sub), 'the reason should carry the months');
});

check('a single-property zeroGroup is not a cross-property pattern, so it is left out', () => {
  const ctx = sandbox();
  assert.strictEqual(ctx.varDigestItems([zeroGroup('Taxes', 1, 9000, 'Jul 26')], []).length, 0);
});

check('a property blank for three months or more becomes a line; two months does not', () => {
  const ctx = sandbox();
  const three = ctx.varDigestItems([zeroRun('7945 Blvd East', 'Water & Sewer', 4, 12400)], []);
  assert.strictEqual(three.length, 1, 'four blank months should surface');
  assert.strictEqual(three[0].head, '7945 Blvd East: 4 blank Water & Sewer months');
  assert.strictEqual(three[0].q, '7945 Blvd East', 'must filter to the property, not the line');
  assert.strictEqual(ctx.varDigestItems([zeroRun('15 Summit Avenue', 'Taxes', 2, 5000)], []).length, 0,
    'two blank months is within normal and must not surface');
});

check('a jump across an entity\'s buildings becomes a line pointing at Variances', () => {
  const ctx = sandbox();
  const out = ctx.varDigestItems([varGroup('Management Wages', 5, 'Cedar Ridge', 60000)], []);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].head, 'Management Wages moved at 5 Cedar Ridge properties at once');
  assert.strictEqual(out[0].cat, 'variance');
});

check('a varGroup with no entity name does not leave a double space in the headline', () => {
  const ctx = sandbox();
  const out = ctx.varDigestItems([varGroup('Repairs', 4, '', 30000)], []);
  assert.strictEqual(out[0].head, 'Repairs moved at 4 properties at once',
    'got: ' + JSON.stringify(out[0].head));
});

console.log('\nNegatives are per-property flags, so the pattern is counted here');

check('the same line negative at three properties surfaces once, with the properties summed', () => {
  const ctx = sandbox();
  const out = ctx.varDigestItems([
    negative('Rent Income', 'A', 1000), negative('Rent Income', 'B', 2000), negative('Rent Income', 'C', 3000),
  ], []);
  assert.strictEqual(out.length, 1, 'three properties, one finding');
  assert.strictEqual(out[0].head, 'Rent Income posted negative at 3 properties');
  assert.ok(/\$6,000/.test(out[0].sub), 'impact should sum the three: ' + out[0].sub);
  assert.strictEqual(out[0].cat, 'negative');
});

check('two properties is not yet a pattern', () => {
  const ctx = sandbox();
  assert.strictEqual(ctx.varDigestItems([negative('Rent Income', 'A', 1000), negative('Rent Income', 'B', 2000)], []).length, 0);
});

check('the same property twice on one line counts as one property, not two', () => {
  const ctx = sandbox();
  const out = ctx.varDigestItems([
    negative('Rent Income', 'A', 1000), negative('Rent Income', 'A', 1000), negative('Rent Income', 'B', 2000),
  ], []);
  assert.strictEqual(out.length, 0, 'two distinct properties should not surface');
});

console.log('\nIt reads every bucket, not the open one');

check('a zero finding surfaces while the open bucket is Variances', () => {
  const ctx = sandbox();                       // _varCategory is 'variance'
  const out = ctx.varDigestItems([zeroGroup('Taxes', 28, 400000, 'Jul–Sep 26')], []);
  assert.strictEqual(out.length, 1, 'the digest must not be limited to the open bucket');
  assert.strictEqual(out[0].cat, 'zero');
});

console.log('\nRanking, the cap, and the roll-up note');

check('findings are ordered by money at stake, biggest first', () => {
  const ctx = sandbox();
  const out = ctx.varDigestItems([
    zeroGroup('Small', 3, 1000, 'Jul 26'),
    zeroGroup('Huge', 9, 900000, 'Jul 26'),
    zeroGroup('Middle', 4, 50000, 'Jul 26'),
  ], []);
  assert.strictEqual(out.map(i => i.head.split(' ')[0]).join(' > '), 'Huge > Middle > Small');
});

check('at most four findings are shown', () => {
  const ctx = sandbox();
  const many = Array.from({ length: 9 }, (_, i) => zeroGroup('Line' + i, 3, (i + 1) * 1000, 'Jul 26'));
  assert.strictEqual(ctx.varDigestItems(many, []).length, 4);
});

check('the roll-up note takes a spare slot and is not clickable', () => {
  const ctx = sandbox();
  const out = ctx.varDigestItems([zeroGroup('Water & Sewer', 3, 5000, 'Jul 26')], [{}, {}, {}]);
  assert.strictEqual(out.length, 2, 'one finding plus the note');
  const note = out[1];
  assert.strictEqual(note.head, '3 roll-ups not counted');
  assert.strictEqual(note.cat, null, 'the note must not be a link — there is nothing to filter to');
});

check('one roll-up is singular', () => {
  const ctx = sandbox();
  const out = ctx.varDigestItems([], [{}]);
  assert.strictEqual(out[0].head, '1 roll-up not counted');
});

check('with four findings the roll-up note is dropped rather than making a fifth line', () => {
  const ctx = sandbox();
  const many = Array.from({ length: 4 }, (_, i) => zeroGroup('Line' + i, 3, (i + 1) * 1000, 'Jul 26'));
  assert.strictEqual(ctx.varDigestItems(many, [{}, {}]).length, 4);
});

check('no patterns and no roll-ups is an empty digest, not a fabricated line', () => {
  const ctx = sandbox();
  assert.strictEqual(ctx.varDigestItems([], []).length, 0);
});

check('an ungrouped single-property zero flag is not a finding on its own', () => {
  const ctx = sandbox();
  const lone = { category: 'zero', reason: 'zero', key: 'taxes', label: 'Taxes',
                 scope: { label: 'Summit Lofts', type: 'Property' }, impact: 5000, monthLabel: 'Jul 26' };
  assert.strictEqual(ctx.varDigestItems([lone], []).length, 0,
    'only the grouped readings (zeroGroup / zeroRun) are patterns');
});

console.log('\nThe wiring in the page');

check('the click handler is passed an index, never an interpolated query string', () => {
  assert.ok(/varDigestJump\(\$\{i\}\)/.test(PAGE),
    'the onclick must pass the array index');
  assert.ok(!/varDigestJump\([^)]*it\.q/.test(PAGE),
    "a query interpolated into the onclick would break on a property named \"the regional manager's\"");
});

check('varDigestJump keeps the query that varSetCategory would have cleared', () => {
  const start = PAGE.indexOf('window.varDigestJump');
  assert.ok(start > 0, 'varDigestJump is missing from the page');
  const body = PAGE.slice(start, start + 900);
  assert.ok(/_varQuery = it\.q/.test(body), 'it must set the query from the finding');
  assert.ok(/_varCategory = it\.cat/.test(body), 'it must switch the bucket');
  assert.ok(/_varHome = false/.test(body), 'it is a way into the board, so it must leave the dashboard');
});

check('the digest is rendered from the scoped list of every bucket', () => {
  assert.ok(/_varDigest = varDigestItems\(scopedFlags, ctxAll\)/.test(PAGE),
    'the dashboard must pass scopedFlags (all buckets), not the active bucket\'s owned list');
});

check('the dashboard draws the zero and negative findings and leaves the rest to the Top 5', () => {
  const start = PAGE.indexOf('function varHomeHtml(');
  assert.ok(start > 0, 'varHomeHtml is missing from the page');
  const body = PAGE.slice(start, PAGE.indexOf('function renderFlaggedSummary()', start));
  assert.ok(/it\.cat === 'zero' \|\| it\.cat === 'negative'/.test(body), 'only the posting-problem findings belong on that card');
  assert.ok(/varDigestJump\(\$\{i\}\)/.test(body), 'the card must hand the finding over by index');
});

check('the functions the digest leans on still exist in the page', () => {
  assert.ok(/function varOwnsFlag\(/.test(PAGE), 'varOwnsFlag was renamed or removed');
  assert.ok(/function varGroupZeroFlags\(/.test(PAGE), 'the zeroGroup reading the digest rolls up is gone');
  assert.ok(/function varGroupJumpFlags\(/.test(PAGE), 'the varGroup reading the digest rolls up is gone');
  assert.ok(/reason: 'zeroRun'/.test(PAGE), 'the zeroRun reading the digest rolls up is gone');
});

check('the bar is two columns: everything that steers, then the digest', () => {
  assert.ok(/\.vt-topbar\{display:grid;grid-template-columns:minmax\(0,max-content\) minmax\(0,1fr\);/.test(PAGE),
    'the steering column sizes to content and the side column takes the rest');
  assert.ok(/\.vt-tb-side\{grid-column:2;/.test(PAGE),
    'the digest and toolbar share the right column');
  assert.ok(/<div class="vt-tb-main">/.test(PAGE), 'the count, chips and tiers stack in one column');
});

check('the toolbar rides in the bar instead of costing a band of its own', () => {
  assert.ok(/_varToolsHtml = tools;/.test(PAGE), 'varBoardHtml must hand the toolbar over');
  assert.ok(/\$\{_varToolsHtml\}/.test(PAGE), 'the bar must paint it');
  assert.ok(!/return tools \+ `<div class="vt-inbox/.test(PAGE),
    'the toolbar must no longer be emitted above the list');
  // A wrapped toolbar in a ~240-550px column cost 23-40px and undid the saving.
  assert.ok(/\.vt-topbar \.vt-tools\{margin:0;flex-wrap:nowrap;\}/.test(PAGE),
    'the toolbar must shrink rather than wrap');
  assert.ok(/\.vt-topbar \.vt-tools \.vt-search\{flex:1 1 90px;min-width:0;\}/.test(PAGE),
    'the search box is what gives up width first');
});

check('the board is built before the bar, since the bar paints the toolbar', () => {
  const board = PAGE.indexOf('const boardHtml = varBoardHtml(');
  const bar = PAGE.indexOf('const strip = `<div class="vt-topbar">');
  assert.ok(board > 0 && bar > 0, 'both must exist');
  assert.ok(board < bar, 'varBoardHtml sets _varToolsHtml, so it has to run first');
});

console.log(failures ? `\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n` : '\n✓ all checks passed\n');
process.exit(failures ? 1 : 0);
