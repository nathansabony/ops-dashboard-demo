#!/usr/bin/env node
// The API inventory sweep exists to answer one question — "what does this Rent
// Manager offer that we are not using?" — and there is exactly one way it can
// give a wrong answer: by calling a resource unused that some service reads every
// day. Then it invites work that is already done, and worse, it makes the whole
// report untrustworthy at the moment somebody acts on it.
//
// So the USED set is not maintained by memory. This greps the source for every
// resource this codebase actually requests and fails if one is missing from it.
//
//   node scripts/checkRmInventory.js

const fs = require('fs');
const path = require('path');
const { GROUPS, USED } = require('../services/rmInventory');

let fails = 0, checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
};

const ROOT = path.join(__dirname, '..');
const files = [
  ...fs.readdirSync(path.join(ROOT, 'services')).filter(f => f.endsWith('.js')).map(f => path.join('services', f)),
  'server.js',
];

// Matching on `.get('/Bills')` alone missed most of them: paths also live in
// tables (`{ path: '/Bills' }`), in helper wrappers, and in template literals
// with the id interpolated. In this codebase a Rent Manager path is always a
// string literal starting with a slash and a capital letter, and an app route
// always starts `/api`, so that is the rule — comments stripped first, because a
// resource NAMED in a comment is not a resource we read.
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
const RM_PATH = /[`'"]\/([A-Z][A-Za-z]*)\b/g;
const SKIP = new Set(['Authentication', 'Reports', 'ReportData']);
const requested = new Map();
for (const rel of files) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  let m;
  while ((m = RM_PATH.exec(src))) {
    if (!SKIP.has(m[1]) && !requested.has(m[1])) requested.set(m[1], rel);
  }
}

console.log('\nThe "we are not using this" column cannot lie');
{
  const missing = [...requested].filter(([name]) => !USED.has(name));
  check(`every resource the code requests is marked used (${requested.size} found in ${files.length} files)`,
    missing.length === 0,
    missing.map(([n, f]) => `${n} — requested in ${f}, absent from USED in services/rmInventory.js`).join('\n      '));
}
{
  // The other direction is a note, not a failure: a path built dynamically
  // (`/${name}`, as the bank and attachment probes do) cannot be seen by a static
  // grep, and a name that really has gone stale only makes the report
  // under-claim — which errs the safe way.
  const stale = [...USED].filter(n => !requested.has(n));
  console.log(stale.length
    ? `  · ${stale.length} name(s) in USED that no service currently requests: ${stale.join(', ')}`
    : '  · nothing stale in USED');
}

console.log('\nThe sweep itself');
{
  const names = GROUPS.flatMap(g => g.resources ? [] : g.names);
  check('every group carries resources and a reason to care',
    GROUPS.every(g => g.group && g.why && Array.isArray(g.names) && g.names.length),
    GROUPS.filter(g => !(g.group && g.why && g.names && g.names.length)).map(g => g.group).join(', '));
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  check('no resource is probed twice', dupes.length === 0, [...new Set(dupes)].join(', '));
  // The two that cost this project weeks. If either ever falls out of the sweep,
  // the next permission change goes unnoticed.
  check('the two resources that were wrong before are still swept',
    names.includes('Attachments') && names.includes('BankAccounts'));
  check('...alongside the ones that turned out to answer instead',
    names.includes('GLAccounts') && names.includes('Banks') && names.includes('Bills'));

  // The first live run reported /CheckDetails as unavailable. It answers a
  // filtered request perfectly and is the backbone of the whole payment side —
  // a report calling it missing is worse than no report.
  const { FILTERED_ATTEMPT_KEYS } = (() => {
    const src = fs.readFileSync(path.join(ROOT, 'services', 'rmInventory.js'), 'utf8');
    const block = /const FILTERED_ATTEMPT = \{([\s\S]*?)\n\};/.exec(src);
    return { FILTERED_ATTEMPT_KEYS: block ? [...block[1].matchAll(/^\s{2}([A-Za-z]+):/gm)].map(m => m[1]) : [] };
  })();
  check('a resource that only answers when filtered gets a filtered attempt',
    FILTERED_ATTEMPT_KEYS.includes('CheckDetails'), FILTERED_ATTEMPT_KEYS.join(', '));
  check('...and a list refusal is told apart from a missing resource',
    /NEEDS_FILTER/.test(fs.readFileSync(path.join(ROOT, 'services', 'rmInventory.js'), 'utf8')));
}

console.log('\nNo row values can escape');
{
  // The whole PII posture of this site is that tenant records stay server-side.
  // Half these resources are tenant-side, so a schema dump is safe and a row is
  // not — and the difference is one careless line.
  const src = fs.readFileSync(path.join(ROOT, 'services', 'rmInventory.js'), 'utf8');
  check('the sweep reads Object.keys and nothing else off a row',
    /function fieldsOf\([\s\S]*?Object\.keys\(row\)[\s\S]*?\n}/.test(src));
  check('...and no probe result carries a row or a sample value',
    !/sample(Row|Value)|rows\[0\]\.[A-Z]/.test(src.replace(/fieldsOf/g, '')),
    'a result that carries a row is a tenant record leaving the server');
}

console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
