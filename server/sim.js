// The living world: towns produce and consume, prices move, caravans travel, events happen.
// Everything advances by real elapsed time, so the world keeps going while nobody is looking.
import {
  GOODS, GOOD_IDS, TIERS, VEHICLES, BUILDINGS, ROAD, SPREAD,
  tierIndex, townNeeds, midPrice, dist, roadKey,
} from '../shared/data.js';
import { nearestHidden } from './world.js';

const HOUR = 3600e3;
const NEED_WEIGHT = { grain: 2, fish: 1.2 };

export function townById(world, id) { return world.towns.find((t) => t.id === id); }
export function companyOf(world, id) { return world.companies[id]; }

export function news(world, text, kind = 'world', at = Date.now()) {
  world.news.unshift({ t: at, text, kind });
  if (world.news.length > 400) world.news.length = 400;
}

export function companyLog(co, text, at = Date.now()) {
  co.log.unshift({ t: at, text });
  if (co.log.length > 150) co.log.length = 150;
}

export function fmtMoney(n) { return 'ƒ' + Math.round(n).toLocaleString('en-US'); }

function activeEvents(world, town) {
  return world.events.filter((e) => {
    if (e.town === town.id) return true;
    if (!e.radius) return false;
    const c = townById(world, e.town);
    return c && dist(c, town) <= e.radius;
  });
}

function mods(world, town) {
  const prod = {}, need = {};
  let growth = 0;
  for (const e of activeEvents(world, town)) {
    for (const [g, m] of Object.entries(e.prod || {})) prod[g] = (prod[g] ?? 1) * m;
    for (const [g, m] of Object.entries(e.need || {})) need[g] = (need[g] ?? 1) * m;
    growth += e.growth || 0;
  }
  return { prod, need, growth };
}

// Per-hour production and consumption, plus the stock level a town considers "normal".
export function townEconomy(world, town) {
  const m = mods(world, town);
  const k = town.pop / 1000;
  const needs = townNeeds(town.pop);
  const cons = {}, prod = {}, target = {};
  for (const g of GOOD_IDS) {
    cons[g] = (needs[g] || 0) * k * (m.need[g] ?? 1);
    prod[g] = 0;
  }
  for (const r of town.resources) prod[r.good] += (2 + k * 5) * r.rich * (m.prod[r.good] ?? 1);
  // small cottage crafts so made goods are never entirely absent
  if (town.resources.some((r) => r.good === 'wool')) prod.cloth += 0.25 + k * 0.4;
  if (town.resources.some((r) => r.good === 'grain')) prod.ale += 0.25 + k * 0.4;
  for (const g of GOOD_IDS) target[g] = cons[g] > 0 ? cons[g] * 16 + 3 : 3 + town.pop / 400;
  return { cons, prod, target, needs, mods: m };
}

export function prices(world, town, econ = townEconomy(world, town)) {
  const out = {};
  for (const g of GOOD_IDS) {
    const mid = midPrice(g, town.stock[g], econ.target[g]);
    out[g] = { mid, buy: mid * (1 + SPREAD), sell: mid * (1 - SPREAD) };
  }
  return out;
}

function recordVolume(world, good, companyId, units) {
  world.tradeLog[good] ||= {};
  world.tradeLog[good][companyId] = (world.tradeLog[good][companyId] || 0) + units;
}

export function cargoCount(c) { return Object.values(c.cargo).reduce((a, b) => a + b, 0); }
export function warehouseOf(world, owner, townId) {
  return world.buildings.find((b) => b.type === 'warehouse' && b.owner === owner && b.town === townId);
}
export function warehouseCap(w) { return BUILDINGS.warehouse.capacity * (w.level || 1); }
export function storeCount(w) { return Object.values(w.stock).reduce((a, b) => a + b, 0); }

// Buy units one at a time so a big order walks the price up.
export function buyGoods(world, co, carrier, town, good, qty, maxPrice, space) {
  const econ = townEconomy(world, town);
  let bought = 0, spent = 0;
  while (bought < qty && bought < space) {
    if (town.stock[good] < 1) break;
    const p = midPrice(good, town.stock[good], econ.target[good]) * (1 + SPREAD);
    if (maxPrice && p > maxPrice) break;
    if (co.cash < p) break;
    co.cash -= p; spent += p; town.stock[good] -= 1; bought++;
    carrier[good] = (carrier[good] || 0) + 1;
  }
  if (bought) recordVolume(world, good, co.id, bought);
  return { bought, spent };
}

export function sellGoods(world, co, carrier, town, good, qty, minPrice) {
  const econ = townEconomy(world, town);
  let sold = 0, earned = 0;
  const have = Math.floor(carrier[good] || 0);
  while (sold < qty && sold < have) {
    const p = midPrice(good, town.stock[good], econ.target[good]) * (1 - SPREAD);
    if (minPrice && p < minPrice) break;
    co.cash += p; earned += p; town.stock[good] += 1; sold++;
    carrier[good] -= 1;
  }
  if (carrier[good] <= 0) delete carrier[good];
  if (sold) {
    recordVolume(world, good, co.id, sold);
    co.stats.revenue = (co.stats.revenue || 0) + earned;
  }
  return { sold, earned };
}

export function roadBetween(world, a, b) {
  const k = roadKey(a, b);
  return world.roads.find((r) => r.key === k);
}

export function travelInfo(world, c, fromId, toId) {
  const a = townById(world, fromId), b = townById(world, toId);
  const v = VEHICLES[c.type];
  const road = roadBetween(world, fromId, toId);
  const speed = v.speed * (road ? ROAD.speedMult : 1);
  const hours = dist(a, b) / speed;
  const toll = road && road.owner !== c.owner ? road.toll : 0;
  return { hours, road, toll, dist: dist(a, b) };
}

export function depart(world, c, toId, now) {
  const co = world.companies[c.owner];
  const info = travelInfo(world, c, c.at, toId);
  if (info.toll) {
    const owner = world.companies[info.road.owner];
    co.cash -= info.toll;
    if (owner) {
      owner.cash += info.toll;
      owner.stats.tolls = (owner.stats.tolls || 0) + info.toll;
    }
  }
  c.from = c.at; c.to = toId; c.at = null;
  c.departAt = now; c.arriveAt = now + info.hours * HOUR;
  c.viaRoad = !!info.road;
}

function runOrders(world, c, town, orders, at) {
  const co = world.companies[c.owner];
  const cap = VEHICLES[c.type].capacity;
  const lines = [];
  for (const o of orders || []) {
    const qtyAll = !o.qty || o.qty <= 0;
    if (o.op === 'sell') {
      const r = sellGoods(world, co, c.cargo, town, o.good, qtyAll ? Infinity : o.qty, o.limit || 0);
      if (r.sold) lines.push(`sold ${r.sold} ${GOODS[o.good].name.toLowerCase()} for ${fmtMoney(r.earned)}`);
    } else if (o.op === 'buy') {
      const space = cap - cargoCount(c);
      const r = buyGoods(world, co, c.cargo, town, o.good, qtyAll ? Infinity : o.qty, o.limit || 0, space);
      if (r.bought) lines.push(`bought ${r.bought} ${GOODS[o.good].name.toLowerCase()} for ${fmtMoney(r.spent)}`);
    } else if (o.op === 'load' || o.op === 'unload') {
      const w = warehouseOf(world, c.owner, town.id);
      if (!w) continue;
      if (o.op === 'load') {
        const space = cap - cargoCount(c);
        const n = Math.min(Math.floor(w.stock[o.good] || 0), space, qtyAll ? Infinity : o.qty);
        if (n > 0) { w.stock[o.good] -= n; c.cargo[o.good] = (c.cargo[o.good] || 0) + n; lines.push(`loaded ${n} ${o.good}`); }
      } else {
        const space = warehouseCap(w) - storeCount(w);
        const n = Math.min(Math.floor(c.cargo[o.good] || 0), space, qtyAll ? Infinity : o.qty);
        if (n > 0) { c.cargo[o.good] -= n; if (c.cargo[o.good] <= 0) delete c.cargo[o.good]; w.stock[o.good] = (w.stock[o.good] || 0) + n; lines.push(`unloaded ${n} ${o.good}`); }
      }
    }
  }
  if (lines.length) companyLog(co, `${c.name} at ${town.name}: ${lines.join(', ')}.`, at);
}

// Called when a caravan with a route is at a town and ready for its next leg.
export function advanceRoute(world, c, now) {
  const r = c.route;
  if (!r || !r.stops.length) return;
  let guard = 0;
  while (guard++ < r.stops.length + 1) {
    const stop = r.stops[r.idx % r.stops.length];
    if (stop.town === c.at) {
      runOrders(world, c, townById(world, c.at), stop.orders, now);
      r.idx = (r.idx + 1) % r.stops.length;
      continue;
    }
    depart(world, c, stop.town, now);
    return;
  }
}

function arrive(world, c, at) {
  const town = townById(world, c.to);
  c.at = c.to; c.from = null; c.to = null;
  const co = world.companies[c.owner];
  co.stats.trips = (co.stats.trips || 0) + 1;
  // Bandits hit caravans that travel off-road through their territory.
  if (!c.viaRoad) {
    const band = activeEvents(world, town).find((e) => e.type === 'bandits');
    if (band && cargoCount(c) > 0) {
      const lost = [];
      for (const g of Object.keys(c.cargo)) {
        const n = Math.floor(c.cargo[g] * 0.25);
        if (n > 0) { c.cargo[g] -= n; lost.push(`${n} ${g}`); }
      }
      if (lost.length) companyLog(co, `Bandits robbed ${c.name} on the way to ${town.name}: lost ${lost.join(', ')}. Roads are safe from them.`, at);
    }
  }
  if (c.route) advanceRoute(world, c, at);
}

function maybeEvent(world, dtH, now) {
  const known = world.towns.filter((t) => t.known);
  if (!known.length) return;
  if (Math.random() > dtH / 3.5) return;
  const t = known[Math.floor(Math.random() * known.length)];
  const roll = Math.random();
  const has = (g) => t.resources.some((r) => r.good === g);
  let e = null;
  if (roll < 0.14) e = { type: 'drought', radius: 230, hours: 18, prod: { grain: 0.3, wool: 0.5 }, text: `Drought around ${t.name}. Grain and wool harvests are failing.` };
  else if (roll < 0.27) e = { type: 'harvest', radius: 200, hours: 12, prod: { grain: 2.2 }, text: `Bumper harvest around ${t.name}. Grain is plentiful.` };
  else if (roll < 0.38 && t.coastal) e = { type: 'shoal', hours: 12, prod: { fish: 2.5 }, text: `Huge shoals off ${t.name}. Fish is cheap.` };
  else if (roll < 0.5) e = { type: 'festival', hours: 10, need: { ale: 3, spices: 3, cloth: 1.5 }, text: `${t.name} holds a festival. Ale, cloth and spices are in demand.` };
  else if (roll < 0.61) e = { type: 'bandits', radius: 190, hours: 10, text: `Bandits on the trails around ${t.name}. Caravans off the roads risk losing cargo.` };
  else if (roll < 0.69 && has('iron')) e = { type: 'mine', hours: 24, prod: { iron: 0 }, text: `The mine at ${t.name} has collapsed. No iron for a day.` };
  else if (roll < 0.79) {
    e = { type: 'fire', hours: 24, need: { timber: 3, stone: 3 }, text: `Fire in ${t.name}. The town needs timber and stone to rebuild.` };
    for (const g of ['timber', 'cloth', 'grain']) t.stock[g] *= 0.6;
  } else if (roll < 0.9) e = { type: 'boom', hours: 24, growth: 0.004, need: { tools: 2 }, text: `A boom in ${t.name}. Settlers are pouring in and want tools.` };
  else if (roll < 0.95 && t.pop > 500) {
    t.pop *= 0.92;
    news(world, `Sickness in ${t.name}. The town has lost people.`, 'event', now);
    return;
  }
  if (!e) return;
  if (world.events.some((x) => x.town === t.id && x.type === e.type)) return;
  world.events.push({ id: 'e' + world.nextId++, town: t.id, type: e.type, radius: e.radius || 0, until: now + e.hours * HOUR, prod: e.prod, need: e.need, growth: e.growth, text: e.text });
  news(world, e.text, 'event', now);
}

function peddlers(world, dtH) {
  // NPC hawkers smooth out the worst gaps between neighbouring towns, slowly.
  const known = world.towns.filter((t) => t.known);
  const econs = known.map((t) => townEconomy(world, t));
  for (let i = 0; i < known.length; i++) {
    const a = known[i];
    const ea = econs[i];
    for (let j = i + 1; j < known.length; j++) {
      const b = known[j];
      if (dist(a, b) > 190) continue;
      const eb = econs[j];
      for (const g of GOOD_IDS) {
        const pa = midPrice(g, a.stock[g], ea.target[g]);
        const pb = midPrice(g, b.stock[g], eb.target[g]);
        const [src, dst] = pa < pb * 0.65 ? [a, b] : pb < pa * 0.65 ? [b, a] : [null, null];
        if (!src) continue;
        const q = Math.min(src.stock[g] * 0.015 * dtH, 1.5 * dtH);
        src.stock[g] -= q; dst.stock[g] += q;
      }
    }
  }
}

function stepTowns(world, dtH, now) {
  const roadCount = {};
  for (const r of world.roads) { roadCount[r.a] = (roadCount[r.a] || 0) + 1; roadCount[r.b] = (roadCount[r.b] || 0) + 1; }
  const bCount = {};
  for (const b of world.buildings) bCount[b.town] = (bCount[b.town] || 0) + 1;
  for (const t of world.towns) {
    if (!t.known) continue;
    const econ = townEconomy(world, t);
    let wsum = 0, fsum = 0;
    for (const g of GOOD_IDS) {
      const p = econ.prod[g] * dtH;
      const cap = Math.max(econ.target[g] * 3, econ.prod[g] * 36);
      if (t.stock[g] < cap) t.stock[g] = Math.min(cap, t.stock[g] + p);
      else t.stock[g] *= Math.pow(0.98, dtH); // spoilage of gluts
      const need = econ.cons[g] * dtH;
      if (need > 0) {
        const got = Math.min(need, t.stock[g]);
        t.stock[g] -= got;
        const w = NEED_WEIGHT[g] || 1;
        wsum += w; fsum += w * (got / need);
      }
    }
    const fill = wsum ? fsum / wsum : 1;
    t.sat += (fill - t.sat) * Math.min(1, dtH / 6);
    const before = tierIndex(t.pop);
    const g = 0.004 * (t.sat - 0.55) + 0.00025 * Math.min(4, roadCount[t.id] || 0) + 0.0002 * Math.min(6, bCount[t.id] || 0) + econ.mods.growth;
    t.pop = Math.max(80, t.pop * (1 + g * dtH));
    const after = tierIndex(t.pop);
    if (after > before) news(world, `${t.name} has grown into a ${TIERS[after].name.toLowerCase()}. It now wants ${Object.keys(TIERS[after].needs).join(', ') || 'more of everything'}.`, 'growth', now);
    else if (after < before) news(world, `${t.name} has dwindled to a ${TIERS[after].name.toLowerCase()}.`, 'decline', now);
  }
}

function stepBuildings(world, dtH) {
  for (const b of world.buildings) {
    const co = world.companies[b.owner];
    if (!co) continue;
    const def = BUILDINGS[b.type];
    co.cash -= def.upkeep * dtH;
    if (b.type === 'warehouse') continue;
    const w = warehouseOf(world, b.owner, b.town);
    if (!w) continue;
    const town = townById(world, b.town);
    let space = warehouseCap(w) - storeCount(w);
    if (space <= 0) continue;
    if (b.type === 'estate') {
      const res = town.resources.find((r) => r.good === b.good);
      const m = mods(world, town).prod[b.good] ?? 1;
      const n = Math.min(space, def.rate * (res ? res.rich : 1) * m * dtH);
      w.stock[b.good] = (w.stock[b.good] || 0) + n;
    } else {
      const rec = def.recipe;
      let n = def.rate * dtH;
      for (const [g, q] of Object.entries(rec.in)) n = Math.min(n, (w.stock[g] || 0) / q);
      n = Math.min(n, space);
      if (n <= 0) { b.idle = true; continue; }
      b.idle = false;
      for (const [g, q] of Object.entries(rec.in)) w.stock[g] -= n * q;
      w.stock[rec.out] = (w.stock[rec.out] || 0) + n;
    }
  }
  for (const r of world.roads) {
    const co = world.companies[r.owner];
    if (co) co.cash -= ROAD.upkeepPerUnit * r.length * dtH;
  }
}

export function netWorth(world, co) {
  let v = co.cash;
  for (const c of world.caravans) if (c.owner === co.id) {
    v += VEHICLES[c.type].cost * 0.6;
    for (const [g, q] of Object.entries(c.cargo)) v += GOODS[g].base * q;
  }
  for (const b of world.buildings) if (b.owner === co.id) {
    v += BUILDINGS[b.type].cost * 0.6 * (b.level || 1);
    if (b.stock) for (const [g, q] of Object.entries(b.stock)) v += GOODS[g].base * q;
  }
  for (const r of world.roads) if (r.owner === co.id) v += r.cost * 0.5;
  return v;
}

const MILESTONES = [10000, 25000, 50000, 100000, 250000, 500000, 1000000];

function hourly(world, now) {
  for (const t of world.towns) {
    if (!t.known) continue;
    const p = prices(world, t);
    for (const g of GOOD_IDS) {
      const h = (t.priceHist[g] ||= []);
      h.push(+p[g].mid.toFixed(2));
      if (h.length > 48) h.shift();
    }
    t.popHist.push(Math.round(t.pop));
    if (t.popHist.length > 168) t.popHist.shift();
  }
  for (const co of Object.values(world.companies)) {
    const nw = netWorth(world, co);
    co.worthHist.push(Math.round(nw));
    if (co.worthHist.length > 168) co.worthHist.shift();
    for (const m of MILESTONES) {
      if (nw >= m && !co.milestones.includes(m)) {
        co.milestones.push(m);
        news(world, `${co.name} is now worth over ${fmtMoney(m)}.`, 'company', now);
      }
    }
  }
  // Who controls which trade (share of the last day's volume).
  for (const g of GOOD_IDS) {
    const vols = world.tradeLog[g] || {};
    const total = Object.values(vols).reduce((a, b) => a + b, 0);
    let top = null, topV = 0;
    for (const [id, v] of Object.entries(vols)) if (v > topV) { top = id; topV = v; }
    const share = total ? topV / total : 0;
    const holder = world.monopolies[g];
    if (top && total > 120 && share > 0.5 && holder !== top && world.companies[top]) {
      world.monopolies[g] = top;
      news(world, `${world.companies[top].name} now controls the ${GOODS[g].name.toLowerCase()} trade (${Math.round(share * 100)}% of the last day).`, 'company', now);
    } else if (holder && (holder !== top || share < 0.35)) {
      delete world.monopolies[g];
      if (world.companies[holder]) news(world, `${world.companies[holder].name}'s grip on ${GOODS[g].name.toLowerCase()} has slipped.`, 'company', now);
    }
  }
  // The frontier opens as the known world grows.
  const known = world.towns.filter((t) => t.known);
  const pop = known.reduce((a, t) => a + t.pop, 0);
  const threshold = 7000 + world.revealThreshold * 2500;
  if (pop > threshold) {
    const cx = known.reduce((a, t) => a + t.x, 0) / known.length;
    const cy = known.reduce((a, t) => a + t.y, 0) / known.length;
    const h = nearestHidden(world, { x: cx, y: cy });
    if (h) {
      revealTown(world, h);
      world.revealThreshold++;
      news(world, `Travellers bring word of ${h.name}, a ${TIERS[tierIndex(h.pop)].name.toLowerCase()} beyond the known roads. It trades in ${h.resources.map((r) => r.good).join(', ')}.`, 'frontier', now);
    }
  }
}

export function revealTown(world, t) {
  t.known = true;
  const econ = townEconomy(world, t);
  for (const g of GOOD_IDS) t.stock[g] = econ.prod[g] > 0 ? econ.target[g] * 2 : econ.target[g] * 0.5;
}

function decayTradeLog(world, dtH) {
  const f = Math.exp(-dtH / 24);
  for (const g of Object.keys(world.tradeLog)) for (const id of Object.keys(world.tradeLog[g])) {
    world.tradeLog[g][id] *= f;
    if (world.tradeLog[g][id] < 0.5) delete world.tradeLog[g][id];
  }
}

// Advance the world from world.lastTick to `until`, in slices of at most 15 minutes.
export function advance(world, until = Date.now()) {
  const MAX = 0.25 * HOUR;
  let steps = 0;
  while (world.lastTick < until && steps < 20000) {
    const now = Math.min(until, world.lastTick + MAX);
    const dtH = (now - world.lastTick) / HOUR;
    // caravans that arrive inside this slice, in time order
    let due;
    while ((due = world.caravans.filter((c) => c.to && c.arriveAt <= now).sort((a, b) => a.arriveAt - b.arriveAt)[0])) {
      arrive(world, due, due.arriveAt);
    }
    for (const c of world.caravans) {
      const co = world.companies[c.owner];
      if (co) co.cash -= VEHICLES[c.type].upkeep * dtH;
    }
    stepTowns(world, dtH, now);
    peddlers(world, dtH);
    stepBuildings(world, dtH);
    decayTradeLog(world, dtH);
    world.events = world.events.filter((e) => e.until > now);
    maybeEvent(world, dtH, now);
    const prevH = Math.floor(world.clockHours);
    world.clockHours += dtH;
    world.lastTick = now;
    if (Math.floor(world.clockHours) > prevH) hourly(world, now);
    steps++;
  }
  return steps;
}

export function initStocks(world) {
  for (const t of world.towns) if (t.known) revealTown(world, t);
}
