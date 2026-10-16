// Navigation API: migrations, publication, verification flow and route statuses.
// Run: npm test   (uses a temporary database, never touches data/kiosk.sqlite)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-nav-test-'));
process.env.KIOSK_DB = path.join(tmp, 'test.sqlite');

const { createApp } = await import('../src/server.js');
const { seed } = await import('../src/seed.js');
const { registerModelRelease } = await import('../src/lib/navigation.js');
const { migrate } = await import('../src/migrations.js');
const { planGraphRoute } = await import('../public/shared/nav-graph.js');
const pilot = JSON.parse(fs.readFileSync(path.join(HERE, '../data/navigation/r09-pilot-draft.json'), 'utf8'));
let server, base, admin;

const j = async (method, url, body, token = admin) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  await seed({ reset: false });
  const app = await createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  admin = (await j('POST', '/auth/login', { email: 'admin@kiosk.local', password: 'ChangeMe!2026' }, null)).body.token;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const anOffice = async () => (await j('GET', '/offices')).body.items.find(o => o.location?.room_id && o.location.floor_level === 2);

test('migrations are recorded once and are idempotent', async () => {
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(process.env.KIOSK_DB));
  const ids = db.exec('SELECT id FROM schema_migrations')[0].values.flat();
  assert.ok(ids.includes('2026-10-16-001-navigation'));
  assert.deepEqual(migrate(db), [], 'nothing re-applied');
});

test('prototype mode (nothing published): labelled placeholder routes; unknown kiosks are errors, not substitutions', async () => {
  const office = await anOffice();
  const r = await j('GET', `/route?office_id=${office.id}&log=0`);
  assert.equal(r.status, 200);
  assert.equal(r.body.routeSource, 'prototype_placeholder');
  assert.equal(r.body.verification, 'unverified');

  const unknown = await j('GET', `/route?office_id=${office.id}&kiosk=NOT-A-KIOSK&log=0`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.reason, 'UNKNOWN_KIOSK');
  assert.equal((await j('GET', '/kiosk/bundle?kiosk=NOT-A-KIOSK')).status, 404);
  assert.equal((await j('GET', '/kiosk/bundle')).body.navigation, null);

  // the seed has stairs but no lift: a step-free request must not fall back to the stairs
  const sf = await j('GET', `/route?office_id=${office.id}&preference=step_free&log=0`);
  assert.equal(sf.status, 422);
  assert.equal(sf.body.reason, 'NO_STEP_FREE_ROUTE');
});

test('graph import validates and refuses to accept claims of verification', async () => {
  const dry = await j('POST', '/admin/navigation/import', { graph: pilot, dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.edges, pilot.edges.length);

  const forged = structuredClone(pilot); forged.navigationVersion = 'forged-1'; forged.edges[0].verified = true;
  const f = await j('POST', '/admin/navigation/import', { graph: forged });
  assert.equal(f.status, 422);
  assert.match(f.body.detail.problems.join(' '), /cannot mark nodes or edges verified/);

  const viewer = (await j('POST', '/auth/login', { email: 'viewer@kiosk.local', password: 'ChangeMe!2026' }, null)).body.token;
  assert.equal((await j('POST', '/admin/navigation/import', { graph: pilot }, viewer)).status, 403);

  const ok = await j('POST', '/admin/navigation/import', { graph: pilot });
  assert.equal(ok.status, 201);
  assert.equal((await j('POST', '/admin/navigation/import', { graph: pilot })).status, 422, 'revisions are immutable');
  const report = (await j('GET', `/admin/navigation/${pilot.navigationVersion}`)).body.report;
  assert.equal(report.unresolvedOpenings.length, 27);
  assert.equal(report.unmappedSigns, 54);
  assert.equal(report.counts.verifiedEdges, 0);
  assert.ok(report.floorElevationMismatch.some(m => /floor 2/.test(m)), 'database 4.2 m vs model 4.0 m is reported');
  assert.ok(report.routes.every(r => r.strict === 'UNVERIFIED_ROUTE'));
});

test('publication needs a registered model release; then the graph is the only routing authority', async () => {
  const p1 = await j('POST', `/admin/navigation/${pilot.navigationVersion}/publish`);
  assert.equal(p1.status, 422);
  registerModelRelease({ modelVersion: pilot.modelVersion, baseUrl: `/models/cityhall/${pilot.modelVersion}/`, sourceBlendSha256: '6b861ed900092188ac6ff359f4c003d72b437cc375baff6819baa6bd6d648c37' });
  const p2 = await j('POST', `/admin/navigation/${pilot.navigationVersion}/publish`);
  assert.equal(p2.status, 200);

  const bundle = (await j('GET', '/kiosk/bundle')).body;
  assert.equal(bundle.navigation.publication.navigationVersion, pilot.navigationVersion);
  assert.equal(bundle.navigation.calibration.status, 'draft');
  assert.equal(bundle.navigation.model.baseUrl, `/models/cityhall/${pilot.modelVersion}/`);

  // no prototype fallback once a graph is published
  const office = await anOffice();
  const r = await j('GET', `/route?office_id=${office.id}&log=0`);
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'UNVERIFIED_DESTINATION');
  assert.equal(r.body.routeSource, 'navigation_graph');
  assert.equal(r.body.waypoints, undefined);
});

test('draft preview is off by default, labelled when on, and never step-free through unknown segments', async () => {
  const q = '/route?opening_id=R2-W032-D210&kiosk=PILOT-ENTRANCE&preview=1&log=0';
  assert.equal((await j('GET', q)).body.reason, 'UNVERIFIED_DESTINATION', 'server preview switch is off');
  await j('PUT', '/admin/navigation-preview', { enabled: true });
  const r = await j('GET', q);
  assert.equal(r.status, 200);
  assert.equal(r.body.verification, 'unverified');
  assert.equal(r.body.preview, true);
  assert.ok(r.body.edges.some(e => e.id === 'S-LEFT-GF-F2'));
  const sf = await j('GET', q + '&preference=step_free');
  assert.equal(sf.status, 422);
  assert.equal(sf.body.reason, 'NO_STEP_FREE_ROUTE');
  // the real kiosk has no surveyed position in the graph
  assert.equal((await j('GET', '/route?opening_id=R2-W032-D210&kiosk=KIOSK-LOBBY-1&preview=1&log=0')).body.reason, 'UNKNOWN_KIOSK');
  await j('PUT', '/admin/navigation-preview', { enabled: false });
});

test('mapping + field verification produce a verified route; office moves and closures are honoured', async () => {
  const v = pilot.navigationVersion;
  const office = await anOffice();
  const room = office.location.room_id;
  assert.equal((await j('PUT', `/admin/navigation/${v}/openings/R2-W032-D210`, { status: 'verified' })).status, 422, 'verified needs a room');
  assert.equal((await j('PUT', `/admin/navigation/${v}/openings/R2-W032-D210`, { room_id: room, status: 'verified' })).status, 200);
  assert.equal((await j('PUT', `/admin/navigation/${v}/kiosks/KIOSK-LOBBY-1`, { node_id: 'GF-ENTRANCE', verified: true })).status, 200);

  let r = await j('GET', `/route?office_id=${office.id}&log=0`);
  assert.equal(r.body.reason, 'UNVERIFIED_ROUTE', 'mapping alone is not enough: segments are still unverified');

  const path = ['E-ENT-LOBBY', 'E-LOBBY-LSTAIRAPP', 'E-LSTAIRAPP-LFOOT', 'S-LEFT-GF-F2', 'E-F2LTOP-FOYER', 'E-F2LFOYER-C1', 'E-F2LC1-D210'];
  for (const e of path) assert.equal((await j('PUT', `/admin/navigation/${v}/edges/${e}`, { verified: true })).status, 200);
  assert.equal((await j('PUT', `/admin/navigation/${v}/edges/S-LEFT-GF-F2`, { step_free: true })).status, 422, 'stairs cannot be step-free');
  r = await j('GET', `/route?office_id=${office.id}&log=0`);
  assert.equal(r.status, 200);
  assert.equal(r.body.verification, 'verified');
  assert.equal(r.body.to.room_id, room);
  assert.equal(r.body.originKioskCode, 'KIOSK-LOBBY-1');

  // server and kiosk agree: the kiosk plans from the bundle's graph with the same module
  const bundle = (await j('GET', '/kiosk/bundle')).body;
  const opening = bundle.navigation.graph.openings.find(o => o.openingId === 'R2-W032-D210');
  const local = planGraphRoute({ graph: bundle.navigation.graph, kioskCode: 'KIOSK-LOBBY-1', destination: { nodeId: opening.approachNodeId, roomId: room, doorPoint: opening.doorPoint, name: office.name, code: opening.roomCode } });
  assert.deepEqual(local.waypoints, r.body.waypoints);
  assert.deepEqual(local.directions.map(d => d.key), r.body.directions.map(d => d.key));

  // closure
  await j('PUT', `/admin/navigation/${v}/edges/E-F2LC1-D210`, { closed: true, closed_reason: 'Floor works' });
  assert.equal((await j('GET', `/route?office_id=${office.id}&log=0`)).body.reason, 'ROUTE_CLOSED');
  await j('PUT', `/admin/navigation/${v}/edges/E-F2LC1-D210`, { closed: false });

  // office moves to a room with no verified doorway: the destination follows the office, the old door is not reused
  const other = (await j('GET', '/admin/rooms')).body.items.find(x => x.id !== room && x.room_type === 'office');
  assert.equal((await j('POST', `/admin/offices/${office.id}/move`, { room_id: other.id, note: 'test move' })).status, 200);
  r = await j('GET', `/route?office_id=${office.id}&log=0`);
  assert.equal(r.body.reason, 'UNVERIFIED_DESTINATION');
});

test('calibration verification needs four measured anchors within 0.10 m', async () => {
  const c = await j('POST', `/admin/calibrations/${pilot.calibration.calibrationVersion}/verify`, { anchors: [{ id: 'ENTRANCE_CENTRE', measured: [0, 0, 0], residual_m: 0.02 }] });
  assert.equal(c.status, 422);
});

test('rollback restores the previous publication', async () => {
  const second = structuredClone(pilot); second.navigationVersion = 'r09-nav-pilot-draft-2';
  assert.equal((await j('POST', '/admin/navigation/import', { graph: second })).status, 201);
  assert.equal((await j('POST', `/admin/navigation/${second.navigationVersion}/publish`)).status, 200);
  assert.equal((await j('GET', '/kiosk/bundle')).body.navigation.publication.navigationVersion, second.navigationVersion);
  const rb = await j('POST', '/admin/navigation/rollback');
  assert.equal(rb.body.nowPublished, pilot.navigationVersion);
  assert.equal((await j('GET', '/kiosk/bundle')).body.navigation.publication.navigationVersion, pilot.navigationVersion);
});
