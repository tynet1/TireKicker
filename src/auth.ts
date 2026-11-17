import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { one, q } from "./db.ts";
import { HttpError } from "./http.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export type Role = "crew" | "shop" | "supervisor" | "admin";
export interface SessionUser {
  id: number;
  name: string;
  email: string | null;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionId: string | null;
  }
}

export const COOKIE = "gc_session";
// The shop manager ranks with crew; the extra things a shop user can do are granted per route (requireRole's `also`).
const RANK: Record<Role, number> = { crew: 1, shop: 1, supervisor: 2, admin: 3 };
const SCRYPT = { N: 16384, r: 8, p: 1 };

// ---------- Secrets (PINs and passwords) ----------

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(secret, salt, 32, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifySecret(secret: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    // Burn similar time so a missing account isn't distinguishable by timing.
    await scrypt(secret, randomBytes(16), 32, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
    return false;
  }
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(secret, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

export const PIN_RE = /^\d{4,6}$/;
export function checkPassword(pw: string): string | null {
  if (pw.length < 10) return "Password must be at least 10 characters.";
  if (pw.length > 200) return "Password is too long.";
  return null;
}

// ---------- Lockout ----------

function waitText(mins: number): string {
  if (mins > 90) return `${Math.round(mins / 60)} hours`;
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}
const minsUntil = (t: Date) => Math.max(1, Math.ceil((t.getTime() - Date.now()) / 60000));

/**
 * Count a sign-in try against the account before the PIN or password is checked, so guesses sent in parallel
 * can't slip past the lockout. Throws 429 while the account is locked. Returns the try's number in the run.
 */
export async function beginAttempt(userId: number): Promise<number> {
  const r = await one<{ failed_logins: number; locked_until: Date | null }>(
    `UPDATE users SET failed_logins = CASE WHEN locked_until > now() THEN failed_logins ELSE failed_logins + 1 END
      WHERE id = $1
      RETURNING failed_logins, locked_until`,
    [userId],
  );
  if (!r) return 0;
  const locked = (until: Date) =>
    new HttpError(429, `Too many wrong tries. Try again in ${waitText(minsUntil(until))}, or ask a supervisor.`);
  if (r.locked_until && r.locked_until > new Date()) throw locked(r.locked_until);
  if (r.failed_logins > config.lockout.maxFailures) {
    // More tries arrived at once than the account allows (only guessing does that): lock it without checking this one.
    await recordFailure(userId, r.failed_logins);
    const now = await one<{ locked_until: Date }>(`SELECT locked_until FROM users WHERE id = $1`, [userId]);
    throw locked(now?.locked_until ?? new Date(Date.now() + 60000));
  }
  return r.failed_logins;
}

/**
 * The try numbered `attempt` was wrong. The last allowed one locks the account: 15 minutes, doubling with each
 * lockout in the same 24 hours. Returns the lockout's length in minutes, or null if not locked.
 */
export async function recordFailure(userId: number, attempt: number): Promise<number | null> {
  if (attempt < config.lockout.maxFailures) return null;
  const r = await one<{ mins: number }>(
    `UPDATE users SET
       failed_logins  = 0,
       lockouts       = CASE WHEN last_locked_at > now() - interval '24 hours' THEN lockouts + 1 ELSE 1 END,
       last_locked_at = now(),
       locked_until   = now() + make_interval(mins => LEAST($2 * power(2, LEAST(
                          CASE WHEN last_locked_at > now() - interval '24 hours' THEN lockouts ELSE 0 END, 10)), $3)::int)
     WHERE id = $1
     RETURNING round(extract(epoch FROM locked_until - now()) / 60)::int AS mins`,
    [userId, config.lockout.minutes, config.lockout.maxMinutes],
  );
  return r?.mins ?? null;
}

// ---------- Client address ----------

// Cloudflare's published ranges (cloudflare.com/ips-v4 and /ips-v6, checked 2026-11-17).
const CLOUDFLARE_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];
const cloudflare = new BlockList();
for (const r of CLOUDFLARE_RANGES) {
  const [net, bits] = r.split("/");
  cloudflare.addSubnet(net, Number(bits), net.includes(":") ? "ipv6" : "ipv4");
}

/**
 * The phone's address, for the sign-in limits. req.ip is the first address past our own proxies (config.trustProxy).
 * When that is Cloudflare's (the domain is proxied through Cloudflare), the phone's address is the CF-Connecting-IP
 * header Cloudflare sets. The header is ignored from anyone else, so going around Cloudflare straight to the server
 * can't fake it.
 */
export function clientAddress(req: FastifyRequest): string {
  const ip = req.ip.replace(/^::ffff:(?=\d+\.)/i, "");
  const family = isIP(ip);
  const header = req.headers["cf-connecting-ip"];
  const claimed = typeof header === "string" ? header.trim() : "";
  if (family && isIP(claimed) && cloudflare.check(ip, family === 6 ? "ipv6" : "ipv4")) return claimed;
  return ip;
}

// ---------- Wrong sign-ins per network ----------

/**
 * What the per-network limit counts by: the IPv4 address, or the /64 for IPv6 (one phone or home gets a whole /64,
 * so counting single IPv6 addresses would be easy to dodge).
 */
export function addressKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(":")) return ip;
  const addr = ip.split("%")[0].toLowerCase();
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/**
 * Wrong PINs and passwords from one network across all accounts, over a sliding window. Kept in memory: there is one
 * app process, and a restart only forgets the count. A yard's crew share one address on its Wi-Fi, so someone's own
 * typos stop counting once they get in.
 */
export class AddressFailures {
  private hits = new Map<string, { at: number; user: number }[]>();
  private windowMs(): number {
    return config.lockout.addressWindowMinutes * 60000;
  }
  private recent(key: string): { at: number; user: number }[] {
    const since = Date.now() - this.windowMs();
    const list = (this.hits.get(key) ?? []).filter((h) => h.at > since);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }
  /** Throws 429 if this network has had too many wrong tries lately. */
  check(ip: string): void {
    const list = this.recent(addressKey(ip));
    if (list.length >= config.lockout.addressMaxFailures) {
      const mins = Math.max(1, Math.ceil((list[0].at + this.windowMs() - Date.now()) / 60000));
      throw new HttpError(429, `Too many wrong sign-ins from this network. Try again in ${waitText(mins)}.`);
    }
  }
  /** Returns true when this wrong try used up the network's allowance. */
  record(ip: string, userId: number): boolean {
    const key = addressKey(ip);
    const list = this.recent(key);
    list.push({ at: Date.now(), user: userId });
    this.hits.set(key, list);
    if (this.hits.size > 20000) {
      for (const k of this.hits.keys()) this.recent(k);
      while (this.hits.size > 20000) this.hits.delete(this.hits.keys().next().value as string);
    }
    return list.length === config.lockout.addressMaxFailures;
  }
  /** A right PIN or password: that person's own wrong tries from this network stop counting. */
  forgive(ip: string, userId: number): void {
    const key = addressKey(ip);
    const list = this.recent(key).filter((h) => h.user !== userId);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
  }
}

// ---------- Sessions ----------

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function cookieSecure(req: FastifyRequest): boolean {
  if (config.cookieSecure === "true") return true;
  if (config.cookieSecure === "false") return false;
  return req.protocol === "https";
}

export async function startSession(req: FastifyRequest, reply: FastifyReply, user: { id: number; role: Role }): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const days = user.role === "crew" ? config.session.crewDays : config.session.staffDays;
  await q(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [sha256(token), user.id, days, String(req.headers["user-agent"] ?? "").slice(0, 300)],
  );
  await q(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(req),
    maxAge: days * 86400,
  });
}

export async function endSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.sessionId) await q(`DELETE FROM sessions WHERE id = $1`, [req.sessionId]);
  reply.clearCookie(COOKIE, { path: "/" });
}

/** onRequest hook: attach req.user from the session cookie. Sliding expiry, refreshed at most hourly. */
export async function loadSession(req: FastifyRequest): Promise<void> {
  req.user = null;
  req.sessionId = null;
  const token = req.cookies?.[COOKIE];
  if (!token || token.length > 100) return;
  const id = sha256(token);
  const row = await one<SessionUser & { refresh: boolean }>(
    `SELECT u.id, u.name, u.email, u.role, (s.last_seen_at < now() - interval '1 hour') AS refresh
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.active`,
    [id],
  );
  if (!row) return;
  if (row.refresh) {
    const days = row.role === "crew" ? config.session.crewDays : config.session.staffDays;
    await q(`UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2) WHERE id = $1`, [id, days]);
  }
  req.user = { id: row.id, name: row.name, email: row.email, role: row.role };
  req.sessionId = id;
}

// ---------- Guards ----------

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, "Please sign in.");
  return req.user;
}

/** `role` or higher may pass, plus any role listed in `also` (e.g. requireRole("supervisor", "shop")). */
export function requireRole(role: Role, ...also: Role[]) {
  return async (req: FastifyRequest) => {
    const u = requireUser(req);
    if (RANK[u.role] < RANK[role] && !also.includes(u.role)) {
      throw new HttpError(403, `Only a ${[role, ...also].join(" or ")} can do that.`);
    }
  };
}

export const atLeast = (u: SessionUser | null, role: Role) => !!u && RANK[u.role] >= RANK[role];
