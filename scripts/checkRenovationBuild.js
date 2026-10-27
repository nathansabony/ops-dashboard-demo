// Offline check for the renovation (non-operating) expense pipeline.
//
// Every other RM service on this site is verified by pointing a probe at the live
// API, which means it can only be verified by someone holding credentials. This
// one is checked here instead: Rent Manager is stubbed with fixtures and
// services/renovationExpenses.js is run end to end, so the parts that are pure
// logic — GL account resolution, unit attribution, the per-property vs
// portfolio-wide decision, and the P&L cross-check — are provable in CI and on a
// dev box with an empty .env.
//
// What it deliberately does NOT prove: the shape Rent Manager actually returns.
// That is what scripts/probeRenovationApi.js is for, and it needs credentials.
//
//   node scripts/checkRenovationBuild.js

const path = require('path');
const assert = require('assert');

// ── Fixtures ────────────────────────────────────────────────────────────────
const GL_ACCOUNTS = [
  { GLAccountID: 900, Reference: '6100',   Name: 'Total REN - Capital Expense', GLAccountTypeName: 'N/O EXPENSE' },
  { GLAccountID: 901, Reference: '6100-1', Name: 'REN - Kitchens',              GLAccountTypeName: 'N/O EXPENSE' },
  { GLAccountID: 902, Reference: '6100-2', Name: 'REN - Bathrooms',             GLAccountTypeName: 'N/O EXPENSE' },
  { GLAccountID: 500, Reference: '5100',   Name: 'Total Repairs & Maintenance', GLAccountTypeName: 'Expense' },
  { GLAccountID: 903, Reference: '6150',   Name: 'REN - Exterior Rehab',        GLAccountTypeName: 'N/O EXPENSE' },
  { GLAccountID: 904, Reference: '6230',   Name: 'Mortgage Interest Expense',   GLAccountTypeName: 'N/O EXPENSE' },
  // 2026-08-25: majors join the set, exterminating is excluded by name and by
  // reference, and a licence account is surfaced as a candidate rather than
  // guessed at.
  // The real chart is FLAT: the major accounts are siblings of 5150, not children
  // of it (5151, 5152, 5220…, never 5150-1). Rooting at 5150 reached exactly one of
  // them and left nineteen in the "not included" list — 2026-08-26.
  { GLAccountID: 515, Reference: '5150',   Name: 'Major - Repair & Maint',       GLAccountTypeName: 'N/O EXPENSE' },
  { GLAccountID: 517, Reference: '5151',   Name: 'Major - Electric',             GLAccountTypeName: 'N/O EXPENSE' },
  { GLAccountID: 518, Reference: '5156',   Name: 'Major- Turnover',              GLAccountTypeName: 'N/O EXPENSE' },
  { GLAccountID: 519, Reference: '5224',   Name: 'Major - Tile & Granite Supplies', GLAccountTypeName: 'N/O EXPENSE' },
  { GLAccountID: 520, Reference: '5177',   Name: 'Major - Exterminating',        GLAccountTypeName: 'N/O EXPENSE' },
  { GLAccountID: 503, Reference: '5031',   Name: 'Exterminating',                GLAccountTypeName: 'Expense' },
  { GLAccountID: 507, Reference: '5075',   Name: 'Licenses & Permits',           GLAccountTypeName: 'Expense' },
];

// 107 and 109 are billed to Demo Portfolio (services/entityMap.js); 999 is billed to a former owner, so it
// must be filtered out before a single report run is spent on it.
const PROPERTIES = [
  { PropertyID: 107, Name: 'Grand Ave', ShortName: 'GRAND', BillingName1: 'Demo Portfolio', IsActive: true },
  { PropertyID: 109, Name: 'Maple Court Ave', ShortName: 'MAPLE', BillingName1: 'Demo Portfolio', IsActive: true },
  { PropertyID: 999, Name: 'Sold Street', ShortName: 'SOLD', BillingName1: 'Former Owner, LLC', IsActive: true },
];

const UNITS = [
  { UnitID: 1, PropertyID: 107, Name: '2R' },
  { UnitID: 2, PropertyID: 107, Name: '3B' },
  { UnitID: 3, PropertyID: 109, Name: '1A' },
];

// Report 51 rows, per property. Note the deliberate variety:
//   • 107 carries a unit RM stated outright (UnitName) AND one only findable in
//     the description, so both attribution paths are exercised.
//   • 107 also has a credit (a returned vanity), so signed amounts are exercised.
//   • 109's postings sum to $100 LESS than the P&L says, so the cross-check has
//     something real to catch.
//   • both properties carry RM's non-posting rows (a begin-balance line and a
//     "No activity in the period" placeholder) that must be filtered out.
const POSTINGS = {
  107: [
    { TransactionDate: '2026-05-14T00:00:00', TransactionType: 'Bill', TransactionReference: 'INV-8842',
      Description: 'Kitchen cabinets', CustomerName: 'Kruger Supply', UnitName: '2R',
      GLAccountID: 901, GLAccountName: 'REN - Kitchens', PropertyShortName: 'GRAND', Debit: '4,500.00', Credit: '' },
    { TransactionDate: '2026-06-02T00:00:00', TransactionType: 'Bill', TransactionReference: 'INV-9001',
      Description: 'Unit 3B bathroom tile', CustomerName: 'Tile Depot',
      GLAccountID: 902, GLAccountName: 'REN - Bathrooms', PropertyShortName: 'GRAND', Debit: '2,000.00', Credit: '' },
    { TransactionDate: '2026-06-20T00:00:00', TransactionType: 'Credit', TransactionReference: 'CM-12',
      Description: 'Returned vanity', CustomerName: 'Tile Depot',
      GLAccountID: 902, GLAccountName: 'REN - Bathrooms', PropertyShortName: 'GRAND', Debit: '', Credit: '300.00' },
    { TransactionDate: '', Description: 'BeginBalance', GLAccountID: 901, Debit: '1,000.00', Credit: '' },
    { TransactionDate: '0001-01-01T00:00:00', Description: 'No activity in the period', GLAccountID: 902, Debit: '', Credit: '' },
  ],
  109: [
    { TransactionDate: '2026-07-09T00:00:00', TransactionType: 'Bill', TransactionReference: 'INV-7777',
      Description: 'Common hallway paint', CustomerName: 'ProPaint',
      GLAccountID: 900, GLAccountName: 'Total REN - Capital Expense', PropertyShortName: 'MAPLE', Debit: '1,400.00', Credit: '' },
  ],
};

// The monthly P&L snapshot the shortlist is read from. 109 claims $1,500 against
// $1,400 of postings — a $100 gap the reconciliation has to surface.
const PL_SNAPSHOT = {
  refreshedAt: '2026-08-24T09:00:00.000Z',
  months: ['Jan 26', 'Feb 26', 'Mar 26', 'Apr 26', 'May 26', 'Jun 26', 'Jul 26', 'Aug 26'],
  properties: {
    107: { name: 'Grand Ave', entity: 'Demo Portfolio', renCapital: [0, 0, 0, 0, 4500, 1700, 0, 0] },
    109: { name: 'Maple Court Ave', entity: 'Demo Portfolio', renCapital: [0, 0, 0, 0, 0, 0, 1500, 0] },
    999: { name: 'Sold Street', entity: 'Demo Portfolio', renCapital: [0, 0, 0, 0, 0, 0, 9999, 0] },
  },
};

// ── Stub Rent Manager ───────────────────────────────────────────────────────
const calls = { runReport: [], properties: 0, units: 0, glAccounts: 0 };

function paramValue(params, name) {
  for (const [k, v] of Object.entries(params)) {
    if (/\.Parameter$/.test(k) && v === name) {
      return params[k.replace(/\.Parameter$/, '.Value')];
    }
  }
  return null;
}

const stub = {
  isConfigured: () => true,
  Properties: async () => { calls.properties += 1; return PROPERTIES; },
  Units: async ({ pageNumber }) => { calls.units += 1; return pageNumber > 1 ? [] : UNITS; },
  GLAccounts: async () => { calls.glAccounts += 1; return GL_ACCOUNTS; },
  // The service reads the whole chart through allGLAccounts; route it through
  // GLAccounts so the call counts and the chart swaps below still apply.
  allGLAccounts: async () => stub.GLAccounts(),
  RunReport: async (reportId, params) => {
    const propOwnerIds = String(paramValue(params, 'PropOwnerIDs') || '');
    const glIds = String(paramValue(params, 'GLAccountIDs') || '');
    calls.runReport.push({ reportId, propOwnerIds, glIds, isSummary: paramValue(params, 'IsSummary') });
    const ids = propOwnerIds.split(',').map(Number).filter(Number.isFinite);
    return ids.flatMap(id => POSTINGS[id] || []);
  },
  get: async () => { throw new Error('not stubbed'); },
};

require.cache[require.resolve(path.join(__dirname, '..', 'services', 'rentManagerClient.js'))] = {
  id: 'rmStub', filename: 'rmStub', loaded: true, exports: stub,
};

const propertyFinancials = require('../services/propertyFinancials');
const renovationExpenses = require('../services/renovationExpenses');

const NOW = new Date('2026-08-24T12:00:00Z');
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ── Checks ──────────────────────────────────────────────────────────────────

check('window covers the configured trailing months, ending with the current month', () => {
  const w = renovationExpenses.defaultWindow(NOW);
  assert.strictEqual(w.to, '2026-08-31', 'window must run through the end of the current month');
  assert.strictEqual(w.from, '2024-09-01', `24 months back from Aug 2026 is Sep 2024, got ${w.from}`);
});

check('GL resolution takes 6100 and 5150 with their children, and nothing else', async () => {
  const { included, candidates } = await renovationExpenses.resolveAccounts();
  const refs = included.map(a => a.ref).sort();
  // 5150 (majors) joined the default set on 2026-08-25 — "add major expense
  // accounts alongside renovation accounts".
  // Every "Major - …" account, whatever its number, plus the renovation tree.
  assert.deepStrictEqual(refs, ['5150', '5151', '5156', '5224', '6100', '6100-1', '6100-2'], `got ${refs.join(', ')}`);
  assert.ok(!refs.includes('5100'), 'operating R&M must never be included');
  assert.ok(!refs.includes('5031'), 'exterminating is excluded by the client\'s direction');
  assert.ok(!refs.includes('5177'), 'and "Major - Exterminating" is excluded by NAME, whatever number it carries');
  assert.ok(!refs.includes('5075'), 'licences are wanted but their reference was never confirmed — never guessed');
  assert.strictEqual(included.find(a => a.ref === '5151').matchedBy, 'name-pattern',
    'a sibling major is reached by the naming convention, not by a reference root');

  // The accounts NOT included but that look like they might belong are the whole
  // point of the "confirm the GL mapping" panel — if this list came back empty the
  // panel would silently certify a mapping nobody checked.
  const candRefs = candidates.map(c => c.ref).sort();
  assert.ok(candRefs.includes('6150'), 'REN - Exterior Rehab should be offered as a candidate');
  assert.ok(candRefs.includes('6230'), 'a non-operating account type should be offered as a candidate');
  assert.ok(!candRefs.includes('6100-1'), 'an included account must not also be a candidate');
  assert.ok(candRefs.includes('5075'), 'a licence account must be OFFERED, since it was asked for but never confirmed');
  assert.ok(!candRefs.includes('5031'), 'a deliberately excluded account must not be suggested either');
});

// Exterminating is excluded by NAME as well as by reference, because matchRefs can
// reach an account through RM's parent linkage or a name match — routes the root
// list never names. Excluding by omission would not have held.
check('an excluded account cannot arrive through the hierarchy either', async () => {
  const chart = [
    { GLAccountID: 515, Reference: '5150', Name: 'Total Major - Repair & Maint', GLAccountTypeName: 'N/O EXPENSE' },
    { GLAccountID: 503, Reference: '5031', Name: 'Major - Exterminating contract', GLAccountTypeName: 'N/O EXPENSE', ParentGLAccountID: 515 },
    { GLAccountID: 516, Reference: '5150-1', Name: 'Major - Roof', GLAccountTypeName: 'N/O EXPENSE', ParentGLAccountID: 515 },
  ];
  const prev = stub.GLAccounts;
  stub.GLAccounts = async () => chart;
  renovationExpenses.__resetAccountCache();
  try {
    const { included } = await renovationExpenses.resolveAccounts();
    const refs = included.map(a => a.ref).sort();
    assert.ok(!refs.includes('5031'), `exterminating rode in through the hierarchy: ${refs.join(', ')}`);
    assert.ok(refs.includes('5150-1'), 'the rest of the majors tree must still come through');
  } finally {
    stub.GLAccounts = prev;
    renovationExpenses.__resetAccountCache();
  }
});

// The live pull's first failure, pinned as a regression: 6100 is a roll-up with no
// postings of its own, and its children are NOT numbered `6100-N` on every Rent
// Manager. Resolving only the reference prefix filtered the transaction report to
// an empty container — 194 summary rows, zero charges, and all 97 properties
// reported as "does not tie".
check('a roll-up account resolves to the children RM links to it', async () => {
  const flat = [
    { GLAccountID: 900, Reference: '6100', Name: 'Total REN - Capital Expense', GLAccountTypeName: 'N/O EXPENSE' },
    { GLAccountID: 911, Reference: '6101', Name: 'REN - Kitchens', GLAccountTypeName: 'N/O EXPENSE', ParentGLAccountID: 900 },
    { GLAccountID: 912, Reference: '6102', Name: 'REN - Bathrooms', GLAccountTypeName: 'N/O EXPENSE', ParentGLAccountID: 900 },
    { GLAccountID: 913, Reference: '6102-A', Name: 'REN - Bath fixtures', GLAccountTypeName: 'N/O EXPENSE', ParentGLAccountID: 912 },
    { GLAccountID: 500, Reference: '5100', Name: 'Repairs & Maintenance', GLAccountTypeName: 'Expense' },
  ];
  const prev = stub.GLAccounts;
  stub.GLAccounts = async () => flat;
  renovationExpenses.__resetAccountCache();
  try {
    const { included } = await renovationExpenses.resolveAccounts();
    const refs = included.map(a => a.ref).sort();
    assert.deepStrictEqual(refs, ['6100', '6101', '6102', '6102-A'],
      `the roll-up's children must come through, got ${refs.join(', ')}`);
    // Grandchildren too — the chart is a tree, not two levels.
    const gc = included.find(a => a.ref === '6102-A');
    assert.strictEqual(gc.matchedBy, 'hierarchy');
    assert.ok(!refs.includes('5100'), 'an operating account must never be pulled in');
  } finally {
    stub.GLAccounts = prev;
    renovationExpenses.__resetAccountCache();
  }
});

check('a roll-up with no reachable children falls back to name matching', async () => {
  // Same chart, but RM exposes no parent linkage at all. Without a fallback the
  // tab shows $0 against a P&L reporting millions.
  const orphaned = [
    { GLAccountID: 900, Reference: '6100', Name: 'Total REN - Capital Expense', GLAccountTypeName: 'N/O EXPENSE' },
    { GLAccountID: 911, Reference: '6101', Name: 'REN - Kitchens', GLAccountTypeName: 'N/O EXPENSE' },
    { GLAccountID: 912, Reference: '6102', Name: 'REN - Bathrooms', GLAccountTypeName: 'N/O EXPENSE' },
    { GLAccountID: 930, Reference: '6230', Name: 'Mortgage Interest Expense', GLAccountTypeName: 'N/O EXPENSE' },
    { GLAccountID: 500, Reference: '5100', Name: 'Repairs & Maintenance', GLAccountTypeName: 'Expense' },
  ];
  const prev = stub.GLAccounts;
  stub.GLAccounts = async () => orphaned;
  renovationExpenses.__resetAccountCache();
  try {
    const { included } = await renovationExpenses.resolveAccounts();
    const refs = included.map(a => a.ref).sort();
    assert.deepStrictEqual(refs, ['6100', '6101', '6102'], `got ${refs.join(', ')}`);
    assert.strictEqual(included.find(a => a.ref === '6101').matchedBy, 'name');
    assert.ok(!refs.includes('6230'), 'mortgage interest is non-operating but is not renovation');
    assert.ok(!refs.includes('5100'), 'an operating account must never be pulled in');
  } finally {
    stub.GLAccounts = prev;
    renovationExpenses.__resetAccountCache();
  }
});

check('the name fallback stays out of the way when the hierarchy works', async () => {
  // If real children are reachable, an unrelated "REN"-named account elsewhere in
  // the chart must NOT be swept in — the fallback is a last resort, not a default.
  const linked = [
    { GLAccountID: 900, Reference: '6100', Name: 'Total REN - Capital Expense', GLAccountTypeName: 'N/O EXPENSE' },
    { GLAccountID: 911, Reference: '6101', Name: 'REN - Kitchens', GLAccountTypeName: 'N/O EXPENSE', ParentGLAccountID: 900 },
    { GLAccountID: 940, Reference: '6400', Name: 'REN - Something Else Entirely', GLAccountTypeName: 'N/O EXPENSE' },
  ];
  const prev = stub.GLAccounts;
  stub.GLAccounts = async () => linked;
  renovationExpenses.__resetAccountCache();
  try {
    const { included } = await renovationExpenses.resolveAccounts();
    const refs = included.map(a => a.ref).sort();
    assert.deepStrictEqual(refs, ['6100', '6101'], `got ${refs.join(', ')}`);
  } finally {
    stub.GLAccounts = prev;
    renovationExpenses.__resetAccountCache();
  }
});

// Majors joined the tab on 2026-08-25, and the shortlist is what decides whether a
// property is pulled at all. A building whose window holds a boiler and no
// renovation would have been skipped entirely — and, worse, the P&L cross-check
// would have compared a detail total carrying majors against a renCapital-only
// expected figure and reported "does not tie" on books that were fine.
check('a property with ONLY major spend is shortlisted, and the cross-check counts it', async () => {
  const snapshot = {
    refreshedAt: '2026-08-24T09:00:00.000Z',
    months: ['Jan 26', 'Feb 26', 'Mar 26', 'Apr 26', 'May 26', 'Jun 26', 'Jul 26', 'Aug 26'],
    properties: {
      107: { name: 'Grand Ave', entity: 'Demo Portfolio', renCapital: [0, 0, 0, 0, 0, 0, 0, 0], majRepairs: [0, 0, 0, 0, 8200, 0, 0, 0] },
      109: { name: 'Maple Court Ave', entity: 'Demo Portfolio', renCapital: [0, 0, 0, 0, 0, 0, 1500, 0] },
    },
  };
  const prev = propertyFinancials.loadSnapshot;
  propertyFinancials.loadSnapshot = () => snapshot;
  calls.runReport.length = 0;
  try {
    const out = await renovationExpenses.build({ now: NOW });
    const pulled = calls.runReport.map(c => c.propOwnerIds).sort();
    assert.deepStrictEqual(pulled, ['107', '109'],
      `the majors-only property must still be pulled, got ${pulled.join(' | ')}`);
    assert.deepStrictEqual((out.reconciliation.plCategories || []).slice().sort(), ['majRepairs', 'renCapital'],
      'the cross-check must say which P&L lines its expected side is made of');
    const row = out.reconciliation.byProperty.find(r => r.propertyId === 107);
    assert.ok(row && row.expected === 8200, `the major spend must be the expected figure, got ${row && row.expected}`);
  } finally {
    propertyFinancials.loadSnapshot = prev;
  }
});

check('build pulls only the properties the P&L says had renovation spend', async () => {
  propertyFinancials.loadSnapshot = () => PL_SNAPSHOT;
  calls.runReport.length = 0;
  const out = await renovationExpenses.build({ now: NOW });

  assert.strictEqual(out.sources.mode, 'per-property');
  const pulled = calls.runReport.map(c => c.propOwnerIds).sort();
  assert.deepStrictEqual(pulled, ['107', '109'],
    `expected one run each for 107 and 109 and nothing for the off-whitelist 999, got ${pulled.join(' | ')}`);
  assert.ok(calls.runReport.every(c => c.reportId === 51 && c.isSummary === 'False'),
    'the detail pull must be report 51 with IsSummary=False');
  assert.ok(calls.runReport.every(c => c.glIds === '515,517,518,519,900,901,902'),
    `every run must be filtered to the resolved renovation + major accounts, got ${calls.runReport.map(c => c.glIds).join(' | ')}`);
  return out;
});

check('non-postings are dropped and signed amounts survive', async () => {
  propertyFinancials.loadSnapshot = () => PL_SNAPSHOT;
  const out = await renovationExpenses.build({ now: NOW });
  assert.strictEqual(out.charges.length, 4, `expected 4 real postings, got ${out.charges.length}`);
  assert.ok(!out.charges.some(c => /BeginBalance|No activity/.test(c.description)),
    'RM summary/placeholder rows must not reach the tab');
  const credit = out.charges.find(c => c.reference === 'CM-12');
  assert.strictEqual(credit.amount, -300, 'a credit must read as a negative amount');
  // Newest first — the charge someone is asked about is almost always a recent one.
  const dates = out.charges.map(c => c.date);
  assert.deepStrictEqual(dates, [...dates].sort().reverse(), 'charges must come back newest first');
});

check('units come from RM when RM states one, and from the description otherwise', async () => {
  propertyFinancials.loadSnapshot = () => PL_SNAPSHOT;
  const out = await renovationExpenses.build({ now: NOW });
  const byRef = Object.fromEntries(out.charges.map(c => [c.reference, c]));

  assert.strictEqual(byRef['INV-8842'].unitName, '2R');
  assert.strictEqual(byRef['INV-8842'].unitSource, 'reported', 'a unit RM named must be marked reported');

  assert.strictEqual(byRef['INV-9001'].unitName, '3B');
  assert.strictEqual(byRef['INV-9001'].unitSource, 'inferred', 'a unit read out of the description is a guess and must say so');

  assert.strictEqual(byRef['INV-7777'].unitName, null, 'a common-area charge must not be pinned to a unit');
  assert.strictEqual(byRef['INV-7777'].unitSource, 'none');

  assert.strictEqual(out.coverage.unitReported, 1);
  assert.strictEqual(out.coverage.unitInferred, 1);
  assert.strictEqual(out.coverage.unitUnknown, 2);
});

// The guesses that can actually be wrong are the ones where the description names
// more than one of the building's units. Those get counted and listed rather than
// averaged into a single "807 inferred" figure nobody can act on.
check('a description naming two units is flagged, one naming a single unit is not', () => {
  const units = [{ id: 1, name: '2R' }, { id: 2, name: '3B' }, { id: 3, name: '5C' }];

  const clear = renovationExpenses.inferUnitDetailed('Kitchen cabinets for 2R', units);
  assert.strictEqual(clear.unit.name, '2R');
  assert.strictEqual(clear.candidates.length, 1, 'one unit named means one candidate');

  const murky = renovationExpenses.inferUnitDetailed('Cabinets 2R, offcuts to 3B', units);
  assert.strictEqual(murky.candidates.length, 2, 'both units in the wording must be recorded');
  assert.ok(murky.candidates.includes('2R') && murky.candidates.includes('3B'));

  // A keyword-anchored mention still wins the pick over a bare token.
  const anchored = renovationExpenses.inferUnitDetailed('leftovers from 5C used in Unit 3B', units);
  assert.strictEqual(anchored.unit.name, '3B', 'the "Unit X" mention should win the pick');
  assert.strictEqual(anchored.candidates.length, 2, 'but the other unit is still a candidate');

  assert.strictEqual(renovationExpenses.inferUnitDetailed('Lobby paint', units).unit, null);
});

check('ambiguous guesses are counted on the build', async () => {
  propertyFinancials.loadSnapshot = () => PL_SNAPSHOT;
  const out = await renovationExpenses.build({ now: NOW });
  const murky = out.charges.filter(c => c.unitAmbiguous);
  assert.strictEqual(out.coverage.unitAmbiguous, murky.length);
  // The fixture's descriptions each name at most one unit, so nothing should flag.
  assert.strictEqual(out.coverage.unitAmbiguous, 0,
    'a clean fixture must not raise false ambiguity — that would cry wolf on every build');
  assert.ok(out.charges.every(c => c.unitAmbiguous === false || c.unitCandidates),
    'a charge marked ambiguous must carry the candidates that made it ambiguous');
});

check('the P&L cross-check ties where it should and catches the gap where it should not', async () => {
  // Scoped to the reference-rooted accounts so the two sides are counting the same
  // thing — which is the precondition for a difference to MEAN anything. The case
  // where they are not is the check below.
  process.env.RENOVATION_GL_NAME_PATTERNS = 'zzz-matches-no-account';
  renovationExpenses.__resetAccountCache();
  propertyFinancials.loadSnapshot = () => PL_SNAPSHOT;
  try {
    const out = await renovationExpenses.build({ now: NOW });
    const rec = out.reconciliation;
    assert.ok(rec.checked, 'the cross-check must run whenever a P&L snapshot exists');
    assert.ok(rec.comparable, 'with only ref-rooted accounts the two sides are comparable');

    const grand = rec.byProperty.find(r => r.propertyId === 107);
    assert.strictEqual(grand.expected, 6200);
    assert.strictEqual(grand.actual, 6200, 'postings must tie to the P&L for the clean property');
    assert.strictEqual(grand.diff, 0);

    assert.strictEqual(rec.mismatches.length, 1, `expected exactly one mismatch, got ${rec.mismatches.length}`);
    assert.strictEqual(rec.mismatches[0].propertyId, 109);
    assert.strictEqual(rec.mismatches[0].diff, -100, 'the $100 the P&L claims and the postings do not show must be surfaced');
  } finally {
    delete process.env.RENOVATION_GL_NAME_PATTERNS;
    renovationExpenses.__resetAccountCache();
  }
});

// The trap the name matching walks into, and the reason it is not just "more
// accounts". The P&L pipeline reads categories by REFERENCE (majRepairs is
// ['5150']), so on a flat chart it carries 5150 and nothing else, while this tab
// now carries every "Major - …" account. Comparing those two would report a
// difference on every property with major spend — and it would not be a difference
// in the books, it would be the two sides counting different accounts.
check('when the two sides count different accounts, the cross-check says so instead of crying mismatch', async () => {
  propertyFinancials.loadSnapshot = () => PL_SNAPSHOT;
  const out = await renovationExpenses.build({ now: NOW });
  const rec = out.reconciliation;
  assert.strictEqual(rec.comparable, false, 'the comparison is not like-for-like and must not claim to be');
  assert.strictEqual(rec.mismatches.length, 0, 'no property may be reported as "does not tie" on that basis');
  const refs = (rec.accountsOutsidePl || []).map(a => a.ref).sort();
  assert.deepStrictEqual(refs, ['5151', '5156', '5224'],
    `the accounts the P&L line cannot contain must be named, got ${refs.join(', ')}`);
  assert.ok(rec.byProperty.length, 'the per-property figures are still published — only the verdict is withheld');
});

check('an account the P&L NESTS under its total is inside the line, not outside it', async () => {
  // The bug this covers, found live 2026-08-26. RM's P&L is a tree flattened into
  // rows, and the Major accounts are children of 5150 by POSITION, not by number:
  //
  //   H  5150  Major - Repair & Maint
  //      5151  Major - Electric        …  5156 Major- Turnover  …  5224 …
  //   T  5150  Total Major - Repair & Maint   311,784   ← what majRepairs reads
  //
  // propertyFinancials.valueForRef prefers a ref's IsTotal row, so the P&L side
  // has been reading that roll-up all along — every one of these accounts was
  // already inside the line the tab is compared against. The old test asked "is
  // this ref one of CATEGORY_REFS, or a 5150-x child of one", which none of them
  // are, and so declared the cross-check incomparable and switched it off. The
  // tie-out was disabled by a question asked the wrong way round.
  propertyFinancials.loadSnapshot = () => ({
    ...PL_SNAPSHOT,
    categoryMembers: { 5150: ['5150', '5151', '5156', '5224'], 6100: ['6100'] },
  });
  const out = await renovationExpenses.build({ now: NOW });
  const rec = out.reconciliation;
  assert.deepStrictEqual((rec.accountsOutsidePl || []).map(a => a.ref), [],
    'an account nested under the total is inside the line');
  assert.strictEqual(rec.comparable, true, 'with nothing outside it, the two sides count the same accounts');
});

check('an account outside the P&L is weighed by what it actually carries', async () => {
  // Report 45 only prints accounts a scope posted to, so an account can be absent
  // from every P&L block simply because nobody used it. On the live portfolio that
  // was 22 accounts named as "outside the P&L" of which only 4 carried a dollar —
  // eighteen names that could not affect the comparison either way. Separating
  // them is arithmetic, not a judgement: a line with no charges in the compared
  // months moves neither side.
  propertyFinancials.loadSnapshot = () => PL_SNAPSHOT;
  const out = await renovationExpenses.build({ now: NOW });
  const rec = out.reconciliation;
  assert.ok(Array.isArray(rec.accountsOutsidePl) && rec.accountsOutsidePl.length,
    'this fixture is meant to have accounts outside the P&L');
  for (const a of rec.accountsOutsidePl) {
    assert.ok(typeof a.charges === 'number' && typeof a.amount === 'number',
      `${a.ref} must carry its charge count and total, got ${JSON.stringify(a)}`);
  }
  assert.strictEqual(rec.outsideWithSpend + rec.outsideDormant, rec.accountsOutsidePl.length,
    'every account is either carrying money or dormant');
  const live = rec.accountsOutsidePl.filter(a => a.charges > 0);
  assert.strictEqual(rec.outsideWithSpend, live.length);
  assert.strictEqual(rec.outsideAmount, Math.round(live.reduce((t, a) => t + a.amount, 0)),
    'the headline figure is the sum of the accounts that actually carry charges');
});

check('the nesting index survives a refresh that only read recent months', () => {
  // The bug this covers cost $16,600 of tie-out. A P&L refresh does not re-read
  // every month, so an account used only in an older month appears in none of the
  // rows that build sees — 5164 Major - Sidewalk Repair, four charges, May 2025,
  // one property. Rebuilt from scratch each time, the index dropped it, and the
  // cross-check read that as "outside the P&L" and switched itself off.
  //
  // The nesting belongs to the chart of accounts, which does not change when a
  // month is skipped, so old members must survive a partial refresh.
  const older = [
    { GLAccountReference: '5150', IsHeader: 'True' },
    { GLAccountReference: '5164' },
    { GLAccountReference: '5150', IsTotal: 'True' },
  ];
  const newer = [
    { GLAccountReference: '5150', IsHeader: 'True' },
    { GLAccountReference: '5151' },
    { GLAccountReference: '5150', IsTotal: 'True' },
  ];
  const a = propertyFinancials.blockMembersFromRows(older, ['5150']);
  const b = propertyFinancials.blockMembersFromRows(newer, ['5150']);
  assert.ok(a['5150'].includes('5164'), 'the older slice knows about 5164');
  assert.ok(!b['5150'].includes('5164'), 'the newer slice does not — that is the whole problem');
  // The union is what the snapshot must carry forward.
  const union = [...new Set([...a['5150'], ...b['5150']])].sort();
  assert.deepStrictEqual(union, ['5150', '5151', '5164'],
    'a refresh must add to the index, never replace it');
});

check('a snapshot with no nesting recorded still refuses to claim a tie-out', async () => {
  // The conservative direction, and the one that has to hold: an older P&L
  // snapshot carries no categoryMembers, so the nesting cannot be SHOWN. Assuming
  // it anyway would publish a tie-out nobody verified.
  propertyFinancials.loadSnapshot = () => PL_SNAPSHOT;
  const out = await renovationExpenses.build({ now: NOW });
  assert.strictEqual(out.reconciliation.comparable, false,
    'without the structure, incomparable is the honest answer');
});

check('block membership is read off the report, sub-blocks and all', () => {
  // Two levels deep: 5220 opens and closes inside 5150's block, so its children
  // belong to 5150's total too. A flat reading would miss them.
  const rows = [
    { GLAccountReference: '5100', IsHeader: 'True' },
    { GLAccountReference: '5101' },
    { GLAccountReference: '5100', IsTotal: 'True' },
    { GLAccountReference: '5150', IsHeader: 'True' },
    { GLAccountReference: '5121' },
    { GLAccountReference: '5220', IsHeader: 'True' },
    { GLAccountReference: '5221' },
    { GLAccountReference: '5220', IsTotal: 'True' },
    { GLAccountReference: '5151' },
    { GLAccountReference: '5150', IsTotal: 'True' },
    { GLAccountReference: '6133' },
  ];
  const m = propertyFinancials.blockMembersFromRows(rows, ['5150']);
  assert.deepStrictEqual(m['5150'].sort(), ['5121', '5150', '5151', '5220', '5221'],
    'everything between the header and its total belongs to the total');
  assert.ok(!m['5150'].includes('6133'), 'a row after the total is outside the block');
  assert.ok(!m['5150'].includes('5101'), 'a row in a different block is not in this one');
  // An unclosed block is not a block we can vouch for.
  const open = propertyFinancials.blockMembersFromRows(
    [{ GLAccountReference: '5150', IsHeader: 'True' }, { GLAccountReference: '5151' }], ['5150']);
  assert.deepStrictEqual(open, {}, 'a header with no matching total yields nothing');
});

check('an empty shortlist is an answer, not a reason to sweep the portfolio', async () => {
  // The P&L says nobody booked renovation spend in the window. The right response
  // is zero charges and zero report runs — not a portfolio-wide fallback run.
  propertyFinancials.loadSnapshot = () => ({ ...PL_SNAPSHOT, properties: {} });
  calls.runReport.length = 0;
  const out = await renovationExpenses.build({ now: NOW });
  assert.strictEqual(out.charges.length, 0);
  assert.strictEqual(calls.runReport.length, 0, 'no P&L spend must cost no report runs');
  assert.strictEqual(out.sources.mode, 'per-property');
});

check('with no P&L snapshot it falls back to one portfolio-wide run and says so', async () => {
  propertyFinancials.loadSnapshot = () => null;
  calls.runReport.length = 0;
  const out = await renovationExpenses.build({ now: NOW });
  assert.strictEqual(out.sources.mode, 'portfolio-wide');
  assert.strictEqual(calls.runReport.length, 1, 'the fallback is exactly one run, not one per property');
  assert.strictEqual(calls.runReport[0].propOwnerIds, '107,109',
    'the fallback still respects the property map — the off-whitelist property stays out');
  assert.strictEqual(out.charges.length, 4);
  // Attribution by name still has to land, or the rollup is meaningless.
  assert.strictEqual(out.coverage.unattributed, 0, 'every posting must resolve to a property by short name');
  assert.ok(out.charges.every(c => c.entity === 'Demo Portfolio'));
  assert.strictEqual(out.reconciliation.checked, false, 'no P&L snapshot means no cross-check to claim');
});

check('a property whose report run fails is reported, not silently dropped', async () => {
  propertyFinancials.loadSnapshot = () => PL_SNAPSHOT;
  const realRunReport = stub.RunReport;
  stub.RunReport = async (reportId, params) => {
    if (String(paramValue(params, 'PropOwnerIDs')) === '109') throw new Error('RM said no');
    return realRunReport(reportId, params);
  };
  try {
    const out = await renovationExpenses.build({ now: NOW });
    assert.strictEqual(out.coverage.errors.length, 1);
    assert.strictEqual(out.coverage.errors[0].propertyId, 109);
    assert.strictEqual(out.charges.length, 3, 'the properties that did work must still come through');
  } finally {
    stub.RunReport = realRunReport;
  }
});

check('an empty account set fails loudly instead of building an empty tab', async () => {
  process.env.RENOVATION_GL_REFS = '9999';
  process.env.RENOVATION_GL_NAME_PATTERNS = 'zzz-matches-no-account';
  try {
    await renovationExpenses.build({ now: NOW });
    assert.fail('a ref that matches no account must throw');
  } catch (err) {
    assert.ok(/No GL accounts matched/.test(err.message), `unexpected error: ${err.message}`);
  } finally {
    delete process.env.RENOVATION_GL_REFS;
    delete process.env.RENOVATION_GL_NAME_PATTERNS;
  }
});

// The failure this exists to stop: the mapping was fixed and deployed, and the tab
// kept showing the old answer because the snapshot it serves was built by the old
// rules. Age cannot catch that — the snapshot can be minutes old and still wrong.
check('a snapshot built under a superseded account mapping is recognised as outdated', async () => {
  const built = { mappingFingerprint: renovationExpenses.mappingFingerprint() };
  assert.ok(built.mappingFingerprint.includes('major'), 'the fingerprint must cover the name patterns');

  // Same rules → not outdated.
  const cacheModule = require(path.join(__dirname, '..', 'services', 'snapshotCache.js'));
  const mk = payload => cacheModule.makeSnapshotCache({
    name: 'test', file: `test-outdated-${Math.abs(payload.n || 0)}.json`, build: async () => payload.data,
    isOutdated: data => !data || data.mappingFingerprint !== renovationExpenses.mappingFingerprint(),
  });
  const c = mk({ n: 1, data: built });
  await c.refresh();
  assert.strictEqual(c.outdated(), false, 'a snapshot built under the current rules is current');

  // A snapshot from before the fix — a different fingerprint, or none at all.
  const c2 = mk({ n: 2, data: { mappingFingerprint: 'refs:6100 | names: | !refs: | !names:' } });
  await c2.refresh();
  assert.strictEqual(c2.outdated(), true, 'a snapshot built under the old mapping must be outdated');
  const c3 = mk({ n: 3, data: { accountRoots: ['6100'] } });
  await c3.refresh();
  assert.strictEqual(c3.outdated(), true, 'a snapshot from before fingerprints existed must rebuild once');

  for (const f of ['test-outdated-1.json', 'test-outdated-2.json', 'test-outdated-3.json']) {
    try { require('fs').unlinkSync(path.join(__dirname, '..', 'data', f)); } catch { /* fine */ }
  }
});

// "Where it mentions two units, maybe just put the cost between the units."
// The money has to survive the split exactly, or the tab starts disagreeing with
// the P&L for a reason that has nothing to do with Rent Manager.
check('a charge naming two units is split between them, to the cent', () => {
  const units = [{ id: 1, name: '06' }, { id: 2, name: '15' }];
  const base = {
    id: 'c-1', amount: 66, unitAmbiguous: true, unitCandidates: ['06', '15'],
    unitName: '06', unitSource: 'inferred', propertyId: 107,
  };
  const out = renovationExpenses.splitAcrossUnits(base, units);
  assert.strictEqual(out.length, 2, 'one row per unit named');
  assert.strictEqual(out[0].amount + out[1].amount, 66, 'the money must not move');
  assert.deepStrictEqual(out.map(c => c.unitName).sort(), ['06', '15']);
  assert.strictEqual(out[0].unitId, 1, 'a known unit keeps its id');
  assert.ok(out.every(c => c.unitSource === 'split' && !c.unitAmbiguous),
    'a split is an allocation, not an unresolved guess');
  assert.strictEqual(out[0].unitSplit.ways, 2);
  assert.notStrictEqual(out[0].id, out[1].id, 'the two rows need distinct ids');

  // An odd cent cannot be dropped or invented.
  const odd = renovationExpenses.splitAcrossUnits({ ...base, amount: 0.05 }, units);
  assert.strictEqual(Math.round((odd[0].amount + odd[1].amount) * 100), 5, `got ${odd.map(o => o.amount).join(' + ')}`);
  const three = renovationExpenses.splitAcrossUnits(
    { ...base, amount: 10, unitCandidates: ['06', '15', '26'] }, units);
  assert.strictEqual(three.length, 3);
  assert.strictEqual(Math.round(three.reduce((t, c) => t + c.amount, 0) * 100), 1000);

  // A credit splits the same way, and stays a credit.
  const credit = renovationExpenses.splitAcrossUnits({ ...base, amount: -66 }, units);
  assert.ok(credit.every(c => c.amount < 0), 'a negative charge must not flip sign');
  assert.strictEqual(credit[0].amount + credit[1].amount, -66);

  // One unit named is not a split at all.
  const single = renovationExpenses.splitAcrossUnits(
    { ...base, unitAmbiguous: false, unitCandidates: ['06'] }, units);
  assert.strictEqual(single.length, 1);
  assert.strictEqual(single[0].amount, 66);
});

check('charge ids are stable across rebuilds and unique within one', async () => {
  propertyFinancials.loadSnapshot = () => PL_SNAPSHOT;
  const a = await renovationExpenses.build({ now: NOW });
  const b = await renovationExpenses.build({ now: NOW });
  const idsA = a.charges.map(c => c.id);
  assert.deepStrictEqual(idsA, b.charges.map(c => c.id),
    'a rebuild must not invalidate the ids the open backup panels are keyed on');
  assert.strictEqual(new Set(idsA).size, idsA.length, 'two charges must never share an id');
});

// ── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${err.message}`);
    }
  }
  console.log(failed
    ? `\n${failed} of ${checks.length} renovation checks failed.`
    : `\nAll ${checks.length} renovation checks passed.`);
  process.exit(failed ? 1 : 0);
})();
