---
target: kiosk
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:C:\\Users\\Administrator\\Desktop\\cityhallkiosk_codex\\City Hall Code\\cityhallkiosk\\server\\public\\kiosk\\index.html"
target_fingerprint: "sha256:a3b39a25a9c6514aeb81ce176c593ed8199946daa8fac01f32e8afd8cb663765"
target_path: "C:\\Users\\Administrator\\Desktop\\cityhallkiosk_codex\\City Hall Code\\cityhallkiosk\\server\\public\\kiosk\\index.html"
timestamp: 2026-10-17T01-07-25Z
slug: server-public-kiosk-index-html
---
Method: dual-agent (A: design review sub-agent · B: detector and browser evidence sub-agent)

# Kiosk critique: Malaybalay City Hall (server/public/kiosk)

## Design health score: 25/40 (Acceptable)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | The map labels the origin "Route start", not "You are here". |
| 2 | Match system / real world | 2 | "1st floor · GF-R108"; map acronyms (CSWDO, CASSO); "walk 1 m"; statute titles. |
| 3 | User control and freedom | 3 | "Avoid stairs" survives the privacy reset; the QR sheet has both "Done" and "Close". |
| 4 | Consistency and standards | 2 | Home button on the Home screen; "Find a service" is the same keyboard; Cebuano leaks English; kiosk checkboxes do nothing. |
| 5 | Error prevention | 2 | "Avoid stairs" on a flat route leads to "Directions not available". |
| 6 | Recognition rather than recall | 2 | No category browse for 276 services. |
| 7 | Flexibility and efficiency | 3 | Suggestions, Cebuano search and the phone handoff work well. |
| 8 | Aesthetic and minimalist design | 2 | Charter wall of text; 11 controls on the navigation screen. |
| 9 | Error recovery | 3 | The no-route screen's main action, "Back to Home", throws away progress. |
| 10 | Help and documentation | 3 | Excellent help bar; the "Complex" and "Highly Technical" badges are never explained. |

## Design specificity

The behaviour is built for this product: verbatim Charter, honesty labels, the real-building walk, the door plate on arrival. The visual skin is generic fintech/SaaS: gradient banner, white cards, gradient icon tiles, pills, glass clock and Plus Jakarta Sans. Nothing echoes the building's terracotta roof, its door plates and signs, or the Charter's table format.

Detector:
- overused-font, Plus Jakarta Sans, at 100% of text (confirmed);
- dark-glow ×2 and border-accent-on-rounded at kiosk.css:468 are false positives;
- side-tab at kiosk.css:153 is borderline.

## Priority issues

- **[P1] "Avoid stairs" (S.prefs.stepFree) and the language survive resetToWelcome (app.js:619).** Later visitors get "Directions not available". Fix: reset prefs and language on reset. Command: harden.
- **[P1] No way to browse services; "Find a service" is the search keyboard.** Fix: a life-event browse with ≤6 tiles per level, then a plain list with "for people who…" subtitles. Command: shape.
- **[P1] The service page is a wall of Charter text with fake checkboxes.**
  - Fix:
    - group circumstances under tappable headings;
    - remove or wire up the kiosk checkboxes;
    - full-width "Who may apply";
    - a verification badge next to the title.
  - Command: layout, then clarify.
- **[P2] The navigation screen has 11 controls; the step-free outcome punishes the visitor.**
  - Fix:
    - large current instruction in portrait;
    - Replay and End visible, the rest behind "More";
    - hide the minimap in 2D;
    - step-free icon;
    - "This route has no stairs".
  - Command: distill.
- **[P2] Contradictory floor and room vocabulary; no "You are here".** Fix: one floor vocabulary, localized "You are here", full office names on the map. Command: clarify.

## Persona red flags

- **Jordan:**
  - keyboard instead of browse;
  - 8 near-identical BIRTH titles;
  - unexplained "Complex" badge;
  - internal services (Pre-Audit) in "Most searched";
  - QR caption "· 12 · 5";
  - the draft banner on every route.
- **Sam:**
  - "Avoid stairs" blocks the route, and the setting sticks;
  - 22 px captions;
  - gesture-first map;
  - no high-contrast mode;
  - top controls out of reach from a wheelchair.
- **Lola Remedios (72, Cebuano):**
  - Charter content stays in English with no note;
  - "Home", "Space" and "Delete" untranslated;
  - QWERTY-first;
  - printing hidden inside the QR sheet;
  - the 60 s idle timer interrupts slow readers.

## Minor observations

- Empty search area before typing.
- Cut-off placeholder.
- Faded landscape list.
- "fee: None" casing.
- Gloss the processing time.
- Draft-banner wording.
- No handoff on the arrival screen.
- Dead end for "Location to be confirmed".
- 422 error on the phone page.

## Questions

1. A staff-approved plain-language layer over the verbatim Charter?
2. Ship the 3D walk before any route is verified?
3. A visual language from the building's own signage?
