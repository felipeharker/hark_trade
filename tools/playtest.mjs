// Headless check: a company sets up a salt-style arbitrage route and the world runs two days.
import { generateWorld } from '../server/world.js';
import { advance, initStocks, prices, townEconomy } from '../server/sim.js';
import { ACTIONS, createCompany } from '../server/actions.js';
import { GOOD_IDS, dist } from '../shared/data.js';
const w = generateWorld(4242);
initStocks(w);
const t0 = w.lastTick;
advance(w, t0 + 6 * 3600e3);
const known = w.towns.filter((t) => t.known);
// find the best simple pair within 200 leagues
let best = null;
for (const a of known) for (const b of known) {
  if (a === b || dist(a, b) > 200) continue;
  const pa = prices(w, a), pb = prices(w, b);
  for (const g of GOOD_IDS) {
    if (a.stock[g] < 20) continue;
    const m = pb[g].sell - pa[g].buy;
    if (!best || m > best.m) best = { a, b, g, m };
  }
}
console.log('best pair', best.a.name, '->', best.b.name, best.g, 'margin', best.m.toFixed(1), 'dist', dist(best.a, best.b).toFixed(0));
createCompany(w, 'u1', { name: 'Test Co', color: '#d0453b', home: best.a.id });
const co = w.companies.u1;
const car = w.caravans[0];
ACTIONS.build(w, co, { kind: 'warehouse', town: best.a.id });
co.cash += 5000; ACTIONS.build(w, co, { kind: 'estate', town: best.a.id, good: best.a.resources[0].good });
ACTIONS.setRoute(w, co, { caravan: car.id, stops: [
  { town: best.a.id, orders: [{ op: 'buy', good: best.g, qty: 0, limit: 0 }] },
  { town: best.b.id, orders: [{ op: 'sell', good: best.g, qty: 0, limit: 0 }] },
] });
console.log('cash after setup', co.cash.toFixed(0));
const now = w.lastTick;
for (let h = 6; h <= 48; h += 6) {
  advance(w, now + h * 3600e3);
  console.log(`+${h}h cash ${co.cash.toFixed(0)} trips ${co.stats.trips || 0} wh ${JSON.stringify(Object.fromEntries(Object.entries(w.buildings[0].stock).map(([k, v]) => [k, Math.round(v)])))}`);
}
console.log(co.log.slice(0, 5).map((l) => l.text));
console.log(w.news.slice(0, 5).map((n) => n.text));
co.cash += 5000;
const r = ACTIONS.buildRoad(w, co, { a: best.a.id, b: best.b.id });
console.log(r, ACTIONS.expedition(w, co, { from: best.b.id, name: 'Feliport' }));
