# Changelog

Every release of TireKicker, newest first. Versions follow [semantic versioning](https://semver.org/): while the major
version is 0, a minor bump (0.2 → 0.3) can add migrations and features; a patch bump (0.2.0 → 0.2.1) only fixes
things.

**Before updating, always take a backup** ([docs/DEPLOY.md §6](docs/DEPLOY.md#6-updating)). Database migrations run
by themselves when the new version starts and can't be undone by going back to an older version; restore the backup
instead.

## [0.2.0] - 2026-11-23

Migrations 012–020 run on first start.

### Added
- **Yard walks:** a daily fire-safety walk of a yard on its own checklist, with OK / Repair, notes, photos, a
  signature and a PDF; findings stay open until resolved (012).
- **Equipment checks** for trailers and tagged equipment, each piece on its kind's checklist, due every 30 days by
  default (013), and a **maintenance log for equipment** (014).
- **Fleet:** truck status with history, trailers on trucks, and a reminders list (015).
- **Incident reports** filed from the phone, printed as one PDF packet; their damage goes on the truck's record (018)
  and can go on a repair ticket when someone ticks it (019).
- **Trash and Delete forever:** Delete moves a record to Admin → Trash; after 7 days an admin can erase it, and every
  permanent delete is logged (020).
- **Dark mode** (Menu → Appearance: Auto, Light or Dark).
- A burn-in test (`scripts/burnin.ts`) and the hardening review in `docs/PHASE3-REVIEW.md`.
- `docs/GETTING-STARTED.md`: the first hour after installing.
- Release images on GitHub's container registry, `compose.release.yml` to run them, and CI that runs the full test
  suite against Postgres.

### Changed
- Faster truck list and indexes for years of data (016); trucks, users and diagrams can't be deleted in the database
  (017).
- Data-loss fixes from the hardening review: files kept when a save's answer is lost, unique photo file names,
  folders flushed after writes, a size limit on the phone's offline cache, and an init process for the app container.

## [0.1.0] - 2026-11-18

First public release: truck inspections with damage pins, photos and signatures, supervisor sign-off, PDF and CSV
export, the maintenance log, repairs board, repair tickets, registration history, the checklist editor, branding,
and Docker Compose with Caddy and nightly backups.

[0.2.0]: https://github.com/tynet1/TireKicker/releases/tag/v0.2.0
[0.1.0]: https://github.com/tynet1/TireKicker/releases/tag/v0.1.0
