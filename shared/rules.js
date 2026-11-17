// Land rules, shared so the browser can show what is allowed before the server is asked.
// ctx: { terrain, towns: [{tx,ty}], settlements: [{tx,ty,owner}], tileAt(tx,ty) -> { o, s } | undefined }
import { inMap, NEIGHBOURS4 } from './terrain.js';
import { CAPITAL_R2, OUTPOST_R2, TOWN_PRECINCT, SETTLE_GAP } from './data.js';

const cheb = (a, tx, ty) => Math.max(Math.abs(a.tx - tx), Math.abs(a.ty - ty));

export function inPrecinct(ctx, tx, ty) {
  return ctx.towns.some((t) => cheb(t, tx, ty) <= TOWN_PRECINCT);
}

// The plots a new settlement at (tx, ty) would take.
export function settleTiles(ctx, tx, ty, capital) {
  const r2 = capital ? CAPITAL_R2 : OUTPOST_R2;
  const out = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    if (dx * dx + dy * dy > r2) continue;
    const x = tx + dx, y = ty + dy;
    if (!inMap(x, y) || ctx.terrain.tile(x, y).kind === 'water') continue;
    if (ctx.tileAt(x, y) || inPrecinct(ctx, x, y)) continue;
    out.push([x, y]);
  }
  return out;
}

// Why a settlement cannot go here, or null if it can.
export function settleProblem(ctx, tx, ty, capital, ownerId) {
  if (!inMap(tx, ty)) return 'That is off the map.';
  if (ctx.terrain.tile(tx, ty).kind === 'water') return 'You cannot settle on water.';
  if (ctx.tileAt(tx, ty)) return 'That land is already claimed.';
  if (ctx.towns.some((t) => cheb(t, tx, ty) < (capital ? SETTLE_GAP : 4))) return 'Too close to a town. Leave it some room.';
  for (const s of ctx.settlements) {
    const d = cheb(s, tx, ty);
    if (s.owner === ownerId ? d < 4 : d < (capital ? SETTLE_GAP : 5)) return s.owner === ownerId ? 'Too close to your own settlement. Just claim the land in between.' : 'Too close to another settlement.';
  }
  if (settleTiles(ctx, tx, ty, capital).length < (capital ? 10 : 5)) return 'Not enough free land here.';
  return null;
}

// Whether `ownerId` can claim one more plot. Returns { s } (the settlement it joins) or { problem }.
export function claimCheck(ctx, tx, ty, ownerId) {
  if (!inMap(tx, ty)) return { problem: 'That is off the map.' };
  if (ctx.terrain.tile(tx, ty).kind === 'water') return { problem: 'You cannot claim open water.' };
  if (ctx.tileAt(tx, ty)) return { problem: 'That plot is already claimed.' };
  if (inPrecinct(ctx, tx, ty)) return { problem: 'That plot belongs to the town.' };
  for (const [dx, dy] of NEIGHBOURS4) {
    const n = ctx.tileAt(tx + dx, ty + dy);
    if (n && n.o === ownerId) return { s: n.s };
  }
  return { problem: 'You can only claim plots next to land you already hold.' };
}
