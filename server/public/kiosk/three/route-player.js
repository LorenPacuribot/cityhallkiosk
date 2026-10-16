// Plays one planned route in the loaded building as a first-person walk: the eye starts at the route's start (the
// entrance), walks the route polyline (shared/walk-path.js) and ends facing the destination door. A flat ribbon with
// moving arrows lies on the floor along the whole route; the door gets a floor ring, a pin and a name label.
// Owns only per-route objects; disposing it never touches the shared building.
//
// onProgress(fraction, canonicalPose, directionIndex) keeps the kiosk's contract: positions are canonical database
// coordinates (plus yaw, for the minimap arrow). onArrive fires once per playback.
//
// A future on-screen character: setAvatar(object3D) places it at the pose every frame (the camera rig would then
// follow it; see camera-controller.js).
import * as THREE from 'three';
import { toRender } from './coordinates.js';
import { CameraRig } from './camera-controller.js';
import { buildWalk } from '../../shared/walk-path.js';

const RIBBON_WIDTH = 0.6;    // m
const LIFT_FLOOR = 0.025;    // ribbon height above level floors (m)
const LIFT_STAIRS = 0.16;    // above the stair pitch line, so the ribbon rides over the nosings instead of into the treads
const LABEL_RANGE = 16;      // m of route left when the destination label appears (it is drawn over walls)
const COLORS = { route: new THREE.Color(0x1a63be), routeDone: new THREE.Color(0x9fb9d9), pin: 0xb8432f, ring: 0xb8432f };

export class RoutePlayer {
  constructor(viewer, route, { onProgress, onArrive } = {}) {
    this.viewer = viewer; this.route = route; this.onProgress = onProgress; this.onArrive = onArrive;
    this.group = new THREE.Group(); this.group.name = 'route';
    this.disposables = [];
    this.rig = new CameraRig(viewer.camera);
    this.elapsed = 0; this.paused = false; this.arrived = false; this.last = null; this.disposed = false; this.avatar = null;
    this.walk = buildWalk(route.waypoints, route.to?.door || null);
    this.build();
    viewer.scene.add(this.group);
    if (viewer.renderer) viewer.renderer.clippingPlanes = []; // first person sees the whole building
    viewer.animating.add(this);
    viewer.invalidate();
  }
  get total() { return this.walk.duration; }

  build() {
    const wps = this.route.waypoints;
    // ---- ribbon on the floor (u = metres along the route, v = across)
    const pts = [], lifts = [];
    for (let i = 0; i < wps.length; i++) {
      const p = wps[i], prev = wps[i - 1], next = wps[i + 1];
      if (prev && Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z) < 1e-3) continue;
      const sloped = q => q && Math.abs(q.y - p.y) > 0.05;
      pts.push(p); lifts.push(sloped(prev) || sloped(next) ? LIFT_STAIRS : LIFT_FLOOR);
    }
    this.ribbonMat = this.track(new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uDone: { value: -1 }, uColor: { value: COLORS.route }, uDoneColor: { value: COLORS.routeDone } },
      vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uDone; uniform vec3 uColor, uDoneColor; varying vec2 vUv;
        void main() {
          float u = vUv.x, v = vUv.y;
          float edge = smoothstep(0.0, 0.1, v) * smoothstep(1.0, 0.9, v);
          float x = fract((u - uTime * 0.9) / 1.6);              // chevrons every 1.6 m, moving forward
          float c = x + abs(v - 0.5) * 0.55;                      // arms trail behind the tip: points the way
          float chev = smoothstep(0.50, 0.53, c) - smoothstep(0.70, 0.73, c);
          vec3 col = mix(uColor, vec3(1.0), chev * 0.9);
          float a = 0.9 * edge;
          if (u < uDone) { col = mix(col, uDoneColor, 0.7); a *= 0.4; }
          gl_FragColor = vec4(col, a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    const ribbon = new THREE.Mesh(this.track(ribbonGeometry(pts, lifts, RIBBON_WIDTH)), this.ribbonMat);
    ribbon.renderOrder = 2; ribbon.frustumCulled = false;
    this.group.add(ribbon);

    // ---- destination: floor ring in front of the door, a pin above it, and the door's name
    const end = wps[wps.length - 1], door = this.route.to?.door;
    const toDoor = door ? new THREE.Vector2(door.x - end.x, door.z - end.z) : new THREE.Vector2();
    const doorDist = toDoor.length();
    // the marker stands just in front of the door (on the corridor side), or at the route end when no door point
    const mk = doorDist > 0.2 ? { x: door.x - toDoor.x / doorDist * 0.7, z: door.z - toDoor.y / doorDist * 0.7 } : { x: end.x, z: end.z };
    const floorY = end.y;
    this.ring = new THREE.Mesh(this.track(new THREE.RingGeometry(0.42, 0.6, 48)),
      this.track(new THREE.MeshBasicMaterial({ color: COLORS.ring, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })));
    this.ring.rotation.x = -Math.PI / 2; this.ring.renderOrder = 3;
    this.ring.position.copy(toRender({ x: mk.x, y: floorY + LIFT_FLOOR + 0.005, z: mk.z }));
    this.pin = new THREE.Mesh(this.track(new THREE.ConeGeometry(0.2, 0.5, 24)), this.track(new THREE.MeshBasicMaterial({ color: COLORS.pin, toneMapped: false })));
    this.pin.rotation.x = Math.PI;
    this.pinBase = toRender({ x: mk.x, y: floorY + 2.3, z: mk.z });
    this.pin.position.copy(this.pinBase);
    this.label = makeLabel(this.route.to?.room_code || '', this.route.to?.name || this.route.to?.room_name || '', this);
    this.label.position.copy(toRender({ x: mk.x, y: floorY + 2.95, z: mk.z }));
    this.label.visible = false;
    this.endFloor = end.floor;
    this.group.add(this.ring, this.pin, this.label);
  }
  track(x) { this.disposables.push(x); return x; }

  /** A future character model; placed at the walker's pose every frame. */
  setAvatar(obj) { if (this.avatar) this.group.remove(this.avatar); this.avatar = obj || null; if (obj) this.group.add(obj); this.viewer.invalidate(); }

  tick(now) {
    if (this.disposed) return;
    const dt = this.last === null ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!this.paused && !this.arrived) this.elapsed = Math.min(this.total, this.elapsed + dt);
    const pose = this.walk.sample(this.elapsed);
    this.rig.update(pose);
    if (this.avatar) { this.avatar.position.copy(toRender(pose)); this.avatar.rotation.y = Math.PI - pose.yaw; }

    this.ribbonMat.uniforms.uTime.value = now / 1000;
    this.ribbonMat.uniforms.uDone.value = pose.s - 1.0; // the part already walked fades (kept a metre behind the eye)
    const pulse = 1 + 0.08 * Math.sin(now / 260);
    this.ring.scale.set(pulse, pulse, 1);
    this.pin.position.y = this.pinBase.y + Math.sin(now / 320) * 0.07;
    this.label.visible = pose.floor === this.endFloor && this.walk.length - pose.s < LABEL_RANGE;

    const pointIdx = pose.seg + (pose.f >= 1 ? 1 : 0);
    let leg = this.route.directions.findIndex(d => d.point_index > pointIdx);
    if (leg === -1) leg = this.route.directions.length - 1;
    this.onProgress?.(this.elapsed / this.total, { x: pose.x, y: pose.y, z: pose.z, floor: pose.floor, yaw: pose.yaw }, leg);
    if (!this.arrived && this.elapsed >= this.total) { this.arrived = true; this.onArrive?.(); }
  }

  pause() { this.paused = !this.paused; this.last = null; return this.paused; }
  replay() { this.elapsed = 0; this.arrived = false; this.paused = false; this.last = null; this.viewer.animating.add(this); this.viewer.invalidate(); }
  skip() { this.elapsed = this.total; this.viewer.invalidate(); }
  /** Jump to a fraction of the walk (tests, staff review). */
  seek(fraction) { this.elapsed = Math.max(0, Math.min(1, fraction)) * this.total; this.arrived = false; this.last = null; this.viewer.invalidate(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.viewer.animating.delete(this);
    this.group.removeFromParent();
    this.disposables.forEach(d => d.dispose?.());
    if (this.viewer.player === this) this.viewer.player = null;
    this.viewer.invalidate();
  }
}

/** Flat strip along a canonical polyline with mitred corners; uv.x = metres along, uv.y = 0..1 across. */
function ribbonGeometry(pts, lifts, width) {
  const n = pts.length, pos = new Float32Array(n * 6), uv = new Float32Array(n * 4), idx = [];
  let u = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[i - 1] || p, b = pts[i + 1] || p;
    if (i > 0) u += Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z);
    // horizontal tangent: average of the incoming and outgoing directions
    const d1 = norm2(p.x - a.x, p.z - a.z), d2 = norm2(b.x - p.x, b.z - p.z);
    let tx = d1.x + d2.x, tz = d1.z + d2.z;
    let tl = Math.hypot(tx, tz);
    if (tl < 1e-6) { tx = d1.x || d2.x; tz = d1.z || d2.z; tl = Math.hypot(tx, tz) || 1; }
    tx /= tl; tz /= tl;
    // miter: scale the half-width by 1/cos(half the turn), capped for sharp turns
    const ref = (d1.x || d1.z) ? d1 : d2;
    const cosHalf = Math.max(0.5, tx * ref.x + tz * ref.z);
    const half = width / 2 / cosHalf;
    const nx = -tz * half, nz = tx * half; // left of travel (canonical)
    const y = p.y + lifts[i];
    const L = toRender({ x: p.x + nx, y, z: p.z + nz }), R = toRender({ x: p.x - nx, y, z: p.z - nz });
    pos.set([L.x, L.y, L.z, R.x, R.y, R.z], i * 6);
    uv.set([u, 0, u, 1], i * 4);
    if (i > 0) { const k = (i - 1) * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
function norm2(x, z) { const l = Math.hypot(x, z); return l > 1e-9 ? { x: x / l, z: z / l } : { x: 0, z: 0 }; }

/** Camera-facing label: room code (large) over the destination name. Drawn over walls so it reads around corners. */
function makeLabel(code, name, owner) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 288;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(255,255,255,0.96)'; x.strokeStyle = '#B8432F'; x.lineWidth = 10;
  x.beginPath(); x.roundRect ? x.roundRect(8, 8, 1008, 272, 40) : x.rect(8, 8, 1008, 272); x.fill(); x.stroke();
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = '#B8432F'; x.font = 'bold 96px "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif';
  x.fillText(code, 512, name ? 104 : 144, 960);
  if (name) { x.fillStyle = '#12355B'; x.font = '600 60px "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif'; x.fillText(name.length > 34 ? name.slice(0, 33) + '…' : name, 512, 206, 960); }
  const tex = owner.track(new THREE.CanvasTexture(c)); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const s = new THREE.Sprite(owner.track(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, toneMapped: false })));
  s.scale.set(1.9, 1.9 * 288 / 1024, 1); s.renderOrder = 10;
  return s;
}
