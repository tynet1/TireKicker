// Fleet management, first part (SPEC §9): a truck's status (who may set what; every change kept by the database,
// migration 015), trailers moved between trucks (kept in asset_changes), and the supervisors' reminders list. Lease
// details and a lease-return checklist may come later.
import type { FastifyInstance } from "fastify";
import { requireRole, requireUser } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import { bad, conflict, HttpError, idParam, int, notFound, obj, str } from "../http.ts";
import { pieces } from "./equipment.ts";
import { CATEGORIES } from "./service.ts";

export const STATUSES = [
  { key: "in_service", title: "In service", inFleet: true },
  { key: "in_shop", title: "In the shop", inFleet: true },
  { key: "on_hold", title: "On hold", inFleet: true },
  { key: "preparing_return", title: "Preparing for return", inFleet: true },
  { key: "returned", title: "Returned", inFleet: false },
  { key: "sold", title: "Sold", inFleet: false },
  { key: "retired", title: "Retired", inFleet: false },
] as const;
const statusTitle = (k: string | null) => STATUSES.find((s) => s.key === k)?.title ?? k;
/** What the shop may set; supervisors and admins may set any status. */
const SHOP_STATUSES = ["in_service", "in_shop", "on_hold"];

function ymd(days = 0): string {
  const d = new Date(Date.now() + days * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "2026-11-17" -> "11/17/2026", the way the app shows dates. */
const us = (iso: string) => { const [y, m, d] = iso.split("-"); return `${Number(m)}/${Number(d)}/${y}`; };

export default async function fleetRoutes(app: FastifyInstance) {
  const staff = { preHandler: requireRole("supervisor", "shop") };

  app.get("/fleet-config", staff, async () => ({ statuses: STATUSES, shop_statuses: SHOP_STATUSES }));

  // Change a truck's status. The database records the change (who, when, note) and keeps Active in step.
  app.post("/vehicles/:id/status", staff, async (req) => {
    const id = idParam(req.params);
    const b = obj(req.body);
    const status = String(b.status ?? "");
    if (!STATUSES.some((s) => s.key === status)) throw bad("Pick a status from the list.");
    const note = str(b.note, "Note", 500);
    const user = req.user!;
    return tx(async (c) => {
      const v = (await c.query(`SELECT status, active FROM vehicles WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!v) throw notFound("Truck not found.");
      if ((await c.query(`SELECT 1 FROM trash WHERE kind = 'vehicle' AND record_id = $1::text`, [id])).rowCount) {
        throw conflict("This truck is in the trash. Restore it first (Admin → Trash).");
      }
      if (user.role === "shop" && (!SHOP_STATUSES.includes(status) || !v.active)) {
        throw new HttpError(403, "The shop can set In service, In the shop or On hold on trucks in the fleet. Ask a supervisor for the rest.");
      }
      if (v.status === status) throw conflict(`It's already ${statusTitle(status)}.`);
      await c.query(`SELECT set_config('gc.user_id', $1, true), set_config('gc.note', $2, true)`, [String(user.id), note ?? ""]);
      const r = (await c.query(`UPDATE vehicles SET status = $2, updated_at = now() WHERE id = $1 RETURNING status, active`, [id, status])).rows[0];
      return { status: r.status, title: statusTitle(r.status), active: r.active };
    });
  });

  app.get("/vehicles/:id/status-history", staff, async (req) => {
    const id = idParam(req.params);
    const rows = await q(
      `SELECT c.previous, c.status, c.note, c.changed_at, u.name AS changed_by_name
         FROM vehicle_status_changes c LEFT JOIN users u ON u.id = c.changed_by
        WHERE c.vehicle_id = $1 ORDER BY c.changed_at DESC, c.id DESC LIMIT 100`,
      [id],
    );
    return rows.map((r) => ({ ...r, title: statusTitle(r.status), previous_title: statusTitle(r.previous) }));
  });

  // Trailers in use and the truck each is on, for picking one.
  app.get("/trailers", staff, async () =>
    q(`SELECT t.id, t.trailer_number, t.name, t.plate, t.vehicle_id, v.truck_code
         FROM trailers t LEFT JOIN vehicles v ON v.id = t.vehicle_id
        WHERE t.active ORDER BY lower(t.trailer_number)`));

  // Put a trailer on a truck (or take it off: vehicle_id null). A truck pulls one trailer, so one already on that truck
  // comes off. Both moves are kept.
  app.post("/trailers/:id/assign", staff, async (req) => {
    const id = idParam(req.params);
    const b = obj(req.body);
    const vehicleId = b.vehicle_id == null ? null : int(b.vehicle_id, "vehicle_id", 1);
    const userId = req.user!.id;
    return tx(async (c) => {
      await c.query(`LOCK TABLE trailers IN SHARE ROW EXCLUSIVE MODE`);
      const t = (await c.query(`SELECT id, vehicle_id, active FROM trailers WHERE id = $1`, [id])).rows[0];
      if (!t || !t.active) throw notFound("That trailer isn't in use.");
      if (vehicleId !== null && !(await c.query(`SELECT 1 FROM vehicles WHERE id = $1 AND active`, [vehicleId])).rowCount) {
        throw bad("That truck isn't in the fleet.");
      }
      if (t.vehicle_id === vehicleId) return { ok: true, moved: false };
      const log = (trailerId: number, from: number | null, to: number | null) => c.query(
        `INSERT INTO asset_changes (trailer_id, action, before, after, changed_by) VALUES ($1, 'moved', $2, $3, $4)`,
        [trailerId, JSON.stringify({ vehicle_id: from }), JSON.stringify({ vehicle_id: to }), userId],
      );
      if (vehicleId !== null) {
        const other = (await c.query(`SELECT id FROM trailers WHERE vehicle_id = $1 AND id <> $2`, [vehicleId, id])).rows[0];
        if (other) {
          await c.query(`UPDATE trailers SET vehicle_id = NULL WHERE id = $1`, [other.id]);
          await log(other.id, vehicleId, null);
        }
      }
      await c.query(`UPDATE trailers SET vehicle_id = $2 WHERE id = $1`, [id, vehicleId]);
      await log(id, t.vehicle_id, vehicleId);
      return { ok: true, moved: true };
    });
  });

  // What needs doing soon, for supervisors (and the shop): registrations, overdue inspections, maintenance due on
  // trucks and equipment, equipment due for a check, and the yard walk. "due" first, then "soon".
  app.get("/reminders", staff, async (req) => {
    requireUser(req);
    const today = ymd();
    const soon = ymd(14);
    const items: { kind: string; state: "due" | "soon"; title: string; detail: string; link: string; sort: string }[] = [];

    for (const r of await q(
      `SELECT id, truck_code, registration_expires FROM vehicles
        WHERE active AND registration_expires IS NOT NULL AND registration_expires <= current_date + 30 ORDER BY registration_expires`)) {
      const past = r.registration_expires < today;
      items.push({ kind: "registration", state: past ? "due" : "soon", title: `${r.truck_code}: registration ${past ? "expired" : "expires"} ${us(r.registration_expires)}`,
        detail: "Update it on the truck page once renewed.", link: `#/truck/${r.id}`, sort: r.registration_expires });
    }
    // Overdue inspections, as one line: listed one by one they'd bury everything else (most trucks start uninspected).
    const overdue = await q(
      `SELECT id, truck_code FROM vehicle_status
        WHERE status = 'in_service' AND (last_inspection_date IS NULL OR last_inspection_date < current_date - 35)
        ORDER BY last_inspection_date NULLS FIRST, truck_code`);
    if (overdue.length) {
      const codes = overdue.map((r) => r.truck_code as string);
      items.push({ kind: "inspection", state: "due",
        title: overdue.length === 1 ? `${codes[0]}: not inspected in 35 days` : `${overdue.length} trucks not inspected in 35 days`,
        detail: codes.length > 12 ? `${codes.slice(0, 12).join(", ")} and ${codes.length - 12} more` : codes.join(", "),
        link: overdue.length === 1 ? `#/truck/${overdue[0].id}` : "#/", sort: "zzzz" });
    }
    // Truck maintenance: next due per truck and type of work, from the newest live entry with that type.
    for (const r of await q(
      `SELECT d.vehicle_id, d.type, d.miles, d.due_date, v.truck_code,
              GREATEST((SELECT max(mileage) FROM live_inspections WHERE vehicle_id = d.vehicle_id),
                       (SELECT max(mileage) FROM service_logs WHERE vehicle_id = d.vehicle_id AND voided_at IS NULL)) AS current_miles
         FROM (SELECT DISTINCT ON (s.vehicle_id, w->>'type') s.vehicle_id, w->>'type' AS type,
                      (w->>'next_due_mileage')::int AS miles, (w->>'next_due_date')::date AS due_date
                 FROM service_logs s CROSS JOIN LATERAL jsonb_array_elements(s.work) w
                WHERE s.voided_at IS NULL
                ORDER BY s.vehicle_id, w->>'type', s.service_date DESC, s.id DESC) d
         JOIN vehicles v ON v.id = d.vehicle_id AND v.active
        WHERE d.miles IS NOT NULL OR d.due_date IS NOT NULL`)) {
      const date: string | null = r.due_date;
      const milesDue = r.miles != null && r.current_miles != null && r.current_miles >= r.miles;
      const milesSoon = r.miles != null && r.current_miles != null && r.current_miles >= r.miles - 500;
      const state = (date && date <= today) || milesDue ? "due" : (date && date <= soon) || milesSoon ? "soon" : null;
      if (!state) continue;
      const when = [date ? `by ${us(date)}` : null, r.miles != null ? `at ${Number(r.miles).toLocaleString("en-US")} mi` : null].filter(Boolean).join(" or ");
      items.push({ kind: "service", state, title: `${r.truck_code}: ${CATEGORIES[r.type] ?? r.type} due ${when}`,
        detail: r.current_miles != null ? `Last mileage ${Number(r.current_miles).toLocaleString("en-US")}.` : "", link: `#/truck/${r.vehicle_id}`, sort: date ?? "9999" });
    }
    // Equipment: due for a check (per trailer) and maintenance due (per piece).
    const all = await pieces();
    const trailers = new Map((await q(`SELECT id, trailer_number FROM trailers`)).map((t) => [t.id, t.trailer_number]));
    const dueBy = new Map<string, string[]>();
    for (const p of all.filter((x) => x.due)) {
      const k = p.trailer_id ? trailers.get(p.trailer_id) ?? "Not on a trailer" : "Not on a trailer";
      dueBy.set(k, [...(dueBy.get(k) ?? []), p.tag]);
    }
    for (const [t, tags] of dueBy) {
      items.push({ kind: "equipment", state: "due", title: `${t}: ${tags.length} piece${tags.length === 1 ? "" : "s"} due for a check`,
        detail: tags.join(", "), link: "#/equipment", sort: "0001" });
    }
    for (const p of all.filter((x) => x.service_due)) {
      items.push({ kind: "equipment_service", state: "due", title: `${p.tag}: maintenance due`, detail: p.type_title,
        link: `#/equipment/piece/${p.id}`, sort: "0002" });
    }
    for (const y of await q(
      `SELECT y.id, y.name FROM yards y WHERE y.active
          AND NOT EXISTS (SELECT 1 FROM live_yard_inspections w WHERE w.yard_id = y.id AND w.inspection_date = $1::date)`, [today])) {
      items.push({ kind: "yard", state: "due", title: `${y.name}: today's walk isn't done`, detail: "", link: `#/yard/${y.id}`, sort: "0000" });
    }
    items.sort((a, b) => (a.state === b.state ? a.sort.localeCompare(b.sort) : a.state === "due" ? -1 : 1));
    return {
      due: items.filter((i) => i.state === "due").length,
      soon: items.filter((i) => i.state === "soon").length,
      items: items.map(({ sort: _s, ...i }) => i),
    };
  });
}
