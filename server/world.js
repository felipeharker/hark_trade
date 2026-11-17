// Generates a fresh world: terrain seed, towns and their local resources.
import { makeTerrain, mulberry32, MAP_W, MAP_H } from '../shared/terrain.js';
import { TERRAIN_GOODS, GOOD_IDS, dist } from '../shared/data.js';

const PRE = ['Ash', 'Bram', 'Cold', 'Dun', 'Elder', 'Fen', 'Gold', 'Hay', 'Iron', 'Kings', 'Lark', 'Mill', 'North', 'Oak', 'Pike', 'Red', 'Salt', 'Thorn', 'Wick', 'Wold', 'Black', 'Stone', 'High', 'Low', 'Marsh', 'Har', 'Brack', 'Gil', 'Tarn', 'Wen', 'Cray', 'Ulver', 'Rook', 'Sedge', 'Bar', 'Lin', 'Mor', 'Ves', 'Quill', 'Hollin'];
const SUF = ['ford', 'bury', 'ton', 'wick', 'stead', 'mouth', 'field', 'haven', 'more', 'dale', 'gate', 'holm', 'by', 'well', 'mere', 'cross', 'brook', 'stow', 'ham', 'reach', 'combe', 'ley', 'thorpe', 'march'];

export function townName(rand, used) {
  for (let i = 0; i < 200; i++) {
    const n = PRE[Math.floor(rand() * PRE.length)] + SUF[Math.floor(rand() * SUF.length)];
    if (!used.has(n)) { used.add(n); return n; }
  }
  return 'Town ' + used.size;
}

export function generateWorld(seed = Math.floor(Math.random() * 1e9)) {
  const rand = mulberry32(seed);
  const terrain = makeTerrain(seed);
  const cx = MAP_W / 2, cy = MAP_H / 2;
  const towns = [];
  const used = new Set();
  const minD = 108;
  let tries = 0;
  // Always seed a capital near the middle.
  while (towns.length < 52 && tries < 20000) {
    tries++;
    let x, y;
    if (towns.length === 0) { const spread = Math.min(900, 120 + tries * 4); x = cx + (rand() - 0.5) * spread; y = cy + (rand() - 0.5) * spread * 0.7; }
    else { x = 50 + rand() * (MAP_W - 100); y = 50 + rand() * (MAP_H - 100); }
    const k = terrain.kind(x, y);
    if (k === 'water') continue;
    if (towns.some((t) => Math.hypot(t.x - x, t.y - y) < minD)) continue;
    const coastal = terrain.nearWater(x, y);
    let tk = coastal && rand() < 0.75 ? 'coast' : k;
    const goods = new Set(TERRAIN_GOODS[tk]);
    // a second influence from what is nearby
    const around = terrain.kind(x + (rand() - 0.5) * 80, y + (rand() - 0.5) * 80);
    if (around !== 'water' && rand() < 0.6) TERRAIN_GOODS[around].forEach((g) => goods.add(g));
    if (rand() < 0.5) goods.add('grain');
    const resources = [...goods].slice(0, 3).map((g) => ({ good: g, rich: +(0.6 + rand() * 0.8).toFixed(2) }));
    const d = towns.length ? Math.hypot((x - towns[0].x) / 1.15, y - towns[0].y) : 0;
    const pop = Math.round((towns.length === 0 ? 1100 : 160 + rand() * 700) * (d < 300 ? 1 : 0.7));
    towns.push({
      id: 't' + towns.length,
      name: townName(rand, used),
      x: Math.round(x), y: Math.round(y),
      terrain: tk, coastal,
      resources,
      pop,
      known: d < 390,
      stock: {},
      sat: 0.7,
      satHist: [],
      popHist: [],
      priceHist: {},
      foundedBy: null,
    });
  }
  // Make sure the opening map has enough towns to trade between.
  const capital = towns[0];
  const byDist = [...towns].sort((p, q) => dist(p, capital) - dist(q, capital));
  byDist.slice(0, 14).forEach((t) => (t.known = true));
  // Rare goods: a few far-off towns grow spices.
  const far = towns.filter((t) => !t.known).sort(() => rand() - 0.5).slice(0, 4);
  for (const t of far) t.resources.push({ good: 'spices', rich: +(0.6 + rand() * 0.5).toFixed(2) });
  // Starting stock near equilibrium.
  for (const t of towns) for (const g of GOOD_IDS) t.stock[g] = 0;
  return {
    version: 1,
    seed,
    createdAt: Date.now(),
    lastTick: Date.now(),
    clockHours: 0,
    towns,
    companies: {},
    caravans: [],
    buildings: [],
    roads: [],
    events: [],
    news: [],
    board: [],
    tradeLog: {}, // good -> { companyId: units } rolling 24h volume
    monopolies: {},
    nextId: 1,
    revealThreshold: 0,
  };
}

export function nearestHidden(world, from) {
  let best = null, bd = Infinity;
  for (const t of world.towns) {
    if (t.known) continue;
    const d = dist(t, from);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
