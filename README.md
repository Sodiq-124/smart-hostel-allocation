#  Smart Hostel Allocation System
A full-stack web application for managing student hostel applications, room allocation and hostel fee payment.
**Stack:** HTML5 · CSS3 · Vanilla JavaScript · Node.js · Express.js · MySQL · Paystack
> **Build status:** Phase 7 complete — admin read-only application visibility, added on top of Phases 1-6. Phase numbering beyond this point is being renegotiated per updated requirements; see below.
> The design specification is in [`docs/phase1-design.md`](docs/phase1-design.md).
---
## Requirements
| Software | Minimum version | Check with |
|---|---|---|
| Node.js | 18 (20+ recommended) | `node --version` |
| npm | 9 | `npm --version` |
| MySQL | 8.0 | `mysql --version` |
MySQL 8.0 is required because the schema uses `CHECK` constraints and generated columns. XAMPP 8.2+ and MySQL Community Server both work.
---
## Installation
```bash
# 1. Get the project
git clone <your-repository-url>
cd smart-hostel-system
# 2. Install backend dependencies
cd backend
npm install
```
If `npm install` fails while building **bcrypt** (common on Windows without build tools), install the pure-JavaScript alternative instead:
```bash
npm uninstall bcrypt
npm install bcryptjs
```
Then change `require('bcrypt')` to `require('bcryptjs')` wherever it appears. The API is identical.
---
## Configuration
```bash
# still inside backend/
cp .env.example .env      # macOS / Linux
copy .env.example .env    # Windows
```
Open `.env` and set at least `DB_USER`, `DB_PASSWORD` and `SESSION_SECRET`.
Generate a session secret with:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
**`.env` is in `.gitignore` and must never be committed.** `.env.example` is the committed template that documents which variables exist.
---
## Database setup
From the project root:
```bash
mysql -u root -p < database/hostel.sql
```
On Windows with XAMPP, if `mysql` is not on your PATH:
```cmd
C:\xampp\mysql\bin\mysql.exe -u root -p < database\hostel.sql
```
Or import `database/hostel.sql` through phpMyAdmin.
The script drops and recreates the `smart_hostel` database, so it is safe
to re-run while developing. It finishes by printing the blocks, room
counts and active fees so you can confirm it loaded.
**Expected output:**
| block | gender | rooms | total_spaces |
|---|---|---|---|
| Block A | male | 6 | 6 |
| Block B | male | 6 | 22 |
| Block C | female | 5 | 5 |
| Block D | female | 6 | 23 |
Create the first administrator account:

```bash
cd backend
npm run seed:admin
```

This reads `SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`
from `.env` (prompting for any that are missing), hashes the password
with bcrypt, and inserts the account. Re-running it is safe — it
updates the same account instead of creating a duplicate.
### Clearing test data
To wipe students, applications and payments while keeping your rooms,
fees and admin account (useful before a demonstration):
```bash
mysql -u root -p smart_hostel < database/reset.sql
```
---
## Accounts

| Area | URL | Notes |
|---|---|---|
| Student register | `/register.html` | Creates a `student` role account. Gender is required — see note below. |
| Student login | `/login.html` | |
| Admin login | `/admin/login.html` | Only accounts with `role = admin` can pass. Created via `npm run seed:admin`. |

**Why registration asks for gender:** the hostel operates separate male
and female blocks (`database/hostel.sql`). A student's gender determines
which blocks they can be matched to, and the database enforces this with
a trigger — an application or allocation that crosses genders is
rejected at the database level, not just hidden in the UI.

## Running the application
```bash
cd backend
npm run dev     # development, restarts automatically on file change
# or
npm start       # plain node, no auto-restart
```
Then open **<http://localhost:5000>**.
One server serves both the web pages and the API, so there is only one address to remember and no CORS configuration to manage.
---
## Project layout
```text
smart-hostel-system/
├── backend/          Node.js + Express API
│   ├── config/       database pool, session store
│   ├── routes/       URL to controller mapping
│   ├── controllers/  request handling
│   ├── services/     business logic (allocation, payments)
│   ├── middleware/   auth, validation, error handling
│   ├── validators/   input rules
│   ├── utils/        small shared helpers
│   └── scripts/      one-off tasks such as seeding the admin
├── frontend/         HTML, CSS and vanilla JavaScript
├── database/         hostel.sql schema and seed data
└── docs/             design and testing documentation
```
---
## Verifying the setup
Open <http://localhost:5000>. The setup-check page runs three tests. Until Phase 3 creates the schema, the database check is expected to report "Not connected".
You can also call the health endpoint directly:
```bash
curl http://localhost:5000/api/health
```
---
## Build phases
| Phase | Scope | Status |
|---|---|---|
| 1 | Requirements, architecture, database design | Complete |
| 2 | Project setup, Express server, error handling | Complete |
| 3 | MySQL schema and seed script | Complete |
| 4 | Authentication and roles | Complete |
| 5 | Student frontend | Complete |
| 6 | Application system | Complete |
| 7 | Admin application visibility (redefined scope) | Complete |
| 8 | Approval, rejection, room allocation | |
| 9 | Payment system | |
| 10 | Payment history and receipts | |
| 11 | Reports, charts, CSV export | |
| 12 | Security hardening and validation | |
| 13 | Testing and debugging | |
| 14 | Final documentation | |
