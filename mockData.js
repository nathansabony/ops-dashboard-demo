// Placeholder data so /api/* routes return something realistic before Rent Manager
// credentials exist. Shapes loosely mirror what the live API will return — replace
// entirely once real field names are confirmed from Rent Manager's API docs/Swagger.

module.exports = {
  tenants: [
    { id: 'demo-1', name: 'Demo Tenant', unit: '101', property: 'Demo Property', status: 'Current', balance: 0 },
    { id: 'demo-2', name: 'Demo Delinquent Tenant', unit: '202', property: 'Demo Property', status: 'Current', balance: 1250 },
  ],
  issues: [],
  delinquency: [
    { tenant: 'Demo Delinquent Tenant', unit: '202', property: 'Demo Property', balance: 1250 },
  ],
  entities: [
    { name: 'Birchwood Commons', properties: 1, units: 50 },
  ],
  overview: {
    cashOnHand: 0,
    monthlyNOI: 0,
    monthlyGPR: 0,
    vacancyPct: 0,
    delinquencyTotal: 0,
  },
  // Placeholder debt service — replaced by live GL data once RM credentials are set.
  // Deliberately fake demo numbers: no real financials live in code (policy).
  debtService: {
    from: '2026-01-01',
    to:   '2026-05-31',
    interest:  0,
    principal: 0,           // principal not yet tracked — will populate from GL liability accounts
    total:     0,
    by_property: [
      { property: 'Demo Entity', interest: 0, principal: 0, total: 0 },
    ],
  },
};
