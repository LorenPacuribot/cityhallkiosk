import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-reference-'));
process.env.KIOSK_DB = path.join(tmp, 'test.sqlite');
const { seed } = await import('../src/seed.js');
const { createApp } = await import('../src/server.js');
const { importGraph, loadGraph, revisionByVersion } = await import('../src/lib/navigation.js');
const { applyPlanReferenceRooms, planReference, roomCode } = await import('../src/lib/plan-reference-rooms.js');
const { get, all, run } = await import('../src/db.js');
const { resolveDestination, planGraphRoute } = await import('../public/shared/nav-graph.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("the owner's room guide places every office, links its doorways as drafts, and re-running keeps later moves", async () => {
  await seed({ reset: false }); await createApp();
  const graph = JSON.parse(fs.readFileSync(new URL('../data/navigation/r09-pilot-draft.json', import.meta.url)));
  importGraph(graph, null);
  assert.equal(applyPlanReferenceRooms(graph).length, planReference.rooms.length, 'one room per numbered room of the guide');
  const loaded = loadGraph(revisionByVersion(graph.navigationVersion).id);
  const firstRoomOf = new Map();
  for (const ref of planReference.rooms) if (ref.office && !firstRoomOf.has(ref.office)) firstRoomOf.set(ref.office, ref);
  for (const [short, ref] of firstRoomOf) {
    const office = get('SELECT * FROM v_office_current_location WHERE office_id = (SELECT id FROM offices WHERE short_name = ?)', [short]);
    assert.equal(office.room_code, roomCode(ref), `${short} is in ${roomCode(ref)}`);
    const target = { roomId: office.room_id, locationType: office.location_type, officeName: office.office_name };
    const draft = resolveDestination(loaded, target, { preview: true, kioskCode: 'PILOT-ENTRANCE' });
    assert.ok(ref.openings.includes(draft.destination.openingId), `${short} resolves to one of its own doorways`);
    if (short === 'CPDO') assert.equal(draft.destination.openingId, 'R2-W032-D210', 'the nearer of two doorways');
    assert.equal(planGraphRoute({ graph: loaded, kioskCode: 'PILOT-ENTRANCE', destination: draft.destination, allowUnverified: true }).status, 'ok', `route to ${short}`);
    assert.equal(resolveDestination(loaded, target).reason, 'UNVERIFIED_DESTINATION', 'draft door matches never reach the public');
  }
  // City Assessors: room 3 is the main location, room 4 an additional one; both doorways' signs belong to it
  const casso = get("SELECT id FROM offices WHERE short_name = 'CASSO'").id;
  assert.deepEqual(all('SELECT r.code, ol.is_primary FROM office_locations ol JOIN rooms r ON r.id = ol.room_id WHERE ol.office_id = ? AND ol.valid_to IS NULL ORDER BY r.code', [casso]),
    [{ code: 'Room 3', is_primary: 1 }, { code: 'Room 4', is_primary: 0 }]);
  const room4 = get("SELECT id FROM rooms WHERE code = 'Room 4'").id;
  assert.equal(get('SELECT status FROM room_openings WHERE opening_id = ? AND room_id = ?', ['R1-W039-D136', room4]).status, 'draft');
  // offices the owner asked to add are created and placed; offices not in the guide become "location unconfirmed"
  assert.equal(get("SELECT room_code FROM v_office_current_location WHERE office_name = 'Management Information System'").room_code, 'Room 10.2');
  assert.equal(get("SELECT room_code FROM v_office_current_location WHERE office_name = 'Project Monitoring and Evaluation Section'").room_code, 'Room 14');
  for (const short of planReference.unconfirmed.offices) {
    const o = get('SELECT id, location_type FROM offices WHERE short_name = ?', [short]);
    assert.equal(o.location_type, 'unconfirmed', `${short} is location unconfirmed`);
    assert.equal(get('SELECT count(*) AS n FROM office_locations WHERE office_id = ? AND valid_to IS NULL', [o.id]).n, 0);
    assert.ok(get('SELECT count(*) AS n FROM office_locations WHERE office_id = ?', [o.id]).n >= 1, 'history kept');
  }
  // doorways not in the guide stay unresolved
  for (const id of Object.keys(planReference.unmatchedDoorways)) assert.equal(get('SELECT status FROM room_openings WHERE opening_id = ?', [id]).status, 'unresolved');

  const office = get("SELECT id FROM offices WHERE short_name = 'CAcO'");
  run("UPDATE office_locations SET valid_to = datetime('now') WHERE office_id = ? AND valid_to IS NULL", [office.id]);
  assert.deepEqual(applyPlanReferenceRooms(graph), []);
  assert.equal(get('SELECT count(*) AS n FROM office_locations WHERE office_id = ? AND valid_to IS NULL', [office.id]).n, 0);
});
