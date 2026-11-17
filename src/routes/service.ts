// Maintenance log (phase 2): the shop manager records work done on a truck.
// Data safety (SPEC §4a): entries are voided, never deleted; each edit keeps the previous version
// (database trigger); a stale edit is refused instead of overwriting someone else's change.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { requireRole } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import { bad, conflict, HttpError, idParam, int, isValidDate, notFound, obj, reqStr, str, UUID_RE } from "../http.ts";

export const CATEGORIES: Record<string, string> = {
  oil_change: "Oil change",
  tires: "Tires",
  brakes: "Brakes",
  repair: "Repair",
  preventive: "Preventive maintenance",
  inspection: "Inspection / registration",
  other: "Other",
};

/**
 * Which open repairs the form ticks for you when you pick a type of work (matched on the checklist label,
 * truck sections only). They're only suggestions: the shop sees the ticks and can untick anything not fixed.
 */
export const AUTO_TICK: Record<string, { match: string; not?: string; sections: string[] }> = {
  oil_change: { match: "\\boil\\b", sections: ["exterior", "interior"] },
  tires: { match: "\\btires?\\b", sections: ["exterior", "interior"] },
  brakes: { match: "brake", not: "light", sections: ["exterior", "interior"] },
  inspection: { match: "registration|license plate|reg tag", sections: ["exterior", "interior"] },
};

/** Fields an entry has, in the order the history shows them. */
const FIELDS = [
  "service_date", "mileage", "work", "description", "parts", "cost", "performed_by", "vendor", "notes",
] as const;
/** Fields plus the old single-type columns, which mirror the first type of work (007). */
type Fields = Record<string, unknown>;

/** One type of work on an entry, with its own next-due. */
export interface WorkItem { type: string; next_due_mileage: number | null; next_due_date: string | null }

/** An entry's types of work; rows from before 007 (history) only have the single-type columns. */
export function workOf(row: Record<string, unknown>): WorkItem[] {
  const raw = Array.isArray(row.work) ? row.work as Record<string, unknown>[]
    : [{ type: row.category, next_due_mileage: row.next_due_mileage, next_due_date: row.next_due_date }];
  return raw.map((w) => ({
    type: String(w.type ?? "other"),
    next_due_mileage: w.next_due_mileage == null ? null : Number(w.next_due_mileage),
    next_due_date: w.next_due_date ? String(w.next_due_date).slice(0, 10) : null,
  }));
}
const sameWork = (a: WorkItem[], b: WorkItem[]) => JSON.stringify(a) === JSON.stringify(b);
export const workLabel = (work: WorkItem[]) => work.map((w) => CATEGORIES[w.type] ?? w.type).join(", ");
const usDate = (s: string) => { const [y, m, d] = s.split("-"); return `${+m}/${+d}/${y}`; };
/** "Oil change (next due 61,200 mi or 5/10/2027), Tires" for the edit history. */
function workText(work: WorkItem[]) {
  return work.map((w) => {
    const due = [w.next_due_mileage != null ? `${w.next_due_mileage.toLocaleString("en-US")} mi` : "",
      w.next_due_date ? usDate(w.next_due_date) : ""].filter(Boolean).join(" or ");
    return `${CATEGORIES[w.type] ?? w.type}${due ? ` (next due ${due})` : ""}`;
  }).join(", ");
}

const canRead = { preHandler: requireRole("supervisor", "shop") };
const canWrite = { preHandler: requireRole("admin", "shop") };

function optDate(v: unknown, label: string): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  if (!isValidDate(s)) throw bad(`${label} must be a date.`);
  return s;
}

function money(v: unknown): number | null {
  if (v == null || v === "") return null;
  const s = String(v).replace(/[$,\s]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) throw bad("Cost must be an amount like 125.50.");
  return Number(s);
}

/** Validate entry fields. On create every required field must be there; on edit only what was sent. */
export function parseFields(b: Record<string, unknown>, creating: boolean): Fields {
  const f: Fields = {};
  const has = (k: string) => creating || b[k] !== undefined;
  if (has("service_date")) {
    const d = String(b.service_date ?? "");
    if (!isValidDate(d)) throw bad("Date is required.");
    const max = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    if (d > max || d < "2000-01-01") throw bad("Date looks wrong. Check the service date.");
    f.service_date = d;
  }
  if (has("mileage")) f.mileage = int(b.mileage, "Mileage", 0, 9_999_999);
  const work = parseWork(b, creating);
  if (work) {
    f.work = work;
    // The old single-type columns mirror the first type, for anything older that still reads them.
    f.category = work[0].type;
    f.next_due_mileage = work[0].next_due_mileage;
    f.next_due_date = work[0].next_due_date;
  }
  if (has("description")) f.description = reqStr(b.description, "Work done", 2000);
  if (b.parts !== undefined) f.parts = str(b.parts, "Parts", 2000);
  if (b.cost !== undefined) f.cost = money(b.cost);
  if (b.performed_by !== undefined) f.performed_by = str(b.performed_by, "Done by", 100);
  if (b.vendor !== undefined) f.vendor = str(b.vendor, "Vendor", 100);
  if (b.notes !== undefined) f.notes = str(b.notes, "Notes", 5000);
  return f;
}

/**
 * Types of work: `work` = [{type, next_due_mileage?, next_due_date?}], at least one, each type once.
 * Older copies of the app (and saves queued on a phone before 007) send category + next_due_* instead; that becomes
 * a list of one, so nothing they saved is refused.
 */
function parseWork(b: Record<string, unknown>, creating: boolean): WorkItem[] | undefined {
  let raw = b.work;
  if (raw === undefined && b.category !== undefined) {
    raw = [{ type: b.category, next_due_mileage: b.next_due_mileage, next_due_date: b.next_due_date }];
  }
  if (raw === undefined) {
    if (creating) throw bad("Pick the type of work.");
    return undefined;
  }
  if (!Array.isArray(raw) || !raw.length) throw bad("Pick the type of work.");
  if (raw.length > Object.keys(CATEGORIES).length) throw bad("Too many types of work.");
  const seen = new Set<string>();
  return raw.map((x) => {
    const o = obj(x, "type of work");
    const type = String(o.type ?? "");
    if (!CATEGORIES[type]) throw bad("Pick the type of work.");
    if (seen.has(type)) throw bad(`${CATEGORIES[type]} is picked twice.`);
    seen.add(type);
    const label = CATEGORIES[type];
    return {
      type,
      next_due_mileage: o.next_due_mileage == null || o.next_due_mileage === ""
        ? null : int(o.next_due_mileage, `${label}: next due mileage`, 0, 9_999_999),
      next_due_date: optDate(o.next_due_date, `${label}: next due date`),
    };
  });
}

/** SQL placeholder and value for a column (work is stored as jsonb). */
const ph = (k: string, n: number) => (k === "work" ? `$${n}::jsonb` : `$${n}`);
const val = (k: string, v: unknown) => (k === "work" ? JSON.stringify(v) : v);

function idList(v: unknown, field: string, max: number): number[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) throw bad(`${field} must be a list.`);
  return [...new Set(v.map((x) => int(x, field, 1)))];
}

type EntryPhoto = { id: string; caption: string | null; damage_mark_id: number | null };

function photoList(v: unknown): EntryPhoto[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > 40) throw bad("Too many photos.");
  const seen = new Set<string>();
  return v.map((x) => {
    const o = obj(x, "photo");
    const id = String(o.id ?? "").toLowerCase();
    if (!UUID_RE.test(id) || seen.has(id)) throw bad("Each photo needs a unique id.");
    seen.add(id);
    // damage_mark_id: this photo shows that damage mark fixed (required for each damage the entry fixes).
    const mark = o.damage_mark_id == null || o.damage_mark_id === "" ? null : int(o.damage_mark_id, "damage_mark_id", 1);
    return { id, caption: str(o.caption, "Photo caption", 300), damage_mark_id: mark };
  });
}

/** Photos must be uploaded by this user and not attached anywhere else (or already on this entry). */
async function checkPhotos(photos: { id: string }[], userId: number, entryId: number | null) {
  if (!photos.length) return;
  const ids = photos.map((p) => p.id);
  const found = await q(
    `SELECT id, inspection_id, service_log_id, damage_repair_id, registration_change_id, uploaded_by FROM photos WHERE id = ANY($1::uuid[])`, [ids]);
  const ok = new Set(found
    .filter((f) => f.inspection_id == null && (f.service_log_id == null
      ? f.damage_repair_id == null && f.registration_change_id == null && f.uploaded_by === userId
      : f.service_log_id === entryId))
    .map((f) => f.id));
  const notReady = ids.filter((id) => !ok.has(id));
  if (notReady.length) {
    throw new HttpError(422, "Some photos haven't finished uploading yet.", { code: "photos_missing", photos: notReady });
  }
}

/** Attach new photos to the entry; a photo of a fixed damage mark also points at that damage repair. */
async function attachPhotos(c: PoolClient, entryId: number, photos: EntryPhoto[], userId: number, repairOf = new Map<number, number>()) {
  for (const p of photos) {
    const r = await c.query(
      `UPDATE photos SET service_log_id = $2, caption = $3, damage_repair_id = $5
        WHERE id = $1 AND uploaded_by = $4 AND inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL AND registration_change_id IS NULL`,
      [p.id, entryId, p.caption, userId, p.damage_mark_id ? repairOf.get(p.damage_mark_id) ?? null : null],
    );
    if (r.rowCount === 1) continue;
    const mine = await c.query(`SELECT 1 FROM photos WHERE id = $1 AND service_log_id = $2`, [p.id, entryId]);
    if (!mine.rowCount) throw conflict("A photo couldn't be attached. Remove it and add it again.");
  }
}

/**
 * Link repair items (from this truck's inspections) to the entry and close the ones still open.
 * An item another entry already fixed is left alone, so a retried or offline save never fails on it.
 */
async function attachRepairs(c: PoolClient, entryId: number, vehicleId: number, ids: number[], userId: number, work: string) {
  if (!ids.length) return;
  const rows = (await c.query(
    `SELECT ii.id, ii.result, ii.resolved_at, i.vehicle_id,
            EXISTS (SELECT 1 FROM service_log_repairs r WHERE r.inspection_item_id = ii.id AND r.active) AS linked,
            EXISTS (SELECT 1 FROM inspection_states s WHERE s.inspection_id = i.id AND s.state <> 'active') AS hidden
       FROM inspection_items ii JOIN inspections i ON i.id = ii.inspection_id
      WHERE ii.id = ANY($1::int[])
      FOR UPDATE OF ii`,
    [ids],
  )).rows;
  const wrong = ids.filter((id) => {
    const r = rows.find((x) => x.id === id);
    // Repairs on an archived or deleted inspection are off the truck, so they can't be fixed through the log either.
    return !r || r.result !== "repair" || r.vehicle_id !== vehicleId || r.hidden;
  });
  if (wrong.length) {
    throw new HttpError(422, "Some of the repairs picked aren't repairs on this truck. Reload and pick again.", { code: "bad_repairs", items: wrong });
  }
  const note = `Fixed (maintenance log): ${work}`.slice(0, 1000);
  for (const r of rows) {
    if (r.linked) continue;
    const here = !r.resolved_at;
    if (here) {
      await c.query(`UPDATE inspection_items SET resolved_at = now(), resolved_by = $2, resolution_note = $3 WHERE id = $1`,
        [r.id, userId, note]);
    }
    await c.query(
      `INSERT INTO service_log_repairs (service_log_id, inspection_item_id, resolved_here) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [entryId, r.id, here],
    );
  }
}

/**
 * Mark damage on file as repaired by this entry (SPEC §9). Each damage mark it newly fixes needs at least one photo
 * of the fixed area in this save. Marks already repaired by this entry are kept; a mark someone else already marked
 * repaired is left alone (like repairs), so a retried or offline save never fails on it.
 * Returns damage mark id -> this entry's repair id, for tagging the photos.
 */
async function attachDamage(c: PoolClient, entryId: number, vehicleId: number, markIds: number[], photos: EntryPhoto[],
  userId: number, work: string): Promise<Map<number, number>> {
  const mine = new Map<number, number>((await c.query(
    "SELECT damage_mark_id, id FROM damage_repairs WHERE service_log_id = $1 AND active", [entryId],
  )).rows.map((r) => [r.damage_mark_id, r.id]));
  const tagged = [...new Set(photos.map((p) => p.damage_mark_id).filter((x): x is number => x != null))];
  if (tagged.some((m) => !markIds.includes(m) && !mine.has(m))) throw bad("A photo is tagged to damage this entry doesn't fix.");
  const todo = markIds.filter((m) => !mine.has(m));
  if (!todo.length) return mine;

  const rows = (await c.query(
    `SELECT dm.id, i.vehicle_id,
            EXISTS (SELECT 1 FROM inspection_states s WHERE s.inspection_id = i.id AND s.state <> 'active') AS hidden,
            EXISTS (SELECT 1 FROM damage_repairs r WHERE r.damage_mark_id = dm.id AND r.active) AS repaired
       FROM damage_marks dm JOIN inspections i ON i.id = dm.inspection_id
      WHERE dm.id = ANY($1::int[])
      FOR UPDATE OF dm`,
    [todo],
  )).rows;
  const wrong = todo.filter((m) => {
    const r = rows.find((x) => x.id === m);
    return !r || r.vehicle_id !== vehicleId || r.hidden;
  });
  if (wrong.length) {
    throw new HttpError(422, "Some of the damage picked isn't on file for this truck. Reload and pick again.", { code: "bad_damage", marks: wrong });
  }
  const fresh = rows.filter((r) => !r.repaired).map((r) => r.id as number);
  const noPhoto = fresh.filter((m) => !photos.some((p) => p.damage_mark_id === m));
  if (noPhoto.length) {
    throw new HttpError(422, "Add a photo of the fixed area for each damage this entry fixes.", { code: "damage_photo_missing", marks: noPhoto });
  }
  const note = `Fixed (maintenance log): ${work}`.slice(0, 1000);
  for (const m of fresh) {
    const r = await c.query(
      `INSERT INTO damage_repairs (damage_mark_id, service_log_id, note, repaired_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (damage_mark_id) WHERE active DO NOTHING RETURNING id`,
      [m, entryId, note, userId],
    );
    if (r.rows[0]) mine.set(m, r.rows[0].id);
  }
  return mine;
}

const same = (a: unknown, b: unknown) => String(a ?? "") === String(b ?? "");

/** One entry with its repairs, photos and edit history. */
export async function loadEntry(id: number) {
  const e = await one(
    `SELECT s.*, v.truck_code, v.year, v.make, v.model,
            cu.name AS created_by_name, uu.name AS updated_by_name, vu.name AS voided_by_name
       FROM service_logs s
       JOIN vehicles v ON v.id = s.vehicle_id
       LEFT JOIN users cu ON cu.id = s.created_by
       LEFT JOIN users uu ON uu.id = s.updated_by
       LEFT JOIN users vu ON vu.id = s.voided_by
      WHERE s.id = $1`,
    [id],
  );
  if (!e) throw notFound("Maintenance entry not found.");
  const repairs = await q(
    `SELECT ii.id, ii.label_snapshot AS label, ii.section, ii.note, ii.resolved_at, r.active, r.resolved_here,
            i.id AS inspection_id, i.inspection_date
       FROM service_log_repairs r
       JOIN inspection_items ii ON ii.id = r.inspection_item_id
       JOIN inspections i ON i.id = ii.inspection_id
      WHERE r.service_log_id = $1
      ORDER BY i.inspection_date, ii.id`,
    [id],
  );
  const photos = await q(`SELECT id, caption, damage_repair_id FROM photos WHERE service_log_id = $1 ORDER BY created_at, id`, [id]);
  const damageFixes = (await q(
    `SELECT dr.id, dr.damage_mark_id, dr.active, dr.repaired_at, dr.end_reason, dm.note, dm.diagram,
            i.id AS inspection_id, i.inspection_date
       FROM damage_repairs dr
       JOIN damage_marks dm ON dm.id = dr.damage_mark_id
       JOIN inspections i ON i.id = dm.inspection_id
      WHERE dr.service_log_id = $1
      ORDER BY i.inspection_date, dm.seq`,
    [id],
  )).map((r) => ({ ...r, photos: photos.filter((p) => p.damage_repair_id === r.id).map(({ damage_repair_id: _d, ...p }) => p) }));
  const hist = await q(
    `SELECT h.changed_at, h.old_row, u.name AS changed_by_name
       FROM service_log_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.service_log_id = $1 ORDER BY h.id`,
    [id],
  );
  // Each history row holds the version before a change; compare it with the next version.
  const versions = [...hist.map((h) => h.old_row as Record<string, unknown>), e];
  const history = hist.map((h, i) => {
    const before = versions[i];
    const after = versions[i + 1];
    const voided = !before.voided_at && !!after.voided_at;
    return {
      changed_at: h.changed_at,
      changed_by_name: h.changed_by_name,
      voided,
      changes: voided ? [] : FIELDS.filter((f) => (f === "work" ? !sameWork(workOf(before), workOf(after)) : !same(before[f], after[f])))
        .map((f) => (f === "work"
          ? { field: f, from: workText(workOf(before)), to: workText(workOf(after)) }
          : { field: f, from: before[f] ?? null, to: after[f] ?? null })),
    };
  });
  return {
    id: e.id,
    vehicle: { id: e.vehicle_id, truck_code: e.truck_code, year: e.year, make: e.make, model: e.model },
    ...Object.fromEntries(FIELDS.map((f) => [f, e[f] ?? null])),
    work: workOf(e).map((w) => ({ ...w, label: CATEGORIES[w.type] ?? w.type })),
    // Older copies of the app read the single-type fields; they mirror the first type of work.
    category: e.category,
    next_due_mileage: e.next_due_mileage ?? null,
    next_due_date: e.next_due_date ?? null,
    category_label: workLabel(workOf(e)),
    version: e.version,
    created_at: e.created_at,
    created_by_name: e.created_by_name,
    updated_at: e.updated_at,
    updated_by_name: e.updated_by_name,
    voided: e.voided_at ? { at: e.voided_at, by: e.voided_by_name, reason: e.void_reason } : null,
    repairs,
    damage_fixes: damageFixes,
    photos: photos.map(({ damage_repair_id: _d, ...p }) => p),
    history,
  };
}

/**
 * Live (not voided) maintenance entries that fixed repairs on one inspection, oldest first, for the PDF.
 * `repairs` are the ones on this inspection; `other_repairs` counts any it fixed on other inspections.
 */
export interface MaintenanceEntry {
  id: number;
  service_date: string;
  mileage: number | null;
  category: string;
  category_label: string;   // every type of work, e.g. "Oil change, Tires"
  work: WorkItem[];
  description: string;
  parts: string | null;
  cost: number | null;
  performed_by: string | null;
  vendor: string | null;
  notes: string | null;
  created_at: Date;
  created_by_name: string | null;
  edits: number;
  repairs: { id: number; label: string; note: string | null }[];
  other_repairs: number;
  photos: { id: string; caption: string | null; file_path: string }[];
}

export async function maintenanceForInspection(inspectionId: string): Promise<MaintenanceEntry[]> {
  const entries = await q(
    `SELECT DISTINCT s.id, s.service_date, s.mileage, s.category, s.work, s.description, s.parts, s.cost, s.performed_by,
            s.vendor, s.notes, s.created_at, cu.name AS created_by_name,
            (SELECT count(*) FROM service_log_history h WHERE h.service_log_id = s.id)::int AS edits
       FROM service_log_repairs r
       JOIN inspection_items ii ON ii.id = r.inspection_item_id
       JOIN service_logs s ON s.id = r.service_log_id
       LEFT JOIN users cu ON cu.id = s.created_by
      WHERE ii.inspection_id = $1 AND r.active AND s.voided_at IS NULL
      ORDER BY s.service_date, s.id`,
    [inspectionId],
  );
  if (!entries.length) return [];
  const ids = entries.map((e) => e.id);
  const repairs = await q(
    `SELECT r.service_log_id, ii.id, ii.label_snapshot AS label, ii.note, (ii.inspection_id = $2) AS here
       FROM service_log_repairs r JOIN inspection_items ii ON ii.id = r.inspection_item_id
      WHERE r.service_log_id = ANY($1::int[]) AND r.active
      ORDER BY ii.section, ii.id`,
    [ids, inspectionId],
  );
  const photos = await q(
    `SELECT id, service_log_id, caption, file_path FROM photos WHERE service_log_id = ANY($1::int[]) ORDER BY created_at, id`,
    [ids],
  );
  return entries.map((e) => ({
    ...e,
    work: workOf(e),
    category_label: workLabel(workOf(e)),
    repairs: repairs.filter((r) => r.service_log_id === e.id && r.here).map(({ id, label, note }) => ({ id, label, note })),
    other_repairs: repairs.filter((r) => r.service_log_id === e.id && !r.here).length,
    photos: photos.filter((p) => p.service_log_id === e.id).map(({ id, caption, file_path }) => ({ id, caption, file_path })),
  }));
}

const LIST_COLS = `
  s.id, s.vehicle_id, v.truck_code, s.service_date, s.mileage, s.category, s.work, s.description, s.cost,
  s.performed_by, s.vendor, (s.voided_at IS NOT NULL) AS voided,
  (SELECT count(*) FROM service_log_repairs r WHERE r.service_log_id = s.id AND r.active)::int AS repair_count,
  (SELECT count(*) FROM photos p WHERE p.service_log_id = s.id)::int AS photo_count`;

const withLabel = <T extends Record<string, unknown>>(r: T) => ({ ...r, category_label: workLabel(workOf(r)) });

class DuplicateSave extends Error {}

export default async function serviceRoutes(app: FastifyInstance) {
  app.get("/service-config", canRead, async () => ({
    categories: Object.entries(CATEGORIES).map(([id, label]) => ({ id, label, auto: AUTO_TICK[id] ?? null })),
  }));

  // A truck's maintenance history, plus what's due next.
  app.get("/vehicles/:id/service", canRead, async (req) => {
    const vid = idParam(req.params);
    if (!(await one(`SELECT 1 FROM vehicles WHERE id = $1`, [vid]))) throw notFound("Truck not found.");
    const entries = await q(
      `SELECT ${LIST_COLS} FROM service_logs s JOIN vehicles v ON v.id = s.vehicle_id
        WHERE s.vehicle_id = $1 ORDER BY s.service_date DESC, s.id DESC LIMIT 500`,
      [vid],
    );
    const current = await one<{ miles: number | null }>(
      `SELECT GREATEST(
         (SELECT max(mileage) FROM live_inspections WHERE vehicle_id = $1),
         (SELECT max(mileage) FROM service_logs WHERE vehicle_id = $1 AND voided_at IS NULL)) AS miles`,
      [vid],
    );
    // Next due per type of work: from the newest live entry with that type (an older due date is out of date).
    // An entry can have several types, each with its own next-due.
    const due = await q(
      `SELECT d.*, (d.next_due_date <= current_date) AS date_due, (d.next_due_date <= current_date + 14) AS date_soon FROM (
         SELECT DISTINCT ON (w->>'type') s.id, w->>'type' AS category, s.service_date,
                (w->>'next_due_mileage')::int AS next_due_mileage, (w->>'next_due_date')::date AS next_due_date
           FROM service_logs s CROSS JOIN LATERAL jsonb_array_elements(s.work) w
          WHERE s.vehicle_id = $1 AND s.voided_at IS NULL
          ORDER BY w->>'type', s.service_date DESC, s.id DESC) d
        WHERE d.next_due_mileage IS NOT NULL OR d.next_due_date IS NOT NULL
        ORDER BY d.category`,
      [vid],
    );
    const miles = current?.miles ?? null;
    return {
      current_mileage: miles,
      next_due: due.map((d) => {
        const milesDue = d.next_due_mileage != null && miles != null && miles >= d.next_due_mileage;
        const milesSoon = d.next_due_mileage != null && miles != null && miles >= d.next_due_mileage - 500;
        return {
          entry_id: d.id,
          category: d.category,
          category_label: CATEGORIES[d.category] ?? d.category,
          mileage: d.next_due_mileage,
          date: d.next_due_date,
          state: milesDue || d.date_due ? "due" : milesSoon || d.date_soon ? "soon" : "ok",
        };
      }),
      entries: entries.map(withLabel),
    };
  });

  // Recent entries across the fleet (home screen).
  app.get("/service-logs", canRead, async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string } | undefined)?.limit) || 20, 200);
    const rows = await q(
      `SELECT ${LIST_COLS} FROM service_logs s JOIN vehicles v ON v.id = s.vehicle_id
        WHERE s.voided_at IS NULL ORDER BY s.created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(withLabel);
  });

  app.get("/service-logs/:id", canRead, async (req) => loadEntry(idParam(req.params)));

  // New entry. Idempotent on client_id, like inspections, so a retried save never makes a duplicate.
  app.post("/service-logs", canWrite, async (req, reply) => {
    const user = req.user!;
    const b = obj(req.body);
    const clientId = String(b.client_id ?? "").toLowerCase();
    if (!UUID_RE.test(clientId)) throw bad("client_id must be a uuid.");
    const dup = await one(`SELECT id FROM service_logs WHERE client_id = $1`, [clientId]);
    if (dup) return reply.code(200).send({ id: dup.id, duplicate: true });

    const vehicleId = int(b.vehicle_id, "vehicle_id", 1);
    if (!(await one(`SELECT 1 FROM vehicles WHERE id = $1`, [vehicleId]))) throw bad("That truck doesn't exist.");
    const f = parseFields(b, true);
    const repairs = idList(b.repair_item_ids, "repair_item_ids", 100);
    const damage = idList(b.damage_mark_ids, "damage_mark_ids", 50);
    const photos = photoList(b.photos);
    await checkPhotos(photos, user.id, null);

    try {
      const id = await tx(async (c) => {
        const cols: Record<string, unknown> = { ...f, vehicle_id: vehicleId, client_id: clientId, created_by: user.id, updated_by: user.id };
        const keys = Object.keys(cols);
        const ins = await c.query(
          `INSERT INTO service_logs (${keys.join(", ")}) VALUES (${keys.map((k, i) => ph(k, i + 1)).join(", ")})
           ON CONFLICT (client_id) DO NOTHING RETURNING id`,
          keys.map((k) => val(k, cols[k])),
        );
        if (!ins.rows[0]) throw new DuplicateSave();
        const newId: number = ins.rows[0].id;
        await attachRepairs(c, newId, vehicleId, repairs, user.id, String(f.description));
        const repairOf = await attachDamage(c, newId, vehicleId, damage, photos, user.id, String(f.description));
        await attachPhotos(c, newId, photos, user.id, repairOf);
        return newId;
      });
      return reply.code(201).send({ id, duplicate: false });
    } catch (e) {
      if (e instanceof DuplicateSave) {
        const d = await one(`SELECT id FROM service_logs WHERE client_id = $1`, [clientId]);
        if (d) return reply.code(200).send({ id: d.id, duplicate: true });
      }
      throw e;
    }
  });

  // Edit. `version` must match the version the editor loaded; otherwise someone else changed it first.
  app.patch("/service-logs/:id", canWrite, async (req) => {
    const user = req.user!;
    const id = idParam(req.params);
    const b = obj(req.body);
    const version = int(b.version, "version", 1);
    const f = parseFields(b, false);
    const repairs = idList(b.repair_item_ids, "repair_item_ids", 100);
    const damage = idList(b.damage_mark_ids, "damage_mark_ids", 50);
    const photos = photoList(b.photos);
    await checkPhotos(photos, user.id, id);

    await tx(async (c) => {
      const cur = (await c.query(`SELECT * FROM service_logs WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound("Maintenance entry not found.");
      if (cur.voided_at) throw conflict("This entry was voided, so it can't be changed.");
      if (cur.version !== version) {
        throw new HttpError(409, "Someone changed this entry after you opened it. Reload it, check their changes, then make yours again.",
          { code: "stale" });
      }
      const changed = Object.keys(f).filter((k) => (k === "work" ? !sameWork(workOf(cur), f.work as WorkItem[]) : !same(cur[k], f[k])));
      if (changed.length || repairs.length || damage.length || photos.length) {
        // Even an edit that only adds photos or repairs bumps the version and records who did it.
        await c.query(
          `UPDATE service_logs SET ${[...changed.map((k, i) => `${k} = ${ph(k, i + 3)}`), "updated_by = $2"].join(", ")} WHERE id = $1`,
          [id, user.id, ...changed.map((k) => val(k, f[k]))],
        );
      }
      const work = String(f.description ?? cur.description);
      await attachRepairs(c, id, cur.vehicle_id, repairs, user.id, work);
      const repairOf = await attachDamage(c, id, cur.vehicle_id, damage, photos, user.id, work);
      await attachPhotos(c, id, photos, user.id, repairOf);
    });
    return loadEntry(id);
  });

  // Void (never delete). Repairs this entry closed are reopened, and damage it fixed goes back on file.
  app.post("/service-logs/:id/void", canWrite, async (req) => {
    const user = req.user!;
    const id = idParam(req.params);
    const reason = reqStr(obj(req.body ?? {}).reason, "Reason", 500);
    await tx(async (c) => {
      const r = await c.query(
        `UPDATE service_logs SET voided_at = now(), voided_by = $2, void_reason = $3, updated_by = $2
          WHERE id = $1 AND voided_at IS NULL RETURNING id`,
        [id, user.id, reason],
      );
      if (!r.rowCount) {
        const exists = await c.query(`SELECT 1 FROM service_logs WHERE id = $1`, [id]);
        if (!exists.rowCount) throw notFound("Maintenance entry not found.");
        throw conflict("This entry was already voided.");
      }
      await c.query(
        `UPDATE inspection_items ii SET resolved_at = NULL, resolved_by = NULL, resolution_note = NULL
           FROM service_log_repairs r
          WHERE r.service_log_id = $1 AND r.active AND r.resolved_here AND ii.id = r.inspection_item_id`,
        [id],
      );
      await c.query(`UPDATE service_log_repairs SET active = false WHERE service_log_id = $1`, [id]);
      // Damage it marked repaired goes back on file.
      await c.query(
        `UPDATE damage_repairs SET active = false, ended_at = now(), ended_by = $2, end_reason = $3
          WHERE service_log_id = $1 AND active`,
        [id, user.id, `Maintenance entry voided: ${reason}`.slice(0, 600)],
      );
    });
    return loadEntry(id);
  });
}
