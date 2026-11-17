// Canvas map: terrain, fog over the unknown, roads, towns, works and moving caravans.
import { makeTerrain, MAP_W, MAP_H, TERRAIN_COLORS } from '/shared/terrain.js';

const CELL = 3;
const FOG = { light: [208, 212, 204], dark: [13, 17, 15] };

function isDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class MapView {
  constructor(canvas, handlers) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.h = handlers; // { onTown, onCaravan, onEmpty }
    this.s = 0.6; this.ox = 0; this.oy = 0;
    this.state = null;
    this.sel = null; // {kind, id}
    this.pick = null; // {filter(town) -> bool}
    this.base = null; this.baseKey = '';
    this.timeOffset = 0;
    this.fitted = false;
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
    this.state = st;
    this.timeOffset = st.now - Date.now();
    this.townMap = new Map(st.towns.map((t) => [t.id, t]));
    this.coMap = new Map(st.companies.map((c) => [c.id, c]));
    if (!this.fitted && st.towns.length) { this.fit(); this.fitted = true; }
  }

  fit(towns = this.state.towns) {
    const xs = towns.map((t) => t.x), ys = towns.map((t) => t.y);
    const minX = Math.min(...xs) - 90, maxX = Math.max(...xs) + 90;
    const minY = Math.min(...ys) - 90, maxY = Math.max(...ys) + 90;
    const padL = this.w > 760 ? 320 : 10, padR = this.w > 760 ? 490 : 10;
    const availW = Math.max(200, this.w - padL - padR), availH = Math.max(200, this.hgt - 52 - 20);
    this.s = Math.min(availW / (maxX - minX), availH / (maxY - minY), 2.2);
    this.ox = padL + (availW - (maxX - minX) * this.s) / 2 - minX * this.s;
    this.oy = 52 + 10 + (availH - (maxY - minY) * this.s) / 2 - minY * this.s;
  }

  centerOn(x, y) {
    const padR = this.w > 760 ? 490 : 0;
    this.ox = (this.w - padR) / 2 - x * this.s;
    this.oy = this.hgt / 2 - y * this.s;
  }

  toScreen(x, y) { return [x * this.s + this.ox, y * this.s + this.oy]; }
  toWorld(sx, sy) { return [(sx - this.ox) / this.s, (sy - this.oy) / this.s]; }

  buildBase() {
    const st = this.state;
    const dark = isDark();
    const key = `${st.seed}|${st.towns.length}|${dark}`;
    if (key === this.baseKey) return;
    this.baseKey = key;
    if (!this.terrain || this.terrainSeed !== st.seed) {
      this.terrain = makeTerrain(st.seed); this.terrainSeed = st.seed;
      const cw = Math.ceil(MAP_W / CELL), ch = Math.ceil(MAP_H / CELL);
      this.kinds = new Array(cw * ch);
      this.elev = new Float32Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const wx = x * CELL + CELL / 2, wy = y * CELL + CELL / 2;
        this.kinds[y * cw + x] = this.terrain.kind(wx, wy);
        this.elev[y * cw + x] = this.terrain.sample(wx, wy).e;
      }
      this.cw = cw; this.ch = ch;
    }
    const pal = dark ? TERRAIN_COLORS.dark : TERRAIN_COLORS.light;
    const rgb = Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, hexToRgb(v)]));
    const fogRgb = dark ? FOG.dark : FOG.light;
    const cv = document.createElement('canvas');
    cv.width = this.cw; cv.height = this.ch;
    const g = cv.getContext('2d');
    const img = g.createImageData(this.cw, this.ch);
    const towns = st.towns;
    for (let y = 0; y < this.ch; y++) for (let x = 0; x < this.cw; x++) {
      const i = y * this.cw + x;
      const k = this.kinds[i];
      let [r, gg, b] = rgb[k];
      // gentle relief shading
      const e = this.elev[i];
      const ex = this.elev[i + 1] ?? e;
      const shade = k === 'water' ? (e - 0.33) * 50 : (e - ex) * 450;
      r += shade; gg += shade; b += shade;
      // fog beyond what anyone has mapped
      const wx = x * CELL, wy = y * CELL;
      let d = Infinity;
      for (const t of towns) { const dd = (t.x - wx) ** 2 + (t.y - wy) ** 2; if (dd < d) d = dd; }
      d = Math.sqrt(d);
      const f = Math.min(1, Math.max(0, (d - 160) / 110)) * 0.92;
      r = r * (1 - f) + fogRgb[0] * f; gg = gg * (1 - f) + fogRgb[1] * f; b = b * (1 - f) + fogRgb[2] * f;
      img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.base = cv;
  }

  caravanPos(c, now) {
    if (c.at) {
      const t = this.townMap.get(c.at);
      if (!t) return null;
      const here = this.state.caravans.filter((x) => x.at === c.at);
      const i = here.indexOf(c);
      const a = (i / Math.max(1, here.length)) * Math.PI * 2 - Math.PI / 2;
      const r = 10 / this.s + this.townR(t) / this.s + 4 / this.s;
      return [t.x + Math.cos(a) * r, t.y + Math.sin(a) * r];
    }
    const A = this.townMap.get(c.from), B = this.townMap.get(c.to);
    if (!A || !B) return null;
    const p = Math.min(1, Math.max(0, (now - c.departAt) / (c.arriveAt - c.departAt)));
    return [A.x + (B.x - A.x) * p, A.y + (B.y - A.y) * p];
  }

  townR(t) { return Math.max(4, Math.min(16, 3 + Math.sqrt(t.pop) / 7)) * Math.min(1.4, Math.max(0.75, this.s)); }

  draw() {
    const st = this.state;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ink').trim();
    const surface = css.getPropertyValue('--surface').trim();
    const accent = css.getPropertyValue('--accent').trim();
    const fog = isDark() ? FOG.dark : FOG.light;
    ctx.fillStyle = `rgb(${fog.join(',')})`;
    ctx.fillRect(0, 0, this.w, this.hgt);
    if (!st) return;
    this.buildBase();
    const now = Date.now() + this.timeOffset;
    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.s, this.s);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, 0, 0, MAP_W, MAP_H);
    ctx.restore();

    // event halos
    for (const e of st.events) {
      const t = this.townMap.get(e.town);
      if (!t) continue;
      const [x, y] = this.toScreen(t.x, t.y);
      const r = (e.radius || 40) * this.s;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      const col = e.type === 'bandits' ? 'rgba(208,59,59,' : e.type === 'drought' || e.type === 'fire' ? 'rgba(236,131,90,' : 'rgba(250,178,25,';
      ctx.fillStyle = col + '0.07)'; ctx.fill();
      ctx.setLineDash([4, 5]); ctx.strokeStyle = col + '0.55)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    }

    // routes in progress (thin dashed lines)
    for (const c of st.caravans) {
      if (c.at) continue;
      const A = this.townMap.get(c.from), B = this.townMap.get(c.to);
      if (!A || !B || c.viaRoad) continue;
      const co = this.coMap.get(c.owner);
      const [x1, y1] = this.toScreen(A.x, A.y), [x2, y2] = this.toScreen(B.x, B.y);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.setLineDash([3, 4]); ctx.strokeStyle = (co?.color || ink) + '88'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
    }

    // roads
    for (const r of st.roads) {
      const A = this.townMap.get(r.a), B = this.townMap.get(r.b);
      if (!A || !B) continue;
      const co = this.coMap.get(r.owner);
      const [x1, y1] = this.toScreen(A.x, A.y), [x2, y2] = this.toScreen(B.x, B.y);
      const sel = this.sel?.kind === 'road' && this.sel.id === r.id;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = surface; ctx.lineWidth = sel ? 9 : 6; ctx.stroke();
      ctx.strokeStyle = co?.color || ink; ctx.lineWidth = sel ? 5 : 3; ctx.stroke();
    }

    // towns
    ctx.textAlign = 'center';
    const pickable = this.pick ? new Set(st.towns.filter(this.pick.filter).map((t) => t.id)) : null;
    for (const t of st.towns) {
      const [x, y] = this.toScreen(t.x, t.y);
      if (x < -60 || y < -60 || x > this.w + 60 || y > this.hgt + 60) continue;
      const r = this.townR(t);
      const sel = this.sel?.kind === 'town' && this.sel.id === t.id;
      if (pickable && pickable.has(t.id)) {
        ctx.beginPath(); ctx.arc(x, y, r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      }
      // satisfaction ring
      ctx.beginPath(); ctx.arc(x, y, r + 2.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t.sat);
      ctx.strokeStyle = t.sat > 0.6 ? '#0ca30c' : t.sat > 0.45 ? '#e0a106' : '#d03b3b';
      ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = surface; ctx.fill();
      ctx.strokeStyle = sel ? accent : ink; ctx.lineWidth = sel ? 3 : 1.5; ctx.stroke();
      if (t.tier >= 2) { ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, Math.PI * 2); ctx.fillStyle = ink; ctx.fill(); }
      // works around the town, one tick per building in its owner's colour
      const bs = st.buildings.filter((b) => b.town === t.id);
      bs.forEach((b, i) => {
        const a = Math.PI * 0.75 + (i / Math.max(6, bs.length)) * Math.PI * 1.5;
        const bx = x + Math.cos(a) * (r + 7), by = y + Math.sin(a) * (r + 7);
        ctx.fillStyle = this.coMap.get(b.owner)?.color || ink;
        const sz = b.type === 'warehouse' ? 5 : 4;
        ctx.fillRect(bx - sz / 2, by - sz / 2, sz, sz);
      });
      // label
      if (this.s > 0.45 || t.tier >= 1 || sel) {
        ctx.font = `${t.tier >= 2 ? 700 : 600} ${t.tier >= 2 ? 13 : 12}px Overpass, system-ui, sans-serif`;
        ctx.lineWidth = 3.5; ctx.strokeStyle = surface; ctx.lineJoin = 'round';
        ctx.strokeText(t.name, x, y + r + 16);
        ctx.fillStyle = ink; ctx.fillText(t.name, x, y + r + 16);
      }
    }

    // caravans
    this.caravanScreen = [];
    for (const c of st.caravans) {
      const p = this.caravanPos(c, now);
      if (!p) continue;
      const [x, y] = this.toScreen(p[0], p[1]);
      const co = this.coMap.get(c.owner);
      const mine = st.me && c.owner === st.me.id;
      const sel = this.sel?.kind === 'caravan' && this.sel.id === c.id;
      const r = c.type === 'wagon' ? 3.5 : c.type === 'train' ? 4.5 : 5.5;
      ctx.beginPath(); ctx.arc(x, y, r + (sel ? 3 : 1.5), 0, Math.PI * 2);
      ctx.fillStyle = sel ? accent : surface; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = co?.color || ink; ctx.fill();
      if (mine && !c.at) { ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.stroke(); }
      this.caravanScreen.push({ c, x, y });
    }
  }

  hit(sx, sy) {
    const st = this.state;
    if (!st) return null;
    if (!this.pick && this.caravanScreen) {
      let best = null, bd = 9;
      for (const p of this.caravanScreen) { const d = Math.hypot(p.x - sx, p.y - sy); if (d < bd) { bd = d; best = p.c; } }
      if (best) return { kind: 'caravan', id: best.id };
    }
    let bt = null, bd = Infinity;
    for (const t of st.towns) {
      const [x, y] = this.toScreen(t.x, t.y);
      const d = Math.hypot(x - sx, y - sy);
      if (d < this.townR(t) + 10 && d < bd) { bd = d; bt = t; }
    }
    if (bt) return { kind: 'town', id: bt.id };
    // roads
    for (const r of st.roads) {
      const A = this.townMap.get(r.a), B = this.townMap.get(r.b);
      if (!A || !B) continue;
      const [x1, y1] = this.toScreen(A.x, A.y), [x2, y2] = this.toScreen(B.x, B.y);
      const dx = x2 - x1, dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((sx - x1) * dx + (sy - y1) * dy) / (dx * dx + dy * dy)));
      if (Math.hypot(x1 + dx * t - sx, y1 + dy * t - sy) < 5) return { kind: 'road', id: r.id };
    }
    return null;
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
      moved = false;
    });
    c.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) {
        const h = this.hit(e.offsetX, e.offsetY);
        c.style.cursor = this.pick ? 'crosshair' : h ? 'pointer' : '';
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
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) { this.ox = down.ox + dx; this.oy = down.oy + dy; c.classList.add('panning'); }
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      c.classList.remove('panning');
      if (down && !moved && pts.size === 0) {
        const h = this.hit(e.offsetX, e.offsetY);
        if (this.pick) {
          if (h?.kind === 'town') {
            const t = this.townMap.get(h.id);
            if (this.pick.filter(t)) this.pick.done(t);
          }
        } else if (h?.kind === 'town') this.h.onTown(h.id);
        else if (h?.kind === 'caravan') this.h.onCaravan(h.id);
        else if (h?.kind === 'road') this.h.onRoad(h.id);
        else this.h.onEmpty();
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
    const ns = Math.max(0.25, Math.min(4, this.s * f));
    const [wx, wy] = this.toWorld(sx, sy);
    this.s = ns;
    this.ox = sx - wx * ns; this.oy = sy - wy * ns;
  }
}
