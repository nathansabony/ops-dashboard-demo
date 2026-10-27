// Debt service year to date, by building: mortgage interest and principal.
//
// Rebuilt 2026-10-20. The old build came back empty on every run, and nothing
// said so:
//   - it read transactions from /GLTransactions, which Rent Manager's API does
//     not have (404), and swallowed the error as "no transactions";
//   - it found accounts by name in the first 500 of the chart, and the PNC Willow Creek
//     1-3, Trimont (Willow Creek), Arbor, BCB and TD #0524 mortgages sit past
//     500 — one of them spelled "Mortagage";
//   - it looked for the account type on fields RM does not send (it is
//     GLAccountType), so no loan was ever classed as principal.
//
// Now:
//   - Interest is the P&L snapshot's mortgage line (GL 6230), year to date — the
//     same number the scorecard's DSCR uses, with no Rent Manager call.
//   - Principal is what was paid down on the mortgage loan accounts: account 2300
//     and every account under it in the chart (by parent, not by name), read with
//     Report 51, the same report the variance cards use. Debits to a loan account
//     reduce it. Member, intercompany and bridge loans (under other parents) are
//     not mortgage debt service and are left out.
//   - A part that cannot be read says why, in `notes`, instead of reading $0.

const MORTGAGE_LOAN_REF = '2300';
const PAYOFF_RE = /pay\s*-?\s*off|refinanc/i;
const PAYOFF_MIN = 1000000;
const YEAR_LABEL = y => ` ${String(y).slice(2)}`;

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  return (payload && (payload.Results || payload.Items)) || [];
}

// deps: { rentManager, loadPL, mergeGroups, primaryOf, propertyEntityMap, glDetail, now }
async function build(deps) {
  const now = deps.now ? deps.now() : new Date();
  const year = now.getFullYear();
  const startDate = `${year}-01-01`;
  const endDate = now.toISOString().slice(0, 10);
  const notes = [];
  const rows = new Map();   // building name -> row
  const row = (name, entity) => {
    if (!rows.has(name)) rows.set(name, { property: name, entity: entity || null, interest: 0, principal: 0 });
    const r = rows.get(name);
    if (!r.entity && entity) r.entity = entity;
    return r;
  };

  // ── Interest: the P&L's mortgage line, this calendar year ──────────────────
  const pl = deps.loadPL();
  let interestThrough = null;
  if (!pl || !Array.isArray(pl.months)) {
    notes.push('Interest: the P&L snapshot has not been built yet.');
  } else {
    const idx = pl.months.map((m, i) => (m.endsWith(YEAR_LABEL(year)) ? i : -1)).filter(i => i >= 0);
    interestThrough = idx.length ? pl.months[idx[idx.length - 1]] : null;
    for (const p of Object.values(pl.properties || {})) {
      const s = p.mortgage || [];
      const v = idx.reduce((t, i) => t + (s[i] || 0), 0);
      if (v) row(p.name, p.entity).interest += v;
    }
    if (pl.partialCurrentMonth && interestThrough) notes.push(`Interest: ${interestThrough} is month to date.`);
  }

  // ── Principal: paydowns on the mortgage loan accounts ──────────────────────
  let loanAccounts = [];
  let largestPaydowns = [];
  const payoffs = [];
  try {
    const all = asRows(await deps.rentManager.allGLAccounts());
    const head = all.find(a => String(a.Reference || '').trim() === MORTGAGE_LOAN_REF);
    if (!head) throw new Error(`no account ${MORTGAGE_LOAN_REF} in the chart`);
    const kids = new Map();
    all.forEach(a => { const p = a.ParentGLAccountID; if (p != null) (kids.get(p) || kids.set(p, []).get(p)).push(a); });
    const walk = a => [a, ...(kids.get(a.GLAccountID) || []).flatMap(walk)];
    loanAccounts = walk(head).filter(a => a.Reference).map(a => ({ id: a.GLAccountID, ref: String(a.Reference).trim(), name: a.Name }));

    const map = await deps.propertyEntityMap();
    const byShort = new Map();
    for (const [id, m] of map.byId) if (m.shortName) byShort.set(String(m.shortName).trim(), { id, entity: m.entity, name: m.name });
    const ids = [...map.byId.keys()];
    if (!ids.length) throw new Error('no properties mapped to an entity');

    const detail = await deps.glDetail({ propOwnerIds: ids.join(','), refs: loanAccounts.map(a => a.ref), startDate, endDate });
    let unmatched = 0;
    const debits = [];
    for (const p of detail.postings || []) {
      if (!(p.debit > 0)) continue;   // credits are new borrowing or corrections, not payments
      const item = { date: p.date, property: p.property, account: p.account, type: p.txnType, reference: p.reference, description: p.description, amount: p.debit };
      // A loan paid off in a refinance also debits the loan account — Birchwood Commons's
      // $164.3M Arbor payoff (J4948, 3/26) and Willow Creek's $84.8M (J4840,
      // 1/26) read as 2026 "principal" before this. A payoff is not debt
      // service: it is kept aside and listed, never added in. Named by its
      // description; a single entry of $1M or more is treated the same way.
      if (PAYOFF_RE.test(`${p.description || ''} ${p.reference || ''}`) || p.debit >= PAYOFF_MIN) { payoffs.push(item); continue; }
      debits.push(item);
      const hit = byShort.get(String(p.property || '').trim());
      if (!hit) { unmatched += p.debit; continue; }
      // A split building reads as one, like everywhere else on the site.
      const primary = deps.primaryOf(Number(hit.id));
      const merged = pl && pl.properties && pl.properties[primary];
      row(merged ? merged.name : hit.name, hit.entity).principal += p.debit;
    }
    largestPaydowns = debits.sort((x, y) => y.amount - x.amount).slice(0, 15);
    if (payoffs.length) {
      const total = payoffs.reduce((t, x) => t + x.amount, 0);
      notes.push(`Principal: ${payoffs.length} loan payoff${payoffs.length === 1 ? '' : 's'} this year ($${Math.round(total).toLocaleString()}, e.g. ${payoffs.slice().sort((x, y) => y.amount - x.amount).slice(0, 2).map(x => `${x.property} ${x.date}`).join(', ')}) are refinancing, not debt service, and are left out.`);
    }
    if (unmatched) notes.push(`Principal: $${Math.round(unmatched).toLocaleString()} posted to buildings outside the entity map is not shown.`);
    if (!(detail.postings || []).some(p => p.debit > 0)) notes.push('Principal: no paydowns were posted to the mortgage loan accounts this year — Rent Manager may not carry principal, so treat coverage as interest only.');
  } catch (err) {
    notes.push(`Principal could not be read: ${String(err && err.message || err).slice(0, 200)}. Showing interest only.`);
  }

  const r2 = v => Math.round(v * 100) / 100;
  const by_property = [...rows.values()].map(r => ({ ...r, interest: r2(r.interest), principal: r2(r.principal), total: r2(r.interest + r.principal) }))
    .filter(r => r.total).sort((a, b) => b.total - a.total);
  const byEntity = {};
  by_property.forEach(r => {
    const e = byEntity[r.entity || 'Unmapped'] ||= { interest: 0, principal: 0, total: 0 };
    e.interest = r2(e.interest + r.interest); e.principal = r2(e.principal + r.principal); e.total = r2(e.total + r.total);
  });
  const sum = k => r2(by_property.reduce((s, r) => s + r[k], 0));
  return {
    version: 4,
    from: startDate, to: endDate, interestThrough,
    sources: { interest: 'P&L snapshot, GL 6230', principal: `Report 51 debits to ${loanAccounts.length} mortgage loan accounts (${MORTGAGE_LOAN_REF} and under)` },
    interest: sum('interest'), principal: sum('principal'), total: sum('total'),
    byEntity, by_property, notes, largestPaydowns, payoffs: payoffs.sort((x, y) => y.amount - x.amount),
  };
}

// The old build's snapshots (no version) are empty by construction; replace them.
const isOutdated = data => !data || data.version !== 4;

module.exports = { build, isOutdated, MORTGAGE_LOAN_REF };
