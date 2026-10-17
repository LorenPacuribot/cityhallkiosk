-- =====================================================================
-- Malaybalay City Hall Kiosk — database schema (SQLite)
--
-- Design rules
--  * Locations are DATA, not code. Every physical place (room, stairs,
--    kiosk) has x, y, z world coordinates in METRES, matching the 3D
--    model (1 unit = 1 m, Y is up). Staff can change them any time
--    and the kiosk and phone pick up the change on the next sync.
--  * An office is not the same as a room. Offices MOVE between rooms.
--    office_locations keeps the full history: the current location is the
--    row with valid_to IS NULL. Moving an office closes that row and opens
--    a new one, so nothing is overwritten and past locations stay auditable.
--  * Services belong to offices, so a service's location always follows
--    its office automatically.
-- =====================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- places
CREATE TABLE IF NOT EXISTS buildings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  address     TEXT,
  origin_note TEXT,                -- what (0,0,0) means, e.g. "centre of main entrance at ground level"
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS floors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  building_id   INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  level         INTEGER NOT NULL,          -- 1 = ground floor
  name          TEXT NOT NULL,             -- "1st floor"
  elevation_y   REAL NOT NULL DEFAULT 0,   -- floor height in metres (Y)
  plan_image    TEXT,                      -- optional URL of a floor-plan image for the admin map
  bounds_min_x  REAL NOT NULL DEFAULT -60, -- extent used to draw the 2D map
  bounds_max_x  REAL NOT NULL DEFAULT 60,
  bounds_min_z  REAL NOT NULL DEFAULT -25,
  bounds_max_z  REAL NOT NULL DEFAULT 25,
  UNIQUE (building_id, level)
);

-- A room is any destination-capable space: office rooms, halls, stairs,
-- elevators, toilets, the information desk. Coordinates are dynamic.
CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_id    INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,        -- "1F-104"
  name        TEXT NOT NULL,
  room_type   TEXT NOT NULL DEFAULT 'office'
              CHECK (room_type IN ('office','hall','stairs','elevator','ramp','toilet','info_desk','entrance','other')),
  -- centre of the room (used for labels / greybox)
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  z REAL NOT NULL DEFAULT 0,
  -- where a person stands to enter: the route ends here (door / counter)
  approach_x  REAL,
  approach_y  REAL,
  approach_z  REAL,
  facing_deg  REAL NOT NULL DEFAULT 0,     -- rotation around Y for arrival camera / popup
  width_m     REAL NOT NULL DEFAULT 6,     -- footprint for the 2D map and greybox
  depth_m     REAL NOT NULL DEFAULT 6,
  is_accessible INTEGER NOT NULL DEFAULT 1, -- reachable without stairs
  is_active   INTEGER NOT NULL DEFAULT 1,
  coord_source TEXT NOT NULL DEFAULT 'manual'  -- 'manual' | 'unity_sync' (legacy import) | 'seed_placeholder'
              CHECK (coord_source IN ('manual','unity_sync','seed_placeholder')),
  photo_url   TEXT,
  notes       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rooms_floor ON rooms(floor_id);

-- ---------------------------------------------------------------- offices
CREATE TABLE IF NOT EXISTS offices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  short_name    TEXT,
  description   TEXT,
  head          TEXT,
  phone         TEXT,
  email         TEXT,
  hours         TEXT DEFAULT 'Monday to Friday 8:00 AM – 5:00 PM (except holidays)',
  location_type TEXT NOT NULL DEFAULT 'in_building'
                CHECK (location_type IN ('in_building','offsite','unconfirmed')),
  offsite_address TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Office ↔ room over time. Current row: valid_to IS NULL.
CREATE TABLE IF NOT EXISTS office_locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  office_id   INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  room_id     INTEGER NOT NULL REFERENCES rooms(id),
  is_primary  INTEGER NOT NULL DEFAULT 1,
  valid_from  TEXT NOT NULL DEFAULT (datetime('now')),
  valid_to    TEXT,
  note        TEXT,
  changed_by  INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_officeloc_current ON office_locations(office_id, valid_to);

-- ---------------------------------------------------------------- kiosks
CREATE TABLE IF NOT EXISTS kiosks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,     -- "KIOSK-LOBBY-1"
  name           TEXT NOT NULL,
  floor_id       INTEGER NOT NULL REFERENCES floors(id),
  x REAL NOT NULL DEFAULT 0,               -- "You are here" — also dynamic
  y REAL NOT NULL DEFAULT 0,
  z REAL NOT NULL DEFAULT 0,
  facing_deg     REAL NOT NULL DEFAULT 0,
  last_heartbeat TEXT,
  app_version    TEXT,
  content_version INTEGER,
  is_active      INTEGER NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------- services (Citizen's Charter)
CREATE TABLE IF NOT EXISTS services (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  office_id          INTEGER NOT NULL REFERENCES offices(id),
  title              TEXT NOT NULL,
  plain_title        TEXT,                 -- citizen-friendly name, e.g. "Cedula"
  description        TEXT,
  office_division    TEXT,
  classification     TEXT,                 -- Simple / Complex / Highly Technical
  transaction_type   TEXT,                 -- G2C / G2B / G2G text from charter
  who_may_avail      TEXT,
  total_fees         TEXT,
  total_processing_time TEXT,
  period_of_extension TEXT,
  notes              TEXT,                 -- charter notes, policies and fee schedules printed with the service
  is_citizen_facing  INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','pending','published','archived')),
  source             TEXT,                 -- "Citizen's Charter 2023, p. 142"
  parse_quality      TEXT,                 -- 'good' | 'needs_review' (from importer)
  verified_at        TEXT,
  verified_by        INTEGER REFERENCES users(id),
  view_count         INTEGER NOT NULL DEFAULT 0,
  -- Changes proposed by an office editor wait here until an LGU admin approves them.
  -- The kiosk keeps showing the published version in the meantime.
  pending_json       TEXT,
  pending_by         INTEGER REFERENCES users(id),
  pending_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_services_office ON services(office_id);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);

CREATE TABLE IF NOT EXISTS service_requirements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id      INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  sort            INTEGER NOT NULL DEFAULT 0,
  requirement     TEXT NOT NULL,
  where_to_secure TEXT
);

CREATE TABLE IF NOT EXISTS service_steps (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id       INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  sort             INTEGER NOT NULL DEFAULT 0,
  client_action    TEXT,
  agency_action    TEXT,
  fee              TEXT,
  processing_time  TEXT,
  person_in_charge TEXT
);

CREATE TABLE IF NOT EXISTS service_keywords (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  keyword    TEXT NOT NULL
);

-- ---------------------------------------------------------------- content & logs
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT,
  tone       TEXT NOT NULL DEFAULT 'info' CHECK (tone IN ('info','warning','critical')),
  starts_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ends_at    TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  kiosk_code TEXT,
  helpful    INTEGER NOT NULL,           -- 1 yes, 0 no
  reason     TEXT,                       -- unclear | wrong_info | not_found | other
  comment    TEXT,
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS search_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  query         TEXT NOT NULL,
  results_count INTEGER NOT NULL,
  kiosk_code    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_logs (      -- one row per kiosk session (from tap to reset)
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kiosk_code  TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  navigated_room_id INTEGER
);

-- ---------------------------------------------------------------- people & audit
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('system_admin','lgu_admin','office_editor','viewer')),
  office_id     INTEGER REFERENCES offices(id),   -- required for office_editor
  is_active     INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,       -- create | update | delete | move | approve | login
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  before_json TEXT,
  after_json  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Convenience view: where every office is right now, with coordinates.
CREATE VIEW IF NOT EXISTS v_office_current_location AS
SELECT o.id AS office_id, o.name AS office_name, o.location_type, o.offsite_address,
       r.id AS room_id, r.code AS room_code, r.name AS room_name,
       f.id AS floor_id, f.level AS floor_level, f.name AS floor_name,
       r.x, r.y, r.z,
       COALESCE(r.approach_x, r.x) AS approach_x,
       COALESCE(r.approach_y, r.y) AS approach_y,
       COALESCE(r.approach_z, r.z) AS approach_z,
       r.facing_deg, ol.valid_from
FROM offices o
LEFT JOIN office_locations ol ON ol.office_id = o.id AND ol.valid_to IS NULL AND ol.is_primary = 1
LEFT JOIN rooms r ON r.id = ol.room_id
LEFT JOIN floors f ON f.id = r.floor_id;
