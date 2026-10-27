// RM-native property -> entity map.
//
// Pulls /Properties straight from Rent Manager and keys the map by the real
// PropertyID, deriving the entity from RM's own BillingName1 field. This map is the
// gate in front of delinquency, collections, cohorts, move activity, unit counts and
// property financials, so every one of them agrees on what an entity is.
//
// The demo portfolio is a single entity, "Demo Portfolio", billed to
// "Demo Portfolio". (The production site carries a dozen entities and a
// property-group whitelist for one of them; none of that applies here, so the
// group / fallback / disk-cache machinery was removed. The exported API is unchanged.)

// Ordered list of management-site entities.
const ENTITY_NAMES = ['Demo Portfolio'];

// Kept for callers that import it: with one entity there is no whitelist to apply.
const GAH_PROPERTY_IDS = new Set();
const GAH_LIST_CONFIRMED = null;
const GAH_GROUP_NAME = '';
const GAH_CACHE_FILE = null;

// Map RM's BillingName1 to a management-site entity name.
function entityFromBilling(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  if (n.includes('demo portfolio')) return 'Demo Portfolio';
  return null;
}

function idOf(p) {
  return p.PropertyID ?? p.PropertyId ?? p.ID ?? p.Id ?? null;
}

// No property-group whitelist in the demo.
async function gahPropertyIds() {
  return { ids: new Set(), source: 'none', added: [], removed: [] };
}
function readLastGoodGroup() { return null; }
function writeLastGoodGroup() { return false; }
function fallbackMembership() { return { ids: new Set(), source: 'none', added: [], removed: [] }; }

// Normalize whatever /Properties returned (array, or {Results:[...]}) to an array.
function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.Results || payload.Items || payload.Data || [];
}

// Build the property->entity map from a live /Properties pull.
// Returns { byId: Map<propertyId, {entity, name, shortName, billingName}>,
//           entities: { [entityName]: [propertyId, ...] }, excluded, totalFromRm }.
// Only properties that resolve to a known entity are included.
async function buildPropertyEntityMap(rentManager) {
  const raw = await rentManager.Properties({
    pageSize: 1000,
    fields: 'PropertyID,Name,BillingName1,ShortName,IsActive',
  });
  const rows = asRows(raw);

  const byId = new Map();
  const entities = {};
  for (const name of ENTITY_NAMES) entities[name] = [];

  // Every property this map turns away, with the reason.
  const excluded = [];

  for (const p of rows) {
    const id = idOf(p);
    const info = {
      propertyId: id,
      name: p.Name || p.ShortName || (id != null ? String(id) : '(no name)'),
      // RM's reports identify a property by ShortName, not by Name or ID.
      shortName: p.ShortName || '',
      billingName: p.BillingName1 || '',
      isActive: p.IsActive,
    };
    if (id == null) { excluded.push({ ...info, reason: 'no-property-id' }); continue; }
    const entity = entityFromBilling(p.BillingName1);
    if (!entity) { excluded.push({ ...info, reason: 'billing-name-unrecognized' }); continue; }
    byId.set(Number(id), {
      entity,
      name: info.name,
      shortName: info.shortName,
      billingName: info.billingName,
    });
    (entities[entity] || (entities[entity] = [])).push(Number(id));
  }

  return { byId, entities, excluded, totalFromRm: rows.length, gah: null };
}

module.exports = {
  ENTITY_NAMES,
  GAH_PROPERTY_IDS,
  GAH_LIST_CONFIRMED,
  GAH_GROUP_NAME,
  GAH_CACHE_FILE,
  gahPropertyIds,
  readLastGoodGroup,
  writeLastGoodGroup,
  fallbackMembership,
  clearGroupCache: () => {},
  __resetGahCache: () => {},
  entityFromBilling,
  buildPropertyEntityMap,
};
