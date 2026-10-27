// Can this Rent Manager API hand us the actual invoice PDF, or can't it?
//
// ── why this is a service and not just a script ─────────────────────────────
// It started as `node scripts/probeAttachments.js`, which was the wrong shape for
// the person who needs the answer. The owner, 2026-08-26: *"this thing you want me to
// run, where do I run it?"* — a fair question, and the honest answer was "on a
// machine with a checkout, a Node install and the API credentials in a .env file",
// which is a developer's answer to an owner's question.
//
// The credentials already live on the server. So the probe lives here, the tab has
// a button, and the CLI is a thin wrapper over the same code for whoever is at a
// terminal anyway.
//
// ── what it is establishing ─────────────────────────────────────────────────
// *"They were able to pull up all these different bills in Rent Manager. Why can't
// we do that through the API?"* The file plainly exists — staff open the scan in
// the Rent Manager client. What has never been established is whether THIS API, on
// THIS instance, at THIS permission level exposes the document store, and under
// which name. Four passes:
//
//   1. DISCOVERY — does the API describe itself? A service document, $metadata or a
//      swagger file would list every resource and settle it in one request.
//   2. RESOURCES — sweep every plausible document resource name and record exactly
//      what came back. The statuses mean different things: 404 no such resource ·
//      401/403 it exists and we are not allowed · 400 it exists but wants a filter.
//      /Bills, /Vendors and /Payments are probed as a CONTROL, so a wall of 404s on
//      the document side is a fact about the document store rather than about our
//      credentials.
//   3. BILLS — ask for a real bill again under each plausible `embeds`, because a
//      collection that is not listable on its own may still ride along on its parent.
//   3b. EVERYTHING ELSE — "the bills themselves, or the credit card bills, or the
//      receipts, WHATEVER they have in Rent Manager". Documents hang off payments,
//      checks, vendors, work orders, properties and units too, and ONE reachable
//      document anywhere changes the diagnosis: the store exists and is visible to
//      this API, so the question narrows from "does this do attachments at all" to
//      "why not on bills".
//   4. BYTES — for any attachment record found, walk the download shapes and report
//      the content type and size that came back.
//
// It ends by composing the text to send Rent Manager support: every request made,
// every answer received, and the four questions worth asking. That is the
// difference between "our integration can't get PDFs" and a question their support
// agent can answer in one reply.
//
// READ-ONLY. Every request is a GET; nothing is created, changed or deleted. It
// records resource names, HTTP statuses and field names — no tenant data, and no
// financial figures.

const rentManager = require('./rentManagerClient');

// Bumped whenever a PASS changes, so a result can say which probe produced it.
// Reading an old answer as a verdict on new code has cost two rounds already.
const VERSION = 11;   // …7 +every handle in its own context · 8 +follow the DownloadURL a bill embed hands back

// ── the candidate lists ─────────────────────────────────────────────────────
const DISCOVERY = ['/', '/$metadata', '/swagger/v1/swagger.json', '/swagger.json', '/openapi.json',
  '/Metadata', '/Resources', '/Help', '/ApiDocs'];

const DOC_RESOURCES = [
  'Attachments', 'Files', 'Documents', 'Images', 'ImageFiles', 'Media', 'Scans',
  'FileAttachments', 'DocumentAttachments', 'BillAttachments', 'AttachmentTypes',
  'DocumentTypes', 'FileTypes', 'HistoryNotes', 'History', 'Notes', 'UserDefinedFields',
];
const CONTROL_RESOURCES = ['Bills', 'BillDetails', 'Vendors', 'Payments', 'Checks'];

const BILL_EMBEDS = ['Attachments', 'Files', 'Documents', 'Images', 'History', 'HistoryNotes',
  'Notes', 'UserDefinedValues', 'BillAttachments', 'BillDetails'];

// Documents in Rent Manager do not only hang off bills. The owner's own words were
// "the bills themselves, or the credit card bills, or the receipts, WHATEVER they
// have in Rent Manager" — and that turns out to matter for the diagnosis, not just
// for coverage. A work order with photos on it, or a vendor with a W-9, proves the
// document store EXISTS and is reachable; the question then narrows from "does
// this API do attachments at all" to "why not on bills". Finding one reachable
// document anywhere in the account is the most useful single thing this probe can
// do, so it asks every parent a scan plausibly hangs from.
// ── The lead the first live run found (2026-08-26) ──────────────────────────
// Every document-shaped resource name 404s on this instance — /Attachments,
// /Files, /Documents, /Images, /Media, /Scans, all of them. Four things answered:
//
//   /HistoryNotes  200, 1 row      /History  200, 1 row
//   /Notes         200, 0 rows     /UserDefinedFields  200, 1 row
//
// That is worth chasing rather than reporting as a dead end. In the Rent Manager
// desktop client, documents attach to a HISTORY record — the History & Notes tab
// is where a scanned invoice lives — so a reachable /History is the most likely
// door left in the building. What is unknown is whether a history row CARRIES its
// file (a name, an id, a path, or the bytes) or merely records that one exists.
//
// Its field names answer that in one request, so the probe now reads them, looks
// for anything file-shaped, and tries the same embeds and download shapes against
// history that it tried against bills.
const HISTORY_RESOURCES = ['History', 'HistoryNotes', 'Notes'];
const HISTORY_EMBEDS = ['Attachments', 'Files', 'Documents', 'Images', 'HistoryNotes', 'Notes', 'UserDefinedValues'];
const FILEISH = /attach|file|image|doc|scan|blob|content|url|path|extension|mime/i;

const PARENT_PROBES = [
  { type: 'Payment', path: '/Payments', why: 'a payment — the credit card charge or the check' },
  { type: 'Check', path: '/Checks', why: 'a check' },
  { type: 'Vendor', path: '/Vendors', why: 'a vendor (W-9s, contracts, COIs live here)' },
  { type: 'ServiceManagerIssue', path: '/ServiceManagerIssues', why: 'a work order (these usually carry photos)' },
  { type: 'Property', path: '/Properties', why: 'a property' },
  { type: 'Unit', path: '/Units', why: 'a unit' },
];

const DOWNLOADS = [
  id => `/Attachments/${id}/Download`,
  id => `/Attachments/${id}/File`,
  id => `/Attachments/${id}/Content`,
  id => `/Attachments/${id}`,
  id => `/Files/${id}/Download`,
  id => `/Documents/${id}/Download`,
  id => `/Images/${id}/Download`,
];

// ── helpers ─────────────────────────────────────────────────────────────────
function statusOf(err) {
  const m = /\((\d{3})\)/.exec(err && err.message ? err.message : '');
  return m ? Number(m[1]) : null;
}
// The whole value of the sweep is that these four answers mean different things.
function verdictFor(status) {
  if (status === 404) return 'no such resource on this instance';
  if (status === 401 || status === 403) return 'EXISTS but this API user is not allowed';
  if (status === 400) return 'exists, but rejected the request (usually wants a filter)';
  if (status === 405) return 'exists, but not readable this way';
  if (status === 500) return 'server error — worth quoting to support verbatim';
  return null;
}
function rowsOf(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  return body.Results || body.Items || body.Data || [];
}
function ymd(d) { return d.toISOString().slice(0, 10); }

async function tryGet(p, params) {
  try {
    const body = await rentManager.get(p, params || {});
    const rows = rowsOf(body);
    return { ok: true, rows, fields: rows.length && typeof rows[0] === 'object' ? Object.keys(rows[0]) : [], body };
  } catch (err) {
    const status = statusOf(err);
    return { ok: false, status, error: String(err.message || err).slice(0, 220), verdict: verdictFor(status) };
  }
}

// ── the probe ───────────────────────────────────────────────────────────────
// Returns a structure the tab renders and the CLI prints. `transcript` is the
// human-readable running commentary; everything else is data.
async function probe({ days = 45, billId = null } = {}) {
  const t0 = Date.now();
  const transcript = [];
  const say = line => transcript.push(line);
  const out = { discovery: [], resources: [], embeds: [], parents: [], history: [], chain: [], withFiles: [], handles: [], bytes: [], bill: null };

  // Every file-shaped id the API hands us, not just the first one.
  //
  // v6 found the record we had been missing — a history note that really does carry
  // a file — and then downloaded the WRONG id from it. `out.followId` was already
  // set to a FileID scraped in pass 3c, so the `followId == null` guard threw away
  // the HistoryAttachmentID that the embed had just returned. Two different handles,
  // one slot, first writer wins: the probe tried the file id against seven generic
  // resource names and called it a day.
  //
  // A handle is only meaningful next to the record it came off — /HistoryAttachments
  // /{id} means nothing if the id was a FileID. So each one is kept WITH its parent,
  // and pass 4b walks all of them.
  const addHandle = (h) => {
    if (h.id == null) return;
    if (out.handles.some(x => x.id === h.id && x.from === h.from)) return;
    out.handles.push(h);
  };

  say('1. Does the API describe itself?');
  for (const p of DISCOVERY) {
    const r = await tryGet(p, {});
    out.discovery.push({ path: p, ok: r.ok, status: r.status, verdict: r.verdict });
    if (r.ok) {
      const keys = r.body && !Array.isArray(r.body) ? Object.keys(r.body).slice(0, 40) : [];
      say(`   ✓ ${p} answered${keys.length ? ` — it lists: ${keys.join(', ')}` : ''}`);
    } else {
      say(`   · ${p} → ${r.status || 'error'}${r.verdict ? ` (${r.verdict})` : ''}`);
    }
  }

  say('');
  say('2. Which document resources exist here?');
  for (const name of [...DOC_RESOURCES, ...CONTROL_RESOURCES]) {
    const r = await tryGet(`/${name}`, { pageSize: 1 });
    const control = CONTROL_RESOURCES.includes(name);
    out.resources.push({
      name, control, ok: r.ok, status: r.status, rows: r.ok ? r.rows.length : null,
      fields: r.fields || [], verdict: r.verdict, error: r.error,
    });
    say(r.ok
      ? `   ✓ /${name} → ${r.rows.length} row(s)${r.fields.length ? `; fields: ${r.fields.slice(0, 10).join(', ')}${r.fields.length > 10 ? '…' : ''}` : ' (empty)'}`
      : `   ${control ? '⚠' : '·'} /${name} → ${r.status || 'error'}${r.verdict ? ` — ${r.verdict}` : ''}`);
  }
  const reachable = out.resources.filter(r => r.ok && !r.control).map(r => r.name);
  say('');
  say(reachable.length
    ? `   → document-side resources that answered: ${reachable.join(', ')}`
    : '   → NO document-side resource answered. That is the finding.');

  say('');
  say('3. Does a bill carry its attachments?');
  let bill = null;
  if (billId) {
    const r = await tryGet(`/Bills/${encodeURIComponent(billId)}`, {});
    bill = r.ok ? (r.rows.length ? r.rows[0] : r.body) : null;
    if (!bill) say(`   could not read bill ${billId}: ${r.error || 'no data'}`);
  } else {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    let r = await tryGet('/Bills', { filters: `BillDate,ge,${ymd(from)};BillDate,le,${ymd(to)}`, pageSize: 25 });
    if (!r.ok) {
      // The date filter 400s on this instance — /Bills rows come back with
      // TransactionDate, not BillDate, so the filter names a column that is not
      // there. v6 stopped at the 400 and never looked at a bill at all. /Bills
      // itself answers fine (pass 2 proves it), so ask again without the filter.
      say(`   /Bills filtered by date → ${r.status || 'error'} (the column is not BillDate here) — asking unfiltered`);
      r = await tryGet('/Bills', { pageSize: 25 });
    }
    if (!r.ok) say(`   /Bills → ${r.status || 'error'}`);
    else if (!r.rows.length) say('   /Bills answered with no rows');
    else bill = r.rows[0];
  }

  if (bill) {
    const bid = bill.BillID ?? bill.BillId ?? bill.ID ?? bill.Id;
    const fileish = Object.keys(bill).filter(k => /attach|file|image|doc|scan|url|path/i.test(k));
    out.bill = { id: bid, date: String(bill.BillDate || bill.Date || '').slice(0, 10), fields: Object.keys(bill), fileish };
    say(`   probing bill ${bid} (${out.bill.date})`);
    say(fileish.length ? `   ⚑ file-shaped fields ON the bill: ${fileish.join(', ')}`
      : '   no file-shaped field on the bill record itself');
    for (const emb of BILL_EMBEDS) {
      const r = await tryGet(`/Bills/${encodeURIComponent(bid)}`, { embeds: emb });
      if (!r.ok) {
        out.embeds.push({ embed: emb, ok: false, status: r.status });
        say(`   · embeds=${emb} → ${r.status || 'error'}${r.verdict ? ` — ${r.verdict}` : ''}`);
        continue;
      }
      const row = r.rows.length ? r.rows[0] : r.body;
      const got = row && row[emb];
      const n = Array.isArray(got) ? got.length : (got ? 1 : 0);
      out.embeds.push({ embed: emb, ok: true, count: n, fields: n && Array.isArray(got) ? Object.keys(got[0]) : [] });
      say(`   ${n ? '✓' : '·'} embeds=${emb} → ${n ? `${n} item(s)` : 'accepted, but nothing came back'}`);
      // An embed that returns something is the strongest handle on the board: it
      // came off the bill we actually care about. v6 could not see this at all —
      // its /Bills query 400d, so no bill was ever asked — and v7's first run
      // logged the row without ever trying to open it, because pass 4's candidate
      // slot had already been filled from history.
      if (n) {
        const item = Array.isArray(got) ? got[0] : got;
        if (item && typeof item === 'object') {
          say(`      ⚑ fields on it: ${Object.keys(item).join(', ')}`);
          const url = item.DownloadURL || item.DownloadUrl || item.Url || item.URL;
          if (url) say(`      ⚑ it carries a DownloadURL: ${String(url).slice(0, 120)}`);
          addHandle({
            id: item.FileID ?? item.AttachmentID ?? item.ID ?? item.Id,
            from: `bill ${bid} → embeds=${emb}`,
            resource: emb, parentRes: 'Bills', parentId: bid,
            downloadUrl: url || null,
            filePath: item.Path || null,
            token: item.Token || null,
            name: item.Name || null,
            extension: item.Extension || null,
          });
        }
      }
    }
  }

  say('');
  say('3b. Do documents hang off anything OTHER than a bill?');
  // One reachable document anywhere is the whole answer changing shape: it means
  // the store is there and the bill side is the exception, which is a different
  // conversation with support than "attachments are not exposed".
  for (const par of PARENT_PROBES) {
    const one = await tryGet(par.path, { pageSize: 1 });
    if (!one.ok || !one.rows.length) { say(`   · ${par.path} → nothing to test against`); continue; }
    const rec = one.rows[0];
    const id = rec[`${par.type}ID`] ?? rec.ID ?? rec.Id
      ?? rec[Object.keys(rec).find(k => /ID$/i.test(k)) || ''];
    if (id == null) { say(`   · ${par.path} → could not find an id on the record`); continue; }
    const byFilter = await tryGet('/Attachments', { filters: `ParentType,eq,${par.type};ParentID,eq,${id}`, pageSize: 5 });
    const byEmbed = await tryGet(`${par.path}/${encodeURIComponent(id)}`, { embeds: 'Attachments' });
    const embedRow = byEmbed.ok ? (byEmbed.rows.length ? byEmbed.rows[0] : byEmbed.body) : null;
    const embedCount = embedRow && Array.isArray(embedRow.Attachments) ? embedRow.Attachments.length : 0;
    const found = (byFilter.ok ? byFilter.rows.length : 0) + embedCount;
    out.parents.push({
      type: par.type, why: par.why, id,
      filterOk: byFilter.ok, filterStatus: byFilter.status, filterRows: byFilter.ok ? byFilter.rows.length : null,
      embedOk: byEmbed.ok, embedCount, found,
    });
    say(`   ${found ? '✓' : '·'} ${par.why} → ${found ? `${found} document(s) reachable` : `nothing (filter ${byFilter.ok ? '200' : byFilter.status || 'error'}, embed ${byEmbed.ok ? '200' : byEmbed.status || 'error'})`}`);
  }
  const parentHit = out.parents.find(p2 => p2.found);
  say(parentHit
    ? `   → documents ARE reachable in this account (on ${parentHit.why}). The store exists.`
    : '   → no document is reachable on any parent we tried, not just on bills.');

  say('');
  say('3c. History — where the desktop client keeps its documents');
  // A history row that names a file is the whole answer; a history row that does
  // not is the difference between "the store is elsewhere" and "there is no store".
  for (const name of HISTORY_RESOURCES) {
    const listed = out.resources.find(r => r.name === name);
    if (!listed || !listed.ok) { say(`   · /${name} did not answer — nothing to inspect`); continue; }
    const r = await tryGet(`/${name}`, { pageSize: 1 });
    if (!r.ok || !r.rows.length) { say(`   · /${name} → no rows to inspect`); continue; }
    const rec = r.rows[0];
    const fields = Object.keys(rec);
    const fileish = fields.filter(f => FILEISH.test(f));
    const id = rec[`${name.replace(/s$/, '')}ID`] ?? rec.HistoryID ?? rec.ID ?? rec.Id
      ?? rec[fields.find(f => /ID$/i.test(f)) || ''];
    const embedHits = [];
    for (const emb of HISTORY_EMBEDS) {
      const e = await tryGet(`/${name}/${encodeURIComponent(id)}`, { embeds: emb });
      if (!e.ok) continue;
      const row = e.rows.length ? e.rows[0] : e.body;
      const got = row && row[emb];
      const n = Array.isArray(got) ? got.length : (got ? 1 : 0);
      if (n) embedHits.push({ embed: emb, count: n, fields: Array.isArray(got) ? Object.keys(got[0]) : [] });
    }
    out.history.push({ resource: name, id, fields, fileish, embedHits, sample: rec });
    say(`   ${fileish.length || embedHits.length ? '✓' : '·'} /${name} row ${id} — ${fields.length} fields`);
    say(`      fields: ${fields.join(', ')}`);
    if (fileish.length) say(`      ⚑ file-shaped: ${fileish.join(', ')}`);
    if (embedHits.length) say(`      ⚑ embeds carrying something: ${embedHits.map(h => `${h.embed} (${h.count})`).join(', ')}`);
  }
  // ── Follow what the API just told us (2026-08-26, second live run) ─────────
  // The first run said "history knows about files". The second said WHICH files:
  //
  //   /History      14 fields — file-shaped: HistoryAttachments
  //   /HistoryNotes 12 fields — file-shaped: FileID
  //
  // That is not a hint any more, it is a name. A field called HistoryAttachments is
  // a collection this API knows how to talk about, and a FileID is a handle to
  // something. So instead of guessing another list of resource names, the probe now
  // asks for exactly what the rows are carrying: the field name as an embed, the
  // field name as a resource, and the id's value against every download shape.
  for (const h of out.history) {
    if (!h.fileish.length) continue;
    h.followed = [];
    for (const field of h.fileish) {
      // 1. the field as an EMBED on its own record
      const e = await tryGet(`/${h.resource}/${encodeURIComponent(h.id)}`, { embeds: field });
      const row = e.ok ? (e.rows.length ? e.rows[0] : e.body) : null;
      const got = row && row[field];
      const n = Array.isArray(got) ? got.length : (got ? 1 : 0);
      if (n) {
        const item = Array.isArray(got) ? got[0] : got;
        const itemFields = item && typeof item === 'object' ? Object.keys(item) : [];
        h.followed.push({ how: `embeds=${field}`, count: n, fields: itemFields });
        say(`   ✓ /${h.resource}/${h.id}?embeds=${field} → ${n} item(s)${itemFields.length ? `; fields: ${itemFields.join(', ')}` : ''}`);
        // the item's own id is the best download candidate we will get
        if (item && typeof item === 'object') {
          const iid = item.HistoryAttachmentID ?? item.AttachmentID ?? item.FileID ?? item.ID ?? item.Id;
          addHandle({
            id: iid, from: `${h.resource}.${field} embed`,
            resource: /s$/i.test(field) ? field : null,
            parentRes: h.resource, parentId: h.id,
            fileId: item.FileID != null ? item.FileID : null,
          });
          if (iid != null && out.followId == null) {
            out.followId = iid;
            out.followFrom = `${h.resource} ${field}`;
            // The collection's own name is the resource its members most likely
            // download from — /HistoryAttachments/{id}/Download.
            if (/s$/i.test(field)) out.followResource = field;
          }
        }
      } else if (e.ok) {
        h.followed.push({ how: `embeds=${field}`, count: 0 });
        say(`   · /${h.resource}/${h.id}?embeds=${field} → accepted, nothing in it`);
      } else {
        h.followed.push({ how: `embeds=${field}`, status: e.status });
        say(`   · /${h.resource}/${h.id}?embeds=${field} → ${e.status || 'error'}`);
      }

      // 2. the field name as a RESOURCE of its own (/HistoryAttachments)
      if (/s$/i.test(field)) {
        const asRes = await tryGet(`/${field}`, { pageSize: 1 });
        h.followed.push({ how: `GET /${field}`, ok: asRes.ok, status: asRes.status, rows: asRes.ok ? asRes.rows.length : null, fields: asRes.fields });
        say(`   ${asRes.ok ? '✓' : '·'} /${field} → ${asRes.ok ? `${asRes.rows.length} row(s)${asRes.fields.length ? `; fields: ${asRes.fields.join(', ')}` : ''}` : `${asRes.status || 'error'}`}`);
        // A resource that answers is a download candidate whether or not we already
        // have an id from the embed — it is the same collection either way.
        if (asRes.ok) out.followResource = out.followResource || field;
        if (asRes.ok && asRes.rows.length && out.followId == null) {
          const r0 = asRes.rows[0];
          const iid = r0.AttachmentID ?? r0.FileID ?? r0.HistoryAttachmentID ?? r0.ID ?? r0.Id;
          if (iid != null) { out.followId = iid; out.followFrom = `/${field}`; }
        }
      }

      // 3. a field holding an ID holds a HANDLE — use its value, not a guess
      if (/ID$/i.test(field) && h.sample && h.sample[field] != null) {
        addHandle({ id: h.sample[field], from: `${h.resource}.${field}`, parentRes: h.resource, parentId: h.id });
        out.followId = out.followId == null ? h.sample[field] : out.followId;
        out.followFrom = out.followFrom || `${h.resource}.${field}`;
        say(`   ⚑ ${h.resource}.${field} = ${h.sample[field]} — using it as a download handle`);
      }
    }
  }

  const historyLead = out.history.find(h => h.fileish.length || h.embedHits.length) || null;
  const historyHit = historyLead;
  say(historyHit
    ? `   → /${historyHit.resource} looks like it knows about files. That is the thread to pull.`
    : '   → history records carry nothing file-shaped either.');

  say('');
  say('3d. Does a BILL reach history, and history reach the file?');
  // The chain the whole thing probably hangs on. Rent Manager's client shows a
  // scanned invoice on a bill's History & Notes tab, which means a history record
  // is linked to the bill and carries the file. We have proved the two ends exist
  // (bills read fine; history rows carry HistoryAttachments). What is untested is
  // the LINK — and if it works, that is the route the tab needs, not a support
  // ticket.
  if (out.bill) {
    const bid = out.bill.id;
    // (a) nested embeds: ask the bill for its history, and the history for its files
    for (const emb of ['History', 'History.HistoryAttachments', 'HistoryAttachments', 'HistoryNotes']) {
      const r = await tryGet(`/Bills/${encodeURIComponent(bid)}`, { embeds: emb });
      if (!r.ok) { out.chain.push({ how: `bill embeds=${emb}`, status: r.status }); say(`   · /Bills/${bid}?embeds=${emb} → ${r.status || 'error'}`); continue; }
      const row = r.rows.length ? r.rows[0] : r.body;
      const head = emb.split('.')[0];
      const got = row && row[head];
      const n = Array.isArray(got) ? got.length : (got ? 1 : 0);
      out.chain.push({ how: `bill embeds=${emb}`, count: n, fields: n && Array.isArray(got) ? Object.keys(got[0]) : [] });
      say(`   ${n ? '✓' : '·'} /Bills/${bid}?embeds=${emb} → ${n ? `${n} item(s); fields: ${Array.isArray(got) ? Object.keys(got[0]).join(', ') : ''}` : 'accepted, nothing in it'}`);
      if (n && Array.isArray(got)) {
        const inner = got[0].HistoryAttachments || got[0].Attachments;
        if (Array.isArray(inner) && inner.length) {
          const iid = inner[0].HistoryAttachmentID ?? inner[0].AttachmentID ?? inner[0].FileID ?? inner[0].ID;
          if (iid != null && out.followId == null) { out.followId = iid; out.followFrom = `bill → ${emb}`; out.followResource = 'HistoryAttachments'; }
          say(`      ⚑ and it carries ${inner.length} attachment(s) — id ${iid}`);
        }
      }
    }
    // (b) history filtered to this bill, under the filter shapes RM uses elsewhere
    for (const f of [`ParentType,eq,Bill;ParentID,eq,${bid}`, `BillID,eq,${bid}`, `ParentID,eq,${bid}`]) {
      const r = await tryGet('/History', { filters: f, pageSize: 5 });
      out.chain.push({ how: `/History?filters=${f}`, ok: r.ok, status: r.status, rows: r.ok ? r.rows.length : null });
      say(`   ${r.ok && r.rows.length ? '✓' : '·'} /History?filters=${f} → ${r.ok ? `${r.rows.length} row(s)` : `${r.status || 'error'}`}`);
      if (r.ok && r.rows.length) {
        const hid = r.rows[0].HistoryID ?? r.rows[0].ID;
        if (hid != null) {
          const e = await tryGet(`/History/${encodeURIComponent(hid)}`, { embeds: 'HistoryAttachments' });
          const row = e.ok ? (e.rows.length ? e.rows[0] : e.body) : null;
          const att = row && row.HistoryAttachments;
          const n = Array.isArray(att) ? att.length : 0;
          say(`      ${n ? '✓' : '·'} that history record → ${n} attachment(s)`);
          if (n) {
            const iid = att[0].HistoryAttachmentID ?? att[0].AttachmentID ?? att[0].FileID ?? att[0].ID;
            if (iid != null && out.followId == null) { out.followId = iid; out.followFrom = 'bill → history → HistoryAttachments'; out.followResource = 'HistoryAttachments'; }
          }
        }
        break;
      }
    }
  }

  say('');
  say('3e. Find a record that actually HAS a file');
  // The hole in every run so far. We take the FIRST history row the API hands back
  // — an arbitrary record, most likely a phone-call note with no file on it — and
  // then conclude something from its empty attachment list. "embeds=HistoryAttachments
  // returned 0 items" is not evidence the embed does not work; it is evidence that
  // record has no attachment.
  //
  // /HistoryNotes carries a FileID, and a FileID is only interesting when it points
  // at something. So: ask for the rows where it does. If none exist anywhere, that
  // is a real finding. If they do, we finally have the id of a file that EXISTS,
  // and every download shape is being tried against something real.
  const FILE_FILTERS = [
    { res: 'HistoryNotes', f: 'FileID,gt,0' },
    { res: 'HistoryNotes', f: 'FileID,ne,null' },
    { res: 'History', f: 'HasAttachment,eq,true' },
    { res: 'History', f: 'AttachmentCount,gt,0' },
  ];
  for (const { res, f } of FILE_FILTERS) {
    const r = await tryGet(`/${res}`, { filters: f, pageSize: 5 });
    out.withFiles.push({ res, filter: f, ok: r.ok, status: r.status, rows: r.ok ? r.rows.length : null });
    say(`   ${r.ok && r.rows.length ? '✓' : '·'} /${res}?filters=${f} → ${r.ok ? `${r.rows.length} row(s)` : `${r.status || 'error'}`}`);
    if (!r.ok || !r.rows.length) continue;
    const rec = r.rows[0];
    const fid = rec.FileID ?? rec.AttachmentID ?? rec.HistoryAttachmentID;
    const rid = rec.HistoryNoteID ?? rec.HistoryID ?? rec.ID ?? rec.Id;
    say(`      ⚑ a record WITH a file: ${res} ${rid}, file id ${fid}`);
    // Ask that record for its attachments, and take the file id as a handle.
    const e = await tryGet(`/${res}/${encodeURIComponent(rid)}`, { embeds: 'HistoryAttachments' });
    const row = e.ok ? (e.rows.length ? e.rows[0] : e.body) : null;
    const att = row && (row.HistoryAttachments || row.Attachments);
    if (Array.isArray(att) && att.length) {
      say(`      ✓ and its embed returns ${att.length} attachment(s): ${Object.keys(att[0]).join(', ')}`);
      const iid = att[0].HistoryAttachmentID ?? att[0].AttachmentID ?? att[0].ID;
      // BOTH ids, kept apart: the attachment row's own id, and the file id it points
      // at. v6 conflated them and only ever tried the second.
      addHandle({ id: iid, from: `${res} ${rid} → HistoryAttachments`, resource: 'HistoryAttachments', parentRes: res, parentId: rid, fileId: att[0].FileID ?? fid });
      addHandle({ id: att[0].FileID ?? fid, from: `${res} ${rid} → FileID`, parentRes: res, parentId: rid, isFileId: true });
      if (iid != null && out.followId == null) { out.followId = iid; out.followFrom = `${res} with a file`; out.followResource = 'HistoryAttachments'; }
    } else if (fid != null) {
      addHandle({ id: fid, from: `${res}.FileID (a file that exists)`, parentRes: res, parentId: rid, isFileId: true });
      if (out.followId == null) {
        out.followId = fid;
        out.followFrom = `${res}.FileID (a file that exists)`;
      }
    }
    break;
  }
  if (!out.withFiles.some(w => w.rows)) {
    say('   → no record anywhere reports carrying a file. Every earlier "0 items" was');
    say('     an empty record, and now we know there is no non-empty one to find.');
  }

  say('');
  say('4. Can we get the actual bytes?');
  // An address the API handed us outranks every path we could assemble, so it is
  // tried before the guessing starts. (v7's first live run had the URL in hand and
  // still opened with /Attachments/12/Download, because the guessing came first.)
  for (const h of out.handles.filter(x => x.downloadUrl)) {
    if (out.bytes.some(b => b.isFile)) break;
    try {
      const r3 = await rentManager.getRaw(h.downloadUrl, {});
      const size = r3.buffer ? r3.buffer.length : 0;
      const isFile = r3.ok && size > 0 && !/json/i.test(r3.contentType || '');
      out.bytes.push({ path: h.downloadUrl, status: r3.status, contentType: r3.contentType, size, isFile, handle: h.from, fromUrl: true });
      say(`   ${isFile ? '✓' : (r3.ok ? '⚑' : '·')} ${String(h.downloadUrl).slice(0, 110)} → ${r3.status} ${r3.contentType || '(no type)'} ${size} bytes`);
      if (isFile) say(`      ⇒ THIS IS THE ONE — ${h.name || 'the file'} came back, ${size} bytes.`);
    } catch (err) {
      out.bytes.push({ path: String(h.downloadUrl).slice(0, 160), error: String(err.message || err).slice(0, 160), handle: h.from, fromUrl: true });
      say(`   · ${String(h.downloadUrl).slice(0, 110)} → ${String(err.message || err).slice(0, 100)}`);
    }
  }
  // Order matters here. A handle the API HANDED us — an attachment id from a
  // history embed, or a FileID off a history note — outranks anything scraped from
  // the first row of a listable resource, which is how a HistoryNoteID once ended
  // up being downloaded from /Attachments and 404ing four times in a row.
  let candidateId = out.followId != null ? out.followId : null;
  let candidateFrom = candidateId != null ? (out.followFrom || 'history') : '';
  const embedHit = out.embeds.find(e => e.ok && e.count);
  if (candidateId == null && embedHit && out.bill) {
    const r = await tryGet(`/Bills/${encodeURIComponent(out.bill.id)}`, { embeds: embedHit.embed });
    const row = r.ok && r.rows.length ? r.rows[0] : (r.ok ? r.body : null);
    const first = row && Array.isArray(row[embedHit.embed]) ? row[embedHit.embed][0] : null;
    if (first) {
      candidateId = first.AttachmentID ?? first.FileID ?? first.DocumentID ?? first.ImageID ?? first.ID ?? first.Id;
      candidateFrom = `bill embed ${embedHit.embed}`;
    }
  }
  // A document found on ANY parent is as good a download candidate as one found on
  // a bill — better, when the bill side came back empty.
  if (candidateId == null && parentHit) {
    const r = await tryGet('/Attachments', { filters: `ParentType,eq,${parentHit.type};ParentID,eq,${parentHit.id}`, pageSize: 1 });
    const first = r.ok && r.rows.length ? r.rows[0] : null;
    if (first) {
      candidateId = first.AttachmentID ?? first.FileID ?? first.DocumentID ?? first.ImageID ?? first.ID ?? first.Id;
      candidateFrom = `${parentHit.type} attachment`;
    }
  }
  if (candidateId == null) {
    for (const name of reachable) {
      const r = await tryGet(`/${name}`, { pageSize: 1 });
      const first = r.ok && r.rows.length ? r.rows[0] : null;
      if (first) {
        candidateId = first.AttachmentID ?? first.FileID ?? first.DocumentID ?? first.ImageID ?? first.ID ?? first.Id;
        if (candidateId != null) { candidateFrom = `/${name}`; break; }
      }
    }
  }
  // The handle the follow-up found — an attachment id from an embed, or a FileID
  // read straight off a history note. A real id beats every guess below it.
  if (candidateId != null && out.followId != null && !out.bytes.length && !out.bytes.some(b => b.isFile)) {
    const res = out.followResource;
    const extra = res ? [
      id => `/${res}/${id}/Download`, id => `/${res}/${id}/File`,
      id => `/${res}/${id}/Content`, id => `/${res}/${id}`,
    ] : [];
    for (const shape of [...extra, ...DOWNLOADS]) {
      const p2 = shape(encodeURIComponent(candidateId));
      try {
        const r2 = await rentManager.getRaw(p2, {});
        const size = r2.buffer ? r2.buffer.length : 0;
        const isFile = r2.ok && size > 0 && !/json/i.test(r2.contentType || '');
        out.bytes.push({ path: p2, status: r2.status, contentType: r2.contentType, size, isFile });
        say(`   ${isFile ? '✓' : '·'} ${p2} → ${r2.status} ${r2.contentType || '(no type)'} ${size} bytes`);
        if (isFile) { say('      ⇒ THIS IS THE ONE — the file came back.'); break; }
      } catch (err) {
        out.bytes.push({ path: p2, error: String(err.message || err).slice(0, 160) });
      }
    }
  }

  // History-shaped routes, when history is the only thing that answered. The
  // /Attachments/{id}/… shapes are pointless on an instance where /Attachments
  // itself 404s; these ask the resource that DID answer.
  if (candidateId == null && !out.bytes.some(b => b.isFile) && historyLead && historyLead.id != null) {
    const hres = historyLead.resource, hid = encodeURIComponent(historyLead.id);
    for (const p2 of [`/${hres}/${hid}/Attachments`, `/${hres}/${hid}/Files`, `/${hres}/${hid}/Documents`,
      `/${hres}/${hid}/Download`, `/${hres}/${hid}/File`]) {
      try {
        const res = await rentManager.getRaw(p2, {});
        const size = res.buffer ? res.buffer.length : 0;
        const isFile = res.ok && size > 0 && !/json/i.test(res.contentType || '');
        out.bytes.push({ path: p2, status: res.status, contentType: res.contentType, size, isFile });
        say(`   ${isFile ? '✓' : '·'} ${p2} → ${res.status} ${res.contentType || '(no type)'} ${size} bytes`);
        if (isFile) { say('      ⇒ THIS IS THE ONE — the file came back.'); break; }
      } catch (err) {
        out.bytes.push({ path: p2, error: String(err.message || err).slice(0, 160) });
        say(`   · ${p2} → ${String(err.message || err).slice(0, 120)}`);
      }
    }
  }
  if (out.bytes.some(b => b.isFile)) {
    // already have the file; no reason to walk the guess list
  } else if (candidateId == null && !out.bytes.length) {
    say('   nothing to download — no attachment record was reachable above.');
  } else {
    say(`   trying id ${candidateId} (from ${candidateFrom})`);
    for (const shape of DOWNLOADS) {
      const p = shape(encodeURIComponent(candidateId));
      try {
        const res = await rentManager.getRaw(p, {});
        const size = res.buffer ? res.buffer.length : 0;
        const isFile = res.ok && size > 0 && !/json/i.test(res.contentType || '');
        out.bytes.push({ path: p, status: res.status, contentType: res.contentType, size, isFile });
        say(`   ${isFile ? '✓' : '·'} ${p} → ${res.status} ${res.contentType || '(no type)'} ${size} bytes`);
        if (isFile) { say('      ⇒ THIS IS THE ONE — the file came back.'); break; }
      } catch (err) {
        out.bytes.push({ path: p, error: String(err.message || err).slice(0, 160) });
        say(`   · ${p} → ${String(err.message || err).slice(0, 120)}`);
      }
    }
  }

  say('');
  say('4b. Every handle we were given, tried in its own context');
  // Pass 4 tries one id against a fixed list of top-level resource names. On an
  // instance where /Attachments, /Files and /Documents all 404, that list can only
  // ever produce seven more 404s — which is exactly what v6 printed.
  //
  // What v6 also produced, and then ignored, was a HistoryAttachment row:
  // HistoryAttachmentID, HistoryID, FileID. Three fields, no filename and no bytes,
  // so the file itself is somewhere else — but the row is the map to it. These
  // routes ask using the id AND the record it belongs to, which is the part a
  // top-level guess cannot express.
  const shapesFor = (h) => {
    const id = encodeURIComponent(h.id);
    const paths = [];
    const push = (x) => { if (x && !paths.includes(x)) paths.push(x); };
    if (h.resource) {
      const r = encodeURIComponent(h.resource);
      push(`/${r}/${id}`);
      push(`/${r}/${id}/Download`);
      push(`/${r}/${id}/File`);
      push(`/${r}/${id}/Content`);
    }
    if (h.parentRes && h.parentId != null) {
      const pr = encodeURIComponent(h.parentRes), pid = encodeURIComponent(h.parentId);
      push(`/${pr}/${pid}/HistoryAttachments/${id}`);
      push(`/${pr}/${pid}/HistoryAttachments/${id}/Download`);
      push(`/${pr}/${pid}/Attachments/${id}/Download`);
      push(`/${pr}/${pid}/Files/${id}`);
      push(`/${pr}/${pid}/File`);
      push(`/${pr}/${pid}/Download`);
    }
    // Singular names, and plural names WITHOUT /Download. v6 only ever asked
    // /Files/{id}/Download, never /Files/{id} — a store can answer one and not the
    // other, and the difference is a 404 we would have misread as final.
    for (const n of ['File', 'Files', 'Attachment', 'Document', 'Image', 'ImageFile', 'Scan']) {
      push(`/${n}/${id}`);
    }
    return paths;
  };

  if (!out.handles.length) {
    say('   no handle was found anywhere — there is nothing to resolve.');
  }
  // A handle the API gave a URL for is not a guess, so it goes first and it goes
  // alone: no shape list, just the address we were handed.
  out.handles.sort((a, b) => (b.downloadUrl ? 1 : 0) - (a.downloadUrl ? 1 : 0));
  for (const h of out.handles) {
    if (out.bytes.some(b => b.isFile)) break;
    say(`   handle ${h.id} — ${h.from}${h.parentRes ? ` (on ${h.parentRes} ${h.parentId})` : ''}`);
    if (h.downloadUrl) {
      for (const target of [h.downloadUrl, ...(h.token ? [`/Attachments/${encodeURIComponent(h.token)}/Download`] : [])]) {
        try {
          const r3 = await rentManager.getRaw(target, {});
          const size = r3.buffer ? r3.buffer.length : 0;
          const isFile = r3.ok && size > 0 && !/json/i.test(r3.contentType || '');
          out.bytes.push({ path: target, status: r3.status, contentType: r3.contentType, size, isFile, handle: h.from, fromUrl: true });
          say(`   ${isFile ? '✓' : (r3.ok ? '⚑' : '·')} ${String(target).slice(0, 110)} → ${r3.status} ${r3.contentType || '(no type)'} ${size} bytes`);
          if (isFile) { say(`      ⇒ THIS IS THE ONE — ${h.name || 'the file'} came back, ${size} bytes.`); break; }
        } catch (err) {
          out.bytes.push({ path: String(target).slice(0, 160), error: String(err.message || err).slice(0, 160), handle: h.from });
          say(`   · ${String(target).slice(0, 110)} → ${String(err.message || err).slice(0, 100)}`);
        }
      }
      if (out.bytes.some(b => b.isFile)) break;
    }
    for (const p2 of shapesFor(h)) {
      if (out.bytes.some(b => b.path === p2)) continue;
      try {
        const r2 = await rentManager.getRaw(p2, {});
        const size = r2.buffer ? r2.buffer.length : 0;
        const isFile = r2.ok && size > 0 && !/json/i.test(r2.contentType || '');
        out.bytes.push({ path: p2, status: r2.status, contentType: r2.contentType, size, isFile, handle: h.from });
        // A 200 that is JSON is not the file, but it is not nothing either: it means
        // the route EXISTS, which is the one thing every other line here rules out.
        const note = isFile ? '' : (r2.ok ? '  ← 200, but JSON, not the file' : '');
        say(`   ${isFile ? '✓' : (r2.ok ? '⚑' : '·')} ${p2} → ${r2.status} ${r2.contentType || '(no type)'} ${size} bytes${note}`);
        if (isFile) { say('      ⇒ THIS IS THE ONE — the file came back.'); break; }
      } catch (err) {
        out.bytes.push({ path: p2, error: String(err.message || err).slice(0, 160), handle: h.from });
      }
    }
  }
  // A file store addressed by query rather than by path.
  if (!out.bytes.some(b => b.isFile)) {
    const fileHandle = out.handles.find(h => h.isFileId || h.fileId != null);
    const fid2 = fileHandle ? (fileHandle.fileId != null ? fileHandle.fileId : fileHandle.id) : null;
    if (fid2 != null) {
      for (const n of ['Files', 'Documents', 'Attachments', 'HistoryAttachments']) {
        const q = await tryGet(`/${n}`, { filters: `FileID,eq,${fid2}`, pageSize: 1 });
        out.bytes.push({ path: `/${n}?filters=FileID,eq,${fid2}`, status: q.status, query: true, rows: q.ok ? q.rows.length : null });
        say(`   ${q.ok && q.rows.length ? '⚑' : '·'} /${n}?filters=FileID,eq,${fid2} → ${q.ok ? `${q.rows.length} row(s)` : (q.status || 'error')}`);
      }
    }
  }
  const anyRouteExists = out.bytes.some(b => !b.query && b.status === 200);
  out.anyRouteExists = anyRouteExists;
  say(anyRouteExists
    ? '   → at least one route EXISTS (200) even though it did not hand over bytes.'
    : '   → every route to the file itself returns 404, on every handle we hold.');

  // ── 5. From a payment to the invoice it paid ──────────────────────────────
  // The question that decides whether this is an email to Rent Manager or a
  // process change at our end, 2026-08-26.
  //
  // Renovation postings here are CHECK ITEMS. When the description names the
  // vendor's invoice number we find the bill and the scan on it. When it says
  // "Cabinets Refinish" instead, we have no way to name the invoice — about
  // 11,000 charges. The desktop client knows: a check shows the bills it paid.
  // If the API will hand over that link, those charges are reachable in code and
  // nobody has to change how they type. If it will not, that is a concrete,
  // answerable thing to ask support for.
  //
  // Same question for card charges: a card charge is not a bill, so is its
  // receipt reachable at all?
  say('');
  say('5. Can a payment tell us which invoice it paid?');
  out.paymentToBill = [];
  const noteLink = (how, r, extra) => {
    const rec = { how, ok: !!r.ok, status: r.status || null, ...(extra || {}) };
    out.paymentToBill.push(rec);
    say(`   ${rec.hit ? '✓' : '·'} ${how} → ${r.ok ? (rec.count != null ? `200, ${rec.count} item(s)` : '200') : (r.status || 'error')}`);
    return rec;
  };

  // A check to start from. Prefer one the API hands back rather than a guess.
  let checkId = null;
  const chk = await tryGet('/Checks', { pageSize: 1 });
  if (chk.ok && chk.rows.length) checkId = chk.rows[0].ID ?? chk.rows[0].CheckID ?? chk.rows[0].Id;
  if (checkId == null) {
    say('   · no check to test against');
  } else {
    say(`   starting from check ${checkId}`);
    // The collection names a check might expose its distribution under.
    for (const emb of ['Bills', 'BillDetails', 'CheckDetails', 'Distributions', 'Allocations',
      'Applications', 'Charges', 'OpenAmounts', 'Payments', 'PaymentDetails', 'Invoices']) {
      const r = await tryGet(`/Checks/${encodeURIComponent(checkId)}`, { embeds: emb });
      const row = r.ok ? (r.rows.length ? r.rows[0] : r.body) : null;
      const got = row && row[emb];
      const n = Array.isArray(got) ? got.length : (got ? 1 : 0);
      noteLink(`GET /Checks/${checkId}?embeds=${emb}`, r,
        { count: r.ok ? n : null, hit: n > 0, fields: n && Array.isArray(got) ? Object.keys(got[0]) : [] });
    }
    // And the same link asked from the other end.
    for (const [res, col] of [['Bills', 'CheckID'], ['Bills', 'PaymentID'], ['BillDetails', 'CheckID'],
      ['Payments', 'CheckID'], ['CheckDetails', 'CheckID'], ['Distributions', 'CheckID']]) {
      const r = await tryGet(`/${res}`, { filters: `${col},eq,${checkId}`, pageSize: 5 });
      noteLink(`GET /${res}?filters=${col},eq,${checkId}`, r,
        { count: r.ok ? r.rows.length : null, hit: r.ok && r.rows.length > 0 });
    }
  }

  // Card charges: a different record type entirely, and 3,555 of our postings.
  say('');
  say('5b. Is a credit card charge reachable, and does it carry its receipt?');
  out.cardCharge = [];
  for (const res of ['CreditCardCharges', 'CreditCards', 'CardCharges', 'CardTransactions',
    'CreditCardTransactions', 'CreditCardStatements', 'Charges']) {
    const r = await tryGet(`/${res}`, { pageSize: 1 });
    const rec = { resource: res, ok: !!r.ok, status: r.status || null, fields: r.ok ? r.fields : [] };
    out.cardCharge.push(rec);
    say(`   ${r.ok ? '✓' : '·'} /${res} → ${r.ok ? `200; fields: ${r.fields.slice(0, 10).join(', ')}` : (r.status || 'error')}`);
    if (!r.ok || !r.rows.length) continue;
    const id = r.rows[0].ID ?? r.rows[0].Id ?? r.rows[0][`${res.replace(/s$/, '')}ID`];
    if (id == null) continue;
    const e = await tryGet(`/${res}/${encodeURIComponent(id)}`, { embeds: 'Attachments' });
    const row = e.ok ? (e.rows.length ? e.rows[0] : e.body) : null;
    const n = row && Array.isArray(row.Attachments) ? row.Attachments.length : null;
    rec.attachmentsEmbed = e.ok ? (n == null ? 'accepted, no Attachments field' : `${n} item(s)`) : `${e.status || 'error'}`;
    say(`      embeds=Attachments → ${rec.attachmentsEmbed}`);
  }

  // ── 5c. Close the two links, against records we actually care about ───────
  // Pass 5 found the doors; this checks they open. Both matter because they are
  // the difference between 27% coverage and something much higher:
  //
  //   a check item  → /CheckDetails gives a BillDetailID → but can a BillDetailID
  //                   be resolved to the BILL that carries the scan?
  //   a card charge → /CreditCardTransactions takes an Attachments embed, but is
  //                   the id on OUR postings the id that resource uses?
  //
  // Tested against real renovation postings rather than the first row of a table:
  // four runs were wasted earlier concluding things from an arbitrary record.
  say('');
  say('5c. Do those links actually reach a document?');
  out.links = [];
  const link = (how, r, extra) => {
    const rec = { how, ok: !!r.ok, status: r.status || null, ...(extra || {}) };
    out.links.push(rec);
    say(`   ${rec.hit ? '✓' : '·'} ${how} → ${r.ok ? '200' : (r.status || 'error')}${rec.note ? ` — ${rec.note}` : ''}`);
    return rec;
  };
  let charges = [];
  try {
    const snap = require('./renovationExpenses').status().cache;
    charges = (snap && snap.data && snap.data.charges) || [];
  } catch (err) { /* no snapshot — fall back to whatever the API hands back */ }

  const aCheck = charges.find(c => c.txnType === 'CHKITM' && c.txnId && !c.invoiceNo);
  if (!aCheck) say('   · no check-item posting without an invoice number to test with');
  else {
    say(`   a real posting with no invoice number: check ${aCheck.txnId}, ${aCheck.vendor || ''} $${aCheck.amount}`);
    const cd = await tryGet('/CheckDetails', { filters: `CheckID,eq,${aCheck.txnId}`, pageSize: 25 });
    const rows = cd.ok ? cd.rows : [];
    link(`/CheckDetails?filters=CheckID,eq,${aCheck.txnId}`, cd,
      { count: rows.length, hit: rows.length > 0, note: rows.length ? `${rows.length} line(s)` : 'no lines' });
    const bdId = rows.map(r => r.BillDetailID).find(v => v != null);
    if (bdId == null) say('   · no BillDetailID on those lines — the trail stops here');
    else {
      say(`   BillDetailID ${bdId} — now: can that be resolved to a bill?`);
      for (const [path, params] of [
        [`/BillDetails/${encodeURIComponent(bdId)}`, {}],
        [`/BillDetails/${encodeURIComponent(bdId)}`, { embeds: 'Bill' }],
        ['/BillDetails', { filters: `BillDetailID,eq,${bdId}`, pageSize: 5 }],
        ['/Bills', { filters: `BillDetailID,eq,${bdId}`, pageSize: 5 }],
      ]) {
        const r = await tryGet(path, params);
        const row = r.ok ? (r.rows.length ? r.rows[0] : r.body) : null;
        const billId = row && (row.BillID ?? row.BillId ?? (row.Bill && (row.Bill.ID ?? row.Bill.BillID)));
        link(`${path}${params.filters ? `?filters=${params.filters}` : params.embeds ? `?embeds=${params.embeds}` : ''}`,
          r, { hit: billId != null, billId: billId ?? null,
            note: billId != null ? `BillID ${billId}` : (r.ok ? `200, fields: ${row ? Object.keys(row).slice(0, 8).join(', ') : 'none'}` : '') });
        if (billId != null) {
          // The whole point: does THAT bill carry a scan?
          const b = await tryGet(`/Bills/${encodeURIComponent(billId)}`, { embeds: 'Attachments' });
          const brow = b.ok ? (b.rows.length ? b.rows[0] : b.body) : null;
          const n = brow && Array.isArray(brow.Attachments) ? brow.Attachments.length : null;
          link(`/Bills/${billId}?embeds=Attachments`, b,
            { hit: !!n, note: n == null ? 'no Attachments field' : `${n} attachment(s)` });
          break;
        }
      }
    }
  }

  const aCard = charges.find(c => c.txnType === 'CC CHG' && c.txnId);
  if (!aCard) say('   · no card posting to test with');
  else {
    say(`   a real card posting: txn ${aCard.txnId}, ${aCard.vendor || ''} $${aCard.amount}`);
    const r = await tryGet(`/CreditCardTransactions/${encodeURIComponent(aCard.txnId)}`, { embeds: 'Attachments' });
    const row = r.ok ? (r.rows.length ? r.rows[0] : r.body) : null;
    const n = row && Array.isArray(row.Attachments) ? row.Attachments.length : null;
    const same = row && String(row.ID ?? row.Id ?? '') === String(aCard.txnId);
    link(`/CreditCardTransactions/${aCard.txnId}?embeds=Attachments`, r,
      { hit: !!n, sameRecord: !!same,
        note: !r.ok ? '' : `${same ? 'same record' : 'DIFFERENT record — the id does not mean the same thing'}, ${n == null ? 'no Attachments field' : `${n} attachment(s)`}` });
    if (n) {
      const a = row.Attachments[0];
      // The FIELD NAMES matter more than the values here. A bill's attachment
      // arrives with a DownloadURL, which is the only thing on this instance that
      // returns bytes. If a card charge's attachment carries something else, the
      // receipt is listed but not openable, and that distinction is the whole
      // answer for 3,555 postings.
      say(`      ⚑ fields: ${Object.keys(a).join(', ')}`);
      say(`      ⚑ ${a.Name || '(no name)'}${a.Extension || ''} — DownloadURL ${a.DownloadURL ? 'present' : 'absent'}`);
      out.cardAttachmentSample = { fields: Object.keys(a), name: a.Name || null,
        extension: a.Extension || null, hasUrl: !!a.DownloadURL,
        fileId: a.FileID ?? a.AttachmentID ?? a.ID ?? null };
      // Ask the record for itself rather than through the embed — an embed can
      // return a thinner projection than the resource does.
      const aid = a.FileID ?? a.AttachmentID ?? a.ID;
      if (aid != null) {
        for (const path of [`/CreditCardTransactions/${encodeURIComponent(aCard.txnId)}/Attachments`,
          `/Attachments/${encodeURIComponent(aid)}`]) {
          const r2 = await tryGet(path, {});
          const row2 = r2.ok ? (r2.rows.length ? r2.rows[0] : r2.body) : null;
          link(path, r2, { hit: !!(row2 && (row2.DownloadURL || (Array.isArray(row2) && row2[0]))),
            note: r2.ok && row2 ? `fields: ${Object.keys(row2).slice(0, 12).join(', ')}` : '' });
        }
      }
    }

    // Can a BillDetailID be resolved by indexing from the BILL side instead?
    // /BillDetails/{id} is a 404, but a bill will list its own detail lines, and
    // only bills that CARRY a scan are worth indexing. If those lines carry a
    // BillDetailID, the check-item trail closes without Rent Manager changing
    // anything.
    const anyBill = out.bill && out.bill.id;
    if (anyBill) {
      const r3 = await tryGet(`/Bills/${encodeURIComponent(anyBill)}`, { embeds: 'BillDetails' });
      const row3 = r3.ok ? (r3.rows.length ? r3.rows[0] : r3.body) : null;
      const det = row3 && Array.isArray(row3.BillDetails) ? row3.BillDetails : null;
      link(`/Bills/${anyBill}?embeds=BillDetails`, r3,
        { hit: !!(det && det.length && det[0].BillDetailID != null),
          note: det && det.length ? `${det.length} line(s); fields: ${Object.keys(det[0]).slice(0, 8).join(', ')}` : 'no lines' });
    }
  }

  const gotBytes = out.bytes.some(b => b.isFile);

  const anyEmbed = out.embeds.some(e => e.ok && e.count);
  // History, notes and user-defined fields answering is a LEAD, not a document
  // store — they record that a document exists, they are not the store itself. The
  // distinction decides which question support gets asked, so it is drawn here
  // rather than left to whoever reads the output.
  const NOT_A_STORE = ['History', 'HistoryNotes', 'Notes', 'UserDefinedFields'];
  const docStores = reachable.filter(n => !NOT_A_STORE.includes(n));
  const anyDocResource = docStores.length > 0;
  const anyParentDoc = out.parents.some(p2 => p2.found);

  const verdict = gotBytes
    ? { level: 'yes', headline: 'This Rent Manager CAN hand over the file.',
        detail: `The invoice came back from ${(out.bytes.find(b => b.isFile) || {}).path}. Nothing further is needed from Rent Manager — this is ours to wire in.` }
    : historyLead && !anyDocResource && !anyEmbed && !anyParentDoc
      ? { level: 'lead',
          headline: `No document resource exists here — but /${historyLead.resource} does, and it knows about files.`,
          detail: `Every attachment-shaped resource 404s, so there is no document store to call directly. What answers is history: /${historyLead.resource} came back carrying ${historyLead.fileish.length ? `file-shaped fields (${historyLead.fileish.join(', ')})` : `an embed with documents in it (${historyLead.embedHits.map(h => h.embed).join(', ')})`}. In the desktop client a scanned invoice hangs off a history record, so that is the thread to pull — and it is a far more specific question for support than "attachments do not work".` }
    : (anyDocResource || anyEmbed || anyParentDoc)
      ? { level: 'partial',
          headline: anyParentDoc
            ? 'Documents ARE reachable in this account — just not the file bytes yet.'
            : 'A document resource answers, but no route returned the file itself.',
          detail: anyParentDoc
            ? `A document came back on ${(out.parents.find(p2 => p2.found) || {}).why}, so the store exists and this API can see it. What is left is either the bill side specifically, or how we ask for the file itself — a far narrower question for support than "attachments do not work".`
            : 'That is a much narrower question for Rent Manager support than "attachments do not work" — the store is there, and something about how we ask for the bytes is wrong.' }
      : { level: 'no', headline: 'No document store is reachable on this instance, under any name we know.',
            detail: 'Bills, vendors and payments all read fine in the same run, so this is about the document store specifically — not about our credentials or our connection. That is the question for Rent Manager support.' };

  return {
    ranAt: new Date().toISOString(),
    tookMs: Date.now() - t0,
    verdict,
    gotBytes,
    anyDocResource,
    anyEmbed,
    reachable,
    ...out,
    transcript,
    supportText: supportTextFor(out),
  };
}

// ── the message to Rent Manager ─────────────────────────────────────────────
// Composed from what actually happened, so it cannot describe a request nobody
// made. Their support has a named agent for this account; this is short enough to
// answer in one reply.
function supportTextFor(out) {
  const L = [];
  const hist = (out.history || []).filter(h => h.fields && h.fields.length);
  L.push('We integrate with Rent Manager through the WAPI12 REST API and read bills, bill');
  L.push('details, vendors and payments without any trouble. What we cannot reach is the');
  L.push('DOCUMENT / ATTACHMENT store — the invoice scans our staff open in the Rent Manager');
  L.push('client. Exactly what we requested and exactly what came back:');
  L.push('');
  for (const r of out.resources.filter(x => !x.control)) {
    L.push(`  GET /${r.name}?pageSize=1  ->  ${r.ok ? `200, ${r.rows} row(s)` : `${r.status || 'error'}${r.verdict ? ` (${r.verdict})` : ''}`}`);
  }
  if (out.bill) {
    L.push('');
    for (const e of out.embeds) {
      L.push(`  GET /Bills/${out.bill.id}?embeds=${e.embed}  ->  ${e.ok ? (e.count ? `200, ${e.count} item(s)` : '200, no collection returned') : `${e.status || 'error'}`}`);
    }
  }
  if (out.parents && out.parents.length) {
    L.push('');
    L.push('  We also checked whether documents hang off anything other than a bill:');
    for (const p2 of out.parents) {
      L.push(`  GET /Attachments?filters=ParentType,eq,${p2.type};ParentID,eq,${p2.id}  ->  ${p2.filterOk ? `200, ${p2.filterRows} row(s)` : `${p2.filterStatus || 'error'}`}`);
    }
  }
  if (out.bytes.length) {
    L.push('');
    for (const b of out.bytes) L.push(`  GET ${b.path}  ->  ${b.error ? b.error : `${b.status} ${b.contentType || ''} ${b.size} bytes`}`);
  }
  L.push('');
  L.push('  Control — these work, so the credentials and the connection are fine:');
  for (const r of out.resources.filter(x => x.control)) {
    L.push(`  GET /${r.name}?pageSize=1  ->  ${r.ok ? `200, ${r.rows} row(s)` : `${r.status || 'error'}`}`);
  }
  if (hist.length) {
    L.push('');
    L.push('  Notably, HISTORY does answer, and in the desktop client a scanned invoice hangs');
    L.push('  off a history record. These are the fields a history row actually returned:');
    for (const h of hist) {
      L.push(`  /${h.resource} row ${h.id}: ${h.fields.join(', ')}`);
      if (h.fileish.length) L.push(`     (file-shaped fields we noticed: ${h.fileish.join(', ')})`);
      if (h.embedHits && h.embedHits.length) L.push(`     (embeds that returned something: ${h.embedHits.map(e => `${e.embed} × ${e.count}`).join(', ')})`);
      for (const f of (h.followed || [])) {
        L.push(`     ${f.how}  ->  ${f.ok === false || f.status ? `${f.status || 'error'}` : (f.count != null ? `${f.count} item(s)` : `${f.rows} row(s)`)}${f.fields && f.fields.length ? `; fields: ${f.fields.join(', ')}` : ''}`);
      }
    }
  }
  if (out.chain && out.chain.length) {
    L.push('');
    L.push('  And whether a BILL can reach its history record, and that record its file:');
    for (const c of out.chain) {
      L.push(`  ${c.how}  ->  ${c.status ? c.status : (c.count != null ? `${c.count} item(s)` : `${c.rows} row(s)`)}${c.fields && c.fields.length ? `; fields: ${c.fields.join(', ')}` : ''}`);
    }
  }
  if (out.withFiles && out.withFiles.length) {
    L.push('');
    L.push('  We also looked for a record that actually HAS a file attached, so that an');
    L.push('  empty attachment list could not be mistaken for a broken call:');
    for (const w of out.withFiles) {
      L.push(`  GET /${w.res}?filters=${w.filter}  ->  ${w.ok ? `200, ${w.rows} row(s)` : `${w.status || 'error'}`}`);
    }
  }
  if (out.handles && out.handles.length) {
    L.push('');
    L.push('  That search DID find one. The record and the attachment row it returned:');
    for (const h of out.handles) {
      L.push(`  ${h.from}  ->  id ${h.id}${h.parentRes ? ` on ${h.parentRes} ${h.parentId}` : ''}${h.fileId != null ? `, FileID ${h.fileId}` : ''}`);
    }
    L.push('');
    L.push('  The attachment row exists but carries no filename and no content, so we then');
    L.push('  tried every route we could construct to the file itself, using that id and the');
    L.push('  record it belongs to:');
    const shown = out.bytes.filter(b => !b.query).slice(0, 40);
    for (const b of shown) {
      L.push(`  GET ${b.path}  ->  ${b.error ? b.error : `${b.status}${b.size ? `, ${b.size} bytes, ${b.contentType}` : ''}`}`);
    }
    const q = out.bytes.filter(b => b.query);
    if (q.length) {
      L.push('');
      L.push('  And by query rather than by path:');
      for (const b of q) L.push(`  GET ${b.path}  ->  ${b.status === 200 || b.rows != null ? `200, ${b.rows} row(s)` : (b.status || 'error')}`);
    }
  }
  L.push('');
  L.push('Questions:');
  L.push('  1. Is the document / attachment store exposed through WAPI12 on our version at');
  L.push('     all? If so, under which resource, and with which parameters? Every name we');
  L.push('     tried returns 404.');
  if (hist.length) {
    if (out.handles && out.handles.length) {
      L.push('  2. This is the specific one. GET /HistoryNotes?filters=FileID,gt,0 returns rows,');
      L.push('     and asking one of those records for embeds=HistoryAttachments returns an');
      L.push('     attachment row with HistoryAttachmentID, HistoryID and FileID on it. So the');
      L.push('     API can already tell us a file exists and give us its id. What is the exact');
      L.push('     call that turns that HistoryAttachmentID (or that FileID) into the file');
      L.push('     itself? That single call is the whole thing we are missing.');
    } else {
      L.push('  2. /History and /HistoryNotes DO answer for us. In the desktop client a scanned');
      L.push('     invoice attaches to a history record — can the attached file be reached');
      L.push('     through those resources (an embed, a sub-resource, a file id we can then');
      L.push('     download), and what is the exact call?');
    }
  } else {
    L.push('  2. Is there another resource that carries the file we have not thought to try?');
  }
  L.push('  3. Does this differ between Rent Manager Online and Rent Manager Express?');
  L.push('  4. Our API user was granted administrator rights — is there a SEPARATE');
  L.push('     permission for document access that also has to be granted? A 404 rather than');
  L.push('     a 403 suggests the resource is absent rather than forbidden, but we would');
  L.push('     rather rule it out.');
  L.push('  5. If attachments are not exposed as a resource at all, is there a supported way');
  L.push('     to retrieve the invoice document for a bill — a report, a document endpoint,');
  L.push('     or an export we can call?');
  return L.join('\n');
}

// ── cache ───────────────────────────────────────────────────────────────────
// ~40 GETs a run, so a button press does not get to spend that every time it is
// clicked. The answer only changes when Rent Manager changes something (a
// permission, a version), which is not a per-minute event.
const TTL_MS = 30 * 60 * 1000;
let _cache = null;
let _inflight = null;

function getCached() { return _cache && Date.now() - Date.parse(_cache.ranAt) < TTL_MS ? _cache : null; }

async function run({ force = false, days, billId } = {}) {
  if (!force) {
    const hit = getCached();
    if (hit) return { ...hit, cached: true };
  }
  if (_inflight) return _inflight;   // a second click joins the first run
  _inflight = probe({ days, billId })
    .then(r => { _cache = r; return r; })
    .finally(() => { _inflight = null; });
  return _inflight;
}

module.exports = { VERSION, run, probe, supportTextFor, DOC_RESOURCES, CONTROL_RESOURCES, BILL_EMBEDS, DOWNLOADS, TTL_MS };
