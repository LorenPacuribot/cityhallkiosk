# Real-building integration: status and runbook

Status on 16 October 2026, branch `codex/3d-building-r09`. This file reports what is built and tested. It does not certify any route, office location or accessible connection.

## Status by stage (guide Â§18)

| Stage | Status |
|---|---|
| A. Baseline and contracts | Done. The 28 source assets match `source-inventory.json`. The live database was backed up before schema work. The existing 9 API tests still pass. |
| B. Visual pilot | Done. Release **r09-web02** is exported, validated and installed:<br>â€¢ 463 building objects and 183,170 triangles, plus 6 scenery cards and 12 triangles, matching the inventory exactly<br>â€¢ worst geometric error 2.1 Ã— 10â»â· m<br>â€¢ UV, colour and projector sums match Blender per object<br>â€¢ 26 files and 73.6 MB, each SHA-256 listed<br>Browser renders exist for all five reference cameras (see below). |
| C. Calibration and mapping | Data model, admin page and API done. A draft calibration exists (model-derived). **Field anchors are missing.** |
| D. Shared routing | Done. One graph planner serves the server, kiosk and phone. A draft graph exists for the four pilot routes. **No segment is verified.** |
| E. Visitor integration | Done for the kiosk 3D/2D view, QR handoff, phone page and printed slip. |
| F. Reliability | Partly done. Loading, cancellation, failure, context loss and repeat-route behaviour are tested. Offline update/rollback of model releases and a Windows service install are **not done**. |
| G. Field pilot | Not started: needs the field facts below and the actual touchscreen. |

## Source defect found and corrected in the browser release

The front-composition camera, `LAYERED_Front_Composition`, has a **stale stored `matrix_world` (identity)** in `09_Baked_Optimized.blend`. Its own data evaluates to the intended camera: location (0, âˆ’220, 12), rotation 84.1Â° about X, no parent and no constraints. The check is `tools/model/inspect_front_camera.py`.

The delivery's `assemble_unity_export.py` copied that identity in two places:

- into `VIEW_LAYERED_Front_Composition` (line 171);
- into every scenery projector coordinate (line 164).

As delivered, the exterior view is blank and the projected scenery is wrong. That includes the **Unity package**, which was never tested in the Unity editor.

r09-web02 recomputes only the marker and the six cards' projector values from the camera's evaluated transform, using the delivery's own formula. Geometry, UVs, colours and lighting are unchanged. The correction is listed in the release's `manifest.json` under `sourceCorrections`. The delivery itself was not modified. The model team should fix the Unity package the same way.

## Reference views (test-results/reference/)

These were rendered in headless Edge with software rendering (SwiftShader) at 1280Ã—720, using each marker's recorded field of view. They were compared with the delivery's `previews/FINAL_*.png`.

- **Matches:** framing, building placement, projected sky, lawn, gate and road layers, interior layout, wall and ceiling tones, the floor tile, doors and signs.
- **Glass:** the browser's transparent-glass approximation makes the front stairwell windows read as dark stripes; Blender renders reflective glass.
- **Brushed stainless** (waiting-area chairs, fittings) renders much darker than Blender's preview. The browser deliberately lights PBR surfaces with a neutral environment, not the 379 authoring lights. Next step: a reflection probe rendered from the baked interior; no brightness hand-tuning.
- **Lift shaft:** the concept lift's interior is unbaked and appears black in the overview cutaway.
- **Timings:** the ones in `report.json` are from software rendering, **not** kiosk performance.

## Pilot routes in the real building (test-results/pilot/)

`node test/e2e/pilot-routes.mjs` plays all four draft routes through the kiosk UI. Each route gets an overview, a midway overview, a walk view and an approach view.

- The routes visibly follow the revision 09 corridors.
- The 2F routes climb the actual left and right stair flights and landings.
- Every route ends at the expected doorway.

This is a visual check, **not** a field verification.

The overview uses a clipping plane 2.2 m above the walker's feet. An earlier attempt hid whole floor zones; that exposed never-baked (black) ceiling tops, because the export groups ceilings with the floor below, which is the case guide Â§6 describes.

## How routing works now

- **Nothing published** (the live database today). Kiosks keep the old corridor routes, which are labelled `routeSource: prototype_placeholder` and drawn only in the old greybox, never over the real building. This mode now fails explicitly in two cases where it used to guess: an unknown kiosk, and a step-free request with no step-free connection (it used to fall back to stairs).
- **A graph is published.** It is the only authority, with no prototype fallback. A route uses only verified, public, open segments, from a kiosk with a registered graph position, to a doorway whose mapping to the office's *current* room is verified. Otherwise the result is an explicit reason:
  - `UNKNOWN_KIOSK`
  - `UNVERIFIED_DESTINATION`
  - `UNVERIFIED_ROUTE`
  - `NO_STEP_FREE_ROUTE`
  - `ROUTE_CLOSED`
  - `DISCONNECTED`
  - `VERSION_MISMATCH`
  - `OFFSITE`

  A failed route never draws a line. Step-free never uses stairs, and segments whose step-free status is unknown are never offered for step-free.
- **Draft preview** is for staff only. It needs both the server switch (Admin â†’ Navigation â†’ Draft-route preview) and `?preview=1` on the kiosk URL. Every such route carries a "Draft route: not yet checked on site" banner.
- **3D view.** It plays only graph routes and needs a **verified calibration**, except for labelled draft routes. Until the calibration is verified, verified routes play on the 2D map. That map uses database coordinates, so it is still correct.

## Field facts needed (nothing below has been guessed)

1. **Kiosk position.** Where KIOSK-LOBBY-1 actually stands and which way it faces. The database value (âˆ’3, 0, 6) is a placeholder, so the graph has no start node for it and its routes return `UNKNOWN_KIOSK`. The pilot uses a separate origin, `PILOT-ENTRANCE` (inside the right-hand entrance doors).
2. **Calibration anchors.** Measure:
   - the entrance centre at floor level,
   - a point to the left,
   - a point to the right or deeper inside,
   - an upstairs landing,
   - one known distance,
   - the real floor elevations.

   The draft origin is the midpoint between the two entrance doorways on the facade line (Blender x=0, y=âˆ’17.5). The model puts the second floor at 4.0 m; the database says 4.2 m.
3. **Which office is behind each pilot doorway, and that it is the public entrance:**
   - R1-W002-D108: ground floor, left
   - R1-W038-D133: ground floor, right
   - R2-W032-D210: second floor, left
   - R2-W057-D229: second floor, right

   The same question applies to the other 23 signed doorways.
4. **Walk each pilot route.**
   - All four routes start inside the entrance.
   - The second-floor left route uses the left main stairs, turning right at both landings.
   - The second-floor right route uses the right main stairs, turning left at both landings.
   - The corridor positions come from the **revision 05** walkthrough stations and have not been re-checked against revision 09.
5. **Lift and ramps.** Whether the right-hand lift exists, its stops and whether it is public. It is modelled as an estimated concept and kept non-public in the graph. Whether the entrance ramps exist and their levels.
6. **Step-free status** of every corridor segment.
7. **Kiosk hardware** for performance measurement: GPU, browser version, resolution.

## Commands

From `server/`:

```powershell
npm test              # 29 tests: API, planner, navigation API, model contract (incl. the real r09-web02 release)
npm run test:e2e      # 12 browser tests, headless Edge (fixture release; temporary database)
node test/e2e/reference-views.mjs   # renders the five VIEW_ markers -> test-results/reference/
node test/e2e/pilot-routes.mjs      # plays the four draft pilot routes in the real building -> test-results/pilot/
```

From the repository root:

```powershell
# 1. Read-only scene inspection (waits for memory; one guarded Blender at a time)
node tools/model/run-blender.mjs tools/model/inspect_r09.py --wait-min 120 -- "<model workspace>/web_source_r09/09_Baked_Optimized.blend" "<scratch>/inspect_r09.json"
# 2. Export the runtime scene into a staging directory (source verified by hash; never saved)
node tools/model/run-blender.mjs tools/model/export_cityhall_web.py --wait-min 120 -- "<â€¦>/09_Baked_Optimized.blend" 6b861ed900092188ac6ff359f4c003d72b437cc375baff6819baa6bd6d648c37 "<scratch>/r09-staging"
# 3. Assemble, validate and install the immutable release (refuses to overwrite)
node tools/model/build-release.mjs "<scratch>/r09-staging"
node tools/model/validate-release.mjs server/public/models/cityhall/r09-web02
# 4. Rebuild the draft pilot graph from cited model evidence
node tools/model/pilot-graph.mjs
# 5. Rebuild the test fixture
node tools/model/make-fixture-release.mjs
```

The Blender guard has the same thresholds as the model workspace's `run_front_blender.py`:

- Blender starts only with â‰¥ 2.35 GiB available.
- It is stopped if availability falls under 1 GiB.
- It runs single-threaded at below-normal priority.
- It never closes other programs.

Publishing, done by an LGU admin:

1. Import the graph with `POST /api/admin/navigation/import`, sending `{ graph, dryRun }`.
2. Register the release with `POST /api/admin/model-releases`, sending `{ model_version }`.
3. In **Admin â†’ Navigation**, review the report, map the doorways, mark the walked segments, and press **Publish**.
4. **Roll back** returns to the previous publication.

Every change is audited.

## Evidence produced

- `test-results/e2e/lut-parity.json`: the GPU afternoon LUT against Blender's 3,072 reference samples. Mean error is 0.19 and maximum 4 on the 8-bit scale, inside the 1.5 / 10 tolerance.
- `test-results/e2e/*.png`: fixture route screenshots (verified 3D, draft-calibration 2D, no step-free route) and the phone page.
- `test-results/reference/`: the five reference-camera renders and `report.json`.
- `test-results/pilot/`: the four pilot routes in portrait, with a report.
- **Not yet produced:** texture-memory and performance figures on the kiosk's own GPU.

## Known gaps

- **Glass and metal.** Both are documented approximations, with the differences listed above. Neither has been compared on kiosk hardware.
- **Sign-label orientation.** Fine on the fixture; not yet checked on the real sign faces.
- **Offline operation.** Missing: model-release download, staged update and rollback tooling for kiosks; a Windows service installer; an offline cold-start test.
- **Translations.** The Filipino and Cebuano route strings are new and need language review.
