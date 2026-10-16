// Plays one planned route in the loaded building: route line, walker, destination pin, timing, floor cutaway,
// camera. Owns only per-route objects; disposing it never touches the shared building.
//
// onProgress(fraction, canonicalPosition, directionIndex) keeps the kiosk's existing contract: positions are
// canonical database coordinates, not three.js coordinates. onArrive fires once per playback.
import * as THREE from 'three';
import { toRender } from './coordinates.js';
import { CameraController } from './camera-controller.js';

const WALK = 4.5;          // preview speed (m/s) on level ground
const STAIRS = 2.2;        // slower on stairs so the landings are visible
const FLOOR_PAUSE = 0.8;   // extra seconds on a floor change
const LOOKAHEAD_S = 4;     // the camera keeps this much of the route ahead in view
// Overview cutaway: a horizontal clipping plane this far above the walker's feet removes ceilings, upper floors and
// the roof. Hiding whole floor zones instead exposed never-baked (black) ceiling tops, because the export groups
// ceilings with the floor below (guide §6). The plane follows the walker up the stairs.
const CUT_ABOVE_FEET = 2.2;
const PIN_HEIGHT = 2.0;    // below the cut, above a door head
const COLORS = { route: 0x1a63be, routeDone: 0x8fb4e3, walker: 0x12355b, pin: 0xb8432f };

export class RoutePlayer {
  constructor(viewer, route, { onProgress, onArrive, cameraMode = 'overview' } = {}) {
    this.viewer = viewer; this.route = route; this.onProgress = onProgress; this.onArrive = onArrive;
    this.group = new THREE.Group(); this.group.name = 'route';
    this.disposables = [];
    this.camera = new CameraController(viewer.camera);
    this.camera.setMode(cameraMode);
    this.elapsed = 0; this.paused = false; this.arrived = false; this.last = null; this.disposed = false;
    this.build();
    viewer.scene.add(this.group);
    viewer.animating.add(this);
    viewer.invalidate();
  }

  build() {
    const wps = this.route.waypoints;
    if (!wps || wps.length < 2) throw new Error('Route has no waypoints');
    // timing per segment, from the planner's own waypoint labels (stairs segments carry edge kind 'stairs')
    this.segs = [];
    for (let i = 1; i < wps.length; i++) {
      const a = wps[i - 1], b = wps[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const onStairs = b.label === 'stairs' || a.floor !== b.floor || Math.abs(b.y - a.y) > 0.05;
      this.segs.push({ a, b, len, dur: Math.max(0.05, len / (onStairs ? STAIRS : WALK)) + (a.floor !== b.floor ? FLOOR_PAUSE : 0) });
    }
    this.total = this.segs.reduce((s, x) => s + x.dur, 0);

    const pts = wps.map(p => toRender({ x: p.x, y: p.y + 0.08, z: p.z }));
    const path = new THREE.CurvePath();
    for (let i = 1; i < pts.length; i++) if (pts[i].distanceToSquared(pts[i - 1]) > 1e-6) path.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
    const tubeGeo = this.track(new THREE.TubeGeometry(path, Math.max(64, pts.length * 16), 0.14, 8, false));
    const tubeMat = this.track(new THREE.MeshBasicMaterial({ color: COLORS.route, toneMapped: false }));
    const tube = new THREE.Mesh(tubeGeo, tubeMat); tube.renderOrder = 2;
    this.group.add(tube);

    // walker: a disc with a direction chevron at floor level, easy to read from above and at eye level
    this.walker = new THREE.Group();
    const disc = new THREE.Mesh(this.track(new THREE.CircleGeometry(0.45, 32)), this.track(new THREE.MeshBasicMaterial({ color: COLORS.walker, toneMapped: false })));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.1;
    const chevShape = new THREE.Shape(); chevShape.moveTo(0, 0.7); chevShape.lineTo(0.35, 0.05); chevShape.lineTo(-0.35, 0.05); chevShape.closePath();
    const chev = new THREE.Mesh(this.track(new THREE.ShapeGeometry(chevShape)), this.track(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })));
    chev.rotation.x = -Math.PI / 2; chev.position.y = 0.11;
    this.walker.add(disc, chev);
    this.group.add(this.walker);

    // destination pin above the door point (or the route end)
    const end = this.route.to?.door || wps[wps.length - 1];
    this.pin = new THREE.Mesh(this.track(new THREE.ConeGeometry(0.35, 1.0, 20)), this.track(new THREE.MeshBasicMaterial({ color: COLORS.pin, toneMapped: false })));
    this.pin.rotation.x = Math.PI;
    this.pinBase = toRender({ x: end.x, y: (end.y ?? wps[wps.length - 1].y) + PIN_HEIGHT, z: end.z });
    this.clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    this.pin.position.copy(this.pinBase);
    this.group.add(this.pin);
  }
  track(x) { this.disposables.push(x); return x; }

  sample(t) {
    let acc = 0;
    for (let i = 0; i < this.segs.length; i++) {
      const s = this.segs[i];
      if (t <= acc + s.dur || i === this.segs.length - 1) {
        const f = Math.min(1, Math.max(0, (t - acc) / s.dur));
        const p = { x: s.a.x + (s.b.x - s.a.x) * f, y: s.a.y + (s.b.y - s.a.y) * f, z: s.a.z + (s.b.z - s.a.z) * f, floor: f < 0.5 ? s.a.floor : s.b.floor };
        return { p, seg: i, f, dir: { x: s.b.x - s.a.x, z: s.b.z - s.a.z } };
      }
      acc += s.dur;
    }
    return { p: { ...this.segs.at(-1).b }, seg: this.segs.length - 1, f: 1, dir: { x: 0, z: 1 } };
  }

  tick(now) {
    if (this.disposed) return;
    const dt = this.last === null ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!this.paused && !this.arrived) this.elapsed = Math.min(this.total, this.elapsed + dt);
    const { p, seg, f, dir } = this.sample(this.elapsed);
    const wp = toRender(p);
    this.walker.position.copy(wp);
    // chevron points along render -Z at rotation 0; render heading is (dx, -dz) for canonical (dx, dz)
    if (Math.hypot(dir.x, dir.z) > 1e-3) this.walker.rotation.y = Math.atan2(-dir.x, dir.z);
    this.pin.position.y = this.pinBase.y + Math.sin(now / 300) * 0.15;

    // cutaway (overview only): clip everything higher than CUT_ABOVE_FEET over the walker; eye level sees the ceiling
    const r = this.viewer.renderer;
    if (this.camera.mode === 'overview') {
      this.clip.constant = p.y + CUT_ABOVE_FEET; // keeps points with y <= constant
      if (r.clippingPlanes[0] !== this.clip) r.clippingPlanes = [this.clip];
    } else if (r.clippingPlanes.length) r.clippingPlanes = [];
    const ah = this.sample(Math.min(this.total, this.elapsed + LOOKAHEAD_S)).p;
    const ahead = ah.floor === p.floor || this.camera.mode === 'eye' ? toRender(ah) : wp.clone();
    const heading = new THREE.Vector3(dir.x, 0, -dir.z);
    if (heading.lengthSq() < 1e-6) heading.set(0, 0, -1); else heading.normalize();
    this.camera.update(wp, ahead, heading, dt || 1 / 60);

    const pointIdx = seg + (f >= 1 ? 1 : 0);
    let leg = this.route.directions.findIndex(d => d.point_index > pointIdx);
    if (leg === -1) leg = this.route.directions.length - 1;
    this.onProgress?.(this.elapsed / this.total, p, leg);
    if (!this.arrived && this.elapsed >= this.total) { this.arrived = true; this.onArrive?.(); }
  }

  pause() { this.paused = !this.paused; this.last = null; return this.paused; }
  replay() { this.elapsed = 0; this.arrived = false; this.paused = false; this.last = null; this.viewer.animating.add(this); this.viewer.invalidate(); }
  skip() { this.elapsed = this.total; this.viewer.invalidate(); }
  setCameraMode(mode) { this.camera.setMode(mode); this.viewer.invalidate(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.viewer.animating.delete(this);
    this.group.removeFromParent();
    this.disposables.forEach(d => d.dispose?.());
    if (this.viewer.renderer) this.viewer.renderer.clippingPlanes = [];
    if (this.viewer.player === this) this.viewer.player = null;
    this.viewer.invalidate();
  }
}
