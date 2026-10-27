// One parser for every dollar figure that comes back from Rent Manager.
//
// ── why this is its own file (2026-08-25) ───────────────────────────────────
// There were four different parsers in services/, and which one a number met
// decided what it was worth:
//
//   propertyFinancials / glTransactions / renovationExpenses  →  strips $ , ( )
//                                                                and reads
//                                                                (60.00) as -60
//   delinquencyReport / billingCohorts                        →  strips $ and ,
//   chargedCollections                                        →  strips , only
//
// The last two turn an accounting-formatted credit into a ZERO. `parseFloat('(60.00)')`
// is NaN, `NaN || 0` is 0 — so a $60 credit is not subtracted, it is discarded,
// and the total comes out $60 HIGH with nothing anywhere saying so. The one that
// strips only commas does the same to any figure RM formats with a currency sign.
//
// That is the shape of two open complaints at once:
//   • the owner, 2026-08-25: charged / paid on the Delinquency tab off by "fifty,
//     sixty dollars" on a unit.
//   • the regional manager, 2026-08-07: RM's total billed comes in LOWER than ours — the note in
//     billingCohorts.js predicted that if `creditAmount` came back 0, credits were
//     not reaching us at all. A parser that drops every parenthesised credit
//     produces exactly that: no credits seen, and a gross denominator where RM
//     has a net one.
//
// So: one parser, in one place, used by everything that reads money out of a
// report. Whether credits actually reach us is then answerable from the data
// rather than from the parser: billingCohorts already counts negative charges
// (`creditCount` / `creditAmount`) for exactly that question, and with this in
// place a zero there means "no credits in the window", not "credits discarded".

// Every accounting format RM emits: 1,234.56 · (1,234.56) · $1,234 · -1,234 ·
// a bare dash for nothing · a real JS number (which most WAPI JSON fields are).
const PARENS = /\([^)]*\)/;

function parseAmount(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const t = String(v).trim();
  if (t === '' || t === '-' || t === '—') return 0;
  const negative = PARENS.test(t);
  const n = Number(t.replace(/[$,()\s]/g, ''));
  if (!Number.isFinite(n)) return 0;
  // A value can carry BOTH a minus sign and parentheses in a badly formatted
  // export; parentheses win, and the result is negative either way — never a
  // double negation back to positive.
  return negative ? -Math.abs(n) : n;
}

module.exports = { parseAmount };
