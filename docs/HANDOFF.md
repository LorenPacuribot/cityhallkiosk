# Malaybalay City Hall Kiosk: handoff

**Start here.** This is the single source of truth for any Codex or Claude session. Read only this file first; open other files only when a task needs them.

**Keep it current:**

- Update it after every finished task.
- Update it before stopping, and when about 70% of your context or usage is spent.
- Edit the **Status** and **In progress** sections in place; do not append a diary.

## Snapshot

| | |
|---|---|
| Updated | 2026-10-17, by Claude (after Codex's release-readiness pass) |
| Repo | `Desktop\cityhallkiosk_codex\City Hall Code\cityhallkiosk`, GitHub `LorenPacuribot/cityhallkiosk` (this repo uses the LorenPacuribot account) |
| Branch | `codex/3d-building-r09` (not merged to `main`) |
| Last commit | `85ce67f`. Release-readiness changes after it are uncommitted. No commit/push requested. |
| Tests | 62/62 unit/API and 23/23 browser cases pass (incl. axe scans) after the office-logo change. The geometry-count test allows ±2 because building geometry uploads lazily (measured 15/16/16/16/16/12 per route); a leaked route adds ≥4. |
| Cover and header | Owner's mockups (2026-10-17): `/` shows the **cover** (photo `img/cityhall-cover-2026.jpg`, the owner's render from 2026-10-17, 2560×1440 JPEG from the 3360×1890 original; zoomed toward the building in landscape; navy fade, seal, clock + open status, greeting, "Welcome to Malaybalay City Hall", Touch to start, languages). Touch to start opens **home**: City Hall gradient band with "What do you need today?", search bar across its edge, the 3 cards (Find a service / Browse offices / Map of City Hall), Most searched (2 columns on wide screens). Every screen's header uses the same **global header**: navy-to-blue gradient with the City Hall render faded in from the right (`pageHead()` in `kiosk/app.js`, `.page-head` in `kiosk.css`). Home button → home; the City Hall logo (top-left) → cover; idle privacy reset → cover. Both cover routes clear the visitor's state. **Search page** (owner, 2026-10-17): one full-width column — big search bar, related suggestions (up to 6, two columns wide), "Your recent searches" (this visitor's own only, cleared at the privacy reset; "Try searching for" common terms before any search; hidden while typing), full-width keyboard kept at the bottom. |
| Live database | `server/data/kiosk.sqlite`. Never reset or reseed it. Navigation tables exist, with no live navigation publication. Back up before live navigation setup. |
| Map button | Owner requested that Map of City Hall open the real model. On local port 3000 without a navigation publication, it redirects to port 3100 `/kiosk/map?kiosk=PILOT-ENTRANCE&preview=1`. Normal demo Home does the same. Both servers must run for this presentation setup. |
| Background | Owner's bg.png is now shown at original visibility across kiosk screens; removed the white wash. Source and asset SHA-256 match. Home/service laptop and phone screenshots and four contrast scans passed. |
| Office logos | Owner, 2026-10-17: office rows (directory + search results) show each office's Citizen's Charter logo; offices without one show the city seal. Source set: `DocumentsChatGPTCityHallKiosk_CodexoutputMalaybalay Office Logos` (mapping CSV), resized to 256 px in `server/public/img/office-logos/`. Map by short_name in `src/lib/office-logos.js`. Migration `2026-10-17-002-office-logos` added `offices.has_logo` / `logo_file`; **has_logo = 0** for CMO, BPLD, OSCA, OBO, CSWDO, CHO (Charter shows only the city seal) and MIS, PMES (not in Charter). API gives `logo_url` (null when has_logo = 0). Applied to the live DB on 2026-10-17 (backup `data/backups/kiosk-20261017-142925-before-office-logos.sqlite`); both servers restarted. Office detail page and phone page do not show logos yet. |
| Arrival map | Owner, 2026-10-17: "You've arrived" shows the 2D floor map instead of the door drawing: `arrivalSVG()` in `shared/route-map.js`, used by `arrivalMap()` in `kiosk/app.js`. Zoomed ~60 m around the office door on the destination floor, faint dotted route, pulsing terracotta halo at the door (no pulse under reduced motion), navy callout with office name + "Room N · floor". **No room outline is drawn**: no verified room geometry exists, so the room is marked at its real doorway. Same plan rule (`usablePlan`); without a graph route it falls back to the door drawing. Screenshots: `.impeccable/review/arrival-map-*.png`. Phone page unchanged. |

## The three folders

| Folder | What it is |
|---|---|
| `Desktop\cityhallkiosk_codex\City Hall Code\cityhallkiosk` | **The app.** Node/Express server, sql.js database, web kiosk, admin, phone page. |
| `Documents\ChatGPT\CityHallKiosk_Codex` | **Model workspace.** Blender revisions 01–09. The web build reads `web_source_r09\` (see its `README.md`). Unity was removed on 2026-10-16; see `web_source_r09\CLEANUP_LOG.txt`. |
| `Desktop\cityhallkiosk_codex\cityhallkiosk_codex` | Old setup notes from 12 October (the Blender + MCP idea). **Obsolete**; points here. |

Product brief (users, purpose, principles, brand rules): [`PRODUCT.md`](../PRODUCT.md). Read it before any design work.

## Decisions (do not re-open without the owner)

- **Screen flow and header (owner, 2026-10-17):** cover first, then home with search + the three cards + Most searched; one global gradient + City Hall header on every page; the office page layout (info card + Show me the way left, services right) is the owner's chosen layout. Keep the background pattern under content.

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
- **Owner's room guide (2026-10-17)** is the source of truth for which office is in which numbered room: `server/data/navigation/r09-room-guide.json`. It replaces `r09-plan-assignments.json`.

  **What it holds:**
  - Rooms 1–17.
  - The offices in them. The City Assessors Office is in Rooms 3 and 4; Room 4 is recorded as an additional, non-primary location.
  - Each room's doorways. These were matched by placing the 27 signed model doorways on the rendered floor plans; **door matches are drafts**.

  **How it is used:**
  - `tools/model/pilot-graph.mjs` reads it. The draft graph `r09-nav-draft-3` (66 nodes, 67 edges) gives **all 24 guide doorways a route**. Corridor chains run along each wing, plus a 2F walkway north of the atrium. Every route passes `walk-clearance.test.js`.
  - `src/lib/plan-reference-rooms.js` → `applyPlanReferenceRooms(graph)` creates "Room N" rooms, moves the offices (with history and audit), and links doorways and signs as **draft**. It is idempotent.
  - The demo server applies it.
  - **Applied to the live database on 2026-10-17** with `node tools/apply-room-guide.mjs`.
    - It stopped the server first and wrote a backup: `server/data/backups/kiosk-20261017-180536-before-room-guide.sqlite`.
    - The graph revision `r09-nav-draft-3` was imported but **not published**.

  **Behaviour:**
  - Signs show draft mappings only in staff preview (`preview=1` plus the server switch). On the public kiosk they show only after staff verify them in Admin → Navigation.
  - A room with several doors routes to the door nearest the kiosk (`doorForRoom`).

  **Open questions for the owner:**
  - Owner decisions:
    - MIS (Room 10.2) and PMES (Room 14) were **added as offices**.
    - Civil Registrar, General Services and HRMO are now **location unconfirmed**.
  - Rooms 12 and 17 have no office.
  - Doorways D166, D171 and D216 are not in the guide.
  - Vice Mayor, Building Official, Senior Citizens and PESO were already location unconfirmed.

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
     - every office opens its own detail page in landscape and portrait (owner confirmed).
   - **All 276 Charter services now reach the kiosk** (owner's decision): `is_citizen_facing` only sorts services under "For other government offices", and "Most searched" stays public-only.
   - **Plain-language lines:**
     - Stored in the new `plain_summaries` table (migration `2026-10-17-001`).
     - Edited in the new **Admin → Plain language** page (`routes/plain-admin.js`): office editors propose for their own office; LGU admins approve or reject.
     - Only approved text reaches the kiosk bundle (`summary: {en, fil, ceb}`); the kiosk falls back to English.
     - The Charter text is never changed.
   - **Prepared drafts:** English drafts for all 26 offices and 276 services are in `server/data/plain-summaries-draft.json`. **Load them** with **Admin → Plain language → Load prepared drafts**. **None is approved on the live database yet.** The demo server loads them as drafts.
   - **Tests:** `test/plain.test.js` and one e2e test.
- **Destination labels name the office, not "Room N" (owner, 2026-10-17):** 3D beacon (`route-player.js`), route-map door label (`route-map.js`, kiosk + phone), arrival door illustration and `arrived_body`. "Room N" stays on door signs, office pages and the route info line. Phone page no longer prints "Room Room N" (`roomLabel` in `m/app.js`). Arrival check icon centred.

### In progress

**Software pass completed: public deployment readiness (owner's eight-point request).** The checklist below records verified completion. Remaining work is the public-launch gates under **Next** and `RELEASE_QA.md`. Current implementation is uncommitted. The owner explicitly wants these checklists kept current so another AI account can resume.

### Release-readiness plan and completion checklist

- [x] Record the implementation plan and exact continuation instructions here.
- [x] Finalize canonical page URLs, legacy links, direct-load/refresh, browser Back/Forward, invalid links, and history reset. Two route unit tests and browser history journey pass.
- [x] Make the premium City Hall photo cover the home page, keeping the three existing actions. Visual and journey checks pass.
- [x] Replace scaled fixed canvas with responsive spacing/type at 1366x768, 1920x1080, portrait, phone and zoom. Responsive tests pass, including 683x384 reflow and all-language enlarged text.
- [x] Unify header, page bands, cards, buttons, typography and supplied pattern background. Screenshots and accessibility scans checked.
- [x] Reapply the owner's bg.png at original visibility, without the white overlay. CSS cache revision bumped. Verified Home/service at 1366x768 and 390x844; contrast scans found no violations. Evidence: `.impeccable/review/background-original-*.png`. Keep this appearance when continuing other tasks.
- [x] Improve landscape service details while retaining all Charter requirements, steps, fees, sources and QR actions. Long Charter text wraps, source/context expands, narrow screens scroll as one page.
- [x] Remove Avoid stairs controls from kiosk UI; retain safe planner behavior for existing step-free API/phone requests. Browser regression and API checks pass.
- [x] Move minimap beside the 3D viewport; floor switching, playback, fallback and no-overlap checks pass.
- [x] Connect Home's Map of City Hall button to the real-model preview. Verified from both port 3000 and normal port 3100, including Home → Map again. This is a local presentation bridge; once live navigation is published, port 3000 uses its own map. Draft verification was not changed.
- [x] Harden search, dialogs, keyboard focus, idle reset, offline behavior and reduced motion. Seven new release journey tests pass, including delayed search cancellation, modal focus, idle continuation/reset and cached offline search.
- [x] Run unit/API and browser regression suites on isolated databases; add route and accessibility checks. 41 unit/API and all 22 browser cases pass; see Snapshot for the focused rerun detail.
- [x] Inspect actual responsive screenshots; map clipping fixed and real-model confirmation saved in `.impeccable/review/final-*.png`.
- [x] Update DESIGN.md and a release QA report with evidence, commands and remaining public-launch blockers. See `docs/RELEASE_QA.md`.

**Resume here:** do not restart the redesign. Read `RELEASE_QA.md` and work through the unchecked public-launch gates below. Live kiosk is running at `http://localhost:3000/kiosk` (tool session 9338; start `npm.cmd start` from server/ if it is no longer running). Real-model preview: `http://localhost:3100/kiosk/map?kiosk=PILOT-ENTRANCE&preview=1`. New release tests are in `server/test/e2e/release-readiness.e2e.mjs`; URL tests are in `server/test/kiosk-routes.test.js`. No test process remains running. No live DB reset, seed or navigation publication was performed. Current source and docs are uncommitted.

**Test harness corrections:** resource counts now compare the same paused pose after its rendered frame, replacing a timing-dependent 400ms sample of different visible meshes. The admin test now explicitly fills its email because the production-facing form no longer advertises a default account. These corrections retain the assertions; no resource thresholds were relaxed.

### Earlier completed work and environment

- Applied owner-supplied bg.png as the background on all kiosk content screens, behind opaque cards and controls. Asset: server/public/img/kiosk-background.png (unaltered copy). Welcome retains its City Hall photo. CSS asset revision bumped; landscape and portrait screenshots verified in .impeccable/review/background-*.png.

- Office directory and individual office/service pages are complete. Directory rows open individual office pages in both orientations. Reference styling and Charter content are preserved.
- Code cleanup is uncommitted: removed the unused landscape side-panel renderer, action, selection state, translations and CSS; split service rendering into named requirements, feedback, context and process helpers; moved section inline styles into CSS and normalized recent CSS formatting.
- Cleanup checks: syntax and whitespace checks pass; browser smoke passes directory -> office -> service -> QR -> Back in landscape and portrait; real 3D preview loads. Full browser regression suite: 15/15 pass. Existing optional fixture plan 404 logs remain.
- 3D configuration: port 3000 uses the live database, with no navigation publication. The real model is on demo port 3100 with kiosk=PILOT-ENTRANCE and preview=1. Current UI changes are also served there. Live database was not changed.
- EstimateMaster was stopped at the owner's request; its previous port 3000 conflict is resolved.
- Design decisions are in DESIGN.md and .impeccable/design.json; review screenshots are in .impeccable/review/.

### Remaining limitations

- Owner asked whether the Blender model was removed: verified it remains at `server/public/models/cityhall/r09-web02/building.glb` (17,217,428 bytes), with its manifest and renderer integration intact. Port 3000 still has no navigation publication; use the real-model preview URL above for the 3D building.
- The Home map button now opens that preview automatically for the local presentation. It depends on demo port 3100 being available; it is not a substitute for verified live navigation publication.

- The minimap overlap is fixed. It occupies a separate sidebar; playback controls lead that sidebar.
- On the map screen the 3D building is wide and short, so there is empty space above and below it in portrait.

## Next (in order)

Complete the site/data/hardware gates below before claiming public deployment readiness. They need real verification, not invented mappings or test fixtures. Mark each item done only when its evidence exists. No commit or push without owner request.

- Review the model at http://localhost:3100/kiosk/map?kiosk=PILOT-ENTRANCE&preview=1. Use `npm.cmd run demo` if the demo server is stopped. Live navigation setup remains a separate task.

- Reset/dead-end hardening and the requested UI consistency pass are done. Do not repeat them from the older critique list.

- [ ] **Match each in-building office (15 in the live database) to its model door.**
   - Use the reference plans in the admin.
   - Staff confirm each match.
   - `docs/3d-integration/LEGACY_LOCATIONS.md` holds the 2024 office/room list. Its coordinates are in an unknown frame; don't use them for positions.
- [ ] **Extend the walking graph to every public door.** Today it is 24 nodes and 24 edges, covering only the pilot corridors. Rebuild with `tools/model/pilot-graph.mjs` and its successor.
- [ ] **Decide on the 3rd floor.** It is in the database and the plans, but not in the routes.
- [ ] **Site checks:**
   - kiosk position and heading;
   - four calibration anchors;
   - the 2nd-floor height (model 4.0 m, database 4.2 m);
   - walk every route;
   - lift and ramps;
   - which segments are step-free.
- [ ] **Go live:** after staff verification, back up the database, then in Admin → Navigation import, register r09-web02 and publish. `npm.cmd start` serves the live app but does not itself publish navigation.
- [ ] **Production:**
   - performance on the real kiosk hardware;
   - offline release update and rollback;
   - a Windows service;
   - a printer test;
   - native-speaker review of the Filipino and Cebuano text.
- [ ] **Accounts and phone access:** replace default passwords for all seeded staff accounts, review roles, configure `PUBLIC_BASE_URL`, and test QR on an actual phone. Public default-credential hints were removed; passwords were not changed.
- [ ] **Resident usability and accessibility:** observe older visitors and people with disabilities using the installed kiosk; check touch reach, glare, screen reader and OS/browser zoom. Automated scans are not participant testing or certification.

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
