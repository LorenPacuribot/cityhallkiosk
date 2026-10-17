// Verified-graph route planner shared by the server (/api/route), the kiosk and the phone page.
// Pure: no DOM, no database, no rendering. Same inputs give the same route everywhere.
// (docs/3D_MODEL_INTEGRATION_GUIDE.md §12)
//
// Coordinates are canonical: metres, Y up, +X right when facing the building, +Z into the building.
//
// graph = {
//   modelVersion, navigationVersion, status: 'published' | 'draft',
//   nodes: [{ id, x, y, z, floor, role, label }],              role: kiosk|entrance|junction|landing|stair_foot|stair_top|door_approach|lift|...
//   edges: [{ id, from, to, kind, polyline:[{x,y,z}], length_m, bidirectional, verified, public, step_free, closed, label }],
//          kind: walk|stairs|ramp|lift|door;  step_free: true | false | null (unknown => not eligible)
//   kiosks: { [kioskCode]: nodeId },
//   floors: [{ level, name }],
// }
// destination = { nodeId, name, code, doorPoint? {x,y,z}, floor }

export const ROUTE_REASONS = Object.freeze({
  UNKNOWN_KIOSK: 'UNKNOWN_KIOSK', UNVERIFIED_DESTINATION: 'UNVERIFIED_DESTINATION', NO_STEP_FREE_ROUTE: 'NO_STEP_FREE_ROUTE',
  ROUTE_CLOSED: 'ROUTE_CLOSED', DISCONNECTED: 'DISCONNECTED', UNVERIFIED_ROUTE: 'UNVERIFIED_ROUTE', VERSION_MISMATCH: 'VERSION_MISMATCH', NO_GRAPH: 'NO_GRAPH',
  OFFSITE: 'OFFSITE', UNKNOWN_DESTINATION: 'UNKNOWN_DESTINATION', INVALID_GRAPH: 'INVALID_GRAPH',
});
const WALK_SPEED = 1.1;        // m/s, for the minutes estimate only
const STAIR_SECONDS_PER_M = 2.0;
const LIFT_SECONDS = 60;       // estimated wait + ride
const TURN_DEG = 30;           // heading change that produces a turn instruction

const d3 = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
export const polylineLength = pts => pts.slice(1).reduce((s, p, i) => s + d3(pts[i], p), 0);

/** Structural validation. Returns a list of problems (empty = valid). Used before publication and on load. */
export function validateGraph(g) {
  const errs = [];
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return ['graph needs nodes[] and edges[]'];
  const ids = new Set();
  for (const n of g.nodes) {
    if (!n.id || ids.has(n.id)) errs.push(`node id ${JSON.stringify(n.id)} missing or duplicated`);
    ids.add(n.id);
    if (![n.x, n.y, n.z].every(Number.isFinite)) errs.push(`node ${n.id}: non-finite coordinates`);
    if (!Number.isInteger(n.floor)) errs.push(`node ${n.id}: floor must be an integer level`);
  }
  const eids = new Set();
  for (const e of g.edges) {
    if (!e.id || eids.has(e.id)) errs.push(`edge id ${JSON.stringify(e.id)} missing or duplicated`);
    eids.add(e.id);
    if (!ids.has(e.from) || !ids.has(e.to)) { errs.push(`edge ${e.id}: unknown endpoint`); continue; }
    if (!['walk', 'stairs', 'ramp', 'lift', 'door'].includes(e.kind)) errs.push(`edge ${e.id}: unknown kind ${e.kind}`);
    const pl = e.polyline || [];
    if (pl.length < 2 || !pl.every(p => [p.x, p.y, p.z].every(Number.isFinite))) { errs.push(`edge ${e.id}: polyline needs ≥2 finite points`); continue; }
    const a = g.nodes.find(n => n.id === e.from), b = g.nodes.find(n => n.id === e.to);
    if (d3(pl[0], a) > 0.05 || d3(pl[pl.length - 1], b) > 0.05) errs.push(`edge ${e.id}: polyline does not start/end at its nodes`);
    const len = polylineLength(pl);
    if (!(len > 0)) errs.push(`edge ${e.id}: zero length`);
    if (Number.isFinite(e.length_m) && Math.abs(e.length_m - len) > 0.05) errs.push(`edge ${e.id}: length_m ${e.length_m} != polyline ${len.toFixed(2)}`);
    if (a.floor !== b.floor && !['stairs', 'ramp', 'lift'].includes(e.kind)) errs.push(`edge ${e.id}: changes floor but is a ${e.kind} edge`);
    if (e.kind === 'stairs' && e.step_free === true) errs.push(`edge ${e.id}: stairs cannot be step-free`);
    if (![true, false, null, undefined].includes(e.step_free)) errs.push(`edge ${e.id}: step_free must be true, false or null`);
  }
  for (const [code, nid] of Object.entries(g.kiosks || {})) if (!ids.has(nid)) errs.push(`kiosk ${code}: unknown node ${nid}`);
  return errs;
}

/**
 * Office / room / doorway -> graph destination, from published mappings only. Shared by server and kiosk.
 * @param {object} graph published graph with openings[] ({openingId, roomId, roomCode, roomName, status, approachNodeId, doorPoint, label})
 * @param {object} target { openingId } or { roomId, locationType, officeName }
 * @param {{preview?: boolean}} opts draft (unverified) mappings only in a labelled preview
 * @returns {{destination}|{reason, message}}
 */
export function resolveDestination(graph, target, { preview = false } = {}) {
  const asDest = (o, name) => ({ nodeId: o.approachNodeId, openingId: o.openingId, roomId: o.roomId ?? null, doorPoint: o.doorPoint || null,
    name: name || o.roomName || o.label, code: o.roomCode || o.openingId, mapping: o.status });
  if (target.openingId) {
    const o = graph.openings?.find(x => x.openingId === target.openingId);
    if (!o) return { reason: ROUTE_REASONS.UNKNOWN_DESTINATION, message: `Doorway ${target.openingId} is not in the navigation graph.` };
    if (!preview && o.status !== 'verified') return { reason: ROUTE_REASONS.UNVERIFIED_DESTINATION, message: `Doorway ${target.openingId} has not been verified.` };
    if (!o.approachNodeId) return { reason: ROUTE_REASONS.UNVERIFIED_DESTINATION, message: `Doorway ${target.openingId} has no public approach in the graph.` };
    return { destination: asDest(o) };
  }
  if (target.locationType === 'offsite') return { reason: ROUTE_REASONS.OFFSITE, message: 'This office is not in this building.' };
  if (target.locationType === 'unconfirmed' || !target.roomId) return { reason: ROUTE_REASONS.UNVERIFIED_DESTINATION, message: 'This office\'s location is not confirmed.' };
  const candidates = (graph.openings || []).filter(o => o.roomId === target.roomId && o.approachNodeId);
  const chosen = candidates.find(o => o.status === 'verified') || (preview ? candidates.find(o => o.status === 'draft') : null);
  if (!chosen) return { reason: ROUTE_REASONS.UNVERIFIED_DESTINATION, message: 'Directions to this office have not been verified yet.' };
  return { destination: asDest(chosen, target.officeName) };
}

/** Which edges a request may use. Unknown step-free status is never eligible for a step-free request. */
export function edgeAllowed(e, { preference = 'any', allowUnverified = false } = {}) {
  if (e.closed) return false;
  if (e.public === false) return false;
  if (!e.verified && !allowUnverified) return false;
  if (preference === 'step_free') {
    if (e.kind === 'stairs') return false;
    if (e.step_free !== true) return false;
  }
  return true;
}

function dijkstra(g, startId, goalId, allow) {
  const adj = new Map(g.nodes.map(n => [n.id, []]));
  for (const e of g.edges) {
    if (!allow(e)) continue;
    const len = Number.isFinite(e.length_m) ? e.length_m : polylineLength(e.polyline);
    adj.get(e.from).push({ e, to: e.to, len, forward: true });
    if (e.bidirectional !== false) adj.get(e.to).push({ e, to: e.from, len, forward: false });
  }
  const dist = new Map([[startId, 0]]), prev = new Map(), done = new Set();
  // small graphs (hundreds of nodes): a linear-scan priority queue keeps this dependency-free and deterministic
  const open = new Set([startId]);
  while (open.size) {
    let u = null, best = Infinity;
    for (const id of open) { const d = dist.get(id); if (d < best || (d === best && id < u)) { best = d; u = id; } }
    open.delete(u);
    if (u === goalId) break;
    done.add(u);
    for (const s of adj.get(u)) {
      if (done.has(s.to)) continue;
      const nd = best + s.len;
      const cur = dist.get(s.to);
      if (cur === undefined || nd < cur - 1e-9 || (Math.abs(nd - cur) <= 1e-9 && s.e.id < prev.get(s.to).step.e.id)) {
        dist.set(s.to, nd); prev.set(s.to, { from: u, step: s }); open.add(s.to);
      }
    }
  }
  if (!dist.has(goalId)) return null;
  const steps = [];
  for (let v = goalId; v !== startId; v = prev.get(v).from) steps.unshift(prev.get(v).step);
  return { steps, length: dist.get(goalId) };
}

const heading = (a, b) => { const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz); return l < 1e-6 ? null : { x: dx / l, z: dz / l }; };
// +X is right when facing +Z: cross > 0 means the new heading is to the right
function turnOf(h1, h2) {
  const cross = h1.z * h2.x - h1.x * h2.z, dot = h1.x * h2.x + h1.z * h2.z;
  const deg = Math.atan2(cross, dot) * 180 / Math.PI;
  if (Math.abs(deg) < TURN_DEG) return 'straight';
  return deg > 0 ? 'right' : 'left';
}
function sideOf(h, from, p) {
  const vx = p.x - from.x, vz = p.z - from.z;
  const along = h.x * vx + h.z * vz, cross = h.z * vx - h.x * vz;
  if (Math.abs(cross) < 0.5 && along > 0) return 'ahead';
  return cross > 0 ? 'right' : 'left';
}

/**
 * Plan a route. Returns either { status:'ok', ...route } or { status:'no_route', reason, message }.
 * @param {object} p
 * @param {object} p.graph published navigation graph
 * @param {string} p.kioskCode origin kiosk (must be registered in graph.kiosks; never substituted)
 * @param {object} p.destination { nodeId, name, code, floor, doorPoint }
 * @param {'any'|'step_free'} [p.preference]
 * @param {boolean} [p.allowUnverified] draft preview only — the result is marked unverified
 * @param {object} [p.versions] { modelVersion, contentVersion } expected by the caller
 */
export function planGraphRoute({ graph, kioskCode, destination, preference = 'any', allowUnverified = false, versions = {} }) {
  const meta = { modelVersion: graph?.modelVersion ?? null, navigationVersion: graph?.navigationVersion ?? null,
    contentVersion: versions.contentVersion ?? null, routePreference: preference, originKioskCode: kioskCode ?? null };
  const fail = (reason, message) => ({ status: 'no_route', reason, message, ...meta });
  if (!graph) return fail(ROUTE_REASONS.NO_GRAPH, 'No navigation graph is published.');
  if (versions.modelVersion && graph.modelVersion !== versions.modelVersion) return fail(ROUTE_REASONS.VERSION_MISMATCH, `Navigation graph is for ${graph.modelVersion}, model is ${versions.modelVersion}.`);
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const startId = graph.kiosks?.[kioskCode];
  if (!startId || !nodes.has(startId)) return fail(ROUTE_REASONS.UNKNOWN_KIOSK, `Kiosk ${kioskCode} has no registered position in this navigation graph.`);
  if (!destination?.nodeId) return fail(ROUTE_REASONS.UNVERIFIED_DESTINATION, 'This destination has no verified entrance in the navigation graph yet.');
  if (!nodes.has(destination.nodeId)) return fail(ROUTE_REASONS.UNKNOWN_DESTINATION, `Destination node ${destination.nodeId} is not in this navigation graph.`);

  const opts = { preference, allowUnverified };
  const found = dijkstra(graph, startId, destination.nodeId, e => edgeAllowed(e, opts));
  if (!found) {
    // explain *why*: closures, step-free restriction, or simply disconnected
    const ignoringClosures = dijkstra(graph, startId, destination.nodeId, e => edgeAllowed({ ...e, closed: false }, opts));
    if (ignoringClosures) return fail(ROUTE_REASONS.ROUTE_CLOSED, 'Every route to this destination is currently closed.');
    if (preference === 'step_free' && dijkstra(graph, startId, destination.nodeId, e => edgeAllowed(e, { ...opts, preference: 'any' })))
      return fail(ROUTE_REASONS.NO_STEP_FREE_ROUTE, 'There is no verified step-free route to this destination.');
    if (!allowUnverified && dijkstra(graph, startId, destination.nodeId, e => edgeAllowed(e, { ...opts, allowUnverified: true })))
      return fail(ROUTE_REASONS.UNVERIFIED_ROUTE, 'A route exists only through segments that staff have not verified yet.');
    return fail(ROUTE_REASONS.DISCONNECTED, 'No connected route to this destination exists in the navigation graph.');
  }
  return { status: 'ok', ...meta, ...describeRoute(graph, nodes, found.steps, destination, startId), verification: found.steps.every(s => s.e.verified) ? 'verified' : 'unverified' };
}

function floorNameOf(graph, level) { return graph.floors?.find(f => f.level === level)?.name || `floor ${level}`; }

/** Turns the chosen edges into waypoints and written directions, from the same data. */
function describeRoute(graph, nodes, steps, destination, startId) {
  const waypoints = [], edges = [];
  const start = nodes.get(startId);
  waypoints.push({ x: start.x, y: start.y, z: start.z, floor: start.floor, label: 'start', node: start.id });
  for (const s of steps) {
    const pl = s.forward ? s.e.polyline : [...s.e.polyline].reverse();
    const a = nodes.get(s.forward ? s.e.from : s.e.to), b = nodes.get(s.forward ? s.e.to : s.e.from);
    const total = polylineLength(pl);
    let acc = 0;
    for (let i = 1; i < pl.length; i++) {
      acc += d3(pl[i - 1], pl[i]);
      const last = i === pl.length - 1;
      const floor = last ? b.floor : (a.floor === b.floor ? a.floor : acc < total / 2 ? a.floor : b.floor);
      waypoints.push({ x: pl[i].x, y: pl[i].y, z: pl[i].z, floor, label: last ? (b.role || 'node') : s.e.kind, node: last ? b.id : null, edge: s.e.id });
    }
    edges.push({ id: s.e.id, kind: s.e.kind, label: s.e.label || null, from: a.id, to: b.id, verified: !!s.e.verified, length_m: +total.toFixed(2) });
  }
  const last = waypoints[waypoints.length - 1];
  last.label = 'arrive';

  // directions: group consecutive same-floor walking into legs split at turns; one leg per floor change
  const legs = [];
  let h = null, legDist = 0, legStartIdx = 0, totalDist = 0, seconds = 0;
  const flushWalk = (i, turn) => {
    if (legDist < 0.5) return;
    const key = turn === 'right' ? 'turn_right' : turn === 'left' ? 'turn_left' : 'straight';
    const d = Math.round(legDist);
    legs.push({ kind: 'walk', key, distance_m: d, floor: waypoints[i].floor, point_index: i,
      text: key === 'straight' ? `Walk straight ahead for ${d} m.` : `Turn ${turn} and walk ${d} m.` });
  };
  let pendingTurn = 'straight';
  let wi = 1;
  for (const s of steps) {
    const pl = s.forward ? s.e.polyline : [...s.e.polyline].reverse();
    const b = nodes.get(s.forward ? s.e.to : s.e.from);
    const segPts = pl.length - 1;
    const len = polylineLength(pl);
    totalDist += len;
    if (s.e.kind === 'walk' || s.e.kind === 'door') {
      seconds += len / WALK_SPEED;
      for (let i = 1; i < pl.length; i++, wi++) {
        const hh = heading(pl[i - 1], pl[i]);
        if (!hh) continue;
        if (h) {
          const turn = turnOf(h, hh);
          if (turn !== 'straight') { flushWalk(wi - 1, pendingTurn); legDist = 0; legStartIdx = wi - 1; pendingTurn = turn; }
        }
        legDist += d3(pl[i - 1], pl[i]);
        h = hh;
      }
    } else {
      flushWalk(wi - 1, pendingTurn); legDist = 0; pendingTurn = 'straight';
      const a = nodes.get(s.forward ? s.e.from : s.e.to);
      const up = b.floor > a.floor || (b.floor === a.floor && b.y > a.y);
      // count landing turns on the stair polyline (actual geometry, not a generic "top of stairs" sentence)
      const turns = [];
      let sh = null, firstLanding = null;
      if (s.e.kind === 'stairs' || s.e.kind === 'ramp') {
        for (let i = 1; i < pl.length; i++) { const hh = heading(pl[i - 1], pl[i]); if (!hh) continue; if (sh) { const t = turnOf(sh, hh); if (t !== 'straight') { turns.push(t); firstLanding ??= Math.max(wi - 1, wi + i - 3); } } sh = hh; }
      }
      const kind = s.e.kind === 'lift' ? 'elevator' : s.e.kind;
      const fname = floorNameOf(graph, b.floor);
      legs.push({ kind: 'floor_change', key: `${kind}_${up ? 'up' : 'down'}`, floor_name: fname, floor: b.floor, distance_m: Math.round(len),
        point_index: wi + segPts - 1, edge_label: s.e.label || null, landing_turns: turns,
        text: `Take the ${s.e.label || kind} ${up ? 'up' : 'down'} to the ${fname}.` });
      if (turns.length) {
        const same = turns.every(t => t === turns[0]);
        legs.push({ kind: 'stairs_turns', key: same ? `landings_${turns[0]}` : 'landings_mixed', n: turns.length, floor: b.floor, distance_m: 0, point_index: wi + segPts - 1, start_point_index: firstLanding,
          text: !same ? 'Follow the stairs around the landings.' : turns.length === 1 ? `At the landing, turn ${turns[0]}.` : `At each of the ${turns.length} landings, turn ${turns[0]}.` });
      }
      seconds += s.e.kind === 'lift' ? LIFT_SECONDS : len * STAIR_SECONDS_PER_M;
      wi += segPts;
      h = heading(pl[pl.length - 2], pl[pl.length - 1]) || h;
      if (s.e.kind === 'lift') h = null; // facing after a lift is not known from the graph
    }
  }
  // final walking leg, then the arrival sentence relative to the walker's heading
  const arriveIdx = waypoints.length - 1;
  flushWalk(arriveIdx, pendingTurn);
  const door = destination.doorPoint || null;
  const side = door && h ? sideOf(h, last, door) : 'ahead';
  legs.push({ kind: 'arrive', key: `arrive_${side}`, distance_m: 0, floor: last.floor, point_index: arriveIdx,
    room_name: destination.name || '', room_code: destination.code || '',
    text: `${destination.name || 'Your destination'} is ${side === 'ahead' ? 'straight ahead' : 'on your ' + side}${destination.code ? ` (${destination.code})` : ''}.` });
  // a short "walk straight" stub (e.g. stepping off a stair landing) folds into the next walking leg
  for (let i = legs.length - 2; i >= 0; i--) {
    const a = legs[i], b = legs[i + 1];
    if (a.kind === 'walk' && a.key === 'straight' && a.distance_m < 2 && b.kind === 'walk') {
      b.distance_m += a.distance_m;
      b.text = b.key === 'straight' ? `Walk straight ahead for ${b.distance_m} m.` : `Turn ${b.key.slice(5)} and walk ${b.distance_m} m.`;
      legs.splice(i, 1);
    }
  }
  const startFloor = start.floor, endFloor = last.floor;
  return {
    from: { kiosk_node: start.id, floor_level: startFloor, x: start.x, y: start.y, z: start.z },
    to: { node: destination.nodeId, room_id: destination.roomId ?? null, room_code: destination.code || null, room_name: destination.name || null,
      floor_level: endFloor, floor_name: floorNameOf(graph, endFloor), x: last.x, y: last.y, z: last.z, door: door },
    waypoints, edges, directions: legs,
    floors_used: [...new Set(waypoints.map(w => w.floor))],
    distance_m: Math.round(totalDist),
    minutes: Math.max(1, Math.round(seconds / 60)),
    estimate_note: 'Walking time is an estimate.',
  };
}
