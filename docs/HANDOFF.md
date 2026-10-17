# Malaybalay City Hall Kiosk: handoff

**Start here.** This is the single source of truth for any Codex or Claude session. Read only this file first; open other files only when a task needs them.

**Keep it current:**

- Update it after every finished task.
- Update it before stopping, and when about 70% of your context or usage is spent.
- Edit the **Status** and **In progress** sections in place; do not append a diary.

## Snapshot

| | |
|---|---|
| Updated | 2026-10-16, by Codex |
| Repo | `Desktop\cityhallkiosk_codex\City Hall Code\cityhallkiosk`, GitHub `LorenPacuribot/cityhallkiosk` (this repo uses the LorenPacuribot account) |
| Branch | `codex/3d-building-r09` (not merged to `main`) |
| Last commit | `9c1c61a`. Work after it is uncommitted; see **In progress**. |
| Tests | `npm test`: 39/39 pass. `npm run test:e2e`: 15/15 pass. `node test/e2e/pilot-routes.mjs` (portrait and landscape): pass, no errors. All run after the changes below. |
| Live database | `server/data/kiosk.sqlite`. Never reset or reseed it. Nothing is published, and the navigation tables are not created yet: the first start of the new server adds them, so **back it up first**. |

## The three folders

| Folder | What it is |
|---|---|
| `Desktop\cityhallkiosk_codex\City Hall Code\cityhallkiosk` | **The app.** Node/Express server, sql.js database, web kiosk, admin, phone page. |
| `Documents\ChatGPT\CityHallKiosk_Codex` | **Model workspace.** Blender revisions 01–09. The web build reads `web_source_r09\` (see its `README.md`). Unity was removed on 2026-10-16; see `web_source_r09\CLEANUP_LOG.txt`. |
| `Desktop\cityhallkiosk_codex\cityhallkiosk_codex` | Old setup notes from 12 October (the Blender + MCP idea). **Obsolete**; points here. |

Product brief (users, purpose, principles, brand rules): [`PRODUCT.md`](../PRODUCT.md). Read it before any design work.

## Decisions (do not re-open without the owner)

- **No Unity.** The web kiosk shows the real model with three.js (installed 0.160.0, local loaders, import map in `kiosk/index.html`).
- **No exterior view.** The welcome photo shows the outside. The release still contains `scenery.glb`, but the kiosk never loads it.
- **Navigation is a first-person walk.** It starts at the entrance and ends facing the office door. A floor ribbon with moving arrows leads to the door, which has a ring, a pin and a name tag. A walking character with a follow camera is planned (`RoutePlayer.setAvatar` hook).
- **One shared planner** (`shared/nav-graph.js`) for the server, kiosk and phone.
- **Never invent data.** Office↔door mappings, positions and accessible links stay explicitly unverified until checked on site:
  - A step-free request never uses stairs.
  - A failed route never draws a line.
  - Draft routes show only in staff preview (server switch plus `?preview=1`), with a banner.
- The **lighting bake is final**; do not rebake unless geometry changes.
- **Blender runs only through the memory-guarded launchers.** In this repo that is `tools/model/run-blender.mjs`; in the model workspace, `scripts/run_front_blender.py`. Both need 2.35 GiB free to start and stop below 1 GiB. Do not close the user's apps.

## Status

### Working (tested)

- **Model release r09-web02** (gitignored, 73.6 MB) at `server/public/models/cityhall/r09-web02/`:
  - 463 objects and 183,170 triangles, matching the source inventory;
  - every file hash-checked;
  - colour-grading LUT parity with Blender: mean error 0.19, maximum 4.
- **Real floor plans** at `server/public/models/plans/r09-web02/`: a section cut at 1.3 m, made with `tools/model/render-plans.mjs`.
- **First-person walk.** Code: `shared/walk-path.js`, `kiosk/three/route-player.js`, `camera-controller.js`.
- **Minimap.** It follows the walker on the real plan, switches floors on the stairs, and has "Follow my position".
- **Map screen.** It shows the 1st or 2nd floor in 3D (`kiosk/three/floor-view.js`) with zoom, rotate and reset, plus a 2D plan toggle.
- **Admin:**
  - Navigation page: map doors, mark segments checked, close segments, publish and roll back.
  - Room assignment with move, share, replace and swap.
  - Reference plans (ground, 2nd, 3rd floor and roof) under `admin/reference-plans/`.
- **Four pilot routes** (drafts) from the entrance. The door↔office matches were read from the supplied plans and are still drafts (`server/data/navigation/r09-plan-assignments.json`):

  | Door | Office | Location |
  |---|---|---|
  | R1-W002-D108 | CSWDO | ground floor, left |
  | R1-W038-D133 | Assessor | ground floor, right |
  | R2-W032-D210 | Planning | 2nd floor, left |
  | R2-W057-D229 | Accounting | 2nd floor, right |

- **Fallbacks:** a 2D map on any 3D failure (missing or damaged files, lost graphics); a QR code to the phone that keeps the kiosk and preference; a printed slip.

### Done this session (2026-10-16), not committed

1. **Unity removed**, and nothing broke:
   - Deleted the repo's `unity/` folder and the `/admin/rooms/sync-from-unity` endpoint and its test.
   - The database value `coord_source='unity_sync'` stays allowed, labelled "Imported".
   - Model workspace: Unity deliverables deleted and build inputs renamed; see `web_source_r09\CLEANUP_LOG.txt`.
   - All 28 inventory files were re-verified by SHA-256 at their new paths.
   - The remaining `UNITY_*` names are scene names inside the .blend; they keep their original names.
2. **Destination name tag:**
   - The text wraps instead of being cut (`kiosk/three/label.js`).
   - Doorway routes are named after the office in that room.
   - Placeholder names like "Room 2F-R210" are dropped.
3. **End of the walk:**
   - The floor line ends in the door ring, with no arrows inside the ring.
   - The walk stops 2.6 m from the door, on the route (`WALK_DEFAULTS.doorStandOff`).
   - The gaze lifts to the door (`pose.doorBlend`).
   - The door instruction shows on arrival.
4. **Minimap:**
   - Larger: 400 px wide, or 420 px in landscape.
   - Smaller markers when zoomed.
   - The walker is navy; the door is a terracotta ring.
5. **Map screen:**
   - Mapped offices are labelled in 3D (HTML buttons over the canvas, `.floor-label`) and on the 2D plan.
   - **Tapping an office starts its route.**
   - The office list shows the room code and "draft" for mapped offices, else "Not on the map yet".
   - The camera is more top-down (62°).
6. **Plan rule, everywhere:**
   - Real plans and the 3D floor map are used only for the published calibration.
   - While that calibration is a draft, only in staff preview (`usablePlan` and `calibrationOK` in `kiosk/app.js`).
   - The phone page (`m/app.js`) uses the same rule.
7. **Docs:**
   - This handoff, `AGENTS.md` and `CLAUDE.md` are new; `NEXT_STEPS.md` was removed (merged here).
   - The old Codex notes point here.

8. **Critique.** `/impeccable critique kiosk` scored 25/40 (saved in `.impeccable/critique/`). The owner chose all 5 priority issues, a civic wayfinding look, and one step at a time:
   1. **shape: service browse** — done (see 9);
   2. layout: service page;
   3. harden: reset bug and dead ends;
   4. distill: navigation screen;
   5. clarify: floor and room names, "You are here", Cebuano leftovers;
   6. document, then colorize and typeset (civic look);
   7. polish.
9. **"Find a service" browse (done):**
   - **Home keeps its three cards** (owner's decision, 2026-10-17):
     - **Find a service** opens search, as before;
     - **Browse offices** opens the office list, now grouped by floor (walking order, then "location to be confirmed", then off-site);
     - **Map of City Hall**, as before.

     Do not merge or replace these cards.
   - **Rows:**
     - each office row shows "Helps with: …";
     - each service row shows "For people who…";
     - Back restores the list position;
     - landscape shows the chosen office in a side panel.
   - **All 276 Charter services now reach the kiosk** (owner's decision): `is_citizen_facing` only sorts services under "For other government offices", and "Most searched" stays public-only.
   - **Plain-language lines:**
     - Stored in the new `plain_summaries` table (migration `2026-10-17-001`).
     - Edited in the new **Admin → Plain language** page (`routes/plain-admin.js`): office editors propose for their own office; LGU admins approve or reject.
     - Only approved text reaches the kiosk bundle (`summary: {en, fil, ceb}`); the kiosk falls back to English.
     - The Charter text is never changed.
   - **Prepared drafts:** English drafts for all 26 offices and 276 services are in `server/data/plain-summaries-draft.json`. **Load them** with **Admin → Plain language → Load prepared drafts**. **None is approved on the live database yet.** The demo server loads them as drafts.
   - **Tests:** `test/plain.test.js` and one e2e test.

### In progress

- 3D map diagnosis: port 3000 uses the live database with no navigation publication. The configured model is on demo port 3100, with kiosk=PILOT-ENTRANCE and preview=1. Verified the real 3D map loads with zero browser errors; screenshot in .impeccable/review/restored-3d-map.png. The current office redesign is served there too. Live database was not changed.

- Owner confirmed separate office directory and individual office pages. Browse offices now uses a full-width floor-grouped directory, two columns in landscape, and every row opens the individual reference-styled office page. This supersedes the former landscape side-panel decision. Filters and Back remain available. Asset revision bumped. Landscape/portrait browser smoke verified directory ? office ? Back; screenshots in `.impeccable/review/*-directory.png`.

- Owner requested stopping EstimateMaster: verified PID 15964 belongs to EstimateMasterApp-main and stopped only that process.

- Follow-up: HTTP checks confirm localhost:3000 serves redesigned kiosk assets, but 127.0.0.1:3000 serves unrelated EstimateMaster HTML (competing IPv4 listener). Added versioned kiosk CSS/JS URLs and translated View office details action in landscape browse panel. Syntax check passed. Use localhost for kiosk preview.

- Office and service detail redesign is complete, uncommitted. Matches the supplied blue civic references: scoped header/chrome, office information and service rows, service summary cards, requirements and process panels, and fixed QR/directions dock. Portrait places steps before feedback/context. Actual Charter text, office locations and navigation rules are preserved; live database untouched.
- Verification: 39/39 unit/API and 15/15 browser tests pass; landscape and portrait screenshots in `.impeccable/review/`. QR, feedback and larger text smoke checks pass. Browser fixtures log missing optional `plans/fx-test01/plans.json` 404s but all tests pass. Independent visual review: ship after portrait ordering fix.
- Design decisions documented in `DESIGN.md` and `.impeccable/design.json`.

### Known small issues

- In landscape, the minimap can briefly cover the name tag while the view turns to the door.
- On the map screen the 3D building is wide and short, so there is empty space above and below it in portrait.

## Next (in order)

- Review the model at http://localhost:3100/kiosk/landscape?kiosk=PILOT-ENTRANCE&preview=1&screen=map. Use npm run demo if the demo server is stopped. Live navigation setup remains a separate task.

- EstimateMaster process PID 15964 stopped at owner request; recheck kiosk listener when starting npm start.

- Review the separate office directory and individual office pages; next prior critique item is reset/dead-end hardening. No commit or push without owner request.

1. **Match each in-building office (15 in the live database) to its model door.**
   - Use the reference plans in the admin.
   - Staff confirm each match.
   - `docs/3d-integration/LEGACY_LOCATIONS.md` holds the 2024 office/room list. Its coordinates are in an unknown frame; don't use them for positions.
2. **Extend the walking graph to every public door.** Today it is 24 nodes and 24 edges, covering only the pilot corridors. Rebuild with `tools/model/pilot-graph.mjs` and its successor.
3. **Decide on the 3rd floor.** It is in the database and the plans, but not in the routes.
4. **Site checks:**
   - kiosk position and heading;
   - four calibration anchors;
   - the 2nd-floor height (model 4.0 m, database 4.2 m);
   - walk every route;
   - lift and ramps;
   - which segments are step-free.
5. **Go live:** back up the database, then `npm start`, then in Admin → Navigation import, register r09-web02 and publish.
6. **Production:**
   - performance on the real kiosk hardware;
   - offline release update and rollback;
   - a Windows service;
   - a printer test;
   - native-speaker review of the Filipino and Cebuano text.

## How to run and check

From `server/`:

| Command | What it does |
|---|---|
| `npm start` | Live server at `http://localhost:3000` (`/kiosk`, `/kiosk/landscape`, `/admin`, `/m`) |
| `node test/e2e/demo-server.mjs` | Demo on a copy of the database, port 3100. The pilot routes are at `/kiosk?kiosk=PILOT-ENTRANCE&preview=1&screen=map`. |
| `npm test` | Unit and API tests |
| `npm run test:e2e` | Headless Edge. **Run browser tools from PowerShell**: the Bash sandbox cannot launch Edge. |
| `node test/e2e/pilot-routes.mjs` | Screenshots to `test-results/pilot/` (add `--layout landscape`) |

Model rebuilds (rarely needed), from the repo root:

- export: `node tools/model/run-blender.mjs tools/model/export_cityhall_web.py -- <web_source_r09>/09_Baked_Optimized.blend <sha> <staging>`;
- then `node tools/model/build-release.mjs <staging>`;
- then `node tools/model/render-plans.mjs --force`.

Details: `docs/3d-integration/IMPLEMENTATION_STATUS.md`.

## Gotchas

- **Line endings.** Many files have CRLF line endings. Scripted edits must normalise `\r\n`, or they silently fail to match.
- **The source `.blend`'s front camera is broken.** Its stored camera matrix is identity. `export_cityhall_web.py` corrects it in the release only; the exterior is unused anyway.
- **The live database is never touched by tests.** Tests, demos and tools use temporary copies (`KIOSK_DB`, `KIOSK_MODELS_ROOT`).
- **Plans and 3D drafts depend on the calibration.** The plan images and draft 3D views are drawn with draft calibration `r09-cal-draft-1`. If the calibration changes, re-render the plans.
