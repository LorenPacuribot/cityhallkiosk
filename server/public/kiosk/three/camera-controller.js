// Camera rig for route playback. It is driven by a POSE (canonical position on the route + yaw/pitch), never by
// the route directly, so a future on-screen character can share the same pose:
//   first-person  the eye stands on the route at eye height and looks along the pose's view direction.
//   (follow)      planned: a camera behind and above a character placed at the pose. Corridors are narrow, so that
//                 mode will need a collision-aware boom; it is deliberately not offered until it exists.
import * as THREE from 'three';
import { toRender } from './coordinates.js';
import { viewDirection } from '../../shared/walk-path.js';

export const EYE_HEIGHT = 1.6;     // m above the floor
const H_FOV = 72;                  // horizontal field of view (degrees) aimed for at any aspect ratio
const V_FOV_RANGE = [48, 74];      // vertical limits: portrait screens get a taller view, landscape a wider one
const WALK_LOOK_DOWN = THREE.MathUtils.degToRad(18); // keep the floor guide and stair treads in view

export class CameraRig {
  constructor(camera) { this.camera = camera; this.mode = 'first-person'; this.eye = new THREE.Vector3(); this.look = new THREE.Vector3(); }

  /** @param {{x,y,z,yaw,pitch}} pose canonical */
  update(pose) {
    const cam = this.camera;
    const v = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(H_FOV / 2)) / (cam.aspect || 1));
    cam.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(v), ...V_FOV_RANGE);
    cam.near = 0.05; cam.far = 600;
    toRender({ x: pose.x, y: pose.y + EYE_HEIGHT, z: pose.z }, this.eye);
    // look down at the floor guide while walking; lift the gaze to the door (sign and name tag) at the end
    const d = viewDirection(pose.yaw, Math.min(0, pose.pitch) - WALK_LOOK_DOWN * (1 - 0.75 * (pose.doorBlend || 0)));
    this.look.set(this.eye.x + d.x, this.eye.y + d.y, this.eye.z - d.z);
    cam.position.copy(this.eye);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    cam.updateProjectionMatrix();
  }
}
