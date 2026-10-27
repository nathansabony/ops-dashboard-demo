# Cedar Ridge Management - Demo

A property-management operations site, running entirely on **fictional data**. It shows what the
product does once it is connected to a Rent Manager account: portfolio grades, variance flagging,
delinquency and collections, budgeting, renovations, service requests, deal underwriting, a contract
scanner and an "Ask" assistant. Nothing here is real: the company ("Cedar Ridge"), the five Columbus, OH
buildings, the tenants, the staff and every figure are generated.

A small **Demo - all data is fictional** badge sits in the header and corner of every page.

## Run it

```bash
npm install
npm start            # http://localhost:3001   (PORT=5604 npm start to change the port)
```

That is all. `npm start` runs `scripts/demoServer.js`, which sets `DEMO_MODE=1`, blanks any Rent Manager
credentials in the environment or a `.env` file, and starts `server.js`. There is no sign-in: the visitor
is signed in automatically as an admin with every tool. `npm run dev` does the same with file watching.

### Deploying (Render, free plan)

`render.yaml` is a blueprint: in Render choose New > Blueprint, pick this repo, and set the
`DEMO_ACCESS_PIN` environment variable in the dashboard. Visitors then see a PIN page first
(a cookie remembers them for 30 days). Leave `DEMO_ACCESS_PIN` empty for a public demo. The free
plan sleeps when idle, so the first visit after a pause takes up to a minute.

Optional: set `ANTHROPIC_API_KEY` to let the Ask assistant and the contract scanner answer free-form
(see "Ask without a key" below). The Underwriting tab's PDF/Excel parsers use Python
(`python3 -m pip install openpyxl pymupdf formulas pandas xlrd`); without them that tab degrades but the rest
works.

## What is faked

| Piece | How |
|---|---|
| **Rent Manager** | `services/demo/` is a fake Rent Manager. `services/rentManagerClient.js` hands every call to it when `DEMO_MODE=1`, and it answers with the exact response shapes the real API returns (properties, units, tenants, leases, charges, GL reports, work orders...). The real pipelines (P&L snapshots, variance engine, delinquency, budget model) run unmodified on that data. |
| **The world** | `services/demo/world.js`: one entity, **Cedar Ridge**, five properties in Columbus, OH (The Alder, Maple Court, Willow Creek, Birchwood Commons, Summit Lofts), 56 units, about 50 current tenants, a handful delinquent. Generated from a fixed seed and anchored to today's date, so it always looks current. Four staff: Jordan Reyes (regional manager), Priya Natarajan (property manager), Sam Whitfield (maintenance supervisor), Dana Okoye (accounting). |
| **Accounts** | `services/userStore.js` keeps users in memory in demo mode, seeded with a demo admin and the four staff. The **Admin** tab works (tick tools per person, add or turn off people) but changes reset when the server restarts. |
| **Email** | `services/mailer.js` is a no-op in demo mode: invite and reset buttons succeed without sending anything. |
| **Market news** | Tries the real public feeds (Treasury, NY Fed, Freddie Mac, RSS); if offline, shows a built-in sample set of rates and headlines (clearly labelled "Sample"). |
| **Underwriting** | Runs on a fictional sample deal (Riverbend Apartments) when no API key is set. |
| **Ask assistant, contract scanner** | See below. |

### Ask without a key

With no `ANTHROPIC_API_KEY`, the Ask panel answers a handful of questions from the live fake data using
the same lookup tools Claude would use (`services/assistantTools.js`): *What is our occupancy? Who is
delinquent? Which property has the weakest DSCR? How is NOI doing? What are the open work orders? How much
have we collected?* Each answer ends with a note that a key enables free-form questions. The suggestion
chips are exactly those questions. The Scanner offers a **Try a sample contract** button that returns a
sample analysis of a fictional laundry lease. With a key, both call Claude for real.

## Plugging it into a real Rent Manager (the sellable version)

The demo and the real product are the same code. The only swap is the data source:

1. Run `node server.js` instead of `npm start` (so `DEMO_MODE` is not set).
2. Set `RENTMANAGER_COMPANY`, `RENTMANAGER_USERNAME` and `RENTMANAGER_PASSWORD` (see `.env.example` and `SETUP.md`).
3. `services/rentManagerClient.js` now authenticates against `https://{company}.api.rentmanager.com` and every
   route serves live data, cached in `data/` snapshots that the refresh buttons (and a weekly schedule) rebuild.
4. Turn on real accounts: set `DASHBOARD_ACCESS_PIN` once to create the first admin, then people sign in with
   their own email and password; the Admin tab chooses each person's tools. Configure `MAIL_FROM` and an SMTP or
   Microsoft 365 sender for invites and password resets.
5. Adjust `services/entityMap.js` (how properties group into entities), `config/` (merged buildings, property
   supers, deal scoring) and the budget assumptions to the customer.

## Tour of the tabs

- **Home**: market news and rates, the portfolio scorecard and health (four things going well, four going badly), the latest underwriting deal, the most urgent variances, and the Ask box.
- **Portfolio**: every entity graded 0-100 on occupancy, delinquency, NOI margin, expense ratio, DSCR and cash flow per unit; needs-attention and growth items with a next step; drill to properties and units.
- **Variances**: month-over-month and year-over-year flagging across every P&L line, ranked by an importance score, with the GL postings behind each flag, one-page PDF reports and a rules screen.
- **Underwriting**: drop an OM, T12 and rent roll; review what was read; build the Excel model and a PDF report; past deals with a 0-100 score.
- **Budgeting**: a 12-month budget built from trailing actuals with benchmark checks, overrides and budget-vs-actual.
- **Delinquency**: who owes what, collections by billing month, and a collections brief with a PDF.
- **Renovations**: non-operating spend by property, unit and vendor, with invoice backup.
- **Scanner**: a contract analyzer that pulls out terms, renewal deadlines and risks.
- **Service Requests**: open work orders, where they pile up and how long they have waited.
- **Admin**: people and the tools each may open.

The refresh buttons re-run the pulls against the fake Rent Manager, so they are harmless.

## Checks

```bash
npm run check:frontend   # every inline script parses; every API path the page calls exists
npm run check:demo       # demo mode end to end: auto sign-in, Admin, Ask, scanner, no-op mailer
```

The full list is in `.github/workflows/checks.yml` (each is also an `npm run check:*` script).

## Layout

```
server.js                 Express app: auth gate, every /api route
public/index.html         The whole front end (one page)
scripts/demoServer.js     Official demo boot (npm start)
services/demo/            The fake Rent Manager and the Cedar Ridge world
services/rentManagerClient.js   Swap point: fake in demo mode, real Rent Manager otherwise
services/assistant*.js    Ask assistant (Claude) and its keyless demo answers
underwriting/             Python parsers and the Excel model generator
budget/, config/, data/   Budget workbook tools, hand-kept config, runtime snapshots
```
