// Lookup tools for the Ask panel (2026-10-20): Claude can read the site's data
// beyond the page that is open — any building's P&L, delinquency, budgets, work
// orders, renovation spend, the postings behind a line.
//
// Every tool reads the snapshot its tab already serves from data/ — none of them
// starts a Rent Manager pull — except gl_postings, which runs the same Report 51
// the Variances card runs when you open a flag. Each tool is guarded by the same
// access rule as its tab's route (services/accessControl.js), checked twice: a
// tool the person cannot use is never offered, and is refused if asked for.
//
// `sources` is passed in by server.js (some caches are server.js locals) and by
// scripts/checkAssistantTools.js with stand-ins, so this file never touches disk.

const accessControl = require('./accessControl');
const varianceConfig = require('./varianceConfig');
const { CATEGORY_REFS } = require('./propertyFinancials');

const MAX_RESULT_CHARS = 40000;
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const MON_NAMES = Object.keys(MON);

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const round = v => (v == null || !Number.isFinite(v)) ? null : Math.round(v * 100) / 100;
const sum = arr => arr.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
const unwrap = c => (c && c.data !== undefined && c.refreshedAt !== undefined ? c.data : c);
const asOf = c => (c && (c.refreshedAt || c.generatedAt || c.asOf)) || null;

class ToolError extends Error {}

// 'Oct 26' ↔ '2026-10'. The P&L months are labels; people and Claude say either.
function ymFromLabel(label) {
  const [m, yy] = String(label).split(' ');
  return MON[m] && yy ? `20${yy}-${String(MON[m]).padStart(2, '0')}` : null;
}
function monthIdx(labels, m) {
  if (m == null || m === '') return -1;
  const s = String(m).trim();
  const ym = /^\d{4}-\d{2}$/.test(s) ? s : (() => {
    const hit = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+'?(\d{2}|\d{4})$/);
    if (!hit) return null;
    const mon = hit[1][0].toUpperCase() + hit[1].slice(1, 3).toLowerCase();
    return MON[mon] ? `${hit[2].length === 2 ? '20' + hit[2] : hit[2]}-${String(MON[mon]).padStart(2, '0')}` : null;
  })();
  return ym ? labels.findIndex(l => ymFromLabel(l) === ym) : -1;
}
function monthWindow(labels, from, to, defaultCount) {
  const last = labels.length - 1;
  let end = to ? monthIdx(labels, to) : last;
  if (to && end < 0) throw new ToolError(`Month "${to}" is not in the P&L window (${labels[0]} to ${labels[last]}). Use YYYY-MM.`);
  let start = from ? monthIdx(labels, from) : Math.max(0, end - (defaultCount - 1));
  if (from && start < 0) throw new ToolError(`Month "${from}" is not in the P&L window (${labels[0]} to ${labels[last]}). Use YYYY-MM.`);
  if (start > end) [start, end] = [end, start];
  return { start, end };
}

// ── P&L scope and line resolution ─────────────────────────────────────────────
function plOrFail(sources) {
  const pl = sources.loadPL();
  if (!pl || !Array.isArray(pl.months)) throw new ToolError('The P&L snapshot has not been built yet. It fills on the next refresh.');
  return pl;
}
// 'portfolio' | an entity name | a property id or name (one match, or a list to choose from).
function resolveScope(pl, scope) {
  const s = String(scope || '').trim();
  if (!s || /^portfolio$/i.test(s) || /^all$/i.test(s)) return { kind: 'portfolio', label: 'Portfolio', series: pl.portfolio || {} };
  const entity = Object.keys(pl.entities || {}).find(e => norm(e) === norm(s));
  if (entity) return { kind: 'entity', label: entity, entity, series: pl.entities[entity] };
  const props = pl.properties || {};
  const id = s.replace(/^prop:/i, '');
  if (props[id]) return { kind: 'property', label: props[id].name, id, entity: props[id].entity, series: props[id] };
  const entries = Object.entries(props);
  let hits = entries.filter(([, p]) => norm(p.name) === norm(s));
  if (!hits.length) hits = entries.filter(([, p]) => norm(p.name).includes(norm(s)) || (p.mergedFrom || []).some(m => norm(m.name).includes(norm(s))));
  if (hits.length === 1) { const [pid, p] = hits[0]; return { kind: 'property', label: p.name, id: pid, entity: p.entity, series: p }; }
  if (hits.length > 1) throw new ToolError(`"${s}" matches ${hits.length} properties: ${hits.slice(0, 15).map(([pid, p]) => `${p.name} (id ${pid}, ${p.entity})`).join('; ')}. Ask again with the id.`);
  throw new ToolError(`No entity or property called "${s}". Entities: ${Object.keys(pl.entities || {}).join(', ')}. Use list_properties to find a building.`);
}

function lineCatalog(pl) {
  const named = {};
  try { (varianceConfig.getConfig().items || []).forEach(i => { named[i.key] = i.label; }); } catch (e) { /* labels are a nicety */ }
  Object.assign(named, { waterSubWater: 'Water (5402-1)', waterSubSewer: 'Sewer (5402-2)', waterSubWaste: 'Solid Waste (5402-3)' });
  const meta = {};
  (pl.lineMeta || []).forEach(l => { if (l && l.key) meta[l.key] = l; });
  const keys = new Set([...(pl.categories || []), ...Object.keys(pl.portfolio || {})]);
  return [...keys].filter(k => Array.isArray((pl.portfolio || {})[k])).map(k => ({
    key: k,
    label: named[k] || (meta[k] && meta[k].label) || k,
    ref: meta[k] ? meta[k].ref : (CATEGORY_REFS[k] || []).join(', ') || undefined,
    group: meta[k] ? meta[k].group : undefined,
  }));
}
function resolveLine(pl, line) {
  const cat = lineCatalog(pl);
  const s = String(line || '').trim();
  const hit = cat.find(l => l.key === s) || cat.find(l => norm(l.key) === norm(s)) || cat.find(l => norm(l.label) === norm(s))
    || cat.find(l => l.ref && String(l.ref).split(', ').includes(s));
  if (hit) return hit;
  const near = cat.filter(l => norm(l.label).includes(norm(s)) || norm(l.key).includes(norm(s)));
  if (near.length === 1) return near[0];
  throw new ToolError(`No P&L line "${s}"${near.length ? `. Close: ${near.slice(0, 10).map(l => `${l.key} (${l.label})`).join(', ')}` : ''}. Call pl_lines for the full list.`);
}

// ── The tools ─────────────────────────────────────────────────────────────────
// route: the API route whose access rule guards this tool.
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = description => ({ type: 'string', description });
const SCOPE = str('"portfolio", an entity name (e.g. "Willow Creek"), or a property name or id');

const TOOLS = [
  {
    name: 'list_properties',
    route: '/api/financials/property-monthly',
    description: 'List the buildings in the portfolio: property id, name, entity, unit count, and any split buildings merged into it. Filter by entity or by part of a name. Use this to find the exact building before other lookups.',
    input_schema: S({ entity: str('Only this entity'), query: str('Part of a building name or address') }),
    run(input, sources) {
      const pl = plOrFail(sources);
      const units = (sources.loadUnits() || {}).byProperty || {};
      let rows = Object.entries(pl.properties || {}).map(([id, p]) => ({
        id, name: p.name, entity: p.entity, units: units[id] != null ? units[id] : undefined,
        mergedFrom: p.mergedFrom ? p.mergedFrom.map(m => m.name) : undefined,
      }));
      if (input.entity) rows = rows.filter(r => norm(r.entity) === norm(input.entity));
      if (input.query) rows = rows.filter(r => norm(r.name).includes(norm(input.query)) || (r.mergedFrom || []).some(n => norm(n).includes(norm(input.query))));
      rows.sort((a, b) => String(a.entity).localeCompare(String(b.entity)) || String(a.name).localeCompare(String(b.name)));
      return { entities: Object.keys(pl.entities || {}), count: rows.length, properties: rows };
    },
  },
  {
    name: 'pl_lines',
    route: '/api/financials/property-monthly',
    description: 'The P&L line catalog: every line key with its label and GL account. Call this when unsure which key a line has (e.g. "repairsMaint" for Repairs & Maint., "waterSewer", "propTax", "noi", "totalIncome").',
    input_schema: S({}),
    run(input, sources) {
      const pl = plOrFail(sources);
      return { months: `${pl.months[0]} to ${pl.months[pl.months.length - 1]}`, lines: lineCatalog(pl) };
    },
  },
  {
    name: 'pl_series',
    route: '/api/financials/property-monthly',
    description: 'Monthly P&L amounts (accrual, from Rent Manager) for one scope and one or more lines. Defaults to the last 13 months. Use for trends, a building\'s history, or checking a figure.',
    input_schema: S({
      scope: SCOPE,
      lines: { type: 'array', items: { type: 'string' }, description: 'Line keys or labels, e.g. ["noi"], ["repairsMaint","turnover"]' },
      from: str('First month, YYYY-MM (optional)'),
      to: str('Last month, YYYY-MM (optional)'),
    }, ['scope', 'lines']),
    run(input, sources) {
      const pl = plOrFail(sources);
      const sc = resolveScope(pl, input.scope);
      const lines = (input.lines || []).slice(0, 8).map(l => resolveLine(pl, l));
      if (!lines.length) throw new ToolError('Name at least one line.');
      const { start, end } = monthWindow(pl.months, input.from, input.to, 13);
      const months = pl.months.slice(start, end + 1);
      return {
        scope: sc.label, entity: sc.entity, asOf: pl.refreshedAt, basis: pl.basis || 'Accrual',
        note: pl.partialCurrentMonth ? `${pl.months[pl.months.length - 1]} is in progress (month to date).` : undefined,
        lines: lines.map(l => {
          const series = (sc.series[l.key] || []).slice(start, end + 1).map(round);
          return { key: l.key, label: l.label, total: round(sum(series)), byMonth: Object.fromEntries(months.map((m, i) => [m, series[i]])) };
        }),
      };
    },
  },
  {
    name: 'pl_rank',
    route: '/api/financials/property-monthly',
    description: 'Rank entities or buildings on one P&L line for one month, or summed over a range: each row has the amount, the month before, the same month last year, and the trailing-12 average. Use for "which buildings spent most on X", "who is worst on Y".',
    input_schema: S({
      line: str('Line key or label'),
      level: { type: 'string', enum: ['entity', 'property'], description: 'Rank entities or buildings' },
      month: str('YYYY-MM; defaults to the last closed month'),
      through: str('Optional YYYY-MM: rank on the sum from month through this month'),
      entity: str('With level=property, only this entity\'s buildings'),
    }, ['line', 'level']),
    run(input, sources) {
      const pl = plOrFail(sources);
      const line = resolveLine(pl, input.line);
      const last = pl.months.length - 1 - (pl.partialCurrentMonth ? 1 : 0);
      const gi = input.month ? monthIdx(pl.months, input.month) : last;
      if (gi < 0) throw new ToolError(`Month "${input.month}" is not in the P&L window (${pl.months[0]} to ${pl.months[pl.months.length - 1]}).`);
      const gj = input.through ? monthIdx(pl.months, input.through) : gi;
      if (gj < 0) throw new ToolError(`Month "${input.through}" is not in the P&L window.`);
      const [a, b] = gi <= gj ? [gi, gj] : [gj, gi];
      let rows = input.level === 'entity'
        ? Object.entries(pl.entities || {}).map(([e, s]) => ({ name: e, s }))
        : Object.entries(pl.properties || {}).map(([id, p]) => ({ name: p.name, id, entity: p.entity, s: p }));
      if (input.level === 'property' && input.entity) rows = rows.filter(r => norm(r.entity) === norm(input.entity));
      const out = rows.map(r => {
        const s = r.s[line.key] || [];
        const amount = sum(s.slice(a, b + 1));
        const t12 = s.slice(Math.max(0, a - 12), a);
        return {
          name: r.name, id: r.id, entity: r.entity, amount: round(amount),
          monthBefore: a > 0 ? round(s[a - 1]) : null,
          sameMonthLastYear: a >= 12 ? round(s[a - 12]) : null,
          trailing12Avg: t12.length ? round(sum(t12) / t12.length) : null,
        };
      }).filter(r => r.amount || r.monthBefore || r.trailing12Avg).sort((x, y) => (y.amount || 0) - (x.amount || 0));
      return { line: line.label, key: line.key, period: a === b ? pl.months[a] : `${pl.months[a]} to ${pl.months[b]}`, asOf: pl.refreshedAt, count: out.length, rows: out.slice(0, 60), truncated: out.length > 60 || undefined };
    },
  },
  {
    name: 'gl_postings',
    route: '/api/variance/gl-detail',
    live: true,
    description: 'The individual GL postings (bills, checks, card charges, credits, journal entries) behind a P&L line for a scope and month range: date, vendor, description, service period, invoice number, amount. Pulled live from Rent Manager (Report 51), so it takes several seconds; keep the window tight (one to three months, one building or entity). Works for the named lines only (repairsMaint, waterSewer, electric, heatingGas, propTax, insurance, payroll, turnover, mgmtFees, mortgage, etc.), not totals.',
    input_schema: S({
      scope: SCOPE,
      line: str('Line key, e.g. "repairsMaint"'),
      from: str('First month, YYYY-MM'),
      to: str('Last month, YYYY-MM (defaults to from)'),
    }, ['scope', 'line', 'from']),
    async run(input, sources) {
      const pl = plOrFail(sources);
      const line = resolveLine(pl, input.line);
      const lineRefs = CATEGORY_REFS[line.key];
      if (!lineRefs) throw new ToolError(`${line.label} is not a single GL line, so it has no postings list. Pick a named line (call pl_lines).`);
      const ymRe = /^\d{4}-\d{2}$/;
      const from = String(input.from || ''), to = String(input.to || input.from || '');
      if (!ymRe.test(from) || !ymRe.test(to)) throw new ToolError('Months must be YYYY-MM.');
      const span = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5)) - Number(from.slice(5));
      if (span < 0 || span > 5) throw new ToolError('Keep the window to six months or less, with from before to.');
      const sc = resolveScope(pl, input.scope);
      const raw = sources.loadRawPL() || pl;
      const ids = sc.kind === 'property' ? sources.idsFor(Number(sc.id)).map(String)
        : sc.kind === 'entity' ? Object.entries(raw.properties || {}).filter(([, p]) => p.entity === sc.entity).map(([id]) => id)
        : Object.keys(raw.properties || {});
      const members = pl.categoryMembers || raw.categoryMembers || {};
      const refs = [...new Set(lineRefs.flatMap(r => [String(r), ...(members[r] || []).map(String)]))];
      const [ty, tm] = to.split('-').map(Number);
      const payload = await sources.glDetail({
        propOwnerIds: ids.join(','), refs,
        startDate: `${from}-01`, endDate: `${to}-${String(new Date(ty, tm, 0).getDate()).padStart(2, '0')}`,
      });
      const postings = (payload.postings || []).map(p => ({
        date: p.date, type: p.txnType, vendor: p.vendor || undefined, description: p.description || undefined,
        servicePeriod: p.servicePeriod ? `${p.servicePeriod.from}–${p.servicePeriod.to}` : undefined,
        invoiceNo: p.invoiceNo || undefined, account: p.account, property: p.property, amount: round(p.amount),
      }));
      const sorted = postings.slice().sort((x, y) => Math.abs(y.amount || 0) - Math.abs(x.amount || 0));
      return {
        scope: sc.label, line: line.label, window: from === to ? from : `${from} to ${to}`, source: 'Rent Manager Report 51, live',
        totals: payload.totals, count: postings.length,
        postings: sorted.slice(0, 80), note: postings.length > 80 ? `Largest 80 of ${postings.length} shown.` : undefined,
      };
    },
  },
  {
    name: 'delinquency',
    route: '/api/delinquency',
    description: 'Current delinquency (Rent Manager report 85, current tenants, 5-day grace): totals, by entity, by building, and the largest balances with tenant name, unit and amount. Filter by entity or building.',
    input_schema: S({ entity: str('Only this entity'), property: str('Only this building (name)'), top: { type: 'integer', description: 'How many tenants to list (default 25, max 100)' } }),
    run(input, sources) {
      const d = sources.loadDelinquency();
      if (!d) throw new ToolError('The delinquency report has not been pulled yet.');
      let items = d.items || [];
      if (input.entity) items = items.filter(i => norm(i.entity) === norm(input.entity));
      if (input.property) items = items.filter(i => norm(i.property).includes(norm(input.property)));
      const filtered = Boolean(input.entity || input.property);
      const byProperty = Object.entries(d.byProperty || {}).map(([name, v]) => ({ name, entity: v.entity, amount: round(v.amount), tenants: v.tenants }))
        .filter(p => (!input.entity || norm(p.entity) === norm(input.entity)) && (!input.property || norm(p.name).includes(norm(input.property))))
        .sort((a, b) => b.amount - a.amount);
      const top = Math.min(Math.max(Number(input.top) || 25, 1), 100);
      return {
        asOf: d.asOf || d.refreshedAt, graceDays: d.graceDays,
        totals: filtered ? { amount: round(sum(items.map(i => i.amount))), tenants: items.length } : d.totals,
        byEntity: filtered ? undefined : d.byEntity,
        byProperty: byProperty.slice(0, 40),
        largest: items.slice(0, top).map(i => ({ tenant: i.tenant, unit: i.unit, property: i.property, entity: i.entity, amount: round(i.amount) })),
      };
    },
  },
  {
    name: 'collections',
    route: '/api/delinquency/cohorts',
    description: 'Collections by billing month: for each month, what was charged and what share was collected by month end, one and two months later, and to date — portfolio and by entity.',
    input_schema: S({ entity: str('Only this entity') }),
    run(input, sources) {
      const c = sources.loadCohorts();
      if (!c) throw new ToolError('Collections by billing month have not been built yet.');
      const pct = (b, k) => b && b.charged ? round(b[k] / b.charged * 100) : null;
      const row = b => b && { charged: round(b.charged), pctByMonthEnd: pct(b, 'm0'), pctPlus1: pct(b, 'm1'), pctPlus2: pct(b, 'm2'), pctToDate: pct(b, 'now') };
      return {
        goalPct: c.goalPct != null ? round(c.goalPct * 100) : undefined,
        months: (c.months || []).filter(m => m.current).map(m => {
          const cur = m.current;
          const b = input.entity ? Object.entries(cur.byEntity || {}).find(([e]) => norm(e) === norm(input.entity)) : null;
          return { month: m.label, mature: m.mature, ...(row(b ? b[1] : cur.totals) || {}) };
        }),
      };
    },
  },
  {
    name: 'occupancy',
    route: '/api/live-overview',
    description: 'Occupancy now (units, occupied, vacant by building and entity, plus monthly GPR) and the occupancy trend from daily snapshots.',
    input_schema: S({ entity: str('Only this entity') }),
    run(input, sources) {
      const o = sources.loadLiveOverview();
      if (!o) throw new ToolError('The occupancy snapshot has not been pulled yet.');
      const props = Object.entries(o.byProperty || {}).map(([name, p]) => ({
        name, entity: p.entity, units: p.total, occupied: p.occupied, vacant: p.vacant,
        occupancyPct: p.total ? round(p.occupied / p.total * 100) : null, gprMonthly: round(p.gpr),
      })).filter(p => !input.entity || norm(p.entity) === norm(input.entity)).sort((a, b) => (a.occupancyPct ?? 101) - (b.occupancyPct ?? 101));
      const hist = (sources.loadVacancyHistory() || []).slice(-12).map(h => {
        const t = input.entity ? Object.entries(h.byEntity || {}).find(([e]) => norm(e) === norm(input.entity)) : null;
        const v = t ? t[1] : h.totals || {};
        return { date: h.date, units: v.units, occupied: v.occupied, occupancyPct: v.units ? round(v.occupied / v.units * 100) : null };
      });
      const t = o.totals || {};
      return { asOf: o.refreshedAt, totals: input.entity ? undefined : { units: t.units, occupied: t.occupied, vacant: t.vacant, occupancyPct: t.occupancy, gprMonthly: round(t.gpr_monthly) }, byProperty: props.slice(0, 80), trend: hist };
    },
  },
  {
    name: 'budget',
    route: '/api/budget',
    description: 'The built 12-month budget for the portfolio or an entity: each budget line by month and for the full year, EGI, operating expense, NOI and cash flow, the base year it was built from, and actuals for months that have closed.',
    input_schema: S({ scope: str('"portfolio" or an entity name') }, ['scope']),
    run(input, sources) {
      const set = sources.loadBudget();
      if (!set) throw new ToolError('The budget set has not been built yet (Budget tab).');
      const key = Object.keys(set.entities || {}).find(e => norm(e) === norm(input.scope));
      const b = /^portfolio$/i.test(String(input.scope || '').trim()) || !input.scope ? set.portfolio : key ? set.entities[key] : null;
      if (!b) throw new ToolError(`No budget for "${input.scope}". Budgets exist for: portfolio, ${Object.keys(set.entities || {}).join(', ')}.`);
      const labels = {};
      ((set.config && set.config.lines) || []).forEach(l => { labels[l.key] = l.label; });
      const months = b.monthLabels || b.months || [];
      // A budget can run past twelve months; the tab reports it a year at a time
      // (Year 1, Year 2…), and so does this. Summing the whole horizon as one
      // "full year" overstated it threefold on a 36-month set.
      const years = (b.years || []).map(y => ({ label: y.label, months: y.months, egi: round(y.egi), opex: round(y.totalOpex), noi: round(y.noi), belowNoi: round(y.belowNoi), cashFlow: round(y.cashFlow) }));
      return {
        scope: key || 'Portfolio', generatedAt: set.generatedAt, horizonMonths: months.length, units: b.units, occupancyPct: b.occupancyPct, baseWindow: b.baseWindow,
        years,
        lines: Object.entries(b.lines || {}).map(([k, arr]) => ({
          key: k, label: labels[k] || k,
          byYear: Object.fromEntries((b.years || []).map(y => [y.label, round(y.lines ? y.lines[k] : null)])),
          byMonth: Object.fromEntries(months.map((m, i) => [m, round(arr[i])])),
        })),
        totalsByMonth: Object.fromEntries(Object.entries(b.totals || {}).map(([k, arr]) => [k, Object.fromEntries(months.map((m, i) => [m, round(arr[i])]))])),
        actuals: (b.actuals || []).map((a, i) => a && { month: months[i], income: round(a.income), opex: round(a.opex), noi: round(a.noi) }).filter(Boolean),
      };
    },
  },
  {
    name: 'work_orders',
    route: '/api/issues',
    description: 'Service issues / work orders from the last week\'s snapshot: counts by status, category and building, and the issues themselves (title, unit, category, priority, open/close dates, assignee).',
    input_schema: S({ entity: str('Only this entity'), property: str('Only this building (name)'), open_only: { type: 'boolean', description: 'Only issues not closed' } }),
    run(input, sources) {
      const snap = sources.loadIssues();
      if (!snap) throw new ToolError('The work-order snapshot has not been pulled yet.');
      let items = snap.items || [];
      if (input.entity) items = items.filter(i => norm(i.entity) === norm(input.entity));
      if (input.property) items = items.filter(i => norm(i.property).includes(norm(input.property)));
      if (input.open_only) items = items.filter(i => !i.closeDate);
      const count = key => Object.entries(items.reduce((m, i) => { const k = i[key] || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 25);
      return {
        window: `last ${snap.days || 7} days`, asOf: snap.refreshedAt || snap.cutoff, count: items.length,
        byStatus: count('status'), byCategory: count('category'), byProperty: count('property'),
        issues: items.slice(0, 60).map(i => ({ opened: i.openDate, closed: i.closeDate || undefined, status: i.status, title: i.title, property: i.property, unit: i.unit, category: i.category, priority: i.priority, assignedTo: i.assignedTo })),
      };
    },
  },
  {
    name: 'duplicate_payments',
    route: '/api/variance/duplicate-payments',
    description: 'Checks that expense a bill a second time (a hand-keyed check repeating a bill already entered): building, vendor, check, the bill it repeats, the duplicated amount and the accounts and service periods involved.',
    input_schema: S({ entity: str('Only this entity'), property: str('Only this building (name)') }),
    run(input, sources) {
      const d = sources.loadDuplicatePayments();
      if (!d) throw new ToolError('The duplicate-payment scan has not run yet.');
      let f = d.findings || [];
      if (input.property) f = f.filter(x => norm(x.property).includes(norm(input.property)));
      if (input.entity) f = f.filter(x => norm(x.entity || '').includes(norm(input.entity)) || norm(sources.entityOfProperty(x.propertyId) || '') === norm(input.entity));
      return {
        window: `${d.startDate} to ${d.endDate}`, count: f.length, total: round(sum(f.map(x => x.duplicateAmount))),
        note: 'Some may already be marked fixed on the Variances tab; the tab shows only open ones.',
        findings: f.slice(0, 50).map(x => ({
          property: x.property, vendor: x.vendor, check: x.check, bill: x.bill && { id: x.bill.id, date: x.bill.date, number: x.bill.invoiceNo || x.bill.reference },
          duplicateAmount: round(x.duplicateAmount), lines: (x.lines || []).map(l => ({ account: l.account, servicePeriod: l.servicePeriod, checkAmount: round(l.checkAmount), billAmount: round(l.billAmount) })),
        })),
      };
    },
  },
  {
    name: 'renovation_spend',
    route: '/api/renovations',
    description: 'Renovation (non-operating, capital) spend from the GL over the last 24 months, grouped by building, unit, vendor or month, with totals. Filter by entity, building or month range.',
    input_schema: S({
      group_by: { type: 'string', enum: ['property', 'unit', 'vendor', 'month'], description: 'How to group the spend' },
      entity: str('Only this entity'), property: str('Only this building (name)'),
      from: str('First month, YYYY-MM'), to: str('Last month, YYYY-MM'),
    }, ['group_by']),
    run(input, sources) {
      const r = sources.loadRenovations();
      if (!r) throw new ToolError('The renovation snapshot has not been built yet.');
      let ch = r.charges || [];
      if (input.entity) ch = ch.filter(c => norm(c.entity) === norm(input.entity));
      if (input.property) ch = ch.filter(c => norm(c.propertyName).includes(norm(input.property)));
      if (input.from) ch = ch.filter(c => String(c.month || c.date).slice(0, 7) >= input.from);
      if (input.to) ch = ch.filter(c => String(c.month || c.date).slice(0, 7) <= input.to);
      const keyOf = {
        property: c => c.propertyName, unit: c => `${c.propertyName} · ${c.unitName || 'no unit'}`,
        vendor: c => c.vendor || '(no vendor)', month: c => String(c.month || c.date).slice(0, 7),
      }[input.group_by];
      const groups = {};
      ch.forEach(c => { const k = keyOf(c); const g = (groups[k] ||= { name: k, amount: 0, charges: 0 }); g.amount += c.amount || 0; g.charges += 1; });
      const rows = Object.values(groups).map(g => ({ ...g, amount: round(g.amount) }));
      rows.sort(input.group_by === 'month' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.amount - a.amount);
      return { window: r.window ? `${r.window.fromYM} to ${r.window.toYM}` : undefined, total: round(sum(ch.map(c => c.amount))), charges: ch.length, groups: rows.slice(0, 60), truncated: rows.length > 60 || undefined };
    },
  },
  {
    name: 'debt_service',
    route: '/api/debt-service',
    description: 'Debt service this calendar year by building and entity: mortgage interest (P&L, GL 6230) and principal paid down on the mortgage loan accounts, with notes on anything that could not be read.',
    input_schema: S({ entity: str('Only this entity') }),
    run(input, sources) {
      const d = sources.loadDebtService();
      if (!d) throw new ToolError('Debt service is being rebuilt; it is ready a minute or two after the first request. Mortgage interest is also on the P&L (pl_series or pl_rank on "mortgage").');
      let rows = (d.by_property || []).slice();
      if (input.entity) rows = rows.filter(r => norm(r.entity) === norm(input.entity));
      return {
        window: `${d.from} to ${d.to}`, asOf: d.refreshedAt, sources: d.sources, notes: d.notes,
        refinancePayoffsLeftOut: (d.payoffs || []).map(p => ({ date: p.date, property: p.property, account: p.account, description: p.description, amount: round(p.amount) })),
        totals: input.entity ? undefined : { interest: round(d.interest), principal: round(d.principal), total: round(d.total) },
        byEntity: input.entity ? undefined : d.byEntity,
        byProperty: rows.sort((a, b) => b.total - a.total).slice(0, 80),
      };
    },
  },
  {
    name: 'move_activity',
    route: '/api/variance/move-activity',
    description: 'Move-ins and move-outs by month for the portfolio, an entity or a building.',
    input_schema: S({ scope: SCOPE, from: str('First month, YYYY-MM'), to: str('Last month, YYYY-MM') }, ['scope']),
    run(input, sources) {
      const m = sources.loadMoves();
      if (!m || !Array.isArray(m.months)) throw new ToolError('Move activity is still loading; it fills a few minutes after the site starts.');
      const sc = resolveScope({ ...plOrFail(sources) }, input.scope);
      const s = sc.kind === 'portfolio' ? m.portfolio : sc.kind === 'entity' ? (m.entities || {})[sc.entity] : (m.properties || {})[sc.id];
      if (!s) return { scope: sc.label, note: 'No move activity recorded for this scope.' };
      const { start, end } = monthWindow(m.months, input.from, input.to, 13);
      return { scope: sc.label, byMonth: m.months.slice(start, end + 1).map((mo, i) => ({ month: mo, moveIns: (s.moveIns || [])[start + i] || 0, moveOuts: (s.moveOuts || [])[start + i] || 0 })) };
    },
  },
  {
    name: 'variance_flags',
    route: '/api/variance/config',
    description: 'The open variance flags the Variances tab shows (computed in the person\'s browser when they asked): building or entity, P&L line, month, urgency, importance score, dollar impact and the detector\'s reading. Filter by entity, building or urgency.',
    input_schema: S({ entity: str('Only this entity'), property: str('Only this building (name)'), urgency: { type: 'string', enum: ['critical', 'high', 'watch', 'info'], description: 'Only this tier' } }),
    run(input, sources, ctx) {
      let f = Array.isArray(ctx.flags) ? ctx.flags : null;
      if (!f) throw new ToolError('No variance flags came with this question: the Variances data had not loaded in the browser yet.');
      if (input.entity) f = f.filter(x => norm(x.entity).includes(norm(input.entity)) || norm(x.scope).includes(norm(input.entity)));
      if (input.property) f = f.filter(x => norm(x.scope).includes(norm(input.property)));
      if (input.urgency) f = f.filter(x => x.urgency === input.urgency);
      return { count: f.length, flags: f.slice(0, 60) };
    },
  },
];

// The tools this person may use, as the Messages API wants them.
function toolsFor(user) {
  return TOOLS.filter(t => allowed(user, t)).map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}
function allowed(user, tool) {
  if (!user) return false;
  return accessControl.decide(user, 'GET', tool.route).ok;
}

// Small, schema-shaped checks: the API validates the JSON, this catches a wrong
// type before a tool trips over it, and is reported back to Claude as an error.
function validate(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Input must be an object.';
  const props = tool.input_schema.properties || {};
  for (const k of tool.input_schema.required || []) if (input[k] === undefined || input[k] === '') return `Missing "${k}".`;
  for (const [k, v] of Object.entries(input)) {
    const p = props[k];
    if (!p) return `Unknown field "${k}".`;
    if (v === null || v === undefined) continue;
    if (p.type === 'string' && typeof v !== 'string') return `"${k}" must be text.`;
    if (p.type === 'string' && v.length > 200) return `"${k}" is too long.`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}.`;
    if (p.type === 'integer' && !Number.isInteger(v)) return `"${k}" must be a whole number.`;
    if (p.type === 'boolean' && typeof v !== 'boolean') return `"${k}" must be true or false.`;
    if (p.type === 'array' && (!Array.isArray(v) || v.some(x => typeof x !== 'string'))) return `"${k}" must be a list of text.`;
  }
  return null;
}

// Runs one tool call. Always resolves to { content, isError } — a failure goes
// back to Claude as a tool error it can read and work around.
async function runTool(name, input, { user, sources, flags }) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return { content: `No tool called ${name}.`, isError: true };
  if (!allowed(user, tool)) return { content: 'This person does not have access to that data.', isError: true };
  const bad = validate(tool, input);
  if (bad) return { content: `Invalid input: ${bad}`, isError: true };
  try {
    const out = await tool.run(input, sources, { flags });
    let text = JSON.stringify(out, (k, v) => (v === undefined ? undefined : v));
    if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + ` … [cut at ${MAX_RESULT_CHARS} characters; narrow the request]`;
    return { content: text, isError: false };
  } catch (err) {
    if (err instanceof ToolError) return { content: err.message, isError: true };
    return { content: `The lookup failed: ${String(err && err.message || err).slice(0, 300)}`, isError: true };
  }
}

// What the panel shows while a tool runs.
function describeCall(name, input) {
  const i = input || {};
  const where = i.scope || i.property || i.entity || '';
  return {
    list_properties: 'Looking up buildings',
    pl_lines: 'Reading the P&L line list',
    pl_series: `Reading the P&L${where ? ` for ${where}` : ''}`,
    pl_rank: `Ranking ${i.level === 'entity' ? 'entities' : 'buildings'} on ${i.line || 'a line'}`,
    gl_postings: `Pulling ${i.line || ''} postings${where ? ` for ${where}` : ''} from Rent Manager`,
    delinquency: `Reading delinquency${where ? ` for ${where}` : ''}`,
    collections: 'Reading collections by billing month',
    occupancy: `Reading occupancy${where ? ` for ${where}` : ''}`,
    budget: `Reading the budget${where ? ` for ${where}` : ''}`,
    work_orders: `Reading work orders${where ? ` for ${where}` : ''}`,
    duplicate_payments: 'Reading duplicate payments',
    renovation_spend: 'Reading renovation spend',
    debt_service: 'Reading debt service',
    move_activity: `Reading move-ins and move-outs${where ? ` for ${where}` : ''}`,
    variance_flags: 'Reading the open variance flags',
  }[name] || 'Looking something up';
}

module.exports = { TOOLS, toolsFor, runTool, describeCall, resolveScope, resolveLine, monthIdx, ymFromLabel };
