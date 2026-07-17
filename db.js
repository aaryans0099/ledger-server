/* ==========================================================================
   db.js — JSON-file database (lowdb).
   Good fit for a small lending team (a handful of staff/agents). If you
   outgrow this (many concurrent writers, need reporting SQL, etc.) swap
   this module for a Postgres/Prisma layer — every route only talks to the
   functions exported here, so the rest of the app doesn't need to change.
   ========================================================================== */
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const DATA_DIR = path.join(__dirname, 'data');
const adapter = new FileSync(path.join(DATA_DIR, 'db.json'));
const db = low(adapter);

db.defaults({
  meta: { companyName: 'My Loan Office', defaultROI: 4, penaltyRatePerDay: 0 },
  users: [],
  customers: [],
  branches: [],
  loans: [],
  disbursements: [],
  collectionAgents: [],
  collectionLogs: [],
  auditLog: []
}).write();

// Seed a default admin on first run only.
if (db.get('users').size().value() === 0) {
  db.get('users').push({
    id: uuid(),
    username: 'admin',
    name: 'Administrator',
    role: 'admin',
    passwordHash: bcrypt.hashSync('admin123', 10),
    active: true,
    createdAt: new Date().toISOString()
  }).write();
  console.log('Seeded default admin login: admin / admin123 — change this immediately after first login.');
}

function uid() { return uuid(); }
function nowISO() { return new Date().toISOString(); }

function logAudit(user, action, entityType, entityId, details) {
  db.get('auditLog').unshift({
    id: uid(), ts: nowISO(), user: user || 'system', action, entityType, entityId, details: details || ''
  }).write();
}

module.exports = { db, uid, nowISO, logAudit };
