// Malaybalay City Hall Kiosk — web prototype (mirrors the Figma kiosk screens K1–K13).
// Works offline from the last downloaded bundle; syncs when the server is reachable.
import { icon } from '../shared/icons.js';
import { t, setLang, getLang, direction } from '../shared/i18n.js';
import { planRouteCore } from '../shared/route-core.js';

const params = new URLSearchParams(location.search);
const KIOSK = params.get('kiosk') || 'KIOSK-LOBBY-1';
const APP_VERSION = 'web-0.1.0';
const IDLE_MS = Number(params.get('idle') ?? 60) * 1000; // ?idle=0 disables the reset (demos/testing)
const WARN_S = 15;
const LS = { bundle: 'kiosk.bundle', fbq: 'kiosk.feedbackQueue', lang: 'kiosk.lang' };

const stage = document.getElementById('stage');
// Screen layout: portrait 1080×1920 (default) or landscape 1920×1080.
//   /kiosk/landscape  or  /kiosk?layout=landscape   → landscape
//   /kiosk?layout=auto                               → follows the window shape
const LAYOUT_PARAM = params.get('layout') || (/\/landscape\/?$/.test(location.pathname) ? 'landscape' : 'portrait');
const layoutNow = () => LAYOUT_PARAM === 'auto' ? (innerWidth >= innerHeight ? 'landscape' : 'portrait') : LAYOUT_PARAM === 'landscape' ? 'landscape' : 'portrait';
const DIM = { portrait: [1080, 1920], landscape: [1920, 1080] };
const S = {
  bundle: null, online: true, savedAt: null, publicBase: location.origin,
  stack: [], query: '', kbMode: 'abc', filter: 'all', floorFilter: 'all', mapFloor: 1,
  nav: null, idleTimer: null, warnTimer: null, suggestTimer: null, lastSuggest: [],
};
const idx = { services: new Map(), offices: new Map(), rooms: new Map() };

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
function fit() {
  const mode = layoutNow();
  if (!stage.classList.contains(mode)) {
    stage.classList.remove('portrait', 'landscape'); stage.classList.add(mode);
    if (S.bundle) rerender();
  }
  const [w, h] = DIM[mode];
  const s = Math.min(window.innerWidth / w, window.innerHeight / h);
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;
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
  try { S.publicBase = (await api('/api/config')).public_base_url; } catch {}
}
async function syncLoop() {
  try {
    const { content_version } = await api('/api/kiosk/version');
    const wasOffline = !S.online;
    S.online = true;
    if (content_version !== S.bundle?.content_version) { await loadBundle(); if (current() === 'welcome' || wasOffline) rerender(); }
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
    <div class="seal" aria-hidden="true">CM</div>
    <div class="identity"><span class="caption">${t('city')}</span><span class="label">${t('kiosk_name')}</span></div>
    <div class="spacer"></div>
    <div class="seg" role="group" aria-label="${t('language')}">
      ${['en', 'fil', 'ceb'].map(x => `<button data-action="lang" data-lang="${x}" aria-pressed="${l === x}">${x.toUpperCase()}</button>`).join('')}
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
  return `<button class="row" data-action="${isOffice ? 'office' : 'service'}" data-id="${item.id}">
    <span class="tile">${icon(isOffice ? 'building' : 'file-text', 36)}</span>
    <span class="txt"><span class="title">${esc(item.title)}</span><span class="sub">${esc(item.subtitle || '')}</span></span>
    <span class="chev">${icon('chevron-right', 36)}</span></button>`;
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
    return `<section class="screen welcome" data-action="start" aria-label="${t('welcome_title')}">
      <img class="hero" src="/img/cityhall.svg" alt="">
      <div class="scrim"></div>
      <div class="top"><div class="seal" aria-hidden="true">CM</div><div class="identity"><span class="caption">${t('city')}</span><span class="label">New City Hall</span></div></div>
      <div class="panel">
        <h1 class="display">${t('welcome_title')}</h1>
        <p class="h3 gold">${t('welcome_sub')}</p>
        <p class="body">${t('welcome_body')}</p>
        <button class="cta" data-action="start">${icon('navigation', 48)}<span class="h2">${t('touch_start')}</span></button>
        <div class="langs chips" role="group" aria-label="${t('language')}">
          ${[['en', 'English'], ['fil', 'Filipino'], ['ceb', 'Cebuano']].map(([k, n]) => `<button data-action="lang" data-lang="${k}" aria-pressed="${l === k}">${n}</button>`).join('')}
        </div>
      </div></section>`;
  },

  home() {
    const pop = (S.bundle.popular_service_ids || []).map(id => idx.services.get(id)).filter(Boolean);
    return `<section class="screen">${topbar()}
      <div class="hero-band"><img src="/img/cityhall.svg" alt=""><div class="scrim"></div><h1 class="h1">${t('home_q')}</h1></div>
      <div class="content">
        <button class="searchfield" data-action="search">${icon('search', 40)}<span class="q">${t('search_placeholder')}</span></button>
        <div class="choices">
          ${[['search', 'file-text', 'find_service'], ['offices', 'building', 'browse_offices'], ['map', 'map', 'map_hall']].map(([a, ic, k]) => `
          <button class="choice" data-action="${a}"><span class="tile">${icon(ic, 44)}</span><span class="h3">${t(k)}</span><span class="caption muted">${t(k + '_d')}</span></button>`).join('')}
        </div>
        <h2 class="h3">${t('popular')}</h2>
        <div class="list">${pop.map(s => rowHTML({ kind: 'service', id: s.id, title: s.display_title, subtitle: `${s.office_name} · ${locText(s.location)}` })).join('')}</div>
      </div>${helpbar()}</section>`;
  },

  search() {
    const q = S.query;
    const sug = S.lastSuggest;
    return `<section class="screen">${topbar()}
      <div class="content search-layout" style="gap:20px">
        <div class="search-left">
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

  offices() {
    const f = S.floorFilter;
    const list = S.bundle.offices.filter(o => f === 'all' ? true : f === 'out' ? o.location_type !== 'in_building' || !o.location?.room_id : o.location?.floor_level === Number(f));
    return `<section class="screen">${topbar()}
      <div class="content" style="gap:24px">
        ${backBtn(t('home'))}
        <h1 class="h1">${t('offices_title')}</h1>
        <div class="chips" role="group">
          ${[['all', t('all_floors')], ...S.bundle.floors.filter(fl => S.bundle.offices.some(o => o.location?.floor_level === fl.level)).map(fl => [String(fl.level), fl.name]), ['out', t('not_in_building')]]
            .map(([k, l]) => `<button class="chip" data-action="floorfilter" data-f="${k}" aria-pressed="${f === k}">${esc(l)}</button>`).join('')}
        </div>
        <div class="list">${list.map(o => rowHTML({ kind: 'office', id: o.id, title: o.name, subtitle: `${locText(o.location)} · ${t('services_count', { n: o.service_count })}` })).join('')}</div>
      </div>${helpbar()}</section>`;
  },

  office({ id }) {
    const o = idx.offices.get(Number(id));
    if (!o) return screens.home();
    const svcs = S.bundle.services.filter(s => s.office_id === o.id);
    const inBuilding = o.location?.room_id;
    return `<section class="screen">${topbar()}
      <div class="content">
        ${backBtn()}
        <div class="cols"><div class="col">
        <h1 class="h1">${esc(o.name)}</h1>
        <div class="badges">${inBuilding ? `<span class="badge info">${icon('map-pin', 24)}${esc(locText(o.location))}</span>` : `<span class="badge offsite">${t(o.location_type === 'offsite' ? 'not_in_building' : 'location_unconfirmed')}</span>`}</div>
        <div class="card" style="display:grid;grid-template-columns:auto 1fr;gap:12px 20px;align-items:center">
          ${icon('clock', 32)}<span class="caption">${esc(o.hours || '')}</span>
          ${o.phone ? `${icon('phone', 32)}<span class="caption">${esc(o.phone)}</span>` : ''}
          ${o.offsite_address ? `${icon('map-pin', 32)}<span class="caption">${esc(o.offsite_address)}</span>` : ''}
        </div>
        ${inBuilding ? `<button class="btn btn-primary btn-block" data-action="navoffice" data-id="${o.id}">${icon('navigation', 36)}${t('show_way')}</button>` : ''}
        </div><div class="col">
        <h2 class="h3">${t('office_services')} (${svcs.length})</h2>
        <div class="list">${svcs.map(s => rowHTML({ kind: 'service', id: s.id, title: s.display_title, subtitle: s.classification || '' })).join('')}</div>
        </div></div>
      </div>${helpbar()}</section>`;
  },

  service({ id }) {
    const s = idx.services.get(Number(id));
    if (!s) return screens.home();
    if (S.online) fetch(`/api/services/${s.id}`).catch(() => {}); // view counter
    const verified = s.verified_at ? `<span class="badge success">${icon('circle-check', 24)}${t('verified_on', { d: new Date(s.verified_at).toLocaleDateString([], { month: 'short', year: 'numeric' }) })}</span>` : '';
    const inBuilding = s.location?.room_id;
    return `<section class="screen">${topbar()}
      <div class="content">
        <div class="crumb">${backBtn()}</div>
        <header style="display:flex;flex-direction:column;gap:16px">
          <h1 class="h1">${esc(s.display_title)}</h1>
          ${s.plain_title ? `<p class="caption muted">${esc(s.title)}</p>` : ''}
          ${s.description ? `<p class="body muted">${esc(s.description.length > 360 ? s.description.slice(0, 357) + '…' : s.description)}</p>` : ''}
          <div class="badges">
            <button class="badge ${inBuilding ? 'info' : 'offsite'}" data-action="office" data-id="${s.office_id}" style="border:0">${icon(inBuilding ? 'map-pin' : 'building', 24)}${esc(s.office_name)} · ${esc(locText(s.location))}</button>
            ${s.classification ? `<span class="badge neutral">${esc(s.classification)}</span>` : ''}${verified}
          </div>
        </header>
        <div class="cols">
        <div class="col">
        <div class="stats">
          ${[['wallet', 'total_fee', s.total_fees], ['clock', 'processing_time', s.total_processing_time], ['users', 'who_may_apply', s.who_may_avail]].map(([ic, k, v]) =>
            `<div class="stat"><span class="lbl">${icon(ic, 28)}${t(k)}</span><span class="val">${esc(v || '—')}</span></div>`).join('')}
        </div>
        ${s.requirements.length ? `<section class="card" style="padding:28px 32px 12px"><h2 class="h3">${t('what_to_bring')} (${s.requirements.length})</h2>
          ${s.requirements.map(r => `<div class="req"><span class="box" aria-hidden="true"></span><div><p class="label">${esc(r.requirement)}</p>${r.where_to_secure ? `<p class="caption muted">${esc(r.where_to_secure)}</p>` : ''}</div></div>`).join('')}
        </section>` : ''}
        </div>
        <div class="col">
        ${s.steps.length ? `<h2 class="h3">${t('what_youll_do')}</h2>
          <div class="list">${s.steps.map((st, i) => `<div class="step"><span class="num">${i + 1}</span><div style="flex:1;display:flex;flex-direction:column;gap:8px">
            ${st.client_action ? `<p class="label">${esc(st.client_action)}</p>` : ''}
            ${st.agency.length ? `<div class="agency">${st.agency.map(a => `<div><p class="caption muted">${esc(a.agency_action)}</p>
              <p class="caption meta">${[a.fee && `${t('total_fee').split(' ').pop()}: ${a.fee}`, a.processing_time, a.person_in_charge].filter(Boolean).map(esc).join(' · ')}</p></div>`).join('')}</div>` : ''}
          </div></div>`).join('')}</div>` : ''}
        <div class="helpful"><span class="label">${t('did_help')}</span><div class="btns">
          <button data-action="fb" data-v="1" data-id="${s.id}">${icon('thumbs-up', 32)}</button>
          <button data-action="fb" data-v="0" data-id="${s.id}">${icon('thumbs-down', 32)}</button></div></div>
        <p class="caption muted">${s.verified_at ? '' : t('not_verified') + ' · '}${t('from_charter', { src: esc(s.source || "Citizen's Charter") })}</p>
        </div></div>
      </div>
      <div class="dock">
        <button class="btn btn-secondary" data-action="qr" data-id="${s.id}">${icon('qr', 36)}${t('take_it')}</button>
        <button class="btn btn-primary" data-action="navservice" data-id="${s.id}">${icon('navigation', 36)}${t('show_way')}</button>
      </div></section>`;
  },

  offsite({ id }) {
    const o = idx.offices.get(Number(id));
    return `<section class="screen">${topbar()}
      <div class="content centered" style="align-items:center;text-align:center">
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
    return `<section class="screen">${topbar()}
      <div class="dest">${icon('map-pin', 44)}<div style="flex:1"><p class="h3">${t('navigating_to', { room: esc(S.nav.title) })}</p>
        <p class="caption">${t('walk_info', { room_code: r.to.room_code, floor: r.to.floor_name, d: r.distance_m, m: r.minutes })}</p></div></div>
      <div class="nav-body">
      <div class="viewport3d" id="vp">
        <div class="minimap" aria-label="Map">
          <div id="mm"></div>
          <div class="floorpick">${S.bundle.floors.map(f => `<button data-action="mmfloor" data-l="${f.level}" aria-pressed="false">${esc(f.name)}</button>`).join('')}</div>
        </div>
        <div class="controls">
          <button data-action="navpause" id="btn-pause">${icon('pause', 32)}<span>${t('pause')}</span></button>
          <button data-action="navreplay">${icon('replay', 32)}<span>${t('replay')}</span></button>
          <button data-action="navskip">${icon('skip', 32)}<span>${t('skip')}</span></button>
        </div>
      </div>
      <div class="directions">
        <div class="progress"><div id="prog"></div></div>
        <div id="dirs">${r.directions.map((d, i) => `<div class="dir" data-i="${i}"><span class="n">${d.kind === 'floor_change' ? icon('stairs', 28) : i + 1}</span><span class="label" style="font-weight:inherit">${esc(direction(d))}</span></div>`).join('')}</div>
        <div class="btn-row"><button class="btn btn-secondary" data-action="toggle2d">${icon('map', 32)}<span id="t2d">${t('view_2d')}</span></button><button class="btn btn-secondary" data-action="endnav">${t('end_nav')}</button></div>
      </div></div></section>`;
  },

  arrived() {
    const n = S.nav;
    const room = idx.rooms.get(n.route.to.room_id);
    const office = n.officeId ? idx.offices.get(n.officeId) : null;
    return `<section class="screen">${topbar()}
      <div class="content arrived-layout" style="align-items:center;text-align:center">
        <div class="card door" style="width:100%;padding:0;overflow:hidden">${doorIllustration(n.route.to.room_code, room?.name || '')}</div>
        <div class="arrived-info">
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
    const lvl = S.mapFloor;
    const fl = S.bundle.floors.find(f => f.level === lvl);
    return `<section class="screen">${topbar()}
      <div class="content">
        ${backBtn(t('home'))}
        <h1 class="h1">${t('map_hall')}</h1>
        <div class="cols map-cols"><div class="col">
        <div class="chips">${S.bundle.floors.map(f => `<button class="chip" data-action="mapfloor" data-l="${f.level}" aria-pressed="${f.level === lvl}">${esc(f.name)}</button>`).join('')}</div>
        ${floorSVG(fl, { interactive: true, you: S.bundle.kiosk.floor_level === lvl ? S.bundle.kiosk : null })}
        </div><div class="col">
        <div class="list">${fl.rooms.filter(r => r.room_type === 'office' || r.occupant).map(r => {
          const off = S.bundle.offices.find(o => o.location?.room_id === r.id);
          return rowHTML({ kind: 'office', id: off?.id ?? '', title: off?.name || r.name, subtitle: r.code });
        }).join('')}</div>
        </div></div>
      </div>${helpbar()}</section>`;
  },
};

function doorIllustration(code, name) {
  return `<svg viewBox="0 0 1000 420" width="100%" role="img" aria-label="${esc(code)}"><rect width="1000" height="420" fill="#F4F1EA"/><rect y="330" width="1000" height="90" fill="#C98F6C"/>
  <rect x="380" y="70" width="240" height="260" fill="#23415F"/><rect x="396" y="86" width="208" height="244" fill="#2E5578"/><circle cx="584" cy="210" r="9" fill="#D9A520"/>
  <rect x="340" y="18" width="320" height="44" rx="8" fill="#12355B"/><text x="500" y="48" fill="#fff" font-size="24" font-weight="700" text-anchor="middle" font-family="sans-serif">${esc(code)}</text>
  <rect x="140" y="110" width="140" height="160" fill="#DCE9F5"/><rect x="720" y="110" width="140" height="160" fill="#DCE9F5"/>
  <text x="500" y="395" fill="#1B2430" font-size="22" text-anchor="middle" font-family="sans-serif">Replace with a photo of ${esc(name).slice(0, 48)}</text></svg>`;
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
  return `<svg class="mapsvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(fl.name)}">
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
      <button class="key wide" data-action="kbdel" aria-label="${t('kb_delete')}">${icon('backspace', 36)}</button>
      <button class="key wide primary" data-action="kbsearch">${icon('search', 32)}&nbsp;${t('kb_search')}</button>
    </div></div>`;
}

// ---------------------------------------------------------------- router
function current() { return S.stack[S.stack.length - 1]?.name || 'welcome'; }
function go(name, p = {}, { replace = false } = {}) {
  if (S.nav?.ctrl && name !== 'navigate') { S.nav.ctrl.dispose(); S.nav.ctrl = null; }
  if (replace) S.stack.pop();
  S.stack.push({ name, p });
  rerender();
}
function back() {
  if (S.stack.length > 1) { S.stack.pop(); const top = S.stack[S.stack.length - 1]; S.stack.pop(); go(top.name, top.p); }
  else go('home');
}
function rerender() {
  const { name, p } = S.stack[S.stack.length - 1] || { name: 'welcome', p: {} };
  if (name !== 'navigate' && S.nav?.ctrl) { S.nav.ctrl.dispose(); S.nav.ctrl = null; }
  const overlays = [...stage.querySelectorAll('.overlay')];
  stage.innerHTML = (screens[name] || screens.home)(p);
  overlays.forEach(o => stage.appendChild(o));
  if (name === 'navigate') startNav();
  if (name === 'search') { /* suggestions update in place */ }
  const content = stage.querySelector('.content'); if (content) content.scrollTop = 0;
}
function resetToWelcome() {
  S.stack = []; S.query = ''; S.results = null; S.filter = 'all'; S.floorFilter = 'all'; S.lastSuggest = [];
  stage.classList.remove('large'); setLang(safeLS.get(LS.lang) || 'en');
  stage.querySelectorAll('.overlay').forEach(o => o.remove());
  go('welcome');
}

// ---------------------------------------------------------------- navigation (route + 3D)
function routeTo(roomId, title, { serviceId = null, officeId = null } = {}) {
  const room = idx.rooms.get(roomId);
  if (!room) return;
  const rooms = S.bundle.floors.flatMap(f => f.rooms.map(r => ({ ...r, floor_level: f.level })));
  const route = planRouteCore({ kiosk: S.bundle.kiosk, room, floors: S.bundle.floors, rooms, corridorZ: Number(S.bundle.settings.corridor_z || 16) });
  S.nav = { route, title, serviceId, officeId, ctrl: null, mode: '3d', step: 0 };
  if (S.online) fetch(`/api/route?room_id=${roomId}&kiosk=${encodeURIComponent(KIOSK)}`).catch(() => {}); // usage log
  go('navigate');
}
function navigateToOffice(officeId, serviceId = null) {
  const o = idx.offices.get(Number(officeId));
  if (!o?.location?.room_id) return go('offsite', { id: officeId });
  routeTo(o.location.room_id, o.name, { serviceId, officeId: o.id });
}
async function startNav() {
  const vp = $('#vp');
  updateMinimap(S.nav.route.waypoints[0]);
  const onProgress = (frac, pos, legIndex) => {
    const bar = $('#prog'); if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
    updateMinimap(pos);
    stage.querySelectorAll('.dir').forEach((el, i) => { el.classList.toggle('on', i === legIndex); el.classList.toggle('done', i < legIndex); });
  };
  const onArrive = () => setTimeout(() => { if (current() === 'navigate') go('arrived', {}, { replace: true }); }, 1400);
  if (S.nav.mode === '2d') { animate2D(onProgress, onArrive); return; }
  try {
    const { createNav3D } = await import('./nav3d.js');
    if (current() !== 'navigate') return;
    S.nav.ctrl = createNav3D(vp, S.bundle, S.nav.route, { onProgress, onArrive });
  } catch (e) {
    console.warn('3D unavailable, using 2D map', e);
    S.nav.mode = '2d'; animate2D(onProgress, onArrive);
  }
}
function updateMinimap(pos) {
  const mm = $('#mm'); if (!mm || !pos) return;
  const fl = S.bundle.floors.find(f => f.level === (S.nav.mmFloor ?? pos.floor)) || S.bundle.floors[0];
  if (mm.dataset.floor !== String(fl.level)) {
    mm.innerHTML = floorSVG(fl, { route: S.nav.route, you: S.bundle.kiosk.floor_level === fl.level ? S.bundle.kiosk : null, target: S.nav.route.to.room_id, small: true });
    mm.dataset.floor = String(fl.level);
    stage.querySelectorAll('[data-action="mmfloor"]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.l) === fl.level)));
  }
  const svg = mm.querySelector('svg'), w = mm.querySelector('#walker2d');
  if (svg && w && pos.floor === fl.level) {
    const sc = 1000 / (fl.bounds_max_x - fl.bounds_min_x), H = (fl.bounds_max_z - fl.bounds_min_z) * sc;
    w.setAttribute('cx', (pos.x - fl.bounds_min_x) * sc); w.setAttribute('cy', H - (pos.z - fl.bounds_min_z) * sc);
  } else if (w) { w.setAttribute('cx', -50); }
}
// 2D fallback animation (no WebGL, or the visitor chose 2D)
function animate2D(onProgress, onArrive) {
  const vp = $('#vp'); if (!vp) return;
  const fl = () => S.bundle.floors.find(f => f.level === cur.floor);
  const pts = S.nav.route.waypoints;
  let seg = 0, t0 = performance.now(), cur = { ...pts[0] };
  let holder = vp.querySelector('.big2d');
  if (!holder) { holder = document.createElement('div'); holder.className = 'big2d'; holder.style.cssText = 'position:absolute;inset:24px 390px 130px 24px;display:grid;place-items:center'; vp.prepend(holder); }
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.z - pts[i].z) + Math.abs(p.y - pts[i].y));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const speed = 8; // m/s preview speed
  const ctrl = { paused: false, dispose() { cancelAnimationFrame(raf); holder.remove(); }, pause() { this.paused = !this.paused; t0 = performance.now() - done / speed * 1000; return this.paused; }, replay() { done = 0; t0 = performance.now(); this.paused = false; }, skip() { done = total; } };
  let done = 0, raf, lastFloor = null;
  S.nav.ctrl = ctrl;
  const tick = now => {
    if (!ctrl.paused) done = Math.min(total, (now - t0) / 1000 * speed);
    let acc = 0; seg = 0;
    while (seg < lens.length - 1 && acc + lens[seg] < done) { acc += lens[seg]; seg++; }
    const f = lens[seg] ? (done - acc) / lens[seg] : 1, a = pts[seg], b = pts[seg + 1] || a;
    cur = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, floor: f < .5 ? a.floor : b.floor };
    if (lastFloor !== cur.floor) { holder.innerHTML = floorSVG(fl(), { route: S.nav.route, you: S.bundle.kiosk.floor_level === cur.floor ? S.bundle.kiosk : null, target: S.nav.route.to.room_id }); lastFloor = cur.floor; }
    const flr = fl(), sc = 1000 / (flr.bounds_max_x - flr.bounds_min_x), H = (flr.bounds_max_z - flr.bounds_min_z) * sc;
    const w = holder.querySelector('#walker2d'); if (w) { w.setAttribute('cx', (cur.x - flr.bounds_min_x) * sc); w.setAttribute('cy', H - (cur.z - flr.bounds_min_z) * sc); }
    const legIndex = S.nav.route.directions.findIndex(d => d.point_index > seg + (f >= 1 ? 1 : 0));
    onProgress(done / total, cur, legIndex === -1 ? S.nav.route.directions.length - 1 : legIndex);
    if (done >= total) { onArrive(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
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
  const url = `${S.publicBase}/m/service/${id}`;
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
  slip.innerHTML = `<b>${esc(t('city'))} · City Hall</b><hr><b>${esc(s.display_title)}</b><br>${esc(s.office_name)} — ${esc(locText(s.location))}<br>
    ${esc(t('total_fee'))}: ${esc(s.total_fees || '-')}<br>${esc(t('processing_time'))}: ${esc(s.total_processing_time || '-')}<hr>
    <b>${esc(t('what_to_bring'))}</b><br>${s.requirements.map(r => `[ ] ${esc(r.requirement)}`).join('<br>')}<hr>${esc(s.source || '')}<br>${new Date().toLocaleString()}`;
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
  maproom: d => { const off = S.bundle.offices.find(o => o.location?.room_id === Number(d.id)); if (off) go('office', { id: off.id }); else { const r = idx.rooms.get(Number(d.id)); routeTo(r.id, r.name); } },
  office: d => { if (d.id) go('office', { id: d.id }); },
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
  navpause: () => { const p = S.nav?.ctrl?.pause(); const b = $('#btn-pause'); if (b) b.innerHTML = p ? `${icon('play', 32)}<span>${t('resume')}</span>` : `${icon('pause', 32)}<span>${t('pause')}</span>`; },
  navreplay: () => S.nav?.ctrl?.replay(),
  navskip: () => S.nav?.ctrl?.skip(),
  endnav: () => { back(); },
  toggle2d: () => { S.nav.mode = S.nav.mode === '3d' ? '2d' : '3d'; S.nav.ctrl?.dispose(); S.nav.ctrl = null; go('navigate', {}, { replace: true }); const l = $('#t2d'); if (l) l.textContent = S.nav.mode === '3d' ? t('view_2d') : t('view_3d'); },
  mmfloor: d => { S.nav.mmFloor = Number(d.l); const mm = $('#mm'); if (mm) mm.dataset.floor = ''; updateMinimap({ ...S.nav.route.waypoints[0], floor: -1 }); },
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
  setInterval(syncLoop, 60_000);
  setTimeout(syncLoop, 5_000);
})();
window.addEventListener('error', () => { /* never leave a blank screen */ if (!stage.children.length) location.reload(); });
