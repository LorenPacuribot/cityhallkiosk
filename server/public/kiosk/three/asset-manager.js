// Loads an immutable model release (manifest -> JSON sidecars -> GLB -> textures -> materials) and owns the
// cached resources for the whole application lifetime. Routes borrow the loaded building; they never reload it.
//
// Integrity: the manifest is validated before use (relative paths only, required entries listed), every file's
// size is checked and, where the browser exposes crypto.subtle (secure contexts such as http://localhost),
// its SHA-256 as well. Textures are decoded with createImageBitmap({premultiplyAlpha:'none',
// colorSpaceConversion:'none'}) so RGBM alpha multipliers and the LUT reach the GPU byte-exact.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { bakedMaterial, pbrMaterial, prepareBakedGeometry } from './materials.js';

export class AssetError extends Error {
  constructor(message, code = 'ASSET_INVALID', detail = null) { super(message); this.code = code; this.detail = detail; }
}
const abortError = () => Object.assign(new Error('Loading was cancelled.'), { name: 'AbortError', code: 'ABORTED' });
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };

const REQUIRED = ['schemaVersion', 'modelVersion', 'units', 'assetCoordinates', 'building', 'scenery', 'materials', 'nodes', 'viewpoints', 'files'];
export const isSafeRelative = p => typeof p === 'string' && p.length > 0 && !p.includes('\\') && !p.startsWith('/')
  && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.split('/').some(s => s === '..' || s === '.' || s === '');

export function validateManifest(m, expectedVersion) {
  if (!m || typeof m !== 'object') throw new AssetError('Model manifest is not an object.', 'MANIFEST_INVALID');
  for (const k of REQUIRED) if (m[k] === undefined) throw new AssetError(`Model manifest is missing "${k}".`, 'MANIFEST_INVALID');
  if (m.schemaVersion !== 1) throw new AssetError(`Unsupported manifest schema ${m.schemaVersion}.`, 'MANIFEST_INVALID');
  if (expectedVersion && m.modelVersion !== expectedVersion) throw new AssetError(`Release is ${m.modelVersion}, expected ${expectedVersion}.`, 'VERSION_MISMATCH');
  if (m.units !== 'metres' || m.assetCoordinates !== 'gltf-y-up-right-handed') throw new AssetError('Model manifest uses unexpected units or axes.', 'MANIFEST_INVALID');
  if (!Array.isArray(m.files) || !m.files.length) throw new AssetError('Model manifest lists no files.', 'MANIFEST_INVALID');
  const files = new Map();
  for (const f of m.files) {
    if (!isSafeRelative(f.path)) throw new AssetError(`Unsafe path in model manifest: ${JSON.stringify(f.path)}`, 'MANIFEST_INVALID');
    if (!Number.isInteger(f.bytes) || f.bytes <= 0 || !/^[0-9a-f]{64}$/.test(f.sha256 || '')) throw new AssetError(`Bad size or hash for ${f.path}.`, 'MANIFEST_INVALID');
    files.set(f.path, f);
  }
  for (const k of ['building', 'scenery', 'materials', 'nodes', 'viewpoints']) if (!files.has(m[k])) throw new AssetError(`Manifest ${k} file ${m[k]} is not listed.`, 'MANIFEST_INVALID');
  return files;
}

async function sha256Hex(buf) {
  if (!globalThis.crypto?.subtle) return null; // not a secure context: size check only
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export class AssetManager {
  constructor({ fetchImpl = (...a) => fetch(...a) } = {}) {
    this.fetch = fetchImpl;
    this.cache = new Map();      // url -> { promise, value, refs, dispose }
    this.integrity = 'unchecked';
  }

  async bytes(url, entry, { signal, onBytes } = {}) {
    const res = await this.fetch(url, { signal, cache: 'force-cache' });
    if (!res.ok) throw new AssetError(`Could not load ${entry.path} (HTTP ${res.status}).`, 'ASSET_MISSING', { url, status: res.status });
    let buf;
    if (res.body && onBytes) {
      const reader = res.body.getReader(), chunks = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onBytes(got); checkAbort(signal); }
      buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
      buf = buf.buffer;
    } else buf = await res.arrayBuffer();
    checkAbort(signal);
    if (buf.byteLength !== entry.bytes) throw new AssetError(`${entry.path} is ${buf.byteLength} bytes, manifest says ${entry.bytes}.`, 'ASSET_CORRUPT');
    const h = await sha256Hex(buf);
    if (h === null) this.integrity = 'size-only';
    else if (h !== entry.sha256) throw new AssetError(`${entry.path} failed its integrity check.`, 'ASSET_CORRUPT');
    else if (this.integrity !== 'size-only') this.integrity = 'sha256';
    return buf;
  }

  /** Cached, reference-counted resource keyed by immutable URL. */
  acquire(url, make) {
    let c = this.cache.get(url);
    if (!c) {
      c = { refs: 0, value: null, promise: null, dispose: null };
      c.promise = make().then(v => { c.value = v.value; c.dispose = v.dispose; return v.value; }, e => { this.cache.delete(url); throw e; });
      this.cache.set(url, c);
    }
    c.refs++;
    return c.promise;
  }
  release(url) {
    const c = this.cache.get(url); if (!c) return;
    if (--c.refs <= 0) { c.dispose?.(); this.cache.delete(url); }
  }

  async texture(base, entry, rule, opts) {
    const url = new URL(entry.path, base).href;
    return this.acquire(url, async () => {
      const buf = await this.bytes(url, entry, opts);
      const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
      const t = new THREE.Texture(bitmap);
      t.name = entry.path;
      t.flipY = false;                       // ImageBitmaps ignore flipY; glTF UVs are top-origin
      t.premultiplyAlpha = false;
      t.colorSpace = rule.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      // glTF default is repeat (tiled floor textures rely on it); lightmaps and the LUT say 'clamp' explicitly
      t.wrapS = t.wrapT = rule.wrap === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      t.generateMipmaps = rule.mipmaps !== false;
      t.minFilter = rule.mipmaps === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return { value: t, dispose: () => { t.dispose(); bitmap.close?.(); } };
    });
  }

  /**
   * Loads the release's building. The exterior scenery cards in the release are not used by the kiosk (the welcome photo shows the outside). Resolves with a Release; rejects with AssetError / AbortError.
   * @param {string} baseUrl e.g. '/models/cityhall/r09-web01/'
   */
  async loadRelease(baseUrl, { expectedVersion, signal, onProgress, renderer } = {}) {
    const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/', location.href);
    const progress = (phase, f) => onProgress?.({ phase, fraction: Math.max(0, Math.min(1, f)) });
    progress('manifest', 0);
    const res = await this.fetch(new URL('manifest.json', base), { signal, cache: 'no-cache' });
    if (!res.ok) throw new AssetError(`Model manifest not found (HTTP ${res.status}).`, 'ASSET_MISSING');
    let manifest;
    try { manifest = await res.json(); } catch { throw new AssetError('Model manifest is not valid JSON.', 'MANIFEST_INVALID'); }
    checkAbort(signal);
    const files = validateManifest(manifest, expectedVersion);
    const json = async k => JSON.parse(new TextDecoder().decode(await this.bytes(new URL(manifest[k], base), files.get(manifest[k]), { signal })));
    const [materials, nodes, viewpoints] = [await json('materials'), await json('nodes'), await json('viewpoints')];
    for (const [k, v] of Object.entries({ materials, nodes, viewpoints })) if (v.modelVersion !== manifest.modelVersion) throw new AssetError(`${k}.json is for ${v.modelVersion}.`, 'VERSION_MISMATCH');

    const bindings = new Map(materials.bindings.map(b => [b.name, b]));
    const texRule = materials.textureRules;
    // textures needed by the building: every baked binding's lightmap + base texture, and the LUT
    const texPaths = new Map([[materials.lut.path, texRule.lut]]);
    for (const b of materials.bindings) if (b.kind === 'baked') { texPaths.set(b.lightmap, texRule.lightmap); if (b.baseTexture) texPaths.set(b.baseTexture, texRule.base); }
    const glbEntry = files.get(manifest.building);
    const total = glbEntry.bytes + [...texPaths.keys()].reduce((a, p) => a + (files.get(p)?.bytes || 0), 0);
    let done = 0;
    const owned = [];
    try {
      const glbBuf = await this.bytes(new URL(manifest.building, base), glbEntry, { signal, onBytes: n => progress('building', (done + n) / total) });
      done += glbEntry.bytes;
      const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(glbBuf, base.href, resolve, e => reject(new AssetError(`Building GLB could not be parsed: ${e.message || e}`, 'ASSET_CORRUPT'))));
      checkAbort(signal);

      const textures = new Map();
      for (const [p, rule] of texPaths) {
        const entry = files.get(p);
        if (!entry) throw new AssetError(`Texture ${p} is not in the manifest.`, 'MANIFEST_INVALID');
        const url = new URL(p, base).href; owned.push(url);
        textures.set(p, await this.texture(base, entry, rule, { signal }));
        done += entry.bytes; progress('textures', done / total);
      }

      let envMap = null;
      if (renderer) {
        const pm = new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment();
        envMap = pm.fromScene(room, 0.04).texture;
        room.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
        pm.dispose();
      }

      const made = new Map(), missing = new Set(), problems = [];
      const materialFor = name => {
        if (made.has(name)) return made.get(name);
        const b = bindings.get(name);
        if (!b) { missing.add(name); return null; }
        let m;
        if (b.kind === 'baked') m = bakedMaterial(b, { lightMap: textures.get(b.lightmap), baseMap: b.baseTexture ? textures.get(b.baseTexture) : null, lut: textures.get(materials.lut.path) });
        else if (b.kind === 'pbr') m = pbrMaterial(b, { envMap });
        else throw new AssetError(`Binding ${name} (${b.kind}) is not allowed in the building.`, 'MATERIAL_INVALID');
        made.set(name, m);
        return m;
      };
      const index = new Map(), meshes = [];
      gltf.scene.traverse(o => {
        if (o.userData?.assetId) index.set(o.userData.assetId, o);
        if (!o.isMesh) return;
        const placeholder = o.material;
        const name = placeholder?.userData?.binding || placeholder?.name;
        const m = materialFor(name);
        placeholder?.dispose?.();
        if (!m) return;
        const owner = assetOwner(o);
        try { if (m.userData.kind === 'baked') prepareBakedGeometry(o.geometry, owner?.userData?.sourceName || o.name); }
        catch (e) { problems.push(e.message); return; }
        o.material = m;
        o.matrixAutoUpdate = false; o.updateMatrix();
        meshes.push(o);
      });
      if (missing.size) throw new AssetError(`Building uses materials with no binding: ${[...missing].join(', ')}`, 'MATERIAL_MISSING', { missing: [...missing] });
      if (problems.length) throw new AssetError(`Building geometry is incomplete: ${problems.slice(0, 3).join('; ')}`, 'ATTRIBUTE_MISSING', { problems });

      const nodeIndex = new Map(nodes.nodes.map(n => [n.assetId, n]));
      for (const id of nodeIndex.keys()) if (!index.has(id) && !id.includes(':ENV_')) throw new AssetError(`Object ${id} from nodes.json is missing from the GLB.`, 'ASSET_INCONSISTENT');
      progress('ready', 1);
      return new Release({ manager: this, base, manifest, files, materials, nodes: nodeIndex, viewpoints: viewpoints.viewpoints, root: gltf.scene,
        index, meshes, ownedTextures: owned, ownedMaterials: [...made.values()], envMap });
    } catch (e) {
      owned.forEach(u => this.release(u));
      throw e;
    }
  }
}

function assetOwner(o) { while (o && !o.userData?.assetId) o = o.parent; return o; }

export class Release {
  constructor(p) { Object.assign(this, p); this.disposed = false; }
  get modelVersion() { return this.manifest.modelVersion; }


  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const geos = new Set();
    for (const r of [this.root]) r?.traverse(o => { if (o.geometry) geos.add(o.geometry); });
    geos.forEach(g => g.dispose());
    this.ownedMaterials.forEach(m => m.dispose());
    this.envMap?.dispose();
    this.ownedTextures.forEach(u => this.manager.release(u));
  }
}
