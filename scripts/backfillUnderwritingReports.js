#!/usr/bin/env node
// Give every underwriting model on a disk its PDF report (2026-10-22).
//
//   npm run backfill:uw-reports                      models in data/underwriting (or $UNDERWRITING_DIR)
//   npm run backfill:uw-reports -- --dir <folder>    some other folder of models
//   npm run backfill:uw-reports -- --force           rebuild every report, even the current ones
//
// Safe to re-run: a model whose PDF is newer than the workbook and was built by the current
// report version is skipped. Nothing is ever deleted; a model that cannot be read is listed with
// the reason and the others carry on. Prints how many were built, how many were already current,
// and what failed.
//
// This is the same code the server runs by itself on Render a minute after boot (and when you
// press POST /api/underwriting/reports/backfill), because the models that matter live on Render's
// disk, not on a laptop. Run it here against a folder of local models.

const path = require('path');
const { execFile } = require('child_process');
const underwritingDeals = require('../services/underwritingDeals');
const underwritingReport = require('../services/underwritingReport');

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const dirIdx = args.indexOf('--dir');
const dir = path.resolve(dirIdx >= 0 ? args[dirIdx + 1] : (process.env.UNDERWRITING_DIR || path.join(__dirname, '..', 'data', 'underwriting')));
const PY = process.env.UNDERWRITING_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function runPython(script, a, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    execFile(PY, [path.join(__dirname, '..', 'underwriting', script), ...a], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${script} failed: ${String(stderr || err.message).split('\n').slice(-3).join(' ').trim()}`));
      const lines = String(stdout).trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!/^[{[]/.test(lines[i].trim())) continue;
        try { return resolve(JSON.parse(lines.slice(i).join('\n'))); } catch { /* keep looking */ }
      }
      reject(new Error(`${script} printed no readable result`));
    });
  });
}

(async () => {
  console.log(`Models folder: ${dir}${flag('--force') ? '  (--force: rebuilding every report)' : ''}`);
  // the sidecar (deals.json) supplies how each file was read, and records that a report was built
  const store = underwritingDeals.createStore({ dir, readCards: async () => ({}) });
  const reports = underwritingReport.createReports({
    dir, runPython,
    provenanceOf: f => store.provenanceOf(f), reportMeta: f => store.reportMeta(f), markReport: (f, m) => store.markReport(f, m),
  });
  const r = await reports.backfill({ force: flag('--force'), log: m => console.log('  ' + m) });
  console.log(`\n${r.total} model(s): ${r.generated.length} report(s) built, ${r.skipped.length} already current, ${r.failed.length} failed.`);
  r.failed.forEach(f => console.log(`  could not build ${f.file}: ${f.reason}`));
  process.exit(r.failed.length ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(2); });
