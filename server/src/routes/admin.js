// Admin API: requires sign-in. Roles: viewer < office_editor < lgu_admin < system_admin.
import express from 'express';
import { all, get, run, tx, bumpContentVersion, setting } from '../db.js';
import { requireRole, canEditOffice, audit, createSession, destroySession, currentUser, verifyPassword, hashPassword } from '../auth.js';
import { invalidateSearchIndex } from '../search.js';
import { serviceDetail, officeLocation, locationPayload, floorsWithRooms } from '../lib/data.js';

export const authApi = express.Router();
export const adminApi = express.Router();
const int = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const changed = () => { bumpContentVersion(); invalidateSearchIndex(); };
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ============================================================ auth
authApi.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = get('SELECT * FROM users WHERE lower(email) = lower(?)', [String(email || '')]);
  if (!u || !u.is_active) return bad(res, 'Email or password is incorrect.', 401);
  if (u.locked_until && new Date(u.locked_until) > new Date()) return bad(res, 'Account locked after too many failed attempts. Try again in 15 minutes or ask an admin.', 423);
  if (!verifyPassword(String(password || ''), u.password_hash)) {
    const fails = u.failed_logins + 1;
    run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?',
      [fails >= 5 ? 0 : fails, fails >= 5 ? new Date(Date.now() + 15 * 60e3).toISOString() : null, u.id]);
    return bad(res, 'Email or password is incorrect.', 401);
  }
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [u.id]);
  const { token, expires } = createSession(u.id);
  audit(u, 'login', 'user', u.id);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', expires: new Date(expires) });
  res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role, office_id: u.office_id } });
});
authApi.post('/logout', (req, res) => {
  const u = currentUser(req);
  if (u) destroySession(u.token);
  res.clearCookie('sid');
  res.json({ ok: true });
});
authApi.get('/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return bad(res, 'Not signed in', 401);
  const office = u.office_id ? get('SELECT id, name FROM offices WHERE id = ?', [u.office_id]) : null;
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role, office_id: u.office_id, office });
});

// ============================================================ dashboard
adminApi.get('/dashboard', requireRole('viewer'), (req, res) => {
  const one = (sql, p = []) => Object.values(get(sql, p) || { v: 0 })[0] ?? 0;
  const byHour = all(`SELECT CAST(strftime('%H', started_at, 'localtime') AS INTEGER) AS hour, count(*) AS n FROM session_logs
                       WHERE date(started_at, 'localtime') = date('now', 'localtime') GROUP BY hour ORDER BY hour`);
  res.json({
    content_version: Number(setting('content_version', '1')),
    sessions_today: one(`SELECT count(*) FROM session_logs WHERE date(started_at,'localtime') = date('now','localtime')`),
    searches_today: one(`SELECT count(*) FROM search_logs WHERE date(created_at,'localtime') = date('now','localtime')`),
    no_result_7d: one(`SELECT count(*) FROM search_logs WHERE results_count = 0 AND created_at >= datetime('now','-7 days')`),
    helpful_30d: get(`SELECT count(*) AS total, sum(helpful) AS yes FROM feedback WHERE created_at >= datetime('now','-30 days')`),
    services: get(`SELECT count(*) AS total, sum(status='published') AS published, sum(pending_json IS NOT NULL) AS pending,
                          sum(verified_at IS NULL) AS never_verified, sum(verified_at < datetime('now','-180 days')) AS stale,
                          sum(parse_quality='needs_review') AS needs_review FROM services WHERE status != 'archived'`),
    kiosks: all(`SELECT code, name, last_heartbeat, app_version, content_version,
                        CASE WHEN last_heartbeat >= datetime('now','-10 minutes') THEN 'online' ELSE 'offline' END AS status FROM kiosks WHERE is_active = 1`),
    sessions_by_hour: byHour,
    top_services: all(`SELECT id, COALESCE(plain_title,title) AS title, view_count FROM services WHERE view_count > 0 ORDER BY view_count DESC LIMIT 6`),
    no_result_queries: all(`SELECT query, count(*) AS n, max(created_at) AS last FROM search_logs WHERE results_count = 0 GROUP BY query ORDER BY n DESC, last DESC LIMIT 8`),
    recent_feedback: all(`SELECT f.id, f.helpful, f.reason, f.comment, f.created_at, COALESCE(s.plain_title, s.title) AS service FROM feedback f LEFT JOIN services s ON s.id = f.service_id ORDER BY f.id DESC LIMIT 6`),
  });
});

// ============================================================ services
const SERVICE_FIELDS = ['office_id', 'title', 'plain_title', 'description', 'office_division', 'classification', 'transaction_type', 'who_may_avail', 'total_fees', 'total_processing_time', 'period_of_extension', 'notes', 'is_citizen_facing'];

adminApi.get('/services', requireRole('viewer'), (req, res) => {
  const where = [`s.status != 'archived'`]; const p = [];
  if (req.query.q) { where.push(`(s.title LIKE ? OR s.plain_title LIKE ? OR o.name LIKE ?)`); const q = `%${req.query.q}%`; p.push(q, q, q); }
  if (req.query.office_id) { where.push('s.office_id = ?'); p.push(int(req.query.office_id)); }
  if (req.query.status === 'pending') where.push('s.pending_json IS NOT NULL');
  else if (req.query.status === 'needs_review') where.push(`s.parse_quality = 'needs_review' AND s.verified_at IS NULL`);
  else if (req.query.status === 'unverified') where.push('s.verified_at IS NULL');
  else if (req.query.status) { where.push('s.status = ?'); p.push(req.query.status); }
  if (req.query.citizen === '1') where.push('s.is_citizen_facing = 1');
  const page = Math.max(1, int(req.query.page) || 1), size = Math.min(100, int(req.query.size) || 25);
  const base = `FROM services s JOIN offices o ON o.id = s.office_id WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT count(*) AS n ${base}`, p).n;
  const items = all(`SELECT s.id, s.title, s.plain_title, s.status, s.is_citizen_facing, s.verified_at, s.view_count, s.parse_quality, s.source,
                            s.pending_json IS NOT NULL AS has_pending, s.updated_at, o.id AS office_id, o.name AS office_name ${base}
                       ORDER BY o.name, s.title LIMIT ? OFFSET ?`, [...p, size, (page - 1) * size]);
  res.json({ total, page, size, items });
});

adminApi.get('/services/:id', requireRole('viewer'), (req, res) => {
  const s = serviceDetail(int(req.params.id), { includeUnpublished: true });
  if (!s) return bad(res, 'Not found', 404);
  res.json(s);
});

function writeServiceChildren(id, body) {
  if (Array.isArray(body.requirements)) {
    run('DELETE FROM service_requirements WHERE service_id = ?', [id]);
    body.requirements.filter(r => r.requirement?.trim()).forEach((r, i) =>
      run('INSERT INTO service_requirements(service_id, sort, requirement, where_to_secure) VALUES (?,?,?,?)', [id, i, r.requirement.trim(), r.where_to_secure || '']));
  }
  if (Array.isArray(body.steps)) {
    run('DELETE FROM service_steps WHERE service_id = ?', [id]);
    body.steps.filter(s => (s.client_action || s.agency_action || '').trim()).forEach((s, i) =>
      run('INSERT INTO service_steps(service_id, sort, client_action, agency_action, fee, processing_time, person_in_charge) VALUES (?,?,?,?,?,?,?)',
        [id, i, s.client_action || '', s.agency_action || '', s.fee || '', s.processing_time || '', s.person_in_charge || '']));
  }
  if (Array.isArray(body.keywords)) {
    run('DELETE FROM service_keywords WHERE service_id = ?', [id]);
    [...new Set(body.keywords.map(k => String(k).trim().toLowerCase()).filter(Boolean))].forEach(k => run('INSERT INTO service_keywords(service_id, keyword) VALUES (?,?)', [id, k]));
  }
}
function applyServiceFields(id, body) {
  const sets = [], p = [];
  for (const f of SERVICE_FIELDS) if (f in body) { sets.push(`${f} = ?`); p.push(f === 'is_citizen_facing' ? (body[f] ? 1 : 0) : body[f]); }
  if (sets.length) run(`UPDATE services SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...p, id]);
  writeServiceChildren(id, body);
}

adminApi.post('/services', requireRole('office_editor'), (req, res) => {
  const b = req.body || {};
  if (!b.title?.trim() || !b.office_id) return bad(res, 'Title and office are required.');
  if (!canEditOffice(req.user, b.office_id)) return bad(res, 'You can only add services for your own office.', 403);
  const isAdmin = ['lgu_admin', 'system_admin'].includes(req.user.role);
  const id = tx(() => {
    const id = run(`INSERT INTO services(office_id, title, status, source) VALUES (?,?,?,?)`, [b.office_id, b.title.trim(), isAdmin && b.publish ? 'published' : 'draft', 'Added in admin panel']).lastId;
    applyServiceFields(id, b);
    return id;
  });
  audit(req.user, 'create', 'service', id, null, b);
  changed();
  res.status(201).json(serviceDetail(id, { includeUnpublished: true }));
});

adminApi.put('/services/:id', requireRole('office_editor'), (req, res) => {
  const id = int(req.params.id);
  const before = serviceDetail(id, { includeUnpublished: true });
  if (!before) return bad(res, 'Not found', 404);
  if (!canEditOffice(req.user, before.office_id)) return bad(res, 'You can only edit your own office’s services.', 403);
  const isAdmin = ['lgu_admin', 'system_admin'].includes(req.user.role);
  if (!isAdmin && before.status === 'published') {
    // editors propose; the published version stays live until approved
    run(`UPDATE services SET pending_json = ?, pending_by = ?, pending_at = datetime('now') WHERE id = ?`, [JSON.stringify(req.body), req.user.id, id]);
    audit(req.user, 'propose', 'service', id, null, req.body);
    return res.json({ ...serviceDetail(id, { includeUnpublished: true }), message: 'Saved. Waiting for approval by the LGU admin before it shows on the kiosk.' });
  }
  tx(() => applyServiceFields(id, req.body || {}));
  if (req.body?.verify) run(`UPDATE services SET verified_at = datetime('now'), verified_by = ? WHERE id = ?`, [req.user.id, id]);
  audit(req.user, 'update', 'service', id, before, req.body);
  changed();
  res.json(serviceDetail(id, { includeUnpublished: true }));
});

adminApi.post('/services/:id/approve', requireRole('lgu_admin'), (req, res) => {
  const id = int(req.params.id);
  const s = get('SELECT pending_json FROM services WHERE id = ?', [id]);
  if (!s?.pending_json) return bad(res, 'Nothing waiting for approval.');
  const before = serviceDetail(id, { includeUnpublished: true });
  tx(() => {
    applyServiceFields(id, JSON.parse(s.pending_json));
    run(`UPDATE services SET pending_json = NULL, pending_by = NULL, pending_at = NULL, verified_at = datetime('now'), verified_by = ? WHERE id = ?`, [req.user.id, id]);
  });
  audit(req.user, 'approve', 'service', id, before, JSON.parse(s.pending_json));
  changed();
  res.json(serviceDetail(id, { includeUnpublished: true }));
});
adminApi.post('/services/:id/reject', requireRole('lgu_admin'), (req, res) => {
  const id = int(req.params.id);
  run(`UPDATE services SET pending_json = NULL, pending_by = NULL, pending_at = NULL WHERE id = ?`, [id]);
  audit(req.user, 'reject', 'service', id, null, { note: req.body?.note || null });
  res.json({ ok: true });
});
adminApi.post('/services/:id/status', requireRole('lgu_admin'), (req, res) => {
  const id = int(req.params.id), status = req.body?.status;
  if (!['draft', 'published', 'archived'].includes(status)) return bad(res, 'Invalid status');
  run(`UPDATE services SET status = ?, updated_at = datetime('now') WHERE id = ?`, [status, id]);
  audit(req.user, 'status', 'service', id, null, { status });
  changed();
  res.json({ ok: true });
});
adminApi.post('/services/:id/verify', requireRole('office_editor'), (req, res) => {
  const id = int(req.params.id);
  const s = get('SELECT office_id FROM services WHERE id = ?', [id]);
  if (!s) return bad(res, 'Not found', 404);
  if (!canEditOffice(req.user, s.office_id)) return bad(res, 'Not your office.', 403);
  run(`UPDATE services SET verified_at = datetime('now'), verified_by = ? WHERE id = ?`, [req.user.id, id]);
  audit(req.user, 'verify', 'service', id);
  changed();
  res.json({ ok: true });
});

// ============================================================ offices & locations
adminApi.get('/offices', requireRole('viewer'), (req, res) => {
  const items = all(`SELECT o.*, (SELECT count(*) FROM services s WHERE s.office_id = o.id AND s.status != 'archived') AS service_count FROM offices o ORDER BY o.name`)
    .map(o => ({ ...o, location: locationPayload(officeLocation(o.id)) }));
  res.json({ items });
});
adminApi.post('/offices', requireRole('lgu_admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim()) return bad(res, 'Name is required.');
  const id = run(`INSERT INTO offices(name, short_name, description, head, phone, email, hours, location_type, offsite_address) VALUES (?,?,?,?,?,?,?,?,?)`,
    [b.name.trim(), b.short_name, b.description, b.head, b.phone, b.email, b.hours || undefined, b.location_type || 'in_building', b.offsite_address]).lastId;
  audit(req.user, 'create', 'office', id, null, b); changed();
  res.status(201).json(get('SELECT * FROM offices WHERE id = ?', [id]));
});
adminApi.put('/offices/:id', requireRole('office_editor'), (req, res) => {
  const id = int(req.params.id);
  if (!canEditOffice(req.user, id)) return bad(res, 'Not your office.', 403);
  const before = get('SELECT * FROM offices WHERE id = ?', [id]);
  if (!before) return bad(res, 'Not found', 404);
  const fields = ['name', 'short_name', 'description', 'head', 'phone', 'email', 'hours', 'location_type', 'offsite_address', 'is_active'];
  const sets = [], p = [];
  for (const f of fields) if (f in (req.body || {})) { sets.push(`${f} = ?`); p.push(req.body[f]); }
  if (sets.length) run(`UPDATE offices SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...p, id]);
  audit(req.user, 'update', 'office', id, before, req.body); changed();
  res.json(get('SELECT * FROM offices WHERE id = ?', [id]));
});

// Move an office to another room. Closes the current assignment and opens a new one.
adminApi.post('/offices/:id/move', requireRole('lgu_admin'), (req, res) => {
  const id = int(req.params.id), roomId = int(req.body?.room_id);
  const office = get('SELECT * FROM offices WHERE id = ?', [id]);
  const room = get('SELECT * FROM rooms WHERE id = ? AND is_active = 1', [roomId]);
  if (!office || !room) return bad(res, 'Office or room not found.', 404);
  const before = officeLocation(id);
  if (before?.room_id === roomId) return bad(res, 'The office is already in that room.');
  const occupants = all(`SELECT o.id, o.name FROM offices o JOIN office_locations ol ON ol.office_id = o.id
    WHERE ol.room_id = ? AND ol.valid_to IS NULL AND ol.is_primary = 1 AND o.id != ? ORDER BY o.id`, [roomId, id]);
  const b = req.body || {}, mode = b.occupancy || 'move';
  if (b.note != null && (typeof b.note !== 'string' || b.note.length > 500)) return bad(res, 'Reason must be text, up to 500 characters.');
  if (!['move', 'share', 'replace', 'swap'].includes(mode)) return bad(res, 'Choose how to handle the current occupants.');
  if (occupants.length && mode === 'move') return bad(res, 'This room is occupied. Choose share, replace, or swap.', 409);
  // The dialog sends the assignments it displayed. A concurrent edit must be reviewed again.
  if (Object.hasOwn(b, 'expected_room_id') && b.expected_room_id !== (before?.room_id ?? null))
    return bad(res, 'This office has moved since you opened the form. Refresh and try again.', 409);
  if (Object.hasOwn(b, 'expected_occupant_ids')) {
    if (!Array.isArray(b.expected_occupant_ids)) return bad(res, 'Expected occupants must be a list.');
    const expected = [...b.expected_occupant_ids].sort((a, b) => a - b);
    if (JSON.stringify(expected) !== JSON.stringify(occupants.map(o => o.id)))
      return bad(res, 'The room occupants have changed. Refresh and review the assignment again.', 409);
  }
  if (mode === 'swap') {
    const source = before?.room_id && get('SELECT id FROM rooms WHERE id = ? AND is_active = 1', [before.room_id]);
    const sourceOthers = source && get('SELECT count(*) AS n FROM office_locations WHERE room_id = ? AND valid_to IS NULL AND is_primary = 1 AND office_id != ?', [source.id, id]).n;
    if (!source || occupants.length !== 1 || sourceOthers) return bad(res, 'Swap needs one office in each of two active rooms.');
  }
  const displaced = occupants.map(o => ({ ...o, before: officeLocation(o.id) }));
  const note = b.note?.trim() || null;
  const closeLocation = officeId => run(`UPDATE office_locations SET valid_to = datetime('now') WHERE office_id = ? AND valid_to IS NULL`, [officeId]);
  const assign = (officeId, target) => {
    run('INSERT INTO office_locations(office_id, room_id, note, changed_by) VALUES (?,?,?,?)', [officeId, target, note, req.user.id]);
    run(`UPDATE offices SET location_type = 'in_building', updated_at = datetime('now') WHERE id = ?`, [officeId]);
  };
  tx(() => {
    closeLocation(id);
    if (mode === 'replace' || mode === 'swap') for (const o of displaced) {
      closeLocation(o.id);
      if (mode === 'swap') assign(o.id, before.room_id);
      else run(`UPDATE offices SET location_type = 'unconfirmed', updated_at = datetime('now') WHERE id = ?`, [o.id]);
      audit(req.user, mode, 'office', o.id, o.before, { ...officeLocation(o.id), note, replaced_by: id });
    }
    assign(id, roomId);
    audit(req.user, 'move', 'office', id, before, { ...officeLocation(id), occupancy: mode, note });
    changed();
  });
  const after = officeLocation(id);
  res.json({ ok: true, location: locationPayload(after) });
});
adminApi.get('/offices/:id/history', requireRole('viewer'), (req, res) => {
  res.json({ items: all(`SELECT ol.*, r.code AS room_code, r.name AS room_name, f.name AS floor_name, u.name AS changed_by_name
                           FROM office_locations ol JOIN rooms r ON r.id = ol.room_id JOIN floors f ON f.id = r.floor_id
                           LEFT JOIN users u ON u.id = ol.changed_by WHERE ol.office_id = ? ORDER BY ol.valid_from DESC, ol.id DESC`, [int(req.params.id)]) });
});

// ============================================================ floors & rooms (dynamic x, y, z)
adminApi.get('/floors', requireRole('viewer'), (req, res) => res.json({ items: floorsWithRooms() }));
adminApi.put('/floors/:id', requireRole('lgu_admin'), (req, res) => {
  const id = int(req.params.id);
  const fields = ['name', 'elevation_y', 'plan_image', 'bounds_min_x', 'bounds_max_x', 'bounds_min_z', 'bounds_max_z'];
  const sets = [], p = [];
  for (const f of fields) if (f in (req.body || {})) { sets.push(`${f} = ?`); p.push(req.body[f]); }
  if (sets.length) run(`UPDATE floors SET ${sets.join(', ')} WHERE id = ?`, [...p, id]);
  audit(req.user, 'update', 'floor', id, null, req.body); changed();
  res.json(get('SELECT * FROM floors WHERE id = ?', [id]));
});

const ROOM_FIELDS = ['floor_id', 'code', 'name', 'room_type', 'x', 'y', 'z', 'approach_x', 'approach_y', 'approach_z', 'facing_deg', 'width_m', 'depth_m', 'is_accessible', 'is_active', 'photo_url', 'notes'];
const NUMERIC = new Set(['x', 'y', 'z', 'approach_x', 'approach_y', 'approach_z', 'facing_deg', 'width_m', 'depth_m']);
function validRoom(b, partial) {
  for (const f of NUMERIC) if (f in b && b[f] !== null && b[f] !== '' && !Number.isFinite(Number(b[f]))) return `${f} must be a number (metres).`;
  if (!partial && (!b.code?.trim() || !b.name?.trim() || !b.floor_id)) return 'Code, name and floor are required.';
  return null;
}
adminApi.get('/rooms', requireRole('viewer'), (req, res) => res.json({ items: all(`SELECT r.*, f.level AS floor_level, f.name AS floor_name FROM rooms r JOIN floors f ON f.id = r.floor_id ORDER BY r.code`) }));
adminApi.post('/rooms', requireRole('lgu_admin'), (req, res) => {
  const b = req.body || {}; const err = validRoom(b, false); if (err) return bad(res, err);
  if (get('SELECT id FROM rooms WHERE code = ?', [b.code.trim()])) return bad(res, 'A room with that code already exists.');
  const floor = get('SELECT * FROM floors WHERE id = ?', [int(b.floor_id)]);
  const id = run(`INSERT INTO rooms(floor_id, code, name, room_type, x, y, z, approach_x, approach_y, approach_z, facing_deg, width_m, depth_m, is_accessible, coord_source, notes)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'manual', ?)`,
    [floor.id, b.code.trim(), b.name.trim(), b.room_type || 'office', num(b.x) ?? 0, num(b.y) ?? floor.elevation_y, num(b.z) ?? 0,
     num(b.approach_x), num(b.approach_y), num(b.approach_z), num(b.facing_deg) ?? 0, num(b.width_m) ?? 6, num(b.depth_m) ?? 6, b.is_accessible === 0 ? 0 : 1, b.notes || null]).lastId;
  audit(req.user, 'create', 'room', id, null, b); changed();
  res.status(201).json(get('SELECT * FROM rooms WHERE id = ?', [id]));
});
adminApi.put('/rooms/:id', requireRole('lgu_admin'), (req, res) => {
  const id = int(req.params.id), b = req.body || {};
  const before = get('SELECT * FROM rooms WHERE id = ?', [id]);
  if (!before) return bad(res, 'Not found', 404);
  const err = validRoom(b, true); if (err) return bad(res, err);
  const sets = [], p = [];
  for (const f of ROOM_FIELDS) if (f in b) { sets.push(`${f} = ?`); p.push(NUMERIC.has(f) ? num(b[f]) : b[f]); }
  if (sets.length) run(`UPDATE rooms SET ${sets.join(', ')}, coord_source = CASE WHEN ? THEN 'manual' ELSE coord_source END, updated_at = datetime('now') WHERE id = ?`,
    [...p, ['x', 'y', 'z', 'approach_x', 'approach_y', 'approach_z'].some(f => f in b) ? 1 : 0, id]);
  audit(req.user, 'update', 'room', id, before, b); changed();
  res.json(get('SELECT * FROM rooms WHERE id = ?', [id]));
});
adminApi.delete('/rooms/:id', requireRole('lgu_admin'), (req, res) => {
  const id = int(req.params.id);
  if (get('SELECT id FROM office_locations WHERE room_id = ? AND valid_to IS NULL', [id])) return bad(res, 'An office is in this room. Move the office first.');
  run(`UPDATE rooms SET is_active = 0, updated_at = datetime('now') WHERE id = ?`, [id]);
  audit(req.user, 'deactivate', 'room', id); changed();
  res.json({ ok: true });
});

// Bulk coordinate sync from the Unity editor (Kiosk > Sync Room Markers).
// Body: { items: [{ code, x, y, z, approach_x, approach_y, approach_z, facing_deg }] }
adminApi.post('/rooms/sync-from-unity', requireRole('lgu_admin'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const updated = [], unknown = [];
  tx(() => {
    for (const it of items) {
      const r = get('SELECT id FROM rooms WHERE code = ?', [String(it.code || '')]);
      if (!r) { unknown.push(it.code); continue; }
      run(`UPDATE rooms SET x = ?, y = ?, z = ?, approach_x = ?, approach_y = ?, approach_z = ?, facing_deg = COALESCE(?, facing_deg),
                            coord_source = 'unity_sync', updated_at = datetime('now') WHERE id = ?`,
        [num(it.x), num(it.y), num(it.z), num(it.approach_x ?? it.x), num(it.approach_y ?? it.y), num(it.approach_z ?? it.z), num(it.facing_deg), r.id]);
      updated.push(it.code);
    }
  });
  audit(req.user, 'unity_sync', 'room', null, null, { updated, unknown });
  if (updated.length) changed();
  res.json({ updated, unknown });
});

// ============================================================ kiosks
adminApi.get('/kiosks', requireRole('viewer'), (req, res) => res.json({ items: all(`SELECT k.*, f.name AS floor_name,
  CASE WHEN last_heartbeat >= datetime('now','-10 minutes') THEN 'online' ELSE 'offline' END AS status FROM kiosks k JOIN floors f ON f.id = k.floor_id ORDER BY k.code`) }));
adminApi.post('/kiosks', requireRole('lgu_admin'), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.name || !b.floor_id) return bad(res, 'Code, name and floor are required.');
  const id = run('INSERT INTO kiosks(code, name, floor_id, x, y, z, facing_deg) VALUES (?,?,?,?,?,?,?)', [b.code, b.name, int(b.floor_id), num(b.x) ?? 0, num(b.y) ?? 0, num(b.z) ?? 0, num(b.facing_deg) ?? 0]).lastId;
  audit(req.user, 'create', 'kiosk', id, null, b); changed();
  res.status(201).json(get('SELECT * FROM kiosks WHERE id = ?', [id]));
});
adminApi.put('/kiosks/:id', requireRole('lgu_admin'), (req, res) => {
  const id = int(req.params.id), b = req.body || {};
  const sets = [], p = [];
  for (const f of ['name', 'floor_id', 'x', 'y', 'z', 'facing_deg', 'is_active']) if (f in b) { sets.push(`${f} = ?`); p.push(b[f]); }
  if (sets.length) run(`UPDATE kiosks SET ${sets.join(', ')} WHERE id = ?`, [...p, id]);
  audit(req.user, 'update', 'kiosk', id, null, b); changed();
  res.json(get('SELECT * FROM kiosks WHERE id = ?', [id]));
});

// ============================================================ announcements
adminApi.get('/announcements', requireRole('viewer'), (req, res) => res.json({ items: all('SELECT * FROM announcements ORDER BY id DESC') }));
adminApi.post('/announcements', requireRole('lgu_admin'), (req, res) => {
  const b = req.body || {};
  if (!b.title?.trim()) return bad(res, 'Title is required.');
  const id = run('INSERT INTO announcements(title, body, tone, starts_at, ends_at, is_active) VALUES (?,?,?,COALESCE(?, datetime(\'now\')),?,?)',
    [b.title.trim(), b.body || '', b.tone || 'info', b.starts_at || null, b.ends_at || null, b.is_active === 0 ? 0 : 1]).lastId;
  audit(req.user, 'create', 'announcement', id, null, b); changed();
  res.status(201).json(get('SELECT * FROM announcements WHERE id = ?', [id]));
});
adminApi.put('/announcements/:id', requireRole('lgu_admin'), (req, res) => {
  const id = int(req.params.id), b = req.body || {};
  const sets = [], p = [];
  for (const f of ['title', 'body', 'tone', 'starts_at', 'ends_at', 'is_active']) if (f in b) { sets.push(`${f} = ?`); p.push(b[f]); }
  if (sets.length) run(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`, [...p, id]);
  audit(req.user, 'update', 'announcement', id, null, b); changed();
  res.json(get('SELECT * FROM announcements WHERE id = ?', [id]));
});
adminApi.delete('/announcements/:id', requireRole('lgu_admin'), (req, res) => {
  run('DELETE FROM announcements WHERE id = ?', [int(req.params.id)]);
  audit(req.user, 'delete', 'announcement', int(req.params.id)); changed();
  res.json({ ok: true });
});

// ============================================================ feedback, search logs, audit
adminApi.get('/feedback', requireRole('viewer'), (req, res) => res.json({ items: all(`SELECT f.*, COALESCE(s.plain_title, s.title) AS service, o.name AS office_name
  FROM feedback f LEFT JOIN services s ON s.id = f.service_id LEFT JOIN offices o ON o.id = s.office_id ORDER BY f.id DESC LIMIT 200`) }));
adminApi.put('/feedback/:id', requireRole('office_editor'), (req, res) => {
  run('UPDATE feedback SET status = ? WHERE id = ?', [req.body?.status === 'resolved' ? 'resolved' : 'new', int(req.params.id)]);
  res.json({ ok: true });
});
adminApi.get('/search-logs', requireRole('viewer'), (req, res) => res.json({
  no_results: all(`SELECT query, count(*) AS n, max(created_at) AS last FROM search_logs WHERE results_count = 0 GROUP BY query ORDER BY n DESC LIMIT 50`),
  top: all(`SELECT query, count(*) AS n FROM search_logs GROUP BY query ORDER BY n DESC LIMIT 50`),
}));
adminApi.get('/audit', requireRole('lgu_admin'), (req, res) => res.json({ items: all(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200`) }));

// ============================================================ users
adminApi.get('/users', requireRole('lgu_admin'), (req, res) => res.json({ items: all(`SELECT u.id, u.name, u.email, u.role, u.office_id, u.is_active, o.name AS office_name FROM users u LEFT JOIN offices o ON o.id = u.office_id ORDER BY u.name`) }));
adminApi.post('/users', requireRole('lgu_admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email || !b.password || !b.role) return bad(res, 'Name, email, password and role are required.');
  if (String(b.password).length < 10) return bad(res, 'Password must be at least 10 characters.');
  if (b.role === 'system_admin' && req.user.role !== 'system_admin') return bad(res, 'Only a system admin can create another system admin.', 403);
  if (b.role === 'office_editor' && !b.office_id) return bad(res, 'Office editors need an office.');
  if (get('SELECT id FROM users WHERE lower(email) = lower(?)', [b.email])) return bad(res, 'That email is already used.');
  const id = run('INSERT INTO users(name, email, password_hash, role, office_id) VALUES (?,?,?,?,?)', [b.name, b.email, hashPassword(b.password), b.role, int(b.office_id)]).lastId;
  audit(req.user, 'create', 'user', id, null, { ...b, password: undefined });
  res.status(201).json({ id });
});
adminApi.put('/users/:id', requireRole('lgu_admin'), (req, res) => {
  const id = int(req.params.id), b = req.body || {};
  const target = get('SELECT * FROM users WHERE id = ?', [id]);
  if (!target) return bad(res, 'Not found', 404);
  if (target.role === 'system_admin' && req.user.role !== 'system_admin') return bad(res, 'Only a system admin can change a system admin.', 403);
  const sets = [], p = [];
  for (const f of ['name', 'role', 'office_id', 'is_active']) if (f in b) { sets.push(`${f} = ?`); p.push(b[f]); }
  if (b.password) { if (String(b.password).length < 10) return bad(res, 'Password must be at least 10 characters.'); sets.push('password_hash = ?'); p.push(hashPassword(b.password)); }
  if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...p, id]);
  audit(req.user, 'update', 'user', id, null, { ...b, password: b.password ? '(changed)' : undefined });
  res.json({ ok: true });
});
