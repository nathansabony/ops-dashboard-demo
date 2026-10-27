#!/usr/bin/env node
// Proves per-person sign-in and tool access (2026-10-07), without Rent Manager.
//
//   1. services/userStore.js — hashing, sign-in, the last-admin rule, sign-out on
//      reset / turn-off.
//   2. services/accessControl.js — the route → tool map: every route server.js
//      declares is covered on purpose, and the decisions are the right ones.
//   3. End to end — starts server.js on a spare port with Rent Manager switched OFF
//      (blank credentials: zero RM calls) and a throwaway user file, then walks the
//      real flows over HTTP: PIN setup → first admin → PIN retired → a Variances-
//      only person is refused Budget data → password change → reset signs out.
//
//   node scripts/checkAccessControl.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op-auth-'));
process.env.DEMO_MODE = '';
process.env.USERS_FILE = path.join(tmp, 'users.json');
const store = require('../services/userStore');
const ac = require('../services/accessControl');

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
}
const throws = (fn, code) => { try { fn(); return false; } catch (e) { return !code || e.code === code; } };

// ── 1. the store ─────────────────────────────────────────────────────────────
console.log('\nUser store');
{
  const h = store.hashPassword('correct horse battery');
  check('passwords are stored as salted scrypt hashes, never in clear', /^scrypt\$/.test(h) && !h.includes('correct horse'));
  check('...and two hashes of the same password differ (salted)', h !== store.hashPassword('correct horse battery'));
  check('verify accepts the right password and rejects a wrong one',
    store.verifyPassword('correct horse battery', h) && !store.verifyPassword('correct horse batterx', h));
  check('a short password is refused', throws(() => store.createUser({ email: 'a@x.com', password: 'short' })));
  check('a password needs at least one number', throws(() => store.createUser({ email: 'a@x.com', password: 'no-numbers-here' })));
  check('...and at least 5 characters, even with a number', throws(() => store.createUser({ email: 'a@x.com', password: 'ab12' })));
  check('5 characters with a number is enough', !!store.createUser({ email: 'ok5@x.com', password: 'abc12' }) && !!store.authenticate('ok5@x.com', 'abc12'));
  const admin = store.createUser({ email: 'Boss@Example.com', name: 'Boss', password: 'boss-password-1', admin: true });
  check('emails are stored lower-case and the hash never leaves the store',
    admin.email === 'boss@example.com' && !('passwordHash' in admin) && admin.tools.length === store.TOOL_KEYS.length);
  check('a duplicate email is refused', throws(() => store.createUser({ email: 'boss@example.com', password: 'another-pass-1' }), 'EXISTS'));
  const v = store.createUser({ email: 'var@example.com', password: 'variance-only-1', tools: ['variances', 'not-a-tool'] });
  check('unknown tools are dropped, and Home is on for everyone', JSON.stringify(v.tools) === '["overview","variances"]');
  check('sign-in works case-insensitively on the email', !!store.authenticate('VAR@example.com', 'variance-only-1'));
  check('...and fails on a wrong password', !store.authenticate('var@example.com', 'nope-nope-nope'));
  check('the only admin cannot be demoted', throws(() => store.updateUser(admin.id, { admin: false }), 'LAST_ADMIN'));
  check('...turned off', throws(() => store.updateUser(admin.id, { disabled: true }), 'LAST_ADMIN'));
  check('...or deleted', throws(() => store.deleteUser(admin.id), 'LAST_ADMIN'));
  const sv0 = store.getById(v.id).sv;
  store.setPassword(v.id, 'variance-new-pass-7');
  check('a password reset ends every session (session version bumps) and never forces a change',
    store.getById(v.id).sv === sv0 + 1 && !('mustChangePassword' in store.getById(v.id)));
  {
    // An account saved by the first accounts build still carries mustChangePassword: true.
    const raw = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
    raw.users.find(x => x.id === v.id).mustChangePassword = true;
    fs.writeFileSync(process.env.USERS_FILE, JSON.stringify(raw));
    const old = store.getById(v.id);
    check('an old saved "must change password" flag is ignored — no forced pop-up, full access to their tools',
      !('mustChangePassword' in store.publicUser(old)) && require('../services/accessControl').decide(store.publicUser(old), 'GET', '/api/variance/config').ok);
    store.setPassword(v.id, 'variance-new-pass-7');
  }
  {
    // Scanner split (2026-10-22): an account saved with Underwriting keeps Scanner once.
    const raw = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
    const old = raw.users.find(x => x.id === v.id);
    old.tools = ['underwriting']; delete old.scannerSplit;
    fs.writeFileSync(process.env.USERS_FILE, JSON.stringify(raw));
    check('an account that had Underwriting is given Scanner too', JSON.stringify(store.publicUser(store.getById(v.id)).tools) === '["overview","underwriting","scanner"]');
    store.updateUser(v.id, { tools: ['underwriting'] });
    check('...and an admin who then takes Scanner away is not overruled on the next load', !store.getById(v.id).tools.includes('scanner'));
    store.updateUser(v.id, { tools: ['variances'] });
  }
  store.updateUser(v.id, { disabled: true });
  check('a turned-off account cannot sign in', !store.authenticate('var@example.com', 'variance-new-pass-7'));
  store.updateUser(v.id, { disabled: false });
  const su = store.signUp({ name: 'Self', email: 'self@example.com', password: 'self-signup-pw-7' }, ['example.com']);
  check('a self sign-up is never an admin, has no tools, and keeps the password they chose (no forced change)',
    !su.admin && su.tools.length === 0 && !su.tools.includes('overview') && !!store.authenticate('self@example.com', 'self-signup-pw-7'));
  check('SIGNUP_ALLOWED_DOMAINS limits sign-ups to work addresses', throws(() => store.signUp({ name: 'X', email: 'x@gmail.com', password: 'whatever-12345' }, ['example.com'])));
  check('a sign-up needs a name', throws(() => store.signUp({ name: ' ', email: 'y@example.com', password: 'whatever-12345' })));
}

console.log('\nMailer');
{
  const saved = { ...process.env };
  for (const k of ['MAIL_TRANSPORT', 'MAIL_DIR', 'MS_GRAPH_TENANT_ID', 'SMTP_HOST', 'MAIL_FROM', 'DASHBOARD_PUBLIC_URL']) delete process.env[k];
  const mailer = require('../services/mailer');
  check('with nothing set up, email is off (and says what to set)', !mailer.configured() && /not set up/.test(mailer.describe()));
  process.env.SMTP_HOST = 'smtp.example.com'; process.env.MAIL_FROM = 'noreply@example.com';
  check('a mail provider without the site address is still off (links need a fixed address)', !mailer.configured() && /DASHBOARD_PUBLIC_URL/.test(mailer.describe()));
  process.env.DASHBOARD_PUBLIC_URL = 'https://site.example/';
  check('provider + site address = on', mailer.configured() && mailer.baseUrl() === 'https://site.example');
  const e = mailer.linkEmail({ kind: 'reset', name: 'A <b>', link: 'https://site.example/reset?token=x', hours: 1 });
  check('the email escapes names and carries the link as text too', !/<b>/.test(e.html.replace(/<\/?(div|p|a|br)[^>]*>/g, '')) && e.text.includes('https://site.example/reset?token=x'));
  Object.keys(process.env).forEach(k => { if (!(k in saved)) delete process.env[k]; });
  Object.assign(process.env, saved);
}

// ── 2. the route map ─────────────────────────────────────────────────────────
console.log('\nRoute → tool map');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routes = [...src.matchAll(/app\.(get|post|put|delete|patch)\(\s*'(\/api\/[^']+)'/g)].map(m => m[2].replace(/\/:[^/]+.*$/, '/x'));
  const uncovered = [...new Set(routes)].filter(r => !ac.ruleFor(r));
  check(`every /api route in server.js has a rule (${new Set(routes).size} routes)`, uncovered.length === 0, uncovered.join(', '));
  const vOnly = { admin: false, tools: ['variances'] };
  const d = (u, p, m = 'GET') => ac.decide(u, m, p);
  check('signed out: the page asks for a sign-in, data is refused', d(null, '/api/budget').status === 401 && d(null, '/api/auth/login', 'POST').ok);
  check('a Variances-only person gets variance data and the P&L feed', d(vOnly, '/api/variance/config').ok && d(vOnly, '/api/financials/property-monthly').ok);
  check('the first-seen store (still open since) is Variances data: a Variances person may post, a Budget-only person may not',
    d(vOnly, '/api/variance/first-seen', 'POST').ok && d({ admin: false, tools: ['budget'] }, '/api/variance/first-seen', 'POST').status === 403);
  // The investigation reads General Ledger postings and bills from Rent Manager and costs API calls, so it is
  // Variances-only and signed-in-only: a Budget-only person, a signed-out request and the Overview tool are all refused.
  check('the Rent Manager investigation behind a flag is Variances-only: a Variances person gets it; signed out, Budget-only and Overview-only do not',
    d(vOnly, '/api/variance/investigate').ok && d(null, '/api/variance/investigate').status === 401
      && d({ admin: false, tools: ['budget'] }, '/api/variance/investigate').status === 403
      && d({ admin: false, tools: ['overview'] }, '/api/variance/investigate').status === 403
      && ac.ruleFor('/api/variance/investigate').p === '/api/variance/investigate');
  check('...but not Budget, Renovations, Deal Tools, tenants or delinquency',
    ['/api/budget', '/api/renovations', '/api/underwriting/models', '/api/tenants/search', '/api/delinquency'].every(p => d(vOnly, p).status === 403));
  check('...nor the Admin API or a probe', d(vOnly, '/api/admin/users').code === 'ADMIN_ONLY' && d(vOnly, '/api/rm-check').code === 'ADMIN_ONLY');
  check('a route nobody listed is admin-only (deny by default)', d(vOnly, '/api/something-new').code === 'ADMIN_ONLY');
  check('an admin gets everything', d({ admin: true }, '/api/budget').ok && d({ admin: true }, '/api/admin/users').ok);
  check('there is no forced password change: a leftover flag never blocks anyone',
    d({ admin: true, mustChangePassword: true }, '/api/budget').ok);
  check('the page itself is always served to a signed-in person (data is what is guarded)', d(vOnly, '/').ok);
  // Home is for everyone (2026-10-22): it reads only the snapshot and public news.
  const homeOnly = { admin: false, tools: ['overview'] };
  check('a Home-only person reads the Home snapshot and market news',
    d(homeOnly, '/api/home-snapshot').ok && d(homeOnly, '/api/market-news').ok);
  check('...but not one raw feed Home used to share with Portfolio',
    ['/api/financials/property-monthly', '/api/live-overview', '/api/entities', '/api/debt-service', '/api/delinquency/cohorts', '/api/tenants/search', '/api/budget', '/api/issues', '/api/scorecard/targets', '/api/refresh'].every(p => d(homeOnly, p).status === 403));
  check('...and cannot post to the Home snapshot', d(homeOnly, '/api/home-snapshot', 'POST').status === 403);
  check('a Portfolio person may post to it', d({ admin: false, tools: ['overview', 'entities'] }, '/api/home-snapshot', 'POST').ok);
  check('Scanner is its own permission: Underwriting alone does not open /api/analyze-contract',
    d({ admin: false, tools: ['underwriting'] }, '/api/analyze-contract', 'POST').status === 403 && d({ admin: false, tools: ['scanner'] }, '/api/analyze-contract', 'POST').ok
    && d({ admin: false, tools: ['scanner'] }, '/api/underwriting/models').status === 403);
}

// ── 3. end to end over HTTP ──────────────────────────────────────────────────
async function e2e() {
  console.log('\nEnd to end (server.js, Rent Manager OFF)');
  const usersFile = path.join(tmp, 'e2e-users.json');
  const port = 5700 + Math.floor(Math.random() * 200);
  const mailDir = path.join(tmp, 'mail');
  const env = { ...process.env, DEMO_MODE: '', PORT: String(port), USERS_FILE: usersFile, DASHBOARD_ACCESS_PIN: 'setup-pin-123',
    MAIL_TRANSPORT: 'file', MAIL_DIR: mailDir, DASHBOARD_PUBLIC_URL: 'https://site.example', MS_GRAPH_TENANT_ID: '', SMTP_HOST: '',
    DASHBOARD_SESSION_SECRET: 'test-secret', RENTMANAGER_USERNAME: '', RENTMANAGER_PASSWORD: '', RENTMANAGER_COMPANY: '',
    CF_ACCESS_TEAM_DOMAIN: '', CF_ACCESS_AUD: '', PL_AUTO_REFRESH_MS: '0', NODE_ENV: 'test' };
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/auth/status'); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
  const jar = () => ({ c: '' });
  const call = async (j, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: j.c }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) j.c = sc.split(';')[0];
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  try {
    const anon = jar();
    let r = await call(anon, 'GET', '/');
    check('signed out, the site shows the sign-in page with email + password', r.status === 401 && /type="email"/.test(r.text) && /BOOTSTRAP = true/.test(r.text));
    const mails = () => (fs.existsSync(mailDir) ? fs.readdirSync(mailDir).sort().map(f => JSON.parse(fs.readFileSync(path.join(mailDir, f), 'utf8'))) : []);
    const tokenIn = m => (/[?&]token=([A-Za-z0-9_\-%]+)/.exec(m.text) || [])[1];

    // People sign themselves up, with the password they choose — no temporary one.
    const owner = jar();
    r = await call(owner, 'POST', '/api/auth/signup', { name: 'Owner', email: 'Owner@Example.com', password: 'owner-own-password-7' });
    check('anyone can sign up with their own password and is signed straight in', r.status === 200);
    r = await call(owner, 'GET', '/');
    check('...a new account with no tools sees only a "waiting for access" page — not the site and its built-in figures',
      r.status === 200 && /You're signed up/.test(r.text) && !/MONTHLY_DATA|__OP_USER/.test(r.text));
    r = await call(owner, 'GET', '/api/variance/config');
    check('...and no data', r.status === 403);
    r = await call(jar(), 'POST', '/api/auth/signup', { name: 'Imposter', email: 'owner@example.com', password: 'whatever-12345' });
    check('a second sign-up with the same email is refused', r.status === 409);
    const conf = mails().filter(m => m.to === 'owner@example.com' && /Confirm your email/.test(m.subject)).pop();
    r = await call(jar(), 'GET', `/verify?token=${tokenIn(conf || { text: '' })}`);
    check('a sign-up gets a "confirm your email" link, and opening it confirms the address', !!conf && /Email confirmed/.test(r.text));

    // First admin: the site PIN, once, to tick Admin on your own account.
    const setup = jar();
    r = await call(setup, 'POST', '/api/auth/login', { pin: 'setup-pin-123' });
    check('with no admin yet, the site PIN opens it (first-time setup)', r.status === 200);
    r = await call(setup, 'GET', '/');
    check('...and the page carries the setup user (admin, bootstrap)', r.status === 200 && /"bootstrap":true/.test(r.text) && /"admin":true/.test(r.text));
    r = await call(setup, 'GET', '/api/admin/users');
    const ownerRow = r.json.users.find(u => u.email === 'owner@example.com');
    check('...where the sign-up is listed with only Home (always on) and its email confirmed', !!ownerRow && JSON.stringify(ownerRow.tools) === '["overview"]' && ownerRow.emailVerified);
    r = await call(setup, 'PUT', `/api/admin/users/${ownerRow.id}`, { admin: true });
    check('the setup session makes that account an admin', r.status === 200 && r.json.user.admin);
    r = await call(setup, 'GET', '/api/admin/users');
    check('...after which the PIN session no longer works', r.status === 401);
    r = await call(jar(), 'POST', '/api/auth/login', { pin: 'setup-pin-123' });
    check('...and the PIN cannot sign in again (retired)', r.status === 401 && /retired/.test(r.json.error));
    r = await call(owner, 'GET', '/api/admin/users');
    check('the new admin\'s existing session now has the Admin tab — no password change, no re-sign-in', r.status === 200);

    const emp = jar();
    r = await call(emp, 'POST', '/api/auth/signup', { name: 'Employee', email: 'emp@example.com', password: 'emp-own-password-7' });
    const empId = (await call(owner, 'GET', '/api/admin/users')).json.users.find(u => u.email === 'emp@example.com').id;
    check('an employee signs up and has no access until an admin acts', r.status === 200 && (await call(emp, 'GET', '/api/variance/config')).status === 403);
    r = await call(owner, 'PUT', `/api/admin/users/${empId}`, { tools: ['variances'] });
    check('the admin ticks Variances for them', r.status === 200 && JSON.stringify(r.json.user.tools) === '["overview","variances"]');
    r = await call(emp, 'GET', '/');
    check('the employee\'s page lists only Variances', r.status === 200 && /"tools":\["overview","variances"\]/.test(r.text) && /"admin":false/.test(r.text));
    r = await call(emp, 'GET', '/api/variance/config');
    check('...variance data is served', r.status === 200);
    r = await call(emp, 'GET', '/api/budget');
    check('...Budget data is refused by the server', r.status === 403 && r.json.code === 'TOOL_FORBIDDEN');
    r = await call(emp, 'GET', '/api/admin/users');
    check('...and the Admin API is refused', r.status === 403);
    await call(owner, 'PUT', `/api/admin/users/${empId}`, { tools: ['variances', 'budget'] });
    r = await call(emp, 'GET', '/api/budget');
    check('ticking Budget for them applies on their next request (no re-sign-in)', r.status !== 403);
    await call(owner, 'POST', `/api/admin/users/${empId}/password`, { password: 'reset-temp-pass-7' });
    r = await call(emp, 'GET', '/api/variance/config');
    check('an admin password reset signs them out at once', r.status === 401);
    r = await call(owner, 'PUT', `/api/admin/users/${(await call(owner, 'GET', '/api/admin/users')).json.users.find(u => u.email === 'owner@example.com').id}`, { admin: false });
    check('the last admin cannot remove their own admin', r.status === 409);
    const stored = fs.readFileSync(usersFile, 'utf8');
    check('the users file holds hashes, not passwords', !/owner-own-password-7|emp-own-password-7|reset-temp-pass-7/.test(stored) && /scrypt\$/.test(stored));
    r = await call(jar(), 'POST', '/api/auth/login', { email: 'emp@example.com', password: 'reset-temp-pass-7' });
    check('a password an admin sets is a normal password — no forced change at next sign-in', r.status === 200 && !('mustChangePassword' in r.json));
    // ── emailed reset links (MAIL_TRANSPORT=file writes them to a folder) ──
    const before = mails().length;
    r = await call(jar(), 'POST', '/api/auth/forgot', { email: 'nobody@example.com' });
    check('"forgot password" for an unknown email answers the same and sends nothing', r.status === 200 && mails().length === before);
    const evil = { c: '' };
    const er = await fetch(base + '/api/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example' }, body: JSON.stringify({ email: 'emp@example.com' }) });
    const m1 = mails().slice(-1)[0];
    check('a reset email goes to the account holder', er.status === 200 && m1 && m1.to === 'emp@example.com' && /Reset your/.test(m1.subject));
    check('...and its link uses the configured site address, never the request\'s Host', m1 && m1.text.includes('https://site.example/reset?token=') && !m1.text.includes('evil.example'));
    const tok = decodeURIComponent(tokenIn(m1) || '');
    const stored2 = fs.readFileSync(usersFile, 'utf8');
    check('only a hash of the link token is stored', tok.length > 30 && !stored2.includes(tok));
    r = await call(jar(), 'GET', '/reset');
    check('the reset page opens without signing in', r.status === 200 && /Choose your password/.test(r.text));
    const empOther = jar();
    await call(empOther, 'POST', '/api/auth/login', { email: 'emp@example.com', password: 'reset-temp-pass-7' });
    const viaLink = jar();
    r = await call(viaLink, 'POST', '/api/auth/reset', { token: tok, password: 'emp-chose-this-one-7' });
    check('the link sets a new password and signs them in', r.status === 200 && (await call(viaLink, 'GET', '/api/variance/config')).status === 200);
    r = await call(jar(), 'POST', '/api/auth/reset', { token: tok, password: 'another-password-9' });
    check('...and works only once', r.status === 400);
    check('...and the old password no longer signs in', (await call(jar(), 'POST', '/api/auth/login', { email: 'emp@example.com', password: 'reset-temp-pass-7' })).status === 401);
    check('...and their other sessions ended', (await call(empOther, 'GET', '/api/variance/config')).status === 401);
    r = await call(owner, 'POST', '/api/admin/users', { email: 'invitee@example.com', name: 'Invitee', invite: true, tools: ['renovations'] });
    const inv = mails().slice(-1)[0];
    check('an admin can invite by email (no temporary password to hand out)', r.status === 200 && r.json.invited && inv.to === 'invitee@example.com' && /account/.test(inv.subject));
    r = await call(jar(), 'POST', '/api/auth/reset', { token: decodeURIComponent(tokenIn(inv)), password: 'invitee-own-pass-7' });
    check('...and the invitee sets their own password from the link', r.status === 200
      && (await call(jar(), 'POST', '/api/auth/login', { email: 'invitee@example.com', password: 'invitee-own-pass-7' })).status === 200);
    r = await call(owner, 'POST', `/api/admin/users/${empId}/send-reset`, {});
    check('an admin can email someone a reset link', r.status === 200 && mails().slice(-1)[0].to === 'emp@example.com');
    r = await call(emp, 'POST', `/api/admin/users/${empId}/send-reset`, {});
    check('...but a non-admin cannot', r.status === 401 || r.status === 403);
    check('no Rent Manager call was attempted', !/myhome\.api\.rentmanager|Authentication failed|logged in maximum/i.test(log));
  } finally {
    child.kill();
  }
}

// A the host pull-request preview: copied settings may include the RM password and
// may lack the PIN. It must stay locked and never log into Rent Manager.
async function previewRun() {
  console.log('\nPull-request preview (IS_PULL_REQUEST=true)');
  const port = 5900 + Math.floor(Math.random() * 90);
  const env = { ...process.env, DEMO_MODE: '', PORT: String(port), USERS_FILE: path.join(tmp, 'preview-users.json'), IS_PULL_REQUEST: 'true',
    DASHBOARD_ACCESS_PIN: '', RENTMANAGER_USERNAME: 'dummy-user', RENTMANAGER_PASSWORD: 'dummy-pass', RENTMANAGER_COMPANY: 'dummyco',
    RENTMANAGER_BASE_URL: 'http://127.0.0.1:9', CF_ACCESS_TEAM_DOMAIN: '', CF_ACCESS_AUD: '', PL_AUTO_REFRESH_MS: '0', MAIL_TRANSPORT: '', SMTP_HOST: '' };
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/auth/status'); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
    await new Promise(r => setTimeout(r, 1500));   // let any startup warm-up run
    const page = await fetch(base + '/');
    check('a preview with no PIN and no accounts is still locked (sign-in page, not the site)', page.status === 401);
    const api = await fetch(base + '/api/variance/config');
    check('...and its data is refused', api.status === 401);
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '' }) });
    check('...and an empty PIN does not open it', login.status === 401);
    const rm = require('../services/rentManagerClient');
    const saved = process.env.IS_PULL_REQUEST; process.env.IS_PULL_REQUEST = 'true';
    check('Rent Manager counts as off in a preview, even with credentials', rm.isConfigured() === false);
    process.env.IS_PULL_REQUEST = '';
    process.env.RENTMANAGER_COMPANY = process.env.RENTMANAGER_COMPANY || '';
    const savedDis = process.env.RM_DISABLED; process.env.RM_DISABLED = '1';
    check('RM_DISABLED=1 also keeps Rent Manager off', rm.isConfigured() === false);
    if (savedDis === undefined) delete process.env.RM_DISABLED; else process.env.RM_DISABLED = savedDis;
    process.env.IS_PULL_REQUEST = saved || '';
    check('...and the preview server made no Rent Manager login attempt', !/AuthorizeUser|Authentication failed|ECONNREFUSED 127\.0\.0\.1:9|maximum number/i.test(log), log.slice(-400));
  } finally { child.kill(); }
}

e2e().then(previewRun).catch(e => { fails++; console.log('  ✗ end-to-end run crashed:', e.message); }).finally(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
  process.exit(fails === 0 ? 0 : 1);
});
