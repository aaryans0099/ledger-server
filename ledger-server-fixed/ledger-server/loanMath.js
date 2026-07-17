/* ==========================================================================
   loanMath.js — flat-rate (fixed, non-reducing) EMI logic.
   Mirrors the calculations in the offline single-file app so numbers match
   exactly if you're migrating data across.
   ========================================================================== */
function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}
function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function flatLoanMath(principal, monthlyRatePct, months) {
  principal = Number(principal) || 0;
  const totalInterest = principal * ((Number(monthlyRatePct) || 0) / 100) * months;
  const totalPayable = principal + totalInterest;
  const emi = months ? totalPayable / months : totalPayable;
  return { totalInterest, totalPayable, emi };
}

function buildSchedule(principal, monthlyRatePct, months, startDate) {
  principal = Number(principal) || 0;
  const { emi } = flatLoanMath(principal, monthlyRatePct, months);
  const principalComp = principal / months;
  const intComp = principal * ((Number(monthlyRatePct) || 0) / 100);
  let balance = principal;
  const rows = [];
  for (let i = 1; i <= months; i++) {
    let princThis = principalComp;
    if (i === months) princThis = balance; // absorb rounding on the last row
    balance = Math.max(0, balance - princThis);
    rows.push({
      no: i,
      dueDate: addMonths(startDate, i),
      emi: Math.round((princThis + intComp) * 100) / 100,
      principal: Math.round(princThis * 100) / 100,
      interest: Math.round(intComp * 100) / 100,
      balance: Math.round(balance * 100) / 100,
      status: 'Pending', paidDate: null, paidAmount: 0,
      paidPrincipal: 0, paidInterest: 0, remarksLog: []
    });
  }
  return rows;
}

function outstandingPrincipal(loan) {
  if (!loan.schedule || !loan.schedule.length) return Math.round((Number(loan.principal) || 0) * 100) / 100;
  const paid = loan.schedule.reduce((s, r) => s + Number(r.paidPrincipal || 0), 0);
  return Math.round(Math.max(0, (Number(loan.principal) || 0) - paid) * 100) / 100;
}
function outstandingInterest(loan) {
  if (!loan.schedule) return 0;
  const total = loan.schedule.reduce((s, r) => s + Math.max(0, Number(r.interest || 0) - Number(r.paidInterest || 0)), 0);
  return Math.round(total * 100) / 100;
}
function loanComputedStatus(loan) {
  if (['Pending', 'Closed', 'Defaulted'].includes(loan.status)) return loan.status;
  if (!loan.schedule || !loan.schedule.length) return loan.status;
  const allPaid = loan.schedule.every(r => r.status === 'Paid');
  if (allPaid) return 'Closed';
  const today = todayDateStr();
  const anyOverdue = loan.schedule.some(r => r.status !== 'Paid' && r.dueDate < today);
  return anyOverdue ? 'Overdue' : 'Active';
}
function pendingPenalty(loan, penaltyRatePerDay) {
  const rate = (penaltyRatePerDay || 0) / 100;
  if (!rate || !loan.schedule) return 0;
  const today = todayDateStr();
  let total = 0;
  loan.schedule.forEach(r => {
    if (r.status === 'Paid') return;
    if (r.dueDate < today) {
      const daysLate = daysBetween(r.dueDate, today);
      const overdueAmt = Math.max(0, Number(r.emi || 0) - Number(r.paidAmount || 0));
      total += overdueAmt * rate * daysLate;
    }
  });
  return Math.round(total * 100) / 100;
}

module.exports = {
  addMonths, daysBetween, todayDateStr, flatLoanMath, buildSchedule,
  outstandingPrincipal, outstandingInterest, loanComputedStatus, pendingPenalty
};
