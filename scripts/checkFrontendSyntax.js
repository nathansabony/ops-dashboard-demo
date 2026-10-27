const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(code => code.trim());

scripts.forEach((code, index) => {
  new vm.Script(code, { filename: `index.html<script-${index + 1}>` });
});

console.log(`Parsed ${scripts.length} inline script blocks successfully.`);

// ── every API path the page calls must exist on the server ──────────────────
// Added 2026-08-26 after deleting the charge probe took the backup-coverage
// endpoint with it: the removal spanned from one endpoint's comment to the next
// endpoint's declaration, and a route that had been inserted between them fell
// inside the cut. Syntax was fine, the checks were green, and the tab called a
// route that returned 404 — found only because the sweep was re-run against the
// live site.
//
// A frontend that fetches a path the server does not serve is a broken feature,
// and it is cheap to notice here.
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const declared = new Set(
  [...serverSrc.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g)].map(m => m[1]));

// Paths built by template literal (`/api/x/${id}`) are matched on their literal
// prefix — the part before the first interpolation — since that is the segment a
// route declaration has to cover.
const called = new Set();
for (const m of html.matchAll(/fetch\(\s*[`'"](\/api\/[^`'"$?]*)/g)) called.add(m[1]);

// Express matches a declared path EXACTLY (params aside). A declared
// /api/renovations does NOT serve /api/renovations/backup-coverage, so a
// parent-prefix rule here would wave through precisely the mistake this exists to
// catch — as it did on the first attempt.
const missing = [];
for (const p of called) {
  const clean = p.replace(/\/+$/, '');
  const ok = [...declared].some((d) => {
    if (d === clean || d === p) return true;
    // The page built the path from a template literal, so what we captured is the
    // static prefix: /api/renovations/backup/file/ from `…/${id}`. That is served
    // by a declared route only if everything after the prefix is a :param.
    if (d.startsWith(`${clean}/`)) {
      return d.slice(clean.length + 1).split('/').every(seg => seg.startsWith(':'));
    }
    // A declared route with params covers a concrete path of the same shape.
    if (d.includes(':')) return new RegExp(`^${d.replace(/:[^/]+/g, '[^/]+')}$`).test(clean);
    return false;
  });
  if (!ok) missing.push(p);
}

if (missing.length) {
  console.error(`\n✗ the page fetches ${missing.length} path(s) the server does not declare:`);
  missing.forEach(p => console.error(`    ${p}`));
  console.error('\n  Either the route was removed, or it was renamed and the page was not.');
  process.exit(1);
}
console.log(`Checked ${called.size} API paths the page calls — all declared in server.js.`);
