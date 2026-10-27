// ── One PDF holding both halves of a charge ─────────────────────────────────
//
// The owner, 2026-09-02: *"maybe have a PDF with both. Show the bill itself … and
// then under it, write the receipt, or make it a two page PDF to just show both
// the bill and who paid it, and have that as a little attached PDF."*
//
// Page 1 is a payment record generated from what Rent Manager holds: the charge,
// the bill it belongs to, the check or card that settled it, and whether that
// payment cleared the bank. Pages 2+ are the vendor's own invoice, appended
// unchanged.
//
// Two rules this will not break:
//
//   * The invoice is never redrawn. It is the vendor's document and it is copied
//     page-for-page, so what comes out is the paper they sent, not our rendering
//     of it. A scan we re-typeset is a document we have quietly authored.
//   * Page 1 says on its face that it was produced by this site from Rent Manager
//     records. It is a summary of what the system holds, and it must never be
//     mistakable for a receipt issued by anybody.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const INK = rgb(0.078, 0.204, 0.165);
const BODY = rgb(0.243, 0.227, 0.200);
const MUTED = rgb(0.490, 0.463, 0.416);
const RULE = rgb(0.871, 0.851, 0.804);
const GOOD = rgb(0.078, 0.396, 0.231);

const PAGE_W = 612, PAGE_H = 792, M = 54;

const usd = (n) => {
  const v = Number(n) || 0;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
// pdf-lib's StandardFonts are WinAnsi: a curly quote or an em dash out of a
// vendor name throws while encoding, which would fail the whole packet over a
// punctuation mark.
const safe = (v) => String(v == null ? '' : v)
  .replace(/[‘’‛]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/[^\x20-\x7E]/g, ' ')
  .trim();

/**
 * The "who paid it" block, as data rather than as draw calls.
 *
 * Sarah, 2026-09-03: the record said *"cleared by bank, method: check"* and did
 * not say which account, so there was nothing to look the check up with. The bank
 * account — its name and the last four digits — is now a row of its own, sitting
 * with the clearance line it qualifies.
 *
 * It is a function so the rows can be asserted in a check. Text drawn straight
 * into a PDF cannot be read back out of one, so a row silently going missing is
 * exactly the kind of regression that ships.
 */
function whoPaidRows(backup) {
  const pay = backup && backup.payment;
  const cc = backup && backup.creditCard && backup.creditCard.charge;
  const rows = [];
  const add = (label, value, opts = {}) => {
    if (value == null || value === '') return;
    rows.push({ label, value: String(value), ...opts });
  };

  if (pay) {
    add(String(pay.method) === 'Check' ? 'Check number' : 'Reference', pay.reference);
    add('Paid on', pay.paidOn);
    add('Payee', pay.payee);
    add('Payment total', usd(pay.amount));
    if (pay.appliedToChargeLine != null) {
      add('Applied to this charge', usd(pay.appliedToChargeLine), { strong: true });
    }
    add('Method', pay.method);
    // Which account the money left from. Only ever the last four digits — this
    // file gets emailed, and four digits is what a bank's search box takes.
    add('Bank account', pay.bank ? pay.bank.label : pay.account);
    // The strongest evidence this API offers, and the reason a check needs no
    // scan: the bank statement has been matched against it.
    add('Bank reconciliation', pay.reconciled ? 'Cleared the bank' : 'Not yet reconciled',
      pay.reconciled ? { strong: true, good: true } : {});
    return rows;
  }
  if (cc && cc.found) {
    add('Paid by', 'Company credit card');
    add('Card', cc.card);
    add('Charged', cc.date);
    add('Amount', usd(cc.amount));
    add('Memo', cc.comment);
    add('Receipt attached', cc.receipts && cc.receipts.length ? 'Yes — appended' : 'No receipt is attached in Rent Manager');
    return rows;
  }
  add('Status', 'No check or card transaction is applied to this charge in Rent Manager.');
  return rows;
}

/**
 * The "the bill" block, as data.
 *
 * The owner, 2026-09-10: *"Any extra information that can go with any of these
 * bills, just add it in."* A bill record was carrying rather a lot that never
 * reached the page — and one field answered a question asked separately in the
 * same conversation: the approval is on the bill (IsApproved / ApprovalUserID /
 * ApprovalDate), so "who approved this spend" needed no purchase order at all.
 *
 * Named rows first, then whatever else the record holds, so nothing is silently
 * dropped. Page 1 is a fixed height, so the caller stops drawing when it runs out
 * of room and says how many rows it could not fit — a page that quietly loses the
 * last four facts is worse than one that admits it.
 */
function billRows(backup) {
  const bill = backup && backup.bill;
  const rows = [];
  const add = (label, value, opts = {}) => {
    if (value == null || value === '') return;
    rows.push({ label, value: String(value), ...opts });
  };
  if (!bill) {
    add('Status', 'No bill located through the Rent Manager API for this posting.');
    return rows;
  }
  add('Invoice / reference', bill.number);
  add('Bill date', bill.date);
  if (bill.postDate && bill.postDate !== bill.date) add('Posted by AP', bill.postDate);
  add('Due', bill.dueDate);
  add('Vendor', bill.vendor);
  add('Bill total', usd(bill.amount));
  if (bill.matchedLine) {
    add('This charge is one line', `${usd(bill.matchedLine.amount)}${bill.matchedLine.unit ? `  unit ${bill.matchedLine.unit}` : ''}`);
  }
  if (bill.lineCount > 1) add('Lines on the invoice', String(bill.lineCount));
  if (bill.approval) {
    add('Approved', bill.approval.approved
      ? ['Yes', bill.approval.by, bill.approval.on ? `on ${bill.approval.on}` : null].filter(Boolean).join(' - ')
      : 'Not approved in Rent Manager', { strong: bill.approval.approved, good: bill.approval.approved });
  }
  if (bill.allocated) {
    add('Settled', `${usd(bill.allocated.amount)} of ${usd(bill.amount)}${bill.allocated.inFull ? ' - paid in full' : ' - not fully paid'}`);
  }
  if (bill.enteredBy) add('Entered by', `${bill.enteredBy}${bill.enteredOn ? ` on ${bill.enteredOn}` : ''}`);
  for (const f of bill.other || []) add(f.label, f.value);
  return rows;
}

function coverPage(pdf, fonts, { charge, backup }) {
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const { reg, bold } = fonts;
  let y = PAGE_H - M;

  const text = (s, { size = 10, font = reg, color = BODY, x = M, dy = 0 } = {}) => {
    y -= dy;
    page.drawText(safe(s), { x, y, size, font, color });
  };
  const rule = (dy = 10) => {
    y -= dy;
    page.drawLine({ start: { x: M, y }, end: { x: PAGE_W - M, y }, thickness: 0.5, color: RULE });
  };
  // A label/value row. The value is clipped by character count rather than
  // measured, because a value that runs off the page edge is worse than one cut
  // short with an ellipsis.
  const row = (label, value, opts = {}) => {
    if (value == null || value === '') return;
    y -= 16;
    page.drawText(safe(label), { x: M, y, size: 9, font: reg, color: MUTED });
    const v = safe(value);
    const max = 62;
    page.drawText(v.length > max ? `${v.slice(0, max - 1)}…` : v, {
      x: M + 132, y, size: 10, font: opts.bold ? bold : reg, color: opts.color || BODY,
    });
  };

  page.drawText('Payment record', { x: M, y, size: 20, font: bold, color: INK });
  y -= 15;
  page.drawText('Produced by the Cedar Ridge Management management site from Rent Manager records.',
    { x: M, y, size: 8.5, font: reg, color: MUTED });
  y -= 11;
  page.drawText('This is a summary of what Rent Manager holds. It is not a receipt issued by the vendor.',
    { x: M, y, size: 8.5, font: reg, color: MUTED });
  rule(14);

  y -= 6;
  text('THE CHARGE', { size: 8.5, font: bold, color: MUTED, dy: 12 });
  row('Property', charge.propertyName);
  row('Unit', charge.unitName || 'Building / no unit named');
  row('Date', charge.date);
  row('Account', [charge.accountRef, charge.accountName].filter(Boolean).join('  '));
  row('Vendor', charge.vendor);
  row('Description', charge.description);
  row('Amount', usd(charge.amount), { bold: true, color: INK });

  y -= 12;
  rule(6);
  text('THE BILL', { size: 8.5, font: bold, color: MUTED, dy: 18 });
  // Page 1 is a fixed height and the bill block is now open-ended, so it is
  // capped by the room actually left rather than by a guessed row count — with
  // the tail below "who paid it" and "to verify" reserved, because those are the
  // point of the page and must never be the rows that fall off it.
  const RESERVED = 260;
  const bRows = billRows(backup);
  let drawn = 0;
  for (const r of bRows) {
    if (y - 16 < RESERVED) break;
    row(r.label, r.value, { bold: r.strong, color: r.good ? GOOD : (r.strong ? INK : BODY) });
    drawn++;
  }
  if (drawn < bRows.length) {
    row('', `+ ${bRows.length - drawn} more field(s) on this bill - see the Renovations tab`);
  }

  y -= 12;
  rule(6);
  text('WHO PAID IT', { size: 8.5, font: bold, color: MUTED, dy: 18 });
  for (const r of whoPaidRows(backup)) {
    row(r.label, r.value, { bold: r.strong, color: r.good ? GOOD : (r.strong ? INK : BODY) });
  }

  const ml = (backup && backup.manualLookup) || {};
  y -= 12;
  rule(6);
  text('TO VERIFY IN RENT MANAGER', { size: 8.5, font: bold, color: MUTED, dy: 18 });
  row('Where', ml.where);
  row('Property', ml.property);
  row('Date', ml.date);
  row('GL account', ml.glAccount);
  row('Vendor', ml.vendor);
  row('Reference', ml.reference);
  // Named here as well as above: this is the block somebody works from when they
  // go and search, and the account is what they search the bank with.
  if (backup && backup.payment && backup.payment.bank && backup.payment.bank.known) {
    row('Bank account', backup.payment.bank.label);
  }

  page.drawText(`Generated ${new Date().toISOString().slice(0, 10)} · Cedar Ridge Management`,
    { x: M, y: 34, size: 8, font: reg, color: MUTED });
  return page;
}

/**
 * Append the vendor's own document, unchanged.
 *
 * A PDF is copied page-for-page. An image is placed on a page of its own, scaled
 * to fit — never stretched, because a squashed invoice is a document somebody
 * will say we altered. Anything else (a spreadsheet, a .msg) cannot go into a PDF
 * and is named on a page instead of being silently dropped.
 */
async function appendDocument(pdf, fonts, { bytes, name, contentType }) {
  const kind = String(contentType || '').toLowerCase();
  const nm = String(name || '').toLowerCase();
  if (kind.includes('pdf') || nm.endsWith('.pdf')) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await pdf.copyPages(src, src.getPageIndices());
    for (const p of pages) pdf.addPage(p);
    return { appended: pages.length, how: 'pdf' };
  }
  if (/png|jpe?g/.test(kind) || /\.(png|jpe?g)$/.test(nm)) {
    const img = /png/.test(kind) || nm.endsWith('.png')
      ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    const maxW = PAGE_W - M * 2, maxH = PAGE_H - M * 2 - 24;
    const s = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = img.width * s, h = img.height * s;
    page.drawText(safe(name || 'Attached document'),
      { x: M, y: PAGE_H - M + 4, size: 9, font: fonts.reg, color: MUTED });
    page.drawImage(img, { x: (PAGE_W - w) / 2, y: (PAGE_H - h) / 2 - 8, width: w, height: h });
    return { appended: 1, how: 'image' };
  }
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  page.drawText('Attached document', { x: M, y: PAGE_H - M, size: 14, font: fonts.bold, color: INK });
  page.drawText(safe(name || '(unnamed)'), { x: M, y: PAGE_H - M - 22, size: 11, font: fonts.reg, color: BODY });
  page.drawText('This file is not a PDF or an image, so it cannot be shown inside this packet.',
    { x: M, y: PAGE_H - M - 40, size: 9.5, font: fonts.reg, color: MUTED });
  page.drawText('Open it from the Renovations tab with "Pull invoice".',
    { x: M, y: PAGE_H - M - 54, size: 9.5, font: fonts.reg, color: MUTED });
  return { appended: 1, how: 'placeholder' };
}

/**
 * @param fetchDoc  async () => { buffer, contentType, fileName } | null
 * @returns {Promise<{bytes: Uint8Array, pages: number, documentPages: number}>}
 */
async function build({ charge, backup, fetchDoc }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Payment record — ${safe(charge.propertyName || '')} ${safe(charge.date || '')}`);
  // pdf-lib stamps its own Producer, so the authorship that matters goes on
  // Creator — this file must never be mistakable for the vendor's own paperwork.
  pdf.setCreator('Cedar Ridge Management management site');
  pdf.setProducer('Cedar Ridge Management management site');
  const fonts = {
    reg: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  coverPage(pdf, fonts, { charge, backup });

  let documentPages = 0;
  let note = null;
  if (fetchDoc) {
    let doc = null;
    try { doc = await fetchDoc(); } catch (err) { note = `document could not be fetched: ${err.message}`; }
    if (doc && doc.buffer && doc.buffer.length) {
      try {
        const r = await appendDocument(pdf, fonts, {
          bytes: doc.buffer, name: doc.fileName, contentType: doc.contentType,
        });
        documentPages = r.appended;
      } catch (err) {
        // A corrupt or encrypted invoice must not take the payment record down
        // with it — the half that works still ships.
        note = `the attached file could not be read into a PDF: ${err.message}`;
      }
    }
  }
  if (!documentPages) {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    page.drawText('No invoice document', { x: M, y: PAGE_H - M, size: 14, font: fonts.bold, color: INK });
    page.drawText(note || 'Rent Manager holds no scan against this charge.',
      { x: M, y: PAGE_H - M - 22, size: 10, font: fonts.reg, color: BODY });
    page.drawText('The payment record on page 1 stands on its own: the check or card that settled',
      { x: M, y: PAGE_H - M - 40, size: 9.5, font: fonts.reg, color: MUTED });
    page.drawText('this charge is recorded in Rent Manager whether or not an invoice was scanned.',
      { x: M, y: PAGE_H - M - 53, size: 9.5, font: fonts.reg, color: MUTED });
  }

  const bytes = await pdf.save();
  return { bytes, pages: pdf.getPageCount(), documentPages };
}

module.exports = { build, appendDocument, safe, whoPaidRows, billRows };
