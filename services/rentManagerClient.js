// Thin wrapper around the Rent Manager WAPI12 REST API.
//
// Reference: Rent Manager 12 Web API Technical Documentation
// https://info.rentmanager.com/hubfs/PDFs/Technical%20Documentation.pdf
//
// Auth flow (per the docs):
//   1. POST /Authentication/AuthorizeUser with { Username, Password } (+ optional LocationID)
//   2. Server returns an APIToken (a plain string)
//   3. Every subsequent request sends that token in the X-RM12Api-ApiToken header
//   4. Tokens are invalidated if the user's permissions/password change, so we
//      re-authenticate automatically on a 401.
//
// This file intentionally does nothing with credentials until RENTMANAGER_USERNAME /
// RENTMANAGER_PASSWORD / RENTMANAGER_COMPANY are set in .env. Until then, isConfigured()
// returns false and server.js falls back to mock data so the rest of the app keeps working.

const fetch = require('node-fetch');

// DEMO_MODE=1: no network at all. Every call is answered from the fake world in
// services/demo (see rmFake.js), so the whole site runs on made-up data.
const DEMO = process.env.DEMO_MODE === '1';
const fake = DEMO ? require('./demo/rmFake') : null;


const COMPANY = process.env.RENTMANAGER_COMPANY;
const USERNAME = process.env.RENTMANAGER_USERNAME;
const PASSWORD = process.env.RENTMANAGER_PASSWORD;
const LOCATION_ID = process.env.RENTMANAGER_LOCATION_ID;

const BASE_URL = COMPANY ? `https://${COMPANY}.api.rentmanager.com` : null;

// ── Outbound proxy support (2026-08-26) ─────────────────────────────────────
// On a normal host there is no proxy and this is a no-op. It exists for the sandboxed
// environments this repo is also worked on from, where ALL egress goes through a
// local CONNECT proxy and anything bypassing it is refused at the network layer —
// which is what made Rent Manager unreachable from the dev container even after
// The host was allowed, while `curl` (which reads HTTPS_PROXY) worked fine.
//
// Loaded lazily and defensively: no proxy variable, or no agent package, and every
// request goes out exactly as it does today.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || '';
let _proxyAgent;
function proxyAgent() {
  if (_proxyAgent !== undefined) return _proxyAgent;
  _proxyAgent = null;
  if (PROXY_URL) {
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      _proxyAgent = new HttpsProxyAgent(PROXY_URL);
    } catch (err) {
      _proxyAgent = null;   // package absent — direct, same as before
    }
  }
  return _proxyAgent;
}
// Merged into every fetch this client makes. node-fetch v2 ignores HTTPS_PROXY on
// its own, which is the whole reason this is here.
function withAgent(init) {
  const agent = proxyAgent();
  return agent ? { ...init, agent } : init;
}

let cachedToken = null;

// De-duplicate concurrent logins. Without this, if cachedToken is null and N
// requests arrive at once (e.g. a per-property P&L backfill firing many calls in
// parallel), each one independently calls authenticate() — N simultaneous
// AuthorizeUser logins, which is exactly what blows RM's ~8-concurrent-session
// cap. Instead the first caller starts the login and every other caller awaits
// the same in-flight promise (mirrors server.js's tenantIndexPromise pattern).
let authPromise = null;

// If AuthorizeUser fails (e.g. RM's concurrent-session cap), cachedToken stays
// null — which used to mean every single incoming request re-attempted login
// immediately, one page view could fire dozens of failed logins in a row and
// keep RM's session cap pinned indefinitely. Now we back off for a bit after
// a failure instead of retrying on every request.
let lastAuthFailureAt = 0;
const AUTH_FAILURE_COOLDOWN_MS = 60 * 1000;

// Wrap authenticate() so concurrent callers share one in-flight login. Any
// caller that needs a fresh token goes through this, never authenticate() directly.
function authenticateShared() {
  if (authPromise) return authPromise;
  authPromise = authenticate().finally(() => { authPromise = null; });
  return authPromise;
}

// A the host pull-request preview copies production's settings — possibly the Rent
// Manager password. Our RM user has a login cap shared with production ("logged
// in maximum number of times"), so a preview that logged in on its own could lock
// production out. Previews therefore never talk to Rent Manager unless someone
// sets RM_IN_PREVIEW=1 on the preview on purpose. (the host sets IS_PULL_REQUEST.)
// RM_DISABLED=1 is the same switch by hand, for any copy of the site that must
// never log into Rent Manager, whatever credentials are pasted into it.
function inPreview() {
  if (process.env.RM_DISABLED === '1') return true;
  return process.env.IS_PULL_REQUEST === 'true' && process.env.RM_IN_PREVIEW !== '1';
}
function isConfigured() {
  if (DEMO) return true;
  return Boolean(COMPANY && USERNAME && PASSWORD) && !inPreview();
}

async function authenticate() {
  if (!isConfigured()) {
    if (inPreview()) throw new Error('Rent Manager is off on this copy of the site (preview, or RM_DISABLED — the RM login cap is shared with production).');
    throw new Error('Rent Manager credentials are not set in .env yet.');
  }

  const res = await fetch(`${BASE_URL}/Authentication/AuthorizeUser`, withAgent({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Username: USERNAME,
      Password: PASSWORD,
      ...(LOCATION_ID ? { LocationID: LOCATION_ID } : {}),
    }),
  }));

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    lastAuthFailureAt = Date.now();
    throw new Error(`Rent Manager auth failed (${res.status}): ${text}`);
  }

  // WAPI12 returns the token as a raw string (sometimes quoted JSON string).
  const raw = await res.text();
  cachedToken = raw.replace(/^"|"$/g, '');
  lastAuthFailureAt = 0;
  return cachedToken;
}

/**
 * Generic authenticated GET against a WAPI12 resource, e.g. get('/Tenants', { pagesize: 50 })
 * Automatically re-authenticates once on a 401 in case the cached token expired.
 */
// ── being rate-limited is not an answer ─────────────────────────────────────
// Rent Manager returns 429 under load, and a sweep that reads thousands of
// records will find it. Left unhandled it is the worst kind of failure here: the
// call comes back empty and the caller reports "no receipt is attached to this
// charge" — a confident, wrong statement about the books, produced by our own
// impatience. Found 2026-08-26 when a coverage sweep declared all 3,555 card
// charges undocumented after being throttled part-way through.
//
// So a 429 waits and retries rather than propagating. Honouring Retry-After when
// the server sends one, backing off exponentially when it does not, and giving up
// loudly rather than quietly after the last attempt.
const RATE_LIMIT_TRIES = 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function handleRateLimit(res, attempt, resourcePath) {
  if (res.status !== 429 || attempt >= RATE_LIMIT_TRIES) return false;
  const header = Number(res.headers.get('retry-after'));
  // Exponential, with jitter so parallel workers do not all come back at once
  // and reproduce the burst that caused this.
  const backoff = Number.isFinite(header) && header > 0
    ? header * 1000
    : Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
  await sleep(backoff);
  return true;
}

async function get(resourcePath, queryParams = {}, _retried = false, _attempt = 0) {
  if (DEMO) return fake.get(resourcePath, queryParams);
  if (!isConfigured()) {
    throw new Error('Rent Manager credentials are not set in .env yet.');
  }
  if (!cachedToken) {
    const cooldownRemaining = AUTH_FAILURE_COOLDOWN_MS - (Date.now() - lastAuthFailureAt);
    if (lastAuthFailureAt && cooldownRemaining > 0) {
      throw new Error(`Rent Manager auth is cooling down after a recent failure — retry in ${Math.ceil(cooldownRemaining / 1000)}s (not re-attempting login to avoid hammering RM while it's rejecting us)`);
    }
    await authenticateShared();
  }

  const qs = new URLSearchParams(queryParams).toString();
  const url = `${BASE_URL}${resourcePath}${qs ? `?${qs}` : ''}`;

  const res = await fetch(url, withAgent({
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-RM12Api-ApiToken': cachedToken,
    },
  }));

  if (res.status === 401 && !_retried) {
    cachedToken = null;
    await authenticateShared();
    return get(resourcePath, queryParams, true);
  }

  if (await handleRateLimit(res, _attempt, resourcePath)) {
    return get(resourcePath, queryParams, _retried, _attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Rent Manager request failed (${res.status}) for ${resourcePath}: ${text}`);
  }

  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`Rent Manager returned non-JSON for ${resourcePath}: ${text.slice(0, 200)}`);
  }
}

/**
 * Same auth and retry as get(), but returns the RAW bytes instead of parsed JSON.
 *
 * Needed because an attachment is a file, not a record. Rent Manager gates file
 * downloads behind the same X-RM12Api-ApiToken header as everything else, which a
 * browser <a href> cannot send — so a link straight to an RM attachment URL is
 * dead on click. The server has to fetch the bytes and stream them to the browser
 * itself. See services/rmDocuments.js fetchAttachment().
 *
 * Returns { ok, status, contentType, contentDisposition, buffer }. Never throws on
 * a non-2xx — the caller is walking a list of candidate URLs and a 404 is data.
 */
// A bare request with any verb, returning the status rather than throwing on it.
// Only the write-capability probe uses this: whether a route answers 404, 403 or
// 400 to a POST is the whole finding, and every one of those is an exception to
// the normal client.
const RAW_TIMEOUT_MS = Number(process.env.RM_RAW_TIMEOUT_MS || 12000);

async function raw(method, resourcePath, body) {
  if (DEMO) return fake.raw(method, resourcePath, body);
  if (!isConfigured()) throw new Error('Rent Manager credentials are not set in .env yet.');
  if (!cachedToken) await authenticateShared();
  // A probe that hangs is a probe that holds a worker until the platform kills the
  // process. Every raw call gets a hard ceiling.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RAW_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE_URL}${resourcePath}`, withAgent({
      method,
      signal: ctl.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-RM12Api-ApiToken': cachedToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  } finally {
    clearTimeout(timer);
  }
  let text = '';
  try { text = await res.text(); } catch (err) { text = ''; }
  return { status: res.status, body: text };
}

async function getRaw(resourcePath, queryParams = {}, _retried = false, _attempt = 0) {
  if (DEMO) return fake.getRaw(resourcePath, queryParams);
  if (!isConfigured()) {
    throw new Error('Rent Manager credentials are not set in .env yet.');
  }
  if (!cachedToken) {
    const cooldownRemaining = AUTH_FAILURE_COOLDOWN_MS - (Date.now() - lastAuthFailureAt);
    if (lastAuthFailureAt && cooldownRemaining > 0) {
      throw new Error(`Rent Manager auth is cooling down after a recent failure — retry in ${Math.ceil(cooldownRemaining / 1000)}s`);
    }
    await authenticateShared();
  }

  const qs = new URLSearchParams(queryParams).toString();
  // An attachment embed hands back a fully-formed DownloadURL. Prepending BASE_URL
  // to it would produce nonsense, so an absolute URL is used as given — it is the
  // API telling us where the file is, which beats any path we could assemble.
  const url = /^https?:\/\//i.test(resourcePath)
    ? `${resourcePath}${qs ? `${resourcePath.includes('?') ? '&' : '?'}${qs}` : ''}`
    : `${BASE_URL}${resourcePath}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, withAgent({
    method: 'GET',
    headers: { 'X-RM12Api-ApiToken': cachedToken },
  }));

  if (res.status === 401 && !_retried) {
    cachedToken = null;
    await authenticateShared();
    return getRaw(resourcePath, queryParams, true);
  }

  if (await handleRateLimit(res, _attempt, resourcePath)) {
    return getRaw(resourcePath, queryParams, _retried, _attempt + 1);
  }

  const buffer = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  return {
    ok: res.ok,
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    contentDisposition: res.headers.get('content-disposition') || '',
    buffer,
  };
}

// ── Resource-specific helpers ──────────────────────────────────────────────
// These map to the report/data categories the management site already visualizes.
// Field names and exact resource paths should be confirmed against the live
// WAPI12 docs/Swagger once credentials are issued — the paths below follow the
// documented resource-naming convention (collection resources match entity names).

const Tenants             = (params) => get('/Tenants', params);
const Properties          = (params) => get('/Properties', params);
const Units               = (params) => get('/Units', params);
const UnitStatusTypes     = (params) => get('/UnitStatusTypes', params);
const Leases              = (params) => get('/Leases', params);
const ServiceManagerIssues = (params) => get('/ServiceManagerIssues', params);
const RecurringCharges    = (params) => get('/RecurringCharges', params);

// Individual charge transactions (per-tenant, per-charge-type line items with a
// TransactionDate). Used to tell "posted early but not due yet" charges (e.g.
// next month's rent, which RM posts ~5 days ahead of the 1st) apart from actually
// past-due balances. Note: TenantID is not a filterable field on this resource —
// the per-tenant link is AccountID (AccountType="Customer") on the charge row.
const Charges              = (params) => get('/Charges', params);

// General Ledger — used for debt service tracking
// GLAccounts: find accounts by type (e.g. AccountType=Liability for mortgage payable,
//   or AccountType=Expense and search name for "Mortgage Interest")
const GLAccounts          = (params) => get('/GLAccounts', params);

// The whole chart of accounts, for anything that needs every account. RM caps a
// page at 1,000 rows unless the request names its fields, and at 20,000 when it
// does. Callers asked for 500 or 1,000 with no fields, so they read the chart up
// to that many rows and dropped the rest without a word: at 500 that hid half
// the mortgage loans from debt service (2026-10-20), and at 934 accounts the
// 1,000 page was close to doing the same to GL detail and renovations. These are
// the fields RM sends by default, so naming them changes nothing else; a page
// that comes back full is an error rather than a silently short chart.
const GL_ACCOUNT_FIELDS = 'GLAccountID,ParentGLAccountID,Name,Description,Reference,GLAccountType,SortOrder';
const GL_ACCOUNT_PAGE = 20000;
async function allGLAccounts() {
  const raw = await GLAccounts({ pageSize: GL_ACCOUNT_PAGE, fields: GL_ACCOUNT_FIELDS });
  const rows = Array.isArray(raw) ? raw : (raw && (raw.Results || raw.Items)) || [];
  if (rows.length >= GL_ACCOUNT_PAGE) throw new Error(`The chart of accounts filled a ${GL_ACCOUNT_PAGE}-row page, so some accounts would be missing.`);
  return rows;
}

// GLTransactions: pull actual debit/credit history for a date range + account filter
// Key params: StartDate, EndDate, GLAccountID, PropertyID, pagesize
const GLTransactions      = (params) => get('/GLTransactions', params);

const ReportParameters    = (reportId, params) => get(`/Reports/${encodeURIComponent(reportId)}/ReportParameters`, params);
const RunReport           = (reportId, params) => get(`/Reports/${encodeURIComponent(reportId)}/RunReport`, params);

// ReportData: run a named RM report and get structured rows back.
// Used as a fallback if GL endpoints don't return enough detail.
// ReportName examples: 'ProfitAndLoss', 'GeneralLedger', 'BalanceSheet'
const ReportData          = (params) => get('/Reports/ReportData', params);

module.exports = {
  raw,
  isConfigured,
  authenticate,
  get,
  getRaw,
  Tenants,
  Properties,
  Units,
  UnitStatusTypes,
  Leases,
  ServiceManagerIssues,
  RecurringCharges,
  Charges,
  GLAccounts,
  GLTransactions,
  allGLAccounts,
  ReportParameters,
  RunReport,
  ReportData,
};
