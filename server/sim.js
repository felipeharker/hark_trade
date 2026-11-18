// The living world: towns and empires produce and consume, prices move, caravans travel, events happen.
// Everything advances by real elapsed time, so the world keeps going while nobody is looking.
import {
  GOODS, GOOD_IDS, TIERS, BUILDINGS, ROAD, SPREAD, CARAVAN, COURIER_SPEED, EMPIRE_NEED_MULT, NEED_WEIGHT, WORKER_SHARE,
  ADJ_BONUS, ADJ_MAX, tierIndex, tierNeeds, townNeeds, midPrice, dist, roadKey, housingOf, storageOf,
} from '../shared/data.js';
import { makeTerrain, tileKey, NEIGHBOURS4 } from '../shared/terrain.js';

const HOUR = 3600e3;

let terrCache = null;
export function terrainOf(world) {
  if (!terrCache || terrCache.seed !== world.seed) terrCache = { seed: world.seed, t: makeTerrain(world.seed) };
  return terrCache.t;
}

export function townById(world, id) { return world.towns.find((t) => t.id === id); }
export function settlementById(world, id) { return world.settlements.find((s) => s.id === id); }
export function placeById(world, id) {
  if (typeof id !== 'string') return null;
  const p = id[0] === 't' ? townById(world, id) : settlementById(world, id);
  return p ? { id: p.id, x: p.x, y: p.y, name: p.name, kind: id[0] === 't' ? 'town' : 'settlement', owner: p.owner } : null;
}
export function capitalOf(world, empireId) { return world.settlements.find((s) => s.owner === empireId && s.capital); }
export const buildingsOf = (world, empireId) => world.buildings.filter((b) => b.owner === empireId);

export function news(world, text, kind = 'world', at = Date.now()) {
  world.news.unshift({ t: at, text, kind });
  if (world.news.length > 400) world.news.length = 400;
}

export function empireLog(e, text, at = Date.now()) {
  e.log.unshift({ t: at, text });
  if (e.log.length > 150) e.log.length = 150;
}

export function fmtMoney(n) { return 'ƒ' + Math.round(n).toLocaleString('en-US'); }
export const lc = (g) => GOODS[g].name.toLowerCase();
export function goodsText(goods) {
  const parts = Object.entries(goods || {}).filter(([, q]) => q > 0).map(([g, q]) => `${Math.round(q)} ${lc(g)}`);
  return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0] || 'nothing';
}

// ---------- events ----------
function eventsAt(world, pos) {
  return world.events.filter((e) => {
    if (e.town === pos.id) return true;
    if (!e.radius) return false;
    const c = townById(world, e.town);
    return c && dist(c, pos) <= e.radius;
  });
}

export function modsAt(world, pos) {
  const prod = {}, need = {};
  let growth = 0;
  for (const e of eventsAt(world, pos)) {
    for (const [g, m] of Object.entries(e.prod || {})) prod[g] = (prod[g] ?? 1) * m;
    for (const [g, m] of Object.entries(e.need || {})) need[g] = (need[g] ?? 1) * m;
    growth += e.growth || 0;
  }
  return { prod, need, growth };
}

// ---------- neutral towns ----------
// Per-hour production and consumption, plus the stock level a town considers "normal".
export function townEconomy(world, town) {
  const m = modsAt(world, town);
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
  if (town.resources.some((r) => r.good === 'iron')) prod.tools += 0.15 + k * 0.25;
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

// Walk a market one unit at a time, so a big order moves the price against you. Nothing changes here.
export function quote(world, town, good, qty, op, limit = 0, cash = Infinity) {
  const target = townEconomy(world, town).target[good];
  let stock = town.stock[good], n = 0, total = 0;
  while (n < qty) {
    if (op === 'buy') {
      if (stock < 1) break;
      const p = midPrice(good, stock, target) * (1 + SPREAD);
      if ((limit && p > limit) || total + p > cash) break;
      total += p; stock -= 1;
    } else {
      const p = midPrice(good, stock, target) * (1 - SPREAD);
      if (limit && p < limit) break;
      total += p; stock += 1;
    }
    n++;
  }
  return { n, total };
}

// ---------- getting from place to place ----------
// Fastest way between two places. Open country is a straight line; roads are quicker and can be chained.
export function route(world, fromId, toId, speed) {
  const ps = [...world.towns, ...world.settlements];
  const s = ps.findIndex((p) => p.id === fromId), target = ps.findIndex((p) => p.id === toId);
  if (s < 0 || target < 0) return null;
  const roadAt = new Map(world.roads.map((r) => [r.key, r]));
  const n = ps.length;
  const time = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), via = new Array(n).fill(null), done = new Array(n).fill(false);
  time[s] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || time[i] < time[u])) u = i;
    if (u < 0 || time[u] === Infinity || u === target) break;
    done[u] = true;
    for (let v = 0; v < n; v++) {
      if (done[v]) continue;
      const road = roadAt.get(roadKey(ps[u].id, ps[v].id));
      // only roads may pass through another place; open country goes straight to the destination
      if (!road && v !== target && u !== s) continue;
      const t = dist(ps[u], ps[v]) / (speed * (road ? ROAD.speedMult : 1));
      if (time[u] + t < time[v] - 1e-9) { time[v] = time[u] + t; prev[v] = u; via[v] = road || null; }
    }
  }
  const order = [];
  for (let v = target; v >= 0; v = prev[v]) order.unshift(v);
  const pts = order.map((i) => [ps[i].x, ps[i].y]);
  const roads = order.slice(1).map((i) => via[i]);
  const total = time[target] || 1e-6;
  const cum = order.map((i) => +(time[i] / total).toFixed(4));
  return {
    hours: time[target], pts, cum, roads: roads.filter(Boolean),
    allRoad: roads.every(Boolean), lastRoad: !!roads[roads.length - 1], dist: dist(ps[s], ps[target]),
  };
}

export function tollsDue(world, rt, payerId) {
  return rt.roads.filter((r) => r.owner !== payerId && r.toll > 0 && world.empires[r.owner]);
}

function payTolls(world, e, rt) {
  let paid = 0;
  for (const r of tollsDue(world, rt, e.id)) {
    const owner = world.empires[r.owner];
    e.cash -= r.toll; paid += r.toll;
    owner.cash += r.toll;
    owner.stats.tolls = (owner.stats.tolls || 0) + r.toll;
  }
  if (paid) e.stats.tollsPaid = (e.stats.tollsPaid || 0) + paid;
  return paid;
}

// ---------- caravans (your trade with the neutral towns) ----------
export function idleCaravans(world, e) {
  let out = 0;
  for (const t of world.trips) if (t.owner === e.id) out += t.caravans || 0;
  return e.caravans - out;
}

// The settlement of yours that is quickest to a town.
export function homeFor(world, e, townId) {
  let best = null;
  for (const s of world.settlements) {
    if (s.owner !== e.id) continue;
    const rt = route(world, s.id, townId, CARAVAN.speed);
    if (rt && (!best || rt.hours < best.rt.hours)) best = { s, rt };
  }
  return best;
}

function startTrip(world, e, kind, home, town, cargo, now) {
  const n = Object.values(cargo).reduce((a, b) => a + b, 0);
  const caravans = Math.max(1, Math.ceil(n / CARAVAN.capacity));
  const toll = payTolls(world, e, home.rt);
  const banditry = !home.rt.lastRoad && eventsAt(world, town).some((ev) => ev.type === 'bandits');
  const trip = {
    id: 'c' + world.nextId++, owner: e.id, kind, from: home.s.id, to: town.id, pts: home.rt.pts, cum: home.rt.cum,
    departAt: now, arriveAt: now + home.rt.hours * HOUR, returnAt: now + 2 * home.rt.hours * HOUR,
    cargo, caravans, toll, risk: kind === 'buy' && banditry,
  };
  world.trips.push(trip);
  e.stats.trips = (e.stats.trips || 0) + 1;
  return trip;
}

// Buy from a town. The price is settled now; the goods come home when the caravans return.
export function marketBuy(world, e, town, good, qty, maxPrice, now, auto = false) {
  const idle = idleCaravans(world, e);
  if (idle < 1) return { n: 0, why: 'All your caravans are out.' };
  const home = homeFor(world, e, town.id);
  if (!home) return { n: 0, why: 'You have no settlement.' };
  const q = quote(world, town, good, Math.min(qty, idle * CARAVAN.capacity), 'buy', maxPrice, Math.max(0, e.cash));
  if (q.n < (auto ? 10 : 1)) return { n: 0, why: town.stock[good] < 1 ? `${town.name} is out of ${lc(good)}.` : maxPrice ? 'The price is above your limit.' : 'Not enough cash.' };
  e.cash -= q.total; town.stock[good] -= q.n;
  e.stats.spent = (e.stats.spent || 0) + q.total;
  const trip = startTrip(world, e, 'buy', home, town, { [good]: q.n }, now);
  empireLog(e, `${auto ? 'Standing order: bought' : 'Bought'} ${q.n} ${lc(good)} in ${town.name} for ${fmtMoney(q.total)}${trip.toll ? ` plus ${fmtMoney(trip.toll)} in tolls` : ''}.`, now);
  return { n: q.n, total: q.total, trip };
}

// Sell to a town. You are paid now, and the caravans are away until they get back.
export function marketSell(world, e, town, good, qty, minPrice, now, auto = false) {
  const idle = idleCaravans(world, e);
  if (idle < 1) return { n: 0, why: 'All your caravans are out.' };
  const home = homeFor(world, e, town.id);
  if (!home) return { n: 0, why: 'You have no settlement.' };
  const have = Math.floor(e.stock[good] || 0);
  const q = quote(world, town, good, Math.min(qty, have, idle * CARAVAN.capacity), 'sell', minPrice);
  if (q.n < (auto ? 10 : 1)) return { n: 0, why: have < 1 ? `You have no ${lc(good)}.` : 'The price is below your limit.' };
  e.stock[good] -= q.n; e.cash += q.total; town.stock[good] += q.n;
  e.stats.revenue = (e.stats.revenue || 0) + q.total;
  const trip = startTrip(world, e, 'sell', home, town, { [good]: q.n }, now);
  empireLog(e, `${auto ? 'Standing order: sold' : 'Sold'} ${q.n} ${lc(good)} in ${town.name} for ${fmtMoney(q.total)}${trip.toll ? `, less ${fmtMoney(trip.toll)} in tolls` : ''}.`, now);
  return { n: q.n, total: q.total, trip };
}

// Exchange deals are delivered by courier between capitals, at no cost beyond any tolls on the way.
export function sendCourier(world, fromId, toId, cargo, now, why = '') {
  const to = world.empires[toId];
  if (!to) return null;
  const a = capitalOf(world, fromId), b = capitalOf(world, toId);
  const rt = a && b ? route(world, a.id, b.id, COURIER_SPEED) : null;
  if (!rt) { addStock(to, cargo); return null; }
  const toll = payTolls(world, to, rt);
  const trip = {
    id: 'c' + world.nextId++, owner: toId, kind: 'courier', from: a.id, to: b.id, pts: rt.pts, cum: rt.cum,
    departAt: now, arriveAt: now + rt.hours * HOUR, returnAt: now + rt.hours * HOUR, cargo: { ...cargo }, caravans: 0, toll, why,
  };
  world.trips.push(trip);
  return trip;
}

export function addStock(e, cargo) {
  for (const [g, q] of Object.entries(cargo)) if (q > 0) e.stock[g] = (e.stock[g] || 0) + q;
}

function finishTrips(world, now) {
  const due = world.trips.filter((t) => t.returnAt <= now).sort((a, b) => a.returnAt - b.returnAt);
  if (!due.length) return;
  for (const t of due) {
    const e = world.empires[t.owner];
    if (!e) continue;
    if (t.kind === 'buy') {
      if (t.risk) {
        const lost = {};
        for (const g of Object.keys(t.cargo)) { const n = Math.floor(t.cargo[g] * 0.25); if (n > 0) { t.cargo[g] -= n; lost[g] = n; } }
        if (Object.keys(lost).length) empireLog(e, `Bandits robbed your caravans on the way back from ${townById(world, t.to)?.name}: lost ${goodsText(lost)}. Roads are safe from them.`, t.returnAt);
      }
      addStock(e, t.cargo);
      empireLog(e, `Caravans are back from ${townById(world, t.to)?.name} with ${goodsText(t.cargo)}.`, t.returnAt);
    } else if (t.kind === 'courier') {
      addStock(e, t.cargo);
      empireLog(e, `A courier delivered ${goodsText(t.cargo)}${t.why ? ` (${t.why})` : ''}.`, t.returnAt);
    }
  }
  const gone = new Set(due);
  world.trips = world.trips.filter((t) => !gone.has(t));
}

// ---------- empires ----------
// Recount how many like neighbours each of an empire's buildings has, and how rich its plot is.
export function refreshBuildings(world, empireId) {
  const terrain = terrainOf(world);
  const mine = buildingsOf(world, empireId);
  const at = new Map(mine.map((b) => [tileKey(b.tx, b.ty), b]));
  for (const b of mine) {
    const def = BUILDINGS[b.type];
    b.rich = def.rich ? terrain.rich(b.tx, b.ty, def.rich) : 1;
    let adj = 0;
    if (def.out) for (const [dx, dy] of NEIGHBOURS4) if (at.get(tileKey(b.tx + dx, b.ty + dy))?.type === b.type) adj++;
    b.adj = adj;
  }
}

export const buildingRate = (b) => {
  const def = BUILDINGS[b.type];
  return (def.rate || 0) * (b.level || 1) * (b.rich || 1) * (1 + ADJ_BONUS * Math.min(ADJ_MAX, b.adj || 0));
};

// What an empire makes, uses and earns per hour right now. `blds` are its buildings.
export function empireEconomy(world, e, blds = buildingsOf(world, e.id)) {
  let housing = 0, cap = 0, jobs = 0, upkeep = 0;
  for (const b of blds) {
    const def = BUILDINGS[b.type];
    housing += housingOf(b);
    cap += storageOf(b);
    upkeep += (def.upkeep || 0) * (b.level || 1) * (b.paused ? 0.25 : 1);
    if (!b.paused) jobs += (def.workers || 0) * (b.level || 1);
  }
  const workers = e.pop * WORKER_SHARE;
  const staff = jobs > 0 ? Math.min(1, workers / jobs) : 1;
  const mods = new Map();
  const modFor = (b) => {
    let m = mods.get(b.s);
    if (!m) { const s = settlementById(world, b.s); m = s ? modsAt(world, s).prod : {}; mods.set(b.s, m); }
    return m;
  };
  const prod = {}, use = {}, cons = {};
  for (const g of GOOD_IDS) { prod[g] = 0; use[g] = 0; cons[g] = 0; }
  const rates = new Map();
  for (const b of blds) {
    const def = BUILDINGS[b.type];
    if (b.paused || !def.rate) continue;
    if (def.out) {
      const r = buildingRate(b) * staff * (modFor(b)[def.out] ?? 1);
      rates.set(b, r); prod[def.out] += r;
    } else if (def.recipe) {
      const r = buildingRate(b) * staff;
      rates.set(b, r); prod[def.recipe.out] += r;
      for (const [g, q] of Object.entries(def.recipe.in)) use[g] += r * q;
    }
  }
  const needs = tierNeeds(e.tier);
  for (const [g, r] of Object.entries(needs)) cons[g] = r * (e.pop / 1000) * EMPIRE_NEED_MULT;
  const caravanUpkeep = e.caravans * CARAVAN.upkeep;
  let roadUpkeep = 0;
  for (const r of world.roads) if (r.owner === e.id) roadUpkeep += ROAD.upkeepPerUnit * r.length;
  const tax = e.pop * TIERS[e.tier].tax * (0.3 + 0.7 * e.sat);
  return { housing, cap, jobs, workers, staff, prod, use, cons, rates, tax, upkeep: upkeep + caravanUpkeep + roadUpkeep, buildingUpkeep: upkeep, caravanUpkeep, roadUpkeep };
}

function stepEmpire(world, e, blds, dtH, now) {
  const ec = empireEconomy(world, e, blds);
  const stock = e.stock;
  // raw goods first, then the workshops that use them
  for (const b of blds) {
    const def = BUILDINGS[b.type];
    if (!def.out || b.paused) continue;
    const room = ec.cap - (stock[def.out] || 0);
    if (room <= 0) { b.idle = 'full'; continue; }
    b.idle = null;
    stock[def.out] = (stock[def.out] || 0) + Math.min(room, ec.rates.get(b) * dtH);
  }
  for (const b of blds) {
    const def = BUILDINGS[b.type];
    if (!def.recipe || b.paused) continue;
    const rec = def.recipe;
    let n = ec.rates.get(b) * dtH;
    const room = ec.cap - (stock[rec.out] || 0);
    if (room <= 0) { b.idle = 'full'; continue; }
    n = Math.min(n, room);
    for (const [g, q] of Object.entries(rec.in)) n = Math.min(n, (stock[g] || 0) / q);
    if (n <= 1e-9) { b.idle = 'inputs'; continue; }
    b.idle = null;
    for (const [g, q] of Object.entries(rec.in)) stock[g] -= n * q;
    stock[rec.out] = (stock[rec.out] || 0) + n;
  }
  // residents eat, drink and wear things
  let wsum = 0, fsum = 0;
  e.fill ||= {};
  const wants = tierNeeds(e.tier);
  for (const g of GOOD_IDS) {
    const need = ec.cons[g] * dtH;
    if (!(wants[g] > 0)) { delete e.fill[g]; continue; }
    const w = NEED_WEIGHT[g] || 1;
    let ratio = 1;
    if (need > 0) {
      const got = Math.min(need, stock[g] || 0);
      stock[g] = (stock[g] || 0) - got;
      ratio = got / need;
    } else ratio = (stock[g] || 0) > 0 ? 1 : 0;
    e.fill[g] = +ratio.toFixed(3);
    wsum += w; fsum += w * ratio;
  }
  const fill = wsum ? fsum / wsum : 1;
  e.sat += (fill - e.sat) * Math.min(1, dtH / 3);
  // people move in while there are homes and their needs are met, and drift away when they are not
  const f = Math.min(1, Math.max(0.1, (e.sat - 0.15) / 0.6));
  const target = Math.min(ec.housing * f, TIERS[e.tier].cap);
  const rate = target > e.pop ? 0.25 : 0.12;
  e.pop += (target - e.pop) * (1 - Math.exp(-rate * dtH));
  if (e.pop < 0.01) e.pop = 0;
  // money
  const tax = ec.tax * dtH;
  e.cash += tax - ec.upkeep * dtH;
  e.stats.taxes = (e.stats.taxes || 0) + tax;
}

// Standing orders keep trade going while you are away: one caravan load at a time.
function stepOrders(world, e, now) {
  for (const o of e.orders || []) {
    if (idleCaravans(world, e) < 1) return;
    const town = townById(world, o.town);
    if (!town) continue;
    if (o.op === 'sell') {
      const surplus = Math.floor((e.stock[o.good] || 0) - o.level);
      if (surplus >= 10) marketSell(world, e, town, o.good, Math.min(surplus, CARAVAN.capacity), o.limit, now, true);
    } else {
      let coming = 0;
      for (const t of world.trips) if (t.owner === e.id && t.kind !== 'sell') coming += t.cargo[o.good] || 0;
      const want = Math.floor(o.level - (e.stock[o.good] || 0) - coming);
      if (want >= 10 && e.cash > 0) marketBuy(world, e, town, o.good, Math.min(want, CARAVAN.capacity), o.limit, now, true);
    }
  }
}

export function netWorth(world, e) {
  let v = e.cash + e.caravans * CARAVAN.cost * 0.6;
  for (const [g, q] of Object.entries(e.stock)) v += GOODS[g].base * q;
  for (const b of world.buildings) if (b.owner === e.id) {
    const def = BUILDINGS[b.type];
    v += (def.cost || 400) * 0.6 * (1 + 1.2 * ((b.level || 1) - 1));
  }
  for (const r of world.roads) if (r.owner === e.id) v += r.cost * 0.5;
  for (const t of world.trips) if (t.owner === e.id && t.kind !== 'sell') for (const [g, q] of Object.entries(t.cargo)) v += GOODS[g].base * q;
  for (const l of world.listings) {
    if (l.seller === e.id) for (const [g, q] of Object.entries(l.offer)) v += GOODS[g].base * q;
    for (const b of l.bids) if (b.bidder === e.id) { v += b.pay.cash || 0; for (const [g, q] of Object.entries(b.pay.goods || {})) v += GOODS[g].base * q; }
  }
  v += (e.land || 0) * 25;
  return v;
}

// ---------- the world's own rhythm ----------
function maybeEvent(world, dtH, now) {
  if (!world.towns.length) return;
  if (Math.random() > (dtH * world.towns.length) / 110) return; // about one every two hours on a full map
  const t = world.towns[Math.floor(Math.random() * world.towns.length)];
  const roll = Math.random();
  const has = (g) => t.resources.some((r) => r.good === g);
  let e = null;
  if (roll < 0.14) e = { type: 'drought', radius: 230, hours: 18, prod: { grain: 0.4, wool: 0.6 }, text: `Drought around ${t.name}. Grain and wool harvests are failing there, on every farm and pasture nearby.` };
  else if (roll < 0.27) e = { type: 'harvest', radius: 200, hours: 12, prod: { grain: 1.8 }, text: `Bumper harvest around ${t.name}. Farms nearby are overflowing with grain.` };
  else if (roll < 0.38 && t.coastal) e = { type: 'shoal', radius: 160, hours: 12, prod: { fish: 2 }, text: `Huge shoals off ${t.name}. Fisheries nearby are hauling in double.` };
  else if (roll < 0.5) e = { type: 'festival', hours: 10, need: { ale: 3, spices: 3, cloth: 1.5 }, text: `${t.name} holds a festival. Ale, cloth and spices are in demand there.` };
  else if (roll < 0.61) e = { type: 'bandits', radius: 190, hours: 10, text: `Bandits on the trails around ${t.name}. Caravans coming home from there off the roads risk losing cargo.` };
  else if (roll < 0.69 && has('iron')) e = { type: 'mine', hours: 24, prod: { iron: 0 }, text: `The mine at ${t.name} has collapsed. No iron from the town for a day.` };
  else if (roll < 0.79) {
    e = { type: 'fire', hours: 24, need: { timber: 3, stone: 3 }, text: `Fire in ${t.name}. The town needs timber and stone to rebuild and will pay for them.` };
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
  const towns = world.towns;
  const econs = towns.map((t) => townEconomy(world, t));
  for (let i = 0; i < towns.length; i++) {
    const a = towns[i], ea = econs[i];
    for (let j = i + 1; j < towns.length; j++) {
      const b = towns[j];
      if (dist(a, b) > 300) continue;
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
  for (const t of world.towns) {
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
    const g = 0.004 * (t.sat - 0.55) + 0.0003 * Math.min(4, roadCount[t.id] || 0) + econ.mods.growth;
    t.pop = Math.max(80, t.pop * (1 + g * dtH));
    const after = tierIndex(t.pop);
    if (after > before) news(world, `${t.name} has grown into a ${TIERS[after].name.toLowerCase()}. It now wants ${Object.keys(TIERS[after].needs).join(', ') || 'more of everything'}.`, 'growth', now);
    else if (after < before) news(world, `${t.name} has dwindled to a ${TIERS[after].name.toLowerCase()}.`, 'decline', now);
  }
}

const WORTH_MILESTONES = [10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000];
const POP_MILESTONES = [100, 250, 500, 1000, 2000, 5000, 10000, 20000];

function hourly(world, byOwner, now) {
  for (const t of world.towns) {
    const p = prices(world, t);
    for (const g of GOOD_IDS) {
      const h = (t.priceHist[g] ||= []);
      h.push(+p[g].mid.toFixed(2));
      if (h.length > 48) h.shift();
    }
    t.popHist.push(Math.round(t.pop));
    if (t.popHist.length > 168) t.popHist.shift();
  }
  const made = {};
  for (const e of Object.values(world.empires)) {
    const nw = netWorth(world, e);
    e.worthHist.push(Math.round(nw));
    if (e.worthHist.length > 168) e.worthHist.shift();
    e.popHist.push(Math.round(e.pop));
    if (e.popHist.length > 168) e.popHist.shift();
    for (const m of WORTH_MILESTONES) if (nw >= m && !e.milestones.includes(m)) {
      e.milestones.push(m);
      news(world, `${e.name} is now worth over ${fmtMoney(m)}.`, 'empire', now);
    }
    for (const m of POP_MILESTONES) if (e.pop >= m && !e.milestones.includes('p' + m)) {
      e.milestones.push('p' + m);
      if (m >= 500) news(world, `${e.name} is now home to ${m.toLocaleString('en-US')} people.`, 'empire', now);
    }
    const ec = empireEconomy(world, e, byOwner.get(e.id) || []);
    for (const g of GOOD_IDS) if (ec.prod[g] > 0) (made[g] ||= {})[e.id] = ec.prod[g];
  }
  // Who makes most of what. Only worth announcing once there is someone to compare with.
  if (Object.keys(world.empires).length >= 2) {
    for (const g of GOOD_IDS) {
      const m = made[g] || {};
      const total = Object.values(m).reduce((a, b) => a + b, 0);
      let top = null, topV = 0;
      for (const [id, v] of Object.entries(m)) if (v > topV) { top = id; topV = v; }
      const share = total ? topV / total : 0;
      const holder = world.leaders[g];
      if (top && total >= 8 && share > 0.5) {
        if (holder !== top) {
          world.leaders[g] = top;
          news(world, `${world.empires[top].name} is now the leading maker of ${lc(g)} (${Math.round(share * 100)}% of what the empires produce).`, 'empire', now);
        }
      } else if (holder && share < 0.4) delete world.leaders[g];
    }
  }
}

// Advance the world from world.lastTick to `until`, in slices of at most 15 minutes.
export function advance(world, until = Date.now()) {
  const MAX = 0.25 * HOUR;
  let steps = 0;
  if (world.lastTick >= until) return 0;
  const byOwner = new Map();
  for (const b of world.buildings) { let a = byOwner.get(b.owner); if (!a) byOwner.set(b.owner, (a = [])); a.push(b); }
  while (world.lastTick < until && steps < 20000) {
    const now = Math.min(until, world.lastTick + MAX);
    const dtH = (now - world.lastTick) / HOUR;
    finishTrips(world, now);
    stepTowns(world, dtH, now);
    peddlers(world, dtH);
    for (const e of Object.values(world.empires)) {
      stepEmpire(world, e, byOwner.get(e.id) || [], dtH, now);
      stepOrders(world, e, now);
    }
    world.events = world.events.filter((e) => e.until > now);
    maybeEvent(world, dtH, now);
    const prevH = Math.floor(world.clockHours);
    world.clockHours += dtH;
    world.lastTick = now;
    if (Math.floor(world.clockHours) > prevH) hourly(world, byOwner, now);
    steps++;
  }
  return steps;
}

export function initStocks(world) {
  for (const t of world.towns) {
    const econ = townEconomy(world, t);
    for (const g of GOOD_IDS) t.stock[g] = econ.prod[g] > 0 ? econ.target[g] * 2 : econ.target[g] * 0.5;
  }
}
