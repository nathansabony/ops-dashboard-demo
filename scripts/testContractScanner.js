#!/usr/bin/env node
// Run a folder of contract PDFs through the contract scanner and grade each
// against scripts/contractScannerAnswerKey.js.
//
//   node scripts/testContractScanner.js <pdf-folder> [out-folder]
//
// Calls the real Claude API (~$0.05–0.15 per contract). Writes each scanner
// JSON to out-folder (default: data/contract-scanner-test/) for inspection.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { analyzeContract } = require('../services/contractScanner');
const answerKey = require('./contractScannerAnswerKey');

const [dir, outArg] = process.argv.slice(2);
if (!dir) { console.error('usage: node scripts/testContractScanner.js <pdf-folder> [out-folder]'); process.exit(1); }
const outDir = outArg || path.join(__dirname, '..', 'data', 'contract-scanner-test');
fs.mkdirSync(outDir, { recursive: true });
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

(async () => {
  const files = fs.readdirSync(dir).filter(f => /\.pdf$/i.test(f)).sort();
  const results = await Promise.all(files.map(async f => {
    try {
      const r = await analyzeContract(apiKey, { pdfBase64: fs.readFileSync(path.join(dir, f)).toString('base64') });
      fs.writeFileSync(path.join(outDir, f.replace(/\.pdf$/i, '.json')), JSON.stringify(r.json ?? { raw: r.raw }, null, 2));
      return { f, r };
    } catch (e) { return { f, err: e.message }; }
  }));

  let pass = 0, total = 0;
  for (const { f, r, err } of results) {
    console.log(`\n=== ${f}`);
    if (err) { console.log(`  ERROR: ${err}`); continue; }
    console.log(`  ${r.ms}ms · stop=${r.stopReason} · in=${r.usage.input_tokens} out=${r.usage.output_tokens}`);
    if (!r.json) { console.log('  FAIL: reply was not valid JSON'); total++; continue; }
    const key = Object.keys(answerKey).find(k => f.includes(k));
    if (!key) { console.log('  (no answer key — output saved only)'); continue; }
    const all = JSON.stringify(r.json).toLowerCase();
    for (const [label, check] of answerKey[key]) {
      let ok = false;
      try { ok = !!check(r.json, all); } catch { ok = false; }
      total++; if (ok) pass++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    }
  }
  console.log(`\n${pass}/${total} checks passed. JSON in ${outDir}`);
  process.exit(pass === total ? 0 : 1);
})();
