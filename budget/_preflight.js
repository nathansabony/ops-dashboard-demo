// Quick Rent Manager auth check — validates creds before the long pull.
// Prints only success/failure, never secret values.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const rm = require('../services/rentManagerClient');
if (!rm.isConfigured()) { console.error('NOT CONFIGURED — RENTMANAGER_COMPANY/USERNAME/PASSWORD missing in .env'); process.exit(2); }
rm.authenticate()
  .then(t => { console.log(`AUTH OK — company reachable, token issued (${(t || '').length} chars)`); process.exit(0); })
  .catch(e => { console.error('AUTH FAILED:', e.message); process.exit(1); });
