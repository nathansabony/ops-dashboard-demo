// Pull a trailing-12-months P&L by ENTITY by category from Rent Manager
// (Report 45 · ProfitLossRecapMonth · accrual) and write a seed JSON that the
// budget-model generator consumes.
//
//   node budget/pullT12.js                    # T12 ending last closed month
//   node budget/pullT12.js 2025-07 2026-06    # explicit YYYY-MM range (inclusive)
//
// Requires .env at repo root with RENTMANAGER_COMPANY / USERNAME / PASSWORD.
// dotenv MUST load before requiring the services (rentManagerClient reads creds
// from process.env at require-time).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const pf = require('../services/propertyFinancials');
const rm = require('../services/rentManagerClient');

// Budget-model line  ->  Rent Manager category key(s) from propertyFinancials.
// Notes: utilities = heating gas + water/sewer subtotal + electric (do NOT add the
// 5402 children — double-count). rm = repairs&maintenance + turnover. "other" is
// the residual so the lines always sum to total operating expense (NOI ties).
const LINES = {
  income:    e => e.totalIncome,                                  // accrual operating income (billed)
  propTax:   e => e.propTax,
  insurance: e => e.insurance,
  utilities: e => addKeys(e, ['heatingGas', 'waterSewer', 'electric']),
  payroll:   e => e.payroll,
  rm:        e => addKeys(e, ['repairsMaint', 'turnover']),
  mgmt:      e => e.mgmtFees,
};
const NAMED = ['propTax', 'insurance', 'utilities', 'payroll', 'rm', 'mgmt'];

function addKeys(e, keys) {
  const n = (e.totalIncome || []).length;
  const out = new Array(n).fill(0);
  for (const k of keys) { const a = e[k]; if (Array.isArray(a)) for (let i = 0; i < n; i++) out[i] += a[i] || 0; }
  return out;
}
const round2 = a => (Array.isArray(a) ? a.map(x => Math.round((x || 0) * 100) / 100) : []);
const ym = (y, m0) => `${y}-${String(m0 + 1).padStart(2, '0')}`;

function defaultRange() {
  const now = new Date();
  let toY = now.getFullYear(), toM = now.getMonth() - 1;   // last CLOSED month (skip partial current)
  if (toM < 0) { toM = 11; toY--; }
  let fromM = toM - 11, fromY = toY;
  while (fromM < 0) { fromM += 12; fromY--; }
  return { fromYM: ym(fromY, fromM), toYM: ym(toY, toM) };
}

(async () => {
  if (!rm.isConfigured || !rm.isConfigured()) {
    console.error('Rent Manager is not configured. Fill RENTMANAGER_COMPANY/USERNAME/PASSWORD in .env first.');
    process.exit(2);
  }
  const range = (process.argv[2] && process.argv[3])
    ? { fromYM: process.argv[2], toYM: process.argv[3] }
    : defaultRange();

  console.log(`Pulling T12 by entity from Rent Manager: ${range.fromYM} -> ${range.toYM} (accrual, Report 45)`);
  console.log('This runs ~1 report per property per calendar-year chunk (~150-180 calls); ~1-2 min...');

  const payload = await pf.pullPortfolioMonthly(range.fromYM, range.toYM, {
    onProgress: p => { const s = typeof p === 'string' ? p : JSON.stringify(p); process.stdout.write(`\r  ${s}`.slice(0, 100).padEnd(80)); },
  });
  process.stdout.write('\n');

  const months = payload.months || [];
  const n = months.length;
  const entities = {};
  for (const [name, e] of Object.entries(payload.entities || {})) {
    if (!e) continue;
    const line = {};
    for (const [k, fn] of Object.entries(LINES)) line[k] = round2(fn(e));
    const named = new Array(n).fill(0);
    for (const k of NAMED) for (let i = 0; i < n; i++) named[i] += (line[k][i] || 0);
    const te = round2(e.totalExpense);
    line.other = te.map((v, i) => Math.round((v - named[i]) * 100) / 100);   // residual -> ties to total OpEx
    entities[name] = line;
  }

  const out = {
    meta: {
      source: 'Rent Manager · Report 45 ProfitLossRecapMonth · Basis=Accrual',
      note: 'income = accrual operating income (billed), NOT cash-collected. Lines sum to total operating expense so NOI ties to the RM feed.',
      range, months,
      refreshedAt: payload.refreshedAt || null,
      asOfMonth: payload.asOfMonth || null,
      partialCurrentMonth: !!payload.partialCurrentMonth,
      entityCount: Object.keys(entities).length,
    },
    entities,
  };
  const outPath = path.join(__dirname, '..', 'data', 't12-budget-seed.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`  ${out.meta.entityCount} entities x ${n} months (${months[0]} .. ${months[n - 1]})`);
  console.log('Next: node buildModels.js  (regenerates every entity workbook off these real numbers)');
})().catch(e => { console.error('\nPull failed:', e && e.message ? e.message : e); process.exit(1); });
