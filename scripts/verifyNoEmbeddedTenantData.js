const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const checks = [
  {
    label: 'FULL_DELINQUENCY is empty',
    pass: /^const FULL_DELINQUENCY = \[\];$/m.test(html),
  },
  {
    label: 'TENANTS is empty',
    pass: /^const TENANTS = \[\];$/m.test(html),
  },
  {
    label: 'top_delinq arrays are empty',
    pass: !/"top_delinq": \[\s*[{\["0-9A-Za-z]/.test(html),
  },
  {
    label: 'no email addresses in static HTML',
    pass: !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(html),
  },
  {
    label: 'no common phone-number patterns in static HTML',
    pass: !/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/.test(html),
  },
  {
    label: 'known former tenant names are absent',
    pass: !/Wilson, Tiffany|Ramonita Lopez|Blissett, Jason|Flis, Gabriela/i.test(html),
  },
];

const failed = checks.filter(check => !check.pass);
for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.label}`);
}

if (failed.length) {
  process.exitCode = 1;
}
