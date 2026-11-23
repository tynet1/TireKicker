# Deploying

Everything runs from `docker compose`: Postgres 16, the app (API + web app + Chromium for PDFs), Caddy in front,
a nightly backup job, and optionally a Cloudflare Tunnel so phones on cellular can reach a server on a private network.

Two common setups:

- **A small cloud VM with a domain** (Ubuntu, any provider): set `SITE_ADDRESS` to the domain and Caddy serves HTTPS
  with a Let's Encrypt certificate. Follow sections 1–3, 5 and 6, and read "Firewall" below.
- **A machine on an office or home network:** leave `SITE_ADDRESS=:80` and add a Cloudflare Tunnel (section 4) for a
  public HTTPS address without opening ports.

## 1. Prepare the server

Ubuntu Server 24.04 with 2 vCPU / 4 GB RAM / 40 GB disk is plenty for a fleet of a few dozen trucks. Install Docker
Engine and the compose plugin (https://docs.docker.com/engine/install/ubuntu/), then let your user run it:

```bash
sudo usermod -aG docker $USER   # log out and back in afterwards
```

## 2. Get the code and configure it

```bash
git clone https://github.com/tynet1/TireKicker.git
cd TireKicker
cp .env.example .env
nano .env
```

In `.env` set at least:

- `POSTGRES_PASSWORD`: long random string (`openssl rand -base64 24`)
- `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (10+ characters): the first admin account, created on first start
- `SITE_ADDRESS`: your domain (for automatic HTTPS), or `:80` behind a Cloudflare Tunnel or for a quick LAN test
- `TZ`: your time zone, e.g. `America/Denver` (PDF and CSV dates use it)
- `BACKUP_DIR`: a folder on a **different disk or a mounted network share** (see section 5)

Optionally load your fleet: copy `seed/vehicles.example.csv` to `seed/vehicles.csv` and replace the sample rows with
your trucks before the first start. Trucks can also be added in **Admin → Trucks**. Trucks are never deleted (only
retired), so don't load the sample rows into a real install.

## 3. Start it

```bash
docker compose up -d --build
docker compose ps                 # all services "running", app "healthy" after ~30s
docker compose logs -f app        # migrations, "created admin account", "added N truck(s)" if you loaded a fleet
```

Open the site (your domain, or `http://<server-ip>/` on the same network) and sign in with the admin email and
password. Then go to **Menu → Admin** and:

1. Set the company name, colors and logo under **Branding**.
2. Add crew users (name + 4–6 digit PIN) and supervisors (email + password).
3. Add trucks and upload a diagram for each model (or use the bundled pickup, dump truck and trailer drawings).
4. Review the checklists under **Checklist**.

[GETTING-STARTED.md](GETTING-STARTED.md) walks through these steps in detail, plus phones, a test run and backups.

Users can also be added from the command line:

```bash
docker compose exec app node src/cli/user.ts add --name "Jane Doe" --role crew --pin 4821
docker compose exec app node src/cli/user.ts list
```

On iPhone, open the site in Safari and use **Share → Add to Home Screen** so crews get an app icon. The offline
features (service worker) need HTTPS.

## 4. Optional: Cloudflare Tunnel

Phones on cellular can't reach a machine on an office or home network. A Cloudflare Tunnel gives it a real HTTPS
address without opening any ports. You need a domain whose DNS is on Cloudflare (the free plan is fine).

1. In the Cloudflare dashboard go to **Zero Trust → Networks → Tunnels → Create a tunnel**, type **Cloudflared**.
2. On the install screen, copy the token (the long string after `--token`) into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. Add a **public hostname**, e.g. `inspect.example.com`, service type **HTTP**, URL **`caddy:80`**.
4. Start the tunnel:

   ```bash
   docker compose --profile tunnel up -d
   ```

5. Open `https://inspect.example.com` on a phone.

Optional later: put **Cloudflare Access** in front of the hostname to require a company email before the sign-in
page even loads.

## 5. Backups

The `backup` service runs every night after `BACKUP_HOUR` (default 2am, local `TZ`) and writes to `BACKUP_DIR`:

- `db_YYYY-MM-DD_HHMMSS.dump`: full database (`pg_dump` custom format)
- `uploads_YYYY-MM-DD_HHMMSS.tar.gz`: all photos, signatures and uploaded diagrams

Files older than `BACKUP_KEEP_DAYS` (default 30) are deleted, but only after a new backup succeeded. That is also how
long a record deleted forever in Admin → Trash can still be found: restoring a backup from before it was deleted brings
it back (with everything else in that backup), and after `BACKUP_KEEP_DAYS` it's gone from the backups too. Point `BACKUP_DIR`
at a second disk or a mounted network share, and copy backups off the server regularly; a backup on the same disk as
the data doesn't survive losing that disk. Each file is written under a temporary name and renamed when complete, an
existing backup is never overwritten, and only one backup runs at a time, so a file with a final name is always a
whole backup.

Take one right now and check it:

```bash
docker compose exec backup /bin/sh /backup.sh
ls -lh backups/        # or your BACKUP_DIR
```

### Restore

```bash
sh scripts/restore.sh backups/db_2026-01-15_020012.dump backups/uploads_2026-01-15_020012.tar.gz
```

It asks you to type `RESTORE`, then:

1. saves the current data as `db_<now>_before-restore.dump` / `uploads_<now>_before-restore.tar.gz`;
2. stops the app, replaces the database and photos, and starts the app again.

Sign in and open a few inspections and their PDFs to confirm. If it was the wrong backup, restore the two
`_before-restore` files the same way to put things back exactly as they were.

To practice a restore without touching the real data, run a second copy of the stack under another name
(it gets its own database, photos and ports), restore into that, then remove it:

```bash
COMPOSE_PROJECT_NAME=tirekicker-test HTTP_PORT=8080 HTTPS_PORT=8443 BACKUP_DIR=./backups-test docker compose up -d --build
COMPOSE_PROJECT_NAME=tirekicker-test BACKUP_DIR=./backups-test sh scripts/restore.sh backups/db_....dump backups/uploads_....tar.gz
COMPOSE_PROJECT_NAME=tirekicker-test BACKUP_DIR=./backups-test docker compose down -v   # -v deletes only tirekicker-test's volumes
```

## 6. Updating

Take a labeled backup first, then pull and rebuild:

```bash
docker compose exec -T backup /bin/sh /backup.sh before-update
git pull --ff-only
nohup sh -c 'docker compose up -d --build app > ~/tirekicker-deploy.log 2>&1; echo EXIT=$? >> ~/tirekicker-deploy.log' &
```

The rebuild takes a few minutes. Running it under `nohup` means a dropped SSH connection can't cancel it halfway;
`tail ~/tirekicker-deploy.log` shows `EXIT=0` when it's done, and `docker compose ps` shows the app `healthy` about 30
seconds later. Until the new container starts, the old one keeps serving. Database migrations run automatically when
the app starts (`docker compose logs app | grep migration`). Phones pick up the new version the next time the app is
opened (the service worker refreshes when the files change).

## Firewall

- Only ports 80 and 443 (and SSH) need to be reachable. Docker's published ports bypass UFW, so use your cloud
  provider's firewall (or the host's `DOCKER-USER` chain) to restrict them.
- If the domain is proxied through Cloudflare, allow 80/443 only from Cloudflare's ranges (cloudflare.com/ips, the same
  list as in `src/auth.ts`), so nobody can reach the server around Cloudflare. Keep 80 open to Cloudflare: Caddy renews
  its certificate through it.
- Allow SSH only from addresses you trust, and keep a console or recovery login from your provider in case you lock
  yourself out.

## Running on Windows (Docker Desktop)

It works for a pilot on a PC: install WSL 2 (`wsl --install --no-distribution` in an admin PowerShell, then restart) and
Docker Desktop, then run the same `docker compose up -d --build`. Turn on **Docker Desktop → Settings → General →
"Start Docker Desktop when you sign in"** and stop Windows from sleeping, or the app goes down with the PC. Run the
scripts from Git Bash (`sh scripts/restore.sh ...`); they handle its path rewriting. Plain `http://` by IP works on the
local network except for the offline app shell and "Share as separate PDFs", which need HTTPS (use a Cloudflare Tunnel).

## Troubleshooting

| Problem | Check |
|---|---|
| App container restarting | `docker compose logs app`; usually a wrong `POSTGRES_PASSWORD` after the database was first created with a different one |
| "No admin account exists" in the logs | Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`, then `docker compose up -d` |
| PDF export fails | `docker compose logs app` around the time of the click; Chromium needs ~300 MB RAM free |
| Phone says "Saved on phone, not yet uploaded" for a long time | Can the phone open the site at all? With a tunnel: `docker compose --profile tunnel ps` |
| Someone is locked out | Admin → Users → set a new PIN or password (unlocks immediately). Otherwise the lock lasts 15 minutes, doubling each time it happens again that day, up to 4 hours |
| "Too many wrong sign-ins from this network" | 20 wrong tries in an hour from one address (e.g. a shared yard Wi-Fi). Wait it out, or sign in on cell data; `docker compose logs app \| grep sign-in` shows the address |
| Photos stay "waiting on this phone" | The daily photo limit (1 GB a person) or a nearly full disk (`df -h /`; uploads pause under 2 GB free). The phones keep the photos and retry |
