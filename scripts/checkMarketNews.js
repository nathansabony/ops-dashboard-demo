// Market news (services/marketNews.js): feed parsing, the relevance gate, the
// daily rotation, rate summaries, the morning schedule, and the fallbacks. Canned
// XML / CSV / JSON throughout — no network. Writes to a scratch file.

const os = require('os');
const path = require('path');
const fs = require('fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-'));
process.env.MARKET_NEWS_FILE = path.join(dir, 'market-news.json');
const mn = require('../services/marketNews');
const accessControl = require('../services/accessControl');

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

const NOW = Date.parse('2026-10-22T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toUTCString();

const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items.join('')}</channel></rss>`;
const item = (title, link, h, desc = '', extra = '') =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${hoursAgo(h)}</pubDate><description>${desc}</description>${extra}</item>`;

// ── parsing ──────────────────────────────────────────────────────────────────
const feed = { id: 'bisnow', name: 'Bisnow' };
let items = mn.parseFeed(rss([
  item('<![CDATA[Multifamily lenders &amp; the Fed: rates fall]]>', 'https://example.com/a', 3,
    '&lt;p&gt;Lenders are pricing in cuts. A second sentence follows here.&lt;/p&gt;'),
  item('No link', 'not-a-url', 3),
  `<item><title>No date</title><link>https://example.com/b</link></item>`,
]), feed);
check('RSS: CDATA, entities and escaped HTML are decoded', items.length === 1 && items[0].title === 'Multifamily lenders & the Fed: rates fall');
check('RSS: the snippet is one plain sentence', items[0].snippet === 'Lenders are pricing in cuts.');
check('RSS: items without an http(s) link or a date are dropped', items.length === 1);
check('RSS: source defaults to the feed name', items[0].source === 'Bisnow');

items = mn.parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Apartment rents rise in Miami</title><link href="https://example.com/atom"/><updated>${new Date(NOW - 3600000).toISOString()}</updated><summary>Rents are up.</summary></entry></feed>`, feed);
check('Atom entries parse (href link, updated date)', items.length === 1 && items[0].link === 'https://example.com/atom');

items = mn.parseFeed(rss([item('Lender pressure opens doors for multifamily buyers - GlobeSt', 'https://news.google.com/x', 2,
  'Lender pressure opens doors for multifamily buyers&nbsp;&nbsp;GlobeSt', '<source url="https://globest.com">GlobeSt</source>')]), { id: 'gn-test', name: 'Google News' });
check('Google News: the outlet is split off the title and named as the source', items[0].title === 'Lender pressure opens doors for multifamily buyers' && items[0].source === 'GlobeSt');
check('Google News: a description that just repeats the headline is dropped', items[0].snippet === '');

// ── relevance ────────────────────────────────────────────────────────────────
const rel = mn.relevance;
check('multifamily + rates in the headline clears the bar', rel('Multifamily lenders brace as the Fed holds interest rates', '') >= 4);
check('a place name alone is not enough (no topic term)', rel('Miami welcomes a new restaurant', 'Best new place in Miami') === 0);
check('a consumer listing is pushed down', rel('Celebrity mansion for sale in Miami', 'luxury home with apartment wing') < 4);
check('Fed + mortgage rates qualify', rel('Mortgage rates fall after Fed minutes', '') >= 4);

// ── selection and rotation ───────────────────────────────────────────────────
const cand = (title, source, h, bonus = 0) => ({ title, link: 'https://example.com/' + encodeURIComponent(title), source, publishedAt: new Date(NOW - h * 3600000).toISOString(), snippet: '', bonus });
const day1 = mn.selectArticles([
  cand('Multifamily debt costs jump as Treasury yields climb', 'Bisnow', 4, 1),
  cand('Fed signals rate cut path; apartment lenders react', 'Connect CRE', 6, 1),
  cand('Ohio multifamily sales volume hits record', 'Real Estate OH', 8),
  cand('Ohio apartment rents soften, lenders tighten', 'Globest', 10),
  cand('Agency multifamily lending: Fannie Mae raises caps', 'Commercial Observer', 12, 1),
  cand('Mortgage rates today: 30-year refinance drops', 'Norada', 14),
  cand('Miami celebrity mansion tour', 'Gossip', 1),
], [], NOW);
check('five articles show, the irrelevant one never does', day1.length === 5 && !day1.some(a => /mansion/.test(a.title)));
check('the list is newest first', day1.every((a, i) => i === 0 || Date.parse(a.publishedAt) <= Date.parse(day1[i - 1].publishedAt)));

const strongest = day1.slice().sort((a, b) => b.relevance - a.relevance).slice(0, 2).map(a => a.title);
const NEXT = NOW + 86400000;
const day2cands = [
  ...day1.map(a => ({ ...a, bonus: 0, publishedAt: a.publishedAt })),
  cand('Apartment REIT cuts guidance as multifamily rents stall', 'Bloomberg', 2, 1),
  cand('Fed minutes: lenders see interest rates staying high', 'Federal Reserve', 3, 2),
  cand('Ohio apartment tower wins refinancing from lender', 'NJBIZ', 5),
  cand('Commercial real estate lending thaws in central Ohio', 'Bisnow', 7),
];
const day2 = mn.selectArticles(day2cands, day1, NEXT);
const day2titles = day2.map(a => a.title);
check('the two strongest from yesterday stay', strongest.every(t => day2titles.includes(t)));
check('the other three are new stories', day2.filter(a => !day1.some(b => b.title === a.title)).length === 3);
check('no outlet appears more than twice', Object.values(day2.reduce((m, a) => (m[a.source] = (m[a.source] || 0) + 1, m), {})).every(n => n <= 2));

const old = mn.selectArticles([cand('Multifamily lenders and interest rates, a week-old story', 'Bisnow', 24 * 9, 1)], [], NOW);
check('stories older than a week are ignored', old.length === 0);
const dupes = mn.selectArticles([cand('Multifamily interest rates: a story', 'A', 3, 1), cand('Multifamily Interest Rates - a story!', 'B', 4, 1)], [], NOW);
check('the same story from two feeds shows once', dupes.length === 1);
const agedPrev = { ...cand('Multifamily lenders and interest rates, old but strong', 'Bisnow', 24 * 6), relevance: 20 };
const agedOut = mn.selectArticles([
  cand('Multifamily lenders and interest rates, old but strong', 'Bisnow', 24 * 6, 2),
  ...[1, 2, 3, 4, 5].map(i => cand('Apartment lending and Fed interest rates, story ' + i, 'Outlet ' + i, i, 1)),
], [agedPrev], NOW);
check('a yesterday-strong story is not pinned once it passes five days', !agedOut.some(a => /old but strong/.test(a.title)) && agedOut.length === 5);
check('a thin news day returns fewer than five, not filler', mn.selectArticles([cand('Multifamily lending and interest rates', 'A', 2, 1)], [], NOW).length === 1);

// ── rates ────────────────────────────────────────────────────────────────────
const csv = 'Date,"1 Mo","5 Yr","10 Yr"\n10/21/2026,4.09,4.95,5.13\n10/20/2026,4.10,4.97,5.15\n10/14/2026,4.12,5.00,5.19\n09/21/2026,4.00,4.83,4.96\n09/18/2026,4.00,4.80,4.95';
const t10 = mn.parseTreasuryCsv(csv, '10 Yr');
check('Treasury CSV: reads the chosen column, dates ISO', t10.length === 5 && t10[0].date === '2026-10-21' && t10[0].value === 5.13);
check('Treasury CSV: an unknown column gives nothing, not a crash', mn.parseTreasuryCsv(csv, '99 Yr').length === 0);
const s10 = mn.summarizeRate({ key: 'ust10', label: '10-Yr Treasury', note: 'n', source: 'U.S. Treasury' }, t10);
check('rate summary: latest value and as-of date', s10.value === 5.13 && s10.asOf === '2026-10-21');
check('rate summary: change vs a week and a month earlier (percentage points)', s10.chgWeek === -0.06 && s10.chgMonth === 0.17);
check('NY Fed JSON parses', mn.parseNyFed({ refRates: [{ effectiveDate: '2026-10-21', percentRate: 3.88 }] })[0].value === 3.88);
check('Freddie Mac CSV parses', mn.parsePmms('date,pmms30\n10/15/2026,7.40\n10/8/2026,7.3')[0].date === '2026-10-15');
check('no observations gives no summary', mn.summarizeRate({ key: 'x' }, []) === null);

// ── schedule ─────────────────────────────────────────────────────────────────
// Oct 22 2026 is EDT (UTC-4): 6am ET = 10:00Z.
check('last due moment: after 6am ET it is today 6am', mn.lastDueEpoch(Date.parse('2026-10-22T12:00:00Z')) === Date.parse('2026-10-22T10:00:00Z'));
check('...before 6am ET it is yesterday 6am', mn.lastDueEpoch(Date.parse('2026-10-22T08:00:00Z')) === Date.parse('2026-10-21T10:00:00Z'));
check('...and winter (EST, UTC-5) is an hour later in UTC', mn.lastDueEpoch(Date.parse('2026-12-10T13:00:00Z')) === Date.parse('2026-12-10T11:00:00Z'));

// ── refresh, fallbacks, cache ────────────────────────────────────────────────
const good = (url) => {
  if (/treasury\.gov/.test(url)) return Promise.resolve(csv + '\n'.repeat(0));
  if (/newyorkfed/.test(url)) return Promise.resolve(JSON.stringify({ refRates: [
    { effectiveDate: '2026-10-21', percentRate: 3.88 }, { effectiveDate: '2026-10-14', percentRate: 3.88 }, { effectiveDate: '2026-09-21', percentRate: 3.85 }] }));
  if (/freddiemac/.test(url)) return Promise.resolve('date,pmms30\n9/17/2026,6.76\n10/8/2026,7.31\n10/15/2026,7.40');
  return Promise.resolve(rss([
    item('Multifamily lenders react to Fed interest rates move', 'https://example.com/1', 2),
    item('Apartment refinancing wave hits Ohio', 'https://example.com/2', 5),
    item('Unrelated: a recipe for soup', 'https://example.com/3', 1),
  ]));
};
(async () => {
  let out = await mn.refresh({ get: good, now: NOW });
  check('a refresh returns all five rates', out.rates.length === 5 && out.rates.every(r => typeof r.value === 'number'));
  check('...articles that pass the gate, and not the recipe', out.articles.length >= 1 && !out.articles.some(a => /soup/.test(a.title)));
  check('...and stamps when it refreshed', out.refreshedAt === new Date(NOW).toISOString() && out.refreshFailed === false);
  check('the cache is on disk and no temp file is left behind', fs.existsSync(process.env.MARKET_NEWS_FILE) && fs.readdirSync(dir).every(f => !f.endsWith('.tmp')));
  check('current() serves the cached payload', mn.current().rates.length === 5);

  // one source down: its rate keeps yesterday's value, flagged stale
  const noSofr = (url) => /secured\/sofr/.test(url) ? Promise.reject(new Error('HTTP 500')) : good(url);
  out = await mn.refresh({ get: noSofr, now: NOW + 3600000 });
  const sofr = out.rates.find(r => r.key === 'sofr');
  check('one rate failing keeps its last value, marked stale', sofr && sofr.stale === true && sofr.value === 3.88);
  check('...the others are still fresh', out.rates.filter(r => !r.stale).length === 4 && out.partial === true);

  // one feed down: the rest still produce articles
  const noBisnow = (url) => /bisnow/.test(url) ? Promise.reject(new Error('HTTP 403')) : good(url);
  out = await mn.refresh({ get: noBisnow, now: NOW + 2 * 3600000 });
  check('one feed failing does not empty the list', out.articles.length >= 1);

  // everything down: the last good copy is served, flagged
  const before = mn.current();
  out = await mn.refresh({ get: () => Promise.reject(new Error('offline')), now: NOW + 3 * 3600000 });
  check('everything failing keeps the last good rates and articles', out.rates.length === 5 && out.articles.length === before.articles.length);
  check('...flagged so the page can say it is showing an older copy', out.refreshFailed === true && out.refreshedAt === before.refreshedAt);

  // schedule decisions on the saved state
  const okAt = Date.parse('2026-10-22T10:30:00Z');         // after 6:00 ET
  mn.save({ refreshedAt: new Date(okAt).toISOString(), rates: [], articles: [] });
  check('not due again the same morning', mn.isDue(Date.parse('2026-10-22T20:00:00Z')) === false);
  check('due once the next 6am ET has passed', mn.isDue(Date.parse('2026-10-23T10:05:00Z')) === true);
  check('not due at 5am ET the next day', mn.isDue(Date.parse('2026-10-23T09:00:00Z')) === false);
  mn.save({ refreshedAt: new Date(okAt).toISOString(), lastAttemptAt: new Date(Date.parse('2026-10-23T10:10:00Z')).toISOString(), refreshFailed: true, rates: [], articles: [] });
  check('after a failed attempt it waits an hour before trying again', mn.isDue(Date.parse('2026-10-23T10:40:00Z')) === false && mn.isDue(Date.parse('2026-10-23T11:20:00Z')) === true);
  fs.unlinkSync(process.env.MARKET_NEWS_FILE);
  check('no cache at all is due (first boot)', mn.isDue(NOW) === true);
  check('...and the route payload is a calm "pending", not an error', mn.current().pending === true && mn.current().articles.length === 0);
  fs.writeFileSync(process.env.MARKET_NEWS_FILE, '{not json');
  check('a corrupt cache file degrades to pending rather than throwing', mn.current().pending === true);

  // access: same need as Home
  const rule = accessControl.ruleFor('/api/market-news');
  check('the route needs the Home tool, nothing more', rule && JSON.stringify(rule.need) === '["overview"]');
  check('a person with Home may read it; one without may not',
    accessControl.decide({ tools: ['overview'] }, 'GET', '/api/market-news').ok && !accessControl.decide({ tools: ['budget'] }, 'GET', '/api/market-news').ok);

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll market-news checks passed');
  process.exit(failed ? 1 : 0);
})();
