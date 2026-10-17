// Camera-facing text labels for the 3D views (destination tag, office names on the floor map).
// Text wraps onto at most `maxLines` lines and shrinks before it is ever cut, so names are never truncated
// unless they would need more than maxLines at the smallest size.
import * as THREE from 'three';

const FONT = '"Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif';

function wrap(ctx, text, width, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean), lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= width || !line) line = next;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.length <= maxLines ? lines : null;
}

/**
 * @param {{title?:string, subtitle?:string, accent?:string, ink?:string, maxLines?:number, width?:number}} o
 * @param {(x:any)=>any} track registers the texture/material for disposal
 * @returns {{sprite: THREE.Sprite, aspect: number}} aspect = height / width
 */
export function makeTextLabel({ title = '', subtitle = '', accent = '#B8432F', ink = '#12355B', maxLines = 2, width = 1024 } = {}, track = x => x) {
  const c = document.createElement('canvas'), x = c.getContext('2d');
  const pad = 44, inner = width - pad * 2;
  let titleSize = 88, subSize = 60, tLines, sLines;
  for (;;) {
    x.font = `bold ${titleSize}px ${FONT}`; tLines = title ? wrap(x, title, inner, 1) || wrap(x, title, inner, maxLines) : [];
    x.font = `600 ${subSize}px ${FONT}`; sLines = subtitle ? wrap(x, subtitle, inner, maxLines) : [];
    if ((tLines && sLines) || subSize <= 40) break;
    titleSize -= 6; subSize -= 4;
  }
  if (!tLines) tLines = [title];
  if (!sLines) { // still too long at the smallest size: keep maxLines and end with an ellipsis
    x.font = `600 ${subSize}px ${FONT}`;
    sLines = wrap(x, subtitle, inner, 99).slice(0, maxLines);
    sLines[maxLines - 1] = sLines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  const lh1 = titleSize * 1.15, lh2 = subSize * 1.22;
  const height = Math.ceil(pad * 1.4 + tLines.length * lh1 + sLines.length * lh2);
  c.width = width; c.height = height;
  x.fillStyle = 'rgba(255,255,255,0.97)'; x.strokeStyle = accent; x.lineWidth = 10;
  x.beginPath(); x.roundRect ? x.roundRect(6, 6, width - 12, height - 12, 40) : x.rect(6, 6, width - 12, height - 12); x.fill(); x.stroke();
  x.textAlign = 'center'; x.textBaseline = 'middle';
  let y = pad * 0.7 + lh1 / 2;
  x.fillStyle = accent; x.font = `bold ${titleSize}px ${FONT}`;
  for (const l of tLines) { x.fillText(l, width / 2, y); y += lh1; }
  y += (lh2 - lh1) / 2;
  x.fillStyle = ink; x.font = `600 ${subSize}px ${FONT}`;
  for (const l of sLines) { x.fillText(l, width / 2, y); y += lh2; }
  const tex = track(new THREE.CanvasTexture(c)); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const sprite = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, toneMapped: false })));
  sprite.renderOrder = 10;
  return { sprite, aspect: height / width };
}

/** "2nd floor, left wing — doorway R2-W032-D210" + code "R2-W032-D210" -> "2nd floor, left wing" */
export function nameWithoutCode(name, code) {
  if (!name || !code) return name || '';
  if (name.trim().toLowerCase() === `room ${code}`.toLowerCase()) return ''; // a placeholder name adds nothing to the code
  return name.replace(new RegExp(`\\s*[—–-]\\s*(doorway\\s+)?${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim() || name;
}
