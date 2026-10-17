#!/usr/bin/env node
// Renders the real r09 release in headless Edge from each exported VIEW_ marker (16:9, recorded vertical FOV)
// and writes test-results/reference/<marker>.png plus report.json (renderer counters, load time, versions).
//
//   node test/e2e/reference-views.mjs [--width 1280] [--calibration path/to/graph.json]
//
// Uses a temporary database; the calibration comes from the draft pilot graph (clearly reported as draft).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const W = Number(opt('--width', 1280)), H = Math.round(W * 9 / 16);
const graph = JSON.parse(fs.readFileSync(opt('--calibration', path.join(REPO, 'server/data/navigation/r09-pilot-draft.json')), 'utf8'));
const OUT = path.join(REPO, 'test-results/reference');
fs.mkdirSync(OUT, { recursive: true });

process.env.KIOSK_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-ref-')), 'ref.sqlite');
const { seed } = await import('../../src/seed.js');
const { createApp } = await import('../../src/server.js');
await seed({ reset: false });
const app = await createApp();
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = createRequire(import.meta.url)('playwright-core');
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}/kiosk?idle=0`, { waitUntil: 'networkidle' });

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'server/public/models/cityhall/r09-web03/manifest.json'), 'utf8'));
// interior walkthrough cameras only: the exterior composition is not part of the kiosk (the welcome photo shows the outside)
const markers = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, 'server/public/models/cityhall/r09-web03/viewpoints.json'), 'utf8')).viewpoints).filter(m => !/Front_Composition/.test(m));
const load = await page.evaluate(async ({ calibration, W, H }) => {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;z-index:99999;background:#000`;
  document.body.appendChild(host);
  const { getViewer } = await import('/kiosk/three/building-viewer.js');
  const v = getViewer();
  const t0 = performance.now();
  await v.ensureModel({ model: { modelVersion: 'r09-web03', baseUrl: '/models/cityhall/r09-web03/' }, calibration }, { allowDraftCalibration: true });
  const loadMs = performance.now() - t0;
  v.renderer.setPixelRatio(1);
  v.attach(host);
  return { loadMs: Math.round(loadMs) };
}, { calibration: graph.calibration, W, H });

const shots = [];
for (const marker of markers) {
  const r = await page.evaluate(async ({ marker, aspect }) => {
    const v = (await import('/kiosk/three/building-viewer.js')).getViewer();
    v.setViewpoint(marker, { aspect });
    const t = performance.now();
    v.renderer.render(v.scene, v.camera); // first render of a view compiles/uploads; time it
    const firstMs = performance.now() - t;
    const t2 = performance.now();
    for (let i = 0; i < 5; i++) v.renderer.render(v.scene, v.camera);
    v.invalidate();
    return { firstFrameMs: Math.round(firstMs), avgFrameMs: +((performance.now() - t2) / 5).toFixed(1), ...v.info() };
  }, { marker, aspect: 16 / 9 });
  await page.waitForTimeout(300);
  const file = path.join(OUT, `${marker}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: W, height: H } });
  shots.push({ marker, file: path.relative(REPO, file).split(path.sep).join('/'), ...r });
}
const report = {
  createdAt: new Date().toISOString(), modelVersion: manifest.modelVersion, sourceBlendSha256: manifest.sourceBlendSha256,
  calibration: { version: graph.calibration.calibrationVersion, status: graph.calibration.status, note: 'draft, model-derived; the VIEW_ markers are placed through the same matrix as the GLB, so reference views do not depend on it' },
  resolution: `${W}x${H}`, renderer: 'headless Microsoft Edge, ANGLE SwiftShader (software). NOT the kiosk GPU: timings are not kiosk performance.',
  ...load, shots, errors,
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, shots: shots.map(s => ({ marker: s.marker, firstFrameMs: s.firstFrameMs, avgFrameMs: s.avgFrameMs, calls: s.calls, triangles: s.triangles, textures: s.textures })) }, null, 2));
await browser.close(); server.close(); process.exit(errors.length ? 1 : 0);
