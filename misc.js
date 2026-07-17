const express = require('express');
const { db, logAudit } = require('../db');
const { requireAuth, requirePerm, agentRecordFor } = require('../auth');

module.exports = function (io) {
  const router = express.Router();
  router.use(requireAuth);

  // ---- Company / loan default settings ----
  router.get('/meta', (req, res) => res.json(db.get('meta').value()));
  router.put('/meta', requirePerm('backup'), (req, res) => {
    db.set('meta', { ...db.get('meta').value(), ...req.body }).write();
    logAudit(req.user.username, 'Settings updated', 'system', '', '');
    io.emit('sync', { entity: 'meta' });
    res.json(db.get('meta').value());
  });

  // ---- Collection logs, portfolio-wide, filterable by date/agent ----
  router.get('/collection-logs', (req, res) => {
    const { from, to, agent } = req.query;
    let entries = [];
    db.get('loans').value().forEach(l => {
      (l.collectionLog || []).forEach(e => entries.push({ ...e, loanId: l.id, agentId: l.agentId }));
    });
    if (req.user.role === 'agent') {
      const myAgent = agentRecordFor(req.user);
      entries = myAgent ? entries.filter(e => e.agentId === myAgent.id) : [];
    } else if (agent) {
      entries = agent === '__unassigned' ? entries.filter(e => !e.agentId) : entries.filter(e => e.agentId === agent);
    }
    if (from) entries = entries.filter(e => (e.date || '') >= from);
    if (to) entries = entries.filter(e => (e.date || '') <= to);
    entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json(entries);
  });

  // ---- Activity / audit log ----
  router.get('/activity', (req, res) => res.json(db.get('auditLog').value().slice(0, 500)));

  // ---- Full data export (admin only) — password hashes stripped ----
  router.get('/export', requirePerm('backup'), (req, res) => {
    const snapshot = JSON.parse(JSON.stringify(db.getState()));
    snapshot.users = (snapshot.users || []).map(({ passwordHash, ...u }) => u);
    logAudit(req.user.username, 'Data exported', 'system', '', '');
    res.setHeader('Content-Disposition', `attachment; filename="ledger-export-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(snapshot);
  });

  return router;
};
