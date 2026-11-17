// Saltroad server: auth, the world clock, and a small JSON API.
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './db.js';
import zlib from 'node:zlib';
import { generateWorld, WORLD_VERSION } from './world.js';
import {
  advance, initStocks, townEconomy, prices, netWorth, townById, empireEconomy, buildingsOf, idleCaravans, homeFor, tollsDue,
  capitalOf, route,
} from './sim.js';
import { ACTIONS as BASE_ACTIONS, createEmpire, GameError } from './actions.js';
import { EXCHANGE } from './exchange.js';
import { tierIndex, TIERS, GOOD_IDS, COURIER_SPEED } from '../shared/data.js';

const ACTIONS = { ...BASE_ACTIONS, ...EXCHANGE };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const INVITE_CODE = process.env.INVITE_CODE || '';
const TICK_MS = 20_000;

const store = await openStore();
const SECRET = process.env.SESSION_SECRET || (await store.secret());

function freshWorld(seed) {
  const w = generateWorld(seed);
  initStocks(w);
  // let the world settle for a simulated day before anyone arrives
  const start = w.lastTick;
  w.lastTick = start - 24 * 3600e3;
  advance(w, start);
  w.clockHours = 0; // day one starts when the land opens to players
  w.news = [];
  w.news.unshift({ t: Date.now(), text: 'A new land lies open. The towns are trading, and the country between them is waiting to be settled.', kind: 'world' });
  return w;
}

let world = await store.loadWorld();
if (world && world.version !== WORLD_VERSION) {
  // An older kind of world cannot be carried over. Keep it as a backup and start again; accounts are untouched.
  await store.backupWorld(world, true);
  console.log(`Found a version ${world.version ?? 1} world; backed it up and starting a version ${WORLD_VERSION} world`);
  world = null;
}
if (!world) {
  world = freshWorld(process.env.WORLD_SEED ? Number(process.env.WORLD_SEED) : undefined);
  await store.saveWorld(world);
  console.log('Generated a new world with seed', world.seed);
} else {
  const behind = Date.now() - world.lastTick;
  const t0 = Date.now();
  advance(world);
  console.log(`Loaded world (seed ${world.seed}); caught up ${(behind / 3600e3).toFixed(2)} h in ${Date.now() - t0} ms`);
}

let dirty = false, saving = false;
async function save() {
  if (saving) { dirty = true; return; }
  saving = true; dirty = false;
  try { await store.saveWorld(world); } catch (e) { console.error('save failed', e); dirty = true; }
  saving = false;
  if (dirty) setTimeout(save, 1000);
}
setInterval(() => { advance(world); save(); }, TICK_MS);
setInterval(() => store.backupWorld(world).catch((e) => console.error('backup failed', e)), 6 * 3600e3);

// ---------- auth ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function makeToken(uid) {
  const v = `${uid}.${Date.now() + 90 * 86400e3}`;
  return `${v}.${sign(v)}`;
}
function readToken(tok) {
  if (!tok) return null;
  const i = tok.lastIndexOf('.');
  const v = tok.slice(0, i), s = tok.slice(i + 1);
  const good = sign(v);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  const [uid, exp] = v.split('.');
  if (Date.now() > Number(exp)) return null;
  return Number(uid);
}
function cookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
function setSession(res, uid) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ht=${encodeURIComponent(makeToken(uid))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${90 * 86400}${secure}`);
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.set('trust proxy', 1);

app.use(async (req, res, next) => {
  const uid = readToken(cookies(req).ht);
  req.user = uid ? await store.userById(uid) : null;
  next();
});
const need = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in.' }));
const cid = (u) => 'u' + u.id;

// crude rate limit on auth
const attempts = new Map();
function limited(req) {
  const k = req.ip;
  const now = Date.now();
  const a = (attempts.get(k) || []).filter((t) => now - t < 10 * 60e3);
  a.push(now); attempts.set(k, a);
  return a.length > 30;
}

app.post('/api/register', async (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
  const { username, password, invite } = req.body || {};
  if (INVITE_CODE && String(invite || '').trim().toLowerCase() !== INVITE_CODE.toLowerCase()) return res.status(403).json({ error: 'That invite code is not right.' });
  const u = String(username || '').trim();
  if (!/^[A-Za-z0-9_.-]{2,24}$/.test(u)) return res.status(400).json({ error: 'Usernames are 2–24 letters, numbers, dots, dashes or underscores.' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'Use a password of at least 6 characters.' });
  if (await store.findUser(u)) return res.status(409).json({ error: 'That username is taken.' });
  const user = await store.createUser(u, hashPassword(String(password)));
  setSession(res, user.id);
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
  const { username, password } = req.body || {};
  const u = await store.findUser(String(username || '').trim());
  if (!u || !checkPassword(String(password || ''), u.pass_hash)) return res.status(401).json({ error: 'Wrong username or password.' });
  setSession(res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ht=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null, inviteRequired: !!INVITE_CODE });
  res.json({ user: { id: req.user.id, username: req.user.username, admin: req.user.is_admin }, empire: !!world.empires[cid(req.user)] });
});

app.post('/api/password', need, async (req, res) => {
  const { current, next: nw } = req.body || {};
  const u = await store.findUser(req.user.username);
  if (!checkPassword(String(current || ''), u.pass_hash)) return res.status(401).json({ error: 'Current password is wrong.' });
  if (String(nw || '').length < 6) return res.status(400).json({ error: 'Use at least 6 characters.' });
  await store.setPassword(u.id, hashPassword(String(nw)));
  res.json({ ok: true });
});

// Admin: throw the world away and start a new one. Accounts stay; everyone founds a new empire.
// The old world is kept in world_backups first.
app.post('/api/admin/reset', need, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only.' });
  if (req.body?.confirm !== 'RESET') return res.status(400).json({ error: 'Type RESET to confirm.' });
  try {
    advance(world);
    await store.backupWorld(world, true);
    world = freshWorld();
    await store.saveWorld(world);
    console.log(`World reset by ${req.user.username}; new seed ${world.seed}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('reset failed', e);
    res.status(500).json({ error: 'Reset failed. The old world is untouched.' });
  }
});

// Admin: reset someone's password (the first account created is the admin).
app.post('/api/admin/password', need, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only.' });
  const u = await store.findUser(String(req.body?.username || ''));
  if (!u) return res.status(404).json({ error: 'No such user.' });
  if (String(req.body?.password || '').length < 6) return res.status(400).json({ error: 'Use at least 6 characters.' });
  await store.setPassword(u.id, hashPassword(String(req.body.password)));
  res.json({ ok: true });
});

// ---------- game API ----------
const r2 = (n) => Math.round(n * 100) / 100;
const whole = (o) => Object.fromEntries(Object.entries(o || {}).map(([g, q]) => [g, Math.floor(q + 1e-6)]).filter(([, q]) => q > 0));

function sendJson(req, res, obj) {
  const body = JSON.stringify(obj);
  if (body.length < 2000 || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return res.type('json').send(body);
  zlib.gzip(body, { level: 5 }, (err, buf) => {
    if (err) return res.type('json').send(body);
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }).send(buf);
  });
}

function publicState(user) {
  const me = user ? world.empires[cid(user)] : null;
  const towns = world.towns.map((t) => {
    const econ = townEconomy(world, t);
    const p = prices(world, t, econ);
    const market = {};
    for (const g of GOOD_IDS) market[g] = {
      stock: r2(t.stock[g]), target: r2(econ.target[g]), buy: r2(p[g].buy), sell: r2(p[g].sell),
      prod: r2(econ.prod[g]), cons: r2(econ.cons[g]),
    };
    return {
      id: t.id, name: t.name, x: t.x, y: t.y, tx: t.tx, ty: t.ty, terrain: t.terrain, coastal: t.coastal,
      pop: Math.round(t.pop), tier: tierIndex(t.pop), sat: +t.sat.toFixed(3), resources: t.resources,
      market, trend: t.popHist.length > 24 ? Math.round(t.pop - t.popHist[t.popHist.length - 24]) : null,
    };
  });
  const counts = {};
  for (const b of world.buildings) counts[b.owner] = (counts[b.owner] || 0) + 1;
  const empires = Object.values(world.empires).map((e) => ({
    id: e.id, name: e.name, color: e.color, tier: e.tier, pop: Math.round(e.pop), land: e.land || 0, buildings: counts[e.id] || 0,
    worth: Math.round(netWorth(world, e)), worthHist: e.worthHist.slice(-72),
    leads: Object.entries(world.leaders).filter(([, id]) => id === e.id).map(([g]) => g),
  }));
  const buildings = world.buildings.map((b) => ({
    id: b.id, type: b.type, owner: b.owner, s: b.s, tx: b.tx, ty: b.ty, level: b.level || 1, paused: b.paused || undefined,
    ...(me && b.owner === me.id ? { idle: b.idle || undefined, rich: b.rich, adj: b.adj } : {}),
  }));
  const trips = world.trips.map((t) => ({
    id: t.id, owner: t.owner, kind: t.kind, from: t.from, to: t.to, pts: t.pts, cum: t.cum,
    departAt: t.departAt, arriveAt: t.arriveAt, returnAt: t.returnAt, caravans: t.caravans,
    ...(me && t.owner === me.id ? { cargo: whole(t.cargo), why: t.why, risk: t.risk || undefined } : {}),
  }));
  let mine = null;
  if (me) {
    const ec = empireEconomy(world, me, buildingsOf(world, me.id));
    const reach = {};
    for (const t of world.towns) {
      const h = homeFor(world, me, t.id);
      if (h) reach[t.id] = { hours: r2(h.rt.hours), from: h.s.id, toll: tollsDue(world, h.rt, me.id).reduce((a, r) => a + r.toll, 0), road: h.rt.roads.length > 0 };
    }
    const couriers = {};
    const cap = capitalOf(world, me.id);
    for (const o of Object.values(world.empires)) {
      if (o.id === me.id) continue;
      const oc = capitalOf(world, o.id);
      const rt = cap && oc ? route(world, cap.id, oc.id, COURIER_SPEED) : null;
      if (rt) couriers[o.id] = r2(rt.hours);
    }
    const stock = {};
    for (const g of GOOD_IDS) stock[g] = r2(me.stock[g] || 0);
    mine = {
      id: me.id, name: me.name, color: me.color, cash: r2(me.cash), tier: me.tier, pop: r2(me.pop), sat: +me.sat.toFixed(3), fill: me.fill || {},
      stock, cap: ec.cap, housing: ec.housing, jobs: ec.jobs, workers: Math.floor(ec.workers), staff: +ec.staff.toFixed(3),
      caravans: me.caravans, idle: idleCaravans(world, me), extra: me.extra || 0, land: me.land || 0,
      prod: Object.fromEntries(GOOD_IDS.map((g) => [g, r2(ec.prod[g])])),
      use: Object.fromEntries(GOOD_IDS.map((g) => [g, r2(ec.use[g])])),
      cons: Object.fromEntries(GOOD_IDS.map((g) => [g, r2(ec.cons[g])])),
      tax: r2(ec.tax), upkeep: r2(ec.upkeep), upkeepParts: { buildings: r2(ec.buildingUpkeep), caravans: r2(ec.caravanUpkeep), roads: r2(ec.roadUpkeep) },
      orders: me.orders || [], reach, couriers,
      log: me.log.slice(0, 80), stats: me.stats, worth: Math.round(netWorth(world, me)),
    };
  }
  return {
    now: Date.now(),
    clock: world.clockHours,
    seed: world.seed,
    towns, empires, buildings, trips,
    settlements: world.settlements,
    tiles: Object.entries(world.tiles).map(([k, t]) => [k, t.o, t.s]),
    roads: world.roads,
    events: world.events.map((e) => ({ id: e.id, type: e.type, town: e.town, radius: e.radius, until: e.until, text: e.text })),
    news: world.news.slice(0, 120),
    board: world.board.slice(0, 60),
    // Bids are private between bidder and seller; everyone else only sees how many there are.
    listings: world.listings.map((l) => ({
      ...l,
      bids: l.bids.filter((b) => me && (l.seller === me.id || b.bidder === me.id)),
      bidCount: l.bids.length,
    })),
    offers: me ? world.offers.filter((o) => o.to === me.id || o.from === me.id) : [],
    me: mine,
  };
}

app.get('/api/state', need, (req, res) => {
  advance(world);
  sendJson(req, res, publicState(req.user));
});

app.get('/api/town/:id', need, (req, res) => {
  const t = townById(world, req.params.id);
  if (!t) return res.status(404).json({ error: 'Unknown town.' });
  res.json({ id: t.id, priceHist: t.priceHist, popHist: t.popHist.slice(-72), tierName: TIERS[tierIndex(t.pop)].name });
});

app.post('/api/empire', need, async (req, res) => {
  try {
    advance(world);
    createEmpire(world, cid(req.user), req.body || {});
    save();
    sendJson(req, res, publicState(req.user));
  } catch (e) {
    if (e instanceof GameError) return res.status(400).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/action', need, (req, res) => {
  const a = req.body || {};
  const e = world.empires[cid(req.user)];
  if (!e) return res.status(400).json({ error: 'Found your empire first.' });
  const fn = Object.hasOwn(ACTIONS, a.type) ? ACTIONS[a.type] : null;
  if (!fn) return res.status(400).json({ error: 'Unknown action.' });
  try {
    advance(world);
    const r = fn(world, e, a) || {};
    save();
    sendJson(req, res, { ...r, state: publicState(req.user) });
  } catch (err) {
    if (err instanceof GameError) return res.status(400).json({ error: err.message });
    console.error(err); res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true, clock: world.clockHours }));

app.use('/shared', express.static(path.join(ROOT, 'shared'), { maxAge: '5m' }));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '5m' }));

app.listen(PORT, () => console.log(`Saltroad on :${PORT} (${store.kind} storage)`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
  try { advance(world); await store.saveWorld(world); } finally { process.exit(0); }
});
