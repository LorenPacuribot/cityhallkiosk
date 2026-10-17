# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: walk-in residents at the Malaybalay City Hall lobby.** Many are visiting for the first time, are older, or are not confident with technology. They stand at the kiosk briefly, often in a busy lobby. Their job is to find the right office for what they need, learn what to bring and what it costs, and then get to that office.

**Secondary: LGU staff.** They use the admin panel to keep services, offices, room assignments, announcements and navigation routes accurate and approved.

**Also: the visitor's own phone.** After the kiosk, the visitor carries the requirements checklist and directions on their phone (QR code), or on a printed slip.

## Product Purpose

A self-service kiosk that answers the two questions every City Hall visitor has: *what do I need to bring?* and *where do I go?* It answers them from the city's official Citizen's Charter and live office locations.

Success for City Hall means, in no particular order:

- **Transparency / ARTA compliance.** The Citizen's Charter (steps, fees, processing times, person in charge) is publicly and accurately displayed, as the Anti-Red Tape Act requires.
- **Fewer wasted trips.** Visitors arrive at the office with complete requirements because they checked first and took the checklist with them.
- **Fewer info-desk queues.** Visitors answer "where do I go, what do I bring" themselves, so the information desk handles fewer basic questions.
- **A modern image for the city.** The kiosk presents a well-run, modern City Hall.

## Positioning

It is built on the city's own Citizen's Charter 2023, imported word for word, with every service's steps, fees and times, and on office locations that staff keep current. Directions are shown in the real City Hall building, as a first-person walk from the entrance to the office door.

Directions are honest by design:

- A route is shown only when it has been checked on site.
- Unverified routes are labelled drafts, for staff preview only.
- A request to avoid stairs never falls back to stairs.
- A failed route never draws a line.

## Operating Context

- **The kiosk:**
  - a touchscreen in the City Hall lobby, portrait 1080 × 1920 or landscape 1920 × 1080;
  - shared by strangers, so it resets to the welcome screen when left idle (privacy);
  - keeps working offline from its last downloaded data.
- **Visitor flow:** welcome → search, or browse services and offices → service details (requirements, steps, fees) → "Show me the way" (3D walk or 2D map) → arrival. The visitor can take the information along by QR code or printed slip.
- **Phone page (`/m`):** opened from the QR code. It holds a requirements checklist that stays on the phone, the steps, and directions from the kiosk that made the code.
- **Admin panel (`/admin`):**
  - roles and an approval flow;
  - office moves with history and room assignment;
  - floors and rooms;
  - navigation publishing and checking;
  - announcements, feedback, search insights and an audit log.
- **Office hours:** Monday to Friday, 8:00 AM to 5:00 PM by default (configurable). Holidays are not yet known to the kiosk.

## Capabilities and Constraints

**Capabilities:**

- 276 services from the Citizen's Charter 2023 and 26 offices: 15 in the building, 6 off-site and 5 unconfirmed.
- Three languages: English, Filipino (fil) and Cebuano (ceb), plus a "Larger text" mode.
- The real City Hall 3D model (Blender revision 09) in the browser, with 1st- and 2nd-floor maps and first-person routes.

**Constraints:**

- **Never fabricate:**
  - office↔door mappings, positions, accessible connections or route checks;
  - Charter wording, which is kept as published, including its errors.
- **Undecided:**
  - a 3rd floor exists in the database and plans but not in routes;
  - most office doors are not yet mapped;
  - kiosk hardware, printer and GPU are not yet specified;
  - holiday calendar.
- **Not yet reviewed:** the Filipino and Cebuano text needs native-speaker review.
- **Current status and next steps:** `docs/HANDOFF.md`.

## Brand Commitments

- **No official LGU style guide or brand rules exist yet.** The current look is the project's own choice, not a city mandate.
- **The City Hall cover image** (`server/public/img/cityhall-photo.jpg`) is an approved render, not a photograph.
- **The Malaybalay City seal** (`server/public/img/malaybalay-seal.jpg`) is in use. Official approval for its use has **not** been confirmed.

## Evidence on Hand

- Citizen's Charter 2023, parsed: `server/data/charter-2023.json`.
- Updated floor plans (ground, 2nd and 3rd floors, roof deck): `server/public/admin/reference-plans/`.
- Historical office/room list (2024): `docs/3d-integration/LEGACY_LOCATIONS.md`.
- The 3D model release and real floor-plan images: `server/public/models/`.

**No usage data, visitor testimonials, satisfaction figures or performance benchmarks exist.** None may be invented.

## Product Principles

1. **Answer the visitor's question in the fewest touches.** Find, then requirements, then the way there.
2. **Official and honest over impressive.** Show the Charter as published. Label anything unchecked. Never guess a location or a route.
3. **Built for the least confident visitor.** First-timers, older people and low tech confidence: plain words, large targets, three languages, nothing hidden behind gestures.
4. **Take it with you.** Every answer can leave the kiosk on the visitor's phone or on paper.
5. **Staff can keep it true.** Every fact a visitor sees can be corrected by staff in the admin panel, with history and approvals.

## Accessibility & Inclusion

**Known needs:**

- older and low-literacy visitors;
- three languages;
- standing use at a public touchscreen;
- a "Larger text" mode;
- step-free route requests that must never fall back to stairs.

**Undecided:** no formal standard (for example, WCAG 2.1 AA) has been mandated.
