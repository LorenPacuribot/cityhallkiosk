// Typo-tolerant search over services and offices.
// Small data set (a few hundred records), so an in-memory index is fast and simple.
import { all } from './db.js';

const STOP = new Set(['of', 'the', 'for', 'and', 'a', 'an', 'to', 'in', 'on', 'ng', 'sa', 'ang', 'mga', 'with', 'or', 'by', 'under']);

export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const tokens = s => normalize(s).split(' ').filter(t => t && !STOP.has(t));

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function tokenScore(q, words) {
  let best = 0;
  for (const w of words) {
    if (w === q) return 10;
    if (w.startsWith(q) && q.length >= 2) best = Math.max(best, 7);
    else if (q.length >= 4) {
      const d = lev(q, w.slice(0, Math.max(q.length, w.length)), q.length >= 7 ? 2 : 1);
      if (d <= (q.length >= 7 ? 2 : 1)) best = Math.max(best, 5);
    }
  }
  return best;
}

let index = null;
export function invalidateSearchIndex() { index = null; }

function buildIndex() {
  const services = all(`
    SELECT s.id, s.title, s.plain_title, s.description, s.classification, s.office_id, o.name AS office_name,
           v.floor_name, o.location_type,
           (SELECT group_concat(keyword, ' | ') FROM service_keywords k WHERE k.service_id = s.id) AS keywords
      FROM services s JOIN offices o ON o.id = s.office_id
      LEFT JOIN v_office_current_location v ON v.office_id = o.id
     WHERE s.status = 'published' AND s.is_citizen_facing = 1 AND o.is_active = 1`);
  const offices = all(`SELECT o.id, o.name, o.short_name, o.location_type, v.floor_name
                         FROM offices o LEFT JOIN v_office_current_location v ON v.office_id = o.id
                        WHERE o.is_active = 1`);
  index = [
    ...services.map(s => ({
      kind: 'service', id: s.id, title: s.plain_title || s.title, official_title: s.title,
      subtitle: [s.office_name, s.location_type === 'offsite' ? 'Not in this building' : s.floor_name].filter(Boolean).join(' · '),
      classification: s.classification,
      titleWords: tokens(`${s.plain_title || ''} ${s.title}`),
      kwWords: tokens(s.keywords),
      kwPhrases: (s.keywords || '').split(' | ').map(normalize).filter(Boolean),
      otherWords: tokens(`${s.office_name} ${s.description || ''}`),
      fullTitle: normalize(`${s.plain_title || ''} ${s.title}`),
    })),
    ...offices.map(o => ({
      kind: 'office', id: o.id, title: o.name,
      subtitle: ['Office', o.location_type === 'offsite' ? 'Not in this building' : o.floor_name].filter(Boolean).join(' · '),
      titleWords: tokens(`${o.name} ${o.short_name || ''}`), kwWords: [], kwPhrases: [normalize(o.short_name)].filter(Boolean),
      otherWords: [], fullTitle: normalize(o.name),
    })),
  ];
}

export function search(q, limit = 25) {
  if (!index) buildIndex();
  const nq = normalize(q);
  const qt = tokens(q);
  if (!nq) return [];
  const results = [];
  for (const item of index) {
    let score = 0;
    if (item.fullTitle.includes(nq)) score += 40;
    if (item.kwPhrases.some(p => p && (p === nq || p.includes(nq) || nq.includes(p)))) score += 45;
    let matched = 0;
    for (const t of qt) {
      const s = Math.max(tokenScore(t, item.titleWords) * 1.5, tokenScore(t, item.kwWords) * 1.6, tokenScore(t, item.otherWords) * 0.5);
      if (s > 0) matched++;
      score += s;
    }
    if (qt.length && matched < Math.ceil(qt.length * 0.6) && score < 40) continue; // most words must match
    if (score < 6) continue; // description-only mentions are too weak to show
    if (item.kind === 'office') score += 2;
    results.push({ ...item, score: Math.round(score) });
  }
  results.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
  return results.slice(0, limit).map(({ titleWords, kwWords, kwPhrases, otherWords, fullTitle, ...r }) => r);
}
