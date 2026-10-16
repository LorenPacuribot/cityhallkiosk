// Extract horizontal / vertical rules (table borders) from PDF pages via the operator list.
// Exports getRules(page) -> { h: [{y, x1, x2}], v: [{x, y1, y2}] } in top-left page coordinates.
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const OPS = pdfjs.OPS;

function mul(m, n) { // m then n (pdf matrices [a b c d e f])
  return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

async function getRules(page) {
  const vp = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
  const h = [], v = [];
  const addBox = (x1, y1, x2, y2) => { // in device space (pdf, y up)
    const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)], [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)];
    const w = bx - ax, hh = by - ay;
    if (hh <= 3 && w > 8) h.push({ y: +(vp.height - (ay + by) / 2).toFixed(1), x1: +ax.toFixed(1), x2: +bx.toFixed(1) });
    else if (w <= 3 && hh > 8) v.push({ x: +((ax + bx) / 2).toFixed(1), y1: +(vp.height - by).toFixed(1), y2: +(vp.height - ay).toFixed(1) });
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(args, ctm);
    else if (fn === OPS.constructPath) {
      const [ops, coords] = args; let k = 0; let cur = null;
      for (const op of ops) {
        if (op === OPS.rectangle) {
          const [x, y, w, hh] = coords.slice(k, k + 4); k += 4;
          const p1 = apply(ctm, x, y), p2 = apply(ctm, x + w, y + hh);
          addBox(p1[0], p1[1], p2[0], p2[1]);
        } else if (op === OPS.moveTo) { cur = apply(ctm, coords[k], coords[k + 1]); k += 2; }
        else if (op === OPS.lineTo) { const p = apply(ctm, coords[k], coords[k + 1]); k += 2; if (cur) addBox(cur[0], cur[1], p[0], p[1]); cur = p; }
        else if (op === OPS.curveTo) k += 6; else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 4;
      }
    }
  }
  return { h, v };
}
module.exports = { getRules };
