#!/usr/bin/env node
// Proves the eight portfolio insights on Home (public/index.html, the block between
// INSIGHTS BEGIN and INSIGHTS END): canned portfolio numbers in, four going well and
// four going badly out, each with a number, a why and a next step; no dollar figure
// in anything Home shows; nothing "undefined" or "NaN"; access respected.
//
// Run: npm run check:portfolio-insights

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
}

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const from = page.indexOf('// ── INSIGHTS BEGIN');
const to = page.indexOf('// ── INSIGHTS END');
if (from < 0 || to < 0) { console.log('✗ the INSIGHTS markers are missing from public/index.html'); process.exit(1); }
const ctx = vm.createContext({});
vm.runInContext(page.slice(from, to), ctx);
const build = F => ctx.buildPortfolioInsights(JSON.parse(JSON.stringify(F)));

// ── canned portfolio ────────────────────────────────────────────────────────
const T = {
  dscr: { target: 1.25, floor: 1 }, occupancy: { target: 95, floor: 90 }, margin: { target: 45, floor: 35 },
  expRatio: { target: 55, floor: 70 }, delinquency: { target: 5, floor: 15 }, cfPerUnit: { target: 50, floor: 0 },
};
const ent = (e, o) => {
  const x = { e, units: 100, income: 0, opex: 0, mtg: 0, prevIncome: 0, prevOpex: 0, prevMtg: 0, occUnits: 100, occupied: 95,
    occManual: false, delinqAmt: 0, gprMonthly: 100000, debtEst: false, t: null, ...o };
  x.noi = x.income - x.opex; x.prevNoi = x.prevIncome - x.prevOpex;
  x.occupancy = x.occUnits ? x.occupied / x.occUnits * 100 : null;
  x.delinqPct = x.gprMonthly ? x.delinqAmt / x.gprMonthly * 100 : null;
  return x;
};
const ENTS = [
  ent('Alpha', { units: 100, income: 1200000, opex: 480000, mtg: 400000, prevIncome: 1150000, prevOpex: 520000, occupied: 97, delinqAmt: 1000 }),
  ent('Bravo', { units: 80, income: 700000, opex: 460000, mtg: 300000, prevIncome: 720000, prevOpex: 380000, occUnits: 80, occupied: 70, gprMonthly: 60000, delinqAmt: 7200 }),
  ent('Charlie', { units: 60, income: 500000, opex: 260000, mtg: 150000, prevIncome: 490000, prevOpex: 240000, occUnits: 60, occupied: 58, gprMonthly: 45000, delinqAmt: 1500 }),
  ent('Delta', { units: 120, income: 900000, opex: 450000, mtg: 200000, prevIncome: 880000, prevOpex: 430000, occUnits: 120, occupied: 114, gprMonthly: 90000, delinqAmt: 3000, debtEst: true }),
  ent('Echo', { units: 50, income: 300000, opex: 200000, mtg: 130000, prevIncome: 290000, prevOpex: 190000, occUnits: 50, occupied: 47, gprMonthly: 30000, delinqAmt: 2500 }),
  ent('Foxtrot', { units: 40, income: 250000, opex: 140000, mtg: 60000, prevIncome: 270000, prevOpex: 140000, occUnits: 40, occupied: 38, gprMonthly: 25000, delinqAmt: 1000 }),
];
const facts = (ents, extra) => {
  const sum = k => ents.reduce((s, x) => s + (x[k] || 0), 0);
  return { asOf: 'Sep 26', prevAsOf: 'Sep 25', targets: T, entities: ents, debtGaps: [], ...extra,
    pf: { units: sum('units'), income: sum('income'), opex: sum('opex'), noi: sum('noi'), mtg: sum('mtg'), prevIncome: sum('prevIncome'),
      prevOpex: sum('prevOpex'), prevNoi: sum('prevNoi'), prevMtg: sum('prevMtg'), occUnits: sum('occUnits'), occupied: sum('occupied'),
      delinqAmt: sum('delinqAmt'), gprMonthly: sum('gprMonthly') } };
};
const BASE = facts(ENTS, { debtGaps: [{ entity: 'Delta', lastPosted: 'Jan 26' }] });
const dirty = list => JSON.stringify(list).match(/undefined|NaN|Infinity|null"/);

console.log('\nFour going well, four going badly');
{
  const out = build(BASE);
  const good = out.filter(i => i.tone === 'good'), bad = out.filter(i => i.tone === 'bad');
  check('canned portfolio gives exactly 4 good and 4 bad', good.length === 4 && bad.length === 4, `got ${good.length} good, ${bad.length} bad: ${out.map(i => i.id).join(', ')}`);
  check('every one has a title, a headline with a number, a why and a next step',
    out.every(i => i.title && /\d/.test(i.headline) && i.why.length >= 1 && i.steps.length >= 1 && i.why.every(Boolean) && i.steps.every(Boolean)));
  check('every one carries rows to explain it, with a bar between 0 and 1 and a cell per column',
    out.every(i => i.rows.length >= 1 && i.rows.every(r => r.bar >= 0 && r.bar <= 1 && r.cells.length === i.cols.length - 1)));
  check('every one has a short key figure for its one-line row on Home, with no dollar sign, and a short title',
    out.every(i => i.key && i.key.length <= 24 && !i.key.includes('$') && i.title.length <= 36), out.map(i => `${i.title} [${i.key}]`).join(' | '));
  check('ids are unique, URL-safe slugs (they become #insight/<id>)', new Set(out.map(i => i.id)).size === out.length && out.every(i => /^[a-z0-9-]+$/.test(i.id)));
  check('no headline carries a dollar figure: Home shows ratios and counts only', out.every(i => !i.headline.includes('$') && !i.title.includes('$')), out.filter(i => i.headline.includes('$')).map(i => i.headline).join(' | '));
  check('the explanation carries the dollars (that page is Portfolio only)', out.filter(i => i.why.some(w => w.includes('$')) || i.rows.some(r => r.cells.some(c => c.includes('$')))).length >= 6);
  check('nothing reads undefined, NaN or Infinity', !dirty(out), String(dirty(out)));
  check('derived figures are labelled Cedar Ridge estimates', out.every(i => i.ours === true) && out.filter(i => i.tone === 'bad').some(i => i.why.concat(i.steps).some(t => /Cedar Ridge estimate/.test(t))));
  check('the same facts always give the same words', JSON.stringify(build(BASE)) === JSON.stringify(build(BASE)));
  check('good items lead, each tone ranked by weight', out.slice(0, 4).every(i => i.tone === 'good') && out.slice(0, 3).every((i, k) => i.weight >= out[k + 1].weight));
}

console.log('\nThe debt story is told honestly');
{
  const out = build(BASE);
  const debt = out.find(i => i.id === 'debt-coverage');
  check('debt coverage is among the bad: Bravo and Echo are under 1.25x', !!debt && debt.rows.map(r => r.label).join() === 'Echo,Bravo');
  check('a missing-interest entity is called a Cedar Ridge estimate in the headline and the why',
    !!debt && /Delta coverage is a Cedar Ridge estimate/.test(debt.headline) && debt.why.some(w => /Delta/.test(w) && /Jan 26/.test(w) && /not an improvement/.test(w)));
  check('...and asks for the missing interest to be entered', !!debt && debt.steps.some(s => /missing mortgage interest for Delta/.test(s)));
  const strong = out.find(i => i.id === 'debt-strength');
  check('an estimated-debt entity is never counted as strong coverage', !!strong && !strong.rows.some(r => r.label === 'Delta'));
  check('the next step names the entity and the NOI it needs', !!debt && /Echo|Bravo/.test(debt.steps[0]) && /more NOI a year/.test(debt.steps[0]));
}

console.log('\nEdges');
{
  check('no entities gives no insights, not an error', build(facts([])).length === 0);
  const noPrior = build(facts(ENTS.map(x => ({ ...x, prevIncome: 0, prevOpex: 0, prevNoi: 0 }))));
  check('without a prior year there are no growth insights and nothing is NaN',
    !noPrior.some(i => ['expense-growth', 'noi-growth', 'noi-decline', 'income-growth', 'expense-control'].includes(i.id)) && !dirty(noPrior));
  const zero = build(facts(ENTS.map(x => ({ ...x, units: 0, mtg: 0, occUnits: 0, occupied: 0, gprMonthly: 0, delinqAmt: 0 }))));
  check('zero units, no debt and no roster stay clean', !dirty(zero));
  const healthy = build(facts([ent('Solo', { units: 100, income: 1500000, opex: 600000, mtg: 300000, prevIncome: 1300000, prevOpex: 620000, occupied: 98, delinqAmt: 500 })]));
  check('a healthy portfolio shows no bad items, only what is real', healthy.every(i => i.tone === 'good') && healthy.length >= 1 && !dirty(healthy));
  const sick = build(facts([ent('Solo', { units: 100, income: 900000, opex: 800000, mtg: 300000, prevIncome: 1000000, prevOpex: 600000, occupied: 70, delinqAmt: 40000 })]));
  check('a struggling one shows bad items and never invents good ones', sick.filter(i => i.tone === 'bad').length >= 3 && !sick.some(i => i.tone === 'good') && !dirty(sick));
}

console.log('\nAccess: Home is for everyone, the explanation is for Portfolio');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ins-'));
  process.env.HOME_SNAPSHOT_FILE = path.join(tmp, 'snap.json');
  const hs = require('../services/homeSnapshot');
  const ac = require('../services/accessControl');
  const items = [
    { id: 'debt-coverage', tone: 'bad', title: 'Debt coverage is thin', line: 'Debt coverage 1.18x against the 1.25x lender minimum' },
    { id: 'noi-growth', tone: 'good', title: 'NOI is growing', line: 'NOI up 4.1% year over year' },
    { id: 'leaky', tone: 'bad', title: 'Leaky', line: 'Short by $320K a year' },
    { id: 'Bad Id!', tone: 'good', title: 'x', line: 'y' },
  ];
  const can = (...t) => x => t.includes(x);
  check('Budget-only and Home-only people cannot post insights', hs.merge({ insights: items }, can('budget')).length === 0 && hs.merge({ insights: items }, can('overview')).length === 0 && hs.read().insights === null);
  check('a Portfolio person can, and an insight with a dollar sign or a bad id never reaches Home',
    hs.merge({ insights: items }, can('overview', 'entities')).includes('insights') && hs.read().insights.items.map(i => i.id).join() === 'noi-growth,debt-coverage');
  const many = Array.from({ length: 9 }, (_, k) => ({ id: 'g' + k, tone: 'good', title: 't', line: 'n ' + k })).concat(Array.from({ length: 9 }, (_, k) => ({ id: 'b' + k, tone: 'bad', title: 't', line: 'n ' + k })));
  hs.merge({ insights: many }, can('entities'));
  check('at most four of each tone are kept', hs.read().insights.items.filter(i => i.tone === 'good').length === 4 && hs.read().insights.items.filter(i => i.tone === 'bad').length === 4);
  const budgetOnly = { admin: false, tools: ['overview', 'budget'] }, homeOnly = { admin: false, tools: ['overview'] };
  check('both can read the snapshot, neither can post to it as Portfolio',
    ac.decide(budgetOnly, 'GET', '/api/home-snapshot').ok && ac.decide(homeOnly, 'GET', '/api/home-snapshot').ok && ac.decide(homeOnly, 'POST', '/api/home-snapshot').status === 403);
  check('neither can read the data the explanation is built from',
    ['/api/financials/property-monthly', '/api/live-overview', '/api/entities', '/api/debt-service'].every(p => ac.decide(budgetOnly, 'GET', p).status === 403 && ac.decide(homeOnly, 'GET', p).status === 403));
  // The page: links exist only for someone who holds Portfolio.
  const render = page.slice(page.indexOf('function homeRender(s) {'), page.indexOf('function homeDrawChart('));
  check('Home draws an insight as a link only when the person holds Portfolio', /const can = opCan\('entities'\);[\s\S]*?can \? `<a class="hm-ins hm-ins-link" href="#insight\//.test(render) && /: `<div class="hm-ins"/.test(render));
  check('...and tells everyone else to ask an admin', /Ask an admin for Portfolio access/.test(render));
  const route = page.slice(page.indexOf('function insightRoute() {'), page.indexOf('function insightBack('));
  check('opening #insight/<id> without Portfolio access clears the hash and shows nothing', /if \(!opCan\('entities'\)\) \{ history\.replaceState/.test(route));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fails ? `\n✗ ${checks - fails}/${checks} checks passed` : `\n✓ ${checks}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
