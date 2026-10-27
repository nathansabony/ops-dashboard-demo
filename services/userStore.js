// User accounts: everyone signs in with their own email + password, and an admin
// chooses which tools (tabs) each person can open.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// An office wants some employees to see only one tool. One shared PIN shows every
// tab to anyone who has it, and PINs get passed around. One login per person, with
// the tools ticked per person, fixes that: removing someone never means changing a
// code everyone else knows.
//
// Normally stored on a persistent disk (data/), never in git. Passwords are scrypt
// hashes with a per-user salt; the plain password is never written anywhere. Which
// tools a person has is read from here on EVERY request (services/accessControl.js),
// so a change in the Admin tab applies immediately.
//
// DEMO_MODE=1: the store lives in memory only and is seeded with a demo admin and a
// few sample staff accounts. The visitor is signed in as the admin automatically
// (server.js), so there is no sign-in. Anything changed in the Admin tab is lost
// when the server restarts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.USERS_FILE || path.join(__dirname, '..', 'data', 'users.json');

// The tools an admin can grant — one per top-level tab. `key` matches the page
// id in public/index.html (page-<key>) and the route map in accessControl.js.
// Nav order and names as of 2026-10-22. Keys never change (they are stored on
// every account); labels are free.
// Home ('overview') is open to everyone signed in (the owner, 2026-10-22: "if
// someone opens the website they have to see something"), so it is `always`:
// publicUser adds it to every account and the Admin tab shows it locked on. It
// shows only general things (grades, headlines, no dollars) from the Home
// snapshot; the data routes it used to share are now behind the tool that owns
// them (services/accessControl.js).
// Scanner became its own permission on 2026-10-22; it used to ride on
// 'underwriting'. Accounts that had Underwriting were given Scanner too (load()).
const TOOLS = [
  { key: 'overview',     label: 'Home', always: true },
  { key: 'entities',     label: 'Portfolio' },
  { key: 'variances',    label: 'Variances' },
  { key: 'underwriting', label: 'Underwriting' },
  { key: 'scanner',      label: 'Scanner' },
  { key: 'budget',       label: 'Budgeting' },
  { key: 'delinquency',  label: 'Delinquency' },
  { key: 'renovations',  label: 'Renovations' },
  { key: 'issues',       label: 'Service Requests' },
];
const TOOL_KEYS = TOOLS.map(t => t.key);
const ALWAYS_KEYS = TOOLS.filter(t => t.always).map(t => t.key);
const MIN_PASSWORD = 5;
// Shown wherever a password is chosen; checkPassword enforces the same rule.
const PASSWORD_RULE = `At least ${MIN_PASSWORD} characters, including a number.`;

// ── passwords ───────────────────────────────────────────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  try {
    const [kind, n, saltB64, hashB64] = String(stored || '').split('$');
    if (kind !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}
// A hash to compare against when the email does not exist, so a wrong email and
// a wrong password take the same time (no "which emails have accounts" oracle).
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

// ── store ───────────────────────────────────────────────────────────────────
const DEMO = process.env.DEMO_MODE === '1';
const DEMO_ADMIN_ID = 'demo-admin';
let demoStore = null;
function seedDemo() {
  const now = new Date().toISOString();
  const mk = (id, email, name, admin, tools) => ({
    id, email, name, passwordHash: hashPassword(crypto.randomBytes(12).toString('hex')), admin, tools,
    disabled: false, sv: 1, createdAt: now, createdBy: 'demo seed', selfSignup: false, emailVerified: true,
    scannerSplit: true, lastLoginAt: now,
  });
  return { users: [
    mk(DEMO_ADMIN_ID, 'demo@cedarridge.example', 'Demo Admin', true, []),
    mk('demo-jordan', 'jordan.reyes@cedarridge.example', 'Jordan Reyes', false, TOOL_KEYS.filter(k => k !== 'underwriting' && k !== 'scanner')),
    mk('demo-priya', 'priya.natarajan@cedarridge.example', 'Priya Natarajan', false, ['entities', 'delinquency', 'issues']),
    mk('demo-sam', 'sam.whitfield@cedarridge.example', 'Sam Whitfield', false, ['issues', 'renovations']),
    mk('demo-dana', 'dana.okoye@cedarridge.example', 'Dana Okoye', false, ['variances', 'budget', 'delinquency']),
  ] };
}

function load() {
  if (DEMO) {
    if (!demoStore) demoStore = seedDemo();
    return JSON.parse(JSON.stringify(demoStore));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const users = Array.isArray(parsed.users) ? parsed.users : [];
    // One-time split of Scanner from Underwriting (2026-10-22): whoever had
    // Underwriting keeps Scanner. The flag rides along on the next save, so an
    // admin who later takes Scanner away is not overruled on the following load.
    for (const u of users) {
      if (u.scannerSplit) continue;
      u.scannerSplit = true;
      if (Array.isArray(u.tools) && u.tools.includes('underwriting') && !u.tools.includes('scanner')) u.tools = [...u.tools, 'scanner'];
    }
    return { users };
  } catch {
    return { users: [] };
  }
}
function save(store) {
  if (DEMO) { demoStore = JSON.parse(JSON.stringify(store)); return; }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);   // atomic: a crash mid-write never leaves half a file
}

const normEmail = e => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Home goes to everyone signed in, except a self sign-up that is still unvouched
// for: email not confirmed AND no tool granted. Anyone can sign up, and a stranger
// should not see the company's grades because they typed an address; confirming
// the email, or an admin granting any tool, is what vouches for them.
function homeKeys(u) {
  const vouched = u.emailVerified || (u.tools || []).some(t => TOOL_KEYS.includes(t));
  return u.selfSignup && !vouched ? [] : ALWAYS_KEYS;
}

// What leaves this module: never the hash.
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name || '', admin: !!u.admin,
    tools: u.admin ? TOOL_KEYS.slice() : [...new Set([...homeKeys(u), ...(u.tools || []).filter(t => TOOL_KEYS.includes(t))])],
    disabled: !!u.disabled,
    selfSignup: !!u.selfSignup, emailVerified: !!u.emailVerified,
    createdAt: u.createdAt || null, createdBy: u.createdBy || null,
    lastLoginAt: u.lastLoginAt || null,
  };
}

function fail(msg, code = 'BAD_INPUT') { const e = new Error(msg); e.code = code; throw e; }
function cleanTools(tools) {
  if (!Array.isArray(tools)) return [];
  return [...new Set(tools.map(String))].filter(t => TOOL_KEYS.includes(t) && !ALWAYS_KEYS.includes(t));
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) fail(`Password must be at least ${MIN_PASSWORD} characters.`);
  if (!/[0-9]/.test(pw)) fail('Password must include at least one number.');
  if (pw.length > 200) fail('Password is too long.');
}

function listUsers() { return load().users.map(publicUser); }
function getById(id) { return load().users.find(u => u.id === id) || null; }
function getByEmail(email) { const e = normEmail(email); return load().users.find(u => u.email === e) || null; }
function hasAdmin() { return load().users.some(u => u.admin && !u.disabled); }
function count() { return load().users.length; }

// Sign-in check. Returns the stored user or null; always does one scrypt.
function authenticate(email, password) {
  const u = getByEmail(email);
  const ok = verifyPassword(password, u ? u.passwordHash : DUMMY_HASH);
  if (!u || !ok || u.disabled) return null;
  return u;
}

function createUser({ email, name, password, tools, admin, selfSignup = false }, by) {
  const e = normEmail(email);
  if (!EMAIL_RE.test(e)) fail('Enter a valid email address.');
  checkPassword(password);
  const store = load();
  if (store.users.some(u => u.email === e)) fail('There is already an account for that email.', 'EXISTS');
  const u = {
    id: crypto.randomUUID(), email: e, name: String(name || '').trim().slice(0, 120),
    passwordHash: hashPassword(password), admin: !!admin, tools: cleanTools(tools),
    disabled: false, sv: 1,
    createdAt: new Date().toISOString(), createdBy: by || null,
    selfSignup: !!selfSignup, emailVerified: false,
  };
  store.users.push(u);
  save(store);
  return publicUser(u);
}

// Admin edits. The last active admin can never be demoted, disabled or deleted —
// that would lock everyone out of the Admin tab with no way back in.
function wouldLeaveNoAdmin(store, id, next) {
  return !store.users.some(u => u.admin && !u.disabled && u.id !== id) && !(next.admin && !next.disabled);
}
function updateUser(id, patch, by) {
  const store = load();
  const u = store.users.find(x => x.id === id);
  if (!u) fail('No such user.', 'NOT_FOUND');
  const next = { ...u };
  if (patch.name !== undefined) next.name = String(patch.name || '').trim().slice(0, 120);
  if (patch.tools !== undefined) next.tools = cleanTools(patch.tools);
  if (patch.admin !== undefined) next.admin = !!patch.admin;
  if (patch.disabled !== undefined) next.disabled = !!patch.disabled;
  if (patch.email !== undefined) {
    const e = normEmail(patch.email);
    if (!EMAIL_RE.test(e)) fail('Enter a valid email address.');
    if (store.users.some(x => x.email === e && x.id !== id)) fail('There is already an account for that email.', 'EXISTS');
    next.email = e;
  }
  if (u.admin && !u.disabled && wouldLeaveNoAdmin(store, id, next)) fail('This is the only admin — make someone else an admin first.', 'LAST_ADMIN');
  if (next.disabled && !u.disabled) next.sv = (u.sv || 1) + 1;   // signs them out everywhere
  next.updatedAt = new Date().toISOString(); next.updatedBy = by || null;
  Object.assign(u, next);
  save(store);
  return publicUser(u);
}
function setPassword(id, password) {
  checkPassword(password);
  const store = load();
  const u = store.users.find(x => x.id === id);
  if (!u) fail('No such user.', 'NOT_FOUND');
  u.passwordHash = hashPassword(password);
  delete u.mustChangePassword;   // retired flag from the first accounts build
  u.sv = (u.sv || 1) + 1;          // every other session for this person ends
  u.passwordChangedAt = new Date().toISOString();
  delete u.reset;
  save(store);
  return publicUser(u);
}
function deleteUser(id) {
  const store = load();
  const u = store.users.find(x => x.id === id);
  if (!u) fail('No such user.', 'NOT_FOUND');
  if (u.admin && !u.disabled && wouldLeaveNoAdmin(store, id, { admin: false, disabled: true })) fail('This is the only admin — make someone else an admin first.', 'LAST_ADMIN');
  store.users = store.users.filter(x => x.id !== id);
  save(store);
}
// ── Emailed reset / invite links ────────────────────────────────────────────
// One live token per person: 32 random bytes, and only its SHA-256 is stored, so a
// copy of users.json cannot be used to reset anyone. Single use; expires.
function tokenHash(raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); }
function createResetToken(id, ttlMs) {
  const store = load();
  const u = store.users.find(x => x.id === id);
  if (!u) fail('No such user.', 'NOT_FOUND');
  if (u.disabled) fail('This account is turned off — turn it back on first.', 'DISABLED');
  const raw = crypto.randomBytes(32).toString('base64url');
  u.reset = { hash: tokenHash(raw), exp: Date.now() + ttlMs };
  save(store);
  return raw;
}
// The person a token belongs to, or null (unknown, used, expired, account off).
function userForResetToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const h = tokenHash(raw);
  const u = load().users.find(x => x.reset && x.reset.hash.length === h.length
    && crypto.timingSafeEqual(Buffer.from(x.reset.hash), Buffer.from(h)));
  if (!u || u.disabled || !(u.reset.exp > Date.now())) return null;
  return u;
}
// Set the new password from a token; the token is spent either way.
function resetWithToken(raw, password) {
  const u = userForResetToken(raw);
  if (!u) fail('This link has expired or was already used. Ask for a new one.', 'BAD_TOKEN');
  checkPassword(password);
  const store = load();
  const x = store.users.find(y => y.id === u.id);
  x.passwordHash = hashPassword(password);
  delete x.mustChangePassword;
  x.sv = (x.sv || 1) + 1;
  x.passwordChangedAt = new Date().toISOString();
  x.emailVerified = true;   // they used a link sent to that address
  delete x.reset;
  save(store);
  return x;
}

// ── Self sign-up (2026-10-07) ───────────────────────────────────────────────
// The owner: "users sign up themselves with default no permissions and then I give
// them perms once they're in." A sign-up is never an admin and has no tools; the
// password they choose is their real one. `allowedDomains` (from
// SIGNUP_ALLOWED_DOMAINS) optionally limits sign-ups to company addresses.
function signUp({ email, name, password }, allowedDomains) {
  const e = normEmail(email);
  if (!String(name || '').trim()) fail('Enter your name.');
  if (allowedDomains && allowedDomains.length && !allowedDomains.includes(e.split('@')[1] || '')) {
    fail(`Use your work email (${allowedDomains.map(d => '@' + d).join(' or ')}).`);
  }
  return createUser({ email: e, name, password, tools: [], admin: false, selfSignup: true }, 'self sign-up');
}

// Email confirmation: proves the person signing up owns the address (so nobody can
// sign up as a colleague and be given their access). Same token scheme as resets.
function createVerifyToken(id) {
  const store = load();
  const u = store.users.find(x => x.id === id);
  if (!u) fail('No such user.', 'NOT_FOUND');
  const raw = crypto.randomBytes(32).toString('base64url');
  u.verify = { hash: tokenHash(raw), exp: Date.now() + 7 * 24 * 3600 * 1000 };
  save(store);
  return raw;
}
function verifyEmail(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const h = tokenHash(raw);
  const store = load();
  const u = store.users.find(x => x.verify && x.verify.hash.length === h.length
    && crypto.timingSafeEqual(Buffer.from(x.verify.hash), Buffer.from(h)));
  if (!u || !(u.verify.exp > Date.now())) return null;
  u.emailVerified = true;
  delete u.verify;
  save(store);
  return publicUser(u);
}

function touchLogin(id) {
  const store = load();
  const u = store.users.find(x => x.id === id);
  if (!u) return;
  u.lastLoginAt = new Date().toISOString();
  save(store);
}

module.exports = {
  FILE, TOOLS, TOOL_KEYS, MIN_PASSWORD, PASSWORD_RULE,
  hashPassword, verifyPassword, publicUser,
  listUsers, getById, getByEmail, hasAdmin, count, authenticate,
  createUser, updateUser, setPassword, deleteUser, touchLogin,
  createResetToken, userForResetToken, resetWithToken,
  signUp, createVerifyToken, verifyEmail,
};
