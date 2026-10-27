// Work-order categories, derived from what the tenant actually wrote.
//
// Rent Manager's ServiceManagerIssues rows come back with no category field at
// all on this account, so normalizeServiceIssue() was defaulting every single
// ticket to 'Maintenance'. The "Issues by Category" doughnut was therefore one
// slice reading "Maintenance 100%" — a chart that cost a render and told you
// nothing.
//
// The signal is in the title. Tenants type "roaches", "no heat", "toilet backing
// up" — that IS the category, just unnormalized. This maps that free text onto
// the buckets a super actually dispatches against.
//
// Two things worth knowing about the rules below:
//
//  1. Order is priority order. The first bucket that matches wins, so the
//     specific ones (Pests, Sewer, Mold) sit above the broad ones (Heat/HVAC,
//     Structural). "Toilet backing up" is a sewer call, not a plumbing call,
//     and the super who gets dispatched is a different person. Appliance and
//     Plumbing outrank Heat/HVAC for the same reason: "refrigerator not
//     cooling" and "water heater leaking" are named by their specific noun,
//     and the generic thermal words would otherwise swallow both.
//
//  2. Tenants write in Spanish. "Rata " and "cucaracha" are real titles from
//     the live feed. A classifier that only speaks English drops those into
//     Uncategorized, which is exactly the ticket you least want to lose.

// Word-boundary matching, so 'ac' doesn't match "back" and 'rat' doesn't match
// "radiator". Accents are stripped first: "calefacción" and "calefaccion" are
// the same word to a tenant typing on a phone.
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Ordered most-specific-first. Each entry's terms are matched whole-word.
const CATEGORY_RULES = [
  {
    category: 'Pests',
    terms: [
      'roach', 'roaches', 'cockroach', 'cockroaches', 'cucaracha', 'cucarachas',
      'rat', 'rats', 'rata', 'ratas', 'raton', 'ratones', 'mice', 'mouse',
      'bedbug', 'bedbugs', 'bed bug', 'bed bugs', 'chinche', 'chinches',
      'ant', 'ants', 'hormiga', 'hormigas', 'termite', 'termites',
      'roden', 'rodent', 'rodents', 'infestation', 'exterminator', 'pest', 'pests',
      'flea', 'fleas', 'wasp', 'wasps', 'bees', 'insect', 'insects', 'plaga', 'plagas',
    ],
  },
  {
    category: 'Sewer / Drain',
    terms: [
      'sewer', 'sewage', 'drain', 'drains', 'drainage', 'clog', 'clogged', 'clogging',
      'backup', 'backed up', 'backing up', 'overflow', 'overflowing', 'septic',
      'sump', 'sump pump', 'main line', 'stoppage', 'desague', 'atascado', 'tapado',
    ],
  },
  {
    category: 'Mold / Moisture',
    terms: ['mold', 'mould', 'mildew', 'moho', 'humedad', 'damp', 'dampness', 'moisture', 'condensation'],
  },
  {
    category: 'Appliance',
    terms: [
      'appliance', 'appliances', 'stove', 'oven', 'range', 'burner', 'burners',
      'fridge', 'refrigerator', 'freezer', 'dishwasher', 'washer', 'dryer',
      'washing machine', 'microwave', 'garbage disposal', 'disposal', 'nevera', 'estufa',
    ],
  },
  {
    category: 'Plumbing',
    terms: [
      'plumbing', 'plumber', 'leak', 'leaks', 'leaking', 'leakage', 'drip', 'dripping',
      'faucet', 'pipe', 'pipes', 'burst', 'water heater', 'hot water', 'no water',
      'toilet', 'toilets', 'sink', 'shower', 'tub', 'bathtub', 'valve', 'water pressure',
      'running water', 'flush', 'flushing', 'agua', 'bano', 'inodoro', 'fuga', 'gotera',
    ],
  },
  {
    category: 'Heat / HVAC',
    terms: [
      'heat', 'heater', 'heating', 'no heat', 'boiler', 'radiator', 'radiators',
      'furnace', 'thermostat', 'hvac', 'ac', 'a/c', 'air condition', 'air conditioner',
      'air conditioning', 'cooling', 'vent', 'vents', 'ventilation',
      'calefaccion', 'calor', 'frio', 'aire',
    ],
  },
  {
    category: 'Electrical',
    terms: [
      'electric', 'electrical', 'electrician', 'outlet', 'outlets', 'breaker', 'breakers',
      'fuse', 'panel', 'wiring', 'wire', 'wires', 'short circuit', 'spark', 'sparking',
      'power', 'no power', 'light', 'lights', 'lighting', 'lightbulb', 'bulb', 'fixture',
      'switch', 'luz', 'luces', 'electricidad', 'corriente', 'enchufe',
    ],
  },
  {
    category: 'Safety / Alarm',
    terms: [
      'alarm', 'smoke detector', 'smoke alarm', 'carbon monoxide', 'co detector',
      'fire', 'fire extinguisher', 'sprinkler', 'emergency', 'gas smell', 'gas leak',
      'smell gas', 'detector', 'alarma', 'humo', 'incendio',
    ],
  },
  {
    category: 'Doors / Locks / Windows',
    terms: [
      'door', 'doors', 'lock', 'locks', 'locked', 'lockout', 'locked out', 'key', 'keys',
      'deadbolt', 'knob', 'handle', 'hinge', 'window', 'windows', 'screen', 'blinds',
      'buzzer', 'intercom', 'gate', 'garage door', 'puerta', 'cerradura', 'llave', 'ventana',
    ],
  },
  {
    category: 'Common Area / Exterior',
    terms: [
      'hallway', 'hall', 'stairs', 'stairway', 'staircase', 'lobby', 'elevator', 'elevators',
      'roof', 'gutter', 'gutters', 'siding', 'garbage', 'trash', 'dumpster', 'recycling',
      'parking', 'lot', 'sidewalk', 'lawn', 'landscaping', 'snow', 'ice', 'laundry room',
      'basement', 'yard', 'fence', 'pasillo', 'escalera', 'basura', 'techo',
    ],
  },
  {
    category: 'Structural',
    terms: [
      'ceiling', 'wall', 'walls', 'floor', 'floors', 'flooring', 'tile', 'tiles',
      'cabinet', 'cabinets', 'counter', 'countertop', 'closet', 'drywall', 'sheetrock',
      'paint', 'painting', 'hole', 'crack', 'cracked', 'collapse', 'collapsed', 'sagging',
      'techo', 'pared', 'piso', 'pintura',
    ],
  },
];

// Categories RM (or our own defaults) hand back that carry no information. When
// we see one of these we classify from the title instead of trusting it.
// '<unassigned>' and 'to do' are RM's own zero-rows — its category list starts
// with a literal '<Unassigned>' and a 'To do' bucket, neither of which says what
// broke. 'maintenance' is the big one: it's the catch-all 73% of tickets land in.
const PLACEHOLDER_CATEGORIES = new Set([
  '', 'maintenance', 'general', 'general maintenance', 'other', 'misc',
  'miscellaneous', 'uncategorized', 'none', 'n/a', 'na', 'unknown',
  '<unassigned>', 'unassigned', 'to do', 'todo', 'work order', 'priorities',
]);

// RM's category names and the keyword buckets above describe the same things in
// different words. Without this, a pest ticket RM tagged and a pest ticket the
// classifier caught land in two adjacent bars — 'Pest Control' and 'Pests' — and
// the chart reads as two smaller problems instead of one big one.
const CATEGORY_ALIASES = new Map([
  ['pest control', 'Pests'],
  ['pest', 'Pests'],
  ['appliances', 'Appliance'],
  ['elevator', 'Common Area / Exterior'],
  ['laundry room', 'Common Area / Exterior'],
  ['common areas', 'Common Area / Exterior'],
]);

const UNCATEGORIZED = 'Uncategorized';

function isPlaceholderCategory(category) {
  return PLACEHOLDER_CATEGORIES.has(String(category || '').trim().toLowerCase());
}

// Pre-split the rule terms once. Multi-word terms ("bed bugs", "no heat") are
// matched as a phrase against the normalized string; single words are matched
// against the token set so 'ac' can't hit "back".
const COMPILED_RULES = CATEGORY_RULES.map(rule => ({
  category: rule.category,
  words: new Set(rule.terms.filter(t => !t.includes(' ') && !t.includes('/'))),
  phrases: rule.terms.filter(t => t.includes(' ') || t.includes('/')),
}));

// Classify a work order from its free text. Returns null when nothing matches,
// so callers can decide between 'Uncategorized' and keeping what RM gave them.
function classifyIssueText(...parts) {
  const text = normalizeText(parts.filter(Boolean).join(' '));
  if (!text) return null;
  const tokens = new Set(text.split(' '));

  for (const rule of COMPILED_RULES) {
    for (const phrase of rule.phrases) {
      if (text.includes(phrase)) return rule.category;
    }
    for (const token of tokens) {
      if (rule.words.has(token)) return rule.category;
    }
  }
  return null;
}

// The category to actually show for an issue: RM's own value when it's a real
// one, otherwise whatever the tenant's words say, otherwise Uncategorized.
// Never silently overrides a category a human set in RM.
function resolveIssueCategory(rmCategory, ...textParts) {
  if (!isPlaceholderCategory(rmCategory)) {
    const name = String(rmCategory).trim();
    return CATEGORY_ALIASES.get(name.toLowerCase()) || name;
  }
  return classifyIssueText(...textParts) || UNCATEGORIZED;
}

module.exports = {
  UNCATEGORIZED,
  CATEGORY_RULES,
  CATEGORY_ALIASES,
  classifyIssueText,
  isPlaceholderCategory,
  resolveIssueCategory,
};
