# Malaybalay City Hall Kiosk — working prototype

This is a self-service kiosk for Malaybalay City Hall. Visitors can find a service, see what to bring, and get walked to the right office in 3D. Everything runs on your own computer from one local database.

| Part | URL / folder | What it is |
|---|---|---|
| **Kiosk screen** | http://localhost:3000/kiosk | The 43″ portrait touchscreen UI from the Figma design (K1–K13): welcome, search with on-screen keyboard, results, offices, service detail, 3D "Show me the way", arrival, QR hand-off, print slip, feedback, idle reset, EN / Filipino / Cebuano, large text. |
| **Admin panel** | http://localhost:3000/admin | Services editor with an approval flow, offices with **move office plus history**, floors and rooms with **drag or typed x/y/z**, kiosks, announcements, feedback, search insights, users and roles, audit log. |
| **Phone page** | http://localhost:3000/m | What the QR code opens: a requirements checklist that stays on the phone, the steps, and a floor map. |
| **API + database** | `server/` | Node.js (Express) API with a SQLite database file. 270 services imported from the Citizen's Charter 2023. |
| **Unity C#** | `unity/Assets/Scripts/Kiosk` | Scripts that read the same database. Room positions are dynamic, office moves apply live, it uses the NavMesh path when one is baked, and an editor tool syncs room markers between Unity and the database. See [`unity/README.md`](unity/README.md). |

## Run it locally

You need **Node.js 18.17 or newer** (https://nodejs.org). Nothing else is required: the database is a file and is created on first start.

```bash
git clone https://github.com/LorenPacuribot/cityhallkiosk.git
cd cityhallkiosk/server
npm install
npm start
```

Then open http://localhost:3000.

| Account (password `ChangeMe!2026`) | Role |
|---|---|
| `admin@kiosk.local` | System admin |
| `lgu.admin@kiosk.local` | LGU admin: approves and publishes, moves offices |
| `ccro.editor@kiosk.local` | Office editor for the City Civil Registrar only; their changes wait for approval |
| `viewer@kiosk.local` | Read only |

**Change these passwords (Admin ▸ Users) before anyone else can reach the server.**

Other commands:

```bash
npm run dev     # restart automatically when code changes
npm run seed    # reset the database to the imported Charter + placeholder rooms
npm test        # API tests (uses a temporary database)
PORT=8080 npm start
PUBLIC_BASE_URL=http://192.168.1.20:3000 npm start   # address printed inside QR codes
```

To test the phone page, connect your phone to the same Wi-Fi and scan the QR code on a service screen. The server prints its LAN address when it starts.

Useful kiosk URL options:
- `?kiosk=KIOSK-LOBBY-1` sets which kiosk this screen is (it sets the start point of routes).
- `?idle=0` turns off the 60-second privacy reset, for demos.
- `?screen=service&id=237` opens a screen directly.

## Locations are data, not code

Every position is in **metres, using Unity's axes**:
- **Y** is up.
- **+X** is to the right when facing the building.
- **+Z** points into the building.
- The **origin is the main entrance**.

- A **room** has a centre `x, y, z`, a door or approach point, a facing direction and a size.
- An **office** is linked to a room through `office_locations`. A move closes the old row and opens a new one, so history is kept and nothing is overwritten.
- A **kiosk** has its own `x, y, z`, which is where every route starts.
- Any change bumps a content version. Web kiosks re-sync within 60 s and Unity within 30 s, offline caches included.

Details: [`docs/DATABASE.md`](docs/DATABASE.md) · endpoints: [`docs/API.md`](docs/API.md)

## Honest status of the prototype

- **Room positions are placeholders.** They sit on a simple grid (labelled *Placeholder* in the admin panel) until someone measures the building or pushes markers from the Unity model.
- The **Charter import** is automatic. **59 services are flagged "needs review"**, and some long fee texts are cut short. Each office should check its own services and press *Mark as verified*.
- The **Filipino and Cebuano** texts are first drafts and need review by native speakers.
- The web kiosk's 3D view is a greybox built from the database (three.js). The real City Hall model goes into Unity.
- The backend is Node.js rather than C#/.NET so it runs with a single `npm start` on any PC. The C# part is the Unity client. The API is plain JSON, so it can be re-implemented in ASP.NET later without changing the kiosk or Unity.
- The Figma admin and phone screens were not drawn (Figma plan limit). The code versions here follow the same design tokens.

## Repository layout

```
server/
  src/            API (Express), database layer (sql.js), auth, search, route planner, seed
  src/schema.sql  database schema
  data/           charter-2023.json (parsed Charter); kiosk.sqlite is created at runtime
  public/kiosk    kiosk SPA (+ nav3d.js three.js greybox)
  public/admin    admin SPA
  public/m        phone page
  public/shared   design tokens, icons, i18n, shared route planner
  test/           API tests
tools/parse_charter.py   re-run the Charter PDF import (needs pdftotext)
unity/Assets/Scripts/Kiosk   Unity C# client + editor sync tool
docs/            API and database reference
```
