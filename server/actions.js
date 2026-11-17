// Player commands. Each validates, changes the world and returns a short result.
import {
  GOODS, TIERS, BUILDINGS, ROAD, CARAVAN, START, EMPIRE_COLORS, dist, roadKey, siteOk, upgradeCost, maxLevel,
  claimCost, outpostCost,
} from '../shared/data.js';
import { tileKey, tileCenter } from '../shared/terrain.js';
import { settleProblem, settleTiles, claimCheck } from '../shared/rules.js';
import {
  townById, placeById, settlementById, news, empireLog, fmtMoney, goodsText, lc, terrainOf, refreshBuildings,
  marketBuy, marketSell, idleCaravans,
} from './sim.js';

class GameError extends Error {}
const fail = (m) => { throw new GameError(m); };
export { GameError, fail };

export const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
export const int = (v, lo, hi) => { const n = Math.floor(Number(v)); if (!Number.isFinite(n)) return lo; return Math.max(lo, Math.min(hi, n)); };

export function pay(e, amount) {
  if (e.cash < amount) fail(`You need ${fmtMoney(amount)} for that (you have ${fmtMoney(Math.max(0, e.cash))}).`);
  e.cash -= amount;
}

export function hasGoods(e, goods) {
  return Object.entries(goods || {}).every(([g, q]) => Math.floor(e.stock[g] || 0) >= q);
}
// Take materials out of an empire's stores, or explain what is short.
export function takeGoods(e, goods, what = 'that') {
  const short = Object.entries(goods || {}).filter(([g, q]) => Math.floor(e.stock[g] || 0) < q);
  if (short.length) fail(`You need ${goodsText(goods)} for ${what}. You are short of ${short.map(([g, q]) => `${Math.ceil(q - Math.floor(e.stock[g] || 0))} ${lc(g)}`).join(' and ')}.`);
  for (const [g, q] of Object.entries(goods || {})) e.stock[g] -= q;
}

function landCtx(world) {
  return {
    terrain: terrainOf(world), towns: world.towns, settlements: world.settlements,
    tileAt: (tx, ty) => world.tiles[tileKey(tx, ty)],
  };
}

function settle(world, e, tx, ty, capital, name) {
  const ctx = landCtx(world);
  const problem = settleProblem(ctx, tx, ty, capital, e.id);
  if (problem) fail(problem);
  const c = tileCenter(tx, ty);
  const s = { id: 's' + world.nextId++, owner: e.id, name, tx, ty, x: c.x, y: c.y, capital, foundedAt: Date.now() };
  for (const [x, y] of settleTiles(ctx, tx, ty, capital)) world.tiles[tileKey(x, y)] = { o: e.id, s: s.id };
  world.settlements.push(s);
  world.buildings.push({ id: 'b' + world.nextId++, type: 'hall', owner: e.id, s: s.id, tx, ty, level: 1, builtAt: Date.now() });
  e.land = Object.values(world.tiles).filter((t) => t.o === e.id).length;
  return s;
}

function uniqueName(world, name, what) {
  const taken = (n) => world.towns.some((t) => t.name.toLowerCase() === n) || world.settlements.some((s) => s.name.toLowerCase() === n);
  if (taken(name.toLowerCase())) fail(`There is already a ${what} called ${name}.`);
}

export function createEmpire(world, userId, a) {
  if (world.empires[userId]) fail('You already have an empire.');
  const name = cleanText(a.name, 28);
  if (name.length < 2) fail('Give your empire a name.');
  if (Object.values(world.empires).some((c) => c.name.toLowerCase() === name.toLowerCase())) fail('That name is taken.');
  const seat = cleanText(a.seat, 24) || name;
  uniqueName(world, seat, 'place');
  let color = a.color;
  const used = new Set(Object.values(world.empires).map((c) => c.color));
  if (!EMPIRE_COLORS.includes(color) || used.has(color)) color = EMPIRE_COLORS.find((c) => !used.has(c)) || EMPIRE_COLORS[Object.keys(world.empires).length % EMPIRE_COLORS.length];
  const e = {
    id: userId, name, color, cash: START.cash, tier: 0, pop: 0, sat: 0.8, stock: { ...START.stock }, caravans: START.caravans,
    extra: 0, land: 0, orders: [], fill: {}, createdAt: Date.now(), log: [], stats: {}, worthHist: [], popHist: [], milestones: [],
  };
  const s = settle(world, e, int(a.tx, -1, 1e6), int(a.ty, -1, 1e6), true, seat);
  world.empires[userId] = e;
  refreshBuildings(world, e.id);
  news(world, `${name} is founded at ${s.name}.`, 'empire');
  empireLog(e, `Founded ${s.name} with ${fmtMoney(START.cash)}, ${START.caravans} caravans and stores of ${goodsText(START.stock)}.`);
  return { ok: true };
}

function myBuilding(world, e, id) {
  const b = world.buildings.find((x) => x.id === id && x.owner === e.id);
  if (!b) fail('That is not yours.');
  return b;
}

const anyTown = (world, id) => townById(world, id) || fail('Unknown town.');
const goodId = (g) => (Object.hasOwn(GOODS, g) ? g : fail('Unknown good.'));

export const ACTIONS = {
  // ----- land and buildings -----
  claim(world, e, a) {
    const tx = int(a.tx, -1, 1e6), ty = int(a.ty, -1, 1e6);
    const r = claimCheck(landCtx(world), tx, ty, e.id);
    if (r.problem) fail(r.problem);
    const cost = claimCost(e.extra || 0);
    pay(e, cost);
    world.tiles[tileKey(tx, ty)] = { o: e.id, s: r.s };
    e.extra = (e.extra || 0) + 1; e.land = (e.land || 0) + 1;
    return { msg: `Plot claimed for ${fmtMoney(cost)}` };
  },

  build(world, e, a) {
    const def = Object.hasOwn(BUILDINGS, a.kind) ? BUILDINGS[a.kind] : null;
    if (!def || def.fixed) fail('Unknown building.');
    const tx = int(a.tx, -1, 1e6), ty = int(a.ty, -1, 1e6);
    const tile = world.tiles[tileKey(tx, ty)];
    if (!tile || tile.o !== e.id) fail('Build on land you hold. Claim the plot first.');
    if (world.buildings.some((b) => b.tx === tx && b.ty === ty)) fail('There is already something on that plot.');
    const terrain = terrainOf(world);
    if (!siteOk(def, terrain.tile(tx, ty).kind, terrain.coastal(tx, ty))) fail(`${def.name} cannot go on that land. ${def.blurb}`);
    if ((def.tier || 0) > e.tier) fail(`Only a ${TIERS[def.tier].name.toLowerCase()} or larger can build that.`);
    if (e.cash < def.cost) fail(`You need ${fmtMoney(def.cost)} for that (you have ${fmtMoney(Math.max(0, e.cash))}).`);
    takeGoods(e, def.mats, `the ${def.name.toLowerCase()}`);
    pay(e, def.cost);
    const b = { id: 'b' + world.nextId++, type: a.kind, owner: e.id, s: tile.s, tx, ty, level: 1, builtAt: Date.now() };
    world.buildings.push(b);
    refreshBuildings(world, e.id);
    return { msg: `${def.name} built`, building: b.id };
  },

  upgrade(world, e, a) {
    const b = myBuilding(world, e, a.building);
    const def = BUILDINGS[b.type];
    const top = maxLevel(b.type, e.tier);
    if (b.level >= top) {
      const next = TIERS.findIndex((t, i) => i > e.tier && maxLevel(b.type, i) > b.level);
      fail(next > 0 ? `Become a ${TIERS[next].name.toLowerCase()} to take this further.` : 'It is as large as it gets.');
    }
    const c = upgradeCost(b.type, b.level);
    if (e.cash < c.cash) fail(`You need ${fmtMoney(c.cash)} for that (you have ${fmtMoney(Math.max(0, e.cash))}).`);
    takeGoods(e, c.mats, 'that upgrade');
    pay(e, c.cash);
    b.level++;
    return { msg: `${def.name} is now level ${b.level}` };
  },

  demolish(world, e, a) {
    const b = myBuilding(world, e, a.building);
    if (b.type === 'hall') fail('A town hall cannot be pulled down.');
    world.buildings = world.buildings.filter((x) => x !== b);
    e.cash += BUILDINGS[b.type].cost * 0.3;
    refreshBuildings(world, e.id);
    return { msg: 'Pulled down' };
  },

  pause(world, e, a) {
    const b = myBuilding(world, e, a.building);
    if (!BUILDINGS[b.type].rate) fail('Only working buildings can be paused.');
    b.paused = !!a.on;
    if (b.paused) b.idle = null;
    return { msg: b.paused ? 'Paused. Its workers are free and upkeep drops to a quarter.' : 'Back at work' };
  },

  charter(world, e) {
    const next = TIERS[e.tier + 1];
    if (!next) fail('There is no higher rank.');
    if (e.pop < next.min) fail(`You need ${next.min.toLocaleString('en-US')} people to become a ${next.name.toLowerCase()} (you have ${Math.floor(e.pop).toLocaleString('en-US')}).`);
    if (e.cash < next.charter.cash) fail(`The charter costs ${fmtMoney(next.charter.cash)} (you have ${fmtMoney(Math.max(0, e.cash))}).`);
    takeGoods(e, next.charter.goods, 'the charter');
    pay(e, next.charter.cash);
    e.tier++;
    const wants = Object.keys(next.needs).map(lc);
    news(world, `${e.name} is now a ${next.name.toLowerCase()}.${wants.length ? ` Its people want ${wants.join(', ')}.` : ''}`, 'empire');
    empireLog(e, `Chartered as a ${next.name.toLowerCase()}.`);
    return { msg: `You are now a ${next.name.toLowerCase()}` };
  },

  outpost(world, e, a) {
    if (e.tier < 1) fail('Become a village before founding outposts.');
    const n = world.settlements.filter((s) => s.owner === e.id && !s.capital).length;
    const cost = outpostCost(n);
    const name = cleanText(a.name, 24);
    if (name.length < 2) fail('Give the outpost a name.');
    uniqueName(world, name, 'place');
    if (e.cash < cost) fail(`An outpost costs ${fmtMoney(cost)} (you have ${fmtMoney(Math.max(0, e.cash))}).`);
    const s = settle(world, e, int(a.tx, -1, 1e6), int(a.ty, -1, 1e6), false, name);
    pay(e, cost);
    refreshBuildings(world, e.id);
    news(world, `${e.name} founds the outpost of ${s.name}.`, 'build');
    return { msg: `${s.name} founded`, settlement: s.id };
  },

  renameSettlement(world, e, a) {
    const s = settlementById(world, a.settlement);
    if (!s || s.owner !== e.id) fail('That is not yours.');
    const name = cleanText(a.name, 24);
    if (name.length < 2) fail('Give it a name.');
    if (name.toLowerCase() !== s.name.toLowerCase()) uniqueName(world, name, 'place');
    s.name = name;
    return { msg: 'Renamed' };
  },

  // ----- caravans and the town markets -----
  buyCaravan(world, e) {
    if (e.caravans >= CARAVAN.max) fail(`${CARAVAN.max} caravans is the most anyone can run.`);
    pay(e, CARAVAN.cost);
    e.caravans++;
    return { msg: `You now run ${e.caravans} caravans` };
  },

  sellCaravan(world, e) {
    if (idleCaravans(world, e) < 1) fail('Wait for a caravan to come home.');
    e.caravans--;
    e.cash += CARAVAN.cost * 0.5;
    return { msg: `Sold for ${fmtMoney(CARAVAN.cost * 0.5)}` };
  },

  marketBuy(world, e, a) {
    const t = anyTown(world, a.town);
    const r = marketBuy(world, e, t, goodId(a.good), int(a.qty, 1, 100000), 0, Date.now());
    if (!r.n) fail(r.why);
    return { msg: `Bought ${r.n} for ${fmtMoney(r.total)}. Home in ${hoursText((r.trip.returnAt - r.trip.departAt) / 3600e3)}.` };
  },

  marketSell(world, e, a) {
    const t = anyTown(world, a.town);
    const r = marketSell(world, e, t, goodId(a.good), int(a.qty, 1, 100000), 0, Date.now());
    if (!r.n) fail(r.why);
    return { msg: `Sold ${r.n} for ${fmtMoney(r.total)}` };
  },

  setOrder(world, e, a) {
    const t = anyTown(world, a.town);
    const good = goodId(a.good);
    if (a.op !== 'buy' && a.op !== 'sell') fail('Bad order.');
    e.orders ||= [];
    const o = { id: 'o' + world.nextId++, op: a.op, good, town: t.id, level: int(a.level, 0, 100000), limit: Math.max(0, Math.round((Number(a.limit) || 0) * 100) / 100) };
    const same = e.orders.findIndex((x) => x.op === o.op && x.good === o.good && x.town === o.town);
    if (same >= 0) e.orders[same] = o;
    else {
      if (e.orders.length >= 10) fail('Ten standing orders is the limit.');
      e.orders.push(o);
    }
    return { msg: 'Standing order set' };
  },

  removeOrder(world, e, a) {
    e.orders = (e.orders || []).filter((o) => o.id !== a.order);
    return { msg: 'Standing order removed' };
  },

  // ----- roads -----
  buildRoad(world, e, a) {
    const A = placeById(world, a.a), B = placeById(world, a.b);
    if (!A || !B) fail('Pick two places.');
    if (A.id === B.id) fail('Pick two different places.');
    const key = roadKey(A.id, B.id);
    if (world.roads.some((r) => r.key === key)) fail('There is already a road there.');
    const len = dist(A, B);
    if (len > ROAD.maxLength) fail(`Too far for one road (${Math.round(len)} of ${ROAD.maxLength} leagues). Build through a place in between.`);
    const cost = Math.round(ROAD.base + ROAD.costPerUnit * len);
    pay(e, cost);
    const toll = int(a.toll ?? ROAD.defaultToll, 0, ROAD.maxToll);
    world.roads.push({ id: 'r' + world.nextId++, key, a: A.id, b: B.id, owner: e.id, toll, length: Math.round(len), cost, builtAt: Date.now() });
    news(world, `${e.name} opens a road between ${A.name} and ${B.name}. Toll ${fmtMoney(toll)}.`, 'build');
    return { msg: `Road built for ${fmtMoney(cost)}` };
  },

  setToll(world, e, a) {
    const r = world.roads.find((x) => x.id === a.road && x.owner === e.id);
    if (!r) fail('Not your road.');
    const old = r.toll;
    r.toll = int(a.toll, 0, ROAD.maxToll);
    if (r.toll !== old) news(world, `${e.name} sets the ${placeById(world, r.a)?.name}–${placeById(world, r.b)?.name} toll to ${fmtMoney(r.toll)}.`, 'build');
    return { msg: 'Toll set' };
  },

  sellRoad(world, e, a) {
    const r = world.roads.find((x) => x.id === a.road && x.owner === e.id);
    if (!r) fail('Not your road.');
    const to = world.empires[a.to];
    if (!to || to.id === e.id) fail('Pick another empire.');
    const price = int(a.price, 0, 100_000_000);
    world.offers = world.offers.filter((o) => !(o.road === r.id && o.to === to.id));
    world.offers.push({ id: 'f' + world.nextId++, kind: 'road', road: r.id, from: e.id, to: to.id, price, t: Date.now() });
    empireLog(to, `${e.name} offers you the ${placeById(world, r.a)?.name}–${placeById(world, r.b)?.name} road for ${fmtMoney(price)}.`);
    return { msg: `Offer sent to ${to.name}` };
  },

  acceptOffer(world, e, a) {
    const o = world.offers.find((x) => x.id === a.offer && x.to === e.id);
    if (!o) fail('No such offer.');
    const r = world.roads.find((x) => x.id === o.road && x.owner === o.from);
    if (!r) { world.offers = world.offers.filter((x) => x !== o); fail('That road has changed hands.'); }
    pay(e, o.price);
    world.offers = world.offers.filter((x) => x.road !== o.road);
    const seller = world.empires[o.from];
    if (seller) seller.cash += o.price;
    r.owner = e.id;
    news(world, `${e.name} buys the ${placeById(world, r.a)?.name}–${placeById(world, r.b)?.name} road from ${seller?.name} for ${fmtMoney(o.price)}.`, 'deal');
    return { msg: 'Road bought' };
  },

  declineOffer(world, e, a) {
    world.offers = world.offers.filter((x) => !(x.id === a.offer && (x.to === e.id || x.from === e.id)));
    return { msg: 'Offer withdrawn' };
  },

  // ----- each other -----
  pay(world, e, a) {
    const to = world.empires[a.to];
    if (!to || to.id === e.id) fail('Pick another empire.');
    const amount = int(a.amount, 1, 100_000_000);
    pay(e, amount);
    to.cash += amount;
    const note = cleanText(a.note, 80);
    news(world, `${e.name} paid ${to.name} ${fmtMoney(amount)}${note ? `: “${note}”` : ''}.`, 'deal');
    empireLog(to, `Received ${fmtMoney(amount)} from ${e.name}${note ? `: “${note}”` : ''}.`);
    return { msg: 'Paid' };
  },

  post(world, e, a) {
    const text = cleanText(a.text, 280);
    if (!text) fail('Say something.');
    world.board.unshift({ t: Date.now(), empire: e.id, text });
    if (world.board.length > 200) world.board.length = 200;
    return { msg: 'Posted' };
  },
};

function hoursText(h) {
  const m = Math.round(h * 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
