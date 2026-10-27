// Official boot for the Demo Portfolio demo: `npm start` / `npm run dev`.
//
// Forces DEMO_MODE=1 (every Rent Manager call is answered by the fake world in
// services/demo), blanks any RENTMANAGER_* credentials that happen to be in the
// environment or a .env file so nothing can ever reach a real system, then loads
// server.js and listens.
//
//   PORT=3001 node scripts/demoServer.js      (PORT defaults to 3001)

process.env.DEMO_MODE = '1';
// Set to '' (not deleted): dotenv never overrides a variable that is already defined.
for (const k of ['RENTMANAGER_COMPANY', 'RENTMANAGER_USERNAME', 'RENTMANAGER_PASSWORD', 'RENTMANAGER_LOCATION_ID',
  'DASHBOARD_ACCESS_PIN', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'WORKER_SHARED_KEY']) {
  process.env[k] = '';
}
process.env.PORT = process.env.PORT || '3001';
// The pacing between Rent Manager calls exists to be polite to a real API; the fake one needs none.
for (const k of ['BACKUP_SWEEP_PACE_MS', 'PAYMENT_SWEEP_PACE_MS', 'RM_INVENTORY_PACE_MS']) process.env[k] = process.env[k] || '0';

const path = require('path');
const app = require(path.join(__dirname, '..', 'server.js'));
const PORT = Number(process.env.PORT);

// server.js only listens when run directly, so listen here (and run its startup chores).
// Optional access PIN (DEMO_ACCESS_PIN on the host); unset means open. See demoGate.js.
const express = require('express');
const outer = express();
outer.set('trust proxy', 1);
outer.use(require('./demoGate').makeGate(process.env.DEMO_ACCESS_PIN || ''));
outer.use(app);
const server = outer.listen(PORT, app.onDemoListening);
server.on('error', err => { console.error(err.message); process.exit(1); });
