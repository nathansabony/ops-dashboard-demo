// The Ask panel without an Anthropic key (DEMO_MODE only).
//
// With a key, services/assistant.js hands the question to Claude, which calls the lookup
// tools in services/assistantTools.js. Without one, this module answers a handful of common
// questions from the same tools: it picks the tool(s) for a question by keyword, runs them
// through assistantTools.runTool (same access rules, same data), and writes the answer in
// plain words. Anything else gets a friendly list of what it can answer and a note that an
// API key turns on free-form answers.

const assistantTools = require('./assistantTools');

const NOTE = 'Demo mode: no Anthropic API key is set, so this answer was written from the demo data by a fixed template. Set ANTHROPIC_API_KEY to let Claude answer anything you type.';

const SUGGESTIONS = [
  'What is our occupancy?',
  'Who is delinquent?',
  'Which property has the weakest DSCR?',
  'How is NOI doing?',
  'What are the open work orders?',
  'How much have we collected?',
];

const money = v => (v == null || !Number.isFinite(Number(v)) ? '-' : (Number(v) < 0 ? '-$' : '$') + Math.abs(Math.round(Number(v))).toLocaleString('en-US'));
const pct = (v, d = 1) => (v == null || !Number.isFinite(Number(v)) ? '-' : Number(v).toFixed(d) + '%');
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

async function tool(name, input, ctx) {
  const r = await assistantTools.runTool(name, input || {}, ctx);
  let data = null;
  try { data = JSON.parse(r.content); } catch { /* leave null */ }
  if (r.isError || !data) return { error: (data && data.error) || String(r.content || 'No data'), data: null };
  return { data };
}
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');

// ── answers ──────────────────────────────────────────────────────────────────
async function occupancy(ctx, say, status) {
  status('Reading occupancy and vacancy');
  const { data, error } = await tool('occupancy', {}, ctx);
  if (error) return say(`I could not read occupancy yet: ${error}`);
  const t = data.totals || {};
  const props = data.byProperty || [];
  say(`**Occupancy is ${pct(t.occupancyPct)}**: ${t.occupied} of ${t.units} units are occupied and ${t.vacant} are vacant. Scheduled rent on the whole portfolio is ${money(t.gprMonthly)} a month.`);
  if (props.length) {
    say('\n\nBy building, weakest first:\n' + table(['Building', 'Units', 'Occupied', 'Vacant', 'Occupancy'],
      props.map(p => [p.name, p.units, p.occupied, p.vacant, pct(p.occupancyPct)])));
    const w = props[0];
    say(`\n\n${w.name} has the most room to improve: ${plural(w.vacant, 'unit')} empty.`);
  }
}

async function delinquency(ctx, say, status) {
  status('Reading the delinquency report');
  const { data, error } = await tool('delinquency', { top: 8 }, ctx);
  if (error) return say(`I could not read delinquency yet: ${error}`);
  const t = data.totals || {};
  say(`**${plural(t.tenants || 0, 'current tenant')} owe ${money(t.amount)}** (rent more than ${data.graceDays || 5} days late, as of ${String(data.asOf || '').slice(0, 10)}).`);
  if ((data.byProperty || []).length) {
    say('\n\nBy building:\n' + table(['Building', 'Tenants', 'Owed'], data.byProperty.map(p => [p.name, p.tenants, money(p.amount)])));
  }
  if ((data.largest || []).length) {
    say('\n\nLargest balances:\n' + data.largest.map(i => `- ${i.tenant}, unit ${i.unit} at ${i.property}: ${money(i.amount)}`).join('\n'));
    say('\n\nA call first, then a written payment plan, is the usual order. The Delinquency tab has the full list and the collections brief.');
  }
}

function trailing(arr, n, endExclusive) {
  const end = endExclusive == null ? arr.length : endExclusive;
  return arr.slice(Math.max(0, end - n), end).reduce((s, v) => s + (Number(v) || 0), 0);
}

async function dscr(ctx, say, status) {
  status('Comparing NOI with mortgage interest by building');
  const pl = ctx.sources.loadPL && ctx.sources.loadPL();
  if (!pl || !pl.properties) return say('The P&L snapshot has not been pulled yet, so I cannot compute coverage. Try again in a minute.');
  const last = pl.months.length - (pl.partialCurrentMonth ? 1 : 0);   // exclusive end of closed months
  const rows = Object.values(pl.properties).map(p => {
    const noi = trailing(p.noi || [], 12, last), debt = trailing(p.mortgage || [], 12, last);
    return { name: p.name, noi, debt, dscr: debt > 0 ? noi / debt : null };
  }).filter(r => r.dscr != null).sort((a, b) => a.dscr - b.dscr);
  if (!rows.length) return say('I found no mortgage interest on the P&L, so there is no debt coverage to rank.');
  const w = rows[0];
  say(`**${w.name} has the weakest debt coverage at ${w.dscr.toFixed(2)}x**: ${money(w.noi)} of NOI against ${money(w.debt)} of mortgage interest over the last 12 closed months.`);
  say('\n\nAll buildings, weakest first:\n' + table(['Building', 'NOI (12 mo)', 'Mortgage interest', 'Coverage'],
    rows.map(r => [r.name, money(r.noi), money(r.debt), r.dscr.toFixed(2) + 'x'])));
  const short = rows.filter(r => r.dscr < 1.25);
  say(`\n\n${short.length ? `${plural(short.length, 'building')} ${short.length === 1 ? 'sits' : 'sit'} under a 1.25x lender minimum.` : 'Every building clears a 1.25x lender minimum.'} Coverage here uses interest only (Rent Manager carries no principal), so a lender would score it lower.`);
}

async function noi(ctx, say, status) {
  status('Ranking buildings on NOI');
  const { data, error } = await tool('pl_rank', { line: 'noi', level: 'property' }, ctx);
  if (error) return say(`I could not rank NOI yet: ${error}`);
  const rows = data.rows || [];
  if (!rows.length) return say('There is no NOI on the P&L yet.');
  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const before = rows.reduce((s, r) => s + (r.monthBefore || 0), 0);
  say(`**NOI for ${data.period} is ${money(total)}** across ${plural(rows.length, 'building')}, ${total >= before ? 'up' : 'down'} ${money(Math.abs(total - before))} from the month before.`);
  say('\n\n' + table(['Building', data.period, 'Month before', '12-mo average'], rows.map(r => [r.name, money(r.amount), money(r.monthBefore), money(r.trailing12Avg)])));
  const top = rows[0], bottom = rows[rows.length - 1];
  say(`\n\n${top.name} leads; ${bottom.name} is lowest. Open the Portfolio tab for the grades behind these numbers.`);
}

async function workOrders(ctx, say, status) {
  status('Reading open work orders');
  const { data, error } = await tool('work_orders', { open_only: true }, ctx);
  if (error) return say(`I could not read work orders yet: ${error}`);
  say(`**${plural(data.count, 'work order')} open** in the ${data.window}.`);
  if ((data.byCategory || []).length) say('\n\nBy category:\n' + data.byCategory.slice(0, 6).map(([k, n]) => `- ${k}: ${n}`).join('\n'));
  if ((data.byProperty || []).length) say('\n\nBy building:\n' + data.byProperty.slice(0, 6).map(([k, n]) => `- ${k}: ${n}`).join('\n'));
  say('\n\nThe Service Requests tab lists each one with its age and assignee.');
}

async function collections(ctx, say, status) {
  status('Reading collections by billing month');
  const { data, error } = await tool('collections', {}, ctx);
  if (error) return say(`I could not read collections yet: ${error}`);
  const months = (data.months || []).filter(m => m.charged);
  if (!months.length) return say('Collections by billing month are still being built.');
  const m = months[0];   // the cohorts list newest first
  say(`**For ${m.month}, ${pct(m.pctToDate)} of the ${money(m.charged)} billed has been collected to date**` + (data.goalPct != null ? ` (goal ${pct(data.goalPct, 0)}).` : '.'));
  say('\n\n' + table(['Billing month', 'Billed', 'By month end', 'To date'], months.slice(0, 6).map(x => [x.month, money(x.charged), pct(x.pctByMonthEnd), pct(x.pctToDate)])));
}

async function renovations(ctx, say, status) {
  status('Reading renovation spend');
  const { data, error } = await tool('renovation_spend', { group_by: 'property' }, ctx);
  if (error) return say(`I could not read renovation spend yet: ${error}`);
  say(`**${money(data.total)} of renovation spend** across ${plural(data.charges, 'charge')} in the last 24 months.`);
  if ((data.groups || []).length) say('\n\n' + table(['Building', 'Spend', 'Charges'], data.groups.slice(0, 6).map(g => [g.name, money(g.amount), g.charges])));
}

async function moves(ctx, say, status) {
  status('Reading move-ins and move-outs');
  const { data, error } = await tool('move_activity', { scope: 'portfolio' }, ctx);
  if (error) return say(`I could not read move activity yet: ${error}`);
  const rows = (data.byMonth || []).slice(-6);
  say('**Move-ins and move-outs, last six months:**\n' + table(['Month', 'Move-ins', 'Move-outs'], rows.map(r => [r.month, r.moveIns, r.moveOuts])));
}

async function budget(ctx, say, status) {
  status('Reading the budget');
  const { data, error } = await tool('budget', { scope: 'portfolio' }, ctx);
  if (error) return say(`I could not read the budget yet: ${error}`);
  const y = (data.years || [])[0];
  if (!y) return say('The budget has no yearly totals yet.');
  say(`**The ${y.label} budget** projects ${money(y.egi)} of effective income, ${money(y.opex)} of operating expense and **${money(y.noi)} of NOI**.`);
}

const INTENTS = [
  { re: /dscr|debt (service )?coverage|coverage ratio|weakest|debt/i, run: dscr },
  { re: /delinq|owe|behind on|late rent|past due|arrears|who (hasn|has not)/i, run: delinquency },
  { re: /collect/i, run: collections },
  { re: /occupan|vacan|empty unit|leased/i, run: occupancy },
  { re: /work ?order|service request|maintenance|repair request|open issues|tickets?/i, run: workOrders },
  { re: /renovat|capital (spend|project)|capex/i, run: renovations },
  { re: /move[- ]?(in|out)|turnover/i, run: moves },
  { re: /budget/i, run: budget },
  { re: /noi|net operating|income|profit|how (are|is) (we|the portfolio|it) doing|performance|best|worst/i, run: noi },
];

function helpText() {
  return 'I can answer a handful of questions from the demo data without an API key. Try one of these:\n' + SUGGESTIONS.map(q => `- ${q}`).join('\n') +
    '\n\nFree-form questions ("why did this line jump?", "compare two buildings") need an Anthropic API key.';
}

// Streams the answer through the same callbacks the Claude path uses. Resolves { handled }.
async function streamDemoAnswer({ question, user, sources, flags, onText, onStatus }) {
  const ctx = { user, sources, flags };
  const q = String(question || '');
  const intent = INTENTS.find(i => i.re.test(q));
  let any = false;
  const say = t => { any = true; onText(t); };
  if (!intent) {
    say(helpText());
  } else {
    try { await intent.run(ctx, say, v => onStatus && onStatus(v)); }
    catch (err) { say(`I hit a problem reading that data: ${err.message}`); }
    if (!any) say(helpText());
  }
  onText('\n\n' + NOTE);
  return { handled: Boolean(intent) };
}

module.exports = { streamDemoAnswer, SUGGESTIONS, NOTE, INTENTS };
