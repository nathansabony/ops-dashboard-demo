// Small, plausible vendor invoices / receipts, generated on the fly from a GL posting so the
// document always agrees with the books (vendor, invoice no, date, property, amount, lines).

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const world = require('./world');
const { HASH } = require('./payables');

const ascii = s => String(s == null ? '' : s).replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E]/g, '');
const money = n => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = n => Math.round(n * 100);
const fromCents = c => c / 100;
const mdy = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${m}/${d}/${y}`; };

const STREETS = ['Industrial Pkwy', 'Commerce Dr', 'Harbor Way', 'Trade Center Blvd', 'Mill Rd', 'Fairgrounds Ave', 'Corporate Blvd', 'Rail Spur Ln'];
const CITIES = [['Columbus', 'OH', '432'], ['Dublin', 'OH', '430'], ['Westerville', 'OH', '430'], ['Grove City', 'OH', '431'], ['Reynoldsburg', 'OH', '430']];
function vendorAddress(name) {
  const h = HASH('vaddr', name);
  const c = CITIES[Math.floor(HASH('vcity', name) * CITIES.length)];
  return {
    l1: `${100 + Math.floor(h * 8800)} ${STREETS[Math.floor(HASH('vst', name) * STREETS.length)]}`,
    l2: `${c[0]}, ${c[1]} ${c[2]}${String(10 + Math.floor(HASH('vzip', name) * 89))}`,
    phone: `(614) 555-${String(1000 + Math.floor(HASH('vph', name) * 8999))}`,
  };
}

// Split a cent total into weighted whole-cent parts that sum exactly.
function split(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const parts = weights.map(w => Math.floor(abs * w / sum));
  parts[0] += abs - parts.reduce((a, b) => a + b, 0);
  return parts.map(p => p * sign);
}

const UTILITY = /^(5401|5402|5404)/;
function lineItems(e) {
  const total = cents(e.amount);
  const task = String(e.memo || '').replace(/^Unit \S+ - /, '').replace(/^Unit \S+ \S+ /, '');
  const L = [];
  if (total < 0) {
    const [a, b] = split(total, [92, 8]);
    L.push([`Credit - ${ascii(e.memo || 'adjustment')}`, 1, fromCents(a)]);
    if (b) L.push(['Credit - taxes and fees', 1, fromCents(b)]);
    return L;
  }
  if (UTILITY.test(e.accountRef)) {
    const [a, b, c] = split(total, [78, 14, 8]);
    const per = e.servicePeriod ? ` (${e.servicePeriod.from} - ${e.servicePeriod.to})` : '';
    L.push([`Usage charges${per}`, 1, fromCents(a)]);
    L.push(['Base service / meter fee', 1, fromCents(b)]);
    L.push(['Taxes, surcharges and fees', 1, fromCents(c)]);
    return L;
  }
  if (e.memo && /installment|accrual|premium|Management fee|subscription|service|wages|benefits|salary|pay period/i.test(e.memo) && !/^Unit /.test(e.memo)) {
    L.push([ascii(e.memo), 1, fromCents(total)]);
    return L;
  }
  if (total < 25000) { L.push([ascii(e.memo || e.accountName), 1, fromCents(total)]); return L; }
  const major = /^51[5-9]|^61/.test(e.accountRef) || total > 150000;
  if (major) {
    const [a, b, c] = split(total, [52, 38, 10]);
    L.push([`Labor - ${ascii(task || e.accountName)}`, 1, fromCents(a)]);
    L.push([`Materials and equipment - ${ascii(task || e.accountName)}`, 1, fromCents(b)]);
    L.push(['Haul-away, permits and disposal', 1, fromCents(c)]);
    return L;
  }
  const [a, b, c] = split(total, [50 + Math.floor(HASH('lw', e.id) * 20), 38, 12]);
  L.push([`Labor - ${ascii(task || e.accountName)}`, 1, fromCents(a)]);
  L.push([`Parts and materials - ${ascii(task || e.accountName)}`, 1, fromCents(b)]);
  if (c) L.push(['Trip charge / supplies', 1, fromCents(c)]);
  return L;
}

async function invoiceBuffer(bill) {
  const e = bill.__entry;
  const prop = world.propertyById.get(e.propertyId) || {};
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${bill.Reference} - ${ascii(e.vendor)}`);
  doc.setAuthor(ascii(e.vendor));
  const page = doc.addPage([612, 792]);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const INK = rgb(0.12, 0.14, 0.18), MUTED = rgb(0.42, 0.45, 0.5), LINE = rgb(0.82, 0.84, 0.87), ACCENT = rgb(0.13, 0.33, 0.55);
  const T = (s, x, y, size = 10, font = reg, color = INK, opts = {}) => page.drawText(ascii(s), { x, y, size, font, color, ...opts });
  const R = (s, xr, y, size = 10, font = reg, color = INK) => { const w = font.widthOfTextAtSize(ascii(s), size); page.drawText(ascii(s), { x: xr - w, y, size, font, color }); };
  const credit = bill.Amount < 0;
  const addr = vendorAddress(e.vendor);
  const billDate = String(bill.TransactionDate).slice(0, 10);
  const due = String(bill.DueDate).slice(0, 10);

  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: ACCENT });
  T(e.vendor, 40, 760, 18, bold, rgb(1, 1, 1));
  T(addr.l1, 40, 722, 9, reg, MUTED); T(addr.l2, 40, 710, 9, reg, MUTED); T(addr.phone, 40, 698, 9, reg, MUTED);
  T(credit ? 'CREDIT MEMO' : 'INVOICE', 612 - 40 - bold.widthOfTextAtSize(credit ? 'CREDIT MEMO' : 'INVOICE', 22), 716, 22, bold, ACCENT);

  const metaY = 668;
  const meta = [['Invoice no.', String(bill.Reference)], [credit ? 'Credit date' : 'Invoice date', mdy(billDate)], ['Due date', mdy(due)], ['Terms', 'Net 30'], ['Account no.', `${(require('./financials').vendorById(e.vendorId) || {}).acctNo || ''}`]];
  meta.forEach(([k, v], i) => { T(k, 380, metaY - i * 14, 9, reg, MUTED); R(v, 572, metaY - i * 14, 9.5, bold); });

  T('BILL TO', 40, 668, 8, bold, MUTED);
  T('Demo Portfolio', 40, 654, 10.5, bold);
  T('Attn: Accounts Payable', 40, 641, 9.5);
  T('Portfolio Management Dashboard', 40, 629, 9.5);
  T('Columbus, OH', 40, 617, 9.5);

  T('SERVICE LOCATION', 40, 586, 8, bold, MUTED);
  T(prop.name || e.propertyShortName, 40, 572, 10.5, bold);
  T(`${prop.street || ''}`, 40, 559, 9.5);
  T(`${prop.city || 'Columbus'}, ${prop.state || 'OH'} ${prop.zip || ''}${e.unitName ? `   -   Unit ${e.unitName}` : ''}`, 40, 547, 9.5);
  if (e.unitName || /repair|maint|turn|hvac|plumb|electr|door|paint|floor|appliance/i.test(e.accountName)) {
    T(`Work order ref: WO-${String(20000 + Math.floor(HASH('wo', e.id) * 9000))}`, 380, 586 - 0, 9, reg, MUTED);
  }

  // table
  let y = 505;
  page.drawRectangle({ x: 40, y: y - 6, width: 532, height: 22, color: rgb(0.94, 0.95, 0.97) });
  T('Description', 48, y, 9, bold, MUTED); R('Qty', 400, y, 9, bold, MUTED); R('Rate', 480, y, 9, bold, MUTED); R('Amount', 564, y, 9, bold, MUTED);
  y -= 24;
  let sum = 0;
  const multi = (bill.__entries || [e]).length > 1;
  const allLines = (bill.__entries || [e]).flatMap(x => lineItems(x).map(([d, q, a]) => [multi ? `${x.accountName}: ${d}` : d, q, a]));
  for (const [desc, qty, amt] of allLines) {
    const lines = wrap(ascii(desc), reg, 9.5, 300);
    lines.forEach((ln, i) => T(ln, 48, y - i * 12, 9.5));
    R(String(qty), 400, y, 9.5); R(money(amt), 480, y, 9.5); R(money(amt), 564, y, 9.5);
    sum += cents(amt);
    const sepY = y - 12 * (lines.length - 1) - 8;
    page.drawLine({ start: { x: 40, y: sepY }, end: { x: 572, y: sepY }, thickness: 0.5, color: LINE });
    y = sepY - 16;
  }
  y -= 8;
  R('Subtotal', 480, y, 9.5, reg, MUTED); R(money(fromCents(sum)), 564, y, 9.5); y -= 15;
  R('Sales tax', 480, y, 9.5, reg, MUTED); R('$0.00', 564, y, 9.5); y -= 6;
  page.drawLine({ start: { x: 400, y }, end: { x: 572, y }, thickness: 0.8, color: INK }); y -= 18;
  R(credit ? 'CREDIT TOTAL' : 'TOTAL DUE', 480, y, 11, bold); R(money(fromCents(sum)), 564, y, 13, bold, ACCENT);

  if (e.memo && !UTILITY.test(e.accountRef)) { T('Notes', 40, y - 44, 8, bold, MUTED); wrap(ascii(e.memo), reg, 9, 330).forEach((ln, i) => T(ln, 40, y - 58 - i * 11, 9, reg, INK)); }
  T(credit ? 'This credit will be applied to your account. No payment is due.' : 'Please include the invoice number with your payment. Thank you for your business.', 40, 70, 8.5, reg, MUTED);
  T(`${ascii(e.vendor)}  |  ${addr.l1}, ${addr.l2}  |  ${addr.phone}`, 40, 52, 8, reg, MUTED);
  T('Demo document - fictional vendor and figures', 40, 38, 7, reg, rgb(0.65, 0.68, 0.72));
  return Buffer.from(await doc.save());
}

function wrap(text, font, size, width) {
  const words = String(text).split(/\s+/); const out = []; let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > width && cur) { out.push(cur); cur = w; } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

// Second document on large jobs: the signed proposal.
async function proposalBuffer(bill) {
  const e = bill.__entry;
  const prop = world.propertyById.get(e.propertyId) || {};
  const doc = await PDFDocument.create();
  doc.setTitle(`Proposal - ${ascii(e.vendor)}`);
  const page = doc.addPage([612, 792]);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const T = (s, x, y, size = 10, font = reg, color = rgb(0.12, 0.14, 0.18)) => page.drawText(ascii(s), { x, y, size, font, color });
  T(e.vendor, 40, 745, 18, bold, rgb(0.13, 0.33, 0.55));
  T('PROPOSAL AND SCOPE OF WORK', 40, 720, 12, bold);
  T(`Project: ${e.memo || e.accountName}`, 40, 690, 10.5, bold);
  T(`Location: ${prop.name || e.propertyShortName}, ${prop.street || ''}, ${prop.city || 'Columbus'}, ${prop.state || 'OH'}`, 40, 674, 10);
  T(`Proposal date: ${mdy(String(bill.TransactionDate).slice(0, 10).replace(/-\d\d$/, '-01'))}`, 40, 658, 10);
  const scope = ['Mobilize crew and protect adjacent finishes.', 'Remove and dispose of existing materials as required.', `Furnish and install new materials for: ${e.memo || e.accountName}.`, 'Test, clean up and walk the job with the property manager.', 'All work warrantied for 12 months from completion.'];
  let y = 620; T('Scope', 40, y, 10, bold); y -= 18;
  scope.forEach((s, i) => { wrap(`${i + 1}. ${s}`, reg, 10, 500).forEach(ln => { T(ln, 48, y, 10); y -= 13; }); y -= 3; });
  y -= 10;
  T(`Contract price: ${money(Math.abs(e.amount))}`, 40, y, 12, bold); y -= 40;
  T('Accepted by:', 40, y, 10, bold); y -= 30;
  page.drawLine({ start: { x: 40, y }, end: { x: 250, y }, thickness: 0.7, color: rgb(0.3, 0.3, 0.3) });
  page.drawLine({ start: { x: 330, y }, end: { x: 540, y }, thickness: 0.7, color: rgb(0.3, 0.3, 0.3) });
  T('Jordan Reyes, Regional Manager - Demo Portfolio', 40, y - 13, 8.5, reg, rgb(0.42, 0.45, 0.5));
  T(`${e.vendor}, authorized signatory`, 330, y - 13, 8.5, reg, rgb(0.42, 0.45, 0.5));
  T('Demo document - fictional vendor and figures', 40, 38, 7, reg, rgb(0.65, 0.68, 0.72));
  return Buffer.from(await doc.save());
}

async function receiptBuffer(card) {
  const e = card.__entry;
  const prop = world.propertyById.get(e.propertyId) || {};
  const doc = await PDFDocument.create();
  doc.setTitle(`Receipt - ${ascii(e.vendor)}`);
  const total = cents(Math.abs(e.amount));
  const tax = Math.round(total * 0.0725 / 1.0725);
  const net = total - tax;
  const nItems = net > 4000 ? 3 : net > 1200 ? 2 : 1;
  const parts = split(net, Array.from({ length: nItems }, (_, i) => 1 + HASH('ri', card.ID, i)));
  const h = 330 + nItems * 22;
  const page = doc.addPage([288, h]);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const monoB = await doc.embedFont(StandardFonts.CourierBold);
  let y = h - 34;
  const C = (s, font = mono, size = 9) => { const w = font.widthOfTextAtSize(ascii(s), size); page.drawText(ascii(s), { x: (288 - w) / 2, y, size, font }); y -= size + 4; };
  const LR = (l, r, font = mono, size = 9) => { page.drawText(ascii(l), { x: 20, y, size, font }); const w = font.widthOfTextAtSize(ascii(r), size); page.drawText(ascii(r), { x: 268 - w, y, size, font }); y -= size + 4; };
  C(e.vendor, monoB, 11);
  C(`Store ${100 + Math.floor(HASH('store', e.vendor) * 900)} - Columbus, OH`);
  C(`(614) 555-${String(1000 + Math.floor(HASH('rph', e.vendor) * 8999))}`);
  y -= 6; C('-'.repeat(34));
  C(`${mdy(e.date)}   ${String(8 + Math.floor(HASH('rt', card.ID) * 10)).padStart(2, '0')}:${String(Math.floor(HASH('rm', card.ID) * 59)).padStart(2, '0')}`);
  C(`Trans #${String(card.ID).slice(-6)}   Reg 0${1 + Math.floor(HASH('reg', card.ID) * 4)}`);
  C('-'.repeat(34)); y -= 4;
  const ITEMS = ['PVC FITTINGS ASSORTED', 'LED BULB 4PK', 'INTERIOR PAINT 1GAL', 'CAULK / SEALANT', 'FASTENERS 1LB BOX', 'FLOOR CLEANER 1GAL', 'FILTER 20X25X1', 'TOILET FLAPPER KIT', 'WIRE NUT ASSORT', 'CLEANING SUPPLIES', 'WORK GLOVES', 'DISPOSAL BAGS 50CT'];
  parts.forEach((p, i) => LR(ITEMS[Math.floor(HASH('it', card.ID, i) * ITEMS.length)], money(fromCents(p))));
  y -= 4; C('-'.repeat(34));
  LR('SUBTOTAL', money(fromCents(net))); LR('TAX 7.25%', money(fromCents(tax)));
  LR('TOTAL', money(fromCents(total)), monoB, 11); y -= 4;
  const last4 = (card.CreditCardID === 1) ? '4417' : '9082';
  LR('VISA/MC ****' + last4, money(fromCents(total))); C('APPROVED   AUTH ' + String(100000 + Math.floor(HASH('au', card.ID) * 899999)));
  y -= 6; C(`PO / Property: ${prop.name || e.propertyShortName}`); C('Thank you for shopping with us');
  return Buffer.from(await doc.save());
}

module.exports = { invoiceBuffer, proposalBuffer, receiptBuffer, lineItems };
