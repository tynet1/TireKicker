// CSV downloads (SPEC §9 phase 2): inspections, repairs, the maintenance log and trucks, with the same filters as the
// screens. Read-only. Each list counts what the app counts for a truck (live inspections only; deleted ones are never
// exported), unless a filter asks for archived inspections, fixed repairs, voided entries or retired trucks.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireRole } from "../auth.ts";
import { toCsv } from "../csv.ts";
import type { Cell } from "../csv.ts";
import { one, q } from "../db.ts";
import { bad, isValidDate } from "../http.ts";
import { REG_ON_FILE, REG_ON_FILE_JOINS } from "./inspections.ts";
import { CATEGORIES, workOf } from "./service.ts";
import { ticketNumber } from "./tickets.ts";

const MAX_ROWS = 20000;
const SECTION: Record<string, string> = { exterior: "Exterior", interior: "Interior", trailer: "Trailer & crew" };
const STATUS: Record<string, string> = { submitted: "Submitted", reviewed: "Signed off" };
const VEHICLE = `concat_ws(' ', v.year, v.make, v.model)`;

interface Filters {
  vehicleId: number | null;
  from: string | null;
  to: string | null;
  more: boolean; // include archived / fixed / voided / retired, depending on the list
}

function filters(req: FastifyRequest): Filters {
  const qs = (req.query ?? {}) as Record<string, string | undefined>;
  let vehicleId: number | null = null;
  if (qs.vehicle_id) {
    if (!/^\d+$/.test(qs.vehicle_id)) throw bad("vehicle_id must be a number.");
    vehicleId = Number(qs.vehicle_id);
  }
  const date = (key: "from" | "to") => {
    const v = qs[key];
    if (!v) return null;
    if (!isValidDate(v)) throw bad(`"${key}" must be a date like 2026-11-10.`);
    return v;
  };
  const f = { vehicleId, from: date("from"), to: date("to"), more: qs.include === "1" };
  if (f.from && f.to && f.from > f.to) throw bad("The From date is after the To date.");
  return f;
}

/** WHERE parts for the truck and a date column, with their parameters. */
function scope(f: Filters, dateCol: string, params: unknown[], vehicleCol = "v.id"): string[] {
  const where: string[] = [];
  if (f.vehicleId !== null) {
    params.push(f.vehicleId);
    where.push(`${vehicleCol} = $${params.length}`);
  }
  if (f.from) {
    params.push(f.from);
    where.push(`${dateCol} >= $${params.length}::date`);
  }
  if (f.to) {
    params.push(f.to);
    where.push(`${dateCol} <= $${params.length}::date`);
  }
  return where;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function send(reply: FastifyReply, req: FastifyRequest, kind: string, f: Filters, header: string[], rows: Cell[][]) {
  const truck = f.vehicleId !== null
    ? (await one<{ truck_code: string }>(`SELECT truck_code FROM vehicles WHERE id = $1`, [f.vehicleId]))?.truck_code
    : null;
  const when = f.from || f.to ? `${f.from ?? "start"}_to_${f.to ?? today()}` : today();
  const name = [kind, truck, when].filter(Boolean).join("_").replace(/[^\w.-]/g, "_") + ".csv";
  return reply
    .type("text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${name}"`)
    .header("cache-control", "no-store")
    .header("x-row-count", String(rows.length))
    .send(toCsv(header, rows));
}

/** Links back into the app, so a row in the spreadsheet opens the inspection, entry or truck. */
const linkBase = (req: FastifyRequest) => `${req.protocol}://${req.host}/#/`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export default async function exportRoutes(app: FastifyInstance) {
  const supervisors = { preHandler: requireRole("supervisor") };
  const supervisorsAndShop = { preHandler: requireRole("supervisor", "shop") };

  // One row per inspection. Archived ones only with include=1; deleted ones never.
  app.get("/export/inspections.csv", supervisors, async (req, reply) => {
    const f = filters(req);
    const params: unknown[] = [];
    const where = scope(f, "i.inspection_date", params);
    where.push(f.more ? `COALESCE(st.state, 'active') IN ('active', 'archived')` : `COALESCE(st.state, 'active') = 'active'`);
    params.push(MAX_ROWS);
    const rows = await q(
      `SELECT i.id, i.inspection_date, v.truck_code, ${VEHICLE} AS vehicle, i.inspector_name, i.mileage, i.mileage_flagged,
              i.oil_change_due, i.trailer_inspected, i.trailer_number_text,
              CASE WHEN i.trailer_inspected THEN td.name END AS trailer_type,
              (SELECT count(*) FROM inspection_items ii WHERE ii.inspection_id = i.id) AS items,
              r.repairs, r.open_repairs, r.repair_list,
              (SELECT count(*) FROM damage_marks dm WHERE dm.inspection_id = i.id) AS damage_marks,
              (SELECT count(*) FROM photos p WHERE p.inspection_id = i.id) AS photos,
              i.existing_notes, i.new_observations, i.comments,
              ${REG_ON_FILE} AS registration_on_file,
              i.status, i.supervisor_name, i.supervisor_signed_at, i.supervisor_note,
              COALESCE(st.state, 'active') AS state, i.created_at
         FROM inspections i
         JOIN vehicles v ON v.id = i.vehicle_id
         LEFT JOIN inspection_states st ON st.inspection_id = i.id
         LEFT JOIN diagrams td ON td.id = COALESCE(i.trailer_diagram_id, v.trailer_diagram_id)
         LEFT JOIN LATERAL (
           SELECT count(*) AS repairs, count(*) FILTER (WHERE ii.resolved_at IS NULL) AS open_repairs,
                  string_agg(ii.label_snapshot || coalesce(': ' || nullif(btrim(ii.note), ''), ''), '; '
                             ORDER BY ii.section, ii.id) AS repair_list
             FROM inspection_items ii WHERE ii.inspection_id = i.id AND ii.result = 'repair') r ON true
         ${REG_ON_FILE_JOINS}
        WHERE ${where.join(" AND ")}
        ORDER BY i.inspection_date DESC, i.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    const link = linkBase(req);
    return send(reply, req, "inspections", f, [
      "Date", "Truck", "Vehicle", "Inspector", "Mileage", "Mileage lower than before", "Oil change due",
      "Trailer inspected", "Trailer number", "Trailer type", "Items checked", "Repairs", "Repairs still open",
      "Repairs needed", "New damage marks", "Photos", "Existing damage noted", "New observations", "Comments",
      "Registration expires (on file then)", "Status", "Signed off by", "Signed off at", "Supervisor note", "Archived",
      "Submitted at", "Link",
    ], rows.map((r) => [
      r.inspection_date, r.truck_code, r.vehicle, r.inspector_name, r.mileage, r.mileage_flagged, r.oil_change_due,
      r.trailer_inspected, r.trailer_number_text, r.trailer_type, num(r.items), num(r.repairs), num(r.open_repairs),
      r.repair_list, num(r.damage_marks), num(r.photos), r.existing_notes, r.new_observations, r.comments,
      r.registration_on_file, STATUS[r.status] ?? r.status, r.supervisor_name, r.supervisor_signed_at, r.supervisor_note,
      r.state === "archived", r.created_at, `${link}inspection/${r.id}`,
    ]));
  });

  // One row per repair item: open ones (the repairs board), or with include=1 the fixed ones too.
  app.get("/export/repairs.csv", supervisorsAndShop, async (req, reply) => {
    const f = filters(req);
    const params: unknown[] = [];
    const where = scope(f, "i.inspection_date", params);
    if (!f.more) where.push("ii.resolved_at IS NULL");
    params.push(MAX_ROWS);
    const rows = await q(
      `SELECT ii.id, v.truck_code, ${VEHICLE} AS vehicle, ii.section, ii.label_snapshot AS label, ii.note,
              i.id AS inspection_id, i.inspection_date, i.inspector_name,
              (COALESCE(ii.resolved_at::date, current_date) - i.inspection_date) AS days_open,
              ii.resolved_at, ru.name AS resolved_by_name, ii.resolution_note,
              (SELECT min(slr.service_log_id) FROM service_log_repairs slr JOIN service_logs sl ON sl.id = slr.service_log_id
                WHERE slr.inspection_item_id = ii.id AND slr.active AND slr.resolved_here AND sl.voided_at IS NULL) AS service_log_id,
              (SELECT count(*) FROM photos p WHERE p.inspection_item_id = ii.id) AS photos,
              ARRAY(SELECT ti.ticket_id FROM repair_ticket_items ti JOIN repair_tickets t ON t.id = ti.ticket_id
                     WHERE ti.inspection_item_id = ii.id AND t.voided_at IS NULL ORDER BY ti.ticket_id) AS ticket_ids
         FROM inspection_items ii
         JOIN live_inspections i ON i.id = ii.inspection_id
         JOIN vehicles v ON v.id = i.vehicle_id
         LEFT JOIN users ru ON ru.id = ii.resolved_by
        WHERE ii.result = 'repair' AND v.active ${where.length ? "AND " + where.join(" AND ") : ""}
        ORDER BY v.truck_code, i.inspection_date, i.created_at, ii.section, ii.id
        LIMIT $${params.length}`,
      params,
    );
    // Damage pinned on an incident report is a repair until it's marked repaired (018).
    const dparams: unknown[] = [];
    const dwhere = scope(f, "n.incident_date", dparams);
    if (!f.more) dwhere.push("dr.id IS NULL");
    dparams.push(MAX_ROWS);
    const dmg = await q(
      `SELECT v.truck_code, ${VEHICLE} AS vehicle, dm.diagram, dm.seq, dm.note, n.id AS incident_id, n.incident_date,
              n.reporter_name, (COALESCE(dr.repaired_at::date, current_date) - n.incident_date) AS days_open,
              dr.repaired_at, ru.name AS repaired_by_name, dr.note AS repair_note, dr.service_log_id,
              (SELECT count(*) FROM photos p WHERE p.damage_mark_id = dm.id) AS photos
         FROM damage_marks dm
         JOIN live_incidents n ON n.id = dm.incident_id
         JOIN vehicles v ON v.id = n.vehicle_id
         LEFT JOIN damage_repairs dr ON dr.damage_mark_id = dm.id AND dr.active
         LEFT JOIN users ru ON ru.id = dr.repaired_by
        WHERE v.active ${dwhere.length ? "AND " + dwhere.join(" AND ") : ""}
        ORDER BY v.truck_code, n.incident_date, n.created_at, dm.diagram DESC, dm.seq
        LIMIT $${dparams.length}`,
      dparams,
    );
    const link = linkBase(req);
    const out = [
      ...rows.map((r) => ({ truck: r.truck_code as string, date: String(r.inspection_date), row: [
        r.truck_code, r.vehicle, SECTION[r.section] ?? r.section, r.label, r.note, r.inspection_date, r.inspector_name,
        r.resolved_at ? "Fixed" : "Open", num(r.days_open), r.resolved_at, r.resolved_by_name, r.resolution_note,
        r.service_log_id ? `${link}service/${r.service_log_id}` : null,
        (r.ticket_ids as number[]).map(ticketNumber).join("; "), num(r.photos), `${link}inspection/${r.inspection_id}`,
      ] as Cell[] })),
      ...dmg.map((r) => ({ truck: r.truck_code as string, date: String(r.incident_date), row: [
        r.truck_code, r.vehicle, "Incident damage", r.diagram === "trailer" ? "Trailer damage" : "Damage", r.note,
        r.incident_date, r.reporter_name, r.repaired_at ? "Fixed" : "Open", num(r.days_open), r.repaired_at, r.repaired_by_name,
        r.service_log_id ? null : r.repair_note, r.service_log_id ? `${link}service/${r.service_log_id}` : null,
        "", num(r.photos), `${link}incident/${r.incident_id}`,
      ] as Cell[] })),
    ].sort((a, b) => a.truck.localeCompare(b.truck) || a.date.localeCompare(b.date));
    return send(reply, req, f.more ? "repairs" : "open_repairs", f, [
      "Truck", "Vehicle", "Section", "Item", "Note", "Reported", "Reported by", "Status", "Days open", "Fixed at",
      "Fixed by", "How it was fixed", "Maintenance entry", "Repair tickets", "Photos", "Report link",
    ], out.map((o) => o.row));
  });

  // One row per maintenance entry; voided ones only with include=1.
  app.get("/export/maintenance.csv", supervisorsAndShop, async (req, reply) => {
    const f = filters(req);
    const params: unknown[] = [];
    const where = scope(f, "s.service_date", params);
    if (!f.more) where.push("s.voided_at IS NULL");
    where.push("NOT EXISTS (SELECT 1 FROM trash tr WHERE tr.kind = 'service_log' AND tr.record_id = s.id::text)");
    params.push(MAX_ROWS);
    const rows = await q(
      `SELECT s.id, s.service_date, v.truck_code, ${VEHICLE} AS vehicle, s.mileage, s.work, s.category,
              s.next_due_mileage, s.next_due_date, s.description, s.parts, s.notes, s.performed_by, s.vendor, s.cost,
              (SELECT count(*) FROM service_log_repairs r WHERE r.service_log_id = s.id AND r.active) AS repairs,
              (SELECT count(*) FROM damage_repairs dr WHERE dr.service_log_id = s.id AND dr.active) AS damage,
              (SELECT count(*) FROM photos p WHERE p.service_log_id = s.id) AS photos,
              cu.name AS created_by_name, s.created_at, s.version, s.updated_at, uu.name AS updated_by_name,
              s.voided_at, s.void_reason
         FROM service_logs s
         JOIN vehicles v ON v.id = s.vehicle_id
         LEFT JOIN users cu ON cu.id = s.created_by
         LEFT JOIN users uu ON uu.id = s.updated_by
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY s.service_date DESC, s.id DESC
        LIMIT $${params.length}`,
      params,
    );
    const link = linkBase(req);
    const label = (t: string) => CATEGORIES[t] ?? t;
    return send(reply, req, "maintenance", f, [
      "Date", "Truck", "Vehicle", "Mileage", "Work", "Next due", "Description", "Parts", "Notes", "Performed by",
      "Vendor", "Cost", "Repairs closed", "Damage fixed", "Photos", "Entered by", "Entered at", "Last edited by",
      "Last edited at", "Voided", "Void reason", "Link",
    ], rows.map((r) => {
      const work = workOf(r);
      const due = work.filter((w) => w.next_due_mileage !== null || w.next_due_date).map((w) =>
        `${label(w.type)}: ${[w.next_due_mileage !== null ? `${w.next_due_mileage.toLocaleString("en-US")} mi` : null,
          w.next_due_date].filter(Boolean).join(" or ")}`);
      const edited = Number(r.version) > 1;
      return [
        r.service_date, r.truck_code, r.vehicle, r.mileage, work.map((w) => label(w.type)).join("; "), due.join("; "),
        r.description, r.parts, r.notes, r.performed_by, r.vendor, num(r.cost), num(r.repairs), num(r.damage),
        num(r.photos), r.created_by_name, r.created_at, edited ? r.updated_by_name : null, edited ? r.updated_at : null,
        !!r.voided_at, r.void_reason, `${link}service/${r.id}`,
      ];
    }));
  });

  // One row per truck in service; retired ones too with include=1.
  app.get("/export/trucks.csv", supervisorsAndShop, async (req, reply) => {
    const f = filters(req);
    const rows = await q(
      `SELECT v.id, v.truck_code, v.unit, v.year, v.make, v.model, v.vin, v.plate, v.registration_expires,
              (v.registration_expires < current_date) AS registration_expired, v.pulls_trailer,
              CASE WHEN v.pulls_trailer THEN COALESCE(td.name, (SELECT name FROM diagrams WHERE kind = 'trailer' ORDER BY id LIMIT 1)) END AS trailer_type,
              v.active, li.inspection_date AS last_inspection_date, li.status AS last_status,
              GREATEST(li.mileage, (SELECT max(s.mileage) FROM service_logs s WHERE s.vehicle_id = v.id AND s.voided_at IS NULL)) AS last_mileage,
              coalesce(orc.n, 0) + coalesce(idm.n, 0) AS open_repairs, coalesce(dof.n, 0) AS damage_on_file,
              ls.service_date AS last_service_date
         FROM vehicles v
         LEFT JOIN diagrams td ON td.id = v.trailer_diagram_id
         -- Counted per truck from the open repairs and the damage marks, not truck by truck through every inspection.
         LEFT JOIN (
           SELECT i.vehicle_id, count(*) AS n FROM inspection_items ii JOIN live_inspections i ON i.id = ii.inspection_id
            WHERE ii.result = 'repair' AND ii.resolved_at IS NULL GROUP BY i.vehicle_id) orc ON orc.vehicle_id = v.id
         -- Incident damage not yet repaired is a repair too (018), as on the truck list.
         LEFT JOIN (
           SELECT dm.vehicle_id, count(*) AS n FROM live_damage_marks dm
            WHERE dm.incident_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM damage_repairs dr WHERE dr.damage_mark_id = dm.id AND dr.active)
            GROUP BY dm.vehicle_id) idm ON idm.vehicle_id = v.id
         LEFT JOIN (
           SELECT dm.vehicle_id, count(*) AS n FROM live_damage_marks dm
            WHERE NOT EXISTS (SELECT 1 FROM damage_repairs dr WHERE dr.damage_mark_id = dm.id AND dr.active)
            GROUP BY dm.vehicle_id) dof ON dof.vehicle_id = v.id
         LEFT JOIN LATERAL (
           SELECT inspection_date, mileage, status FROM live_inspections
            WHERE vehicle_id = v.id ORDER BY inspection_date DESC, created_at DESC LIMIT 1) li ON true
         LEFT JOIN LATERAL (
           SELECT service_date FROM service_logs
            WHERE vehicle_id = v.id AND voided_at IS NULL ORDER BY service_date DESC, id DESC LIMIT 1) ls ON true
        ${f.more ? "WHERE NOT EXISTS (SELECT 1 FROM trash tr WHERE tr.kind = 'vehicle' AND tr.record_id = v.id::text)" : "WHERE v.active"}
        ORDER BY v.truck_code`,
    );
    const link = linkBase(req);
    return send(reply, req, "trucks", { ...f, vehicleId: null, from: null, to: null }, [
      "Truck", "Unit", "Year", "Make", "Model", "VIN", "Plate", "Registration expires", "Registration expired",
      "Pulls a trailer", "Trailer type", "In service", "Last inspection", "Last inspection status", "Last mileage",
      "Open repairs", "Damage on file", "Last maintenance", "Link",
    ], rows.map((r) => [
      r.truck_code, r.unit, r.year, r.make, r.model, r.vin, r.plate, r.registration_expires, !!r.registration_expired,
      r.pulls_trailer, r.trailer_type, r.active, r.last_inspection_date, r.last_status ? STATUS[r.last_status] : null,
      num(r.last_mileage), num(r.open_repairs), num(r.damage_on_file), r.last_service_date, `${link}truck/${r.id}`,
    ]));
  });
}
