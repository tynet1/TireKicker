// Admin → Trash (SPEC §4a, migration 020). Delete puts a record in the trash, where it is out of every list and off
// the truck but nothing is erased, and Restore puts it back. After TRASH_DAYS in the trash an admin can delete it
// forever: the record, everything that is only part of it, and its photo and signature files. The database refuses
// that unless gc_begin_purge() agrees (it re-checks the days itself), and every permanent delete is written to
// purge_log. Admins only, all of it.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { requireRole } from "../auth.ts";
import type { SessionUser } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import { bad, conflict, HttpError, isValidDate, notFound, obj, reqStr, UUID_RE } from "../http.ts";
import { files } from "../storage.ts";
import { changeIncidentState } from "./incidents.ts";
import { changeInspectionState } from "./inspections.ts";
import { voidEquipmentService } from "./equipment-service.ts";
import { voidServiceLog } from "./service.ts";
import { ticketNumber, voidTicket } from "./tickets.ts";

/** Days a record stays in the trash before it can be deleted forever (also checked by the database). */
export const TRASH_DAYS = 7;

export type Kind = "inspection" | "incident" | "yard_walk" | "equipment_check" | "service_log" | "equipment_service"
  | "repair_ticket" | "vehicle" | "user";
export const KINDS: Kind[] = ["inspection", "incident", "yard_walk", "equipment_check", "service_log", "equipment_service",
  "repair_ticket", "vehicle", "user"];
const UUID_KINDS = new Set<Kind>(["inspection", "incident", "yard_walk", "equipment_check"]);
export const KIND_LABEL: Record<Kind, string> = {
  inspection: "Inspection", incident: "Incident report", yard_walk: "Yard walk", equipment_check: "Equipment check",
  service_log: "Maintenance entry", equipment_service: "Equipment maintenance", repair_ticket: "Repair ticket",
  vehicle: "Truck", user: "User",
};
/** What the old-records tool can move to the trash by date (trucks and users go one at a time). */
export const BY_DATE: Kind[] = ["inspection", "incident", "yard_walk", "equipment_check", "service_log", "equipment_service",
  "repair_ticket"];

/** A kind and an id from a request body, checked. */
function parseRef(b: Record<string, unknown>): { kind: Kind; id: string } {
  const kind = b.kind as Kind;
  if (!KINDS.includes(kind)) throw bad("Unknown kind of record.");
  const raw = typeof b.id === "number" ? String(b.id) : b.id;
  if (typeof raw !== "string") throw bad("id is required.");
  if (UUID_KINDS.has(kind) ? !UUID_RE.test(raw) : !/^\d{1,10}$/.test(raw)) throw notFound("Record not found.");
  return { kind, id: raw.toLowerCase() };
}

// ---------- What's in the trash ----------

/**
 * Everything in the trash, one row per record: its kind and id, a code (truck, yard, trailer, tag or name), its date,
 * who did it, a few words about it, and when, by whom and why it went in. Text ids throughout (uuid or number).
 */
const TRASH_LIST = `
  SELECT 'inspection' AS kind, i.id::text AS id, v.truck_code AS code, i.inspection_date AS record_date,
         i.inspector_name AS who, NULL::text AS about, s.changed_at AS deleted_at, u.name AS deleted_by_name, s.reason
    FROM inspection_states s JOIN inspections i ON i.id = s.inspection_id JOIN vehicles v ON v.id = i.vehicle_id
    JOIN users u ON u.id = s.changed_by
   WHERE s.state = 'deleted'
  UNION ALL
  SELECT 'incident', n.id::text, v.truck_code, n.incident_date, n.reporter_name, NULL, s.changed_at, u.name, s.reason
    FROM incident_states s JOIN incidents n ON n.id = s.incident_id JOIN vehicles v ON v.id = n.vehicle_id
    JOIN users u ON u.id = s.changed_by
   WHERE s.state = 'deleted'
  UNION ALL
  SELECT t.kind, t.record_id, y.code, w.inspection_date, w.inspector_name, NULL, t.deleted_at, u.name, t.reason
    FROM trash t JOIN yard_inspections w ON w.id::text = t.record_id JOIN yards y ON y.id = w.yard_id
    JOIN users u ON u.id = t.deleted_by
   WHERE t.kind = 'yard_walk'
  UNION ALL
  SELECT t.kind, t.record_id, coalesce(tr.trailer_number, 'No trailer'), c.check_date, c.checker_name, NULL, t.deleted_at,
         u.name, t.reason
    FROM trash t JOIN equipment_checks c ON c.id::text = t.record_id LEFT JOIN trailers tr ON tr.id = c.trailer_id
    JOIN users u ON u.id = t.deleted_by
   WHERE t.kind = 'equipment_check'
  UNION ALL
  SELECT t.kind, t.record_id, v.truck_code, s.service_date, coalesce(s.performed_by, s.vendor), s.description,
         t.deleted_at, u.name, t.reason
    FROM trash t JOIN service_logs s ON s.id::text = t.record_id JOIN vehicles v ON v.id = s.vehicle_id
    JOIN users u ON u.id = t.deleted_by
   WHERE t.kind = 'service_log'
  UNION ALL
  SELECT t.kind, t.record_id, e.tag, s.service_date, coalesce(s.performed_by, s.vendor), s.description,
         t.deleted_at, u.name, t.reason
    FROM trash t JOIN equipment_service_logs s ON s.id::text = t.record_id JOIN equipment e ON e.id = s.equipment_id
    JOIN users u ON u.id = t.deleted_by
   WHERE t.kind = 'equipment_service'
  UNION ALL
  SELECT t.kind, t.record_id, v.truck_code, r.created_at::date, cu.name, r.sent_to, t.deleted_at, u.name, t.reason
    FROM trash t JOIN repair_tickets r ON r.id::text = t.record_id JOIN vehicles v ON v.id = r.vehicle_id
    JOIN users cu ON cu.id = r.created_by JOIN users u ON u.id = t.deleted_by
   WHERE t.kind = 'repair_ticket'
  UNION ALL
  SELECT t.kind, t.record_id, v.truck_code, NULL::date, NULL, concat_ws(' ', v.year, v.make, v.model), t.deleted_at,
         u.name, t.reason
    FROM trash t JOIN vehicles v ON v.id::text = t.record_id JOIN users u ON u.id = t.deleted_by
   WHERE t.kind = 'vehicle'
  UNION ALL
  SELECT t.kind, t.record_id, p.name, NULL::date, NULL, p.role::text, t.deleted_at, u.name, t.reason
    FROM trash t JOIN users p ON p.id::text = t.record_id JOIN users u ON u.id = t.deleted_by
   WHERE t.kind = 'user'`;

interface TrashRow {
  kind: Kind; id: string; code: string | null; record_date: string | null; who: string | null; about: string | null;
  deleted_at: Date; deleted_by_name: string; reason: string; ready: boolean; ready_at: Date;
}

const LINKS: Partial<Record<Kind, (id: string) => string>> = {
  inspection: (id) => `#/inspection/${id}`,
  incident: (id) => `#/incident/${id}`,
  yard_walk: (id) => `#/yard-walk/${id}`,
  equipment_check: (id) => `#/equipment-check/${id}`,
  service_log: (id) => `#/service/${id}`,
  equipment_service: (id) => `#/equipment-service/${id}`,
};

/** The title a record gets in the trash and in the purge log: what it was, never what it said. */
function titleOf(r: { kind: Kind; id: string; code: string | null; about?: string | null }): string {
  if (r.kind === "repair_ticket") return `Repair ticket ${ticketNumber(Number(r.id))} · ${r.code}`;
  if (r.kind === "user") return `User #${r.id}${r.about ? ` (${r.about})` : ""}`;
  return `${KIND_LABEL[r.kind]} · ${r.code}`;
}

function forClient(r: TrashRow) {
  return {
    kind: r.kind, id: r.id, label: KIND_LABEL[r.kind], title: titleOf(r), code: r.code,
    name: r.kind === "user" ? r.code : null, record_date: r.record_date, who: r.who,
    about: r.about && r.about.length > 90 ? `${r.about.slice(0, 88)}…` : r.about,
    deleted_at: r.deleted_at, deleted_by_name: r.deleted_by_name, reason: r.reason,
    ready: r.ready, ready_at: r.ready_at,
    // What to type to delete it forever: the truck, yard, trailer or tag on it, or the person's name.
    confirm: r.code && r.code !== "No trailer" ? r.code : "DELETE",
    link: LINKS[r.kind]?.(r.id) ?? null,
  };
}

const READY_COLS = `x.*, (x.deleted_at <= now() - interval '${TRASH_DAYS} days') AS ready,
  x.deleted_at + interval '${TRASH_DAYS} days' AS ready_at`;

async function trashed(kind: Kind, id: string, db: Pick<PoolClient, "query"> | undefined = undefined): Promise<TrashRow | undefined> {
  return one<TrashRow>(`SELECT ${READY_COLS} FROM (${TRASH_LIST}) x WHERE x.kind = $1 AND x.id = $2`, [kind, id], db);
}

/** Whether a record is in the trash, for the detail screens: when, by whom and why (null when it isn't). */
export async function trashInfo(kind: Kind, id: string | number) {
  return (await one(
    `SELECT t.deleted_at, u.name AS deleted_by_name, t.reason, t.deleted_at + interval '${TRASH_DAYS} days' AS ready_at
       FROM trash t JOIN users u ON u.id = t.deleted_by WHERE t.kind = $1 AND t.record_id = $2`,
    [kind, String(id)],
  )) ?? null;
}

// ---------- Things that point at trucks and users ----------

const TABLE_WORDS: Record<string, string> = {
  inspections: "inspections", incidents: "incident reports", yard_inspections: "yard walks",
  equipment_checks: "equipment checks", service_logs: "maintenance entries",
  equipment_service_logs: "equipment maintenance entries", repair_tickets: "repair tickets", trailers: "trailers",
  photos: "photos", damage_repairs: "damage repairs", inspection_items: "repairs closed",
  yard_inspection_items: "yard findings closed", equipment_check_items: "equipment problems closed",
  registration_changes: "registration updates", vehicle_status_changes: "truck status changes",
  inspection_states: "archived or deleted inspections", inspection_state_history: "archive or delete actions",
  incident_states: "archived or deleted reports", incident_state_history: "archive or delete actions",
  incident_notes: "incident notes", trash: "records put in the trash", trash_history: "trash actions",
  service_log_history: "maintenance edits", checklist_changes: "checklist changes", yard_checklist_changes: "checklist changes",
  equipment_checklist_changes: "checklist changes", asset_changes: "equipment changes", settings: "saved settings",
};

/**
 * What still points at a truck or a user, in words ("3 inspections"), leaving out the tables in `own` (its own history,
 * which goes with it). Read from the database's own list of foreign keys, so a table added later is never missed.
 */
async function pointingAt(c: Pick<PoolClient, "query">, table: "vehicles" | "users", id: number, own: string[]): Promise<string[]> {
  const fks = (await c.query<{ tbl: string; col: string }>(
    `SELECT con.conrelid::regclass::text AS tbl, a.attname AS col
       FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND con.confrelid = $1::regclass AND cardinality(con.conkey) = 1
      ORDER BY 1, 2`,
    [table],
  )).rows;
  const counts = new Map<string, number>();
  for (const fk of fks) {
    if (own.includes(fk.tbl)) continue;
    const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const n = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${ident(fk.tbl)} WHERE ${ident(fk.col)} = $1`, [id])).rows[0].n;
    if (n) counts.set(fk.tbl, (counts.get(fk.tbl) ?? 0) + n);
  }
  return [...counts].map(([t, n]) => {
    const words = TABLE_WORDS[t] ?? t.replace(/_/g, " ");
    return `${n} ${n === 1 ? singular(words) : words}`;
  });
}
/** "inspections" → "inspection", "maintenance entries" → "maintenance entry", "repairs closed" → "repair closed". */
function singular(words: string): string {
  const w = words.split(" ");
  const i = w.findIndex((x) => x.endsWith("s") && x !== "status");
  if (i < 0) return words;
  w[i] = w[i].endsWith("ies") ? w[i].slice(0, -3) + "y" : w[i].slice(0, -1);
  return w.join(" ");
}
const VEHICLE_OWN = ["vehicle_status_changes", "registration_changes"];
const USER_OWN = ["sessions", "incident_reads"];

// ---------- Delete (into the trash) and restore ----------

interface Actor { id: number; name: string }

/** Does the record exist? (and lock it, so a delete and a restore at once go one after the other) */
const EXISTS: Record<Exclude<Kind, "inspection" | "incident">, string> = {
  yard_walk: `SELECT id FROM yard_inspections WHERE id::text = $1 FOR UPDATE`,
  equipment_check: `SELECT id FROM equipment_checks WHERE id::text = $1 FOR UPDATE`,
  service_log: `SELECT id FROM service_logs WHERE id::text = $1 FOR UPDATE`,
  equipment_service: `SELECT id FROM equipment_service_logs WHERE id::text = $1 FOR UPDATE`,
  repair_ticket: `SELECT id FROM repair_tickets WHERE id::text = $1 FOR UPDATE`,
  vehicle: `SELECT id, active, truck_code FROM vehicles WHERE id::text = $1 FOR UPDATE`,
  user: `SELECT id, active, name FROM users WHERE id::text = $1 FOR UPDATE`,
};
const NOT_FOUND: Record<Kind, string> = {
  inspection: "Inspection not found.", incident: "Incident report not found.", yard_walk: "Yard walk not found.",
  equipment_check: "Equipment check not found.", service_log: "Maintenance entry not found.",
  equipment_service: "Maintenance entry not found.", repair_ticket: "Ticket not found.", vehicle: "Truck not found.",
  user: "User not found.",
};

/**
 * Put one record in the trash. Maintenance entries and tickets are voided first if they aren't already (a voided entry
 * reopens the repairs it closed, as a void always does). A truck must be retired and a user inactive, with nothing on
 * file, before they can go.
 */
export async function moveToTrash(kind: Kind, id: string, by: Actor, reason: string) {
  if (kind === "inspection") return changeInspectionState(id, "delete", by.id, reason);
  if (kind === "incident") return changeIncidentState(id, "delete", by.id, reason);
  return tx(async (c) => {
    const row = (await c.query(EXISTS[kind], [id])).rows[0];
    if (!row) throw notFound(NOT_FOUND[kind]);
    if ((await c.query(`SELECT 1 FROM trash WHERE kind = $1 AND record_id = $2`, [kind, id])).rowCount) {
      throw conflict("That's already in the trash.");
    }
    if (kind === "service_log") await voidServiceLog(c, Number(id), by.id, reason);
    else if (kind === "equipment_service") await voidEquipmentService(c, Number(id), by.id, reason);
    else if (kind === "repair_ticket") await voidTicket(c, Number(id), by.id, reason);
    else if (kind === "vehicle") {
      if (row.active) throw conflict(`Retire ${row.truck_code} first (Admin → Trucks). Only a retired truck can be deleted.`);
      const on = await pointingAt(c, "vehicles", Number(id), VEHICLE_OWN);
      if (on.length) throw conflict(`${row.truck_code} has ${on.join(", ")} on file, so it stays retired instead (its history is kept).`);
    } else if (kind === "user") {
      if (Number(id) === by.id) throw bad("You can't delete yourself.");
      if (row.active) throw conflict(`Make ${row.name} inactive first. Only an inactive user can be deleted.`);
      const on = await pointingAt(c, "users", Number(id), USER_OWN);
      if (on.length) throw conflict(`${row.name} has ${on.join(", ")} on file, so they stay inactive instead (their history is kept).`);
    }
    await c.query(`INSERT INTO trash (kind, record_id, reason, deleted_by) VALUES ($1, $2, $3, $4)`, [kind, id, reason, by.id]);
    await c.query(`INSERT INTO trash_history (kind, record_id, action, reason, changed_by) VALUES ($1, $2, 'delete', $3, $4)`,
      [kind, id, reason, by.id]);
    return { state: "deleted" };
  });
}

export async function restoreFromTrash(kind: Kind, id: string, by: Actor) {
  if (kind === "inspection") return changeInspectionState(id, "restore", by.id, null);
  if (kind === "incident") return changeIncidentState(id, "restore", by.id, null);
  return tx(async (c) => {
    const r = await c.query(`DELETE FROM trash WHERE kind = $1 AND record_id = $2 RETURNING record_id`, [kind, id]);
    if (!r.rowCount) throw conflict("That isn't in the trash (it may have been restored or deleted forever).");
    await c.query(`INSERT INTO trash_history (kind, record_id, action, changed_by) VALUES ($1, $2, 'restore', $3)`, [kind, id, by.id]);
    return { state: "active" };
  });
}

// ---------- Delete forever ----------

interface Purged { removed: Record<string, number>; files: string[]; notes: string[] }
type Purger = (c: PoolClient, id: string) => Promise<Purged>;

const count = (r: { rowCount: number | null }) => r.rowCount ?? 0;
const paths = (r: { rows: { file_path: string | null }[] }) => r.rows.map((x) => x.file_path).filter((x): x is string => !!x);
function tally(removed: Record<string, number>, what: string, n: number) {
  if (n) removed[what] = (removed[what] ?? 0) + n;
}
const listOf = (ids: number[], fmt: (n: number) => string) => [...new Set(ids)].sort((a, b) => a - b).map(fmt).join(", ");

/**
 * Damage repairs recorded against damage marks that are going (the marks' record is being deleted forever). A Log-fix
 * photo also belongs to its maintenance entry, so it stays there; a supervisor's "repaired" photo goes with the repair.
 */
async function dropDamageRepairs(c: PoolClient, marksSql: string, id: string, out: Purged) {
  const repairs = `SELECT id FROM damage_repairs WHERE damage_mark_id IN (${marksSql})`;
  await c.query(`UPDATE photos SET damage_repair_id = NULL WHERE damage_repair_id IN (${repairs}) AND service_log_id IS NOT NULL`, [id]);
  const ph = await c.query(`DELETE FROM photos WHERE damage_repair_id IN (${repairs}) RETURNING file_path`, [id]);
  out.files.push(...paths(ph));
  tally(out.removed, "photos", count(ph));
  tally(out.removed, "damage repairs", count(await c.query(`DELETE FROM damage_repairs WHERE damage_mark_id IN (${marksSql})`, [id])));
  const td = await c.query<{ ticket_id: number }>(
    `DELETE FROM repair_ticket_damage WHERE damage_mark_id IN (${marksSql}) RETURNING ticket_id`, [id]);
  if (td.rowCount) out.notes.push(`Its damage was taken off repair ticket ${listOf(td.rows.map((r) => r.ticket_id), ticketNumber)}.`);
}

async function dropTrashRows(c: PoolClient, kind: Kind, id: string) {
  await c.query(`DELETE FROM trash_history WHERE kind = $1 AND record_id = $2`, [kind, id]);
  await c.query(`DELETE FROM trash WHERE kind = $1 AND record_id = $2`, [kind, id]);
}

const PURGE: Record<Kind, Purger> = {
  async inspection(c, id) {
    const out: Purged = { removed: {}, files: [], notes: [] };
    const i = (await c.query(`SELECT employee_signature_path AS a, supervisor_signature_path AS b FROM inspections WHERE id = $1`, [id])).rows[0];
    if (!i) throw notFound(NOT_FOUND.inspection);
    const items = `SELECT id FROM inspection_items WHERE inspection_id = $1`;
    const marks = `SELECT id FROM damage_marks WHERE inspection_id = $1`;
    const ti = await c.query<{ ticket_id: number }>(`DELETE FROM repair_ticket_items WHERE inspection_item_id IN (${items}) RETURNING ticket_id`, [id]);
    if (ti.rowCount) out.notes.push(`Its repairs were taken off repair ticket ${listOf(ti.rows.map((r) => r.ticket_id), ticketNumber)}.`);
    const sl = await c.query<{ service_log_id: number }>(
      `DELETE FROM service_log_repairs WHERE inspection_item_id IN (${items}) RETURNING service_log_id`, [id]);
    if (sl.rowCount) out.notes.push(`Maintenance entr${new Set(sl.rows.map((r) => r.service_log_id)).size === 1 ? "y" : "ies"} ${
      listOf(sl.rows.map((r) => r.service_log_id), (n) => `#${n}`)} no longer list${sl.rowCount === 1 ? "s" : ""} its repairs (the entries stay).`);
    await dropDamageRepairs(c, marks, id, out);
    // A registration update made while signing it off stays in the truck's registration history, unlinked.
    const rc = await c.query(`UPDATE registration_changes SET inspection_id = NULL, source = 'other' WHERE inspection_id = $1`, [id]);
    if (rc.rowCount) out.notes.push("The registration update made while signing it off stays in the truck's history.");
    const ph = await c.query(`DELETE FROM photos WHERE inspection_id = $1 RETURNING file_path`, [id]);
    out.files.push(...paths(ph));
    tally(out.removed, "photos", count(ph));
    tally(out.removed, "damage marks", count(await c.query(`DELETE FROM damage_marks WHERE inspection_id = $1`, [id])));
    tally(out.removed, "checklist answers", count(await c.query(`DELETE FROM inspection_items WHERE inspection_id = $1`, [id])));
    await c.query(`DELETE FROM inspection_state_history WHERE inspection_id = $1`, [id]);
    await c.query(`DELETE FROM inspection_states WHERE inspection_id = $1`, [id]);
    await c.query(`DELETE FROM inspections WHERE id = $1`, [id]);
    for (const p of [i.a, i.b]) if (p) out.files.push(p);
    tally(out.removed, "signatures", [i.a, i.b].filter(Boolean).length);
    return out;
  },

  async incident(c, id) {
    const out: Purged = { removed: {}, files: [], notes: [] };
    const n = (await c.query(
      `SELECT sketch_path AS s, driver_signature_path AS d, reporter_signature_path AS r, map_photo_id FROM incidents WHERE id = $1`, [id])).rows[0];
    if (!n) throw notFound(NOT_FOUND.incident);
    const marks = `SELECT id FROM damage_marks WHERE incident_id = $1`;
    await dropDamageRepairs(c, marks, id, out);
    if (n.map_photo_id) await c.query(`UPDATE incidents SET map_photo_id = NULL WHERE id = $1`, [id]);
    const ph = await c.query(`DELETE FROM photos WHERE incident_id = $1 OR id = $2 RETURNING file_path`, [id, n.map_photo_id]);
    out.files.push(...paths(ph));
    tally(out.removed, "photos", count(ph));
    tally(out.removed, "damage marks", count(await c.query(`DELETE FROM damage_marks WHERE incident_id = $1`, [id])));
    tally(out.removed, "notes", count(await c.query(`DELETE FROM incident_notes WHERE incident_id = $1`, [id])));
    await c.query(`DELETE FROM incident_reads WHERE incident_id = $1`, [id]);
    await c.query(`DELETE FROM incident_state_history WHERE incident_id = $1`, [id]);
    await c.query(`DELETE FROM incident_states WHERE incident_id = $1`, [id]);
    await c.query(`DELETE FROM incidents WHERE id = $1`, [id]);
    for (const p of [n.s, n.d, n.r]) if (p) out.files.push(p);
    tally(out.removed, "signatures", [n.d, n.r].filter(Boolean).length);
    tally(out.removed, "sketches", n.s ? 1 : 0);
    return out;
  },

  async yard_walk(c, id) {
    const out: Purged = { removed: {}, files: [], notes: [] };
    const w = (await c.query(`SELECT signature_path FROM yard_inspections WHERE id = $1`, [id])).rows[0];
    if (!w) throw notFound(NOT_FOUND.yard_walk);
    const ph = await c.query(`DELETE FROM photos WHERE yard_inspection_id = $1 RETURNING file_path`, [id]);
    out.files.push(...paths(ph));
    tally(out.removed, "photos", count(ph));
    tally(out.removed, "checklist answers", count(await c.query(`DELETE FROM yard_inspection_items WHERE yard_inspection_id = $1`, [id])));
    await dropTrashRows(c, "yard_walk", id);
    await c.query(`DELETE FROM yard_inspections WHERE id = $1`, [id]);
    if (w.signature_path) out.files.push(w.signature_path);
    tally(out.removed, "signatures", w.signature_path ? 1 : 0);
    return out;
  },

  async equipment_check(c, id) {
    const out: Purged = { removed: {}, files: [], notes: [] };
    if (!(await c.query(`SELECT 1 FROM equipment_checks WHERE id = $1`, [id])).rowCount) throw notFound(NOT_FOUND.equipment_check);
    const fx = await c.query<{ service_log_id: number }>(
      `DELETE FROM equipment_service_repairs WHERE check_item_id IN (SELECT id FROM equipment_check_items WHERE check_id = $1)
       RETURNING service_log_id`, [id]);
    if (fx.rowCount) out.notes.push(`Equipment maintenance ${listOf(fx.rows.map((r) => r.service_log_id), (n) => `#${n}`)} no longer lists its problems (the entries stay).`);
    const ph = await c.query(`DELETE FROM photos WHERE equipment_check_id = $1 RETURNING file_path`, [id]);
    out.files.push(...paths(ph));
    tally(out.removed, "photos", count(ph));
    tally(out.removed, "checklist answers", count(await c.query(`DELETE FROM equipment_check_items WHERE check_id = $1`, [id])));
    tally(out.removed, "pieces checked", count(await c.query(`DELETE FROM equipment_check_pieces WHERE check_id = $1`, [id])));
    await dropTrashRows(c, "equipment_check", id);
    await c.query(`DELETE FROM equipment_checks WHERE id = $1`, [id]);
    return out;
  },

  async service_log(c, id) {
    const out: Purged = { removed: {}, files: [], notes: [] };
    if (!(await c.query(`SELECT 1 FROM service_logs WHERE id = $1`, [id])).rowCount) throw notFound(NOT_FOUND.service_log);
    // Damage it marked repaired that is still repaired stays repaired (with its photo); ended repairs go with it.
    const kept = await c.query<{ id: number }>(
      `UPDATE damage_repairs SET service_log_id = NULL, note = coalesce(nullif(btrim(note), ''), $2)
        WHERE service_log_id = $1 AND active RETURNING id`, [id, `Fixed in maintenance entry #${id}, since deleted`]);
    if (kept.rowCount) {
      await c.query(`UPDATE photos SET service_log_id = NULL WHERE service_log_id = $1 AND damage_repair_id = ANY($2::int[])`,
        [id, kept.rows.map((r) => r.id)]);
      out.notes.push(`Damage it fixed stays marked repaired (${kept.rowCount}), with ${kept.rowCount === 1 ? "its" : "their"} photos.`);
    }
    const ended = `SELECT id FROM damage_repairs WHERE service_log_id = $1`;
    const eph = await c.query(`DELETE FROM photos WHERE damage_repair_id IN (${ended}) RETURNING file_path`, [id]);
    out.files.push(...paths(eph));
    tally(out.removed, "photos", count(eph));
    tally(out.removed, "damage repairs", count(await c.query(`DELETE FROM damage_repairs WHERE service_log_id = $1`, [id])));
    tally(out.removed, "repairs listed", count(await c.query(`DELETE FROM service_log_repairs WHERE service_log_id = $1`, [id])));
    tally(out.removed, "earlier versions", count(await c.query(`DELETE FROM service_log_history WHERE service_log_id = $1`, [id])));
    const ph = await c.query(`DELETE FROM photos WHERE service_log_id = $1 RETURNING file_path`, [id]);
    out.files.push(...paths(ph));
    tally(out.removed, "photos", count(ph));
    await dropTrashRows(c, "service_log", id);
    await c.query(`DELETE FROM service_logs WHERE id = $1`, [id]);
    return out;
  },

  async equipment_service(c, id) {
    const out: Purged = { removed: {}, files: [], notes: [] };
    if (!(await c.query(`SELECT 1 FROM equipment_service_logs WHERE id = $1`, [id])).rowCount) throw notFound(NOT_FOUND.equipment_service);
    tally(out.removed, "problems listed", count(await c.query(`DELETE FROM equipment_service_repairs WHERE service_log_id = $1`, [id])));
    const ph = await c.query(`DELETE FROM photos WHERE equipment_service_log_id = $1 RETURNING file_path`, [id]);
    out.files.push(...paths(ph));
    tally(out.removed, "photos", count(ph));
    await dropTrashRows(c, "equipment_service", id);
    await c.query(`DELETE FROM equipment_service_logs WHERE id = $1`, [id]);
    return out;
  },

  async repair_ticket(c, id) {
    const out: Purged = { removed: {}, files: [], notes: [] };
    if (!(await c.query(`SELECT 1 FROM repair_tickets WHERE id = $1`, [id])).rowCount) throw notFound(NOT_FOUND.repair_ticket);
    tally(out.removed, "repairs listed", count(await c.query(`DELETE FROM repair_ticket_items WHERE ticket_id = $1`, [id]))
      + count(await c.query(`DELETE FROM repair_ticket_damage WHERE ticket_id = $1`, [id])));
    await dropTrashRows(c, "repair_ticket", id);
    await c.query(`DELETE FROM repair_tickets WHERE id = $1`, [id]);
    return out;
  },

  async vehicle(c, id) {
    const out: Purged = { removed: {}, files: [], notes: [] };
    const v = (await c.query(`SELECT truck_code FROM vehicles WHERE id = $1`, [id])).rows[0];
    if (!v) throw notFound(NOT_FOUND.vehicle);
    const on = await pointingAt(c, "vehicles", Number(id), VEHICLE_OWN);
    if (on.length) throw conflict(`${v.truck_code} now has ${on.join(", ")} on file, so it can't be deleted forever. Restore it instead.`);
    const ph = await c.query(
      `DELETE FROM photos WHERE registration_change_id IN (SELECT id FROM registration_changes WHERE vehicle_id = $1) RETURNING file_path`, [id]);
    out.files.push(...paths(ph));
    tally(out.removed, "photos", count(ph));
    tally(out.removed, "registration updates", count(await c.query(`DELETE FROM registration_changes WHERE vehicle_id = $1`, [id])));
    tally(out.removed, "status changes", count(await c.query(`DELETE FROM vehicle_status_changes WHERE vehicle_id = $1`, [id])));
    await dropTrashRows(c, "vehicle", id);
    await c.query(`DELETE FROM vehicles WHERE id = $1`, [id]);
    return out;
  },

  async user(c, id) {
    const out: Purged = { removed: {}, files: [], notes: [] };
    const u = (await c.query(`SELECT name FROM users WHERE id = $1`, [id])).rows[0];
    if (!u) throw notFound(NOT_FOUND.user);
    const on = await pointingAt(c, "users", Number(id), USER_OWN);
    if (on.length) throw conflict(`${u.name} now has ${on.join(", ")} on file, so they can't be deleted forever. Restore them instead.`);
    await c.query(`DELETE FROM incident_reads WHERE user_id = $1`, [id]);
    await c.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    await dropTrashRows(c, "user", id);
    await c.query(`DELETE FROM users WHERE id = $1`, [id]);
    return out;
  },
};

/** Thrown to roll a preview back; carries what the real thing would have done. */
class DryRun extends Error {
  result: PurgeResult;
  constructor(result: PurgeResult) {
    super("dry run");
    this.result = result;
  }
}
export interface PurgeResult { title: string; removed: Record<string, number>; files: number; notes: string[]; already?: boolean }

function purgeError(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === "GC001") throw notFound("That isn't in the trash any more (it may have been restored).");
  if (code === "GC002") throw conflict(`A record has to be in the trash for ${TRASH_DAYS} days before it can be deleted forever.`);
  if (code === "23503") {
    const t = (e as { table?: string }).table;
    throw conflict(`Something else still points at it${t ? ` (${TABLE_WORDS[t] ?? t})` : ""}, so it can't be deleted forever.`);
  }
  throw e;
}

/** Of these files, the ones nothing in the database points at any more (so they're safe to remove). */
async function unusedFiles(keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  const used = new Set((await q<{ k: string }>(
    `SELECT k FROM unnest($1::text[]) k
      WHERE EXISTS (SELECT 1 FROM photos WHERE file_path = k)
         OR EXISTS (SELECT 1 FROM inspections WHERE employee_signature_path = k OR supervisor_signature_path = k)
         OR EXISTS (SELECT 1 FROM yard_inspections WHERE signature_path = k)
         OR EXISTS (SELECT 1 FROM incidents WHERE sketch_path = k OR driver_signature_path = k OR reporter_signature_path = k)
         OR EXISTS (SELECT 1 FROM diagrams WHERE file_path = k)`,
    [keys],
  )).map((r) => r.k));
  return [...new Set(keys)].filter((k) => !used.has(k));
}

/**
 * Delete one record forever (or, with dry = true, work out what that would remove and roll it all back). The rows go
 * in one transaction; the files only after it has committed, and only those nothing points at any more.
 */
export async function purge(kind: Kind, id: string, by: Actor, dry = false, log?: (m: string) => void): Promise<PurgeResult> {
  if (await one(`SELECT 1 FROM purge_log WHERE kind = $1 AND record_id = $2`, [kind, id])) {
    return { title: "", removed: {}, files: 0, notes: [], already: true };
  }
  let done: { result: PurgeResult; files: string[] };
  try {
    done = await tx(async (c) => {
      try {
        await c.query(`SELECT gc_begin_purge($1, $2)`, [kind, id]);
      } catch (e) {
        purgeError(e);
      }
      const info = await trashed(kind, id, c);
      if (!info) throw notFound("That isn't in the trash any more.");
      let out: Purged;
      try {
        out = await PURGE[kind](c, id);
      } catch (e) {
        purgeError(e);
      }
      await c.query(`SELECT set_config('gc.purge', '', true)`);
      const result: PurgeResult = { title: titleOf(info), removed: out.removed, files: new Set(out.files).size, notes: out.notes };
      if (dry) throw new DryRun(result);
      await c.query(
        `INSERT INTO purge_log (kind, record_id, title, truck_code, record_date, reason, deleted_at, deleted_by_name,
                                purged_by, purged_by_name, removed, files)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [kind, id, result.title, ["user"].includes(kind) ? null : info.code, info.record_date, info.reason, info.deleted_at,
          info.deleted_by_name, by.id, by.name, JSON.stringify(out.removed), result.files],
      );
      return { result, files: out.files };
    });
  } catch (e) {
    if (e instanceof DryRun) return e.result;
    throw e;
  }
  // The database no longer points at these; remove them from the disk. A file that can't be removed is only spare.
  try {
    for (const k of await unusedFiles(done.files)) {
      await files.remove(k).catch((err) => log?.(`purge: couldn't remove ${k}: ${(err as Error).message}`));
    }
  } catch (err) {
    log?.(`purge: files kept for ${kind} ${id}: ${(err as Error).message}`);
  }
  return done.result;
}

// ---------- Old records ----------

/** Records of a kind dated before `before` that aren't in the trash yet: SQL giving their ids (as text). */
const OLD: Partial<Record<Kind, string>> = {
  inspection: `SELECT i.id::text AS id FROM inspections i WHERE i.inspection_date < $1::date
                 AND NOT EXISTS (SELECT 1 FROM inspection_states s WHERE s.inspection_id = i.id AND s.state = 'deleted')`,
  incident: `SELECT n.id::text AS id FROM incidents n WHERE n.incident_date < $1::date
               AND NOT EXISTS (SELECT 1 FROM incident_states s WHERE s.incident_id = n.id AND s.state = 'deleted')`,
  yard_walk: `SELECT w.id::text AS id FROM yard_inspections w WHERE w.inspection_date < $1::date
                AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.kind = 'yard_walk' AND t.record_id = w.id::text)`,
  equipment_check: `SELECT c.id::text AS id FROM equipment_checks c WHERE c.check_date < $1::date
                      AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.kind = 'equipment_check' AND t.record_id = c.id::text)`,
  service_log: `SELECT s.id::text AS id FROM service_logs s WHERE s.service_date < $1::date
                  AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.kind = 'service_log' AND t.record_id = s.id::text)`,
  equipment_service: `SELECT s.id::text AS id FROM equipment_service_logs s WHERE s.service_date < $1::date
                        AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.kind = 'equipment_service' AND t.record_id = s.id::text)`,
  repair_ticket: `SELECT r.id::text AS id FROM repair_tickets r WHERE r.created_at < $1::date
                    AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.kind = 'repair_ticket' AND t.record_id = r.id::text)`,
};

async function oldCounts(before: string, kinds: Kind[], db?: Pick<PoolClient, "query">) {
  const out: Record<string, number> = {};
  for (const k of kinds) out[k] = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM (${OLD[k]!}) x`, [before], db))!.n;
  return out;
}

/**
 * Move every record of these kinds dated before `before` to the trash, in one transaction. Maintenance entries and
 * tickets are voided as they go in, but quietly: repairs they fixed stay fixed (these are old records being cleared
 * out, not mistakes being undone).
 */
async function trashOld(before: string, kinds: Kind[], by: Actor, reason: string, expect: number) {
  return tx(async (c) => {
    const counts = await oldCounts(before, kinds, c);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total !== expect) throw conflict(`That's now ${total} record${total === 1 ? "" : "s"}, not ${expect}. Check the numbers and try again.`);
    for (const k of kinds) {
      const ids = `SELECT id FROM (${OLD[k]!}) x`;
      if (k === "inspection" || k === "incident") {
        const [states, col, hist] = k === "inspection"
          ? ["inspection_states", "inspection_id", "inspection_state_history"]
          : ["incident_states", "incident_id", "incident_state_history"];
        await c.query(
          `WITH moved AS (
             INSERT INTO ${states} (${col}, state, reason, changed_at, changed_by)
             SELECT id::uuid, 'deleted', $2, now(), $3 FROM (${ids}) p
             ON CONFLICT (${col}) DO UPDATE SET state = 'deleted', reason = $2, changed_at = now(), changed_by = $3
             RETURNING ${col})
           INSERT INTO ${hist} (${col}, action, reason, changed_by) SELECT ${col}, 'delete', $2, $3 FROM moved`,
          [before, reason, by.id],
        );
        continue;
      }
      if (k === "service_log") {
        await c.query(`UPDATE service_logs SET voided_at = now(), voided_by = $3, void_reason = $2, updated_by = $3
                        WHERE voided_at IS NULL AND id::text IN (${ids})`, [before, reason, by.id]);
      } else if (k === "equipment_service") {
        await c.query(`UPDATE equipment_service_logs SET voided_at = now(), voided_by = $3, void_reason = $2
                        WHERE voided_at IS NULL AND id::text IN (${ids})`, [before, reason, by.id]);
      } else if (k === "repair_ticket") {
        await c.query(`UPDATE repair_tickets SET voided_at = now(), voided_by = $3, void_reason = $2
                        WHERE voided_at IS NULL AND id::text IN (${ids})`, [before, reason, by.id]);
      }
      await c.query(
        `WITH moved AS (
           INSERT INTO trash (kind, record_id, reason, deleted_by) SELECT $4, id, $2, $3 FROM (${ids}) p RETURNING record_id)
         INSERT INTO trash_history (kind, record_id, action, reason, changed_by) SELECT $4, record_id, 'delete', $2, $3 FROM moved`,
        [before, reason, by.id, k],
      );
    }
    return { moved: counts, total };
  });
}

// ---------- Routes ----------

const actor = (u: SessionUser): Actor => ({ id: u.id, name: u.name });

export default async function trashRoutes(app: FastifyInstance) {
  const admins = { preHandler: requireRole("admin") };

  app.get("/admin/trash", admins, async () => {
    const rows = await q<TrashRow>(`SELECT ${READY_COLS} FROM (${TRASH_LIST}) x ORDER BY x.deleted_at DESC LIMIT 1000`);
    const totals = await one<{ total: number; ready: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE x.deleted_at <= now() - interval '${TRASH_DAYS} days')::int AS ready
         FROM (${TRASH_LIST}) x`);
    return { days: TRASH_DAYS, total: totals!.total, ready: totals!.ready, items: rows.map(forClient) };
  });

  app.post("/admin/trash", admins, async (req) => {
    const b = obj(req.body);
    const { kind, id } = parseRef(b);
    return moveToTrash(kind, id, actor(req.user!), reqStr(b.reason, "Reason", 500));
  });

  app.post("/admin/trash/restore", admins, async (req) => {
    const { kind, id } = parseRef(obj(req.body));
    return restoreFromTrash(kind, id, actor(req.user!));
  });

  // What Delete forever would remove, worked out by doing it and rolling it back.
  app.post("/admin/trash/preview", admins, async (req) => {
    const { kind, id } = parseRef(obj(req.body));
    return purge(kind, id, actor(req.user!), true);
  });

  app.post("/admin/trash/purge", admins, async (req) => {
    const b = obj(req.body);
    const { kind, id } = parseRef(b);
    const info = await trashed(kind, id);
    if (!info) {
      const again = await purge(kind, id, actor(req.user!)); // already deleted forever (a retry): says so; else not found
      return again;
    }
    const want = forClient(info).confirm;
    if (typeof b.confirm !== "string" || b.confirm.trim().toUpperCase() !== want.toUpperCase()) {
      throw bad(`Type ${want} to confirm.`);
    }
    return purge(kind, id, actor(req.user!), false, (m) => req.log.warn(m));
  });

  // Everything that has been in the trash long enough, oldest first, a batch at a time (the screen calls again until
  // nothing is left). The first call must name how many there are, as typed by the admin.
  app.post("/admin/trash/purge-ready", admins, async (req) => {
    const b = obj(req.body);
    const skip = new Set(Array.isArray(b.skip) ? b.skip.filter((s): s is string => typeof s === "string") : []);
    const ready = (await q<TrashRow>(
      `SELECT ${READY_COLS} FROM (${TRASH_LIST}) x WHERE x.deleted_at <= now() - interval '${TRASH_DAYS} days'
        ORDER BY x.deleted_at, x.kind, x.id`,
    )).filter((r) => !skip.has(`${r.kind}:${r.id}`));
    if (b.more !== true && Number(b.confirm) !== ready.length) {
      throw conflict(`There ${ready.length === 1 ? "is" : "are"} ${ready.length} ready to delete forever, not ${b.confirm}. Check and try again.`);
    }
    const started = Date.now();
    let purged = 0;
    const failed: { kind: Kind; id: string; title: string; error: string }[] = [];
    for (const r of ready) {
      if (Date.now() - started > 20_000) break;
      try {
        await purge(r.kind, r.id, actor(req.user!), false, (m) => req.log.warn(m));
        purged++;
      } catch (e) {
        failed.push({ kind: r.kind, id: r.id, title: titleOf(r), error: e instanceof HttpError ? e.message : "Couldn't delete it." });
        if (!(e instanceof HttpError)) req.log.error(e);
      }
    }
    return { purged, failed, remaining: ready.length - purged - failed.length };
  });

  app.get("/admin/purge-log", admins, async () =>
    q(`SELECT id, kind, title, truck_code, record_date, reason, deleted_at, deleted_by_name, purged_at, purged_by_name, removed, files
         FROM purge_log ORDER BY purged_at DESC, id DESC LIMIT 500`));

  const oldArgs = (src: Record<string, unknown>) => {
    const before = typeof src.before === "string" ? src.before : "";
    if (!isValidDate(before)) throw bad("Pick a date.");
    if (before > new Date().toISOString().slice(0, 10)) throw bad("Pick a date that isn't in the future.");
    const raw = Array.isArray(src.kinds) ? src.kinds : typeof src.kinds === "string" ? src.kinds.split(",") : BY_DATE;
    const kinds = BY_DATE.filter((k) => raw.includes(k));
    if (!kinds.length) throw bad("Pick at least one kind of record.");
    return { before, kinds };
  };

  app.get("/admin/old-records", admins, async (req) => {
    const { before, kinds } = oldArgs((req.query ?? {}) as Record<string, unknown>);
    const counts = await oldCounts(before, kinds);
    return { before, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  });

  app.post("/admin/old-records/trash", admins, async (req) => {
    const b = obj(req.body);
    const { before, kinds } = oldArgs(b);
    const reason = reqStr(b.reason, "Reason", 500);
    const expect = Number(b.confirm);
    if (!Number.isInteger(expect) || expect < 1) throw bad("Type how many records to move to the trash.");
    return trashOld(before, kinds, actor(req.user!), reason, expect);
  });
}
