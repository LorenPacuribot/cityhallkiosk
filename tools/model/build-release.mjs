#!/usr/bin/env node
// Assembles an immutable browser model release from the Blender staging export and the Unity sidecars.
//
//   node tools/model/build-release.mjs <stagingDir> [--sidecars <CityHallPrepared dir>] [--out <models dir>]
//
// Writes <out>/<modelVersion>/ via a temporary directory, validates it (validate-release.mjs) and only then
// renames it into place. An existing release directory is never overwritten: kiosks may be caching it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease } from './validate-release.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const INVENTORY = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/3d-integration/source-inventory.json'), 'utf8'));
const args = process.argv.slice(2);
const staging = path.resolve(args.shift() || '');
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SIDECARS = opt('--sidecars', path.join(INVENTORY.model_workspace, 'unity_baked_revision/Unity_Package/Assets/CityHallPrepared'));
const OUT = path.resolve(opt('--out', path.join(REPO, 'server/public/models/cityhall')));

const report = JSON.parse(fs.readFileSync(path.join(staging, 'export-report.json'), 'utf8'));
const version = report.modelVersion;
const dest = path.join(OUT, version);
if (fs.existsSync(dest)) { console.error(`release ${dest} already exists; releases are immutable — bump the model version`); process.exit(1); }
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const blend = INVENTORY.source_assets.find(a => a.path.endsWith('09_Unity_Baked_Optimized.blend'));
if (report.source.sha256 !== blend.sha256) { console.error('export report source hash differs from the verified inventory'); process.exit(1); }

// Every sidecar input must match the verified inventory before it is copied.
const verified = file => {
  const inv = INVENTORY.source_assets.find(a => path.resolve(a.path) === path.resolve(file));
  if (!inv) throw new Error(`${file} is not in the verified source inventory`);
  const buf = fs.readFileSync(file);
  if (buf.length !== inv.bytes || sha256(buf) !== inv.sha256) throw new Error(`${file} differs from the verified inventory`);
  return buf;
};

const tmp = path.join(OUT, `.${version}.tmp-${process.pid}`);
fs.mkdirSync(path.join(tmp, 'textures'), { recursive: true });
try {
  const files = [];
  const put = (rel, buf) => { fs.writeFileSync(path.join(tmp, ...rel.split('/')), buf); files.push({ path: rel, bytes: buf.length, sha256: sha256(buf) }); };
  const json = (rel, obj) => put(rel, Buffer.from(JSON.stringify(obj, null, 1) + '\n'));

  for (const f of ['building.glb', 'scenery.glb', 'nodes.json', 'export-report.json']) put(f, fs.readFileSync(path.join(staging, f)));

  const bindings = JSON.parse(verified(path.join(SIDECARS, 'MaterialBindings.json')).toString('utf8')).materials;
  const texRel = f => f ? `textures/${f}` : '';
  const usedTextures = new Set(['AgX_Afternoon_LUT.png']);
  for (const b of bindings) { if (b.lightmap) usedTextures.add(b.lightmap); if (b.baseTexture) usedTextures.add(b.baseTexture); }
  for (const t of [...usedTextures].sort()) put(`textures/${t}`, verified(path.join(SIDECARS, 'Textures', t)));
  const used = new Set(report.materials);
  const missing = [...used].filter(n => !bindings.some(b => b.name === n));
  if (missing.length) throw new Error(`exported materials without a binding: ${missing.join(', ')}`);
  json('materials.json', {
    schemaVersion: 1, modelVersion: version,
    source: 'Unity_Package/Assets/CityHallPrepared/MaterialBindings.json (values copied unchanged; texture paths made release-relative)',
    lut: { path: texRel('AgX_Afternoon_LUT.png'), size: [4096, 64], slices: 64, encoding: 'log2 input: p = clamp((log2(max(c,1/4096))+12)/18,0,1)*63; R within slice, G vertical (bottom origin), B selects slice; output is display-encoded (sRGB)' },
    lightmapEncoding: 'RGBM, linear: irradiance = rgb * a * lightRange',
    textureRules: {
      lightmap: { colorSpace: 'none', flipY: false, premultiplyAlpha: false, wrap: 'clamp', mipmaps: true },
      lut: { colorSpace: 'none', flipY: false, filter: 'linear', mipmaps: false, wrap: 'clamp' },
      base: { colorSpace: 'srgb', flipY: false, uv: 0 },
      projected: { colorSpace: 'srgb', flipY: false },
    },
    bindings: bindings.map(b => ({ ...b, lightmap: texRel(b.lightmap), baseTexture: texRel(b.baseTexture), usedInExport: used.has(b.name) })),
  });

  const src = JSON.parse(fs.readFileSync(path.join(staging, 'viewpoints.src.json'), 'utf8')).viewpoints;
  const vps = {};
  for (const v of INVENTORY.viewpoints) {
    const s = src[v.marker];
    if (!s) throw new Error(`viewpoint ${v.marker} was not exported`);
    vps[v.marker] = { marker: v.marker, sourceCamera: v.sourceCamera, verticalFov: v.verticalFov, aspect: v.aspect,
      assetId: s.assetId, targetAssetId: s.targetAssetId, upAssetId: s.upAssetId, gltf: s.gltf, blender: s.blender };
  }
  json('viewpoints.json', { schemaVersion: 1, modelVersion: version, coordinates: 'gltf (before calibration); blender values for reference', viewpoints: vps });

  const manifest = {
    schemaVersion: 1, modelVersion: version, sourceBlendSha256: report.source.sha256, sourceBlendBytes: report.source.bytes,
    sourceScene: report.source.scene, sourceCollection: report.source.collection, blender: report.blender,
    units: 'metres', assetCoordinates: 'gltf-y-up-right-handed', uvConvention: 'gltf-top-left',
    building: 'building.glb', scenery: 'scenery.glb', materials: 'materials.json', nodes: 'nodes.json', viewpoints: 'viewpoints.json',
    counts: { buildingMeshObjects: report.building_mesh_objects, buildingTriangles: report.building_triangles,
      meshObjects: report.mesh_objects, triangles: report.triangles, roles: report.role_counts },
    calibration: 'not included: published separately as versioned data (see model_calibrations); never assume identity',
    createdAt: new Date().toISOString(),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');

  // validate the release under its final name: the check compares the directory name with modelVersion
  const check = path.join(OUT, `.check-${process.pid}`, version);
  fs.mkdirSync(path.dirname(check), { recursive: true });
  fs.renameSync(tmp, check);
  const r = validateRelease(check, { inventory: INVENTORY });
  if (!r.ok) { fs.renameSync(check, tmp); fs.rmSync(path.dirname(check), { recursive: true, force: true }); throw new Error('validation failed:\n  ' + r.errors.slice(0, 40).join('\n  ')); }
  fs.renameSync(check, dest);
  fs.rmSync(path.dirname(check), { recursive: true, force: true });
  console.log(JSON.stringify({ status: 'released', dir: dest, stats: r.stats, files: manifest.files.length,
    bytes: manifest.files.reduce((a, f) => a + f.bytes, 0) }, null, 2));
} catch (e) {
  console.error(String(e.stack || e));
  console.error(`left the incomplete release in ${tmp} for inspection`);
  process.exit(1);
}
