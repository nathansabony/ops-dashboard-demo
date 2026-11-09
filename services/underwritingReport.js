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
const { reviewReasons, reviewFix, scoreDeal, shapeCard, reviewFor } = require('./underwritingDeals');

// Bump when the layout or the facts change, so existing PDFs are rebuilt.
// 16: their price vs the price we would pay, right under the bottom line
// 15: the bottom line in plain English, our bid, and how to make it work (levers.py), leading page 1
// 14: a deal underwritten by hand prints the review (checked / fixed / open) instead of the cautions
// 13: cautions (Year 1 far from the T12; a price that is not the broker's ask) under the score
// 12: a NEEDS REVIEW deal is scored too, held to an F
// 11: the score is worked out from the shaped card, as on the tab and Home (it read the raw one, which has no gap to the max price)
// 4: wider page so every report fits three pages; 3: an unsolved IRR from the earlier template ("NM") prints n/a;
// 2: unit mix read in full, plain-language parse notes, clearer market-vs-in-place gap
const REPORT_VERSION = 16;

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

// ── the bottom line, in plain English ───────────────────────────────────────
// The owner, 2026-11-01: the report should "explain in plain English why it's a good or bad deal", lead with the
// price WE would pay rather than the broker's, and show "other ways to do things that could raise the score".
// Every sentence is built from the model's own numbers (levers.py rebuilds its cash flows and must tie to its IRR);
// nothing here is written by a language model.

// What each Pro Forma line means when Year 1 differs from the seller's T12. Lines that are one thing to a reader
// share words (rent and vacancy are one story: the rent roll replaces the T12's market rent and its vacancy) and net.
const DRIVER_WORDS = [
  [/^property tax/i, () => 'property tax re-set on the purchase price'],
  [/^insurance/i, (l, u) => `insurance at ${perUnit(l.year1, u)} a unit (the seller pays ${perUnit(l.t12, u)})`],
  [/^(repairs|turnover|controllable)/i, () => 'repairs and make-ready at our standard where the seller spends less'],
  [/^labor|payroll/i, (l, u) => `payroll at ${perUnit(l.year1, u)} a unit (the seller pays ${perUnit(l.t12, u)})`],
  [/^bad debt/i, () => 'bad debt at 2% of rent'],
  [/^replacement reserves/i, () => 'replacement reserves of $250 a unit'],
  [/^miscellaneous/i, () => 'one-time takeover costs of $250 a unit'],
  [/^(base gross potential rent|vacancy|value-add)/i, () => 'rent and occupancy from today’s rent roll'],
  [/concessions/i, () => 'move-in concessions'],
  [/^other income/i, () => 'other income'],
  [/^management fee/i, () => 'the 3% management fee'],
  [/^utilit/i, () => 'utilities'],
  [/^other controllable/i, () => 'other operating costs'],
];
const perUnit = (v, u) => isNum(v) && u ? '$' + Math.round(v / u).toLocaleString('en-US') : NA;
// 'an 8-year', 'an 8.38% cap', 'an 11% …', 'an 18 …': the numbers read aloud with a vowel sound
const an = s => (/^(8|11|18)(?!\d)|^8\d(?!\d)/.test(String(s).replace(/^[−$]/, '')) ? 'an ' : 'a ') + s;
const SKIP_DRIVER = /^(adjusted gross potential rent|net rental income|effective gross income|total operating expenses|net operating income|noi margin)/i;

function noiDrivers(lines, t12Noi, units) {
  const out = new Map();
  for (const l of lines || []) {
    if (!l || SKIP_DRIVER.test(l.label) || !isNum(l.t12) || !isNum(l.year1)) continue;
    // income lines help NOI when they rise, expense lines (positive amounts, below EGI) hurt it
    const income = /rent|vacancy|bad debt|concession|other income|value-add/i.test(l.label) && !/^repairs/i.test(l.label);
    const effect = income ? l.year1 - l.t12 : l.t12 - l.year1;
    const hit = DRIVER_WORDS.find(([re]) => re.test(l.label));
    const words = hit ? hit[1](l, units) : l.label.toLowerCase();
    out.set(words, (out.get(words) || 0) + effect);
  }
  const floor = Math.abs(t12Noi || 0) * 0.01;
  return [...out.entries()].map(([words, effect]) => ({ words, effect })).filter(d => Math.abs(d.effect) >= floor)
    .sort((a, b) => a.effect - b.effect);
}

function bottomLine(facts, card, { price, units, irr, tgt, tgtTxt, meets }) {
  const lv = facts.levers;
  if (!lv || lv.error || !price) return null;
  const bid = lv.bid && isNum(lv.bid.price) ? lv.bid : null;
  const t12 = isNum(card.t12_noi) ? card.t12_noi : null;
  const y1 = isNum(card.year1_noi) ? card.year1_noi : null;
  const per = v => isNum(v) && units ? ` (${moneyK(v / units)} a unit)` : '';
  const hold = isNum(lv.hold) ? lv.hold : card.hold_years;
  const why = [];

  why.push(card.price_from_ask
    ? `The asking price is ${moneyK(price)}${per(price)}${t12 ? `, ${an(pct(t12 / price, 2))} cap rate on the seller's last 12 months of NOI` : ''}.`
    : `No asking price was given, so the model prices it at the seller's T12 NOI ÷ our ${isNum(card.purchase_cap) ? pct(card.purchase_cap, 1) : '5.5%'} cap: ${moneyK(price)}${per(price)}.`);
  why.push(`At that price we would earn ${pct(irr, 1)} a year on our equity over ${an(hold + '-year')} hold, against our ${tgtTxt} target.`);

  if (t12 && y1) {
    const drop = 1 - y1 / t12;
    const drivers = noiDrivers(facts.pro_forma && facts.pro_forma.lines, t12, units);
    const hurt = drivers.filter(d => d.effect < 0).slice(0, 5);
    const help = drivers.filter(d => d.effect > 0).slice(-2).reverse();
    if (Math.abs(drop) >= 0.03) {
      let s = `Our Year-1 NOI is ${moneyK(y1)}, ${pct(Math.abs(drop), 0)} ${drop > 0 ? 'below' : 'above'} the seller's ${moneyK(t12)}`;
      if (drop > 0 && hurt.length) s += `, because we underwrite what a new owner actually pays: ${hurt.map(d => `${d.words} (−${moneyK(-d.effect)})`).join('; ')}`;
      if (help.length && drop > 0) s += `. Partly offset by ${help.map(d => `${d.words} (+${moneyK(d.effect)})`).join(' and ')}`;
      if (drop < 0 && help.length) s += `, mainly ${help.map(d => `${d.words} (+${moneyK(d.effect)})`).join(' and ')}`;
      why.push(s + '.');
    } else {
      why.push(`Our Year-1 NOI (${moneyK(y1)}) is within 3% of the seller's T12 (${moneyK(t12)}).`);
    }
    const yieldOnPrice = y1 / price;
    const rate = (facts.inputs || []).find(i => /^loan interest rate/i.test(String(i.label || '')));
    const r = rate && isNum(rate.value) ? rate.value : null;
    // negative leverage: worth a sentence when the property yields less than the loan costs; the main reason when by a point or more
    if (r != null && yieldOnPrice < r - 0.0025) {
      const cf1 = facts.pro_forma && facts.pro_forma.after_debt ? (facts.pro_forma.after_debt[1] ?? facts.pro_forma.after_debt['1']) : null;
      why.push(`At ${moneyK(price)} the property earns ${pct(yieldOnPrice, 1)} on the price in Year 1 while the loan costs ${pct(r, 1)}, so borrowing lowers our return instead of raising it`
        + (isNum(cf1) && cf1 < 0 ? ` (Year 1 loses ${money(-cf1)} after the loan and our fee)` : '')
        + (yieldOnPrice < r - 0.01 ? '. That is the main reason the return is low.' : '.'));
    }
  }

  let headline;
  if (meets) {
    headline = `Works at ${moneyK(price)}: ${pct(irr, 1)} against our ${tgtTxt} target.` + (bid ? ` We could pay up to ${moneyK(bid.price)}${per(bid.price)} and still make ${tgtTxt}.` : '');
  } else if (bid) {
    headline = (bid.vs_price > -0.05 ? `Close at ${moneyK(price)} (${pct(irr, 1)}).` : `Does not work at ${moneyK(price)} (${pct(irr, 1)}).`)
      + ` Our bid: ${moneyK(bid.price)}${per(bid.price)}, ${pct(Math.abs(bid.vs_price), 0)} below — the most we can pay and still make ${tgtTxt}.`;
    why.push(`Our bid of ${moneyK(bid.price)} is ${an(pct(t12 ? t12 / bid.price : bid.cap_on_t12, 2))} cap rate on the seller's T12 NOI. A broker will compare that cap rate to recent sales, so it is the number to defend in an offer.`);
  } else {
    headline = `Does not work at ${moneyK(price)} (${pct(irr, 1)}), and no price between a 2% and a 15% cap on the T12 NOI makes ${tgtTxt}.`;
  }

  // a deal of several buildings: say whether buying only part of it does better (the Deal Combinations tab
  // underwrites every mix through the full model)
  const mixes = (Array.isArray(card.combos) ? card.combos : []).filter(m => isNum(m.irr) && m.mix);
  if (mixes.length >= 3) {
    const whole = mixes.reduce((a, m) => (isNum(m.units) && m.units > (a ? a.units : 0) ? m : a), null);
    const parts = mixes.filter(m => m !== whole).sort((a, b) => b.irr - a.irr);
    const best = parts[0];
    if (whole && best) {
      why.push(best.irr > whole.irr
        ? `Buying only ${best.mix} does better: ${pct(best.irr, 1)} at its ${moneyK(best.ask)} ask${isNum(best.max_price) ? `, with our bid at ${moneyK(best.max_price)}` : ''}${best.irr >= tgt ? ` — it clears ${tgtTxt}` : ` — still short of ${tgtTxt}`}.`
        : `Splitting it up does not help: each of the ${parts.length} smaller mixes of the buildings does worse than the whole package (the best, ${best.mix} on its own ask, makes ${pct(best.irr, 1)}).`);
    }
  }

  const rows = (lv.levers || []).map(l => ({ label: l.label, how: l.how, irr: pct(l.irr, 1), change: isNum(l.change) ? (l.change >= 0 ? '+' : '−') + Math.abs(l.change * 100).toFixed(1) + ' pts' : NA, bid: isNum(l.bid) ? moneyK(l.bid) : (l.key === 'ltv' ? 'n/a' : NA), bidUp: isNum(l.bid) && bid ? '+' + moneyK(l.bid - bid.price) : '' }));
  const tog = lv.together || {};
  let leverNote = '';
  if (isNum(tog.irr)) {
    leverNote = tog.irr >= tgt
      ? `Do all three of cheaper debt, lower costs and more income, and it reaches ${pct(tog.irr, 1)} at ${moneyK(price)} — the deal can work at this price if those are real.`
      : `Even with cheaper debt, lower costs and more income together, it reaches only ${pct(tog.irr, 1)} at ${moneyK(price)}. The price is what has to move${isNum(tog.bid) ? `: with all three, our bid rises to ${moneyK(tog.bid)}` : ''}.`;
  }
  return { headline, why, rows, together: { irr: pct(tog.irr, 1), bid: isNum(tog.bid) ? moneyK(tog.bid) : NA, change: isNum(tog.change) ? '+' + (tog.change * 100).toFixed(1) + ' pts' : NA }, leverNote, bid: bid ? moneyK(bid.price) : null };
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
  // our bid: levers.py solves it exactly on the model's own cash flows; the workbook's solver interpolates between
  // cap-rate columns (about $0.1M off), so the exact figure is used wherever both exist
  const exactBid = facts.levers && facts.levers.bid && isNum(facts.levers.bid.price) ? facts.levers.bid.price : null;
  const maxPrice = exactBid != null ? exactBid : isNum(card.max_price) && card.max_price > 0 ? card.max_price : null;
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
    { label: card.price_from_ask ? 'THEIR ASK' : 'NO ASK · INCOME PRICE', value: moneyK(price), sub: isNum(card.price_per_door) ? money(card.price_per_door) + ' per unit' : NA, src: card.price_from_ask ? 'the broker’s asking price' : 'no ask: T12 NOI ÷ our purchase cap' },
    { label: 'UNITS', value: int(units), sub: isNum(card.occupancy) ? pct(card.occupancy, 1) + ' occupied' : NA, src: T('rent_roll', 'Rent Roll') },
    { label: 'T12 NOI', value: moneyK(card.t12_noi), sub: isNum(card.year1_noi) ? 'Year-1 NOI ' + moneyK(card.year1_noi) : NA, src: T('t12', 'T12 Actuals') },
    { label: 'IN-PLACE CAP RATE', value: pct(cap, 2), sub: OPT + ': T12 NOI ÷ price run', src: 'derived here, not quoted' },
    { label: 'LEVERED IRR', value: irrFailed ? 'n/a' : pct(irr, 1), sub: irrFailed ? 'equity not recovered' : (meets == null ? NA : (meets ? 'meets ' : 'below ') + tgtTxt + ' target'), src: `model: Debt & Exit, ${isNum(card.hold_years) ? card.hold_years + '-year hold' : 'hold period'}`, tone: meets === true ? 'good' : meets === false ? 'bad' : '' },
    { label: `OUR BID @ ${tgtTxt} IRR`, value: maxPrice != null ? moneyK(maxPrice) : 'no solve', sub: gap != null ? `${gap >= 0 ? '+' : '−'}${moneyK(Math.abs(gap))} (${gap >= 0 ? '+' : '−'}${Math.abs(Math.round(gap / price * 100))}%) vs ${card.price_from_ask ? 'their ask' : 'the income price'} — ${OPT}` : 'the solver returned no price', src: exactBid != null ? 'the price that makes the target on the model’s cash flows' : 'model: Max Price Solver', tone: gap == null ? '' : gap >= 0 ? 'good' : 'bad' },
  ];
  if (review.needs) {
    for (const t of tiles) {
      if (/^(THEIR ASK|NO ASK|IN-PLACE CAP RATE|LEVERED IRR|OUR BID)/.test(t.label)) { t.value = nr; t.sub = 'not reliable: see the review box'; t.tone = 'bad'; }
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

  // their price against ours (the owner, 2026-11-01: "for each deal, a price we're willing to pay versus the price they give")
  const versus = (!review.needs && price && maxPrice != null) ? (() => {
    const d = maxPrice - price, pc = d / price, per = v => isNum(units) && units ? ` · ${moneyK(v / units)} a unit` : '';
    return {
      theirLabel: card.price_from_ask ? 'THEIR ASKING PRICE' : 'NO ASK GIVEN', their: moneyK(price),
      theirSub: card.price_from_ask ? `${per(price).slice(3) || ' '}` : `the price the income supports at our ${isNum(card.purchase_cap) ? pct(card.purchase_cap, 1) : '5.5%'} cap${per(price)}`,
      our: moneyK(maxPrice), ourSub: `the most that makes ${tgtTxt}${per(maxPrice)}`,
      gap: d >= 0 ? `${moneyK(d)} of room` : `${moneyK(Math.abs(d))} (${Math.abs(Math.round(pc * 100))}%)`,
      gapSub: d >= 0 ? `we could pay ${Math.round(pc * 100)}% more and still make ${tgtTxt}` : `below ${card.price_from_ask ? 'their ask' : 'the income price'}: ${Math.abs(pc) <= 0.1 ? 'a negotiable gap' : Math.abs(pc) <= 0.2 ? 'a hard negotiation' : 'unlikely to close'}`,
    };
  })() : null;
  const bottom = review.needs ? null : bottomLine(facts, card, { price, units, irr, tgt, tgtTxt, meets });

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
    versus, bottom, review, score: scoreDeal(Object.assign(shapeCard(card), { needs_review: review.needs })), cautions: review.needs ? [] : shapeCard(card).cautions, handReview: reviewFor(shapeCard(card).name, path.basename(String(ctx.file || ''))), noRecord: !idx.known, tiles, tiles2, verdict, tgtTxt,
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
  if (r.bottom) h.push(`<table cellspacing="4"><tr><td class="bottom"><p class="big">${esc(r.bottom.headline)}</p>${r.bottom.why.map(x => `<p>• ${esc(x)}</p>`).join('')}</td></tr></table>`);
  if (r.versus) h.push(`<table cellspacing="4"><tr><td class="vs"><p class="lbl">${esc(r.versus.theirLabel)}</p><p class="big">${esc(r.versus.their)}</p><p>${esc(r.versus.theirSub)}</p></td><td class="vs"><p class="lbl">THE PRICE WE WOULD PAY</p><p class="big good">${esc(r.versus.our)}</p><p>${esc(r.versus.ourSub)}</p></td><td class="vs"><p class="lbl">TO NEGOTIATE</p><p class="big">${esc(r.versus.gap)}</p><p>${esc(r.versus.gapSub)}</p></td></tr></table>`);
  // the hand review sits under the numbers it vouches for when the page leads with the bottom line, else up top
  const hr = r.handReview;
  const hl = (t, xs) => (xs || []).length ? `<p><b>${t}</b></p>${xs.map(x => `<p>• ${esc(x)}</p>`).join('')}` : '';
  const reviewBox = () => {
    if (hr) h.push(`<table cellspacing="4"><tr><td class="reviewed"><p><b>Underwritten by hand ${esc(hr.reviewed || '')}${hr.current ? '' : ' (an earlier run)'}.</b> ${esc(hr.summary)}</p>${hl('What was checked', hr.checked)}${hl('What was wrong and is fixed', hr.fixed)}${hl('Still open', hr.open)}</td></tr></table>`);
    else if (r.cautions && r.cautions.length) h.push(`<table cellspacing="4"><tr><td class="caution"><p><b>Check before relying on the score.</b></p>${r.cautions.map(x => `<p>• ${esc(x)}</p>`).join('')}</td></tr></table>`);
  };
  if (!r.bottom) reviewBox();
  if (r.review && r.review.needs) h.push(`<table cellspacing="4"><tr><td class="review"><p><b>NEEDS REVIEW: do not rely on this deal's price or returns.</b></p>${r.review.reasons.map(x => `<p>• ${esc(x)}</p>`).join('')}${(r.review.fix || []).map(x => `<p><b>What would fix it:</b> ${esc(x)}</p>`).join('')}</td></tr></table>`);
  const tile = t => `<td class="tile" width="33%"><p class="lbl">${esc(t.label)}</p><p class="big ${t.tone || ''}">${esc(t.value)}</p><p>${esc(t.sub)}</p><p class="src">${esc(t.src)}</p></td>`;
  h.push(`<table cellspacing="6"><tr>${r.tiles.slice(0, 3).map(tile).join('')}</tr><tr>${r.tiles.slice(3).map(tile).join('')}</tr></table>`);
  h.push(`<table><tr>${r.tiles2.map(t => `<td><p class="lbl">${esc(t[0].toUpperCase())}</p><p><b>${esc(t[1])}</b></p><p class="src">${esc(t[2])}</p></td>`).join('')}</tr></table>`);
  const b = r.bottom;
  if (b) {
    h.push('<h2>How to make it work</h2>');
    h.push(`<table><tr><th>If we could…</th><th class="r">IRR at ${esc(r.tiles[0].value)}</th><th class="r">Change</th><th class="r">Our bid becomes</th></tr>${b.rows.map(l => `<tr><td><b>${esc(l.label)}</b><br/><span class="src">${esc(l.how)}</span></td><td class="r">${esc(l.irr)}</td><td class="r">${esc(l.change)}</td><td class="r">${esc(l.bid)}${l.bidUp ? `<br/><span class="src">${esc(l.bidUp)}</span>` : ''}</td></tr>`).join('')}<tr class="tot"><td>Cheaper debt, lower costs and more income, together</td><td class="r">${esc(b.together.irr)}</td><td class="r">${esc(b.together.change)}</td><td class="r">${esc(b.together.bid)}</td></tr></table>`);
    if (b.leverNote) h.push(`<p style="margin-top:4pt"><b>${esc(b.leverNote)}</b></p>`);
    h.push(`<p class="src">house estimate: each line re-runs the model's own cash flows (property tax re-set at each price, as the model does) with that one change. "Our bid" is the price that makes ${esc(r.tgtTxt)}. The sizes are examples to judge against this property, not promises.</p>`);
    reviewBox();
  } else {
    h.push(`<p style="margin-top:8pt"><b>${esc(r.verdict)}</b></p>`);
  }

  h.push('<h2>Property and deal facts</h2>');
  if (r.noRecord) h.push('<p class="src">Original file names were not kept for this deal (run before the 2026-10-21 tracking); each figure is cited to the model tab it was read from.</p>');
  h.push(`<table><tr><th>Item</th><th class="r">Value</th><th>Source</th></tr>${r.facts.map(f => row2(f[0], f[1], f[2])).join('')}</table>`);

  h.push('<h2>Returns and capital</h2>');
  h.push(`<table><tr><th>Scenario (model's own)</th><th class="r">Hold</th><th class="r">Sale value</th><th class="r">Levered IRR</th><th class="r">Equity multiple</th><th class="r">vs ${esc(r.tgtTxt)}</th></tr>${r.scenarios.length ? r.scenarios.map(s => `<tr><td>${esc(s.scenario)}</td><td class="r">${esc(s.hold)}</td><td class="r">${esc(s.sale)}</td><td class="r"><b>${esc(s.irr)}</b></td><td class="r">${esc(s.em)}</td><td class="r ${s.verdict === 'meets' ? 'good' : s.verdict === 'below' ? 'bad' : ''}">${esc(s.verdict)}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">Scenario table not readable from this model.</td></tr>'}</table>`);
  const half = Math.ceil(r.stack.length / 2);
  h.push(`<table style="margin-top:6pt"><tr><th>Capital stack (model: Debt &amp; Exit tab)</th><th class="r">Amount</th><th>&nbsp;</th><th class="r">Amount</th></tr>${r.stack.slice(0, half).map((s, i) => { const t = r.stack[half + i]; return `<tr><td>${esc(s.label)}</td><td class="r">${esc(s.value)}</td><td>${t ? esc(t.label) : ''}</td><td class="r">${t ? esc(t.value) : ''}</td></tr>`; }).join('')}</table>`);

  if (r.score && r.score.score != null) {
    h.push(`<h2>Deal score: ${r.score.score} / 100 (${esc(r.score.grade)})</h2>`);
    if (r.score.capped) h.push(`<p class="muted">${esc(r.score.note)}.</p>`);
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
    if (meta && meta.v !== REPORT_VERSION) return false;
    // a hand review that changed after the PDF was built (config/underwriting-reviews.json) makes it stale too
    if (meta && meta.name != null && (meta.review || '') !== reviewStamp(meta.name, file)) return false;
    return true;
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
      if (markReport) markReport(file, { v: REPORT_VERSION, at: new Date().toISOString(), pages: res.pages, name: report.header.name, review: reviewStamp(report.header.name, file) });
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

// what the hand review printed in a report said, as a short hash, so a review edited later rebuilds the PDF
function reviewStamp(name, file) {
  const r = reviewFor(name, path.basename(String(file || '')));
  return r ? crypto.createHash('sha1').update(JSON.stringify(r)).digest('hex').slice(0, 12) : '';
}

// same stamp rule the board uses for "run date"
function runDateOf(file, mtimeMs) {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?=(?:\s*\(\d+\))?\.xlsx$)/i.exec(file);
  if (m) { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])); if (!Number.isNaN(d.getTime())) return d.toISOString(); }
  return new Date(mtimeMs).toISOString();
}

module.exports = { REPORT_VERSION, plainNote, buildReport, renderHtml, footerText, createReports, pdfNameFor, money, moneyK, pct, assumptionSource, sourceIndex };
