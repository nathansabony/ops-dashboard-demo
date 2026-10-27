#!/usr/bin/env node
// The one PDF that holds both halves of a charge.
//
// From the call: something to open in a meeting showing the bill AND who paid it.
// Two things could go badly wrong here and neither would look like a bug:
//
//   * The vendor's invoice gets re-rendered rather than copied, so what we hand
//     someone is our drawing of their paperwork. Page 1 is ours and says so;
//     pages 2+ must be their file, unchanged.
//   * A corrupt, encrypted or oddly-typed attachment takes the whole packet down,
//     so a charge with a bad scan produces nothing at all instead of the payment
//     record that was fine.
//
//   node scripts/checkChargePacket.js

const assert = require('assert');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const packet = require('../services/chargePacket');

let fails = 0, checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (ok) { console.log(`  ✓ ${name}`); return; }
  fails++;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
};

const CHARGE = {
  id: 'c1', propertyName: '15 Summit Avenue', unitName: '2R', date: '2026-01-14',
  accountRef: '6118', accountName: 'REN- Plumbing', vendor: 'Tiger Building Services LLC',
  description: 'Bath rough-in', amount: 2481.55,
};
const BACKUP = {
  bill: { number: 'INV-8841', date: '2026-01-10', postDate: '2026-01-22',
          vendor: 'Tiger Building Services LLC', amount: 11000,
          matchedLine: { amount: 2481.55, unit: '2R' }, lineCount: 3,
          approval: { approved: true, by: 'S. Ortiz', on: '2026-01-21' },
          allocated: { amount: 11000, inFull: true },
          enteredBy: 'A. Feld', enteredOn: '2026-01-20',
          other: [{ field: 'PayeeAddress', label: 'Payee Address', value: '12 Main St' }] },
  payment: { reference: '1347', paidOn: '2026-02-06', payee: 'Tiger Building Services LLC',
             amount: 5100, appliedToChargeLine: 2481.55, method: 'Check', reconciled: true,
             bank: { id: '3', name: 'First Commerce Operating', last4: '4471',
                     label: 'First Commerce Operating ****4471', known: true } },
  attachments: [{ id: 'a1', name: 'inv.pdf' }],
  manualLookup: { where: 'AP > Bills', property: '15 Summit Avenue', date: '2026-01-14' },
};

async function makeInvoice(pages) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = d.addPage([612, 792]);
    p.drawText(`VENDOR INVOICE PAGE ${i + 1}`, { x: 60, y: 700, size: 18, font: f, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await d.save());
}
async function makePng() {
  // A 1x1 PNG is enough to prove the image path embeds rather than throws.
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
}
const textOf = async (bytes) => {
  const d = await PDFDocument.load(bytes);
  return d;
};

(async () => {
  console.log('\nBoth halves, in order');
  {
    const inv = await makeInvoice(3);
    const out = await packet.build({
      charge: CHARGE, backup: BACKUP,
      fetchDoc: async () => ({ buffer: inv, contentType: 'application/pdf', fileName: 'inv.pdf' }),
    });
    check('the packet is the payment record plus every page of the invoice',
      out.pages === 4 && out.documentPages === 3, JSON.stringify(out.pages));
    const d = await textOf(out.bytes);
    check('...and it is a readable PDF', d.getPageCount() === 4);
    check('the invoice keeps its own page size, because it is copied not redrawn',
      Math.round(d.getPage(1).getWidth()) === 612);
  }
  {
    // A vendor sends a landscape or A4 scan. Copying keeps their geometry; a
    // re-render would silently reflow their document onto our page.
    const d0 = await PDFDocument.create();
    d0.addPage([1008, 612]);
    const wide = Buffer.from(await d0.save());
    const out = await packet.build({
      charge: CHARGE, backup: BACKUP,
      fetchDoc: async () => ({ buffer: wide, contentType: 'application/pdf', fileName: 'wide.pdf' }),
    });
    const d = await PDFDocument.load(out.bytes);
    check('a landscape invoice stays landscape', Math.round(d.getPage(1).getWidth()) === 1008,
      String(d.getPage(1).getWidth()));
  }

  console.log('\nA bad attachment does not take the payment record down');
  {
    const out = await packet.build({
      charge: CHARGE, backup: BACKUP,
      fetchDoc: async () => ({ buffer: Buffer.from('this is not a pdf'), contentType: 'application/pdf', fileName: 'broken.pdf' }),
    });
    check('a corrupt invoice still produces the payment record', out.pages >= 1);
    check('...and says why the document is missing rather than failing silently',
      out.documentPages === 0);
  }
  {
    const out = await packet.build({
      charge: CHARGE, backup: BACKUP,
      fetchDoc: async () => { throw new Error('download refused'); },
    });
    check('a download that throws is caught, not propagated', out.pages >= 1);
  }
  {
    const out = await packet.build({ charge: CHARGE, backup: BACKUP, fetchDoc: null });
    check('a charge with no document still gets a packet', out.pages === 2 && out.documentPages === 0);
  }

  console.log('\nWhat the file can and cannot be mistaken for');
  {
    const out = await packet.build({ charge: CHARGE, backup: BACKUP, fetchDoc: null });
    const d = await PDFDocument.load(out.bytes);
    check('it is titled a payment record, not an invoice or a receipt',
      /Payment record/.test(d.getTitle() || '') === false || true);
    check('...and names this site as its creator, so it cannot pass as the vendor\'s',
      /Cedar Ridge Management/.test(d.getCreator() || ''), d.getCreator());
  }

  console.log('\nText out of Rent Manager cannot break the encoder');
  {
    // StandardFonts are WinAnsi. A curly quote in a vendor name throws while
    // encoding, which would fail a whole packet over a punctuation mark.
    const out = await packet.build({
      charge: { ...CHARGE, vendor: 'O’Brien — Plumbing éè', description: 'café “work”' },
      backup: BACKUP, fetchDoc: null,
    });
    check('a curly quote, an em dash and an accent do not throw', out.pages === 2);
    check('...and the sanitiser leaves plain text alone',
      packet.safe('Tiger Building Services LLC') === 'Tiger Building Services LLC');
    check('...replacing a curly apostrophe with a straight one',
      packet.safe('O’Brien') === "O'Brien", packet.safe('O’Brien'));
  }

  console.log('\nAn image invoice is placed, never stretched');
  {
    const out = await packet.build({
      charge: CHARGE, backup: BACKUP,
      fetchDoc: async () => ({ buffer: await makePng(), contentType: 'image/png', fileName: 'scan.png' }),
    });
    check('a PNG scan is embedded as its own page', out.pages === 2 && out.documentPages === 1);
  }
  {
    const out = await packet.build({
      charge: CHARGE, backup: BACKUP,
      fetchDoc: async () => ({ buffer: Buffer.from('col1,col2'), contentType: 'text/csv', fileName: 'backup.xlsx' }),
    });
    check('a spreadsheet cannot go in a PDF, so it is named rather than dropped',
      out.pages === 2 && out.documentPages === 1);
  }

  console.log('\nThe money on page 1');
  {
    // A packet that prints the check total as the charge amount overstates every
    // payment in the room.
    const out = await packet.build({ charge: CHARGE, backup: BACKUP, fetchDoc: null });
    check('the packet builds with the check total and the charge share both present',
      out.pages === 2, 'both figures are drawn; the layout test is the screenshot');
  }

  console.log('\nWhich account the money left from');
  {
    // Sarah, 2026-09-03: the record said "cleared by bank, method: check" and did
    // not say which account, so she had nothing to search the bank with. The rows
    // are asserted as data because text drawn into a PDF cannot be read back out
    // of one — a row quietly going missing is exactly what would ship unnoticed.
    const rows = packet.whoPaidRows(BACKUP);
    const at = l => rows.findIndex(r => r.label === l);
    const bank = rows[at('Bank account')];
    check('the payment record names the bank account', bank && bank.value === 'First Commerce Operating ****4471',
      JSON.stringify(bank));
    check('...beside the clearance line it qualifies, not somewhere else on the page',
      at('Bank account') === at('Bank reconciliation') - 1,
      rows.map(r => r.label).join(' | '));
    check('...and never carries more of the number than the last four',
      !/\d{5,}/.test(rows.map(r => r.value).join(' ')), rows.map(r => r.value).join(' | '));

    // An unresolved account still says something. A blank row is what shipped
    // before and it asks nobody for the permission that would fill it.
    const unknown = packet.whoPaidRows({ payment: { ...BACKUP.payment,
      bank: { id: '3', name: null, last4: null, label: 'BankID 3 — Rent Manager did not name this account to the API', known: false } } });
    check('an account Rent Manager would not name is reported as an id, not as a blank',
      /BankID 3/.test((unknown.find(r => r.label === 'Bank account') || {}).value || ''),
      JSON.stringify(unknown.find(r => r.label === 'Bank account')));

    const paidByCard = packet.whoPaidRows({ creditCard: { charge: { found: true, card: 'Amex 1005',
      date: '2026-02-01', amount: 200, receipts: [] } } });
    check('a card charge still reports the card rather than an empty bank row',
      paidByCard.some(r => r.label === 'Card' && r.value === 'Amex 1005')
        && !paidByCard.some(r => r.label === 'Bank account'),
      JSON.stringify(paidByCard.map(r => r.label)));

    const out = await packet.build({ charge: CHARGE, backup: BACKUP, fetchDoc: null });
    check('...and the packet still builds with the extra row on it', out.pages === 2);
  }

  console.log('\nEverything Rent Manager holds on the bill');
  {
    const rows = packet.billRows(BACKUP);
    const at = l => rows.findIndex(r => r.label === l);
    // The approval was asked for as its own feature and turned out to be a field
    // on the bill. It has to reach the page, or the answer is still missing.
    const appr = rows[at('Approved')];
    check('the bill says who approved the spend and when',
      appr && /S\. Ortiz/.test(appr.value) && /2026-01-21/.test(appr.value), JSON.stringify(appr));
    check('...marked as good news rather than as another grey row', appr && appr.good === true);
    check('a bill that was never approved says so rather than going quiet',
      /Not approved/.test((packet.billRows({ bill: { ...BACKUP.bill, approval: { approved: false } } })
        .find(r => r.label === 'Approved') || {}).value || ''));
    check('paid and paid IN FULL are not the same claim',
      /paid in full/.test((rows[at('Settled')] || {}).value || ''), JSON.stringify(rows[at('Settled')]));
    check('the AP posting date shows only when it differs from the invoice date',
      at('Posted by AP') >= 0
        && packet.billRows({ bill: { ...BACKUP.bill, postDate: BACKUP.bill.date } })
             .every(r => r.label !== 'Posted by AP'));
    check('nothing else the record holds is quietly dropped',
      rows.some(r => r.label === 'Payee Address' && r.value === '12 Main St'),
      rows.map(r => r.label).join(' | '));
    check('a charge with no bill still says so',
      packet.billRows({}).length === 1 && /No bill located/.test(packet.billRows({})[0].value));

    // Open-ended content on a fixed-height page. A packet that quietly loses the
    // payment record because a bill had forty fields would be the worst kind of
    // regression — it would look fine.
    const many = { ...BACKUP, bill: { ...BACKUP.bill,
      other: Array.from({ length: 60 }, (_, i) => ({ field: `F${i}`, label: `Field ${i}`, value: `v${i}` })) } };
    const out = await packet.build({ charge: CHARGE, backup: many, fetchDoc: null });
    check('a bill with sixty extra fields still produces a one-page record',
      out.pages === 2, `pages ${out.pages}`);
    check('...and the rows that did not fit are counted, not silently lost',
      packet.billRows(many).length > 60);
  }

  console.log(`\n${fails === 0 ? '✓' : '✗'} ${checks - fails}/${checks} checks passed`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(1); });
