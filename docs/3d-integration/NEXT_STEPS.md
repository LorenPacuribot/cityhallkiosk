# What needs to be done next

Status on 16 October 2026. Branch `codex/3d-building-r09`, last commit `b227227`.

This report covers work in three places:

- **Kiosk app:** `Desktop\cityhallkiosk_codex\City Hall Code\cityhallkiosk`.
- **Model workspace:** `Documents\ChatGPT\CityHallKiosk_Codex`. This holds Blender revision 09 and the Unity package.
- **Old Codex setup repo:** `Desktop\cityhallkiosk_codex\cityhallkiosk_codex`. Its notes are from 12 October and are out of date (see section 5).

## 1. Where things stand

| Check | Result |
|---|---|
| Unit and API tests (`npm test`) | **36 / 36 pass** |
| Browser tests in Edge (`npm run test:e2e`) | **14 / 14 pass** |
| Four pilot routes played through the kiosk screen | **4 / 4 play, no errors**, all labelled "Draft route" |
| Live database | Unchanged. Nothing is published, and the new navigation tables are not created yet. |
| Codex's latest work | **Not committed:** 23 files changed and 9 new files |

## 2. Your four requests

| # | Request | Status | What is left |
|---|---|---|---|
| 1 | Drop the exterior | **Done.** The kiosk no longer loads the outdoor scenery, and the front camera view is gone from the checks. The original model files are untouched. | Nothing |
| 2 | First-person walk with a line to the office door | **Done, needs polish.** The walk starts just inside the main entrance and follows the route. It climbs the real stairs and turns at each landing, then stops facing the door. A blue floor line with moving arrows leads to the door, which is marked by a ring, a pin and a name tag. Directions highlight in step. | • The name tag is cut off ("2nd floor, left wing — doorway R2…").<br>• The end of the line overlaps the door ring and leaves a white patch.<br>• A character with a follow camera is not started. A hook for the character exists. |
| 3 | Minimap works | **Done, needs polish.** It shows the real floor plan, follows the walker with a direction arrow and switches floors on the stairs. The floor buttons and "Follow my position" work. | • It is small.<br>• At the destination the start, stairs and door markers pile on top of each other. |
| 4 | 1st and 2nd floor map views | **Done, needs polish.** The map screen shows each floor in 3D with the upper floors cut away. It has Zoom in, Zoom out, Rotate and Reset buttons, drag to move, and a 2D plan toggle. | • The building appears small, with empty space above and below it.<br>• Offices are not labelled on the map.<br>• The office list under the map uses the **old database room codes** (for example 2F-207), which do not match the real building's doors. |

## 3. What must happen before the public can use it

These are in order. Items 1–4 need City Hall staff or the plans; software alone cannot settle them.

1. **Match every office to its real door.** Only 4 of the building's doorways have routes so far:
   - Social Welfare: R1-W002-D108
   - Assessor: R1-W038-D133
   - Planning: R2-W032-D210
   - Accounting: R2-W057-D229

   Codex matched these 4 from the floor plans you supplied, and they are still drafts. The live database lists 26 offices: 15 in the building, 6 off-site and 5 unconfirmed. For each in-building office, staff should confirm the door and its public entrance. The plans are in Admin, under reference plans.
2. **Extend the walking network to every office door.** Today it has 24 points and 24 segments, covering only the corridors of the 4 pilot routes. The other wings and corridors must be added, from the model, the same way.
3. **Decide about the 3rd floor.** The database and your plans have a 3rd floor (8.4 m), but routes cover only the 1st and 2nd floors. If any public office is on the 3rd floor, it needs its stairs and corridors added. Otherwise the kiosk should say "ask at the information desk".
4. **Site checks** (measuring tape and a walk-through):
   - Where the lobby kiosk will stand and which way it faces.
   - Four measured points:
     - the entrance centre;
     - a point to the left;
     - a point to the right or deeper inside;
     - an upstairs landing.
   - The real 2nd-floor height. The model says 4.0 m and the database says 4.2 m.
   - Walk every route and tick each segment as checked in **Admin → Navigation**.
   - Whether the lift and the ramps exist and are public, and which corridors have no steps.
5. **Go live on the real database.**
   - **Back up `server/data/kiosk.sqlite` first.** The new server adds the navigation tables to it on its first start.
   - Then import the network, register model release r09-web02, check the report in **Admin → Navigation** and publish.
   - Draft routes never show to visitors; only checked routes do.

## 4. Development work I can do now (no site visit needed)

| Priority | Item |
|---|---|
| High | Commit Codex's uncommitted work, then push the branch. |
| High | Shorten or wrap the destination name tag, and fix the white patch where the line meets the door ring. |
| High | Map screen: make the building fill the frame, label the offices on the plan and in 3D, and let a tap on an office start the route. Replace the old room codes in the office list with the real door or room names. |
| High | Phone page: use the real floor plans. It still draws the outline-only map, because my edit there did not save. |
| Medium | Minimap: make it larger, stop the end markers from overlapping, and add a tap to enlarge it. |
| Medium | Check every screen in landscape and on a phone, then fix layout problems. |
| Medium | Translations: the new Filipino and Cebuano wording needs a native-speaker review. |
| Later | A walking character with a camera that follows it. It needs collision handling so the camera never passes through corridor walls. |

## 5. Production readiness (not started)

- **Speed on the actual kiosk.** All timings so far come from software rendering on this PC. The real kiosk's graphics card, browser and screen size are needed.
- **Offline running:**
  - install, update and roll back model releases with no internet;
  - run the server as a Windows service that starts on boot.
- **Printing:** test the printed slip on the real kiosk printer.
- **Old setup notes:** the notes in `Desktop\cityhallkiosk_codex\cityhallkiosk_codex` (HANDOFF, PROGRESS, TASKS) still say "no application code exists yet" and point to an old repository. Update them or archive them so a new session does not follow them.

## 6. Model and Unity

- The Blender export is complete, and no rebake is needed.
- **Unity has never been opened.** The web kiosk now runs the real building without Unity. **Decide whether Unity is still needed.** If it is not, stop the Unity work, so the model is not maintained twice.
- If Unity stays, the model team must fix the package's broken front camera. The web version corrects it on its own, and the exterior view is no longer used.
- Cosmetic:
  - steel chairs look darker than in Blender;
  - glass looks too clear;
  - the lift shaft is black in cut-away views.

## How to see it

From `server/`:

```powershell
node test/e2e/demo-server.mjs
```

This runs on a copy of the database and changes nothing in the real one. Then open:

- **Pilot routes:** `http://localhost:3100/kiosk?kiosk=PILOT-ENTRANCE&preview=1&screen=map`. Scroll to "Pilot doorways" and touch one.
- **Map:** the 1st floor and 2nd floor buttons on the same screen.
- **Admin:** `http://localhost:3100/admin#/navigation`

Fresh screenshots: `test-results/pilot/` (portrait and landscape: the walk at the entrance, on the stairs and at the door, plus the floor maps).
