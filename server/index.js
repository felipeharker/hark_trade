// Saltroad server: auth, the world clock, and a small JSON API.
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './db.js';
import { generateWorld } from './world.js';
import { advance, initStocks, townEconomy, prices, netWorth, townById, warehouseCap } from './sim.js';
import { ACTIONS, createCompany, GameError } from './actions.js';
import { tierIndex, TIERS, GOOD_IDS } from '../shared/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const INVITE_CODE = process.env.INVITE_CODE || '';
const TICK_MS = 20_000;

const store = await openStore();
const SECRET = process.env.SESSION_SECRET || (await store.secret());

let world = await store.loadWorld();
if (!world) {
  world = generateWorld(process.env.WORLD_SEED ? Number(process.env.WORLD_SEED) : undefined);
  initStocks(world);
  // let the world settle for a simulated day before anyone arrives
  const start = world.lastTick;
  world.lastTick = start - 24 * 3600e3;
  advance(world, start);
  world.news = [];
  world.news.unshift({ t: Date.now(), text: 'The trading season opens. The roads are empty and the markets are waiting.', kind: 'world' });
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
  res.json({ user: { id: req.user.id, username: req.user.username, admin: req.user.is_admin }, company: !!world.companies[cid(req.user)] });
});

app.post('/api/password', need, async (req, res) => {
  const { current, next: nw } = req.body || {};
  const u = await store.findUser(req.user.username);
  if (!checkPassword(String(current || ''), u.pass_hash)) return res.status(401).json({ error: 'Current password is wrong.' });
  if (String(nw || '').length < 6) return res.status(400).json({ error: 'Use at least 6 characters.' });
  await store.setPassword(u.id, hashPassword(String(nw)));
  res.json({ ok: true });
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
function publicState(user) {
  const me = user ? world.companies[cid(user)] : null;
  const towns = world.towns.filter((t) => t.known).map((t) => {
    const econ = townEconomy(world, t);
    const p = prices(world, t, econ);
    const market = {};
    for (const g of GOOD_IDS) market[g] = {
      stock: Math.floor(t.stock[g]), buy: +p[g].buy.toFixed(2), sell: +p[g].sell.toFixed(2),
      prod: +econ.prod[g].toFixed(2), cons: +econ.cons[g].toFixed(2),
    };
    return {
      id: t.id, name: t.name, x: t.x, y: t.y, terrain: t.terrain, coastal: t.coastal,
      pop: Math.round(t.pop), tier: tierIndex(t.pop), sat: +t.sat.toFixed(3), resources: t.resources,
      market, foundedBy: t.foundedBy, trend: t.popHist.length > 24 ? Math.round(t.pop - t.popHist[t.popHist.length - 24]) : null,
    };
  });
  const companies = Object.values(world.companies).map((c) => ({
    id: c.id, name: c.name, color: c.color, home: c.home, worth: Math.round(netWorth(world, c)), worthHist: c.worthHist.slice(-72),
    monopolies: Object.entries(world.monopolies).filter(([, id]) => id === c.id).map(([g]) => g),
  }));
  const caravans = world.caravans.map((c) => {
    const mine = me && c.owner === me.id;
    const n = Object.values(c.cargo).reduce((a, b) => a + b, 0);
    return {
      id: c.id, owner: c.owner, type: c.type, name: c.name, at: c.at, from: c.from, to: c.to,
      departAt: c.departAt, arriveAt: c.arriveAt, viaRoad: c.viaRoad, load: Math.floor(n),
      cargo: mine ? Object.fromEntries(Object.entries(c.cargo).map(([g, q]) => [g, Math.floor(q)]).filter(([, q]) => q > 0)) : undefined,
      route: mine ? c.route : c.route ? { stops: c.route.stops.map((s) => ({ town: s.town })) } : null,
    };
  });
  const buildings = world.buildings.map((b) => {
    const mine = me && b.owner === me.id;
    return {
      id: b.id, type: b.type, owner: b.owner, town: b.town, good: b.good, level: b.level, idle: b.idle,
      stock: mine && b.stock ? Object.fromEntries(Object.entries(b.stock).map(([g, q]) => [g, Math.floor(q)]).filter(([, q]) => q > 0)) : undefined,
      cap: b.type === 'warehouse' ? warehouseCap(b) : undefined,
    };
  });
  return {
    now: Date.now(),
    clock: world.clockHours,
    seed: world.seed,
    hiddenLeft: world.towns.filter((t) => !t.known).length,
    towns, companies, caravans, buildings,
    roads: world.roads,
    events: world.events.map((e) => ({ id: e.id, type: e.type, town: e.town, radius: e.radius, until: e.until, text: e.text })),
    news: world.news.slice(0, 120),
    board: world.board.slice(0, 60),
    offers: me ? (world.offers || []).filter((o) => o.to === me.id || o.from === me.id) : [],
    me: me ? { id: me.id, name: me.name, color: me.color, cash: me.cash, home: me.home, log: me.log.slice(0, 60), stats: me.stats, worth: Math.round(netWorth(world, me)) } : null,
  };
}

app.get('/api/state', need, (req, res) => {
  advance(world);
  res.json(publicState(req.user));
});

app.get('/api/town/:id', need, (req, res) => {
  const t = townById(world, req.params.id);
  if (!t || !t.known) return res.status(404).json({ error: 'Unknown town.' });
  res.json({ id: t.id, priceHist: t.priceHist, popHist: t.popHist.slice(-72), tierName: TIERS[tierIndex(t.pop)].name });
});

app.post('/api/company', need, async (req, res) => {
  try {
    advance(world);
    createCompany(world, cid(req.user), req.body || {});
    save();
    res.json(publicState(req.user));
  } catch (e) {
    if (e instanceof GameError) return res.status(400).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/action', need, (req, res) => {
  const a = req.body || {};
  const co = world.companies[cid(req.user)];
  if (!co) return res.status(400).json({ error: 'Found your company first.' });
  const fn = Object.hasOwn(ACTIONS, a.type) ? ACTIONS[a.type] : null;
  if (!fn) return res.status(400).json({ error: 'Unknown action.' });
  try {
    advance(world);
    const r = fn(world, co, a) || {};
    save();
    res.json({ ...r, state: publicState(req.user) });
  } catch (e) {
    if (e instanceof GameError) return res.status(400).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true, clock: world.clockHours }));

app.use('/shared', express.static(path.join(ROOT, 'shared'), { maxAge: '5m' }));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '5m' }));

app.listen(PORT, () => console.log(`Saltroad on :${PORT} (${store.kind} storage)`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
  try { advance(world); await store.saveWorld(world); } finally { process.exit(0); }
});
