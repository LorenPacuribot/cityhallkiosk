// Malaybalay City Hall Kiosk — web prototype (mirrors the Figma kiosk screens K1–K13).
// Works offline from the last downloaded bundle; syncs when the server is reachable.
import { readRoute, routeURL } from './routes.js';
import { icon } from '../shared/icons.js';
import { t, setLang, getLang, direction } from '../shared/i18n.js';
import { planRouteCore } from '../shared/route-core.js';
import { planGraphRoute, resolveDestination, doorForRoom } from '../shared/nav-graph.js';
import { routeFloorSVG, floorPlanSVG, arrivalSVG, floorBounds, placeWalker, followWalker } from '../shared/route-map.js';
import { loadPlans, planFor } from '../shared/plans.js';
import { buildWalk, activeDirection } from '../shared/walk-path.js';

const params = new URLSearchParams(location.search);
const KIOSK = params.get('kiosk') || 'KIOSK-LOBBY-1';
// Staff preview of draft (unverified) routes: only when the URL asks AND the server has preview switched on.
const PREVIEW = params.get('preview') === '1';
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const APP_VERSION = 'web-0.2.0';
const WARN_S = 15;
const LS = { bundle: `kiosk.bundle.${KIOSK}`, fbq: 'kiosk.feedbackQueue', lang: 'kiosk.lang' };

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
// CSS uses actual viewport pixels: no scaled canvas or oversized desktop typography.
function fit() {
  const compact = innerWidth < 600;
  const layout = FORCED || (!compact && innerWidth >= 960 && innerWidth / innerHeight >= 1.15 ? 'landscape' : 'portrait');
  const changed = layout !== LAYOUT;
  LAYOUT = layout;
  stage.classList.toggle('landscape', layout === 'landscape');
  stage.classList.toggle('compact', compact);
  stage.classList.toggle('narrow', innerWidth < 760);
  if (changed && S.stack.length) rerender();
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
      if (S.buildingUsed) import('./three/building-viewer.js').then(m => m.getViewer().updateContent(S.bundle, { preview: graphPreview() })).catch(() => {});
      if (S.nav && ['navigate', 'noroute', 'arrived'].includes(current())) navContentChanged();
      else rerender();
    }
    else if (wasOffline) rerender();
    await api(`/api/kiosks/${encodeURIComponent(KIOSK)}/heartbeat`, { method: 'POST', body: JSON.stringify({ app_version: APP_VERSION, content_version: S.bundle.content_version }) }).catch(() => {});
    flushFeedback();
  } catch {
    if (S.online) { S.online = false; rerender(); }
  }
}
function flushFeedback() {
  const q = feedbackQueue();
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
    <button class="brand-home" data-action="cover" aria-label="${t('back_to_cover')}"><img class="seal" src="/img/malaybalay-seal.jpg" alt="">
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
// An office's own Charter logo; offices without one (has_logo = 0) show the city seal.
const CITY_SEAL = '/img/office-logos/city-seal.png';
const officeLogo = o => `<span class="tile logo${o?.logo_url ? '' : ' seal-fallback'}"><img src="${esc(o?.logo_url || CITY_SEAL)}" alt="" loading="lazy" decoding="async"></span>`;
function rowHTML(item) {
  const isOffice = item.kind === 'office';
  return `<button class="row" data-action="${isOffice ? 'office' : 'service'}" data-id="${item.id}">
    ${isOffice ? officeLogo(idx.offices.get(Number(item.id))) : `<span class="tile">${icon('file-text', 36)}</span>`}
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
function officeRow(o) {
  const sum = summaryOf(o);
  return rowHTML({ kind: 'office', id: o.id, title: o.name, subtitle: sum ? t('helps_with', { text: sum }) : '',
    meta: `${locText(o.location)} · ${t('services_count', { n: o.service_count })}` });
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
  const room = l.room_code ? (/^room\b/i.test(l.room_code) ? l.room_code : t('room_n', { c: l.room_code })) : ''; // "Room 7" codes read as they are
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

function locText(loc) {
  if (!loc || loc.type === 'unconfirmed' && !loc.room_id) return t('location_unconfirmed');
  if (loc.type === 'offsite') return t('not_in_building');
  return [loc.floor_name, loc.room_code].filter(Boolean).join(' · ');
}

// Service sections keep the page layout separate from Charter content rendering.
function serviceRequirementsHTML(s) {
  if (!s.requirements.length) return '';
  return `<section class="card bring-card"><h2 class="h2"><span class="section-number">1</span>${t('what_to_bring')} (${s.requirements.length})</h2>
    ${s.requirements.map(r => `<div class="req"><span class="box" aria-hidden="true"></span><div><p class="label">${esc(r.requirement)}</p>${r.where_to_secure ? `<p class="caption muted">${esc(r.where_to_secure)}</p>` : ''}</div></div>`).join('')}
  </section>`;
}

function serviceFeedbackHTML(s) {
  return `<div class="helpful"><span class="label">${t('did_help')}</span><div class="btns">
    <button data-action="fb" data-v="1" data-id="${s.id}">${icon('thumbs-up', 32)}<span>${t('yes')}</span></button>
    <button data-action="fb" data-v="0" data-id="${s.id}">${icon('thumbs-down', 32)}<span>${t('no')}</span></button></div></div>`;
}

function serviceContextHTML(s) {
  const verified = s.verified_at ? `<span class="badge success">${icon('circle-check', 24)}${t('verified_on', { d: new Date(s.verified_at).toLocaleDateString([], { month: 'short', year: 'numeric' }) })}</span>` : '';
  const inBuilding = s.location?.room_id;
  const govBadge = s.is_citizen_facing ? '' : `<span class="badge neutral">${icon('building', 24)}${t('gov_services')}</span>`;
  return `<div class="service-context"><header class="service-context-header">
    ${s.plain_title ? `<p class="caption muted">${esc(s.title)}</p>` : ''}
    ${s.description ? `<p class="body muted svc-desc">${esc(s.description)}</p>` : ''}
    <div class="badges">
      <button class="badge badge-link ${inBuilding ? 'info' : 'offsite'}" data-action="office" data-id="${s.office_id}">${icon(inBuilding ? 'map-pin' : 'building', 24)}${esc(s.office_name)} · ${esc(locText(s.location))}${icon('chevron-right', 24)}</button>
      ${govBadge}${s.classification ? `<span class="badge neutral">${esc(s.classification)}</span>` : ''}${verified}
    </div>
  </header></div>`;
}

function serviceProcessHTML(s) {
  return `${s.steps.length ? `<section class="card steps-card"><h2 class="h2"><span class="section-number">2</span>${t('what_youll_do')}</h2>
    <div class="list">${s.steps.map((st, i) => `<div class="step"><span class="num">${i + 1}</span><div class="step-content">
      ${st.client_action ? `<p class="label">${esc(st.client_action)}</p>` : ''}
      ${st.agency.length ? `<div class="agency">${st.agency.map(a => `<div><p class="caption muted">${esc(a.agency_action)}</p>
        <p class="caption meta">${stepMeta(a)}</p></div>`).join('')}</div>` : ''}
    </div></div>`).join('')}</div></section>` : ''}
  ${s.notes ? `<section class="card notes"><h2 class="h3">${t('notes')}</h2>${notesHTML(s.notes)}</section>` : ''}`;
}

// One page header for every screen: the City Hall gradient band with Back, title and an optional subtitle line.
function pageHead(title, { sub = '', back = true, cls = '' } = {}) {
  return `<div class="page-head ${cls}">${back ? backBtn() : ''}<div class="head-txt"><h1 class="h1">${title}</h1>${sub ? `<p class="body">${sub}</p>` : ''}</div></div>`;
}

// ---------------------------------------------------------------- screens
const screens = {
  welcome() {
    const st = openStatus(new Date());
    return `<section class="screen welcome-cover">
      <img src="/img/cityhall-cover-2026.jpg" alt="" class="welcome-photo" fetchpriority="high">
      <header class="welcome-header">
        <div class="welcome-brand"><img src="/img/malaybalay-seal.jpg" alt="" class="seal"><div><p class="caption">${t('city')}</p><p class="h3">${t('kiosk_name')}</p></div></div>
        <div class="welcome-info"><div class="welcome-clock"><time data-clock="time">${coverClock('time')}</time><span data-clock="date">${coverClock('date')}</span></div><span class="welcome-status ${st.open ? 'is-open' : 'is-closed'}"><i class="dot"></i>${esc(st.text)}</span></div>
      </header>
      <div class="welcome-main">
        <p class="welcome-greeting">${t('welcome_sub')}</p>
        <h1>${t('welcome_intro')}<span>${t('kiosk_name')}</span></h1>
        <button class="welcome-start" data-action="start"><span class="start-icon">${icon('navigation', 40)}</span>${t('touch_to_start')}</button>
      </div>
      <footer class="welcome-footer"><div class="welcome-languages" role="group" aria-label="${t('language')}">${LANGS.map(([lang, name]) => `<button data-action="lang" data-lang="${lang}" aria-pressed="${getLang() === lang}">${name}</button>`).join('')}</div></footer>
      ${S.online ? '' : `<div class="banner warning" role="status">${t('offline_banner', { t: fmtTime(S.savedAt) })}</div>`}
    </section>`;
  },

  home() {
    const popular = (S.bundle.popular_service_ids || []).slice(0, 6).map(id => idx.services.get(id)).filter(Boolean);
    return `<section class="screen home-screen">${topbar()}
      <div class="page-head home-head"><div class="head-txt"><h1 class="display">${t('home_q')}</h1><p class="body">${t('home_sub')}</p></div>
        <button class="searchfield home-search" data-action="search"><span class="search-dot">${icon('search', 28)}</span><span class="q">${t('search_placeholder')}</span></button></div>
      <div class="content home-content">
        <div class="choices">
          ${[['search', 'file-text', 'find_service'], ['offices', 'building', 'browse_offices'], ['map', 'map', 'map_hall']].map(([a, ic, k]) => `
          <button class="choice" data-action="${a}"><span class="tile">${icon(ic, 32)}</span><span class="choice-txt"><span class="h3">${t(k)}</span><span class="caption muted">${t(k + '_d')}</span></span></button>`).join('')}
        </div>
        ${popular.length ? `<section class="popular-services" aria-labelledby="popular-title"><h2 class="h2" id="popular-title">${t('popular')}</h2><div class="popular-grid">${popular.map(s => rowHTML({ kind: 'service', id: s.id, title: s.display_title, subtitle: `${s.office_name} · ${locText(s.location)}` })).join('')}</div></section>` : ''}
      </div>${helpbar()}</section>`;
  },

  notfound() {
    return `<section class="screen">${topbar()}${pageHead(t('page_not_found'), { back: false })}<div class="content centered">
      <p class="body muted">${t('page_not_found_body')}</p>
      <button class="btn btn-primary" data-action="home">${t('back_home')}</button>
    </div>${helpbar()}</section>`;
  },

  search() {
    const q = S.query;
    const sug = S.lastSuggest;
    // Recent searches are this visitor's own (cleared at the privacy reset); before any, common search terms.
    const recent = S.recent || [], terms = recent.length ? recent : COMMON_SEARCHES;
    return `<section class="screen search-screen">${topbar()}${pageHead(t('find_service'), { sub: t('find_service_d') })}
      <div class="content search-page">
        <form class="search-form" id="search-form">
          <label class="sr-only" for="service-search">${t('search_placeholder')}</label>
          <div class="searchfield search-big">${icon('search', 32)}<input id="service-search" type="search" value="${esc(q)}" placeholder="${t('search_placeholder')}" autocomplete="off" maxlength="60"><button class="btn btn-primary" type="submit">${t('kb_search')}</button></div>
        </form>
        <section class="search-suggest" aria-live="polite">
          <p class="caption muted">${q.trim() ? t('suggestions') : t('type_to_search')}</p>
          <div class="list suggest-grid" id="suggest">${sug.slice(0, 6).map(rowHTML).join('')}</div>
        </section>
        <section class="search-recent"${q.trim() ? ' hidden' : ''}>
          <h2 class="h3">${t(recent.length ? 'recent_searches' : 'try_searching')}</h2>
          <div class="chips recent-chips">${terms.map(term => `<button class="chip" data-action="recentq" data-q="${esc(term)}">${icon(recent.length ? 'clock' : 'search', 22)}${esc(term)}</button>`).join('')}</div>
          ${recent.length ? `<p class="caption muted">${t('recent_note')}</p>` : ''}
        </section>
        ${keyboard()}
      </div></section>`;
  },

  results() {
    const all = S.results || [];
    const list = S.filter === 'all' ? all : all.filter(r => r.kind === (S.filter === 'services' ? 'service' : 'office'));
    const nS = all.filter(r => r.kind === 'service').length, nO = all.length - nS;
    if (!all.length) return screens.noresults();
    return `<section class="screen">${topbar()}${pageHead(all.length === 1 ? t('result_for', { q: esc(S.query) }) : t('results_for', { n: all.length, q: esc(S.query) }))}
      <div class="content">
        <div class="chips" role="group">
          ${[['all', `${t('all')} (${all.length})`], ['services', `${t('services')} (${nS})`], ['offices', `${t('offices')} (${nO})`]].map(([k, l]) => `<button class="chip" data-action="filter" data-f="${k}" aria-pressed="${S.filter === k}">${l}</button>`).join('')}
        </div>
        <div class="list">${list.map(rowHTML).join('')}</div>
        <div class="card" style="display:flex;gap:16px;align-items:center;background:var(--bg-subtle);border:0">${icon('message', 36)}<span class="caption muted">${t('not_what')}</span></div>
      </div>${helpbar()}</section>`;
  },

  noresults() {
    const pop = (S.bundle.popular_service_ids || []).slice(0, 3).map(id => idx.services.get(id)).filter(Boolean);
    return `<section class="screen">${topbar()}${pageHead(t('find_service'))}
      <div class="content">
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

  // Dedicated office directory; each office opens its own detail screen.
  offices() {
    const f = S.floorFilter;
    const all = officeGroups('all');
    const chips = [['all', t('all_floors')], ...all.filter(g => g.key !== 'unconfirmed' && g.key !== 'out').map(g => [g.key, g.label]), ...(all.some(g => g.key === 'out' || g.key === 'unconfirmed') ? [['out', t('not_in_building')]] : [])];
    const list = officeGroups(f).map(g => `<section class="office-directory-group"><h2 class="h2 group-h">${esc(g.label)}</h2><div class="list">${g.items.map(o => officeRow(o)).join('')}</div></section>`).join('');
    return `<section class="screen civic-detail office-directory">${topbar()}
      <div class="page-head svc-head">${backBtn()}<div class="head-txt"><h1 class="h1">${t('offices_title')}</h1></div></div>
      <div class="content directory-content">
        <div class="chips" role="group" aria-label="${t('all_floors')}">${chips.map(([k, l]) => `<button class="chip" data-action="floorfilter" data-f="${k}" aria-pressed="${f === k}">${esc(l)}</button>`).join('')}</div>
        ${list}
      </div>${helpbar()}</section>`;
  },

  office({ id }) {
    const o = idx.offices.get(Number(id));
    if (!o) return screens.notfound();
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
    if (!s) return screens.notfound();
    if (S.online) fetch(`/api/services/${s.id}`).catch(() => {}); // view counter
    const facts = [['wallet', 'total_fee', s.total_fees], ['clock', 'processing_time', s.total_processing_time], ['users', 'who_may_apply', s.who_may_avail]];
    return `<section class="screen civic-detail service-detail">${topbar()}
      <div class="page-head svc-head">${backBtn()}<div class="head-txt">
        <h1 class="h1">${esc(s.display_title)}</h1>
        <p class="body">${esc(s.office_name)} · ${esc(locText(s.location))}</p>
      </div></div>
      <div class="content service-content">
        <div class="stats">${facts.map(([ic, key, value]) =>
          `<div class="stat"><span class="lbl">${icon(ic, 28)}${t(key)}</span><span class="val">${esc(value || '—')}</span></div>`).join('')}</div>
        <div class="service-grid">
          ${serviceRequirementsHTML(s)}
          <div class="service-process">${serviceProcessHTML(s)}</div>
          <div class="service-support">
            ${serviceFeedbackHTML(s)}
            <details class="service-reference"><summary>${t('service_reference')}</summary>
              ${serviceContextHTML(s)}
              <p class="caption muted">${s.verified_at ? '' : t('not_verified') + ' / '}${t('from_charter', { src: esc(s.source || "Citizen's Charter") })}</p>
            </details>
          </div>
        </div>
      </div>
      <div class="dock">
        <div class="dock-destination"><p class="label">${esc(s.office_name)}</p><p class="caption muted">${esc(locText(s.location))}</p></div>
        <button class="btn btn-secondary" data-action="qr" data-id="${s.id}">${icon('qr', 36)}${t('take_it')}</button>
        <button class="btn btn-primary" data-action="navservice" data-id="${s.id}">${icon('navigation', 36)}${t('show_way')}</button>
      </div>
    </section>`;
  },

  offsite({ id }) {
    const o = idx.offices.get(Number(id));
    return `<section class="screen">${topbar()}${pageHead(esc(o?.name || ''), { sub: t('offsite_title') })}
      <div class="content" style="align-items:center;text-align:center">
        <div class="circle-icon" style="background:var(--brand-terracotta-tint);color:var(--brand-terracotta)">${icon('building', 64)}</div>
        ${o?.offsite_address ? `<p class="body">${t('offsite_body', { addr: esc(o.offsite_address) })}</p>` : `<p class="body muted">${t('location_unconfirmed')}</p>`}
        ${o?.phone ? `<p class="label">${icon('phone', 32)} ${esc(o.phone)}</p>` : ''}
        <p class="caption muted">${esc(o?.hours || '')}</p>
      </div>${helpbar()}</section>`;
  },

  navigate() {
    const r = S.nav.route;
    // Playback controls and minimap are outside the 3D viewport.
    const controls = `<div class="controls">
          <button data-action="navpause" id="btn-pause">${icon('pause', 32)}<span>${t('pause')}</span></button>
          <button data-action="navreplay">${icon('replay', 32)}<span>${t('replay')}</span></button>
          <button data-action="navskip">${icon('skip', 32)}<span>${t('skip')}</span></button>
        </div>`;
    // the banner is about the ROUTE. An unverified building alignment (calibration) only matters for the 3D view:
    // verified routes then play on the 2D map, which uses canonical coordinates and stays correct.
    const draft = r.verification !== 'verified';
    return `<section class="screen">${topbar()}
      <div class="dest">${icon('map-pin', 44)}<div style="flex:1"><h1 class="h3">${t('navigating_to', { room: esc(S.nav.title) })}</h1>
        <p class="caption">${t('walk_info', { room_code: r.to.room_code, floor: r.to.floor_name, d: r.distance_m, m: r.minutes })}</p></div></div>
      ${draft ? `<div class="banner warning draft-route" role="note">${icon('alert', 32)}<span>${t(isGraphRoute(r) ? 'draft_route' : 'prototype_route')}</span></div>` : ''}
      <div class="nav-body">
      <div class="viewport3d" id="vp">
        <div class="vp-loading" hidden role="status"><span class="label">${t('loading_building')}</span><div class="bar"><div></div></div></div>
      </div>
      <aside class="navigation-sidebar">
        <div class="nav-status">
          <div class="progress"><div id="prog"></div></div>
          <h2 class="h3" id="dircur" aria-live="polite">${esc(direction(r.directions[0]))}</h2>
          ${controls}
        </div>
        <div class="minimap" aria-label="${t('map_hall')}">
          <span class="caption" id="mm-status" aria-live="polite"></span>
          <div id="mm"></div>
          <div class="floorpick">${(isGraphRoute(r) ? S.bundle.navigation.graph.floors || [] : S.bundle.floors)
            .map(f => `<button data-action="mmfloor" data-l="${f.level}" aria-pressed="false">${esc(f.name)}</button>`).join('')}</div>
          <button class="chip mm-follow" data-action="mmfollow" aria-pressed="${S.nav.mmFloor == null}">${icon('navigation', 24)}${t('follow_position')}</button>
        </div>
      <div class="directions">
        <div id="dirs">${r.directions.map((d, i) => `<div class="dir" data-i="${i}"><span class="n"><span class="n-num">${d.kind === 'floor_change' ? icon('stairs', 28) : i + 1}</span><span class="n-done">${icon('check', 28)}</span></span><span class="label" style="font-weight:inherit">${esc(direction(d))}</span></div>`).join('')}</div>
        <div class="btn-row"><button class="btn btn-secondary" data-action="toggle2d">${icon('map', 32)}<span id="t2d">${t(S.nav.mode === '2d' ? 'view_3d' : 'view_2d')}</span></button><button class="btn btn-secondary" data-action="endnav">${t('end_nav')}</button></div>
      </div></aside></div></section>`;
  },

  // A valid request that cannot be routed: say why, show where the office is, draw no line.
  noroute() {
    const n = S.nav, r = n.route;
    const office = n.officeId ? idx.offices.get(Number(n.officeId)) : null;
    const reasonKey = `route_${String(r.reason || 'DISCONNECTED').toLowerCase()}`;
    return `<section class="screen">${topbar()}${pageHead(t('route_unavailable'))}
      <div class="content centered" style="align-items:center;text-align:center">
        <div class="circle-icon" style="background:var(--status-warning-tint);color:var(--status-warning)">${icon('alert', 64)}</div>
        <p class="body">${t(reasonKey) || esc(r.message || '')}</p>
        ${office?.location ? `<p class="label">${esc(office.name)} · ${esc(locText(office.location))}</p>` : ''}
        <p class="body muted">${t('ask_info_desk')}</p>
        ${r.reason === 'NO_STEP_FREE_ROUTE' ? `<p class="caption muted">${t('step_free_note')}</p>` : ''}
        <div style="display:flex;flex-direction:column;gap:16px;width:100%;max-width:720px">
          ${n.serviceId ? `<button class="btn btn-secondary btn-block" data-action="service" data-id="${n.serviceId}">${t('see_requirements')}</button>` : ''}
          <button class="btn btn-primary btn-block" data-action="home">${t('back_home')}</button>
        </div>
      </div>${helpbar()}</section>`;
  },

  arrived() {
    const n = S.nav;
    const room = idx.rooms.get(n.route.to.room_id);
    const office = n.officeId ? idx.offices.get(n.officeId) : null;
    return `<section class="screen">${topbar()}${pageHead(t('arrived'), { back: false, sub: esc(office?.name || room?.name || '') })}
      <div class="content cols arrived-cols" style="align-items:center;text-align:center">
        <div class="col-main"><div class="card arrival-map-card" style="width:100%;padding:0;overflow:hidden">${arrivalMap(n.route, office?.name || room?.name || '')}</div></div>
        <div class="col-side">
        <div class="circle-icon" style="background:var(--brand-grass-tint);color:var(--status-success)">${icon('circle-check', 64)}</div>
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
    return `<section class="screen">${topbar()}${pageHead(t('map_hall'), { sub: t('map_hall_d') })}
      <div class="content cols map-cols">
        <div class="col-main">
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

// Arrival: the 2D floor map around the office's door with its name; the door drawing when there is no graph route.
function arrivalMap(r, name) {
  if (!isGraphRoute(r) || !r.to?.floor_level) return doorIllustration(r.to.room_code, name);
  const l = r.to, room = l.room_code ? (/^room\b/i.test(l.room_code) ? l.room_code : t('room_n', { c: l.room_code })) : '';
  return arrivalSVG({ graph: S.bundle.navigation.graph, route: r, plan: usablePlan(l.floor_level), title: name || room, sub: [room, l.floor_name].filter(Boolean).join(' · ') });
}
function doorIllustration(code, name) {
  // 16:9, the frame a real door photo will use later. The sign above the door carries the office name only.
  const label = name || code, fs = label.length > 44 ? 18 : label.length > 30 ? 21 : 24;
  const w = Math.min(940, Math.max(320, Math.round(label.length * fs * 0.56) + 64));
  return `<svg viewBox="0 0 1000 562" width="100%" style="display:block" role="img" aria-label="${esc(label)}"><rect width="1000" height="562" fill="#F4F1EA"/><g transform="translate(0 142)"><rect y="330" width="1000" height="90" fill="#C98F6C"/>
  <rect x="380" y="70" width="240" height="260" fill="#23415F"/><rect x="396" y="86" width="208" height="244" fill="#2E5578"/><circle cx="584" cy="210" r="9" fill="#D9A520"/>
  <rect x="${500 - w / 2}" y="18" width="${w}" height="44" rx="8" fill="#12355B"/><text x="500" y="${40 + fs * 0.35}" fill="#fff" font-size="${fs}" font-weight="700" text-anchor="middle" font-family="sans-serif">${esc(label.length > 70 ? label.slice(0, 67) + '…' : label)}</text>
  <rect x="140" y="110" width="140" height="160" fill="#DCE9F5"/><rect x="720" y="110" width="140" height="160" fill="#DCE9F5"/></g></svg>`;
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
  const local = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(local.weekday);
  const mins = Number(local.hour) * 60 + Number(local.minute), weekday = day >= 1 && day <= 5;
  if (weekday && mins >= open && mins < close) return { open: true, text: t('open_now', { t: fmtHM(close) }) };
  if (weekday && mins < open) return { open: false, text: t('opens_today', { t: fmtHM(open) }) };
  if (day >= 1 && day <= 4) return { open: false, text: t('opens_tomorrow', { t: fmtHM(open) }) };
  return { open: false, text: t('opens_monday', { t: fmtHM(open) }) };
}
function tickClock() {
  const st = openStatus(new Date());
  stage.querySelectorAll('.open-pill, .welcome-status').forEach(el => {
    el.classList.toggle('is-open', st.open); el.classList.toggle('is-closed', !st.open);
    el.innerHTML = `<i class="dot"></i>${esc(st.text)}`;
  });
  stage.querySelectorAll('[data-clock]').forEach(el => { el.textContent = coverClock(el.dataset.clock); });
}
function coverClock(part) {
  const options = part === 'time' ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'long', day: 'numeric', month: 'long' };
  return new Intl.DateTimeFormat(getLang() === 'fil' ? 'fil-PH' : 'en-PH', { timeZone: 'Asia/Manila', ...options }).format(new Date());
}
setInterval(tickClock, 15000);

// ---------------------------------------------------------------- router
let historyEpoch = history.state?.kioskEpoch || `${Date.now()}-${Math.random()}`;
let urlGeneration = 0;
function current() { return S.stack[S.stack.length - 1]?.name || 'welcome'; }
const SCROLLERS = '.screen, .content, .col-main, .col-side, .service-process, .navigation-sidebar';
function routeParams(name, p = {}) {
  if (['search', 'results', 'noresults'].includes(name)) return { ...p, q: S.query, filter: S.filter };
  if (name === 'offices') return { ...p, floor: S.floorFilter };
  if (name === 'map') return { ...p, floor: S.mapFloor };
  if (['navigate', 'noroute', 'arrived'].includes(name) && S.nav) return { target: S.nav.target, title: S.nav.title, serviceId: S.nav.serviceId };
  return p;
}
function updateHistory(replace = false) {
  const entry = S.stack.at(-1); if (!entry) return;
  entry.p = routeParams(entry.name, entry.p);
  const state = { kioskEpoch: historyEpoch, stack: S.stack };
  history[replace ? 'replaceState' : 'pushState'](state, '', routeURL(entry.name, entry.p, location.href));
}
function go(name, p = {}, { replace = false, restore = null, fromHistory = false } = {}) {
  if (!fromHistory) ++urlGeneration;
  if (!Object.hasOwn(screens, name)) name = 'notfound';
  if (['office', 'offsite'].includes(name) && !idx.offices.has(Number(p.id))) name = 'notfound';
  if (name === 'service' && !idx.services.has(Number(p.id))) name = 'notfound';
  if (['navigate', 'noroute', 'arrived'].includes(name) && !S.nav) name = 'notfound';
  if (!fromHistory && S.stack.length) {
    S.stack.at(-1).scroll = [...stage.querySelectorAll(SCROLLERS)].map(el => el.scrollTop);
    updateHistory(true);
  }
  closeOverlay({ restoreFocus: false });
  if (replace) S.stack.pop();
  S.stack.push({ name, p: routeParams(name, p) });
  updateHistory(replace || fromHistory || S.stack.length === 1);
  rerender({ focus: true });
  if (restore) stage.querySelectorAll(SCROLLERS).forEach((el, i) => { el.scrollTop = restore[i] || 0; });
  armIdle();
}
function back() {
  if (S.stack.length > 1) history.back();
  else resetToWelcome();
}
async function openURL({ state = null } = {}) {
  const generation = ++urlGeneration;
  if (state?.kioskEpoch && state.kioskEpoch !== historyEpoch) { resetToWelcome(); return; }
  const saved = state?.kioskEpoch === historyEpoch && state.stack?.length ? state.stack : null;
  const entry = saved ? saved.at(-1) : readRoute(location.href);
  const { name, p = {} } = entry;
  if (name === 'offices') S.floorFilter = ['all', 'out', 'unconfirmed', ...S.bundle.floors.map(f => String(f.level))].includes(p.floor) ? p.floor : 'all';
  if (name === 'map') S.mapFloor = S.bundle.floors.some(f => f.level === Number(p.floor)) ? Number(p.floor) : S.bundle.floors[0].level;
  if (['search', 'results', 'noresults'].includes(name)) {
    S.query = String(p.q || '').slice(0, 60); S.filter = ['all', 'services', 'offices'].includes(p.filter) ? p.filter : 'all';
    if (name !== 'search') S.results = await doSearch(S.query, false);
  }
  if (generation !== urlGeneration) return;
  let next = name;
  if (['navigate', 'noroute', 'arrived'].includes(name) && p.target) {
    stopNav();
    const route = planLocal(p.target);
    const office = idx.offices.get(Number(p.target.officeId)) || S.bundle.offices.find(o => o.location?.room_id && o.location.room_id === route.to?.room_id);
    S.nav = { route, target: p.target, title: office?.name || p.title || route.to?.room_code || t('map_hall'), serviceId: p.serviceId, officeId: office?.id, ctrl: null, mode: '3d', step: 0 };
    next = route.status === 'ok' ? 'navigate' : 'noroute';
  }
  S.stack = saved || [];
  go(next, p, { replace: true, fromHistory: true, restore: entry.scroll });
  if (next === 'search') refreshSearch();
}
addEventListener('popstate', e => { if (S.bundle) openURL({ state: e.state }); });
function rerender({ focus = false } = {}) {
  stopMap();
  const { name, p } = S.stack.at(-1) || { name: 'home', p: {} };
  if (name !== 'navigate') stopNav();
  const active = document.activeElement;
  const focusAction = active?.dataset?.action, focusLang = active?.dataset?.lang;
  const overlays = [...stage.querySelectorAll('.overlay')];
  stage.innerHTML = (screens[name] || screens.notfound)(p);
  stage.querySelectorAll('.screen').forEach(el => el.dataset.page = name);
  overlays.forEach(o => stage.appendChild(o));
  if (overlays.length) stage.querySelector('.screen').inert = true;
  if (name === 'navigate') startNav();
  if (name === 'map') startMap();
  document.title = `${stage.querySelector('h1')?.textContent || t('map_hall')} | ${t('kiosk_name')}`;
  if (focus) {
    const heading = stage.querySelector('h1') || stage.querySelector('.dest');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  } else if (focusAction) {
    [...stage.querySelectorAll('[data-action]')].find(el => el.dataset.action === focusAction && (!focusLang || el.dataset.lang === focusLang))?.focus({ preventScroll: true });
  }
}
// Native scrolling supplies a visible scrollbar; no faded text at the edge.
function updateScrollFades() {}
function resetToWelcome(destination = 'welcome') {
  clearTimeout(S.idleTimer); clearInterval(S.warnTimer); clearTimeout(S.suggestTimer);
  stopNav(); stopMap(); closeOverlay({ restoreFocus: false });
  historyEpoch = `${Date.now()}-${Math.random()}`; ++urlGeneration; ++searchGeneration;
  S.stack = []; S.query = ''; S.results = null; S.filter = 'all'; S.floorFilter = 'all'; S.lastSuggest = []; S.recent = [];
  S.nav = null; S.prefs.stepFree = false; S.mapFloor = 1; S.mapMode = '3d';
  document.getElementById('print-slip')?.remove();
  stage.classList.remove('large'); setLang(safeLS.get(LS.lang) || 'en');
  go(destination, {}, { replace: true });
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
    v.attach(vp); v.updateContent(S.bundle, { preview: graphPreview() }); S.buildingUsed = true;
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
    const d = resolveDestination(nav.graph, t2, { preview: allow, kioskCode: KIOSK });
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
  go(route.status === 'ok' ? 'navigate' : 'noroute', { target, title, serviceId });
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
    const ctrl = await createNav3D(vp, S.bundle, S.nav.route, { preview: graphPreview(),
      signal: ac.signal, onProgress, onArrive, onFallback: fallback,
      onLoadProgress: ev => { if (!live() || !loading) return; loading.hidden = false; const b = loading.querySelector('.bar > div'); if (b) b.style.width = `${Math.round(ev.fraction * 100)}%`; },
    });
    if (!live()) { ctrl.dispose(); return; } // the visitor left while the building loaded: never attach to an old screen
    S.nav.ctrl = ctrl;
    if (reducedMotion()) setPlaybackPaused(true);
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
    pause(force) { this.paused = force ?? !this.paused; last = null; if (!this.paused) schedule(); return this.paused; },
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
  if (reducedMotion()) setPlaybackPaused(true);
}

function setPlaybackPaused(force) {
  const paused = S.nav?.ctrl?.pause(force);
  if (paused == null) return;
  const button = $('#btn-pause');
  if (button) button.innerHTML = `${icon(paused ? 'play' : 'pause', 32)}<span>${t(paused ? 'resume' : 'pause')}</span>`;
}

// ---------------------------------------------------------------- overlays
let overlayFocus = null, overlayOnClose = null;
function closeOverlay({ restoreFocus = true } = {}) {
  const present = stage.querySelector('.overlay');
  if (!present) return;
  stage.querySelectorAll('.overlay').forEach(el => el.remove());
  const screen = stage.querySelector('.screen'); if (screen) screen.inert = false;
  const callback = overlayOnClose; overlayOnClose = null; callback?.();
  if (restoreFocus && overlayFocus?.isConnected) overlayFocus.focus();
  overlayFocus = null;
}
function overlay(html, { bottom = false, onClose } = {}) {
  closeOverlay({ restoreFocus: false });
  overlayFocus = document.activeElement; overlayOnClose = onClose;
  const el = document.createElement('div');
  el.className = `overlay${bottom ? ' bottom' : ''}`; el.innerHTML = html;
  el.addEventListener('click', e => { if (e.target === el) closeOverlay(); });
  el.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); return; }
    if (e.key !== 'Tab') return;
    const nodes = [...el.querySelectorAll('button, a[href], input, summary, [tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length);
    const first = nodes[0], last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  stage.querySelector('.screen').inert = true;
  stage.appendChild(el); el.querySelector('button')?.focus();
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
  overlay(`<div class="sheet" role="dialog" aria-modal="true" aria-label="${t('why_not')}">
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
function feedbackQueue() {
  try { const q = JSON.parse(safeLS.get(LS.fbq) || '[]'); return Array.isArray(q) ? q : []; } catch { return []; }
}
function queueFb(f) { const q = feedbackQueue(); q.push(f); safeLS.set(LS.fbq, JSON.stringify(q)); }

// ---------------------------------------------------------------- idle / privacy reset
function armIdle() {
  clearTimeout(S.idleTimer);
  if (current() === 'welcome' || !IDLE_MS) return;
  S.idleTimer = setTimeout(stillThere, IDLE_MS);
}
function stillThere() {
  let s = WARN_S;
  const el = overlay(`<div class="sheet" role="alertdialog" aria-modal="true" aria-label="${t('still_there')}" aria-live="assertive">
    <div class="ring"><span class="display" id="cd" style="color:var(--brand-navy)">${s}</span></div>
    <h2 class="h2 center">${t('still_there')}</h2><p class="body muted center" id="cdt">${t('still_body', { s })}</p>
    <div class="btn-row" style="width:100%"><button class="btn btn-secondary" data-action="startover">${t('start_over')}</button><button class="btn btn-primary" data-action="stillhere">${t('still_here')}</button></div></div>`,
    { onClose: () => { clearInterval(S.warnTimer); armIdle(); } });
  setPlaybackPaused(true);
  clearInterval(S.warnTimer);
  S.warnTimer = setInterval(() => {
    s--; const cd = el.querySelector('#cd'), cdt = el.querySelector('#cdt');
    if (cd) cd.textContent = s; if (cdt) cdt.textContent = t('still_body', { s });
    if (s <= 0) { clearInterval(S.warnTimer); resetToWelcome(); }
  }, 1000);
}

// ---------------------------------------------------------------- actions
function openCityHallMap() {
  // The owner's local presentation uses the real-model demo until live navigation
  // is published. Keep draft verification intact; never publish into the live DB.
  const localPresentation = location.port === '3000' || location.port === '3100';
  const needsDemo = location.port === '3000' && !S.bundle.navigation?.publication;
  const needsPreview = location.port === '3100' && (!PREVIEW || KIOSK !== 'PILOT-ENTRANCE');
  if (localPresentation && (needsDemo || needsPreview)) {
    const url = new URL('/kiosk/map', location.href);
    url.port = '3100';
    url.searchParams.set('kiosk', 'PILOT-ENTRANCE');
    url.searchParams.set('preview', '1');
    for (const key of ['layout', 'idle']) if (params.has(key)) url.searchParams.set(key, params.get(key));
    location.assign(url.href);
    return;
  }
  S.mapFloor = S.bundle.kiosk.floor_level;
  go('map');
}
const actions = {
  start: () => { if (S.online) api('/api/kiosk-sessions', { method: 'POST', body: JSON.stringify({ kiosk_code: KIOSK }) }).catch(() => {}); go('home'); },
  lang: d => { setLang(d.lang); safeLS.set(LS.lang, d.lang); rerender(); },
  large: () => { stage.classList.toggle('large'); rerender(); },
  home: () => resetToWelcome('home'),
  cover: () => resetToWelcome('welcome'), // the City Hall seal and name return to the cover (with the privacy reset)
  back,
  search: () => { S.query = ''; S.lastSuggest = []; go('search'); },
  offices: () => go('offices'),
  map: openCityHallMap,
  mapfloor: d => { S.mapFloor = Number(d.l); go('map', {}, { replace: true }); },
  maproom: d => { const off = S.bundle.offices.find(o => o.location?.room_id === Number(d.id)); if (off) go('office', { id: off.id }); else { const r = idx.rooms.get(Number(d.id)); routeTo({ roomId: r.id }, r.name); } },
  office: d => { if (d.id) go('office', { id: d.id }); },
  service: d => go('service', { id: d.id }),
  filter: d => { S.filter = d.f; go('results', {}, { replace: true }); },
  floorfilter: d => { S.floorFilter = d.f; go('offices', {}, { replace: true }); },
  key: d => { S.query = (S.query + d.k).slice(0, 60); refreshSearch(); },
  kbdel: () => { S.query = S.query.slice(0, -1); refreshSearch(); },
  kbclear: () => { S.query = ''; refreshSearch(); },
  kbmode: () => { S.kbMode = S.kbMode === 'abc' ? '123' : 'abc'; go('search', {}, { replace: true }); },
  kbsearch: async () => {
    if (!S.query.trim()) return;
    const generation = ++searchGeneration, query = S.query;
    const results = await doSearch(query, true);
    if (generation !== searchGeneration || current() !== 'search' || S.query !== query) return;
    const term = query.trim();
    S.recent = [term, ...(S.recent || []).filter(x => x.toLowerCase() !== term.toLowerCase())].slice(0, 6);
    S.results = results; S.filter = 'all'; go('results');
  },
  recentq: d => { S.query = String(d.q || '').slice(0, 60); refreshSearch(); actions.kbsearch(); },
  qr: d => showQR(d.id),
  print: d => printSlip(d.id),
  closeov: () => closeOverlay(),
  fb: d => showFeedback(Number(d.id), Number(d.v)),
  fbreason: d => { sendFeedback({ service_id: Number(d.id), helpful: 0, reason: d.r || null }); closeOverlay(); toast(t('thanks')); },
  navservice: d => { const s = idx.services.get(Number(d.id)); navigateToOffice(s.office_id, s.id); },
  navoffice: d => navigateToOffice(d.id),
  navopening: d => routeTo({ openingId: d.o }, d.t),
  navpause: () => setPlaybackPaused(),
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
  stillhere: () => { clearInterval(S.warnTimer); closeOverlay(); armIdle(); },
  startover: () => { clearInterval(S.warnTimer); resetToWelcome(); },
};
let searchGeneration = 0;
// Shown before the visitor has searched: the terms the kiosk's own popular defaults use (not other visitors' searches).
const COMMON_SEARCHES = ['cedula', 'birth certificate', 'business permit', 'amilyar', 'senior citizen ID', 'marriage license'];
function refreshSearch() {
  const input = $('#service-search');
  if (input && input.value !== S.query) input.value = S.query;
  clearTimeout(S.suggestTimer);
  const generation = ++searchGeneration, query = S.query;
  updateHistory(true);
  S.suggestTimer = setTimeout(async () => {
    const results = query.trim().length >= 2 ? await doSearch(query, false) : [];
    if (generation !== searchGeneration || current() !== 'search') return;
    S.lastSuggest = results;
    const box = $('#suggest'); if (box) box.innerHTML = results.slice(0, 6).map(rowHTML).join('');
    const hint = box?.previousElementSibling; if (hint) hint.textContent = query.trim() ? t('suggestions') : t('type_to_search');
    const recent = $('.search-recent'); if (recent) recent.hidden = !!query.trim(); // typing: suggestions get the room
  }, 180);
}
stage.addEventListener('input', e => {
  if (e.target.id === 'service-search') { S.query = e.target.value.slice(0, 60); refreshSearch(); armIdle(); }
});
stage.addEventListener('submit', e => { if (e.target.id === 'search-form') { e.preventDefault(); actions.kbsearch(); } });

stage.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || !stage.contains(el)) return;
  e.stopPropagation();
  const fn = actions[el.dataset.action];
  if (fn) fn(el.dataset);
});
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { if (!stage.querySelector('[role="alertdialog"]')) armIdle(); }, { passive: true });
// ---------------------------------------------------------------- boot
(async function boot() {
  setLang(safeLS.get(LS.lang) || 'en');
  try {
    await loadBundle();
    await openURL({ state: history.state });
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
