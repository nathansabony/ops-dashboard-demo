// Answer key for scripts/testContractScanner.js — hand-checked against the
// actual contracts. Keyed by a substring of the PDF filename. Each check gets
// the scanner's JSON (j) and a lowercased dump of it (all) for "mentions"
// checks. Add a contract here whenever the scanner gets one wrong.
const money = j => (j.money?.terms || []);
const moneyText = j => JSON.stringify(money(j)).toLowerCase();
const has = (s, ...needles) => needles.every(n => String(s || '').toLowerCase().includes(n.toLowerCase()));
const issues = j => JSON.stringify(j.document_issues || []).toLowerCase();

module.exports = {
  '2301 Willow Creek Rd': [
    ['vendor is Metered Appliances (counterparty)', j => has(j.counterparty?.name, 'metered')],
    ['rent = 40% of collections', j => moneyText(j).includes('40%')],
    ['55% low-usage alternative captured', (j, all) => all.includes('55%')],
    ['22 units', j => j.property?.units === 22],
    ['initial term 8 years', j => /8|eight/.test(j.term?.initial_term || '')],
    ['auto-renews in 3-year terms', j => j.renewal?.auto_renews === true && /3|three/.test(j.renewal?.renewal_length || '')],
    ['90-day non-renewal notice', j => /90/.test(j.renewal?.notice_to_stop || '')],
    ['not fully executed (vendor never signed)', j => j.signature_status?.fully_executed === false],
    ['flags 410 Alder Street vs 2301 Willow Creek Rd mismatch', j => has(issues(j), '53', '6119')],
    ['never reports the 1 Demo Portfolio Plaza head office as the property', j => !/600 central/i.test(j.property?.address || '')],
    ['flags §10 sale clause wording', j => /§\s*10|section 10/i.test(JSON.stringify(j.document_issues || []))],
    ['no PSA deal terms', j => j.deal_terms == null],
  ],
  'CSC contract': [
    ['vendor is CSC ServiceWorks', j => has(j.counterparty?.name, 'csc')],
    ['our entity is Maple Court Owner LLC', j => has(j.our_entity?.name, 'maple court')],
    ['flat rent $1,925/month', j => /1,?925/.test(moneyText(j))],
    ['12.75% admin fee deduction captured', (j, all) => all.includes('12.75')],
    ['term 96 months / 8 years', j => /96|8 year|eight/.test(j.term?.initial_term || '')],
    ['auto-renews year-to-year', j => j.renewal?.auto_renews === true && /year/.test(j.renewal?.renewal_length || '')],
    ['60-day non-renewal notice', j => /60/.test(j.renewal?.notice_to_stop || '')],
    ['end date estimated ~2034', j => /^2034-/.test(j.term?.end_date || '') && j.term?.end_date_is_estimate === true],
    ['fully executed', j => j.signature_status?.fully_executed === true],
    ['sale: buyer must assume / lease binds buyer', j => /assum|assign|bind/.test((j.if_we_sell || '').toLowerCase())],
    ['5 excepted in-unit laundry units captured', (j, all) => /(5|five)[^"]{0,60}excepted|excepted[^"]{0,60}(5|five)/.test(all)],
    ['units not stated → null, not 0', j => j.property?.units == null],
    ['no PSA deal terms', j => j.deal_terms == null],
  ],
  'Macro Laundry': [
    ['our entity is Optbridge (lessor) — not swapped', j => has(j.our_entity?.name, 'optbridge')],
    ['vendor is In House Laundromat / Macro', j => /in house|macro/.test((j.counterparty?.name || '').toLowerCase())],
    ['we receive money', j => /receive/i.test(j.money?.direction || '')],
    ['rent = 40% of income', j => moneyText(j).includes('40%')],
    ['$47.50/machine/month floor captured', j => moneyText(j).includes('47.5')],
    ['30 units', j => j.property?.units === 30],
    ['initial term 8 years', j => /8|eight/.test(j.term?.initial_term || '')],
    ['auto-renews in 3-MONTH terms', j => j.renewal?.auto_renews === true && /3|three/.test(j.renewal?.renewal_length || '') && /month/i.test(j.renewal?.renewal_length || '')],
    ['60-day non-renewal notice', j => /60/.test(j.renewal?.notice_to_stop || '')],
    ['flags "N/A" plumbed units vs 6 of 30 with W/D', j => /six|6/.test(issues(j))],
    ['80% occupancy termination trigger captured', (j, all) => all.includes('80%')],
    ['no PSA deal terms', j => j.deal_terms == null],
  ],
  'Google contract': [
    ['provider is Google Fiber', j => has(j.counterparty?.name, 'google')],
    ['our entity is New Birchwood Commons Member', j => has(j.our_entity?.name, 'birchwood commons')],
    ['869 units', j => j.property?.units === 869],
    ['door fee = $130,350 computed', j => money(j).some(m => m.computed_value === 130350)],
    ['5% revenue share, quarterly', j => moneyText(j).includes('5%') && moneyText(j).includes('quarter')],
    ['term 10 years from Service Ready', j => /10|ten/.test(j.term?.initial_term || '') && /service ready/i.test(j.term?.start_trigger || '')],
    ['auto-renews 1-year terms', j => j.renewal?.auto_renews === true && /1|one/.test(j.renewal?.renewal_length || '')],
    ['6-month non-renewal notice', j => /6|six/.test(j.renewal?.notice_to_stop || '')],
    ['not fully executed (Google side blank)', j => j.signature_status?.fully_executed === false],
    ['door-fee clawback (reimbursement fee) captured', (j, all) => all.includes('reimbursement')],
    ['no bulk/exclusive internet deal restriction', j => /bulk|exclusive/i.test(j.exclusivity || '')],
    ['no PSA deal terms', j => j.deal_terms == null],
  ],
  'Wave contract': [
    ['equipment purchase type', j => /purchase/i.test(j.contract_type || '')],
    ['we pay', j => /pay/i.test(j.money?.direction || '') && !/receive/i.test(j.money?.direction || '')],
    ['net price $14,399 captured', j => /14,?399/.test(moneyText(j))],
    ['50/50 installments of $7,199.50', j => /7,?199\.5/.test(moneyText(j))],
    ['6-month money-back captured', (j, all) => /6.month|six.month|six \(6\) month/.test(all)],
    ['15-year warranty captured', (j, all) => /15.year|fifteen/.test(all)],
    ['payment schedule NOT treated as earnest money', j => j.deal_terms == null],
    ['flags "12/2/224" date typo', j => /224/.test(issues(j))],
    ['flags signed as individual / Demo Portfolio entity not named', j => /individual|entity|personal/.test(issues(j))],
    // The invoice carries 9-digit account/routing/ACH numbers — none may appear.
    ['no bank account numbers leaked', (j, all) => !/\b\d{9}\b/.test(all)],
  ],
};
