# Getting started

Your first hour with TireKicker, from an empty install to a crew lead submitting the first inspection. It assumes the
app is already running ([README quick start](../README.md#quick-start-docker-compose), or
[DEPLOY.md](DEPLOY.md) for a real server). Setup is easiest on a computer; everything after that happens on phones.

## The plan

1. [Sign in as the admin](#1-sign-in-as-the-admin)
2. [Brand it](#2-brand-it)
3. [Add your people](#3-add-your-people)
4. [Add your trucks](#4-add-your-trucks)
5. [Give each truck model a diagram](#5-give-each-truck-model-a-diagram)
6. [Review the checklists](#6-review-the-checklists)
7. [Optional: trailers, equipment and yards](#7-optional-trailers-equipment-and-yards)
8. [Put it on the phones](#8-put-it-on-the-phones)
9. [Do a test run](#9-do-a-test-run)
10. [Check your backups](#10-check-your-backups)

## 1. Sign in as the admin

Open the site, tap **Supervisor or admin? Sign in with email**, and use the `ADMIN_EMAIL` and `ADMIN_PASSWORD` from
your `.env`. The first
admin is created on the first start; if the sign-in fails, check `docker compose logs app` for "created admin account".

Everything below is under **Menu → Admin**, which has six tabs: **Users & PINs**, **Trucks**, **Equipment**,
**Checklist**, **Branding** and **Trash**.

## 2. Brand it

**Admin → Branding:** company name, app name (shown in the header; "TireKicker" by default), header color and logo
(PNG or JPEG). The logo and company name also print at the top of every PDF. Phones pick up the new look the next time
they open the app.

## 3. Add your people

**Admin → Users & PINs → Add user.** Pick a role for each person:

| Role | For | Signs in with |
|---|---|---|
| crew (inspections) | crew leads and drivers who inspect trucks | their name + a 4–6 digit PIN |
| shop (maintenance log) | the shop manager or mechanic: maintenance, equipment checks, repairs | name + PIN, or email + password |
| supervisor (sign-off) | supervisors: sign-off, yard walks, incident reports, PDFs and CSVs | email + password (10+ characters) |
| admin (everything) | whoever runs the app | email + password |

Anyone with a PIN shows up in the name list on the sign-in screen, so give PINs only to people who sign in that way.
Crew stay signed in for about 30 days. Lockouts are automatic after 5 wrong tries; setting a new PIN or password here
unlocks the person right away. People who leave are switched off, not deleted, so their past inspections keep their
name.

You can also add users from the server: `docker compose exec app node src/cli/user.ts add --name "Jane Doe" --role crew --pin 4821`.

## 4. Add your trucks

Two ways:

- **One at a time:** **Admin → Trucks → Add truck**. Truck ID (your fleet number, e.g. T101) is the only required
  field; add unit, VIN, plate, year/make/model and the registration expiration date if you have them. The VIN must be
  17 characters.
- **The whole fleet at once:** copy `seed/vehicles.example.csv` to `seed/vehicles.csv`, replace the sample rows with
  your trucks (same columns; `diagram` and `trailer` name a truck diagram and a trailer type), then rebuild:
  `docker compose up -d --build app`. On every start the app adds trucks from that file that it doesn't have yet,
  matched by Truck ID; it never changes a truck that already exists, so later edits made in Admin are safe. The file
  is gitignored, so your VINs and plates stay out of git.

Check every truck once in **Admin → Trucks**: set its **Trailer type**, or **No trailer** if it doesn't normally pull one
(the inspection form turns the trailer section on for trucks that do), and its registration date (the app warns 30
days before it expires).

Trucks are never deleted. A truck that leaves the fleet gets a status on its truck page (Returned, Sold or Retired); a
truck added by mistake can be retired and then moved to the trash.

## 5. Give each truck model a diagram

Crews tap on the truck picture to mark damage, so the picture should look like the truck. Three generic drawings come
with the app: a pickup, a dump truck and a utility trailer. To use your own:

1. Make one image per model: the truck from the left, right, front, rear and top on one picture, like the bundled
   ones in `public/diagrams/`. A JPEG or PNG about 1200 px wide works well. The manufacturer's spec sheets or a
   vehicle-template service are good sources (check you're allowed to use the art).
2. **Admin → Trucks →** pick a truck → **Damage diagram → Add a truck diagram**, name it (e.g. "2026 F-250 8 ft bed")
   and upload. The same screen has **Add a trailer type** for trailer pictures.
3. Choose that diagram on every truck of the same model.

Changing a truck's diagram later is safe: old inspections keep the picture their pins were drawn on.

## 6. Review the checklists

**Admin → Checklist** has three checklists: **Truck inspection** (Exterior 16, Interior 16, Trailer & crew 17 items),
**Yard walk** (12 fire-safety items) and **Equipment** (items for all equipment plus a part per kind). Add, reword,
reorder or retire items to match how you work. Changes apply to new inspections only: submitted ones keep the wording
they had, and a form already open on a phone still sends.

## 7. Optional: trailers, equipment and yards

Skip what you don't use; nothing else depends on it.

- **Trailers and equipment:** **Admin → Equipment** keeps your trailers (number, plate) and the tagged equipment on them
  (tag, kind, make, model, serial). The shop or a supervisor then checks a trailer at a time under **Menu → Equipment
  checks**. Each piece is due every 30 days; change that at the top of the Equipment tab. To put a trailer on a truck,
  use **Trailer → Change** on the truck's page.
- **Yards:** the app comes with one yard, "Main yard", for the daily fire-safety walk (**Menu → Yard walks**). There's
  no Admin screen for yards yet. To rename it or add another, run SQL against the database, for example:

  ```bash
  docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE yards SET code = '\''NORTH'\'', name = '\''North yard'\'' WHERE code = '\''MAIN'\''"'
  docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO yards (code, name) VALUES ('\''SOUTH'\'', '\''South yard'\'')"'
  ```

  Yards can't be deleted. One you don't use can be switched off with `UPDATE yards SET active = false WHERE code = '…'`.

## 8. Put it on the phones

The offline features need HTTPS (a domain in `SITE_ADDRESS`, or a Cloudflare Tunnel; see [DEPLOY.md](DEPLOY.md)).

- **iPhone:** open the site in Safari → **Share → Add to Home Screen**. Use the app from the home-screen icon: Safari
  may clear a website's saved data after a week without a visit, but not an app added to the home screen.
- **Android:** open the site in Chrome → **⋮ → Add to Home screen** (or **Install app**).

Each person signs in once on their phone. On a shared phone, sign out from the menu; it won't let you while work is
still waiting to upload.

## 9. Do a test run

Before rollout, walk through it with a test truck (add one called TEST, say) and a test crew user:

1. As crew: open the truck, **Start inspection**, answer the checklist, mark a Repair with a note, drop a damage pin,
   add a photo and sign. Turn on airplane mode before **Save**: it says "Saved on phone, not yet uploaded", and sends
   itself when signal returns.
2. As a supervisor: open the inspection, **Sign off**, then **Export PDF** and check it looks right with your logo.
3. As the shop: on the truck page, use **Log fix** on the repair and save a maintenance entry; the repair closes.
4. Look at **Menu → Repairs board** and **Menu → Reminders**.
5. Clean up as an admin: delete the test inspection and maintenance entry, retire the TEST truck and move it to the
   trash. After 7 days, **Admin → Trash** can delete them forever.

## 10. Check your backups

Backups run every night. Take one now and make sure it lands where you expect:

```bash
docker compose exec backup /bin/sh /backup.sh
ls -lh backups/        # or your BACKUP_DIR
```

Point `BACKUP_DIR` at a second disk or network share, or copy the files off the server regularly, and try a restore
into a test copy once ([DEPLOY.md §5](DEPLOY.md#5-backups)).

## Where to next

- [SPEC.md](../SPEC.md): how every screen and rule works, including the data-safety rules (§4a).
- [DEPLOY.md](DEPLOY.md): HTTPS, the Cloudflare Tunnel, firewall, updates and troubleshooting.
- Questions or problems: open an issue on GitHub. Security problems: see [SECURITY.md](../SECURITY.md).
