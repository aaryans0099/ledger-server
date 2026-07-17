const express = require('express');
const { db, uid, nowISO, logAudit } = require('../db');
const { requireAuth, requirePerm } = require('../auth');

module.exports = function (io) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', (req, res) => res.json(db.get('branches').value()));

  router.post('/', requirePerm('branches'), (req, res) => {
    const b = { id: uid(), ...req.body, createdAt: nowISO() };
    db.get('branches').push(b).write();
    logAudit(req.user.username, 'Branch created', 'branch', b.id, b.name);
    io.emit('sync', { entity: 'branches' });
    res.status(201).json(b);
  });

  router.put('/:id', requirePerm('branches'), (req, res) => {
    const b = db.get('branches').find({ id: req.params.id }).value();
    if (!b) return res.status(404).json({ error: 'Not found' });
    db.get('branches').find({ id: req.params.id }).assign(req.body).write();
    logAudit(req.user.username, 'Branch updated', 'branch', b.id, b.name);
    io.emit('sync', { entity: 'branches' });
    res.json(db.get('branches').find({ id: req.params.id }).value());
  });

  return router;
};
