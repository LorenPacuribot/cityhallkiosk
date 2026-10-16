// Shared graph planner (public/shared/nav-graph.js): correctness rules from docs/3D_MODEL_INTEGRATION_GUIDE.md §12.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planGraphRoute, validateGraph, edgeAllowed, ROUTE_REASONS as R } from '../public/shared/nav-graph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pilot = JSON.parse(fs.readFileSync(path.join(HERE, '../data/navigation/r09-pilot-draft.json'), 'utf8'));

// A small synthetic building: corridor with a left turn, stairs (short) and a ramp (long) to a mezzanine.
function synthetic(over = {}) {
  const n = (id, x, z, floor = 1, y = 0, role = 'junction') => ({ id, x, y, z, floor, role });
  const e = (id, from, to, pts, extra = {}) => ({ id, from, to, kind: 'walk', polyline: pts.map(([x, y, z]) => ({ x, y, z })), bidirectional: true, verified: true, public: true, step_free: true, closed: false, ...extra });
  return {
    modelVersion: 'm1', navigationVersion: 'n1', floors: [{ level: 1, name: '1st floor' }, { level: 2, name: '2nd floor' }],
    nodes: [n('K', 0, 0, 1, 0, 'kiosk'), n('A', 0, 10), n('B', -10, 10), n('DOOR', -10, 12, 1, 0, 'door_approach'),
      n('SF', 5, 10), n('ST', 5, 14, 2, 4, 'stair_top'), n('RT', 5, 14.5, 2, 4), n('UP', 10, 14, 2, 4, 'door_approach'), n('ISLAND', 50, 50)],
    edges: [
      e('KA', 'K', 'A', [[0, 0, 0], [0, 0, 10]]),
      e('AB', 'A', 'B', [[0, 0, 10], [-10, 0, 10]]),
      e('BD', 'B', 'DOOR', [[-10, 0, 10], [-10, 0, 12]]),
      e('AS', 'A', 'SF', [[0, 0, 10], [5, 0, 10]]),
      e('STAIRS', 'SF', 'ST', [[5, 0, 10], [5, 2, 12], [5, 4, 14]], { kind: 'stairs', step_free: false, label: 'test stairs' }),
      e('RAMP', 'SF', 'RT', [[5, 0, 10], [20, 0, 10], [20, 4, 30], [5, 4, 14.5]], { kind: 'ramp', step_free: true }),
      e('ST-UP', 'ST', 'UP', [[5, 4, 14], [10, 4, 14]]),
      e('RT-ST', 'RT', 'ST', [[5, 4, 14.5], [5, 4, 14]]),
      ...(over.edges || []),
    ],
    kiosks: { 'K-1': 'K' },
    ...over.top,
  };
}
const dest = (nodeId, extra = {}) => ({ nodeId, name: 'Test office', code: 'T-1', ...extra });

test('graph validation rejects structural errors', () => {
  assert.deepEqual(validateGraph(synthetic()), []);
  assert.deepEqual(validateGraph(pilot), []);
  const bad = synthetic();
  bad.edges.push({ id: 'X', from: 'K', to: 'NOPE', kind: 'walk', polyline: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] });
  bad.edges.push({ id: 'Y', from: 'A', to: 'ST', kind: 'walk', polyline: [{ x: 0, y: 0, z: 10 }, { x: 5, y: 4, z: 14 }] });
  bad.edges.push({ id: 'Z', from: 'SF', to: 'ST', kind: 'stairs', step_free: true, polyline: [{ x: 5, y: 0, z: 10 }, { x: 5, y: 4, z: 14 }] });
  bad.edges.push({ id: 'W', from: 'K', to: 'A', kind: 'walk', polyline: [{ x: 9, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }] });
  const errs = validateGraph(bad).join('\n');
  assert.match(errs, /X: unknown endpoint/);
  assert.match(errs, /Y: changes floor but is a walk edge/);
  assert.match(errs, /Z: stairs cannot be step-free/);
  assert.match(errs, /W: polyline does not start\/end at its nodes/);
});

test('same-floor route: distance along real polylines, turns and arrival side', () => {
  const r = planGraphRoute({ graph: synthetic(), kioskCode: 'K-1', destination: dest('DOOR', { doorPoint: { x: -11, y: 0, z: 12 } }) });
  assert.equal(r.status, 'ok');
  assert.equal(r.distance_m, 22);
  assert.deepEqual(r.directions.map(d => d.key), ['straight', 'turn_left', 'turn_right', 'arrive_left']);
  assert.deepEqual(r.edges.map(e => e.id), ['KA', 'AB', 'BD']);
  for (const k of ['from', 'to', 'waypoints', 'directions', 'distance_m', 'minutes', 'status', 'modelVersion', 'navigationVersion', 'routePreference', 'originKioskCode'])
    assert.ok(k in r, `route has ${k}`);
  assert.equal(r.verification, 'verified');
});

test('every consecutive waypoint pair lies on a chosen edge: no shortcut lines', () => {
  const g = synthetic();
  const r = planGraphRoute({ graph: g, kioskCode: 'K-1', destination: dest('UP') });
  const segs = new Set();
  for (const e of g.edges) for (let i = 1; i < e.polyline.length; i++) {
    const k = (a, b) => `${a.x},${a.y},${a.z}>${b.x},${b.y},${b.z}`;
    segs.add(k(e.polyline[i - 1], e.polyline[i])); segs.add(k(e.polyline[i], e.polyline[i - 1]));
  }
  for (let i = 1; i < r.waypoints.length; i++) {
    const a = r.waypoints[i - 1], b = r.waypoints[i];
    assert.ok(segs.has(`${a.x},${a.y},${a.z}>${b.x},${b.y},${b.z}`), `waypoint ${i} follows a graph segment`);
  }
});

test('step-free requests never use stairs and never fall back to them', () => {
  const g = synthetic();
  const any = planGraphRoute({ graph: g, kioskCode: 'K-1', destination: dest('UP') });
  assert.ok(any.edges.some(e => e.kind === 'stairs'), 'default route takes the shorter stairs');
  const sf = planGraphRoute({ graph: g, kioskCode: 'K-1', destination: dest('UP'), preference: 'step_free' });
  assert.equal(sf.status, 'ok');
  assert.ok(!sf.edges.some(e => e.kind === 'stairs'), 'step-free route avoids stairs');
  assert.ok(sf.edges.some(e => e.id === 'RAMP'));
  assert.equal(sf.routePreference, 'step_free');

  // ramp step-free status unknown -> not eligible -> explicit no-route, not stairs
  const unknown = synthetic(); unknown.edges.find(e => e.id === 'RAMP').step_free = null;
  const r = planGraphRoute({ graph: unknown, kioskCode: 'K-1', destination: dest('UP'), preference: 'step_free' });
  assert.equal(r.status, 'no_route');
  assert.equal(r.reason, R.NO_STEP_FREE_ROUTE);
  assert.equal(r.waypoints, undefined, 'a failed route carries no line to draw');
  assert.equal(edgeAllowed({ kind: 'stairs', verified: true, step_free: false }, { preference: 'step_free' }), false);
});

test('closures, disconnected graphs, unknown kiosks and unmapped destinations fail explicitly', () => {
  const closed = synthetic(); closed.edges.find(e => e.id === 'BD').closed = true;
  assert.equal(planGraphRoute({ graph: closed, kioskCode: 'K-1', destination: dest('DOOR') }).reason, R.ROUTE_CLOSED);

  assert.equal(planGraphRoute({ graph: synthetic(), kioskCode: 'K-1', destination: dest('ISLAND') }).reason, R.DISCONNECTED);
  const unknownKiosk = planGraphRoute({ graph: synthetic(), kioskCode: 'K-UNKNOWN', destination: dest('DOOR') });
  assert.equal(unknownKiosk.reason, R.UNKNOWN_KIOSK);
  assert.equal(unknownKiosk.originKioskCode, 'K-UNKNOWN', 'never silently substitutes another kiosk');
  assert.equal(planGraphRoute({ graph: synthetic(), kioskCode: 'K-1', destination: { name: 'Unmapped office' } }).reason, R.UNVERIFIED_DESTINATION);
  assert.equal(planGraphRoute({ graph: synthetic(), kioskCode: 'K-1', destination: dest('NOT-A-NODE') }).reason, R.UNKNOWN_DESTINATION);
  assert.equal(planGraphRoute({ graph: synthetic(), kioskCode: 'K-1', destination: dest('DOOR'), versions: { modelVersion: 'other' } }).reason, R.VERSION_MISMATCH);
  assert.equal(planGraphRoute({ graph: null, kioskCode: 'K-1', destination: dest('DOOR') }).reason, R.NO_GRAPH);
});

test('unverified edges are excluded unless a labelled draft preview asks for them', () => {
  const g = synthetic(); g.edges.find(e => e.id === 'AB').verified = false;
  const strict = planGraphRoute({ graph: g, kioskCode: 'K-1', destination: dest('DOOR') });
  assert.equal(strict.reason, R.UNVERIFIED_ROUTE);
  const preview = planGraphRoute({ graph: g, kioskCode: 'K-1', destination: dest('DOOR'), allowUnverified: true });
  assert.equal(preview.status, 'ok');
  assert.equal(preview.verification, 'unverified');
});

test('pilot routes: entrance to both wings on both floors, via the correct stairs and landings', () => {
  const byId = Object.fromEntries(pilot.destinations.map(d => [d.id, d]));
  const plan = (id, extra = {}) => planGraphRoute({ graph: pilot, kioskCode: 'PILOT-ENTRANCE', destination: byId[id], allowUnverified: true, ...extra });

  const gfl = plan('PILOT-GF-LEFT');
  assert.equal(gfl.status, 'ok');
  assert.deepEqual(gfl.floors_used, [1]);
  assert.deepEqual(gfl.directions.map(d => d.key), ['straight', 'turn_left', 'turn_right', 'arrive_ahead']);
  assert.ok(gfl.to.x < 0, 'left wing is on the visitor\'s left (negative x)');

  const gfr = plan('PILOT-GF-RIGHT');
  assert.deepEqual(gfr.directions.map(d => d.key), ['straight', 'turn_right', 'turn_left', 'arrive_ahead']);
  assert.ok(gfr.to.x > 0);

  const f2l = plan('PILOT-2F-LEFT');
  assert.ok(f2l.edges.some(e => e.id === 'S-LEFT-GF-F2'), 'uses the left stairs');
  const lt = f2l.directions.find(d => d.kind === 'stairs_turns');
  assert.equal(lt.key, 'landings_right'); assert.equal(lt.n, 2);
  assert.deepEqual(f2l.floors_used, [1, 2]);
  assert.equal(f2l.directions.at(-1).key, 'arrive_left');

  const f2r = plan('PILOT-2F-RIGHT');
  assert.ok(f2r.edges.some(e => e.id === 'S-RIGHT-GF-F2'), 'uses the right stairs');
  assert.ok(!f2r.edges.some(e => e.kind === 'lift'), 'never the unconfirmed lift');
  const rt = f2r.directions.find(d => d.kind === 'stairs_turns');
  assert.equal(rt.key, 'landings_left'); assert.equal(rt.n, 2);
  assert.equal(f2r.directions.at(-1).key, 'arrive_right');

  // stair waypoints climb through the actual landing heights, not a diagonal through the slab
  const stairY = f2l.waypoints.filter(w => w.edge === 'S-LEFT-GF-F2').map(w => w.y);
  assert.ok(stairY.includes(1.345) && stairY.includes(2.679), 'passes both left-stair landings');

  for (const id of Object.keys(byId)) {
    assert.equal(plan(id, { allowUnverified: false }).reason, R.UNVERIFIED_ROUTE, `${id}: nothing is verified yet`);
    assert.equal(plan(id).verification, 'unverified');
  }
  for (const id of ['PILOT-2F-LEFT', 'PILOT-2F-RIGHT', 'PILOT-GF-LEFT']) assert.equal(plan(id, { preference: 'step_free' }).reason, R.NO_STEP_FREE_ROUTE);
});

test('the planner is deterministic', () => {
  const d = pilot.destinations[2];
  const a = planGraphRoute({ graph: pilot, kioskCode: 'PILOT-ENTRANCE', destination: d, allowUnverified: true });
  const b = planGraphRoute({ graph: structuredClone(pilot), kioskCode: 'PILOT-ENTRANCE', destination: d, allowUnverified: true });
  assert.deepEqual(a, b);
});
