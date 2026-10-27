// Optional PIN gate in front of the demo. Set DEMO_ACCESS_PIN on the host (Render env var,
// never committed) and every visitor must type it once; a signed cookie then remembers them
// for 30 days. Unset, the demo is open (local development). Behind the gate the visitor is
// still auto-signed in as the demo admin - the PIN only decides who may see the site at all.
const crypto = require('crypto');

const COOKIE = 'demo_pin_ok';
const MAX_AGE_S = 30 * 24 * 3600;
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function makeGate(pin) {
  if (!pin) return (req, res, next) => next();
  // The cookie is an HMAC of the PIN, so changing the PIN on the host signs everyone out.
  const token = crypto.createHmac('sha256', 'portfolio-dashboard-demo-gate').update(pin).digest('hex');
  const tries = new Map();   // ip -> { n, at }: 8 wrong PINs, then a 5 minute pause
  const page = (msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Portfolio Management Dashboard Demo</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F3EC;font-family:system-ui,sans-serif;color:#14342A}
form{background:#FFFDFA;border:1px solid #E6E1D6;border-radius:10px;padding:32px;width:300px;text-align:center}
h1{font:600 20px Georgia,serif;margin:0 0 6px}p{font-size:13px;color:#6b665c;margin:0 0 18px}
input{width:100%;box-sizing:border-box;padding:12px;font-size:20px;text-align:center;letter-spacing:4px;border:1px solid #E6E1D6;border-radius:6px;margin-bottom:12px}
button{width:100%;padding:12px;font-size:14px;font-weight:600;color:#FFFDFA;background:#14532D;border:0;border-radius:6px;cursor:pointer}
.e{color:#A32B2B;font-size:12.5px;min-height:18px;margin-top:10px}</style></head><body>
<form method="post" action="/__pin"><h1>Portfolio Management Dashboard</h1><p>Demo - enter the access PIN</p>
<input name="pin" type="password" autocomplete="off" placeholder="PIN" autofocus><button>Enter</button><div class="e">${msg || ''}</div></form></body></html>`;

  return (req, res, next) => {
    if (parseCookies(req.headers.cookie)[COOKIE] === token) return next();
    if (req.method === 'POST' && req.path === '/__pin') {
      const ip = req.ip || '';
      const t = tries.get(ip) || { n: 0, at: 0 };
      if (t.n >= 8 && Date.now() - t.at < 5 * 60 * 1000) return res.status(429).send(page('Too many tries - wait a few minutes.'));
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1000) req.destroy(); });
      req.on('end', () => {
        const given = new URLSearchParams(body).get('pin') || '';
        if (same(given, pin)) {
          tries.delete(ip);
          res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
          return res.redirect(303, '/');
        }
        tries.set(ip, { n: t.n + 1, at: Date.now() });
        res.status(401).send(page('That PIN is not right.'));
      });
      return;
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'PIN required' });
    res.status(401).send(page(''));
  };
}

module.exports = { makeGate };
