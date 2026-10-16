// The only place that converts between coordinate systems (docs/3D_MODEL_INTEGRATION_GUIDE.md §7).
//
//   canonical  database / route coordinates: metres, Y up, +X right when facing the building,
//              +Z into the building, origin = main entrance centre at ground level.
//   render     three.js world: (x, y, z) -> (x, y, -z)                                  = S
//   blender    model authoring space, Z up                                              (source of the GLB)
//   gltf       GLB asset space: blender (x, y, z) -> (x, z, -y)                         = R
//   calibration A maps blender world -> canonical. It is measured data, published per model version.
//
// The GLB root gets T = S × A × R⁻¹ exactly once. Route and room coordinates get S only.
// Matrices are column-major arrays (THREE.Matrix4.fromArray order).
import * as THREE from 'three';

export const S = new THREE.Matrix4().makeScale(1, 1, -1);
export const R = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, -1, 0, 0,
  0, 0, 0, 1);

export const toRender = ({ x, y, z }, target = new THREE.Vector3()) => target.set(x, y, -z);
export const toCanonical = v => ({ x: v.x, y: v.y, z: -v.z });

export class CalibrationError extends Error {
  constructor(message, code = 'CALIBRATION_MISSING') { super(message); this.code = code; }
}

/**
 * Validates a published calibration record and returns the GLB-root matrix T.
 * Never substitutes an identity matrix: a missing or malformed calibration is an error.
 * @param {object} cal {modelVersion, status, matrixBlenderToCanonical:number[16], ...}
 * @param {string} modelVersion the release being loaded
 * @param {{allowDraft?: boolean}} opts drafts are allowed only for clearly-labelled previews
 */
export function glbRootMatrix(cal, modelVersion, { allowDraft = false } = {}) {
  if (!cal) throw new CalibrationError('No calibration is published for this model.');
  if (cal.modelVersion !== modelVersion) throw new CalibrationError(`Calibration is for ${cal.modelVersion}, model is ${modelVersion}.`, 'VERSION_MISMATCH');
  const m = cal.matrixBlenderToCanonical;
  if (!Array.isArray(m) || m.length !== 16 || !m.every(Number.isFinite)) throw new CalibrationError('Calibration matrix is malformed.', 'CALIBRATION_INVALID');
  if (cal.status !== 'verified' && !allowDraft) throw new CalibrationError('Calibration is not verified.', 'CALIBRATION_UNVERIFIED');
  const A = new THREE.Matrix4().fromArray(m);
  if (Math.abs(A.determinant()) < 1e-9) throw new CalibrationError('Calibration matrix is singular.', 'CALIBRATION_INVALID');
  const Rinv = R.clone().invert();
  return new THREE.Matrix4().multiplyMatrices(S, A).multiply(Rinv);
}

/** gltf-space point (e.g. a marker from viewpoints.json) -> render space, through the same T as the GLB root. */
export const gltfToRender = (T, [x, y, z]) => new THREE.Vector3(x, y, z).applyMatrix4(T);
