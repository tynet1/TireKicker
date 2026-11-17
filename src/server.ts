import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyError, FastifyInstance } from "fastify";
import { addressKey, clientAddress, loadSession } from "./auth.ts";
import { config } from "./config.ts";
import { pool, q } from "./db.ts";
import { HttpError } from "./http.ts";
import { migrate } from "./migrate.ts";
import { closePdfBrowser } from "./pdf.ts";
import adminRoutes from "./routes/admin.ts";
import exportRoutes from "./routes/export.ts";
import ticketRoutes from "./routes/tickets.ts";
import checklistRoutes from "./routes/checklist.ts";
import authRoutes from "./routes/auth.ts";
import brandingRoutes from "./routes/branding.ts";
import inspectionRoutes from "./routes/inspections.ts";
import photoRoutes, { cleanupOrphanPhotos } from "./routes/photos.ts";
import serviceRoutes from "./routes/service.ts";
import vehicleRoutes from "./routes/vehicles.ts";
import { ensureAdmin, seedVehicles } from "./seed.ts";

const CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Hash of everything in public/, so the service worker cache updates whenever the app changes. */
async function buildVersion(): Promise<string> {
  const h = createHash("sha256");
  async function walk(dir: string) {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else h.update(relative(config.publicDir, p)).update(String((await stat(p)).size)).update(await readFile(p));
    }
  }
  await walk(config.publicDir);
  return h.digest("hex").slice(0, 12);
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    disableRequestLogging: config.logLevel !== "debug",
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(multipart);
  await app.register(rateLimit, {
    global: false,
    // The phone's real address: CF-Connecting-IP only when the request really came through Cloudflare (clientAddress).
    keyGenerator: (req) => addressKey(clientAddress(req)),
  });

  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api/")) {
      // CSRF: state-changing API calls must carry a header a cross-site form can't set.
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-gc-app"] !== "1") {
        return reply.code(403).send({ error: "Forbidden", message: "Missing app header." });
      }
      await loadSession(req);
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("x-frame-options", "DENY");
    reply.header("content-security-policy", CSP);
    reply.header("permissions-policy", "geolocation=(), microphone=()");
    // Over HTTPS, phones remember to never use plain http for this site (a year, renewed on every visit).
    if (req.protocol === "https") reply.header("strict-transport-security", "max-age=31536000");
    if (req.url.startsWith("/api/") && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    return payload;
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    const status = err.statusCode ?? 500;
    // An HttpError is a deliberate answer (e.g. 503 "disk nearly full"), so its message is meant for the phone.
    const meant = err instanceof HttpError;
    if (status >= 500 && !meant) req.log.error(err);
    const details = meant ? err.details : undefined;
    const message = status >= 500 && !meant ? "Something went wrong on the server. Try again." : err.message;
    return reply.code(status).send({ error: status, message, ...(details ? { details } : {}) });
  });

  app.get("/healthz", async () => {
    await q("SELECT 1");
    return { ok: true };
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(brandingRoutes);
      await api.register(vehicleRoutes);
      await api.register(photoRoutes);
      await api.register(inspectionRoutes);
      await api.register(serviceRoutes);
      await api.register(adminRoutes);
      await api.register(exportRoutes);
      await api.register(ticketRoutes);
      await api.register(checklistRoutes);
      api.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 404, message: "Not found." }));
    },
    { prefix: "/api" },
  );

  // Service worker: served with the current build version baked in, never cached by the browser.
  const version = await buildVersion();
  const swSource = (await readFile(join(config.publicDir, "sw.js"), "utf8")).replace("__BUILD_VERSION__", version);
  app.get("/sw.js", async (_req, reply) =>
    reply.type("text/javascript").header("cache-control", "no-cache").header("service-worker-allowed", "/").send(swSource));

  await app.register(fastifyStatic, {
    root: config.publicDir,
    index: ["index.html"],
    setHeaders: (res, path) => {
      if (path.endsWith(".html")) res.header("cache-control", "no-cache");
      else res.header("cache-control", "public, max-age=300");
    },
  });

  return app;
}

async function main() {
  const app = await buildApp();
  const log = (m: string) => app.log.info(m);
  await migrate(log);
  await ensureAdmin(log);
  await seedVehicles(log);

  const housekeeping = async () => {
    try {
      await cleanupOrphanPhotos(log);
      await q(`DELETE FROM sessions WHERE expires_at < now()`);
    } catch (e) {
      app.log.error(e, "housekeeping failed");
    }
  };
  void housekeeping();
  const timer = setInterval(housekeeping, 6 * 3600_000);
  timer.unref();

  const shutdown = async (sig: string) => {
    app.log.info(`${sig} received, shutting down`);
    await app.close();
    await closePdfBrowser();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
