import type { FastifyInstance, FastifyRequest } from "fastify";
import { AddressFailures, beginAttempt, clientAddress, endSession, PIN_RE, recordFailure, requireUser, startSession, verifySecret } from "../auth.ts";
import type { Role } from "../auth.ts";
import { one, q } from "../db.ts";
import { bad, HttpError, obj } from "../http.ts";

interface LoginRow {
  id: number;
  name: string;
  email: string | null;
  role: Role;
  pin_hash: string | null;
  password_hash: string | null;
}

const authLimit = { rateLimit: { max: 15, timeWindow: "1 minute" } };

export default async function authRoutes(app: FastifyInstance) {
  const network = new AddressFailures();

  /** Check a PIN or password with the account lockout and the per-network limit around it. */
  async function check(req: FastifyRequest, u: LoginRow | undefined, secret: string, stored: string | null): Promise<boolean> {
    const ip = clientAddress(req);
    network.check(ip);
    const attempt = u ? await beginAttempt(u.id) : 0;
    // Takes the same time when there's no such account or it has no PIN/password.
    if ((await verifySecret(secret, stored)) && u) {
      network.forgive(ip, u.id);
      return true;
    }
    if (network.record(ip, u?.id ?? 0)) req.log.warn({ ip }, "sign-in: too many wrong tries from one network");
    if (u) {
      const mins = await recordFailure(u.id, attempt);
      if (mins) req.log.warn({ user: u.id, ip, minutes: mins }, "sign-in: account locked after wrong tries");
    }
    return false;
  }

  // Names for the crew sign-in picker (anyone with a PIN).
  app.get("/auth/crew", async () =>
    q(`SELECT id, name FROM users WHERE active AND pin_hash IS NOT NULL ORDER BY lower(name)`));

  app.post("/auth/pin", { config: authLimit }, async (req, reply) => {
    const b = obj(req.body);
    const userId = Number(b.user_id);
    const pin = b.pin;
    if (!Number.isInteger(userId) || typeof pin !== "string" || !PIN_RE.test(pin)) {
      throw bad("Pick your name and enter your 4–6 digit PIN.");
    }
    const u = await one<LoginRow>(`SELECT * FROM users WHERE id = $1 AND active`, [userId]);
    if (!(await check(req, u, pin, u?.pin_hash ?? null)) || !u) {
      throw new HttpError(401, "That PIN didn't match. Try again.");
    }
    await startSession(req, reply, u);
    return { id: u.id, name: u.name, email: u.email, role: u.role };
  });

  app.post("/auth/login", { config: authLimit }, async (req, reply) => {
    const b = obj(req.body);
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    if (!email || !password) throw bad("Enter your email and password.");
    const u = await one<LoginRow>(`SELECT * FROM users WHERE lower(email) = $1 AND active`, [email]);
    if (!(await check(req, u, password, u?.password_hash ?? null)) || !u) {
      throw new HttpError(401, "Email or password is wrong.");
    }
    await startSession(req, reply, u);
    return { id: u.id, name: u.name, email: u.email, role: u.role };
  });

  app.post("/auth/logout", async (req, reply) => {
    await endSession(req, reply);
    return { ok: true };
  });

  app.get("/me", async (req) => requireUser(req));
}
