// 2D maps for graph routes and the floor map (kiosk minimap, 2D fallback, map screen, phone page). Pure string
// output, no DOM, except placeWalker / followWalker which update an existing SVG.
//
// With a plan set (tools/model/render-plans.mjs) the floor is the REAL plan of the published model release.
// Without one, it falls back to the published walkable network drawn as faint corridors. Neither draws the
// database's placeholder room boxes: they do not match the building. Top-down canonical X/Z, +Z (into the building)
// up, so the entrance is at the bottom.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const W = 1000;

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

/** Shared frame: plan bounds when a plan exists (so both floors line up), else the floor's network bounds. */
function frame(graph, level, plan) {
  const b = plan?.bounds || floorBounds(graph, level) || { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
  const sc = W / (b.maxX - b.minX), H = Math.max(200, Math.round((b.maxZ - b.minZ) * sc));
  const X = x => +((x - b.minX) * sc).toFixed(1), Y = z => +(H - (z - b.minZ) * sc).toFixed(1);
  const base = plan
    ? `<image href="${esc(plan.href)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>`
    : `<rect width="${W}" height="${H}" fill="#FBF8F3"/>`;
  return { b, sc, H, X, Y, base };
}

const corridorsSVG = (graph, level, { X, Y, sc }) => {
  const nodeOf = id => graph.nodes.find(n => n.id === id);
  return graph.edges.filter(e => e.public !== false && (nodeOf(e.from)?.floor === level || nodeOf(e.to)?.floor === level)).map(e => {
    const pts = e.polyline.map(p => `${X(p.x)},${Y(p.z)}`).join(' ');
    const stairs = e.kind === 'stairs' || e.kind === 'lift' || e.kind === 'ramp';
    return `<polyline points="${pts}" fill="none" stroke="${stairs ? '#E9D9A8' : '#E7E1D6'}" stroke-width="${Math.max(10, 2.4 * sc)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
};

// walker: a dot with a heading wedge (rotated by placeWalker); hidden off-canvas until placed
const walkerSVG = (sc, small) => {
  const r = small ? 10 : 12, cone = Math.max(r * 2.6, 3.2 * sc);
  return `<g id="walker2d" transform="translate(-100 -100)"><path class="heading" d="M0 0 L${-cone * 0.55} ${-cone} A${cone} ${cone} 0 0 1 ${cone * 0.55} ${-cone} Z" fill="#1A63BE" fill-opacity=".28"/>
    <circle r="${r}" fill="#12355B" stroke="#fff" stroke-width="4"/></g>`;
};

const youSVG = (x, y, small, label) => `<g class="you">${small ? `<circle cx="${x}" cy="${y}" r="7" fill="#fff" stroke="#12355B" stroke-width="4"/>` : `<circle cx="${x}" cy="${y}" r="13" fill="#12355B" stroke="#fff" stroke-width="4"/>`}
  ${small || !label ? '' : `<text x="${x}" y="${y + 36}" font-size="20" text-anchor="middle" fill="#12355B" font-weight="700" font-family="sans-serif" paint-order="stroke" stroke="#fff" stroke-width="5">${esc(label)}</text>`}</g>`;

/**
 * Route on one floor.
 * @param {object} p
 * @param {object} p.graph published navigation graph
 * @param {object} p.route planner result (status ok)
 * @param {number} p.level floor to draw
 * @param {boolean} [p.small] minimap styling
 * @param {object} [p.labels] { you: 'You are here', door: 'Door', stairs: 'Stairs' }
 * @param {{href:string,bounds:object}|null} [p.plan] real floor plan for this level
 */
export function routeFloorSVG({ graph, route, level, small = false, labels = {}, plan = null }) {
  const f = frame(graph, level, plan), { X, Y, sc, H } = f;
  const nodeOf = id => graph.nodes.find(n => n.id === id);
  const onFloor = route.waypoints.filter(p => p.floor === level);
  const pts = onFloor.map(p => `${X(p.x)},${Y(p.z)}`).join(' ');
  const lw = small ? 8 : 9;
  const line = onFloor.length > 1 ? `<polyline points="${pts}" fill="none" stroke="#fff" stroke-width="${lw + 8}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity=".9"/>
    <polyline points="${pts}" fill="none" stroke="#1A63BE" stroke-width="${lw}" stroke-linecap="round" stroke-linejoin="round"/>` : '';
  const marks = [];
  // floor-change points: where this floor's part of the route meets stairs / lift
  for (const e of route.edges || []) if (e.kind !== 'walk' && e.kind !== 'door') {
    for (const id of [e.from, e.to]) {
      const n = nodeOf(id);
      const q = small ? 10 : 16;
      if (n?.floor === level) marks.push(`<g><rect x="${X(n.x) - q}" y="${Y(n.z) - q}" width="${2 * q}" height="${2 * q}" rx="${small ? 4 : 6}" fill="#D9A520" stroke="#fff" stroke-width="3"/>
        ${small ? '' : `<text x="${X(n.x)}" y="${Y(n.z) - 24}" font-size="20" text-anchor="middle" fill="#6B4E00" font-weight="700" font-family="sans-serif" paint-order="stroke" stroke="#fff" stroke-width="5">${esc(e.label || labels.stairs || e.kind)}</text>`}</g>`);
    }
  }
  const start = route.from;
  if (start && start.floor_level === level) marks.push(youSVG(X(start.x), Y(start.z), small, labels.you || 'You are here'));
  const door = route.to?.door, end = route.to;
  if (end && end.floor_level === level) {
    const d = door || end;
    // the door: a terracotta ring with a dot, so it never reads as the (navy) walker
    marks.push(`<g class="door"><circle cx="${X(d.x)}" cy="${Y(d.z)}" r="${small ? 11 : 15}" fill="#fff" stroke="#B8432F" stroke-width="${small ? 5 : 6}"/><circle cx="${X(d.x)}" cy="${Y(d.z)}" r="${small ? 4 : 6}" fill="#B8432F"/></g>
      ${small ? '' : `<text x="${X(d.x)}" y="${Y(d.z) - 24}" font-size="20" text-anchor="middle" fill="#B8432F" font-weight="700" font-family="sans-serif" paint-order="stroke" stroke="#fff" stroke-width="5">${esc(end.name || end.room_code || labels.door || '')}</text>`}`);
  }
  return `<svg class="mapsvg routemap${plan ? ' has-plan' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(graph.floors?.find(fl => fl.level === level)?.name || '')}"
    data-minx="${f.b.minX}" data-minz="${f.b.minZ}" data-sc="${sc}" data-h="${H}" data-w="${W}">
    ${f.base}${plan ? '' : corridorsSVG(graph, level, f)}${line}${marks.join('')}${walkerSVG(sc, small)}</svg>`;
}

/**
 * Floor map without a route (map screen, 2D view): the real plan, "You are here" and optional labelled points.
 * @param {{graph, level:number, plan?:object|null, you?:{x,z}|null, labels?:{you?:string}, points?:{x,z,label,color?}[]}} p
 */
export function floorPlanSVG({ graph, level, plan = null, you = null, labels = {}, points = [] }) {
  const f = frame(graph, level, plan), { X, Y, sc, H } = f;
  const pts = points.map(p => `<g${p.action ? ` class="tap" data-action="${esc(p.action)}" data-id="${esc(p.id)}" role="button" aria-label="${esc(p.label)}"` : ''}>${p.action ? `<circle cx="${X(p.x)}" cy="${Y(p.z)}" r="30" fill="transparent"/>` : ''}<circle cx="${X(p.x)}" cy="${Y(p.z)}" r="11" fill="${p.color || '#1A63BE'}" stroke="#fff" stroke-width="4"/>
    ${p.label ? `<text x="${X(p.x)}" y="${Y(p.z) - 20}" font-size="18" text-anchor="middle" fill="${p.color || '#1A63BE'}" font-weight="700" font-family="sans-serif" paint-order="stroke" stroke="#fff" stroke-width="5">${esc(p.label)}</text>` : ''}</g>`).join('');
  return `<svg class="mapsvg routemap floorplan${plan ? ' has-plan' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(graph.floors?.find(fl => fl.level === level)?.name || '')}"
    data-minx="${f.b.minX}" data-minz="${f.b.minZ}" data-sc="${sc}" data-h="${H}" data-w="${W}">
    ${f.base}${plan ? '' : corridorsSVG(graph, level, f)}${pts}${you ? youSVG(X(you.x), Y(you.z), false, labels.you || 'You are here') : ''}</svg>`;
}

// Splits a label into at most 3 lines of about `max` characters (word boundaries; the last line is ellipsised).
function wrapLines(text, max) {
  const lines = [];
  for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
    const cur = lines[lines.length - 1];
    if (cur != null && (cur + ' ' + w).length <= max) lines[lines.length - 1] = cur + ' ' + w; else lines.push(w);
  }
  if (lines.length > 3) { lines.length = 3; lines[2] = lines[2].replace(/\s*\S*$/, '') + '…'; }
  return lines;
}

/**
 * Arrival map: the destination floor, zoomed around the office's door, with the door highlighted (a pulsing halo, the
 * terracotta door ring) and a callout naming the office. The route walked so far is drawn faintly for context.
 * There are no verified room outlines, so the room is marked at its real doorway rather than with an invented box.
 * @param {{graph, route, plan?:object|null, title:string, sub?:string}} p
 */
export function arrivalSVG({ graph, route, plan = null, title, sub = '' }) {
  const end = route.to, level = end.floor_level, d = end.door || end;
  const f = frame(graph, level, plan), { X, Y, sc, H } = f;
  const dx = X(d.x), dy = Y(d.z);
  // crop: about 60 m of building around the door (16:10), kept inside the plan
  const vw = Math.min(W, 60 * sc), vh = Math.min(H, vw * 0.625);
  const vx = Math.max(0, Math.min(W - vw, dx - vw / 2)), vy = Math.max(0, Math.min(H - vh, dy - vh / 2));
  const u = vw / 600; // one "unit" ≈ 1px when the map is shown about 600px wide
  const onFloor = route.waypoints.filter(p => p.floor === level);
  const pts = onFloor.map(p => `${X(p.x)},${Y(p.z)}`).join(' ');
  const line = onFloor.length > 1 ? `<polyline points="${pts}" fill="none" stroke="#1A63BE" stroke-opacity=".45" stroke-width="${6 * u}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${2 * u} ${10 * u}"/>` : '';
  const start = route.from;
  const you = start && start.floor_level === level ? youSVG(X(start.x), Y(start.z), true) : '';
  const halo = `<g class="arrive-halo"><circle class="pulse" cx="${dx}" cy="${dy}" r="${46 * u}" fill="#B8432F" fill-opacity=".16"/>
    <circle cx="${dx}" cy="${dy}" r="${30 * u}" fill="#B8432F" fill-opacity=".22" stroke="#B8432F" stroke-opacity=".5" stroke-width="${2 * u}"/></g>
    <g class="door"><circle cx="${dx}" cy="${dy}" r="${15 * u}" fill="#fff" stroke="#B8432F" stroke-width="${6 * u}"/><circle cx="${dx}" cy="${dy}" r="${6 * u}" fill="#B8432F"/></g>`;
  // callout: navy plate with the office name (and room · floor), above the door unless that leaves the crop
  const fs = 24 * u, fs2 = 18 * u, lh = fs * 1.2, pad = 14 * u;
  const lines = wrapLines(title, 30);
  const boxW = Math.min(vw - 16 * u, Math.max(...lines.map(l => l.length * fs * 0.56), sub.length * fs2 * 0.55) + pad * 2);
  const boxH = pad * 2 + lines.length * lh + (sub ? fs2 * 1.4 : 0);
  const gap = 56 * u, above = dy - gap - boxH >= vy + 8 * u;
  const by = above ? dy - gap - boxH : dy + gap;
  const bx = Math.max(vx + 8 * u, Math.min(vx + vw - 8 * u - boxW, dx - boxW / 2));
  const cx = bx + boxW / 2;
  const text = lines.map((l, i) => `<tspan x="${cx}" y="${by + pad + fs * 0.85 + i * lh}">${esc(l)}</tspan>`).join('');
  const callout = `<g class="arrive-callout"><line x1="${dx}" y1="${above ? dy - 17 * u : dy + 17 * u}" x2="${dx}" y2="${above ? by + boxH : by}" stroke="#12355B" stroke-width="${3 * u}"/>
    <rect x="${bx}" y="${by}" width="${boxW}" height="${boxH}" rx="${10 * u}" fill="#12355B" stroke="#fff" stroke-width="${3 * u}"/>
    <text font-size="${fs}" font-weight="700" fill="#fff" text-anchor="middle" font-family="sans-serif">${text}</text>
    ${sub ? `<text x="${cx}" y="${by + pad + lines.length * lh + fs2 * 0.95}" font-size="${fs2}" fill="#DCE8F5" text-anchor="middle" font-family="sans-serif">${esc(sub)}</text>` : ''}</g>`;
  return `<svg class="mapsvg routemap arrivalmap${plan ? ' has-plan' : ''}" viewBox="${vx.toFixed(1)} ${vy.toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}" role="img"
    aria-label="${esc([title, sub].filter(Boolean).join(', '))}" preserveAspectRatio="xMidYMid meet">
    ${f.base}${plan ? '' : corridorsSVG(graph, level, f)}${line}${you}${halo}${callout}</svg>`;
}

const toSvg = (svg, pos) => {
  const minX = +svg.dataset.minx, minZ = +svg.dataset.minz, sc = +svg.dataset.sc, H = +svg.dataset.h;
  return { x: (pos.x - minX) * sc, y: H - (pos.z - minZ) * sc, sc };
};

/** Positions the walker (dot + heading wedge) on any map SVG that carries data-minx/minz/sc/h. pos.yaw is optional. */
export function placeWalker(svg, pos) {
  const w = svg?.querySelector('#walker2d');
  if (!w) return;
  w.setAttribute('visibility', pos ? 'visible' : 'hidden');
  if (!pos) return;
  const p = toSvg(svg, pos);
  // The placeholder plan uses a circle; graph plans use a group with a heading wedge.
  if (w.tagName.toLowerCase() === 'circle') { w.setAttribute('cx', '0'); w.setAttribute('cy', '0'); }
  const deg = Number.isFinite(pos.yaw) ? pos.yaw * 180 / Math.PI : null; // canonical yaw 0 = +Z = map up
  w.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})${deg === null ? '' : ` rotate(${deg.toFixed(1)})`}`);
  w.querySelector('.heading')?.setAttribute('visibility', deg === null ? 'hidden' : 'visible');
}

/**
 * Minimap follow view: frames spanM metres around pos (kept inside the map), at the element's aspect ratio.
 * Pass pos = null to show the whole floor.
 */
export function followWalker(svg, pos, spanM = 34) {
  if (!svg) return;
  const fullW = +svg.dataset.w || W, fullH = +svg.dataset.h;
  if (!pos) { svg.setAttribute('viewBox', `0 0 ${fullW} ${fullH}`); return; }
  const rect = svg.getBoundingClientRect(), aspect = rect.width && rect.height ? rect.height / rect.width : 0.75;
  const p = toSvg(svg, pos);
  let vw = Math.min(fullW, spanM * p.sc), vh = vw * aspect;
  if (vh > fullH) { vh = fullH; vw = vh / aspect; }
  const x = Math.max(0, Math.min(fullW - vw, p.x - vw / 2)), y = Math.max(0, Math.min(fullH - vh, p.y - vh / 2));
  svg.setAttribute('viewBox', `${x.toFixed(1)} ${y.toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}`);
}
