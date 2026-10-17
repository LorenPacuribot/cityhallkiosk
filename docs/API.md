# API

Base URL: `http://localhost:3000/api`. All requests and responses are JSON. Admin endpoints need a session, sent either as the `sid` cookie set by login or as `Authorization: Bearer <token>`.

## Public (kiosk, phone)

| Method & path | Returns |
|---|---|
| `GET /health` | `{ ok, content_version, time }` |
| `GET /kiosk/version` | `{ content_version }`. Poll this endpoint and re-download when the value changes. |
| `GET /kiosk/bundle?kiosk=CODE` | Everything the web kiosk needs offline (~1.2 MB): settings, kiosk, building, floors with rooms, offices, published services, announcements |
| `POST /kiosks/:code/heartbeat` | Body `{ app_version, content_version }`. Shows the kiosk as online in the dashboard. |
| `GET /kiosks/:code` | Kiosk position `{ code, x, y, z, facing_deg, floor_level }` |
| `POST /kiosk-sessions` | Body `{ kiosk_code }`. Counts one session. |
| `GET /search?q=&kiosk=&log=0` | Typo-tolerant search over services, offices and keywords: `{ results: [{ kind: service|office, id, title, subtitle, score }] }` |
| `GET /services/popular` | The most viewed services |
| `GET /services/:id?view=0` | Service detail: requirements, grouped steps, `location` with room and floor |
| `GET /offices`, `GET /offices/:id` | Offices with their current location (and services) |
| `GET /floors` | Floors with their rooms (x/y/z, approach, size) |
| `GET /rooms` | Active rooms. The approach point falls back to the centre. |
| `GET /destinations` | Every office's current room with x/y/z and approach |
| `GET /route?room_id=` \| `office_id=` \| `service_id=` `&kiosk=&accessible=1&log=0` | `{ from, to, waypoints[{x,y,z,floor,label}], directions[{key,text,distance_m,point_index}], distance_m, minutes }` |
| `POST /feedback` | Body `{ service_id, helpful: 1/0, reason: unclear/wrong_info/not_found/other, comment, kiosk_code }` |
| `GET /qr.svg?data=` | QR code for the phone hand-off |
| `GET /config` | `{ public_base_url }`: the LAN address used inside QR codes |

## Auth

| | |
|---|---|
| `POST /auth/login` | `{ email, password }` → `{ token, user }`. Also sets the `sid` cookie. |
| `POST /auth/logout` | |
| `GET /auth/me` | Current user |

## Admin (`/api/admin`, minimum role in brackets)

| Method & path | |
|---|---|
| `GET /dashboard` (viewer) | Today's sessions and searches, helpful %, searches with no results, service health, kiosks, top services |
| `GET /services?q=&office_id=&status=published\|draft\|pending\|needs_review\|unverified\|archived&page=&size=` (viewer) | Paged list |
| `GET /services/:id` (viewer) | Detail including `raw_steps`, `keywords`, `pending` |
| `POST /services` (office_editor) | Create. Body: fields plus `requirements[]`, `steps[]`, `keywords[]`, `publish` |
| `PUT /services/:id` (office_editor) | Update. When an office editor changes a published service, the change goes to approval. |
| `POST /services/:id/approve` \| `reject` (lgu_admin) | Apply or discard a pending change |
| `POST /services/:id/status` (lgu_admin) | `{ status: draft\|published\|archived }` |
| `POST /services/:id/verify` (office_editor) | Stamps "checked by the office" |
| `GET/POST /offices`, `PUT /offices/:id` | Office details |
| `POST /offices/:id/move` (lgu_admin) | `{ room_id, note }`. Closes the current location and opens a new one. |
| `GET /offices/:id/history` (viewer) | All past locations |
| `GET /floors`, `PUT /floors/:id` (lgu_admin) | Elevation (y) and plan bounds |
| `GET /rooms`, `POST /rooms`, `PUT /rooms/:id`, `DELETE /rooms/:id` (lgu_admin) | Room CRUD with x/y/z validation. Delete deactivates, and is blocked while an office is in the room. |
| `GET/POST /kiosks`, `PUT /kiosks/:id` | Kiosk position |
| `GET/POST /announcements`, `PUT/DELETE /announcements/:id` | |
| `GET /feedback`, `PUT /feedback/:id` | `{ status: resolved\|new }` |
| `GET /search-logs` | `{ no_results[], top[] }` |
| `GET /audit` (lgu_admin) | Last 200 changes |
| `GET/POST /users`, `PUT /users/:id` (lgu_admin) | Passwords must be at least 10 characters. Only a system admin can create a system admin. |

Errors come back as `{ "error": "Human-readable message" }` with a 4xx status.
