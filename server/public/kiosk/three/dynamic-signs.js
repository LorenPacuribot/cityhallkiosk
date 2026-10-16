// Office labels on the model's blank sign faces, from published data (docs/3D_MODEL_INTEGRATION_GUIDE.md §11).
// Only VERIFIED opening->room mappings get a label; an unverified sign stays blank exactly as modelled.
// The label is a canvas texture on the face's UV0 in its own material instance; UV1 and the shared lightmap
// are untouched, so the baked lighting still applies.
import * as THREE from 'three';
import { bakedMaterial } from './materials.js';

const W = 1024, H = 256;

/**
 * Text for one doorway: the room's CURRENT occupant office(s), primary first, then the room code.
 * A room with no current office shows only its code: a room's stored name is often its former occupant.
 */
export function signText(bundle, roomId) {
  const room = bundle.floors?.flatMap(f => f.rooms).find(r => r.id === roomId);
  const offices = (bundle.offices || []).filter(o => o.location?.room_id === roomId).map(o => o.name);
  if (!offices.length) return { title: room?.code || '', code: '' };
  return { title: offices.slice(0, 2).join(' / ') + (offices.length > 2 ? ` +${offices.length - 2}` : ''), code: room?.code || '' };
}

function drawLabel(canvas, { title, code }) {
  const x = canvas.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#12355B'; x.textAlign = 'center'; x.textBaseline = 'middle';
  let size = 84;
  x.font = `700 ${size}px "Plus Jakarta Sans", "Segoe UI", sans-serif`;
  while (x.measureText(title).width > W - 80 && size > 34) { size -= 4; x.font = `700 ${size}px "Plus Jakarta Sans", "Segoe UI", sans-serif`; }
  x.fillText(title, W / 2, code ? H * 0.40 : H / 2, W - 60);
  if (code) { x.font = '600 52px "Plus Jakarta Sans", "Segoe UI", sans-serif'; x.fillStyle = '#4A5260'; x.fillText(code, W / 2, H * 0.76); }
}

export class DynamicSigns {
  constructor(release) {
    this.release = release;
    this.applied = new Map(); // assetId -> { mesh, original, material, texture, text }
  }

  /**
   * @param {object} bundle current published content (offices + floors) with bundle.navigation.graph signs/openings
   */
  update(bundle) {
    const g = bundle?.navigation?.graph;
    const wanted = new Map();
    if (g && g.modelVersion === this.release.modelVersion) {
      const openings = new Map(g.openings.map(o => [o.openingId, o]));
      for (const s of g.signs || []) {
        const o = openings.get(s.openingId);
        if (!o || o.status !== 'verified' || !o.roomId || s.status !== 'verified') continue;
        const t = signText(bundle, o.roomId);
        if (t.title) wanted.set(s.assetId, t);
      }
    }
    for (const [id, a] of this.applied) if (!wanted.has(id)) this.clear(id);
    for (const [id, text] of wanted) this.apply(id, text);
    return { labelled: this.applied.size };
  }

  meshesOf(assetId) {
    const obj = this.release.index.get(assetId);
    const out = [];
    obj?.traverse(o => { if (o.isMesh) out.push(o); });
    return out;
  }

  apply(assetId, text) {
    const prev = this.applied.get(assetId);
    if (prev && prev.text.title === text.title && prev.text.code === text.code) return;
    const meshes = this.meshesOf(assetId);
    const mesh = meshes.find(m => m.material?.userData?.kind === 'baked');
    if (!mesh) return;
    const original = prev?.original || mesh.material;
    const canvas = prev?.texture.image || Object.assign(document.createElement('canvas'), { width: W, height: H });
    drawLabel(canvas, text);
    let texture = prev?.texture;
    if (!texture) {
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false; // glTF UV0 is top-origin; checked on both faces (Face_A / Face_B)
      texture.anisotropy = 4;
    }
    texture.needsUpdate = true;
    let material = prev?.material;
    if (!material) {
      const u = original.uniforms;
      material = bakedMaterial({ name: `${original.name}#label`, lightRange: u.lightRange.value },
        { lightMap: u.lightMap.value, baseMap: texture, lut: u.lut.value });
      mesh.material = material;
    }
    this.applied.set(assetId, { mesh, original, material, texture, text });
  }

  clear(assetId) {
    const a = this.applied.get(assetId);
    if (!a) return;
    a.mesh.material = a.original;
    a.material.dispose(); a.texture.dispose();
    this.applied.delete(assetId);
  }

  dispose() { for (const id of [...this.applied.keys()]) this.clear(id); }
}
