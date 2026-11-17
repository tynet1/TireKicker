# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. On GitHub, open the repository's **Security** tab
and choose **Report a vulnerability** (private vulnerability reporting). Include what you found, how to reproduce it,
and what an attacker could do with it.

You should get a reply within a week. Once a fix is ready, it's released and credited to you if you'd like.

## Supported versions

Only the latest commit on the default branch gets security fixes. Keep your install up to date
([docs/DEPLOY.md §6](docs/DEPLOY.md#6-updating)).

## Running it safely

- Serve it over HTTPS only (a domain in `SITE_ADDRESS`, or a Cloudflare Tunnel).
- Use a long random `POSTGRES_PASSWORD` and a strong admin password, and never commit `.env`.
- Keep the database and uploads private: only Caddy's ports 80/443 should be reachable from the internet.
- Keep nightly backups on a second disk or off the server, and test a restore.
