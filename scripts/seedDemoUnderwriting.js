#!/usr/bin/env node
// Builds the demo's showcase deal through the REAL server code (2026-10): boots the demo server on a spare port, POSTs the reviewed
// deal that scripts/buildDemoUnderwriting.py wrote (underwriting/sample/riverbend-deal.json) to /api/underwriting/generate - the same
// call the tab makes - so the model is filled by generator.py, calculated and baked by finish_model.py, scored, and its PDF report
// built, exactly as for a deal a person ran. Then the pair is renamed to a fixed stamp (so the tracked files do not change name
// every time this is re-run) and the sidecar data/underwriting/deals.json is rewritten to match.
//
//   python3 scripts/buildDemoUnderwriting.py && node scripts/seedDemoUnderwriting.js
//
// It REPLACES whatever is in data/underwriting/ (models, PDFs, deals.json): the demo ships exactly one deal.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'underwriting');
const STAMP = '2026-10-20-14-32-08';                      // the run date the board shows for the showcase deal
const FINAL = `Riverbend-Apartments-${STAMP}.xlsx`;
const PORT = 5000 + Math.floor(Math.random() * 900) + 100;

async function waitFor(url, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 400));
  }
}

(async () => {
  const deal = JSON.parse(fs.readFileSync(path.join(ROOT, 'underwriting', 'sample', 'riverbend-deal.json'), 'utf8'));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'demoServer.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
  try {
    const base = `http://127.0.0.1:${PORT}`;
    await waitFor(`${base}/api/underwriting/sample`, 60000);
    const provenance = {
      sources: [
        { kind: 'rent_roll', filename: 'Riverbend Apartments - Rent Roll.xlsx', method: 'deterministic (openpyxl)', warnings: 0, notes: ['Parsed 96 units; the report says 96.'] },
        { kind: 't12', filename: 'Riverbend Apartments - T12.xlsx', method: 'deterministic (openpyxl)', warnings: 0, notes: ['EGI - OpEx ties to the statement\'s NOI.'] },
        { kind: 'om', filename: 'Riverbend Apartments - Offering Memorandum.pdf', method: 'read by Claude', pages: 14 },
      ],
      confirmed_by_hand: 2,
      confirmed_fields: ['Hold period (yrs, 1-8 — sets the sale year) (edited)', 'Exit cap rate % (edited)'],
    };
    const r = await fetch(`${base}/api/underwriting/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deal, provenance }) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error('generate failed: ' + (j.error || r.status));
    console.log('generated', j.file, '| recalc engine:', j.engine, '| baked cells:', j.bakedCells, '| report built:', j.reportBuilt, '| review:', JSON.stringify(j.review));
    // the board read once, so the card cache is written, before the server stops
    const deals = await (await fetch(`${base}/api/underwriting/deals`)).json();
    const p = deals.properties[0];
    console.log('card:', p.name, 'score', p.latest.card.deal_score.score, p.latest.card.deal_score.grade, 'IRR', p.latest.card.irr);
    srv.kill();
    await new Promise(r2 => setTimeout(r2, 800));

    const was = j.file;
    fs.renameSync(path.join(OUT, was), path.join(OUT, FINAL));
    fs.renameSync(path.join(OUT, was.replace(/\.xlsx$/, '.pdf')), path.join(OUT, FINAL.replace(/\.xlsx$/, '.pdf')));
    const metaFile = path.join(OUT, 'deals.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.models[FINAL] = meta.models[was];
    delete meta.models[was];
    meta.models[FINAL].mtime = fs.statSync(path.join(OUT, FINAL)).mtimeMs;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
    for (const f of fs.readdirSync(OUT)) if (/\.(tmp|building|story)$|usage\.jsonl$/.test(f)) fs.rmSync(path.join(OUT, f), { force: true });
    // The PDF was built under the generator's stamp ("model run Oct 27"); rebuild it under the final name so its run date matches the card.
    const srv2 = spawn(process.execPath, [path.join(ROOT, 'scripts', 'demoServer.js')], { env: { ...process.env, PORT: String(PORT + 1) }, stdio: 'ignore' });
    try {
      const base2 = `http://127.0.0.1:${PORT + 1}`;
      await waitFor(`${base2}/api/underwriting/sample`, 60000);
      await fetch(`${base2}/api/underwriting/reports/backfill`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) });
      for (let i = 0; i < 120; i++) { const st = await (await fetch(`${base2}/api/underwriting/reports/status`)).json(); if (!st.running && st.finishedAt) { if (st.failed.length) throw new Error('report failed: ' + JSON.stringify(st.failed)); break; } await new Promise(r3 => setTimeout(r3, 1000)); }
      await fetch(`${base2}/api/underwriting/deals`);
    } finally { srv2.kill(); await new Promise(r3 => setTimeout(r3, 800)); }
    for (const f of fs.readdirSync(OUT)) if (/\.(tmp|building|story)$|usage\.jsonl$/.test(f)) fs.rmSync(path.join(OUT, f), { force: true });
    console.log('wrote', fs.readdirSync(OUT).join(', '));
  } catch (e) {
    console.error(e.message, '\n--- server log ---\n' + log.slice(-2000));
    process.exitCode = 1;
  } finally {
    srv.kill();
  }
})();
