#!/usr/bin/env node
// Underwrite a deal with no API tokens: Claude reads the files, the model and its checks are the site's own.
//
// The owner, 2026-11-01: "I've been sending you these deals. You should be underwriting them through Claude, so we're
// not using API tokens through the website... checking the full process: it parses them correctly, gets all the
// numbers into the model, all the tools in the model work, and if there are numbers we can't get, what are other
// ways to get them." The site's Generate button needs a paid model to read a file its built-in readers do not know
// (a PDF, a T12 laid out by account groups, an OM). Here Claude reads those in the session and writes what it read
// into the deal folder's intake.json; this script then does exactly what the Generate route does - the same
// generator, mixes, bake, card, levers and PDF - and checks the result before anyone sees it.
//
//   node scripts/underwriteLocal.js <deal-folder>
//
// <deal-folder>/intake.json:
//   { "name": "Lakeview Portfolio",                       // the property's name (a portfolio: the package name)
//     "property": { "address": "...", "year_built": 1986, "site_acres": 39.56 },
//     "buildings": [                                          // one entry per building; a single property has one
//       { "name": "Haywood Pointe", "rent_roll": "RR.xlsx", "rr_map": "rr-map.json", "t12": "T12.xlsx", "t12_map": "t12-map.json",
//         "address": "...", "year_built": 1986, "asking_price": 31000000 } ],
//     "assumptions": { "purchase_price_override": 78000000 },  // only what differs from the house defaults, each with a reason
//     "why": { "purchase_price_override": "Broker email 10/15: $78M for the package" },
//     "tax": { "current_taxable_value": 50647770, "current_millage_rate": 18.161, "reassessment_on_sale_pct": 1,
//              "county_source_url": "https://..." },
//     "om": { "file": "OM.pdf", "notes": ["OM p.4: 416 of 564 units renovated"] } }
//
// Writes <deal-folder>/out/<model>.xlsx, its PDF report and intake-report.md (every check, pass or fail). The model
// carries a hidden Provenance tab, so importing it on the Underwriting tab keeps the record of how each file was read.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UW = path.join(ROOT, 'underwriting');
const PY = process.env.UNDERWRITING_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const deals = require(path.join(ROOT, 'services', 'underwritingDeals'));
const report = require(path.join(ROOT, 'services', 'underwritingReport'));

function py(script, args, timeout = 900000) {
  const out = execFileSync(PY, [path.join(UW, script), ...args], { cwd: UW, maxBuffer: 256 * 1024 * 1024, timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const line = out.trim().split('\n').reverse().find(l => l.trim().startsWith('{'));
  if (!line) throw new Error(`${script} printed no result`);
  const j = JSON.parse(line);
  if (j.error) throw new Error(`${script}: ${j.error}`);
  return j;
}

// The page's own defaults (public/index.html UW_DEFAULTS), so a deal built here starts exactly where one built on the site does.
function houseDefaults() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const m = /const UW_DEFAULTS = (\{[\s\S]*?\n\});/.exec(html);
  if (!m) throw new Error('UW_DEFAULTS not found in public/index.html');
  return vm.runInNewContext('(' + m[1] + ')');
}

const sum = xs => xs.reduce((a, b) => a + b, 0);
const T12_SUM = ['gross_potential_rent', 'vacancy_concessions_bad_debt', 'net_rental_income', 'other_income', 'effective_gross_income',
  'controllable_expenses', 'utilities', 'management_fee_actual', 'insurance', 'property_taxes_actual', 'other_property_expenses',
  'total_operating_expenses', 'net_operating_income', 'actual_vacancy_loss', 'actual_bad_debt', 'actual_concessions'];
const T12_SUBS = ['repairs_maintenance', 'turnover_costs', 'labor_costs', 'advertising_promotions', 'general_admin'];

function buildDeal(folder, intake, log) {
  const defaults = houseDefaults();
  const blds = intake.buildings || [];
  if (!blds.length) throw new Error('intake.json lists no buildings');
  const multi = blds.length > 1;
  const sources = [];
  const parts = blds.map(b => {
    const rr = py('intake_read.py', ['rr', path.join(folder, b.rent_roll), ...(b.rr_map ? [path.join(folder, b.rr_map)] : [])]);
    const t = py('intake_read.py', ['t12', path.join(folder, b.t12), ...(b.t12_map ? [path.join(folder, b.t12_map)] : [])]);
    sources.push({ kind: 'rent_roll', filename: b.rent_roll, method: rr.method, warnings: rr.warnings.length, notes: [`${b.name}: ${rr.data.units.length} units`, ...rr.warnings].slice(0, 6) });
    sources.push({ kind: 't12', filename: b.t12, method: t.method, warnings: t.warnings.length, notes: [`${b.name}: NOI ${Math.round(t.data.net_operating_income).toLocaleString('en-US')}`, ...t.warnings].slice(0, 6) });
    log(`read ${b.name}: ${rr.data.units.length} units (${rr.method}); T12 NOI ${Math.round(t.data.net_operating_income).toLocaleString('en-US')} (${t.method})`);
    return { b, rr, t };
  });

  // rent roll: one list, each unit labelled with its building when there are several (the page's uwMergeRentRolls)
  const units = [];
  parts.forEach(p => p.rr.data.units.forEach(u => units.push(Object.assign({}, u, { unit_number: multi ? `${p.b.name} · ${u.unit_number ?? ''}` : u.unit_number }))));
  const off = k => { const v = parts.map(p => p.rr.data[k]); return v.every(x => typeof x === 'number') ? sum(v) : null; };
  const dates = parts.map(p => p.rr.data.as_of_date).filter(Boolean).sort();
  const rent_roll = { as_of_date: dates.length ? dates[dates.length - 1] : null, official_units: off('official_units'),
    official_occupied_units: off('official_occupied_units'), official_vacant_units: off('official_vacant_units'), units };
  rent_roll.official_occupancy = rent_roll.official_units && rent_roll.official_occupied_units != null ? rent_roll.official_occupied_units / rent_roll.official_units : null;

  // T12: the buildings' statements added up (uwMergeT12s); a controllable sub-line only when every building has it
  const t12 = {};
  for (const k of T12_SUM) { const v = parts.map(p => p.t.data[k]).filter(x => typeof x === 'number'); t12[k] = v.length ? sum(v) : null; }
  for (const k of T12_SUBS) { const v = parts.map(p => p.t.data[k]); t12[k] = v.every(x => typeof x === 'number') ? sum(v) : null; }
  t12.month_headers = (parts.find(p => (p.t.data.month_headers || []).length) || parts[0]).t.data.month_headers || [];
  t12.raw_monthly_detail = [];
  parts.forEach(p => (p.t.data.raw_monthly_detail || []).forEach(r => t12.raw_monthly_detail.push(Object.assign({}, r, multi ? { label: `${p.b.name} · ${r.label || r.account || ''}` } : {}))));

  const assumptions = Object.assign({}, defaults, { stabilized_occupancy_target: rent_roll.official_occupancy ?? defaults.stabilized_occupancy_target });
  const asks = blds.map(b => b.asking_price);
  if (asks.every(a => typeof a === 'number' && a > 0)) assumptions.purchase_price_override = sum(asks);
  Object.assign(assumptions, intake.assumptions || {});

  const deal = {
    property: Object.assign({ name: intake.name, units: rent_roll.official_units }, intake.property || {}),
    assumptions,
    t12,
    tax: Object.assign({ t12_property_tax_expense: t12.property_taxes_actual ?? undefined,
      site_address: multi ? blds.map(b => b.address).filter(Boolean).join('; ') || undefined : undefined }, intake.tax || {}),
    rent_roll, rent_comps: intake.rent_comps || [], sale_comps: intake.sale_comps || [],
  };
  if (intake.om && intake.om.file) deal.property.om_source_file = intake.om.file;
  if (multi && deal.property.year_built == null) {
    const yrs = blds.filter(b => b.year_built).map(b => `${b.year_built} (${b.name})`);
    if (yrs.length) deal.property.year_built_label = yrs.join(' / ');
  }
  if (multi) {
    deal.properties = parts.map(p => {
      const e = { name: p.b.name, rent_roll_file: p.b.rent_roll, as_of_date: p.rr.data.as_of_date || null, t12_file: p.b.t12, t12: {},
        address: p.b.address || null, year_built: p.b.year_built || null, om_units: p.b.units || null, asking_price: p.b.asking_price || null };
      T12_SUM.concat(T12_SUBS).forEach(k => { if (typeof p.t.data[k] === 'number') e.t12[k] = p.t.data[k]; });
      return e;
    });
  }
  if (intake.om && intake.om.file) sources.push({ kind: 'om', filename: intake.om.file, method: 'read by Claude (no API)', notes: (intake.om.notes || []).slice(0, 6) });
  const why = intake.why || {};
  const confirmed = Object.keys(intake.assumptions || {}).map(k => `${k.replace(/_/g, ' ')}: ${why[k] || 'set in the intake sheet'}`);
  return { deal, parts, provenance: { sources, confirmed_by_hand: confirmed.length, confirmed_fields: confirmed } };
}

function underwrite(folder, { log = console.log } = {}) {
  folder = path.resolve(folder);
  const intake = JSON.parse(fs.readFileSync(path.join(folder, 'intake.json'), 'utf8'));
  const out = path.join(folder, 'out');
  fs.mkdirSync(out, { recursive: true });
  const checks = [];
  const check = (label, ok, detail) => { checks.push({ label, ok: !!ok, detail: detail == null ? '' : String(detail) }); log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail == null ? '' : '  -> ' + detail}`); };

  const { deal, parts, provenance } = buildDeal(folder, intake, log);
  const rec = deals.reconcileOfficialCounts(deal.rent_roll);
  if (rec.note) log('rent roll: ' + rec.note);

  // the files themselves: every unit read, each T12 adds up (and ties to its statement's NOI where a map was used)
  for (const p of parts) {
    const d = p.rr.data;
    check(`${p.b.name}: every unit on the rent roll was read (${d.units.length} of ${d.official_units})`, d.official_units == null || d.units.length === d.official_units, `${d.units.length} read, report says ${d.official_units}`);
    const t = p.t.data;
    const tie = t.effective_gross_income - t.total_operating_expenses - t.net_operating_income;
    check(`${p.b.name}: the T12 ties (EGI − expenses = NOI)`, Math.abs(tie) < Math.max(2, Math.abs(t.net_operating_income) * 0.001), `off by ${Math.round(tie)}`);
    if (p.t.meta && p.t.meta.stated_noi != null) check(`${p.b.name}: the mapped T12 ties to the statement's own NOI`, Math.abs(p.t.meta.stated_noi - t.net_operating_income) <= (p.t.meta.noi_tolerance || 1), `${t.net_operating_income} vs ${p.t.meta.stated_noi}`);
  }

  const slug = String(intake.name || 'deal').replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, '-').slice(0, 48) || 'deal';
  const stampTime = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const model = path.join(out, `${slug}-${stampTime}.xlsx`);
  const dealJson = path.join(out, 'deal.json');
  fs.writeFileSync(dealJson, JSON.stringify(deal, null, 1));
  const gen = py('generator.py', [dealJson, model, path.join(UW, 'Underwriting Model TEMPLATE.xlsx')]);
  (gen.warnings || []).forEach(w => log('generator: ' + w));
  if ((deal.properties || []).length >= 2) {
    const c = py('deal_combos.py', [dealJson, model], 1800000);
    log(`mixes: ${c.combos} underwritten${(c.warnings || []).length ? '; ' + c.warnings.join('; ') : ''}`);
  }
  const provFile = path.join(out, 'provenance.json');
  fs.writeFileSync(provFile, JSON.stringify(provenance));
  py('intake_read.py', ['stamp', model, provFile]);
  const fin = py('finish_model.py', [model], 1800000);
  log(`baked ${fin.baked_cells ?? '?'} cells with ${fin.engine || 'Excel'}`);

  // the finished model, as the board and the PDF will read it
  const raw = py('deal_card.py', [model]).cards[model];
  const card = deals.shapeCard(raw);
  check('every formula in the model has a value (nothing opens blank)', raw.uncomputed_formulas === 0, `${raw.uncomputed_formulas} formulas without a value`);
  check('the model solved a price, an IRR and our bid', raw.computed && typeof raw.irr === 'number' && !raw.irr_failed && typeof raw.max_price === 'number', JSON.stringify({ irr: raw.irr, bid: raw.max_price }));
  check('the model holds every rent-roll unit', raw.units === deal.rent_roll.official_units, `${raw.units} vs ${deal.rent_roll.official_units}`);
  // a hand-reviewed correction to the T12 (config/underwriting-overrides.json, e.g. a property-tax refund taken out) may differ,
  // and is named; anything else must be the statements' NOI to the dollar
  let t12Overridden = false;
  try {
    const ov = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'underwriting-overrides.json'), 'utf8'))[deals.propertyKey(intake.name)];
    t12Overridden = !!(ov && (ov.cells || []).some(c => /^T12 Actuals!/i.test(c.cell)));
  } catch { /* no overrides file */ }
  const noiGap = (raw.t12_noi || 0) - deal.t12.net_operating_income;
  const noiLabel = t12Overridden && Math.abs(noiGap) >= 1
    ? `the model's T12 NOI differs from the statements' by ${Math.round(noiGap).toLocaleString('en-US')}: the hand-reviewed override for this property (config/underwriting-overrides.json)`
    : "the model's T12 NOI is the statements' NOI";
  check(noiLabel, t12Overridden || Math.abs(noiGap) < 1, `${raw.t12_noi} vs ${deal.t12.net_operating_income}`);
  const facts = py('deal_facts.py', [model], 600000);
  check('our bid and the levers re-run the model\'s own cash flows and tie to its IRR', facts.levers && !facts.levers.error, facts.levers && facts.levers.error);
  const reasons = deals.reviewReasons(raw);
  check('nothing trips the plausibility gate (it would be flagged NEEDS REVIEW on the board)', reasons.length === 0, reasons.join(' | '));
  const placeholders = (facts.inputs || []).filter(i => /placeholder|needs? confirmation|source needed/i.test(String(i.note || ''))).map(i => i.label);

  const r = report.buildReport(facts, { file: path.basename(model), provenance, runDate: new Date().toISOString(), generated: new Date().toISOString() });
  const html = path.join(out, 'report.html');
  fs.writeFileSync(html, report.renderHtml(r));
  const pdf = model.replace(/\.xlsx$/, '.pdf');
  const res = py('html_to_pdf.py', [html, pdf, report.footerText(r), `${r.header.name} - underwriting summary`]);
  check('the PDF report builds', fs.existsSync(pdf) && res.pages >= 1, JSON.stringify(res));
  fs.unlinkSync(html);

  const pct = v => typeof v === 'number' ? (v * 100).toFixed(1) + '%' : 'n/a';
  const M = v => typeof v === 'number' ? '$' + (v / 1e6).toFixed(2) + 'M' : 'n/a';
  const md = [
    `# ${intake.name} — intake ${stampTime.slice(0, 10)}`, '',
    `Model: ${path.basename(model)}  `, `Report: ${path.basename(pdf)} (${res.pages} pages)`, '',
    `**${r.bottom ? r.bottom.headline : r.verdict}**`, '',
    ...(r.bottom ? r.bottom.why.map(w => `- ${w}`) : []), '',
    `| Price | IRR | Our bid | Year-1 NOI | T12 NOI | Score |`, `|---|---|---|---|---|---|`,
    `| ${M(raw.price)} | ${pct(raw.irr)} | ${M(raw.max_price)} | ${M(raw.year1_noi)} | ${M(raw.t12_noi)} | ${card.deal_score ? card.deal_score.score : deals.scoreDeal(card).score} |`, '',
    '## Checks', ...checks.map(c => `- ${c.ok ? 'PASS' : '**FAIL**'} ${c.label}${c.ok || !c.detail ? '' : ` — ${c.detail}`}`), '',
    '## How each file was read', ...provenance.sources.map(s => `- ${s.kind}: ${s.filename} — ${s.method}${s.notes && s.notes.length ? ` (${s.notes.join('; ')})` : ''}`), '',
    '## Set by hand, and why', ...(provenance.confirmed_fields.length ? provenance.confirmed_fields.map(f => `- ${f}`) : ['- nothing: house defaults throughout']), '',
    '## Still placeholders (not from a document)', ...(placeholders.length ? placeholders.map(p => `- ${p}`) : ['- none']), '',
    'Next: drop the .xlsx on the Underwriting tab (it imports as a finished model and keeps this record), then add a hand review to config/underwriting-reviews.json.',
  ].join('\n');
  fs.writeFileSync(path.join(out, 'intake-report.md'), md + '\n');
  return { model, pdf, checks, failed: checks.filter(c => !c.ok).length, card: raw };
}

module.exports = { underwrite, buildDeal, houseDefaults };

if (require.main === module) {
  const folder = process.argv[2];
  if (!folder) { console.error('Usage: node scripts/underwriteLocal.js <deal-folder>'); process.exit(2); }
  try {
    const r = underwrite(folder);
    console.log(`\n${r.failed ? r.failed + ' check(s) FAILED' : 'All intake checks passed'} — ${r.model}`);
    process.exit(r.failed ? 1 : 0);
  } catch (e) {
    console.error('Intake failed: ' + e.message);
    process.exit(1);
  }
}
