// Balance check: a few simple-minded players run empires for some days, checking in every few hours.
// Usage: node tools/simtest.mjs [days] [players] [seed] [hours between check-ins]
import fs from 'node:fs';
import { generateWorld } from '../server/world.js';
import { advance, initStocks, terrainOf, empireEconomy, netWorth, idleCaravans, quote, homeFor } from '../server/sim.js';
import { ACTIONS, createEmpire } from '../server/actions.js';
import { EXCHANGE } from '../server/exchange.js';
import { settleProblem, settleTiles, claimCheck } from '../shared/rules.js';
import { tileKey, TILES_W, TILES_H, NEIGHBOURS4 } from '../shared/terrain.js';
import { BUILDINGS, GOODS, GOOD_IDS, TIERS, CARAVAN, siteOk, upgradeCost, maxLevel, claimCost, tierNeeds } from '../shared/data.js';

const A = { ...ACTIONS, ...EXCHANGE };
const DAYS = Number(process.argv[2]) || 14, PLAYERS = Number(process.argv[3]) || 3, SEED = Number(process.argv[4]) || undefined, EVERY = Number(process.argv[5]) || 4;
const realNow = Date.now();
let clock = realNow - (DAYS + 1) * 24 * 3600e3; // finish at the present, so a saved world can be loaded by the server
Date.now = () => clock;
const w = generateWorld(SEED);
initStocks(w);
clock += 24 * 3600e3; advance(w, clock);
const terr = terrainOf(w);
const ctx = () => ({ terrain: terr, towns: w.towns, settlements: w.settlements, tileAt: (x, y) => w.tiles[tileKey(x, y)] });
const tryAct = (name, e, a) => { try { return A[name](w, e, a) || {}; } catch (err) { return null; } };

function siteScore(tx, ty) {
  const kinds = {}; let coast = 0;
  for (const [x, y] of settleTiles(ctx(), tx, ty, true)) { const k = terr.tile(x, y).kind; kinds[k] = (kinds[k] || 0) + 1; if (terr.coastal(x, y)) coast++; }
  return Math.min(kinds.plains || 0, 8) + Math.min(kinds.forest || 0, 4) * 1.5 + Math.min(coast, 3) * 2 + Math.min(kinds.hills || 0, 3) * 1.5;
}
function found(id, name) {
  let best = null;
  for (let i = 0; i < 3000; i++) {
    const tx = 3 + Math.floor(Math.random() * (TILES_W - 6)), ty = 3 + Math.floor(Math.random() * (TILES_H - 6));
    if (settleProblem(ctx(), tx, ty, true, null)) continue;
    const s = siteScore(tx, ty);
    if (!best || s > best.s) best = { tx, ty, s };
  }
  createEmpire(w, id, { name, tx: best.tx, ty: best.ty });
}
const names = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir'];
for (let i = 0; i < PLAYERS; i++) found('u' + (i + 1), names[i]);

const myTiles = (e) => Object.entries(w.tiles).filter(([, t]) => t.o === e.id).map(([k]) => k.split(',').map(Number));
const occupied = () => new Set(w.buildings.map((b) => tileKey(b.tx, b.ty)));
function freeSite(e, kind) {
  const def = BUILDINGS[kind], occ = occupied();
  let best = null;
  for (const [tx, ty] of myTiles(e)) {
    if (occ.has(tileKey(tx, ty)) || !siteOk(def, terr.tile(tx, ty).kind, terr.coastal(tx, ty))) continue;
    let r = def.rich ? terr.rich(tx, ty, def.rich) : 1;
    // houses and workshops should not sit on land a producer needs
    if (!def.out) r -= (terr.coastal(tx, ty) ? 0.5 : 0) + (terr.tile(tx, ty).kind === 'forest' ? 0.2 : 0) + (terr.tile(tx, ty).kind === 'hills' ? 0.3 : 0);
    if (!best || r > best.r) best = { tx, ty, r };
  }
  return best;
}
function claimFor(e, kind) {
  const def = BUILDINGS[kind];
  let best = null;
  for (const [tx, ty] of myTiles(e)) for (const [dx, dy] of NEIGHBOURS4) {
    const x = tx + dx, y = ty + dy;
    if (claimCheck(ctx(), x, y, e.id).problem) continue;
    if (!siteOk(def, terr.tile(x, y).kind, terr.coastal(x, y))) continue;
    const r = def.rich ? terr.rich(x, y, def.rich) : 1;
    if (!best || r > best.r) best = { tx: x, ty: y, r };
  }
  return best && tryAct('claim', e, best) ? best : null;
}
function build(e, kind) {
  const def = BUILDINGS[kind];
  if ((def.tier || 0) > e.tier || e.cash < def.cost + 200) return false;
  if (!Object.entries(def.mats || {}).every(([g, q]) => (e.stock[g] || 0) >= q)) { want(e, def.mats); return false; }
  let site = freeSite(e, kind);
  if (!site && e.cash > def.cost + claimCost(e.extra) + 200) site = claimFor(e, kind);
  return !!(site && tryAct('build', e, { kind, tx: site.tx, ty: site.ty }));
}
const shopping = new Map();
function want(e, goods) { const m = shopping.get(e.id) || {}; for (const [g, q] of Object.entries(goods || {})) m[g] = Math.max(m[g] || 0, q + 5); shopping.set(e.id, m); }

const MAKER = { grain: 'farm', wool: 'pasture', fish: 'fishery', salt: 'saltworks', timber: 'lumber', stone: 'quarry', iron: 'mine', cloth: 'weaver', ale: 'brewery', tools: 'smithy' };
function bestTown(e, good, op) {
  let best = null;
  for (const t of w.towns) {
    const h = homeFor(w, e, t.id);
    if (!h || h.rt.hours > 6) continue;
    const q = quote(w, t, good, 20, op);
    if (q.n < 5) continue;
    const unit = q.total / q.n;
    if (!best || (op === 'buy' ? unit < best.unit : unit > best.unit)) best = { t, unit };
  }
  return best;
}

function checkIn(e) {
  shopping.set(e.id, {});
  let ec = empireEconomy(w, e);
  const next = TIERS[e.tier + 1];
  let saving = 0;
  if (next && e.pop >= next.min) { if (!tryAct('charter', e, {})) { want(e, next.charter.goods); saving = next.charter.cash; } }
  for (let n = 0; n < 6; n++) {
    ec = empireEconomy(w, e);
    const net = (g) => ec.prod[g] - ec.use[g] - ec.cons[g];
    // 1. whatever people need and we are short of
    const needs = ec.staff < 0.98 ? [] : Object.keys(tierNeeds(e.tier)).filter((g) => net(g) < 0.2 && MAKER[g]).sort((p, q) => net(p) - net(q));
    let did = false;
    for (const g of needs) {
      const def = BUILDINGS[MAKER[g]];
      if (def.recipe) {
        const lacking = Object.entries(def.recipe.in).find(([i, q]) => net(i) < def.rate * q - 0.5 && (e.stock[i] || 0) < 150);
        // make the input at home if the land allows, otherwise import it and build the workshop anyway
        if (lacking) { if (build(e, MAKER[lacking[0]])) { did = true; break; } if (freeSite(e, MAKER[lacking[0]]) || ec.use[lacking[0]] > 0) continue; want(e, { [lacking[0]]: 40 }); }
      }
      if (build(e, MAKER[g])) { did = true; break; }
    }
    if (did) continue;
    // 2. homes, when there is work to do or the houses are full
    if (ec.staff < 0.98 || (e.pop > ec.housing * 0.92 && ec.housing < (TIERS[e.tier].cap || 1e9))) {
      const h = w.buildings.find((b) => b.owner === e.id && b.type === 'house' && b.level < maxLevel('house', e.tier));
      const uc = h && upgradeCost('house', h.level);
      if (h && e.cash > uc.cash + 100) { if (tryAct('upgrade', e, { building: h.id })) continue; want(e, uc.mats); }
      if (build(e, 'house')) continue;
    }
    // 3. storage, then something to export
    if (GOOD_IDS.some((g) => (e.stock[g] || 0) > ec.cap * 0.95) && e.cash > 2500 + saving && build(e, 'warehouse')) continue;
    if (e.cash > 3000 + saving && ec.staff >= 0.98 && ec.workers > ec.jobs + 20) {
      const k = ['lumber', 'quarry', 'fishery', 'saltworks', 'farm', 'pasture'].find((x) => freeSite(e, x));
      if (k && build(e, k)) continue;
    }
    break;
  }
  if (e.cash > 4000 + saving && e.caravans < 3 + e.tier * 3) tryAct('buyCaravan', e, {});
  // trade: cover shortfalls, fetch materials, sell gluts
  ec = empireEconomy(w, e);
  const list = shopping.get(e.id);
  for (const g of GOOD_IDS) {
    const net = ec.prod[g] - ec.use[g] - ec.cons[g];
    const need = Math.max(net < 0 ? -net * 24 : 0, list[g] || 0);
    if (need > (e.stock[g] || 0) && idleCaravans(w, e) > 0 && e.cash > 300) {
      const b = bestTown(e, g, 'buy');
      if (b && b.unit < GOODS[g].base * (list[g] ? 3.6 : 2.5)) tryAct('marketBuy', e, { town: b.t.id, good: g, qty: Math.min(CARAVAN.capacity, Math.ceil(need - (e.stock[g] || 0))) });
    }
  }
  for (const g of GOOD_IDS) {
    const net = ec.prod[g] - ec.use[g] - ec.cons[g];
    const keep = Math.max(40, (list[g] || 0), ec.cons[g] * 24 + ec.use[g] * 12);
    const spare = Math.floor((e.stock[g] || 0) - keep);
    if (spare >= 20 && net > 0 && idleCaravans(w, e) > 0) {
      const b = bestTown(e, g, 'sell');
      if (b && b.unit > GOODS[g].base * 0.5) tryAct('marketSell', e, { town: b.t.id, good: g, qty: Math.min(spare, CARAVAN.capacity) });
    }
  }
}

const row = (e) => {
  const ec = empireEconomy(w, e);
  const bl = w.buildings.filter((b) => b.owner === e.id);
  return `${e.name.padEnd(7)} ${TIERS[e.tier].name.padEnd(11)} pop ${String(Math.round(e.pop)).padStart(5)}/${String(ec.housing).padEnd(5)} sat ${e.sat.toFixed(2)} cash ${String(Math.round(e.cash)).padStart(7)} tax ${ec.tax.toFixed(0).padStart(4)}/h up ${ec.upkeep.toFixed(0).padStart(3)}/h worth ${String(Math.round(netWorth(w, e))).padStart(7)} bld ${String(bl.length).padStart(3)} land ${String(e.land).padStart(3)} car ${e.caravans} sold ${Math.round(e.stats.revenue || 0)} bought ${Math.round(e.stats.spent || 0)}`;
};
for (let h = 0; h < DAYS * 24; h += EVERY) {
  for (const e of Object.values(w.empires)) checkIn(e);
  clock += EVERY * 3600e3; advance(w, clock);
  if ((h + EVERY) % 24 === 0) { console.log(`--- day ${(h + EVERY) / 24}`); for (const e of Object.values(w.empires)) console.log(row(e)); }
}
const e = w.empires.u1, ec = empireEconomy(w, e);
console.log('\n' + e.name, 'stock', GOOD_IDS.map((g) => `${g} ${Math.round(e.stock[g] || 0)} (${(ec.prod[g] - ec.use[g] - ec.cons[g]).toFixed(1)}/h)`).join(', '));
console.log('fill', JSON.stringify(e.fill), 'cap', ec.cap, 'staff', ec.staff.toFixed(2));
const kinds = {}; for (const b of w.buildings.filter((b) => b.owner === e.id)) kinds[b.type + (b.level > 1 ? b.level : '')] = (kinds[b.type + (b.level > 1 ? b.level : '')] || 0) + 1;
console.log('buildings', JSON.stringify(kinds));
console.log('towns', w.towns.map((t) => `${t.name} ${Math.round(t.pop)}`).join(', '));
if (process.env.DEBUG_GOOD) {
  const g = process.env.DEBUG_GOOD;
  for (const t of w.towns) { const h = homeFor(w, e, t.id); const q = quote(w, t, g, 20, 'buy'); console.log(t.name.padEnd(12), 'res', t.resources.map((r) => r.good).join('/').padEnd(22), g, 'stock', t.stock[g].toFixed(0).padStart(4), 'quote20', q.n, (q.total / (q.n || 1)).toFixed(1), 'hours', h.rt.hours.toFixed(1)); }
  console.log(e.log.slice(0, 12).map((x) => x.text).join('\n'));
}
if (process.env.OUT) { fs.writeFileSync(process.env.OUT, JSON.stringify(w)); console.log('wrote', process.env.OUT); }
