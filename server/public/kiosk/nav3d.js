// 3D "show me the way" preview for the web kiosk: the public navigation adapter.
//
//   const ctrl = await createNav3D(container, bundle, route, { signal, onProgress, onArrive, onLoadProgress });
//   ctrl.pause() / replay() / skip() / dispose() / setAvatar(object3D) / updateContent(bundle)
//
// Routes from the published navigation graph play inside the REAL building (three/building-viewer.js), loaded
// once per session. Prototype routes (no graph published) keep the database GREYBOX below: they come from
// placeholder coordinates and must never be drawn over the real building, where they would cross walls.
// onProgress(fraction, canonicalPosition, directionIndex) always reports canonical database coordinates.
import * as THREE from 'three';
import { CameraRig } from './three/camera-controller.js';
import { buildWalk, activeDirection } from '../shared/walk-path.js';

export class Nav3DError extends Error { constructor(message, code) { super(message); this.code = code; } }

export async function createNav3D(container, bundle, route, { signal, onProgress, onArrive, onLoadProgress, onFallback, preview } = {}) {
  const nav = bundle.navigation;
  if (route.routeSource !== 'navigation_graph' || !nav?.model) return createGreyboxNav(container, bundle, route, { onProgress, onArrive });
  if (nav.graph?.modelVersion !== nav.model.modelVersion) throw new Nav3DError('Navigation graph and model release do not match.', 'VERSION_MISMATCH');
  const { getViewer } = await import('./three/building-viewer.js');
  const viewer = getViewer();
  // a draft calibration is acceptable only for a route that is itself labelled unverified
  await viewer.ensureModel(nav, { signal, onLoadProgress, allowDraftCalibration: route.verification !== 'verified' });
  if (signal?.aborted) throw Object.assign(new Error('Navigation was cancelled.'), { name: 'AbortError', code: 'ABORTED' });
  viewer.attach(container);
  viewer.updateContent(bundle, { preview });
  const player = viewer.playRoute(route, { onProgress, onArrive });
  // WebGL context lost mid-route (driver reset, GPU memory pressure): hand the route to the 2D map
  const off = viewer.on(ev => { if (ev.type === 'contextlost') onFallback?.(Object.assign(new Error('WebGL context lost'), { code: 'CONTEXT_LOST' })); });
  return {
    kind: 'building',
    draft: route.verification !== 'verified' || viewer.calibration?.status !== 'verified',
    pause: force => player.pause(force),
    replay: () => player.replay(),
    skip: () => player.skip(),
    setAvatar: obj => player.setAvatar(obj),
    updateContent: b => viewer.updateContent(b),
    info: () => viewer.info(),
    // releases this route only: the building, textures and WebGL context stay for the next route
    dispose() { off(); player.dispose(); viewer.detach(); },
  };
}

const U = (x, y, z) => new THREE.Vector3(x, y, -z);
const COLORS = {
  floor: 0xf3efe8, floorEdge: 0xc7bfb2, office: 0xc9e0f8, target: 0xb8432f, stairs: 0xd9a520,
  restroom: 0xe6f2e7, toilet: 0xe6f2e7, hall: 0xfbf8f3, entrance: 0xe8f2fc, info_desk: 0x2e7d32, other: 0xe3ddd3, route: 0x1a63be, walker: 0x12355b, kiosk: 0x2e7d32,
};
const WALK = 4.5;        // preview speed (m/s) — faster than real walking so the preview is short
const FLOOR_PAUSE = 0.8; // seconds to linger on a stairs transition
const CAM_HEIGHT = 26;   // minimum camera height (m) above the walker
const LOOKAHEAD_M = 24;  // how far ahead on the route the camera keeps in view (m)
const CAM_MARGIN = 6;    // space kept around the walker and the look-ahead point (m)

// Prototype greybox built from the database rooms (placeholder coordinates). Used only for prototype routes.
export function createGreyboxNav(container, bundle, route, { onProgress, onArrive } = {}) {
  // ---------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  if (!renderer.getContext()) throw new Error('WebGL unavailable');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe8e4dc);
  scene.fog = new THREE.Fog(0xe8e4dc, 60, 140);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xbfb5a5, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(-30, 60, 20); sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 50, bottom: -50, far: 200 });
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);

  const disposables = [];
  const mat = (color, extra = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: .85, ...extra }); disposables.push(m); return m; };
  const geo = g => { disposables.push(g); return g; };

  // ---------- greybox from the database
  const targetId = route.to.room_id;
  const floorGroups = new Map();
  for (const fl of bundle.floors) {
    const g = new THREE.Group(); g.userData.level = fl.level; scene.add(g); floorGroups.set(fl.level, g);
    const w = fl.bounds_max_x - fl.bounds_min_x, d = fl.bounds_max_z - fl.bounds_min_z;
    const slab = new THREE.Mesh(geo(new THREE.BoxGeometry(w, 0.3, d)), mat(COLORS.floor));
    slab.position.copy(U(fl.bounds_min_x + w / 2, fl.elevation_y - 0.15, fl.bounds_min_z + d / 2));
    slab.receiveShadow = true; g.add(slab);
    const edge = new THREE.LineSegments(geo(new THREE.EdgesGeometry(slab.geometry)), new THREE.LineBasicMaterial({ color: COLORS.floorEdge }));
    edge.position.copy(slab.position); g.add(edge);

    for (const r of fl.rooms) {
      if (r.is_active === 0) continue;
      const isTarget = r.id === targetId;
      const type = r.room_type;
      const FLAT = ['hall', 'lobby', 'corridor', 'entrance', 'open_area'];
      const h = FLAT.includes(type) ? 0.06 : type === 'stairs' ? 1.2 : type === 'info_desk' ? 1.1 : 2.6;
      const color = isTarget ? COLORS.target : COLORS[type] ?? (type === 'office' ? COLORS.office : COLORS.other);
      const box = new THREE.Mesh(geo(new THREE.BoxGeometry(r.width_m || 4, h, r.depth_m || 4)),
        mat(color, isTarget ? { emissive: 0x5a1a10, emissiveIntensity: .35 } : { transparent: true, opacity: h > 2 ? .6 : .92, depthWrite: h <= 2 }));
      box.position.copy(U(r.x, fl.elevation_y + h / 2, r.z));
      box.rotation.y = -(r.facing_deg || 0) * Math.PI / 180 + Math.PI; // facing is the door direction
      box.castShadow = h > 1; box.receiveShadow = true; g.add(box);
      if (isTarget) addLabel(g, r.code, U(r.x, fl.elevation_y + h + 1.4, r.z), '#B8432F');
      else if (type === 'office' || type === 'stairs') addLabel(g, r.code, U(r.x, fl.elevation_y + h + .8, r.z), '#12355B', .55);
    }
  }
  // Kiosk "You are here"
  const k = bundle.kiosk;
  const kioskMesh = new THREE.Mesh(geo(new THREE.BoxGeometry(.6, 1.8, .4)), mat(COLORS.kiosk));
  kioskMesh.position.copy(U(k.x, k.y + .9, k.z)); scene.add(kioskMesh);
  addLabel(scene, 'YOU ARE HERE', U(k.x, k.y + 2.6, k.z), '#2E7D32', .7);

  // ---------- route line (tube along the waypoints, raised a little above the floor)
  const pts = route.waypoints.map(p => U(p.x, p.y + .12, p.z));
  const curvePath = new THREE.CurvePath();
  for (let i = 1; i < pts.length; i++) curvePath.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
  const tube = new THREE.Mesh(geo(new THREE.TubeGeometry(curvePath, Math.max(64, pts.length * 24), .18, 8, false)),
    mat(COLORS.route, { emissive: 0x0d3a73, emissiveIntensity: .5 }));
  scene.add(tube);
  // destination pin
  const pin = new THREE.Mesh(geo(new THREE.ConeGeometry(.5, 1.4, 20)), mat(COLORS.target));
  pin.rotation.x = Math.PI; const endPt = pts[pts.length - 1];
  pin.position.set(endPt.x, endPt.y + 1.6, endPt.z); scene.add(pin);

  // ---------- walker
  const walker = new THREE.Group();
  const body = new THREE.Mesh(geo(new THREE.CapsuleGeometry(.28, .9, 6, 12)), mat(COLORS.walker));
  body.position.y = .75; body.castShadow = true; walker.add(body);
  const nose = new THREE.Mesh(geo(new THREE.ConeGeometry(.16, .4, 12)), mat(0xffffff));
  nose.rotation.x = -Math.PI / 2; nose.position.set(0, 1.0, -.32); walker.add(nose);
  scene.add(walker);

  // One pose timeline drives both real-building and placeholder first-person previews.
  const walk = buildWalk(route.waypoints, route.to?.door);
  const rig = new CameraRig(camera);
  walker.visible = false;
  let elapsed = 0, paused = false, arrived = false, last = null, raf = 0, disposed = false;
  function resize() {
    const w = container.clientWidth || 1080, h = container.clientHeight || 1000;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();
  function frame(now) {
    if (disposed) return;
    const dt = last === null ? 0 : Math.min(.1, (now - last) / 1000); last = now;
    if (!paused && !arrived) elapsed = Math.min(walk.duration, elapsed + dt);
    const pose = walk.sample(elapsed);
    rig.update(pose);
    for (const [lvl, g] of floorGroups) g.visible = lvl <= pose.floor;
    renderer.render(scene, camera);
    const leg = activeDirection(route.directions, pose);
    onProgress?.(elapsed / walk.duration, pose, leg);
    if (!arrived && elapsed >= walk.duration) { arrived = true; onArrive?.(); }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  function addLabel(parent, text, pos, color = '#12355B', scale = 1) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(255,255,255,.92)'; roundRect(x, 4, 4, 504, 120, 28); x.fill();
    x.lineWidth = 6; x.strokeStyle = color; roundRect(x, 4, 4, 504, 120, 28); x.stroke();
    x.fillStyle = color; x.font = 'bold 64px "Segoe UI", system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, 256, 68);
    const tex = new THREE.CanvasTexture(c); disposables.push(tex);
    const sm = new THREE.SpriteMaterial({ map: tex, depthTest: false }); disposables.push(sm);
    const s = new THREE.Sprite(sm); s.scale.set(4 * scale, 1 * scale, 1); s.position.copy(pos); s.renderOrder = 10;
    parent.add(s);
  }
  function roundRect(x, l, t, w, h, r) { x.beginPath(); x.roundRect ? x.roundRect(l, t, w, h, r) : x.rect(l, t, w, h); }

  return {
    kind: 'greybox', draft: true,
    pause(force) { paused = force ?? !paused; return paused; },
    replay() { elapsed = 0; arrived = false; paused = false; last = null; },
    skip() { elapsed = walk.duration; },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); ro.disconnect();
      disposables.forEach(d => d.dispose?.()); renderer.dispose(); renderer.forceContextLoss?.();
      renderer.domElement.remove();
    },
  };
}
