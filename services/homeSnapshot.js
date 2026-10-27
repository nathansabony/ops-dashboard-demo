// The Home snapshot — what the Home page shows every signed-in person.
//
// ── WHY THIS EXISTS (2026-10-22) ─────────────────────────────────────────────
// The owner: Home is "an opening page to the website. Everyone gets it, and then
// everyone also gets the tool that they're assigned to." It shows the portfolio
// in general terms: a health feed, the variances worth a look, best and worst
// entity grades, the latest underwriting deal, one chart. None of it can be a
// link into a tool the person may not have, and no exact dollar figure sits in
// the text (the chart's numbers stay, by his say-so).
//
// The grades, the variance scan and the health lines are all worked out in the
// BROWSER from P&L data that only Portfolio / Variances / Delinquency / Budget
// people may fetch (services/accessControl.js). So Home cannot compute them for
// someone who has none of those tools. Instead a browser that DOES have the data
// posts a small, coarse summary here, and Home reads that summary. The raw feeds
// stay locked; this file carries only what Home prints.
//
// Sections are independent. Each is replaced whole by a poster who holds the tool
// that owns it (SECTION_NEEDS), and carries its own timestamp, so someone with
// Portfolio but not Variances can refresh the grades without wiping the
// variances. Everything arriving is browser input: shapes are rebuilt field by
// field, strings are capped, numbers must be finite. The latest underwriting deal
// is not posted at all: the server reads it itself (services/underwritingDeals.js).

const fs = require('fs');
const path = require('path');

const FILE = process.env.HOME_SNAPSHOT_FILE || path.join(__dirname, '..', 'data', 'home-snapshot.json');

// Which tool may post which section. `health` is posted per source, below.
const SECTION_NEEDS = { scorecard: 'entities', chart: 'entities', variances: 'variances', insights: 'entities' };
// A health line comes from one tool's data; its source says whose permission is
// needed to refresh it. `entities` covers debt coverage and the scorecard lines.
const HEALTH_SOURCES = { entities: 'entities', variances: 'variances', delinquency: 'delinquency', budget: 'budget' };

const SEV = ['bad', 'warn', 'ok'];
const MAX_LINES = 12;
const MAX_POINTS = 60;

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const num = v => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function cleanLines(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_LINES).map(l => ({
    id: str(l && l.id, 60),
    sev: SEV.includes(l && l.sev) ? l.sev : 'warn',
    text: str(l && l.text, 220),
  })).filter(l => l.id && l.text);
}

function cleanEntityRow(r) {
  return { e: str(r && r.e, 60), grade: str(r && r.grade, 3), score: num(r && r.score), note: str(r && r.note, 160) };
}

function cleanScorecard(s) {
  if (!s || typeof s !== 'object') return null;
  const rows = list => (Array.isArray(list) ? list : []).slice(0, 6).map(cleanEntityRow).filter(r => r.e && r.grade);
  return {
    score: num(s.score), grade: str(s.grade, 3), count: num(s.count), atB: num(s.atB),
    best: rows(s.best), worst: rows(s.worst),
  };
}

function cleanChart(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.months)) return null;
  const n = Math.min(c.months.length, MAX_POINTS);
  const series = k => (Array.isArray(c[k]) ? c[k] : []).slice(-n).map(num);
  const months = c.months.slice(-n).map(m => str(m, 12));
  const out = { months, noi: series('noi'), debt: series('debt'), dscr: series('dscr') };
  // Series must line up with the months or the chart would draw against the wrong labels.
  if (!['noi', 'debt', 'dscr'].every(k => out[k].length === months.length)) return null;
  return out;
}

// The eight portfolio insights on Home (four going well, four going badly). Home
// is open to every signed-in person, so only a title and one headline travel here,
// and the headline may carry ratios, percentages and counts but never a dollar
// figure: anything with a "$" in it is dropped, so a mistake in the page cannot
// publish an amount. The full explanation, with the dollars, is built in the
// browser of someone who holds the Portfolio tool.
function cleanInsights(list) {
  const seen = new Set();
  const out = [];
  for (const i of (Array.isArray(list) ? list : [])) {
    const id = str(i && i.id, 40), title = str(i && i.title, 90), line = str(i && i.line, 200), key = str(i && i.key, 40);
    const tone = i && i.tone === 'good' ? 'good' : i && i.tone === 'bad' ? 'bad' : '';
    if (!/^[a-z0-9-]+$/.test(id) || !tone || !title || !line || seen.has(id)) continue;
    if (title.includes('$') || line.includes('$') || key.includes('$')) continue;
    seen.add(id);
    out.push({ id, tone, title, key, line });
  }
  const pick = t => out.filter(x => x.tone === t).slice(0, 4);
  return [...pick('good'), ...pick('bad')];
}

function cleanVariances(list) {
  return (Array.isArray(list) ? list : []).slice(0, 5).map(v => ({
    dot: str(v && v.dot, 8), scope: str(v && v.scope, 80), line: str(v && v.line, 100),
    month: str(v && v.month, 20), tag: str(v && v.tag, 60), score: num(v && v.score),
  })).filter(v => v.line);
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function save(snap) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(snap));
  fs.renameSync(tmp, FILE);   // a crash mid-write never leaves half a file
}

// Fold a poster's payload into the stored snapshot. `can(tool)` says whether the
// poster holds a tool (admins hold all). Sections they may not post are ignored,
// not errors: the page posts everything it computed and the server keeps what the
// person is allowed to write. Returns the sections that were actually taken.
function merge(payload, can, now = new Date()) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const snap = load();
  const at = now.toISOString();
  const taken = [];

  if (can(SECTION_NEEDS.scorecard) && p.scorecard !== undefined) {
    const s = cleanScorecard(p.scorecard);
    if (s) { snap.scorecard = { ...s, at }; taken.push('scorecard'); }
  }
  if (can(SECTION_NEEDS.chart) && p.chart !== undefined) {
    const c = cleanChart(p.chart);
    if (c) { snap.chart = { ...c, at }; taken.push('chart'); }
  }
  if (can(SECTION_NEEDS.insights) && p.insights !== undefined) {
    snap.insights = { items: cleanInsights(p.insights), at };
    taken.push('insights');
  }
  if (can(SECTION_NEEDS.variances) && p.variances !== undefined) {
    snap.variances = { items: cleanVariances(p.variances), at };
    taken.push('variances');
  }
  if (p.health && typeof p.health === 'object') {
    snap.health = snap.health && typeof snap.health === 'object' ? snap.health : {};
    for (const [src, tool] of Object.entries(HEALTH_SOURCES)) {
      if (p.health[src] === undefined || !can(tool)) continue;
      snap.health[src] = { lines: cleanLines(p.health[src]), at };
      taken.push('health:' + src);
    }
  }
  if (taken.length) save(snap);
  return taken;
}

// What Home reads: the stored sections plus the health lines flattened in the
// order the page sorts them (worst first).
function read() {
  const snap = load();
  const lines = [];
  for (const src of Object.keys(HEALTH_SOURCES)) {
    const h = snap.health && snap.health[src];
    if (h && Array.isArray(h.lines)) lines.push(...h.lines.map(l => ({ ...l, src })));
  }
  const rank = { bad: 0, warn: 1, ok: 2 };
  lines.sort((a, b) => rank[a.sev] - rank[b.sev]);
  return {
    scorecard: snap.scorecard || null,
    chart: snap.chart || null,
    variances: snap.variances || null,
    insights: snap.insights || null,
    health: lines,
  };
}

// Why a deal did not solve, in a sentence: the first thing that is actually true of
// its card. A deal can fail three ways: the model flags it as unfit (NEEDS REVIEW),
// it cannot solve an IRR, or it solves one but the max-price solver finds no price.
function unsolvedReason(c) {
  if (c.needs_review) return (Array.isArray(c.review_reasons) && c.review_reasons[0]) || 'Flagged NEEDS REVIEW';
  const y1 = num(c.year1_noi), t12 = num(c.t12_noi), occ = num(c.occupancy);
  if (c.irr_failed || num(c.irr) == null) {
    if (y1 != null && y1 < 0) return `Year-1 NOI is negative (${y1 < 0 ? '-' : ''}$${Math.abs(Math.round(y1)).toLocaleString('en-US')}), so the equity is never recovered and no IRR exists`;
    if (occ != null && occ < 0.5) return `Occupancy is ${(occ * 100).toFixed(0)}%, so the model's income cannot repay the loan and no IRR exists`;
    if (t12 != null && t12 <= 0) return 'The T12 NOI is zero or negative, so no IRR exists';
    return 'The model could not solve an IRR on these inputs (the equity is never recovered)';
  }
  if (num(c.max_price) == null) return 'The IRR solved, but the max-price solver found no price in its cap-rate range';
  return '';
}

// The newest live underwriting run, reduced to what Home prints (2026-10-22,
// The owner: "just show the most recent deal and the IRR, COC return and buy price at
// the target IRR, and give each deal a score"). So: the deal, its levered IRR and
// Year-2 cash-on-cash, the price to pay that still clears the target IRR, and the
// deal score. A deal flagged NEEDS REVIEW is not scored and withholds its numbers;
// an IRR the model could not solve reads unsolved with its reason.
const { scoreDeal } = require('./underwritingDeals');

//
// The box must never read as empty (2026-10-22, the owner: "it shows nothing"): the two newest runs that day were flagged
// NEEDS REVIEW, which withhold their numbers, so the box had nothing to print. It now shows the latest deal that HAS a result,
// and says separately and plainly which newer runs could not be scored and why. If no deal has a result it says so.
function isScored(c) {
  return !!c && !c.needs_review && !c.irr_failed && num(c.irr) != null && scoreDeal(c).score != null;
}

function latestDeal(props) {
  const live = (props || []).filter(p => !p.hidden && p.latest && p.latest.card && p.latest.card.computed !== false);
  if (!live.length) return null;
  live.sort((a, b) => String(b.latest.created).localeCompare(String(a.latest.created)));
  const firstScored = live.findIndex(o => isScored(o.latest.card));
  const noneSolved = firstScored < 0;
  const p = live[noneSolved ? 0 : firstScored], c = p.latest.card;
  // runs newer than the one shown that could not be scored, with the reason (they withhold their own numbers)
  const newerNotScored = live.slice(0, noneSolved ? 0 : firstScored)
    .map(o => ({ key: str(o.key || '', 120), name: o.latest.card.name || o.name, ranOn: String(o.latest.created || '').slice(0, 10),
      needsReview: !!o.latest.card.needs_review, reason: str(unsolvedReason(o.latest.card) || 'Not scored', 260),
      fix: str(Array.isArray(o.latest.card.review_fix) && o.latest.card.review_fix[0] || '', 420) }))
    .slice(0, 6);
  const review = !!c.needs_review;
  const solved = !review && !c.irr_failed && num(c.irr) != null;
  const sc = scoreDeal(c);
  const out = {
    key: str(p.key || '', 120),     // the board's own key for this property, so Home can open its full analysis
    name: c.name || p.name || '(unnamed deal)',
    address: c.address || '',
    units: num(c.units),
    ranOn: String(p.latest.created || '').slice(0, 10),
    runs: p.run_count || 1,
    verdict: review ? 'review' : c.meets_target === true ? 'meets' : c.meets_target === false ? 'below' : 'unknown',
    target: num(c.irr_target),
    irr: solved ? num(c.irr) : null,
    coc: review ? null : num(c.coc),
    buyPrice: review ? null : num(c.max_price),     // the price that still clears the target IRR
    score: sc.score, grade: sc.grade,
    fix: review ? str(Array.isArray(c.review_fix) && c.review_fix[0] || '', 420) : '',
    problems: review ? (c.review_reasons || []).slice(0, 3).map(r => str(r, 260))
      : (!solved ? [str(unsolvedReason(c) || 'The model has not produced an IRR yet.', 260)] : []),
    noneSolved,                                       // no deal on the board has a usable result: the box says so in words
    newerNotScored,
    unsolvedCount: 0,
    unsolved: live.map(o => ({ name: o.latest.card.name || o.name, ranOn: String(o.latest.created || '').slice(0, 10), reason: str(unsolvedReason(o.latest.card), 240) }))
      .filter(o => o.reason).slice(0, 8),
  };
  out.unsolvedCount = out.unsolved.length;
  return out;
}

module.exports = { FILE, SECTION_NEEDS, HEALTH_SOURCES, merge, read, latestDeal, cleanChart, cleanScorecard, cleanLines, cleanInsights };
