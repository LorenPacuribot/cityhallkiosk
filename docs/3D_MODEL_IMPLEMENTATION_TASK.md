# Implementation task: real City Hall model in the web kiosk

Use this task with the [detailed integration guide](3D_MODEL_INTEGRATION_GUIDE.md) and [source inventory](3d-integration/source-inventory.json). This file is a handoff prompt; it does not mean the work below has already been performed.

## Objective

Integrate the actual revision 09 Blender building into the existing Three.js web kiosk. Keep the current Node/Express API, admin workflow, search, translations, requirements, QR/phone page, print flow and 2D fallback. Deliver verified route previews from the physical kiosk to office entrances. Unity is not the runtime for this implementation.

Application root:

```text
C:/Users/Administrator/Desktop/cityhallkiosk_codex/City Hall Code/cityhallkiosk
```

Blender source:

```text
C:/Users/Administrator/Documents/ChatGPT/CityHallKiosk_Codex/unity_baked_revision/09_Unity_Baked_Optimized.blend
```

Read `docs/3D_MODEL_INTEGRATION_GUIDE.md` completely before editing. Use its exact baseline, data contracts, material algorithms and completion gates. All suggested new files/endpoints are to be implemented and tested; do not assume they already exist.

## Working constraints

- Preserve existing modified/untracked application files and the Blender/Unity source deliveries. Record a baseline first. Add migrations without resetting the live database; never run the reset seed against it.
- Use installed Three.js 0.160.0 and matching local loaders for the first parity pass. No framework rewrite is necessary.
- Export only `UNITY_Baked_Optimized` runtime geometry. Preserve the 193 closed-door roots, 54 blank sign faces, six scenery cards, source geometry, both UV channels and vertex colors.
- Read and port material bindings, RGBM lighting, the LUT and projected scenery. The custom Unity shaders do not transfer automatically through GLB.
- Preserve the permanent-building rule: no people or removable/seasonal decorations.
- Use stable asset/opening/room identities. Never infer office assignments, actual kiosk position, floor elevations or accessible connections from placeholder coordinates.
- Do not rebake existing lighting merely to export GLB. Use one guarded Blender process at a time on this memory-constrained machine. Preserve the existing launcher thresholds; never terminate user applications.
- Keep routing deterministic and shared by browser/server. No route through walls, no straight-line fallback presented as directions, and no stairs fallback for a step-free request.
- Make actual status explicit: draft/unverified routes, missing mapping information, browser material differences and untested hardware must not be reported as verified.

## Execute in this order

1. Check current instructions and git status, verify input hashes, preserve working changes, and run the existing nine API tests with a temporary database.
2. Implement a reproducible browser export into an isolated versioned directory. Write a manifest, material bindings, stable node metadata and viewpoints. Validate GLB attributes and geometry. Keep scenery separately loadable.
3. Implement local Three.js imports, asset loading, baked/PBR/projected material factories, shader sample checks and reference-camera screenshots. Establish visual correctness before lossy compression.
4. Implement calibration and explicit room/opening/sign mappings, including draft verification states and admin preview. Request only the genuinely missing field facts; continue independent work while they are unresolved.
5. Implement navigation graph migrations, validation and a shared planner. Preserve compatible successful route fields while adding explicit no-route statuses, versions and preferences.
6. Connect asynchronous loading and route playback to the existing kiosk controls. Handle cancellation, office moves, resource reuse, idle reset and 2D fallback. Generate dynamic labels without modifying lighting UVs.
7. Update QR/phone/print flows to preserve the originating kiosk, selected accessibility preference and current destination. Include all floors on multi-floor routes.
8. Add durable local published releases, version compatibility, offline restart behavior and staged update/rollback. Keep ordinary kiosk operation separate from administrative editing.
9. Validate the four pilot routes, measure the actual device, then expand only to mapped and verified destinations. Keep any unmapped office explicitly unconfirmed.

## Pilot routes

- Entrance → ground-floor left wing.
- Entrance → ground-floor right wing.
- Entrance → left stairs → second-floor left wing.
- Entrance → right stairs → second-floor right wing.

Include corridor turns, stair turns/landings and the public approach at each destination. Route cameras and doors must align with the actual model. Staff must physically verify public routes before production publication.

## Completion evidence

- All existing API tests pass; new route/model/browser tests are included in runnable test commands.
- Model release hashes, stable IDs, attribute/material completeness and triangle/world-position checks pass.
- Browser captures exist at the revision 09 reference cameras, with reported appearance differences.
- Kiosk and server produce the same route; phone and printed directions preserve its origin and preference.
- Step-free mode fails explicitly when no verified eligible route exists.
- An office move updates its signs and active destination without rebuilding the model.
- Repeated route changes, interrupted loading, WebGL loss, offline restart and invalid asset releases have tested recovery paths.
- Performance results identify hardware, browser, screen resolution, release versions and cache state. Targets are not reported as measured results.
- Updated runbook explains installation, startup, content publication, updates, backups and rollback.

Report completed stages and remaining gaps separately. If field verification or deployment hardware is unavailable, complete the software stages that can be verified and leave the affected routes/deployment checks explicitly pending. Do not claim full integration merely because the GLB renders.
