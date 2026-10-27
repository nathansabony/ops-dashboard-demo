const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

function replaceArrayDeclaration(name) {
  const pattern = new RegExp(`^const ${name} = \\[.*\\];$`, 'm');
  const next = html.replace(pattern, `const ${name} = [];`);
  if (next === html) {
    throw new Error(`Could not find ${name} declaration in ${htmlPath}`);
  }
  html = next;
}

function scrubArrayValueForKey(key) {
  const needle = `"${key}": [`;
  let cursor = 0;
  let count = 0;
  let out = '';

  while (cursor < html.length) {
    const keyStart = html.indexOf(needle, cursor);
    if (keyStart === -1) {
      out += html.slice(cursor);
      break;
    }

    const arrayStart = html.indexOf('[', keyStart);
    let depth = 0;
    let inString = false;
    let escaped = false;
    let arrayEnd = -1;

    for (let i = arrayStart; i < html.length; i++) {
      const ch = html[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '[') {
        depth += 1;
      } else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          arrayEnd = i;
          break;
        }
      }
    }

    if (arrayEnd === -1) {
      throw new Error(`Could not find closing array for ${key}`);
    }

    out += html.slice(cursor, keyStart);
    out += `"${key}": []`;
    cursor = arrayEnd + 1;
    count += 1;
  }

  if (count === 0) {
    throw new Error(`Could not find any ${key} arrays`);
  }

  html = out;
  return count;
}

replaceArrayDeclaration('FULL_DELINQUENCY');
replaceArrayDeclaration('TENANTS');
const topDelinqCount = scrubArrayValueForKey('top_delinq');

fs.writeFileSync(htmlPath, html, 'utf8');
console.log(`Removed embedded FULL_DELINQUENCY, TENANTS, and ${topDelinqCount} top_delinq lists.`);
