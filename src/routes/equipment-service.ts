// Maintenance log for equipment (SPEC §9): the shop logs work on a piece (types of work, each with an optional next-due
// date; what was done, parts, cost, who or which vendor, notes, photos) and can close the piece's open problems from
// equipment checks. Entries are never edited or deleted: a mistaken one is voided with a reason, which reopens the
// problems it closed. Saves are idempotent on client_id, like every other form.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { requireRole } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import { bad, conflict, HttpError, idParam, int, isValidDate, notFound, obj, reqStr, str, UUID_RE } from "../http.ts";
import { attachFailed, UNATTACHED } from "../photo-owners.ts";
import { money } from "./service.ts";
import { trashInfo } from "./trash.ts";

export const EQUIPMENT_WORK = [
  { key: "sharpen", title: "Sharpen blade or chain" },
  { key: "line_head", title: "Trimmer line / head" },
  { key: "air_filter", title: "Air filter" },
  { key: "spark_plug", title: "Spark plug" },
  { key: "fuel_system", title: "Fuel system / carburetor" },
  { key: "oil", title: "Oil change" },
  { key: "tune_up", title: "Tune-up" },
  { key: "repair", title: "Repair" },
  { key: "other", title: "Other" },
] as const;
const WORK_KEYS: string[] = EQUIPMENT_WORK.map((w) => w.key);
export const workTitle = (k: string) => EQUIPMENT_WORK.find((w) => w.key === k)?.title ?? k;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface EntryIn {
  client_id: string;
  equipment_id: number;
  service_date: string;
  work: { type: string; next_due_date: string | null }[];
  description: string;
  parts: string | null;
  cost: number | null;
  performed_by: string | null;
  vendor: string | null;
  notes: string | null;
  fix_item_ids: number[];
  photos: { id: string; caption: string | null }[];
}

function dateOf(v: unknown, label: string): string {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !isValidDate(s)) throw bad(`${label} must be a date.`);
  return s;
}

export function parseEntry(body: unknown): EntryIn {
  const b = obj(body);
  const clientId = String(b.client_id ?? "").toLowerCase();
  if (!UUID_RE.test(clientId)) throw bad("client_id must be a uuid.");
  const date = dateOf(b.service_date, "Date");
  const max = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  if (date > max || date < "2020-01-01") throw bad("Date looks wrong. Check the date of the work.");
  if (!Array.isArray(b.work) || !b.work.length) throw bad("Pick at least one type of work.");
  if (b.work.length > WORK_KEYS.length) throw bad("Too many types of work.");
  const seen = new Set<string>();
  const work = b.work.map((x) => {
    const o = obj(x, "work");
    const type = String(o.type ?? "");
    if (!WORK_KEYS.includes(type)) throw bad("Pick the type of work from the list.");
    if (seen.has(type)) throw bad("A type of work is listed twice.");
    seen.add(type);
    const next = o.next_due_date == null || o.next_due_date === "" ? null : dateOf(o.next_due_date, "Next due");
    if (next && next <= date) throw bad("Next due must be after the date of the work.");
    return { type, next_due_date: next };
  });
  const fix = Array.isArray(b.fix_item_ids) ? b.fix_item_ids.map((v) => int(v, "fix_item_ids", 1)) : [];
  if (fix.length > 100) throw bad("Too many problems.");
  const photoIds = new Set<string>();
  const photos = (Array.isArray(b.photos) ? b.photos : []).map((x) => {
    const o = obj(x, "photo");
    const id = String(o.id ?? "").toLowerCase();
    if (!UUID_RE.test(id) || photoIds.has(id)) throw bad("Each photo needs a unique id.");
    photoIds.add(id);
    return { id, caption: str(o.caption, "Photo caption", 300) };
  });
  if (photos.length > 20) throw bad("Too many photos.");
  return {
    client_id: clientId, equipment_id: int(b.equipment_id, "equipment_id", 1), service_date: date, work,
    description: reqStr(b.description, "What was done", 2000), parts: str(b.parts, "Parts", 1000), cost: money(b.cost),
    performed_by: str(b.performed_by, "Done by", 100), vendor: str(b.vendor, "Vendor", 120), notes: str(b.notes, "Notes", 2000),
    fix_item_ids: [...new Set(fix)], photos,
  };
}

class DuplicateSave extends Error {}
const byClientId = (clientId: string) => one<{ id: number }>(`SELECT id FROM equipment_service_logs WHERE client_id = $1`, [clientId]);

export async function saveEntry(input: EntryIn, userId: number) {
  const dup = await byClientId(input.client_id);
  if (dup) return { id: dup.id, duplicate: true };
  if (!(await one(`SELECT 1 FROM equipment WHERE id = $1 AND active`, [input.equipment_id]))) throw bad("That equipment isn't in use.");
  if (input.photos.length) {
    const ids = input.photos.map((p) => p.id);
    const ok = new Set((await q(`SELECT id FROM photos WHERE id = ANY($1::uuid[]) AND ${UNATTACHED}`, [ids]))
      .map((r) => r.id));
    const notReady = ids.filter((id) => !ok.has(id));
    if (notReady.length) throw new HttpError(422, "Some photos haven't finished uploading yet.", { code: "photos_missing", photos: notReady });
  }
  try {
    return await tx(async (c) => {
      // The problems it fixes must be this piece's (open, or already resolved some other way meanwhile).
      const items = input.fix_item_ids.length ? (await c.query(
        `SELECT id, resolved_at FROM equipment_check_items WHERE id = ANY($1::int[]) AND equipment_id = $2 AND result = 'repair'
            AND check_id IN (SELECT id FROM live_equipment_checks) FOR UPDATE`,
        [input.fix_item_ids, input.equipment_id],
      )).rows : [];
      const wrong = input.fix_item_ids.filter((id) => !items.some((i) => i.id === id));
      if (wrong.length) {
        throw new HttpError(422, "Some of the problems picked aren't problems on this piece. Reload and pick again.", { code: "bad_problems", items: wrong });
      }
      const ins = await c.query(
        `INSERT INTO equipment_service_logs (client_id, equipment_id, service_date, work, description, parts, cost, performed_by, vendor, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (client_id) DO NOTHING RETURNING id`,
        [input.client_id, input.equipment_id, input.service_date, JSON.stringify(input.work), input.description, input.parts,
          input.cost, input.performed_by, input.vendor, input.notes, userId],
      );
      if (!ins.rows[0]) throw new DuplicateSave();
      const id = ins.rows[0].id as number;
      const note = `Fixed (maintenance log): ${input.description}`.slice(0, 1000);
      for (const it of items) {
        const here = !it.resolved_at;
        if (here) {
          await c.query(`UPDATE equipment_check_items SET resolved_at = now(), resolved_by = $2, resolution_note = $3 WHERE id = $1`,
            [it.id, userId, note]);
        }
        await c.query(`INSERT INTO equipment_service_repairs (service_log_id, check_item_id, resolved_here) VALUES ($1, $2, $3)`, [id, it.id, here]);
      }
      for (const p of input.photos) {
        const r = await c.query(`UPDATE photos SET equipment_service_log_id = $2, caption = $3 WHERE id = $1 AND ${UNATTACHED}`, [p.id, id, p.caption]);
        if (r.rowCount !== 1) throw await attachFailed(c, p.id, "A photo was attached to something else. Remove it and try again.");
      }
      return { id, fixed: items.length, duplicate: false };
    });
  } catch (e) {
    if (e instanceof DuplicateSave) {
      const d = await byClientId(input.client_id);
      if (d) return { id: d.id, duplicate: true };
    }
    throw e;
  }
}

/** Next due per type of work: from the newest live entry with that type (an older one's date is out of date). */
export async function nextDue(equipmentId: number) {
  const rows = await q<{ type: string; next_due_date: string | null; service_date: string; id: number }>(
    `SELECT DISTINCT ON (w->>'type') w->>'type' AS type, w->>'next_due_date' AS next_due_date, s.service_date, s.id
       FROM equipment_service_logs s CROSS JOIN LATERAL jsonb_array_elements(s.work) w
      WHERE s.equipment_id = $1 AND s.voided_at IS NULL
      ORDER BY w->>'type', s.service_date DESC, s.id DESC`,
    [equipmentId],
  );
  const t = today();
  const soon = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
  return rows.filter((r) => r.next_due_date).map((r) => ({
    type: r.type, title: workTitle(r.type), date: r.next_due_date, entry_id: r.id,
    state: r.next_due_date! <= t ? "due" : r.next_due_date! <= soon ? "soon" : "ok",
  }));
}

/**
 * Void an entry, inside the caller's transaction; problems it resolved open again (unless another live entry also fixed
 * them). Returns how many reopened, or null when it was already voided (or doesn't exist).
 */
export async function voidEquipmentService(c: PoolClient, id: number, userId: number, reason: string): Promise<number | null> {
  const r = await c.query(
    `UPDATE equipment_service_logs SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL RETURNING id`,
    [id, userId, reason],
  );
  if (!r.rowCount) return null;
  const reopened = await c.query(
    `UPDATE equipment_check_items i SET resolved_at = NULL, resolved_by = NULL, resolution_note = NULL
       FROM equipment_service_repairs r
      WHERE r.service_log_id = $1 AND r.resolved_here AND i.id = r.check_item_id AND i.resolved_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM equipment_service_repairs r2 JOIN equipment_service_logs s2 ON s2.id = r2.service_log_id
                         WHERE r2.check_item_id = i.id AND r2.service_log_id <> $1 AND s2.voided_at IS NULL)`,
    [id],
  );
  return reopened.rowCount ?? 0;
}

export default async function equipmentServiceRoutes(app: FastifyInstance) {
  const canRead = { preHandler: requireRole("supervisor", "shop") };
  const canWrite = { preHandler: requireRole("admin", "shop") };

  app.get("/equipment-service-config", canRead, async () => ({ work: EQUIPMENT_WORK }));

  // A piece's maintenance: entries (newest first, voided ones marked) and what's due next.
  app.get("/equipment/:id/service", canRead, async (req) => {
    const id = idParam(req.params);
    if (!(await one(`SELECT 1 FROM equipment WHERE id = $1`, [id]))) throw notFound("Equipment not found.");
    const entries = await q(
      `SELECT s.id, s.service_date, s.work, s.description, s.cost, s.performed_by, s.vendor, (s.voided_at IS NOT NULL) AS voided,
              (SELECT count(*) FROM equipment_service_repairs r WHERE r.service_log_id = s.id)::int AS fixed
         FROM equipment_service_logs s WHERE s.equipment_id = $1 AND NOT EXISTS (SELECT 1 FROM trash tr WHERE tr.kind = 'equipment_service' AND tr.record_id = s.id::text)
        ORDER BY s.service_date DESC, s.id DESC LIMIT 300`,
      [id],
    );
    return {
      entries: entries.map((e) => ({ ...e, work_titles: (e.work as { type: string }[]).map((w) => workTitle(w.type)) })),
      next_due: await nextDue(id),
    };
  });

  app.post("/equipment-service", { ...canWrite, bodyLimit: 512 * 1024 }, async (req, reply) => {
    const out = await saveEntry(parseEntry(req.body), req.user!.id);
    return reply.code(out.duplicate ? 200 : 201).send(out);
  });

  app.get("/equipment-service/:id", canRead, async (req) => {
    const id = idParam(req.params);
    const e = await one(
      `SELECT s.*, eq.tag, eq.type AS equipment_type, cu.name AS created_by_name, vu.name AS voided_by_name
         FROM equipment_service_logs s JOIN equipment eq ON eq.id = s.equipment_id
         JOIN users cu ON cu.id = s.created_by LEFT JOIN users vu ON vu.id = s.voided_by WHERE s.id = $1`,
      [id],
    );
    if (!e) throw notFound("Maintenance entry not found.");
    const fixed = await q(
      `SELECT i.id, i.label_snapshot AS label, i.note, c.check_date, r.resolved_here
         FROM equipment_service_repairs r JOIN equipment_check_items i ON i.id = r.check_item_id JOIN equipment_checks c ON c.id = i.check_id
        WHERE r.service_log_id = $1 ORDER BY i.id`,
      [id],
    );
    const photos = await q(`SELECT id, caption FROM photos WHERE equipment_service_log_id = $1 ORDER BY created_at, id`, [id]);
    return {
      ...e, voided: !!e.voided_at, trash: await trashInfo("equipment_service", id),
      work: (e.work as { type: string; next_due_date: string | null }[]).map((w) => ({ ...w, title: workTitle(w.type) })),
      fixed, photos,
    };
  });

  // Void a mistaken entry: it stays listed, marked voided; problems it resolved are open again.
  app.post("/equipment-service/:id/void", canWrite, async (req) => {
    const id = idParam(req.params);
    const reason = reqStr(obj(req.body ?? {}).reason, "Reason", 600);
    return tx(async (c) => {
      const reopened = await voidEquipmentService(c, id, req.user!.id, reason);
      if (reopened === null) {
        if (!(await c.query(`SELECT 1 FROM equipment_service_logs WHERE id = $1`, [id])).rowCount) throw notFound("Maintenance entry not found.");
        throw conflict("That entry is already voided.");
      }
      return { ok: true, reopened };
    });
  });
}
