# CLAUDE.md: notes for AI coding agents working on TireKicker (and humans)

Read `SPEC.md` first; it describes how the app behaves and why. Then:

- `db/migrations/` holds the schema. Change it only by adding a numbered migration (`012_...sql`); never edit one
  that has shipped. Migrations run automatically when the app starts, each in its own transaction.
- `seed/vehicles.example.csv` shows the columns for loading a fleet. A real `seed/vehicles.csv` is gitignored on
  purpose (it holds VINs and plates).

## Stack and layout

- Node 24 runs the TypeScript in `src/` directly (type stripping), so no build step. Erasable syntax only:
  no enums, namespaces or constructor parameter properties; use `import type` for types; import with `.ts`.
- Fastify API under `/api` (`src/routes/*`); plain SQL via `pg` (`src/db.ts`); no ORM.
- Frontend: plain ES modules in `public/js` (no framework, no bundler). `public/sw.js` lists the app-shell
  files; add new JS/diagram files to `SHELL_FILES` there (a test checks the JS ones).
- Photos/signatures go through `src/storage.ts` (local disk at `UPLOAD_DIR`); keep it behind that interface.
- PDF: `src/pdf.ts` builds the inspection-sheet HTML and prints it with Playwright Chromium.

## Commands

```bash
npm run dev          # local server on :3000 using .env.local
npm run typecheck
TEST_DATABASE_URL=postgres://... npm test   # wipes that database
npm run user -- add --name "X" --role crew --pin 1234
```

## Working rules

- **Never lose data.** Read SPEC §4a before changing anything that stores, moves or deletes data. No hard deletes
  from the app (retire instead), writes are atomic, migrations are additive.
- Phone-first. Test every screen at 390×844 (iPhone) and 820×1180 (iPad). Touch targets at least 44px. Numeric keypad for mileage.
- Expect bad cell signal. Drafts live on the device, uploads retry, and submits are idempotent via `client_id`.
- Submitted inspections are read-only (enforced by database triggers); corrections go in the supervisor note.
  They can't be deleted either: archive/delete lives in `inspection_states` (migration 005). Anything that means "counts for the
  truck" (open repairs, damage on file, last inspection, mileage, lists) reads `live_inspections`, not `inspections`; a
  migration that adds an inspections column must recreate that view if it's needed there.
- Every state-changing `/api` call needs the `x-gc-app: 1` header (CSRF guard); `public/js/api.js` adds it.
- Everything runs with `docker compose up -d`. Secrets go in `.env` (never committed); `.env.example` documents them.
  Local dev settings go in `.env.local` (also gitignored), so they never collide with a server's `.env`.
- Never run the tests or experiments against a database with real data. Use a throwaway Postgres for `npm test`, or a
  second copy of the stack under its own `COMPOSE_PROJECT_NAME` (see docs/DEPLOY.md §5).
