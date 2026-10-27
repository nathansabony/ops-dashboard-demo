// The demo's books: chart of accounts, monthly GL amounts per property, mortgages,
// bank balances and individual GL transactions for the fake portfolio.
//
// Everything is derived deterministically from services/demo/world.js (the rent roll)
// and anchored to TODAY, so the current month always looks current. The route modules
// in routes/financials.js turn this into the exact shapes Rent Manager reports return;
// other demo modules (bills, checks, invoices) build on glEntries().
//
// ── Stable API (other modules depend on it) ─────────────────────────────────
//   chart                     [{ id, ref, name, type, parentRef, parentId, kind, sortOrder }]
//   accountByRef(ref) / accountById(id) / childrenOf(ref)
//   MONTHS                    ['YYYY-MM', …] oldest → current month (40 months)
//   currentYM
//   propertyIds               [101…105]
//   shortName(propertyId)     the name Report 51 prints in PropertyShortName
//   monthly(propertyId, ym)   → { accountRef: amount }  leaf P&L accounts only; income and
//                               expense both positive, credits negative. Includes 6230 interest.
//   totals(propertyId, ym)    → { income, otherIncome, opex, noi, nonop, interest, … }
//   loans                     [{ id, ref, name, lender, propertyIds, rate, … }]
//   loanMonth(loan, ym)       → { interest, principal, payment, balance }
//   glEntries(from, to, propertyIds?, { refs? })
//                             → individual postings that sum EXACTLY to monthly() for P&L
//                               accounts. Each: { id, txnId, txnType, date, propertyId,
//                               propertyShortName, accountRef, accountId, accountName,
//                               vendor, vendorId, reference, invoiceNo, description, memo,
//                               debit, credit, amount, billId, checkNo, paidDate, dueDate, … }
//   entryById(id)
//   vendors / vendorById(id)
//   balanceSheet(asOf, propertyIds) → rows for Report 38
//   bankAccounts

const world = require('./world');

// ── months ──────────────────────────────────────────────────────────────────
const TODAY = world.today;
const CUR_IDX = TODAY.getFullYear() * 12 + TODAY.getMonth();
const HISTORY = 40;
const pad2 = n => String(n).padStart(2, '0');
const idxToYM = i => `${Math.floor(i / 12)}-${pad2((i % 12) + 1)}`;
const ymToIdx = ym => { const [y, m] = String(ym).split('-').map(Number); return y * 12 + m - 1; };
const monthsAgo = ym => CUR_IDX - ymToIdx(ym);
const MONTHS = Array.from({ length: HISTORY }, (_, k) => idxToYM(CUR_IDX - (HISTORY - 1) + k));
const currentYM = MONTHS[MONTHS.length - 1];
const lastDay = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monLabel = ym => `${MON3[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
const TODAY_DAY = TODAY.getDate();

// ── deterministic noise ─────────────────────────────────────────────────────
function hash01(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
  x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995); x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
const noise = (amp, ...key) => 1 + (hash01(key.join('|')) - 0.5) * 2 * amp;
const cents = v => Math.round(v * 100);
const dollars = c => Math.round(c) / 100;

// ── properties ──────────────────────────────────────────────────────────────
const PROPS = world.PROPERTIES;
const propertyIds = PROPS.map(p => p.id);
const propIndex = new Map(propertyIds.map((id, i) => [id, i]));
const shortName = id => { const p = world.propertyById.get(Number(id)); return p ? (p.shortName || p.name) : String(id); };
const rentRoll = new Map(propertyIds.map(id => [id, world.currentTenants.filter(t => t.propertyId === id).reduce((s, t) => s + t.rent, 0)]));
const unitsOf = id => world.UNITS.filter(u => u.propertyId === id);
// Older buildings cost more to run; the newer one runs lean. Tax and utility factors differ again.
const PF = {
  101: { opex: 0.98, tax: 1.00, util: 1.00 },
  102: { opex: 1.10, tax: 1.04, util: 1.10 },
  103: { opex: 0.97, tax: 1.02, util: 0.95 },
  104: { opex: 1.03, tax: 0.95, util: 1.05 },
  105: { opex: 0.88, tax: 1.08, util: 0.85 },
};
const INFLATION = 0.035;
const growth = a => Math.pow(1 + INFLATION, -a / 12);

// ── seasonality (index = month 0..11) ───────────────────────────────────────
const SEASON = {
  flat: Array(12).fill(1),
  gas: [2.1, 1.9, 1.5, 0.9, 0.5, 0.35, 0.3, 0.3, 0.4, 0.75, 1.3, 1.85],
  electric: [1.05, 1.0, 0.95, 0.9, 0.95, 1.1, 1.2, 1.2, 1.05, 0.95, 0.95, 1.05],
  water: [0.95, 0.93, 0.95, 0.98, 1.02, 1.08, 1.12, 1.12, 1.05, 1.0, 0.95, 0.95],
  landscape: [1.9, 1.6, 0.8, 0.7, 1.0, 1.1, 1.1, 1.1, 1.0, 0.9, 0.8, 1.6],
  turnover: [0.7, 0.7, 0.9, 1.0, 1.15, 1.3, 1.4, 1.4, 1.2, 0.9, 0.7, 0.6],
  repairs: [1.15, 1.1, 0.95, 0.9, 0.95, 1.0, 1.05, 1.0, 0.95, 0.95, 1.0, 1.1],
};

// ── chart of accounts ───────────────────────────────────────────────────────
// kind 'leaf' posts; kind 'block' is a parent whose Total row the P&L prints.
// calc: how the monthly amount is derived (see baseAmount).
//   rent       — the rent roll itself
//   rentPct    — a share of the month's rent income
//   R          — a share of steady-state income (so expenses don't swing with vacancy)
//   incomePct  — a share of the month's actual total income
//   tax / ins  — annual steps (tax each January, insurance at renewal)
//   fixed      — flat monthly amount scaled by property size
const L = (ref, name, type, calc, o = {}) => ({ kind: 'leaf', ref, name, type, calc, ...o });
const B = (ref, name, type, children, o = {}) => ({ kind: 'block', ref, name, type, children, totalName: o.totalName || `Total ${name}`, ...o });
const INC = 'Income', EXP = 'Expense', NOP = 'Non Operating Expense', OINC = 'Other Income';

const SPEC = [
  // ── income ──
  L('4000', 'Rental Income', INC, { k: 'rent' }),
  L('4010', 'Concessions & Discounts', INC, { k: 'rentPct', pct: -0.004, noise: 0.9 }),
  L('4100', 'Late Fees', INC, { k: 'rentPct', pct: 0.011, noise: 0.35 }),
  L('4110', 'Pet Rent & Fees', INC, { k: 'rentPct', pct: 0.012, noise: 0.08 }),
  L('4120', 'Laundry Income', INC, { k: 'rentPct', pct: 0.008, noise: 0.12 }),
  L('4130', 'Application & Admin Fees', INC, { k: 'rentPct', pct: 0.004, noise: 0.45 }),
  L('4140', 'Utility Reimbursement', INC, { k: 'rentPct', pct: 0.028, noise: 0.05 }),
  L('4150', 'Parking & Storage', INC, { k: 'rentPct', pct: 0.006, noise: 0.05 }),
  L('4500', 'Interest Income', OINC, { k: 'rentPct', pct: 0.0006, noise: 0.3 }),
  // ── operating expenses ──
  L('5000', 'Management Fees Expense', EXP, { k: 'incomePct', pct: 0.05 }),
  L('5001', 'Advertising', EXP, { k: 'R', pct: 0.007, noise: 0.45 }),
  L('5010', 'Bank Fees', EXP, { k: 'R', pct: 0.0015, noise: 0.2 }),
  L('5020', 'Legal & Professional', EXP, { k: 'R', pct: 0.008, noise: 0.9 }),
  L('5031', 'Exterminating', EXP, { k: 'R', pct: 0.007, noise: 0.15 }),
  L('5035', 'Landscaping & Snow Removal', EXP, { k: 'R', pct: 0.011, season: 'landscape', noise: 0.12 }),
  L('5045', 'Cleaning & Janitorial', EXP, { k: 'R', pct: 0.006, noise: 0.12 }),
  L('5060', 'Internet & Telephone', EXP, { k: 'R', pct: 0.0035, noise: 0.04 }),
  L('5070', 'Computer & IT', EXP, { k: 'R', pct: 0.005, noise: 0.1 }),
  L('5080', 'Licenses & Permits', EXP, { k: 'R', pct: 0.003, noise: 0.5 }),
  B('5050', 'Insurance Expense', EXP, [
    L('5050-1', 'Property Insurance', EXP, { k: 'ins', pct: 0.046 }),
    L('5050-2', 'General Liability & Umbrella', EXP, { k: 'ins', pct: 0.009 }),
  ]),
  B('5100', 'Repairs & Maintenance Expense', EXP, [
    L('5101', 'Appliance Repairs', EXP, { k: 'R', pct: 0.0055, season: 'repairs', noise: 0.35 }),
    L('5102', 'Plumbing Repairs', EXP, { k: 'R', pct: 0.011, season: 'repairs', noise: 0.35 }),
    L('5103', 'Electrical Repairs', EXP, { k: 'R', pct: 0.0055, season: 'repairs', noise: 0.35 }),
    L('5104', 'HVAC Repairs', EXP, { k: 'R', pct: 0.0085, season: 'repairs', noise: 0.4 }),
    L('5105', 'Locks & Keys', EXP, { k: 'R', pct: 0.002, noise: 0.5 }),
    L('5107', 'Painting & Drywall', EXP, { k: 'R', pct: 0.006, noise: 0.4 }),
    L('5108', 'Doors & Windows', EXP, { k: 'R', pct: 0.0035, noise: 0.5 }),
    L('5109', 'General Repairs', EXP, { k: 'R', pct: 0.005, noise: 0.35 }),
    B('5200', 'Materials & Supplies', EXP, [
      L('5201', 'Hardware & Supplies', EXP, { k: 'R', pct: 0.0055, noise: 0.3 }),
      L('5202', 'Cleaning Supplies', EXP, { k: 'R', pct: 0.0025, noise: 0.3 }),
      L('5203', 'Paint Supplies', EXP, { k: 'R', pct: 0.0025, noise: 0.35 }),
      L('5204', 'Lighting & Electrical Supplies', EXP, { k: 'R', pct: 0.0015, noise: 0.4 }),
    ]),
  ], { totalName: 'Total Repairs & Maintenance Expense' }),
  L('5106', 'Turnover', EXP, { k: 'R', pct: 0.022, season: 'turnover', noise: 0.3 }),
  B('5301', 'Property Taxes', EXP, [
    L('5301-1', 'Real Estate Taxes', EXP, { k: 'tax', pct: 0.088 }),
    L('5301-2', 'Special Assessments', EXP, { k: 'R', pct: 0.0, noise: 0 }),
  ]),
  L('5401', 'Utilities Heating Gas', EXP, { k: 'R', pct: 0.026, season: 'gas', noise: 0.1, pf: 'util' }),
  B('5402', 'Water & Sewer', EXP, [
    L('5402-1', 'Utilities Water', EXP, { k: 'R', pct: 0.024, season: 'water', noise: 0.06, pf: 'util' }),
    L('5402-2', 'Utilities Sewer', EXP, { k: 'R', pct: 0.030, season: 'water', noise: 0.06, pf: 'util' }),
    L('5402-3', 'Solid Waste Charges', EXP, { k: 'R', pct: 0.010, noise: 0.04, pf: 'util' }),
  ], { totalName: 'Total Water & Sewer' }),
  L('5404', 'Utilities Electric', EXP, { k: 'R', pct: 0.022, season: 'electric', noise: 0.08, pf: 'util' }),
  B('5700', 'Payroll Expenses', EXP, [
    L('5701', 'Maintenance Wages', EXP, { k: 'R', pct: 0.034, noise: 0.03 }),
    L('5702', 'Payroll Taxes', EXP, { k: 'R', pct: 0.004, noise: 0.05 }),
    L('5703', 'Workers Compensation', EXP, { k: 'R', pct: 0.003, noise: 0.05 }),
    L('5704', 'Employee Benefits', EXP, { k: 'R', pct: 0.002, noise: 0.05 }),
  ], { totalName: 'Total Payroll Expenses' }),
  // ── non-operating (below NOI) ──
  L('5040', 'Commissions Expense', NOP, { k: 'R', pct: 0.0045, noise: 0.8 }),
  L('5710', 'Management Wages, Salary', NOP, { k: 'R', pct: 0.02, noise: 0.02 }),
  B('5150', 'Major - Repair & Maint', NOP, [
    L('5151', 'Major - Electric', NOP, { k: 'major' }),
    L('5152', 'Major - Windows', NOP, { k: 'major' }),
    L('5156', 'Major- Turnover', NOP, { k: 'major' }),
    L('5158', 'Major - Plumbing', NOP, { k: 'major' }),
    L('5160', 'Major - Painting', NOP, { k: 'major' }),
    L('5161', 'Major - Boiler expense', NOP, { k: 'major' }),
    L('5168', 'Major - Flooring', NOP, { k: 'major' }),
    L('5172', 'Major - Roof repair', NOP, { k: 'major' }),
  ], { totalName: 'Total Major - Repair & Maint' }),
  B('6100', 'REN - Capital Expense', NOP, [
    L('6100-1', 'REN - Flooring', NOP, { k: 'reno', part: 'flooring' }),
    L('6100-2', 'REN - Kitchen Cabinets & Counters', NOP, { k: 'reno', part: 'cabinets' }),
    L('6100-3', 'REN - Appliances', NOP, { k: 'reno', part: 'appliances' }),
    L('6100-4', 'REN - Paint & Drywall', NOP, { k: 'reno', part: 'paint' }),
    L('6100-5', 'REN - Bath & Fixtures', NOP, { k: 'reno', part: 'bath' }),
    L('6100-6', 'REN - Payroll Labor', NOP, { k: 'reno', part: 'labor' }),
  ], { totalName: 'Total REN - Capital Expense' }),
  L('6230', 'Mortgage Interest Expense', NOP, { k: 'interest' }),
];

// Non-P&L accounts (balance sheet side), in chart order.
const BS_SPEC = [
  { ref: '1010', name: 'Cedar Ridge Operating - 4471', type: 'Bank' },
  { ref: '1020', name: 'Cedar Ridge Reserve - 8820', type: 'Bank' },
  { ref: '1030', name: 'Cedar Ridge Security Deposits - 3095', type: 'Bank' },
  { ref: '1200', name: 'Tenant Receivables', type: 'Receivable' },
  { ref: '1500', name: 'Land & Buildings', type: 'Fixed Asset' },
  { ref: '1510', name: 'Accumulated Depreciation', type: 'Fixed Asset' },
  { ref: '2100', name: 'Accounts Payable', type: 'Payable' },
  { ref: '2200', name: 'Security Deposits Held', type: 'Liability' },
  { ref: '2210', name: 'Prepaid Rent', type: 'Liability' },
  { ref: '2300', name: 'Mortgage Notes Payable', type: 'Liability', block: true },
  { ref: '3000', name: "Members' Capital", type: 'Equity' },
  { ref: '3900', name: 'Retained Earnings', type: 'Equity' },
];

// Mortgages: three loans over the five buildings. `dscrIO` is the NOI ÷ interest the loan is
// sized to at the trailing twelve months; the weak one is interest-only, the strong one amortizes.
const LOAN_SPEC = [
  { ref: '2301', name: 'Mortgage - Heartland Capital (The Alder)', lender: 'Heartland Capital Lending', loanNo: '4471-0382', propertyIds: [101], rate: 0.0545, orig: '2022-08', amortMonths: 360, ioMonths: 0, dscrIO: 1.70 },
  { ref: '2302', name: 'Mortgage - Buckeye Mutual Bank (Maple Court)', lender: 'Buckeye Mutual Bank', loanNo: '88-120457', propertyIds: [102], rate: 0.0665, orig: '2024-03', amortMonths: 360, ioMonths: 60, dscrIO: 1.12 },
  { ref: '2303', name: 'Mortgage - Lakeshore Community Bank (Willow Creek / Birchwood / Summit)', lender: 'Lakeshore Community Bank', loanNo: 'LCB-30-9915', propertyIds: [103, 104, 105], rate: 0.059, orig: '2023-05', amortMonths: 300, ioMonths: 60, dscrIO: 1.45 },
];

// ── flatten the spec into a chart ───────────────────────────────────────────
const chart = [];
const byRef = new Map();
const byId = new Map();
let nextId = 1000;
let sortOrder = 0;
function addAccount(a) {
  const acct = { id: nextId++, sortOrder: (sortOrder += 10), ...a };
  chart.push(acct); byRef.set(acct.ref, acct); byId.set(acct.id, acct);
  return acct;
}
const leafNodes = [];       // P&L leaves in report order, with spec
const layout = [];          // nested structure for the P&L report: { head|leaf|total }
function walk(nodes, parentRef, depthLayout) {
  for (const n of nodes) {
    if (n.kind === 'block') {
      const parent = byRef.get(parentRef);
      addAccount({ ref: n.ref, name: n.name, type: n.type, parentRef: parentRef || null, parentId: parent ? parent.id : null, kind: 'block' });
      const sub = [];
      walk(n.children, n.ref, sub);
      depthLayout.push({ block: n, children: sub });
    } else {
      const parent = byRef.get(parentRef);
      addAccount({ ref: n.ref, name: n.name, type: n.type, parentRef: parentRef || null, parentId: parent ? parent.id : null, kind: 'leaf' });
      leafNodes.push(n);
      depthLayout.push({ leaf: n });
    }
  }
}
walk(SPEC, null, layout);
for (const b of BS_SPEC) {
  const a = addAccount({ ref: b.ref, name: b.name, type: b.type, parentRef: null, parentId: null, kind: b.block ? 'block' : 'leaf' });
  if (b.ref === '2300') {
    for (const l of LOAN_SPEC) addAccount({ ref: l.ref, name: l.name, type: 'Liability', parentRef: '2300', parentId: a.id, kind: 'leaf' });
  }
}
const accountByRef = ref => byRef.get(String(ref));
const accountById = id => byId.get(Number(id));
const childrenOf = ref => chart.filter(a => a.parentRef === String(ref));
const leafByRef = new Map(leafNodes.map(n => [n.ref, n]));

// ── vendors ─────────────────────────────────────────────────────────────────
const VENDOR_DEFS = {
  mgmt: ['Cedar Ridge Management Co.'],
  advertising: ['Apartment Finder Online', 'Local Listing Media'],
  bank: ['First Heartland Bank'],
  legal: ['Harlan & Pruitt LLP', 'Metro Eviction Services'],
  pest: ['Guardian Pest Control'],
  landscape: ['GreenEdge Lawn & Snow'],
  cleaning: ['Sparkle Turn Cleaning Co.', 'Brightway Janitorial'],
  internet: ['Metro Broadband', 'Ohio Fiber Telecom'],
  software: ['PropTools Software', 'Cloudbase IT Services'],
  license: ['City of Columbus Licensing', 'Franklin County Auditor'],
  insProp: ['Midwest Mutual Insurance Group'],
  insLiab: ['Lakeshore Specialty Insurance'],
  plumbing: ['Buckeye Plumbing & Drain', 'Ohio Valley Mechanical'],
  electrical: ['Brightline Electric', 'Capital City Electrical'],
  hvac: ['Northstar Heating & Air', 'Keystone Climate Control'],
  appliance: ['Appliance Parts Warehouse', 'Midwest Appliance Repair'],
  locks: ['Columbus Lock & Key'],
  paint: ['Fresh Coat Painters', 'Pro Drywall & Paint'],
  general: ['Reliable Property Services', 'Alvarez Handyman Services'],
  doors: ['Clearview Window & Door'],
  supplies: ['THE HOME DEPOT #4112', 'ACE HARDWARE CLINTONVILLE', 'LOWES #1873'],
  janSupplies: ['Uline Supply', 'Sam\'s Club #6428'],
  paintSupplies: ['Sherwin Paint Store #7040', 'THE HOME DEPOT #4112'],
  lighting: ['Capital City Electrical', 'LOWES #1873'],
  turnover: ['Sparkle Turn Cleaning Co.', 'Fresh Coat Painters', 'Reliable Property Services', 'Tri-County Flooring'],
  tax: ['Franklin County Treasurer'],
  gas: ['Buckeye Natural Gas'],
  water: ['City of Columbus Utilities'],
  waste: ['Capital Waste Services'],
  electric: ['Ohio Power & Light'],
  payroll: ['Keystone Payroll Services'],
  commission: ['Cedar Ridge Leasing Team'],
  roof: ['Summit Ridge Roofing', 'Heritage Roofing & Exteriors'],
  flooring: ['Tri-County Flooring', 'Central Ohio Flooring Supply'],
  cabinets: ['Heritage Kitchen & Cabinets'],
  renoAppl: ['Appliance Parts Warehouse'],
  renoPaint: ['Fresh Coat Painters'],
  bath: ['Buckeye Plumbing & Drain', 'Bath Fitters of Ohio'],
  boiler: ['Northstar Heating & Air'],
  lenders: LOAN_SPEC.map(l => l.lender),
  // Willow Creek sits in a different service district: its own water and waste vendors.
  waterAlt: ['Franklin County Water & Sewer'],
  wasteAlt: ['Northland Disposal Co.'],
};
const ALT_VENDOR = { 103: { water: 'waterAlt', waste: 'wasteAlt' } };
const vendorKeyFor = (pid, key) => (ALT_VENDOR[pid] && ALT_VENDOR[pid][key]) || key;
const vendors = [];
const vendorByName = new Map();
let vendorSeq = 11000;
for (const names of Object.values(VENDOR_DEFS)) {
  for (const name of names) {
    if (vendorByName.has(name)) continue;
    const v = { id: ++vendorSeq, name, acctNo: String(40000 + Math.floor(hash01(name) * 59999)) };
    vendors.push(v); vendorByName.set(name, v);
  }
}
const vendorById = id => vendors.find(v => v.id === Number(id));

// ── scripted events (the Variances tab needs something to find) ─────────────
// `a` is months before the current month, so these stay inside the six-month flag
// window as the calendar moves. a=0 is the in-progress month.
const EVENTS = [
  { pid: 104, refs: ['5402-1', '5402-2'], a: 2, mult: 3.6, why: 'Water & sewer spike — a high bill after a hydrant/irrigation leak' },
  { pid: 102, refs: ['5102'], a: 1, add: 3400, why: 'Repairs jump — plumbing stack replaced' },
  { pid: 102, refs: ['5104'], a: 1, add: 2900, why: 'Repairs jump — rooftop HVAC unit replaced' },
  { pid: 103, refs: ['5050-1'], a: 3, set: -3950, why: 'Insurance credit — premium audit refund' },
  { pid: 103, refs: ['5402-1', '5402-2', '5402-3'], a: 4, set: 0, why: 'Water & sewer not posted — autopay lapsed for the month' },
  { pid: 104, refs: ['5000'], a: 4, set: 0, why: 'Management fee not posted' },
  { pid: 104, refs: ['5000'], a: 3, mult: 2, why: 'Management fee caught up' },
  { pid: 105, refs: ['5106'], a: 2, add: 2900, why: 'Turnover — two units made ready the same month' },
  { pid: 101, refs: ['5404'], a: 2, add: 1500, why: 'Electric — common-area meter error' },
  // A jump that was partly credited back: the utility credits sewer charges a month after the leak is found.
  { pid: 104, refs: ['5402-2'], a: 1, add: -900, why: 'Sewer — utility credit after the leak adjustment' },
  // Favourable moves that held (the Variances 'Going well' list): savings that stay saved.
  ...[3, 2, 1, 0].map(a => ({ pid: 104, refs: ['5404'], a, mult: 0.45, why: 'Electric - LED retrofit cut the common-area load' })),
  ...[3, 2, 1, 0].map(a => ({ pid: 103, refs: ['5101', '5102', '5103', '5104', '5105', '5107', '5108', '5109'], a, mult: 0.5, why: 'Repairs - a second in-house technician took over routine work' })),
  ...[3, 2, 1, 0].map(a => ({ pid: 101, refs: ['5101', '5102', '5103', '5104', '5105', '5107', '5108', '5109'], a, mult: 0.55, why: 'Repairs - preventive maintenance program cut call-outs' })),
  // A new run rate, not a spike: Summit Lofts' property tax is reassessed and the new amount posts every month after.
  ...[4, 3, 2, 1, 0].map(a => ({ pid: 105, refs: ['5301-1'], a, mult: 1.32, why: 'Property tax - reassessment (new assessed value)' })),
];
// Occupancy dips (rent income) at Summit Lofts.
const RENT_DIPS = [{ pid: 105, a: 2, f: -0.10 }, { pid: 105, a: 1, f: -0.10 }];
// One-off major repairs (non-operating).
const MAJOR_SCRIPT = [
  { pid: 101, a: 2, ref: '5161', amount: 18400, desc: 'Replace boiler — heating plant' },
  { pid: 103, a: 5, ref: '5172', amount: 24500, desc: 'Roof repair — east wing' },
  { pid: 102, a: 8, ref: '5158', amount: 6850, desc: 'Plumbing — main line replacement' },
  { pid: 104, a: 12, ref: '5152', amount: 9200, desc: 'Replace windows — building B' },
  // one early posting per major account so every account is "live" in the P&L's history
  { pid: 105, a: 19, ref: '5151', amount: 2150, desc: 'Electric — panel upgrade' },
  { pid: 101, a: 17, ref: '5156', amount: 1480, desc: 'Turnover — full unit make-ready' },
  { pid: 103, a: 16, ref: '5160', amount: 2780, desc: 'Painting — stairwells' },
  { pid: 102, a: 14, ref: '5168', amount: 3320, desc: 'Flooring — hallway LVP' },
];

// ── renovation projects (6100) ──────────────────────────────────────────────
const RENO_PARTS = { flooring: 1850, cabinets: 3100, appliances: 1450, paint: 720, bath: 1380, labor: 960 };
const RENO_VENDOR = { flooring: 'flooring', cabinets: 'cabinets', appliances: 'renoAppl', paint: 'renoPaint', bath: 'bath' };
const RENO_TASK = {
  flooring: 'LVP flooring install', cabinets: 'kitchen cabinets & counters', appliances: 'appliance package',
  paint: 'paint & drywall repair', bath: 'bath vanity & fixtures', labor: 'in-house renovation crew',
};
const renoProjects = new Map();   // `${pid}|${ym}` → [{ unit, parts:{part:amount} }]
for (const pid of propertyIds) {
  const units = unitsOf(pid);
  for (const ym of MONTHS) {
    const a = monthsAgo(ym);
    if (hash01(`reno|${pid}|${ym}`) > 0.2) continue;
    if (a === 0 && TODAY_DAY < 12) continue;
    const unit = units[Math.floor(hash01(`renoU|${pid}|${ym}`) * units.length)];
    const scale = (0.55 + hash01(`renoS|${pid}|${ym}`) * 1.1) * growth(a);
    const parts = {};
    for (const [part, base] of Object.entries(RENO_PARTS)) {
      // not every renovation touches every trade
      if (part !== 'labor' && hash01(`renoP|${pid}|${ym}|${part}`) < 0.3) continue;
      parts[part] = dollars(cents(base * scale));
    }
    if (!Object.keys(parts).length) parts.flooring = dollars(cents(RENO_PARTS.flooring * scale));
    const key = `${pid}|${ym}`;
    (renoProjects.get(key) || renoProjects.set(key, []).get(key)).push({ unit: unit.name, parts });
  }
}

// ── amounts ─────────────────────────────────────────────────────────────────
const baseRent = id => rentRoll.get(id) || 0;
function rentIncome(pid, ym) {
  const a = monthsAgo(ym);
  if (a === 0) return baseRent(pid);
  let n = noise(0.035, 'occ', pid, ym);
  for (const d of RENT_DIPS) if (d.pid === pid && d.a === a) n += d.f;
  return baseRent(pid) * growth(a) * n;
}
const steadyIncome = (pid, ym) => (baseRent(pid) / 0.945) * growth(monthsAgo(ym));
function renewalMonth(pid) { return 2 + (propIndex.get(pid) % 3); }   // Mar / Apr / May
function eventFor(pid, ref, a) { return EVENTS.filter(e => e.pid === pid && e.refs.includes(ref) && e.a === a); }

const cacheBase = new Map();
function baseMonthly(pid, ym) {
  const key = `${pid}|${ym}`;
  if (cacheBase.has(key)) return cacheBase.get(key);
  const out = {};
  const a = monthsAgo(ym);
  const m0 = Number(ym.slice(5)) - 1;
  const year = Number(ym.slice(0, 4));
  const R = steadyIncome(pid, ym);
  const rent = rentIncome(pid, ym);
  const pf = PF[pid];
  const partial = a === 0 ? 0.7 : 1;      // the in-progress month has only some bills posted

  // income first (incomePct depends on it)
  let income = 0;
  for (const n of leafNodes) {
    if (n.type !== INC) continue;
    const c = n.calc;
    let v = c.k === 'rent' ? rent : rent * c.pct * noise(c.noise || 0, n.ref, pid, ym);
    if (a === 0 && c.k !== 'rent') v *= 0.9;
    v = dollars(cents(v));
    out[n.ref] = v; income += v;
  }
  for (const n of leafNodes) {
    if (n.type === INC) continue;
    const c = n.calc;
    let v = 0;
    switch (c.k) {
      case 'rentPct': v = rent * c.pct * noise(c.noise || 0, n.ref, pid, ym); break;
      case 'incomePct': v = income * c.pct; break;
      case 'R': {
        v = R * c.pct * (SEASON[c.season || 'flat'][m0]) * noise(c.noise || 0, n.ref, pid, ym) * (c.pf ? pf[c.pf] : pf.opex);
        if (a === 0) v *= partial;
        break;
      }
      case 'tax': v = steadyIncome(pid, currentYM) * c.pct * pf.tax * Math.pow(1.04, year - TODAY.getFullYear()); break;
      case 'ins': {
        const eff = m0 >= renewalMonth(pid) ? year : year - 1;
        v = steadyIncome(pid, currentYM) * c.pct * Math.pow(1.08, eff - TODAY.getFullYear()) * (0.92 + 0.16 * hash01(`ins|${pid}`));
        break;
      }
      case 'major': {
        v = 0;
        for (const s of MAJOR_SCRIPT) if (s.pid === pid && s.ref === n.ref && s.a === a) v += s.amount;
        // small routine majors, ~2% of property-months per account
        if (!v && a > 0 && hash01(`maj|${pid}|${n.ref}|${ym}`) < 0.02) v = 700 + hash01(`majA|${pid}|${n.ref}|${ym}`) * 1800;
        break;
      }
      case 'reno': {
        v = 0;
        for (const p of renoProjects.get(`${pid}|${ym}`) || []) v += p.parts[c.part] || 0;
        break;
      }
      case 'interest': v = 0; break;      // filled in by monthly() once the loans are sized
      default: v = 0;
    }
    for (const e of eventFor(pid, n.ref, a)) {
      if (e.set != null) v = e.set; else if (e.mult != null) v *= e.mult; else if (e.add != null) v += e.add;
    }
    out[n.ref] = dollars(cents(v));
  }
  cacheBase.set(key, out);
  return out;
}

// ── loans ───────────────────────────────────────────────────────────────────
const SUM_NOI = (pids, fromA, toA) => {
  let s = 0;
  for (let a = fromA; a <= toA; a++) {
    const ym = idxToYM(CUR_IDX - a);
    for (const pid of pids) s += baseTotals(pid, ym).noi;
  }
  return s;
};
function baseTotals(pid, ym) {
  const m = baseMonthly(pid, ym);
  let income = 0, otherIncome = 0, opex = 0, nonop = 0;
  for (const n of leafNodes) {
    const v = m[n.ref] || 0;
    if (n.type === INC) income += v;
    else if (n.type === OINC) otherIncome += v;
    else if (n.type === EXP) opex += v;
    else nonop += v;
  }
  return { income, otherIncome, opex, nonop, noi: income - opex };
}

function simulateLoan(spec, orig) {
  // Returns rows by YM: { start, interest, principal, payment, end } from origination onward.
  const rows = new Map();
  const r = spec.rate / 12;
  const amortPmt = orig * r / (1 - Math.pow(1 + r, -spec.amortMonths));
  let bal = orig;
  const first = ymToIdx(spec.orig);
  for (let i = first; i <= CUR_IDX; i++) {
    const n = i - first;                       // payments already made before this month
    const interest = bal * r;
    const io = n < spec.ioMonths;
    const principal = io ? 0 : Math.min(bal, amortPmt - interest);
    rows.set(idxToYM(i), { start: bal, interest, principal, payment: interest + principal, end: bal - principal });
    bal -= principal;
  }
  return rows;
}
const loans = LOAN_SPEC.map(spec => {
  const noi = SUM_NOI(spec.propertyIds, 1, 12);
  const target = noi / (spec.dscrIO * spec.rate);
  const unit = simulateLoan(spec, 1);
  const orig = target / unit.get(currentYM).end;
  const sched = simulateLoan(spec, orig);
  // allocation of the loan's payments to buildings, by T12 NOI
  const share = {};
  for (const pid of spec.propertyIds) share[pid] = SUM_NOI([pid], 1, 12) / noi;
  const acct = accountByRef(spec.ref);
  return { ...spec, id: acct.id, accountId: acct.id, originalPrincipal: Math.round(orig), sched, share, vendor: vendorByName.get(spec.lender) };
});
const loanMonth = (loan, ym) => {
  const r = loan.sched.get(ym);
  return r ? { interest: dollars(cents(r.interest)), principal: dollars(cents(r.principal)), payment: dollars(cents(r.payment)), balance: dollars(cents(r.end)) } : null;
};
const loansFor = pid => loans.filter(l => l.propertyIds.includes(Number(pid)));
function interestFor(pid, ym) {
  let c = 0;
  for (const l of loansFor(pid)) { const m = loanMonth(l, ym); if (m) c += cents(m.interest * l.share[pid]); }
  return dollars(c);
}
function principalFor(pid, ym) {
  let c = 0;
  for (const l of loansFor(pid)) { const m = loanMonth(l, ym); if (m) c += cents(m.principal * l.share[pid]); }
  return dollars(c);
}

const cacheFull = new Map();
function monthly(pid, ym) {
  pid = Number(pid);
  if (!MONTHS.includes(ym)) return {};
  const key = `${pid}|${ym}`;
  if (cacheFull.has(key)) return cacheFull.get(key);
  const m = { ...baseMonthly(pid, ym) };
  m['6230'] = interestFor(pid, ym);
  cacheFull.set(key, m);
  return m;
}

function totals(pid, ym) {
  const m = monthly(pid, ym);
  const t = baseTotals(pid, ym);
  const interest = m['6230'] || 0;
  return { ...t, nonop: t.nonop, interest, principal: principalFor(pid, ym), debtService: interest + principalFor(pid, ym), net: t.noi - t.nonop };
}

// ── bank balances & balance sheet ───────────────────────────────────────────
const bankAccounts = BS_SPEC.filter(b => b.type === 'Bank').map(b => accountByRef(b.ref));
function t12(pid, key) { let s = 0; for (let a = 1; a <= 12; a++) s += baseTotals(pid, idxToYM(CUR_IDX - a))[key]; return s; }
function balances(pid, asOf) {
  const ym = String(asOf).slice(0, 7);
  const a = Math.max(0, monthsAgo(ym));
  const g = growth(a);
  const units = unitsOf(pid).length;
  const tenants = world.currentTenants.filter(t => t.propertyId === pid);
  const rents = tenants.reduce((s, t) => s + t.rent, 0);
  const opexMo = t12(pid, 'opex') / 12;
  const wiggle = 1 + (hash01(`cash|${pid}|${ym}`) - 0.5) * 0.18;
  const deposits = rents * g;
  const ar = world.currentTenants.filter(t => t.propertyId === pid).reduce((s, t) => s + (t.balance || 0), 0);
  const cost = (t12(pid, 'noi') / 0.058) * g;
  const loanBal = loansFor(pid).reduce((s, l) => { const m = loanMonth(l, MONTHS.includes(ym) ? ym : currentYM); return s + (m ? m.balance * l.share[pid] : 0); }, 0);
  const rec = {
    '1010': (opexMo * 2.3 + units * 1100) * wiggle * g,
    '1020': units * (1650 - a * 12),
    '1030': deposits,
    '1200': ar,
    '1500': cost,
    '1510': -cost * 0.12 * (1 - a / 120),
    '2100': opexMo * 0.55 * wiggle,
    '2200': deposits,
    '2210': rents * 0.04,
  };
  for (const l of loansFor(pid)) { const m = loanMonth(l, MONTHS.includes(ym) ? ym : currentYM); rec[l.ref] = m ? m.balance * l.share[pid] : 0; }
  const assets = rec['1010'] + rec['1020'] + rec['1030'] + rec['1200'] + rec['1500'] + rec['1510'];
  const liab = rec['2100'] + rec['2200'] + rec['2210'] + loanBal;
  rec['3900'] = cost * 0.11;
  rec['3000'] = assets - liab - rec['3900'];
  for (const k of Object.keys(rec)) rec[k] = dollars(cents(rec[k]));
  return rec;
}
// Rows for Report 38: [{ ref, name, type, amount (positive display), raw (RM sign) , ... }]
function balanceSheet(asOf, pids = propertyIds) {
  const sums = {};
  for (const pid of pids) { const b = balances(Number(pid), asOf); for (const [k, v] of Object.entries(b)) sums[k] = (sums[k] || 0) + v; }
  const rows = [];
  const push = (a, amount) => {
    const assetLike = ['Bank', 'Receivable', 'Fixed Asset'].includes(a.type);
    rows.push({ ref: a.ref, name: a.name, type: a.type, accountId: a.id, amount: dollars(cents(amount)), raw: dollars(cents(assetLike ? -amount : amount)) });
  };
  for (const b of BS_SPEC) {
    const a = accountByRef(b.ref);
    if (b.block) { for (const l of LOAN_SPEC) push(accountByRef(l.ref), sums[l.ref] || 0); }
    else push(a, sums[b.ref] || 0);
  }
  return rows;
}

// ── GL entries ──────────────────────────────────────────────────────────────
const TASKS = {
  '5101': ['replace disposal', 'range igniter repair', 'dishwasher pump', 'refrigerator thermostat', 'washer hookup'],
  '5102': ['clear kitchen drain', 'replace toilet fill valve', 'repair leaking supply line', 'water heater element', 'tub spout replacement'],
  '5103': ['replace GFCI outlets', 'repair bath fan wiring', 'breaker replacement', 'hallway lighting repair'],
  '5104': ['furnace igniter replacement', 'AC capacitor', 'thermostat replacement', 'condenser fan motor', 'seasonal tune-up'],
  '5105': ['rekey after move-out', 'replace deadbolt', 'mailbox lock replacement'],
  '5107': ['patch and paint after repair', 'ceiling water-stain repair', 'drywall patch'],
  '5108': ['replace patio door roller', 'window balance repair', 'entry door weatherstrip'],
  '5109': ['general maintenance', 'smoke detector batteries', 'blinds replacement', 'hallway carpet seam'],
  '5106': ['turnover make-ready', 'deep clean and touch-up paint', 'turn: carpet clean & paint', 'unit turn labor'],
};
const MEMO_REFS = new Set(Object.keys(TASKS));
const TXN_CODES = { Bill: 11, Check: 12, 'CC CHG': 13, Journal: 14, Payroll: 15, Charge: 21 };

// How each account's month is booked as transactions.
//   n: [min,max] postings in the month · vendors: VENDOR_DEFS key · type · cc: share paid by card
const RULES = {
  '5000': { vendors: 'mgmt', n: [1, 1], day: 28, text: 'Management fee' },
  '5001': { vendors: 'advertising', n: [1, 2] },
  '5010': { vendors: 'bank', n: [1, 1], day: 30, text: 'Monthly bank service charges' },
  '5020': { vendors: 'legal', n: [1, 2] },
  '5031': { vendors: 'pest', n: [1, 1], day: 12, text: 'Monthly pest control service' },
  '5035': { vendors: 'landscape', n: [1, 2], text: 'Grounds and snow service' },
  '5045': { vendors: 'cleaning', n: [1, 2], text: 'Common-area cleaning' },
  '5060': { vendors: 'internet', n: [1, 2], day: 8, text: 'Internet and phone service' },
  '5070': { vendors: 'software', n: [1, 2], day: 3, text: 'Software subscription' },
  '5080': { vendors: 'license', n: [1, 1] },
  '5050-1': { vendors: 'insProp', n: [1, 1], day: 1, text: 'Property insurance premium (monthly installment)' },
  '5050-2': { vendors: 'insLiab', n: [1, 1], day: 1, text: 'General liability and umbrella installment' },
  '5101': { vendors: 'appliance', n: [1, 3] },
  '5102': { vendors: 'plumbing', n: [1, 3] },
  '5103': { vendors: 'electrical', n: [1, 2] },
  '5104': { vendors: 'hvac', n: [1, 3] },
  '5105': { vendors: 'locks', n: [1, 2] },
  '5107': { vendors: 'paint', n: [1, 2] },
  '5108': { vendors: 'doors', n: [1, 2] },
  '5109': { vendors: 'general', n: [1, 3] },
  '5201': { vendors: 'supplies', n: [2, 4], cc: true },
  '5202': { vendors: 'janSupplies', n: [1, 3], cc: true },
  '5203': { vendors: 'paintSupplies', n: [1, 3], cc: true },
  '5204': { vendors: 'lighting', n: [1, 2], cc: true },
  '5106': { vendors: 'turnover', n: [2, 5] },
  '5301-1': { vendors: 'tax', n: [1, 1], day: 20, text: 'Real estate tax accrual' },
  '5301-2': { vendors: 'tax', n: [1, 1], day: 20, text: 'Special assessment' },
  '5401': { vendors: 'gas', n: [1, 1], day: 16, text: 'Natural gas', period: true },
  '5402-1': { vendors: 'water', n: [1, 1], day: 14, text: 'Water', period: true },
  '5402-2': { vendors: 'water', n: [1, 1], day: 14, text: 'Sewer', period: true },
  '5402-3': { vendors: 'waste', n: [1, 1], day: 10, text: 'Solid waste and recycling' },
  '5404': { vendors: 'electric', n: [1, 1], day: 18, text: 'Common-area electric', period: true },
  '5701': { payroll: true, text: 'Maintenance wages' },
  '5702': { payroll: true, text: 'Employer payroll taxes' },
  '5703': { vendors: 'payroll', n: [1, 1], day: 28, text: 'Workers compensation premium' },
  '5704': { vendors: 'payroll', n: [1, 1], day: 28, text: 'Employee benefits' },
  '5040': { vendors: 'commission', n: [1, 2], text: 'Leasing commission' },
  '5710': { payroll: true, text: 'Property management salary' },
  '5151': { vendors: 'electrical', n: [1, 1], major: true },
  '5152': { vendors: 'doors', n: [1, 1], major: true },
  '5156': { vendors: 'turnover', n: [1, 1], major: true },
  '5158': { vendors: 'plumbing', n: [1, 1], major: true },
  '5160': { vendors: 'paint', n: [1, 1], major: true },
  '5161': { vendors: 'boiler', n: [1, 1], major: true },
  '5168': { vendors: 'flooring', n: [1, 1], major: true },
  '5172': { vendors: 'roof', n: [1, 1], major: true },
};

function splitCents(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  const parts = weights.map(w => Math.floor(total * w / sum));
  parts[0] += total - parts.reduce((s, p) => s + p, 0);
  return parts;
}
const fmtMDY = (y, m, d) => `${pad2(m)}/${pad2(d)}/${String(y).slice(2)}`;
const isoDate = (ym, d) => `${ym}-${pad2(d)}`;
const addDaysISO = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY_ISO = `${currentYM}-${pad2(TODAY_DAY)}`;

const entryCache = new Map();      // `${pid}|${ym}` → entries
const entryIndex = new Map();      // id → entry
function buildEntries(pid, ym) {
  const key = `${pid}|${ym}`;
  if (entryCache.has(key)) return entryCache.get(key);
  const m = monthly(pid, ym);
  const pIdx = propIndex.get(pid);
  const ymI = ymToIdx(ym);
  const base = 100000 + (ymI - 23900) * 5000 + pIdx * 1000;
  let seq = 0;
  const short = shortName(pid);
  const [yy, mm] = ym.split('-').map(Number);
  const maxDay = ym === currentYM ? Math.min(TODAY_DAY, lastDay(ym)) : lastDay(ym);
  const out = [];
  const units = unitsOf(pid);

  function emit(e) {
    const acct = accountByRef(e.ref);
    const date = e.date > TODAY_ISO ? TODAY_ISO : e.date;
    const credit = e.amountC < 0 ? -e.amountC : 0;
    const debit = e.amountC > 0 ? e.amountC : 0;
    const income = acct.type === INC || acct.type === OINC;
    const txnId = base + (seq++);
    const type = e.type;
    const row = {
      id: `E${pid}-${ym}-${e.ref}-${seq}`,
      txnId, txnType: type, txnCode: TXN_CODES[type] || 14,
      hyperlink: `${TXN_CODES[type] || 14}:${txnId}`,
      date, month: ym,
      propertyId: pid, propertyShortName: short,
      accountRef: e.ref, accountId: acct.id, accountName: acct.name,
      vendor: e.vendor || '', vendorId: e.vendor ? vendorByName.get(e.vendor).id : null,
      reference: e.reference || '', invoiceNo: e.invoiceNo || null,
      description: e.description, memo: e.memo || '',
      // GL convention: expenses debit, income credits. amountC is the *spend* amount in cents.
      debit: dollars(income ? credit : debit),
      credit: dollars(income ? debit : credit),
      amount: dollars(e.amountC),
      billId: type === 'Bill' ? txnId : null,
      checkNo: type === 'Check' ? String(e.reference || '') : null,
      dueDate: type === 'Bill' ? addDaysISO(date, 30) : null,
      paidDate: (type === 'Bill' || type === 'CC CHG') ? (addDaysISO(date, 12) <= TODAY_ISO ? addDaysISO(date, 12) : null) : date,
      unitName: e.unitName || null,
      servicePeriod: e.servicePeriod || null,
    };
    entryIndex.set(row.id, row);
    out.push(row);
  }

  const invoiceNo = (ref, k) => String(10000 + Math.floor(hash01(`inv|${pid}|${ym}|${ref}|${k}`) * 89999));
  const dayOf = (ref, k, fixed) => Math.min(maxDay, fixed || 1 + Math.floor(hash01(`day|${pid}|${ym}|${ref}|${k}`) * 27));

  for (const n of leafNodes) {
    const ref = n.ref;
    const amt = m[ref] || 0;
    if (!amt) continue;
    const total = cents(amt);
    if (n.type === INC || n.type === OINC) {
      emit({ ref, date: isoDate(ym, 1), type: 'Charge', amountC: total,
        description: ref === '4000' ? `Rent charges for ${monLabel(ym)}` : `${n.name} — ${monLabel(ym)}`, reference: `CHG-${ym.replace('-', '')}-${ref}` });
      continue;
    }
    if (ref === '6230') continue;                           // below, with the loan postings
    if (n.calc.k === 'reno') {
      for (const proj of renoProjects.get(`${pid}|${ym}`) || []) {
        const v = proj.parts[n.calc.part];
        if (!v) continue;
        const d = dayOf(ref, proj.unit, null);
        if (n.calc.part === 'labor') {
          emit({ ref, date: isoDate(ym, d), type: 'Payroll', amountC: cents(v), unitName: proj.unit,
            description: `In-house renovation crew — Unit ${proj.unit} ${RENO_TASK.labor}`, reference: `PR-${ym.replace('-', '')}-${d}` });
        } else {
          const vendor = VENDOR_DEFS[RENO_VENDOR[n.calc.part]][Math.floor(hash01(`rv|${pid}|${ym}|${proj.unit}|${n.calc.part}`) * VENDOR_DEFS[RENO_VENDOR[n.calc.part]].length)];
          const inv = invoiceNo(ref, proj.unit);
          emit({ ref, date: isoDate(ym, d), type: 'Bill', vendor, amountC: cents(v), unitName: proj.unit, invoiceNo: inv, reference: inv,
            description: `${vendor}: ${inv}`, memo: `Unit ${proj.unit} — ${RENO_TASK[n.calc.part]}` });
        }
      }
      continue;
    }
    if (n.calc.k === 'major') {
      const s = MAJOR_SCRIPT.find(x => x.pid === pid && x.ref === ref && x.a === monthsAgo(ym));
      const rule = RULES[ref];
      const names = VENDOR_DEFS[rule.vendors];
      const vendor = names[Math.floor(hash01(`mv|${pid}|${ym}|${ref}`) * names.length)];
      const inv = invoiceNo(ref, 0);
      const unit = units[Math.floor(hash01(`mu|${pid}|${ym}|${ref}`) * units.length)].name;
      emit({ ref, date: isoDate(ym, dayOf(ref, 0, null)), type: 'Bill', vendor, amountC: total, invoiceNo: inv, reference: inv,
        description: `${vendor}: ${inv}`, memo: s ? s.desc : `${n.name.replace(/^Major\s*-\s*/, '')} — unit ${unit}`, unitName: s ? null : unit });
      continue;
    }
    const rule = RULES[ref] || { vendors: 'general', n: [1, 1] };
    if (rule.payroll) {
      const label = rule.text;
      const halves = cents(amt) >= 0 ? splitCents(total, [1, 1]) : [total];
      halves.forEach((c, k) => {
        const d = k === 0 ? Math.min(15, maxDay) : maxDay;
        if (d < 1) return;
        emit({ ref, date: isoDate(ym, d), type: 'Payroll', amountC: c, reference: `PR-${ym.replace('-', '')}-${d}`,
          description: `${label} — pay period ending ${fmtMDY(yy, mm, d)}` });
      });
      continue;
    }
    // vendor-billed account
    const names = VENDOR_DEFS[vendorKeyFor(pid, rule.vendors)];
    const negative = total < 0;
    let count = negative ? 1 : rule.n[0] + Math.floor(hash01(`n|${pid}|${ym}|${ref}`) * (rule.n[1] - rule.n[0] + 1));
    const weights = Array.from({ length: count }, (_, k) => 0.4 + hash01(`w|${pid}|${ym}|${ref}|${k}`));
    const parts = negative ? [total] : splitCents(total, weights);
    // the early-month bills that haven't posted yet in the in-progress month
    parts.forEach((c, k) => {
      const vendor = names[Math.floor(hash01(`v|${pid}|${ym}|${ref}|${k}`) * names.length)];
      const day = dayOf(ref, k, rule.day);
      const date = isoDate(ym, day);
      const card = rule.cc;
      const type = card ? 'CC CHG' : (names === VENDOR_DEFS.tax || rule.vendors === 'bank') ? 'Bill' : (hash01(`t|${pid}|${ym}|${ref}|${k}`) < 0.12 && !rule.period && !rule.text ? 'Check' : 'Bill');
      const e = { ref, date, type, vendor, amountC: c };
      if (negative) {
        const inv = invoiceNo(ref, k);
        Object.assign(e, { invoiceNo: `CM-${inv}`, reference: `CM-${inv}`, description: `${vendor}: CM-${inv}`, memo: `Credit memo — ${n.name} (${rule.period ? 'billing correction' : /^5050/.test(ref) ? 'premium audit refund' : 'vendor credit'})` });
      } else if (card) {
        const mdy = `${pad2(mm)}.${pad2(day)}.${String(yy).slice(2)}`;
        Object.assign(e, { reference: `CC${ym.replace('-', '')}${k}`, description: `${vendor} — ${mdy}`, memo: `${n.name} — card purchase` });
      } else if (rule.period) {
        // utilities name the service period they cover, not a vendor invoice number
        const prev = idxToYM(ymI - 1);
        const [py, pm] = prev.split('-').map(Number);
        const from = fmtMDY(py, pm, Math.min(day, lastDay(prev)));
        const to = fmtMDY(yy, mm, Math.max(1, day - 1));
        const acctNo = `${vendorByName.get(vendor).acctNo}${String(pIdx + 1).padStart(2, '0')}`;
        Object.assign(e, { reference: acctNo, description: `${vendor}: ${acctNo} - ${from} - ${to}`, memo: `${rule.text} — service ${from} to ${to}`, servicePeriod: { from, to } });
      } else if (rule.text) {
        const inv = invoiceNo(ref, k);
        Object.assign(e, { invoiceNo: inv, reference: inv, description: `${vendor}: ${inv}`, memo: `${rule.text} — ${monLabel(ym)}` });
      } else {
        const inv = invoiceNo(ref, k);
        let memo = n.name;
        if (MEMO_REFS.has(ref)) {
          const tasks = TASKS[ref];
          const unit = units[Math.floor(hash01(`u|${pid}|${ym}|${ref}|${k}`) * units.length)].name;
          memo = `Unit ${unit} — ${tasks[Math.floor(hash01(`tk|${pid}|${ym}|${ref}|${k}`) * tasks.length)]}`;
          e.unitName = unit;
        }
        Object.assign(e, { invoiceNo: inv, reference: inv, description: `${vendor}: ${inv}`, memo });
      }
      if (type === 'Check') e.reference = String(5000 + Math.floor(hash01(`ck|${pid}|${ym}|${ref}|${k}`) * 4000));
      emit(e);
    });
  }

  // mortgage interest and principal (loan postings)
  for (const l of loansFor(pid)) {
    const lm = loanMonth(l, ym);
    if (!lm) continue;
    const date = isoDate(ym, 1);
    const ic = cents(lm.interest * l.share[pid]);
    const pc = cents(lm.principal * l.share[pid]);
    const nm = ym.replace('-', '');
    if (ic) emit({ ref: '6230', date, type: 'Check', vendor: l.lender, amountC: ic, reference: `ACH-${l.loanNo}-${nm}`,
      description: `${l.lender}: Loan ${l.loanNo} interest — ${monLabel(ym)}`, memo: `Mortgage interest, loan ${l.loanNo}` });
    if (pc) emit({ ref: l.ref, date, type: 'Check', vendor: l.lender, amountC: pc, loanPayment: true, reference: `ACH-${l.loanNo}-${nm}`,
      description: `${l.lender}: Loan ${l.loanNo} principal — ${monLabel(ym)}`, memo: `Principal paydown, loan ${l.loanNo}` });
  }
  entryCache.set(key, out);
  return out;
}
// Loan principal postings debit the liability: fix their debit/credit orientation once built.
function fixLoanSide(e) {
  if (accountByRef(e.accountRef).parentRef === '2300') { e.debit = e.amount; e.credit = 0; }
  return e;
}

// ── planted findings in the transactions ────────────────────────────────────
// Totals never change; only how a month's postings are labelled. A "duplicate payment" is
// a check keyed straight to the expense account that repeats a bill already entered for the
// same vendor and invoice number (the second of two bills for the account is relabelled).
// The month is searched for (not hard-coded) so the story survives the calendar moving on.
const DUP_PLANTS = [
  { pid: 104, from: 1, to: 5, refs: ['5106', '5109', '5102', '5104', '5101', '5103'] },
  { pid: 101, from: 2, to: 5, refs: ['5106', '5104', '5109', '5102', '5101', '5103'] },
];
const planted = { duplicates: [] };
let plantsDone = false;
function ensurePlants() {
  if (plantsDone) return;
  plantsDone = true;
  for (const d of DUP_PLANTS) {
    let hit = null, bestAmt = 0;
    for (let a = d.from; a <= d.to; a++) {
      const ym = idxToYM(CUR_IDX - a);
      if (!MONTHS.includes(ym)) continue;
      const list = buildEntries(d.pid, ym);
      for (const ref of d.refs) {
        const bills = list.filter(e => e.accountRef === ref && e.txnType === 'Bill' && e.amount > 0 && e.invoiceNo)
          .sort((x, y) => y.amount - x.amount);
        // the pair with the most money in it: the larger bill stays a bill, the next largest is the repeat
        if (bills.length >= 2 && bills[1].amount > bestAmt) { bestAmt = bills[1].amount; hit = { bill: bills[0], dup: bills[1], ym }; }
      }
    }
    if (!hit) continue;
    const { bill, dup } = hit;
    const checkNo = String(7000 + Math.floor(hash01(`dupck|${dup.id}`) * 1900));
    Object.assign(dup, {
      txnType: 'Check', txnCode: TXN_CODES.Check, hyperlink: `${TXN_CODES.Check}:${dup.txnId}`,
      vendor: bill.vendor, vendorId: bill.vendorId, invoiceNo: bill.invoiceNo,
      description: `${bill.vendor}: ${bill.invoiceNo}`, reference: checkNo, checkNo,
      billId: null, dueDate: null, paidDate: dup.date,
      memo: `${dup.memo.replace(/ \(.*$/, '')} (check keyed to expense)`,
    });
    planted.duplicates.push({ propertyId: d.pid, month: hit.ym, billTxnId: bill.txnId, checkTxnId: dup.txnId, invoiceNo: bill.invoiceNo, vendor: bill.vendor });
  }
}

function glEntries(from, to, propertyIds_, opts = {}) {
  ensurePlants();
  const f = String(from).slice(0, 10), t = String(to).slice(0, 10);
  const pids = propertyIds_ == null ? propertyIds
    : (Array.isArray(propertyIds_) ? propertyIds_ : String(propertyIds_).split(',')).map(Number).filter(n => propIndex.has(n));
  const refs = opts.refs ? new Set(opts.refs.map(String)) : null;
  const out = [];
  for (const ym of MONTHS) {
    if (ym < f.slice(0, 7) || ym > t.slice(0, 7)) continue;
    for (const pid of pids) {
      for (const e of buildEntries(pid, ym)) {
        if (e.date < f || e.date > t) continue;
        if (refs && !refs.has(e.accountRef)) continue;
        out.push(fixLoanSide(e));
      }
    }
  }
  out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.txnId - y.txnId));
  return out;
}
function entryById(id) {
  ensurePlants();
  if (!entryIndex.has(id)) {
    const m = /^E(\d+)-(\d{4}-\d{2})-/.exec(String(id));
    if (m) buildEntries(Number(m[1]), m[2]);
  }
  return entryIndex.get(id) || null;
}
function entryByTxnId(txnId) {
  ensurePlants();
  txnId = Number(txnId);
  const ymI = 23900 + Math.floor((txnId - 100000) / 5000);
  const pIdx = Math.floor(((txnId - 100000) % 5000) / 1000);
  const pid = propertyIds[pIdx];
  if (pid == null) return null;
  return buildEntries(pid, idxToYM(ymI)).find(e => e.txnId === txnId) || null;
}

module.exports = {
  chart, accountByRef, accountById, childrenOf, layout, leafNodes, leafByRef, SPEC, BS_SPEC,
  MONTHS, currentYM, monthsAgo, idxToYM, ymToIdx, lastDay,
  propertyIds, shortName,
  monthly, totals, baseTotals, principalFor, interestFor,
  loans, loanMonth, loansFor,
  glEntries, entryById, entryByTxnId,
  vendors, vendorById, vendorByName,
  balanceSheet, balances, bankAccounts,
  EVENTS, RENT_DIPS, MAJOR_SCRIPT, renoProjects, planted, ensurePlants,
  INC, EXP, NOP, OINC,
};
