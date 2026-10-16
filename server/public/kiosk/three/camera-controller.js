// Camera for route playback.
//   overview  elevated follow camera looking down at the walker and the route ahead, upper floors cut away.
//   eye       eye level ON the route polyline, looking along it. The route comes from the verified graph, so a
//             camera that stays on it never passes through walls; corners turn the view, never cut the corner.
import * as THREE from 'three';

const EYE = 1.6;
const OVERVIEW = { minHeight: 14, maxHeight: 40, back: 0.62, margin: 5 };

export class CameraController {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'overview';
    this.pos = new THREE.Vector3(); this.look = new THREE.Vector3();
    this.init = false;
  }
  setMode(mode) { if (mode !== this.mode) { this.mode = mode; this.init = false; } }

  /**
   * @param {THREE.Vector3} walker render-space position on the route
   * @param {THREE.Vector3} ahead render-space point further along the route (same floor when possible)
   * @param {THREE.Vector3} heading render-space unit direction of travel
   * @param {number} dt seconds since last frame
   */
  update(walker, ahead, heading, dt) {
    const cam = this.camera;
    let desiredPos, desiredLook;
    if (this.mode === 'eye') {
      desiredPos = walker.clone().add(new THREE.Vector3(0, EYE, 0));
      desiredLook = ahead.clone().add(new THREE.Vector3(0, EYE * 0.9, 0));
      if (desiredLook.distanceTo(desiredPos) < 0.5) desiredLook = desiredPos.clone().add(heading.clone().multiplyScalar(3));
      cam.fov = 60; cam.near = 0.05;
      // position is never smoothed off the line (that could leave the corridor); only the view direction eases
      this.pos.copy(desiredPos);
      this.look.lerp(desiredLook, this.init ? 1 - Math.pow(0.004, dt) : 1);
    } else {
      const focus = walker.clone().lerp(ahead, 0.5);
      const span = walker.distanceTo(ahead) / 2 + OVERVIEW.margin;
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(45 / 2));
      const h = THREE.MathUtils.clamp(span / (tanHalf * Math.min(1, cam.aspect)), OVERVIEW.minHeight, OVERVIEW.maxHeight);
      // stand behind the walker (opposite the travel direction) and look down at the focus
      const back = new THREE.Vector3(-heading.x, 0, -heading.z).normalize().multiplyScalar(h * OVERVIEW.back);
      desiredPos = focus.clone().add(back).add(new THREE.Vector3(0, h, 0));
      desiredLook = focus;
      cam.fov = 45; cam.near = 0.3;
      const k = this.init ? 1 - Math.pow(0.03, dt) : 1;
      this.pos.lerp(desiredPos, k); this.look.lerp(desiredLook, k);
    }
    if (!this.init) { this.pos.copy(desiredPos); this.look.copy(desiredLook); this.init = true; }
    cam.position.copy(this.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    cam.updateProjectionMatrix();
  }
}
