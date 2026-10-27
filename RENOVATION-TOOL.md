# Renovations tab — Non-Operating (Renovation) Expense Detail

*Built August 2026. Replaces a manual Rent Manager walkthrough with one page.*

---

## What it replaces

Today, when ownership asks what the renovation money bought, someone logs into
Rent Manager and does this, per property:

1. Open the property's **unit-level P&L**
2. Drill into the **non-operating expense categories** (renovation charges only —
   never the operating 5xxx lines)
3. Click a category to see the **individual charges** inside it
4. Open a charge to get its **backup**: the attached invoice, the payment record,
   and — when it was paid on a company card — the **credit card statement charge**

Four levels of clicking per invoice, repeated per unit, per property, every time.

The **Renovations** tab is that same hierarchy, for the whole portfolio, already
pulled: property → unit → category → charge, each level clickable, with the backup
one click further.

---

## Where the numbers come from

| | |
|---|---|
| **Report** | Rent Manager Report **51 "GeneralLedger"**, `IsSummary=False` — one row per posting |
| **Basis** | **Accrual** (`Basis=2`) — which is what makes *"include accrued charges, not just paid ones"* true. A bill entered but unpaid is already in the accrual GL. |
| **GL scope** | Reference **6100** (`Total REN - Capital Expense`) and its children (`6100-1`, `6100-2`, …). Operating expenses (5xxx) are excluded entirely; so is mortgage interest (6230). |
| **Window** | A rolling 24 months, ending with the current (in-progress) month |
| **Cost** | One report run **per property that actually booked renovation spend** in the window |

### Why only some properties get a report run

The monthly P&L snapshot (`services/propertyFinancials.js`) already carries
`renCapital` per property per month. So before spending a single API call we
already know *which* properties had renovation spend — and pull only those. On a
portfolio where renovations are concentrated in a handful of buildings, that is a
handful of runs instead of ~89.

It also buys a free correctness check: the postings pulled for a property **must**
sum to the same figure the P&L reports for it. Where they don't, the tab says so
(see *Cross-check* below) rather than letting a number reach an owner unverified.

If the P&L snapshot has not been built yet there is no shortlist, so the pull falls
back to one portfolio-wide report run with postings attributed to properties by
Rent Manager short name. That is degraded — and the tab says so on screen.

---

## Data freshness

Same contract as every other tab on this site: **the page makes no Rent Manager
call on load.** It serves the last snapshot until someone presses ⟳ Refresh (or the
weekly Monday-4am schedule fires). The date-range selector slices the cached window
in the browser and costs nothing.

The refresh source key is `renovations` (`REFRESH_SOURCES` in `server.js`). It is
deliberately **not** in the global set — only its own tab reads it. Refresh the
Monthly P&L first (Overview or Variances) when you want the shortlist to be current.

**The one live call** is pressing **📎 Backup** on a single charge. That is a
deliberate click, not a page load — the same design as the Variance tab's GL
drill-down. Pre-pulling a document for every charge would be thousands of calls for
the handful anyone opens. Results cache for five minutes.

---


## What the tab tells you before a number leaves the screen

Each notice renders only when it has something to say:

* **Cross-check vs the monthly P&L** — per property, to the dollar. Green when
  everything ties; amber listing each property that doesn't, with the gap.
* **Inferred units** — Rent Manager does not always name a unit on a GL posting. When
  it doesn't, the unit is matched out of the charge description against the
  property's own unit list and badged **`inferred`** (vs **`from RM`**). A guessed
  unit reads as a guess.
* **Unattributed charges** — postings that could not be matched to a property.
* **Failed property pulls** — a property whose report run errored, so the totals are
  transparently short rather than quietly wrong.
* **Degraded attribution** — the portfolio-wide fallback mode described above.

---


## Verifying it

```bash
# Offline — no credentials needed. Runs the whole pipeline against fixtures:
# GL resolution, unit attribution, the per-property vs portfolio-wide decision,
# the P&L cross-check, error handling, id stability. Runs in CI on every push.
npm run check:renovations

# Offline — the invoice lookup itself: split invoices, match ranking, the date
# window, that a refused request is reported as a refusal, and that a payment
# names the bank account it was drawn on (last four only).
npm run check:bill-match

# Offline — the two-page payment record: the invoice is copied not redrawn, a bad
# scan cannot take the packet down, and page 1 names the bank account.
npm run check:charge-packet

# Offline — the attachment probe's verdict logic, against a fake Rent Manager
# (both endings: no document store, and a store that returns a PDF).
npm run check:attachments

# Offline — the API inventory report cannot call a resource unused when a
# service reads it, and cannot let a row value out.
npm run check:rm-inventory

# Live — needs .env. THE question: can this API hand us the invoice PDF at all?
# Read-only; prints a support-ready block of every request and every answer.
npm run probe:attachments

# Live — needs .env. Answers both open items above against the real API and
# walks one real charge all the way to its backup document. Read-only.
node scripts/the pull [FROM] [TO]
```

---

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `RENOVATION_GL_REFS` | `6100,5150` | Comma-separated GL reference roots counted as renovation / major spend. Children (`<ref>-N`) and anything RM links beneath them are included automatically. |
| `RENOVATION_EXCLUDE_GL_REFS` | `5031` | References that must never appear, however they were matched (name and hierarchy matching can reach accounts the roots never named). `5031` is Exterminating, excluded by the client. |
| `RENOVATION_WINDOW_MONTHS` | `24` | How far back the snapshot reaches. The date-range selector slices inside this. |

---

## Files

| File | Role |
|---|---|
| `services/renovationExpenses.js` | GL account resolution, the report-51 pull, property/unit/category/charge grouping, the P&L cross-check, the snapshot cache |
| `services/rmDocuments.js` | Level four: capability probe, bill match, bill-worksheet cross-check, attachments, payment, credit card statement charge, manual-lookup fallback |
| `services/attachmentProbe.js` | The "can this API hand over the invoice PDF?" probe behind the button on the tab and `scripts/probeAttachments.js` |
| `server.js` | `/api/renovations`, `/api/renovations/backup`, `/api/renovations/capabilities`, and the `renovations` refresh source |
| `public/index.html` | The tab: filters, summary tiles, notices, the four-level board, the backup panel, CSV export, the owner packet |
| `scripts/checkRenovationBuild.js` | Offline pipeline check (CI) |
| `scripts/the pull` | Live API verification (needs credentials) |

---

## Sending it to ownership

**🖨 Owner packet** renders the currently filtered data as a printable statement in
a new tab — one section per property, charges grouped by unit, every line carrying
its date, GL category, vendor, description and invoice number so any figure can be
traced back to a Rent Manager posting. It states the source, the basis, when the
data was pulled, whether it ties to the monthly P&L, and flags any unit that was
inferred rather than reported. Print → Save as PDF.

Built as its own document rather than a print stylesheet on the tab: the tab is an
interactive drill-down with collapsed sections, so printing it would capture
whatever happened to be expanded. The packet is always complete.

**⤓ CSV** exports the same filtered rows for anyone who wants the numbers in Excel.

---

## When the board comes back empty

An empty board prints the counts showing where the pull stopped — GL accounts
matched, properties in the entity map, properties shortlisted from the P&L, report
runs made, rows returned, real postings kept — rather than a bare "no charges".
"No renovation spend" and "the GL reference is wrong for this Rent Manager" must
never look the same in front of an owner.

If the filters are narrow but the snapshot does hold charges, it says that instead
and points at the Full window button.

---

## Known limits

* **Unit attribution depends on what Rent Manager puts on the posting.** If report
  51 carries no unit field on this instance, units come from the description and are
  badged `inferred`. The bill worksheet (`/BillDetails`) carries a unit per
  distribution line and is used when a bill is found — the pull
  section 2 tells you which situation you are in.
* **A charge with no matching AP bill** (a journal entry, a period adjustment) has no
  invoice to attach. The tab says that rather than showing an empty panel.
* **Attachment bytes** are served through the site, not linked directly. If this
  Rent Manager build has no download route at all, the link is replaced by the
  manual-lookup block rather than a broken download.
* **The snapshot is a rolling 24 months.** A question about older spend needs
  `RENOVATION_WINDOW_MONTHS` raised and a refresh.
