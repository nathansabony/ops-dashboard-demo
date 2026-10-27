#!/usr/bin/env node
// Proves what the Variance grid HIGHLIGHTS, without a browser and without Rent
// Manager.
//
// The owner, 2026-08-25, with the tab open next to a P&L: *"when you're looking at a
// certain issue, and then you're looking at the rest of the chart, a lot of things
// are not highlighted that should be."* The example on screen was a -$8,023
// insurance credit sitting plain white two cells away from a -$596 credit painted
// yellow. Both are credits; one was inside the 60-day posting gate, so the
// detector never ran on it and the grid had no way to say so.
//
// The fix (see MOM_CELL.noted in public/index.html) is a fourth cell state —
// "noted": the detector's own rules re-run on a cell it is not allowed to FLAG,
// painted in a muted tone that means context rather than verdict. This script
// pins the two halves of that rule apart, because the whole risk of the change is
// that a context mark quietly becomes a flag:
//
//   • every anomaly on the grid gets SOME mark, and
//   • nothing that was not already flaggable became flaggable.
//
// It runs the REAL functions — lifted out of public/index.html by name and
// evaluated in a vm sandbox — against synthetic series, so it cannot drift from
// what the page does. Holds no real financial figures (repo policy): every number
// here is made up to exercise a rule.
//
//   node scripts/checkVarianceColors.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getConfig } = require('../services/varianceConfig');

// ── lift the real functions out of the page ─────────────────────────────────
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Source of `function NAME(` … its matching closing brace. Brace-counting is
// enough here (none of these functions contain a brace inside a string or regex
// literal; the assertion below catches it immediately if that ever changes).
function lift(name) {
  const at = html.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`checkVarianceColors: ${name}() not found in index.html`);
  let i = html.indexOf('{', at), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
  }
  throw new Error(`checkVarianceColors: ${name}() has no closing brace`);
}

const NAMES = [
  'varScopeOpex', 'varSizeFactors', 'varTune',
  'fmtExact', 'latestCompleteIdx', 'varZeroAbs', 'varNearZero', 'varNegMinAbs',
  'yearOfMonthLabel', 'trailing12Stats', 'lineNormallyPresent', 'withinZeroGrace',
  'daysSinceMonthEnd', 'monthAbbrOfLabel', 'varFlagWindowMonths', 'inFlagWindow', 'varCellSignal',
  'unscannedNegativeIsAnomaly', 'varCellUntrackedReason', 'untrackedRowSignal',
  'varNotedTitle',
];

// Module-level constants those functions close over, lifted the same way.
function liftConst(name) {
  const m = new RegExp(`const ${name} = [\\s\\S]*?;\\n`).exec(html);
  if (!m) throw new Error(`checkVarianceColors: const ${name} not found in index.html`);
  return m[0];
}

const _model = getConfig().model;
_model.sizeScale = { ..._model.sizeScale, enabled: false };   // fixtures use the line's own limits
const sandbox = { _liveData: null, _varModel: _model, CURRENT_YEAR: 2026, console };
vm.createContext(sandbox);
vm.runInContext(['var _varSizeCache = { stamp: null, map: new Map() };', liftConst('_MONTH_ABBR'), ...NAMES.map(lift)].join('\n\n'), sandbox);

// ── the grid's own painting decision, transcribed from renderHeatmapRows ────
// One cell in, one tone out ('' | 'yellow' | 'red' | 'green' | 'noted'). Kept in
// the same order as the if/else chain on the page: a verdict always wins, and the
// context mark only ever fills a cell no verdict claimed.
function toneFor(key, item, series, gi, scopeType, isPartial, isWO) {
  const v = series[gi];
  // Total Income / NOI (2026-10-06): shown, never tracked — the page passes no
  // item for them (activeConfigItems drops displayOnly) and paints nothing.
  if (key === 'totalIncome' || key === 'noi') return { tone: '', flag: false };
  const sig = (item && !isWO && !isPartial) ? sandbox.varCellSignal(item, series, gi, scopeType) : null;
  if (sig) return { tone: sig.bad ? (sig.kind === 'var' ? 'red' : 'yellow') : 'green', flag: true, sig };
  if (!isWO && !isPartial && sandbox.unscannedNegativeIsAnomaly(key, item, v, gi)) return { tone: 'yellow', flag: false };
  if (!isWO) {
    const reason = sandbox.varCellUntrackedReason(key, item, gi, isPartial);
    if (reason) {
      const ctx = item
        ? sandbox.varCellSignal(item, series, gi, scopeType, { context: true })
        : sandbox.untrackedRowSignal(key, series, gi, scopeType);
      if (ctx && (!isPartial || ctx.kind === 'neg')) return { tone: 'noted', flag: false, sig: ctx, reason };
    }
  }
  if (isWO) return { tone: 'resolved', flag: false };
  return { tone: '', flag: false };
}

// ── a synthetic 13-column grid, shaped like the real one ────────────────────
// Aug 25 … Aug 26, with Aug 26 in progress — the window the tab displays today.
const MONTHS = ['Aug 25', 'Sep 25', 'Oct 25', 'Nov 25', 'Dec 25', 'Jan 26', 'Feb 26',
  'Mar 26', 'Apr 26', 'May 26', 'Jun 26', 'Jul 26', 'Aug 26'];
const GI = Object.fromEntries(MONTHS.map((m, i) => [m, i]));
sandbox._liveData = { months: MONTHS, partialCurrentMonth: true };

const items = Object.fromEntries(getConfig().items.map(it => [it.key, it]));
const flat = v => MONTHS.map(() => v);

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
}

// The posting gate is measured in real days from month-end, so "which months are
// gated" moves with the calendar. Ask the page's own helper rather than assuming.
const gatedMonths = MONTHS.filter((m, i) => {
  const d = sandbox.daysSinceMonthEnd(i);
  return d != null && d < getConfig().model.postingGateDays;
});

console.log(`\nGrid ${MONTHS[0]} … ${MONTHS[MONTHS.length - 1]} (${MONTHS.length} columns, ${MONTHS[MONTHS.length - 1]} in progress)`);
console.log(`Posting-gated months today: ${gatedMonths.join(', ') || '(none)'}\n`);

// ── 1. the case that started it: a gated credit is no longer invisible ──────
console.log('The credit inside the posting window');
{
  const gated = gatedMonths.filter(m => m.endsWith('26') && m !== 'Aug 26');
  if (!gated.length) {
    console.log('  – no gated complete month in this window today; rule covered by check 3');
  } else {
    const m = gated[gated.length - 1];
    const s = flat(6000); s[GI[m]] = -8023;             // the credit that was plain white
    s[GI['Apr 26']] = -596;                             // the one beside it that was yellow
    const gatedCell = toneFor('insurance', items.insurance, s, GI[m], 'Property', false, false);
    const openCell = toneFor('insurance', items.insurance, s, GI['Apr 26'], 'Property', false, false);
    check(`a ${m} credit inside the gate is marked (was uncoloured)`, gatedCell.tone === 'noted',
      `tone "${gatedCell.tone}"`);
    check(`...and it is still NOT a flag`, gatedCell.flag === false && /posting window/.test(gatedCell.reason || ''),
      `flag=${gatedCell.flag} reason="${gatedCell.reason}"`);
    check('the ungated credit beside it is still a flag (yellow), unchanged',
      openCell.tone === 'yellow' && openCell.flag === true, `tone "${openCell.tone}"`);
    check('the bigger credit does not outrank the smaller one in TIER — only in ink',
      gatedCell.flag === false && openCell.flag === true);
  }
}

// ── 2. prior-year columns can mark at last ─────────────────────────────────
console.log('\nPrior-year columns (5 of the 13 on screen)');
{
  const s = flat(200); s[GI['Oct 25']] = -13107;
  const c = toneFor('insurance', items.insurance, s, GI['Oct 25'], 'Property', false, false);
  check('a prior-year credit is marked', c.tone === 'noted', `tone "${c.tone}"`);
  check('...as context, never as a flag', c.flag === false && /context only/.test(c.reason || ''));

  const rise = flat(3000); rise[GI['Nov 25']] = 19000;
  const r = toneFor('waterSewer', items.waterSewer, rise, GI['Nov 25'], 'Property', false, false);
  check('a prior-year spike is marked', r.tone === 'noted', `tone "${r.tone}"`);
  check('no prior-year cell is ever painted red / yellow / green (a verdict tone)',
    MONTHS.filter(m => m.endsWith('25')).every(m => {
      const t = toneFor('waterSewer', items.waterSewer, rise, GI[m], 'Property', false, false).tone;
      return t === '' || t === 'noted';
    }));
}

// ── 3. rows with no rule of their own ──────────────────────────────────────
console.log('\nRows the model has no entry for (roll-ups, REN Capital, mortgage)');
{
  const s = flat(3000); s[GI['Feb 26']] = 15843; s[GI['Oct 25']] = -4200;
  const jump = toneFor('renCapital', undefined, s, GI['Feb 26'], 'Property', false, false);
  check('a material jump on an untracked row is marked', jump.tone === 'noted', `tone "${jump.tone}"`);
  check('...and is not a flag', jump.flag === false);
  const priorNeg = toneFor('renCapital', undefined, s, GI['Oct 25'], 'Property', false, false);
  check('a prior-year credit on an untracked row is marked', priorNeg.tone === 'noted', `tone "${priorNeg.tone}"`);
  const cyNeg = toneFor('renCapital', undefined, (() => { const a = flat(3000); a[GI['Mar 26']] = -4200; return a; })(),
    GI['Mar 26'], 'Property', false, false);
  check('a current-year credit on an untracked row keeps its yellow (unchanged rule)',
    cyNeg.tone === 'yellow', `tone "${cyNeg.tone}"`);

  const mort = flat(60000); mort[GI['Jun 26']] = -9000; mort[GI['Jul 26']] = 250000;
  check('mortgage interest still raises no flag, in any month',
    MONTHS.every(m => toneFor('mortgage', undefined, mort, GI[m], 'Property', false, false).flag === false));
  check('...but its credit is at least visible as context',
    toneFor('mortgage', undefined, mort, GI['Jun 26'], 'Property', false, false).tone === 'noted');
}

// ── 4. a verdict of "normal" keeps its silence ─────────────────────────────
// This is the line the whole change hangs on: a cell the detector LOOKED at and
// cleared must stay plain, or the grid turns into wallpaper and the marks stop
// meaning anything.
console.log('\nCells the detector examined and cleared stay plain');
{
  const noise = flat(4000); noise[GI['Mar 26']] = -120;   // under NEG_MIN_ABS
  check('a credit under the noise floor is not marked',
    toneFor('electric', items.electric, noise, GI['Mar 26'], 'Property', false, false).tone === '');

  const summerHeat = flat(9000); summerHeat[GI['Jul 26']] = 0;
  check('heating gas at $0 in July (no heating season) is not marked',
    toneFor('heatingGas', items.heatingGas, summerHeat, GI['Jul 26'], 'Property', false, false).tone === '');

  // The annual-renewal exemption compares against the same month LAST year, which
  // is 12 columns back — further than this 13-column window reaches for anything
  // but its oldest cell. So this one case gets its own longer series.
  const long = Array.from({ length: 25 }, () => 5000);
  const longMonths = [];
  for (let i = 0; i < 25; i++) {
    const d = new Date(2024, 7 + i, 1);
    longMonths.push(`${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]} ${String(d.getFullYear()).slice(2)}`);
  }
  const saved = sandbox._liveData;
  sandbox._liveData = { months: longMonths, partialCurrentMonth: true };
  const apr26 = longMonths.indexOf('Apr 26'), apr25 = longMonths.indexOf('Apr 25');
  long[apr26] = -40000; long[apr25] = -38000;             // the same renewal credit, a year apart
  check('an insurance credit matching last year\'s renewal is not marked',
    toneFor('insurance', items.insurance, long, apr26, 'Property', false, false).tone === '');
  long[apr26] = -400000;                                   // ten times last year's — that is news
  check('...but a credit way off last year\'s still flags yellow',
    toneFor('insurance', items.insurance, long, apr26, 'Property', false, false).tone === 'yellow');
  sandbox._liveData = saved;

  const steady = flat(4000); steady[GI['Mar 26']] = 4400;  // a 10% wobble
  check('a small move inside the line\'s normal range is not marked',
    toneFor('electric', items.electric, steady, GI['Mar 26'], 'Property', false, false).tone === '');

  const resolved = flat(4000); resolved[GI['Mar 26']] = -9000;
  check('a resolved (✓) row is never marked, in any state',
    toneFor('electric', items.electric, resolved, GI['Mar 26'], 'Property', false, true).tone === 'resolved');
}

// ── 5. the in-progress month ───────────────────────────────────────────────
console.log('\nThe in-progress (MTD) column');
{
  const s = flat(4000); s[GI['Aug 26']] = -5000;
  check('a credit posted this month is marked',
    toneFor('electric', items.electric, s, GI['Aug 26'], 'Property', true, false).tone === 'noted');
  const low = flat(4000); low[GI['Aug 26']] = 200;
  check('a half-entered month reading low is NOT marked (it always reads low)',
    toneFor('electric', items.electric, low, GI['Aug 26'], 'Property', true, false).tone === '');
  const blank = flat(4000); blank[GI['Aug 26']] = 0;
  check('a blank in-progress month is NOT marked',
    toneFor('electric', items.electric, blank, GI['Aug 26'], 'Property', true, false).tone === '');
}

// ── 6. the invariant that matters most: no new flags ───────────────────────
// Every cell of every tracked line, across a spread of shapes, compared against
// the detector as it behaves WITHOUT the context pass. The context mark may add
// ink; it may never add a flag.
console.log('\nNothing became flaggable');
{
  const shapes = {
    steady: flat(5000),
    spiky: MONTHS.map((_, i) => (i % 4 === 0 ? 40000 : 3000)),
    credits: MONTHS.map((_, i) => (i % 5 === 0 ? -7000 : 6000)),
    blanks: MONTHS.map((_, i) => (i % 3 === 0 ? 0 : 8000)),
    climbing: MONTHS.map((_, i) => 1000 * (i + 1)),
  };
  let extraFlags = 0, marks = 0, cells = 0;
  for (const item of getConfig().items) {
    for (const [, series] of Object.entries(shapes)) {
      for (let gi = 0; gi < MONTHS.length; gi++) {
        cells++;
        const isPartial = gi === MONTHS.length - 1;
        const painted = toneFor(item.key, item, series, gi, 'Property', isPartial, false);
        const bare = (!isPartial) ? sandbox.varCellSignal(item, series, gi, 'Property') : null;
        if (painted.flag && !bare) extraFlags++;
        if (painted.tone === 'noted') marks++;
      }
    }
  }
  check(`no cell became a flag that was not one before (${cells} cells)`, extraFlags === 0,
    `${extraFlags} cell(s) gained a flag`);
  check(`the context pass does mark something (${marks} cells across ${cells})`, marks > 0);
}

// ── 2026-10-06: the flag window and the per-line check switches ─────────────
console.log('\nFlag window + per-line checks');
{
  const it = Object.assign({}, items.waterSewer, { postingGateDays: null });
  const jump = (at) => MONTHS.map((_, i) => (i === at ? 30000 : 5000 + (i % 3) * 50));
  // window = last 6 COMPLETE months: Feb 26 … Jul 26 (Aug 26 is in progress)
  check('a big jump inside the last 6 complete months flags', !!sandbox.varCellSignal(it, jump(GI['Jul 26']), GI['Jul 26'], 'Property'));
  check('the same jump 7 complete months back does NOT flag', !sandbox.varCellSignal(it, jump(GI['Jan 26']), GI['Jan 26'], 'Property'));
  check('switching the variance check off silences the jump',
    !sandbox.varCellSignal(Object.assign({}, it, { flagVariance: false }), jump(GI['Jul 26']), GI['Jul 26'], 'Property'));
  const credit = MONTHS.map((_, i) => (i === GI['Jun 26'] ? -5000 : 5000));
  check('a credit inside the window flags as a negative', (sandbox.varCellSignal(it, credit, GI['Jun 26'], 'Property') || {}).kind === 'neg');
  check('switching the negatives check off silences the credit',
    !sandbox.varCellSignal(Object.assign({}, it, { flagNegative: false }), credit, GI['Jun 26'], 'Property'));
}

// ── 2026-10-06: Total Income / NOI are shown, not tracked ──────────────────
console.log('\nTotal Income / NOI — display only');
{
  const neg = flat(20000); neg[GI['Jun 26']] = -15000;
  check('a negative NOI month is no longer painted red (no NOI rule)',
    toneFor('noi', undefined, neg, GI['Jun 26'], 'Property', false, false).tone === '');
  check('a negative Total Income month is not marked either',
    toneFor('totalIncome', undefined, neg, GI['Jun 26'], 'Property', false, false).tone === '');
  check('both stay in the config (rules screen) but can never be tracked',
    ['totalIncome', 'noi'].every(k => items[k] && items[k].displayOnly && items[k].enabled === false));
  const { finalize, RAW_ITEMS } = require('../services/varianceConfig');
  check('switching "Tracked" on for NOI does not take',
    finalize({ ...RAW_ITEMS.find(i => i.key === 'noi'), enabled: true }).enabled === false);
  check('no "every other P&L line" items remain in the model',
    getConfig().items.every(i => !/^gl:/.test(i.key) && !i.generated));
  check('the page no longer has the NOI red-cell rule or the other-lines section',
    !/key === 'noi' && v != null && v < 0/.test(html) && !/varOtherLinesHtml/.test(html));
}

console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
