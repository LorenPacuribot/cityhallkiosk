#!/usr/bin/env node
// Applies the owner's room guide (server/data/navigation/r09-room-guide.json) to a kiosk database:
// imports the draft navigation graph revision if it is missing (NOT published), creates rooms "Room 1".."Room 17",
// moves offices into them with history, links doorways and signs as DRAFT, and marks the guide's "unconfirmed"
// offices. Idempotent: rooms that already exist are left alone.
//
//   node tools/apply-room-guide.mjs            (live database server/data/kiosk.sqlite; STOP the server first)
//   KIOSK_DB=path/to/copy.sqlite node tools/apply-room-guide.mjs
//
// A timestamped backup is written to server/data/backups/ before anything changes. Refuses to run while a kiosk
// server is listening on port 3000 (it would overwrite these changes from memory).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');
const DB = process.env.KIOSK_DB || path.join(SERVER, 'data/kiosk.sqlite');
const listening = await new Promise(r => { const s = net.connect(Number(process.env.PORT || 3000), '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
if (listening && !process.env.KIOSK_DB) { console.error('A server is listening on port 3000. Stop it first: it keeps the database in memory and would overwrite these changes.'); process.exit(1); }
if (!fs.existsSync(DB)) { console.error(`No database at ${DB}`); process.exit(1); }

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const backups = path.join(path.dirname(DB), 'backups'); fs.mkdirSync(backups, { recursive: true });
const backup = path.join(backups, `${path.basename(DB, '.sqlite')}-${stamp}-before-room-guide.sqlite`);
fs.copyFileSync(DB, backup);
console.log(`backup: ${path.relative(ROOT, backup)}`);

process.env.KIOSK_DB = DB;
const mod = p => import(pathToFileURL(path.join(SERVER, p)).href);
const { createApp } = await mod('src/server.js');
await createApp(); // opens the database and runs migrations; does not listen
const { saveNow, get, all } = await mod('src/db.js');
const nav = await mod('src/lib/navigation.js');
const { applyPlanReferenceRooms } = await mod('src/lib/plan-reference-rooms.js');
const graph = JSON.parse(fs.readFileSync(path.join(SERVER, 'data/navigation/r09-pilot-draft.json'), 'utf8'));
if (!nav.revisionByVersion(graph.navigationVersion)) { nav.importGraph(graph, null); console.log(`imported draft graph ${graph.navigationVersion} (not published)`); }
const applied = applyPlanReferenceRooms(graph);
saveNow();
console.log(applied.length ? `rooms created: ${applied.join(', ')}` : 'nothing to do: every guide room already exists');
for (const o of all(`SELECT o.short_name, o.location_type, v.room_code, v.floor_name FROM offices o LEFT JOIN v_office_current_location v ON v.office_id = o.id
                      WHERE o.is_active = 1 AND o.location_type != 'offsite' ORDER BY v.floor_name, v.room_code`))
  console.log(`  ${o.short_name.padEnd(7)} ${o.location_type === 'in_building' ? `${o.floor_name} · ${o.room_code}` : o.location_type}`);
console.log(`content version: ${get("SELECT value FROM settings WHERE key = 'content_version'")?.value}`);
process.exit(0);
