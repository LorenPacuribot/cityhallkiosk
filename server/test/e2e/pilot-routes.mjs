#!/usr/bin/env node
// Plays the four DRAFT pilot routes in the real r09 building through the actual kiosk UI (staff preview mode)
// and writes screenshots + a JSON report to test-results/pilot/. Temporary database only.
//
//   node test/e2e/pilot-routes.mjs [--layout portrait|landscape]
//
// Every route is unverified: the kiosk shows the draft banner; nothing here is a field verification.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const args = process.argv.slice(2), layout = args.includes('--layout') ? args[args.indexOf('--layout') + 1] : 'portrait';
const OUT = path.join(REPO, 'test-results/pilot');
fs.mkdirSync(OUT, { recursive: true });

process.env.KIOSK_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-pilot-')), 'pilot.sqlite');
const { seed } = await import('../../src/seed.js');
const { createApp } = await import('../../src/server.js');
await seed({ reset: false });
const app = await createApp();
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const token = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@kiosk.local', password: 'ChangeMe!2026' }) })).json()).token;
const api = async (method, url, body) => {
  const r = await fetch(`${base}/api${url}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(j)}`); return j;
};
const graph = JSON.parse(fs.readFileSync(path.join(REPO, 'server/data/navigation/r09-pilot-draft.json'), 'utf8'));
await api('POST', '/admin/navigation/import', { graph });
await api('POST', '/admin/model-releases', { model_version: graph.modelVersion });
await api('POST', `/admin/navigation/${graph.navigationVersion}/publish`);
await api('PUT', '/admin/navigation-preview', { enabled: true });
const floor1 = (await api('GET', '/admin/floors')).items.find(f => f.level === 1);
await api('POST', '/admin/kiosks', { code: 'PILOT-ENTRANCE', name: 'Pilot origin: inside the main entrance', floor_id: floor1.id });

const { chromium } = createRequire(import.meta.url)('playwright-core');
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const viewport = layout === 'landscape' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
const page = await browser.newPage({ viewport, deviceScaleFactor: 0.5 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}/kiosk?idle=0&kiosk=PILOT-ENTRANCE&preview=1&screen=map`, { waitUntil: 'networkidle' });
const report = { createdAt: new Date().toISOString(), layout, modelVersion: graph.modelVersion, navigationVersion: graph.navigationVersion,
  calibration: graph.calibration.calibrationVersion + ' (draft)', note: 'Draft routes from model evidence. Not field verified.', routes: [], errors };

for (const d of graph.destinations) {
  await page.goto(`${base}/kiosk?idle=0&kiosk=PILOT-ENTRANCE&preview=1&screen=map`, { waitUntil: 'networkidle' });
  await page.click(`[data-action="navopening"][data-o="${d.openingId}"]`);
  await page.waitForSelector('#vp canvas', { timeout: 60000 });
  const tag = d.id.toLowerCase();
  const shots = [];
  const snap = async name => { const f = path.join(OUT, `${layout}-${tag}-${name}.png`); await page.screenshot({ path: f }); shots.push(path.relative(REPO, f).split(path.sep).join('/')); };
  await page.click('[data-action="navpause"]'); // freeze at the start for a stable overview
  await snap('1-start-overview');
  const directions = await page.$$eval('.dir', els => els.map(e => e.textContent.replace(/^\s*\d*/, '').trim()));
  const banner = await page.$eval('.draft-route', e => e.textContent.trim()).catch(() => null);
  // stair section (if any) and the arrival, sampled from the route's own timing
  await page.evaluate(async () => { const v = (await import('/kiosk/three/building-viewer.js')).getViewer(); const p = v.player; p.elapsed = p.total * 0.5; p.last = null; v.invalidate(); });
  await page.waitForTimeout(600); await snap('2-midway-overview');
  await page.click('[data-action="navcam"]');
  await page.waitForTimeout(800); await snap('3-midway-walkview');
  await page.evaluate(async () => { const v = (await import('/kiosk/three/building-viewer.js')).getViewer(); const p = v.player; p.elapsed = p.total * 0.93; p.last = null; v.invalidate(); });
  await page.waitForTimeout(800); await snap('4-approach-walkview');
  await page.click('[data-action="navcam"]');
  const info = await page.evaluate(async () => (await import('/kiosk/three/building-viewer.js')).getViewer().info());
  report.routes.push({ destination: d.id, opening: d.openingId, banner, directions, shots, renderer: info });
  await page.click('[data-action="endnav"]');
}
fs.writeFileSync(path.join(OUT, `${layout}-report.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ routes: report.routes.map(r => ({ d: r.destination, steps: r.directions.length, banner: !!r.banner, loads: r.renderer.loads })), errors }, null, 2));
await browser.close(); server.close(); process.exit(errors.length ? 1 : 0);
