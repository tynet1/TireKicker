import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { requireRole, requireUser } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import { defaultDiagram, diagramUrl, pickDiagram } from "../diagrams.ts";
import {
  bad, conflict, DATE_RE, HttpError, idParam, int, isValidDate, notFound, obj, reqStr, str, UUID_RE, uuidParam,
} from "../http.ts";
import { renderInspectionPdf } from "../pdf.ts";
import { decodePngDataUrl, discardUnlessUsed, files, newKey } from "../storage.ts";
import { attachFailed, isUnattached, OWNER_COLUMNS, UNATTACHED } from "../photo-owners.ts";

type Section = "exterior" | "interior" | "trailer";

interface ItemIn { checklist_item_id: number; result: "ok" | "repair"; note: string | null }
interface DamageIn { key: string; diagram: "truck" | "trailer"; x: number; y: number; note: string | null }
interface PhotoIn { id: string; caption: string | null; damage_key: string | null; checklist_item_id: number | null }

export interface SubmitInput {
  client_id: string;
  vehicle_id: number;
  inspection_date: string;
  inspector_name: string;
  mileage: number;
  oil_change_due: boolean;
  existing_notes: string | null;
  new_observations: string | null;
  comments: string | null;
  trailer: { number: string | null; plate: string | null } | null;
  /** The pictures the phone showed (older drafts don't send these; the truck's current ones are used). */
  truck_diagram_id: number | null;
  trailer_diagram_id: number | null;
  /**
   * When the phone fetched the checklist it showed (form-config's as_of). Items added to the checklist after that aren't
   * required; older drafts and cached forms don't send it, and then every current item is.
   */
  checklist_as_of: Date | null;
  items: ItemIn[];
  damage: DamageIn[];
  photos: PhotoIn[];
  signature: Buffer;
}

function arr(v: unknown, field: string, max: number): unknown[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad(`${field} must be a list.`);
  if (v.length > max) throw bad(`Too many ${field}.`);
  return v;
}

function frac(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw bad(`${field} must be between 0 and 1.`);
  return Math.round(v * 10000) / 10000;
}

/** Shape-check the submit body. Business rules that need the database are checked in submitInspection. */
export function parseSubmit(body: unknown): SubmitInput {
  const b = obj(body);
  const clientId = String(b.client_id ?? "").toLowerCase();
  if (!UUID_RE.test(clientId)) throw bad("client_id must be a uuid.");
  const date = String(b.inspection_date ?? "");
  if (!DATE_RE.test(date) || !isValidDate(date)) throw bad("Date is required.");
  const today = new Date();
  const max = new Date(today.getTime() + 2 * 86400_000).toISOString().slice(0, 10);
  if (date > max || date < "2020-01-01") throw bad("Date looks wrong. Check the inspection date.");
  if (typeof b.oil_change_due !== "boolean") throw bad("Answer whether an oil change is due.");
  const sig = decodePngDataUrl(b.signature);
  if (!sig) throw bad("Employee signature is required.");

  let trailer: SubmitInput["trailer"] = null;
  if (b.trailer != null) {
    const t = obj(b.trailer, "trailer");
    trailer = { number: str(t.number, "Trailer number", 50), plate: str(t.plate, "Trailer plate", 20) };
  }

  let asOf: Date | null = null;
  if (b.checklist_as_of != null) {
    const t = new Date(String(b.checklist_as_of));
    if (Number.isNaN(t.getTime())) throw bad("checklist_as_of must be a date and time.");
    asOf = t;
  }

  const items = arr(b.items, "checklist items", 200).map((x, i): ItemIn => {
    const o = obj(x, `item ${i + 1}`);
    if (o.result !== "ok" && o.result !== "repair") throw bad("Each checklist item must be OK or Repair.");
    return { checklist_item_id: int(o.checklist_item_id, "checklist_item_id", 1), result: o.result, note: str(o.note, "Repair note", 1000) };
  });

  const keys = new Set<string>();
  const damage = arr(b.damage, "damage marks", 99).map((x, i): DamageIn => {
    const o = obj(x, `damage mark ${i + 1}`);
    const key = String(o.key ?? "");
    if (!/^[\w-]{1,40}$/.test(key) || keys.has(key)) throw bad("Each damage mark needs a unique key.");
    keys.add(key);
    if (o.diagram !== "truck" && o.diagram !== "trailer") throw bad("Damage mark diagram must be truck or trailer.");
    return { key, diagram: o.diagram, x: frac(o.x, "x"), y: frac(o.y, "y"), note: str(o.note, "Damage note", 500) };
  });

  const photoIds = new Set<string>();
  const photos = arr(b.photos, "photos", 60).map((x): PhotoIn => {
    const o = obj(x, "photo");
    const id = String(o.id ?? "").toLowerCase();
    if (!UUID_RE.test(id) || photoIds.has(id)) throw bad("Each photo needs a unique id.");
    photoIds.add(id);
    const damageKey = o.damage_key == null ? null : String(o.damage_key);
    if (damageKey && !keys.has(damageKey)) throw bad("Photo points at a damage mark that isn't in this inspection.");
    return {
      id,
      caption: str(o.caption, "Photo caption", 300),
      damage_key: damageKey,
      checklist_item_id: o.checklist_item_id == null ? null : int(o.checklist_item_id, "checklist_item_id", 1),
    };
  });

  return {
    client_id: clientId,
    vehicle_id: int(b.vehicle_id, "vehicle_id", 1),
    inspection_date: date,
    inspector_name: reqStr(b.inspector_name, "Inspector name", 100),
    mileage: int(b.mileage, "Mileage", 0, 9_999_999),
    oil_change_due: b.oil_change_due,
    existing_notes: str(b.existing_notes, "Existing notes", 5000),
    new_observations: str(b.new_observations, "New observations", 5000),
    comments: str(b.comments, "Comments", 5000),
    trailer,
    truck_diagram_id: b.truck_diagram_id == null ? null : int(b.truck_diagram_id, "truck_diagram_id", 1),
    trailer_diagram_id: b.trailer_diagram_id == null ? null : int(b.trailer_diagram_id, "trailer_diagram_id", 1),
    checklist_as_of: asOf,
    items,
    damage,
    photos,
    signature: sig,
  };
}

async function existingByClientId(clientId: string) {
  return one<{ id: string; mileage_flagged: boolean }>(
    `SELECT id, mileage_flagged FROM inspections WHERE client_id = $1`, [clientId]);
}

/**
 * Validate against the database and store the inspection. Idempotent on client_id:
 * a retried submit returns the record that already exists.
 */
export async function submitInspection(input: SubmitInput, userId: number) {
  const dup = await existingByClientId(input.client_id);
  if (dup) return { ...dup, duplicate: true };

  const vehicle = await one<{ id: number; diagram_id: number | null; trailer_diagram_id: number | null }>(
    `SELECT id, diagram_id, trailer_diagram_id FROM vehicles WHERE id = $1 AND active`, [input.vehicle_id]);
  if (!vehicle) throw bad("That truck isn't in the active fleet.");
  // Record the pictures the pins were placed on, so later changes to the truck never move them.
  const truckDiagram = await pickDiagram([input.truck_diagram_id, vehicle.diagram_id], "truck");
  const trailerDiagram = input.trailer ? await pickDiagram([input.trailer_diagram_id, vehicle.trailer_diagram_id], "trailer") : null;

  // Answers must be to checklist items in the visible sections; retired ones still count (the form may have shown them
  // before an admin retired them). Every active item must be answered, except ones added to the checklist after the
  // phone loaded it (checklist_as_of), so editing the checklist never bounces an inspection that's being filled in.
  // A claimed checklist time is taken back at most 90 days, so the original items can never be skipped.
  const sections: Section[] = input.trailer ? ["exterior", "interior", "trailer"] : ["exterior", "interior"];
  const checklist = await q<{ id: number; section: Section; label: string; active: boolean; required: boolean }>(
    `SELECT id, section, label, active,
            active AND created_at <= GREATEST(LEAST(COALESCE($2::timestamptz, now()), now()), now() - interval '90 days') AS required
       FROM checklist_items WHERE section = ANY($1::checklist_section[]) ORDER BY section, sort_order, id`,
    [sections, input.checklist_as_of],
  );
  const byId = new Map(checklist.map((c) => [c.id, c]));
  const answered = new Map<number, ItemIn>();
  for (const it of input.items) {
    if (!byId.has(it.checklist_item_id)) {
      throw new HttpError(422, "The checklist changed since this form was opened. Reload the form and check the items again.", { code: "checklist_changed" });
    }
    if (answered.has(it.checklist_item_id)) throw bad("A checklist item was answered twice.");
    answered.set(it.checklist_item_id, it);
  }
  const missing = checklist.filter((c) => c.required && !answered.has(c.id));
  if (missing.length) {
    throw new HttpError(422, `${missing.length} checklist item(s) still need an answer.`, { missing: missing.map((m) => m.id) });
  }
  const noNote = input.items.filter((i) => i.result === "repair" && !i.note);
  if (noNote.length) {
    throw new HttpError(422, "Every Repair needs a short note.", { missing_notes: noNote.map((i) => i.checklist_item_id) });
  }
  for (const p of input.photos) {
    if (p.checklist_item_id != null && !answered.has(p.checklist_item_id)) throw bad("Photo points at a checklist item that isn't in this inspection.");
  }

  // Photos must already be uploaded and not attached to anything yet. (Whoever is signed in on the phone may send them:
  // a shared phone's queue can go out under the next person to sign in. Photo ids are random and known only to that phone.)
  if (input.photos.length) {
    const ids = input.photos.map((p) => p.id);
    const found = await q(
      `SELECT id, uploaded_by, ${OWNER_COLUMNS} FROM photos WHERE id = ANY($1::uuid[])`, [ids]);
    const ok = new Set(found.filter((f) => isUnattached(f)).map((f) => f.id));
    const notReady = ids.filter((id) => !ok.has(id));
    if (notReady.length) {
      throw new HttpError(422, "Some photos haven't finished uploading yet.", { code: "photos_missing", photos: notReady });
    }
  }

  const prev = await one<{ mileage: number | null }>(
    `SELECT mileage FROM live_inspections WHERE vehicle_id = $1 ORDER BY inspection_date DESC, created_at DESC LIMIT 1`,
    [input.vehicle_id],
  );
  const previousMileage = prev?.mileage ?? null;
  const mileageFlagged = previousMileage != null && input.mileage < previousMileage;

  const sigKey = newKey("png");
  await files.put(sigKey, input.signature);

  try {
    return await tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO inspections (
           client_id, vehicle_id, trailer_id, trailer_number_text, trailer_plate_text, trailer_inspected,
           inspection_date, inspector_user_id, inspector_name, mileage, oil_change_due,
           existing_notes, new_observations, comments, employee_signature_path, previous_mileage, mileage_flagged,
           truck_diagram_id, trailer_diagram_id)
         VALUES ($1, $2,
           (SELECT id FROM trailers WHERE active AND lower(trailer_number) = lower($3) LIMIT 1), $3, $4, $5,
           $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (client_id) DO NOTHING
         RETURNING id, mileage_flagged`,
        [
          input.client_id, input.vehicle_id, input.trailer?.number ?? null, input.trailer?.plate ?? null, !!input.trailer,
          input.inspection_date, userId, input.inspector_name, input.mileage, input.oil_change_due,
          input.existing_notes, input.new_observations, input.comments, sigKey, previousMileage, mileageFlagged,
          truckDiagram?.id ?? null, trailerDiagram?.id ?? null,
        ],
      );
      if (!ins.rows[0]) throw new DuplicateSubmit();
      const id: string = ins.rows[0].id;
      await insertChildren(c, id, input, checklist);
      return { id, mileage_flagged: ins.rows[0].mileage_flagged as boolean, duplicate: false };
    });
  } catch (e) {
    await discardUnlessUsed(sigKey, async () => !!(await one(`SELECT 1 FROM inspections WHERE employee_signature_path = $1`, [sigKey])));
    if (e instanceof DuplicateSubmit) {
      const d = await existingByClientId(input.client_id);
      if (d) return { ...d, duplicate: true };
    }
    throw e;
  }
}

class DuplicateSubmit extends Error {}

async function insertChildren(c: PoolClient, id: string, input: SubmitInput, checklist: { id: number; section: Section; label: string }[]) {
  const answers = new Map(input.items.map((i) => [i.checklist_item_id, i]));
  const itemIds = new Map<number, number>();
  for (const ci of checklist) {
    // Only what the phone answered: retired items it didn't show and items added after it loaded the form are skipped.
    const a = answers.get(ci.id);
    if (!a) continue;
    const r = await c.query(
      `INSERT INTO inspection_items (inspection_id, checklist_item_id, section, label_snapshot, result, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [id, ci.id, ci.section, ci.label, a.result, a.result === "repair" ? a.note : null],
    );
    itemIds.set(ci.id, r.rows[0].id);
  }
  const markIds = new Map<string, number>();
  const seq = { truck: 0, trailer: 0 };
  for (const d of input.damage) {
    if (d.diagram === "trailer" && !input.trailer) continue;
    const r = await c.query(
      `INSERT INTO damage_marks (inspection_id, diagram, seq, x, y, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [id, d.diagram, ++seq[d.diagram], d.x, d.y, d.note],
    );
    markIds.set(d.key, r.rows[0].id);
  }
  for (const p of input.photos) {
    const r = await c.query(
      `UPDATE photos SET inspection_id = $2, caption = $3, damage_mark_id = $4, inspection_item_id = $5
        WHERE id = $1 AND ${UNATTACHED}`,
      [p.id, id, p.caption, p.damage_key ? markIds.get(p.damage_key) ?? null : null,
        p.checklist_item_id ? itemIds.get(p.checklist_item_id) ?? null : null],
    );
    if (r.rowCount !== 1) throw await attachFailed(c, p.id, "A photo was attached to another inspection. Remove it and try again.");
  }
}

export type InspectionState = "active" | "archived" | "deleted";
type StateAction = "archive" | "unarchive" | "delete" | "restore";

/** Which state each action moves an inspection from and to. */
const TRANSITIONS: Record<StateAction, { from: InspectionState[]; to: InspectionState }> = {
  archive: { from: ["active"], to: "archived" },
  unarchive: { from: ["archived"], to: "active" },
  delete: { from: ["active", "archived"], to: "deleted" },
  restore: { from: ["deleted"], to: "active" },
};
const ALREADY: Record<InspectionState, string> = {
  active: "This inspection isn't archived or deleted.",
  archived: "This inspection is already archived.",
  deleted: "This inspection is deleted. Restore it first (Admin → Trash).",
};

/**
 * Archive, un-archive, delete or restore an inspection. The inspection row itself never changes (it's read-only);
 * the state lives in inspection_states and every change is appended to inspection_state_history.
 */
export async function changeInspectionState(id: string, action: StateAction, userId: number, reason: string | null) {
  const t = TRANSITIONS[action];
  return tx(async (c) => {
    // Lock the inspection so two people archiving/deleting at once are applied one after the other.
    const insp = (await c.query(`SELECT id FROM inspections WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!insp) throw notFound("Inspection not found.");
    const cur = (await c.query(`SELECT state FROM inspection_states WHERE inspection_id = $1`, [id])).rows[0];
    const from = (cur?.state ?? "active") as InspectionState;
    if (!t.from.includes(from)) throw conflict(ALREADY[from]);
    await c.query(
      `INSERT INTO inspection_states (inspection_id, state, reason, changed_at, changed_by) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (inspection_id) DO UPDATE SET state = $2, reason = $3, changed_at = now(), changed_by = $4`,
      [id, t.to, t.to === "active" ? null : reason, userId],
    );
    await c.query(
      `INSERT INTO inspection_state_history (inspection_id, action, reason, changed_by) VALUES ($1, $2, $3, $4)`,
      [id, action, reason, userId],
    );
    return { state: t.to };
  });
}

/**
 * The registration date that was on file for an inspection `i` of truck `v`: the one a supervisor set while signing
 * it off, else the one on file when it was submitted (the first later change's "previous"), else today's.
 * Use REG_ON_FILE as a column and REG_ON_FILE_JOINS after the joins.
 */
export const REG_ON_FILE = `CASE WHEN rs.id IS NOT NULL THEN rs.expires WHEN ra.id IS NOT NULL THEN ra.previous
                 ELSE v.registration_expires END`;
export const REG_ON_FILE_JOINS = `
       LEFT JOIN LATERAL (
         SELECT r.id, r.expires FROM registration_changes r WHERE r.inspection_id = i.id
          ORDER BY r.changed_at DESC, r.id DESC LIMIT 1) rs ON true
       LEFT JOIN LATERAL (
         SELECT r.id, r.previous FROM registration_changes r WHERE r.vehicle_id = i.vehicle_id AND r.changed_at > i.created_at
          ORDER BY r.changed_at, r.id LIMIT 1) ra ON true`;

/** Everything about one inspection, for the detail screen and the PDF. */
export async function loadInspection(id: string) {
  const i = await one(
    `SELECT i.*, v.truck_code, v.unit, v.vin, v.plate, v.year, v.make, v.model,
            ${REG_ON_FILE} AS registration_expires,
            v.registration_expires AS truck_registration_expires,
            d.id AS diagram_id, d.file_path AS diagram_path,
            td.id AS trailer_dia_id, td.file_path AS trailer_dia_path, td.name AS trailer_type
       FROM inspections i
       JOIN vehicles v ON v.id = i.vehicle_id
       LEFT JOIN diagrams d ON d.id = COALESCE(i.truck_diagram_id, v.diagram_id)
       LEFT JOIN diagrams td ON td.id = COALESCE(i.trailer_diagram_id, v.trailer_diagram_id)
       ${REG_ON_FILE_JOINS}
      WHERE i.id = $1`,
    [id],
  );
  if (!i) return null;
  const items = await q(
    `SELECT ii.id, ii.checklist_item_id, ii.section, ii.label_snapshot AS label, ii.result, ii.note,
            ii.resolved_at, ii.resolution_note, ru.name AS resolved_by_name,
            (SELECT r.service_log_id FROM service_log_repairs r
              WHERE r.inspection_item_id = ii.id AND r.active) AS service_log_id
       FROM inspection_items ii
       LEFT JOIN users ru ON ru.id = ii.resolved_by
      WHERE ii.inspection_id = $1
      ORDER BY ii.section, ii.id`, // saved in the order the form showed them, so reordering the checklist never reshuffles old ones
    [id],
  );
  const damage = await q(
    `SELECT id, diagram, seq, x, y, note FROM damage_marks WHERE inspection_id = $1 ORDER BY diagram, seq`, [id]);
  const photos = await q(
    `SELECT id, caption, damage_mark_id, inspection_item_id, file_path FROM photos WHERE inspection_id = $1 ORDER BY created_at, id`,
    [id],
  );
  const truckFallback = i.diagram_id ? null : await defaultDiagram("truck");
  const trailerFallback = i.trailer_dia_id ? null : await defaultDiagram("trailer");
  const state = await one(
    `SELECT s.state, s.reason, s.changed_at, u.name AS changed_by_name
       FROM inspection_states s JOIN users u ON u.id = s.changed_by WHERE s.inspection_id = $1`,
    [id],
  );
  const stateHistory = await q(
    `SELECT h.action, h.reason, h.changed_at, u.name AS changed_by_name
       FROM inspection_state_history h JOIN users u ON u.id = h.changed_by
      WHERE h.inspection_id = $1 ORDER BY h.changed_at, h.id`,
    [id],
  );
  return {
    inspection: i,
    state: (state?.state ?? "active") as InspectionState,
    stateInfo: state && state.state !== "active"
      ? { reason: state.reason as string | null, changed_at: state.changed_at as string, changed_by_name: state.changed_by_name as string }
      : null,
    stateHistory,
    items,
    damage,
    photos,
    truckDiagram: { id: i.diagram_id ?? truckFallback?.id ?? null, file_path: i.diagram_path ?? truckFallback?.file_path ?? null },
    trailerDiagram: i.trailer_dia_id
      ? { id: i.trailer_dia_id as number, name: i.trailer_type as string, file_path: i.trailer_dia_path as string }
      : trailerFallback ?? null,
  };
}

export default async function inspectionRoutes(app: FastifyInstance) {
  app.get("/inspections", async (req) => {
    requireUser(req);
    const qs = (req.query ?? {}) as Record<string, string | undefined>;
    const limit = Math.min(Number(qs.limit) || 30, 200);
    const where: string[] = [];
    const params: unknown[] = [];
    if (qs.status === "submitted" || qs.status === "reviewed") {
      params.push(qs.status);
      where.push(`i.status = $${params.length}`);
    }
    if (qs.vehicle_id && /^\d+$/.test(qs.vehicle_id)) {
      params.push(Number(qs.vehicle_id));
      where.push(`i.vehicle_id = $${params.length}`);
    }
    // Inspection date range (inclusive), for the export screen.
    for (const [key, op] of [["from", ">="], ["to", "<="]] as const) {
      const v = qs[key];
      if (!v) continue;
      if (!isValidDate(v)) throw bad(`"${key}" must be a date like 2026-11-10.`);
      params.push(v);
      where.push(`i.inspection_date ${op} $${params.length}::date`);
    }
    // Archived and deleted inspections are left out unless asked for: archived=only (just archived ones) or
    // archived=include (live and archived). Deleted ones are only listed under Admin → Trash.
    const st = "COALESCE(st.state, 'active')";
    if (qs.archived === "only") where.push(`${st} = 'archived'`);
    else if (qs.archived === "include") where.push(`${st} IN ('active', 'archived')`);
    else where.push(`${st} = 'active'`);
    params.push(limit);
    return q(
      `SELECT i.id, i.vehicle_id, v.truck_code, i.inspection_date, i.inspector_name, i.mileage, i.status, i.mileage_flagged,
              ${st} AS state,
              (SELECT count(*) FROM inspection_items ii WHERE ii.inspection_id = i.id AND ii.result = 'repair') AS repair_count,
              (SELECT count(*) FROM inspection_items ii
                WHERE ii.inspection_id = i.id AND ii.result = 'repair' AND ii.resolved_at IS NULL) AS open_repair_count
         FROM inspections i JOIN vehicles v ON v.id = i.vehicle_id
         LEFT JOIN inspection_states st ON st.inspection_id = i.id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY i.created_at DESC LIMIT $${params.length}`,
      params,
    );
  });

  app.post("/inspections", { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    const user = requireUser(req);
    const input = parseSubmit(req.body);
    const out = await submitInspection(input, user.id);
    return reply.code(out.duplicate ? 200 : 201).send(out);
  });

  app.get("/inspections/:id", async (req) => {
    requireUser(req);
    const data = await loadInspection(uuidParam(req.params));
    if (!data) throw notFound("Inspection not found.");
    const { inspection: i, state, stateInfo, stateHistory, items, damage, photos, truckDiagram, trailerDiagram } = data;
    return {
      id: i.id,
      status: i.status,
      state,
      state_info: stateInfo,
      state_history: stateHistory,
      vehicle: {
        id: i.vehicle_id, truck_code: i.truck_code, unit: i.unit, vin: i.vin, plate: i.plate,
        year: i.year, make: i.make, model: i.model,
        registration_expires: i.truck_registration_expires, // the truck's date today
      },
      registration_expires: i.registration_expires, // the date on file for this inspection (what its PDF shows)
      inspection_date: i.inspection_date,
      inspector_name: i.inspector_name,
      mileage: i.mileage,
      previous_mileage: i.previous_mileage,
      mileage_flagged: i.mileage_flagged,
      oil_change_due: i.oil_change_due,
      existing_notes: i.existing_notes,
      new_observations: i.new_observations,
      comments: i.comments,
      trailer: i.trailer_inspected
        ? { number: i.trailer_number_text, plate: i.trailer_plate_text, type: trailerDiagram?.name ?? null }
        : null,
      created_at: i.created_at,
      items,
      damage,
      photos: photos.map(({ file_path, ...p }) => p),
      truck_diagram_url: diagramUrl(truckDiagram.id, truckDiagram.file_path),
      trailer_diagram_url: trailerDiagram ? diagramUrl(trailerDiagram.id, trailerDiagram.file_path) : null,
      employee_signature_url: `/api/inspections/${i.id}/signature/employee`,
      supervisor: i.status === "reviewed"
        ? {
          name: i.supervisor_name, signed_at: i.supervisor_signed_at, note: i.supervisor_note,
          signature_url: `/api/inspections/${i.id}/signature/supervisor`,
        }
        : null,
    };
  });

  app.get("/inspections/:id/signature/:who", async (req, reply) => {
    requireUser(req);
    const who = (req.params as { who: string }).who;
    if (who !== "employee" && who !== "supervisor") throw notFound();
    const col = who === "employee" ? "employee_signature_path" : "supervisor_signature_path";
    const r = await one(`SELECT ${col} AS path FROM inspections WHERE id = $1`, [uuidParam(req.params)]);
    if (!r?.path) throw notFound();
    return reply.type("image/png").header("cache-control", "private, max-age=31536000, immutable").send(files.stream(r.path));
  });

  app.post("/inspections/:id/review", { preHandler: requireRole("supervisor") }, async (req) => {
    const user = req.user!;
    const id = uuidParam(req.params);
    const b = obj(req.body);
    const sig = decodePngDataUrl(b.signature);
    if (!sig) throw bad("Supervisor signature is required.");
    const note = str(b.note, "Supervisor note", 2000);
    const name = str(b.name, "Supervisor name", 100) ?? user.name;
    const key = newKey("png");
    await files.put(key, sig);
    const r = await one(
      `UPDATE inspections SET status = 'reviewed', supervisor_user_id = $2, supervisor_name = $3,
              supervisor_signature_path = $4, supervisor_signed_at = now(), supervisor_note = $5
        WHERE id = $1 AND status = 'submitted'
          AND NOT EXISTS (SELECT 1 FROM inspection_states s WHERE s.inspection_id = $1 AND s.state = 'deleted')
        RETURNING id`,
      [id, user.id, name, key, note],
    );
    if (!r) {
      await files.remove(key).catch(() => {});
      const exists = await one(
        `SELECT i.status, s.state FROM inspections i LEFT JOIN inspection_states s ON s.inspection_id = i.id WHERE i.id = $1`, [id]);
      if (!exists) throw notFound("Inspection not found.");
      if (exists.state === "deleted") throw conflict(ALREADY.deleted);
      throw conflict("This inspection was already signed off.");
    }
    return { ok: true };
  });

  // Archive (supervisor+) and delete (admin) never erase anything; see changeInspectionState.
  const reasonOf = (body: unknown, required: boolean) => {
    const b = obj(body ?? {});
    return required ? reqStr(b.reason, "Reason", 500) : str(b.reason, "Reason", 500);
  };
  app.post("/inspections/:id/archive", { preHandler: requireRole("supervisor") }, async (req) =>
    changeInspectionState(uuidParam(req.params), "archive", req.user!.id, reasonOf(req.body, false)));
  app.post("/inspections/:id/unarchive", { preHandler: requireRole("supervisor") }, async (req) =>
    changeInspectionState(uuidParam(req.params), "unarchive", req.user!.id, null));
  app.post("/inspections/:id/delete", { preHandler: requireRole("admin") }, async (req) =>
    changeInspectionState(uuidParam(req.params), "delete", req.user!.id, reasonOf(req.body, true)));
  app.post("/inspections/:id/restore", { preHandler: requireRole("admin") }, async (req) =>
    changeInspectionState(uuidParam(req.params), "restore", req.user!.id, null));

  // Deleted inspections (older copies of the app's Admin → Deleted tab; Admin → Trash lists everything now).
  app.get("/admin/deleted-inspections", { preHandler: requireRole("admin") }, async () =>
    q(`SELECT i.id, i.vehicle_id, v.truck_code, i.inspection_date, i.inspector_name, i.mileage, i.status,
              s.reason, s.changed_at AS deleted_at, u.name AS deleted_by_name
         FROM inspection_states s
         JOIN inspections i ON i.id = s.inspection_id
         JOIN vehicles v ON v.id = i.vehicle_id
         JOIN users u ON u.id = s.changed_by
        WHERE s.state = 'deleted'
        ORDER BY s.changed_at DESC LIMIT 500`));

  // Repairs board: every open repair across the fleet (live inspections, trucks in service), oldest first per truck.
  app.get("/repairs", { preHandler: requireRole("supervisor", "shop") }, async (req) => {
    const qs = (req.query ?? {}) as Record<string, string | undefined>;
    const params: unknown[] = [];
    let truck = "";
    if (qs.vehicle_id) {
      if (!/^\d+$/.test(qs.vehicle_id)) throw bad("vehicle_id must be a number.");
      params.push(Number(qs.vehicle_id));
      truck = `AND v.id = $${params.length}`;
    }
    return q(
      `SELECT ii.id, ii.section, ii.label_snapshot AS label, ii.note,
              i.id AS inspection_id, i.inspection_date, i.inspector_name,
              v.id AS vehicle_id, v.truck_code, v.year, v.make, v.model,
              (current_date - i.inspection_date) AS days_open,
              ARRAY(SELECT p.id FROM photos p WHERE p.inspection_item_id = ii.id ORDER BY p.created_at, p.id) AS photo_ids,
              ARRAY(SELECT ti.ticket_id FROM repair_ticket_items ti JOIN repair_tickets t ON t.id = ti.ticket_id
                     WHERE ti.inspection_item_id = ii.id AND t.voided_at IS NULL ORDER BY ti.ticket_id) AS ticket_ids
         FROM inspection_items ii
         JOIN live_inspections i ON i.id = ii.inspection_id
         JOIN vehicles v ON v.id = i.vehicle_id
        WHERE ii.result = 'repair' AND ii.resolved_at IS NULL AND v.active ${truck}
        ORDER BY v.truck_code, i.inspection_date, i.created_at, ii.section, ii.id
        LIMIT 2000`,
      params,
    );
  });

  app.post("/inspection-items/:id/resolve", { preHandler: requireRole("supervisor", "shop") }, async (req) => {
    const id = idParam(req.params);
    const b = obj(req.body ?? {});
    const note = reqStr(b.note, "Resolution note", 1000);
    const r = await one(
      `UPDATE inspection_items SET resolved_at = now(), resolved_by = $2, resolution_note = $3
        WHERE id = $1 AND result = 'repair' AND resolved_at IS NULL RETURNING id`,
      [id, req.user!.id, note],
    );
    if (!r) throw conflict("That repair is already resolved or isn't a repair item.");
    return { ok: true };
  });

  app.get("/inspections/:id/pdf", { preHandler: requireRole("supervisor") }, async (req, reply) => {
    const data = await loadInspection(uuidParam(req.params));
    if (!data) throw notFound("Inspection not found.");
    const pdf = await renderInspectionPdf(data);
    const name = `${data.inspection.truck_code}_${data.inspection.inspection_date}_inspection.pdf`.replace(/[^\w.-]/g, "_");
    return reply
      .type("application/pdf")
      .header("content-disposition", `attachment; filename="${name}"`)
      .header("cache-control", "no-store")
      .send(pdf);
  });
}
