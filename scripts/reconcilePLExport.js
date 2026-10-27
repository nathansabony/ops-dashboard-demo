#!/usr/bin/env node
// Reconcile the Variance tab against the P&L EXPORT somebody is holding.
//
//   node scripts/reconcilePLExport.js entity.csv --scope Birchwood Commons
//   node scripts/reconcilePLExport.js entity.csv --scope Birchwood Commons --live
//   node scripts/reconcilePLExport.js --selftest
//
// ── why this script exists, when two already did ────────────────────────────
// The owner, 2026-08-25, with a Rent Manager "Profit & Loss 12 Month Recap" next to
// the tab: the insurance line did not tie, *"and we can't be doing the trackers if
// some of them are off."*
//
// We already had two reconcilers and NEITHER could have caught it:
//
//   • reconcileVariancePL.js proves the PIPELINE is faithful to report 45 —
//     months labelled right, nothing dropped, chunked pulls exact.
//   • compareDashboardToRM.js proves the DEPLOYED SNAPSHOT matches a fresh pull.
//
// Both compare us to us. They run the same report, with the same parameters,
// through the same category map, and then check that two copies of that agree.
// Every one of the four ways a number can be wrong in an argument with a human
// survives that: a category map that adds up the wrong ACCOUNTS, an entity whose
// PROPERTY SET is not the one the export was run for, a REPORT PARAMETER that
// differs from what the person clicked in RM, and a restatement that landed
// BETWEEN the two runs. All four look identical on screen — a number that is off.
//
// This one compares us to THE EXPORT: the artifact in the meeting, whatever RM
// printed, parsed as text. It has no opinion about which side is right; it says
// where they differ and, for each difference, what KIND of difference it is —
// which is the question that actually ends the argument.
//
// Contains no financial figures of its own (repo policy). Everything it prints
// comes from the two inputs; the self-test numbers are invented.

const fs = require('fs');
const path = require('path');

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_IDX = Object.fromEntries(MONTH_ABBR.map((m, i) => [m.toLowerCase(), i]));

// ── number parsing ──────────────────────────────────────────────────────────
// Accounting formats, all of which RM emits somewhere: 1,234.56 · (1,234.56) ·
// $1,234 · -1,234 · a bare dash for nothing.
const NUM_RE = /^\(?-?\$?-?[\d,]+(?:\.\d+)?\)?$|^-$|^—$/;
function parseNum(t) {
  const s = String(t).trim();
  if (s === '-' || s === '—' || s === '') return 0;
  const n = Number(s.replace(/[$,()\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return /\(/.test(s) ? -Math.abs(n) : n;
}

// "JAN 26" · "JAN26" · "Jan-26" · "01/2026" · "2026-01" → "Jan 26" (our label).
function monthLabel(token) {
  const t = String(token).trim().replace(/["']/g, '');
  let m = /^([A-Za-z]{3})[A-Za-z]*[\s\-/]*(\d{2,4})$/.exec(t);
  if (m && MONTH_IDX[m[1].toLowerCase()] !== undefined) {
    const yy = m[2].length === 4 ? m[2].slice(2) : m[2];
    return `${MONTH_ABBR[MONTH_IDX[m[1].toLowerCase()]]} ${yy}`;
  }
  m = /^(\d{1,2})[\-/](\d{4})$/.exec(t);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${MONTH_ABBR[+m[1] - 1]} ${m[2].slice(2)}`;
  m = /^(\d{4})[\-/](\d{1,2})$/.exec(t);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${MONTH_ABBR[+m[2] - 1]} ${m[1].slice(2)}`;
  return null;
}

// A line is either comma-separated (a real CSV / Excel export) or column-aligned
// text (copied straight out of the PDF), and telling them apart by eye is exactly
// what a script should not do:
//
//   • on a P&L nearly every comma is a THOUSANDS SEPARATOR, so counting commas
//     reads "5050 Insurance  1,000  2,000  3,000" as a four-field CSV row and
//     shreds it into "5050 Insurance  1" / "000  2" / "000  3";
//   • and the other way round, RM has real account names with commas in them
//     ("5710 Management Wages, Salary"), so a comma next to a letter does not
//     prove CSV either.
//
// So the file is parsed BOTH WAYS and the reading that recognises more account
// rows wins (see parseExport). No guessing, and a format nobody anticipated still
// gets whichever reading works better.
function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}
function cells(line, mode) {
  return mode === 'csv'
    ? splitCsv(line)
    : line.trim().split(/\s{2,}|\t+/).map(s => s.trim()).filter(Boolean);
}

// ── parsing the export ──────────────────────────────────────────────────────
// Rows are keyed by GL reference, exactly like the pipeline (services/property
// Financials.js): reference numbers are stable in RM's chart of accounts, account
// NAMES are not — and the PDF truncates them anyway ("5050 Insurance Expe…").
function parseOnce(text, mode) {
  const lines = text.split(/\r?\n/);
  const out = { scopeName: null, basis: null, runAt: null, months: [], rows: [], summary: {}, warnings: [] };

  for (const raw of lines) {
    const line = raw.replace(/ /g, ' ');
    if (!line.trim()) continue;

    if (!out.scopeName) {
      const m = /^\s*(?:Property|Owner|Entity|Group)\s*:\s*(.+?)\s*$/i.exec(line);
      if (m) { out.scopeName = m[1].trim(); continue; }
    }
    if (out.basis == null && /\b(accrual|cash)\b\s*basis|basis\s*[:=]?\s*(accrual|cash)/i.test(line)) {
      out.basis = /accrual/i.test(line) ? 'accrual' : 'cash';
    }
    if (!out.runAt) {
      const m = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\s+\d{1,2}:\d{2}\s*(AM|PM)?/i.exec(line);
      if (m) out.runAt = m[1];
    }

    const parts = cells(line, mode);
    if (parts.length < 3) continue;

    // The month header: the first line carrying several month tokens in a row.
    if (!out.months.length) {
      const labels = parts.map(monthLabel);
      const found = labels.filter(Boolean);
      if (found.length >= 3 && found.length >= parts.length - 3) {
        out.months = found;
        out.monthCols = labels.map((l, i) => (l ? i : -1)).filter(i => i >= 0);
        continue;
      }
    }
    if (!out.months.length) continue;

    // A data row: a label, then a run of numbers — one per month column.
    //
    // In CSV mode the fields already say where the label ends. In fixed-width mode
    // they do not: a long account name can sit ONE space away from its first
    // figure ("5402 Total Water & Sewer 2,000"), which splitting on runs of spaces
    // glues into a single token and silently costs that row its January. So the
    // numeric tail is taken off the END of the line instead, however it is spaced.
    let nums = [], label = '';
    if (mode === 'csv') {
      const numAt = [];
      parts.forEach((p, i) => { if (NUM_RE.test(p)) { const v = parseNum(p); if (v !== null) { nums.push(v); numAt.push(i); } } });
      if (!nums.length) continue;
      label = parts.slice(0, numAt[0]).join(' ').trim();
    } else {
      const m = /^(.*?)((?:\s+\(?-?\$?[\d,]+(?:\.\d+)?\)?)+)\s*$/.exec(line);
      if (!m) continue;
      label = m[1].trim();
      let toks = m[2].trim().split(/\s+/);
      // More numbers than the report has columns (+ its Total): the leading ones
      // belong to the label — an account whose NAME starts with a figure, printed
      // hard against its first column.
      const maxNums = out.months.length + 1;
      while (toks.length > maxNums) { label = `${label} ${toks.shift()}`.trim(); }
      nums = toks.map(parseNum).filter(v => v !== null);
    }
    if (nums.length < Math.max(2, Math.floor(out.months.length / 2))) continue;
    if (!label) continue;
    const refMatch = /^(\d{3,6}(?:-\d+)*)\b\s*(.*)$/.exec(label);

    // Values are placed by POSITION in the numeric run, which is how a fixed-width
    // report prints. A row that is short (fewer numbers than months) is reported
    // rather than guessed at — a silently mis-aligned row is worse than no row.
    const values = {};
    const n = Math.min(nums.length, out.months.length);
    for (let i = 0; i < n; i++) values[out.months[i]] = nums[i];
    const total = nums.length > out.months.length ? nums[out.months.length] : null;
    if (nums.length < out.months.length) {
      out.warnings.push(`row "${label.slice(0, 40)}" has ${nums.length} numbers for ${out.months.length} months — values placed left to right`);
    }

    const isTotalRow = /^total\b/i.test(label);
    const key = label.toLowerCase().replace(/\s+/g, ' ');
    if (!refMatch) {
      if (/^total\s+income/.test(key)) out.summary.totalIncome = { values, total };
      else if (/^total\s+expense/.test(key)) out.summary.totalExpense = { values, total };
      else if (/^noi\b/.test(key) || /net operating income/.test(key)) out.summary.noi = { values, total };
      continue;
    }
    out.rows.push({ ref: refMatch[1], name: refMatch[2] || '', isTotal: isTotalRow, values, total });
  }
  out.mode = mode;
  return out;
}

// Read it both ways, keep the reading that found more account rows. A tie goes to
// the fixed-width reading, which is what the PDF copy-paste produces.
function parseExport(text) {
  const fixed = parseOnce(text, 'fixed');
  const csv = parseOnce(text, 'csv');
  const score = p => p.rows.length * 100 + p.months.length;
  return score(csv) > score(fixed) ? csv : fixed;
}

// The export's value for a GL reference, under the same rule the pipeline uses:
// an account's own subtotal row when it has one (so children are not counted
// twice), otherwise the sum of the rows carrying that reference. A parent whose
// children print as `5402-1` style refs with no subtotal row is summed from them.
function exportValueForRef(parsed, ref, month) {
  const exact = parsed.rows.filter(r => r.ref === ref);
  if (exact.length) {
    const t = exact.find(r => r.isTotal);
    if (t) return { value: t.values[month] || 0, rows: [t] };
    return { value: exact.reduce((s, r) => s + (r.values[month] || 0), 0), rows: exact };
  }
  const kids = parsed.rows.filter(r => r.ref.startsWith(`${ref}-`));
  if (kids.length) return { value: kids.reduce((s, r) => s + (r.values[month] || 0), 0), rows: kids };
  return { value: null, rows: [] };   // the export has no such account at all
}

// ── classifying a difference ────────────────────────────────────────────────
// The point of the whole script. A raw list of disagreeing cells is what we had
// before; it starts an argument rather than settling one.
function classify(diffs, ours, theirs, months, parsed, catRefs, tol) {
  const byKey = new Map();
  for (const d of diffs) {
    if (!byKey.has(d.key)) byKey.set(d.key, []);
    byKey.get(d.key).push(d);
  }

  for (const d of diffs) {
    // (1) A month shift: the same money, one column over. This is what a
    //     post-date-vs-accounting-period difference looks like, and also what a
    //     journal entry moved between the two runs looks like.
    //     The cancellation is allowed to be approximate — a shifted entry usually
    //     travels with a small real difference on top of it, and demanding an exact
    //     ±$1 cancel is what makes a script say "unexplained" about the one pattern
    //     it exists to recognise.
    const band = Math.max(tol, Math.abs(d.delta) * 0.03);
    const sibling = byKey.get(d.key).find(o => Math.abs(o.mi - d.mi) === 1 && Math.abs(o.delta + d.delta) <= band);
    if (sibling) {
      const residual = d.delta + sibling.delta;
      d.kind = 'month-shift';
      d.detail = `the same amount is ${d.delta > 0 ? 'missing from' : 'extra in'} ${months[sibling.mi]} — one entry sitting in a different month on the two runs (an accounting-period vs post-date difference, or a re-post between them)`
        + (Math.abs(residual) > tol ? `. ${fmt(Math.abs(residual))} of the gap is left over once the shift is accounted for` : '');
      continue;
    }

    // (2) An account we do not add up. If some row in the export has, in this very
    //     month, a value equal to the gap, that row IS the gap — name it.
    const hit = parsed.rows.find(r => {
      if (r.isTotal) return false;
      const v = r.values[months[d.mi]];
      if (v == null || Math.abs(v) < tol) return false;
      return Math.abs(Math.abs(v) - Math.abs(d.delta)) <= tol;
    });
    if (hit) {
      const mapped = (catRefs[d.key] || []).some(ref => hit.ref === ref || hit.ref.startsWith(`${ref}-`));
      d.kind = mapped ? 'double-count' : 'category-map';
      d.detail = mapped
        ? `account ${hit.ref} ${hit.name} is being counted twice on this line`
        : `account ${hit.ref} ${hit.name} is exactly this size — ${d.delta > 0 ? 'the tab is including it and the export is not' : 'the export includes it and the tab does not'}. Fix in CATEGORY_REFS (services/propertyFinancials.js), not here.`;
      continue;
    }

    // (3) The whole line off by one ratio, every month → a different set of
    //     properties, not a different set of accounts.
    const line = byKey.get(d.key);
    if (line.length >= Math.max(3, months.length - 2)) {
      const ratios = line.filter(o => Math.abs(o.theirs) > tol).map(o => o.ours / o.theirs);
      if (ratios.length >= 3) {
        const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
        if (ratios.every(r => Math.abs(r - avg) < 0.02) && Math.abs(avg - 1) > 0.001) {
          d.kind = 'scope';
          d.detail = `every month on this line is ${(avg * 100).toFixed(1)}% of the export — the two runs cover different PROPERTIES, not different accounts`;
          continue;
        }
      }
    }
    d.kind = 'unexplained';
    d.detail = 'no shift, no account of this size, no constant ratio — check the report parameters (basis, period vs date, inactive properties) and the pull age';
  }
  return diffs;
}

// ── our side ────────────────────────────────────────────────────────────────
function loadSnapshot(file) {
  const p = file || path.join(__dirname, '..', 'data', 'property-pl-cache.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Resolve "Birchwood Commons" to a series in the snapshot: an entity, a property name, or a
// PropertyID. Ambiguity is reported, never guessed — picking the wrong side of an
// entity/property name collision is how you spend an afternoon on a real match.
function resolveScope(snap, want) {
  const hits = [];
  for (const name of Object.keys(snap.entities || {})) {
    if (name.toLowerCase() === want.toLowerCase()) hits.push({ type: 'Entity', name, series: snap.entities[name] });
  }
  for (const [pid, p] of Object.entries(snap.properties || {})) {
    if (String(pid) === want || String(p.name || '').toLowerCase().includes(want.toLowerCase())) {
      hits.push({ type: 'Property', name: `${p.name} (PropertyID ${pid})`, series: p, entity: p.entity });
    }
  }
  if (!hits.length) {
    for (const name of Object.keys(snap.entities || {})) {
      if (name.toLowerCase().includes(want.toLowerCase())) hits.push({ type: 'Entity', name, series: snap.entities[name] });
    }
  }
  return hits;
}

function fmt(v) {
  if (v == null) return '—';
  const s = v < 0 ? '-' : '';
  return `${s}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
}

// ── report ──────────────────────────────────────────────────────────────────
function reconcile({ parsed, ourMonths, ourSeries, catRefs, categoryLabel, tol, snapshotAge, scopeLabel }) {
  const months = parsed.months.filter(m => ourMonths.includes(m));
  const skipped = parsed.months.filter(m => !ourMonths.includes(m));
  const lines = [];
  const diffs = [];
  let compared = 0, tied = 0;

  const keys = Object.keys(catRefs).filter(k => !k.startsWith('waterSub'));
  for (const key of keys) {
    const refs = catRefs[key];
    for (let mi = 0; mi < months.length; mi++) {
      const month = months[mi];
      let theirs = null, present = false;
      for (const ref of refs) {
        const got = exportValueForRef(parsed, ref, month);
        if (got.value != null) { theirs = (theirs || 0) + got.value; present = true; }
      }
      if (!present) continue;                       // the export does not carry this line at all
      const oi = ourMonths.indexOf(month);
      const ours = (ourSeries[key] || [])[oi];
      if (ours == null) continue;
      compared++;
      const delta = ours - theirs;
      if (Math.abs(delta) <= tol) { tied++; continue; }
      diffs.push({ key, label: categoryLabel[key] || key, mi, month, ours, theirs, delta });
    }
  }

  // Summary rows, when the export prints them.
  for (const [key, row] of Object.entries(parsed.summary)) {
    for (let mi = 0; mi < months.length; mi++) {
      const month = months[mi];
      const theirs = row.values[month];
      const oi = ourMonths.indexOf(month);
      const ours = (ourSeries[key] || [])[oi];
      if (theirs == null || ours == null) continue;
      compared++;
      const delta = ours - theirs;
      if (Math.abs(delta) <= tol) { tied++; continue; }
      diffs.push({ key, label: categoryLabel[key] || key, mi, month, ours, theirs, delta });
    }
  }

  classify(diffs, ourSeries, parsed, months, parsed, catRefs, tol);

  // Accounts in the export that no tracked line adds up. Not an error — most of
  // the chart is untracked on purpose — but it is the list to read when a category
  // is short, so it is printed whenever something disagrees.
  const mappedRefs = new Set();
  Object.values(catRefs).forEach(rs => rs.forEach(r => mappedRefs.add(r)));
  const unmapped = parsed.rows.filter(r => !r.isTotal
    && ![...mappedRefs].some(ref => r.ref === ref || r.ref.startsWith(`${ref}-`)));

  return { months, skipped, diffs, compared, tied, unmapped, lines, snapshotAge, scopeLabel };
}

function printReport(res, parsed, opts) {
  const { months, diffs, compared, tied, unmapped } = res;
  console.log(`\nExport   : ${parsed.scopeName || '(no scope line found)'}${parsed.runAt ? ` · run ${parsed.runAt}` : ''}${parsed.basis ? ` · ${parsed.basis} basis` : ''}`);
  console.log(`Tab      : ${res.scopeLabel}${res.snapshotAge != null ? ` · snapshot ${res.snapshotAge}` : ''}`);
  console.log(`Months   : ${months.length ? `${months[0]} … ${months[months.length - 1]}` : '(none in common)'}${res.skipped.length ? ` · ${res.skipped.length} export month(s) outside the tab's window: ${res.skipped.join(', ')}` : ''}`);
  if (parsed.basis === 'cash') {
    console.log('\n⚠ This export is CASH basis. The tab is ACCRUAL (report 45, Basis=1).');
    console.log('  They answer different questions and are supposed to differ — re-run the');
    console.log('  export on Accrual before reading anything below as a defect.');
  }
  parsed.warnings.forEach(w => console.log(`⚠ ${w}`));

  console.log(`\n${tied}/${compared} cells tie within $${opts.tol}.`);
  if (!diffs.length) {
    console.log('\n✓ Every line the export carries matches the tab, month for month.');
    return 0;
  }

  const byKind = {};
  diffs.forEach(d => { (byKind[d.kind] = byKind[d.kind] || []).push(d); });
  const order = ['scope', 'category-map', 'double-count', 'month-shift', 'unexplained'];
  const HEAD = {
    scope: 'DIFFERENT PROPERTIES — the two runs do not cover the same buildings',
    'category-map': 'DIFFERENT ACCOUNTS — a GL account one side counts and the other does not',
    'double-count': 'DOUBLE COUNT — an account added twice on one line',
    'month-shift': 'SAME MONEY, DIFFERENT MONTH — a timing difference between the two runs',
    unexplained: 'UNEXPLAINED — none of the known shapes fit',
  };
  for (const kind of order) {
    const list = byKind[kind];
    if (!list || !list.length) continue;
    console.log(`\n${HEAD[kind]}  (${list.length} cell${list.length === 1 ? '' : 's'})`);
    const seen = new Set();
    for (const d of list) {
      console.log(`  ${d.label.padEnd(18)} ${d.month.padEnd(7)} tab ${fmt(d.ours).padStart(12)}   export ${fmt(d.theirs).padStart(12)}   Δ ${fmt(d.delta).padStart(12)}`);
      const k = `${d.key}:${d.kind}:${d.detail}`;
      if (!seen.has(k)) { seen.add(k); console.log(`      → ${d.detail}`); }
    }
  }

  if (unmapped.length) {
    console.log(`\nAccounts in this export that no tracked line adds up (${unmapped.length}) —`);
    console.log('read this list when a category comes up short:');
    const refs = [...new Set(unmapped.map(r => `${r.ref} ${r.name}`.trim()))];
    refs.slice(0, 25).forEach(r => console.log(`  ${r}`));
    if (refs.length > 25) console.log(`  …and ${refs.length - 25} more`);
  }

  console.log('\nWhat to do with each kind:');
  if (byKind.scope) console.log('  scope        → compare the property list. The tab builds an entity from RM BillingName1\n                 (services/entityMap.js); an export run on a property GROUP is a different set.');
  if (byKind['category-map'] || byKind['double-count']) console.log('  accounts     → fix CATEGORY_REFS in services/propertyFinancials.js, then a FULL recompute\n                 (an incremental refresh keeps the old mapping for months it seeds).');
  if (byKind['month-shift']) console.log('  month-shift  → check whether the export was run by ACCOUNTING PERIOD and the tab by date\n                 (the tab passes RunByPeriod=false), and whether the entry moved between runs.');
  if (byKind.unexplained) console.log('  unexplained  → re-run npm run check:variance-pl (pipeline vs report) and\n                 node scripts/compareDashboardToRM.js (snapshot vs fresh pull) for this scope.');
  return 1;
}

// ── self-test ───────────────────────────────────────────────────────────────
// Synthetic export + synthetic tab, one per classification, so the classifier is
// proved rather than trusted. Invented numbers only.
function selftest() {
  const catRefs = { insurance: ['5050', '5051'], waterSewer: ['5402'], mgmtFees: ['5000'] };
  const labels = { insurance: 'Insurance', waterSewer: 'Water & Sewer', mgmtFees: 'Management Fees' };
  const months = ['Jan 26', 'Feb 26', 'Mar 26', 'Apr 26'];
  const header = `                        ${months.map(m => m.toUpperCase().replace(' ', ' ')).join('  ')}`;
  let fails = 0;
  const t = (name, ok, detail) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
    if (!ok) fails++;
  };

  const build = rows => `Profit & Loss 12 Month Recap\nProperty: Testville\nMonthly recap 01/01/26 - 04/30/26  (accrual basis)\n${header}\n${rows.join('\n')}\n`;

  // 1. everything ties
  {
    const ex = build([
      '5050 Insurance Expense     1,000  1,000  1,000  1,000',
      '5051 Car Insurance            10     10     10     10',
      '5402 Total Water & Sewer   2,000  2,000  2,000  2,000',
    ]);
    const parsed = parseExport(ex);
    t('parses the month header', parsed.months.join(',') === months.join(','), parsed.months.join(','));
    t('reads the basis off the export', parsed.basis === 'accrual', String(parsed.basis));
    const res = reconcile({ parsed, ourMonths: months, ourSeries: { insurance: [1010, 1010, 1010, 1010], waterSewer: [2000, 2000, 2000, 2000] }, catRefs, categoryLabel: labels, tol: 1, scopeLabel: 'test' });
    t('a matching tab reports no differences', res.diffs.length === 0 && res.tied === res.compared, `${res.tied}/${res.compared}`);
  }

  // 2. a month shift
  {
    const parsed = parseExport(build(['5050 Insurance Expense   1,000  1,000  1,000  1,000']));
    const res = reconcile({ parsed, ourMonths: months, ourSeries: { insurance: [1000, 1000, 1500, 500] }, catRefs, categoryLabel: labels, tol: 1, scopeLabel: 'test' });
    t('an amount sitting one month over is called a month-shift',
      res.diffs.length === 2 && res.diffs.every(d => d.kind === 'month-shift'),
      res.diffs.map(d => `${d.month}:${d.kind}`).join(' '));
  }

  // 2b. a month shift carrying a small real difference on top of it
  {
    const parsed = parseExport(build(['5050 Insurance Expense   1,000  1,000  1,000  1,000']));
    const res = reconcile({ parsed, ourMonths: months, ourSeries: { insurance: [1000, 1000, 1520, 490] }, catRefs, categoryLabel: labels, tol: 1, scopeLabel: 'test' });
    t('a shift that does not cancel to the dollar is still a month-shift, with the residual named',
      res.diffs.length === 2 && res.diffs.every(d => d.kind === 'month-shift') && /left over/.test(res.diffs[0].detail),
      res.diffs.map(d => d.kind).join(' '));
  }

  // 3. an account one side counts
  {
    const parsed = parseExport(build([
      '5050 Insurance Expense   1,000  1,000  1,000  1,000',
      '5051 Car Insurance          10     10     10     10',
      '5052 Flood Insurance       250    250    250    250',
    ]));
    // the tab is over by exactly 5052 every month (as if it were in CATEGORY_REFS)
    const res = reconcile({ parsed, ourMonths: months, ourSeries: { insurance: [1260, 1260, 1260, 1260] }, catRefs, categoryLabel: labels, tol: 1, scopeLabel: 'test' });
    t('a gap the size of one account names that account',
      res.diffs.length && res.diffs.every(d => d.kind === 'category-map' && /5052/.test(d.detail)),
      res.diffs.map(d => d.kind).join(' '));
    t('and that account is listed as unmapped', res.unmapped.some(r => r.ref === '5052'));
  }

  // 4. a different property set
  {
    const parsed = parseExport(build([
      '5050 Insurance Expense   1,000  1,200    900  1,100',
      '5402 Total Water & Sewer 2,000  2,400  1,800  2,200',
    ]));
    const res = reconcile({ parsed, ourMonths: months,
      ourSeries: { insurance: [900, 1080, 810, 990], waterSewer: [1800, 2160, 1620, 1980] },
      catRefs, categoryLabel: labels, tol: 1, scopeLabel: 'test' });
    t('a constant ratio across every month is called a scope difference',
      res.diffs.length === 8 && res.diffs.every(d => d.kind === 'scope'),
      res.diffs.map(d => d.kind).join(' '));
  }

  // 5. a parent summed from children, and a CSV export
  {
    const csv = ['Profit & Loss', 'Property: Testville', 'GL,Name,JAN 26,FEB 26,MAR 26,APR 26',
      '5402-1,Utilities Water,"1,000","1,000","1,000","1,000"',
      '5402-2,Utilities Sewer,500,500,500,500',
      '5402-3,Solid Waste,100,100,100,100'].join('\n');
    const parsed = parseExport(csv);
    const res = reconcile({ parsed, ourMonths: months, ourSeries: { waterSewer: [1600, 1600, 1600, 1600] }, catRefs, categoryLabel: labels, tol: 1, scopeLabel: 'test' });
    t('a CSV export parses and a parent sums from its children',
      res.compared === 4 && res.diffs.length === 0, `${res.tied}/${res.compared} tied, ${res.diffs.length} diffs`);
  }

  // 6. negatives in accounting parentheses
  {
    const parsed = parseExport(build(['5050 Insurance Expense   1,000  (8,023)  1,000  1,000']));
    t('a parenthesised credit parses as negative',
      parsed.rows[0].values['Feb 26'] === -8023, String(parsed.rows[0].values['Feb 26']));
  }

  // 7. a cash-basis export is called out rather than diffed as a defect
  {
    const parsed = parseExport('Property: Testville\nRun on a cash basis\n' + header + '\n5050 Insurance Expense 1,000 1,000 1,000 1,000');
    t('a cash-basis export is detected', parsed.basis === 'cash', String(parsed.basis));
  }

  console.log(fails === 0 ? '\n✓ self-test passed' : `\n✗ ${fails} self-test failure(s)`);
  return fails === 0 ? 0 : 1;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());

  const file = argv.find(a => !a.startsWith('--'));
  const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
  const tol = Number(arg('tol') || 1);
  const scopeWant = arg('scope');
  if (!file) {
    console.error(`usage: node scripts/reconcilePLExport.js <export.csv|export.txt> --scope "<entity or property>" [--live] [--tol 1]

Save the RM "Profit & Loss 12 Month Recap" as CSV, or paste the columns out of the
PDF into a text file — either parses. --live pulls this scope from RM instead of
reading the cached snapshot (needs .env credentials); --selftest proves the
classifier against synthetic exports.`);
    process.exit(2);
  }

  const parsed = parseExport(fs.readFileSync(file, 'utf8'));
  if (!parsed.months.length) {
    console.error('Could not find a month header in that file. It needs one line carrying the month');
    console.error('columns — "JAN 26  FEB 26  …" or "…,JAN 26,FEB 26,…" — above the account rows.');
    process.exit(2);
  }
  const want = scopeWant || parsed.scopeName;
  if (!want) {
    console.error('No --scope given and no "Property:" line in the export — which scope is this?');
    process.exit(2);
  }

  const pf = require('../services/propertyFinancials');
  const categoryLabel = {
    propTax: 'Property Taxes', mgmtFees: 'Management Fees', insurance: 'Insurance',
    heatingGas: 'Heating Gas', waterSewer: 'Water & Sewer', electric: 'Electric',
    repairsMaint: 'Repairs & Maint', turnover: 'Turnover', payroll: 'Payroll',
    mgmtWages: 'Mgmt Wages', mortgage: 'Mortgage Interest', renCapital: 'REN Capital',
    majRepairs: 'Major Repairs', commissions: 'Commissions', advertising: 'Advertising',
    totalIncome: 'Total Income', totalExpense: 'Operating Expense', noi: 'NOI',
  };

  let ourMonths, ourSeries, scopeLabel, snapshotAge = null;

  if (argv.includes('--live')) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    const rm = require('../services/rentManagerClient');
    const { buildPropertyEntityMap } = require('../services/entityMap');
    const { byId, entities } = await buildPropertyEntityMap(rm);
    let ids = entities[want];
    if (!ids) {
      const hit = [...byId.entries()].find(([id, m]) => String(id) === want || m.name.toLowerCase().includes(want.toLowerCase()));
      if (!hit) { console.error(`No entity or property matched "${want}".`); process.exit(2); }
      ids = [hit[0]];
    }
    // Pull exactly the export's months, so nothing is compared across a window edge.
    const ym = l => { const [mon, yy] = l.split(' '); return `${2000 + Number(yy)}-${String(MONTH_IDX[mon.toLowerCase()] + 1).padStart(2, '0')}`; };
    const monthsMeta = pf.enumerateMonths(ym(parsed.months[0]), ym(parsed.months[parsed.months.length - 1]));
    const total = {};
    for (const id of ids) {
      const s = await pf.pullScopeSeries(String(id), monthsMeta);
      for (const k of pf.ALL_KEYS) {
        total[k] = total[k] || monthsMeta.map(() => 0);
        s[k].forEach((v, i) => { total[k][i] += v; });
      }
    }
    ourMonths = monthsMeta.map(m => m.label);
    ourSeries = total;
    scopeLabel = `${want} — live pull of ${ids.length} propert${ids.length === 1 ? 'y' : 'ies'}`;
  } else {
    const snap = loadSnapshot(arg('snapshot'));
    if (!snap) {
      console.error('No P&L snapshot at data/property-pl-cache.json. Pass --snapshot <file>, or --live to pull from RM.');
      process.exit(2);
    }
    const hits = resolveScope(snap, want);
    if (!hits.length) { console.error(`"${want}" is not an entity or property in the snapshot.`); process.exit(2); }
    if (hits.length > 1) {
      console.error(`"${want}" matches ${hits.length} scopes — name one exactly:`);
      hits.forEach(h => console.error(`  ${h.type}: ${h.name}`));
      process.exit(2);
    }
    ourMonths = snap.months;
    ourSeries = hits[0].series;
    scopeLabel = `${hits[0].type} ${hits[0].name}`;
    const ageH = (Date.now() - Date.parse(snap.refreshedAt || 0)) / 3600000;
    snapshotAge = Number.isFinite(ageH) ? `pulled ${ageH < 1 ? 'under an hour' : `${Math.round(ageH)}h`} ago` : 'age unknown';
    if (Number.isFinite(ageH) && ageH > 24) {
      console.log(`\n⚠ The snapshot is ${Math.round(ageH / 24)} day(s) old. A month restated since it was built`);
      console.log('  will disagree here and be right on both sides — press Refresh, or use --live.');
    }
  }

  const res = reconcile({ parsed, ourMonths, ourSeries, catRefs: pf.CATEGORY_REFS, categoryLabel, tol, snapshotAge, scopeLabel });
  process.exit(printReport(res, parsed, { tol }));
}

if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { parseExport, exportValueForRef, reconcile, classify, parseNum, monthLabel };
