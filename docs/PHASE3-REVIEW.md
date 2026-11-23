# Hardening review: code, performance, burn-in, data safety (November 2026)

A full code review, a performance check with years of data, a burn-in test (many phones with bad
signal for an hour, proving nothing is lost or duplicated) and a data-loss review against SPEC §4a. Everything ran
against throwaway databases, never real data.

## Summary

- **Burn-in:** **passed.** In one hour, 30 phones sent 9,897 records with 14,189 photos through a connection that
  refused, stalled or cut 11,483 requests. Meanwhile the app was killed 7 times and the database restarted 3 times.
  Every record arrived exactly once and complete, with every photo attached and its file intact. Nothing was refused,
  nothing was left unsent, and the app never stopped on its own.
- **Performance:** with five years of data (50,856 inspections, 1.6 million checklist answers), four screens took
  0.7–3.7 s. Every screen now answers in under 0.1 s. The exceptions are a full five-year inspections CSV (4 MB,
  about 2.5 s) and PDFs (about 0.8 s, Chromium).
- **Data safety:** §4a holds. The review found 8 gaps, all rare edge cases, and all are fixed. In two of them a
  signature or photo file could be lost. In three, a save could get stuck on a phone. The others are a phone cache
  that could grow until the browser clears the app's storage, trucks/users/pictures that could still be deleted by
  hand in the database, and helper processes piling up in the app container.
- 118 tests pass (6 new). Two migrations: 016 (indexes and a faster truck list) and 017 (delete guards).

## Burn-in test

`scripts/burnin.ts` starts the app against an empty throwaway database and puts a deliberately bad connection in front
of it. That connection refuses 12% of connections (no signal), stalls 15% for 0.5–4.5 s (weak signal), and cuts 10%
after the request reached the app. A cut means the app saved the record, the phone never heard back, and the retry
must not make a second copy.

Simulated phones then do a day's work: crews submit truck inspections, two supervisors submit yard walks and
inspections, and two shop phones submit equipment checks, truck maintenance and equipment maintenance. Records carry
photos (15–55 KB each) and signatures, and some include repairs, damage pins and "not here" pieces. Each phone works
like the real outbox: photos first, then the record, retrying with the same `client_id` until the server confirms it.
Phones also go offline for a while and send several saved records at once.

During the run, the app is killed hard (SIGKILL) every few minutes and restarted. Every third time, the Postgres
container is restarted instead. At the end the signal comes back for good, every phone sends what it still has, and
the script checks the database and the upload folder:

- every record a phone made exists **exactly once** (by `client_id`), and no record exists that no phone made;
- every record has all its checklist answers and all its photos;
- every photo a phone took is attached to its record, and its file on disk is byte-for-byte what the phone sent;
- the app never stopped on its own (only the planned crashes).

```bash
node scripts/burnin.ts --db postgres://gc:gctest@localhost:54331/gc_burn --minutes 60 --phones 30 \
  --crash-every 5 --pg-container gc-burn-pg
```

Exit code 0 means nothing was lost, duplicated or left incomplete. It needs an empty database (it creates its own users,
trailers and equipment). The app restarts during the run picked up the fixes below, so they were burned in too.

### Results

Run on 2026-11-18, 15:51–16:52 UTC: 30 phones (26 crew, 2 supervisors, 2 shop) for 60 minutes, a crash about every
5 minutes. Result: **exit 0, no problems.**

| | |
|---|---|
| Records made on the phones | 9,897: 8,873 truck inspections, 334 yard walks, 219 equipment checks, 247 truck maintenance entries, 224 equipment maintenance entries |
| Records in the database | 9,897, each exactly once, none extra, every checklist answer there |
| Photos | 14,189 taken, 14,189 attached to the right record, every file byte-for-byte what the phone sent |
| Bad connection | 3,691 connections refused, 4,729 stalled, 3,063 cut after the app got the request (19,732 went through normally) |
| Retries | 7,082 (at most 8 tries for one record) |
| App killed / database restarted | 7 / 3 |
| Refused by the server, or still waiting at the end | 0 / 0 |
| App stopped on its own | never |
| Errors in the app log | 16, all "database connection lost" during the 3 planned database restarts |

## Performance check

Five years of made-up data in a throwaway database: every truck inspected every weekday (50,856 inspections,
1,627,392 answers, 2% repairs, most fixed), damage on 10%, a photo on each, monthly maintenance and daily yard walks
(330 MB). Times are the median of three requests through the app.

| Screen / request | Before | After |
|---|---|---|
| Yard findings (`/yard-findings`) | 3,691 ms | 15 ms |
| Repairs CSV | 3,035 ms | 43 ms |
| Repairs board (`/repairs`) | 2,352 ms | 37 ms |
| Reminders | 668 ms | 25 ms |
| Trucks CSV | 340 ms | 56 ms |
| Truck list / home screen (`/vehicles`) | 156 ms | 28 ms |
| Truck page (`/vehicles/:id`) | 73 ms | 66 ms |
| Inspections CSV, one year (2 MB) | 937 ms | 631 ms |
| Inspections CSV, five years (4 MB) | 2,460 ms | about 2,500 ms |
| Inspection PDF | 725 ms | about 800 ms (Chromium) |

Everything else (forms, lists, detail screens, admin) was already under 90 ms. Causes and fixes:

- **No index for a repair's photos.** The repairs board, repairs CSV and yard findings look up each open problem's
  photos by checklist answer, which read all 50,000 photos per problem. Migration 016 adds indexes for photos by
  checklist answer (truck, yard, equipment) and by damage mark.
- **PostgreSQL's JIT compiler.** It spent 0.65 s compiling the reminders query for a few milliseconds of work. The
  app's queries are all small, so the app turns JIT off for its own connections (`src/db.ts`).
- **Open repair counts.** The truck list counted each truck's open repairs by walking all of its inspections. It now
  counts from the open repairs themselves (`vehicle_status` view, migration 016; same columns, same numbers, and a
  test compares them). The Trucks CSV does the same.

## Data-loss review against SPEC §4a

| §4a rule | Checked how | Result |
|---|---|---|
| Nothing hard-deleted from the app | Every `DELETE` in `src/`: only sessions and never-attached photos older than a week | Holds |
| Database refuses deletes of records | Listed every table without a delete guard | **Gap:** trucks, users and diagrams could be deleted by hand. Fixed (017) |
| Submitted records read-only | Update triggers on every record table; existing tests | Holds |
| Phone keeps a draft until confirmed; idempotent submits; retries | Read all five outboxes (inspections, maintenance, yard, equipment, equipment maintenance); burn-in | Holds; **gaps** in 3 edge cases (below), fixed |
| Files written safely | `storage.ts` | **Gap:** the folder wasn't flushed after the rename. Fixed |
| Migrations additive, one transaction each | `migrate.ts`, all migrations | Holds |
| Photos protected once attached; one list of photo owners | DB functions `photos_guard` / `photos_no_erase` checked against `PHOTO_OWNERS` | Holds (all 7 owners) |
| Backups nightly to a second location, restore tested | `scripts/backup.sh`, `restore.sh` | Backups are nightly and safe; whether they reach a second location depends on where `BACKUP_DIR` points (see docs/DEPLOY.md §5) |
| Survives the database restarting | Burn-in restarts Postgres under load | Holds |
| Uploads pause before the disk fills | `photos.ts` | Holds |

### Gaps found and fixed

1. **A signature file could be deleted under a saved record.** If the connection dropped just after the database
   committed an inspection or yard walk but before it said so, the app treated the save as failed and deleted the
   signature file it had just written, though the saved record pointed at it. The same applied to a new logo. Such
   files are now removed only when the database confirms nothing points at them, and kept if it can't be asked
   (`discardUnlessUsed`).
2. **A re-sent photo's file could be deleted.** Photo files were named after the photo id. A photo whose first upload
   was cleaned up after a week, then sent again in the same month, landed on the same file name. If that happened
   while the clean-up was running, the clean-up could delete the new file. Every upload now gets its own file name.
3. **Shared phones: queued work could get stuck.** A photo uploaded while one person was signed in was refused
   ("Photo id already used") when the same phone sent it after someone else signed in. That happens after a session
   ends with work queued, or when the next person finishes a draft the first one started. The save went back to
   editing, and its photos couldn't be added again. Now a photo already uploaded from the phone can be sent by
   whoever is signed in. Photo ids are random and known only to the phone that took the photo, and an attached photo
   still can't move to another record.
4. **A photo cleaned up mid-save stopped the save.** If the week-old clean-up removed a photo while a save using it was
   on its way, the save was refused with "attached to another inspection". It now answers "photo missing", so the
   phone uploads it again by itself.
5. **The phone's cache had no limit.** The phone kept every photo and screen it ever loaded for offline use. On a busy
   supervisor phone that grows for years, and a browser short on space may clear everything the site stores, unsent
   drafts included. The cache now keeps the newest 400 items, and CSV downloads aren't cached.
6. **Trucks, users and truck pictures could be deleted by hand in the database** (the app never does). The database
   now refuses, as it does for everything else (017).
7. **The folder wasn't flushed after a file was written.** On Linux a power cut right after a save could lose the new
   file's name. The folder is now flushed too.
8. **Helper processes piled up in the app container.** Node ran as process 1, which doesn't clean up the exited
   processes Chromium leaves after PDFs. `init: true` in `docker-compose.yml` adds a small init process that does.

The database connection pool also gives up after 10 s instead of waiting forever, and rolls back a transaction left
idle for a minute, so one stuck request can't hold locks.

### Noted, not changed

- **Backups on the same disk as the data** don't survive losing that disk. Point `BACKUP_DIR` at a second disk or
  network share, or copy `backups/` off the server regularly.
- **Phones should use the app from the home screen.** On iPhones, Safari may clear a website's storage after 7 days
  without a visit; an app added to the home screen is exempt. Drafts survive normal use either way, and the app asks
  the browser to keep its storage.
- **Retrying an edit to a maintenance entry** after the answer was lost says "Someone changed this entry". The edit
  was saved, and reloading shows it. Rare (edits are made online), and nothing is lost.
- **Fastify warning:** `disableRequestLogging` is deprecated and goes away in Fastify 6. The app pins Fastify 5, so
  this only matters when upgrading.
- **A missing photo file** answers 500 instead of 404. It only happens if files are lost outside the app.

## Code review notes

The review read the server's core (`db`, `http`, `auth`, `server`, `storage`, `migrate`), every save route, the five
phone outboxes, the IndexedDB layer, the API client, the service worker and the Docker setup. Beyond the fixes above,
it confirmed these hold:

- every save that returns 201 has committed;
- every retry is answered from the existing record;
- concurrent duplicates are handled with `ON CONFLICT DO NOTHING` plus a re-read;
- sign-out is refused while work is queued;
- a rejected save goes back to editing with nothing lost.
