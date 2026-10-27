// Which tools a request needs — the server half of per-person tool access.
//
// Hiding a tab in the browser is not access control: anyone can open the
// browser's console and call /api/budget. So every /api route is mapped here to
// the tools that use it, and the server refuses a request when the signed-in
// person has none of them (services/userStore.js holds who has what; server.js
// calls `decide` on every request).
//
// Some data is shared between tabs, and the rule is "any tool that reads it":
// the P&L feed serves Entities and Variances. Home ('overview') is open to every
// signed-in person and reads only the Home snapshot and public news, so it is
// not named on the data routes below.
//
// DENY BY DEFAULT. A route not listed below — a new endpoint, a probe, a debug
// tool — is admin-only until someone adds it here on purpose.
// scripts/checkAccessControl.js fails if server.js grows a route this file does
// not mention.

const OPEN = 'OPEN';     // reachable signed out (the login itself)
const ANY = 'ANY';       // any signed-in person
const ADMIN = 'ADMIN';   // admins only

// First match wins, so specific paths sit above their prefixes. `p` ending in
// '/' is a prefix; otherwise it matches the path exactly or as a prefix + '/'.
const RULES = [
  { p: '/api/auth/', need: OPEN },
  { p: '/api/admin/', need: ADMIN },
  { p: '/api/status', need: ANY },

  // Operational / diagnostic — never a tab's everyday data.
  { p: '/api/debug/', need: ADMIN },
  { p: '/api/rm-check', need: ADMIN },
  { p: '/api/rm/', need: ADMIN },
  { p: '/api/bank/', need: ADMIN },
  { p: '/api/payments/', need: ADMIN },
  { p: '/api/collections/', need: ADMIN },
  { p: '/api/financials/property-monthly/recompute', need: ADMIN },
  { p: '/api/renovations/api-scan', need: ADMIN },
  { p: '/api/renovations/attachment-write-probe', need: ADMIN },
  { p: '/api/renovations/attachment-write-test', need: ADMIN },

  // The refresh button on Issues (and the status it polls).
  { p: '/api/refresh/status', need: ['issues', 'entities'] },
  { p: '/api/refresh', need: ['issues', 'entities'] },

  // P&L — Overview, Entities, Variances.
  { p: '/api/financials/', need: ['entities', 'variances'] },
  // First-seen dates (2026-10-21) are Variances data like the rest of the prefix;
  // listed by name so the dashboard's "still open since" store is on the map.
  { p: '/api/variance/first-seen', need: ['variances'] },
  // The Rent Manager investigation behind each flag's PDF report (2026-10-22) reads
  // postings and bills, so it is named here rather than left to the prefix: a
  // Variances person gets it, nobody else does.
  { p: '/api/variance/investigate', need: ['variances'] },
  { p: '/api/variance/', need: ['variances'] },
  { p: '/api/live-overview', need: ['entities'] },
  { p: '/api/overview', need: ['entities'] },
  { p: '/api/entities', need: ['entities'] },
  { p: '/api/debt-service', need: ['entities'] },
  { p: '/api/vacancy-history', need: ['entities'] },
  { p: '/api/properties/breakdown', need: ['entities', 'renovations', 'underwriting'] },

  // Tenant-level data (names, balances) — Delinquency, and the Portfolio tile and
  // grades that read it (they were Overview's before Home became general).
  { p: '/api/delinquency', need: ['delinquency', 'entities'] },
  { p: '/api/tenants', need: ['delinquency', 'entities'] },

  { p: '/api/issues', need: ['issues'] },
  { p: '/api/supers', need: ['issues'] },
  { p: '/api/auto-assign/', need: ['issues'] },

  // Home is for every signed-in person (2026-10-22: userStore gives 'overview' to
  // everyone but an unvouched self sign-up), so what it reads is either public or a
  // coarse summary: market news is public rates and headlines, and the Home
  // snapshot holds grades, headlines and one chart, no raw feed. Posting needs a
  // tool that owns a section; the handler (services/homeSnapshot.js) keeps only
  // the sections that tool owns.
  { p: '/api/market-news', need: ['overview'] },
  { p: '/api/home-snapshot', need: ['overview'], post: ['entities', 'variances', 'delinquency', 'budget'] },
  { p: '/api/budget', need: ['budget'] },
  // Scorecard targets: read with the scorecard (Portfolio); saved under /api/admin/.
  { p: '/api/scorecard/', need: ['entities'] },
  { p: '/api/renovations', need: ['renovations'] },
  { p: '/api/underwriting/', need: ['underwriting'] },
  { p: '/api/analyze-contract', need: ['scanner'] },
  { p: '/api/contracts-history', need: ['scanner'] },

  // The Ask panel answers from the page snapshot the browser sends — data this
  // person's tools already let them see — so any signed-in person may ask.
  { p: '/api/assistant', need: ANY },
];

function ruleFor(pathname) {
  const p = String(pathname || '');
  for (const r of RULES) {
    if (r.p.endsWith('/') ? p.startsWith(r.p) : (p === r.p || p.startsWith(r.p + '/'))) return r;
  }
  return null;
}

// user: the public user ({ admin, tools }) or null.
// Returns { ok, status?, code?, reason? }.
function decide(user, method, pathname) {
  const p = String(pathname || '');
  if (!p.startsWith('/api/')) return { ok: true };                  // the page itself; data is what is guarded
  const rule = ruleFor(p);
  if (rule && rule.need === OPEN) return { ok: true };
  if (!user) return { ok: false, status: 401, code: 'AUTH_REQUIRED', reason: 'Sign in first.' };
  if (user.admin) return { ok: true };
  if (!rule || rule.need === ADMIN) return { ok: false, status: 403, code: 'ADMIN_ONLY', reason: 'Only an admin can use this.' };
  if (rule.need === ANY) return { ok: true };
  const tools = user.tools || [];
  // A write to a route Home reads still needs one of the tools that own its data.
  if (rule.post && method !== 'GET' && method !== 'HEAD' && !rule.post.some(t => tools.includes(t))) {
    return { ok: false, status: 403, code: 'TOOL_FORBIDDEN', reason: 'Your account does not include this tool. Ask an admin for access.' };
  }
  if (rule.need.some(t => tools.includes(t))) return { ok: true };
  return { ok: false, status: 403, code: 'TOOL_FORBIDDEN', reason: 'Your account does not include this tool. Ask an admin for access.' };
}

module.exports = { RULES, ruleFor, decide, OPEN, ANY, ADMIN };
