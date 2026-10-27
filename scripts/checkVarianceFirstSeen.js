// When each variance flag was first seen (services/varianceFirstSeen.js) — the
// dates behind the Variances dashboard's "still open since {Mon}" tag.
//
// The owner's pre-mortem (2026-10-21): "the Top 5 stopped changing — same five
// flags for weeks". A flag open past one review cycle drops below fresh flags of
// the same score. That only works if the FIRST date sticks: a store that
// overwrote it on every pull would make every flag fresh forever. So:
//   • record() keeps the first date on a second call;
//   • junk ids (anything that is not a varFlagId string) are refused, not stored;
//   • a corrupt file reads as empty and record() still answers — never a throw;
//   • the per-call and whole-file caps hold.
// Also checks the page side: the Top 5 sort puts fresh before stale INSIDE a
// score, and the Overview tile's five are not touched. Writes to a scratch file.
//
// Run: npm run check:variance-first-seen

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-')), 'first-seen.json');
process.env.VARIANCE_FIRST_SEEN_FILE = tmp;
const fsn = require('../services/varianceFirstSeen');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '\n      ' + detail}`);
  if (!ok) failed += 1;
}

const A = 'prop:12|water_sewer|Aug 26|mom';
const B = 'prop:40|insurance|Sep 26|singleMonth';
const G = 'group:water_sewer:Aug 26:Demo Portfolio|water_sewer|Aug 26|varGroup';
const Z = 'group:gas:Jun 26|gas|Jun–Jul 26|zeroGroup';

console.log('\nFirst date sticks');
check('the store points at the scratch file', fsn.FILE === tmp);
check('with nothing saved, nothing is seen', Object.keys(fsn.load().seen).length === 0);

let r = fsn.record([A, B], '2026-08-03T12:00:00.000Z');
check('record() answers with the date for each id asked about', r[A] === '2026-08-03T12:00:00.000Z' && r[B] === '2026-08-03T12:00:00.000Z');
check('the file on disk is the sanitized shape', (() => {
  const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  return raw.version === 1 && raw.seen[A] === '2026-08-03T12:00:00.000Z' && raw.updatedAt;
})());

r = fsn.record([A, G, Z], '2026-10-21T09:00:00.000Z');
check('a second call keeps the FIRST date for an id already seen', r[A] === '2026-08-03T12:00:00.000Z', JSON.stringify(r));
check('...and stamps only the new ones with now', r[G] === '2026-10-21T09:00:00.000Z' && r[Z] === '2026-10-21T09:00:00.000Z');
check('...and answers only for the ids asked about, not the whole file', !(B in r) && Object.keys(r).length === 3);
check('ids with spaces, an en dash and an entity group key are valid', fsn.validId(Z) && fsn.validId(G) && fsn.validId('Demo Portfolio|mgmt_fee||trend'));

const before = fs.statSync(tmp).mtimeMs;
const again = fsn.record([A, B]);
check('re-posting a set that is all seen changes nothing', again[A] === '2026-08-03T12:00:00.000Z' && again[B] === '2026-08-03T12:00:00.000Z'
  && fs.statSync(tmp).mtimeMs === before);

console.log('\nJunk is refused');
const junk = ['', 'no pipes at all', 'a|b|c', 'a|b|c|d|e', '|line|Aug 26|mom', 'prop:1||Aug 26|mom', 'x'.repeat(301),
  'prop:1|line|Aug 26|mo m', 'prop:1|li\nne|Aug 26|mom', 42, null, { id: A }, ['nested']];
r = fsn.record(junk, '2026-10-21T09:00:00.000Z');
check('none of the junk ids is answered', Object.keys(r).length === 0, JSON.stringify(r));
check('...or stored', Object.keys(fsn.load().seen).length === 4);
check('a non-array body records nothing and does not throw', (() => {
  try { return Object.keys(fsn.record('prop:1|a|b|c')).length === 0 && Object.keys(fsn.record(undefined)).length === 0; }
  catch { return false; }
})());
check('a junk date passed as now falls back to the real now', (() => {
  const id = 'prop:77|gas|Sep 26|mom';
  const got = fsn.record([id], 'not a date')[id];
  return typeof got === 'string' && Math.abs(Date.parse(got) - Date.now()) < 60000;
})());

console.log('\nA corrupt file degrades to empty');
fs.writeFileSync(tmp, '{ not json');
check('a corrupt file reads as nothing seen rather than an error', Object.keys(fsn.load().seen).length === 0);
check('record() over a corrupt file still answers and rewrites it clean', (() => {
  try {
    const got = fsn.record([A], '2026-10-21T10:00:00.000Z');
    return got[A] === '2026-10-21T10:00:00.000Z' && JSON.parse(fs.readFileSync(tmp, 'utf8')).seen[A];
  } catch { return false; }
})());
fs.writeFileSync(tmp, JSON.stringify({ seen: { [A]: 'yesterday', 'junk key': '2026-01-01T00:00:00Z', [B]: '2026-09-01T00:00:00Z' } }));
check('junk keys and junk dates in the file are dropped on read', (() => {
  const s = fsn.load().seen;
  return Object.keys(s).length === 1 && s[B] === '2026-09-01T00:00:00.000Z';
})());
fs.writeFileSync(tmp, JSON.stringify({ seen: ['not', 'an', 'object'] }));
check('a seen that is not an object reads as empty', Object.keys(fsn.load().seen).length === 0);

console.log('\nCaps');
r = fsn.record(Array.from({ length: fsn.MAX_PER_CALL + 500 }, (_, i) => `prop:${i}|line|Aug 26|mom`), '2026-10-21T11:00:00.000Z');
check(`at most ${fsn.MAX_PER_CALL} ids are taken per call`, Object.keys(r).length === fsn.MAX_PER_CALL);
check('the file keeps the newest entries when over the cap (oldest dropped)', (() => {
  const seen = {};
  for (let i = 0; i < fsn.MAX_ENTRIES + 10; i++) seen[`prop:${i}|line|Aug 26|mom`] = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
  const s = fsn.sanitize({ seen }).seen;
  return Object.keys(s).length === fsn.MAX_ENTRIES && !s['prop:0|line|Aug 26|mom'] && !!s[`prop:${fsn.MAX_ENTRIES + 9}|line|Aug 26|mom`];
})());

console.log('\nThe route and the page');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
check('server.js serves POST /api/variance/first-seen through the store', /app\.post\('\/api\/variance\/first-seen'[\s\S]{0,400}varianceFirstSeen\.record\(/.test(SERVER));
check('the access map lists it with the Variances tool', (() => {
  const ac = require('../services/accessControl');
  const rule = ac.ruleFor('/api/variance/first-seen');
  return rule && rule.p === '/api/variance/first-seen' && JSON.stringify(rule.need) === JSON.stringify(['variances']);
})());
check('the page posts once per P&L pull, not on every repaint', /if \(_varFirstSeenFor === stamp\) return;/.test(PAGE)
  && /_liveData && _liveData\.refreshedAt/.test(PAGE));
check('the Top 5 sorts fresh before stale INSIDE a score (score first, then staleness)',
  /\(\(b\.scoreRaw \|\| 0\) - \(a\.scoreRaw \|\| 0\)\) \|\| \(\(staleOf\.get\(a\) \? 1 : 0\) - \(staleOf\.get\(b\) \? 1 : 0\)\)/.test(PAGE));
check('the Overview tile (_varOverviewFlags) does not read first-seen', (() => {
  const i = PAGE.indexOf('_varOverviewFlags = ownedAll.slice().sort(');
  const block = PAGE.slice(i, PAGE.indexOf('.slice(0, 5);', i));
  return i > 0 && !/staleOf|varStaleSince|_varFirstSeen/.test(block);
})());
check('stale rows get the tag through varRowHtml ctx.tag, not by editing the HTML after', /ctx\.tag \? `<span class="vt-rtag"/.test(PAGE));

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll first-seen checks passed.');
process.exit(failed ? 1 : 0);
