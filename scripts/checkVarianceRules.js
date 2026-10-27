#!/usr/bin/env node
// Proves the rules screen — the one added 2026-08-26 so the model can be read and
// retuned from the tab instead of from a file nobody opens.
//
// Two halves, and they fail in different ways:
//
//   1. THE WORDS. The per-category box prints sentences like "the month has to
//      move up by at least 15% against the month before it". Those sentences are
//      worth having only if they are the rules — a box that describes a threshold
//      the detector is not using is worse than no box, because it ends the
//      argument in the wrong direction. So every number in every sentence is
//      checked against the item it came from.
//   2. THE STORE. Edits are shared, validated server-side, and stored as a DIFF
//      against services/varianceConfig.js. The whole round trip runs here against
//      a scratch file: save, merge, re-derive, reject, drop-when-same-as-default,
//      reset.
//
// No Rent Manager, no browser, no financial figures — the thresholds it prints
// are the model's own knobs, which are already in the repo.
//
//   node scripts/checkVarianceRules.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// Point the store at a scratch file BEFORE the service loads it — this must never
// touch data/variance-rules.json, which on the host holds the team's real tuning.
const SCRATCH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'varrules-')), 'variance-rules.json');
process.env.VARIANCE_RULES_FILE = SCRATCH;

const varianceConfig = require('../services/varianceConfig');
const overrides = require('../services/varianceRuleOverrides');

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
}

// ── half one: the sentences are the rules ───────────────────────────────────
// varRuleLines is lifted out of the page and run for real, so the check cannot
// drift from what a person reads on screen.
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function lift(decl) {
  const at = html.indexOf(decl);
  if (at === -1) throw new Error(`checkVarianceRules: ${decl} not found in index.html`);
  let i = html.indexOf('{', at), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
  }
  throw new Error(`checkVarianceRules: ${decl} has no closing brace`);
}

const cfg = overrides.apply(varianceConfig.getConfig());
const sandbox = { _varModel: cfg.model, console };
vm.createContext(sandbox);
vm.runInContext([lift('const VAR_DIR_WORD'), lift('function fmtExact'), lift('function varRuleLines')].join('\n\n'), sandbox);

const money = n => `$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;

console.log('\nThe rules box says what the detector does');
{
  let bad = [];
  for (const item of cfg.items) {
    const lines = sandbox.varRuleLines(item);
    const text = lines.map(l => l.text).join(' ');
    if (item.enabled === false) {
      if (!/never raises a flag/.test(text)) bad.push(`${item.key}: an untracked line does not say so`);
      continue;
    }
    if (item.monthAbs) {
      // The single-month lines have no step-1 maths at all, and saying they did
      // would be the most misleading sentence on the screen.
      if (!text.includes(money(item.monthAbs))) bad.push(`${item.key}: single-month threshold ${money(item.monthAbs)} missing`);
      if (/Step 1/.test(lines.map(l => l.label).join(' '))) bad.push(`${item.key}: a single-month line must not claim month-over-month maths`);
    } else {
      if (!text.includes(`${Math.round(item.pct * 100)}%`)) bad.push(`${item.key}: pct gate ${Math.round(item.pct * 100)}% missing`);
      if (!text.includes(money(item.minImpact))) bad.push(`${item.key}: dollar floor ${money(item.minImpact)} missing`);
      const dir = { rise: 'up', drop: 'down', both: 'either way' }[item.direction];
      if (!text.includes(`move ${dir}`)) bad.push(`${item.key}: direction "${dir}" not stated`);
      if (item.redPct && !text.includes(`${Math.round(item.redPct * 100)}%`)) bad.push(`${item.key}: red gate missing`);
    }
    if (item.postingGateDays && !text.includes(`${item.postingGateDays} days`)) bad.push(`${item.key}: posting gate not stated`);
    if (item.zeroOkMonths && item.zeroOkMonths.length && !text.includes(item.zeroOkMonths.join(', '))) bad.push(`${item.key}: seasonal months not stated`);
    if (item.zeroRunMonths && !text.includes(String(item.zeroRunMonths))) bad.push(`${item.key}: zero-run length not stated`);
    // A seasonal line has to say so, and say it is context rather than a gate —
    // "water & sewer is seasonal now" must never read as "water & sewer flags
    // less". 2301 Willow Creek Rd's +$12K July is still a flag; it just arrives with
    // last July beside it.
    if (item.seasonalYoYContext) {
      if (!text.includes(item.seasonalYoYTitle || 'Season, or ours?')) bad.push(`${item.key}: seasonal panel not named in the box`);
      if (!/context, not a gate/.test(text)) bad.push(`${item.key}: seasonal context reads as if it changed the gate`);
    }
    if (item.group !== 'income' && !text.includes(money(cfg.model.negMinAbs))) bad.push(`${item.key}: credit floor not stated`);
  }
  check(`every tracked line's box quotes its own thresholds (${cfg.items.length} lines)`, !bad.length, bad.join('\n      '));
}
{
  // The `why` sentence is shown as the headline of each rules box, so a stale one
  // is now visible rather than buried in a config file.
  const stale = cfg.items.filter(i => i.enabled !== false && /prior quarter|20 days/i.test(i.why || ''));
  check('no line still describes a model this tab stopped using',
    !stale.length, stale.map(i => `${i.key}: "${(i.why || '').slice(0, 60)}…"`).join('\n      '));
}

// ── half two: the store ─────────────────────────────────────────────────────
console.log('\nEditing, storing and merging');
{
  const base = varianceConfig.getConfig();
  const defaultPct = base.items.find(i => i.key === 'electric').pct;

  overrides.setItem('electric', { pct: 0.45 }, 'owner');
  let merged = overrides.apply(varianceConfig.getConfig());
  const electric = merged.items.find(i => i.key === 'electric');
  check('a saved edit comes back merged', electric.pct === 0.45, `got ${electric.pct}`);
  check('...marked as an override, with the default it replaced',
    merged.overrides.electric && merged.overrides.electric.fields.includes('pct')
    && merged.overrides.electric.defaults.pct === defaultPct,
    JSON.stringify(merged.overrides.electric));
  check('...and attributed', merged.overrides.electric.by === 'owner');

  // The edited item still goes through finalize(), so derived fields hold.
  check('an edited line is still derived like a default one',
    electric.flagNegative === true && electric.yoy != null && electric.mode === 'operating');

  // Only the field that changed is stored: the file is a diff, so a later change
  // to a default in varianceConfig.js still reaches the tab.
  const stored = JSON.parse(fs.readFileSync(SCRATCH, 'utf8'));
  check('only the changed field is stored (the file is a diff, not a copy)',
    Object.keys(stored.items.electric.values).join() === 'pct', JSON.stringify(stored.items.electric.values));

  // Saving a value back to its default is not an override.
  overrides.setItem('electric', { pct: defaultPct }, 'owner');
  merged = overrides.apply(varianceConfig.getConfig());
  check('setting a field back to its default drops the override',
    !merged.overrides.electric, JSON.stringify(merged.overrides.electric || {}));

  // Bounds, enums and unknown fields.
  const rejects = [
    ['pct out of range', { pct: 99 }],
    ['a percentage that is not a number', { pct: 'lots' }],
    ['an unknown direction', { direction: 'sideways' }],
    ['a tier that is not a tier', { urgency: 'urgent' }],
    ['a posting gate beyond a year', { postingGateDays: 999 }],
  ];
  let rejected = 0;
  for (const [, patch] of rejects) {
    try { overrides.setItem('electric', patch, 'test'); } catch (e) { if (e.code === 'BAD_VALUE') rejected++; }
  }
  check(`every out-of-range value is refused (${rejected}/${rejects.length})`, rejected === rejects.length);

  try { overrides.setItem('notALine', { pct: 0.2 }, 'test'); check('an unknown line is refused', false); }
  catch (e) { check('an unknown line is refused', e.code === 'BAD_KEY'); }

  // The thing that must never be editable from a browser.
  overrides.setItem('electric', { glRefs: ['9999'], key: 'hacked', label: 'nope', group: 'income' }, 'test');
  merged = overrides.apply(varianceConfig.getConfig());
  const still = merged.items.find(i => i.key === 'electric');
  check('glRefs, key, label and group cannot be changed from the API',
    still && still.glRefs.join() === '5404' && still.label === 'Electric' && still.group === 'expense'
    && !merged.overrides.electric,
    JSON.stringify(still && { refs: still.glRefs, label: still.label, group: still.group }));

  // Seasonal months, the field that makes a line different from its neighbours.
  overrides.setItem('electric', { zeroOkMonths: ['Jul', 'Aug', 'Nope', 'Aug'] }, 'manager');
  merged = overrides.apply(varianceConfig.getConfig());
  check('month lists are de-duplicated and filtered to real months',
    merged.items.find(i => i.key === 'electric').zeroOkMonths.join() === 'Jul,Aug',
    JSON.stringify(merged.items.find(i => i.key === 'electric').zeroOkMonths));

  // Global knobs.
  overrides.setModel({ negMinAbs: 500 }, 'owner');
  merged = overrides.apply(varianceConfig.getConfig());
  check('a global knob merges into the model', merged.model.negMinAbs === 500, String(merged.model.negMinAbs));
  check('...and is marked as overridden', !!merged.overrides._model);
  let threw = false;
  try { overrides.setModel({ abnormalZ: 99 }, 'owner'); } catch (e) { threw = e.code === 'BAD_VALUE'; }
  check('an out-of-range global knob is refused', threw);

  // Reset, one line and then everything.
  overrides.reset('electric', 'owner');
  merged = overrides.apply(varianceConfig.getConfig());
  check('resetting one line returns it to the file default',
    merged.items.find(i => i.key === 'electric').pct === defaultPct && !merged.overrides.electric);
  check('...and leaves the global knob alone', merged.model.negMinAbs === 500);
  overrides.reset(null, 'owner');
  merged = overrides.apply(varianceConfig.getConfig());
  check('resetting everything returns the whole model to the file',
    !Object.keys(merged.overrides).length && merged.model.negMinAbs === base.model.negMinAbs);

  // A corrupt store must not take the tab down.
  fs.writeFileSync(SCRATCH, '{ this is not json');
  const recovered = overrides.apply(varianceConfig.getConfig());
  check('a corrupt store degrades to the defaults instead of throwing',
    recovered.items.length === base.items.length && !Object.keys(recovered.overrides).length);
}

// ── the editor is built from the server's own field table ───────────────────
console.log('\nThe editor and the validator describe the same rules');
{
  const applied = overrides.apply(varianceConfig.getConfig());
  const fields = applied.editable && applied.editable.fields;
  check('the payload carries the field table the screen is built from', !!fields);
  const missingHelp = Object.entries(fields || {}).filter(([, s]) => !s.label || !s.help).map(([k]) => k);
  check('every editable field has a label and an explanation', !missingHelp.length, missingHelp.join(', '));
  const core = ['enabled', 'direction', 'pct', 'redPct', 'minImpact', 'urgency', 'why'];
  const absent = core.filter(f => !fields[f]);
  check('the fields the screen always shows all exist', !absent.length, absent.join(', '));
}

try { fs.rmSync(path.dirname(SCRATCH), { recursive: true, force: true }); } catch { /* scratch dir */ }

console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
