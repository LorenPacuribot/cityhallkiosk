// Browser versions of the Unity delivery's materials (docs/3D_MODEL_INTEGRATION_GUIDE.md §8).
//
//   baked      Shaders/BakedAfternoon.shader:  irradiance = rgbm.rgb * rgbm.a * lightRange
//              linearSurface = irradiance * linearBase(uv0) * linearVertexColour;  display = AfternoonLUT(linearSurface)
//   pbr        glass / metal / emissive fixtures from the binding's linear values (approximation, see pbrMaterial)
//   projected  Shaders/ProjectedEnvironment.shader: uv = projXY / max(depth, .001) * projection.xy + projection.zw
//
// Renderer contract: outputColorSpace = SRGBColorSpace, toneMapping = NoToneMapping. The baked/projected
// shaders produce linear values and use the installed colorspace_fragment chunk for the single output encode.
import * as THREE from 'three';

const SRGB_TO_LINEAR = /* glsl */`
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}`;

// Shared by the shader and by tests/sample checks (lut-check.js) so both use the same addressing.
export const LUT_GLSL = /* glsl */`
uniform sampler2D lut;
vec3 gradeAfternoon(vec3 linearColor) {
  // 64^3 LUT laid out 4096x64: R within each 64-px slice, G vertical (bottom origin), B selects the slice.
  vec3 p = clamp((log2(max(linearColor, vec3(1.0 / 4096.0))) + 12.0) / 18.0, 0.0, 1.0) * 63.0;
  float slice = floor(p.b);
  // texture uploaded with flipY = false (top-origin PNG): flip V once here
  float v = 1.0 - (p.g + 0.5) / 64.0;
  vec2 a = vec2((slice * 64.0 + p.r + 0.5) / 4096.0, v);
  vec2 b = vec2((min(slice + 1.0, 63.0) * 64.0 + p.r + 0.5) / 4096.0, v);
  return mix(texture2D(lut, a).rgb, texture2D(lut, b).rgb, fract(p.b));
}`;

const BAKED_VERT = /* glsl */`
attribute vec2 bakeUv;
attribute vec3 bakeColor;
varying vec2 vUv;
varying vec2 vBakeUv;
varying vec3 vColor;
#include <clipping_planes_pars_vertex>
void main() {
  vUv = uv;
  vBakeUv = bakeUv;
  vColor = bakeColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const BAKED_FRAG = /* glsl */`
uniform sampler2D lightMap;
uniform sampler2D baseMap;
uniform float lightRange;
uniform float hasBase;
varying vec2 vUv;
varying vec2 vBakeUv;
varying vec3 vColor;
${SRGB_TO_LINEAR}
${LUT_GLSL}
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  vec4 lm = texture2D(lightMap, vBakeUv);              // RGBM: alpha is the range multiplier, not transparency
  vec3 base = hasBase > 0.5 ? texture2D(baseMap, vUv).rgb : vec3(1.0); // sRGB texture: sampled as linear
  vec3 linearSurface = lm.rgb * lm.a * lightRange * base * vColor;
  gl_FragColor = vec4(srgbToLinear(gradeAfternoon(linearSurface)), 1.0);
  #include <colorspace_fragment>
}`;

const PROJ_VERT = /* glsl */`
attribute float _proj_x;
attribute float _proj_y;
attribute float _proj_depth;
varying vec3 vProj;
void main() {
  vProj = vec3(_proj_x, _proj_y, _proj_depth);         // interpolated, divided per fragment
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PROJ_FRAG = /* glsl */`
uniform sampler2D map;
uniform vec4 projection;
varying vec3 vProj;
void main() {
  vec2 uvBottom = vProj.xy / max(vProj.z, 0.001) * projection.xy + projection.zw;
  gl_FragColor = vec4(texture2D(map, vec2(uvBottom.x, 1.0 - uvBottom.y)).rgb, 1.0);
  #include <colorspace_fragment>
}`;

let WHITE = null;
function whiteTexture() {
  if (!WHITE) {
    WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    WHITE.needsUpdate = true;
  }
  return WHITE;
}

/** Baked surface: needs geometry attributes uv (UV0), uv1 (lightmap UV) and color (linear albedo). */
export function bakedMaterial(binding, { lightMap, baseMap, lut }) {
  const m = new THREE.ShaderMaterial({
    name: binding.name,
    uniforms: {
      lightMap: { value: lightMap },
      baseMap: { value: baseMap || whiteTexture() },
      hasBase: { value: baseMap ? 1 : 0 },
      lut: { value: lut },
      lightRange: { value: binding.lightRange },
    },
    vertexShader: BAKED_VERT,
    fragmentShader: BAKED_FRAG,
    clipping: true,
  });
  m.toneMapped = false;
  m.userData.binding = binding.name;
  m.userData.kind = 'baked';
  return m;
}

/** Point the shader's attribute names at the loader's BufferAttributes without copying arrays. */
export function prepareBakedGeometry(geometry, label) {
  const uv1 = geometry.getAttribute('uv1'), color = geometry.getAttribute('color'), uv = geometry.getAttribute('uv');
  if (!uv || !uv1 || !color) throw new Error(`${label}: baked surface needs uv, uv1 and color attributes (has ${Object.keys(geometry.attributes).join(', ')})`);
  geometry.setAttribute('bakeUv', uv1);
  geometry.setAttribute('bakeColor', color.itemSize === 3 ? color : rgbView(color));
}
// COLOR_0 may arrive as RGBA; the shader reads RGB (alpha is not used for baked surfaces).
function rgbView(attr) {
  const n = attr.count, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = attr.getX(i); out[i * 3 + 1] = attr.getY(i); out[i * 3 + 2] = attr.getZ(i); }
  return new THREE.BufferAttribute(out, 3);
}

/**
 * Glass, metal and emissive fixtures. Documented approximation for the first parity pass: glass is a thin
 * transparent standard material with environment reflections instead of MeshPhysicalMaterial transmission,
 * which would add a full extra scene pass per frame on kiosk hardware. Compare on the actual device before changing.
 */
export function pbrMaterial(binding, { envMap } = {}) {
  const [r, g, b, a] = binding.baseColor || [1, 1, 1, 1];
  const glass = (binding.transmission || 0) > 0.5;
  const m = new THREE.MeshStandardMaterial({
    name: binding.name,
    color: new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace),
    metalness: binding.metallic ?? 0,
    roughness: binding.roughness ?? 0.5,
    envMap: envMap || null,
    envMapIntensity: glass ? 1.0 : 0.8,
    transparent: glass || a < 1,
    opacity: glass ? 0.22 : a,
    depthWrite: !glass,
    side: glass ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (binding.emission > 0) {
    const [er, eg, eb] = binding.emissionColor || binding.baseColor || [1, 1, 1];
    m.emissive = new THREE.Color().setRGB(er, eg, eb, THREE.LinearSRGBColorSpace);
    m.emissiveIntensity = binding.emission;
  }
  m.userData.binding = binding.name;
  m.userData.kind = 'pbr';
  m.userData.approximation = glass ? 'transparent-standard-glass' : null;
  return m;
}

/** Projected scenery card: needs scalar attributes _proj_x, _proj_y, _proj_depth (GLTFLoader lowercases names). */
export function projectedMaterial(binding, { map }) {
  const m = new THREE.ShaderMaterial({
    name: binding.name,
    uniforms: { map: { value: map }, projection: { value: new THREE.Vector4(...binding.projection) } },
    vertexShader: PROJ_VERT,
    fragmentShader: PROJ_FRAG,
    side: THREE.DoubleSide,
  });
  m.toneMapped = false;
  m.userData.binding = binding.name;
  m.userData.kind = 'projected';
  return m;
}

export function prepareProjectedGeometry(geometry, label) {
  for (const a of ['_proj_x', '_proj_y', '_proj_depth']) if (!geometry.getAttribute(a)) throw new Error(`${label}: projected card is missing ${a}`);
}
