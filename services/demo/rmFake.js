// Fake Rent Manager. When DEMO_MODE=1, services/rentManagerClient.js hands every call
// here instead of the network. Route modules in ./routes/*.js each export
//   register(router, world)
// and add handlers with router.get(pathPattern, (ctx) => jsonBody).
//   pathPattern: string (exact, case-insensitive) or RegExp
//   ctx: { path, query, match, world }   (query = the same object the real client was given)
// A handler returns the JSON body exactly as Rent Manager would (array or object), or
// { __status, __body } to simulate an error. Unhandled paths throw a clear 404 so a
// missing emulation is loud, never a silent empty result.

const fs = require('fs');
const path = require('path');
const world = require('./world');

const routes = [];
const router = {
  get(pattern, handler) { routes.push({ pattern, handler }); },
  raw(pattern, handler) { routes.push({ pattern, handler, raw: true }); },
};

let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  const dir = path.join(__dirname, 'routes');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    require(path.join(dir, f)).register(router, world);
  }
}

function find(resourcePath) {
  load();
  const p = String(resourcePath).split('?')[0].replace(/^https?:\/\/[^/]+/i, '');
  for (const r of routes) {
    if (typeof r.pattern === 'string') { if (r.pattern.toLowerCase() === p.toLowerCase()) return { r, match: null, p }; }
    else { const m = p.match(r.pattern); if (m) return { r, match: m, p }; }
  }
  return null;
}

async function get(resourcePath, query = {}) {
  const hit = find(resourcePath);
  if (!hit) throw new Error(`Rent Manager request failed (404) for ${resourcePath}: demo data has no emulation for this resource`);
  const out = await hit.r.handler({ path: hit.p, query, match: hit.match, world });
  if (out && out.__status) throw new Error(`Rent Manager request failed (${out.__status}) for ${resourcePath}: ${out.__body || ''}`);
  return out;
}

// getRaw returns { ok, status, contentType, contentDisposition, buffer }
async function getRaw(resourcePath, query = {}) {
  const hit = find(resourcePath);
  if (hit && hit.r.raw) return hit.r.handler({ path: hit.p, query, match: hit.match, world });
  return { ok: false, status: 404, contentType: '', contentDisposition: '', buffer: Buffer.alloc(0) };
}

async function raw(method, resourcePath) {
  return { status: 405, body: 'Read-only demo data' };
}

module.exports = { get, getRaw, raw, router, world };
