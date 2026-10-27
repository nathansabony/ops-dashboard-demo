// Frozen budget set — built ONCE, served from disk.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The budget is not a live tool yet. It is a deliverable: a set of 12-month
// budgets and Excel workbooks to put in front of the regional manager, discuss, and then change
// how they're MADE. That means two things it must not do:
//
//   1. Never pull from Rent Manager on a page view. The engine itself costs zero
//      RM calls, but reading the P&L snapshot through propertyFinancials.getStatus()
//      would self-heal a >30-minute-old snapshot by kicking off a background
//      refresh (~89 report runs). Opening a tab must not spend API budget, so
//      everything here reads snapshots PASSIVELY via loadSnapshot().
//
//   2. Never move underfoot. If the tab recomputed from a live snapshot on every
//      open, the numbers on screen would drift away from the workbooks already
//      downloaded and emailed. A budget you're reviewing has to hold still.
//
// So: one build writes the whole set — the JSON the tab renders plus one .xlsx per
// entity plus the portfolio — into data/budget/, and everything after that is a
// file read. Rebuilding is an explicit act (npm run budget:build, or the Rebuild
// button on the tab), never a side effect of looking at it.
//
// data/ is a the host persistent disk (see render.yaml), so the set survives
// redeploys and restarts.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const propertyFinancials = require('./propertyFinancials');
const unitCounts = require('./unitCounts');
const budgetModel = require('./budgetModel');
const budgetAssumptions = require('./budgetAssumptions');
const budgetOverrides = require('./budgetOverrides');

const STORE_DIR = path.join(__dirname, '..', 'data', 'budget');
const SET_FILE = path.join(STORE_DIR, 'budget-set.json');
const MANIFEST_FILE = path.join(STORE_DIR, 'manifest.json');
const WORKBOOK_SCRIPT = path.join(__dirname, '..', 'budget', 'budget_workbook.py');
const VERIFY_SCRIPT = path.join(__dirname, '..', 'scripts', 'verifyBudgetWorkbook.py');
const PY = process.env.UNDERWRITING_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

let _building = null;
let _progress = null;
let _lastError = null;

function safeScope(scope) {
  return String(scope).replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, '-') || 'entity';
}

function workbookName(scope, stamp) {
  return `Budget-${safeScope(scope)}-12mo-${stamp}.xlsx`;
}

// ── read side: pure file reads, no RM, no recompute ──────────────────────────
function loadSet() {
  try {
    return JSON.parse(fs.readFileSync(SET_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Absolute path to a stored workbook, or null when it isn't on disk.
function workbookPath(scope) {
  const manifest = loadManifest();
  if (!manifest) return null;
  const entry = (manifest.workbooks || []).find(w => w.scope === scope);
  if (!entry) return null;
  const file = path.join(STORE_DIR, entry.file);
  return fs.existsSync(file) ? file : null;
}

// ── Generate one workbook, then prove it ─────────────────────────────────────
// The workbook and the Budget tab are two independent implementations of the same
// model — Excel formulas and JavaScript. verifyBudgetWorkbook.py recalculates the
// generated file and asserts every cell against the engine that produced it.
//
// That check existed for a year as a script nobody ran, which is how a portfolio
// workbook that disagreed with the portfolio tab by $905,667 shipped unnoticed. It
// costs about a second per workbook, so it now runs on every build and a mismatch
// fails the build rather than landing in an accountant's inbox.
//
// Two failures are possible here and they are NOT the same thing:
//
//   • the verifier RAN and found a mismatch  → the workbook is wrong, fail the build
//   • the verifier could not run at all      → we simply don't know, warn and continue
//
// Conflating them is how "someone deleted the verifier" would get reported as
// "your numbers are wrong", and — worse in the other direction — how a broken
// interpreter could be mistaken for a passing check. So a genuine mismatch is
// identified by the verifier's OWN output markers rather than by exit code, which
// is 1 for both a real mismatch and an import error.
const VERIFY_FAILED = /mismatch\(es\)|did not evaluate|cached values missing|not found in the workbook/i;

function verifyWorkbook(jsonPath, outPath, onWarn) {
  return new Promise((resolve, reject) => {
    execFile(PY, [VERIFY_SCRIPT, jsonPath, outPath],
      { timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const out = `${stderr || ''}${stdout || ''}`;
        if (VERIFY_FAILED.test(out)) {
          const detail = out.split('\n').filter(l => l.trim()).slice(-12).join('\n   ').trim();
          return reject(new Error(`workbook does not reproduce the engine:\n   ${detail}`));
        }
        // Could not verify. Say exactly why, in one line, and carry on — a budget
        // still gets built, it just ships unproven and the build says so.
        const why = /ModuleNotFoundError|No module named/i.test(out)
          ? `python "formulas" package not installed for ${PY}`
          : (out.split('\n').find(l => l.trim()) || 'verifier could not be run').trim();
        if (onWarn) onWarn(`NOT VERIFIED — ${why}`);
        return resolve(null);
      });
  });
}

function runWorkbook(payload, outPath, { verify = true, onWarn } = {}) {
  return new Promise((resolve, reject) => {
    const tmp = `${outPath}.json`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    execFile(PY, [WORKBOOK_SCRIPT, tmp, outPath],
      { timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      async (err, stdout, stderr) => {
        if (err) {
          fs.unlink(tmp, () => {});
          const detail = (stderr || err.message || '').split('\n').slice(-4).join(' ').trim();
          return reject(new Error(detail || 'budget_workbook.py failed'));
        }
        try {
          if (verify) await verifyWorkbook(tmp, outPath, onWarn);
          resolve(stdout);
        } catch (verifyErr) {
          reject(verifyErr);
        } finally {
          fs.unlink(tmp, () => {});
        }
      });
  });
}

// ── compute: the one path both the build and the live preview run through ────
// Editing an assumption on the tab has to produce EXACTLY the number a rebuild
// would produce, or the preview is a lie you find out about after you've agreed
// to it in a meeting. So preview and build differ in one respect only — whether
// anything is written to disk — and they share this function to guarantee it.
//
// Reads both snapshots PASSIVELY. A missing P&L snapshot throws rather than
// triggering a Rent Manager pull.
function computeSet(overrides) {
  const snapshot = propertyFinancials.loadSnapshot();
  if (!snapshot) {
    const err = new Error(
      'No P&L snapshot on disk to build from. Refresh the live financials first '
      + '(POST /api/financials/property-monthly/recompute), then build the budget set.');
    err.code = 'NO_SNAPSHOT';
    throw err;
  }
  const unitSnap = unitCounts.loadSnapshot();
  const unitsByEntity = (unitSnap && unitSnap.byEntity) || {};

  // Assumptions edited on the tab (services/budgetOverrides.js) are part of the
  // build, not a display layer — otherwise the frozen set and the workbooks would
  // keep quoting the code defaults while the screen showed the regional manager's numbers.
  const benchmarks = {};
  for (const line of budgetOverrides.benchmarkLines()) {
    benchmarks[line.key] = budgetOverrides.benchmarkFor(line, overrides);
  }

  const built = budgetModel.buildAll(snapshot, {
    unitsByEntity,
    assumptions: overrides.global,
    entityAssumptions: overrides.entities,
    pins: overrides.pins,
    benchmarks,
  });

  const payload = {
    ...built,
    config: {
      lines: budgetAssumptions.BUDGET_LINES,
      defaults: budgetAssumptions.DEFAULT_ASSUMPTIONS,
      uncontrollable: [...budgetAssumptions.UNCONTROLLABLE],
      horizonMonths: budgetAssumptions.HORIZON_MONTHS,
      baseMonths: budgetAssumptions.BASE_MONTHS,
    },
    unitsByEntity,
    unitsSource: unitSnap ? 'Rent Manager /Units' : 'unavailable — per-unit checks skipped',
    overrides,
    benchmarks,
  };

  return { snapshot, unitSnap, unitsByEntity, overrides, benchmarks, built, payload };
}

/**
 * Recompute the whole set in memory with the given (unsaved) overrides. Writes
 * nothing — this is what the tab's live editing calls on every keystroke, so it
 * must stay free of side effects: no files, no workbooks, no Rent Manager.
 */
function preview(rawOverrides) {
  return computeSet(budgetOverrides.sanitize(rawOverrides)).payload;
}

// ── build side: explicit only ────────────────────────────────────────────────
/**
 * Build every entity's budget + workbook and persist the set.
 */
async function build({ onProgress } = {}) {
  // The one Rent Manager call this path is allowed to make, and only when the
  // count has NEVER been pulled. Everything else here reads snapshots passively,
  // but a budget built with zero units is quietly wrong rather than merely
  // incomplete: replacement reserves ARE units × $/unit/yr, so they come out $0,
  // every $/unit benchmark check is skipped, and the workbook prints "Units —"
  // on its front page. npm run budget:build already did this; the Rebuild button
  // on the tab did not, so a rebuild from the site shipped unit-less workbooks.
  // A single cheap /Units sweep, once, beats fourteen wrong workbooks.
  if (!unitCounts.loadSnapshot()) {
    try { await unitCounts.startBuild(); } catch { /* budget still builds; per-unit checks skip */ }
  }

  const overrides = budgetOverrides.load();
  const { snapshot, built, benchmarks, payload } = computeSet(overrides);
  const scopes = [...Object.keys(built.entities), 'Portfolio'];
  const stamp = new Date().toISOString().slice(0, 10);

  fs.mkdirSync(STORE_DIR, { recursive: true });

  const workbooks = [];
  let done = 0;
  for (const scope of scopes) {
    const budget = scope === 'Portfolio' ? built.portfolio : built.entities[scope];
    if (!budget) continue;
    const file = workbookName(scope, stamp);
    const outPath = path.join(STORE_DIR, file);
    await runWorkbook(budgetModel.toWorkbookPayload(budget, { benchmarks }), outPath, {
      onWarn: msg => console.warn(`  ! ${scope}: ${msg}`),
    });
    const stat = fs.statSync(outPath);
    workbooks.push({
      scope,
      file,
      size: stat.size,
      units: budget.units || 0,
      year1NOI: budget.years[0] ? budget.years[0].noi : null,
    });
    done += 1;
    if (onProgress) onProgress(done, scopes.length, scope);
  }

  // Remove workbooks from earlier builds so the folder only ever holds the
  // current set — otherwise every rebuild leaves a differently-dated copy behind
  // and it stops being obvious which file is the real one.
  const keep = new Set(workbooks.map(w => w.file));
  for (const f of fs.readdirSync(STORE_DIR)) {
    if (f.endsWith('.xlsx') && !keep.has(f)) {
      try { fs.unlinkSync(path.join(STORE_DIR, f)); } catch { /* best effort */ }
    }
  }

  const manifest = {
    builtAt: new Date().toISOString(),
    stamp,
    scopes: workbooks.map(w => w.scope),
    workbooks,
    actualsRefreshedAt: snapshot.refreshedAt || null,
    actualsAsOfMonth: snapshot.asOfMonth || null,
    // Stamped into the manifest so the tab can say "these workbooks were built
    // with the assumptions you edited on 27 Jul", not just when they were built.
    assumptionsEditedAt: overrides.editedAt || null,
    assumptionsEditedBy: overrides.editedBy || null,
    assumptionsEdits: budgetOverrides.diffFromDefaults(overrides).count,
    baseWindow: built.portfolio ? built.portfolio.baseWindow : null,
    budgetWindow: built.portfolio
      ? { from: built.portfolio.monthLabels[0], to: built.portfolio.monthLabels[built.portfolio.monthLabels.length - 1] }
      : null,
  };

  fs.writeFileSync(SET_FILE, JSON.stringify(payload));
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  return { payload, manifest };
}

// Kick off a build, de-duplicating concurrent requests.
function startBuild() {
  if (_building) return _building;
  _lastError = null;
  _progress = { done: 0, total: null, current: null };
  _building = build({
    onProgress: (done, total, current) => { _progress = { done, total, current }; },
  })
    .catch(err => { _lastError = err.message; throw err; })
    .finally(() => { _building = null; _progress = null; });
  return _building;
}

function status() {
  return { building: Boolean(_building), progress: _progress, lastError: _lastError };
}

module.exports = {
  STORE_DIR,
  SET_FILE,
  MANIFEST_FILE,
  loadSet,
  loadManifest,
  workbookPath,
  computeSet,
  preview,
  build,
  startBuild,
  status,
};
