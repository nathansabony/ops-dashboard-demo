#!/usr/bin/env node
// Reconcile the Delinquency tab's charged / paid against RM's own Report Summary.
//
//   node scripts/reconcileChargeDetail.js summary.txt --scope Birchwood Commons
//   node scripts/reconcileChargeDetail.js summary.txt --scope Birchwood Commons --window 2026-07
//   node scripts/reconcileChargeDetail.js --selftest
//
// ── the complaint ───────────────────────────────────────────────────────────
// The owner, 2026-08-25: on the charged / paid figures, *"some of those numbers were
// off, like fifty, sixty dollars. We wanna make sure they're the exact numbers."*
// The meeting's guess was mid-month move-in proration. There are four candidates
// that all look like a small unexplained gap, and this script separates them by
// asking Rent Manager the same question four ways:
//
//   1. TENANT SCOPE. We pass CustomerStatus=2 (current + notice). A tenant who
//      moved out inside the window is FORMER now (status 1) — their charges are in
//      an export run with the default scope and not in ours. This is the leading
//      candidate for a one-unit, few-dollar gap, and it is settled by running both
//      and seeing which one reproduces the export.
//   2. EXCLUDED CHARGE TYPES. The tab drops TAX and LD from the percentage on
//      purpose (2026-07-22 meeting). If the export includes them, the totals are
//      supposed to differ — by exactly those rows, which this prints separately.
//   3. GRID1 vs GRID2. The % Collected card reads Grid2 (RM's own summary); the
//      cohort maths reads Grid1 (one row per payment allocation) and dedupes by
//      ChargeID. The two are supposed to be identical. That was verified once by
//      hand in July; here it is an assertion.
//   4. THE PARSER. Until 2026-08-25 the delinquency services read amounts with a
//      parser that turned an accounting credit "(60.00)" into 0 — see
//      services/rmAmount.js. A gap the size of a credit is the signature.
//
// Holds no financial figures (repo policy): everything printed comes from the
// export and from RM, and the self-test numbers are invented.

const fs = require('fs');
const path = require('path');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NUM_RE = /^\(?-?\$?[\d,]+(?:\.\d+)?\)?$|^-$|^—$/;

function parseNum(t) {
  const s = String(t).trim();
  if (s === '' || s === '-' || s === '—') return 0;
  const n = Number(s.replace(/[$,()\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return /\(/.test(s) ? -Math.abs(n) : n;
}
const fmt = v => (v == null ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);

// ── the export ──────────────────────────────────────────────────────────────
// RM's ChargeDetail "Report Summary" page: a row per charge type carrying
// Tenants Charged / % Charged / Charge Count / Amount Charged / Amount Paid /
// Balance, then a Total Amount line. The three money columns are the last three
// numbers on the row, which is the one thing that stays true whether it was
// copied out of the PDF or exported to CSV.
function parseSummary(text) {
  const out = { scopeName: null, range: null, rows: [], total: null, warnings: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/ /g, ' ').trim();
    if (!line) continue;
    if (!out.scopeName) {
      const m = /^(?:Property|Owner|Entity|Group)\s*:\s*(.+)$/i.exec(line);
      if (m) { out.scopeName = m[1].trim(); continue; }
    }
    if (!out.range) {
      const m = /Date Range\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(line);
      if (m) { out.range = { start: m[1], end: m[2] }; continue; }
    }

    const fields = (line.match(/,/g) || []).length >= 4 && /,\s*[A-Za-z"]/.test(line)
      ? line.split(',').map(s => s.trim().replace(/^"|"$/g, ''))
      : line.split(/\s{2,}|\t+/).map(s => s.trim()).filter(Boolean);
    const nums = fields.filter(f => NUM_RE.test(f)).map(parseNum).filter(v => v !== null);
    if (nums.length < 3) continue;
    const label = fields.slice(0, fields.findIndex(f => NUM_RE.test(f))).join(' ').trim();
    const [charged, paid, balance] = nums.slice(-3);

    if (/^total\s+amount/i.test(label) || /^total$/i.test(label)) {
      out.total = { charged, paid, balance };
      continue;
    }
    // A charge-type row: the first field is the type code (1 RC, GARBAG, H2O…).
    if (!label || /charge type/i.test(label)) continue;
    const type = fields[0].split(/\s{2,}/)[0].trim();
    const description = label.slice(type.length).trim();
    out.rows.push({ type, description, charged, paid, balance });
  }
  // RM prints the total; if it disagrees with the rows we parsed, we mis-read the
  // page, and every comparison below would inherit that. Say so rather than run on.
  if (out.total) {
    const sum = out.rows.reduce((s, r) => s + r.charged, 0);
    if (Math.abs(sum - out.total.charged) > 0.02) {
      out.warnings.push(`parsed rows sum to ${fmt(sum)} but the export's own Total Amount is ${fmt(out.total.charged)} — the page was not read correctly`);
    }
  }
  return out;
}

// ── our side, from one live ChargeDetail run ────────────────────────────────
const EXCLUDED = ['TAX', 'LD'];

function reportParamQuery(pairs) {
  const params = {};
  pairs.forEach(([k, v], i) => {
    params[`parameters[${i}].Parameter`] = k;
    params[`parameters[${i}].Value`] = v;
    params[`parameters[${i}].InListItemMode`] = 'false';
  });
  return params;
}

// Grid2 (RM's summary) and Grid1 (one row per allocation) folded the same way the
// two services do it, so a disagreement here is a disagreement in the tab.
function foldGrids(body, num) {
  const grid2 = (body && body.Grid2) || [];
  const grid1 = (body && body.Grid1) || [];
  const summary = new Map();
  for (const r of grid2) {
    const type = String(r.ReportSummaryChargeType || '').trim();
    if (!type) continue;
    const cur = summary.get(type) || { type, description: r.ReportSummaryDescription || '', charged: 0, paid: 0 };
    cur.charged += num(r.ReportSummaryAmountCharged);
    cur.paid += num(r.ReportSummaryAmountPaid);
    summary.set(type, cur);
  }
  const detail = new Map();
  const seen = new Set();
  for (const r of grid1) {
    const type = String(r.ChargeTypesName || r.ChargeTypesNameClone || '').trim();
    if (!type) continue;
    const cur = detail.get(type) || { type, charged: 0, paid: 0 };
    const id = r.ChargesChargeID;
    if (id != null && !seen.has(id)) {
      seen.add(id);
      cur.charged += num(r.ChargesAmount || r.ChargesAmountClone);
    }
    if (r.PaymentsTransactionDate) cur.paid += num(r.AllocationsAmount);
    detail.set(type, cur);
  }
  return { summary, detail, grid1Rows: grid1.length, grid2Rows: grid2.length };
}

async function runFor(rm, propertyIds, start, end, status, num) {
  const body = await rm.RunReport(30, reportParamQuery([
    ['StartDate', start],
    ['EndDate', end],
    ['PropertyIDs', propertyIds.join(',')],
    ['SHOWINACTIVEPROPS', 'False'],
    ['GroupID', '0'],
    ['BatchProps', 'False'],
    ['CHARGESTOINCLUDE', 'All'],
    ['SORTOPTIONS', '0'],
    ['CustomerStatus', String(status)],
  ]));
  return foldGrids(body, num);
}

// ── comparison ──────────────────────────────────────────────────────────────
function compare(exportRows, ours, tol) {
  const types = new Set([...exportRows.map(r => r.type), ...ours.keys()]);
  const rows = [];
  for (const type of types) {
    const e = exportRows.find(r => r.type === type);
    const o = ours.get(type);
    const ec = e ? e.charged : null, ep = e ? e.paid : null;
    const oc = o ? o.charged : null, op = o ? o.paid : null;
    const dC = (oc == null || ec == null) ? null : oc - ec;
    const dP = (op == null || ep == null) ? null : op - ep;
    rows.push({ type, ec, ep, oc, op, dC, dP, excluded: EXCLUDED.includes(type),
      onlyExport: !o, onlyOurs: !e,
      ties: dC != null && Math.abs(dC) <= tol && dP != null && Math.abs(dP) <= tol });
  }
  rows.sort((a, b) => Math.abs(b.dC || 0) - Math.abs(a.dC || 0));
  return rows;
}

function printComparison(title, rows, tol) {
  const off = rows.filter(r => !r.ties);
  console.log(`\n${title}`);
  if (!off.length) { console.log('  ✓ every charge type ties, charged and paid'); return 0; }
  console.log(`  ${rows.length - off.length}/${rows.length} charge types tie. Off:`);
  for (const r of off) {
    const tag = r.excluded ? ' [excluded from the tab on purpose — TAX/LD]'
      : r.onlyOurs ? ' [in our run, not in the export]'
      : r.onlyExport ? ' [in the export, not in our run]' : '';
    console.log(`   ${r.type.padEnd(8)} charged  export ${fmt(r.ec).padStart(14)}  ours ${fmt(r.oc).padStart(14)}  Δ ${fmt(r.dC).padStart(12)}${tag}`);
    if (r.dP == null || Math.abs(r.dP) > tol) {
      console.log(`   ${''.padEnd(8)} paid     export ${fmt(r.ep).padStart(14)}  ours ${fmt(r.op).padStart(14)}  Δ ${fmt(r.dP).padStart(12)}`);
    }
  }
  return off.filter(r => !r.excluded).length;
}

// ── self-test ───────────────────────────────────────────────────────────────
function selftest() {
  let fails = 0;
  const t = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`); if (!ok) fails++; };

  const page = [
    '                        Report Summary',
    '                        Property: Testville',
    'Tenants:  681            Tenants as of 07/01/2026:   771',
    'Date Range: 07/01/2026 - 07/31/2026        Days In Range: 31',
    'Charge Type   Description        Tenants Charged   % Charged   Charge Count   Amount Charged   Amount Paid   Balance',
    '1 RC          Rent Charge        679               1.7%        682            1,598,651.27     1,569,452.43  29,198.84',
    'GARBAG        Garbage Fee        677               1.7%        678            22,179.56        21,695.21     484.35',
    'LC            Late Charge        75                0.2%        75             10,612.30        7,409.28      3,202.87',
    'MISC          Miscellaneous Rep  1                 0.0%        1              (60.00)          0.00          (60.00)',
    '                                                   Total Amount:              1,631,383.13     1,598,556.92  32,826.06',
  ].join('\n');

  const p = parseSummary(page);
  t('reads the property off the page', p.scopeName === 'Testville', String(p.scopeName));
  t('reads the date range', p.range && p.range.start === '07/01/2026' && p.range.end === '07/31/2026', JSON.stringify(p.range));
  t('reads every charge-type row', p.rows.length === 4, `${p.rows.length} rows: ${p.rows.map(r => r.type).join(',')}`);
  t('reads a parenthesised credit as negative',
    (p.rows.find(r => r.type === 'MISC') || {}).charged === -60, JSON.stringify(p.rows.find(r => r.type === 'MISC')));
  t('the parsed rows add up to the export\'s own Total Amount', p.warnings.length === 0, p.warnings.join(' | '));

  // The old parser's failure mode, reproduced: a credit read as 0 leaves us $60 high.
  const weak = s => parseFloat(String(s ?? '0').replace(/,/g, '')) || 0;
  const { parseAmount } = require('../services/rmAmount');
  t('the shared parser gets the credit that the old one dropped',
    parseAmount('(60.00)') === -60 && weak('(60.00)') === 0);

  const ours = new Map(p.rows.map(r => [r.type, { type: r.type, charged: r.charged, paid: r.paid }]));
  t('identical sides tie', compare(p.rows, ours, 0.01).every(r => r.ties));
  ours.get('MISC').charged = 0;                       // exactly the dropped-credit bug
  const off = compare(p.rows, ours, 0.01).filter(r => !r.ties);
  t('a $60 gap on one charge type is isolated to that type',
    off.length === 1 && off[0].type === 'MISC' && Math.abs(off[0].dC - 60) < 0.01,
    off.map(r => `${r.type}:${r.dC}`).join(' '));

  const g = foldGrids({
    Grid2: [{ ReportSummaryChargeType: 'RC', ReportSummaryAmountCharged: '1,000.00', ReportSummaryAmountPaid: '900.00' }],
    Grid1: [
      { ChargeTypesName: 'RC', ChargesChargeID: 1, ChargesAmount: '600.00', PaymentsTransactionDate: '2026-07-05', AllocationsAmount: '600.00' },
      { ChargesChargeIDClone: 1, ChargesChargeID: 1, ChargeTypesNameClone: 'RC', ChargesAmount: '', PaymentsTransactionDate: '2026-07-20', AllocationsAmount: '100.00' },
      { ChargeTypesName: 'RC', ChargesChargeID: 2, ChargesAmount: '400.00', PaymentsTransactionDate: '2026-07-06', AllocationsAmount: '200.00' },
    ],
  }, parseAmount);
  t('Grid1 deduped by ChargeID equals Grid2\'s charged',
    Math.abs(g.detail.get('RC').charged - g.summary.get('RC').charged) < 0.01,
    `${g.detail.get('RC').charged} vs ${g.summary.get('RC').charged}`);
  t('Grid1 allocations (continuation rows included) equal Grid2\'s paid',
    Math.abs(g.detail.get('RC').paid - g.summary.get('RC').paid) < 0.01,
    `${g.detail.get('RC').paid} vs ${g.summary.get('RC').paid}`);

  console.log(fails === 0 ? '\n✓ self-test passed' : `\n✗ ${fails} self-test failure(s)`);
  return fails === 0 ? 0 : 1;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());

  const file = argv.find(a => !a.startsWith('--'));
  const arg = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const tol = Number(arg('tol') || 0.01);
  if (!file) {
    console.error(`usage: node scripts/reconcileChargeDetail.js <report-summary.txt|csv> --scope "<entity or property>"

Save (or copy) the Report Summary page of RM's ChargeDetail report — the one listing
each charge type with Amount Charged / Amount Paid / Balance. The script re-runs the
same window out of RM for the scope you name, once per tenant scope, and shows which
one reproduces the export. --selftest proves the parser and the comparison offline.`);
    process.exit(2);
  }

  const parsed = parseSummary(fs.readFileSync(file, 'utf8'));
  parsed.warnings.forEach(w => console.log(`⚠ ${w}`));
  if (!parsed.rows.length) {
    console.error('No charge-type rows found. The page needs the summary table with Amount Charged / Amount Paid columns.');
    process.exit(2);
  }
  if (!parsed.range) {
    console.error('No "Date Range: mm/dd/yyyy - mm/dd/yyyy" line found — that is the window to re-run, so it cannot be guessed.');
    process.exit(2);
  }

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const rm = require('../services/rentManagerClient');
  const { buildPropertyEntityMap } = require('../services/entityMap');
  const { parseAmount } = require('../services/rmAmount');

  const want = arg('scope') || parsed.scopeName;
  const { byId, entities } = await buildPropertyEntityMap(rm);
  let ids = entities[want];
  let scopeLabel = `entity ${want}`;
  if (!ids) {
    const hits = [...byId.entries()].filter(([id, m]) => String(id) === want || m.name.toLowerCase().includes(String(want).toLowerCase()));
    if (!hits.length) { console.error(`No entity or property matched "${want}".`); process.exit(2); }
    ids = hits.map(([id]) => id);
    scopeLabel = hits.length === 1 ? `property ${hits[0][1].name}` : `${hits.length} properties matching "${want}"`;
  }

  const iso = d => { const [m, dd, y] = d.split('/'); return `${y}-${m.padStart(2, '0')}-${dd.padStart(2, '0')}`; };
  const start = iso(parsed.range.start), end = iso(parsed.range.end);

  console.log(`\nExport : ${parsed.scopeName || '(no property line)'} · ${parsed.range.start} – ${parsed.range.end} · ${parsed.rows.length} charge types`);
  console.log(`Ours   : ${scopeLabel} · ${ids.length} propert${ids.length === 1 ? 'y' : 'ies'} · re-running RM report 30 over the same window`);

  const SCOPES = [
    { status: 2, name: 'CustomerStatus 2 — current + notice (what the tab passes)' },
    { status: 3, name: 'CustomerStatus 3 — current + notice + former' },
  ];
  const results = [];
  for (const s of SCOPES) {
    const got = await runFor(rm, ids, start, end, s.status, parseAmount);
    const rows = compare(parsed.rows, got.summary, tol);
    const offCount = printComparison(`${s.name}  ·  Grid2 rows ${got.grid2Rows}, Grid1 rows ${got.grid1Rows}`, rows, tol);
    results.push({ ...s, got, rows, offCount });

    // Grid1 vs Grid2 — the identity the cohort maths depends on.
    let worst = 0, worstType = '';
    for (const [type, d] of got.detail) {
      const g2 = got.summary.get(type);
      if (!g2) continue;
      const diff = Math.abs(d.charged - g2.charged);
      if (diff > worst) { worst = diff; worstType = type; }
    }
    console.log(`  ${worst <= tol ? '✓' : '✗'} Grid1 (deduped by ChargeID) === Grid2 charged${worst > tol ? ` — worst ${fmt(worst)} on ${worstType}` : ''}`);
  }

  const excludedTotal = parsed.rows.filter(r => EXCLUDED.includes(r.type)).reduce((s, r) => s + r.charged, 0);
  if (excludedTotal) {
    console.log(`\nThe export includes ${fmt(excludedTotal)} of TAX / LD charges, which the tab excludes from the`);
    console.log('percentage on purpose (2026-07-22 meeting). That much of any total difference is by design.');
  }

  const best = results.slice().sort((a, b) => a.offCount - b.offCount)[0];
  console.log(`\nClosest match: ${best.name} (${best.offCount} charge type(s) still off).`);
  if (best.status !== 2 && best.offCount < (results.find(r => r.status === 2) || {}).offCount) {
    console.log('The export was run over a WIDER tenant scope than the tab uses. A tenant who moved out');
    console.log('inside the window is former, so their charges are in the export and not in the tab —');
    console.log('that is the gap. Decide which population the % should measure before changing anything.');
  }
  process.exit(best.offCount === 0 ? 0 : 1);
}

if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { parseSummary, foldGrids, compare, parseNum };
