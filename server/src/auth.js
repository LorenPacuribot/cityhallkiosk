import crypto from 'node:crypto';
import { get, run } from './db.js';

const SESSION_HOURS = 10;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
  run('INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)', [token, userId, expires]);
  return { token, expires };
}

export function destroySession(token) {
  run('DELETE FROM sessions WHERE token = ?', [token]);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function currentUser(req) {
  const token = readCookie(req, 'sid') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
  if (!token) return null;
  const row = get(
    `SELECT u.id, u.name, u.email, u.role, u.office_id, s.token, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND u.is_active = 1`, [token]);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) { destroySession(token); return null; }
  return row;
}

// requireRole('lgu_admin') allows lgu_admin and system_admin, etc.
const RANK = { viewer: 1, office_editor: 2, lgu_admin: 3, system_admin: 4 };
export function requireRole(minRole = 'viewer') {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if ((RANK[user.role] || 0) < RANK[minRole]) return res.status(403).json({ error: 'You do not have permission to do this.' });
    req.user = user;
    next();
  };
}

// Office editors may only touch their own office's content.
export function canEditOffice(user, officeId) {
  if (!user) return false;
  if (user.role === 'system_admin' || user.role === 'lgu_admin') return true;
  return user.role === 'office_editor' && Number(user.office_id) === Number(officeId);
}

export function audit(user, action, entity, entityId, before, after) {
  run('INSERT INTO audit_log(user_id, action, entity, entity_id, before_json, after_json) VALUES (?,?,?,?,?,?)',
    [user?.id ?? null, action, entity, entityId ?? null,
     before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}
