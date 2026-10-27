// Handled entity action items (services/entityActions.js): what a mark keeps,
// what it refuses, when a handled item comes back, and that the page's copy of
// the reopen rule is the server's. Writes to a scratch file.
//
// Run: npm run check:entity-actions

const os = require('os');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ea-')), 'actions.json');
process.env.ENTITY_ACTIONS_FILE = tmp;
const ea = require('../services/entityActions');
const accessControl = require('../services/accessControl');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '\n      ' + detail}`);
  if (!ok) failed += 1;
}

console.log('\nThe store');
check('with nothing saved, nothing is handled', Object.keys(ea.load().handled).length === 0);

let s = ea.handle('EA:Cedar Ridge:occupancy', '  Leasing push started, 6 applications in  ', 89.7, 'Regional Manager');
check('a mark is kept with who, when, the note and the value', (() => {
  const h = s.handled['EA:Cedar Ridge:occupancy'];
  return h && h.by === 'Regional Manager' && h.note === 'Leasing push started, 6 applications in' && h.value === 89.7 && h.at && h.date;
})());
check('the file on disk is the sanitized shape', (() => {
  const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  return raw.version === 1 && raw.handled['EA:Cedar Ridge:occupancy'].value === 89.7 && raw.updatedBy === 'Regional Manager';
})());

s = ea.handle('EA:Willow Creek:dscr', 'Asked Dana about GL 6230', null, 'Owner');
check('a data item (no figure) is kept with a null value', s.handled['EA:Willow Creek:dscr'].value === null);
check('an entity name with a space is a valid key', ea.validKey('EA:Maple Court:pl'));

let threw = null;
try { ea.handle('RR:Cedar Ridge:occupancy', 'x', 1, 'x'); } catch (err) { threw = err; }
check('a Variances key is refused — this store is for entity items only', threw && threw.code === 'BAD_KEY');
threw = null;
try { ea.handle('EA:Cedar Ridge:margin', 'x', 1, 'x'); } catch (err) { threw = err; }
check('an unknown rule is refused (margin and expense ratio share "pl")', threw && threw.code === 'BAD_KEY');
check('a refused mark leaves the stored ones alone', Object.keys(ea.load().handled).length === 2);

s = ea.handle('EA:Cedar Ridge:occupancy', 'x'.repeat(900), 90.1, 'Regional Manager');
check('re-marking overwrites the mark and caps the note', s.handled['EA:Cedar Ridge:occupancy'].value === 90.1 && s.handled['EA:Cedar Ridge:occupancy'].note.length === 500);

s = ea.unhandle('EA:Cedar Ridge:occupancy', 'Owner');
check('putting an item back removes only that mark', !s.handled['EA:Cedar Ridge:occupancy'] && s.handled['EA:Willow Creek:dscr']);
check('an unknown key on unhandle is a no-op, not an error', Object.keys(ea.unhandle('EA:Nowhere:pl', 'x').handled).length === 1);

fs.writeFileSync(tmp, '{ not json');
check('a corrupt file reads as nothing handled rather than an error', Object.keys(ea.load().handled).length === 0);
fs.writeFileSync(tmp, JSON.stringify({ handled: { 'EA:Cedar Ridge:occupancy': { value: 'abc', by: 42 }, 'junk': { note: 'x' } } }));
check('junk keys are dropped and a non-numeric value reads as none', (() => {
  const h = ea.load().handled;
  return Object.keys(h).length === 1 && h['EA:Cedar Ridge:occupancy'].value === null && h['EA:Cedar Ridge:occupancy'].by === null;
})());

console.log('\nWhen a handled item comes back');
const occ = { value: 91.2 };
check('occupancy holding or improving stays handled', !ea.reopened(occ, 91.2, 'higher', 0.5) && !ea.reopened(occ, 93, 'higher', 0.5));
check('occupancy a rounding wobble lower stays handled', !ea.reopened(occ, 90.9, 'higher', 0.5));
check('occupancy clearly lower comes back', ea.reopened(occ, 89.0, 'higher', 0.5));
const dq = { value: 6.1 };
check('delinquency (lower is better) rising comes back, falling does not', ea.reopened(dq, 7.5, 'lower', 0.5) && !ea.reopened(dq, 5.0, 'lower', 0.5));
check('a mark with no figure never reopens itself', !ea.reopened({ value: null }, 1, 'higher', 0) && !ea.reopened(null, 1, 'higher', 0));

// The page has its own copy of the rule (eaReopened in public/index.html), so a
// change to one without the other would make the page and the store disagree
// about whether an item is open. Lift the page's and run the same cases.
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const m = PAGE.match(/function eaReopened\(entry, flag\) \{[\s\S]*?\n\}/);
const tol = PAGE.match(/const EA_REOPEN_TOL = (\{[^}]+\});/);
check('the page defines eaReopened and its tolerances', !!m && !!tol);
if (m && tol) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`const EA_REOPEN_TOL = ${tol[1]};\n${m[0]}`, ctx);
  const cases = [
    [{ value: 91.2 }, { value: 89.0, unit: '%', better: 'higher' }, 0.5],
    [{ value: 91.2 }, { value: 90.9, unit: '%', better: 'higher' }, 0.5],
    [{ value: 6.1 }, { value: 7.5, unit: '%', better: 'lower' }, 0.5],
    [{ value: 1.1 }, { value: 1.07, unit: 'x', better: 'higher' }, 0.02],
    [{ value: 1.1 }, { value: 1.09, unit: 'x', better: 'higher' }, 0.02],
    [{ value: null }, { value: 1, unit: 'x', better: 'higher' }, 0.02],
  ];
  const agree = cases.every(([entry, flag, t]) => ctx.eaReopened(entry, flag) === ea.reopened(entry, flag.value, flag.better, t));
  check('the page and the server agree on every reopen case', agree);
}

// Every rule the page can raise a flag for must be a rule the server accepts,
// or clicking Handled on that flag would be refused with a 400 and look broken.
// And the reverse: a server rule the page can no longer raise is dead weight.
const labels = PAGE.match(/const EA_LABEL = \{([^}]+)\};/);
check('the page defines its flag rules', !!labels);
if (labels) {
  const pageRules = [...labels[1].matchAll(/(\w+):/g)].map(x => x[1]).sort();
  check('the page and the server agree on the set of rules a flag can carry',
    JSON.stringify(pageRules) === JSON.stringify([...ea.RULES].sort()),
    `page: ${pageRules.join(',')} server: ${[...ea.RULES].sort().join(',')}`);
}
check('the page marks a flag with the key shape the server validates', /key: `EA:\$\{e\}:\$\{rule\}`/.test(PAGE) && ea.validKey('EA:Cedar Ridge:occupancy'));
check('a merged data flag has no key, so it can never be marked handled', /key: null, ents, e: ents\.join/.test(PAGE));

console.log('\nWho may mark');
const viewer = { admin: false, tools: ['entities'] };
check('anyone with the Entities tab can read and mark', accessControl.decide(viewer, 'GET', '/api/entities/actions').ok && accessControl.decide(viewer, 'POST', '/api/entities/actions').ok);
check('someone without Overview or Entities cannot', !accessControl.decide({ admin: false, tools: ['issues'] }, 'POST', '/api/entities/actions').ok);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll entity action checks pass');
process.exit(failed ? 1 : 0);
