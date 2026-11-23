// Equipment inspections (SPEC §9 wishlist): the yard-care equipment carried on the trailers, about 8 tagged pieces a
// trailer. Admins keep the trailers and equipment (add, edit, move a piece to another trailer, retire; every change
// kept). The shop or a supervisor checks a trailer at a time: each piece on its type's checklist ("All equipment" plus
// its type's part), or "Not here". Problems stay open until resolved with a note. A piece is due for a check every
// `check_days` (Admin → Equipment, 30 by default). Checks are read-only once submitted and idempotent on client_id.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { requireRole } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import { bad, conflict, DATE_RE, HttpError, idParam, int, isValidDate, notFound, obj, reqStr, str, UUID_RE, uuidParam } from "../http.ts";
import { attachFailed, UNATTACHED } from "../photo-owners.ts";
import { EQUIPMENT_SECTIONS, EQUIPMENT_TYPES } from "./checklist.ts";
import { trashInfo } from "./trash.ts";

const TYPE_KEYS: string[] = EQUIPMENT_TYPES.map((t) => t.key);
const SECTION_ORDER = EQUIPMENT_SECTIONS.map((s) => s.key);
const typeTitle = (k: string) => EQUIPMENT_TYPES.find((t) => t.key === k)?.title ?? k;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function checkDays(): Promise<number> {
  const r = await one<{ value: { check_days?: number } }>(`SELECT value FROM settings WHERE key = 'equipment'`);
  const n = Number(r?.value?.check_days);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30;
}

async function logChange(c: PoolClient, what: { equipment_id?: number; trailer_id?: number }, action: string,
  before: unknown, after: unknown, userId: number) {
  await c.query(
    `INSERT INTO asset_changes (equipment_id, trailer_id, action, before, after, changed_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [what.equipment_id ?? null, what.trailer_id ?? null, action, before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after), userId],
  );
}

/** Only the fields that changed, before and after. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if ((before[k] ?? null) !== (after[k] ?? null)) { b[k] = before[k] ?? null; a[k] = after[k] ?? null; }
  }
  return { b, a, changed: Object.keys(a) };
}

// ---------- Submitting a check ----------

interface PieceIn {
  equipment_id: number;
  status: "checked" | "not_here";
  note: string | null;
  items: { checklist_item_id: number; result: "ok" | "repair"; note: string | null }[];
}
interface PhotoIn { id: string; caption: string | null; equipment_id: number; checklist_item_id: number | null }
export interface CheckSubmit {
  client_id: string;
  trailer_id: number | null;
  check_date: string;
  checker_name: string;
  comments: string | null;
  checklist_as_of: Date | null;
  pieces: PieceIn[];
  photos: PhotoIn[];
}

const list = (v: unknown, field: string, max: number): unknown[] => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad(`${field} must be a list.`);
  if (v.length > max) throw bad(`Too many ${field}.`);
  return v;
};

export function parseCheck(body: unknown): CheckSubmit {
  const b = obj(body);
  const clientId = String(b.client_id ?? "").toLowerCase();
  if (!UUID_RE.test(clientId)) throw bad("client_id must be a uuid.");
  const date = String(b.check_date ?? "");
  if (!DATE_RE.test(date) || !isValidDate(date)) throw bad("Date is required.");
  const max = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  if (date > max || date < "2020-01-01") throw bad("Date looks wrong. Check the date of the check.");
  let asOf: Date | null = null;
  if (b.checklist_as_of != null) {
    asOf = new Date(String(b.checklist_as_of));
    if (Number.isNaN(asOf.getTime())) throw bad("checklist_as_of must be a date and time.");
  }
  const seen = new Set<number>();
  const pieces = list(b.pieces, "pieces", 100).map((x, i): PieceIn => {
    const o = obj(x, `piece ${i + 1}`);
    const id = int(o.equipment_id, "equipment_id", 1);
    if (seen.has(id)) throw bad("A piece of equipment is on the check twice.");
    seen.add(id);
    if (o.status !== "checked" && o.status !== "not_here") throw bad('Each piece must be "checked" or "not_here".');
    const items = list(o.items, "checklist items", 100).map((y) => {
      const it = obj(y, "item");
      if (it.result !== "ok" && it.result !== "repair") throw bad("Each checklist item must be OK or Repair.");
      return { checklist_item_id: int(it.checklist_item_id, "checklist_item_id", 1), result: it.result as "ok" | "repair", note: str(it.note, "Repair note", 1000) };
    });
    if (o.status === "not_here" && items.length) throw bad("A piece that isn't here has no checklist answers.");
    return { equipment_id: id, status: o.status, note: str(o.note, "Note", 500), items };
  });
  if (!pieces.length) throw bad("Check at least one piece of equipment.");
  const photoIds = new Set<string>();
  const photos = list(b.photos, "photos", 60).map((x): PhotoIn => {
    const o = obj(x, "photo");
    const id = String(o.id ?? "").toLowerCase();
    if (!UUID_RE.test(id) || photoIds.has(id)) throw bad("Each photo needs a unique id.");
    photoIds.add(id);
    return {
      id, caption: str(o.caption, "Photo caption", 300), equipment_id: int(o.equipment_id, "equipment_id", 1),
      checklist_item_id: o.checklist_item_id == null ? null : int(o.checklist_item_id, "checklist_item_id", 1),
    };
  });
  return {
    client_id: clientId, trailer_id: b.trailer_id == null ? null : int(b.trailer_id, "trailer_id", 1), check_date: date,
    checker_name: reqStr(b.checker_name, "Name", 100), comments: str(b.comments, "Comments", 5000),
    checklist_as_of: asOf, pieces, photos,
  };
}

const byClientId = (clientId: string) => one<{ id: string }>(`SELECT id FROM equipment_checks WHERE client_id = $1`, [clientId]);
class DuplicateSubmit extends Error {}

export async function submitCheck(input: CheckSubmit, userId: number) {
  const dup = await byClientId(input.client_id);
  if (dup) return { id: dup.id, duplicate: true };
  if (input.trailer_id != null && !(await one(`SELECT 1 FROM trailers WHERE id = $1`, [input.trailer_id]))) {
    throw bad("That trailer isn't on file.");
  }
  const ids = input.pieces.map((p) => p.equipment_id);
  const equipment = new Map((await q<{ id: number; tag: string; type: string }>(
    `SELECT id, tag, type FROM equipment WHERE id = ANY($1::int[])`, [ids])).map((e) => [e.id, e]));
  const unknown = ids.filter((id) => !equipment.has(id));
  if (unknown.length) throw new HttpError(422, "Some of this equipment isn't on file. Reload and check again.", { code: "unknown_equipment", equipment: unknown });

  // The same checklist rules as the truck and yard forms (011): answers to any item in the piece's parts (retired ones
  // too), each once; items in use are required unless added after the phone loaded the form (90 days back at most).
  const checklist = await q<{ id: number; section: string; label: string; required: boolean }>(
    `SELECT id, section, label,
            active AND created_at <= GREATEST(LEAST(COALESCE($1::timestamptz, now()), now()), now() - interval '90 days') AS required
       FROM equipment_checklist_items ORDER BY array_position($2::text[], section), sort_order, id`,
    [input.checklist_as_of, SECTION_ORDER],
  );
  const missing: { equipment_id: number; items: number[] }[] = [];
  const noNote: { equipment_id: number; items: number[] }[] = [];
  const answered = new Map<number, Set<number>>(); // equipment id -> answered checklist item ids
  for (const p of input.pieces) {
    if (p.status !== "checked") continue;
    const type = equipment.get(p.equipment_id)!.type;
    const mine = checklist.filter((c) => c.section === "all" || c.section === type);
    const allowed = new Set(mine.map((c) => c.id));
    const got = new Set<number>();
    for (const it of p.items) {
      if (!allowed.has(it.checklist_item_id)) {
        throw new HttpError(422, "The equipment checklist changed since this form was opened. Reload the form and check again.", { code: "checklist_changed" });
      }
      if (got.has(it.checklist_item_id)) throw bad("A checklist item was answered twice.");
      got.add(it.checklist_item_id);
    }
    answered.set(p.equipment_id, got);
    const miss = mine.filter((c) => c.required && !got.has(c.id)).map((c) => c.id);
    if (miss.length) missing.push({ equipment_id: p.equipment_id, items: miss });
    const nn = p.items.filter((i) => i.result === "repair" && !i.note).map((i) => i.checklist_item_id);
    if (nn.length) noNote.push({ equipment_id: p.equipment_id, items: nn });
  }
  if (missing.length) {
    const n = missing.reduce((s, m) => s + m.items.length, 0);
    throw new HttpError(422, `${n} checklist item(s) still need an answer.`, { missing });
  }
  if (noNote.length) throw new HttpError(422, "Every Repair needs a short note.", { missing_notes: noNote });
  for (const ph of input.photos) {
    const got = answered.get(ph.equipment_id);
    if (!got) throw bad("A photo points at equipment that wasn't checked.");
    if (ph.checklist_item_id != null && !got.has(ph.checklist_item_id)) throw bad("A photo points at a checklist item that wasn't answered.");
  }
  if (input.photos.length) {
    const pids = input.photos.map((p) => p.id);
    const ok = new Set((await q(`SELECT id FROM photos WHERE id = ANY($1::uuid[]) AND ${UNATTACHED}`, [pids]))
      .map((r) => r.id));
    const notReady = pids.filter((id) => !ok.has(id));
    if (notReady.length) throw new HttpError(422, "Some photos haven't finished uploading yet.", { code: "photos_missing", photos: notReady });
  }

  try {
    return await tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO equipment_checks (client_id, trailer_id, check_date, checked_by, checker_name, comments)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (client_id) DO NOTHING RETURNING id`,
        [input.client_id, input.trailer_id, input.check_date, userId, input.checker_name, input.comments],
      );
      if (!ins.rows[0]) throw new DuplicateSubmit();
      const id: string = ins.rows[0].id;
      const itemIds = new Map<string, number>(); // "equipmentId:checklistItemId" -> saved item id
      let failed = 0;
      for (const p of input.pieces) {
        const e = equipment.get(p.equipment_id)!;
        const piece = (await c.query(
          `INSERT INTO equipment_check_pieces (check_id, equipment_id, status, note, tag_snapshot, type_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [id, e.id, p.status, p.note, e.tag, e.type],
        )).rows[0].id as number;
        const answers = new Map(p.items.map((i) => [i.checklist_item_id, i]));
        for (const ci of checklist) {
          const a = answers.get(ci.id);
          if (!a) continue;
          const r = await c.query(
            `INSERT INTO equipment_check_items (check_id, piece_id, equipment_id, checklist_item_id, section, label_snapshot, result, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [id, piece, e.id, ci.id, ci.section, ci.label, a.result, a.result === "repair" ? a.note : null],
          );
          itemIds.set(`${e.id}:${ci.id}`, r.rows[0].id);
          if (a.result === "repair") failed++;
        }
      }
      for (const ph of input.photos) {
        const r = await c.query(
          `UPDATE photos SET equipment_check_id = $2, equipment_check_item_id = $3, caption = $4 WHERE id = $1 AND ${UNATTACHED}`,
          [ph.id, id, ph.checklist_item_id ? itemIds.get(`${ph.equipment_id}:${ph.checklist_item_id}`) ?? null : null, ph.caption],
        );
        if (r.rowCount !== 1) throw await attachFailed(c, ph.id, "A photo was attached to something else. Remove it and try again.");
      }
      return { id, failed, duplicate: false };
    });
  } catch (e) {
    if (e instanceof DuplicateSubmit) {
      const d = await byClientId(input.client_id);
      if (d) return { id: d.id, duplicate: true };
    }
    throw e;
  }
}

// ---------- Reading ----------

/** Active pieces with when each was last checked, whether it's due, and its open problems. */
export async function pieces(where = "", params: unknown[] = []) {
  const days = await checkDays();
  const rows = await q(
    `SELECT e.id, e.tag, e.type, e.make, e.model, e.serial, e.trailer_id, e.notes,
            (SELECT max(c.check_date) FROM equipment_check_pieces p JOIN live_equipment_checks c ON c.id = p.check_id
              WHERE p.equipment_id = e.id AND p.status = 'checked') AS last_checked,
            (SELECT count(*) FROM equipment_check_items i JOIN live_equipment_checks c ON c.id = i.check_id
              WHERE i.equipment_id = e.id AND i.result = 'repair' AND i.resolved_at IS NULL)::int AS open_problems,
            -- Maintenance whose next-due date has passed (newest live entry per type of work, migration 014).
            (SELECT count(*) FROM (
               SELECT DISTINCT ON (w->>'type') (w->>'next_due_date')::date AS d
                 FROM equipment_service_logs s CROSS JOIN LATERAL jsonb_array_elements(s.work) w
                WHERE s.equipment_id = e.id AND s.voided_at IS NULL
                ORDER BY w->>'type', s.service_date DESC, s.id DESC) x WHERE x.d <= current_date)::int AS service_due
       FROM equipment e WHERE e.active ${where} ORDER BY lower(e.tag)`,
    params,
  );
  const cutoff = new Date(Date.now() - days * 86400_000);
  const cut = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return rows.map((r) => ({ ...r, type_title: typeTitle(r.type), due: !r.last_checked || r.last_checked <= cut }));
}

export async function loadCheck(id: string) {
  const c = await one(
    `SELECT c.id, c.trailer_id, t.trailer_number, t.name AS trailer_name, c.check_date, c.checker_name, c.comments, c.created_at
       FROM equipment_checks c LEFT JOIN trailers t ON t.id = c.trailer_id WHERE c.id = $1`,
    [id],
  );
  if (!c) return null;
  const ps = await q(
    `SELECT p.id, p.equipment_id, p.status, p.note, p.tag_snapshot AS tag, p.type_snapshot AS type
       FROM equipment_check_pieces p WHERE p.check_id = $1 ORDER BY lower(p.tag_snapshot), p.id`,
    [id],
  );
  const items = await q(
    `SELECT i.id, i.piece_id, i.equipment_id, i.section, i.label_snapshot AS label, i.result, i.note, i.resolved_at,
            i.resolution_note, u.name AS resolved_by_name
       FROM equipment_check_items i LEFT JOIN users u ON u.id = i.resolved_by
      WHERE i.check_id = $1 ORDER BY i.id`,
    [id],
  );
  const photos = await q(
    `SELECT id, caption, equipment_check_item_id AS item_id FROM photos WHERE equipment_check_id = $1 ORDER BY created_at, id`, [id]);
  return {
    check: c,
    pieces: ps.map((p) => ({ ...p, type_title: typeTitle(p.type), items: items.filter((i) => i.piece_id === p.id) })),
    photos,
  };
}

// ---------- Routes ----------

export default async function equipmentRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireRole("admin") };
  const crewOfShop = { preHandler: requireRole("supervisor", "shop") };

  // ----- Admin: trailers, equipment, how often -----

  app.get("/admin/equipment", admin, async () => ({
    types: EQUIPMENT_TYPES,
    check_days: await checkDays(),
    trailers: await q(`SELECT id, trailer_number, name, plate, notes, active FROM trailers ORDER BY active DESC, lower(trailer_number)`),
    equipment: (await q(`SELECT id, tag, type, make, model, serial, trailer_id, notes, active FROM equipment ORDER BY active DESC, lower(tag)`))
      .map((e) => ({ ...e, type_title: typeTitle(e.type) })),
  }));

  app.put("/admin/equipment-settings", admin, async (req) => {
    const days = int(obj(req.body).check_days, "Days between checks", 1, 365);
    await one(
      `INSERT INTO settings (key, value, updated_by) VALUES ('equipment', $1::jsonb, $2)
       ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [JSON.stringify({ check_days: days }), req.user!.id],
    );
    return { check_days: days };
  });

  function trailerFields(b: Record<string, unknown>, partial: boolean) {
    const f: Record<string, unknown> = {};
    if (!partial || b.trailer_number !== undefined) f.trailer_number = reqStr(b.trailer_number, "Trailer number", 30);
    for (const [k, label, max] of [["name", "Name", 80], ["plate", "Plate", 20], ["notes", "Notes", 1000]] as const) {
      if (!partial || b[k] !== undefined) f[k] = str(b[k], label, max);
    }
    if (b.active !== undefined) {
      if (typeof b.active !== "boolean") throw bad("active must be true or false.");
      f.active = b.active;
    }
    return f;
  }

  async function trailerNumberFree(c: PoolClient, num: string, exceptId: number) {
    const clash = (await c.query(`SELECT id FROM trailers WHERE lower(trailer_number) = lower($1) AND id <> $2`, [num, exceptId])).rows[0];
    if (clash) throw conflict(`Another trailer is already numbered ${num}.`);
  }

  app.post("/admin/trailers", admin, async (req, reply) => {
    const f = trailerFields(obj(req.body), false);
    const t = await tx(async (c) => {
      await c.query(`LOCK TABLE trailers IN SHARE ROW EXCLUSIVE MODE`);
      await trailerNumberFree(c, String(f.trailer_number), 0);
      const r = (await c.query(
        `INSERT INTO trailers (trailer_number, name, plate, notes) VALUES ($1, $2, $3, $4) RETURNING id, trailer_number, name, plate, notes, active`,
        [f.trailer_number, f.name, f.plate, f.notes],
      )).rows[0];
      await logChange(c, { trailer_id: r.id }, "added", null, f, req.user!.id);
      return r;
    });
    return reply.code(201).send(t);
  });

  app.patch("/admin/trailers/:id", admin, async (req) => {
    const id = idParam(req.params);
    const f = trailerFields(obj(req.body), true);
    return tx(async (c) => {
      await c.query(`LOCK TABLE trailers IN SHARE ROW EXCLUSIVE MODE`);
      const old = (await c.query(`SELECT trailer_number, name, plate, notes, active FROM trailers WHERE id = $1`, [id])).rows[0];
      if (!old) throw notFound("Trailer not found.");
      if (f.trailer_number !== undefined) await trailerNumberFree(c, String(f.trailer_number), id);
      if (f.active === false && old.active) {
        const on = Number((await c.query(`SELECT count(*) AS n FROM equipment WHERE trailer_id = $1 AND active`, [id])).rows[0].n);
        if (on) throw conflict(`${on} piece${on === 1 ? " is" : "s are"} still on this trailer. Move ${on === 1 ? "it" : "them"} first.`);
      }
      const { b, a, changed } = diff(old, f);
      if (!changed.length) return { ok: true };
      await c.query(`UPDATE trailers SET ${changed.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...changed.map((k) => a[k])]);
      const action = changed.includes("active") ? (a.active ? "restored" : "retired") : "edited";
      await logChange(c, { trailer_id: id }, action, b, a, req.user!.id);
      return { ok: true };
    });
  });

  function equipmentFields(b: Record<string, unknown>, partial: boolean) {
    const f: Record<string, unknown> = {};
    if (!partial || b.tag !== undefined) f.tag = reqStr(b.tag, "Tag", 30);
    if (!partial || b.type !== undefined) {
      const t = String(b.type ?? "");
      if (!TYPE_KEYS.includes(t)) throw bad("Pick what kind of equipment it is.");
      f.type = t;
    }
    for (const [k, label, max] of [["make", "Make", 60], ["model", "Model", 60], ["serial", "Serial number", 60], ["notes", "Notes", 1000]] as const) {
      if (!partial || b[k] !== undefined) f[k] = str(b[k], label, max);
    }
    if (!partial || b.trailer_id !== undefined) f.trailer_id = b.trailer_id == null || b.trailer_id === "" ? null : int(b.trailer_id, "trailer_id", 1);
    if (b.active !== undefined) {
      if (typeof b.active !== "boolean") throw bad("active must be true or false.");
      f.active = b.active;
    }
    return f;
  }

  async function equipmentChecks(c: PoolClient, f: Record<string, unknown>, exceptId: number) {
    if (f.tag !== undefined) {
      const clash = (await c.query(`SELECT id FROM equipment WHERE lower(tag) = lower($1) AND id <> $2`, [f.tag, exceptId])).rows[0];
      if (clash) throw conflict(`Another piece is already tagged ${f.tag}.`);
    }
    if (f.trailer_id != null && !(await c.query(`SELECT 1 FROM trailers WHERE id = $1 AND active`, [f.trailer_id])).rowCount) {
      throw bad("That trailer isn't in use.");
    }
  }

  app.post("/admin/equipment", admin, async (req, reply) => {
    const f = equipmentFields(obj(req.body), false);
    const e = await tx(async (c) => {
      await c.query(`LOCK TABLE equipment IN SHARE ROW EXCLUSIVE MODE`);
      await equipmentChecks(c, f, 0);
      const r = (await c.query(
        `INSERT INTO equipment (tag, type, make, model, serial, trailer_id, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, tag, type, make, model, serial, trailer_id, notes, active`,
        [f.tag, f.type, f.make, f.model, f.serial, f.trailer_id, f.notes],
      )).rows[0];
      await logChange(c, { equipment_id: r.id }, "added", null, f, req.user!.id);
      return r;
    });
    return reply.code(201).send(e);
  });

  app.patch("/admin/equipment/:id", admin, async (req) => {
    const id = idParam(req.params);
    const f = equipmentFields(obj(req.body), true);
    return tx(async (c) => {
      await c.query(`LOCK TABLE equipment IN SHARE ROW EXCLUSIVE MODE`);
      const old = (await c.query(`SELECT tag, type, make, model, serial, trailer_id, notes, active FROM equipment WHERE id = $1`, [id])).rows[0];
      if (!old) throw notFound("Equipment not found.");
      await equipmentChecks(c, f, id);
      const { b, a, changed } = diff(old, f);
      if (!changed.length) return { ok: true };
      await c.query(`UPDATE equipment SET ${changed.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
        [id, ...changed.map((k) => a[k])]);
      // One history entry per kind of change, so a move or a retirement stands out.
      const moved = changed.includes("trailer_id");
      const status = changed.includes("active");
      const rest = changed.filter((k) => k !== "trailer_id" && k !== "active");
      if (moved) await logChange(c, { equipment_id: id }, "moved", { trailer_id: b.trailer_id }, { trailer_id: a.trailer_id }, req.user!.id);
      if (status) await logChange(c, { equipment_id: id }, a.active ? "restored" : "retired", { active: b.active }, { active: a.active }, req.user!.id);
      if (rest.length) {
        await logChange(c, { equipment_id: id }, "edited", Object.fromEntries(rest.map((k) => [k, b[k]])),
          Object.fromEntries(rest.map((k) => [k, a[k]])), req.user!.id);
      }
      return { ok: true };
    });
  });

  // ----- Shop and supervisors -----

  // Every trailer in use with its pieces (and the pieces on no trailer), each with its last check and whether it's due.
  app.get("/equipment", crewOfShop, async () => {
    const all = await pieces();
    const trailers = await q(
      `SELECT t.id, t.trailer_number, t.name, t.plate, v.truck_code FROM trailers t LEFT JOIN vehicles v ON v.id = t.vehicle_id
        WHERE t.active ORDER BY lower(t.trailer_number)`);
    return {
      check_days: await checkDays(),
      trailers: trailers.map((t) => ({ ...t, pieces: all.filter((p) => p.trailer_id === t.id) })),
      unassigned: all.filter((p) => p.trailer_id == null || !trailers.some((t) => t.id === p.trailer_id)),
      due: all.filter((p) => p.due).length,
      open_problems: all.reduce((n, p) => n + p.open_problems, 0),
    };
  });

  // One piece: its details, history (adds, edits, moves), checks and open problems.
  app.get("/equipment/:id", crewOfShop, async (req) => {
    const id = idParam(req.params);
    const e = await one(
      `SELECT e.id, e.tag, e.type, e.make, e.model, e.serial, e.trailer_id, t.trailer_number, e.notes, e.active, e.created_at
         FROM equipment e LEFT JOIN trailers t ON t.id = e.trailer_id WHERE e.id = $1`, [id]);
    if (!e) throw notFound("Equipment not found.");
    const history = await q(
      `SELECT ac.action, ac.before, ac.after, ac.changed_at, u.name AS changed_by_name
         FROM asset_changes ac JOIN users u ON u.id = ac.changed_by WHERE ac.equipment_id = $1 ORDER BY ac.changed_at DESC, ac.id DESC LIMIT 100`,
      [id]);
    const checks = await q(
      `SELECT c.id, c.check_date, c.checker_name, p.status, p.note,
              (SELECT count(*) FROM equipment_check_items i WHERE i.piece_id = p.id AND i.result = 'repair')::int AS problems
         FROM equipment_check_pieces p JOIN live_equipment_checks c ON c.id = p.check_id
        WHERE p.equipment_id = $1 ORDER BY c.check_date DESC, c.created_at DESC LIMIT 100`,
      [id]);
    const trailers = new Map((await q(`SELECT id, trailer_number FROM trailers`)).map((t) => [t.id, t.trailer_number]));
    return {
      equipment: { ...e, type_title: typeTitle(e.type) },
      history: history.map((h) => ({
        ...h,
        // Name the trailers in moves, not their ids.
        before: h.action === "moved" ? { trailer: trailers.get(h.before?.trailer_id) ?? null } : h.before,
        after: h.action === "moved" ? { trailer: trailers.get(h.after?.trailer_id) ?? null } : h.after,
      })),
      checks,
    };
  });

  // What the check form needs for one trailer ("none": the pieces on no trailer). as_of goes back with the check.
  app.get("/equipment-config/:trailer", crewOfShop, async (req) => {
    const key = (req.params as { trailer: string }).trailer;
    let trailer = null;
    let list;
    if (key === "none") {
      list = await pieces(`AND (e.trailer_id IS NULL OR e.trailer_id NOT IN (SELECT id FROM trailers WHERE active))`);
    } else {
      if (!/^\d+$/.test(key)) throw bad("Pick a trailer.");
      trailer = await one(`SELECT id, trailer_number, name FROM trailers WHERE id = $1 AND active`, [Number(key)]);
      if (!trailer) throw notFound("That trailer isn't in use.");
      list = await pieces(`AND e.trailer_id = $1`, [trailer.id]);
    }
    return {
      trailer,
      pieces: list,
      sections: EQUIPMENT_SECTIONS,
      checklist: await q(
        `SELECT id, section, label FROM equipment_checklist_items WHERE active ORDER BY array_position($1::text[], section), sort_order, id`,
        [SECTION_ORDER]),
      as_of: new Date().toISOString(),
    };
  });

  app.post("/equipment-checks", { ...crewOfShop, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const out = await submitCheck(parseCheck(req.body), req.user!.id);
    return reply.code(out.duplicate ? 200 : 201).send(out);
  });

  // Recent checks, for a trailer ("none": pieces on no trailer) or all of them.
  app.get("/equipment-checks", crewOfShop, async (req) => {
    const qs = (req.query ?? {}) as Record<string, string | undefined>;
    const params: unknown[] = [];
    let where = "";
    if (qs.trailer === "none") where = "WHERE c.trailer_id IS NULL";
    else if (qs.trailer) {
      if (!/^\d+$/.test(qs.trailer)) throw bad("trailer must be a number or none.");
      params.push(Number(qs.trailer));
      where = `WHERE c.trailer_id = $${params.length}`;
    }
    params.push(Math.min(Number(qs.limit) || 30, 200));
    return q(
      `SELECT c.id, c.check_date, c.checker_name, c.trailer_id, t.trailer_number,
              (SELECT count(*) FROM equipment_check_pieces p WHERE p.check_id = c.id AND p.status = 'checked')::int AS checked,
              (SELECT count(*) FROM equipment_check_pieces p WHERE p.check_id = c.id AND p.status = 'not_here')::int AS not_here,
              (SELECT count(*) FROM equipment_check_items i WHERE i.check_id = c.id AND i.result = 'repair')::int AS problems,
              (SELECT count(*) FROM equipment_check_items i WHERE i.check_id = c.id AND i.result = 'repair' AND i.resolved_at IS NULL)::int AS open
         FROM live_equipment_checks c LEFT JOIN trailers t ON t.id = c.trailer_id
         ${where} ORDER BY c.check_date DESC, c.created_at DESC LIMIT $${params.length}`,
      params,
    );
  });

  app.get("/equipment-checks/:id", crewOfShop, async (req) => {
    const d = await loadCheck(uuidParam(req.params));
    if (!d) throw notFound("Equipment check not found.");
    return { ...d, trash: await trashInfo("equipment_check", d.check.id) };
  });

  // Open problems on equipment in use, oldest first (repairs board, home screen).
  app.get("/equipment-findings", crewOfShop, async () =>
    (await q(
      `SELECT i.id, i.label_snapshot AS label, i.section, i.note, c.id AS check_id, c.check_date, c.checker_name,
              e.id AS equipment_id, e.tag, e.type, t.trailer_number,
              (current_date - c.check_date) AS days_open,
              ARRAY(SELECT ph.id FROM photos ph WHERE ph.equipment_check_item_id = i.id ORDER BY ph.created_at, ph.id) AS photo_ids
         FROM equipment_check_items i
         JOIN live_equipment_checks c ON c.id = i.check_id
         JOIN equipment e ON e.id = i.equipment_id
         LEFT JOIN trailers t ON t.id = e.trailer_id
        WHERE i.result = 'repair' AND i.resolved_at IS NULL AND e.active
        ORDER BY c.check_date, c.created_at, lower(e.tag), i.id LIMIT 1000`,
    )).map((f) => ({ ...f, type_title: typeTitle(f.type) })));

  app.post("/equipment-findings/:id/resolve", crewOfShop, async (req) => {
    const note = reqStr(obj(req.body ?? {}).note, "Resolution note", 1000);
    const r = await one(
      `UPDATE equipment_check_items SET resolved_at = now(), resolved_by = $2, resolution_note = $3
        WHERE id = $1 AND result = 'repair' AND resolved_at IS NULL
          AND check_id IN (SELECT id FROM live_equipment_checks) RETURNING id`,
      [idParam(req.params), req.user!.id, note],
    );
    if (!r) throw conflict("That problem is already resolved, isn't a problem, or its check is in the trash.");
    return { ok: true };
  });
}

