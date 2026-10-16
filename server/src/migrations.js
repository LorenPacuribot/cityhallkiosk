// Versioned, transactional schema migrations. Each runs once, inside BEGIN/COMMIT, and is recorded in
// schema_migrations. They only ADD tables/columns: existing content, office history and audit rows are untouched.
// Never replace this with a reseed — `npm run seed` resets the database.

export const MIGRATIONS = [
  {
    id: '2026-10-16-001-navigation',
    description: 'Model releases, calibrations, navigation graph revisions, opening/sign mappings and publications',
    sql: `
CREATE TABLE IF NOT EXISTS model_releases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version  TEXT NOT NULL UNIQUE,            -- 'r09-web01' (immutable directory under /models/cityhall/)
  base_url       TEXT NOT NULL,                   -- '/models/cityhall/r09-web01/'
  manifest_sha256 TEXT,
  source_blend_sha256 TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','available','retired')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_calibrations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  calibration_version TEXT NOT NULL UNIQUE,
  model_version       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','verified','retired')),
  matrix_json         TEXT NOT NULL,              -- column-major 4x4: blender world -> canonical
  anchors_json        TEXT NOT NULL DEFAULT '[]', -- [{id, blender, canonical, measured, residual_m, source}]
  floor_elevations_json TEXT NOT NULL DEFAULT '{}',
  description         TEXT,
  verified_by         INTEGER REFERENCES users(id),
  verified_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS navigation_revisions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  navigation_version  TEXT NOT NULL UNIQUE,
  model_version       TEXT NOT NULL,
  calibration_version TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  floors_json         TEXT NOT NULL DEFAULT '[]',
  note                TEXT,
  field_checklist_json TEXT NOT NULL DEFAULT '[]',
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS navigation_nodes (
  revision_id  INTEGER NOT NULL REFERENCES navigation_revisions(id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  floor_level  INTEGER NOT NULL,
  role         TEXT NOT NULL DEFAULT 'junction',
  label        TEXT,
  source       TEXT,                              -- evidence this position came from
  verified     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (revision_id, node_id)
);

CREATE TABLE IF NOT EXISTS navigation_edges (
  revision_id  INTEGER NOT NULL REFERENCES navigation_revisions(id) ON DELETE CASCADE,
  edge_id      TEXT NOT NULL,
  from_node    TEXT NOT NULL,
  to_node      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('walk','stairs','ramp','lift','door')),
  polyline_json TEXT NOT NULL,                    -- ordered [{x,y,z}] in canonical metres
  length_m     REAL NOT NULL CHECK (length_m > 0),
  bidirectional INTEGER NOT NULL DEFAULT 1,
  verified     INTEGER NOT NULL DEFAULT 0,
  is_public    INTEGER NOT NULL DEFAULT 1,
  step_free    INTEGER CHECK (step_free IN (0,1)), -- NULL = unknown = not eligible for step-free requests
  closed       INTEGER NOT NULL DEFAULT 0,
  closed_reason TEXT,
  label        TEXT,
  source       TEXT,
  verified_by  INTEGER REFERENCES users(id),
  verified_at  TEXT,
  PRIMARY KEY (revision_id, edge_id),
  FOREIGN KEY (revision_id, from_node) REFERENCES navigation_nodes(revision_id, node_id),
  FOREIGN KEY (revision_id, to_node) REFERENCES navigation_nodes(revision_id, node_id),
  CHECK (NOT (kind = 'stairs' AND step_free = 1))
);

CREATE TABLE IF NOT EXISTS kiosk_navigation_nodes (
  revision_id  INTEGER NOT NULL REFERENCES navigation_revisions(id) ON DELETE CASCADE,
  kiosk_code   TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  verified     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (revision_id, kiosk_code),
  FOREIGN KEY (revision_id, node_id) REFERENCES navigation_nodes(revision_id, node_id)
);

-- physical doorway <-> database room. Unresolved rows stay unresolved (room_id NULL); nothing is guessed.
CREATE TABLE IF NOT EXISTS room_openings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id   INTEGER NOT NULL REFERENCES navigation_revisions(id) ON DELETE CASCADE,
  opening_id    TEXT NOT NULL,                    -- 'R2-W001-D187' (model opening, NOT a room code)
  room_id       INTEGER REFERENCES rooms(id),
  door_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  approach_node_id TEXT,                          -- graph node where the public approach ends
  door_x REAL, door_y REAL, door_z REAL,          -- door point (canonical) for the arrival side
  label         TEXT,                             -- human label for pilot / preview destinations
  status        TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved','draft','verified')),
  reviewed_by   INTEGER REFERENCES users(id),
  reviewed_at   TEXT,
  notes         TEXT,
  UNIQUE (revision_id, opening_id),
  FOREIGN KEY (revision_id, approach_node_id) REFERENCES navigation_nodes(revision_id, node_id),
  CHECK (status != 'verified' OR (room_id IS NOT NULL AND approach_node_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS sign_bindings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id   INTEGER NOT NULL REFERENCES navigation_revisions(id) ON DELETE CASCADE,
  sign_asset_id TEXT NOT NULL,                    -- 'r09-web01:SIGNFACE_SIGN_R2-W001-D187_Face_A'
  opening_id    TEXT NOT NULL,
  face          TEXT NOT NULL CHECK (face IN ('A','B')),
  status        TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved','draft','verified')),
  reviewed_by   INTEGER REFERENCES users(id),
  reviewed_at   TEXT,
  UNIQUE (revision_id, sign_asset_id),
  FOREIGN KEY (revision_id, opening_id) REFERENCES room_openings(revision_id, opening_id)
);

-- the compatible tuple the kiosks use. Exactly one row is 'published'; earlier rows are kept for rollback.
CREATE TABLE IF NOT EXISTS navigation_publications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version       TEXT NOT NULL,
  calibration_version TEXT NOT NULL,
  navigation_version  TEXT NOT NULL,
  content_version     INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('published','superseded','rolled_back')),
  validation_json     TEXT NOT NULL,
  published_by        INTEGER REFERENCES users(id),
  published_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_published_navigation ON navigation_publications(status) WHERE status = 'published';
`,
  },
];

/** Applies pending migrations. `db` is the sql.js Database. Returns the ids applied. */
export function migrate(db) {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, description TEXT, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const done = new Set((db.exec('SELECT id FROM schema_migrations')[0]?.values || []).map(r => r[0]));
  const applied = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.run('BEGIN');
    try {
      db.run(m.sql);
      db.run('INSERT INTO schema_migrations(id, description) VALUES (?, ?)', [m.id, m.description]);
      db.run('COMMIT');
      applied.push(m.id);
    } catch (e) {
      db.run('ROLLBACK');
      throw new Error(`migration ${m.id} failed: ${e.message}`);
    }
  }
  return applied;
}
