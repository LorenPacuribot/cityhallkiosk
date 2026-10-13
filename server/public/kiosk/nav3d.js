// 3D "show me the way" preview for the web kiosk.
//
// This is a GREYBOX built at runtime from the database (floors + rooms with x/y/z),
// so when an admin moves a room or an office, the 3D scene follows on the next bundle sync.
// The production Unity build swaps this greybox for the real City Hall model; the
// coordinates are the same (metres, Unity convention: Y up, +X right, +Z into the building).
//
// three.js is right-handed, Unity is left-handed, so we map Unity (x, y, z) -> three (x, y, -z).
import * as THREE from '/vendor/three/build/three.module.js';

const U = (x, y, z) => new THREE.Vector3(x, y, -z);
const COLORS = {
  floor: 0xf3efe8, floorEdge: 0xc7bfb2, office: 0xc9e0f8, target: 0xb8432f, stairs: 0xd9a520,
  restroom: 0xe6f2e7, toilet: 0xe6f2e7, hall: 0xfbf8f3, entrance: 0xe8f2fc, info_desk: 0x2e7d32, other: 0xe3ddd3, route: 0x1a63be, walker: 0x12355b, kiosk: 0x2e7d32,
};
const WALK = 4.5;        // preview speed (m/s) — faster than real walking so the preview is short
const FLOOR_PAUSE = 0.8; // seconds to linger on a stairs transition

export function createNav3D(container, bundle, route, { onProgress, onArrive } = {}) {
  // ---------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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

  // ---------- path timing (segment lengths; floor changes get a fixed pause)
  const raw = route.waypoints;
  const segs = [];
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1], b = raw[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z) + Math.abs(b.y - a.y);
    const dur = a.floor !== b.floor ? Math.max(FLOOR_PAUSE, len / WALK) : len / WALK;
    segs.push({ a, b, dur });
  }
  const total = segs.reduce((s, x) => s + x.dur, 0) || 0.001;

  // ---------- state + loop
  let elapsed = 0, paused = false, arrived = false, last = performance.now(), raf = 0, disposed = false;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  let camInit = false;

  function sample(t) {
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (t <= acc + s.dur || i === segs.length - 1) {
        const f = s.dur ? Math.min(1, Math.max(0, (t - acc) / s.dur)) : 1;
        const p = { x: s.a.x + (s.b.x - s.a.x) * f, y: s.a.y + (s.b.y - s.a.y) * f, z: s.a.z + (s.b.z - s.a.z) * f, floor: f < .5 ? s.a.floor : s.b.floor };
        return { p, seg: i, f, dir: { x: s.b.x - s.a.x, z: s.b.z - s.a.z } };
      }
      acc += s.dur;
    }
    const e = raw[raw.length - 1];
    return { p: { ...e }, seg: segs.length - 1, f: 1, dir: { x: 0, z: 1 } };
  }

  function resize() {
    const w = container.clientWidth || 1080, h = container.clientHeight || 1000;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  function frame(now) {
    if (disposed) return;
    const dt = Math.min(.1, (now - last) / 1000); last = now;
    if (!paused && !arrived) elapsed = Math.min(total, elapsed + dt);
    const { p, seg, f, dir } = sample(elapsed);
    const wp = U(p.x, p.y, p.z);
    walker.position.copy(wp);
    if (Math.hypot(dir.x, dir.z) > .01) walker.rotation.y = Math.atan2(-dir.x, dir.z) + Math.PI; // face travel direction
    pin.position.y = endPt.y + 1.6 + Math.sin(now / 300) * .2;

    // upper floors fade out when the walker is below them, so you can see inside
    for (const [lvl, g] of floorGroups) {
      g.visible = lvl <= p.floor;
      if (g.userData.shownFor !== p.floor) { // labels only for the floor you are on
        g.children.forEach(c => { if (c.isSprite) c.visible = lvl === p.floor; });
        g.userData.shownFor = p.floor;
      }
    }

    // follow camera: fixed elevated offset on the entrance side (steady, no motion sickness)
    const desired = wp.clone().add(new THREE.Vector3(0, 26, 9));
    const look = wp.clone().add(new THREE.Vector3(0, .5, -1));
    if (!camInit) { camPos.copy(desired); camLook.copy(look); camInit = true; }
    camPos.lerp(desired, 1 - Math.pow(.02, dt)); camLook.lerp(look, 1 - Math.pow(.02, dt));
    camera.position.copy(camPos); camera.lookAt(camLook);
    renderer.render(scene, camera);

    const pointIdx = seg + (f >= 1 ? 1 : 0);
    let leg = route.directions.findIndex(d => d.point_index > pointIdx);
    if (leg === -1) leg = route.directions.length - 1;
    onProgress?.(elapsed / total, p, leg);
    if (!arrived && elapsed >= total) { arrived = true; onArrive?.(); }
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
    pause() { paused = !paused; return paused; },
    replay() { elapsed = 0; arrived = false; paused = false; },
    skip() { elapsed = total; },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); ro.disconnect();
      disposables.forEach(d => d.dispose?.()); renderer.dispose(); renderer.forceContextLoss?.();
      renderer.domElement.remove();
    },
  };
}
