// Market news for the Home tab (2026-10-22, the owner): "what's going on in the
// market, relating to real estate" — the rates that price multifamily debt, and
// a handful of articles that bear on the portfolio (multifamily, CRE lending,
// rates, Columbus and central Ohio).
//
// ── WHERE IT COMES FROM ──────────────────────────────────────────────────────
// Free, keyless, and from the people who publish the number:
//   • 10-yr and 5-yr Treasury  → treasury.gov daily par yield curve (CSV)
//   • SOFR and Fed funds       → NY Fed reference-rate API (JSON)
//   • 30-yr mortgage           → Freddie Mac PMMS history (CSV, weekly)
//   • articles                 → RSS from trade press, the Fed, and Google News
//                                searches (which fan out across outlets)
// FRED would have been the obvious rate source but it times out from here, and
// these are the primary publishers FRED itself copies.
//
// ── WHAT IS STORED, AND WHAT IS NOT ──────────────────────────────────────────
// Headline, outlet, date, link, and at most one sentence of snippet the feed
// itself hands out. No page is ever fetched, so nothing paywalled is read or
// copied. Paywalled outlets (WSJ) are in the list for their headline only.
//
// ── THE DAILY ROTATION ───────────────────────────────────────────────────────
// Five articles show. The two strongest from the previous list stay (up to
// KEEP_DAYS) and the other three are replaced each morning, so the box moves but
// the stories that matter do not vanish overnight. Every candidate must pass
// the relevance score first; a slow news day shows fewer than five rather than
// filler.
//
// ── FAILURE ──────────────────────────────────────────────────────────────────
// The page must never show an empty box or take a 500. Each source fails on its
// own: a dead feed is skipped, a dead rate keeps yesterday's value (flagged
// stale), and if everything fails the last good file is served with
// `refreshFailed` set so the page can say "showing yesterday's". The cache is
// written to a temp file then renamed, so a crash mid-write cannot leave half a
// file on the persistent disk.

const fs = require('fs');
const path = require('path');

const DEMO = process.env.DEMO_MODE === '1';

const FILE = process.env.MARKET_NEWS_FILE || path.join(__dirname, '..', 'data', 'market-news.json');
const TZ = 'America/New_York';
const REFRESH_HOUR = Number(process.env.MARKET_NEWS_HOUR ?? 6);
const TICK_MS = 15 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;      // after a failed refresh, try again hourly
const FETCH_TIMEOUT_MS = 12000;
const SHOW = 5;
const KEEP = 2;                        // strongest from the last list that stay
const KEEP_DAYS = 5;                   // ...but not for longer than this
const MAX_AGE_DAYS = 7;                // candidates older than this are ignored
const MAX_PER_SOURCE = 2;
const MIN_RELEVANCE = 4;
const UA = 'Mozilla/5.0 (compatible; PortfolioDashboardDemo/1.0)';

const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:3d')}&hl=en-US&gl=US&ceid=US:en`;

// bonus: nudges an outlet up or down; official/trade sources get a point, broad
// ones none. Google News feeds name the real outlet in each item.
const FEEDS = [
  { id: 'bisnow', name: 'Bisnow', url: 'https://www.bisnow.com/rss', bonus: 1 },
  { id: 'connectcre', name: 'Connect CRE', url: 'https://www.connectcre.com/feed/', bonus: 1 },
  { id: 'commobs', name: 'Commercial Observer', url: 'https://commercialobserver.com/feed/', bonus: 1 },
  { id: 'housingwire', name: 'HousingWire', url: 'https://www.housingwire.com/feed/', bonus: 0 },
  { id: 'cnbc-re', name: 'CNBC', url: 'https://www.cnbc.com/id/10000115/device/rss/rss.html', bonus: 0 },
  { id: 'wsj-mkts', name: 'WSJ', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', bonus: 0 },
  { id: 'fed-fomc', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', bonus: 2 },
  { id: 'fed-speeches', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/speeches.xml', bonus: 0 },
  { id: 'gn-mf-rates', name: 'Google News', url: gnews('multifamily interest rates'), bonus: 0 },
  { id: 'gn-cre-lending', name: 'Google News', url: gnews('commercial real estate lending'), bonus: 0 },
  { id: 'gn-apartments', name: 'Google News', url: gnews('apartment market rents multifamily'), bonus: 0 },
  { id: 'gn-agency', name: 'Google News', url: gnews('Fannie Mae Freddie Mac multifamily'), bonus: 0 },
  { id: 'gn-fed', name: 'Google News', url: gnews('Federal Reserve rate decision mortgage rates'), bonus: 0 },
  { id: 'gn-local', name: 'Google News', url: gnews('Columbus Ohio multifamily apartments'), bonus: 0 },
  { id: 'gn-local2', name: 'Google News', url: gnews('central Ohio apartment market'), bonus: 0 },
];

// ── Relevance ────────────────────────────────────────────────────────────────
// [pattern, weight]. A hit in the headline counts double. "Topic" terms (A, B)
// are the gate: an article that mentions only "Miami" or "real estate" is not
// about our business and never qualifies on its own.
const TERMS = [
  [/multi-?family|apartment|rental housing|rent growth|renters?\b|cap rates?|\bcmbs\b|bridge loan|agency (loan|lend)|debt service|\bdscr\b|refinanc/i, 3, 'topic'],
  [/commercial real estate|\bcre\b|interest rates?|mortgage rates?|\bfed\b|federal reserve|\bfomc\b|rate (cut|hike)s?|treasury yield|\bsofr\b|10-year|inflation|lender|lending|fannie mae|freddie mac|\bhud\b/i, 2, 'topic'],
  [/ohio|columbus|cleveland|cincinnati|dayton|midwest/i, 1.5, 'place'],
  [/real estate|housing market|property (market|values?)|landlord/i, 1, 'place'],
];
const PENALTY = /celebrity|mansion|luxury home|homes? for sale|open house|horoscope|\bnfl\b|\bnba\b|stock picks?|crypto|bitcoin|how to (buy|sell) a home|first-time (home)?buyer/i;

function relevance(title, snippet) {
  const t = String(title || ''), s = String(snippet || '');
  let score = 0, topic = false;
  for (const [re, w, kind] of TERMS) {
    if (re.test(t)) { score += w * 2; if (kind === 'topic') topic = true; }
    else if (re.test(s)) { score += w; if (kind === 'topic') topic = true; }
  }
  if (PENALTY.test(t)) score -= 4;
  return topic ? score : 0;
}

// ── RSS / Atom parsing ───────────────────────────────────────────────────────
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');
}
function plain(s) {
  // Decode twice: feeds often carry entity-escaped HTML inside the description.
  return decode(decode(s)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}
function firstSentence(s, max = 200) {
  const t = plain(s);
  if (!t) return '';
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  const out = m ? m[1] : t;
  return out.length > max ? out.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : out;
}

// Returns [{ title, link, source, publishedAt (ISO), snippet }]. Anything that
// lacks a title, an http(s) link, or a parseable date is dropped.
function parseFeed(xml, feed) {
  const out = [];
  const blocks = String(xml || '').match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    let title = plain(tag(b, 'title'));
    let link = plain(tag(b, 'link'));
    if (!link) { const m = b.match(/<link[^>]*href=["']([^"']+)["']/i); if (m) link = decode(m[1]); }
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const when = new Date(plain(tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'published') || tag(b, 'updated')));
    if (isNaN(when)) continue;
    let source = plain(tag(b, 'source')) || feed.name;
    // Google News appends " - Outlet" to every title.
    if (/^gn-/.test(feed.id)) {
      const m = title.match(/^(.*\S)\s+-\s+([^-]{2,60})$/);
      if (m) { title = m[1]; if (!plain(tag(b, 'source'))) source = m[2]; }
    }
    let snippet = firstSentence(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded'));
    // Google News "descriptions" just repeat the headline; drop those.
    if (snippet && (snippet.toLowerCase().startsWith(title.toLowerCase().slice(0, 30)) || /^gn-/.test(feed.id))) snippet = '';
    out.push({ title, link, source, publishedAt: when.toISOString(), snippet });
  }
  return out;
}

const normTitle = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70);

// Choose what to show. `previous` is the last list (with its scores); `now` is
// injectable so the check can run on a fixed clock.
function selectArticles(candidates, previous, now = Date.now()) {
  const cutoff = now - MAX_AGE_DAYS * 86400000;
  const seen = new Set();
  const pool = [];
  for (const c of candidates) {
    const at = Date.parse(c.publishedAt);
    if (!(at >= cutoff) || at > now + 3600000) continue;
    const rel = relevance(c.title, c.snippet) + (c.bonus || 0);
    if (rel < MIN_RELEVANCE) continue;
    const key = normTitle(c.title);
    if (seen.has(key)) continue;
    seen.add(key);
    const ageDays = (now - at) / 86400000;
    pool.push({ ...c, relevance: rel, score: rel + Math.max(0, 2 - ageDays * 0.5) });
  }
  pool.sort((a, b) => b.score - a.score);

  const perSource = {};
  const chosen = [];
  const take = (a) => {
    if ((perSource[a.source] || 0) >= MAX_PER_SOURCE) return false;
    perSource[a.source] = (perSource[a.source] || 0) + 1;
    chosen.push(a);
    return true;
  };

  // The strongest of yesterday's stay, if they are still within KEEP_DAYS and
  // were seen again today (a story that dropped out of every feed has gone).
  const byKey = new Map(pool.map(p => [normTitle(p.title), p]));
  const prevSorted = (previous || []).slice().sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
  const prevKeys = new Set(prevSorted.map(p => normTitle(p.title)));
  let kept = 0;
  for (const p of prevSorted) {
    if (kept >= KEEP) break;
    const fresh = byKey.get(normTitle(p.title));
    const age = (now - Date.parse(p.publishedAt)) / 86400000;
    if (!fresh || age > KEEP_DAYS) continue;
    if (take(fresh)) kept += 1;
  }
  // Then the best that were not on yesterday's list; only if still short, repeat.
  for (const a of pool) {
    if (chosen.length >= SHOW) break;
    if (chosen.includes(a) || prevKeys.has(normTitle(a.title)) || byKey.get(normTitle(a.title)) !== a) continue;
    take(a);
  }
  for (const a of pool) {
    if (chosen.length >= SHOW) break;
    if (!chosen.includes(a)) take(a);
  }
  return chosen.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .map(({ title, link, source, publishedAt, snippet, relevance: r }) => ({ title, link, source, publishedAt, snippet, relevance: r }));
}

// ── Rates ────────────────────────────────────────────────────────────────────
// Each fetcher returns observations [{ date: 'YYYY-MM-DD', value }] (any order).
function usDate(s) {                      // 10/21/2026 → 2026-10-21
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}
function parseTreasuryCsv(text, column) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  const idx = head.indexOf(column);
  if (idx < 0) return [];
  const out = [];
  for (const l of lines.slice(1)) {
    const cells = l.split(',').map(c => c.replace(/"/g, '').trim());
    const date = usDate(cells[0]), value = parseFloat(cells[idx]);
    if (date && isFinite(value)) out.push({ date, value });
  }
  return out;
}
function parseNyFed(json) {
  const rows = (json && json.refRates) || [];
  return rows.map(r => ({ date: r.effectiveDate, value: Number(r.percentRate) }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && isFinite(r.value));
}
function parsePmms(text) {
  const out = [];
  for (const l of String(text || '').split(/\r?\n/).slice(1)) {
    const c = l.split(',');
    const date = usDate(c[0]), value = parseFloat(c[1]);
    if (date && isFinite(value)) out.push({ date, value });
  }
  return out.filter(o => o.date >= '2020-01-01');
}

const RATES = [
  { key: 'ust10', label: '10-Yr Treasury', note: 'Benchmark for fixed-rate multifamily loans', source: 'U.S. Treasury',
    get: async (f, y) => parseTreasuryCsv(await treasuryText(f, y), '10 Yr') },
  { key: 'ust5', label: '5-Yr Treasury', note: 'Prices many agency and bank loans', source: 'U.S. Treasury',
    get: async (f, y) => parseTreasuryCsv(await treasuryText(f, y), '5 Yr') },
  { key: 'sofr', label: 'SOFR', note: 'What floating-rate loans reset on', source: 'NY Fed',
    get: async (f) => parseNyFed(JSON.parse(await f('https://markets.newyorkfed.org/api/rates/secured/sofr/last/45.json'))) },
  { key: 'effr', label: 'Fed Funds', note: 'Effective rate, set by the FOMC', source: 'NY Fed',
    get: async (f) => parseNyFed(JSON.parse(await f('https://markets.newyorkfed.org/api/rates/unsecured/effr/last/45.json'))) },
  { key: 'mort30', label: '30-Yr Mortgage', note: 'Freddie Mac weekly survey', source: 'Freddie Mac',
    get: async (f) => parsePmms(await f('https://www.freddiemac.com/pmms/docs/PMMS_history.csv')) },
];
async function treasuryText(f, year) {
  const u = (yr) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yr}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${yr}&page&_format=csv`;
  let text = await f(u(year));
  // Early in January there is not a month of rows yet; add last year's.
  if (text.split(/\r?\n/).length < 45) { try { text += '\n' + (await f(u(year - 1))).split(/\r?\n/).slice(1).join('\n'); } catch { /* current year alone is fine */ } }
  return text;
}

// value, as-of date, and the change vs. the last observation on or before 7 / 30
// days earlier (percentage points).
function summarizeRate(def, obs) {
  const rows = obs.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const at = (days) => {
    const t = Date.parse(last.date + 'T00:00:00Z') - days * 86400000;
    let hit = null;
    for (const r of rows) { if (Date.parse(r.date + 'T00:00:00Z') <= t) hit = r; else break; }
    return hit;
  };
  const w = at(7), m = at(30);
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    key: def.key, label: def.label, note: def.note, source: def.source,
    value: last.value, asOf: last.date,
    chgWeek: w ? r2(last.value - w.value) : null,
    chgMonth: m ? r2(last.value - m.value) : null,
  };
}

// ── Time zone ────────────────────────────────────────────────────────────────
function etParts(epoch) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(epoch))) p[x.type] = x.value;
  return p;
}
function etWallToEpoch(y, mo, d, h) {
  let guess = Date.UTC(y, mo - 1, d, h, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = etParts(guess);
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, 0);
    guess += Date.UTC(y, mo - 1, d, h, 0, 0) - shown;
  }
  return guess;
}
// The most recent 6am Eastern at or before `now`.
function lastDueEpoch(now = Date.now()) {
  for (let back = 0; back <= 2; back++) {
    const p = etParts(now - back * 86400000);
    const e = etWallToEpoch(+p.year, +p.month, +p.day, REFRESH_HOUR);
    if (e <= now) return e;
  }
  return now;
}

// ── Cache ────────────────────────────────────────────────────────────────────
function load() {
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!o || typeof o !== 'object') return null;
    return { ...o, rates: Array.isArray(o.rates) ? o.rates : [], articles: Array.isArray(o.articles) ? o.articles : [] };
  } catch { return null; }
}
function save(payload) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, FILE);
}

async function httpGet(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, text/csv, application/json, */*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

// One refresh. `get` is injectable (the check script feeds canned XML). Never
// throws: returns the payload that was saved. If NOTHING could be fetched the
// previous good payload is kept and marked refreshFailed.
async function refresh(opts = {}) {
  const get = opts.get || httpGet;
  const now = opts.now || Date.now();
  const prev = load();
  const failed = [];

  const rates = [];
  await Promise.all(RATES.map(async (def, i) => {
    try {
      const s = summarizeRate(def, await def.get(get, +etParts(now).year));
      if (!s) throw new Error('no observations');
      rates[i] = s;
    } catch (err) {
      failed.push(`${def.key}: ${err.message}`);
      const old = prev && prev.rates.find(r => r.key === def.key);
      if (old) rates[i] = { ...old, stale: true };
    }
  }));

  const candidates = [];
  let feedsOk = 0;
  await Promise.all(FEEDS.map(async (feed) => {
    try {
      const items = parseFeed(await get(feed.url), feed);
      feedsOk += 1;
      for (const it of items) candidates.push({ ...it, bonus: feed.bonus });
    } catch (err) { failed.push(`${feed.id}: ${err.message}`); }
  }));

  const gotRates = rates.filter(r => r && !r.stale).length;
  if (!gotRates && !feedsOk) {
    const kept = prev || { rates: [], articles: [] };
    const out = { ...kept, refreshFailed: true, lastAttemptAt: new Date(now).toISOString(), failed: failed.slice(0, 20) };
    try { save(out); } catch { /* disk trouble must not become an outage */ }
    return out;
  }

  // Feeds that all failed keep yesterday's articles rather than clearing the box.
  let articles = feedsOk ? selectArticles(candidates, prev && prev.articles, now) : (prev ? prev.articles : []);
  if (feedsOk && !articles.length && prev && prev.articles.length) articles = prev.articles;
  const out = {
    refreshedAt: new Date(now).toISOString(),
    lastAttemptAt: new Date(now).toISOString(),
    refreshFailed: false,
    partial: failed.length > 0,
    rates: rates.filter(Boolean),
    articles,
    sources: { feedsOk, feedsTotal: FEEDS.length },
    failed: failed.slice(0, 20),
  };
  try { save(out); } catch (err) { console.warn('market news: cache write failed:', err.message); }
  return out;
}

// DEMO_MODE only: a built-in set of plausible sample rates and headlines, used when the
// live feeds cannot be reached (no internet, a locked-down host). Dates are relative to
// "now" so the box always looks current; every item says it is sample content and links
// to a placeholder, never to a real story.
function sampleSnapshot(now = Date.now()) {
  const day = 86400000;
  const iso = (d) => new Date(now - d * day).toISOString();
  const ymd = (d) => iso(d).slice(0, 10);
  const rate = (key, label, note, source, value, w, m, ageDays) => ({
    key, label, note, source, value, asOf: ymd(ageDays), chgWeek: w, chgMonth: m,
  });
  const art = (title, source, ageDays, snippet, relevance) => ({
    title, link: 'https://example.com/sample-headline', source, publishedAt: iso(ageDays), snippet, relevance,
  });
  return {
    sample: true,
    refreshedAt: iso(0), lastAttemptAt: iso(0), refreshFailed: false, partial: true,
    rates: [
      rate('ust10', '10-Yr Treasury', 'Benchmark for fixed-rate multifamily loans', 'U.S. Treasury', 4.18, -0.06, -0.14, 1),
      rate('ust5', '5-Yr Treasury', 'Prices many agency and bank loans', 'U.S. Treasury', 3.84, -0.05, -0.12, 1),
      rate('sofr', 'SOFR', 'What floating-rate loans reset on', 'NY Fed', 4.05, 0, -0.1, 1),
      rate('effr', 'Fed Funds', 'Effective rate, set by the FOMC', 'NY Fed', 4.08, 0, -0.08, 1),
      rate('mort30', '30-Yr Mortgage', 'Freddie Mac weekly survey', 'Freddie Mac', 6.21, -0.03, -0.17, 4),
    ],
    articles: [
      art('Multifamily lenders widen spreads as agency volume slows into year-end', 'Sample Multifamily Weekly', 1, 'Sample headline: refinancing activity cools while borrowers wait for lower rates.', 9),
      art('Central Ohio apartment rents hold steady as new supply levels off', 'Sample Columbus Business Review', 2, 'Sample headline: occupancy in the metro stays near 94 percent.', 8),
      art('Fed officials signal patience on rate cuts as inflation cools unevenly', 'Sample Markets Desk', 2, 'Sample headline: what a slower path means for floating-rate multifamily debt.', 8),
      art('Bridge-loan maturities push owners toward agency refinancing', 'Sample CRE Daily', 4, 'Sample headline: lenders report more value-add owners seeking fixed-rate takeouts.', 7),
      art('Midwest workforce housing draws institutional buyers again', 'Sample Housing Wire', 5, 'Sample headline: cap rates for older Class B product firm up in secondary markets.', 6),
    ],
    sources: { feedsOk: 0, feedsTotal: FEEDS.length, sample: true },
    failed: [],
  };
}

// What the route returns: never throws, never empty-handed once any refresh has
// ever succeeded. In DEMO_MODE the built-in sample fills whatever the live pull
// could not (the whole box when the host is offline).
function current() {
  const c = load();
  if (DEMO) {
    const sample = sampleSnapshot();
    if (!c || (!c.rates.length && !c.articles.length)) return sample;
    return { ...c, rates: c.rates.length ? c.rates : sample.rates, articles: c.articles.length ? c.articles : sample.articles,
      sample: !c.rates.length || !c.articles.length ? true : undefined, pending: undefined };
  }
  if (c) return c;
  return { pending: true, rates: [], articles: [] };
}

// Due when we have never refreshed, or the last good refresh is before the most
// recent 6am ET. After a failure, no more than one attempt an hour.
function isDue(now = Date.now()) {
  const c = load();
  if (!c || !c.refreshedAt) {
    return !(c && c.lastAttemptAt && now - Date.parse(c.lastAttemptAt) < RETRY_MS);
  }
  if (Date.parse(c.refreshedAt) >= lastDueEpoch(now)) return false;
  return !(c.lastAttemptAt && c.refreshFailed && now - Date.parse(c.lastAttemptAt) < RETRY_MS);
}

let _running = null;
function refreshIfDue(reason) {
  if (_running || !isDue()) return _running;
  console.log(`Market news refresh (${reason})…`);
  _running = refresh().then(r => {
    console.log(r.refreshFailed ? 'Market news refresh failed — keeping the last good copy.' : `Market news refreshed: ${r.rates.length} rates, ${r.articles.length} articles.`);
    return r;
  }).catch(err => console.warn('Market news refresh error:', err.message))
    .finally(() => { _running = null; });
  return _running;
}

// Boot: fill an empty cache now, then check every 15 minutes whether 6am ET has
// passed since the last good pull (the same self-healing shape as the P&L
// schedule: a sleeping instance catches up when it wakes). unref so tests exit.
function start() {
  refreshIfDue('startup');
  const t = setInterval(() => refreshIfDue('tick'), TICK_MS);
  if (t.unref) t.unref();
}

module.exports = {
  FILE, FEEDS, RATES, SHOW,
  parseFeed, relevance, selectArticles, parseTreasuryCsv, parseNyFed, parsePmms, summarizeRate,
  lastDueEpoch, load, save, refresh, current, sampleSnapshot, isDue, refreshIfDue, start,
};
