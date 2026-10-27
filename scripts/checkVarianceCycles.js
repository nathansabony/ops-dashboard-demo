#!/usr/bin/env node
// Proves the recurring-spike reading on a flag card, without a browser.
//
// The owner, 2026-09-03, on the 2301 Willow Creek Rd water flag: *"it jumped a lot, but
// there was also a high number once every three, four months. So start checking
// patterns too."*
//
// That is the general rule the water flag produced, and it is the kind of rule
// that is dangerous precisely because it is helpful: a pattern detector that is
// too eager will label a genuine step change "the billing cycle" and talk
// somebody out of looking at a real problem. So the two halves are pinned apart
// here, the same way check:variance-colors pins marks apart from flags:
//
//   • a line that really does bill on a cycle is recognised, and
//   • a line that does NOT — a step change, a plateau, irregular highs, a short
//     history — returns nothing at all rather than a confident wrong story.
//
// And the case that motivated the size test: a spike that arrives exactly on
// schedule and is half again as big as the last few. A month-over-month test
// calls that normal-for-this-line; a same-month-last-year test calls it normal;
// only the peak-to-peak comparison sees it.
//
// Runs the REAL functions, lifted out of public/index.html by name and evaluated
// in a vm, so it cannot drift from what the page does. Holds no real financial
// figures — every number here is invented to exercise a rule.
//
//   node scripts/checkVarianceCycles.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getConfig } = require('../services/varianceConfig');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function lift(name) {
  const at = html.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`checkVarianceCycles: ${name}() not found in index.html`);
  let i = html.indexOf('{', at), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
  }
  throw new Error(`checkVarianceCycles: ${name}() has no closing brace`);
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext([lift('varSpikeCycle'), lift('varCycleVerdict')].join('\n\n'), sandbox);
const { varSpikeCycle, varCycleVerdict } = sandbox;

const MODEL = getConfig().model;
const C = MODEL.cycle;

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
}

// ── series builders (invented figures) ──────────────────────────────────────
// A line that bills every `period` months: a quiet base, and a spike on the beat.
// The beat is anchored to the LAST month, so the month under test is always the
// one that was due unless a test deliberately pushes another month after it.
function cyclical({ months = 24, period = 3, base = 9000, peak = 27000, peakAt = null }) {
  const lastIdx = months - 1;
  return Array.from({ length: months }, (_, i) => ((lastIdx - i) % period === 0
    ? (peakAt ? peakAt(i) : peak)
    : base + (i % 2 ? 200 : -200)));
}
const last = a => a.length - 1;
const verdictOf = (series, gi) => varCycleVerdict(varSpikeCycle(series, gi, MODEL), MODEL);

console.log('\nA line that really does bill on a cycle');
{
  const s = cyclical({ months: 24, period: 3 });
  const cyc = varSpikeCycle(s, last(s), MODEL);
  check('a quarterly biller is recognised as one', cyc && cyc.period === 3,
    JSON.stringify(cyc && { period: cyc.period, peaks: cyc.peaks.length }));
  check('...with the spike months named, so the claim is checkable against the grid',
    cyc && cyc.peaks.length >= C.minPeaks && cyc.peaks[cyc.peaks.length - 1] === last(s),
    JSON.stringify(cyc && cyc.peaks));
  const v = verdictOf(s, last(s));
  check('...and the spike that was due, at the usual size, reads as the cycle',
    v && v.key === 'on-cycle' && v.tone === 'ok', JSON.stringify(v));
  check('...saying so in the line\'s own terms rather than generically',
    v && /every 3 months/.test(v.text), v && v.text);
}

console.log('\nThe case a month-over-month test and a year-over-year test both miss');
{
  // On schedule, and half again as big as the spikes before it. Both existing
  // comparisons call this normal; this is the one that costs money quietly.
  const s = cyclical({ months: 24, period: 3 });
  s[last(s)] = 40000;
  const v = verdictOf(s, last(s));
  check('a spike that arrives on schedule but far bigger than the last few is called out',
    v && v.key === 'bigger' && v.tone === 'warn', JSON.stringify(v));
  check('...quantified against the previous peaks, not against last month',
    v && /% bigger than the/.test(v.text), v && v.text);

  const cyc = varSpikeCycle(s, last(s), MODEL);
  check('...and the comparison excludes this peak from its own baseline',
    cyc && Math.abs(cyc.priorPeakAvg - 27000) < 1, String(cyc && cyc.priorPeakAvg));
}
{
  // Peaks creeping up. Each one is within the size gate against the average, so
  // only the drift catches it.
  const s = cyclical({ months: 24, period: 3, base: 4000, peakAt: i => 18000 + i * 220 });
  const v = verdictOf(s, last(s));
  check('peaks drifting upward year over year are named even when this one is not "big"',
    v && v.key === 'climbing', JSON.stringify(v));
  const cyc = varSpikeCycle(s, last(s), MODEL);
  check('...with the drift expressed per year, off the peaks themselves',
    cyc && cyc.trendPctPerYear > C.trendPctPerYear,
    String(cyc && cyc.trendPctPerYear));
}

console.log('\nThe pattern is read from history, not from the month it explains');
{
  // The circular-argument guard. If the flagged month is allowed to help
  // establish the pattern, "this spike is on schedule" becomes true almost by
  // construction and the off-schedule reading is unreachable — which is exactly
  // what the first version of this did.
  const s = cyclical({ months: 24, period: 3 });
  const normal = varSpikeCycle(s, last(s), MODEL);
  const huge = varSpikeCycle(s.map((v, i) => (i === last(s) ? 999999 : v)), last(s), MODEL);
  check('a wildly different flagged month does not change the pattern found',
    normal.period === huge.period
      && normal.priorPeaks.join() === huge.priorPeaks.join()
      && Math.abs(normal.priorPeakAvg - huge.priorPeakAvg) < 1,
    JSON.stringify({ normal: normal.period, huge: huge.period }));
  check('...it only changes what is said ABOUT that month',
    varCycleVerdict(normal, MODEL).key === 'on-cycle' && varCycleVerdict(huge, MODEL).key === 'bigger',
    `${varCycleVerdict(normal, MODEL).key} / ${varCycleVerdict(huge, MODEL).key}`);
}

console.log('\nWhen the pattern does NOT explain the jump');
{
  const s = cyclical({ months: 24, period: 3 });
  // An extra spike one month after the scheduled one — off the beat.
  s.push(30000);   // gap of 1 from the peak that was due
  const v = verdictOf(s, last(s));
  check('a spike off the beat is an extra one, not the one that was due',
    v && v.key === 'off-schedule', JSON.stringify(v));
}
{
  const s = cyclical({ months: 24, period: 3 });
  // A jump that is real but nowhere near the line's own spike size: the cycle
  // exists and has nothing to say about this month.
  s.push(11000);
  const v = verdictOf(s, last(s));
  check('a jump that is not one of the line\'s spikes is told it is not one',
    v && v.key === 'not-a-peak', JSON.stringify(v));
}

console.log('\nNothing is invented where there is no pattern');
{
  // THE failure that would matter: a genuine step change — a new cost that
  // arrived and stayed — must never be explained away as a billing cycle.
  const step = Array.from({ length: 24 }, (_, i) => (i < 18 ? 9000 : 26000));
  check('a step change is not a cycle', varSpikeCycle(step, last(step), MODEL) === null,
    JSON.stringify(varSpikeCycle(step, last(step), MODEL)));

  const flat = Array.from({ length: 24 }, () => 9000);
  check('a flat line is not a cycle', varSpikeCycle(flat, last(flat), MODEL) === null);

  // Three high months in a row are one event, not three peaks a month apart.
  const plateau = Array.from({ length: 24 }, (_, i) => (i >= 20 && i <= 22 ? 30000 : 9000));
  plateau.push(30000);
  check('a plateau is one event, not a monthly cycle',
    varSpikeCycle(plateau, last(plateau), MODEL) === null,
    JSON.stringify(varSpikeCycle(plateau, last(plateau), MODEL)));

  // Highs at irregular spacing are choppiness.
  const irregular = Array.from({ length: 24 }, () => 9000);
  [8, 10, 15, 23].forEach(i => { irregular[i] = 30000; });
  check('highs at irregular spacing are not a cycle',
    varSpikeCycle(irregular, last(irregular), MODEL) === null,
    JSON.stringify(varSpikeCycle(irregular, last(irregular), MODEL)));

  // An annual pattern belongs to the same-months-last-year panel, not this one.
  const annual = Array.from({ length: 36 }, (_, i) => (i % 12 === 7 ? 30000 : 9000));
  check('an annual pattern is left to the seasonal panel, not claimed as a cycle',
    varSpikeCycle(annual, last(annual), MODEL) === null,
    JSON.stringify(varSpikeCycle(annual, last(annual), MODEL)));

  const short = cyclical({ months: 5, period: 3 });
  check('too little history returns nothing rather than a pattern from three points',
    varSpikeCycle(short, last(short), MODEL) === null);

  const zeros = Array.from({ length: 24 }, () => 0);
  zeros[23] = 5000;
  check('a line that is mostly zero has no cycle to find',
    varSpikeCycle(zeros, last(zeros), MODEL) === null);

  check('a series with holes in it does not throw',
    varSpikeCycle([null, undefined, 1, null, 2], 4, MODEL) === null);
  check('no verdict without a cycle', varCycleVerdict(null, MODEL) === null);
}

console.log('\nThe knobs on screen are the knobs it runs on');
{
  // The rules box prints these numbers. A detector reading different ones would
  // make that box describe a rule nobody is applying.
  check('every knob the reading uses is in services/varianceConfig.js',
    ['window', 'minPeaks', 'minPeriod', 'maxPeriod', 'slack', 'peakOver', 'biggerPct', 'trendPctPerYear']
      .every(k => typeof C[k] === 'number'), JSON.stringify(C));
  // Raising the size gate above the gap must change the verdict — proof the knob
  // is read rather than hard-coded.
  const s = cyclical({ months: 24, period: 3 });
  s[last(s)] = 31000;                              // ~15% over the prior peaks
  const tight = varCycleVerdict(varSpikeCycle(s, last(s), MODEL), { cycle: { ...C, biggerPct: 0.05 } });
  const loose = varCycleVerdict(varSpikeCycle(s, last(s), MODEL), { cycle: { ...C, biggerPct: 0.80 } });
  check('the size gate is read from the config, not baked in',
    tight.key === 'bigger' && loose.key !== 'bigger', `${tight.key} / ${loose.key}`);
}

console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
