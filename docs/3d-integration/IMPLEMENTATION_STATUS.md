# Real-building integration: status and runbook

Status on 16 October 2026, branch `codex/3d-building-r09`. This file reports what is built and tested. It does not certify any route, office location or accessible connection.

## Status by stage (guide §18)

| Stage | Status |
|---|---|
| A. Baseline and contracts | Done. The 28 source assets match `source-inventory.json`. The live database was backed up before schema work. The existing 9 API tests still pass. |
| B. Visual pilot | Code done; the real export is **blocked**. The exporter, validator, loader, material factories and viewer are written and tested against a fixture release. The r09 export could not run because Blender needs ≥ 2.35 GiB free and the machine had 0.8–1.3 GiB. |
| C. Calibration and mapping | Data model, admin page and API done. A draft calibration exists (model-derived). **Field anchors are missing.** |
| D. Shared routing | Done. One graph planner serves the server, kiosk and phone. A draft graph exists for the four pilot routes. **No segment is verified.** |
| E. Visitor integration | Done for the kiosk 3D/2D view, QR handoff, phone page and printed slip. |
| F. Reliability | Partly done. Loading, cancellation, failure, context loss and repeat-route behaviour are tested. Offline update/rollback of model releases and a Windows service install are **not done**. |
| G. Field pilot | Not started: needs the field facts below and the actual touchscreen. |

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
- **Draft preview** is for staff only. It needs both the server switch (Admin → Navigation → Draft-route preview) and `?preview=1` on the kiosk URL. Every such route carries a "Draft route: not yet checked on site" banner.
- **3D view.** It plays only graph routes and needs a **verified calibration**, except for labelled draft routes. Until the calibration is verified, verified routes play on the 2D map. That map uses database coordinates, so it is still correct.

## Field facts needed (nothing below has been guessed)

1. **Kiosk position.** Where KIOSK-LOBBY-1 actually stands and which way it faces. The database value (−3, 0, 6) is a placeholder, so the graph has no start node for it and its routes return `UNKNOWN_KIOSK`. The pilot uses a separate origin, `PILOT-ENTRANCE` (inside the right-hand entrance doors).
2. **Calibration anchors.** Measure:
   - the entrance centre at floor level,
   - a point to the left,
   - a point to the right or deeper inside,
   - an upstairs landing,
   - one known distance,
   - the real floor elevations.

   The draft origin is the midpoint between the two entrance doorways on the facade line (Blender x=0, y=−17.5). The model puts the second floor at 4.0 m; the database says 4.2 m.
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
npm test              # 29 tests: API, planner, navigation API, model contract (the real-release check is skipped until exported)
npm run test:e2e      # 12 browser tests, headless Edge (fixture release; temporary database)
```

From the repository root:

```powershell
# 1. Read-only scene inspection (waits for memory; one guarded Blender at a time)
node tools/model/run-blender.mjs tools/model/inspect_r09.py --wait-min 120 -- "<model workspace>/unity_baked_revision/09_Unity_Baked_Optimized.blend" "<scratch>/inspect_r09.json"
# 2. Export the runtime scene into a staging directory (source verified by hash; never saved)
node tools/model/run-blender.mjs tools/model/export_cityhall_web.py --wait-min 120 -- "<…>/09_Unity_Baked_Optimized.blend" 6b861ed900092188ac6ff359f4c003d72b437cc375baff6819baa6bd6d648c37 "<scratch>/r09-staging"
# 3. Assemble, validate and install the immutable release (refuses to overwrite)
node tools/model/build-release.mjs "<scratch>/r09-staging"
node tools/model/validate-release.mjs server/public/models/cityhall/r09-web01
# 4. Rebuild the draft pilot graph from cited model evidence
node tools/model/pilot-graph.mjs
# 5. Rebuild the test fixture
node tools/model/make-fixture-release.mjs
```

The Blender guard has the same thresholds as the model workspace's `run_front_blender.py`:

- Blender starts only with ≥ 2.35 GiB available.
- It is stopped if availability falls under 1 GiB.
- It runs single-threaded at below-normal priority.
- It never closes other programs.

Publishing, done by an LGU admin:

1. Import the graph with `POST /api/admin/navigation/import`, sending `{ graph, dryRun }`.
2. Register the release with `POST /api/admin/model-releases`, sending `{ model_version }`.
3. In **Admin → Navigation**, review the report, map the doorways, mark the walked segments, and press **Publish**.
4. **Roll back** returns to the previous publication.

Every change is audited.

## Evidence produced

- `test-results/e2e/lut-parity.json`: the GPU afternoon LUT against Blender's 3,072 reference samples. Mean error is 0.19 and maximum 4 on the 8-bit scale, inside the 1.5 / 10 tolerance.
- `test-results/e2e/*.png`: fixture route screenshots (verified 3D, draft-calibration 2D, no step-free route) and the phone page.
- **Not yet produced** (all need the r09 export):
  - screenshots at the five revision 09 reference cameras,
  - the real-model GLB validation,
  - texture-memory and performance figures.

## Known gaps

- **r09 export.** Never run, so there are no real-building screenshots or counts. The validator checks for 463 objects, 183,170 triangles and ≤ 0.001 m error once the export exists.
- **Floor cutaway.** It uses zone names from the source object names (GF/F2/F3Roof). Whether roofs and ceilings are separable needs checking on the real export (guide §6, last paragraph).
- **Glass.** It uses a documented transparent approximation instead of transmission. It has not been compared on kiosk hardware.
- **Sign-label orientation.** Fine on the fixture; not yet checked on the real sign faces.
- **Offline operation.** Missing: model-release download, staged update and rollback tooling for kiosks; a Windows service installer; an offline cold-start test.
- **Translations.** The Filipino and Cebuano route strings are new and need language review.
