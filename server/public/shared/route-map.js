// 2D directions map for graph routes (kiosk fallback, minimap and phone page). Pure string output, no DOM.
// It draws the published walkable network as faint corridors, the route on top, the start and the destination
// door. It deliberately does NOT draw the database's placeholder room boxes: they do not match the building.
// Top-down canonical X/Z, +Z (into the building) up.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function floorBounds(graph, level, margin = 4) {
  const pts = [];
  for (const n of graph.nodes) if (n.floor === level) pts.push(n);
  for (const e of graph.edges) {
    const a = graph.nodes.find(n => n.id === e.from), b = graph.nodes.find(n => n.id === e.to);
    if (a?.floor === level || b?.floor === level) pts.push(...e.polyline);
  }
  if (!pts.length) return null;
  const xs = pts.map(p => p.x), zs = pts.map(p => p.z);
  return { minX: Math.min(...xs) - margin, maxX: Math.max(...xs) + margin, minZ: Math.min(...zs) - margin, maxZ: Math.max(...zs) + margin };
}

/**
 * @param {object} p
 * @param {object} p.graph published navigation graph
 * @param {object} p.route planner result (status ok)
 * @param {number} p.level floor to draw
 * @param {boolean} [p.small] minimap styling
 * @param {object} [p.labels] { you: 'You are here', door: 'Door', stairs: 'Stairs' }
 */
export function routeFloorSVG({ graph, route, level, small = false, labels = {} }) {
  const b = floorBounds(graph, level) || { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
  const W = 1000, sc = W / (b.maxX - b.minX), H = Math.max(200, Math.round((b.maxZ - b.minZ) * sc));
  const X = x => +((x - b.minX) * sc).toFixed(1), Y = z => +(H - (z - b.minZ) * sc).toFixed(1);
  const nodeOf = id => graph.nodes.find(n => n.id === id);
  const corridors = graph.edges.filter(e => e.public !== false && (nodeOf(e.from)?.floor === level || nodeOf(e.to)?.floor === level)).map(e => {
    const pts = e.polyline.map(p => `${X(p.x)},${Y(p.z)}`).join(' ');
    const stairs = e.kind === 'stairs' || e.kind === 'lift' || e.kind === 'ramp';
    return `<polyline points="${pts}" fill="none" stroke="${stairs ? '#E9D9A8' : '#E7E1D6'}" stroke-width="${Math.max(10, 2.4 * sc)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  const onFloor = route.waypoints.filter(p => p.floor === level);
  const line = onFloor.length > 1 ? `<polyline points="${onFloor.map(p => `${X(p.x)},${Y(p.z)}`).join(' ')}" fill="none" stroke="#1A63BE" stroke-width="${small ? 12 : 9}" stroke-linecap="round" stroke-linejoin="round"/>` : '';
  const marks = [];
  // floor-change points: where this floor's part of the route meets stairs / lift
  for (const e of route.edges || []) if (e.kind !== 'walk' && e.kind !== 'door') {
    for (const id of [e.from, e.to]) {
      const n = nodeOf(id);
      if (n?.floor === level) marks.push(`<g><rect x="${X(n.x) - 16}" y="${Y(n.z) - 16}" width="32" height="32" rx="6" fill="#D9A520" stroke="#fff" stroke-width="3"/>
        ${small ? '' : `<text x="${X(n.x)}" y="${Y(n.z) - 24}" font-size="18" text-anchor="middle" fill="#6B4E00" font-weight="700" font-family="sans-serif">${esc(e.label || labels.stairs || e.kind)}</text>`}</g>`);
    }
  }
  const start = route.from;
  if (start && start.floor_level === level) marks.push(`<circle cx="${X(start.x)}" cy="${Y(start.z)}" r="${small ? 14 : 12}" fill="#12355B" stroke="#fff" stroke-width="4"/>
    ${small ? '' : `<text x="${X(start.x)}" y="${Y(start.z) + 34}" font-size="18" text-anchor="middle" fill="#12355B" font-weight="700" font-family="sans-serif">${esc(labels.you || 'You are here')}</text>`}`);
  const door = route.to?.door, end = route.to;
  if (end && end.floor_level === level) {
    const d = door || end;
    marks.push(`<circle cx="${X(d.x)}" cy="${Y(d.z)}" r="${small ? 16 : 14}" fill="#B8432F" stroke="#fff" stroke-width="4"/>
      ${small ? '' : `<text x="${X(d.x)}" y="${Y(d.z) - 24}" font-size="18" text-anchor="middle" fill="#B8432F" font-weight="700" font-family="sans-serif">${esc(end.room_code || labels.door || '')}</text>`}`);
  }
  return `<svg class="mapsvg routemap" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(graph.floors?.find(f => f.level === level)?.name || '')}"
    data-minx="${b.minX}" data-minz="${b.minZ}" data-sc="${sc}" data-h="${H}">
    <rect width="${W}" height="${H}" fill="#FBF8F3"/>${corridors}${line}${marks.join('')}
    <circle id="walker2d" cx="-50" cy="-50" r="${small ? 16 : 12}" fill="#B8432F" stroke="#fff" stroke-width="4"/></svg>`;
}

/** Positions the walker dot on any map SVG that carries data-minx/minz/sc/h (both map kinds do). */
export function placeWalker(svg, pos) {
  const w = svg?.querySelector('#walker2d');
  if (!w) return;
  if (!pos) { w.setAttribute('cx', -50); return; }
  const minX = +svg.dataset.minx, minZ = +svg.dataset.minz, sc = +svg.dataset.sc, H = +svg.dataset.h;
  w.setAttribute('cx', (pos.x - minX) * sc); w.setAttribute('cy', H - (pos.z - minZ) * sc);
}
