// ── The Variance tab's numbers, against a fresh Rent Manager pull ────────────
//
// The owner, 2026-09-14: *"When I have the meeting, I want to start going over the
// different variances one by one. The regional manager is going to pull out a real T-12 in Rent
// Manager and compare the numbers just to make sure the tool is even accurate."*
//
// That is the right test and it has to be survivable in the room, so this runs it
// beforehand — SERVER-SIDE, where the Rent Manager credentials already live, so
// nobody has to hand a login anywhere.
//
// The script `scripts/reconcileT12.js` does the same work from a terminal. This
// is the same three questions asked over HTTP, returning structured findings
// rather than printed ones, because the answer a meeting needs is "here are the
// cells that disagree", not a wall of ticks.
//
//   1. The PARAMETERS both sides must be running. Half of every "these don't
//      match" is two people running two different reports, and it is settled in
//      one line each: report 45, accrual, by post date, this exact date range.
//   2. The ROLLUP identities — each entity is the sum of its own buildings, the
//      portfolio is the sum of the entities and of the properties. These hold
//      whatever the books say, so a failure means something specific.
//   3. The LIVE comparison — each entity re-pulled from Rent Manager as one
//      combined-scope accrual call over the same twelve months, compared cell for
//      cell against what the site is serving.
//
// The in-progress month is excluded throughout. A half-posted month reads low by
// construction, and comparing one is how two correct runs disagree.

const pf = require('./propertyFinancials');

const EPS = 1;   // dollars — the tab displays whole dollars
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function windowOf(snap) {
  const labels = snap.months || [];
  const partial = snap.partialCurrentMonth ? 1 : 0;
  const displayed = labels.slice(Math.max(0, labels.length - 12 - partial), labels.length - partial);
  if (!displayed.length) return { labels: [], indexes: [], months: [] };
  const parse = (l) => {
    const [mon, yy] = String(l).split(' ');
    return { year: 2000 + Number(yy), m0: MONTH_ABBR.indexOf(mon) };
  };
  const a = parse(displayed[0]), b = parse(displayed[displayed.length - 1]);
  const pad = n => String(n).padStart(2, '0');
  return {
    labels: displayed,
    indexes: displayed.map(l => labels.indexOf(l)),
    from: `${a.year}-${pad(a.m0 + 1)}-01`,
    to: `${b.year}-${pad(b.m0 + 1)}-${pad(new Date(b.year, b.m0 + 1, 0).getDate())}`,
    months: pf.enumerateMonths(`${a.year}-${pad(a.m0 + 1)}`, `${b.year}-${pad(b.m0 + 1)}`),
  };
}

// What to hand the person running the report on the other side of the table.
function parameters(snap, win) {
  return {
    report: `${pf.REPORT_ID} — ProfitLossRecapMonth`,
    basis: `ACCRUAL (Basis=${pf.BASIS_ACCRUAL})`,
    runBy: 'post date, not accounting period (RunByPeriod=false); period adjustments included',
    from: win.from,
    to: win.to,
    months: win.labels.length,
    firstMonth: win.labels[0] || null,
    lastMonth: win.labels[win.labels.length - 1] || null,
    snapshotBuilt: snap.refreshedAt || null,
    inProgressMonthExcluded: Boolean(snap.partialCurrentMonth),
    note: 'A cash-basis export legitimately differs from every figure on this tab. Check that first.',
  };
}

// Identities that must hold whatever the books say — so a failure is a specific
// thing, not "a number looks off".
function rollups(snap, win, keys) {
  const props = Object.entries(snap.properties || {});
  const entities = Object.entries(snap.entities || {});
  const findings = [];

  const membership = new Map();
  for (const [pid, p] of props) {
    const e = p.entity || '(no entity)';
    if (!membership.has(e)) membership.set(e, []);
    membership.get(e).push({ pid, name: p.name });
  }
  const orphans = membership.get('(no entity)') || [];
  if (orphans.length) {
    findings.push({
      check: 'every property maps to an entity', ok: false,
      detail: `${orphans.length} map to none — their money reaches the portfolio and no entity`,
      properties: orphans.slice(0, 20).map(o => `${o.name} (id ${o.pid})`),
    });
  }

  for (const [name, series] of entities) {
    const members = membership.get(name) || [];
    let worst = null;
    for (const key of keys) {
      win.indexes.forEach((si, j) => {
        const rolled = (series[key] || [])[si] || 0;
        const summed = members.reduce((s, m) => s + ((snap.properties[m.pid][key] || [])[si] || 0), 0);
        const d = rolled - summed;
        if (Math.abs(d) > EPS && (!worst || Math.abs(d) > Math.abs(worst.diff))) {
          worst = { entity: name, line: key, month: win.labels[j], rollup: Math.round(rolled), buildings: Math.round(summed), diff: Math.round(d), memberCount: members.length };
        }
      });
    }
    if (worst) findings.push({ check: 'entity equals the sum of its own buildings', ok: false, ...worst });
  }

  for (const [label, sumOf] of [
    ['the portfolio equals the sum of the entities', entities.map(([, e]) => e)],
    ['the portfolio equals the sum of the properties', props.map(([, p]) => p)],
  ]) {
    let worst = null;
    for (const key of keys) {
      win.indexes.forEach((si, j) => {
        const total = ((snap.portfolio || {})[key] || [])[si] || 0;
        const summed = sumOf.reduce((s, e) => s + ((e[key] || [])[si] || 0), 0);
        const d = total - summed;
        if (Math.abs(d) > EPS && (!worst || Math.abs(d) > Math.abs(worst.diff))) {
          worst = { line: key, month: win.labels[j], portfolio: Math.round(total), sum: Math.round(summed), diff: Math.round(d) };
        }
      });
    }
    if (worst) findings.push({ check: label, ok: false, ...worst });
  }

  return {
    entityCount: entities.length,
    propertyCount: props.length,
    cellsChecked: entities.length * keys.length * win.labels.length,
    findings,
    passed: findings.length === 0,
    membership,
  };
}

/**
 * Re-pull each entity from Rent Manager and compare cell for cell.
 *
 * One combined-scope call per entity rather than one per property: that is the
 * scope the tab actually displays, and it is what a T-12 run on the other side of
 * the table will be run at.
 */
async function liveCompare(snap, win, keys, membership, { only = null, maxEntities = 20 } = {}) {
  const names = Object.keys(snap.entities || {})
    .filter(n => !only || n.toLowerCase().includes(String(only).toLowerCase()))
    .slice(0, maxEntities);

  const entities = [];
  for (const name of names) {
    const members = membership.get(name) || [];
    if (!members.length) { entities.push({ entity: name, buildings: 0, error: 'no properties in this entity' }); continue; }
    let fresh;
    try {
      fresh = await pf.pullScopeSeries(members.map(m => m.pid).join(','), win.months);
    } catch (err) {
      entities.push({ entity: name, buildings: members.length, error: String(err && err.message || err).slice(0, 160) });
      continue;
    }
    const off = [];
    for (const key of keys) {
      win.indexes.forEach((si, j) => {
        const ours = (snap.entities[name][key] || [])[si] || 0;
        const theirs = (fresh[key] || [])[j] || 0;
        if (Math.abs(ours - theirs) > EPS) {
          off.push({ line: key, month: win.labels[j], tab: Math.round(ours), rentManager: Math.round(theirs), diff: Math.round(ours - theirs) });
        }
      });
    }
    entities.push({
      entity: name,
      buildings: members.length,
      cells: keys.length * win.labels.length,
      agreeing: keys.length * win.labels.length - off.length,
      disagreeing: off.length,
      // Biggest money first: that is the order anybody reads them in.
      worst: off.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 12),
    });
  }
  return entities;
}

// One line, twelve months, every scope — the page to put beside a real T-12.
function lineTable(snap, win, key) {
  const row = (name, series) => {
    const values = win.indexes.map(si => Math.round(((series || {})[key] || [])[si] || 0));
    return { scope: name, months: values, total: values.reduce((a, b) => a + b, 0) };
  };
  return {
    line: key,
    glAccounts: pf.CATEGORY_REFS[key] || null,
    months: win.labels,
    rows: [row('PORTFOLIO', snap.portfolio), ...Object.entries(snap.entities || {}).sort().map(([n, s]) => row(n, s))],
  };
}

async function run({ live = false, scope = null, line = null } = {}) {
  const snap = pf.loadSnapshot();
  if (!snap || !snap.months || !snap.months.length) {
    throw new Error('No P&L snapshot yet — press Refresh on the Variances tab first.');
  }
  const win = windowOf(snap);
  if (!win.labels.length) throw new Error('The snapshot carries no complete months.');
  const keys = (snap.categories && snap.categories.length) ? snap.categories : pf.ALL_KEYS;

  const out = {
    ranAt: new Date().toISOString(),
    parameters: parameters(snap, win),
    rollups: null,
    live: null,
    table: null,
  };
  const roll = rollups(snap, win, keys);
  const { membership, ...rollPublic } = roll;
  out.rollups = rollPublic;
  if (line) {
    const hit = keys.find(k => k.toLowerCase() === String(line).toLowerCase())
      || keys.find(k => k.toLowerCase().includes(String(line).toLowerCase()));
    if (!hit) throw new Error(`"${line}" is not a tracked line. Try one of: ${keys.join(', ')}`);
    out.table = lineTable(snap, win, hit);
  }
  if (live) out.live = await liveCompare(snap, win, keys, membership, { only: scope });
  return out;
}

module.exports = { run, windowOf, parameters, rollups, liveCompare, lineTable };
