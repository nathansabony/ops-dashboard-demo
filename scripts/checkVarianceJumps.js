#!/usr/bin/env node
// Proves the two jump readings added 2026-10-06, without a browser and without
// Rent Manager:
//
//   • CREDIT BACK — the owner: a Water & Sewer flag up ~$27K where the next month is
//     −$25K is not a $27K problem. The flag gets an Important note ("$X credited
//     back in <month> — net change $Y"), and when most of the jump came back it
//     drops a tier and is tagged "credited back". The sub-account panel names the
//     account that took the credit.
//   • NEW RUN RATE — the owner: Property Taxes jumps and the same new amount posts
//     every month after. That is a rate change, not a spike: it still flags once,
//     labelled "new run rate since <month>", one tier lower.
//
// Runs the REAL functions — lifted out of public/index.html by name and evaluated
// in a vm sandbox, the same way check:variance-colors does — against synthetic
// series. Every number is invented to exercise a rule (repo policy: no real
// financial figures in the repo).
//
//   node scripts/checkVarianceJumps.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getConfig } = require('../services/varianceConfig');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function lift(name) {
  const at = html.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`checkVarianceJumps: ${name}() not found in index.html`);
  let i = html.indexOf('{', at), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
  }
  throw new Error(`checkVarianceJumps: ${name}() has no closing brace`);
}
function liftConst(name) {
  const m = new RegExp(`const ${name} = [\\s\\S]*?;\\n`).exec(html);
  if (!m) throw new Error(`checkVarianceJumps: const ${name} not found in index.html`);
  return m[0];
}

const NAMES = [
  'varScopeOpex', 'varSizeFactors', 'varTune',
  'fmtExact', 'escapeHtml', 'latestCompleteIdx', 'varZeroAbs', 'varNearZero', 'varNegMinAbs',
  'trailing12Stats', 'trailing12Avg', 'lineNormallyPresent', 'withinZeroGrace', 'daysSinceMonthEnd',
  'monthAbbrOfLabel', 'varFlagWindowMonths', 'inFlagWindow', 'currentYearMonthIdxs', 'varCellSignal',
  'escalateTier', 'demoteTier', 'varCreditBack', 'varStepChange', 'varCreditReversal', 'varJumpReadings', 'varWoThroughIdx', 'scanLineFlags', 'scanLineFlagsAll',
  'varSpikeCycle', 'varCycleVerdict', 'varCycleSeasonReading', 'varMissedCycle', 'varIrregularMonths', 'varRunRateTrend',
  'varScoreFlag', 'varCatchUpReading', 'varCrossScopeReadings', 'varTopFlags', 'varFlagId',
  'varSubFlags',
];
const model = getConfig().model;
// The fixtures below are tuned to the line's own limits; size scaling has its own test.
model.sizeScale = { ...model.sizeScale, enabled: false };
const sandbox = {
  _liveData: null, _varModel: model, CURRENT_YEAR: 2026, console,
  // Unrelated to these rules: who to call, and the resolution store.
  varContactFor: () => '', varRunRateWoKey: (s, k) => `${s}|${k}`, activeWriteoff: () => null,
  // The sub-flag panel reads sub-accounts through these; the test hands it a tree.
  varAcctFor: () => sandbox.__acct, varEnsureAcct: () => {}, fullSeries: () => sandbox.__series,
};
vm.createContext(sandbox);
vm.runInContext(['var _varSizeCache = { stamp: null, map: new Map() };', liftConst('_MONTH_ABBR'), liftConst('TIER_ORDER'), ...['VAR_TOP_N', 'VAR_TOP_PER_LINE', 'VAR_LINE_WEIGHT'].map(n => `const ${n} = ${new RegExp(`const ${n} = ([\\d.]+);`).exec(html)[1]};`), 'const varTierRank = u => TIER_ORDER.indexOf(u);', ...NAMES.map(lift)].join('\n\n'), sandbox);

// 14 complete months, no MTD column, so the flag window is the last 6 (May…Oct 26).
const MONTHS = ['Sep 25', 'Oct 25', 'Nov 25', 'Dec 25', 'Jan 26', 'Feb 26', 'Mar 26',
  'Apr 26', 'May 26', 'Jun 26', 'Jul 26', 'Aug 26', 'Sep 26', 'Oct 26'];
const GI = Object.fromEntries(MONTHS.map((m, i) => [m, i]));
sandbox._liveData = { months: MONTHS, partialCurrentMonth: false };
const items = Object.fromEntries(getConfig().items.map(it => [it.key, it]));
const noGate = it => Object.assign({}, it, { postingGateDays: null });
const scope = { key: 'prop:1', type: 'Property', label: 'Test Property', entity: 'Test' };
// A steady line with a little texture, so the trailing-12 range is real.
const base = (lvl) => MONTHS.map((_, i) => lvl + ((i % 3) - 1) * 150);

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
}
const scan = (item, series) => sandbox.scanLineFlags(scope, item, series, 0, {})
  .filter(f => f.reason === 'mom' || f.reason === 'singleMonth');

// ── 1. the pure readings ─────────────────────────────────────────────────────
console.log('\nvarCreditBack / varStepChange on their own');
{
  const s = base(10000); s[GI['Jul 26']] = 37000; s[GI['Aug 26']] = -25000;
  const cb = sandbox.varCreditBack(s, GI['Jul 26'], model, s.length - 1);
  check('a −$25K month after a +$27K jump is read as a credit back', !!cb && cb.months[0].credit === true, JSON.stringify(cb));
  check('give-back is measured against the pre-jump level (Jun 26 level + the $25K credit)',
    !!cb && Math.round(cb.back) === Math.round(s[GI['Jun 26']] + 25000) && Math.round(cb.net) === Math.round(cb.jump - cb.back), cb && cb.back);
  check('...which is "most" of the jump', cb && cb.most === true);

  const half = base(10000); half[GI['Jul 26']] = 37000; half[GI['Aug 26']] = -3000;
  const cbHalf = sandbox.varCreditBack(half, GI['Jul 26'], model, half.length - 1);
  check('a partial give-back is noted but is not "most"', !!cbHalf && cbHalf.most === false && cbHalf.share >= model.creditBackNotePct);

  const back2 = base(10000); back2[GI['Jul 26']] = 37000; back2[GI['Sep 26']] = -20000;
  check('a credit two months later still counts (look window = 2)', !!sandbox.varCreditBack(back2, GI['Jul 26'], model, back2.length - 1));
  const back3 = base(10000); back3[GI['Jul 26']] = 37000; back3[GI['Oct 26']] = -20000;
  check('...three months later does not', !sandbox.varCreditBack(back3, GI['Jul 26'], model, back3.length - 1));
  check('...unless the window is widened on the rules screen',
    !!sandbox.varCreditBack(back3, GI['Jul 26'], Object.assign({}, model, { creditBackMonths: 3 }), back3.length - 1));

  const spike = base(10000); spike[GI['Jul 26']] = 37000;   // one-off spike, back to normal
  check('a one-off spike that simply returns to normal is NOT a credit back',
    !sandbox.varCreditBack(spike, GI['Jul 26'], model, spike.length - 1));
  check('...and is NOT a new run rate either',
    !sandbox.varStepChange(spike, GI['Jul 26'], model, spike.length - 1));

  const step = base(8000).map((v, i) => (i >= GI['Jun 26'] ? 12000 : v));
  step[GI['Aug 26']] = 12300; step[GI['Sep 26']] = 11700;     // within ±5%
  const st = sandbox.varStepChange(step, GI['Jun 26'], model, step.length - 1);
  check('a jump that repeats at ±5% is a new run rate', !!st && st.repeats === 4, JSON.stringify(st));
  check('...per month and per year', st && Math.round(st.perMonth) === 12000 - step[GI['May 26']] && Math.round(st.perYear) === Math.round(st.perMonth * 12));
  const wobble = step.slice(); wobble[GI['Jul 26']] = 13000;  // 8% off the new level
  check('a repeat outside the tolerance breaks the run', !sandbox.varStepChange(wobble, GI['Jun 26'], model, wobble.length - 1));
  check('...but a wider tolerance on the rules screen accepts it',
    !!sandbox.varStepChange(wobble, GI['Jun 26'], Object.assign({}, model, { stepTolerancePct: 0.10 }), wobble.length - 1));
  const late = base(8000).map((v, i) => (i >= GI['Sep 26'] ? 12000 : v));
  check('one repeat month is not enough with the default of 2', !sandbox.varStepChange(late, GI['Sep 26'], model, late.length - 1));
  check('...and is with repeat months set to 1',
    !!sandbox.varStepChange(late, GI['Sep 26'], Object.assign({}, model, { stepRepeatMonths: 1 }), late.length - 1));
  check('the in-progress month is never counted as a repeat (lastIdx bound)',
    !sandbox.varStepChange(late, GI['Sep 26'], Object.assign({}, model, { stepRepeatMonths: 1 }), GI['Sep 26']));
}

// ── 2. through the real detector ────────────────────────────────────────────
console.log('\nscanLineFlags — what the flag says and where it ranks');
{
  const ws = noGate(items.waterSewer);
  const plain = base(10000); plain[GI['Jul 26']] = 37000;
  const [p] = scan(ws, plain);
  check('a Water & Sewer +$27K jump flags', !!p && p.reason === 'mom');

  const cred = plain.slice(); cred[GI['Aug 26']] = -25000;
  const [c] = scan(ws, cred);
  check('the same jump with −$25K next month still flags (once)', !!c && c.reason === 'mom' && c.giMonth === GI['Jul 26']);
  check('...with an Important note naming the month and the net change',
    !!c && /credited back in Aug 26 — net change/.test(c.note || ''), c && c.note);
  check('...shown in the flag detail text', !!c && /Important —/.test(c.why));
  check('...one tier lower than without the credit', !!p && !!c && p.urgency !== 'info' && sandbox.demoteTier(p.urgency) === c.urgency, `${p && p.urgency} → ${c && c.urgency}`);
  check('...and tagged "credited back"', !!c && c.adjTag === 'credited back' && /credited back/.test(c.tag));

  const part = plain.slice(); part[GI['Aug 26']] = 4000;     // $6K under the old level: ~22% back
  const [q] = scan(ws, part);
  check('a partial give-back gets the note but keeps its tier', !!q && !!q.note && q.urgency === p.urgency && !q.adjTag, q && `${q.urgency} ${q.note}`);

  const pt = noGate(items.propTax);
  const tax = base(20000).map((v, i) => (i >= GI['Jun 26'] ? 30000 : v));
  const sp = base(20000); sp[GI['Jun 26']] = 30000;          // same jump, one-off
  const [t] = scan(pt, tax), [t0] = scan(pt, sp);
  check('a Property Taxes step up still flags once', !!t && t.giMonth === GI['Jun 26']);
  check('...labelled "new run rate since Jun 26" with $/mo and $/yr',
    !!t && /^New run rate since Jun 26 \(\+\$[\d,]+\/mo, ≈\+\$[\d,]+\/yr\)$/.test(t.note || ''), t && t.note);
  check('...explained as a rate change in the detail', !!t && /repeated 4 months/.test(t.noteDetail) && /rate \/ assessment change/.test(t.noteDetail));
  check('...one tier lower than the same jump as a one-off spike', !!t0 && !!t && t0.urgency !== 'info' && sandbox.demoteTier(t0.urgency) === t.urgency, `${t0 && t0.urgency} → ${t && t.urgency}`);
  check('the one-off spike carries no note', !!t0 && !t0.note);

  const mr = noGate(items.majRepairs);
  const big = base(3000); big[GI['Jul 26']] = 45000; big[GI['Aug 26']] = -40000;
  const [m] = scan(mr, big);
  check('a big single month (major repairs) gets the credit-back reading too', !!m && m.reason === 'singleMonth' && m.adjTag === 'credited back');
}

// ── 2b. after the first production run (2026-10-06) ─────────────────────────
console.log('\nAfter production review — wording and the credit\'s own card');
{
  // Insurance renewal: a big June, then months that just run LOWER — no credit.
  const ins = noGate(items.insurance);
  const s = base(1600); s[GI['Jun 26']] = 14000; s[GI['Jul 26']] = 600; s[GI['Aug 26']] = 500;
  const [f] = scan(ins, s);
  check('months that only ran lower are "given back", not "credited back"',
    !!f && /given back in Jul 26 and Aug 26/.test(f.note || '') && !/credited/.test(f.note), f && f.note);
  check('...and the detail says no credit posted', !!f && /No credit posted/.test(f.noteDetail));

  // Electric: a $300K charge, reversed by a −$300K credit the next month.
  const el = noGate(items.electric);
  const e = base(25000); e[GI['Aug 26']] = 326000; e[GI['Sep 26']] = -300000;
  const all = sandbox.scanLineFlags(scope, el, e, 0, {});
  const jump = all.find(x => x.reason === 'mom'), neg = all.find(x => x.reason === 'negative');
  check('the charge flags, tagged "credited back"', !!jump && jump.adjTag === 'credited back');
  check('the credit\'s negative card says which jump it reverses',
    !!neg && /^Reverses the \$[\d,]+ jump in Aug 26 — net change/.test(neg.note || ''), neg && neg.note);
  check('...and drops one tier (critical → high)', !!neg && neg.urgency === 'high', neg && neg.urgency);
  const over = base(25000); over[GI['Aug 26']] = 60000; over[GI['Sep 26']] = -100000;
  const negOver = sandbox.scanLineFlags(scope, el, over, 0, {}).find(x => x.reason === 'negative');
  check('a credit far bigger than the jump keeps its tier, and says the extra needs explaining',
    !!negOver && negOver.urgency === 'critical' && /Reverses the/.test(negOver.note || '') && /still needs explaining/.test(negOver.noteDetail || ''),
    negOver && `${negOver.urgency} ${negOver.note}`);
  const lone = base(25000); lone[GI['Sep 26']] = -30000;
  const negLone = sandbox.scanLineFlags(scope, el, lone, 0, {}).find(x => x.reason === 'negative');
  check('a credit with no jump before it stays Critical with no note', !!negLone && negLone.urgency === 'critical' && !negLone.note);
}

// ── 2b'. from the 2026-10-13 meeting — credited back is not a flag ──────────
console.log('\nCredited back clears the flag (2026-10-13)');
{
  const ws = noGate(items.waterSewer);
  // A big water month, credited back in full the month after.
  const w = base(10000); w[GI['Aug 26']] = 46000; w[GI['Sep 26']] = -26000;
  const all = sandbox.scanLineFlags(scope, ws, w, 0, {});
  const jump = all.find(x => x.reason === 'mom'), neg = all.find(x => x.reason === 'negative');
  check('a jump a posted credit cancels is cleared automatically', !!jump && !!jump.autoCleared && jump.autoCleared.why === 'credited back', jump && JSON.stringify(jump.autoCleared));
  check('...and so is the credit that cancelled it', !!neg && !!neg.autoCleared, neg && `${neg.note}`);
  // Months that only ran lower (no credit) are not cleared — they still flag.
  const ins = noGate(items.insurance);
  const g = base(1600); g[GI['Jun 26']] = 14000; g[GI['Jul 26']] = 600; g[GI['Aug 26']] = 500;
  const [gf] = scan(ins, g);
  check('"given back" (no credit posted) still flags', !!gf && !gf.autoCleared && /given back/.test(gf.note || ''));
  // A partial credit keeps the flag.
  const half = base(10000); half[GI['Aug 26']] = 46000; half[GI['Sep 26']] = -2000;
  const [hf] = scan(ws, half);
  check('a credit that only gives back part of the jump keeps the flag', !!hf && !hf.autoCleared);
  // A credit far bigger than the jump keeps both.
  const el = noGate(items.electric);
  const over = base(25000); over[GI['Aug 26']] = 60000; over[GI['Sep 26']] = -100000;
  const ov = sandbox.scanLineFlags(scope, el, over, 0, {});
  check('a credit far bigger than the jump is not cleared', ov.every(x => !x.autoCleared));
  // The switch on the rules screen turns it off.
  const was = sandbox._varModel.creditBackClears;
  sandbox._varModel.creditBackClears = false;
  const off = sandbox.scanLineFlags(scope, ws, w, 0, {});
  sandbox._varModel.creditBackClears = was;
  check('with "Credited back — clear the flag" off, both still flag', off.length >= 2 && off.every(x => !x.autoCleared));
  // A credit in the month still in progress counts (the $36K water bill credited
  // in October, before October closed) — but a partial month that merely runs low
  // does not.
  const cp = base(10000); cp[GI['Sep 26']] = 46000; cp[GI['Oct 26']] = -30000;
  const cb = sandbox.varCreditBack(cp, GI['Sep 26'], model, GI['Sep 26']);
  check('a credit posted in the in-progress month counts as credited back', !!cb && cb.most && cb.months.some(m => m.partial && m.credit));
  const lp = base(10000); lp[GI['Sep 26']] = 46000; lp[GI['Oct 26']] = 2000;
  check('a low in-progress month (no credit) does not count', !sandbox.varCreditBack(lp, GI['Sep 26'], model, GI['Sep 26']));
}

// ── 2c. from the 2026-10-06 meeting ─────────────────────────────────────────
console.log('\nMeeting follow-ups — billing cycle, missed bill, repeated swings, payroll trend');
{
  // A longer synthetic history for the cycle cases: 26 complete months.
  const LONG = ['Aug 24', 'Sep 24', 'Oct 24', 'Nov 24', 'Dec 24', 'Jan 25', 'Feb 25', 'Mar 25', 'Apr 25', 'May 25',
    'Jun 25', 'Jul 25', 'Aug 25', 'Sep 25', 'Oct 25', 'Nov 25', 'Dec 25', 'Jan 26', 'Feb 26', 'Mar 26', 'Apr 26',
    'May 26', 'Jun 26', 'Jul 26', 'Aug 26', 'Sep 26'];
  const LG = Object.fromEntries(LONG.map((m, i) => [m, i]));
  const saved = sandbox._liveData;
  sandbox._liveData = { months: LONG, partialCurrentMonth: false };
  const ws = noGate(items.waterSewer);
  // Quarterly sewer: ~$3K months, ~$15K every Feb / May / Aug / Nov.
  // The due Aug 26 spike is a little over the ones before (+8%) — enough to sit
  // just above the trailing range, like 2301 Willow Creek Rd in May 26 — but the usual size.
  const qtr = LONG.map((m, i) => (/^(Feb|May|Aug|Nov)/.test(m) ? 15000 + (i % 2) * 300 : 2800 + (i % 3) * 60));
  qtr[LG['Aug 26']] = 16300;
  const [q] = sandbox.scanLineFlags(scope, ws, qtr, 0, {}).filter(f => f.reason === 'mom');
  check('a due, usual-size quarterly spike still flags', !!q);
  check('...labelled "billing cycle" and one tier lower',
    !!q && q.adjTag === 'billing cycle' && /every-3-month spike/.test(q.note || ''), q && `${q.urgency} ${q.adjTag} ${q.note}`);
  sandbox._varModel = Object.assign({}, model, { demoteOnCycle: false });
  const qOff = sandbox.scanLineFlags(scope, ws, qtr, 0, {}).find(f => f.reason === 'mom' && f.giMonth === q.giMonth);
  sandbox._varModel = model;
  check('...and switching that off on the rules screen restores the tier',
    !!qOff && !qOff.adjTag && sandbox.demoteTier(qOff.urgency) === q.urgency, qOff && qOff.urgency);

  const big = qtr.slice(); big[LG['Aug 26']] = 26000;            // due, but far bigger
  const b = sandbox.scanLineFlags(scope, ws, big, 0, {}).find(f => f.reason === 'mom' && f.giMonth === LG['Aug 26']);
  check('a cycle spike well above the usual size is NOT lowered', !!b && b.adjTag !== 'billing cycle', b && b.adjTag);

  // Robust drift: one low early peak must not read as a climbing cycle.
  const flatPeaks = qtr.slice(); flatPeaks[LG['Nov 24']] = 9700;
  const cyc = sandbox.varSpikeCycle(flatPeaks, LG['May 26'], model);
  check('one low early peak does not make flat spikes read as "+20%/yr"',
    !!cyc && Math.abs(cyc.trendPctPerYear) < model.cycle.trendPctPerYear, cyc && cyc.trendPctPerYear);

  // The missed bill: the Aug 26 spike never posts.
  const miss = qtr.slice(); miss[LG['Aug 26']] = 2750; miss[LG['Sep 26']] = 3100;
  const m = sandbox.scanLineFlags(scope, ws, miss, 0, {}).find(f => f.reason === 'missedCycle');
  check('a quarterly bill that never posted flags as a missed cycle bill', !!m && m.monthLabel === 'Aug 26' && m.category === 'zero', m && m.monthLabel);
  check('...naming the cycle and the months', !!m && /every-3-month bill due in Aug 26/.test(m.note));
  const late = qtr.slice(); late[LG['Aug 26']] = 2750; late[LG['Sep 26']] = 15200;   // a month late
  check('a bill one month late is not "missing"', !sandbox.scanLineFlags(scope, ws, late, 0, {}).some(f => f.reason === 'missedCycle'));
  const rep = sandbox.scanLineFlags(scope, noGate(items.majRepairs), miss, 0, {});
  check('a repairs line with spaced spikes never gets a missed-bill flag (not a billed line)', !rep.some(f => f.reason === 'missedCycle'));
  const irrQ = sandbox.scanLineFlags(scope, ws, qtr, 0, {}).find(f => f.reason === 'mom');
  check('a quarterly line is never called "irregular" for its own cycle', !!irrQ && !(irrQ.irregular || []).length);
  // Seasonal: water climbed Jul → Aug last year by about as much as this year.
  const seas = LONG.map(() => 6000).map((v, i) => v + (i % 3) * 40);
  seas[LG['Aug 25']] = 11000; seas[LG['Aug 26']] = 12000;
  const sf = sandbox.scanLineFlags(scope, ws, seas, 0, {}).find(f => f.reason === 'mom' && f.giMonth === LG['Aug 26']);
  check('a seasonal climb last year made too is labelled "seasonal", one tier lower',
    !!sf && sf.adjTag === 'seasonal', sf && `${sf.urgency} ${sf.adjTag}`);
  const unseas = seas.slice(); unseas[LG['Aug 25']] = 6100;
  const uf = sandbox.scanLineFlags(scope, ws, unseas, 0, {}).find(f => f.reason === 'mom' && f.giMonth === LG['Aug 26']);
  check('...and without last year\'s climb it keeps its tier', !!uf && !uf.adjTag && !!sf && sandbox.demoteTier(uf.urgency) === sf.urgency, uf && uf.urgency);
  check('a line with no cycle never gets a missed-bill flag', !sandbox.scanLineFlags(scope, ws, LONG.map(() => 5000), 0, {}).some(f => f.reason === 'missedCycle'));

  // Payroll trend: ~$40K/mo up to ~$50K/mo year over year (+25%).
  const pay = LONG.map((_, i) => (i >= LONG.length - 12 ? 50000 : 40000) + (i % 3) * 100);
  const t = sandbox.scanLineFlags(scope, noGate(items.payroll), pay, 0, {}).find(f => f.reason === 'trend');
  check('payroll whose run rate grew 25% year over year flags as a trend', !!t && t.category === 'variance' && t.pct > 0.2, t && t.pct);
  check('...sized to the annual increase', !!t && Math.round(t.impact / 1000) === 120, t && t.impact);
  const steady = LONG.map((_, i) => 40000 + (i % 3) * 100);
  check('steady payroll does not', !sandbox.scanLineFlags(scope, noGate(items.payroll), steady, 0, {}).some(f => f.reason === 'trend'));
  check('lines without the trend switch never get one',
    !sandbox.scanLineFlags(scope, noGate(items.electric), pay, 0, {}).some(f => f.reason === 'trend'));
  const tr3 = sandbox.varRunRateTrend(LONG.concat(LONG).map((_, i) => 1000 + i * 10), 51);
  check('with 3+ years of history the trend compares every year (multi-year)', !!tr3 && tr3.steps.length >= 3, tr3 && tr3.steps.length);
  sandbox._liveData = saved;

  // Repeated swings: management fees bouncing three months in the window.
  // 96/98 Maple Court shape: Mar, May and Jun entries far off the ~$2.6K normal.
  const fees = base(2600); fees[GI['Mar 26']] = 20800; fees[GI['Apr 26']] = 2600;
  fees[GI['May 26']] = 15500; fees[GI['Jun 26']] = 21300; fees[GI['Jul 26']] = 2570;
  const fl = scan(noGate(items.mgmtFees), fees)[0];
  check('a line that swung in 3+ of the last 12 months says so on its card (reads past the window)',
    !!fl && /Irregular in \d+ of the last 12 months/.test(fl.note || '') && (fl.irregular || []).includes('Mar 26'), fl && fl.note);
  const once = base(2600); once[GI['Jun 26']] = 21300;
  const fo = scan(noGate(items.mgmtFees), once)[0];
  check('...and a single swing does not', !!fo && !(fo.irregular || []).length);
}

// ── 2d. the 1–5 importance score and the 2026-10-07 audit readings ────────
console.log('\nImportance score (1–5) and the audit readings');
{
  const L = sandbox._liveData.months;
  const ws = noGate(items.waterSewer);
  const score = (series, opex) => {
    const f = scan(ws, series)[0];
    return f && sandbox.varScoreFlag(f, series, opex == null ? 400000 : opex, L);
  };
  // Same jump; one year it is new, the other year last year did the same thing.
  const fresh = base(4000); fresh[GI['Oct 26']] = 12000;
  const repeat = fresh.slice(); repeat[GI['Sep 25']] = 4000; repeat[GI['Oct 25']] = 11000;
  const a = score(fresh), b = score(repeat);
  check('every flag gets a 1–5 score with its parts written out',
    !!a && a.score >= 1 && a.score <= 5 && a.scoreParts.length === 4 && a.scoreParts.every(p => p.text), a && a.score);
  check('the same jump scores LOWER when last year made the same move (seasonal)',
    !!a && !!b && b.scoreRaw < a.scoreRaw && /looks seasonal/.test(b.scoreParts.find(p => p.key === 'lastYear').text),
    `${a && a.scoreRaw} vs ${b && b.scoreRaw}`);
  check('"vs normal" compares to the T12 average AND the year-to-date average',
    !!a && /T12 avg/.test(a.scoreParts.find(p => p.key === 'normal').text) && /YTD avg/.test(a.scoreParts.find(p => p.key === 'normal').text));
  const big = score(fresh, 100000), small = score(fresh, 5000000);
  check('the same dollars score higher at a small building than in a big scope', big.scoreRaw > small.scoreRaw, `${big.scoreRaw} vs ${small.scoreRaw}`);
  const older = base(4000); older[GI['May 26']] = 12000;
  const o = score(older);
  check('an older month scores lower on recency', !!o && o.scoreParts.find(p => p.key === 'recency').pts < a.scoreParts.find(p => p.key === 'recency').pts);
  const cred = base(4000); cred[GI['Jul 26']] = 12000; cred[GI['Aug 26']] = -7000;
  const c = scan(ws, cred).find(f => f.reason === 'mom');
  sandbox.varScoreFlag(c, cred, 400000, L);
  check('an explained flag (credited back) loses points and says why',
    !!c && c.scoreAdj.some(x => x.pts < 0 && /credited back/.test(x.label)), c && JSON.stringify(c.scoreAdj));
  check('...and its size is the NET, not the gross jump',
    !!c && /net, after what came back/.test(c.scoreParts.find(p => p.key === 'size').text));
  // Timing (2026-10-16): a low month, then the jump, averaging out to about normal
  // is one bill landing a month late — a point off, and the card says so.
  const late = base(4000); late[GI['Sep 26']] = 1200; late[GI['Oct 26']] = 8000;
  const t = scan(ws, late).find(f => f.reason === 'mom' && f.giMonth === GI['Oct 26']);
  if (t) sandbox.varScoreFlag(t, late, 400000, L);
  const tj = scan(ws, fresh).find(f => f.reason === 'mom');
  check('a jump right after a low month that averages out to normal loses a point for timing',
    !!t && t.scoreAdj.some(x => x.pts < 0 && /^timing/.test(x.label)), t && JSON.stringify(t.scoreAdj));
  check('...and a plain jump after a normal month does not', !!a && !a.scoreAdj.some(x => /^timing/.test(x.label)));

  // Top 10: most important first, and one card per entity-wide issue.
  const mk = (id, sc, ew) => ({ scope: { key: id, type: 'Property', label: id }, key: ew ? 'propTax' : `k${id}`, reason: 'zero', monthLabel: 'Jul 26',
    urgency: 'high', impact: 1000, scoreRaw: sc, entityWide: ew ? { entity: 'Summit Lofts', month: 'Jul 26', n: 5 } : null });
  const list = [mk('a', 9, true), mk('b', 8.9, true), mk('c', 8.8, true), mk('d', 5), mk('e', 6), mk('f', 4), mk('g', 3), mk('h', 7), mk('i', 2), mk('j', 2.5), mk('k', 1.5), mk('l', 1.2)];
  const top = sandbox.varTopFlags(list);
  check('the top 10 is ordered by score', top.every((f, i) => i === 0 || top[i - 1].scoreRaw >= f.scoreRaw));
  check('...and an entity-wide issue takes ONE slot, not one per building', top.filter(f => f.entityWide).length === 1, top.map(f => f.scope.key).join(','));

  // Limits sized to the building (2026-10-19): a small building needs fewer
  // dollars and a bigger percent; a big one more dollars and a smaller percent.
  {
    const keep = sandbox._varModel.sizeScale, keepSeries = sandbox.__series;
    sandbox._varModel.sizeScale = { ...keep, enabled: true };
    sandbox._varSizeCache.stamp = 'x'; sandbox._varSizeCache.map.clear();
    sandbox.__series = Array(L.length).fill(10000);          // ~$120K a year
    const small = sandbox.varTune({ key: 'prop:small', type: 'Property' });
    sandbox._varSizeCache.map.clear();
    sandbox.__series = Array(L.length).fill(700000);         // ~$8.4M a year
    const big = sandbox.varTune({ key: 'prop:big', type: 'Property' });
    check('a small building needs fewer dollars and a bigger percent', small.sized && small.impactMul < 0.5 && small.pctMul > 1.5, JSON.stringify(small));
    check('a big building needs more dollars and a smaller percent', big.sized && big.impactMul > 2.5 && big.pctMul < 0.7, JSON.stringify(big));
    check('a bare scope type still reads the flat tuning', !sandbox.varTune('Entity').sized);
    sandbox._varModel.sizeScale = keep; sandbox.__series = keepSeries; sandbox._varSizeCache.map.clear();
  }

  // Caught up: blank May, double June.
  const fees = noGate(items.mgmtFees);
  const cu = base(17000); cu[GI['May 26']] = 0; cu[GI['Jun 26']] = 34000;
  const z = sandbox.scanLineFlags(scope, fees, cu, 0, {}).find(f => f.reason === 'zero');
  check('a blank month followed by ~2× normal reads "caught up", one tier lower',
    !!z && z.adjTag === 'caught up' && /Caught up in Jun 26/.test(z.note) && z.urgency === 'watch', z && `${z.urgency} ${z.note}`);
  const nz = base(17000); nz[GI['May 26']] = 0;
  const z2 = sandbox.scanLineFlags(scope, fees, nz, 0, {}).find(f => f.reason === 'zero');
  check('...a blank month nobody caught up stays where it was', !!z2 && !z2.adjTag && z2.urgency === 'high');

  // Entity-wide and booked-to-one.
  const pf = (id, extra) => Object.assign({ scope: { key: `prop:${id}`, type: 'Property', label: id, entity: 'Cedar Ridge' }, key: 'propTax', label: 'Property Taxes',
    reason: 'zero', category: 'zero', monthLabel: 'Jul 26', zeroMonthLabels: ['Jul 26'], giMonth: GI['Jul 26'], urgency: 'high' }, extra || {});
  const ew = [pf('1'), pf('2'), pf('3'), pf('4', { scope: { key: 'prop:4', type: 'Property', label: '4', entity: 'Willow Creek' } })];
  sandbox.varCrossScopeReadings(ew);
  check('the same blank at 3 properties of one entity is marked entity-wide on each',
    ew.slice(0, 3).every(f => f.entityWide && f.entityWide.n === 3 && /Same on 2 other Cedar Ridge properties/.test(f.note)) && !ew[3].entityWide);
  const ent = base(33000);                               // the entity's normal month
  const savedFS = sandbox.fullSeries;
  sandbox.fullSeries = (k) => (k === 'Cedar Ridge' ? ent : savedFS(k));
  const booked = pf('108', { key: 'mgmtFees', label: 'Management Fees', reason: 'mom', category: 'variance', curr: 33467, prev: 480, histAvg: 530 });
  sandbox.varCrossScopeReadings([booked]);
  sandbox.fullSeries = savedFS;
  check('one property carrying the whole entity\'s month is called an allocation error (108 60th Street)',
    !!booked.bookedToOne && /landed on this property/.test(booked.note), booked.note);
}

// ── 3. the sub-account panel names who took the credit ─────────────────────
console.log('\nvarSubFlags — which sub-account got the credit');
{
  const water = base(6000), sewer = base(4000);
  water[GI['Jul 26']] = 9000;               // +3K on water
  sewer[GI['Jul 26']] = 28000;              // +24K on sewer — the jump
  sewer[GI['Aug 26']] = -21000;             // ...and sewer gives it back
  const line = water.map((v, i) => v + sewer[i]);
  sandbox.__series = line;
  sandbox.__acct = { months: MONTHS, lines: { waterSewer: [
    { kind: 'leaf', name: 'Water', s: water }, { kind: 'leaf', name: 'Sewer', s: sewer },
  ] } };
  const [f] = scan(noGate(items.waterSewer), line);
  const sf = f && sandbox.varSubFlags(f);
  check('the line flag carries the credit back', !!f && !!f.creditBack);
  check('the panel names Sewer as the account that took the credit',
    !!sf && !!sf.creditBack && sf.creditBack.rows.length === 1 && sf.creditBack.rows[0].name === 'Sewer',
    sf && JSON.stringify(sf.creditBack));
  check('...and not Water, which did not give anything back',
    !!sf && sf.rows.find(r => r.name === 'Water').gave === 0);
  check('the jump itself is still put on Sewer', !!sf && sf.rows.find(r => r.name === 'Sewer').sub === true);
}

// ── 4. the knobs live in the config and are editable ───────────────────────
console.log('\nKnobs');
{
  const { MODEL_FIELDS } = require('../services/varianceRuleOverrides');
  ['creditBackMonths', 'creditBackNotePct', 'creditBackMostPct', 'stepTolerancePct', 'stepRepeatMonths'].forEach(k => {
    check(`${k} has a default in varianceConfig and a field on the rules screen`, model[k] != null && !!MODEL_FIELDS[k]);
  });
  check('defaults: credited back clears; books close the 15th, review the 18th',
    model.creditBackClears === true && model.closeDay === 15 && model.reviewDay === 18);
  check('defaults: 2 months, 10% note, 80% "most", ±5%, 2 repeats',
    model.creditBackMonths === 2 && model.creditBackNotePct === 0.10 && model.creditBackMostPct === 0.80
    && model.stepTolerancePct === 0.05 && model.stepRepeatMonths === 2);
}

console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
