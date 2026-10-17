// Browser model release contract (tools/model/validate-release.mjs): integrity, attributes, bindings, counts.
// Run: npm test. Uses the isolated fixture release; validates the real r09 release too when it has been built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease, safeRelative } from '../../tools/model/validate-release.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures/models');
const fxInventory = JSON.parse(fs.readFileSync(path.join(FX, 'fx-test01.inventory.json'), 'utf8'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function copyFixture() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'model-test-')), 'fx-test01');
  fs.cpSync(path.join(FX, 'cityhall/fx-test01'), dir, { recursive: true });
  return dir;
}
const rehash = (dir, rel) => {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, rel)), f = m.files.find(x => x.path === rel);
  f.bytes = buf.length; f.sha256 = sha(buf);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
};
function editGlbJson(file, fn) { // rewrite the JSON chunk of a GLB, keeping the binary chunk
  const buf = fs.readFileSync(file), jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jl)); fn(json);
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const rest = buf.subarray(20 + jl), out = Buffer.alloc(20 + js.length + rest.length);
  buf.copy(out, 0, 0, 12); out.writeUInt32LE(out.length, 8); out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20); rest.copy(out, 20 + js.length);
  fs.writeFileSync(file, out);
}

test('the fixture release passes: hashes, attributes, bindings, ids, counts and geometry sums', () => {
  const r = validateRelease(path.join(FX, 'cityhall/fx-test01'), { inventory: fxInventory });
  assert.deepEqual(r.errors, []);
  assert.ok(r.stats.worstBoundsErrorM <= 0.001);
});

test('integrity: a changed byte, an unsafe path and an unlisted file are rejected', () => {
  const a = copyFixture();
  const lm = path.join(a, 'textures/FX_GF_RGBM.png'), b = fs.readFileSync(lm); b[b.length - 30] ^= 1; fs.writeFileSync(lm, b);
  assert.match(validateRelease(a, { inventory: fxInventory }).errors.join('\n'), /FX_GF_RGBM\.png: SHA-256 mismatch/);

  const c = copyFixture();
  const m = JSON.parse(fs.readFileSync(path.join(c, 'manifest.json'), 'utf8'));
  m.files.push({ path: '../outside.bin', bytes: 1, sha256: '0'.repeat(64) });
  fs.writeFileSync(path.join(c, 'manifest.json'), JSON.stringify(m));
  assert.match(validateRelease(c, { inventory: fxInventory }).errors.join('\n'), /unsafe path/);

  const d = copyFixture();
  fs.writeFileSync(path.join(d, 'textures/extra.png'), 'x');
  assert.match(validateRelease(d, { inventory: fxInventory }).errors.join('\n'), /unlisted file in release: textures\/extra\.png/);

  for (const p of ['/abs', 'C:\\x', 'https://cdn/x.glb', 'a/../b', './a', 'a//b']) assert.equal(safeRelative(p), false, p);
  assert.equal(safeRelative('textures/a.png'), true);
});

test('a material without a binding, or a baked primitive without vertex colours, is rejected', () => {
  const a = copyFixture();
  const mats = JSON.parse(fs.readFileSync(path.join(a, 'materials.json'), 'utf8'));
  mats.bindings = mats.bindings.filter(x => x.name !== 'BAKED_Centre_GF_Tile');
  fs.writeFileSync(path.join(a, 'materials.json'), JSON.stringify(mats)); rehash(a, 'materials.json');
  assert.match(validateRelease(a, { inventory: fxInventory }).errors.join('\n'), /binding BAKED_Centre_GF_Tile not in materials\.json/);

  const b = copyFixture();
  editGlbJson(path.join(b, 'building.glb'), j => { delete j.meshes[0].primitives[0].attributes.COLOR_0; }); rehash(b, 'building.glb');
  assert.match(validateRelease(b, { inventory: fxInventory }).errors.join('\n'), /missing COLOR_0/);

  const c = copyFixture();
  editGlbJson(path.join(c, 'building.glb'), j => { delete j.nodes[0].extras.assetId; }); rehash(c, 'building.glb');
  assert.match(validateRelease(c, { inventory: fxInventory }).errors.join('\n'), /has no extras\.assetId/);
});

const REAL = path.join(HERE, '../public/models/cityhall/r09-web03');
test('the real r09-web03 release matches the verified source inventory', { skip: !fs.existsSync(path.join(REAL, 'manifest.json')) && 'r09-web03 has not been exported on this machine yet' }, () => {
  const r = validateRelease(REAL);
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.buildingMeshObjects, 463);
  assert.equal(r.stats.buildingTriangles, 183170);
  assert.ok(r.stats.worstBoundsErrorM <= 0.001);
});
