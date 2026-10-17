// The real-building viewer: one WebGL renderer and one loaded model release for the whole kiosk session.
// Screens borrow the canvas (attach/detach) and routes borrow the building (playRoute); neither recreates the
// context nor reloads geometry/textures. Rendering runs only while something changes, pauses when the page is
// hidden, and WebGL context loss is reported so the kiosk can keep showing the 2D directions.
import * as THREE from 'three';
import { AssetManager } from './asset-manager.js';
import { glbRootMatrix, gltfToRender } from './coordinates.js';
import { RoutePlayer } from './route-player.js';
import { FloorView } from './floor-view.js';
import { FloorVisibility } from './floor-visibility.js';
import { DynamicSigns } from './dynamic-signs.js';

const MAX_DPR = 1.5;

export class BuildingViewer {
  constructor() {
    this.assets = new AssetManager();
    this.renderer = null;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xdfe6ee);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.modelRoot = new THREE.Group();          // gets T = S × A × R⁻¹ once
    this.modelRoot.name = 'model-root';
    this.modelRoot.matrixAutoUpdate = false;
    this.scene.add(this.modelRoot);
    this.release = null; this.releaseKey = null; this.loading = null;
    this.container = null; this.ro = null;
    this.raf = 0; this.dirty = true; this.animating = new Set();
    this.contextLost = false; this.listeners = new Set();
    this.player = null; this.floorView = null; this.floors = null; this.signs = null;
    this.stats = { frames: 0, loads: 0 };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.invalidate(); });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { this.listeners.forEach(fn => { try { fn(ev); } catch (e) { console.error(e); } }); }

  ensureRenderer() {
    if (this.renderer) return this.renderer;
    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!r.getContext()) throw Object.assign(new Error('WebGL unavailable'), { code: 'WEBGL_UNAVAILABLE' });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.localClippingEnabled = true;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    r.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    r.domElement.setAttribute('aria-hidden', 'true');
    r.domElement.addEventListener('webglcontextlost', e => {
      e.preventDefault(); this.contextLost = true; cancelAnimationFrame(this.raf); this.raf = 0;
      this.emit({ type: 'contextlost' });
    });
    r.domElement.addEventListener('webglcontextrestored', () => { this.contextLost = false; this.invalidate(); this.emit({ type: 'contextrestored' }); });
    this.renderer = r;
    return r;
  }

  /** Loads (once) the published model release. Concurrent callers share the same promise; abort only stops waiting. */
  async ensureModel(nav, { signal, onLoadProgress, allowDraftCalibration = false } = {}) {
    const model = nav?.model;
    if (!model?.baseUrl) throw Object.assign(new Error('No model release is published.'), { code: 'NO_MODEL' });
    const T = glbRootMatrix(nav.calibration, model.modelVersion, { allowDraft: allowDraftCalibration });
    const key = `${model.modelVersion}|${model.baseUrl}`;
    this.ensureRenderer();
    if (this.releaseKey !== key || !this.release) {
      if (!this.loading || this.loading.key !== key) {
        const ctrl = new AbortController();
        const p = this.assets.loadRelease(model.baseUrl, { expectedVersion: model.modelVersion, renderer: this.renderer, signal: ctrl.signal,
          onProgress: ev => this.loading?.listeners.forEach(fn => fn(ev)) });
        this.loading = { key, promise: p, listeners: new Set(), ctrl, waiters: 0 };
        p.then(rel => {
          if (this.loading?.key !== key) { rel.dispose(); return; }
          this.release?.dispose();
          this.modelRoot.clear();
          this.modelRoot.add(rel.root);
          this.release = rel; this.releaseKey = key; this.loading = null; this.stats.loads++;
          this.floors = new FloorVisibility(rel);
          this.signs = new DynamicSigns(rel);
          this.invalidate();
        }, () => { if (this.loading?.key === key) this.loading = null; });
      }
      const L = this.loading;
      if (onLoadProgress) L.listeners.add(onLoadProgress);
      L.waiters++;
      try {
        await abortable(L.promise, signal);
      } finally {
        L.listeners.delete(onLoadProgress);
        // the last waiter to give up cancels the download; a completed load is kept for the next route
        if (--L.waiters === 0 && signal?.aborted && this.loading === L) { L.ctrl.abort(); this.loading = null; }
      }
    }
    this.modelRoot.matrix.copy(T);
    this.modelRoot.matrixWorldNeedsUpdate = true;
    this.calibration = nav.calibration;
    this.T = T;
    return this.release;
  }

  attach(container) {
    const r = this.ensureRenderer();
    if (this.container === container) return;
    this.detach();
    this.container = container;
    container.prepend(r.domElement);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }
  detach() {
    this.ro?.disconnect(); this.ro = null;
    this.renderer?.domElement.remove();
    this.container = null;
    cancelAnimationFrame(this.raf); this.raf = 0;
  }
  resize() {
    if (!this.container || !this.renderer) return;
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.floorView?.resized();
    this.invalidate();
  }

  invalidate() { this.dirty = true; this.schedule(); }
  schedule() {
    if (this.raf || !this.container || this.contextLost || document.hidden) return;
    this.raf = requestAnimationFrame(t => this.frame(t));
  }
  frame(t) {
    this.raf = 0;
    const animating = this.animating.size > 0;
    for (const a of this.animating) a.tick(t);
    if (this.dirty || animating) {
      this.renderer.render(this.scene, this.camera);
      this.stats.frames++;
      this.dirty = false;
    }
    if (this.animating.size) this.schedule();
  }

  /** Content changes (office moved, labels) after the geometry is loaded. */
  /** @param {{preview?: boolean}} [opts] staff preview: draft sign mappings are shown too (remembered for later calls) */
  updateContent(bundle, { preview } = {}) {
    if (preview !== undefined) this.signPreview = preview;
    this.signs?.update(bundle, { preview: !!this.signPreview }); this.invalidate();
  }

  playRoute(route, opts) {
    if (!this.release) throw new Error('Model is not loaded');
    this.player?.dispose(); this.floorView?.dispose();
    this.player = new RoutePlayer(this, route, opts);
    return this.player;
  }

  /** Map screen: one floor in 3D, everything above it cut away (three/floor-view.js). */
  showFloor(opts) {
    if (!this.release) throw new Error('Model is not loaded');
    this.player?.dispose(); this.floorView?.dispose();
    this.floorView = new FloorView(this, opts);
    return this.floorView;
  }

  /** Camera exactly as a source VIEW_ marker (for reference comparisons). */
  setViewpoint(marker, { aspect } = {}) {
    const v = this.release?.viewpoints?.[marker];
    if (!v) throw new Error(`Unknown viewpoint ${marker}`);
    const pos = gltfToRender(this.T, v.gltf.position), target = gltfToRender(this.T, v.gltf.target), up = gltfToRender(this.T, v.gltf.up).sub(pos).normalize();
    this.camera.fov = v.verticalFov;
    if (aspect) this.camera.aspect = aspect;
    this.camera.near = 0.1; this.camera.far = 3000;
    this.camera.position.copy(pos); this.camera.up.copy(up); this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
    this.floors?.showAll();
    this.invalidate();
  }


  /** Renderer counters for performance reports. */
  info() {
    const i = this.renderer?.info;
    return { calls: i?.render.calls, triangles: i?.render.triangles, geometries: i?.memory.geometries, textures: i?.memory.textures,
      programs: i?.programs?.length, frames: this.stats.frames, loads: this.stats.loads, integrity: this.assets.integrity, contextLost: this.contextLost };
  }

  /** Full shutdown (application exit / tests). Routes never call this. */
  dispose() {
    this.player?.dispose(); this.player = null; this.floorView?.dispose();
    this.signs?.dispose(); this.release?.dispose(); this.release = null; this.releaseKey = null;
    this.detach();
    this.renderer?.dispose(); this.renderer = null;
  }
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(Object.assign(new Error('Loading was cancelled.'), { name: 'AbortError', code: 'ABORTED' }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('Loading was cancelled.'), { name: 'AbortError', code: 'ABORTED' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(v => { signal.removeEventListener('abort', onAbort); resolve(v); }, e => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

let VIEWER = null;
/** The application-lifetime viewer. */
export function getViewer() { return (VIEWER ??= new BuildingViewer()); }
export function resetViewerForTests() { VIEWER?.dispose(); VIEWER = null; }
