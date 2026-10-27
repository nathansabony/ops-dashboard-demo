#!/usr/bin/env node
// Build step for the host (see render.yaml): start the demo in-process, let it build every
// snapshot (P&L, renovations, budget set, delinquency, issues, ...) from the fake world, then
// exit. The files land in data/ and ship with the deploy, so the first visitor does not wait
// for a small free machine to compute them. Never fails the build: the site rebuilds anything
// missing on its own at start-up.
process.env.DEMO_MODE = '1';
for (const k of ['RENTMANAGER_COMPANY', 'RENTMANAGER_USERNAME', 'RENTMANAGER_PASSWORD', 'DASHBOARD_ACCESS_PIN']) process.env[k] = '';
for (const k of ['BACKUP_SWEEP_PACE_MS', 'PAYMENT_SWEEP_PACE_MS', 'RM_INVENTORY_PACE_MS']) process.env[k] = '0';

const fs = require('fs');
const path = require('path');
const http = require('http');
const app = require(path.join(__dirname, '..', 'server.js'));
const data = p => path.join(__dirname, '..', 'data', p);

const server = app.listen(0, () => {
  app.onDemoListening();
  const port = server.address().port;
  const hit = p => new Promise(res => http.get({ port, path: p }, r => { r.resume(); r.on('end', res); }).on('error', res));
  const want = ['property-pl-cache.json', 'renovation-expenses-cache.json', 'backup-coverage-cache.json',
    'duplicate-payments-cache.json', 't12-budget-seed.json', 'budget/budget-set.json'];
  const started = Date.now();
  (async function loop() {
    // These routes build their snapshot the first time they are asked.
    for (const p of ['/api/live-overview', '/api/delinquency', '/api/delinquency/collections', '/api/delinquency/cohorts',
      '/api/issues', '/api/issues/backlog', '/api/supers', '/api/financials/property-monthly', '/api/debt-service',
      '/api/budget', '/api/underwriting/deals']) await hit(p);
    const missing = want.filter(f => !fs.existsSync(data(f)));
    if (!missing.length || Date.now() - started > 8 * 60 * 1000) {
      console.log(missing.length ? `[build] gave up waiting for: ${missing.join(', ')}` : '[build] demo caches built');
      process.exit(0);
    }
    setTimeout(loop, 3000);
  })();
});
