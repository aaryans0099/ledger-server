const express = require('express');
const { db, logAudit } = require('../db');
const { signToken, requireAuth, bcrypt, agentRecordFor } = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.get('users').find({ username }).value();
  if (!user || !user.active || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password, or account disabled' });
  }
  logAudit(user.username, 'Logged in', 'user', user.id, '');
  const token = signToken(user);
  const { passwordHash, ...safeUser } = user;
  res.json({ token, user: safeUser, agent: agentRecordFor(user) || null });
});

router.get('/me', requireAuth, (req, res) => {
  const { passwordHash, ...safeUser } = req.user;
  res.json({ user: safeUser, agent: agentRecordFor(req.user) || null });
});

module.exports = router;
