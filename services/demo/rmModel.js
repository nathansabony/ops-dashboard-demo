// Rent-Manager-shaped model of the fake world for the inventory & operations side:
// the charge ledger (rent, fees, payments), leases, work orders, history notes.
// world.js stays the neutral source of people/units; this file derives everything
// that Rent Manager would hold *about* them, deterministically and anchored to today.
//
// Route modules (routes/inventory.js, tenants.js, operations.js) only reshape what is here.

const world = require('./world');
const U = world.util;
const { ymd, addDays, addMonths, firstOfMonth, round2 } = U;

const TODAY = world.today;
const TODAY_STR = ymd(TODAY);
const GRACE_DAYS = 5;                 // rent posts on the 1st; the site's report uses a 5-day grace
const rng = U.rng(world.seed + 7);    // own stream, so world.js's numbers never move
const hash = (a, b) => (Math.imul(a ^ 0x9e3779b1, 2654435761) ^ Math.imul(b + 0x85ebca6b, 40503)) >>> 0;
const frac = (a, b) => (hash(a, b) % 10000) / 10000;

// ── staff / users ────────────────────────────────────────────────────────────
const USERS = [
  { id: 1, name: 'Jordan Reyes', role: 'Regional Manager' },
  { id: 2, name: 'Priya Natarajan', role: 'Property Manager' },
  { id: 3, name: 'Sam Whitfield', role: 'Maintenance Supervisor' },
  { id: 4, name: 'Dana Okoye', role: 'Accounting' },
  { id: 5, name: 'Marcus Bell', role: 'Maintenance Technician' },
  { id: 6, name: 'Elena Torres', role: 'Maintenance Technician' },
];
// property → the user Rent Manager routes its tickets to (Summit Lofts is left unset on purpose;
// config/property-supers.json fills it, which shows the gap-filler path).
const PROPERTY_SUPER = { 101: 3, 102: 5, 103: 3, 104: 6, 105: null };

// ── property groups / unit status types ──────────────────────────────────────
const GROUP = { id: 1, name: 'Demo Portfolio Portfolio' };
const UNIT_STATUS_TYPES = [
  { id: 1, name: 'Occupied', isVacant: false },
  { id: 2, name: 'Notice - Occupied', isVacant: false },
  { id: 3, name: 'Vacant - Ready', isVacant: true },
  { id: 4, name: 'Vacant - Make Ready', isVacant: true },
  { id: 5, name: 'Vacant - Renovation', isVacant: true },
];

// ── charge types ─────────────────────────────────────────────────────────────
const CHARGE_TYPES = {
  RENT: { id: 1, code: 'RENT', desc: 'Rent' },
  WTR: { id: 2, code: 'WTR', desc: 'Water/Sewer' },
  PET: { id: 3, code: 'PET', desc: 'Pet Fee' },
  PARK: { id: 4, code: 'PARK', desc: 'Parking' },
  LATE: { id: 5, code: 'LATE', desc: 'Late Fee' },
  CLEAN: { id: 6, code: 'CLEAN', desc: 'Move-out Cleaning' },
  DMG: { id: 7, code: 'DMG', desc: 'Damage' },
  LD: { id: 62, code: 'LD', desc: 'Liquidated Damages' },
};

const unitOf = id => world.unitById.get(id);
const propOf = id => world.propertyById.get(id);
const display = t => `CR-${t.id}`;

// ── tenants' expected-vs-notice flags ────────────────────────────────────────
// Two current tenants have given notice (Rent Manager: ExpectedMoveOutDate + NoticeDate).
const NOTICE_TENANT_IDS = new Set();
{
  const cur = world.currentTenants.filter(t => !t.behindMonths);
  [4, 23].forEach(i => { if (cur[i]) NOTICE_TENANT_IDS.add(cur[i].id); });
}
const noticeInfo = t => NOTICE_TENANT_IDS.has(t.id)
  ? { notice: ymd(addDays(TODAY, -9)), expected: ymd(addDays(TODAY, 24)) } : null;

// A few current tenants moved in during the last three months (the world's own leases all start
// at least a month back). Overridden here so move-in activity and the ledger both show recent move-ins.
const EFF = new Map();
{
  const cand = world.currentTenants.filter(t => !t.behindMonths && !NOTICE_TENANT_IDS.has(t.id) && t.leaseStart < addMonths(TODAY, -6));
  [[cand[2], 12], [cand[9], 41], [cand[16], 73]].forEach(([t, d]) => {
    if (!t) return;
    const moveIn = addDays(TODAY, -d);
    EFF.set(t.id, { moveIn, leaseStart: moveIn, leaseEnd: addMonths(moveIn, 12) });
  });
}
const eff = t => EFF.get(t.id) || { moveIn: t.moveIn, leaseStart: t.leaseStart, leaseEnd: t.leaseEnd };

// ── the charge ledger ────────────────────────────────────────────────────────
const CHARGES = [];
let chargeSeq = 700000;
function addCharge(t, type, amount, date, createDate) {
  const u = unitOf(t.unitId);
  const c = {
    id: ++chargeSeq, tenantId: t.id, propertyId: t.propertyId, unitId: t.unitId, unitName: u.name,
    type, amount: round2(amount), date: ymd(date), createDate: ymd(createDate || date), paid: [],
    tenantStatus: t.status,
  };
  CHARGES.push(c);
  return c;
}
function pay(c, date, amount) {
  if (amount <= 0) return;
  if (ymd(date) > TODAY_STR) return;          // a payment dated in the future has not happened
  c.paid.push({ date: ymd(date), amount: round2(amount) });
}
const paidOf = c => round2(c.paid.reduce((s, p) => s + p.amount, 0));
const openOf = c => round2(c.amount - paidOf(c));

// months considered "due" for delinquency: the 1st plus the grace period has passed
function dueMonthStarts() {
  const out = [];
  for (let k = 0; k >= -13; k--) {
    const ms = firstOfMonth(TODAY, k);
    if (ymd(addDays(ms, GRACE_DAYS)) <= TODAY_STR) out.push(ms);
  }
  return out;                                   // newest first
}
const DUE_MONTHS = dueMonthStarts();

for (const t of world.TENANTS) {
  const u = unitOf(t.unitId);
  const current = t.status === 'Current';
  const tIdx = t.id;
  const water = [40, 50, 60, 70][Math.min(3, u.bedrooms)];
  const hasPet = tIdx % 4 === 0, hasPark = tIdx % 5 === 0;
  const startMonth = firstOfMonth(eff(t).moveIn);
  const endDate = current ? null : t.moveOut;
  // delinquent months (newest-first indices into DUE_MONTHS)
  const unpaidMonths = new Set(DUE_MONTHS.slice(0, t.behindMonths || 0).map(d => ymd(d)));
  const oldestUnpaid = [...unpaidMonths].sort()[0];

  for (let k = -13; k <= 1; k++) {
    const ms = firstOfMonth(TODAY, k);
    if (ms < startMonth) continue;
    if (!current && ms > endDate) continue;
    // next month's charges are posted ~5 days early (CreateDate), dated the 1st
    const created = addDays(ms, -5);
    if (k === 1 && ymd(created) > TODAY_STR) continue;
    if (k === 1 && NOTICE_TENANT_IDS.has(t.id) && ymd(ms) > noticeInfo(t).expected) continue;
    const lines = [['RENT', t.rent]];
    lines.push(['WTR', water]);
    if (hasPet) lines.push(['PET', 35]);
    if (hasPark) lines.push(['PARK', 50]);
    const r = frac(tIdx, k + 40);
    for (const [type, amt] of lines) {
      const c = addCharge(t, type, amt, ms, created);
      const msKey = ymd(ms);
      if (type === 'RENT' && unpaidMonths.has(msKey)) {
        // behind: nothing paid, except the oldest unpaid month may carry a part payment
        if (msKey === oldestUnpaid && t.partialPaid) pay(c, addDays(ms, 12), t.partialPaid);
        continue;
      }
      // ordinary payers: paid ahead (10%), 1st-4th (80%), a few days late (10%)
      let payDate;
      if (r < 0.10) payDate = addDays(ms, -(3 + Math.floor(frac(tIdx, k) * 4)));
      else if (r < 0.86 || k >= 0) payDate = addDays(ms, Math.floor(frac(tIdx, k + 7) * 4));
      else if (r < 0.93) payDate = addDays(ms, 5 + Math.floor(frac(tIdx, k + 13) * 4));
      else payDate = addDays(addMonths(ms, 1), 1 + Math.floor(frac(tIdx, k + 21) * 12));   // slow payer: lands in the next month
      pay(c, payDate, c.amount);
    }
    // late fees on months the tenant is behind (dated the 6th)
    if (unpaidMonths.has(ymd(ms))) {
      const lf = addDays(ms, 5);
      if (ymd(lf) <= TODAY_STR) addCharge(t, 'LATE', 75, lf);
    }
  }
}
// Move-out charges on a few former tenants (cleaning, damage, liquidated damages)
{
  const former = world.TENANTS.filter(t => t.status === 'Past').sort((a, b) => b.moveOut - a.moveOut);
  former.slice(0, 8).forEach((t, i) => {
    const d = t.moveOut;
    if (i % 2 === 0) { const c = addCharge(t, 'CLEAN', 125, d); if (i % 4 === 0) pay(c, addDays(d, 9), 125); }
    if (i % 3 === 0) { const c = addCharge(t, 'DMG', 210, d); if (i === 0) pay(c, addDays(d, 20), 100); }
    if (i === 3) addCharge(t, 'LD', 350, d);
  });
}
CHARGES.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id);

const chargesByTenant = new Map();
for (const c of CHARGES) { (chargesByTenant.get(c.tenantId) || chargesByTenant.set(c.tenantId, []).get(c.tenantId)).push(c); }
const tenantBalance = id => round2((chargesByTenant.get(id) || []).reduce((s, c) => s + openOf(c), 0));

// ── leases ───────────────────────────────────────────────────────────────────
const LEASES = world.TENANTS.map((t, i) => {
  const n = noticeInfo(t);
  return {
    LeaseID: 3000 + i + 1,
    TenantID: t.id, UnitID: t.unitId, PropertyID: t.propertyId,
    StartDate: ymd(eff(t).leaseStart), EndDate: ymd(eff(t).leaseEnd),
    MoveInDate: ymd(eff(t).moveIn), MoveOutDate: t.status === 'Past' ? ymd(t.moveOut) : null,
    ExpectedMoveOutDate: n ? n.expected : (t.status === 'Past' ? ymd(t.moveOut) : null),
    NoticeDate: n ? n.notice : (t.status === 'Past' ? ymd(addDays(t.moveOut, -30)) : null),
    IsMoveOutConfirmed: t.status === 'Past',
    Status: t.status === 'Past' ? 'Past' : (n ? 'Notice' : 'Current'),
    RentAmount: t.rent,
  };
});

// ── recurring charges (what is scheduled to post each month) ─────────────────
const RECURRING = [];
{
  let id = 8000;
  for (const t of world.currentTenants) {
    const u = unitOf(t.unitId);
    const p = propOf(t.propertyId);
    const water = [40, 50, 60, 70][Math.min(3, u.bedrooms)];
    const add = (type, amount) => RECURRING.push({
      RecurringChargeID: ++id, TenantID: t.id, UnitID: t.unitId, PropertyID: t.propertyId,
      PropertyName: p.name, UnitName: u.name,
      ChargeTypeID: CHARGE_TYPES[type].id, ChargeType: CHARGE_TYPES[type].desc, Description: CHARGE_TYPES[type].desc,
      Amount: amount, FromDate: ymd(eff(t).leaseStart), ToDate: ymd(eff(t).leaseEnd), Frequency: 'Monthly', IsActive: true,
    });
    add('RENT', t.rent);
    add('WTR', water);
    if (t.id % 4 === 0) add('PET', 35);
    if (t.id % 5 === 0) add('PARK', 50);
  }
}

// ── work orders ──────────────────────────────────────────────────────────────
const STATUSES = [
  { id: 1, name: 'New', closed: false }, { id: 2, name: 'Work In Progress', closed: false },
  { id: 3, name: 'Waiting on Parts', closed: false }, { id: 4, name: 'Scheduled', closed: false },
  { id: 5, name: 'Resolved', closed: true }, { id: 6, name: 'Closed', closed: true },
];
const PRIORITIES = [{ id: 1, name: 'Emergency' }, { id: 2, name: 'High' }, { id: 3, name: 'Medium' }, { id: 4, name: 'Low' }];
const CATEGORIES = [
  { id: 1, name: 'Maintenance' }, { id: 2, name: 'Plumbing' }, { id: 3, name: 'Electrical' },
  { id: 4, name: 'HVAC' }, { id: 5, name: 'Appliance' }, { id: 6, name: 'Pest Control' },
  { id: 7, name: 'Common Area' }, { id: 8, name: 'Locks & Keys' },
];
const sid = n => STATUSES.find(s => s.name === n).id;
const pid = n => PRIORITIES.find(p => p.name === n).id;
const cid = n => CATEGORIES.find(c => c.name === n).id;

// [title, description, category, priority]
const ISSUE_TEMPLATES = [
  ['Kitchen faucet leaking', 'Kitchen faucet drips constantly and water pools under the sink cabinet.', 'Plumbing', 'Medium'],
  ['No heat in bedroom', 'Baseboard heat in the bedroom is cold, living room is fine.', 'HVAC', 'High'],
  ['Toilet running constantly', 'Toilet keeps running after flushing, jiggling the handle does not help.', 'Plumbing', 'Medium'],
  ['Dishwasher not draining', 'Standing water left at the bottom after every cycle.', 'Appliance', 'Medium'],
  ['Refrigerator not cooling', 'Fridge is warm and the freezer is starting to thaw.', 'Appliance', 'High'],
  ['Smoke detector chirping', 'Hallway smoke detector chirps every minute, likely needs a battery.', 'Maintenance', 'High'],
  ['Garbage disposal jammed', 'Disposal hums but does not spin.', 'Appliance', 'Low'],
  ['Bathroom exhaust fan very loud', 'Fan rattles and is much louder than it used to be.', 'Electrical', 'Low'],
  ['Front door lock sticking', 'Key is hard to turn and the deadbolt sometimes does not retract.', 'Locks & Keys', 'High'],
  ['Ceiling stain after rain', 'Brown stain spreading on the living room ceiling after last night\'s storm.', 'Maintenance', 'High'],
  ['AC not cooling', 'Air conditioner runs but blows warm air.', 'HVAC', 'High'],
  ['Clogged bathroom sink', 'Sink drains very slowly, water backs up when brushing teeth.', 'Plumbing', 'Medium'],
  ['Outlet not working in living room', 'Two outlets on the north wall have no power.', 'Electrical', 'Medium'],
  ['Oven will not heat', 'Oven turns on but never gets above warm.', 'Appliance', 'Medium'],
  ['Window will not latch', 'Bedroom window latch is broken, window does not lock.', 'Maintenance', 'Medium'],
  ['Mice in kitchen', 'Droppings found behind the stove, heard noises at night.', 'Pest Control', 'Medium'],
  ['Parking lot light out', 'Light pole by building entrance has been dark for several nights.', 'Common Area', 'Medium'],
  ['Hallway carpet torn', 'Corner of the hallway carpet is lifting, tripping hazard.', 'Common Area', 'Low'],
  ['Water heater leaking', 'Water around the base of the water heater closet.', 'Plumbing', 'Emergency'],
  ['Buzzer / intercom not working', 'Visitors cannot reach the unit from the front door panel.', 'Electrical', 'Low'],
  ['Mailbox lock broken', 'Mailbox door will not lock.', 'Locks & Keys', 'Low'],
  ['Laundry room washer out of order', 'Shared washer takes coins and does nothing.', 'Appliance', 'Medium'],
  ['Shower head dripping', 'Shower drips after turning off, low water pressure.', 'Plumbing', 'Low'],
  ['Closet door off track', 'Sliding closet door came off the track.', 'Maintenance', 'Low'],
  ['Peeling paint in bathroom', 'Paint peeling near the shower, possible moisture.', 'Maintenance', 'Low'],
  ['Roaches in kitchen', 'Seeing roaches at night under the sink.', 'Pest Control', 'Medium'],
  ['Slow drain in basement laundry', 'Floor drain by the dryers backs up when machines run.', 'Plumbing', 'High'],
  ['Thermostat blank', 'Thermostat display is blank, heat will not turn on.', 'HVAC', 'High'],
  ['Balcony railing loose', 'Railing wobbles when leaned on.', 'Maintenance', 'High'],
  ['Stove burner will not light', 'Front left burner clicks but does not ignite.', 'Appliance', 'Medium'],
  ['Light fixture flickering', 'Kitchen overhead light flickers on and off.', 'Electrical', 'Low'],
  ['Trash chute door stuck', 'Third floor trash chute door does not close fully.', 'Common Area', 'Low'],
  ['Key fob not working', 'Building entry fob stopped working, needs to be reprogrammed.', 'Locks & Keys', 'Medium'],
  ['Heat vent blowing dust', 'Vents blow dusty air when heat turns on.', 'HVAC', 'Low'],
  ['Bathroom tub caulk failing', 'Caulk around tub is cracked and water gets behind it.', 'Maintenance', 'Low'],
  ['Dryer vent blocked', 'Dryer takes several cycles to dry, vent looks packed with lint.', 'Appliance', 'Medium'],
  ['Hot water runs out quickly', 'Hot water only lasts a few minutes in the shower.', 'Plumbing', 'Medium'],
  ['Entry door sweep missing', 'Gap under front door lets cold air and bugs in.', 'Maintenance', 'Low'],
  ['Sidewalk ice melt needed', 'Walkway by the east entrance is icy.', 'Common Area', 'High'],
  ['Garage door opener remote dead', 'Remote does not open the garage gate.', 'Locks & Keys', 'Low'],
  ['Leak under bathroom sink', 'Supply line dripping into the cabinet.', 'Plumbing', 'High'],
];

// [status, openedDaysAgo, closedDaysAgo|null]
const ISSUE_PLAN = [
  // opened this week, still open
  ['New', 0], ['New', 0], ['New', 1], ['New', 1], ['New', 2], ['New', 3], ['New', 5],
  ['Work In Progress', 1], ['Work In Progress', 2], ['Work In Progress', 4], ['Work In Progress', 6],
  ['Scheduled', 3], ['Scheduled', 5],
  // older, still open (aged)
  ['Work In Progress', 9], ['Work In Progress', 14], ['Waiting on Parts', 12], ['Waiting on Parts', 26],
  ['Scheduled', 16], ['New', 11], ['Waiting on Parts', 41], ['Work In Progress', 58], ['New', 74],
  // closed within the last week
  ['Resolved', 1, 0], ['Resolved', 2, 0], ['Resolved', 3, 1], ['Resolved', 4, 2], ['Resolved', 5, 3], ['Resolved', 6, 5],
  ['Closed', 5, 4],
  // closed earlier
  ['Resolved', 10, 8], ['Resolved', 14, 11], ['Resolved', 19, 15], ['Resolved', 25, 20], ['Resolved', 33, 27],
  ['Closed', 40, 35], ['Closed', 52, 44], ['Resolved', 47, 41], ['Closed', 63, 58], ['Resolved', 71, 66], ['Closed', 85, 78],
];

const ISSUES = ISSUE_PLAN.map(([status, openedAgo, closedAgo], i) => {
  const tpl = ISSUE_TEMPLATES[(i * 7 + 3) % ISSUE_TEMPLATES.length];
  const prop = world.PROPERTIES[(i * 3 + Math.floor(i / 5)) % world.PROPERTIES.length];
  const common = /Common Area|Parking|Hallway|Laundry|Sidewalk|Trash|Mailbox|Garage|Buzzer|Key fob/i.test(tpl[0]);
  const propUnits = world.UNITS.filter(u => u.propertyId === prop.id);
  const unit = common ? null : propUnits[(i * 5 + 1) % propUnits.length];
  const superId = PROPERTY_SUPER[prop.id] || [2, 3, 5, 6][i % 4];
  const unassigned = status === 'New' && openedAgo <= 1;
  const opened = addDays(TODAY, -openedAgo);
  const closed = closedAgo != null ? addDays(TODAY, -closedAgo) : null;
  let priority = tpl[3];
  if (status === 'Waiting on Parts' && priority === 'Low') priority = 'Medium';
  return {
    id: 104000 + i * 3 + 11,
    title: tpl[0], description: tpl[1], category: tpl[2], priority, status,
    propertyId: prop.id, propertyName: prop.name, unitId: unit ? unit.id : null, unitName: unit ? unit.name : '',
    assignedTo: unassigned ? 0 : superId,
    opened: ymd(opened), created: ymd(addDays(opened, 0)), closed: closed ? ymd(closed) : null,
  };
});

// ── history notes ────────────────────────────────────────────────────────────
const HISTORY_NOTES = [];
{
  let id = 5000;
  for (const iss of ISSUES) {
    const base = new Date(iss.opened + 'T09:00:00');
    HISTORY_NOTES.push({ HistoryID: ++id, EntityType: 'ServiceManagerIssue', EntityID: iss.id, FileID: null, UserID: 2,
      CreateDate: iss.opened + 'T09:05:00', Note: 'Work order created from tenant portal request.' });
    if (iss.assignedTo) HISTORY_NOTES.push({ HistoryID: ++id, EntityType: 'ServiceManagerIssue', EntityID: iss.id, FileID: null, UserID: 1,
      CreateDate: iss.opened + 'T10:30:00', Note: `Assigned to ${(USERS.find(u => u.id === iss.assignedTo) || {}).name}.` });
    if (iss.status === 'Waiting on Parts') HISTORY_NOTES.push({ HistoryID: ++id, EntityType: 'ServiceManagerIssue', EntityID: iss.id, FileID: null, UserID: iss.assignedTo || 3,
      CreateDate: ymd(addDays(base, 2)) + 'T14:00:00', Note: 'Part ordered, expected in a few days.' });
    if (iss.closed) HISTORY_NOTES.push({ HistoryID: ++id, EntityType: 'ServiceManagerIssue', EntityID: iss.id, FileID: null, UserID: iss.assignedTo || 3,
      CreateDate: iss.closed + 'T16:15:00', Note: 'Repair completed, tenant notified.' });
  }
  for (const t of world.currentTenants.filter(t => t.behindMonths)) {
    HISTORY_NOTES.push({ HistoryID: ++id, EntityType: 'Tenant', EntityID: t.id, FileID: null, UserID: 2,
      CreateDate: ymd(addDays(TODAY, -6)) + 'T11:20:00', Note: `Called about past-due balance; tenant promised payment by the ${10 + (t.id % 15)}th.` });
  }
}

// ── auto-assign bot activity (shadow log, /api/auto-assign/activity) ──────────
function autoAssignActivity() {
  const out = [];
  for (const iss of ISSUES) {
    const s = USERS.find(u => u.id === iss.assignedTo);
    const ts = new Date(iss.opened + 'T12:00:00Z');
    ts.setUTCMinutes(ts.getUTCMinutes() + (iss.id % 90));
    if (TODAY - ts > 14 * 86400000) continue;
    if (s) out.push({ ts: ts.toISOString(), action: 'assigned', dryRun: true, issueId: iss.id, title: iss.title,
      propertyId: iss.propertyId, propertyName: iss.propertyName, superId: s.id, superName: s.name,
      detail: `Would assign to ${s.name} (the super set on ${iss.propertyName}).` });
    else out.push({ ts: ts.toISOString(), action: 'skipped_no_super', dryRun: true, issueId: iss.id, title: iss.title,
      propertyId: iss.propertyId, propertyName: iss.propertyName, detail: 'No super set on this property in Rent Manager - left for a human.' });
  }
  return out.sort((a, b) => a.ts < b.ts ? -1 : 1);
}

module.exports = {
  world, TODAY, TODAY_STR, GRACE_DAYS, USERS, PROPERTY_SUPER, GROUP, UNIT_STATUS_TYPES, CHARGE_TYPES,
  CHARGES, chargesByTenant, tenantBalance, paidOf, openOf, LEASES, RECURRING, STATUSES, PRIORITIES, CATEGORIES,
  ISSUES, HISTORY_NOTES, eff, autoAssignActivity, noticeInfo, NOTICE_TENANT_IDS, display, unitOf, propOf,
  sid, pid, cid,
};
