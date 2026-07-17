# Ledger — Live (server-backed, real-time multi-user)

This is the backend + reference frontend for a real-time, multi-device version of
the offline Ledger CRM & Loan Management app. Where the single-file version stored
everything in one browser's `localStorage`, this version stores data on a server,
so every logged-in device sees the same data instantly.

## What's included

- **Full REST API** — auth, customers, loans (create/correct/disburse/pay/reset/top-up/
  assign-agent/collection-log), disbursements, branches, collection agents, staff,
  settings, portfolio-wide collection logs, audit log. Logic (flat-rate EMI, penalty,
  top-up modes, role permissions) mirrors the offline app so numbers match if you
  migrate data across.
- **Real JWT authentication** — passwords are hashed with bcrypt, never stored or
  sent in plain text after login. Tokens expire after 12 hours.
- **Server-side role enforcement** — an agent's token literally cannot pull another
  agent's loans; this isn't just hidden in the UI like the offline version.
- **Real-time sync** — Socket.IO. Any write (new loan, payment recorded, agent
  reassigned, etc.) broadcasts a `sync` event to every connected client, which
  refetches the affected data. Verified working across independent connections.
- **JSON-file storage (lowdb)** — zero setup, good for a small team. The whole
  database lives in `data/db.json`. If you outgrow this later (many concurrent
  writers, need SQL reporting), swap `db.js` for a Postgres layer — every route
  only talks to the functions `db.js` exports, so nothing else needs to change.
- **A complete frontend** (`public/index.html`) — same screen set as the offline
  app: Dashboard, Customers, Loans (list + detail with EMI schedule/disbursements/
  collection/correction/top-up), Disbursements, Branches, Collections (loans board +
  date-filterable activity log), Collection Agents, Reports (Disbursement/Collection/
  Pendency/P&L, all with CSV download), Staff & Roles, Reminders, Activity Log,
  Settings (default ROI, penalty rate, password change). All screens read from a
  client-side cache that refetches automatically whenever a `sync` event arrives —
  so every connected device updates within moments of any change, anywhere.

## Running it locally

```bash
cd ledger-server
npm install
cp .env.example .env
# edit .env and set a real JWT_SECRET
npm start
```

Open `http://localhost:4000`. Default login: `admin` / `admin123` — change it
immediately (Staff & Roles → Staff, once that screen is ported, or via the API
directly for now: `PUT /api/staff/:id` with a `password` field).

## Deploying it for real

### Option A — Render (has a ready-made blueprint in this repo: `render.yaml`)

1. Push this `ledger-server` folder to a new GitHub repo (Render deploys from GitHub).
   ```bash
   cd ledger-server
   git init && git add . && git commit -m "Ledger server"
   # create a repo on github.com, then:
   git remote add origin https://github.com/<you>/ledger-server.git
   git push -u origin main
   ```
2. On [render.com](https://render.com) → **New** → **Blueprint** → connect that repo.
   Render reads `render.yaml` automatically and sets up the web service, a
   generated `JWT_SECRET`, and a 1GB persistent disk for `data/` — you don't
   need to configure anything by hand.
3. Click **Apply**. First deploy takes a couple of minutes. Render gives you a
   `https://ledger-server-xxxx.onrender.com` URL — that's your live app.
4. **Important:** the `disk:` block in `render.yaml` needs a paid plan (Render's
   free tier has no persistent disks — your data would reset on every restart).
   The Starter plan (~$7/mo) is enough for a small team. If you want to stay
   free while testing, deploy without the disk block first, just know data
   won't survive a redeploy until you add it.
5. Once it's live, open the URL, log in with `admin`/`admin123`, and change
   the password immediately (Settings → Change Password).

### Option B — Railway

1. Push the code to GitHub the same way as above.
2. On [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Railway auto-detects Node and runs `npm install && npm start` — no config needed.
4. Go to your service → **Variables** → add `JWT_SECRET` (use a real random
   value — see below) and `CORS_ORIGIN` (leave as `*` for now).
5. Go to **Volumes** → attach a volume mounted at `/app/data` so `db.json`
   persists across deploys.
6. Railway gives you a public URL under **Settings → Networking → Generate Domain**.

### Generating your own JWT_SECRET

If you don't use Render's auto-generated one, make your own instead of using
the placeholder in `.env.example`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
A ready-to-use one has been generated for you (only use this if you haven't
shared it anywhere — treat it like a password):
```
d4025ef355453becc687b856b6319d990cd8fca4d690e09cd27464d81e02cc0857f0b0b9054232ba6912d8f5f6471e90
```

### After it's live

- [ ] Log in and change the default admin password immediately
- [ ] Create real staff/agent logins (Staff & Roles), then disable or repurpose
      the default `admin` account if you want a personal one instead
- [ ] Set your real company name and default ROI/penalty rate (Settings)
- [ ] Narrow `CORS_ORIGIN` from `*` to your actual frontend URL once you know it
- [ ] Bookmark the URL on every phone/laptop that needs access — no install needed,
      it's just a website now
- [ ] Set a calendar reminder to pull a backup via `GET /api/export` periodically
      until that's wired to a button in Settings

## API shape (for continuing the frontend port)

All endpoints are under `/api`, require `Authorization: Bearer <token>` (except
`/api/auth/login`), and return JSON.

```
POST   /api/auth/login              { username, password } → { token, user, agent }
GET    /api/auth/me                 → { user, agent }

GET    /api/customers
POST   /api/customers
PUT    /api/customers/:id

GET    /api/loans                   (auto-scoped to the caller's own loans if role=agent)
GET    /api/loans/:id
POST   /api/loans
PUT    /api/loans/:id                (correction)
POST   /api/loans/:id/disburse
POST   /api/loans/:id/payments
POST   /api/loans/:id/schedule/:no/reset
POST   /api/loans/:id/topup
POST   /api/loans/:id/assign-agent
POST   /api/loans/:id/collection-log
DELETE /api/loans/:id

GET    /api/disbursements

GET    /api/branches
POST   /api/branches
PUT    /api/branches/:id

GET    /api/agents
POST   /api/agents
PUT    /api/agents/:id

GET    /api/staff                   (admin/manager only)
POST   /api/staff
PUT    /api/staff/:id
POST   /api/staff/:id/toggle

GET    /api/meta
PUT    /api/meta                    (company name, default ROI, penalty rate)
GET    /api/collection-logs         ?from=&to=&agent=
GET    /api/activity
GET    /api/health
```

Real-time: connect Socket.IO to the same origin, emit `hello` with
`{username}` after connecting, then listen for `sync` events —
`{entity: 'loans'|'customers'|'branches'|'agents'|'staff'|'meta'|'disbursements'}` —
and refetch that entity's list.

## What's left

Everything from the offline app has a working screen here now, backed by real
API calls and live sync. A few things intentionally weren't carried over 1:1:

- **Loan Agreement PDF/print view** — the offline app generated a printable
  loan agreement template; not yet ported (straightforward to add if wanted).
- **Backup/Restore as a screen** — since data now lives on the server, the
  offline app's local export/import UI doesn't apply the same way. There's an
  admin-only `GET /api/export` endpoint (full JSON snapshot, password hashes
  stripped) that Settings can call — wire a "Download full backup" button to
  it if you want a one-click safety copy independent of the database itself.
- **EMI calculator** as a standalone preview tool (separate from actually
  creating a loan) — the loan creation form still computes EMI live as you type.

Let me know if you want any of these finished off, or if something in daily use
turns up a gap.
