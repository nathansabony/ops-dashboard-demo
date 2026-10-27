// The one-to-three page PDF report that sits beside every underwriting model
// (The owner, 2026-10-22: "You don't have to open the full Excel to see all the numbers
// - you could just click PDF report ... for every new underwriting deal, and also
// for the older ones").
//
// The report is built from the finished model itself (underwriting/deal_facts.py
// reads the values finish_model.py baked into the workbook), not from the deal JSON
// the page sent, because the older models never had a deal JSON on record. So a new
// deal and a deal from July come out of one path, and the numbers on the page are
// the numbers in the Excel file. What the page DID know at generation time - which
// files it was built from, how each was read, what a person had to adjust - rides in
// from the deals sidecar (services/underwritingDeals.js) and is printed as sources
// and as the "what we could not read" section.
//
// This file is pure: facts in, sections + HTML out, so scripts/checkUnderwritingReport.js
// can prove it with no Python, no Excel and no PDF library. createReports() is the
// disk side: where the PDF lives (next to the model, in data/underwriting - the Render
// persistent disk), when it is stale, and the backfill.
//
// Labelling rule (the owner's, kept everywhere): a number WE derived says so. The
// in-place cap rate, the gap to max price, annualised loss-to-lease and each expense's
// share of EGI are marked "house estimate"; everything else is the model's own.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { reviewReasons, reviewFix, scoreDeal } = require('./underwritingDeals');

// Bump when the layout or the facts change, so existing PDFs are rebuilt.
// 4: wider page so every report fits three pages; 3: an unsolved IRR from the earlier template ("NM") prints n/a;
// 2: unit mix read in full, plain-language parse notes, clearer market-vs-in-place gap
const REPORT_VERSION = 10;

// ── formatting: nothing may print "undefined" or "NaN" ──────────────────────
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const NA = '—';
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = v => !isNum(v) ? NA : (v < 0 ? '−' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
const moneyK = v => !isNum(v) ? NA : Math.abs(v) >= 1e6 ? (v < 0 ? '−' : '') + '$' + (Math.abs(v) / 1e6).toFixed(2) + 'M'
  : Math.abs(v) >= 1e3 ? (v < 0 ? '−' : '') + '$' + Math.round(Math.abs(v) / 1e3) + 'K' : money(v);
const pct = (v, dp = 1) => !isNum(v) ? NA : (v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(dp) + '%';
const int = v => !isNum(v) ? NA : Math.round(v).toLocaleString('en-US');
const x2 = v => !isNum(v) ? NA : v.toFixed(2) + 'x';
const text = v => (v == null || String(v).trim() === '' || /^\[[A-Z _]+\]$/.test(String(v).trim())) ? NA : String(v).trim();
const shortDate = iso => { try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch { return NA; } };
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const firstSentence = (s, n = 150) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); const m = t.match(/^(.+?[.!?])(\s|$)/); return clip(m ? m[1] : t, n); };

// ── sources: every figure says which file it came from ──────────────────────
const KIND_NAME = { rent_roll: 'Rent roll', t12: 'T12', om: 'OM', model: 'Imported model' };
function sourceIndex(provenance) {
  const by = { rent_roll: [], t12: [], om: [], model: [] };
  const list = (provenance && Array.isArray(provenance.sources)) ? provenance.sources : [];
  for (const s of list) if (s && by[s.kind] && s.filename) by[s.kind].push(String(s.filename));
  return { by, known: list.length > 0, list };
}
// "T12 <file> → model tab 'T12 Actuals'" - or, when the run predates the record, say the file is not recorded.
function srcText(idx, kind, tab) {
  const files = idx.by[kind] || [];
  const doc = KIND_NAME[kind] || kind;
  if (files.length) return `${doc}: ${files.map(f => clip(f, 30)).join(', ')} · ${tab} tab`;
  return `${doc} · ${tab} tab`;                // the report says once, under the facts, that this deal's file names were not kept
}

// ── what an assumption's note says about where it came from ─────────────────
const PLACEHOLDER_RE = /placeholder|needs? (a )?(quote|confirmation)|source needed|prior model|confirm with|not confirmed/i;
function assumptionSource(note) {
  const n = String(note || '');
  if (PLACEHOLDER_RE.test(n)) return { label: 'Placeholder, not confirmed', flag: true };
  if (/^OM\b|OM and rent roll|OM value-add|OM \/ /i.test(n)) return { label: 'OM / public record', flag: false };
  if (/house|benchmark/i.test(n)) return { label: 'House benchmark', flag: false };
  if (/modeling (assumption|toggle)|scenario/i.test(n)) return { label: 'Model assumption', flag: false };
  if (/calculated|derived|from rent roll/i.test(n)) return { label: 'Calculated by the model', flag: false };
  return { label: 'Model input', flag: false };
}

// The assumptions the report prints, by the label the model gives them.
const ASSUMPTIONS = [
  ['Purchase Cap Rate', 'pct2'], ['LTV', 'pct0'], ['Loan Interest Rate', 'pct2'], ['Hold Period', 'yrs'], ['Exit Cap Rate', 'pct2'],
  ['Closing Cost', 'pct1'], ['Disposition / Closing Cost at Exit', 'pct1'], ['Income Growth', 'pct1'], ['Expense Growth', 'pct1'], ['Tax Growth', 'pct1'],
  ['Bad Debt %', 'pct1'], ['Management Fee % of EGI', 'pct1'], ['Asset Management Fee % of EGI', 'pct1'],
  ['Value-Add Units', 'int'], ['Value-Add Premium / Unit / Month', 'money'], ['Interior Renovation Cost / Unit', 'money'], ['Common / Exterior Capex', 'money'],
  ['Amortization Period', 'yrs0'], ['IRR Target', 'pct0'], ['Year 2 Cash-on-Cash Target', 'pct1'],
];
function fmtAssumption(kind, v) {
  if (!isNum(v)) return text(v);
  switch (kind) {
    case 'pct0': return pct(v, 0); case 'pct1': return pct(v, 1); case 'pct2': return pct(v, 2);
    case 'yrs': return v + ' yrs'; case 'yrs0': return v === 0 ? 'interest-only' : v + ' yrs';
    case 'money': return money(v); default: return int(v);
  }
}

// A parse note is the extraction model's own sentence, and it quotes field names ("turnover_costs is null").
// A reader should not see a column name or the word null: say it in plain words.
function plainNote(n) {
  return String(n == null ? '' : n)
    .replace(/\b([a-z]+(?:_[a-z]+)+)\b/g, (m, w) => w.replace(/_/g, ' '))
    .replace(/\b(is|are|was|set to|left as|returned as) null\b/gi, (m, v) => ({ 'set to': 'left', 'left as': 'left', 'returned as': 'left' }[v.toLowerCase()] || v) + ' blank')
    .replace(/\bnull\b/gi, 'blank')
    .replace(/\s+/g, ' ').trim();
}

// ── the report, as data ─────────────────────────────────────────────────────
function buildReport(facts, ctx = {}) {
  facts = facts || {};
  const card = facts.card || {};
  const prop = facts.property || {};
  const idx = sourceIndex(ctx.provenance);
  const tgt = isNum(card.irr_target) ? card.irr_target : 0.16;
  const tgtTxt = pct(tgt, 0);
  const price = isNum(card.price) ? card.price : null;
  const units = isNum(card.units) ? card.units : (isNum(prop.units) ? prop.units : null);
  const rr = (facts.rent_roll && facts.rent_roll.metrics) || {};
  const rrk = (facts.rent_roll && facts.rent_roll.kpis) || {};
  const mix = Array.isArray(facts.unit_mix) ? facts.unit_mix : [];
  const gaps = Array.isArray(facts.gaps) ? facts.gaps.slice() : [];

  const irrFailed = card.irr_failed === true || (card.irr === 0 && isNum(card.equity_multiple) && Math.abs(card.equity_multiple - 1) > 1e-9);
  const irr = irrFailed ? null : (isNum(card.irr) ? card.irr : null);
  const meets = irrFailed ? false : (irr == null ? null : irr >= tgt);
  const maxPrice = isNum(card.max_price) && card.max_price > 0 ? card.max_price : null;
  const gap = maxPrice != null && price ? maxPrice - price : null;                    // house estimate
  const cap = price && isNum(card.t12_noi) ? card.t12_noi / price : null;             // house estimate

  const name = text(card.name) !== NA ? text(card.name) : (text(prop.name) !== NA ? text(prop.name) : '(unnamed deal)');
  const T = (kind, tab) => srcText(idx, kind, tab);
  const OPT = 'house estimate';

  // headline numbers: the owner's price-test six, then the second row
  // Plausibility gate (services/underwritingDeals.js): a deal built on inputs that cannot support a decision says so on page 1
  // and shows its price and returns as not reliable instead of as numbers.
  const reasons = reviewReasons(Object.assign({}, card, { units, irr_failed: irrFailed, price, price_per_door: card.price_per_door }));
  const review = { needs: reasons.length > 0, reasons, fix: reasons.length ? reviewFix(Object.assign({}, card, { units, price, price_per_door: card.price_per_door })) : [] };
  const nr = 'n/r';
  const tiles = [
    { label: 'PRICE RUN', value: moneyK(price), sub: isNum(card.price_per_door) ? money(card.price_per_door) + ' per unit' : NA, src: 'model: Debt & Exit tab · price = T12 NOI ÷ purchase cap, unless overridden' },
    { label: 'UNITS', value: int(units), sub: isNum(card.occupancy) ? pct(card.occupancy, 1) + ' occupied' : NA, src: T('rent_roll', 'Rent Roll') },
    { label: 'T12 NOI', value: moneyK(card.t12_noi), sub: isNum(card.year1_noi) ? 'Year-1 NOI ' + moneyK(card.year1_noi) : NA, src: T('t12', 'T12 Actuals') },
    { label: 'IN-PLACE CAP RATE', value: pct(cap, 2), sub: OPT + ': T12 NOI ÷ price run', src: 'derived here, not quoted' },
    { label: 'LEVERED IRR', value: irrFailed ? 'n/a' : pct(irr, 1), sub: irrFailed ? 'equity not recovered' : (meets == null ? NA : (meets ? 'meets ' : 'below ') + tgtTxt + ' target'), src: `model: Debt & Exit, ${isNum(card.hold_years) ? card.hold_years + '-year hold' : 'hold period'}`, tone: meets === true ? 'good' : meets === false ? 'bad' : '' },
    { label: `MAX PRICE @ ${tgtTxt} IRR`, value: maxPrice != null ? moneyK(maxPrice) : 'no solve', sub: gap != null ? `${gap >= 0 ? '+' : '−'}${moneyK(Math.abs(gap))} (${gap >= 0 ? '+' : '−'}${Math.abs(Math.round(gap / price * 100))}%) vs price run — ${OPT}` : 'the solver returned no price', src: 'model: Max Price Solver', tone: gap == null ? '' : gap >= 0 ? 'good' : 'bad' },
  ];
  if (review.needs) {
    for (const t of tiles) {
      if (/^(PRICE RUN|IN-PLACE CAP RATE|LEVERED IRR|MAX PRICE)/.test(t.label)) { t.value = nr; t.sub = 'not reliable: see the review box'; t.tone = 'bad'; }
    }
  }
  const tiles2 = [
    ['Year-2 cash-on-cash', review.needs ? nr : pct(card.coc, 1), 'model: Pro Forma'], ['Equity multiple', review.needs ? nr : x2(card.equity_multiple), 'model: Debt & Exit'],
    ['Year-1 DSCR', review.needs ? nr : x2(card.dscr), 'model: Pro Forma'], ['Total capex', moneyK(card.capex), 'model: Inputs'],
    ['Avg in-place rent / mo', isNum(card.avg_rent) ? money(card.avg_rent) : NA, T('rent_roll', 'Rent Roll')], ['Hold period', isNum(card.hold_years) ? card.hold_years + ' years' : NA, 'model: Inputs'],
  ];

  // plain-language verdict - the model's result, in a sentence
  let verdict;
  if (review.needs) verdict = 'This deal is flagged NEEDS REVIEW (see the box at the top). The price, the cap rate and the returns come from inputs that cannot support a decision, so they are shown as not reliable; the tables below are the model\'s own output, printed for reference.';
  else if (price == null) verdict = 'The model did not save a calculated price for this deal, so no verdict can be stated here. Open the Excel model to compute it.';
  else {
    const hold = isNum(card.hold_years) ? `${card.hold_years}-year` : 'hold-period';
    verdict = irrFailed
      ? `At the price run (${moneyK(price)}) the model could not solve a levered IRR over the ${hold} hold: the equity is not recovered (equity multiple ${x2(card.equity_multiple)}).`
      : `At the price run (${moneyK(price)}) the model's levered IRR over the ${hold} hold is ${pct(irr, 1)}, ${meets == null ? 'with no target to compare' : meets ? 'meeting' : 'below'} the ${tgtTxt} target.`;
    verdict += maxPrice != null
      ? ` The model's solver puts the most that could be paid and still reach ${tgtTxt} at ${moneyK(maxPrice)}, ${gap >= 0 ? 'above' : 'below'} the price run by ${moneyK(Math.abs(gap))} (${Math.abs(Math.round(gap / price * 100))}%; the gap is an ${OPT}).`
      : ` The model's max-price solver returned no price${meets ? '; the price run already meets the target, so the room above it was not solved' : ''}.`;
  }

  // property & deal facts
  const mixBlend = mix.length ? mix.reduce((a, m) => ({ sf: a.sf + (m.avg_sf || 0) * (m.units || 0), mk: a.mk + (m.avg_market || 0) * (m.units || 0), n: a.n + (m.units || 0) }), { sf: 0, mk: 0, n: 0 }) : null;
  const factsRows = [
    ['Address', text(prop.address), idx.by.om.length ? T('om', 'Inputs') : 'model Inputs tab (OM / county record per its notes)'],
    ['Year built', text(prop.year_built), idx.by.om.length ? T('om', 'Inputs') : 'model Inputs tab'],
    ['Units', int(units), T('rent_roll', 'Rent Roll')],
    ...(isNum(card.non_revenue_units) && card.non_revenue_units > 0 && isNum(units) && units > card.non_revenue_units ? [
      ['Revenue units (not down, model or employee)', `${int(units - card.non_revenue_units)} of ${int(units)}`, `rent roll: ${int(card.non_revenue_units)} units are not for rent`],
      ['Occupancy of revenue units', pct(Math.round(card.occupancy * units) / (units - card.non_revenue_units), 1), `${OPT}: occupied ÷ revenue units (the ${pct(card.occupancy, 1)} above counts every unit)`],
    ] : []),
    ['Site acres', isNum(prop.site_acres) && prop.site_acres > 0 ? prop.site_acres + ' ac' : NA, idx.by.om.length ? T('om', 'Inputs') : 'model Inputs tab'],
    ['Average unit size', mixBlend && mixBlend.n && mixBlend.sf > 0 ? int(mixBlend.sf / mixBlend.n) + ' sf' : NA, T('rent_roll', 'Unit Mix')],
    ['Average market rent / mo', mixBlend && mixBlend.n ? money(mixBlend.mk / mixBlend.n) : NA, T('rent_roll', 'Unit Mix')],
  ];

  // returns
  const ret = facts.returns || {};
  const stack = [
    ['Purchase price', ret['Purchase Price']], ['Loan amount', ret['Loan Amount']], ['Equity before capex', ret['Equity Before Capex']],
    ['Capex', ret['Total Capex']], ['Acquisition closing cost', ret['Upfront Acquisition Closing Cost']], ['Initial equity required', ret['Initial Equity Required']],
    ['Gross exit value', ret['Gross Exit Value']], ['Net sale proceeds', ret['Net Sale Proceeds']],
  ].map(([l, v]) => ({ label: l, value: money(v) }));
  const scenarios = (Array.isArray(facts.scenarios) ? facts.scenarios : []).filter(s => !/cash-on-cash|^notes?$/i.test(String(s.scenario).trim()) && (isNum(s.irr) || isNum(s.sale_value))).map(s => ({
    scenario: text(s.scenario), hold: isNum(s.hold) ? s.hold + ' yrs' : NA, sale: moneyK(s.sale_value), irr: pct(s.irr, 1), em: x2(s.equity_multiple),
    verdict: isNum(s.irr) ? (s.irr >= tgt ? 'meets' : 'below') : NA,
  }));

  // rent roll
  const lossMo = isNum(rrk.loss_to_lease_mo) ? rrk.loss_to_lease_mo : (isNum(rr['Monthly Loss-to-Lease']) ? rr['Monthly Loss-to-Lease'] : null);
  const rentRows = [
    ['Report as of', text(String(rr['Report As Of'] || '').slice(0, 10)), T('rent_roll', 'Rent Roll')],
    ['Units (official / parsed)', `${int(rr['Official Units'])} / ${int(rr['Parsed Unit Count'])}`, T('rent_roll', 'Rent Roll')],
    ['Occupied (official)', `${int(rr['Official Occupied Units'])} of ${int(rr['Official Units'])} — ${pct(rr['Official Occupancy'], 1)}`, T('rent_roll', 'Rent Roll')],
    ['Monthly market rent', money(rr['Monthly Market Rent']), T('rent_roll', 'Rent Roll')],
    ['Monthly in-place rent', money(rr['Monthly In-place Rent Charges']), T('rent_roll', 'Rent Roll')],
    ['Monthly loss-to-lease (model\'s term)', money(lossMo), 'market minus in-place, vacant units counted at market; ' + T('rent_roll', 'Rent Roll')],
    ['Annual market-vs-in-place gap', isNum(lossMo) ? money(lossMo * 12) : NA, `${OPT}: monthly × 12; upside only if vacant units lease`],
    ['Resident balances owed', money(rr['Total Resident Balance']), T('rent_roll', 'Rent Roll')],
  ];
  const mixCap = review.needs ? 6 : 10;      // the review box takes room on page 1; a flagged deal still has to fit three pages
  const mixRows = mix.slice(0, mixCap).map(m => ({
    type: text(m.type), units: int(m.units), occ: int(m.occupied), sf: isNum(m.avg_sf) && m.avg_sf > 0 ? int(m.avg_sf) : NA,
    market: isNum(m.avg_market) ? money(m.avg_market) : NA, inplace: isNum(m.avg_inplace) ? money(m.avg_inplace) : NA,
    ltl: isNum(m.avg_market) && isNum(m.avg_inplace) ? money(m.avg_market - m.avg_inplace) : NA,
  }));
  const mixMore = mix.length > mixCap ? mix.length - mixCap : 0;

  // T12
  const t12 = facts.t12 || {};
  const months = Array.isArray(t12.months) ? t12.months : [];
  const egi = isNum(t12.kpis && t12.kpis.egi) ? t12.kpis.egi : null;
  const zeroLines = [];
  const t12Rows = (Array.isArray(t12.lines) ? t12.lines : []).filter(l => isNum(l.amount)).filter(l => {
    if (l.amount === 0 && !/^(effective gross income|total operating expenses|net operating income)/i.test(String(l.label || ''))) { zeroLines.push(l.label); return false; }
    return true;
  }).map(l => {
    const lab = String(l.label || '');
    const isIncomeTotal = /^effective gross income/i.test(lab), isOpex = /^total operating expenses/i.test(lab), isNoi = /^net operating income/i.test(lab);
    const memo = /^actual (vacancy|bad debt|concessions)/i.test(lab);
    return { label: lab, amount: money(l.amount), share: (egi && !memo && !/rental income|gross potential|less:|other income|effective/i.test(lab) && l.amount !== 0) ? pct(l.amount / egi, 1) : '', total: isIncomeTotal || isOpex || isNoi, memo };
  });
  const t12Span = months.length ? `${months[0]} – ${months[months.length - 1]} (${months.length} month${months.length === 1 ? '' : 's'})` : 'period not recorded in the model';

  // pro forma
  const pf = facts.pro_forma || {};
  const pfYears = (Array.isArray(pf.years) ? pf.years : []).filter(y => [1, 2, 3, 5, 8].includes(y));
  const yv = (m, y) => (m && (m[y] != null ? m[y] : m[String(y)]));
  const pfRows = pfYears.length ? [
    ['Effective gross income', pf.egi], ['Total operating expenses', pf.opex], ['Net operating income', pf.noi], ['Debt service', pf.debt_service], ['Net income after debt service', pf.after_debt],
  ].map(([l, m]) => ({ label: l, cells: pfYears.map(y => money(yv(m, y))) })).concat([{ label: 'Cash-on-cash', cells: pfYears.map(y => pct(yv(pf.coc, y), 1)) }]) : [];
  const noiUpside = isNum(card.year1_noi) && isNum(card.t12_noi) ? card.year1_noi - card.t12_noi : null;     // house estimate

  // assumptions
  const inputs = Array.isArray(facts.inputs) ? facts.inputs : [];
  const byLabel = lab => inputs.find(i => String(i.label || '').toLowerCase().startsWith(lab.toLowerCase()));
  const assumptions = [];
  for (const [lab, kind] of ASSUMPTIONS) {
    const i = byLabel(lab);
    if (!i || i.value == null) continue;
    const s = assumptionSource(i.note);
    assumptions.push({ label: String(i.label).replace(/\s*\(.*$/, ''), value: fmtAssumption(kind, i.value), source: s.label, flag: s.flag });
  }
  const placeholders = assumptions.filter(a => a.flag).map(a => a.label);

  // what we could not read, and how sure we are
  const parse = [];
  if (idx.known) {
    for (const s of idx.list) {
      parse.push({ kind: KIND_NAME[s.kind] || s.kind, file: text(s.filename), method: text(s.method), notes: (Array.isArray(s.notes) ? s.notes : []).slice(0, 2).map(n => clip(plainNote(n), 200)), warnings: isNum(s.warnings) ? s.warnings : (Array.isArray(s.notes) ? s.notes.length : 0) });
    }
  }
  const checks = facts.checks || { items: [] };
  const notOk = (Array.isArray(checks.items) ? checks.items : []).filter(c => String(c.result || '').toUpperCase() !== 'OK').map(c => ({ result: String(c.result).toUpperCase(), check: text(c.check), note: firstSentence(c.note) }));
  const missing = [];
  if (text(prop.address) === NA) missing.push('Address was not in the files (the model shows a blank).');
  if (text(prop.year_built) === NA) missing.push('Year built was not in the files.');
  if (mix.length === 1 && !mix[0].type) missing.push('The rent roll carried no unit types, so the unit mix is one blended line.');
  const tax = facts.tax || {};
  if (isNum(tax.millage) && tax.millage === 0) missing.push('No county millage rate was found, so the tax forecast falls back to the T12 property tax.');
  if (maxPrice == null) missing.push('The model\'s max-price solver returned no price, so "max price" is blank rather than estimated.');
  if (irrFailed) missing.push('The model could not solve an IRR (equity never recovered), so this report shows n/a.');
  for (const g of gaps) missing.push(g);
  const confirmed = Array.isArray(ctx.provenance && ctx.provenance.confirmed_fields) ? ctx.provenance.confirmed_fields : [];

  // (score: the board's card carries gap_pct, the gap to the max price; the model's own card does not, and the price line scored 0 here)
  return {
    version: REPORT_VERSION,
    header: { name, address: text(prop.address) !== NA ? text(prop.address) : text(card.address), runDate: ctx.runDate ? shortDate(ctx.runDate) : NA, generated: ctx.generated ? shortDate(ctx.generated) : NA, file: text(ctx.file) },
    review, score: review.needs ? null : scoreDeal(Object.assign({}, card, { needs_review: false, gap_pct: gap != null && price ? gap / price : null })), noRecord: !idx.known, tiles, tiles2, verdict, tgtTxt,
    facts: factsRows, stack, scenarios,
    rent: { rows: rentRows, mix: mixRows, mixMore },
    t12: { span: t12Span, rows: t12Rows, zeroLines, noi: money(t12.kpis && t12.kpis.noi), margin: pct(t12.kpis && t12.kpis.margin, 1), src: T('t12', 'T12 Actuals') },
    proForma: { years: pfYears, rows: pfRows, noiUpside: noiUpside == null ? NA : money(noiUpside), src: 'model: Pro Forma' },
    assumptions, placeholders,
    confidence: { recorded: idx.known, parse, adjusted: parse.flatMap(p => p.notes.filter(n => /adjusted month|annualized/i.test(n))), confirmed, notOk, missing, estimates: [`In-place cap rate (${pct(cap, 2)})`, `Gap to max price (${gap == null ? NA : moneyK(gap)})`, `Annual market-vs-in-place gap (${isNum(lossMo) ? money(lossMo * 12) : NA})`, 'Each expense line\'s share of EGI', `Year-1 NOI change vs T12 (${noiUpside == null ? NA : money(noiUpside)})`] },
    sourcesList: idx.known ? idx.list.map(s => `${KIND_NAME[s.kind] || s.kind}: ${text(s.filename)}`) : [],
  };
}

// ── HTML (tables only: the PDF engine has no flex/grid) ─────────────────────
function renderHtml(r) {
  const h = [];
  const row2 = (a, b, c) => `<tr><td>${esc(a)}</td><td class="r"><b>${esc(b)}</b></td><td class="src">${esc(c)}</td></tr>`;
  h.push(`<table><tr><td class="band"><h1>${esc(r.header.name)}</h1><p>${esc(r.header.address)}</p><p>Underwriting summary · model run ${esc(r.header.runDate)} · report generated ${esc(r.header.generated)}</p></td></tr></table>`);
  if (r.review && r.review.needs) h.push(`<table cellspacing="4"><tr><td class="review"><p><b>NEEDS REVIEW: do not rely on this deal's price or returns.</b></p>${r.review.reasons.map(x => `<p>• ${esc(x)}</p>`).join('')}${(r.review.fix || []).map(x => `<p><b>What would fix it:</b> ${esc(x)}</p>`).join('')}</td></tr></table>`);
  const tile = t => `<td class="tile" width="33%"><p class="lbl">${esc(t.label)}</p><p class="big ${t.tone || ''}">${esc(t.value)}</p><p>${esc(t.sub)}</p><p class="src">${esc(t.src)}</p></td>`;
  h.push(`<table cellspacing="6"><tr>${r.tiles.slice(0, 3).map(tile).join('')}</tr><tr>${r.tiles.slice(3).map(tile).join('')}</tr></table>`);
  h.push(`<table><tr>${r.tiles2.map(t => `<td><p class="lbl">${esc(t[0].toUpperCase())}</p><p><b>${esc(t[1])}</b></p><p class="src">${esc(t[2])}</p></td>`).join('')}</tr></table>`);
  h.push(`<p style="margin-top:8pt"><b>${esc(r.verdict)}</b></p>`);

  h.push('<h2>Property and deal facts</h2>');
  if (r.noRecord) h.push('<p class="src">Original file names were not kept for this deal (run before the 2026-10-21 tracking); each figure is cited to the model tab it was read from.</p>');
  h.push(`<table><tr><th>Item</th><th class="r">Value</th><th>Source</th></tr>${r.facts.map(f => row2(f[0], f[1], f[2])).join('')}</table>`);

  h.push('<h2>Returns and capital</h2>');
  h.push(`<table><tr><th>Scenario (model's own)</th><th class="r">Hold</th><th class="r">Sale value</th><th class="r">Levered IRR</th><th class="r">Equity multiple</th><th class="r">vs ${esc(r.tgtTxt)}</th></tr>${r.scenarios.length ? r.scenarios.map(s => `<tr><td>${esc(s.scenario)}</td><td class="r">${esc(s.hold)}</td><td class="r">${esc(s.sale)}</td><td class="r"><b>${esc(s.irr)}</b></td><td class="r">${esc(s.em)}</td><td class="r ${s.verdict === 'meets' ? 'good' : s.verdict === 'below' ? 'bad' : ''}">${esc(s.verdict)}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">Scenario table not readable from this model.</td></tr>'}</table>`);
  const half = Math.ceil(r.stack.length / 2);
  h.push(`<table style="margin-top:6pt"><tr><th>Capital stack (model: Debt &amp; Exit tab)</th><th class="r">Amount</th><th>&nbsp;</th><th class="r">Amount</th></tr>${r.stack.slice(0, half).map((s, i) => { const t = r.stack[half + i]; return `<tr><td>${esc(s.label)}</td><td class="r">${esc(s.value)}</td><td>${t ? esc(t.label) : ''}</td><td class="r">${t ? esc(t.value) : ''}</td></tr>`; }).join('')}</table>`);

  if (r.score && r.score.score != null) {
    h.push(`<h2>Deal score: ${r.score.score} / 100 (${esc(r.score.grade)})</h2>`);
    h.push(`<table><tr><th>Factor</th><th class="r">Points</th><th>What drove it</th></tr>${r.score.parts.map(p => `<tr><td>${esc(p.label)}</td><td class="r">${p.points} / ${p.weight}</td><td class="muted">${esc(p.why)}</td></tr>`).join('')}</table>`);
    h.push('<p class="src">house estimate: the score weighs the model\'s own results against our targets; the factors and thresholds are set on the Underwriting tab.</p>');
  }
  h.push('<h2>Rent roll summary</h2>');
  h.push(`<table><tr><th>Item</th><th class="r">Value</th><th>Source</th></tr>${r.rent.rows.map(f => row2(f[0], f[1], f[2])).join('')}</table>`);
  if (r.rent.mix.length) {
    h.push(`<h3>Unit mix — average rent vs market</h3><table><tr><th>Type</th><th class="r">Units</th><th class="r">Occupied</th><th class="r">Avg sf</th><th class="r">Avg market</th><th class="r">Avg in-place</th><th class="r">Loss-to-lease*</th></tr>${r.rent.mix.map(m => `<tr><td>${esc(m.type)}</td><td class="r">${esc(m.units)}</td><td class="r">${esc(m.occ)}</td><td class="r">${esc(m.sf)}</td><td class="r">${esc(m.market)}</td><td class="r">${esc(m.inplace)}</td><td class="r">${esc(m.ltl)}</td></tr>`).join('')}</table>`);
    h.push(`<p class="src">* house estimate: average market rent minus average in-place rent, per unit per month.${r.rent.mixMore ? ` ${r.rent.mixMore} more unit type(s) are in the Excel model.` : ''}</p>`);
  }

  h.push('<h2>T12 summary</h2>');
  h.push(`<p>Months covered: <b>${esc(r.t12.span)}</b> · ${esc(r.t12.src)}</p>`);
  h.push(`<table><tr><th>Line</th><th class="r">12-month amount</th><th class="r">% of EGI*</th></tr>${r.t12.rows.map(l => `<tr class="${l.total ? 'tot' : ''}"><td class="${l.memo ? 'muted' : ''}">${esc(l.label)}${l.memo ? ' (memo)' : ''}</td><td class="r">${esc(l.amount)}</td><td class="r muted">${esc(l.share)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">T12 summary not readable from this model.</td></tr>'}</table>`);
  h.push(`<p class="src">* house estimate: the line divided by effective gross income. NOI margin ${esc(r.t12.margin)}.${r.t12.zeroLines.length ? ` Lines at $0 are not shown (${esc(r.t12.zeroLines.join(', '))}).` : ''}</p>`);

  if (r.proForma.rows.length) {
    h.push('<h2>Pro forma (model)</h2>');
    h.push(`<table><tr><th></th>${r.proForma.years.map(y => `<th class="r">Year ${y}</th>`).join('')}</tr>${r.proForma.rows.map(p => `<tr><td>${esc(p.label)}</td>${p.cells.map(c => `<td class="r">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`);
    h.push(`<p class="src">${esc(r.proForma.src)}. Year-1 NOI vs the T12 NOI: ${esc(r.proForma.noiUpside)} (house estimate: the model's Year-1 figure minus the trailing actual).</p>`);
  }

  h.push('<h2>Assumptions the model used</h2>');
  h.push(`<table><tr><th>Assumption</th><th class="r">Value</th><th>Where it came from</th></tr>${r.assumptions.map(a => `<tr><td>${esc(a.label)}</td><td class="r"><b>${esc(a.value)}</b></td><td class="${a.flag ? 'amber' : 'src'}">${esc(a.source)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Inputs not readable from this model.</td></tr>'}</table>`);

  const c = r.confidence;
  h.push('<h2>What we could not read, and how sure we are</h2>');
  if (c.recorded) {
    h.push('<h3>How each file was read</h3>');
    h.push(`<table><tr><th>Document</th><th>File</th><th>Read by</th><th class="r">Parse notes</th></tr>${c.parse.map(p => `<tr><td>${esc(p.kind)}</td><td>${esc(clip(p.file, 44))}</td><td>${esc(p.method)}</td><td class="r">${esc(p.warnings)}</td></tr>`).join('')}</table>`);
    for (const p of c.parse) for (const n of p.notes) h.push(`<p class="src">${esc(p.kind)}: ${esc(n)}</p>`);
  } else {
    h.push('<p class="note">No record of how this deal\'s files were read: it was run before the board began saving that (2026-10-21). Every figure above is exactly what the Excel model holds; the confidence of the original parse is unknown.</p>');
  }
  if (c.adjusted && c.adjusted.length) h.push(`<h3>Adjusted by us (house estimate)</h3>${c.adjusted.map(a => `<p>• ${esc(a)}</p>`).join('')}`);
  h.push(`<h3>Values a person had to judge</h3><p>${c.confirmed.length ? esc(c.confirmed.join(' · ')) : (c.recorded ? 'None: nothing was edited or low-confidence at review.' : 'Not recorded for this deal.')}</p>`);
  if (c.notOk.length) h.push(`<h3>Model checks that are not OK</h3><table>${c.notOk.map(n => `<tr><td width="14%" class="amber"><b>${esc(n.result)}</b></td><td width="30%">${esc(n.check)}</td><td class="src">${esc(n.note)}</td></tr>`).join('')}</table>`);
  if (r.placeholders.length) h.push(`<h3>Assumptions still placeholders</h3><p>${esc(r.placeholders.join(' · '))} — set from house defaults or a prior model, not from a quote or document.</p>`);
  if (c.missing.length) h.push(`<h3>Not available, and not guessed</h3>${c.missing.map(m => `<p>• ${esc(m)}</p>`).join('')}`);
  h.push(`<h3>Figures derived here (house estimates)</h3><p class="src">${esc(c.estimates.join(' · '))}</p>`);
  return `<html><body>${h.join('\n')}</body></html>`;
}

function footerText(r) {
  return `Portfolio Management Dashboard (demo) · Underwriting summary · ${clip(r.header.name, 60)} · prepared ${new Date().toISOString().slice(0, 10)}`;
}

// ── the disk side ───────────────────────────────────────────────────────────
// A report lives next to its model: Foo-2026-09-25-21-23-03.xlsx -> Foo-2026-09-25-21-23-03.pdf in the
// same folder - on Render, the persistent disk (render.yaml mounts data/), so it survives a deploy
// exactly as the model does.
const pdfNameFor = file => String(file).replace(/\.xlsx$/i, '.pdf');

function createReports({ dir, runPython, provenanceOf, markReport, reportMeta }) {
  const pdfPath = file => path.join(dir, pdfNameFor(file));
  const modelPath = file => path.join(dir, file);

  function isFresh(file) {
    const p = pdfPath(file);
    if (!fs.existsSync(p) || fs.statSync(p).size < 500) return false;
    if (fs.statSync(p).mtimeMs < fs.statSync(modelPath(file)).mtimeMs - 5000) return false;     // the model was rewritten (5 s of slack: a git checkout or a copy writes the pair in either order)
    const meta = reportMeta ? reportMeta(file) : null;
    return !meta || meta.v === REPORT_VERSION;
  }

  // One report at a time, whoever asks. Each build starts a Python process that loads a whole workbook, and the
  // Render instance has 512 MB: five models imported at once (each starting its own build) while the boot-time
  // backfill ran and uploads were being read took the live site down for a restart (2026-10-22, 19:49 UTC).
  let queue = Promise.resolve();
  const serial = fn => { const run = queue.then(fn, fn); queue = run.then(() => {}, () => {}); return run; };

  const inflight = new Map();
  async function build(file) {
    const model = modelPath(file);
    if (!fs.existsSync(model)) throw new Error('No such model');
    const facts = await runPython('deal_facts.py', [model], 180000);
    if (facts.error) throw new Error(facts.error);
    const st = fs.statSync(model);
    const report = buildReport(facts, { file, provenance: provenanceOf ? provenanceOf(file) : null, runDate: runDateOf(file, st.mtimeMs), generated: new Date().toISOString() });
    const tmpHtml = path.join(os.tmpdir(), `uwr-${crypto.randomBytes(6).toString('hex')}.html`);
    fs.writeFileSync(tmpHtml, renderHtml(report));
    try {
      const out = pdfPath(file) + '.building';
      const res = await runPython('html_to_pdf.py', [tmpHtml, out, footerText(report), `${report.header.name} - underwriting summary`], 120000);
      if (res.error) throw new Error(res.error);
      fs.renameSync(out, pdfPath(file));
      if (markReport) markReport(file, { v: REPORT_VERSION, at: new Date().toISOString(), pages: res.pages });
      return { pages: res.pages, bytes: res.bytes };
    } finally {
      fs.unlink(tmpHtml, () => {});
      // the layout scratch file; never leave one on the persistent disk
      fs.unlink(pdfPath(file) + '.building.story', () => {});
      fs.unlink(pdfPath(file) + '.building', () => {});
    }
  }

  // Returns the PDF's path, building it when it is missing or stale. Concurrent callers for one model share one build.
  async function ensure(file, { force = false } = {}) {
    if (!/^[A-Za-z0-9 ._()-]+\.xlsx$/.test(file)) throw new Error('Bad file name');
    if (!force && isFresh(file)) return { path: pdfPath(file), built: false };
    if (!inflight.has(file)) inflight.set(file, serial(() => build(file)).finally(() => inflight.delete(file)));
    const info = await inflight.get(file);
    return { path: pdfPath(file), built: true, ...info };
  }

  // Every model on the disk gets one. Safe to re-run: a model whose PDF is current is skipped.
  async function backfill({ force = false, log = () => {} } = {}) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$')).sort() : [];
    const out = { total: files.length, generated: [], skipped: [], failed: [] };
    for (const f of files) {
      try {
        const r = await ensure(f, { force });
        (r.built ? out.generated : out.skipped).push(f);
        log(`${r.built ? 'built  ' : 'current'} ${f}${r.pages ? ` (${r.pages} pages)` : ''}`);
      } catch (e) {
        out.failed.push({ file: f, reason: e.message });
        log(`FAILED  ${f}: ${e.message}`);
      }
    }
    return out;
  }

  return { ensure, backfill, pdfPath, isFresh };
}

// same stamp rule the board uses for "run date"
function runDateOf(file, mtimeMs) {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?=(?:\s*\(\d+\))?\.xlsx$)/i.exec(file);
  if (m) { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])); if (!Number.isNaN(d.getTime())) return d.toISOString(); }
  return new Date(mtimeMs).toISOString();
}

module.exports = { REPORT_VERSION, plainNote, buildReport, renderHtml, footerText, createReports, pdfNameFor, money, moneyK, pct, assumptionSource, sourceIndex };
