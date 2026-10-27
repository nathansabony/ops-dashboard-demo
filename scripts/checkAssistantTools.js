// The Ask panel's lookup tools (services/assistantTools.js) against stand-in
// snapshots: scope and month resolution, what each tool returns, who may use
// which, and the tool loop in services/assistant.js. No key, no Rent Manager.

const tools = require('../services/assistantTools');
const assistant = require('../services/assistant');

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

const months = ['Sep 25', 'Oct 25', 'Nov 25', 'Dec 25', 'Jan 26', 'Feb 26', 'Mar 26', 'Apr 26', 'May 26', 'Jun 26', 'Jul 26', 'Aug 26', 'Sep 26', 'Oct 26'];
const flat = v => months.map(() => v);
const pl = {
  refreshedAt: '2026-10-20T06:00:00Z', basis: 'Accrual', partialCurrentMonth: true, months,
  categories: ['noi', 'repairsMaint', 'waterSewer'],
  lineMeta: [{ key: 'gl:5999', ref: '5999', label: 'Misc Expense', group: 'expense' }],
  categoryMembers: { 5100: ['5100-1'] },
  portfolio: { noi: flat(300), repairsMaint: flat(30), waterSewer: flat(12), 'gl:5999': flat(1) },
  entities: {
    'Willow Creek': { noi: flat(200), repairsMaint: flat(20), waterSewer: flat(8), 'gl:5999': flat(1) },
    'Maple Court': { noi: flat(100), repairsMaint: flat(10), waterSewer: flat(4), 'gl:5999': flat(0) },
  },
  properties: {
    11: { name: '410 Alder Street', entity: 'Willow Creek', noi: flat(150), repairsMaint: [...flat(5).slice(1), 48], waterSewer: flat(6), 'gl:5999': flat(1) },
    12: { name: '88-92 Maple Court', entity: 'Willow Creek', noi: flat(50), repairsMaint: flat(15).slice(0, 13).concat([0]), waterSewer: flat(2), mergedFrom: [{ id: 12, name: '88 Maple Court' }, { id: 13, name: '90 Maple Court' }] },
    21: { name: '77 Birchwood Lane', entity: 'Maple Court', noi: flat(100), repairsMaint: flat(10), waterSewer: flat(4) },
    22: { name: '77 Birchwood Lane Rear', entity: 'Maple Court', noi: flat(0), repairsMaint: flat(0), waterSewer: flat(0) },
  },
};
const glCalls = [];
const sources = {
  loadPL: () => pl,
  loadRawPL: () => ({ ...pl, properties: { ...pl.properties, 13: { name: '90 Maple Court', entity: 'Willow Creek' } } }),
  idsFor: pid => (pid === 12 ? [12, 13] : [pid]),
  entityOfProperty: pid => (pl.properties[pid] || {}).entity,
  loadUnits: () => ({ byProperty: { 11: 40, 12: 24, 21: 30 } }),
  glDetail: async args => { glCalls.push(args); return { totals: { net: 48 }, postings: [
    { date: '2026-09-04', txnType: 'BILLITM', vendor: 'Acme Boiler', description: 'Boiler replacement', amount: 41000, account: '5100 Repairs', property: '169Ma', servicePeriod: null, invoiceNo: 'A-17' },
    { date: '2026-09-12', txnType: 'CHKITM', vendor: 'Home Depot', description: 'Supplies', amount: 7000, account: '5100-1 Supplies', property: '169Ma' },
  ] }; },
  loadDelinquency: () => ({ asOf: '2026-10-20', graceDays: 5, totals: { amount: 1500, tenants: 3 }, byEntity: { 'Willow Creek': { amount: 1000, tenants: 2 } },
    byProperty: { '410 Alder Street': { amount: 1000, tenants: 2, entity: 'Willow Creek' }, '77 Birchwood Lane': { amount: 500, tenants: 1, entity: 'Maple Court' } },
    items: [{ tenant: 'A Tenant', unit: '2B', property: '410 Alder Street', entity: 'Willow Creek', amount: 700 }, { tenant: 'B Tenant', unit: '3A', property: '410 Alder Street', entity: 'Willow Creek', amount: 300 }, { tenant: 'C Tenant', unit: '1', property: '77 Birchwood Lane', entity: 'Maple Court', amount: 500 }] }),
  loadCohorts: () => null,
  loadLiveOverview: () => null, loadVacancyHistory: () => [], loadBudget: () => null, loadIssues: () => null,
  loadDuplicatePayments: () => null, loadRenovations: () => null, loadDebtService: () => null, loadMoves: () => null,
};
const admin = { admin: true, tools: [] };
const varOnly = { admin: false, tools: ['variances'] };
const dqOnly = { admin: false, tools: ['delinquency'] };
const parse = r => JSON.parse(r.content);

(async () => {
  // ── Resolution ──────────────────────────────────────────────────────────────
  check('an entity name resolves, any case', tools.resolveScope(pl, 'willow creek').kind === 'entity');
  check('a property resolves by id', tools.resolveScope(pl, '11').label === '410 Alder Street');
  check('a property resolves by part of its name', tools.resolveScope(pl, 'alder').id === '11');
  check('a merged side finds its building', tools.resolveScope(pl, '90 Maple Court').id === '12');
  let amb = ''; try { tools.resolveScope(pl, 'Birchwood Lane'); } catch (e) { amb = e.message; }
  check('an ambiguous name lists the choices with ids', /matches 2 properties/.test(amb) && /id 21/.test(amb));
  check('a month resolves as YYYY-MM or a label', tools.monthIdx(months, '2026-09') === 12 && tools.monthIdx(months, 'Sep 26') === 12 && tools.monthIdx(months, 'September 2026') === 12);
  check('a line resolves by label', tools.resolveLine(pl, 'Misc Expense').key === 'gl:5999');

  // ── Tools ───────────────────────────────────────────────────────────────────
  const ctx = { user: admin, sources, flags: null };
  const lp = parse(await tools.runTool('list_properties', { entity: 'Willow Creek' }, ctx));
  check('list_properties filters by entity and carries units and merged sides', lp.count === 2 && lp.properties.find(p => p.id === '12').mergedFrom.length === 2 && lp.properties.find(p => p.id === '11').units === 40);

  const ps = parse(await tools.runTool('pl_series', { scope: '410 Alder Street', lines: ['repairsMaint'], from: '2026-08', to: '2026-10' }, ctx));
  check('pl_series returns the window by month with a total', ps.lines[0].byMonth['Oct 26'] === 48 && ps.lines[0].total === 58 && ps.note.includes('in progress'));

  const pr = parse(await tools.runTool('pl_rank', { line: 'repairsMaint', level: 'property' }, ctx));
  check('pl_rank defaults to the last closed month, not the one in progress', pr.period === 'Sep 26');
  check('pl_rank ranks highest first with month before and last year', pr.rows[0].name === '88-92 Maple Court' && pr.rows[0].monthBefore === 15 && pr.rows[0].sameMonthLastYear === 15);

  const gl = parse(await tools.runTool('gl_postings', { scope: '88-92 Maple Court', line: 'repairsMaint', from: '2026-09' }, ctx));
  check('gl_postings asks Report 51 for both sides of a merged building', glCalls[0].propOwnerIds === '12,13');
  check('gl_postings widens the line to its member accounts', glCalls[0].refs.join(',') === '5100,5100-1');
  check('gl_postings covers whole months', glCalls[0].startDate === '2026-09-01' && glCalls[0].endDate === '2026-09-30');
  check('gl_postings lists the largest posting first', gl.postings[0].vendor === 'Acme Boiler' && gl.count === 2);
  await tools.runTool('gl_postings', { scope: 'Willow Creek', line: 'repairsMaint', from: '2026-09' }, ctx);
  check('gl_postings for an entity includes every building of it, merged sides too', glCalls[1].propOwnerIds.split(',').sort().join(',') === '11,12,13');
  const wide = await tools.runTool('gl_postings', { scope: 'Willow Creek', line: 'repairsMaint', from: '2025-01', to: '2026-09' }, ctx);
  check('gl_postings refuses a window over six months', wide.isError && /six months/.test(wide.content));
  const total = await tools.runTool('gl_postings', { scope: 'Willow Creek', line: 'noi', from: '2026-09' }, ctx);
  check('gl_postings refuses a total line', total.isError && /not a single GL line/.test(total.content));

  const dq = parse(await tools.runTool('delinquency', { entity: 'Willow Creek' }, ctx));
  check('delinquency filters and recomputes totals', dq.totals.amount === 1000 && dq.totals.tenants === 2 && dq.largest[0].tenant === 'A Tenant');

  // A 24-month budget is two years, reported a year at a time — never summed as one.
  const bm = Array.from({ length: 24 }, (_, i) => `M${i + 1}`);
  const budgetSet = { generatedAt: '2026-07-29', config: { lines: [{ key: 'propTax', label: 'Property Taxes' }] }, entities: {}, portfolio: {
    monthLabels: bm, lines: { propTax: bm.map(() => 10) }, totals: { noi: bm.map(() => 100) },
    years: [{ label: 'Year 1', months: 'M1 – M12', lines: { propTax: 120 }, noi: 1200 }, { label: 'Year 2', months: 'M13 – M24', lines: { propTax: 120 }, noi: 1200 }] } };
  const bg = parse(await tools.runTool('budget', { scope: 'portfolio' }, { ...ctx, sources: { ...sources, loadBudget: () => budgetSet } }));
  check('a multi-year budget reports each year, not the horizon as one year', bg.years.length === 2 && bg.years[0].noi === 1200 && bg.lines[0].byYear['Year 1'] === 120 && bg.horizonMonths === 24);

  const missing = await tools.runTool('budget', { scope: 'portfolio' }, ctx);
  check('a snapshot not built yet says so instead of failing', missing.isError && /not been built/.test(missing.content));

  const flags = [{ scope: '410 Alder Street', entity: 'Willow Creek', line: 'Water & Sewer', urgency: 'critical' }, { scope: '77 Birchwood Lane', entity: 'Maple Court', line: 'Electric', urgency: 'watch' }];
  const vf = parse(await tools.runTool('variance_flags', { urgency: 'critical' }, { ...ctx, flags }));
  check('variance_flags reads the flags the browser sent', vf.count === 1 && vf.flags[0].line === 'Water & Sewer');

  // ── Input checks ────────────────────────────────────────────────────────────
  check('a missing required field is an error back to Claude', (await tools.runTool('pl_series', { scope: 'Willow Creek' }, ctx)).isError);
  check('a wrong type is an error back to Claude', (await tools.runTool('pl_rank', { line: 'noi', level: 'building' }, ctx)).isError);
  check('an unknown field is an error back to Claude', (await tools.runTool('debt_service', { x: 1 }, ctx)).isError);
  check('an unknown tool is an error back to Claude', (await tools.runTool('drop_tables', {}, ctx)).isError);

  // ── Access ──────────────────────────────────────────────────────────────────
  const names = u => tools.toolsFor(u).map(t => t.name);
  check('an admin is offered every tool', names(admin).length === tools.TOOLS.length);
  check('Variances only: P&L, postings and flags, but not delinquency or budget', names(varOnly).includes('gl_postings') && names(varOnly).includes('variance_flags') && !names(varOnly).includes('delinquency') && !names(varOnly).includes('budget'));
  check('Delinquency only: delinquency and collections, but no P&L', names(dqOnly).includes('delinquency') && names(dqOnly).includes('collections') && !names(dqOnly).includes('pl_series'));
  const refused = await tools.runTool('delinquency', {}, { user: varOnly, sources });
  check('a tool asked for without access is refused, not run', refused.isError && /access/.test(refused.content));
  check('nobody signed out is offered tools', tools.toolsFor(null).length === 0);

  // ── The loop ────────────────────────────────────────────────────────────────
  // Round 1: Claude asks for a tool. Round 2: it answers.
  const requests = [];
  const script = [
    { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu1', name: 'pl_series', input: { scope: 'Willow Creek', lines: ['noi'] } }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'NOI is flat at $200 a month.' }], stop_reason: 'end_turn' },
  ];
  const api = { beta: { messages: { stream(params) {
    requests.push(JSON.parse(JSON.stringify(params)));
    const msg = script[requests.length - 1];
    return {
      async *[Symbol.asyncIterator]() { for (const b of msg.content) if (b.type === 'text') yield { type: 'content_block_delta', delta: { type: 'text_delta', text: b.text } }; },
      async finalMessage() { return { ...msg, model: params.model, usage: { input_tokens: 5, output_tokens: 3 } }; },
    };
  } } } };
  let text = ''; const statuses = [];
  const r = await assistant.streamAnswer({ history: [], question: 'How is Willow Creek NOI?', context: { page: 'overview', text: '' }, api, user: varOnly, sources, onText: t => { text += t; }, onStatus: s => statuses.push(s) });
  check('the loop runs the tool and asks again', requests.length === 2 && r.toolCalls.length === 1 && r.toolCalls[0].name === 'pl_series');
  const second = requests[1].messages;
  check('the tool turn goes back unchanged, then its result', second[1].role === 'assistant' && second[1].content[1].id === 'tu1' && second[2].content[0].type === 'tool_result' && second[2].content[0].tool_use_id === 'tu1');
  check('the result carries the data', /"Jan 26":200/.test(second[2].content[0].content));
  check('the person sees what is being looked up', statuses[0] === 'Reading the P&L for Willow Creek');
  check('the answer streams through', text.includes('NOI is flat'));
  check('only this person\'s tools are offered', requests[0].tools.every(t => names(varOnly).includes(t.name)));

  // A question that never stops reaching for tools still ends: the last round may not call one.
  const looping = { beta: { messages: { stream(params) {
    const done = params.tool_choice && params.tool_choice.type === 'none';
    const msg = done ? { content: [{ type: 'text', text: 'Here is what I found.' }], stop_reason: 'end_turn' }
      : { content: [{ type: 'tool_use', id: 'tu' + Math.random(), name: 'pl_lines', input: {} }], stop_reason: 'tool_use' };
    return { async *[Symbol.asyncIterator]() {}, async finalMessage() { return { ...msg, model: 'm', usage: {} }; } };
  } } } };
  const lr = await assistant.streamAnswer({ history: [], question: 'q', context: { page: 'overview' }, api: looping, user: admin, sources, onText: () => {} });
  check('a runaway loop ends after the round limit with tools still defined', lr.toolCalls.length === 8 && lr.stopReason === 'end_turn');

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll Ask panel lookup checks pass');
  process.exit(failed ? 1 : 0);
})();
