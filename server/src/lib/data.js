import { all, get, setting } from '../db.js';
import { publishedNavigation } from './navigation.js';
import { logoUrl } from './office-logos.js';

export function officeLocation(officeId) {
  return get('SELECT * FROM v_office_current_location WHERE office_id = ?', [officeId]);
}

export function locationPayload(loc) {
  if (!loc) return null;
  return {
    type: loc.location_type,
    offsite_address: loc.offsite_address,
    room_id: loc.room_id, room_code: loc.room_code, room_name: loc.room_name,
    floor_id: loc.floor_id, floor_level: loc.floor_level, floor_name: loc.floor_name,
    position: loc.room_id ? { x: loc.x, y: loc.y, z: loc.z } : null,
    approach: loc.room_id ? { x: loc.approach_x, y: loc.approach_y, z: loc.approach_z } : null,
    facing_deg: loc.facing_deg, since: loc.valid_from,
  };
}

export function serviceDetail(id, { includeUnpublished = false } = {}) {
  const s = get(`SELECT s.*, o.name AS office_name, o.short_name AS office_short, o.phone AS office_phone, o.hours AS office_hours
                   FROM services s JOIN offices o ON o.id = s.office_id WHERE s.id = ?`, [id]);
  if (!s) return null;
  if (!includeUnpublished && s.status !== 'published') return null;
  const requirements = all('SELECT id, requirement, where_to_secure FROM service_requirements WHERE service_id = ? ORDER BY sort, id', [id]);
  const rawSteps = all('SELECT id, client_action, agency_action, fee, processing_time, person_in_charge FROM service_steps WHERE service_id = ? ORDER BY sort, id', [id]);
  // group agency sub-steps under the client step they belong to
  const steps = [];
  for (const r of rawSteps) {
    if (r.client_action || !steps.length) steps.push({ client_action: r.client_action || '', agency: [] });
    if (r.agency_action || r.fee || r.processing_time || r.person_in_charge)
      steps[steps.length - 1].agency.push({ id: r.id, agency_action: r.agency_action, fee: r.fee, processing_time: r.processing_time, person_in_charge: r.person_in_charge });
  }
  const keywords = all('SELECT keyword FROM service_keywords WHERE service_id = ?', [id]).map(k => k.keyword);
  const { pending_json, pending_by, pending_at, ...rest } = s;
  const out = {
    ...rest,
    display_title: s.plain_title || s.title,
    requirements, steps, raw_steps: rawSteps, keywords,
    location: locationPayload(officeLocation(s.office_id)),
  };
  if (includeUnpublished) Object.assign(out, { pending: pending_json ? JSON.parse(pending_json) : null, pending_by, pending_at,
    pending_by_name: pending_by ? get('SELECT name FROM users WHERE id = ?', [pending_by])?.name ?? null : null });
  return out;
}

export function officesWithLocation() {
  return all(`SELECT o.id, o.name, o.short_name, o.phone, o.hours, o.location_type, o.offsite_address, o.has_logo, o.logo_file,
                     (SELECT count(*) FROM services s WHERE s.office_id = o.id AND s.status = 'published') AS service_count
                FROM offices o WHERE o.is_active = 1 ORDER BY o.name`)
    .map(({ logo_file, ...o }) => ({ ...o, logo_url: o.has_logo ? logoUrl(logo_file) : null, location: locationPayload(officeLocation(o.id)) }));
}

export function floorsWithRooms() {
  const floors = all('SELECT * FROM floors ORDER BY level');
  const rooms = all(`SELECT r.*, (SELECT group_concat(o.name, ', ') FROM office_locations ol JOIN offices o ON o.id = ol.office_id
                                   WHERE ol.room_id = r.id AND ol.valid_to IS NULL) AS occupant
                       FROM rooms r WHERE r.is_active = 1 ORDER BY r.code`);
  return floors.map(f => ({ ...f, rooms: rooms.filter(r => r.floor_id === f.id) }));
}

/** Approved plain-language summaries only, as { office: Map(id -> {en, fil, ceb}), service: Map(...) }. */
export function approvedSummaries() {
  const out = { office: new Map(), service: new Map() };
  for (const r of all(`SELECT entity_type, entity_id, lang, approved_text FROM plain_summaries WHERE approved_text IS NOT NULL AND approved_text != ''`)) {
    const m = out[r.entity_type], cur = m.get(r.entity_id) || {};
    cur[r.lang] = r.approved_text; m.set(r.entity_id, cur);
  }
  return out;
}

export function activeAnnouncements() {
  return all(`SELECT id, title, body, tone, starts_at, ends_at FROM announcements
               WHERE is_active = 1 AND datetime(starts_at) <= datetime('now') AND (ends_at IS NULL OR datetime(ends_at) >= datetime('now'))
               ORDER BY starts_at DESC`);
}

export function popularServiceIds(limit = 6) {
  const viewed = all(`SELECT id FROM services WHERE status='published' AND is_citizen_facing=1 AND view_count > 0 ORDER BY view_count DESC LIMIT ?`, [limit]).map(r => r.id);
  if (viewed.length >= limit) return viewed;
  // sensible defaults before there is any usage data
  const defaults = all(`SELECT s.id FROM services s JOIN service_keywords k ON k.service_id = s.id
                         WHERE s.status='published' AND s.is_citizen_facing=1
                           AND k.keyword IN ('cedula','business permit','birth certificate','amilyar','senior id','marriage license')
                         GROUP BY s.id ORDER BY min(k.id) LIMIT ?`, [limit]).map(r => r.id);
  return [...new Set([...viewed, ...defaults])].slice(0, limit);
}

// The kiosk's offline bundle. An unknown kiosk code gives kiosk: null (the API answers 404); it is never
// replaced by another kiosk's position.
export function kioskBundle(kioskCode) {
  const kiosk = get(`SELECT k.id, k.code, k.name, k.floor_id, k.x, k.y, k.z, k.facing_deg, f.level AS floor_level
                       FROM kiosks k JOIN floors f ON f.id = k.floor_id WHERE k.code = ?`, [kioskCode]);
  if (!kiosk) return { kiosk: null };
  // every published Charter service; is_citizen_facing only decides where it is listed (public vs. other government offices)
  const ids = all(`SELECT id FROM services WHERE status='published' ORDER BY id`).map(r => r.id);
  const nav = publishedNavigation();
  const summaries = approvedSummaries();
  const withSummary = (type, x) => ({ ...x, summary: summaries[type].get(x.id) || null });
  return {
    content_version: Number(setting('content_version', '1')),
    // published navigation tuple (model release, calibration, graph, opening/sign mappings); null = prototype mode
    navigation: nav,
    generated_at: new Date().toISOString(),
    settings: Object.fromEntries(all('SELECT key, value FROM settings').map(r => [r.key, r.value])),
    kiosk,
    building: get('SELECT * FROM buildings ORDER BY id LIMIT 1'),
    floors: floorsWithRooms(),
    offices: officesWithLocation().map(o => withSummary('office', o)),
    services: ids.map(id => withSummary('service', serviceDetail(id))),
    announcements: activeAnnouncements(),
    popular_service_ids: popularServiceIds(),
  };
}
