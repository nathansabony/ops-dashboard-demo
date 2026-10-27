# Connecting a live Rent Manager (Setup Notes)

> The demo (`npm start`) never needs any of this: it runs on a fictional Rent Manager built into `services/demo`. These notes are for the sellable version, where `services/rentManagerClient.js` talks to a real Rent Manager instead (run `node server.js` without `DEMO_MODE`).

## 1. Requesting API access

Rent Manager's API ("WAPI12") isn't self-serve from a developer portal — access is granted per-company through Rent Manager directly. Steps:

1. Contact your Rent Manager account rep or support and ask to enable **API access** for your company database. Mention you want **read access** to start (Tenants, Properties, Units, Service Manager Issues / work orders, and reporting data) — you can request write access later if the management site ever needs to push data back.
2. Ask them to set up a **dedicated API user** rather than using a personal login. This lets you scope permissions narrowly (so the API account can only see what the management site needs) and means the integration doesn't break if a staff member's password changes.
3. Once provisioned, Rent Manager (or your admin) manages the integration from the **"My Integrations"** tab inside Rent Manager Online — this is where you can review which permissions the API user has and get support if something stops working.
4. You'll end up with: a company/subdomain identifier, an API username, and an API password. There is also a published **Rent Manager 12 Web API Technical Documentation PDF** with the full resource list — worth requesting the latest copy from your rep since resources/fields can change.

## 2. How authentication works (for reference once you have credentials)

- `POST https://{company}.api.rentmanager.com/Authentication/AuthorizeUser` with `{ "Username": ..., "Password": ... }` → returns an `APIToken` string.
- Every other request sends that token in an `X-RM12Api-ApiToken` header.
- Tokens are invalidated if the API user's password or permissions change — `services/rentManagerClient.js` already handles re-authenticating automatically on a 401.
- Standard REST verbs: `GET` (read), `POST` (create/update), `DELETE`. Collection endpoints (e.g. `/Tenants`) support `fields`, `embed`, `filters`, `pagenumber`/`pagesize`, and `orderby` query params.
- The API is rate-limited per company (hourly), with `X-RateLimit` / `X-RateRemaining` / `X-RateTimeLeft` response headers to track it.

## 3. What to do the moment you get credentials

1. Copy `.env.example` to `.env` and fill in `RENTMANAGER_COMPANY`, `RENTMANAGER_USERNAME`, `RENTMANAGER_PASSWORD`.
2. Set `DASHBOARD_ACCESS_PIN` before hosting anywhere outside your machine. Tenant search, tenant profiles, and tenant-level delinquency routes require this PIN when it is present. For production, put the app behind your own SSO as well.
3. Optionally set `DASHBOARD_SESSION_SECRET` to a long random value so the tenant-data session cookie is signed with a secret separate from the PIN.
4. Run `npm install` then `npm start` in this folder — `/api/status` will report `"mode": "live"` once it can authenticate.
5. The static management site no longer carries `TENANTS` or `FULL_DELINQUENCY` records. Tenant search, tenant profiles, and tenant-level delinquency now flow through same-origin `/api/...` routes so Rent Manager credentials and tenant records stay server-side until requested.

Troubleshooting: if live tenant routes return `User is already logged in maximum number of times`, Rent Manager is rejecting a new API session for that username. Sign out other sessions for the API user, use a dedicated API-only user, or wait for Rent Manager to expire older sessions before retesting.

## 4. Rent Manager reports/forms worth pulling in for more depth

Rent Manager ships 450+ predefined reports. Beyond what the management site already covers (Trial Balance, Rent Roll, Delinquency, Vacancy, P&L), these would add real depth:

- **Balance Sheet** and **General Ledger** — full financial-statement depth beyond P&L, useful for a "financials" drill-down per entity.
- **Budget vs. Actual** — Rent Manager has dedicated budgeting reports; pairing with the existing NOI charts would show plan vs. performance, not just current state.
- **Prospect Box Score** — leasing funnel data (leads, follow-ups, conversion) if leadership wants leasing-pipeline visibility alongside occupancy.
- **Audit Trail** — useful internally for tracking who changed financial records, less relevant to the exec-facing management site but worth knowing it exists.
- **1099 / Tax Forms** — could feed an "owner distributions" or compliance tab if that becomes a priority.
- **Renewal/Notice tracking** (from Leasing & Resident Management module) — leases expiring in the next 60–90 days, a natural addition next to Vacancy.
- **Owner Statements / Distributions** — if leadership includes property owners or investors, this closes the loop from NOI to actual payout.
- **Utility Billing / Meter Reads** — if utilities are a meaningful cost center across the portfolio, worth tracking against budget.

These map to Rent Manager's documented module groupings (Portfolio & Unit Management, Leasing & Resident Management, Accounting & Payments, Maintenance, Owner & Vendor Management) — useful framing when asking your rep which reports/resources are included in your specific license.

## Sources

- [Rent Manager 12 Web API Technical Documentation (PDF)](https://info.rentmanager.com/hubfs/PDFs/Technical%20Documentation.pdf)
- [Rent Manager Reporting overview](https://www.rentmanager.com/reporting/)
- [Rent Manager API Partner Periodical](https://www.rentmanager.com/api-partner-periodical/)


## Accounts and tool access (2026-10-07)

Everyone signs in with their **own email and password**. An admin decides which
tools (tabs) each person can open on the **Admin** tab. The server enforces it:
a person without a tool is refused that tool's data even if they type the address
(`services/accessControl.js`); the tabs they lack are simply not drawn.

**People sign themselves up.** The sign-in page has *"New here? Create an account"*:
name, email and a password they choose — that is their real password. A new account
has **no tools** and only sees a "waiting for access" page (not the site) until an
admin ticks tools for it on the **Admin** tab, where new sign-ups are listed first.
Optional: `SIGNUP_ALLOWED_DOMAINS=cedarridge.example` limits sign-ups to work addresses.
Anyone can type any address, so until email is set up (which sends a "confirm your
email" link and shows ✓ in Admin), check with the person before giving them access.

**First admin:** sign up yourself, then sign in with the site PIN (*"First-time setup:
use the site PIN"*), open **Admin** and tick **Admin** on your account. The moment an
admin exists the PIN stops working.

**Day to day (Admin tab):** **+ Add a person** creates an account directly (name, email, a starting password — or an emailed invite once email is set up — and their tools ticked up front), tick/untick tools (applies on their next click), make
someone an admin, **Reset password** for anyone (email them a reset link, or type a
new password for them — hidden as you type), turn an account off, or delete it.
There is always at least one admin. On the sign-in page everyone has *"Forgot your
password?"* (emails a link once email is set up; until then it says to ask an admin).

**Password reset by email.** Once email is set up (below), the sign-in screen gets a
*"Forgot your password?"* link, the Admin tab gets *"Email a reset link"*, and new
people can be **invited by email** to set their own password instead of being handed a
temporary one. Links work once and expire (reset 1 hour, invite 72 hours); only a
hash of each link is stored; links always use `DASHBOARD_PUBLIC_URL`. Until email is
set up, admins set temporary passwords as above.

To turn email on, set in the host **one** of:
- *Microsoft 365* (send as e.g. `noreply@cedarridge.example`): register an app in
  Microsoft Entra with the **Mail.Send** application permission (admin consent), then
  `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET`, `MAIL_FROM`.
- *Any SMTP provider* (Resend, Postmark, SendGrid, M365 SMTP): `SMTP_HOST`,
  `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.

plus `DASHBOARD_PUBLIC_URL` (the site's address, e.g. `https://management.example.com`).

*Free option, no IT needed — Brevo* (free plan: 300 emails/day): sign up, add and
verify a sender address (Brevo emails it a confirmation link), then copy the values
from **SMTP & API → SMTP**: `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`,
`SMTP_USER` = the login shown there, `SMTP_PASS` = the SMTP key, `MAIL_FROM` = the
verified sender. If messages land in spam or bounce, the domain would need Brevo's
SPF/DKIM records — or use a dedicated Gmail account (App Password, `smtp.gmail.com`,
port 587) as the sender instead.

The Admin tab shows whether email is on and what is missing.

**Where it lives:** `data/users.json` on the host disk (git-ignored). Passwords are
salted scrypt hashes. Set `DASHBOARD_SESSION_SECRET` in the host to a long random
value so sessions do not depend on the PIN. `npm run check:access` proves the whole
flow without Rent Manager.

**Known gap:** the page still carries the older built-in portfolio summary figures
(2024–mid 2026) that Overview falls back on, visible in the page source to any
signed-in person. Live data — including all tenant-level data — is guarded per tool.
