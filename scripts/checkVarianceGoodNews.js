#!/usr/bin/env node
// "Going well" — the good-news card on the Variances dashboard (2026-10-21).
//
// The owner: "here's what's going good with the portfolio — expenses that went down
// are green, revenue that went up is also green." The red-flag scan throws those
// moves away on purpose (scanLineFlagsAll's `dirOk`), so varGoodNewsScan is a
// SEPARATE, read-only scan. What earns a row, as decided with the owner:
//
//   1. the SAME tests a red flag passes — varCellSignal says it is a variance and
//      it is not bad (so the $ floor, % gate, abnormal-range test, flag window,
//      flagVariance switch and resolutions all apply);
//   2. and then it proves it is real, all three:
//        a. not a posting hole (the new amount is above the near-zero cutoff, and
//           the month is not still being posted);
//        b. past the posting gate (insurance / taxes / mgmt fees);
//        c. it held — the next month stays on the good side of the pre-move
//           level, or the month beats the same month last year.
//
// The cases worth protecting: a saving that held is in, with the proofs it
// passed named; a drop to $0 (or to $100) is not a saving; a drop inside the
// posting gate is not a saving yet; a one-month dip that comes back is not a
// saving; an unfavourable move is never on the list; a property's win is not
// repeated at its entity or the portfolio.
//
// Runs the REAL functions — lifted out of public/index.html by name and evaluated
// in a vm sandbox, the way check:variance-jumps and check:variance-digest do —
// against synthetic series. Every number is invented (repo policy: no real
// financial figures in the repo). The clock is pinned to 2026-10-21, so the
// posting gate and the grace window read the same on any day the check runs.
//
//   node scripts/checkVarianceGoodNews.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getConfig } = require('../services/varianceConfig');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function lift(name) {
  const at = html.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`checkVarianceGoodNews: ${name}() not found in index.html`);
  let i = html.indexOf('{', at), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
  }
  throw new Error(`checkVarianceGoodNews: ${name}() has no closing brace`);
}
function liftConst(name) {
  const m = new RegExp(`const ${name} = [\\s\\S]*?;\\n`).exec(html);
  if (!m) throw new Error(`checkVarianceGoodNews: const ${name} not found in index.html`);
  return m[0];
}

const NAMES = [
  'varScopeOpex', 'varSizeFactors', 'varTune', 'latestCompleteIdx',
  'varZeroAbs', 'varNearZero', 'varNegMinAbs', 'trailing12Stats', 'lineNormallyPresent',
  'withinZeroGrace', 'daysSinceMonthEnd', 'monthAbbrOfLabel', 'varFlagWindowMonths', 'inFlagWindow',
  'currentYearMonthIdxs', 'varCellSignal',
  'varRunRateWoKey', 'varResolutionStale', 'activeWriteoff', 'varWoThroughIdx',
  'varAllScopes', 'activeConfigItems', 'fullSeries', 'varDisplayOnly', 'configItem',
  'varGoodNewsStamp', 'varGoodNewsScan',
];
const model = getConfig().model;
// The fixtures are sized to the line's own limits; size scaling has its own test.
model.sizeScale = { ...model.sizeScale, enabled: false };
const items = getConfig().items;
const byKey = Object.fromEntries(items.map(it => [it.key, it]));
// The fixtures below test the proof gates on Water & Sewer and Insurance, which the
// real config marks isLumpy — and the scan skips lumpy lines (tested at the end). So
// the gate tests run with those two switched to non-lumpy, and the lumpy test turns
// them back on.
const LUMPY_WAS = { waterSewer: byKey.waterSewer.isLumpy, insurance: byKey.insurance.isLumpy };
byKey.waterSewer.isLumpy = false; byKey.insurance.isLumpy = false;

const sandbox = { _liveData: null, _varModel: model, _varConfig: items, console, __wo: {}, METRICS: [] };
sandbox.loadWriteoffs = () => sandbox.__wo;
vm.createContext(sandbox);
vm.runInContext([
  "Date.now = () => Date.parse('2026-10-21T12:00:00');",
  'var _varSizeCache = { stamp: null, map: new Map() };',
  liftConst('_MONTH_ABBR'), liftConst('VAR_ACCRUAL_SWITCH'), liftConst('VAR_DISPLAY_ONLY'), liftConst('_varGoodCache'),
  ...NAMES.map(lift),
].join('\n\n'), sandbox);

// 24 complete months (Oct 24 … Sep 26) + Oct 26 in progress. Flag window = the
// last 6 complete (Apr … Sep 26); every one of them has a same-month-last-year.
const MONTHS = [];
for (let y = 24, m = 9; MONTHS.length < 25; m++) {
  if (m === 12) { m = 0; y++; }
  MONTHS.push(`${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m]} ${y}`);
}
const GI = Object.fromEntries(MONTHS.map((m, i) => [m, i]));
// A steady line with a little texture, so the trailing-12 range is real.
const base = lvl => MONTHS.map((_, i) => lvl + ((i % 3) - 1) * 150);
const withMonths = (lvl, at) => { const s = base(lvl); Object.entries(at).forEach(([m, v]) => { s[GI[m]] = v; }); return s; };

function fixture() {
  return {
    months: MONTHS, partialCurrentMonth: true, refreshedAt: '2026-10-21T06:00:00Z',
    properties: {
      1: { name: 'Alpha', entity: 'E1',
        // (A) a Water & Sewer saving that held: $10K → $6K in Jul, still ~$6K Aug and Sep.
        waterSewer: withMonths(10000, { 'Jul 26': 6000, 'Aug 26': 6100, 'Sep 26': 6050 }),
        // (D) a one-month dip that came back: $12K → $7K in Jul, $16K in Aug (a
        // red jump). Jul 25 was lower still, so last year does not rescue it.
        heatingGas: withMonths(12000, { 'Jul 25': 6000, 'Jul 26': 7000, 'Aug 26': 16000, 'Sep 26': 12000 }),
        // (C1) insurance drop in Aug 26 — 51 days after month-end, inside the 60-day gate.
        insurance: withMonths(12000, { 'Aug 26': 6000, 'Sep 26': 6000 }),
      },
      2: { name: 'Beta', entity: 'E1',
        // (E) unfavourable: Water & Sewer UP $5K and staying there — a red flag, never good news.
        waterSewer: withMonths(10000, { 'Jul 26': 15000, 'Aug 26': 15000, 'Sep 26': 15000 }),
        // (C2) insurance drop in Jul 26 — 82 days, past the gate. Aug is inside the
        // gate so it cannot count as "held"; the year-ago month carries it.
        insurance: withMonths(12000, { 'Jul 26': 6000, 'Aug 26': 6000, 'Sep 26': 6000 }),
      },
      3: { name: 'Gamma', entity: 'E2',
        // (B1) electric to $0 — a posting hole (the zero bucket's), not a saving.
        electric: withMonths(8000, { 'Aug 26': 0, 'Sep 26': 0 }),
        // (B2) repairs to $100 and staying there — passes varCellSignal as a
        // favourable move, but $100 is under the near-zero cutoff.
        repairsMaint: withMonths(12000, { 'Jul 26': 100, 'Aug 26': 100, 'Sep 26': 100 }),
        // (F) the last complete month with no year-ago month: cannot be tested yet.
        waterSewer: withMonths(9000, { 'Sep 26': 5000 }).map((v, i) => (i <= GI['Sep 25'] ? null : v)),
      },
    },
    entities: {
      // E1's own Water & Sewer makes the same Jul move — Alpha's, rolled up.
      E1: { waterSewer: withMonths(20000, { 'Jul 26': 14000, 'Aug 26': 14100, 'Sep 26': 14050 }) },
      E2: {},   // single-property entity — varAllScopes skips it
    },
    portfolio: {
      waterSewer: withMonths(30000, { 'Jul 26': 22000, 'Aug 26': 22100, 'Sep 26': 22050 }),
      // (G) a portfolio-only saving: no property carries Payroll, so it stays here.
      payroll: withMonths(40000, { 'Jul 26': 30000, 'Aug 26': 30200, 'Sep 26': 30100 }),
    },
  };
}

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
}
const reset = data => { sandbox._liveData = data; sandbox.__wo = {}; };
const scan = () => sandbox.varGoodNewsScan();
const find = (wins, scopeKey, key) => wins.find(w => w.scope.key === scopeKey && w.key === key);
const sig = (scopeKey, key, month) => {
  const scope = sandbox.varAllScopes().find(s => s.key === scopeKey);
  return sandbox.varCellSignal(byKey[key], sandbox.fullSeries(scopeKey, key), GI[month], scope);
};
const favourable = s => !!s && s.kind === 'var' && !s.bad;

reset(fixture());
const wins = scan();
console.log(`\nStub data: ${wins.length} wins — ${wins.map(w => `${w.scope.label} ${w.label} ${w.monthLabel} [${w.proofs.join(' · ')}]`).join('; ')}`);

console.log('\nA favourable move that held is in, naming its proof');
{
  const a = find(wins, 'prop:1', 'waterSewer');
  check('Alpha Water & Sewer $10K → $6K in Jul 26, still low Aug and Sep, is on the list', !!a);
  check('...for the month it moved, with the monthly and annualized amounts',
    !!a && a.monthLabel === 'Jul 26' && a.giMonth === GI['Jul 26'] && Math.round(a.diff) === 6000 - a.prev
      && Math.round(a.impact) === Math.round(Math.abs(a.diff) * 12) && a.curr === 6000, JSON.stringify(a && { m: a.monthLabel, d: a.diff, i: a.impact }));
  check('...and its proofs name what it passed: held 3 mo, beat Jul 25 (no gate on this line)',
    !!a && a.proofs.join(' · ') === 'held 3 mo · beat Jul 25', a && a.proofs.join(' · '));
  const c2 = find(wins, 'prop:2', 'insurance');
  check('Beta insurance drop in Jul 26 (82 days, past the 60-day gate) is in on last year alone',
    !!c2 && c2.monthLabel === 'Jul 26' && c2.proofs.join(' · ') === 'past posting gate · beat Jul 25', c2 && c2.proofs.join(' · '));
  check('...Aug 26 is inside the gate, so it does not count toward "held"', !!c2 && c2.held === 1);
  check('the list is ordered by annualized impact, biggest first',
    wins.every((w, i) => i === 0 || wins[i - 1].impact >= w.impact));
}

console.log('\nA posting hole is not a saving');
{
  check('Gamma electric to $0 is a zero signal (the red side\'s), not a favourable move',
    (sig('prop:3', 'electric', 'Aug 26') || {}).kind === 'zero');
  check('...and is not on the list', !find(wins, 'prop:3', 'electric'));
  check('Gamma repairs to $100 passes varCellSignal as a favourable variance…', favourable(sig('prop:3', 'repairsMaint', 'Jul 26')));
  check('...but $100 is under the near-zero cutoff, so it is not on the list', !find(wins, 'prop:3', 'repairsMaint'));
}

console.log('\nA drop inside the posting gate is not a saving yet');
{
  check('Alpha insurance Aug 26 is 51 days after month-end — varCellSignal does not read it',
    sig('prop:1', 'insurance', 'Aug 26') === null);
  check('...and it is not on the list', !find(wins, 'prop:1', 'insurance'));
  const gated = fixture();
  // Same drop, gate lifted: proves it was the gate, not the numbers.
  const save = byKey.insurance.postingGateDays;
  byKey.insurance.postingGateDays = null;
  reset(gated);
  const ungated = find(scan(), 'prop:1', 'insurance');
  byKey.insurance.postingGateDays = save;
  check('...with the gate lifted the same drop would qualify (so the gate is what kept it off)',
    !!ungated && ungated.monthLabel === 'Aug 26', JSON.stringify(ungated && ungated.proofs));
}

console.log('\nA one-month dip that comes back is not a saving');
reset(fixture());
{
  check('Alpha heating gas Jul 26 ($12K → $7K) passes varCellSignal as a favourable variance',
    favourable(sig('prop:1', 'heatingGas', 'Jul 26')));
  check('...Aug 26 went back up to $16K and Jul 25 was lower, so it is not on the list', !find(scan(), 'prop:1', 'heatingGas'));
  check('Gamma Water & Sewer dropped in Sep 26, the last complete month, with no Sep 25 — not testable, not on the list',
    favourable(sig('prop:3', 'waterSewer', 'Sep 26')) && !find(scan(), 'prop:3', 'waterSewer'));
}

console.log('\nAn unfavourable move is never good news');
{
  const w = scan();
  check('Beta Water & Sewer UP $5K (a red flag) is not on the list', !find(w, 'prop:2', 'waterSewer'));
  check('Alpha heating gas back UP in Aug 26 (a red flag) is not on the list',
    !!sig('prop:1', 'heatingGas', 'Aug 26') && sig('prop:1', 'heatingGas', 'Aug 26').bad && !w.some(x => x.key === 'heatingGas'));
  // Every row, re-read through the detector: favourable, and in the cost-down /
  // income-up direction.
  check('every row is a favourable variance by varCellSignal, in the good direction',
    w.every(x => { const s = sig(x.scope.key, x.key, x.monthLabel); return favourable(s) && (x.group === 'income' ? x.diff > 0 : x.diff < 0); }));
}

console.log('\nRoll-ups: a property\'s win is not repeated at its entity or the portfolio');
{
  const w = scan();
  check('E1 Water & Sewer makes the same Jul 26 move (a favourable variance at entity tuning)…', favourable(sig('E1', 'waterSewer', 'Jul 26')));
  check('...and is dropped, because Alpha (in E1) carries it', !find(w, 'E1', 'waterSewer'));
  check('the portfolio\'s Jul 26 Water & Sewer win is dropped too', !find(w, '', 'waterSewer'));
  check('a portfolio-only saving (Payroll, no property carries it) stays at the portfolio',
    !!find(w, '', 'payroll') && find(w, '', 'payroll').scope.type === 'Portfolio');
  const noAlpha = fixture(); delete noAlpha.properties[1].waterSewer;
  reset(noAlpha);
  check('with Alpha\'s line gone, E1 becomes the lowest scope carrying it and shows', !!find(scan(), 'E1', 'waterSewer'));
}

console.log('\nThe red side\'s switches apply here too');
{
  reset(fixture());
  sandbox.__wo = { 'RR:prop:1:waterSewer': { note: 'x', at: '2026-10-20T12:00:00Z' } };
  check('a whole-line resolution hides the line', !find(scan(), 'prop:1', 'waterSewer'));
  sandbox.__wo = { 'RR:prop:1:waterSewer': { note: 'x', at: '2026-10-20T12:00:00Z', through: 'Jul 26' } };
  check('a resolution through Jul 26 hides the Jul 26 move', !find(scan(), 'prop:1', 'waterSewer'));
  sandbox.__wo = {};
  const save = byKey.waterSewer.flagVariance;
  byKey.waterSewer.flagVariance = false;
  sandbox._liveData = fixture();   // new snapshot, so the memo cannot answer
  check('flagVariance === false keeps the line off', !find(scan(), 'prop:1', 'waterSewer'));
  byKey.waterSewer.flagVariance = save;
}

console.log('\nMemoized per snapshot + resolutions');
{
  reset(fixture());
  const a = scan(), b = scan();
  check('a repaint on the same snapshot returns the cached list (no rescan)', a === b);
  sandbox.__wo['RR:prop:1:waterSewer'] = { note: 'x', at: '2026-10-20T12:00:00Z' };   // in place, as applyLocal does
  const c = scan();
  check('a resolution added in place is seen (rescan)', c !== a && !find(c, 'prop:1', 'waterSewer'));
  sandbox._liveData = Object.assign({}, sandbox._liveData, { refreshedAt: '2026-10-22T06:00:00Z' });
  check('a new pull is seen (rescan)', scan() !== c);
}

console.log('\nThe red side is untouched');
{
  check('scanLineFlagsAll still drops a favourable move from the buckets (dirOk)',
    /const dirOk = dir === 'both' \|\| \(dir === 'drop' \? sig\.diff < 0 : sig\.diff > 0\);\s*\n\s*if \(!dirOk\) return;/.test(html));
  check('computeAllActiveFlags never calls the good-news scan', !/varGoodNewsScan/.test(lift('computeAllActiveFlags')));
  check('renderFlaggedSummary (which publishes window.VAR_*) never calls it', !/varGoodNewsScan/.test(lift('renderFlaggedSummary')));
  check('the card is drawn in varHomeHtml, under Top 5', /\$\{topCard\}\$\{goodCard\}/.test(lift('varHomeHtml')));
}

console.log('\nLumpy lines are never celebrated');
{
  byKey.waterSewer.isLumpy = LUMPY_WAS.waterSewer; byKey.insurance.isLumpy = LUMPY_WAS.insurance;
  vm.runInContext('_varGoodCache.stamp = null', sandbox);   // the memo is keyed on the snapshot, not on the config's flags
  check('the real config marks Water & Sewer and Insurance lumpy', LUMPY_WAS.waterSewer === true && LUMPY_WAS.insurance === true);
  const w = scan();
  check('a favourable move on a lumpy line is not on the list (a lump reverting is not a saving)',
    !w.some(x => x.key === 'waterSewer' || x.key === 'insurance'));
  check('...while a non-lumpy line (payroll) still is', !!find(w, '', 'payroll'));
  byKey.waterSewer.isLumpy = false; byKey.insurance.isLumpy = false;
  vm.runInContext('_varGoodCache.stamp = null', sandbox);
}

console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
