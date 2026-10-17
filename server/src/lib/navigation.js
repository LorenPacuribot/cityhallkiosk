// Navigation data: graph revisions, opening/sign mappings, calibration and the published tuple.
// The planner itself is public/shared/nav-graph.js so the server, kiosk and phone compute the same route.
import { all, get, run, tx, setting } from '../db.js';
import { validateGraph, planGraphRoute, resolveDestination, ROUTE_REASONS } from '../../public/shared/nav-graph.js';

const bool = v => v === 1 || v === true;
const triBool = v => v === null || v === undefined ? null : bool(v);

// ------------------------------------------------------------------ read
export function revisionByVersion(v) { return get('SELECT * FROM navigation_revisions WHERE navigation_version = ?', [v]); }

export function currentPublication() { return get(`SELECT * FROM navigation_publications WHERE status = 'published'`); }

/** Graph object in the planner's format for one revision (all nodes/edges; the planner filters by status). */
export function loadGraph(revisionId) {
  const rev = get('SELECT * FROM navigation_revisions WHERE id = ?', [revisionId]);
  if (!rev) return null;
  const nodes = all('SELECT * FROM navigation_nodes WHERE revision_id = ? ORDER BY node_id', [revisionId]).map(n => ({
    id: n.node_id, x: n.x, y: n.y, z: n.z, floor: n.floor_level, role: n.role, label: n.label, verified: bool(n.verified), source: n.source }));
  const edges = all('SELECT * FROM navigation_edges WHERE revision_id = ? ORDER BY edge_id', [revisionId]).map(e => ({
    id: e.edge_id, from: e.from_node, to: e.to_node, kind: e.kind, polyline: JSON.parse(e.polyline_json), length_m: e.length_m,
    bidirectional: bool(e.bidirectional), verified: bool(e.verified), public: bool(e.is_public), step_free: triBool(e.step_free),
    closed: bool(e.closed), closed_reason: e.closed_reason, label: e.label, source: e.source }));
  const kiosks = Object.fromEntries(all('SELECT kiosk_code, node_id FROM kiosk_navigation_nodes WHERE revision_id = ?', [revisionId]).map(k => [k.kiosk_code, k.node_id]));
  const openings = all(`SELECT o.*, r.code AS room_code, r.name AS room_name FROM room_openings o LEFT JOIN rooms r ON r.id = o.room_id
                         WHERE o.revision_id = ? ORDER BY o.opening_id`, [revisionId]).map(o => ({
    openingId: o.opening_id, roomId: o.room_id, roomCode: o.room_code, roomName: o.room_name, status: o.status,
    approachNodeId: o.approach_node_id, doorPoint: o.door_x === null ? null : { x: o.door_x, y: o.door_y, z: o.door_z },
    label: o.label, doorAssetIds: JSON.parse(o.door_asset_ids_json || '[]'), reviewedAt: o.reviewed_at }));
  const signs = all('SELECT sign_asset_id, opening_id, face, status FROM sign_bindings WHERE revision_id = ? ORDER BY sign_asset_id', [revisionId])
    .map(s => ({ assetId: s.sign_asset_id, openingId: s.opening_id, face: s.face, status: s.status }));
  return { revisionId, modelVersion: rev.model_version, navigationVersion: rev.navigation_version, calibrationVersion: rev.calibration_version,
    status: rev.status, floors: JSON.parse(rev.floors_json), nodes, edges, kiosks, openings, signs,
    fieldVerificationNeeded: JSON.parse(rev.field_checklist_json || '[]'), note: rev.note };
}

export function calibrationRecord(version) {
  const c = get('SELECT * FROM model_calibrations WHERE calibration_version = ?', [version]);
  if (!c) return null;
  return { calibrationVersion: c.calibration_version, modelVersion: c.model_version, status: c.status, description: c.description,
    matrixBlenderToCanonical: JSON.parse(c.matrix_json), anchors: JSON.parse(c.anchors_json), floorElevations: JSON.parse(c.floor_elevations_json),
    verifiedAt: c.verified_at };
}

export function modelRelease(version) {
  const m = get('SELECT * FROM model_releases WHERE model_version = ?', [version]);
  return m && { modelVersion: m.model_version, baseUrl: m.base_url, sourceBlendSha256: m.source_blend_sha256, status: m.status };
}

/** What a kiosk/phone needs: the published tuple, its graph, calibration and model release. null if nothing is published. */
export function publishedNavigation() {
  const p = currentPublication();
  if (!p) return null;
  const rev = revisionByVersion(p.navigation_version);
  const graph = rev && loadGraph(rev.id);
  if (!graph) return null;
  return {
    publication: { id: p.id, modelVersion: p.model_version, calibrationVersion: p.calibration_version, navigationVersion: p.navigation_version,
      contentVersion: p.content_version, publishedAt: p.published_at },
    previewUnverified: setting('navigation_preview_unverified', '0') === '1',
    model: modelRelease(p.model_version),
    calibration: calibrationRecord(p.calibration_version),
    graph,
  };
}

/** What a visitor's phone may see: public, open edges only; no internal evidence notes or mapping workflow. */
export function publicNavigation() {
  const nav = publishedNavigation();
  if (!nav) return null;
  const g = nav.graph;
  const edges = g.edges.filter(e => e.public && !e.closed).map(({ source, closed_reason, ...e }) => e);
  const used = new Set(edges.flatMap(e => [e.from, e.to]));
  return {
    publication: nav.publication,
    graph: { modelVersion: g.modelVersion, navigationVersion: g.navigationVersion, floors: g.floors,
      nodes: g.nodes.filter(n => used.has(n.id)).map(({ source, ...n }) => n), edges },
  };
}

// ------------------------------------------------------------------ routing
/** DB lookup -> shared resolveDestination (public/shared/nav-graph.js), so the kiosk resolves identically. */
export function resolveFromDb(graph, { officeId, roomId, openingId }, { preview = false, kioskCode = null } = {}) {
  if (openingId) return resolveDestination(graph, { openingId }, { preview });
  if (officeId) {
    const office = get('SELECT * FROM v_office_current_location WHERE office_id = ?', [officeId]);
    if (!office) return { reason: ROUTE_REASONS.UNKNOWN_DESTINATION, message: 'Office not found.' };
    return resolveDestination(graph, { roomId: office.room_id, locationType: office.location_type, officeName: office.office_name }, { preview, kioskCode });
  }
  if (!roomId) return { reason: ROUTE_REASONS.UNKNOWN_DESTINATION, message: 'No destination given.' };
  if (!get('SELECT 1 FROM rooms WHERE id = ?', [roomId])) return { reason: ROUTE_REASONS.UNKNOWN_DESTINATION, message: 'Room not found.' };
  return resolveDestination(graph, { roomId, locationType: 'in_building' }, { preview, kioskCode });
}

export function planPublishedRoute({ kioskCode, officeId, roomId, openingId, preference = 'any', preview = false }) {
  const nav = publishedNavigation();
  if (!nav) return null; // caller decides (prototype mode)
  const allowUnverified = preview && nav.previewUnverified;
  const meta = { modelVersion: nav.graph.modelVersion, navigationVersion: nav.graph.navigationVersion, contentVersion: Number(setting('content_version', '1')),
    routePreference: preference, originKioskCode: kioskCode, routeSource: 'navigation_graph' };
  const d = resolveFromDb(nav.graph, { officeId, roomId, openingId }, { preview: allowUnverified, kioskCode });
  if (!d.destination) return { status: 'no_route', ...meta, reason: d.reason, message: d.message };
  const r = planGraphRoute({ graph: nav.graph, kioskCode, destination: d.destination, preference, allowUnverified,
    versions: { modelVersion: nav.publication.modelVersion, contentVersion: meta.contentVersion } });
  return { ...r, routeSource: 'navigation_graph', calibrationVersion: nav.publication.calibrationVersion, calibrationStatus: nav.calibration?.status ?? null,
    destinationMapping: d.destination.mapping, preview: allowUnverified };
}

// ------------------------------------------------------------------ import / validate / publish
export class NavError extends Error { constructor(msg, status = 400, detail = null) { super(msg); this.status = status; this.detail = detail; } }

/** Imports a graph JSON (tools/model/pilot-graph.mjs format) as a new DRAFT revision. Never edits a published one. */
export function importGraph(g, user, { dryRun = false } = {}) {
  const problems = validateGraph(g);
  if (!g.navigationVersion || !g.modelVersion) problems.push('navigationVersion and modelVersion are required');
  if (g.calibration && g.calibration.modelVersion !== g.modelVersion) problems.push('calibration is for a different model version');
  if (revisionByVersion(g.navigationVersion)) problems.push(`navigation version ${g.navigationVersion} already exists (revisions are immutable once imported)`);
  const nodeIds = new Set(g.nodes.map(n => n.id));
  for (const o of g.openings || []) {
    if (o.approachNodeId && !nodeIds.has(o.approachNodeId)) problems.push(`opening ${o.openingId}: unknown approach node`);
    if (o.status === 'verified') problems.push(`opening ${o.openingId}: imports cannot mark mappings verified; staff verify them in the admin panel`);
  }
  if ((g.edges || []).some(e => e.verified) || (g.nodes || []).some(n => n.verified)) problems.push('imports cannot mark nodes or edges verified; staff verify them in the admin panel');
  const openingIds = new Set((g.openings || []).map(o => o.openingId));
  for (const s of g.signs || []) if (!openingIds.has(s.openingId)) problems.push(`sign ${s.assetId}: opening ${s.openingId} not listed`);
  const summary = { navigationVersion: g.navigationVersion, modelVersion: g.modelVersion, nodes: g.nodes?.length || 0, edges: g.edges?.length || 0,
    openings: g.openings?.length || 0, signs: g.signs?.length || 0, kiosks: Object.keys(g.kiosks || {}), problems };
  if (problems.length) throw new NavError('Graph is not valid', 422, summary);
  if (dryRun) return { dryRun: true, ...summary };
  const cal = g.calibration;
  tx(() => {
    if (cal && !get('SELECT 1 FROM model_calibrations WHERE calibration_version = ?', [cal.calibrationVersion])) {
      if (cal.status === 'verified') throw new NavError('imports cannot create a verified calibration', 422);
      run(`INSERT INTO model_calibrations(calibration_version, model_version, status, matrix_json, anchors_json, floor_elevations_json, description)
           VALUES (?,?,?,?,?,?,?)`, [cal.calibrationVersion, cal.modelVersion, 'draft', JSON.stringify(cal.matrixBlenderToCanonical),
        JSON.stringify(cal.anchors || []), JSON.stringify(cal.floorElevations || {}), cal.description || null]);
    }
    if (!get('SELECT 1 FROM model_calibrations WHERE calibration_version = ?', [g.calibrationVersion])) throw new NavError(`calibration ${g.calibrationVersion} does not exist`, 422);
    const rev = run(`INSERT INTO navigation_revisions(navigation_version, model_version, calibration_version, status, floors_json, note, field_checklist_json, created_by)
                     VALUES (?,?,?,?,?,?,?,?)`, [g.navigationVersion, g.modelVersion, g.calibrationVersion, 'draft', JSON.stringify(g.floors || []), g.note || null,
      JSON.stringify(g.fieldVerificationNeeded || []), user?.id ?? null]).lastId;
    for (const n of g.nodes) run(`INSERT INTO navigation_nodes(revision_id,node_id,x,y,z,floor_level,role,label,source,verified) VALUES (?,?,?,?,?,?,?,?,?,0)`,
      [rev, n.id, n.x, n.y, n.z, n.floor, n.role || 'junction', n.label || null, n.source || null]);
    for (const e of g.edges) run(`INSERT INTO navigation_edges(revision_id,edge_id,from_node,to_node,kind,polyline_json,length_m,bidirectional,verified,is_public,step_free,closed,label,source)
                                  VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
      [rev, e.id, e.from, e.to, e.kind, JSON.stringify(e.polyline), e.length_m, e.bidirectional === false ? 0 : 1, e.public === false ? 0 : 1,
        e.step_free === null || e.step_free === undefined ? null : e.step_free ? 1 : 0, e.closed ? 1 : 0, e.label || null, e.source || null]);
    for (const [code, nodeId] of Object.entries(g.kiosks || {})) run('INSERT INTO kiosk_navigation_nodes(revision_id,kiosk_code,node_id,verified) VALUES (?,?,?,0)', [rev, code, nodeId]);
    for (const o of g.openings || []) run(`INSERT INTO room_openings(revision_id,opening_id,room_id,door_asset_ids_json,approach_node_id,door_x,door_y,door_z,label,status)
                                          VALUES (?,?,NULL,?,?,?,?,?,?,'unresolved')`,
      [rev, o.openingId, JSON.stringify(o.doorAssetIds || []), o.approachNodeId || null, o.doorPoint?.x ?? null, o.doorPoint?.y ?? null, o.doorPoint?.z ?? null, o.label || null]);
    for (const s of g.signs || []) run(`INSERT INTO sign_bindings(revision_id,sign_asset_id,opening_id,face,status) VALUES (?,?,?,?,'unresolved')`, [rev, s.assetId, s.openingId, s.face]);
  });
  return { imported: true, ...summary };
}

/** Admin validation report: everything that stops a revision from giving verified public directions. */
export function validationReport(revisionId) {
  const g = loadGraph(revisionId);
  if (!g) throw new NavError('Unknown navigation revision', 404);
  const cal = calibrationRecord(g.calibrationVersion);
  const structural = validateGraph(g);
  const kioskCodes = all('SELECT code FROM kiosks WHERE is_active = 1').map(k => k.code);
  const routes = [];
  for (const o of g.openings.filter(x => x.approachNodeId)) for (const code of Object.keys(g.kiosks)) {
    const dest = { nodeId: o.approachNodeId, name: o.label, code: o.openingId, doorPoint: o.doorPoint };
    const strict = planGraphRoute({ graph: g, kioskCode: code, destination: dest });
    const preview = planGraphRoute({ graph: g, kioskCode: code, destination: dest, allowUnverified: true });
    const stepFree = planGraphRoute({ graph: g, kioskCode: code, destination: dest, preference: 'step_free', allowUnverified: true });
    routes.push({ kiosk: code, opening: o.openingId, strict: strict.status === 'ok' ? 'ok' : strict.reason,
      preview: preview.status === 'ok' ? `ok ${preview.distance_m} m via ${preview.edges.map(e => e.id).join(' ')}` : preview.reason,
      stepFree: stepFree.status === 'ok' ? 'ok' : stepFree.reason });
  }
  const dbFloors = all('SELECT level, elevation_y FROM floors');
  const floorMismatch = cal ? Object.entries(cal.floorElevations || {}).flatMap(([lvl, y]) => {
    const f = dbFloors.find(d => d.level === Number(lvl));
    return f && Math.abs(f.elevation_y - y) > 0.05 ? [`floor ${lvl}: database elevation_y ${f.elevation_y} m, model calibration ${y} m`] : [];
  }) : [];
  return {
    navigationVersion: g.navigationVersion, modelVersion: g.modelVersion, status: g.status, structural,
    calibration: cal ? { version: cal.calibrationVersion, status: cal.status, residualsMeasured: (cal.anchors || []).some(a => a.residual_m !== null) } : null,
    counts: { nodes: g.nodes.length, edges: g.edges.length, verifiedEdges: g.edges.filter(e => e.verified).length,
      stepFreeKnown: g.edges.filter(e => e.step_free !== null).length, closedEdges: g.edges.filter(e => e.closed).length },
    unresolvedOpenings: g.openings.filter(o => o.status === 'unresolved').map(o => o.openingId),
    draftOpenings: g.openings.filter(o => o.status === 'draft').map(o => o.openingId),
    unmappedSigns: g.signs.filter(s => s.status !== 'verified').length,
    unverifiedKiosks: Object.keys(g.kiosks),
    activeKiosksWithoutNode: kioskCodes.filter(c => !g.kiosks[c]),
    floorElevationMismatch: floorMismatch,
    routes,
    fieldVerificationNeeded: g.fieldVerificationNeeded,
  };
}

export function publish(navigationVersion, user) {
  const rev = revisionByVersion(navigationVersion);
  if (!rev) throw new NavError('Unknown navigation revision', 404);
  const report = validationReport(rev.id);
  if (report.structural.length) throw new NavError('Structural problems; cannot publish', 422, report);
  if (!report.calibration) throw new NavError('No calibration for this revision', 422, report);
  if (!modelRelease(rev.model_version)) throw new NavError(`Model release ${rev.model_version} is not registered`, 422, report);
  const content = Number(setting('content_version', '1'));
  tx(() => {
    run(`UPDATE navigation_publications SET status = 'superseded' WHERE status = 'published'`);
    run(`UPDATE navigation_revisions SET status = 'retired' WHERE status = 'published'`);
    run(`UPDATE navigation_revisions SET status = 'published' WHERE id = ?`, [rev.id]);
    run(`INSERT INTO navigation_publications(model_version, calibration_version, navigation_version, content_version, status, validation_json, published_by)
         VALUES (?,?,?,?,'published',?,?)`, [rev.model_version, rev.calibration_version, rev.navigation_version, content, JSON.stringify(report), user?.id ?? null]);
  });
  return { published: navigationVersion, report };
}

export function registerModelRelease({ modelVersion, baseUrl, sourceBlendSha256, manifestSha256 = null }) {
  if (get('SELECT 1 FROM model_releases WHERE model_version = ?', [modelVersion])) return { existing: true };
  run(`INSERT INTO model_releases(model_version, base_url, source_blend_sha256, manifest_sha256, status) VALUES (?,?,?,?, 'available')`,
    [modelVersion, baseUrl, sourceBlendSha256, manifestSha256]);
  return { registered: true };
}
