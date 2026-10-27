// The Entities board, and the two inputs that were skewing every grade.
//
// The board at the top of the Entities tab ranks all thirteen entities by the
// SAME model as the Overview report cards — rcScore, scTarget, SC_WEIGHTS. The
// point of one model rendered twice is that the two tabs can never disagree
// about an entity, so the first thing checked here is that the board did not
// quietly grow a model of its own.
//
// Then the two corrections made while building it, both of which were already
// skewing the shipped Overview cards:
//
//   DSCR carries the heaviest weight (25 of 100), and Willow Creek/2/3 have posted no
//   mortgage interest to GL 6230 since January 2026. A live $0 is the honest
//   number everywhere else, but fed to DSCR it understates debt service and
//   FLATTERS the grade — so the three entities whose debt data is broken scored
//   highest on the metric that counts most.
//
//   Occupancy carries 20, and came from MANUAL_OCCUPANCY_FACTS — hand-entered on
//   2026-07-20 — for every entity, including two small LLCs sitting at a flat
//   100% on 19 and 12 doors.
//
// Both are corrected at the input, never silently: scNotes names them on the
// card and stamps the debt figure as ours.
//
// The page is a single HTML file, so the functions under test are lifted out of
// it and run in a sandbox with stubbed data. That keeps these as real
// behavioural tests rather than a regex hunt, and it means a change to the
// logic has to keep passing them.
//
// Run: npm run check:entity-board

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

// ── Lift the functions under test out of the page ───────────────────────────
function lift(name) {
  const start = PAGE.indexOf('function ' + name + '(');
  assert.ok(start > 0, `could not find function ${name} in public/index.html`);
  // Walk braces from the first { after the signature to find the body's end.
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

const MONTHS = Array.from({ length: 30 }, (_, i) => 'M' + i);

function sandbox(over) {
  const ctx = {
    ovT12Range: () => ({ from: 18, to: 29 }),
    MONTHLY_DATA: { months: MONTHS },
    LIVE_MONTHLY: null,
    LIVE_DEBT_GAPS: null,
    LIVE_BYPROP: null,
    DATA: {},
    entPropLive: null,
    ...over,
  };
  vm.createContext(ctx);
  // The snapshot date the notes quote is a const beside the functions, lifted
  // from the page too so these tests assert the real date rather than a copy of
  // it that could drift.
  const asOf = PAGE.match(/const SC_MANUAL_OCC_AS_OF = '([^']+)';/);
  assert.ok(asOf, 'SC_MANUAL_OCC_AS_OF is missing from public/index.html');
  vm.runInContext(
    [`const SC_MANUAL_OCC_AS_OF = '${asOf[1]}';`,
     lift('scSumT12'), lift('scDebtGap'), lift('scDebtT12'),
     lift('scOccupancy'), lift('scNotes')].join('\n'), ctx);
  ctx.MANUAL_OCC_AS_OF = asOf[1];
  return ctx;
}

// A clean entity: live interest posted every month, live roster present.
const POSTED = { mortgage: Array(30).fill(1000), noi: Array(30).fill(5000) };
// A broken one: posted for a year, then nothing since.
const STOPPED = { mortgage: [...Array(24).fill(1000), ...Array(6).fill(0)], noi: Array(30).fill(5000) };

console.log('\nDebt service: an unposted month must not flatter DSCR');

check('with interest posting normally, DSCR reads the live GL figure', () => {
  const ctx = sandbox({
    LIVE_MONTHLY: { 'Maple Court': POSTED },
    MONTHLY_DATA: { months: MONTHS, 'Maple Court': { mortgage: Array(30).fill(9999) } },
    LIVE_DEBT_GAPS: [],
  });
  assert.strictEqual(ctx.scDebtT12('Maple Court', 0), 12000, 'should be 12 live months of $1,000');
});

check('where the gap detector fires, DSCR falls back to the verified figure', () => {
  const ctx = sandbox({
    LIVE_MONTHLY: { 'Willow Creek': STOPPED },
    MONTHLY_DATA: { months: MONTHS, 'Willow Creek': { mortgage: Array(30).fill(1200) } },
    LIVE_DEBT_GAPS: [{ entity: 'Willow Creek', missing: 6, of: 6, lastPosted: 'Jan 26' }],
  });
  // Live would be 6 x 1000 = 6,000 across the window; verified is 12 x 1,200.
  assert.strictEqual(ctx.scDebtT12('Willow Creek', 0), 14400, 'should use the verified series, not the $0 months');
});

check('the live figure would have been lower — which is the whole bug', () => {
  const live = sandbox({ LIVE_MONTHLY: { 'Willow Creek': STOPPED }, LIVE_DEBT_GAPS: [] });
  const fixed = sandbox({
    LIVE_MONTHLY: { 'Willow Creek': STOPPED },
    MONTHLY_DATA: { months: MONTHS, 'Willow Creek': { mortgage: Array(30).fill(1200) } },
    LIVE_DEBT_GAPS: [{ entity: 'Willow Creek', missing: 6, of: 6 }],
  });
  const understated = live.scDebtT12('Willow Creek', 0);
  const real = fixed.scDebtT12('Willow Creek', 0);
  assert.ok(understated < real,
    `the uncorrected figure (${understated}) must be lower than the verified one (${real}) — otherwise this check proves nothing`);
  // Less debt service = a higher DSCR = a better grade, off missing data.
  assert.ok(5000 * 12 / understated > 5000 * 12 / real, 'the gap inflates DSCR');
});

check('an entity nobody flagged is untouched, even with a zero month', () => {
  const ctx = sandbox({ LIVE_MONTHLY: { 'Birchwood Commons': STOPPED }, LIVE_DEBT_GAPS: [] });
  assert.strictEqual(ctx.scDebtT12('Birchwood Commons', 0), 6000, 'a $0 month is still reported as $0 when it is not a pattern');
});

check('a null LIVE_DEBT_GAPS (no live pull yet) does not throw', () => {
  const ctx = sandbox({ LIVE_MONTHLY: { 'Willow Creek': POSTED }, LIVE_DEBT_GAPS: null });
  assert.strictEqual(ctx.scDebtT12('Willow Creek', 0), 12000);
});

console.log('\nOccupancy: live roster first, and the manual snapshot says so');

check('the live per-property roster is preferred and is not marked manual', () => {
  const ctx = sandbox({
    DATA: { 'Cedar Ridge': { units: 100, occupied: 80, occupancy: 80 } },
    entPropLive: e => (e === 'Cedar Ridge' ? [{ total: 60, occupied: 57 }, { total: 40, occupied: 38 }] : null),
  });
  const o = ctx.scOccupancy('Cedar Ridge');
  assert.strictEqual(o.units, 100);
  assert.strictEqual(o.occupied, 95);
  assert.strictEqual(o.manual, false);
  assert.strictEqual(Math.round(o.pct), 95, 'should be the roster figure, not the 80% snapshot');
});

check('without a roster it falls back to the snapshot and marks it manual', () => {
  const ctx = sandbox({
    DATA: { 'Summit Lofts': { units: 12, occupied: 12, occupancy: 100 } },
    entPropLive: () => null,
  });
  const o = ctx.scOccupancy('Summit Lofts');
  assert.strictEqual(o.pct, 100);
  assert.strictEqual(o.manual, true, 'a hand-entered 100% must not look like a live result');
});

check('an entity with neither is null, not a zero that grades as a failure', () => {
  const ctx = sandbox({ DATA: { Ghost: {} }, entPropLive: () => null });
  assert.strictEqual(ctx.scOccupancy('Ghost'), null);
});

console.log('\nThe notes name every input that cannot carry a verdict');

check('an imputed debt figure is stamped as ours and names the gap', () => {
  const ctx = sandbox({
    DATA: { 'Willow Creek': { units: 207, occupied: 195, occupancy: 94.2 } },
    LIVE_MONTHLY: { 'Willow Creek': STOPPED },
    MONTHLY_DATA: { months: MONTHS, 'Willow Creek': { mortgage: Array(30).fill(1200) } },
    LIVE_DEBT_GAPS: [{ entity: 'Willow Creek', missing: 6, of: 6, lastPosted: 'Jan 26' }],
    entPropLive: () => null,
  });
  const n = ctx.scNotes('Willow Creek').find(x => x.kind === 'debt');
  assert.ok(n, 'no debt note was raised for an entity with a posting gap');
  assert.strictEqual(n.ours, true, 'a figure we derived must be stamped as ours');
  assert.ok(/Jan 26/.test(n.text), 'the note should say when interest was last posted');
  assert.ok(/Cedar Ridge estimate/.test(n.text), 'it must not read as a Rent Manager number');
});

check('a manual occupancy note carries the date it was entered', () => {
  const ctx = sandbox({
    DATA: { 'Birchwood Commons': { units: 19, occupied: 19, occupancy: 100 } },
    entPropLive: () => null,
  });
  const n = ctx.scNotes('Birchwood Commons').find(x => x.kind === 'occ');
  assert.ok(n, 'no manual-occupancy note was raised');
  assert.ok(/2026-07-20/.test(n.text), 'the note must say when the snapshot was taken');
});

check('a small entity says how much one vacancy is worth', () => {
  const ctx = sandbox({
    DATA: { 'The Alder': { units: 12, occupied: 11, occupancy: 91.7 } },
    entPropLive: () => null,
  });
  const n = ctx.scNotes('The Alder').find(x => x.kind === 'small');
  assert.ok(n, 'no small-entity note for a 12-unit entity');
  assert.ok(/8\.3 points/.test(n.text), `expected 8.3 points on 12 units, got: ${n.text}`);
});

check('a large entity on a live roster raises no notes at all', () => {
  const ctx = sandbox({
    DATA: { 'Cedar Ridge': { units: 941, occupied: 844, occupancy: 89.7 } },
    LIVE_MONTHLY: { 'Cedar Ridge': POSTED },
    LIVE_DEBT_GAPS: [],
    entPropLive: () => [{ total: 941, occupied: 844 }],
  });
  // Length, not deepStrictEqual: the array comes back from the vm sandbox, so
  // its prototype is that realm's Array and a strict compare fails on an
  // equally empty list.
  const notes = ctx.scNotes('Cedar Ridge');
  assert.strictEqual(notes.length, 0,
    `a clean entity should carry no caveats, got: ${notes.map(n => n.kind).join(', ')}`);
});

console.log('\nThe board shares the Overview model rather than growing its own');

check('the board grades with rcScore, the same function Overview uses', () => {
  assert.ok(/\.\.\.rcScore\(e, f\)/.test(PAGE), 'ebRows must score through rcScore');
  assert.ok(/function ebRows\(\)/.test(PAGE), 'ebRows is missing');
});

check('it did not grow a second set of weights or grade bands', () => {
  const weights = (PAGE.match(/SC_WEIGHTS\s*=/g) || []).length;
  assert.strictEqual(weights, 1, `found ${weights} weight tables — there must be exactly one`);
  const grades = (PAGE.match(/function rcGrade\(/g) || []).length;
  assert.strictEqual(grades, 1, `found ${grades} grade-band functions — there must be exactly one`);
  assert.ok(!/function ebGrade\(|EB_WEIGHTS/.test(PAGE), 'the board must not define its own grading');
});

check('the board ranks best-first while Overview stays weakest-first', () => {
  assert.ok(/\.sort\(\(a, b\) => \(b\.score \?\? -1\) - \(a\.score \?\? -1\)\)/.test(PAGE),
    'the board must sort best first');
  assert.ok(/\.sort\(\(a, b\) => \(a\.score \?\? 101\) - \(b\.score \?\? 101\)\)/.test(PAGE),
    'the Overview report cards must still sort weakest first');
});

check('the pill-tab selector is gone, replaced by the board', () => {
  assert.ok(/function buildEntityBoard\(\)/.test(PAGE), 'buildEntityBoard is missing');
  assert.ok(!/ENTITIES\.forEach\(e=>\{ html\+=`<button class="etab/.test(PAGE),
    'the old pill-tab selector is still being built');
});

check('no entity is dropped from the board', () => {
  assert.ok(/ENTITIES\.map\(e => \{\s*\n\s*const f = scFigures/.test(PAGE),
    'the board must start from every entity');
});

check('nothing is selected until the board is used', () => {
  assert.ok(/if \(!ebSelected\) \{ host\.innerHTML = ebPickPrompt\(\); return; \}/.test(PAGE),
    'renderEntityDetail must not paint an entity before one is picked');
});

check('the board repaints when targets or live figures land', () => {
  const repaints = (PAGE.match(/buildEntityBoard\(\)/g) || []).length;
  assert.ok(repaints >= 4, `buildEntityBoard is only wired in ${repaints} places — targets and live pulls must both repaint it`);
  assert.ok(/name === 'entities'\) \{ scLoadTargets\(\)/.test(PAGE),
    'opening Entities must load the targets, even if Overview was never opened');
});

check('scFigures reads the corrected inputs, not the raw ones', () => {
  assert.ok(/ents\.reduce\(\(s, e\) => s \+ scDebtT12\(e, shift\), 0\)/.test(PAGE),
    'scFigures must take debt service through scDebtT12');
  assert.ok(!/const income = sumF\('income'\), opex = sumF\('opex'\), noi = sumF\('noi'\), mtg = sumF\('mortgage'\)/.test(PAGE),
    'scFigures is still summing the raw live mortgage for DSCR');
  assert.ok(/const occRows = ents\.map\(scOccupancy\)/.test(PAGE),
    'scFigures must take occupancy through scOccupancy');
});

// ── Action items (2026-10-21) ────────────────────────────────────────────────
// The "What to work on" dashboard under the board derives each item from the
// parts rcScore produced, by fixed rules. These run those rules on stubbed rows
// and check that every sentence names the figure that put it there, that the
// Willow Creekdebt gap reads as missing data rather than as coverage, and that nothing
// here grades on its own.
console.log('\nAction items name the figure behind them');

function liftConst(name) {
  const m = PAGE.match(new RegExp(`const ${name} = ([^;\\n]+);`));
  assert.ok(m, `${name} is missing from public/index.html`);
  return `const ${name} = ${m[1]};`;
}
function eaSandbox(over) {
  const ctx = {
    ovT12Range: () => ({ from: 18, to: 29 }),
    ovSumRange: () => null,
    MONTHLY_DATA: { months: MONTHS },
    LIVE_MONTHLY: null, LIVE_DEBT_GAPS: null, LIVE_BYPROP: null,
    DATA: {}, entPropLive: null, entPropDelinq: null,
    FULL_DELINQUENCY: undefined, DQ_IDX: { tenant: 0, unit: 1, property: 2, entity: 3, amount: 4 },
    fmtK: v => '$' + Math.round(v).toLocaleString('en-US'),
    scFmt: (v, u) => v == null ? '—' : u === '%' ? v.toFixed(1) + '%' : u === 'x' ? v.toFixed(2) + 'x' : '$' + Math.round(v),
    ...over,
  };
  vm.createContext(ctx);
  const asOf = PAGE.match(/const SC_MANUAL_OCC_AS_OF = '([^']+)';/)[1];
  vm.runInContext(
    [`const SC_MANUAL_OCC_AS_OF = '${asOf}';`, liftConst('EA_LABEL'), liftConst('EA_REOPEN_TOL'), liftConst('EA_BIG_BALANCE'), liftConst('EA_PER_ENTITY'), liftConst('EA_PER_RULE'), liftConst('EA_GREEN_LABEL'),
     lift('scDebtGap'), lift('scOccupancy'), lift('eaMoney'), lift('eaSigned'), lift('eaGain'), lift('eaFlags'), lift('eaTopFlags'), lift('eaGreens')].join('\n'), ctx);
  return ctx;
}
// A row as ebRows builds it: the parts carry status/score/weight per metric.
const T = {
  occupancy: { unit: '%', better: 'higher', target: 95, floor: 90 },
  delinquency: { unit: '%', better: 'lower', target: 5, floor: 15 },
  margin: { unit: '%', better: 'higher', target: 45, floor: 35 },
  expRatio: { unit: '%', better: 'lower', target: 55, floor: 70 },
  dscr: { unit: 'x', better: 'higher', target: 1.25, floor: 1 },
  cfPerUnit: { unit: '$', better: 'higher', target: 50, floor: 0 },
};
const W = { dscr: 25, occupancy: 20, margin: 15, delinquency: 15, cfPerUnit: 15, expRatio: 10 };
function row(e, f, statuses, units) {
  const parts = Object.keys(T).map(k => ({
    m: { key: k, label: k }, t: T[k], v: f[k], w: W[k],
    status: statuses[k] || 'good', sc: statuses[k] === 'bad' ? 25 : statuses[k] === 'watch' ? 75 : 100,
  }));
  return { e, f, parts, units, score: 70, grade: 'C', rank: 5 };
}
const CR_F = { income: 5000000, opex: 2200000, noi: 2800000, mtg: 2600000, net: 200000, units: 941,
  occupancy: 89.7, delinquency: 24.0, margin: 56, expRatio: 44, dscr: 1.08, cfPerUnit: 17.7 };

check('an entity on target raises no items at all', () => {
  const ctx = eaSandbox({ DATA: { 'Cedar Ridge': { units: 941, occupied: 941, occupancy: 100 } }, entPropLive: () => null });
  assert.strictEqual(ctx.eaFlags(row('Cedar Ridge', CR_F, {}, 941)).length, 0);
});

check('occupancy says how many doors to the target and where the vacancies sit', () => {
  const ctx = eaSandbox({
    DATA: { 'Cedar Ridge': { units: 941, occupied: 844, occupancy: 89.7 } },
    entPropLive: () => [{ name: 'Garden Court', total: 500, occupied: 440, vacant: 60 }, { name: 'Oak', total: 441, occupied: 404, vacant: 37 }],
  });
  const fl = ctx.eaFlags(row('Cedar Ridge', CR_F, { occupancy: 'bad' }, 941)).find(x => x.rule === 'occupancy');
  assert.ok(fl, 'no occupancy item');
  assert.ok(/89\.7% occupied — 97 of 941 units vacant/.test(fl.number), fl.number);
  // ceil(.95 * 941) = 894 occupied needed, minus 844 = 50 doors.
  assert.ok(/Lease 50 more units to reach the 95\.0% target/.test(fl.action), fl.action);
  assert.ok(/60 at Garden Court, 37 at Oak/.test(fl.action), 'should name the buildings with the most vacancies');
  assert.strictEqual(fl.key, 'EA:Cedar Ridge:occupancy');
  assert.strictEqual(fl.value, 89.7);
  assert.strictEqual(fl.status, 'bad');
  // 20 of 100 weight at a 25 score: (100-25) * 20 / 100 = 15 points.
  assert.strictEqual(fl.gain, 15);
});

check('a manual-snapshot occupancy says so in the item', () => {
  const ctx = eaSandbox({ DATA: { 'The Alder': { units: 12, occupied: 11, occupancy: 91.7 } }, entPropLive: () => null });
  const fl = ctx.eaFlags(row('The Alder', { ...CR_F, occupancy: 91.7 }, { occupancy: 'watch' }, 12)).find(x => x.rule === 'occupancy');
  assert.ok(/manual snapshot of 2026-07-20/.test(fl.number), fl.number);
  assert.ok(/Lease 1 more unit to reach/.test(fl.action), fl.action);
});

check('delinquency names the dollars to collect and the tenants over $5K', () => {
  const ctx = eaSandbox({
    DATA: { 'Cedar Ridge': { units: 941, occupied: 844, occupancy: 89.7, delinq_amount: 319313, delinq_tenants: 183, gpr_monthly: 1331022 } },
    entPropLive: () => null,
    FULL_DELINQUENCY: [
      ['A', '1', 'P', 'Cedar Ridge', 12000], ['B', '2', 'P', 'Cedar Ridge', 6500], ['C', '3', 'P', 'Cedar Ridge', 900], ['D', '4', 'Q', 'Maple Court', 20000],
    ],
  });
  const fl = ctx.eaFlags(row('Cedar Ridge', CR_F, { delinquency: 'bad' }, 941)).find(x => x.rule === 'delinquency');
  assert.ok(fl, 'no delinquency item');
  assert.ok(/24\.0% of a month's GPR — \$319,313 owed by 183 tenants/.test(fl.number), fl.number);
  // 319,313 − 5% × 1,331,022 = 252,762 to collect.
  assert.ok(/Collect \$252,762 to get under the 5\.0% target/.test(fl.action), fl.action);
  assert.ok(/2 tenants over \$5,000 owe \$18,500 — start there/.test(fl.action), 'should count only this entity\'s balances over $5K: ' + fl.action);
});

check('without the ledger, delinquency falls back to the property holding most of it', () => {
  const ctx = eaSandbox({
    DATA: { 'Cedar Ridge': { delinq_amount: 100000, delinq_tenants: 40, gpr_monthly: 1000000 } },
    entPropLive: () => null,
    entPropDelinq: () => ({ total: 100000, tenants: 40, rows: [{ name: 'Garden Court', amount: 70000, tenants: 25 }] }),
  });
  const fl = ctx.eaFlags(row('Cedar Ridge', { ...CR_F, delinquency: 10 }, { delinquency: 'watch' }, 941)).find(x => x.rule === 'delinquency');
  assert.ok(/\$70,000 of it sits at Garden Court \(25 tenants\)/.test(fl.action), fl.action);
});

check('expense ratio and margin share one item, worth both metrics\' points', () => {
  const ctx = eaSandbox({
    DATA: {},
    entPropLive: () => null,
    ovSumRange: (e, field) => field === 'income' ? 1000000 : field === 'opex' ? 500000 : null,
  });
  const f = { ...CR_F, income: 1000000, opex: 700000, noi: 300000, margin: 30, expRatio: 70 };
  const items = ctx.eaFlags(row('X', f, { expRatio: 'bad', margin: 'bad' }, 100));
  const pl = items.filter(x => x.rule === 'pl');
  assert.strictEqual(pl.length, 1, 'expense ratio and margin must be one item, not two');
  assert.ok(/Expense ratio 70\.0% · NOI margin 30\.0% — \$700,000 of expenses on \$1,000,000 income/.test(pl[0].number), pl[0].number);
  // To 55%: cut 700,000 − 550,000 = 150,000; or income to 700,000 / .55 = 1,272,727 (+272,727).
  assert.ok(/come down \$150,000 a year, or income up \$272,727/.test(pl[0].action), pl[0].action);
  assert.ok(/expenses \+\$200,000, income \+\$0 — mostly expenses/.test(pl[0].action), 'should name the side that moved: ' + pl[0].action);
  // (100-25) × 10/100 + (100-25) × 15/100 = 7.5 + 11.25 → 8 + 11 = 19.
  assert.strictEqual(pl[0].gain, 19);
  assert.strictEqual(pl[0].key, 'EA:X:pl');
});

check('a stopped interest posting reads as missing data, stamped as ours — never as coverage', () => {
  const ctx = eaSandbox({
    DATA: {}, entPropLive: () => null,
    LIVE_DEBT_GAPS: [{ entity: 'Willow Creek', missing: 6, of: 6, lastPosted: 'Jan 26' }],
  });
  // DSCR is GOOD here — on the verified figure — and the item must still speak.
  const items = ctx.eaFlags(row('Willow Creek', { ...CR_F, dscr: 1.4 }, {}, 207));
  const fl = items.find(x => x.rule === 'dscr');
  assert.ok(fl, 'the gap must raise a DSCR item even when the ratio reads fine');
  assert.strictEqual(fl.status, 'data');
  assert.strictEqual(fl.ours, true);
  assert.strictEqual(fl.gain, null, 'a data item has no points to win');
  assert.strictEqual(fl.value, null, 'a data item carries no figure, so a mark on it never reopens on a number');
  assert.ok(/no mortgage interest for Willow Creek in 6 of the last 6 months \(last posted Jan 26\)/.test(fl.number), fl.number);
  assert.ok(/Not an improvement/.test(fl.action) && /Cedar Ridge estimate/.test(fl.action) && /GL 6230/.test(fl.action), fl.action);
  assert.ok(!items.find(x => x.rule === 'cfPerUnit'), 'cash flow per unit must not speak separately on estimated debt');
});

check('a real DSCR shortfall says what NOI has to do, and absorbs cash flow per unit', () => {
  const ctx = eaSandbox({ DATA: {}, entPropLive: () => null, LIVE_DEBT_GAPS: [] });
  const items = ctx.eaFlags(row('Cedar Ridge', CR_F, { dscr: 'watch', cfPerUnit: 'bad' }, 941));
  const fl = items.find(x => x.rule === 'dscr');
  assert.ok(/1\.08x — NOI \$2,800,000 against \$2,600,000 of debt service \(interest only\)/.test(fl.number), fl.number);
  // 1.25 × 2.6M − 2.8M = 450,000, +16%; or debt 2.6M − 2.8M/1.25 = 360,000 lower.
  assert.ok(/NOI needs \+\$450,000 a year \(\+16%\) to reach 1\.25x, or debt service \$360,000 lower/.test(fl.action), fl.action);
  assert.ok(/lifts cash flow per unit/.test(fl.action));
  assert.ok(!items.find(x => x.rule === 'cfPerUnit'), 'cash flow per unit folds into the DSCR item');
  // (100-75) × 25/100 + (100-25) × 15/100 = 6.25 + 11.25 → 6 + 11 = 17.
  assert.strictEqual(fl.gain, 17);
});

check('cash flow per unit speaks on its own only when DSCR did not', () => {
  const ctx = eaSandbox({ DATA: {}, entPropLive: () => null, LIVE_DEBT_GAPS: [] });
  const fl = ctx.eaFlags(row('Cedar Ridge', CR_F, { cfPerUnit: 'bad' }, 941)).find(x => x.rule === 'cfPerUnit');
  assert.ok(fl, 'no cash flow item');
  assert.ok(/\$18 per unit per month — net \$200,000 a year across 941 units/.test(fl.number), fl.number);
  // 50 × 12 × 941 = 564,600 − 200,000 = 364,600.
  assert.ok(/\+\$364,600 a year to reach \$50 a unit a month/.test(fl.action), fl.action);
});

check('red items come before amber, and a data item sits between', () => {
  const ctx = eaSandbox({
    DATA: { 'Cedar Ridge': { units: 941, occupied: 844, occupancy: 89.7, delinq_amount: 1, delinq_tenants: 1, gpr_monthly: 100 } },
    entPropLive: () => null, LIVE_DEBT_GAPS: [{ entity: 'Cedar Ridge', missing: 4, of: 6 }],
  });
  const order = ctx.eaFlags(row('Cedar Ridge', CR_F, { occupancy: 'watch', delinquency: 'bad' }, 941)).map(x => x.status);
  assert.deepStrictEqual([...order], ['bad', 'data', 'watch']);
});

check('no owner names anywhere: the items carry none and the code that routed them is gone', () => {
  // The owner, 2026-10-22: "remove those people's names." Removed, not hidden.
  assert.ok(!/function eaOwner\(|function eaPeople\(|_eaOwnerFilter|function eaEntityBlock\(/.test(PAGE), 'owner routing or the per-entity list is still in the page');
  const ctx = eaSandbox({
    DATA: { 'Cedar Ridge': { units: 941, occupied: 844, occupancy: 89.7, delinq_amount: 300000, delinq_tenants: 100, gpr_monthly: 1000000 } },
    entPropLive: () => null, LIVE_DEBT_GAPS: [],
  });
  const items = ctx.eaFlags(row('Cedar Ridge', CR_F, { occupancy: 'bad', delinquency: 'bad', expRatio: 'bad', dscr: 'bad' }, 941));
  assert.ok(items.length >= 4);
  items.forEach(x => {
    assert.ok(!('owner' in x), `${x.rule} still carries an owner`);
    assert.ok(!/Dana Okoye|Priya|Sam Whitfield|Jordan/.test(x.number + ' ' + x.action), `${x.rule} names a person: ${x.action}`);
  });
});

console.log('\nThe five flags');

// A flag as eaFlags hands it over, for the ranking tests.
const F = (e, rule, status, gain, score, extra) => ({ key: `EA:${e}:${rule}`, e, rule, label: rule, status, gain, score, value: 1, number: `${e} ${rule}`, action: 'x', ...extra });
const open = () => true;

check('red-line items come before amber, each band by points at stake', () => {
  const ctx = eaSandbox({});
  const top = ctx.eaTopFlags([
    F('A', 'occupancy', 'watch', 20, 80), F('B', 'dscr', 'bad', 10, 60), F('C', 'pl', 'bad', 30, 55), F('D', 'delinquency', 'watch', 5, 70),
  ], open, 5).map(x => x.key);
  assert.deepStrictEqual([...top], ['EA:C:pl', 'EA:B:dscr', 'EA:A:occupancy', 'EA:D:delinquency']);
});

check('at most two flags from one entity, so five slots show the portfolio', () => {
  const ctx = eaSandbox({});
  const flags = [
    F('X', 'dscr', 'bad', 40, 8), F('X', 'pl', 'bad', 30, 8), F('X', 'occupancy', 'bad', 20, 8), F('X', 'delinquency', 'bad', 10, 8),
    F('Y', 'dscr', 'bad', 9, 50), F('Z', 'pl', 'bad', 8, 60), F('W', 'occupancy', 'bad', 7, 70),
  ];
  const top = ctx.eaTopFlags(flags, open, 5);
  assert.strictEqual(top.length, 5);
  assert.strictEqual(top.filter(x => x.e === 'X').length, 2, 'X must hold two slots, not four');
  assert.deepStrictEqual([...top.map(x => x.e)].sort(), ['W', 'X', 'X', 'Y', 'Z']);
});

check('at most two flags of one metric, so the five tell the team different things', () => {
  const ctx = eaSandbox({});
  const flags = [
    F('A', 'dscr', 'bad', 40, 10), F('B', 'dscr', 'bad', 39, 11), F('C', 'dscr', 'bad', 38, 12), F('D', 'dscr', 'bad', 37, 13),
    F('E', 'occupancy', 'bad', 10, 50), F('F', 'delinquency', 'bad', 9, 60),
  ];
  const top = ctx.eaTopFlags(flags, open, 5);
  const rules = top.map(x => x.rule);
  assert.strictEqual(top.length, 5);
  assert.ok(rules.includes('occupancy') && rules.includes('delinquency'), 'the other metrics must get a slot: ' + rules);
  assert.deepStrictEqual([...top.map(x => x.e)].slice(0, 2), ['A', 'B'], 'the two biggest debt-coverage items keep the lead');
  assert.strictEqual(rules.filter(r => r === 'dscr').length, 3, 'the third debt-coverage item only fills the overflow slot');
});

check('with only one entity short, the slots still fill from it rather than going empty', () => {
  const ctx = eaSandbox({});
  const flags = ['dscr', 'pl', 'occupancy', 'delinquency'].map((r, i) => F('X', r, 'bad', 40 - i, 8));
  assert.strictEqual(ctx.eaTopFlags(flags, open, 5).length, 4, 'all four of its items, none dropped by the per-entity cap');
});

check('a handled flag steps aside and the next-worst takes its slot', () => {
  const ctx = eaSandbox({});
  const flags = [F('A', 'dscr', 'bad', 40, 10), F('B', 'dscr', 'bad', 30, 20), F('C', 'dscr', 'bad', 20, 30)];
  const top = ctx.eaTopFlags(flags, fl => fl.key !== 'EA:A:dscr', 2).map(x => x.e);
  assert.deepStrictEqual([...top], ['B', 'C']);
});

check('Willow Creek/2/3 collapse into ONE flag that leads, says the interest is missing, and cannot be marked handled', () => {
  const gaps = ['Willow Creek', 'Willow Creek', 'Willow Creek'].map(e => ({ entity: e, missing: 6, of: 6, lastPosted: 'Jan 26' }));
  const ctx = eaSandbox({ DATA: {}, entPropLive: () => null, LIVE_DEBT_GAPS: gaps });
  const dataFlags = gaps.map(g => ctx.eaFlags(row(g.entity, { ...CR_F, dscr: 1.4 }, {}, 200)).find(x => x.rule === 'dscr'));
  assert.ok(dataFlags.every(x => x && x.status === 'data'), 'each Willow Creekentity must raise a data item');
  const rest = [F('Cedar Ridge', 'dscr', 'bad', 40, 50), F('Maple Court', 'pl', 'bad', 30, 60)];
  const top = ctx.eaTopFlags([...rest, ...dataFlags], open, 5);
  assert.strictEqual(top.length, 3, 'three Willow Creekitems must collapse to one slot');
  const lead = top[0];
  assert.strictEqual(lead.merged, true, 'the data flag must take the first slot');
  assert.deepStrictEqual([...lead.ents], ['Willow Creek', 'Willow Creek', 'Willow Creek']);
  assert.ok(/^Rent Manager has posted no mortgage interest in 6 of the last 6 months \(last posted Jan 26\)/.test(lead.number), lead.number);
  assert.ok(/Not an improvement/.test(lead.action) && /Cedar Ridge estimate/.test(lead.action) && /Willow Creek 1\.40x/.test(lead.action), lead.action);
  assert.strictEqual(lead.ours, true);
  assert.strictEqual(lead.key, null, 'nothing to mark handled: it clears when interest posts again');
  assert.strictEqual(lead.gain, null);
});

console.log('\nThe five greens');
// A row whose metrics are all on target, with the figures set per test.
function greenRow(e, f, units, score) {
  const r = row(e, f, {}, units);
  r.score = score ?? 90; r.grade = 'A';
  return r;
}
const GOOD_F = { occupancy: 98, delinquency: 1, margin: 60, expRatio: 40, dscr: 1.6, cfPerUnit: 120 };

check('a green names the metric, the figure and how far past target it is', () => {
  const ctx = eaSandbox({ DATA: {}, entPropLive: () => [{ total: 400, occupied: 392 }], LIVE_DEBT_GAPS: [] });
  const g = ctx.eaGreens([greenRow('Cedar Ridge', { ...GOOD_F, occupancy: 98 }, 400)], 9).find(x => x.rule === 'occupancy');
  assert.ok(g, 'no occupancy green');
  assert.ok(/98\.0% occupied \(392 of 400 units\) — 3\.0 pts above the 95\.0% target/.test(g.number), g.number);
  const dq = ctx.eaGreens([greenRow('Cedar Ridge', { ...GOOD_F, delinquency: 1 }, 400)], 9).find(x => x.rule === 'delinquency');
  assert.ok(/1\.0% — 4\.0 pts below the 5\.0% target/.test(dq.number), dq.number);
});

check('ranked by distance past target (capped at one target-to-red-line gap), then by weight, then by score', () => {
  const ctx = eaSandbox({ DATA: {}, entPropLive: () => [{ total: 400, occupied: 392 }], LIVE_DEBT_GAPS: [] });
  // Occupancy 100 is 5 past target on a 5-point gap: a full gap. DSCR 1.5 is
  // one full gap (0.25) as well, and weighs more (25 against 20). Delinquency 4
  // is a tenth of its 10-point gap, so it ranks last of the three.
  const only = { occupancy: 100, delinquency: 4, dscr: 1.5, margin: 45, expRatio: 55, cfPerUnit: 50 };
  const order = ctx.eaGreens([greenRow('Cedar Ridge', only, 400)], 9).map(x => x.rule);
  assert.strictEqual(order[0], 'dscr');
  assert.strictEqual(order[1], 'occupancy');
  assert.ok(order.indexOf('delinquency') > order.indexOf('occupancy'));
  // Same distance and weight: the higher entity score leads.
  const two = ctx.eaGreens([greenRow('LOW', { ...GOOD_F }, 400, 80), greenRow('HIGH', { ...GOOD_F }, 400, 95)], 1);
  assert.strictEqual(two[0].e, 'HIGH');
});

check('at most two greens from one entity, filling from the overflow only when entities run out', () => {
  const ctx = eaSandbox({ DATA: {}, entPropLive: () => [{ total: 400, occupied: 400 }], LIVE_DEBT_GAPS: [] });
  const meh = { occupancy: 96, delinquency: 4, dscr: 1.3, margin: 46, expRatio: 54, cfPerUnit: 55 };
  const three = ctx.eaGreens([greenRow('BIG', GOOD_F, 400, 99), greenRow('B', meh, 400, 85), greenRow('C', meh, 400, 84)], 5);
  assert.strictEqual(three.length, 5);
  assert.ok(three.filter(x => x.e === 'BIG').length <= 2, 'BIG must not take more than two slots while others have greens');
  assert.ok(new Set(three.map(x => x.e)).size === 3, 'five slots across three entities must show all three');
  // Two entities can only fill four slots under the cap; the fifth comes from the overflow rather than staying empty.
  const two = ctx.eaGreens([greenRow('BIG', GOOD_F, 400, 99), greenRow('B', meh, 400, 85)], 5);
  assert.strictEqual(two.length, 5);
});

check('at most two greens of one metric', () => {
  const ctx = eaSandbox({ DATA: {}, entPropLive: () => [{ total: 400, occupied: 400 }], LIVE_DEBT_GAPS: [] });
  // Four entities all strongest on debt coverage; one has a standout occupancy.
  const base = { occupancy: 95, delinquency: 5, margin: 45, expRatio: 55, cfPerUnit: 50 };
  const rows = ['A', 'B', 'C', 'D'].map((e, k) => greenRow(e, { ...base, dscr: 2 - k * 0.01 }, 400, 90 - k));
  rows.push(greenRow('E', { ...base, dscr: 1.25, occupancy: 100 }, 400, 70));
  const g = ctx.eaGreens(rows, 5);
  assert.ok(g.some(x => x.rule === 'occupancy' && x.e === 'E'), 'a standout of another metric must get a slot: ' + g.map(x => x.e + ':' + x.rule));
  assert.strictEqual(g.filter(x => x.rule === 'dscr').length <= 3, true);
  assert.strictEqual(g.slice(0, 3).filter(x => x.rule === 'dscr').length <= 2, true, 'two debt-coverage greens at most before another metric appears');
});

check('a flattered number never reads as a result: manual occupancy, tiny entities, estimated debt', () => {
  const manual = eaSandbox({ DATA: { M: { units: 120, occupied: 120, occupancy: 100 } }, entPropLive: () => null, LIVE_DEBT_GAPS: [] });
  assert.ok(!manual.eaGreens([greenRow('M', { ...GOOD_F, occupancy: 100 }, 120)], 9).some(x => x.rule === 'occupancy'), 'a hand-entered 100% must not be a green');
  const small = eaSandbox({ DATA: {}, entPropLive: () => [{ total: 19, occupied: 19 }], LIVE_DEBT_GAPS: [] });
  assert.ok(!small.eaGreens([greenRow('Birchwood Commons', { ...GOOD_F, occupancy: 100 }, 19)], 9).some(x => x.rule === 'occupancy'), 'one lease on 19 doors is not a result');
  const est = eaSandbox({ DATA: {}, entPropLive: () => [{ total: 400, occupied: 392 }], LIVE_DEBT_GAPS: [{ entity: 'Willow Creek', missing: 6, of: 6 }] });
  const g = est.eaGreens([greenRow('Willow Creek', GOOD_F, 400)], 9).map(x => x.rule);
  assert.ok(!g.includes('dscr') && !g.includes('cfPerUnit'), 'coverage on an estimated debt figure must not be celebrated: ' + g);
  assert.ok(g.includes('occupancy') && g.includes('margin'), 'the metrics that do not rest on debt should still count');
});

check('only metrics on target are greens, and a metric with no figure is not one', () => {
  const ctx = eaSandbox({ DATA: {}, entPropLive: () => [{ total: 400, occupied: 392 }], LIVE_DEBT_GAPS: [] });
  const r = row('Cedar Ridge', { ...GOOD_F, delinquency: null }, { dscr: 'watch' }, 400);
  r.score = 90; r.grade = 'A';
  r.parts.find(p => p.m.key === 'delinquency').sc = null;
  const g = ctx.eaGreens([r], 9).map(x => x.rule);
  assert.ok(!g.includes('dscr'), 'an amber metric is not a green');
  assert.ok(!g.includes('delinquency'), 'no figure, no green');
});

check('the strips grade nothing themselves — they pick from rcScore\'s parts', () => {
  assert.ok(!/function eaScore\(|function eaGrade\(|EA_WEIGHTS/.test(PAGE), 'the action items must not define their own grading');
  assert.ok(/const all = rows\.flatMap\(eaFlags\)/.test(PAGE), 'the flags must build from the board\'s own rows');
  assert.ok(/eaGreens\(rows, 4\)/.test(PAGE) && /eaTopFlags\(all, eaIsOpen, 5\)/.test(PAGE), 'five needing attention and four growth items (the owner, 2026-10-22)');
  assert.ok(/function eaGain\(parts, key\)/.test(PAGE) && /\(100 - p\.sc\) \* p\.w \/ wsum/.test(PAGE), 'the points at stake must come from the part\'s own score and weight');
});

check('the flags sit in the filter bar above the grade cards, and follow the scope', () => {
  assert.ok(/pfBuildBar\(rows\)/.test(PAGE), 'the board must hand its rows to the bar that carries the flags');
  const bar = PAGE.indexOf('<div class="pf-bar" id="pfBar">'), board = PAGE.indexOf('<div class="entity-tabs" id="entityTabs"></div>');
  assert.ok(bar > 0 && board > 0 && bar < board, 'the filter bar must come before the grade cards in the page');
  assert.ok(/const scoped = ebSelected \? rows\.filter\(r => r\.e === ebSelected\) : rows;/.test(PAGE), 'flags must follow the picked entity');
  assert.ok(!/\$\{eaEntityBlock\(/.test(PAGE), 'the picked entity card must not carry a scrolling list of items any more');
});

console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll entity-board checks passed.\n');
process.exit(failures ? 1 : 0);
