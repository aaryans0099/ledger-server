const express = require('express');
const { db, uid, nowISO, logAudit } = require('../db');
const { requireAuth, requirePerm } = require('../auth');

module.exports = function (io) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', (req, res) => {
    res.json(db.get('customers').value());
  });

  router.post('/', requirePerm('create'), (req, res) => {
    const c = { id: uid(), ...req.body, createdAt: nowISO(), createdBy: req.user.username };
    db.get('customers').push(c).write();
    logAudit(req.user.username, 'Customer created', 'customer', c.id, c.name);
    io.emit('sync', { entity: 'customers' });
    res.status(201).json(c);
  });

  router.put('/:id', requirePerm('create'), (req, res) => {
    const c = db.get('customers').find({ id: req.params.id }).value();
    if (!c) return res.status(404).json({ error: 'Not found' });
    db.get('customers').find({ id: req.params.id }).assign(req.body).write();
    logAudit(req.user.username, 'Customer updated', 'customer', c.id, c.name);
    io.emit('sync', { entity: 'customers' });
    res.json(db.get('customers').find({ id: req.params.id }).value());
  });

  return router;
};
