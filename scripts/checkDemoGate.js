#!/usr/bin/env node
// The demo's optional PIN gate: closed without the PIN, open with it, open when unset.
const http = require('http');
const express = require('express');
const { makeGate } = require('./demoGate');
let bad = 0;
const check = (n, ok) => { console.log((ok ? 'ok   ' : 'FAIL ') + n); if (!ok) bad++; };

function req(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, method, path, headers }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const serve = pin => new Promise(resolve => {
  const app = express(); app.use(makeGate(pin)); app.get('*', (q, s) => s.send('site'));
  const srv = app.listen(0, () => resolve({ srv, port: srv.address().port }));
});

(async () => {
  const open = await serve('');
  check('no PIN set: the site is open', (await req(open.port)).body === 'site');
  open.srv.close();

  const { srv, port } = await serve('4321');
  const page = await req(port);
  check('PIN set: a visitor gets the PIN page, not the site', page.status === 401 && /enter the access PIN/.test(page.body) && !/site$/.test(page.body));
  check('PIN set: the API is refused', (await req(port, { path: '/api/overview' })).status === 401);
  const form = { method: 'POST', path: '/__pin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
  const wrong = await req(port, { ...form, body: 'pin=0000' });
  check('a wrong PIN is refused and sets no cookie', wrong.status === 401 && !wrong.headers['set-cookie']);
  const right = await req(port, { ...form, body: 'pin=4321' });
  const cookie = (right.headers['set-cookie'] || [''])[0].split(';')[0];
  check('the right PIN sets a cookie and redirects', right.status === 303 && /^demo_pin_ok=/.test(cookie));
  check('with the cookie the site opens', (await req(port, { headers: { Cookie: cookie } })).body === 'site');
  check('the cookie does not contain the PIN', !cookie.includes('4321'));
  srv.close();
  console.log(bad ? `\n${bad} failed` : '\nAll demo gate checks passed');
  process.exit(bad ? 1 : 0);
})();
