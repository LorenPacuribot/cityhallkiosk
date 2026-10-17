#!/usr/bin/env node
// Builds the small, contract-complete TEST release "fx-test01" (not the City Hall): two floors, a corridor,
// stairs with a landing, a door root + leaf, two sign faces, a glass pane, a viewpoint marker, one projected
// scenery card, RGBM lightmaps, a neutral display LUT, base and scenery textures, and every sidecar file.
//
//   node tools/model/make-fixture-release.mjs [outRoot]     (default server/test/fixtures/models)
//
// Writes <outRoot>/cityhall/fx-test01/ plus fx-test01.graph.json and fx-test01.inventory.json next to it.
// Authored in Blender axes (Z up, front faces -Y) and converted with the same R as the real export.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';
import { validateRelease } from './validate-release.mjs';
import { validateGraph, polylineLength } from '../../server/public/shared/nav-graph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(HERE, '../../server/test/fixtures/models'));
const V = 'fx-test01';
const DIR = path.join(ROOT, 'cityhall', V);
const R = ([x, y, z]) => [x, z, -y];                 // blender -> glTF
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------ textures
const srgbEncode = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function lut() { // neutral "display" LUT: log-encoded input -> sRGB of the same linear value (clamped)
  const W = 4096, H = 64, px = new Uint8Array(W * H * 3);
  const dec = p => Math.min(1, Math.pow(2, (p / 63) * 18 - 12));
  for (let row = 0; row < H; row++) {
    const g = 63 - row; // bottom origin
    for (let x = 0; x < W; x++) {
      const b = Math.floor(x / 64), r = x % 64, i = (row * W + x) * 3;
      px[i] = Math.round(srgbEncode(dec(r)) * 255); px[i + 1] = Math.round(srgbEncode(dec(g)) * 255); px[i + 2] = Math.round(srgbEncode(dec(b)) * 255);
    }
  }
  return encodePng(W, H, 3, px);
}
function rgbm(range, fn) { // fn(u,v) -> linear irradiance rgb
  const S = 64, px = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const rgb = fn((x + 0.5) / S, (y + 0.5) / S), mx = Math.max(...rgb, 1e-6);
    const m = Math.max(Math.ceil(mx / range * 255), 1) / 255, i = (y * S + x) * 4;
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(Math.min(1, rgb[c] / (m * range)) * 255);
    px[i + 3] = Math.round(m * 255);
  }
  return encodePng(S, S, 4, px);
}
function solid(w, h, fn) { const px = new Uint8Array(w * h * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(fn(x / w, y / h), (y * w + x) * 3); return encodePng(w, h, 3, px); }
const textures = {
  'AgX_Afternoon_LUT.png': lut(),
  'FX_GF_RGBM.png': rgbm(4, (u, v) => [0.35 + 0.9 * u, 0.35 + 0.85 * u, 0.3 + 0.8 * u]),
  'FX_F2_RGBM.png': rgbm(8, (u, v) => [0.5 + 2.5 * v, 0.5 + 2.4 * v, 0.45 + 2.2 * v]),
  'FX_Tile.png': solid(64, 64, (x, y) => ((Math.floor(x * 8) + Math.floor(y * 8)) % 2 ? [205, 150, 70] : [235, 205, 150])),
  'FX_Sky.png': solid(96, 54, (x, y) => [Math.round(120 + 100 * y), Math.round(170 + 60 * y), 240]),
};

// ------------------------------------------------------------------ geometry (Blender axes)
const objects = []; // {name, parent, translation (blender), mesh?, material(s), props}
const ALB = [0.82, 0.8, 0.76, 1];
function box(min, max, { material, uvScale = 1, light = [0, 0, 1, 1], color = ALB }) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max, P = [], N = [], U0 = [], U1 = [], C = [], I = [];
  const faces = [ // corners counter-clockwise seen from outside, normal (blender)
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]], [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]], [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0]],
    [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0]], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]],
  ];
  for (const [a, b, c, d, n] of faces) quadInto({ P, N, U0, U1, C, I }, [a, b, c, d], n, { uvScale, light, color });
  return { P, N, U0, U1, C, I, material };
}
function quadInto(m, corners, n, { uvScale = 1, light = [0, 0, 1, 1], color = ALB, uv = null }) {
  const base = m.P.length / 3;
  const [lu0, lv0, lu1, lv1] = light;
  const quv = uv || [[0, 1], [1, 1], [1, 0], [0, 0]];
  corners.forEach((p, k) => {
    m.P.push(...R(p)); m.N.push(...R(n));
    m.U0.push(quv[k][0] * uvScale, quv[k][1] * uvScale);
    // lightmap UV: a per-object sub-rectangle of the atlas
    m.U1.push(lu0 + (lu1 - lu0) * [0, 1, 1, 0][k], lv0 + (lv1 - lv0) * [1, 1, 0, 0][k]);
    m.C.push(...color);
  });
  m.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function quad(corners, n, opts) { const m = { P: [], N: [], U0: [], U1: [], C: [], I: [], material: opts.material }; quadInto(m, corners, n, opts); return m; }
const obj = (name, mesh, extra = {}) => objects.push({ name, mesh, parent: null, translation: [0, 0, 0], props: {}, ...extra });

// ground floor slab + corridor walls (wing x in [-20, 20], entrance facade at y = -10)
obj('STATIC_Centre_GF_Floor', box([-20, -10, -0.2], [20, 10, 0], { material: 'BAKED_Centre_GF_Tile', uvScale: 8, light: [0, 0, 0.5, 0.5] }));
obj('STATIC_Centre_GF_WallNorth', box([-20, 4, 0], [20, 4.2, 3.8], { material: 'BAKED_Centre_GF_VertexColor', light: [0.5, 0, 1, 0.5] }));
obj('STATIC_Centre_GF_WallSouth', box([-20, -4.2, 0], [-2, -4, 3.8], { material: 'BAKED_Centre_GF_VertexColor', light: [0, 0.5, 0.5, 1] }));
obj('STATIC_Centre_GF_WallSouthR', box([2, -4.2, 0], [20, -4, 3.8], { material: 'BAKED_Centre_GF_VertexColor', light: [0.5, 0.5, 1, 1] }));
// stairs: two flights with a landing (z 0 -> 2 -> 4) on the right
obj('STATIC_Centre_GF_Stair1', box([10, 0, 0], [12, 3, 1.0], { material: 'BAKED_Centre_GF_VertexColor', light: [0, 0, 0.25, 0.25] }));
obj('STATIC_Centre_GF_Landing', box([10, 3, 1.9], [14, 4, 2.0], { material: 'BAKED_Centre_GF_VertexColor', light: [0.25, 0, 0.5, 0.25] }));
// second floor + roof
obj('STATIC_Centre_F2_Floor', box([-20, -10, 3.8], [20, 10, 4.0], { material: 'BAKED_Centre_F2_VertexColor', light: [0, 0, 1, 1] }));
obj('STATIC_Centre_F3Roof_Slab', box([-20, -10, 7.8], [20, 10, 8.0], { material: 'BAKED_Centre_F3Roof_VertexColor', light: [0, 0, 1, 1] }));
// glass pane in the facade
obj('STATIC_PBR_Glass', quad([[-6, -10, 0.5], [-2, -10, 0.5], [-2, -10, 3], [-6, -10, 3]], [0, -1, 0], { material: 'PBR_Clear_Glass' }));
// door: root empty at the hinge, leaf geometry as a child (local coordinates)
objects.push({ name: 'DOOR_R1-W001-D001_leaf_1', parent: null, translation: [-8.5, 4, 0], props: { openingId: 'R1-W001-D001', door_state: 'CLOSED; local Z pivot at hinge' } });
objects.push({ name: 'DOORGEO_R1-W001-D001_leaf_1', parent: 'DOOR_R1-W001-D001_leaf_1', translation: [0, 0, 0], props: {},
  mesh: box([0, -0.05, 0], [1.0, 0.05, 2.2], { material: 'BAKED_Centre_GF_VertexColor', light: [0.75, 0.75, 1, 1] }) });
// sign faces above the door, both sides (A faces the corridor = -Y side, B the room)
obj('SIGNFACE_SIGN_R1-W001-D001_Face_A', quad([[-9, 3.88, 2.4], [-7, 3.88, 2.4], [-7, 3.88, 2.9], [-9, 3.88, 2.9]], [0, -1, 0], { material: 'BAKED_Centre_GF_VertexColor', color: [1, 1, 1, 1], light: [0.6, 0.6, 0.7, 0.7] }), { props: { opening_id: 'R1-W001-D001', dynamic_face: 'Face_A', label: '' } });
obj('SIGNFACE_SIGN_R1-W001-D001_Face_B', quad([[-7, 4.32, 2.4], [-9, 4.32, 2.4], [-9, 4.32, 2.9], [-7, 4.32, 2.9]], [0, 1, 0], { material: 'BAKED_Centre_GF_VertexColor', color: [1, 1, 1, 1], light: [0.7, 0.6, 0.8, 0.7] }), { props: { opening_id: 'R1-W001-D001', dynamic_face: 'Face_B', label: '' } });
// viewpoint marker in front of the building, looking +Y
objects.push({ name: 'VIEW_FX_Front', parent: null, translation: [0, -40, 6], props: {} });
objects.push({ name: 'VIEW_FX_Front_TARGET', parent: 'VIEW_FX_Front', translation: [0, 3, -0.3], props: {} });
objects.push({ name: 'VIEW_FX_Front_UP', parent: 'VIEW_FX_Front', translation: [0, 0, 1], props: {} });
// one projected scenery card far behind the building
const env = quad([[-60, 40, -5], [60, 40, -5], [60, 40, 40], [-60, 40, 40]], [0, -1, 0], { material: 'ENVIRONMENT_Projected_Cards' });
env.proj = { x: [-60, 60, 60, -60], y: [-5, -5, 40, 40], depth: [80, 80, 80, 80] };
obj('ENV_FX_Card_0', env);

const bindings = [
  { name: 'BAKED_Centre_GF_VertexColor', kind: 'baked', lightmap: 'FX_GF_RGBM.png', lightRange: 4, baseTexture: '', baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1, emission: 0, transmission: 0 },
  { name: 'BAKED_Centre_GF_Tile', kind: 'baked', lightmap: 'FX_GF_RGBM.png', lightRange: 4, baseTexture: 'FX_Tile.png', baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1, emission: 0, transmission: 0 },
  { name: 'BAKED_Centre_F2_VertexColor', kind: 'baked', lightmap: 'FX_F2_RGBM.png', lightRange: 8, baseTexture: '', baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1, emission: 0, transmission: 0 },
  { name: 'BAKED_Centre_F3Roof_VertexColor', kind: 'baked', lightmap: 'FX_F2_RGBM.png', lightRange: 8, baseTexture: '', baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1, emission: 0, transmission: 0 },
  { name: 'PBR_Clear_Glass', kind: 'pbr', lightmap: '', lightRange: 1, baseTexture: '', baseColor: [0.96, 0.98, 1, 1], metallic: 0, roughness: 0.075, emission: 0, transmission: 1, emissionColor: [1, 1, 1, 1] },
  { name: 'ENVIRONMENT_Projected_Cards', kind: 'projected', baseTexture: 'FX_Sky.png', baseColor: [1, 1, 1, 1], projection: [0.5 / 60, 1 / 45, 0.5, 5 / 45] },
];

// ------------------------------------------------------------------ GLB writer
function glb(objs) {
  const json = { asset: { version: '2.0', generator: 'cityhallkiosk make-fixture-release' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
  const chunks = []; let byteLength = 0;
  const view = (typed, target) => {
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (byteLength % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); byteLength += pad; }
    json.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buf.length, ...(target ? { target } : {}) });
    chunks.push(buf); byteLength += buf.length;
    return json.bufferViews.length - 1;
  };
  const acc = (arr, type, size) => {
    const typed = new Float32Array(arr), count = arr.length / size;
    const a = { bufferView: view(typed, 34962), componentType: 5126, count, type };
    if (type === 'VEC3') { a.min = [0, 1, 2].map(c => Math.min(...arr.filter((_, i) => i % 3 === c))); a.max = [0, 1, 2].map(c => Math.max(...arr.filter((_, i) => i % 3 === c))); }
    json.accessors.push(a); return json.accessors.length - 1;
  };
  const matIndex = new Map();
  const material = name => {
    if (!matIndex.has(name)) { json.materials.push({ name, extras: { binding: name }, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1] } }); matIndex.set(name, json.materials.length - 1); }
    return matIndex.get(name);
  };
  const nodeIndex = new Map();
  for (const o of objs) {
    const n = { name: o.name, translation: R(o.translation), extras: { assetId: `${V}:${o.name}`, sourceName: o.name, ...o.props } };
    if (o.mesh) {
      const m = o.mesh, attributes = { POSITION: acc(m.P, 'VEC3', 3), NORMAL: acc(m.N, 'VEC3', 3), TEXCOORD_0: acc(m.U0, 'VEC2', 2), TEXCOORD_1: acc(m.U1, 'VEC2', 2) };
      if (!m.proj) attributes.COLOR_0 = acc(m.C, 'VEC4', 4);
      else { const per = k => m.proj[k]; attributes._PROJ_X = acc(per('x'), 'SCALAR', 1); attributes._PROJ_Y = acc(per('y'), 'SCALAR', 1); attributes._PROJ_DEPTH = acc(per('depth'), 'SCALAR', 1); }
      const idx = new Uint16Array(m.I);
      json.accessors.push({ bufferView: view(idx, 34963), componentType: 5123, count: idx.length, type: 'SCALAR' });
      json.meshes.push({ name: o.name, primitives: [{ attributes, indices: json.accessors.length - 1, material: material(m.material), mode: 4 }] });
      n.mesh = json.meshes.length - 1;
    }
    json.nodes.push(n); nodeIndex.set(o.name, json.nodes.length - 1);
  }
  for (const o of objs) {
    const i = nodeIndex.get(o.name);
    if (o.parent && nodeIndex.has(o.parent)) (json.nodes[nodeIndex.get(o.parent)].children ||= []).push(i);
    else json.scenes[0].nodes.push(i);
  }
  const bin = Buffer.concat(chunks); const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  json.buffers.push({ byteLength: binPad.length });
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const out = Buffer.alloc(12 + 8 + js.length + 8 + binPad.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20);
  out.writeUInt32LE(binPad.length, 20 + js.length); out.writeUInt32LE(0x004e4942, 24 + js.length); binPad.copy(out, 28 + js.length);
  return out;
}

// ------------------------------------------------------------------ sidecars and invariant sums
const worldT = o => { let t = [0, 0, 0], c = o; while (c) { t = t.map((v, i) => v + c.translation[i]); c = objects.find(x => x.name === c.parent); } return R(t); };
const report = { schemaVersion: 1, modelVersion: V, source: { file: 'fixture', sha256: '0'.repeat(64), bytes: 0, scene: 'fixture', collection: 'fixture' }, blender: 'n/a (fixture)', objects: {}, materials: [] };
const nodes = [];
const roleOf = n => n.startsWith('STATIC_') ? 'static' : n.startsWith('DOORGEO_') ? 'door_geometry' : n.startsWith('DOOR_') ? 'door_root' : n.startsWith('SIGNFACE_') ? 'sign_face'
  : n.startsWith('ENV_') ? 'scenery' : n.endsWith('_TARGET') ? 'viewpoint_target' : n.endsWith('_UP') ? 'viewpoint_up' : n.startsWith('VIEW_') ? 'viewpoint' : 'unknown';
for (const o of objects) {
  const t = worldT(o);
  const zone = ['GF', 'F2', 'F3Roof'].find(z => o.name.split('_').includes(z)) || null;
  const e = { assetId: `${V}:${o.name}`, sourceName: o.name, objectType: o.mesh ? 'MESH' : 'EMPTY', role: roleOf(o.name), parent: o.parent ? `${V}:${o.parent}` : null,
    openingId: o.props.openingId || o.props.opening_id || null, dynamicFace: o.props.dynamic_face || null, assetZone: zone, modelWing: 'Centre', floorLevel: null, cutawayGroup: zone,
    classification: 'fixture', worldGltf: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...t, 1], props: o.props };
  if (o.mesh) {
    const m = o.mesh, tris = m.I.length / 3, pos = [0, 0, 0], uv0 = [0, 0], uv1 = [0, 0], col = [0, 0, 0, 0], mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const proj = { _PROJ_X: 0, _PROJ_Y: 0, _PROJ_DEPTH: 0 };
    for (const v of m.I) {
      for (let c = 0; c < 3; c++) { const w = m.P[v * 3 + c] + t[c]; pos[c] += w; mn[c] = Math.min(mn[c], w); mx[c] = Math.max(mx[c], w); }
      uv0[0] += m.U0[v * 2]; uv0[1] += m.U0[v * 2 + 1]; uv1[0] += m.U1[v * 2]; uv1[1] += m.U1[v * 2 + 1];
      if (!m.proj) for (let c = 0; c < 4; c++) col[c] += m.C[v * 4 + c];
      else { proj._PROJ_X += m.proj.x[v]; proj._PROJ_Y += m.proj.y[v]; proj._PROJ_DEPTH += m.proj.depth[v]; }
    }
    // Float32 storage: sums from the stored values so the validator's tolerance is about export, not rounding
    report.objects[o.name] = { triangles: tris, pos, bounds: [mn, mx], tris_by_material: { [m.material]: tris }, uv0, uv1, ...(m.proj ? proj : { color: col }) };
    e.triangles = tris; e.boundsGltf = [mn, mx]; e.materials = [m.material];
    if (!report.materials.includes(m.material)) report.materials.push(m.material);
  }
  nodes.push(e);
}
const vp = { marker: 'VIEW_FX_Front', sourceCamera: 'FX_Front', verticalFov: 35, aspect: 16 / 9 };
const vpObj = objects.find(o => o.name === 'VIEW_FX_Front');
const vps = { [vp.marker]: { ...vp, assetId: `${V}:VIEW_FX_Front`, targetAssetId: `${V}:VIEW_FX_Front_TARGET`, upAssetId: `${V}:VIEW_FX_Front_UP`,
  gltf: { position: worldT(vpObj), target: worldT(objects.find(o => o.name === 'VIEW_FX_Front_TARGET')), up: worldT(objects.find(o => o.name === 'VIEW_FX_Front_UP')) } } };

// ------------------------------------------------------------------ write the release
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(DIR, 'textures'), { recursive: true });
const files = [];
const put = (rel, buf) => { fs.writeFileSync(path.join(DIR, ...rel.split('/')), buf); files.push({ path: rel, bytes: buf.length, sha256: sha(buf) }); };
put('building.glb', glb(objects.filter(o => !o.name.startsWith('ENV_'))));
put('scenery.glb', glb(objects.filter(o => o.name.startsWith('ENV_'))));
for (const [name, buf] of Object.entries(textures)) put(`textures/${name}`, buf);
const json = (rel, o) => put(rel, Buffer.from(JSON.stringify(o, null, 1) + '\n'));
json('materials.json', { schemaVersion: 1, modelVersion: V, source: 'fixture',
  lut: { path: 'textures/AgX_Afternoon_LUT.png', size: [4096, 64], slices: 64, encoding: 'neutral fixture LUT' },
  textureRules: { lightmap: { colorSpace: 'none', flipY: false, premultiplyAlpha: false, wrap: 'clamp', mipmaps: true }, lut: { colorSpace: 'none', flipY: false, filter: 'linear', mipmaps: false, wrap: 'clamp' },
    base: { colorSpace: 'srgb', flipY: false, uv: 0, wrap: 'repeat' }, projected: { colorSpace: 'srgb', flipY: false } },
  bindings: bindings.map(b => ({ ...b, lightmap: b.lightmap ? `textures/${b.lightmap}` : '', baseTexture: b.baseTexture ? `textures/${b.baseTexture}` : '', usedInExport: true })) });
json('nodes.json', { schemaVersion: 1, modelVersion: V, nodes });
json('viewpoints.json', { schemaVersion: 1, modelVersion: V, viewpoints: vps });
json('export-report.json', report);
const mesh = Object.entries(report.objects), building = mesh.filter(([k]) => !k.startsWith('ENV_'));
const manifest = { schemaVersion: 1, modelVersion: V, sourceBlendSha256: '0'.repeat(64), units: 'metres', assetCoordinates: 'gltf-y-up-right-handed', uvConvention: 'gltf-top-left',
  building: 'building.glb', scenery: 'scenery.glb', materials: 'materials.json', nodes: 'nodes.json', viewpoints: 'viewpoints.json',
  note: 'TEST FIXTURE — not the City Hall model', files: files.sort((a, b) => a.path.localeCompare(b.path)) };
fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');

const roles = {}; for (const n of nodes) roles[n.role] = (roles[n.role] || 0) + 1;
const inventory = { building_meshes: building.length, building_triangles: building.reduce((a, [, v]) => a + v.triangles, 0), total_meshes: mesh.length,
  total_triangles: mesh.reduce((a, [, v]) => a + v.triangles, 0), closed_door_roots: roles.door_root, blank_sign_faces: roles.sign_face, environment_cards: roles.scenery,
  material_kinds: bindings.reduce((a, b) => ({ ...a, [b.kind]: (a[b.kind] || 0) + 1 }), {}), viewpoints: [vp],
  source_assets: [{ path: 'fixture/09_Baked_Optimized.blend', sha256: '0'.repeat(64), bytes: 0 }] };
fs.writeFileSync(path.join(ROOT, `${V}.inventory.json`), JSON.stringify(inventory, null, 1) + '\n');

// ------------------------------------------------------------------ fixture navigation graph (canonical: x, z_blender, y_blender + 10)
const C = ([bx, by, bz]) => ({ x: bx, y: bz, z: by + 10 });
const gn = (id, floor, role, b, label = null) => ({ id, floor, role, label, ...C(b), source: 'fixture geometry' });
const gnodes = [gn('ENT', 1, 'entrance', [0, -9, 0], 'Entrance'), gn('HALL', 1, 'junction', [0, 0, 0]), gn('L-DOOR-C', 1, 'junction', [-8, 0, 0]),
  gn('L-DOOR', 1, 'door_approach', [-8, 3, 0], 'Fixture office'), gn('ST-FOOT', 1, 'stair_foot', [11, -1, 0]), gn('ST-TOP', 2, 'stair_top', [13, 0, 4]), gn('F2-HALL', 2, 'junction', [0, 0, 4])];
const ge = (id, kind, from, to, via = []) => {
  const a = gnodes.find(n => n.id === from), b = gnodes.find(n => n.id === to);
  const polyline = [a, ...via.map(C), b].map(({ x, y, z }) => ({ x, y, z }));
  return { id, kind, from, to, polyline, length_m: +polylineLength(polyline).toFixed(3), bidirectional: true, verified: false, public: true, step_free: kind === 'stairs' ? false : null, closed: false, label: kind === 'stairs' ? 'fixture stairs' : null, source: 'fixture' };
};
const graph = { schemaVersion: 1, modelVersion: V, navigationVersion: 'fx-nav-1', calibrationVersion: 'fx-cal-1', status: 'draft', floors: [{ level: 1, name: '1st floor' }, { level: 2, name: '2nd floor' }],
  nodes: gnodes,
  edges: [ge('E1', 'walk', 'ENT', 'HALL'), ge('E2', 'walk', 'HALL', 'L-DOOR-C'), ge('E3', 'door', 'L-DOOR-C', 'L-DOOR'), ge('E4', 'walk', 'HALL', 'ST-FOOT', [[11, 0, 0]]),
    ge('S1', 'stairs', 'ST-FOOT', 'ST-TOP', [[11, 3, 1.95], [13, 3.5, 1.95]]), ge('E5', 'walk', 'ST-TOP', 'F2-HALL')],
  kiosks: { 'KIOSK-LOBBY-1': 'ENT' },
  openings: [{ openingId: 'R1-W001-D001', roomId: null, status: 'unresolved', approachNodeId: 'L-DOOR', doorPoint: C([-8, 4, 0]), label: 'Fixture doorway',
    doorAssetIds: [`${V}:DOOR_R1-W001-D001_leaf_1`] }],
  signs: [{ assetId: `${V}:SIGNFACE_SIGN_R1-W001-D001_Face_A`, openingId: 'R1-W001-D001', face: 'A' }, { assetId: `${V}:SIGNFACE_SIGN_R1-W001-D001_Face_B`, openingId: 'R1-W001-D001', face: 'B' }],
  calibration: { modelVersion: V, calibrationVersion: 'fx-cal-1', status: 'draft', units: 'metres', description: 'fixture', matrixBlenderToCanonical: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 10, 1],
    anchors: [], floorElevations: { 1: 0, 2: 4 } },
};
const gp = validateGraph(graph); if (gp.length) throw new Error(gp.join('\n'));
fs.writeFileSync(path.join(ROOT, `${V}.graph.json`), JSON.stringify(graph, null, 1) + '\n');

const r = validateRelease(DIR, { inventory });
console.log(JSON.stringify({ dir: DIR, ok: r.ok, errors: r.errors, stats: r.stats }, null, 2));
process.exit(r.ok ? 0 : 1);
