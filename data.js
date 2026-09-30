// FAKE SAMPLE DATA: generated for demonstration only. Not real properties or financials.
const MONTHS = ['Oct 2025','Nov 2025','Dec 2025','Jan 2026','Feb 2026','Mar 2026','Apr 2026','May 2026','Jun 2026','Jul 2026','Aug 2026','Sep 2026'];

const BASE = [
  { name: 'Maple Court',    region: 'North',   units: 48,  rent: 1850, occ: 0.95, opexRatio: 0.42 },
  { name: 'Riverside Lofts',region: 'North',   units: 72,  rent: 2100, occ: 0.93, opexRatio: 0.40 },
  { name: 'Birch Gardens',  region: 'North',   units: 36,  rent: 1650, occ: 0.97, opexRatio: 0.45 },
  { name: 'Harbor View',    region: 'Central', units: 90,  rent: 2300, occ: 0.91, opexRatio: 0.38 },
  { name: 'Oak Terrace',    region: 'Central', units: 24,  rent: 1550, occ: 0.96, opexRatio: 0.47 },
  { name: 'Summit Place',   region: 'Central', units: 60,  rent: 1950, occ: 0.89, opexRatio: 0.43 },
  { name: 'Cedar Row',      region: 'South',   units: 40,  rent: 1700, occ: 0.94, opexRatio: 0.44 },
  { name: 'Willow Park',    region: 'South',   units: 54,  rent: 1800, occ: 0.92, opexRatio: 0.41 },
];

// Deterministic pseudo-random so the demo looks the same every load
let seed = 7;
function rand() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }

const PROPERTIES = BASE.map(b => ({
  name: b.name,
  region: b.region,
  months: MONTHS.map((_, i) => {
    const occupancy = Math.min(0.995, Math.max(0.82, b.occ + (rand() - 0.5) * 0.05 + i * 0.001));
    const revenue = b.units * b.rent * occupancy * (1 + i * 0.002);
    const budget = b.units * b.rent * b.occ * b.opexRatio;
    const opex = budget * (0.94 + rand() * 0.18);
    return { occupancy, revenue, budget, opex };
  })
}));
