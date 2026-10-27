// DEMO_MODE without an ANTHROPIC_API_KEY: the Scanner tab cannot read a contract with Claude,
// so it shows this analysis of a fictional laundry-room lease instead, in exactly the shape the
// real analyzer returns (services/contractScanner.js). The first line of the summary says so.

function sampleAnalysis(today = new Date()) {
  const iso = d => d.toISOString().slice(0, 10);
  const signed = new Date(today.getFullYear(), today.getMonth() - 2, 14);
  const end = new Date(signed.getFullYear() + 8, signed.getMonth(), signed.getDate());
  const cancelBy = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 90);
  return {
    contract_type: 'Laundry Lease',
    title: 'Laundry Room Lease and Services Agreement (sample)',
    one_line_summary: 'Demo sample: SudsCo runs the laundry room at Maple Court for 8 years and pays Cedar Ridge 45% of collections, with a $1,100/month minimum.',
    property: { address: '88 Maple Court, Columbus, OH 43214', units: 12, units_note: 'All 12 apartments may use the shared laundry room.' },
    our_entity: { name: 'Cedar Ridge Holdings, LLC', role: 'Landlord / Lessor' },
    counterparty: { name: 'SudsCo Laundry Services, Inc. (fictional)', role: 'Tenant / Lessee (vendor)' },
    signature_status: { fully_executed: true, detail: `Signed for both parties on ${iso(signed)}.` },
    money: {
      direction: 'We receive',
      terms: [
        { label: 'Rent (revenue share)', amount: '45% of gross collections', computed_value: null, frequency: 'monthly', who_pays: 'Them', timing: 'By the 15th of the following month', conditions: 'Less a 3% admin fee; never below the minimum guarantee', section: '§4.1' },
        { label: 'Minimum guarantee', amount: '$1,100/month', computed_value: 13200, frequency: 'monthly', who_pays: 'Them', timing: 'Same statement as the revenue share', conditions: 'Applies once all machines are installed', section: '§4.2' },
        { label: 'Signing fee', amount: '$6,000', computed_value: 6000, frequency: 'one-time', who_pays: 'Them', timing: 'Within 30 days of signing', conditions: 'Clawed back pro rata if the vendor terminates early', section: '§4.4' },
      ],
    },
    term: {
      start_trigger: 'Date all machines are installed and operating', start_date: null,
      initial_term: '96 months (8 years)', end_date: iso(end), end_date_is_estimate: true,
      end_date_basis: 'Estimated from the signing date plus 96 months, because the start depends on an undated installation.',
    },
    renewal: {
      auto_renews: true, renewal_length: 'Successive 1-year terms',
      notice_to_stop: '90 days before expiration', notice_method: 'Certified mail, return receipt requested',
      cancel_by_date: iso(cancelBy), notes: 'Notice must be received, not just sent.',
    },
    termination_rights: [
      { who: 'Them', trigger: 'Machines are removed because revenue falls below the minimum for 6 months', notice: '60 days', consequence: 'Repay the unamortised part of the signing fee', section: '§9.2' },
      { who: 'Us', trigger: 'Vendor misses service calls (48 hours) three times in a year', notice: '30 days to cure', consequence: 'No penalty', section: '§9.1' },
    ],
    exclusivity: 'No other vendor may place coin or card laundry equipment at the property during the term.',
    if_we_sell: 'The buyer must assume the lease; it cannot be terminated by a sale.',
    our_obligations: ['Provide the laundry room, power, water and drain', 'Keep the room open and lit', 'Give the vendor access for service'],
    their_obligations: ['Install and maintain all machines', 'Respond to service calls within 48 hours', 'Carry $2M general liability insurance'],
    other_key_terms: [{ term: 'Pricing', detail: 'Vendor may raise per-cycle prices up to 5% a year without consent.', section: '§6' }],
    deal_terms: null,
    document_issues: [{ issue: 'Section 9.3 refers to "Exhibit D", but the lease only attaches Exhibits A to C.', section: '§9.3' }],
    flagged_risks: [
      { severity: 'High', clause_reference: '§3', issue_description: 'Auto-renews for 1-year terms unless notice is received 90 days before the end.', recommended_action: 'Calendar the notice deadline and decide a year ahead whether to renegotiate.' },
      { severity: 'Medium', clause_reference: '§6', issue_description: 'The vendor can raise resident prices 5% a year without approval.', recommended_action: 'Ask for a cap tied to CPI or require our consent above 3%.' },
      { severity: 'Low', clause_reference: '§9.3', issue_description: 'Cross-reference to a missing exhibit.', recommended_action: 'Have the vendor correct the exhibit reference in an amendment.' },
    ],
    action_items: [
      `Calendar the non-renewal notice for ${iso(cancelBy)} (90 days before the estimated end date).`,
      'Ask the vendor to confirm the installation date in writing so the term has a real start.',
      'Request a corrected exhibit reference for §9.3.',
    ],
    demo_note: 'Demo mode: this is a sample analysis of a fictional lease, shown because no ANTHROPIC_API_KEY is configured. With a key, the contract you upload is read by Claude.',
  };
}

module.exports = { sampleAnalysis };
