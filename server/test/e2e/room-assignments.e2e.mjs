import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, startServer, browser, watch } from './harness.mjs';

const tmp = isolate('room-assignments-');
let srv, b;
before(async () => { srv = await startServer(); b = await browser(); });
after(async () => { await b?.close(); srv?.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('admin swaps offices from the room list, reviews the change, and can read all four reference plans', async () => {
  const page = await b.newPage({ viewport: { width: 1440, height: 1000 } }), errors = watch(page);
  const offices = (await srv.api('GET', '/admin/offices')).body.items;
  const mayor = offices.find(o => o.short_name === 'CMO'), accounting = offices.find(o => o.short_name === 'CAcO');
  await page.goto(srv.base + '/admin#/assignments');
  await page.locator('[name=password]').fill('ChangeMe!2026');
  await page.locator('#login button').click();
  await page.getByRole('heading', { name: 'Room assignments', exact: true }).waitFor();
  await page.locator('.reference-plans summary').click();
  assert.equal(await page.locator('.reference-plan').count(), 4);
  await page.waitForFunction(() => [...document.querySelectorAll('.reference-plan img')].every(i => i.complete && i.naturalWidth > 0));
  for (const link of await page.locator('.reference-plan').evaluateAll(els => els.map(e => e.getAttribute('href')))) {
    const response = await page.request.get(srv.base + link);
    assert.equal(response.status(), 200); assert.match(response.headers()['content-type'], /application\/pdf/);
  }
  await page.locator('.reference-plans summary').click();
  await page.locator('[name=q]').fill('account');
  await page.locator('#assignment-filter button').click();
  await page.locator(`[data-room-row="${accounting.location.room_id}"] [data-act=assignoffice]`).click();
  await page.locator('#assignment-form [name=office_id]').selectOption(String(mayor.id));
  assert.equal(await page.locator('#assignment-save').isDisabled(), true, 'requires explicit choice');
  await page.locator('[name=occupancy]').selectOption('swap');
  assert.match(await page.locator('#assignment-review').innerText(), new RegExp(accounting.location.room_code));
  assert.match(await page.locator('#assignment-review').innerText(), new RegExp(mayor.location.room_code));
  await page.locator('[name=note]').fill('Updated room plan');
  const out = path.resolve('../test-results/admin'); fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, 'swap-review.png') });
  await page.locator('#assignment-save').click();
  await page.locator('#assignment-form').waitFor({ state: 'detached' });
  const updated = (await srv.api('GET', '/admin/offices')).body.items;
  assert.equal(updated.find(o => o.id === mayor.id).location.room_id, accounting.location.room_id);
  assert.equal(updated.find(o => o.id === accounting.id).location.room_id, mayor.location.room_id);
  await page.goto(`${srv.base}/admin#/offices/${mayor.id}`);
  await page.getByRole('heading', { name: 'Location history' }).waitFor();
  assert.match(await page.locator('main').innerText(), /Updated room plan/);
  await page.screenshot({ path: path.join(out, 'updated-office-history.png') });
  assert.deepEqual(errors, []);
  await page.close();
});
