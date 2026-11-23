// Vehicle incident reports (SPEC §9): a supervisor files one from the phone for a truck that was in an accident. It
// prints as one PDF incident packet (src/incident-pdf.ts), and its damage pins join the truck's
// damage on file and repair items. Supervisors and admins only: reports hold the other party's details. Read-only
// once filed (corrections are notes), archive/delete without erasing, submits idempotent on client_id.
import type { FastifyInstance } from "fastify";
import { atLeast, requireRole, requireUser } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import type { Db } from "../db.ts";
import { defaultDiagram, diagramUrl, pickDiagram } from "../diagrams.ts";
import { bad, conflict, DATE_RE, HttpError, int, isValidDate, notFound, obj, reqStr, str, UUID_RE, uuidParam } from "../http.ts";
import { renderHtmlToPdf } from "../pdf.ts";
import { incidentPdfHtml } from "../incident-pdf.ts";
import { attachFailed, UNATTACHED } from "../photo-owners.ts";
import { decodePngDataUrl, discardUnlessUsed, files, newKey } from "../storage.ts";

const SHORT = 200;
const LONG = 5000;

/** Yes / no / not answered. */
function yn(v: unknown, field: string): boolean | null {
  if (v == null || v === "") return null;
  if (v === true || v === "yes") return true;
  if (v === false || v === "no") return false;
  throw bad(`${field} must be yes or no.`);
}

const list = (v: unknown, field: string, max: number): unknown[] => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad(`${field} must be a list.`);
  if (v.length > max) throw bad(`Too many ${field}.`);
  return v;
};

/** The other party's fields (Vehicle Accident Report page 2), all optional text except passengers. */
export const PARTY_FIELDS = [
  "name", "address", "city", "state", "zip", "phone", "license_no", "vehicle_year", "make", "model",
  "plate_state", "plate_no", "insurance_company", "policy_no", "insurance_phone",
] as const;
export const WITNESS_FIELDS = ["name", "phone", "address", "city", "state", "zip"] as const;
export type Party = Partial<Record<(typeof PARTY_FIELDS)[number], string>> & { passengers?: boolean | null };
export type Witness = Partial<Record<(typeof WITNESS_FIELDS)[number], string>>;

function textFields<K extends string>(o: Record<string, unknown>, keys: readonly K[], what: string) {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const s = str(o[k], `${what}: ${k.replace(/_/g, " ")}`, SHORT);
    if (s) out[k] = s;
  }
  return out;
}

interface DamageIn { key: string; diagram: "truck" | "trailer"; x: number; y: number; note: string | null }
interface PhotoIn { id: string; caption: string | null; damage_key: string | null; map: boolean }

export interface IncidentSubmit {
  client_id: string;
  vehicle_id: number;
  trailer: { number: string | null } | null;
  truck_diagram_id: number | null;
  trailer_diagram_id: number | null;
  fields: Record<string, unknown>; // the incidents columns below, validated
  other_parties: Party[];
  witnesses: Witness[];
  damage: DamageIn[];
  photos: PhotoIn[];
  sketch: Buffer | null;
  driver_signature: Buffer | null;
  reporter_signature: Buffer;
}

const num = (v: unknown, field: string, min: number, max: number): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${field} is out of range.`);
  return n;
};

export function parseIncident(body: unknown): IncidentSubmit {
  const b = obj(body);
  const clientId = String(b.client_id ?? "").toLowerCase();
  if (!UUID_RE.test(clientId)) throw bad("client_id must be a uuid.");
  const date = String(b.incident_date ?? "");
  if (!DATE_RE.test(date) || !isValidDate(date)) throw bad("Date of the incident is required.");
  const max = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  if (date > max || date < "2020-01-01") throw bad("The date looks wrong. Check the date of the incident.");
  const time = str(b.incident_time, "Time", 5);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad("Time must look like 14:30.");
  const anyoneInjured = yn(b.anyone_injured, "Anyone injured");
  if (anyoneInjured === null) throw bad("Answer whether anyone was injured.");
  const employeeInjured = anyoneInjured ? yn(b.employee_injured, "Employee injured") === true : false;
  const lat = num(b.latitude, "Latitude", -90, 90);
  const lng = num(b.longitude, "Longitude", -180, 180);
  if ((lat === null) !== (lng === null)) throw bad("Location needs both latitude and longitude.");

  const reporterSig = decodePngDataUrl(b.reporter_signature);
  if (!reporterSig) throw bad("The reporting manager's signature is required.");
  const driverSig = b.driver_signature == null ? null : decodePngDataUrl(b.driver_signature);
  if (b.driver_signature != null && !driverSig) throw bad("The driver's signature couldn't be read. Clear it and sign again.");
  const sketch = b.sketch == null ? null : decodePngDataUrl(b.sketch, 2_500_000);
  if (b.sketch != null && !sketch) throw bad("The drawing couldn't be read. Clear it and draw it again.");

  const parties = list(b.other_parties, "other parties", 8).map((x, i): Party => {
    const o = obj(x, `other party ${i + 1}`);
    return { ...textFields(o, PARTY_FIELDS, `Other party ${i + 1}`), passengers: yn(o.passengers, "Other party passengers") };
  }).filter((p) => Object.entries(p).some(([k, v]) => k !== "passengers" && v));
  const witnesses = list(b.witnesses, "witnesses", 8).map((x, i): Witness => textFields(obj(x, `witness ${i + 1}`), WITNESS_FIELDS, `Witness ${i + 1}`))
    .filter((w) => Object.keys(w).length);

  const keys = new Set<string>();
  const damage = list(b.damage, "damage marks", 40).map((x): DamageIn => {
    const o = obj(x, "damage mark");
    const key = String(o.key ?? "");
    if (!/^[\w-]{1,40}$/.test(key) || keys.has(key)) throw bad("Each damage mark needs a unique key.");
    keys.add(key);
    if (o.diagram !== "truck" && o.diagram !== "trailer") throw bad("Damage diagram must be truck or trailer.");
    const xy = (v: unknown, f: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw bad(`Damage ${f} must be between 0 and 1.`);
      return Math.round(n * 10000) / 10000;
    };
    return { key, diagram: o.diagram, x: xy(o.x, "x"), y: xy(o.y, "y"), note: str(o.note, "Damage note", 500) };
  });
  const seen = new Set<string>();
  const photos = list(b.photos, "photos", 60).map((x): PhotoIn => {
    const o = obj(x, "photo");
    const id = String(o.id ?? "").toLowerCase();
    if (!UUID_RE.test(id) || seen.has(id)) throw bad("Each photo needs a unique id.");
    seen.add(id);
    const dk = o.damage_key == null ? null : String(o.damage_key);
    if (dk !== null && !keys.has(dk)) throw bad("A photo points at a damage mark that isn't in this report.");
    return { id, caption: str(o.caption, "Photo caption", 300), damage_key: dk, map: o.map === true };
  });
  if (photos.filter((p) => p.map).length > 1) throw bad("Pick one map picture.");

  const trailer = b.trailer == null ? null : { number: str(obj(b.trailer, "trailer").number, "Trailer number", 40) };
  if (!trailer && damage.some((d) => d.diagram === "trailer")) throw bad("Trailer damage needs a trailer on the report.");

  const s = (k: string, label: string, max = SHORT) => str(b[k], label, max);
  const fields: Record<string, unknown> = {
    incident_date: date,
    incident_time: time,
    weather: s("weather", "Weather"),
    location_name: s("location_name", "Incident location"),
    on_job: yn(b.on_job, "On a job"),
    site_name: s("site_name", "Site name"),
    street: s("street", "Street address or intersection"),
    city: s("city", "City", 100),
    state: s("state", "State", 40),
    zip: s("zip", "Zip code", 20),
    latitude: lat === null ? null : Math.round(lat * 1e6) / 1e6,
    longitude: lng === null ? null : Math.round(lng * 1e6) / 1e6,
    location_accuracy_m: lat === null || b.location_accuracy_m == null ? null : Math.round(num(b.location_accuracy_m, "Accuracy", 0, 1e6)!),
    property_damage: yn(b.property_damage, "Property damage") === true,
    theft_vandalism: yn(b.theft_vandalism, "Theft or vandalism") === true,
    police_present: yn(b.police_present, "Police present"),
    police_department: s("police_department", "Police department"),
    police_phone: s("police_phone", "Police phone", 40),
    officer_name: s("officer_name", "Officer name"),
    police_report_no: s("police_report_no", "Police report number", 80),
    citation_driver: yn(b.citation_driver, "Citation issued"),
    citation_other: yn(b.citation_other, "Other party cited"),
    anyone_injured: anyoneInjured,
    injury_description: anyoneInjured ? s("injury_description", "Injuries", LONG) : null,
    employee_injured: employeeInjured,
    medical_evaluation: employeeInjured ? yn(b.medical_evaluation, "Medical evaluation") : null,
    medical_clinic: employeeInjured ? s("medical_clinic", "Clinic") : null,
    ad_test: yn(b.ad_test, "Drug and alcohol test"),
    ad_clinic: s("ad_clinic", "Drug and alcohol test clinic"),
    driver_user_id: b.driver_user_id == null || b.driver_user_id === "" ? null : int(b.driver_user_id, "driver_user_id", 1),
    driver_name: reqStr(b.driver_name, "Driver's name", 100),
    employee_manager: s("employee_manager", "Employee's manager", 100),
    department: s("department", "Department", 100),
    passengers: yn(b.passengers, "Passengers"),
    passenger_names: s("passenger_names", "Passenger names", 500),
    seatbelt_driver: yn(b.seatbelt_driver, "Seatbelt"),
    seatbelt_passenger: yn(b.seatbelt_passenger, "Passenger seatbelt"),
    drivable: yn(b.drivable, "Vehicle drivable"),
    towed_to: s("towed_to", "Towed to", 300),
    damage_gc: s("damage_gc", "Damage to our vehicle", 1000),
    damage_other: s("damage_other", "Damage to the other vehicle", 1000),
    other_marks: s("other_marks", "Marks on the other vehicle", 1000),
    other_appearance: s("other_appearance", "Other parties' appearance", 1000),
    description: reqStr(b.description, "What happened", LONG),
    manager_comments: s("manager_comments", "Manager comments", LONG),
    preventive_measures: s("preventive_measures", "Preventive measures", LONG),
    reporter_name: reqStr(b.reporter_name, "Reporting manager's name", 100),
  };
  if (!fields.passengers) { fields.passenger_names = null; fields.seatbelt_passenger = null; }
  if (fields.drivable !== false) fields.towed_to = null;
  if (fields.ad_test !== true) fields.ad_clinic = null;
  if (fields.on_job !== true) fields.site_name = null;
  const diag = (v: unknown, f: string) => (v == null || v === "" ? null : int(v, f, 1));
  return {
    client_id: clientId, vehicle_id: int(b.vehicle_id, "vehicle_id", 1), trailer,
    truck_diagram_id: diag(b.truck_diagram_id, "truck_diagram_id"), trailer_diagram_id: diag(b.trailer_diagram_id, "trailer_diagram_id"),
    fields, other_parties: parties, witnesses, damage, photos,
    sketch, driver_signature: driverSig, reporter_signature: reporterSig,
  };
}

const byClientId = (clientId: string) => one<{ id: string }>(`SELECT id FROM incidents WHERE client_id = $1`, [clientId]);

class DuplicateSubmit extends Error {}

export async function submitIncident(input: IncidentSubmit, userId: number) {
  const dup = await byClientId(input.client_id);
  if (dup) return { id: dup.id, duplicate: true };
  const vehicle = await one(`SELECT id, diagram_id, trailer_diagram_id FROM vehicles WHERE id = $1 AND active`, [input.vehicle_id]);
  if (!vehicle) throw bad("That truck isn't in the active fleet.");
  if (input.fields.driver_user_id != null && !(await one(`SELECT 1 FROM users WHERE id = $1`, [input.fields.driver_user_id]))) {
    throw bad("That driver isn't a user of the app. Type the name instead.");
  }
  const truckDiagram = await pickDiagram([input.truck_diagram_id, vehicle.diagram_id], "truck");
  const trailerDiagram = input.trailer ? await pickDiagram([input.trailer_diagram_id, vehicle.trailer_diagram_id], "trailer") : null;

  // Photos must already be uploaded and attached to nothing (whoever is signed in on the phone may send them).
  if (input.photos.length) {
    const ids = input.photos.map((p) => p.id);
    const found = await q(`SELECT id FROM photos WHERE id = ANY($1::uuid[]) AND ${UNATTACHED}`, [ids]);
    const ok = new Set(found.map((f) => f.id));
    const notReady = ids.filter((id) => !ok.has(id));
    if (notReady.length) throw new HttpError(422, "Some photos haven't finished uploading yet.", { code: "photos_missing", photos: notReady });
  }

  const written: { key: string; col: string }[] = [];
  const save = async (buf: Buffer | null, col: string) => {
    if (!buf) return null;
    const key = newKey("png");
    await files.put(key, buf);
    written.push({ key, col });
    return key;
  };
  const f = input.fields;
  try {
    const reporterSig = await save(input.reporter_signature, "reporter_signature_path");
    const driverSig = await save(input.driver_signature, "driver_signature_path");
    const sketch = await save(input.sketch, "sketch_path");
    return await tx(async (c) => {
      const cols: Record<string, unknown> = {
        client_id: input.client_id, vehicle_id: input.vehicle_id,
        trailer_number_text: input.trailer ? input.trailer.number : null,
        truck_diagram_id: truckDiagram?.id ?? null, trailer_diagram_id: trailerDiagram?.id ?? null,
        ...f,
        other_parties: JSON.stringify(input.other_parties), witnesses: JSON.stringify(input.witnesses),
        sketch_path: sketch, map_photo_id: input.photos.find((p) => p.map)?.id ?? null,
        driver_signature_path: driverSig, reporter_user_id: userId, reporter_signature_path: reporterSig,
      };
      const names = Object.keys(cols);
      const ins = await c.query(
        `INSERT INTO incidents (${names.join(", ")}, trailer_id)
         VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")},
                 (SELECT id FROM trailers WHERE active AND lower(trailer_number) = lower($${names.length + 1}) LIMIT 1))
         ON CONFLICT (client_id) DO NOTHING RETURNING id`,
        [...Object.values(cols), input.trailer?.number ?? null],
      );
      if (!ins.rows[0]) throw new DuplicateSubmit();
      const id: string = ins.rows[0].id;
      const markIds = new Map<string, number>();
      const seq = { truck: 0, trailer: 0 };
      for (const d of input.damage) {
        const r = await c.query(
          `INSERT INTO damage_marks (incident_id, diagram, seq, x, y, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [id, d.diagram, ++seq[d.diagram], d.x, d.y, d.note],
        );
        markIds.set(d.key, r.rows[0].id);
      }
      for (const p of input.photos) {
        const r = await c.query(
          `UPDATE photos SET incident_id = $2, caption = $3, damage_mark_id = $4 WHERE id = $1 AND ${UNATTACHED}`,
          [p.id, id, p.caption, p.damage_key ? markIds.get(p.damage_key) ?? null : null],
        );
        if (r.rowCount !== 1) throw await attachFailed(c, p.id, "A photo was attached to something else. Remove it and try again.");
      }
      // Whoever filed it has seen it; everyone else with access is told on their home screen.
      await c.query(`INSERT INTO incident_reads (incident_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, userId]);
      return { id, damage: input.damage.length, duplicate: false };
    });
  } catch (e) {
    for (const w of written) {
      await discardUnlessUsed(w.key, async () => !!(await one(`SELECT 1 FROM incidents WHERE ${w.col} = $1`, [w.key])));
    }
    if (e instanceof DuplicateSubmit) {
      const d = await byClientId(input.client_id);
      if (d) return { id: d.id, duplicate: true };
    }
    throw e;
  }
}

export type IncidentState = "active" | "archived" | "deleted";
type StateAction = "archive" | "unarchive" | "delete" | "restore";
const TRANSITIONS: Record<StateAction, { from: IncidentState[]; to: IncidentState }> = {
  archive: { from: ["active"], to: "archived" },
  unarchive: { from: ["archived"], to: "active" },
  delete: { from: ["active", "archived"], to: "deleted" },
  restore: { from: ["deleted"], to: "active" },
};
const ALREADY: Record<IncidentState, string> = {
  active: "This report isn't archived or deleted.",
  archived: "This report is already archived.",
  deleted: "This report is deleted. Restore it first (Admin → Trash).",
};

/** Archive, un-archive, delete or restore a report. The report never changes; the state row and its history do. */
export async function changeIncidentState(id: string, action: StateAction, userId: number, reason: string | null) {
  const t = TRANSITIONS[action];
  return tx(async (c) => {
    if (!(await c.query(`SELECT id FROM incidents WHERE id = $1 FOR UPDATE`, [id])).rows[0]) throw notFound("Incident report not found.");
    const cur = (await c.query(`SELECT state FROM incident_states WHERE incident_id = $1`, [id])).rows[0];
    const from = (cur?.state ?? "active") as IncidentState;
    if (!t.from.includes(from)) throw conflict(ALREADY[from]);
    await c.query(
      `INSERT INTO incident_states (incident_id, state, reason, changed_at, changed_by) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (incident_id) DO UPDATE SET state = $2, reason = $3, changed_at = now(), changed_by = $4`,
      [id, t.to, t.to === "active" ? null : reason, userId],
    );
    await c.query(`INSERT INTO incident_state_history (incident_id, action, reason, changed_by) VALUES ($1, $2, $3, $4)`,
      [id, action, reason, userId]);
    return { state: t.to };
  });
}

/** Everything about one report, for the detail screen and the PDF. */
export async function loadIncident(id: string, db?: Db) {
  const n = await one(
    `SELECT n.*, v.truck_code, v.unit, v.vin, v.plate, v.year, v.make, v.model,
            d.id AS dia_id, d.file_path AS dia_path, td.id AS trailer_dia_id, td.file_path AS trailer_dia_path, td.name AS trailer_type,
            COALESCE(s.state, 'active') AS record_state, s.reason AS state_reason, s.changed_at AS state_changed_at, su.name AS state_changed_by_name
       FROM incidents n
       JOIN vehicles v ON v.id = n.vehicle_id
       LEFT JOIN diagrams d ON d.id = COALESCE(n.truck_diagram_id, v.diagram_id)
       LEFT JOIN diagrams td ON td.id = COALESCE(n.trailer_diagram_id, v.trailer_diagram_id)
       LEFT JOIN incident_states s ON s.incident_id = n.id
       LEFT JOIN users su ON su.id = s.changed_by
      WHERE n.id = $1`,
    [id], db,
  );
  if (!n) return null;
  const damage = await q(
    `SELECT dm.id, dm.diagram, dm.seq, dm.x, dm.y, dm.note,
            dr.id AS repair_id, dr.repaired_at, dr.service_log_id, ru.name AS repaired_by_name
       FROM damage_marks dm
       LEFT JOIN damage_repairs dr ON dr.damage_mark_id = dm.id AND dr.active
       LEFT JOIN users ru ON ru.id = dr.repaired_by
      WHERE dm.incident_id = $1 ORDER BY dm.diagram DESC, dm.seq`,
    [id], db,
  );
  const photos = await q(
    `SELECT id, caption, damage_mark_id, file_path, created_at FROM photos WHERE incident_id = $1 ORDER BY created_at, id`, [id], db);
  const notes = await q(
    `SELECT nt.id, nt.note, nt.created_at, u.name AS created_by_name
       FROM incident_notes nt JOIN users u ON u.id = nt.created_by WHERE nt.incident_id = $1 ORDER BY nt.created_at, nt.id`,
    [id], db,
  );
  const history = await q(
    `SELECT h.action, h.reason, h.changed_at, u.name AS changed_by_name
       FROM incident_state_history h JOIN users u ON u.id = h.changed_by WHERE h.incident_id = $1 ORDER BY h.changed_at, h.id`,
    [id], db,
  );
  const truckFallback = n.dia_id ? null : await defaultDiagram("truck");
  const trailerFallback = n.trailer_dia_id ? null : await defaultDiagram("trailer");
  return {
    incident: n,
    damage,
    photos,
    notes,
    history,
    truckDiagram: { id: (n.dia_id ?? truckFallback?.id ?? null) as number | null, file_path: (n.dia_path ?? truckFallback?.file_path ?? null) as string | null },
    trailerDiagram: n.trailer_number_text !== null || n.trailer_diagram_id
      ? { id: (n.trailer_dia_id ?? trailerFallback?.id ?? null) as number | null, file_path: (n.trailer_dia_path ?? trailerFallback?.file_path ?? null) as string | null,
        name: (n.trailer_type ?? null) as string | null }
      : null,
  };
}
export type IncidentData = NonNullable<Awaited<ReturnType<typeof loadIncident>>>;

/**
 * The report for the phone: no file paths, files as URLs. `state` is the report's archive state, like an inspection's;
 * the address's state (incidents.state) goes as `address_state`.
 */
function forPhone(d: IncidentData, unread: boolean) {
  const n = d.incident;
  const {
    sketch_path, driver_signature_path, reporter_signature_path, dia_id: _a, dia_path: _b, trailer_dia_id: _c,
    trailer_dia_path: _d, trailer_type: _e, record_state: state, state_reason, state_changed_at, state_changed_by_name,
    state: address_state, ...rest
  } = n;
  return {
    ...rest,
    address_state,
    state,
    state_info: state !== "active" ? { reason: state_reason, changed_at: state_changed_at, changed_by_name: state_changed_by_name } : null,
    state_history: d.history,
    unread,
    sketch_url: sketch_path ? `/api/incidents/${n.id}/file/sketch` : null,
    driver_signature_url: driver_signature_path ? `/api/incidents/${n.id}/file/driver` : null,
    reporter_signature_url: reporter_signature_path ? `/api/incidents/${n.id}/file/reporter` : null,
    truck_diagram_url: diagramUrl(d.truckDiagram.id, d.truckDiagram.file_path),
    trailer_diagram_url: d.trailerDiagram ? diagramUrl(d.trailerDiagram.id, d.trailerDiagram.file_path) : null,
    trailer_type: d.trailerDiagram?.name ?? null,
    damage: d.damage,
    photos: d.photos.map(({ file_path: _f, ...p }) => ({ ...p, map: p.id === n.map_photo_id })),
    notes: d.notes,
  };
}

const LIST_COLS = `n.id, n.vehicle_id, v.truck_code, n.incident_date, n.incident_time, n.driver_name, n.reporter_name,
  n.location_name, n.city, n.anyone_injured, n.employee_injured, n.created_at,
  (SELECT count(*) FROM damage_marks dm WHERE dm.incident_id = n.id)::int AS damage_count,
  (SELECT count(*) FROM damage_marks dm WHERE dm.incident_id = n.id
     AND NOT EXISTS (SELECT 1 FROM damage_repairs dr WHERE dr.damage_mark_id = dm.id AND dr.active))::int AS open_damage`;

export default async function incidentRoutes(app: FastifyInstance) {
  const sups = { preHandler: requireRole("supervisor") };
  const admins = { preHandler: requireRole("admin") };

  // What the form needs besides the truck: who can be picked as the driver.
  app.get("/incident-config", sups, async () => ({
    people: await q(`SELECT id, name, role FROM users WHERE active ORDER BY name, id`),
  }));

  app.post("/incidents", { ...sups, bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const out = await submitIncident(parseIncident(req.body), req.user!.id);
    return reply.code(out.duplicate ? 200 : 201).send(out);
  });

  // Reports, newest first: live ones, or archived=only / archived=include, optionally for one truck.
  app.get("/incidents", sups, async (req) => {
    const qs = (req.query ?? {}) as Record<string, string | undefined>;
    const params: unknown[] = [req.user!.id];
    const where: string[] = [];
    if (qs.vehicle_id) {
      if (!/^\d+$/.test(qs.vehicle_id)) throw bad("vehicle_id must be a number.");
      params.push(Number(qs.vehicle_id));
      where.push(`n.vehicle_id = $${params.length}`);
    }
    const st = "COALESCE(s.state, 'active')";
    if (qs.archived === "only") where.push(`${st} = 'archived'`);
    else if (qs.archived === "include") where.push(`${st} IN ('active', 'archived')`);
    else where.push(`${st} = 'active'`);
    params.push(Math.min(Number(qs.limit) || 100, 500));
    return q(
      `SELECT ${LIST_COLS}, ${st} AS state,
              NOT EXISTS (SELECT 1 FROM incident_reads r WHERE r.incident_id = n.id AND r.user_id = $1) AS unread
         FROM incidents n JOIN vehicles v ON v.id = n.vehicle_id
         LEFT JOIN incident_states s ON s.incident_id = n.id
        WHERE ${where.join(" AND ")}
        ORDER BY n.incident_date DESC, n.created_at DESC LIMIT $${params.length}`,
      params,
    );
  });

  // New reports this user hasn't opened yet (home screen), from the last 60 days.
  app.get("/incidents/unread", sups, async (req) =>
    q(
      `SELECT ${LIST_COLS}
         FROM live_incidents n JOIN vehicles v ON v.id = n.vehicle_id
        WHERE n.created_at > now() - interval '60 days'
          AND NOT EXISTS (SELECT 1 FROM incident_reads r WHERE r.incident_id = n.id AND r.user_id = $1)
        ORDER BY n.created_at DESC LIMIT 20`,
      [req.user!.id],
    ));

  app.get("/incidents/:id", sups, async (req) => {
    const id = uuidParam(req.params);
    const d = await loadIncident(id);
    if (!d) throw notFound("Incident report not found.");
    const read = await one(`SELECT 1 FROM incident_reads WHERE incident_id = $1 AND user_id = $2`, [id, req.user!.id]);
    return forPhone(d, !read);
  });

  // Opened: off this user's home screen. Repeats are harmless.
  app.post("/incidents/:id/read", sups, async (req) => {
    const id = uuidParam(req.params);
    const r = await one(
      `INSERT INTO incident_reads (incident_id, user_id) SELECT id, $2 FROM incidents WHERE id = $1
       ON CONFLICT DO NOTHING RETURNING incident_id`, [id, req.user!.id]);
    if (!r && !(await one(`SELECT 1 FROM incidents WHERE id = $1`, [id]))) throw notFound("Incident report not found.");
    return { ok: true };
  });

  // A correction or a later fact, kept with who and when. Idempotent on client_id.
  app.post("/incidents/:id/notes", sups, async (req, reply) => {
    const id = uuidParam(req.params);
    const b = obj(req.body);
    const clientId = String(b.client_id ?? "").toLowerCase();
    if (!UUID_RE.test(clientId)) throw bad("client_id must be a uuid.");
    const note = reqStr(b.note, "Note", 2000);
    const dup = await one(`SELECT id, incident_id FROM incident_notes WHERE client_id = $1`, [clientId]);
    if (dup) return { id: dup.id, duplicate: true };
    const st = await one(
      `SELECT COALESCE(s.state, 'active') AS state FROM incidents n LEFT JOIN incident_states s ON s.incident_id = n.id WHERE n.id = $1`, [id]);
    if (!st) throw notFound("Incident report not found.");
    if (st.state === "deleted") throw conflict(ALREADY.deleted);
    const r = await one(
      `INSERT INTO incident_notes (client_id, incident_id, note, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id) DO NOTHING RETURNING id`, [clientId, id, note, req.user!.id]);
    if (!r) return { id: (await one(`SELECT id FROM incident_notes WHERE client_id = $1`, [clientId]))!.id, duplicate: true };
    return reply.code(201).send({ id: r.id, duplicate: false });
  });

  app.get("/incidents/:id/file/:which", sups, async (req, reply) => {
    const which = (req.params as { which: string }).which;
    const col = { driver: "driver_signature_path", reporter: "reporter_signature_path", sketch: "sketch_path" }[which];
    if (!col) throw notFound();
    const r = await one(`SELECT ${col} AS path FROM incidents WHERE id = $1`, [uuidParam(req.params)]);
    if (!r?.path) throw notFound();
    return reply.type("image/png").header("cache-control", "private, max-age=31536000, immutable").send(files.stream(r.path));
  });

  app.get("/incidents/:id/pdf", sups, async (req, reply) => {
    const d = await loadIncident(uuidParam(req.params));
    if (!d) throw notFound("Incident report not found.");
    const pdf = await renderHtmlToPdf(await incidentPdfHtml(d));
    const name = `${d.incident.truck_code}_incident_${d.incident.incident_date}.pdf`.replace(/[^\w.-]/g, "_");
    return reply.type("application/pdf").header("content-disposition", `attachment; filename="${name}"`)
      .header("cache-control", "no-store").send(pdf);
  });

  const reasonOf = (body: unknown, required: boolean) => {
    const b = obj(body ?? {});
    return required ? reqStr(b.reason, "Reason", 500) : str(b.reason, "Reason", 500);
  };
  app.post("/incidents/:id/archive", sups, async (req) =>
    changeIncidentState(uuidParam(req.params), "archive", req.user!.id, reasonOf(req.body, false)));
  app.post("/incidents/:id/unarchive", sups, async (req) =>
    changeIncidentState(uuidParam(req.params), "unarchive", req.user!.id, null));
  app.post("/incidents/:id/delete", admins, async (req) =>
    changeIncidentState(uuidParam(req.params), "delete", req.user!.id, reasonOf(req.body, true)));
  app.post("/incidents/:id/restore", admins, async (req) =>
    changeIncidentState(uuidParam(req.params), "restore", req.user!.id, null));

  app.get("/admin/deleted-incidents", admins, async () =>
    q(`SELECT n.id, n.vehicle_id, v.truck_code, n.incident_date, n.driver_name, n.reporter_name,
              s.reason, s.changed_at AS deleted_at, u.name AS deleted_by_name
         FROM incident_states s
         JOIN incidents n ON n.id = s.incident_id
         JOIN vehicles v ON v.id = n.vehicle_id
         JOIN users u ON u.id = s.changed_by
        WHERE s.state = 'deleted'
        ORDER BY s.changed_at DESC LIMIT 500`));

  // Incident damage not yet repaired, across trucks in service (repairs board; the truck page has its own).
  app.get("/incident-repairs", { preHandler: requireRole("supervisor", "shop") }, async (req) => {
    const u = requireUser(req);
    const rows = await q(
      `SELECT dm.id, dm.diagram, dm.seq, dm.note, n.id AS incident_id, n.incident_date, n.reporter_name,
              v.id AS vehicle_id, v.truck_code, v.year, v.make, v.model,
              (current_date - n.incident_date) AS days_open,
              ARRAY(SELECT p.id FROM photos p WHERE p.damage_mark_id = dm.id ORDER BY p.created_at, p.id) AS photo_ids,
              ARRAY(SELECT td.ticket_id FROM repair_ticket_damage td JOIN repair_tickets t ON t.id = td.ticket_id
                     WHERE td.damage_mark_id = dm.id AND t.voided_at IS NULL ORDER BY td.ticket_id) AS ticket_ids
         FROM damage_marks dm
         JOIN live_incidents n ON n.id = dm.incident_id
         JOIN vehicles v ON v.id = n.vehicle_id
        WHERE v.active AND NOT EXISTS (SELECT 1 FROM damage_repairs dr WHERE dr.damage_mark_id = dm.id AND dr.active)
        ORDER BY v.truck_code, n.incident_date, n.created_at, dm.diagram DESC, dm.seq
        LIMIT 2000`,
    );
    // The shop sees the damage, not the report it came from.
    return atLeast(u, "supervisor") ? rows : rows.map((r) => ({ ...r, incident_id: null, reporter_name: null }));
  });
}
