const express = require('express');
const { db, uid, nowISO, logAudit } = require('../db');
const { requireAuth, requirePerm, bcrypt } = require('../auth');

module.exports = function (io) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', requirePerm('staff'), (req, res) => {
    res.json(db.get('users').value().map(({ passwordHash, ...u }) => u));
  });

  router.post('/', requirePerm('staff'), (req, res) => {
    const { username, name, role, password } = req.body;
    if (db.get('users').find({ username }).value()) return res.status(409).json({ error: 'Username already exists' });
    const u = { id: uid(), username, name, role, passwordHash: bcrypt.hashSync(password, 10), active: true, createdAt: nowISO() };
    db.get('users').push(u).write();
    logAudit(req.user.username, 'Staff created', 'user', u.id, u.username);
    io.emit('sync', { entity: 'staff' });
    const { passwordHash, ...safe } = u;
    res.status(201).json(safe);
  });

  router.put('/:id', requirePerm('staff'), (req, res) => {
    const u = db.get('users').find({ id: req.params.id }).value();
    if (!u) return res.status(404).json({ error: 'Not found' });
    const patch = { name: req.body.name, role: req.body.role };
    if (req.body.password) patch.passwordHash = bcrypt.hashSync(req.body.password, 10);
    db.get('users').find({ id: req.params.id }).assign(patch).write();
    logAudit(req.user.username, 'Staff updated', 'user', u.id, u.username);
    io.emit('sync', { entity: 'staff' });
    const { passwordHash, ...safe } = db.get('users').find({ id: req.params.id }).value();
    res.json(safe);
  });

  router.post('/:id/toggle', requirePerm('staff'), (req, res) => {
    const u = db.get('users').find({ id: req.params.id }).value();
    if (!u) return res.status(404).json({ error: 'Not found' });
    if (u.username === req.user.username) return res.status(400).json({ error: "Can't disable your own account" });
    db.get('users').find({ id: req.params.id }).assign({ active: !u.active }).write();
    logAudit(req.user.username, u.active ? 'Staff disabled' : 'Staff enabled', 'user', u.id, u.username);
    io.emit('sync', { entity: 'staff' });
    res.json({ active: !u.active });
  });

  return router;
};
