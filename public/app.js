// Saltroad client: sign-in, founding a company, and the game UI over the map.
import { GOODS, GOOD_IDS, TIERS, VEHICLES, BUILDINGS, ROAD, EXPEDITION_COST, COMPANY_COLORS, dist, roadKey } from '/shared/data.js';
import { MapView } from './map.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n < 0 ? '−ƒ' : 'ƒ') + Math.abs(Math.round(n)).toLocaleString('en-US');
const price = (n) => 'ƒ' + (n >= 100 ? Math.round(n) : n.toFixed(1));
const lc = (g) => GOODS[g].name.toLowerCase();

function dur(ms) {
  ms = Math.max(0, ms);
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
function ago(t) {
  const s = (Date.now() + skew - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function when(t) {
  const d = new Date(t);
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Request failed (${r.status})`); e.status = r.status; throw e; }
  return j;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 4500 : 2600);
}

// ---------- state ----------
let S = null; // latest server state
let skew = 0;
const ui = { sel: null, tab: 'caravans', withId: null, qty: 10, newsOpen: true, townCache: {}, pick: null, routeDraft: null };
const T = (id) => S?.towns.find((t) => t.id === id);
const CO = (id) => S?.companies.find((c) => c.id === id);
const mine = () => (S?.me ? S.caravans.filter((c) => c.owner === S.me.id) : []);
const myWorks = () => (S?.me ? S.buildings.filter((b) => b.owner === S.me.id) : []);
const myWarehouse = (town) => S?.buildings.find((b) => b.type === 'warehouse' && b.owner === S.me?.id && b.town === town);

const map = new MapView($('#map'), {
  onTown: (id) => select({ kind: 'town', id }),
  onCaravan: (id) => select({ kind: 'caravan', id }),
  onRoad: (id) => select({ kind: 'road', id }),
  onEmpty: () => select(null),
});

function select(sel) {
  ui.sel = sel;
  map.sel = sel;
  if (sel?.kind === 'town') loadTownDetail(sel.id);
  renderInspector(true);
  renderCompany();
}

async function loadTownDetail(id) {
  const c = ui.townCache[id];
  if (c && Date.now() - c.at < 60e3) return;
  try {
    const d = await api('/api/town/' + id);
    ui.townCache[id] = { at: Date.now(), ...d };
    if (ui.sel?.kind === 'town' && ui.sel.id === id) renderInspector(true);
  } catch { /* ignore */ }
}

function apply(st) {
  S = st;
  skew = st.now - Date.now();
  map.setState(st);
  if (ui.sel?.kind === 'caravan' && !st.caravans.some((c) => c.id === ui.sel.id)) ui.sel = null;
  if (!st.me) return;
  renderTop(); renderCompany(); renderInspector(); renderNews();
}

async function refresh() {
  try { apply(await api('/api/state')); }
  catch (e) { if (e.status === 401) location.reload(); }
}

async function act(body, okMsg) {
  try {
    const r = await api('/api/action', body);
    apply(r.state);
    toast(okMsg || r.msg || 'Done');
    return r;
  } catch (e) { toast(e.message, true); return null; }
}

// ---------- top bar ----------
function renderTop() {
  const me = S.me;
  const day = Math.floor(S.clock / 24) + 1;
  $('#topbar').innerHTML = `
    <div class="brand"><span class="mark"><svg width="16" height="16" viewBox="0 0 32 32"><path d="M5 24 L16 7 L27 24" stroke="white" stroke-width="3.5" fill="none" stroke-linejoin="round"/><circle cx="16" cy="24" r="3" fill="white"/></svg></span>Saltroad <small class="hide-sm">Day ${day}</small></div>
    <div class="cohead"><span class="swatch" style="background:${me.color}"></span>${esc(me.name)}</div>
    <div class="stat"><b class="num ${me.cash < 0 ? 'bad' : ''}">${money(me.cash)}</b><span>Cash</span></div>
    <div class="stat hide-sm"><b class="num">${money(me.worth)}</b><span>Worth</span></div>
    <div class="spacer"></div>
    <button class="btn ghost" data-act="ledger">Standings</button>
    <button class="btn ghost" data-act="board">Exchange</button>
    <button class="btn ghost" data-act="help">How to play</button>
    <button class="btn ghost" data-act="menu" aria-label="Menu">☰</button>`;
}

// ---------- company panel ----------
function caravanStatus(c) {
  const now = Date.now() + skew;
  if (c.at) return `At ${esc(T(c.at)?.name)}${c.route ? ' · on route' : ''}`;
  return `To ${esc(T(c.to)?.name)} · ${dur(c.arriveAt - now)}${c.viaRoad ? ' · road' : ''}`;
}

function renderCompany() {
  const el = $('#company');
  if (!S?.me) return;
  const tabs = [['caravans', 'Caravans'], ['works', 'Works'], ['roads', 'Roads'], ['log', 'Log']];
  let body = '';
  if (ui.tab === 'caravans') {
    const cs = mine();
    body = `<ul class="list">${cs.map((c) => `
      <li class="click ${ui.sel?.kind === 'caravan' && ui.sel.id === c.id ? 'sel' : ''}" data-act="sel-caravan" data-id="${c.id}">
        <span class="swatch" style="background:${S.me.color}"></span>
        <div class="grow"><div class="title">${esc(c.name)}</div><div class="sub">${caravanStatus(c)}</div></div>
        <span class="num small muted">${c.load}/${VEHICLES[c.type].capacity}</span>
      </li>`).join('')}</ul>
      <div class="pbody"><p class="note">Buy more vehicles at your home town (${esc(T(S.me.home)?.name)}) or any town where you have a warehouse.</p></div>`;
  } else if (ui.tab === 'works') {
    const ws = myWorks();
    body = ws.length ? `<ul class="list">${ws.map((b) => `
      <li class="click" data-act="sel-town" data-id="${b.town}">
        <div class="grow"><div class="title">${esc(b.type === 'estate' ? `${GOODS[b.good].name} estate` : BUILDINGS[b.type].name)}</div>
        <div class="sub">${esc(T(b.town)?.name)}${b.type === 'warehouse' ? ` · ${Object.values(b.stock || {}).reduce((a, x) => a + x, 0)}/${b.cap} stored` : b.idle ? ' · idle, needs inputs' : ''}</div></div>
      </li>`).join('')}</ul>` : '<div class="pbody"><p class="note">No works yet. Open a town and build a warehouse to start storing goods, then estates and workshops to make them.</p></div>';
  } else if (ui.tab === 'roads') {
    const rs = S.roads.filter((r) => r.owner === S.me.id);
    body = rs.length ? `<ul class="list">${rs.map((r) => `
      <li class="click" data-act="sel-road" data-id="${r.id}">
        <div class="grow"><div class="title">${esc(T(r.a)?.name)} – ${esc(T(r.b)?.name)}</div><div class="sub">${r.length} leagues · toll ${money(r.toll)}</div></div>
      </li>`).join('')}</ul>` : '<div class="pbody"><p class="note">No roads yet. Roads make caravans 80% faster, keep bandits off, help towns grow, and earn you a toll from every rival who uses them.</p></div>';
    body += `<div class="pbody"><p class="note">Tolls earned so far: <span class="num">${money(S.me.stats.tolls || 0)}</span></p></div>`;
  } else {
    body = `<ul class="feed">${S.me.log.map((l) => `<li><time>${ago(l.t)}</time>${esc(l.text)}</li>`).join('')}</ul>`;
  }
  const offers = S.offers.filter((o) => o.to === S.me.id);
  el.innerHTML = `
    <div class="tabs">${tabs.map(([k, n]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-act="tab" data-id="${k}">${n}</button>`).join('')}</div>
    ${offers.length ? `<div class="section">${offers.map((o) => {
      const r = S.roads.find((x) => x.id === o.road);
      return `<div class="row small"><b>${esc(CO(o.from)?.name)}</b> offers you the ${esc(T(r?.a)?.name)}–${esc(T(r?.b)?.name)} road for <span class="num">${money(o.price)}</span>
        <button class="btn tiny primary" data-act="offer-accept" data-id="${o.id}">Accept</button><button class="btn tiny" data-act="offer-decline" data-id="${o.id}">Decline</button></div>`;
    }).join('')}</div>` : ''}
    <div class="scroll">${body}</div>`;
}

// ---------- news ----------
function renderNews() {
  const el = $('#news');
  el.classList.toggle('collapsed', !ui.newsOpen);
  el.innerHTML = `
    <div class="phead"><h3>The Gazette</h3><button class="btn ghost tiny x" data-act="news-toggle">${ui.newsOpen ? 'Hide' : 'Show'}</button></div>
    <ul class="feed">${S.news.slice(0, 60).map((n) => `<li class="k-${n.kind}"><time>${ago(n.t)}</time>${esc(n.text)}</li>`).join('')}</ul>`;
}

// ---------- inspector ----------
function spark(vals, w = 40, h = 14) {
  if (!vals || vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - min) / (max - min || 1)) * (h - 2)).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${up ? 'var(--bad)' : 'var(--good)'}" stroke-width="1.3"/></svg>`;
}

function renderInspector(force = false) {
  const el = $('#inspector');
  if (!S) return;
  const a = document.activeElement;
  if (!force && a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return;
  const sel = ui.sel;
  if (!sel) { el.hidden = true; return; }
  el.hidden = false;
  const scroll = el.scrollTop;
  if (sel.kind === 'town') el.innerHTML = townHtml(T(sel.id));
  else if (sel.kind === 'caravan') el.innerHTML = caravanHtml(S.caravans.find((c) => c.id === sel.id));
  else if (sel.kind === 'road') el.innerHTML = roadHtml(S.roads.find((r) => r.id === sel.id));
  el.scrollTop = scroll;
}

function townHtml(t) {
  if (!t) return '';
  const me = S.me;
  const detail = ui.townCache[t.id];
  const tier = TIERS[t.tier];
  const here = mine().filter((c) => c.at === t.id);
  const wh = myWarehouse(t.id);
  // who we trade with: a caravan here, or our warehouse
  let withId = ui.withId;
  if (!(withId === 'store' && wh) && !here.some((c) => c.id === withId)) withId = here[0]?.id || (wh ? 'store' : null);
  ui.withId = withId;
  const carrier = withId === 'store' ? wh : here.find((c) => c.id === withId);
  const holding = withId === 'store' ? wh?.stock || {} : carrier?.cargo || {};
  const events = S.events.filter((e) => e.town === t.id || (e.radius && dist(T(e.town) || t, t) <= e.radius));
  const needs = new Set(GOOD_IDS.filter((g) => t.market[g].cons > 0));
  const rows = GOOD_IDS.map((g) => {
    const m = t.market[g];
    const have = holding[g] || 0;
    const tradeBtns = carrier ? `<span class="acts">
        <button class="btn tiny" data-act="trade" data-op="buy" data-good="${g}" title="Buy ${ui.qty}">Buy</button>
        <button class="btn tiny" data-act="trade" data-op="sell" data-good="${g}" ${have ? '' : 'disabled'} title="Sell ${ui.qty}">Sell</button>
        ${withId !== 'store' && wh ? `<button class="btn tiny ghost" data-act="xfer" data-op="unload" data-good="${g}" ${have ? '' : 'disabled'} title="Put into your warehouse">↓</button><button class="btn tiny ghost" data-act="xfer" data-op="load" data-good="${g}" ${wh.stock?.[g] ? '' : 'disabled'} title="Load from your warehouse">↑</button>` : ''}
      </span>` : '';
    const flow = m.prod > m.cons ? `<span class="good" title="Produced here, ${m.prod}/h">▲</span>` : m.cons > 0 ? `<span class="warn" title="Consumed here, ${m.cons}/h">▼</span>` : '';
    return `<tr class="${needs.has(g) && m.stock < m.cons * 4 ? 'need' : ''}">
      <td><span class="gd"><span class="swatch" style="background:${GOODS[g].color}"></span>${GOODS[g].name}</span> ${flow}</td>
      <td class="num">${m.stock}</td>
      <td class="num">${price(m.buy)}</td>
      <td class="num">${price(m.sell)}</td>
      <td class="sp">${spark(detail?.priceHist?.[g]?.slice(-24))}</td>
      ${carrier ? `<td class="num muted">${have || ''}</td><td>${tradeBtns}</td>` : ''}
    </tr>`;
  }).join('');
  const works = S.buildings.filter((b) => b.town === t.id);
  const roads = S.roads.filter((r) => r.a === t.id || r.b === t.id);
  const capOf = (c) => VEHICLES[c.type].capacity;
  const canBuyVehicle = t.id === me.home || wh;
  const myCount = works.filter((b) => b.owner === me.id && b.type !== 'warehouse').length;
  return `
    <div class="phead"><h2>${esc(t.name)}</h2><span class="muted small">${tier.name}${t.id === me.home ? ' · your home' : ''}</span><button class="btn ghost tiny x" data-act="close">✕</button></div>
    <div class="section">
      <dl class="kv">
        <dt>People</dt><dd class="num">${t.pop.toLocaleString()} ${t.trend != null ? `<span class="${t.trend >= 0 ? 'good' : 'bad'}">${t.trend >= 0 ? '+' : ''}${t.trend}/day</span>` : ''}</dd>
        <dt>Needs met</dt><dd><div class="bar" style="width:120px;display:inline-block"><i style="width:${Math.round(t.sat * 100)}%;background:${t.sat > 0.6 ? 'var(--good)' : t.sat > 0.45 ? 'var(--warn)' : 'var(--bad)'}"></i></div> <span class="num">${Math.round(t.sat * 100)}%</span></dd>
        <dt>Land</dt><dd>${t.terrain}${t.coastal ? ', by water' : ''}</dd>
      </dl>
      <div class="chips" style="margin-top:8px">${t.resources.map((r) => `<span class="chip"><span class="swatch" style="background:${GOODS[r.good].color}"></span>${GOODS[r.good].name} ${r.rich >= 1.15 ? '(rich)' : r.rich < 0.8 ? '(poor)' : ''}</span>`).join('')}
        ${events.map((e) => `<span class="chip event" title="${esc(e.text)}">${e.type} · ${dur(e.until - Date.now() - skew)}</span>`).join('')}</div>
      ${t.tier < TIERS.length - 1 ? `<p class="note">Grows into a ${TIERS[t.tier + 1].name.toLowerCase()} at ${TIERS[t.tier + 1].min.toLocaleString()} people, which will want ${Object.keys(TIERS[t.tier + 1].needs).map(lc).join(', ') || 'more of everything'}.</p>` : ''}
    </div>
    <div class="section">
      <h4>Market</h4>
      ${carrier || here.length || wh ? `<div class="row" style="margin-bottom:6px">
        <span class="small muted">Trade with</span>
        <select class="in" data-input="with">${here.map((c) => `<option value="${c.id}" ${c.id === withId ? 'selected' : ''}>${esc(c.name)} (${c.load}/${capOf(c)})</option>`).join('')}${wh ? `<option value="store" ${withId === 'store' ? 'selected' : ''}>Warehouse (${Object.values(wh.stock || {}).reduce((a, x) => a + x, 0)}/${wh.cap})</option>` : ''}</select>
        <span class="small muted">Qty</span><input class="in qty" type="number" min="1" value="${ui.qty}" data-input="qty">
      </div>` : '<p class="note" style="margin-top:0">Bring a caravan here to trade. ▲ made here (cheap), ▼ used here; a dot means it is running short.</p>'}
      <table class="market"><thead><tr><th>Good</th><th>Stock</th><th>Buy</th><th>Sell</th><th class="sp">24h</th>${carrier ? '<th>Have</th><th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table>
    </div>
    <div class="section">
      <h4>Works here</h4>
      ${works.length ? `<ul class="list" style="margin:0 -12px">${works.map((b) => {
        const co = CO(b.owner);
        const isMine = b.owner === me.id;
        const name = b.type === 'estate' ? `${GOODS[b.good].name} estate` : BUILDINGS[b.type].name;
        let sub = esc(co?.name);
        if (isMine && b.type === 'warehouse') sub = Object.entries(b.stock || {}).map(([g, q]) => `${q} ${lc(g)}`).join(', ') || 'empty';
        if (isMine && b.idle) sub = 'idle: put inputs in your warehouse';
        return `<li><span class="swatch" style="background:${co?.color}"></span><div class="grow"><div class="title">${name}${b.level > 1 ? ` (size ${b.level})` : ''}</div><div class="sub">${sub}</div></div>
          ${isMine && b.type === 'warehouse' && (b.level || 1) < 5 ? `<button class="btn tiny" data-act="expand" data-id="${t.id}" title="Add 300 storage">Expand ${money(600 * (b.level || 1))}</button>` : ''}
          ${isMine ? `<button class="btn tiny ghost danger" data-act="demolish" data-id="${b.id}" title="Pull down (refunds 30%)">✕</button>` : ''}</li>`;
      }).join('')}</ul>` : '<p class="note" style="margin-top:0">Nobody has built here yet.</p>'}
    </div>
    <div class="section">
      <h4>Build</h4>
      ${!wh ? `<div class="row"><button class="btn" data-act="build" data-type="warehouse" data-town="${t.id}">Warehouse · ${money(BUILDINGS.warehouse.cost)}</button></div><p class="note">${BUILDINGS.warehouse.blurb}</p>` : myCount < 3 ? `
        <div class="row"><select class="in" data-input="estate-good">${t.resources.map((r) => `<option value="${r.good}">${GOODS[r.good].name}</option>`).join('')}</select>
          <button class="btn" data-act="build" data-type="estate" data-town="${t.id}">Estate · ${money(BUILDINGS.estate.cost)}</button></div>
        <div class="row">${['weaver', 'brewery', 'smithy'].map((k) => `<button class="btn" data-act="build" data-type="${k}" data-town="${t.id}" title="${esc(BUILDINGS[k].blurb)}">${BUILDINGS[k].name} · ${money(BUILDINGS[k].cost)}</button>`).join('')}</div>
        <p class="note">Estates make local goods. Weavers turn wool into cloth, breweries grain into ale, smithies iron and timber into tools. Output lands in your warehouse.</p>` : '<p class="note">You have three works here, the most a town allows.</p>'}
      <div class="row" style="margin-top:8px">
        <button class="btn" data-act="road" data-id="${t.id}">Road to…</button>
        ${canBuyVehicle ? Object.entries(VEHICLES).map(([k, v]) => `<button class="btn" data-act="buy-vehicle" data-type="${k}" data-town="${t.id}" title="${v.capacity} cargo, ${v.speed} leagues/h, ${money(v.upkeep)}/h upkeep">${v.name} · ${money(v.cost)}</button>`).join('') : ''}
      </div>
      ${S.hiddenLeft ? `<div class="row" style="margin-top:8px"><input class="in" placeholder="Name the new town (optional)" data-input="exp-name" style="flex:1"><button class="btn" data-act="expedition" data-id="${t.id}">Expedition · ${money(EXPEDITION_COST)}</button></div>
        <p class="note">Sends scouts past ${esc(t.name)} to find the nearest unmapped town. You get to name it.</p>` : ''}
    </div>
    ${roads.length ? `<div class="section"><h4>Roads</h4><ul class="list" style="margin:0 -12px">${roads.map((r) => {
      const o = r.a === t.id ? r.b : r.a;
      return `<li class="click" data-act="sel-road" data-id="${r.id}"><span class="swatch" style="background:${CO(r.owner)?.color}"></span><div class="grow"><div class="title">to ${esc(T(o)?.name)}</div><div class="sub">${esc(CO(r.owner)?.name)} · toll ${money(r.toll)}</div></div></li>`;
    }).join('')}</ul></div>` : ''}`;
}

function caravanHtml(c) {
  if (!c) return '';
  const co = CO(c.owner);
  const isMine = c.owner === S.me.id;
  const v = VEHICLES[c.type];
  const now = Date.now() + skew;
  let where;
  if (c.at) where = `At <a href="#" data-act="sel-town" data-id="${c.at}">${esc(T(c.at)?.name)}</a>`;
  else where = `On the way from ${esc(T(c.from)?.name)} to <a href="#" data-act="sel-town" data-id="${c.to}">${esc(T(c.to)?.name)}</a>, arriving in <b class="num">${dur(c.arriveAt - now)}</b> (${when(c.arriveAt - skew)})${c.viaRoad ? ' by road' : ''}`;
  if (!isMine) {
    return `<div class="phead"><span class="swatch" style="background:${co?.color}"></span><h2>${esc(c.name)}</h2><button class="btn ghost tiny x" data-act="close">✕</button></div>
      <div class="section"><p style="margin:0">${esc(co?.name)}'s ${v.name.toLowerCase()}, carrying ${c.load} of ${v.capacity}.</p><p class="note">${where}</p>
      ${c.route ? `<p class="note">Runs a route: ${c.route.stops.map((s) => esc(T(s.town)?.name)).join(' → ')}</p>` : ''}</div>`;
  }
  const cargo = Object.entries(c.cargo || {});
  const route = c.route;
  return `
    <div class="phead"><span class="swatch" style="background:${co?.color}"></span><h2>${esc(c.name)}</h2><span class="muted small">${v.name}</span><button class="btn ghost tiny x" data-act="close">✕</button></div>
    <div class="section"><p style="margin:0">${where}.</p>
      <div class="row" style="margin-top:8px"><div class="bar" style="flex:1"><i style="width:${(c.load / v.capacity) * 100}%"></i></div><span class="num small">${c.load}/${v.capacity}</span></div>
      <p class="note">${cargo.length ? cargo.map(([g, q]) => `${q} ${lc(g)}`).join(', ') : 'Empty.'}</p>
      <p class="note">${v.speed} leagues an hour (${Math.round(v.speed * ROAD.speedMult)} on roads) · upkeep ${money(v.upkeep)}/h</p>
    </div>
    <div class="section"><h4>Orders</h4>
      <div class="row">
        ${c.at ? `<button class="btn primary" data-act="send" data-id="${c.id}">Send to…</button><button class="btn" data-act="sel-town" data-id="${c.at}">Trade here</button>` : ''}
        <button class="btn" data-act="route" data-id="${c.id}">${route ? 'Edit route' : 'Set up a route'}</button>
        ${route ? `<button class="btn" data-act="stop-route" data-id="${c.id}">Stop route</button>` : ''}
      </div>
      ${route ? `<p class="note">Route: ${route.stops.map((s, i) => `<b style="${i === route.idx ? 'color:var(--accent)' : ''}">${esc(T(s.town)?.name)}</b>${s.orders.length ? ` (${s.orders.map((o) => `${o.op} ${lc(o.good)}`).join(', ')})` : ''}`).join(' → ')} → repeat</p>`
        : '<p class="note">A route keeps the caravan trading on its own while you are away: it buys and sells at each stop, then moves on, forever.</p>'}
    </div>
    <div class="section"><h4>Vehicle</h4>
      <div class="row"><input class="in" value="${esc(c.name)}" data-input="rename" style="flex:1"><button class="btn" data-act="rename" data-id="${c.id}">Rename</button></div>
      ${c.at ? `<div class="row"><button class="btn danger" data-act="sell-vehicle" data-id="${c.id}">Sell for ${money(v.cost * 0.5)}</button></div>` : ''}
    </div>`;
}

function roadHtml(r) {
  if (!r) return '';
  const co = CO(r.owner);
  const isMine = r.owner === S.me.id;
  const others = S.companies.filter((c) => c.id !== S.me.id);
  return `<div class="phead"><span class="swatch" style="background:${co?.color}"></span><h2>${esc(T(r.a)?.name)} – ${esc(T(r.b)?.name)}</h2><button class="btn ghost tiny x" data-act="close">✕</button></div>
    <div class="section"><dl class="kv"><dt>Owner</dt><dd>${esc(co?.name)}</dd><dt>Length</dt><dd class="num">${r.length} leagues</dd><dt>Toll</dt><dd class="num">${money(r.toll)} per trip</dd><dt>Built</dt><dd>${ago(r.builtAt)}</dd></dl>
    <p class="note">Caravans on a road travel ${ROAD.speedMult}× as fast and are safe from bandits. The owner travels free; everyone else pays the toll.</p></div>
    ${isMine ? `<div class="section"><h4>Manage</h4>
      <div class="row"><span class="small muted">Toll</span><input class="in qty" type="number" min="0" max="200" value="${r.toll}" data-input="toll"><button class="btn" data-act="toll" data-id="${r.id}">Set toll</button></div>
      ${others.length ? `<div class="row"><span class="small muted">Sell to</span><select class="in" data-input="sell-to">${others.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><input class="in qty" type="number" min="0" value="${Math.round(r.cost * 0.6)}" data-input="sell-price"><button class="btn" data-act="sell-road" data-id="${r.id}">Offer</button></div>` : ''}
    </div>` : ''}`;
}

// ---------- picking towns on the map ----------
function startPick(label, filter, done) {
  ui.pick = { label, filter, done };
  map.pick = { filter, done: (t) => { endPick(); done(t); } };
  $('#map').classList.add('picking');
  const bar = $('#pickbar');
  bar.innerHTML = `<span>${label}</span><button class="btn tiny" data-act="pick-cancel">Cancel</button>`;
  bar.hidden = false;
}
function endPick() {
  ui.pick = null; map.pick = null;
  $('#map').classList.remove('picking');
  $('#pickbar').hidden = true;
}

// ---------- route editor ----------
// Suggest a sensible price limit so a route does not buy at any price once a market dries up.
function autoLimit(town, o) {
  if (o.auto === false) return;
  const t = T(town);
  o.auto = true;
  if (!t || (o.op !== 'buy' && o.op !== 'sell')) { o.limit = 0; return; }
  const base = GOODS[o.good].base;
  o.limit = o.op === 'buy' ? Math.round(Math.max(t.market[o.good].buy * 1.25, base * 0.6) * 2) / 2 : Math.round(base * 0.5 * 2) / 2;
}

function openRoute(c) {
  const existing = c.route?.stops;
  ui.routeDraft = {
    caravan: c.id,
    stops: existing ? JSON.parse(JSON.stringify(existing)).map((s) => ({ ...s, orders: s.orders.map((o) => ({ ...o, auto: false })) })) : [
      { town: c.at || c.to, orders: [] },
      { town: '', orders: [] },
    ],
  };
  renderRoute();
}

function renderRoute() {
  const d = ui.routeDraft;
  const c = S.caravans.find((x) => x.id === d.caravan);
  const towns = [...S.towns].sort((a, b) => a.name.localeCompare(b.name));
  const opt = (sel) => `<option value="">Choose a town…</option>` + towns.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const hint = (town, o) => {
    const t = T(town); if (!t || !o.good) return '';
    const m = t.market[o.good];
    return o.op === 'buy' ? `now ${price(m.buy)}, ${m.stock} in stock` : o.op === 'sell' ? `now ${price(m.sell)}` : '';
  };
  let legs = 0;
  for (let i = 0; i < d.stops.length; i++) {
    const a = T(d.stops[i].town), b = T(d.stops[(i + 1) % d.stops.length].town);
    if (a && b) legs += dist(a, b) / (VEHICLES[c.type].speed * (S.roads.some((r) => r.key === roadKey(a.id, b.id)) ? ROAD.speedMult : 1));
  }
  const m = $('#modal');
  m.innerHTML = `<div class="card panel wide">
    <div class="phead"><h2>Route for ${esc(c.name)}</h2><span class="muted small">${VEHICLES[c.type].capacity} cargo</span><button class="btn ghost tiny x" data-act="modal-close">✕</button></div>
    <div class="pbody">
      <p class="note" style="margin-top:0">The caravan visits each stop in order, carries out its orders, then moves on, looping forever. Quantity 0 means as much as possible. The price limit is the most you will pay when buying, or the least you will take when selling (0 means any price).</p>
      ${d.stops.map((s, i) => `<div class="stop">
        <div class="head"><b>${i + 1}</b><select class="in" data-rinput="town" data-i="${i}">${opt(s.town)}</select>
          <button class="btn tiny ghost" data-act="r-up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn tiny ghost" data-act="r-down" data-i="${i}" ${i === d.stops.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn tiny ghost danger" data-act="r-del" data-i="${i}" ${d.stops.length <= 2 ? 'disabled' : ''}>Remove stop</button></div>
        ${s.orders.map((o, j) => `<div class="order">
          <select class="in" data-rinput="op" data-i="${i}" data-j="${j}">${['buy', 'sell', 'load', 'unload'].map((x) => `<option value="${x}" ${o.op === x ? 'selected' : ''}>${x === 'load' ? 'load from warehouse' : x === 'unload' ? 'unload to warehouse' : x}</option>`).join('')}</select>
          <select class="in" data-rinput="good" data-i="${i}" data-j="${j}">${GOOD_IDS.map((g) => `<option value="${g}" ${o.good === g ? 'selected' : ''}>${GOODS[g].name}</option>`).join('')}</select>
          <span class="small muted">qty</span><input class="in qty" type="number" min="0" value="${o.qty || 0}" data-rinput="qty" data-i="${i}" data-j="${j}">
          ${o.op === 'buy' || o.op === 'sell' ? `<span class="small muted">${o.op === 'buy' ? 'max' : 'min'} ƒ</span><input class="in qty" type="number" min="0" step="0.5" value="${o.limit || 0}" data-rinput="limit" data-i="${i}" data-j="${j}">` : ''}
          <span class="hint">${hint(s.town, o)}</span>
          <button class="btn tiny ghost danger" data-act="r-odel" data-i="${i}" data-j="${j}">✕</button>
        </div>`).join('')}
        <button class="btn tiny" data-act="r-oadd" data-i="${i}">+ Order</button>
      </div>`).join('')}
      <div class="row"><button class="btn" data-act="r-add" ${d.stops.length >= 8 ? 'disabled' : ''}>+ Stop</button><span class="muted small">One loop takes about <b class="num">${dur(legs * 3600e3)}</b> of travel.</span>
        <span style="flex:1"></span><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="r-save">Start route</button></div>
    </div></div>`;
  m.hidden = false;
}

// ---------- modals ----------
function openModal(html, wide = false) {
  const m = $('#modal');
  m.innerHTML = `<div class="card panel ${wide ? 'wide' : ''}">${html}</div>`;
  m.hidden = false;
}

function ledgerHtml() {
  const cos = [...S.companies].sort((a, b) => b.worth - a.worth);
  const counts = (id) => ({
    cars: S.caravans.filter((c) => c.owner === id).length,
    works: S.buildings.filter((b) => b.owner === id).length,
    roads: S.roads.filter((r) => r.owner === id).length,
  });
  return `<div class="phead"><h2>Standings</h2><span class="muted small">No winner, just bragging rights</span><button class="btn ghost tiny x" data-act="modal-close">✕</button></div>
    <ul class="list">${cos.map((c, i) => {
      const n = counts(c.id);
      return `<li><b class="num muted">${i + 1}</b><span class="swatch" style="background:${c.color}"></span><div class="grow"><div class="title">${esc(c.name)}</div>
        <div class="sub">${n.cars} vehicles · ${n.works} works · ${n.roads} roads · home ${esc(T(c.home)?.name)}${c.monopolies.length ? ` · controls ${c.monopolies.map(lc).join(', ')}` : ''}</div></div>
        ${spark(c.worthHist.slice(-48), 70, 18).replace('var(--bad)', 'var(--good)')}<b class="num">${money(c.worth)}</b></li>`;
    }).join('')}</ul>
    <div class="pbody"><p class="note">Worth counts cash, vehicles, works, roads and goods at base value. Trade control goes to whoever moves more than half of a good's volume over the last day.</p></div>`;
}

function boardHtml() {
  const others = S.companies.filter((c) => c.id !== S.me.id);
  return `<div class="phead"><h2>The Exchange</h2><span class="muted small">Make deals, pay people, talk trash</span><button class="btn ghost tiny x" data-act="modal-close">✕</button></div>
    <div class="section"><h4>Post a notice</h4>
      <div class="row"><input class="in" style="flex:1" maxlength="280" placeholder="Selling 200 salt in Saltford, best offer…" data-input="post"><button class="btn primary" data-act="post">Post</button></div></div>
    ${others.length ? `<div class="section"><h4>Pay a company</h4>
      <div class="row"><select class="in" data-input="pay-to">${others.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <input class="in qty" type="number" min="1" value="100" data-input="pay-amount" style="width:90px"><input class="in" style="flex:1" maxlength="80" placeholder="What for (shown in the Gazette)" data-input="pay-note">
      <button class="btn" data-act="pay">Pay</button></div>
      <p class="note">Payments are public. Use them to settle deals, buy out a rival's route or rent their warehouse; the rest is on trust.</p></div>` : ''}
    <div class="section"><h4>Notices</h4>
      ${S.board.length ? `<ul class="feed" style="margin:0 -12px">${S.board.map((b) => {
        const c = CO(b.company);
        return `<li><time>${ago(b.t)}</time><b style="color:${c?.color}">${esc(c?.name)}</b>: ${esc(b.text)}</li>`;
      }).join('')}</ul>` : '<p class="note">Nothing posted yet.</p>'}
    </div>`;
}

function helpHtml() {
  return `<div class="phead"><h2>How to play</h2><button class="btn ghost tiny x" data-act="modal-close">✕</button></div>
  <div class="pbody" style="line-height:1.5">
    <p><b>There is no end and no winner.</b> The world runs in real time, all the time. One hour on the clock is one hour in the world, and caravans keep moving while you're away. Check in a few times a day.</p>
    <p><b>Trade.</b> Every town makes some goods (▲, cheap there) and uses others (▼). Prices follow stock: flood a town with salt and salt gets cheap. Click your caravan, then a town, to buy, then <i>Send to…</i> a town that needs it and sell.</p>
    <p><b>Routes.</b> Give a caravan a route (stops plus buy and sell orders with price limits) and it trades on its own, forever. This is how you make money while you sleep.</p>
    <p><b>Towns grow when they are fed.</b> A town whose needs are met grows into a village, a market town, a city. Each step wants new goods: cloth, ale and stone, then tools and iron, then spices from the far frontier. Neglected towns shrink.</p>
    <p><b>Build.</b> A warehouse stores goods in a town. Estates there produce local goods; weavers, breweries and smithies turn raw goods into cloth, ale and tools. Roads between towns are 80% faster, stop bandits, help both towns grow, and charge rivals a toll that you set.</p>
    <p><b>Explore.</b> The fog hides more towns. They appear as the known world grows, or when someone pays for an expedition (and names the town).</p>
    <p><b>Events.</b> Droughts, harvests, festivals, fires, booms and bandits come and go. Watch the Gazette.</p>
    <p><b>Each other.</b> Corner a good, undercut a rival, build the road everyone needs, sell it at a markup. The Exchange lets you post notices and pay other companies to seal deals.</p>
    <p class="note">Tip: upkeep runs whether or not you play. An idle wagon costs ƒ48 a day.</p>
  </div>`;
}

function menuHtml(me) {
  return `<div class="phead"><h2>${esc(me.username)}</h2><button class="btn ghost tiny x" data-act="modal-close">✕</button></div>
  <div class="section"><h4>Theme</h4><div class="row">
    <button class="btn" data-act="theme" data-id="">Match system</button><button class="btn" data-act="theme" data-id="light">Light</button><button class="btn" data-act="theme" data-id="dark">Dark</button></div></div>
  <div class="section"><h4>Change password</h4>
    <div class="row"><input class="in" type="password" placeholder="Current" data-input="pw-cur"><input class="in" type="password" placeholder="New" data-input="pw-new"><button class="btn" data-act="pw">Change</button></div></div>
  ${me.admin ? `<div class="section"><h4>Admin: reset a password</h4>
    <div class="row"><input class="in" placeholder="Username" data-input="ad-user"><input class="in" placeholder="New password" data-input="ad-pw"><button class="btn" data-act="admin-pw">Reset</button></div></div>` : ''}
  <div class="section"><button class="btn danger" data-act="logout">Sign out</button></div>`;
}

// ---------- events ----------
const val = (name, root = document) => root.querySelector(`[data-input="${name}"]`)?.value;

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.input === 'qty') ui.qty = Math.max(1, Math.floor(Number(t.value) || 1));
  if (t.dataset.rinput) {
    const d = ui.routeDraft;
    const i = Number(t.dataset.i), j = Number(t.dataset.j);
    const k = t.dataset.rinput;
    if (k === 'town') d.stops[i].town = t.value;
    else {
      const o = d.stops[i].orders[j];
      o[k] = k === 'qty' || k === 'limit' ? Number(t.value) || 0 : t.value;
      if (k === 'limit') o.auto = false;
      if (k === 'op' || k === 'good') autoLimit(d.stops[i].town, o);
    }
    if (k === 'town') d.stops[i].orders.forEach((o) => autoLimit(t.value, o));
    if (k === 'town' || k === 'op' || k === 'good') renderRoute();
  }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.input === 'with') { ui.withId = e.target.value; renderInspector(true); }
});

let me = null;
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  const { act: a, id } = el.dataset;
  const d = ui.routeDraft;
  switch (a) {
    case 'close': select(null); break;
    case 'tab': ui.tab = id; renderCompany(); break;
    case 'sel-caravan': {
      select({ kind: 'caravan', id });
      const c = S.caravans.find((x) => x.id === id);
      const p = c && map.caravanPos(c, Date.now() + skew);
      if (p) map.centerOn(p[0], p[1]);
      break;
    }
    case 'sel-town': { select({ kind: 'town', id }); const t = T(id); if (t) map.centerOn(t.x, t.y); break; }
    case 'sel-road': select({ kind: 'road', id }); break;
    case 'news-toggle': ui.newsOpen = !ui.newsOpen; renderNews(); break;
    case 'trade': {
      const town = ui.sel.id;
      if (ui.withId === 'store') await act({ type: 'storeTrade', town, op: el.dataset.op, good: el.dataset.good, qty: ui.qty });
      else await act({ type: 'trade', caravan: ui.withId, op: el.dataset.op, good: el.dataset.good, qty: ui.qty });
      ui.townCache[town] = null;
      break;
    }
    case 'xfer': await act({ type: 'transfer', caravan: ui.withId, op: el.dataset.op, good: el.dataset.good, qty: ui.qty }); break;
    case 'send': {
      const c = S.caravans.find((x) => x.id === id);
      startPick(`Pick a town for ${esc(c.name)}`, (t) => t.id !== c.at, async (t) => {
        const info = dist(T(c.at), t) / (VEHICLES[c.type].speed * (S.roads.some((r) => r.key === roadKey(c.at, t.id)) ? ROAD.speedMult : 1));
        const r = await act({ type: 'send', caravan: c.id, to: t.id }, `${c.name} leaves for ${t.name}, about ${dur(info * 3600e3)}`);
        if (r) select({ kind: 'caravan', id: c.id });
      });
      break;
    }
    case 'pick-cancel': endPick(); break;
    case 'route': openRoute(S.caravans.find((x) => x.id === id)); break;
    case 'stop-route': await act({ type: 'clearRoute', caravan: id }); break;
    case 'rename': await act({ type: 'renameCaravan', caravan: id, name: val('rename') }); break;
    case 'sell-vehicle': if (confirm('Sell this vehicle for half what it cost?')) await act({ type: 'sellVehicle', caravan: id }); break;
    case 'buy-vehicle': await act({ type: 'buyVehicle', kind: el.dataset.type, town: el.dataset.town }); break;
    case 'build': await act({ type: 'build', kind: el.dataset.type, town: el.dataset.town, good: val('estate-good') }); break;
    case 'expand': await act({ type: 'expandWarehouse', town: id }); break;
    case 'demolish': if (confirm('Pull this down? You get 30% back.')) await act({ type: 'demolish', building: id }); break;
    case 'road': {
      const A = T(id);
      startPick(`Pick the other end of a road from ${esc(A.name)}`, (t) => t.id !== A.id && dist(A, t) <= ROAD.maxLength && !S.roads.some((r) => r.key === roadKey(A.id, t.id)), async (t) => {
        const cost = Math.round(ROAD.base + ROAD.costPerUnit * dist(A, t));
        if (!confirm(`Build a road from ${A.name} to ${t.name} for ${money(cost)}? Rivals will pay you a toll of ${money(ROAD.defaultToll)} per trip, which you can change.`)) return;
        await act({ type: 'buildRoad', a: A.id, b: t.id, toll: ROAD.defaultToll });
      });
      break;
    }
    case 'toll': await act({ type: 'setToll', road: id, toll: Number(val('toll')) }); break;
    case 'sell-road': await act({ type: 'sellRoad', road: id, to: val('sell-to'), price: Number(val('sell-price')) }); break;
    case 'offer-accept': await act({ type: 'acceptOffer', offer: id }); break;
    case 'offer-decline': await act({ type: 'declineOffer', offer: id }); break;
    case 'expedition': {
      if (!confirm(`Pay ${money(EXPEDITION_COST)} for an expedition?`)) break;
      const r = await act({ type: 'expedition', from: id, name: val('exp-name') });
      if (r?.town) { const t = T(r.town); if (t) { select({ kind: 'town', id: t.id }); map.centerOn(t.x, t.y); } }
      break;
    }
    case 'ledger': openModal(ledgerHtml()); break;
    case 'board': openModal(boardHtml(), true); break;
    case 'help': openModal(helpHtml()); break;
    case 'menu': openModal(menuHtml(me)); break;
    case 'modal-close': $('#modal').hidden = true; ui.routeDraft = null; break;
    case 'post': { const r = await act({ type: 'post', text: val('post') }); if (r) openModal(boardHtml(), true); break; }
    case 'pay': {
      const amt = Number(val('pay-amount'));
      if (!confirm(`Pay ${money(amt)} to ${CO(val('pay-to'))?.name}?`)) break;
      const r = await act({ type: 'pay', to: val('pay-to'), amount: amt, note: val('pay-note') });
      if (r) openModal(boardHtml(), true);
      break;
    }
    case 'theme': {
      if (id) document.documentElement.dataset.theme = id; else delete document.documentElement.dataset.theme;
      try { localStorage.setItem('ht-theme', id || ''); } catch { /* private mode */ }
      break;
    }
    case 'pw': try { await api('/api/password', { current: val('pw-cur'), next: val('pw-new') }); toast('Password changed'); } catch (err) { toast(err.message, true); } break;
    case 'admin-pw': try { await api('/api/admin/password', { username: val('ad-user'), password: val('ad-pw') }); toast('Password reset'); } catch (err) { toast(err.message, true); } break;
    case 'logout': await api('/api/logout', {}); location.reload(); break;
    // route editor
    case 'r-add': d.stops.push({ town: '', orders: [] }); renderRoute(); break;
    case 'r-del': d.stops.splice(Number(el.dataset.i), 1); renderRoute(); break;
    case 'r-up': case 'r-down': {
      const i = Number(el.dataset.i), j = a === 'r-up' ? i - 1 : i + 1;
      [d.stops[i], d.stops[j]] = [d.stops[j], d.stops[i]]; renderRoute(); break;
    }
    case 'r-oadd': {
      const s = d.stops[Number(el.dataset.i)];
      const t = T(s.town);
      const g = t ? t.resources[0]?.good || 'grain' : 'grain';
      const o = { op: s.orders.length ? 'buy' : 'sell', good: g, qty: 0, limit: 0 };
      autoLimit(s.town, o);
      s.orders.push(o);
      renderRoute(); break;
    }
    case 'r-odel': d.stops[Number(el.dataset.i)].orders.splice(Number(el.dataset.j), 1); renderRoute(); break;
    case 'r-save': {
      if (d.stops.some((s) => !s.town)) { toast('Choose a town for every stop.', true); break; }
      const r = await act({ type: 'setRoute', caravan: d.caravan, stops: d.stops });
      if (r) { $('#modal').hidden = true; ui.routeDraft = null; }
      break;
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (ui.pick) endPick();
    else if (!$('#modal').hidden) { $('#modal').hidden = true; ui.routeDraft = null; }
    else select(null);
  }
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') { $('#modal').hidden = true; ui.routeDraft = null; } });

// ---------- sign-in and founding ----------
function gate(html) { const g = $('#gate'); g.innerHTML = `<div class="card panel">${html}</div>`; g.hidden = false; return g; }

const LOGO = `<span class="brand"><span class="mark" style="width:34px;height:34px"><svg width="20" height="20" viewBox="0 0 32 32"><path d="M5 24 L16 7 L27 24" stroke="white" stroke-width="3.5" fill="none" stroke-linejoin="round"/><circle cx="16" cy="24" r="3" fill="white"/></svg></span></span>`;

function showAuth(inviteRequired, mode = 'login') {
  const g = gate(`
    <h1>${LOGO} Saltroad</h1>
    <p class="lede">A living world of rival trading companies. It never stops, and nobody wins.</p>
    <form id="auth">
      <label>Username</label><input name="username" autocomplete="username" required>
      <label>Password</label><input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required>
      ${mode === 'register' && inviteRequired ? '<label>Invite code</label><input name="invite" required>' : ''}
      <div class="err" id="auth-err"></div>
      <div class="actions"><button class="btn primary" type="submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
      <span class="muted small">${mode === 'login' ? 'New here?' : 'Have an account?'}</span>
      <button type="button" class="linkish" id="swap">${mode === 'login' ? 'Create an account' : 'Sign in'}</button></div>
    </form>`);
  $('#swap', g).onclick = () => showAuth(inviteRequired, mode === 'login' ? 'register' : 'login');
  $('#auth', g).onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api(mode === 'login' ? '/api/login' : '/api/register', f); boot(); }
    catch (err) { $('#auth-err').textContent = err.message; }
  };
}

function showFound(st) {
  apply(st);
  let color = COMPANY_COLORS.find((c) => !st.companies.some((x) => x.color === c)) || COMPANY_COLORS[0];
  const towns = [...st.towns].sort((a, b) => a.name.localeCompare(b.name));
  const g = gate(`
    <h1>${LOGO} Found your company</h1>
    <p class="lede">Pick a name, a colour and a home town. You start with ${money(2500)} and one wagon. ${st.companies.length ? `${st.companies.length} ${st.companies.length === 1 ? 'company is' : 'companies are'} already trading.` : 'You are the first.'}</p>
    <form id="found">
      <label>Company name</label><input name="name" maxlength="32" placeholder="Harker &amp; Sons" required>
      <label>Colour</label><div class="colors">${COMPANY_COLORS.map((c) => `<button type="button" data-c="${c}" class="${c === color ? 'on' : ''}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>
      <label>Home town</label><select name="home">${towns.map((t) => `<option value="${t.id}">${esc(t.name)} · ${TIERS[t.tier].name}, ${t.pop} people · ${t.resources.map((r) => r.good).join(', ')}</option>`).join('')}</select>
      <p class="note">Your home is where you can buy vehicles before you have warehouses elsewhere. Click a town on the map to look at it first.</p>
      <div class="err" id="found-err"></div>
      <div class="actions"><button class="btn primary" type="submit">Open for business</button></div>
    </form>`);
  g.querySelectorAll('.colors button').forEach((b) => b.onclick = () => {
    color = b.dataset.c; g.querySelectorAll('.colors button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('#found', g).onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('/api/company', { ...f, color }); boot(); }
    catch (err) { $('#found-err').textContent = err.message; }
  };
}

let poller;
async function boot() {
  try { const th = localStorage.getItem('ht-theme'); if (th) document.documentElement.dataset.theme = th; } catch { /* ignore */ }
  const r = await api('/api/me');
  if (!r.user) return showAuth(r.inviteRequired);
  me = r.user;
  const st = await api('/api/state');
  if (!st.me) return showFound(st);
  $('#gate').hidden = true;
  for (const id of ['topbar', 'company', 'news']) $('#' + id).hidden = false;
  apply(st);
  clearInterval(poller);
  poller = setInterval(() => { if (!document.hidden) refresh(); }, 6000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (S) { renderCompany(); if (ui.sel?.kind === 'caravan') renderInspector(); } }, 30000);
  if (!localStorage.getItem('ht-seen-help')) { try { localStorage.setItem('ht-seen-help', '1'); } catch { /* ignore */ } openModal(helpHtml()); }
}

boot().catch((e) => gate(`<h1>Saltroad</h1><p class="lede">Could not reach the server: ${esc(e.message)}</p>`));
