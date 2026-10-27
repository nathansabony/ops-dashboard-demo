// Split buildings read back as one (services/propertyMerges.js).
//
// The case it is for: 88-90 Maple Court was split into 37 (30) and 39 (209) in Rent
// Manager, a bill lands on one side one month and the other the next, and each
// side gets flagged for a swing the building as a whole never had. Merged, the
// combined series is the sum, the member drops out, and nothing else moves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const merges = require('../services/propertyMerges');

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

const groups = [{ name: '88-90 Maple Court', primary: 30, members: [209] }];
const snap = {
  months: ['Aug 26', 'Sep 26'],
  properties: {
    30: { name: '37 (The Brevard)', entity: 'Maple Court', heatingGas: [0, 900], electric: [100, 50], totalExpense: [100, 950] },
    209: { name: '90 Maple Court', entity: 'Maple Court', heatingGas: [800, 0], electric: [20, 30], totalExpense: [820, 30] },
    36: { name: '77 Birchwood Lane', entity: 'Maple Court', heatingGas: [5, 5], electric: [1, 1], totalExpense: [6, 6] },
  },
  entities: { 'Maple Court': { heatingGas: [805, 905] } },
  accounts: {
    properties: {
      30: { electric: [{ id: 'l:5404', kind: 'leaf', ref: '5404', s: [100, 50] }] },
      209: { electric: [{ id: 'l:5404', kind: 'leaf', ref: '5404', s: [20, 30] }, { id: 'l:5404-1', kind: 'leaf', ref: '5404-1', s: [1, 2] }] },
    },
  },
};
const before = JSON.stringify(snap);
const out = merges.apply(snap, groups);

check('the combined building is the sum of both sides', JSON.stringify(out.properties[30].heatingGas) === '[800,900]');
check('every series is summed, not just one line', JSON.stringify(out.properties[30].totalExpense) === '[920,980]');
check('the member drops out of the list', !out.properties[209]);
check('it takes the group name', out.properties[30].name === '88-90 Maple Court');
check('it says what it was made from', out.properties[30].mergedFrom.map(m => m.id).join(',') === '30,209');
check('a building outside the group is untouched', out.properties[36] === snap.properties[36]);
check('entity totals do not move (they already counted both sides)', out.entities === snap.entities);
check('the account tree merges line by line', JSON.stringify(out.accounts.properties[30].electric.map(l => l.s)) === '[[120,80],[1,2]]');
check('the snapshot on disk is not changed', JSON.stringify(snap) === before);

check('a drill-down on the building asks for both sides', merges.idsFor(30, groups).join(',') === '30,209');
check('a drill-down on any other building asks for itself', merges.idsFor(36, groups).join(',') === '36');
check('a member knows which building it went into', merges.primaryOf(209, groups) === 30 && merges.primaryOf(36, groups) === null);

check('no groups leaves the snapshot as it is', merges.apply(snap, []) === snap);
check('a group whose member is missing from the snapshot changes nothing',
  merges.apply(snap, [{ primary: 30, members: [999] }]) === snap);

// The file: bad rows are skipped, and a property cannot be claimed twice.
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'merges-')), 'm.json');
fs.writeFileSync(tmp, JSON.stringify({ groups: [
  { primary: 30, members: [209] },
  { primary: 209, members: [36] },
  { primary: 41, members: [] },
  { primary: 'x', members: [1] },
  { primary: 5, members: [5, 203, 204] },
] }));
const loaded = merges.loadGroups(tmp);
check('the file loads its valid groups', loaded.length === 2);
check('a property already in a building is not counted again', !loaded.some(g => g.primary === 209));
check('a primary listed as its own member is ignored', loaded[1].members.join(',') === '203,204');
check('a missing file means no merges', merges.loadGroups(tmp + '.nope').length === 0);

// The shipped file parses, and every group in it is well formed. The file is
// hand-kept - 18 groups over 43 property ids once the regional manager's October list went in -
// so these check what a hand edit gets wrong: a mistyped id, a building listed
// twice, a group with no name for the tab to show.
const shipped = merges.loadGroups();
const raw = JSON.parse(fs.readFileSync(merges.MERGES_FILE, 'utf8'));
const rawGroups = raw.groups || [];
check('config/property-merges.json: every group loads', shipped.length === rawGroups.length);
check('every group is named (the name is what the tab shows)', shipped.every(g => g.name && g.name.trim()));
check('every id is a positive whole number', rawGroups.every(g =>
  [g.primary, ...(g.members || [])].every(id => Number.isInteger(Number(id)) && Number(id) > 0)));
const allIds = shipped.flatMap(g => [g.primary, ...g.members]);
check('no building appears in two groups', new Set(allIds).size === allIds.length);
check('every group records why it is one building', rawGroups.every(g => g.why && g.why.trim()));

// --live: the half only Rent Manager can answer - does each id still reach the
// tab, and are both sides of a group in the SAME entity? They have to be. A group
// folds its members' dollars into the primary, so a member belonging to another
// entity would leave that entity's property rows no longer adding up to the
// entity total, and the tab would quietly disagree with itself. Kept out of the
// committed run (it needs credentials and a live pull) - run it after editing the
// file: `node scripts/checkPropertyMerges.js --live`.
async function live() {
  require('dotenv').config();
  const rm = require('../services/rentManagerClient');
  if (!rm.isConfigured()) { console.error('\n--live needs Rent Manager credentials in .env'); process.exit(1); }
  const map = await require('../services/entityMap').buildPropertyEntityMap(rm);
  console.log('');
  for (const g of shipped) {
    const sides = [g.primary, ...g.members].map(id => ({ id, entity: (map.byId.get(id) || {}).entity || null }));
    const missing = sides.filter(x => !x.entity).map(x => x.id);
    const entities = [...new Set(sides.map(x => x.entity).filter(Boolean))];
    check(`${g.name}: every side reaches the tab`, missing.length === 0);
    if (missing.length) console.log(`        no entity for ${missing.join(', ')} - that side is dropped before the tab sees it`);
    check(`${g.name}: both sides are one entity`, entities.length === 1);
    if (entities.length > 1) console.log(`        spans ${entities.join(' / ')} - folding these would unbalance both`);
  }
}

(async () => {
  if (process.argv.includes('--live')) await live();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\nAll property-merge checks passed.');
})().catch(e => { console.error(`\nERROR  ${e.message}`); process.exit(1); });
