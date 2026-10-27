// ── What can this Rent Manager actually give us? ─────────────────────────────
//
// The owner, 2026-09-10: *"Is there any information in the API that we're just
// leaving out that could maybe relate to this tool? Scan every possible pull the
// API could pull."*
//
// A fair question, and the project has now been caught twice by its own answer to
// it. `/Attachments` is a 404 here and invoices were reachable the whole time,
// riding on the bill as an embed. `/BankAccounts` is a 404 here and the bank
// accounts were sitting in `/GLAccounts` under `GLAccountType: "Bank"`. Both cost
// weeks, and both were the same mistake: assuming that the resource we thought of
// first is the only place the data could be.
//
// So this sweeps every resource name that could plausibly feed the invoice tool,
// records what came back, and — the part that answers the question — marks which
// ones this codebase ALREADY reads. What is left is the list of things the API
// offers and we are not using.
//
// ── what leaves this module ─────────────────────────────────────────────────
// Resource names, HTTP status, and FIELD NAMES. Never a field VALUE. Half of
// these resources are tenant-side (`/Tenants`, `/Leases`, `/Contacts`) and this
// site's whole PII posture is that tenant records stay server-side until somebody
// asks for one by name. A schema dump is safe; a row is not, and the difference
// is one careless line of code, so it is enforced in one place — `fieldsOf()` —
// rather than trusted at each call site.

const rentManager = require('./rentManagerClient');

const PACE_MS = Number(process.env.RM_INVENTORY_PACE_MS || 120);
const TTL_MS = 30 * 60 * 1000;

// Grouped by what the resource would be FOR, because "is /PurchaseOrders here?"
// is not a useful question on its own — "is there anything between the vendor's
// quote and the bill that we could be showing" is.
const GROUPS = [
  {
    group: 'The bill behind a charge',
    why: 'What the Renovations tab opens when somebody asks what the money bought.',
    names: ['Bills', 'BillDetails', 'BillAllocations', 'RecurringBills', 'Invoices',
      'VendorInvoices', 'PurchaseOrders', 'PurchaseOrderDetails', 'Quotes', 'Estimates'],
  },
  {
    group: 'The document itself',
    why: 'The scan. /Attachments 404s here and bills carry their own — that is the trap this group exists to re-check after every permission change.',
    names: ['Attachments', 'BillAttachments', 'Files', 'FileAttachments', 'Documents',
      'Images', 'ImageFiles', 'Media', 'Scans', 'Uploads', 'HistoryNotes', 'History', 'Notes'],
  },
  {
    group: 'The money that left',
    why: 'Who paid it, from which account, and whether the bank agreed.',
    names: ['Checks', 'CheckDetails', 'Payments', 'PaymentDetails', 'PaymentTypes',
      'CreditCards', 'CreditCardTransactions', 'BankAccounts', 'Banks', 'BankTransactions',
      'BankReconciliations', 'Reconciliations', 'ReconciliationItems', 'Deposits',
      'BankDeposits', 'ElectronicPayments', 'EFTs'],
  },
  {
    group: 'The ledger it posted to',
    why: 'Where the bank accounts turned out to live, and the postings the tab is built on.',
    names: ['GLAccounts', 'GLAccountTypes', 'GLTransactions', 'GLDetails',
      'JournalEntries', 'JournalEntryDetails', 'AccountGroups', 'Accounts'],
  },
  {
    group: 'Who was paid',
    why: 'Naming a vendor, and anything filed against them.',
    names: ['Vendors', 'VendorCategories', 'VendorContacts', 'Contacts', 'Payees', 'Owners',
      'OwnerDistributions'],
  },
  {
    group: 'The work behind the charge',
    why: 'A work order or an inspection is backup a bill is not — it says what was actually done.',
    names: ['ServiceManagerIssues', 'ServiceManagerIssueCategories', 'WorkOrders',
      'Inspections', 'InspectionItems', 'Tasks', 'Projects'],
  },
  {
    group: 'Where it happened',
    why: 'Property, unit and entity — how a charge is attributed.',
    names: ['Properties', 'Units', 'PropertyGroups', 'PropertyGroupProperties', 'Locations',
      'UserDefinedFields', 'CustomFields'],
  },
];

// Every resource this codebase requests anywhere — a feature, a probe, a
// capability sweep. "Used" is deliberately that broad: the report's job is to
// surface what nothing in the code has ever reached for, and a resource we
// already ask about is not a missed opportunity even when the asking is a probe.
//
// It is not maintained from memory. `npm run check:rm-inventory` greps the source
// for every Rent Manager path and fails if one is missing here — otherwise the
// "we are not using this" column quietly starts lying, which is the only thing
// this report is really for. (Paths built dynamically, `/${name}`, cannot be seen
// by a static grep; a name here that the grep does not find is reported as a
// note, not a failure.)
const USED = new Set([
  'ApiDocs', 'Attachments', 'BankAccounts', 'BankReconciliations', 'BankTransactions',
  'Banks', 'BillAttachments', 'BillDetails', 'Bills', 'Charges', 'CheckDetails', 'Checks',
  'CreditCardTransactions', 'CreditCards', 'Deposits', 'Documents', 'FileAttachments',
  'Files', 'GLAccounts', 'GLTransactions', 'Help', 'History', 'HistoryNotes', 'Images',
  'Leases', 'Metadata', 'PaymentDetails', 'Payments', 'Properties', 'PropertyGroups',
  'PurchaseOrders', 'Reconciliations',
  'RecurringCharges', 'Reports', 'Resources', 'ServiceManagerCategories',
  'ServiceManagerIssues', 'ServiceManagerPriorities', 'ServiceManagerStatuses',
  'Tenants', 'UnitStatusTypes', 'Units', 'Users', 'Vendors',
]);

// Some resources refuse a bare list and demand a filter. That is not evidence of
// absence — it is the mistake that once turned off the entire invoice path, and
// this sweep walked straight into it on its first live run: `/CheckDetails`
// answers `500` to an unfiltered list and answers perfectly when filtered by
// `BillDetailID`, and it is the backbone of the whole payment side. Reporting it
// as missing would have been the most misleading line in the report.
//
// So two things. Where a sensible filter is known, it is the second attempt.
// And a refusal is classified by WHAT KIND it is rather than lumped into "no":
// 404 is absent, 401/403 is a permission somebody can grant, and 400/500 on a
// list is a resource that is present and simply will not be paged blind.
const FILTERED_ATTEMPT = {
  CheckDetails: { filters: 'BillDetailID,eq,1', pageSize: 1 },
  BillDetails: { filters: 'BillID,eq,1', pageSize: 1 },
  PurchaseOrderDetails: { filters: 'PurchaseOrderID,eq,1', pageSize: 1 },
  JournalEntryDetails: { filters: 'JournalEntryID,eq,1', pageSize: 1 },
  InspectionItems: { filters: 'InspectionID,eq,1', pageSize: 1 },
};
const NEEDS_FILTER = new Set([400, 500]);

function statusOf(err) {
  const m = /\((\d{3})\)/.exec(String((err && err.message) || ''));
  return m ? Number(m[1]) : null;
}
function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.Results || payload.Items || payload.Data || [];
}

// The one place a row is ever touched, and it only ever reads Object.keys. No
// caller gets a row, so no caller can leak one.
function fieldsOf(rows) {
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  return row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row).sort() : [];
}

async function probe(name) {
  const attempts = [{ pageSize: 1 }];
  if (FILTERED_ATTEMPT[name]) attempts.push(FILTERED_ATTEMPT[name]);
  let last = null, filtered = false;
  for (const params of attempts) {
    try {
      const rows = asRows(await rentManager.get(`/${name}`, params));
      return {
        name, available: true, rows: rows.length, fields: fieldsOf(rows), used: USED.has(name),
        // "It answered, but only when told what to look for." A caller has to
        // know that before treating it as a browsable list.
        needsFilter: filtered || undefined,
      };
    } catch (err) { last = err; filtered = true; }
  }
  const status = statusOf(last);
  return {
    name, available: false, status, used: USED.has(name),
    // Present, but it will not be paged blind. Not the same as not being there,
    // and the difference decides whether anybody goes looking further.
    needsFilter: NEEDS_FILTER.has(status) || undefined,
  };
}

let _cache = null;

async function sweep({ force = false } = {}) {
  if (_cache && !force && Date.now() - _cache.at < TTL_MS) return _cache.payload;

  // Sequential. Rent Manager caps concurrent sessions and rate-limits by the
  // hour; this is a once-in-a-while question, not something a page waits on.
  const groups = [];
  for (const g of GROUPS) {
    const resources = [];
    for (const name of g.names) {
      resources.push(await probe(name));
      if (PACE_MS) await new Promise(r => setTimeout(r, PACE_MS));
    }
    groups.push({ ...g, names: undefined, resources });
  }

  const all = groups.flatMap(g => g.resources);
  const payload = {
    sweptAt: new Date().toISOString(),
    counts: {
      probed: all.length,
      available: all.filter(r => r.available).length,
      // The answer to the question this exists for.
      availableAndUnused: all.filter(r => r.available && !r.used).length,
      forbidden: all.filter(r => !r.available && (r.status === 401 || r.status === 403)).length,
      needsFilter: all.filter(r => r.needsFilter).length,
      absent: all.filter(r => !r.available && r.status === 404).length,
    },
    // Reachable, and nothing in this codebase reads it.
    unused: all.filter(r => r.available && !r.used).map(r => ({ name: r.name, fields: r.fields })),
    // Present but refused — a permission somebody could grant, not a dead end.
    forbidden: all.filter(r => !r.available && (r.status === 401 || r.status === 403)).map(r => r.name),
    // There, but not browsable: it wants a filter. /CheckDetails is the whole
    // payment side and lives in here — reading this list as "missing" is the
    // single most expensive way to misread this report.
    needsFilter: all.filter(r => r.needsFilter).map(r => ({ name: r.name, status: r.status || null })),
    groups,
    note: 'Resource names, HTTP status and FIELD NAMES only. No field values are read or returned.',
  };
  _cache = { at: Date.now(), payload };
  return payload;
}

module.exports = { sweep, GROUPS, USED };
