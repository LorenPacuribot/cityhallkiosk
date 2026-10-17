// Plain-language summaries and the "Find a service" browse data.
// Run: npm test   (temporary database; never touches data/kiosk.sqlite)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-plain-test-'));
process.env.KIOSK_DB = path.join(tmp, 'test.sqlite');
const { createApp } = await import('../src/server.js');
const { seed } = await import('../src/seed.js');
let server, base;
before(async () => {
  await seed({ reset: false });
  const app = await createApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const j = async (method, url, body, token) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const login = email => j('POST', '/auth/login', { email, password: 'ChangeMe!2026' }).then(r => r.body.token);
const bundle = () => j('GET', '/kiosk/bundle').then(r => r.body);

test('the kiosk lists every published Charter service; citizen-facing only decides where it is listed', async () => {
  const b = await bundle();
  assert.equal(b.services.length, 276);
  const gov = b.services.filter(s => !s.is_citizen_facing);
  assert.ok(gov.length > 50, 'services for other government offices are included');
  assert.equal((await j('GET', `/services/${gov[0].id}?view=0`)).status, 200, 'their detail page opens (QR / phone)');
  const office = b.offices.find(o => o.id === gov[0].office_id);
  assert.equal(office.service_count, b.services.filter(s => s.office_id === office.id).length);
  assert.ok(b.popular_service_ids.every(id => b.services.find(s => s.id === id).is_citizen_facing), '"Most searched" stays public');
});

test('search finds services for other government offices, below public ones', async () => {
  const r = await j('GET', '/search?q=financial%20statements&log=0');
  assert.ok(r.body.results.some(x => /Financial Statements/.test(x.title)));
});

test('prepared drafts load as drafts only: nothing reaches the kiosk before approval', async () => {
  const admin = await login('lgu.admin@kiosk.local');
  const r = await j('POST', '/admin/plain-summaries/import-drafts', {}, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 26 + 276);
  assert.deepEqual(r.body.unknown, []);
  assert.equal((await j('POST', '/admin/plain-summaries/import-drafts', {}, admin)).body.added, 0, 'a second load adds nothing');
  const b = await bundle();
  assert.ok(b.offices.every(o => o.summary === null) && b.services.every(s => s.summary === null));
  const list = (await j('GET', '/admin/plain-summaries?lang=en', null, admin)).body;
  assert.equal(list.counts.draft, 302);
});

test('approve, edit and reject: the public sees only approved wording, and an edit waits for approval', async () => {
  const admin = await login('lgu.admin@kiosk.local');
  const ccro = (await bundle()).offices.find(o => o.short_name === 'CCRO');
  const url = `/admin/plain-summaries/office/${ccro.id}/en`;
  assert.equal((await j('POST', `${url}/approve`, {}, admin)).status, 200);
  let o = (await bundle()).offices.find(x => x.id === ccro.id);
  assert.match(o.summary.en, /Birth, marriage and death certificates/);

  // an office editor of THIS office proposes a change: a draft, the approved line stays public
  const editor = await login('ccro.editor@kiosk.local');
  assert.equal((await j('PUT', url, { text: 'Birth, marriage and death records.' }, editor)).status, 200);
  o = (await bundle()).offices.find(x => x.id === ccro.id);
  assert.match(o.summary.en, /Birth, marriage and death certificates/, 'still the approved wording');
  assert.equal((await j('POST', `${url}/reject`, {}, admin)).status, 200);
  assert.match((await bundle()).offices.find(x => x.id === ccro.id).summary.en, /certificates/);

  // the same editor cannot edit another office; a viewer cannot edit; an editor cannot approve
  const other = (await bundle()).offices.find(x => x.short_name === 'CTO');
  assert.equal((await j('PUT', `/admin/plain-summaries/office/${other.id}/en`, { text: 'x' }, editor)).status, 403);
  assert.equal((await j('PUT', url, { text: 'x' }, await login('viewer@kiosk.local'))).status, 403);
  assert.equal((await j('POST', `${url}/approve`, {}, editor)).status, 403);
  assert.equal((await j('PUT', url, { text: 'x'.repeat(201) }, editor)).status, 400, 'one short line');

  // a translation is approved separately; until then the kiosk falls back to English (client side)
  assert.equal((await j('POST', `/admin/plain-summaries/office/${ccro.id}/ceb/approve`, { text: 'Mga sertipiko sa pagkatawo, kaminyoon ug kamatayon.' }, admin)).status, 200);
  o = (await bundle()).offices.find(x => x.id === ccro.id);
  assert.ok(o.summary.en && o.summary.ceb && !o.summary.fil);
});
