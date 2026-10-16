// Real floor plans from the loaded model release: a top-down orthographic render of one floor below a horizontal
// cut, with the architectural section (where the cut plane meets the walls) drawn on top. Seen straight from
// above, walls are edge-on and invisible in a render, so the section lines are computed from the triangles.
// Doors are left out so doorways read as openings; dynamic signs are left out.
//
// Used offline by tools/model/render-plans.mjs to write versioned plan images that the kiosk minimap, the map
// screen and the phone page share. The plan is canonical top-down: +X right, +Z (into the building) up.
import * as THREE from 'three';

const HIDE_ROLES = new Set(['door_geometry', 'door_root', 'sign_face', 'scenery']);

function ownerNode(release, o) {
  while (o && !o.userData?.assetId) o = o.parent;
  return o ? release.nodes.get(o.userData.assetId) : null;
}

/**
 * @param {import('./building-viewer.js').BuildingViewer} viewer viewer with a loaded release
 * @param {{elevation:number, cut?:number, bounds:{minX,maxX,minZ,maxZ}, pxPerM?:number, supersample?:number}} o
 * @returns {{canvas: HTMLCanvasElement, width:number, height:number, segments:number}}
 */
export function renderFloorPlan(viewer, { elevation, cut = 1.3, bounds, pxPerM = 14, supersample = 2 }) {
  const release = viewer.release, renderer = viewer.ensureRenderer();
  if (!release) throw new Error('Model is not loaded');
  const cutY = elevation + cut;
  const W = Math.ceil((bounds.maxX - bounds.minX) * pxPerM), H = Math.ceil((bounds.maxZ - bounds.minZ) * pxPerM);

  // hide doors / signs for the plan; remember visibility to restore it
  const hidden = [];
  release.root.traverse(o => {
    if (!o.isMesh || !o.visible) return;
    const n = ownerNode(release, o);
    if (n && (HIDE_ROLES.has(n.role) || (n.parent && release.nodes.get(n.parent)?.role === 'door_root'))) { o.visible = false; hidden.push(o); }
  });
  viewer.scene.updateMatrixWorld(true);

  // ---- base: top-down render below the cut
  const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;
  const cam = new THREE.OrthographicCamera(-(bounds.maxX - bounds.minX) / 2, (bounds.maxX - bounds.minX) / 2, (bounds.maxZ - bounds.minZ) / 2, -(bounds.maxZ - bounds.minZ) / 2, 0.1, 400);
  cam.position.set(cx, cutY + 100, -cz); cam.up.set(0, 0, -1); cam.lookAt(cx, cutY - 1, -cz); // canonical +Z = image up
  cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const rw = W * supersample, rh = H * supersample;
  const rt = new THREE.WebGLRenderTarget(rw, rh, { colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const prev = { clip: renderer.clippingPlanes, bg: viewer.scene.background, target: renderer.getRenderTarget() };
  renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), cutY)];
  viewer.scene.background = new THREE.Color(0xf4f1ea);
  const routeGroups = viewer.scene.children.filter(c => c.name === 'route' || c.name === 'floor-view-markers');
  routeGroups.forEach(g => { g.userData.wasVisible = g.visible; g.visible = false; });
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(viewer.scene, cam);
  const px = new Uint8Array(rw * rh * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, rw, rh, px);
  renderer.setRenderTarget(prev.target);
  renderer.clippingPlanes = prev.clip; viewer.scene.background = prev.bg;
  routeGroups.forEach(g => { g.visible = g.userData.wasVisible; });
  rt.dispose();

  const big = document.createElement('canvas'); big.width = rw; big.height = rh;
  const bctx = big.getContext('2d'), img = bctx.createImageData(rw, rh);
  for (let y = 0; y < rh; y++) img.data.set(px.subarray((rh - 1 - y) * rw * 4, (rh - y) * rw * 4), y * rw * 4); // GL rows are bottom-up
  bctx.putImageData(img, 0, 0);

  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, W, H);
  // soften the render so the section lines, route and labels carry the plan
  ctx.fillStyle = 'rgba(250,248,243,0.32)'; ctx.fillRect(0, 0, W, H);

  // ---- section: intersect every visible triangle with the plane y = cutY (render y = canonical y)
  const X = x => (x - bounds.minX) * pxPerM, Y = z => H - (z - bounds.minZ) * pxPerM;
  const walls = new Path2D(), light = new Path2D();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let segments = 0;
  release.root.traverse(o => {
    if (!o.isMesh || !o.visible) return;
    let vis = true; for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break; }
    if (!vis) return;
    const g = o.geometry, pos = g.attributes.position, index = g.index;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
    if (bb.min.y > cutY || bb.max.y < cutY) return;
    const path = o.material?.userData?.kind === 'baked' ? walls : light;
    const count = index ? index.count : pos.count;
    const v = i => index ? index.getX(i) : i;
    for (let t = 0; t < count; t += 3) {
      a.fromBufferAttribute(pos, v(t)).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, v(t + 1)).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, v(t + 2)).applyMatrix4(o.matrixWorld);
      const pts = [];
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const dp = p.y - cutY, dq = q.y - cutY;
        if ((dp < 0) === (dq < 0) || dp === dq) continue;
        const f = dp / (dp - dq);
        pts.push([p.x + (q.x - p.x) * f, -(p.z + (q.z - p.z) * f)]); // render -> canonical z
      }
      if (pts.length === 2) { path.moveTo(X(pts[0][0]), Y(pts[0][1])); path.lineTo(X(pts[1][0]), Y(pts[1][1])); segments++; }
    }
  });
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#5d6f86'; ctx.lineWidth = Math.max(1, pxPerM * 0.07); ctx.stroke(light);
  ctx.strokeStyle = '#2b3442'; ctx.lineWidth = Math.max(1.5, pxPerM * 0.16); ctx.stroke(walls);

  hidden.forEach(o => { o.visible = true; });
  viewer.invalidate();
  return { canvas, width: W, height: H, segments };
}

/** Canonical bounds of the loaded building's meshes (optionally only those whose source name matches). */
export function buildingBounds(viewer, filter = null) {
  const box = new THREE.Box3(), tmp = new THREE.Box3();
  viewer.scene.updateMatrixWorld(true);
  viewer.release.root.traverse(o => {
    if (!o.isMesh) return;
    const n = ownerNode(viewer.release, o);
    if (n && HIDE_ROLES.has(n.role)) return;
    if (filter && !filter(n?.sourceName || o.name)) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
  });
  return { minX: box.min.x, maxX: box.max.x, minZ: -box.max.z, maxZ: -box.min.z, minY: box.min.y, maxY: box.max.y };
}
