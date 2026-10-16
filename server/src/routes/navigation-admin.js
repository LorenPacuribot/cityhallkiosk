// Admin API for the real-building navigation: model releases, calibration, graph revisions, opening/sign
// mappings, field verification, closures and publication. Mounted under /api/admin; every write is audited.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, bumpContentVersion, MODELS_ROOT } from '../db.js';
import { requireRole, audit } from '../auth.js';
import { importGraph, validationReport, publish, revisionByVersion, loadGraph, calibrationRecord, registerModelRelease, NavError, currentPublication } from '../lib/navigation.js';

export const navAdminApi = express.Router();
const MODELS_DIR = path.join(MODELS_ROOT, 'cityhall');
const fail = (res, e) => {
  if (e instanceof NavError) return res.status(e.status).json({ error: e.message, detail: e.detail });
  throw e;
};
const rev = (res, version) => {
  const r = revisionByVersion(String(version));
  if (!r) { res.status(404).json({ error: 'Unknown navigation revision' }); return null; }
  return r;
};
const triState = v => v === null ? null : v === true || v === 1 || v === '1' ? 1 : v === false || v === 0 || v === '0' ? 0 : undefined;

navAdminApi.get('/navigation', requireRole('viewer'), (req, res) => {
  res.json({
    publication: currentPublication(),
    history: all('SELECT id, model_version, calibration_version, navigation_version, content_version, status, published_at FROM navigation_publications ORDER BY id DESC LIMIT 20'),
    revisions: all(`SELECT r.id, r.navigation_version, r.model_version, r.calibration_version, r.status, r.created_at, r.note,
                           (SELECT count(*) FROM navigation_edges e WHERE e.revision_id = r.id) AS edges,
                           (SELECT count(*) FROM navigation_edges e WHERE e.revision_id = r.id AND e.verified = 1) AS verified_edges,
                           (SELECT count(*) FROM room_openings o WHERE o.revision_id = r.id AND o.status = 'verified') AS verified_openings,
                           (SELECT count(*) FROM room_openings o WHERE o.revision_id = r.id) AS openings
                      FROM navigation_revisions r ORDER BY r.id DESC`),
    calibrations: all('SELECT calibration_version, model_version, status, description, verified_at FROM model_calibrations ORDER BY id DESC'),
    models: all('SELECT model_version, base_url, status, source_blend_sha256, created_at FROM model_releases ORDER BY id DESC'),
    previewUnverified: get(`SELECT value FROM settings WHERE key = 'navigation_preview_unverified'`)?.value === '1',
  });
});

navAdminApi.get('/navigation/:version', requireRole('viewer'), (req, res) => {
  const r = rev(res, req.params.version); if (!r) return;
  res.json({ graph: loadGraph(r.id), report: validationReport(r.id), calibration: calibrationRecord(r.calibration_version) });
});

// Body: { graph: <tools/model/pilot-graph.mjs output>, dryRun?: boolean }
navAdminApi.post('/navigation/import', requireRole('lgu_admin'), (req, res) => {
  try {
    const out = importGraph(req.body?.graph, req.user, { dryRun: !!req.body?.dryRun });
    if (!out.dryRun) audit(req.user, 'import', 'navigation_revision', null, null, { navigationVersion: out.navigationVersion, nodes: out.nodes, edges: out.edges });
    res.status(out.dryRun ? 200 : 201).json(out);
  } catch (e) { fail(res, e); }
});

navAdminApi.post('/navigation/:version/publish', requireRole('lgu_admin'), (req, res) => {
  try {
    const out = publish(req.params.version, req.user);
    audit(req.user, 'publish', 'navigation_revision', null, null, { navigationVersion: req.params.version });
    bumpContentVersion();
    res.json(out);
  } catch (e) { fail(res, e); }
});

// Return to the previous publication (kept for exactly this purpose).
navAdminApi.post('/navigation/rollback', requireRole('lgu_admin'), (req, res) => {
  const cur = currentPublication();
  const prev = get(`SELECT * FROM navigation_publications WHERE status = 'superseded' ORDER BY id DESC LIMIT 1`);
  if (!cur) return res.status(409).json({ error: 'Nothing is published.' });
  tx(() => {
    run(`UPDATE navigation_publications SET status = 'rolled_back' WHERE id = ?`, [cur.id]);
    run(`UPDATE navigation_revisions SET status = 'retired' WHERE navigation_version = ?`, [cur.navigation_version]);
    if (prev) {
      run(`UPDATE navigation_publications SET status = 'published' WHERE id = ?`, [prev.id]);
      run(`UPDATE navigation_revisions SET status = 'published' WHERE navigation_version = ?`, [prev.navigation_version]);
    }
  });
  audit(req.user, 'rollback', 'navigation_publication', cur.id, { navigationVersion: cur.navigation_version }, { navigationVersion: prev?.navigation_version ?? null });
  bumpContentVersion();
  res.json({ rolledBack: cur.navigation_version, nowPublished: prev?.navigation_version ?? null });
});

// Field verification / closures for one edge. Body: { verified?, closed?, closed_reason?, step_free? (true|false|null), is_public? }
navAdminApi.put('/navigation/:version/edges/:edgeId', requireRole('lgu_admin'), (req, res) => {
  const r = rev(res, req.params.version); if (!r) return;
  const before = get('SELECT * FROM navigation_edges WHERE revision_id = ? AND edge_id = ?', [r.id, req.params.edgeId]);
  if (!before) return res.status(404).json({ error: 'Unknown edge' });
  const b = req.body || {}, sets = [], p = [];
  if ('step_free' in b) {
    const v = triState(b.step_free);
    if (v === undefined) return res.status(400).json({ error: 'step_free must be true, false or null' });
    if (before.kind === 'stairs' && v === 1) return res.status(422).json({ error: 'Stairs cannot be step-free.' });
    sets.push('step_free = ?'); p.push(v);
  }
  for (const k of ['verified', 'closed', 'is_public']) if (k in b) { sets.push(`${k} = ?`); p.push(b[k] ? 1 : 0); }
  if ('closed_reason' in b) { sets.push('closed_reason = ?'); p.push(b.closed_reason ? String(b.closed_reason).slice(0, 200) : null); }
  if ('verified' in b) { sets.push('verified_by = ?', 'verified_at = ?'); p.push(b.verified ? req.user.id : null, b.verified ? new Date().toISOString() : null); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  run(`UPDATE navigation_edges SET ${sets.join(', ')} WHERE revision_id = ? AND edge_id = ?`, [...p, r.id, req.params.edgeId]);
  const after = get('SELECT * FROM navigation_edges WHERE revision_id = ? AND edge_id = ?', [r.id, req.params.edgeId]);
  audit(req.user, 'update', 'navigation_edge', null, before, after);
  if (r.status === 'published') bumpContentVersion();
  res.json(after);
});

// Opening <-> room mapping. Body: { room_id?: number|null, status?: 'unresolved'|'draft'|'verified', approach_node_id?, notes? }
navAdminApi.put('/navigation/:version/openings/:openingId', requireRole('lgu_admin'), (req, res) => {
  const r = rev(res, req.params.version); if (!r) return;
  const before = get('SELECT * FROM room_openings WHERE revision_id = ? AND opening_id = ?', [r.id, req.params.openingId]);
  if (!before) return res.status(404).json({ error: 'Unknown opening' });
  const b = req.body || {};
  const roomId = 'room_id' in b ? (b.room_id === null ? null : Number(b.room_id)) : before.room_id;
  if (roomId !== null && !get('SELECT 1 FROM rooms WHERE id = ?', [roomId])) return res.status(422).json({ error: 'Unknown room' });
  const nodeId = 'approach_node_id' in b ? b.approach_node_id : before.approach_node_id;
  if (nodeId && !get('SELECT 1 FROM navigation_nodes WHERE revision_id = ? AND node_id = ?', [r.id, nodeId])) return res.status(422).json({ error: 'Unknown approach node' });
  const status = b.status || (roomId ? 'draft' : 'unresolved');
  if (!['unresolved', 'draft', 'verified'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  if (status === 'verified' && (!roomId || !nodeId)) return res.status(422).json({ error: 'A verified mapping needs a room and an approach node.' });
  run(`UPDATE room_openings SET room_id = ?, approach_node_id = ?, status = ?, notes = COALESCE(?, notes), reviewed_by = ?, reviewed_at = datetime('now')
        WHERE revision_id = ? AND opening_id = ?`, [roomId, nodeId, status, b.notes ?? null, req.user.id, r.id, req.params.openingId]);
  // the opening's sign faces follow the mapping state
  run('UPDATE sign_bindings SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE revision_id = ? AND opening_id = ?',
    [status, req.user.id, r.id, req.params.openingId]);
  const after = get('SELECT * FROM room_openings WHERE revision_id = ? AND opening_id = ?', [r.id, req.params.openingId]);
  audit(req.user, 'update', 'room_opening', after.id, before, after);
  if (r.status === 'published') bumpContentVersion();
  res.json(after);
});

// Kiosk start position for this revision. Body: { node_id, verified? }
navAdminApi.put('/navigation/:version/kiosks/:code', requireRole('lgu_admin'), (req, res) => {
  const r = rev(res, req.params.version); if (!r) return;
  const nodeId = String(req.body?.node_id || '');
  if (!get('SELECT 1 FROM navigation_nodes WHERE revision_id = ? AND node_id = ?', [r.id, nodeId])) return res.status(422).json({ error: 'Unknown node' });
  run(`INSERT INTO kiosk_navigation_nodes(revision_id, kiosk_code, node_id, verified) VALUES (?,?,?,?)
       ON CONFLICT(revision_id, kiosk_code) DO UPDATE SET node_id = excluded.node_id, verified = excluded.verified`,
    [r.id, req.params.code, nodeId, req.body?.verified ? 1 : 0]);
  audit(req.user, 'update', 'kiosk_navigation_node', null, null, { revision: r.navigation_version, kiosk: req.params.code, nodeId });
  if (r.status === 'published') bumpContentVersion();
  res.json({ ok: true });
});

// Mark a calibration verified once its field anchors are measured. Body: { anchors: [{id, measured:[x,y,z], residual_m}] }
navAdminApi.post('/calibrations/:version/verify', requireRole('lgu_admin'), (req, res) => {
  const c = get('SELECT * FROM model_calibrations WHERE calibration_version = ?', [req.params.version]);
  if (!c) return res.status(404).json({ error: 'Unknown calibration' });
  const anchors = Array.isArray(req.body?.anchors) ? req.body.anchors : [];
  const problems = [];
  if (anchors.length < 4) problems.push('At least four measured anchors are required (entrance centre, left point, right/deeper point, upstairs landing).');
  for (const a of anchors) {
    if (!Array.isArray(a.measured) || a.measured.length !== 3 || !a.measured.every(Number.isFinite)) problems.push(`${a.id}: measured position missing`);
    if (!(Number.isFinite(a.residual_m) && a.residual_m <= 0.10)) problems.push(`${a.id}: residual ${a.residual_m} m exceeds 0.10 m`);
  }
  if (problems.length) return res.status(422).json({ error: 'Calibration cannot be verified', problems });
  run(`UPDATE model_calibrations SET status = 'verified', anchors_json = ?, verified_by = ?, verified_at = datetime('now') WHERE id = ?`,
    [JSON.stringify(anchors), req.user.id, c.id]);
  audit(req.user, 'verify', 'model_calibration', c.id, { status: c.status }, { status: 'verified', anchors });
  bumpContentVersion();
  res.json(get('SELECT calibration_version, status, verified_at FROM model_calibrations WHERE id = ?', [c.id]));
});

// Register a model release that is already on disk (built by tools/model/build-release.mjs).
navAdminApi.post('/model-releases', requireRole('lgu_admin'), (req, res) => {
  const v = String(req.body?.model_version || '');
  if (!/^[a-z0-9][a-z0-9.-]{1,40}$/.test(v)) return res.status(400).json({ error: 'Bad model version' });
  const mf = path.join(MODELS_DIR, v, 'manifest.json');
  if (!fs.existsSync(mf)) return res.status(422).json({ error: `No release on disk at /models/cityhall/${v}/` });
  let m;
  try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { return res.status(422).json({ error: 'Manifest is not valid JSON' }); }
  if (m.modelVersion !== v) return res.status(422).json({ error: 'Manifest version does not match' });
  const out = registerModelRelease({ modelVersion: v, baseUrl: `/models/cityhall/${v}/`, sourceBlendSha256: m.sourceBlendSha256 });
  audit(req.user, 'register', 'model_release', null, null, { modelVersion: v });
  res.status(out.registered ? 201 : 200).json(out);
});

// Draft-route preview on kiosks/phones (?preview=1). Off by default; results are always labelled unverified.
navAdminApi.put('/navigation-preview', requireRole('lgu_admin'), (req, res) => {
  const on = !!req.body?.enabled;
  run(`INSERT INTO settings(key, value) VALUES ('navigation_preview_unverified', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [on ? '1' : '0']);
  audit(req.user, 'update', 'setting', null, null, { navigation_preview_unverified: on });
  bumpContentVersion();
  res.json({ previewUnverified: on });
});
