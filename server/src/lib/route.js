// Server routing: the published navigation graph when one exists (shared/nav-graph.js), otherwise the labelled
// prototype corridor planner (shared/route-core.js) that predates the real building.
import { all, get, setting } from '../db.js';
import { planRouteCore } from '../../public/shared/route-core.js';
import { planPublishedRoute } from './navigation.js';

export const DEFAULT_KIOSK = 'KIOSK-LOBBY-1'; // the deliberate default when a caller names no kiosk

/**
 * @returns {{status:'ok'|'no_route', reason?, ...}}  — never null; unknown inputs come back as explicit reasons
 */
export function planRoute({ kioskCode = DEFAULT_KIOSK, roomId = null, officeId = null, openingId = null, preference = 'any', preview = false }) {
  const graphRoute = planPublishedRoute({ kioskCode, officeId, roomId, openingId, preference, preview });
  if (graphRoute) return graphRoute;

  // ---- prototype mode (no navigation graph published yet)
  const base = { routeSource: 'prototype_placeholder', originKioskCode: kioskCode, routePreference: preference, modelVersion: null, navigationVersion: null,
    contentVersion: Number(setting('content_version', '1')) };
  if (openingId) return { status: 'no_route', ...base, reason: 'NO_GRAPH', message: 'No navigation graph is published.' };
  const kiosk = get(`SELECT k.*, f.level AS floor_level FROM kiosks k JOIN floors f ON f.id = k.floor_id WHERE k.code = ?`, [kioskCode]);
  if (!kiosk) return { status: 'no_route', ...base, reason: 'UNKNOWN_KIOSK', message: `Kiosk ${kioskCode} is not registered.` };
  if (!roomId && officeId) {
    const loc = get('SELECT * FROM v_office_current_location WHERE office_id = ?', [officeId]);
    if (!loc) return { status: 'no_route', ...base, reason: 'UNKNOWN_DESTINATION', message: 'Office not found.' };
    if (loc.location_type === 'offsite') return { status: 'no_route', ...base, reason: 'OFFSITE', message: 'This office is not in this building.' };
    roomId = loc.room_id;
  }
  if (!roomId) return { status: 'no_route', ...base, reason: 'UNVERIFIED_DESTINATION', message: 'This office has no room in this building yet.' };
  const room = get(`SELECT r.*, f.level AS floor_level, f.name AS floor_name FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = ?`, [roomId]);
  if (!room) return { status: 'no_route', ...base, reason: 'UNKNOWN_DESTINATION', message: 'Room not found.' };
  const floors = all('SELECT level, name, elevation_y FROM floors ORDER BY level');
  const rooms = all(`SELECT r.room_type, r.x, r.z, r.approach_x, r.approach_z, r.is_active, f.level AS floor_level
                       FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.is_active = 1`);
  const r = planRouteCore({ kiosk, room, floors, rooms, accessible: preference === 'step_free', corridorZ: Number(setting('corridor_z', '16')) });
  return { ...base, ...r };
}
