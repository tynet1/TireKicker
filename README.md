# TireKicker

Vehicle inspections without the clipboard. TireKicker is a phone-first web app that replaces paper truck
inspection sheets. Crews sign in with a PIN, work through the checklist on their phone, drop numbered damage pins on
a truck diagram, add photos and sign with a finger. Supervisors sign off and export a PDF laid out like a paper
inspection sheet. The shop keeps a maintenance log, open repairs are tracked across the fleet, repair tickets go out
as PDFs, supervisors walk the yard on a fire-safety checklist, the shop checks the equipment on each trailer,
supervisors file vehicle incident reports, and everything exports to CSV.

It's built for weak cell signal: drafts stay on the phone and upload when signal returns, and a submit never creates a
duplicate. Submitted records are read-only, enforced by the database, and nothing is erased except by an admin, from
the trash, after a week.

## Features

- **Inspections:** exterior, interior and trailer checklists with big OK / Repair buttons (Repair needs a note), damage
  pins on the truck and trailer pictures (earlier damage shows as grey dots), photos, finger signatures, and a save bar
  that lists what's missing.
- **Offline-friendly:** drafts autosave on the phone (IndexedDB), uploads retry with backoff, and submits are
  idempotent (`client_id`). It installs to the home screen as a PWA. A one-hour burn-in test (30 simulated phones on a
  bad connection while the app crashes and the database restarts) lost and duplicated nothing.
- **Supervisor review:** sign-off with a signature, resolve repairs, archive or delete inspections, and update
  registration dates with a full history.
- **PDF export:** one inspection per PDF, laid out like a paper sheet with pins, photos and signatures; batch export
  to a zip built on the phone.
- **Maintenance log** for the shop: several types of work per entry with next-due mileage and dates, closing repairs
  and damage (with a photo of the fix), edit history, and void instead of delete.
- **Repairs board** across the fleet, and **repair tickets** (RT-0001…) as PDFs to print or share with a shop.
- **Yard walks:** a daily fire-safety walk of a yard (checklist editable), with OK / Repair, notes, photos, a signature
  and a PDF; problems stay open until resolved.
- **Equipment checks:** trailers and tagged equipment (trimmers, blowers and the like), each piece checked on its
  type's checklist, due every 30 days by default, with its own maintenance log.
- **Fleet:** truck status (in service, in the shop, on hold, preparing for return, returned, sold, retired) with
  history, trailers moved between trucks, and a reminders list (registrations, overdue inspections, maintenance and
  equipment due).
- **Incident reports:** supervisors file vehicle incidents from the phone (location with optional GPS, police,
  injuries, damage pinned on the truck, other parties, witnesses, a sketch of the scene, photos, signatures). It prints
  as one PDF packet, and the damage goes on the truck's record until it's repaired. Only supervisors and admins can
  see reports, and the driver's home address, birth date, license and employee ID are never stored.
- **Trash and Delete forever:** Delete moves a record to Admin → Trash, where it can be restored. After 7 days an admin
  can delete it for good; every permanent delete is logged.
- **CSV export** of inspections, repairs, maintenance and trucks, safe to open in Excel.
- **Admin:** users and PINs, trucks and diagrams, trailers and equipment, checklist editors (truck, yard, equipment)
  with change history, and branding (company name, app name, header color, logo). Light and dark mode.
- **Security:** PIN and password lockouts, per-network sign-in limits, a CSRF guard, upload limits, and HSTS. See
  [SPEC.md §3](SPEC.md#3-stack-and-hosting).

Roles: **crew** (inspect), **supervisor** (review, sign off, yard walks, incidents, export), **shop** (maintenance,
equipment), **admin** (everything). The full behavior is in [SPEC.md](SPEC.md).

## Quick start (Docker Compose)

Needs Docker with the compose plugin.

```bash
git clone https://github.com/tynet1/TireKicker.git
cd TireKicker
cp .env.example .env    # set POSTGRES_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD, SITE_ADDRESS, TZ
docker compose up -d --build
```

Open `http://localhost/` (or your domain) and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Then, under
**Menu → Admin**, set your branding, add crew users with PINs, and add trucks.

To try it with sample data, copy `seed/vehicles.example.csv` to `seed/vehicles.csv` before the first start; the app
adds those 8 fake trucks on start. For a real install, start with your own fleet instead: put your trucks in
`seed/vehicles.csv` (it's gitignored) or add them in Admin. Sample trucks would otherwise have to be retired and then
deleted through the trash.

Production setup (HTTPS, Cloudflare Tunnel, backups, restore, updates, firewall): [docs/DEPLOY.md](docs/DEPLOY.md).

## Configuration

All settings live in `.env`; [.env.example](.env.example) documents each one.

| Setting | What it does |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Database credentials (the password is required) |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin account, created on first start if there is no admin (password 10+ characters) |
| `SITE_ADDRESS` | `:80` for plain HTTP (behind a tunnel or on a LAN), or a domain for automatic HTTPS |
| `HTTP_PORT`, `HTTPS_PORT` | Host ports for Caddy |
| `COOKIE_SECURE` | `auto` (default) marks the sign-in cookie Secure over HTTPS |
| `UPLOAD_DAILY_MB`, `UPLOAD_MIN_FREE_MB` | Photo limit per person per day (1024), and the free disk space under which uploads wait (2048) |
| `TZ` | Time zone for PDF and CSV dates (defaults to UTC) |
| `CLOUDFLARE_TUNNEL_TOKEN` | Optional tunnel, started with `docker compose --profile tunnel up -d` |
| `BACKUP_DIR`, `BACKUP_HOUR`, `BACKUP_KEEP_DAYS` | Nightly backups: where, when, and how many days to keep |

## Develop locally

Needs Node 24+ and a Postgres 16 database.

```bash
npm install
npx playwright install chromium        # for PDF export
```

Create `.env.local` (gitignored) with at least `DATABASE_URL`, `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then:

```bash
npm run dev                            # http://localhost:3000, migrations run on start
npm run user -- add --name "Test Crew" --role crew --pin 1234
npm run typecheck
```

There's no build step: Node 24 runs the TypeScript in `src/` directly, and the frontend in `public/` is plain ES
modules. Changes under `public/` need a server restart so the service worker picks up the new version.

## Tests

The API tests run against a real Postgres and **wipe the database they're given**, so use a throwaway one. With Docker:

```bash
docker run -d --name tirekicker-test-pg -e POSTGRES_USER=gc -e POSTGRES_PASSWORD=gctest -e POSTGRES_DB=gc_test -p 127.0.0.1:54330:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://gc:gctest@localhost:54330/gc_test npm test
docker rm -f -v tirekicker-test-pg
```

Without `TEST_DATABASE_URL`, `npm test` skips the database tests (`api`, `incidents`, `trash`) and runs the rest
(browser files parse, the service worker lists every script, CSV and zip helpers, client-address handling). The
database tests load their own fake fleet from `test/fixtures/vehicles.csv`.

Burn-in test (needs its own empty database; about an hour):

```bash
docker run -d --name tirekicker-burn-pg -e POSTGRES_USER=gc -e POSTGRES_PASSWORD=gctest -e POSTGRES_DB=gc_burn -p 127.0.0.1:54331:5432 postgres:16-alpine
node scripts/burnin.ts --db postgres://gc:gctest@localhost:54331/gc_burn --minutes 60 --phones 30 --crash-every 5 --pg-container tirekicker-burn-pg
docker rm -f -v tirekicker-burn-pg
```

What it checks and what the last run found: [docs/PHASE3-REVIEW.md](docs/PHASE3-REVIEW.md).

## Layout

```
src/                 Fastify API (TypeScript, run directly by Node 24, no build step)
  routes/            auth, vehicles, photos, inspections, service (maintenance), tickets, export (CSV),
                     checklist (editor), yard (yard walks), equipment (trailers, equipment, checks),
                     equipment-service (equipment maintenance), fleet (status, trailers, reminders),
                     incidents (incident reports), trash (delete, restore, delete forever, old records),
                     admin, branding
  photo-owners.ts    the one list of records a photo can belong to (used by every photo check and the clean-up)
  pdf.ts             inspection-sheet HTML template -> PDF via headless Chromium
  ticket-pdf.ts      repair ticket PDF
  yard-pdf.ts        yard walk PDF
  incident-pdf.ts    incident report packet
  csv.ts             CSV files for Excel (formula-safe)
  storage.ts         photo/signature storage (local disk; S3/Azure could go behind the same interface)
public/              the web app (plain HTML/CSS/JS modules, no framework), service worker, diagrams
  js/theme.js        light or dark look (runs before the page draws; colors are CSS variables in css/app.css)
  js/views/          one module per screen (home, truck, form, detail, repairs, tickets, yard, incidents, admin…)
  js/drafts.js, svc.js, yardq.js, equipq.js, esvcq.js, incq.js   what's saved on the phone and the upload queues
db/migrations/       numbered SQL migrations, applied automatically on start (never edit one that has shipped)
seed/                vehicles.example.csv: the format for loading trucks from seed/vehicles.csv
scripts/             backup.sh (nightly, run by the backup container), restore.sh, burnin.ts (burn-in test)
test/                database tests against a real Postgres, plus browser-file, CSV and zip checks
docs/                DEPLOY.md (production setup, backups, restore, updates), PHASE3-REVIEW.md (review and burn-in)
```

## Contributing and security

Issues and pull requests are welcome. Please read [SPEC.md §4a](SPEC.md#4a-data-safety-top-priority) first: any change
that stores, moves or deletes data must keep the "never lose data" rules. To report a security problem, see
[SECURITY.md](SECURITY.md); please don't open a public issue for it.

## License

[MIT](LICENSE)
