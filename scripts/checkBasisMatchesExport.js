// Does the Variance tab's pull match a P&L someone exported from Rent Manager?
//
//   node scripts/checkBasisMatchesExport.js <PropertyID> <export.xlsx>
//
// <export.xlsx> is Rent Manager's "Profit & Loss 12 Month Recap" exported to
// Excel (accrual, collapse parents OFF). Every account row in it is compared,
// month by month, with Report 45 as this site pulls it (same basis code, same
// parse). Prints the accounts that differ; exits 1 if any do.
//
// Written 2026-10-06 after the owner's export for 2301 Willow Creek Rd showed the site
// had been pulling Basis=2, which is CASH: 15 of 101 accounts matched. With
// Basis=1 (accrual) all 101 match in all 12 months.
//
// Reads the export with python3/openpyxl (already a dependency of the
// underwriting tools) so this script needs no new npm package.
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pf = require('../services/propertyFinancials');

const [pid, file] = process.argv.slice(2);
if (!pid || !file) {
  console.error('Usage: node scripts/checkBasisMatchesExport.js <PropertyID> <12-month-recap.xlsx>');
  process.exit(2);
}

const PY = `
import json, sys, openpyxl
ws = openpyxl.load_workbook(sys.argv[1], data_only=True).active
hdr = None; out = {}
for r in ws.iter_rows(values_only=True):
    if hdr is None:
        if any(isinstance(v, str) and len(v) == 6 and v[:3].isalpha() and v[3:].strip().isdigit() for v in r[1:4]):
            hdr = [str(v or '').strip() for v in r]
        continue
    name = str(r[0] or '').strip()
    vals = r[1:len(hdr)]
    if name and any(isinstance(v, (int, float)) for v in vals):
        out[name] = {hdr[i + 1]: float(v or 0) for i, v in enumerate(vals) if hdr[i + 1] and hdr[i + 1] != 'TOTAL'}
print(json.dumps({"months": [h for h in hdr[1:] if h and h != 'TOTAL'] if hdr else [], "rows": out}))
`;

(async () => {
  const exp = JSON.parse(execFileSync('python3', ['-c', PY, file], { encoding: 'utf8' }));
  if (!exp.months.length) throw new Error('No month header row (e.g. "OCT 25") found in the export.');
  // "OCT 25" -> RM column key "OCT2025"
  const colKeys = exp.months.map(m => m.replace(/\s+/, '').replace(/(\d{2})$/, '20$1').toUpperCase());
  const first = colKeys[0], last = colKeys[colKeys.length - 1];
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const ym = k => `${k.slice(3)}-${String(MON.indexOf(k.slice(0, 3)) + 1).padStart(2, '0')}`;
  const [ly, lm] = ym(last).split('-').map(Number);
  const rows = await pf.runReport45(pid, `${ym(first)}-01`, `${ym(last)}-${String(new Date(ly, lm, 0).getDate()).padStart(2, '0')}`);

  const site = {};
  for (const r of rows) {
    if (String(r.IsHeader) === 'true' || r.IsHeader === true || String(r.IsTotal) === 'true' || r.IsTotal === true
        || r.IsHeader === 'True' || r.IsTotal === 'True') continue;
    site[String(r.GLAccountName || '').trim()] = r;
  }
  let same = 0;
  const bad = [];
  for (const [name, byMonth] of Object.entries(exp.rows)) {
    const r = site[name] || {};
    const off = colKeys.filter((k, i) => {
      const a = byMonth[exp.months[i]] || 0;
      const b = Number(r[k] || 0);
      // Income rows come back credit-signed from the API; the export shows them positive.
      return Math.abs(a - b) > 0.005 && Math.abs(a + b) > 0.005;
    });
    if (off.length) bad.push(`${name}: ${off.length} month(s) differ (${off.slice(0, 3).join(', ')}…)`);
    else same++;
  }
  console.log(`Report 45, Basis=${pf.BASIS_ACCRUAL}, property ${pid}, ${exp.months[0]} – ${exp.months[exp.months.length - 1]}`);
  console.log(`${same}/${same + bad.length} accounts match the export in every month.`);
  bad.forEach(b => console.log('  ✗ ' + b));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
