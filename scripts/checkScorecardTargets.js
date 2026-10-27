// Scorecard targets (services/scorecardTargets.js): defaults, what a save keeps
// and refuses, and who may read and change them. Writes to a scratch file.

const os = require('os');
const path = require('path');
const fs = require('fs');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sct-')), 'targets.json');
process.env.SCORECARD_TARGETS_FILE = tmp;
const st = require('../services/scorecardTargets');
const accessControl = require('../services/accessControl');

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}
const ENTS = ['Willow Creek', 'Maple Court'];
const metric = (t, k) => t.metrics.find(m => m.key === k);

const d = st.load();
check('with nothing saved, the built-in defaults apply', metric(d, 'dscr').target === 1.25 && metric(d, 'dscr').floor === 1 && metric(d, 'occupancy').target === 95);
check('every metric says which way is better', d.metrics.every(m => m.better === 'higher' || m.better === 'lower'));

let r = st.save({ defaults: { occupancy: { target: 96, floor: 92 }, dscr: { target: 1.25, floor: 1 } }, entities: { 'Maple Court': { occupancy: { target: 85, floor: 75 } } } }, 'Owner', ENTS);
check('a save is accepted', r.ok);
const saved = JSON.parse(fs.readFileSync(tmp, 'utf8'));
check('only changed defaults are stored', saved.defaults.occupancy && !saved.defaults.dscr);
check('an entity target is stored', saved.entities['Maple Court'].occupancy.target === 85);
check('who changed it and when are kept', saved.updatedBy === 'Owner' && saved.updatedAt);
check('load returns the new default and remembers the built-in one', metric(r.targets, 'occupancy').target === 96 && metric(r.targets, 'occupancy').defaultTarget === 95);

r = st.save({ defaults: { margin: { target: 30, floor: 40 } } }, 'x', ENTS);
check('a target below its red line is refused (higher is better)', !r.ok && /at or above/.test(r.error));
r = st.save({ defaults: { expRatio: { target: 70, floor: 55 } } }, 'x', ENTS);
check('a target above its red line is refused (lower is better)', !r.ok && /at or below/.test(r.error));
r = st.save({ defaults: { dscr: { target: 'abc', floor: 1 } } }, 'x', ENTS);
check('a non-number is refused', !r.ok);
r = st.save({ defaults: { nonsense: { target: 1, floor: 1 } } }, 'x', ENTS);
check('an unknown metric is refused', !r.ok);
r = st.save({ entities: { 'Nowhere LLC': { dscr: { target: 1.2, floor: 1 } } } }, 'x', ENTS);
check('an unknown entity is refused', !r.ok);
check('a refused save leaves the stored targets alone', st.load().entities['Maple Court'].occupancy.target === 85);

const viewer = { admin: false, tools: ['overview'] };
check('a Home-only person cannot read the targets (Home shows grades only)', !accessControl.decide(viewer, 'GET', '/api/scorecard/targets').ok);
check('anyone with Portfolio can read the targets', accessControl.decide({ admin: false, tools: ['overview', 'entities'] }, 'GET', '/api/scorecard/targets').ok);
check('someone without Portfolio cannot', !accessControl.decide({ admin: false, tools: ['issues'] }, 'GET', '/api/scorecard/targets').ok);
check('only an admin can save them', !accessControl.decide(viewer, 'POST', '/api/admin/scorecard-targets').ok && accessControl.decide({ admin: true }, 'POST', '/api/admin/scorecard-targets').ok);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll scorecard target checks pass');
process.exit(failed ? 1 : 0);
