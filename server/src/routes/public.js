// Public API: used by the kiosk (web prototype and Unity), and the phone page. No sign-in.
import express from 'express';
import QRCode from 'qrcode';
import { all, get, run, setting } from '../db.js';
import { search } from '../search.js';
import { serviceDetail, officesWithLocation, officeLocation, locationPayload, floorsWithRooms, kioskBundle, activeAnnouncements, popularServiceIds } from '../lib/data.js';
import { planRoute } from '../lib/route.js';

export const publicApi = express.Router();
const int = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

publicApi.get('/health', (req, res) => res.json({ ok: true, content_version: Number(setting('content_version', '1')), time: new Date().toISOString() }));

// --- offline sync ------------------------------------------------------------
publicApi.get('/kiosk/version', (req, res) => res.json({ content_version: Number(setting('content_version', '1')) }));
publicApi.get('/kiosk/bundle', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(kioskBundle(req.query.kiosk || 'KIOSK-LOBBY-1'));
});
publicApi.post('/kiosks/:code/heartbeat', (req, res) => {
  const { app_version = null, content_version = null } = req.body || {};
  const r = run(`UPDATE kiosks SET last_heartbeat = datetime('now'), app_version = COALESCE(?, app_version), content_version = COALESCE(?, content_version) WHERE code = ?`,
    [app_version, content_version, req.params.code]);
  if (!r.changes) return res.status(404).json({ error: 'Unknown kiosk code' });
  res.json({ ok: true, content_version: Number(setting('content_version', '1')) });
});
publicApi.post('/kiosk-sessions', (req, res) => {
  run('INSERT INTO session_logs(kiosk_code) VALUES (?)', [req.body?.kiosk_code || null]);
  res.json({ ok: true });
});

// --- browse & search -----------------------------------------------------------
publicApi.get('/search', (req, res) => {
  const q = String(req.query.q || '').slice(0, 120);
  const results = q.trim() ? search(q, int(req.query.limit) || 25) : [];
  if (q.trim() && req.query.log !== '0') run('INSERT INTO search_logs(query, results_count, kiosk_code) VALUES (?,?,?)', [q.trim().toLowerCase(), results.length, req.query.kiosk || null]);
  res.json({ query: q, count: results.length, results });
});

publicApi.get('/services/popular', (req, res) => {
  res.json({ items: popularServiceIds(int(req.query.limit) || 6).map(id => {
    const s = serviceDetail(id);
    return s && { id: s.id, title: s.display_title, office_name: s.office_name, location: s.location };
  }).filter(Boolean) });
});

publicApi.get('/services/:id', (req, res) => {
  const s = serviceDetail(int(req.params.id));
  if (!s || !s.is_citizen_facing) return res.status(404).json({ error: 'Service not found' });
  if (req.query.view !== '0') run('UPDATE services SET view_count = view_count + 1 WHERE id = ?', [s.id]);
  res.json(s);
});

publicApi.get('/offices', (req, res) => res.json({ items: officesWithLocation() }));
publicApi.get('/offices/:id', (req, res) => {
  const o = get('SELECT * FROM offices WHERE id = ? AND is_active = 1', [int(req.params.id)]);
  if (!o) return res.status(404).json({ error: 'Office not found' });
  const services = all(`SELECT id, COALESCE(plain_title, title) AS title, classification, total_fees, total_processing_time
                          FROM services WHERE office_id = ? AND status='published' AND is_citizen_facing=1 ORDER BY title`, [o.id]);
  res.json({ ...o, location: locationPayload(officeLocation(o.id)), services });
});

publicApi.get('/floors', (req, res) => res.json({ items: floorsWithRooms() }));
publicApi.get('/announcements', (req, res) => res.json({ items: activeAnnouncements() }));

// --- locations for the 3D app ----------------------------------------------------
// Unity calls this to know where every office is NOW. When an office moves rooms,
// or a room's coordinates are corrected, the next call returns the new values.
publicApi.get('/destinations', (req, res) => {
  const items = all(`SELECT * FROM v_office_current_location WHERE room_id IS NOT NULL ORDER BY office_name`).map(d => ({
    office_id: d.office_id, office_name: d.office_name, room_id: d.room_id, room_code: d.room_code, room_name: d.room_name,
    floor_level: d.floor_level, floor_name: d.floor_name,
    x: d.x, y: d.y, z: d.z, approach_x: d.approach_x ?? d.x, approach_y: d.approach_y ?? d.y, approach_z: d.approach_z ?? d.z, facing_deg: d.facing_deg ?? 0,
    since: d.valid_from,
  }));
  res.json({ content_version: Number(setting('content_version', '1')), items });
});
// Kiosk position (start of every route). Unity's KioskStartPoint reads this.
publicApi.get('/kiosks/:code', (req, res) => {
  const k = get(`SELECT k.id, k.code, k.name, k.x, k.y, k.z, k.facing_deg, f.level AS floor_level FROM kiosks k JOIN floors f ON f.id = k.floor_id WHERE k.code = ?`, [String(req.params.code)]);
  if (!k) return res.status(404).json({ error: 'Kiosk not found' });
  res.json(k);
});
publicApi.get('/rooms', (req, res) => {
  res.json({ items: all(`SELECT r.id, r.code, r.name, r.room_type, f.level AS floor_level, r.x, r.y, r.z,
                                COALESCE(r.approach_x, r.x) AS approach_x, COALESCE(r.approach_y, r.y) AS approach_y, COALESCE(r.approach_z, r.z) AS approach_z,
                                r.facing_deg, r.width_m, r.depth_m, r.is_accessible, r.coord_source
                           FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.is_active = 1 ORDER BY r.code`) });
});

publicApi.get('/route', (req, res) => {
  let roomId = int(req.query.room_id);
  if (!roomId && req.query.office_id) roomId = officeLocation(int(req.query.office_id))?.room_id;
  if (!roomId && req.query.service_id) {
    const s = get('SELECT office_id FROM services WHERE id = ?', [int(req.query.service_id)]);
    roomId = s && officeLocation(s.office_id)?.room_id;
  }
  if (!roomId) return res.status(404).json({ error: 'This office has no room in this building yet.' });
  const r = planRoute({ kioskCode: req.query.kiosk || 'KIOSK-LOBBY-1', roomId, accessible: req.query.accessible === '1' });
  if (!r) return res.status(404).json({ error: 'Route not available' });
  if (req.query.log !== '0') run('INSERT INTO session_logs(kiosk_code, navigated_room_id) VALUES (?,?)', [req.query.kiosk || null, roomId]);
  res.json(r);
});

// --- feedback -----------------------------------------------------------------
publicApi.post('/feedback', (req, res) => {
  const { service_id = null, helpful, reason = null, comment = null, kiosk_code = null } = req.body || {};
  if (helpful !== 0 && helpful !== 1 && helpful !== true && helpful !== false) return res.status(400).json({ error: 'helpful must be 1 or 0' });
  const allowed = [null, 'unclear', 'wrong_info', 'not_found', 'other'];
  if (!allowed.includes(reason)) return res.status(400).json({ error: 'Unknown reason' });
  run('INSERT INTO feedback(service_id, kiosk_code, helpful, reason, comment) VALUES (?,?,?,?,?)',
    [int(service_id), kiosk_code, helpful ? 1 : 0, reason, comment ? String(comment).slice(0, 500) : null]);
  res.status(201).json({ ok: true });
});

// --- QR code (phone hand-off) ---------------------------------------------------
publicApi.get('/qr.svg', async (req, res) => {
  const data = String(req.query.data || '').slice(0, 500);
  if (!data) return res.status(400).send('missing data');
  const svg = await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#12355B', light: '#FFFFFF' } });
  res.type('image/svg+xml').send(svg);
});
