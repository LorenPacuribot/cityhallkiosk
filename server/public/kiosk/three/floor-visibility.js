// Which floor each exported object belongs to, for cutaway display only (never used for routing).
// Order of evidence: the export's assetZone (GF / F2 / F3Roof from the source object name), then the opening ID
// prefix of doors and signs (R1/F1 -> 1, R2/F2 -> 2, R3/F3 -> 3), then the object's lowest point.
// This is provisional display metadata, recorded per object as `levelSource` so it can be reviewed.
const ZONE_LEVEL = { GF: 1, F2: 2, F3Roof: 3 };

export function displayLevel(node) {
  if (node.assetZone && ZONE_LEVEL[node.assetZone]) return { level: ZONE_LEVEL[node.assetZone], source: 'zone' };
  const m = /^[RF](\d)-/.exec(node.openingId || '');
  if (m) return { level: Number(m[1]), source: 'opening' };
  const b = node.boundsGltf;
  if (b) { const y = b[0][1]; return { level: y < 3.5 ? 1 : y < 7.5 ? 2 : 3, source: 'height' }; }
  return { level: null, source: 'unknown' };
}

export class FloorVisibility {
  constructor(release) {
    this.groups = new Map(); // level -> Object3D[]
    this.unknown = [];
    for (const [id, node] of release.nodes) {
      if (node.role === 'scenery' || node.role?.startsWith('viewpoint')) continue;
      if (node.parent && release.nodes.get(node.parent)?.role === 'door_root') continue; // follows its door root
      const obj = release.index.get(id);
      if (!obj) continue;
      const { level, source } = displayLevel(node);
      obj.userData.displayLevel = level; obj.userData.levelSource = source;
      if (level === null) { this.unknown.push(obj); continue; }
      if (!this.groups.has(level)) this.groups.set(level, []);
      this.groups.get(level).push(obj);
    }
    this.current = null;
  }
  /** Show floors up to and including `level`; everything above is hidden so the visitor can see inside. */
  showUpTo(level) {
    if (this.current === level) return false;
    for (const [l, objs] of this.groups) for (const o of objs) o.visible = l <= level;
    this.current = level;
    return true;
  }
  showAll() { for (const objs of this.groups.values()) for (const o of objs) o.visible = true; this.current = null; }
  levels() { return [...this.groups.keys()].sort((a, b) => a - b); }
}
