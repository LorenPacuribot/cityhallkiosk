// Phone page — what the visitor gets after scanning the QR code on the kiosk.
// /m/service/:id  → requirements checklist (saved on the phone), steps, where to go.
// /m              → search.
import { icon } from '/shared/icons.js';
import { routeFloorSVG } from '/shared/route-map.js';
import { loadPlans, planFor } from '/shared/plans.js';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Charter notes: plain lines become paragraphs; runs of "a | b | c" lines (fee schedules) become a table.
function notesHTML(notes) {
  const out = []; let rows = [];
  const flush = () => { if (rows.length) out.push(`<div class="note-table"><table>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`); rows = []; };
  for (const line of String(notes).split('\n')) {
    if (line.includes(' | ')) rows.push(line.split(' | '));
    else { flush(); out.push(`<p class="small">${esc(line)}</p>`); }
  }
  flush();
  return out.join('');
}
const app = document.getElementById('app');
const store = { get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };

const header = (back = false) => `<header class="top">${back ? `<a href="/m" class="back" aria-label="Search">${icon('arrow-left', 22)}</a>` : ''}
  <a href="/m" class="brand-home" aria-label="Home"><img class="seal" src="/img/malaybalay-seal.jpg" alt="Official seal of the City of Malaybalay"><div><b>Malaybalay City Hall</b><small>Self-service kiosk</small></div></a></header>`;

async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Not found'); return r.json(); }

// ------------------------------------------------------------ service page
async function servicePage(id) {
  const s = await getJSON(`/api/services/${id}`);
  document.title = `${s.display_title} — Malaybalay City Hall`;
  const key = `chk:${s.id}`; const done = new Set(store.get(key) || []);
  const loc = s.location;
  // QR context from the kiosk: origin kiosk, step-free preference, the room and versions when the code was made
  const q = new URLSearchParams(location.search);
  const origin = q.get('k'), stepFree = q.get('p') === 'sf', qrRoom = Number(q.get('r')) || null;
  const moved = qrRoom && loc?.room_id !== qrRoom;
  let floor = null, route = null, nav = null, plans = null;
  if (loc?.room_id) {
    // directions follow the office's CURRENT room; without an origin kiosk there is no "from" — never assume the lobby
    [floor, route, nav] = await Promise.all([
      getJSON('/api/floors').then(d => d.items.find(f => f.id === loc.floor_id)).catch(() => null),
      origin ? fetch(`/api/route?office_id=${s.office_id}&kiosk=${encodeURIComponent(origin)}${stepFree ? '&preference=step_free' : ''}&log=0`).then(r => r.json()).catch(() => null) : null,
      getJSON('/api/navigation').catch(() => null),
    ]);
    plans = await loadPlans(nav);
  }
  app.innerHTML = `${header(true)}<main>
    <h1>${esc(s.display_title)}</h1>
    ${s.plain_title && s.plain_title !== s.title ? `<p class="muted small">${esc(s.title)}</p>` : ''}
    <a class="where" href="#where">${icon('map-pin', 20)}<span><b>${esc(s.office_name)}</b><br>${loc?.room_code ? `${esc(loc.floor_name)} · Room ${esc(loc.room_code)}` : loc?.type === 'offsite' ? esc(loc.offsite_address || 'Outside City Hall') : 'Ask at the information desk'}</span></a>
    <div class="stats"><div>${icon('wallet', 18)}<small>Fee</small><b>${esc(s.total_fees || '—')}</b></div><div>${icon('clock', 18)}<small>Time</small><b>${esc(s.total_processing_time || '—')}</b></div></div>
    ${s.who_may_avail ? `<p class="small"><b>Who may apply:</b> ${esc(s.who_may_avail)}</p>` : ''}

    <section><h2>What to bring <span class="count" id="cnt"></span></h2>
      <p class="muted small">Tick each one as you prepare it. This list stays on your phone.</p>
      <ul class="check">${s.requirements.map(r => `<li><label><input type="checkbox" data-r="${r.id}" ${done.has(r.id) ? 'checked' : ''}><span><b>${esc(r.requirement)}</b>${r.where_to_secure ? `<small>Get it from: ${esc(r.where_to_secure)}</small>` : ''}</span></label></li>`).join('') || '<li class="muted">No documents needed.</li>'}</ul>
    </section>

    <section><h2>What you’ll do</h2><ol class="steps">${s.steps.map(st => `<li><b>${esc(st.client_action)}</b>${st.agency.map(a => `<small>${esc(a.agency_action)}${a.processing_time ? ` · ${esc(a.processing_time.replace(/\n/g, ', '))}` : ''}${a.fee && !/^none$/i.test(a.fee) ? ` · ${esc(a.fee.replace(/\n/g, ', '))}` : ''}</small>`).join('')}</li>`).join('')}</ol></section>

    ${s.notes ? `<section><h2>Notes and fees</h2>${notesHTML(s.notes)}</section>` : ''}

    <section id="where"><h2>How to get there</h2>
      ${moved ? `<p class="notice">This office has moved since the code was made. The directions below are for where it is now: <b>${esc(loc.floor_name)} · Room ${esc(loc.room_code)}</b>.</p>` : ''}
      ${whereHTML({ loc, floor, route, nav, origin, stepFree, plans })}
    </section>

    <section class="contact">${s.office_phone ? `<a class="btn" href="tel:${esc(s.office_phone.replace(/[^\d+]/g, ''))}">${icon('phone', 18)}Call ${esc(s.office_phone)}</a>` : ''}<p class="muted small">${esc(s.office_hours || '')}</p></section>

    <section class="fb" id="fb"><h2>Was this helpful?</h2><div class="row"><button class="btn" data-h="1">${icon('thumbs-up', 18)}Yes</button><button class="btn" data-h="0">${icon('thumbs-down', 18)}No</button></div></section>
    <p class="muted small">Source: ${esc(s.source || 'Citizen’s Charter')}${s.verified_at ? ` · checked by the office ${new Date(s.verified_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-PH')}` : ''}. Fees and requirements can change — the office has the final say.</p>
  </main>`;
  const count = () => { $('#cnt').textContent = s.requirements.length ? `${done.size}/${s.requirements.length}` : ''; };
  count();
  app.addEventListener('change', e => { const c = e.target.closest('[data-r]'); if (!c) return; const r = Number(c.dataset.r); c.checked ? done.add(r) : done.delete(r); store.set(key, [...done]); count(); });
  $('#fb').addEventListener('click', async e => {
    const b = e.target.closest('[data-h]'); if (!b) return;
    const helpful = Number(b.dataset.h);
    if (!helpful) { $('#fb').innerHTML = `<h2>What was wrong?</h2><div class="row wrap">${[['unclear', 'Hard to understand'], ['wrong_info', 'Information is wrong'], ['not_found', 'Couldn’t find the office'], ['other', 'Something else']].map(([k, l]) => `<button class="btn" data-reason="${k}">${l}</button>`).join('')}</div>`; return; }
    await send(1, null);
  });
  $('#fb').addEventListener('click', async e => { const b = e.target.closest('[data-reason]'); if (b) await send(0, b.dataset.reason); });
  async function send(helpful, reason) {
    await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service_id: s.id, helpful, reason, kiosk_code: 'PHONE' }) }).catch(() => {});
    $('#fb').innerHTML = `<p><b>Salamat!</b> Thank you — the office will see this.</p>`;
  }
}

const REASONS = {
  UNVERIFIED_DESTINATION: 'Step-by-step directions to this office have not been checked on site yet.',
  UNVERIFIED_ROUTE: 'The way to this office has not been checked on site yet.',
  NO_STEP_FREE_ROUTE: 'There is no checked step-free way to this office.',
  ROUTE_CLOSED: 'The way to this office is closed right now.',
  UNKNOWN_KIOSK: 'The kiosk this code came from is not set up for directions.',
};
function whereHTML({ loc, floor, route, nav, origin, stepFree, plans }) {
  if (!loc?.room_id) return `<p>${loc?.type === 'offsite' ? `This office is <b>not inside City Hall</b>: ${esc(loc.offsite_address || 'ask the information desk for the address')}.` : 'The room is not confirmed yet. Please ask at the information desk.'}</p>`;
  const place = `<p><b>${esc(loc.floor_name)} · Room ${esc(loc.room_code)}</b></p>`;
  if (!origin) return `${place}<p class="muted small">Scan the code on a City Hall kiosk to get step-by-step directions from where you are standing.</p>`;
  if (!route || route.status !== 'ok') return `${place}<p>${esc(REASONS[route?.reason] || 'Directions are not available right now.')} Please ask at the information desk.</p>`;
  const pref = stepFree ? ' · avoiding stairs' : '';
  const dirs = `<ol class="dirs">${route.directions.map(d => `<li>${esc(d.text)}</li>`).join('')}</ol>`;
  if (route.routeSource === 'navigation_graph' && nav?.graph) {
    // one map per floor the route uses: the real floor plan when it was drawn with the published calibration (an
    // unverified calibration only for a route that is itself labelled draft), else the published walkable network
    const cal = nav.calibration, planOK = !!plans && plans.calibrationVersion === cal?.calibrationVersion && (cal.status === 'verified' || route.verification !== 'verified');
    const maps = route.floors_used.map(l => `<figure class="plan-fig"><figcaption>${esc(nav.graph.floors.find(f => f.level === l)?.name || `Floor ${l}`)}</figcaption>${routeFloorSVG({ graph: nav.graph, route, level: l, labels: { you: 'Kiosk' }, plan: planOK ? planFor(plans, l) : null })}</figure>`).join('');
    const draft = route.verification !== 'verified' ? '<p class="notice">Draft route: not yet checked on site. Please confirm at the information desk.</p>' : '';
    return `${place}${draft}${maps}${dirs}<p class="muted small">From kiosk ${esc(origin)}${pref} · about ${route.distance_m} m · map version ${esc(route.navigationVersion || '')}.</p>`;
  }
  return `${place}${floor ? planSVG(floor, loc.room_id, route) : ''}${dirs}<p class="muted small">Sample route on a placeholder map, not the real building. From kiosk ${esc(origin)}${pref}.</p>`;
}

function planSVG(fl, roomId, route) {
  const W = fl.bounds_max_x - fl.bounds_min_x, D = fl.bounds_max_z - fl.bounds_min_z;
  const X = x => x - fl.bounds_min_x, Y = z => fl.bounds_max_z - z;
  const rooms = fl.rooms.filter(r => r.is_active).map(r => {
    const rot = Math.round(((r.facing_deg || 0) % 180 + 180) % 180) === 90; const w = rot ? r.depth_m : r.width_m, d = rot ? r.width_m : r.depth_m;
    const hit = r.id === roomId;
    return `<rect x="${X(r.x) - w / 2}" y="${Y(r.z) - d / 2}" width="${w}" height="${d}" rx=".5" fill="${hit ? '#B8432F' : r.room_type === 'office' ? '#C9E0F8' : r.room_type === 'stairs' ? '#F6E3B0' : '#FFFFFF'}" stroke="#12355B" stroke-width=".15"/>
      <text x="${X(r.x)}" y="${Y(r.z) + .6}" font-size="${hit ? 2 : 1.5}" text-anchor="middle" fill="${hit ? '#fff' : '#12355B'}" font-weight="700">${esc(r.code)}</text>`;
  }).join('');
  const pts = (route?.waypoints || []).filter(p => p.floor === fl.level).map(p => `${X(p.x)},${Y(p.z)}`).join(' ');
  return `<svg class="plan" viewBox="-1 -1 ${W + 2} ${D + 2}" role="img" aria-label="${esc(fl.name)} plan with your destination highlighted">
    <rect x="0" y="0" width="${W}" height="${D}" fill="#F3EFE8" rx="1"/>${rooms}
    ${pts ? `<polyline points="${pts}" fill="none" stroke="#1A63BE" stroke-width=".7" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1.5 1"/>` : ''}
    <text x="${X(0)}" y="${D + .6}" font-size="1.4" text-anchor="middle" fill="#5A6472">Main entrance</text></svg>`;
}

// ------------------------------------------------------------ search page
function searchPage() {
  app.innerHTML = `${header()}<main><h1>What do you need?</h1>
    <label class="search">${icon('search', 22)}<input id="q" type="search" placeholder="e.g. cedula, birth certificate, business permit" aria-label="Search services" autofocus></label>
    <ul class="results" id="res"></ul></main>`;
  let t;
  $('#q').addEventListener('input', e => { clearTimeout(t); t = setTimeout(async () => {
    const q = e.target.value.trim(); if (q.length < 2) { $('#res').innerHTML = ''; return; }
    const d = await getJSON(`/api/search?q=${encodeURIComponent(q)}&kiosk=PHONE`).catch(() => ({ results: [] }));
    $('#res').innerHTML = d.results.filter(r => r.kind === 'service').map(r => `<li><a href="/m/service/${r.id}"><b>${esc(r.title)}</b><small>${esc(r.subtitle || '')}</small></a></li>`).join('') || '<li class="muted">No match. Try another word or ask the information desk.</li>';
  }, 300); });
}

// ------------------------------------------------------------ router
const m = location.pathname.match(/^\/m\/service\/(\d+)/);
(m ? servicePage(Number(m[1])) : Promise.resolve(searchPage())).catch(e => {
  app.innerHTML = `${header(true)}<main><h1>Sorry</h1><p>${esc(e.message)}. The service may have been updated — please search again.</p><a class="btn" href="/m">Search services</a></main>`;
});
