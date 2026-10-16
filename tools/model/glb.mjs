// Minimal binary glTF (GLB 2.0) reader for validation: no dependencies, reads accessors into typed arrays.
import fs from 'node:fs';

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const TYPES = {
  5120: [Int8Array, 127], 5121: [Uint8Array, 255], 5122: [Int16Array, 32767],
  5123: [Uint16Array, 65535], 5125: [Uint32Array, 0], 5126: [Float32Array, 0],
};

export function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB (bad magic)`);
  if (buf.readUInt32LE(4) !== 2) throw new Error(`${file}: GLB version ${buf.readUInt32LE(4)}, expected 2`);
  if (buf.readUInt32LE(8) !== buf.length) throw new Error(`${file}: header length ${buf.readUInt32LE(8)} != file size ${buf.length}`);
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error(`${file}: no JSON chunk`);
  return { json, bin, bytes: buf.length };
}

/** Returns { array: Float64Array (normalized to floats), count, size } for an accessor. */
export function readAccessor(gltf, index) {
  const { json, bin } = gltf;
  const acc = json.accessors[index];
  if (!acc) throw new Error(`accessor ${index} missing`);
  const size = COMPONENTS[acc.type];
  const [Ctor, max] = TYPES[acc.componentType] || [];
  if (!Ctor) throw new Error(`accessor ${index}: unsupported componentType ${acc.componentType}`);
  const out = new Float64Array(acc.count * size);
  if (acc.bufferView === undefined) return { array: out, count: acc.count, size, accessor: acc }; // all zeros (sparse unsupported)
  if (acc.sparse) throw new Error(`accessor ${index}: sparse accessors not supported by the validator`);
  const bv = json.bufferViews[acc.bufferView];
  if (bv.buffer !== 0) throw new Error(`accessor ${index}: external buffer`);
  const el = Ctor.BYTES_PER_ELEMENT;
  const stride = bv.byteStride || size * el;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  if (base + stride * (acc.count - 1) + size * el > (bv.byteOffset || 0) + bv.byteLength) throw new Error(`accessor ${index}: out of bufferView bounds`);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const getter = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[acc.componentType];
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < size; c++) {
      let v = dv[getter](base + i * stride + c * el, true);
      if (acc.normalized && max) v = Math.max(v / max, -1);
      out[i * size + c] = v;
    }
  }
  return { array: out, count: acc.count, size, accessor: acc };
}

// 4x4 column-major helpers
const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function trs(n) {
  if (n.matrix) return n.matrix.slice();
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
export function transformPoint(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/** World matrix (glTF space) for every node index, walking from the default scene roots. */
export function worldMatrices(json) {
  const world = new Array(json.nodes?.length || 0).fill(null), parent = new Array(world.length).fill(null);
  const scene = json.scenes?.[json.scene ?? 0];
  const visit = (i, pm) => {
    if (world[i]) throw new Error(`node ${i} reached twice (not a tree)`);
    world[i] = mul(pm, trs(json.nodes[i]));
    for (const c of json.nodes[i].children || []) { parent[c] = i; visit(c, world[i]); }
  };
  for (const r of scene?.nodes || []) visit(r, ident());
  return { world, parent };
}
