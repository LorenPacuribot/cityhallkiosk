// SQLite through sql.js (pure WebAssembly): no native build tools needed on Windows/macOS/Linux.
// The whole database lives in memory and is written to data/kiosk.sqlite after every change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { migrate } from './migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DB_FILE = process.env.KIOSK_DB || path.join(ROOT, 'data', 'kiosk.sqlite');
// Browser model releases (<root>/cityhall/<modelVersion>/). Tests point this at isolated fixtures.
export const MODELS_ROOT = process.env.KIOSK_MODELS_ROOT || path.join(ROOT, 'public', 'models');

let SQL;
let db;
let saveTimer = null;

export async function openDb({ fresh = false } = {}) {
  SQL ??= await initSqlJs();
  if (!fresh && fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON;');
  db.run(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  upgrade();
  if (migrate(db).length) saveNow();
  return db;
}

// Columns added after a database was first created (CREATE TABLE IF NOT EXISTS leaves old tables as they were).
function upgrade() {
  const cols = db.exec('PRAGMA table_info(services)')[0]?.values.map(r => r[1]) || [];
  if (!cols.includes('notes')) db.run('ALTER TABLE services ADD COLUMN notes TEXT');
}

export function saveNow() {
  if (!db) return;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, DB_FILE); // atomic replace: a crash never leaves a half-written database
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

const norm = (params = []) =>
  Array.isArray(params) ? params.map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)) : params;

export function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(norm(params));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export function get(sql, params = []) {
  return all(sql, params)[0] ?? null;
}

export function run(sql, params = []) {
  db.run(sql, norm(params));
  const id = db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0];
  const changes = db.getRowsModified();
  scheduleSave();
  return { lastId: id, changes };
}

// Runs fn inside BEGIN/COMMIT; rolls back on any error.
export function tx(fn) {
  db.run('BEGIN');
  try {
    const out = fn();
    db.run('COMMIT');
    scheduleSave();
    return out;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

export function setting(key, fallback = null) {
  return get('SELECT value FROM settings WHERE key = ?', [key])?.value ?? fallback;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
}

// Every content change bumps this number. Kiosks and phones poll it
// and re-download their offline bundle when it changes.
export function bumpContentVersion() {
  const v = Number(setting('content_version', '0')) + 1;
  setSetting('content_version', v);
  return v;
}

process.on('exit', () => { try { saveNow(); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { saveNow(); } finally { process.exit(0); } });
