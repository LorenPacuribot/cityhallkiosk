// Pure route planner shared by the server (/api/route) and the kiosk (offline fallback).
// Input is plain data from the database, so the result is identical in both places.
//
// It walks: kiosk -> main corridor -> (stairs -> other floor -> corridor) -> door of the room.
// The Unity build replaces this with a real NavMesh path between the same two points.

const WALK_SPEED = 1.1; // m/s

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) + Math.abs((a.y ?? 0) - (b.y ?? 0));
const unit = (a, b) => { const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1; return { x: dx / l, z: dz / l }; };

function side(heading, from, point) {
  const vx = point.x - from.x, vz = point.z - from.z;
  const cross = heading.z * vx - heading.x * vz; // +X is right when facing +Z
  return Math.abs(cross) < 0.5 ? 'ahead' : cross > 0 ? 'right' : 'left';
}
function turnWord(prev, next) {
  const cross = prev.z * next.x - prev.x * next.z;
  const dot = prev.x * next.x + prev.z * next.z;
  if (dot > 0.7) return 'straight';
  return cross > 0 ? 'right' : 'left';
}

/**
 * @param {object} p
 * @param {{code,x,y,z,facing_deg,floor_level}} p.kiosk
 * @param {{id,code,name,x,y,z,approach_x,approach_y,approach_z,facing_deg,floor_level,floor_name}} p.room
 * @param {Array<{level,name}>} p.floors
 * @param {Array<{room_type,x,z,approach_x,approach_z,floor_level,is_active}>} p.rooms  all rooms (for stairs)
 */
export function planRouteCore({ kiosk, room, floors, rooms, accessible = false, corridorZ = 16 }) {
  const target = { x: room.approach_x ?? room.x, y: room.approach_y ?? room.y, z: room.approach_z ?? room.z, floor: room.floor_level };
  const start = { x: kiosk.x, y: kiosk.y, z: kiosk.z, floor: kiosk.floor_level };
  const pts = [{ ...start, label: 'start' }];
  const push = (p, label) => pts.push({ ...p, label });
  const floorName = lvl => floors.find(f => f.level === lvl)?.name || `floor ${lvl}`;
  const floorY = lvl => floors.find(f => f.level === lvl)?.elevation_y ?? (lvl - 1) * 4.2;

  let stairs = null;
  if (start.floor !== target.floor) {
    const sideSign = target.x < 0 ? -1 : 1;
    const movers = rooms.filter(r => ['stairs', 'elevator', 'ramp'].includes(r.room_type) && r.is_active !== 0 && r.floor_level === start.floor);
    const usable = movers.filter(c => !accessible || c.room_type !== 'stairs');
    stairs = (usable.length ? usable : movers).sort((a, b) => Math.abs(a.x - sideSign * 10) - Math.abs(b.x - sideSign * 10))[0] || null;
  }

  push({ x: start.x, y: start.y, z: corridorZ, floor: start.floor }, 'corridor');
  if (stairs) {
    const sx = stairs.approach_x ?? stairs.x, sz = stairs.approach_z ?? stairs.z;
    push({ x: sx, y: start.y, z: corridorZ, floor: start.floor }, 'to-stairs');
    push({ x: sx, y: start.y, z: sz, floor: start.floor }, 'stairs-bottom');
    const upper = rooms.filter(r => r.floor_level === target.floor && r.room_type === stairs.room_type)
      .sort((a, b) => Math.abs(a.x - stairs.x) - Math.abs(b.x - stairs.x))[0];
    const ux = upper ? (upper.approach_x ?? upper.x) : sx, uz = upper ? (upper.approach_z ?? upper.z) : sz;
    const uy = floorY(target.floor);
    push({ x: ux, y: uy, z: uz, floor: target.floor }, 'stairs-top');
    push({ x: ux, y: uy, z: corridorZ, floor: target.floor }, 'corridor');
  }
  push({ x: target.x, y: target.y, z: corridorZ, floor: target.floor }, 'door-corridor');
  push({ ...target }, 'arrive');
  const path = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 0.05 || p.floor !== pts[i - 1].floor);

  const legs = [];
  const fd = (kiosk.facing_deg || 0) * Math.PI / 180;
  let heading = { x: Math.sin(fd), z: Math.cos(fd) };
  let total = 0, afterFloor = false;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const d = dist(a, b);
    total += d;
    if (a.floor !== b.floor) {
      const kind = stairs?.room_type === 'elevator' ? 'elevator' : 'stairs';
      legs.push({ kind: 'floor_change', key: b.floor > a.floor ? `${kind}_up` : `${kind}_down`, floor_name: floorName(b.floor),
        text: `Take the ${kind} ${b.floor > a.floor ? 'up' : 'down'} to the ${floorName(b.floor)}.`, distance_m: 0, floor: b.floor, point_index: i });
      afterFloor = true;
      continue;
    }
    if (d < 0.5) continue;
    const dir = unit(a, b);
    const turn = turnWord(heading, dir);
    let text, key;
    if (b.label === 'arrive') {
      const s = side(heading, a, { x: room.x, z: room.z });
      key = s === 'ahead' ? 'arrive_ahead' : `arrive_${s}`;
      text = `${room.name} is ${s === 'ahead' ? 'straight ahead' : 'on your ' + s} (${room.code}).`;
    } else if (afterFloor) { key = 'after_stairs'; text = `At the top of the stairs, walk ${Math.round(d)} m back to the main corridor.`; }
    else if (turn === 'straight') { key = 'straight'; text = `Walk straight ahead for ${Math.round(d)} m.`; }
    else { key = `turn_${turn}`; text = `Turn ${turn} and walk ${Math.round(d)} m.`; }
    legs.push({ kind: b.label === 'arrive' ? 'arrive' : 'walk', key, text, distance_m: Math.round(d), floor: b.floor, room_name: room.name, room_code: room.code, point_index: i });
    heading = dir;
    afterFloor = false;
  }
  return {
    from: { kiosk_code: kiosk.code, floor_level: start.floor, x: start.x, y: start.y, z: start.z },
    to: { room_id: room.id, room_code: room.code, room_name: room.name, floor_level: room.floor_level, floor_name: room.floor_name || floorName(room.floor_level), ...target, facing_deg: room.facing_deg },
    waypoints: path.map(({ x, y, z, floor, label }) => ({ x, y, z, floor, label })),
    directions: legs,
    distance_m: Math.round(total),
    minutes: Math.max(1, Math.round(total / WALK_SPEED / 60)),
    note: 'Prototype corridor route. The Unity kiosk computes the real path on the NavMesh from the same start and end coordinates.',
  };
}
