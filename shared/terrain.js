// Deterministic terrain from a seed, so the server and every browser draw the same land.

export const MAP_W = 1600;
export const MAP_H = 1100;
// The land is divided into square plots. Everything a player builds sits on one plot.
export const TILE = 20;
export const TILES_W = MAP_W / TILE;
export const TILES_H = MAP_H / TILE;
export const tileKey = (tx, ty) => tx + ',' + ty;
export const tileCenter = (tx, ty) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });
export const inMap = (tx, ty) => tx >= 0 && ty >= 0 && tx < TILES_W && ty < TILES_H;
export const NEIGHBOURS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const u = smooth(xf), v = smooth(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y, seed, oct = 5) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * valueNoise(x * f, y * f, seed + i * 101);
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return s / norm;
}

export function makeTerrain(seed) {
  const cache = new Map();
  function sample(x, y) {
    const nx = x / 260, ny = y / 260;
    let e = fbm(nx, ny, seed, 5);
    // a gentle bowl so the edges are wilder and the middle is settled plains
    const dx = x / MAP_W - 0.5, dy = y / MAP_H - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy);
    e = e * 0.85 + r * 0.35 - 0.06;
    const m = fbm(nx * 1.3 + 40, ny * 1.3 + 40, seed + 7, 4);
    return { e, m };
  }
  function kind(x, y) {
    const { e, m } = sample(x, y);
    if (e < 0.33) return 'water';
    if (e > 0.74) return 'mountains';
    if (e > 0.63) return 'hills';
    if (m > 0.56) return 'forest';
    if (e < 0.37 && m > 0.48) return 'marsh';
    return 'plains';
  }
  function nearWater(x, y, r = 34) {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      if (kind(x + Math.cos(ang) * r, y + Math.sin(ang) * r) === 'water') return true;
    }
    return false;
  }
  // Plots: one terrain kind each, taken at the plot's centre.
  const tiles = new Map();
  function tile(tx, ty) {
    const k = tx + ',' + ty;
    let t = tiles.get(k);
    if (!t) {
      if (!inMap(tx, ty)) t = { kind: 'water', e: 0, off: true };
      else { const c = tileCenter(tx, ty); t = { kind: kind(c.x, c.y), e: sample(c.x, c.y).e }; }
      tiles.set(k, t);
    }
    return t;
  }
  function coastal(tx, ty) {
    if (tile(tx, ty).kind === 'water') return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && inMap(tx + dx, ty + dy) && tile(tx + dx, ty + dy).kind === 'water') return true;
    }
    return false;
  }
  // How good a plot is for one building type, 0.7 (poor) to 1.3 (rich). Varies smoothly, so rich land comes in patches.
  function rich(tx, ty, salt) {
    const v = valueNoise(tx / 3.1 + salt * 17.3, ty / 3.1 - salt * 9.1, seed + 900 + salt * 13);
    return +(0.7 + 0.6 * Math.min(1, Math.max(0, (v - 0.2) / 0.6))).toFixed(2);
  }
  return { sample, kind, nearWater, tile, coastal, rich };
}

// Palette shared with the map renderer (a quiet planning-map look).
export const TERRAIN_COLORS = {
  light: { water: '#a9c7da', plains: '#e6e9d6', forest: '#b7d0a6', hills: '#dccfad', mountains: '#b5aa9c', marsh: '#bfd8cf' },
  dark: { water: '#1f3644', plains: '#222a22', forest: '#1c3324', hills: '#39321f', mountains: '#46403a', marsh: '#1d3632' },
};
export const TERRAIN_NAMES = { plains: 'Plains', forest: 'Forest', hills: 'Hills', mountains: 'Mountains', marsh: 'Marsh', water: 'Water' };
