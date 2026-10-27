// Demo mode end to end: boots server.js with DEMO_MODE=1 and checks that a visitor is
// signed in as an admin with every tool and no PIN, that the seeded accounts live in the
// Admin tab, that email is a no-op, that the Ask panel answers its canned questions from the
// fake data without an API key (and says so), and that the Scanner returns a sample analysis.
// Everything runs against the built-in fake Rent Manager: no network, no credentials.

const { spawn } = require('child_process');
const path = require('path');

let failed = 0, total = 0;
function check(name, ok, detail) {
  total++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '\n      ' + detail}`);
  if (!ok) failed++;
}

async function getJson(base, p, opts) {
  const r = await fetch(base + p, opts);
  return { status: r.status, json: await r.json().catch(() => null), text: null };
}
async function ask(base, question) {
  const r = await fetch(base + '/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, context: { page: 'overview', text: '' } }) });
  const body = await r.text();
  const events = body.split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { status: r.status, text: events.filter(e => e.t === 'text').map(e => e.v).join(''), error: (events.find(e => e.t === 'error') || {}).v, done: events.some(e => e.t === 'done') };
}

(async () => {
  const port = 5700 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DEMO_MODE: '1', ANTHROPIC_API_KEY: '', DASHBOARD_ACCESS_PIN: '',
    RENTMANAGER_COMPANY: 'must-be-ignored', RENTMANAGER_USERNAME: 'x', RENTMANAGER_PASSWORD: 'x' };
  const child = spawn(process.execPath, [path.join(__dirname, 'demoServer.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(base + '/api/status')).ok) break; } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 250));
    }
    const st = await getJson(base, '/api/status');
    check('boots in demo mode and ignores Rent Manager credentials', st.json && st.json.mode === 'demo' && st.json.demo === true);
    check('no sign-in is required', st.json && st.json.tenantDataAuthRequired === false);

    const auth = await getJson(base, '/api/auth/status');
    const u = auth.json && auth.json.user;
    check('the visitor is the demo admin with every tool', !!u && u.admin === true && u.email === 'demo@cedarridge.example' && u.tools.length >= 9);

    const page = await fetch(base + '/');
    const html = await page.text();
    check('the page is served with the admin user written in', page.status === 200 && /window\.__OP_USER=/.test(html) && /"admin":true/.test(html) && /"demo":true/.test(html));
    check('the page is branded Cedar Ridge Management - Demo with the fictional-data ribbon', /<title>Cedar Ridge Management - Demo<\/title>/.test(html) && /all data is fictional/.test(html));

    const users = await getJson(base, '/api/admin/users');
    check('the Admin tab lists the seeded people', users.status === 200 && users.json.users.length >= 4 && users.json.users.some(x => x.name === 'Priya Natarajan'));
    check('email is "on" but a no-op in demo', users.json.mailEnabled === true && /not sent/i.test(users.json.mailInfo));
    const made = await getJson(base, '/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'new.person@cedarridge.example', name: 'New Person', invite: true, tools: ['entities'] }) });
    check('inviting a person works with no mail server', made.status === 200 && made.json.invited === true, JSON.stringify(made.json));
    const me = users.json.users.find(x => x.email === 'demo@cedarridge.example');
    const del = await getJson(base, `/api/admin/users/${me.id}`, { method: 'DELETE' });
    check('the demo admin cannot delete itself', del.status === 400);

    const occ = await ask(base, 'What is our occupancy?');
    check('Ask answers occupancy from the demo data', occ.status === 200 && /Occupancy is \d/.test(occ.text) && occ.done, occ.text.slice(0, 200));
    const dq = await ask(base, 'Who is delinquent?');
    check('Ask answers delinquency from the demo data', /owe \$/.test(dq.text), dq.text.slice(0, 200));
    const ds = await ask(base, 'Which property has the weakest DSCR?');
    check('Ask answers the weakest DSCR', /weakest debt coverage at \d\.\d\dx/.test(ds.text), ds.text.slice(0, 200));
    check('Ask says a key enables free-form answers', /ANTHROPIC_API_KEY/.test(occ.text));
    const other = await ask(base, 'Write me a poem');
    check('an unknown question gets the list of what it can answer, not an error', !other.error && /Try one of these/.test(other.text));
    check('the status endpoint says the assistant is canned', (await getJson(base, '/api/status')).json.assistant === 'canned');

    const k = await getJson(base, '/api/analyze-contract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'anything' }) });
    check('the contract analyzer returns a sample analysis with no key', k.status === 200 && k.json.demo === true && k.json.json.one_line_summary && k.json.json.flagged_risks.length > 0);

    const news = await getJson(base, '/api/market-news');
    check('market news always has rates and headlines (built-in sample when offline)', news.status === 200 && news.json.rates.length >= 4 && news.json.articles.length >= 3);

    const keep = await getJson(base, '/api/contracts-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'Laundry Lease' }) });
    const hist = await getJson(base, '/api/contracts-history');
    check('past contract analyses are kept for the session', keep.status === 200 && hist.json.some(e => e.type === 'Laundry Lease'));
  } catch (err) {
    check('the run did not crash', false, err.stack);
  } finally {
    child.kill();
  }
  console.log(failed ? `\n${failed} of ${total} demo checks FAILED\n${log.split('\n').slice(-15).join('\n')}` : `\nAll ${total} demo checks passed`);
  process.exit(failed ? 1 : 0);
})();
