// Tiny disk-backed snapshot cache.
//
// The site had four hand-rolled versions of this pattern (P&L, collections, move
// activity, unit counts) and two endpoints with none at all — Issues and Debt
// Service went to Rent Manager on EVERY request, so simply loading a page spent
// API budget. This is the shared version, used for those two.
//
// The contract that matters: `get()` NEVER fetches. It returns whatever was last
// pulled, or null. Refreshing is always an explicit call to `refresh()`, which is
// what the universal refresh button drives. That's what makes "the site shows the
// last pull until you press refresh" true rather than aspirational.
//
// A failed refresh keeps the previous snapshot. Stale data beats no data, and a
// refresh that wipes good numbers when RM is briefly unavailable is worse than
// one that reports it couldn't.

const fs = require('fs');
const path = require('path');

// `isOutdated(data)` is age-independent staleness: a snapshot that was correct
// when it was built and is wrong now because the CODE changed under it. The case
// that forced it (2026-08-26): the renovation tab's GL account mapping was fixed,
// deployed, and the tab kept serving the previous snapshot — so the accounts that
// had just been included still showed as excluded, and the only way to find out
// was to know to press Refresh. A cache that can silently outlive the rules that
// built it will do this every time the rules change.
function makeSnapshotCache({ name, file, build, autoRefreshMs = 0, isOutdated = null }) {
  const FILE = path.join(__dirname, '..', 'data', file);
  let cache = null;
  let inFlight = null;
  let lastError = null;
  let loaded = false;

  function get() {
    if (!loaded) {
      try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = null; }
      loaded = true;
    }
    return cache;
  }

  function save(payload) {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(payload));
    } catch (err) {
      // Non-fatal: the in-memory copy still serves until the next restart.
      lastError = `${name} snapshot write failed: ${err.message}`;
    }
  }

  // After a failed build, don't try again immediately. Without this, a route that
  // builds-on-empty turns a Rent Manager outage into a retry storm: every page
  // load starts another doomed build. Mirrors the auth cooldown in
  // rentManagerClient for the same reason.
  const FAILURE_COOLDOWN_MS = 60 * 1000;
  let lastFailureAt = 0;

  function cooldownRemaining() {
    if (!lastFailureAt) return 0;
    return Math.max(0, FAILURE_COOLDOWN_MS - (Date.now() - lastFailureAt));
  }

  // Explicit refresh. Concurrent callers share one in-flight build so a burst of
  // requests can't multiply into a burst of RM calls.
  function refresh({ force = false } = {}) {
    if (inFlight) return inFlight;
    const wait = cooldownRemaining();
    if (wait > 0 && !force) {
      return Promise.reject(new Error(
        `${name} refresh is cooling down after a recent failure — retry in ${Math.ceil(wait / 1000)}s`));
    }
    lastError = null;
    inFlight = Promise.resolve()
      .then(build)
      .then(data => {
        const payload = { refreshedAt: new Date().toISOString(), data };
        cache = payload;
        loaded = true;
        lastFailureAt = 0;
        save(payload);
        return payload;
      })
      .catch(err => {
        lastError = err.message;
        lastFailureAt = Date.now();
        throw err; // previous snapshot deliberately left intact
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  // Opt-in staleness, off unless a caller passes autoRefreshMs. Only the work-order
  // feed uses it: the Issues tab is a live operational queue, and a job raised this
  // morning being invisible until someone presses a button defeats the tab. It's a
  // single cheap sweep, not the report runs that made the old timers expensive.
  //
  // Deliberately pull-based rather than a setInterval: it refreshes only while
  // someone is actually looking at the tab, and goes quiet when nobody is.
  function isStale() {
    if (!autoRefreshMs) return false;
    const c = get();
    if (!c) return true;
    const age = Date.now() - Date.parse(c.refreshedAt || 0);
    return !Number.isFinite(age) || age > autoRefreshMs;
  }

  // Built under rules this build no longer uses. Unlike age, this is not opt-in
  // by time: nobody wants a snapshot computed by a mapping that has since been
  // corrected, so it is checked on every read and it triggers a rebuild.
  function outdated() {
    if (typeof isOutdated !== 'function') return false;
    const c = get();
    if (!c) return false;                       // nothing cached is "empty", not "outdated"
    try { return !!isOutdated(c.data, c); } catch { return false; }
  }

  // Serve the snapshot immediately and kick a background refresh when it's aged
  // out — the reader never waits on Rent Manager.
  function getFresh() {
    const c = get();
    if ((isStale() || outdated()) && !inFlight && cooldownRemaining() === 0) {
      refresh().catch(() => {}); // previous snapshot still serves
    }
    return c;
  }

  // status() is what the routes read, so the outdated check has to fire here too —
  // otherwise a tab that never calls getFresh() keeps serving the old rules.
  function status() {
    const c = get();
    const stale = outdated();
    if (stale && !inFlight && cooldownRemaining() === 0) refresh().catch(() => {});
    return {
      cache: c,
      refreshedAt: c ? c.refreshedAt : null,
      building: Boolean(inFlight),
      outdated: stale,
      lastError,
      cooldownMs: cooldownRemaining(),
      autoRefreshMs,
    };
  }

  return { get, getFresh, refresh, status, isStale, outdated, FILE };
}

module.exports = { makeSnapshotCache };
