// Admin panel SPA — content management for the City Hall kiosk.
// Everything here writes to the same SQLite database the kiosk and phone read from;
// each save bumps the content version so kiosks pick it up on their next sync (≤ 60 s).
import { icon } from '/shared/icons.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const root = document.getElementById('root');
const ROLES = ['viewer', 'office_editor', 'lgu_admin', 'system_admin'];
const ROLE_LABEL = { viewer: 'Viewer', office_editor: 'Office editor', lgu_admin: 'LGU admin', system_admin: 'System admin' };
const ROOM_TYPES = ['office', 'hall', 'entrance', 'info_desk', 'stairs', 'elevator', 'ramp', 'toilet', 'other']; // must match the CHECK in schema.sql
const S = { me: null, offices: [], floors: [], pending: 0, roomFloor: 1, selRoom: null };

// ------------------------------------------------------------------ helpers
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/login') { S.me = null; renderLogin(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg, bad = false) {
  const el = document.createElement('div'); el.className = `toast${bad ? ' bad' : ''}`; el.setAttribute('role', 'status'); el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3200);
}
const can = min => S.me && ROLES.indexOf(S.me.role) >= ROLES.indexOf(min);
const isAdmin = () => can('lgu_admin');
const when = d => d ? new Date(d.replace(' ', 'T') + (d.includes('Z') || d.includes('+') ? '' : 'Z')).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const ago = d => { if (!d) return 'never'; const s = (Date.now() - new Date(d.replace(' ', 'T') + 'Z')) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
const formData = form => Object.fromEntries(new FormData(form).entries());
function modal(html, onMount) {
  const el = document.createElement('div'); el.className = 'modal';
  el.innerHTML = `<div class="card" role="dialog" aria-modal="true">${html}</div>`;
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) el.remove(); });
  document.body.appendChild(el); el.querySelector('input,select,textarea,button')?.focus();
  onMount?.(el); return el;
}
const coordBadge = s => s === 'unity_sync' ? '<span class="badge ok">Imported</span>' : s === 'manual' ? '<span class="badge info">Manual</span>' : '<span class="badge warn">Placeholder</span>';
const statusBadge = s => s === 'published' ? '<span class="badge ok">Published</span>' : s === 'draft' ? '<span class="badge">Draft</span>' : `<span class="badge bad">${esc(s)}</span>`;
const officeOptions = (sel, { blank = false } = {}) => (blank ? '<option value="">—</option>' : '') + S.offices.map(o => `<option value="${o.id}" ${Number(sel) === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('');

// ------------------------------------------------------------------ auth
function renderLogin(msg = '') {
  root.innerHTML = `<div class="login"><form class="card" id="login" autocomplete="on">
    <div class="row"><img class="seal" src="/img/malaybalay-seal.jpg" alt="Official seal of the City of Malaybalay"><div><b>Malaybalay City Hall</b><div class="muted small">Kiosk admin panel</div></div></div>
    <h1 style="font-size:22px;margin:8px 0 0">Sign in</h1>
    ${msg ? `<div class="notice bad" role="alert">${icon('alert', 18)}<span>${esc(msg)}</span></div>` : ''}
    <label class="f">Email<input name="email" type="email" required autocomplete="username" value="admin@kiosk.local"></label>
    <label class="f">Password<input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn primary" style="justify-content:center">Sign in</button>
    <p class="muted small" style="margin:0">Prototype accounts use the password <code>ChangeMe!2026</code>. Change them before going live.</p>
  </form></div>`;
  $('#login').addEventListener('submit', async e => {
    e.preventDefault();
    try { const r = await api('/api/auth/login', { method: 'POST', body: formData(e.target) }); S.me = r.user; await boot(); }
    catch (err) { renderLogin(err.message); }
  });
}
async function logout() { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); S.me = null; location.hash = ''; renderLogin(); }

// ------------------------------------------------------------------ shell
const NAV = [
  ['dashboard', 'Dashboard', 'chart', 'viewer'],
  ['services', 'Services', 'file-text', 'viewer'],
  ['approvals', 'Approvals', 'check', 'lgu_admin'],
  ['offices', 'Offices', 'building', 'viewer'],
  ['assignments', 'Room assignments', 'move', 'viewer'],
  ['rooms', 'Floors & rooms', 'map', 'viewer'],
  ['kiosks', 'Kiosks', 'monitor', 'viewer'],
  ['navigation', 'Navigation', 'map', 'viewer'],
  ['announcements', 'Announcements', 'megaphone', 'viewer'],
  ['feedback', 'Feedback', 'message', 'viewer'],
  ['searches', 'Search insights', 'search', 'viewer'],
  ['users', 'Users', 'users', 'lgu_admin'],
  ['audit', 'Audit log', 'history', 'lgu_admin'],
];
function shell(active, inner) {
  root.innerHTML = `<div class="app">
    <aside class="side"><a class="brand" href="#/dashboard" aria-label="Dashboard"><img class="seal" src="/img/malaybalay-seal.jpg" alt="Official seal of the City of Malaybalay"><div><b>Malaybalay City Hall</b><small>Kiosk admin</small></div></a>
      <nav class="nav" aria-label="Sections">${NAV.filter(n => can(n[3])).map(([k, label, ic]) =>
        `<a href="#/${k}" class="${active === k ? 'on' : ''}" ${active === k ? 'aria-current="page"' : ''}>${icon(ic, 18)}${label}${k === 'approvals' && S.pending ? `<span class="count">${S.pending}</span>` : ''}</a>`).join('')}
        <h6>Open</h6>
        <a href="/kiosk" target="_blank">${icon('monitor', 18)}Kiosk screen</a>
      </nav>
      <div class="me"><b>${esc(S.me.name)}</b><div class="small" style="opacity:.8">${ROLE_LABEL[S.me.role]}${S.me.office ? ` · ${esc(S.me.office.name)}` : ''}</div>
        <button data-act="logout">${icon('logout', 16)}Sign out</button></div>
    </aside>
    <main id="main">${inner}</main></div>`;
}
document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  const fn = ACTIONS[a.dataset.act]; if (fn) { e.preventDefault(); fn(a, e); }
});
const ACTIONS = { logout };

// ------------------------------------------------------------------ pages
const PAGES = {};

PAGES.dashboard = async () => {
  const d = await api('/api/admin/dashboard');
  const h = d.helpful_30d || {}; const pct = h.total ? Math.round(100 * (h.yes || 0) / h.total) : null;
  const hours = Array.from({ length: 24 }, (_, i) => i).map(hr => ({ hr, n: d.sessions_by_hour.find(x => x.hour === hr)?.n || 0 }));
  const max = Math.max(1, ...hours.map(x => x.n));
  shell('dashboard', `<div class="head"><h1>Dashboard</h1><a class="btn primary" href="#/assignments">${icon('move', 18)}Change room assignments</a><span class="badge info">Content version ${d.content_version}</span></div>
    <div class="grid g4">
      <div class="card stat"><small>Kiosk sessions today</small><b>${d.sessions_today}</b><span class="hint">${d.searches_today} searches</span></div>
      <div class="card stat"><small>Found it helpful (30 days)</small><b>${pct === null ? '—' : pct + '%'}</b><span class="hint">${h.total || 0} answers</span></div>
      <div class="card stat"><small>Searches with no result (7 days)</small><b>${d.no_result_7d}</b><span class="hint"><a href="#/searches">Fix them →</a></span></div>
      <div class="card stat"><small>Services published</small><b>${d.services.published}</b><span class="hint">${d.services.pending || 0} waiting · ${d.services.needs_review || 0} need review</span></div>
    </div>
    ${d.services.needs_review ? `<div class="notice warn" style="margin-top:16px">${icon('alert', 18)}<span><b>${d.services.needs_review} services</b> were imported from the Citizen’s Charter with low confidence. Each office should check them. <a href="#/services?status=needs_review">Review list →</a></span></div>` : ''}
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h2>Sessions by hour (today)</h2><div class="bars" aria-label="Sessions by hour">${hours.map(x => `<div style="height:${Math.round(100 * x.n / max)}%" title="${x.hr}:00 — ${x.n}">${x.hr % 3 === 0 ? `<span>${x.hr}</span>` : ''}</div>`).join('')}</div><div style="height:18px"></div></div>
      <div class="card"><h2>Kiosks</h2><table class="tbl"><tbody>${d.kiosks.map(k => `<tr><td><b>${esc(k.name)}</b><div class="muted small">${esc(k.code)}</div></td><td>${k.status === 'online' ? '<span class="badge ok">Online</span>' : '<span class="badge bad">Offline</span>'}</td><td class="small muted">Last seen ${ago(k.last_heartbeat)}<br>Content v${k.content_version ?? '—'}</td></tr>`).join('') || '<tr><td class="muted">No kiosks yet.</td></tr>'}</tbody></table></div>
      <div class="card"><h2>Most viewed services</h2><table class="tbl"><tbody>${d.top_services.map(s => `<tr class="click" data-href="#/services/${s.id}"><td>${esc(s.title)}</td><td class="num">${s.view_count}</td></tr>`).join('') || '<tr><td class="muted">No views yet — open the kiosk and look up a service.</td></tr>'}</tbody></table></div>
      <div class="card"><h2>What people searched but didn’t find</h2><table class="tbl"><tbody>${d.no_result_queries.map(q => `<tr><td>“${esc(q.query)}”</td><td class="num">${q.n}×</td></tr>`).join('') || '<tr><td class="muted">Nothing yet.</td></tr>'}</tbody></table></div>
    </div>
    <div class="card" style="margin-top:16px"><h2>Recent feedback</h2><table class="tbl"><tbody>${d.recent_feedback.map(f => `<tr><td>${f.helpful ? '<span class="badge ok">Helpful</span>' : '<span class="badge bad">Not helpful</span>'}</td><td>${esc(f.service || '—')}</td><td class="muted">${esc(f.reason || '')} ${esc(f.comment || '')}</td><td class="small muted">${ago(f.created_at)}</td></tr>`).join('') || '<tr><td class="muted">No feedback yet.</td></tr>'}</tbody></table></div>`);
};
document.addEventListener('click', e => { const tr = e.target.closest('tr[data-href]'); if (tr && !e.target.closest('button,a,input,select')) location.hash = tr.dataset.href; });

// ---------------- services
PAGES.services = async (id, qs) => {
  if (id) return serviceEditor(id);
  const q = new URLSearchParams(qs);
  if (!q.has('office_id') && S.me.role === 'office_editor' && S.me.office_id && !q.has('all')) q.set('office_id', S.me.office_id);
  const page = Number(q.get('page') || 1);
  const d = await api(`/api/admin/services?${q}&size=25`);
  const set = (k, v) => { const n = new URLSearchParams(q); v ? n.set(k, v) : n.delete(k); n.delete('page'); return `#/services?${n}`; };
  shell('services', `<div class="head"><h1>Services</h1>${can('office_editor') ? `<a class="btn primary" href="#/services/new">${icon('plus', 18)}Add service</a>` : ''}</div>
    <p class="sub">${d.total} services. Imported from the Citizen’s Charter 2023 — each office owns and verifies its own.</p>
    <div class="card"><form class="toolbar" id="sf">
      <input name="q" placeholder="Search title or office" value="${esc(q.get('q') || '')}" style="width:260px" aria-label="Search">
      <select name="office_id" aria-label="Office"><option value="">All offices</option>${officeOptions(q.get('office_id'))}</select>
      <select name="status" aria-label="Status">${[['', 'Any status'], ['published', 'Published'], ['draft', 'Draft'], ['pending', 'Waiting for approval'], ['needs_review', 'Needs review (import)'], ['unverified', 'Never verified'], ['archived', 'Archived']].map(([v, l]) => `<option value="${v}" ${q.get('status') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn">${icon('search', 16)}Filter</button></form>
      <table class="tbl"><thead><tr><th>Service</th><th>Office</th><th>Status</th><th>Verified</th><th class="num">Views</th></tr></thead><tbody>
      ${d.items.map(s => `<tr class="click" data-href="#/services/${s.id}"><td><b>${esc(s.plain_title || s.title)}</b>${s.plain_title ? `<div class="small muted">${esc(s.title)}</div>` : ''}
        <div class="row" style="margin-top:4px">${s.has_pending ? '<span class="badge warn">Change waiting</span>' : ''}${s.parse_quality === 'needs_review' && !s.verified_at ? '<span class="badge warn">Check import</span>' : ''}${!s.is_citizen_facing ? '<span class="badge">Internal (G2G)</span>' : ''}</div></td>
        <td>${esc(s.office_name)}</td><td>${statusBadge(s.status)}</td><td class="small">${s.verified_at ? ago(s.verified_at) : '<span class="muted">never</span>'}</td><td class="num">${s.view_count}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No services match.</td></tr>'}
      </tbody></table>
      <div class="pager"><span class="muted small">Page ${page} of ${Math.max(1, Math.ceil(d.total / 25))}</span>
        ${page > 1 ? `<a class="btn sm" href="${set('page', '')}&page=${page - 1}">Previous</a>` : ''}${page * 25 < d.total ? `<a class="btn sm" href="${set('page', '')}&page=${page + 1}">Next</a>` : ''}</div></div>`);
  $('#sf').addEventListener('submit', e => { e.preventDefault(); const f = formData(e.target); let h = '#/services?'; for (const [k, v] of Object.entries(f)) if (v) h += `${k}=${encodeURIComponent(v)}&`; if (S.me.role === 'office_editor' && !f.office_id) h += 'all=1'; location.hash = h; });
};

async function serviceEditor(id) {
  const isNew = id === 'new';
  const s = isNew ? { title: '', office_id: S.me.office_id || '', requirements: [], raw_steps: [], keywords: [], status: 'draft', is_citizen_facing: 1 } : await api(`/api/admin/services/${id}`);
  const mine = isNew || can('lgu_admin') || (S.me.role === 'office_editor' && S.me.office_id === s.office_id);
  const ro = !mine || !can('office_editor');
  const data = { requirements: s.requirements.map(r => ({ requirement: r.requirement, where_to_secure: r.where_to_secure })), steps: s.raw_steps.map(x => ({ ...x })), keywords: [...s.keywords] };
  const reqItem = (r, i) => `<div class="item" data-i="${i}"><span class="n">${i + 1}</span><div class="fields">
    <label class="f full">Requirement<input data-k="requirement" value="${esc(r.requirement)}" ${ro ? 'disabled' : ''}></label>
    <label class="f full">Where to get it<input data-k="where_to_secure" value="${esc(r.where_to_secure)}" ${ro ? 'disabled' : ''}></label></div>
    ${ro ? '<span></span>' : opsHtml()}</div>`;
  const stepItem = (x, i) => `<div class="item" data-i="${i}"><span class="n">${i + 1}</span><div class="fields">
    <label class="f full">What the client does<textarea data-k="client_action" rows="2" ${ro ? 'disabled' : ''}>${esc(x.client_action)}</textarea></label>
    <label class="f full">What the office does<textarea data-k="agency_action" rows="2" ${ro ? 'disabled' : ''}>${esc(x.agency_action)}</textarea></label>
    <label class="f">Fee<input data-k="fee" value="${esc(x.fee)}" ${ro ? 'disabled' : ''}></label>
    <label class="f">Processing time<input data-k="processing_time" value="${esc(x.processing_time)}" ${ro ? 'disabled' : ''}></label>
    <label class="f full">Person in charge<input data-k="person_in_charge" value="${esc(x.person_in_charge)}" ${ro ? 'disabled' : ''}></label></div>
    ${ro ? '<span></span>' : opsHtml()}</div>`;
  shell('services', `<div class="head"><a class="btn sm" href="#/services">${icon('arrow-left', 16)}Services</a><h1>${isNew ? 'Add service' : esc(s.display_title || s.title)}</h1>
      ${!isNew ? statusBadge(s.status) : ''}${!isNew ? `<a class="btn sm" href="/kiosk?idle=0&screen=service&id=${s.id}" target="_blank">${icon('eye', 16)}Preview on kiosk</a>` : ''}</div>
    ${s.pending ? `<div class="notice warn">${icon('clock', 18)}<span>A change by ${esc(s.pending_by_name || 'an office editor')} is waiting for approval${isAdmin() ? ` — <a href="#/approvals">review it</a>` : ''}. The kiosk keeps showing the published version until then.</span></div>` : ''}
    ${s.parse_quality === 'needs_review' && !s.verified_at ? `<div class="notice warn">${icon('alert', 18)}<span>This service was imported automatically and some fields may be cut off or mixed up. Compare with the printed Charter (${esc(s.source || '')}), fix it, then press <b>Mark as verified</b>.</span></div>` : ''}
    ${ro ? `<div class="notice">${icon('eye', 18)}<span>Read only. ${S.me.role === 'office_editor' ? 'You can only edit services of your own office.' : 'Your role can view but not edit.'}</span></div>` : ''}
    <form id="svc" class="grid" style="gap:16px">
      <div class="card"><h2>Basics</h2><div class="form">
        <label class="f full">Official title (from the Charter)<input name="title" required value="${esc(s.title)}" ${ro ? 'disabled' : ''}></label>
        <label class="f full">Plain-language title shown on the kiosk <span class="muted" style="font-weight:400">e.g. “Cedula (Community Tax Certificate)”</span><input name="plain_title" value="${esc(s.plain_title)}" ${ro ? 'disabled' : ''}></label>
        <label class="f">Office<select name="office_id" ${ro || (S.me.role === 'office_editor') ? 'disabled' : ''}>${officeOptions(s.office_id)}</select></label>
        <label class="f">Division<input name="office_division" value="${esc(s.office_division)}" ${ro ? 'disabled' : ''}></label>
        <label class="f">Classification<select name="classification" ${ro ? 'disabled' : ''}>${['Simple', 'Complex', 'Highly Technical'].map(c => `<option ${s.classification === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="f">Type of transaction<input name="transaction_type" value="${esc(s.transaction_type)}" ${ro ? 'disabled' : ''}></label>
        <label class="f full">Who may apply<input name="who_may_avail" value="${esc(s.who_may_avail)}" ${ro ? 'disabled' : ''}></label>
        <label class="f">Total fee<input name="total_fees" value="${esc(s.total_fees)}" ${ro ? 'disabled' : ''}></label>
        <label class="f">Total processing time<input name="total_processing_time" value="${esc(s.total_processing_time)}" ${ro ? 'disabled' : ''}></label>
        <label class="f full">Description<textarea name="description" rows="3" ${ro ? 'disabled' : ''}>${esc(s.description)}</textarea></label>
        <label class="f full">Notes and fee schedules (one line per item; table rows use " | " between columns)<textarea name="notes" rows="3" ${ro ? 'disabled' : ''}>${esc(s.notes)}</textarea></label>
        <label class="f full" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="is_citizen_facing" ${s.is_citizen_facing ? 'checked' : ''} ${ro ? 'disabled' : ''}> Show on the public kiosk (untick for government-to-government services)</label>
      </div></div>
      <div class="card"><div class="row"><h2 class="grow">What to bring (${data.requirements.length})</h2>${ro ? '' : `<button type="button" class="btn sm" data-add="requirements">${icon('plus', 16)}Add requirement</button>`}</div><div class="rep" id="rep-requirements">${data.requirements.map(reqItem).join('') || '<p class="muted">No requirements.</p>'}</div></div>
      <div class="card"><div class="row"><h2 class="grow">Steps (${data.steps.length})</h2>${ro ? '' : `<button type="button" class="btn sm" data-add="steps">${icon('plus', 16)}Add step</button>`}</div><p class="muted small" style="margin-top:-6px">Rows with the same client action are shown on the kiosk as one step with several office sub-steps.</p><div class="rep" id="rep-steps">${data.steps.map(stepItem).join('') || '<p class="muted">No steps.</p>'}</div></div>
      <div class="card"><h2>Search words</h2><p class="muted small" style="margin-top:-6px">Words people actually type: local names, misspellings, Bisaya/Filipino terms. Example: <i>cedula, sedula, ctc</i>.</p>
        <div class="row" id="kw">${data.keywords.map(k => `<span class="chip">${esc(k)}${ro ? '' : `<button type="button" data-kwdel="${esc(k)}" aria-label="Remove ${esc(k)}">${icon('x', 12)}</button>`}</span>`).join('')}</div>
        ${ro ? '' : '<div class="row" style="margin-top:10px"><input id="kwin" placeholder="Add a word and press Enter" style="width:280px"></div>'}</div>
      ${ro ? '' : `<div class="card row" style="position:sticky;bottom:12px;z-index:5">
        <button class="btn primary">${icon('check', 18)}${isNew ? 'Create service' : S.me.role === 'office_editor' && s.status === 'published' ? 'Submit for approval' : 'Save changes'}</button>
        ${!isNew ? `<button type="button" class="btn" data-svc="verify">${icon('circle-check', 18)}Mark as verified</button>` : ''}
        <span class="grow"></span>
        ${!isNew && isAdmin() ? (s.status === 'published' ? `<button type="button" class="btn" data-svc="draft">Unpublish</button>` : `<button type="button" class="btn ok" data-svc="published">Publish</button>`) + `<button type="button" class="btn danger" data-svc="archived">${icon('trash', 16)}Archive</button>` : ''}
        ${isNew && isAdmin() ? '<label class="row small"><input type="checkbox" name="publish" checked> Publish now</label>' : ''}
        <span class="muted small">${s.verified_at ? `Last verified ${ago(s.verified_at)}` : 'Never verified'}</span></div>`}
    </form>`);
  if (ro) return;
  const form = $('#svc');
  const sync = () => {
    for (const kind of ['requirements', 'steps']) $$(`#rep-${kind} .item`).forEach(el => { const i = Number(el.dataset.i); $$('[data-k]', el).forEach(inp => { data[kind][i][inp.dataset.k] = inp.value; }); });
  };
  const rerender = kind => { sync(); $(`#rep-${kind}`).innerHTML = data[kind].map(kind === 'steps' ? stepItem : reqItem).join(''); $(`#rep-${kind}`).closest('.card').querySelector('h2').textContent = `${kind === 'steps' ? 'Steps' : 'What to bring'} (${data[kind].length})`; };
  form.addEventListener('click', async e => {
    const add = e.target.closest('[data-add]');
    if (add) { sync(); const k = add.dataset.add; data[k].push(k === 'steps' ? { client_action: '', agency_action: '', fee: '', processing_time: '', person_in_charge: '' } : { requirement: '', where_to_secure: '' }); rerender(k); $$(`#rep-${k} .item`).pop()?.querySelector('input,textarea')?.focus(); return; }
    const op = e.target.closest('[data-op]');
    if (op) {
      const item = op.closest('.item'), kind = item.parentElement.id.replace('rep-', ''), i = Number(item.dataset.i); sync();
      const arr = data[kind];
      if (op.dataset.op === 'del') arr.splice(i, 1);
      if (op.dataset.op === 'up' && i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      if (op.dataset.op === 'down' && i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
      rerender(kind); return;
    }
    const kd = e.target.closest('[data-kwdel]');
    if (kd) { data.keywords = data.keywords.filter(k => k !== kd.dataset.kwdel); kd.parentElement.remove(); return; }
    const sv = e.target.closest('[data-svc]');
    if (sv) {
      const a = sv.dataset.svc;
      try {
        if (a === 'verify') { await api(`/api/admin/services/${s.id}/verify`, { method: 'POST' }); toast('Marked as verified.'); }
        else { if (a === 'archived' && !confirmInline(sv, 'Archive?')) return; await api(`/api/admin/services/${s.id}/status`, { method: 'POST', body: { status: a } }); toast(a === 'published' ? 'Published — kiosks update within a minute.' : a === 'draft' ? 'Unpublished.' : 'Archived.'); if (a === 'archived') { location.hash = '#/services'; return; } }
        serviceEditor(s.id);
      } catch (err) { toast(err.message, true); }
    }
  });
  $('#kwin')?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return; e.preventDefault();
    const v = e.target.value.trim().toLowerCase(); if (!v || data.keywords.includes(v)) return;
    data.keywords.push(v); e.target.value = '';
    $('#kw').insertAdjacentHTML('beforeend', `<span class="chip">${esc(v)}<button type="button" data-kwdel="${esc(v)}" aria-label="Remove ${esc(v)}">${icon('x', 12)}</button></span>`);
  });
  form.addEventListener('submit', async e => {
    e.preventDefault(); sync();
    const f = formData(form);
    const body = { ...f, is_citizen_facing: !!f.is_citizen_facing, publish: !!f.publish, requirements: data.requirements, steps: data.steps, keywords: data.keywords };
    if (S.me.role === 'office_editor') body.office_id = s.office_id || S.me.office_id;
    try {
      const r = isNew ? await api('/api/admin/services', { method: 'POST', body }) : await api(`/api/admin/services/${s.id}`, { method: 'PUT', body });
      toast(r.message || (isNew ? 'Service created.' : 'Saved — kiosks update within a minute.'));
      if (isNew) location.hash = `#/services/${r.id}`; else serviceEditor(s.id);
      refreshPending();
    } catch (err) { toast(err.message, true); }
  });
}
const opsHtml = () => `<div class="ops"><button type="button" class="iconbtn" data-op="up" aria-label="Move up">${icon('chevron-up', 18)}</button><button type="button" class="iconbtn" data-op="down" aria-label="Move down">${icon('chevron-down', 18)}</button><button type="button" class="iconbtn" data-op="del" aria-label="Remove">${icon('trash', 18)}</button></div>`;
function confirmInline(btn, text) { if (btn.dataset.armed) return true; btn.dataset.armed = '1'; const old = btn.innerHTML; btn.textContent = `${text} Click again`; setTimeout(() => { delete btn.dataset.armed; btn.innerHTML = old; }, 3000); return false; }

// ---------------- approvals
PAGES.approvals = async () => {
  const d = await api('/api/admin/services?status=pending&size=100');
  const details = await Promise.all(d.items.map(s => api(`/api/admin/services/${s.id}`)));
  const show = v => Array.isArray(v) ? v.map((x, i) => typeof x === 'object' ? `${i + 1}. ${Object.values(x).filter(Boolean).join(' — ')}` : x).join('\n') : String(v ?? '');
  const current = (s, k) => k === 'requirements' ? s.requirements.map(r => ({ requirement: r.requirement, where_to_secure: r.where_to_secure })) : k === 'steps' ? s.raw_steps.map(({ client_action, agency_action, fee, processing_time, person_in_charge }) => ({ client_action, agency_action, fee, processing_time, person_in_charge })) : s[k];
  shell('approvals', `<div class="head"><h1>Approvals</h1></div><p class="sub">Changes proposed by office editors. Nothing reaches the kiosk until you approve it.</p>
    ${details.map(s => { const p = s.pending; const keys = Object.keys(p).filter(k => !['verify', 'publish'].includes(k) && show(p[k]) !== show(current(s, k)));
      return `<div class="card" style="margin-bottom:16px"><div class="row"><h2 class="grow">${esc(s.display_title)}</h2><span class="muted small">${esc(s.office_name)} · proposed by ${esc(s.pending_by_name || '—')} ${ago(s.pending_at)}</span></div>
      ${keys.length ? keys.map(k => `<h3>${esc(k.replace(/_/g, ' '))}</h3><div class="diff"><div><div class="small muted">Now on the kiosk</div><pre>${esc(show(current(s, k))) || '<i>empty</i>'}</pre></div><div><div class="small muted">Proposed</div><pre style="background:var(--brand-grass-tint)">${esc(show(p[k])) || '<i>empty</i>'}</pre></div></div>`).join('') : '<p class="muted">No visible differences.</p>'}
      <div class="row" style="margin-top:14px"><button class="btn ok" data-act="approve" data-id="${s.id}">${icon('check', 18)}Approve &amp; publish</button><button class="btn danger" data-act="reject" data-id="${s.id}">Reject</button><a class="btn" href="#/services/${s.id}">Open service</a></div></div>`; }).join('') || `<div class="card"><p class="muted">${icon('circle-check', 20)} Nothing waiting. Good job.</p></div>`}`);
};
ACTIONS.approve = async b => { try { await api(`/api/admin/services/${b.dataset.id}/approve`, { method: 'POST' }); toast('Approved and published.'); await refreshPending(); PAGES.approvals(); } catch (e) { toast(e.message, true); } };
ACTIONS.reject = async b => { try { await api(`/api/admin/services/${b.dataset.id}/reject`, { method: 'POST', body: {} }); toast('Rejected. The published version stays.'); await refreshPending(); PAGES.approvals(); } catch (e) { toast(e.message, true); } };
async function refreshPending() { if (!isAdmin()) return; const d = await api('/api/admin/services?status=pending&size=1').catch(() => ({ total: 0 })); S.pending = d.total; const a = $('.nav a[href="#/approvals"]'); if (a) { a.querySelector('.count')?.remove(); if (S.pending) a.insertAdjacentHTML('beforeend', `<span class="count">${S.pending}</span>`); } }

// ---------------- offices
async function loadOffices() { S.offices = (await api('/api/admin/offices')).items; }
async function loadFloors() { S.floors = (await api('/api/admin/floors')).items; }
const locText = l => !l ? '<span class="badge warn">Not set</span>' : l.type === 'in_building' && l.room_code ? `<b>${esc(l.room_code)}</b> · ${esc(l.floor_name)}` : l.type === 'offsite' ? `<span class="badge info">Off-site</span> <span class="small muted">${esc(l.offsite_address || '')}</span>` : '<span class="badge warn">Location unconfirmed</span>';

PAGES.offices = async id => {
  await loadOffices();
  if (id) return officeDetail(Number(id));
  shell('offices', `<div class="head"><h1>Offices</h1>${isAdmin() ? `<button class="btn primary" data-act="newoffice">${icon('plus', 18)}Add office</button>` : ''}</div>
    <p class="sub">Where each office is <i>right now</i>. Moving an office keeps the old location in its history and updates every kiosk and the 3D route.</p>
    <div class="card"><table class="tbl"><thead><tr><th>Office</th><th>Location</th><th>Position (x, y, z)</th><th class="num">Services</th></tr></thead><tbody>
    ${S.offices.map(o => `<tr class="click" data-href="#/offices/${o.id}"><td><b>${esc(o.name)}</b>${o.short_name ? ` <span class="muted small">${esc(o.short_name)}</span>` : ''}</td><td>${locText(o.location)}</td>
      <td class="small">${o.location?.position ? `${o.location.position.x}, ${o.location.position.y}, ${o.location.position.z} ${coordBadge(o.location.coord_source)}` : '—'}</td><td class="num">${o.service_count}</td></tr>`).join('')}
    </tbody></table></div>`);
};
ACTIONS.newoffice = () => modal(`<h2>Add office</h2><form class="grid" id="no"><label class="f">Name<input name="name" required></label><label class="f">Short name<input name="short_name"></label>
  <label class="f">Phone<input name="phone"></label><label class="f">Office hours<input name="hours" value="Monday to Friday 8:00 AM – 5:00 PM (except holidays)"></label>
  <div class="row"><button class="btn primary">Create</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, el => {
  $('#no', el).addEventListener('submit', async e => { e.preventDefault(); try { const o = await api('/api/admin/offices', { method: 'POST', body: { ...formData(e.target), location_type: 'unconfirmed' } }); el.remove(); toast('Office added. Now place it in a room.'); location.hash = `#/offices/${o.id}`; } catch (err) { toast(err.message, true); } });
});

async function officeDetail(id) {
  const o = S.offices.find(x => x.id === id); if (!o) return shell('offices', '<p>Not found.</p>');
  const [hist] = await Promise.all([api(`/api/admin/offices/${id}/history`), loadFloors()]);
  const editable = can('lgu_admin') || (S.me.role === 'office_editor' && S.me.office_id === id);
  shell('offices', `<div class="head"><a class="btn sm" href="#/offices">${icon('arrow-left', 16)}Offices</a><h1>${esc(o.name)}</h1><a class="btn sm" href="#/services?office_id=${o.id}&all=1">${o.service_count} services →</a></div>
    <div class="split">
      <form class="card form" id="of"><h2 class="full">Details</h2>
        <label class="f full">Name<input name="name" value="${esc(o.name)}" ${editable ? '' : 'disabled'}></label>
        <label class="f">Short name<input name="short_name" value="${esc(o.short_name)}" ${editable ? '' : 'disabled'}></label>
        <label class="f">Head of office<input name="head" value="${esc(o.head)}" ${editable ? '' : 'disabled'}></label>
        <label class="f">Phone<input name="phone" value="${esc(o.phone)}" ${editable ? '' : 'disabled'}></label>
        <label class="f">Email<input name="email" value="${esc(o.email)}" ${editable ? '' : 'disabled'}></label>
        <label class="f full">Office hours<input name="hours" value="${esc(o.hours)}" ${editable ? '' : 'disabled'}></label>
        <label class="f">Where is it?<select name="location_type" ${isAdmin() ? '' : 'disabled'}>${[['in_building', 'Inside City Hall'], ['offsite', 'Another building'], ['unconfirmed', 'Not confirmed yet']].map(([v, l]) => `<option value="${v}" ${o.location_type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="f">Off-site address<input name="offsite_address" value="${esc(o.offsite_address)}" ${isAdmin() ? '' : 'disabled'}></label>
        <label class="f full">Description<textarea name="description" ${editable ? '' : 'disabled'}>${esc(o.description)}</textarea></label>
        ${editable ? `<div class="full"><button class="btn primary">${icon('check', 18)}Save details</button></div>` : ''}
      </form>
      <div class="grid">
        <div class="card"><h2>Current location</h2><p style="margin:0 0 8px">${locText(o.location)}</p>
          ${o.location?.position ? `<p class="small muted" style="margin:0">Door position x ${o.location.position.x}, y ${o.location.position.y}, z ${o.location.position.z} m · ${coordBadge(o.location.coord_source)} · <a href="#/rooms?room=${o.location.room_id}">Edit room position</a></p>` : ''}
          ${isAdmin() ? `<p><button class="btn primary" data-act="assignoffice" data-office="${id}">${icon('move', 18)}Move office</button></p><p class="small muted">Choose a new room, share a room, or swap with another office. Each change is kept in history.</p>` : ''}
        </div>
        <div class="card"><h2>Location history</h2><table class="tbl"><tbody>${hist.items.map(h => `<tr><td><b>${esc(h.room_code)}</b> · ${esc(h.floor_name)}<div class="small muted">${esc(h.note || '')}</div></td><td class="small">${when(h.valid_from)} → ${h.valid_to ? when(h.valid_to) : '<span class="badge ok">now</span>'}<div class="muted">${esc(h.changed_by_name || 'Seed')}</div></td></tr>`).join('') || '<tr><td class="muted">No history.</td></tr>'}</tbody></table></div>
      </div></div>`);
  $('#of').addEventListener('submit', async e => { e.preventDefault(); try { const b = formData(e.target); await api(`/api/admin/offices/${id}`, { method: 'PUT', body: b }); toast('Saved.'); PAGES.offices(id); } catch (err) { toast(err.message, true); } });
}

// ---------------- room assignments: physical rooms stay fixed when offices move
const ASSIGNABLE = new Set(['office', 'info_desk', 'other']);
const roomOffices = roomId => S.offices.filter(o => o.location?.room_id === roomId);
let floorReferences;
async function loadFloorReferences() {
  return floorReferences ||= await api('/admin/reference-plans/index.json');
}
PAGES.assignments = async (_, qs) => {
  await Promise.all([loadOffices(), loadFloors()]);
  const refs = await loadFloorReferences(), q = new URLSearchParams(qs);
  const floorId = q.get('floor') || '', term = (q.get('q') || '').toLowerCase();
  const rooms = S.floors.filter(f => !floorId || String(f.id) === floorId).flatMap(f => f.rooms
    .filter(r => r.is_active && ASSIGNABLE.has(r.room_type)).map(r => ({ ...r, floor_name: f.name })));
  const matching = rooms.filter(r => [r.code, r.name, ...roomOffices(r.id).map(o => o.name)].join(' ').toLowerCase().includes(term));
  const unplaced = S.offices.filter(o => o.is_active && o.location_type !== 'offsite' && !o.location?.room_id);
  shell('assignments', `<div class="head"><h1>Room assignments</h1>${isAdmin() ? '<button class="btn primary" data-act="assignoffice">Move an office</button>' : ''}</div>
    <p class="sub">Choose a room and change the office inside. Room positions stay fixed; office services and destinations follow the new assignment.</p>
    <details class="card reference-plans"><summary>Updated floor plans — room reference</summary>
      <p class="small muted">Use these drawings to identify rooms. The table below shows the current assignments; names printed on the drawings stay as supplied.</p>
      <div class="grid g2">${refs.plans.map(p => `<a class="reference-plan" href="${esc(p.pdf)}" target="_blank" rel="noopener"><img src="${esc(p.image)}" loading="lazy" alt="${esc(p.name)}"><b>${esc(p.name)}</b><span class="small">Open full PDF ↗</span></a>`).join('')}</div>
    </details>
    ${unplaced.length ? `<div class="notice warn"><span><b>${unplaced.length} offices need a room.</b> ${unplaced.map(o => `<a href="#/offices/${o.id}">${esc(o.short_name || o.name)}</a>`).join(', ')}</span></div>` : ''}
    <div class="card"><form class="toolbar" id="assignment-filter">
      <input name="q" aria-label="Search rooms or offices" placeholder="Search a room or office" value="${esc(q.get('q') || '')}">
      <select name="floor" aria-label="Filter by floor"><option value="">All floors</option>${S.floors.map(f => `<option value="${f.id}" ${String(f.id) === floorId ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select><button class="btn">Filter</button>
    </form><div class="table-scroll"><table class="tbl"><thead><tr><th>Room</th><th>Floor</th><th>Current offices</th><th></th></tr></thead><tbody>
      ${matching.map(r => `<tr data-room-row="${r.id}"><td><b>${esc(r.code)}</b><div class="small muted">${esc(r.name)}</div></td><td>${esc(r.floor_name)}</td>
        <td>${roomOffices(r.id).map(o => `<div><a href="#/offices/${o.id}">${esc(o.name)}</a></div>`).join('') || '<span class="muted">Available</span>'}</td>
        <td class="right">${isAdmin() ? `<button class="btn sm" data-act="assignoffice" data-room="${r.id}">Change office</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4">No rooms match this filter.</td></tr>'}
    </tbody></table></div></div><p class="small muted">Room geometry and doorway links are managed in <a href="#/rooms">Floors &amp; rooms</a> and <a href="#/navigation">Navigation</a>. Routes are available for rooms with a mapped doorway.</p>`);
  $('#assignment-filter').addEventListener('submit', e => { e.preventDefault(); location.hash = '#/assignments?' + new URLSearchParams(formData(e.target)); });
};
ACTIONS.assignoffice = b => assignmentDialog({ roomId: Number(b.dataset.room) || null, officeId: Number(b.dataset.office) || null });
async function assignmentDialog({ roomId = null, officeId = null, onSaved = () => route() } = {}) {
  await Promise.all([loadOffices(), loadFloors()]);
  const rooms = S.floors.flatMap(f => f.rooms.filter(r => r.is_active && ASSIGNABLE.has(r.room_type)).map(r => ({ ...r, floor_name: f.name })));
  const trigger = document.activeElement;
  modal(`<h2 id="assignment-title">Change room assignment</h2><form id="assignment-form" class="grid">
    <label class="f">Office to move<select name="office_id" required><option value="">Choose an office…</option>${S.offices.filter(o => o.is_active).map(o => `<option value="${o.id}" ${o.id === officeId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>
    <div id="assignment-current" class="small muted"></div>
    <label class="f">New room<select name="room_id" required><option value="">Choose a room…</option>${rooms.map(r => `<option value="${r.id}" ${r.id === roomId ? 'selected' : ''}>${esc(r.code)} · ${esc(r.floor_name)}${roomOffices(r.id).length ? ` — ${esc(roomOffices(r.id).map(o => o.short_name || o.name).join(', '))}` : ' — Available'}</option>`).join('')}</select></label>
    <div id="assignment-occupancy"></div><div id="assignment-review" class="notice" aria-live="polite"></div>
    <label class="f">Reason (optional, saved in history)<input name="note" maxlength="500" placeholder="e.g. Office relocation"></label>
    <div id="assignment-error" class="notice bad" role="alert" hidden></div>
    <div class="row"><button class="btn primary" id="assignment-save" disabled>Save assignment</button><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn" id="assignment-refresh" hidden>Refresh assignments</button></div>
    <p class="small muted">Connected kiosks pick up changes within a minute. Previous assignments remain in each office’s location history.</p>
  </form>`, el => {
    $('[role=dialog]', el).setAttribute('aria-labelledby', 'assignment-title');
    const form = $('#assignment-form', el), save = $('#assignment-save', el);
    let state = null;
    const review = (reset = false) => {
      const office = S.offices.find(o => o.id === Number(form.elements.office_id.value));
      const room = rooms.find(r => r.id === Number(form.elements.room_id.value));
      const occupants = room ? roomOffices(room.id).filter(o => o.id !== office?.id) : [];
      $('#assignment-current', el).innerHTML = office ? `Current location: ${locText(office.location)}` : '';
      if (reset) {
        const canSwap = office?.location?.room_id && roomOffices(office.location.room_id).length === 1 && occupants.length === 1;
        $('#assignment-occupancy', el).innerHTML = occupants.length ? `<label class="f">This room contains ${esc(occupants.map(o => o.name).join(', '))}<select name="occupancy" required>
          <option value="">Choose what happens to the current occupants…</option><option value="replace">Replace — current occupants will need a new room</option>
          ${canSwap ? '<option value="swap">Swap — exchange the two offices’ rooms</option>' : ''}<option value="share">Share — keep the current occupants here</option></select></label>` : '';
      }
      const mode = occupants.length ? form.elements.occupancy?.value : 'move';
      const same = office && room && office.location?.room_id === room.id;
      save.disabled = !office || !room || !mode || same;
      const change = !office || !room ? 'Choose an office and its new room.' : same ? 'This office is already assigned to this room.' : !mode ? 'Choose what happens to the current occupants.' :
        `${esc(office.name)} → <b>${esc(room.code)}</b>. ` + (mode === 'replace' ? `${esc(occupants.map(o => o.name).join(', '))} will be marked “Location unconfirmed” until assigned elsewhere.` : mode === 'swap' ? `${esc(occupants[0].name)} → <b>${esc(office.location.room_code)}</b>.` : mode === 'share' ? 'The existing occupants will stay in this room.' : 'The previous room assignment will be saved in history.');
      $('#assignment-review', el).innerHTML = `<span>${change}</span>`;
      state = { office, room, occupants, mode };
    };
    form.addEventListener('change', e => review(e.target.name !== 'occupancy' && e.target.name !== 'note'));
    review(true);
    $('#assignment-refresh', el).onclick = () => { el.remove(); assignmentDialog({ roomId: state?.room?.id, officeId: state?.office?.id, onSaved }); };
    form.addEventListener('submit', async e => {
      e.preventDefault(); if (save.disabled) return;
      const { office, room, occupants, mode } = state;
      save.disabled = true;
      try {
        await api(`/api/admin/offices/${office.id}/move`, { method: 'POST', body: { room_id: room.id, occupancy: mode, note: form.elements.note.value,
          expected_room_id: office.location?.room_id ?? null, expected_occupant_ids: occupants.map(o => o.id) } });
        el.remove(); toast(`Assigned ${office.short_name || office.name} to ${room.code}.`); await onSaved();
      } catch (err) {
        const error = $('#assignment-error', el); error.hidden = false; error.textContent = err.message;
        $('#assignment-refresh', el).hidden = false; save.disabled = false;
      }
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { el.remove(); trigger?.focus(); }
      if (e.key !== 'Tab') return;
      const focusable = $$('input, select, button', el).filter(x => !x.disabled && !x.hidden);
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  });
}

// ---------------- floors & rooms (dynamic x, y, z) — drag on the plan or type the numbers
PAGES.rooms = async (_, qs) => {
  await Promise.all([loadFloors(), loadOffices()]);
  const q = new URLSearchParams(qs);
  if (q.get('room')) { const r = S.floors.flatMap(f => f.rooms).find(r => r.id === Number(q.get('room'))); if (r) { S.selRoom = r.id; S.roomFloor = S.floors.find(f => f.id === r.floor_id).level; } }
  const kiosks = (await api('/api/admin/kiosks')).items;
  drawRooms(kiosks);
};
function drawRooms(kiosks) {
  const fl = S.floors.find(f => f.level === S.roomFloor) || S.floors[0];
  const sel = fl.rooms.find(r => r.id === S.selRoom) || null;
  const editable = isAdmin();
  shell('rooms', `<div class="head"><h1>Floors &amp; rooms</h1>${editable ? `<button class="btn primary" data-act="newroom">${icon('plus', 18)}Add room</button>` : ''}</div>
    <p class="sub">Positions are in metres with the same axes as the 3D model: <b>x</b> left/right from the main entrance, <b>y</b> height of the floor, <b>z</b> depth into the building. ${editable ? 'Drag a room on the plan or type exact numbers.' : ''}</p>
    <div class="row" style="margin-bottom:12px" role="tablist">${S.floors.map(f => `<button class="btn ${f.level === fl.level ? 'primary' : ''}" role="tab" aria-selected="${f.level === fl.level}" data-act="roomfloor" data-l="${f.level}">${esc(f.name)} <span class="small" style="opacity:.75">y = ${f.elevation_y}</span></button>`).join('')}</div>
    <div class="split"><div class="card">${planSVG(fl, kiosks)}<p class="small muted" style="margin:8px 0 0">Grid = 2 m. Blue dot = door / approach point the route walks to. Green = kiosk.</p></div>
      <div class="card" id="roomform">${sel ? roomForm(sel, editable) : '<p class="muted">Select a room on the plan or in the table.</p>'}</div></div>
    <div class="card" style="margin-top:16px"><table class="tbl"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Office inside</th><th>x</th><th>y</th><th>z</th><th>Source</th></tr></thead><tbody>
      ${fl.rooms.map(r => `<tr class="click ${r.is_active ? '' : 'muted'}" data-act="selroom" data-id="${r.id}"><td><b>${esc(r.code)}</b></td><td>${esc(r.name)}${r.is_active ? '' : ' <span class="badge">inactive</span>'}</td><td>${esc(r.room_type)}</td><td class="small">${esc(r.occupant || '')}</td><td>${r.x}</td><td>${r.y}</td><td>${r.z}</td><td>${coordBadge(r.coord_source)}</td></tr>`).join('')}
    </tbody></table></div>`);
  if (sel && editable) bindRoomForm(sel);
  if (editable) bindDrag(fl);
}
function planSVG(fl, kiosks) {
  const W = fl.bounds_max_x - fl.bounds_min_x, D = fl.bounds_max_z - fl.bounds_min_z;
  const X = x => x - fl.bounds_min_x, Y = z => fl.bounds_max_z - z; // north (+z) at the top
  let grid = ''; for (let x = Math.ceil(fl.bounds_min_x / 2) * 2; x <= fl.bounds_max_x; x += 2) grid += `<line x1="${X(x)}" y1="0" x2="${X(x)}" y2="${D}" stroke="${x === 0 ? '#c7bfb2' : '#e3ddd3'}" stroke-width="${x === 0 ? .2 : .08}"/>`;
  for (let z = Math.ceil(fl.bounds_min_z / 2) * 2; z <= fl.bounds_max_z; z += 2) grid += `<line x1="0" y1="${Y(z)}" x2="${W}" y2="${Y(z)}" stroke="#e3ddd3" stroke-width=".08"/>`;
  const rooms = fl.rooms.filter(r => r.is_active).map(r => {
    const rot = Math.round(((r.facing_deg || 0) % 180 + 180) % 180) === 90; const w = rot ? r.depth_m : r.width_m, d = rot ? r.width_m : r.depth_m;
    const fill = r.id === S.selRoom ? '#FBE9E5' : r.room_type === 'office' ? '#C9E0F8' : r.room_type === 'stairs' ? '#F6E3B0' : r.room_type === 'hall' ? '#FFFFFF' : '#E3DDD3';
    return `<g class="room ${r.id === S.selRoom ? 'sel' : ''}" data-id="${r.id}"><rect x="${X(r.x) - w / 2}" y="${Y(r.z) - d / 2}" width="${w}" height="${d}" rx=".4" fill="${fill}" stroke="#12355B" stroke-width=".12"/>
      <text x="${X(r.x)}" y="${Y(r.z) + .5}" font-size="1.4" text-anchor="middle" fill="#12355B" font-weight="700" pointer-events="none">${esc(r.code)}</text>
      ${r.approach_x != null ? `<circle class="appr" cx="${X(r.approach_x)}" cy="${Y(r.approach_z)}" r=".45" fill="#1A63BE" pointer-events="none"/>` : ''}</g>`;
  }).join('');
  const ks = kiosks.filter(k => k.floor_id === fl.id).map(k => `<g pointer-events="none"><circle cx="${X(k.x)}" cy="${Y(k.z)}" r=".8" fill="#2E7D32"/><text x="${X(k.x)}" y="${Y(k.z) - 1.2}" font-size="1.2" text-anchor="middle" fill="#2E7D32" font-weight="700">${esc(k.code)}</text></g>`).join('');
  return `<svg class="plan" id="plan" viewBox="-1 -1 ${W + 2} ${D + 2}" role="img" aria-label="Plan of ${esc(fl.name)}">${grid}
    <text x="${X(0)}" y="${D + .6}" font-size="1.1" text-anchor="middle" fill="#5A6472">ENTRANCE (x 0, z 0)</text>${rooms}${ks}</svg>`;
}
function roomForm(r, editable) {
  const dis = editable ? '' : 'disabled';
  const n = (k, label, step = '0.1') => `<label class="f">${label}<input type="number" step="${step}" name="${k}" value="${r[k] ?? ''}" ${dis}></label>`;
  return `<form id="rf" class="grid" style="gap:12px"><div class="row"><h2 class="grow" style="margin:0">${esc(r.code)}</h2>${coordBadge(r.coord_source)}</div>
    ${r.occupant ? `<p class="small" style="margin:0">Office inside: <b>${esc(r.occupant)}</b></p>` : ''}
    <label class="f">Code<input name="code" value="${esc(r.code)}" ${dis}></label>
    <label class="f">Name<input name="name" value="${esc(r.name)}" ${dis}></label>
    <label class="f">Type<select name="room_type" ${dis}>${ROOM_TYPES.map(t => `<option ${t === r.room_type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <div><div class="small" style="font-weight:700;color:var(--text-secondary);margin-bottom:4px">Room centre (m)</div><div class="xyz">${n('x', 'x')}${n('y', 'y')}${n('z', 'z')}</div></div>
    <div><div class="small" style="font-weight:700;color:var(--text-secondary);margin-bottom:4px">Door / approach point (m)</div><div class="xyz">${n('approach_x', 'x')}${n('approach_y', 'y')}${n('approach_z', 'z')}</div></div>
    <div class="xyz">${n('facing_deg', 'Door faces (°)', '1')}${n('width_m', 'Width')}${n('depth_m', 'Depth')}</div>
    <label class="row small"><input type="checkbox" name="is_accessible" ${r.is_accessible ? 'checked' : ''} ${dis}> Wheelchair accessible</label>
    <label class="f">Notes<textarea name="notes" rows="2" ${dis}>${esc(r.notes)}</textarea></label>
    ${editable ? `<div class="row"><button class="btn primary">${icon('check', 18)}Save position</button>${r.is_active ? `<button type="button" class="btn danger" data-act="delroom" data-id="${r.id}">Deactivate</button>` : ''}</div>
    <p class="small muted" style="margin:0">Saving bumps the content version. Kiosks re-download within a minute.</p>` : ''}</form>`;
}
function bindRoomForm(r) {
  $('#rf').addEventListener('submit', async e => {
    e.preventDefault();
    const b = formData(e.target); b.is_accessible = b.is_accessible ? 1 : 0;
    for (const k of ['x', 'y', 'z', 'approach_x', 'approach_y', 'approach_z', 'facing_deg', 'width_m', 'depth_m']) b[k] = b[k] === '' ? null : Number(b[k]);
    try { await api(`/api/admin/rooms/${r.id}`, { method: 'PUT', body: b }); toast(`${b.code} saved.`); PAGES.rooms(); } catch (err) { toast(err.message, true); }
  });
}
function bindDrag(fl) {
  const svg = $('#plan'); let drag = null;
  const pt = e => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; const m = p.matrixTransform(svg.getScreenCTM().inverse()); return { x: m.x + fl.bounds_min_x, z: fl.bounds_max_z - m.y }; };
  svg.addEventListener('pointerdown', e => {
    const g = e.target.closest('.room'); if (!g) return;
    const r = fl.rooms.find(x => x.id === Number(g.dataset.id));
    if (S.selRoom !== r.id) { S.selRoom = r.id; $('#roomform').innerHTML = roomForm(r, true); bindRoomForm(r); $$('.room', svg).forEach(x => x.classList.toggle('sel', x === g)); }
    const p = pt(e); drag = { g, r, start: p, ox: r.x, oz: r.z, ax: r.approach_x, az: r.approach_z }; svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return; const p = pt(e);
    const dx = Math.round((p.x - drag.start.x) * 2) / 2, dz = Math.round((p.z - drag.start.z) * 2) / 2; // snap 0.5 m
    drag.g.setAttribute('transform', `translate(${dx} ${-dz})`);
    const f = $('#rf'); if (!f) return;
    f.x.value = drag.ox + dx; f.z.value = drag.oz + dz;
    if (drag.ax != null) { f.approach_x.value = drag.ax + dx; f.approach_z.value = drag.az + dz; }
    drag.moved = dx || dz;
  });
  svg.addEventListener('pointerup', () => { if (drag?.moved) toast('Moved on the plan — press “Save position” to keep it.'); drag = null; });
}
ACTIONS.roomfloor = b => { S.roomFloor = Number(b.dataset.l); S.selRoom = null; PAGES.rooms(); };
ACTIONS.selroom = b => { S.selRoom = Number(b.dataset.id); PAGES.rooms(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
ACTIONS.delroom = async b => { if (!confirmInline(b, 'Deactivate?')) return; try { await api(`/api/admin/rooms/${b.dataset.id}`, { method: 'DELETE' }); toast('Room deactivated.'); S.selRoom = null; PAGES.rooms(); } catch (e) { toast(e.message, true); } };
ACTIONS.newroom = () => {
  const fl = S.floors.find(f => f.level === S.roomFloor);
  modal(`<h2>Add room on ${esc(fl.name)}</h2><form id="nr" class="grid" style="gap:12px">
    <label class="f">Code<input name="code" required placeholder="${fl.level}F-1xx"></label><label class="f">Name<input name="name" required></label>
    <label class="f">Type<select name="room_type">${ROOM_TYPES.map(t => `<option>${t}</option>`).join('')}</select></label>
    <div class="xyz"><label class="f">x<input type="number" step="0.1" name="x" value="0"></label><label class="f">y<input type="number" step="0.1" name="y" value="${fl.elevation_y}"></label><label class="f">z<input type="number" step="0.1" name="z" value="10"></label></div>
    <div class="xyz"><label class="f">Door x<input type="number" step="0.1" name="approach_x"></label><label class="f">Door y<input type="number" step="0.1" name="approach_y" value="${fl.elevation_y}"></label><label class="f">Door z<input type="number" step="0.1" name="approach_z"></label></div>
    <div class="row"><button class="btn primary">Add room</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, el => {
    $('#nr', el).addEventListener('submit', async e => { e.preventDefault(); const b = formData(e.target); b.floor_id = fl.id; for (const k of ['x', 'y', 'z', 'approach_x', 'approach_y', 'approach_z']) b[k] = b[k] === '' ? null : Number(b[k]);
      try { const r = await api('/api/admin/rooms', { method: 'POST', body: b }); el.remove(); S.selRoom = r.id; toast('Room added.'); PAGES.rooms(); } catch (err) { toast(err.message, true); } });
  });
};

// ---------------- kiosks
PAGES.kiosks = async () => {
  await loadFloors();
  const d = await api('/api/admin/kiosks');
  shell('kiosks', `<div class="head"><h1>Kiosks</h1>${isAdmin() ? `<button class="btn primary" data-act="editkiosk">${icon('plus', 18)}Add kiosk</button>` : ''}</div>
    <p class="sub">Each kiosk’s position is the start of every route. Open a kiosk with <code>/kiosk?kiosk=CODE</code>.</p>
    <div class="card"><table class="tbl"><thead><tr><th>Kiosk</th><th>Status</th><th>Floor</th><th>x, y, z</th><th>Faces</th><th>Content</th><th></th></tr></thead><tbody>
    ${d.items.map(k => `<tr><td><b>${esc(k.name)}</b><div class="small muted">${esc(k.code)}</div></td><td>${k.status === 'online' ? '<span class="badge ok">Online</span>' : '<span class="badge bad">Offline</span>'}<div class="small muted">${ago(k.last_heartbeat)}</div></td>
      <td>${esc(k.floor_name)}</td><td>${k.x}, ${k.y}, ${k.z}</td><td>${k.facing_deg}°</td><td>v${k.content_version ?? '—'}</td><td>${isAdmin() ? `<button class="btn sm" data-act="editkiosk" data-id="${k.id}">${icon('pencil', 14)}Edit</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`);
  S.kiosks = d.items;
};
ACTIONS.editkiosk = b => {
  const k = S.kiosks.find(x => x.id === Number(b.dataset.id)) || { code: '', name: '', floor_id: S.floors[0].id, x: 0, y: 0, z: 0, facing_deg: 0 };
  modal(`<h2>${k.id ? 'Edit' : 'Add'} kiosk</h2><form id="kf" class="grid" style="gap:12px">
    <label class="f">Code<input name="code" value="${esc(k.code)}" ${k.id ? 'disabled' : 'required'}></label><label class="f">Name<input name="name" value="${esc(k.name)}" required></label>
    <label class="f">Floor<select name="floor_id">${S.floors.map(f => `<option value="${f.id}" ${f.id === k.floor_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
    <div class="xyz"><label class="f">x<input type="number" step="0.1" name="x" value="${k.x}"></label><label class="f">y<input type="number" step="0.1" name="y" value="${k.y}"></label><label class="f">z<input type="number" step="0.1" name="z" value="${k.z}"></label></div>
    <label class="f">Screen faces (degrees, 0 = into the building)<input type="number" name="facing_deg" value="${k.facing_deg}"></label>
    <div class="row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, el => {
    $('#kf', el).addEventListener('submit', async e => { e.preventDefault(); const f = formData(e.target); for (const x of ['x', 'y', 'z', 'facing_deg', 'floor_id']) f[x] = Number(f[x]);
      try { await api(k.id ? `/api/admin/kiosks/${k.id}` : '/api/admin/kiosks', { method: k.id ? 'PUT' : 'POST', body: f }); el.remove(); toast('Saved.'); PAGES.kiosks(); } catch (err) { toast(err.message, true); } });
  });
};

// ---------------- announcements
PAGES.announcements = async () => {
  const d = await api('/api/admin/announcements'); S.ann = d.items;
  shell('announcements', `<div class="head"><h1>Announcements</h1>${isAdmin() ? `<button class="btn primary" data-act="editann">${icon('plus', 18)}New announcement</button>` : ''}</div>
    <p class="sub">Shown as a banner on the kiosk home screen (holidays, system downtime, moved offices).</p>
    <div class="card"><table class="tbl"><thead><tr><th>Title</th><th>Tone</th><th>Shows</th><th>Status</th><th></th></tr></thead><tbody>
    ${d.items.map(a => `<tr><td><b>${esc(a.title)}</b><div class="small muted">${esc(a.body)}</div></td><td><span class="badge ${a.tone === 'warning' ? 'warn' : a.tone === 'critical' ? 'bad' : 'info'}">${esc(a.tone)}</span></td>
      <td class="small">${when(a.starts_at)}<br>→ ${a.ends_at ? when(a.ends_at) : 'until removed'}</td><td>${a.is_active ? '<span class="badge ok">On</span>' : '<span class="badge">Off</span>'}</td>
      <td class="right">${isAdmin() ? `<button class="btn sm" data-act="editann" data-id="${a.id}">Edit</button> <button class="btn sm danger" data-act="delann" data-id="${a.id}">Delete</button>` : ''}</td></tr>`).join('') || '<tr><td class="muted">No announcements.</td></tr>'}
    </tbody></table></div>`);
};
ACTIONS.editann = b => {
  const a = S.ann.find(x => x.id === Number(b.dataset.id)) || { title: '', body: '', tone: 'info', ends_at: '', is_active: 1 };
  modal(`<h2>${a.id ? 'Edit' : 'New'} announcement</h2><form id="af" class="grid" style="gap:12px">
    <label class="f">Title<input name="title" value="${esc(a.title)}" required maxlength="80"></label><label class="f">Message<textarea name="body" maxlength="240">${esc(a.body)}</textarea></label>
    <label class="f">Tone<select name="tone">${['info', 'warning', 'critical'].map(t => `<option ${a.tone === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f">Hide after (optional)<input type="datetime-local" name="ends_at" value="${esc((a.ends_at || '').replace(' ', 'T').slice(0, 16))}"></label>
    <label class="row small"><input type="checkbox" name="is_active" ${a.is_active ? 'checked' : ''}> Showing on kiosks</label>
    <div class="row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, el => {
    $('#af', el).addEventListener('submit', async e => { e.preventDefault(); const f = formData(e.target); f.is_active = f.is_active ? 1 : 0; f.ends_at = f.ends_at ? new Date(f.ends_at).toISOString().replace('T', ' ').slice(0, 19) : null;
      try { await api(a.id ? `/api/admin/announcements/${a.id}` : '/api/admin/announcements', { method: a.id ? 'PUT' : 'POST', body: f }); el.remove(); toast('Saved.'); PAGES.announcements(); } catch (err) { toast(err.message, true); } });
  });
};
ACTIONS.delann = async b => { if (!confirmInline(b, 'Delete?')) return; await api(`/api/admin/announcements/${b.dataset.id}`, { method: 'DELETE' }); toast('Deleted.'); PAGES.announcements(); };

// ---------------- feedback
PAGES.feedback = async () => {
  const d = await api('/api/admin/feedback');
  shell('feedback', `<div class="head"><h1>Feedback</h1></div><p class="sub">From the “Was this helpful?” buttons on the kiosk and the phone page.</p>
    <div class="card"><table class="tbl"><thead><tr><th></th><th>Service</th><th>Reason</th><th>When</th><th>Status</th></tr></thead><tbody>
    ${d.items.map(f => `<tr><td>${f.helpful ? '<span class="badge ok">Helpful</span>' : '<span class="badge bad">Not helpful</span>'}</td><td>${f.service_id ? `<a href="#/services/${f.service_id}">${esc(f.service)}</a>` : '—'}<div class="small muted">${esc(f.office_name || '')}</div></td>
      <td>${esc(f.reason || '')}<div class="small muted">${esc(f.comment || '')}</div></td><td class="small">${when(f.created_at)}<div class="muted">${esc(f.kiosk_code || 'phone')}</div></td>
      <td>${f.helpful ? '' : `<button class="btn sm ${f.status === 'resolved' ? '' : 'ok'}" data-act="fbres" data-id="${f.id}" data-s="${f.status === 'resolved' ? 'new' : 'resolved'}">${f.status === 'resolved' ? 'Reopen' : 'Mark fixed'}</button>`}</td></tr>`).join('') || '<tr><td class="muted">No feedback yet.</td></tr>'}
    </tbody></table></div>`);
};
ACTIONS.fbres = async b => { await api(`/api/admin/feedback/${b.dataset.id}`, { method: 'PUT', body: { status: b.dataset.s } }); PAGES.feedback(); };

// ---------------- search insights
PAGES.searches = async () => {
  const d = await api('/api/admin/search-logs');
  shell('searches', `<div class="head"><h1>Search insights</h1></div><p class="sub">The words people type tell you what to add. Add a missing word to the right service and the kiosk will find it next time.</p>
    <div class="grid g2"><div class="card"><h2>No results</h2><table class="tbl"><tbody>${d.no_results.map(q => `<tr><td>“${esc(q.query)}”</td><td class="num">${q.n}×</td><td class="right">${can('office_editor') ? `<button class="btn sm" data-act="addkw" data-q="${esc(q.query)}">${icon('plus', 14)}Add to a service</button>` : ''}</td></tr>`).join('') || '<tr><td class="muted">None — every search found something.</td></tr>'}</tbody></table></div>
    <div class="card"><h2>Most searched</h2><table class="tbl"><tbody>${d.top.map(q => `<tr><td>${esc(q.query)}</td><td class="num">${q.n}</td></tr>`).join('') || '<tr><td class="muted">No searches yet.</td></tr>'}</tbody></table></div></div>`);
};
ACTIONS.addkw = b => {
  const word = b.dataset.q.toLowerCase();
  modal(`<h2>Add “${esc(word)}” as a search word</h2><input id="kwq" placeholder="Find the service…" style="width:100%"><div id="kwres" style="margin-top:10px;max-height:320px;overflow:auto"></div><div class="row" style="margin-top:10px"><button class="btn" data-close>Cancel</button></div>`, el => {
    const run = async () => { const r = await api(`/api/admin/services?q=${encodeURIComponent($('#kwq', el).value)}&size=10&status=published`);
      $('#kwres', el).innerHTML = r.items.map(s => `<button class="btn" style="width:100%;justify-content:flex-start;margin-bottom:6px;white-space:normal;text-align:left" data-sid="${s.id}">${esc(s.plain_title || s.title)}<span class="muted small" style="margin-left:auto">${esc(s.office_name)}</span></button>`).join('') || '<p class="muted">No match.</p>'; };
    $('#kwq', el).addEventListener('input', () => { clearTimeout(el.t); el.t = setTimeout(run, 250); }); run();
    $('#kwres', el).addEventListener('click', async e => { const sb = e.target.closest('[data-sid]'); if (!sb) return;
      try { const s = await api(`/api/admin/services/${sb.dataset.sid}`); const r = await api(`/api/admin/services/${s.id}`, { method: 'PUT', body: { keywords: [...s.keywords, word] } }); el.remove(); toast(r.message || `“${word}” now finds ${s.display_title}.`); } catch (err) { toast(err.message, true); } });
  });
};

// ---------------- users
PAGES.users = async () => {
  const d = await api('/api/admin/users'); S.users = d.items;
  shell('users', `<div class="head"><h1>Users</h1><button class="btn primary" data-act="edituser">${icon('plus', 18)}Add user</button></div>
    <p class="sub">Office editors can only change their own office’s services, and their changes wait for LGU admin approval.</p>
    <div class="card"><table class="tbl"><thead><tr><th>Name</th><th>Role</th><th>Office</th><th>Status</th><th></th></tr></thead><tbody>
    ${d.items.map(u => `<tr><td><b>${esc(u.name)}</b><div class="small muted">${esc(u.email)}</div></td><td>${ROLE_LABEL[u.role]}</td><td>${esc(u.office_name || '—')}</td><td>${u.is_active ? '<span class="badge ok">Active</span>' : '<span class="badge">Disabled</span>'}</td>
      <td class="right"><button class="btn sm" data-act="edituser" data-id="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>`);
};
ACTIONS.edituser = b => {
  const u = S.users.find(x => x.id === Number(b.dataset.id)) || { name: '', email: '', role: 'office_editor', office_id: '', is_active: 1 };
  modal(`<h2>${u.id ? 'Edit' : 'Add'} user</h2><form id="uf" class="grid" style="gap:12px">
    <label class="f">Name<input name="name" value="${esc(u.name)}" required></label><label class="f">Email<input name="email" type="email" value="${esc(u.email)}" ${u.id ? 'disabled' : 'required'}></label>
    <label class="f">Role<select name="role">${ROLES.filter(r => r !== 'system_admin' || S.me.role === 'system_admin').map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select></label>
    <label class="f">Office (for office editors)<select name="office_id">${officeOptions(u.office_id, { blank: true })}</select></label>
    <label class="f">${u.id ? 'New password (leave blank to keep)' : 'Password (min 10 characters)'}<input name="password" type="password" minlength="10" ${u.id ? '' : 'required'} autocomplete="new-password"></label>
    ${u.id ? `<label class="row small"><input type="checkbox" name="is_active" ${u.is_active ? 'checked' : ''}> Active</label>` : ''}
    <div class="row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, el => {
    $('#uf', el).addEventListener('submit', async e => { e.preventDefault(); const f = formData(e.target); f.office_id = f.office_id ? Number(f.office_id) : null; if (u.id) f.is_active = f.is_active ? 1 : 0; if (!f.password) delete f.password;
      try { await api(u.id ? `/api/admin/users/${u.id}` : '/api/admin/users', { method: u.id ? 'PUT' : 'POST', body: f }); el.remove(); toast('Saved.'); PAGES.users(); } catch (err) { toast(err.message, true); } });
  });
};

// ---------------- audit
PAGES.audit = async () => {
  const d = await api('/api/admin/audit');
  shell('audit', `<div class="head"><h1>Audit log</h1></div><p class="sub">Every change, who made it and when (last 200).</p>
    <div class="card"><table class="tbl"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>What</th></tr></thead><tbody>
    ${d.items.map(a => `<tr><td class="small">${when(a.created_at)}</td><td>${esc(a.user_name || '—')}</td><td><span class="badge info">${esc(a.action)}</span></td><td>${esc(a.entity)} ${a.entity_id ?? ''}</td></tr>`).join('')}</tbody></table></div>`);
};

// ---------------- navigation (real building): mapping, field verification, publication
const navBadge = s => s === 'verified' ? '<span class="badge ok">Verified</span>' : s === 'draft' ? '<span class="badge warn">Draft</span>' : '<span class="badge bad">Unresolved</span>';
PAGES.navigation = async (version) => {
  const d = await api('/api/admin/navigation');
  const pub = d.publication;
  const head = `<div class="head"><h1>Navigation</h1>${isAdmin() && pub ? `<button class="btn" data-act="navrollback">Roll back publication</button>` : ''}</div>
    <p class="sub">Routes in the real building come only from this published graph. Nothing is shown to visitors as verified until staff have walked it and marked it here.</p>
    <div class="card"><div class="grid g2">
      <div><b>Published</b><div class="small">${pub ? `Model ${esc(pub.model_version)} · calibration ${esc(pub.calibration_version)} · graph ${esc(pub.navigation_version)} · ${when(pub.published_at)}` : '<span class="muted">Nothing published: kiosks use the labelled prototype routes.</span>'}</div></div>
      <div><b>Draft-route preview</b><div class="small">${d.previewUnverified ? '<span class="badge warn">On</span> kiosks opened with <code>?preview=1</code> may show unverified routes, always labelled as drafts.' : '<span class="badge">Off</span> visitors only ever see verified routes.'}
        ${isAdmin() ? ` <button class="btn sm" data-act="navpreview" data-on="${d.previewUnverified ? 0 : 1}">${d.previewUnverified ? 'Turn off' : 'Turn on'}</button>` : ''}</div></div>
    </div></div>
    <div class="card"><h2>Graph revisions</h2><table class="tbl"><thead><tr><th>Version</th><th>Model / calibration</th><th>Segments verified</th><th>Doorways verified</th><th>Status</th><th></th></tr></thead><tbody>
    ${d.revisions.map(r => `<tr data-href="#/navigation/${esc(r.navigation_version)}"><td><b>${esc(r.navigation_version)}</b><div class="small muted">${esc(r.note || '')}</div></td>
      <td class="small">${esc(r.model_version)}<br>${esc(r.calibration_version)} ${navBadge(d.calibrations.find(c => c.calibration_version === r.calibration_version)?.status)}</td>
      <td class="num">${r.verified_edges} / ${r.edges}</td><td class="num">${r.verified_openings} / ${r.openings}</td><td>${statusBadge(r.status)}</td>
      <td class="right">${isAdmin() && r.status !== 'published' ? `<button class="btn sm primary" data-act="navpublish" data-v="${esc(r.navigation_version)}">Publish</button>` : ''}</td></tr>`).join('') || '<tr><td class="muted">No graph imported yet (POST /api/admin/navigation/import with tools/model/pilot-graph.mjs output).</td></tr>'}
    </tbody></table></div>`;
  if (!version) return shell('navigation', head);

  const [{ graph: g, report: rep, calibration: cal }, rooms] = [await api(`/api/admin/navigation/${encodeURIComponent(version)}`), (await api('/api/admin/rooms')).items];
  S.navVersion = version; S.navGraph = g;
  const roomOpts = sel => `<option value="">— not mapped —</option>` + rooms.map(r => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.code)} · ${esc(r.name)}</option>`).join('');
  const issues = [
    ...rep.structural.map(s => `Structure: ${s}`),
    rep.calibration?.status !== 'verified' ? `Calibration ${rep.calibration?.version || ''} is not verified: the 3D view is only shown for labelled draft routes.` : null,
    ...rep.floorElevationMismatch,
    rep.unresolvedOpenings.length ? `${rep.unresolvedOpenings.length} doorways have no confirmed office.` : null,
    rep.unmappedSigns ? `${rep.unmappedSigns} sign faces stay blank until their doorway is verified.` : null,
    rep.activeKiosksWithoutNode.length ? `Kiosks without a start position in this graph: ${rep.activeKiosksWithoutNode.join(', ')}.` : null,
  ].filter(Boolean);
  shell('navigation', `${head}
    <div class="card"><h2>${esc(g.navigationVersion)} — what still needs checking</h2>
      ${issues.length ? `<ul class="small">${issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="small">No open issues.</p>'}
      ${g.fieldVerificationNeeded?.length ? `<h3>Field checks</h3><ol class="small">${g.fieldVerificationNeeded.map(f => `<li>${esc(f)}</li>`).join('')}</ol>` : ''}
    </div>
    <div class="card"><h2>Route checks</h2><table class="tbl"><thead><tr><th>From</th><th>To doorway</th><th>Visitors (verified only)</th><th>Draft preview</th><th>Step-free</th></tr></thead><tbody>
      ${rep.routes.map(r => `<tr><td>${esc(r.kiosk)}</td><td>${esc(r.opening)}</td><td>${r.strict === 'ok' ? '<span class="badge ok">Route</span>' : `<span class="badge bad">${esc(r.strict)}</span>`}</td><td class="small">${esc(r.preview)}</td><td>${r.stepFree === 'ok' ? '<span class="badge ok">Route</span>' : `<span class="badge">${esc(r.stepFree)}</span>`}</td></tr>`).join('') || '<tr><td class="muted">No doorway has an approach point yet.</td></tr>'}
    </tbody></table></div>
    <div class="card"><h2>Doorways → offices</h2><p class="sub">Map a doorway only after confirming on site which office uses it. "Verified" needs a room and an approach point; the sign faces follow.</p>
      <table class="tbl"><thead><tr><th>Doorway</th><th>Room</th><th>Status</th><th></th></tr></thead><tbody>
      ${g.openings.map(o => `<tr><td><b>${esc(o.openingId)}</b><div class="small muted">${esc(o.label || '')}${o.approachNodeId ? ` · approach ${esc(o.approachNodeId)}` : ' · no approach point'}</div></td>
        <td><select data-oroom="${esc(o.openingId)}" ${isAdmin() ? '' : 'disabled'}>${roomOpts(o.roomId)}</select></td>
        <td><select data-ostatus="${esc(o.openingId)}" ${isAdmin() ? '' : 'disabled'}>${['unresolved', 'draft', 'verified'].map(s => `<option ${o.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
        <td class="right">${isAdmin() ? `<button class="btn sm" data-act="navopening" data-o="${esc(o.openingId)}">Save</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
    <div class="card"><h2>Segments</h2><p class="sub">Mark a segment verified after walking it. Step-free stays "unknown" until checked; unknown is never offered to visitors who avoid stairs.</p>
      <table class="tbl"><thead><tr><th>Segment</th><th>Kind</th><th>Length</th><th>Verified</th><th>Step-free</th><th>Open</th></tr></thead><tbody>
      ${g.edges.map(e => `<tr><td><b>${esc(e.id)}</b><div class="small muted">${esc(e.from)} → ${esc(e.to)}${e.label ? ` · ${esc(e.label)}` : ''}${e.public ? '' : ' · <b>not public</b>'}</div></td>
        <td>${esc(e.kind)}</td><td class="num">${e.length_m.toFixed(1)} m</td>
        <td>${isAdmin() ? `<button class="btn sm ${e.verified ? 'ok' : ''}" data-act="navedge" data-e="${esc(e.id)}" data-f="verified" data-val="${e.verified ? 0 : 1}">${e.verified ? 'Verified' : 'Mark verified'}</button>` : e.verified ? 'yes' : 'no'}</td>
        <td>${e.kind === 'stairs' ? '<span class="badge">No (stairs)</span>' : isAdmin() ? `<select data-esf="${esc(e.id)}">${[['', 'unknown'], ['1', 'yes'], ['0', 'no']].map(([v, l]) => `<option value="${v}" ${String(e.step_free === null ? '' : e.step_free ? 1 : 0) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : esc(String(e.step_free ?? 'unknown'))}</td>
        <td>${isAdmin() ? `<button class="btn sm ${e.closed ? 'danger' : ''}" data-act="navedge" data-e="${esc(e.id)}" data-f="closed" data-val="${e.closed ? 0 : 1}">${e.closed ? 'Closed — reopen' : 'Close'}</button>` : e.closed ? 'closed' : 'open'}</td></tr>`).join('')}
      </tbody></table></div>`);
  document.querySelectorAll('[data-esf]').forEach(sel => sel.addEventListener('change', async () => {
    const v = sel.value === '' ? null : sel.value === '1';
    try { await api(`/api/admin/navigation/${encodeURIComponent(S.navVersion)}/edges/${encodeURIComponent(sel.dataset.esf)}`, { method: 'PUT', body: { step_free: v } }); toast('Saved.'); } catch (err) { toast(err.message, true); }
  }));
};
ACTIONS.navpublish = async b => {
  if (!confirmInline(b, 'Publish to kiosks?')) return;
  try { await api(`/api/admin/navigation/${encodeURIComponent(b.dataset.v)}/publish`, { method: 'POST' }); toast('Published. Kiosks pick it up on their next sync.'); route(); } catch (err) { toast(err.message, true); }
};
ACTIONS.navrollback = async b => {
  if (!confirmInline(b, 'Roll back?')) return;
  try { const r = await api('/api/admin/navigation/rollback', { method: 'POST' }); toast(r.nowPublished ? `Back to ${r.nowPublished}.` : 'Nothing published now: kiosks use prototype routes.'); route(); } catch (err) { toast(err.message, true); }
};
ACTIONS.navpreview = async b => { await api('/api/admin/navigation-preview', { method: 'PUT', body: { enabled: b.dataset.on === '1' } }); route(); };
ACTIONS.navedge = async b => {
  try { await api(`/api/admin/navigation/${encodeURIComponent(S.navVersion)}/edges/${encodeURIComponent(b.dataset.e)}`, { method: 'PUT', body: { [b.dataset.f]: b.dataset.val === '1' } }); route(); } catch (err) { toast(err.message, true); }
};
ACTIONS.navopening = async b => {
  const o = b.dataset.o, room = document.querySelector(`[data-oroom="${CSS.escape(o)}"]`).value, status = document.querySelector(`[data-ostatus="${CSS.escape(o)}"]`).value;
  try { await api(`/api/admin/navigation/${encodeURIComponent(S.navVersion)}/openings/${encodeURIComponent(o)}`, { method: 'PUT', body: { room_id: room ? Number(room) : null, status } }); toast('Saved.'); route(); } catch (err) { toast(err.message, true); }
};

// ------------------------------------------------------------------ router
async function route() {
  if (!S.me) return;
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [page = 'dashboard', id] = path.split('/');
  const fn = PAGES[page] || PAGES.dashboard;
  try { await fn(id, qs); window.scrollTo(0, 0); }
  catch (e) { if (e.message !== 'Signed out') { shell(page, `<div class="notice bad">${icon('alert', 18)}<span>${esc(e.message)}</span></div>`); } }
}
addEventListener('hashchange', route);
async function boot() {
  try { S.me = await api('/api/auth/me'); } catch { return renderLogin(); }
  await loadOffices(); await refreshPending();
  route();
}
boot();
