// The Exchange: players list goods they hold for a price in cash or in other goods.
// Listed goods are held in escrow. Others can buy at the asking price or make a counter bid,
// which is escrowed too. Every handover happens in the listing's town: goods go into the
// receiver's warehouse there, or wait at the town's pickup for one of their caravans.
import { GOODS, VEHICLES } from '../shared/data.js';
import { townById, news, companyLog, fmtMoney, warehouseOf, warehouseCap, storeCount, cargoCount } from './sim.js';

class ExchangeError extends Error {}
const fail = (m) => { throw new ExchangeError(m); };
export { ExchangeError };

const int = (v, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; };
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const lc = (g) => GOODS[g].name.toLowerCase();

export function priceText(p) {
  return p.cash != null ? fmtMoney(p.cash) : `${p.qty} ${lc(p.good)}`;
}

function parsePrice(p) {
  if (!p) fail('Set a price.');
  if (p.kind === 'goods') {
    if (!GOODS[p.good]) fail('Pick the goods you want in return.');
    const qty = int(p.qty, 1, 100000);
    return { good: p.good, qty };
  }
  const cash = int(p.cash, 1, 100_000_000);
  return { cash };
}

// Everything a company holds in one town: its warehouse, parked caravans and pickup.
function holders(world, coId, townId) {
  const out = [];
  const w = warehouseOf(world, coId, townId);
  if (w) out.push(w.stock);
  for (const c of world.caravans) if (c.owner === coId && c.at === townId) out.push(c.cargo);
  const p = world.pickups?.[coId]?.[townId];
  if (p) out.push(p);
  return out;
}

export function heldInTown(world, coId, townId, good) {
  return Math.floor(holders(world, coId, townId).reduce((a, h) => a + (h[good] || 0), 0));
}

// Take goods out of a company's holdings in a town, pickup first, then caravans, then warehouse.
function take(world, coId, townId, good, qty) {
  if (heldInTown(world, coId, townId, good) < qty) return false;
  let left = qty;
  const hs = holders(world, coId, townId).reverse();
  for (const h of hs) {
    const n = Math.min(left, Math.floor(h[good] || 0));
    if (n > 0) { h[good] -= n; if (h[good] <= 0) delete h[good]; left -= n; }
    if (!left) break;
  }
  return true;
}

// Hand goods to a company in a town: warehouse first, overflow to the pickup.
export function deliver(world, coId, townId, good, qty) {
  const w = warehouseOf(world, coId, townId);
  let left = qty;
  if (w) {
    const n = Math.min(left, Math.max(0, Math.floor(warehouseCap(w) - storeCount(w))));
    if (n > 0) { w.stock[good] = (w.stock[good] || 0) + n; left -= n; }
  }
  if (left > 0) {
    world.pickups ||= {};
    const p = ((world.pickups[coId] ||= {})[townId] ||= {});
    p[good] = (p[good] || 0) + left;
  }
}

function pay(world, payer, payee, townId, price) {
  if (price.cash != null) {
    if (payee) payee.cash += price.cash;
  } else if (payee) deliver(world, payee.id, townId, price.good, price.qty);
}

// Escrow a price from a company (cash or goods in the listing's town).
function escrow(world, co, townId, price) {
  if (price.cash != null) {
    if (co.cash < price.cash) fail(`You need ${fmtMoney(price.cash)} (you have ${fmtMoney(co.cash)}).`);
    co.cash -= price.cash;
  } else if (!take(world, co.id, townId, price.good, price.qty)) {
    fail(`You need ${price.qty} ${lc(price.good)} in ${townById(world, townId).name} (in a warehouse or a caravan parked there).`);
  }
}

function refund(world, coId, townId, price) {
  const co = world.companies[coId];
  if (!co) return;
  if (price.cash != null) co.cash += price.cash;
  else deliver(world, coId, townId, price.good, price.qty);
}

function listingOf(world, id) {
  const l = (world.listings ||= []).find((x) => x.id === id);
  if (!l) fail('That listing is gone.');
  return l;
}

function closeListing(world, l) {
  world.listings = world.listings.filter((x) => x !== l);
}

export const EXCHANGE = {
  list(world, co, a) {
    const t = townById(world, a.town);
    if (!t || !t.known) fail('Unknown town.');
    if (!GOODS[a.good]) fail('Pick something to sell.');
    const qty = int(a.qty, 1, 100000);
    const price = parsePrice(a.price);
    if (price.good === a.good) fail('Ask for something other than what you are selling.');
    if ((world.listings ||= []).filter((l) => l.seller === co.id).length >= 12) fail('You can have at most 12 listings open.');
    if (!take(world, co.id, t.id, a.good, qty)) fail(`You only have ${heldInTown(world, co.id, t.id, a.good)} ${lc(a.good)} in ${t.name}.`);
    const l = { id: 'x' + world.nextId++, seller: co.id, town: t.id, good: a.good, qty, price, note: cleanText(a.note, 120), t: Date.now(), bids: [] };
    world.listings.push(l);
    news(world, `${co.name} offers ${qty} ${lc(a.good)} in ${t.name} for ${priceText(price)}.`, 'deal');
    return { msg: 'Listed on the Exchange' };
  },

  buyListing(world, co, a) {
    const l = listingOf(world, a.listing);
    if (l.seller === co.id) fail('That is your own listing.');
    escrow(world, co, l.town, l.price);
    const seller = world.companies[l.seller];
    pay(world, co, seller, l.town, l.price);
    deliver(world, co.id, l.town, l.good, l.qty);
    for (const b of l.bids) refund(world, b.bidder, l.town, b.price);
    closeListing(world, l);
    const t = townById(world, l.town);
    news(world, `${co.name} buys ${l.qty} ${lc(l.good)} from ${seller?.name} in ${t.name} for ${priceText(l.price)}.`, 'deal');
    if (seller) companyLog(seller, `${co.name} bought your ${l.qty} ${lc(l.good)} in ${t.name} for ${priceText(l.price)}.`);
    return { msg: `Bought. The ${lc(l.good)} is waiting for you in ${t.name}.` };
  },

  bid(world, co, a) {
    const l = listingOf(world, a.listing);
    if (l.seller === co.id) fail('That is your own listing.');
    if (l.bids.filter((b) => b.bidder === co.id).length >= 3) fail('You already have three bids on this.');
    const price = parsePrice(a.price);
    if (price.good === l.good) fail('Offer something other than what is being sold.');
    escrow(world, co, l.town, price);
    l.bids.push({ id: 'y' + world.nextId++, bidder: co.id, price, note: cleanText(a.note, 120), t: Date.now() });
    const seller = world.companies[l.seller];
    if (seller) companyLog(seller, `${co.name} bids ${priceText(price)} for your ${l.qty} ${lc(l.good)} in ${townById(world, l.town).name}.`);
    return { msg: 'Counter bid sent. It is held until the seller answers or you withdraw it.' };
  },

  acceptBid(world, co, a) {
    const l = listingOf(world, a.listing);
    if (l.seller !== co.id) fail('Not your listing.');
    const b = l.bids.find((x) => x.id === a.bid);
    if (!b) fail('That bid is gone.');
    const buyer = world.companies[b.bidder];
    pay(world, buyer, co, l.town, b.price);
    deliver(world, b.bidder, l.town, l.good, l.qty);
    for (const o of l.bids) if (o !== b) refund(world, o.bidder, l.town, o.price);
    closeListing(world, l);
    const t = townById(world, l.town);
    news(world, `${co.name} sells ${l.qty} ${lc(l.good)} to ${buyer?.name} in ${t.name} for ${priceText(b.price)}.`, 'deal');
    if (buyer) companyLog(buyer, `${co.name} accepted your bid: ${l.qty} ${lc(l.good)} in ${t.name} for ${priceText(b.price)}.`);
    return { msg: 'Deal done' };
  },

  declineBid(world, co, a) {
    const l = listingOf(world, a.listing);
    const b = l.bids.find((x) => x.id === a.bid);
    if (!b) fail('That bid is gone.');
    if (l.seller !== co.id && b.bidder !== co.id) fail('Not yours.');
    refund(world, b.bidder, l.town, b.price);
    l.bids = l.bids.filter((x) => x !== b);
    const other = world.companies[l.seller === co.id ? b.bidder : l.seller];
    if (other) companyLog(other, l.seller === co.id
      ? `${co.name} turned down your bid of ${priceText(b.price)} for ${l.qty} ${lc(l.good)}.`
      : `${co.name} withdrew its bid of ${priceText(b.price)} for your ${l.qty} ${lc(l.good)}.`);
    return { msg: l.seller === co.id ? 'Bid declined and returned' : 'Bid withdrawn' };
  },

  cancelListing(world, co, a) {
    const l = listingOf(world, a.listing);
    if (l.seller !== co.id) fail('Not your listing.');
    deliver(world, co.id, l.town, l.good, l.qty);
    for (const b of l.bids) {
      refund(world, b.bidder, l.town, b.price);
      const bc = world.companies[b.bidder];
      if (bc) companyLog(bc, `${co.name} withdrew its ${l.qty} ${lc(l.good)}; your bid was returned.`);
    }
    closeListing(world, l);
    return { msg: 'Listing withdrawn. The goods are back in your hands.' };
  },

  // Move goods from a pickup into a parked caravan or your warehouse.
  collect(world, co, a) {
    const p = world.pickups?.[co.id]?.[a.town];
    if (!p || !GOODS[a.good] || !(p[a.good] > 0)) fail('Nothing to collect.');
    let room;
    let dest;
    if (a.caravan) {
      const c = world.caravans.find((x) => x.id === a.caravan && x.owner === co.id && x.at === a.town);
      if (!c) fail('That caravan is not here.');
      room = VEHICLES[c.type].capacity - cargoCount(c); dest = c.cargo;
    } else {
      const w = warehouseOf(world, co.id, a.town);
      if (!w) fail('No warehouse here.');
      room = warehouseCap(w) - storeCount(w); dest = w.stock;
    }
    const n = Math.min(Math.floor(p[a.good]), Math.floor(room));
    if (n <= 0) fail('No room.');
    p[a.good] -= n; if (p[a.good] <= 0) delete p[a.good];
    dest[a.good] = (dest[a.good] || 0) + n;
    return { msg: `Collected ${n} ${lc(a.good)}` };
  },
};
