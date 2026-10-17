# Kiosk release-readiness review — 2026-10-17

The interface changes are implemented. This is a software QA record, not a declaration that the unverified building routes or public deployment have been approved.

## Implemented

- Canonical URLs with direct loads, refresh, browser Back/Forward, list restoration, invalid-link recovery and visitor-history reset.
- Premium City Hall cover on Home, with the existing search, offices and map actions.
- One responsive kiosk stylesheet, calmer text sizes, consistent buttons/cards and the supplied pattern background.
- Complete service requirements and process columns, with source/context in a disclosure and visible take-away/directions actions on landscape screens.
- Removed the kiosk Avoid stairs control. Existing step-free API/phone requests still fail safely when no verified route exists.
- Minimap beside the 3D viewport. Pause/Resume, Replay and Skip lead the sidebar; current instruction remains visible while scrolling it.
- Real search input, dialog focus containment/restoration, idle privacy reset, delayed-response cancellation, reduced-motion playback and cached-data fallback.
- Static JS/CSS/HTML revalidate; missing assets return 404 instead of an HTML app shell. Public pages no longer display default staff credentials. Existing passwords were not changed.

## Public page routes

| Page | URL |
|---|---|
| Home | `/kiosk` |
| Office directory | `/kiosk/offices` |
| Individual office | `/kiosk/offices/:id` |
| Service details | `/kiosk/services/:id` |
| Search | `/kiosk/search?q=...` |
| Results | `/kiosk/results?q=...&filter=services` |
| Building map | `/kiosk/map?floor=1` |
| Directions | `/kiosk/directions?office=:id` |
| Off-site/unconfirmed office | `/kiosk/offsite/:id` |

Directions also accept `room`, or a staff-preview `door`, plus an optional `service` ID. Existing `?screen=...&id=...` and `/kiosk/landscape` links continue to work and normalize to the canonical URLs. Kiosk origin, preview and explicit layout settings survive navigation. Phone URLs (`/m/service/:id`) and admin routes remain separate.

For the owner's local presentation, the Home map button on port 3000 (while navigation is unpublished) redirects to the real-model preview on port 3100 with `kiosk=PILOT-ENTRANCE&preview=1`. Normal demo Home also selects this preview. Both entry paths and repeat Home → Map were verified in the browser with the model canvas visible and no JavaScript errors. Keep the demo server running for this bridge; production navigation publication remains a launch gate.

## Validation

- Unit/API suite: 41 tests passed, including two new URL tests. Covers search, services, roles, office moves, approval, planner constraints, calibration, model integrity and walk geometry.
- Browser results: all 22 cases have passing results. The final full run passed 20 cases and identified two test-harness issues. The resource check was changed from an arbitrary 400ms sample to the same paused/rendered pose; the admin test now enters the email explicitly after removing the prefilled account. A focused rerun passed both corrected cases and their calibration prerequisite. Resource thresholds were not relaxed.
- Existing 15 browser cases cover real 3D loading, missing/corrupt asset fallback, context loss, model/context reuse, floor/minimap synchronization, office relocation, QR/phone handoff and admin assignment.
- Seven new release cases cover canonical navigation, refresh and history reset; physical search typing and late response cancellation; QR focus trap and Escape; idle continuation/reset; responsive accessibility; reduced-motion 3D and minimap separation; offline cached search and HTTP asset behavior.
- Live port 3000 smoke check passed Home → Offices → Office → Service with no JavaScript errors. JS response headers confirm `no-cache` revalidation.
- Automated axe scans: 40 page/viewport combinations, 15 enlarged-text/language combinations, plus QR and 3D navigation. No reported violations in the configured WCAG A/AA and best-practice rules.
- Viewports: 1366×768, 1920×1080, 1080×1920, 390×844, and 683×384 (the CSS viewport equivalent of 200% on 1366×768). This last test is reflow coverage, not a physical browser/OS zoom certification.
- Screenshots: `.impeccable/review/final-*.png`. The real model, unobstructed minimap, visible map controls and laptop/phone service layout were visually inspected.
- Browser tests use isolated temporary databases. Demo 3100 uses a copy. The live database was not reset or reseeded; no navigation publication or verification was performed.

Run from `server/` in PowerShell:

```powershell
npm.cmd test
npm.cmd run test:e2e
```

The release suite alone: `node --test test/e2e/release-readiness.e2e.mjs`.

## Gates before public launch

- [ ] Staff verify office↔door matches, kiosk position/heading, calibration anchors, routes, floor heights and any accessibility connections. Publish only verified navigation. The live database currently has no publication; its fallback is a labelled sample map. The real 3D pilot remains a labelled staff preview on port 3100.
- [ ] Decide and verify third-floor coverage; extend beyond the four pilot routes. Do not infer missing geometry or accessible connections.
- [ ] Review current Charter information and approve plain-language drafts. Native speakers review Filipino and Cebuano. Opening status uses Manila time and configured weekday hours; holidays and exceptional office closures still need an operational policy.
- [ ] Replace seeded/default credentials for every staff account; confirm staff roles and production host/network access. Removing public hints does not secure unchanged default accounts.
- [ ] Configure and test `PUBLIC_BASE_URL` from an actual visitor phone. Use the production address and deployment transport appropriate to the installation.
- [ ] Test on the installed touchscreen/GPU, including long-running playback, scrolling, touch accuracy, glare, reach, OS/browser zoom and screen-reader use. Test the real printer and QR handoff.
- [ ] Conduct observed usability sessions with residents, including older visitors and people with disabilities. The automated journeys and expert walkthrough are not participant usability testing or an accessibility certification.
- [ ] Configure the Windows service, backup/restore, restart/recovery, update/rollback and offline operational procedure. Cached data works when the API fails but static assets are available; a cold start with the entire server unavailable is not a fully offline application.

See `HANDOFF.md` for the living checklist and exact continuation state.
