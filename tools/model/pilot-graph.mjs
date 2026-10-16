#!/usr/bin/env node
// Builds the DRAFT pilot navigation graph for model r09-web01 from cited model evidence.
//
//   node tools/model/pilot-graph.mjs [out.json]      (default server/data/navigation/r09-pilot-draft.json)
//
// Nothing here is a field survey. Every node cites the model-workspace file it came from; every edge is
// verified:false and step_free:null (unknown). Staff must walk each route and confirm it before any edge is
// marked verified. Positions are Blender world metres (Z up) converted with the DRAFT calibration below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGraph, polylineLength } from '../../server/public/shared/nav-graph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || path.join(HERE, '../../server/data/navigation/r09-pilot-draft.json'));
const WS = 'CityHallKiosk_Codex';
const SRC = {
  walk: `${WS}/interior_walkthrough/Capture_Manifest.json shots[].actual_camera_position (eye 1.60 m above floor; revision 05 geometry, lineage to r09 not re-verified)`,
  poses: `${WS}/scripts/prepare_walkthrough_poses.py (requested stair stations)`,
  stairs: `${WS}/front_facade_review/Mesh_Inventory.json lo/hi (stair flights and landings)`,
  doors: `${WS}/interior_walkthrough_plan/Model_Area_Inventory.json candidate_doorways[].center (first leaf bbox centre)`,
  lift: `${WS}/front_facade_review/Mesh_Inventory.json RIGHT_ELEVATOR_* and R_ELEVATOR_F*_door_gap (concept v3, dimensions estimated)`,
  facade: `${WS}/scripts/build_v3.py V3_Entrance_Wall y=-17.5; Front_Opening_Schedule.csv FRONT-017/018 x=∓3.1`,
  corridor2f: `${WS}/second_floor_revision/README.md (2F fixture rows centred y=-5.0 left, -4.5 right)`,
};

// DRAFT calibration: Blender world -> canonical. Origin = midpoint between the two main entrance doorways on the
// facade line (x=0, y=-17.5, z=0). Front faces -Y, so +Y is "into the building" (canonical +Z) and +X is the
// visitor's right. Needs field anchors (entrance centre, left/right points, upstairs landing, one known distance).
export const DRAFT_CALIBRATION = {
  modelVersion: 'r09-web01', calibrationVersion: 'r09-cal-draft-1', status: 'draft', units: 'metres',
  description: 'Model-derived draft. Origin = midpoint of the two entrance doorways on the facade line; NOT surveyed.',
  // column-major: canonical = A * blender ; x'=x, y'=z, z'=y+17.5
  matrixBlenderToCanonical: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 17.5, 1],
  anchors: [
    { id: 'ENTRANCE_CENTRE', blender: [0, -17.5, 0], canonical: [0, 0, 0], source: SRC.facade, measured: null, residual_m: null },
  ],
  floorElevations: { 1: 0.0, 2: 4.0 },
  floorElevationSource: `${WS}/front_facade_review/Mesh_Inventory.json F1_slab top z=0.0, F2_slab top z=4.0; database floors.elevation_y is a placeholder (4.2)`,
  residualsMeasured: false,
};
const c = ([bx, by, bz]) => ({ x: +bx.toFixed(3), y: +bz.toFixed(3), z: +(by + 17.5).toFixed(3) });

const nodes = [];
const node = (id, floor, role, b, source, label = null) => { nodes.push({ id, floor, role, label, ...c(b), blender: b, source, verified: false }); return id; };
const edges = [];
const edge = (id, kind, from, to, viaBlender, { label = null, source, isPublic = true } = {}) => {
  const a = nodes.find(n => n.id === from), b = nodes.find(n => n.id === to);
  const polyline = [a, ...viaBlender.map(c), b].map(({ x, y, z }) => ({ x, y, z }));
  edges.push({ id, kind, from, to, polyline, length_m: +polylineLength(polyline).toFixed(3), bidirectional: true,
    verified: false, public: isPublic, step_free: kind === 'stairs' ? false : null, closed: false, label, source });
};

// ---------------------------------------------------------------- ground floor (level 1, z = 0)
node('GF-ENTRANCE', 1, 'entrance', [3.25, -16.0, 0], `${SRC.walk} ENTRY-04 (inside the right-hand entrance doors)`, 'Main entrance');
node('GF-LOBBY', 1, 'junction', [0.25, -4.0, 0], `${SRC.walk} ENTRY-07`, 'Lobby');
edge('E-ENT-LOBBY', 'walk', 'GF-ENTRANCE', 'GF-LOBBY', [[0.25, -5.0, 0]], { source: `${SRC.walk} ENTRY-04 -> ENTRY-06 -> ENTRY-07` });

// left wing
node('GF-L-FOYER', 1, 'junction', [-13.75, -4.5, 0], `${SRC.walk} GF-L foyer`);
node('GF-L-STAIRAPP', 1, 'junction', [-8.0, -4.5, 0], `${SRC.walk} L-STAIR approach`);
node('GF-L-C1', 1, 'junction', [-21.75, -5.0, 0], `${SRC.walk} GF-L corridor y=-5.0`);
node('GF-L-D108', 1, 'junction', [-35.225, -5.0, 0], `${SRC.doors} R1-W002-D108 x, on the GF-L corridor line y=-5.0 (${SRC.walk})`);
node('GF-L-D108-APP', 1, 'door_approach', [-35.225, -3.0, 0], `1.0 m in front of door leaf centre (-35.225,-1.975) from ${SRC.doors}`, 'Doorway R1-W002-D108');
edge('E-LOBBY-LSTAIRAPP', 'walk', 'GF-LOBBY', 'GF-L-STAIRAPP', [], { source: SRC.walk });
edge('E-LSTAIRAPP-LFOYER', 'walk', 'GF-L-STAIRAPP', 'GF-L-FOYER', [], { source: SRC.walk });
edge('E-LFOYER-LC1', 'walk', 'GF-L-FOYER', 'GF-L-C1', [[-18.25, -5.0, 0]], { source: SRC.walk });
edge('E-LC1-LD108', 'walk', 'GF-L-C1', 'GF-L-D108', [[-26.75, -5.0, 0]], { source: SRC.walk });
edge('E-LD108-APP', 'door', 'GF-L-D108', 'GF-L-D108-APP', [], { source: SRC.doors });

// right wing
node('GF-R-STAIRAPP', 1, 'junction', [8.0, -4.5, 0], `${SRC.walk} R-STAIR approach (mirror of L-STAIR station)`);
node('GF-R-FOYER', 1, 'junction', [13.75, -4.0, 0], `${SRC.walk} GF-R foyer`);
node('GF-R-C1', 1, 'junction', [21.75, -4.0, 0], `${SRC.walk} GF-R corridor y=-4.0`);
node('GF-R-D133', 1, 'junction', [26.525, -4.0, 0], `${SRC.doors} R1-W038-D133 x, on the GF-R corridor line y=-4.0 (${SRC.walk})`);
node('GF-R-D133-APP', 1, 'door_approach', [26.525, -3.0, 0], `1.0 m in front of door leaf centre (26.525,-2.025) from ${SRC.doors}`, 'Doorway R1-W038-D133');
edge('E-LOBBY-RSTAIRAPP', 'walk', 'GF-LOBBY', 'GF-R-STAIRAPP', [], { source: SRC.walk });
edge('E-RSTAIRAPP-RFOYER', 'walk', 'GF-R-STAIRAPP', 'GF-R-FOYER', [], { source: SRC.walk });
edge('E-RFOYER-RC1', 'walk', 'GF-R-FOYER', 'GF-R-C1', [[18.25, -4.0, 0]], { source: SRC.walk });
edge('E-RC1-RD133', 'walk', 'GF-R-C1', 'GF-R-D133', [[24.25, -4.0, 0]], { source: SRC.walk });
edge('E-RD133-APP', 'door', 'GF-R-D133', 'GF-R-D133-APP', [], { source: SRC.doors });

// ---------------------------------------------------------------- stairs (actual flights and landings)
node('GF-L-STAIRFOOT', 1, 'stair_foot', [-11.45, -4.75, 0], `${SRC.walk} L-STAIR foot`, 'Left main stairs');
node('F2-L-STAIRTOP', 2, 'stair_top', [-18.55, -6.6, 4.0], `${SRC.walk} L-STAIR arrival`, 'Left main stairs (2nd floor)');
edge('E-LSTAIRAPP-LFOOT', 'walk', 'GF-L-STAIRAPP', 'GF-L-STAIRFOOT', [], { source: SRC.walk });
edge('S-LEFT-GF-F2', 'stairs', 'GF-L-STAIRFOOT', 'F2-L-STAIRTOP',
  [[-11.45, -8.0, 0.179], [-11.45, -9.1, 0.679], [-11.45, -11.3, 1.345], [-14.8, -11.5, 2.012], [-18.55, -11.5, 2.679], [-18.55, -9.4, 3.345], [-18.55, -8.1, 3.845]],
  { label: 'left main stairs', source: `${SRC.poses}; ${SRC.stairs} (Landing0 z 1.345, Landing1 z 2.679; two right turns)` });

node('GF-R-STAIRFOOT', 1, 'stair_foot', [11.45, -4.75, 0], `${SRC.walk} R-STAIR foot`, 'Right main stairs');
node('F2-R-STAIRTOP', 2, 'stair_top', [18.55, -6.6, 4.0], `${SRC.walk} R-STAIR arrival`, 'Right main stairs (2nd floor)');
edge('E-RSTAIRAPP-RFOOT', 'walk', 'GF-R-STAIRAPP', 'GF-R-STAIRFOOT', [], { source: SRC.walk });
edge('S-RIGHT-GF-F2', 'stairs', 'GF-R-STAIRFOOT', 'F2-R-STAIRTOP',
  // flight 1 has 6 treads (z 0.183 -> 1.016 over y -7.665 -> -9.54); the -9.1 station z is interpolated along that flight
  [[11.45, -8.0, 0.179], [11.45, -9.1, 0.82], [11.45, -11.3, 1.012], [14.8, -11.5, 1.845], [18.55, -11.5, 2.679], [18.55, -9.4, 3.345], [18.55, -8.1, 3.845]],
  { label: 'right main stairs', source: `${SRC.poses}; ${SRC.stairs} (Landing0 z 1.012, Landing1 z 2.679; two left turns)` });

// ---------------------------------------------------------------- second floor (level 2, z = 4.0)
node('F2-L-FOYER', 2, 'junction', [-18.55, -5.2, 4.0], `${SRC.walk} L-STAIR top foyer`);
node('F2-L-C1', 2, 'junction', [-21.75, -5.0, 4.0], `${SRC.walk} 2F-L corridor y=-5.0; ${SRC.corridor2f}`);
node('F2-L-D210', 2, 'door_approach', [-26.625, -5.0, 4.0], `on the 2F-L corridor line, 0.975 m from door leaf centre (-26.625,-5.975) in ${SRC.doors}`, 'Doorway R2-W032-D210');
edge('E-F2LTOP-FOYER', 'walk', 'F2-L-STAIRTOP', 'F2-L-FOYER', [], { source: SRC.walk });
edge('E-F2LFOYER-C1', 'walk', 'F2-L-FOYER', 'F2-L-C1', [], { source: SRC.walk });
edge('E-F2LC1-D210', 'walk', 'F2-L-C1', 'F2-L-D210', [], { source: SRC.walk });

node('F2-R-FOYER', 2, 'junction', [18.55, -5.2, 4.0], `${SRC.walk} R-STAIR top foyer`);
node('F2-R-C1', 2, 'junction', [21.75, -4.5, 4.0], `${SRC.corridor2f} (right y=-4.5)`);
node('F2-R-D229', 2, 'door_approach', [25.375, -4.75, 4.0], `on the 2F-R corridor, 1.225 m from door leaf centre (25.375,-5.975) in ${SRC.doors}`, 'Doorway R2-W057-D229');
edge('E-F2RTOP-FOYER', 'walk', 'F2-R-STAIRTOP', 'F2-R-FOYER', [], { source: SRC.walk });
edge('E-F2RFOYER-C1', 'walk', 'F2-R-FOYER', 'F2-R-C1', [], { source: SRC.walk });
edge('E-F2RC1-D229', 'walk', 'F2-R-C1', 'F2-R-D229', [], { source: SRC.walk });

// ---------------------------------------------------------------- lift: modelled as a concept only.
// Kept in the graph so it can be verified later, but NOT public: its existence, stops and access are unconfirmed.
node('GF-LIFT', 1, 'lift', [15.5, -6.6, 0], `${SRC.lift}: GF door gap x 15.495–15.505, threshold y -7.675..-7.405; standing point 1 m in front`, 'Lift (concept, unverified)');
node('F2-LIFT', 2, 'lift', [15.5, -6.6, 4.0], `${SRC.lift}: F2 threshold z 4.0`, 'Lift 2nd floor (concept, unverified)');
edge('E-RFOYER-LIFT', 'walk', 'GF-R-FOYER', 'GF-LIFT', [], { source: `${SRC.walk} GF-R-05 elevator lobby face (15.75,-4.5)`, isPublic: false });
edge('L-RIGHT-GF-F2', 'lift', 'GF-LIFT', 'F2-LIFT', [[15.5, -8.9, 0], [15.5, -8.9, 4.0]], { label: 'lift', source: SRC.lift, isPublic: false });
edge('E-F2LIFT-RFOYER', 'walk', 'F2-LIFT', 'F2-R-FOYER', [], { source: `${SRC.walk} (2F foyer mirror of GF)`, isPublic: false });

const graph = {
  schemaVersion: 1, modelVersion: 'r09-web01', navigationVersion: 'r09-nav-pilot-draft-1', status: 'draft',
  calibrationVersion: DRAFT_CALIBRATION.calibrationVersion,
  note: 'Draft pilot graph from model evidence. No edge is verified; step-free status is unknown everywhere. Do not publish as verified directions.',
  floors: [{ level: 1, name: '1st floor' }, { level: 2, name: '2nd floor' }],
  nodes, edges,
  kiosks: { 'PILOT-ENTRANCE': 'GF-ENTRANCE' },
  destinations: [
    { id: 'PILOT-GF-LEFT', nodeId: 'GF-L-D108-APP', openingId: 'R1-W002-D108', name: 'Ground floor, left wing', code: 'R1-W002-D108', doorPoint: c([-35.225, -1.975, 0]), roomId: null, mapping: 'unresolved' },
    { id: 'PILOT-GF-RIGHT', nodeId: 'GF-R-D133-APP', openingId: 'R1-W038-D133', name: 'Ground floor, right wing', code: 'R1-W038-D133', doorPoint: c([26.525, -2.025, 0]), roomId: null, mapping: 'unresolved' },
    { id: 'PILOT-2F-LEFT', nodeId: 'F2-L-D210', openingId: 'R2-W032-D210', name: '2nd floor, left wing', code: 'R2-W032-D210', doorPoint: c([-26.625, -5.975, 4.0]), roomId: null, mapping: 'unresolved' },
    { id: 'PILOT-2F-RIGHT', nodeId: 'F2-R-D229', openingId: 'R2-W057-D229', name: '2nd floor, right wing', code: 'R2-W057-D229', doorPoint: c([25.375, -5.975, 4.0]), roomId: null, mapping: 'unresolved' },
  ],
  calibration: DRAFT_CALIBRATION,
  fieldVerificationNeeded: [
    'Actual kiosk position and facing (KIOSK-LOBBY-1 has only a placeholder).',
    'Four calibration anchors: entrance centre, a point left, a point right/deeper inside, an upstairs landing; one measured distance; real floor elevations.',
    'Which office occupies each pilot doorway (R1-W002-D108, R1-W038-D133, R2-W032-D210, R2-W057-D229), and that the doorway is the public entrance.',
    'That every corridor segment, both main stairs and their landings are public and walkable as drawn (positions come from revision 05 walkthrough stations).',
    'Whether the lift exists, where it stops and whether it is public; whether the entrance ramps exist and their levels.',
    'Step-free status of every corridor segment.',
  ],
};
// Sign faces and their openings from the verified Unity sidecar (hash-checked against the inventory).
// Every opening starts unresolved: the model does not say which office is behind a door.
import crypto from 'node:crypto';
const INV = JSON.parse(fs.readFileSync(path.join(HERE, '../../docs/3d-integration/source-inventory.json'), 'utf8'));
const dynEntry = INV.source_assets.find(a => a.path.endsWith('DynamicObjects.json'));
const dynBuf = fs.readFileSync(dynEntry.path);
if (crypto.createHash('sha256').update(dynBuf).digest('hex') !== dynEntry.sha256) { console.error('DynamicObjects.json differs from the verified inventory'); process.exit(1); }
const dyn = JSON.parse(dynBuf.toString('utf8')).objects;
graph.signs = dyn.filter(o => o.kind === 'sign').map(o => ({ assetId: `${graph.modelVersion}:${o.name}`, openingId: o.openingId, face: /_Face_B$/.test(o.name) ? 'B' : 'A' }));
const destByOpening = new Map(graph.destinations.map(d => [d.openingId, d]));
graph.openings = [...new Set(graph.signs.map(s => s.openingId))].sort().map(openingId => {
  const d = destByOpening.get(openingId);
  return { openingId, roomId: null, status: 'unresolved', approachNodeId: d?.nodeId ?? null, doorPoint: d?.doorPoint ?? null,
    label: d ? `${d.name} — doorway ${openingId}` : `Doorway ${openingId}`,
    doorAssetIds: dyn.filter(o => o.kind === 'door' && o.openingId === openingId).map(o => `${graph.modelVersion}:${o.name}`) };
});
for (const d of graph.destinations) if (!graph.openings.some(o => o.openingId === d.openingId)) throw new Error(`pilot destination ${d.openingId} has no sign opening`);

const problems = validateGraph(graph);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(graph, null, 1) + '\n');
console.log(`wrote ${OUT}: ${nodes.length} nodes, ${edges.length} edges`);
