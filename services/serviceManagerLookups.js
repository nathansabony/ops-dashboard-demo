// Rent Manager's Service Manager lookup tables.
//
// A ServiceManagerIssues row carries CategoryID / StatusID / PriorityID /
// AssignedToUserID and nothing else — numbers with no names attached. An earlier
// pass concluded the matching lookup resources didn't exist and the site was
// left guessing: every ticket's priority defaulted to "Medium", its status to a
// boolean Open/Closed, and its assignee to blank.
//
// The lookups do exist. /ServiceManagerCategories, /ServiceManagerStatuses,
// /ServiceManagerPriorities and /Users all resolve, which is the difference
// between "Medium, Medium, Medium" and the real split (High 234, Medium 70,
// Low 62 over a 7-day window).
//
// All four are small and effectively static — 35 categories, 11 statuses, 4
// priorities, a few hundred users — so they're cached in memory for an hour
// rather than re-pulled alongside every issue sweep. RM caps concurrent
// sessions; four extra calls on every refresh is a cost with no payoff.

const CACHE_TTL_MS = 60 * 60 * 1000;

let cached = null;
let cachedAt = 0;
let inFlight = null;

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.Results || payload.Items || payload.Data || [];
}

// RM uses the literal string '<Unassigned>' for the zero row of every lookup.
// That's a placeholder, not a name — map it to empty so callers fall back
// rather than rendering "<Unassigned>" at people.
function realName(value) {
  const text = String(value || '').trim();
  return text && text !== '<Unassigned>' ? text : '';
}

function nameMap(rows, idKey, nameKey = 'Name') {
  const map = new Map();
  for (const row of rows) {
    const id = row && row[idKey];
    if (id == null) continue;
    const name = realName(row[nameKey]);
    if (name) map.set(Number(id), name);
  }
  return map;
}

const EMPTY = {
  categories: new Map(),
  statuses: new Map(),
  priorities: new Map(),
  users: new Map(),
  ok: false,
};

async function build(rentManager) {
  // Sequential, not Promise.all: RM's concurrent-session cap is low enough that
  // parallel bursts get 401'd, and this runs at most once an hour.
  const categories = nameMap(asRows(await rentManager.get('/ServiceManagerCategories', { pagesize: 500 })), 'ServiceManagerCategoryID');
  const statuses = nameMap(asRows(await rentManager.get('/ServiceManagerStatuses', { pagesize: 500 })), 'ServiceManagerStatusID');
  const priorities = nameMap(asRows(await rentManager.get('/ServiceManagerPriorities', { pagesize: 500 })), 'ServiceManagerPriorityID');

  // /Users rows carry Name plus Firstname/Lastname; Name is what RM shows in the
  // Service Manager UI, so it's what a super would recognize on the dashboard.
  const userRows = asRows(await rentManager.get('/Users', { pagesize: 1000 }));
  const users = new Map();
  for (const row of userRows) {
    const id = row && (row.UserID ?? row.UserId);
    if (id == null) continue;
    const name = realName(row.Name) || realName([row.Firstname, row.Lastname].filter(Boolean).join(' '));
    if (name) users.set(Number(id), name);
  }

  return { categories, statuses, priorities, users, ok: true };
}

// Resolved id→name maps for Service Manager. Never throws: an RM outage or a
// permissions gap degrades this to empty maps, and every caller falls back to
// what it did before names were available.
async function getLookups(rentManager) {
  if (!rentManager || !rentManager.isConfigured || !rentManager.isConfigured()) return EMPTY;
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  if (inFlight) return inFlight;

  inFlight = build(rentManager)
    .then(result => {
      cached = result;
      cachedAt = Date.now();
      return result;
    })
    .catch(err => {
      console.warn('Service Manager lookups unavailable:', err.message);
      return cached || EMPTY; // a stale map beats no map
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}

function clearCache() {
  cached = null;
  cachedAt = 0;
}

module.exports = { getLookups, clearCache, EMPTY };
