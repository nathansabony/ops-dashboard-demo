#!/usr/bin/env node
// The full trailing-twelve reconciliation, on accrual, across every scope the tab
// shows — and the one level none of the other reconcilers has ever checked.
//
//   node scripts/reconcileT12.js                     # every scope, off the snapshot
//   node scripts/reconcileT12.js --live              # …and every entity re-pulled from RM
//   node scripts/reconcileT12.js --line insurance    # the T-12 table, ready to sit beside corporate's
//   node scripts/reconcileT12.js --selftest          # offline, against a synthetic snapshot
//
// ── why a fifth reconciler ───────────────────────────────────────────────────
// The owner, 2026-09-03: *"make sure the numbers match Rent Manager — last time they
// didn't. Do a full reconciliation. Everything is accrual basis, and match the
// numbers."* The live item behind it is the insurance figure that came out
// slightly different in his scan and in corporate's measurement.
//
// The four scripts already here check four real things and share one blind spot,
// and it is exactly where an insurance figure would slip:
//
//   check:variance-pl        the PIPELINE is faithful to report 45   — per property
//   compareDashboardToRM     the SNAPSHOT matches a fresh pull       — per property
//   reconcilePLExport        we match THE EXPORT somebody is holding — one scope
//   reconcileChargeDetail    charged/paid against RM's own summary   — delinquency
//
// Every one of them works a PROPERTY, or one scope named on the command line.
// Nobody works an ENTITY — and an entity is what the Variance tab shows, what
// ownership asks about, and what corporate measures. An entity here is not a
// thing Rent Manager hands over; it is built by summing the properties whose
// BillingName1 matches (services/entityMap.js). So an entity total can be wrong
// in a way that leaves every single property cell tying perfectly:
//
//   * a property in the wrong entity — both entities are off, opposite ways, and
//     the portfolio still ties;
//   * a property in NO entity — the entity is short and the portfolio is right;
//   * a property counted in two — the portfolio is over and no property is wrong.
//
// That is the shape of "ours and corporate's are slightly different", and no
// existing check could see any of it. This one does, and then re-pulls each
// entity from Rent Manager as one combined-scope accrual call so the rollup is
// checked against RM rather than against itself.
//
// Contains NO financial figures. The identities below must hold whatever the
// books say; `--line` prints whatever the snapshot holds at the time.

const fs = require('fs');
const path = require('path');

const EPS = 1;                 // dollars — the tab displays whole dollars
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let fails = 0, checks = 0;
function check(label, ok, detail) {
  checks++;
  if (!ok) fails++;
  console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${label}${detail ? `\n         ${detail}` : ''}`);
}
const money = v => `${v < 0 ? '-' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;

// ── the window, stated so the other side can run the same report ────────────
// Half of every "these don't match" turns out to be two people running two
// different reports. So the parameters go at the top of the output, in the words
// of Rent Manager's own dialog, and they are read off the pipeline rather than
// typed here — a script describing parameters the pipeline does not pass would be
// worse than no script.
function windowOf(snap, pf) {
  const labels = snap.months || [];
  const partial = snap.partialCurrentMonth ? 1 : 0;
  const displayed = labels.slice(Math.max(0, labels.length - 12 - partial), labels.length - partial);
  const parse = (l) => {
    const [mon, yy] = String(l).split(' ');
    return { year: 2000 + Number(yy), m0: MONTH_ABBR.indexOf(mon) };
  };
  if (!displayed.length) return { labels: [], from: null, to: null, months: [] };
  const a = parse(displayed[0]), b = parse(displayed[displayed.length - 1]);
  const pad = n => String(n).padStart(2, '0');
  return {
    labels: displayed,
    from: `${a.year}-${pad(a.m0 + 1)}-01`,
    to: `${b.year}-${pad(b.m0 + 1)}-${pad(new Date(b.year, b.m0 + 1, 0).getDate())}`,
    months: pf ? pf.enumerateMonths(`${a.year}-${pad(a.m0 + 1)}`, `${b.year}-${pad(b.m0 + 1)}`) : [],
    // Where each displayed month sits in the snapshot's own arrays.
    indexes: displayed.map(l => labels.indexOf(l)),
  };
}

function printHeader(snap, win, pf) {
  const ageH = (Date.now() - Date.parse(snap.refreshedAt || 0)) / 3600000;
  console.log('\n── The report both sides have to be running ─────────────────────────');
  console.log(`  Report        ${pf ? pf.REPORT_ID : 45} · ProfitLossRecapMonth`);
  console.log(`  Basis         ACCRUAL${pf ? ` (Basis=${pf.BASIS_ACCRUAL})` : ''} — every figure on this site is accrual, without exception`);
  console.log(`  Run by        post date, not accounting period (RunByPeriod=false), period adjustments included`);
  console.log(`  Window        ${win.from} → ${win.to}   (${win.labels.length} complete months: ${win.labels[0]} … ${win.labels[win.labels.length - 1]})`);
  console.log(`  Snapshot      ${snap.refreshedAt || 'unknown'}${Number.isFinite(ageH) ? ` · ${ageH < 1 ? 'under an hour' : `${Math.round(ageH)}h`} old` : ''}`);
  console.log(`  Scopes        ${Object.keys(snap.entities || {}).length} entities · ${Object.keys(snap.properties || {}).length} properties`);
  if (snap.partialCurrentMonth) {
    console.log('  Note          the in-progress month is EXCLUDED here. A half-posted month reads low');
    console.log('                by construction and comparing one is how two correct runs disagree.');
  }
  if (Number.isFinite(ageH) && ageH > 24) {
    console.log(`\n  ⚠ The snapshot is ${Math.round(ageH / 24)} day(s) old. A month restated since it was built will`);
    console.log('    disagree with a fresh export while both sides are right. Press Refresh, or use --live.');
  }
}

// ── the rollup identities ───────────────────────────────────────────────────
// Every one of these must hold whatever the numbers are, which is what makes them
// safe to keep in a repo that holds no figures — and what makes a failure mean
// something specific rather than "a number looks off".
function checkRollups(snap, win, keys) {
  const props = Object.entries(snap.properties || {});
  const entities = Object.entries(snap.entities || {});

  console.log('\n── Does each entity equal the buildings inside it? ──────────────────');
  const membership = new Map();
  for (const [pid, p] of props) {
    const e = p.entity || '(no entity)';
    if (!membership.has(e)) membership.set(e, []);
    membership.get(e).push({ pid, name: p.name });
  }

  // A property in no entity is money the tab shows at portfolio level and cannot
  // show at entity level. It is the single likeliest reason an entity figure comes
  // in under corporate's, so it is named rather than counted.
  const orphans = membership.get('(no entity)') || [];
  check(`every property maps to an entity (${props.length} properties)`,
    orphans.length === 0,
    orphans.length ? `${orphans.length} map to none: ${orphans.slice(0, 8).map(o => `${o.name} (id ${o.pid})`).join(', ')}${orphans.length > 8 ? ' …' : ''}` : '');

  const named = entities.map(([n]) => n);
  const unbuilt = [...membership.keys()].filter(e => e !== '(no entity)' && !named.includes(e));
  check('every entity a property claims is an entity the snapshot built',
    unbuilt.length === 0, unbuilt.join(', '));

  let worst = null, offEntities = 0;
  for (const [name, series] of entities) {
    const members = membership.get(name) || [];
    let entityWorst = null;
    for (const key of keys) {
      win.indexes.forEach((si, j) => {
        const rolled = (series[key] || [])[si] || 0;
        const summed = members.reduce((s, m) => s + ((snap.properties[m.pid][key] || [])[si] || 0), 0);
        const d = rolled - summed;
        if (Math.abs(d) > EPS && (!entityWorst || Math.abs(d) > Math.abs(entityWorst.d))) {
          entityWorst = { name, key, month: win.labels[j], rolled, summed, d, members: members.length };
        }
      });
    }
    if (entityWorst) {
      offEntities++;
      if (!worst || Math.abs(entityWorst.d) > Math.abs(worst.d)) worst = entityWorst;
    }
  }
  check(`each entity is exactly the sum of its own buildings (${entities.length} entities × ${keys.length} lines × ${win.labels.length} months)`,
    offEntities === 0,
    worst ? `worst: ${worst.name} ${worst.key} ${worst.month} — rollup ${money(worst.rolled)} vs its ${worst.members} building${worst.members === 1 ? '' : 's'} ${money(worst.summed)}, off by ${money(worst.d)}` : '');

  console.log('\n── Does the portfolio equal the entities? ───────────────────────────');
  // The check that separates "a building is in the wrong entity" (this passes,
  // the entity check fails) from "a building is in none, or in two" (this fails).
  let pWorst = null;
  for (const key of keys) {
    win.indexes.forEach((si, j) => {
      const total = ((snap.portfolio || {})[key] || [])[si] || 0;
      const summed = entities.reduce((s, [, e]) => s + ((e[key] || [])[si] || 0), 0);
      const d = total - summed;
      if (Math.abs(d) > EPS && (!pWorst || Math.abs(d) > Math.abs(pWorst.d))) {
        pWorst = { key, month: win.labels[j], total, summed, d };
      }
    });
  }
  check('the portfolio row is exactly the sum of the entities',
    pWorst === null,
    pWorst ? `worst: ${pWorst.key} ${pWorst.month} — portfolio ${money(pWorst.total)} vs entities ${money(pWorst.summed)}, off by ${money(pWorst.d)}`
      + '\n         a building in no entity makes this short; one counted twice makes it long' : '');

  let sWorst = null;
  for (const key of keys) {
    win.indexes.forEach((si, j) => {
      const total = ((snap.portfolio || {})[key] || [])[si] || 0;
      const summed = props.reduce((s, [, p]) => s + ((p[key] || [])[si] || 0), 0);
      const d = total - summed;
      if (Math.abs(d) > EPS && (!sWorst || Math.abs(d) > Math.abs(sWorst.d))) {
        sWorst = { key, month: win.labels[j], total, summed, d };
      }
    });
  }
  check('…and of the properties, so the two roads to the same total agree',
    sWorst === null,
    sWorst ? `worst: ${sWorst.key} ${sWorst.month} — portfolio ${money(sWorst.total)} vs properties ${money(sWorst.summed)}, off by ${money(sWorst.d)}` : '');

  console.log('\n── Is every month actually there? ───────────────────────────────────');
  // A category that is silently absent reads as a permanent $0, which on screen is
  // indistinguishable from "nothing was posted" — and in a reconciliation is
  // indistinguishable from corporate having a number we do not.
  const short = [];
  for (const [name, series] of entities) {
    for (const key of keys) {
      const arr = series[key];
      if (!Array.isArray(arr) || arr.length < (snap.months || []).length) short.push(`${name}.${key}`);
    }
  }
  check('every entity carries a full-length series for every tracked line',
    short.length === 0, short.slice(0, 10).join(', '));

  const allZero = keys.filter(key =>
    win.indexes.every(si => Math.abs(((snap.portfolio || {})[key] || [])[si] || 0) < 0.005));
  // Not a failure — a portfolio genuinely may not post commissions — but it is the
  // list to read first when a line is missing on one side of a comparison.
  if (allZero.length) {
    console.log(`  ·  ${allZero.length} tracked line(s) are $0 portfolio-wide for the whole window: ${allZero.join(', ')}`);
    console.log('     Check the GL mapping (CATEGORY_REFS) before reading a $0 as "nothing was spent".');
  }
  return membership;
}

// ── the same twelve months, pulled again from Rent Manager ──────────────────
async function checkLive(snap, win, keys, membership, only) {
  const pf = require('../services/propertyFinancials');
  console.log('\n── The same window, pulled again from Rent Manager ──────────────────');
  console.log('  One combined-scope accrual call per entity — the rollup checked against RM,');
  console.log('  not against itself.\n');

  const entities = Object.keys(snap.entities || {})
    .filter(n => !only || n.toLowerCase().includes(only.toLowerCase()));
  if (!entities.length) { console.log(`  (no entity matched "${only}")`); return; }

  for (const name of entities) {
    const members = (membership.get(name) || []);
    if (!members.length) { console.log(`  ${name}: no properties — nothing to pull`); continue; }
    let fresh;
    try {
      fresh = await pf.pullScopeSeries(members.map(m => m.pid).join(','), win.months);
    } catch (err) {
      check(`${name} — re-pulled from Rent Manager`, false, `pull failed: ${err.message}`);
      continue;
    }
    const off = [];
    for (const key of keys) {
      win.indexes.forEach((si, j) => {
        const ours = (snap.entities[name][key] || [])[si] || 0;
        const theirs = (fresh[key] || [])[j] || 0;
        if (Math.abs(ours - theirs) > EPS) {
          off.push({ key, month: win.labels[j], ours, theirs, d: ours - theirs });
        }
      });
    }
    check(`${name} (${members.length} buildings) — ${keys.length} lines × ${win.labels.length} months`,
      off.length === 0,
      off.slice(0, 6).map(o => `${o.key.padEnd(14)} ${o.month.padEnd(7)} tab ${money(o.ours).padStart(12)}   RM ${money(o.theirs).padStart(12)}   Δ ${money(o.d)}`)
        .join('\n         ') + (off.length > 6 ? `\n         …and ${off.length - 6} more cell(s)` : ''));
  }
}

// ── one line, twelve months, every scope — the meeting artifact ─────────────
function printLine(snap, win, key, label) {
  console.log(`\n── ${label} · trailing twelve, accrual ───────────────────────────────`);
  console.log('  Hand this beside corporate\'s figure. Where it differs, the shape of the');
  console.log('  difference is the answer: a whole month apart is timing, a flat percentage');
  console.log('  is a different set of buildings, one account\'s worth is the GL map.\n');

  const rows = [['Scope', ...win.labels, 'T-12']];
  const line = (name, series) => {
    const vals = win.indexes.map(si => (series[key] || [])[si] || 0);
    return [name, ...vals.map(v => Math.round(v)), Math.round(vals.reduce((a, b) => a + b, 0))];
  };
  rows.push(line('PORTFOLIO', snap.portfolio || {}));
  for (const [name, s] of Object.entries(snap.entities || {}).sort()) rows.push(line(name, s));

  const w = rows[0].map((_, c) => Math.max(...rows.map(r => String(r[c]).length)));
  rows.forEach((r, i) => {
    console.log('  ' + r.map((cell, c) => String(cell)[c === 0 ? 'padEnd' : 'padStart'](w[c])).join('  '));
    if (i === 0) console.log('  ' + w.map(n => '─'.repeat(n)).join('  '));
  });
  console.log(`\n  GL accounts on this line: ${(require('../services/propertyFinancials').CATEGORY_REFS[key] || []).join(' + ') || '(summary row)'}`);
  console.log('  Which GL accounts a line IS lives in services/propertyFinancials.js. If corporate');
  console.log('  counts an account we do not, that is where it is fixed — then a FULL recompute.');
}

// ── self-test ───────────────────────────────────────────────────────────────
// Every failure mode above, built by hand out of invented numbers, so the checks
// are proved rather than trusted. A reconciler that cannot fail is not a check.
function selftest() {
  const keys = ['totalIncome', 'insurance'];
  const months = ['Jan 26', 'Feb 26'];
  const S = (a, b) => [a, b];
  const base = () => ({
    refreshedAt: new Date().toISOString(),
    months, partialCurrentMonth: false,
    portfolio: { totalIncome: S(300, 300), insurance: S(30, 30) },
    entities: {
      'Birchwood Commons': { totalIncome: S(100, 100), insurance: S(10, 10) },
      Golden: { totalIncome: S(200, 200), insurance: S(20, 20) },
    },
    properties: {
      1: { name: 'A', entity: 'Birchwood Commons', totalIncome: S(100, 100), insurance: S(10, 10) },
      2: { name: 'B', entity: 'Golden', totalIncome: S(120, 120), insurance: S(12, 12) },
      3: { name: 'C', entity: 'Golden', totalIncome: S(80, 80), insurance: S(8, 8) },
    },
  });
  const run = (snap) => {
    const before = fails;
    const log = console.log; console.log = () => {};
    try { checkRollups(snap, windowOf(snap, null), keys); } finally { console.log = log; }
    return fails - before;
  };

  const t = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`); return ok; };
  let bad = 0;
  const record = (ok) => { if (!ok) bad++; };
  const reset = () => { fails = 0; checks = 0; };

  reset();
  record(t('a snapshot that ties raises nothing', run(base()) === 0));

  // A building in the wrong entity: both entities are off, the portfolio still ties.
  reset();
  let s = base(); s.properties[3].entity = 'Birchwood Commons';
  record(t('a building filed under the wrong entity is caught', run(s) > 0));

  // A building in no entity: the entity is short, the portfolio is right.
  reset();
  s = base(); s.properties[3].entity = null;
  record(t('a building in no entity is caught, and named', run(s) > 0));

  // A building counted twice: the portfolio is long and no property is wrong.
  reset();
  s = base(); s.portfolio.totalIncome = S(380, 380);
  record(t('a portfolio that does not equal its entities is caught', run(s) > 0));

  // A line silently truncated reads as $0 and looks like "nothing posted".
  reset();
  s = base(); s.entities['Birchwood Commons'].insurance = [10];
  record(t('a series short of a month is caught', run(s) > 0));

  reset();
  s = base();
  const win = windowOf(s, null);
  record(t('the window is the complete months only, in order',
    win.labels.join(',') === 'Jan 26,Feb 26' && win.from === '2026-01-01' && win.to === '2026-02-28',
    JSON.stringify({ from: win.from, to: win.to })));

  s = base(); s.months = ['Dec 25', 'Jan 26', 'Feb 26']; s.partialCurrentMonth = true;
  const w2 = windowOf(s, null);
  record(t('an in-progress month is excluded from the comparison',
    w2.labels.join(',') === 'Dec 25,Jan 26' && w2.indexes.join(',') === '0,1',
    JSON.stringify(w2.labels)));

  console.log(`\n${bad === 0 ? '✓' : '✗'} ${7 - bad}/7 self-tests passed`);
  return bad === 0 ? 0 : 1;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());

  const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const pf = require('../services/propertyFinancials');

  const file = arg('snapshot') || pf.SNAPSHOT_FILE;
  if (!fs.existsSync(file)) {
    console.error(`No P&L snapshot at ${file}.`);
    console.error('Press Refresh on the Overview or Variances tab (or POST');
    console.error('/api/financials/property-monthly/recompute?mode=full), then run this again.');
    process.exit(2);
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const win = windowOf(snap, pf);
  if (!win.labels.length) { console.error('The snapshot carries no complete months.'); process.exit(2); }

  const keys = (snap.categories && snap.categories.length ? snap.categories : pf.ALL_KEYS);
  printHeader(snap, win, pf);
  const membership = checkRollups(snap, win, keys);

  const lineWant = arg('line');
  if (lineWant) {
    const hit = keys.find(k => k.toLowerCase() === lineWant.toLowerCase())
      || keys.find(k => k.toLowerCase().includes(lineWant.toLowerCase()));
    if (!hit) {
      console.error(`\n"${lineWant}" is not a tracked line. Try one of: ${keys.join(', ')}`);
      process.exit(2);
    }
    printLine(snap, win, hit, hit);
  }

  if (argv.includes('--live')) {
    const rm = require('../services/rentManagerClient');
    if (!rm.isConfigured()) {
      console.log('\n── --live skipped: no Rent Manager credentials in .env ──────────────');
      fails++;
    } else {
      await checkLive(snap, win, keys, membership, arg('scope'));
    }
  } else {
    console.log('\n  (Add --live to re-pull every entity from Rent Manager and compare cell for cell.)');
  }

  console.log(`\n${fails === 0
    ? `✓ ${checks}/${checks} checks passed — every scope on the tab ties, on accrual, across the trailing twelve.`
    : `✗ ${fails} of ${checks} checks FAILED — read each one above before taking a figure to a meeting.`}`);
  process.exit(fails === 0 ? 0 : 1);
}

if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { windowOf, checkRollups };
