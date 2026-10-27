// Rent Manager emulation: Service Manager (work orders) and history notes.
const m = require('../rmModel');
const { collection } = require('../rmQuery');

function register(router, world) {
  const dt = d => (d ? `${d}T00:00:00` : null);
  const issueRows = () => m.ISSUES.map(i => {
    const st = m.STATUSES.find(s => s.name === i.status);
    return {
      ServiceManagerIssueID: i.id, Title: i.title, Description: i.description,
      AssignedOpenDate: dt(i.opened), CreateDate: dt(i.created), CloseDate: dt(i.closed), AssignedCloseDate: dt(i.closed),
      IsClosed: st.closed, StatusID: st.id, PriorityID: m.pid(i.priority), CategoryID: m.cid(i.category),
      AssignedToUserID: i.assignedTo || 0,
      // the property / unit link only comes back as an embed, as in the real API
      __propertyId: i.propertyId, __unitId: i.unitId,
    };
  });
  const embedIssue = (r, e) => {
    const out = { ...r };
    if (e.has('Properties')) { const p = world.propertyById.get(r.__propertyId); out.Properties = [{ PropertyID: p.id, Name: p.name, ShortName: p.name }]; }
    if (e.has('Units')) { const u = r.__unitId ? world.unitById.get(r.__unitId) : null; out.Units = u ? [{ UnitID: u.id, Name: u.name, PropertyID: u.propertyId }] : []; }
    delete out.__propertyId; delete out.__unitId;
    return out;
  };
  const clean = rows => rows.map(r => { const o = { ...r }; delete o.__propertyId; delete o.__unitId; return o; });
  router.get('/ServiceManagerIssues', ({ query }) => {
    const out = collection(issueRows(), query, { embed: embedIssue });
    return clean(out);
  });
  router.get(/^\/ServiceManagerIssues\/(\d+)$/i, ({ query, match }) =>
    clean(collection(issueRows().filter(r => r.ServiceManagerIssueID === Number(match[1])), query, { embed: embedIssue })));

  router.get('/ServiceManagerStatuses', ({ query }) => collection([{ ServiceManagerStatusID: 0, Name: '<Unassigned>' }]
    .concat(m.STATUSES.map(s => ({ ServiceManagerStatusID: s.id, Name: s.name, IsClosed: s.closed }))), query));
  router.get('/ServiceManagerPriorities', ({ query }) => collection([{ ServiceManagerPriorityID: 0, Name: '<Unassigned>' }]
    .concat(m.PRIORITIES.map(p => ({ ServiceManagerPriorityID: p.id, Name: p.name }))), query));
  router.get('/ServiceManagerCategories', ({ query }) => collection([{ ServiceManagerCategoryID: 0, Name: '<Unassigned>' }]
    .concat(m.CATEGORIES.map(c => ({ ServiceManagerCategoryID: c.id, Name: c.name }))), query));

  router.get('/HistoryNotes', ({ query }) => collection(m.HISTORY_NOTES, query));
  router.get(/^\/HistoryNotes\/(\d+)$/i, ({ query, match }) =>
    collection(m.HISTORY_NOTES.filter(h => h.HistoryID === Number(match[1])), query));
}
module.exports = { register };
