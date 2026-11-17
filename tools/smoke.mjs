// Quick end-to-end check of the rules without a server: found two empires, build, trade, deal.
import { generateWorld } from '../server/world.js';
import { advance, initStocks, terrainOf, empireEconomy, netWorth, idleCaravans } from '../server/sim.js';
import { ACTIONS, createEmpire } from '../server/actions.js';
import { EXCHANGE } from '../server/exchange.js';
import { settleProblem } from '../shared/rules.js';
import { tileKey, TILES_W, TILES_H } from '../shared/terrain.js';
import { BUILDINGS, siteOk } from '../shared/data.js';

const A = { ...ACTIONS, ...EXCHANGE };
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const w = generateWorld(Number(process.argv[2]) || undefined);
initStocks(w);
const ctx = () => ({ terrain: terrainOf(w), towns: w.towns, settlements: w.settlements, tileAt: (x, y) => w.tiles[tileKey(x, y)] });
function findSite() {
  for (let i = 0; i < 5000; i++) {
    const tx = 3 + Math.floor(Math.random() * (TILES_W - 6)), ty = 3 + Math.floor(Math.random() * (TILES_H - 6));
    if (!settleProblem(ctx(), tx, ty, true, null)) return [tx, ty];
  }
  throw new Error('no site');
}
for (const [id, name] of [['u1', 'Alder'], ['u2', 'Birch']]) { const [tx, ty] = findSite(); createEmpire(w, id, { name, tx, ty }); }
const [a, b] = [w.empires.u1, w.empires.u2];
const terr = terrainOf(w);
function buildAny(e, kind) {
  const def = BUILDINGS[kind];
  for (const [k, t] of Object.entries(w.tiles)) {
    if (t.o !== e.id) continue;
    const [tx, ty] = k.split(',').map(Number);
    if (w.buildings.some((x) => x.tx === tx && x.ty === ty)) continue;
    if (!siteOk(def, terr.tile(tx, ty).kind, terr.coastal(tx, ty))) continue;
    try { A.build(w, e, { kind, tx, ty }); return true; } catch (err) { console.log('  build', kind, 'failed:', err.message); return false; }
  }
  console.log('  no site for', kind); return false;
}
for (const e of [a, b]) { for (const k of ['house', 'house', 'farm', 'lumber', 'house']) buildAny(e, k); }
const step = (h) => { clock += h * 3600e3; advance(w, clock); };
step(6);
for (const e of [a, b]) { const ec = empireEconomy(w, e); console.log(e.name, 'pop', e.pop.toFixed(0), 'sat', e.sat.toFixed(2), 'cash', e.cash.toFixed(0), 'tax/h', ec.tax.toFixed(1), 'upkeep/h', ec.upkeep.toFixed(1), 'staff', ec.staff.toFixed(2)); }
console.log(A.marketSell(w, a, { town: w.towns[0].id, good: 'timber', qty: 30 }).msg, '| idle', idleCaravans(w, a));
console.log(A.marketBuy(w, a, { town: w.towns[0].id, good: 'fish', qty: 10 }).msg, '| idle', idleCaravans(w, a));
console.log(A.list(w, a, { offer: { grain: 20, timber: 5 }, ask: { cash: 150 } }).msg);
const l = w.listings[0];
console.log(A.bid(w, b, { listing: l.id, pay: { cash: 60, goods: { stone: 10 } } }).msg, 'b cash', b.cash.toFixed(0), 'stone', b.stock.stone);
console.log(A.acceptBid(w, a, { listing: l.id, bid: l.bids[0].id }).msg, 'a cash', a.cash.toFixed(0));
console.log('trips', w.trips.map((t) => `${t.kind} ${t.owner} ${JSON.stringify(t.cargo)} ${(t.returnAt - clock) / 3600e3 | 0}h`).join(' | '));
A.list(w, b, { offer: { stone: 5 }, ask: { goods: { grain: 10 } } });
console.log(A.buyListing(w, a, { listing: w.listings[0].id }).msg);
step(30);
console.log('after 30h: trips', w.trips.length, 'a stone', a.stock.stone?.toFixed(1), 'b grain', b.stock.grain?.toFixed(1), 'b timber', b.stock.timber?.toFixed(1));
for (const e of [a, b]) console.log(e.name, 'pop', e.pop.toFixed(0), 'sat', e.sat.toFixed(2), 'cash', e.cash.toFixed(0), 'worth', netWorth(w, e).toFixed(0), 'fill', JSON.stringify(e.fill));
console.log(a.log.slice(0, 6).map((x) => x.text).join('\n'));
console.log(w.news.slice(0, 6).map((x) => x.text).join('\n'));
