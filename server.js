// Backend for the Cedar Ridge Management site (demo build).
//
// Rent Manager (WAPI12) is the source of truth in a live install: when
// RENTMANAGER_COMPANY / RENTMANAGER_USERNAME / RENTMANAGER_PASSWORD are set, each
// /api/* route calls the corresponding rentManagerClient function and serves live
// data - several routes back it with a self-refreshing cache (live-overview snapshot,
// propertyFinancials, moveActivity, chargedCollections).
//
// DEMO_MODE=1 (what `npm start` sets, via scripts/demoServer.js): rentManagerClient
// answers every call from the fictional "Cedar Ridge" world in services/demo, the
// visitor is signed in automatically as an admin, and nothing leaves the machine.
//
// When neither is set (local dev without creds), routes fall back to mockData
// shaped like the RM response so the frontend still renders. A few legacy routes
// (/api/entities, /api/overview, /api/debt-service) still return mock and are no
// longer called by the current frontend.

const path    = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const userStore = require('./services/userStore');
const accessControl = require('./services/accessControl');
const mailer = require('./services/mailer');
const Anthropic = require('@anthropic-ai/sdk');
const assistant = require('./services/assistant');
const scorecardTargets = require('./services/scorecardTargets');
const marketNews = require('./services/marketNews');
const underwritingDeals = require('./services/underwritingDeals');
const underwritingReport = require('./services/underwritingReport');
const rentManager = require('./services/rentManagerClient');
const propertyFinancials = require('./services/propertyFinancials');
const propertyMerges = require('./services/propertyMerges');
const varianceConfig = require('./services/varianceConfig');
const varianceResolutions = require('./services/varianceResolutions');
const varianceFirstSeen = require('./services/varianceFirstSeen');
const entityActions = require('./services/entityActions');
const homeSnapshot = require('./services/homeSnapshot');
const varianceRuleOverrides = require('./services/varianceRuleOverrides');
const moveActivity = require('./services/moveActivity');
const duplicatePayments = require('./services/duplicatePayments');
const glTransactions = require('./services/glTransactions');
const varianceInvestigation = require('./services/varianceInvestigation');
const chargedCollections = require('./services/chargedCollections');
const delinquencyReport = require('./services/delinquencyReport');
const billingCohorts = require('./services/billingCohorts');
const budgetAssumptions = require('./services/budgetAssumptions');
const unitCounts = require('./services/unitCounts');
const budgetStore = require('./services/budgetStore');
const budgetModel = require('./services/budgetModel');
const budgetOverrides = require('./services/budgetOverrides');
const snapshotCache = require('./services/snapshotCache');
const issueCategories = require('./services/issueCategories');
const renovationExpenses = require('./services/renovationExpenses');
const backupCoverage = require('./services/backupCoverage');
const chargePacket = require('./services/chargePacket');
const rmInventory = require('./services/rmInventory');
const rmLeads = require('./services/rmLeads');
const varianceReconcile = require('./services/varianceReconcile');
const backupIndex = require('./services/backupIndex');
const { parseAmount } = require('./services/rmAmount');
const rmDocuments = require('./services/rmDocuments');
const attachmentProbe = require('./services/attachmentProbe');
const serviceManagerLookups = require('./services/serviceManagerLookups');
const { buildPropertyEntityMap } = require('./services/entityMap');
const propertySupers = require('./services/propertySupers');
const mockData = require('./mockData');

// Contract scanner prompt + call live in services/contractScanner.js.
const contractScanner = require('./services/contractScanner');

const app = express();
// The host terminates TLS at its proxy; trust the first hop so req.ip is the
// real client address (needed for per-IP login rate limiting).
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
// Hand-rolled rather than a helmet dependency, and deliberately compatible with
// how public/index.html is built today (large inline <script> blocks and inline
// onclick="..." handlers throughout) — a strict script-src CSP would break every
// button on the site. This still buys real protection:
//  - frame-ancestors/X-Frame-Options: the site can't be iframed elsewhere
//    (clickjacking), which also would have blocked outcomes of the tenant-name
//    onclick-attribute XSS bug fixed alongside this.
//  - object-src/base-uri 'none': closes off plugin-based and <base>-tag XSS tricks.
//  - X-Content-Type-Options: stops the browser from MIME-sniffing uploaded/served
//    files (e.g. an underwriting PDF) into executable content.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; " +
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https: data:; " +
    "img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self' https:;"
  );
  next();
});
const PORT = process.env.PORT || 3001;
const DEMO_MODE = process.env.DEMO_MODE === '1';
const TENANT_ACCESS_PIN = process.env.DASHBOARD_ACCESS_PIN || '';
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || TENANT_ACCESS_PIN || 'local-management-session-secret';
const SESSION_COOKIE = 'op_management_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
// No timer: serve the last pull until the refresh button is pressed. Set
// TENANT_INDEX_TTL_MS to a millisecond interval to bring periodic refresh back.
const TENANT_INDEX_TTL_MS = Number(process.env.TENANT_INDEX_TTL_MS || 0);
const TENANT_FIELD_LIST = [
  'TenantID',
  'Name',
  'FirstName',
  'LastName',
  'AccountNumber',
  'Status',
  'Email',
  'Phone',
  'PhoneNumber',
  'Balance',
  'CurrentBalance',
  'AmountOwed',
].join(',');

let staticPropertyEntityMap = null;
let tenantIndexCache = null;
let tenantIndexPromise = null;

// Single sign-on through an identity proxy is not part of the demo build, so the
// site is gated by its own user accounts only (see services/userStore.js).
function cfAccessEnabled() { return false; }
const DASHBOARD_PUBLIC_URL = process.env.DASHBOARD_PUBLIC_URL || '';

// 80mb: underwriting OM PDFs run 40-50MB and arrive base64-encoded (~65MB)
app.use(express.json({ limit: '80mb' }));

// ── Site-wide PIN gate ────────────────────────────────────────────────────────
// When DASHBOARD_ACCESS_PIN is set, everything (static files and APIs) requires
// a valid session. Browsers without one get a login page; API calls get a 401.
const AUTH_OPEN_PATHS = new Set(['/brand/logo', '/api/auth/login', '/api/auth/logout', '/api/auth/status', '/api/auth/forgot', '/api/auth/reset', '/reset', '/api/auth/signup', '/verify']);

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cedar Ridge Management — Sign In</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet">
<style>
  /* Forest Ledger — the same direction the app behind this gate uses. */
  body { margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center;
         justify-content:center; gap:30px; padding:48px 16px 72px; box-sizing:border-box;
         background:#10291F; font-family:'Inter',system-ui,sans-serif;
         -webkit-font-smoothing:antialiased; }
  /* the ground: a deep green with a low warm glow and a faint drafting grid that
     fades out toward the edges, so it reads as quiet texture, not a pattern */
  body::before { content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
         background:
           radial-gradient(55% 50% at 50% 46%, rgba(185,138,46,.11), transparent 70%),
           radial-gradient(120% 90% at 50% 50%, #17392D 0%, #10291F 60%, #0B1F17 100%); }
  body::after { content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
         background-image:
           linear-gradient(rgba(255,253,250,.035) 1px, transparent 1px),
           linear-gradient(90deg, rgba(255,253,250,.035) 1px, transparent 1px);
         background-size:56px 56px; background-position:center center;
         -webkit-mask-image:radial-gradient(60% 55% at 50% 48%, #000 0%, transparent 100%);
                 mask-image:radial-gradient(60% 55% at 50% 48%, #000 0%, transparent 100%); }
  body > * { position:relative; z-index:1; }
  /* the brand lockup above the card */
  .brand { text-align:center; color:#FFFDFA; user-select:none; }
  .brand img { display:block; margin:0 auto; height:80px; width:auto; max-width:340px; object-fit:contain;
               filter:brightness(0) invert(1); opacity:.94; }   /* a black logo shows white on green */
  .brand .mark { display:block; margin:0 auto 18px; width:42px; height:42px; }
  .brand .wm { font-size:30px; font-weight:500; letter-spacing:.38em; margin-right:-.38em; line-height:1; }
  .brand .rule { width:40px; height:1px; background:#B98A2E; margin:16px auto 14px; }
  .brand .sub { font-size:13px; font-weight:500; letter-spacing:.52em; margin-right:-.52em;
                color:rgba(255,253,250,.55); line-height:1; }
  .foot { position:fixed; left:0; right:0; bottom:20px; text-align:center; z-index:1;
          font-size:11px; letter-spacing:.06em; color:rgba(255,253,250,.32); }
  @media (max-height:640px) { .foot { position:static; } }
  /* a low city skyline along the bottom — dark towers, a few lit windows */
  .skyline { position:fixed; left:0; right:0; bottom:0; width:100%; height:32vh; max-height:300px;
             min-height:150px; z-index:0; pointer-events:none; }
  @media (max-width:420px) { .card { padding:32px 22px; } .brand .wm { font-size:24px; } .brand .sub { font-size:11px; } }
  @keyframes rise { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  .brand, .card { animation:rise .5s ease-out both; }
  .card { animation-delay:.06s; }
  @media (prefers-reduced-motion:reduce) { .brand, .card { animation:none; } }
  .card { position:relative; box-sizing:border-box; background:#FFFDFA; border-radius:8px; padding:40px 36px; width:412px;
          max-width:100%; text-align:center; border-top:3px solid #B98A2E;
          box-shadow:0 24px 60px rgba(0,0,0,.38); }
  h1 { font-family:'Fraunces',Georgia,serif; font-size:20px; font-weight:600; letter-spacing:-.015em;
       line-height:1.25; margin:0 0 7px; color:#14342A; }
  p  { font-size:13px; color:#7D766A; margin:0 0 24px; }
  input { width:100%; box-sizing:border-box; padding:12px 14px; font-size:16px; font-family:inherit;
          color:#14342A; background:#FFFDFA; border:1px solid #E6E1D6; border-radius:6px;
          margin-bottom:14px; text-align:center; letter-spacing:4px;
          font-variant-numeric:tabular-nums; transition:border-color .12s, box-shadow .12s; }
  input::placeholder { color:#9C9488; letter-spacing:1px; }
  input.txt { letter-spacing:normal; text-align:left; font-size:15px; }
  input:focus { outline:none; border-color:#14532D; box-shadow:0 0 0 3px rgba(20,83,45,.12); }
  button { width:100%; padding:12px; font-size:14px; font-weight:600; font-family:inherit;
           letter-spacing:.01em; color:#FFFDFA; background:#14532D;
           border:none; border-radius:6px; cursor:pointer; transition:background .12s; }
  button:hover { background:#0E3D21; }
  .err { color:#A32B2B; font-size:12.5px; font-weight:500; min-height:18px; margin-top:12px; }
</style>
</head>
<body>
__BRAND__
<div class="card">
  <h1>Portfolio Management</h1>
  <p id="sub">Sign in with your email and password</p>
  <form id="f">
    <input id="name" class="txt" type="text" autocomplete="name" placeholder="Your name" style="display:none">
    <input id="email" class="txt" type="email" autocomplete="username" placeholder="Email" autofocus>
    <input id="password" class="txt" type="password" autocomplete="current-password" placeholder="Password">
    <input id="password2" class="txt" type="password" autocomplete="new-password" placeholder="Password again" style="display:none">
    <input id="pin" type="password" autocomplete="off" placeholder="Site PIN" style="display:none">
    <button type="submit" id="go">Sign in</button>
    <div class="err" id="err"></div>
  </form>
  <div style="font-size:12.5px;margin-top:2px;"><a href="#" id="signuplink" style="color:#14532D;font-weight:600;">New here? Create an account</a></div>
  <a href="#" id="pinlink" style="display:none;font-size:12px;color:#14532D;margin-top:8px;">First-time setup: use the site PIN</a>
  <div id="forgotbox" style="font-size:11.5px;color:#9C9488;margin-top:14px;">Forgot your password? Ask an admin to reset it.</div>
</div>
<script>
// While no admin account exists yet, the old site PIN still opens the site (as an
// admin) so the first accounts can be created. It switches off by itself after.
const BOOTSTRAP = __BOOTSTRAP__;
const MAIL = __MAIL__;
// Create an account: name, email, a password they choose (their real one). New
// accounts have no tools until an admin gives them some.
let signupMode = false;
document.getElementById('signuplink').addEventListener('click', (e) => {
  e.preventDefault();
  signupMode = !signupMode;
  if (signupMode && pinMode) document.getElementById('pinlink').click();
  document.getElementById('name').style.display = signupMode ? '' : 'none';
  document.getElementById('password2').style.display = signupMode ? '' : 'none';
  document.getElementById('password').setAttribute('autocomplete', signupMode ? 'new-password' : 'current-password');
  document.getElementById('password').placeholder = signupMode ? 'Choose a password (${userStore.MIN_PASSWORD}+ characters, with a number)' : 'Password';
  document.getElementById('go').textContent = signupMode ? 'Create account' : 'Sign in';
  document.getElementById('sub').textContent = signupMode ? 'Create your account — an admin will then give you access' : 'Sign in with your email and password';
  document.getElementById('signuplink').textContent = signupMode ? 'Already have an account? Sign in' : 'New here? Create an account';
  document.getElementById('err').textContent = '';
});
// Forgot password — always offered. With email set up it sends a one-time reset
// link; without it, it says to ask an admin (who can reset it from the Admin tab).
{
  const fb = document.getElementById('forgotbox');
  fb.innerHTML = '<a href="#" id="forgotlink" style="color:#14532D;">Forgot your password?</a>';
  document.getElementById('forgotlink').addEventListener('click', async (e) => {
    e.preventDefault();
    if (!MAIL) { fb.textContent = 'Ask an admin to reset it — they can do it from the Admin tab, and you can then change it to your own.'; return; }
    const email = document.getElementById('email').value.trim();
    if (!email) { document.getElementById('err').textContent = 'Type your email above, then click "Forgot your password?" again.'; return; }
    const r = await fetch('/api/auth/forgot', { method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email }) });
    let j = {}; try { j = await r.json(); } catch {}
    fb.textContent = r.ok ? 'If there is an account for ' + email + ', a reset link is on its way. Check your inbox (and spam).' : (j.error || 'Could not send a reset link right now.');
  });
}
let pinMode = false;
if (BOOTSTRAP) document.getElementById('pinlink').style.display = 'inline-block';
document.getElementById('pinlink').addEventListener('click', (e) => {
  e.preventDefault();
  pinMode = !pinMode;
  document.getElementById('email').style.display = pinMode ? 'none' : '';
  document.getElementById('password').style.display = pinMode ? 'none' : '';
  document.getElementById('pin').style.display = pinMode ? '' : 'none';
  document.getElementById('sub').textContent = pinMode ? 'Enter the site PIN — then create the admin accounts' : 'Sign in with your email and password';
  document.getElementById('pinlink').textContent = pinMode ? 'Sign in with email instead' : 'First-time setup: use the site PIN';
});
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (signupMode) {
    if (document.getElementById('password').value !== document.getElementById('password2').value) {
      document.getElementById('err').textContent = 'The two passwords do not match.'; return;
    }
    const r = await fetch('/api/auth/signup', { method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ name: document.getElementById('name').value, email: document.getElementById('email').value, password: document.getElementById('password').value }) });
    if (r.ok) { window.location.reload(); return; }
    let j = {}; try { j = await r.json(); } catch {}
    document.getElementById('err').textContent = j.error || 'Could not create the account.';
    return;
  }
  const body = pinMode
    ? { pin: document.getElementById('pin').value }
    : { email: document.getElementById('email').value, password: document.getElementById('password').value };
  const resp = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
  if (resp.ok) { window.location.reload(); return; }
  let msg = pinMode ? 'Incorrect PIN — try again.' : 'Email or password is not right — try again.';
  try { const j = await resp.json(); if (resp.status === 429 && j.error) msg = j.error; } catch {}
  document.getElementById('err').textContent = msg;
});
</script>
__FOOT__
</body>
</html>`;

app.use(async (req, res, next) => {
  if (!tenantAccessEnabled()) { req.user = LOCAL_OPEN_USER; if (DEMO_MODE) req.accessUser = LOCAL_OPEN_USER.name; return next(); }   // local / demo, unlocked
  if (AUTH_OPEN_PATHS.has(req.path)) return next();
  const user = resolveUser(req);
  if (user) {
    req.user = user;
    req.accessUser = user.name || user.email || '';   // attribution on resolutions / rule edits
    // Per-person tool access (services/accessControl.js) — the server refuses data
    // for a tool the person does not have, whatever the browser shows.
    const verdict = accessControl.decide(user, req.method, req.path);
    if (verdict.ok) return next();
    noStore(res);
    return res.status(verdict.status).json({ code: verdict.code, error: verdict.reason });
  }

  noStore(res);
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ code: 'TENANT_AUTH_REQUIRED', error: 'Management site is locked.' });
  }
  res.status(401).type('html').send(loginPageHtml());
});

// The page itself, with the signed-in person's tools written in, so the tabs they
// do not have are never drawn and their data is never requested (the server would
// refuse it anyway — this just keeps the page quiet). Registered before the static
// handler so it wins for / and /index.html.
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
// A signed-in person with no tools yet (a fresh sign-up) gets this page instead of
// the site — the site's page carries built-in figures they have no business seeing.
function waitingPageHtml(u) {
  const head = LOGIN_PAGE_HTML.slice(0, LOGIN_PAGE_HTML.indexOf('<body>'));
  const esc = v => String(v || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return head + `<body><div class="card">
  <h1>You're signed up</h1>
  <p>Hi ${esc(u.name || u.email)} — your account is ready, but it does not have any tools yet. An admin will give you access to the ones you need; then just reload this page.</p>
  ${!u.emailVerified && mailer.configured() ? '<p style="font-size:12.5px;">We sent a confirmation link to <b>' + esc(u.email) + '</b> — please click it.</p>' : ''}
  <button onclick="location.reload()">Check again</button>
  <div style="margin-top:14px;font-size:12.5px;"><a href="#" id="out" style="color:#14532D;">Sign out</a></div>
</div>
<script>document.getElementById('out').addEventListener('click', async (e) => { e.preventDefault(); await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); location.reload(); });</script>
</body></html>`;
}
app.get(['/', '/index.html'], (req, res, next) => {
  if (req.user && !req.user.admin && !(req.user.tools || []).length) { noStore(res); return res.type('html').send(waitingPageHtml(req.user)); }
  let html;
  try { html = fs.readFileSync(INDEX_FILE, 'utf8'); } catch { return next(); }
  const u = req.user || (tenantAccessEnabled() ? null : LOCAL_OPEN_USER);
  const who = u ? { email: u.email || '', name: u.name || '', admin: !!u.admin, tools: u.tools || userStore.TOOL_KEYS,
    bootstrap: !!u.bootstrap, toolList: userStore.TOOLS, demo: DEMO_MODE }
    : { email: req.accessUser || '', name: '', admin: true, tools: userStore.TOOL_KEYS, toolList: userStore.TOOLS };
  const tag = `<script>window.__OP_USER=${JSON.stringify(who).replace(/</g, '\\u003c')};</script>`;
  noStore(res);
  res.type('html').send(html.replace('<head>', '<head>' + tag));
});

// Serve only the management-site frontend (public/). Never serve the parent project
// directory — it contains spreadsheets and legacy files that must not be
// reachable from a browser.
app.use(express.static(path.join(__dirname, 'public')));

// Simple request log so it's obvious which routes the frontend is actually calling.
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

function noStore(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function publicErrorMessage(err) {
  const message = String(err && err.message ? err.message : err || 'Unknown error');
  if (/already logged in maximum number of times/i.test(message)) {
    return 'Rent Manager rejected the API login because this user is already logged in the maximum number of times. End old sessions, reset the API user password, or wait for old API sessions to expire.';
  }
  return message
    .replace(/https:\/\/[^\s"]+/g, '[redacted-url]')
    .replace(/[A-Za-z0-9+/=_-]{30,}/g, '[redacted]');
}

async function optionalLiveRequest(promise, fallback, label) {
  try {
    return await promise;
  } catch (err) {
    if (/auth failed|maximum number of times|401/i.test(String(err && err.message ? err.message : err))) {
      throw err;
    }
    console.warn(`Live overview skipped ${label}:`, publicErrorMessage(err));
    return fallback;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map(part => {
    const [key, ...rest] = part.trim().split('=');
    let value = rest.join('=');
    try { value = decodeURIComponent(value); } catch {}
    return [key, value];
  }).filter(([key]) => key));
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if ((payload.scope !== 'tenant-data' && payload.scope !== 'user') || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function setSessionCookie(res, payload) {
  const token = signSession({ ...(payload || { scope: 'tenant-data' }), exp: Date.now() + SESSION_TTL_MS });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// The site is locked whenever there is a PIN or any user account. (Locally, with
// neither, it stays open for development — every tool, as an admin.)
// A pull-request preview is a public address: it is always
// locked, even if the PIN setting did not carry over (then set
// DASHBOARD_ACCESS_PIN on the preview to do the first-time setup).
function tenantAccessEnabled() {
  if (DEMO_MODE) return false;   // demo: no sign-in, everyone is the demo admin (LOCAL_OPEN_USER)
  return Boolean(TENANT_ACCESS_PIN) || userStore.count() > 0 || process.env.IS_PULL_REQUEST === 'true';
}
const LOCAL_OPEN_USER = DEMO_MODE
  ? { id: 'demo-admin', email: 'demo@cedarridge.example', name: 'Demo Admin', admin: true, tools: userStore.TOOL_KEYS }
  : { email: '', name: 'local', admin: true, tools: userStore.TOOL_KEYS };

// The PIN only opens the site while no admin account exists — it is how the first
// admin gets in to create accounts. Once there is an admin it stops working, so the
// shared PIN (which people also use elsewhere) cannot be a way around per-person
// access.
function pinLoginAllowed() {
  return Boolean(TENANT_ACCESS_PIN) && !userStore.hasAdmin();
}

// Who is this request? A person's session is checked against the store on every
// request: a disabled account, a reset password (sv bump) or changed tools take
// effect immediately.
function resolveUser(req) {
  const session = verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (!session) return null;
  if (session.scope === 'user') {
    const u = userStore.getById(session.uid);
    if (!u || u.disabled || (u.sv || 1) !== session.sv) return null;
    return userStore.publicUser(u);
  }
  // Legacy PIN session: only while bootstrapping, and then as an admin.
  if (session.scope === 'tenant-data' && pinLoginAllowed()) {
    return { id: 'pin', email: '', name: 'Site PIN (setup)', admin: true, tools: userStore.TOOL_KEYS, bootstrap: true };
  }
  return null;
}

// The company logo on the sign-in screen. Drop the file in public/brand/ (logo.svg,
// logo.png or logo.webp) and it replaces the wordmark; it is shown white, so the
// black master works as-is. Served before sign-in, so it is the only file there.
const BRAND_LOGO_FILES = [['logo.svg', 'image/svg+xml'], ['logo.png', 'image/png'], ['logo.webp', 'image/webp']];
function brandLogoFile() {
  for (const [name, type] of BRAND_LOGO_FILES) {
    const file = path.join(__dirname, 'public', 'brand', name);
    if (fs.existsSync(file)) return { file, type };
  }
  return null;
}
app.get('/brand/logo', (req, res) => {
  const logo = brandLogoFile();
  if (!logo) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=3600').type(logo.type).sendFile(logo.file);
});

function brandHtml() {
  if (brandLogoFile()) return '<div class="brand"><img src="/brand/logo" alt="Cedar Ridge Management"></div>';
  // No logo file yet: a quiet wordmark — a square-in-square mark, tracked caps, a gold hairline.
  return `<div class="brand" aria-label="Cedar Ridge Management">
  <svg class="mark" viewBox="0 0 34 34" fill="none" aria-hidden="true">
    <rect x="0.75" y="0.75" width="32.5" height="32.5" stroke="#FFFDFA" stroke-opacity=".9" stroke-width="1.5"/>
    <rect x="9.75" y="9.75" width="14.5" height="14.5" stroke="#B98A2E" stroke-width="1.5"/>
  </svg>
  <div class="wm">CEDAR RIDGE</div>
  <div class="rule"></div>
  <div class="sub">MANAGEMENT</div>
</div>`;
}

// The skyline behind the sign-in screen (generated once; deliberately plain shapes).
const SKYLINE_SVG = '<svg class="skyline" viewBox="0 0 1440 320" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><path fill="rgba(255,253,250,.022)" d="M-10 320V85H38V320ZM41 320V200L69 182L97 200V320ZM106 320V133H176V320ZM179 320V223H250V320ZM258 320V75H325V320ZM327 320V116H366V90H372V116H411V320ZM416 320V204H493V320ZM495 320V224H536V320ZM538 320V175H602V320ZM604 320V174H677V320ZM686 320V171H720V145H726V171H761V320ZM766 320V113H854V320ZM856 320V88H922V320ZM925 320V185H935V155H966V185H976V320ZM983 320V102H1069V320ZM1077 320V182H1110V156H1116V182H1149V320ZM1158 320V130H1230V320ZM1232 320V168H1302V320ZM1310 320V186H1340V160H1346V186H1376V320ZM1383 320V118H1428V320ZM1431 320V189H1520V320Z"/><path fill="#0D2219" stroke="rgba(255,253,250,.07)" stroke-width="1" d="M-10 320V289H1V259H36V289H47V320ZM54 320V151L113 129L173 151V320ZM179 320V166H245V320ZM247 320V215H260V185H301V215H314V320ZM322 320V235H342V205H406V235H426V320ZM435 320V225H522V320ZM529 320V248H635V320ZM643 320V224H753V320ZM755 320V202H867V320ZM877 320V261H889V231H926V261H938V320ZM942 320V187H954V157H992V187H1004V320ZM1011 320V255H1025V225H1068V255H1082V320ZM1084 320V248H1152V320ZM1155 320V202H1270V320ZM1280 320V164H1343V320ZM1353 320V173H1426V320ZM1430 320V193H1527V320Z"/><g fill="rgba(185,138,46,.32)"><rect x="74" y="165" width="4" height="6"/><rect x="86" y="165" width="4" height="6"/><rect x="74" y="181" width="4" height="6"/><rect x="122" y="277" width="4" height="6"/><rect x="62" y="309" width="4" height="6"/><rect x="134" y="309" width="4" height="6"/><rect x="158" y="309" width="4" height="6"/><rect x="211" y="180" width="4" height="6"/><rect x="223" y="196" width="4" height="6"/><rect x="187" y="244" width="4" height="6"/><rect x="199" y="276" width="4" height="6"/><rect x="255" y="199" width="4" height="6"/><rect x="291" y="247" width="4" height="6"/><rect x="303" y="247" width="4" height="6"/><rect x="414" y="219" width="4" height="6"/><rect x="390" y="251" width="4" height="6"/><rect x="354" y="267" width="4" height="6"/><rect x="366" y="267" width="4" height="6"/><rect x="414" y="299" width="4" height="6"/><rect x="479" y="303" width="4" height="6"/><rect x="549" y="294" width="4" height="6"/><rect x="687" y="254" width="4" height="6"/><rect x="663" y="270" width="4" height="6"/><rect x="847" y="216" width="4" height="6"/><rect x="835" y="248" width="4" height="6"/><rect x="986" y="299" width="4" height="6"/><rect x="1055" y="239" width="4" height="6"/><rect x="1043" y="303" width="4" height="6"/><rect x="1175" y="248" width="4" height="6"/><rect x="1187" y="264" width="4" height="6"/><rect x="1223" y="264" width="4" height="6"/><rect x="1247" y="264" width="4" height="6"/><rect x="1211" y="280" width="4" height="6"/><rect x="1312" y="242" width="4" height="6"/><rect x="1288" y="290" width="4" height="6"/><rect x="1300" y="306" width="4" height="6"/><rect x="1486" y="223" width="4" height="6"/><rect x="1510" y="223" width="4" height="6"/></g></svg>';

function footHtml() {
  return SKYLINE_SVG + `<div class="foot">&copy; ${new Date().getFullYear()} Cedar Ridge Management</div>`;
}

function loginPageHtml() {
  return LOGIN_PAGE_HTML.replace('__BOOTSTRAP__', pinLoginAllowed() ? 'true' : 'false')
    .replace('__MAIL__', mailer.configured() ? 'true' : 'false')
    .replace('__BRAND__', brandHtml())
    .replace('__FOOT__', footHtml());
}

// The page an emailed link opens: choose a new password. Same look as sign-in.
function resetPageHtml() {
  const head = LOGIN_PAGE_HTML.slice(0, LOGIN_PAGE_HTML.indexOf('<body>'));
  return head + `<body>
${brandHtml()}
<div class="card">
  <h1>Choose your password</h1>
  <p>${userStore.PASSWORD_RULE}</p>
  <form id="f">
    <input id="p1" class="txt" type="password" autocomplete="new-password" placeholder="New password" autofocus>
    <input id="p2" class="txt" type="password" autocomplete="new-password" placeholder="New password again">
    <button type="submit">Save and sign in</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
history.replaceState(null, '', '/reset');   // keep the one-time token out of history
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const a = document.getElementById('p1').value, b = document.getElementById('p2').value;
  if (a !== b) { document.getElementById('err').textContent = 'The two passwords do not match.'; return; }
  const r = await fetch('/api/auth/reset', { method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ token, password: a }) });
  let j = {}; try { j = await r.json(); } catch {}
  if (r.ok) { location.href = '/'; return; }
  document.getElementById('err').textContent = j.error || 'That did not work — ask for a new link.';
});
</script>
${footHtml()}
</body>
</html>`;
}

function requireTenantAccess(req, res, next) {
  noStore(res);
  // In SSO proxy Access mode the site-wide gate already verified the JWT.
  if (cfAccessEnabled()) return next();
  if (!tenantAccessEnabled()) return next();
  if (resolveUser(req)) return next();
  res.status(401).json({ code: 'TENANT_AUTH_REQUIRED', error: 'Tenant data is locked.' });
}

function safePinMatches(pin) {
  const incoming = Buffer.from(String(pin || ''));
  const expected = Buffer.from(TENANT_ACCESS_PIN);
  return incoming.length === expected.length && crypto.timingSafeEqual(incoming, expected);
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.items || payload.Items || payload.data || payload.Data || payload.results || payload.Results || [];
}

function reportGridRows(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return asList(payload);
  return Object.entries(payload)
    .filter(([key, value]) => /^Grid\d+$/i.test(key) && Array.isArray(value))
    .flatMap(([, value]) => value);
}

function visibleLeafReportRows(payload) {
  return reportGridRows(payload).filter(row => row && typeof row === 'object' && !row.HideRow && !row.IsHeader && !row.IsTotal);
}

function reportParamQuery(entries) {
  const params = {};
  entries.forEach(([parameter, value], index) => {
    params[`parameters[${index}].Parameter`] = parameter;
    params[`parameters[${index}].Value`] = value;
    params[`parameters[${index}].InListItemMode`] = 'false';
  });
  return params;
}

function pick(obj, keys, fallback = '') {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return fallback;
}

function pickNested(obj, parentKeys, childKeys, fallback = '') {
  for (const parentKey of parentKeys) {
    const parent = obj && obj[parentKey];
    const value = pick(parent, childKeys, '');
    if (value !== '') return value;
  }
  return fallback;
}

function numberValue(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'object') {
    return numberValue(pick(value, ['Balance', 'Amount', 'Value', 'CurrentBalance', 'AmountOwed', 'OpenBalance', 'Total'], 0));
  }
  const text = String(value).trim();
  const parsed = Number(text.replace(/[$,()]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function reportAmount(row, key = 'RawAmount') {
  return numberValue(row?.[key] ?? row?.Amount ?? row?.Value ?? row?.Total ?? 0);
}

function reportLabel(row) {
  return String(row?.GLAccountName || row?.AccountName || row?.Label || row?.Description || row?.Name || '').trim();
}

function idValue(row, keys) {
  const value = pick(row, keys, '');
  return value === undefined || value === null || value === '' ? '' : String(value);
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function embeddedText(value, keys = ['Name', 'PropertyName', 'Status', 'Description', 'UnitStatusTypeName', 'OccupancyType']) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return String(pick(value, keys, ''));
}

// ── one entity source for the whole site ────────────────────────────────────
// The owner, 2026-09-11, after six Cedar Ridge buildings turned out to be missing
// from the Cedar Ridge whitelist: *"go over the entire website and not just this tool and
// see if it's like that everywhere else. If it is, make the entire portfolio the
// updated Cedar Ridge one."*
//
// It was like that everywhere else, and worse. There were TWO property→entity
// maps and they disagreed:
//
//   services/entityMap.js        built from Rent Manager, now with Cedar Ridge read off
//                                the "Cedar Ridge" group. 42 Cedar Ridge
//                                properties. Gates delinquency, collections,
//                                cohorts, moves, unit counts, financials.
//   getStaticPropertyEntityMap   THE SERVER PARSING ITS OWN FRONTEND HTML —
//                                reading `const DATA` out of public/index.html
//                                and keying entity by property NAME. 37 Cedar Ridge
//                                properties, missing all six.
//
// The second one is not cosmetic. It filters which units count toward portfolio
// OCCUPANCY on the Overview, and it labels the entity on work orders, issues,
// units and tenant rows. So those six buildings' units were excluded from
// occupancy outright and their rows carried a blank entity, on a page nobody
// would think to cross-check against the Renovations tab.
//
// Now there is one source. The live map is warmed at boot and refreshed with the
// caches; the parsed-HTML map stays ONLY as the cold-start fallback, because a
// name lookup that returns nothing would silently drop every row from the
// portfolio rather than mislabel it — and this file has learned what silent
// dropping costs.
let livePropertyEntityByName = null;

function buildNameIndex(byId) {
  const index = new Map();
  for (const meta of byId.values()) {
    // Rows carry a property's Name in some places and its ShortName in others
    // (RM's own reports use ShortName), so both address the same entity.
    for (const key of [meta.name, meta.shortName]) {
      const k = normalizeKey(key);
      if (k) index.set(k, meta.entity);
    }
  }
  return index;
}

async function refreshPropertyEntityNames(reason = 'refresh') {
  if (!rentManager.isConfigured()) return null;
  try {
    // A refresh means go and look again. Without this the group's own six-hour
    // cache would hand back the membership somebody just edited in Rent Manager
    // and pressed Refresh to pick up.
    if (reason !== 'startup') require('./services/entityMap').clearGroupCache();
    const { byId, gah: group } = await buildPropertyEntityMap(rentManager);
    livePropertyEntityByName = buildNameIndex(byId);
    console.log(`Property→entity map (${reason}): ${livePropertyEntityByName.size} name(s) from Rent Manager`
      + (group ? ` · Cedar Ridge from ${group.source}${group.via ? ` (${group.via})` : ''}, ${group.properties || (group.ids && group.ids.size) || '?'} propert${(group.properties || 0) === 1 ? 'y' : 'ies'}` : ''));
    return livePropertyEntityByName;
  } catch (err) {
    console.warn(`Property→entity map (${reason}) failed, using the static fallback:`, publicErrorMessage(err));
    return null;
  }
}

function getStaticPropertyEntityMap() {
  if (staticPropertyEntityMap) return staticPropertyEntityMap;
  staticPropertyEntityMap = new Map();

  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const match = html.match(/const DATA = ([\s\S]*?);\r?\nconst TOTALS =/);
    if (!match) return staticPropertyEntityMap;

    const data = JSON.parse(match[1]);
    Object.entries(data).forEach(([entity, entityData]) => {
      (entityData.props || []).forEach(prop => {
        staticPropertyEntityMap.set(normalizeKey(prop.name), entity);
      });
    });
  } catch (err) {
    console.warn('Could not build property/entity lookup:', err.message);
  }

  return staticPropertyEntityMap;
}

// The live map when it is warm, the parsed-HTML one until then. Callers stay
// synchronous — every one of them is inside a row mapper.
function propertyEntityLookup() {
  return (livePropertyEntityByName && livePropertyEntityByName.size)
    ? livePropertyEntityByName
    : getStaticPropertyEntityMap();
}

function entityForProperty(propertyName) {
  return propertyEntityLookup().get(normalizeKey(propertyName)) || '';
}

function rowPropertyName(row) {
  const embeddedProperty = row?.Property || row?.property || {};
  return String(pick(
    row,
    ['PropertyName', 'propertyName', 'PropertyShortName', 'propertyShortName'],
    embeddedText(embeddedProperty, ['Name', 'PropertyName', 'ShortName', 'PropertyShortName'])
  ));
}

function unitStatusTypeId(unit) {
  return idValue(unit?.CurrentUnitStatus || {}, ['UnitStatusTypeID', 'UnitStatusTypeId', 'ID', 'Id']);
}

function unitStatusText(unit, unitStatusTypesById) {
  const statusType = unitStatusTypesById.get(unitStatusTypeId(unit)) || {};
  return [
    embeddedText(unit?.CurrentOccupancyStatus, ['Name', 'Status', 'Description', 'OccupancyType']),
    embeddedText(unit?.CurrentUnitStatus, ['Name', 'Status', 'Description', 'UnitStatusTypeName']),
    embeddedText(statusType, ['Name', 'Status', 'Description']),
    embeddedText(unit?.Status),
    embeddedText(unit?.UnitStatus),
  ].filter(Boolean).join(' ');
}

function hasCurrentOccupant(unit) {
  const occupancy = unit?.CurrentOccupancyStatus || {};
  const occupants = unit?.CurrentOccupants;
  return Boolean(
    unit?.CurrentOccupant ||
    unit?.TenantID ||
    occupancy.TenantID ||
    (Array.isArray(occupants) && occupants.length > 0)
  );
}

function unitOccupancySignal(unit, unitStatusTypesById) {
  const statusType = unitStatusTypesById.get(unitStatusTypeId(unit)) || {};
  if (statusType.IsVacant === true) return 'vacant';
  if (statusType.IsVacant === false && statusType.Name) return 'occupied';

  const occupancyType = String(pick(unit?.CurrentOccupancyStatus || {}, ['OccupancyType', 'Type'], '')).toLowerCase();
  if (/current\s*occupant|currentoccupant|occupied|tenant/.test(occupancyType)) return 'occupied';
  if (/past|vacant|available|none/.test(occupancyType)) return 'vacant';

  const text = unitStatusText(unit, unitStatusTypesById).toLowerCase();
  if (/occupied|leased|rented/.test(text)) return 'occupied';
  if (/vacant|available|notice|down|model|offline|make ready|renovation|major|unrentable|inact|inactive/.test(text)) return 'vacant';

  if (hasCurrentOccupant(unit)) return 'occupied';

  // Rent Manager returns {} for both current occupancy and current unit status
  // on too many portfolio units. Treat that as unknown instead of inventing a
  // vacancy number from incomplete live data.
  return 'unknown';
}

function namesLikelyMatch(nameA = '', nameB = '') {
  const a = String(nameA).toLowerCase().trim();
  const b = String(nameB).toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const reorder = (name) => {
    if (!name.includes(',')) return name;
    const [last, first] = name.split(',').map(s => s.trim());
    return `${first} ${last}`.trim();
  };
  return reorder(a) === b || reorder(b) === a;
}

function normalizeTenant(row) {
  const first = pick(row, ['FirstName', 'firstName', 'First', 'first', 'TenantFirstName', 'FirstName1'], '');
  const last = pick(row, ['LastName', 'lastName', 'Last', 'last', 'TenantLastName', 'LastName1'], '');
  const fullName = pick(row, ['Name', 'name', 'DisplayName', 'displayName', 'FullName', 'fullName', 'TenantName', 'tenantName', 'CustomerName'], [first, last].filter(Boolean).join(' '));
  const balance = numberValue(pick(row, ['Balance', 'balance', 'CurrentBalance', 'currentBalance', 'AmountOwed', 'amountOwed', 'AmountDue', 'OpenBalance', 'TotalBalance', 'ReceivableBalance', 'Amount'], 0));
  const property = String(pick(row, ['PropertyName', 'property', 'Property', 'PropertyShortName'], pickNested(row, ['Property', 'property'], ['Name', 'name', 'PropertyName', 'ShortName'], '')));

  return {
    id: String(pick(row, ['TenantID', 'TenantId', 'tenantId', 'ID', 'Id', 'id', 'AccountID', 'AccountId', 'accountId', 'AccountNumber'], '')),
    name: fullName || 'Tenant',
    account: String(pick(row, ['AccountNumber', 'account', 'AccountID', 'AccountId', 'accountId', 'TenantID', 'TenantId', 'tenantId', 'ID', 'Id', 'id'], '')),
    property,
    unit: String(pick(row, ['UnitName', 'unit', 'Unit', 'UnitNumber', 'UnitID', 'UnitId'], pickNested(row, ['Unit', 'unit'], ['Name', 'name', 'UnitName', 'UnitNumber'], ''))),
    entity: String(pick(row, ['Entity', 'entity', 'EntityName', 'Portfolio', 'PortfolioName', 'PropertyGroupName'], entityForProperty(property))),
    leaseStart: String(pick(row, ['LeaseStart', 'leaseStart', 'LeaseStartDate', 'StartDate', 'MoveInDate'], '')),
    leaseEnd: String(pick(row, ['LeaseEnd', 'leaseEnd', 'LeaseEndDate', 'EndDate', 'MoveOutDate'], '')),
    email: String(pick(row, ['Email', 'email', 'EmailAddress', 'PrimaryEmail'], '')),
    phone: String(pick(row, ['Phone', 'phone', 'PhoneNumber', 'PrimaryPhone', 'MobilePhone', 'CellPhone'], '')),
    status: String(pick(row, ['Status', 'status', 'TenantStatus', 'LeaseStatus'], '')),
    delinquent: balance > 0,
    amountOwed: Math.round(balance * 100) / 100,
  };
}

function pickText(row, keys, fallback = '') {
  for (const key of keys) {
    const value = row && row[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') {
      const text = embeddedText(value, ['Name', 'name', 'DisplayName', 'displayName', 'Description', 'description', 'Status', 'status', 'Title', 'title']);
      if (text) return text;
      continue;
    }
    return String(value);
  }
  return fallback;
}

function parseIssueDateValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const date = new Date(value > 10000000000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const text = String(value).trim();
  if (!text) return null;

  const dotNet = text.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
  if (dotNet) {
    const date = new Date(Number(dotNet[1]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const mdy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (mdy) {
    const year = Number(mdy[3]) < 100 ? 2000 + Number(mdy[3]) : Number(mdy[3]);
    return new Date(year, Number(mdy[1]) - 1, Number(mdy[2]));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLocalDate(date) {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function issueWindowCutoff(days) {
  const normalizedDays = Math.max(1, Math.min(Number(days) || 7, 365));
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (normalizedDays - 1));
  return cutoff;
}

// Pull the property/unit an issue belongs to out of the embedded collections.
//
// The issue row itself has no PropertyID, UnitID or TenantID — confirmed by
// asking RM for those fields explicitly and getting back only the issue id. That
// is why every ticket on the Issues tab read "Unassigned" with a blank entity,
// and why the by-entity chart was empty: there was nothing to group on.
//
// The link is reachable, just not as a column. /ServiceManagerIssues accepts
// embeds=Properties,Units — plural. The singular forms (Property, Unit) 404 with
// "the given key was not present in the dictionary", which is what an earlier
// probe read as "no embeds supported at all". With the plural names, 413 of 419
// tickets in a live 7-day window resolve to a real property and unit.
//
// Both come back as arrays. No issue in the live feed had more than one property,
// so the first is the ticket's location.
function embeddedIssueProperty(row) {
  const list = row && (row.Properties || row.properties);
  return Array.isArray(list) && list.length ? list[0] : null;
}

function embeddedIssueUnit(row) {
  const list = row && (row.Units || row.units);
  return Array.isArray(list) && list.length ? list[0] : null;
}

function normalizeServiceIssue(row, lookups = serviceManagerLookups.EMPTY, entityById = null) {
  // RM12's actual ServiceManagerIssues fields are AssignedOpenDate (when the
  // ticket was assigned/opened) and CreateDate (when the record was entered) —
  // neither matched the old candidate list below, so every issue's openDate
  // came back blank and the recent-issues window filter dropped 100% of rows.
  const openedRaw = pick(row, [
    'AssignedOpenDate', 'assignedOpenDate', 'CreateDate', 'createDate',
    'OpenDate', 'openDate', 'DateOpened', 'dateOpened',
    'DateCreated', 'dateCreated', 'CreatedDate', 'createdDate', 'CreatedOn',
    'DateSubmitted', 'SubmittedDate', 'ReportedDate', 'RequestDate', 'StartDate', 'Date',
  ], '');
  const closeRaw = pick(row, [
    'CloseDate', 'closeDate', 'AssignedCloseDate', 'assignedCloseDate', 'ClosedDate', 'closedDate',
    'DateClosed', 'ResolvedDate', 'CompletedDate', 'CompletionDate', 'FinishDate',
  ], '');
  const openedDate = parseIssueDateValue(openedRaw);
  const closeDate = parseIssueDateValue(closeRaw);

  const embeddedProperty = embeddedIssueProperty(row);
  const embeddedUnit = embeddedIssueUnit(row);
  const property = (embeddedProperty && String(embeddedProperty.Name || embeddedProperty.ShortName || '').trim())
    || rowPropertyName(row)
    || pickText(row, ['Property', 'property'], '');

  // Entity comes from the embedded property's own id, through the same RM-native
  // map the rest of the site uses — not from a name-matching pass, which is what
  // made this field fragile before.
  const propertyId = embeddedProperty && (embeddedProperty.PropertyID ?? embeddedProperty.PropertyId);
  const mappedEntity = entityById && propertyId != null ? entityById.get(Number(propertyId)) : null;

  // Real names for the numeric ids RM sends. Each falls back to what the code
  // did before the lookups existed, so a lookup outage degrades rather than blanks.
  const statusName = lookups.statuses.get(Number(row?.StatusID));
  const status = statusName
    || (row && typeof row.IsClosed === 'boolean'
      ? (row.IsClosed ? 'Closed' : 'Open')
      : pickText(row, [
          'Status', 'status', 'StatusName', 'statusName', 'IssueStatus', 'IssueStatusName',
          'ServiceManagerIssueStatusName', 'ServiceManagerIssueStatus',
        ], 'New'));

  return {
    id: idValue(row, [
      'ServiceManagerIssueID', 'ServiceManagerIssueId', 'ServiceIssueID', 'ServiceIssueId',
      'IssueID', 'IssueId', 'WorkOrderID', 'WorkOrderId', 'ID', 'Id', 'id',
    ]),
    openDate: formatLocalDate(openedDate),
    closeDate: formatLocalDate(closeDate),
    status,
    title: pickText(row, ['Title', 'title', 'Subject', 'subject', 'Description', 'description', 'Issue', 'issue', 'Name', 'name', 'ShortDescription', 'ProblemDescription'], ''),
    property: property || 'Unassigned',
    propertyId: propertyId != null ? Number(propertyId) : null,
    entity: mappedEntity
      || pickText(row, ['Entity', 'entity', 'EntityName', 'Portfolio', 'PortfolioName', 'PropertyGroupName'], entityForProperty(property)),
    unit: (embeddedUnit && String(embeddedUnit.Name || '').trim())
      || pickText(row, ['UnitName', 'unitName', 'UnitNumber', 'unitNumber', 'Unit', 'unit'], ''),
    // RM's own category wins when it says something — 'Pest Control', 'Elevator',
    // 'DCA Violation' are all real buckets a super dispatches against. But 73% of
    // tickets are filed under the catch-all 'Maintenance', which is no more useful
    // than no category at all, so those fall through to reading the tenant's own
    // words. See services/issueCategories.js.
    category: issueCategories.resolveIssueCategory(
      lookups.categories.get(Number(row?.CategoryID))
        || pickText(row, ['Category', 'category', 'CategoryName', 'IssueCategory', 'IssueCategoryName', 'ServiceManagerIssueCategoryName', 'ServiceManagerIssueCategory'], ''),
      pickText(row, ['Title', 'title', 'Subject', 'subject'], ''),
      pickText(row, ['Description', 'description', 'ShortDescription', 'ProblemDescription', 'Comment', 'Notes'], '')
    ),
    priority: lookups.priorities.get(Number(row?.PriorityID))
      || pickText(row, ['Priority', 'priority', 'PriorityName', 'IssuePriority', 'IssuePriorityName', 'ServiceManagerIssuePriorityName', 'ServiceManagerIssuePriority'], 'Medium'),
    assignedTo: lookups.users.get(Number(row?.AssignedToUserID))
      || pickText(row, ['AssignedTo', 'assignedTo', 'AssignedToName', 'Assignee', 'AssigneeName', 'AssignedUser', 'AssignedUserName', 'Technician', 'TechnicianName', 'VendorName'], ''),
  };
}

function issueIsWithinWindow(issue, cutoff) {
  const opened = parseIssueDateValue(issue.openDate);
  return Boolean(opened && opened >= cutoff);
}

async function loadRecentServiceIssues(query = {}) {
  const days = Math.max(1, Math.min(Number(query.days) || 7, 365));
  const limit = Math.max(1, Math.min(Number(query.limit) || 5000, 20000));
  const pageSize = Math.max(1, Math.min(Number(query.pagesize) || 1000, 5000));
  const maxPages = Math.max(1, Math.min(Number(query.maxPages) || Math.ceil(limit / pageSize) + 1, 200));
  const cutoff = issueWindowCutoff(days);
  const passthrough = { ...query };
  ['days', 'format', 'limit', 'maxPages', 'fresh', 'ts'].forEach(key => delete passthrough[key]);

  // Ask RM to filter by date server-side (RQL: field,operator,value — confirmed
  // against RM12's own WAPI docs) instead of paginating client-side through its
  // full multi-thousand-row issue history in ID order (oldest first). Without
  // this, "recent" issues past the first ~6000 old rows were never reached and
  // every days=N request came back empty.
  const rqlCutoff = `AssignedOpenDate,ge,${formatLocalDate(cutoff)}`;
  passthrough.filters = passthrough.filters ? `${passthrough.filters};${rqlCutoff}` : rqlCutoff;

  // The property/unit link only comes back as an embed — see embeddedIssueProperty.
  // Without this every ticket is location-less and the tab can't group by anything.
  passthrough.embeds = passthrough.embeds ? `${passthrough.embeds},Properties,Units` : 'Properties,Units';

  const rows = await loadAllPages(
    params => rentManager.ServiceManagerIssues(params),
    passthrough,
    pageSize,
    maxPages
  );

  // Both are cached and non-fatal: the lookups for an hour, the entity map by its
  // own module. Resolved once per sweep rather than once per row.
  const [lookups, entityMap] = await Promise.all([
    serviceManagerLookups.getLookups(rentManager),
    buildPropertyEntityMap(rentManager).catch(() => null),
  ]);
  const entityById = entityMap
    ? new Map([...entityMap.byId].map(([id, meta]) => [id, meta.entity]))
    : null;

  const allRecent = rows
    .map(row => normalizeServiceIssue(row, lookups, entityById))
    .filter(issue => issue.id && issueIsWithinWindow(issue, cutoff))
    .sort((a, b) => {
      const ad = parseIssueDateValue(a.openDate)?.getTime() || 0;
      const bd = parseIssueDateValue(b.openDate)?.getTime() || 0;
      if (bd !== ad) return bd - ad;
      return Number(b.id) - Number(a.id);
    });

  const items = allRecent.slice(0, limit);
  return {
    days,
    cutoff: formatLocalDate(cutoff),
    scanned: rows.length,
    count: allRecent.length,
    returned: items.length,
    maxResults: limit,
    truncated: allRecent.length > limit,
    items,
  };
}

function tenantSearchText(tenant) {
  return [tenant.name, tenant.account, tenant.property, tenant.unit, tenant.entity].join(' ').toLowerCase();
}

async function loadAllPages(fetchPage, baseParams = {}, preferredPageSize = 1000, maxPages = 200) {
  const rows = [];
  let pageSize = preferredPageSize;

  for (let page = 1; page <= maxPages; page += 1) {
    let pageRows;
    try {
      pageRows = asList(await fetchPage({ ...baseParams, pagesize: pageSize, pagenumber: page }));
    } catch (err) {
      if (page === 1 && pageSize > 1000 && /maximum page size|page size/i.test(err.message)) {
        pageSize = 1000;
        pageRows = asList(await fetchPage({ ...baseParams, pagesize: pageSize, pagenumber: page }));
      } else {
        throw err;
      }
    }

    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  return rows;
}

async function loadTenantSourceRows() {
  try {
    const tenants = await loadAllPages(
      params => rentManager.Tenants(params),
      { fields: TENANT_FIELD_LIST, embeds: 'Balance' },
      20000,
      10
    );
    if (tenants.length) return tenants;
  } catch (err) {
    console.warn('Tenant fields query failed; falling back to embedded tenant pages:', err.message);
  }

  return loadAllPages(
    params => rentManager.Tenants(params),
    { embeds: 'Balance,Property,Leases' },
    1000,
    100
  );
}

// RM posts each unit's next recurring charge (rent, and whatever else is on
// auto-billing) a few days before it's actually due — TransactionDate is the
// 1st of next month, but CreateDate is ~5 days earlier. Tenants' Balance embed
// is a raw ledger sum that includes those not-yet-due charges, which inflates
// the Delinquency tab (a tenant billed early for next month reads as "past due"
// today even though nothing has come due). Sum every charge dated after today
// per tenant (AccountID on /Charges == TenantID; confirmed live 2026-07-29) so
// buildTenantIndex can net it back out of amountOwed. TenantID isn't filterable
// on /Charges, so this pulls the whole future-dated set once (~9 pages) instead
// of one call per tenant.
async function loadFutureChargeTotals() {
  const today = formatLocalDate(new Date());
  const rows = await loadAllPages(
    params => rentManager.Charges(params),
    { filters: `TransactionDate,gt,${today}`, fields: 'AccountID,AccountType,Amount,TransactionDate' },
    1000,
    30
  );

  const byAccount = new Map();
  for (const row of rows) {
    if (row.AccountType !== 'Customer') continue;
    const id = String(row.AccountID ?? '').trim();
    if (!id) continue;
    const amount = Number(row.Amount) || 0;
    byAccount.set(id, (byAccount.get(id) || 0) + amount);
  }
  return byAccount;
}

function buildPropertyLookup(properties) {
  const byId = new Map();
  const byName = new Map();

  properties.forEach(row => {
    const id = idValue(row, ['PropertyID', 'PropertyId', 'ID', 'Id']);
    const name = String(pick(row, ['Name', 'PropertyName', 'ShortName', 'PropertyShortName'], ''));
    const entity = String(pick(row, ['Entity', 'EntityName', 'Portfolio', 'PortfolioName', 'PropertyGroupName'], entityForProperty(name)));
    const prop = { id, name, entity };
    if (id) byId.set(id, prop);
    if (name) byName.set(normalizeKey(name), prop);
  });

  return { byId, byName };
}

function buildUnitLookup(units, propertyLookup) {
  const byId = new Map();

  units.forEach(row => {
    const id = idValue(row, ['UnitID', 'UnitId', 'ID', 'Id']);
    if (!id) return;
    const propertyId = idValue(row, ['PropertyID', 'PropertyId']);
    const property = propertyLookup.byId.get(propertyId);
    byId.set(id, {
      id,
      name: String(pick(row, ['Name', 'UnitName', 'UnitNumber', 'Number'], '')),
      propertyId,
      propertyName: property?.name || String(pick(row, ['PropertyName'], '')),
      entity: property?.entity || entityForProperty(property?.name || ''),
    });
  });

  return byId;
}

function leaseDateValue(row, keys) {
  return String(pick(row, keys, ''));
}

function leaseScore(lease) {
  const start = Date.parse(lease.leaseStart || '');
  const end = Date.parse(lease.leaseEnd || '');
  const now = Date.now();
  let score = 0;
  if (!Number.isNaN(start)) score += Math.min(start / 1000000000, 3000);
  if (!Number.isNaN(start) && start <= now) score += 5000;
  if (Number.isNaN(end) || end >= now) score += 10000;
  return score;
}

function normalizeLease(row) {
  return {
    tenantId: idValue(row, ['TenantID', 'TenantId', 'tenantId']),
    unitId: idValue(row, ['UnitID', 'UnitId', 'unitId']),
    propertyId: idValue(row, ['PropertyID', 'PropertyId', 'propertyId']),
    leaseStart: leaseDateValue(row, ['LeaseStart', 'LeaseStartDate', 'StartDate', 'MoveInDate', 'FromDate']),
    leaseEnd: leaseDateValue(row, ['LeaseEnd', 'LeaseEndDate', 'EndDate', 'MoveOutDate', 'ToDate']),
  };
}

function buildLeaseLookup(leases) {
  const byTenant = new Map();
  leases.map(normalizeLease).forEach(lease => {
    if (!lease.tenantId) return;
    if (!byTenant.has(lease.tenantId)) byTenant.set(lease.tenantId, []);
    byTenant.get(lease.tenantId).push(lease);
  });

  byTenant.forEach((tenantLeases, tenantId) => {
    tenantLeases.sort((a, b) => leaseScore(b) - leaseScore(a));
    byTenant.set(tenantId, tenantLeases);
  });

  return byTenant;
}

function embeddedLeaseForTenant(row) {
  const leases = Array.isArray(row.Leases) ? row.Leases : (Array.isArray(row.leases) ? row.leases : []);
  return leases.map(normalizeLease).sort((a, b) => leaseScore(b) - leaseScore(a))[0] || null;
}

function enrichTenantRow(row, lookups) {
  const tenantId = idValue(row, ['TenantID', 'TenantId', 'tenantId', 'ID', 'Id', 'id']);
  const embeddedLease = embeddedLeaseForTenant(row);
  const lease = embeddedLease || (lookups.leasesByTenant.get(tenantId) || [])[0] || {};
  const unitId = idValue(row, ['UnitID', 'UnitId', 'unitId']) || lease.unitId;
  const unit = unitId ? lookups.unitsById.get(unitId) : null;
  const embeddedProperty = row.Property || row.property || {};
  const propertyId = idValue(row, ['PropertyID', 'PropertyId', 'propertyId'])
    || lease.propertyId
    || unit?.propertyId
    || idValue(embeddedProperty, ['PropertyID', 'PropertyId', 'ID', 'Id']);
  const property = propertyId ? lookups.properties.byId.get(propertyId) : null;
  const propertyName = String(pick(row, ['PropertyName', 'propertyName'], pick(embeddedProperty, ['Name', 'PropertyName', 'ShortName'], property?.name || unit?.propertyName || '')));
  const unitName = String(pick(row, ['UnitName', 'unitName', 'UnitNumber'], unit?.name || ''));

  return {
    ...row,
    TenantID: tenantId || row.TenantID,
    PropertyID: propertyId || row.PropertyID,
    PropertyName: propertyName,
    UnitID: unitId || row.UnitID,
    UnitName: unitName,
    Entity: String(pick(row, ['Entity', 'EntityName', 'Portfolio', 'PortfolioName', 'PropertyGroupName'], property?.entity || unit?.entity || entityForProperty(propertyName))),
    LeaseStart: String(pick(row, ['LeaseStart', 'LeaseStartDate', 'StartDate', 'MoveInDate'], lease.leaseStart || '')),
    LeaseEnd: String(pick(row, ['LeaseEnd', 'LeaseEndDate', 'EndDate', 'MoveOutDate'], lease.leaseEnd || '')),
  };
}

async function buildTenantIndex() {
  const [tenantRows, properties, units, leases, futureChargesByAccount] = await Promise.all([
    loadTenantSourceRows(),
    loadAllPages(params => rentManager.Properties(params), {}, 1000, 20),
    loadAllPages(params => rentManager.Units(params), {}, 1000, 50),
    loadAllPages(params => rentManager.Leases(params), {}, 1000, 100),
    loadFutureChargeTotals().catch(err => {
      console.warn('Future-charge lookup failed; Delinquency will include not-yet-due charges:', err.message);
      return new Map();
    }),
  ]);

  const propertiesLookup = buildPropertyLookup(properties);
  const unitsById = buildUnitLookup(units, propertiesLookup);
  const leasesByTenant = buildLeaseLookup(leases);
  const tenants = tenantRows.map(row => normalizeTenant(enrichTenantRow(row, {
    properties: propertiesLookup,
    unitsById,
    leasesByTenant,
  })));

  // Net out not-yet-due charges (see loadFutureChargeTotals) after normalizing,
  // rather than inside normalizeTenant, so the handful of call sites that
  // re-run already-normalized tenants back through normalizeTenant() (it reads
  // its own `amountOwed` output as a fallback balance field) can't double-subtract.
  let futureExcludedAmount = 0;
  let futureExcludedTenants = 0;
  tenants.forEach(t => {
    const future = Math.round(((futureChargesByAccount.get(t.id) || 0)) * 100) / 100;
    if (future > 0) {
      futureExcludedAmount += future;
      futureExcludedTenants += 1;
    }
    t.futureChargeAmount = future;
    t.amountOwed = Math.max(0, Math.round((t.amountOwed - future) * 100) / 100);
    t.delinquent = t.amountOwed > 0;
  });

  return {
    refreshedAt: Date.now(),
    tenants,
    stats: {
      tenants: tenants.length,
      properties: properties.length,
      units: units.length,
      leases: leases.length,
      delinquent: tenants.filter(t => t.amountOwed > 0).length,
      futureChargesExcluded: {
        amount: Math.round(futureExcludedAmount * 100) / 100,
        tenants: futureExcludedTenants,
      },
    },
  };
}

async function getTenantIndex() {
  if (!rentManager.isConfigured()) {
    const tenants = mockData.tenants.map(normalizeTenant);
    tenants.forEach(t => { t.futureChargeAmount = 0; });
    return {
      refreshedAt: Date.now(),
      tenants,
      stats: {
        tenants: tenants.length,
        delinquent: tenants.filter(t => t.amountOwed > 0).length,
        futureChargesExcluded: { amount: 0, tenants: 0 },
      },
    };
  }

  if (tenantIndexCache && (TENANT_INDEX_TTL_MS === 0 || Date.now() - tenantIndexCache.refreshedAt < TENANT_INDEX_TTL_MS)) {
    return tenantIndexCache;
  }

  if (!tenantIndexPromise) {
    tenantIndexPromise = buildTenantIndex()
      .then(index => {
        tenantIndexCache = index;
        return index;
      })
      .finally(() => {
        tenantIndexPromise = null;
      });
  }

  // Serve the expired index immediately while the rebuild runs in the
  // background — a page open should never wait on a full RM re-pull.
  if (tenantIndexCache) {
    tenantIndexPromise.catch(err => {
      console.warn('Tenant index background refresh failed:', publicErrorMessage(err));
    });
    return tenantIndexCache;
  }

  return tenantIndexPromise;
}

async function loadTenantRows(query = {}) {
  return (await getTenantIndex()).tenants;
}

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    rentManagerConfigured: rentManager.isConfigured(),
    mode: DEMO_MODE ? 'demo' : rentManager.isConfigured() ? 'live' : 'mock',
    demo: DEMO_MODE,
    assistant: !process.env.ANTHROPIC_API_KEY ? (DEMO_MODE ? 'canned' : 'off') : 'claude',
    tenantDataAuthRequired: tenantAccessEnabled(),
  });
});

app.get('/api/auth/status', (req, res) => {
  noStore(res);
  const user = tenantAccessEnabled() ? resolveUser(req) : LOCAL_OPEN_USER;
  res.json({
    protected: tenantAccessEnabled(),
    demo: DEMO_MODE,
    authenticated: Boolean(user),
    mode: 'users',
    bootstrap: pinLoginAllowed(),
    user: user ? { email: user.email, name: user.name, admin: !!user.admin, tools: user.tools, bootstrap: !!user.bootstrap } : null,
    tools: userStore.TOOLS,
  });
});

// Brute-force protection: max 5 failed PIN attempts per IP per 15 minutes.
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // ip -> { count, windowStart }

function loginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_ATTEMPT_WINDOW_MS) return false;
  return entry.count >= LOGIN_ATTEMPT_LIMIT;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_ATTEMPT_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
  // Opportunistic cleanup so the map can't grow unbounded
  if (loginAttempts.size > 10000) {
    for (const [key, value] of loginAttempts) {
      if (now - value.windowStart > LOGIN_ATTEMPT_WINDOW_MS) loginAttempts.delete(key);
    }
  }
}

app.post('/api/auth/login', (req, res) => {
  noStore(res);
  if (!tenantAccessEnabled()) {
    return res.json({ ok: true, protected: false });
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const body = req.body || {};
  // Email + password. Rate-limited per IP+email, so one person mistyping does not
  // lock the whole office (which shares an IP) out.
  if (body.email !== undefined) {
    const key = `${ip}|${String(body.email).trim().toLowerCase()}`;
    // ...and a looser cap per address across all emails, so one machine cannot try
    // a password against every account.
    const ipKey = `${ip}|*`;
    const ipEntry = loginAttempts.get(ipKey);
    const ipBlocked = ipEntry && Date.now() - ipEntry.windowStart <= LOGIN_ATTEMPT_WINDOW_MS && ipEntry.count >= 30;
    if (ipBlocked || loginRateLimited(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const u = userStore.authenticate(body.email, body.password);
    if (!u) { recordFailedLogin(key); recordFailedLogin(ipKey); return res.status(401).json({ error: 'Email or password is not right.' }); }
    loginAttempts.delete(key);
    userStore.touchLogin(u.id);
    setSessionCookie(res, { scope: 'user', uid: u.id, sv: u.sv || 1 });
    return res.json({ ok: true, protected: true });
  }
  // Site PIN — first-time setup only (see pinLoginAllowed).
  if (loginRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  if (!pinLoginAllowed() || !safePinMatches(body.pin)) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: pinLoginAllowed() ? 'Invalid PIN.' : 'The site PIN is retired — sign in with your email and password.' });
  }
  loginAttempts.delete(ip);
  setSessionCookie(res);
  res.json({ ok: true, protected: true, bootstrap: true });
});

// ── Emailed reset / invite links ─────────────────────────────────────────────
const RESET_TTL_HOURS = 1, INVITE_TTL_HOURS = 72;
async function sendLinkEmail(u, kind) {
  const hours = kind === 'invite' ? INVITE_TTL_HOURS : RESET_TTL_HOURS;
  const raw = userStore.createResetToken(u.id, hours * 3600 * 1000);
  const link = `${mailer.baseUrl()}/reset?token=${encodeURIComponent(raw)}`;
  await mailer.send({ to: u.email, ...mailer.linkEmail({ kind, name: u.name, link, hours }) });
}
app.get('/reset', (req, res) => { noStore(res); res.type('html').send(resetPageHtml()); });

// Forgot password. Always the same answer whether or not the email has an account,
// so this cannot be used to find out who works here. Rate-limited per address.
app.post('/api/auth/forgot', async (req, res) => {
  noStore(res);
  if (!mailer.configured()) return res.status(503).json({ error: 'Password reset by email is not set up yet — ask an admin to reset it.' });
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = `forgot|${ip}`;
  if (loginRateLimited(key)) return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
  recordFailedLogin(key);
  const u = userStore.getByEmail((req.body || {}).email);
  if (u && !u.disabled) {
    try { await sendLinkEmail(u, 'reset'); } catch (err) { console.warn('[auth] reset email failed:', err.message); }
  }
  res.json({ ok: true });
});

// The link's form posts here: new password, then signed in.
app.post('/api/auth/reset', (req, res) => {
  noStore(res);
  const { token, password } = req.body || {};
  try {
    const u = userStore.resetWithToken(token, password);
    setSessionCookie(res, { scope: 'user', uid: u.id, sv: u.sv });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || 'ERROR' });
  }
});

// ── Self sign-up (2026-10-07) ────────────────────────────────────────────────
// Anyone can create an account; it has no tools until an admin ticks some, and
// until then the person only sees a "waiting for access" page (GET /). Optional
// SIGNUP_ALLOWED_DOMAINS=cedarridge.example limits it to work addresses.
const SIGNUP_DOMAINS = (process.env.SIGNUP_ALLOWED_DOMAINS || '').split(',').map(d => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
async function sendVerifyEmail(u) {
  const raw = userStore.createVerifyToken(u.id);
  const link = `${mailer.baseUrl()}/verify?token=${encodeURIComponent(raw)}`;
  await mailer.send({ to: u.email, ...mailer.verifyEmailMessage({ name: u.name, link }) });
}
app.post('/api/auth/signup', async (req, res) => {
  noStore(res);
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = `signup|${ip}`;
  if (loginRateLimited(key)) return res.status(429).json({ error: 'Too many sign-ups from here. Try again in 15 minutes.' });
  recordFailedLogin(key);   // counts every sign-up from this address, not just failures
  let u;
  try { u = userStore.signUp(req.body || {}, SIGNUP_DOMAINS); }
  catch (err) { return res.status(err.code === 'EXISTS' ? 409 : 400).json({ error: err.code === 'EXISTS' ? 'There is already an account for that email — sign in, or use "Forgot your password?".' : err.message }); }
  if (mailer.configured()) { try { await sendVerifyEmail(u); } catch (err) { console.warn('[auth] confirm email failed:', err.message); } }
  setSessionCookie(res, { scope: 'user', uid: u.id, sv: 1 });
  res.json({ ok: true, user: { email: u.email, name: u.name, tools: [] } });
});
app.get('/verify', (req, res) => {
  noStore(res);
  const u = userStore.verifyEmail(String(req.query.token || ''));
  const head = LOGIN_PAGE_HTML.slice(0, LOGIN_PAGE_HTML.indexOf('<body>'));
  res.type('html').send(head + `<body><div class="card"><h1>${u ? 'Email confirmed' : 'Link expired'}</h1>
    <p>${u ? 'Thanks — an admin can now see your address is confirmed.' : 'This confirmation link has expired or was already used.'}</p>
    <a href="/" style="color:#14532D;font-weight:600;">Go to the site</a></div></body></html>`);
});

// ── Admin: people and the tools they can open ────────────────────────────────
// Every route under /api/admin/ is admin-only (accessControl.RULES).
function adminActor(req) { return (req.user && (req.user.email || req.user.name)) || 'admin'; }
// Belt and braces: the site gate already refuses /api/admin/ to non-admins, but in
// SSO proxy Access mode that gate does not resolve a person — so check here too.
app.use('/api/admin/', (req, res, next) => {
  if (req.user && req.user.admin) return next();
  noStore(res);
  res.status(403).json({ code: 'ADMIN_ONLY', error: 'Only an admin can use this.' });
});
function adminError(res, err) {
  const status = err.code === 'NOT_FOUND' ? 404 : (err.code === 'EXISTS' || err.code === 'LAST_ADMIN' ? 409 : 400);
  res.status(status).json({ error: err.message, code: err.code || 'ERROR' });
}
app.get('/api/admin/users', (req, res) => {
  noStore(res);
  res.json({ users: userStore.listUsers(), tools: userStore.TOOLS, minPassword: userStore.MIN_PASSWORD, passwordRule: userStore.PASSWORD_RULE,
    mailEnabled: mailer.configured(), mailInfo: mailer.describe() });
});
app.post('/api/admin/users', async (req, res) => {
  noStore(res);
  const body = { ...(req.body || {}) };
  // Invite by email: the account gets an unguessable throwaway password and the
  // person sets their own from the emailed link.
  if (body.invite) {
    if (!mailer.configured()) return res.status(400).json({ error: mailer.describe() });
    body.password = require('crypto').randomBytes(24).toString('base64url');
  }
  let user;
  try { user = userStore.createUser(body, adminActor(req)); } catch (err) { return adminError(res, err); }
  if (body.invite) {
    try { await sendLinkEmail(user, 'invite'); }
    catch (err) { return res.status(502).json({ user, error: `Account created, but the invite email failed: ${err.message}` }); }
  }
  res.json({ user, invited: !!body.invite });
});
app.post('/api/admin/users/:id/send-verify', async (req, res) => {
  noStore(res);
  const u = userStore.getById(req.params.id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  if (!mailer.configured()) return res.status(400).json({ error: mailer.describe() });
  try { await sendVerifyEmail(u); res.json({ ok: true }); } catch (err) { res.status(502).json({ error: err.message }); }
});
// Email someone a reset (or a fresh invite) link.
app.post('/api/admin/users/:id/send-reset', async (req, res) => {
  noStore(res);
  const u = userStore.getById(req.params.id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  if (!mailer.configured()) return res.status(400).json({ error: mailer.describe() });
  try { await sendLinkEmail(u, (req.body || {}).kind === 'invite' ? 'invite' : 'reset'); res.json({ ok: true }); }
  catch (err) { res.status(err.code === 'DISABLED' ? 409 : 502).json({ error: err.message }); }
});
app.put('/api/admin/users/:id', (req, res) => {
  noStore(res);
  try { res.json({ user: userStore.updateUser(req.params.id, req.body || {}, adminActor(req)) }); } catch (err) { adminError(res, err); }
});
app.post('/api/admin/users/:id/password', (req, res) => {
  noStore(res);
  try { res.json({ user: userStore.setPassword(req.params.id, (req.body || {}).password) }); } catch (err) { adminError(res, err); }
});
app.delete('/api/admin/users/:id', (req, res) => {
  noStore(res);
  if (req.user && req.user.id === req.params.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  try { userStore.deleteUser(req.params.id); res.json({ ok: true }); } catch (err) { adminError(res, err); }
});

app.post('/api/auth/logout', (req, res) => {
  noStore(res);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/tenants', requireTenantAccess, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const tenants = (await loadTenantRows(req.query)).map(normalizeTenant).slice(0, limit);
    res.json({ source: rentManager.isConfigured() ? 'rent-manager' : 'mock', count: tenants.length, tenants });
  } catch (err) {
    res.status(502).json({ error: publicErrorMessage(err) });
  }
});

app.get('/api/tenants/search', requireTenantAccess, async (req, res) => {
  try {
    const q = String(req.query.q || req.query.search || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    if (q.length < 2) {
      return res.json({ source: rentManager.isConfigured() ? 'rent-manager' : 'mock', count: 0, tenants: [] });
    }

    const tenants = (await loadTenantRows(req.query))
      .map(normalizeTenant)
      .filter(tenant => tenantSearchText(tenant).includes(q))
      .slice(0, limit);

    res.json({ source: rentManager.isConfigured() ? 'rent-manager' : 'mock', count: tenants.length, tenants });
  } catch (err) {
    res.status(502).json({ error: publicErrorMessage(err) });
  }
});

app.get('/api/tenants/profile', requireTenantAccess, async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    const name = String(req.query.name || '').trim();
    const property = String(req.query.property || '').trim();
    const unit = String(req.query.unit || '').trim();
    if (!id && !name && !(property && unit)) {
      return res.status(400).json({ error: 'Provide id, name, or property+unit.' });
    }

    const tenants = (await loadTenantRows({ ...req.query, pagesize: req.query.pagesize || 5000 })).map(normalizeTenant);
    const tenant = tenants.find(t => id && (t.id === id || t.account === id))
      || tenants.find(t => property && unit && t.property === property && String(t.unit) === unit)
      || tenants.find(t => name && property && namesLikelyMatch(t.name, name) && t.property === property)
      || tenants.find(t => name && namesLikelyMatch(t.name, name));

    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
    res.json({ source: rentManager.isConfigured() ? 'rent-manager' : 'mock', tenant });
  } catch (err) {
    res.status(502).json({ error: publicErrorMessage(err) });
  }
});

app.get('/api/tenants/:id', requireTenantAccess, async (req, res) => {
  try {
    const tenants = (await loadTenantRows({ ...req.query, pagesize: req.query.pagesize || 5000 })).map(normalizeTenant);
    const tenant = tenants.find(t => t.id === req.params.id || t.account === req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
    res.json({ source: rentManager.isConfigured() ? 'rent-manager' : 'mock', tenant });
  } catch (err) {
    res.status(502).json({ error: publicErrorMessage(err) });
  }
});

// The Issues tab's work-order feed. This used to hit Rent Manager on EVERY page
// load — with the tab's 30-second browser poll that was ~2,880 live pulls a day
// per open tab, which is a good part of how this site got itself suspended.
//
// Issues is the one deliberate exception to "nothing refreshes on its own": it's
// a live operational queue, so a work order raised at 9am has to show up without
// anyone pressing a button. The fix isn't to stop refreshing, it's to decouple
// the browser's poll from the API call — the tab still polls every 30s, but the
// server only goes back to Rent Manager when the snapshot is older than
// ISSUES_AUTO_REFRESH_MS. Ten open tabs cost the same as one.
// limit is deliberately well above a week's real volume (~420). The charts split
// the whole window by entity and category, so a cap that truncates the feed
// silently under-counts the busiest entities — the ones the chart exists to show.
const ISSUES_FEED_QUERY = { days: '7', pagesize: '1000', limit: '5000', format: 'workorders' };
const issuesFeed = snapshotCache.makeSnapshotCache({
  name: 'issues',
  file: 'issues-cache.json',
  build: () => loadRecentServiceIssues(ISSUES_FEED_QUERY),
  autoRefreshMs: Number(process.env.ISSUES_AUTO_REFRESH_MS ?? 5 * 60 * 1000),
});

app.get('/api/issues', async (req, res) => {
  const wantsRecentFeed = req.query.days || req.query.format === 'workorders';
  if (rentManager.isConfigured()) {
    try {
      if (wantsRecentFeed) {
        noStore(res);
        const snap = issuesFeed.getFresh();
        if (snap) {
          return res.json({ source: 'rent-manager', cached: true, refreshedAt: snap.refreshedAt, ...snap.data });
        }
        // Nothing cached yet — build once so a fresh install isn't empty.
        const built = await issuesFeed.refresh();
        return res.json({ source: 'rent-manager', cached: false, refreshedAt: built.refreshedAt, ...built.data });
      }
      return res.json(await rentManager.ServiceManagerIssues(req.query));
    } catch (err) {
      return res.status(502).json({ error: publicErrorMessage(err) });
    }
  }

  if (wantsRecentFeed) {
    const days = Math.max(1, Math.min(Number(req.query.days) || 7, 365));
    const cutoff = issueWindowCutoff(days);
    const allRecent = mockData.issues
      // row => … rather than .map(normalizeServiceIssue): map passes the index as
      // the second argument, which landed in `lookups` and threw, and in an async
      // route that is a request that never answers. Found 2026-10-21, the first
      // time the mock had any issues to normalise.
      .map(row => normalizeServiceIssue(row))
      .filter(issue => issue.id && issueIsWithinWindow(issue, cutoff));
    return res.json({
      source: 'mock',
      days,
      cutoff: formatLocalDate(cutoff),
      scanned: mockData.issues.length,
      count: allRecent.length,
      returned: allRecent.length,
      maxResults: allRecent.length,
      truncated: false,
      items: allRecent,
    });
  }

  res.json(mockData.issues);
});

// ── The open backlog: every open ticket, whatever its age (2026-10-21) ───────
// The feed above is a 7-day window on AssignedOpenDate. That is the right shape
// for "what came in this week" and the wrong one for the question the Issues
// dashboard opens on — how old the open tickets are, where they pile up, who is
// carrying them. On the day this was built RM held 1,392 open tickets and 1,107
// of them were opened more than a week ago; 311 more than a year ago. None of
// those were reachable from the feed. The owner, 2026-10-21: build the home screen
// on the full open backlog.
//
// Two filtered sweeps, run one after the other (RM's concurrent-session cap is
// low — see services/serviceManagerLookups.js), ~2s together:
//   IsClosed=false            → the backlog, two pages at 1,000.
//   CloseDate >= 7 days ago   → "out this week". The feed only sees closes among
//                               tickets opened INSIDE its window; in the probe
//                               week 138 of 285 closes were older tickets, so
//                               counting the feed's closes made every week look
//                               like the backlog was exploding.
// Same embeds as the feed (Properties,Units — never Tenants, see
// scripts/verifyNoEmbeddedTenantData.js), same normaliser, so a ticket reads the
// same whichever pull it came from. Cached and auto-refreshed on the feed's
// cadence; the tab's Refresh button rebuilds both (see the refresh registry).
const ISSUES_BACKLOG_DAYS = 7;
async function loadOpenIssueBacklog() {
  const cutoff = issueWindowCutoff(ISSUES_BACKLOG_DAYS);
  const openRows = await loadAllPages(
    params => rentManager.ServiceManagerIssues(params),
    { filters: 'IsClosed,eq,false', embeds: 'Properties,Units' },
    1000, 20);
  const closedRows = await loadAllPages(
    params => rentManager.ServiceManagerIssues(params),
    { filters: `CloseDate,ge,${formatLocalDate(cutoff)}`, embeds: 'Properties,Units' },
    1000, 10);

  const [lookups, entityMap] = await Promise.all([
    serviceManagerLookups.getLookups(rentManager),
    buildPropertyEntityMap(rentManager).catch(() => null),
  ]);
  const entityById = entityMap
    ? new Map([...entityMap.byId].map(([id, meta]) => [id, meta.entity]))
    : null;
  const normalize = row => normalizeServiceIssue(row, lookups, entityById);

  const open = openRows.map(normalize).filter(issue => issue.id);
  const closedRecently = closedRows.map(normalize).filter(issue => issue.id && issue.closeDate);

  // Units per property, by NAME, because that is the key the browser's rows
  // carry. Read from the unit-count snapshot when one has been built; a property
  // it doesn't know simply shows no per-unit figure rather than a wrong one.
  //
  // byPropertyAll, not byProperty (2026-10-22): byProperty only counts properties
  // inside the entity map, so the busiest non-entity buildings (7112-7312
  // Boulevard East, 352 units; Countryside, 181) printed no per-100-units figure.
  // A snapshot built before that field existed is read the old way for now, and
  // rebuilt once in the background — startBuild() is the same single /Units sweep
  // the refresh button runs, shared if one is already in flight — so the next
  // backlog build (5 min) has the full counts without anyone pressing anything.
  const unitSnap = unitCounts.loadSnapshot();
  if (!unitSnap || !unitSnap.byPropertyAll) unitCounts.startBuild().catch(() => {});
  const unitsById = (unitSnap && (unitSnap.byPropertyAll || unitSnap.byProperty)) || {};
  const unitsByProperty = {};
  open.forEach(issue => {
    if (issue.propertyId == null || !issue.property || unitsByProperty[issue.property] != null) return;
    const n = unitsById[issue.propertyId] ?? unitsById[String(issue.propertyId)];
    if (n != null) unitsByProperty[issue.property] = Number(n);
  });

  return {
    days: ISSUES_BACKLOG_DAYS,
    cutoff: formatLocalDate(cutoff),
    count: { open: open.length, closedRecently: closedRecently.length },
    unitsByProperty,
    open,
    closedRecently,
  };
}

const issuesBacklog = snapshotCache.makeSnapshotCache({
  name: 'issuesBacklog',
  file: 'issues-backlog-cache.json',
  build: () => loadOpenIssueBacklog(),
  autoRefreshMs: Number(process.env.ISSUES_AUTO_REFRESH_MS ?? 5 * 60 * 1000),
});

// Guarded by the '/api/issues' rule in services/accessControl.js (prefix match).
app.get('/api/issues/backlog', async (req, res) => {
  noStore(res);
  if (rentManager.isConfigured()) {
    try {
      const snap = issuesBacklog.getFresh();
      if (snap) return res.json({ source: 'rent-manager', cached: true, refreshedAt: snap.refreshedAt, ...snap.data });
      const built = await issuesBacklog.refresh();
      return res.json({ source: 'rent-manager', cached: false, refreshedAt: built.refreshedAt, ...built.data });
    } catch (err) {
      return res.status(502).json({ error: publicErrorMessage(err) });
    }
  }
  // Mock mode: the same split, read off the mock rows.
  const cutoff = issueWindowCutoff(ISSUES_BACKLOG_DAYS);
  const all = mockData.issues.map(row => normalizeServiceIssue(row)).filter(issue => issue.id);
  const closedRecently = all.filter(issue => {
    const closed = parseIssueDateValue(issue.closeDate);
    return closed && closed >= cutoff;
  });
  res.json({
    source: 'mock',
    days: ISSUES_BACKLOG_DAYS,
    cutoff: formatLocalDate(cutoff),
    count: { open: all.filter(i => !i.closeDate).length, closedRecently: closedRecently.length },
    unitsByProperty: {},
    open: all.filter(issue => !issue.closeDate),
    closedRecently,
  });
});

// ── Property → super map (what auto-assign routes against) ───────────────────
// Cached like every other RM pull: property records change on the order of
// months, so this must not cost an API call per tab open. The universal refresh
// button drives refresh(), same as the rest.
const supersSnapshot = snapshotCache.makeSnapshotCache({
  name: 'supers',
  file: 'supers-cache.json',
  build: () => propertySupers.resolvePropertySupers(rentManager),
});

app.get('/api/supers', async (req, res) => {
  try {
    const snap = supersSnapshot.get();
    if (snap && !req.query.fresh) {
      return res.json({ cached: true, refreshedAt: snap.refreshedAt, ...snap.data });
    }
    const built = await supersSnapshot.refresh();
    res.json({ cached: false, refreshedAt: built.refreshedAt, ...built.data });
  } catch (err) {
    res.status(502).json({ error: publicErrorMessage(err) });
  }
});

// ── Auto-assign activity log (work-order bot) ────────────────────────────────
// The demo has no bot running, so the log is empty. A live install reads the bot's
// activity log from AUTO_ASSIGN_LOG_FILE (one JSON object per line).
app.get('/api/auto-assign/activity', (req, res) => {
  try {
    const file = process.env.AUTO_ASSIGN_LOG_FILE;
    if (!DEMO_MODE && file && fs.existsSync(file)) {
      const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      return res.json({ source: 'live', entries });
    }
  } catch { /* fall through to the empty log */ }
  res.json({ source: DEMO_MODE ? 'demo' : 'none', entries: DEMO_MODE ? require('./services/demo/rmModel').autoAssignActivity() : [] });
});

app.get('/api/delinquency', requireTenantAccess, async (req, res) => {
  try {
    const q = String(req.query.q || req.query.search || '').trim().toLowerCase();
    const entity = String(req.query.entity || '').trim();
    const property = String(req.query.property || '').trim();
    const minBalance = numberValue(req.query.minBalance || req.query.min || 0);
    const status = String(req.query.status || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 5000);

    // SINGLE SOURCE OF TRUTH: RM report 85 (see services/delinquencyReport.js).
    // Everything on the Delinquency tab — KPI tiles, entity chart, entity
    // summary table and the tenant list — reads this one endpoint, so the tab
    // can no longer show two different delinquency numbers. The per-tenant rows
    // sum exactly to RM's own official "Delinquent Amount".
    const report = await delinquencyReport.getDelinquency();
    if (report.configured === false) {
      // No RM credentials (local/mock) — fall back to the tenant index so the
      // dev site still renders something.
      const rows = (await loadTenantRows({ ...req.query, pagesize: req.query.pagesize || 5000 }))
        .filter(tenant => tenant.amountOwed > 0)
        .map(tenant => ({
          tenant: tenant.name, tenantId: tenant.id, account: tenant.account,
          unit: tenant.unit, property: tenant.property, entity: tenant.entity,
          status: tenant.status, amount: tenant.amountOwed, futureChargeAmount: 0,
        }));
      const amt = rows.reduce((s, r) => s + r.amount, 0);
      return res.json({
        source: 'mock', count: rows.length, returned: rows.length,
        totals: {
          amount: Math.round(amt * 100) / 100, tenants: rows.length,
          currentAmount: Math.round(amt * 100) / 100, currentTenants: rows.length,
          pastAmount: 0, pastTenants: 0, futureExcludedAmount: 0, futureExcludedTenants: 0,
        },
        items: rows,
      });
    }

    let items = report.items;
    if (property) items = items.filter(i => i.property === property);
    if (entity) items = items.filter(i => i.entity === entity);
    if (minBalance) items = items.filter(i => i.amount >= minBalance);
    if (status) items = items.filter(i => i.status.toLowerCase() === status);
    if (q) items = items.filter(i => `${i.tenant} ${i.unit} ${i.property} ${i.entity} ${i.account || ''}`.toLowerCase().includes(q));

    // Unfiltered totals come straight from the report so they always tie to RM;
    // any active filter means the totals describe the filtered subset instead.
    const filtered = Boolean(property || entity || minBalance || status || q);
    const amount = filtered ? Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100 : report.totals.amount;
    const tenantCount = filtered ? items.length : report.totals.tenants;

    res.json({
      source: 'rent-manager-report-85',
      asOf: report.asOf,
      graceDays: report.graceDays,
      refreshedAt: report.refreshedAt,
      official: report.official,
      tiesToOfficial: report.tiesToOfficial,
      count: items.length,
      returned: Math.min(items.length, limit),
      totals: {
        amount,
        tenants: tenantCount,
        currentAmount: amount,
        currentTenants: tenantCount,
        pastAmount: 0,
        pastTenants: 0,
        futureExcludedAmount: 0,
        futureExcludedTenants: 0,
      },
      byEntity: report.byEntity,
      byProperty: report.byProperty,
      items: items.slice(0, limit),
    });
  } catch (err) {
    res.status(502).json({ error: publicErrorMessage(err) });
  }
});

app.get('/api/entities', (req, res) => {
  res.json(mockData.entities);
});

app.get('/api/overview', (req, res) => {
  res.json(mockData.overview);
});

// ── DEBT SERVICE (services/debtService.js) ────────────────────────────────────
// Year to date by building: mortgage interest from the P&L snapshot, principal
// from Report 51 on the mortgage loan accounts. A snapshot like everything else:
// serve the last pull, refresh on the button and the weekly schedule.
const debtService = require('./services/debtService');
function buildDebtService() {
  return debtService.build({
    rentManager,
    loadPL() {
      const snap = propertyFinancials.loadSnapshot();
      if (!snap) return null;
      const { accounts, ...rest } = snap;
      return propertyMerges.apply(rest);
    },
    primaryOf: pid => propertyMerges.primaryOf(pid),
    propertyEntityMap: () => buildPropertyEntityMap(rentManager),
    glDetail: args => glTransactions.getGLDetail(args),
  });
}

const debtServiceCache = snapshotCache.makeSnapshotCache({
  name: 'debt-service',
  file: 'debt-service-cache.json',
  build: buildDebtService,
  isOutdated: debtService.isOutdated,   // the old build's empty snapshots rebuild on next read
});

app.get('/api/debt-service', async (req, res) => {
  if (!rentManager.isConfigured()) {
    return res.json(mockData.debtService || { interest: 0, principal: 0, total: 0, by_property: [] });
  }
  try {
    const snap = debtServiceCache.getFresh();
    if (snap) return res.json({ cached: true, refreshedAt: snap.refreshedAt, ...snap.data });
    const built = await debtServiceCache.refresh();
    return res.json({ cached: false, refreshedAt: built.refreshedAt, ...built.data });
  } catch (err) {
    console.error('debt-service error:', err.message);
    res.status(502).json({ error: publicErrorMessage(err) });
  }
});

// ── Past contract analyses (Scanner tab history) ─────────────────────────────
// Kept in memory only (newest first, capped at 50). In the demo it resets on restart;
// a real install would persist this to a database or the data/ disk.
const contractHistory = [];
app.get('/api/contracts-history', (req, res) => res.json(contractHistory));
app.post('/api/contracts-history', (req, res) => {
  const entry = { id: crypto.randomUUID(), ...(req.body || {}) };
  contractHistory.unshift(entry);
  contractHistory.length = Math.min(contractHistory.length, 50);
  res.json({ ok: true, id: entry.id });
});
app.delete('/api/contracts-history', (req, res) => {
  const i = contractHistory.findIndex(e => e.id === String(req.query.id || ''));
  if (i >= 0) contractHistory.splice(i, 1);
  res.json({ ok: true });
});

app.post('/api/analyze-contract', async (req, res) => {
  const { text, pdf_base64 } = req.body;
  if (!text?.trim() && !pdf_base64) return res.status(400).json({ error: 'No contract provided' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Demo without a key: a sample analysis of a fictional lease, so the tab still shows what it produces.
  if (!apiKey && DEMO_MODE) {
    return res.json({ json: require('./services/contractDemo').sampleAnalysis(), model: 'demo-sample', usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 }, demo: true });
  }
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });

  try {
    const result = await contractScanner.analyzeContract(apiKey, { pdfBase64: pdf_base64, text });
    if (!result.json) {
      const why = result.stopReason === 'max_tokens' ? 'the response was cut off' : 'the response was not valid JSON';
      return res.status(502).json({ error: `Contract analysis failed: ${why}. Try again.` });
    }
    res.json({ json: result.json, model: result.model, usage: uwUsageFromReply(result.usage) });
  } catch (err) {
    res.status(err.status || 500).json({ error: publicErrorMessage(err) });
  }
});

// ── ASK PANEL (services/assistant.js) ─────────────────────────────────────────
// A question about the open page, answered by Claude from the page snapshot the
// browser sends. The answer streams back as newline-delimited JSON:
//   {"t":"text","v":"…"}  a piece of the answer
//   {"t":"status","v":"…"} a lookup is running (what it is reading)
//   {"t":"done"}          finished (with the answer's token use)
//   {"t":"error","v":"…"} stopped; v says why
// Capped per person per hour: every question is a paid API call, and a stuck
// retry loop in a browser tab should not be able to run up the bill.
const ASK_LIMIT_PER_HOUR = 60;
const askCounts = new Map();   // person -> { count, windowStart }
function askAllowed(who) {
  const now = Date.now();
  const e = askCounts.get(who);
  if (!e || now - e.windowStart > 3600000) { askCounts.set(who, { count: 1, windowStart: now }); return true; }
  if (e.count >= ASK_LIMIT_PER_HOUR) return false;
  e.count += 1;
  return true;
}

// What the Ask panel's lookup tools read (services/assistantTools.js). Snapshots
// only — the same files the tabs serve — except glDetail, which is the Report 51
// pull a variance card makes. Functions, so each lookup sees the current file.
let _assistantPL = { raw: null, merged: null };
const assistantSources = {
  loadRawPL: () => propertyFinancials.loadSnapshot(),
  loadPL() {
    const raw = propertyFinancials.loadSnapshot();
    if (!raw) return null;
    if (_assistantPL.raw !== raw) {
      // The account trees are megabytes and no tool reads them; merge without them.
      const { accounts, ...rest } = raw;
      _assistantPL = { raw, merged: propertyMerges.apply(rest) };
    }
    return _assistantPL.merged;
  },
  idsFor: pid => propertyMerges.idsFor(pid),
  entityOfProperty: pid => (((propertyFinancials.loadSnapshot() || {}).properties || {})[pid] || {}).entity,
  loadUnits: () => unitCounts.loadSnapshot(),
  glDetail: args => glTransactions.getGLDetail(args),
  loadDelinquency: () => delinquencyReport.getStatus().cache,
  loadCohorts: () => billingCohorts.getStatus().cache,
  loadLiveOverview: () => loadLiveOverviewSnapshot(),
  loadVacancyHistory() { try { return JSON.parse(fs.readFileSync(VACANCY_HISTORY_FILE, 'utf8')); } catch { return []; } },
  loadBudget() { const set = budgetStore.loadSet(); const live = propertyFinancials.loadSnapshot(); return set && live ? budgetModel.overlayActuals(set, live) : set; },
  loadIssues() { const c = issuesFeed.get(); return c && c.data ? { ...c.data, refreshedAt: c.refreshedAt } : null; },
  loadDuplicatePayments() { const c = duplicatePayments.status().cache; return c && c.data ? c.data : c; },
  loadRenovations() { const c = renovationExpenses.get(); return c && c.data ? c.data : c; },
  loadDebtService() { const c = debtServiceCache.getFresh(); return c && c.data && c.data.version >= 4 ? { ...c.data, refreshedAt: c.refreshedAt } : null; },
  loadMoves: () => moveActivity.getStatus().cache,
};

app.post('/api/assistant', async (req, res) => {
  noStore(res);
  // Demo without a key: canned questions answered from the live fake data (services/assistantDemo.js).
  const demoCanned = DEMO_MODE && !assistant.isConfigured();
  if (!assistant.isConfigured() && !demoCanned) {
    return res.status(503).json({ error: 'The Ask panel needs ANTHROPIC_API_KEY set on the server.' });
  }
  const { question, history, context, flags } = req.body || {};
  if (typeof question !== 'string' || !question.trim()) return res.status(400).json({ error: 'Ask a question first.' });
  if (question.length > assistant.MAX_QUESTION_CHARS) {
    return res.status(400).json({ error: `Keep the question under ${assistant.MAX_QUESTION_CHARS.toLocaleString()} characters.` });
  }
  const who = (req.user && (req.user.email || req.user.name)) || req.ip;
  if (!askAllowed(who)) {
    return res.status(429).json({ error: `That's ${ASK_LIMIT_PER_HOUR} questions this hour — the limit resets within the hour.` });
  }

  res.status(200);
  res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.set('X-Accel-Buffering', 'no');   // The host's proxy would otherwise hold the stream
  const send = obj => res.write(JSON.stringify(obj) + '\n');
  // Stop paying for an answer nobody is waiting for (panel closed, tab gone).
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });

  if (demoCanned) {
    try {
      await require('./services/assistantDemo').streamDemoAnswer({
        question, user: req.user, sources: assistantSources, flags: Array.isArray(flags) ? flags.slice(0, 400) : null,
        onText: v => send({ t: 'text', v }), onStatus: v => send({ t: 'status', v }),
      });
      send({ t: 'done', model: 'demo-canned', usage: { lookups: 0 } });
    } catch (err) {
      console.error('Ask panel (demo) error:', publicErrorMessage(err));
      send({ t: 'error', v: 'The demo answer could not be generated. Try again in a moment.' });
    }
    return res.end();
  }

  try {
    const { stopReason, usage, toolCalls, model } = await assistant.streamAnswer({
      history, question, context, signal: ctrl.signal,
      user: req.user, sources: assistantSources,
      flags: Array.isArray(flags) ? flags.slice(0, 400) : null,
      onText: v => send({ t: 'text', v }),
      onStatus: v => send({ t: 'status', v }),
    });
    if (stopReason === 'refusal') send({ t: 'error', v: 'Claude declined to answer that one. Try rephrasing the question.' });
    else if (stopReason === 'max_tokens') send({ t: 'error', v: 'The answer hit its length limit and was cut off.' });
    // The answer's token use and lookups ride on the last line: the page ignores
    // them, and they are what an API bill is checked against.
    else send({ t: 'done', model, usage: { ...usage, lookups: toolCalls.length } });
    console.log(`Ask panel: ${who} on ${String(context && context.page)} — ${usage.input_tokens}+${usage.cache_read_input_tokens || 0} cached in, ${usage.output_tokens} out` +
      (toolCalls.length ? ` · tools: ${toolCalls.map(t => `${t.name} ${t.ms}ms${t.error ? ' (error)' : ''}`).join(', ')}` : ''));
  } catch (err) {
    if (ctrl.signal.aborted) return res.end();
    let msg = 'The answer could not be generated. Try again in a moment.';
    if (err instanceof Anthropic.RateLimitError) msg = 'Claude is rate-limited right now. Try again in a minute.';
    else if (err instanceof Anthropic.AuthenticationError) msg = 'The server’s Anthropic API key was rejected. Check ANTHROPIC_API_KEY on the host.';
    else if (err instanceof Anthropic.APIError) msg = `Claude API error (${err.status || 'no status'}). Try again in a moment.`;
    console.error('Ask panel error:', publicErrorMessage(err));
    send({ t: 'error', v: msg });
  }
  res.end();
});

// ── UNDERWRITING ──────────────────────────────────────────────────────────────
// Drop OM (PDF) + T12 + rent roll (Excel) → parse → human review on the tab →
// generate the underwriting model from the template. Parsing/generation run in
// Python (openpyxl); fast-facts need an Excel COM recalc, so on servers without
// Excel the endpoints degrade gracefully (workbook still generates + downloads).
const UW_DIR = path.join(__dirname, 'underwriting');
const UW_OUT = process.env.UNDERWRITING_DIR || path.join(__dirname, 'data', 'underwriting');   // override: scripts/checkUnderwritingDeals.js points it at a throwaway folder
const UW_PY  = process.env.UNDERWRITING_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

// ── DEMO MODE: the Claude-backed steps without an API key ─────────────────────
// The tab's reading steps (OM extraction, county tax and area occupancy lookups, PDF/Word rent rolls) call the Claude API.
// With DEMO_MODE=1 and no ANTHROPIC_API_KEY they answer from the fictional showcase deal (underwriting/sample/) instead of
// failing, so a visitor can click through "upload documents -> review -> build the model" offline. Spreadsheet rent rolls and
// T12s in the Rent Manager layout never needed the key: parsers.py reads them with no model. With a real key set, nothing here runs.
const UW_SAMPLE_DIR = path.join(UW_DIR, 'sample');
const uwDemoNoKey = () => DEMO_MODE && !process.env.ANTHROPIC_API_KEY;
const UW_DEMO_NOTE = 'Demo mode: sample data for a fictional property is shown here instead of a live Claude / web lookup (no API key is configured).';
function uwSampleJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(UW_SAMPLE_DIR, name), 'utf8')); } catch { return null; }
}
const UW_ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };

// One Python process at a time. Each loads a whole workbook or PDF (100-200 MB), and the host instance has 512 MB: three files
// dropped together, each peeked and parsed, started five of them at once and the site was killed and restarted (2026-10-22, 21:35 UTC,
// the second time that day). Waiting callers run in the order they asked; the timeout counts from when the process starts.
const UW_PY_MAX = Math.max(1, Number(process.env.UNDERWRITING_PY_CONCURRENCY) || 1);
let uwPyActive = 0;
const uwPyWaiting = [];
function runPython(script, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const start = () => {
      uwPyActive++;
      execFile(UW_PY, [path.join(UW_DIR, script), ...args],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          uwPyActive--;
          const next = uwPyWaiting.shift();
          if (next) next();
          if (err) {
            const detail = (stderr || err.message || '').split('\n').slice(-4).join(' ').trim();
            return reject(new Error(`${script} failed: ${detail}`));
          }
          resolve(stdout);
        });
    };
    if (uwPyActive < UW_PY_MAX) start(); else uwPyWaiting.push(start);
  });
}

// The underwriting scripts print one JSON document on stdout. A library that
// prints its own line first (current PyMuPDF announces "warning: The `fitz` API
// is deprecated" on stdout) turned that into "Unexpected token w" and failed the
// upload outright — 2026-09-22, the a two-building portfolio OM. Read the JSON even with
// stray lines around it, and say what the script actually printed when there is
// none to find.
function parsePyJson(stdout, script) {
  const out = String(stdout || '').trim();
  try { return JSON.parse(out); } catch { /* look for the JSON line below */ }
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* keep looking */ }
  }
  const first = lines.find(l => l.trim()) || '(no output)';
  throw new Error(`${script || 'underwriting script'} returned no readable result: ${first.slice(0, 200)}`);
}
async function runPythonJson(script, args, timeoutMs) {
  return parsePyJson(await runPython(script, args, timeoutMs), script);
}

function uwTempFile(name) {
  const safe = String(name || 'upload').replace(/[^A-Za-z0-9._ -]/g, '_');
  return path.join(os.tmpdir(), `uw-${crypto.randomBytes(6).toString('hex')}-${safe}`);
}

// ── Claude extraction cost tracking ──────────────────────────────────────────
// Every extraction call appends one line to data/underwriting/usage.jsonl
// (gitignored with the rest of data/underwriting). The tab shows the running
// average so the user always knows what a deal costs to process.
const UW_USAGE_FILE = path.join(UW_OUT, 'usage.jsonl');
const UW_MODEL = 'claude-sonnet-5';

function uwCostUsd(inputTokens, outputTokens, when = new Date()) {
  // Sonnet 5: $2/$10 per M tokens (intro) through 2026-08-31, then $3/$15
  const intro = when < new Date('2026-09-01T00:00:00Z');
  const inRate = intro ? 2 : 3, outRate = intro ? 10 : 15;
  return (inputTokens * inRate + outputTokens * outRate) / 1e6;
}

function uwRecordUsage(rec) {
  try {
    fs.mkdirSync(UW_OUT, { recursive: true });
    fs.appendFileSync(UW_USAGE_FILE, JSON.stringify(rec) + '\n');
  } catch (e) {
    console.error('usage tracking write failed:', e.message);
  }
}

function uwUsageFromReply(usage) {
  const input = (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0);
  const output = usage?.output_tokens || 0;
  return { input_tokens: input, output_tokens: output, cost_usd: Math.round(uwCostUsd(input, output) * 10000) / 10000 };
}

// Streaming Messages call — rent-roll extractions can emit 30-60K output
// tokens (every unit as JSON), far past what a non-streaming request allows
// without HTTP timeouts. Accumulates text deltas + usage, returns like the
// non-streaming shape: { text, usage }.
async function anthropicStreamText(apiKey, payload, timeoutMs = 600000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: ctrl.signal,
    });
    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      const e = new Error(err.error?.message || `Anthropic API error (${upstream.status})`);
      e.status = upstream.status;
      throw e;
    }
    let text = '';
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    let stopReason = null;
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(dataStr); } catch { continue; }
        if (ev.type === 'message_start' && ev.message?.usage) {
          Object.assign(usage, ev.message.usage);
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          text += ev.delta.text;
        } else if (ev.type === 'message_delta') {
          if (ev.usage?.output_tokens != null) usage.output_tokens = ev.usage.output_tokens;
          if (ev.usage?.server_tool_use?.web_search_requests != null) usage.web_search_requests = ev.usage.server_tool_use.web_search_requests;
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        } else if (ev.type === 'error') {
          throw new Error(ev.error?.message || 'Anthropic stream error');
        }
      }
    }
    return { text, usage, stopReason };
  } finally {
    clearTimeout(timer);
  }
}

function uwSalvageJson(text) {
  let t = String(text || '').replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  try { return JSON.parse(t); } catch { /* salvage below */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

// ── Hybrid rent-roll extraction: Claude maps columns, pandas moves the data ──
// Full-Claude extraction retypes every unit as JSON: slow (5-10 min), pricey
// (~$0.56-0.85/rent roll), and a 1,000-unit file exceeds the model's output
// ceiling outright. Instead, Claude reads a compact sample (sheet_sample.py)
// and returns a COLUMN MAPPING (a few hundred tokens); mapped_extract.py then
// walks every real row with pandas — fast, byte-accurate, no ceiling. Files
// the mapping can't express (multi-row-per-unit blocks, weird layouts) and
// all T12s fall back to the full-Claude path below.
const UW_MAP_SYSTEM_PROMPT = `You are a senior multifamily acquisitions analyst. You are given a compact SAMPLE of a spreadsheet exported from a property-management system: per-sheet markers with total row/column counts, then sampled rows labeled with their 1-based row numbers ("R12:"), cells separated by " | " in column order (column 1 first; empty cells still count). Rows may be omitted between samples.

Classify the document. If it is a RENT ROLL laid out one row per unit, return a COLUMN MAPPING; if it is a T12, return a ROW MAPPING. Deterministic code then extracts every value itself — you never retype data.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{"kind":"rent_roll"|"t12"|"unknown",
 "mappable":true|false,
 "meta":{"property_name":"","as_of_date":"YYYY-MM-DD"|null,"period":""|null,"source_format":"software/report name if identifiable"},
 "official":{"official_units":int|null,"official_occupied_units":int|null,"official_vacant_units":int|null,"official_occupancy":decimal 0-1|null},
 "warnings":["..."],
 "mapping":{  // rent_roll only
  "sheets":[{"name":"exact sheet name","data_start_row":int,"stop_markers":["..."],"skip":false}],
  "columns":{"unit_number":int,"unit_type":int|null,"sqft":int|null,"resident_id":int|null,"resident_name":int|null,"market_rent":int,"rent_charge":int,"total_charges":int|null,"move_in":int|null,"lease_expiration":int|null,"move_out":int|null,"balance":int|null,"status":int|null},
  "total_charges_sum_columns":[int]|null,
  "occupancy_source":"status"|"resident_name"|"rent_charge",
  "status_rules":{"exclude_contains":["..."],"vacant_contains":["..."]},
  "vacant_resident_names":["VACANT"]},
 "t12_mapping":{  // t12 only
  "sheet":"exact sheet name","month_header_row":int,"month_columns":[int],"total_column":int|null,"label_columns":[int],
  "fields":{"<field>":{"row":int,"flip_sign":false} | {"sum_rows":[int],"flip_sign":false} | null}}}

Rules:
- kind: rent roll = one record per unit/lease. t12 = trailing-12-month income statement (GL lines with monthly columns; sheets marked "T12-style" list every row's labels + row total). A broker's ACTUAL annual operating statement ("Financial Worksheet - Actual": one amount per line, no months) is also kind t12, mappable false. A pro forma / budget / projection is NEVER a t12 — kind unknown. A Rent Manager header such as "Book = Accrual,Budget (BA)" only names the accounting books the report was allowed to draw from, so judge by the COLUMNS, not that header: one set of monthly columns for a period that has already ended (compare it with today's date, given in the message) is actuals, not a budget. A budget or pro forma shows forecast months or separate budget/variance columns. Anything else = unknown, mappable false, kind/meta/warnings only.
- mappable=true ONLY when each unit is one spreadsheet row with the same columns on every data row. Multi-row-per-unit blocks (charge rows listed under each unit), pivoted or free-form layouts: mappable=false.
- Column indices are 1-based positions in the sample lines, counting empty cells.
- data_start_row: the labeled row number ("R8:" means 8) of the FIRST unit data row. Off-by-one here silently drops a unit — double-check against the sample.
- stop_markers: substrings of the row where unit data ENDS (summary blocks, totals, future-resident sections, report footers). The extractor stops at the first row containing any marker. If the report has a future-residents/applicants section, its section-header text MUST be a stop marker (or that data must be excluded via skip/status rules) — future residents are never units.
- Sheets with no current-unit data (future-resident sheets, summary-only sheets): skip:true.
- rent_charge = the actual/in-place rent column for the current resident. market_rent = asking/market rent. total_charges = total recurring monthly billing: a single total column if one exists, else list the individual charge columns in total_charges_sum_columns, else null (extractor repeats rent_charge).
- occupancy_source "status" when a unit/lease status column exists; then fill status_rules (case-insensitive substring match): exclude_contains = statuses whose rows must be DROPPED entirely because they are not current leases — applicant, future, pending (pending residents/renewals are duplicate future-lease rows for a unit that already has a current row), former, denied; vacant_contains = statuses meaning physically unoccupied (vacant, admin, down, model, non-rev, office — including "vacant leased"/"vacant rented", which are still vacant today); everything else counts occupied. A resident on NOTICE ("Notice", "Notice-Unrented", "Notice-Rented") is still living in the unit: it is OCCUPIED, so never put "notice" in vacant_contains (one property, 2026-10-22: its 99.5% occupancy read as 95.6% when "notice-unrented" was listed as vacant).
- occupancy_source "resident_name" when there is no status column and vacancy shows in the name column (fill vacant_resident_names with the placeholder(s) used, e.g. "VACANT"; MODEL/OFFICE units also count unoccupied). "rent_charge": occupied = in-place rent > 0.
- official values: copy ONLY from an explicit summary/totals line visible in the sample; otherwise null. NEVER derive them yourself — in particular, never report a data-row count as official_units: reports often show the same unit on multiple rows (pending renewals, applicants), so row count > unit count. official_occupancy as a decimal.
- as_of_date: the report's as-of date, not the print/run date.
- Add warnings for anything unusual: no sqft column, ambiguous rent columns, sections you can infer but cannot see in the sample, summary counts that look inconsistent.

T12 row-mapping rules (kind "t12", mappable true when the statement has one GL line per row and month columns):
- month_columns / total_column / label_columns are 1-based column indices from the head rows of the sample; label_columns = the account-code and description columns (in that order).
- fields: map EACH of gross_potential_rent, vacancy_concessions_bad_debt, net_rental_income, other_income, effective_gross_income, controllable_expenses, utilities, management_fee_actual, insurance, property_taxes_actual, other_property_expenses, total_operating_expenses, net_operating_income, actual_vacancy_loss, actual_bad_debt, actual_concessions to statement rows. Prefer the statement's own total/subtotal row ({"row":N}); use {"sum_rows":[...]} only when no subtotal line exists for that bucket. null when the statement genuinely has no such amount (then add a warning).
- ALSO map, when the statement breaks controllable expenses into sub-sections, each of: repairs_maintenance, turnover_costs, labor_costs (payroll), advertising_promotions, general_admin. These five must sum to controllable_expenses; put a sub-section under exactly one of them. If the statement has no such breakdown, set them null WITHOUT a warning — they are optional.
- Bucket meanings (labels vary by vendor): gross_potential_rent = gross potential/scheduled/market rent incl. gain/loss-to-lease if the statement folds it there; vacancy_concessions_bad_debt = ALL rent deductions (vacancy + concessions + bad debt + non-revenue units); net_rental_income = GPR + those deductions; other_income = ancillary income; effective_gross_income = total income; utilities; management_fee_actual; insurance; property_taxes_actual = real-estate taxes; controllable_expenses = payroll + R&M/turnover + contract services + admin + marketing (everything EXCEPT utilities/mgmt/insurance/taxes); other_property_expenses = remaining operating expense outside those buckets (null/0 if none — NEVER dump utilities or taxes here). actual_vacancy_loss / actual_bad_debt / actual_concessions = the individual line items when identifiable.
- Sign convention: income and expenses positive; vacancy_concessions_bad_debt and the three actual_* deduction fields negative. Set flip_sign true on any field whose statement rows carry the opposite sign (e.g. deductions shown positive, or an expense section shown negative).
- Never map the same dollars into two buckets. The result must tie: EGI - total OpEx = NOI, and the six expense buckets must sum to total OpEx. If the statement's own subtotals do not tie, map the statement faithfully and add a warning naming the discrepancy.
- Watch for: partial-year statements (fewer than 12 month columns — warn), a Total column that is actually a budget/variance column, commercial income mixed in.`;

const UW_EXTRACT_SYSTEM_PROMPT = `You are a senior multifamily acquisitions analyst. You are given the raw text of a spreadsheet exported from a property management or accounting system — the vendor and layout vary (Rent Manager, Yardi, RealPage, AppFolio, AION, QuickBooks-style statements, broker workbooks). First decide whether it is a RENT ROLL (one record per unit/lease) or a T12 (trailing-12-month income statement: GL line items with monthly columns). A broker's ACTUAL annual operating statement (one amount per line, no monthly columns — e.g. "Financial Worksheet - Actual") also counts as a T12: use its annual amounts and warn that there is no monthly detail. A pro forma, budget or projection is NOT a T12 — return kind "unknown" and say so. A Rent Manager header such as "Book = Accrual,Budget (BA)" only names the accounting books the report was allowed to draw from, so judge by the COLUMNS, not that header: one set of monthly columns for a period that has already ended (compare it with today's date, given in the message) is actuals, not a budget. A budget or pro forma shows forecast months or separate budget/variance columns. Then extract.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{"kind":"rent_roll"|"t12"|"unknown","meta":{"property_name":"","period":"","source_format":"one phrase naming the software/report if identifiable"},"warnings":["..."],"data":{...}}

If kind is "rent_roll", data = {
  "as_of_date":"YYYY-MM-DD or null",
  "official_units":int|null,"official_occupied_units":int|null,"official_vacant_units":int|null,"official_occupancy":decimal 0-1|null,
  "units":[{"unit_number":"","unit_type":"","sqft":num,"resident_id":str|null,"resident_name":str|null,"market_rent":num,"rent_charge":num,"total_charges":num,"move_in":"YYYY-MM-DD"|null,"lease_expiration":"YYYY-MM-DD"|null,"move_out":"YYYY-MM-DD"|null,"balance":num,"occupied_flag":0|1}]
}
Rent roll rules:
- One entry per rentable unit. Include EVERY unit in the report — never truncate, sample, or summarize. A 300-unit report means 300 entries.
- rent_charge = the actual/in-place rent the current resident pays (0 if vacant). market_rent = the asking/market rent for the unit.
- total_charges = total recurring monthly charges for the unit if the report shows them; otherwise repeat rent_charge.
- occupied_flag = 1 only when a current resident is in place. Vacant, admin/down, model, and applicant/future-resident rows get 0 (and applicants/future residents are EXCLUDED from units[] entirely, as are summary/total rows).
- unit_type = the floorplan/unit-type code as shown.
- official_* fields: ONLY from an explicit summary block in the report. If the report has none, derive counts from the unit rows, and add a warning that they were derived rather than reported.
- Dates ISO. Numbers plain (no $ signs, no thousands separators).

If kind is "t12", data = {
  "gross_potential_rent":num,"vacancy_concessions_bad_debt":num,"net_rental_income":num,"other_income":num,"effective_gross_income":num,
  "controllable_expenses":num,"utilities":num,"management_fee_actual":num,"insurance":num,"property_taxes_actual":num,"other_property_expenses":num,
  "repairs_maintenance":num|null,"turnover_costs":num|null,"labor_costs":num|null,"advertising_promotions":num|null,"general_admin":num|null,
  "total_operating_expenses":num,"net_operating_income":num,
  "actual_vacancy_loss":num|null,"actual_bad_debt":num|null,"actual_concessions":num|null
}
T12 rules:
- Use 12-month totals: the statement's own Total column when present, otherwise sum the monthly columns.
- Sign convention: income and expenses are POSITIVE; rent deductions (vacancy_concessions_bad_debt, actual_vacancy_loss, actual_bad_debt, actual_concessions) are NEGATIVE.
- Map the statement's sections onto these buckets (labels vary by vendor):
  gross_potential_rent = gross potential / scheduled / market rent total (including gain/loss-to-lease if the statement folds it there — otherwise fold loss-to-lease into vacancy_concessions_bad_debt and say so in a warning);
  vacancy_concessions_bad_debt = total rent deductions: vacancy + concessions + bad debt + non-revenue/model/office units;
  net_rental_income = GPR + those (negative) deductions; other_income = all ancillary/other income; effective_gross_income = total income;
  utilities; management_fee_actual; insurance; property_taxes_actual = real-estate property taxes;
  controllable_expenses = payroll + repairs/maintenance/turnover + contract services + admin + marketing (everything EXCEPT utilities, management fees, insurance, taxes);
  repairs_maintenance / turnover_costs / labor_costs / advertising_promotions / general_admin = the controllable sub-sections when the statement breaks them out (they must sum to controllable_expenses; each section under exactly one). If the statement has no such breakdown, use null for all five WITHOUT a warning — they are optional;
  other_property_expenses = whatever operating expense remains outside those buckets (0 if none — this field grows 3%/yr in the model, so never dump utilities or taxes here).
- actual_vacancy_loss / actual_bad_debt / actual_concessions: the individual line-item totals when identifiable, else null.
- Tie-out check before answering: EGI - total OpEx must equal NOI within rounding, and the expense buckets must sum to total OpEx within rounding. If the statement itself does not tie, report the statement's numbers and add a warning naming the discrepancy — NEVER invent or plug numbers.
- If a field genuinely does not exist in the statement, use null and add a warning.
- Also warn about: partial-year statements, fewer/more than 12 monthly columns, cash vs accrual notes, commercial income mixed in.

If the document is neither (e.g. a portfolio P&L spanning many properties, a budget, a delinquency report), return kind "unknown" with a warning explaining what it actually is.`;

// Parse an uploaded T12 / rent roll Excel export via Claude extraction.
// Any vendor's format works — the spreadsheet is flattened to text and the
// model classifies + extracts into the deal schema, with warnings surfaced
// on the review screen.
// A rent-roll extraction whose unit count contradicts the report's own stated
// official count -> {official, parsed}, else null. Only trust an explicit
// official figure (> 0); a derived/absent one can't gate anything.
function uwCountMismatch(data) {
  const official = data?.official_units;
  const parsed = data?.units?.length;
  if (typeof official === 'number' && official > 0 &&
      typeof parsed === 'number' && parsed !== official) {
    return { official, parsed };
  }
  return null;
}

app.post('/api/underwriting/parse', async (req, res) => {
  const { filename, data, forceFull } = req.body || {};
  // `want` = the slot the file was dropped on. A broker workbook often carries
  // the rent roll, the actual P&L, a pro forma and condition notes as separate
  // tabs; the slot decides which tab is read (underwriting/sheet_pick.py).
  const want = ({ rr: 'rent_roll', rent_roll: 'rent_roll', t12: 't12' })[req.body?.want] || null;
  if (!data) return res.status(400).json({ error: 'No file data provided' });
  // No key is only a problem once a model path is needed: a fixed-layout Rent Manager export is read by parsers.py without one.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // CSV / TSV exports (Rent Manager, Yardi and AppFolio all offer them) are turned
  // into a one-tab workbook first so every reader below sees the file it expects.
  // Before 2026-10-21 a CSV was refused outright.
  const isCsv = /\.(csv|tsv|txt)$/i.test(String(filename || ''));
  let original = uwTempFile(filename);
  const csvSource = isCsv ? original : null;
  let tmp = original;
  let detFallback = null;  // hoisted so the outer catch can fall back to it
  // Every successful answer carries which tab was read, and what else the
  // workbook holds, so the page can say so and offer the other slot.
  let workbook = null;
  const sendJson = res.json.bind(res);
  res.json = body => {
    if (!workbook || !body || body.error) return sendJson(body);
    const note = workbook.picked.length
      ? `Read the "${workbook.picked.join('", "')}" tab${workbook.picked.length > 1 ? 's' : ''} of this workbook` +
        (workbook.others.length ? ` (also in it: ${workbook.others.join(', ')}).` : '.')
      : null;
    return sendJson({ ...body, workbook, warnings: note ? [note, ...(body.warnings || [])] : body.warnings });
  };
  try {
    fs.writeFileSync(original, Buffer.from(data, 'base64'));
    if (isCsv) {
      const xlsx = uwTempFile('from-csv.xlsx');
      const conv = await runPythonJson('csv_to_xlsx.py', [original, xlsx]);
      if (conv.error) { fs.unlink(xlsx, () => {}); return res.status(422).json({ error: conv.error }); }
      original = xlsx; tmp = xlsx;
    }

    if (want) {
      const picked = uwTempFile('tab.xlsx');
      try {
        const pick = await runPythonJson('sheet_pick.py', [original, want, picked]);
        if (!pick.error && pick.sheets && pick.sheets.length > 1) {
          workbook = {
            sheets: pick.sheets,
            picked: pick.picked || [],
            others: pick.sheets.filter(t => !(pick.picked || []).includes(t.name)).map(t => t.name),
            has: {
              rent_roll: pick.sheets.some(t => t.kind === 'rent_roll'),
              t12: pick.sheets.some(t => t.kind === 't12'),
            },
          };
          if (pick.split) tmp = picked;
          else if (!workbook.picked.length) {
            fs.unlink(picked, () => {});
            const label = want === 't12' ? 'P&L / T12' : 'rent roll';
            return res.status(422).json({
              error: `No ${label} tab found in this workbook. Its tabs: ${pick.sheets.map(t => `${t.name} (${t.kind.replace(/_/g, ' ')})`).join(', ')}.`,
              workbook,
            });
          }
        } else {
          fs.unlink(picked, () => {});
        }
      } catch (err) {
        fs.unlink(picked, () => {});   // tab pick is a narrowing step — never sink the parse
      }
    }

    // Deterministic pre-pass (zero tokens, no model): the standard RM
    // "Rent Roll with Lease Charges" and "12 Month Trailing Income Statement"
    // exports have a fixed layout that parsers.py reads exactly. This is the
    // path a multi-row charge-block rent roll (e.g. a large property, ~2,900 rows of
    // per-unit charge blocks) needs — the column-mapping fast path below
    // assumes one row per unit and can't map it, so without this it silently
    // falls through to the 128K-token full extraction and burns minutes of
    // model time. forceFull (a recheck) deliberately skips this to re-derive
    // via the model. Any miss/failure falls through to the model paths.
    // A low-confidence deterministic rent-roll parse (missing per-unit charge
    // totals, or a parsed-vs-summary unit-count mismatch) means the property's
    // export layout drifts from the standard RM shape parsers.py assumes — the
    // exact "formatting changed" failure. Rather than return possibly-wrong
    // numbers for free, we fall through to the AI extraction path for a cleaner
    // read, and keep this parse as a fallback if the AI path also fails.
    if (!forceFull || !apiKey) {
      try {
        const det = await runPythonJson('parsers.py', [tmp]);
        const ok = det && (
          (det.kind === 'rent_roll' && det.data?.units?.length) ||
          (det.kind === 't12' && det.data?.net_operating_income != null));
        if (ok) {
          const warns = det.warnings || [];
          // A T12 whose layout is not the Rent Manager standard (one property, 2026-10-22: insurance and taxes under
          // "Fixed Expenses") reads its NOI and income but misses GPR, utilities, insurance, taxes and total expenses -
          // and used to be accepted with only a warning, which would have built a model with those buckets empty.
          // Like a rent roll that does not tie, it goes to the AI mapping for a complete read instead, and this
          // partial parse stays as the fallback if that fails.
          const lowConfidence = (det.kind === 'rent_roll' && warns.some(w =>
            /no 'Total' charges row found/.test(w) || /but report summary says/.test(w))) ||
            (det.kind === 't12' && warns.some(w => /T12 lines not found/.test(w) || /T12 does not tie out/.test(w) || /expense buckets sum to/.test(w)));
          const meta = Object.assign({}, det.meta, { extraction_method: 'deterministic (openpyxl)' });
          if (det.kind === 'rent_roll') meta.parsed_units = det.data.units.length;
          if (!lowConfidence) {
            const zero = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
            uwRecordUsage({ ts: new Date().toISOString(), endpoint: 'parse', kind: det.kind, method: 'deterministic', filename: filename || null, model: null, ...zero });
            return res.json({ kind: det.kind, meta, warnings: warns, data: det.data, usage: zero });
          }
          detFallback = { kind: det.kind, meta, warnings: warns, data: det.data };
        }
      } catch (err) {
        // not a recognized fixed-layout export — fall through to the model paths
      }
    }

    if (!apiKey) {
      if (detFallback) {
        uwRecordUsage({ ts: new Date().toISOString(), endpoint: 'parse', kind: detFallback.kind, method: 'deterministic-fallback', filename: filename || null, model: null, ...UW_ZERO_USAGE });
        return res.json({ kind: detFallback.kind, meta: detFallback.meta, data: detFallback.data, usage: UW_ZERO_USAGE,
          warnings: ['No Claude API key is configured, so the AI re-read was skipped; showing the standard-layout parse. Verify the flagged lines before generating.', ...(detFallback.warnings || [])] });
      }
      return res.status(DEMO_MODE ? 422 : 500).json({ error: DEMO_MODE
        ? 'Demo mode: this file is not a standard Rent Manager export, and reading other layouts needs the Claude API, which is switched off in this demo. Use "Try with sample documents" above, or drop a Rent Manager "Rent Roll" / "12 Month Trailing Income Statement" Excel export.'
        : 'ANTHROPIC_API_KEY is not configured on the server' });
    }

    // Fast path: Claude maps columns from a small sample; pandas extracts
    // every row. Falls through to full extraction on any failure.
    // forceFull=true skips this and always uses the slower full-Claude
    // extraction — used to independently re-verify a flagged number.
    const mapUsage = { input_tokens: 0, output_tokens: 0 };
    const mapWarnings = [];
    if (detFallback) mapWarnings.push(detFallback.kind === 't12'
      ? 'Standard-layout parse of this T12 was incomplete (expense or income lines it expected were not found) — re-read it with AI extraction.'
      : 'Standard-layout parse was low-confidence (missing charge totals or a unit-count mismatch) — re-read this rent roll with AI extraction.');
    if (forceFull) mapWarnings.push('Recheck requested: used full extraction (column-mapping fast path skipped) for an independent cross-check.');
    try {
      if (forceFull) throw Object.assign(new Error(''), { __skipSilently: true });
      const sample = await runPythonJson('sheet_sample.py', [tmp]);
      if (!sample.error && sample.text && sample.chars >= 40) {
        // One mapping round: Claude maps columns (a few hundred tokens), pandas
        // extracts every row. `corrective` is appended on the 2nd round only, to
        // steer the count. Returns { map, out, mappable }; out is null if the
        // layout isn't mappable or the deterministic extract came back empty.
        const mapRound = async (corrective) => {
          const reply = await anthropicStreamText(apiKey, {
            model: UW_MODEL,
            max_tokens: 4000,
            // Without this the model spent the whole 4,000 tokens thinking and returned no text (one property's T12, 2026-10-22), so a mappable
            // layout silently fell through to the slow full read, which has none of the mapped path's checks.
            thinking: { type: 'disabled' },
            system: UW_MAP_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: `File name: ${filename || 'workbook'}\nToday's date: ${new Date().toISOString().slice(0, 10)}.${corrective || ''}\n\n${sample.text}` }],
          }, 180000);
          mapUsage.input_tokens += (reply.usage?.input_tokens || 0) + (reply.usage?.cache_creation_input_tokens || 0) + (reply.usage?.cache_read_input_tokens || 0);
          mapUsage.output_tokens += reply.usage?.output_tokens || 0;
          const map = uwSalvageJson(reply.text);
          const mappable = (map?.kind === 'rent_roll' && map.mappable && map.mapping) ||
                           (map?.kind === 't12' && map.mappable && map.t12_mapping);
          if (!mappable) return { map, out: null, mappable: false };
          const mapTmp = uwTempFile('mapping.json');
          try {
            fs.writeFileSync(mapTmp, JSON.stringify(map));
            const out = await runPythonJson('mapped_extract.py', [tmp, mapTmp]);
            const ok = map.kind === 'rent_roll' ? out?.data?.units?.length : out?.data?.net_operating_income != null;
            return { map, out: ok ? out : null, mappable: true };
          } finally {
            fs.unlink(mapTmp, () => {});
          }
        };

        let { map, out, mappable } = await mapRound('');
        if (!map) {
          // the reply was not valid JSON (a stray brace after "warnings" on one property's T12): ask once more rather than fall to the full read
          ({ map, out, mappable } = await mapRound('\n\nYour previous reply was not valid JSON. Return ONLY one valid JSON object in the shape described, with every brace and quote balanced and no text outside it.'));
        }
        // A T12 whose mapped columns do not reproduce the statement's own totals is not accepted (one property: two of twelve month
        // columns mapped, NOI $305K against the statement's $1,869K). Re-map once, naming what did not tie; if it still does not, the
        // slower full read is used and says so.
        const tieOut = o => o && o.kind === 't12' ? (o.warnings || []).find(w => /^Tie-out:/.test(w)) : null;
        if (out && tieOut(out)) {
          const why = tieOut(out);
          const retry = await mapRound(`\n\nIMPORTANT: your first mapping did not reproduce the statement: ${why} Map EVERY month column in the header row (all twelve) and the Total column, and use the statement's own NOI line.`);
          if (retry.out && !tieOut(retry.out)) {
            out = retry.out; map = retry.map;
            mapWarnings.push('The first column mapping did not tie out to the statement; it was re-mapped once and now does.');
          } else {
            mapWarnings.push(`Column mapping did not tie out to the statement (${why}) - used full extraction.`);
            out = null; mappable = false; map = null;
          }
        }
        if (out) {
          let mm = out.kind === 'rent_roll' ? uwCountMismatch(out.data) : null;
          let reconciled = false;
          if (mm) {
            // Count contradicts the report's own summary — almost always future-
            // residents/applicant or duplicate renewal rows the mapping swept in.
            // Re-map ONCE with the exact target (cheap, seconds) rather than a slow
            // full re-read; the corrected mapping's stop/skip rules fix the count.
            const corrective = `\n\nIMPORTANT: A first mapping extracted ${mm.parsed} units, but this report's own summary states EXACTLY ${mm.official} current units. Correct the mapping so exactly ${mm.official} units extract: add stop_markers for any future-residents / applicant / waitlist section, and set status or skip rules to drop duplicate rows for the same unit (e.g. a pending renewal listed twice). Return the corrected mapping.`;
            const retry = await mapRound(corrective);
            if (retry.out && retry.out.kind === 'rent_roll' && !uwCountMismatch(retry.out.data)) {
              out = retry.out; reconciled = true; mm = null;
              mapWarnings.push(`Auto-reconciled to the report's ${out.data.official_units} units after a corrective re-map.`);
            } else {
              const got = retry.out?.data?.units?.length;
              mapWarnings.push(`Column mapping parsed ${mm.parsed} units but the report says ${mm.official}${got != null && got !== mm.parsed ? ` (corrective re-map got ${got})` : ''} — verify the unit list before generating.`);
            }
          }
          const u = uwUsageFromReply(mapUsage);
          uwRecordUsage({ ts: new Date().toISOString(), endpoint: 'parse', kind: out.kind, method: reconciled ? 'mapped-reconciled' : 'mapped', filename: filename || null, model: UW_MODEL, ...u });
          const meta = Object.assign({}, out.meta);
          if (out.kind === 'rent_roll') meta.parsed_units = out.data.units.length;
          // drop mapped_extract's own count-mismatch note; mapWarnings now owns that story
          const outWarns = (out.warnings || []).filter(w => !/report summary says/.test(w));
          return res.json({ kind: out.kind, meta, warnings: [...mapWarnings, ...outWarns], data: out.data, usage: u });
        }
        if (mappable) {
          mapWarnings.push('Mapped extraction returned nothing usable — used full extraction instead.');
        } else if (map?.kind === 'rent_roll' || map?.kind === 't12') {
          mapWarnings.push(`${map.kind === 't12' ? 'T12' : 'Rent roll'} layout is not row/column-mappable — used full extraction.`);
        }
        // unknown: the full path below classifies and extracts as before
      }
    } catch (err) {
      if (!err.__skipSilently) mapWarnings.push(`Column-mapping pass failed (${publicErrorMessage(err)}) — used full extraction.`);
    }

    const sheet = await runPythonJson('sheet_text.py', [tmp]);
    if (sheet.error) return res.status(422).json({ error: sheet.error });
    if (!sheet.text || sheet.chars < 40) return res.status(422).json({ error: 'Workbook appears to be empty.' });

    // Guardrail: this last-resort path retypes every unit as JSON and is the
    // only place a bad/unmappable file can run away. Bound both blast radii —
    // a 5-min hard timeout (was the effective runaway window) and a 64K output
    // ceiling (~1,000 units at 50-60 tokens each; documented extractions run
    // 30-60K) so it fails fast and cheap instead of grinding. The fixed-layout
    // RM exports never reach here now — the deterministic pre-pass caught them.
    const { text, usage, stopReason } = await anthropicStreamText(apiKey, {
      model: UW_MODEL,
      max_tokens: 64000,
      system: UW_EXTRACT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `File name: ${filename || 'workbook'}\nToday's date: ${new Date().toISOString().slice(0, 10)}.\n\n${sheet.text}` }],
    }, 300000);

    const parsed = uwSalvageJson(text);
    if (!parsed || !parsed.kind) {
      return res.status(502).json({ error: 'Extraction returned unparseable output', stop_reason: stopReason, raw: String(text).slice(0, 1500) });
    }
    if (stopReason === 'max_tokens') {
      parsed.warnings = [...(parsed.warnings || []), 'Extraction hit the output limit — the unit list may be incomplete. Verify the parsed unit count against the report.'];
    }
    if (mapWarnings.length) parsed.warnings = [...mapWarnings, ...(parsed.warnings || [])];
    // bill the (small) mapping attempt into this extraction's usage record
    if (mapUsage) {
      usage.input_tokens += (mapUsage.input_tokens || 0) + (mapUsage.cache_creation_input_tokens || 0) + (mapUsage.cache_read_input_tokens || 0);
      usage.output_tokens += mapUsage.output_tokens || 0;
    }
    const u = uwUsageFromReply(usage);
    uwRecordUsage({ ts: new Date().toISOString(), endpoint: 'parse', kind: parsed.kind, method: 'full', filename: filename || null, model: UW_MODEL, ...u });

    const meta = Object.assign({}, parsed.meta);
    if (parsed.kind === 'rent_roll') meta.parsed_units = (parsed.data?.units || []).length;
    // Exact-match gate on the full path too: never quietly ship a unit list that
    // contradicts the report's own official count.
    const fullMm = parsed.kind === 'rent_roll' ? uwCountMismatch(parsed.data) : null;
    if (fullMm) {
      parsed.warnings = [`Parsed ${fullMm.parsed} units but the report says ${fullMm.official} — verify the unit list before generating.`, ...(parsed.warnings || [])];
    }
    // The full-Claude path only extracts bucket totals — no GL-level monthly
    // detail — so a model generated from it had an EMPTY "raw monthly account
    // detail" audit table (one property, 2026-07-22: T12 summary
    // landed, actuals table blank). Backfill it deterministically: a zero-token
    // grid dump of the statement's monthly rows.
    if (parsed.kind === 't12' && parsed.data && !(parsed.data.raw_monthly_detail || []).length) {
      try {
        const dump = await runPythonJson('parsers.py', [tmp, '--dump-raw']);
        if ((dump.raw_monthly_detail || []).length) {
          parsed.data.raw_monthly_detail = dump.raw_monthly_detail;
          if ((dump.month_headers || []).some(h => h)) parsed.data.month_headers = dump.month_headers;
          meta.detail_rows = dump.raw_monthly_detail.length;
        } else {
          parsed.warnings = [...(parsed.warnings || []), 'No GL-level monthly grid could be read from this statement — the model\'s raw monthly detail table will be empty (summary numbers are unaffected).'];
        }
      } catch (e) { /* audit-table backfill only — never sink the parse */ }
    }
    res.json({ kind: parsed.kind, meta, warnings: parsed.warnings || [], data: parsed.data || {}, usage: u, error: parsed.kind === 'unknown' ? (parsed.warnings || []).join(' ') : undefined });
  } catch (err) {
    // AI path failed after a low-confidence deterministic parse — return that
    // parse rather than nothing, flagging that its numbers need a manual check.
    if (detFallback) {
      const zero = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      uwRecordUsage({ ts: new Date().toISOString(), endpoint: 'parse', kind: detFallback.kind, method: 'deterministic-fallback', filename: filename || null, model: null, ...zero });
      return res.json({
        kind: detFallback.kind,
        meta: detFallback.meta,
        warnings: [`AI re-read failed (${publicErrorMessage(err)}) — showing the standard-layout parse instead; verify the flagged units before generating.`, ...(detFallback.warnings || [])],
        data: detFallback.data,
        usage: zero,
      });
    }
    res.status(500).json({ error: publicErrorMessage(err) });
  } finally {
    fs.unlink(original, () => {});
    if (csvSource) fs.unlink(csvSource, () => {});
    if (tmp !== original) fs.unlink(tmp, () => {});
  }
});

// Extraction cost stats for the tab's cost panel
app.get('/api/underwriting/usage', (req, res) => {
  try {
    if (!fs.existsSync(UW_USAGE_FILE)) return res.json({ count: 0, total_cost_usd: 0, by_kind: {}, avg_deal_cost_usd: null, recent: [] });
    const lines = fs.readFileSync(UW_USAGE_FILE, 'utf8').split('\n').filter(Boolean);
    const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const byKind = {};
    let total = 0;
    for (const r of recs) {
      total += r.cost_usd || 0;
      const k = r.kind || r.endpoint || '?';
      const b = byKind[k] = byKind[k] || { count: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 };
      b.count += 1; b.cost_usd += r.cost_usd || 0;
      b.input_tokens += r.input_tokens || 0; b.output_tokens += r.output_tokens || 0;
    }
    // average cost of a full deal = avg rent roll + avg T12 + avg OM extraction
    let avgDeal = 0, have = 0;
    for (const k of ['rent_roll', 't12', 'om']) {
      if (byKind[k]?.count) { avgDeal += byKind[k].cost_usd / byKind[k].count; have++; }
    }
    res.json({
      count: recs.length,
      total_cost_usd: Math.round(total * 100) / 100,
      by_kind: Object.fromEntries(Object.entries(byKind).map(([k, b]) => [k, { ...b, cost_usd: Math.round(b.cost_usd * 10000) / 10000 }])),
      avg_deal_cost_usd: have ? Math.round(avgDeal * 100) / 100 : null,
      avg_deal_components: have,
      recent: recs.slice(-12).reverse(),
    });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  }
});

const OM_SYSTEM_PROMPT = `You are a senior multifamily acquisitions analyst. You are given the text of an Offering Memorandum (OM), page by page. Extract deal data for an underwriting model.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{
  "property": { "name": "", "address": "full street address with city/state/zip", "city": "", "year_built": 0, "site_acres": 0.0, "units": 0, "avg_unit_size_sf": 0 },
  "value_add": { "value_add_units": 0, "value_add_premium_per_unit_month": 0, "plan_note": "one sentence on the OM's renovation plan" },
  "tax": { "county_pin": "", "current_taxable_value": 0, "current_millage_rate": 0, "non_ad_valorem_tax": 0 },
  "properties": [ { "name": "", "address": "", "units": 0, "year_built": 0, "source_page": 0 } ],
  "asking_price": null,
  "rent_comps": [ { "property_name": "", "address_market": "", "units": 0, "year_built": 0, "avg_unit_size_sf": 0, "market_rent": 0, "achieved_rent": 0, "rent_psf": 0, "occupancy": 0.0, "source_status": "OM p.<page>", "notes": "" } ],
  "sale_comps": [ { "property_name": "", "location": "", "units": 0, "year_built": 0, "sale_date": "", "sale_price": 0, "price_per_unit": 0, "source": "OM p.<page>", "notes": "" } ],
  "confidence": { "<field path like property.units>": 0.0 to 1.0 },
  "source_pages": { "<field path>": page number the value came from }
}

Rules:
- Only report what the OM actually states. Use null for anything not found; never guess or infer numbers.
- Portfolio OMs (several buildings sold together): "property" describes the WHOLE deal — name = the portfolio/offering name, units = total units, address = the first property's address, year_built/avg_unit_size_sf as the OM states them for the portfolio (else null). List every building in "properties". For a single-property OM, "properties" has one entry.
- occupancy as a decimal (0.92 not 92).
- Include EVERY rent comp in the OM's comp set. OMs rarely have sale comps; empty array is normal.
- confidence reflects how explicit the OM is (1.0 = stated verbatim in a table; below 0.7 = you had to interpret).
- source_pages must reference the page markers in the input.`;

// Extract structured deal data from an OM PDF via Claude
app.post('/api/underwriting/om-extract', async (req, res) => {
  const { filename, data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'No file data provided' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && uwDemoNoKey()) {
    // Demo: the showcase deal's extracted facts, whatever OM was dropped (see the note on UW_DEMO_NOTE).
    const sample = uwSampleJson('riverbend-om-extracted.json');
    if (!sample) return res.status(503).json({ error: 'Demo mode: the sample OM facts are missing (underwriting/sample/riverbend-om-extracted.json).' });
    const { _meta, ...extracted } = sample;
    return res.json({ kind: 'om', meta: { pages: (_meta && _meta.pages) || 14, chars: (_meta && _meta.chars) || 0, truncated: false, image_pages: 0, image_pages_skipped: 0, source_kind: 'pdf', demo: true },
      extracted, usage: UW_ZERO_USAGE, demo_note: 'Demo mode: sample OM loaded. The facts, comps and value-add plan below are the fictional Riverbend Apartments OM, not read from the file you dropped (no Claude API key is configured).' });
  }
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });

  const tmp = uwTempFile(filename);
  try {
    fs.writeFileSync(tmp, Buffer.from(data, 'base64'));
    const omText = await runPythonJson('om_text.py', [tmp], 300000);
    if (omText.error) return res.status(422).json({ error: omText.error });

    const pagesBlock = omText.pages
      .filter(p => p.text)
      .map(p => `=== OM PAGE ${p.page} ===\n${p.text}`)
      .join('\n\n');
    // Pages with no text layer (a scan, a JPEG uploaded as the OM, a flattened
    // rent-roll page) come back as images — send them as pictures, each labelled
    // with its page so source_pages still points somewhere real.
    const images = omText.images || [];
    if (!pagesBlock && !images.length) {
      return res.status(422).json({ error: 'No readable text or pages in this file — is it the right document?' });
    }
    const content = [{ type: 'text', text: pagesBlock || '(This OM has no text layer — every page is an image below.)' }];
    for (const img of images) {
      content.push({ type: 'text', text: `=== OM PAGE ${img.page} (image — no text layer) ===` });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    }

    // Streamed, with room to finish. 8,192 output tokens was not enough for a
    // portfolio OM with a long comp set (a two-building portfolio, 2026-09-24: cut off inside
    // the rent comps → "unparseable output"). Streaming is what lets a large
    // ceiling run without an HTTP timeout — the rent-roll path already does this.
    let reply;
    try {
      reply = await anthropicStreamText(apiKey, {
        model: UW_MODEL,
        max_tokens: 32000,
        system: OM_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }, 600000);
    } catch (err) {
      return res.status(err.status || 502).json({ error: err.message || 'Anthropic API error' });
    }
    const extracted = uwSalvageJson(reply.text);
    if (!extracted) {
      return res.status(502).json({
        error: reply.stopReason === 'max_tokens'
          ? 'OM extraction ran past the output limit — the OM is unusually long; try again or trim it to the summary and comp pages.'
          : 'OM extraction returned unparseable output',
        stop_reason: reply.stopReason,
        raw: String(reply.text || '').slice(0, 2000),
      });
    }
    const omUsage = uwUsageFromReply(reply.usage);
    uwRecordUsage({ ts: new Date().toISOString(), endpoint: 'om-extract', kind: 'om', filename: filename || null, model: UW_MODEL, ...omUsage });
    res.json({
      kind: 'om',
      meta: {
        pages: omText.page_count, chars: omText.chars, truncated: omText.truncated,
        image_pages: images.length, image_pages_skipped: omText.image_pages_skipped || 0,
        source_kind: omText.source_kind || 'pdf',
      },
      extracted,
      usage: omUsage,
    });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

// ── County tax record lookup (Claude + web search) ──────────────────────────
// Runs automatically after OM extraction: searches the county assessor /
// public tax records for the property's real assessed value, tax rate, and
// the state's reassessment-on-sale rule, returning every value WITH its
// source URL so the review screen and the workbook's Tax tab can cite it.
const UW_TAX_SEARCH_PROMPT = `You are a senior multifamily acquisitions analyst finding the property-tax MILLAGE RATE for a property's taxing jurisdiction. Be fast: 2-4 targeted searches, then answer.

PRIMARY GOAL — the total combined millage rate (county + municipality + school district, per $1,000 of taxable/assessed value) for the property's location. These are PUBLISHED rates: search "<county> <state> millage rates <current year>", "<city> property tax millage", "<school district> millage". County budget pages, municipal tax pages, school-district pages, and local news articles all publish them. Do NOT try to query county GIS/parcel-lookup portals (ChescoViews, property appraiser search forms, etc.) — they are interactive databases that web search cannot reach; skip them entirely.

SECONDARY (only if a search you already ran surfaced it — do not spend extra searches): the parcel's assessed/taxable value and current annual tax bill.

Also state the jurisdiction's reassessment-on-sale rule in one or two sentences (e.g. Ohio reassesses near sale price; Pennsylvania uses base-year values + common level ratio and school districts may appeal after a sale).

If the user message includes an IMPLIED millage (their current tax bill ÷ taxable value), use it as a sanity anchor: if your found total is wildly different (>40% off), double-check which components apply (wrong municipality? county-only rate? assessment ratio?) and explain the gap in one short warning.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{"found": true|false,
 "county": "county, state",
 "current_taxable_value": number|null,
 "current_millage_rate": number|null,
 "millage_breakdown": {"county": number|null, "municipal": number|null, "school": number|null, "other": number|null},
 "non_ad_valorem_tax": number|null,
 "current_annual_tax": number|null,
 "reassessment_rule": "1-2 sentences max",
 "sources": [{"field":"current_millage_rate","url":"...","title":"page title"}],
 "confidence": 0.0-1.0,
 "warnings": ["..."]}

Rules:
- current_millage_rate = TOTAL combined rate per $1,000 of taxable value. If components come from different sources, sum them and cite each.
- Every non-null value MUST have an entry in sources with the URL it came from. Official (.gov, county/city/school sites) beats news beats aggregators; never use Zillow/Redfin/PropertyShark numbers.
- found=true if you have a usable total millage, even with taxable value null (the OM/T12 usually supplies value).
- If you cannot find a reliable millage, found=false — NEVER guess.
- warnings: at most 3, each under 20 words. No essays.
- confidence: 1.0 = official source for every component; below 0.6 = partial or single-source.`;

app.post('/api/underwriting/tax-lookup', async (req, res) => {
  const { property_name, address, county_pins, taxable_value, t12_property_tax } = req.body || {};
  if (!address && !(county_pins || []).length) return res.status(400).json({ error: 'Need an address or parcel IDs to search county records' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && uwDemoNoKey()) {
    const lk = uwSampleJson('riverbend-lookups.json');
    if (lk && lk.tax) return res.json({ ...lk.tax, warnings: [UW_DEMO_NOTE, ...(lk.tax.warnings || []).filter(w => !/^Demo mode/.test(w))] });
  }
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
  try {
    // implied millage from the deal's own numbers = a sanity anchor for the search
    const implied = (Number(taxable_value) > 0 && Number(t12_property_tax) > 0)
      ? Math.round(Number(t12_property_tax) / Number(taxable_value) * 1000 * 100) / 100 : null;
    const lines = [
      property_name ? `Property: ${property_name}` : null,
      address ? `Address: ${address}` : null,
      (county_pins || []).length ? `Parcel ID(s): ${(county_pins || []).join(', ')}` : null,
      taxable_value ? `Taxable value per the OM: ${Number(taxable_value).toLocaleString('en-US')}` : null,
      t12_property_tax ? `Current annual tax per the T12: ${Number(t12_property_tax).toLocaleString('en-US')}` : null,
      implied ? `IMPLIED millage from those two numbers: ${implied} per $1,000 (sanity anchor)` : null,
    ].filter(Boolean).join('\n');

    const { text, usage, stopReason } = await anthropicStreamText(apiKey, {
      model: UW_MODEL,
      max_tokens: 4000,
      system: UW_TAX_SEARCH_PROMPT,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: lines }],
    }, 240000);

    const parsed = uwSalvageJson(text);
    if (!parsed || parsed.found == null) {
      return res.status(502).json({ error: 'Tax lookup returned unparseable output', stop_reason: stopReason, raw: String(text).slice(0, 1200) });
    }
    const u = uwUsageFromReply(usage);
    // web search bills $10 per 1K searches on top of tokens
    u.searches = usage.web_search_requests || 0;
    u.cost_usd = Math.round((u.cost_usd + u.searches * 0.01) * 10000) / 10000;
    uwRecordUsage({ ts: new Date().toISOString(), endpoint: 'tax-lookup', kind: 'tax', filename: property_name || address || null, model: UW_MODEL, ...u });
    res.json({ ...parsed, usage: u });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  }
});

// ── Submarket occupancy lookup (Claude + web search) ────────────────────────
// Finds the average apartment occupancy for the property's submarket/metro so
// the review screen can show "this property vs the area" before the user sets
// the stabilized-occupancy target.
const UW_OCC_SEARCH_PROMPT = `You are a multifamily market analyst. You are given a property's location. Use web search to find the CURRENT average apartment occupancy (or vacancy) rate for that submarket or metro area.

Prefer, in order: recent (last 12 months) multifamily market reports from Northmarq, CBRE, Berkadia, Marcus & Millichap, Yardi Matrix, CoStar news articles, or reputable local market coverage. Metro-level is fine when submarket data isn't public.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{"found": true|false,
 "market": "the submarket/metro the number describes, e.g. Lehigh Valley, PA metro",
 "occupancy": 0.0-1.0 or null,
 "as_of": "period the number describes, e.g. Q1 2026",
 "sources": [{"url":"...","title":"page title"}],
 "notes": "1 sentence of context (trend, new supply, anything a buyer should know)",
 "confidence": 0.0-1.0,
 "warnings": ["..."]}

Rules:
- occupancy is a decimal (95.5% -> 0.955). If a source reports vacancy, convert (occupancy = 1 - vacancy) and say so in notes.
- Every value MUST cite its source URL in sources.
- If you cannot find a number from the last ~18 months, found=false with warnings — NEVER guess.`;

app.post('/api/underwriting/occupancy-lookup', async (req, res) => {
  const { property_name, address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Need an address to identify the submarket' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && uwDemoNoKey()) {
    const lk = uwSampleJson('riverbend-lookups.json');
    if (lk && lk.occupancy) return res.json({ ...lk.occupancy, warnings: [UW_DEMO_NOTE] });
  }
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
  try {
    const lines = [
      property_name ? `Property: ${property_name}` : null,
      `Address: ${address}`,
    ].filter(Boolean).join('\n');

    const { text, usage, stopReason } = await anthropicStreamText(apiKey, {
      model: UW_MODEL,
      max_tokens: 4000,
      system: UW_OCC_SEARCH_PROMPT,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      messages: [{ role: 'user', content: lines }],
    }, 240000);

    const parsed = uwSalvageJson(text);
    if (!parsed || parsed.found == null) {
      return res.status(502).json({ error: 'Occupancy lookup returned unparseable output', stop_reason: stopReason, raw: String(text).slice(0, 1200) });
    }
    const u = uwUsageFromReply(usage);
    u.searches = usage.web_search_requests || 0;
    u.cost_usd = Math.round((u.cost_usd + u.searches * 0.01) * 10000) / 10000;
    uwRecordUsage({ ts: new Date().toISOString(), endpoint: 'occupancy-lookup', kind: 'occupancy', filename: property_name || address || null, model: UW_MODEL, ...u });
    res.json({ ...parsed, usage: u });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  }
});

// Sale comps: manual for now (user decision 2026-07-15). Public web search
// couldn't reliably find closed institutional sales — comps get filled in
// Excel after download; OM-extracted comps still ride along automatically.

// The fictional sample documents behind "Try with sample documents" (underwriting/sample/): a Rent Manager style rent roll and
// T12 workbook and a short OM, for the showcase deal. Served from that one folder only, by exact name.
const UW_SAMPLE_FILES = [
  { name: 'Riverbend Apartments - Rent Roll.xlsx', kind: 'rent_roll', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { name: 'Riverbend Apartments - T12.xlsx', kind: 't12', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { name: 'Riverbend Apartments - Offering Memorandum.pdf', kind: 'om', type: 'application/pdf' },
];
app.get('/api/underwriting/sample', (req, res) => {
  const files = UW_SAMPLE_FILES.filter(f => fs.existsSync(path.join(UW_SAMPLE_DIR, f.name)))
    .map(f => ({ name: f.name, kind: f.kind, type: f.type, url: `/api/underwriting/sample/${encodeURIComponent(f.name)}` }));
  res.json({ available: files.length === UW_SAMPLE_FILES.length, demo: DEMO_MODE, ai: !!process.env.ANTHROPIC_API_KEY, property: 'Riverbend Apartments', files });
});
app.get('/api/underwriting/sample/:name', (req, res) => {
  const f = UW_SAMPLE_FILES.find(x => x.name === req.params.name);
  if (!f || !fs.existsSync(path.join(UW_SAMPLE_DIR, f.name))) return res.status(404).json({ error: 'No such sample file' });
  res.setHeader('Content-Type', f.type);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.sendFile(path.join(UW_SAMPLE_DIR, f.name));
});

// Generate the underwriting model from a reviewed deal JSON
app.post('/api/underwriting/generate', async (req, res) => {
  const deal = req.body?.deal;
  if (!deal || typeof deal !== 'object') return res.status(400).json({ error: 'No deal payload provided' });
  if (!deal.property?.name) return res.status(400).json({ error: 'Deal is missing property.name' });
  if (!deal.t12?.net_operating_income) return res.status(400).json({ error: 'Deal is missing t12.net_operating_income — cannot underwrite without NOI' });
  if (!Array.isArray(deal.rent_roll?.units) || deal.rent_roll.units.length === 0) {
    return res.status(400).json({ error: 'Deal has no rent roll units' });
  }
  // Official counts that the unit rows contradict (Birchwood Commons: 0% "official" occupancy, 54 of 56 units paying rent) must not
  // reach the model; the page reconciles them too, this is the backstop for any other caller.
  const reconciled = underwritingDeals.reconcileOfficialCounts(deal.rent_roll);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const slug = String(deal.property.name).replace(/[^A-Za-z0-9 ]/g, '').trim()
    .replace(/\s+/g, '-').slice(0, 48) || 'deal';
  const outName = `${slug}-${stamp}.xlsx`;
  const outPath = path.join(UW_OUT, outName);
  const dealTmp = uwTempFile('deal.json');
  try {
    fs.mkdirSync(UW_OUT, { recursive: true });
    fs.writeFileSync(dealTmp, JSON.stringify(deal));
    const genOut = await runPython('generator.py', [dealTmp, outPath, path.join(UW_DIR, 'Underwriting Model TEMPLATE.xlsx')]);
    let genWarnings = [];
    try { genWarnings = (JSON.parse(genOut).warnings) || []; } catch { /* older stdout format */ }
    if (reconciled.note) genWarnings = [reconciled.note, ...genWarnings];
    let finish = { recalc: false, facts: null };
    try {
      // generous timeout: the pure-python formulas engine takes ~20s locally
      // and the host's free-tier CPU is several times slower
      finish = await runPythonJson('finish_model.py', [outPath], 420000);
    } catch (err) {
      finish.recalc_error = publicErrorMessage(err);
    }
    // What this run was built from and what was judged by hand, kept next to the model
    // so its card can say so (the owner: uncertain values are shown, never silently guessed).
    try { uwDeals.setProvenance(outName, req.body?.provenance || {}); } catch (e) { console.error('deal provenance:', e.message); }
    // ...and the PDF report beside it (non-fatal: the card's button builds it on first click if this fails)
    let reportOk = false;
    try { await uwReports.ensure(outName, { force: true }); reportOk = true; } catch (e) { console.error('deal report:', e.message); }
    // The plausibility gate's verdict on what was just built, so the result screen can say it before anyone reads a number.
    let review = { needs_review: false, reasons: [], uncomputed_formulas: null };
    try {
      const built = (await uwDeals.list()).find(e => e.file === outName);
      if (built) review = { needs_review: !!built.card.needs_review, reasons: built.card.review_reasons || [], fix: built.card.review_fix || [], uncomputed_formulas: built.card.uncomputed_formulas ?? null };
    } catch (e) { console.error('deal review:', e.message); }
    res.json({
      file: outName,
      download: `/api/underwriting/download/${encodeURIComponent(outName)}`,
      report: `/api/underwriting/report/${encodeURIComponent(outName)}`,
      reportBuilt: reportOk,
      review: { needs_review: review.needs_review, reasons: review.reasons, fix: review.fix || [], uncomputed_formulas: review.uncomputed_formulas },
      recalc: finish.recalc,
      recalcError: finish.recalc_error || null,
      engine: finish.engine || null,
      bakedCells: finish.baked_cells ?? null,
      bakeError: finish.bake_error || finish.formulas_error || null,
      facts: finish.facts,
      warnings: genWarnings,
    });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  } finally {
    fs.unlink(dealTmp, () => {});
  }
});

// Download a generated model
app.get('/api/underwriting/download/:name', (req, res) => {
  const name = path.basename(req.params.name);
  if (!/^[A-Za-z0-9 ._-]+\.xlsx$/.test(name)) return res.status(400).json({ error: 'Bad file name' });
  const file = path.join(UW_OUT, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });
  res.download(file, name);
});

// List previously generated models (newest first)
app.get('/api/underwriting/models', (req, res) => {
  try {
    if (!fs.existsSync(UW_OUT)) return res.json({ models: [] });
    const models = fs.readdirSync(UW_OUT)
      .filter(f => f.endsWith('.xlsx'))
      .map(f => {
        const st = fs.statSync(path.join(UW_OUT, f));
        return { file: f, size: st.size, created: st.mtime.toISOString(), download: `/api/underwriting/download/${encodeURIComponent(f)}` };
      })
      .sort((a, b) => b.created.localeCompare(a.created));
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  }
});

// ── PAST DEALS + ONE DROP ZONE (2026-10-21) ───────────────────────────────────
// The owner: the Underwriting tab opens on the tool - "drop the different formats in
// right away: T12, OM, and rent roll ... it accepts all forms" - and under it
// "the past deals we ran that are saved on our disk ... with the Excel model
// attached". Past deals are the .xlsx models already on the host disk
// (data/underwriting is the persistent volume - render.yaml); the numbers on each
// card are read back from the model's own baked Dashboard (deal_card.py).
const uwDeals = underwritingDeals.createStore({
  dir: UW_OUT,
  readCards: async files => (await runPythonJson('deal_card.py', files, 300000)).cards || {},
});
try { const n = uwDeals.inheritRepairedProvenance(); if (n) console.log(`underwriting: ${n} repaired model(s) now cite the files they were built from`); } catch (e) { console.error('provenance heal:', e.message); }
underwritingDeals.useScoreOverride(path.join(UW_OUT, 'score-config.json'));

// The scoring model, editable on the Underwriting tab: one shared copy on the persistent disk. Preview rescoring never saves.
app.get('/api/underwriting/score-config', (req, res) => res.json(underwritingDeals.scoreConfigInfo()));
app.post('/api/underwriting/score-config', (req, res) => {
  try {
    const info = underwritingDeals.saveScoreConfig(req.body && req.body.config, uwActor(req));
    console.log(`underwriting: ${uwActor(req)} changed the scoring model`);
    res.json(info);
  } catch (err) { res.status(500).json({ error: publicErrorMessage(err) }); }
});
app.post('/api/underwriting/score-config/reset', (req, res) => {
  console.log(`underwriting: ${uwActor(req)} reset the scoring model to its defaults`);
  res.json(underwritingDeals.resetScoreConfig());
});
app.post('/api/underwriting/score-config/preview', async (req, res) => {
  try {
    const cfg = underwritingDeals.sanitizeScoreConfig(req.body && req.body.config);
    const props = underwritingDeals.groupByProperty(await uwDeals.list()).filter(p => !p.hidden);
    res.json({
      config: cfg,
      deals: props.map(p => {
        const c = p.latest.card, was = underwritingDeals.scoreDeal(c), now = underwritingDeals.scoreDeal(c, cfg);
        return { key: p.key, name: c.name, ran: p.latest.created, was: was.score, wasGrade: was.grade, now: now.score, nowGrade: now.grade };
      }),
    });
  } catch (err) { res.status(500).json({ error: publicErrorMessage(err) }); }
});

const uwActor = req => req.accessUser || (req.user && (req.user.email || req.user.name)) || 'someone';
const UW_MODEL_FILE_RE = /^[A-Za-z0-9 ._()-]+\.xlsx$/;

app.get('/api/underwriting/deals', async (req, res) => {
  try {
    const entries = await uwDeals.list();
    const properties = underwritingDeals.rankProperties(underwritingDeals.groupByProperty(entries));
    res.json({
      properties,
      model_count: entries.length,
      // workbooks on the disk that gave no card: named with the reason, never silently left off the board
      unreadable: uwDeals.problems(),
      // the disk is one 1 GB volume shared with every cache - say how much of it models use
      disk_bytes: entries.reduce((a, e) => a + e.size, 0),
    });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  }
});

// Retry a workbook the board could not read: make a repaired COPY (repair_model.py - the original is never touched),
// put it on the board, and hide the damaged original. Anything that cannot be repaired comes back with the reason.
app.post('/api/underwriting/deals/retry', async (req, res) => {
  const { file } = req.body || {};
  if (!UW_MODEL_FILE_RE.test(String(file || '')) || !fs.existsSync(path.join(UW_OUT, path.basename(file)))) {
    return res.status(404).json({ error: 'No such model' });
  }
  const src = path.basename(file);
  const out = `${src.replace(/\.xlsx$/i, '').replace(/(-repaired-[a-z0-9]+)+$/i, '')}-repaired-${Date.now().toString(36)}.xlsx`;     // one suffix, however many times it is repaired
  try {
    const r = await runPythonJson('repair_model.py', [path.join(UW_OUT, src), path.join(UW_OUT, out), '--note', `repaired copy of ${src}`], 420000);
    if (r.error) return res.status(422).json({ error: r.error });
    const entry = (await uwDeals.list()).find(e => e.file === out);
    if (!entry) { fs.unlink(path.join(UW_OUT, out), () => {}); return res.status(422).json({ error: 'The repaired copy still could not be read' }); }
    uwDeals.setProvenance(out, { imported: true, sources: [{ kind: 'model', filename: src, method: 'repaired copy of a damaged model', notes: r.changes || [] }] });
    uwDeals.inheritRepairedProvenance();          // ...and the copy keeps citing the files its original was built from
    uwDeals.setHidden(src, true, uwActor(req));
    uwReports.ensure(out).catch(e => console.error('repair report:', e.message));
    res.json({ file: out, original: src, name: entry.card.name, changes: r.changes || [] });
  } catch (err) {
    fs.unlink(path.join(UW_OUT, out), () => {});
    res.status(500).json({ error: publicErrorMessage(err) });
  }
});

// Hide, never delete (the owner): the .xlsx stays on the disk, the card moves to
// "Hidden deals", and who/when is kept.
app.post('/api/underwriting/deals/hide', async (req, res) => {
  const { file, hidden } = req.body || {};
  if (!UW_MODEL_FILE_RE.test(String(file || '')) || !fs.existsSync(path.join(UW_OUT, path.basename(file)))) {
    return res.status(404).json({ error: 'No such model' });
  }
  const who = uwActor(req);
  const state = uwDeals.setHidden(path.basename(file), hidden !== false, who);
  console.log(`underwriting: ${who} ${state ? 'hid' : 'restored'} ${file}`);
  res.json({ file, hidden: state });
});

// A finished Cedar Ridge model dropped on the tab becomes a past deal (so models run
// before the host disk existed, or on another machine, can be brought in).
// Anything that is not one of our models is refused, not shown with zeros.
app.post('/api/underwriting/deals/import', async (req, res) => {
  const { filename, data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'No file data provided' });
  const tmp = uwTempFile('import.xlsx');
  try {
    fs.writeFileSync(tmp, Buffer.from(data, 'base64'));
    const cards = (await runPythonJson('deal_card.py', [tmp], 120000)).cards || {};
    const raw = cards[tmp];
    if (!raw || raw.error) return res.status(422).json({ error: (raw && raw.error) || 'Could not read this workbook' });
    fs.mkdirSync(UW_OUT, { recursive: true });
    const stem = String(filename || 'Imported model').replace(/\.xlsx$/i, '').replace(/[^A-Za-z0-9 ._()-]/g, '_').slice(0, 90) || 'Imported model';
    let name = `${stem}.xlsx`;
    const size = fs.statSync(tmp).size;
    if (fs.existsSync(path.join(UW_OUT, name))) {
      // the same file dropped twice is not a second deal
      if (fs.statSync(path.join(UW_OUT, name)).size === size) return res.json({ file: name, duplicate: true });
      name = `${stem}-${Date.now().toString(36)}.xlsx`;
    }
    fs.copyFileSync(tmp, path.join(UW_OUT, name));
    uwDeals.setProvenance(name, { imported: true, sources: [{ kind: 'model', filename: filename || name, method: 'imported finished model' }] });
    uwReports.ensure(name).catch(e => console.error('import report:', e.message));   // background; the card's button builds it if this fails
    res.json({ file: name, duplicate: false, name: underwritingDeals.shapeCard(raw).name });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

// First look at one dropped file: what is it? Spreadsheets by their tabs, PDFs /
// Word / PowerPoint / photos by their first pages (doc_peek.py) - zero model
// tokens. The tab shows the guess with its confidence and lets the person
// correct it; it never decides silently (the owner: "show the confidence, never
// silently guess").
app.post('/api/underwriting/peek', async (req, res) => {
  const { filename, data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'No file data provided' });
  const name = String(filename || '');
  const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() || '';
  const sheetExt = ['xlsx', 'xls', 'xlsm', 'csv', 'tsv'];
  const tmps = [];
  const temp = n => { const t = uwTempFile(n); tmps.push(t); return t; };
  try {
    let file = temp(name || 'upload');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    if (['csv', 'tsv'].includes(ext)) {
      const x = temp('peek.xlsx');
      const conv = await runPythonJson('csv_to_xlsx.py', [file, x]);
      if (conv.error) return res.status(422).json({ error: conv.error });
      file = x;
    }
    if (sheetExt.includes(ext)) {
      const sheetOut = temp('peek-tab.xlsx');
      const pick = await runPythonJson('sheet_pick.py', [file, 'rent_roll', sheetOut]);
      if (pick.error) return res.status(422).json({ error: pick.error });
      const names = (pick.sheets || []).map(s => s.name);
      const has = { rent_roll: false, t12: false };
      for (const s of pick.sheets || []) {
        if (s.kind === 'rent_roll' || s.kind === 'retail_rent_roll') has.rent_roll = true;
        if (s.kind === 't12') has.t12 = true;
      }
      // a finished Cedar Ridge model carries these tabs; it becomes a past deal, not an input
      if (['Dashboard', 'Inputs', 'Pro Forma', 'Max Price Solver'].every(n => names.includes(n))) {
        return res.json({ kind: 'model', confidence: 1, reason: 'Has the Cedar Ridge model\'s own tabs (Dashboard, Inputs, Pro Forma, Max Price Solver).', has, sheets: names });
      }
      if (has.rent_roll || has.t12) {
        const kind = has.rent_roll && has.t12 ? 'workbook' : has.rent_roll ? 'rent_roll' : 't12';
        const by = (pick.sheets || []).filter(s => s.kind === 'rent_roll' || s.kind === 't12' || s.kind === 'retail_rent_roll');
        const viaName = by.every(s => s.reason === 'tab name');
        return res.json({
          kind, confidence: viaName ? 0.95 : 0.75, has, sheets: names,
          reason: `Tab${by.length > 1 ? 's' : ''} ${by.map(s => `"${s.name}" (${s.kind.replace(/_/g, ' ')}, from ${s.reason})`).join(', ')}.`,
        });
      }
      // no tab looks like either: the fixed-layout reader's own title sniff is the last cheap look
      try {
        const det = await runPythonJson('parsers.py', [file]);
        if (det && (det.kind === 'rent_roll' || det.kind === 't12')) {
          return res.json({ kind: det.kind, confidence: 0.6, has: { rent_roll: det.kind === 'rent_roll', t12: det.kind === 't12' }, sheets: names, reason: 'Report title and layout match a standard export.' });
        }
      } catch { /* not a fixed-layout export */ }
      return res.json({ kind: 'unknown', confidence: 0, has, sheets: names, reason: `No tab looks like a rent roll or a T12 (tabs: ${names.join(', ') || 'none'}).` });
    }
    // anything else: read the first pages
    const peek = await runPythonJson('doc_peek.py', [file], 60000);
    if (peek.error) return res.status(422).json({ error: peek.error });
    res.json(peek);
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  } finally {
    tmps.forEach(t => fs.unlink(t, () => {}));
  }
});

// A rent roll or T12 that arrived as a PDF, Word file or photo of pages. Read the
// way the OM is (text pages as text, scans as pictures) and extracted into the
// same shape the spreadsheet path returns, so the review screen and the generator
// do not care where the numbers came from. The person said what it is (the peek
// guessed, they confirmed), so the prompt is told; if the document disagrees, say
// so instead of forcing it.
app.post('/api/underwriting/parse-doc', async (req, res) => {
  const { filename, data } = req.body || {};
  const want = ({ rr: 'rent_roll', rent_roll: 'rent_roll', t12: 't12' })[req.body?.kind] || null;
  if (!data) return res.status(400).json({ error: 'No file data provided' });
  if (!want) return res.status(400).json({ error: 'kind must be rent_roll or t12' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && uwDemoNoKey()) return res.status(422).json({ error: 'Demo mode: reading a rent roll or T12 that arrives as a PDF, Word file or photo needs the Claude API, which is switched off in this demo. Use "Try with sample documents" above, or drop an Excel export.' });
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
  const tmp = uwTempFile(filename);
  try {
    fs.writeFileSync(tmp, Buffer.from(data, 'base64'));
    const doc = await runPythonJson('om_text.py', [tmp], 300000);
    if (doc.error) return res.status(422).json({ error: doc.error });
    const pagesBlock = doc.pages.filter(p => p.text).map(p => `=== PAGE ${p.page} ===\n${p.text}`).join('\n\n');
    const images = doc.images || [];
    if (!pagesBlock && !images.length) return res.status(422).json({ error: 'No readable text or pages in this file.' });
    const label = want === 'rent_roll' ? 'RENT ROLL' : 'T12';
    const content = [{ type: 'text', text: `File name: ${filename || 'document'}\nToday's date: ${new Date().toISOString().slice(0, 10)}.\nThe person who dropped this says it is a ${label}. It arrived as a ${doc.source_kind} document, not a spreadsheet; the pages follow.\n\n${pagesBlock || '(No text layer - every page is an image below.)'}` }];
    for (const img of images) {
      content.push({ type: 'text', text: `=== PAGE ${img.page} (image - no text layer) ===` });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    }
    let reply;
    try {
      reply = await anthropicStreamText(apiKey, {
        model: UW_MODEL, max_tokens: 64000, system: UW_EXTRACT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }, 600000);
    } catch (err) {
      return res.status(err.status || 502).json({ error: err.message || 'Anthropic API error' });
    }
    const parsed = uwSalvageJson(reply.text);
    if (!parsed || !parsed.kind) {
      return res.status(502).json({ error: 'Extraction returned unparseable output', stop_reason: reply.stopReason, raw: String(reply.text || '').slice(0, 1500) });
    }
    const usage = uwUsageFromReply(reply.usage);
    uwRecordUsage({ ts: new Date().toISOString(), endpoint: 'parse-doc', kind: parsed.kind, method: 'document', filename: filename || null, model: UW_MODEL, ...usage });
    if (parsed.kind !== want) {
      // Say what the model said, not a garbled "neither ... not a t12": a statement it judged a
      // pro forma / budget is refused on purpose (the extraction prompt never takes one as a T12).
      const wantName = want === 'rent_roll' ? 'a rent roll' : 'a T12';
      const got = parsed.kind === 'unknown' ? 'something else (a pro forma, budget or another report)' : (parsed.kind === 'rent_roll' ? 'a rent roll' : 'a T12');
      const why = (parsed.warnings || []).join(' ').trim();
      return res.status(422).json({ error: `Claude did not read this as ${wantName} - it reads as ${got}.${why ? ' Its note: ' + why : ''}` });
    }
    const warnings = [...(parsed.warnings || [])];
    warnings.unshift(`Read from a ${doc.source_kind.toUpperCase()} document, not a spreadsheet: there is no cell grid to tie back to, so check the ${want === 'rent_roll' ? 'unit count and rent totals' : 'NOI and EGI'} against the original before generating.`);
    if (doc.image_pages_skipped) warnings.push(`${doc.image_pages_skipped} page(s) with no text layer were beyond the picture limit and were NOT read.`);
    if (doc.truncated) warnings.push('The document was longer than the read limit and was cut off - the later pages were NOT read.');
    if (stopLimit(reply)) warnings.push('Extraction hit the output limit - the unit list may be incomplete.');
    const meta = Object.assign({}, parsed.meta, { extraction_method: `document (${doc.source_kind}, read by Claude)`, pages: doc.page_count });
    if (want === 'rent_roll') {
      meta.parsed_units = (parsed.data?.units || []).length;
      const mm = uwCountMismatch(parsed.data);
      if (mm) warnings.unshift(`Parsed ${mm.parsed} units but the report says ${mm.official} - verify the unit list before generating.`);
    } else {
      warnings.push('A document has no monthly grid, so the model\'s raw monthly detail table will be empty (summary numbers are unaffected).');
    }
    res.json({ kind: want, meta, warnings, data: parsed.data || {}, usage });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  } finally {
    fs.unlink(tmp, () => {});
  }
});
function stopLimit(reply) { return reply && reply.stopReason === 'max_tokens'; }

// ── PDF REPORTS (2026-10-22) ──────────────────────────────────────────────────
// The owner: "every deal to produce the Excel model, but also to produce a PDF report
// summarizing the property ... also for the older ones." The PDF is written next to
// its model in data/underwriting - the host persistent disk - so it survives a
// deploy exactly as the model does. It is built from the finished model
// (underwriting/deal_facts.py) plus what the page recorded about how the files were
// read (services/underwritingReport.js), then laid out by PyMuPDF (html_to_pdf.py):
// nothing new is installed on the host.
const uwReports = underwritingReport.createReports({
  dir: UW_OUT,
  runPython: (script, args, timeoutMs) => runPythonJson(script, args, timeoutMs),
  provenanceOf: f => uwDeals.provenanceOf(f),
  reportMeta: f => uwDeals.reportMeta(f),
  markReport: (f, m) => uwDeals.markReport(f, m),
});

app.get('/api/underwriting/report/:name', async (req, res) => {
  const name = path.basename(req.params.name);
  if (!UW_MODEL_FILE_RE.test(name) || !fs.existsSync(path.join(UW_OUT, name))) return res.status(404).json({ error: 'No such model' });
  try {
    const r = await uwReports.ensure(name);       // builds it now if this deal has none yet (an older run), then serves it
    // The site-wide CSP says object-src 'none', which stops the browser's own PDF viewer from drawing a PDF
    // opened in a tab. This response is our own generated file, so it may use the viewer.
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'self'; frame-ancestors 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src 'self' data:");
    res.setHeader('Content-Type', 'application/pdf');
    // ?download=1 saves the file instead of opening it in the tab (the audit of 2026-10-22 saved all twelve to read them offline)
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${underwritingReport.pdfNameFor(name).replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.sendFile(r.path);
  } catch (err) {
    res.status(500).json({ error: `Could not build the PDF report: ${publicErrorMessage(err)}` });
  }
});

// One pass over every model on the disk: build the reports that are missing or stale. Safe to re-run; runs in
// the background (a dozen models take a minute) with progress at GET .../reports/status.
const uwBackfillState = { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, generated: [], skipped: [], failed: [] };
async function uwRunReportBackfill({ force = false } = {}) {
  if (uwBackfillState.running) return uwBackfillState;
  const files = fs.existsSync(UW_OUT) ? fs.readdirSync(UW_OUT).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$')).sort() : [];
  Object.assign(uwBackfillState, { running: true, startedAt: new Date().toISOString(), finishedAt: null, total: files.length, done: 0, generated: [], skipped: [], failed: [] });
  (async () => {
    for (const f of files) {
      try {
        const r = await uwReports.ensure(f, { force });
        (r.built ? uwBackfillState.generated : uwBackfillState.skipped).push(f);
      } catch (e) {
        uwBackfillState.failed.push({ file: f, reason: publicErrorMessage(e) });
      }
      uwBackfillState.done += 1;
    }
    uwBackfillState.running = false;
    uwBackfillState.finishedAt = new Date().toISOString();
    console.log(`underwriting reports: ${uwBackfillState.generated.length} built, ${uwBackfillState.skipped.length} current, ${uwBackfillState.failed.length} failed`);
  })().catch(e => { uwBackfillState.running = false; console.error('report backfill:', e.message); });
  return uwBackfillState;
}
app.post('/api/underwriting/reports/backfill', async (req, res) => {
  res.json(await uwRunReportBackfill({ force: req.body && req.body.force === true }));
});
app.get('/api/underwriting/reports/status', (req, res) => {
  let missing = 0;
  try { if (fs.existsSync(UW_OUT)) missing = fs.readdirSync(UW_OUT).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$') && !uwReports.isFresh(f)).length; } catch { /* status only */ }
  res.json({ ...uwBackfillState, missing });
});

// ── DEBUG: probe raw RM endpoints to verify response shapes ──────────────────
app.get('/api/debug/:resource', async (req, res) => {
  if (!rentManager.isConfigured()) return res.status(503).json({ error: 'RM credentials not configured' });
  const resourceMap = {
    units:    () => rentManager.Units({ pagesize: 5 }),
    tenants:  () => rentManager.Tenants({ pagesize: 5 }),
    charges:  () => rentManager.RecurringCharges({ pagesize: 5 }),
    gl:       () => rentManager.GLAccounts({ pagesize: 10 }),
    props:    () => rentManager.Properties({ pagesize: 5 }),
    txns:     () => rentManager.GLTransactions({ pagesize: 5, StartDate: req.query.from || '2026-01-01', EndDate: req.query.to || '2026-05-31' }),
    report:   () => rentManager.ReportData({ ReportName: req.query.name || 'ProfitAndLoss', StartDate: req.query.from || '2026-01-01', EndDate: req.query.to || '2026-05-31', pagesize: 10 }),
    cash:     () => rentManager.allGLAccounts(),
  };
  const fn = resourceMap[req.params.resource];
  if (!fn) return res.status(404).json({ error: 'Unknown resource. Try: units, tenants, charges, gl, props, txns, report, cash' });
  try {
    res.json(await fn());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── RM ACCOUNTING CHECK — probe GL to see if full accounting is in RM ────────
// Call this once to determine whether RM has cash/expense/mortgage GL entries,
// which would mean we can eventually pull NOI and Cash from RM directly.
app.get('/api/rm-check', async (req, res) => {
  if (!rentManager.isConfigured()) {
    return res.json({ configured: false, message: 'Add RENTMANAGER_COMPANY / USERNAME / PASSWORD to .env' });
  }
  try {
    const [glRaw, propsRaw] = await Promise.all([
      rentManager.allGLAccounts().catch(() => []),
      rentManager.Properties({ pagesize: 200 }).catch(() => []),
    ]);
    const accounts = Array.isArray(glRaw) ? glRaw : (glRaw?.Results || []);
    const props    = Array.isArray(propsRaw) ? propsRaw : (propsRaw?.Results || []);

    const toName = a => (a.Name || a.AccountName || '').toLowerCase();
    res.json({
      configured: true,
      propertyCount: props.length,
      glAccountCount: accounts.length,
      hasCashAccounts:     accounts.some(a => /bank|cash|checking|savings/.test(toName(a))),
      hasMortgageAccounts: accounts.some(a => /mortgage|loan|note payable/.test(toName(a))),
      hasExpenseAccounts:  accounts.some(a => /expense/.test((a.AccountType || a.Type || '').toLowerCase())),
      // Sample of what's in GL so you can verify account naming
      glAccountSample: accounts.slice(0, 30).map(a => ({
        name: a.Name || a.AccountName,
        type: a.AccountType || a.Type,
      })),
      propertyNames: props.slice(0, 50).map(p => p.Name || p.PropertyName),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── LIVE OVERVIEW — everything the management site needs, pulled from Rent Manager ──
// Accepts ?from=YYYY-MM-DD&to=YYYY-MM-DD (defaults to YTD).
// Pulls in parallel:
//   1. Units            → vacancy / occupancy
//   2. Tenants w/ balance > 0  → delinquency
//   3. RecurringCharges (Rent) → GPR
//   4. P&L report       → income / opex / NOI / mortgage interest
//   5. Balance Sheet    → cash by property
//
// The pull takes long enough that it must never run inside a page-load request:
// the default-period (YTD) payload is cached in memory + a disk snapshot and
// served instantly; a background refresh keeps it under LIVE_OVERVIEW_TTL_MS
// old (stale-while-revalidate, same model as services/propertyFinancials).
// No timer: serve the last pull until the refresh button is pressed. Set
// LIVE_OVERVIEW_TTL_MS to a millisecond interval to bring periodic refresh back.
const LIVE_OVERVIEW_TTL_MS = Number(process.env.LIVE_OVERVIEW_TTL_MS || 0);
const LIVE_OVERVIEW_SNAPSHOT_FILE = path.join(__dirname, 'data', 'live-overview-cache.json');
let liveOverviewCache = null;       // last successfully built default-period payload
let liveOverviewPromise = null;     // in-flight build (dedupes concurrent refreshes)
let liveOverviewDiskChecked = false;

function loadLiveOverviewSnapshot() {
  if (!liveOverviewCache && !liveOverviewDiskChecked) {
    liveOverviewDiskChecked = true;
    try {
      liveOverviewCache = JSON.parse(fs.readFileSync(LIVE_OVERVIEW_SNAPSHOT_FILE, 'utf8'));
    } catch {
      liveOverviewCache = null; // no snapshot on disk yet
    }
  }
  return liveOverviewCache;
}

function liveOverviewIsStale() {
  const cached = loadLiveOverviewSnapshot();
  if (!cached) return true;                 // nothing cached — must build once
  if (LIVE_OVERVIEW_TTL_MS === 0) return false; // no timer: the last pull stands
  const age = Date.now() - Date.parse(cached.refreshedAt || 0);
  return !Number.isFinite(age) || age > LIVE_OVERVIEW_TTL_MS;
}

function refreshLiveOverviewCache() {
  if (!liveOverviewPromise) {
    liveOverviewPromise = buildLiveOverview()
      .then(payload => {
        liveOverviewCache = payload;
        try {
          fs.mkdirSync(path.dirname(LIVE_OVERVIEW_SNAPSHOT_FILE), { recursive: true });
          fs.writeFileSync(LIVE_OVERVIEW_SNAPSHOT_FILE, JSON.stringify(payload));
        } catch {} // ephemeral disk on the host — memory cache still serves
        appendVacancySnapshot(payload); // vacancy trend accrues one point per pull
        return payload;
      })
      .finally(() => { liveOverviewPromise = null; });
  }
  return liveOverviewPromise;
}

app.get('/api/live-overview', async (req, res) => {
  if (!rentManager.isConfigured()) {
    return res.json({ configured: false, message: 'RM credentials not set — add to .env to enable live refresh' });
  }

  try {
    // Custom period → always a direct pull (rare; nothing caches it).
    if (req.query.from || req.query.to) {
      return res.json(await buildLiveOverview(req.query.from, req.query.to));
    }

    const cached = loadLiveOverviewSnapshot();
    if (cached) {
      // Serve the snapshot instantly; kick a background refresh if it's stale.
      if (liveOverviewIsStale()) refreshLiveOverviewCache().catch(err => {
        console.warn('live-overview background refresh failed:', publicErrorMessage(err));
      });
      return res.json(cached);
    }

    // Very first request after a cold start with no disk snapshot: build inline.
    return res.json(await refreshLiveOverviewCache());
  } catch (err) {
    console.error('live-overview error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

async function buildLiveOverview(from, to) {
  const now = new Date();
  const startDate = from || `${now.getFullYear()}-01-01`;
  const endDate   = to   || now.toISOString().slice(0, 10);

  const [unitsRaw, unitStatusTypesRaw, tenantsRaw, chargesRaw, cashFlowRaw, balanceSheetRaw] = await Promise.all([
      optionalLiveRequest(loadAllPages(params => rentManager.Units(params), { embeds: 'CurrentUnitStatus,CurrentOccupancyStatus,Property' }, 1000, 50), [], 'Units'),
      optionalLiveRequest(loadAllPages(params => rentManager.UnitStatusTypes(params), {}, 500, 10), [], 'UnitStatusTypes'),
      // Tenants is ~13.8k rows account-wide, so this used to fetch one bounded
      // 1000-row page rather than paginate ~14 pages inside the request (which is
      // what was timing the endpoint out). That page carried no embeds, though:
      // without Property every balance fell through rowPropertyName() to 'Unknown'
      // — a bucket that belongs to no entity and gets filtered out — so the
      // per-property delinquency the Entities tab reads was $0 for every entity,
      // and without Balance the amounts were undefined too. Use the cached,
      // fully-enriched tenant index instead (property + entity + amountOwed already
      // resolved). It's the authoritative source, it's shared with the Delinquency
      // tab, and it serves stale-while-revalidate, so this costs no new RM calls.
      optionalLiveRequest(getTenantIndex().then(ix => ix.tenants), [], 'Tenants'),
      optionalLiveRequest(loadAllPages(params => rentManager.RecurringCharges(params), {}, 1000, 50), [], 'RecurringCharges'),
      // Report 54 = Cash Flow. This is where period mortgage interest expense lives.
      optionalLiveRequest(
        rentManager.RunReport(54, reportParamQuery([
          ['StartDate', startDate],
          ['EndDate', endDate],
          ['Basis', 'Accrual'],
          ['COLLAPSEPARENTS', 'false'],
          ['SHOWWHOLEDOLLAR', 'false'],
          ['IsSummary', 'false'],
        ])),
        null,
        'Cash Flow report'
      ),
      // Report 38 = Balance Sheet. This is where live bank and loan balances live.
      optionalLiveRequest(
        rentManager.RunReport(38, reportParamQuery([
          ['AsOfDate', endDate],
          ['Basis', 'Accrual'],
          ['COLLAPSEPARENTS', 'false'],
          ['SHOWWHOLEDOLLAR', 'false'],
        ])),
        null,
        'Balance Sheet report'
      ),
    ]);

    const norm = r => Array.isArray(r) ? r : (r?.Results || r?.ReportRows || r?.Rows || []);
    const units   = norm(unitsRaw);
    const unitStatusTypes = norm(unitStatusTypesRaw);
    const tenants = norm(tenantsRaw);
    const charges = norm(chargesRaw);
    const cashFlowRows = visibleLeafReportRows(cashFlowRaw);
    const balanceSheetRows = visibleLeafReportRows(balanceSheetRaw);

    // ── Occupancy ──────────────────────────────────────────────────────────────
    // Rent Manager's current unit embeds are not display labels. Occupied units
    // usually arrive as CurrentOccupancyStatus.OccupancyType = "CurrentOccupant";
    // vacant-style statuses are UnitStatusTypeID values resolved via /UnitStatusTypes.
    const unitStatusTypesById = new Map(
      unitStatusTypes
        .map(row => [idValue(row, ['UnitStatusTypeID', 'UnitStatusTypeId', 'ID', 'Id']), row])
        .filter(([id]) => id)
    );
    // The filter that decided which units count toward portfolio occupancy. Read
    // off the static list it excluded six real Cedar Ridge buildings outright.
    const propertyEntityMap = propertyEntityLookup();
    const portfolioUnits = propertyEntityMap.size
      ? units.filter(u => propertyEntityMap.has(normalizeKey(rowPropertyName(u))))
      : units;
    const occupancyCounts = portfolioUnits.reduce((acc, unit) => {
      const signal = unitOccupancySignal(unit, unitStatusTypesById);
      acc.total += 1;
      acc[signal] += 1;
      return acc;
    }, { total: 0, occupied: 0, vacant: 0, unknown: 0 });
    const occupancyReliable = occupancyCounts.total > 0 && occupancyCounts.unknown === 0;
    const totalUnits    = occupancyCounts.total;
    const totalOccupied = occupancyCounts.occupied;
    const totalVacant   = occupancyCounts.vacant;

    // ── Delinquency ────────────────────────────────────────────────────────────
    // Read the SHARED report-85 service (services/delinquencyReport.js) rather
    // than re-deriving delinquency from raw /Tenants balances here.
    //
    // What this used to do — `tenants.filter(t => t.amountOwed > 0)` — was wrong
    // in two ways, and the numbers it produced were landing on the Delinquency
    // tab's headline tiles (verified live 2026-08-03):
    //   1. No status filter, so all 10.4k PAST tenants counted. Moved-out
    //      balances are a collections/write-off matter, not delinquency, and
    //      they alone were $10.0M across 2,479 former tenants.
    //   2. Net account balance, not aged open charges, so next month's
    //      early-posted rent read as past due.
    // Together that put $12.6M / 3,670 tenants on the tab against a true
    // $635K / 315. Worse, it CLOBBERED the correct figure: the frontend loads
    // /api/delinquency and /api/live-overview concurrently and both wrote
    // TOTALS.delinq_*, so the slower live-overview response usually won.
    //
    // Sourcing both from one service means the tiles, the entity chart, the
    // entity table, the Entities tab and the tenant list cannot disagree.
    const delinquency = await optionalLiveRequest(
      delinquencyReport.getDelinquency(), null, 'Delinquency (report 85)'
    );
    const delinqByProperty = (delinquency && delinquency.byProperty) || {};
    const delinqTotals     = (delinquency && delinquency.totals) || null;

    // ── GPR ────────────────────────────────────────────────────────────────────
    const rentCharges = charges.filter(c => /rent/i.test(c.ChargeType || c.Type || c.Description || ''));
    const totalGPR    = rentCharges.reduce((s, c) => s + parseFloat(c.Amount || c.ChargeAmount || 0), 0);

    // ── Per-property helpers ────────────────────────────────────────────────────
    const byProp = {};
    const ensureProp = p => {
      if (!byProp[p]) byProp[p] = { total: 0, occupied: 0, vacant: 0, gpr: 0,
                                     unknown: 0,
                                     delinq_amount: 0, delinq_tenants: 0,
                                     income: 0, opex: 0, mortgage: 0, noi: 0, net: 0, cash: 0 };
    };
    portfolioUnits.forEach(u => {
      const p = rowPropertyName(u) || 'Unknown'; ensureProp(p);
      const signal = unitOccupancySignal(u, unitStatusTypesById);
      byProp[p].total++;
      byProp[p][signal]++;
    });
    rentCharges.forEach(c => {
      const p = rowPropertyName(c) || 'Unknown'; ensureProp(p);
      byProp[p].gpr += parseFloat(c.Amount || c.ChargeAmount || 0);
    });
    // Unit-level feed for the Portfolio tab's Unit filter (2026-10-22, the owner): one
    // row per unit as [name, o|v|u (occupied, vacant, unknown), scheduled rent].
    // Built from the unit and charge lists this pull already holds: no extra RM call.
    const rentByUnit = {};
    rentCharges.forEach(c => {
      const id = idValue(c, ['UnitID', 'UnitId']);
      if (id != null && id !== '') rentByUnit[id] = (rentByUnit[id] || 0) + (parseFloat(c.Amount || c.ChargeAmount || 0) || 0);
    });
    const unitsByProperty = {};
    portfolioUnits.forEach(u => {
      const p = rowPropertyName(u) || 'Unknown';
      const sig = unitOccupancySignal(u, unitStatusTypesById);
      const id = idValue(u, ['UnitID', 'UnitId']);
      (unitsByProperty[p] || (unitsByProperty[p] = [])).push([
        String(u.Name || u.UnitName || id || '').slice(0, 24),
        sig === 'occupied' ? 'o' : sig === 'vacant' ? 'v' : 'u',
        Math.round(rentByUnit[id] || 0),
      ]);
    });
    Object.entries(delinqByProperty).forEach(([p, d]) => {
      ensureProp(p);
      byProp[p].delinq_amount  += d.amount  || 0;
      byProp[p].delinq_tenants += d.tenants || 0;
    });

    // ── Cash Flow report parsing ───────────────────────────────────────────────
    // Report 54 returns GL-style rows. For now the safest live finance number
    // is mortgage-interest expense; broader NOI replacement needs entity/property
    // report mapping before it should overwrite the frontend charts.
    const plFinancials = { income: 0, opex: 0, mortgage: 0, noi: 0, net: 0 };
    let mortgageInterestRows = 0;
    cashFlowRows.forEach(row => {
      const p   = row.PropertyName || row.Property || null;
      const lbl = reportLabel(row).toLowerCase();
      const type = String(row.GLAccountTypeName || '').toLowerCase();
      const amt = Math.abs(reportAmount(row));

      if (/^total income|^gross potential|^total revenue|^total gross/i.test(lbl))   plFinancials.income   = amt;
      if (/^total operating exp|^total operat|^total expenses?\s*$/i.test(lbl))        plFinancials.opex     = amt;
      if (/net operating income|^noi\b|^total noi/i.test(lbl))                         plFinancials.noi      = amt;
      if (/expense/.test(type) && /mortgage interest|loan interest|interest expense|debt service/i.test(lbl) && !/non-posting/i.test(lbl)) {
        plFinancials.mortgage += amt;
        mortgageInterestRows += 1;
      }
      if (/^net income|^total net income|^net after/i.test(lbl))                       plFinancials.net      = amt;

      // Property-level rows — accumulate for per-entity breakdown
      if (p) {
        ensureProp(p);
        if (/^total income|^gross potential|^total revenue/i.test(lbl))      byProp[p].income   = amt;
        if (/^total operating exp|^total expenses?\s*$/i.test(lbl))           byProp[p].opex     = amt;
        if (/net operating income|^noi\b/i.test(lbl))                         byProp[p].noi      = amt;
        if (/expense/.test(type) && /mortgage interest|loan interest|interest expense|debt service/i.test(lbl) && !/non-posting/i.test(lbl)) {
          byProp[p].mortgage += amt;
        }
        if (/^net income|^net after/i.test(lbl))                               byProp[p].net      = amt;
      }
    });

    // If the report returned property-level rows but no summary totals, sum them up
    if (!plFinancials.income && Object.keys(byProp).length) {
      plFinancials.income   = Object.values(byProp).reduce((s, p) => s + p.income,   0);
      plFinancials.opex     = Object.values(byProp).reduce((s, p) => s + p.opex,     0);
      plFinancials.mortgage = Object.values(byProp).reduce((s, p) => s + p.mortgage, 0);
    }
    // Derive NOI and net if not explicitly in the report
    if (!plFinancials.noi && plFinancials.income) plFinancials.noi = plFinancials.income - plFinancials.opex;
    if (!plFinancials.net && plFinancials.noi)     plFinancials.net = plFinancials.noi - plFinancials.mortgage;

    // ── Balance Sheet parsing ─────────────────────────────────────────────────
    const bankRows = balanceSheetRows.filter(row => String(row.GLAccountTypeName || '').toLowerCase() === 'bank');
    const debtRows = balanceSheetRows.filter(row => {
      const lbl = reportLabel(row).toLowerCase();
      const type = String(row.GLAccountTypeName || '').toLowerCase();
      return /(mortgage|loan|note payable|notes payable|line of credit|loc\b|debt)/i.test(lbl) ||
        (/liabil/.test(type) && /(payable|loan|note|mortgage|debt|credit)/i.test(lbl));
    });
    // RM's Balance Sheet JSON uses RawAmount's accounting sign. Bank assets are
    // negative in that raw output, so invert to display cash as a positive balance.
    const totalCash = -bankRows.reduce((sum, row) => sum + reportAmount(row, 'RawAmount'), 0);
    const totalDebtBalance = debtRows.reduce((sum, row) => sum + reportAmount(row, 'Amount'), 0);

    const round2 = n => Math.round(n * 100) / 100;

    return {
      configured: true,
      refreshedAt: new Date().toISOString(),
      period: { from: startDate, to: endDate },
      totals: {
        // RM-native (always available)
        units:          occupancyReliable ? totalUnits : null,
        occupied:       occupancyReliable ? totalOccupied : null,
        vacant:         occupancyReliable ? totalVacant : null,
        occupancy:      occupancyReliable ? Math.round(totalOccupied / totalUnits * 1000) / 10 : null,
        // null (not 0) when the report is unavailable, so the frontend leaves
        // the delinquency tiles alone rather than zeroing them.
        delinq_amount:  delinqTotals ? round2(delinqTotals.amount) : null,
        delinq_tenants: delinqTotals ? delinqTotals.tenants : null,
        gpr_monthly:    round2(totalGPR),
        // Financial (from GL — null if report returned no data)
        income:   plFinancials.income   || null,
        opex:     plFinancials.opex     || null,
        mortgage: plFinancials.mortgage || null,
        debt_balance: round2(totalDebtBalance) || null,
        noi:      plFinancials.noi      || null,
        net:      plFinancials.net      || null,
        cash:     totalCash             || null,
      },
      sources: {
        occupancy: { resource: '/Units', rows: portfolioUnits.length, excludedRows: units.length - portfolioUnits.length, unitStatusTypes: unitStatusTypesById.size, reliable: occupancyReliable, ...occupancyCounts },
        cash: { reportId: 38, report: 'Balance Sheet', rows: bankRows.length },
        delinquency: delinquency
          ? { reportId: 85, report: 'Delinquency', asOf: delinquency.asOf, graceDays: delinquency.graceDays, tenants: delinqTotals && delinqTotals.tenants, tiesToOfficial: delinquency.tiesToOfficial }
          : { reportId: 85, report: 'Delinquency', unavailable: true },
        mortgage: { reportId: 54, report: 'Cash Flow', rows: mortgageInterestRows },
        debt_balance: { reportId: 38, report: 'Balance Sheet', rows: debtRows.length },
      },
      // Each property tagged with its owning entity so the Entities tab can group
      // without re-deriving the mapping client-side.
      byProperty: Object.fromEntries(
        Object.entries(byProp).map(([name, p]) => [name, { ...p, entity: entityForProperty(name) }])
      ),
      unitsByProperty,
    };
}

// ── Vacancy history ──────────────────────────────────────────────────────────
// Rent Manager only answers "who is vacant right now" — it keeps no history, so
// a vacancy trend can't be pulled, only accumulated. Every successful overview
// pull appends one dated snapshot (portfolio + per entity + per property); the
// weekly schedule makes that one point a week, and in a few months the trend
// chart draws itself. Kept tiny on purpose: counts only, ~1KB/snapshot, on the
// persistent disk next to the other caches.
const VACANCY_HISTORY_FILE = path.join(__dirname, 'data', 'vacancy-history.json');

function appendVacancySnapshot(payload) {
  try {
    if (!payload || !payload.totals || payload.totals.units == null) return;
    let history = [];
    try { history = JSON.parse(fs.readFileSync(VACANCY_HISTORY_FILE, 'utf8')); } catch {}
    const day = (payload.refreshedAt || new Date().toISOString()).slice(0, 10);
    // One snapshot per day — a manual refresh after the weekly pull replaces that
    // day's point rather than stacking a second one an hour apart.
    history = history.filter(h => h.date !== day);
    const byEntity = {};
    Object.values(payload.byProperty || {}).forEach(p => {
      if (!p.entity) return;
      const e = (byEntity[p.entity] ||= { units: 0, occupied: 0, vacant: 0 });
      e.units += p.total; e.occupied += p.occupied; e.vacant += p.vacant;
    });
    history.push({
      date: day,
      totals: {
        units: payload.totals.units,
        occupied: payload.totals.occupied,
        vacant: payload.totals.vacant,
        occupancy: payload.totals.occupancy,
      },
      byEntity,
      byProperty: Object.fromEntries(
        Object.entries(payload.byProperty || {})
          .filter(([, p]) => p.total > 0)
          .map(([name, p]) => [name, { units: p.total, occupied: p.occupied, vacant: p.vacant, entity: p.entity }])
      ),
    });
    history.sort((a, b) => a.date < b.date ? -1 : 1);
    fs.mkdirSync(path.dirname(VACANCY_HISTORY_FILE), { recursive: true });
    fs.writeFileSync(VACANCY_HISTORY_FILE, JSON.stringify(history));
  } catch (err) {
    console.warn('Vacancy history append failed:', err.message); // never blocks the pull
  }
}

app.get('/api/vacancy-history', (req, res) => {
  noStore(res);
  try {
    res.json(JSON.parse(fs.readFileSync(VACANCY_HISTORY_FILE, 'utf8')));
  } catch {
    res.json([]); // no snapshots yet — the tab shows "trend builds as pulls accrue"
  }
});

// ── Per-property monthly P&L (Variance tab live source) ──────────────────────
// GET returns the cached per-property/entity/portfolio monthly P&L payload. The
// build is expensive (~267 RM calls), so it never runs inside this request: the
// cache is served immediately, and an empty cache self-heals by kicking off a
// background build (see services/propertyFinancials.getStatus). Frontend polls
// until `building` clears. Auth: covered by the site-wide gate above.
app.get('/api/financials/property-monthly', (req, res) => {
  if (!rentManager.isConfigured()) {
    return res.json({ configured: false, message: 'RM credentials not set — add to .env to enable live P&L' });
  }
  const { cache: raw, building, progress, lastError } = propertyFinancials.getStatus();
  // Split buildings read as one (config/property-merges.json).
  const cache = propertyMerges.apply(raw);
  if (cache) {
    // The account trees are the bulk of the snapshot and only needed when a line
    // is opened — they have their own route below.
    const { accounts, ...rest } = cache;
    return res.json({ ...rest, building, progress, hasAccounts: Boolean(accounts) });
  }
  // No data yet — a build was just started (or is running). Tell the frontend to poll.
  return res.status(building ? 202 : 503).json({
    configured: true,
    building,
    progress,
    lastError,
    message: building ? 'Building per-property P&L from Rent Manager — retry shortly.' : 'No P&L snapshot yet.',
  });
});

// The accounts under each grid line for ONE scope — what the Variance grid shows
// when a line (Water & Sewer, Repairs & Maintenance…) is clicked open. Same
// snapshot, same months as the payload above.
//   scope: 'portfolio' | '<Entity Name>' | 'prop:<PropertyID>'
app.get('/api/financials/property-monthly/accounts', (req, res) => {
  const cache = propertyMerges.apply(propertyFinancials.loadSnapshot());
  if (!cache) return res.status(503).json({ error: 'No P&L snapshot yet.' });
  if (!cache.accounts) {
    return res.json({ months: cache.months, lines: {}, pending: true,
      message: 'Account breakdowns arrive with the next full refresh.' });
  }
  const scope = String(req.query.scope || 'portfolio');
  let lines;
  if (scope === 'portfolio') lines = cache.accounts.portfolio;
  else if (scope.startsWith('prop:')) lines = cache.accounts.properties[scope.slice(5)];
  else lines = cache.accounts.entities[scope];
  if (!lines) return res.status(404).json({ error: `No account detail for "${scope}".` });
  res.json({ months: cache.months, scope, lines });
});

// POST forces a rebuild. Default is incremental (current year only, seeded from
// the cached snapshot — fast). Pass ?mode=full to re-pull every year, e.g. after
// RM restates old books or the category map changes. Returns immediately; the
// build runs in the background.
app.post('/api/financials/property-monthly/recompute', (req, res) => {
  if (!rentManager.isConfigured()) {
    return res.status(400).json({ error: 'RM credentials not set.' });
  }
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const mode = req.query.mode === 'full' ? 'full' : undefined;
  const already = propertyFinancials.isBuilding();
  propertyFinancials.startBuild(from, to, mode).catch(() => {});
  res.json({ started: true, alreadyRunning: already, mode: mode || 'incremental', from: from || 'default', to: to || 'default' });
});

// Tracked-line-item + threshold config for the Variance tab (single source of
// truth; see services/varianceConfig.js). Static — no RM call — so it's cheap to
// fetch separately from the P&L payload.
// ── Market news (services/marketNews.js) ─────────────────────────────────────
// Public rates and headlines for the top of Home. Reads the cached file only —
// the fetch happens on the 6am Eastern schedule, never on a page load — and
// never answers with an error: an empty/pending payload is a normal answer.
app.get('/api/market-news', (req, res) => {
  noStore(res);
  try { res.json(marketNews.current()); }
  catch (err) { res.json({ pending: true, refreshFailed: true, rates: [], articles: [] }); }
});

// ── Scorecard targets (services/scorecardTargets.js) ─────────────────────────
// Read by anyone who sees the scorecard; saved by admins only — the save sits
// under /api/admin/, which accessControl keeps admin-only.
app.get('/api/scorecard/targets', (req, res) => {
  noStore(res);
  res.json(scorecardTargets.load());
});
app.post('/api/admin/scorecard-targets', (req, res) => {
  noStore(res);
  const who = req.accessUser || (req.user && (req.user.name || req.user.email)) || null;
  const r = scorecardTargets.save(req.body, who, require('./services/entityMap').ENTITY_NAMES);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r.targets);
});

app.get('/api/variance/config', (req, res) => {
  noStore(res);
  res.json(varianceRuleOverrides.apply(varianceConfig.getConfig()));
});

// ── Editing the rules from the tab ───────────────────────────────────────────
// The owner, 2026-08-26: "edit variance rules per category… it opens a new screen
// with all the categories, and you can edit the rules there." The defaults stay in
// services/varianceConfig.js — that file is still the documented model — and these
// routes store the DIFF against it, shared on disk like resolutions, for the same
// reason: a threshold somebody tunes in their own browser is their private opinion
// of the rules, not the rules.
//
// What cannot be edited here: glRefs, key, label, group. Which GL accounts a line
// IS is the definition of the number, not a rule about it, and changing that from
// a browser would silently re-base every figure the tab is reconciled against.
app.post('/api/variance/rules', (req, res) => {
  const who = resolutionActor(req);
  const body = req.body || {};
  try {
    if (body.model && typeof body.model === 'object') varianceRuleOverrides.setModel(body.model, who);
    if (body.key) varianceRuleOverrides.setItem(String(body.key), body.values || {}, who);
    else if (!body.model) return res.status(400).json({ error: 'Nothing to save — send { key, values } or { model }.' });
    console.log(`variance rules: ${body.key ? `"${body.key}"` : 'global model'} edited by ${who}`);
    res.json(varianceRuleOverrides.apply(varianceConfig.getConfig()));
  } catch (err) {
    const status = err.code === 'BAD_KEY' || err.code === 'BAD_VALUE' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Reset one line — or, with no key, every rule on the tab — back to the file
// defaults. Never destructive of anything but the overrides themselves.
app.delete('/api/variance/rules', (req, res) => {
  const who = resolutionActor(req);
  const key = (req.body && req.body.key) || req.query.key || null;
  try {
    console.log(`variance rules: ${key ? `"${key}"` : 'EVERYTHING'} reset to defaults by ${who}`);
    varianceRuleOverrides.reset(key ? String(key) : null, who);
    res.json(varianceRuleOverrides.apply(varianceConfig.getConfig()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Resolved flags (shared) ──────────────────────────────────────────────────
// "Mark normal" used to write to localStorage, which made it a private note —
// see services/varianceResolutions.js for why that was the wrong shape. These
// four routes are the shared record: every browser reads the same file, so the
// flag list shrinks for everyone as the month gets worked.
//
// Attribution: under SSO proxy Access the email comes from the verified JWT and
// the browser cannot influence it. In PIN mode there is no per-user identity at
// all, so a client-supplied name is accepted as a fallback. That is a display
// label for a shared internal tool, NOT an authorization check — nothing here
// grants access, and anyone who can reach these routes has already passed the
// site's auth gate.
function resolutionActor(req) {
  if (req.accessUser) return req.accessUser;
  const claimed = req.body && typeof req.body.by === 'string' ? req.body.by.trim() : '';
  return claimed ? claimed.slice(0, 120) : 'site';
}

// The whole resolved set. Never cached — a stale copy here means someone works
// a flag their colleague already resolved, which is the exact failure this
// replaced.
app.get('/api/variance/resolutions', (req, res) => {
  noStore(res);
  res.json(varianceResolutions.load());
});

// Resolve one flag, or bulk-import a browser's leftover localStorage set.
// Import is additive only (existing entries win), so it is safe to fire on
// every page load — it converges and then does nothing.
app.post('/api/variance/resolutions', (req, res) => {
  const who = resolutionActor(req);
  const body = req.body || {};
  try {
    if (body.import && typeof body.import === 'object') {
      const { added, state } = varianceResolutions.importMissing(body.import, who);
      if (added) console.log(`variance: imported ${added} resolution(s) from ${who}'s browser`);
      return res.json({ ...state, imported: added });
    }
    const saved = varianceResolutions.resolve(body.key, body.note, who, body.through);
    res.json(saved);
  } catch (err) {
    res.status(err.code === 'BAD_KEY' ? 400 : 500).json({ error: err.message });
  }
});

// Restore one flag back to the list.
app.delete('/api/variance/resolutions', (req, res) => {
  const who = resolutionActor(req);
  const key = (req.body && req.body.key) || req.query.key;
  if (!key) return res.status(400).json({ error: 'Missing flag key.' });
  try {
    res.json(varianceResolutions.unresolve(String(key), who));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore EVERYTHING — this discards the whole team's review, so it is its own
// route rather than a flag on the one above. The UI confirms twice before
// calling it.
app.delete('/api/variance/resolutions/all', (req, res) => {
  const who = resolutionActor(req);
  try {
    console.log(`variance: ALL resolutions cleared by ${who}`);
    res.json(varianceResolutions.clearAll(who));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── When each flag was first seen (2026-10-21) ───────────────────────────────
// The Variances dashboard's "still open since {Mon}" tag — see
// services/varianceFirstSeen.js for why (the owner's pre-mortem: "the Top 5 stopped
// changing"). The page posts the ids of the flags it is showing, once per P&L
// pull; this keeps the first date each was seen and answers with those dates.
// A body without an ids array is an empty answer, not a 400: the page treats
// any failure as "no tags" anyway, and junk ids are dropped by the store.
app.post('/api/variance/first-seen', (req, res) => {
  noStore(res);
  const body = req.body || {};
  try {
    res.json({ seen: varianceFirstSeen.record(Array.isArray(body.ids) ? body.ids : []) });
  } catch (err) {
    res.status(500).json({ error: err.message, seen: {} });
  }
});

// ── Home snapshot (every signed-in person reads it) ──────────────────────────
// Home shows grades, headlines and one chart to everyone (the owner, 2026-10-22).
// Those are worked out in the browser from feeds only some tools may fetch, so a
// browser that holds the data posts the coarse result here and Home reads it back
// (services/homeSnapshot.js). The latest underwriting deal is read here on the
// server, reduced to name, size, date and meets/below target, because the
// Underwriting routes themselves stay behind that tool.
app.get('/api/home-snapshot', async (req, res) => {
  noStore(res);
  const out = homeSnapshot.read();
  try {
    const props = underwritingDeals.groupByProperty(await uwDeals.list());
    out.deal = homeSnapshot.latestDeal(props);
    // Workbooks the board could not read at all are unsolved deals too: name them.
    out.unreadable = (uwDeals.problems() || []).slice(0, 5).map(u => ({ file: String(u.file || '').slice(0, 120), reason: String(u.reason || '').slice(0, 200) }));
  } catch (err) {
    out.deal = null;
  }
  res.json(out);
});

app.post('/api/home-snapshot', (req, res) => {
  const u = req.user || LOCAL_OPEN_USER;
  const can = tool => !!u.admin || (u.tools || []).includes(tool);
  try {
    res.json({ taken: homeSnapshot.merge(req.body, can) });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  }
});

// ── Handled entity action items (shared) ─────────────────────────────────────
// The Entities tab lists what each entity should work on, derived from the
// metric that cost it points (public/index.html, eaFlags). The owner (2026-10-21):
// the team marks those done — and a mark is only worth having if every browser
// shows the same list, so it lives in services/entityActions.js on the
// persistent disk, like the Variances resolutions above. Same actor rule
// (resolutionActor): a verified Access email where there is one, otherwise the
// name the browser offers, as a display label and nothing more.
//
// Access: /api/entities covers these (services/accessControl.js) — anyone who
// can read the board can mark an item on it. The item itself is never stored;
// it is recomputed from the live figures, and the stored mark carries the value
// at the time so the page can bring it back if the number has worsened since.
app.get('/api/entities/actions', (req, res) => {
  noStore(res);
  res.json(entityActions.load());
});

app.post('/api/entities/actions', (req, res) => {
  const who = resolutionActor(req);
  const body = req.body || {};
  try {
    res.json(entityActions.handle(body.key, body.note, body.value, who));
  } catch (err) {
    res.status(err.code === 'BAD_KEY' ? 400 : 500).json({ error: err.message });
  }
});

app.delete('/api/entities/actions', (req, res) => {
  const who = resolutionActor(req);
  const key = (req.body && req.body.key) || req.query.key;
  if (!key) return res.status(400).json({ error: 'Missing action key.' });
  try {
    res.json(entityActions.unhandle(String(key), who));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GL transaction drill-down (the invoices behind a flag) ───────────────────
// A flag says "Water & Sewer was $16.8K in Mar" or "$0 in Apr". This returns the
// actual postings behind that number — date, vendor, description (often naming
// the SERVICE PERIOD the bill covers), debit/credit — via RM Report 51.
//
// scope: 'portfolio' | '<Entity Name>' | 'prop:<PropertyID>'
// key:   a varianceConfig tracked-item key ('waterSewer'), resolved to its GL refs
// from/to: 'YYYY-MM' inclusive; defaults to the single month in `month`
app.get('/api/variance/gl-detail', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) {
    return res.status(400).json({ error: 'RM credentials not set.' });
  }
  const scope = String(req.query.scope || 'portfolio');
  const key = String(req.query.key || '');
  const lineRefs = propertyFinancials.CATEGORY_REFS[key];
  if (!lineRefs) {
    return res.status(400).json({ error: `Unknown or non-GL line "${key}" — no GL accounts map to it.` });
  }
  // The P&L line is a block: 5100 Repairs holds accounts that share no number
  // with it (they nest by position in the chart, not by a 5100-N suffix). Asking
  // the GL for 5100 and its 5100-N children alone returned no postings at all
  // for a line the P&L showed at $1-2K a month (verified live 2026-09-23). The
  // snapshot build records each block's members from the report itself, so the
  // drill-down reads the same accounts the P&L figure is made of.
  const members = (propertyFinancials.loadSnapshot() || {}).categoryMembers || {};
  const refs = [...new Set(lineRefs.flatMap(r => [String(r), ...(members[r] || []).map(String)]))];

  // Month window. `month` is the convenience single-month form ('2026-03').
  const month = typeof req.query.month === 'string' ? req.query.month : null;
  const fromYM = (typeof req.query.from === 'string' && req.query.from) || month;
  const toYM = (typeof req.query.to === 'string' && req.query.to) || month;
  if (!/^\d{4}-\d{2}$/.test(fromYM || '') || !/^\d{4}-\d{2}$/.test(toYM || '')) {
    return res.status(400).json({ error: 'Need month=YYYY-MM, or from=YYYY-MM&to=YYYY-MM.' });
  }
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const startDate = `${fy}-${String(fm).padStart(2, '0')}-01`;
  const endDate = `${ty}-${String(tm).padStart(2, '0')}-${String(new Date(ty, tm, 0).getDate()).padStart(2, '0')}`;

  try {
    // Resolve the scope to the PropOwnerIDs the report wants.
    const { byId } = await require('./services/entityMap').buildPropertyEntityMap(rentManager);
    let propOwnerIds;
    if (scope.startsWith('prop:')) {
      const pid = Number(scope.slice(5));
      if (!byId.has(pid)) return res.status(400).json({ error: `Unknown property ${pid}.` });
      // A merged building's drill-down shows every side's postings.
      propOwnerIds = propertyMerges.idsFor(pid).join(',');
    } else if (scope === 'portfolio') {
      propOwnerIds = [...byId.keys()].join(',');
    } else {
      const ids = [...byId.entries()].filter(([, m]) => m.entity === scope).map(([id]) => id);
      if (!ids.length) return res.status(400).json({ error: `Unknown entity "${scope}".` });
      propOwnerIds = ids.join(',');
    }

    const payload = await glTransactions.getGLDetail({ propOwnerIds, refs, startDate, endDate });
    // The card opens and pulls every invoice next. Card swipes are the slow ones
    // in Rent Manager, so read this window's card transactions in one batch now
    // (not awaited) and the per-charge lookups find them waiting. One property
    // only: a portfolio window can hold thousands.
    if (scope.startsWith('prop:')) {
      try {
        rmDocuments.prefetchCardTransactions((payload.postings || [])
          .filter(p => String(p.txnType || '').toUpperCase() === 'CC CHG').map(p => p.txnId));
      } catch (e) { /* a warm-up only */ }
    }
    res.json({ ...payload, scope, key });
  } catch (err) {
    res.status(502).json({ error: `Rent Manager: ${err.message}` });
  }
});

// ── The invoice behind one variance posting (2026-10-13) ────────────────────
// The regional manager, reviewing flags: the bill is the first thing he opens, and finding it
// meant leaving for Rent Manager. Each posting in a flag's "Bills & invoices"
// list can now pull the bill it was paid on and the files attached to it — the
// same lookup the Renovations tab runs (rmDocuments.backupFor).
//
// The posting is found again server-side (the GL report is cached for five
// minutes) rather than trusted from the query string, so a hand-made URL cannot
// pull a document for a charge that is not on the flag.
async function varianceChargeFor(req) {
  const scope = String(req.query.scope || 'portfolio');
  const key = String(req.query.key || '');
  const postingIdQ = String(req.query.posting || '');
  const lineRefs = propertyFinancials.CATEGORY_REFS[key];
  if (!lineRefs) return { status: 400, error: `Unknown or non-GL line "${key}".` };
  if (!postingIdQ) return { status: 400, error: 'Need ?posting=<id>.' };
  const fromYM = String(req.query.from || ''), toYM = String(req.query.to || '');
  if (!/^\d{4}-\d{2}$/.test(fromYM) || !/^\d{4}-\d{2}$/.test(toYM)) return { status: 400, error: 'Need from=YYYY-MM&to=YYYY-MM.' };
  const members = (propertyFinancials.loadSnapshot() || {}).categoryMembers || {};
  const refs = [...new Set(lineRefs.flatMap(r => [String(r), ...(members[r] || []).map(String)]))];
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const startDate = `${fy}-${String(fm).padStart(2, '0')}-01`;
  const endDate = `${ty}-${String(tm).padStart(2, '0')}-${String(new Date(ty, tm, 0).getDate()).padStart(2, '0')}`;
  const { byId } = await require('./services/entityMap').buildPropertyEntityMap(rentManager);
  let propOwnerIds;
  if (scope.startsWith('prop:')) {
    const pid = Number(scope.slice(5));
    if (!byId.has(pid)) return { status: 400, error: `Unknown property ${pid}.` };
    propOwnerIds = propertyMerges.idsFor(pid).join(',');
  } else if (scope === 'portfolio') {
    propOwnerIds = [...byId.keys()].join(',');
  } else {
    const ids = [...byId.entries()].filter(([, m]) => m.entity === scope).map(([id]) => id);
    if (!ids.length) return { status: 400, error: `Unknown entity "${scope}".` };
    propOwnerIds = ids.join(',');
  }
  const payload = await glTransactions.getGLDetail({ propOwnerIds, refs, startDate, endDate });
  const p = (payload.postings || []).find(x => x.id === postingIdQ);
  if (!p) return { status: 404, error: 'That posting is not in this flag’s window any more — reopen the flag.' };
  // Report 51 names the property by ShortName; map it back to the id the bill
  // lookup filters on. A property scope is the answer outright.
  // A merged building's posting can sit on any member, so it is named by the
  // posting itself, the same way a portfolio or entity scope is.
  let propertyId = scope.startsWith('prop:') && propertyMerges.idsFor(scope.slice(5)).length === 1
    ? Number(scope.slice(5)) : null;
  let propertyName = '';
  if (propertyId == null) {
    const hit = [...byId.entries()].find(([, m]) => m.shortName && String(m.shortName).trim().toUpperCase() === String(p.property || '').trim().toUpperCase());
    if (hit) { propertyId = hit[0]; propertyName = hit[1].name || ''; }
  } else {
    propertyName = (byId.get(propertyId) || {}).name || '';
  }
  const acct = (payload.accounts || []).find(a => String(a.id) === String(p.accountId)) || {};
  const charge = {
    id: `var:${p.id}`,
    date: p.date,
    amount: p.amount,
    reference: p.reference,
    description: p.description,
    vendor: p.vendor,
    vendorId: p.vendorId,
    txnId: p.txnId,
    txnType: p.txnType,
    invoiceNo: p.invoiceNo,
    propertyId,
    propertyName,
    accountId: p.accountId,
    accountRef: acct.ref || '',
    accountName: p.account || acct.name || '',
    unitName: null,
  };
  return { charge, posting: p };
}

app.get('/api/variance/invoice', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) return res.status(400).json({ error: 'RM credentials not set.' });
  try {
    const found = await varianceChargeFor(req);
    if (found.error) return res.status(found.status).json({ error: found.error });
    const backup = await rmDocuments.backupFor(found.charge);
    res.json({ posting: found.posting, backup });
  } catch (err) {
    res.status(502).json({ error: `Rent Manager: ${publicErrorMessage(err)}` });
  }
});

app.get('/api/variance/invoice/file', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) return res.status(400).json({ error: 'RM credentials not set.' });
  const attachmentId = String(req.query.attachment || '');
  if (!attachmentId) return res.status(400).json({ error: 'Need &attachment=<id>.' });
  try {
    const found = await varianceChargeFor(req);
    if (found.error) return res.status(found.status).json({ error: found.error });
    // Validated against the posting's OWN backup (cached five minutes), so only a
    // file that is on this charge's bill can be served.
    const backup = await rmDocuments.backupFor(found.charge);
    const meta = (backup.attachments || []).find(a => String(a.id) === attachmentId);
    if (!meta) return res.status(404).json({ error: 'That attachment is not on this charge.' });
    const file = await rmDocuments.fetchAttachment(meta);
    if (!file) {
      return res.status(502).json({ error: 'Rent Manager listed this attachment but would not serve the file through the API. Open it on the bill in Rent Manager.' });
    }
    const name = file.fileName || meta.name || `attachment-${attachmentId}`;
    res.setHeader('Content-Type', file.contentType || meta.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${name.replace(/["\\]/g, '')}"`);
    return res.send(file.buffer);
  } catch (err) {
    return res.status(502).json({ error: `Rent Manager: ${publicErrorMessage(err)}` });
  }
});

// ── What is actually wrong, found in Rent Manager (2026-10-22) ──────────────
// The owner: "Every variance should produce a PDF report … also doing digging into
// solving it on its own — going into Rent Manager and actually finding the actual
// issue itself." services/varianceInvestigation.js does what a person would:
// puts the flagged month's General Ledger postings beside last month's and last
// year's, names the ones that account for the change, classifies them by rule
// (one big bill, a new vendor, a duplicate payment, a credit, a bill on the wrong
// building…), and says "could not determine" when the postings do not show it.
// Only endpoints this site already calls: Report 51 and /Bills. At most four
// Report 51 runs and three bill lookups per answer, and the answer is kept per
// (scope, line, month) until the P&L snapshot is refreshed — a pack of twenty
// reports asks Rent Manager once for each.
//
//   GET /api/variance/investigate?scope=portfolio|<Entity>|prop:<id>&key=<line>&month=YYYY-MM
// Access: the /api/variance/ prefix — Variances (services/accessControl.js).
async function varianceScopeInfo(scope) {
  const { byId } = await require('./services/entityMap').buildPropertyEntityMap(rentManager);
  const shortOf = id => String((byId.get(Number(id)) || {}).shortName || '').trim();
  if (scope.startsWith('prop:')) {
    const pid = Number(scope.slice(5));
    const me = byId.get(pid);
    if (!me) { const e = new Error(`Unknown property ${pid}.`); e.code = 'BAD_REQUEST'; throw e; }
    const ids = propertyMerges.idsFor(pid);
    const mine = new Set(ids.map(Number));
    return {
      kind: 'property', label: me.name || String(pid), entity: me.entity || '',
      propOwnerIds: ids.join(','),
      ownShortNames: ids.map(shortOf).filter(Boolean),
      siblingOwnerIds: [...byId.entries()].filter(([id, m]) => m.entity === me.entity && !mine.has(Number(id))).map(([id]) => id),
    };
  }
  if (scope === 'portfolio') return { kind: 'portfolio', label: 'All Entities', entity: '', propOwnerIds: [...byId.keys()].join(','), ownShortNames: [], siblingOwnerIds: [] };
  const ids = [...byId.entries()].filter(([, m]) => m.entity === scope).map(([id]) => id);
  if (!ids.length) { const e = new Error(`Unknown entity "${scope}".`); e.code = 'BAD_REQUEST'; throw e; }
  return { kind: 'entity', label: scope, entity: scope, propOwnerIds: ids.join(','), ownShortNames: [], siblingOwnerIds: [] };
}

function varianceInvestigationDeps() {
  const snap = propertyFinancials.loadSnapshot() || {};
  const members = snap.categoryMembers || {};
  const refsFor = key => {
    const lineRefs = propertyFinancials.CATEGORY_REFS[key];
    return lineRefs ? [...new Set(lineRefs.flatMap(r => [String(r), ...(members[r] || []).map(String)]))] : null;
  };
  return {
    now: () => new Date(),
    snapshotStamp: () => snap.refreshedAt || '',
    refsFor,
    lineLabel: key => {
      const item = (varianceConfig.getConfig().items || []).find(i => i.key === key);
      return item ? item.label : key;
    },
    resolveScope: varianceScopeInfo,
    getGLDetail: args => glTransactions.getGLDetail(args),
    // The bill behind one posting, through the same lookup the invoice button uses.
    billBackup: async (p) => {
      const { byId } = await require('./services/entityMap').buildPropertyEntityMap(rentManager);
      const hit = [...byId.entries()].find(([, m]) => m.shortName && String(m.shortName).trim().toUpperCase() === String(p.property || '').trim().toUpperCase());
      return rmDocuments.backupFor({
        id: `var:${p.id}`, date: p.date, amount: p.amount, reference: p.reference, description: p.description,
        vendor: p.vendor, vendorId: p.vendorId, txnId: p.txnId, txnType: p.txnType, invoiceNo: p.invoiceNo,
        propertyId: hit ? hit[0] : null, propertyName: hit ? (hit[1].name || '') : '',
        accountId: p.accountId, accountRef: '', accountName: p.account || '', unitName: null,
      });
    },
  };
}

app.get('/api/variance/investigate', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) return res.status(400).json({ error: 'RM credentials not set.' });
  try {
    res.json(await varianceInvestigation.investigate({
      scope: String(req.query.scope || 'portfolio'), key: String(req.query.key || ''), month: String(req.query.month || ''),
    }, varianceInvestigationDeps()));
  } catch (err) {
    if (err.code === 'BAD_REQUEST') return res.status(400).json({ error: err.message });
    res.status(502).json({ error: `Rent Manager: ${publicErrorMessage(err)}` });
  }
});

// Move-in / move-out counts per property/entity/month (from /Leases actual
// move dates — see services/moveActivity.js). Serves the cache immediately and
// self-refreshes in the background when stale; 202 = first build still running.
app.get('/api/variance/move-activity', (req, res) => {
  if (!rentManager.isConfigured()) {
    return res.json({ configured: false, message: 'RM credentials not set.' });
  }
  const { cache, building, lastError } = moveActivity.getStatus();
  if (cache) return res.json({ ...cache, building });
  return res.status(building ? 202 : 503).json({ configured: true, building, lastError });
});

// Bills expensed a second time by a hand-keyed check (services/duplicatePayments.js).
// Never calls Rent Manager on a read: an empty cache starts the one build and
// answers 202, the same way move activity does.
app.get('/api/variance/duplicate-payments', (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) {
    return res.json({ configured: false, message: 'RM credentials not set.' });
  }
  const { cache, building, lastError } = duplicatePayments.status();
  if (cache) return res.json({ ...cache.data, refreshedAt: cache.refreshedAt, building });
  if (!building) duplicatePayments.refresh().catch(() => {});
  return res.status(202).json({ configured: true, building: true, lastError });
});

// ── Non-Operating (Renovation) Expense Detail ────────────────────────────────
// The tab that replaces a manual Rent Manager walkthrough: unit-level renovation
// charges rolled up by property, each one openable down to its backup document.
// See services/renovationExpenses.js for why the pull is shaped the way it is.
//
// Cached like every other source — this route NEVER calls Rent Manager. The
// refresh button (REFRESH_SOURCES key 'renovations') is what rebuilds it.
app.get('/api/renovations', (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) {
    return res.json({ configured: false, message: 'RM credentials not set.' });
  }
  // status() also notices a snapshot built under a superseded GL mapping and kicks
  // the rebuild itself — see makeSnapshotCache's isOutdated. The flag travels to
  // the tab so it can say "these numbers are from the old mapping, a rebuild is
  // running" rather than showing yesterday's account list with no explanation.
  const { cache, building, lastError, refreshedAt, outdated } = renovationExpenses.status();
  if (cache) return res.json({ ...cache.data, refreshedAt, building, lastError, outdated });
  return res.status(building ? 202 : 503).json({
    configured: true, building, lastError,
    message: building ? 'First pull in progress.' : 'Nothing pulled yet — press Refresh on the Renovations tab.',
  });
});

// The backup behind ONE charge: invoice attachment, bill worksheet cross-check,
// payment record, and the credit card statement charge when it was paid on a card.
//
// This one DOES reach Rent Manager, deliberately: it fires on a click, not on page
// load, exactly like the Variance tab's GL drill-down. Pre-pulling a document for
// every charge in the window would be thousands of calls for the handful anyone
// ever opens. Results are cached for five minutes inside services/rmDocuments.js.
app.get('/api/renovations/backup', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) {
    return res.status(400).json({ error: 'RM credentials not set.' });
  }
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Need the charge id (?id=…).' });

  // The charge is looked up in the snapshot rather than trusted from the query
  // string: the identifying fields (property, date, amount, GL account) are what
  // the bill match runs on, and taking those from the caller would let a hand-made
  // URL pull a document for a charge that isn't on this tab.
  const { cache } = renovationExpenses.status();
  if (!cache) return res.status(503).json({ error: 'No renovation snapshot yet — press Refresh on the Renovations tab first.' });
  const charge = (cache.data.charges || []).find(c => c.id === id);
  if (!charge) return res.status(404).json({ error: 'That charge is not in the current snapshot.' });

  try {
    // ?force=1 is the explicit slow path: search Rent Manager again even when the
    // sweep already came back empty for this charge. Off by default, because that
    // search takes about a minute and reaches the sweep's answer.
    const force = req.query.force === '1' || req.query.force === 'true';
    res.json({ charge, backup: await rmDocuments.backupFor(charge, { force }) });
  } catch (err) {
    res.status(502).json({ error: `Rent Manager: ${publicErrorMessage(err)}` });
  }
});

// A full sweep of what this Rent Manager API actually offers — resources and
// reports — run from the browser.
//
// Two questions kept coming up that nobody could answer without a local checkout
// and credentials: "did you look at the WHOLE API?" (no — the document probe
// covers eight endpoints out of many) and "would admin rights on Rent Manager
// help?" (unanswerable without seeing whether a missing endpoint returns 403 or
// 404, which are opposite problems). This answers both.
//
// The status code is the point. 403 means the endpoint EXISTS and this API user
// is not allowed to see it — a permissions change on the Rent Manager side fixes
// it. 404 means this API build does not have it at all, and no amount of admin
// will conjure it. Reporting "unavailable" for both, as the document probe did,
// hid that distinction.
//
// It also lists the REPORTS the instance exposes, which matters more than it
// sounds: the unit-level P&L demoed in the classic client is a report, and if it
// is in this list we can run it directly instead of inferring units from charge
// descriptions.
//
// Read-only. Costs one request per resource probed, run sequentially.
const SCAN_RESOURCES = [
  // Document / AP side — the invoice hierarchy.
  'Bills', 'BillDetails', 'BillCharges', 'Attachments', 'Files', 'Documents', 'Images',
  'Payments', 'Checks', 'APChecks', 'BankAccounts', 'BankTransactions', 'Vendors',
  // GL side — where renovation postings live.
  'GLAccounts', 'GLAccountTypes', 'GLTransactions', 'GLDetails', 'JournalEntries', 'Journals',
  // Unit / property side — what could carry a unit-level split.
  'Properties', 'Units', 'UnitTypes', 'Leases', 'Charges', 'PropertyGroups',
  // Anything else worth knowing about.
  'Reports', 'Budgets', 'BudgetDetails', 'Owners', 'Portfolios', 'UserDefinedFields',
];

app.get('/api/renovations/api-scan', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) {
    return res.status(400).json({ error: 'RM credentials not set.' });
  }

  const statusOf = (err) => {
    const m = /\((\d{3})\)/.exec(String(err && err.message) || '');
    return m ? Number(m[1]) : null;
  };

  try {
    const resources = [];
    for (const name of SCAN_RESOURCES) {
      try {
        const body = await rentManager.get(`/${name}`, { pageSize: 1 });
        const rows = Array.isArray(body) ? body : (body && (body.Results || body.Items || body.Data)) || [];
        resources.push({
          name,
          status: 200,
          verdict: 'available',
          sampleFields: Array.isArray(rows) && rows.length && typeof rows[0] === 'object'
            ? Object.keys(rows[0]).sort() : [],
        });
      } catch (err) {
        const status = statusOf(err);
        resources.push({
          name,
          status,
          // The distinction that decides whether an admin can help.
          verdict: status === 401 || status === 403 ? 'permission-denied'
            : status === 404 ? 'not-in-this-api'
            : status === 400 ? 'exists-but-needs-a-filter'
            : 'error',
          error: String(err.message || '').slice(0, 200),
        });
      }
    }

    // The report catalogue. A unit-level P&L, if this instance has one, is here.
    let reports = [];
    let reportsError = null;
    try {
      const body = await rentManager.get('/Reports', { pageSize: 500 });
      const rows = Array.isArray(body) ? body : (body && (body.Results || body.Items || body.Data)) || [];
      reports = rows.map(r => ({
        id: r.ReportID ?? r.ReportId ?? r.ID ?? r.Id ?? null,
        name: String(r.Name || r.ReportName || r.Title || '').trim(),
        category: String(r.Category || r.ReportCategory || r.Group || '').trim(),
      })).filter(r => r.name);
      reports.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      reportsError = String(err.message || '').slice(0, 200);
    }

    // Reports worth looking at for this tab specifically.
    const interesting = reports.filter(r =>
      /unit/i.test(r.name) && /p\s*&?\s*l|profit|income|ledger|expense/i.test(r.name)
      || /general\s*ledger|profit.*loss|income statement/i.test(r.name));

    const denied = resources.filter(r => r.verdict === 'permission-denied');
    const missing = resources.filter(r => r.verdict === 'not-in-this-api');

    res.json({
      scannedAt: new Date().toISOString(),
      resources,
      reports,
      reportsError,
      unitLevelReportCandidates: interesting,
      summary: {
        scanned: resources.length,
        available: resources.filter(r => r.verdict === 'available').length,
        permissionDenied: denied.length,
        notInThisApi: missing.length,
        reportsFound: reports.length,
      },
      // The plain answer to "would admin rights help?"
      adminWouldHelp: denied.length > 0,
      adminVerdict: denied.length
        ? `${denied.length} endpoint${denied.length === 1 ? '' : 's'} returned 401/403 — they exist and this API user is not permitted to read them. Granting that user access in Rent Manager would unlock them: ${denied.map(r => r.name).join(', ')}.`
        : `Nothing returned 401/403. Every endpoint that failed did so with 404 — it is not present in this API build, so Rent Manager permissions are not the blocker.`,
    });
  } catch (err) {
    res.status(502).json({ error: `Rent Manager: ${publicErrorMessage(err)}` });
  }
});

// The full property/entity roster, one row per property.
//
// Asked for repeatedly and never actually available anywhere: the site shows
// entity rollups and per-property numbers, but nothing lists "here is every
// building we manage, which entity owns it, and how many units it has" in a form
// you can hand someone or open in Excel. This is that list, built from the same
// property→entity map and unit sweep every other tab already runs on, so it can
// never disagree with them.
//
// Reads caches only — no Rent Manager call beyond the property map, which is
// itself cached by the client.
app.get('/api/properties/breakdown', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) {
    return res.status(400).json({ error: 'RM credentials not set.' });
  }
  try {
    const { byId, excluded, totalFromRm, gah: group } = await buildPropertyEntityMap(rentManager);

    // Units per property, from the unit-count snapshot when it has been built.
    const unitSnap = unitCounts.loadSnapshot();
    const byProperty = (unitSnap && unitSnap.byProperty) || {};

    const rows = [...byId.entries()].map(([id, meta]) => ({
      entity: meta.entity,
      propertyId: id,
      name: meta.name,
      shortName: meta.shortName || '',
      billingName: meta.billingName || '',
      units: byProperty[id] != null ? byProperty[id] : (byProperty[String(id)] != null ? byProperty[String(id)] : null),
    })).sort((a, b) =>
      String(a.entity).localeCompare(String(b.entity)) || String(a.name).localeCompare(String(b.name)));

    const byEntity = {};
    for (const r of rows) {
      if (!byEntity[r.entity]) byEntity[r.entity] = { entity: r.entity, properties: 0, units: 0 };
      byEntity[r.entity].properties += 1;
      byEntity[r.entity].units += r.units || 0;
    }

    res.json({
      generatedAt: new Date().toISOString(),
      // Where Cedar Ridge's membership came from, and what changed against the list that
      // used to be typed into the code. A total that moved should be explainable
      // without reading a diff.
      group: group ? {
        source: group.source, groupName: group.groupName || null, groupId: group.groupId,
        properties: group.ids ? group.ids.size : null,
        addedVsCodeList: group.added, removedVsCodeList: group.removed, note: group.note || null,
      } : null,
      totals: {
        properties: rows.length,
        units: rows.reduce((t, r) => t + (r.units || 0), 0),
        entities: Object.keys(byEntity).length,
        returnedByRentManager: totalFromRm,
      },
      entities: Object.values(byEntity).sort((a, b) => b.units - a.units),
      properties: rows,
      // Properties Rent Manager returned that the site deliberately does NOT
      // count, with the reason — sold buildings still billed under a live LLC,
      // billing names no rule recognises. A roster that hides its own exclusions
      // is how a portfolio count quietly goes wrong.
      excluded: (excluded || []).map(e => ({
        propertyId: e.propertyId, name: e.name, billingName: e.billingName, reason: e.reason,
      })),
      unitCountsAsOf: unitSnap ? unitSnap.refreshedAt : null,
    });
  } catch (err) {
    res.status(502).json({ error: `Rent Manager: ${publicErrorMessage(err)}` });
  }
});

// "Where does the renovation detail actually live?" — answered from the browser.
//
// The first live pull showed 97 properties with a P&L renovation total and no
// charge detail behind any of them, which is a reasonable thing to disbelieve:
// that money was spent, so the invoices exist somewhere. They do — under the
// child accounts of the roll-up, not the roll-up itself.
//
// Rather than ask anyone to take that on faith, this runs the SAME report that
// produces the P&L number (report 45) for one property and returns every GL row
// it contains, with each row's reference, name, type, whether RM marks it as a
// heading or a subtotal, and its total for the window. The accounts that sum into
// the renovation total are then visible directly, and their reference numbers are
// exactly what RENOVATION_GL_REFS would be set to.
//
// One report run. Read-only.
app.get('/api/renovations/account-probe', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) {
    return res.status(400).json({ error: 'RM credentials not set.' });
  }

  try {
    const { byId } = await buildPropertyEntityMap(rentManager);

    // Default to the property with the most renovation spend the P&L knows about —
    // the one most likely to have detail worth looking at.
    let propertyId = Number(req.query.property);
    if (!Number.isFinite(propertyId)) {
      const { cache } = renovationExpenses.status();
      const rows = (cache && cache.data.reconciliation && cache.data.reconciliation.byProperty) || [];
      const biggest = rows.slice().sort((a, b) => Math.abs(b.expected) - Math.abs(a.expected))[0];
      propertyId = biggest ? biggest.propertyId : [...byId.keys()][0];
    }
    if (!byId.has(propertyId)) return res.status(400).json({ error: `Unknown property ${propertyId}.` });

    // Report 45 returns at most 12 month columns, so ask for exactly 12.
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
    const iso = d => d.toISOString().slice(0, 10);

    const raw = await propertyFinancials.runReport45(String(propertyId), iso(start), iso(end));

    // Sum every month column on a row so a one-line "what did this account carry"
    // figure comes back, without the caller needing to know RM's column keys.
    const MONTHKEY = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{4}$/i;
    const money = v => {
      if (v == null || v === '') return 0;
      if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
      const t = String(v).trim();
      const n = Number(t.replace(/[$,()]/g, ''));
      if (!Number.isFinite(n)) return 0;
      return /\([^)]+\)/.test(t) ? -n : n;
    };
    const truthy = v => v === true || v === 'True' || v === 'true';

    const rows = raw.map(r => {
      let total = 0;
      for (const [k, v] of Object.entries(r)) if (MONTHKEY.test(k)) total += money(v);
      return {
        ref: String(r.GLAccountReference || '').trim(),
        name: String(r.GLAccountName || '').trim(),
        type: String(r.GLAccountTypeName || '').trim(),
        isHeader: truthy(r.IsHeader),
        isTotal: truthy(r.IsTotal),
        total: Math.round(total),
        // Per month, not just the 12-month total. Reconciling against a Rent
        // Manager export is always about one month — "March reads $573,580 here
        // and $434,571 there" — and a single summed figure cannot answer that.
        byMonth: Object.fromEntries(Object.entries(r)
          .filter(([k]) => MONTHKEY.test(k))
          .map(([k, v]) => [k, Math.round(money(v) * 100) / 100])
          .filter(([, v]) => v !== 0)),
      };
    }).filter(r => r.ref || r.name);

    // ── why the tab and a Rent Manager export disagree ────────────────────────
    // The reconciliation ask from the 2026-08-25 meeting: an insurance line read
    // $573,580 here and $434,571 on the export he pulled. Same report, same
    // property, same month.
    //
    // The snapshot runs report 45 with period adjustments INCLUDED — that is what
    // makes it the accrual position. Rent Manager's own P&L export leaves them
    // out. So an accrual booked in one month and reversed in the next shows in
    // ours and not in his, and the two differ by exactly that pair.
    //
    // ?adjustments=compare runs it both ways and prints the accounts that move,
    // so the answer is a list of postings rather than an argument.
    let adjustments = null;
    if (req.query.adjustments === 'compare') {
      const without = await propertyFinancials.runReport45(String(propertyId), iso(start), iso(end),
        { excludePeriodAdjustments: true });
      const key = r => `${String(r.GLAccountReference || '').trim()}|${String(r.GLAccountName || '').trim()}`;
      const sumOf = (rows) => {
        const m = new Map();
        for (const r of rows) {
          if (truthy(r.IsHeader) || truthy(r.IsTotal)) continue;
          const acc = m.get(key(r)) || {};
          for (const [k, v] of Object.entries(r)) if (MONTHKEY.test(k)) acc[k] = (acc[k] || 0) + money(v);
          m.set(key(r), acc);
        }
        return m;
      };
      const withAdj = sumOf(raw);
      const noAdj = sumOf(without);
      const moved = [];
      for (const [k, months] of withAdj) {
        const other = noAdj.get(k) || {};
        const diffs = {};
        let any = false;
        for (const [mk, v] of Object.entries(months)) {
          const d = Math.round((v - (other[mk] || 0)) * 100) / 100;
          if (Math.abs(d) >= 1) { diffs[mk] = d; any = true; }
        }
        if (any) moved.push({ account: k, byMonth: diffs, total: Math.round(Object.values(diffs).reduce((a, b) => a + b, 0)) });
      }
      moved.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      adjustments = {
        note: 'Amounts present with period adjustments and absent without them. This is the difference between this site and a Rent Manager P&L export.',
        accountsAffected: moved.length,
        accounts: moved.slice(0, 40),
      };
    }


    // The renovation neighbourhood: the configured roots, anything sharing their
    // leading digits, and anything whose name reads like renovation spend. Wide on
    // purpose — the point is to SEE what is there, not to filter it out again.
    const roots = renovationExpenses.refRoots();
    const rootPrefixes = roots.map(r => String(r).slice(0, 2));
    const near = rows.filter(r =>
      roots.some(root => r.ref === root || r.ref.startsWith(root))
      || rootPrefixes.some(p => r.ref.startsWith(p))
      || /\bren\b|renovat|rehab|capital/i.test(r.name));

    res.json({
      property: { id: propertyId, ...byId.get(propertyId) },
      window: { from: iso(start), to: iso(end) },
      reportId: propertyFinancials.REPORT_ID,
      configuredRoots: roots,
      adjustments,
      renovationNeighbourhood: near,
      // Everything, for when the neighbourhood filter itself is the thing that's wrong.
      allRows: rows,
      note: 'Rows with a total but no IsTotal flag are posting accounts — those reference numbers are what RENOVATION_GL_REFS should contain.',
    });
  } catch (err) {
    res.status(502).json({ error: `Rent Manager: ${publicErrorMessage(err)}` });
  }
});

// Stream ONE attachment's bytes out to the browser.
//
// This route exists because listing an invoice is not the same as producing it.
// Rent Manager gates file downloads behind the API token header, which a browser
// link cannot send — so without this, a found invoice is a filename the user still
// has to go open in Rent Manager by hand, which is the exact work the tab exists
// to remove.
//
// The attachment id is validated against the charge's OWN backup rather than
// trusted from the query string: a hand-made URL must not be able to pull an
// arbitrary company document out of Rent Manager through this endpoint.
// Which entities and properties will actually show an invoice, and which will not.
//
// The owner, 2026-08-26, before a call: *"I wanna know which properties have the
// bills, which don't so that when I'm showing them on a call, I don't show the
// bad ones."* Pressing Backup on 28,261 charges to find out which are worth
// pressing is not a plan; this answers it for the whole ledger in one pass and
// caches the answer.
app.get('/api/renovations/backup-coverage', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) return res.status(400).json({ error: 'RM credentials not set.' });
  try {
    // Is a sweep running, did the last one fail, how old is the answer? Without
    // this the only visible state is "the number has not changed yet", which is
    // the same whether it is halfway through, crashed, or in a failure cooldown —
    // and waiting on a build that died is indistinguishable from patience.
    if (req.query.status === '1') {
      const st = backupCoverage.status();
      const idx = backupIndex.status();
      return res.json({
        building: st.building, refreshedAt: st.refreshedAt, lastError: st.lastError,
        cooldownMs: st.cooldownMs,
        resolvedEntries: idx.entries,
        documented: st.cache && st.cache.data ? (st.cache.data.documented || []).length : 0,
      });
    }

    const force = req.query.force === '1' || req.query.force === 'true';
    const payload = force ? await backupCoverage.refresh({ force: true }) : await backupCoverage.getFresh();
    const data = payload && payload.data ? payload.data : payload;
    const refreshedAt = payload && payload.refreshedAt ? payload.refreshedAt : null;
    // The per-charge index is about a megabyte and only the board needs it, so
    // the summary panel does not carry it and the board does not carry the tables.
    if (req.query.ids === '1') {
      // A charge whose document is a consolidated statement is re-labelled here
      // rather than in the sweep, so the distinction lands without a two-hour
      // re-run. The charge id goes in as well as the bill id, and it is not
      // optional: without it the test is fan-out alone, which cannot tell one
      // invoice split across forty unit lines from a statement covering four
      // hundred purchases, and calls both a statement.
      const documented = (data.documented || []).map((row) => {
        const at = row.lastIndexOf('|');
        if (at < 0) return row;
        const chargeId = row.slice(0, at);
        const hit = backupIndex.lookup(chargeId);
        if (hit && hit.billId && backupIndex.isStatement(hit.billId, chargeId)) return `${chargeId}|statement`;
        return row;
      });
      return res.json({ refreshedAt, documented, count: documented.length });
    }
    const { documented, ...summary } = data;
    res.json({ ...summary, refreshedAt });
  } catch (err) {
    res.status(502).json({ error: `Backup coverage: ${publicErrorMessage(err)}` });
  }
});

// ── can we put the missing scans BACK? ──────────────────────────────────────
// 5,820 renovation charges have no invoice attached, and they are only 1,236
// distinct invoices — so a backfill is asking a dozen suppliers for copies rather
// than chasing thousands of pieces of paper. What decides whether that backfill is
// a script or a filing-cabinet exercise is whether this API can WRITE an
// attachment onto a bill. Every probe so far has been read-only.
//
// This never creates anything. It sends a deliberately EMPTY body to each
// candidate route and reads the status back, because the four answers are
// different facts and none of them requires a real upload:
//
//   404  the route does not exist here
//   401/403  it exists and this API user may not write to it
//   400/415/422  it exists, accepts writes, and rejected THIS body — which is
//                the answer we want, obtained without putting a row in the ledger
//   200/201  it accepted an empty attachment, which would itself be worth knowing
//
// Read-only by construction: an empty JSON body cannot carry a file.
app.get('/api/renovations/attachment-write-probe', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) return res.status(400).json({ error: 'RM credentials not set.' });

  const seedBill = String(req.query.bill || '');
  const out = { seedBill, note: 'No attachment is created. Empty bodies only.', routes: [] };

  const probe = async (method, path) => {
    try {
      const r = await rentManager.raw(method, path, {});
      out.routes.push({ method, path, status: r.status, body: String(r.body || '').slice(0, 180) });
    } catch (err) {
      out.routes.push({ method, path, status: null, error: String(err && err.message).slice(0, 180) });
    }
  };

  const b = seedBill || '2';
  const ROUTES = [
    ['POST', '/Attachments'],
    ['POST', '/Files'],
    ['POST', '/Documents'],
    ['POST', `/Bills/${encodeURIComponent(b)}/Attachments`],
    ['POST', '/BillAttachments'],
    ['POST', '/FileAttachments'],
    ['PATCH', `/Bills/${encodeURIComponent(b)}`],
  ];
  // One route per call. Seven round trips in a single request is how this probe
  // ran past the host's limit and took the process down with it.
  const only = req.query.route;
  const list = only == null ? ROUTES.slice(0, 1) : ROUTES.slice(Number(only), Number(only) + 1);
  out.routeCount = ROUTES.length;
  out.routeIndex = only == null ? 0 : Number(only);
  for (const [m, p] of list) await probe(m, p);

  res.json(out);
});

// ── the other half: who paid it ─────────────────────────────────────────────
// There is no sweep here, deliberately.
//
// The paid side needs no API call at all: a renovation charge in this ledger IS a
// line of a payment, so txnType and txnId on the snapshot already say who paid
// every one of them — 24,620 by check or ACH, 3,555 by company card, 86 credits
// and journal entries with no payment side. That is the whole answer to "how many
// do we have on the paid side", and it is exact.
//
// What a sweep would add is the bank-reconciliation stamp per charge, and three
// attempts to build one took this instance down each time: first as 2,754 point
// lookups, then paged but retaining the rows, then paged and projected. Even the
// third died, which says the container has no headroom left beside the renovation
// snapshot and the coverage cache rather than saying the sweep was written badly.
//
// So the endpoint is gone rather than left where someone can trigger an outage
// with it. services/paymentCoverage.js stays in the tree with its build() intact:
// the sampling that DOES answer the cleared question (98-99% of checks reconciled)
// was recorded when the endpoint was retired, and if this ever runs it belongs on a worker, not on the process serving the site.

// ── the write test, and its answer ──────────────────────────────────────────
// The owner authorised a real write on 2026-09-03. It ran against a test bill and
// the answer is no: this API cannot attach a document to a bill.
//
// The evidence, in the order it was gathered:
//
//   * POST /Bills/{id}/Attachments is REACHED — it answers 500, not 404, where
//     /Attachments, /Files, /Documents, /BillAttachments and /FileAttachments all
//     answer 404 and PATCH /Bills/{id} answers 405.
//   * Reading a real attachment first, rather than guessing field names, showed
//     why: `IsDepotUsed: true`, `Path: "202607\\Invoice_589.pdf"`,
//     and a signed `Token`. The bytes live on a depot file server; the bill row
//     holds a POINTER to them. So an attachment is not a thing you post — it is a
//     reference to a file that must already exist somewhere this API does not
//     expose.
//   * Three payload shapes (Name/Extension/FileData, File{...}, FileName/Base64)
//     each returned the same opaque 500, "There was an issue retrieving data from
//     the database", and re-reading the bill confirmed **nothing was created**.
//
// So the backfill of 1,236 missing invoices cannot be pushed into Rent Manager
// over this connection. It can still be done — the files live on our side and the
// tab serves them — or Rent Manager support can say what the depot upload route
// is, which is the one question worth asking them.
//
// The write and remove branches are gone now the test has run. An endpoint that
// POSTs to the accounting system is not something to leave standing for a finding
// that is already recorded; the read-only shape probe stays, because that is what
// made the diagnosis rather than the writes.
app.get('/api/renovations/attachment-write-test', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) return res.status(400).json({ error: 'RM credentials not set.' });
  const rows = (b) => (Array.isArray(b) ? b : (b && (b.Results || b.Items || b.Data)) || (b ? [b] : []));
  try {
    const bill = String(req.query.bill || '');
    if (!bill) return res.json({ usage: 'shape=1&bill=N — read-only; the write branches were removed after the test.' });
    const one = rows(await rentManager.get(`/Bills/${encodeURIComponent(bill)}`,
      { embeds: 'Attachments' }))[0] || {};
    const atts = Array.isArray(one.Attachments) ? one.Attachments : [];
    return res.json({
      bill, attachmentCount: atts.length,
      fields: atts.length ? Object.keys(atts[0]) : [],
      sample: atts.length ? { ...atts[0], Token: atts[0].Token ? '(signed token, withheld)' : undefined } : null,
    });
  } catch (err) {
    res.status(502).json({ error: publicErrorMessage(err) });
  }
});

// ── both halves of a charge in one PDF ──────────────────────────────────────
// From the call: something to open in a meeting that shows the bill AND who paid
// it, in one file. Page 1 is the payment record built from Rent Manager; pages 2+
// are the vendor's own invoice, copied unchanged rather than re-rendered.
app.get('/api/renovations/charge-packet', async (req, res) => {
  noStore(res);
  const chargeId = String(req.query.id || '');
  if (!chargeId) return res.status(400).type('text/plain').send('Need ?id=<charge>.');

  const { cache } = renovationExpenses.status();
  if (!cache) return res.status(503).type('text/plain').send('No renovation snapshot yet.');
  const charge = (cache.data.charges || []).find(c => c.id === chargeId);
  if (!charge) return res.status(404).type('text/plain').send('That charge is not in the current snapshot.');

  let backup = null;
  try { backup = await rmDocuments.backupFor(charge); } catch (err) { /* the record stands without it */ }

  const atts = (backup && backup.attachments) || [];
  const fetchDoc = atts.length
    ? async () => {
      const got = await rmDocuments.fetchAttachment(atts[0]);
      if (!got || !got.buffer) return null;
      return { buffer: got.buffer, contentType: got.contentType, fileName: got.fileName || atts[0].name };
    }
    : null;

  try {
    const { bytes, pages } = await chargePacket.build({ charge, backup, fetchDoc });
    const stamp = String(charge.date || '').slice(0, 10);
    const who = String(charge.vendor || 'charge').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40);
    res.type('application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="payment-record-${who}-${stamp}.pdf"`);
    res.setHeader('X-Packet-Pages', String(pages));
    res.send(Buffer.from(bytes));
  } catch (err) {
    res.status(502).type('text/plain').send(`Could not build the packet: ${publicErrorMessage(err)}`);
  }
});

// ── a coversheet for a charge with no document ──────────────────────────────
// From the call: for charges the API cannot pull a document for, she still wants
// something to put in the file.
//
// What this is NOT is a reconstructed invoice. Generating a document that looks
// like a vendor's bill and filing it beside real ones is how a made-up paper ends
// up presented as evidence, and no amount of good intent survives that later. So
// this says what it is on its face, in the title, in a banner, and in the footer:
// a summary of what Rent Manager holds about the charge, produced by this site.
//
// Served as a printable page rather than a generated PDF — the browser makes the
// PDF, which avoids putting a document-generation library on the server for a
// coversheet.
// ── why charged/paid can differ from a Rent Manager export ──────────────────
// The 2026-08-25 meeting: "some of those numbers were off, like fifty, sixty
// dollars. We wanna make sure they're the exact numbers." The guess in the room
// was mid-month move-in proration.
//
// Proration is inside Rent Manager's own figures — we read AmountCharged and
// AmountPaid from report 30's summary and do no proration arithmetic of our own,
// so there is nothing on this side for a part-month to get wrong. The candidate
// that CAN move a small amount is tenant scope: we pass CustomerStatus=2 (current
// and notice), so a tenant who moved out inside the window is FORMER now and
// their charges are in an export run with a wider scope and not in ours.
//
// This runs the same window both ways and prints the difference per charge type,
// so the question is settled by the report rather than by argument.
app.get('/api/collections/scope-check', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) return res.status(400).json({ error: 'RM credentials not set.' });
  try {
    const days = Math.min(400, Math.max(1, Number(req.query.days) || 90));
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    const iso = d => d.toISOString().slice(0, 10);

    const { byId } = await buildPropertyEntityMap(rentManager);
    const entity = String(req.query.entity || '').trim();
    const ids = [...byId.entries()]
      .filter(([, m]) => !entity || String(m.entity || '') === entity)
      .map(([pid]) => pid);
    if (!ids.length) return res.status(400).json({ error: `No properties for entity "${entity}".` });

    const run = async (status) => {
      const p = {
        StartDate: iso(from), EndDate: iso(to), PropertyIDs: ids.join(','),
        SHOWINACTIVEPROPS: 'False', GroupID: '0', BatchProps: 'False',
        CHARGESTOINCLUDE: 'All', SORTOPTIONS: '0', CustomerStatus: String(status),
      };
      const params = {};
      Object.keys(p).forEach((k, i) => {
        params[`parameters[${i}].Parameter`] = k;
        params[`parameters[${i}].Value`] = p[k];
        params[`parameters[${i}].InListItemMode`] = 'false';
      });
      const body = await rentManager.RunReport(30, params);
      const out = new Map();
      for (const r of (body && body.Grid2) || []) {
        out.set(String(r.ReportSummaryChargeType || '').trim(), {
          charged: parseAmount(r.ReportSummaryAmountCharged),
          paid: parseAmount(r.ReportSummaryAmountPaid),
        });
      }
      return out;
    };

    // CustomerStatus is a set, not a scale — 0 is rejected outright ("You must
    // select at least one tenants status to include"), so "everything" has to be
    // found rather than assumed. Each candidate is run and reported with its own
    // total; the one that carries MORE than the tab's scope is the one an export
    // would have been run under.
    const candidates = String(req.query.status || '1,2,3,4,5,6,7')
      .split(',').map(v => v.trim()).filter(Boolean);
    const scopes = [];
    for (const c of candidates) {
      try {
        const m = await run(c);
        const charged = [...m.values()].reduce((t, v) => t + v.charged, 0);
        const paid = [...m.values()].reduce((t, v) => t + v.paid, 0);
        scopes.push({ status: c, ok: true, types: m.size,
          charged: Math.round(charged * 100) / 100, paid: Math.round(paid * 100) / 100, map: m });
      } catch (err) {
        scopes.push({ status: c, ok: false, error: String(err && err.message ? err.message : err).slice(0, 120) });
      }
    }
    const ok = scopes.filter(x => x.ok);
    const ours = (ok.find(x => x.status === '2') || {}).map || new Map();
    // The widest scope that answered — whatever RM calls "include everyone".
    const widest = ok.reduce((best, x) => (!best || x.charged > best.charged ? x : best), null);
    const all = (widest && widest.map) || new Map();
    const types = [...new Set([...ours.keys(), ...all.keys()])];
    const rows = [];
    let dc = 0, dp = 0;
    for (const t of types) {
      const a = ours.get(t) || { charged: 0, paid: 0 };
      const b = all.get(t) || { charged: 0, paid: 0 };
      const diff = { type: t, chargedDiff: Math.round((b.charged - a.charged) * 100) / 100,
        paidDiff: Math.round((b.paid - a.paid) * 100) / 100 };
      if (diff.chargedDiff || diff.paidDiff) { rows.push(diff); dc += diff.chargedDiff; dp += diff.paidDiff; }
    }
    rows.sort((a, b) => Math.abs(b.chargedDiff) - Math.abs(a.chargedDiff));
    res.json({
      entity: entity || '(whole portfolio)', properties: ids.length,
      window: { from: iso(from), to: iso(to) },
      scopes: scopes.map(({ map, ...rest }) => rest),
      tabScope: '2', widestScope: widest ? widest.status : null,
      note: 'Amounts present when every tenant status is included and absent with CustomerStatus=2 (current + notice). A tenant who moved out inside the window is FORMER now, so their charges sit in a wider-scope export and not in the tab.',
      chargedDifference: Math.round(dc * 100) / 100,
      paidDifference: Math.round(dp * 100) / 100,
      byChargeType: rows.slice(0, 30),
    });
  } catch (err) {
    res.status(502).json({ error: `Rent Manager: ${publicErrorMessage(err)}` });
  }
});

// ── what Rent Manager knows about money leaving the account ─────────────────
// An earlier design note was written from search results in one sitting and never checked
// against this instance. Its first and cheapest route was "Rent Manager may
// already import the bank statement for reconciliation, in which case there is
// nothing to integrate" — and everything downstream of that (whether to ring
// First Commerce, whether an aggregator is needed) depends on the answer.
//
// The join it proposes is check number: RM says a check was written, the bank
// says it cleared. So this asks three things of the live API rather than of a
// search engine: is there a reconciliation-shaped resource here, does a check
// record carry a CHECK NUMBER to join on, and does it carry any sign of having
// CLEARED. Read-only, one page per resource.
// ── how a bill connects to the money that paid it ───────────────────────────
// From the brief: for any charge she needs BOTH sides — the invoice and the card
// side — pulled together. The invoice side works. The payment side was written
// against /Payments and /Checks filtered by BillID, and the card side against
// /BankTransactions, and a live sample of 20 bill charges found a payment record
// on none of them. /BankTransactions 404s on this instance and a /Checks row has
// no BillID field on it at all, so both were querying things that do not exist.
//
// The route that DOES work is already proven by the coverage sweep, backwards: a
// check's own CheckDetails name the BillDetailIDs they settled. This probes the
// forward direction — bill to check, and bill to card transaction — against real
// bills rather than guessing a second time.
app.get('/api/payments/probe', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) return res.status(400).json({ error: 'RM credentials not set.' });
  const out = { bills: [], embeds: [], resources: [] };
  const rows = (body) => (Array.isArray(body) ? body
    : (body && (body.Results || body.Items || body.Data)) || (body ? [body] : []));
  const fieldsOf = (r) => (r && typeof r === 'object' ? Object.keys(r) : []);

  try {
    // Which embeds a bill will actually accept. An embed the server rejects comes
    // back as a 400, so they are asked for one at a time rather than in a list
    // that fails as a whole and says nothing about which name was the bad one.
    const seed = rows(await rentManager.get('/Bills', { pageSize: 5 }));
    const billId = seed.length ? (seed[0].BillID || seed[0].ID || seed[0].Id) : null;
    out.seedBill = billId;
    out.billFields = fieldsOf(seed[0]);
    for (const name of ['Payments', 'Checks', 'CheckDetails', 'BillDetails', 'PaymentDetails',
                        'CreditCardTransactions', 'GLTransactions', 'Vendor']) {
      if (billId == null) break;
      try {
        const body = await rentManager.get(`/Bills/${encodeURIComponent(billId)}`, { embeds: name });
        const one = rows(body)[0] || {};
        out.embeds.push({ name, ok: true, present: Object.prototype.hasOwnProperty.call(one, name),
          sample: fieldsOf((one[name] || [])[0] || null) });
      } catch (err) {
        out.embeds.push({ name, ok: false, error: publicErrorMessage(err).slice(0, 120) });
      }
    }

    // And whether the payment-side resources can be filtered by a bill at all.
    for (const probe of [
      { label: '/Payments pageSize 1', path: '/Payments', params: { pageSize: 1 } },
      { label: '/PaymentDetails pageSize 1', path: '/PaymentDetails', params: { pageSize: 1 } },
      { label: '/CheckDetails pageSize 1', path: '/CheckDetails', params: { pageSize: 1 } },
      { label: '/CheckDetails by BillDetailID', path: '/CheckDetails',
        params: { filters: 'BillDetailID,eq,1', pageSize: 1 } },
      { label: '/CreditCardTransactions pageSize 1', path: '/CreditCardTransactions', params: { pageSize: 1 } },
      { label: '/CreditCards pageSize 1', path: '/CreditCards', params: { pageSize: 1 } },
    ]) {
      try {
        const body = await rentManager.get(probe.path, probe.params);
        const r = rows(body);
        out.resources.push({ label: probe.label, ok: true, count: r.length, fields: fieldsOf(r[0]) });
      } catch (err) {
        out.resources.push({ label: probe.label, ok: false, error: publicErrorMessage(err).slice(0, 140) });
      }
    }
    // What kinds of payment exist at all. Card detection reads the check row's
    // TransactionType, so whether a card-paid bill even shows up here — and under
    // what name — decides whether that detection can ever fire.
    try {
      const recent = rows(await rentManager.get('/Checks',
        { filters: 'TransactionDate,ge,2026-01-01', pageSize: 500 }));
      const kinds = {};
      const banks = {};
      for (const r of recent) {
        kinds[String(r.TransactionType || '(none)')] = (kinds[String(r.TransactionType || '(none)')] || 0) + 1;
        banks[String(r.BankID)] = (banks[String(r.BankID)] || 0) + 1;
      }
      out.checkKinds = { sampled: recent.length, transactionTypes: kinds, bankIds: banks };
    } catch (err) {
      out.checkKinds = { error: publicErrorMessage(err).slice(0, 140) };
    }

    // Walk the route forward on real bills: bill → BillDetails → CheckDetails →
    // Check. A filter that is merely ACCEPTED proves nothing; the question is
    // whether it comes back with the check that actually paid this bill.
    const want = String(req.query.bills || '').split(',').map(x => x.trim()).filter(Boolean);
    for (const id of want.slice(0, 6)) {
      const walk = { billId: id };
      try {
        const one = rows(await rentManager.get(`/Bills/${encodeURIComponent(id)}`,
          { embeds: 'BillDetails' }))[0] || {};
        const details = one.BillDetails || [];
        walk.detailIds = details.map(d => d.BillDetailID).filter(x => x != null);
        walk.billAmount = one.Amount;
        walk.checks = [];
        for (const did of walk.detailIds.slice(0, 4)) {
          const cds = rows(await rentManager.get('/CheckDetails',
            { filters: `BillDetailID,eq,${did}`, pageSize: 10 }));
          for (const cd of cds) {
            const entry = { billDetailId: did, checkId: cd.CheckID, amount: cd.Amount };
            try {
              const chk = rows(await rentManager.get(`/Checks/${encodeURIComponent(cd.CheckID)}`, {}))[0] || {};
              entry.check = { reference: chk.Reference, date: chk.TransactionDate, payee: chk.Payee,
                amount: chk.Amount, reconcileId: chk.ReconcileID, type: chk.TransactionType,
                bankId: chk.BankID, accountType: chk.AccountType };
            } catch (err) { entry.checkError = publicErrorMessage(err).slice(0, 90); }
            walk.checks.push(entry);
          }
        }
      } catch (err) {
        walk.error = publicErrorMessage(err).slice(0, 140);
      }
      out.bills.push(walk);
    }
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: `Payment probe: ${publicErrorMessage(err)}`, partial: out });
  }
});

// ── the Variance tab, against a fresh Rent Manager pull ─────────────────────
// The owner, 2026-09-14: in the meeting, the regional manager pulls a real T-12 out of Rent
// Manager and compares it to the tab to see whether the tool is even accurate.
// That is the right test, and it should not be the first time anybody runs it.
//
// This runs it here, where the Rent Manager credentials already live, so nobody
// has to hand a login to anyone. Same three questions as
// scripts/reconcileT12.js: the parameters both sides must be running, the rollup
// identities, and each entity re-pulled and compared cell for cell.
//
//   /api/variance/reconcile                    the identities, no RM calls
//   /api/variance/reconcile?live=1             …and every entity re-pulled
//   /api/variance/reconcile?live=1&scope=Birchwood Commons one entity
//   /api/variance/reconcile?line=insurance     that line's T-12, every scope
app.get('/api/variance/reconcile', async (req, res) => {
  noStore(res);
  try {
    const live = req.query.live === '1' || req.query.live === 'true';
    if (live && !rentManager.isConfigured()) {
      return res.status(400).json({ error: 'A live comparison needs Rent Manager credentials.' });
    }
    res.json(await varianceReconcile.run({
      live,
      scope: req.query.scope || null,
      line: req.query.line || null,
    }));
  } catch (err) {
    res.status(502).json({ error: `Variance reconcile: ${publicErrorMessage(err)}` });
  }
});

// ── the three leads the inventory sweep turned up ───────────────────────────
// Each is a thing somebody asked for, and none can be settled from the outside:
// whether a purchase order can be LINKED to a bill (an approval we cannot attach
// to a charge is trivia), whether a history note's FileID leads to actual bytes
// (the only new lead on the 47 charges with no scan), and whether RM's property
// groups describe the same entities this site reports (if they carve the
// portfolio differently, adopting them would silently re-base every entity
// figure). Read-only. Counts, field names and ids — never note text or bytes.
app.get('/api/rm/leads', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) return res.status(400).json({ error: 'RM credentials not set.' });
  try {
    res.json(await rmLeads.run());
  } catch (err) {
    res.status(502).json({ error: `Leads probe: ${publicErrorMessage(err)}` });
  }
});

// ── everything this Rent Manager could give us ──────────────────────────────
// "Is there any information in the API that we're just leaving out that could
// relate to this tool?" Twice now the answer has been yes, and both times it cost
// weeks: invoices ride on the bill as an embed while /Attachments 404s, and the
// bank accounts were in /GLAccounts while /BankAccounts 404s. So the question is
// a command rather than an afternoon.
//
// Read-only, ~60 paced GETs, cached for half an hour. Returns resource names,
// HTTP status and FIELD NAMES only — never a field value, because half of these
// resources are tenant-side and a schema is safe where a row is not.
app.get('/api/rm/inventory', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) return res.status(400).json({ error: 'RM credentials not set.' });
  try {
    res.json(await rmInventory.sweep({ force: req.query.force === '1' }));
  } catch (err) {
    res.status(502).json({ error: `API inventory: ${publicErrorMessage(err)}` });
  }
});

app.get('/api/bank/probe', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) return res.status(400).json({ error: 'RM credentials not set.' });

  const CANDIDATES = [
    'BankAccounts', 'Banks', 'BankTransactions', 'BankDeposits', 'Deposits',
    'Reconciliations', 'BankReconciliations', 'ReconciliationItems',
    'ClearedTransactions', 'Statements', 'BankStatements', 'GLAccounts',
  ];
  const CLEARED = /clear|reconcil|settle|posted|void/i;
  const NUMBERISH = /checknumber|checkno|check_num|reference|documentnumber/i;

  const out = { resources: [], checks: null, payments: null, directory: null };

  // Can we put a NAME and a last four on a check, or only a BankID? That is the
  // whole of Sarah's ask (2026-09-03) and it is one question, so it gets one
  // answer here rather than being inferred from the resource table below.
  try {
    const dir = await rmDocuments.bankDirectory();
    out.directory = {
      resolvedFrom: dir.source,
      // A check joins on BankID. If the directory is keyed on something else here,
      // the join is naming accounts by the wrong id space and every label on the
      // payment record is suspect — so this field is the first one to read.
      keyedOn: dir.keyedOn,
      accounts: dir.byId.size,
      tried: dir.tried,
      // Names and last four only. A full account number is never read out of
      // this endpoint, whatever Rent Manager holds.
      sample: [...dir.byId.values()].slice(0, 25)
        .map(b => ({ id: String(b.id), name: b.name || null, last4: b.last4 || null, from: b.last4From })),
    };
  } catch (err) {
    out.directory = { error: publicErrorMessage(err).slice(0, 160) };
  }

  // And the route a resource list cannot find. /Attachments 404s on this instance
  // and invoices are reachable anyway, because they ride on the bill as an embed —
  // so the same question is worth asking of a check before the account is written
  // off as unreachable.
  try {
    const seed = (await rentManager.get('/Checks', { pageSize: 1 }));
    const rows = Array.isArray(seed) ? seed : (seed && (seed.Results || seed.Items || seed.Data)) || [];
    const id = rows.length ? (rows[0].ID || rows[0].CheckID) : null;
    out.checkEmbed = { checkId: id, tried: [] };
    for (const name of ['Bank', 'BankAccount']) {
      if (id == null) break;
      try {
        const body = await rentManager.get(`/Checks/${encodeURIComponent(id)}`, { embeds: name });
        const row = Array.isArray(body) ? body[0] : body;
        const nested = row && (row[name] || row[`${name}s`]);
        const b = Array.isArray(nested) ? nested[0] : nested;
        out.checkEmbed.tried.push({ name, ok: true, present: Boolean(b && typeof b === 'object'),
          // Field NAMES only — no account numbers leave this endpoint.
          fields: b && typeof b === 'object' ? Object.keys(b) : [] });
      } catch (err) {
        out.checkEmbed.tried.push({ name, ok: false, error: publicErrorMessage(err).slice(0, 120) });
      }
    }
  } catch (err) {
    out.checkEmbed = { error: publicErrorMessage(err).slice(0, 160) };
  }

  for (const name of CANDIDATES) {
    try {
      const body = await rentManager.get(`/${name}`, { pageSize: 1 });
      const rows = Array.isArray(body) ? body : (body && (body.Results || body.Items || body.Data)) || [];
      const fields = rows.length && typeof rows[0] === 'object' ? Object.keys(rows[0]) : [];
      out.resources.push({ name, available: true, fields,
        clearedFields: fields.filter(f => CLEARED.test(f)) });
    } catch (err) {
      const m = /\((\d{3})\)/.exec(String(err && err.message) || '');
      out.resources.push({ name, available: false, status: m ? Number(m[1]) : null });
    }
  }

  // The two records the join would actually run on.
  for (const [key, path] of [['checks', '/Checks'], ['payments', '/Payments']]) {
    try {
      const body = await rentManager.get(path, { pageSize: 1 });
      const rows = Array.isArray(body) ? body : (body && (body.Results || body.Items || body.Data)) || [];
      const row = rows.length ? rows[0] : null;
      const fields = row ? Object.keys(row) : [];
      out[key] = {
        available: true, fields,
        // Can we join on a check number at all?
        numberFields: fields.filter(f => NUMBERISH.test(f)),
        // Does RM already know it cleared? If it does, no bank feed is needed.
        clearedFields: fields.filter(f => CLEARED.test(f)),
        sampleReference: row ? (row.Reference != null ? String(row.Reference).slice(0, 40) : null) : null,
      };
    } catch (err) {
      const m = /\((\d{3})\)/.exec(String(err && err.message) || '');
      out[key] = { available: false, status: m ? Number(m[1]) : null };
    }
  }

  // ── a field existing is not the same as the process being used ────────────
  // The mistake this guards against is one already made twice on this project:
  // /History carried a HistoryAttachments field and had none, and the sweep
  // reported 3,555 card charges as undocumented when it had simply been
  // throttled. So ReconcileID being present on the Checks schema proves nothing.
  // What matters is whether checks actually CARRY one — that is the difference
  // between "Rent Manager could tell us a check cleared" and "Rent Manager does".
  // RECENT checks, not the first page. The first page is check id 1 upward —
  // 2018 records, reconciled at the time — and every one of them carries a
  // ReconcileID. Reading that as "reconciliation is happening" would be the same
  // sampling mistake that had four runs concluding things from the first history
  // row the API handed back. What matters is whether checks written THIS YEAR
  // carry one.
  const recentFrom = new Date(Date.now() - (Number(req.query.days) || 180) * 86400000)
    .toISOString().slice(0, 10);
  try {
    const body = await rentManager.get('/Checks', {
      filters: `TransactionDate,ge,${recentFrom}`, pageSize: 500,
    });
    const rows = Array.isArray(body) ? body : (body && (body.Results || body.Items || body.Data)) || [];
    const has = r => r.ReconcileID != null && String(r.ReconcileID) !== '0' && String(r.ReconcileID) !== '';
    const withRef = rows.filter(r => r.Reference != null && String(r.Reference).trim() !== '');
    out.reconciliation = {
      since: recentFrom,
      checksSampled: rows.length,
      withReconcileId: rows.filter(has).length,
      withCheckNumber: withRef.length,
      // Both together is the whole join: a number to match on, and a flag saying
      // the money actually moved.
      withBoth: rows.filter(r => has(r) && r.Reference != null && String(r.Reference).trim() !== '').length,
      sampleReferences: withRef.slice(0, 8).map(r => String(r.Reference).slice(0, 24)),
    };
  } catch (err) {
    out.reconciliation = { error: String(err && err.message ? err.message : err).slice(0, 160) };
  }

  try {
    // Same trap: the first page is 2018. Ask for the recent ones.
    let rows = [];
    for (const params of [
      { filters: `ReconciliationDate,ge,${recentFrom}`, pageSize: 200 },
      { pageSize: 200 },
    ]) {
      try {
        const body = await rentManager.get('/BankReconciliations', params);
        rows = Array.isArray(body) ? body : (body && (body.Results || body.Items || body.Data)) || [];
        if (rows.length) break;
      } catch (err) { /* the filter may not be supported — fall back to a page */ }
    }
    const dated = rows.map(r => String(r.ReconciliationDate || '').slice(0, 10)).filter(Boolean).sort();
    out.bankReconciliations = {
      rows: rows.length,
      earliest: dated[0] || null,
      latest: dated[dated.length - 1] || null,
      // Counted off the LATEST date, not off this page. The rows come back oldest
      // first, so counting "how many in this page are recent" answered 0 on a
      // portfolio whose bank rec had run four days earlier.
      currentWithin120Days: !!(dated.length
        && dated[dated.length - 1] >= new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10)),
    };
  } catch (err) {
    out.bankReconciliations = { error: String(err && err.message ? err.message : err).slice(0, 160) };
  }

  const reconcileResource = out.resources.find(r => r.available && /reconcil|statement|cleared/i.test(r.name));
  const checkCleared = out.checks && out.checks.available && out.checks.clearedFields.length > 0;
  const rc = out.reconciliation || {};
  const br = out.bankReconciliations || {};
  out.verdict = rc.withBoth
    ? `Rent Manager already carries this: ${rc.withBoth} of ${rc.checksSampled} sampled checks have BOTH a check number and a ReconcileID, and the last bank reconciliation ran ${br.latest || 'never'}. Proof of payment does not need a bank feed — it needs this field read.`
    : (reconcileResource || checkCleared)
      ? 'The reconciliation FIELDS exist but no sampled check carries one — the schema supports it and the process is not filling it in. A bank feed would be answering a question Rent Manager could answer if the bank rec were done here.'
      : 'No reconciliation or cleared-status data is reachable through this API. Proving a check cleared needs the bank, not Rent Manager.';
  res.json(out);
});

app.get('/api/renovations/charge-sheet', async (req, res) => {
  noStore(res);
  const chargeId = String(req.query.id || '');
  if (!chargeId) return res.status(400).type('text/plain').send('Need ?id=<charge>.');

  const { cache } = renovationExpenses.status();
  if (!cache) return res.status(503).type('text/plain').send('No renovation snapshot yet.');
  const charge = (cache.data.charges || []).find(c => c.id === chargeId);
  if (!charge) return res.status(404).type('text/plain').send('That charge is not in the current snapshot.');

  let backup = null;
  try { backup = await rmDocuments.backupFor(charge); } catch (err) { /* the sheet stands without it */ }

  const esc = v => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const usd = n => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const row = (k, v) => (v == null || v === '' ? '' :
    `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`);

  const bill = backup && backup.bill;
  const atts = (backup && backup.attachments) || [];
  const why = (backup && backup.unavailable) || [];
  const ml = (backup && backup.manualLookup) || {};

  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>Charge summary — ${esc(charge.propertyName || '')} ${esc(charge.date || '')}</title>
<style>
 @page { size: letter; margin: 0.75in; }
 body { font: 13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:#26231d; margin:0; padding:32px; background:#fff; }
 .wrap { max-width: 760px; margin: 0 auto; }
 h1 { font-size: 20px; margin:0 0 2px; color:#14342A; letter-spacing:-.01em; }
 .sub { color:#7D766A; font-size:12px; margin-bottom:16px; }
 .banner { border:1px solid #E3CFA3; background:#FBF3E7; color:#6B4E16; border-radius:8px;
           padding:10px 12px; font-size:12.5px; margin:0 0 18px; }
 .banner b { color:#5a4111; }
 h2 { font-size:13px; margin:20px 0 6px; color:#3E3A33; }
 table { width:100%; border-collapse:collapse; font-size:12.5px; }
 th { text-align:left; font-weight:600; color:#7D766A; width:34%; padding:5px 10px 5px 0; vertical-align:top;
      border-bottom:1px solid #F0EDE5; font-variant:normal; }
 td { padding:5px 0; border-bottom:1px solid #F0EDE5; font-variant-numeric:tabular-nums; }
 .note { color:#7A4E0E; font-size:12px; margin:4px 0; }
 footer { margin-top:26px; padding-top:10px; border-top:1px solid #DED9CD; color:#9C9488; font-size:11px; }
 @media print { body { padding:0; } .noprint { display:none; } }
 .noprint button { font:inherit; padding:6px 12px; border:1px solid #C9C2B6; background:#fff;
                   border-radius:6px; cursor:pointer; }
</style></head><body><div class="wrap">
<div class="noprint" style="margin-bottom:14px;"><button onclick="window.print()">Print / Save as PDF</button></div>

<h1>Charge summary</h1>
<div class="sub">Generated by the Cedar Ridge Management management site · ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</div>

<div class="banner"><b>This is not an invoice.</b> It is a summary of what Rent Manager holds
about this charge, produced by this site${atts.length ? '' : ' because no vendor document is attached to it in Rent Manager'}.
It is not a vendor document and must not be filed as one.</div>

<h2>The charge</h2>
<table>
 ${row('Property', charge.propertyName)}
 ${row('Entity', charge.entity)}
 ${row('Unit', charge.unitName)}
 ${row('Date', charge.date)}
 ${row('GL account', `${charge.accountRef || ''}${charge.accountName ? ` · ${charge.accountName}` : ''}`)}
 ${row('Vendor', charge.vendor)}
 ${row('Description', charge.description)}
 ${row('Reference', charge.reference)}
 ${row('Transaction type', charge.txnType)}
 ${row('Amount', usd(charge.amount))}
</table>

${bill ? `<h2>The bill it belongs to</h2><table>
 ${row('Bill number', bill.number)}
 ${row('Bill date', bill.date)}
 ${row('Bill total', usd(bill.amount))}
 ${row('Matched on', bill.matchConfidence)}
</table>` : ''}

${atts.length ? `<h2>Documents in Rent Manager</h2><table>
 ${atts.map(a => row(a.name || 'Attachment', 'attached to the bill in Rent Manager')).join('')}
</table>` : ''}

${why.length ? `<h2>Why there is no document</h2>${why.map(w => `<div class="note">• ${esc(w)}</div>`).join('')}` : ''}

<h2>To find it by hand in Rent Manager</h2>
<table>
 ${row('Path', ml.where)}
 ${row('Property', ml.property)}
 ${row('Unit', ml.unit)}
 ${row('Date', ml.date)}
 ${row('GL account', ml.glAccount)}
 ${row('Vendor', ml.vendor)}
 ${row('Reference', ml.reference)}
 ${row('Amount', ml.amount != null ? usd(ml.amount) : null)}
</table>

<footer>Charge summary generated by the Cedar Ridge Management management site from Rent Manager data.
Not a vendor invoice. Charge id ${esc(chargeId)}.</footer>
</div></body></html>`);
});

app.get('/api/renovations/backup/file', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) {
    return res.status(400).json({ error: 'RM credentials not set.' });
  }
  const chargeId = String(req.query.id || '');
  const attachmentId = String(req.query.attachment || '');
  if (!chargeId || !attachmentId) {
    return res.status(400).json({ error: 'Need ?id=<charge>&attachment=<attachmentId>.' });
  }

  const { cache } = renovationExpenses.status();
  if (!cache) return res.status(503).json({ error: 'No renovation snapshot yet.' });
  const charge = (cache.data.charges || []).find(c => c.id === chargeId);
  if (!charge) return res.status(404).json({ error: 'That charge is not in the current snapshot.' });

  try {
    // backupFor is cached for five minutes, so the panel the user is looking at
    // and this check are reading the same answer.
    const backup = await rmDocuments.backupFor(charge);
    const meta = (backup.attachments || []).find(a => String(a.id) === attachmentId);
    if (!meta) return res.status(404).json({ error: 'That attachment is not on this charge.' });

    // Pass the attachment itself, not just its id: it carries the DownloadURL,
    // which is the only thing that returns bytes on this instance.
    const file = await rmDocuments.fetchAttachment(meta);
    if (!file) {
      return res.status(502).json({
        error: 'Rent Manager listed this attachment but would not serve the file through the API. Open it on the charge in Rent Manager.',
      });
    }
    const name = file.fileName || meta.name || `attachment-${attachmentId}`;
    res.setHeader('Content-Type', file.contentType || meta.contentType || 'application/octet-stream');
    // inline, not attachment: a PDF should open in a tab, which is what she'd do
    // in Rent Manager anyway. The browser still offers Save from there.
    res.setHeader('Content-Disposition', `inline; filename="${name.replace(/["\\]/g, '')}"`);
    return res.send(file.buffer);
  } catch (err) {
    return res.status(502).json({ error: `Rent Manager: ${publicErrorMessage(err)}` });
  }
});

// What this Rent Manager API actually exposes on the document side — the answer to
// the brief's first open item ("does the connected API expose the same
// document/attachment hierarchy she demoed in the classic UI?"), served so the tab
// can show it rather than leaving it in someone's notes. One cheap probe per
// resource, cached for six hours.
app.get('/api/renovations/capabilities', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) {
    return res.json({ configured: false, message: 'RM credentials not set.' });
  }
  try {
    res.json({ configured: true, ...(await rmDocuments.capabilities({ force: req.query.force === '1' })) });
  } catch (err) {
    res.status(502).json({ error: `Rent Manager: ${publicErrorMessage(err)}` });
  }
});

// ── "Why can't we pull the invoice PDFs?" ────────────────────────────────────
// The owner, 2026-08-26, on being handed a CLI: *"this thing you want me to run,
// where do I run it?"* The credentials live here, so the probe runs here and the
// tab has a button. See services/attachmentProbe.js for what it establishes and
// why the four HTTP statuses mean different things.
//
// Read-only — every request it makes is a GET. ~40 of them, so the answer is
// cached for half an hour and a second press joins the run already in flight;
// ?force=1 is the deliberate re-run after Rent Manager changes a permission.
app.get('/api/renovations/attachment-probe', async (req, res) => {
  noStore(res);
  if (!rentManager.isConfigured()) {
    return res.json({ configured: false, message: 'RM credentials not set on this server.' });
  }
  try {
    const out = await attachmentProbe.run({ force: req.query.force === '1' });
    // Which build answered. Twice now a result has been read as "the new code did
    // not work" when it was the old code answering — a deploy still in flight, or a
    // cached answer from before it. A stamp on the output ends that: if the build
    // shown is not the one that shipped the change, the result is not about the
    // change. The host sets RENDER_GIT_COMMIT; locally it falls back to the tree.
    res.json({
      configured: true,
      build: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'local',
      probeVersion: attachmentProbe.VERSION,
      ...out,
    });
  } catch (err) {
    res.status(502).json({ error: `Rent Manager: ${publicErrorMessage(err)}` });
  }
});

// % Collected per entity (Charged Detail analysis) — RM report 30 Grid2 summary,
// per entity per window, excluding TAX + LD charge types. ~65 report runs per
// rebuild, so it's fully cache-backed: serves the snapshot immediately and
// refreshes in the background when stale (202 = first build still running).
app.get('/api/delinquency/collections', async (req, res) => {
  if (!rentManager.isConfigured()) {
    return res.json({ configured: false, message: 'RM credentials not set.' });
  }
  const { cache, building, lastError } = chargedCollections.getStatus();
  if (!cache) return res.status(building ? 202 : 503).json({ configured: true, building, lastError });

  // The "Owed now" column is overlaid from the shared delinquency service at
  // response time rather than read out of this cache. The collections cache is
  // expensive (~65 report runs) so it can sit for days, while delinquency is one
  // cheap run — without this overlay the card would show a stale owed figure
  // that disagrees with the KPI tiles fed by /api/delinquency.
  let rmDelinquency = cache.rmDelinquency;
  try {
    const d = await delinquencyReport.getDelinquency();
    if (d && d.configured !== false) {
      rmDelinquency = {
        asOf: d.asOf,
        refreshedAt: d.refreshedAt,
        portfolio: { amount: d.totals.amount, tenants: d.totals.tenants },
        entities: Object.fromEntries(Object.entries(d.byEntity || {})
          .map(([e, v]) => [e, { amount: v.amount, tenants: v.tenants }])),
        note: "RM report 85 Delinquency — the same single run that feeds this tab's KPI tiles and tenant table, so every delinquency figure on the page agrees.",
      };
    }
  } catch (err) { /* keep whatever the snapshot had */ }

  return res.json({ ...cache, rmDelinquency, building });
});

// Billing-month cohorts — "of what we billed in June, how much had we collected
// by the end of June / July / August?" See services/billingCohorts.js.
app.get('/api/delinquency/cohorts', (req, res) => {
  if (!rentManager.isConfigured()) {
    return res.json({ configured: false, message: 'RM credentials not set.' });
  }
  const { cache, building, lastError } = billingCohorts.getStatus();
  if (cache) return res.json({ ...cache, building });
  return res.status(building ? 202 : 503).json({ configured: true, building, lastError });
});

// ── BUDGET ────────────────────────────────────────────────────────────────────
// The budget is a FROZEN SET, not a live query. It is built once by an explicit
// action (npm run budget:build, or POST /api/budget/rebuild) and everything after
// that is a file read out of data/budget/ — see services/budgetStore.js for why.
//
// Two properties this guarantees, both of which matter more than freshness right
// now: opening the tab costs ZERO Rent Manager calls, and the numbers on screen
// can never drift away from workbooks that have already been downloaded.

// Every entity's budget in one payload, straight off disk.
app.get('/api/budget', (req, res) => {
  const payload = budgetStore.loadSet();
  const manifest = budgetStore.loadManifest();
  const { building, progress, lastError } = budgetStore.status();
  if (!payload) {
    return res.status(building ? 202 : 503).json({
      configured: true,
      built: false,
      building,
      progress,
      lastError,
      message: building
        ? 'Building the budget set — retry shortly.'
        : 'No budget set has been built yet. Run "npm run budget:build" or use the Build button.',
    });
  }
  // The budget is frozen at build; its actuals are not. Every closed month the
  // live P&L now carries is laid beside the budget (budgetModel.overlayActuals).
  const live = propertyFinancials.loadSnapshot();
  const withActuals = live ? budgetModel.overlayActuals(payload, live) : payload;
  const m = live && manifest ? { ...manifest, actualsAsOfMonth: live.asOfMonth || manifest.actualsAsOfMonth, actualsRefreshedAt: live.refreshedAt || manifest.actualsRefreshedAt } : manifest;
  res.json({ configured: true, built: true, building, manifest: m, ...withActuals });
});

// What's on disk: when it was built, which workbooks exist, how big they are.
app.get('/api/budget/files', (req, res) => {
  const manifest = budgetStore.loadManifest();
  const { building, progress, lastError } = budgetStore.status();
  if (!manifest) return res.json({ built: false, building, progress, lastError, workbooks: [] });
  res.json({ built: true, building, progress, lastError, ...manifest });
});

// The assumptions layer on its own — static, no snapshot needed.
//
// Returns three things the Budget tab's editor needs: what the code believes
// (defaults + the per-entity overrides that live in budgetAssumptions.js), what
// has been edited on the site since, and the editable surface itself — the field
// list with its units and allowed band, so the panel is generated from the same
// definition the server validates against instead of a second copy that can
// drift out of step with it.
app.get('/api/budget/assumptions', (req, res) => {
  const overrides = budgetOverrides.load();
  res.json({
    ...budgetAssumptions.getConfig(),
    fields: budgetOverrides.RATE_FIELDS,
    benchmarkLines: budgetOverrides.benchmarkLines().map(l => ({
      key: l.key, label: l.label, section: l.section,
      benchmark: l.benchmark,
      effective: budgetOverrides.benchmarkFor(l, overrides),
      pinnable: budgetOverrides.pinnableLines().some(p => p.key === l.key),
    })),
    overrides,
    diff: budgetOverrides.diffFromDefaults(overrides),
  });
});

// ── Live what-if ─────────────────────────────────────────────────────────────
// Recompute one scope with UNSAVED assumptions and return it. Writes nothing:
// no set, no workbooks, no Rent Manager call — it is the same engine the build
// runs (budgetStore.computeSet), so a number previewed here is the number a
// rebuild will produce rather than an approximation of it.
app.post('/api/budget/preview', (req, res) => {
  const scope = String((req.body && req.body.scope) || 'Portfolio');
  try {
    const payload = budgetStore.preview((req.body && req.body.overrides) || {});
    const budget = scope === 'Portfolio' ? payload.portfolio : payload.entities[scope];
    if (!budget) return res.status(404).json({ error: `No budget for scope "${scope}".` });
    res.json({
      scope,
      budget,
      overrides: payload.overrides,
      benchmarks: payload.benchmarks,
      // Year-1 NOI for every entity, so the panel can show what an edit did to
      // the whole portfolio without shipping 13 full budgets on every keystroke.
      noiByEntity: Object.fromEntries(
        Object.entries(payload.entities).map(([n, b]) => [n, b.years[0] ? b.years[0].noi : null])),
    });
  } catch (err) {
    // A missing P&L snapshot is the one expected failure — it means this
    // environment has never pulled actuals, not that the request was wrong.
    const code = err && err.code === 'NO_SNAPSHOT' ? 409 : 500;
    res.status(code).json({ error: err.message, code: err.code || null });
  }
});

// Save the edited assumptions and rebuild the set behind them. This is the only
// path that moves the numbers everyone else sees, so it is deliberately separate
// from the preview above: editing is free, committing is an act.
app.put('/api/budget/overrides', (req, res) => {
  const who = req.accessUser || 'site';
  try {
    const saved = budgetOverrides.save(req.body || {}, who);
    budgetStore.startBuild().catch(() => {});
    res.json({ saved, diff: budgetOverrides.diffFromDefaults(saved), rebuilding: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Back to the code defaults, and rebuild so the set matches.
app.delete('/api/budget/overrides', (req, res) => {
  try {
    const cleared = budgetOverrides.clear();
    budgetStore.startBuild().catch(() => {});
    res.json({ saved: cleared, diff: budgetOverrides.diffFromDefaults(cleared), rebuilding: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Explicit rebuild. Reads the P&L snapshot PASSIVELY — it never triggers a Rent
// Manager pull of its own, so refreshing actuals stays a separate, deliberate act
// (the Variance tab's recompute). Returns immediately; the build runs in the
// background and takes a few seconds per workbook.
app.post('/api/budget/rebuild', (req, res) => {
  const already = budgetStore.status().building;
  budgetStore.startBuild().catch(() => {});
  res.json({ started: true, alreadyRunning: already });
});

// Serve a pre-built workbook. Nothing is generated here — if the file isn't on
// disk the answer is "build the set", not "spend a few seconds making one now",
// so a download can never quietly become a compute job.
app.get('/api/budget/:scope/excel', (req, res) => {
  const scope = String(req.params.scope);
  const file = budgetStore.workbookPath(scope);
  if (!file) {
    const manifest = budgetStore.loadManifest();
    return res.status(404).json({
      error: manifest
        ? `No workbook for '${scope}' in the current build.`
        : 'No budget set has been built yet — run "npm run budget:build" or use the Build button.',
      available: manifest ? manifest.scopes : [],
    });
  }
  res.download(file, path.basename(file));
});

// ── UNIVERSAL REFRESH ─────────────────────────────────────────────────────────
// One button, one endpoint, everything the site reads from Rent Manager.
//
// The site has six independent caches, each of which used to decide on its own
// when to go back to RM. That's how the P&L ended up re-pulling 48 times a day:
// nobody was looking at the total. This puts the decision in one place and in the
// user's hands — press it and everything refreshes together, so "when was this
// data last pulled" has a single answer instead of six.
//
// Deliberately NOT included: the budget set. It's a frozen deliverable right now,
// not a live view, and rebuilding it is its own explicit action on the Budget tab
// (POST /api/budget/rebuild). Refreshing data must not silently move numbers that
// have already been reviewed and emailed out.
// `global` marks a source as part of the one big button on Overview. The two
// left out are the ones with their own tools and their own tab buttons:
// % Collected (~78 report runs — over half the portfolio's total cost, and the
// Delinquency tab is where you'd actually want it fresh) and work orders (the
// Issues tab polls those live on its own, so sweeping them here is redundant).
// Pulling those two out roughly halves what the global button costs.
//
// `tabs` drives the per-tab refresh buttons. Note the overlap is real, not a
// modelling accident: Monthly P&L is one cache that Overview, Entities and
// Variances all read, so refreshing it from any of them updates all three. The
// buttons say so rather than pretending the tabs are independent.
const REFRESH_SOURCES = [
  {
    key: 'liveOverview', label: 'Portfolio overview',
    cost: '~2 report runs + unit/tenant sweeps',
    global: true, tabs: ['overview', 'entities'],
    run: () => refreshLiveOverviewCache(),
    refreshedAt: () => (liveOverviewCache && liveOverviewCache.refreshedAt) || null,
  },
  {
    key: 'tenantIndex', label: 'Tenants & leases',
    cost: 'property/unit/lease sweeps',
    global: true, tabs: ['overview', 'delinquency'],
    run: () => { tenantIndexCache = null; return getTenantIndex(); },
    refreshedAt: () => (tenantIndexCache && new Date(tenantIndexCache.refreshedAt).toISOString()) || null,
  },
  {
    key: 'propertyPL', label: 'Monthly P&L',
    cost: '~89 report runs — the expensive one',
    global: true, tabs: ['overview', 'entities', 'variances'],
    run: () => propertyFinancials.startBuild(),
    refreshedAt: () => { const c = propertyFinancials.loadSnapshot(); return c ? c.refreshedAt : null; },
  },
  {
    key: 'delinquency', label: 'Delinquency (RM report 85)',
    cost: '1 report run (~13s)',
    global: true, tabs: ['overview', 'delinquency'],
    run: () => delinquencyReport.refresh(),
    refreshedAt: () => { const s = delinquencyReport.getStatus(); return s.cache ? s.cache.refreshedAt : null; },
  },
  {
    key: 'cohorts', label: 'Collections by billing month',
    cost: '24 report runs (~30s)',
    global: true, tabs: ['overview', 'delinquency'],
    run: () => billingCohorts.refresh(),
    refreshedAt: () => { const s = billingCohorts.getStatus(); return s.cache ? s.cache.refreshedAt : null; },
  },
  {
    // The rolling 30/60/90-day windows this builds are no longer shown anywhere —
    // the Delinquency tab and the Overview health line both read `cohorts` now.
    // Kept because /api/delinquency/collections is still a working endpoint, but
    // deliberately off every tab so the Delinquency refresh button doesn't spend
    // 65 report runs rebuilding something nobody looks at.
    key: 'collections', label: '% Collected — rolling windows (legacy)',
    cost: '~65 report runs',
    global: false, tabs: [],
    run: () => chargedCollections.refresh(),
    refreshedAt: () => { const s = chargedCollections.getStatus(); return s.cache ? s.cache.refreshedAt : null; },
  },
  {
    key: 'moveActivity', label: 'Move-ins / move-outs',
    cost: 'lease sweeps',
    global: true, tabs: ['entities', 'variances'],
    run: () => moveActivity.refresh(),
    refreshedAt: () => { const s = moveActivity.getStatus(); return s.cache ? s.cache.refreshedAt : null; },
  },
  {
    key: 'issues', label: 'Work orders (Issues)',
    cost: 'service-issue sweep + open backlog',
    global: false, tabs: ['issues'],
    // The dashboard's backlog pull rides the same button (2026-10-21): one press
    // means "what's current", and the list and the home screen must not
    // disagree about which tickets are still open. Sequential, not parallel —
    // the RM session cap.
    run: () => issuesFeed.refresh({ force: true }).then(() => issuesBacklog.refresh({ force: true })),
    refreshedAt: () => issuesFeed.status().refreshedAt,
  },
  {
    key: 'debtService', label: 'Debt service',
    cost: 'chart of accounts + Report 51 on the mortgage loans',
    global: true, tabs: ['overview'],
    run: () => debtServiceCache.refresh({ force: true }),
    refreshedAt: () => debtServiceCache.status().refreshedAt,
  },
  {
    key: 'unitCounts', label: 'Unit counts',
    cost: 'one /Units sweep',
    global: true, tabs: ['overview', 'entities'],
    run: () => unitCounts.startBuild(),
    refreshedAt: () => { const c = unitCounts.loadSnapshot(); return c ? c.refreshedAt : null; },
  },
  {
    // Not in the global set: it is only read by its own tab, and the pull is one
    // report run per property that actually booked renovation spend — cheap when
    // renovations are concentrated, wasteful to fire on every global refresh.
    // It reads the Monthly P&L snapshot to know which properties those are, so
    // refreshing it right after propertyPL gives the most accurate shortlist.
    key: 'renovations', label: 'Renovation (non-operating) charges',
    cost: 'one GL report run per property with renovation spend',
    global: false, tabs: ['renovations'],
    run: () => renovationExpenses.refresh({ force: true }),
    refreshedAt: () => renovationExpenses.status().refreshedAt,
  },
  {
    // One GL report run over the portfolio's utility and repair lines for the
    // last six months — the Variance tab's duplicate-payment check.
    key: 'duplicatePayments', label: 'Duplicate payments',
    cost: '1 GL report run (portfolio, 6 months)',
    global: false, tabs: ['variances'],
    run: () => duplicatePayments.refresh({ force: true }),
    refreshedAt: () => duplicatePayments.status().refreshedAt,
  },
  {
    key: 'supers', label: 'Property supers (auto-assign map)',
    cost: 'one /Properties sweep',
    global: false, tabs: ['issues'],
    run: () => supersSnapshot.refresh({ force: true }),
    refreshedAt: () => supersSnapshot.status().refreshedAt,
  },
];

const GLOBAL_REFRESH_KEYS = REFRESH_SOURCES.filter(s => s.global).map(s => s.key);

let _refreshRun = null; // { startedAt, sources: { key: {state, error, finishedAt} } }

function refreshStatus() {
  const inRun = key => Boolean(_refreshRun && _refreshRun.keys.includes(key));
  const sources = REFRESH_SOURCES.map(s => ({
    key: s.key,
    label: s.label,
    cost: s.cost,
    global: Boolean(s.global),
    tabs: s.tabs || [],
    refreshedAt: (() => { try { return s.refreshedAt(); } catch { return null; } })(),
    // Sources outside the current run stay 'idle' — a per-tab refresh of one cache
    // must not make the other seven look like they're queued behind it.
    state: inRun(s.key) ? ((_refreshRun.sources[s.key] || {}).state || 'pending') : 'idle',
    error: inRun(s.key) ? ((_refreshRun.sources[s.key] || {}).error || null) : null,
  }));
  const running = Boolean(_refreshRun && sources.some(s => s.state === 'running' || s.state === 'pending'));
  const oldestOf = list => list.reduce((oldest, s) => {
    if (!s.refreshedAt) return oldest;
    return (!oldest || s.refreshedAt < oldest) ? s.refreshedAt : oldest;
  }, null);
  return {
    running,
    startedAt: _refreshRun ? _refreshRun.startedAt : null,
    reason: _refreshRun ? _refreshRun.reason : null,
    runningKeys: _refreshRun ? _refreshRun.keys : [],
    sources,
    nextScheduledAt: nextWeeklyRefreshISO(),
    // The oldest source is the honest "how current is this site" figure — a single
    // fresh cache doesn't make the picture fresh. Scoped to the global set, since
    // that's what the big button actually refreshes.
    oldestRefreshedAt: oldestOf(sources.filter(s => s.global)),
    oldestAnyRefreshedAt: oldestOf(sources),
  };
}

// Run a named subset of sources, sequentially. Shared by the global button, the
// per-tab buttons and the weekly schedule so there is exactly one code path that
// talks to Rent Manager — the thing that stopped six caches each inventing their
// own refresh policy.
function startRefresh(keys, reason) {
  const valid = REFRESH_SOURCES.filter(s => keys.includes(s.key));
  if (!valid.length) return null;
  _refreshRun = {
    startedAt: new Date().toISOString(),
    reason,
    keys: valid.map(s => s.key),
    sources: {},
  };
  valid.forEach(s => { _refreshRun.sources[s.key] = { state: 'pending' }; });

  (async () => {
    // Entity membership first, and not as one of the sources: every source below
    // attributes its rows through this map, so refreshing it afterwards would
    // rebuild the whole portfolio against the membership it is replacing. It is
    // two cached requests and it never fails the run — a stale map is a bad day,
    // an abandoned refresh is a worse one.
    await refreshPropertyEntityNames(reason);

    for (const s of valid) {
      _refreshRun.sources[s.key] = { state: 'running' };
      try {
        await s.run();
        _refreshRun.sources[s.key] = { state: 'done', finishedAt: new Date().toISOString() };
      } catch (err) {
        // One source failing must not abandon the rest — a refresh-all that gives
        // up halfway is worse than one that reports what it couldn't do.
        _refreshRun.sources[s.key] = { state: 'failed', error: publicErrorMessage(err) };
        console.warn(`Refresh (${reason}): ${s.key} failed — ${err.message}`);
      }
    }
    console.log(`Refresh (${reason}) finished: ${valid.map(s => s.key).join(', ')}`);
  })();

  return _refreshRun;
}

app.get('/api/refresh/status', (req, res) => {
  if (!rentManager.isConfigured()) return res.json({ configured: false, running: false, sources: [] });
  res.json({ configured: true, ...refreshStatus() });
});

// Kick a refresh off. Returns immediately; poll /api/refresh/status for progress.
// Sources run sequentially rather than all at once: RM caps concurrent sessions,
// and a refresh-all that trips that cap would fail half its own sources.
//
// Body is optional:
//   {}                        → the global set (the big button on Overview)
//   { keys: ['propertyPL'] }  → just those sources (a per-tab button)
//   { tab: 'delinquency' }    → every source that tab reads
//   { all: true }             → everything, including the two the global set omits
app.post('/api/refresh', (req, res) => {
  if (!rentManager.isConfigured()) {
    return res.status(400).json({ error: 'Rent Manager credentials are not set.' });
  }
  if (_refreshRun && refreshStatus().running) {
    return res.json({ started: false, alreadyRunning: true, ...refreshStatus() });
  }

  const body = req.body || {};
  let keys;
  let reason;
  if (Array.isArray(body.keys) && body.keys.length) {
    keys = REFRESH_SOURCES.filter(s => body.keys.includes(s.key)).map(s => s.key);
    reason = 'manual · ' + keys.join(', ');
  } else if (body.tab) {
    keys = REFRESH_SOURCES.filter(s => (s.tabs || []).includes(body.tab)).map(s => s.key);
    reason = `manual · ${body.tab} tab`;
  } else if (body.all) {
    keys = REFRESH_SOURCES.map(s => s.key);
    reason = 'manual · everything';
  } else {
    keys = GLOBAL_REFRESH_KEYS;
    reason = 'manual · global';
  }

  if (!keys.length) {
    return res.status(400).json({ error: 'No matching refresh sources.' });
  }

  startRefresh(keys, reason);
  res.json({ started: true, ...refreshStatus() });
});

// ── Weekly schedule ───────────────────────────────────────────────────────────
// One scheduled pull a week — Monday 4am ET — so the site is already rebuilt
// before anyone opens it Monday morning. It fires the SAME startRefresh() the
// button does, which is the point: a clock triggering the one central path is
// not the thing we removed. What we removed was six caches each deciding on
// their own to go back to Rent Manager, which is how this site reached ~4,600
// report runs a day. This is ~89 a week.
const SCHEDULE_TZ    = process.env.REFRESH_SCHEDULE_TZ   || 'America/New_York';
const SCHEDULE_DOW   = process.env.REFRESH_SCHEDULE_DAY  || 'Mon';
const SCHEDULE_HOUR  = Number(process.env.REFRESH_SCHEDULE_HOUR ?? 4);
const SCHEDULE_STATE_FILE = path.join(__dirname, 'data', 'refresh-schedule.json');
// Checking the clock costs nothing (no RM calls), so a coarse tick is fine — it
// only decides whether the weekly window has been crossed.
const SCHEDULE_TICK_MS = Number(process.env.REFRESH_SCHEDULE_TICK_MS || 15 * 60 * 1000);

// Minutes that the scheduling timezone is offset from UTC at a given instant.
// Derived from Intl rather than hardcoded so DST doesn't shift the run by an hour.
function tzOffsetMinutes(epoch) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(epoch).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const hour = parts.hour === '24' ? 0 : Number(parts.hour); // Intl can emit hour 24
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second);
  return (asUTC - epoch) / 60000;
}

// Epoch ms for a wall-clock time in SCHEDULE_TZ. Two passes settle the DST edge
// where the offset at the guess differs from the offset at the answer.
function tzWallClockToEpoch(y, m, d, h) {
  const naive = Date.UTC(y, m - 1, d, h, 0, 0);
  let epoch = naive;
  for (let i = 0; i < 3; i++) {
    const next = naive - tzOffsetMinutes(epoch) * 60000;
    if (next === epoch) break;
    epoch = next;
  }
  return epoch;
}

function tzDateParts(epoch) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TZ, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(epoch).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
}

// The most recent scheduled moment that has already passed.
function lastScheduledRefreshEpoch(now = Date.now()) {
  for (let back = 0; back <= 8; back++) {
    const probe = now - back * 86400000;
    const p = tzDateParts(probe);
    if (p.weekday !== SCHEDULE_DOW) continue;
    const epoch = tzWallClockToEpoch(+p.year, +p.month, +p.day, SCHEDULE_HOUR);
    if (epoch <= now) return epoch;
  }
  return null;
}

function nextWeeklyRefreshISO(now = Date.now()) {
  for (let ahead = 0; ahead <= 8; ahead++) {
    const probe = now + ahead * 86400000;
    const p = tzDateParts(probe);
    if (p.weekday !== SCHEDULE_DOW) continue;
    const epoch = tzWallClockToEpoch(+p.year, +p.month, +p.day, SCHEDULE_HOUR);
    if (epoch > now) return new Date(epoch).toISOString();
  }
  return null;
}

function loadScheduleState() {
  try { return JSON.parse(fs.readFileSync(SCHEDULE_STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveScheduleState(state) {
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_STATE_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULE_STATE_FILE, JSON.stringify(state));
  } catch (err) {
    console.warn('Could not persist refresh schedule state:', err.message);
  }
}

// Comparing against the last scheduled moment (rather than "has a week elapsed")
// is what makes this self-healing: if the instance was suspended through Monday
// 4am and comes back Tuesday, the window is still unserved, so it runs on boot.
// That matters here — the host has suspended this service before.
function weeklyScheduleTick(reason) {
  if (!rentManager.isConfigured()) return;
  if (_refreshRun && refreshStatus().running) return;
  const due = lastScheduledRefreshEpoch();
  if (!due) return;
  const state = loadScheduleState();
  const lastRunAt = Number(state.lastRunAt || 0);
  if (lastRunAt >= due) return;
  console.log(`Weekly refresh due (${new Date(due).toISOString()}) — starting [${reason}]`);
  saveScheduleState({ ...state, lastRunAt: Date.now(), lastDueAt: due });
  startRefresh(GLOBAL_REFRESH_KEYS, 'weekly schedule');
}

// ── Daily P&L refresh ─────────────────────────────────────────────────────────
// 2026-08-15 (the owner: "they all need to match"). The weekly cadence above is
// right for most sources, but not for the monthly P&L behind the Variance tab.
//
// That tab is reconciled line by line against P&L exports pulled from Rent
// Manager that morning, so any drift between the snapshot and RM reads as a bug
// in the tab. And the books genuinely move after month-end: a sweep on 2026-08-15
// against a 69-hour-old snapshot found mortgage interest for June AND July posted
// on ~31 Cedar Ridge properties in the days after it was taken
// (scripts/compareDashboardToRM.js). At a weekly cadence that window is up to
// seven days wide, which is far too much for a tab whose whole job is spotting a
// number that looks off.
//
// So the P&L alone runs daily. It fires the same central startRefresh() the
// button and the weekly schedule use — a clock triggering the one shared path is
// not the thing that was removed here. Cost is ~196 report runs a day, against
// the ~4,600 a day that the old every-cache-polls-on-every-page-hit design was
// reaching. Set REFRESH_DAILY_KEYS='' to turn it off.
const DAILY_REFRESH_KEYS = (process.env.REFRESH_DAILY_KEYS ?? 'propertyPL')
  .split(',').map(s => s.trim()).filter(Boolean);
const DAILY_SCHEDULE_HOUR = Number(process.env.REFRESH_DAILY_HOUR ?? 5);

function lastDailyRefreshEpoch(now = Date.now()) {
  for (let back = 0; back <= 2; back++) {
    const p = tzDateParts(now - back * 86400000);
    const epoch = tzWallClockToEpoch(+p.year, +p.month, +p.day, DAILY_SCHEDULE_HOUR);
    if (epoch <= now) return epoch;
  }
  return null;
}

function nextDailyRefreshISO(now = Date.now()) {
  for (let ahead = 0; ahead <= 2; ahead++) {
    const p = tzDateParts(now + ahead * 86400000);
    const epoch = tzWallClockToEpoch(+p.year, +p.month, +p.day, DAILY_SCHEDULE_HOUR);
    if (epoch > now) return new Date(epoch).toISOString();
  }
  return null;
}

// Same self-healing shape as the weekly tick: it compares against the last
// scheduled MOMENT, not "has 24h elapsed", so an instance that was suspended
// through 5am runs as soon as it comes back rather than skipping the day.
function dailyScheduleTick(reason) {
  if (!rentManager.isConfigured()) return;
  if (!DAILY_REFRESH_KEYS.length) return;
  if (_refreshRun && refreshStatus().running) return;
  const due = lastDailyRefreshEpoch();
  if (!due) return;
  const state = loadScheduleState();
  if (Number(state.lastDailyRunAt || 0) >= due) return;
  console.log(`Daily P&L refresh due (${new Date(due).toISOString()}) — starting [${reason}]`);
  saveScheduleState({ ...state, lastDailyRunAt: Date.now(), lastDailyDueAt: due });
  startRefresh(DAILY_REFRESH_KEYS, 'daily schedule · P&L');
}

// ── Cache warming ─────────────────────────────────────────────────────────────
// Warming only ever fills in what is MISSING. A cache that already has data is
// left exactly as it is until the button or the weekly schedule refreshes it —
// that's what makes "the site shows the last pull" true on a page load as well
// as on a tab switch. A fresh install must still not serve an empty site.
function warmCaches(reason) {
  if (!rentManager.isConfigured()) return;
  console.log(`Warming caches (${reason})…`);
  if (!tenantIndexCache) {
    getTenantIndex().catch(err => console.warn('Cache warm (tenant index) failed:', publicErrorMessage(err)));
  }
  if (!loadLiveOverviewSnapshot()) {
    refreshLiveOverviewCache().catch(err => console.warn('Cache warm (live overview) failed:', publicErrorMessage(err)));
  }
  // Both no-op once a snapshot exists; they only backfill a missing one.
  propertyFinancials.getStatus();
  chargedCollections.getStatus();
}

// ── stay up ─────────────────────────────────────────────────────────────────
// Node terminates the process on an unhandled promise rejection, and this app had
// no guard — so one stray rejection anywhere took the WHOLE site down, and every
// request in flight got the host's HTML error page. The owner hit exactly that error
// mid-demo ("Unexpected token '<'"), and an attachment probe reproduced it: one
// bad route, site down, everybody logged out.
//
// A failed request should fail. It should not take the other requests with it.
// These handlers log and keep serving; nothing is swallowed silently.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] request failed but the server stays up:',
    reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] request failed but the server stays up:',
    err && err.stack ? err.stack : err);
});

// Startup chores shared by `node server.js` and scripts/demoServer.js.
function onListening() {
  console.log(`Cedar Ridge management backend running on http://localhost:${PORT}`);
  console.log(`Rent Manager mode: ${DEMO_MODE ? 'DEMO (fictional data, no network)' : rentManager.isConfigured() ? 'LIVE (credentials found)' : 'MOCK (no .env credentials yet)'}`);
  console.log(`Weekly refresh: ${SCHEDULE_DOW} ${SCHEDULE_HOUR}:00 ${SCHEDULE_TZ} · next ${nextWeeklyRefreshISO()}`);
  console.log(DAILY_REFRESH_KEYS.length
    ? `Daily refresh: ${DAILY_REFRESH_KEYS.join(', ')} at ${DAILY_SCHEDULE_HOUR}:00 ${SCHEDULE_TZ} · next ${nextDailyRefreshISO()}`
    : 'Daily refresh: disabled (REFRESH_DAILY_KEYS empty)');
  refreshPropertyEntityNames('startup');
  marketNews.start();   // public data: runs with or without Rent Manager credentials
  warmCaches('startup');
  if (DEMO_MODE) require('./services/demo/warm').warm().catch(e => console.warn('demo warm-up:', e.message));   // renovations + budget set
  weeklyScheduleTick('startup catch-up');
  dailyScheduleTick('startup catch-up');
  setInterval(() => weeklyScheduleTick('tick'), SCHEDULE_TICK_MS);
  setInterval(() => dailyScheduleTick('tick'), SCHEDULE_TICK_MS);
  // every deal on the disk should have its PDF report: a minute after boot, build any that are missing (a deploy
  // that changes the report layout re-issues them too). Idempotent, one deal at a time, never blocks a request.
  setTimeout(() => uwRunReportBackfill().catch(e => console.error('report backfill:', e.message)), 60000);
}
app.onDemoListening = onListening;

if (require.main === module) {
  app.listen(PORT, onListening);
}

module.exports = app;
// Exposed for scripts/verifyIssuesFeed.js — the Issues feed's property/entity
// resolution is worth checking against live RM without going through HTTP.
module.exports.loadRecentServiceIssues = loadRecentServiceIssues;
