// Query handling shared by the demo route modules: the bits of the Rent Manager
// collection API the site actually uses (filters, fields, embeds, paging).

const q = (query, ...names) => {
  for (const n of names) {
    for (const k of Object.keys(query || {})) if (k.toLowerCase() === n.toLowerCase() && query[k] !== '' && query[k] != null) return query[k];
  }
  return undefined;
};
const getKey = (row, key) => {
  if (key in row) return row[key];
  const k = Object.keys(row).find(x => x.toLowerCase() === String(key).toLowerCase());
  return k ? row[k] : undefined;
};

// RQL: "Field,op,value;Field,op,value" (AND). Ops: eq ne gt ge lt le in like.
function parseFilters(str) {
  if (!str) return [];
  return String(str).split(';').map(part => {
    const bits = part.split(',');
    if (bits.length < 3) return null;
    return { field: bits[0].trim(), op: bits[1].trim().toLowerCase(), value: bits.slice(2).join(',').trim() };
  }).filter(Boolean);
}
function matches(row, f) {
  let v = getKey(row, f.field);
  const want = f.value;
  if (typeof v === 'boolean' || want === 'true' || want === 'false') {
    const b = String(v) === 'true';
    return f.op === 'ne' ? b !== (want === 'true') : b === (want === 'true');
  }
  if (v == null) v = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(want)) v = String(v).slice(0, 10);
  const numeric = v !== '' && !isNaN(Number(v)) && !isNaN(Number(want));
  const a = numeric ? Number(v) : String(v).toLowerCase();
  const b = numeric ? Number(want) : String(want).toLowerCase();
  switch (f.op) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'gt': return a > b;
    case 'ge': return a >= b;
    case 'lt': return a < b;
    case 'le': return a <= b;
    case 'in': return want.split('|').map(s => s.toLowerCase()).includes(String(a));
    case 'like': return String(a).includes(String(b));
    default: return true;
  }
}

// rows: array of plain objects (full records). opts.embed(row, embedsSet) may return a copy with embeds.
function collection(rows, query, opts = {}) {
  const filters = parseFilters(q(query, 'filters', 'filter'));
  let out = filters.length ? rows.filter(r => filters.every(f => matches(r, f))) : rows;
  const size = Number(q(query, 'pagesize')) || out.length || 1;
  const page = Math.max(1, Number(q(query, 'pagenumber')) || 1);
  out = out.slice((page - 1) * size, page * size);
  const embeds = new Set(String(q(query, 'embeds') || '').split(',').map(s => s.trim()).filter(Boolean));
  const fields = q(query, 'fields');
  const want = fields ? new Set(String(fields).split(',').map(s => s.trim().toLowerCase())) : null;
  return out.map(r => {
    let row = opts.embed && embeds.size ? opts.embed(r, embeds) : r;
    if (want) {
      const slim = {};
      for (const k of Object.keys(row)) {
        if (want.has(k.toLowerCase()) || !(k in r)) slim[k] = row[k];   // embeds always ride along
      }
      row = slim;
    }
    return row;
  });
}

// report parameters: parameters[0].Parameter / .Value
function reportParams(query) {
  const out = {};
  for (const k of Object.keys(query || {})) {
    const m = k.match(/^parameters\[(\d+)\]\.Parameter$/i);
    if (m) out[query[k]] = query[`parameters[${m[1]}].Value`];
  }
  return out;
}

module.exports = { q, getKey, parseFilters, matches, collection, reportParams };
