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
const { applyPlanReferenceRooms, planReference } = await import('../src/lib/plan-reference-rooms.js');
const { get, run } = await import('../src/db.js');
const { resolveDestination, planGraphRoute } = await import('../public/shared/nav-graph.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('plan placements create draft room links and repeated setup preserves later office moves', async () => {
  await seed({ reset: false }); await createApp();
  const graph = JSON.parse(fs.readFileSync(new URL('../data/navigation/r09-pilot-draft.json', import.meta.url)));
  importGraph(graph, null);
  assert.equal(applyPlanReferenceRooms(graph).length, 4);
  const loaded = loadGraph(revisionByVersion(graph.navigationVersion).id);
  for (const ref of planReference.rooms) {
    const office = get('SELECT * FROM v_office_current_location WHERE office_id = (SELECT id FROM offices WHERE short_name = ?)', [ref.officeShortName]);
    assert.equal(office.room_code, ref.code);
    const target = { roomId: office.room_id, locationType: office.location_type, officeName: office.office_name };
    const draft = resolveDestination(loaded, target, { preview: true });
    assert.equal(draft.destination.openingId, ref.openingId);
    assert.equal(planGraphRoute({ graph: loaded, kioskCode: 'PILOT-ENTRANCE', destination: draft.destination, allowUnverified: true }).status, 'ok');
    assert.equal(resolveDestination(loaded, target).reason, 'UNVERIFIED_DESTINATION');
  }
  const office = get("SELECT id FROM offices WHERE short_name = 'CAcO'");
  run("UPDATE office_locations SET valid_to = datetime('now') WHERE office_id = ? AND valid_to IS NULL", [office.id]);
  assert.deepEqual(applyPlanReferenceRooms(graph), []);
  assert.equal(get('SELECT count(*) AS n FROM office_locations WHERE office_id = ? AND valid_to IS NULL', [office.id]).n, 0);
});
