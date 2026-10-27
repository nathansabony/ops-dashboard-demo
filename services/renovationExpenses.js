// Non-operating (renovation) expense detail — the tool that replaces a manual
// Rent Manager walkthrough.
//
// What it replaces, step by step: someone logs into RM, opens a property's
// unit-level P&L, drills into the non-operating expense categories, opens each
// individual charge, and pulls the backup document (invoice PDF, or the credit
// card statement charge when it was paid on a card) to send to ownership. That is
// four levels of clicking per invoice, repeated per unit, per property.
//
// This service builds the first three levels — property → unit → category →
// individual charge — as one cached snapshot. The fourth level (the backup
// document itself) is per-charge and lives in services/rmDocuments.js, because
// whether RM's API exposes it at all is the one open question the brief flagged.
//
// ── Where the numbers come from ─────────────────────────────────────────────
// Report 51 "GeneralLedger" with IsSummary=False, the same report the Variance
// tab's drill-down uses (services/glTransactions.js). It returns one row per
// posting: date, transaction type, vendor, description, debit, credit. Basis is
// Accrual (2), which is what makes "include accrued charges, not just paid ones"
// true — a bill entered but not yet paid is already in the accrual GL.
//
// ── Why it runs per property rather than portfolio-wide ─────────────────────
// Report 51 rows carry PropertyShortName, not a PropertyID, so a single
// portfolio-wide run has to attribute every posting by matching a name string.
// Running it per property makes attribution exact — the filter IS the answer.
//
// That would be ~89 report runs if we ran it for every property. We don't: the
// monthly P&L snapshot (services/propertyFinancials.js) already carries
// `renCapital` per property per month, so we know before spending a single call
// WHICH properties had renovation spend in the window, and pull only those. On a
// portfolio where renovations are concentrated in a handful of buildings that is
// a handful of runs, and it gives us a free cross-check: the postings we pull for
// a property have to sum to the same number the P&L reports for it.
//
// If the P&L snapshot hasn't been built yet there is no shortlist to work from,
// so we fall back to one portfolio-wide run with name-matched attribution and say
// so in `sources.mode` — degraded, but honest and still useful.

const rentManager = require('./rentManagerClient');
const propertyFinancials = require('./propertyFinancials');
const { buildPropertyEntityMap } = require('./entityMap');
const { makeSnapshotCache } = require('./snapshotCache');
const rmDocuments = require('./rmDocuments');

const REPORT_ID = 51;        // GeneralLedger, IsSummary=False
const BASIS_ACCRUAL = 1;     // 1 = Accrual (2 is Cash); matches propertyFinancials so the detail ties to the totals

// ── What counts as "non-operating renovation" ───────────────────────────────
// GL reference 6100 is "Total REN - Capital Expense" — the renovation bucket the
// rest of this codebase already keys off (propertyFinancials.CATEGORY_REFS
// .renCapital, varianceConfig's `renCapital` line). Children (6100-1, 6100-2, …)
// are the individual categories that open up when she clicks the bucket in RM,
// and they are exactly the level this tab needs, so we resolve refs to accounts
// INCLUDING children rather than taking the parent's total row.
//
// Mortgage interest (6230) is non-operating but is not a renovation charge, so it
// is not in the default set.
//
// 2026-08-25 (the owner, in the renovation demo): MAJOR EXPENSES join the set —
// "add major expense accounts alongside renovation accounts". A boiler, a roof or
// an elevator is the same question ownership is asking ("what did the money buy at
// this building?") and it was the one large category the tab could not answer for.
// 5150 is "Total Major - Repair & Maint", the same reference the P&L pipeline and
// the variance model already key off (propertyFinancials.CATEGORY_REFS.majRepairs,
// varianceConfig's `majRepairs` line), so the three agree by construction.
//
// EXTERMINATING IS EXCLUDED, by the client's own direction in that meeting. It is
// recurring pest control, not a capital event. The exclusion is a list rather than
// an absence because these accounts are matched by hierarchy and by NAME as well as
// by reference (see matchRefs) — leaving an account out of the roots does not keep
// it out of the set, so an account that must not appear has to say so.
//
// LICENSES were asked for in the same breath and are NOT here, deliberately: the
// reference number was not confirmed in the meeting and this tab should not guess
// at a GL account. Accounts whose names read like licences or permits are surfaced
// as CANDIDATES (see resolveAccounts and the panel at the foot of the tab), so
// adding the confirmed one is a config change, not a code change.
//
// This is a default, not a decree. The brief's second open item is "confirm the
// exact GL codes/category tags that map to non-operating expenses" — so the roots
// are overridable with RENOVATION_GL_REFS, and every build also reports the
// accounts it did NOT include but that look like they might belong
// (`accountCandidates`), which is what makes that confirmation a five-second job
// on the tab instead of a call with accounting.
const DEFAULT_REF_ROOTS = ['6100', '5150'];

// References that must never end up in the set, however they were matched.
// 5031 is Exterminating — recurring pest control, excluded by the client.
const DEFAULT_EXCLUDED_ROOTS = ['5031'];

// ── Matching by NAME, because this chart of accounts is flat ─────────────────
// 2026-08-26. Rooting majors at 5150 was wrong, and the screenshot of the "not
// included" panel is what showed it: the major accounts are not children of 5150,
// they are SIBLINGS of it —
//
//   5150 Major - Repair & Maint   5151 Major - Electric   5152 Major - Windows
//   5153 Major - Elevator repair  5155 Major - Cleaning   5156 Major- Turnover
//   5158 Major - Plumbing         5160 Major - Painting   5161 Major - Boiler expense
//   5164 Major - Sidewalk Repair  5165 Major - Low Voltage 5168 Major - Flooring
//   5172 Major - Roof repair      5175 Major - Garbage removal
//   5220 Major - Material & Supplies … 5225 Major - Kitchen Cabinets
//
// A reference root only reaches an account that IS the root, hangs off it by a
// dash suffix, or is linked to it as a child in RM. None of those are true here,
// so 5150 pulled in exactly one account out of twenty and the other nineteen sat
// in the candidates list.
//
// What actually groups them is the NAME. "Major - …" is the convention the chart
// is organised by, and it is also the convention that will carry the next major
// account somebody adds — which a hand-typed list of twenty numbers would not.
// So a name pattern is a first-class way to define the set, not a fallback.
const DEFAULT_NAME_PATTERNS = ['^\\s*major\\b'];

// Excluding by name for the same reason: "exclude exterminating" was the client's
// instruction, and it should hold whatever number that account carries — including
// a "Major - Exterminating" that would otherwise be swept in by the pattern above.
const DEFAULT_EXCLUDED_NAMES = ['extermin'];

function csvEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback.slice();
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function refRoots() { return csvEnv('RENOVATION_GL_REFS', DEFAULT_REF_ROOTS); }
function excludedRoots() { return csvEnv('RENOVATION_EXCLUDE_GL_REFS', DEFAULT_EXCLUDED_ROOTS); }
function namePatterns() { return csvEnv('RENOVATION_GL_NAME_PATTERNS', DEFAULT_NAME_PATTERNS); }
function excludedNames() { return csvEnv('RENOVATION_EXCLUDE_NAME_PATTERNS', DEFAULT_EXCLUDED_NAMES); }

// A pattern that does not compile must not take the whole tab down with it — a bad
// override in an env var is a typo, not a reason to serve nothing.
function toRegexes(patterns) {
  const out = [];
  for (const p of patterns) {
    try { out.push(new RegExp(p, 'i')); } catch { /* skip an unparseable pattern */ }
  }
  return out;
}
function matchesAny(text, regexes) {
  const t = String(text || '');
  return regexes.some(re => re.test(t));
}

// An account is excluded when it IS an excluded reference, hangs beneath one, or
// its name matches an exclusion pattern.
function isExcludedRef(ref, roots) {
  const r = String(ref || '');
  return roots.some(x => r === x || r.startsWith(`${x}-`));
}
function isExcludedAccount(account, roots, nameRes) {
  return isExcludedRef(account.ref, roots) || matchesAny(account.name, nameRes);
}

// How far back the snapshot reaches. The date-range selector on the tab slices
// INSIDE this window — it never triggers a Rent Manager call of its own, which is
// what keeps the tab inside the site's cached-data contract. Two years covers
// "this year vs last year" comparisons, which is what ownership asks for.
const WINDOW_MONTHS = Number(process.env.RENOVATION_WINDOW_MONTHS || 24);

// ── small shared helpers (same shapes the other RM services use) ────────────
function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const grids = Object.entries(payload)
    .filter(([k, v]) => /^Grid\d+$/i.test(k) && Array.isArray(v))
    .flatMap(([, v]) => v);
  if (grids.length) return grids;
  return payload.Results || payload.Items || payload.Data || [];
}

// The one RM figure parser (services/rmAmount.js). This file's own copy was the
// CORRECT one — accounting parentheses and all — but three other services carried
// weaker versions that silently zeroed a credit, so the copies are gone and there
// is one implementation to be right or wrong.
const { parseAmount: num } = require('./rmAmount');

function pick(row, names) {
  for (const n of names) {
    if (row[n] != null && row[n] !== '') return row[n];
  }
  return null;
}

function ym(dateStr) {
  return String(dateStr || '').slice(0, 7);
}

function lastDayOfMonth(year, m1) { return new Date(year, m1, 0).getDate(); }

// The snapshot's date window: the first day of the month WINDOW_MONTHS back
// through the last day of the current month (the current month is deliberately
// included — a renovation invoice entered this morning is the one she is most
// likely to be asked about).
function defaultWindow(now = new Date()) {
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = new Date(end.getFullYear(), end.getMonth() - (WINDOW_MONTHS - 1), 1);
  const ty = end.getFullYear();
  const tm = end.getMonth() + 1;
  return {
    from: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`,
    to: `${ty}-${String(tm).padStart(2, '0')}-${String(lastDayOfMonth(ty, tm)).padStart(2, '0')}`,
  };
}

// ── GL account resolution ───────────────────────────────────────────────────
// Resolve the configured refs to real account ids, and — separately — collect the
// accounts that LOOK like renovation/non-operating but aren't in the set, so the
// tab can show "here is what I included, here is what I didn't, tell me if I'm
// wrong". Cached for an hour: a chart of accounts changes roughly never.
let _acctCache = null;
const ACCT_TTL_MS = 60 * 60 * 1000;

// Names that read like renovation or capital spend. `licen` / `permit` are here
// for the 2026-08-25 ask: licences were wanted in the set but their reference was
// never confirmed, so the tab's job is to put the actual accounts in front of
// somebody who can confirm them rather than to guess. `major` likewise surfaces
// any major-repair account that does not hang off 5150.
const CANDIDATE_NAME_RE = /\bren\b|renovat|rehab|capital\s*expen|\bcapex\b|construction|turn\s*key|\bmajor\b|licen[cs]|permit/i;

// ── Vendor cost vs in-house payroll ─────────────────────────────────────────
// The renovation bucket on this chart of accounts holds two different kinds of
// money: what was paid to vendors (materials, trades, equipment) and what the
// company's own crew cost while doing the work — wages, payroll taxes, workers
// comp — capitalised into the job.
//
// Both are genuinely renovation spend and both belong in the total. But they are
// not interchangeable when someone asks "what did the renovation cost, and can I
// see the invoices": a payroll line has no vendor and no invoice, and can never
// have one. Reporting them as one number means either the invoice count looks
// broken, or an owner is shown a "renovation invoices" figure that silently
// includes salaries.
//
// Classification is by ACCOUNT, not by charge text, and prefers the account's
// group: if the parent of a group is "REN - Payroll Expenses", everything under it
// is payroll regardless of how the individual child is named. RENOVATION_PAYROLL_REFS
// overrides the whole thing with explicit references when the naming is unhelpful.
const PAYROLL_NAME_RE = /payroll|salar|\bwages?\b|workers?\s*comp|\blabou?r\b/i;

function payrollRefOverrides() {
  const raw = String(process.env.RENOVATION_PAYROLL_REFS || '').trim();
  if (!raw) return null;
  return raw.split(',').map(x => x.trim()).filter(Boolean);
}

// Tag every resolved account 'payroll' or 'vendor'. Mutates in place and returns
// the list, so callers can keep treating it as the account set it already was.
function classifyCostType(accounts) {
  const overrides = payrollRefOverrides();
  const groupOf = ref => String(ref).split('-')[0];

  // Group heads, so a child inherits its parent's kind.
  const headName = new Map();
  for (const a of accounts) {
    if (String(a.ref) === groupOf(a.ref)) headName.set(groupOf(a.ref), a.name);
  }

  for (const a of accounts) {
    if (overrides) {
      a.costType = overrides.some(r => a.ref === r || String(a.ref).startsWith(`${r}-`)) ? 'payroll' : 'vendor';
      continue;
    }
    const head = headName.get(groupOf(a.ref)) || '';
    a.costType = (PAYROLL_NAME_RE.test(a.name) || PAYROLL_NAME_RE.test(head)) ? 'payroll' : 'vendor';
  }
  return accounts;
}

function accountType(a) {
  return String(pick(a, ['GLAccountTypeName', 'AccountTypeName', 'AccountType', 'GLAccountType']) || '').trim();
}

// Field names Rent Manager might use to link a sub-account to its parent. The
// chart of accounts is a tree and RM does expose the linkage, but the field name
// is not consistent across WAPI builds, so we look for any of them.
const PARENT_FIELDS = ['ParentGLAccountID', 'ParentGLAccountId', 'ParentID', 'ParentId',
  'ParentAccountID', 'ParentAccountId', 'GLAccountParentID'];

async function loadAccounts() {
  if (_acctCache && Date.now() - _acctCache.at < ACCT_TTL_MS) return _acctCache;
  const rows = asRows(await rentManager.allGLAccounts());
  const all = rows
    .map(a => ({
      id: a.GLAccountID,
      name: a.Name || '',
      ref: String(a.Reference || '').trim(),
      type: accountType(a),
      parentId: pick(a, PARENT_FIELDS),
    }))
    .filter(a => a.id != null && a.ref);
  _acctCache = { at: Date.now(), all };
  return _acctCache;
}

// ── Resolving a roll-up account to the accounts that actually carry postings ──
//
// This got the first live pull wrong, so it is worth being explicit about why.
//
// GL 6100 is named "Total REN - Capital Expense" and that "Total" is literal: it
// is a ROLL-UP. The monthly P&L reads its subtotal row, which includes everything
// beneath it — but nothing is posted to 6100 itself. Filtering the transaction
// report to 6100 therefore returns a begin/end balance pair per property and not
// one single invoice, which is exactly what happened: 194 rows across 97
// properties, zero postings, and every property reported as "does not tie".
//
// The first version assumed children would be numbered `6100-1`, `6100-2` (they
// are in some Rent Manager charts). On this instance they are not. So resolution
// now works in three widening tiers, and every account records WHICH tier found
// it so the accounts panel can show its work:
//
//   ref       — the root itself, and any `<root>-N` style children
//   hierarchy — anything RM links to the root as a parent, at any depth
//   name      — last resort: same account type, name reading as renovation spend
//
// The name tier only engages when the tiers above found nothing but the root,
// because a roll-up with no reachable children is otherwise a dead end — and a
// tab that shows $0 while the P&L shows millions is worse than one that includes
// a slightly wide account set and shows you exactly what it included.
function matchRefs(all, roots, nameRes = []) {
  const byId = new Map(all.map(a => [String(a.id), a]));
  const out = new Map();
  const add = (a, matchedBy) => {
    if (!out.has(a.id)) out.set(a.id, { ...a, matchedBy });
  };

  // Tier 1 — the reference itself and dash-suffixed children.
  const rootAccounts = [];
  for (const root of roots) {
    for (const a of all) {
      if (a.ref === root) { rootAccounts.push(a); add(a, 'ref'); }
      else if (a.ref.startsWith(`${root}-`)) add(a, 'ref');
    }
  }

  // Tier 2 — walk RM's own parent linkage down from each root, at any depth.
  const childrenOf = new Map();
  for (const a of all) {
    if (a.parentId == null) continue;
    const key = String(a.parentId);
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(a);
  }
  const queue = rootAccounts.slice();
  const walked = new Set(rootAccounts.map(a => String(a.id)));
  while (queue.length) {
    const node = queue.shift();
    for (const child of childrenOf.get(String(node.id)) || []) {
      if (walked.has(String(child.id))) continue;   // a cycle would otherwise hang the build
      walked.add(String(child.id));
      add(child, 'hierarchy');
      queue.push(child);
    }
  }

  // Tier 2b — accounts named as part of the set (2026-08-26). Not a fallback: on a
  // flat chart of accounts the NAME is the grouping, so this runs every time, and
  // it is what brings in "Major - Electric", "Major - Roof repair" and the other
  // eighteen siblings that no reference root could reach.
  for (const a of all) {
    if (out.has(a.id)) continue;
    if (matchesAny(a.name, nameRes)) add(a, 'name-pattern');
  }

  // Tier 3 — nothing but the roll-up itself. Fall back to the accounts that share
  // its type and read as renovation spend.
  const foundBeyondRoot = [...out.values()].some(a => !rootAccounts.some(r => r.id === a.id));
  if (!foundBeyondRoot && rootAccounts.length) {
    const rootTypes = new Set(rootAccounts.map(r => r.type.toLowerCase()).filter(Boolean));
    for (const a of all) {
      if (out.has(a.id)) continue;
      const sameType = rootTypes.size === 0 || rootTypes.has(a.type.toLowerCase());
      if (sameType && CANDIDATE_NAME_RE.test(a.name)) add(a, 'name');
    }
  }

  return [...out.values()].sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}

async function resolveAccounts() {
  const roots = refRoots();
  const excluded = excludedRoots();
  const nameRes = toRegexes(namePatterns());
  const excludedNameRes = toRegexes(excludedNames());
  const { all } = await loadAccounts();
  // The exclusion is applied AFTER matching, not by leaving a root out: matchRefs
  // reaches accounts by reference, by RM's parent linkage AND by name, so an
  // account can arrive by a route the roots never named.
  const included = classifyCostType(matchRefs(all, roots, nameRes))
    .filter(a => !isExcludedAccount(a, excluded, excludedNameRes));
  const includedIds = new Set(included.map(a => a.id));

  // Anything outside the set whose name or type reads like renovation spend.
  // Deliberately generous — this list exists to be looked at and dismissed, and a
  // candidate that never appears is a mapping error nobody can catch. (It is also
  // where the twenty "Major - …" accounts sat until 2026-08-26, which is exactly
  // the job this list is for: it showed the mapping was wrong.)
  const candidates = all
    .filter(a => !includedIds.has(a.id))
    .filter(a => !isExcludedAccount(a, excluded, excludedNameRes))   // deliberately out — not a suggestion
    .filter(a => CANDIDATE_NAME_RE.test(a.name) || /n\/o|non.?operat/i.test(a.type))
    .map(a => ({
      ...a,
      why: /licen[cs]|permit/i.test(a.name) ? 'a licence / permit account — asked for on 2026-08-25, reference never confirmed'
        : (CANDIDATE_NAME_RE.test(a.name) ? 'name looks like renovation or major spend' : 'non-operating account type'),
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));

  return { roots, excluded, namePatterns: namePatterns(), excludedNames: excludedNames(), included, candidates, chartSize: all.length };
}

// ── Unit index ──────────────────────────────────────────────────────────────
// Report 51 is a GL report, so a posting's unit — if it carries one at all — is
// whatever RM chose to put in the row. To turn that into a real unit we need the
// property's own unit list, which also gives us the fallback: matching a unit name
// out of the charge description ("2R — kitchen cabinets"). One paged /Units sweep,
// the same call unitCounts.js makes.
const UNIT_PAGE_SIZE = 1000;
const UNIT_MAX_PAGES = 50;

async function loadUnitIndex() {
  const byProperty = new Map();   // propertyId → [{ id, name }]
  const byId = new Map();         // unitId → { id, name, propertyId }
  for (let page = 1; page <= UNIT_MAX_PAGES; page++) {
    const rows = asRows(await rentManager.Units({
      pageSize: UNIT_PAGE_SIZE,
      pageNumber: page,
      fields: 'UnitID,PropertyID,Name',
    }));
    for (const u of rows) {
      const pid = Number(u.PropertyID ?? u.PropertyId);
      const id = u.UnitID ?? u.UnitId;
      const name = String(u.Name || '').trim();
      if (!Number.isFinite(pid) || id == null || !name) continue;
      const rec = { id, name, propertyId: pid };
      byId.set(String(id), rec);
      if (!byProperty.has(pid)) byProperty.set(pid, []);
      byProperty.get(pid).push(rec);
    }
    if (rows.length < UNIT_PAGE_SIZE) break;
  }
  return { byProperty, byId };
}

// Unit names are short and collide with ordinary words ("A", "1", "REAR"), so a
// description match has to be anchored. We only accept a unit name that appears
// either after a unit-ish keyword ("Unit 3B", "Apt 2R", "#4C") or as its own token
// when it is at least two characters and contains a digit — which is what real
// unit labels look like and what stray prose does not.
const UNIT_KEYWORD_RE = /(?:unit|apt\.?|apartment|suite|ste\.?|#)\s*([A-Za-z0-9][A-Za-z0-9\-]{0,7})\b/i;

// Returns { unit, candidates, via } rather than just a unit, because HOW MANY
// units the description could plausibly mean is the thing that decides whether the
// guess is safe. "Cabinets for 2R" has one candidate and is as good as fact.
// "Cabinets 2R, offcuts to 3B" has two, and picking the first one silently is how
// a wrong unit ends up on an owner's report. The count travels with the charge so
// the ambiguous ones can be listed and checked instead of averaged in.
function inferUnitDetailed(text, unitsForProperty) {
  const s = String(text || '');
  if (!s || !unitsForProperty || !unitsForProperty.length) return { unit: null, candidates: [], via: null };

  const matches = [];
  const seen = new Set();
  const push = (u, via) => {
    if (!u || seen.has(u.name)) return;
    seen.add(u.name);
    matches.push({ unit: u, via });
  };

  // A keyword-anchored mention ("Unit 3B", "Apt 2R", "#4C") is the strongest
  // signal, so it is collected first and wins the pick.
  const byName = new Map(unitsForProperty.map(u => [u.name.toUpperCase(), u]));
  const kwRe = new RegExp(UNIT_KEYWORD_RE.source, 'gi');
  let kw;
  while ((kw = kwRe.exec(s)) !== null) push(byName.get(kw[1].toUpperCase()), 'keyword');

  // Bare token match, restricted to unit labels distinctive enough to be safe.
  for (const u of unitsForProperty) {
    if (u.name.length < 2 || !/\d/.test(u.name)) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9])${u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i');
    if (re.test(s)) push(u, 'token');
  }

  if (!matches.length) return { unit: null, candidates: [], via: null };
  return {
    unit: matches[0].unit,
    via: matches[0].via,
    candidates: matches.map(m => m.unit.name),
  };
}

// Back-compat wrapper — most callers only want the unit.
function inferUnit(text, unitsForProperty) {
  return inferUnitDetailed(text, unitsForProperty).unit;
}

// ── Report 51 ───────────────────────────────────────────────────────────────
async function runGeneralLedger({ propOwnerIds, glAccountIds, startDate, endDate }) {
  const p = {
    StartDate: startDate,
    EndDate: endDate,
    PropOwnerIDs: String(propOwnerIds),
    GLAccountIDs: glAccountIds.join(','),
    Basis: String(BASIS_ACCRUAL),
    IsSummary: 'False',
    SHOWINACTIVEPROPS: 'False',
    GroupID: '0',
    INCLUDEINACTIVEOWNERS: 'False',
    RUNBYOWNER: 'False',
    CHARTMAPID: '0',
    CombineReceivableTypes: 'False',
    UNITID: '-1',
    SHOWDEPOSITBREAKDOWN: 'False',
    ZeroAmountExclusion: '1',
    BatchPropsOrUnits: '',
    RestrictByOwnerContractDates: 'false',
    ExcludePeriodAdjustments: 'False',
    StartPeriodID: '0',
    EndPeriodID: '0',
    RunByPeriod: 'false',
  };
  const params = {};
  Object.keys(p).forEach((id, i) => {
    params[`parameters[${i}].Parameter`] = id;
    params[`parameters[${i}].Value`] = p[id];
    params[`parameters[${i}].InListItemMode`] = 'false';
  });
  return asRows(await rentManager.RunReport(REPORT_ID, params));
}

// RM appends per-account summary rows (BeginBalance/EndBalance, no date) and, for
// an account with nothing in the window, a placeholder dated 0001-01-01 reading
// "No activity in the period". Neither is a posting.
function isPosting(r) {
  const d = String(r.TransactionDate || '');
  if (!d || d.startsWith('0001-01-01')) return false;
  return num(r.Debit) !== 0 || num(r.Credit) !== 0;
}

// A stable identity for one charge, so the frontend can ask for its backup
// document without us having to hold server-side state between the two calls.
// Built from the fields that identify a posting in RM rather than from an array
// index, which would shift the moment the snapshot is rebuilt.
function chargeId(p) {
  const parts = [p.propertyId, p.date, p.accountId, p.reference, p.amount.toFixed(2), p.description];
  return Buffer.from(parts.join('|')).toString('base64url').slice(0, 64);
}

// ── Posting → charge ────────────────────────────────────────────────────────
let _lastRowFields = null;

// "Tubs Refinishing Services Inc.: 100134" → "100134".
//
// RM writes the vendor's own invoice number after the payee name, and that string
// is the bill's Reference. Only the tail after the last colon is taken, and only
// when it looks like a reference rather than prose — a description that is a
// sentence must not produce a filter that quietly matches nothing.
function invoiceNumberFrom(description) {
  const at = String(description || '').lastIndexOf(':');
  if (at < 0) return null;
  const tail = String(description).slice(at + 1).trim();
  if (!tail || tail.length > 24) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{2,}$/.test(tail) ? tail : null;
}

function toCharge(row, ctx) {
  if (!_lastRowFields && row && typeof row === 'object') _lastRowFields = Object.keys(row);
  const debit = num(row.Debit);
  const credit = num(row.Credit);
  const description = String(pick(row, ['Description', 'Memo', 'Comment']) || '');
  const reference = String(pick(row, ['TransactionReference', 'Reference', 'CheckNumber']) || '');
  const type = String(pick(row, ['TransactionType', 'Type']) || '');

  // A unit RM reported on the row, if this instance puts one there at all. Field
  // names vary between report builds, so we look for any of them rather than
  // betting on one — and record WHICH path found it, because a unit we inferred
  // from free text is a different kind of fact from one RM stated.
  const reportedUnitId = pick(row, ['UnitID', 'UnitId']);
  const reportedUnitName = pick(row, ['UnitName', 'UnitNumber', 'Unit', 'UnitShortName']);
  const unitsHere = ctx.unitsByProperty.get(ctx.propertyId) || [];

  let unit = null;
  let unitSource = 'none';
  let unitCandidates = [];
  if (reportedUnitId != null && ctx.unitsById.has(String(reportedUnitId))) {
    unit = ctx.unitsById.get(String(reportedUnitId));
    unitSource = 'reported';
  } else if (reportedUnitName) {
    const hit = unitsHere.find(u => u.name.toUpperCase() === String(reportedUnitName).trim().toUpperCase());
    unit = hit || { id: null, name: String(reportedUnitName).trim(), propertyId: ctx.propertyId };
    unitSource = 'reported';
  } else {
    const guess = inferUnitDetailed(`${description} ${reference}`, unitsHere);
    if (guess.unit) {
      unit = guess.unit;
      unitSource = 'inferred';
      unitCandidates = guess.candidates;
    }
  }

  // The two things that turn "find an invoice by date and amount" into "fetch the
  // invoice", both sitting on the report row and both previously discarded:
  //
  //   CustomerID  11501         the VENDOR (a check on it reads AccountType:
  //                             "Vendor"), so a bill filter by AccountID returns
  //                             that vendor's invoices instead of a fortnight of
  //                             everybody's.
  //   Hyperlink   "11:158810"   type code and transaction id — the posting's own
  //                             record, no matching required.
  //
  // And the invoice number is in the description: RM writes "Tubs Refinishing
  // Services Inc.: 100134", where 100134 is the bill's Reference. Vendor plus
  // reference identifies one bill exactly.
  const hyperlink = String(pick(row, ['Hyperlink']) || '');
  const txnId = hyperlink.includes(':') ? hyperlink.split(':')[1] : null;

  const charge = {
    date: String(row.TransactionDate || '').slice(0, 10),
    vendorId: pick(row, ['CustomerID', 'CustomerId', 'VendorID', 'VendorId']),
    txnId,
    txnType: String(pick(row, ['TransactionType']) || ''),
    invoiceNo: invoiceNumberFrom(description),
    month: ym(row.TransactionDate),
    propertyId: ctx.propertyId,
    propertyName: ctx.propertyName,
    entity: ctx.entity,
    unitId: unit ? unit.id : null,
    unitName: unit ? unit.name : null,
    unitSource,
    // More than one unit named in the description → the guess picked one of
    // several. Listed so it can be checked rather than trusted.
    unitAmbiguous: unitCandidates.length > 1,
    unitCandidates: unitCandidates.length > 1 ? unitCandidates : undefined,
    accountId: row.GLAccountID != null ? row.GLAccountID : null,
    accountRef: ctx.refByAccountId.get(String(row.GLAccountID)) || '',
    // 'vendor' — paid to someone outside, has a bill. 'payroll' — the company's
    // own crew, capitalised into the job, and never has one.
    costType: (ctx.costTypeByAccountId && ctx.costTypeByAccountId.get(String(row.GLAccountID))) || 'vendor',
    accountName: String(row.GLAccountName || '').trim(),
    type,
    reference,
    description,
    vendor: String(pick(row, ['CustomerName', 'VendorName', 'PayeeName']) || '').trim(),
    debit,
    credit,
    // Signed: a debit is spend, a credit is money coming back (a return, a
    // reclass). The tab ranks by this so credits read as negatives.
    amount: debit - credit,
  };
  charge.id = chargeId(charge);
  return charge;
}

// Which P&L snapshot series correspond to the GL roots this tab is built from.
// Derived from propertyFinancials.CATEGORY_REFS rather than hardcoded, so adding a
// root (majors did exactly this on 2026-08-25) automatically brings its P&L series
// with it. Get this wrong and two things break at once: the shortlist skips every
// property whose spend is on the new root, and the cross-check compares a detail
// total that includes it against a P&L total that does not — reporting "does not
// tie" on properties whose books are fine.
// Which of the accounts we PULL can the P&L side actually contain?
//
// This matters the moment the set is defined by name rather than by reference
// (2026-08-26). The P&L pipeline reads categories by GL reference —
// propertyFinancials.CATEGORY_REFS.majRepairs is ['5150'] — so on a flat chart it
// carries 5150 and nothing else, while the detail here now carries every
// "Major - …" account. Comparing those two would report a difference on every
// property with major spend, and it would not be a difference in the books: it is
// the two sides counting different accounts.
//
// So the comparison says so instead. The accounts named here are also the exact
// list to add to CATEGORY_REFS once someone confirms whether RM's own P&L nests
// them under 5150 (in which case the P&L line is already right and adding them
// would double count) or prints them as separate lines (in which case the variance
// tab's Major Repairs line is carrying one account out of twenty).
function accountsOutsidePl(included, roots, blockMembers) {
  const refs = propertyFinancials.CATEGORY_REFS || {};
  const { keys } = plCategoriesForRoots(roots);
  const covered = [];
  for (const k of keys) (refs[k] || []).forEach(r => covered.push(String(r)));
  // The nesting answer, 2026-08-26. The question above — does RM's P&L nest these
  // under 5150, or print them as separate lines? — is settled, and it nests them:
  //
  //   139 H  5150  Major - Repair & Maint
  //   140     5121  Violations Fees
  //   141 H  5220  Major - Material & Supplies …  146 T 5220 Total  29,560
  //   147     5151  Major - Electric   … 154  5156 Major- Turnover
  //   155     5150  Other Major - Repair & Maint  77,983
  //   156 T  5150  Total Major - Repair & Maint  311,784
  //
  // and the children sum to 311,785 — the total to the dollar. propertyFinancials'
  // valueForRef prefers a ref's IsTotal row, so majRepairs:['5150'] has been
  // reading that roll-up all along. Every "Major - …" account this tab pulls is
  // already inside the P&L line it is compared against.
  //
  // So the old test — is the account's own ref one of CATEGORY_REFS, or a `5150-x`
  // child of one — was asking the wrong question. These are siblings by number
  // (5151, 5220, 5119-1) and children only by POSITION in the report, which is
  // exactly what blockMembers carries. Without it we cannot show the nesting holds,
  // and the honest answer stays "not comparable" rather than a tie-out nobody
  // verified.
  const inBlock = (ref) => !!(blockMembers && covered.some(c => (blockMembers[c] || []).includes(String(ref))));
  return included
    .filter(a => !covered.some(c => a.ref === c || String(a.ref).startsWith(`${c}-`)) && !inBlock(a.ref))
    .map(a => ({ ref: a.ref, name: a.name }));
}

function plCategoriesForRoots(roots) {
  const refs = propertyFinancials.CATEGORY_REFS || {};
  const keys = [];
  const unmapped = [];
  for (const root of roots) {
    const key = Object.keys(refs).find(k => (refs[k] || []).includes(root));
    if (key) keys.push(key);
    else unmapped.push(root);
  }
  return { keys: [...new Set(keys)], unmapped };
}

// ── A charge that names two units belongs to both ───────────────────────────
// The owner, 2026-08-26: *"where the units could go either way, where it mentions two
// units, maybe just put the cost between the units."*
//
// He is right, and it is a better answer than the one it replaces. "Shloimy
// Tessler: THE HOME DEPOT #8475 — 06.15.26" filed under 06 while naming 06 and 15
// is not a guess that needs checking; it is one receipt covering two units. Picking
// one and flagging it produced 1,131 rows for somebody to work through, and the
// honest reading of every one of them was "half each".
//
// So an ambiguous charge becomes one row per unit at its share of the money. The
// property total does not move — the split is exact to the cent, with any odd cent
// going to the first piece — so nothing downstream that sums charges changes. What
// changes is that a unit's number now includes its share instead of all or nothing.
function splitAcrossUnits(charge, unitsHere) {
  const names = charge.unitCandidates || [];
  if (!charge.unitAmbiguous || names.length < 2) return [charge];

  const cents = Math.round(Math.abs(charge.amount) * 100);
  const sign = charge.amount < 0 ? -1 : 1;
  const base = Math.floor(cents / names.length);
  const extra = cents - base * names.length;   // the odd cents, given to the first pieces

  return names.map((name, i) => {
    const share = (base + (i < extra ? 1 : 0)) / 100 * sign;
    const known = (unitsHere || []).find(u => u.name.toUpperCase() === String(name).toUpperCase());
    const piece = {
      ...charge,
      unitId: known ? known.id : null,
      unitName: name,
      unitSource: 'split',
      amount: Math.round(share * 100) / 100,
      // The flag is gone: this is not an unresolved guess any more, it is a
      // deliberate allocation. `unitSplit` says so, and carries what it was split
      // with so the row can explain itself without the reader opening anything.
      unitAmbiguous: false,
      unitCandidates: undefined,
      unitSplit: { of: charge.amount, ways: names.length, withUnits: names },
    };
    piece.id = `${charge.id}~${String(name).replace(/\s+/g, '')}`;
    return piece;
  });
}

// ── Which properties to pull ────────────────────────────────────────────────
// The P&L snapshot's per-property series for this tab's GL roots (renCapital for
// 6100, majRepairs for 5150, …), sliced to the window, tells us where the dollars
// are before we spend a call. Returns null when there is no snapshot to read,
// which is the signal to fall back to one portfolio-wide run.
function propertiesWithSpend(fromYM, toYM) {
  const snap = propertyFinancials.loadSnapshot();
  const data = snap && snap.data ? snap.data : snap;
  if (!data || !data.properties || !Array.isArray(data.months)) return null;

  // The P&L snapshot labels months 'Jan 26'; turn those into 'YYYY-MM' so they can
  // be compared with the window.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthKeys = data.months.map(label => {
    const m = /^([A-Za-z]{3})\s+(\d{2})$/.exec(String(label).trim());
    if (!m) return null;
    const idx = MON.findIndex(x => x.toLowerCase() === m[1].toLowerCase());
    if (idx < 0) return null;
    return `20${m[2]}-${String(idx + 1).padStart(2, '0')}`;
  });

  const inWindow = monthKeys.map(k => k != null && k >= fromYM && k <= toYM);
  const { keys: plKeys, unmapped } = plCategoriesForRoots(refRoots());
  const out = new Map();  // propertyId → expected total from the P&L
  for (const [pid, p] of Object.entries(data.properties)) {
    let total = 0;
    for (const key of plKeys) {
      const series = p[key] || [];
      for (let i = 0; i < series.length; i++) if (inWindow[i]) total += series[i] || 0;
    }
    if (Math.abs(total) >= 1) out.set(Number(pid), total);
  }
  // The months the P&L actually contributed. The two windows are NOT the same:
  // this tab pulls 24 months, the P&L snapshot starts at December two years back
  // (~21). Comparing a 24-month detail total against a 21-month P&L total made
  // every property with older renovation spend look like it didn't tie — a
  // difference invented by the comparison, not found in the books. The cross-check
  // now runs over this overlap only.
  const coveredMonths = monthKeys.filter((k, i) => inWindow[i]);
  // A root with no P&L series behind it (a custom RENOVATION_GL_REFS entry the
  // pipeline does not track) means the comparison is structurally short, not that
  // the books disagree. It travels with the result so the cross-check can say so
  // instead of reporting a difference it invented.
  return { expected: out, coveredMonths, plKeys, unmappedRoots: unmapped, plRefreshedAt: data.refreshedAt || null, categoryMembers: data.categoryMembers || null };
}

// ── Build ───────────────────────────────────────────────────────────────────
const PULL_CONCURRENCY = 3;   // RM caps concurrent sessions; the P&L pull uses the same restraint

async function build({ now = new Date() } = {}) {
  const win = defaultWindow(now);
  const fromYM = win.from.slice(0, 7);
  const toYM = win.to.slice(0, 7);

  const [{ byId: propMap }, accounts, units] = await Promise.all([
    buildPropertyEntityMap(rentManager),
    resolveAccounts(),
    loadUnitIndex(),
  ]);

  if (!accounts.included.length) {
    throw new Error(
      `No GL accounts matched the renovation refs [${accounts.roots.join(', ')}]. ` +
      `Set RENOVATION_GL_REFS to the right reference number(s) — run scripts/probeRenovationApi.js to see the chart of accounts.`);
  }

  const refByAccountId = new Map(accounts.included.map(a => [String(a.id), a.ref]));
  const costTypeByAccountId = new Map(accounts.included.map(a => [String(a.id), a.costType || 'vendor']));
  const glAccountIds = accounts.included.map(a => a.id);

  const shortlist = propertiesWithSpend(fromYM, toYM);
  const charges = [];
  const perPropertyErrors = [];
  let mode;
  let reportRuns = 0;
  // Every count that could explain an empty board. A tab that says "no renovation
  // charges" when the truth is "the P&L snapshot is stale" or "the GL refs match
  // nothing on this instance" is worse than useless in front of an owner — it
  // certifies a wrong answer. These are what the empty state prints instead.
  const diagnostics = {
    propertiesInMap: propMap.size,
    accountsResolved: accounts.included.length,
    // Separates "this chart has no child accounts" from "/GLAccounts didn't hand
    // us the chart" — two very different problems that look identical upstream.
    chartOfAccounts: accounts.chartSize,
    accountCandidates: accounts.candidates.length,
    shortlisted: shortlist ? shortlist.expected.size : null,
    shortlistedInMap: 0,
    reportRowsReturned: 0,
    postingRowsKept: 0,
  };

  // A shortlist with nothing in it is an ANSWER — the P&L says no property booked
  // renovation spend in this window — not a reason to fall back to the expensive
  // portfolio-wide run. Only a missing snapshot (null) triggers the fallback.
  if (shortlist) {
    mode = 'per-property';
    const ids = [...shortlist.expected.keys()].filter(pid => propMap.has(pid));
    diagnostics.shortlistedInMap = ids.length;
    let cursor = 0;
    async function pullOne() {
      while (cursor < ids.length) {
        const pid = ids[cursor++];
        const meta = propMap.get(pid);
        try {
          const rows = await runGeneralLedger({
            propOwnerIds: String(pid), glAccountIds, startDate: win.from, endDate: win.to,
          });
          reportRuns += 1;
          diagnostics.reportRowsReturned += rows.length;
          for (const r of rows) {
            if (!isPosting(r)) continue;
            diagnostics.postingRowsKept += 1;
            charges.push(...splitAcrossUnits(toCharge(r, {
              propertyId: pid,
              propertyName: meta.name,
              entity: meta.entity,
              unitsByProperty: units.byProperty,
              unitsById: units.byId,
              refByAccountId,
              costTypeByAccountId,
            }), units.byProperty.get(pid) || []));
          }
        } catch (err) {
          // One property failing must not sink the pull — the tab is more useful
          // short by one building and saying so than not built at all.
          perPropertyErrors.push({ propertyId: pid, name: meta.name, error: err.message });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PULL_CONCURRENCY, ids.length) }, pullOne));
  } else {
    // No P&L snapshot to shortlist from. One portfolio-wide run, property resolved
    // by matching RM's PropertyShortName against the property map. Anything that
    // doesn't match is counted rather than dropped quietly.
    mode = 'portfolio-wide';
    // Report 51 identifies a property by ShortName. Index on both that and the
    // full name — RM instances are inconsistent about which one a given report
    // build emits, and an unmatched row costs us the whole property.
    const byName = new Map();
    for (const [pid, meta] of propMap.entries()) {
      for (const label of [meta.shortName, meta.name]) {
        const key = String(label || '').trim().toUpperCase();
        if (key && !byName.has(key)) byName.set(key, { pid, meta });
      }
    }
    const rows = await runGeneralLedger({
      propOwnerIds: [...propMap.keys()].join(','), glAccountIds, startDate: win.from, endDate: win.to,
    });
    reportRuns += 1;
    diagnostics.reportRowsReturned += rows.length;
    for (const r of rows) {
      if (!isPosting(r)) continue;
      diagnostics.postingRowsKept += 1;
      const nameKey = String(r.PropertyShortName || r.PropertyName || '').trim().toUpperCase();
      const hit = byName.get(nameKey);
      charges.push(...splitAcrossUnits(toCharge(r, {
        propertyId: hit ? hit.pid : null,
        propertyName: hit ? hit.meta.name : (r.PropertyShortName || '(unattributed)'),
        entity: hit ? hit.meta.entity : null,
        unitsByProperty: units.byProperty,
        unitsById: units.byId,
        refByAccountId,
        costTypeByAccountId,
      }), units.byProperty.get(hit ? hit.pid : null) || []));
    }
  }

  charges.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : Math.abs(b.amount) - Math.abs(a.amount)));

  // ── Cross-check against the P&L ───────────────────────────────────────────
  // Two reports, same GL accounts, same basis, same window: they have to agree. A
  // property where they don't is either a posting the shortlist missed or an
  // account mapped into one report and not the other, and either way the person
  // sending this to ownership needs to know before she sends it.
  const reconciliation = { checked: false, byProperty: [], mismatches: [] };
  if (shortlist) {
    reconciliation.checked = true;
    reconciliation.plRefreshedAt = shortlist.plRefreshedAt;
    // Which P&L lines the "expected" side is made of, so the panel can name them
    // (renCapital + majRepairs since 2026-08-25) — and any GL root the P&L
    // pipeline does not track, which makes the comparison structurally short
    // rather than the books wrong.
    reconciliation.plCategories = shortlist.plKeys || [];
    reconciliation.rootsWithoutPlSeries = shortlist.unmappedRoots || [];
    // Accounts this tab pulls that the P&L categories cannot contain — see
    // accountsOutsidePl. When there are any, the two sides are counting different
    // things and a difference is expected, so it is reported as an incomparable
    // set rather than as a wall of properties that "do not tie".
    // What the P&L's own totals contain, read off the report rather than assumed.
    // Portfolio-wide on purpose: report 45 only prints accounts a scope actually
    // posted to, so deriving the blocks from a single property would leave every
    // account that property happens not to use looking like it sits outside the
    // P&L — and switch the cross-check off over an accident of which building was
    // sampled.
    // Carried on the P&L snapshot, unioned over every property in its run — the
    // rows it is derived from were already being read to build the series, so
    // this costs nothing here. A snapshot taken before that field existed simply
    // has no structure to offer, and the comparison stays incomparable, which is
    // the same answer it gave yesterday.
    const blockMembers = shortlist.categoryMembers || null;
    reconciliation.plBlockMembers = blockMembers;
    reconciliation.accountsOutsidePl = accountsOutsidePl(accounts.included, refRoots(), blockMembers);
    // How much money is actually at stake in the accounts that fall outside.
    //
    // Report 45 only prints accounts a scope posted to, so an account can be
    // absent from every P&L block simply because nobody used it. An account with
    // no charges in the compared months cannot move either side of the
    // comparison — that is arithmetic, not a judgement — so it is separated from
    // the ones that can. Twenty-two names with no figures is a wall; four names
    // and a total is something a person can act on.
    {
      const covered = new Set(reconciliation.comparedMonths || []);
      const byRef = new Map();
      for (const c of charges) {
        if (covered.size && !covered.has(c.month)) continue;
        const ref = String(c.accountRef || '');
        if (!ref) continue;
        const at = byRef.get(ref) || { charges: 0, amount: 0 };
        at.charges++; at.amount += c.amount || 0;
        byRef.set(ref, at);
      }
      reconciliation.accountsOutsidePl = reconciliation.accountsOutsidePl.map(a => ({
        ...a, ...(byRef.get(String(a.ref)) || { charges: 0, amount: 0 }),
      }));
      const live = reconciliation.accountsOutsidePl.filter(a => a.charges > 0);
      reconciliation.outsideWithSpend = live.length;
      reconciliation.outsideAmount = Math.round(live.reduce((t, a) => t + a.amount, 0));
      reconciliation.outsideDormant = reconciliation.accountsOutsidePl.length - live.length;
    }
    reconciliation.comparable = reconciliation.accountsOutsidePl.length === 0;
    const covered = new Set(shortlist.coveredMonths || []);
    reconciliation.comparedMonths = shortlist.coveredMonths || [];
    reconciliation.comparedFrom = reconciliation.comparedMonths[0] || null;
    reconciliation.comparedTo = reconciliation.comparedMonths[reconciliation.comparedMonths.length - 1] || null;
    const actualByProperty = new Map();
    for (const c of charges) {
      if (c.propertyId == null) continue;
      // Only months the P&L also covers — see coveredMonths above.
      if (covered.size && !covered.has(c.month)) continue;
      actualByProperty.set(c.propertyId, (actualByProperty.get(c.propertyId) || 0) + c.amount);
    }
    // Only properties this site actually manages. The property map deliberately
    // turns some away (sold buildings still billed under a live LLC — see
    // entityMap's Demo Portfolio whitelist), and reporting those as a renovation "mismatch"
    // would fill the panel with rows nobody can act on and bury the real ones.
    const pids = new Set(
      [...shortlist.expected.keys(), ...actualByProperty.keys()].filter(pid => propMap.has(pid)));
    for (const pid of pids) {
      const expected = shortlist.expected.get(pid) || 0;
      const actual = actualByProperty.get(pid) || 0;
      const meta = propMap.get(pid);
      const row = {
        propertyId: pid,
        name: meta ? meta.name : String(pid),
        entity: meta ? meta.entity : null,
        expected: Math.round(expected),
        actual: Math.round(actual),
        diff: Math.round(actual - expected),
      };
      reconciliation.byProperty.push(row);
      // A dollar of rounding is not a mismatch; anything above it is — unless the
      // two sides are not counting the same accounts, in which case a difference is
      // arithmetic, not a finding.
      if (Math.abs(row.diff) > 1 && reconciliation.comparable) reconciliation.mismatches.push(row);
    }
    reconciliation.byProperty.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    reconciliation.mismatches.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    // A wall of "does not tie" rows is almost never a wall of separate problems.
    // When every mismatched property is missing ALL of its detail, that is one
    // cause — the wrong GL accounts, or a report returning no transactions — and
    // saying it once is the difference between a finding and a panic.
    const allEmpty = reconciliation.mismatches.length > 1
      && reconciliation.mismatches.every(m => m.actual === 0 && m.expected !== 0);
    if (allEmpty) {
      reconciliation.systemic = {
        kind: 'no-detail-at-all',
        properties: reconciliation.mismatches.length,
        total: reconciliation.mismatches.reduce((t, m) => t + m.expected, 0),
      };
    }
  }

  // Properties carried into the payload so the tab's filters don't need a second
  // endpoint — same {id: {name, entity}} shape the other tabs already read.
  const properties = {};
  for (const c of charges) {
    if (c.propertyId == null) continue;
    if (!properties[c.propertyId]) {
      properties[c.propertyId] = {
        name: c.propertyName,
        entity: c.entity,
        unitCount: (units.byProperty.get(c.propertyId) || []).length,
      };
    }
  }

  const coverage = {
    charges: charges.length,
    propertiesWithCharges: Object.keys(properties).length,
    unattributed: charges.filter(c => c.propertyId == null).length,
    unitReported: charges.filter(c => c.unitSource === 'reported').length,
    unitInferred: charges.filter(c => c.unitSource === 'inferred').length,
    unitAmbiguous: charges.filter(c => c.unitAmbiguous).length,
    // Rows that came from one receipt naming several units, and the receipts they
    // came from. A count of pieces alone would read as more work than it is —
    // 1,131 pieces from 500 receipts is 500 things somebody once had to check and
    // now nobody does.
    unitSplitRows: charges.filter(c => c.unitSplit).length,
    unitSplitSources: new Set(charges.filter(c => c.unitSplit).map(c => String(c.id).split('~')[0])).size,
    unitUnknown: charges.filter(c => c.unitSource === 'none').length,
    vendorTotal: Math.round(charges.filter(c => c.costType !== 'payroll').reduce((t, c) => t + c.amount, 0)),
    payrollTotal: Math.round(charges.filter(c => c.costType === 'payroll').reduce((t, c) => t + c.amount, 0)),
    reportRuns,
    errors: perPropertyErrors,
    diagnostics,
  };

  // Ask ONCE, here, whether this Rent Manager exposes the document hierarchy the
  // backup drill-down needs, and carry the answer in the snapshot. The probe is
  // eight cheap requests; running it here rather than when the tab opens is what
  // keeps "no Rent Manager calls on page load" literally true.
  let documentCapabilities = null;
  try {
    documentCapabilities = await rmDocuments.capabilities({ force: true });
  } catch (err) {
    documentCapabilities = { probedAt: new Date().toISOString(), resources: [], error: err.message,
      verdict: { level: 'unknown', text: `Could not probe the document API: ${err.message}` } };
  }

  return {
    configured: true,
    basis: 'Accrual',
    documentCapabilities,
    window: { from: win.from, to: win.to, fromYM, toYM, months: WINDOW_MONTHS },
    accounts: accounts.included,
    accountRoots: accounts.roots,
    accountNamePatterns: accounts.namePatterns || [],
    // Stamped so a snapshot can be recognised as built under superseded rules —
    // see mappingFingerprint below.
    mappingFingerprint: mappingFingerprint(),
    accountCandidates: accounts.candidates,
    charges,
    properties,
    reconciliation,
    coverage,
    // The field names RM's own report hands back, recorded once. Which columns a
    // report build carries is not documented and differs between instances, so
    // knowing whether a row already names its bill — rather than inferring it
    // from date, amount and vendor — is the difference between matching an
    // invoice and guessing at one.
    sources: { reportId: REPORT_ID, report: 'GeneralLedger', mode, basis: 'Accrual (2)',
      rowFields: _lastRowFields },
  };
}

// ── Snapshot cache ──────────────────────────────────────────────────────────
// Pull-on-demand like every other source on this site: `get()` never calls Rent
// Manager, `refresh()` is what the sync button drives.
// What set of accounts this snapshot was built from, as one short string. A
// snapshot built before the mapping was corrected is not stale by age — it can be
// minutes old and still wrong — so age cannot be what invalidates it.
//
// This is the fix for the day the majors stayed in "not included" after the deploy
// that included them: the code was right, and the tab was serving a snapshot built
// by the previous rules, with no way for anyone to tell.
// Bumped when a charge gains a field the tab depends on, not only when the
// account mapping changes. A snapshot is a cache of CHARGES, so a build that
// starts recording the vendor id and the invoice number produces charges the old
// one cannot stand in for — and without this the tab would keep serving
// yesterday's rows, with the invoice lookup quietly finding nothing.
const CHARGE_SHAPE = 2;   // 2: +vendorId, +invoiceNo, +txnId (2026-08-26)

function mappingFingerprint() {
  return [
    `shape:${CHARGE_SHAPE}`,
    `refs:${refRoots().join('+')}`,
    `names:${namePatterns().join('+')}`,
    `!refs:${excludedRoots().join('+')}`,
    `!names:${excludedNames().join('+')}`,
  ].join(' | ');
}

const cache = makeSnapshotCache({
  name: 'renovation expenses',
  file: 'renovation-expenses-cache.json',
  build: () => build(),
  // A payload from before this shipped has no fingerprint at all — that is also
  // "built under different rules", so it rebuilds once and then carries one.
  isOutdated: data => !data || data.mappingFingerprint !== mappingFingerprint(),
});

module.exports = {
  REPORT_ID,
  classifyCostType,
  PAYROLL_NAME_RE,
  // Test seam: the chart of accounts is cached for an hour, which is right in
  // production and useless in a check that swaps charts between assertions.
  __resetAccountCache: () => { _acctCache = null; },
  DEFAULT_REF_ROOTS,
  WINDOW_MONTHS,
  refRoots,
  namePatterns,
  excludedRoots,
  excludedNames,
  mappingFingerprint,
  accountsOutsidePl,
  defaultWindow,
  resolveAccounts,
  loadUnitIndex,
  inferUnit,
  inferUnitDetailed,
  splitAcrossUnits,
  runGeneralLedger,
  isPosting,
  toCharge,
  chargeId,
  invoiceNumberFrom,
  propertiesWithSpend,
  build,
  get: cache.get,
  refresh: cache.refresh,
  status: cache.status,
  SNAPSHOT_FILE: cache.FILE,
};
