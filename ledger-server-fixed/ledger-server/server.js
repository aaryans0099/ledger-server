/* ==========================================================================
   server.js — entry point. Wires Express (REST API) + Socket.IO (real-time
   sync) + all route modules together.

   Run:  npm install && npm start
   Env:  copy .env.example to .env and set JWT_SECRET before going live.
   ========================================================================== */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*' }
});

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// ---- Socket.IO: clients join after authenticating so we could scope
// broadcasts per-role/per-agent later; for now every connected client
// gets every 'sync' event and just refetches the affected entity. ----
io.on('connection', (socket) => {
  socket.on('hello', (info) => {
    socket.data.username = info && info.username;
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- Routes ----
app.use('/api/auth', require('./routes/auth'));
app.use('/api/customers', require('./routes/customers')(io));
app.use('/api/loans', require('./routes/loans')(io));
app.use('/api/disbursements', require('./routes/disbursements')());
app.use('/api/branches', require('./routes/branches')(io));
app.use('/api/agents', require('./routes/agents')(io));
app.use('/api/staff', require('./routes/staff')(io));
app.use('/api', require('./routes/misc')(io)); // /api/meta, /api/collection-logs, /api/activity

// Serve the frontend build (if present) so the whole app can be hosted from one process.
const path = require('path');
const fs = require('fs');
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Ledger server running on http://localhost:${PORT}`);
  console.log(`WebSocket (Socket.IO) ready for real-time sync on the same port.`);
});
