// Rent Manager emulation: tenants, leases, recurring charges, charge transactions.
const m = require('../rmModel');
const { collection } = require('../rmQuery');

function register(router, world) {
  const tenantRows = () => world.TENANTS.map(t => {
    const u = world.unitById.get(t.unitId);
    const [first, ...rest] = t.name.split(' ');
    return {
      TenantID: t.id, Name: t.name, FirstName: first, LastName: rest.join(' '),
      AccountNumber: m.display(t), Status: t.status === 'Past' ? 'Past' : 'Current',
      Email: t.email, Phone: t.phone, PhoneNumber: t.phone,
      PropertyID: t.propertyId, UnitID: t.unitId, MoveInDate: world.util.ymd(m.eff(t).moveIn),
      MoveOutDate: t.status === 'Past' ? world.util.ymd(t.moveOut) : null,
      CurrentBalance: m.tenantBalance(t.id),
    };
  });
  const embedTenant = (r, e) => {
    const out = { ...r };
    if (e.has('Balance')) {
      const b = m.tenantBalance(r.TenantID);
      out.Balance = { Balance: b, CurrentBalance: b };
    }
    if (e.has('Property')) { const p = world.propertyById.get(r.PropertyID); out.Property = { PropertyID: p.id, Name: p.name, ShortName: p.name }; }
    if (e.has('Leases')) out.Leases = m.LEASES.filter(l => l.TenantID === r.TenantID);
    return out;
  };
  router.get('/Tenants', ({ query }) => collection(tenantRows(), query, { embed: embedTenant }));
  router.get(/^\/Tenants\/(\d+)$/i, ({ query, match }) =>
    collection(tenantRows().filter(t => t.TenantID === Number(match[1])), query, { embed: embedTenant }));

  router.get('/Leases', ({ query }) => collection(m.LEASES, query));
  router.get(/^\/Leases\/(\d+)$/i, ({ query, match }) =>
    collection(m.LEASES.filter(l => l.LeaseID === Number(match[1])), query));

  router.get('/RecurringCharges', ({ query }) => collection(m.RECURRING, query));

  // Individual charge transactions. The per-tenant link is AccountID (AccountType "Customer").
  const chargeRows = () => m.CHARGES.map(c => {
    const t = world.tenantById.get(c.tenantId);
    const ct = m.CHARGE_TYPES[c.type];
    return {
      ChargeID: c.id, AccountID: c.tenantId, AccountType: 'Customer', TenantID: c.tenantId,
      PropertyID: c.propertyId, UnitID: c.unitId, ChargeTypeID: ct.id, ChargeType: ct.code,
      Description: ct.desc, Amount: c.amount, Balance: m.openOf(c),
      TransactionDate: `${c.date}T00:00:00`, CreateDate: `${c.createDate}T00:00:00`,
      DueDate: `${c.date}T00:00:00`, IsPaid: m.openOf(c) <= 0,
    };
  });
  router.get('/Charges', ({ query }) => collection(chargeRows(), query));
}
module.exports = { register };
