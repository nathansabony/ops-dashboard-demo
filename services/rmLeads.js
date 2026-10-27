// ── Three open leads, asked of the live API instead of argued about ──────────
//
// Out of the 2026-09-10 inventory sweep, three resources came back reachable that
// nothing here reads. Each one maps to a thing somebody has actually asked for,
// and none of them can be decided from the outside — the same trap this project
// keeps falling into is deciding what an API "probably" does. So each is a
// question with a measurable answer, and this asks all three in one pass.
//
//   A. /PurchaseOrders  — "who approved this spend?" The backup panel shows the
//      charge, the bill and the payment and cannot answer that at all today. The
//      open question is not whether POs exist (they do) but whether one can be
//      LINKED to a bill; an approval we cannot attach to a charge is trivia.
//
//   B. /HistoryNotes    — carries a FileID. Every document resource on this
//      instance is a 404 and invoices only come through the bill embed, which is
//      why 47 of ~190 demoed charges had no scan. A file id hanging off a history
//      note is the first new lead on that in weeks. The question is whether that
//      id leads to BYTES.
//
//   C. /PropertyGroups  — entity membership is derived today by regex over RM's
//      BillingName1 plus a hand-maintained whitelist of 36 property ids
//      (services/entityMap.js), which is due for replacement.
//      The question is whether RM's own groups actually describe the same
//      entities we report on — if they carve the portfolio up differently, using
//      them would silently re-base every entity figure on the site.
//
// ── what leaves this module ─────────────────────────────────────────────────
// Counts, field names, ids, property and group names, HTTP statuses, and for the
// file test a content-type and a byte length. **Never** a note body, a tenant
// name, or file bytes. `/HistoryNotes` is the one resource here that is likely to
// contain tenant text, and it is read for its SHAPE only.

const rentManager = require('./rentManagerClient');

function statusOf(err) {
  const m = /\((\d{3})\)/.exec(String((err && err.message) || ''));
  return m ? Number(m[1]) : null;
}
function errOf(err) {
  const st = statusOf(err);
  return st ? `HTTP ${st}` : String((err && err.message) || err).slice(0, 120);
}
function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.Results || payload.Items || payload.Data || [];
}
function oneRow(payload) {
  const list = asRows(payload);
  if (list.length) return list[0];
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  return null;
}
function pick(row, names) {
  for (const n of names) if (row && row[n] != null && row[n] !== '') return row[n];
  return null;
}
const fields = row => (row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row).sort() : []);

// ── A. can an approval be attached to a charge? ─────────────────────────────
async function purchaseOrders() {
  const out = { question: 'Can a purchase order be linked to the bill behind a charge?' };
  try {
    const rows = asRows(await rentManager.get('/PurchaseOrders', { pageSize: 50 }));
    out.reachable = true;
    out.sampled = rows.length;
    out.fields = fields(rows[0]);
    // An approval field that exists and is never filled is not an approval trail.
    // This project has been fooled by a populated-looking schema twice.
    out.approved = rows.filter(r => pick(r, ['ApprovedByUserID', 'ApprovedDate'])).length;
    out.closed = rows.filter(r => r.IsClosed === true).length;
    out.withVendor = rows.filter(r => pick(r, ['VendorID'])).length;

    // THE question: is there a join to a bill? Look from both ends.
    const poId = rows.length ? pick(rows[0], ['PurchaseOrderID', 'ID']) : null;
    out.embeds = [];
    for (const name of ['PurchaseOrderDetails', 'Details', 'Bills', 'Vendor', 'Attachments']) {
      if (poId == null) break;
      try {
        const row = oneRow(await rentManager.get(`/PurchaseOrders/${encodeURIComponent(poId)}`, { embeds: name }));
        const nested = row && (row[name] || row[`${name}s`]);
        out.embeds.push({ name, ok: true, present: nested != null,
          fields: fields(Array.isArray(nested) ? nested[0] : nested) });
      } catch (err) { out.embeds.push({ name, ok: false, error: errOf(err) }); }
    }
    // And from the bill's side — a PurchaseOrderID on a bill would be the clean join.
    try {
      const bill = oneRow(await rentManager.get('/Bills', { pageSize: 1 }));
      out.billFields = fields(bill);
      out.billCarriesPoId = out.billFields.some(f => /purchaseorder/i.test(f));
    } catch (err) { out.billFields = errOf(err); }
  } catch (err) {
    out.reachable = false;
    out.error = errOf(err);
  }
  return out;
}

// ── B. does a history note's FileID lead to bytes? ──────────────────────────
async function historyFiles() {
  const out = { question: 'Does the FileID on a history note lead to an actual document?' };
  try {
    const rows = asRows(await rentManager.get('/HistoryNotes', { pageSize: 200 }));
    out.reachable = true;
    out.sampled = rows.length;
    out.fields = fields(rows[0]);

    // Shape only. A history note's body is free text somebody typed about a
    // tenant; it is counted, never read out.
    const byEntity = {};
    let withFile = 0;
    const fileIds = [];
    for (const r of rows) {
      const t = String(pick(r, ['EntityType']) || '(none)');
      byEntity[t] = byEntity[t] || { notes: 0, withFile: 0 };
      byEntity[t].notes++;
      const fid = pick(r, ['FileID', 'FileId']);
      if (fid != null) {
        withFile++;
        byEntity[t].withFile++;
        if (fileIds.length < 5) fileIds.push({ fileId: fid, entityType: t, historyId: pick(r, ['HistoryID', 'ID']) });
      }
    }
    out.withFileId = withFile;
    out.byEntityType = byEntity;

    // Can the notes be narrowed to the things this tool cares about? A route that
    // only works by paging the whole history is not a route.
    out.filters = [];
    for (const f of ['EntityType,eq,Bill', 'EntityType,eq,Vendor', 'EntityType,eq,Property']) {
      try {
        const r = asRows(await rentManager.get('/HistoryNotes', { filters: f, pageSize: 1 }));
        out.filters.push({ filter: f, ok: true, rows: r.length });
      } catch (err) { out.filters.push({ filter: f, ok: false, error: errOf(err) }); }
    }

    // And the whole point: bytes. On this instance the ONLY thing that has ever
    // returned a file is a DownloadURL that Rent Manager itself handed back —
    // invented paths 404. So look for a record that carries one.
    out.fileRoutes = [];
    const probe = fileIds[0];
    if (probe) {
      out.probeFileId = probe.fileId;
      for (const attempt of [
        { label: '/HistoryNotes/{id}?embeds=File', path: `/HistoryNotes/${encodeURIComponent(probe.historyId)}`, params: { embeds: 'File' }, nested: 'File' },
        { label: '/HistoryNotes/{id}?embeds=Attachments', path: `/HistoryNotes/${encodeURIComponent(probe.historyId)}`, params: { embeds: 'Attachments' }, nested: 'Attachments' },
        { label: '/Files/{fileId}', path: `/Files/${encodeURIComponent(probe.fileId)}`, params: {} },
        { label: '/FileAttachments/{fileId}', path: `/FileAttachments/${encodeURIComponent(probe.fileId)}`, params: {} },
        { label: '/Documents/{fileId}', path: `/Documents/${encodeURIComponent(probe.fileId)}`, params: {} },
      ]) {
        try {
          const row = oneRow(await rentManager.get(attempt.path, attempt.params));
          const target = attempt.nested ? (row && row[attempt.nested]) : row;
          const rec = Array.isArray(target) ? target[0] : target;
          const url = rec ? pick(rec, ['DownloadURL', 'DownloadUrl', 'Url', 'URL', 'Link']) : null;
          out.fileRoutes.push({ ...attempt, path: undefined, params: undefined,
            ok: true, present: rec != null, fields: fields(rec), hasDownloadUrl: Boolean(url) });
          if (url && !out.bytes) {
            // The proof. Length and type only — the bytes themselves stay here.
            try {
              const res = await rentManager.getRaw(String(url));
              out.bytes = { via: attempt.label, status: res.status,
                contentType: res.contentType, length: res.buffer ? res.buffer.length : 0 };
            } catch (err) { out.bytes = { via: attempt.label, error: errOf(err) }; }
          }
        } catch (err) {
          out.fileRoutes.push({ ...attempt, path: undefined, params: undefined, ok: false, error: errOf(err) });
        }
      }
    }
  } catch (err) {
    out.reachable = false;
    out.error = errOf(err);
  }
  return out;
}

// ── C. do RM's groups describe the entities we report on? ───────────────────
async function propertyGroups() {
  const out = { question: "Do Rent Manager's property groups match the entities this site reports?" };
  try {
    const rows = asRows(await rentManager.get('/PropertyGroups', { pageSize: 200 }));
    out.reachable = true;
    out.count = rows.length;
    out.fields = fields(rows[0]);
    out.groups = rows.map(r => ({
      id: pick(r, ['PropertyGroupID', 'ID']),
      name: String(pick(r, ['Name', 'Description']) || ''),
    }));

    // Membership is the whole question and /PropertyGroupProperties is a 404, so
    // find where the link lives before anything is built on it.
    out.membership = [];
    const gid = out.groups.length ? out.groups[0].id : null;
    for (const name of ['Properties', 'PropertyGroupProperties', 'GroupProperties']) {
      if (gid == null) break;
      try {
        const row = oneRow(await rentManager.get(`/PropertyGroups/${encodeURIComponent(gid)}`, { embeds: name }));
        const nested = row && (row[name] || row[`${name}s`]);
        out.membership.push({ via: `/PropertyGroups/{id}?embeds=${name}`, ok: true,
          present: nested != null, count: Array.isArray(nested) ? nested.length : null,
          fields: fields(Array.isArray(nested) ? nested[0] : nested) });
      } catch (err) { out.membership.push({ via: `embeds=${name}`, ok: false, error: errOf(err) }); }
    }
    // The other direction: does a property name its group?
    try {
      const p = oneRow(await rentManager.get('/Properties', { pageSize: 1 }));
      out.propertyFields = fields(p);
      out.propertyCarriesGroup = out.propertyFields.some(f => /group/i.test(f));
    } catch (err) { out.propertyFields = errOf(err); }
    for (const name of ['PropertyGroups', 'PropertyGroup']) {
      try {
        const p = oneRow(await rentManager.get('/Properties', { pageSize: 1, embeds: name }));
        const nested = p && (p[name] || p[`${name}s`]);
        out.membership.push({ via: `/Properties?embeds=${name}`, ok: true,
          present: nested != null, count: Array.isArray(nested) ? nested.length : null,
          fields: fields(Array.isArray(nested) ? nested[0] : nested) });
      } catch (err) { out.membership.push({ via: `/Properties?embeds=${name}`, ok: false, error: errOf(err) }); }
    }
  } catch (err) {
    out.reachable = false;
    out.error = errOf(err);
  }
  return out;
}

async function run() {
  return {
    ranAt: new Date().toISOString(),
    note: 'Counts, field names, ids and names only. No history-note text, no tenant data, no file bytes.',
    purchaseOrders: await purchaseOrders(),
    historyFiles: await historyFiles(),
    propertyGroups: await propertyGroups(),
  };
}

module.exports = { run, purchaseOrders, historyFiles, propertyGroups };
