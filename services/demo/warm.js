// Demo boot warm-up: the caches the real site fills with a button press (or a weekly
// schedule) are built once at start-up so every tab has data the first time it opens.
//
//   P&L snapshot  → (already started by server.js warmCaches)
//   renovations   → built after the P&L (it shortlists properties from it)
//   budget set    → data/budget/ + the T12 seed (data/t12-budget-seed.json)
//
// All of it is generated from the fake books in services/demo/financials.js, and all of it
// is skipped when the file is already on disk. Failures are logged, never thrown.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const log = (...a) => console.log('[demo warm]', ...a);

async function warm() {
  const propertyFinancials = require('../propertyFinancials');
  const renovationExpenses = require('../renovationExpenses');
  const budgetStore = require('../budgetStore');

  // 1. the P&L snapshot everything else reads
  try { if (!propertyFinancials.loadSnapshot()) await propertyFinancials.startBuild(); }
  catch (err) { log('P&L build failed:', err.message); return; }

  const jobs = [];

  // 2. renovation / major-repair charges
  jobs.push((async () => {
    try {
      if (!renovationExpenses.status().cache) { await renovationExpenses.refresh({ force: true }); log('renovations built'); }
    } catch (err) { log('renovations failed:', err.message); }
    // the invoice-coverage sweep reads the renovation snapshot and the fake bills
    try {
      const backupCoverage = require('../backupCoverage');
      if (!backupCoverage.status().cache) { await backupCoverage.refresh({ force: true }); log('backup coverage built'); }
    } catch (err) { log('backup coverage failed:', err.message); }
  })());

  // 2b. duplicate-payment scan over the last six months of postings
  jobs.push((async () => {
    try {
      const duplicatePayments = require('../duplicatePayments');
      if (!duplicatePayments.status().cache) { await duplicatePayments.refresh({ force: true }); log('duplicate payments built'); }
    } catch (err) { log('duplicate payments failed:', err.message); }
  })());

  // 3. T12 seed (ending the last closed month), then the budget set that reads the P&L
  jobs.push((async () => {
    try {
      if (!fs.existsSync(path.join(ROOT, 'data', 't12-budget-seed.json'))) {
        await new Promise((resolve, reject) => execFile(process.execPath, [path.join(ROOT, 'budget', 'pullT12.js')],
          { env: { ...process.env, DEMO_MODE: '1' }, timeout: 120000 }, err => (err ? reject(err) : resolve())));
        log('T12 seed written');
      }
    } catch (err) { log('T12 seed failed:', err.message); }
    try {
      if (!budgetStore.loadSet()) { await budgetStore.startBuild(); log('budget set built'); }
    } catch (err) { log('budget build failed:', err.message); }
  })());

  await Promise.all(jobs);
}

module.exports = { warm };
