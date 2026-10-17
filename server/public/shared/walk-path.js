// First-person walk along a planned route: a deterministic timeline of pose (position, yaw, pitch) over time.
// Pure math (no three.js) so it is shared by the kiosk player and the tests.
//
// The position never leaves the route polyline (the route follows verified corridors, so the eye never passes
// through a wall); only the view direction is blended around corners. Speed drops before a turn so the view never
// swings faster than MAX_TURN_RATE, the walk eases in at the start and out at the door, and at the end the view
// turns to face the destination door.
//
// Canonical coordinates: +X right, +Z into the building, +Y up. yaw 0 looks along +Z, yaw +90° looks along +X.
// pitch > 0 looks up.

export const WALK_DEFAULTS = {
  walk: 2.0,            // m/s on level floors (a brisk preview; real walking is about 1.3 m/s)
  stairs: 1.0,          // m/s along a flight
  maxTurnRate: 1.05,    // rad/s (60°/s): faster turns are uncomfortable on a large screen
  cornerRadius: 1.6,    // m: the view starts turning this far before a corner
  startHold: 0.8,       // s at the entrance before walking, so the visitor sees where they are
  easeIn: 1.2,          // m
  easeOut: 1.6,         // m
  doorTurnRate: 1.2,    // rad/s for the final turn towards the door
  endHold: 0.4,         // s looking at the door before arrival is reported
  stairPitch: 0.6,      // fraction of the flight's slope used as view pitch (look up the stairs, not at the steps)
  doorLookAhead: 2.0,   // start looking toward the door before stopping beside it
  pathLookAhead: 2.4,   // look into the next landing before reaching a stairwell wall
};

const TAU = Math.PI * 2;
const wrap = a => a - TAU * Math.round(a / TAU); // -> [-π, π]
const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
const DS = 0.05; // integration step (m)

/**
 * @param {{x:number,y:number,z:number,floor:number}[]} waypoints route polyline (canonical)
 * @param {{x:number,y?:number,z:number}|null} [door] destination door point; the walk ends facing it
 * @param {Partial<typeof WALK_DEFAULTS>} [opts]
 */
export function buildWalk(waypoints, door = null, opts = {}) {
  const o = { ...WALK_DEFAULTS, ...opts };
  if (!waypoints || waypoints.length < 2) throw new Error('A walk needs at least two waypoints');

  // segments over the ORIGINAL waypoint indices (direction legs refer to them); zero-length ones are kept but skipped
  const segs = [];
  let s0 = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const h = Math.hypot(dx, dz), len = Math.hypot(h, dy);
    segs.push({ i: i - 1, a, b, s0, len, h, dy, yaw: null, pitch: h > 1e-6 ? Math.atan2(dy, h) : 0, stairs: Math.abs(dy) > 0.05 || a.floor !== b.floor });
    s0 += len;
  }
  const total = s0;
  if (total < 1e-3) throw new Error('The route has no length');
  // heading of zero-length / vertical segments: inherit the neighbour's
  for (const g of segs) if (g.h > 1e-6) g.yaw = Math.atan2(g.b.x - g.a.x, g.b.z - g.a.z);
  for (let k = 0; k < segs.length; k++) if (segs[k].yaw === null) segs[k].yaw = segs[k - 1]?.yaw ?? segs.find(g => g.yaw !== null)?.yaw ?? 0;
  const moving = segs.filter(g => g.len > 1e-6);

  // corners between consecutive moving segments
  const corners = [];
  for (let k = 1; k < moving.length; k++) {
    const p = moving[k - 1], n = moving[k];
    const turn = wrap(n.yaw - p.yaw), dPitch = n.pitch - p.pitch;
    if (Math.abs(turn) < 0.05 && Math.abs(dPitch) < 0.02) continue;
    const r = Math.max(0.15, Math.min(o.cornerRadius, 0.45 * p.len, 0.45 * n.len));
    corners.push({ s: n.s0, r, turn, dPitch: dPitch * o.stairPitch });
  }

  const yawAt = s => { let y = moving[0].yaw; for (const c of corners) y += c.turn * smooth((s - (c.s - c.r)) / (2 * c.r)); return y; };
  const pitchAt = s => { let p = moving[0].pitch * o.stairPitch; for (const c of corners) p += c.dPitch * smooth((s - (c.s - c.r)) / (2 * c.r)); return p; };
  const segAt = s => { let k = segs.length - 1; while (k > 0 && (segs[k].s0 > s || segs[k].len <= 1e-6)) k--; return segs[k]; };
  const speedAt = s => {
    const g = segAt(s);
    let v = g.stairs ? o.stairs : o.walk;
    for (const c of corners) {
      // inside a corner's turning window the mean yaw rate is |turn| * v / (2r), and smoothstep peaks at 1.5x the mean
      if (Math.abs(s - c.s) <= c.r * 1.25 && Math.abs(c.turn) > 0.05) v = Math.min(v, o.maxTurnRate * 2 * c.r / (1.5 * Math.abs(c.turn)));
    }
    v *= 0.25 + 0.75 * smooth(s / o.easeIn);
    v *= 0.25 + 0.75 * smooth((total - s) / o.easeOut);
    return Math.max(0.12, v);
  };

  // integrate distance -> time
  const S = [0], T = [o.startHold];
  for (let s = 0; s < total;) {
    const ds = Math.min(DS, total - s);
    const v = (speedAt(s) + speedAt(s + ds)) / 2;
    s += ds;
    S.push(s); T.push(T[T.length - 1] + ds / v);
  }
  const walkEnd = T[T.length - 1];

  // final turn to face the door (from the end of the route, horizontally)
  const end = waypoints[waypoints.length - 1];
  const pathYawAt = s => {
    const from = poseAtDistance(s), to = poseAtDistance(Math.min(total, s + o.pathLookAhead));
    return Math.hypot(to.x - from.x, to.z - from.z) > .01 ? Math.atan2(to.x - from.x, to.z - from.z) : yawAt(s);
  };
  let yawEnd = pathYawAt(total);
  const pitchEnd = pitchAt(total);
  let doorTurn = 0;
  if (door && Math.hypot(door.x - end.x, door.z - end.z) > 0.2) doorTurn = wrap(Math.atan2(door.x - end.x, door.z - end.z) - yawEnd);
  if (o.doorLookAhead > 0) { yawEnd += doorTurn; doorTurn = 0; }
  const turnDur = Math.max(0.5, 1.5 * Math.abs(doorTurn) / o.doorTurnRate);
  const duration = walkEnd + turnDur + o.endHold;

  function poseAtDistance(s) {
    const g = segAt(s);
    const f = g.len > 1e-6 ? Math.min(1, Math.max(0, (s - g.s0) / g.len)) : 1;
    return {
      x: g.a.x + (g.b.x - g.a.x) * f, y: g.a.y + (g.b.y - g.a.y) * f, z: g.a.z + (g.b.z - g.a.z) * f,
      floor: f < 0.5 ? g.a.floor : g.b.floor, seg: g.i, f,
    };
  }

  /** Pose at time t (seconds since the walk started). */
  function sample(t) {
    if (t <= o.startHold) return { ...poseAtDistance(0), yaw: pathYawAt(0), pitch: pitchAt(0), s: 0, phase: 'start' };
    if (t >= walkEnd) {
      const k = smooth((t - walkEnd) / turnDur);
      const p = poseAtDistance(total);
      return { ...p, seg: segs.length - 1, f: 1, yaw: yawEnd + doorTurn * k, pitch: pitchEnd * (1 - k), s: total, phase: t >= duration ? 'arrived' : 'door' };
    }
    // binary search the timeline
    let lo = 0, hi = T.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    const s = S[lo] + (S[hi] - S[lo]) * ((t - T[lo]) / (T[hi] - T[lo] || 1));
    const pose = poseAtDistance(s);
    let yaw = pathYawAt(s);
    // Look toward the door over the last two metres, while feet stay on the corridor.
    if (door && total - s < o.doorLookAhead) {
      const desired = Math.atan2(door.x - pose.x, door.z - pose.z);
      yaw += wrap(desired - yaw) * smooth(1 - (total - s) / o.doorLookAhead);
    }
    return { ...pose, yaw, pitch: pitchAt(s), s, phase: 'walk' };
  }

  /** Time at which the walk reaches distance s (for skipping to a point). */
  function timeAtDistance(s) {
    if (s <= 0) return o.startHold;
    if (s >= total) return walkEnd;
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
    return T[lo] + (T[hi] - T[lo]) * ((s - S[lo]) / (S[hi] - S[lo] || 1));
  }

  return { duration, walkEnd, length: total, corners, sample, timeAtDistance, poseAtDistance, yawAt, pitchAt, options: o };
}

/** Canonical (yaw, pitch) -> canonical unit view direction. */
export function viewDirection(yaw, pitch) {
  const c = Math.cos(pitch);
  return { x: Math.sin(yaw) * c, y: Math.sin(pitch), z: Math.cos(yaw) * c };
}

// Stair instructions share an end point. Show the landing cue as the walker approaches
// the first landing instead of letting the floor-change instruction hide it throughout.
export function activeDirection(directions, pose) {
  const point = pose.seg + (pose.f >= 1 ? 1 : 0);
  let index = directions.findIndex(d => d.point_index > point);
  if (index < 0) return directions.length - 1;
  const next = directions[index + 1];
  if (directions[index].kind === 'floor_change' && next?.kind === 'stairs_turns' && next.start_point_index != null && point >= next.start_point_index) index++;
  return index;
}
