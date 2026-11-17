// Deterministic terrain from a seed, so the server and every browser draw the same land.

export const MAP_W = 1600;
export const MAP_H = 1100;

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
  return { sample, kind, nearWater };
}

// Palette shared with the map renderer (a quiet planning-map look).
export const TERRAIN_COLORS = {
  light: { water: '#b7cfdc', plains: '#e8ebe3', forest: '#cddcc2', hills: '#ddd8c8', mountains: '#cbc6b8', marsh: '#d5e0d2' },
  dark: { water: '#22343d', plains: '#1c2320', forest: '#1d2a22', hills: '#25261f', mountains: '#2d2c26', marsh: '#1e2a27' },
};
