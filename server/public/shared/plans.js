// Real floor-plan images of the published model release (written by tools/model/render-plans.mjs).
// A plan set is used only when its model version is exactly the published one; otherwise maps fall back to the
// walkable network. Shared by the kiosk and the phone page.
const cache = new Map();

/** @returns {Promise<object|null>} plans.json of the published release, or null */
export function loadPlans(nav) {
  const v = nav?.model?.modelVersion;
  if (!v) return Promise.resolve(null);
  if (!cache.has(v)) {
    const base = `/models/plans/${encodeURIComponent(v)}/`;
    cache.set(v, fetch(base + 'plans.json')
      .then(r => r.ok ? r.json() : null)
      .then(p => {
        if (!p || p.modelVersion !== v || !Array.isArray(p.levels) || !p.bounds) return null;
        p.base = base;
        // warm the image cache so the first map draws at once
        if (typeof Image !== 'undefined') for (const l of p.levels) { const i = new Image(); i.decoding = 'async'; i.src = base + l.file; }
        return p;
      })
      .catch(() => null));
  }
  return cache.get(v);
}

/** The plan for one floor in the form route-map.js takes, or null. */
export function planFor(plans, level) {
  const l = plans?.levels?.find(x => x.level === level);
  return l ? { href: plans.base + l.file, bounds: plans.bounds, level, name: l.name } : null;
}
