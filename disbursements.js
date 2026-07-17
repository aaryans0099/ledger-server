const express = require('express');
const { db } = require('../db');
const { requireAuth, agentRecordFor } = require('../auth');

module.exports = function () {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', (req, res) => {
    let rows = db.get('disbursements').value();
    if (req.user.role === 'agent') {
      const myAgent = agentRecordFor(req.user);
      const myLoanIds = new Set(db.get('loans').filter(l => myAgent && l.agentId === myAgent.id).map('id').value());
      rows = rows.filter(d => myLoanIds.has(d.loanId));
    }
    res.json(rows);
  });

  return router;
};
