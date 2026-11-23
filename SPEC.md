# TireKicker: design spec

How the app behaves and why. Code comments point at these sections (for example "SPEC §4a"), so keep the numbering.

## 1. Why

Many fleets still inspect trucks on paper, one sheet per truck, monthly or quarterly. That causes three problems:

- Damage is only found at the next inspection, so nobody knows when it happened or who was driving.
- Completed sheets aren't searchable, and repairs written on them don't reliably get done.
- Paper forms often have no signature lines, so there's no sign-off chain.

The app moves the same sheet onto a phone and adds damage pins, photos, signatures, supervisor review and repair follow-through.

## 2. Users and roles

| Role | Who | Can |
|---|---|---|
| crew | Crew leads and drivers | Sign in with name + PIN, start or resume an inspection, upload photos, submit |
| supervisor | Crew supervisors, fleet staff | Everything crew can do, plus review and sign off inspections, mark repairs resolved, export PDFs, walk yards, check equipment, and file and read incident reports |
| shop | Shop manager or mechanic | Everything crew can do, plus log, edit and void maintenance entries (trucks and equipment), check equipment, and close repair items; can't sign off inspections or export PDFs |
| admin | Whoever runs the app | Everything, plus manage trucks, trailers, equipment, diagrams, checklists, users and branding, and the trash |

Crew sign-in has to be fast on a phone in a truck: pick your name, enter a 4–6 digit PIN, and the session stays signed
in for about 30 days. Supervisors and admins use email + password.

## 3. Stack and hosting

- **Runtime:** Docker Compose (Postgres 16, the app, Caddy, a nightly backup job, optional Cloudflare Tunnel).
- **App:** Node.js 24 runs the TypeScript directly (no build step), Fastify API, plain HTML/JS mobile-first frontend
  with a service worker. No native app.
- **Photos and signatures:** files on a Docker volume (`/data/uploads/yyyy/mm/<uuid>.jpg`), path stored in Postgres.
  Phones resize photos to at most 1600px JPEG before upload. Storage sits behind an interface (`src/storage.ts`) so it
  can move to S3 or Azure Blob later.
- **PDF:** server-side, an HTML print template rendered by headless Chromium (Playwright).
- **Reverse proxy / TLS:** Caddy (automatic HTTPS when `SITE_ADDRESS` is a domain).
- **Backups:** nightly `pg_dump` plus an uploads tarball to a second location, keeping 30 days.

### Remote access

Crews are on cellular in the field, so phones must reach the server from the internet. Options:

1. **A small cloud VM** with a domain: Caddy gets a certificate and serves HTTPS directly.
2. **Cloudflare Tunnel** for a server on an office or home network: no open ports, real HTTPS hostname, free tier.
3. Port-forwarding and dynamic DNS: not recommended.

### Hardening for the open internet (migration 009)

- The app trusts forwarded headers only from its own proxies (private addresses), so the sign-in limits count the
  phone's real address. When the domain is proxied through Cloudflare, the phone's address is Cloudflare's
  `CF-Connecting-IP`, used only when the connection really comes from Cloudflare's published ranges (listed in
  `src/auth.ts`; recheck cloudflare.com/ips once a year). Someone going around Cloudflare can't fake it.
- Wrong sign-ins: an account locks after 5 wrong tries in a row, for 15 minutes, doubling with each lockout that
  day (30, 60, 120, then 240 minutes). Tries sent all at once count too. One network gets 20 wrong tries an hour
  across all accounts; for IPv6 a network is its /64. A crew sharing a yard's Wi-Fi address shares that budget, so a
  person's own typos stop counting once they sign in. An admin setting a new PIN or password unlocks the account at once.
- Photo uploads stop at 1 GB per person per 24 hours (`UPLOAD_DAILY_MB`), and pause for everyone while the server disk
  has under 2 GB free (`UPLOAD_MIN_FREE_MB`), because the database is usually on the same disk. Either way the phone
  keeps the photos and keeps retrying, and the draft shows why.
- HSTS over HTTPS (one year).

## 4. Screens (all phone-first, also good on iPad)

1. **Sign in:** name picker + PIN pad, or email/password for supervisors and admins.
2. **Home / pick a truck:** searchable list of trucks (code, year/make/model, plate, VIN). Each shows badges for last
   inspection date (warn if over 35 days), open repair count, draft in progress, and registration expired.
3. **Truck page:** header info, Start/Resume inspection, open repairs from all past inspections, **damage on file** (the
   truck picture with every damage mark from every inspection, numbered oldest first, and a list newest first with the date,
   a link to the inspection and its photos), maintenance, repair tickets and inspection history. Each mark on file has
   **Log fix** (shop/admin) and **Mark repaired** (supervisor/admin); repaired marks move to a **Repaired** list with
   before and after photos (§9).
4. **Inspection form** (same order as the paper sheet):
   - Truck header (read-only)
   - Date (default today), inspector name (default signed-in user), mileage (numeric keypad), oil change due Yes/No
   - **Damage diagram:** tap to drop a numbered pin and describe it. All damage already on file (every pin from every
     earlier inspection, since crews only mark new damage) shows as grey dots. A "Damage already on file" list under the
     picture shows each one's description and date; tapping one darkens and numbers its dot, so crews don't mark the same
     damage twice. Pins drawn on a picture the truck no longer uses are left off the form (still listed on the truck
     page). A photo can be attached to a pin.
   - Existing notes (prefilled from the previous inspection's notes and observations) and New observations
   - Checklist sections, Exterior (16) and Interior (16) by default. Each item has big OK / Repair buttons; Repair
     requires a short note and allows a photo. "Mark rest OK" per section.
   - Trailer switch (defaults on if the truck usually pulls a trailer). When on: trailer number/plate, trailer diagram
     with pins, and the Trailer & crew checklist (17 by default).
   - Photos with captions; uploaded as they're added
   - Comments
   - Employee signature (finger-drawn)
   - Sticky bottom bar with progress (N of M items) and Save. Save is blocked until required fields are done, and the
     missing items are listed and highlighted.
   - Drafts autosave on the device (IndexedDB) and survive closing the browser
5. **Inspection detail:** everything submitted, repairs listed first, damage diagram with pins, photo gallery with
   full-screen view, full checklist, signatures. Supervisor sign-off happens here (name + finger signature).
   **Export PDF** button. **Archive or delete** card (§9): Archive / Un-archive (supervisor+), Delete / Restore (admin),
   with the history of each change; an archived or deleted inspection shows a banner saying so.
6. **Repairs board** (supervisor, shop, admin): all open repair items across the fleet from live inspections on trucks in
   service, filterable by truck, grouped by truck (oldest first) or one list oldest first, each with how long it's been
   open (amber from 14 days, red from 30) and its photos. Resolve with a note (supervisor/admin) or Log fix to close it
   through a maintenance entry (shop/admin).

   6a. **Maintenance log** (shop, admin; supervisors can read): on the truck page, "Next due" (from the newest entry of
   each type, orange within 500 miles or 14 days, red when due), the list of entries, and "+ Log maintenance". The entry
   form has date, mileage, types of work (one or more of: oil change, tires, brakes, repair, preventive maintenance,
   inspection/registration, other), work done, parts, cost, done by, outside shop, the truck's open repairs and damage to
   tick off, next due mileage/date for each type picked, photos, notes. An entry shows its repairs, photos and every
   change ("Cost: $64.20 → $66.40"). Shop/admin can edit it or void it with a reason.

   **Closing repairs:** every open repair (truck page and inspection) has a **Log fix** button for shop/admin that opens
   a new entry with that repair ticked and the type of work picked. Picking a type of work also ticks matching open
   repairs (oil change → engine oil; tires → tire items; brakes → brake items but not brake lights;
   inspection/registration → plate, tag and registration items), shown with a "Matches …" label; a tick set or cleared
   by hand is never changed. Saving closes the ticked repairs; the inspection then shows "✓ Repairs fixed" (green)
   instead of red, and each fixed repair links to its entry. Supervisors keep the quick **Resolve** (note only).
7. **Admin:** trucks (add, edit every header field, retire, pick or upload the body diagram, set the trailer type or
   "no trailer"), trailer types (name + picture), users and PINs, branding (company name, app name, header color, logo),
   trailers and equipment, the checklist editors for trucks, yards and equipment (§9), and the trash (§4a).

A trailer type is a named trailer diagram. Every inspection records which truck and trailer pictures it was drawn on, so
changing a truck's diagram or trailer type later never moves old pins.

## 4a. Data safety (top priority)

Losing an inspection, photo or log entry is the worst failure this app can have. Every change is judged against that first.

- Nothing is erased by accident or in a hurry. An admin can erase a record on purpose through one guarded path, the
  trash (020, below); everything else holds: trucks, users, diagrams and checklist items are retired, not removed, and
  every guard in the database refuses deletes and changes.
- **The trash and Delete forever (020).** For test records before rollout, mistakes, personal information on request,
  and records past an age. Admins only.
  - **Delete puts a record in the trash** (Admin → Trash), never erases it: inspections, incident reports, yard walks,
    equipment checks, maintenance entries (truck and equipment), repair tickets, and retired trucks and inactive users
    that have nothing on file. A record in the trash is out of every list and off the truck; Restore puts it back.
    Maintenance entries and tickets are voided as they go in (as a void always does, a maintenance entry's repairs
    reopen), and come back voided. A truck or user with any record on file stays retired instead, so their history is
    never orphaned.
  - **After 7 days in the trash** an admin can **Delete forever**: the record and everything that is only part of it
    (checklist answers, damage marks and their repairs, notes, edit history, photos, signature and sketch files).
    Things that stand on their own stay: a ticket or maintenance entry that listed its repairs just loses those lines,
    damage a deleted maintenance entry fixed stays repaired (with its photo), and a registration update made at sign-off
    stays in the truck's history. The screen first shows exactly what will go (worked out by doing it and rolling it
    back) and asks for the truck number (or the yard, trailer, tag or person's name) to be typed.
  - **Old records:** Admin → Trash → Move old records to the trash takes every record of the ticked kinds dated before a
    day (count typed to confirm). They can be restored like any other until deleted forever. **Delete forever all
    ready** does every record past its 7 days.
  - **The database enforces it:** every guard still refuses deletes and changes, except inside one transaction started
    by `gc_begin_purge(kind, id)`, which itself refuses a record that isn't in the trash or hasn't been there 7 days.
    Files are removed only after that transaction commits, and only if nothing in the database still points at them.
  - **The log:** each permanent delete is a line in `purge_log` (Admin → Trash → Deleted forever): what kind of record,
    which truck, its date, why, who put it in the trash and who deleted it forever, and how many rows and files went.
    Never the record's contents; a user is logged as "User #12 (crew)", without the name. The log can't be changed or
    erased.
  - Nightly backups keep 30 days, so a record deleted forever is still in the backups for up to 30 days, then gone.
- Submitted records are read-only in the database (triggers), and corrections go in notes.
- The phone keeps a draft until the server confirms it; submits are idempotent; uploads retry.
- Files are written to a temp file, flushed to disk and renamed, so a crash never leaves a half-written photo.
- Schema changes only add numbered migrations, each in one transaction.
- Damage repairs (006) can't be edited or deleted, only ended (undo / voided entry) with who, when and why.
- The database refuses to delete inspections, their checklist answers and damage marks, and any photo once it's attached
  (005). "Delete" in the app only marks an inspection deleted (in the trash), restorable, with every change kept as
  history; only Delete forever (020) erases it.
- Nightly backups (database + uploads) to a second location. A backup is written to a temp file and renamed only when
  complete, never overwrites an existing backup, and runs one at a time. A restore first saves the current data as a
  `_before-restore` backup, so a wrong restore can be undone. Test a restore before relying on it (docs/DEPLOY.md §5).
- The app survives the database restarting under it (a dropped connection is logged and replaced, not a crash).
- Maintenance entries: never deleted (void with a reason; the database refuses deletes), every edit saves the previous
  version, an edit made from an out-of-date copy is refused instead of overwriting, and voiding reopens the repairs the
  entry closed. Orphan-photo cleanup skips photos attached to an entry.
- Uploads pause (the phone keeps the photos and retries) before the disk the database lives on fills up (009).
- Repair tickets (010) can't be deleted or changed, only voided once with a reason; the repairs on a ticket never change.
- Checklist items (011) are retired, never deleted, and every checklist change is kept; editing the checklist never
  changes a submitted inspection or bounces one that's being filled in.
- Yard walks (012) are read-only once submitted; only a finding's resolution is recorded later. Yards, yard checklist
  items and their change history can't be deleted, and a walk's photos are protected like any other.
- Equipment checks (013) are read-only the same way. Trailers, equipment, their change history and the equipment
  checklist can't be deleted. Which records a photo can belong to is one list (`src/photo-owners.ts`), used by every
  photo check and the clean-up, so a new kind of record can't leave its photos unprotected.
- Equipment maintenance entries (014) can only be voided (with a reason), never edited or deleted; voiding reopens the
  problems the entry closed.
- Truck status changes (015) are recorded by the database itself for every change, however it's made, and the history
  can't be edited or deleted. Trailer moves are kept with the other asset changes.
- From the hardening review (docs/PHASE3-REVIEW.md): trucks, users and truck pictures can't be deleted in the database
  either (017). A file written for a save that then fails is removed only once the database confirms nothing points at
  it (the save may have gone through after all). Every photo upload gets its own file name, and a file's folder is
  flushed after it's written. A photo already uploaded from a phone can be sent by whoever is signed in on it (shared
  phones), and one cleaned up mid-save is simply uploaded again. The phone's offline cache keeps the newest 400 items,
  so it can't grow until the browser clears the app's storage. A 60-minute burn-in (30 phones, bad signal, app
  crashes, database restarts) checks that nothing is lost, duplicated or incomplete: `scripts/burnin.ts`.
- Incident reports (018) follow the inspection rules: idempotent submit on `client_id`, read-only once filed (the
  database refuses changes and deletes to the report, its damage marks, notes and who-has-read-it rows), corrections
  and later facts are notes added with who and when, and archive/delete only changes a state row with history (delete
  is admin-only with a reason; restore from Admin → Trash). Their photos are attached like any other record's.

## 5. Business rules

- Required to submit: date, inspector, mileage, oil change due, every visible checklist item answered, a note on every
  Repair, and the employee signature.
- Mileage must be at least the truck's last recorded mileage. If it's lower, warn but allow (odometer typo), and flag the record.
- An inspection is immutable after submit, except for the supervisor sign-off and repair resolution fields. Corrections
  go in a supervisor note.
- Inspections store a snapshot of checklist labels, so editing the checklist never changes old records.
- Submits are idempotent: the phone generates `client_id` (uuid). A retried submit with the same `client_id` returns the
  existing record.
- Weak signal is normal. Uploads and submits retry with backoff, the draft stays on the device until the server
  confirms, and the UI shows "Saved on phone, not yet uploaded" rather than failing.
- Retention: keep everything; it's small. (In the US, FMCSA's DVIR minimum is 90 days if any vehicles count as CMVs.)

## 6. PDF export

- One inspection → one PDF laid out like a paper truck inspection sheet:
  - Page 1: header table, damage diagram with numbered pins and a legend, notes, the two-column checklist with
    OK/Repair checkmarks
  - Page 2, if a trailer was inspected: trailer diagram, trailer checklist, comments, signatures
  - Final pages: photos, 2 per row, with captions
- Filename: `<TruckCode>_<YYYY-MM-DD>_inspection.pdf`
- The logo and company name from branding print at the top of page 1.
- If repairs were closed through the maintenance log, a "Repairs fixed — maintenance log" section follows the sign-off:
  one table per entry (number, type, date, mileage, done by / outside shop, cost, repairs fixed, work done, parts, notes,
  who logged it and whether it was edited later). The checklist line says "✓ Fixed <date> (maintenance entry N)", and
  the entry's photos go on the photo pages captioned "Maintenance entry N". Voided entries are left out.
- Page 1 stays one page: the diagram shrinks (down to 1.9in) when repair notes, a long damage legend or long notes need
  the room. A sheet too busy even for that continues on the next page with the checklist header repeated, never leaving
  a blank page. Timestamps print in the server's time zone (`TZ`), not UTC.
- **Batch export:** Export PDFs screen (supervisor+, from the menu, home or a truck's history). Filter by truck and
  dates (quick picks: last 7 days, this month, last month), then tick the inspections wanted (or Select all). Each
  becomes **its own PDF**, named like a single export (`_2`, `_3` added if two share a name), never one combined PDF;
  saved together in `inspections_<date>.zip`, or shared as separate PDFs where the phone supports sharing files (needs
  HTTPS). The phone fetches the PDFs two at a time and retries each one on a weak signal, with progress and Cancel; any
  that still fail are listed with "Try again", which fetches only those. Up to 100 per export; the list shows the
  newest 200. The zip is built on the phone (`public/js/zip.js`, stored, no compression), so the server only ever
  makes single PDFs.
- **CSV export:** a Download CSV screen (supervisor, shop, admin; from the menu and from a "Download CSV" link on Export
  PDFs, the repairs board, a truck's Maintenance section and Admin → Trucks, carrying that screen's truck). Pick what:
  **Inspections** (supervisor+; one row each: date, truck, inspector, mileage, oil due, trailer, repairs needed and how
  many are still open, notes, registration on file then, sign-off, archived, link), **Repairs** (one row per repair
  item: truck, item, note, reported, days open, fixed when/by/how, maintenance entry, link), **Maintenance log** (one
  row per entry: every type of work with its next due, description, parts, cost, vendor, who entered and last edited
  it, link) or **Trucks** (VIN, plate, registration, trailer, last inspection and mileage, open repairs, damage on file,
  last maintenance, link). Filters: truck, dates (with the same quick picks), and "include archived inspections / fixed
  repairs / voided entries / retired trucks". Every matching row is in the file (up to 20,000). Lists count what the
  truck page counts (live inspections; deleted ones are never exported). The file is UTF-8 with a byte-order mark so
  Excel opens names correctly; dates are `2026-11-17`, times `2026-11-17 14:05` in the server's time zone. Text that a
  spreadsheet would run as a formula (starting with = + - @) gets a leading apostrophe. The phone shows how many rows,
  then Save or Share; if nothing matches it says so instead of saving an empty file.

## 7. API sketch

All under `/api`. Every state-changing call needs the `x-gc-app: 1` header.

```
POST /auth/pin            {user_id, pin}
POST /auth/login          {email, password}
GET  /vehicles            -> vehicle_status rows
GET  /vehicles/:id        -> vehicle + open repairs + history + damage on file (with photos)
GET  /vehicles/:id/last   -> last inspection (to prefill notes) + all damage on file that fits today's picture (grey pins)
POST /photos              multipart -> {id}   (before submit; orphan cleanup after 7 days)
POST /inspections         {client_id, ..., items[], damage[], photo_ids[]}
GET  /inspections?limit&status&vehicle_id&from&to&archived   (from/to: inclusive dates; archived=only|include, else live only)
POST /inspections/:id/archive {reason?} · /unarchive          supervisor+
POST /inspections/:id/delete {reason} · /restore             admin
GET  /admin/deleted-inspections                               admin (older app copies; Admin → Trash uses the routes below)
GET  /admin/trash                                             admin: everything in the trash, with ready / ready_at / confirm
POST /admin/trash {kind, id, reason} · /admin/trash/restore {kind, id}       admin (kind: inspection, incident, yard_walk,
                                 equipment_check, service_log, equipment_service, repair_ticket, vehicle, user)
POST /admin/trash/preview {kind, id}                          admin: what Delete forever would remove (done, then rolled back)
POST /admin/trash/purge {kind, id, confirm}                   admin: Delete forever (7+ days in the trash; idempotent)
POST /admin/trash/purge-ready {confirm} · {more, skip[]}      admin: everything ready, a batch per call
GET  /admin/old-records?before&kinds · POST /admin/old-records/trash {before, kinds[], reason, confirm}   admin
GET  /admin/purge-log                                         admin
POST /damage-marks/:id/repair {client_id, note, photo_ids[]}   supervisor+ (photo required; idempotent)
POST /vehicles/:id/registration {client_id, expires, was, from: form|sign-off|truck, inspection_id?, note?, photo_ids[]?}
                                 supervisor+; 409 if the date changed since `was`; idempotent; history in GET /vehicles/:id
POST /damage-repairs/:id/undo {reason}                       supervisor+ (supervisor repairs only)
POST/PATCH /service-logs also take damage_mark_ids[], with photos[].damage_mark_id for the photo of each fix
GET  /inspections/:id
POST /inspections/:id/review     {signature (png)}        supervisor+
POST /inspection-items/:id/resolve {note}                 supervisor+
GET  /inspections/:id/pdf
GET  /repairs?vehicle_id                 -> open repairs across the fleet (repairs board)   supervisor, shop, admin
GET  /export/inspections.csv?vehicle_id&from&to&include=1   (archived too)      supervisor+
GET  /export/repairs.csv?vehicle_id&from&to&include=1       (fixed too)         supervisor, shop, admin
GET  /export/maintenance.csv?vehicle_id&from&to&include=1   (voided too)        supervisor, shop, admin
GET  /export/trucks.csv?include=1                           (retired too)       supervisor, shop, admin

Repair tickets, supervisor, shop, admin:
POST /repair-tickets {client_id, vehicle_id, item_ids[], sent_to?, note?}   -> {id, number}  (200 + duplicate on a retry)
GET  /repair-tickets/:id             -> the ticket, its truck, and each repair with whether and how it was fixed
GET  /repair-tickets/:id/pdf[?inline=1]
POST /repair-tickets/:id/void {reason}
GET  /vehicles/:id/repair-tickets    -> the truck's tickets with fixed counts
GET  /repair-tickets/sent-to         -> recent "Sent to" names
admin CRUD: /vehicles, /trailers, /diagrams, /users

Checklist editor, admin only:
GET  /admin/checklist                -> {sections, items (with how often each was answered), changes}
POST /admin/checklist {section, label}
PATCH /admin/checklist/:id {label}
POST /admin/checklist/:id/move {direction: "up" | "down"}
POST /admin/checklist/:id/retire, /restore
GET  /form-config also returns as_of; the phone sends it back as checklist_as_of with the inspection.
/admin/yard-checklist and /admin/equipment-checklist: the same five calls for those checklists.

Yard walks:
GET  /yards                          -> yards with walked_today, last_date, open_findings     supervisor, shop, admin
GET  /yard-config                    -> {sections, checklist, as_of}                          supervisor+
POST /yard-inspections {client_id, yard_id, inspection_date, inspector_name, comments, checklist_as_of, items, photos, signature}
                                     -> {id, failed} (200 + duplicate on a retry)              supervisor+
GET  /yards/:id/inspections          -> the yard's walks, newest first                         supervisor, shop, admin
GET  /yard-inspections/:id           -> walk, items (with resolutions), photos                 supervisor, shop, admin
GET  /yard-inspections/:id/signature, /pdf (supervisor+)
GET  /yard-findings                  -> open findings, oldest first                            supervisor, shop, admin
POST /yard-findings/:id/resolve {note}                                                         supervisor+

Equipment:
GET  /admin/equipment                -> {types, check_days, trailers, equipment}                admin
POST /admin/trailers, PATCH /admin/trailers/:id; POST /admin/equipment, PATCH /admin/equipment/:id   admin (moves = trailer_id)
PUT  /admin/equipment-settings {check_days}                                                     admin
GET  /equipment                      -> trailers with pieces (last_checked, due, open_problems), unassigned   supervisor, shop, admin
GET  /equipment/:id                  -> a piece, its history and checks                          supervisor, shop, admin
GET  /equipment-config/:trailer|none -> {trailer, pieces, sections, checklist, as_of}            supervisor, shop, admin
POST /equipment-checks {client_id, trailer_id, check_date, checker_name, comments, checklist_as_of, pieces, photos}
                                     -> {id, failed} (200 + duplicate on a retry)               supervisor, shop, admin
GET  /equipment-checks?trailer=…, /equipment-checks/:id
GET  /equipment-findings; POST /equipment-findings/:id/resolve {note}                           supervisor, shop, admin
GET  /equipment-service-config       -> {work}                                                  supervisor, shop, admin
GET  /equipment/:id/service          -> {entries, next_due}                                     supervisor, shop, admin
POST /equipment-service {client_id, equipment_id, service_date, work:[{type, next_due_date}], description, parts, cost,
     performed_by, vendor, notes, fix_item_ids, photos} -> {id, fixed} (200 + duplicate on a retry)   shop, admin
GET  /equipment-service/:id; POST /equipment-service/:id/void {reason}                          read: supervisor, shop, admin; void: shop, admin

Fleet, supervisor, shop, admin:
GET  /fleet-config                   -> {statuses, shop_statuses}
POST /vehicles/:id/status {status, note}     (the shop: in_service, in_shop, on_hold, trucks in the fleet only)
GET  /vehicles/:id/status-history
GET  /trailers; POST /trailers/:id/assign {vehicle_id | null}
GET  /reminders                      -> {due, soon, items: [{kind, state, title, detail, link}]}
GET  /vehicles/:id includes vehicle.status and vehicle.trailer.

Incident reports, supervisor and admin:
GET  /incident-config                -> what the form needs besides the truck (drivers to pick from)
POST /incidents {client_id, vehicle_id, ...}  (200 + duplicate on a retry)
GET  /incidents?vehicle_id, /incidents/unread, /incidents/:id; POST /incidents/:id/read
POST /incidents/:id/notes {note}
GET  /incidents/:id/file/:which (driver, reporter, sketch) · /incidents/:id/pdf
POST /incidents/:id/archive · /unarchive (supervisor+) · /delete {reason} · /restore (admin)
GET  /incident-repairs               -> incident damage not yet repaired (repairs board)   supervisor, shop, admin

Maintenance log:
GET  /service-config                -> {categories}                          shop, supervisor, admin
GET  /vehicles/:id/service          -> {entries, next_due, current_mileage}  shop, supervisor, admin
GET  /service-logs?limit            -> recent entries across the fleet
GET  /service-logs/:id              -> entry + repairs + photos + history
POST /service-logs                  {client_id, vehicle_id, ..., repair_item_ids[], photos[]}   shop, admin (idempotent)
PATCH /service-logs/:id             {version, changed fields, more repair_item_ids/photos}      shop, admin (409 if stale)
POST /service-logs/:id/void         {reason}                                                    shop, admin
```

## 8. Checklist and diagrams

- One checklist for every truck (Exterior, Interior, and Trailer & crew), and a diagram per truck model. The default
  items are seeded by migration 001; admins change them in Admin → Checklist (§9).
- Bundled diagrams are generic line drawings (`public/diagrams/`: pickup, dump truck, utility trailer). Admins upload a
  JPEG or PNG for each of their own models and trailer types; uploaded ones are stored like photos.
- Trucks can be loaded from `seed/vehicles.csv` on start (see `seed/vehicles.example.csv`); a truck already in the
  database is never changed by the seed file.

## 9. Feature notes

- **Maintenance log** (§4 6a): for the `shop` role. Log service and repairs on a truck, close the repair items it fixes,
  next-due tracking, and each truck's full history.
- **Several types of work on one maintenance entry (migration 007):** one shop visit often covers several (oil change +
  tires + brakes). "Type of work" is a multi-select; each selected type gets its own optional next-due mileage and/or
  date. The truck page's "Next due" list keeps one line per type, taken from the newest live entry with that type. The
  entry stores its work as a list of {type, next-due mileage, next-due date}; the older single-type columns stay and
  mirror the first type, so a save queued on a phone running an older version is still accepted.
- **Mark damage repaired (migration 006):** each mark in "Damage on file" gets **Repaired**: shop/admin can **Log fix**
  (opens a maintenance entry with that damage ticked), supervisors can mark it repaired with a short note. **A photo of
  the fixed area is required** either way (proof for lease returns and insurance). A repaired mark drops off the
  form's grey dots; the truck page keeps it under "Repaired" with when, who and the maintenance entry. Voiding that
  entry, or undoing a supervisor's repair (reason required), puts the damage back on file.
- **Archive or delete inspections (migration 005):** for mistakes (wrong truck, a duplicate, a test) and for clearing
  old ones out of the lists. **Archive** (supervisor+) hides an inspection from home, truck history, the export list and
  sign-off lists; it still opens from a link or an "Archived" filter and can be un-archived. **Delete** (admin only,
  reason required) moves it to Admin → Trash, where it can be restored; after 7 days there an admin can delete it
  forever (§4a, migration 020). Nothing is cleaned up automatically. Archived and deleted inspections' open repairs and damage come off the truck while they're archived or deleted, and
  the Archive confirmation names what will come off. The submitted inspection itself stays read-only: the state lives
  in its own table, with every change kept as history.
- **Registration expiration (migration 008):** the inspection form, the sign-off screen and the truck page show the
  truck's registration expiration (red once expired, amber within 30 days); a supervisor or admin taps **Update**,
  enters the new date and can add a note and a photo. It changes the truck, not the inspection, and needs signal. The
  screen sends the date it showed, so a concurrent change is never overwritten. Every change, including Admin → Trucks
  edits and any made outside the app, is kept in a registration history listed on the truck page. An inspection, its
  detail screen and its PDF show the date that was on file when it was submitted.
- **PDF repair ticket (migration 010):** from the repairs board or a truck page, a supervisor, the shop or an admin ticks
  the repairs, adds an optional "Sent to" (names used before are suggested) and note, and taps **Make ticket**. It needs
  signal; a retry never makes a second ticket. The ticket gets the next number (**RT-0001**…) and opens with **Share or
  email PDF**, **Save PDF** and **Open PDF to print**. The PDF carries branding, the truck (code, VIN, plate, last
  mileage), each problem with its note and photos, and blank lines for the shop (work done, parts, cost, date,
  signature). A ticket's **Log fix** opens a maintenance entry with its still-open repairs ticked. A mistaken ticket is
  **voided** with a reason: it stays listed, its PDF says VOID, and its repairs stay open. A ticket can also hold damage
  from an incident report (019), but **only if someone ticks it**: the picker never ticks incident damage for you, so a
  totaled truck doesn't go to the mechanic by accident.
- **Checklist editor (migration 011):** Admin → Checklist lists the Exterior, Interior and Trailer & crew items in form
  order. An admin adds an item (at the end of its section), rewords one, moves it up or down, retires it or restores it.
  No two items in use in a section may read the same. Every change is kept with who and when. Changes apply to new
  inspections only: submitted inspections keep the items, wording and order they had. A form already open on a phone
  keeps working: it sends when it loaded the checklist, so the server doesn't demand items added after that and still
  accepts answers to items retired since (a claimed checklist time counts back at most 90 days). The same editor serves
  the yard walk and equipment checklists.
- **Yard walks (migration 012):** a supervisor's daily walk of a yard (Menu → Yard walks, or the yard card on the home
  screen). Yards are a table (one "Main yard" to start; add more). The walk has a date, the inspector, the yard checklist
  in four sections (Fire safety; Fuel, oil & chemicals; Equipment & charging; Access & security; 12 items to start) with
  OK / Repair, a note for each Repair, photos, comments and a finger signature. Drafts are saved on the phone and queued
  like truck inspections. Each Repair is a **finding** that stays open until a supervisor resolves it with a note: on
  the yard page, the walk, and the top of the repairs board. Supervisors' home screen shows each yard with "Walked
  today" or "Not walked today" and its open findings. A walk is read-only once submitted and has a PDF.
- **Equipment checks (migration 013):** Admin → Equipment keeps the trailers (number, description, plate, notes) and
  the equipment (tag, kind, make, model, serial, trailer, notes). A piece moves by changing its trailer; trailers and
  pieces are retired, never deleted, and every add, edit, move and retirement is kept. The checklist has an "All
  equipment" part plus a part per kind (string trimmer, blower, hedge trimmer, edger, chainsaw, pole saw, mower,
  sprayer, other). The shop or a supervisor checks a trailer at a time: each piece OK / Repair with a note and photos,
  or "Not here". No signature. Every piece is due every 30 days by default (Admin → Equipment changes it). Problems stay
  open (equipment page, repairs board, the check) until someone resolves them with a note.
- **Maintenance log for equipment (migration 014):** on a piece's page, the shop logs work (sharpen blade or chain,
  trimmer line/head, air filter, spark plug, fuel system, oil change, tune-up, repair, other), each type with an
  optional next-due date, plus what was done, parts, cost, who or which outside shop, notes, photos, and which of the
  piece's open problems it fixes. Entries aren't edited: a mistaken one is voided with a reason, which reopens the
  problems it closed.
- **Fleet (migration 015):** a truck's **status** (In service, In the shop, On hold, Preparing for return, Returned,
  Sold, Retired). The shop sets In service / In the shop / On hold; supervisors and admins set any. Returned, Sold and
  Retired take the truck out of the fleet, and Admin → Trucks' Active switch stays in step. Every change, from
  anywhere, is recorded by the database with who, when and an optional note. **Trailers on trucks:** a truck pulls one
  trailer at a time; moves are kept, and the inspection form fills in the truck's trailer. **Reminders** (Menu →
  Reminders and a home-screen card): registrations expired or within 30 days, truck maintenance due or within two weeks
  (date or 500 miles), equipment due for a check or maintenance, the yard walk not done today, and trucks not
  inspected in 35 days.
- **Incident reports (migration 018):** a supervisor files one from the truck page: when and where (with an optional
  GPS location), the driver, police, injuries, damage pinned on the truck's picture, other parties, witnesses, what
  happened, a finger drawing of the scene and a map screenshot, photos, the manager's comments, and driver and manager
  signatures. Only the date, driver, injuries yes/no, what happened and the manager's name and signature are
  required. It works offline like the other forms. Damage pins go on the truck's damage on file and count as open
  repairs until marked repaired or fixed through the maintenance log. Supervisors and admins see new reports on their
  home screen until they open them; only they can see reports and their photos (reports hold the other party's
  details). For privacy the driver's home address, birth date, license number and employee ID are never stored. The
  PDF is one packet: a manager's incident report, a vehicle accident report, the damage diagram, a photograph log,
  any notes added later, and, when our employee was hurt, an injury report and (if they weren't seen by a clinic) a
  refusal-of-treatment form to finish by hand.
- **Trash and Delete forever (migration 020):** see §4a.
- **Dark mode:** the app follows the phone's light or dark setting, and Menu → Appearance picks Auto, Light or Dark
  (kept on the phone). Photos, diagrams, signatures and sketches stay on white, like paper; PDFs don't change.

### Ideas not built yet

- Lease details and a lease-return checklist for trucks, insurance dates, and push notifications to phones.
- A PDF or CSV of equipment checks and equipment maintenance, and hour meters.
- Single sign-on (for example Microsoft Entra ID) for supervisors and admins; pulling vehicles and odometers from a
  telematics API.
