// Rent Manager emulation: properties, property groups, units, unit statuses, users.
const m = require('../rmModel');
const { collection } = require('../rmQuery');

function register(router, world) {
  const propRow = p => ({
    PropertyID: p.id, Name: p.name, ShortName: p.name, BillingName1: p.billingName, IsActive: true,
    Address1: p.street, Street: p.street, City: p.city, State: p.state, PostalCode: p.zip,
    YearBuilt: p.built, UnitCount: p.units,
    ServiceManagerAssignedUserID: m.PROPERTY_SUPER[p.id] || 0,
    IsOverrideAssignedUserID: Boolean(m.PROPERTY_SUPER[p.id]),
  });
  const properties = () => world.PROPERTIES.map(propRow);
  const groupRef = { PropertyGroupID: m.GROUP.id, Name: m.GROUP.name };
  const embedProperty = (r, e) => (e.has('PropertyGroups') || e.has('PropertyGroup')) ? { ...r, PropertyGroups: [groupRef] } : r;

  router.get('/Properties', ({ query }) => collection(properties(), query, { embed: embedProperty }));
  router.get(/^\/Properties\/(\d+)$/i, ({ query, match }) =>
    collection(properties().filter(p => p.PropertyID === Number(match[1])), query, { embed: embedProperty }));

  const groupRows = () => [{ PropertyGroupID: m.GROUP.id, Name: m.GROUP.name }];
  const embedGroup = (r, e) => e.has('Properties') ? { ...r, Properties: properties().map(p => ({ PropertyID: p.PropertyID, Name: p.Name, ShortName: p.ShortName })) } : r;
  router.get('/PropertyGroups', ({ query }) => collection(groupRows(), query, { embed: embedGroup }));
  router.get(/^\/PropertyGroups\/(\d+)$/i, ({ query, match }) =>
    collection(groupRows().filter(g => g.PropertyGroupID === Number(match[1])), query, { embed: embedGroup }));

  // ── units ──
  const vacantOrder = [...world.vacantUnitIds];
  const vacantStatus = [3, 4, 3, 5, 3, 4];
  const tenantOfUnit = new Map(world.currentTenants.map(t => [t.unitId, t]));
  const unitStatusId = u => {
    if (world.vacantUnitIds.has(u.id)) return vacantStatus[vacantOrder.indexOf(u.id) % vacantStatus.length];
    const t = tenantOfUnit.get(u.id);
    return t && m.NOTICE_TENANT_IDS.has(t.id) ? 2 : 1;
  };
  const unitRows = () => world.UNITS.map(u => ({
    UnitID: u.id, PropertyID: u.propertyId, Name: u.name, IsActive: true,
    Bedrooms: u.bedrooms, SquareFeet: u.sqft, MarketRent: u.marketRent, UnitType: u.type,
    TenantID: world.vacantUnitIds.has(u.id) ? null : u.tenantId,
  }));
  const embedUnit = (r, e) => {
    const out = { ...r };
    const st = m.UNIT_STATUS_TYPES.find(s => s.id === unitStatusId({ id: r.UnitID }));
    if (e.has('CurrentUnitStatus')) out.CurrentUnitStatus = { UnitStatusTypeID: st.id, Name: st.name };
    if (e.has('CurrentOccupancyStatus')) {
      out.CurrentOccupancyStatus = r.TenantID
        ? { OccupancyType: 'CurrentOccupant', TenantID: r.TenantID }
        : { OccupancyType: 'PastOccupant' };
    }
    if (e.has('Property')) { const p = world.propertyById.get(r.PropertyID); out.Property = { PropertyID: p.id, Name: p.name, ShortName: p.name }; }
    return out;
  };
  router.get('/Units', ({ query }) => collection(unitRows(), query, { embed: embedUnit }));
  router.get(/^\/Units\/(\d+)$/i, ({ query, match }) =>
    collection(unitRows().filter(u => u.UnitID === Number(match[1])), query, { embed: embedUnit }));

  router.get('/UnitStatusTypes', ({ query }) => collection(m.UNIT_STATUS_TYPES.map(s => ({
    UnitStatusTypeID: s.id, Name: s.name, IsVacant: s.isVacant, IsActive: true,
  })), query));

  // ── users ──
  const userRows = () => [{ UserID: 0, Name: '<Unassigned>', Firstname: '', Lastname: '' }].concat(m.USERS.map(u => {
    const [first, ...rest] = u.name.split(' ');
    return { UserID: u.id, Name: u.name, Firstname: first, Lastname: rest.join(' '), Title: u.role,
      Email: `${first}.${rest.join('')}`.toLowerCase() + '@example.com', IsActive: true };
  }));
  router.get('/Users', ({ query }) => collection(userRows(), query));
  router.get(/^\/Users\/(\d+)$/i, ({ query, match }) => collection(userRows().filter(u => u.UserID === Number(match[1])), query));
}
module.exports = { register };
