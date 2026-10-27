// Who is the super for this property?
//
// The auto-assign bot (the rm-auto-assign Worker) already answers this question
// every time it routes a ticket — it reads the super off the property record in
// Rent Manager and writes the assignment back. What it never did was tell the
// dashboard, so the site had no way to show "this ticket goes to Luis Real"
// before the bot acts, and no way to show which buildings are still uncovered.
//
// This resolves the same map the bot uses, from two sources:
//
//   1. Rent Manager's /Properties records. RM wins wherever it has a super,
//      because RM is what the bot actually reads. A panel that showed a
//      different name than the one the bot is about to assign would be worse
//      than no panel.
//
//   2. config/property-supers.json — a hand-maintained file that fills the gaps
//      RM hasn't been backfilled for yet (Willow Creek already has none). It
//      never overrides a super that exists in RM, so it can't go stale against
//      a change someone makes there.
//
// Coverage is the point of the output, not a side effect. A property with no
// super resolves to null and is reported as uncovered — that's the ticket a
// human still has to route by hand, and it's the number that shows whether the
// bot is worth turning loose.

const fs = require('fs');
const path = require('path');
const { buildPropertyEntityMap, ENTITY_NAMES } = require('./entityMap');
const serviceManagerLookups = require('./serviceManagerLookups');

// Not data/: on the host that folder is the persistent disk, mounted over the repo's
// copy, so a file committed there never reaches the live site.
const OVERRIDES_FILE = path.join(__dirname, '..', 'config', 'property-supers.json');

// The field RM itself routes on.
//
// A Property row carries ServiceManagerAssignedUserID: the user every Service
// Manager ticket at that property is assigned to. That is not a guess about who
// the super is — it is the setting RM reads when it assigns, so a panel built on
// it shows the same name the ticket is actually going to get. /Users turns the
// id into a name (see services/serviceManagerLookups.js).
//
// IsOverrideAssignedUserID is RM's flag for "this property overrides the default";
// we don't branch on it, because either way the id present on the row is the one
// that wins for tickets at that property.
const SERVICE_MANAGER_USER_FIELDS = ['ServiceManagerAssignedUserID', 'ServiceManagerAssignedUserId'];

// Fallbacks, tried only when the routing field above is unset. Different accounts
// keep a super in the property's manager slot, a user-defined field, or an
// embedded contact. ManagerName in particular is a real person on this account,
// but it's the property MANAGER, not the maintenance super — it routes worse than
// the field above, so it sits below it.
// scripts/probeSuperFields.js prints which of these your account actually uses.
const SUPER_NAME_FIELDS = [
  'SuperName', 'Super', 'SuperintendentName', 'Superintendent',
  'ManagerName', 'Manager', 'PropertyManagerName', 'PropertyManager',
  'MaintenanceContact', 'MaintenanceContactName', 'MaintenanceTech',
  'DefaultAssignee', 'DefaultAssigneeName', 'AssignedUserName',
];
const SUPER_ID_FIELDS = [
  'SuperID', 'SuperId', 'SuperintendentID', 'SuperintendentId',
  'ManagerID', 'ManagerId', 'PropertyManagerID', 'PropertyManagerId',
  'MaintenanceContactID', 'MaintenanceContactId',
  'DefaultAssigneeID', 'DefaultAssigneeId', 'AssignedUserID', 'AssignedUserId',
];
// User-defined field names to check inside a UserDefinedValues collection.
const SUPER_UDF_NAMES = ['super', 'superintendent', 'building super', 'maintenance', 'maintenance tech'];

function firstText(row, keys) {
  if (!row || typeof row !== 'object') return '';
  for (const key of keys) {
    const value = row[key];
    if (value == null) continue;
    // RM sometimes hands back the contact as an object rather than a string.
    if (typeof value === 'object') {
      const nested = value.Name || value.FullName || value.DisplayName
        || [value.FirstName, value.LastName].filter(Boolean).join(' ');
      if (nested && String(nested).trim()) return String(nested).trim();
      continue;
    }
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function firstId(row, keys) {
  if (!row || typeof row !== 'object') return null;
  for (const key of keys) {
    const value = row[key];
    if (value == null) continue;
    if (typeof value === 'object') {
      const nested = value.UserID ?? value.UserId ?? value.ContactID ?? value.ContactId ?? value.ID ?? value.Id;
      if (nested != null && Number(nested)) return Number(nested);
      continue;
    }
    if (Number(value)) return Number(value);
  }
  return null;
}

// Pull a super out of a UserDefinedValues collection, which is where RM puts it
// when the account tracks supers as a custom field rather than a manager slot.
function superFromUserDefined(row) {
  const udfs = row && (row.UserDefinedValues || row.userDefinedValues || row.UserDefinedFields);
  if (!Array.isArray(udfs)) return '';
  for (const udf of udfs) {
    const name = String(udf?.Name || udf?.FieldName || udf?.UserDefinedFieldName || '').trim().toLowerCase();
    if (!SUPER_UDF_NAMES.includes(name)) continue;
    const value = String(udf?.Value ?? udf?.value ?? '').trim();
    if (value) return value;
  }
  return '';
}

function readOverrides() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // no override file is a normal state, not an error
  }
}

// Override keys are matched on a squashed property name so "15 Summit Avenue
// (273 Sherman)" in RM still finds "78 congress st (273 sherman)" in the file.
function nameKey(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.Results || payload.Items || payload.Data || [];
}

// Ask RM for properties with enough embedded to find a super. The embeds are
// requested optimistically — if the account doesn't expose one, RM ignores it
// rather than failing, and we fall back to a plain pull.
async function loadPropertyRows(rentManager) {
  const withEmbeds = { pageSize: 1000, embeds: 'UserDefinedValues,Manager,MaintenanceContact' };
  try {
    const rows = asRows(await rentManager.Properties(withEmbeds));
    if (rows.length) return rows;
  } catch {
    // embeds rejected by this account — retry without them
  }
  return asRows(await rentManager.Properties({ pageSize: 1000 }));
}

// Resolve the property → super map.
//
// Returns { properties: [...], entities: {...}, coverage: {...}, sources: {...} }.
// Never throws: an RM outage degrades this to overrides-only, which still
// renders a useful tab, rather than blanking the panel.
async function resolvePropertySupers(rentManager) {
  const overrides = readOverrides();
  const overrideByName = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith('_')) continue; // '_comment' style keys are documentation
    overrideByName.set(nameKey(key), value);
  }

  let rows = [];
  let entityMap = null;
  let lookups = serviceManagerLookups.EMPTY;
  let rmError = null;
  if (rentManager && rentManager.isConfigured && rentManager.isConfigured()) {
    try {
      [rows, entityMap, lookups] = await Promise.all([
        loadPropertyRows(rentManager),
        buildPropertyEntityMap(rentManager).catch(() => null),
        serviceManagerLookups.getLookups(rentManager),
      ]);
    } catch (err) {
      rmError = err && err.message ? err.message : String(err);
    }
  } else {
    rmError = 'Rent Manager is not configured on this server';
  }

  const properties = [];
  let fromRm = 0;
  let fromOverride = 0;

  for (const row of rows) {
    const propertyId = row.PropertyID ?? row.PropertyId ?? row.ID ?? row.Id ?? null;
    const name = row.Name || row.ShortName || (propertyId != null ? String(propertyId) : '');
    if (!name) continue;

    const routingUserId = firstId(row, SERVICE_MANAGER_USER_FIELDS);
    const rmSuper = (routingUserId ? lookups.users.get(routingUserId) : '')
      || firstText(row, SUPER_NAME_FIELDS)
      || superFromUserDefined(row);
    const override = overrideByName.get(nameKey(name));
    const overrideSuper = typeof override === 'string' ? override : (override && override.super) || '';

    let superName = '';
    let source = 'none';
    if (rmSuper) {
      superName = rmSuper;
      source = 'rent-manager';
      fromRm += 1;
    } else if (overrideSuper) {
      superName = overrideSuper;
      source = 'override';
      fromOverride += 1;
    }

    const mapped = entityMap && propertyId != null ? entityMap.byId.get(Number(propertyId)) : null;
    properties.push({
      propertyId: propertyId != null ? Number(propertyId) : null,
      property: name,
      entity: mapped ? mapped.entity : (row.BillingName1 ? null : null),
      superName: superName || null,
      // Name fields are scanned for an id too: when RM returns the super as an
      // embedded contact object, the id is nested inside it rather than sitting
      // in a sibling *ID column. Plain name strings fail Number() and are skipped.
      superId: routingUserId || firstId(row, [...SUPER_ID_FIELDS, ...SUPER_NAME_FIELDS]),
      source,
      // RM keeps records for vendors, renovation arms and roll-up buckets in the
      // same Properties table as real buildings. They have no super because they
      // never receive a ticket — counting them as "uncovered" would inflate the
      // gap with rows nobody is ever going to fill in.
      active: row.IsActive !== false,
    });
  }

  // Overrides for properties RM didn't return (or that RM couldn't be reached
  // for) still belong in the map — they're the whole reason the file exists.
  const seen = new Set(properties.map(p => nameKey(p.property)));
  for (const [key, value] of overrideByName) {
    if (seen.has(key)) continue;
    const superName = typeof value === 'string' ? value : (value && value.super) || '';
    const entity = typeof value === 'object' && value ? value.entity || null : null;
    properties.push({
      propertyId: null,
      property: typeof value === 'object' && value && value.name ? value.name : key,
      entity,
      superName: superName || null,
      superId: null,
      source: superName ? 'override' : 'none',
      active: true,
    });
    if (superName) fromOverride += 1;
  }

  // Roll up to entities, which is the altitude the Issues tab reports at.
  const entities = {};
  for (const entity of ENTITY_NAMES) {
    entities[entity] = { entity, properties: 0, covered: 0, supers: [], uncovered: [] };
  }
  for (const prop of properties) {
    const key = prop.entity;
    if (!key || !prop.active) continue;
    const bucket = entities[key] || (entities[key] = { entity: key, properties: 0, covered: 0, supers: [], uncovered: [] });
    bucket.properties += 1;
    if (prop.superName) {
      bucket.covered += 1;
      if (!bucket.supers.includes(prop.superName)) bucket.supers.push(prop.superName);
    } else {
      bucket.uncovered.push(prop.property);
    }
  }

  // Coverage counts only active properties that belong to an entity — i.e. the
  // buildings a ticket can actually be raised at.
  const routable = properties.filter(p => p.active && p.entity);
  const covered = routable.filter(p => p.superName).length;
  return {
    properties: properties.sort((a, b) => a.property.localeCompare(b.property)),
    entities,
    coverage: {
      properties: routable.length,
      covered,
      uncovered: routable.length - covered,
      pct: routable.length ? Math.round((covered / routable.length) * 100) : 0,
    },
    sources: {
      rentManager: rmError ? { ok: false, error: rmError, resolved: 0 } : { ok: true, resolved: fromRm },
      overrides: { resolved: fromOverride, file: 'config/property-supers.json' },
    },
  };
}

module.exports = {
  OVERRIDES_FILE,
  SUPER_NAME_FIELDS,
  SUPER_ID_FIELDS,
  SUPER_UDF_NAMES,
  resolvePropertySupers,
};
