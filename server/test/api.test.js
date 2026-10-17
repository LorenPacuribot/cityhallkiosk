// Run: npm test   (uses a temporary database, never touches data/kiosk.sqlite)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-test-'));
process.env.KIOSK_DB = path.join(tmp, 'test.sqlite');

const { createApp } = await import('../src/server.js');
const { seed } = await import('../src/seed.js');
let server, base;

before(async () => {
  await seed({ reset: false }); // fresh DB in temp dir
  const app = await createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const j = async (method, url, body, token) => {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const login = async (email) => (await j('POST', '/auth/login', { email, password: 'ChangeMe!2026' })).body.token;

test('search tolerates typos and local words', async () => {
  const a = await j('GET', '/search?q=cedula&log=0');
  assert.match(a.body.results[0].title, /Cedula/);
  const b = await j('GET', '/search?q=birth%20certifcate&log=0');
  assert.ok(b.body.count > 0);
  const c = await j('GET', '/search?q=passport&log=0');
  assert.equal(c.body.count, 0);
});

test('service detail includes requirements, steps and live location with xyz', async () => {
  const s = (await j('GET', '/search?q=cedula&log=0')).body.results[0];
  const d = await j('GET', `/services/${s.id}?view=0`);
  assert.equal(d.status, 200);
  assert.ok(d.body.requirements.length > 0);
  assert.ok(d.body.steps.length > 0);
  assert.equal(typeof d.body.location.approach.x, 'number');
});

test('room coordinates are dynamic: updating x,y,z changes destinations and bumps content version', async () => {
  const token = await login('admin@kiosk.local');
  const v1 = (await j('GET', '/kiosk/version')).body.content_version;
  const room = (await j('GET', '/rooms')).body.items.find(r => r.code === '1F-104');
  const upd = await j('PUT', `/admin/rooms/${room.id}`, { x: -20.5, y: 0, z: 23.25, approach_x: -20.5, approach_z: 17.1 }, token);
  assert.equal(upd.status, 200);
  const dest = (await j('GET', '/destinations')).body.items.find(d => d.room_code === '1F-104');
  assert.equal(dest.x, -20.5);
  assert.equal(dest.approach_z, 17.1);
  const v2 = (await j('GET', '/kiosk/version')).body.content_version;
  assert.ok(v2 > v1);
});

test('moving an office keeps history and updates where its services point', async () => {
  const token = await login('lgu.admin@kiosk.local');
  const offices = (await j('GET', '/admin/offices', null, token)).body.items;
  const ccro = offices.find(o => o.short_name === 'CCRO');
  const newRoom = await j('POST', '/admin/rooms', { floor_id: ccro.location.floor_id, code: '1F-120', name: 'Temporary office', x: 40, z: 10, approach_x: 40, approach_z: 15.2 }, token);
  assert.equal(newRoom.status, 201);
  const mv = await j('POST', `/admin/offices/${ccro.id}/move`, { room_id: newRoom.body.id, note: 'Renovation' }, token);
  assert.equal(mv.body.location.room_code, '1F-120');
  const hist = (await j('GET', `/admin/offices/${ccro.id}/history`, null, token)).body.items;
  assert.equal(hist.length, 2);
  assert.equal(hist.filter(h => h.valid_to === null).length, 1);
  const route = await j('GET', `/route?office_id=${ccro.id}&log=0`);
  assert.equal(route.body.to.room_code, '1F-120');
  // cannot delete a room that has an office in it
  const del = await j('DELETE', `/admin/rooms/${newRoom.body.id}`, null, token);
  assert.equal(del.status, 400);
});

test('Unity marker sync updates coordinates by room code', async () => {
  const token = await login('admin@kiosk.local');
  const r = await j('POST', '/admin/rooms/sync-from-unity', { items: [{ code: '2F-201', x: -19, y: 4.5, z: 9.5, approach_x: -19, approach_y: 4.5, approach_z: 14.9, facing_deg: 180 }, { code: 'NOPE' }] }, token);
  assert.deepEqual(r.body.updated, ['2F-201']);
  assert.deepEqual(r.body.unknown, ['NOPE']);
  const room = (await j('GET', '/rooms')).body.items.find(x => x.code === '2F-201');
  assert.equal(room.y, 4.5);
  assert.equal(room.coord_source, 'unity_sync');
});

test('room reassignment requires an occupancy choice, swaps atomically, and preserves displaced history', async () => {
  const token = await login('lgu.admin@kiosk.local');
  const floor = (await j('GET', '/admin/floors', null, token)).body.items[0];
  const rooms = [];
  for (const code of ['TEST-A', 'TEST-B']) rooms.push((await j('POST', '/admin/rooms', { floor_id: floor.id, code, name: code }, token)).body);
  const offices = [];
  for (const name of ['Assignment Accounting', 'Assignment Mayor', 'Assignment Shared']) offices.push((await j('POST', '/admin/offices', { name, location_type: 'unconfirmed' }, token)).body);
  const move = (office, room, body = {}) => j('POST', `/admin/offices/${office.id}/move`, { room_id: room.id, ...body }, token);
  await move(offices[0], rooms[0]); await move(offices[1], rooms[1]);
  const version = (await j('GET', '/kiosk/version')).body.content_version;
  assert.equal((await move(offices[1], rooms[0])).status, 409, 'occupied room never silently becomes shared');
  assert.equal((await move(offices[1], rooms[0], { occupancy: 'swap', expected_room_id: null })).status, 409, 'stale source rejected');
  assert.equal((await move(offices[1], rooms[0], { occupancy: 'swap', expected_occupant_ids: [] })).status, 409, 'stale target rejected');
  assert.equal((await j('GET', '/kiosk/version')).body.content_version, version, 'rejected edits do not publish');
  assert.equal((await move(offices[1], rooms[0], { occupancy: 'swap', expected_room_id: rooms[1].id, expected_occupant_ids: [offices[0].id], note: 'Exchange rooms' })).status, 200);
  const current = async id => (await j('GET', '/admin/offices', null, token)).body.items.find(o => o.id === id);
  assert.equal((await current(offices[0].id)).location.room_id, rooms[1].id);
  assert.equal((await current(offices[1].id)).location.room_id, rooms[0].id);
  assert.equal((await move(offices[2], rooms[0], { occupancy: 'share' })).status, 200);
  const occupied = (await j('GET', '/admin/floors', null, token)).body.items.flatMap(f => f.rooms).find(r => r.id === rooms[0].id);
  assert.match(occupied.occupant, /Assignment Mayor/); assert.match(occupied.occupant, /Assignment Shared/);
  assert.equal((await move(offices[0], rooms[0], { occupancy: 'swap' })).status, 400, 'ambiguous shared-room swap rejected');
  assert.equal((await move(offices[0], rooms[0], { occupancy: 'replace', note: 'Reassign room' })).status, 200);
  for (const office of offices.slice(1)) {
    const o = await current(office.id);
    assert.equal(o.location_type, 'unconfirmed'); assert.equal(o.location.room_id, null);
    const hist = (await j('GET', `/admin/offices/${o.id}/history`, null, token)).body.items;
    assert.ok(hist.length); assert.ok(hist.every(h => h.valid_to !== null));
  }
  const hist = (await j('GET', `/admin/offices/${offices[0].id}/history`, null, token)).body.items;
  assert.equal(hist.filter(h => h.valid_to === null).length, 1);
  assert.equal(hist[0].note, 'Reassign room');
  assert.equal((await j('POST', `/admin/offices/${offices[0].id}/move`, { room_id: rooms[1].id }, await login('viewer@kiosk.local'))).status, 403);
});

test('office editor proposals wait for approval; kiosk keeps the published version', async () => {
  const editor = await login('ccro.editor@kiosk.local');
  const admin = await login('lgu.admin@kiosk.local');
  const me = (await j('GET', '/auth/me', null, editor)).body;
  const list = (await j('GET', `/admin/services?office_id=${me.office_id}`, null, editor)).body.items;
  const sid = list[0].id;
  const original = (await j('GET', `/services/${sid}?view=0`)).body.display_title;
  const p = await j('PUT', `/admin/services/${sid}`, { plain_title: 'Proposed new title' }, editor);
  assert.match(p.body.message, /approval/);
  assert.equal((await j('GET', `/services/${sid}?view=0`)).body.display_title, original);
  const a = await j('POST', `/admin/services/${sid}/approve`, {}, admin);
  assert.equal(a.status, 200);
  assert.equal((await j('GET', `/services/${sid}?view=0`)).body.display_title, 'Proposed new title');
  // editors cannot touch another office
  const other = (await j('GET', '/admin/services?office_id=1', null, editor)).body.items[0];
  const denied = await j('PUT', `/admin/services/${other.id}`, { plain_title: 'x' }, editor);
  assert.equal(denied.status, 403);
});

test('roles: viewer cannot edit, wrong password is rejected', async () => {
  const viewer = await login('viewer@kiosk.local');
  const r = await j('PUT', '/admin/rooms/1', { x: 1 }, viewer);
  assert.equal(r.status, 403);
  const bad = await j('POST', '/auth/login', { email: 'admin@kiosk.local', password: 'wrong' });
  assert.equal(bad.status, 401);
});

test('feedback and search logs feed the dashboard', async () => {
  await j('GET', '/search?q=zzzz-unknown');
  await j('POST', '/feedback', { helpful: 0, reason: 'unclear', kiosk_code: 'KIOSK-LOBBY-1' });
  const token = await login('viewer@kiosk.local');
  const d = (await j('GET', '/admin/dashboard', null, token)).body;
  assert.ok(d.no_result_queries.some(q => q.query === 'zzzz-unknown'));
  assert.ok(d.helpful_30d.total >= 1);
});

test('Unity endpoints: kiosk position and destinations always carry numeric xyz', async () => {
  const k = await j('GET', '/kiosks/KIOSK-LOBBY-1');
  assert.equal(k.status, 200);
  for (const f of ['x', 'y', 'z', 'facing_deg', 'floor_level']) assert.equal(typeof k.body[f], 'number');
  assert.equal((await j('GET', '/kiosks/NOPE')).status, 404);
  const d = await j('GET', '/destinations');
  assert.ok(d.body.items.length > 10);
  for (const it of d.body.items) for (const f of ['x', 'y', 'z', 'approach_x', 'approach_y', 'approach_z', 'facing_deg']) assert.equal(typeof it[f], 'number', `${it.room_code}.${f}`);
});
