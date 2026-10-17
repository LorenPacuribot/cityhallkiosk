#!/usr/bin/env node
// Demo server for the real-building navigation, on a COPY of the live database (the live file is never opened
// for writing). Sets up what staff would do in Admin -> Navigation: imports the draft pilot graph, registers the
// r09-web02 model release, publishes, turns on labelled draft preview and registers the PILOT-ENTRANCE origin.
//
//   cd server
//   node test/e2e/demo-server.mjs            (port 3100; PORT=xxxx to change)
//
// Stop with Ctrl+C. The copy is deleted on exit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../..');
const LIVE = path.join(SERVER, 'data/kiosk.sqlite');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-demo-'));
const copy = path.join(tmp, 'demo.sqlite');
if (fs.existsSync(LIVE)) fs.copyFileSync(LIVE, copy);
process.env.KIOSK_DB = copy;
const PORT = Number(process.env.PORT || 3100);

const { seed } = await import('../../src/seed.js');
const { createApp } = await import('../../src/server.js');
const { get, run, setSetting } = await import('../../src/db.js');
const nav = await import('../../src/lib/navigation.js');
const { applyPlanReferenceRooms } = await import('../../src/lib/plan-reference-rooms.js');
if (!fs.existsSync(LIVE)) await seed({ reset: false });
const app = await createApp();

const graph = JSON.parse(fs.readFileSync(path.join(SERVER, 'data/navigation/r09-pilot-draft.json'), 'utf8'));
const release = path.join(SERVER, 'public/models/cityhall', graph.modelVersion, 'manifest.json');
if (!fs.existsSync(release)) { console.error(`Model release ${graph.modelVersion} is not built: see docs/3d-integration/IMPLEMENTATION_STATUS.md`); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(release, 'utf8'));
if (!nav.revisionByVersion(graph.navigationVersion)) nav.importGraph(graph, null);
nav.registerModelRelease({ modelVersion: graph.modelVersion, baseUrl: `/models/cityhall/${graph.modelVersion}/`, sourceBlendSha256: manifest.sourceBlendSha256 });
if (nav.currentPublication()?.navigation_version !== graph.navigationVersion) nav.publish(graph.navigationVersion, null);
applyPlanReferenceRooms(graph);
setSetting('navigation_preview_unverified', '1');
if (!get(`SELECT 1 FROM kiosks WHERE code = 'PILOT-ENTRANCE'`)) {
  const f1 = get('SELECT id FROM floors WHERE level = 1');
  run(`INSERT INTO kiosks(code, name, floor_id, x, y, z, facing_deg) VALUES ('PILOT-ENTRANCE', 'Pilot origin: inside the main entrance', ?, 3.25, 0, 1.5, 0)`, [f1.id]);
}

app.listen(PORT, () => {
  const u = `http://localhost:${PORT}`;
  console.log(`
DEMO (copy of the live database; nothing you do here changes the real one)

  Pilot routes in the real building (draft preview):
    ${u}/kiosk?kiosk=PILOT-ENTRANCE&preview=1&screen=map
    -> scroll to "Pilot doorways (staff preview)" and touch one

  Same, landscape:  ${u}/kiosk/landscape?kiosk=PILOT-ENTRANCE&preview=1&screen=map
  Normal kiosk:     ${u}/kiosk            (offices say "not checked on site yet": no doorway is verified)
  Admin:            ${u}/admin#/navigation   (sign in with your usual admin account)

Ctrl+C to stop.`);
});
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(0); };
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
