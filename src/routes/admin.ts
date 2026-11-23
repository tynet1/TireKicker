import type { FastifyInstance } from "fastify";
import { checkPassword, hashSecret, PIN_RE, requireRole } from "../auth.ts";
import type { Role } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import { bad, conflict, idParam, int, isValidDate, notFound, obj, reqStr, str } from "../http.ts";
import { isDiagramKind } from "../diagrams.ts";
import { files, imageType, newKey } from "../storage.ts";
import { vehicleRows } from "./vehicles.ts";

const ROLES: Role[] = ["crew", "shop", "supervisor", "admin"];

function pgUnique(e: unknown, msg: string): never {
  if ((e as { code?: string }).code === "23505") throw conflict(msg);
  throw e;
}

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireRole("admin"));

  // ---------- Users ----------
  app.get("/admin/users", async () =>
    q(`SELECT id, name, email, role, active, (pin_hash IS NOT NULL) AS has_pin, (password_hash IS NOT NULL) AS has_password,
              last_login_at, (locked_until > now()) AS locked
         FROM users u WHERE NOT EXISTS (SELECT 1 FROM trash tr WHERE tr.kind = 'user' AND tr.record_id = u.id::text) ORDER BY active DESC, lower(name)`));

  async function userFields(b: Record<string, unknown>, creating: boolean) {
    const out: Record<string, unknown> = {};
    if (creating || b.name !== undefined) out.name = reqStr(b.name, "Name", 100);
    if (creating || b.role !== undefined) {
      if (!ROLES.includes(b.role as Role)) throw bad("Role must be crew, shop, supervisor or admin.");
      out.role = b.role;
    }
    if (b.email !== undefined) {
      const email = str(b.email, "Email", 200)?.toLowerCase() ?? null;
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("That email doesn't look right.");
      out.email = email;
    }
    if (b.pin !== undefined && b.pin !== null && b.pin !== "") {
      if (typeof b.pin !== "string" || !PIN_RE.test(b.pin)) throw bad("PIN must be 4 to 6 digits.");
      out.pin_hash = await hashSecret(b.pin);
    }
    if (b.clear_pin === true) out.pin_hash = null;
    if (b.password !== undefined && b.password !== null && b.password !== "") {
      const err = typeof b.password === "string" ? checkPassword(b.password) : "Password must be text.";
      if (err) throw bad(err);
      out.password_hash = await hashSecret(b.password as string);
    }
    if (b.active !== undefined) out.active = !!b.active;
    return out;
  }

  app.post("/admin/users", async (req, reply) => {
    const f = await userFields(obj(req.body), true);
    if (!f.pin_hash && !f.password_hash) throw bad("Give the user a PIN (crew) or an email and password (supervisor/admin).");
    if (f.password_hash && !f.email) throw bad("An email is needed to sign in with a password.");
    const cols = Object.keys(f);
    try {
      const u = await one(
        `INSERT INTO users (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        Object.values(f),
      );
      return reply.code(201).send(u);
    } catch (e) {
      pgUnique(e, "Another user already has that email.");
    }
  });

  app.patch("/admin/users/:id", async (req) => {
    const id = idParam(req.params);
    const f = await userFields(obj(req.body), false);
    if (await one(`SELECT 1 FROM trash WHERE kind = 'user' AND record_id = $1::text`, [id])) {
      throw conflict("This user is in the trash. Restore them first (Admin → Trash).");
    }
    if (id === req.user!.id && (f.active === false || (f.role && f.role !== "admin"))) {
      throw bad("You can't deactivate yourself or remove your own admin role.");
    }
    if (f.pin_hash !== undefined || f.password_hash !== undefined) {
      f.failed_logins = 0;
      f.locked_until = null;
      f.lockouts = 0;
    }
    const cols = Object.keys(f);
    if (!cols.length) return { ok: true };
    try {
      const r = await one(
        `UPDATE users SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING id, email, password_hash`,
        [id, ...Object.values(f)],
      );
      if (!r) throw notFound("User not found.");
      if (r.password_hash && !r.email) throw bad("An email is needed to sign in with a password.");
    } catch (e) {
      pgUnique(e, "Another user already has that email.");
    }
    if (f.active === false || f.pin_hash !== undefined || f.password_hash !== undefined) {
      await q(`DELETE FROM sessions WHERE user_id = $1`, [id]); // sign them out everywhere
    }
    return { ok: true };
  });

  // ---------- Trucks ----------
  app.get("/admin/vehicles", async () =>
    q(`SELECT v.*, d.name AS diagram_name, td.name AS trailer_type
         FROM vehicles v
         LEFT JOIN diagrams d ON d.id = v.diagram_id
         LEFT JOIN diagrams td ON td.id = v.trailer_diagram_id
        WHERE NOT EXISTS (SELECT 1 FROM trash tr WHERE tr.kind = 'vehicle' AND tr.record_id = v.id::text)
        ORDER BY v.active DESC, v.truck_code`));

  const optId = (v: unknown, label: string) => (v === null || v === "" ? null : int(v, label, 1));

  async function vehicleFields(b: Record<string, unknown>, creating: boolean) {
    const out: Record<string, unknown> = {};
    if (creating || b.truck_code !== undefined) {
      const code = reqStr(b.truck_code, "Truck ID", 20).toUpperCase().replace(/\s+/g, "");
      if (!/^[A-Z0-9_-]{2,20}$/.test(code)) throw bad("Truck ID can only use letters, numbers, - and _.");
      out.truck_code = code;
    }
    for (const [k, label, max] of [["unit", "Unit", 30], ["plate", "Plate", 20], ["make", "Make", 40], ["model", "Model", 80]] as const) {
      if (b[k] !== undefined) out[k] = str(b[k], label, max);
    }
    if (b.vin !== undefined) {
      const vin = str(b.vin, "VIN", 17)?.toUpperCase() ?? null;
      if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw bad("VIN must be 17 letters/numbers (no I, O or Q).");
      out.vin = vin;
    }
    if (b.year !== undefined) out.year = b.year === null || b.year === "" ? null : int(b.year, "Year", 1980, 2100);
    if (b.registration_expires !== undefined) {
      const d = b.registration_expires === null || b.registration_expires === "" ? null : String(b.registration_expires);
      if (d && !isValidDate(d)) throw bad("Registration expiration must be a date.");
      out.registration_expires = d;
    }
    if (b.diagram_id !== undefined) {
      const id = optId(b.diagram_id, "Diagram");
      if (id && !(await isDiagramKind(id, "truck"))) throw bad("Pick a truck diagram from the list.");
      out.diagram_id = id;
    }
    // Trailer: null = no trailer; otherwise the trailer type (a trailer diagram). pulls_trailer follows it.
    if (b.trailer_diagram_id !== undefined) {
      const id = optId(b.trailer_diagram_id, "Trailer type");
      if (id && !(await isDiagramKind(id, "trailer"))) throw bad("Pick a trailer type from the list.");
      out.trailer_diagram_id = id;
      out.pulls_trailer = id != null;
    } else if (b.pulls_trailer !== undefined) {
      out.pulls_trailer = !!b.pulls_trailer;
      if (!out.pulls_trailer) out.trailer_diagram_id = null;
    }
    if (b.active !== undefined) out.active = !!b.active;
    return out;
  }

  app.post("/admin/vehicles", async (req, reply) => {
    const f = await vehicleFields(obj(req.body), true);
    const cols = Object.keys(f);
    try {
      const r = await one(
        `INSERT INTO vehicles (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        Object.values(f),
      );
      return reply.code(201).send(r);
    } catch (e) {
      pgUnique(e, "A truck with that ID or VIN already exists.");
    }
  });

  app.patch("/admin/vehicles/:id", async (req) => {
    const id = idParam(req.params);
    const f = await vehicleFields(obj(req.body), false);
    const cols = Object.keys(f);
    if (!cols.length) return { ok: true };
    try {
      await tx(async (c) => {
        const v = (await c.query(`SELECT registration_expires FROM vehicles WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!v) throw notFound("Truck not found.");
        if ((await c.query(`SELECT 1 FROM trash WHERE kind = 'vehicle' AND record_id = $1::text`, [id])).rowCount) {
          throw conflict("This truck is in the trash. Restore it first (Admin → Trash).");
        }
        if (f.registration_expires !== undefined && f.registration_expires !== v.registration_expires) {
          await c.query(
            `INSERT INTO registration_changes (vehicle_id, previous, expires, changed_by, source) VALUES ($1, $2, $3, $4, 'admin')`,
            [id, v.registration_expires, f.registration_expires, req.user!.id],
          );
        }
        // Switching a truck off or on changes its status (015); the database records who did it.
        await c.query(`SELECT set_config('gc.user_id', $1, true), set_config('gc.note', $2, true)`,
          [String(req.user!.id), f.active === undefined ? "" : "Admin → Trucks"]);
        await c.query(
          `UPDATE vehicles SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
          [id, ...Object.values(f)],
        );
      });
    } catch (e) {
      pgUnique(e, "A truck with that ID or VIN already exists.");
    }
    const [v] = await vehicleRows("WHERE vs.id = $1", [id]);
    return v ?? { ok: true };
  });

  // ---------- Diagrams ----------
  app.post("/admin/diagrams", async (req, reply) => {
    const part = await req.file({ limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
    if (!part) throw bad("No image was sent.");
    const field = (n: string) => (part.fields[n] as { value?: unknown } | undefined)?.value;
    const kind = field("kind") === "trailer" ? "trailer" : "truck";
    const name = reqStr(field("name"), "Diagram name", 100);
    const data = await part.toBuffer();
    if (part.file.truncated) throw bad("Image is too large.");
    const type = imageType(data);
    if (!type) throw bad("Diagram must be a JPEG or PNG image.");
    const key = newKey(type.ext);
    await files.put(key, data);
    const d = await one(`INSERT INTO diagrams (kind, name, file_path) VALUES ($1, $2, $3) RETURNING id, kind, name`, [kind, name, key]);
    return reply.code(201).send({ ...d, url: `/api/diagrams/${d.id}/image` });
  });
}
