// Browser-test harness: a real server on a temporary database, the fixture model release, headless Edge.
// Never touches data/kiosk.sqlite or server/public/models.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(HERE, '../fixtures/models');
const require = createRequire(import.meta.url);

/** Must run before the server modules are imported (they read the env at import time). */
export function isolate(prefix = 'kiosk-e2e-') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.KIOSK_DB = path.join(tmp, 'e2e.sqlite');
  process.env.KIOSK_MODELS_ROOT = FIXTURES;
  return tmp;
}

export async function startServer() {
  const { seed } = await import('../../src/seed.js');
  const { createApp } = await import('../../src/server.js');
  await seed({ reset: false });
  const app = await createApp();
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@kiosk.local', password: 'ChangeMe!2026' }) })).json()).token;
  const api = async (method, url, body) => {
    const res = await fetch(base + '/api' + url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => null);
    if (!res.ok && !api.allowFail) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
    return { status: res.status, body: json };
  };
  return { server, base, api };
}

/**
 * Publishes the fixture graph and maps its doorway to a real ground-floor office.
 * @param {{verifyCalibration?: boolean, verifyEdges?: boolean}} o
 */
export async function publishFixture(api, { verifyCalibration = true, verifyEdges = true, previewOn = false } = {}) {
  const graph = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'fx-test01.graph.json'), 'utf8'));
  await api('POST', '/admin/navigation/import', { graph });
  await api('POST', '/admin/model-releases', { model_version: 'fx-test01' });
  await api('POST', `/admin/navigation/${graph.navigationVersion}/publish`);
  const offices = (await api('GET', '/offices')).body.items;
  const office = offices.find(o => o.location?.room_id && o.location.floor_level === 1);
  await api('PUT', `/admin/navigation/${graph.navigationVersion}/openings/R1-W001-D001`, { room_id: office.location.room_id, status: 'verified' });
  await api('PUT', `/admin/navigation/${graph.navigationVersion}/kiosks/KIOSK-LOBBY-1`, { node_id: 'ENT', verified: true });
  if (verifyEdges) for (const e of ['E1', 'E2', 'E3']) await api('PUT', `/admin/navigation/${graph.navigationVersion}/edges/${e}`, { verified: true });
  if (verifyCalibration) await api('POST', `/admin/calibrations/${graph.calibration.calibrationVersion}/verify`, {
    anchors: ['ENTRANCE_CENTRE', 'LEFT', 'RIGHT_DEEP', 'UPSTAIRS'].map(id => ({ id, measured: [0, 0, 0], residual_m: 0.03 })) });
  if (previewOn) await api('PUT', '/admin/navigation-preview', { enabled: true });
  return { graph, office };
}

export async function browser() {
  const { chromium } = require('playwright-core');
  return chromium.launch({ channel: process.env.E2E_BROWSER || 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}

/** Collects page errors so every test can assert there were none. */
export function watch(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_ABORTED|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
}

export const viewerInfo = page => page.evaluate(async () => (await import('/kiosk/three/building-viewer.js')).getViewer().info());
