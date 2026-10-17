// 3D floor map for the kiosk's map screen: one floor of the real building seen from above at an angle, with
// everything higher than CUT_ABOVE_FLOOR cut away (ceilings, upper floors, roof). The default camera looks from the
// entrance side, so the entrance is at the bottom of the screen like on the 2D plans.
//   one finger drag  pan          two fingers  pinch zoom + twist rotate          wheel  zoom
//   zoom(f) / rotate(rad) / reset() for on-screen buttons
import * as THREE from 'three';
import { toRender } from './coordinates.js';

const CUT_ABOVE_FLOOR = 2.4;   // m: below the ceilings, above door heads
const FOV = 38;
const PITCH = THREE.MathUtils.degToRad(62);
const ZOOM_RANGE = [0.22, 1.15]; // x the distance that fits the whole floor
const EASE = 0.45;             // s for preset changes

export class FloorView {
  /**
   * @param {import('./building-viewer.js').BuildingViewer} viewer
   * @param {{level:number, elevation:number, bounds:{minX,maxX,minZ,maxZ}, you?:{x,y,z}|null, youLabel?:string}} o
   */
  constructor(viewer, o) {
    this.viewer = viewer; this.o = o; this.disposed = false;
    this.group = new THREE.Group(); this.group.name = 'floor-view-markers';
    this.disposables = [];
    this.clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), o.elevation + CUT_ABOVE_FLOOR);
    viewer.renderer.clippingPlanes = [this.clip];
    // labels are HTML over the canvas: never cut by the clipping plane and sharp at any zoom. Office names are real
    // buttons (data-action="navoffice") for touch and screen readers.
    this.labelLayer = document.createElement('div'); this.labelLayer.className = 'floor-labels';
    this.officeLabels = (o.offices || []).map(of => this.addOffice(of));
    if (o.you) this.officeLabels.push(this.addYou(o.you, o.youLabel || 'You are here'));
    viewer.container?.appendChild(this.labelLayer);
    viewer.scene.add(this.group);
    this.home = this.fitPreset();
    this.cur = { ...this.home }; this.from = null; this.anim = 0;
    this.apply();
    this.bindInput();
  }
  track(x) { this.disposables.push(x); return x; }

  addYou(p, text) {
    const pin = new THREE.Mesh(this.track(new THREE.ConeGeometry(0.7, 1.8, 24)), this.track(new THREE.MeshBasicMaterial({ color: 0x12355b, toneMapped: false })));
    pin.rotation.x = Math.PI; pin.position.copy(toRender({ x: p.x, y: p.y + 1.2, z: p.z }));
    const disc = new THREE.Mesh(this.track(new THREE.CircleGeometry(1.1, 32)), this.track(new THREE.MeshBasicMaterial({ color: 0x12355b, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false })));
    disc.rotation.x = -Math.PI / 2; disc.position.copy(toRender({ x: p.x, y: p.y + 0.04, z: p.z }));
    this.group.add(pin, disc);
    const el = document.createElement('span'); el.className = 'floor-label you'; el.textContent = text;
    this.labelLayer.append(el);
    return { el, anchor: toRender({ x: p.x, y: p.y + 2.2, z: p.z }) };
  }

  /** An office name over its door: a stem in the model and an HTML button that follows it on screen. */
  addOffice(of) {
    const stem = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.14, 0.14, 2.2, 8)), this.track(new THREE.MeshBasicMaterial({ color: of.draft ? 0x9a6b00 : 0x1a63be, toneMapped: false })));
    stem.position.copy(toRender({ x: of.x, y: of.y + 1.1, z: of.z }));
    this.group.add(stem);
    const b = document.createElement('button');
    b.className = `floor-label${of.draft ? ' draft' : ''}`; b.dataset.action = 'navoffice'; b.dataset.id = String(of.id);
    const t = document.createElement('b'); t.textContent = of.title; b.append(t);
    if (of.subtitle) b.setAttribute('aria-label', `${of.title}, ${of.subtitle}`);
    this.labelLayer.append(b);
    return { el: b, anchor: toRender({ x: of.x, y: of.y + 2.2, z: of.z }) };
  }

  /** Camera preset that fits the whole floor at the current aspect ratio. */
  fitPreset() {
    const b = this.o.bounds, y0 = this.o.elevation;
    const target = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
    const corners = [];
    for (const x of [b.minX, b.maxX]) for (const z of [b.minZ, b.maxZ]) for (const y of [y0, y0 + CUT_ABOVE_FLOOR]) corners.push(toRender({ x, y, z }));
    const cam = this.viewer.camera.clone(); cam.fov = FOV;
    let lo = 5, hi = 800;
    for (let i = 0; i < 32; i++) {
      const d = (lo + hi) / 2;
      this.place(cam, { target, yaw: 0, pitch: PITCH, dist: d });
      const ok = corners.every(p => { const v = p.clone().project(cam); return Math.abs(v.x) <= 0.97 && Math.abs(v.y) <= 0.97 && v.z < 1; });
      if (ok) hi = d; else lo = d;
    }
    return { target, yaw: 0, pitch: PITCH, dist: hi, fit: hi };
  }

  place(cam, s) {
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw); // canonical forward (yaw 0 looks into the building)
    const t = toRender({ x: s.target.x, y: this.o.elevation, z: s.target.z });
    const h = Math.cos(s.pitch) * s.dist, v = Math.sin(s.pitch) * s.dist;
    cam.position.copy(toRender({ x: s.target.x - fx * h, y: this.o.elevation + v, z: s.target.z - fz * h }));
    cam.up.set(0, 1, 0); cam.lookAt(t);
    cam.near = Math.max(0.5, s.dist * 0.02); cam.far = s.dist * 4 + 200;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true); // project() must use this candidate pose when fitting the floor
  }

  apply() {
    const cam = this.viewer.camera;
    cam.fov = FOV;
    this.place(cam, this.cur);
    const v = new THREE.Vector3();
    for (const l of this.officeLabels) {
      v.copy(l.anchor).project(cam);
      const off = v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
      l.el.hidden = off;
      if (!off) { l.el.style.left = `${(v.x + 1) * 50}%`; l.el.style.top = `${(1 - v.y) * 50}%`; }
    }
    this.viewer.invalidate();
  }

  clampState(s) {
    const b = this.o.bounds;
    s.dist = THREE.MathUtils.clamp(s.dist, this.home.fit * ZOOM_RANGE[0], this.home.fit * ZOOM_RANGE[1]);
    s.target.x = THREE.MathUtils.clamp(s.target.x, b.minX, b.maxX);
    s.target.z = THREE.MathUtils.clamp(s.target.z, b.minZ, b.maxZ);
    return s;
  }

  /** Animated change to a new camera state (buttons, reset). */
  goTo(next) {
    this.from = { ...this.cur, target: { ...this.cur.target } };
    this.to = this.clampState({ ...next, target: { ...next.target } });
    this.anim = 0; this.last = null;
    this.viewer.animating.add(this); this.viewer.invalidate();
  }
  tick(now) {
    if (!this.from) { this.viewer.animating.delete(this); return; }
    const dt = this.last === null ? 0 : (now - this.last) / 1000; this.last = now;
    this.anim = Math.min(1, this.anim + dt / EASE);
    const k = this.anim * this.anim * (3 - 2 * this.anim), L = (a, b) => a + (b - a) * k;
    let dy = this.to.yaw - this.from.yaw; dy -= Math.PI * 2 * Math.round(dy / (Math.PI * 2));
    this.cur = { ...this.cur, yaw: this.from.yaw + dy * k, pitch: L(this.from.pitch, this.to.pitch), dist: L(this.from.dist, this.to.dist),
      target: { x: L(this.from.target.x, this.to.target.x), z: L(this.from.target.z, this.to.target.z) } };
    this.apply();
    if (this.anim >= 1) { this.from = null; this.viewer.animating.delete(this); }
  }

  zoom(f) { this.goTo({ ...this.cur, dist: this.cur.dist / f }); }
  rotate(rad) { this.goTo({ ...this.cur, yaw: this.cur.yaw + rad }); }
  reset() { this.home = this.fitPreset(); this.goTo(this.home); }
  /** The viewport changed size: keep the same framing relative to the fit. */
  resized() { const r = this.cur.dist / this.home.fit; this.home = this.fitPreset(); this.cur.dist = this.home.fit * r; this.clampState(this.cur); this.apply(); }

  bindInput() {
    const el = this.viewer.renderer.domElement;
    const pts = new Map();
    let start = null;
    const snapshot = () => ({ ...this.cur, target: { ...this.cur.target } });
    const ground = (dx, dy, s) => {
      // screen drag -> ground motion, in the camera's yaw frame; metres per pixel at the target distance
      const h = el.clientHeight || 1, mpp = 2 * s.dist * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) / h;
      const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), rx = fz, rz = -fx; // right of forward (canonical)
      const along = dy * mpp / Math.sin(s.pitch);
      return { x: s.target.x - rx * dx * mpp + fx * along, z: s.target.z - rz * dx * mpp + fz * along };
    };
    const metrics = () => {
      const [a, b] = [...pts.values()];
      return { d: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    };
    const down = e => {
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.from = null; this.viewer.animating.delete(this);
      start = { s: snapshot(), p: { x: e.clientX, y: e.clientY }, m: pts.size === 2 ? metrics() : null };
    };
    const move = e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1 && start && !start.m) {
        const t = ground(e.clientX - start.p.x, e.clientY - start.p.y, start.s);
        this.cur = this.clampState({ ...start.s, target: t });
      } else if (pts.size === 2) {
        if (!start?.m) start = { s: snapshot(), m: metrics() };
        const m = metrics();
        this.cur = this.clampState({ ...start.s, target: { ...start.s.target }, dist: start.s.dist * start.m.d / Math.max(20, m.d), yaw: start.s.yaw - (m.ang - start.m.ang) });
      }
      this.apply();
    };
    const up = e => {
      pts.delete(e.pointerId);
      start = pts.size === 1 ? { s: snapshot(), p: [...pts.values()][0], m: null } : null;
    };
    const wheel = e => { e.preventDefault(); this.cur = this.clampState({ ...this.cur, dist: this.cur.dist * Math.exp(e.deltaY * 0.0012) }); this.apply(); };
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    this.unbind = () => {
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel); el.style.touchAction = '';
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unbind?.();
    this.labelLayer?.remove();
    this.viewer.animating.delete(this);
    this.group.removeFromParent();
    this.disposables.forEach(d => d.dispose?.());
    if (this.viewer.renderer) this.viewer.renderer.clippingPlanes = [];
    if (this.viewer.floorView === this) this.viewer.floorView = null;
    this.viewer.invalidate();
  }
}
