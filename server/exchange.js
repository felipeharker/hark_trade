// The Exchange: players list goods from their stores for a price in cash, in other goods, or both.
// Listed goods are held in escrow. Anyone else can accept the asking price or send a counter bid,
// which is escrowed too until the seller answers or the bidder withdraws it. When a deal is struck,
// cash changes hands at once and couriers carry the goods between the two capitals.
import { GOODS } from '../shared/data.js';
import { news, empireLog, fmtMoney, goodsText, sendCourier, addStock } from './sim.js';
import { fail, cleanText, int } from './actions.js';

const MAX_LISTINGS = 12;
const MAX_BIDS_EACH = 3;

function parseGoods(obj, what) {
  const out = {};
  for (const [g, q] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
    if (!Object.hasOwn(GOODS, g)) continue;
    const n = int(q, 0, 1_000_000);
    if (n > 0) out[g] = n;
  }
  if (Object.keys(out).length > 6) fail(`Keep ${what} to six kinds of goods.`);
  return out;
}

function parsePay(p) {
  const pay = { cash: int(p?.cash, 0, 100_000_000), goods: parseGoods(p?.goods, 'a price') };
  if (!pay.cash && !Object.keys(pay.goods).length) fail('Set a price: cash, goods, or both.');
  return pay;
}

export function payText(pay) {
  const parts = [];
  if (pay.cash) parts.push(fmtMoney(pay.cash));
  if (Object.keys(pay.goods || {}).length) parts.push(goodsText(pay.goods));
  return parts.join(' plus ');
}

function overlap(a, b) { return Object.keys(a).some((g) => b[g]); }

// Hold a price aside from an empire's cash and stores.
function escrow(e, pay) {
  if (e.cash < pay.cash) fail(`You need ${fmtMoney(pay.cash)} (you have ${fmtMoney(Math.max(0, e.cash))}).`);
  const short = Object.entries(pay.goods).filter(([g, q]) => Math.floor(e.stock[g] || 0) < q);
  if (short.length) fail(`You do not have ${goodsText(Object.fromEntries(short))} to offer.`);
  e.cash -= pay.cash;
  for (const [g, q] of Object.entries(pay.goods)) e.stock[g] -= q;
}

function refund(world, empireId, pay) {
  const e = world.empires[empireId];
  if (!e) return;
  e.cash += pay.cash || 0;
  addStock(e, pay.goods || {});
}

function listingOf(world, id) {
  const l = world.listings.find((x) => x.id === id);
  if (!l) fail('That listing is gone. Someone may have taken it.');
  return l;
}

// Close a deal: `pay` is already out of the buyer's hands, the offer already out of the seller's.
function settle(world, l, buyer, pay, now) {
  const seller = world.empires[l.seller];
  if (seller) {
    seller.cash += pay.cash;
    seller.stats.dealsCash = (seller.stats.dealsCash || 0) + pay.cash;
    if (Object.keys(pay.goods).length) sendCourier(world, buyer.id, seller.id, pay.goods, now, `payment from ${buyer.name}`);
  }
  const trip = sendCourier(world, l.seller, buyer.id, l.offer, now, `bought from ${seller?.name}`);
  world.listings = world.listings.filter((x) => x !== l);
  for (const e of [seller, buyer]) if (e) e.stats.deals = (e.stats.deals || 0) + 1;
  return trip;
}

export const EXCHANGE = {
  list(world, e, a) {
    const offer = parseGoods(a.offer, 'a listing');
    if (!Object.keys(offer).length) fail('Pick something from your stores to sell.');
    const ask = parsePay(a.ask);
    if (overlap(offer, ask.goods)) fail('Ask for something other than what you are selling.');
    if (world.listings.filter((l) => l.seller === e.id).length >= MAX_LISTINGS) fail(`You can have at most ${MAX_LISTINGS} listings open.`);
    const short = Object.entries(offer).filter(([g, q]) => Math.floor(e.stock[g] || 0) < q);
    if (short.length) fail(`You only have ${short.map(([g]) => `${Math.floor(e.stock[g] || 0)} ${GOODS[g].name.toLowerCase()}`).join(' and ')} in your stores.`);
    for (const [g, q] of Object.entries(offer)) e.stock[g] -= q;
    const l = { id: 'x' + world.nextId++, seller: e.id, offer, ask, note: cleanText(a.note, 120), t: Date.now(), bids: [] };
    world.listings.push(l);
    news(world, `${e.name} lists ${goodsText(offer)} on the Exchange for ${payText(ask)}.`, 'deal');
    return { msg: 'Listed on the Exchange' };
  },

  buyListing(world, e, a) {
    const l = listingOf(world, a.listing);
    if (l.seller === e.id) fail('That is your own listing.');
    // the buyer's own bids on this listing come back first, so that money can go towards the asking price
    const own = l.bids.filter((b) => b.bidder === e.id);
    for (const b of own) refund(world, e.id, b.pay);
    try { escrow(e, l.ask); } catch (err) { for (const b of own) escrow(e, b.pay); throw err; }
    for (const b of l.bids) if (b.bidder !== e.id) refund(world, b.bidder, b.pay);
    const seller = world.empires[l.seller];
    const trip = settle(world, l, e, l.ask, Date.now());
    news(world, `${e.name} buys ${goodsText(l.offer)} from ${seller?.name} for ${payText(l.ask)}.`, 'deal');
    if (seller) empireLog(seller, `${e.name} took your listing: ${goodsText(l.offer)} for ${payText(l.ask)}.`);
    empireLog(e, `Bought ${goodsText(l.offer)} from ${seller?.name} for ${payText(l.ask)}.`);
    return { msg: trip ? 'Deal done. A courier is on the way with your goods.' : 'Deal done.' };
  },

  bid(world, e, a) {
    const l = listingOf(world, a.listing);
    if (l.seller === e.id) fail('That is your own listing.');
    if (l.bids.filter((b) => b.bidder === e.id).length >= MAX_BIDS_EACH) fail(`You already have ${MAX_BIDS_EACH} bids on this. Withdraw one first.`);
    const pay = parsePay(a.pay);
    if (overlap(l.offer, pay.goods)) fail('Offer something other than what is being sold.');
    escrow(e, pay);
    l.bids.push({ id: 'y' + world.nextId++, bidder: e.id, pay, note: cleanText(a.note, 120), t: Date.now() });
    const seller = world.empires[l.seller];
    if (seller) empireLog(seller, `${e.name} bids ${payText(pay)} for your ${goodsText(l.offer)}.`);
    return { msg: 'Counter bid sent. It is held until the seller answers or you withdraw it.' };
  },

  acceptBid(world, e, a) {
    const l = listingOf(world, a.listing);
    if (l.seller !== e.id) fail('Not your listing.');
    const b = l.bids.find((x) => x.id === a.bid);
    if (!b) fail('That bid has been withdrawn.');
    const buyer = world.empires[b.bidder];
    if (!buyer) fail('That bidder is gone.');
    for (const o of l.bids) if (o !== b) {
      refund(world, o.bidder, o.pay);
      const oc = world.empires[o.bidder];
      if (oc) empireLog(oc, `${e.name} sold its ${goodsText(l.offer)} to someone else. Your bid of ${payText(o.pay)} was returned.`);
    }
    settle(world, l, buyer, b.pay, Date.now());
    news(world, `${e.name} sells ${goodsText(l.offer)} to ${buyer.name} for ${payText(b.pay)}.`, 'deal');
    empireLog(buyer, `${e.name} accepted your bid: ${goodsText(l.offer)} for ${payText(b.pay)}. A courier is on the way.`);
    empireLog(e, `Sold ${goodsText(l.offer)} to ${buyer.name} for ${payText(b.pay)}.`);
    return { msg: 'Deal done' };
  },

  // The seller turns a bid down, or the bidder takes it back.
  declineBid(world, e, a) {
    const l = listingOf(world, a.listing);
    const b = l.bids.find((x) => x.id === a.bid);
    if (!b) fail('That bid is gone.');
    if (l.seller !== e.id && b.bidder !== e.id) fail('Not yours.');
    refund(world, b.bidder, b.pay);
    l.bids = l.bids.filter((x) => x !== b);
    const mineToDecline = l.seller === e.id;
    const other = world.empires[mineToDecline ? b.bidder : l.seller];
    if (other) empireLog(other, mineToDecline
      ? `${e.name} turned down your bid of ${payText(b.pay)} for ${goodsText(l.offer)}. It was returned.`
      : `${e.name} withdrew its bid of ${payText(b.pay)} for your ${goodsText(l.offer)}.`);
    return { msg: mineToDecline ? 'Bid declined and returned' : 'Bid withdrawn and returned to you' };
  },

  cancelListing(world, e, a) {
    const l = listingOf(world, a.listing);
    if (l.seller !== e.id) fail('Not your listing.');
    addStock(e, l.offer);
    for (const b of l.bids) {
      refund(world, b.bidder, b.pay);
      const bc = world.empires[b.bidder];
      if (bc) empireLog(bc, `${e.name} withdrew its listing of ${goodsText(l.offer)}. Your bid was returned.`);
    }
    world.listings = world.listings.filter((x) => x !== l);
    return { msg: 'Listing withdrawn. The goods are back in your stores.' };
  },
};
