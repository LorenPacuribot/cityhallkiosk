// Server wrapper around the shared route planner (public/shared/route-core.js).
import { all, get, setting } from '../db.js';
import { planRouteCore } from '../../public/shared/route-core.js';

export function planRoute({ kioskCode, roomId, accessible = false }) {
  const kiosk = get(`SELECT k.*, f.level AS floor_level FROM kiosks k JOIN floors f ON f.id = k.floor_id WHERE k.code = ?`, [kioskCode])
    || get(`SELECT k.*, f.level AS floor_level FROM kiosks k JOIN floors f ON f.id = k.floor_id ORDER BY k.id LIMIT 1`);
  const room = get(`SELECT r.*, f.level AS floor_level, f.name AS floor_name FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = ?`, [roomId]);
  if (!kiosk || !room) return null;
  const floors = all('SELECT level, name, elevation_y FROM floors ORDER BY level');
  const rooms = all(`SELECT r.room_type, r.x, r.z, r.approach_x, r.approach_z, r.is_active, f.level AS floor_level
                       FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.is_active = 1`);
  return planRouteCore({ kiosk, room, floors, rooms, accessible, corridorZ: Number(setting('corridor_z', '16')) });
}
