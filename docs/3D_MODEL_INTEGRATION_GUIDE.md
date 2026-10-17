> **Note (2026-10-16).** This is the original brief, kept as delivered. Unity has since been dropped. The model files moved: `unity_baked_revision/` is now `web_source_r09/`, `09_Unity_Baked_Optimized.blend` is now `09_Baked_Optimized.blend` (same contents), and `Unity_Package/Assets/CityHallPrepared/` is now `web_source_r09/sidecars/`. Current status: `docs/HANDOFF.md`.

# Integrating the City Hall building into the web kiosk

Implementation specification • 16 October 2026

This guide describes the work required to integrate the actual Blender building into the existing browser application. It is an implementation plan, not a claim that the integration is complete. Examples marked **proposed** describe new contracts and files. Measurements, office assignments and accessible connections must be verified; example identifiers are not surveyed locations.

Companion files: [implementation task](3D_MODEL_IMPLEMENTATION_TASK.md) and [source inventory with hashes](3d-integration/source-inventory.json).

## 1. Intended result and architecture

Keep the existing Node/Express application, kiosk interface, admin interface and phone page. Replace the procedural greybox with the actual building using Three.js. Preserve the 2D directions fallback. Unity is not required to run this implementation.

The completed visitor flow is: search for a service → review requirements → resolve the office's current room → show verified directions from this kiosk → preview the route in 3D → optionally take the same directions by QR or print.

Keep these responsibilities separate:

| Responsibility | Source of truth | Runtime consumer |
|---|---|---|
| Physical building appearance | Versioned Blender-derived GLB and textures | Three.js viewer |
| Service content and office occupancy | Published database content | Kiosk, admin and phone |
| Physical opening-to-room association | Verified room/opening mapping | Signs and destination highlighting |
| Walkable connections and restrictions | Published navigation graph | Shared route planner |
| Camera movement and route animation | Viewer code using the planner's route | Three.js viewer |
| Kiosk starting position | Registered, verified kiosk record | Route planner |

A beautiful model is not proof that a route is walkable. A route must terminate at the verified public approach to the office door/counter. Closed office doors can remain closed because the preview need not enter the office.

## 2. Exact project and source files

Application repository:

```text
C:/Users/Administrator/Desktop/cityhallkiosk_codex/City Hall Code/cityhallkiosk
```

Model workspace:

```text
C:/Users/Administrator/Documents/ChatGPT/CityHallKiosk_Codex
```

Use this final Blender file:

```text
unity_baked_revision/09_Unity_Baked_Optimized.blend
```

Select scene `UNITY_Baked_Optimized` and collection `UNITY_Optimized_Geometry`. Export only its runtime meshes, door roots, sign faces and viewpoint markers. Exclude `UNITY_Blender_Preview_Lighting_Only`, all source scenes and `LEGACY_Unity_Export_DO_NOT_USE`. The source file also contains editable scenes; exporting every scene would duplicate the building and inflate memory.

Read these existing assets under `unity_baked_revision/Unity_Package/Assets/CityHallPrepared/`:

- `MaterialBindings.json`: authoritative material kinds and parameter values.
- `DynamicObjects.json`: 193 door roots and 54 sign faces, including original names and opening IDs where provided.
- `Viewpoints.json`: five camera markers and their target/up child names.
- `Textures/`: 16 RGBM lighting maps, the grading LUT, floor texture, civic seal and scenery image.
- `Shaders/BakedAfternoon.shader` and `Shaders/ProjectedEnvironment.shader`: reference algorithms to port, not browser-loadable shaders.

Additional evidence lives in `unity_baked_revision/Export_Report.json`, `Validation_Report.json`, `Texture_Validation.json`, `Triangle_Cleanup_Audit.json`, `previews/` and `Preview_Comparison.html`.

Verified starting counts:

| Item | Baseline |
|---|---:|
| Building mesh objects | 463 |
| Building triangles | 183,170 |
| Total meshes including scenery | 469 |
| Total triangles including scenery | 183,182 |
| Closed-door roots | 193 |
| Independently addressable sign faces | 54 |
| Scenery planes | 6 |
| Material bindings | 41: 24 baked, 16 PBR, 1 projected |
| Lighting maps | 16: three 2048² and thirteen 1024² |
| Lighting texture memory estimate | 133.3 MiB as RGBA8 including mipmaps |

The source bake is already complete. Do not rebake to export another format. Structural or lighting changes would require a separate rebake decision. The baked floors are more matte and exterior windows brighter than earlier source previews; do not describe the existing bake as an exact appearance match.

## 3. Preserve the current work before implementing

The application working directory already contains many modified and untracked files. Preserve those changes. Record `git status --short` and a baseline diff before editing. Do not reset, clean or replace the repository. Use a `codex/` branch if branching is appropriate; a new branch alone is not a backup of uncommitted files.

Back up the live database before schema work. **Do not run `npm run seed` against the working database:** it invokes a reset. Tests should use an explicit temporary `KIOSK_DB`, as the existing API tests do. Never commit a live database, credentials or staff session tokens.

The inspected project installs Three.js **0.160.0**. Pin that version for the first visual baseline and use its bundled loaders. A dependency upgrade can be a subsequent, separately validated change. Do not mix current online example code or a CDN loader with this older installed core.

The nine existing API tests passed during the preceding review. Run them again before and after implementation. They cover backend behavior, not the new GLB, shader, routing accuracy or touch experience.

Existing command, from `server/`:

```powershell
npm test
```

If Node is absent from PATH on this machine, the inspected runtime is:

```powershell
& 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --test test/api.test.js
```

## 4. Files to change and files to create

Paths below are relative to the application repository. New paths are **proposed**, not existing commands or modules.

| Path | Required work |
|---|---|
| `server/public/kiosk/index.html` | Add a local Three.js import map before module scripts. |
| `server/public/kiosk/nav3d.js` | Keep the public navigation adapter; delegate to the real viewer. |
| `server/public/kiosk/app.js` | Await viewer loading, handle cancellation/errors, route statuses, preferences and content changes. |
| `server/public/shared/route-core.js` | Replace fixed-corridor assumptions with a graph planner shared by server/browser. |
| `server/src/lib/route.js` | Read the published graph and resolve verified endpoints; call the shared planner. |
| `server/src/lib/data.js` | Extend `kioskBundle()` with a compatible model/navigation version and published graph/mappings. |
| `server/src/routes/public.js` | Extend route input/output and kiosk bundle validation. |
| `server/src/routes/admin.js` | Add controlled mapping, calibration and route-publication endpoints. |
| `server/src/schema.sql` plus versioned migrations | Store navigation/mapping revisions without destroying current content. |
| `server/public/admin/app.js` | Add validation/preview/publication controls for mappings and route restrictions. |
| `server/public/m/app.js` | Preserve origin/preferences in QR links and show all relevant floors. |
| `server/public/shared/i18n.js` | Add route error, lift/ramp, floor change and preference strings. |
| `server/public/kiosk/three/` | New viewer modules described below. |
| `server/public/models/cityhall/r09-web01/` | New immutable browser asset release. |
| `tools/model/` | New export, attribute, mapping and integrity tools. |
| `server/test/route.test.js`, `model.test.js` | New meaningful route/asset contract tests. |
| `server/test/e2e/` | New browser integration and repeat-navigation tests. |

Suggested module boundaries:

```text
server/public/kiosk/three/
  asset-manager.js       # manifest, loaders, texture cache and ownership
  materials.js           # baked/PBR/projected material factories
  coordinates.js         # the only canonical-to-render conversion
  building-viewer.js     # renderer, scene, resize, context loss and shutdown
  route-player.js        # route line, timing, progress and floor transitions
  camera-controller.js   # overview, eye-level view and obstruction handling
  dynamic-signs.js       # database labels on individually mapped sign faces
  floor-visibility.js    # validated floor/roof/cutaway metadata
```

Keep the existing plain JavaScript application initially. Introducing React or changing the backend framework is not a dependency of this work. If a bundler is added later, migrate the module loading deliberately rather than mixing two Three.js copies.

## 5. Define browser asset contracts before export

Create an immutable release directory containing:

```text
r09-web01/
  manifest.json
  building.glb
  scenery.glb
  materials.json
  nodes.json
  viewpoints.json
  textures/...
```

Keep the six scenery cards separate so an indoor route does not need to load the large exterior image. Keep service text and office occupancy out of these immutable files; they belong in published content.

The **proposed** manifest needs at least:

```json
{
  "schemaVersion": 1,
  "modelVersion": "r09-web01",
  "sourceBlendSha256": "COPY_FROM_VERIFIED_INVENTORY",
  "units": "metres",
  "assetCoordinates": "gltf-y-up-right-handed",
  "uvConvention": "gltf-top-left",
  "building": "building.glb",
  "scenery": "scenery.glb",
  "materials": "materials.json",
  "nodes": "nodes.json",
  "viewpoints": "viewpoints.json",
  "files": []
}
```

Populate `files` with relative path, exact bytes and SHA-256 for every dependent resource. Reject absolute URLs, path traversal and missing files. Do not publish the illustrative hash above. Release URLs should be versioned; do not overwrite a released GLB while kiosks cache it.

Each exported logical object needs a stable `assetId` in glTF `extras`. Use a deterministic ID, not Blender memory addresses or Three.js UUIDs. Record original object names as diagnostic metadata. `nodes.json` should map asset IDs to `sourceName`, role, verified `floorLevel`, wing, optional opening ID and cutaway group. Leave unknown classifications explicitly unknown until inspected. Floor level is an integer from the database; `GF`, `F2` and `F3Roof` are asset-zone names, not automatically serviceable floors.

Material binding must survive multi-material export. Preserve a material binding key on each material/primitive. Do not rely solely on Three.js object names: a glTF node with several primitives may load as a Group containing several Meshes. Preserve 463 logical building objects even if the renderer reports a different primitive/Mesh count.

## 6. Export GLB while preserving baked data

Create `tools/model/export_cityhall_web.py`. Use an isolated Blender process reading revision 09. It may modify a temporary in-memory export copy but must not save over the source file or Unity delivery.

1. Verify the source hash against `source-inventory.json`.
2. Select only `UNITY_Optimized_Geometry` runtime content. Classify by stable IDs and sidecars, using prefixes such as `STATIC_`, `DOOR_`, `DOORGEO_`, `SIGNFACE_`, `ENV_` and `VIEW_` as initial hints.
3. Preserve closed door parent transforms and pivots. Preserve sign faces independently. Keep the viewpoint target/up empties.
4. Export evaluated triangles, corner normals, both UV sets and linear vertex colors. Split vertices at UV/color/normal seams as needed; a higher exported vertex count alone is not geometry damage.
5. Use minimal temporary materials retaining the original binding key. Rebuild the real materials from the sidecar in the browser. Do not expect glTF to translate Blender's custom LUT or projection node networks.
6. Export building and scenery separately with glTF Y-up conversion enabled. Preserve names/extras and hierarchy. Do not normalize dimensions or center the model automatically.
7. Copy the existing texture bytes. Record hashes and parameter values in the browser release. Do not expose absolute Windows paths in runtime JSON.
8. Validate the emitted GLB, not just the Blender export return code.

The installed Blender 5.2 exporter exposes `export_texcoords`, `export_normals`, `export_attributes`, `export_vertex_color`, `export_vertex_color_name`, `export_extras` and material modes. Inspect RNA properties in the installed version before assembling the operator call. Select the `Albedo` color layer explicitly (`NAME` mode) or validate `ACTIVE` mode. Do not use the default material-dependent color export and assume custom-node colors will survive.

`export_materials='NONE'` can merge primitive groups and lose slot identity. Prefer minimal exported materials that retain the binding key; `PLACEHOLDER` is only suitable if a separately verified primitive-to-binding mapping is generated. Preserve every UV channel even when a placeholder material does not reference it.

Building attribute contract:

| Blender data | glTF attribute | Three.js 0.160.0 attribute |
|---|---|---|
| Vertex position | `POSITION` | `position` |
| Corner normal | `NORMAL` | `normal` |
| `BaseUV` | `TEXCOORD_0` | `uv` |
| `LightmapUV` | `TEXCOORD_1` | `uv1` |
| `Albedo`, linear RGB(A) | `COLOR_0` | `color` |

**Do not call the second glTF UV set `uv2` in this project.** Its installed loader maps `TEXCOORD_1` to `uv1`. A custom material may bind an alias such as `bakeUv` to that BufferAttribute without duplicating its array, to avoid assumptions about injected shader defines.

Validate each primitive: finite positions/normals, valid indices, required attributes, matching attribute lengths, nonempty material binding and stable logical parent. Compare triangle totals and world positions after undoing the known axis conversion; target geometric export error at or below 0.001 m. UV seams and vertices must not be welded across different baked values. Do not regenerate lightmap UVs, decimate, remesh or enable lossy geometry compression during the first parity pass.

If roof/ceiling faces are merged with walls, do not hide the entire zone to obtain a cutaway. Recover face provenance from `09_Unity_Bake_Working.blend` (`source_id`) and `Bake_Manifest.json.sources`, using a separate adaptation of `assemble_unity_export.py` to split required visibility groups while preserving triangle data, normals, colors and UVs. Do not rerun the existing assembly script against its delivery paths. Alternatively complete the eye-level pilot first and make cutaway splitting a separately verified export step.

## 7. Calibrate coordinates once

The database's documented coordinates are metres, Y up, +X right facing the building and +Z into it, with the main entrance as origin. Existing browser code uses:

```js
const toRender = ({ x, y, z }) => new THREE.Vector3(x, y, -z);
```

Retain this convention for database data. The Blender scene's origin and orientation must be measured; do not assume the final model already shares the database origin.

Use at least four verified anchors: entrance center at floor level, a point to the left, a point to the right/deeper inside, and an upstairs landing. Measure one known distance and the actual floor elevations. Avoid using placeholder database positions as calibration truth.

Define and record these transforms:

- `R`: the standard Blender-to-glTF axis conversion, normally `(Bx, By, Bz) → (Bx, Bz, -By)`; verify the exported anchors.
- `A`: surveyed Blender-world-to-canonical-database transform.
- `S`: canonical-to-browser conversion `(x, y, z) → (x, y, -z)`.
- GLB-root transform: `T = S × A × inverse(R)`.

Apply `T` to the imported building/scenery/viewpoint roots exactly once. Apply `S` to canonical route and room coordinates. Do not reflect both the GLB and its already-converted vertices. Store matrix ordering explicitly, preferably column-major arrays compatible with `THREE.Matrix4.fromArray()`.

Publish calibration as versioned data with model version, units, anchor IDs, measured positions, residual errors and verification status. Reject missing calibration for production routes; a draft preview may show a prominent unverified state. Do not silently substitute an identity matrix.

Calibration checks: measured width, left/right orientation, actual floor heights, entrance origin, correct label facing and a marker standing in front of each pilot door. Proposed initial field tolerance is 0.10 m at anchors, tightened wherever a doorway or narrow passage requires it. This is distinct from the much smaller export fidelity tolerance.

## 8. Port the material system deliberately

Create factories for `baked`, `pbr` and `projected` bindings. Fail loading with a useful diagnostic if any binding is missing; retain usable 2D directions. Use one cached texture per immutable URL. A new route should not reload the entire texture set.

### 8.1 Baked surfaces

Reproduce `BakedAfternoon.shader`, using the map-specific `lightRange` from the sidecar. Existing ranges include 4 and 8; do not substitute one global value.

The reference calculation is:

```text
irradiance = rgbm.rgb * rgbm.a * lightRange
linearSurface = irradiance * linearBaseTexture * linearVertexColor
displayRGB = sampleAfternoonLUT(linearSurface)
```

Use a white base texture when `baseTexture` is empty. Keep floor/seal base textures on UV0 and lighting on UV1. Apply vertex albedo once. RGBM alpha is an encoding multiplier, not surface transparency.

LUT calculation:

```text
p = clamp((log2(max(linearSurface, 1/4096)) + 12) / 18, 0, 1) * 63
slice = floor(p.b)
u0 = (slice * 64 + p.r + 0.5) / 4096
u1 = (min(slice + 1, 63) * 64 + p.r + 0.5) / 4096
vBottomOrigin = (p.g + 0.5) / 64
displayRGB = lerp(sample(u0, v), sample(u1, v), fract(p.b))
```

For the specified `flipY=false` top-origin PNG convention, use `v = 1 - vBottomOrigin`. Prove the orientation using known color samples and the existing numerical texture validation. Do not correct a flipped LUT by altering exposure.

Texture rules for the initial uncompressed baseline:

| Resource | Color space | Upload/filter rules |
|---|---|---|
| Base color and canvas labels | `SRGBColorSpace` | Standard glTF UVs; manually loaded textures `flipY=false`; confirm label orientation. |
| RGBM PNG maps | `NoColorSpace` | `flipY=false`, alpha preserved, `premultiplyAlpha=false`, clamp edges; mipmaps require seam checks. |
| `AgX_Afternoon_LUT.png` | `NoColorSpace` | 4096×64, linear filtering, no mipmaps, clamp; flip V in lookup as above. |
| Scenery PNG | `SRGBColorSpace` | `flipY=false`; projection shader supplies top-origin UV. |

Sampling an sRGB-tagged color texture gives linear color in the rendering workflow; do not decode it a second time. Numeric albedo/vertex colors copied from the source are already linear. The LUT is stored as display-encoded RGB data but must be sampled without automatic decoding before interpolation.

For a `ShaderMaterial`, set `toneMapped=false`. Convert the LUT result from sRGB to linear, then perform the renderer's single output conversion with the installed `colorspace_fragment` chunk. Set `renderer.outputColorSpace = THREE.SRGBColorSpace`. Use `THREE.NoToneMapping` for the initial scene baseline and do not add a second AgX/ACES transform or screen-wide grading pass. For a `RawShaderMaterial`, implement the corresponding output conversion explicitly; engine chunks are not automatically injected the same way.

Acceptance: compare GPU shader output for a fixed sample grid against a CPU reference using the same PNGs. Start with the existing LUT tolerance (mean error under 1.5 and maximum under 10 on an 8-bit scale); separately inspect shadows, lightmap seams, floor pattern, seal and signs. Numerical encoding parity alone does not establish full visual parity.

### 8.2 Glass, metal and fixtures

Create Three.js PBR materials from each `pbr` binding's linear `baseColor`, metallic, roughness, emission and transmission values. Preserve material boundaries and normals. Glass and polished frames need actual reflection/environment review. Start with a documented transparent-glass approximation or measured `MeshPhysicalMaterial` transmission, then compare quality and cost on the kiosk hardware.

Do not add all 379 Blender authoring lights to the browser. Static surfaces already carry their illumination. Use a restrained environment/reflection setup and only the runtime lighting justified by retained PBR materials. Avoid light leaking through walls; if shadow-casting runtime lights are used, baked meshes can cast shadows for PBR objects without receiving another diffuse lighting contribution themselves.

### 8.3 Six projected scenery cards

The source `ENV_` meshes carry projector XY in the first UV set and projector depth in the second. Those are data, not ordinary UVs. A normal glTF UV conversion can invert their Y component and corrupt the perspective.

In the temporary export copy, write raw projector values to three custom scalar attributes, for example `_PROJ_X`, `_PROJ_Y`, `_PROJ_DEPTH`. Export custom attributes and verify their exact values. In the installed Three.js loader, unknown attribute names are lowercased, giving `_proj_x`, `_proj_y`, `_proj_depth`. Scalar attributes avoid accidental vector axis conversion; validate that the exporter preserved the per-corner values.

Interpolate those values to the fragment shader, then compute:

```text
uvBottomOrigin = projectorXY / max(projectorDepth, 0.001)
uvBottomOrigin = uvBottomOrigin * projection.xy + projection.zw
uvTopOrigin = (uvBottomOrigin.x, 1 - uvBottomOrigin.y)
```

Use the `projection` vector from the material binding, double-sided rendering and the existing image as an unlit sRGB color texture. Divide after interpolation, not only at vertices. Do not rotate projector scalars when transforming world geometry.

Validate with `VIEW_LAYERED_Front_Composition`, 16:9 and its recorded vertical field of view. The planes support that view and small offsets. They are not a walkable lawn, road, gate or guardhouse. Load them for the exterior presentation; do not derive outdoor navigation or collision from their painted content.

## 9. Add local Three.js module loading

The server already serves its installed Three.js package at `/vendor/three`. Add this **proposed** import map before the first module script in the kiosk HTML:

```html
<script type="importmap">
{
  "imports": {
    "three": "/vendor/three/build/three.module.js",
    "three/addons/": "/vendor/three/examples/jsm/"
  }
}
</script>
```

Use matching imports in the new modules:

```js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
```

Apply the import map to any other page that loads those modules. Keep loader/decoder files local. No runtime CDN dependency is needed. The existing absolute core import should resolve to the same URL, but standardize imports as the modules are touched.

Serve GLB with `model/gltf-binary`, JSON with its normal JSON MIME type and textures with image MIME types. Prefer same-origin assets/API to avoid unnecessary CORS complexity. Inspect actual network responses and missing-file behavior.

The loader must fetch and validate the manifest, resolve relative asset URLs, verify compatibility, load the GLB, attach materials by binding ID, apply calibration and index asset IDs before announcing readiness. Show real loading/error states and keep search available during loading. Resolve office/sign text from the current published bundle after the geometry loads.

## 10. Connect viewer lifetime to the current kiosk

The current `startNav()` in `app.js` dynamically imports `nav3d.js` and calls synchronous `createNav3D(...)`. Real assets load asynchronously. Make that transition explicit, preserving the adapter's pause, replay, skip, progress and arrival behavior.

Suggested **proposed** interface:

```js
const controller = await createNav3D(container, bundle, route, {
  signal,
  onProgress,
  onArrive,
  onLoadProgress
});
// controller.pause(), replay(), skip(), dispose()
// Optional updateContent(bundle), setCameraMode(mode), setRoute(route).
```

Keep `onProgress(fraction, canonicalPosition, directionIndex)` compatible with the current minimap and direction list. Do not pass Three.js coordinates into a function that expects database coordinates. Fire `onArrive` once per playback.

Use an AbortController and monotonically increasing navigation generation. When the user leaves, searches again or the session resets, invalidate pending loads/callbacks. GLTFLoader internals may not cancel every request in this version; stale-result rejection is still required. Never attach a late controller to an obsolete screen. Dispose stale instances or release their cache references.

Separate application-lifetime asset ownership from per-route ownership. Reuse geometry/textures and, if practical, a viewer instance. Dispose route lines, labels, observers and animation loops when their route ends; dispose shared assets only after their final owner releases them. Avoid creating and force-losing a new WebGL context on every route.

Use `preserveDrawingBuffer=false` for ordinary navigation; the existing greybox enables it. Provide a deliberate screenshot path when needed. Pause rendering when hidden or idle, cap device pixel ratio initially, handle `webglcontextlost/restored`, and keep the 2D route usable if 3D fails.

Floor visibility must be metadata-based, including each mesh's classified role. During a staircase transition show both connected floors and the actual landings. An eye-level preview needs collision-aware camera placement or a validated camera path so it does not cut through walls. Do not smooth route corners into walls. Preserve the existing overview as an option, but do not carry its hard-coded 26 m camera height into the eye-level view.

For visual comparisons, position cameras from the exported `VIEW_` markers; use transformed target/up child positions and recorded vertical FOV. Treat source comparison cameras as 16:9. Compose the portrait kiosk separately rather than pretending a stretched or cropped portrait image is an exact source match.

## 11. Map rooms, doors and signs explicitly

An opening ID such as `R2-W001-D187` is not a database room code such as `2F-201`. Their relationship is not established by naming or counts. The 193 door roots include several types of doors; the 54 sign faces do not represent 54 verified offices.

Create an admin-editable, versioned mapping with:

- `modelVersion`, stable `openingId` and exact door/sign asset IDs.
- Database `roomId` plus room code for human review.
- Verified canonical approach point, facing direction and graph endpoint node ID.
- Verification state, reviewer and review date.
- Optional multiple openings per room and separate front/back sign orientations.

Retain unresolved rows as unresolved. Do not guess which office occupies a physical doorway. The model and public data are insufficient to establish this mapping automatically.

Suggested **new** tables are `room_openings` and `sign_bindings`, alongside existing `rooms`, `offices`, `office_locations` and `kiosks`. Use foreign keys and unique constraints to prevent a sign face from binding ambiguously. Account for a room with several occupants through the current location records and an explicit display rule.

The blank sign geometry remains unchanged. Generate a canvas texture with a white background and current office/room label, then assign it only to the intended face's UV0. Keep UV1 and its lighting map unchanged. Use an independent material/uniform instance where labels differ while sharing the immutable lightmap. Test both faces for mirrored text; do not flip the lighting UV to fix text orientation.

Office movement must update the label and destination through published data. Track active navigation by office/service identity, then resolve its current room again after a content update. Tracking only the old room ID misses moves between unchanged rooms. A physical room move/calibration change is a separate mapping change requiring route validation.

Keep doors closed in the initial release. Later door animation would not update the existing baked shadow and needs its own material/lighting design.

## 12. Replace prototype routing with verified graph routing

Remove dependence on `corridor_z=16`. Model a walkable network: kiosk origins, corridor junctions, door approaches, stair landings, and only verified ramps/lifts. Stairways need their actual landing/turn polyline, not a diagonal through the slab or an automatic match to the nearest object upstairs.

Suggested **new** tables: `navigation_revisions`, `navigation_nodes`, `navigation_edges`, and `kiosk_navigation_nodes`. A node contains a stable ID, canonical coordinates, floor and role. An edge contains endpoints, an ordered polyline in canonical coordinates, actual length, directionality, kind, verified status, public access, step-free eligibility and closure status. Store connection and display metadata for directions. Validate complete paths, not just room-level accessibility flags.

Use one pure planner shared by browser and server, for example Dijkstra initially. A* is suitable only with an admissible heuristic for the chosen costs; do not let a speed heuristic compromise route correctness. Keep rendering out of the planner.

Planner requirements:

1. Resolve the supplied kiosk explicitly. An unknown supplied kiosk code must produce an error; do not silently route from another kiosk. Preserve the configured lobby default only where deliberately specified.
2. Resolve office → current room → verified approach node. An offsite or unconfirmed office has a clear non-route result.
3. Use only published, verified and permitted edges in the selected model/navigation revision.
4. For step-free mode exclude stairs and every unverified/ineligible edge. If none remains, return a no-route result; never fall back to stairs.
5. Honor closures in both online and cached published data. Include data age and do not claim live closure information while offline.
6. Calculate travel distance along real edge polylines. Treat waiting times and estimated walking times as estimates.
7. Generate directional instructions from the same selected edges. Distinguish left/right turns, stairs up/down, ramp and lift; avoid generic "top of stairs" text for every floor change.
8. Preserve canonical waypoint coordinates and floor/transition information so 2D, 3D and phone playback agree.
9. Stop with a clear no-route response if disconnected. Do not draw an unvalidated straight line as visitor directions.

Maintain the existing successful route fields `from`, `to`, `waypoints`, `directions`, `distance_m` and `minutes`. Add these **proposed** fields: `status`, `modelVersion`, `navigationVersion`, `contentVersion`, `routePreference`, and `originKioskCode`. Provide explicit reasons such as `UNVERIFIED_DESTINATION`, `UNKNOWN_KIOSK`, `NO_STEP_FREE_ROUTE`, `ROUTE_CLOSED`, `DISCONNECTED` and `VERSION_MISMATCH`.

For HTTP, use a documented status such as 422 for an unrouteable valid request and 404 for unknown entities, with a structured body. The pure planner should return the same domain status without HTTP concerns. Update API/UI tests and callers together; the current UI assumes a successful route object.

Add the published navigation graph and mapping/calibration revision to `kioskBundle()`. Make `/api/route` and the browser call the same planner with the same inputs. The phone must use this route system too. Do not add independent Unity NavMesh routes as a competing authority for this browser release.

## 13. Publication, migrations and administrative workflow

Use versioned, transactional migrations, not a database reseed. The current `upgrade()` only adds a service notes column; add a migration ledger for further schema changes. Validate foreign keys, finite coordinates and positive lengths. Do not write `blender_sync` into the existing `coord_source` constraint without a migration; current permitted values are `manual`, `unity_sync`, `seed_placeholder`.

Keep the existing `/api/admin/rooms/sync-from-unity` compatible if still used. Add a neutral **proposed** import endpoint, such as `POST /api/admin/rooms/sync-from-model`, with model version, units, calibration version, dry-run support and reviewed room mappings. Reuse validation/business logic, not a fake Unity label for Blender-derived data.

A publication needs a compatible tuple `(modelVersion, calibrationVersion, navigationVersion, mappingVersion, contentVersion)`. Introduce new fields compatibly rather than removing `content_version` from existing clients. Stage a draft, validate all references and route checks, then publish atomically. The kiosk should not combine new room coordinates with an old route graph mid-session.

Normal office moves update occupancy/content without rebuilding geometry. Structural changes, a relocated doorway or changed stairs require a model/calibration/graph review. Preserve prior published revisions for rollback. Preserve the office move history, roles, audit records and approval behavior already implemented.

Administrative validation must list unresolved openings, unmapped signs, unreachable destinations, stale field verification and incompatible versions. New offices or draft routes must not silently appear as verified public directions. Treat the Citizen's Charter content and Filipino/Cebuano translations as requiring office/language review before production publication.

## 14. QR handoff, phone maps and printable directions

The current phone route request omits the originating kiosk. Include kiosk code and route preference in the QR URL, together with the service/office identifier and useful version context. A phone using another kiosk's URL must not default to the main lobby accidentally.

The phone should re-resolve the current destination and inform the visitor if the office moved since the QR was generated. Do not permanently bind a service link to an obsolete room. Keep printed directions labeled with the origin, destination, floor and preparation date/version.

Render every floor used by the route, not only the destination floor. Use the same verified map outlines and path coordinates. Keep 2D instructions as the phone's initial experience; downloading the entire model is optional.

The QR URL must be reachable from the visitor's phone. `localhost` on their phone refers to their phone. A LAN address requires appropriate Wi-Fi access; a public HTTPS URL needs the approved hosting arrangement. Publish only intended public data there, with administrative access handled separately.

This system initially previews a route from a known origin. It does not track the visitor indoors. If intermediate QR checkpoints are introduced, each must map to a verified graph node; a scan updates the route origin explicitly.

## 15. Offline operation and deployment

The current browser caches a content bundle in localStorage. That does not by itself guarantee a cold start while the application server is unavailable. Cache application files, verified model releases and compatible published content as a coherent release.

Recommended kiosk deployment: a local Windows service serves the application and durable published files from disk at a loopback URL, while a controlled background updater downloads and validates new releases from the authoritative server. Keep the local publication mirror read-only to ordinary kiosk use. Administrative writes belong to the authoritative database; avoid creating conflicting independent databases on every kiosk.

Edge kiosk mode uses InPrivate sessions, so use the disk-backed local service for restart persistence. A service worker/PWA cache may be useful for supported browser deployments, but it is not the only durable storage plan. Service-worker scope, secure-context requirements and actual browser policy must be tested.

Publication/update procedure:

1. Download a release into a new staging directory.
2. Validate manifest, hashes and content/model compatibility.
3. Check the required local files and database snapshot.
4. Switch a small active-release pointer atomically at an idle boundary.
5. Retain the previous known-good release for rollback.

Do not delete an in-use release. Show published-data age during network outages. Search and verified local routes should remain usable when internet access is disconnected. Phone access still depends on how its URL is hosted.

Run under a restricted kiosk account with automatic startup/restart. Test touchscreen keyboard, portrait/landscape layout, idle reset and optional printing on the actual device. Before deployment review authentication/session settings, default accounts, backups and recovery; do not expose the development configuration directly to the public internet.

## 16. Optimize after establishing correctness

The model's triangle count alone does not determine performance. Measure draw calls, texture memory, upload time, shader cost and repeated-navigation memory. The 133.3 MiB lighting estimate excludes base textures, scenery, geometry, framebuffer, JavaScript and driver overhead.

Start with exact PNG maps and uncompressed geometry for appearance comparison. Then optimize in measured stages:

- Load the interior model before optional scenery; avoid downloading it again on each route.
- Cap device pixel ratio, pause idle rendering and render static views only when needed.
- Use visibility groups and frustum culling. Split into floor/wing assets only after preserving cross-floor stairs, shared resources and consistent coordinates.
- Batch static geometry only where material, lighting and cutaway behavior permit. Keep dynamic sign faces and door roots independently addressable.
- Profile material groups: 463 logical meshes do not imply exactly 463 draw calls.
- Evaluate KTX2/Basis for suitable color textures with a matching local decoder. Do not apply lossy color compression to the RGBM multiplier or LUT without numerical and visual validation.
- Evaluate mesh compression only after the uncompressed positional/UV baseline passes. Compression savings are not proof of visual fidelity.

Proposed initial acceptance targets on the selected kiosk, to be measured rather than claimed: cached search response within 300 ms, warm route view within 2 s, sustained navigation at least 30 fps, no growing memory trend across 100 route changes, and successful recovery after restart without internet. Record hardware, resolution, browser, cache state and worst observed route. Set a separate cold-load budget after the first pilot measurement. Run an eight-hour kiosk session test before release.

## 17. Test plan and evidence

| Test group | Required evidence |
|---|---|
| Existing application | All nine API tests still pass; no live database changes during tests. |
| GLB integrity | Attribute/material completeness, stable IDs, finite geometry, hashes, correct triangle totals. |
| Coordinates | Known-distance test, four calibrated anchors, left/right and floor checks. |
| Material parity | Shader sample checks and source/browser images at identical reference cameras. |
| Dynamic content | Office move changes destination and both sign faces without replacing geometry. |
| Routing | Same-floor turns, both stairs, closures, disconnected graph, unknown kiosk, offsite/unconfirmed office. |
| Accessibility | Step-free request never uses stairs; unavailable verified path returns explicit no-route status. |
| Cross-client agreement | Server and browser choose the same path; phone/print preserve origin and preference. |
| Async/lifetime | Back, idle reset and rapid destination changes during loading create no stale canvas or callback. |
| Failure recovery | Missing GLB/texture, malformed manifest and WebGL loss preserve usable 2D information. |
| Offline/update | Cold restart offline, compatible cached release, staged update rejection and rollback. |
| Field verification | Staff walk each published route and confirm door/counter, turns and restrictions. |

Use browser screenshots for the five exported viewpoint markers, including the front composition and both upstairs wings. Compare to the final revision 09 previews, and include earlier source comparisons when assessing known appearance changes. Label Blender and browser images accurately. Record texture/color differences rather than compensating with arbitrary global exposure.

Add tests to the actual npm test command: the current command names only `test/api.test.js`, so new test files will not run automatically. One future command is `node --test test/api.test.js test/route.test.js test/model.test.js`, once those files exist. Use a separate documented browser-test command and keep browser fixtures/data isolated.

Store reports under a new test-results directory: browser/OS/GPU information, asset/content versions, route fixtures, screenshots, timings, renderer counters and failures. Rendering success does not replace route verification.

## 18. Delivery order and completion gates

| Stage | Deliverable | Completion gate |
|---|---|---|
| A. Baseline and contracts | Inventory, schemas, test baseline, export destination | Existing work preserved; inputs and intended versions recorded. |
| B. Visual pilot | One GLB release, loader and material factories | Reference views load with correct UVs, colors and projection; no unknown materials. |
| C. Calibration and mapping | Reviewed anchors, opening/room/sign mappings | Pilot doorway markers align; unresolved mappings remain explicit. |
| D. Shared routing | Published graph and planner on server/browser | Reachable valid routes, reliable no-route behavior, no stairs in step-free mode. |
| E. Visitor integration | Search → real 3D route → QR/print | Origin/destination/content updates stay consistent across clients. |
| F. Reliability | Local release cache, update/recovery, resource lifecycle | Restart/offline/context-loss/repeat-route checks pass. |
| G. Field pilot | Four routes on actual touchscreen | Staff verification and measured performance evidence. |
| H. Expansion | Remaining verified offices and operating procedure | Full route audit, content review, backup/rollback and long-session test. |

The first field pilot must cover the user's four routes:

1. Entrance → ground-floor left wing, including turns.
2. Entrance → ground-floor right wing, including turns.
3. Entrance → left stairs → second-floor left wing, including landings/turns.
4. Entrance → right stairs → second-floor right wing, including landings/turns.

Choose an actual verified destination for each. The two upstairs lighting reference cameras are visual comparison points, not proof of an already surveyed complete route. If a required room or accessible connection is unknown, record the missing field information and continue independent implementation without inventing it.

Final delivery should include browser assets with hashes, calibration/mapping/graph versions, migrations, source code, automated and field results, before/after browser images, launch/update/rollback instructions and an honest list of unresolved locations. Preserve the Blender master and the permanent-building rule: exclude people and removable/seasonal decorations.

## 19. Evidence and reference material

The implementation details above are grounded primarily in the installed code and source assets. Relevant inspected files include `server/public/kiosk/nav3d.js`, `server/public/shared/route-core.js`, `server/src/lib/data.js`, `server/src/routes/admin.js`, the installed Three.js `GLTFLoader.js`, its shader chunks and the installed Blender 5.2 glTF exporter. Their source snapshot is recorded in the companion inventory where listed.

Online references are supporting documentation; they do not replace version-specific inspection:

- [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html): supported loading and decoder interfaces; use the installed 0.160.0 implementation for this baseline.
- [Three.js color management](https://threejs.org/manual/pages/color-management.html): linear working color and explicit output conversion for custom materials.
- [Blender glTF exporter documentation](https://docs.blender.org/manual/en/4.3/addons/import_export/scene_gltf2.html): attribute/material export concepts; exact settings above were checked in installed Blender 5.2 code.
- [Microsoft Edge kiosk mode](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-configure-kiosk-mode): full-screen kiosk operation, InPrivate sessions and restart considerations.

This guide defines the work. It does not certify current office positions, accessible routes, production hosting, completed browser shader parity or performance on unspecified hardware.
