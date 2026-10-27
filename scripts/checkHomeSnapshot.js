#!/usr/bin/env node
// Proves the Home snapshot (services/homeSnapshot.js): the one thing every
// signed-in person can read on Home, written by browsers that hold the data.
//
//   1. A poster only changes the sections their tools own - a Portfolio person
//      cannot overwrite the variances, a Variances person cannot overwrite grades.
//   2. Junk from a browser is rebuilt field by field: strings are capped, a
//      chart whose series do not line up with its months is refused.
//   3. The latest underwriting deal reaches Home as name, size, date and a
//      meets/below verdict - never a price, IRR or NOI.
//
// Run: npm run check:home-snapshot

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'home-snap-'));
process.env.HOME_SNAPSHOT_FILE = path.join(tmp, 'home-snapshot.json');
const hs = require('../services/homeSnapshot');

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
}
const canOnly = (...tools) => t => tools.includes(t);

const full = {
  scorecard: { score: 78, grade: 'B', count: 13, atB: 8,
    best: [{ e: 'Demo Portfolio', grade: 'A', score: 94, note: 'Strong coverage' }, { e: 'The Alder', grade: 'A', score: 90, note: '' }],
    worst: [{ e: 'Willow Creek', grade: 'D', score: 51, note: 'Occupancy' }] },
  chart: { months: ['Jan 26', 'Feb 26', 'Mar 26'], noi: [100, 110, 120], debt: [60, 60, 60], dscr: [1.4, 1.5, 1.6] },
  variances: [{ dot: 'R', scope: 'Willow Creek', line: 'Water & Sewer', month: 'Sep 26', tag: 'x', score: 5, impact: 99999 }],
  health: {
    entities: [{ id: 'dscr', sev: 'warn', text: 'Debt coverage is under the lender minimum' }],
    delinquency: [{ id: 'dq', sev: 'bad', text: 'Delinquency is high' }],
    variances: [{ id: 'var', sev: 'ok', text: 'Variance scan clean' }],
  },
};
const SEVRANK = { bad: 0, warn: 1, ok: 2 };

console.log('\nWho may post what');
{
  let taken = hs.merge(full, canOnly('entities'));
  check('a Portfolio person posts grades, chart and the debt-coverage lines only',
    taken.slice().sort().join() === 'chart,health:entities,scorecard');
  let r = hs.read();
  check('...so the variances and the delinquency line are not there', r.variances === null && !r.health.some(l => l.src === 'delinquency'));
  taken = hs.merge(full, canOnly('variances'));
  check('a Variances person then adds the variances and their health line', taken.slice().sort().join() === 'health:variances,variances');
  r = hs.read();
  check('...and the grades survive that post', r.scorecard && r.scorecard.grade === 'B' && r.scorecard.best.length === 2);
  taken = hs.merge(full, canOnly('overview'));
  check('someone with only Home posts nothing', taken.length === 0);
  hs.merge({ ...full, scorecard: { ...full.scorecard, grade: 'C' } }, canOnly('entities'));
  check('a newer post replaces the section whole', hs.read().scorecard.grade === 'C');
  hs.merge(full, canOnly('delinquency'));
  r = hs.read();
  check('health lines come back worst first, each tagged with its source',
    r.health.length === 3 && r.health.every((l, i, a) => i === 0 || SEVRANK[a[i - 1].sev] <= SEVRANK[l.sev]) && r.health.every(l => l.src));
  check('the variance dollars a browser sent are not kept', !JSON.stringify(r.variances).includes('99999'));
}

console.log('\nBrowser input is rebuilt, not trusted');
{
  hs.merge({ chart: { months: ['a', 'b'], noi: [1], debt: [1, 2], dscr: [1, 2] } }, canOnly('entities'));
  check('a chart whose series do not match its months is refused', hs.read().chart.months.length === 3);
  hs.merge({ chart: { months: ['Jan 26'], noi: ['x'], debt: [null], dscr: [Infinity] } }, canOnly('entities'));
  const c = hs.read().chart;
  check('non-numbers become null, never NaN or a string', c.months.length === 1 && c.noi[0] === null && c.dscr[0] === null);
  const long = 'x'.repeat(5000);
  hs.merge({ health: { entities: [{ id: 'a', sev: '<script>', text: long }, { id: '', sev: 'bad', text: 'no id' }] } }, canOnly('entities'));
  const line = hs.read().health.find(l => l.id === 'a');
  check('text is capped, an unknown severity falls back, a line with no id is dropped',
    line && line.text.length <= 220 && line.sev === 'warn' && !hs.read().health.some(l => l.text === 'no id'));
  hs.merge({ scorecard: 'not an object', variances: 'nope' }, canOnly('entities', 'variances'));
  check('garbage in a section leaves nothing broken', hs.read().scorecard.grade === 'C' && Array.isArray(hs.read().variances.items));
  fs.writeFileSync(process.env.HOME_SNAPSHOT_FILE, '{not json');
  const r = hs.read();
  check('a corrupt file reads as an empty Home, not a crash', r.scorecard === null && r.health.length === 0);
}

console.log('\nLatest underwriting deal');
{
  const card = o => ({ computed: true, name: 'Casa Bella', address: '1 Main St, Miami OH', units: 48, price: 9000000, irr: 0.21, irr_target: 0.16, meets_target: true, t12_noi: 600000, ...o });
  const props = [
    { name: 'Old', hidden: false, run_count: 1, latest: { created: '2026-09-01T10:00:00Z', card: card({ name: 'Old', meets_target: false }) } },
    { name: 'Casa Bella', hidden: false, run_count: 3, latest: { created: '2026-10-21T10:00:00Z', card: card({}) } },
    { name: 'Hidden', hidden: true, run_count: 0, latest: { created: '2026-10-22T10:00:00Z', card: card({ name: 'Hidden' }) } },
  ];
  const d = hs.latestDeal(props);
  check('the newest live run is chosen, hidden deals skipped', d && d.name === 'Casa Bella' && d.ranOn === '2026-10-21' && d.runs === 3);
  check('it says whether the model cleared its target', d.verdict === 'meets' && hs.latestDeal([props[0]]).verdict === 'below');
  const text = JSON.stringify(d);
  // 2026-10-22 (the owner): the deal box now shows the deal's real numbers, so this
  // is the one place price, IRR and NOI do reach Home. A deal flagged NEEDS REVIEW
  // still withholds price and returns.
  check('the deal carries its IRR, cash-on-cash, buy price at target and score for the box', d.irr === 0.21 && d.buyPrice == null && typeof d.score === 'number' && d.grade && !('price' in d) && !('t12Noi' in d));
  check('the buy price is the max price that clears the target IRR', hs.latestDeal([{ name: 'M', hidden: false, run_count: 1, latest: { created: '2026-10-22T10:00:00Z', card: card({ max_price: 8000000, coc: 0.07, gap_pct: 0.1 }) } }]).buyPrice === 8000000);
  const flagged = hs.latestDeal([{ name: 'Bad', hidden: false, run_count: 1, latest: { created: '2026-10-22T10:00:00Z', card: card({ needs_review: true, review_reasons: ['Occupancy is 39.8%'] }) } }]);
  check('the latest deal carries the board key so Home can open its analysis', d.key === '' || typeof d.key === 'string');
  check('a deal that needs review withholds price and returns, and says why', flagged.verdict === 'review' && flagged.buyPrice === null && flagged.irr === null && flagged.score === null && flagged.problems.length === 1);
  const unsolved = hs.latestDeal([{ name: 'U', hidden: false, run_count: 1, latest: { created: '2026-10-22T10:00:00Z', card: card({ irr: null, irr_failed: true, meets_target: false }) } }]);
  check('an unsolved IRR is reported as unsolved, with a reason', unsolved.irr === null && unsolved.problems.length === 1 && unsolved.unsolvedCount === 1);
  check('no deals reads as null', hs.latestDeal([]) === null);
  // the box must never read as empty: the newest runs were flagged and withheld their numbers
  const board = [
    { key: 'ok', name: 'Overlook', hidden: false, run_count: 1, latest: { created: '2026-10-22T17:00:00Z', card: card({ name: 'Overlook', irr: 0.187, meets_target: true, max_price: 95e6, coc: 0.089 }) } },
    { key: 'h', name: 'Hilliard', hidden: false, run_count: 1, latest: { created: '2026-10-22T19:00:00Z', card: card({ name: 'Hilliard', irr: null, irr_failed: true, needs_review: true, review_reasons: ['The equity multiple is negative (-0.45x)'] }) } },
    { key: 'a', name: 'Avondale', hidden: false, run_count: 1, latest: { created: '2026-10-22T21:00:00Z', card: card({ name: 'Avondale', irr: null, irr_failed: true, needs_review: true, review_reasons: ['Occupancy is 39.8%'] }) } },
  ];
  const shown = hs.latestDeal(board);
  const withFix = hs.latestDeal([Object.assign({}, board[2], { latest: Object.assign({}, board[2].latest, { card: Object.assign({}, board[2].latest.card, { review_fix: ['Send the asking price.'] }) }) }), board[0]]);
  check('a flagged run carries its what-would-fix-it line to Home', withFix.newerNotScored[0].fix === 'Send the asking price.');
  check('with the two newest runs flagged, the box shows the latest SCORED deal with its numbers', shown.name === 'Overlook' && shown.irr === 0.187 && shown.coc === 0.089 && shown.buyPrice === 95e6 && typeof shown.score === 'number' && shown.noneSolved === false);
  check('...and lists the newer runs that could not be scored, newest first, each with its reason and no numbers',
    shown.newerNotScored.length === 2 && shown.newerNotScored[0].name === 'Avondale' && /39\.8%/.test(shown.newerNotScored[0].reason) && shown.newerNotScored[1].name === 'Hilliard' && !('irr' in shown.newerNotScored[0]) && shown.newerNotScored.every(n => n.needsReview));
  check('a flagged deal never becomes the headline while a scored one exists', shown.verdict !== 'review' && shown.problems.length === 0);
  const nothing = hs.latestDeal(board.slice(1));
  check('when no deal has a result the box says so (noneSolved) and still names the newest run and why', nothing.noneSolved === true && nothing.name === 'Avondale' && nothing.irr === null && nothing.problems.length >= 1 && nothing.newerNotScored.length === 0);
  check('the newest scored deal is shown even when it is the newest run (nothing newer to list)', hs.latestDeal(board.slice(0, 1)).newerNotScored.length === 0);
}

console.log('\nThe page: Home is general and display-only');
{
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const home = page.slice(page.indexOf('<div id="page-overview"'), page.indexOf('<div id="page-entities"'));
  // Everything that can be clicked in Home's own markup: the refresh button, the Ask box and
  // the news links (public articles). The two doors into a tool (the deal box and the scorecard,
  // 2026-10-22) are drawn by homeRender and are checked below.
  const handlers = [...home.matchAll(/onclick="([^"]*)"/g)].map(m => m[1]);
  const allowed = h => /^(runGlobalRefresh|ddAsk|ddMic|askOpenWith)\(/.test(h);
  check('no element in Home\'s markup navigates into a tool', handlers.every(allowed), handlers.filter(h => !allowed(h)).join(' | '));
  const rend = page.slice(page.indexOf('function homeRender(s) {'), page.indexOf('function homeDrawChart('));
  check('the deal and scorecard buttons are drawn only for someone who holds the tool',
    /d\.key && opCan\('underwriting'\)/.test(rend) && /const can = opCan\('entities'\)/.test(rend));
  check('the helpers behind them refuse anyone without the tool',
    /function homeOpenEntity\(e\) \{\s*if \(!opCan\('entities'\)\) return;/.test(page) && /function homeOpenDeal\(key\) \{\s*if \(!opCan\('underwriting'\) \|\| !key\) return;/.test(page));
  check('the headline tiles, ratio strip and debt table are on Portfolio, not Home',
    !/id="snap-cash"|id="rc-dscr"|id="ebDebt"|id="ov-momentum"/.test(home) && /id="snap-cash"/.test(page) && /id="rc-dscr"/.test(page) && /id="ebDebt"/.test(page));
  const render = page.slice(page.indexOf('function homeRender(s) {'), page.indexOf('function homeDrawChart('));
  // The deal box is the one deliberate exception (the owner, 2026-10-22); every other block stays figure-free.
  const noDeal = render.replace(/\/\/[^\n]*/g, '').replace(/if \(\$\('hm-deal'\)\) \{[\s\S]*?\n  \}\n\n  \/\* ?Portfolio scorecard|if \(\$\('hm-deal'\)\) \{[\s\S]*?\n  \}\n\n  /, '');
  check('the Home renderer prints no dollar amounts outside the deal box', !/fmtK\(|\.impact\b/.test(noDeal));
  check('the old Home-only data feeds are gone from Home (no chart of NOI trend, no urgent-variance click-through)',
    !/chartNOITrend|varOpenUrgent\(\$\{/.test(home));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n✗ ${checks - fails}/${checks} checks passed` : `\n✓ ${checks}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
