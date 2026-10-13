# Unity 3D navigation — C# prototype

These scripts connect the Unity build of Malaybalay City Hall to the kiosk database. Room positions are never hard-coded in the scene. They come from the server, so when an office moves or a room is re-measured, Unity follows on its next sync without a rebuild.

Tested to compile against the Unity 2021.3+ API surface. Built-in render pipeline and URP both work. The scripts need no extra packages; for exact paths, bake a NavMesh with the built-in Navigation window or the AI Navigation package.

## Files (`Assets/Scripts/Kiosk/`)

| Script | What it does |
|---|---|
| `KioskApiClient.cs` | Makes HTTP calls to the Node server (`baseUrl`, `kioskCode`). Every GET is also cached in `persistentDataPath/kiosk-cache`, so the app keeps working offline with the last data. |
| `KioskDtos.cs` | The JSON shapes, which are `JsonUtility`-friendly. |
| `DestinationRegistry.cs` | Polls `/api/kiosk/version` every 30 s. When the version changes, it reloads rooms, destinations and the kiosk position and raises `OnChanged`. It also sends the heartbeat that the admin dashboard shows. |
| `RoomMarker.cs` | Put one inside each room as `DEST_<code>`, for example `DEST_1F-102`. The child `Approach` marks the corridor point in front of the door, and the marker's forward axis is the direction the door faces. |
| `KioskStartPoint.cs` | Marks where the physical kiosk stands. Its position comes from the admin panel's Kiosks page. |
| `NavigationController.cs` | Draws the route from the kiosk to the room. It uses `NavMesh.CalculatePath` when a NavMesh is baked, and otherwise falls back to the server's corridor route (`/api/route`). It also handles the LineRenderer, the walking guide, follow camera, pause / replay / skip, and re-routing when the room moves. |
| `GreyboxBuilder.cs` | Builds block geometry from `/api/floors`, so you can test before the Blender model is ready. Disable it once the real model is in. |
| `KioskDemoUI.cs` | A small on-screen UI: search the database, pick an office, watch the route. |
| `Editor/KioskSyncWindow.cs` | The **Kiosk ▸ Room Sync…** menu. **Pull** creates and moves markers from the database. **Push** writes the marker x/y/z back to the database (`POST /api/admin/rooms/sync-from-unity`; needs an LGU admin account). |

## Coordinate convention (same in the database, the web kiosk and Unity)

- Units are metres. **Y is up.** **+X** is to your right when you stand outside facing the building. **+Z** points into the building.
- **Origin (0,0,0)** is the centre of the main entrance, at ground level.
- Floors sit at y = 0 / 4.2 / 8.4 (editable in the database). The main corridor is at z = 16 in the placeholder layout.
- Put the imported model under an empty **BuildingRoot**, positioned so the entrance is at the root's origin, and assign it to `DestinationRegistry.buildingRoot`. You can then place the whole building anywhere in the scene.

## Scene setup (about 5 minutes)

1. Start the server: `cd server && npm install && npm start`. Check that http://localhost:3000/api/destinations returns JSON.
2. Copy `Assets/Scripts/Kiosk` into your Unity project.
3. Create an empty object called **KioskSystems** and add `KioskApiClient`, `DestinationRegistry`, `GreyboxBuilder` (only until the real model exists), `KioskDemoUI`.
4. Create an empty object called **Navigation** and add `NavigationController`, which adds a LineRenderer. Drag your Main Camera into *Follow Camera*.
5. Optionally add an empty object called **KioskStart** with `KioskStartPoint`.
6. Press Play. The greybox builds, the office list appears, and clicking an office shows the route.

### Live-change test

While Play mode is running, open http://localhost:3000/admin → Offices → *City Civil Registrar Office* → **Move office** to another room. Within 30 s, Unity logs `Loaded content v…`, the markers move, and an active route re-calculates. You can do the same with Floors & rooms by dragging a room or typing a new x/z.

## Workflow with the real Blender model

1. Import the FBX under `BuildingRoot` (entrance at origin, 1 unit = 1 m, Y up).
2. Run **Kiosk ▸ Room Sync… ▸ Pull server → markers**. This creates a `DEST_<code>` marker for every room in the database.
3. Drag each marker into its real room, and its `Approach` child to the corridor in front of the door. Rotate the marker so blue (+Z) faces out of the door.
4. Run **Push markers → server** with an LGU admin login. The admin panel then shows those rooms as *Unity sync* instead of *Placeholder*.
5. Bake the NavMesh with stairs walkable. `NavigationController` then prefers real NavMesh paths automatically.
6. If a new room is added in the building later, add it in the admin panel first (code and name), then place its marker and Push. Unknown codes are reported, not created.

## Building for the kiosk PC

- Set `KioskApiClient.baseUrl` to `http://localhost:3000` if the server runs on the kiosk PC, or to the LAN address of the server PC.
- Use a portrait 1080 × 1920 window. The web kiosk (`/kiosk`) and the Unity app can run side by side, or the Unity view can be embedded later.
- If the server is unreachable, the app starts from `persistentDataPath/kiosk-cache`. It needs one successful run with the network first.
