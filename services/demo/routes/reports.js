// Rent Manager emulation: report 85 (Delinquency) and report 30 (ChargeDetail).
const m = require('../rmModel');
const { reportParams } = require('../rmQuery');

const money = n => (n < 0 ? `(${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
  : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const ymd = d => d.toISOString().slice(0, 10);
const shift = (s, days) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return ymd(d); };
const idSet = s => new Set(String(s || '').split(',').map(x => Number(x)).filter(Boolean));

function register(router, world) {
  // ── 85: Delinquency (IsSummary=True: one Grid1 row per tenant, Grid2 = RM's own summary) ──
  router.get(/^\/Reports\/85\/RunReport$/i, ({ query }) => {
    const p = reportParams(query);
    const asOf = (p.AsOfDate || m.TODAY_STR).slice(0, 10);
    const grace = Number(p.DelinquentDaysToInclude) || 0;
    const cutoff = shift(asOf, -grace);
    const props = idSet(p.PropertyIDs);
    const status = String(p.CustomersToInclude || 'Current');
    const rows = [];
    for (const t of world.TENANTS) {
      if (props.size && !props.has(t.propertyId)) continue;
      if (status === 'Current' && t.status !== 'Current') continue;
      let total = 0, buckets = [0, 0, 0, 0];
      for (const c of m.chargesByTenant.get(t.id) || []) {
        if (c.date > cutoff) continue;                       // not yet old enough to count
        const open = m.openOf(c);
        if (open <= 0) continue;
        total += open;
        const age = Math.round((Date.parse(asOf) - Date.parse(c.date)) / 86400000);
        buckets[age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3] += open;
      }
      total = Math.round(total * 100) / 100;
      if (total <= 0) continue;
      const u = world.unitById.get(t.unitId), pr = world.propertyById.get(t.propertyId);
      const [first, ...rest] = t.name.split(' ');
      rows.push({
        EntitiesEntityID: pr.id, EntitiesName: pr.name, SubEntitiesName: u.name,
        AccountsAccountID: t.id, AccountsName: t.name, AccountsFirstName: first, AccountsLastName: rest.join(' '),
        CustomersCustomerDisplayID: m.display(t),
        ChargesAmount: money(total),
        Aging0To30: money(Math.round(buckets[0] * 100) / 100), Aging31To60: money(Math.round(buckets[1] * 100) / 100),
        Aging61To90: money(Math.round(buckets[2] * 100) / 100), Aging90Plus: money(Math.round(buckets[3] * 100) / 100),
      });
    }
    const amount = Math.round(rows.reduce((s, r) => s + Number(String(r.ChargesAmount).replace(/,/g, '')), 0) * 100) / 100;
    // Percent delinquent: past-due dollars against the rent billed over the trailing twelve months.
    let billed = 0;
    const since = shift(asOf, -365);
    for (const c of m.CHARGES) if (c.type === 'RENT' && c.tenantStatus === 'Current' && c.date >= since && c.date <= asOf && (!props.size || props.has(c.propertyId))) billed += c.amount;
    const tenantsInScope = world.currentTenants.filter(t => !props.size || props.has(t.propertyId)).length;
    return {
      Grid1: rows,
      Grid2: [
        { ReportSummaryDetail: 'Delinquent Amount:', ReportSummaryValue: money(amount) },
        { ReportSummaryDetail: 'Tenants:', ReportSummaryValue: String(tenantsInScope) },
        { ReportSummaryDetail: 'Percent Delinquent:', ReportSummaryValue: billed ? (amount / billed * 100).toFixed(2) : '0.00' },
      ],
    };
  });

  // ── 30: ChargeDetail (Grid2 = per-charge-type summary, Grid1 = one row per payment allocation) ──
  router.get(/^\/Reports\/30\/RunReport$/i, ({ query }) => {
    const p = reportParams(query);
    const start = String(p.StartDate || '0000-01-01').slice(0, 10), end = String(p.EndDate || '9999-12-31').slice(0, 10);
    const props = idSet(p.PropertyIDs);
    const cs = Number(p.CustomerStatus || 2);
    const wantCurrent = (cs & 2) !== 0, wantFormer = (cs & 1) !== 0;
    const charges = m.CHARGES.filter(c => c.date >= start && c.date <= end
      && (!props.size || props.has(c.propertyId))
      && (c.tenantStatus === 'Current' ? wantCurrent : wantFormer));

    const byType = new Map();
    const grid1 = [];
    for (const c of charges) {
      const ct = m.CHARGE_TYPES[c.type];
      const paid = m.paidOf(c);
      const agg = byType.get(c.type) || { code: ct.code, desc: ct.desc, charged: 0, paid: 0 };
      agg.charged += c.amount; agg.paid += paid; byType.set(c.type, agg);

      const t = world.tenantById.get(c.tenantId), pr = world.propertyById.get(c.propertyId);
      const base = {
        EntitiesEntityID: pr.id, EntitiesName: pr.name, SubEntitiesName: c.unitName,
        AccountsAccountID: t.id, AccountsName: t.name, ChargeTypesDescription: ct.desc,
        ChargesChargeID: c.id, ChargesTransactionDate: `${c.date}T00:00:00`,
      };
      if (!c.paid.length) {
        grid1.push({ ...base, ChargeTypesName: ct.code, ChargesAmount: money(c.amount), PaymentsTransactionDate: null, AllocationsAmount: null });
      } else {
        c.paid.forEach((pm, i) => grid1.push(i === 0
          ? { ...base, ChargeTypesName: ct.code, ChargesAmount: money(c.amount), PaymentsTransactionDate: `${pm.date}T00:00:00`, AllocationsAmount: money(pm.amount) }
          // continuation rows carry the charge only in the *Clone fields
          : { ...base, ChargeTypesName: '', ChargeTypesNameClone: ct.code, ChargesAmount: '', ChargesAmountClone: money(c.amount),
              PaymentsTransactionDate: `${pm.date}T00:00:00`, AllocationsAmount: money(pm.amount) }));
      }
    }
    const grid2 = [...byType.values()].map(a => ({
      ReportSummaryChargeType: a.code, ReportSummaryDescription: a.desc,
      ReportSummaryAmountCharged: money(Math.round(a.charged * 100) / 100),
      ReportSummaryAmountPaid: money(Math.round(a.paid * 100) / 100),
      ReportSummaryBalance: money(Math.round((a.charged - a.paid) * 100) / 100),
    }));
    return { Grid1: grid1, Grid2: grid2 };
  });
}
module.exports = { register };
