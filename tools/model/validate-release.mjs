#!/usr/bin/env node
// Validates a browser model release directory (server/public/models/cityhall/<version>/).
//
//   node tools/model/validate-release.mjs <releaseDir>          -> prints a JSON report, exit 1 on any error
//
// Checks the manifest (relative paths, sizes, SHA-256, no unlisted files), materials.json, nodes.json,
// viewpoints.json and both GLBs: required attributes per primitive, finite data, index bounds, material
// bindings, unique stable asset IDs, expected object/triangle counts from the source inventory, and the
// per-object triangle-corner sums and bounds recorded by the Blender export (geometry tolerance 0.001 m).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, readAccessor, worldMatrices, transformPoint } from './glb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = path.resolve(HERE, '../../docs/3d-integration/source-inventory.json');
export const GEOMETRY_TOLERANCE_M = 0.001;

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const safeRelative = p => typeof p === 'string' && p.length > 0 && !p.includes('\\') && !p.startsWith('/')
  && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.split('/').some(s => s === '..' || s === '.' || s === '');

export function validateManifest(dir, manifest) {
  const errors = [];
  const need = ['schemaVersion', 'modelVersion', 'sourceBlendSha256', 'units', 'assetCoordinates', 'uvConvention',
    'building', 'scenery', 'materials', 'nodes', 'viewpoints', 'files'];
  for (const k of need) if (manifest[k] === undefined) errors.push(`manifest: missing ${k}`);
  if (manifest.schemaVersion !== 1) errors.push(`manifest: schemaVersion ${manifest.schemaVersion}, expected 1`);
  if (manifest.units !== 'metres') errors.push('manifest: units must be "metres"');
  if (manifest.assetCoordinates !== 'gltf-y-up-right-handed') errors.push('manifest: unexpected assetCoordinates');
  if (!/^[0-9a-f]{64}$/.test(manifest.sourceBlendSha256 || '')) errors.push('manifest: sourceBlendSha256 is not a SHA-256');
  if (path.basename(dir) !== manifest.modelVersion) errors.push(`manifest: modelVersion ${manifest.modelVersion} != directory ${path.basename(dir)}`);
  const listed = new Map();
  for (const f of manifest.files || []) {
    if (!safeRelative(f.path)) { errors.push(`manifest: unsafe path ${JSON.stringify(f.path)}`); continue; }
    if (listed.has(f.path)) errors.push(`manifest: duplicate ${f.path}`);
    listed.set(f.path, f);
    const abs = path.join(dir, ...f.path.split('/'));
    if (!fs.existsSync(abs)) { errors.push(`missing file ${f.path}`); continue; }
    const st = fs.statSync(abs);
    if (st.size !== f.bytes) errors.push(`${f.path}: ${st.size} bytes, manifest says ${f.bytes}`);
    else if (sha256(abs) !== f.sha256) errors.push(`${f.path}: SHA-256 mismatch`);
  }
  for (const k of ['building', 'scenery', 'materials', 'nodes', 'viewpoints']) {
    if (manifest[k] && !listed.has(manifest[k])) errors.push(`manifest: ${k} (${manifest[k]}) is not in files[]`);
  }
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const abs of walk(dir)) {
    const rel = path.relative(dir, abs).split(path.sep).join('/');
    if (rel !== 'manifest.json' && !listed.has(rel)) errors.push(`unlisted file in release: ${rel}`);
  }
  return { errors, listed };
}

function validateMaterials(materials, listed) {
  const errors = [];
  const names = new Set();
  const tex = p => { if (p && !listed.has(p)) errors.push(`materials: texture ${p} not in manifest`); };
  if (!materials.lut?.path) errors.push('materials: no LUT');
  tex(materials.lut?.path);
  for (const b of materials.bindings || []) {
    if (names.has(b.name)) errors.push(`materials: duplicate binding ${b.name}`);
    names.add(b.name);
    if (!['baked', 'pbr', 'projected'].includes(b.kind)) errors.push(`materials: ${b.name} has unknown kind ${b.kind}`);
    if (b.kind === 'baked') {
      if (!b.lightmap) errors.push(`materials: baked ${b.name} has no lightmap`);
      if (!(Number.isFinite(b.lightRange) && b.lightRange > 0)) errors.push(`materials: baked ${b.name} lightRange ${b.lightRange}`);
      tex(b.lightmap); tex(b.baseTexture);
    }
    if (b.kind === 'projected') {
      tex(b.baseTexture);
      if (!(Array.isArray(b.projection) && b.projection.length === 4 && b.projection.every(Number.isFinite))) errors.push(`materials: ${b.name} projection`);
    }
  }
  return { errors, names };
}

function close(a, b, tol) { return Math.abs(a - b) <= tol; }

/** Walks one GLB, checks primitives, returns per-logical-object stats keyed by sourceName. */
function inspectGlb(gltf, label, bindingNames, { requireBaked }) {
  const errors = [], objects = new Map();
  const { json } = gltf;
  const { world } = worldMatrices(json);
  const ids = new Set();
  json.nodes.forEach((n, i) => {
    const ex = n.extras || {};
    if (!ex.assetId) { errors.push(`${label}: node ${i} (${n.name}) has no extras.assetId`); return; }
    if (ids.has(ex.assetId)) errors.push(`${label}: duplicate assetId ${ex.assetId}`);
    ids.add(ex.assetId);
    if (n.mesh === undefined) return;
    if (!world[i]) { errors.push(`${label}: node ${n.name} not reachable from the scene`); return; }
    const mesh = json.meshes[n.mesh];
    const o = { assetId: ex.assetId, triangles: 0, pos: [0, 0, 0], uv0: [0, 0], uv1: [0, 0], color: [0, 0, 0, 0], tris_by_material: {},
      _PROJ_X: 0, _PROJ_Y: 0, _PROJ_DEPTH: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], attrs: new Set() };
    mesh.primitives.forEach((p, pi) => {
      const where = `${label}: ${ex.sourceName} primitive ${pi}`;
      if (p.mode !== undefined && p.mode !== 4) { errors.push(`${where}: mode ${p.mode}, expected triangles`); return; }
      const mat = json.materials?.[p.material];
      const binding = mat?.extras?.binding || mat?.name;
      if (!binding) errors.push(`${where}: no material binding`);
      else if (!bindingNames.has(binding)) errors.push(`${where}: binding ${binding} not in materials.json`);
      const need = requireBaked ? ['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0'] : ['POSITION', '_PROJ_X', '_PROJ_Y', '_PROJ_DEPTH'];
      for (const a of need) if (p.attributes[a] === undefined) errors.push(`${where}: missing ${a}`);
      const A = Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, readAccessor(gltf, v)]));
      Object.keys(A).forEach(k => o.attrs.add(k));
      const count = A.POSITION?.count ?? 0;
      for (const [k, a] of Object.entries(A)) {
        if (a.count !== count) errors.push(`${where}: ${k} has ${a.count} items, POSITION has ${count}`);
        for (let i = 0; i < a.array.length; i++) if (!Number.isFinite(a.array[i])) { errors.push(`${where}: ${k} has non-finite values`); break; }
      }
      let idx;
      if (p.indices !== undefined) idx = readAccessor(gltf, p.indices).array; else idx = Float64Array.from({ length: count }, (_, i) => i);
      if (idx.length % 3) errors.push(`${where}: index count ${idx.length} is not a multiple of 3`);
      for (let i = 0; i < idx.length; i++) if (idx[i] >= count || idx[i] < 0 || !Number.isInteger(idx[i])) { errors.push(`${where}: index out of range`); break; }
      const tris = idx.length / 3;
      o.triangles += tris;
      o.tris_by_material[binding] = (o.tris_by_material[binding] || 0) + tris;
      const m = world[i];
      for (let k = 0; k < idx.length; k++) {
        const v = idx[k];
        if (A.POSITION) {
          const w = transformPoint(m, A.POSITION.array[v * 3], A.POSITION.array[v * 3 + 1], A.POSITION.array[v * 3 + 2]);
          for (let c = 0; c < 3; c++) { o.pos[c] += w[c]; if (w[c] < o.min[c]) o.min[c] = w[c]; if (w[c] > o.max[c]) o.max[c] = w[c]; }
        }
        if (A.TEXCOORD_0) { o.uv0[0] += A.TEXCOORD_0.array[v * 2]; o.uv0[1] += A.TEXCOORD_0.array[v * 2 + 1]; }
        if (A.TEXCOORD_1) { o.uv1[0] += A.TEXCOORD_1.array[v * 2]; o.uv1[1] += A.TEXCOORD_1.array[v * 2 + 1]; }
        if (A.COLOR_0) { const s = A.COLOR_0.size; for (let c = 0; c < s; c++) o.color[c] += A.COLOR_0.array[v * s + c]; if (s === 3) o.color[3] += 1; }
        for (const s of ['_PROJ_X', '_PROJ_Y', '_PROJ_DEPTH']) if (A[s]) o[s] += A[s].array[v];
      }
    });
    objects.set(ex.sourceName, o);
  });
  return { errors, objects, ids };
}

export function compareToExport(objects, report, label) {
  const errors = [];
  let worstBounds = 0, worstMean = 0;
  for (const [name, o] of objects) {
    const r = report.objects[name];
    if (!r) { errors.push(`${label}: ${name} is not in the export report`); continue; }
    if (o.triangles !== r.triangles) errors.push(`${label}: ${name} has ${o.triangles} triangles, source ${r.triangles}`);
    for (const [m, n] of Object.entries(r.tris_by_material || {})) if ((o.tris_by_material[m] || 0) !== n) errors.push(`${label}: ${name} material ${m} has ${o.tris_by_material[m] || 0} triangles, source ${n}`);
    const corners = r.triangles * 3 || 1;
    for (let c = 0; c < 3; c++) {
      worstMean = Math.max(worstMean, Math.abs(o.pos[c] - r.pos[c]) / corners);
      if (r.bounds) worstBounds = Math.max(worstBounds, Math.abs(o.min[c] - r.bounds[0][c]), Math.abs(o.max[c] - r.bounds[1][c]));
    }
    const sumTol = n => 1e-3 * n + 1e-3;
    for (const k of ['uv0', 'uv1']) if (r[k] && o.attrs.has(k === 'uv0' ? 'TEXCOORD_0' : 'TEXCOORD_1')) {
      for (let c = 0; c < 2; c++) if (!close(o[k][c], r[k][c], sumTol(corners))) errors.push(`${label}: ${name} ${k} sum ${o[k][c].toFixed(4)} != source ${r[k][c].toFixed(4)}`);
    }
    if (r.color && o.attrs.has('COLOR_0')) for (let c = 0; c < 4; c++) if (!close(o.color[c], r.color[c], 2e-3 * corners + 1e-3)) errors.push(`${label}: ${name} colour[${c}] sum ${o.color[c].toFixed(4)} != source ${r.color[c].toFixed(4)}`);
    for (const s of ['_PROJ_X', '_PROJ_Y', '_PROJ_DEPTH']) if (r[s] !== undefined && !close(o[s], r[s], sumTol(corners) * Math.max(1, Math.abs(r[s]) / corners))) errors.push(`${label}: ${name} ${s} sum ${o[s]} != source ${r[s]}`);
  }
  if (worstBounds > GEOMETRY_TOLERANCE_M) errors.push(`${label}: worst object bounds error ${worstBounds.toExponential(2)} m > ${GEOMETRY_TOLERANCE_M}`);
  if (worstMean > GEOMETRY_TOLERANCE_M) errors.push(`${label}: worst mean corner position error ${worstMean.toExponential(2)} m > ${GEOMETRY_TOLERANCE_M}`);
  return { errors, worstBounds, worstMean };
}

export function validateRelease(dir, { inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8')) } = {}) {
  const errors = [], warnings = [], stats = {};
  const mf = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mf)) return { ok: false, errors: ['manifest.json missing'], warnings, stats };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { return { ok: false, errors: [`manifest.json: ${e.message}`], warnings, stats }; }
  const m = validateManifest(dir, manifest);
  errors.push(...m.errors);
  if (m.errors.length) return { ok: false, errors, warnings, stats };
  const read = rel => JSON.parse(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'));
  const blend = inventory.source_assets.find(a => /09_(Unity_)?Baked_Optimized\.blend$/.test(a.path));
  if (manifest.sourceBlendSha256 !== blend?.sha256) errors.push('manifest: source hash differs from the verified inventory');

  const materials = read(manifest.materials);
  const mv = validateMaterials(materials, m.listed);
  errors.push(...mv.errors);
  const kinds = {};
  for (const b of materials.bindings) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
  for (const [k, n] of Object.entries(inventory.material_kinds)) if (kinds[k] !== n) errors.push(`materials: ${kinds[k] || 0} ${k} bindings, inventory says ${n}`);

  const report = read('export-report.json');
  const nodes = read(manifest.nodes).nodes;
  const roles = {};
  for (const n of nodes) roles[n.role] = (roles[n.role] || 0) + 1;
  stats.roles = roles;
  if (roles.door_root !== inventory.closed_door_roots) errors.push(`nodes: ${roles.door_root} door roots, inventory ${inventory.closed_door_roots}`);
  if (roles.sign_face !== inventory.blank_sign_faces) errors.push(`nodes: ${roles.sign_face} sign faces, inventory ${inventory.blank_sign_faces}`);
  if (roles.scenery !== inventory.environment_cards) errors.push(`nodes: ${roles.scenery} scenery cards, inventory ${inventory.environment_cards}`);
  if (roles.viewpoint !== inventory.viewpoints.length) errors.push(`nodes: ${roles.viewpoint} viewpoints, inventory ${inventory.viewpoints.length}`);
  if (roles.unknown) errors.push(`nodes: ${roles.unknown} objects with an unknown role`);

  const b = inspectGlb(readGlb(path.join(dir, manifest.building)), 'building', mv.names, { requireBaked: true });
  const s = inspectGlb(readGlb(path.join(dir, manifest.scenery)), 'scenery', mv.names, { requireBaked: false });
  errors.push(...b.errors, ...s.errors);
  const bTris = [...b.objects.values()].reduce((a, o) => a + o.triangles, 0);
  const sTris = [...s.objects.values()].reduce((a, o) => a + o.triangles, 0);
  Object.assign(stats, { buildingMeshObjects: b.objects.size, buildingTriangles: bTris, sceneryMeshObjects: s.objects.size, sceneryTriangles: sTris, nodeIds: b.ids.size + s.ids.size });
  if (b.objects.size !== inventory.building_meshes) errors.push(`building: ${b.objects.size} mesh objects, inventory ${inventory.building_meshes}`);
  if (bTris !== inventory.building_triangles) errors.push(`building: ${bTris} triangles, inventory ${inventory.building_triangles}`);
  if (b.objects.size + s.objects.size !== inventory.total_meshes) errors.push(`total mesh objects ${b.objects.size + s.objects.size}, inventory ${inventory.total_meshes}`);
  if (bTris + sTris !== inventory.total_triangles) errors.push(`total triangles ${bTris + sTris}, inventory ${inventory.total_triangles}`);
  const nodeIds = new Set(nodes.map(n => n.assetId));
  for (const id of [...b.ids, ...s.ids]) if (!nodeIds.has(id)) errors.push(`GLB assetId ${id} missing from nodes.json`);
  if (b.ids.size + s.ids.size !== nodeIds.size) errors.push(`nodes.json lists ${nodeIds.size} objects, GLBs contain ${b.ids.size + s.ids.size}`);

  const cb = compareToExport(b.objects, report, 'building'), cs = compareToExport(s.objects, report, 'scenery');
  errors.push(...cb.errors, ...cs.errors);
  stats.worstBoundsErrorM = Math.max(cb.worstBounds, cs.worstBounds);
  stats.worstMeanPositionErrorM = Math.max(cb.worstMean, cs.worstMean);

  const vps = read(manifest.viewpoints).viewpoints;
  if (Object.keys(vps).length !== inventory.viewpoints.length) errors.push('viewpoints.json: count differs from inventory');
  for (const v of inventory.viewpoints) {
    const got = vps[v.marker];
    if (!got) { errors.push(`viewpoints.json: ${v.marker} missing`); continue; }
    if (Math.abs(got.verticalFov - v.verticalFov) > 1e-9) errors.push(`viewpoints.json: ${v.marker} FOV differs`);
  }
  return { ok: errors.length === 0, errors, warnings, stats, modelVersion: manifest.modelVersion };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = validateRelease(path.resolve(process.argv[2]));
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
