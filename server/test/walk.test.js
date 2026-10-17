import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWalk, viewDirection, activeDirection, WALK_DEFAULTS } from '../public/shared/walk-path.js';
import { planGraphRoute, resolveDestination } from '../public/shared/nav-graph.js';
import fs from 'node:fs';

const graph = JSON.parse(fs.readFileSync(new URL('../data/navigation/r09-pilot-draft.json', import.meta.url)));
for (const opening of graph.openings.filter(o => o.approachNodeId)) {
  test(`first-person walk stays on the corridor and faces door ${opening.openingId}`, () => {
    const { destination } = resolveDestination(graph, { openingId: opening.openingId }, { preview: true });
    const route = planGraphRoute({ graph, kioskCode: 'PILOT-ENTRANCE', destination, allowUnverified: true });
    assert.equal(route.status, 'ok');
    const landing = route.directions.findIndex(d => d.kind === 'stairs_turns');
    if (landing >= 0) {
      const start = route.directions[landing].start_point_index;
      assert.equal(activeDirection(route.directions, { seg: start - 1, f: 0 }), landing - 1);
      assert.equal(activeDirection(route.directions, { seg: start, f: 0 }), landing);
    }
    const walk = buildWalk(route.waypoints, route.to.door);
    const start = walk.sample(0), entrance = route.waypoints[0];
    for (const k of ['x', 'y', 'z', 'floor']) assert.equal(start[k], entrance[k]);
    assert.equal(walk.sample(WALK_DEFAULTS.startHold / 2).s, 0, 'entrance hold');
    let previous = 0;
    for (let t = 0; t < walk.duration; t += .1) {
      const p = walk.sample(t), a = route.waypoints[p.seg], b = route.waypoints[p.seg + 1];
      assert.ok(p.s >= previous); previous = p.s;
      for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(p[k] - (a[k] + (b[k] - a[k]) * p.f)) < 1e-7, 'no corner shortcut');
      assert.ok(Number.isFinite(p.yaw) && Number.isFinite(p.pitch));
    }
    const end = walk.sample(walk.duration), last = route.waypoints.at(-1);
    const beforeDoor = viewDirection(walk.sample(walk.walkEnd - .001).yaw, 0);
    const atDoor = viewDirection(walk.sample(walk.walkEnd).yaw, 0);
    assert.ok(beforeDoor.x * atDoor.x + beforeDoor.z * atDoor.z > .999, 'no heading snap at the door');
    assert.equal(end.phase, 'arrived');
    for (const k of ['x', 'y', 'z', 'floor']) assert.equal(end[k], last[k]);
    const dir = viewDirection(end.yaw, end.pitch), dx = route.to.door.x - end.x, dz = route.to.door.z - end.z;
    if (Math.hypot(dx, dz) > .2) assert.ok((dir.x * dx + dir.z * dz) / Math.hypot(dx, dz) > .999);
  });
}
