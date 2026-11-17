// Runs the world for a while with no players and prints how towns and prices settle.
import { generateWorld } from '../server/world.js';
import { advance, initStocks, prices } from '../server/sim.js';
import { TIERS, tierIndex, GOOD_IDS } from '../shared/data.js';
const days = Number(process.argv[2] || 7);
const w = generateWorld(Number(process.argv[3] || 12345));
initStocks(w);
const t0 = Date.now();
const start = w.lastTick;
const known = () => w.towns.filter((t) => t.known);
console.log('towns', w.towns.length, 'known', known().length);
for (let d = 1; d <= days; d++) {
  advance(w, start + d * 86400e3);
  const k = known();
  const pop = k.reduce((a, t) => a + t.pop, 0);
  const tiers = TIERS.map((T, i) => k.filter((t) => tierIndex(t.pop) === i).length).join('/');
  const sat = (k.reduce((a, t) => a + t.sat, 0) / k.length).toFixed(2);
  console.log(`day ${d}: known ${k.length} pop ${Math.round(pop)} tiers ${tiers} avgSat ${sat} events ${w.events.length}`);
}
for (const g of GOOD_IDS) {
  const ps = known().map((t) => prices(w, t)[g].mid);
  console.log(g.padEnd(7), 'min', Math.min(...ps).toFixed(1), 'max', Math.max(...ps).toFixed(1));
}
console.log('news:', w.news.slice(0, 8).map((n) => n.text));
console.log('ms', Date.now() - t0, 'json KB', Math.round(JSON.stringify(w).length / 1024));
