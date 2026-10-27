// Prunes the static ISSUES_DATA blob in public/index.html down to issues opened
// in the last KEEP_DAYS days (rolling window). Older work orders only exist in
// that embedded blob — the live refresh from the Worker keeps streaming in new
// ones — so pruning here is what actually shrinks the Issues tab and the page
// payload. Rerun it every month or two to keep the window rolling.
//
// Usage: node scripts/pruneOldIssues.js [days]   (default 90)
// Safe to rerun; keeps rows whose opened date fails to parse rather than dropping them.

const fs = require('fs');
const path = require('path');

const IDX = { id: 0, opened: 1, status: 2, issue: 3, property: 4, entity: 5, unit: 6, category: 7, priority: 8, assigned: 9, resolved: 10 };

const FILTER_FIELDS = {
  statuses: IDX.status,
  categories: IDX.category,
  entities: IDX.entity,
  properties: IDX.property,
  priorities: IDX.priority,
  assignees: IDX.assigned,
};

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const match = html.match(/const ISSUES_DATA = (\{.*\});/);
if (!match) {
  console.error('FAIL: could not find the ISSUES_DATA assignment in public/index.html');
  process.exit(1);
}

const data = JSON.parse(match[1]);
const before = data.issues.length;
const KEEP_DAYS = Number(process.argv[2]) || 90;
const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;

function openedTime(issue) {
  // Dates are "MM/DD/YY" strings.
  const parts = String(issue[IDX.opened] || '').split('/');
  if (parts.length !== 3) return null;
  const [mm, dd, yy] = parts.map(Number);
  if (![mm, dd, yy].every(Number.isFinite)) return null;
  return new Date(2000 + yy, mm - 1, dd).getTime();
}

data.issues = data.issues.filter(issue => {
  const opened = openedTime(issue);
  return opened === null || opened >= cutoff;
});

Object.entries(FILTER_FIELDS).forEach(([key, fieldIdx]) => {
  if (!data.filters || !(key in data.filters)) return;
  data.filters[key] = [...new Set(data.issues.map(i => i[fieldIdx]).filter(Boolean))].sort();
});

const replacement = `const ISSUES_DATA = ${JSON.stringify(data)};`;
const updated = html.replace(match[0], replacement);
fs.writeFileSync(htmlPath, updated);

const savedKb = ((match[0].length - replacement.length) / 1024).toFixed(0);
console.log(`Pruned ISSUES_DATA to the last ${KEEP_DAYS} days: ${before} -> ${data.issues.length} issues (${savedKb} KB smaller).`);
