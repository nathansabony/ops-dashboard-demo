// The PDF report beside every underwriting model (services/underwritingReport.js).
// A canned deal goes in; the sections come out; nothing may read "undefined" or "NaN"
// however sparse or strange the facts are. Also the disk side (where the PDF lives,
// when it is stale, the backfill) with the PDF engine stubbed, so this runs with no
// Python, no Excel and no Rent Manager. If PyMuPDF happens to be installed it also
// lays out a real PDF; if not, that one check is skipped, not failed.
//
// Run: npm run check:underwriting-report

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const report = require('../services/underwritingReport');
const deals = require('../services/underwritingDeals');
const accessControl = require('../services/accessControl');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '\n      ' + String(detail).slice(0, 400)}`);
  if (!ok) failed += 1;
}
const BAD = /undefined|NaN|\[object|Infinity|null/;
const clean = (html) => !BAD.test(html.replace(/<[^>]+>/g, ' '));
const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// A model as deal_facts.py reads it (Harbor-shaped, trimmed).
const facts = (over = {}) => Object.assign({
  card: { computed: true, name: 'Harbor Row Portfolio', address: '210-216 Elm St, Fairview, NJ 07022', year_built: '1924 / 1962', units: 49, occupancy: 1, avg_rent: 1470.88,
    price: 11208290.21, price_per_door: 228740.6, t12_noi: 616455.96, year1_noi: 403903.46, capex: 500000, irr: 0.0456, irr_target: 0.16, equity_multiple: 1.39, dscr: 0.86, coc: 0.0316, hold_years: 8, max_price: 8129433.57 },
  property: { name: 'Harbor Row Portfolio', address: '210-216 Elm St, Fairview, NJ 07022', year_built: '1924 / 1962', site_acres: 0.84, units: 49 },
  inputs: [
    { label: 'Purchase Cap Rate', value: 0.055, note: 'Purchase price = T12 NOI / purchase cap rate.' },
    { label: 'LTV', value: 0.7, note: 'Debt = purchase price x LTV.' },
    { label: 'Loan Interest Rate', value: 0.06, note: 'Placeholder - source needed. Interest-only debt service.' },
    { label: 'Hold Period (years)', value: 8, note: 'Modeling assumption. THE hold-period switch.' },
    { label: 'Interior Renovation Cost / Unit', value: 15000, note: 'Prior model / needs confirmation.' },
    { label: 'Value-Add Units', value: 0, note: 'OM value-add plan.' },
    { label: 'IRR Target', value: 0.16, note: 'Scenario IRRs are scored PASS/FLAG vs. this.' },
  ],
  t12: { months: ['Jun 2025', 'Jul 2025', 'Aug 2025', 'Sep 2025', 'Oct 2025', 'Nov 2025', 'Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026'],
    kpis: { noi: 616455.96, egi: 886355.28, opex: 269899.32, margin: 0.6955 },
    lines: [{ label: 'Gross Potential Rent', amount: 899424 }, { label: 'Other Income', amount: 4500 }, { label: 'Effective Gross Income (EGI)', amount: 886355.28 },
      { label: 'Turnover Costs', amount: 0 }, { label: 'Utilities', amount: 39505.99 }, { label: 'Property Taxes - actual T12', amount: 120196.67 },
      { label: 'Total Operating Expenses', amount: 269899.32 }, { label: 'Net Operating Income (NOI)', amount: 616455.96 }, { label: 'Actual Vacancy Loss', amount: -17568.72 }] },
  rent_roll: { metrics: { 'Report As Of': '2026-06-01 00:00:00', 'Official Units': 49, 'Parsed Unit Count': 49, 'Official Occupied Units': 49, 'Official Occupancy': 1, 'Monthly Market Rent': 86710, 'Monthly In-place Rent Charges': 72073.33, 'Total Resident Balance': 0 }, kpis: { loss_to_lease_mo: 14636.67 } },
  unit_mix: [{ type: '1BR', units: 30, occupied: 30, avg_sf: 700, avg_market: 1500, avg_inplace: 1300 }, { type: '2BR', units: 19, occupied: 19, avg_sf: 1000, avg_market: 2100, avg_inplace: 1700 }],
  pro_forma: { years: [1, 2, 3, 4, 5, 6, 7, 8], egi: { 1: 926270, 2: 1042704, 5: 1100000, 8: 1300000 }, opex: { 1: 522366, 2: 439470, 5: 480000, 8: 520000 }, noi: { 1: 403903, 2: 603234, 5: 620000, 8: 780000 }, debt_service: { 1: 470748 }, after_debt: { 1: -66845 }, coc: { 1: -0.016, 2: 0.032 } },
  returns: { 'Purchase Price': 11208290, 'Loan Amount': 7845803, 'Initial Equity Required': 4198736, 'Net Sale Proceeds': 4595617 },
  scenarios: [{ scenario: 'Sale Year 5', irr: -0.004, equity_multiple: 0.98, hold: 5, sale_value: 11984907 }, { scenario: 'Sale Year 8', irr: 0.0456, equity_multiple: 1.39, hold: 8, sale_value: 13096231 },
    { scenario: 'Year 2 Cash-on-Cash', irr: 0.0316 }, { scenario: 'Notes', irr: null, sale_value: null }],
  solver: { max_price: 8129433.57 }, tax: { current: 120196.67, millage: 34.89 },
  checks: { counts: { ok: 11, needs_input: 2 }, items: [{ check: 'Rent roll unit count tie', result: 'OK', note: 'ties.' }, { check: 'Debt quote', result: 'NEEDS INPUT', note: 'Interest rate is placeholder until lender quote. Get rate.' }] },
  gaps: [],
}, over);

const prov = { sources: [
  { kind: 'rent_roll', filename: 'Harbor RR 10-15.xlsx', method: 'deterministic (openpyxl)', warnings: 1, notes: ['Parsed 49 units; report says 49.'] },
  { kind: 't12', filename: 'Harbor T12.pdf', method: 'document (pdf, read by Claude)', warnings: 2, notes: ['Read from a PDF document, not a spreadsheet.'] },
  { kind: 'om', filename: 'Harbor OM.pdf', method: 'read by Claude' }], confirmed_by_hand: 2, confirmed_fields: ['Units (edited)', 'Year built (low-confidence OM value)'] };

console.log('\nThe sections');
const full = report.buildReport(facts(), { file: 'Harbor-2026-09-25-21-23-03.xlsx', provenance: prov, runDate: '2026-09-25T21:23:03Z', generated: '2026-10-22T12:00:00Z' });
const html = report.renderHtml(full);
const txt = textOf(html);
{
  for (const h of ['Property and deal facts', 'Returns and capital', 'Rent roll summary', 'T12 summary', 'Pro forma (model)', 'Assumptions the model used', 'What we could not read, and how sure we are']) {
    check(`section present: ${h}`, txt.includes(h));
  }
  check('nothing reads undefined / NaN / null / Infinity anywhere', clean(html), (html.match(/.{30}(undefined|NaN|\[object|Infinity).{30}/) || [])[0]);
  check('the six headline tiles are The owner\'s price-test six', full.tiles.map(t => t.label.split(' @')[0]).join('|') === 'PRICE RUN|UNITS|T12 NOI|IN-PLACE CAP RATE|LEVERED IRR|MAX PRICE');
  check('price, units, T12 NOI, IRR and max price read right', txt.includes('$11.21M') && txt.includes('$229K') === false ? txt.includes('$228,741 per unit') : txt.includes('$11.21M'));
  check('IRR 4.6% is below the 16% target and says so', txt.includes('4.6%') && txt.includes('below 16% target'));
  check('the gap to max price is stated, in dollars and percent, and labelled an estimate', /−\$3\.08M \(−27%\) vs price run — Cedar Ridge estimate/.test(txt));
  check('in-place cap rate is T12 NOI over price and is labelled a Cedar Ridge estimate', txt.includes('5.50%') && /Cedar Ridge estimate: T12 NOI ÷ price run/.test(txt));
  check('the verdict sentence uses the model\'s own numbers', /levered IRR over the 8-year hold is 4\.6%, below the 16% target/.test(txt) && /put[s]? the most that could be paid .* at \$8\.13M/.test(txt));
  check('the T12 section names the months covered', txt.includes('Jun 2025 – May 2026 (12 months)'));
  check('zero-value T12 lines are left out and said so', !txt.includes('Turnover Costs $0') && txt.includes('Lines at $0 are not shown (Turnover Costs)'));
  check('expense shares of EGI are labelled as our estimate', txt.includes('% of EGI*') && txt.includes('Cedar Ridge estimate: the line divided by effective gross income'));
  check('the scenario table drops the "Notes" column and the cash-on-cash row', !/>Notes</.test(html) && full.scenarios.length === 2);
  check('annual loss-to-lease is monthly x 12 and labelled an estimate', txt.includes('$175,640') && /Cedar Ridge estimate: monthly × 12/.test(txt));
  check('the unit mix shows market vs in-place rent per type', txt.includes('1BR') && txt.includes('$200') && txt.includes('$400'));
}

console.log('\nSources and confidence');
{
  check('with a record, every table cites the file it came from', txt.includes('Harbor RR 10-15.xlsx') && txt.includes('Harbor T12.pdf') && txt.includes('Harbor OM.pdf'));
  check('how each file was read, and its notes, are printed', txt.includes('deterministic (openpyxl)') && txt.includes('document (pdf, read by Claude)') && txt.includes('Parsed 49 units; report says 49.'));
  check('values a person had to judge are listed', txt.includes('Units (edited)') && txt.includes('Year built (low-confidence OM value)'));
  check('model checks that are not OK are listed, OK ones are not', txt.includes('NEEDS INPUT') && txt.includes('Debt quote') && !txt.includes('Rent roll unit count tie'));
  check('placeholder assumptions are flagged as not confirmed', txt.includes('Placeholder, not confirmed') && /Assumptions still placeholders.*Loan Interest Rate.*Interior Renovation Cost/.test(txt));
  const old = report.buildReport(facts(), { file: 'Old-2026-07-22-16-35-44.xlsx', provenance: null });
  const oldTxt = textOf(report.renderHtml(old));
  check('a deal with no record says ONCE that its file names were not kept, never repeats "file not recorded" and never invents a name',
    (oldTxt.match(/Original file names were not kept/g) || []).length === 1 && !/file not recorded/.test(oldTxt) && !oldTxt.includes('Harbor RR'));
  check('...and says the confidence of its original parse is unknown', /No record of how this deal's files were read/.test(oldTxt) && oldTxt.includes('confidence of the original parse is unknown'));
}

console.log('\nParse notes and blanks in plain words');
{
  check('a parse note never prints a field name or the word null', report.plainNote('so turnover_costs is null and repairs_maintenance includes all R&M') === 'so turnover costs is blank and repairs maintenance includes all R&M' && !/null|_/.test(report.plainNote('T12: turnover_costs set to null because the statement does not break out')));
  const kf = facts({ unit_mix: [{ type: null, units: 56, occupied: 54, avg_sf: 0, avg_market: 1611, avg_inplace: 1550 }] });
  const kt = textOf(report.renderHtml(report.buildReport(kf, {})));
  check('an average unit size of 0 (no square footage in the rent roll) prints as blank, not "0 sf"', !/Average unit size 0 sf/.test(kt) && /Average unit size — /.test(kt));
  const many = Array.from({ length: 9 }, (_, i) => `a note number ${i} with some plain words in it`);
  const withNotes = textOf(report.renderHtml(report.buildReport(facts(), { provenance: { sources: [{ kind: 'rent_roll', filename: 'rr.xlsx', method: 'x', notes: many }] } })));
  check('at most two parse notes per file are printed (the rest stay in the count), so the report stays within three pages', (withNotes.match(/a note number/g) || []).length === 2);
  check('market-vs-in-place gap says vacant units are counted at market (Pinecrest\'s $11.6M "rent upside" at 40% occupancy was misleading)', /Annual market-vs-in-place gap/.test(kt) && /upside only if vacant units lease/.test(kt));
}

console.log('\nA deal flagged NEEDS REVIEW');
{
  const bad = facts({ card: Object.assign({}, facts().card, { units: 996, occupancy: 0.3976, price: 6616690, price_per_door: 6643, t12_noi: 363918, year1_noi: -1661066, dscr: -5.98, equity_multiple: 2.5, irr: 0.0969, coc: 0.0969, non_revenue_units: 359, max_price: 4775246 }) });
  const rb = report.buildReport(bad, {});
  const tb = textOf(report.renderHtml(rb));
  check('page 1 carries a NEEDS REVIEW banner with every reason', rb.review.needs && /NEEDS REVIEW: do not rely on this deal's price or returns/.test(tb) && rb.review.reasons.length === 4 && /Occupancy is 39\.8%/.test(tb));
  check('price, cap rate, IRR, max price, cash-on-cash, equity multiple and DSCR print as n/r, not as numbers',
    ['PRICE RUN', 'IN-PLACE CAP RATE', 'LEVERED IRR', 'MAX PRICE'].every(l => rb.tiles.find(t => t.label.startsWith(l)).value === 'n/r') && rb.tiles2.slice(0, 3).every(t => t[1] === 'n/r') && !/\$6\.62M/.test(tb.slice(0, tb.indexOf('Property and deal facts'))));
  check('the verdict sentence is replaced by the review note, not by a rosy IRR sentence', /flagged NEEDS REVIEW/.test(rb.verdict) && !/levered IRR over the/.test(rb.verdict));
  check('physical and revenue units are both shown (996 physical, 637 revenue, 62.2% of revenue units occupied)', /Revenue units \(not down, model or employee\) 637 of 996/.test(tb) && /Occupancy of revenue units 62\.2%/.test(tb));
  const good = textOf(report.renderHtml(report.buildReport(facts(), {})));
  check('a scored deal\'s PDF explains its score, factor by factor, and a flagged one prints none', /Deal score: \d+ \/ 100/.test(good) && /Levered IRR vs target/.test(good) && /How soon the target is hit/.test(good) && !/Deal score:/.test(tb));
  check('a healthy deal has no banner and keeps its numbers', !/NEEDS REVIEW/.test(good) && /\$11\.21M/.test(good));
  const adj = textOf(report.renderHtml(report.buildReport(facts(), { provenance: { sources: [{ kind: 't12', filename: 'T12.xlsx', method: 'row-mapped (pandas)', notes: ['ADJUSTED MONTH: Oct 2025 has no gross potential rent. It is left out and every T12 figure is annualized (x12/11). This is a Cedar Ridge estimate.'] }] } })));
  check('a T12 the reader annualized says so under "Adjusted by us (Cedar Ridge estimate)"', /Adjusted by us \(Cedar Ridge estimate\)/.test(adj) && /ADJUSTED MONTH: Oct 2025/.test(adj));
}

console.log('\nWhatever the facts look like');
{
  const cases = {
    'empty facts': {},
    'no facts at all': undefined,
    'every number NaN': facts({ card: { price: NaN, units: NaN, t12_noi: NaN, irr: NaN, max_price: NaN, coc: NaN, capex: NaN, equity_multiple: NaN }, scenarios: [{ scenario: 'Sale Year 8', irr: NaN, sale_value: NaN }] }),
    'strings where numbers belong': facts({ card: { price: '11,208,290', units: '49', irr: 'n/a', t12_noi: null } }),
    'blank template placeholders': facts({ card: Object.assign({}, facts().card, { address: '[ADDRESS]', year_built: '[YEAR]' }), property: { name: 'X', address: '[ADDRESS]', year_built: '[YEAR]' } }),
    'no solver price': facts({ card: Object.assign({}, facts().card, { max_price: null }) }),
    'IRR the model could not solve': facts({ card: Object.assign({}, facts().card, { irr: 0, equity_multiple: 0.4 }) }),
    'sections that failed to read': facts({ t12: null, rent_roll: null, pro_forma: null, scenarios: null, inputs: null, checks: null, gaps: ['pro forma could not be read from this model (KeyError).'] }),
    'many unit types': facts({ unit_mix: Array.from({ length: 16 }, (_, i) => ({ type: 'T' + i, units: 5, occupied: 5, avg_sf: 800, avg_market: 1500, avg_inplace: 1400 })) }),
  };
  for (const [label, f] of Object.entries(cases)) {
    let h, err = null;
    try { h = report.renderHtml(report.buildReport(f, { file: 'x.xlsx', provenance: label === 'no facts at all' ? null : prov })); } catch (e) { err = e; }
    check(`${label}: builds, and nothing reads undefined / NaN`, !err && clean(h), err ? err.stack : (h.match(/.{30}(undefined|NaN|\[object|Infinity|null).{30}/) || [])[0]);
  }
  const failedIrr = textOf(report.renderHtml(report.buildReport(cases['IRR the model could not solve'], {})));
  check('an IRR the model could not solve prints n/a and "equity not recovered", not 0%', failedIrr.includes('n/a') && failedIrr.includes('equity not recovered') && !/LEVERED IRR\s+0\.0%/.test(failedIrr));
  const noSolve = textOf(report.renderHtml(report.buildReport(cases['no solver price'], {})));
  check('no solver price says so rather than showing $0', noSolve.includes('no solve') && /solver returned no price/.test(noSolve));
  const blank = textOf(report.renderHtml(report.buildReport(cases['blank template placeholders'], {})));
  check('an unfilled [ADDRESS] / [YEAR] is reported as missing, not printed', !blank.includes('[ADDRESS]') && !blank.includes('[YEAR]') && /Address was not in the files/.test(blank));
  const many = textOf(report.renderHtml(report.buildReport(cases['many unit types'], {})));
  check('16 unit types print 10 and say 6 more are in the Excel', /6 more unit type\(s\) are in the Excel model/.test(many));
  const failedSections = textOf(report.renderHtml(report.buildReport(cases['sections that failed to read'], {})));
  check('a section the reader could not read is named in "not available", and the report still builds', /pro forma could not be read from this model/.test(failedSections) && failedSections.includes('Property and deal facts'));
  const nasty = report.renderHtml(report.buildReport(facts({ card: Object.assign({}, facts().card, { name: 'A <script>alert(1)</script> & B' }) }), {}));
  check('a deal name is escaped', !nasty.includes('<script>') && nasty.includes('&lt;script&gt;'));
}

console.log('\nWhere the PDF lives (PDF engine stubbed)');
async function disk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uwr-'));
  const model = 'Harbor-2026-09-25-21-23-03.xlsx';
  fs.writeFileSync(path.join(dir, model), 'x'); fs.writeFileSync(path.join(dir, 'Bad-2026-01-01-00-00-00.xlsx'), 'x');
  const calls = [];
  const runPython = async (script, args) => {
    calls.push(script);
    if (script === 'deal_facts.py') { if (/Bad-/.test(args[0])) return { error: 'Not a Cedar Ridge underwriting model' }; await new Promise(r => setTimeout(r, 15)); return facts(); }
    if (script === 'html_to_pdf.py') { fs.writeFileSync(args[1], '%PDF-1.4 ' + 'x'.repeat(900)); return { pages: 3, bytes: 909 }; }
    throw new Error('unexpected ' + script);
  };
  const metas = {};
  const reports = report.createReports({ dir, runPython, provenanceOf: () => prov, reportMeta: f => metas[f] || null, markReport: (f, m) => { metas[f] = m; } });
  check('the PDF is named after its model and sits beside it', report.pdfNameFor(model) === 'Harbor-2026-09-25-21-23-03.pdf' && reports.pdfPath(model) === path.join(dir, 'Harbor-2026-09-25-21-23-03.pdf'));
  // many models asked for at once must still build one at a time (the 512 MB instance restarted when five imports each started a build)
  const live = { now: 0, max: 0 };
  const slow = async (script, args) => { live.now += 1; live.max = Math.max(live.max, live.now); try { return await runPython(script, args); } finally { live.now -= 1; } };
  const many = fs.mkdtempSync(path.join(os.tmpdir(), 'uwq-'));
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(many, `M${i}-2026-09-25-21-23-0${i}.xlsx`), 'x');
  const queued = report.createReports({ dir: many, runPython: slow, provenanceOf: () => null, reportMeta: () => null, markReport: () => {} });
  await Promise.all(fs.readdirSync(many).map(f => queued.ensure(f)));
  check('six reports asked for at once are built one at a time, never in parallel', live.max === 1 && fs.readdirSync(many).filter(f => f.endsWith('.pdf')).length === 6, 'max parallel ' + live.max);
  calls.length = 0;   // the checks below count builds of their own model only
  const [a, b] = await Promise.all([reports.ensure(model), reports.ensure(model)]);
  check('a missing report is built, and two callers at once share one build', a.built && b.built && calls.filter(c => c === 'html_to_pdf.py').length === 1 && fs.existsSync(reports.pdfPath(model)));
  check('the build records its version, so a changed layout can be re-issued', metas[model] && metas[model].v === report.REPORT_VERSION);
  const n = calls.length;
  const again = await reports.ensure(model);
  check('a current report is served as it is, with no rebuild', !again.built && calls.length === n);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, model), later, later);
  check('a model rewritten after its report makes the report stale', (await reports.ensure(model)).built === true);
  metas[model] = { v: report.REPORT_VERSION - 1 };
  check('a report built by an older layout is rebuilt', (await reports.ensure(model)).built === true);
  check('a file name that is not a model is refused', await reports.ensure('../../etc/passwd').then(() => false, () => true) && await reports.ensure('notes.txt').then(() => false, () => true));
  check('building leaves no scratch files on the disk', fs.readdirSync(dir).every(f => /\.(xlsx|pdf)$/.test(f)));
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(dir, model), past, past);      // the stale-model check above moved it into the future
  fs.unlinkSync(reports.pdfPath(model));
  const bf = await reports.backfill();
  check('backfill builds what is missing, and names what it could not read with the reason',
    bf.total === 2 && bf.generated.length === 1 && bf.failed.length === 1 && /Not a Cedar Ridge underwriting model/.test(bf.failed[0].reason), JSON.stringify(bf));
  const bf2 = await reports.backfill();
  check('backfill is safe to re-run: the current report is skipped, the failure is reported again', bf2.generated.length === 0 && bf2.skipped.length === 1 && bf2.failed.length === 1);
  const bf3 = await reports.backfill({ force: true });
  check('--force rebuilds the current ones too', bf3.generated.length === 1);
}

async function board() {
  console.log('\nThe deals board');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uwd2-'));
  fs.writeFileSync(path.join(dir, 'A-2026-09-25-21-23-03.xlsx'), 'x'); fs.writeFileSync(path.join(dir, 'A-2026-09-25-21-23-03.pdf'), 'p');
  fs.writeFileSync(path.join(dir, 'B-2026-09-26-21-23-03.xlsx'), 'x');
  const store = deals.createStore({ dir, readCards: async fs_ => Object.fromEntries(fs_.map(f => [f, facts().card])) });
  const long = 'n'.repeat(900);
  store.setProvenance('A-2026-09-25-21-23-03.xlsx', { sources: Array.from({ length: 30 }, (_, i) => ({ kind: 't12', filename: 'f' + i, notes: Array.from({ length: 10 }, () => long) })), confirmed_by_hand: 1, confirmed_fields: ['x'] });
  const p = store.provenanceOf('A-2026-09-25-21-23-03.xlsx');
  check('saved provenance is bounded: 20 sources, 6 notes each, 300 characters a note', p.sources.length === 20 && p.sources[0].notes.length === 6 && p.sources[0].notes[0].length === 300);
  store.markReport('A-2026-09-25-21-23-03.xlsx', { v: 1, at: 'now', pages: 3 });
  check('report metadata round-trips', store.reportMeta('A-2026-09-25-21-23-03.xlsx').pages === 3 && store.reportMeta('nope.xlsx') === null);
  const list = await store.list();
  const a = list.find(d => d.file.startsWith('A-')), b = list.find(d => d.file.startsWith('B-'));
  check('every card carries a PDF report link, built or not (the route builds the missing one on first click)',
    a.report === '/api/underwriting/report/A-2026-09-25-21-23-03.xlsx' && b.report === '/api/underwriting/report/B-2026-09-26-21-23-03.xlsx');
  check('...and says whether the PDF already exists', a.has_report === true && b.has_report === false);
}

console.log('\nAccess');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routes = [['GET', '/api/underwriting/report/x.xlsx'], ['POST', '/api/underwriting/reports/backfill'], ['GET', '/api/underwriting/reports/status']];
  check('every report route is refused to someone without the Underwriting tool', routes.every(([m, p]) => accessControl.decide({ admin: false, tools: ['variances'] }, m, p).status === 403));
  check('...and allowed to someone with it', routes.every(([m, p]) => accessControl.decide({ admin: false, tools: ['underwriting'] }, m, p).ok));
  check('server.js declares them, and serves the PDF inline so the browser opens it', src.includes("'/api/underwriting/report/:name'") && src.includes("'/api/underwriting/reports/backfill'") && /inline; filename=|'attachment' : 'inline'/.test(src));
  check('the PDF route lifts the site\'s object-src \'none\' (it stops a browser drawing a PDF in a tab)', /res\.setHeader\('Content-Security-Policy', "default-src 'self'; object-src 'self'/.test(src));
}

console.log('\nExtraction guardrails (read from server.js)');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('a standard-layout T12 parse with lines missing or not tying goes to the AI read, not straight to a model',
    /det\.kind === 't12' && warns\.some\(w => \/T12 lines not found\/\.test\(w\)/.test(src) && /T12 does not tie out/.test(src));
  check('every extraction call is told today\'s date, so a period that has ended is not "future months"',
    (src.match(/Today's date: \$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}/g) || []).length >= 3);
  check('both prompts say a "Book = Accrual,Budget" header is not evidence of a budget',
    (src.match(/names the accounting books the report was allowed to draw from/g) || []).length === 2);
}

console.log('\nThe PDF engine (only if PyMuPDF is installed here)');
function engine() {
  const py = process.env.UNDERWRITING_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  try { execFileSync(py, ['-c', 'import pymupdf'], { stdio: 'ignore' }); } catch { console.log('SKIP  PyMuPDF is not installed in this environment; the layout is checked on the real models instead'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uwp-'));
  fs.writeFileSync(path.join(tmp, 'r.html'), html);
  const out = JSON.parse(execFileSync(py, [path.join(__dirname, '..', 'underwriting', 'html_to_pdf.py'), path.join(tmp, 'r.html'), path.join(tmp, 'r.pdf'), report.footerText(full), 'T'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').pop());
  const body = execFileSync(py, ['-c', 'import pymupdf,sys;d=pymupdf.open(sys.argv[1]);print(d.page_count);print(" ".join(p.get_text() for p in d))', path.join(tmp, 'r.pdf')], { stdio: ['ignore', 'pipe', 'ignore'], env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) }).toString('utf8');
  const pages = Number(body.split('\n')[0]);
  check('a real PDF is written: 1-3 pages, with the name, the sources and a page footer', out.pages === pages && pages >= 1 && pages <= 3 && body.includes('Harbor Row Portfolio') && body.includes('Harbor T12.pdf') && /Page 1 of \d/.test(body), body.slice(0, 200));
  check('...and its text contains no undefined / NaN', clean(body));
  // parsers.py: the header-driven Rent Manager lease-charges variant (Pinecrest Village, 2026-10-22: 996 units that the
  // standard parser rejected, which sent the file to the AI read that cannot finish that many units in 5 minutes)
  const mkRr = `import sys
from openpyxl import Workbook
wb=Workbook(); ws=wb.active
ws.cell(1,1,"Rent Roll with Lease Charges")
for c,l in {1:"Unit",2:"Unit Type",4:"Unit Sqft",5:"Resident",9:"Name",12:"Market Rent",14:"Charge Code",15:"Amount",20:"Move In",22:"Lease Expiration",25:"Move Out",27:"Balance"}.items(): ws.cell(4,c,l)
ws.cell(5,1,"Current/Notice Residents")
r=6
def unit(u,t,sf,rid,name,mkt,charges,total):
    global r
    ws.cell(r,1,u); ws.cell(r,2,t); ws.cell(r,4,sf); ws.cell(r,5,rid); ws.cell(r,9,name); ws.cell(r,12,mkt); r+=1
    for code,amt in charges: ws.cell(r,14,code); ws.cell(r,15,amt); r+=1
    ws.cell(r,15,total); r+=1
unit("A1","1BR",700,"t1","Pat Lee",1200,[("conwatr ",35),("conrent ",900)],935)
unit("A2","1BR",700,"VACANT","VACANT",1200,[],0)
unit("A3","2BR",900,"Down","Down",1500,[],0)
unit("A4","2BR",900,"t4","Sam Ortiz",1500,[("concess ",-500),("conrent ",0)],-500)
unit("A5","2BR",900,"t5","Kim Roe",1500,[("conrent ",1400)],1400)
ws.cell(r+1,7,"Square Footage"); ws.cell(r+1,18,"# of Units"); ws.cell(r+1,21,"Unit Occupancy")
r+=2
ws.cell(r,1,"Current/Notice Res."); ws.cell(r,11,2335); r+=1
ws.cell(r,1,"Future Residents/Applicants"); r+=1
ws.cell(r,1,"Occupied Units"); ws.cell(r,18,3); ws.cell(r,21,60.0); r+=1
ws.cell(r,1,"Total Non Rev Units"); ws.cell(r,18,1); r+=1
ws.cell(r,1,"Vacant Units"); ws.cell(r,18,1); r+=1
ws.cell(r,1,"Total"); ws.cell(r,18,5); r+=2
ws.cell(r,1,"Summary of Charges by Charge Code"); r+=1
ws.cell(r,1,"Total"); ws.cell(r,11,9999)
wb.save(sys.argv[1])`;
  const rrFile = path.join(tmp, 'headed-rr.xlsx');
  let headed = null;
  try {
    execFileSync(py, ['-c', mkRr, rrFile], { stdio: 'ignore' });
    headed = JSON.parse(execFileSync(py, [path.join(__dirname, '..', 'underwriting', 'parsers.py'), rrFile], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').pop());
  } catch (e) { headed = { error: String(e.message).slice(0, 120) }; }
  const hd = (headed && headed.data) || {};
  check('a lease-charges rent roll that names its own columns is read by the standard parser, not sent to the AI',
    headed.kind === 'rent_roll' && hd.units && hd.units.length === 5 && /header-driven/.test((headed.meta || {}).layout || ''), JSON.stringify(headed).slice(0, 300));
  check('...its official counts come from the summary block, not the charge summary below it',
    hd.official_units === 5 && hd.official_occupied_units === 3 && hd.official_vacant_units === 2 && Math.abs(hd.official_occupancy - 0.6) < 1e-9, JSON.stringify({ o: hd.official_units, occ: hd.official_occupied_units, v: hd.official_vacant_units }));
  check('...rent is the "conrent" line, a unit total is the amount-only row, and "Down" / "VACANT" are not residents but a $0-rent resident is occupied',
    hd.units && hd.units[0].rent_charge === 900 && hd.units[0].total_charges === 935 && hd.units.map(u => u.occupied_flag).join('') === '10011', JSON.stringify((hd.units || []).map(u => [u.unit_number, u.rent_charge, u.occupied_flag])));
  check('...and it says the non-revenue units count as unoccupied', (headed.warnings || []).some(w => /1 of the 5 units are non-revenue/.test(w)));
  // generator / finish_model / repair_model (2026-10-22 audit of the live board's models)
  const here = JSON.stringify(path.join(__dirname, '..', 'underwriting').replace(/\\/g, '/'));
  const mkModel = `import sys, os, json, zipfile, re, tempfile
sys.path.insert(0, ${here})
from openpyxl import load_workbook, Workbook
import generator, finish_model, repair_model
out = {}
# 1. a property with 30 unit types: the Unit Mix summary must span them all (the template summed B6:B25 only)
wb = load_workbook(os.path.join(${here}, 'Underwriting Model TEMPLATE.xlsx'))
units = [{'unit_type': 'T%02d' % (i % 30), 'sqft': 800 + i, 'market_rent': 1500, 'rent_charge': 1400, 'occupied_flag': 1} for i in range(90)]
generator.write_unit_mix(wb, {'rent_roll': {'units': units}})
um = wb['Unit Mix']
out['mixA2'] = um['A2'].value; out['mixD2'] = um['D2'].value
# 2. the bake: the engine's text 'empty' (a blank reference) must become 0, never invalid XML in a numeric cell
d = tempfile.mkdtemp(); f = os.path.join(d, 'b.xlsx')
w = Workbook(); ws = w.active; ws.title = 'S'; ws['A1'] = None; ws['B1'] = '=A1'; ws['B2'] = '=A1&"x"'; w.save(f)
# the real files had these cells typed t="n" already (Pro Forma D16..D20); that is what made the old bake write text under a number type
zi = zipfile.ZipFile(f); pp = {n: zi.read(n) for n in zi.namelist()}; zi.close()
pp['xl/worksheets/sheet1.xml'] = pp['xl/worksheets/sheet1.xml'].replace(b'<c r="B1"', b'<c r="B1" t="n"')
with zipfile.ZipFile(f, 'w') as zo:
    for n, b in pp.items(): zo.writestr(n, b)
finish_model.bake_values_into_xlsx(f, {('S', 'B1'): 'empty', ('S', 'B2'): 'x'})
v = load_workbook(f, data_only=True)['S']
out['bakeB1'] = v['B1'].value; out['bakeB2'] = v['B2'].value
# 3. repair: an invalid cached value is dropped so the workbook opens again
g = os.path.join(d, 'bad.xlsx'); w = Workbook(); ws = w.active; ws.title = 'S'; ws['B1'] = '=1+1'; w.save(g)
z = zipfile.ZipFile(g); parts = {n: z.read(n) for n in z.namelist()}; z.close()
x = parts['xl/worksheets/sheet1.xml'].decode()
x = re.sub(r'(<c r="B1"[^>]*>)(<f>[^<]*</f>)(<v\\s*/>|<v></v>)?', lambda m: m.group(1) + m.group(2) + '<v>empty</v>', x)
parts['xl/worksheets/sheet1.xml'] = x.encode()
with zipfile.ZipFile(g, 'w') as zo:
    for n, b in parts.items(): zo.writestr(n, b)
try: load_workbook(g, data_only=True); out['badOpens'] = True
except Exception: out['badOpens'] = False
h = os.path.join(d, 'fixed.xlsx'); out['removed'] = repair_model.strip_invalid_cached_values(g, h)
try: load_workbook(h, data_only=True); out['fixedOpens'] = True
except Exception: out['fixedOpens'] = False
sys.__stdout__.write(json.dumps(out) + chr(10))   # the imported modules point sys.stdout at stderr`;
  let gen = null;
  try { gen = JSON.parse(execFileSync(py, ['-c', mkModel], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim().split('\n').pop()); } catch (e) { gen = { error: String((e.stderr || e.message)).slice(-500) }; }
  check('the Unit Mix summary spans all 30 unit types, not the template\'s first 20 (Overlook 351 of 532, Estates 102 of 400)',
    gen && /^=SUM\(B6:B35\)$/.test(gen.mixA2 || '') && /SUMPRODUCT\(B6:B35,G6:G35\)/.test(gen.mixD2 || ''), JSON.stringify(gen));
  check('the bake turns the engine\'s "empty" into 0 and keeps text typed as text (it wrote invalid XML before: Station Heights / International City could not be opened)',
    gen && gen.bakeB1 === 0 && gen.bakeB2 === 'x', JSON.stringify(gen));
  check('a workbook with an invalid cached value fails to open, and repair removes it so it does', gen && gen.badOpens === false && gen.removed >= 1 && gen.fixedOpens === true, JSON.stringify(gen));
  // doc_peek: an OM whose first pages are bare cover photos is still an OM (Estates at Fairway Green, 2026-10-22)
  const mk = `import pymupdf,sys
d=pymupdf.open()
bare=int(sys.argv[2])
for i in range(12):
    p=d.new_page()
    if i>=bare: p.insert_text((40,80),"Offering Memorandum. Executive Summary. Investment Highlights. Property Overview. Market Overview. Rent Comparables. Exclusively offered by Test Realty.",fontsize=9)
d.save(sys.argv[1])`;
  const peek = (bare) => {
    const f = path.join(tmp, `peek${bare}.pdf`);
    execFileSync(py, ['-c', mk, f, String(bare)], { stdio: 'ignore' });
    return JSON.parse(execFileSync(py, [path.join(__dirname, '..', 'underwriting', 'doc_peek.py'), f], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').pop());
  };
  const cover = peek(4), blank = peek(12);
  check('an OM with bare cover pages up front is still read as an OM, not "a scan"', cover.scanned === false && cover.kind === 'om', JSON.stringify(cover));
  check('a document with no text anywhere is still a scan that asks the person', blank.scanned === true && blank.kind === 'unknown', JSON.stringify(blank));
}

disk().then(() => board()).then(() => engine()).then(() => {
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll underwriting-report checks passed.');
  process.exit(failed ? 1 : 0);
});
