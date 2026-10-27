#!/usr/bin/env node
// Proves the Variance tab's month window without calling Rent Manager.
//
// The owner, 2026-08-20: "the main pull should only be the twelve months" — because
// the figures on this tab get compared cell-by-cell against a T12 P&L export run
// out of RM, and last time some of them did not tie. Two separate things have to
// hold for that comparison to be fair, and neither of them is visible by reading
// the tab:
//
//   1. The displayed window really is a trailing 12 COMPLETE months plus the
//      in-progress month, with the same-month-last-year column carried BESIDE it
//      rather than inside it (a 14th value inside the window would shift every
//      month by one and mis-attribute every flag).
//   2. Those twelve months come back from ONE report run. RM caps a report at 12
//      month columns, so a window that straddles the cap gets stitched from two
//      runs — and a seam inside the T12 is exactly where a month can go missing.
//
// Plus the rule that came out of the August "numbers don't match" review: an
// incremental refresh must re-pull EVERY month the grid can display. Replaying a
// displayed month from an older snapshot is how a restated month stayed wrong on
// the tab indefinitely, with Refresh unable to fix it.
//
// Holds no financial figures (repo policy) — these are identities about the
// window, so they stay valid whatever the books say.
//
//   node scripts/checkVarianceWindow.js            # against today
//   node scripts/checkVarianceWindow.js 2026-01    # or any as-of month

const pf = require('../services/propertyFinancials');

const asOf = process.argv[2] || null;
let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
}

// The frontend's own slice, transcribed from t12Window() in public/index.html:
// n = 12 + (in-progress month ? 1 : 0) taken off the END, and the last-year column
// read separately at lastComplete - 12.
function frontendWindow(monthLabels, partialCurrentMonth) {
  const n = Math.min(monthLabels.length, 12 + (partialCurrentMonth ? 1 : 0));
  const start = monthLabels.length - n;
  const lastCompleteGi = monthLabels.length - 1 - (partialCurrentMonth ? 1 : 0);
  const lyGi = lastCompleteGi - 12;
  return {
    displayed: monthLabels.slice(start),
    lyLabel: lyGi >= 0 ? monthLabels[lyGi] : null,
    lyGi,
  };
}

function runFor(toYM) {
  const [ty, tm] = toYM.split('-').map(Number);
  const fromYM = pf.pullWindowFrom(new Date(ty, tm - 1, 15));   // DEFAULT_FROM(): rolling 36 months back
  const months = pf.enumerateMonths(fromYM, toYM);
  const labels = months.map(m => m.label);
  console.log(`\nAs of ${toYM} — pull window ${fromYM} → ${toYM} (${months.length} months)`);

  // ── 1. the displayed window ────────────────────────────────────────────────
  for (const partial of [true, false]) {
    const fe = frontendWindow(labels, partial);
    const complete = partial ? fe.displayed.slice(0, -1) : fe.displayed;
    check(`grid shows 12 complete months${partial ? ' + the in-progress month' : ''} (${fe.displayed.length} columns)`,
      complete.length === 12 && fe.displayed.length === (partial ? 13 : 12),
      `got ${fe.displayed.length} columns, ${complete.length} complete`);
    check(`last-year column sits OUTSIDE the 12 (${fe.lyLabel} vs window starting ${fe.displayed[0]})`,
      fe.lyLabel != null && fe.displayed.indexOf(fe.lyLabel) === -1,
      `ly=${fe.lyLabel} appears inside the displayed window`);
    check(`last-year column is exactly 12 months before the newest complete month`,
      fe.lyGi >= 0 && labels[fe.lyGi + 12] === complete[complete.length - 1],
      `ly=${labels[fe.lyGi]} vs newest complete ${complete[complete.length - 1]}`);
  }

  // ── 2. one report run for the twelve ──────────────────────────────────────
  const chunks = pf.chunkTrailing(months);
  const newest = chunks[0].map(m => m.label);
  const fe = frontendWindow(labels, true);
  const complete = fe.displayed.slice(0, -1);
  check(`newest report run carries ${pf.MAX_MONTH_COLS} months, no more (RM's column cap)`,
    chunks.every(c => c.length <= pf.MAX_MONTH_COLS) && newest.length === pf.MAX_MONTH_COLS,
    `newest chunk = ${newest.length} months`);
  // 13 displayed columns cannot come from one run — RM caps a report at 12 columns —
  // so the question is WHERE the seam falls, not whether there is one. Chunking
  // backwards from the newest month puts the seam at the OLDEST displayed month and
  // nowhere else: the in-progress month and the eleven complete months before it are
  // one run. (reconcileVariancePL check C proves the stitch itself is exact to the
  // cell; this asserts the seam has not drifted into the middle of the window, which
  // is what calendar-year chunking used to do.)
  const outside = fe.displayed.filter(l => newest.indexOf(l) === -1);
  check('at most one seam inside the displayed window, and it falls at its oldest month',
    outside.length <= 1 && (outside.length === 0 || outside[0] === fe.displayed[0]),
    `outside the newest run: ${outside.join(', ') || 'none'}`);
  check('the newest run covers the in-progress month and the 11 complete months before it',
    fe.displayed.slice(1).every(l => newest.indexOf(l) !== -1),
    `missing from the newest run: ${fe.displayed.slice(1).filter(l => newest.indexOf(l) === -1).join(', ')}`);
  check('both sides of that seam are re-pulled in the SAME refresh (never half-stale)',
    outside.every(l => pf.refreshWindow(months, labels, ty).some(m => m.label === l)));
  check('the chunks cover the whole range exactly once',
    chunks.reduce((n, c) => n + c.length, 0) === months.length &&
      new Set(chunks.flat().map(m => m.label)).size === months.length);

  // ── 3. an incremental refresh re-pulls everything the grid can display ─────
  const baselineLabels = labels.slice();               // a snapshot covering the same range
  const toPull = pf.refreshWindow(months, baselineLabels, ty).map(m => m.label);
  for (const partial of [true, false]) {
    const w = frontendWindow(labels, partial);
    const missed = w.displayed.filter(l => toPull.indexOf(l) === -1);
    check(`incremental refresh re-pulls every displayed month (in-progress month ${partial ? 'open' : 'closed'})`,
      missed.length === 0, `never re-pulled: ${missed.join(', ')}`);
    check(`incremental refresh re-pulls the last-year column (${w.lyLabel})`,
      w.lyLabel == null || toPull.indexOf(w.lyLabel) !== -1);
  }
  check('a first build with no baseline pulls the whole range',
    pf.refreshWindow(months, null, ty).length === months.length);
  check(`incremental refresh stays cheap — ${toPull.length} months, under two report runs per property`,
    Math.ceil(toPull.length / pf.MAX_MONTH_COLS) <= 2, `${toPull.length} months = ${Math.ceil(toPull.length / pf.MAX_MONTH_COLS)} runs`);
}

console.log('Variance tab — month window checks (no Rent Manager calls, no figures)');
if (asOf) runFor(asOf);
else {
  const now = new Date();
  runFor(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  // A January as-of is the case that breaks naive windowing: the trailing 12 and
  // the last-year column both reach back across two calendar-year boundaries.
  runFor(`${now.getFullYear()}-01`);
}
// ── 2026-10-07: a refresh list with a gap must never become one wide request ──
// The first incremental refresh after the window grew to 36 months pulled the new
// year (Oct 23 – Nov 24) plus the displayed months (Sep 25 on) and chunked them as
// if contiguous: one run asked RM for Feb 24 → Oct 25 (21 months, RM caps at 12)
// and Sep/Oct 25 came back empty.
console.log('\nRefresh chunks with a gap');
{
  const all = pf.enumerateMonths('2023-10', '2026-10');
  const baseline = pf.enumerateMonths('2024-12', '2026-10').map(m => m.label);
  const sub = pf.refreshWindow(all, baseline, 2026);
  const chunks = pf.chunkTrailing(sub);
  const span = c => (c[c.length - 1].year * 12 + c[c.length - 1].m0) - (c[0].year * 12 + c[0].m0) + 1;
  check('every chunk covers consecutive months only (first→last spans exactly its length)',
    chunks.every(c => span(c) === c.length), chunks.map(c => `${c[0].label}→${c[c.length - 1].label} (${c.length}/${span(c)})`).join(', '));
  check(`no request spans more than ${pf.MAX_MONTH_COLS} calendar months`, chunks.every(c => span(c) <= pf.MAX_MONTH_COLS));
  check('every month in the refresh list is requested exactly once',
    chunks.flat().length === sub.length && new Set(chunks.flat().map(m => m.label)).size === sub.length);
}
console.log(`\n${fails ? '✗' : '✓'} ${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
