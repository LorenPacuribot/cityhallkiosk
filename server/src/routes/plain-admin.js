// Admin API for plain-language summaries: one short line per office ("Helps with ...") and per service
// ("For people who ..."), shown on the kiosk's service browse. They sit ON TOP of the Citizen's Charter text,
// which is never changed. A line reaches the public only after an LGU admin approves it; an edit to an approved
// line becomes a new draft while the approved wording stays visible. Mounted under /api/admin; every write is audited.
import express from 'express';
import fs from 'node:fs';
import { all, get, run, tx, bumpContentVersion } from '../db.js';
import { requireRole, canEditOffice, audit } from '../auth.js';

export const plainAdminApi = express.Router();
const DRAFTS = new URL('../../data/plain-summaries-draft.json', import.meta.url);
const TYPES = new Set(['office', 'service']), LANGS = new Set(['en', 'fil', 'ceb']);
const MAX_LEN = 200;

const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
const rowOf = (type, id, lang) => get('SELECT * FROM plain_summaries WHERE entity_type = ? AND entity_id = ? AND lang = ?', [type, id, lang]);
const officeOf = (type, id) => type === 'office' ? id : get('SELECT office_id FROM services WHERE id = ?', [id])?.office_id;
function target(req, res) {
  const { type, lang } = req.params, id = Number(req.params.id);
  if (!TYPES.has(type) || !LANGS.has(lang) || !Number.isInteger(id)) { bad(res, 'Unknown summary.'); return null; }
  const exists = type === 'office' ? get('SELECT id FROM offices WHERE id = ?', [id]) : get('SELECT id FROM services WHERE id = ?', [id]);
  if (!exists) { bad(res, `No such ${type}.`, 404); return null; }
  return { type, id, lang };
}

/** Every office and published service with its summary in one language (status 'none' when nothing exists yet). */
plainAdminApi.get('/plain-summaries', requireRole('viewer'), (req, res) => {
  const lang = LANGS.has(req.query.lang) ? req.query.lang : 'en';
  const offices = all(`SELECT 'office' AS entity_type, o.id AS entity_id, o.name, o.short_name AS office_short, o.id AS office_id, NULL AS context,
                              p.text, p.status, p.approved_text, p.source, p.updated_at, p.reviewed_at
                         FROM offices o LEFT JOIN plain_summaries p ON p.entity_type = 'office' AND p.entity_id = o.id AND p.lang = ?
                        WHERE o.is_active = 1 ORDER BY o.name`, [lang]);
  const services = all(`SELECT 'service' AS entity_type, s.id AS entity_id, s.title AS name, o.short_name AS office_short, s.office_id,
                               s.who_may_avail AS context, s.is_citizen_facing, s.source AS charter_source,
                               p.text, p.status, p.approved_text, p.source, p.updated_at, p.reviewed_at
                          FROM services s JOIN offices o ON o.id = s.office_id
                          LEFT JOIN plain_summaries p ON p.entity_type = 'service' AND p.entity_id = s.id AND p.lang = ?
                         WHERE s.status = 'published' ORDER BY o.name, s.title`, [lang]);
  const items = [...offices, ...services].map(r => ({ ...r, status: r.status || 'none' }));
  const counts = items.reduce((c, r) => (c[r.status] = (c[r.status] || 0) + 1, c), {});
  res.json({ lang, counts, items });
});

/** Propose or edit a line. Office editors may edit their own office's lines; it becomes a draft. */
plainAdminApi.put('/plain-summaries/:type/:id/:lang', requireRole('office_editor'), (req, res) => {
  const t = target(req, res); if (!t) return;
  if (!canEditOffice(req.user, officeOf(t.type, t.id))) return bad(res, 'You can only edit summaries for your own office.', 403);
  const text = String(req.body?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return bad(res, 'Write the summary first.');
  if (text.length > MAX_LEN) return bad(res, `Keep it under ${MAX_LEN} characters: one line a visitor can read at a glance.`);
  const before = rowOf(t.type, t.id, t.lang);
  if (before) run(`UPDATE plain_summaries SET text = ?, status = 'draft', source = 'staff', updated_by = ?, updated_at = datetime('now'), reviewed_by = NULL, reviewed_at = NULL WHERE id = ?`, [text, req.user.id, before.id]);
  else run(`INSERT INTO plain_summaries(entity_type, entity_id, lang, text, status, source, updated_by) VALUES (?,?,?,?,'draft','staff',?)`, [t.type, t.id, t.lang, text, req.user.id]);
  audit(req.user, 'propose', 'plain_summary', t.id, before, { ...t, text });
  res.json(rowOf(t.type, t.id, t.lang));
});

/** Approve the current draft (optionally with a final wording). Only then does the kiosk show it. */
plainAdminApi.post('/plain-summaries/:type/:id/:lang/approve', requireRole('lgu_admin'), (req, res) => {
  const t = target(req, res); if (!t) return;
  const before = rowOf(t.type, t.id, t.lang);
  const text = req.body?.text != null ? String(req.body.text).replace(/\s+/g, ' ').trim() : before?.text;
  if (!text) return bad(res, 'There is nothing to approve yet.');
  if (text.length > MAX_LEN) return bad(res, `Keep it under ${MAX_LEN} characters.`);
  tx(() => {
    if (before) run(`UPDATE plain_summaries SET text = ?, approved_text = ?, status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`, [text, text, req.user.id, before.id]);
    else run(`INSERT INTO plain_summaries(entity_type, entity_id, lang, text, approved_text, status, source, updated_by, reviewed_by, reviewed_at)
              VALUES (?,?,?,?,?,'approved','staff',?,?,datetime('now'))`, [t.type, t.id, t.lang, text, text, req.user.id, req.user.id]);
    audit(req.user, 'approve', 'plain_summary', t.id, before, { ...t, text });
  });
  bumpContentVersion();
  res.json(rowOf(t.type, t.id, t.lang));
});

/** Reject the waiting draft; a previously approved wording stays visible. */
plainAdminApi.post('/plain-summaries/:type/:id/:lang/reject', requireRole('lgu_admin'), (req, res) => {
  const t = target(req, res); if (!t) return;
  const before = rowOf(t.type, t.id, t.lang);
  if (!before || before.status !== 'draft') return bad(res, 'There is no waiting draft to reject.');
  run(`UPDATE plain_summaries SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`, [req.user.id, before.id]);
  audit(req.user, 'reject', 'plain_summary', t.id, before, { ...t, reason: req.body?.reason || null });
  res.json(rowOf(t.type, t.id, t.lang));
});

/**
 * Loads the prepared English drafts (data/plain-summaries-draft.json) as drafts for every office/service that has
 * no English line yet. Never overwrites staff wording or an approved line, and approves nothing.
 */
export function importPlainDrafts(user = null) {
  const d = JSON.parse(fs.readFileSync(DRAFTS, 'utf8'));
  const result = { added: 0, kept: 0, unknown: [] };
  tx(() => {
    const add = (type, id, text) => {
      if (rowOf(type, id, 'en')) { result.kept++; return; }
      run(`INSERT INTO plain_summaries(entity_type, entity_id, lang, text, status, source, updated_by) VALUES (?,?,'en',?,'draft','drafted',?)`, [type, id, text, user?.id ?? null]);
      result.added++;
    };
    for (const [short, text] of Object.entries(d.offices || {})) {
      const o = get('SELECT id FROM offices WHERE short_name = ?', [short]);
      o ? add('office', o.id, text) : result.unknown.push(`office ${short}`);
    }
    for (const [source, text] of Object.entries(d.services || {})) {
      const s = get('SELECT id FROM services WHERE source = ?', [source]);
      s ? add('service', s.id, text) : result.unknown.push(`service ${source}`);
    }
    audit(user, 'import_drafts', 'plain_summary', null, null, result);
  });
  return result;
}
plainAdminApi.post('/plain-summaries/import-drafts', requireRole('lgu_admin'), (req, res) => res.json(importPlainDrafts(req.user)));
