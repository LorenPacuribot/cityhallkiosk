// Public journeys and accessibility on an isolated DB. Never publishes to the live kiosk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { isolate, startServer, publishFixture, browser, watch } from './harness.mjs';
const require = createRequire(import.meta.url);
const tmp = isolate('kiosk-release-');
let srv, b, fx, service;
before(async () => {
  srv = await startServer(); fx = await publishFixture(srv.api); b = await browser();
  const bundle = await (await fetch(`${srv.base}/api/kiosk/bundle`)).json();
  service = bundle.services.find(s => /Community Tax Certificate/i.test(s.title));
});
after(async () => { await b?.close(); srv?.server.close(); fs.rmSync(tmp, { recursive:true, force:true }); });
const ready = page => page.waitForSelector('.screen[data-page]');
async function open(page,path='') { await page.goto(`${srv.base}/kiosk${path}${path.includes('?')?'&':'?'}idle=0`); await ready(page); }
async function audit(page) {
  await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
  return page.evaluate(async () => (await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','best-practice']}})).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})));
}
async function noOverflow(page) {
  const bad = await page.evaluate(() => [...document.querySelectorAll('button,input,.content')].filter(e => {
    const r=e.getBoundingClientRect(); return r.width>0 && (r.right>innerWidth+1 || r.left < -1);
  }).map(e => e.outerHTML.slice(0,160)));
  assert.deepEqual(bad,[],'no horizontal clipping');
}

test('canonical URLs, refresh, Back/Forward, list scroll and reset are reliable',async()=>{
  const p=await b.newPage({viewport:{width:1366,height:768}}), errors=watch(p);
  await open(p); assert.ok(await p.$('.welcome-cover img')); // the cover comes first
  await p.click('.welcome-start'); await p.waitForSelector('.home-search');
  await p.click('[data-action="offices"]'); await p.waitForURL('**/kiosk/offices?*');
  await p.locator('.content').evaluate(e=>e.scrollTop=240);
  const row=p.locator('[data-action="office"]').first(), id=await row.getAttribute('data-id');
  await row.click(); await p.waitForURL(`**/offices/${id}?*`);
  await p.reload(); await ready(p);
  await p.click('[data-action="service"]'); await p.waitForURL('**/services/*');
  await p.goBack(); await p.waitForSelector('.office-detail');
  await p.goForward(); await p.waitForSelector('.service-detail');
  await p.click('[data-action="back"]'); await p.waitForSelector('.office-detail');
  await p.click('[data-action="back"]'); await p.waitForSelector('.office-directory');
  await p.locator('.tb-btn[data-action="home"]').click(); await p.waitForSelector('.home-search');
  await p.goBack(); await p.waitForSelector('.home-search, .welcome-cover'); // previous visitor state cannot return
  assert.deepEqual(errors,[]); await p.close();
});

test('search accepts physical typing, submits once, and ignores late responses after Home',async()=>{
  const p=await b.newPage(); await open(p,'/search');
  await p.fill('#service-search','cedula'); await p.press('#service-search','Enter');
  await p.waitForURL('**/results?*'); assert.match(await p.textContent('h1'),/cedula/i);
  await p.reload(); await ready(p); assert.ok(await p.$('[data-action="service"]'));
  await open(p,'/search');
  await p.route('**/api/search?*',async r=>{ await new Promise(resolve=>setTimeout(resolve,700)); await r.continue(); });
  await p.fill('#service-search','tax'); await p.press('#service-search','Enter');
  await p.locator('.tb-btn[data-action="home"]').click(); await p.waitForTimeout(1200);
  assert.ok(await p.$('.home-search')); await p.close();
});

test('QR dialog traps focus, supports Escape, restores focus and passes accessibility checks',async()=>{
  const p=await b.newPage({viewport:{width:1366,height:768}}); await open(p,`/services/${service.id}`);
  await p.click('[data-action="qr"]');
  assert.deepEqual(await audit(p),[]);
  for(let i=0;i<6;i++) { await p.keyboard.press('Tab'); assert.equal(await p.evaluate(()=>!!document.activeElement.closest('[role="dialog"]')),true); }
  await p.keyboard.press('Escape'); assert.equal(await p.$('.overlay'),null);
  assert.equal(await p.evaluate(()=>document.activeElement.dataset.action),'qr');
  assert.equal(await p.locator('.screen').evaluate(e=>e.inert),false); await p.close();
});

test('idle warning can be continued and reset clears visitor state',async()=>{
  const p=await b.newPage(); await p.clock.install();
  await p.goto(`${srv.base}/kiosk/search?idle=2`); await ready(p);
  await p.fill('#service-search','private query');
  await p.clock.fastForward(2100); await p.waitForSelector('[role="alertdialog"]');
  await p.click('[data-action="stillhere"]'); assert.equal(await p.$('.overlay'),null);
  await p.clock.fastForward(2100); await p.waitForSelector('[role="alertdialog"]');
  await p.clock.fastForward(16000); await p.waitForSelector('.welcome-cover'); // privacy reset returns to the cover
  await p.click('.welcome-start'); await p.waitForSelector('.home-search');
  await p.click('[data-action="search"]'); assert.equal(await p.inputValue('#service-search'),'');
  await p.close();
});

test('responsive public pages and large-text languages have no accessibility violations or horizontal clipping',async()=>{
  for (const [width,height] of [[1366,768],[1920,1080],[1080,1920],[390,844],[683,384]]) {
    const p=await b.newPage({viewport:{width,height}}), errors=watch(p);
    for(const path of ['', '/offices', `/offices/${service.office_id}`, `/services/${service.id}`, '/search', '/results?q=zznotfound', '/map', '/services/999999']) {
      await open(p,path); await noOverflow(p);
      assert.deepEqual(await audit(p),[],`${width}x${height} ${path}`);
    }
    await open(p,`/services/${service.id}`);
    await p.click('[data-action="large"]');
    for(const lang of ['fil','ceb','en']) {
      await p.click(`[data-lang="${lang}"]`); await noOverflow(p);
      assert.deepEqual(await audit(p),[],`${width} ${lang} large text`);
    }
    // Small/zoomed screens must retain a usable vertical reading area.
    const heightAvailable=await p.locator('.content').evaluate(e=>e.clientHeight);
    assert.ok(heightAvailable>150,`content area ${heightAvailable}px`);
    assert.deepEqual(errors,[]); await p.close();
  }
});

test('reduced motion pauses the real 3D walk and minimap never overlaps its viewport',async()=>{
  const p=await b.newPage({viewport:{width:1366,height:768},reducedMotion:'reduce'}), errors=watch(p);
  await open(p,`/offices/${fx.office.id}`); await p.click('[data-action="navoffice"]');
  await p.waitForSelector('#vp canvas');
  await p.waitForFunction(()=>/Resume/.test(document.querySelector('#btn-pause')?.textContent));
  const boxes=await p.evaluate(()=>['#vp','.minimap'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));
  assert.ok(boxes[0].right <= boxes[1].left || boxes[0].bottom <= boxes[1].top);
  assert.equal(await p.evaluate(async()=>(await import('/kiosk/three/building-viewer.js')).getViewer().player.paused),true);
  assert.deepEqual(await audit(p),[]);
  await p.reload(); await p.waitForSelector('#vp canvas');
  assert.match(new URL(p.url()).pathname,/directions/);
  assert.deepEqual(errors,[]); await p.close();
});

test('cached information works offline and missing assets return actual 404s',async()=>{
  const p=await b.newPage(); await open(p,`/services/${service.id}`);
  await p.route('**/api/**',r=>r.abort()); await p.reload(); await ready(p);
  assert.ok(await p.$('.banner.warning')); assert.ok(await p.$('.service-detail'));
  await p.locator('.tb-btn[data-action="home"]').click(); await p.click('[data-action="search"]');
  await p.fill('#service-search','cedula'); await p.press('#service-search','Enter'); await p.waitForURL('**/results?*');
  assert.ok(await p.$('[data-action="service"]'));
  const missing=await fetch(`${srv.base}/kiosk/missing-module.js`); assert.equal(missing.status,404);
  const deep=await fetch(`${srv.base}/kiosk/services/${service.id}`); assert.equal(deep.status,200);
  assert.match(deep.headers.get('cache-control'),/no-cache/);
  await p.close();
});

test('the City Hall logo returns to the cover and clears the visitor state', async () => {
  const p = await b.newPage(); await open(p, '/search');
  await p.fill('#service-search', 'private query');
  await p.click('.brand-home'); await p.waitForSelector('.welcome-cover');
  await p.click('.welcome-start'); await p.waitForSelector('.home-search');
  await p.click('[data-action="search"]'); assert.equal(await p.inputValue('#service-search'), '');
  await p.close();
});
