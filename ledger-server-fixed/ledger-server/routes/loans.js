const express = require('express');
const { db, uid, nowISO, logAudit } = require('../db');
const { requireAuth, requirePerm, agentRecordFor } = require('../auth');
const {
  flatLoanMath, buildSchedule, outstandingPrincipal, outstandingInterest,
  loanComputedStatus, pendingPenalty, todayDateStr
} = require('../loanMath');

module.exports = function (io) {
  const router = express.Router();
  router.use(requireAuth);

  // Agent-scoping guard: if the caller is an 'agent', only their assigned loans are visible.
  function scopeLoans(req, loans) {
    if (req.user.role !== 'agent') return loans;
    const myAgent = agentRecordFor(req.user);
    if (!myAgent) return [];
    return loans.filter(l => l.agentId === myAgent.id);
  }
  function assertLoanAccess(req, res, loan) {
    if (!loan) { res.status(404).json({ error: 'Loan not found' }); return false; }
    if (req.user.role === 'agent') {
      const myAgent = agentRecordFor(req.user);
      if (!myAgent || loan.agentId !== myAgent.id) { res.status(403).json({ error: "This loan isn't assigned to you" }); return false; }
    }
    return true;
  }
  function enrich(l) {
    const penaltyRate = db.get('meta.penaltyRatePerDay').value();
    return {
      ...l,
      computedStatus: loanComputedStatus(l),
      remainingPrincipal: outstandingPrincipal(l),
      remainingInterest: outstandingInterest(l),
      pendingPenalty: pendingPenalty(l, penaltyRate)
    };
  }

  router.get('/', (req, res) => {
    res.json(scopeLoans(req, db.get('loans').value()).map(enrich));
  });

  router.get('/:id', (req, res) => {
    const loan = db.get('loans').find({ id: req.params.id }).value();
    if (!assertLoanAccess(req, res, loan)) return;
    res.json(enrich(loan));
  });

  router.post('/', requirePerm('create'), (req, res) => {
    const { customerId, principal, interestRate, tenureMonths, processingFee, sanctionDate, purpose } = req.body;
    const p = parseFloat(principal), rate = parseFloat(interestRate), months = parseInt(tenureMonths, 10);
    const emi = Math.round(flatLoanMath(p, rate, months).emi * 100) / 100;
    const loan = {
      id: uid(), customerId, principal: p, interestRate: rate, tenureMonths: months,
      processingFee: parseFloat(processingFee || 0), sanctionDate, purpose: purpose || '',
      emi, status: 'Pending', schedule: [], agentId: null, collectionLog: [],
      createdAt: nowISO(), createdBy: req.user.username
    };
    db.get('loans').push(loan).write();
    logAudit(req.user.username, 'Loan created', 'loan', loan.id, `${p} @ ${rate}%/mo for ${months}m`);
    io.emit('sync', { entity: 'loans' });
    res.status(201).json(enrich(loan));
  });

  // Correction: manual adjustment of principal / ROI / tenure / dates / status
  router.put('/:id', requirePerm('correct'), (req, res) => {
    const loan = db.get('loans').find({ id: req.params.id }).value();
    if (!loan) return res.status(404).json({ error: 'Not found' });
    const before = { principal: loan.principal, interestRate: loan.interestRate, tenureMonths: loan.tenureMonths, sanctionDate: loan.sanctionDate };
    const b = req.body;
    const newPrincipal = parseFloat(b.principal), newRate = parseFloat(b.interestRate), newMonths = parseInt(b.tenureMonths, 10);
    const coreChanged = newPrincipal !== before.principal || newRate !== before.interestRate || newMonths !== before.tenureMonths || b.sanctionDate !== before.sanctionDate;

    const patch = {
      principal: newPrincipal, interestRate: newRate, tenureMonths: newMonths,
      sanctionDate: b.sanctionDate, status: b.status, processingFee: parseFloat(b.processingFee || 0),
      purpose: b.purpose || ''
    };
    patch.emi = Math.round(flatLoanMath(patch.principal, patch.interestRate, patch.tenureMonths).emi * 100) / 100;
    if (coreChanged && loan.schedule && loan.schedule.length) {
      const startDate = loan.disbursementDate || patch.sanctionDate;
      patch.schedule = buildSchedule(patch.principal, patch.interestRate, patch.tenureMonths, startDate);
    }
    db.get('loans').find({ id: req.params.id }).assign(patch).write();
    logAudit(req.user.username, 'Loan corrected', 'loan', loan.id, `Reason: ${b.reason || ''}${coreChanged ? ' — schedule regenerated' : ''}`);
    io.emit('sync', { entity: 'loans' });
    res.json(enrich(db.get('loans').find({ id: req.params.id }).value()));
  });

  // Record a disbursement against a loan (activates Pending loans)
  router.post('/:id/disburse', requirePerm('disburse'), (req, res) => {
    const loan = db.get('loans').find({ id: req.params.id }).value();
    if (!loan) return res.status(404).json({ error: 'Not found' });
    const { amount, date, mode, refNo, remarks } = req.body;
    const d = { id: uid(), loanId: loan.id, amount: parseFloat(amount), date, mode, refNo: refNo || '', remarks: remarks || '', disbursedBy: req.user.username, createdAt: nowISO() };
    db.get('disbursements').push(d).write();
    if (loan.status === 'Pending') {
      const schedule = buildSchedule(loan.principal, loan.interestRate, loan.tenureMonths, date);
      db.get('loans').find({ id: loan.id }).assign({ schedule, status: 'Active', disbursementDate: date }).write();
    }
    logAudit(req.user.username, 'Disbursement recorded', 'loan', loan.id, `${d.amount} via ${d.mode}`);
    io.emit('sync', { entity: 'loans' });
    io.emit('sync', { entity: 'disbursements' });
    res.status(201).json({ disbursement: d, loan: enrich(db.get('loans').find({ id: loan.id }).value()) });
  });

  // Record a repayment against a specific instalment — component (principal/interest/both) + scheduled-or-manual amount
  router.post('/:id/payments', requirePerm('view'), (req, res) => {
    const loan = db.get('loans').find({ id: req.params.id }).value();
    if (!assertLoanAccess(req, res, loan)) return;
    const { instNo, component, amountMode, manualAmount, date, remarks } = req.body;
    const row = (loan.schedule || []).find(r => String(r.no) === String(instNo));
    if (!row) return res.status(404).json({ error: 'Instalment not found' });

    const remainingPrincipal = Math.max(0, Math.round((row.principal - (row.paidPrincipal || 0)) * 100) / 100);
    const remainingInterest = Math.max(0, Math.round((row.interest - (row.paidInterest || 0)) * 100) / 100);

    let addPrincipal = 0, addInterest = 0;
    if (amountMode === 'scheduled') {
      if (component === 'both') { addPrincipal = remainingPrincipal; addInterest = remainingInterest; }
      else if (component === 'principal') addPrincipal = remainingPrincipal;
      else if (component === 'interest') addInterest = remainingInterest;
    } else {
      const manual = Math.max(0, parseFloat(manualAmount) || 0);
      if (component === 'principal') addPrincipal = manual;
      else if (component === 'interest') addInterest = manual;
      else { addInterest = Math.min(manual, remainingInterest); addPrincipal = Math.max(0, manual - addInterest); }
    }

    row.paidPrincipal = Math.round(((row.paidPrincipal || 0) + addPrincipal) * 100) / 100;
    row.paidInterest = Math.round(((row.paidInterest || 0) + addInterest) * 100) / 100;
    row.paidAmount = Math.round((row.paidPrincipal + row.paidInterest) * 100) / 100;
    row.paidDate = date || todayDateStr();
    row.status = (row.paidPrincipal >= row.principal - 0.01 && row.paidInterest >= row.interest - 0.01) ? 'Paid' : (row.paidAmount > 0 ? 'Partial' : 'Pending');
    if (!row.remarksLog) row.remarksLog = [];
    row.remarksLog.push({ date: row.paidDate, amount: Math.round((addPrincipal + addInterest) * 100) / 100, component, note: remarks || '', by: req.user.username, createdAt: nowISO() });

    db.get('loans').find({ id: loan.id }).assign({ schedule: loan.schedule }).write();
    logAudit(req.user.username, 'Repayment recorded', 'loan', loan.id, `Inst #${row.no}: ${component} ${addPrincipal + addInterest}`);
    io.emit('sync', { entity: 'loans' });
    res.json(enrich(db.get('loans').find({ id: loan.id }).value()));
  });

  // Reset an instalment back to Pending (undo all payments on it)
  router.post('/:id/schedule/:no/reset', requirePerm('correct'), (req, res) => {
    const loan = db.get('loans').find({ id: req.params.id }).value();
    if (!loan) return res.status(404).json({ error: 'Not found' });
    const row = (loan.schedule || []).find(r => String(r.no) === String(req.params.no));
    if (!row) return res.status(404).json({ error: 'Instalment not found' });
    Object.assign(row, { status: 'Pending', paidDate: null, paidAmount: 0, paidPrincipal: 0, paidInterest: 0, remarksLog: [] });
    db.get('loans').find({ id: loan.id }).assign({ schedule: loan.schedule }).write();
    logAudit(req.user.username, 'Instalment reset', 'loan', loan.id, `Inst #${row.no}`);
    io.emit('sync', { entity: 'loans' });
    res.json(enrich(db.get('loans').find({ id: loan.id }).value()));
  });

  // Top-up: either close+consolidate into a new loan, or extend the same account
  router.post('/:id/topup', requirePerm('correct'), (req, res) => {
    const loan = db.get('loans').find({ id: req.params.id }).value();
    if (!loan) return res.status(404).json({ error: 'Not found' });
    const { topupAmount, tenureMonths, interestRate, mode, date, remarks } = req.body;
    const outstanding = outstandingPrincipal(loan);
    const newPrincipal = Math.round((outstanding + parseFloat(topupAmount)) * 100) / 100;
    const months = parseInt(tenureMonths, 10);
    const rate = parseFloat(interestRate);
    const today = date || todayDateStr();

    if (mode === 'consolidate') {
      db.get('loans').find({ id: loan.id }).assign({ status: 'Closed' }).write();
      const newLoan = {
        id: uid(), customerId: loan.customerId, principal: newPrincipal, interestRate: rate, tenureMonths: months,
        processingFee: 0, sanctionDate: today, purpose: `Top-up consolidation of loan #${loan.id.slice(-6).toUpperCase()}`,
        emi: Math.round(flatLoanMath(newPrincipal, rate, months).emi * 100) / 100,
        status: 'Active', schedule: buildSchedule(newPrincipal, rate, months, today),
        disbursementDate: today, agentId: loan.agentId || null, collectionLog: [],
        createdAt: nowISO(), createdBy: req.user.username
      };
      db.get('loans').push(newLoan).write();
      const d = { id: uid(), loanId: newLoan.id, amount: parseFloat(topupAmount), date: today, mode: 'Top-up', refNo: '', remarks: remarks || `Top-up, consolidated old loan #${loan.id.slice(-6).toUpperCase()}`, disbursedBy: req.user.username, createdAt: nowISO() };
      db.get('disbursements').push(d).write();
      logAudit(req.user.username, 'Loan topped up (consolidated)', 'loan', newLoan.id, `From loan #${loan.id.slice(-6).toUpperCase()}, +${topupAmount}`);
      io.emit('sync', { entity: 'loans' }); io.emit('sync', { entity: 'disbursements' });
      return res.status(201).json({ closedLoanId: loan.id, newLoan: enrich(newLoan) });
    } else {
      const schedule = buildSchedule(newPrincipal, rate, months, today);
      db.get('loans').find({ id: loan.id }).assign({ principal: newPrincipal, interestRate: rate, tenureMonths: months, schedule, status: 'Active', emi: Math.round(flatLoanMath(newPrincipal, rate, months).emi * 100) / 100 }).write();
      const d = { id: uid(), loanId: loan.id, amount: parseFloat(topupAmount), date: today, mode: 'Top-up', refNo: '', remarks: remarks || 'Top-up on existing loan', disbursedBy: req.user.username, createdAt: nowISO() };
      db.get('disbursements').push(d).write();
      logAudit(req.user.username, 'Loan topped up (same account)', 'loan', loan.id, `+${topupAmount}, new principal ${newPrincipal}`);
      io.emit('sync', { entity: 'loans' }); io.emit('sync', { entity: 'disbursements' });
      return res.json({ loan: enrich(db.get('loans').find({ id: loan.id }).value()) });
    }
  });

  // Assign / reassign collection agent (never exposed to agent role in the frontend, but also blocked here)
  router.post('/:id/assign-agent', requirePerm('view'), (req, res) => {
    if (req.user.role === 'agent') return res.status(403).json({ error: 'Agents cannot reassign loans' });
    const loan = db.get('loans').find({ id: req.params.id }).value();
    if (!loan) return res.status(404).json({ error: 'Not found' });
    const { agentId } = req.body;
    db.get('loans').find({ id: loan.id }).assign({ agentId: agentId || null }).write();
    const agent = agentId ? db.get('collectionAgents').find({ id: agentId }).value() : null;
    logAudit(req.user.username, 'Collection agent assigned', 'loan', loan.id, agent ? agent.name : 'Unassigned');
    io.emit('sync', { entity: 'loans' });
    res.json(enrich(db.get('loans').find({ id: loan.id }).value()));
  });

  // Log a collection activity, tied to the loan and (optionally) a specific instalment
  router.post('/:id/collection-log', requirePerm('view'), (req, res) => {
    const loan = db.get('loans').find({ id: req.params.id }).value();
    if (!assertLoanAccess(req, res, loan)) return;
    const { date, outcome, note, instNo } = req.body;
    const entry = { id: uid(), date: date || todayDateStr(), outcome, note: note || '', instNo: instNo || null, agentId: loan.agentId || null, by: req.user.username, createdAt: nowISO() };
    const log = loan.collectionLog || [];
    log.push(entry);
    db.get('loans').find({ id: loan.id }).assign({ collectionLog: log }).write();
    logAudit(req.user.username, 'Collection activity logged', 'loan', loan.id, `${instNo ? 'Inst #' + instNo + ': ' : ''}${outcome}`);
    io.emit('sync', { entity: 'loans' });
    res.status(201).json(entry);
  });

  router.delete('/:id', requirePerm('delete'), (req, res) => {
    const loan = db.get('loans').find({ id: req.params.id }).value();
    if (!loan) return res.status(404).json({ error: 'Not found' });
    db.get('loans').remove({ id: req.params.id }).write();
    db.get('disbursements').remove({ loanId: req.params.id }).write();
    logAudit(req.user.username, 'Loan deleted', 'loan', req.params.id, '');
    io.emit('sync', { entity: 'loans' });
    res.status(204).end();
  });

  return router;
};
