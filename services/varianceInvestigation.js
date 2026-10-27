// What a person would find by opening Rent Manager on a flagged line — done for them.
//
// The owner, 2026-10-22: "Every variance should produce a PDF report explaining why
// that one was flagged, but also doing digging into solving it on its own — going
// into Rent Manager and actually finding the actual issue itself."
//
// The flag says WHAT moved ("Water & Sewer was $9,000 in Sep, $3,100 in Aug"). The
// first thing anyone does next is open the postings behind the month, put them
// beside last month's, and see which bill is the difference. This does that, with
// rules and no language model: every sentence below is assembled from a posting,
// a date, an amount or a count that is printed next to it, so nothing here can say
// something the postings do not show. Where they show nothing, the answer is
// "could not determine" — with what was looked at, so the next person does not
// repeat it.
//
// WHAT IT READS (only endpoints this site already uses — nothing new is asked of
// Rent Manager):
//   • Report 51 General Ledger, accrual, via glTransactions.getGLDetail — the
//     flagged line's postings for the six months ending in the flagged month (the
//     flagged month, last month, and four months of history), the same line a year
//     earlier (±1 month), and — for a single building — the entity's OTHER
//     buildings on the line and this building's neighbouring GL lines, to see
//     whether a bill sits on the wrong building or the wrong account.
//   • The duplicate-payment rule (duplicatePayments.findDuplicates), run over the
//     same postings: a check keyed straight to expense that repeats a bill.
//   • /Bills through rmDocuments.backupFor, for the few biggest bills of the
//     month: is there an invoice file on it, is it approved, has anything paid it.
//
// BOUNDED: at most 4 Report 51 runs (one is needed; three more are optional and
// their failure only narrows what is claimed) and 3 bill lookups per
// investigation, each with its own time limit. The answer is kept per
// (scope, line, month) for as long as the P&L snapshot it was built beside is the
// current one, so a pack of twenty reports, or the same report printed twice,
// asks Rent Manager once.
//
// Pure where it can be: analyze() takes postings in and gives findings out, so
// scripts/checkVarianceInvestigation.js can prove each rule on canned payloads
// without a network.

const duplicatePayments = require('./duplicatePayments');

const MONTH_RE = /^\d{4}-\d{2}$/;
const HISTORY_MONTHS = 5;        // months before the flagged one that are read
const MAX_FINDINGS = 5;
const BILL_LOOKUPS = 3;
const BILL_LOOKUP_MS = 25000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const POSTINGS_SHOWN_CUR = 200;

// Lines a bill is easily keyed to the wrong one of. Only these are cross-checked;
// a property tax bill has no neighbour worth looking at.
const NEIGHBOURS = {
  heatingGas: ['electric', 'waterSewer'],
  electric: ['heatingGas', 'waterSewer'],
  waterSewer: ['heatingGas', 'electric'],
  repairsMaint: ['turnover', 'majRepairs'],
  turnover: ['repairsMaint', 'majRepairs'],
  majRepairs: ['repairsMaint', 'renCapital'],
  renCapital: ['majRepairs'],
  payroll: ['mgmtWages'],
  mgmtWages: ['payroll'],
};

// ── small helpers ───────────────────────────────────────────────────────────
const round2 = v => Math.round(v * 100) / 100;
const sumOf = list => round2(list.reduce((t, p) => t + (p.amount || 0), 0));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const usd = v => `${v < 0 ? '-' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
const pctTxt = r => `${Math.round(r * 100)}%`;

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const monthStart = ym => `${ym}-01`;
function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
function monthName(ym) { const [y, m] = ym.split('-'); return `${MON[Number(m) - 1]} ${y.slice(2)}`; }
const monthOf = p => String(p.date || '').slice(0, 7);
const dayName = d => { const [y, m, dd] = String(d).split('-'); return m ? `${MON[Number(m) - 1]} ${Number(dd)}` : String(d); };

function descHead(p) {
  const d = String(p.description || '');
  const i = d.indexOf(':');
  return (i > 0 ? d.slice(0, i) : d).trim();
}
const vendorLabel = p => String(p.vendor || '').trim() || descHead(p) || '(no vendor named)';
function vendorKey(p) {
  if (p.vendorId != null && p.vendorId !== '') return `id:${p.vendorId}`;
  return `n:${vendorLabel(p).toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
}
function groupVendors(list) {
  const m = new Map();
  for (const p of list) {
    const k = vendorKey(p);
    if (!m.has(k)) m.set(k, { key: k, label: vendorLabel(p), postings: [], total: 0 });
    const g = m.get(k);
    g.postings.push(p);
    g.total = round2(g.total + (p.amount || 0));
  }
  return m;
}

// The service period a vendor wrote into the description, anywhere in it:
// "PSE&G : 7379602209 -04/01/26 - 05/01/26".
const PERIOD_ANY = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/;
function usDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  return Number.isNaN(d.getTime()) ? null : d;
}
function periodOf(p) {
  const m = PERIOD_ANY.exec(String(p.description || ''));
  if (!m) return null;
  const from = usDate(m[1]), to = usDate(m[2]);
  if (!from || !to || to < from) return null;
  return { from, to, text: `${m[1]} - ${m[2]}`, days: Math.round((to - from) / 86400000) };
}

// What the page needs to show a posting: nothing that is not already on the
// General Ledger report.
const slimPosting = p => ({
  id: p.id, date: p.date, vendor: p.vendor || '', description: p.description || '', reference: p.reference || '',
  amount: round2(p.amount || 0), account: p.account || '', property: p.property || '', txnType: p.txnType || '',
  txnId: p.txnId || null, invoiceNo: p.invoiceNo || null,
});
const cite = (list, n = 6) => list.slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, n).map(slimPosting);
const postingText = p => `${dayName(p.date)} ${usd(p.amount)}${p.reference ? ` (ref ${p.reference})` : ''}${p.description && p.description !== p.vendor ? ` — ${String(p.description).slice(0, 90)}` : ''}`;

// ── the next step, per kind ─────────────────────────────────────────────────
// Instructions for a person in Rent Manager. They name the thing to open, and
// nothing about how a screen is laid out.
function nextFor(kind, f) {
  switch (kind) {
    case 'duplicate':
      return `In Rent Manager open check ${f.checkRef} and the bill${f.billRefs.length === 1 ? '' : 's'} it repeats (${f.billRefs.join(', ')}). If the bill was already paid, the check needs to be voided or applied to the bill instead of expensed again — and any credit posted against it belongs on the same accounts as the charges. Leave the Variances duplicate marked open until that is done.`;
    case 'credit':
      return f.reversed
        ? `Open the original ${f.vendor} charge and its credit in Rent Manager and confirm the credit was meant to cancel it, and that it was posted to the same property and account.`
        : `Open the ${f.vendor} credit in Rent Manager and find what it relates to — the postings pulled show no matching charge — then confirm the property and account.`;
    case 'wrong-place':
      return `Open the ${f.vendor} bill${f.where ? ` and compare it with the one at ${f.where}` : ''} in Rent Manager and confirm which property and GL account it belongs to; reclass whichever is wrong.`;
    case 'catch-up':
      return `Open the ${f.vendor} bill in Rent Manager and read the service period it covers. If it pays earlier months, ask accounting whether those months were accrued — the arrears land here and make this month look like a jump.`;
    case 'cycle':
      return `Open the ${f.vendor} bill in Rent Manager and compare it with the earlier one listed. If the amount is in line, this is the billing cycle and the flag can be marked normal; if it is not, ask ${f.vendor} what changed.`;
    case 'new-vendor':
      return `Open the ${f.vendor} bill in Rent Manager: check the invoice is attached and approved, and that this vendor is meant to bill this property and this account.`;
    case 'vendor-more':
      return `Open the ${f.vendor} bill in Rent Manager and compare it with the earlier months listed — look at the invoice for a rate change, a late fee or a second period billed together.`;
    case 'one-big-bill':
      return `Open the ${f.vendor} bill in Rent Manager and read the invoice: confirm the work or service was for this property and the amount was keyed correctly.`;
    case 'missing-bill':
      return `Check in Rent Manager whether ${f.vendor}'s bill for this month has arrived and been entered, and whether it was entered to another property or account (the unpaid-bills list for ${f.vendor} is the place to look).`;
    case 'one-off-gone':
      return `Open the ${f.vendor} posting from last month in Rent Manager and read what it was for; this month is lower because it did not repeat.`;
    case 'vendor-less':
      return `Open this month's ${f.vendor} bill in Rent Manager and compare it with the earlier months listed — a lower bill is worth confirming against the invoice.`;
    default:
      return `Open the ${f.vendor} postings listed in Rent Manager and read the invoices; the postings pulled do not say why the amount changed.`;
  }
}

// ── the analysis ────────────────────────────────────────────────────────────
// input: {
//   month: 'YYYY-MM', line: {key, label}, scope: {kind, label, entity, ownShortNames:[...]},
//   window: postings for month-5 … month (required),
//   lastYear: postings for lastYearMonth ±1, or null when it could not be pulled,
//   siblings: the entity's other buildings on the line (prev + flagged month), or null,
//   neighbours: this building on neighbouring lines (month-5 … month), or null,
// }
// Returns { result, billTargets } — result is plain data; every string is text.
function analyze(input) {
  const month = input.month;
  const A = input.window || [];
  const prevM = addMonths(month, -1);
  const lyM = addMonths(month, -12);
  const priorMonths = [-5, -4, -3, -2, -1].map(n => addMonths(month, n));
  const own = new Set((input.scope.ownShortNames || []).map(s => String(s).trim().toUpperCase()));

  const inMonth = (list, ym) => (list || []).filter(p => monthOf(p) === ym);
  const cur = inMonth(A, month), prev = inMonth(A, prevM);
  const lyCtx = input.lastYear ? input.lastYear.filter(p => [addMonths(lyM, -1), lyM, addMonths(lyM, 1)].includes(monthOf(p))) : null;
  const lyExact = lyCtx ? lyCtx.filter(p => monthOf(p) === lyM) : null;
  const curT = sumOf(cur), prevT = sumOf(prev), lyT = lyExact ? sumOf(lyExact) : null;

  const presence = new Map();                       // vendor → Set of months it posted in
  for (const p of A) {
    const k = vendorKey(p);
    if (!presence.has(k)) presence.set(k, new Set());
    presence.get(k).add(monthOf(p));
  }
  const curV = groupVendors(cur), prevV = groupVendors(prev);
  const sibList = input.siblings ? input.siblings.filter(p => !own.has(String(p.property || '').trim().toUpperCase())) : null;
  const nbList = input.neighbours || null;

  // The duplicate rule, over the same postings: a check keyed to expense (CHKITM)
  // in the flagged month that repeats a bill already entered.
  const dupByCheck = new Map();
  try {
    for (const f of duplicatePayments.findDuplicates(A)) {
      if (!cur.some(p => p.txnId && String(p.txnId) === String(f.check.id))) continue;
      if (!dupByCheck.has(f.check.id)) dupByCheck.set(f.check.id, { check: f.check, findings: [], dup: 0, credits: [] });
      const e = dupByCheck.get(f.check.id);
      e.findings.push(f); e.dup = round2(e.dup + f.duplicateAmount);
      for (const c of f.credits || []) if (!e.credits.some(x => x.id === c.id)) e.credits.push(c);
    }
  } catch (e) { /* the rule is a bonus; a posting shape it cannot read just means it does not fire */ }

  const checked = [`General Ledger postings on ${input.line.label} for ${monthName(addMonths(month, -HISTORY_MONTHS))}–${monthName(month)} (${A.length} postings)`];
  const limits = [];
  if (lyCtx) checked.push(`the same line around ${monthName(lyM)} last year (${lyCtx.length} postings)`);
  else limits.push(input.lastYearNote || 'The same month last year was not pulled, so "new vendor" and "annual bill" are judged on the last five months alone.');
  if (sibList) checked.push(`the entity's other buildings on this line, ${monthName(prevM)}–${monthName(month)} (${sibList.length} postings)`);
  else if (input.siblingsNote) limits.push(input.siblingsNote);
  if (nbList) checked.push(`this building's neighbouring GL lines (${nbList.length} postings)`);
  else if (input.neighboursNote) limits.push(input.neighboursNote);
  checked.push('the duplicate-payment rule (a check keyed to expense that repeats a bill)');

  const base = {
    month, monthName: monthName(month), prevMonth: prevM, prevMonthName: monthName(prevM),
    lastYearMonth: lyM, lastYearMonthName: monthName(lyM),
    totals: { cur: curT, prev: prevT, lastYear: lyT, vsPrev: round2(curT - prevT), vsLastYear: lyT == null ? null : round2(curT - lyT) },
    postingCount: { cur: cur.length, prev: prev.length },
    // Only the flagged month: the report lists these as "Postings behind the month" instead of pulling
    // the same General Ledger window a second time. Past the cap the page pulls its own list.
    postings: { month, cur: cur.slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, POSTINGS_SHOWN_CUR).map(slimPosting),
      truncated: cur.length > POSTINGS_SHOWN_CUR },
    checked, limits,
  };

  let mode, target;
  if (!cur.length) { mode = 'blank'; target = null; }
  else if (curT < 0) { mode = 'credit'; target = curT; }
  else { mode = 'change'; target = round2(curT - prevT); }

  // ── contributors ──────────────────────────────────────────────────────────
  const contribs = [];
  if (mode === 'blank') {
    const monthTotals = priorMonths.map(m => sumOf(A.filter(p => monthOf(p) === m))).filter(v => v !== 0);
    const usualTotal = monthTotals.length ? round2(monthTotals.reduce((t, v) => t + v, 0) / monthTotals.length) : 0;
    target = -usualTotal;
    const vendors = new Map();
    for (const p of A) { if (!priorMonths.includes(monthOf(p))) continue; const k = vendorKey(p); if (!vendors.has(k)) vendors.set(k, []); vendors.get(k).push(p); }
    for (const [k, list] of vendors) {
      const months = [...new Set(list.map(monthOf))];
      const byM = months.map(m => sumOf(list.filter(p => monthOf(p) === m)));
      const usual = round2(byM.reduce((t, v) => t + v, 0) / byM.length);
      contribs.push({ key: k, label: vendorLabel(list[0]), c: -usual, regular: months.length >= 3, usual, monthsPosted: months.length, list });
    }
  } else {
    const keys = new Set([...curV.keys(), ...prevV.keys()]);
    for (const k of keys) {
      const c = mode === 'credit' ? ((curV.get(k) || {}).total || 0) : round2(((curV.get(k) || {}).total || 0) - ((prevV.get(k) || {}).total || 0));
      contribs.push({ key: k, label: (curV.get(k) || prevV.get(k)).label, c });
    }
  }

  const absTarget = target == null ? 0 : Math.abs(target);
  if (mode !== 'blank' && absTarget < 1) {
    return { result: { ...base, ok: true, supported: true, mode: 'no-change', target: 0, findings: [], housekeeping: [], likely: null,
      couldNotDetermine: false,
      summary: `The postings for ${base.monthName} total ${usd(curT)}, the same as ${base.prevMonthName} (${usd(prevT)}) — there is no change in the postings to explain.`,
      next: 'The postings agree with last month. If the flag still looks wrong, compare the P&L figure with the General Ledger total above — a difference there is a timing or mapping question for accounting.',
      explained: { amount: 0, pct: null }, offset: 0 }, billTargets: [] };
  }
  const s = target < 0 ? -1 : 1;
  const threshold = Math.min(100, 0.05 * absTarget);
  const chosen = contribs.filter(x => (mode !== 'blank' || x.regular || prevV.has(x.key)) && s * x.c >= Math.max(1, threshold)).sort((a, b) => s * b.c - s * a.c).slice(0, MAX_FINDINGS);
  const offset = round2(contribs.filter(x => s * x.c < 0).reduce((t, x) => t + Math.abs(x.c), 0));

  // ── classify each contributor ─────────────────────────────────────────────
  const sameVendor = (list, k) => (list || []).filter(p => vendorKey(p) === k);
  const findings = chosen.map(x => classify(x));

  function classify(x) {
    const k = x.key;
    const v = { label: x.label };
    const curP = sameVendor(cur, k), prevP = sameVendor(prev, k);
    const presentMonths = presence.get(k) || new Set();
    const priorPresent = priorMonths.filter(m => presentMonths.has(m));
    const priorTotals = priorPresent.map(m => sumOf(A.filter(p => vendorKey(p) === k && monthOf(p) === m)));
    const avgPrior = priorTotals.length ? round2(priorTotals.reduce((t, a) => t + a, 0) / priorTotals.length) : 0;
    const curTotal = sumOf(curP), prevTotal = sumOf(prevP);
    const lyP = lyCtx ? sameVendor(lyCtx, k) : [];
    const matches = [];                               // every rule that fires, most specific first
    const add = (kind, confidence, headline, evidence, postings, extra) => matches.push({ kind, confidence, headline, evidence, postings, extra: extra || {} });

    // 1. a duplicate payment ----------------------------------------------
    for (const p of curP) {
      const d = dupByCheck.get(String(p.txnId));
      if (!d || matches.some(m => m.kind === 'duplicate')) continue;
      const billRefs = [...new Set(d.findings.map(f => f.bill.reference || `bill ${f.bill.id}`))];
      const ev = [`Check ${d.check.reference || d.check.id} (${dayName(d.check.date)}) was posted straight to expense accounts and repeats ${d.findings.length} bill line${d.findings.length === 1 ? '' : 's'} already entered (${billRefs.join(', ')}) for the same service period or invoice number — ${usd(d.dup)} counted twice.`];
      if (d.findings.some(f => f.amountsDiffer)) ev.push('The check and the bill differ by a dollar or more on at least one line.');
      for (const c of d.credits) {
        const chkAccts = [...new Set(d.findings.flatMap(f => f.lines.map(l => l.account)))];
        ev.push(`A credit of ${usd(c.amount)} (${dayName(c.date)}) was posted for this vendor on ${c.account}${chkAccts.length && !chkAccts.includes(c.account) ? `; the check's lines are on ${chkAccts.join(' and ')}, so the amount nets out but the accounts do not` : ''}.`);
      }
      add('duplicate', 'high', `${x.label}: a check keyed to expense repeats a bill already entered — ${usd(d.dup)} counted twice`, ev,
        curP.filter(q => String(q.txnId) === String(d.check.id)), { checkRef: d.check.reference || d.check.id, billRefs, dup: d.dup });
    }

    // 2. a credit or reversal ----------------------------------------------
    const curNeg = curP.filter(p => p.amount < 0);
    if (curNeg.length && (s < 0 || mode === 'credit')) {
      const ev = []; let reversedAll = true;
      for (const c of curNeg) {
        const orig = A.find(q => q.amount > 0 && vendorKey(q) === k && q.date <= c.date && Math.abs(q.amount + c.amount) <= 1);
        if (orig) ev.push(`Credit ${postingText(c)} reverses the ${dayName(orig.date)} charge of ${usd(orig.amount)}${orig.reference ? ` (ref ${orig.reference})` : ''}${monthOf(orig) !== month ? `, posted in ${monthName(monthOf(orig))}` : ''}.`);
        else { reversedAll = false; ev.push(`Credit ${postingText(c)} — no charge of that size from ${x.label} among the ${A.length} postings pulled (${monthName(addMonths(month, -HISTORY_MONTHS))}–${monthName(month)}).`); }
      }
      const total = Math.abs(sumOf(curNeg));
      add('credit', 'high', `${x.label}: ${curNeg.length === 1 ? 'a credit' : `${curNeg.length} credits`} of ${usd(total)} posted in ${base.monthName}`, ev, curNeg, { vendor: x.label, reversed: reversedAll });
    }
    const prevNeg = prevP.filter(p => p.amount < 0);
    if (s > 0 && mode === 'change' && prevNeg.length) {
      const credit = Math.abs(sumOf(prevNeg));
      if (credit >= 0.5 * x.c) {
        add('credit', 'high', `${x.label}: ${base.prevMonthName} was lowered by a credit of ${usd(credit)}, which is most of this month's rise`,
          [`${base.prevMonthName}: ${postingText(prevNeg[0])}${prevNeg.length > 1 ? ` and ${prevNeg.length - 1} more credit${prevNeg.length === 2 ? '' : 's'}` : ''}.`,
            `Without the credit ${base.prevMonthName} would have been ${usd(prevTotal + credit)} for ${x.label}, against ${usd(curTotal)} in ${base.monthName}.`],
          prevNeg, { vendor: x.label, reversed: true });
      }
    }

    // 3. posted to the wrong building or account ---------------------------
    const place = [];
    const siblingNames = list => [...new Set(list.map(p => p.property).filter(Boolean))].join(', ');
    if (sibList) {
      const sibCur = sameVendor(sibList.filter(p => monthOf(p) === month), k);
      const sibPrev = sameVendor(sibList.filter(p => monthOf(p) === prevM), k);
      for (const p of curP) {
        if (!(p.amount > 0)) continue;
        // Real pull 2026-10-22: a shared invoice number with a DIFFERENT amount is one invoice
        // allocated across lines or buildings, which is normal; and a same-amount twin that is
        // a sliver of the vendor's change ($543 of $8,886, $2,500 of $6,756) is a flat fee, not
        // the reason the line jumped. Both must be the whole story to be called a mis-posting.
        const material = p.amount >= 0.5 * Math.abs(x.c);
        const inv = p.invoiceNo ? sibCur.find(q => q.invoiceNo && String(q.invoiceNo).toUpperCase() === String(p.invoiceNo).toUpperCase() && Math.abs(q.amount - p.amount) < 0.01) : null;
        if (inv) { place.push({ conf: 'high', where: inv.property, text: `Invoice ${p.invoiceNo} from ${x.label} is also posted at ${inv.property} (${postingText(inv)}) — the same invoice number on two buildings.`, ps: [inv] }); continue; }
        const same = (p.amount >= 100 && material) ? sibCur.find(q => Math.abs(q.amount - p.amount) < 0.01) : null;
        if (same) place.push({ conf: 'medium', where: same.property, text: `${x.label} also posted exactly ${usd(p.amount)} at ${same.property} in ${base.monthName} (${postingText(same)}) — a bill split across buildings, or entered on the wrong one.`, ps: [same] });
      }
      if (s > 0 && sibPrev.length && !sibCur.length && sumOf(sibPrev) >= 0.6 * x.c) {
        place.push({ conf: 'medium', where: siblingNames(sibPrev), text: `${x.label} billed ${siblingNames(sibPrev)} ${usd(sumOf(sibPrev))} in ${base.prevMonthName} and nothing in ${base.monthName}; this building took ${usd(curTotal)} this month (${usd(prevTotal)} last month).`, ps: sibPrev });
      }
      if (s < 0 && sibCur.length && sumOf(sibCur) >= 0.6 * Math.abs(x.c)) {
        place.push({ conf: 'medium', where: siblingNames(sibCur), text: `${x.label} posted ${usd(sumOf(sibCur))} at ${siblingNames(sibCur)} in ${base.monthName}, while this building dropped ${usd(Math.abs(x.c))} — the charge may have moved.`, ps: sibCur });
      }
    }
    if (nbList) {
      const nbCur = sameVendor(nbList.filter(p => monthOf(p) === month), k);
      for (const p of curP) {
        if (!(p.amount > 0)) continue;
        const nbMaterial = p.amount >= 0.5 * Math.abs(x.c);   // see the note on the sibling rule above
        const twin = nbCur.find(q => Math.abs(q.amount - p.amount) < 0.01 && (p.invoiceNo && q.invoiceNo && String(q.invoiceNo).toUpperCase() === String(p.invoiceNo).toUpperCase() || (p.amount >= 100 && nbMaterial)));
        if (twin) place.push({ conf: p.invoiceNo && twin.invoiceNo ? 'high' : 'medium', where: twin.account,
          text: `${x.label}'s ${usd(p.amount)} also appears on ${twin.account} at this building in ${base.monthName} (${postingText(twin)})${p.invoiceNo && twin.invoiceNo ? ' with the same invoice number' : ''} — charged to two accounts, or keyed to the wrong one.`, ps: [twin] });
      }
      const nbPrior = priorMonths.filter(m => nbList.some(q => vendorKey(q) === k && monthOf(q) === m));
      if (nbPrior.length >= 2 && !nbCur.length && priorPresent.length <= 1) {
        const acct = (nbList.find(q => vendorKey(q) === k) || {}).account;
        place.push({ conf: 'medium', where: acct, text: `${x.label} posted to ${acct} in ${nbPrior.length} of the 5 months before ${base.monthName} but has nothing there this month; this month it is on ${input.line.label}.`, ps: nbList.filter(q => vendorKey(q) === k) });
      }
    }
    if (place.length) {
      place.sort((a, b) => (a.conf === 'high' ? 0 : 1) - (b.conf === 'high' ? 0 : 1));
      add('wrong-place', place[0].conf, `${x.label}: the same bill or vendor shows up on another building or account in ${base.monthName}`,
        place.map(q => q.text), [...curP, ...place.flatMap(q => q.ps)], { vendor: x.label, where: place[0].where });
    }

    // 4. a catch-up of earlier months --------------------------------------
    if (s > 0) {
      const ev = []; const ps = []; let conf = 'high';
      // A vendor whose bills ALWAYS cover a quarter is on its cycle, not catching up.
      const usuallyLong = A.some(q => vendorKey(q) === k && priorMonths.includes(monthOf(q)) && (periodOf(q) || {}).days > 45);
      for (const p of curP) {
        const per = periodOf(p);
        if (!per) continue;
        if (per.days > 45 && !usuallyLong) { ev.push(`${postingText(p)} covers ${per.text} — about ${Math.round(per.days / 30)} months in one posting.`); ps.push(p); }
        else if (per.to < new Date(`${monthStart(prevM)}T00:00:00Z`)) { ev.push(`${postingText(p)} is for ${per.text}, which ended before ${base.prevMonthName}.`); ps.push(p); }
      }
      if (!ev.length && !prevP.length && priorPresent.length >= 2 && avgPrior > 0 && curTotal >= 1.6 * avgPrior) {
        conf = 'medium';
        ev.push(`${x.label} posted in ${priorPresent.length} of the 5 months before (about ${usd(avgPrior)} a month) but nothing in ${base.prevMonthName}; ${base.monthName} is ${usd(curTotal)}, ${(curTotal / avgPrior).toFixed(1)}× the usual — consistent with a skipped month billed together.`);
        ps.push(...curP);
      }
      if (ev.length) add('catch-up', conf, `${x.label}: ${base.monthName} includes charges for earlier months`, ev, ps, { vendor: x.label });
    }

    // 5. a quarterly or annual bill landing --------------------------------
    if (s > 0 && curTotal > 0) {
      const m3 = addMonths(month, -3);
      if (presentMonths.has(m3) && !presentMonths.has(prevM) && !presentMonths.has(addMonths(month, -2))) {
        const then = sameVendor(A, k).filter(p => monthOf(p) === m3);
        add('cycle', 'medium', `${x.label}: posted in ${base.monthName} and ${monthName(m3)} with nothing between — consistent with a quarterly bill`,
          [`${monthName(m3)}: ${usd(sumOf(then))} (${postingText(then[0])}).`, `${base.monthName}: ${usd(curTotal)} — ${curTotal >= sumOf(then) ? pctTxt(curTotal / (sumOf(then) || 1) - 1) + ' more' : pctTxt(1 - curTotal / (sumOf(then) || 1)) + ' less'} than that quarter's.`,
            `Nothing from ${x.label} in ${base.prevMonthName} or ${monthName(addMonths(month, -2))}.`], [...curP, ...then], { vendor: x.label });
      } else if (lyP.length && !priorPresent.length) {
        add('cycle', 'medium', `${x.label}: posted ${base.monthName} and the same time last year, nothing in the five months between — consistent with an annual bill`,
          [`Last year: ${postingText(lyP[0])} (${usd(sumOf(lyP))} in total around ${monthName(lyM)}).`, `This year: ${usd(curTotal)} in ${base.monthName}.`],
          [...curP, ...lyP], { vendor: x.label });
      }
    }

    // 6. a new vendor ------------------------------------------------------
    if (s > 0 && curTotal > 0 && !priorPresent.length && !(lyCtx && lyP.length)) {
      add('new-vendor', 'medium', `${x.label} is new on this line: no postings in the 5 months before ${base.monthName}${lyCtx ? ` or around ${monthName(lyM)} last year` : ''}`,
        [`${base.monthName}: ${curP.map(postingText).join('; ')}.`, `Searched ${A.length} postings${lyCtx ? ` and ${lyCtx.length} from last year` : ''} on ${input.line.label} for this vendor.`], curP, { vendor: x.label });
    }

    // 7. a vendor billing more than usual ----------------------------------
    if (s > 0 && priorPresent.length && avgPrior > 0 && curTotal >= 1.25 * avgPrior && curTotal - avgPrior >= 100) {
      add('vendor-more', 'high', `${x.label} billed ${usd(curTotal)} in ${base.monthName} against about ${usd(avgPrior)} a month before (+${pctTxt(curTotal / avgPrior - 1)})`,
        [`It posted in ${priorPresent.length} of the 5 months before (${priorPresent.map(monthName).join(', ')}), averaging ${usd(avgPrior)} in the months it posted.`, `${base.monthName}: ${curP.map(postingText).join('; ')}.`],
        curP, { vendor: x.label });
    }

    // 8. one big bill --------------------------------------------------------
    if (s > 0 && curP.length) {
      const top = curP.slice().sort((a, b) => b.amount - a.amount)[0];
      if (top.amount >= 500 && top.amount >= 0.5 * curT) {
        add('one-big-bill', 'high', `${x.label}: one posting of ${usd(top.amount)} is ${pctTxt(Math.min(1, top.amount / (curT || top.amount)))} of ${base.monthName}'s ${usd(curT)}`,
          [`${postingText(top)}${top.invoiceNo ? ` — invoice ${top.invoiceNo}` : ''}.`], [top], { vendor: x.label });
      }
    }

    // 9. the other direction: a regular bill that did not post, a lower bill
    if (s < 0 && mode !== 'credit') {
      if (mode === 'blank') {
        if (x.regular) {
          const where = (nbList ? sameVendor(nbList.filter(p => monthOf(p) === month), k) : []);
          if (where.length) add('wrong-place', 'high', `${x.label} posted ${usd(sumOf(where))} in ${base.monthName} — to ${[...new Set(where.map(p => p.account))].join(' and ')}, not ${input.line.label}`, where.map(p => `${postingText(p)} on ${p.account}.`), where, { vendor: x.label, where: where[0].account });
          add('missing-bill', 'high', `${x.label} posted in ${x.monthsPosted} of the 5 months before (about ${usd(x.usual)} a month) and has nothing in ${base.monthName}`,
            [`Earlier months: ${[...new Set(x.list.map(monthOf))].sort().map(monthName).join(', ')}.`, `Biggest earlier posting: ${postingText(x.list.slice().sort((a, b) => b.amount - a.amount)[0])}.`], x.list, { vendor: x.label });
        } else if (prevP.length) {
          add('one-off-gone', 'high', `${x.label}'s ${usd(prevTotal)} in ${base.prevMonthName} did not repeat — it posted in only ${x.monthsPosted} of the 5 months before ${base.monthName}`,
            [`${base.prevMonthName}: ${prevP.map(postingText).join('; ')}.`], prevP, { vendor: x.label });
        }
      } else {
        if (!curP.length) {
          if (priorPresent.length >= 3) add('missing-bill', 'high', `${x.label} posted in ${priorPresent.length} of the 5 months before (about ${usd(avgPrior)} a month) and has nothing in ${base.monthName}`,
            [`${base.prevMonthName}: ${prevP.map(postingText).join('; ')}.`], prevP, { vendor: x.label });
          else add('one-off-gone', 'high', `${x.label}'s ${usd(prevTotal)} in ${base.prevMonthName} did not repeat — it posted in only ${priorPresent.length} of the 5 months before ${base.monthName}`,
            [`${base.prevMonthName}: ${prevP.map(postingText).join('; ')}.`], prevP, { vendor: x.label });
        } else if (priorPresent.length && avgPrior > 0 && curTotal <= 0.8 * avgPrior) {
          add('vendor-less', 'high', `${x.label} billed ${usd(curTotal)} in ${base.monthName} against about ${usd(avgPrior)} a month before`,
            [`${base.monthName}: ${curP.map(postingText).join('; ')}.`, `Earlier months it posted in: ${priorPresent.map(monthName).join(', ')}.`], curP, { vendor: x.label });
        }
      }
    }

    // ── the most specific rule that fired is the finding ────────────────────
    const order = ['duplicate', 'credit', 'wrong-place', 'catch-up', 'cycle', 'new-vendor', 'vendor-more', 'one-big-bill', 'missing-bill', 'one-off-gone', 'vendor-less'];
    matches.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const dollars = Math.abs(x.c);
    if (!matches.length) {
      const list = curP.length ? curP : prevP;
      const f = {
        kind: 'other', confidence: 'none', dollars, vendor: x.label,
        headline: `${x.label}: ${usd(curTotal)} in ${base.monthName} against ${usd(prevTotal)} in ${base.prevMonthName} — nothing in the postings says why`,
        evidence: [`${base.monthName}: ${curP.length ? curP.map(postingText).join('; ') : 'no postings'}.`, `${base.prevMonthName}: ${prevP.length ? prevP.map(postingText).join('; ') : 'no postings'}.`],
        postings: cite(list), also: [],
      };
      f.next = nextFor('other', { vendor: x.label });
      return f;
    }
    const m = matches[0];
    const f = {
      kind: m.kind, confidence: m.confidence, dollars: m.kind === 'duplicate' ? Math.min(dollars, m.extra.dup) : dollars, vendor: x.label,
      headline: m.headline, evidence: m.evidence, postings: cite(m.postings),
      also: matches.slice(1).map(o => ({ kind: o.kind, note: o.headline })),
    };
    f.next = nextFor(m.kind, { vendor: x.label, ...m.extra });
    return f;
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  const classified = findings.filter(f => f.kind !== 'other').sort((a, b) => b.dollars - a.dollars);
  const unclassified = findings.filter(f => f.kind === 'other').sort((a, b) => b.dollars - a.dollars);
  const ranked = [...classified, ...unclassified].map((f, i) => ({ rank: i + 1, ...f, pctOfChange: absTarget ? round2(Math.min(1, f.dollars / absTarget)) : null }));
  const explainedAmt = round2(Math.min(absTarget, ranked.reduce((t, f) => t + f.dollars, 0)));
  const classifiedAmt = round2(Math.min(absTarget, classified.reduce((t, f) => t + f.dollars, 0)));
  const classifiedShare = absTarget ? classifiedAmt / absTarget : 0;
  const likely = classified.length && classifiedShare >= 0.5 ? ranked[0] : null;

  let summary, nextLine;
  const moved = mode === 'blank'
    ? `${base.monthName} has no postings on ${input.line.label}; the five months before averaged ${usd(absTarget)} a month.`
    : mode === 'credit'
      ? `${base.monthName} nets to ${usd(curT)} — credits outweigh charges.`
      : `${base.monthName} is ${usd(curT)} against ${usd(prevT)} in ${base.prevMonthName} (${target >= 0 ? '+' : '-'}${usd(Math.abs(target))})${lyT != null ? `, and ${usd(lyT)} in ${monthName(lyM)} last year` : ''}.`;
  if (likely) {
    summary = `${moved} ${ranked.length === 1 || explainedAmt >= absTarget ? 'The postings account for it' : `The postings named below account for ${usd(explainedAmt)} (${pctTxt(explainedAmt / absTarget)}) of it`}. Most likely: ${likely.headline}.`;
    nextLine = likely.next;
  } else if (classified.length) {
    summary = `${moved} The postings do not settle it: the clearest finding, ${classified[0].headline}, accounts for ${usd(classified[0].dollars)} (${pctTxt(classified[0].dollars / absTarget)}) of the change and nothing else is explained. Could not determine the cause from Rent Manager's postings.`;
    nextLine = classified[0].next;
  } else {
    summary = `${moved} Could not determine the cause: ${ranked.length ? `the biggest mover, ${ranked[0].vendor} (${usd(ranked[0].dollars)}, ${pctTxt(ranked[0].dollars / absTarget)} of the change), has nothing in its postings` : 'no single vendor moved enough to account for it, and nothing in the postings'} — service period, history, invoice number, duplicates, other buildings or neighbouring accounts — that explains it.`;
    nextLine = ranked.length ? ranked[0].next
      : `Open the ${input.line.label} postings for ${base.monthName} in Rent Manager and read the invoices for the biggest ones; the postings pulled do not point to a cause.`;
  }

  const billTargets = [];
  const seen = new Set();
  for (const x of chosen) {
    for (const p of sameVendor(cur, x.key)) {
      if (p.txnType === 'BILLITM' && p.amount > 0 && p.txnId && !seen.has(p.txnId)) { seen.add(p.txnId); billTargets.push(p); }
    }
  }
  billTargets.sort((a, b) => b.amount - a.amount);

  return {
    result: {
      ...base, ok: true, supported: true, mode, target, summary, next: nextLine,
      findings: ranked, housekeeping: [],
      likely: likely ? { kind: likely.kind, confidence: likely.confidence, headline: likely.headline, evidence: likely.evidence, next: likely.next } : null,
      couldNotDetermine: !likely,
      explained: { amount: explainedAmt, pct: absTarget ? round2(explainedAmt / absTarget) : null },
      offset,
      lastYearReading: lastYearReading(cur, lyExact, lyT, curT),
    },
    billTargets: billTargets.slice(0, BILL_LOOKUPS),
  };
}

// The same month a year earlier, vendor by vendor — the second comparison the
// brief asks for. Top three movers and how much of the year-on-year change they
// are; nothing more is said about them.
function lastYearReading(cur, lyExact, lyT, curT) {
  if (!lyExact) return null;
  const a = groupVendors(cur), b = groupVendors(lyExact);
  const delta = round2(curT - lyT);
  const movers = [...new Set([...a.keys(), ...b.keys()])].map(k => ({
    vendor: (a.get(k) || b.get(k)).label, cur: (a.get(k) || {}).total || 0, lastYear: (b.get(k) || {}).total || 0,
  })).map(m => ({ ...m, change: round2(m.cur - m.lastYear) }))
    .filter(m => Math.abs(m.change) >= 1 && Math.sign(m.change) === Math.sign(delta || 1))
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change)).slice(0, 3);
  return { total: lyT, delta, movers, explained: delta ? round2(Math.min(1, movers.reduce((t, m) => t + Math.abs(m.change), 0) / Math.abs(delta))) : null };
}

// ── what the bills say ─────────────────────────────────────────────────────
// backupFor(bill) payloads in, housekeeping items out. A bill that is missing its
// invoice, unapproved or unpaid is not why the month moved — it is what is wrong
// with the postings that did — so it is listed apart from the cause.
function billFindings(lookups) {
  const out = [], limits = [];
  for (const { posting: p, backup, error } of lookups) {
    const who = `${vendorLabel(p)}, ${usd(p.amount)}, ${dayName(p.date)}`;
    if (error || !backup) { limits.push(`Bill lookup for ${who} did not finish: ${error || 'no answer'}.`); continue; }
    const bill = backup.bill;
    if (!bill) {
      if (backup.payment && backup.payment.direct) continue;     // paid straight to the payee — there is no bill to look at
      out.push({ kind: 'no-bill', vendor: vendorLabel(p), posting: slimPosting(p),
        headline: `No AP bill was found for ${who}`,
        evidence: [(backup.unavailable || [])[0] || 'Rent Manager returned no bill for this posting.'],
        next: 'In Rent Manager search the vendor\'s bills around this date. It may be a journal entry or a period adjustment; if it should be a bill, the invoice is missing from AP.' });
      continue;
    }
    const num = bill.number ? `#${bill.number}` : `id ${bill.id}`;
    if (!(backup.attachments || []).length) out.push({ kind: 'no-invoice', vendor: vendorLabel(p), posting: slimPosting(p), headline: `Bill ${num} (${who}) has no invoice file attached`,
      evidence: ['The bill was found in Rent Manager; nothing is attached to it.'], next: 'Attach the vendor\'s invoice to the bill in Rent Manager.' });
    if (bill.approval && bill.approval.approved === false) out.push({ kind: 'unapproved', vendor: vendorLabel(p), posting: slimPosting(p), headline: `Bill ${num} (${who}) is not approved`,
      evidence: ['Rent Manager shows the bill as not approved.'], next: 'Have the bill approved in Rent Manager, or find out why it is waiting.' });
    const paymentUnreachable = (backup.unavailable || []).some(u => /could not be reached/i.test(u));
    if (!backup.payment && !paymentUnreachable) out.push({ kind: 'unpaid', vendor: vendorLabel(p), posting: slimPosting(p), headline: `Bill ${num} (${who}) has no payment applied`,
      evidence: ['No check or EFT is applied to the bill — on an accrual basis it is entered, not yet paid.'], next: 'Check in Rent Manager whether the bill is waiting to be paid or was paid another way.' });
  }
  return { items: out, limits };
}

// ── the orchestrator ───────────────────────────────────────────────────────
const _cache = new Map();         // key → { at, stamp, payload }
const _inflight = new Map();

function withTimeout(promise, ms, what) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}
const reason = e => String((e && e.message) || e || 'unknown error').replace(/^Rent Manager:\s*/, '');

async function run({ scope, key, month }, deps) {
  const refs = deps.refsFor(key);
  const lineLabel = deps.lineLabel ? deps.lineLabel(key) : key;
  const stamp = deps.now().toISOString();
  const head = { ok: true, scope, key, month, line: lineLabel, label: 'Cedar Ridge analysis of Rent Manager data', generatedAt: stamp,
    reports: [{ id: 51, name: 'General Ledger (accrual)' }] };
  if (!refs) {
    return { ...head, supported: false, reason: `${lineLabel} has no GL accounts behind it, so there are no postings to look at.` };
  }
  const sc = await deps.resolveScope(scope);
  const startDate = monthStart(addMonths(month, -HISTORY_MONTHS)), endDate = monthEnd(month);
  const window = await deps.getGLDetail({ propOwnerIds: sc.propOwnerIds, refs, startDate, endDate });

  const lyM = addMonths(month, -12);
  const nbRefs = [...new Set((NEIGHBOURS[key] || []).flatMap(k => deps.refsFor(k) || []))].filter(r => !refs.includes(r));
  const single = sc.kind === 'property';
  const optional = await Promise.allSettled([
    deps.getGLDetail({ propOwnerIds: sc.propOwnerIds, refs, startDate: monthStart(addMonths(lyM, -1)), endDate: monthEnd(addMonths(lyM, 1)) }),
    single && sc.siblingOwnerIds && sc.siblingOwnerIds.length
      ? deps.getGLDetail({ propOwnerIds: sc.siblingOwnerIds.join(','), refs, startDate: monthStart(addMonths(month, -1)), endDate }) : Promise.resolve(null),
    single && nbRefs.length
      ? deps.getGLDetail({ propOwnerIds: sc.propOwnerIds, refs: nbRefs, startDate, endDate }) : Promise.resolve(null),
  ]);
  const ok = r => (r.status === 'fulfilled' ? r.value : null);
  const [lyR, sibR, nbR] = optional;
  const input = {
    month, line: { key, label: lineLabel }, scope: sc,
    window: window.postings || [],
    lastYear: ok(lyR) ? ok(lyR).postings || [] : null,
    lastYearNote: lyR.status === 'rejected' ? `The same month last year could not be pulled (${reason(lyR.reason)}), so "new vendor" and "annual bill" are judged on the last five months alone.` : null,
    siblings: ok(sibR) ? ok(sibR).postings || [] : null,
    siblingsNote: !single ? `Sibling buildings were not compared: this flag is ${sc.kind === 'entity' ? 'entity' : 'portfolio'}-wide, which already includes every building.`
      : (sibR.status === 'rejected' ? `Sibling buildings could not be pulled (${reason(sibR.reason)}), so a bill on the wrong building would not be seen.`
        : 'This entity has no other buildings to compare with.'),
    neighbours: ok(nbR) ? ok(nbR).postings || [] : null,
    neighboursNote: !single ? null : (nbR.status === 'rejected' ? `Neighbouring GL lines could not be pulled (${reason(nbR.reason)}), so a bill on the wrong account would not be seen.`
      : (!nbRefs.length ? (NEIGHBOURS[key] ? `${lineLabel}'s neighbouring lines have no GL accounts to read, so a bill on the wrong account would not be seen.`
        : `${lineLabel} has no neighbouring line that a bill is commonly keyed to by mistake.`) : null)),
  };
  if (!single && !input.neighboursNote) input.neighboursNote = 'Neighbouring accounts were not compared for a multi-building scope.';

  const { result, billTargets } = analyze(input);
  const out = { ...head, ...result, scopeLabel: sc.label, scopeKind: sc.kind };

  // Bill status for the biggest bills behind the findings. Sequential and capped:
  // each lookup is several Rent Manager requests.
  if (deps.billBackup && billTargets.length) {
    const lookups = [];
    for (const p of billTargets) {
      try { lookups.push({ posting: p, backup: await withTimeout(deps.billBackup(p, sc), BILL_LOOKUP_MS, 'The bill lookup') }); }
      catch (e) { lookups.push({ posting: p, error: reason(e) }); }
    }
    const b = billFindings(lookups);
    out.housekeeping = b.items;
    out.limits = [...out.limits, ...b.limits];
    out.checked = [...out.checked, `bill status in Rent Manager for the ${billTargets.length} biggest bill${billTargets.length === 1 ? '' : 's'} behind the findings (invoice attached, approved, paid)`];
    out.reports = [...out.reports, { id: null, name: 'AP bills (/Bills)' }];
  }
  return out;
}

async function investigate(args, deps) {
  const { scope, key, month } = args || {};
  if (!scope || !key || !MONTH_RE.test(month || '')) {
    const e = new Error('Need scope, key and month=YYYY-MM.'); e.code = 'BAD_REQUEST'; throw e;
  }
  const snap = deps.snapshotStamp ? deps.snapshotStamp() : '';
  const ck = `${snap}|${scope}|${key}|${month}`;
  const hit = _cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.payload, fromCache: true };
  if (_inflight.has(ck)) return _inflight.get(ck);
  const p = run({ scope, key, month }, deps).then(payload => {
    if (_cache.size >= 400) _cache.delete(_cache.keys().next().value);
    _cache.set(ck, { at: Date.now(), payload });
    return payload;
  }).finally(() => _inflight.delete(ck));
  _inflight.set(ck, p);
  return p;
}

module.exports = {
  investigate, analyze, billFindings, lastYearReading, NEIGHBOURS,
  addMonths, monthName, vendorKey, periodOf,
  __resetCache: () => { _cache.clear(); _inflight.clear(); },
};
