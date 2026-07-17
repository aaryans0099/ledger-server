const express = require('express');
const { db, uid, nowISO, logAudit } = require('../db');
const { requireAuth, requirePerm } = require('../auth');

module.exports = function (io) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', (req, res) => res.json(db.get('collectionAgents').value()));

  router.post('/', requirePerm('collections'), (req, res) => {
    const a = { id: uid(), ...req.body, createdAt: nowISO() };
    db.get('collectionAgents').push(a).write();
    logAudit(req.user.username, 'Collection agent created', 'agent', a.id, a.name);
    io.emit('sync', { entity: 'agents' });
    res.status(201).json(a);
  });

  router.put('/:id', requirePerm('collections'), (req, res) => {
    const a = db.get('collectionAgents').find({ id: req.params.id }).value();
    if (!a) return res.status(404).json({ error: 'Not found' });
    db.get('collectionAgents').find({ id: req.params.id }).assign(req.body).write();
    logAudit(req.user.username, 'Collection agent updated', 'agent', a.id, a.name);
    io.emit('sync', { entity: 'agents' });
    res.json(db.get('collectionAgents').find({ id: req.params.id }).value());
  });

  return router;
};
