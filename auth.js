/* ==========================================================================
   auth.js — JWT auth + role/permission enforcement.
   IMPORTANT: unlike the offline single-file version, permission checks here
   run on the SERVER, not just hidden in the UI. An agent's JWT literally
   cannot pull another agent's loans, regardless of what the frontend sends.
   ========================================================================== */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_dev_only_secret';
const JWT_EXPIRES_IN = '12h';

const ROLE_PERMS = {
  admin:   ['view', 'create', 'correct', 'disburse', 'delete', 'staff', 'backup', 'branches', 'collections'],
  manager: ['view', 'create', 'correct', 'disburse', 'backup', 'branches', 'collections'],
  staff:   ['view', 'create', 'disburse'],
  agent:   ['view']
};

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Express middleware: requires a valid bearer token, attaches req.user
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = verifyToken(token);
    const user = db.get('users').find({ id: payload.sub }).value();
    if (!user || !user.active) return res.status(401).json({ error: 'Invalid session' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Express middleware factory: requires one of the listed permissions
function requirePerm(...perms) {
  return (req, res, next) => {
    const role = req.user && req.user.role;
    const allowed = ROLE_PERMS[role] || [];
    if (!perms.some(p => allowed.includes(p))) {
      return res.status(403).json({ error: 'Not permitted for your role' });
    }
    next();
  };
}

// If the caller is an 'agent', find their linked collectionAgents record.
// Returns null if agent role but no linked record (frontend should show a friendly message).
function agentRecordFor(user) {
  if (!user || user.role !== 'agent') return undefined; // undefined = "not an agent, no scoping needed"
  return db.get('collectionAgents').find({ username: user.username }).value() || null;
}

module.exports = { signToken, verifyToken, requireAuth, requirePerm, agentRecordFor, ROLE_PERMS, bcrypt };
