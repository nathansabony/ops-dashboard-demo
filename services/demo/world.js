// The demo's fake world: one entity ("Cedar Ridge Holdings"), five properties, 56 units,
// 50 current tenants (+ former ones). Everything is generated deterministically from a
// seed and anchored to TODAY, so the demo always looks current without a data refresh.
//
// This is a neutral data model. services/demo/routes/*.js turn it into the exact shapes
// Rent Manager's API returns, so every real pipeline in the site runs unmodified.

const SEED = 20260101;
function rng(seed) {                       // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = arr => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + rand() * (hi - lo);
const int = (lo, hi) => Math.floor(between(lo, hi + 1));
const round2 = n => Math.round(n * 100) / 100;

const TODAY = new Date();
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), 28)); return x; };
const firstOfMonth = (d, offset = 0) => new Date(d.getFullYear(), d.getMonth() + offset, 1);

const ENTITY = { name: 'Cedar Ridge', legalName: 'Cedar Ridge Holdings, LLC', billingName: 'Cedar Ridge Holdings, LLC' };

const PROPERTIES = [
  { id: 101, name: 'The Alder',          street: '410 Alder Street',      city: 'Columbus', state: 'OH', zip: '43215', units: 12, built: 1998, rent: 1425, sqft: 780 },
  { id: 102, name: 'Maple Court',        street: '88 Maple Court',        city: 'Columbus', state: 'OH', zip: '43214', units: 12, built: 1987, rent: 1295, sqft: 720 },
  { id: 103, name: 'Willow Creek',       street: '2301 Willow Creek Rd',  city: 'Columbus', state: 'OH', zip: '43229', units: 11, built: 2004, rent: 1560, sqft: 860 },
  { id: 104, name: 'Birchwood Commons',  street: '77 Birchwood Lane',     city: 'Columbus', state: 'OH', zip: '43224', units: 11, built: 1992, rent: 1340, sqft: 760 },
  { id: 105, name: 'Summit Lofts',       street: '15 Summit Avenue',      city: 'Columbus', state: 'OH', zip: '43201', units: 10, built: 2012, rent: 1695, sqft: 910 },
].map(p => ({ ...p, entity: ENTITY.name, billingName: ENTITY.billingName }));

const BED_MIX = [['Studio', 0, 0.8], ['1BR', 1, 1.0], ['1BR', 1, 1.0], ['2BR', 2, 1.28], ['2BR', 2, 1.3], ['3BR', 3, 1.55]];

// ── units ───────────────────────────────────────────────────────────────────
const UNITS = [];
let unitId = 5000;
for (const p of PROPERTIES) {
  for (let i = 0; i < p.units; i++) {
    const floor = Math.floor(i / 4) + 1;
    const [label, beds, mult] = BED_MIX[i % BED_MIX.length];
    UNITS.push({
      id: ++unitId, propertyId: p.id, name: `${floor}${pad((i % 4) + 1)}`, bedrooms: beds, type: label,
      sqft: Math.round(p.sqft * (0.85 + beds * 0.17)), marketRent: Math.round(p.rent * mult / 5) * 5,
      tenantId: null, // set below
    });
  }
}

// ── people ──────────────────────────────────────────────────────────────────
const FIRST = ['Olivia','Liam','Emma','Noah','Ava','Elijah','Sophia','Mateo','Isabella','Lucas','Mia','Amara','Ethan','Harper','Daniel','Camila','Aiden','Layla','Jackson','Zoe','Samuel','Nora','Gabriel','Ruby','Henry','Priya','Omar','Chloe','Marcus','Elena','Tyler','Grace','Andre','Hannah','Victor','Lila','Caleb','Maya','Diego','Naomi','Owen','Imani','Felix','Tessa','Jonah','Sienna','Rafael','Claire','Dominic','Wren','Theo','June','Malik','Ingrid','Pablo','Rosa'];
const LAST = ['Alvarez','Bennett','Chen','Dawson','Okafor','Fischer','Gupta','Hartley','Ibrahim','Jensen','Kowalski','Lindqvist','Morales','Nguyen','Ortega','Patel','Quinn','Reyes','Sato','Thornton','Underwood','Vasquez','Whitaker','Xu','Yamamoto','Zimmerman','Abbott','Brennan','Castillo','Delgado','Ellison','Foster','Grant','Hughes','Irving','Jordan','Keller','Lawson','Mercer','Navarro','Osei','Pruitt','Ramsey','Sullivan','Tran','Ulrich','Vance','Wallace','Young','Zielinski','Barlow','Coleman','Dunn','Eaton'];
const used = new Set();
function personName() {
  for (;;) {
    const n = `${pick(FIRST)} ${pick(LAST)}`;
    if (!used.has(n)) { used.add(n); return n; }
  }
}

// ── tenants & leases ────────────────────────────────────────────────────────
// 50 current tenants fill 50 of 56 units (89% occupied; the 6 vacant units are spread
// across properties). A dozen former tenants moved out over the past year.
const TENANTS = [];
let tenantId = 9000;
const VACANT_UNIT_IDS = new Set();
[0, 7, 15, 24, 33, 41].forEach(i => { const u = UNITS[(i * 3 + 2) % UNITS.length]; VACANT_UNIT_IDS.add(u.id); });
while (VACANT_UNIT_IDS.size < 6) VACANT_UNIT_IDS.add(UNITS[int(0, UNITS.length - 1)].id);

const DELINQUENT_PLAN = [   // [monthsBehind, share of one month's rent already paid] for 6 tenants
  [1, 0.4], [1, 0.6], [1, 0.25], [1, 1], [2, 0.5], [1, 0.5],
];
let delIdx = 0;
const unitsList = UNITS.filter(u => !VACANT_UNIT_IDS.has(u.id));
unitsList.forEach((u, i) => {
  const startMonthsAgo = int(1, 34);
  const leaseStart = firstOfMonth(addMonths(TODAY, -startMonthsAgo));
  let leaseEnd = addMonths(leaseStart, 12 * Math.ceil((startMonthsAgo + 1) / 12));
  if (leaseEnd < addDays(TODAY, 20)) leaseEnd = addMonths(leaseEnd, 12);
  const rent = Math.round(u.marketRent * between(0.93, 1.02) / 5) * 5;
  const t = {
    id: ++tenantId, name: personName(), unitId: u.id, propertyId: u.propertyId, status: 'Current',
    leaseStart, leaseEnd, rent, email: null, phone: `(614) 555-${String(int(100, 989)).padStart(4, '0')}`,
    behindMonths: 0, partialPaid: 0, balance: 0, moveIn: leaseStart,
  };
  t.email = t.name.toLowerCase().replace(/[^a-z ]/g, '').replace(/ /g, '.') + '@example.com';
  if (i % 5 === 3 && delIdx < DELINQUENT_PLAN.length) {
    const [m, partial] = DELINQUENT_PLAN[delIdx++];
    t.behindMonths = m; t.partialPaid = partial >= 1 ? 0 : round2(rent * partial);
    t.balance = round2(rent * m - t.partialPaid);
  }
  u.tenantId = t.id;
  TENANTS.push(t);
});
// Former tenants — moved out across the last 12 months; vacant units list them as last occupant.
const vacantUnits = UNITS.filter(u => VACANT_UNIT_IDS.has(u.id));
for (let i = 0; i < 14; i++) {
  const u = i < vacantUnits.length ? vacantUnits[i] : pick(unitsList);
  const moveOutMonthsAgo = i < vacantUnits.length ? int(0, 2) : int(2, 11);
  const moveOut = addDays(firstOfMonth(addMonths(TODAY, -moveOutMonthsAgo)), int(0, 27));
  const moveIn = addMonths(moveOut, -int(10, 30));
  const name = personName();
  TENANTS.push({
    id: ++tenantId, name, unitId: u.id, propertyId: u.propertyId, status: 'Past',
    leaseStart: moveIn, leaseEnd: moveOut, rent: Math.round(u.marketRent * 0.97 / 5) * 5,
    email: name.toLowerCase().replace(/[^a-z ]/g, '').replace(/ /g, '.') + '@example.com',
    phone: `(614) 555-${String(int(100, 989)).padStart(4, '0')}`,
    behindMonths: 0, partialPaid: 0, balance: 0, moveIn, moveOut,
  });
}

const STAFF = [
  { id: 1, name: 'Jordan Reyes', role: 'Regional Manager' },
  { id: 2, name: 'Priya Natarajan', role: 'Property Manager' },
  { id: 3, name: 'Sam Whitfield', role: 'Maintenance Supervisor' },
  { id: 4, name: 'Dana Okoye', role: 'Accounting' },
];

const byId = (arr) => new Map(arr.map(x => [x.id, x]));
const world = {
  seed: SEED, today: TODAY, ENTITY, PROPERTIES, UNITS, TENANTS, STAFF,
  propertyById: byId(PROPERTIES), unitById: byId(UNITS), tenantById: byId(TENANTS),
  currentTenants: TENANTS.filter(t => t.status === 'Current'),
  vacantUnitIds: VACANT_UNIT_IDS,
  util: { rng, rand, pick, between, int, round2, pad, ymd, addDays, addMonths, firstOfMonth },
};
module.exports = world;
