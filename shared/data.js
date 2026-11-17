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

// Size tiers, used by the neutral towns and by player empires alike.
// needs: units consumed per 1,000 residents per hour, added on top of the tiers below.
// For empires: tax is cash per resident per hour, maxLevel caps building levels, and
// charter is what it costs to step up to this tier once enough people live there, and cap is the most people
// an empire of that tier can hold however many houses it has.
export const TIERS = [
  { id: 'hamlet',     name: 'Hamlet',      min: 0,    needs: { grain: 4, fish: 2, salt: 0.8, timber: 1.5 }, tax: 0.08, maxLevel: 1, cap: 600 },
  { id: 'village',    name: 'Village',     min: 400,  needs: { cloth: 1.2, stone: 1, ale: 1.5, wool: 0.4 }, tax: 0.1, maxLevel: 2, cap: 1800,
    charter: { cash: 1000, goods: { timber: 20, stone: 20 } } },
  { id: 'town',       name: 'Market town', min: 1200, needs: { tools: 0.9, iron: 0.4 }, tax: 0.125, maxLevel: 3, cap: 5000,
    charter: { cash: 5000, goods: { stone: 60, cloth: 30, ale: 30 } } },
  { id: 'city',       name: 'City',        min: 3500, needs: { spices: 0.4 }, tax: 0.155, maxLevel: 4, cap: 12000,
    charter: { cash: 20000, goods: { stone: 150, tools: 60, cloth: 60 } } },
  { id: 'metropolis', name: 'Metropolis',  min: 9000, needs: {}, tax: 0.19, maxLevel: 4, cap: 1e9,
    charter: { cash: 80000, goods: { tools: 150, cloth: 150, spices: 80 } } },
];

export function tierIndex(pop) {
  let t = 0;
  for (let i = 0; i < TIERS.length; i++) if (pop >= TIERS[i].min) t = i;
  return t;
}

// Needs per 1,000 residents per hour at a given tier.
export function tierNeeds(ti) {
  const out = {};
  for (let i = 0; i <= ti; i++) for (const [g, r] of Object.entries(TIERS[i].needs)) out[g] = (out[g] || 0) + r;
  return out;
}
export function townNeeds(pop) { return tierNeeds(tierIndex(pop)); }

// Player residents eat a little more than townsfolk, so an empire always has something to chase.
export const EMPIRE_NEED_MULT = 1.5;
export const NEED_WEIGHT = { grain: 2, fish: 1.2 };
export const WORKER_SHARE = 0.5; // half of residents work

// What each terrain lets a neutral town produce.
export const TERRAIN_GOODS = {
  plains: ['grain', 'wool'],
  coast: ['fish', 'salt'],
  forest: ['timber'],
  hills: ['stone', 'wool'],
  mountains: ['iron', 'stone'],
  marsh: ['salt', 'fish'],
};

const ANY_LAND = ['plains', 'forest', 'hills', 'marsh'];

// Everything a player can put on a plot.
//  land: terrain kinds it can stand on. site 'coast' needs water next door; 'salt' needs water next door or marsh.
//  out + rate: raw good made per hour at level 1 on average land. recipe: turns inputs into an output.
//  workers: residents needed to run it at level 1. tier: lowest empire tier that can build it.
//  rich: index used to look up how good a plot is for this building (see terrain.rich).
export const BUILDINGS = {
  hall: { name: 'Town hall', fixed: true, storage: 200, land: ANY_LAND.concat('mountains'), cost: 0,
    blurb: 'The heart of a settlement. Holds 200 of every good.' },
  house: { name: 'Houses', cost: 250, mats: { timber: 8 }, land: ANY_LAND, housing: [50, 120, 250, 500], upkeep: 0,
    blurb: 'Homes for 50 people. Residents work your buildings and pay taxes.' },
  farm: { name: 'Farm', out: 'grain', rate: 4, workers: 20, cost: 350, mats: { timber: 6 }, land: ['plains'], upkeep: 1, rich: 1,
    blurb: 'Grows grain on plains.' },
  pasture: { name: 'Pasture', out: 'wool', rate: 3, workers: 20, cost: 400, mats: { timber: 6 }, land: ['plains', 'hills'], upkeep: 1, rich: 2,
    blurb: 'Raises sheep for wool on plains or hills.' },
  fishery: { name: 'Fishery', out: 'fish', rate: 4, workers: 20, cost: 450, mats: { timber: 10 }, site: 'coast', land: ANY_LAND, upkeep: 1, rich: 3,
    blurb: 'Lands fish. Needs a plot beside water.' },
  saltworks: { name: 'Saltworks', out: 'salt', rate: 3, workers: 20, cost: 450, mats: { timber: 6 }, site: 'salt', land: ANY_LAND, upkeep: 1, rich: 4,
    blurb: 'Makes salt. Needs a plot beside water, or marsh.' },
  lumber: { name: 'Lumber camp', out: 'timber', rate: 4, workers: 20, cost: 300, mats: {}, land: ['forest'], upkeep: 1, rich: 5,
    blurb: 'Fells timber in forest.' },
  quarry: { name: 'Quarry', out: 'stone', rate: 3, workers: 20, cost: 500, mats: { timber: 10 }, land: ['hills', 'mountains'], upkeep: 1, rich: 6,
    blurb: 'Cuts stone from hills or mountains.' },
  mine: { name: 'Iron mine', out: 'iron', rate: 2.5, workers: 25, cost: 900, mats: { timber: 15, stone: 10 }, land: ['mountains'], upkeep: 1.5, rich: 7, tier: 1,
    blurb: 'Digs iron out of mountains.' },
  weaver: { name: 'Weaver', recipe: { in: { wool: 1 }, out: 'cloth' }, rate: 2.5, workers: 25, cost: 1200, mats: { timber: 15, stone: 10 }, land: ANY_LAND, upkeep: 2.5, tier: 1,
    blurb: 'Weaves wool into cloth.' },
  brewery: { name: 'Brewery', recipe: { in: { grain: 2 }, out: 'ale' }, rate: 3, workers: 25, cost: 1100, mats: { timber: 15, stone: 10 }, land: ANY_LAND, upkeep: 2.5, tier: 1,
    blurb: 'Brews ale, two grain a barrel.' },
  smithy: { name: 'Smithy', recipe: { in: { iron: 1, timber: 1 }, out: 'tools' }, rate: 2, workers: 25, cost: 1800, mats: { timber: 10, stone: 20 }, land: ANY_LAND, upkeep: 2.5, tier: 1,
    blurb: 'Forges tools from iron and timber.' },
  warehouse: { name: 'Warehouse', storage: 250, cost: 600, mats: { timber: 15, stone: 5 }, land: ANY_LAND, upkeep: 0.5,
    blurb: 'Lets you hold 250 more of every good.' },
};
export const BUILD_ORDER = ['house', 'farm', 'pasture', 'fishery', 'saltworks', 'lumber', 'quarry', 'mine', 'weaver', 'brewery', 'smithy', 'warehouse'];

export function siteOk(def, kind, coastal) {
  if (kind === 'water') return false;
  if (def.site === 'coast') return coastal;
  if (def.site === 'salt') return coastal || kind === 'marsh';
  return def.land.includes(kind);
}

// Materials for taking any building to a level.
const UPGRADE_MATS = { 2: { timber: 12, stone: 12 }, 3: { stone: 20, tools: 8 }, 4: { stone: 40, tools: 20, cloth: 10 } };
export function upgradeCost(type, level) {
  const def = BUILDINGS[type];
  return { cash: Math.round(def.cost * (0.9 + 0.9 * level)), mats: UPGRADE_MATS[level + 1] || {} };
}
export function maxLevel(type, tier) {
  if (type === 'hall') return 1;
  const cap = TIERS[tier].maxLevel;
  return type === 'house' ? cap : Math.min(3, cap);
}
export const housingOf = (b) => (b.type === 'house' ? BUILDINGS.house.housing[(b.level || 1) - 1] : 0);
export const storageOf = (b) => (BUILDINGS[b.type].storage || 0) * (b.level || 1);
export const ADJ_BONUS = 0.1; // per neighbouring building of the same kind
export const ADJ_MAX = 4;

// Land.
export const CAPITAL_R2 = 5;  // plots within this squared distance of the hall come with a capital (21 plots)
export const OUTPOST_R2 = 2;  // and with an outpost (9 plots)
export const TOWN_PRECINCT = 2; // plots around a neutral town that nobody can claim
export const SETTLE_GAP = 6;  // a new capital must be this many plots from any other settlement or town
export const claimCost = (extra) => Math.round(30 + 8 * extra + 0.15 * extra * extra);
export const outpostCost = (count) => 2500 * Math.pow(2, count);

// Caravans carry your trade with the neutral towns. Couriers deliver Exchange deals for free.
export const CARAVAN = { cost: 500, capacity: 40, speed: 130, upkeep: 0.5, max: 40 };
export const COURIER_SPEED = 180;

export const ROAD = { costPerUnit: 14, base: 250, speedMult: 1.8, upkeepPerUnit: 0.02, defaultToll: 8, maxToll: 60, maxLength: 340 };

export const START = { cash: 3000, caravans: 2, stock: { timber: 80, stone: 40, grain: 80, fish: 30, salt: 12 } };
export const PRICE_MIN = 0.3;
export const PRICE_MAX = 3.5;
export const SPREAD = 0.06; // buy at +6%, sell at -6% of mid

export const EMPIRE_COLORS = ['#d0453b', '#2a78d6', '#e0a106', '#7b4fc4', '#0b8a66', '#e0682a', '#c43f86', '#3b9bb0', '#6a7d1f', '#8a5a3c'];

// Mid price for a good in a town given stock and the town's target stock.
export function midPrice(good, stock, target) {
  const base = GOODS[good].base;
  const r = Math.pow((target + 1) / (stock + 1), 0.7);
  return base * Math.min(PRICE_MAX, Math.max(PRICE_MIN, r));
}

export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export function roadKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
