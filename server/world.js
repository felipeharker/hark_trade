// Generates a fresh world: a terrain seed and the neutral towns that serve as markets.
import { makeTerrain, mulberry32, TILES_W, TILES_H, tileCenter } from '../shared/terrain.js';
import { TERRAIN_GOODS, GOOD_IDS, dist } from '../shared/data.js';

export const WORLD_VERSION = 3;

const PRE = ['Ash', 'Bram', 'Cold', 'Dun', 'Elder', 'Fen', 'Gold', 'Hay', 'Iron', 'Kings', 'Lark', 'Mill', 'North', 'Oak', 'Pike', 'Red', 'Salt', 'Thorn', 'Wick', 'Wold', 'Black', 'Stone', 'High', 'Low', 'Marsh', 'Har', 'Brack', 'Gil', 'Tarn', 'Wen', 'Cray', 'Ulver', 'Rook', 'Sedge', 'Bar', 'Lin', 'Mor', 'Ves', 'Quill', 'Hollin'];
const SUF = ['ford', 'bury', 'ton', 'wick', 'stead', 'mouth', 'field', 'haven', 'more', 'dale', 'gate', 'holm', 'by', 'well', 'mere', 'cross', 'brook', 'stow', 'ham', 'reach', 'combe', 'ley', 'thorpe', 'march'];

export function townName(rand, used) {
  for (let i = 0; i < 200; i++) {
    const n = PRE[Math.floor(rand() * PRE.length)] + SUF[Math.floor(rand() * SUF.length)];
    if (!used.has(n)) { used.add(n); return n; }
  }
  return 'Town ' + used.size;
}

// A world worth settling has some of every kind of land.
function balanced(seed) {
  const t = makeTerrain(seed);
  const c = { water: 0, plains: 0, forest: 0, hills: 0, mountains: 0, marsh: 0 };
  let coast = 0;
  for (let ty = 0; ty < TILES_H; ty++) for (let tx = 0; tx < TILES_W; tx++) {
    c[t.tile(tx, ty).kind]++;
    if (t.coastal(tx, ty)) coast++;
  }
  const n = (TILES_W * TILES_H) / 4400; // thresholds were set on an 80 by 55 map
  return c.water >= 140 * n && c.water <= 900 * n && coast >= 110 * n && c.mountains >= 110 * n && c.hills >= 300 * n && c.forest >= 600 * n && c.plains >= 1500 * n;
}

export function pickSeed() {
  for (let i = 0; i < 400; i++) {
    const s = Math.floor(Math.random() * 1e9);
    if (balanced(s)) return s;
  }
  return 42;
}

const TOWN_COUNT = 54;

export function generateWorld(seed = pickSeed()) {
  const rand = mulberry32(seed);
  const terrain = makeTerrain(seed);
  const towns = [];
  const used = new Set();
  let minD = 200;
  let tries = 0;
  while (towns.length < TOWN_COUNT && tries < 30000) {
    tries++;
    if (tries % 4000 === 0) minD -= 15; // loosen up if the land is cramped
    let tx, ty;
    if (towns.length === 0) {
      const spread = Math.min(30, 4 + tries / 8);
      tx = Math.round(TILES_W / 2 + (rand() - 0.5) * spread); ty = Math.round(TILES_H / 2 + (rand() - 0.5) * spread * 0.7);
    } else { tx = 4 + Math.floor(rand() * (TILES_W - 8)); ty = 4 + Math.floor(rand() * (TILES_H - 8)); }
    const k = terrain.tile(tx, ty).kind;
    if (k === 'water') continue;
    const { x, y } = tileCenter(tx, ty);
    if (towns.some((t) => Math.hypot(t.x - x, t.y - y) < minD)) continue;
    const coastal = terrain.nearWater(x, y, 30);
    const tk = coastal && rand() < 0.75 ? 'coast' : k;
    const goods = new Set(TERRAIN_GOODS[tk]);
    // a second influence from what is nearby
    const around = terrain.kind(x + (rand() - 0.5) * 80, y + (rand() - 0.5) * 80);
    if (around !== 'water' && rand() < 0.6) TERRAIN_GOODS[around].forEach((g) => goods.add(g));
    if (rand() < 0.5) goods.add('grain');
    const resources = [...goods].slice(0, 3).map((g) => ({ good: g, rich: +(0.6 + rand() * 0.8).toFixed(2) }));
    const pop = Math.round(towns.length === 0 ? 1100 : 180 + rand() * 650);
    towns.push({
      id: 't' + towns.length, name: townName(rand, used),
      x, y, tx, ty, terrain: tk, coastal, resources, pop,
      stock: {}, sat: 0.7, popHist: [], priceHist: {},
    });
  }
  // Between them the towns must offer every raw good, or an empire on the wrong land would have nowhere to turn.
  // Hand each scarce good to the towns furthest from anyone already making it.
  const QUOTA = { stone: 11, iron: 9, timber: 11, fish: 11, salt: 11, wool: 11, grain: 14 };
  for (const [good, quota] of Object.entries(QUOTA)) {
    for (;;) {
      const makers = towns.filter((t) => t.resources.some((r) => r.good === good));
      if (makers.length >= quota) break;
      const open = towns.filter((t) => !makers.includes(t) && t.resources.length < 3);
      const pool = open.length ? open : towns.filter((t) => !makers.includes(t));
      if (!pool.length) break;
      const far = (t) => (makers.length ? Math.min(...makers.map((m) => dist(m, t))) : rand() * 100);
      pool.sort((p, q) => far(q) - far(p));
      const t = pool[0];
      const r = { good, rich: +(0.7 + rand() * 0.7).toFixed(2) };
      if (t.resources.length < 3) t.resources.push(r);
      else t.resources[t.resources.length - 1] = r;
    }
  }
  // A few far-off towns grow spices, which nobody can make at home.
  const capital = towns[0];
  const outer = towns.slice(1).sort((p, q) => dist(q, capital) - dist(p, capital)).slice(0, 18);
  const far = [outer[0]];
  while (far.length < 5) { // spread around the rim, not all in one corner
    const spread = (t) => Math.min(...far.map((f) => dist(f, t)));
    far.push(outer.filter((t) => !far.includes(t)).sort((p, q) => spread(q) - spread(p))[0]);
  }
  for (const t of far) t.resources.push({ good: 'spices', rich: +(0.7 + rand() * 0.5).toFixed(2) });
  for (const t of towns) for (const g of GOOD_IDS) t.stock[g] = 0;
  return {
    version: WORLD_VERSION,
    seed,
    createdAt: Date.now(),
    lastTick: Date.now(),
    clockHours: 0,
    towns,
    empires: {},
    settlements: [],
    tiles: {},       // "tx,ty" -> { o: empire id, s: settlement id }
    buildings: [],
    trips: [],       // caravans and couriers on the move
    roads: [],
    events: [],
    news: [],
    board: [],
    listings: [],
    offers: [],
    leaders: {},     // good -> empire id that makes most of it
    nextId: 1,
  };
}
