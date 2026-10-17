// Browser integration tests for the real-building navigation (headless Edge via playwright-core).
// Run from server/:  npm run test:e2e        (fixture release only; never touches the live database)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isolate, startServer, publishFixture, browser, watch, viewerInfo, FIXTURES } from './harness.mjs';
import { decodePng } from '../../../tools/model/png.mjs';

const tmp = isolate();
let srv, b, ctx;
const RESULTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../test-results/e2e');
fs.mkdirSync(RESULTS, { recursive: true });

before(async () => {
  srv = await startServer();
  srv.fx = await publishFixture(srv.api, { verifyCalibration: false });
  b = await browser();
});
after(async () => { await b?.close(); srv?.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const PORTRAIT = { viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 0.5 };
async function openOffice(page, extra = '') {
  await page.goto(`${srv.base}/kiosk?idle=0&screen=office&id=${srv.fx.office.id}${extra}`, { waitUntil: 'networkidle' });
}
async function startRoute(page) {
  await page.click('[data-action="navoffice"]');
  await page.waitForSelector('#vp');
}
// the viewer attaches its canvas only after the release has loaded and the route player exists
const waitBuilding = page => page.waitForSelector('#vp canvas', { timeout: 30000 });
const canvasCount = page => page.$$eval('canvas', c => c.length);

test('a verified route needs a verified calibration for 3D; until then it plays on the 2D map', async () => {
  const page = await b.newPage(PORTRAIT), errors = watch(page);
  await openOffice(page);
  await startRoute(page);
  await page.waitForSelector('.big2d svg.routemap', { timeout: 20000 });
  assert.equal(await canvasCount(page), 0, 'no 3D with an unverified building alignment');
  assert.equal(await page.$('.draft-route'), null, 'the route itself is verified: no draft-route banner');
  assert.ok((await page.$$('.dir')).length >= 2);
  await page.screenshot({ path: path.join(RESULTS, 'fixture-verified-route-draft-calibration-2d.png') });
  assert.deepEqual(errors.filter(e => !/3D unavailable/.test(e)), []);
  await page.close();

  await srv.api('POST', `/admin/calibrations/${srv.fx.graph.calibration.calibrationVersion}/verify`, {
    anchors: ['ENTRANCE_CENTRE', 'LEFT', 'RIGHT_DEEP', 'UPSTAIRS'].map(id => ({ id, measured: [0, 0, 0], residual_m: 0.03 })) });
  const p2 = await b.newPage(PORTRAIT), errors2 = watch(p2);
  await openOffice(p2); await startRoute(p2); await waitBuilding(p2);
  assert.ok(await p2.$('#vp canvas'), 'canvas attached to the navigation viewport');
  assert.equal(await p2.$('.draft-route'), null, 'verified route + verified calibration: no draft banner');
  const info = await viewerInfo(p2);
  assert.equal(info.loads, 1); assert.equal(info.integrity, 'sha256'); assert.ok(info.calls > 0 && info.textures > 0);
  assert.equal(await p2.evaluate(async () => (await import('/kiosk/three/building-viewer.js')).getViewer().signs.applied.size), 2, 'both sign faces of the verified doorway are labelled');
  await p2.screenshot({ path: path.join(RESULTS, 'fixture-route-verified-3d.png') });
  assert.deepEqual(errors2, []);
  await p2.close();
});

test('repeated navigation reuses one model, one WebGL context and stable GPU resources', async () => {
  const page = await b.newPage(PORTRAIT), errors = watch(page);
  await openOffice(page);
  let first = null;
  for (let i = 0; i < 6; i++) {
    await startRoute(page); await waitBuilding(page);
    await page.waitForTimeout(400); // let the route's own meshes render (GPU upload) before counting
    const info = await viewerInfo(page);
    first ??= info;
    assert.equal(info.loads, 1, 'the building is loaded once per session');
    assert.ok(info.geometries <= first.geometries, `no geometry growth on route ${i + 1} (${info.geometries} vs ${first.geometries})`);
    assert.ok(info.textures <= first.textures, `no texture growth on route ${i + 1} (${info.textures} vs ${first.textures})`);
    assert.ok(await canvasCount(page) <= 1);
    await page.click('[data-action="endnav"]');
    await page.waitForSelector('[data-action="navoffice"]');
    assert.equal(await canvasCount(page), 0, 'canvas detached when the route ends');
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('floor views, first-person pose, minimap follow and paused playback stay in sync', async () => {
  await srv.api('POST', `/admin/calibrations/${srv.fx.graph.calibration.calibrationVersion}/verify`, {
    anchors: ['ENTRANCE_CENTRE', 'LEFT', 'RIGHT_DEEP', 'UPSTAIRS'].map(id => ({ id, measured: [0, 0, 0], residual_m: 0.03 })) });
  const page = await b.newPage(PORTRAIT), errors = watch(page);
  const sceneryRequests = [];
  page.on('request', r => { if (/scenery\.glb|scenery.*\.png/i.test(r.url())) sceneryRequests.push(r.url()); });
  await page.goto(`${srv.base}/kiosk?idle=0&screen=map`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#floor-vp.has-building canvas');
  for (const level of [2, 1]) {
    await page.click(`[data-action="mapfloor"][data-l="${level}"]`);
    await page.waitForSelector('#floor-vp.has-building canvas');
    assert.equal(await page.evaluate(async () => (await import('/kiosk/three/building-viewer.js')).getViewer().floorView.o.level), level);
  }
  await page.click(`[data-action="office"][data-id="${srv.fx.office.id}"]`);
  await startRoute(page); await waitBuilding(page);
  await page.click('[data-action="navpause"]');
  await page.waitForTimeout(200);
  const pose = await page.evaluate(async () => {
    const v = (await import('/kiosk/three/building-viewer.js')).getViewer(), p = v.player.walk.sample(v.player.elapsed);
    return { eye: v.camera.position.toArray(), p, frames: v.info().frames, clipping: v.renderer.clippingPlanes.length };
  });
  assert.ok(Math.abs(pose.eye[1] - pose.p.y - 1.6) < .001);
  assert.equal(pose.clipping, 0, 'floor cutaway removed for first-person');
  await page.waitForTimeout(200);
  assert.equal((await viewerInfo(page)).frames, pose.frames, 'paused route does not render continuously');
  await page.click('[data-action="mmfloor"][data-l="2"]');
  assert.equal(await page.getAttribute('#mm', 'data-floor'), '2');
  assert.equal(await page.getAttribute('#mm #walker2d', 'visibility'), 'hidden');
  await page.click('[data-action="mmfollow"]');
  assert.equal(await page.getAttribute('#mm', 'data-floor'), '1');
  assert.equal(await page.getAttribute('#mm #walker2d', 'visibility'), 'visible');
  await page.click('[data-action="navreplay"]');
  assert.match(await page.textContent('#btn-pause'), /Pause/);
  await page.click('[data-action="toggle2d"]');
  await page.waitForSelector('.big2d svg');
  assert.match(await page.textContent('#t2d'), /3D/);
  await page.click('[data-action="navpause"]');
  await page.click('[data-action="navskip"]');
  await page.waitForSelector('.arrived-cols', { timeout: 10000 });
  assert.deepEqual(sceneryRequests, [], 'no exterior scenery downloads');
  assert.deepEqual(errors, []);
  await page.close();
});

test('leaving while the building loads cancels cleanly; a later route still works', async () => {
  const page = await b.newPage(PORTRAIT), errors = watch(page);
  let delay = 2500;
  await page.route('**/models/cityhall/fx-test01/building.glb', async r => { await new Promise(res => setTimeout(res, delay)); await r.continue(); });
  await openOffice(page);
  await page.click('[data-action="navoffice"]');
  await page.waitForSelector('.vp-loading');
  await page.click('[data-action="endnav"]');      // back to the office screen before the model arrives
  await page.waitForTimeout(delay + 1500);
  assert.equal(await canvasCount(page), 0, 'no late canvas attached to an obsolete screen');
  assert.ok(await page.$('[data-action="navoffice"]'), 'still on the office screen');
  delay = 0;
  await startRoute(page); await waitBuilding(page);
  assert.ok(await page.$('#vp canvas'));
  assert.deepEqual(errors, []);
  await page.close();
});

for (const [name, setup] of [
  ['missing GLB', page => page.route('**/fx-test01/building.glb', r => r.fulfill({ status: 404, body: 'gone' }))],
  ['corrupted lightmap bytes', page => page.route('**/fx-test01/textures/FX_GF_RGBM.png', async r => { const res = await r.fetch(); const body = Buffer.from(await res.body()); body[body.length - 20] ^= 0xff; await r.fulfill({ response: res, body }); })],
  ['malformed manifest', page => page.route('**/fx-test01/manifest.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"schemaVersion":1,"files":[{"path":"../../etc/passwd"}' }))],
]) {
  test(`${name}: the visitor keeps usable 2D directions`, async () => {
    const page = await b.newPage(PORTRAIT), errors = watch(page);
    await setup(page);
    await openOffice(page);
    await page.click('[data-action="navoffice"]');
    await page.waitForSelector('.big2d svg', { timeout: 20000 });
    assert.equal(await canvasCount(page), 0);
    assert.ok((await page.$$('.dir')).length >= 2, 'written directions still shown');
    assert.ok(await page.$('.big2d svg .routemap, .big2d svg.routemap'), 'graph-based 2D map, not placeholder rooms');
    assert.deepEqual(errors.filter(e => !/3D unavailable|404/.test(e)), []);
    await page.close();
  });
}

test('WebGL context loss mid-route hands over to the 2D map', async () => {
  const page = await b.newPage(PORTRAIT);
  await openOffice(page); await startRoute(page); await waitBuilding(page);
  await page.evaluate(async () => (await import('/kiosk/three/building-viewer.js')).getViewer().renderer.getContext().getExtension('WEBGL_lose_context').loseContext());
  await page.waitForSelector('.big2d svg', { timeout: 10000 });
  assert.ok((await page.$$('.dir')).length >= 2);
  await page.close();
});

test('step-free request: explicit no-route, nothing drawn, never stairs', async () => {
  const page = await b.newPage(PORTRAIT), errors = watch(page);
  await openOffice(page); await startRoute(page);
  await page.click('[data-action="stepfree"]');
  await page.waitForSelector('[data-action="home"]');
  const text = await page.textContent('.screen');
  assert.match(text, /no checked step-free way/);
  assert.equal(await canvasCount(page), 0);
  assert.equal(await page.$('.big2d'), null);
  await page.screenshot({ path: path.join(RESULTS, 'fixture-no-step-free-route.png') });
  await page.click('[data-action="stepfree"]'); // "Show a route with stairs" restores the normal route
  await page.waitForSelector('#vp');
  assert.deepEqual(errors, []);
  await page.close();
});

test('an office move updates the active destination and the sign without reloading the building', async () => {
  await srv.api('POST', `/admin/calibrations/${srv.fx.graph.calibration.calibrationVersion}/verify`, {
    anchors: ['ENTRANCE_CENTRE', 'LEFT', 'RIGHT_DEEP', 'UPSTAIRS'].map(id => ({ id, measured: [0, 0, 0], residual_m: 0.03 })) });
  const page = await b.newPage(PORTRAIT), errors = watch(page);
  await openOffice(page, '&sync=1');
  await startRoute(page); await waitBuilding(page);
  const signText = () => page.evaluate(async () => [...(await import('/kiosk/three/building-viewer.js')).getViewer().signs.applied.values()].map(a => a.text.title));
  assert.ok((await signText()).every(t => t === srv.fx.office.name));
  const rooms = (await srv.api('GET', '/admin/rooms')).body.items;
  const other = rooms.find(r => r.id !== srv.fx.office.location.room_id && r.room_type === 'office');
  await srv.api('POST', `/admin/offices/${srv.fx.office.id}/move`, { room_id: other.id, occupancy: 'share', note: 'e2e move' });
  // the next content sync re-resolves the office: its new room has no verified doorway -> explicit no-route
  await page.waitForFunction(() => /not been checked on site/.test(document.querySelector('.screen')?.textContent || ''), null, { timeout: 20000 });
  const titles = await signText();
  assert.ok(titles.every(t => t !== srv.fx.office.name), 'the sign no longer names the office that moved away');
  assert.equal((await viewerInfo(page)).loads, 1, 'geometry was not reloaded');
  assert.deepEqual(errors, []);
  await page.close();
  await srv.api('POST', `/admin/offices/${srv.fx.office.id}/move`, { room_id: srv.fx.office.location.room_id, note: 'e2e move back' });
});

test('QR handoff keeps the origin kiosk and preference; the phone re-plans and flags office moves', async () => {
  const svc = (await (await fetch(`${srv.base}/api/search?q=${encodeURIComponent(srv.fx.office.name.split(' ')[0])}&log=0`)).json()).results
    .find(r => r.kind === 'service' && r.subtitle?.startsWith(srv.fx.office.name));
  assert.ok(svc, 'a service of the mapped office');
  const page = await b.newPage(PORTRAIT);
  await page.goto(`${srv.base}/kiosk?idle=0&screen=service&id=${svc.id}`, { waitUntil: 'networkidle' });
  await page.click('[data-action="qr"]');
  const src = await page.getAttribute('.sheet img.qr', 'src');
  const encoded = new URL(decodeURIComponent(new URL(src, srv.base).searchParams.get('data')));
  assert.equal(encoded.searchParams.get('k'), 'KIOSK-LOBBY-1');
  assert.equal(encoded.searchParams.get('r'), String(srv.fx.office.location.room_id));
  assert.equal(encoded.searchParams.get('nv'), srv.fx.graph.navigationVersion);
  await page.close();

  const phone = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }), errors = watch(phone);
  await phone.goto(`${srv.base}/m/service/${svc.id}?k=KIOSK-LOBBY-1&r=${srv.fx.office.location.room_id}`, { waitUntil: 'networkidle' });
  assert.ok((await phone.$$('#where .dirs li')).length >= 3, 'step-by-step directions from the kiosk');
  assert.equal((await phone.$$('#where .plan-fig svg.routemap')).length, 1, 'one graph map per floor used');
  assert.match(await phone.textContent('#where'), /From kiosk KIOSK-LOBBY-1/);
  assert.equal(await phone.$('#where .notice'), null, 'no move notice when the room is unchanged');
  await phone.screenshot({ path: path.join(RESULTS, 'phone-directions.png'), fullPage: true });

  await phone.goto(`${srv.base}/m/service/${svc.id}`, { waitUntil: 'networkidle' });
  assert.equal((await phone.$$('#where .dirs li')).length, 0, 'no origin: never assumes the lobby');
  assert.match(await phone.textContent('#where'), /Scan the code on a City Hall kiosk/);

  await phone.goto(`${srv.base}/m/service/${svc.id}?k=KIOSK-LOBBY-1&r=999999`, { waitUntil: 'networkidle' });
  assert.match(await phone.textContent('#where .notice'), /has moved since the code was made/);

  await phone.goto(`${srv.base}/m/service/${svc.id}?k=KIOSK-LOBBY-1&p=sf`, { waitUntil: 'networkidle' });
  assert.match(await phone.textContent('#where'), /no checked step-free way/);
  assert.equal((await phone.$$('#where .dirs li')).length, 0);
  assert.deepEqual(errors, []);
  await phone.close();
});

// ---------------------------------------------------------------- shader parity
const INV = JSON.parse(fs.readFileSync(path.resolve(FIXTURES, '../../../../docs/3d-integration/source-inventory.json'), 'utf8'));
const lutEntry = INV.source_assets.find(a => a.path.endsWith('AgX_Afternoon_LUT.png'));
const QA = path.join(INV.model_workspace, 'web_source_r09', 'texture_validation');
function readNpy(file) {
  const buf = fs.readFileSync(file), hl = buf.readUInt16LE(8), header = buf.toString('latin1', 10, 10 + hl);
  const descr = /'descr':\s*'([^']+)'/.exec(header)[1], shape = /'shape':\s*\(([^)]*)\)/.exec(header)[1].split(',').filter(s => s.trim()).map(Number);
  if (/fortran_order':\s*True/.test(header)) throw new Error('fortran order unsupported');
  const data = buf.subarray(10 + hl), n = shape.reduce((a, b) => a * b, 1);
  const arr = descr === '<f4' ? new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + n * 4)) : descr === '<f8' ? Float64Array.from(new Float64Array(data.buffer.slice(data.byteOffset, data.byteOffset + n * 8))) : null;
  if (!arr) throw new Error(`dtype ${descr} unsupported`);
  return { shape, data: arr };
}
const haveLut = fs.existsSync(lutEntry?.path || '') && fs.existsSync(path.join(QA, 'LUT_Input.npy')) && fs.existsSync(path.join(QA, 'LUT_Reference.png'));

test('GPU afternoon LUT matches Blender\'s reference renders (mean < 1.5, max < 10 on 8-bit)', { skip: !haveLut && 'model workspace LUT validation files not available' }, async () => {
  const lutBuf = fs.readFileSync(lutEntry.path);
  assert.equal(crypto.createHash('sha256').update(lutBuf).digest('hex'), lutEntry.sha256, 'LUT matches the verified inventory');
  const input = readNpy(path.join(QA, 'LUT_Input.npy'));
  const [H, W] = input.shape;
  const ref = decodePng(fs.readFileSync(path.join(QA, 'LUT_Reference.png')));
  const page = await b.newPage({ viewport: { width: 400, height: 400 } });
  await page.goto(`${srv.base}/kiosk?idle=0`, { waitUntil: 'networkidle' });
  const out = await page.evaluate(async ({ lutB64, W, H, data }) => {
    const THREE = await import('three');
    const { LUT_GLSL } = await import('/kiosk/three/materials.js');
    const bytes = Uint8Array.from(atob(lutB64), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const lut = new THREE.Texture(bmp); lut.flipY = false; lut.colorSpace = THREE.NoColorSpace; lut.generateMipmaps = false;
    lut.minFilter = lut.magFilter = THREE.LinearFilter; lut.wrapS = lut.wrapT = THREE.ClampToEdgeWrapping; lut.needsUpdate = true;
    const rgba = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = 1; }
    const inp = new THREE.DataTexture(rgba, W, H, THREE.RGBAFormat, THREE.FloatType); inp.minFilter = inp.magFilter = THREE.NearestFilter; inp.needsUpdate = true;
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL1,
      uniforms: { lut: { value: lut }, inp: { value: inp } },
      vertexShader: 'attribute vec3 position; attribute vec2 uv; varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float; uniform sampler2D inp; varying vec2 vUv; ${LUT_GLSL} void main(){ gl_FragColor = vec4(gradeAfternoon(texture2D(inp, vUv).rgb), 1.0); }`,
    });
    const r = new THREE.WebGLRenderer({ antialias: false }); r.setPixelRatio(1); r.setSize(W, H, false); r.outputColorSpace = THREE.LinearSRGBColorSpace;
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    r.render(scene, new THREE.Camera());
    const gl = r.getContext(), px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    r.dispose(); r.forceContextLoss();
    return Array.from(px);
  }, { lutB64: lutBuf.toString('base64'), W, H, data: Array.from(input.data) });
  // readPixels row i (bottom-up) <-> input row i <-> reference PNG row H-1-i (the check script flips the PNG)
  let sum = 0, max = 0, n = 0;
  for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) for (let c = 0; c < 3; c++) {
    const g = out[(i * W + j) * 4 + c], e = ref.pixels[((H - 1 - i) * ref.width + j) * ref.channels + c];
    const d = Math.abs(g - e); sum += d; max = Math.max(max, d); n++;
  }
  const result = { samples: n, meanError8bit: +(sum / n).toFixed(3), maxError8bit: max, tolerance: { mean: 1.5, max: 10 } };
  fs.writeFileSync(path.join(RESULTS, 'lut-parity.json'), JSON.stringify({ ...result, lutSha256: lutEntry.sha256, reference: path.join(QA, 'LUT_Reference.png') }, null, 2));
  assert.ok(result.meanError8bit < 1.5 && max < 10, JSON.stringify(result));
  await page.close();
});

test('baked shader decodes RGBM with the binding range and grades once', async () => {
  const page = await b.newPage({ viewport: { width: 400, height: 400 } });
  await page.goto(`${srv.base}/kiosk?idle=0`, { waitUntil: 'networkidle' });
  const r = await page.evaluate(async () => {
    const THREE = await import('three');
    const { bakedMaterial, LUT_GLSL } = await import('/kiosk/three/materials.js');
    const res = await fetch('/models/cityhall/fx-test01/textures/AgX_Afternoon_LUT.png');
    const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const lut = new THREE.Texture(bmp); lut.flipY = false; lut.generateMipmaps = false; lut.minFilter = lut.magFilter = THREE.LinearFilter; lut.needsUpdate = true;
    const N = 8, rgbm = new Uint8Array(N * N * 4), want = new Float32Array(N * N * 4);
    for (let i = 0; i < N * N; i++) { // spread of RGBM texels incl. small multipliers (the premultiply trap)
      const m = [4, 16, 64, 128, 200, 255, 32, 8][i % 8], rgb = [(i * 37) % 256, (i * 91 + 40) % 256, (i * 53 + 90) % 256];
      rgbm.set([...rgb, m], i * 4);
      for (let c = 0; c < 3; c++) want[i * 4 + c] = rgb[c] / 255 * (m / 255) * 8; want[i * 4 + 3] = 1;
    }
    const lm = new THREE.DataTexture(rgbm, N, N); lm.minFilter = lm.magFilter = THREE.NearestFilter; lm.needsUpdate = true;
    const mat = bakedMaterial({ name: 't', lightRange: 8 }, { lightMap: lm, baseMap: null, lut });
    const geo = new THREE.PlaneGeometry(2, 2);
    geo.setAttribute('uv1', geo.getAttribute('uv')); geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12).fill(1), 3));
    const { prepareBakedGeometry } = await import('/kiosk/three/materials.js'); prepareBakedGeometry(geo, 't');
    const run = material => {
      const rr = new THREE.WebGLRenderer({ antialias: false }); rr.setPixelRatio(1); rr.setSize(N, N, false);
      rr.outputColorSpace = THREE.SRGBColorSpace; rr.toneMapping = THREE.NoToneMapping;
      const sc = new THREE.Scene(); const mesh = new THREE.Mesh(geo, material); sc.add(mesh);
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); cam.position.z = 1;
      rr.render(sc, cam); const gl = rr.getContext(), px = new Uint8Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
      rr.dispose(); rr.forceContextLoss(); return px;
    };
    const got = run(mat);
    // reference: CPU-decoded RGBM fed straight into the same LUT function
    const inp = new THREE.DataTexture(want, N, N, THREE.RGBAFormat, THREE.FloatType); inp.minFilter = inp.magFilter = THREE.NearestFilter; inp.needsUpdate = true;
    const refMat = new THREE.ShaderMaterial({ uniforms: { lut: { value: lut }, inp: { value: inp } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D inp; varying vec2 vUv; ${LUT_GLSL} void main(){ gl_FragColor = vec4(gradeAfternoon(texture2D(inp, vUv).rgb), 1.0); }` });
    refMat.toneMapped = false;
    const ref = (() => { const rr = new THREE.WebGLRenderer({ antialias: false }); rr.setPixelRatio(1); rr.setSize(N, N, false); rr.outputColorSpace = THREE.LinearSRGBColorSpace;
      const sc = new THREE.Scene(); sc.add(new THREE.Mesh(geo, refMat)); const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); cam.position.z = 1;
      rr.render(sc, cam); const gl = rr.getContext(), px = new Uint8Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px); rr.dispose(); rr.forceContextLoss(); return px; })();
    let max = 0, sum = 0; for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) { const d = Math.abs(got[i * 4 + c] - ref[i * 4 + c]); max = Math.max(max, d); sum += d; }
    return { max, mean: sum / (N * N * 3) };
  });
  assert.ok(r.max <= 2 && r.mean < 0.6, `baked shader vs CPU-decoded RGBM through the same LUT: ${JSON.stringify(r)}`);
  await page.close();
});

test('Browse offices: grouped by floor, plain lines once approved, Back keeps the place', async () => {
  const office = srv.fx.office;
  await srv.api('POST', '/admin/plain-summaries/import-drafts', {});
  await srv.api('POST', `/admin/plain-summaries/office/${office.id}/en/approve`, {});
  const page = await b.newPage(PORTRAIT), errors = watch(page);
  await page.goto(`${srv.base}/kiosk?idle=0&screen=home`, { waitUntil: 'networkidle' });
  await page.click('.choice[data-action="offices"]');
  assert.ok((await page.$$('.group-h')).length >= 2, 'grouped by floor');
  const row = page.locator(`.row[data-action="office"][data-id="${office.id}"]`);
  assert.match(await row.textContent(), /Helps with:/, 'approved line shown');
  const unapproved = await page.$$eval('.row[data-action="office"]', rows => rows.filter(r => /Helps with:/.test(r.textContent)).length);
  assert.equal(unapproved, 1, 'drafts that are not approved stay hidden');
  await page.evaluate(() => { document.querySelector('.content').scrollTop = 600; });
  const before = await page.evaluate(() => document.querySelector('.content').scrollTop);
  // a DOM click (Playwright's own click would first scroll the row into view and move the list)
  await page.evaluate(id => document.querySelector(`.row[data-action="office"][data-id="${id}"]`).click(), office.id);
  await page.waitForSelector('.row[data-action="service"]');
  await page.click('[data-action="back"]');
  await page.waitForSelector('.row[data-action="office"]');
  assert.equal(await page.evaluate(() => document.querySelector('.content').scrollTop), before, 'Back returns to the same place in the list');
  assert.deepEqual(errors, []);
  await page.close();
});
