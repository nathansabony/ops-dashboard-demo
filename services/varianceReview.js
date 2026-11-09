// The review every flag gets, built the same way each time.
//
// The owner, 2026-11-02: "the PDF form should be for everything … the hand reviews,
// that format should be expanded to every single variance as an automatic thing
// … at the top, in plain English what the actual issue is … a one sentence as to
// why this thing was flagged, and then after doing a full review, what came back
// is the real answer … we're not changing the accounting … we're just catching
// all the mistakes."
//
// services/varianceInvestigation.js says WHAT moved and which postings account
// for it. This reads the BILLS behind those postings as well — paid or open, past
// due, approved before or after it was paid, invoice attached, who keyed it and
// when — and puts one plain conclusion on top. Same shape as the hand reviews in
// config/variance-reviews.json (which still win for the flags they cover), so one
// renderer draws both.
//
// Rules, not a language model: every sentence is assembled from a posting, a bill
// field, a date or an amount printed beside it. Where the data shows nothing, the
// verdict is "unexplained" and the conclusion says what was looked at. Nothing
// here changes Rent Manager; the actions are things to check or raise.
//
// The kinds a conclusion can take (found by hand across the first eleven flags):
//   duplicate      the same bill entered twice, or a check that repeats a bill
//   wrong-account  money coded to an expense that the payee's history puts elsewhere
//   timing         a year (or years) of cost booked in one month; a catch-up; a credit
//   correction     a back-dated or corrected bill that moved a closed month
//   concentration  one big bill, all on one building
//   unpaid         bills entered but not paid, past their due date
//   paperwork      real-looking cost with no invoice behind it
//   real           an ordinary cost, with its invoice, that simply was large
//   unexplained    the postings do not say why
//
// Pure where it can be: build() takes postings, bill lookups and payee history in
// and gives the review out, so scripts/checkVarianceReview.js proves each rule on
// canned payloads without a network.

const {
  usd, round2, addMonths, monthName, monthOf, vendorKey, vendorLabel, periodOf, slimPosting,
} = require('./varianceInvestigation');

const VERDICT_LABEL = {
  duplicate: 'Same bill entered twice',
  'wrong-account': 'Coded to the wrong kind of account',
  timing: 'Booked in the wrong month',
  correction: 'Back-dated or corrected bill',
  concentration: 'One big bill on one building',
  unpaid: 'Unpaid or past due',
  paperwork: 'No backup on file',
  real: 'Looks like a real cost',
  unexplained: 'The postings do not say why',
};
// The order a conclusion is chosen in: the most specific mistake first.
const PRIORITY = ['duplicate', 'wrong-account', 'timing', 'correction', 'concentration', 'unpaid', 'paperwork', 'real', 'unexplained'];
const MIN_SHARE = 0.25;               // a cause must carry a quarter of the move to be the conclusion
const BACKDATED_DAYS = 45;

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pct = r => `${Math.round(r * 100)}%`;
const txnKey = p => (p.txnId ? `${p.txnType}|${p.txnId}` : `p|${p.id}`);
const dayText = iso => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]} ${Number(m[3])}` : String(iso || '');
};
const daysBetween = (a, b) => Math.round((new Date(String(b).slice(0, 10)) - new Date(String(a).slice(0, 10))) / 86400000);

function groupTxns(list) {
  const m = new Map();
  for (const p of list) {
    const k = txnKey(p);
    if (!m.has(k)) m.set(k, { key: k, type: p.txnType, id: p.txnId, vendor: vendorLabel(p), vendorId: p.vendorId, ref: p.reference, invoiceNo: p.invoiceNo,
      date: p.date, description: p.description, total: 0, lines: 0, biggest: p, props: new Set(), postings: [] });
    const g = m.get(k);
    g.total = round2(g.total + p.amount); g.lines++; g.postings.push(p); g.props.add(p.property);
    if (Math.abs(p.amount) > Math.abs(g.biggest.amount)) g.biggest = p;
  }
  return [...m.values()];
}

// What a bill lookup (rmDocuments.backupFor) says, reduced to the facts a rule needs.
function factsOf(lk, today) {
  if (!lk || lk.error || !lk.backup) return { known: false, error: lk && lk.error };
  const b = lk.backup.bill || null, pay = lk.backup.payment || null, files = lk.backup.attachments || [];
  const direct = Boolean(pay && pay.direct) || (!b && Boolean(pay));
  const al = b && b.allocated && Number.isFinite(b.allocated.amount) ? b.allocated : null;
  const remaining = al && Number.isFinite(b.amount) ? round2(b.amount - al.amount) : null;
  // A bill is settled when Rent Manager has allocated all of it (to a check, or to a credit);
  // part-paid when some but not all; otherwise by whether any payment is applied.
  const paid = remaining != null ? remaining <= 0.01 : Boolean(pay && !(pay.paid === false));
  const part = remaining != null && al.amount > 0.01 && remaining > 0.01;
  const approvedOn = b && b.approval && b.approval.approved ? b.approval.on : null;
  const f = {
    known: true, hasBill: Boolean(b), direct, paid, part, remaining, viaCredit: Boolean(paid && !pay), files: files.map(a => ({ id: a.id, name: a.name || a.fileName || `file ${a.id}` })),
    billId: b ? b.id : null, number: b ? b.number : null, amount: b ? b.amount : null, dueDate: b ? b.dueDate : null,
    enteredBy: b ? b.enteredBy : null, enteredOn: b ? b.enteredOn : null, billDate: b ? b.date : null,
    approved: b && b.approval ? b.approval.approved : null, approvedBy: b && b.approval ? b.approval.by : null, approvedOn,
    paidOn: pay ? pay.paidOn || null : null, payRef: pay ? pay.reference || null : null, cleared: pay ? Boolean(pay.reconciled) : false,
    allocated: b ? b.allocated : null, lineProps: b && Array.isArray(b.lines) ? [...new Set(b.lines.map(l => l.propertyId))] : [], lineCount: b ? b.lineCount || (b.lines || []).length : 0,
    comment: b && Array.isArray(b.other) ? (b.other.find(o => o.field === 'Comment') || {}).value || '' : '',
  };
  f.financed = /financ|instal+ment|payment plan/i.test(f.comment);
  f.pastDue = Boolean(f.hasBill && !f.paid && !f.financed && f.dueDate && today && String(f.dueDate).slice(0, 10) < today);
  f.paidBeforeApproved = Boolean(f.paidOn && f.approvedOn && String(f.paidOn).slice(0, 10) < String(f.approvedOn).slice(0, 10));
  f.paidLateDays = f.paid && f.paidOn && f.dueDate ? daysBetween(f.dueDate, f.paidOn) : 0;
  return f;
}

function billRow(t, f, month, flaggedDup) {
  const status = [];
  let tone = 'ok';
  if (t.type === 'JOURNL') status.push('Journal entry — no bill');
  else if (/^CR/i.test(t.type)) status.push('Credit');
  else if (!f.known) { status.push('Not checked — only the biggest transactions are looked up'); tone = 'warn'; }
  else if (f.direct && !f.hasBill) {
    status.push(`Paid directly${f.payRef ? ` (${f.payRef})` : ''}${f.paidOn ? ` ${dayText(f.paidOn)}` : ''} — no bill behind it`);
    tone = 'warn';
  } else if (!f.hasBill) { status.push('No AP bill found'); tone = 'warn'; }
  else {
    if (f.paid && f.viaCredit) status.push('Settled by a credit (fully allocated)');
    else if (f.paid) status.push(`Paid${f.payRef ? ` (${f.payRef})` : ''}${f.paidOn ? ` ${dayText(f.paidOn)}` : ''}${f.cleared ? ', cleared' : ', not yet cleared'}${f.paidLateDays > 30 ? `, ${f.paidLateDays} days after it was due` : ''}`);
    else {
      status.push(f.financed ? `Financed — ${usd(f.amount - f.remaining)} of ${usd(f.amount)} paid so far`
        : f.part ? `Part-paid — ${usd(f.amount - f.remaining)} of ${usd(f.amount)} applied, ${usd(f.remaining)} open${f.pastDue ? `, past due since ${dayText(f.dueDate)}` : ''}`
        : (f.pastDue ? `Open — past due since ${dayText(f.dueDate)}` : 'Open — no payment applied'));
      tone = f.pastDue ? 'bad' : 'warn';
    }
    if (f.paid && f.paidLateDays > 30 && tone === 'ok') tone = 'warn';
    if (f.approved === false) { status.push('not approved'); if (tone === 'ok') tone = 'warn'; }
    else if (f.approved && f.approvedOn) status.push(`approved ${dayText(f.approvedOn)}`);
    if (f.enteredBy) status.push(`keyed by ${f.enteredBy}${f.enteredOn ? ` ${dayText(f.enteredOn)}` : ''}`);
    if (!f.files.length) status.push('no invoice');
  }
  if (flaggedDup) tone = 'bad';
  return {
    date: t.date, vendor: t.vendor, ref: t.ref || t.invoiceNo || '', billId: f.billId || (t.type === 'BILLITM' ? Number(t.id) || null : null),
    amount: t.total, account: [...new Set(t.postings.map(p => String(p.account).split(' ')[0]))].slice(0, 3).join('/'),
    status: status.join(' · '), tone, note: flaggedDup ? flaggedDup : '', posting: t.biggest.id, month, files: f.files || [],
  };
}

// ── the review ──────────────────────────────────────────────────────────────
// input: {
//   inv:     varianceInvestigation.analyze()'s result,
//   A:       postings for month-5 … month (slim),
//   lookups: [{posting, backup, error}] for the biggest transactions of the month,
//   payee:   Map(vendorKey → { total, offExpense, items:[{name,type,amount}] }) or null,
//   siblings, flag: { scopeLabel, line:{key,label}, month }, today: 'YYYY-MM-DD'
// }
function build(input) {
  const { inv, A = [], lookups = [], payee = null, flag, today } = input;
  const month = flag.month, prevM = addMonths(month, -1);
  const cur = A.filter(p => monthOf(p) === month);
  const where = flag.scopeLabel || 'this scope';
  const line = flag.line.label;
  const mName = monthName(month);
  const txns = groupTxns(cur).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const facts = new Map(lookups.map(l => [txnKey(l.posting), factsOf(l, today)]));
  const factFor = t => facts.get(t.key) || { known: false };
  const target = Math.abs(inv.target || 0);
  const curT = inv.totals ? inv.totals.cur : 0;
  const base = Math.max(target, 1);
  const cands = [];                      // every rule that fires; the highest-priority one big enough is the conclusion
  const add = c => cands.push({ confidence: 'Medium', actions: [], questions: [], happened: [], ...c });
  const lookedUp = lookups.length;

  // 1a. the same bill entered twice (same invoice number and amount, two bills) ----------------
  const dupRows = new Set();
  {
    const wide = groupTxns(A.filter(p => p.txnType === 'BILLITM' && p.amount > 0));
    const by = new Map();
    for (const t of wide) {
      const r = norm(t.ref);                    // the bill's own reference — a number parsed out of the memo is often just the account number
      if (r.length < 4) continue;
      const k = `${r}|${Math.round(t.total * 100)}`;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(t);
    }
    for (const list of by.values()) {
      if (list.length < 2 || !list.some(t => monthOf(t) === month || String(t.date).slice(0, 7) === month)) continue;
      const withFile = list.filter(t => factFor(t).files && factFor(t).files.length);
      const keep = withFile[0] || list.slice().sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      const extra = list.filter(t => t !== keep);
      const amt = list[0].total;
      list.forEach(t => dupRows.add(t.key));
      const names = [...new Set(list.map(t => t.vendor))];
      add({
        verdict: 'duplicate', dollars: amt * extra.length, confidence: 'High', label: 'Same bill entered twice',
        headline: `${names.join(' and ')}: the same ${usd(amt)} bill (invoice ${list[0].invoiceNo || list[0].ref}) is in Rent Manager ${list.length} times.`,
        happened: [
          `${list.length} bills carry invoice number ${list[0].invoiceNo || list[0].ref}, each ${usd(amt)}, dated ${[...new Set(list.map(t => dayText(t.date)))].join(' / ')}${names.length > 1 ? ` — under ${names.length} different vendor names, which is how Rent Manager's own duplicate check misses it` : ''}.`,
          ...list.map(t => {
            const f = factFor(t);
            return `Bill ${f.billId || t.id}${f.enteredBy ? ` was keyed by ${f.enteredBy}${f.enteredOn ? ` on ${dayText(f.enteredOn)}` : ''}` : ''}${f.known ? (f.files.length ? ' with the invoice attached' : ' with no invoice') : ''}${f.known && f.hasBill ? (f.paid ? ', and is paid' : ', and has no payment applied') : ''}.`;
          }),
        ],
        actions: [
          { who: 'Accounting', do: `Void the extra copy before it is paid (keep bill ${factFor(keep).billId || keep.id}${factFor(keep).files && factFor(keep).files.length ? ', the one with the invoice' : ''}).` },
          { who: 'Accounting', do: 'Merge the vendor records so the duplicate-invoice check catches the next one.' },
        ],
        questions: [], atIssueLabel: 'counted twice',
      });
    }
  }

  // 1b. a check keyed straight to expense that repeats a bill (the existing rule) -------------
  for (const f of inv.findings || []) {
    if (f.kind !== 'duplicate') continue;
    add({ verdict: 'duplicate', dollars: f.dollars, confidence: 'High', label: 'Paid twice', atIssueLabel: 'counted twice',
      headline: f.headline, happened: f.evidence || [],
      actions: [{ who: 'Accounting', do: f.next }], questions: [] });
  }

  // 2. a payment with no bill, to a payee whose history sits on another kind of account --------
  for (const t of txns) {
    if (t.type !== 'CHKITM' || t.total <= 0 || Math.abs(t.total) < MIN_SHARE * base) continue;
    const f = factFor(t);
    const h = payee && payee.get(vendorKey(t.biggest));
    const wire = /\b(wire|transfer|loan|advance)\b/i.test(`${t.description} ${t.ref}`);   // not bare "ACH": that is how ordinary vendors are paid
    if (h && h.total > 0 && h.offExpense / h.total >= 0.5) {
      const top = h.items.filter(i => i.type && !/expense/i.test(i.type)).sort((a, b) => b.amount - a.amount)[0];
      add({ verdict: 'wrong-account', dollars: t.total, confidence: 'High', label: 'Coded to the wrong kind of account', atIssueLabel: 'paid with no bill',
        headline: `${t.vendor}: ${usd(t.total)} was paid by check with no bill behind it and coded to ${(t.postings[0].account || 'an expense').replace(/^\d+(-\d+)?\s*/, '')}, but ${pct(h.offExpense / h.total)} of what ${t.vendor} has ever been paid is booked to ${top ? `${top.name} (${top.type})` : 'a non-expense account'}.`,
        happened: [
          `${dayText(t.date)}: ${usd(t.total)} to ${t.vendor}${t.ref ? ` (ref ${t.ref})` : ''}${t.description ? ` — ${String(t.description).slice(0, 80)}` : ''}${f.known && f.paidOn ? `, paid ${dayText(f.paidOn)}${f.cleared ? ' and cleared the bank' : ''}` : ''}.`,
          `${t.vendor}'s payment history in Rent Manager: ${h.items.slice(0, 4).map(i => `${usd(i.amount)} to ${i.name}${i.type ? ` (${i.type})` : ''}`).join('; ')}.`,
          'A payment keyed straight to an expense account with no bill is the pattern behind duplicate payments too — the books never see an invoice for it.',
        ],
        actions: [{ who: 'the owner / accounting', do: `Say what these payments to ${t.vendor} are (loan, transfer, owner distribution, or a real cost).` },
          { who: 'Accounting', do: `If they are the same kind of payment ${t.vendor} was paid before, they belong on ${top ? top.name : 'that account'}, not on ${line}.` }],
        questions: [`What is ${t.vendor} to ${where}?`] });
    } else if (!wire && (!f.known || !f.hasBill) && t.total >= 0.5 * base) {
      add({ verdict: 'paperwork', dollars: t.total, confidence: 'Medium', label: 'Paid with no bill behind it', atIssueLabel: 'paid with no bill',
        headline: `${t.vendor}: a ${usd(t.total)} check was keyed straight to ${line} with no bill behind it — the books never saw an invoice for it.`,
        happened: [`${dayText(t.date)}: ${usd(t.total)} to ${t.vendor}${t.ref ? ` (ref ${t.ref})` : ''}${t.description ? ` — ${String(t.description).slice(0, 80)}` : ''}.`,
          'A check written directly to an expense account skips the bill, so nothing stops it from repeating a bill that was already paid.'],
        actions: [{ who: 'Accounting', do: `Check whether ${t.vendor} also billed this amount through AP (a bill for the same period would mean it was paid twice), and attach the invoice to the check.` }], questions: [] });
    } else if (wire && (!f.known || !f.hasBill)) {
      add({ verdict: 'wrong-account', dollars: t.total, confidence: 'Medium', label: 'A wire coded straight to expense', atIssueLabel: 'paid with no bill',
        headline: `${t.vendor}: a ${usd(t.total)} wire/ACH was keyed straight to ${line} with no bill behind it — it may not be a ${line.toLowerCase()} cost at all.`,
        happened: [`${dayText(t.date)}: ${usd(t.total)} to ${t.vendor}${t.ref ? ` (ref ${t.ref})` : ''}${t.description ? ` — ${String(t.description).slice(0, 80)}` : ''}, with no vendor bill.`,
          payee ? `${t.vendor}'s other payments did not clearly sit on a non-expense account, so this is a question, not a finding.` : `${t.vendor}'s payment history was not read, so what account it normally goes to is not known.`],
        actions: [{ who: 'the owner / accounting', do: `Say what this payment to ${t.vendor} was for, and whether it belongs on ${line}.` }],
        questions: [`What was the ${usd(t.total)} to ${t.vendor} for?`] });
    }
  }

  // 3. a year (or years) of cost booked in one month; a catch-up --------------------------------
  for (const t of txns) {
    if (t.type === 'CHKITM' || t.total <= 0) continue;
    const per = t.postings.map(periodOf).filter(Boolean).sort((a, b) => b.days - a.days)[0];
    if (!per || per.days < 150) continue;
    const share = t.total / base;
    if (share < MIN_SHARE && t.total < 0.4 * Math.abs(curT)) continue;
    const months = Math.max(1, Math.round(per.days / 30.4));
    const long = per.days > 420;
    add({ verdict: 'timing', dollars: t.total, confidence: 'High', label: long ? 'A catch-up bill covering years' : 'A year of cost booked in one month',
      atIssueLabel: long ? 'back-billed in one month' : `a ${months}-month cost in one month`,
      headline: long
        ? `${t.vendor}: one bill for ${usd(t.total)} covers ${per.text} (about ${Math.round(per.days / 365 * 10) / 10} years) and posted entirely in ${mName}.`
        : `${t.vendor}: one bill for ${usd(t.total)} covers ${per.text} (${months} months) but was booked entirely in ${mName} — spread evenly it is about ${usd(t.total / months)} a month.`,
      happened: [
        `${dayText(t.date)} bill${t.ref ? ` ${t.ref}` : ''}: ${usd(t.total)} for ${per.text}.`,
        long ? `The usual monthly bill from ${t.vendor} is a small fraction of this, so the month shows years of usage at once.` : `${line} here is normally about ${usd(avgPrior(A, month, t))} a month without this bill.`,
        'It reads as a booking-period issue: the cost is real, but this month carries a year of it.',
      ],
      actions: [{ who: 'Accounting', do: 'Check whether the bill was spread over its months as last year\'s was (a prepaid entry); if it was not, the monthly P&L overstates this month and understates the rest.' }],
      questions: long ? [`Why did ${t.vendor} bill ${per.days > 700 ? 'years of usage' : 'this period'} at once — an estimated reading, a meter fault, or a billing error?`] : [] });
  }
  for (const f of inv.findings || []) {
    if (f.kind === 'cycle' || f.kind === 'catch-up') {
      add({ weak: true, verdict: 'timing', dollars: f.dollars, confidence: f.confidence === 'high' ? 'High' : 'Medium', label: f.kind === 'cycle' ? 'A quarterly or annual bill' : 'A catch-up of earlier months',
        atIssueLabel: 'posted in one month', headline: f.headline, happened: f.evidence || [], actions: [{ who: 'Accounting', do: f.next }], questions: [] });
    }
    if (f.kind === 'credit') {
      add({ weak: true, verdict: 'timing', dollars: f.dollars, confidence: 'Medium', label: f.reversed ? 'A credit that reverses an earlier charge' : 'A credit with no matching charge',
        atIssueLabel: 'credit posted', headline: f.headline, happened: f.evidence || [], actions: [{ who: 'Accounting', do: f.next }], questions: [] });
    }
    if (f.kind === 'wrong-place') {
      add({ weak: true, verdict: 'wrong-account', dollars: f.dollars, confidence: 'Medium', label: 'Possibly on the wrong building or account',
        atIssueLabel: 'may be misplaced', headline: f.headline, happened: f.evidence || [], actions: [{ who: 'Accounting', do: f.next }], questions: [] });
    }
  }

  // 4. back-dated or corrected bills -------------------------------------------------------------
  for (const t of txns) {
    const f = factFor(t);
    if (!f.known || !f.hasBill || t.total <= 0) continue;
    const lag = f.enteredOn && f.billDate ? daysBetween(f.billDate, f.enteredOn) : 0;
    const corrected = /\b(corrected|correction|revised|re-?bill|adjust)/i.test(`${f.comment} ${t.description} ${t.ref}`);
    if (lag >= BACKDATED_DAYS) {
      add({ verdict: 'correction', dollars: t.total, confidence: 'High', label: 'Back-dated bill', atIssueLabel: 'keyed long after its date',
        headline: `${t.vendor}: bill ${f.billId} (${usd(t.total)}) is dated ${dayText(f.billDate)} but was keyed ${dayText(f.enteredOn)}${f.enteredBy ? ` by ${f.enteredBy}` : ''}, ${Math.round(lag / 30)} months later — ${mName} changed after it had closed.`,
        happened: [`The bill's date puts it in ${mName}; Rent Manager shows it was entered ${lag} days after that date.`, 'A P&L that was reviewed when the month closed no longer matches today\'s.'],
        actions: [{ who: 'Accounting', do: 'Date late-arriving invoices in the month they are entered (or note them), so closed months stop moving.' }], questions: [] });
    } else if (corrected && t.total >= MIN_SHARE * base) {
      add({ verdict: 'correction', dollars: t.total, confidence: 'High', label: 'A corrected bill', atIssueLabel: 'on the corrected bill',
        headline: `${t.vendor}: a corrected bill for ${usd(t.total)} (${f.comment || t.ref}) re-bills a period already in the books.`,
        happened: [`Bill ${f.billId}${f.comment ? ` is marked "${f.comment}"` : ''}.`, f.paid ? 'It has a payment applied.' : `It has no payment applied${f.pastDue ? ` and was due ${dayText(f.dueDate)}` : ''}.`],
        actions: [{ who: 'Accounting', do: `Compare it with the earlier ${t.vendor} bills for the same service period and make sure the old ones were credited or voided, not paid as well.` }], questions: [] });
    }
  }

  // 5. one big bill, all on one building --------------------------------------------------------
  {
    const t = txns.find(x => x.type === 'BILLITM' && x.total > 0);
    if (t) {
      const f = factFor(t), share = t.total / base;
      // Charged to one building: the bill's own lines say so when they are known (a bill split across
      // buildings shows only this scope's share in the postings); otherwise the postings do.
      const oneProp = f.known && f.lineProps.length ? f.lineProps.length === 1 : t.props.size === 1;
      // A vendor that bills most months (payroll, a utility) is not "one big bill": a big one from it is the vendor billing more.
      const regular = [-5, -4, -3, -2, -1].filter(n => A.some(p => vendorKey(p) === vendorKey(t.biggest) && monthOf(p) === addMonths(month, n))).length >= 3;
      const longPeriod = regular || t.postings.some(p => { const pr = periodOf(p); return pr && pr.days >= 150; });
      if (share >= 0.5 && t.total >= 5000 && !dupRows.has(t.key) && !longPeriod && oneProp) {
        add({ verdict: 'concentration', dollars: t.total, confidence: 'Medium', label: 'One big bill on one building', atIssueLabel: 'one bill',
          headline: `${t.vendor}: one bill for ${usd(t.total)} is ${pct(Math.min(1, share))} of the move, and every line of it is charged to ${where}${f.known && !f.files.length ? ', with no invoice attached' : ''}.`,
          happened: [`Bill ${f.billId || t.id}${t.ref ? ` (${t.ref})` : ''}: ${usd(f.amount || t.total)}, ${f.lineCount || t.lines} lines${f.known && f.lineProps.length === 1 ? ', all on this one property' : ''}.`,
            'A bill this size is either a large job at this building or supplies bought for several buildings and charged to one.'],
          actions: [{ who: 'the owner', do: 'Ask who ordered it and what it was for. If it was stock for several buildings, it should be split across them; if one job, the job should be noted on the bill.' },
            ...(f.known && !f.files.length ? [{ who: 'Accounting', do: `Get the ${t.vendor} invoice and attach it to bill ${f.billId || t.id}.` }] : [])],
          questions: [`Was there a large job at ${where}?`] });
      }
    }
  }

  // 6. bills entered but not paid, past due ------------------------------------------------------
  {
    const open = txns.filter(t => { const f = factFor(t); return f.known && f.hasBill && !f.paid && t.total > 0 && !f.part; });
    const partOpen = txns.filter(t => { const f = factFor(t); return f.known && f.hasBill && f.part && f.pastDue && t.total > 0; });
    open.push(...partOpen);
    for (let i = open.length - 1; i >= 0; i--) if (factFor(open[i]).financed) open.splice(i, 1);
    const dollars = round2(open.reduce((s, t) => s + t.total, 0));
    const late = open.filter(t => factFor(t).pastDue);
    if (open.length && dollars >= MIN_SHARE * base) {
      const oldest = late.map(t => factFor(t).dueDate).sort()[0];
      add({ verdict: 'unpaid', dollars, confidence: 'High', label: 'Unpaid or past due', atIssueLabel: late.length ? 'open, past due' : 'open',
        headline: `${open.length} of ${mName}'s bills (${usd(dollars)}) have no payment applied${late.length ? `, and ${late.length === open.length ? 'all' : late.length} ${late.length === 1 ? 'is' : 'are'} past due (the oldest since ${dayText(oldest)})` : ''}.`,
        happened: open.map(t => { const f = factFor(t); return `${t.vendor} bill ${f.billId || t.id}: ${usd(t.total)}${f.dueDate ? `, due ${dayText(f.dueDate)}` : ''}${f.approved === false ? ', not approved' : ''}.`; }),
        actions: [{ who: 'Accounting', do: 'Check each is waiting to be paid or was paid another way, so it is not paid twice or left to add late fees.' }], questions: [] });
    }
  }

  // 7. real-looking cost, with or without its paperwork ------------------------------------------
  const unpaidPastDue = txns.filter(t => { const f = factFor(t); return f.known && f.pastDue; });
  const explained = (inv.findings || []).filter(f => ['one-big-bill', 'vendor-more', 'new-vendor', 'missing-bill', 'one-off-gone', 'vendor-less'].includes(f.kind));
  const bills = txns.filter(t => t.type === 'BILLITM' && t.total > 0 && factFor(t).known && factFor(t).hasBill);
  const billDollars = bills.reduce((s, t) => s + t.total, 0);
  const noFile = bills.filter(t => !factFor(t).files.length);
  const noFileDollars = noFile.reduce((s, t) => s + t.total, 0);
  const paidFirst = bills.filter(t => factFor(t).paidBeforeApproved);
  if (explained.length && bills.length) {
    const f0 = explained[0];
    if (noFileDollars / Math.max(billDollars, 1) >= 0.5 && noFileDollars >= MIN_SHARE * base) {
      add({ verdict: 'paperwork', dollars: noFileDollars, confidence: 'Medium', label: 'No backup on file', atIssueLabel: 'with no invoice attached',
        headline: `${noFile.length} of ${bills.length} bills behind ${mName} (${usd(noFileDollars)}) have no invoice attached in Rent Manager, so the cost cannot be confirmed from the books.`,
        happened: [f0.headline, ...noFile.slice(0, 4).map(t => `${t.vendor} bill ${factFor(t).billId || t.id} (${usd(t.total)})${factFor(t).paid ? ' is paid' : ' is open'} with no invoice.`),
          ...paidFirst.map(t => `${t.vendor} bill ${factFor(t).billId} was paid ${dayText(factFor(t).paidOn)}, before it was approved ${dayText(factFor(t).approvedOn)}.`)],
        actions: [{ who: 'Accounting', do: 'Attach the invoices; a bill with no invoice and no payment months later is either unpaid or was paid another way (then it is counted twice).' }], questions: [] });
    } else if (!unpaidPastDue.length) {
      add({ verdict: 'real', dollars: f0.dollars, confidence: 'Medium', label: 'Looks like a real cost', atIssueLabel: 'ordinary cost, backed',
        headline: `${f0.headline}. The bills have their invoices and nothing in Rent Manager looks wrong with them.`,
        happened: [...(f0.evidence || []), `${bills.length - noFile.length} of ${bills.length} bills have an invoice attached; none looks duplicated, back-dated or misplaced.`],
        actions: [{ who: 'the owner', do: f0.next }, { who: 'the owner', do: 'If the cost was expected, mark the flag normal.' }], questions: [] });
    }
  }

  // ── choose the conclusion ──────────────────────────────────────────────────────────────────
  // The engine's own readings (a catch-up, an annual bill, a credit, a possible wrong building) say less
  // than a rule that has read the bill, so they rank after the specific ones — but they still explain
  // why the month moved, which an unpaid or undocumented bill does not (those are what is wrong with
  // the bills, not why the month jumped), so they rank before those.
  const rank = c => (c.weak ? PRIORITY.indexOf('concentration') + 0.5 : PRIORITY.indexOf(c.verdict));
  cands.sort((a, b) => rank(a) - rank(b) || b.dollars - a.dollars);
  const major = cands.filter(c => c.dollars >= MIN_SHARE * base || c.verdict === 'duplicate');
  let top = major[0] || null;
  if (top) {
    const bigger = major.find(c => !c.weak && !['real', 'unexplained'].includes(c.verdict) && c.dollars >= 3 * top.dollars);
    if (bigger) top = bigger;
  }
  const rest = major.filter(c => c !== top && !(top && c.headline === top.headline));
  const checked = [
    ...(inv.checked || []),
    `${lookedUp} of the biggest transactions in ${mName}: paid or open, approved, due date, who keyed it and when, invoice attached`,
    'same invoice number entered twice, back-dated bills, and bills with no payment past their due date',
    payee ? 'the payment history of any payee paid by check with no bill' : '',
  ].filter(Boolean);
  const limits = [...(inv.limits || [])];
  if (!lookedUp) limits.push('No bills were looked up in Rent Manager, so paid/open, approval and invoice status are not part of this reading.');
  for (const l of lookups) if (l.error || !l.backup) limits.push(`The bill lookup for ${vendorLabel(l.posting)}, ${usd(l.posting.amount)}, ${dayText(l.posting.date)} did not finish (${l.error || 'no answer'}), so its paid/open and invoice status are not in this reading.`);

  const rows = txns.filter(t => Math.abs(t.total) >= Math.max(100, 0.02 * Math.abs(curT))).slice(0, 8)
    .map(t => billRow(t, factFor(t), month, dupRows.has(t.key) ? 'Same invoice number as another bill' : ''));
  const withFile = rows.filter(r => r.files.length).length;

  const out = {
    auto: true, reviewed: today, by: 'House automatic review', month, scope: flag.scopeToken || null, line: flag.line.key,
    bills: rows, checked, limits, alsoFound: rest.slice(0, 4).map(c => ({ verdict: c.verdict, headline: c.headline, dollars: round2(c.dollars) })),
    backup: { bills: rows.length, withFile },
  };
  if (top) {
    // When the mistake found is a small part of the move, say what the big part is, so the
    // reader is not left thinking the $3K bill explains a $10K month.
    const lead = txns.find(t => t.total > 0);
    let biggest = '';
    if (lead && top.dollars < 0.4 * base && !top.headline.includes(lead.vendor) && lead.total > top.dollars) {
      const lf = factFor(lead);
      const st = !lf.known ? '' : (lf.direct && !lf.hasBill ? ', paid with no bill' : lf.paid ? (lf.files.length ? ', paid, invoice on file' : ', paid, no invoice') : lf.part ? `, ${usd(lf.remaining)} still open` : ', not paid');
      biggest = `The biggest bill in ${mName} is ${lead.vendor} (${usd(lead.total)}${lead.ref ? `, ${lead.ref}` : ''}${st}).`;
    }
    return { ...out, verdict: top.verdict, verdictLabel: top.label || VERDICT_LABEL[top.verdict],
      // the bottom line follows the headline on the page, so it carries what the headline does not
      headline: biggest ? `${top.headline} ${biggest}` : top.headline, bottomLine: [...top.happened.filter(h => h !== top.headline).slice(0, 2), ...rest.filter(c => !c.weak && ['unpaid', 'duplicate', 'correction', 'wrong-account'].includes(c.verdict)).slice(0, 2).map(c => `Also: ${c.headline}`)].join(' '),
      atIssue: round2(top.dollars), atIssueLabel: top.atIssueLabel || '', confidence: `${top.confidence} — ${confidenceReason(top)}`,
      whatHappened: top.happened, actions: dedupeActions(top.actions.concat(rest.filter(c => !c.weak && ['duplicate', 'wrong-account', 'unpaid', 'paperwork', 'correction'].includes(c.verdict)).flatMap(c => c.actions)).slice(0, 5)), questions: top.questions };
  }
  // No bill was found wrong, but the postings themselves say what moved (a new vendor, a regular
  // charge that did not post, a bigger bill from the usual vendor): say that, marked as a reading
  // of the postings, instead of "nothing explains it" next to the explanation.
  const g = explained.find(x => x.dollars >= MIN_SHARE * base);
  if (g) {
    const missing = g.kind === 'missing-bill';
    const label = { 'new-vendor': 'A new vendor on this line', 'vendor-more': 'The usual vendor billed more', 'one-big-bill': 'One big bill', 'missing-bill': 'A regular charge did not post',
      'one-off-gone': 'Last month\'s one-off did not repeat', 'vendor-less': 'The usual vendor billed less' }[g.kind] || VERDICT_LABEL.real;
    return { ...out, verdict: missing ? 'timing' : 'real', verdictLabel: label,
      headline: /[.!?]$/.test(g.headline) ? g.headline : `${g.headline}.`,
      bottomLine: missing ? `If it is still owed, ${mName} is understated until it posts — check it was billed, not skipped.`
        : 'Nothing found in Rent Manager looks wrong with it, but the bills behind it were not confirmed, so this is what the postings show, not a checked conclusion.',
      atIssue: round2(g.dollars), atIssueLabel: missing ? 'not posted this month' : 'from the postings', confidence: 'Low — read from the postings; the bills were not confirmed',
      whatHappened: g.evidence || [], actions: [{ who: missing ? 'Accounting' : 'the owner', do: g.next || `Open the ${line} postings for ${mName} in Rent Manager and read the invoices for the biggest ones.` }],
      questions: [] };
  }
  const f0 = (inv.findings || [])[0];
  const nothing = inv.mode === 'no-change';
  return { ...out, verdict: 'unexplained', verdictLabel: VERDICT_LABEL.unexplained,
    headline: nothing ? `The postings for ${mName} match the month before, so there is no change in Rent Manager to explain.`
      : `Rent Manager's postings and bills do not explain why ${mName} moved${f0 ? ` — the biggest mover is ${f0.vendor} (${usd(f0.dollars)})` : ''}.`,
    bottomLine: nothing ? (inv.summary || '') : `${inv.summary || ''} Every check listed below came back clean: no duplicate bill, no payment coded against the payee's history, no back-dated or corrected bill, nothing unpaid past due.`.trim(),
    atIssue: f0 ? round2(f0.dollars) : 0, atIssueLabel: f0 ? 'unexplained' : '', confidence: 'None — nothing found to rely on',
    whatHappened: (f0 ? f0.evidence : []) || [], actions: [{ who: 'the owner', do: inv.next || `Open the ${line} postings for ${mName} in Rent Manager and read the invoices for the biggest ones.` }],
    questions: [] };
}

function confidenceReason(c) {
  if (c.verdict === 'duplicate') return 'same invoice number and amount on more than one bill';
  if (c.verdict === 'wrong-account') return c.confidence === 'High' ? 'the payee\'s own history in Rent Manager' : 'the pattern, not the payee\'s history';
  if (c.verdict === 'timing') return 'the service period printed on the bill';
  if (c.verdict === 'correction') return 'the dates and wording on the bill';
  if (c.verdict === 'unpaid') return 'read from the bill\'s own payment status';
  return 'what the postings and bills state';
}
function dedupeActions(list) {
  const seen = new Set();
  return list.filter(a => a && a.do && !seen.has(a.do) && seen.add(a.do));
}
function avgPrior(A, month, t) {
  const months = [-5, -4, -3, -2, -1].map(n => addMonths(month, n));
  const tot = months.map(m => A.filter(p => monthOf(p) === m).reduce((s, p) => s + p.amount, 0)).filter(v => v !== 0);
  return tot.length ? tot.reduce((s, v) => s + v, 0) / tot.length : 0;
}

// ── a run-rate (12 months to X) flag ────────────────────────────────────────────────────────────
// input: { A: postings month-23 … month, flag:{scopeLabel,line,month,scopeToken}, today }
// The question is "what made the last 12 months cost more than the 12 before",
// answered as a split of the difference: unlabelled journal entries in the earlier
// year, new payees, and growth at the vendors that were already there.
function buildTrend(input) {
  const { A = [], flag, today } = input;
  const month = flag.month, from12 = addMonths(month, -11);
  const inCur = p => monthOf(p) >= from12 && monthOf(p) <= month;
  const cur = A.filter(inCur), prev = A.filter(p => !inCur(p));
  const curT = round2(cur.reduce((s, p) => s + p.amount, 0)), prevT = round2(prev.reduce((s, p) => s + p.amount, 0));
  const delta = round2(curT - prevT), up = delta >= 0;
  const jrnl = p => p.txnType === 'JOURNL';
  const sums = list => { const m = new Map(); for (const p of list) { const k = jrnl(p) ? 'journal' : vendorKey(p); const e = m.get(k) || { key: k, label: jrnl(p) ? 'Journal entries (no payee)' : vendorLabel(p), amount: 0 }; e.amount = round2(e.amount + p.amount); m.set(k, e); } return m; };
  const a = sums(cur), b = sums(prev);
  const parts = [...new Set([...a.keys(), ...b.keys()])].map(k => {
    const c = (a.get(k) || {}).amount || 0, p0 = (b.get(k) || {}).amount || 0;
    return { key: k, label: (a.get(k) || b.get(k)).label, cur: c, prev: p0, change: round2(c - p0) };
  }).filter(x => Math.abs(x.change) >= 1).sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
  const lead = parts[0];
  const mName = monthName(month);
  const line = flag.line.label, where = flag.scopeLabel || 'this scope';
  const decomposition = parts.slice(0, 6).map(x => ({ label: x.label, change: x.change, prev: x.prev, cur: x.cur,
    kind: x.key === 'journal' ? 'journal' : (x.prev === 0 ? 'new' : 'growth') }));
  let verdict = 'unexplained', headline, atIssue = 0, atIssueLabel = '', happened = [], actions = [], questions = [], label = VERDICT_LABEL.unexplained, conf = 'Medium';
  if (!lead || Math.abs(delta) < 1) {
    headline = `${line} at ${where} cost about the same over the last 12 months as the 12 before.`;
  } else if (lead.key === 'journal' && Math.abs(lead.change) >= 0.25 * Math.abs(delta)) {
    const lowered = lead.prev < 0 && Math.sign(lead.change) === Math.sign(delta);
    verdict = 'timing'; label = lowered ? 'Last year\'s books look low' : 'Journal entries moved the line';
    atIssue = Math.abs(lead.change); atIssueLabel = lowered ? 'from last year\'s journal entries' : 'from journal entries'; conf = 'High';
    headline = lowered
      ? `Most of the ${usd(Math.abs(delta))} ${up ? 'rise' : 'drop'} is last year looking low, not new spending: journal entries took ${usd(Math.abs(lead.prev))} off ${line} in the earlier 12 months and ${usd(Math.abs(lead.cur))} in the latest, which accounts for ${usd(Math.abs(lead.change))} of it.`
      : `${usd(Math.abs(lead.change))} of the ${usd(Math.abs(delta))} change comes from journal entries (${usd(lead.prev)} in the earlier 12 months, ${usd(lead.cur)} in the latest), not from what vendors billed.`;
    happened.push(`Journal entries on ${line}: ${usd(lead.prev)} in the earlier 12 months, ${usd(lead.cur)} in the latest.`);
    actions.push({ who: 'Accounting', do: 'Say what those journal entries were and where the other side was booked, and whether the same allocation should still be happening.' });
    questions.push('Were those journal entries an allocation that has since stopped?');
  } else if (lead.prev === 0 && Math.abs(lead.change) >= 0.25 * Math.abs(delta)) {
    verdict = 'concentration'; label = 'A new payee on this line'; atIssue = Math.abs(lead.change); atIssueLabel = 'new in the last 12 months'; conf = 'Medium';
    headline = `${lead.label} did not appear on ${line} in the earlier 12 months and has ${usd(lead.cur)} in the latest — ${pct(Math.abs(lead.change) / Math.abs(delta))} of the ${usd(Math.abs(delta))} change.`;
    happened.push(`${lead.label}: ${usd(lead.prev)} before, ${usd(lead.cur)} now.`);
    actions.push({ who: 'the owner', do: `Confirm ${lead.label} is meant to bill ${line} at ${where}.` });
  } else {
    const jump = lead.prev > 0 && Math.abs(lead.change) / Math.abs(lead.prev) >= 1;
    verdict = jump ? 'concentration' : 'real'; label = jump ? 'One payee\'s billing more than doubled' : 'Looks like ordinary growth';
    atIssue = Math.abs(lead.change); atIssueLabel = 'at the biggest payee'; conf = 'Medium';
    headline = `${lead.label} accounts for ${usd(Math.abs(lead.change))} (${pct(Math.min(1, Math.abs(lead.change) / Math.abs(delta)))}) of the ${usd(Math.abs(delta))} ${up ? 'rise' : 'drop'} over the last 12 months to ${mName}${lead.prev ? ` — ${lead.change >= 0 ? 'up' : 'down'} ${pct(Math.abs(lead.change) / Math.abs(lead.prev))} on the year before` : ''}.`;
    happened.push(`${lead.label}: ${usd(lead.prev)} in the earlier 12 months, ${usd(lead.cur)} in the latest.`);
    actions.push({ who: 'the owner', do: jump ? `Ask what changed at ${lead.label} — a rate, a new service, or a change in how it is booked.` : 'If the increase was expected (a raise, a new hire, a rate change), mark the flag normal.' });
  }
  for (const x of decomposition.slice(0, 4)) happened.push(`${x.label}: ${x.change >= 0 ? '+' : '−'}${usd(Math.abs(x.change))}.`);
  return {
    auto: true, trend: true, reviewed: today, by: 'House automatic review', month, scope: flag.scopeToken || null, line: flag.line.key,
    verdict, verdictLabel: label, headline, bottomLine: `${line} at ${where}: ${usd(curT)} over the 12 months to ${mName}, against ${usd(prevT)} in the 12 before (${delta >= 0 ? '+' : '−'}${usd(Math.abs(delta))}).`,
    atIssue: round2(atIssue), atIssueLabel, confidence: `${conf} — read from the General Ledger by vendor, 24 months`,
    whatHappened: happened, bills: [], actions, questions, decomposition,
    checked: [`General Ledger postings on ${line} for ${monthName(addMonths(month, -23))}–${mName} (${A.length} postings), split by payee`, 'journal entries in either year (split out from the payees)'],
    limits: [], alsoFound: [], backup: { bills: 0, withFile: 0 },
  };
}

module.exports = { build, buildTrend, VERDICT_LABEL, factsOf, groupTxns };
