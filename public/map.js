// Canvas map: land plots, claimed territory, buildings, towns, roads and the caravans moving between them.
import { makeTerrain, MAP_W, MAP_H, TILE, TILES_W, TILES_H, TERRAIN_COLORS, tileKey, inMap, NEIGHBOURS4 } from '/shared/terrain.js';
import { GOODS, BUILDINGS, TOWN_PRECINCT, siteOk } from '/shared/data.js';
import { settleTiles, settleProblem, claimCheck } from '/shared/rules.js';

const CHIP = { hall: null, house: '#e8a87c', warehouse: '#b9bdb6' };
export function buildingColor(type) {
  if (type in CHIP) return CHIP[type];
  const def = BUILDINGS[type];
  return GOODS[def.out || def.recipe?.out]?.color || '#b9bdb6';
}

function isDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const lum = (h) => { const [r, g, b] = hexToRgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const rgba = (h, a) => { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})`; };

// Small pictograms, drawn in a unit square.
const GLYPH = {
  hall(c) { c.beginPath(); c.moveTo(0.3, 0.86); c.lineTo(0.3, 0.14); c.stroke(); c.beginPath(); c.moveTo(0.3, 0.16); c.lineTo(0.8, 0.31); c.lineTo(0.3, 0.48); c.closePath(); c.fill(); },
  house(c) { c.beginPath(); c.moveTo(0.5, 0.16); c.lineTo(0.86, 0.48); c.lineTo(0.73, 0.48); c.lineTo(0.73, 0.82); c.lineTo(0.27, 0.82); c.lineTo(0.27, 0.48); c.lineTo(0.14, 0.48); c.closePath(); c.fill(); },
  farm(c) { for (const y of [0.3, 0.5, 0.7]) { c.beginPath(); c.moveTo(0.2, y); c.lineTo(0.8, y); c.stroke(); } },
  pasture(c) { for (const [x, y] of [[0.3, 0.62], [0.56, 0.36], [0.72, 0.68]]) { c.beginPath(); c.arc(x, y, 0.11, 0, 7); c.fill(); } },
  fishery(c) { c.beginPath(); c.ellipse(0.43, 0.5, 0.27, 0.15, 0, 0, 7); c.fill(); c.beginPath(); c.moveTo(0.66, 0.5); c.lineTo(0.88, 0.34); c.lineTo(0.88, 0.66); c.closePath(); c.fill(); },
  saltworks(c) { c.beginPath(); c.moveTo(0.18, 0.78); c.lineTo(0.5, 0.26); c.lineTo(0.82, 0.78); c.closePath(); c.stroke(); },
  lumber(c) { c.beginPath(); c.moveTo(0.5, 0.14); c.lineTo(0.8, 0.66); c.lineTo(0.2, 0.66); c.closePath(); c.fill(); c.fillRect(0.44, 0.66, 0.12, 0.2); },
  quarry(c) { c.strokeRect(0.18, 0.52, 0.32, 0.3); c.strokeRect(0.5, 0.3, 0.32, 0.52); },
  mine(c) { c.beginPath(); c.moveTo(0.18, 0.5); c.quadraticCurveTo(0.5, 0.08, 0.82, 0.5); c.stroke(); c.beginPath(); c.moveTo(0.5, 0.28); c.lineTo(0.5, 0.88); c.stroke(); },
  weaver(c) { for (const v of [0.36, 0.64]) { c.beginPath(); c.moveTo(v, 0.18); c.lineTo(v, 0.82); c.stroke(); c.beginPath(); c.moveTo(0.18, v); c.lineTo(0.82, v); c.stroke(); } },
  brewery(c) { c.beginPath(); c.ellipse(0.5, 0.5, 0.24, 0.33, 0, 0, 7); c.stroke(); for (const y of [0.36, 0.64]) { c.beginPath(); c.moveTo(0.29, y); c.lineTo(0.71, y); c.stroke(); } },
  smithy(c) { c.beginPath(); c.moveTo(0.16, 0.32); c.lineTo(0.84, 0.32); c.lineTo(0.66, 0.5); c.lineTo(0.6, 0.5); c.lineTo(0.6, 0.66); c.lineTo(0.76, 0.82); c.lineTo(0.24, 0.82); c.lineTo(0.4, 0.66); c.lineTo(0.4, 0.5); c.lineTo(0.3, 0.5); c.closePath(); c.fill(); },
  warehouse(c) { c.strokeRect(0.2, 0.24, 0.6, 0.56); c.beginPath(); c.moveTo(0.2, 0.24); c.lineTo(0.8, 0.8); c.moveTo(0.8, 0.24); c.lineTo(0.2, 0.8); c.stroke(); },
};

export class MapView {
  constructor(canvas, handlers) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.h = handlers; // { onSelect(sel|null), onTool(tile) }
    this.s = 0.6; this.ox = 0; this.oy = 0;
    this.state = null;
    this.sel = null;   // { kind: 'tile', tx, ty } | { kind: 'town', id } | { kind: 'road', id }
    this.tool = null;  // { type: 'build', kind } | { type: 'claim' } | { type: 'settle', capital } | { type: 'place', ok(place) }
    this.hover = null; // [tx, ty]
    this.base = null; this.baseKey = '';
    this.timeOffset = 0;
    this.pad = { l: 0, r: 0, t: 52, b: 0 }; // screen edges covered by the interface
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const loop = () => { this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.c.width = Math.round(r.width * this.dpr);
    this.c.height = Math.round(r.height * this.dpr);
    this.w = r.width; this.hgt = r.height;
  }

  setState(st) {
    const first = !this.state;
    if (!this.terrain || this.seed !== st.seed) {
      this.terrain = makeTerrain(st.seed); this.seed = st.seed; this.base = null; this.baseKey = '';
    }
    this.state = st;
    this.timeOffset = st.now - Date.now();
    this.townMap = new Map(st.towns.map((t) => [t.id, t]));
    this.empMap = new Map(st.empires.map((c) => [c.id, c]));
    this.placeMap = new Map([...st.towns, ...st.settlements].map((p) => [p.id, p]));
    this.owner = new Map(st.tiles.map(([k, o, s]) => [k, { o, s }]));
    this.bAt = new Map(st.buildings.map((b) => [tileKey(b.tx, b.ty), b]));
    this.ctxRules = {
      terrain: this.terrain, towns: st.towns, settlements: st.settlements,
      tileAt: (tx, ty) => this.owner.get(tileKey(tx, ty)),
    };
    this.toolCache = null;
    if (first) this.fit();
  }

  fit() {
    const { l, r, t, b } = this.pad;
    const availW = Math.max(160, this.w - l - r - 16), availH = Math.max(160, this.hgt - t - b - 16);
    this.s = Math.min(availW / MAP_W, availH / MAP_H);
    this.ox = l + 8 + (availW - MAP_W * this.s) / 2;
    this.oy = t + 8 + (availH - MAP_H * this.s) / 2;
  }

  centerOn(x, y, s) {
    if (s) this.s = s;
    const { l, r, t, b } = this.pad;
    this.ox = l + (this.w - l - r) / 2 - x * this.s;
    this.oy = t + (this.hgt - t - b) / 2 - y * this.s;
  }

  // Is this world point on screen and clear of the interface?
  inView(x, y) {
    const [sx, sy] = this.toScreen(x, y);
    return sx > this.pad.l + 20 && sx < this.w - this.pad.r - 20 && sy > this.pad.t + 20 && sy < this.hgt - this.pad.b - 20;
  }

  toScreen(x, y) { return [x * this.s + this.ox, y * this.s + this.oy]; }
  toWorld(sx, sy) { return [(sx - this.ox) / this.s, (sy - this.oy) / this.s]; }
  tileAtScreen(sx, sy) { const [x, y] = this.toWorld(sx, sy); return [Math.floor(x / TILE), Math.floor(y / TILE)]; }

  buildBase() {
    const dark = isDark();
    const key = `${this.seed}|${dark}`;
    if (key === this.baseKey && this.base) return;
    this.baseKey = key;
    const pal = dark ? TERRAIN_COLORS.dark : TERRAIN_COLORS.light;
    const rgb = Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, hexToRgb(v)]));
    const cv = document.createElement('canvas');
    cv.width = TILES_W; cv.height = TILES_H;
    const g = cv.getContext('2d');
    const img = g.createImageData(TILES_W, TILES_H);
    for (let ty = 0; ty < TILES_H; ty++) for (let tx = 0; tx < TILES_W; tx++) {
      const t = this.terrain.tile(tx, ty);
      let [r, gg, b] = rgb[t.kind];
      const right = this.terrain.tile(Math.min(TILES_W - 1, tx + 1), ty);
      // a little grain so neighbouring plots read as separate, and deeper water further out
      const jitter = (((tx * 73856093) ^ (ty * 19349663)) >>> 0) % 5 - 2;
      const shade = (t.kind === 'water' ? Math.max(-14, (t.e - 0.33) * 70) : (t.e - right.e) * 60) + jitter * (dark ? 0.5 : 0.8);
      r += shade; gg += shade; b += shade;
      const i = (ty * TILES_W + tx) * 4;
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.base = cv;
  }

  tripPos(t, now) {
    let p;
    if (now <= t.arriveAt) p = (now - t.departAt) / Math.max(1, t.arriveAt - t.departAt);
    else if (t.returnAt > t.arriveAt) p = 1 - (now - t.arriveAt) / (t.returnAt - t.arriveAt);
    else p = 1;
    p = Math.min(1, Math.max(0, p));
    const { pts, cum } = t;
    for (let i = 1; i < pts.length; i++) {
      if (p <= cum[i] || i === pts.length - 1) {
        const f = (p - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
      }
    }
    return pts[0];
  }

  townR(t) { return Math.max(5, Math.min(15, 4 + Math.sqrt(t.pop) / 7)) * Math.min(1.5, Math.max(0.6, this.s * 1.6)); }

  // Which plots the current tool can act on. Recomputed when the state or the tool changes.
  toolTiles() {
    const st = this.state, tool = this.tool;
    if (!tool || !st?.me) return null;
    const key = JSON.stringify(tool);
    if (this.toolCache?.key === key) return this.toolCache.tiles;
    const tiles = new Map();
    if (tool.type === 'build') {
      const def = BUILDINGS[tool.kind];
      for (const [k, t] of this.owner) {
        if (t.o !== st.me.id || this.bAt.has(k)) continue;
        const [tx, ty] = k.split(',').map(Number);
        if (siteOk(def, this.terrain.tile(tx, ty).kind, this.terrain.coastal(tx, ty))) tiles.set(k, def.rich ? this.terrain.rich(tx, ty, def.rich) : 1);
      }
    } else if (tool.type === 'claim') {
      for (const [k, t] of this.owner) {
        if (t.o !== st.me.id) continue;
        const [tx, ty] = k.split(',').map(Number);
        for (const [dx, dy] of NEIGHBOURS4) {
          const nk = tileKey(tx + dx, ty + dy);
          if (!tiles.has(nk) && !claimCheck(this.ctxRules, tx + dx, ty + dy, st.me.id).problem) tiles.set(nk, 1);
        }
      }
    }
    this.toolCache = { key, tiles };
    return tiles;
  }

  draw() {
    const st = this.state;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ink').trim();
    const surface = css.getPropertyValue('--surface').trim();
    const accent = css.getPropertyValue('--accent').trim();
    const dark = isDark();
    ctx.fillStyle = dark ? '#0d110f' : '#cfd8dc';
    ctx.fillRect(0, 0, this.w, this.hgt);
    if (!st) return;
    this.buildBase();
    const now = Date.now() + this.timeOffset;
    const s = this.s, tp = TILE * s; // plot size on screen
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, this.ox, this.oy, MAP_W * s, MAP_H * s);

    // visible plots
    const [wx0, wy0] = this.toWorld(0, 0), [wx1, wy1] = this.toWorld(this.w, this.hgt);
    const tx0 = Math.max(0, Math.floor(wx0 / TILE)), ty0 = Math.max(0, Math.floor(wy0 / TILE));
    const tx1 = Math.min(TILES_W - 1, Math.floor(wx1 / TILE)), ty1 = Math.min(TILES_H - 1, Math.floor(wy1 / TILE));
    const visible = (tx, ty) => tx >= tx0 - 1 && tx <= tx1 + 1 && ty >= ty0 - 1 && ty <= ty1 + 1;
    const px = (tx) => tx * tp + this.ox, py = (ty) => ty * tp + this.oy;

    if (tp >= 18) {
      ctx.beginPath();
      for (let tx = tx0; tx <= tx1 + 1; tx++) { ctx.moveTo(Math.round(px(tx)) + 0.5, py(ty0)); ctx.lineTo(Math.round(px(tx)) + 0.5, py(ty1 + 1)); }
      for (let ty = ty0; ty <= ty1 + 1; ty++) { ctx.moveTo(px(tx0), Math.round(py(ty)) + 0.5); ctx.lineTo(px(tx1 + 1), Math.round(py(ty)) + 0.5); }
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.05)' : 'rgba(21,28,24,0.07)'; ctx.lineWidth = 1; ctx.stroke();
    }

    // town precincts
    if (tp >= 7) {
      ctx.setLineDash([3, 3]); ctx.strokeStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(21,28,24,0.25)'; ctx.lineWidth = 1;
      for (const t of st.towns) {
        if (!visible(t.tx, t.ty)) continue;
        ctx.strokeRect(px(t.tx - TOWN_PRECINCT), py(t.ty - TOWN_PRECINCT), tp * (TOWN_PRECINCT * 2 + 1), tp * (TOWN_PRECINCT * 2 + 1));
      }
      ctx.setLineDash([]);
    }

    // claimed land: a wash of the owner's colour, with a firm line around the edge
    for (const [k, t] of this.owner) {
      const [tx, ty] = k.split(',').map(Number);
      if (!visible(tx, ty)) continue;
      const col = this.empMap.get(t.o)?.color || '#888888';
      ctx.fillStyle = rgba(col, dark ? 0.2 : 0.16);
      ctx.fillRect(px(tx), py(ty), tp + 0.5, tp + 0.5);
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, Math.min(3, tp / 10));
      ctx.beginPath();
      const x = px(tx), y = py(ty);
      if (this.owner.get(tileKey(tx, ty - 1))?.o !== t.o) { ctx.moveTo(x, y); ctx.lineTo(x + tp, y); }
      if (this.owner.get(tileKey(tx, ty + 1))?.o !== t.o) { ctx.moveTo(x, y + tp); ctx.lineTo(x + tp, y + tp); }
      if (this.owner.get(tileKey(tx - 1, ty))?.o !== t.o) { ctx.moveTo(x, y); ctx.lineTo(x, y + tp); }
      if (this.owner.get(tileKey(tx + 1, ty))?.o !== t.o) { ctx.moveTo(x + tp, y); ctx.lineTo(x + tp, y + tp); }
      ctx.stroke();
    }

    // what the current tool can do
    const tool = this.tool;
    const tiles = this.toolTiles();
    if (tiles) {
      for (const [k, v] of tiles) {
        const [tx, ty] = k.split(',').map(Number);
        if (!visible(tx, ty)) continue;
        if (tool.type === 'build') {
          ctx.fillStyle = rgba(dark ? '#46c495' : '#0b8a66', 0.18 + (v - 0.7) * 0.75);
          ctx.fillRect(px(tx) + 1, py(ty) + 1, tp - 2, tp - 2);
        } else {
          ctx.setLineDash([4, 3]); ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
          ctx.strokeRect(px(tx) + 2, py(ty) + 2, tp - 4, tp - 4); ctx.setLineDash([]);
        }
      }
    }
    if (tool?.type === 'settle' && this.hover) {
      const [hx, hy] = this.hover;
      const bad = settleProblem(this.ctxRules, hx, hy, tool.capital, st.me?.id || null);
      for (const [tx, ty] of settleTiles(this.ctxRules, hx, hy, tool.capital)) {
        ctx.fillStyle = bad ? 'rgba(208,59,59,0.28)' : rgba(tool.color || accentHex(accent), 0.38);
        ctx.fillRect(px(tx) + 1, py(ty) + 1, tp - 2, tp - 2);
      }
    }
    if (tool?.type === 'settle' && tool.at) {
      for (const [tx, ty] of settleTiles(this.ctxRules, tool.at[0], tool.at[1], tool.capital)) {
        ctx.strokeStyle = tool.color || accent; ctx.lineWidth = 2;
        ctx.strokeRect(px(tx) + 1.5, py(ty) + 1.5, tp - 3, tp - 3);
      }
    }

    // event halos
    for (const e of st.events) {
      const t = this.townMap.get(e.town);
      if (!t) continue;
      const [x, y] = this.toScreen(t.x, t.y);
      const r = (e.radius || 40) * s;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      const col = e.type === 'bandits' ? 'rgba(208,59,59,' : e.type === 'drought' || e.type === 'fire' ? 'rgba(236,131,90,' : 'rgba(250,178,25,';
      ctx.fillStyle = col + '0.06)'; ctx.fill();
      ctx.setLineDash([4, 5]); ctx.strokeStyle = col + '0.55)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    }

    // roads
    ctx.lineCap = 'round';
    for (const r of st.roads) {
      const A = this.placeMap.get(r.a), B = this.placeMap.get(r.b);
      if (!A || !B) continue;
      const co = this.empMap.get(r.owner);
      const [x1, y1] = this.toScreen(A.x, A.y), [x2, y2] = this.toScreen(B.x, B.y);
      const sel = this.sel?.kind === 'road' && this.sel.id === r.id;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = surface; ctx.lineWidth = sel ? 9 : 6; ctx.stroke();
      ctx.strokeStyle = co?.color || ink; ctx.lineWidth = sel ? 5 : 3; ctx.stroke();
    }

    // trips: a faint line for your own, a dot for everyone's
    this.tripScreen = [];
    for (const t of st.trips) {
      const mine = st.me && t.owner === st.me.id;
      const co = this.empMap.get(t.owner);
      if (mine) {
        ctx.beginPath();
        t.pts.forEach((p, i) => { const [x, y] = this.toScreen(p[0], p[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.setLineDash([3, 5]); ctx.strokeStyle = rgba(co?.color || '#888888', 0.7); ctx.lineWidth = 1.3; ctx.stroke(); ctx.setLineDash([]);
      }
    }

    // buildings
    for (const b of st.buildings) {
      if (!visible(b.tx, b.ty)) continue;
      const x = px(b.tx), y = py(b.ty);
      const own = this.empMap.get(b.owner)?.color || '#888888';
      const col = buildingColor(b.type) || own;
      const inset = tp >= 12 ? Math.max(1.5, tp * 0.1) : 0.5;
      ctx.globalAlpha = b.paused ? 0.45 : 1;
      ctx.fillStyle = col;
      roundRect(ctx, x + inset, y + inset, tp - inset * 2, tp - inset * 2, Math.min(5, tp * 0.14));
      ctx.fill();
      if (tp >= 12) { ctx.strokeStyle = dark ? 'rgba(0,0,0,0.5)' : 'rgba(21,28,24,0.45)'; ctx.lineWidth = 1; ctx.stroke(); }
      if (tp >= 15 && GLYPH[b.type]) {
        const gs = tp - inset * 2;
        ctx.save();
        ctx.translate(x + inset, y + inset); ctx.scale(gs, gs);
        const fg = lum(col) > 0.55 ? '#1b221e' : '#ffffff';
        ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.lineWidth = 0.085; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        GLYPH[b.type](ctx);
        ctx.restore();
        ctx.lineCap = 'round';
      }
      ctx.globalAlpha = 1;
      if (tp >= 22 && b.level > 1) {
        ctx.fillStyle = surface; ctx.strokeStyle = ink; ctx.lineWidth = 1;
        for (let i = 0; i < b.level; i++) { ctx.beginPath(); ctx.arc(x + tp - inset - 4 - i * 6, y + tp - inset - 4, 2.2, 0, 7); ctx.fill(); ctx.stroke(); }
      }
      if (tp >= 15 && b.idle) {
        ctx.beginPath(); ctx.arc(x + inset + 4, y + inset + 4, 3.2, 0, 7);
        ctx.fillStyle = b.idle === 'inputs' ? '#d03b3b' : '#e0a106'; ctx.fill(); ctx.strokeStyle = surface; ctx.lineWidth = 1; ctx.stroke();
      }
    }

    // towns
    ctx.textAlign = 'center';
    const labels = [];
    const pickable = tool?.type === 'place' ? tool.ok : null;
    for (const t of st.towns) {
      const [x, y] = this.toScreen(t.x, t.y);
      if (x < -80 || y < -80 || x > this.w + 80 || y > this.hgt + 80) continue;
      const r = this.townR(t);
      const sel = this.sel?.kind === 'town' && this.sel.id === t.id;
      if (pickable && pickable(t)) {
        ctx.beginPath(); ctx.arc(x, y, r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.beginPath(); ctx.arc(x, y, r + 2.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t.sat);
      ctx.strokeStyle = t.sat > 0.6 ? '#0ca30c' : t.sat > 0.45 ? '#e0a106' : '#d03b3b';
      ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = surface; ctx.fill();
      ctx.strokeStyle = sel ? accent : ink; ctx.lineWidth = sel ? 3 : 1.5; ctx.stroke();
      if (t.tier >= 2) { ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, Math.PI * 2); ctx.fillStyle = ink; ctx.fill(); }
      labels.push({ text: t.name, x, y: y + r + 15, font: `600 ${t.tier >= 2 ? 13 : 12}px Overpass, system-ui, sans-serif`, fill: ink, rank: sel ? 1e9 : t.pop });
    }

    // settlements: named under the hall, in the owner's colour
    for (const p of st.settlements) {
      const [x, y] = this.toScreen(p.x, p.y);
      if (x < -80 || y < -80 || x > this.w + 80 || y > this.hgt + 80) continue;
      const co = this.empMap.get(p.owner);
      if (pickable && pickable(p)) {
        ctx.beginPath(); ctx.arc(x, y, Math.max(12, tp * 0.8), 0, Math.PI * 2);
        ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      }
      if (tp < 12) { // from far away the hall is too small to see, so mark the settlement
        ctx.beginPath(); ctx.arc(x, y, p.capital ? 5 : 3.5, 0, 7); ctx.fillStyle = co?.color || ink; ctx.fill();
        ctx.strokeStyle = surface; ctx.lineWidth = 1.5; ctx.stroke();
      }
      const text = tp < 12 && p.capital ? co?.name || p.name : p.name;
      // close up the buildings matter more than the name, which the hall shows when clicked
      if (tp < 30 && (tp >= 12 || p.capital)) labels.push({ text, x, y: y + Math.max(tp * 0.5, 6) + 14, font: `800 ${p.capital ? 13 : 12}px Overpass, system-ui, sans-serif`, fill: co?.color || ink, rank: p.capital ? 1e8 : 1e7 });
    }
    // names, most important first; one that would sit on another is left out until you zoom in
    const taken = [];
    for (const L of labels.sort((a, b) => b.rank - a.rank)) {
      ctx.font = L.font;
      const w = ctx.measureText(L.text).width / 2 + 3;
      const box = [L.x - w, L.y - 12, L.x + w, L.y + 4];
      if (taken.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
      taken.push(box);
      label(ctx, L.text, L.x, L.y, L.fill, surface);
    }

    // moving caravans and couriers
    for (const t of st.trips) {
      const [wx, wy] = this.tripPos(t, now);
      const [x, y] = this.toScreen(wx, wy);
      const co = this.empMap.get(t.owner);
      const mine = st.me && t.owner === st.me.id;
      const r = t.kind === 'courier' ? 3.2 : 3 + Math.min(3, t.caravans || 1) * 0.8;
      ctx.beginPath(); ctx.arc(x, y, r + 1.5, 0, 7); ctx.fillStyle = surface; ctx.fill();
      ctx.beginPath();
      if (t.kind === 'courier') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); } else ctx.arc(x, y, r, 0, 7);
      ctx.fillStyle = co?.color || ink; ctx.fill();
      if (mine) { ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.stroke(); }
    }

    // hover and selection
    if (this.hover && inMap(this.hover[0], this.hover[1]) && tp >= 7 && tool?.type !== 'place') {
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.7)' : 'rgba(21,28,24,0.65)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(px(this.hover[0]) + 0.5, py(this.hover[1]) + 0.5, tp - 1, tp - 1);
    }
    if (this.sel?.kind === 'tile') {
      ctx.strokeStyle = accent; ctx.lineWidth = 3;
      ctx.strokeRect(px(this.sel.tx) + 1, py(this.sel.ty) + 1, tp - 2, tp - 2);
      ctx.strokeStyle = surface; ctx.lineWidth = 1;
      ctx.strokeRect(px(this.sel.tx) - 1, py(this.sel.ty) - 1, tp + 2, tp + 2);
    }
  }

  hit(sx, sy, slop = 0) {
    const st = this.state;
    if (!st) return null;
    let bt = null, bd = Infinity;
    for (const t of st.towns) {
      const [x, y] = this.toScreen(t.x, t.y);
      const d = Math.hypot(x - sx, y - sy);
      if (d < this.townR(t) + 8 + slop && d < bd) { bd = d; bt = t; }
    }
    if (bt) return { kind: 'town', id: bt.id };
    const [tx, ty] = this.tileAtScreen(sx, sy);
    const k = tileKey(tx, ty);
    if (!this.bAt.has(k)) {
      for (const r of st.roads) {
        const A = this.placeMap.get(r.a), B = this.placeMap.get(r.b);
        if (!A || !B) continue;
        const [x1, y1] = this.toScreen(A.x, A.y), [x2, y2] = this.toScreen(B.x, B.y);
        const dx = x2 - x1, dy = y2 - y1;
        const f = Math.max(0, Math.min(1, ((sx - x1) * dx + (sy - y1) * dy) / (dx * dx + dy * dy)));
        if (Math.hypot(x1 + dx * f - sx, y1 + dy * f - sy) < 5 + slop * 0.6) return { kind: 'road', id: r.id };
      }
    }
    if (!inMap(tx, ty)) return null;
    return { kind: 'tile', tx, ty };
  }

  // The town or settlement under the pointer, for tools that pick a place.
  placeAt(sx, sy, slop = 0) {
    let best = null, bd = Infinity;
    for (const p of this.placeMap.values()) {
      const [x, y] = this.toScreen(p.x, p.y);
      const d = Math.hypot(x - sx, y - sy);
      if (d < Math.max(18, TILE * this.s) + slop && d < bd) { bd = d; best = p; }
    }
    return best;
  }

  bindInput() {
    const c = this.c;
    let down = null, moved = false;
    const pts = new Map();
    let pinch = null;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: this.s };
      }
      down = { x: e.offsetX, y: e.offsetY, ox: this.ox, oy: this.oy };
      moved = pts.size > 1; // a second finger is never a tap
    });
    c.addEventListener('pointermove', (e) => {
      this.hover = e.pointerType === 'touch' ? null : this.tileAtScreen(e.offsetX, e.offsetY);
      if (!pts.has(e.pointerId)) {
        c.style.cursor = this.tool ? 'crosshair' : this.hit(e.offsetX, e.offsetY) ? 'pointer' : '';
        return;
      }
      pts.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this.zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (pinch.s * d / pinch.d) / this.s);
        moved = true;
        return;
      }
      if (!down) return;
      const dx = e.offsetX - down.x, dy = e.offsetY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > (e.pointerType === 'touch' ? 10 : 5)) moved = true;
      if (moved) { this.ox = down.ox + dx; this.oy = down.oy + dy; c.classList.add('panning'); }
    });
    c.addEventListener('pointerleave', () => { this.hover = null; });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pinch && pts.size === 1) { // one finger left after a pinch: carry on panning from where it is
        const [q] = [...pts.values()];
        down = { x: q[0], y: q[1], ox: this.ox, oy: this.oy };
      }
      if (pts.size < 2) pinch = null;
      c.classList.remove('panning');
      const slop = e.pointerType === 'touch' ? 10 : 0;
      if (down && !moved && pts.size === 0) {
        const tool = this.tool;
        if (tool?.type === 'place') {
          const p = this.placeAt(e.offsetX, e.offsetY, slop);
          if (p && tool.ok(p)) this.h.onTool({ place: p });
        } else if (tool) {
          const [tx, ty] = this.tileAtScreen(e.offsetX, e.offsetY);
          if (inMap(tx, ty)) this.h.onTool({ tx, ty });
        } else this.h.onSelect(this.hit(e.offsetX, e.offsetY, slop));
      }
      if (pts.size === 0) down = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
  }

  zoomAt(sx, sy, f) {
    const ns = Math.max(0.07, Math.min(5, this.s * f));
    const [wx, wy] = this.toWorld(sx, sy);
    this.s = ns;
    this.ox = sx - wx * ns; this.oy = sy - wy * ns;
  }
}

function accentHex(a) { return /^#[0-9a-f]{6}$/i.test(a) ? a : '#0b8a66'; }

function label(ctx, text, x, y, fill, halo) {
  ctx.lineWidth = 3.5; ctx.strokeStyle = halo; ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill; ctx.fillText(text, x, y);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
