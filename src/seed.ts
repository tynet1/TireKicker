import { readFile } from "node:fs/promises";
import { hashSecret } from "./auth.ts";
import { config } from "./config.ts";
import { one, q } from "./db.ts";

/** Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD if there is no active admin yet. */
export async function ensureAdmin(log: (m: string) => void): Promise<void> {
  const existing = await one(`SELECT id FROM users WHERE role = 'admin' AND active LIMIT 1`);
  if (existing) return;
  const { name, email, password } = config.admin;
  if (!email || !password) {
    log("WARNING: no admin account exists. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env and restart.");
    return;
  }
  if (password.length < 10) {
    log("WARNING: ADMIN_PASSWORD must be at least 10 characters; admin not created.");
    return;
  }
  await q(
    `INSERT INTO users (name, email, role, password_hash) VALUES ($1, lower($2), 'admin', $3)
     ON CONFLICT (email) DO UPDATE SET role = 'admin', active = true, password_hash = EXCLUDED.password_hash`,
    [name, email, await hashSecret(password)],
  );
  log(`created admin account for ${email}`);
}

/** Minimal CSV parser: commas, double-quoted fields, "" escapes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/**
 * Add trucks from seed/vehicles.csv that aren't in the database yet (matched by truck_code).
 * Never changes trucks that already exist, so admin edits are safe across restarts.
 */
export async function seedVehicles(log: (m: string) => void): Promise<void> {
  let text: string;
  try {
    text = await readFile(config.vehiclesCsv, "utf8");
  } catch {
    return;
  }
  const rows = parseCsv(text).filter((r) => r.truck_code && !r.truck_code.startsWith("#"));
  let added = 0;
  for (const r of rows) {
    // Trucks that pull a trailer get the trailer type named in the optional "trailer" column, else the default one.
    const res = await q(
      `INSERT INTO vehicles (truck_code, unit, vin, plate, year, make, model, registration_expires,
                             pulls_trailer, diagram_id, trailer_diagram_id)
       SELECT upper($1), NULLIF($2,''), NULLIF(upper($3),''), NULLIF(upper($4),''), NULLIF($5,'')::smallint,
              NULLIF($6,''), NULLIF($7,''), NULLIF($8,'')::date, p.pulls,
              (SELECT id FROM diagrams WHERE kind = 'truck' AND name = NULLIF($10,'') LIMIT 1),
              CASE WHEN p.pulls THEN COALESCE(
                (SELECT id FROM diagrams WHERE kind = 'trailer' AND name = NULLIF($11,'') LIMIT 1),
                (SELECT id FROM diagrams WHERE kind = 'trailer' ORDER BY id LIMIT 1)) END
         FROM (SELECT coalesce(NULLIF(lower($9),'') IN ('true','yes','1','y'), false) AS pulls) p
       ON CONFLICT DO NOTHING RETURNING id`,
      [r.truck_code, r.unit, r.vin, r.plate, r.year, r.make, r.model, r.registration_expires, r.pulls_trailer,
        r.diagram ?? "", r.trailer ?? ""],
    );
    added += res.length;
  }
  if (added) log(`added ${added} truck(s) from ${config.vehiclesCsv}`);
}
