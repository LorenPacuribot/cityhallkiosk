#!/usr/bin/env node
// Renders the real floor plans of an installed model release (one image per navigation floor) with the kiosk's own
// viewer in headless Edge, and writes them with plans.json to <models>/plans/<modelVersion>/.
// The kiosk minimap, the 2D fallback, the map screen and the phone page all use these images.
//
//   node tools/model/render-plans.mjs                       (r09 pilot graph -> server/public/models/plans/r09-web02/)
//   node tools/model/render-plans.mjs --fixture             (test fixture -> server/test/fixtures/models/plans/fx-test01/)
//   options: --graph <file> --bounds minX,maxX,minZ,maxZ --px <pixels per metre> --cut <m above floor> --force
//
// Plans are derived data: they carry the release's manifest hash, and the kiosk ignores a plan set whose model
// version differs from the published release. Uses a temporary database only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const SERVER = path.join(REPO, 'server');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const fixture = argv.includes('--fixture');
const modelsRoot = fixture ? path.join(SERVER, 'test/fixtures/models') : path.join(SERVER, 'public/models');
const graphFile = opt('--graph', fixture ? path.join(modelsRoot, 'fx-test01.graph.json') : path.join(SERVER, 'data/navigation/r09-pilot-draft.json'));
const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const modelVersion = graph.modelVersion;
const releaseDir = path.join(modelsRoot, 'cityhall', modelVersion);
const manifestPath = path.join(releaseDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) { console.error(`Release ${modelVersion} is not installed at ${releaseDir}`); process.exit(1); }
const manifestSha = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
const out = path.join(modelsRoot, 'plans', modelVersion);
if (fs.existsSync(path.join(out, 'plans.json')) && !argv.includes('--force')) { console.error(`${out} exists (use --force to re-render)`); process.exit(1); }
const pxPerM = Number(opt('--px', fixture ? 24 : 14)), cut = Number(opt('--cut', 1.3));
const boundsArg = opt('--bounds', null)?.split(',').map(Number);

// floor elevations from the graph's own nodes (the model's levels, not the database's)
const levels = graph.floors.map(f => {
  const ys = graph.nodes.filter(n => n.floor === f.level).map(n => n.y);
  return { level: f.level, name: f.name, elevation: ys.length ? Math.min(...ys) : 0 };
});

process.env.KIOSK_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-plans-')), 'plans.sqlite');
process.env.KIOSK_MODELS_ROOT = modelsRoot;
const { seed } = await import(pathToFileURL(path.join(SERVER, 'src/seed.js')).href);
const { createApp } = await import(pathToFileURL(path.join(SERVER, 'src/server.js')).href);
await seed({ reset: false });
const app = await createApp();
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = createRequire(path.join(SERVER, 'package.json'))('playwright-core');
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER || 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
await page.goto(`${base}/kiosk?idle=0`, { waitUntil: 'networkidle' });

const result = await page.evaluate(async ({ modelVersion, calibration, levels, pxPerM, cut, boundsArg, fixture }) => {
  const { getViewer } = await import('/kiosk/three/building-viewer.js');
  const { renderFloorPlan, buildingBounds } = await import('/kiosk/three/plan-renderer.js');
  const viewer = getViewer();
  await viewer.ensureModel({ model: { modelVersion, baseUrl: `/models/cityhall/${modelVersion}/` }, calibration }, { allowDraftCalibration: true });
  let bounds;
  if (boundsArg) bounds = { minX: boundsArg[0], maxX: boundsArg[1], minZ: boundsArg[2], maxZ: boundsArg[3] };
  else {
    // the building footprint: the wings' upper-floor shells (the ground-floor meshes also carry the forecourt)
    let b = fixture ? null : buildingBounds(viewer, name => /^STATIC_(West|East)_F2$/.test(name));
    if (!b || !Number.isFinite(b.minX)) b = buildingBounds(viewer);
    const m = 1.5;
    bounds = { minX: Math.floor(b.minX - m), maxX: Math.ceil(b.maxX + m), minZ: Math.floor(b.minZ - m), maxZ: Math.ceil(b.maxZ + m) };
  }
  const plans = [];
  for (const l of levels) {
    const r = renderFloorPlan(viewer, { elevation: l.elevation, cut, bounds, pxPerM });
    plans.push({ ...l, width: r.width, height: r.height, segments: r.segments, dataUrl: r.canvas.toDataURL('image/webp', 0.9) });
  }
  return { bounds, plans };
}, { modelVersion, calibration: graph.calibration, levels, pxPerM, cut, boundsArg, fixture });

fs.mkdirSync(out, { recursive: true });
const record = { schemaVersion: 1, modelVersion, sourceManifestSha256: manifestSha, calibrationVersion: graph.calibration.calibrationVersion,
  generatedAt: new Date().toISOString(), generator: 'tools/model/render-plans.mjs', cutHeightM: cut, pxPerM, bounds: result.bounds,
  note: 'Top-down render of the model below the cut with the section lines of the walls. Doors and dynamic signs are omitted.',
  levels: [] };
for (const p of result.plans) {
  const file = `floor-${p.level}.webp`;
  const bytes = Buffer.from(p.dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(path.join(out, file), bytes);
  record.levels.push({ level: p.level, name: p.name, elevation: p.elevation, file, width: p.width, height: p.height, bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sectionSegments: p.segments });
}
fs.writeFileSync(path.join(out, 'plans.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ out: path.relative(REPO, out), bounds: record.bounds, levels: record.levels.map(l => ({ level: l.level, px: `${l.width}x${l.height}`, kb: Math.round(l.bytes / 1024), segments: l.sectionSegments })), errors }, null, 2));
await browser.close(); server.close();
process.exit(errors.length ? 1 : 0);
