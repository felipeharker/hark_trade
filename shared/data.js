// Game data shared by the server simulation and the browser client.
// All rates are per real hour: one hour on the clock is one hour in the world.

export const GOODS = {
  grain:  { name: 'Grain',  base: 6,  color: '#d9b44a', kind: 'raw' },
  fish:   { name: 'Fish',   base: 8,  color: '#5f9fc2', kind: 'raw' },
  timber: { name: 'Timber', base: 10, color: '#8a6a43', kind: 'raw' },
  stone:  { name: 'Stone',  base: 9,  color: '#9a9a92', kind: 'raw' },
  wool:   { name: 'Wool',   base: 12, color: '#d8cfbf', kind: 'raw' },
  salt:   { name: 'Salt',   base: 14, color: '#c9d3d6', kind: 'raw' },
  iron:   { name: 'Iron',   base: 18, color: '#6d7480', kind: 'raw' },
  cloth:  { name: 'Cloth',  base: 30, color: '#b0566b', kind: 'made' },
  ale:    { name: 'Ale',    base: 20, color: '#c98a2c', kind: 'made' },
  tools:  { name: 'Tools',  base: 45, color: '#4f6a8f', kind: 'made' },
  spices: { name: 'Spices', base: 60, color: '#c4552b', kind: 'rare' },
};
export const GOOD_IDS = Object.keys(GOODS);

// Town size tiers. Each tier adds needs on top of the ones below it.
// need: units consumed per 1,000 residents per hour.
export const TIERS = [
  { id: 'hamlet',     name: 'Hamlet',     min: 0,    needs: { grain: 4, fish: 2, salt: 0.8, timber: 1.5 } },
  { id: 'village',    name: 'Village',    min: 400,  needs: { cloth: 1.2, stone: 1, ale: 1.5, wool: 0.4 } },
  { id: 'town',       name: 'Market town',min: 1200, needs: { tools: 0.9, iron: 0.4 } },
  { id: 'city',       name: 'City',       min: 3500, needs: { spices: 0.4 } },
  { id: 'metropolis', name: 'Metropolis', min: 9000, needs: {} },
];

export function tierIndex(pop) {
  let t = 0;
  for (let i = 0; i < TIERS.length; i++) if (pop >= TIERS[i].min) t = i;
  return t;
}

export function townNeeds(pop) {
  const ti = tierIndex(pop);
  const out = {};
  for (let i = 0; i <= ti; i++) for (const [g, r] of Object.entries(TIERS[i].needs)) out[g] = (out[g] || 0) + r;
  return out; // per 1000 pop per hour
}

// What each terrain lets a town produce.
export const TERRAIN_GOODS = {
  plains: ['grain', 'wool'],
  coast: ['fish', 'salt'],
  forest: ['timber'],
  hills: ['stone', 'wool'],
  mountains: ['iron', 'stone'],
  marsh: ['salt', 'fish'],
};

export const VEHICLES = {
  wagon:   { name: 'Wagon',         cost: 600,  capacity: 20, speed: 60, upkeep: 2 },
  train:   { name: 'Mule train',    cost: 2200, capacity: 60, speed: 50, upkeep: 5 },
  convoy:  { name: 'Freight convoy',cost: 6500, capacity: 150, speed: 42, upkeep: 11 },
};

export const ROAD = { costPerUnit: 14, base: 250, speedMult: 1.8, upkeepPerUnit: 0.02, defaultToll: 8, maxLength: 340 };

export const BUILDINGS = {
  warehouse: { name: 'Warehouse', cost: 800, upkeep: 2, capacity: 300,
    blurb: 'Store goods in this town. Caravans can load and unload here, and your workshops draw from it.' },
  estate: { name: 'Estate', cost: 2400, upkeep: 6, rate: 6, needs: 'warehouse',
    blurb: "Produces one of the town's local goods into your warehouse, 6 an hour." },
  weaver: { name: 'Weaver', cost: 3000, upkeep: 8, rate: 4, needs: 'warehouse', recipe: { in: { wool: 1 }, out: 'cloth' },
    blurb: 'Turns wool into cloth, 4 an hour.' },
  brewery: { name: 'Brewery', cost: 2800, upkeep: 7, rate: 5, needs: 'warehouse', recipe: { in: { grain: 2 }, out: 'ale' },
    blurb: 'Brews ale from grain, 5 an hour (2 grain each).' },
  smithy: { name: 'Smithy', cost: 3600, upkeep: 9, rate: 3, needs: 'warehouse', recipe: { in: { iron: 1, timber: 1 }, out: 'tools' },
    blurb: 'Forges tools from iron and timber, 3 an hour.' },
};

export const EXPEDITION_COST = 1500;
export const START_CASH = 2500;
export const PRICE_MIN = 0.3;
export const PRICE_MAX = 3.5;
export const SPREAD = 0.06; // buy at +6%, sell at -6% of mid

export const COMPANY_COLORS = ['#d0453b', '#2a78d6', '#e0a106', '#7b4fc4', '#0b8a66', '#e0682a', '#c43f86', '#3b9bb0', '#6a7d1f', '#8a5a3c'];

// Mid price for a good in a town given stock and the town's target stock.
export function midPrice(good, stock, target) {
  const base = GOODS[good].base;
  const r = Math.pow((target + 1) / (stock + 1), 0.7);
  return base * Math.min(PRICE_MAX, Math.max(PRICE_MIN, r));
}

export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export function roadKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
