// Malaybalay City Hall Kiosk — web prototype (mirrors the Figma kiosk screens K1–K13).
// Works offline from the last downloaded bundle; syncs when the server is reachable.
import { icon } from '../shared/icons.js';
import { t, setLang, getLang, direction } from '../shared/i18n.js';
import { planRouteCore } from '../shared/route-core.js';
import { planGraphRoute, resolveDestination, doorForRoom } from '../shared/nav-graph.js';
import { routeFloorSVG, floorPlanSVG, floorBounds, placeWalker, followWalker } from '../shared/route-map.js';
import { loadPlans, planFor } from '../shared/plans.js';
import { buildWalk, activeDirection } from '../shared/walk-path.js';

const params = new URLSearchParams(location.search);
const KIOSK = params.get('kiosk') || 'KIOSK-LOBBY-1';
// Staff preview of draft (unverified) routes: only when the URL asks AND the server has preview switched on.
const PREVIEW = params.get('preview') === '1';
const APP_VERSION = 'web-0.1.0';
const WARN_S = 15;
const LS = { bundle: 'kiosk.bundle', fbq: 'kiosk.feedbackQueue', lang: 'kiosk.lang' };

// Layout: portrait (designed at 1080 × 1920) or landscape (1920 × 1080), picked from the window's shape
// unless forced with /kiosk/landscape or ?layout=portrait|landscape. Phones get "compact": a narrower,
// larger-text version of portrait. See fit().
const FORCED = params.get('layout') || (/\/landscape\/?$/.test(location.pathname) ? 'landscape' : null);
const isPhone = () => !FORCED && Math.min(innerWidth, innerHeight) < 540;
let LAYOUT = 'portrait';
// Idle privacy reset is for the shared kiosk; a visitor's own phone doesn't need it. ?idle=0 disables it (demos/testing).
const IDLE_MS = Number(params.get('idle') ?? (isPhone() ? 0 : 60)) * 1000;

const stage = document.getElementById('stage');
const S = {
  bundle: null, online: true, savedAt: null, publicBase: location.origin,
  stack: [], query: '', kbMode: 'abc', filter: 'all', floorFilter: 'all', mapFloor: 1,
  nav: null, idleTimer: null, warnTimer: null, suggestTimer: null, lastSuggest: [],
  prefs: { stepFree: false },
  plans: null, mapMode: '3d', mapCtrl: null, mapGen: 0, mapAbort: null,
  navGen: 0, navAbort: null, // every navigation start/stop bumps navGen; late async results from older starts are dropped
};
const idx = { services: new Map(), offices: new Map(), rooms: new Map() };
const LANGS = [['en', 'English'], ['fil', 'Filipino'], ['ceb', 'Cebuano']];

// ---------------------------------------------------------------- utilities
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = sel => stage.querySelector(sel);
const fmtTime = iso => { try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
const safeLS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = msg;
  stage.appendChild(el); setTimeout(() => el.remove(), 2600);
}
// The stage always fills the window. It is laid out in design pixels and scaled, so the kiosk screen
// (1080 × 1920 or 1920 × 1080) renders 1:1 and other screens get the same design, reflowed to their shape:
// 4K/TV and desktops scale up or down, iPads get portrait or landscape by orientation, phones get compact.
function fit() {
  const w = innerWidth, h = innerHeight, compact = isPhone();
  const layout = FORCED ? (FORCED === 'landscape' ? 'landscape' : 'portrait') : !compact && w / h >= 1.15 ? 'landscape' : 'portrait';
  const s = compact ? Math.min(0.75, w / 600, h / 640) : layout === 'landscape' ? Math.min(w / 1920, h / 1000) : Math.min(w / 1080, h / 1500);
  const sw = w / s, narrow = sw < 900;
  const changed = layout !== LAYOUT || compact !== stage.classList.contains('compact') || narrow !== stage.classList.contains('narrow');
  stage.style.width = `${sw}px`; stage.style.height = `${h / s}px`;
  stage.style.transform = `scale(${s})`;
  stage.classList.toggle('landscape', layout === 'landscape');
  stage.classList.toggle('compact', compact);
  stage.classList.toggle('narrow', narrow);
  LAYOUT = layout;
  if (changed && S.stack.length) { // e.g. a tablet rotated: redraw the current screen for the new layout
    stopNav();
    rerender();
  }
  updateScrollFades();
}
addEventListener('resize', fit); fit();

// ---------------------------------------------------------------- data
function indexBundle(b) {
  idx.services = new Map(b.services.map(s => [s.id, s]));
  idx.offices = new Map(b.offices.map(o => [o.id, o]));
  idx.rooms = new Map(b.floors.flatMap(f => f.rooms.map(r => [r.id, { ...r, floor_level: f.level, floor_name: f.name }])));
}
async function loadBundle() {
  try {
    const b = await api(`/api/kiosk/bundle?kiosk=${encodeURIComponent(KIOSK)}`);
    S.bundle = b; S.online = true; S.savedAt = b.generated_at;
    if (!safeLS.set(LS.bundle, JSON.stringify(b))) console.warn('Could not save offline copy (storage full or blocked).');
  } catch (e) {
    const cached = safeLS.get(LS.bundle);
    if (!cached) throw e;
    S.bundle = JSON.parse(cached); S.online = false; S.savedAt = S.bundle.generated_at;
  }
  indexBundle(S.bundle);
  S.plans = await loadPlans(S.bundle.navigation);
  try { S.publicBase = (await api('/api/config')).public_base_url; } catch {}
}
async function syncLoop() {
  try {
    const { content_version } = await api('/api/kiosk/version');
    const wasOffline = !S.online;
    S.online = true;
    if (content_version !== S.bundle?.content_version) {
      await loadBundle();
      // the loaded building outlives routes: its sign labels must follow published content even between routes
      if (S.buildingUsed) import('./three/building-viewer.js').then(m => m.getViewer().updateContent(S.bundle)).catch(() => {});
      if (S.nav && ['navigate', 'noroute', 'arrived'].includes(current())) navContentChanged();
      else if (current() === 'welcome' || wasOffline) rerender();
    }
    else if (wasOffline) rerender();
    await api(`/api/kiosks/${encodeURIComponent(KIOSK)}/heartbeat`, { method: 'POST', body: JSON.stringify({ app_version: APP_VERSION, content_version: S.bundle.content_version }) }).catch(() => {});
    flushFeedback();
  } catch {
    if (S.online) { S.online = false; rerender(); }
  }
}
function flushFeedback() {
  const q = JSON.parse(safeLS.get(LS.fbq) || '[]');
  if (!q.length) return;
  Promise.all(q.map(f => api('/api/feedback', { method: 'POST', body: JSON.stringify(f) }))).then(() => safeLS.set(LS.fbq, '[]')).catch(() => {});
}
const floorName = lvl => S.bundle.floors.find(f => f.level === lvl)?.name || '';

// ---------------------------------------------------------------- search
function normalize(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function localSearch(q) {
  const nq = normalize(q); if (!nq) return [];
  const words = nq.split(' ');
  const out = [];
  for (const s of S.bundle.services) {
    const hay = normalize(`${s.display_title} ${s.title} ${(s.keywords || []).join(' ')} ${s.office_name}`);
    const hits = words.filter(w => hay.includes(w)).length;
    if (hits === words.length) out.push({ kind: 'service', id: s.id, title: s.display_title, subtitle: `${s.office_name} · ${s.location?.floor_name || t('not_in_building')}`, score: hay.startsWith(nq) ? 20 : 10 });
  }
  for (const o of S.bundle.offices) if (normalize(o.name).includes(nq) || normalize(o.short_name) === nq) out.push({ kind: 'office', id: o.id, title: o.name, subtitle: o.location?.floor_name || t('not_in_building'), score: 15 });
  return out.sort((a, b) => b.score - a.score).slice(0, 25);
}
async function doSearch(q, log) {
  if (!q.trim()) return [];
  if (S.online) {
    try { return (await api(`/api/search?q=${encodeURIComponent(q)}&kiosk=${encodeURIComponent(KIOSK)}&log=${log ? 1 : 0}`)).results; } catch { S.online = false; }
  }
  return localSearch(q);
}

// ---------------------------------------------------------------- chrome
function topbar() {
  const l = getLang();
  return `<header class="topbar">
    <button class="brand-home" data-action="home" aria-label="${t('home')}"><img class="seal" src="/img/malaybalay-seal.jpg" alt="">
    <span class="identity"><span class="label">${t('kiosk_name')}</span><span class="caption">${t('city')}</span></span></button>
    <div class="spacer"></div>
    <div class="seg" role="group" aria-label="${t('language')}">
      ${LANGS.map(([x, name]) => `<button data-action="lang" data-lang="${x}" aria-pressed="${l === x}">${LAYOUT === 'landscape' ? name : x.toUpperCase()}</button>`).join('')}
    </div>
    <button class="tb-btn" data-action="large" aria-pressed="${stage.classList.contains('large')}">${icon('text-size', 30)}<span>${t('large_text')}</span></button>
    <button class="tb-btn" data-action="home">${icon('home', 30)}<span>${t('home')}</span></button>
  </header>${S.online ? '' : `<div class="banner warning" role="status">${icon('wifi-off', 36)}<span>${t('offline_banner', { t: fmtTime(S.savedAt) })}</span></div>`}
  ${announcementBanner()}`;
}
function announcementBanner() {
  const a = (S.bundle?.announcements || []).find(x => x.tone !== 'info');
  return a ? `<div class="banner ${a.tone === 'critical' ? 'critical' : 'warning'}">${icon('megaphone', 32)}<span><b>${esc(a.title)}</b> — ${esc(a.body)}</span></div>` : '';
}
const helpbar = () => `<div class="helpbar">${icon('users', 36)}<span>${t('help_bar')}</span></div>`;
const backBtn = (label = t('back')) => `<button class="back" data-action="back">${icon('arrow-left', 36)}<span>${esc(label)}</span></button>`;
function rowHTML(item) {
  const isOffice = item.kind === 'office';
  return `<button class="row"${item.current ? ' aria-current="true"' : ''} data-action="${isOffice ? 'office' : 'service'}" data-id="${item.id}">
    <span class="tile">${icon(isOffice ? 'building' : 'file-text', 36)}</span>
    <span class="txt"><span class="title">${esc(item.title)}</span>${item.subtitle ? `<span class="sub">${esc(item.subtitle)}</span>` : ''}${item.meta ? `<span class="sub meta">${esc(item.meta)}</span>` : ''}</span>
    <span class="chev">${icon('chevron-right', 36)}</span></button>`;
}
// An approved plain-language line in the visitor's language (English when not yet translated), or null.
const summaryOf = x => x?.summary ? (x.summary[getLang()] || x.summary.en || null) : null;
// Browse groups, in walking order: each floor of the building, then offices whose room is not confirmed, then off-site.
function officeGroups(filter = 'all') {
  const floors = S.bundle.floors.filter(fl => S.bundle.offices.some(o => o.location?.room_id && o.location.floor_level === fl.level));
  const groups = floors.map(fl => ({ key: String(fl.level), label: fl.name, items: S.bundle.offices.filter(o => o.location?.room_id && o.location.floor_level === fl.level) }));
  groups.push({ key: 'unconfirmed', label: t('location_unconfirmed'), items: S.bundle.offices.filter(o => o.location_type !== 'offsite' && !o.location?.room_id) });
  groups.push({ key: 'out', label: t('not_in_building'), items: S.bundle.offices.filter(o => o.location_type === 'offsite') });
  return groups.filter(g => g.items.length && (filter === 'all' || filter === g.key || (filter === 'out' && g.key === 'unconfirmed')));
}
function officeRow(o, current = false) {
  const sum = summaryOf(o);
  return rowHTML({ kind: 'office', id: o.id, title: o.name, subtitle: sum ? t('helps_with', { text: sum }) : '',
    meta: `${locText(o.location)} · ${t('services_count', { n: o.service_count })}`, current });
}
// An office's services: public first, then the ones the Charter lists for other government offices.
function officeServicesHTML(o) {
  const svcs = S.bundle.services.filter(s => s.office_id === o.id);
  const time = s => { const v = String(s.total_processing_time || '').trim(); return v && v.length <= 40 && !v.includes('\n') ? t('about_time', { t: v.toLowerCase() }) : ''; };
  const facts = s => [s.classification && s.classification.length <= 24 ? s.classification : '', time(s)].filter(Boolean).join(' · ');
  const row = s => { const sum = summaryOf(s); return rowHTML({ kind: 'service', id: s.id, title: s.display_title, subtitle: sum || facts(s), meta: sum ? facts(s) : '' }); };
  const pub = svcs.filter(s => s.is_citizen_facing), gov = svcs.filter(s => !s.is_citizen_facing);
  return `${pub.length ? `<h2 class="h2 svc-list-h">${gov.length ? t('public_services') : t('office_services')} (${pub.length})</h2><div class="list">${pub.map(row).join('')}</div>` : ''}
    ${gov.length ? `<h2 class="h2 svc-list-h">${t('gov_services')} (${gov.length})</h2><div class="list">${gov.map(row).join('')}</div>` : ''}`;
}
// "1st floor · Room 1F-102 · Inside City Hall" (or off-site / to be confirmed)
function officeWhere(o, { short = false } = {}) {
  const l = o.location;
  if (o.location_type === 'offsite') return o.offsite_address || t('not_in_building');
  if (!l?.room_id) return t('location_unconfirmed');
  const room = l.room_code ? t('room_n', { c: l.room_code }) : '';
  return short ? [l.floor_name, room].filter(Boolean).join(', ') : [l.floor_name, room, t('inside_hall')].filter(Boolean).join(' · ');
}
// Left column: open-now (City Hall hours), office hours, phone, where; then "Show me the way" for offices in the building
function officeInfoHTML(o) {
  const inBuilding = o.location?.room_id, sum = summaryOf(o), st = openStatus(new Date());
  const item = (ic, label, value) => value ? `<div class="info-row"><span class="info-ic">${icon(ic, 32)}</span><div class="info-txt"><span class="body muted">${label}</span><span class="info-val">${esc(value)}</span></div></div>` : '';
  return `${sum ? `<p class="body office-sum">${esc(t('helps_with', { text: sum }))}</p>` : ''}
    <div class="card office-info">
      ${inBuilding ? `<span class="open-pill ${st.open ? 'is-open' : 'is-closed'}"><i class="dot"></i>${esc(st.text)}</span>` : ''}
      ${item('clock', t('office_hours'), o.hours)}
      ${item('phone', t('phone'), o.phone)}
      ${item('map-pin', t('where_label'), officeWhere(o, { short: true }))}
    </div>
    ${inBuilding ? `<button class="btn btn-primary btn-block" data-action="navoffice" data-id="${o.id}">${icon('navigation', 36)}${t('show_way')}</button>` : ''}`;
}
function officePanelHTML(o) {
  if (!o) return `<p class="body muted browse-empty">${t('choose_office')}</p>`;
  return `<h2 class="h2">${esc(o.name)}</h2><p class="body muted">${esc(officeWhere(o))}</p>${officeInfoHTML(o)}${officeServicesHTML(o)}`;
}

function locText(loc) {
  if (!loc || loc.type === 'unconfirmed' && !loc.room_id) return t('location_unconfirmed');
  if (loc.type === 'offsite') return t('not_in_building');
  return [loc.floor_name, loc.room_code].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- screens
const screens = {
  welcome() {
    const l = getLang();
    const name = t('kiosk_name');
    const title = t('welcome_title').replace(new RegExp('\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      () => `<br>${name.split(' ').length > 2 ? `<span class="nowrap">${name.split(' ')[0]}</span><br><span class="nowrap">${name.split(' ').slice(1).join(' ')}</span>` : `<span class="nowrap">${name}</span>`}`);
    const st = openStatus(new Date());
    const openPill = cls => `<span class="wp-open ${cls} ${st.open ? 'is-open' : 'is-closed'}"><i class="dot"></i><span class="wp-open-txt">${esc(st.text)}</span></span>`;
    return `<section class="screen welcome premium" data-action="start" aria-label="${esc(t('welcome_title'))}">
      <div class="wp-photo"><img src="/img/cityhall-cover.jpg" alt=""></div>
      <div class="wp-shade"></div>
      <header class="wp-top">
        <img class="seal" src="/img/malaybalay-seal.jpg" alt="">
        <div class="identity"><span class="caption">${t('gov_name')}</span><span class="label">${name}</span></div>
        <div class="wp-clock glass">
          <span class="wp-time-col"><span class="wp-time" data-clock="time"></span><span class="wp-date" data-clock="date"></span></span>
          <span class="wp-sep"></span>${openPill('in-clock')}
        </div>
      </header>
      <div class="wp-panel">
        ${openPill('in-panel')}
        <p class="wp-greet">${t('welcome_sub')}</p>
        <h1 class="wp-title${t('welcome_title').length > 34 ? ' long' : ''}">${title}</h1>
        <button class="wp-cta" data-action="start"><span class="wp-cta-ic">${icon('navigation', 44)}</span><span>${t('touch_to_start')}</span></button>
      </div>
      <footer class="wp-foot">
        <div class="wp-lang glass" role="group" aria-label="${t('language')}">
          ${LANGS.map(([k, n]) => `<button data-action="lang" data-lang="${k}" aria-pressed="${l === k}">${n}</button>`).join('')}
        </div>
        <span class="wp-hint">${t('touch_anywhere')}</span>
      </footer></section>`;
  },

  home() {
    const pop = (S.bundle.popular_service_ids || []).map(id => idx.services.get(id)).filter(Boolean);
    return `<section class="screen">${topbar()}
      <div class="page-head home-head"><img class="head-photo" src="/img/cityhall-photo.jpg" alt=""><h1 class="h1">${t('home_q')}</h1><p class="body">${t('home_sub')}</p></div>
      <div class="content home-content">
        <button class="searchfield raised" data-action="search"><span class="search-dot">${icon('search', 36)}</span><span class="q">${t('search_placeholder')}</span></button>
        <div class="choices">
          ${[['search', 'file-text', 'find_service'], ['offices', 'building', 'browse_offices'], ['map', 'map', 'map_hall']].map(([a, ic, k]) => `
          <button class="choice" data-action="${a}"><span class="tile">${icon(ic, 44)}</span><span class="choice-txt"><span class="h3">${t(k)}</span><span class="caption muted">${t(k + '_d')}</span></span></button>`).join('')}
        </div>
        <h2 class="h3">${t('popular')}</h2>
        <div class="list">${pop.map(s => rowHTML({ kind: 'service', id: s.id, title: s.display_title, subtitle: `${s.office_name} · ${locText(s.location)}` })).join('')}</div>
      </div>${helpbar()}</section>`;
  },

  search() {
    const q = S.query;
    const sug = S.lastSuggest;
    return `<section class="screen">${topbar()}
      <div class="content cols search-cols" style="gap:20px">
        <div class="col-main">
        ${backBtn()}
        <div class="searchfield active" role="textbox" aria-label="${t('search_placeholder')}" aria-live="polite">${icon('search', 40)}<span class="q">${esc(q)}<span class="caret"></span>${q ? '' : `<span class="muted"> ${t('search_placeholder')}</span>`}</span></div>
        <p class="caption muted">${q.trim() ? t('suggestions') : t('type_to_search')}</p>
        <div class="list" id="suggest">${sug.slice(0, 4).map(rowHTML).join('')}</div>
        </div>
        ${keyboard()}
      </div></section>`;
  },

  results() {
    const all = S.results || [];
    const list = S.filter === 'all' ? all : all.filter(r => r.kind === (S.filter === 'services' ? 'service' : 'office'));
    const nS = all.filter(r => r.kind === 'service').length, nO = all.length - nS;
    if (!all.length) return screens.noresults();
    return `<section class="screen">${topbar()}
      <div class="content">
        ${backBtn()}
        <h1 class="h2">${all.length === 1 ? t('result_for', { q: esc(S.query) }) : t('results_for', { n: all.length, q: esc(S.query) })}</h1>
        <div class="chips" role="group">
          ${[['all', `${t('all')} (${all.length})`], ['services', `${t('services')} (${nS})`], ['offices', `${t('offices')} (${nO})`]].map(([k, l]) => `<button class="chip" data-action="filter" data-f="${k}" aria-pressed="${S.filter === k}">${l}</button>`).join('')}
        </div>
        <div class="list">${list.map(rowHTML).join('')}</div>
        <div class="card" style="display:flex;gap:16px;align-items:center;background:var(--bg-subtle);border:0">${icon('message', 36)}<span class="caption muted">${t('not_what')}</span></div>
      </div>${helpbar()}</section>`;
  },

  noresults() {
    const pop = (S.bundle.popular_service_ids || []).slice(0, 3).map(id => idx.services.get(id)).filter(Boolean);
    return `<section class="screen">${topbar()}
      <div class="content">
        ${backBtn()}
        <div class="card center" style="display:flex;flex-direction:column;align-items:center;gap:20px;padding:56px 40px">
          <div class="circle-icon" style="background:var(--bg-subtle);color:var(--text-secondary)">${icon('search', 56)}</div>
          <h1 class="h2">${t('no_result_title', { q: esc(S.query) })}</h1>
          <p class="body muted">${t('no_result_body')}</p>
        </div>
        <div class="card" style="display:flex;gap:20px;align-items:center;background:var(--brand-sky);border:0;color:var(--brand-navy)">${icon('map-pin', 44)}<div><p class="label">${t('ask_desk')}</p><p class="caption">${t('ask_desk_where')}</p></div></div>
        <h2 class="h3">${t('people_look')}</h2>
        <div class="list">${pop.map(s => rowHTML({ kind: 'service', id: s.id, title: s.display_title, subtitle: `${s.office_name} · ${locText(s.location)}` })).join('')}</div>
      </div>${helpbar()}</section>`;
  },

  // "Find a service": every office, grouped by floor in walking order, each saying what it helps with. No typing.
  // Landscape shows the chosen office's services beside the list.
  offices() {
    const f = S.floorFilter, wide = LAYOUT === 'landscape';
    const all = officeGroups('all');
    const chips = [['all', t('all_floors')], ...all.filter(g => g.key !== 'unconfirmed' && g.key !== 'out').map(g => [g.key, g.label]), ...(all.some(g => g.key === 'out' || g.key === 'unconfirmed') ? [['out', t('not_in_building')]] : [])];
    const sel = wide ? idx.offices.get(S.browseSel) || null : null;
    const list = officeGroups(f).map(g => `<h2 class="h3 group-h">${esc(g.label)}</h2><div class="list">${g.items.map(o => officeRow(o, sel?.id === o.id)).join('')}</div>`).join('');
    return `<section class="screen">${topbar()}
      <div class="content${wide ? ' cols browse-cols' : ''}" style="gap:24px">
        <div class="col-main">
        ${backBtn()}
        <h1 class="h1">${t('offices_title')}</h1>
        <div class="chips" role="group">${chips.map(([k, l]) => `<button class="chip" data-action="floorfilter" data-f="${k}" aria-pressed="${f === k}">${esc(l)}</button>`).join('')}</div>
        ${list}
        </div>
        ${wide ? `<div class="col-side browse-panel" aria-live="polite">${officePanelHTML(sel)}</div>` : ''}
      </div>${helpbar()}</section>`;
  },

  office({ id }) {
    const o = idx.offices.get(Number(id));
    if (!o) return screens.home();
    return `<section class="screen civic-detail office-detail">${topbar()}
      <div class="page-head svc-head office-head">${backBtn()}<div class="head-txt"><h1 class="h1">${esc(o.name)}</h1>
        <p class="body head-loc">${icon(o.location?.room_id ? 'map-pin' : 'building', 28)}<span>${esc(officeWhere(o))}</span></p></div></div>
      <div class="content cols office-cols">
        <div class="col-main">${officeInfoHTML(o)}</div>
        <div class="col-side">${officeServicesHTML(o)}</div>
      </div>${helpbar()}</section>`;
  },

  service({ id }) {
    const s = idx.services.get(Number(id));
    if (!s) return screens.home();
    if (S.online) fetch(`/api/services/${s.id}`).catch(() => {}); // view counter
    const verified = s.verified_at ? `<span class="badge success">${icon('circle-check', 24)}${t('verified_on', { d: new Date(s.verified_at).toLocaleDateString([], { month: 'short', year: 'numeric' }) })}</span>` : '';
    const inBuilding = s.location?.room_id;
    const govBadge = s.is_citizen_facing ? '' : `<span class="badge neutral">${icon('building', 24)}${t('gov_services')}</span>`;
    return `<section class="screen civic-detail service-detail">${topbar()}
      <div class="page-head svc-head">${backBtn()}<div class="head-txt"><h1 class="h1">${esc(s.display_title)}</h1>
        <p class="body">${esc(s.office_name)} · ${esc(locText(s.location))}</p></div></div>
      <div class="content service-content">
        <div class="stats">
          ${[['wallet', 'total_fee', s.total_fees], ['clock', 'processing_time', s.total_processing_time], ['users', 'who_may_apply', s.who_may_avail]].map(([ic, k, v]) =>
            `<div class="stat"><span class="lbl">${icon(ic, 28)}${t(k)}</span><span class="val">${esc(v || '—')}</span></div>`).join('')}
        </div>
        <div class="service-grid">
          <div class="service-bring">        ${s.requirements.length ? `<section class="card bring-card"><h2 class="h2"><span class="section-number">1</span>${t('what_to_bring')} (${s.requirements.length})</h2>
          ${s.requirements.map(r => `<div class="req"><span class="box" aria-hidden="true"></span><div><p class="label">${esc(r.requirement)}</p>${r.where_to_secure ? `<p class="caption muted">${esc(r.where_to_secure)}</p>` : ''}</div></div>`).join('')}
        </section>` : ''}
        <div class="helpful"><span class="label">${t('did_help')}</span><div class="btns">
          <button data-action="fb" data-v="1" data-id="${s.id}">${icon('thumbs-up', 32)}<span>${t('yes')}</span></button>
          <button data-action="fb" data-v="0" data-id="${s.id}">${icon('thumbs-down', 32)}<span>${t('no')}</span></button></div></div>

          <div class="service-context">        <header style="display:flex;flex-direction:column;gap:16px">
          ${s.plain_title ? `<p class="caption muted">${esc(s.title)}</p>` : ''}
          ${s.description ? `<p class="body muted svc-desc">${esc(s.description)}</p>` : ''}
          <div class="badges">
            <button class="badge badge-link ${inBuilding ? 'info' : 'offsite'}" data-action="office" data-id="${s.office_id}">${icon(inBuilding ? 'map-pin' : 'building', 24)}${esc(s.office_name)} · ${esc(locText(s.location))}${icon('chevron-right', 24)}</button>
            ${govBadge}${s.classification ? `<span class="badge neutral">${esc(s.classification)}</span>` : ''}${verified}
          </div>
        </header>
</div>        <p class="caption muted">${s.verified_at ? '' : t('not_verified') + ' · '}${t('from_charter', { src: esc(s.source || "Citizen's Charter") })}</p>
</div>
          <div class="service-process">        ${s.steps.length ? `<section class="card steps-card"><h2 class="h2"><span class="section-number">2</span>${t('what_youll_do')}</h2>
          <div class="list">${s.steps.map((st, i) => `<div class="step"><span class="num">${i + 1}</span><div style="flex:1;display:flex;flex-direction:column;gap:8px">
            ${st.client_action ? `<p class="label">${esc(st.client_action)}</p>` : ''}
            ${st.agency.length ? `<div class="agency">${st.agency.map(a => `<div><p class="caption muted">${esc(a.agency_action)}</p>
              <p class="caption meta">${stepMeta(a)}</p></div>`).join('')}</div>` : ''}
          </div></div>`).join('')}</div></section>` : ''}
        ${s.notes ? `<section class="card notes"><h2 class="h3">${t('notes')}</h2>${notesHTML(s.notes)}</section>` : ''}
</div>
        </div>
      </div>
      <div class="dock"><div class="dock-destination"><p class="label">${esc(s.office_name)}</p><p class="caption muted">${esc(locText(s.location))}</p></div>
        <button class="btn btn-secondary" data-action="qr" data-id="${s.id}">${icon('qr', 36)}${t('take_it')}</button>
        <button class="btn btn-primary" data-action="navservice" data-id="${s.id}">${icon('navigation', 36)}${t('show_way')}</button>
      </div></section>`;
  },

  offsite({ id }) {
    const o = idx.offices.get(Number(id));
    return `<section class="screen">${topbar()}
      <div class="content" style="align-items:center;text-align:center">
        ${backBtn()}
        <div class="circle-icon" style="background:var(--brand-terracotta-tint);color:var(--brand-terracotta)">${icon('building', 64)}</div>
        <h1 class="h1">${t('offsite_title')}</h1>
        <p class="h3">${esc(o?.name || '')}</p>
        ${o?.offsite_address ? `<p class="body">${t('offsite_body', { addr: esc(o.offsite_address) })}</p>` : `<p class="body muted">${t('location_unconfirmed')}</p>`}
        ${o?.phone ? `<p class="label">${icon('phone', 32)} ${esc(o.phone)}</p>` : ''}
        <p class="caption muted">${esc(o?.hours || '')}</p>
      </div>${helpbar()}</section>`;
  },

  navigate() {
    const r = S.nav.route;
    const wide = LAYOUT === 'landscape';
    // In landscape the playback controls sit in the directions panel so they don't cover the route start.
    const controls = `<div class="controls">
          <button data-action="navpause" id="btn-pause">${icon('pause', 32)}<span>${t('pause')}</span></button>
          <button data-action="navreplay">${icon('replay', 32)}<span>${t('replay')}</span></button>
          <button data-action="navskip">${icon('skip', 32)}<span>${t('skip')}</span></button>
        </div>`;
    // the banner is about the ROUTE. An unverified building alignment (calibration) only matters for the 3D view:
    // verified routes then play on the 2D map, which uses canonical coordinates and stays correct.
    const draft = r.verification !== 'verified';
    return `<section class="screen">${topbar()}
      <div class="dest">${icon('map-pin', 44)}<div style="flex:1"><p class="h3">${t('navigating_to', { room: esc(S.nav.title) })}</p>
        <p class="caption">${t('walk_info', { room_code: r.to.room_code, floor: r.to.floor_name, d: r.distance_m, m: r.minutes })}</p></div></div>
      ${draft ? `<div class="banner warning draft-route" role="note">${icon('alert', 32)}<span>${t(isGraphRoute(r) ? 'draft_route' : 'prototype_route')}</span></div>` : ''}
      <div class="nav-body">
      <div class="viewport3d" id="vp">
        <div class="vp-loading" hidden role="status"><span class="label">${t('loading_building')}</span><div class="bar"><div></div></div></div>
        <div class="vp-tools">
          <button class="chip" data-action="stepfree" aria-pressed="${S.prefs.stepFree}">${icon('alert', 28)}<span>${t('avoid_stairs')}</span></button>
        </div>
        <div class="minimap" aria-label="Map">
          <span class="caption" id="mm-status" aria-live="polite"></span>
          <div id="mm"></div>
          <div class="floorpick">${(isGraphRoute(r) ? S.bundle.navigation.graph.floors || [] : S.bundle.floors)
            .map(f => `<button data-action="mmfloor" data-l="${f.level}" aria-pressed="false">${esc(f.name)}</button>`).join('')}</div>
          <button class="chip mm-follow" data-action="mmfollow" aria-pressed="${S.nav.mmFloor == null}">${icon('navigation', 24)}${t('follow_position')}</button>
        </div>
        ${wide ? '' : controls}
      </div>
      <div class="directions">
        <div class="progress"><div id="prog"></div></div>
        ${wide ? `<p class="h2" id="dircur" aria-live="polite">${esc(direction(r.directions[0]))}</p>` : ''}
        <div id="dirs">${r.directions.map((d, i) => `<div class="dir" data-i="${i}"><span class="n"><span class="n-num">${d.kind === 'floor_change' ? icon('stairs', 28) : i + 1}</span><span class="n-done">${icon('check', 28)}</span></span><span class="label" style="font-weight:inherit">${esc(direction(d))}</span></div>`).join('')}</div>
        ${wide ? controls : ''}
        <div class="btn-row"><button class="btn btn-secondary" data-action="toggle2d">${icon('map', 32)}<span id="t2d">${t(S.nav.mode === '2d' ? 'view_3d' : 'view_2d')}</span></button><button class="btn btn-secondary" data-action="endnav">${t('end_nav')}</button></div>
      </div></div></section>`;
  },

  // A valid request that cannot be routed: say why, show where the office is, draw no line.
  noroute() {
    const n = S.nav, r = n.route;
    const office = n.officeId ? idx.offices.get(Number(n.officeId)) : null;
    const reasonKey = `route_${String(r.reason || 'DISCONNECTED').toLowerCase()}`;
    return `<section class="screen">${topbar()}
      <div class="content centered" style="align-items:center;text-align:center">
        ${backBtn()}
        <div class="circle-icon" style="background:var(--status-warning-tint);color:var(--status-warning)">${icon('alert', 64)}</div>
        <h1 class="h1">${t('route_unavailable')}</h1>
        <p class="body">${t(reasonKey) || esc(r.message || '')}</p>
        ${office?.location ? `<p class="label">${esc(office.name)} · ${esc(locText(office.location))}</p>` : ''}
        <p class="body muted">${t('ask_info_desk')}</p>
        ${r.reason === 'NO_STEP_FREE_ROUTE' ? `<p class="caption muted">${t('step_free_note')}</p>` : ''}
        <div style="display:flex;flex-direction:column;gap:16px;width:100%;max-width:720px">
          ${S.prefs.stepFree ? `<button class="btn btn-secondary btn-block" data-action="stepfree">${t('allow_stairs')}</button>` : ''}
          ${n.serviceId ? `<button class="btn btn-secondary btn-block" data-action="service" data-id="${n.serviceId}">${t('see_requirements')}</button>` : ''}
          <button class="btn btn-primary btn-block" data-action="home">${t('back_home')}</button>
        </div>
      </div>${helpbar()}</section>`;
  },

  arrived() {
    const n = S.nav;
    const room = idx.rooms.get(n.route.to.room_id);
    const office = n.officeId ? idx.offices.get(n.officeId) : null;
    return `<section class="screen">${topbar()}
      <div class="content cols arrived-cols" style="align-items:center;text-align:center">
        <div class="col-main"><div class="card" style="width:100%;padding:0;overflow:hidden">${doorIllustration(n.route.to.room_code, office?.name || room?.name || '')}</div></div>
        <div class="col-side">
        <div class="circle-icon" style="background:var(--brand-grass-tint);color:var(--status-success)">${icon('circle-check', 64)}</div>
        <h1 class="h1">${t('arrived')}</h1>
        <p class="body muted">${t('arrived_body', { office: esc(office?.name || room?.name || ''), room_code: n.route.to.room_code, floor: n.route.to.floor_name })}</p>
        ${office ? `<span class="badge info" style="padding:16px 28px">${icon('clock', 32)}${esc(office.hours || '')}</span>` : ''}
        <div style="display:flex;flex-direction:column;gap:16px;width:100%">
          ${n.serviceId ? `<button class="btn btn-primary btn-block" data-action="service" data-id="${n.serviceId}">${t('see_requirements')}</button>` : ''}
          <button class="btn btn-secondary btn-block" data-action="home">${t('back_home')}</button>
        </div>
        </div>
      </div>${helpbar()}</section>`;
  },

  map() {
    const floors = S.bundle.navigation?.graph?.floors || S.bundle.floors;
    const lvl = S.mapFloor = floors.some(f => f.level === S.mapFloor) ? S.mapFloor : floors[0].level;
    const fl = S.bundle.floors.find(f => f.level === lvl);
    const real = !!S.bundle.navigation?.graph, can3d = real && calibrationOK();
    const mapped = new Map((real ? mapOffices(null) : []).map(m => [m.office.id, m]));
    return `<section class="screen">${topbar()}
      <div class="content cols map-cols">
        <div class="col-main">
        ${backBtn()}
        <h1 class="h1">${t('map_hall')}</h1>
        <div class="chips">${floors.map(f => `<button class="chip" data-action="mapfloor" data-l="${f.level}" aria-pressed="${f.level === lvl}">${esc(f.name)}</button>`).join('')}
        ${can3d ? `<button class="chip" data-action="mapmode">${t(S.mapMode === '3d' ? 'view_2d' : 'view_3d')}</button>` : ''}</div>
        <div class="floor-viewport" id="floor-vp">
          <div class="floor-fallback">${real ? mapPlan(lvl) : floorSVG(fl, { interactive: true, you: S.bundle.kiosk.floor_level === lvl ? S.bundle.kiosk : null })}</div>
          ${can3d && S.mapMode === '3d' ? `<div class="vp-loading" role="status"><span class="label">${t('loading_building')}</span><div class="bar"><div></div></div></div>` : ''}
        </div>
        ${can3d ? `<div class="map-controls" hidden><button class="chip" data-action="mapzoom" data-f="1.35">${t('zoom_in')}</button><button class="chip" data-action="mapzoom" data-f="0.74">${t('zoom_out')}</button><button class="chip" data-action="maprotate">${t('rotate_map')}</button><button class="chip" data-action="mapreset">${t('reset_view')}</button></div><p class="caption muted map-hint" hidden>${t('map_gestures')}</p>` : ''}
        </div>
        <div class="col-side">${real ? `<p class="caption muted">${t('tap_office_map')}</p>` : ''}<div class="list">${S.bundle.offices.filter(o => o.location?.floor_level === lvl && o.location?.room_id)
          .map(o => { const m = real ? mapped.get(o.id) : null;
            // the database room codes are placeholders until a door is mapped: show the mapped door's room, else say so
            return rowHTML({ kind: 'office', id: o.id, title: o.name, subtitle: !real ? o.location.room_code : m ? `${o.location.room_code} · ${t(m.draft ? 'draft' : 'on_map')}` : t('not_on_map_yet') }); }).join('')}</div>
        ${graphPreview() ? `<h2 class="h3">${t('pilot_doorways')}</h2><p class="caption muted">${t('pilot_doorways_note')}</p>
          <div class="list">${S.bundle.navigation.graph.openings.filter(o => o.approachNodeId && o.status !== 'verified').map(o =>
            `<button class="row" data-action="navopening" data-o="${esc(o.openingId)}" data-t="${esc(o.label || o.openingId)}"><span class="tile">${icon('navigation', 32)}</span><span class="txt"><span class="title">${esc(o.label || o.openingId)}</span><span class="sub">${esc(o.openingId)} · ${t('draft')}</span></span>${icon('chevron-right', 32)}</button>`).join('')}</div>` : ''}
        </div>
      </div>${helpbar()}</section>`;
  },
};

// "Fee: … · time · person". A charter cell can list one value per line for several sub-actions
// ("PHP100.00 / None" beside "15 Minutes / 5 Minutes"); those are paired line by line.
function stepMeta(a) {
  const fees = String(a.fee || '').split('\n').filter(Boolean), times = String(a.processing_time || '').split('\n').filter(Boolean);
  const feeLabel = t('total_fee').split(' ').pop();
  const lines = fees.length > 1 && fees.length === times.length
    ? fees.map((f, i) => `${feeLabel}: ${f} · ${times[i]}`)
    : [[fees.length && `${feeLabel}: ${fees.join(', ')}`, times.join(', ')].filter(Boolean).join(' · ')];
  if (a.person_in_charge) lines[lines.length - 1] = [lines[lines.length - 1], a.person_in_charge].filter(Boolean).join(' · ');
  return lines.map(esc).join('<br>');
}

// Charter notes: plain lines become paragraphs; runs of "a | b | c" lines (fee schedules) become a table.
function notesHTML(notes) {
  const out = []; let rows = [];
  const flush = () => { if (rows.length) out.push(`<div class="note-table"><table>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`); rows = []; };
  for (const line of String(notes).split('\n')) {
    if (line.includes(' | ')) rows.push(line.split(' | '));
    else { flush(); out.push(`<p class="caption">${esc(line)}</p>`); }
  }
  flush();
  return out.join('');
}

function doorIllustration(code, name) {
  // 16:9, the frame a real door photo will use later
  return `<svg viewBox="0 0 1000 562" width="100%" style="display:block" role="img" aria-label="${esc(code)}"><rect width="1000" height="562" fill="#F4F1EA"/><g transform="translate(0 142)"><rect y="330" width="1000" height="90" fill="#C98F6C"/>
  <rect x="380" y="70" width="240" height="260" fill="#23415F"/><rect x="396" y="86" width="208" height="244" fill="#2E5578"/><circle cx="584" cy="210" r="9" fill="#D9A520"/>
  <rect x="340" y="18" width="320" height="44" rx="8" fill="#12355B"/><text x="500" y="48" fill="#fff" font-size="24" font-weight="700" text-anchor="middle" font-family="sans-serif">${esc(code)}</text>
  <rect x="140" y="110" width="140" height="160" fill="#DCE9F5"/><rect x="720" y="110" width="140" height="160" fill="#DCE9F5"/>
  <text x="500" y="395" fill="#1B2430" font-size="22" text-anchor="middle" font-family="sans-serif">${esc(name.length > 60 ? name.slice(0, 57) + '…' : name)}</text></g></svg>`;
}

// 2D floor plan (top-down X/Z). Used on the map screen, minimap and phone page.
export function floorSVG(fl, { interactive = false, route = null, you = null, target = null, small = false } = {}) {
  const W = 1000, minX = fl.bounds_min_x, maxX = fl.bounds_max_x, minZ = fl.bounds_min_z, maxZ = fl.bounds_max_z;
  const sc = W / (maxX - minX), H = Math.round((maxZ - minZ) * sc);
  const X = x => (x - minX) * sc, Y = z => H - (z - minZ) * sc; // north (+Z) up
  const color = r => r.room_type === 'stairs' || r.room_type === 'elevator' ? '#C9E0F8' : r.room_type === 'toilet' ? '#E6F2E7' : r.room_type === 'hall' || r.room_type === 'entrance' ? '#F3EFE8' : r.room_type === 'info_desk' ? '#FFF4E0' : '#FFFFFF';
  const rooms = fl.rooms.map(r => {
    const isT = target && r.id === target;
    return `<g class="room" ${interactive ? `data-action="maproom" data-id="${r.id}"` : ''}>
      <rect x="${X(r.x - r.width_m / 2)}" y="${Y(r.z + r.depth_m / 2)}" width="${r.width_m * sc}" height="${r.depth_m * sc}" rx="4" fill="${isT ? '#FBE9E5' : color(r)}" stroke="${isT ? '#B8432F' : '#C7BFB2'}" stroke-width="${isT ? 6 : 2}"/>
      ${small ? '' : `<text x="${X(r.x)}" y="${Y(r.z) + 6}" font-size="${r.width_m > 9 ? 17 : 14}" text-anchor="middle" fill="#1B2430" font-family="sans-serif" font-weight="600">${esc(r.code.replace(/^\dF-/, ''))}</text>`}
    </g>`;
  }).join('');
  let path = '';
  if (route) {
    const seg = route.waypoints.filter(p => p.floor === fl.level);
    if (seg.length > 1) path = `<polyline points="${seg.map(p => `${X(p.x)},${Y(p.z)}`).join(' ')}" fill="none" stroke="#1A63BE" stroke-width="${small ? 10 : 8}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  const youMark = you ? `<circle cx="${X(you.x)}" cy="${Y(you.z)}" r="${small ? 14 : 12}" fill="#12355B" stroke="#fff" stroke-width="4"/>${small ? '' : `<text x="${X(you.x)}" y="${Y(you.z) + 34}" font-size="16" text-anchor="middle" fill="#12355B" font-weight="700" font-family="sans-serif">${esc(t('you_are_here'))}</text>`}` : '';
  return `<svg class="mapsvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(fl.name)}" data-minx="${minX}" data-minz="${minZ}" data-sc="${sc}" data-h="${H}">
    <rect x="${X(-56)}" y="${Y(28)}" width="${112 * sc}" height="${24 * sc}" fill="#FBF8F3"/>
    <rect x="${X(-56)}" y="${Y(17.5)}" width="${112 * sc}" height="${3 * sc}" fill="#EDE7DC"/>
    ${rooms}${path}${youMark}<circle id="walker2d" cx="-50" cy="-50" r="${small ? 16 : 12}" fill="#B8432F" stroke="#fff" stroke-width="4"/></svg>`;
}

function keyboard() {
  const rows = S.kbMode === 'abc' ? ['QWERTYUIOP', 'ASDFGHJKLÑ', 'ZXCVBNM-'] : ['1234567890', '.,/()&\'#', ''];
  return `<div class="keyboard" role="group" aria-label="Keyboard">
    ${rows.filter(Boolean).map(r => `<div class="kb-row">${[...r].map(ch => `<button class="key" data-action="key" data-k="${esc(ch)}">${esc(ch)}</button>`).join('')}</div>`).join('')}
    <div class="kb-row">
      <button class="key wide" data-action="kbmode">${S.kbMode === 'abc' ? t('kb_123') : t('kb_abc')}</button>
      <button class="key wide" data-action="kbclear">${t('kb_clear')}</button>
      <button class="key space" data-action="key" data-k=" ">${t('kb_space')}</button>
      <button class="key wide" data-action="kbdel">${icon('backspace', 32)}<span>${t('kb_delete')}</span></button>
      <button class="key wide primary" data-action="kbsearch">${icon('search', 32)}&nbsp;${t('kb_search')}</button>
    </div></div>`;
}

// ---------------------------------------------------------------- welcome clock & office hours
// Office hours: Monday–Friday 8:00 AM – 5:00 PM by default. Override with settings
// office_open / office_close ("HH:MM"). Holidays are not known to the kiosk yet.
function hm(str, def) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : def; }
function fmtHM(mins) { const d = new Date(2000, 0, 1, Math.floor(mins / 60), mins % 60); return d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }); }
function openStatus(now) {
  const open = hm(S.bundle?.settings?.office_open, 8 * 60), close = hm(S.bundle?.settings?.office_close, 17 * 60);
  const day = now.getDay(), mins = now.getHours() * 60 + now.getMinutes(), weekday = day >= 1 && day <= 5;
  if (weekday && mins >= open && mins < close) return { open: true, text: t('open_now', { t: fmtHM(close) }) };
  if (weekday && mins < open) return { open: false, text: t('opens_today', { t: fmtHM(open) }) };
  if (day >= 1 && day <= 4) return { open: false, text: t('opens_tomorrow', { t: fmtHM(open) }) };
  return { open: false, text: t('opens_monday', { t: fmtHM(open) }) };
}
function tickClock() {
  const els = stage.querySelectorAll('[data-clock]'); if (!els.length) return;
  const now = new Date(), loc = getLang() === 'fil' ? 'fil-PH' : 'en-PH';
  els.forEach(el => { el.textContent = el.dataset.clock === 'time'
    ? now.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
    : now.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long' }); });
  const st = openStatus(now);
  stage.querySelectorAll('.wp-open').forEach(el => { el.classList.toggle('is-open', st.open); el.classList.toggle('is-closed', !st.open); el.querySelector('.wp-open-txt').textContent = st.text; });
}
setInterval(tickClock, 15000);

// ---------------------------------------------------------------- router
function current() { return S.stack[S.stack.length - 1]?.name || 'welcome'; }
const SCROLLERS = '.content, .col-main, .col-side';
function go(name, p = {}, { replace = false, restore = null } = {}) {
  if (name !== 'navigate') stopNav();
  if (replace) S.stack.pop();
  else { const cur = S.stack[S.stack.length - 1]; if (cur) cur.scroll = [...stage.querySelectorAll(SCROLLERS)].map(el => el.scrollTop); }
  S.stack.push({ name, p });
  rerender();
  if (restore) stage.querySelectorAll(SCROLLERS).forEach((el, i) => { if (restore[i]) el.scrollTop = restore[i]; });
}
function back() {
  if (S.stack.length > 1) { S.stack.pop(); const top = S.stack[S.stack.length - 1]; S.stack.pop(); go(top.name, top.p, { restore: top.scroll }); }
  else go('home');
}
function rerender() {
  stopMap();
  const { name, p } = S.stack[S.stack.length - 1] || { name: 'welcome', p: {} };
  if (name !== 'navigate') stopNav();
  const overlays = [...stage.querySelectorAll('.overlay')];
  stage.innerHTML = (screens[name] || screens.home)(p);
  overlays.forEach(o => stage.appendChild(o));
  if (name === 'navigate') startNav();
  if (name === 'map') startMap();
  if (name === 'welcome') tickClock();
  if (name === 'search') { /* suggestions update in place */ }
  const content = stage.querySelector('.content'); if (content) content.scrollTop = 0;
  updateScrollFades();
}
// Landscape: fade the bottom edge of any area that has more content below, so it reads as scrollable.
function updateScrollFades() {
  if (LAYOUT !== 'landscape') return;
  stage.querySelectorAll('.content, .col-main, .col-side').forEach(el => {
    el.classList.toggle('more', el.scrollHeight - el.clientHeight - el.scrollTop > 8);
  });
}
stage.addEventListener('scroll', updateScrollFades, { capture: true, passive: true });
function resetToWelcome() {
  S.stack = []; S.query = ''; S.results = null; S.filter = 'all'; S.floorFilter = 'all'; S.lastSuggest = []; S.browseSel = null;
  stage.classList.remove('large'); setLang(safeLS.get(LS.lang) || 'en');
  stage.querySelectorAll('.overlay').forEach(o => o.remove());
  go('welcome');
}

// The floor browser and the route player borrow the same model and renderer.
function mapOrigin(level) {
  const graph = S.bundle.navigation?.graph;
  const point = graph?.nodes.find(n => n.id === graph.kiosks?.[KIOSK]);
  return point?.floor === level ? point : null;
}
/** Offices whose door is mapped in the published graph (verified; drafts only in staff preview), on one floor or all. */
function mapOffices(level) {
  const graph = S.bundle.navigation?.graph; if (!graph) return [];
  const out = [];
  for (const office of S.bundle.offices) {
    const door = doorForRoom(graph, office.location?.room_id, { preview: graphPreview() });
    const node = door && graph.nodes.find(n => n.id === door.approachNodeId);
    if (!door?.doorPoint || !node || (level != null && node.floor !== level)) continue;
    out.push({ office, door, x: door.doorPoint.x, y: node.y, z: door.doorPoint.z, floor: node.floor, draft: door.status !== 'verified' });
  }
  return out;
}
const officeTag = o => o.short_name || o.name;
// Plans and the 3D floor map are drawn with the published calibration: use them only for that calibration, and while it
// is unverified only in a labelled staff preview (the same rule as the 3D route view and the phone page).
function calibrationOK() { const c = S.bundle.navigation?.calibration; return !!c && (c.status === 'verified' || graphPreview()); }
function usablePlan(level) {
  return S.plans && calibrationOK() && S.plans.calibrationVersion === S.bundle.navigation.calibration.calibrationVersion ? planFor(S.plans, level) : null;
}
function mapPlan(level) {
  const graph = S.bundle.navigation.graph;
  const points = mapOffices(level).map(m => ({ x: m.x, z: m.z, label: officeTag(m.office), color: m.draft ? '#9A6B00' : '#1A63BE', action: 'navoffice', id: m.office.id }));
  return floorPlanSVG({ graph, level, plan: usablePlan(level), you: mapOrigin(level), labels: { you: t('route_start') }, points });
}
function stopMap() {
  S.mapGen++;
  S.mapAbort?.abort(); S.mapAbort = null;
  S.mapCtrl?.dispose(); S.mapCtrl = null;
  S.mapDetach?.(); S.mapDetach = null;
}
async function startMap() {
  const nav = S.bundle.navigation;
  if (S.mapMode !== '3d' || !nav?.model || !nav.graph || !calibrationOK()) return;
  const gen = S.mapGen, ac = S.mapAbort = new AbortController(), level = S.mapFloor;
  const live = () => gen === S.mapGen && current() === 'map';
  const vp = $('#floor-vp'), loading = vp?.querySelector('.vp-loading');
  let off;
  try {
    const { getViewer } = await import('./three/building-viewer.js');
    if (!live()) return;
    const v = getViewer();
    await v.ensureModel(nav, { signal: ac.signal, allowDraftCalibration: graphPreview(),
      onLoadProgress: e => { if (live() && loading) loading.querySelector('.bar > div').style.width = `${Math.round(e.fraction * 100)}%`; } });
    if (!live()) return;
    v.attach(vp); v.updateContent(S.bundle); S.buildingUsed = true;
    const floor = S.plans?.levels.find(f => f.level === level);
    const nodes = nav.graph.nodes.filter(n => n.floor === level);
    const elevation = floor?.elevation ?? Math.min(...nodes.map(n => n.y));
    S.mapCtrl = v.showFloor({ level, elevation: Number.isFinite(elevation) ? elevation : 0,
      bounds: S.plans?.bounds || floorBounds(nav.graph, level), you: mapOrigin(level), youLabel: t('route_start'),
      offices: mapOffices(level).map(m => ({ id: m.office.id, x: m.x, y: m.y, z: m.z, title: officeTag(m.office), subtitle: m.office.short_name ? m.office.name : '', draft: m.draft })) });
    S.mapDetach = () => { off?.(); v.detach(); };
    vp.classList.add('has-building');
    $('.map-controls').hidden = false; $('.map-hint').hidden = false;
    off = v.on(e => { if (e.type === 'contextlost' && live()) { S.mapMode = '2d'; rerender(); toast(t('map_2d_fallback')); } });
  } catch (e) {
    if (e.name !== 'AbortError' && live()) {
      stopMap(); S.mapMode = '2d'; rerender(); toast(t('map_2d_fallback'));
    }
  } finally { if (live() && loading) loading.hidden = true; }
}

// ---------------------------------------------------------------- navigation (route + 3D)
// One planner per mode, the same one the server uses:
//   published navigation graph  -> shared/nav-graph.js (verified segments only, unless a labelled staff preview)
//   nothing published yet       -> shared/route-core.js prototype corridors (placeholder coordinates, greybox only)
const graphPreview = () => PREVIEW && !!S.bundle.navigation?.previewUnverified;
function planLocal(target) {
  const preference = S.prefs.stepFree ? 'step_free' : 'any';
  const nav = S.bundle.navigation;
  const contentVersion = S.bundle.content_version;
  if (nav?.graph) {
    const allow = graphPreview();
    const office = target.officeId ? idx.offices.get(Number(target.officeId)) : null;
    const t2 = target.openingId ? { openingId: target.openingId }
      : office ? { roomId: office.location?.room_id ?? null, locationType: office.location_type === 'offsite' ? 'offsite' : office.location?.room_id ? 'in_building' : 'unconfirmed', officeName: office.name }
      : { roomId: target.roomId, locationType: 'in_building' };
    const meta = { routeSource: 'navigation_graph', preview: allow, originKioskCode: KIOSK, routePreference: preference,
      modelVersion: nav.publication.modelVersion, navigationVersion: nav.publication.navigationVersion, contentVersion };
    const d = resolveDestination(nav.graph, t2, { preview: allow });
    if (!d.destination) return { status: 'no_route', ...meta, reason: d.reason, message: d.message };
    // a doorway picked directly (staff pilot list) is named after the office now in its room, if any
    if (target.openingId && d.destination.roomId != null) {
      const occupant = S.bundle.offices.find(o => o.location?.room_id === d.destination.roomId);
      if (occupant) d.destination.name = occupant.name;
    }
    const r = planGraphRoute({ graph: nav.graph, kioskCode: KIOSK, destination: d.destination, preference, allowUnverified: allow,
      versions: { modelVersion: nav.publication.modelVersion, contentVersion } });
    return { ...r, ...meta, destinationMapping: d.destination.mapping, calibrationStatus: nav.calibration?.status ?? null };
  }
  if (target.openingId) return { status: 'no_route', reason: 'NO_GRAPH', routeSource: 'prototype_placeholder' };
  const roomId = target.roomId ?? idx.offices.get(Number(target.officeId))?.location?.room_id;
  const room = idx.rooms.get(roomId);
  if (!room) return { status: 'no_route', reason: 'UNVERIFIED_DESTINATION', routeSource: 'prototype_placeholder' };
  const rooms = S.bundle.floors.flatMap(f => f.rooms.map(r => ({ ...r, floor_level: f.level })));
  const r = planRouteCore({ kiosk: S.bundle.kiosk, room, floors: S.bundle.floors, rooms, accessible: preference === 'step_free', corridorZ: Number(S.bundle.settings.corridor_z || 16) });
  return { routeSource: 'prototype_placeholder', ...r };
}
/** target: { officeId } | { roomId } | { openingId } — navigation follows the office identity, not a room snapshot */
function routeTo(target, title, { serviceId = null } = {}) {
  const route = planLocal(target);
  S.nav = { route, target, title, serviceId, officeId: target.officeId ?? null, ctrl: null, mode: '3d', step: 0 };
  if (S.online) {
    const q = target.openingId ? `opening_id=${encodeURIComponent(target.openingId)}` : target.officeId ? `office_id=${target.officeId}` : `room_id=${target.roomId}`;
    fetch(`/api/route?${q}&kiosk=${encodeURIComponent(KIOSK)}${S.prefs.stepFree ? '&preference=step_free' : ''}${graphPreview() ? '&preview=1' : ''}`).catch(() => {}); // usage log
  }
  go(route.status === 'ok' ? 'navigate' : 'noroute');
}
function navigateToOffice(officeId, serviceId = null) {
  const o = idx.offices.get(Number(officeId));
  if (!o?.location?.room_id) return go('offsite', { id: officeId });
  routeTo({ officeId: o.id }, o.name, { serviceId });
}
/** Published content changed while a route is shown: re-resolve the office's CURRENT room and refresh labels. */
function navContentChanged() {
  const n = S.nav;
  const fresh = planLocal(n.target);
  const key = r => r.status === 'ok' ? `${r.to?.node ?? ''}|${r.to?.room_id ?? ''}|${r.to?.room_code ?? ''}|${r.navigationVersion ?? ''}` : `x|${r.reason}`;
  if (key(fresh) !== key(n.route)) {
    n.route = fresh;
    stopNav();
    toast(t('office_moved'));
    go(fresh.status === 'ok' ? 'navigate' : 'noroute', {}, { replace: true });
  } else {
    n.ctrl?.updateContent?.(S.bundle);
  }
}
function stopNav() {
  S.navGen++;
  S.navAbort?.abort(); S.navAbort = null;
  clearTimeout(S.nav?.arrivalTimer);
  if (S.nav?.ctrl) { S.nav.ctrl.dispose(); S.nav.ctrl = null; }
}
async function startNav() {
  stopNav();
  const gen = S.navGen, ac = S.navAbort = new AbortController();
  const live = () => gen === S.navGen && current() === 'navigate';
  const vp = $('#vp');
  updateMinimap(S.nav.route.waypoints[0]);
  const onProgress = (frac, pos, legIndex) => {
    if (!live()) return;
    S.nav.position = pos;
    // Playback counts as active use; long upstairs walks must not hit the idle reset.
    if (frac !== S.nav.progress) {
      S.nav.progress = frac;
      if (!S.nav.lastActivity || performance.now() - S.nav.lastActivity > 1000) { S.nav.lastActivity = performance.now(); armIdle(); }
    }
    const bar = $('#prog'); if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
    updateMinimap(pos);
    stage.querySelectorAll('.dir').forEach((el, i) => { el.classList.toggle('on', i === legIndex); el.classList.toggle('done', i < legIndex); });
    const cur = $('#dircur'), d = S.nav.route.directions[legIndex];
    if (cur && d && cur.dataset.i !== String(legIndex)) { cur.textContent = direction(d); cur.dataset.i = String(legIndex); }
  };
  const onArrive = () => { S.nav.arrivalTimer = setTimeout(() => { if (live()) go('arrived', {}, { replace: true }); }, 1400); };
  if (S.nav.mode === '2d') { animate2D(onProgress, onArrive); return; }
  const loading = vp?.querySelector('.vp-loading');
  if (loading && isGraphRoute(S.nav.route)) loading.hidden = false; // visible at once; hidden again when the route plays
  try {
    const { createNav3D } = await import('./nav3d.js');
    if (!live()) return;
    const fallback = err => {
      if (!live()) return;
      console.warn('3D stopped, continuing on the 2D map', err);
      S.nav.ctrl?.dispose(); S.nav.ctrl = null;
      S.nav.mode = '2d'; S.nav.fallback = err?.code || 'ERROR';
      toast(t('map_2d_fallback'));
      animate2D(onProgress, onArrive);
    };
    const ctrl = await createNav3D(vp, S.bundle, S.nav.route, {
      signal: ac.signal, onProgress, onArrive, onFallback: fallback,
      onLoadProgress: ev => { if (!live() || !loading) return; loading.hidden = false; const b = loading.querySelector('.bar > div'); if (b) b.style.width = `${Math.round(ev.fraction * 100)}%`; },
    });
    if (!live()) { ctrl.dispose(); return; } // the visitor left while the building loaded: never attach to an old screen
    S.nav.ctrl = ctrl;
    if (ctrl.kind === 'building') S.buildingUsed = true;
    if (loading) loading.hidden = true;
  } catch (e) {
    if (e?.name === 'AbortError' || !live()) return;
    console.warn('3D unavailable, using 2D map', e);
    if (loading) loading.hidden = true;
    S.nav.mode = '2d'; S.nav.fallback = e?.code || 'ERROR';
    toast(t('map_2d_fallback'));
    animate2D(onProgress, onArrive);
  }
}
const isGraphRoute = r => r?.routeSource === 'navigation_graph';
function mapSVG(level, { small = false } = {}) {
  const r = S.nav.route;
  if (isGraphRoute(r)) return routeFloorSVG({ graph: S.bundle.navigation.graph, route: r, level, small, plan: usablePlan(level), labels: { you: t('route_start') } });
  const fl = S.bundle.floors.find(f => f.level === level) || S.bundle.floors[0];
  return floorSVG(fl, { route: r, you: S.bundle.kiosk.floor_level === fl.level ? S.bundle.kiosk : null, target: r.to.room_id, small });
}
function updateMinimap(pos) {
  const mm = $('#mm'); if (!mm || !pos) return;
  const level = S.nav.mmFloor ?? pos.floor;
  if (mm.dataset.floor !== String(level)) {
    mm.innerHTML = mapSVG(level, { small: true });
    mm.dataset.floor = String(level);
    stage.querySelectorAll('[data-action="mmfloor"]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.l) === level)));
  }
  placeWalker(mm.querySelector('svg'), pos.floor === level ? pos : null);
  followWalker(mm.querySelector('svg'), S.nav.mmFloor == null && pos.floor === level ? pos : null);
  const status = $('#mm-status');
  const text = `${floorName(level)} · ${t(S.nav.mmFloor == null ? 'following_position' : 'floor_overview')}`;
  if (status && status.textContent !== text) status.textContent = text;
  $('.mm-follow')?.setAttribute('aria-pressed', String(S.nav.mmFloor == null));
}
// 2D fallback animation (no WebGL, failed 3D load, or the visitor chose 2D). Same canonical waypoints as 3D.
function animate2D(onProgress, onArrive) {
  const vp = $('#vp'); if (!vp) return;
  const walk = buildWalk(S.nav.route.waypoints, S.nav.route.to?.door);
  let holder = vp.querySelector('.big2d');
  if (!holder) { holder = document.createElement('div'); holder.className = 'big2d'; vp.prepend(holder); }
  let elapsed = 0, last = null, raf = 0, lastFloor = null, arrived = false, disposed = false;
  const schedule = () => { if (!raf && !disposed) raf = requestAnimationFrame(tick); };
  const ctrl = { kind: '2d', paused: false,
    dispose() { disposed = true; cancelAnimationFrame(raf); holder.remove(); },
    pause() { this.paused = !this.paused; last = null; if (!this.paused) schedule(); return this.paused; },
    replay() { elapsed = 0; arrived = false; last = null; this.paused = false; schedule(); },
    skip() { elapsed = walk.duration; schedule(); } };
  S.nav.ctrl = ctrl;
  const loading = vp.querySelector('.vp-loading'); if (loading) loading.hidden = true;
  const toggle = $('#t2d'); if (toggle) toggle.textContent = t('view_3d');
  const tick = now => {
    raf = 0; if (disposed) return;
    const dt = last === null ? 0 : Math.min(.1, (now - last) / 1000); last = now;
    if (!ctrl.paused) elapsed = Math.min(walk.duration, elapsed + dt);
    const cur = walk.sample(elapsed);
    if (lastFloor !== cur.floor) { holder.innerHTML = mapSVG(cur.floor); lastFloor = cur.floor; }
    placeWalker(holder.querySelector('svg'), cur);
    onProgress(elapsed / walk.duration, cur, activeDirection(S.nav.route.directions, cur));
    if (!arrived && elapsed >= walk.duration) { arrived = true; onArrive(); }
    if (!ctrl.paused && !arrived) schedule();
  };
  schedule();
}

// ---------------------------------------------------------------- overlays
function overlay(html, { bottom = false, onClose } = {}) {
  stage.querySelectorAll('.overlay').forEach(o => o.remove());
  const el = document.createElement('div');
  el.className = `overlay${bottom ? ' bottom' : ''}`;
  el.innerHTML = html;
  el.addEventListener('click', e => { if (e.target === el) { el.remove(); onClose?.(); } });
  stage.appendChild(el);
  el.querySelector('button')?.focus();
  return el;
}
function showQR(id) {
  const s = idx.services.get(Number(id));
  // the phone re-plans from THIS kiosk with the same preference, and can tell if the office moved since
  const qs = new URLSearchParams({ k: KIOSK, r: String(s.location?.room_id ?? ''), cv: String(S.bundle.content_version) });
  if (S.prefs.stepFree) qs.set('p', 'sf');
  if (S.bundle.navigation) qs.set('nv', S.bundle.navigation.publication.navigationVersion);
  const url = `${S.publicBase}/m/service/${id}?${qs}`;
  overlay(`<div class="sheet" role="dialog" aria-modal="true" aria-label="${t('qr_title')}">
    <h2 class="h2 center">${t('qr_title')}</h2><p class="body muted center">${t('qr_body')}</p>
    ${S.online ? `<img class="qr" src="/api/qr.svg?data=${encodeURIComponent(url)}" alt="QR code for ${esc(s.display_title)}">` : `<div class="card center">${icon('wifi-off', 48)}<p class="body">${t('offline_banner', { t: fmtTime(S.savedAt) })}</p></div>`}
    <p class="label center" style="color:var(--brand-navy)">${esc(s.display_title)} · ${s.requirements.length} · ${s.steps.length}</p>
    <div class="btn-row" style="width:100%"><button class="btn btn-secondary" data-action="print" data-id="${id}">${icon('printer', 32)}${t('print_slip')}</button><button class="btn btn-primary" data-action="closeov">${t('done')}</button></div>
    <button class="btn btn-secondary btn-block" data-action="closeov">${icon('x', 32)}${t('close')}</button></div>`);
}
function printSlip(id) {
  const s = idx.services.get(Number(id));
  let slip = document.getElementById('print-slip');
  if (!slip) { slip = document.createElement('div'); slip.id = 'print-slip'; document.body.appendChild(slip); }
  // directions from this kiosk, labelled with origin, destination, preference and the data they came from
  const r = s.location?.room_id ? planLocal({ officeId: s.office_id }) : null;
  const way = !r ? '' : r.status !== 'ok' ? `<b>${esc(t('route_unavailable'))}</b><br>${esc(t(`route_${String(r.reason).toLowerCase()}`))}<hr>`
    : `<b>${esc(t('slip_directions', { kiosk: S.bundle.kiosk.name || KIOSK }))}</b>${S.prefs.stepFree ? ` (${esc(t('avoid_stairs'))})` : ''}<br>
       ${r.directions.map((d, i) => `${i + 1}. ${esc(direction(d))}`).join('<br>')}<br>
       ${r.verification !== 'verified' ? `<i>${esc(t(isGraphRoute(r) ? 'draft_route' : 'prototype_route'))}</i><br>` : ''}<hr>`;
  slip.innerHTML = `<b>${esc(t('kiosk_name'))}</b><hr><b>${esc(s.display_title)}</b><br>${esc(s.office_name)} — ${esc(locText(s.location))}<br>
    ${esc(t('total_fee'))}: ${esc(s.total_fees || '-')}<br>${esc(t('processing_time'))}: ${esc(s.total_processing_time || '-')}<hr>
    <b>${esc(t('what_to_bring'))}</b><br>${s.requirements.map(r => `[ ] ${esc(r.requirement)}`).join('<br>')}<hr>${way}${esc(s.source || '')}<br>
    ${new Date().toLocaleString()} · ${esc(KIOSK)} · v${S.bundle.content_version}${S.bundle.navigation ? ` · ${esc(S.bundle.navigation.publication.navigationVersion)}` : ''}`;
  window.print();
}
function showFeedback(serviceId, helpful) {
  if (helpful === 1) { sendFeedback({ service_id: serviceId, helpful: 1 }); toast(t('thanks')); return; }
  overlay(`<div class="sheet" role="dialog" aria-modal="true">
    <h2 class="h2 center">${t('why_not')}</h2><p class="caption muted center">${t('helpful_note')}</p>
    <div class="list" style="width:100%">${[['unclear', 'r_unclear'], ['wrong_info', 'r_wrong'], ['not_found', 'r_notfound'], ['other', 'r_other']].map(([v, k]) =>
      `<button class="row" style="min-height:96px" data-action="fbreason" data-r="${v}" data-id="${serviceId}"><span class="txt"><span class="title">${t(k)}</span></span>${icon('chevron-right', 32)}</button>`).join('')}</div>
    <button class="btn btn-ghost" data-action="fbreason" data-r="" data-id="${serviceId}">${t('skip_btn')}</button></div>`, { bottom: true });
}
function sendFeedback(f) {
  const body = { kiosk_code: KIOSK, reason: null, ...f };
  if (S.online) api('/api/feedback', { method: 'POST', body: JSON.stringify(body) }).catch(() => queueFb(body));
  else queueFb(body);
}
function queueFb(f) { const q = JSON.parse(safeLS.get(LS.fbq) || '[]'); q.push(f); safeLS.set(LS.fbq, JSON.stringify(q)); }

// ---------------------------------------------------------------- idle / privacy reset
function armIdle() {
  clearTimeout(S.idleTimer);
  if (current() === 'welcome' || !IDLE_MS) return;
  S.idleTimer = setTimeout(stillThere, IDLE_MS);
}
function stillThere() {
  let s = WARN_S;
  const el = overlay(`<div class="sheet" role="alertdialog" aria-modal="true" aria-live="assertive">
    <div class="ring"><span class="display" id="cd" style="color:var(--brand-navy)">${s}</span></div>
    <h2 class="h2 center">${t('still_there')}</h2><p class="body muted center" id="cdt">${t('still_body', { s })}</p>
    <div class="btn-row" style="width:100%"><button class="btn btn-secondary" data-action="startover">${t('start_over')}</button><button class="btn btn-primary" data-action="stillhere">${t('still_here')}</button></div></div>`,
    { onClose: () => { clearInterval(S.warnTimer); armIdle(); } });
  S.nav?.ctrl?.pause?.(true);
  clearInterval(S.warnTimer);
  S.warnTimer = setInterval(() => {
    s--; const cd = el.querySelector('#cd'), cdt = el.querySelector('#cdt');
    if (cd) cd.textContent = s; if (cdt) cdt.textContent = t('still_body', { s });
    if (s <= 0) { clearInterval(S.warnTimer); resetToWelcome(); }
  }, 1000);
}

// ---------------------------------------------------------------- actions
const actions = {
  start: () => { if (S.online) api('/api/kiosk-sessions', { method: 'POST', body: JSON.stringify({ kiosk_code: KIOSK }) }).catch(() => {}); go('home'); },
  lang: d => { setLang(d.lang); safeLS.set(LS.lang, d.lang); rerender(); },
  large: () => { stage.classList.toggle('large'); rerender(); },
  home: () => { S.stack = []; go('home'); },
  back,
  search: () => { S.query = ''; S.lastSuggest = []; go('search'); },
  offices: () => go('offices'),
  map: () => { S.mapFloor = S.bundle.kiosk.floor_level; go('map'); },
  mapfloor: d => { S.mapFloor = Number(d.l); go('map', {}, { replace: true }); },
  maproom: d => { const off = S.bundle.offices.find(o => o.location?.room_id === Number(d.id)); if (off) go('office', { id: off.id }); else { const r = idx.rooms.get(Number(d.id)); routeTo({ roomId: r.id }, r.name); } },
  office: d => {
    if (!d.id) return;
    const panel = LAYOUT === 'landscape' && current() === 'offices' && $('.browse-panel');
    if (!panel) return go('office', { id: d.id });
    S.browseSel = Number(d.id);
    panel.innerHTML = officePanelHTML(idx.offices.get(S.browseSel)); panel.scrollTop = 0;
    stage.querySelectorAll('.browse-cols .col-main .row').forEach(r => r.dataset.id === String(S.browseSel) ? r.setAttribute('aria-current', 'true') : r.removeAttribute('aria-current'));
  },
  service: d => go('service', { id: d.id }),
  filter: d => { S.filter = d.f; go('results', {}, { replace: true }); },
  floorfilter: d => { S.floorFilter = d.f; go('offices', {}, { replace: true }); },
  key: d => { S.query = (S.query + d.k).slice(0, 60); refreshSearch(); },
  kbdel: () => { S.query = S.query.slice(0, -1); refreshSearch(); },
  kbclear: () => { S.query = ''; refreshSearch(); },
  kbmode: () => { S.kbMode = S.kbMode === 'abc' ? '123' : 'abc'; go('search', {}, { replace: true }); },
  kbsearch: async () => { if (!S.query.trim()) return; S.results = await doSearch(S.query, true); S.filter = 'all'; go('results'); },
  qr: d => showQR(d.id),
  print: d => printSlip(d.id),
  closeov: () => stage.querySelectorAll('.overlay').forEach(o => o.remove()),
  fb: d => showFeedback(Number(d.id), Number(d.v)),
  fbreason: d => { sendFeedback({ service_id: Number(d.id), helpful: 0, reason: d.r || null }); stage.querySelectorAll('.overlay').forEach(o => o.remove()); toast(t('thanks')); },
  navservice: d => { const s = idx.services.get(Number(d.id)); navigateToOffice(s.office_id, s.id); },
  navoffice: d => navigateToOffice(d.id),
  navopening: d => routeTo({ openingId: d.o }, d.t),
  // "Avoid stairs": replan the same destination; a step-free request never falls back to stairs
  stepfree: () => { S.prefs.stepFree = !S.prefs.stepFree; if (!S.nav) return; S.nav.route = planLocal(S.nav.target); go(S.nav.route.status === 'ok' ? 'navigate' : 'noroute', {}, { replace: true }); },
  navpause: () => { const p = S.nav?.ctrl?.pause(); const b = $('#btn-pause'); if (b) b.innerHTML = p ? `${icon('play', 32)}<span>${t('resume')}</span>` : `${icon('pause', 32)}<span>${t('pause')}</span>`; },
  navreplay: () => { clearTimeout(S.nav?.arrivalTimer); S.nav.mmFloor = null; S.nav.ctrl?.replay(); const b = $('#btn-pause'); if (b) b.innerHTML = `${icon('pause', 32)}<span>${t('pause')}</span>`; },
  navskip: () => S.nav?.ctrl?.skip(),
  endnav: () => { back(); },
  toggle2d: () => { S.nav.mode = S.nav.mode === '3d' ? '2d' : '3d'; S.nav.ctrl?.dispose(); S.nav.ctrl = null; go('navigate', {}, { replace: true }); const l = $('#t2d'); if (l) l.textContent = S.nav.mode === '3d' ? t('view_2d') : t('view_3d'); },
  mmfloor: d => { S.nav.mmFloor = Number(d.l); updateMinimap(S.nav.position || S.nav.route.waypoints[0]); },
  mmfollow: () => { S.nav.mmFloor = null; updateMinimap(S.nav.position || S.nav.route.waypoints[0]); },
  mapmode: () => { S.mapMode = S.mapMode === '3d' ? '2d' : '3d'; rerender(); },
  mapzoom: d => S.mapCtrl?.zoom(Number(d.f)),
  maprotate: () => S.mapCtrl?.rotate(Math.PI / 4),
  mapreset: () => S.mapCtrl?.reset(),
  stillhere: () => { clearInterval(S.warnTimer); stage.querySelectorAll('.overlay').forEach(o => o.remove()); armIdle(); },
  startover: () => { clearInterval(S.warnTimer); resetToWelcome(); },
};
function refreshSearch() {
  const field = $('.searchfield .q');
  if (field) field.innerHTML = `${esc(S.query)}<span class="caret"></span>${S.query ? '' : `<span class="muted"> ${t('search_placeholder')}</span>`}`;
  clearTimeout(S.suggestTimer);
  S.suggestTimer = setTimeout(async () => {
    S.lastSuggest = S.query.trim().length >= 2 ? await doSearch(S.query, false) : [];
    const box = $('#suggest'); if (box) box.innerHTML = S.lastSuggest.slice(0, 4).map(rowHTML).join('');
    const hint = box?.previousElementSibling; if (hint) hint.textContent = S.query.trim() ? t('suggestions') : t('type_to_search');
  }, 180);
}

stage.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || !stage.contains(el)) return;
  e.stopPropagation();
  const fn = actions[el.dataset.action];
  if (fn) fn(el.dataset);
});
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { if (!stage.querySelector('[role="alertdialog"]')) armIdle(); }, { passive: true });
// physical keyboard support (testing on a PC)
addEventListener('keydown', e => {
  if (current() !== 'search') return;
  if (e.key === 'Enter') actions.kbsearch();
  else if (e.key === 'Backspace') actions.kbdel();
  else if (e.key.length === 1) actions.key({ k: e.key.toUpperCase() });
});

// ---------------------------------------------------------------- boot
(async function boot() {
  setLang(safeLS.get(LS.lang) || 'en');
  try {
    await loadBundle();
    go(params.get('screen') || 'welcome', params.get('id') ? { id: Number(params.get('id')) } : {});
  } catch (e) {
    stage.innerHTML = `<section class="screen" style="align-items:center;justify-content:center;padding:80px;text-align:center;gap:24px">
      <div class="circle-icon" style="background:var(--status-warning-tint);color:var(--status-warning)">${icon('alert', 72)}</div>
      <h1 class="h1">${t('restarting')}</h1><p class="body muted">${t('restarting_body')}</p></section>`;
    setTimeout(() => location.reload(), 15000);
  }
  // content sync every minute (?sync=N seconds: faster for tests and demos)
  const syncMs = Math.max(1, Number(params.get('sync') || 60)) * 1000;
  setInterval(syncLoop, syncMs);
  setTimeout(syncLoop, Math.min(5_000, syncMs));
})();
window.addEventListener('error', () => { /* never leave a blank screen */ if (!stage.children.length) location.reload(); });
