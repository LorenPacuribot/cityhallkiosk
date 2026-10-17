// Geometry regression for the real release, independent of GPU/browser screenshots.
// Tests centreline clearance, not a full character capsule or a field-accessibility survey.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { readGlb, readAccessor, worldMatrices } from '../../tools/model/glb.mjs';
import { glbRootMatrix, toRender } from '../public/kiosk/three/coordinates.js';
import { planGraphRoute, resolveDestination } from '../public/shared/nav-graph.js';
import { buildWalk } from '../public/shared/walk-path.js';

const file = new URL('../public/models/cityhall/r09-web02/building.glb', import.meta.url);
test('real pilot walks clear solid geometry and stay above the stair treads', { skip: !fs.existsSync(file) }, () => {
  const graph = JSON.parse(fs.readFileSync(new URL('../data/navigation/r09-pilot-draft.json', import.meta.url)));
  const g = readGlb(file), world = worldMatrices(g.json).world;
  const root = glbRootMatrix(graph.calibration, graph.modelVersion, { allowDraft: true }), meshes = [];
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  for (let i = 0; i < g.json.nodes.length; i++) {
    const node = g.json.nodes[i]; if (node.mesh === undefined) continue;
    for (const primitive of g.json.meshes[node.mesh].primitives) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(readAccessor(g, primitive.attributes.POSITION).array, 3));
      if (primitive.indices !== undefined) geometry.setIndex(new THREE.Uint32BufferAttribute(readAccessor(g, primitive.indices).array, 1));
      const mesh = new THREE.Mesh(geometry, material); mesh.name = node.name;
      mesh.applyMatrix4(root.clone().multiply(new THREE.Matrix4().fromArray(world[i]))); mesh.updateMatrixWorld(true); meshes.push(mesh);
    }
  }
  const ray = new THREE.Raycaster();
  for (const opening of graph.openings.filter(o => o.approachNodeId)) {
    const route = planGraphRoute({ graph, kioskCode: 'PILOT-ENTRANCE', destination: resolveDestination(graph, { openingId: opening.openingId }, { preview: true }).destination, allowUnverified: true });
    for (let i = 1; i < route.waypoints.length; i++) for (const height of [.35, .85, 1.6]) {
      const a = route.waypoints[i - 1], b = route.waypoints[i];
      const from = toRender({ ...a, y: a.y + height }), to = toRender({ ...b, y: b.y + height }), delta = to.sub(from);
      ray.set(from, delta.clone().normalize()); ray.near = .02; ray.far = delta.length() - .02;
      assert.equal(ray.intersectObjects(meshes, false).length, 0, `${opening.openingId}, segment ${i}, height ${height}: solid obstruction`);
    }
    const walk = buildWalk(route.waypoints, route.to.door);
    for (let s = 0; s < walk.length; s += .25) {
      const p = walk.poseAtDistance(s); if (p.y <= .05 || p.y >= 3.95) continue;
      ray.set(toRender({ ...p, y: p.y + .8 }), new THREE.Vector3(0, -1, 0)); ray.near = 0; ray.far = 1.4;
      const surface = ray.intersectObjects(meshes, false)[0];
      assert.ok(surface, 'stair surface beneath the route');
      const offset = p.y - surface.point.y;
      assert.ok(offset >= -.025 && offset <= .2, `stair pitch line offset ${offset.toFixed(3)} m at ${s.toFixed(2)} m`);
    }
  }
  meshes.forEach(m => m.geometry.dispose()); material.dispose();
});
