// Saltroad client: sign-in, founding an empire, and the game UI over the map.
import {
  GOODS, GOOD_IDS, TIERS, BUILDINGS, BUILD_ORDER, ROAD, CARAVAN, START, EMPIRE_COLORS, SPREAD, ADJ_BONUS, ADJ_MAX,
  dist, roadKey, siteOk, upgradeCost, maxLevel, claimCost, outpostCost, midPrice, tierNeeds, housingOf, storageOf,
} from '/shared/data.js';
import { tileKey, NEIGHBOURS4, TERRAIN_COLORS, TERRAIN_NAMES } from '/shared/terrain.js';
import { settleProblem, settleTiles, claimCheck, inPrecinct } from '/shared/rules.js';
import { MapView, buildingColor } from './map.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n < 0 ? '−ƒ' : 'ƒ') + Math.abs(Math.round(n)).toLocaleString('en-US');
const price = (n) => 'ƒ' + (n >= 100 ? Math.round(n) : n.toFixed(1));
const lc = (g) => GOODS[g].name.toLowerCase();
const whole = (n) => Math.floor((n || 0) + 1e-6);
const perHour = (n) => (Math.abs(n) < 0.05 ? '0' : (n > 0 ? '+' : '−') + (Math.abs(n) >= 10 ? Math.round(Math.abs(n)) : Math.abs(n).toFixed(1)));
const tierName = (i) => TIERS[i].name.toLowerCase();
const article = (w) => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;
const cap1 = (w) => w[0].toUpperCase() + w.slice(1);

function dur(ms) {
  ms = Math.max(0, ms);
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.round(h / 24)}d`;
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
function ago(t) {
  const s = (Date.now() + skew - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
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
  toastTimer = setTimeout(() => (t.hidden = true), err ? 5000 : 2800);
}

// ---------- state ----------
let S = null; // latest server state
let skew = 0;
let me = null; // signed-in user
const ui = {
  sel: null, tab: 'stores', sideOpen: true, newsTab: 'world', qty: 40, newsOpen: true, townCache: {}, modal: null, lastLog: 0,
  found: { name: '', seat: '', color: null, at: null },
  ex: { tab: 'listings', offer: [{ good: '', qty: '' }], askCash: '', askGoods: [], note: '', bid: null },
  order: { op: 'sell', good: 'grain', level: 50, limit: 0 },
};
const T = (id) => S?.towns.find((t) => t.id === id);
const E = (id) => S?.empires.find((c) => c.id === id);
const P = (id) => T(id) || S?.settlements.find((s) => s.id === id);
const mine = (x) => !!S?.me && x.owner === S.me.id;
const myBuildings = () => S.buildings.filter(mine);
const mySettlements = () => S.settlements.filter(mine);
const have = (g) => whole(S.me.stock[g]);
const haveAll = (goods) => Object.entries(goods || {}).every(([g, q]) => have(g) >= q);

const map = window.__map = new MapView($('#map'), {
  onSelect: (sel) => select(sel),
  onTool: (hit) => useTool(hit),
});

// An upright phone shows one thing at a time: a bar of sections along the bottom and sheets that rise above it.
const PHONE = matchMedia('(max-width: 720px) and (min-height: 541px), (max-width: 540px)');
const small = () => PHONE.matches;
const TOUCH = matchMedia('(pointer: coarse)').matches;
const Tap = TOUCH ? 'Tap' : 'Click', tap = TOUCH ? 'tap' : 'click';

// Tell the map which of its edges the interface covers, so "centre" and "whole map" mean the part you can see.
function layout() {
  const founding = $('#side').classList.contains('founding');
  if (small()) map.pad = { l: 0, r: 0, t: founding ? 0 : $('#topbar').offsetHeight || 88, b: founding ? Math.round(window.innerHeight * 0.5) : $('#nav').offsetHeight || 57 };
  else map.pad = { l: 340, r: ui.sel && !founding ? 440 : 0, t: founding ? 0 : $('#topbar').offsetHeight || 52, b: 0 };
}

function select(sel) {
  ui.sel = sel;
  if (sel && small() && (ui.sideOpen || ui.modal)) { ui.sideOpen = false; closeModal(); renderSide(); }
  map.sel = sel;
  if (sel?.kind === 'town') loadTownDetail(sel.id);
  renderInspector(true);
  if (sel && small()) reveal(sel);
}

// On a phone the sheet covers the lower half: slide the map so what you picked stays in sight.
function reveal(sel) {
  const p = sel.kind === 'town' ? T(sel.id) : sel.kind === 'tile' ? { x: sel.tx * 20 + 10, y: sel.ty * 20 + 10 } : null;
  if (!p) return;
  const [, sy] = map.toScreen(p.x, p.y);
  const top = $('#inspector').offsetTop;
  if (sy > top - 30) map.oy -= sy - (top - 70);
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
  renderLegend();
  if (!st.me) return;
  const newest = st.me.log[0]?.t || 0;
  if (ui.lastLog && newest > ui.lastLog) {
    const fresh = st.me.log.filter((l) => l.t > ui.lastLog && /courier|bid|took your listing|accepted|turned down|withdrew|offers you|Received|robbed/.test(l.text));
    if (fresh.length) toast(fresh[0].text);
  }
  ui.lastLog = newest || ui.lastLog || 1;
  renderTop(); renderSide(); renderInspector(); renderNews(); renderModal(); renderNav();
  if (map.tool) renderPickbar();
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

// ---------- small pieces of HTML ----------
const swatch = (color) => `<span class="swatch" style="background:${color}"></span>`;
const goodChip = (g, q) => `<span class="chip">${swatch(GOODS[g].color)}<b class="num">${q}</b> ${lc(g)}</span>`;
function chips(goods) { return Object.entries(goods || {}).map(([g, q]) => goodChip(g, q)).join(''); }
function payHtml(pay) {
  return (pay.cash ? `<span class="chip cash"><b class="num">${money(pay.cash)}</b></span>` : '') + chips(pay.goods);
}
// "ƒ350 · 6 timber", with whatever you are short of in red
function costHtml(cash, mats) {
  const parts = [];
  if (cash) parts.push(`<span class="num ${S.me.cash < cash ? 'bad' : ''}">${money(cash)}</span>`);
  for (const [g, q] of Object.entries(mats || {})) parts.push(`<span class="${have(g) < q ? 'bad' : ''}"><span class="num">${q}</span> ${lc(g)}</span>`);
  return parts.join(' + ') || 'free';
}
const baseValue = (goods) => Object.entries(goods || {}).reduce((a, [g, q]) => a + GOODS[g].base * q, 0);
function spark(vals, w = 40, h = 14, upGood = false) {
  if (!vals || vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - min) / (max - min || 1)) * (h - 2)).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${up === upGood ? 'var(--good)' : 'var(--bad)'}" stroke-width="1.3"/></svg>`;
}
const ICONS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chart: '<path d="M5 20V11M12 20V5M19 20v-6M3 20h18"/>',
  hammer: '<path d="M13.5 4.5l6 6-2.5 2.5-6-6zM12.5 8.5L4 17l3 3 8.5-8.5"/>',
  hall: '<path d="M4 20h16M6 20v-8M18 20v-8M10 20v-5h4v5M3 11l9-7 9 7"/>',
  cart: '<path d="M3 6h11v9H3zM14 9h4l3 3v3h-7"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  swap: '<path d="M8 4L4 8l4 4M4 8h13M16 12l4 4-4 4M20 16H7"/>',
  news: '<path d="M4 5h12v14H6a2 2 0 0 1-2-2zM16 9h4v8a2 2 0 0 1-2 2H6M7.5 9h5M7.5 12.5h5M7.5 16h3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.5-1.2 1-1.2 1.9M12 17h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18"/>',
  flag: '<path d="M6 21V4M6 4h11l-2.4 4L17 12H6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  out: '<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
};
const icon = (name, px = 20) => `<svg class="ic" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const LOGO = (px = 16) => `<svg width="${px}" height="${px}" viewBox="0 0 32 32"><path d="M5 24 L16 7 L27 24" stroke="white" stroke-width="3.5" fill="none" stroke-linejoin="round"/><circle cx="16" cy="24" r="3" fill="white"/></svg>`;

// ---------- top bar ----------
function renderTop() {
  const m = S.me;
  const day = Math.floor(S.clock / 24) + 1;
  const net = m.tax - m.upkeep;
  const news = S.listings.filter((l) => l.seller !== m.id).length + S.listings.filter((l) => l.seller === m.id).reduce((a, l) => a + l.bidCount, 0);
  const badge = news ? `<span class="badge">${news}</span>` : '';
  $('#topbar').innerHTML = `
    <div class="brand"><span class="mark">${LOGO()}</span><span>Saltroad</span> <small>Day ${day}</small></div>
    <button class="cohead linkish-plain" data-act="home" title="Go to your capital">${swatch(m.color)}<span class="nm">${esc(m.name)}</span> <small>${TIERS[m.tier].name}</small></button>
    <div class="kpis">
      <span class="day">Day ${day}</span>
      <div class="stat"><b class="num ${m.cash < 0 ? 'bad' : ''}">${money(m.cash)}</b><span>Cash <i class="${net < 0 ? 'bad' : 'good'}">${perHour(net)}/h</i></span></div>
      <div class="stat"><b class="num">${Math.floor(m.pop).toLocaleString('en-US')}<small> / ${m.housing.toLocaleString('en-US')}</small></b><span>People</span></div>
      <div class="stat"><b class="num ${m.sat < 0.5 ? 'bad' : m.sat < 0.75 ? 'warn' : ''}">${Math.round(m.sat * 100)}%</b><span>Needs<em> met</em></span></div>
      <div class="stat"><b class="num">${m.idle}<small> / ${m.caravans}</small></b><span>Caravans<em> home</em></span></div>
    </div>
    <div class="spacer"></div>
    <div class="tb-actions">
      <button class="btn ghost t-world" data-act="world" title="See the whole map" aria-label="Whole map">${icon('globe', 18)}<span class="lbl">World</span></button>
      <button class="btn ghost t-ex" data-act="exchange" title="Trade with the other empires">${icon('swap', 18)}<span class="lbl">Exchange</span>${badge}</button>
      <button class="btn ghost t-led" data-act="ledger" title="Standings" aria-label="Standings">${icon('chart', 18)}<span class="lbl">Standings</span></button>
      <button class="btn ghost t-help" data-act="help" title="How to play" aria-label="How to play">${icon('help', 18)}<span class="lbl">How to play</span></button>
      <button class="btn ghost t-menu" data-act="menu" title="Menu" aria-label="Menu">${icon('menu', 18)}</button>
    </div>`;
}

// ---------- bottom bar (phones) ----------
function renderNav() {
  const el = $('#nav');
  if (!S?.me) return;
  const m = S.me;
  const news = S.listings.filter((l) => l.seller !== m.id).length + S.listings.filter((l) => l.seller === m.id).reduce((a, l) => a + l.bidCount, 0);
  const on = ui.modal === 'exchange' ? 'exchange' : ui.modal ? '' : ui.sideOpen ? ui.tab : map.tool && !map.tool.capital && map.tool.type !== 'place' ? 'build' : '';
  const items = [['stores', 'hall', 'Empire'], ['build', 'hammer', 'Build'], ['trade', 'cart', 'Trade'], ['exchange', 'swap', 'Exchange'], ['log', 'news', 'News']];
  el.innerHTML = items.map(([k, ic, n]) => `<button class="navb" data-act="nav" data-id="${k}" aria-pressed="${on === k}">${icon(ic, 22)}<span>${n}</span>${k === 'exchange' && news ? `<i class="badge">${news}</i>` : ''}</button>`).join('');
}

// ---------- left panel ----------
function renderSide() {
  const el = $('#side');
  if (!S?.me) return;
  const a = document.activeElement;
  if (a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
  const tabs = [['stores', 'Empire'], ['build', 'Build'], ['trade', 'Trade'], ['log', 'Log']];
  const body = ui.tab === 'stores' ? storesHtml() : ui.tab === 'build' ? buildHtml() : ui.tab === 'trade' ? tradeHtml() : logHtml();
  const scroll = $('.scroll', el)?.scrollTop || 0;
  el.classList.toggle('shut', !ui.sideOpen);
  const title = { stores: 'Your empire', build: 'Build', trade: 'Trade', log: 'News' }[ui.tab];
  el.innerHTML = `<div class="phead sheet-head"><h2>${title}</h2><button class="btn ghost tiny x" data-act="side-close" aria-label="Close">${icon('x', 18)}</button></div><div class="tabs">${tabs.map(([k, n]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-act="tab" data-id="${k}">${n}</button>`).join('')}</div><div class="scroll">${body}</div>`;
  $('.scroll', el).scrollTop = scroll;
  renderNav();
}

function rankHtml() {
  const m = S.me, next = TIERS[m.tier + 1];
  if (!next) return `<div class="section"><h4>Rank</h4><p style="margin:0"><b>${TIERS[m.tier].name}</b>. There is nothing higher. Keep building.</p></div>`;
  const ready = m.pop >= next.min;
  const can = ready && m.cash >= next.charter.cash && haveAll(next.charter.goods);
  const wants = Object.keys(next.needs).map(lc);
  return `<div class="section"><h4>Rank <span class="muted" style="margin-left:auto;text-transform:none;letter-spacing:0">${TIERS[m.tier].name}</span></h4>
    <div class="row small"><span>Next: <b>${next.name}</b></span><span class="num muted" style="margin-left:auto">${Math.floor(m.pop).toLocaleString('en-US')} / ${next.min.toLocaleString('en-US')} people</span></div>
    <div class="bar" style="margin:5px 0 7px"><i style="width:${Math.min(100, (m.pop / next.min) * 100)}%"></i></div>
    <div class="row small"><span class="muted">Charter</span> ${costHtml(next.charter.cash, next.charter.goods)}
      <button class="btn tiny ${can ? 'primary' : ''}" style="margin-left:auto" data-act="charter" ${can ? '' : 'disabled'}>Become ${article(next.name.toLowerCase())}</button></div>
    <p class="note">Taxes rise from ƒ${TIERS[m.tier].tax} to ƒ${next.tax} a head each hour and buildings can go a level higher. ${cap1(article(TIERS[m.tier].name.toLowerCase()))} holds ${TIERS[m.tier].cap.toLocaleString('en-US')} people at most; ${article(next.name.toLowerCase())} holds ${next.cap > 1e8 ? 'any number' : next.cap.toLocaleString('en-US')}.${wants.length ? ` Your people will also want ${wants.join(', ')}.` : ''}</p></div>`;
}

function storesHtml() {
  const m = S.me;
  const wants = tierNeeds(m.tier);
  const rows = GOOD_IDS.map((g) => {
    const net = m.prod[g] - m.use[g] - m.cons[g];
    const stock = m.stock[g];
    const need = wants[g] > 0;
    const fill = m.fill[g];
    let state = '';
    if (need && m.pop >= 1 && fill < 0.99) state = `<span class="${fill < 0.5 ? 'bad' : 'warn'}" title="Your people want ${lc(g)} and are getting ${Math.round(fill * 100)}% of it">●</span>`;
    else if (need) state = `<span class="muted" title="Your people use ${lc(g)}">○</span>`;
    let left = '';
    if (net < -0.05 && stock > 0.5) left = `<span class="muted small">${dur((stock / -net) * 3600e3)} left</span>`;
    else if (stock >= m.cap - 0.5 && net > 0.05) left = '<span class="warn small">full</span>';
    const tip = `Made ${m.prod[g]}/h, used by workshops ${m.use[g]}/h, used by people ${m.cons[g]}/h`;
    return `<tr title="${tip}">
      <td><span class="gd">${swatch(GOODS[g].color)}${GOODS[g].name}</span> ${state}</td>
      <td class="stockcell"><div class="bar"><i style="width:${Math.min(100, (stock / m.cap) * 100)}%;background:${GOODS[g].color}"></i></div></td>
      <td class="num">${whole(stock)}</td>
      <td class="num ${net < -0.05 ? 'bad' : net > 0.05 ? 'good' : 'muted'}">${perHour(net)}</td>
      <td>${left}</td></tr>`;
  }).join('');
  const short = m.jobs > m.workers + 0.5;
  return `${rankHtml()}
    <div class="section"><h4>Stores <span class="muted" style="margin-left:auto;text-transform:none;letter-spacing:0">holds ${m.cap} of each</span></h4>
      <table class="market stores"><thead><tr><th>Good</th><th></th><th>Have</th><th>/hour</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">● your people want it and are going short. Sell a surplus or cover a shortfall at a town, or on the Exchange.</p></div>
    <div class="section"><h4>People</h4>
      <dl class="kv"><dt>Residents</dt><dd class="num">${Math.floor(m.pop).toLocaleString('en-US')} of ${m.housing.toLocaleString('en-US')} homes</dd>
      <dt>Workers</dt><dd class="num ${short ? 'warn' : ''}">${m.workers.toLocaleString('en-US')} for ${m.jobs.toLocaleString('en-US')} jobs</dd>
      <dt>Needs met</dt><dd class="num">${Math.round(m.sat * 100)}%</dd></dl>
      ${short ? `<p class="note warn">Short of workers, so everything runs at ${Math.round(m.staff * 100)}%. Build or upgrade houses, or pause a building.</p>` : ''}
      ${m.sat < 0.75 ? '<p class="note">People only fill every home when at least three quarters of their needs are met.</p>' : ''}</div>
    <div class="section"><h4>Money per hour</h4>
      <dl class="kv"><dt>Taxes</dt><dd class="num good">+${m.tax.toFixed(1)}</dd>
      <dt>Buildings</dt><dd class="num">−${m.upkeepParts.buildings.toFixed(1)}</dd>
      <dt>Caravans</dt><dd class="num">−${m.upkeepParts.caravans.toFixed(1)}</dd>
      ${m.upkeepParts.roads ? `<dt>Roads</dt><dd class="num">−${m.upkeepParts.roads.toFixed(1)}</dd>` : ''}
      <dt><b>Net</b></dt><dd class="num ${m.tax - m.upkeep < 0 ? 'bad' : 'good'}"><b>${perHour(m.tax - m.upkeep)}</b></dd></dl>
      <p class="note">Worth ${money(m.worth)} in all. Happier people pay more tax.</p></div>`;
}

function buildRowCost(def) { return costHtml(def.cost, def.mats); }

function buildHtml() {
  const m = S.me;
  const outposts = mySettlements().filter((s) => !s.capital).length;
  const tool = map.tool;
  return `<div class="section"><h4>Land <span class="muted" style="margin-left:auto;text-transform:none;letter-spacing:0">${m.land} plots</span></h4>
      <div class="row"><button class="btn ${tool?.type === 'claim' ? 'primary' : ''}" data-act="tool-claim">Claim a plot<i class=dot></i>${money(claimCost(m.extra))}</button>
      <button class="btn ${tool?.type === 'settle' ? 'primary' : ''}" data-act="tool-outpost" ${m.tier < 1 ? 'disabled title="Become a village first"' : ''}>Outpost<i class=dot></i>${money(outpostCost(outposts))}</button></div>
      <p class="note">Each plot costs a little more than the last. An outpost claims nine plots anywhere on the map, so you can reach land your capital lacks.</p></div>
    <div class="section" style="padding-bottom:4px"><h4>Buildings</h4><p class="note" style="margin:0 0 6px">Pick one, then ${tap} a highlighted plot. Darker green is richer land.</p></div>
    <ul class="list build">${BUILD_ORDER.map((k) => {
      const def = BUILDINGS[k];
      const locked = (def.tier || 0) > m.tier;
      const what = def.out ? `${def.rate} ${lc(def.out)}/h` : def.recipe ? `${Object.entries(def.recipe.in).map(([g, q]) => `${q * def.rate} ${lc(g)}`).join(' + ')} → ${def.rate} ${lc(def.recipe.out)}/h` : def.housing ? '50 people' : `+${def.storage} storage`;
      return `<li class="click ${tool?.type === 'build' && tool.kind === k ? 'sel' : ''} ${locked ? 'locked' : ''}" data-act="tool-build" data-id="${k}" title="${esc(def.blurb)}">
        <span class="bchip" style="background:${buildingColor(k)}"></span>
        <div class="grow"><div class="title">${def.name} <span class="muted small" style="font-weight:500">${what}</span></div>
        <div class="sub">${locked ? `Needs ${article(tierName(def.tier))}` : buildRowCost(def)}${def.workers ? `<i class=dot></i>${def.workers} workers` : ''}</div></div></li>`;
    }).join('')}</ul>`;
}

function tripText(t) {
  const now = Date.now() + skew;
  const town = T(t.to);
  const cargo = Object.entries(t.cargo || {}).map(([g, q]) => `${q} ${lc(g)}`).join(', ');
  if (t.kind === 'courier') return { title: `Courier with ${cargo}`, sub: `${esc(t.why || 'Exchange delivery')}<i class=dot></i>arrives in ${dur(t.arriveAt - now)}` };
  if (t.kind === 'buy') return { title: `Fetching ${cargo}`, sub: `from ${esc(town?.name)}<i class=dot></i>home in ${dur(t.returnAt - now)}${t.risk ? '<i class=dot></i>bandits about' : ''}` };
  return { title: `Delivering ${cargo}`, sub: `to ${esc(town?.name)}<i class=dot></i>caravans home in ${dur(t.returnAt - now)}` };
}

function orderText(o) {
  const t = T(o.town);
  return o.op === 'sell'
    ? { title: `Sell ${lc(o.good)} above ${o.level}`, sub: `at ${esc(t?.name)}${o.limit ? `<i class=dot></i>not below ${price(o.limit)}` : ''}` }
    : { title: `Buy ${lc(o.good)} up to ${o.level}`, sub: `at ${esc(t?.name)}${o.limit ? `<i class=dot></i>not above ${price(o.limit)}` : ''}` };
}

function tradeHtml() {
  const m = S.me;
  const trips = S.trips.filter(mine).sort((a, b) => a.returnAt - b.returnAt);
  const roads = S.roads.filter(mine);
  const offers = S.offers.filter((o) => o.to === m.id);
  return `<div class="section"><h4>Caravans</h4>
      <div class="row"><span><b class="num">${m.idle}</b> of <b class="num">${m.caravans}</b> at home</span>
        <button class="btn tiny" style="margin-left:auto" data-act="buy-caravan">Buy<i class=dot></i>${money(CARAVAN.cost)}</button>
        <button class="btn tiny ghost" data-act="sell-caravan" ${m.idle ? '' : 'disabled'}>Sell</button></div>
      <p class="note">Each carries ${CARAVAN.capacity} goods to or from a town market and costs ƒ${CARAVAN.upkeep} an hour. ${Tap} a town on the map to trade there. Exchange deals with other players are carried by courier and need no caravans.</p></div>
    ${offers.length ? `<div class="section"><h4>Offers</h4>${offers.map((o) => {
      const r = S.roads.find((x) => x.id === o.road);
      return `<div class="row small"><span><b>${esc(E(o.from)?.name)}</b> offers you the ${esc(P(r?.a)?.name)}–${esc(P(r?.b)?.name)} road for <span class="num">${money(o.price)}</span></span>
        <button class="btn tiny primary" data-act="offer-accept" data-id="${o.id}">Accept</button><button class="btn tiny" data-act="offer-decline" data-id="${o.id}">Decline</button></div>`;
    }).join('')}</div>` : ''}
    <div class="section" style="padding-bottom:0"><h4>On the road</h4></div>
    ${trips.length ? `<ul class="list">${trips.map((t) => { const x = tripText(t); return `<li><span class="tripdot ${t.kind}" style="background:${m.color}"></span><div class="grow"><div class="title">${x.title}</div><div class="sub">${x.sub}</div></div></li>`; }).join('')}</ul>` : '<div class="pbody" style="padding-top:0"><p class="note" style="margin:0">Nothing on the move.</p></div>'}
    <div class="section" style="padding-bottom:0"><h4>Standing orders</h4></div>
    ${m.orders.length ? `<ul class="list">${m.orders.map((o) => { const x = orderText(o); return `<li class="click" data-act="sel-town" data-id="${o.town}"><div class="grow"><div class="title">${x.title}</div><div class="sub">${x.sub}</div></div><button class="btn tiny ghost danger" data-act="order-del" data-id="${o.id}" title="Remove">✕</button></li>`; }).join('')}</ul>` : ''}
    <div class="pbody" style="padding-top:${m.orders.length ? 8 : 0}px"><p class="note" style="margin:0">A standing order sends a caravan by itself whenever one is free, so trade carries on while you are away. Set them from a town's market.</p></div>
    ${roads.length ? `<div class="section" style="padding-bottom:0"><h4>Your roads <span class="muted" style="margin-left:auto;text-transform:none;letter-spacing:0">tolls so far ${money(m.stats.tolls || 0)}</span></h4></div>
      <ul class="list">${roads.map((r) => `<li class="click" data-act="sel-road" data-id="${r.id}"><div class="grow"><div class="title">${esc(P(r.a)?.name)} – ${esc(P(r.b)?.name)}</div><div class="sub">${r.length} leagues<i class=dot></i>toll ${money(r.toll)}</div></div></li>`).join('')}</ul>` : ''}`;
}

function logHtml() {
  const own = `<ul class="feed">${S.me.log.map((l) => `<li><time>${ago(l.t)}</time>${esc(l.text)}</li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul>`;
  if (!small()) return own;
  // on a phone the Gazette has no panel of its own, so it shares this sheet with your own log
  const world = `<ul class="feed">${S.news.slice(0, 60).map((n) => `<li class="k-${n.kind}"><time>${ago(n.t)}</time>${esc(n.text)}</li>`).join('')}</ul>`;
  return `<div class="seg">${[['world', 'The Gazette'], ['mine', 'Your log']].map(([k, n]) => `<button data-act="news-tab" data-id="${k}" aria-pressed="${ui.newsTab === k}">${n}</button>`).join('')}</div>${ui.newsTab === 'mine' ? own : world}`;
}

function renderLegend() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const pal = dark ? TERRAIN_COLORS.dark : TERRAIN_COLORS.light;
  $('#legend').innerHTML = Object.entries(TERRAIN_NAMES).map(([k, n]) => `<span>${swatch(pal[k])}${n}</span>`).join('');
  $('#legend').hidden = false;
}

// ---------- news ----------
function renderNews() {
  const el = $('#news');
  const scroll = $('.feed', el)?.scrollTop || 0;
  el.classList.toggle('collapsed', !ui.newsOpen);
  el.innerHTML = `
    <div class="phead"><h3>The Gazette</h3><button class="btn ghost tiny x" data-act="news-toggle">${ui.newsOpen ? 'Hide' : 'Show'}</button></div>
    <ul class="feed">${S.news.slice(0, 60).map((n) => `<li class="k-${n.kind}"><time>${ago(n.t)}</time>${esc(n.text)}</li>`).join('')}</ul>`;
  $('.feed', el).scrollTop = scroll;
}

// ---------- inspector ----------
function renderInspector(force = false) {
  const el = $('#inspector');
  if (!S?.me) { el.hidden = true; return; }
  const a = document.activeElement;
  if (!force && a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return;
  const sel = ui.sel;
  if (!sel) { el.hidden = true; return; }
  el.hidden = false;
  const scroll = el.scrollTop;
  if (sel.kind === 'town') el.innerHTML = townHtml(T(sel.id));
  else if (sel.kind === 'tile') el.innerHTML = tileHtml(sel.tx, sel.ty);
  else if (sel.kind === 'road') el.innerHTML = roadHtml(S.roads.find((r) => r.id === sel.id));
  el.scrollTop = scroll;
}

const richWord = (r) => (r >= 1.15 ? 'rich' : r < 0.85 ? 'poor' : 'fair');
const closeBtn = `<button class="btn ghost tiny x" data-act="close" aria-label="Close">${icon('x', 18)}</button>`;
const modalClose = `<button class="btn ghost tiny x" data-act="modal-close" aria-label="Close">${icon('x', 18)}</button>`;

// What a building of this kind would make on a plot, counting like neighbours.
function estimate(kind, tx, ty, level = 1, skipId = null) {
  const def = BUILDINGS[kind];
  const rich = def.rich ? map.terrain.rich(tx, ty, def.rich) : 1;
  let adj = 0;
  if (def.out) for (const [dx, dy] of NEIGHBOURS4) { const b = map.bAt.get(tileKey(tx + dx, ty + dy)); if (b && b.id !== skipId && mine(b) && b.type === kind) adj++; }
  return { rich, adj, rate: def.rate * level * rich * (1 + ADJ_BONUS * Math.min(ADJ_MAX, adj)) };
}

function buildingHtml(b, tx, ty) {
  const def = BUILDINGS[b.type];
  const owner = E(b.owner);
  const s = S.settlements.find((x) => x.id === b.s);
  const head = `<div class="phead"><span class="bchip" style="background:${buildingColor(b.type) || owner?.color}"></span><h2>${b.type === 'hall' ? esc(s?.name) : def.name}</h2>
    <span class="muted small">${b.type === 'hall' ? (s?.capital ? 'Capital' : 'Outpost') : `Level ${b.level}`}</span>${closeBtn}</div>`;
  if (!mine(b)) return `${head}<div class="section"><p style="margin:0">${swatch(owner?.color)} Belongs to <b>${esc(owner?.name)}</b>${s ? `, in ${esc(s.name)}` : ''}.</p></div>`;
  const m = S.me;
  let body = '';
  if (def.out || def.recipe) {
    const e = estimate(b.type, tx, ty, b.level, b.id);
    const rate = e.rate * m.staff;
    const out = def.out || def.recipe.out;
    const status = b.paused ? '<span class="warn">Paused.</span>' : b.idle === 'full' ? `<span class="warn">Standing idle: your stores of ${lc(out)} are full.</span>` : b.idle === 'inputs' ? `<span class="bad">Standing idle: it has run out of ${Object.keys(def.recipe.in).filter((g) => m.stock[g] < 1).map(lc).join(' and ') || 'inputs'}.</span>` : '<span class="good">Working.</span>';
    body = `<div class="section"><p style="margin:0 0 6px">${status}</p><dl class="kv">
      <dt>Makes</dt><dd><span class="num">${rate.toFixed(1)}</span> ${lc(out)} an hour</dd>
      ${def.recipe ? `<dt>Uses</dt><dd>${Object.entries(def.recipe.in).map(([g, q]) => `<span class="num">${(rate * q).toFixed(1)}</span> ${lc(g)}`).join(' + ')}</dd>` : ''}
      ${def.rich ? `<dt>Land</dt><dd>${richWord(e.rich)} <span class="num muted">×${e.rich.toFixed(2)}</span></dd>` : ''}
      ${def.out ? `<dt>Neighbours</dt><dd>${e.adj ? `${e.adj} alike <span class="num muted">+${Math.round(ADJ_BONUS * Math.min(ADJ_MAX, e.adj) * 100)}%</span>` : '<span class="muted">none alike</span>'}</dd>` : ''}
      <dt>Workers</dt><dd class="num">${def.workers * b.level}${m.staff < 0.995 ? ` <span class="warn">(${Math.round(m.staff * 100)}% staffed)</span>` : ''}</dd>
      <dt>Upkeep</dt><dd class="num">ƒ${(def.upkeep * b.level * (b.paused ? 0.25 : 1)).toFixed(1)} an hour</dd></dl>
      ${def.out ? `<p class="note">Each neighbouring ${def.name.toLowerCase()} adds ${ADJ_BONUS * 100}% to the ones beside it.</p>` : ''}</div>`;
  } else if (b.type === 'house') {
    body = `<div class="section"><dl class="kv"><dt>Homes for</dt><dd class="num">${housingOf(b)} people</dd><dt>Workers</dt><dd class="num">${housingOf(b) / 2}</dd></dl></div>`;
  } else {
    body = `<div class="section"><dl class="kv"><dt>Holds</dt><dd><span class="num">${storageOf(b)}</span> of every good</dd>
      ${def.upkeep ? `<dt>Upkeep</dt><dd class="num">ƒ${(def.upkeep * b.level).toFixed(1)} an hour</dd>` : ''}</dl></div>`;
  }
  let actions = '';
  if (b.type === 'hall') {
    actions = `<div class="section"><h4>Settlement</h4>
      <div class="row"><input class="in" value="${esc(s.name)}" maxlength="24" data-input="rename" style="flex:1"><button class="btn" data-act="rename" data-id="${s.id}">Rename</button></div>
      <div class="row"><button class="btn" data-act="road" data-id="${s.id}">Build a road from here…</button></div>
      ${roadsAt(s.id)}</div>`;
  } else {
    const top = maxLevel(b.type, m.tier);
    const uc = upgradeCost(b.type, b.level);
    const canUp = b.level < top;
    const absolute = b.type === 'house' ? 4 : 3;
    const gain = b.type === 'house' ? `homes for ${BUILDINGS.house.housing[b.level]}` : def.rate ? 'makes more, needs more workers' : `holds ${def.storage * (b.level + 1)}`;
    actions = `<div class="section"><h4>Manage</h4>
      ${b.level >= absolute ? '<p class="note" style="margin-top:0">As large as it gets.</p>' : canUp
        ? `<div class="row"><button class="btn ${m.cash >= uc.cash && haveAll(uc.mats) ? 'primary' : ''}" data-act="upgrade" data-id="${b.id}">Upgrade to level ${b.level + 1}</button><span class="small">${costHtml(uc.cash, uc.mats)}</span></div><p class="note">Level ${b.level + 1}: ${gain}.</p>`
        : `<p class="note" style="margin-top:0">Level ${b.level + 1} needs ${article(tierName(TIERS.findIndex((t, i) => i > m.tier && maxLevel(b.type, i) > b.level)))}.</p>`}
      <div class="row">${def.rate ? `<button class="btn" data-act="pause" data-id="${b.id}" data-on="${b.paused ? '' : '1'}">${b.paused ? 'Put back to work' : 'Pause'}</button>` : ''}
        <button class="btn danger" data-act="demolish" data-id="${b.id}">Pull down</button></div></div>`;
  }
  return head + body + actions;
}

function roadsAt(placeId) {
  const roads = S.roads.filter((r) => r.a === placeId || r.b === placeId);
  if (!roads.length) return '';
  return `<ul class="list" style="margin:8px -12px 0">${roads.map((r) => {
    const o = r.a === placeId ? r.b : r.a;
    return `<li class="click" data-act="sel-road" data-id="${r.id}">${swatch(E(r.owner)?.color)}<div class="grow"><div class="title">Road to ${esc(P(o)?.name)}</div><div class="sub">${esc(E(r.owner)?.name)}<i class=dot></i>toll ${money(r.toll)}</div></div></li>`;
  }).join('')}</ul>`;
}

function landFacts(tx, ty) {
  const t = map.terrain.tile(tx, ty), coastal = map.terrain.coastal(tx, ty);
  const fits = BUILD_ORDER.filter((k) => BUILDINGS[k].out && siteOk(BUILDINGS[k], t.kind, coastal));
  return { t, coastal, fits };
}

function tileHtml(tx, ty) {
  const key = tileKey(tx, ty);
  const b = map.bAt.get(key);
  if (b) return buildingHtml(b, tx, ty);
  const m = S.me;
  const { t, coastal, fits } = landFacts(tx, ty);
  const own = map.owner.get(key);
  const owner = own && E(own.o);
  const kindName = t.kind === 'water' ? 'Open water' : t.kind[0].toUpperCase() + t.kind.slice(1);
  const head = `<div class="phead"><h2>${kindName}${coastal ? ', by the water' : ''}</h2><span class="muted small num">${tx}, ${ty}</span>${closeBtn}</div>`;
  if (t.kind === 'water') return `${head}<div class="section"><p style="margin:0" class="muted">Nothing can be built here, but fisheries and saltworks want a plot beside it.</p></div>`;
  const good = fits.length ? `<div class="chips" style="margin-top:6px">${fits.map((k) => { const r = map.terrain.rich(tx, ty, BUILDINGS[k].rich); return `<span class="chip" title="×${r.toFixed(2)}">${swatch(GOODS[BUILDINGS[k].out].color)}${BUILDINGS[k].name}: ${richWord(r)}</span>`; }).join('')}</div>` : '<p class="note">No raw goods to be had here, but houses and workshops can stand on it.</p>';
  if (own && own.o === m.id) {
    const s = S.settlements.find((x) => x.id === own.s);
    const options = BUILD_ORDER.filter((k) => siteOk(BUILDINGS[k], t.kind, coastal));
    return `${head}<div class="section"><p style="margin:0">Your land, part of ${esc(s?.name)}.</p>${good}</div>
      <div class="section" style="padding-bottom:0"><h4>Build here</h4></div>
      <ul class="list build">${options.map((k) => {
        const def = BUILDINGS[k];
        const locked = (def.tier || 0) > m.tier;
        const e = def.out ? estimate(k, tx, ty) : null;
        const what = e ? `${e.rate.toFixed(1)} ${lc(def.out)}/h${e.adj ? ` (+${Math.round(ADJ_BONUS * Math.min(ADJ_MAX, e.adj) * 100)}% neighbours)` : ''}` : def.recipe ? `${def.rate} ${lc(def.recipe.out)}/h` : def.housing ? '50 people' : `+${def.storage} storage`;
        const ok = !locked && m.cash >= def.cost && haveAll(def.mats);
        return `<li><span class="bchip" style="background:${buildingColor(k)}"></span><div class="grow"><div class="title">${def.name} <span class="muted small" style="font-weight:500">${what}</span></div>
          <div class="sub">${locked ? `Needs ${article(tierName(def.tier))}` : costHtml(def.cost, def.mats)}</div></div>
          <button class="btn tiny ${ok ? 'primary' : ''}" data-act="build-here" data-id="${k}" ${locked ? 'disabled' : ''}>Build</button></li>`;
      }).join('')}</ul>`;
  }
  if (owner) return `${head}<div class="section"><p style="margin:0">${swatch(owner.color)} Land of <b>${esc(owner.name)}</b>.</p>${good}</div>`;
  if (inPrecinct(map.ctxRules, tx, ty)) return `${head}<div class="section"><p style="margin:0" class="muted">Town land. Nobody can claim the plots around a town.</p></div>`;
  const cc = claimCheck(map.ctxRules, tx, ty, m.id);
  const outposts = mySettlements().filter((s) => !s.capital).length;
  const sp = settleProblem(map.ctxRules, tx, ty, false, m.id);
  return `${head}<div class="section"><p style="margin:0" class="muted">Unclaimed land.</p>${good}</div>
    <div class="section">${cc.problem ? `<p class="note" style="margin-top:0">${esc(cc.problem)}</p>` : `<div class="row"><button class="btn primary" data-act="claim-here">Claim this plot<i class=dot></i>${money(claimCost(m.extra))}</button></div>`}
      ${cc.problem && m.tier >= 1 && !sp ? `<div class="row"><input class="in" placeholder="Outpost name" maxlength="24" data-input="outpost-name" style="flex:1"><button class="btn" data-act="outpost-here">Found an outpost<i class=dot></i>${money(outpostCost(outposts))}</button></div>` : ''}
      ${cc.problem && m.tier < 1 ? '<p class="note">Once you are a village you can found outposts on far-off land like this.</p>' : ''}</div>`;
}

// Walk a town's market the way the server does, to show what an order would really cost.
function quoteLocal(m, good, qty, op) {
  let stock = m.stock, n = 0, total = 0;
  while (n < qty) {
    if (op === 'buy') { if (stock < 1) break; total += midPrice(good, stock, m.target) * (1 + SPREAD); stock -= 1; } else { total += midPrice(good, stock, m.target) * (1 - SPREAD); stock += 1; }
    n++;
  }
  return { n, total };
}

function townHtml(t) {
  if (!t) return '';
  const m = S.me;
  const detail = ui.townCache[t.id];
  const tier = TIERS[t.tier];
  const reach = m.reach[t.id];
  const from = S.settlements.find((s) => s.id === reach?.from);
  const events = S.events.filter((e) => e.town === t.id || (e.radius && dist(T(e.town) || t, t) <= e.radius));
  const qty = ui.qty;
  const maxLoad = m.idle * CARAVAN.capacity;
  const rows = GOOD_IDS.map((g) => {
    const mk = t.market[g];
    const mineQty = have(g);
    const qb = quoteLocal(mk, g, qty, 'buy'), qs = quoteLocal(mk, g, Math.min(qty, Math.max(1, mineQty)), 'sell');
    const flow = mk.prod > mk.cons ? `<span class="good" title="Made here, ${mk.prod}/h">▲</span>` : mk.cons > 0 ? `<span class="warn" title="Used here, ${mk.cons}/h">▼</span>` : '';
    const short = mk.cons > 0 && mk.stock < mk.cons * 4;
    return `<tr class="${short ? 'need' : ''}">
      <td><span class="gd">${swatch(GOODS[g].color)}${GOODS[g].name}</span> ${flow}</td>
      <td class="num">${whole(mk.stock)}</td>
      <td class="num pc" title="Average for ${qb.n}: ${qb.n ? price(qb.total / qb.n) : 'none in stock'}">${price(mk.buy)}</td>
      <td class="num pc" title="Average for ${qs.n}: ${price(qs.total / qs.n)}">${price(mk.sell)}</td>
      <td class="sp">${spark(detail?.priceHist?.[g]?.slice(-24))}</td>
      <td class="num muted">${mineQty || ''}</td>
      <td><span class="acts">
        <button class="btn tiny" data-act="mbuy" data-good="${g}" ${mk.stock >= 1 && m.idle ? '' : 'disabled'} title="Buy ${Math.min(qty, qb.n)} for about ${money(qb.total)}">Buy<span class="pr num">${price(mk.buy)}</span></button>
        <button class="btn tiny" data-act="msell" data-good="${g}" ${mineQty && m.idle ? '' : 'disabled'} title="Sell ${Math.min(qty, mineQty)} for about ${money(qs.total)}">Sell<span class="pr num">${price(mk.sell)}</span></button></span></td>
    </tr>`;
  }).join('');
  const orders = m.orders.filter((o) => o.town === t.id);
  const od = ui.order;
  return `
    <div class="phead"><h2>${esc(t.name)}</h2><span class="muted small">${tier.name}<i class=dot></i>neutral town</span>${closeBtn}</div>
    <div class="section">
      <dl class="kv">
        <dt>People</dt><dd class="num">${t.pop.toLocaleString('en-US')} ${t.trend != null ? `<span class="${t.trend >= 0 ? 'good' : 'bad'}">${t.trend >= 0 ? '+' : ''}${t.trend}/day</span>` : ''}</dd>
        <dt>Needs met</dt><dd><div class="bar" style="width:120px;display:inline-block"><i style="width:${Math.round(t.sat * 100)}%;background:${t.sat > 0.6 ? 'var(--good)' : t.sat > 0.45 ? 'var(--warn)' : 'var(--bad)'}"></i></div> <span class="num">${Math.round(t.sat * 100)}%</span></dd>
      </dl>
      <div class="chips" style="margin-top:8px">${t.resources.map((r) => `<span class="chip">${swatch(GOODS[r.good].color)}Makes ${lc(r.good)}</span>`).join('')}
        ${events.map((e) => `<span class="chip event" title="${esc(e.text)}">${e.type}<i class=dot></i>${dur(e.until - Date.now() - skew)}</span>`).join('')}</div>
    </div>
    <div class="section">
      <h4>Market</h4>
      <div class="row" style="margin-bottom:6px">
        <span class="small muted">Quantity</span><input class="in qty" type="number" min="1" value="${qty}" data-input="qty">
        <span class="small ${m.idle ? 'muted' : 'warn'}">${m.idle ? `${m.idle} caravan${m.idle > 1 ? 's' : ''} free, up to ${maxLoad}` : 'all caravans are out'}</span>
      </div>
      <p class="note" style="margin:0 0 6px">${reach ? `${dur(reach.hours * 2 * 3600e3)} there and back from ${esc(from?.name)}${reach.road ? ', partly by road' : ''}${reach.toll ? `, ${money(reach.toll)} in tolls` : ''}.` : ''} You pay or are paid at once at today's price. Goods you buy arrive when the caravans get home.</p>
      <table class="market"><thead><tr><th>Good</th><th>Stock</th><th class="pc">Buy</th><th class="pc">Sell</th><th class="sp">24h</th><th>Yours</th><th class="pch">Price for one</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">▲ made here and cheap, ▼ used here. A dot means the town is running short and pays well. Big orders move the price.</p>
    </div>
    <div class="section">
      <h4>Standing orders here</h4>
      ${orders.map((o) => { const x = orderText(o); return `<div class="row small"><span class="grow">${x.title}${o.limit ? `<i class=dot></i>${o.op === 'sell' ? 'not below' : 'not above'} ${price(o.limit)}` : ''}</span><button class="btn tiny ghost danger" data-act="order-del" data-id="${o.id}">Remove</button></div>`; }).join('')}
      <div class="row" style="margin-top:6px">
        <select class="in" data-order="op"><option value="sell" ${od.op === 'sell' ? 'selected' : ''}>Sell</option><option value="buy" ${od.op === 'buy' ? 'selected' : ''}>Buy</option></select>
        <select class="in" data-order="good">${GOOD_IDS.map((g) => `<option value="${g}" ${od.good === g ? 'selected' : ''}>${GOODS[g].name}</option>`).join('')}</select>
        <span class="small muted">${od.op === 'sell' ? 'whenever I hold more than' : 'whenever I hold less than'}</span><input class="in qty" type="number" min="0" value="${od.level}" data-order="level">
      </div>
      <div class="row"><span class="small muted">${od.op === 'sell' ? 'but not below ƒ' : 'but not above ƒ'}</span><input class="in qty" type="number" min="0" step="0.5" value="${od.limit}" data-order="limit"><span class="small muted">each (0 for any price)</span>
        <button class="btn" style="margin-left:auto" data-act="order-add" data-id="${t.id}">Add order</button></div>
      <p class="note">A free caravan goes by itself, one load of up to ${CARAVAN.capacity} at a time, whether or not you are playing.</p>
    </div>
    <div class="section"><h4>Roads</h4>
      <div class="row"><button class="btn" data-act="road" data-id="${t.id}">Build a road from here…</button></div>
      ${roadsAt(t.id)}
    </div>`;
}

function roadHtml(r) {
  if (!r) return '';
  const co = E(r.owner);
  const others = S.empires.filter((c) => c.id !== S.me.id);
  return `<div class="phead">${swatch(co?.color)}<h2>${esc(P(r.a)?.name)} – ${esc(P(r.b)?.name)}</h2>${closeBtn}</div>
    <div class="section"><dl class="kv"><dt>Owner</dt><dd>${esc(co?.name)}</dd><dt>Length</dt><dd class="num">${r.length} leagues</dd><dt>Toll</dt><dd class="num">${money(r.toll)} per trip</dd><dt>Built</dt><dd>${ago(r.builtAt)}</dd></dl>
    <p class="note">Caravans and couriers travel ${ROAD.speedMult}× as fast along a road and are safe from bandits. They take one whenever it is quicker. The owner travels free; everyone else pays the toll.</p></div>
    ${mine(r) ? `<div class="section"><h4>Manage</h4>
      <div class="row"><span class="small muted">Toll</span><input class="in qty" type="number" min="0" max="${ROAD.maxToll}" value="${r.toll}" data-input="toll"><button class="btn" data-act="toll" data-id="${r.id}">Set toll</button><span class="small muted">up to ${money(ROAD.maxToll)}</span></div>
      ${others.length ? `<div class="row"><span class="small muted">Sell to</span><select class="in" data-input="sell-to">${others.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><input class="in qty" type="number" min="0" value="${Math.round(r.cost * 0.6)}" data-input="sell-price" style="width:80px"><button class="btn" data-act="sell-road" data-id="${r.id}">Offer</button></div>` : ''}
    </div>` : ''}`;
}

// ---------- tools: things you do by clicking the map ----------
function setTool(tool) {
  map.tool = tool; map.toolCache = null;
  if (tool && small() && !tool.capital) { ui.sideOpen = false; ui.sel = null; map.sel = null; renderInspector(true); } // leave the map free to tap
  $('#map').classList.toggle('picking', !!tool);
  renderPickbar();
  if (S?.me) renderSide();
}

function renderPickbar() {
  const bar = $('#pickbar');
  const tool = map.tool;
  if (!tool || tool.capital) { bar.hidden = true; return; }
  let text = '';
  if (tool.type === 'build') {
    const def = BUILDINGS[tool.kind];
    const n = map.toolTiles()?.size || 0;
    text = `<span><b>${def.name}</b><i class=dot></i>${costHtml(def.cost, def.mats)}</span><span class="muted small">${n ? `${Tap} a highlighted plot` : 'None of your free plots suit it. Claim more land.'}</span>`;
  } else if (tool.type === 'claim') text = `<span><b>Claim land</b><i class=dot></i>next plot <span class="num">${money(claimCost(S.me.extra))}</span></span><span class="muted small">${Tap} a dashed plot beside your land</span>`;
  else if (tool.type === 'settle') text = `<span><b>Found an outpost</b></span><span class="muted small">${Tap} free land away from other settlements</span>`;
  else if (tool.type === 'place') text = `<span>${tool.label}</span>`;
  bar.innerHTML = `${text}<button class="btn tiny" data-act="tool-cancel">Done</button>`;
  bar.hidden = false;
}

// From far out a plot is only a few pixels across: the first tap zooms in on the spot instead of choosing it.
function zoomFirst(hit) {
  if (map.s * 20 >= 9) return false;
  map.centerOn(hit.tx * 20 + 10, hit.ty * 20 + 10, small() ? 0.9 : 1.1);
  return true;
}

async function useTool(hit) {
  const tool = map.tool;
  if (!tool) return;
  if (tool.type === 'build') {
    if (!map.toolTiles()?.has(tileKey(hit.tx, hit.ty))) return toast(`${BUILDINGS[tool.kind].name} cannot go there. ${BUILDINGS[tool.kind].blurb}`, true);
    await act({ type: 'build', kind: tool.kind, tx: hit.tx, ty: hit.ty });
  } else if (tool.type === 'claim') {
    const c = claimCheck(map.ctxRules, hit.tx, hit.ty, S.me.id);
    if (c.problem) return toast(c.problem, true);
    await act({ type: 'claim', tx: hit.tx, ty: hit.ty });
  } else if (tool.type === 'settle' && tool.capital) {
    if (zoomFirst(hit)) return;
    const bad = settleProblem(map.ctxRules, hit.tx, hit.ty, true, null);
    if (bad) return toast(bad, true);
    ui.found.at = [hit.tx, hit.ty]; tool.at = ui.found.at;
    renderFoundSite();
  } else if (tool.type === 'settle') {
    if (zoomFirst(hit)) return;
    const bad = settleProblem(map.ctxRules, hit.tx, hit.ty, false, S.me.id);
    if (bad) return toast(bad, true);
    const name = prompt('Name the outpost');
    if (!name) return;
    const r = await act({ type: 'outpost', tx: hit.tx, ty: hit.ty, name });
    if (r) { setTool(null); select({ kind: 'tile', tx: hit.tx, ty: hit.ty }); }
  } else if (tool.type === 'place') tool.done(hit.place);
}

function startRoad(fromId) {
  const A = P(fromId);
  const ok = (p) => p.id !== A.id && dist(A, p) <= ROAD.maxLength && !S.roads.some((r) => r.key === roadKey(A.id, p.id));
  setTool({
    type: 'place', ok, label: `<b>Road from ${esc(A.name)}</b> <span class="muted small">${Tap} a ringed town or settlement, up to ${ROAD.maxLength} leagues away</span>`,
    done: async (p) => {
      const cost = Math.round(ROAD.base + ROAD.costPerUnit * dist(A, p));
      setTool(null);
      if (!confirm(`Build a road from ${A.name} to ${p.name} for ${money(cost)}? Others will pay you a toll of ${money(ROAD.defaultToll)} per trip, which you can change.`)) return;
      await act({ type: 'buildRoad', a: A.id, b: p.id, toll: ROAD.defaultToll });
    },
  });
  // pull back far enough to see every place the road could reach
  layout();
  const { l, r, t, b } = map.pad;
  const fit = Math.min(map.w - l - r, map.hgt - t - b - 70) / (2 * ROAD.maxLength + 60);
  if (map.s > fit) map.centerOn(A.x, A.y, fit);
}

// ---------- modals ----------
function openModal(kind) { ui.modal = kind; renderModal(true); renderNav(); }
function closeModal() { if (!ui.modal) return; ui.modal = null; $('#modal').hidden = true; renderNav(); }

function renderModal(force = false) {
  const m = $('#modal');
  if (!ui.modal) { m.hidden = true; return; }
  const a = document.activeElement;
  if (!force && a && m.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA')) return;
  const html = { exchange: exchangeHtml, ledger: ledgerHtml, help: helpHtml, menu: menuHtml }[ui.modal]();
  const scroll = $('.mbody', m)?.scrollTop || 0;
  m.className = `modal is-${ui.modal}`;
  m.innerHTML = `<div class="card panel ${ui.modal === 'exchange' ? 'wide' : ''}">${html}</div>`;
  m.hidden = false;
  if ($('.mbody', m)) $('.mbody', m).scrollTop = scroll;
}

function ledgerHtml() {
  const cos = [...S.empires].sort((a, b) => b.worth - a.worth);
  return `<div class="phead"><h2>Standings</h2><span class="muted small">No winner, just bragging rights</span>${modalClose}</div>
    <div class="mbody"><ul class="list">${cos.map((c, i) => `<li class="click" data-act="goto-empire" data-id="${c.id}"><b class="num muted">${i + 1}</b>${swatch(c.color)}<div class="grow"><div class="title">${esc(c.name)} <span class="muted small" style="font-weight:500">${TIERS[c.tier].name}</span></div>
        <div class="sub">${c.pop.toLocaleString('en-US')} people<i class=dot></i>${c.land} plots<i class=dot></i>${c.buildings} buildings${c.leads.length ? `<i class=dot></i>leading maker of ${c.leads.map(lc).join(', ')}` : ''}</div></div>
        ${spark(c.worthHist.slice(-48), 70, 18, true)}<b class="num">${money(c.worth)}</b></li>`).join('')}</ul>
    <div class="pbody"><p class="note">Worth counts cash, land, buildings, caravans, roads and goods at their usual price.</p></div></div>`;
}

// --- the Exchange ---
function goodRows(rows, attr, options) {
  return rows.map((r, i) => `<div class="row">
      <select class="in" data-ex="${attr}.${i}.good" style="flex:1"><option value="">Choose a good…</option>${options(r.good).map(([g, label]) => `<option value="${g}" ${r.good === g ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <input class="in qty" type="number" min="1" placeholder="Qty" value="${esc(r.qty)}" data-ex="${attr}.${i}.qty">
      <button class="btn tiny ghost danger" data-act="ex-del" data-id="${attr}.${i}" title="Remove">✕</button></div>`).join('');
}
const rowsToGoods = (rows) => Object.fromEntries(rows.filter((r) => r.good && Number(r.qty) > 0).map((r) => [r.good, Math.floor(Number(r.qty))]));
const inStock = (cur) => GOOD_IDS.filter((g) => have(g) >= 1 || g === cur).map((g) => [g, `${GOODS[g].name} (you have ${have(g)})`]);
const anyGood = () => GOOD_IDS.map((g) => [g, GOODS[g].name]);

function lotHtml(l) {
  const m = S.me;
  const seller = E(l.seller);
  const isMine = l.seller === m.id;
  const eta = m.couriers[l.seller];
  const canPay = m.cash >= l.ask.cash && haveAll(l.ask.goods);
  const bid = ui.ex.bid?.listing === l.id ? ui.ex.bid : null;
  const myBids = l.bids.filter((b) => b.bidder === m.id);
  let foot = '';
  if (isMine) {
    foot = `${l.bids.length ? `<div class="bids"><div class="lbl">Counter bids</div>${l.bids.map((b) => `<div class="bid">${swatch(E(b.bidder)?.color)}<b>${esc(E(b.bidder)?.name)}</b> offers ${payHtml(b.pay)}${b.note ? `<span class="muted small">“${esc(b.note)}”</span>` : ''}
        <span class="acts"><button class="btn tiny primary" data-act="ex-accept-bid" data-id="${l.id}" data-bid="${b.id}">Accept</button><button class="btn tiny" data-act="ex-decline-bid" data-id="${l.id}" data-bid="${b.id}">Decline</button></span></div>`).join('')}</div>` : '<p class="note" style="margin:6px 0 0">No bids yet.</p>'}
      <div class="row" style="margin-top:8px"><button class="btn tiny danger" data-act="ex-cancel" data-id="${l.id}">Withdraw listing</button><span class="muted small">Your goods are held until it sells or you withdraw it.</span></div>`;
  } else {
    foot = `${myBids.length ? `<div class="bids"><div class="lbl">Your bids, held until answered</div>${myBids.map((b) => `<div class="bid">${payHtml(b.pay)}${b.note ? `<span class="muted small">“${esc(b.note)}”</span>` : ''}<span class="acts"><button class="btn tiny" data-act="ex-decline-bid" data-id="${l.id}" data-bid="${b.id}">Withdraw</button></span></div>`).join('')}</div>` : ''}
      ${bid ? `<div class="bidform"><div class="lbl">Your counter bid for ${chips(l.offer)}</div>
        <div class="row"><span class="small muted">Cash ƒ</span><input class="in qty" type="number" min="0" value="${esc(bid.cash)}" data-ex="bid.cash" style="width:90px"><span class="small muted">and / or goods</span></div>
        ${goodRows(bid.goods, 'bid.goods', inStock)}
        <div class="row"><button class="btn tiny" data-act="ex-add" data-id="bid.goods">+ Add goods</button><input class="in" style="flex:1" maxlength="120" placeholder="Note (optional)" value="${esc(bid.note)}" data-ex="bid.note"></div>
        <div class="row"><button class="btn primary" data-act="ex-send-bid" data-id="${l.id}">Send bid</button><button class="btn" data-act="ex-bid-cancel">Cancel</button><span class="muted small">What you offer is set aside until ${esc(seller?.name)} answers or you withdraw.</span></div></div>`
      : `<div class="row" style="margin-top:8px"><button class="btn ${canPay ? 'primary' : ''}" data-act="ex-buy" data-id="${l.id}" ${canPay ? '' : 'disabled title="You do not have the asking price"'}>Accept for ${payText(l.ask)}</button>
        <button class="btn" data-act="ex-bid" data-id="${l.id}">Counter bid…</button>${l.bidCount - myBids.length > 0 ? `<span class="muted small">${l.bidCount - myBids.length} other bid${l.bidCount - myBids.length > 1 ? 's' : ''}</span>` : ''}</div>`}`;
  }
  return `<div class="lot ${isMine ? 'mine' : ''}">
    <div class="lot-head">${swatch(seller?.color)}<b>${isMine ? 'Your listing' : esc(seller?.name)}</b><span class="muted small">${ago(l.t)}${!isMine && eta ? `<i class=dot></i>courier takes ${dur(eta * 3600e3)}` : ''}</span></div>
    <div class="lot-body"><div><div class="lbl">Selling</div><div class="chips">${chips(l.offer)}</div></div><div class="for">for</div><div><div class="lbl">Asking</div><div class="chips">${payHtml(l.ask)}</div></div></div>
    ${l.note ? `<p class="note" style="margin:6px 0 0">“${esc(l.note)}”</p>` : ''}${foot}</div>`;
}
function payText(pay) {
  const parts = [];
  if (pay.cash) parts.push(money(pay.cash));
  for (const [g, q] of Object.entries(pay.goods || {})) parts.push(`${q} ${lc(g)}`);
  return parts.join(' + ');
}

function exchangeHtml() {
  const x = ui.ex, m = S.me;
  const others = S.empires.filter((c) => c.id !== m.id);
  const tabs = [['listings', `Listings${S.listings.length ? ` (${S.listings.length})` : ''}`], ['new', 'Sell something'], ['notices', small() ? 'Notices' : 'Notices and payments']];
  let body = '';
  if (x.tab === 'listings') {
    const theirs = S.listings.filter((l) => l.seller !== m.id).sort((a, b) => b.t - a.t);
    const own = S.listings.filter((l) => l.seller === m.id).sort((a, b) => b.t - a.t);
    body = `<div class="pbody">
      ${!S.listings.length ? `<p class="note" style="margin-top:0">Nothing is listed yet. ${others.length ? 'Be the first: sell a surplus for cash, or swap it for something your land cannot give you.' : 'Once other players have settled, this is where you trade with them.'}</p><button class="btn primary" data-act="ex-tab" data-id="new">Sell something</button>` : ''}
      ${own.length ? `<h4 class="exh">Yours</h4>${own.map(lotHtml).join('')}` : ''}
      ${theirs.length ? `<h4 class="exh">From other empires</h4>${theirs.map(lotHtml).join('')}` : ''}</div>`;
  } else if (x.tab === 'new') {
    const offer = rowsToGoods(x.offer), ask = rowsToGoods(x.askGoods);
    const vo = baseValue(offer), va = (Number(x.askCash) || 0) + baseValue(ask);
    body = `<div class="pbody">
      <div class="newlot"><div><div class="lbl">What you are selling, from your stores</div>
          ${goodRows(x.offer, 'offer', inStock)}
          <button class="btn tiny" data-act="ex-add" data-id="offer">+ Add another good</button>
          <p class="note" id="ex-vo">${vo ? `Usually worth about ${money(vo)}.` : ''}</p></div>
        <div><div class="lbl">Your price</div>
          <div class="row"><span class="small muted">Cash ƒ</span><input class="in qty" type="number" min="0" placeholder="0" value="${esc(x.askCash)}" data-ex="askCash" style="width:100px"><span class="small muted">and / or goods:</span></div>
          ${goodRows(x.askGoods, 'askGoods', anyGood)}
          <button class="btn tiny" data-act="ex-add" data-id="askGoods">+ Ask for goods</button>
          <p class="note" id="ex-va">${va ? `Usually worth about ${money(va)}.` : ''}</p></div></div>
      <div class="row"><input class="in" style="flex:1" maxlength="120" placeholder="Note for buyers (optional)" value="${esc(x.note)}" data-ex="note"><button class="btn primary" data-act="ex-list">List it</button></div>
      <p class="note">The goods leave your stores and are held until someone accepts, you accept a counter bid, or you withdraw the listing. Other players can take your price as it stands or bid something else, in cash or goods. When a deal is struck, cash moves at once and couriers carry the goods between your capitals.</p></div>`;
  } else {
    body = `<div class="section"><h4>Post a notice</h4>
      <div class="row"><input class="in" style="flex:1" maxlength="280" placeholder="Looking for stone, can pay in fish…" data-input="post"><button class="btn primary" data-act="post">Post</button></div></div>
    ${others.length ? `<div class="section"><h4>Pay an empire</h4>
      <div class="row"><select class="in" data-input="pay-to">${others.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <input class="in qty" type="number" min="1" value="100" data-input="pay-amount" style="width:90px"><input class="in" style="flex:1" maxlength="80" placeholder="What for (shown in the Gazette)" data-input="pay-note">
      <button class="btn" data-act="pay">Pay</button></div>
      <p class="note">Payments are public. Use them for anything a listing cannot cover: a loan, rent, a favour.</p></div>` : ''}
    <div class="section"><h4>Notices</h4>
      ${S.board.length ? `<ul class="feed" style="margin:0 -12px">${S.board.map((b) => { const c = E(b.empire); return `<li><time>${ago(b.t)}</time><b style="color:${c?.color}">${esc(c?.name)}</b>: ${esc(b.text)}</li>`; }).join('')}</ul>` : '<p class="note">Nothing posted yet.</p>'}
    </div>`;
  }
  return `<div class="phead"><h2>The Exchange</h2><span class="muted small sub">Trade with the other empires</span>${modalClose}</div>
    <div class="tabs">${tabs.map(([k, n]) => `<button class="tab ${x.tab === k ? 'on' : ''}" data-act="ex-tab" data-id="${k}">${n}</button>`).join('')}</div><div class="mbody">${body}</div>`;
}

function helpHtml() {
  return `<div class="phead"><h2>How to play</h2>${modalClose}</div>
  <div class="mbody pbody" style="line-height:1.5">
    <p><b>There is no end and no winner.</b> The world runs in real time, all the time. Your empire keeps working while you are away, so check in a few times a day.</p>
    <p><b>Build on your land.</b> Open Build, pick a building and ${tap} a highlighted plot. Farms want plains, lumber camps forest, quarries hills, mines mountains, and fisheries and saltworks a plot beside water. Some plots are richer than others, and like buildings side by side help each other.</p>
    <p><b>House people.</b> Residents work your buildings and pay taxes, which is your steady income. They move in while their needs are met: grain, fish, salt and timber at first. Leave them short and they drift away.</p>
    <p><b>Rise in rank.</b> With enough people you can pay for a charter and become a village, a market town, a city. Each step raises taxes and lets buildings grow a level, and your people start wanting more: cloth, ale and stone, then tools and iron, then spices.</p>
    <p><b>Nobody's land has everything.</b> Claim more plots beside your own, found outposts on far-off land once you are a village, or trade for what you lack.</p>
    <p><b>Trade with towns.</b> ${Tap} a neutral town to buy and sell at its market. Your caravans carry the goods, so more caravans and nearer towns mean more trade. Standing orders keep them working while you are offline.</p>
    <p><b>Trade with each other.</b> On the Exchange, list goods from your stores for a price in cash, in other goods, or both. Others can accept your price or send a counter bid. Listings and bids are held in escrow, so nobody can back out, and couriers deliver the goods.</p>
    <p><b>Roads</b> make caravans and couriers ${Math.round((ROAD.speedMult - 1) * 100)}% faster, keep bandits off, and earn their owner a toll from everyone else who uses them.</p>
    <p class="note">Tip: when a store is full, the buildings that fill it stand idle. Sell the surplus, list it on the Exchange, or build a warehouse.</p>
  </div>`;
}

function menuHtml() {
  const m = S?.me;
  return `<div class="phead"><h2>${m ? esc(m.name) : esc(me.username)}</h2><span class="muted small">${m ? `${TIERS[m.tier].name}<i class=dot></i>` : ''}signed in as ${esc(me.username)}</span>${modalClose}</div>
  <div class="mbody">
  <div class="section"><div class="menu-list">
    <button class="btn" data-act="home">${icon('flag')}My capital</button>
    <button class="btn" data-act="world">${icon('globe')}Whole map</button>
    <button class="btn" data-act="ledger">${icon('chart')}Standings</button>
    <button class="btn" data-act="help">${icon('help')}How to play</button></div></div>
  <div class="section"><h4>Theme</h4><div class="row grow3">
    <button class="btn" data-act="theme" data-id="">Match system</button><button class="btn" data-act="theme" data-id="light">Light</button><button class="btn" data-act="theme" data-id="dark">Dark</button></div></div>
  <div class="section"><h4>Change password</h4>
    <div class="row stack"><input class="in" type="password" placeholder="Current" autocomplete="current-password" data-input="pw-cur"><input class="in" type="password" placeholder="New" autocomplete="new-password" data-input="pw-new"><button class="btn" data-act="pw">Change</button></div></div>
  ${me.admin ? `<div class="section"><h4>Admin: start a new world</h4>
    <p class="note" style="margin-top:0">Wipes the map and every empire, and starts over on fresh land. Accounts and passwords stay; everyone founds a new empire. The old world is kept as a backup.</p>
    <div class="row stack"><input class="in" placeholder="Type RESET" autocapitalize="characters" data-input="reset-confirm"><button class="btn danger" data-act="admin-reset">Start a new world</button></div></div>` : ''}
  ${me.admin ? `<div class="section"><h4>Admin: reset a password</h4>
    <div class="row stack"><input class="in" placeholder="Username" autocapitalize="none" data-input="ad-user"><input class="in" placeholder="New password" data-input="ad-pw"><button class="btn" data-act="admin-pw">Reset</button></div></div>` : ''}
  <div class="section"><div class="menu-list"><button class="btn danger" data-act="logout">${icon('out')}Sign out</button></div></div>
  </div>`;
}

// ---------- events ----------
const val = (name, root = document) => root.querySelector(`[data-input="${name}"]`)?.value;

function exPath(path) {
  const parts = path.split('.');
  let o = parts[0] === 'bid' ? ui.ex.bid : ui.ex;
  const keys = parts[0] === 'bid' ? parts.slice(1) : parts;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  return [o, keys[keys.length - 1]];
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.input === 'qty') ui.qty = Math.max(1, Math.floor(Number(t.value) || 1));
  if (t.dataset.order) ui.order[t.dataset.order] = t.dataset.order === 'level' || t.dataset.order === 'limit' ? Math.max(0, Number(t.value) || 0) : t.value;
  if (t.dataset.ex) {
    const [o, k] = exPath(t.dataset.ex);
    o[k] = t.value;
    if (ui.ex.tab === 'new') {
      const vo = baseValue(rowsToGoods(ui.ex.offer)), va = (Number(ui.ex.askCash) || 0) + baseValue(rowsToGoods(ui.ex.askGoods));
      if ($('#ex-vo')) $('#ex-vo').textContent = vo ? `Usually worth about ${money(vo)}.` : '';
      if ($('#ex-va')) $('#ex-va').textContent = va ? `Usually worth about ${money(va)}.` : '';
    }
  }
  if (t.dataset.found) { ui.found[t.dataset.found] = t.value; }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.input === 'qty') renderInspector(true);
  if (t.dataset.order === 'op') renderInspector(true);
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  const { act: a, id } = el.dataset;
  const x = ui.ex;
  switch (a) {
    case 'close': select(null); break;
    case 'tab': ui.sideOpen = true; ui.tab = id; if (map.tool && id !== 'build') setTool(null); renderSide(); break;
    case 'nav': {
      if (id === 'exchange') {
        if (ui.modal === 'exchange') { closeModal(); break; }
        ui.sideOpen = false; if (map.tool) setTool(null); select(null); renderSide(); openModal('exchange');
        break;
      }
      const wasOpen = ui.sideOpen && ui.tab === id && !ui.modal;
      closeModal();
      if (map.tool && (id !== 'build' || wasOpen || !ui.sideOpen)) setTool(null);
      ui.tab = id; ui.sideOpen = !wasOpen;
      if (ui.sideOpen) { ui.sel = null; map.sel = null; renderInspector(true); }
      renderSide();
      break;
    }
    case 'side-close': ui.sideOpen = false; renderSide(); break;
    case 'news-tab': ui.newsTab = id; renderSide(); break;
    case 'home': { closeModal(); layout(); const c = mySettlements().find((s) => s.capital); if (c) map.centerOn(c.x, c.y, Math.max(map.s, small() ? 1.5 : 1.7)); break; }
    case 'world': closeModal(); if (small()) { ui.sideOpen = false; renderSide(); } layout(); map.fit(); break;
    case 'sel-town': { const t = T(id); layout(); if (t && !map.inView(t.x, t.y)) map.centerOn(t.x, t.y, Math.max(map.s, 0.5)); select({ kind: 'town', id }); break; }
    case 'sel-road': select({ kind: 'road', id }); break;
    case 'goto-empire': { const c = S.settlements.find((s) => s.owner === id && s.capital); if (c) { closeModal(); if (small()) { ui.sideOpen = false; renderSide(); } layout(); map.centerOn(c.x, c.y, Math.max(map.s, 1.4)); } break; }
    case 'news-toggle': ui.newsOpen = !ui.newsOpen; renderNews(); break;
    // land and buildings
    case 'tool-build': if (!el.classList.contains('locked')) setTool(map.tool?.type === 'build' && map.tool.kind === id ? null : { type: 'build', kind: id }); else toast(`Only ${article(tierName(BUILDINGS[id].tier))} or larger can build that.`, true); break;
    case 'tool-claim': setTool(map.tool?.type === 'claim' ? null : { type: 'claim' }); break;
    case 'tool-outpost': setTool(map.tool?.type === 'settle' ? null : { type: 'settle', capital: false, color: S.me.color }); break;
    case 'tool-cancel': setTool(null); break;
    case 'build-here': await act({ type: 'build', kind: id, tx: ui.sel.tx, ty: ui.sel.ty }); break;
    case 'claim-here': await act({ type: 'claim', tx: ui.sel.tx, ty: ui.sel.ty }); break;
    case 'outpost-here': await act({ type: 'outpost', tx: ui.sel.tx, ty: ui.sel.ty, name: val('outpost-name') }); break;
    case 'upgrade': await act({ type: 'upgrade', building: id }); break;
    case 'pause': await act({ type: 'pause', building: id, on: !!el.dataset.on }); break;
    case 'demolish': if (confirm('Pull this down? You get 30% of its price back, and none of the materials.')) await act({ type: 'demolish', building: id }); break;
    case 'charter': { const next = TIERS[S.me.tier + 1]; if (confirm(`Become ${article(next.name.toLowerCase())}? Taxes rise${Object.keys(next.needs).length ? `, and your people will start wanting ${Object.keys(next.needs).map(lc).join(', ')}` : ''}.`)) await act({ type: 'charter' }); break; }
    case 'rename': await act({ type: 'renameSettlement', settlement: id, name: val('rename') }); renderInspector(true); break;
    // caravans and markets
    case 'buy-caravan': await act({ type: 'buyCaravan' }); break;
    case 'sell-caravan': if (confirm(`Sell a caravan for ${money(CARAVAN.cost * 0.5)}?`)) await act({ type: 'sellCaravan' }); break;
    case 'mbuy': await act({ type: 'marketBuy', town: ui.sel.id, good: el.dataset.good, qty: ui.qty }); ui.townCache[ui.sel.id] = null; break;
    case 'msell': await act({ type: 'marketSell', town: ui.sel.id, good: el.dataset.good, qty: ui.qty }); ui.townCache[ui.sel.id] = null; break;
    case 'order-add': await act({ type: 'setOrder', town: id, ...ui.order }); renderInspector(true); break;
    case 'order-del': e.stopPropagation(); await act({ type: 'removeOrder', order: id }); renderInspector(true); break;
    // roads
    case 'road': startRoad(id); break;
    case 'toll': await act({ type: 'setToll', road: id, toll: Number(val('toll')) }); break;
    case 'sell-road': await act({ type: 'sellRoad', road: id, to: val('sell-to'), price: Number(val('sell-price')) }); break;
    case 'offer-accept': await act({ type: 'acceptOffer', offer: id }); break;
    case 'offer-decline': await act({ type: 'declineOffer', offer: id }); break;
    // modals
    case 'exchange': if (ui.modal === 'exchange') closeModal(); else openModal('exchange'); break;
    case 'ledger': openModal('ledger'); break;
    case 'help': openModal('help'); break;
    case 'menu': if (ui.modal === 'menu') closeModal(); else openModal('menu'); break;
    case 'modal-close': closeModal(); break;
    // the Exchange
    case 'ex-tab': x.tab = id; renderModal(true); break;
    case 'ex-add': { const [o, k] = exPath(id); o[k].push({ good: '', qty: '' }); renderModal(true); break; }
    case 'ex-del': { const i = id.lastIndexOf('.'); const [o, k] = exPath(id.slice(0, i)); o[k].splice(Number(id.slice(i + 1)), 1); renderModal(true); break; }
    case 'ex-list': {
      const r = await act({ type: 'list', offer: rowsToGoods(x.offer), ask: { cash: Number(x.askCash) || 0, goods: rowsToGoods(x.askGoods) }, note: x.note });
      if (r) { Object.assign(x, { tab: 'listings', offer: [{ good: '', qty: '' }], askCash: '', askGoods: [], note: '' }); renderModal(true); }
      break;
    }
    case 'ex-buy': { const l = S.listings.find((q) => q.id === id); if (l && confirm(`Buy ${payText({ goods: l.offer })} from ${E(l.seller)?.name} for ${payText(l.ask)}?`)) { await act({ type: 'buyListing', listing: id }); renderModal(true); } break; }
    case 'ex-bid': x.bid = { listing: id, cash: '', goods: [], note: '' }; renderModal(true); break;
    case 'ex-bid-cancel': x.bid = null; renderModal(true); break;
    case 'ex-send-bid': { const r = await act({ type: 'bid', listing: id, pay: { cash: Number(x.bid.cash) || 0, goods: rowsToGoods(x.bid.goods) }, note: x.bid.note }); if (r) x.bid = null; renderModal(true); break; }
    case 'ex-accept-bid': await act({ type: 'acceptBid', listing: id, bid: el.dataset.bid }); renderModal(true); break;
    case 'ex-decline-bid': await act({ type: 'declineBid', listing: id, bid: el.dataset.bid }); renderModal(true); break;
    case 'ex-cancel': await act({ type: 'cancelListing', listing: id }); renderModal(true); break;
    case 'post': { const r = await act({ type: 'post', text: val('post') }); if (r) renderModal(true); break; }
    case 'pay': {
      const amt = Number(val('pay-amount'));
      if (!confirm(`Pay ${money(amt)} to ${E(val('pay-to'))?.name}?`)) break;
      const r = await act({ type: 'pay', to: val('pay-to'), amount: amt, note: val('pay-note') });
      if (r) renderModal(true);
      break;
    }
    // account
    case 'theme': {
      if (id) document.documentElement.dataset.theme = id; else delete document.documentElement.dataset.theme;
      renderLegend();
      try { localStorage.setItem('ht-theme', id || ''); } catch { /* private mode */ }
      break;
    }
    case 'pw': try { await api('/api/password', { current: val('pw-cur'), next: val('pw-new') }); toast('Password changed'); } catch (err) { toast(err.message, true); } break;
    case 'admin-pw': try { await api('/api/admin/password', { username: val('ad-user'), password: val('ad-pw') }); toast('Password reset'); } catch (err) { toast(err.message, true); } break;
    case 'admin-reset': {
      if (val('reset-confirm') !== 'RESET') { toast('Type RESET in the box to confirm.', true); break; }
      if (!confirm('Really start a new world for everyone?')) break;
      try { await api('/api/admin/reset', { confirm: 'RESET' }); location.reload(); } catch (err) { toast(err.message, true); }
      break;
    }
    case 'logout': await api('/api/logout', {}); location.reload(); break;
    // founding
    case 'found-color': ui.found.color = id; map.tool.color = id; document.querySelectorAll('.colors button').forEach((b) => b.classList.toggle('on', b.dataset.id === id)); break;
    case 'found-go': {
      const f = ui.found;
      if (!f.at) { toast(`${Tap} the map to choose where to settle.`, true); break; }
      try { await api('/api/empire', { name: f.name, seat: f.seat, color: f.color, tx: f.at[0], ty: f.at[1] }); setTool(null); await boot(); }
      catch (err) { toast(err.message, true); try { apply(await api('/api/state')); } catch { /* keep the old picture */ } }
      break;
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (map.tool && !map.tool.capital) setTool(null);
  else if (ui.modal) closeModal();
  else select(null);
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

// ---------- sign-in and founding ----------
function gate(html) { const g = $('#gate'); g.innerHTML = `<div class="card panel">${html}</div>`; g.hidden = false; return g; }

const BIGLOGO = `<span class="brand"><span class="mark" style="width:34px;height:34px">${LOGO(20)}</span></span>`;

function showAuth(inviteRequired, mode = 'login') {
  const g = gate(`
    <h1>${BIGLOGO} Saltroad</h1>
    <p class="lede">Build an empire from open land, and trade with your friends for what yours cannot give you. It never stops, and nobody wins.</p>
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

function siteHtml() {
  const at = ui.found.at;
  if (!at) return `<p class="note sitehint">${Tap} the map to zoom in, then ${tap} the spot where you want to settle. ${TOUCH ? 'Drag to look around and pinch to zoom' : 'Drag to look around and scroll to zoom'}. Look for a mix of land: plains to farm, forest for timber, water for fish and salt, hills for stone.</p>`;
  const [tx, ty] = at;
  const tiles = settleTiles(map.ctxRules, tx, ty, true);
  const kinds = {}; let coast = 0;
  for (const [x, y] of tiles) { const k = map.terrain.tile(x, y).kind; kinds[k] = (kinds[k] || 0) + 1; if (map.terrain.coastal(x, y)) coast++; }
  const can = BUILD_ORDER.filter((k) => BUILDINGS[k].out && tiles.some(([x, y]) => siteOk(BUILDINGS[k], map.terrain.tile(x, y).kind, map.terrain.coastal(x, y))));
  const cannot = BUILD_ORDER.filter((k) => BUILDINGS[k].out && !can.includes(k));
  const c = { x: tx * 20 + 10, y: ty * 20 + 10 };
  const near = [...S.towns].sort((p, q) => dist(p, c) - dist(q, c)).slice(0, 3);
  return `<div class="site"><div class="lbl">Your first ${tiles.length} plots here</div>
    <div class="chips">${Object.entries(kinds).map(([k, n]) => `<span class="chip">${n} ${k}</span>`).join('')}${coast ? `<span class="chip">${coast} by water</span>` : ''}</div>
    <p class="note">You can make ${can.map((k) => lc(BUILDINGS[k].out)).join(', ') || 'nothing raw'} here${cannot.length ? `, but not ${cannot.map((k) => lc(BUILDINGS[k].out)).join(', ')} until you claim other land or trade for it` : ''}.</p>
    <p class="note">Nearest markets: ${near.map((t) => `${esc(t.name)} (${dur((dist(t, c) / CARAVAN.speed) * 2 * 3600e3)} round trip, makes ${t.resources.map((r) => lc(r.good)).join(', ')})`).join('; ')}.</p></div>`;
}
function renderFoundSite() { const el = $('#found-site'); if (el) el.innerHTML = siteHtml(); $('#found-go')?.toggleAttribute('disabled', !ui.found.at); }

function showFound(st) {
  $('#gate').hidden = true;
  for (const id of ['topbar', 'news', 'inspector', 'nav']) $('#' + id).hidden = true;
  apply(st);
  const taken = new Set(st.empires.map((x) => x.color));
  ui.found.color ||= EMPIRE_COLORS.find((c) => !taken.has(c)) || EMPIRE_COLORS[0];
  const el = $('#side');
  el.hidden = false; el.classList.add('founding');
  el.innerHTML = `<div class="pbody">
    <h1 class="foundh">${BIGLOGO} Found your empire</h1>
    <p class="lede">You start with ${money(START.cash)}, ${START.caravans} caravans and stores of timber, stone and food. ${st.empires.length ? `${st.empires.length} ${st.empires.length === 1 ? 'empire has' : 'empires have'} already settled.` : 'You are the first to arrive.'}</p>
    ${small() ? '<div id="found-site">' + siteHtml() + '</div>' : ''}
    <label>Empire name</label><input class="in" data-found="name" maxlength="28" placeholder="House Harker" value="${esc(ui.found.name)}">
    <label>Capital name <span class="muted" style="font-weight:500">(optional)</span></label><input class="in" data-found="seat" maxlength="24" placeholder="Same as the empire" value="${esc(ui.found.seat)}">
    <label>Colour</label><div class="colors">${EMPIRE_COLORS.filter((c) => !taken.has(c)).map((c) => `<button type="button" data-act="found-color" data-id="${c}" class="${c === ui.found.color ? 'on' : ''}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>
    ${small() ? '' : '<div id="found-site">' + siteHtml() + '</div>'}
    <div class="actions"><button class="btn primary" id="found-go" data-act="found-go" ${ui.found.at ? '' : 'disabled'}>Settle here</button><button class="btn ghost" data-act="logout">Sign out</button></div>
  </div>`;
  layout();
  map.fit();
  setTool({ type: 'settle', capital: true, color: ui.found.color, at: ui.found.at });
}

let poller, started = false;
async function boot() {
  try { const th = localStorage.getItem('ht-theme'); if (th) document.documentElement.dataset.theme = th; } catch { /* ignore */ }
  const r = await api('/api/me');
  if (!r.user) return showAuth(r.inviteRequired);
  me = r.user;
  const st = await api('/api/state');
  if (!st.me) return showFound(st);
  $('#gate').hidden = true;
  $('#side').classList.remove('founding');
  for (const id of ['topbar', 'side', 'news', 'nav']) $('#' + id).hidden = false;
  if (!started) ui.sideOpen = !small(); // a phone opens on the map, with the sections a tap away
  apply(st);
  layout();
  const cap = st.settlements.find((s) => s.owner === st.me.id && s.capital);
  if (cap) map.centerOn(cap.x, cap.y, small() ? 1.6 : 1.9);
  if (started) return;
  started = true;
  clearInterval(poller);
  poller = setInterval(() => { if (!document.hidden) refresh(); }, 6000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  let seen = null;
  try { seen = localStorage.getItem('sr-seen-help'); localStorage.setItem('sr-seen-help', '1'); } catch { /* ignore */ }
  if (!seen) openModal('help');
}

// turning a phone, or resizing a window across the line between the two layouts
PHONE.addEventListener('change', () => {
  if (!S?.me) { if (!$('#side').hidden) { layout(); map.fit(); } return; }
  ui.sideOpen = !small();
  renderSide(); renderInspector(true); renderModal(true); layout();
});

boot().catch((e) => gate(`<h1>Saltroad</h1><p class="lede">Could not reach the server: ${esc(e.message)}</p>`));
