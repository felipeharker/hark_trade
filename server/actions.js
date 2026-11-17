// Player commands. Each validates, changes the world and returns a short result.
import { GOODS, VEHICLES, BUILDINGS, ROAD, EXPEDITION_COST, START_CASH, COMPANY_COLORS, dist, roadKey } from '../shared/data.js';
import {
  townById, news, companyLog, fmtMoney, buyGoods, sellGoods, cargoCount, warehouseOf, warehouseCap, storeCount,
  depart, advanceRoute, roadBetween, revealTown,
} from './sim.js';
import { nearestHidden } from './world.js';

class GameError extends Error {}
const fail = (m) => { throw new GameError(m); };
export { GameError };

const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const int = (v, lo, hi) => { const n = Math.floor(Number(v)); if (!Number.isFinite(n)) return lo; return Math.max(lo, Math.min(hi, n)); };

function knownTown(world, id) {
  const t = townById(world, id);
  if (!t || !t.known) fail('Unknown town.');
  return t;
}

function myCaravan(world, co, id) {
  const c = world.caravans.find((x) => x.id === id && x.owner === co.id);
  if (!c) fail('That caravan is not yours.');
  return c;
}

function pay(co, amount) {
  if (co.cash < amount) fail(`You need ${fmtMoney(amount)} for that (you have ${fmtMoney(co.cash)}).`);
  co.cash -= amount;
}

function newCaravan(world, co, type, townId) {
  const n = world.caravans.filter((c) => c.owner === co.id).length + 1;
  const c = { id: 'c' + world.nextId++, owner: co.id, type, name: `${VEHICLES[type].name} ${n}`, cargo: {}, at: townId, from: null, to: null, departAt: 0, arriveAt: 0, route: null, viaRoad: false };
  world.caravans.push(c);
  return c;
}

export function createCompany(world, userId, { name, color, home }) {
  if (world.companies[userId]) fail('You already run a company.');
  name = cleanText(name, 32);
  if (name.length < 2) fail('Pick a company name.');
  if (Object.values(world.companies).some((c) => c.name.toLowerCase() === name.toLowerCase())) fail('That name is taken.');
  const t = knownTown(world, home);
  if (!COMPANY_COLORS.includes(color)) color = COMPANY_COLORS[Object.keys(world.companies).length % COMPANY_COLORS.length];
  const co = { id: userId, name, color, cash: START_CASH, home: t.id, createdAt: Date.now(), log: [], stats: {}, worthHist: [], milestones: [] };
  world.companies[userId] = co;
  newCaravan(world, co, 'wagon', t.id);
  news(world, `${name} opens its doors in ${t.name}.`, 'company');
  companyLog(co, `Founded in ${t.name} with ${fmtMoney(START_CASH)} and one wagon.`);
  return { ok: true };
}

export const ACTIONS = {
  trade(world, co, a) {
    const c = myCaravan(world, co, a.caravan);
    if (!c.at) fail('The caravan is on the road.');
    if (!GOODS[a.good]) fail('Unknown good.');
    const t = townById(world, c.at);
    const qty = int(a.qty, 1, 10000);
    if (a.op === 'buy') {
      const space = VEHICLES[c.type].capacity - cargoCount(c);
      if (space <= 0) fail('The caravan is full.');
      const r = buyGoods(world, co, c.cargo, t, a.good, qty, 0, space);
      if (!r.bought) fail(t.stock[a.good] < 1 ? 'The market is out of that.' : 'Not enough cash.');
      companyLog(co, `${c.name} bought ${r.bought} ${a.good} in ${t.name} for ${fmtMoney(r.spent)}.`);
      return { msg: `Bought ${r.bought} for ${fmtMoney(r.spent)}` };
    }
    if (a.op === 'sell') {
      const r = sellGoods(world, co, c.cargo, t, a.good, qty, 0);
      if (!r.sold) fail('Nothing to sell.');
      companyLog(co, `${c.name} sold ${r.sold} ${a.good} in ${t.name} for ${fmtMoney(r.earned)}.`);
      return { msg: `Sold ${r.sold} for ${fmtMoney(r.earned)}` };
    }
    fail('Bad order.');
  },

  // Move goods between a caravan and your warehouse in the same town.
  transfer(world, co, a) {
    const c = myCaravan(world, co, a.caravan);
    if (!c.at) fail('The caravan is on the road.');
    const w = warehouseOf(world, co.id, c.at);
    if (!w) fail('You have no warehouse here.');
    if (!GOODS[a.good]) fail('Unknown good.');
    const qty = int(a.qty, 1, 10000);
    if (a.op === 'load') {
      const n = Math.min(Math.floor(w.stock[a.good] || 0), VEHICLES[c.type].capacity - cargoCount(c), qty);
      if (n <= 0) fail('Nothing to load, or no room.');
      w.stock[a.good] -= n; c.cargo[a.good] = (c.cargo[a.good] || 0) + n;
      return { msg: `Loaded ${n}` };
    }
    const n = Math.min(Math.floor(c.cargo[a.good] || 0), warehouseCap(w) - storeCount(w), qty);
    if (n <= 0) fail('Nothing to unload, or the warehouse is full.');
    c.cargo[a.good] -= n; if (c.cargo[a.good] <= 0) delete c.cargo[a.good];
    w.stock[a.good] = (w.stock[a.good] || 0) + n;
    return { msg: `Unloaded ${n}` };
  },

  // Trade straight from a warehouse with the local market.
  storeTrade(world, co, a) {
    const t = knownTown(world, a.town);
    const w = warehouseOf(world, co.id, t.id);
    if (!w) fail('You have no warehouse here.');
    if (!GOODS[a.good]) fail('Unknown good.');
    const qty = int(a.qty, 1, 10000);
    if (a.op === 'sell') {
      const r = sellGoods(world, co, w.stock, t, a.good, qty, 0);
      if (!r.sold) fail('Nothing to sell.');
      companyLog(co, `Warehouse in ${t.name} sold ${r.sold} ${a.good} for ${fmtMoney(r.earned)}.`);
      return { msg: `Sold ${r.sold} for ${fmtMoney(r.earned)}` };
    }
    const r = buyGoods(world, co, w.stock, t, a.good, qty, 0, warehouseCap(w) - storeCount(w));
    if (!r.bought) fail('Could not buy (no stock, room or cash).');
    companyLog(co, `Warehouse in ${t.name} bought ${r.bought} ${a.good} for ${fmtMoney(r.spent)}.`);
    return { msg: `Bought ${r.bought} for ${fmtMoney(r.spent)}` };
  },

  send(world, co, a) {
    const c = myCaravan(world, co, a.caravan);
    if (!c.at) fail('The caravan is already on the road.');
    const t = knownTown(world, a.to);
    if (t.id === c.at) fail('Already there.');
    c.route = null;
    depart(world, c, t.id, Date.now());
    return { msg: `${c.name} set off for ${t.name}` };
  },

  setRoute(world, co, a) {
    const c = myCaravan(world, co, a.caravan);
    const stops = (Array.isArray(a.stops) ? a.stops : []).slice(0, 8).map((s) => ({
      town: knownTown(world, s.town).id,
      orders: (Array.isArray(s.orders) ? s.orders : []).slice(0, 8).filter((o) => GOODS[o.good] && ['buy', 'sell', 'load', 'unload'].includes(o.op))
        .map((o) => ({ op: o.op, good: o.good, qty: int(o.qty, 0, 10000), limit: Math.max(0, Number(o.limit) || 0) })),
    }));
    if (stops.length < 2) fail('A route needs at least two stops.');
    for (let i = 0; i < stops.length; i++) if (stops[i].town === stops[(i + 1) % stops.length].town) fail('Two stops in a row are the same town.');
    // Start at the stop the caravan is heading for or sitting at, if any.
    const here = c.at || c.to;
    let idx = stops.findIndex((s) => s.town === here);
    if (idx < 0) idx = 0;
    c.route = { stops, idx };
    if (c.at) advanceRoute(world, c, Date.now());
    return { msg: `${c.name} is running its route` };
  },

  clearRoute(world, co, a) {
    const c = myCaravan(world, co, a.caravan);
    c.route = null;
    return { msg: `${c.name} will stop at its next town` };
  },

  renameCaravan(world, co, a) {
    const c = myCaravan(world, co, a.caravan);
    const n = cleanText(a.name, 24);
    if (n.length < 1) fail('Give it a name.');
    c.name = n;
    return { msg: 'Renamed' };
  },

  buyVehicle(world, co, a) {
    const v = VEHICLES[a.kind];
    if (!v) fail('Unknown vehicle.');
    const t = knownTown(world, a.town);
    if (t.id !== co.home && !warehouseOf(world, co.id, t.id)) fail('Buy vehicles at your home town or a town where you have a warehouse.');
    pay(co, v.cost);
    const c = newCaravan(world, co, a.kind, t.id);
    companyLog(co, `Bought ${c.name} in ${t.name} for ${fmtMoney(v.cost)}.`);
    return { msg: `${c.name} is ready in ${t.name}` };
  },

  sellVehicle(world, co, a) {
    const c = myCaravan(world, co, a.caravan);
    if (!c.at) fail('Wait until it reaches a town.');
    if (cargoCount(c) > 0) fail('Empty it first.');
    const refund = VEHICLES[c.type].cost * 0.5;
    co.cash += refund;
    world.caravans = world.caravans.filter((x) => x !== c);
    return { msg: `Sold for ${fmtMoney(refund)}` };
  },

  build(world, co, a) {
    const def = BUILDINGS[a.kind];
    if (!def) fail('Unknown building.');
    const t = knownTown(world, a.town);
    const w = warehouseOf(world, co.id, t.id);
    if (a.kind === 'warehouse') {
      if (w) fail('You already have a warehouse here. Expand it instead.');
    } else if (!w) fail('Build a warehouse here first.');
    let good;
    if (a.kind === 'estate') {
      good = a.good;
      if (!t.resources.some((r) => r.good === good)) fail(`${t.name} cannot produce that.`);
    }
    const mine = world.buildings.filter((b) => b.owner === co.id && b.town === t.id && b.type !== 'warehouse');
    if (a.kind !== 'warehouse' && mine.length >= 3) fail('At most three works per town.');
    pay(co, def.cost);
    const b = { id: 'b' + world.nextId++, type: a.kind, owner: co.id, town: t.id, builtAt: Date.now() };
    if (a.kind === 'warehouse') { b.stock = {}; b.level = 1; }
    if (good) b.good = good;
    world.buildings.push(b);
    const what = a.kind === 'estate' ? `a ${GOODS[good].name.toLowerCase()} estate` : `a ${def.name.toLowerCase()}`;
    news(world, `${co.name} builds ${what} in ${t.name}.`, 'build');
    return { msg: `Built ${what}` };
  },

  expandWarehouse(world, co, a) {
    const w = warehouseOf(world, co.id, a.town);
    if (!w) fail('No warehouse there.');
    if ((w.level || 1) >= 5) fail('It is as big as it gets.');
    pay(co, 600 * (w.level || 1));
    w.level = (w.level || 1) + 1;
    return { msg: `Warehouse now holds ${warehouseCap(w)}` };
  },

  demolish(world, co, a) {
    const b = world.buildings.find((x) => x.id === a.building && x.owner === co.id);
    if (!b) fail('Not yours.');
    if (b.type === 'warehouse' && world.buildings.some((x) => x.owner === co.id && x.town === b.town && x.type !== 'warehouse')) fail('Pull down the works here first.');
    if (b.type === 'warehouse' && storeCount(b) > 0) fail('Empty the warehouse first.');
    world.buildings = world.buildings.filter((x) => x !== b);
    co.cash += BUILDINGS[b.type].cost * 0.3;
    return { msg: 'Demolished' };
  },

  buildRoad(world, co, a) {
    const A = knownTown(world, a.a), B = knownTown(world, a.b);
    if (A.id === B.id) fail('Pick two different towns.');
    if (roadBetween(world, A.id, B.id)) fail('There is already a road there.');
    const len = dist(A, B);
    if (len > ROAD.maxLength) fail(`Too far for one road (${Math.round(len)} of ${ROAD.maxLength} leagues). Build through a town in between.`);
    const cost = Math.round(ROAD.base + ROAD.costPerUnit * len);
    pay(co, cost);
    const toll = int(a.toll ?? ROAD.defaultToll, 0, 200);
    world.roads.push({ id: 'r' + world.nextId++, key: roadKey(A.id, B.id), a: A.id, b: B.id, owner: co.id, toll, length: Math.round(len), cost, builtAt: Date.now() });
    news(world, `${co.name} opens a road between ${A.name} and ${B.name}. Toll ${fmtMoney(toll)}.`, 'build');
    return { msg: `Road built for ${fmtMoney(cost)}` };
  },

  setToll(world, co, a) {
    const r = world.roads.find((x) => x.id === a.road && x.owner === co.id);
    if (!r) fail('Not your road.');
    const old = r.toll;
    r.toll = int(a.toll, 0, 200);
    if (r.toll !== old) news(world, `${co.name} sets the ${townById(world, r.a).name}–${townById(world, r.b).name} toll to ${fmtMoney(r.toll)}.`, 'build');
    return { msg: 'Toll set' };
  },

  sellRoad(world, co, a) {
    const r = world.roads.find((x) => x.id === a.road && x.owner === co.id);
    if (!r) fail('Not your road.');
    const to = world.companies[a.to];
    if (!to || to.id === co.id) fail('Pick another company.');
    const price = int(a.price, 0, 10_000_000);
    if (to.cash < price) fail(`${to.name} cannot afford that.`);
    // A sale needs the buyer's consent: create an offer they can accept.
    world.offers ||= [];
    world.offers.push({ id: 'o' + world.nextId++, kind: 'road', road: r.id, from: co.id, to: to.id, price, t: Date.now() });
    return { msg: `Offer sent to ${to.name}` };
  },

  acceptOffer(world, co, a) {
    world.offers ||= [];
    const o = world.offers.find((x) => x.id === a.offer && x.to === co.id);
    if (!o) fail('No such offer.');
    const r = world.roads.find((x) => x.id === o.road && x.owner === o.from);
    world.offers = world.offers.filter((x) => x !== o);
    if (!r) fail('That road has changed hands.');
    pay(co, o.price);
    const seller = world.companies[o.from];
    if (seller) seller.cash += o.price;
    r.owner = co.id;
    news(world, `${co.name} buys the ${townById(world, r.a).name}–${townById(world, r.b).name} road from ${seller?.name} for ${fmtMoney(o.price)}.`, 'deal');
    return { msg: 'Road bought' };
  },

  declineOffer(world, co, a) {
    world.offers = (world.offers || []).filter((x) => !(x.id === a.offer && (x.to === co.id || x.from === co.id)));
    return { msg: 'Offer withdrawn' };
  },

  expedition(world, co, a) {
    const from = knownTown(world, a.from);
    const h = nearestHidden(world, from);
    if (!h) fail('The whole world is mapped.');
    pay(co, EXPEDITION_COST);
    const name = cleanText(a.name, 24);
    if (name && name.length >= 2 && !world.towns.some((t) => t.name.toLowerCase() === name.toLowerCase())) h.name = name;
    h.foundedBy = co.id;
    revealTown(world, h);
    news(world, `An expedition from ${co.name} reaches ${h.name}, beyond ${from.name}. It trades in ${h.resources.map((r) => r.good).join(', ')}.`, 'frontier');
    return { msg: `Discovered ${h.name}`, town: h.id };
  },

  pay(world, co, a) {
    const to = world.companies[a.to];
    if (!to || to.id === co.id) fail('Pick another company.');
    const amount = int(a.amount, 1, 10_000_000);
    pay(co, amount);
    to.cash += amount;
    const note = cleanText(a.note, 80);
    news(world, `${co.name} paid ${to.name} ${fmtMoney(amount)}${note ? `: “${note}”` : ''}.`, 'deal');
    companyLog(to, `Received ${fmtMoney(amount)} from ${co.name}${note ? `: “${note}”` : ''}.`);
    return { msg: 'Paid' };
  },

  post(world, co, a) {
    const text = cleanText(a.text, 280);
    if (!text) fail('Say something.');
    world.board.unshift({ t: Date.now(), company: co.id, text });
    if (world.board.length > 200) world.board.length = 200;
    return { msg: 'Posted' };
  },
};
