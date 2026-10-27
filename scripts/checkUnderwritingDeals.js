// The Underwriting tab's past deals (services/underwritingDeals.js): what a card
// says, how repeat runs fold into one property, what the disk-backed store keeps,
// and that every new route stays behind the Underwriting tool. No Python, no Excel,
// no Rent Manager: the model reader is stubbed, so this runs anywhere.
//
// Run: npm run check:underwriting-deals

const os = require('os');
const path = require('path');
const fs = require('fs');
const deals = require('../services/underwritingDeals');
const accessControl = require('../services/accessControl');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '\n      ' + detail}`);
  if (!ok) failed += 1;
}

const raw = (o = {}) => ({
  computed: true, name: 'Harbor Row Portfolio', address: '210-216 Elm St', year_built: 1924, units: 49,
  price: 11208290, price_per_door: 228740, t12_noi: 616456, year1_noi: 403903, irr: 0.0456, irr_target: 0.16,
  max_price: 8129433, equity_multiple: 1.39, dscr: 0.86, scenarios: [{ scenario: 'Sale Year 8', irr: 0.0456 }], checks: { ok: 11 }, ...o,
});

console.log('\nWhat a card says');
{
  const c = deals.shapeCard(raw());
  check('cap rate is T12 NOI over the price run, labelled as our estimate',
    Math.abs(c.cap_rate - 616456 / 11208290) < 1e-9 && /Cedar Ridge estimate/.test(c.cap_note));
  check('gap to max price is max minus price, in dollars and as a share of the price',
    Math.round(c.gap_to_max) === 8129433 - 11208290 && Math.abs(c.gap_pct - (8129433 - 11208290) / 11208290) < 1e-9);
  check('an IRR under its target is "below", at or over is "meets"',
    c.meets_target === false && deals.shapeCard(raw({ irr: 0.16 })).meets_target === true && deals.shapeCard(raw({ irr: 0.21 })).meets_target === true);
  check('no IRR means no verdict, not a failing one', deals.shapeCard(raw({ irr: null })).meets_target === null);
  check('a target the model did not carry falls back to 16%', deals.shapeCard(raw({ irr_target: null })).irr_target === 0.16);
  const none = deals.shapeCard(raw({ max_price: 0 }));
  check('a solver that found no price (0) is "no max price", never a 100% gap', none.max_price === null && none.gap_to_max === null && none.gap_pct === null);
  const blank = deals.shapeCard(raw({ address: '[ADDRESS]', year_built: '[YEAR]' }));
  check('an unfilled template ([ADDRESS] / [YEAR]) is blank, not a fact', blank.address === null && blank.year_built === null);
  check('a portfolio\'s year-built text is kept as the model wrote it', deals.shapeCard(raw({ year_built: '1924 (A) / 1962 (B)' })).year_built === '1924 (A) / 1962 (B)');
  check('a model that is not ours reads as an error, never as zeros', deals.shapeCard({ error: 'Not a Cedar Ridge underwriting model' }).error != null);
  check('no price means no cap rate rather than a divide by zero', deals.shapeCard(raw({ price: 0 })).cap_rate === null);
}

console.log('\nRun dates');
{
  check('the generator\'s stamp wins over the file\'s mtime', deals.runDate('Harbor-2026-09-25-21-23-03.xlsx', Date.UTC(2026, 9, 21)) === '2026-09-25T21:23:03.000Z');
  check('a browser-style " (1)" suffix still reads the stamp', deals.runDate('Willow-Bella-2026-09-14-19-45-10 (1).xlsx', 0) === '2026-09-14T19:45:10.000Z');
  check('no stamp falls back to the mtime', deals.runDate('Imported model.xlsx', Date.UTC(2026, 9, 21, 12)) === '2026-10-21T12:00:00.000Z');
}

console.log('\nOne card per property');
{
  const e = (file, name, created, extra = {}) => ({ file, created, card: deals.shapeCard(raw({ name })), hidden: null, ...extra });
  const entries = [
    e('a1.xlsx', 'Willow Bay on Bayshore', '2026-09-14T19:00:00.000Z'),
    e('a2.xlsx', 'Willow Bay on Bayshore', '2026-09-14T20:00:00.000Z'),
    e('a3.xlsx', 'Willow Bay on Bayshore', '2026-09-14T21:00:00.000Z'),
    e('b.xlsx', 'Club at Sandy Shores (128)', '2026-08-11T02:00:00.000Z'),
    e('b2.xlsx', 'Club at Sandy Shores', '2026-08-12T02:00:00.000Z'),
    e('c.xlsx', 'Harbor Row Portfolio', '2026-09-25T00:00:00.000Z'),
  ];
  const props = deals.groupByProperty(entries);
  const willow = props.find(p => /willow/i.test(p.name));
  check('three runs of one property fold into one card showing the newest', props.length === 3 && willow.run_count === 3 && willow.latest.file === 'a3.xlsx');
  check('"(128)" in a name does not split the same property', props.find(p => /sandy/i.test(p.name)).run_count === 2);
  check('newest property first', props[0].name === 'Harbor Row Portfolio' && props[2].name.startsWith('Club'));
  entries[2].hidden = { by: 'n', at: 'x' };
  const afterHide = deals.groupByProperty(entries).find(p => /willow/i.test(p.name));
  check('hiding the newest run puts the next one on the card and keeps the count honest', afterHide.latest.file === 'a2.xlsx' && afterHide.run_count === 2 && !afterHide.hidden);
  entries[0].hidden = entries[1].hidden = entries[2].hidden;
  const allHidden = deals.groupByProperty(entries).find(p => /willow/i.test(p.name));
  check('hiding every run moves the property to Hidden deals', allHidden.hidden === true);
}

console.log('\nOfficial counts the unit rows contradict');
{
  const vm = require('vm');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const m = html.match(/function uwOfficialCounts\(rr\)\{[\s\S]*?\n\}\n(?=function uwRecombine)/);
  const page = m ? vm.runInNewContext(m[0] + '; uwOfficialCounts') : null;
  const units = (occ, n) => Array.from({ length: n }, (_, i) => ({ unit_number: 'U' + i, occupied_flag: i < occ ? 1 : 0 }));
  const rrOf = o => Object.assign({ units: units(54, 56) }, o);
  const cases = {
    'Maple Court: official occupied 0 / 0% with 54 of 56 paying rent': rrOf({ official_units: 56, official_occupied_units: 0, official_vacant_units: 0, official_occupancy: 0 }),
    'no official figures at all': rrOf({}),
    'official occupied larger than the unit count': rrOf({ official_units: 56, official_occupied_units: 90 }),
    'a good summary (Pinecrest: 396 of 996)': { units: units(396, 996), official_units: 996, official_occupied_units: 396, official_vacant_units: 600, official_occupancy: 0.3976 },
    'an honestly empty building (0 of 56, no unit pays)': { units: units(0, 56), official_units: 56, official_occupied_units: 0, official_occupancy: 0 },
  };
  const svc = deals.reconcileOfficialCounts(JSON.parse(JSON.stringify(cases['Maple Court: official occupied 0 / 0% with 54 of 56 paying rent'])));
  const k = JSON.parse(JSON.stringify(cases['Maple Court: official occupied 0 / 0% with 54 of 56 paying rent']));
  deals.reconcileOfficialCounts(k);
  check('an official occupancy of 0 while 54 of 56 units pay rent is replaced by the unit rows (96.4%), and the reader is told',
    k.official_occupied_units === 54 && k.official_vacant_units === 2 && Math.abs(k.official_occupancy - 54 / 56) < 1e-9 && /contradict its own unit rows.*54 of 56/.test(svc.note), JSON.stringify(k).slice(0, 200));
  const none = JSON.parse(JSON.stringify(cases['no official figures at all'])); deals.reconcileOfficialCounts(none);
  check('no official figures: unit count and occupancy come from the unit rows', none.official_units === 56 && none.official_occupied_units === 54);
  const big = JSON.parse(JSON.stringify(cases['official occupied larger than the unit count'])); deals.reconcileOfficialCounts(big);
  check('an occupied count above the unit count is not believed', big.official_occupied_units === 54);
  const good = JSON.parse(JSON.stringify(cases['a good summary (Pinecrest: 396 of 996)'])); const gr = deals.reconcileOfficialCounts(good);
  check('a summary that agrees is left exactly as it was', !gr.changed && good.official_occupied_units === 396 && good.official_occupancy === 0.3976);
  const empty = JSON.parse(JSON.stringify(cases['an honestly empty building (0 of 56, no unit pays)'])); const er = deals.reconcileOfficialCounts(empty);
  check('a building that really is empty (no unit pays) stays at 0%', !er.changed && empty.official_occupied_units === 0);
  check('the page carries the same rule, found in public/index.html', typeof page === 'function');
  if (typeof page === 'function') {
    let same = true, why = '';
    for (const [label, rr] of Object.entries(cases)) {
      const a = JSON.parse(JSON.stringify(rr)), b = { data: JSON.parse(JSON.stringify(rr)) };
      const sa = deals.reconcileOfficialCounts(a), sb = page(b);
      const f = o => JSON.stringify([o.official_units, o.official_occupied_units, o.official_vacant_units, o.official_occupancy]);
      if (f(a) !== f(b.data) || (sa.note || null) !== (sb || null)) { same = false; why = label + ': ' + f(a) + ' vs ' + f(b.data) + ' | ' + sa.note + ' | ' + sb; }
    }
    check('...and it gives the same answer and the same note as the server on every case', same, why);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('the generate route reconciles before it builds, and passes the note back', /reconcileOfficialCounts\(deal\.rent_roll\)/.test(src) && /reconciled\.note/.test(src));
}

console.log('\nThe plausibility gate (a deal built on inputs that cannot support a decision)');
{
  const healthy = { computed: true, units: 532, occupancy: 0.9, price: 88e6, price_per_door: 165358, t12_noi: 4.8e6, year1_noi: 5.4e6, dscr: 1.46, equity_multiple: 3.2, irr: 0.18, non_revenue_units: 10 };
  const reasons = o => deals.shapeCard(Object.assign({}, healthy, o)).review_reasons;
  check('a healthy deal passes the gate with no reasons', reasons({}).length === 0 && deals.shapeCard(healthy).needs_review === false);
  check('occupancy under 50% is flagged, 50% is not', reasons({ occupancy: 0.499 }).some(r => /Occupancy is 49.9%/.test(r)) && reasons({ occupancy: 0.5 }).length === 0);
  check('price per door under $30K or over $400K is flagged, the limits themselves are not',
    reasons({ price_per_door: 29999 }).length === 1 && reasons({ price_per_door: 400001 }).length === 1 && reasons({ price_per_door: 30000 }).length === 0 && reasons({ price_per_door: 400000 }).length === 0);
  check('a negative Yr-1 NOI over a positive T12 NOI is flagged; a building that loses money on both is not a surprise',
    reasons({ year1_noi: -1 }).some(r => /Year-1 NOI/.test(r)) && reasons({ year1_noi: -1, t12_noi: -5 }).length === 0);
  check('a negative DSCR is flagged', reasons({ dscr: -0.01 }).some(r => /debt coverage is negative/.test(r)) && reasons({ dscr: 0.5 }).length === 0);
  check('a negative equity multiple is flagged', reasons({ equity_multiple: -0.45 }).some(r => /equity multiple is negative/.test(r)) && reasons({ equity_multiple: 0.4 }).length === 0);
  const avon = deals.shapeCard({ computed: true, name: 'Pinecrest Village', units: 996, occupancy: 0.3976, price: 6616690, price_per_door: 6643, t12_noi: 363918, year1_noi: -1661066, dscr: -5.98, equity_multiple: 2.5, irr: 0.0969, non_revenue_units: 359 });
  check('Pinecrest\'s card (39.8% occupied, $6.6K a door, Yr-1 NOI -$1.66M, DSCR -5.98x) is flagged for all four reasons', avon.needs_review && avon.review_reasons.length === 4, avon.review_reasons.join(' | '));
  check('...and its occupancy reason shows physical and revenue units: 359 of 996 not for rent, 396 of 637 revenue units occupied (62.2%)',
    /359 of the 996 units are down, model or employee units/.test(avon.review_reasons[0]) && /396 of the 637 revenue units are occupied \(62\.2%\)/.test(avon.review_reasons[0]) && avon.revenue_units === 637 && Math.abs(avon.revenue_occupancy - 396 / 637) < 1e-9);
  const fixAvon = deals.shapeCard({ computed: true, name: 'Pinecrest Village', units: 996, occupancy: 0.3976, price: 4088392, price_per_door: 4105, t12_noi: 224862, year1_noi: -2639904, dscr: -15.4, equity_multiple: -1, irr: 0, irr_failed: true, non_revenue_units: 359 }).review_fix;
  check('a lease-up (under 50% occupied) is told to send an asking price and a stabilization plan, in one line, not a list of gate numbers', fixAvon.length === 1 && /asking price/.test(fixAvon[0]) && /stabilization plan/.test(fixAvon[0]) && /lease-up/.test(fixAvon[0]), fixAvon.join('|'));
  check('an odd price alone is told to enter the real asking price; a deal that passes has no fix lines',
    deals.shapeCard(Object.assign({}, healthy, { price_per_door: 20000 })).review_fix.length === 1 && /Price override/.test(deals.shapeCard(Object.assign({}, healthy, { price_per_door: 20000 })).review_fix[0]) && deals.shapeCard(healthy).review_fix.length === 0);
  const rank = deals.rankProperties([
    { key: 'bad', name: 'bad', hidden: false, latest: { file: 'b', created: '2026-09-01T00:00:00.000Z', card: deals.shapeCard(Object.assign({}, healthy, { irr: 0.5, occupancy: 0.2 })) } },
    { key: 'ok', name: 'ok', hidden: false, latest: { file: 'o', created: '2026-09-01T00:00:00.000Z', card: deals.shapeCard(Object.assign({}, healthy, { irr: 0.05 })) } },
  ]);
  check('a flagged deal ranks after every deal that passes, whatever its IRR says', rank.find(p => p.key === 'ok').rank === 1 && rank.find(p => p.key === 'bad').rank === 2);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('the generate route returns the gate verdict, so the result screen can show it', /review: \{ needs_review/.test(src));
  check('a mapped T12 that does not tie out to the statement is re-mapped once, then read in full', /did not reproduce the statement/.test(src) && /used full extraction/.test(src) && /\^Tie-out:/.test(src));
  check('underwriting Python runs one process at a time (a multi-file drop once killed the 512 MB instance)', /uwPyActive < UW_PY_MAX/.test(src) && /UNDERWRITING_PY_CONCURRENCY\) \|\| 1/.test(src));
  check('the column-mapping call runs with thinking off and gets one retry on invalid JSON, so a mappable T12 is not silently read the slow way',
    /thinking: \{ type: 'disabled' \},\r?\n\s+system: UW_MAP_SYSTEM_PROMPT/.test(src) && /Your previous reply was not valid JSON/.test(src));
}

console.log('\nAn IRR the model could not solve');
{
  const k = deals.shapeCard(raw({ name: 'Maple Court', irr: 0, equity_multiple: 0.4, coc: -0.21 }));
  check('an IRR of exactly 0 with equity not recovered is "could not solve", not 0%', k.irr === null && k.irr_failed === true);
  check('...and it counts as below target, never as a pass or an unknown', k.meets_target === false);
  const nm = deals.shapeCard(raw({ irr: null, irr_failed: true, equity_multiple: -0.45 }));
  check('an earlier-template model whose IRR cell says "NM" reads as unsolved, not as a blank', nm.irr === null && nm.irr_failed === true && nm.meets_target === false);
  const be = deals.shapeCard(raw({ irr: 0, equity_multiple: 1 }));
  check('a true break-even (0% at exactly 1.00x) is still 0%', be.irr === 0 && be.irr_failed === false && be.meets_target === false);
  const props = [0.046, null].map((irr, i) => ({ key: 'p' + i, name: 'p' + i, hidden: false, latest: { file: 'f' + i, created: '2026-09-01T00:00:00.000Z', card: i ? k : deals.shapeCard(raw({ irr })) } }));
  deals.rankProperties(props);
  check('it ranks after every deal that has a real IRR', props[0].rank === 1 && props[1].rank === 2);
}

console.log('\nBest deal first (IRR, then Year-2 cash-on-cash)');
{
  const prop = (name, irr, coc, created = '2026-09-01T00:00:00.000Z', extra = {}) =>
    ({ key: name, name, hidden: false, latest: { file: name + '.xlsx', created, card: deals.shapeCard(raw({ name, irr, coc, ...extra })) } });
  check('cash-on-cash comes from the Dashboard tile', deals.shapeCard(raw({ coc: 0.107 })).coc === 0.107);
  check('...or, for an older card, from the scenario table\'s Year-2 row',
    deals.shapeCard(raw({ coc: undefined, scenarios: [{ scenario: 'Sale Year 8', irr: 0.2 }, { scenario: 'Year 2 Cash-on-Cash', irr: 0.0316 }] })).coc === 0.0316);
  const ranked = deals.rankProperties([prop('low', 0.046, 0.03), prop('best', 0.212, 0.107), prop('mid', 0.12, 0.05), prop('none', null, 0.4)]);
  const byRank = ranked.slice().sort((a, b) => a.rank - b.rank).map(p => p.name);
  check('the highest IRR is #1, a deal with no IRR is last however good its cash-on-cash', byRank.join() === 'best,mid,low,none');
  // the deal score (2026-10-22)
  const sc = deals.scoreDeal(deals.shapeCard(raw({ irr: 0.25, coc: 0.11, max_price: 12000000, price: 9000000, equity_multiple: 3, dscr: 1.6, occupancy: 0.96, checks: { needs_input: 0 }, scenarios: [{ scenario: 'Sale Year 3', irr: 0.2 }, { scenario: 'Sale Year 8', irr: 0.25 }] })));
  check('a deal that clears everything with room to spare scores an A, but not a perfect 100', sc.score >= 85 && sc.score < 100 && sc.grade === 'A', sc.score);
  check('the seven parts add up to the score and the weights to 100', Math.abs(sc.parts.reduce((t, x) => t + x.points, 0) - sc.score) <= 1 && sc.parts.reduce((t, x) => t + x.weight, 0) === 100);
  check('a deal that clears its target at every price tested (no solved max) keeps full price marks, one that fails at every price gets none',
    deals.scoreDeal(deals.shapeCard(raw({ irr: 0.2, max_price: 0, meets_target: true }))).parts.find(x => x.key === 'price').points > 0 && deals.scoreDeal(deals.shapeCard(raw({ irr: -0.03, max_price: 0 }))).parts.find(x => x.key === 'price').points === 0);
  check('a deal that needs review is not scored', deals.scoreDeal({ computed: true, needs_review: true }).score === null);
  const strong = { irr: 0.18, coc: 0.09, max_price: 12000000, price: 9000000, equity_multiple: 2.2, dscr: 1.4 };
  const y3 = deals.scoreDeal(deals.shapeCard(raw(Object.assign({}, strong, { scenarios: [{ scenario: 'Sale Year 3', irr: 0.17 }, { scenario: 'Sale Year 8', irr: 0.18 }] }))));
  const y8 = deals.scoreDeal(deals.shapeCard(raw(Object.assign({}, strong, { scenarios: [{ scenario: 'Sale Year 3', irr: 0.05 }, { scenario: 'Sale Year 8', irr: 0.18 }] }))));
  const refi = deals.scoreDeal(deals.shapeCard(raw(Object.assign({}, strong, { scenarios: [{ scenario: 'Sale Year 8', irr: 0.1 }, { scenario: 'Refi Yr3 + Sale Yr8', irr: 0.18 }] }))));
  check('a deal that clears the target only at year 8, or only with a refinance, scores below one that clears it at year 3', y3.score > y8.score && y8.score > refi.score, [y3.score, y8.score, refi.score]);
  const t = k => x => x.parts.find(p => p.key === k).points;
  check('...through the timing line, which says why', t('timing')(y3) === 15 && t('timing')(y8) < t('timing')(y3) && /year 8/.test(y8.parts.find(p => p.key === 'timing').why) && /refinance/.test(refi.parts.find(p => p.key === 'timing').why));
  check('a stabilised deal with its checks answered earns more on risk than an empty one with inputs outstanding',
    t('risk')(deals.scoreDeal(deals.shapeCard(raw({ occupancy: 0.95, checks: { needs_input: 0 } }))) ) > t('risk')(deals.scoreDeal(deals.shapeCard(raw({ occupancy: 0.72, checks: { needs_input: 3 } })))));
  check('the weights and thresholds come from config/deal-score.json', JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'deal-score.json'), 'utf8')).weights.irr === 25 && /deal-score\.json/.test(fs.readFileSync(path.join(__dirname, '..', 'services', 'underwritingDeals.js'), 'utf8')));
  check('an unsolved IRR earns nothing on the IRR line', deals.scoreDeal(deals.shapeCard(raw({ irr: null, irr_failed: true }))).parts[0].points === 0);
  const tie = deals.rankProperties([prop('a', 0.1, 0.02), prop('b', 0.1, 0.06)]);
  check('equal IRRs are broken by cash-on-cash', tie.find(p => p.name === 'b').rank === 1);
  const tie2 = deals.rankProperties([prop('old', 0.1, 0.05, '2026-08-01T00:00:00.000Z'), prop('new', 0.1, 0.05, '2026-09-01T00:00:00.000Z')]);
  check('...and then the newer run', tie2.find(p => p.name === 'new').rank === 1);
  const withHidden = deals.rankProperties([Object.assign(prop('gone', 0.5, 0.5), { hidden: true }), prop('kept', 0.05, 0.01)]);
  check('a hidden deal is never ranked and does not push the others down', withHidden.find(p => p.name === 'gone').rank === null && withHidden.find(p => p.name === 'kept').rank === 1);
}

console.log('\nThe store (fake model reader, scratch folder)');
async function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uwd-'));
  const touch = (f, body = 'x') => fs.writeFileSync(path.join(dir, f), body);
  touch('Harbor-2026-09-25-21-23-03.xlsx'); touch('Willow-2026-09-14-19-45-10.xlsx'); touch('stray.xlsx'); touch('~$lock.xlsx'); touch('notes.txt');
  let reads = 0;
  const readCards = async files => {
    reads += 1;
    const out = {};
    for (const f of files) {
      const b = path.basename(f);
      out[f] = /stray/.test(b) ? { error: 'Not a Cedar Ridge underwriting model' } : raw({ name: /Harbor/.test(b) ? 'Harbor Row Portfolio' : 'Willow Bay' });
    }
    return out;
  };
  const s = deals.createStore({ dir, readCards });
  let list = await s.list();
  check('every model on the disk is a deal; lock files, text files and non-models are not', list.length === 2 && reads === 1);
  list = await s.list();
  check('the second look reads nothing: cards are cached against the file\'s mtime', reads === 1);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'Harbor-2026-09-25-21-23-03.xlsx'), later, later);
  await s.list();
  check('a model that changed on disk is read again', reads === 2);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'deals.json'), 'utf8'));
  Object.values(meta.models).forEach(m => { m.v = 1; });
  fs.writeFileSync(path.join(dir, 'deals.json'), JSON.stringify(meta));
  await deals.createStore({ dir, readCards }).list();
  check('a card shaped by an older version of the service is rebuilt from its model, not served stale', reads === 3);
  s.setProvenance('Harbor-2026-09-25-21-23-03.xlsx', { sources: [{ kind: 'rent_roll', filename: 'rr.xlsx' }], confirmed_by_hand: 3, confirmed_fields: ['Units (edited)'] });
  s.setHidden('Willow-2026-09-14-19-45-10.xlsx', true, 'owner@example.com');
  const fresh = deals.createStore({ dir, readCards });
  list = await fresh.list();
  const essex = list.find(d => /Harbor/.test(d.file)), willow = list.find(d => /Willow/.test(d.file));
  check('who/what/when survives a restart (it is a file on the Render disk)',
    essex.confirmed_by_hand === 3 && essex.sources[0].filename === 'rr.xlsx' && willow.hidden && willow.hidden.by === 'owner@example.com' && reads === 3);
  fresh.setHidden('Willow-2026-09-14-19-45-10.xlsx', false, 'x');
  check('restoring clears the hide', (await fresh.list()).find(d => /Willow/.test(d.file)).hidden === null);
  check('hiding never deletes the model', fs.existsSync(path.join(dir, 'Willow-2026-09-14-19-45-10.xlsx')));
  check('the sidecar sits beside the models', fs.existsSync(path.join(dir, 'deals.json')));
  // a repaired copy keeps citing the files its original was built from
  const rp = deals.createStore({ dir, readCards });
  rp.setProvenance('Harbor-2026-09-25-21-23-03.xlsx', { sources: [{ kind: 't12', filename: 'T12.xlsx', notes: ['n1'] }, { kind: 'rent_roll', filename: 'rr.xlsx' }], confirmed_by_hand: 2, confirmed_fields: ['Units (edited)'] });
  rp.setProvenance('Willow-2026-09-14-19-45-10.xlsx', { imported: true, sources: [{ kind: 'model', filename: 'Harbor-2026-09-25-21-23-03.xlsx', method: 'repaired copy of a damaged model', notes: ['fix'] }] });
  rp.markReport('Willow-2026-09-14-19-45-10.xlsx', { v: 7 });
  check('a repaired copy takes its original\'s sources, hand-confirmed fields and repair note, and its PDF is marked for a rebuild',
    rp.inheritRepairedProvenance() === 1 && rp.provenanceOf('Willow-2026-09-14-19-45-10.xlsx').sources.map(s => s.filename).join() === 'T12.xlsx,rr.xlsx'
      && rp.provenanceOf('Willow-2026-09-14-19-45-10.xlsx').confirmed_by_hand === 2 && rp.reportMeta('Willow-2026-09-14-19-45-10.xlsx').v === 0);
  check('...and running it again changes nothing', rp.inheritRepairedProvenance() === 0);
  rp.setProvenance('Harbor-2026-09-25-21-23-03.xlsx', { sources: [] });
  rp.setProvenance('Willow-2026-09-14-19-45-10.xlsx', { sources: [{ kind: 'model', filename: 'Harbor-2026-09-25-21-23-03.xlsx', method: 'repaired copy of a damaged model' }] });
  check('a copy whose original has no sources to give keeps its repair note', rp.inheritRepairedProvenance() === 0 && rp.provenanceOf('Willow-2026-09-14-19-45-10.xlsx').sources[0].kind === 'model');
}

console.log('\nThe scoring model editor and run dates');
{
  const tmp = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'uw-score-')), 'score-config.json');
  deals.useScoreOverride(tmp);
  const base = { computed: true, units: 200, occupancy: 0.95, price: 30e6, t12_noi: 2e6, irr_target: 0.16, irr: 0.2, coc: 0.07, equity_multiple: 2, dscr: 1.3, max_price: 33e6, meets_target: true, checks: { needs_input: 0 }, scenarios: [{ scenario: 'Sale Year 5', irr: 0.2 }] };
  const before = deals.scoreDeal(deals.shapeCard(base));
  check('with nothing saved the score uses the shipped defaults and nobody is credited', deals.scoreConfigInfo().updated === null && before.parts.length === 7);
  const info = deals.saveScoreConfig({ weights: { irr: 60, timing: 10, price: 10, coc: 10, em: 5, dscr: 5, risk: 0 } }, 'owner@example.com');
  const after = deals.scoreDeal(deals.shapeCard(base));
  check('a saved change re-scores every deal, and says who changed it and when', after.score !== before.score && info.updated.by === 'owner@example.com' && /^\d{4}-/.test(info.updated.at) && after.parts.find(x => x.key === 'irr').weight === 60);
  check('the saved file is on disk and no temp file is left behind', JSON.parse(fs.readFileSync(tmp, 'utf8')).config.weights.irr === 60 && !fs.existsSync(tmp + '.' + process.pid + '.tmp'));
  const odd = deals.sanitizeScoreConfig({ weights: { irr: 50, timing: 50, price: 50, coc: 50, em: 50, dscr: 50, risk: 50 }, grades: { A: 10, B: 50, C: 60, D: 70 }, coc: { zeroAt: 0.1, fullAt: 0.05 }, em: 'x', bogus: 1 });
  check('weights are scaled to add up to 100, grade cut-offs kept in order, a backwards curve and junk fall back to defaults',
    Math.abs(Object.values(odd.weights).reduce((a, b) => a + b, 0) - 100) < 1 && odd.grades.A > odd.grades.B && odd.coc.fullAt > odd.coc.zeroAt && typeof odd.em.zeroAt === 'number' && !('bogus' in odd));
  fs.writeFileSync(tmp, '{ this is not json');
  deals.useScoreOverride(tmp);
  check('a damaged file degrades to the defaults instead of breaking scoring', deals.scoreDeal(deals.shapeCard(base)).score === before.score);
  deals.saveScoreConfig({ weights: { irr: 40 } }, 'a');
  const reset = deals.resetScoreConfig();
  check('reset removes the shared copy and the defaults are back', reset.updated === null && deals.scoreDeal(deals.shapeCard(base)).score === before.score && !fs.existsSync(tmp));
  const prev = deals.scoreDeal(deals.shapeCard(base), deals.sanitizeScoreConfig({ weights: { irr: 80, timing: 5, price: 5, coc: 5, em: 5, dscr: 0, risk: 0 } }));
  check('a preview scores with a candidate model without saving it', prev.score !== before.score && !fs.existsSync(tmp));
  deals.useScoreOverride(null);
  check('a repaired copy was RUN when its original was, so its date is the original stamp, not the repair time',
    deals.runDate('Orchard-Village-2026-10-22-22-37-54-repaired-mvk6bldk.xlsx', Date.parse('2026-10-23T10:00:00Z')) === '2026-10-22T22:37:54.000Z'
    && deals.runDate('Station-2026-10-22-19-46-26-repaired-abc-repaired-def.xlsx', 0) === '2026-10-22T19:46:26.000Z');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('the editor has its routes: read, save, reset and preview', ['', '/reset', '/preview'].every(x => srv.includes("'/api/underwriting/score-config" + x + "'")));
}

console.log('\nAccess');
{
  const vOnly = { admin: false, tools: ['variances'] };
  const uw = { admin: false, tools: ['underwriting'] };
  const routes = ['/api/underwriting/score-config', '/api/underwriting/score-config/preview', '/api/underwriting/score-config/reset', '/api/underwriting/deals', '/api/underwriting/deals/hide', '/api/underwriting/deals/import', '/api/underwriting/peek', '/api/underwriting/parse-doc'];
  check('every new route is refused to someone without the Underwriting tool', routes.every(p => accessControl.decide(vOnly, 'POST', p).status === 403));
  check('...and allowed to someone with it', routes.every(p => accessControl.decide(uw, 'POST', p).ok));
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('server.js declares every one of them', routes.every(p => src.includes(`'${p}'`)));
}

console.log('\nThe demo\'s showcase deal (data/underwriting, read from its sidecar: no Python)');
{
  const dir = path.join(__dirname, '..', 'data', 'underwriting');
  const xlsx = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f)) : [];
  check('exactly one deal ships, and it is the fictional Riverbend Apartments', xlsx.length === 1 && /^Riverbend-Apartments-/.test(xlsx[0]), xlsx.join(', '));
  const meta = fs.existsSync(path.join(dir, 'deals.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'deals.json'), 'utf8')) : { models: {} };
  const rec = xlsx.length ? meta.models[xlsx[0]] : null;
  check('its card was read from the model, passes the plausibility gate and is computed', !!rec && rec.card.computed === true && !rec.card.needs_review && rec.card.units === 96);
  const sc = rec ? deals.scoreDeal(rec.card) : { score: null };
  check('it meets its IRR target and scores B or better (the showcase should look like a good deal)', !!rec && rec.card.meets_target === true && sc.score >= 75 && /^[AB]$/.test(sc.grade), JSON.stringify(sc.score));
  check('its PDF report sits beside the model', xlsx.length === 1 && fs.existsSync(path.join(dir, xlsx[0].replace(/\.xlsx$/i, '.pdf'))));
  const sample = path.join(__dirname, '..', 'underwriting', 'sample');
  check('the sample documents behind "Try with sample documents" are all there', ['Riverbend Apartments - Rent Roll.xlsx', 'Riverbend Apartments - T12.xlsx', 'Riverbend Apartments - Offering Memorandum.pdf', 'riverbend-om-extracted.json', 'riverbend-lookups.json', 'riverbend-deal.json'].every(f => fs.existsSync(path.join(sample, f))));
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('with no API key in demo mode the OM, tax, occupancy and document reads answer from the sample instead of failing', ['om-extract', 'tax-lookup', 'occupancy-lookup', 'parse-doc'].every(r => new RegExp(`'/api/underwriting/${r}'[\\s\\S]{0,1200}?(uwDemoNoKey\\(\\))`).test(srv)));
}

store().then(() => {
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll underwriting-deal checks passed.');
  process.exit(failed ? 1 : 0);
});
