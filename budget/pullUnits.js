// Pull real per-ENTITY unit counts from Rent Manager (for the $/unit benchmark
// column in the budget models). Writes data/entity-units.json.
//   node budget/pullUnits.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const rm = require('../services/rentManagerClient');
const { buildPropertyEntityMap } = require('../services/entityMap');

const asList = p => Array.isArray(p) ? p : (p && (p.Results || p.Items || p.Data)) || [];
async function loadAllPages(fetchPage, base = {}, pageSize = 1000, maxPages = 200) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const pageRows = asList(await fetchPage({ ...base, pagesize: pageSize, pagenumber: page }));
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }
  return rows;
}

(async () => {
  if (!rm.isConfigured()) { console.error('Rent Manager not configured.'); process.exit(2); }
  const map = await buildPropertyEntityMap(rm);
  const units = await loadAllPages(p => rm.Units(p));
  const counts = {}; let mapped = 0, unmapped = 0;
  for (const u of units) {
    const pid = Number(u.PropertyID ?? u.PropertyId ?? u.propertyID ?? (u.Property && u.Property.PropertyID));
    const meta = map.byId.get(pid);
    if (!meta) { unmapped++; continue; }
    counts[meta.entity] = (counts[meta.entity] || 0) + 1; mapped++;
  }
  const outPath = path.join(__dirname, '..', 'data', 'entity-units.json');
  fs.writeFileSync(outPath, JSON.stringify(counts, null, 2));
  console.log(`Units total ${units.length} · mapped ${mapped} · unmapped ${unmapped}`);
  console.log('Per entity:', JSON.stringify(counts, null, 0));
  console.log('Wrote', outPath);
})().catch(e => { console.error('Units pull failed:', e.message); process.exit(1); });
