// Yard inspections (SPEC §9): a supervisor's daily walk of a yard on its own checklist (fire safety by default).
// OK or Repair per item, a note and photos for each problem, comments and a signature. A walk is
// read-only once submitted; each failed item ("finding") stays open on the repairs board and the supervisors' home
// screen until someone resolves it with a note. Submits are idempotent on client_id, like truck inspections.
import type { FastifyInstance } from "fastify";
import { requireRole, requireUser } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import { bad, conflict, DATE_RE, HttpError, idParam, int, isValidDate, notFound, obj, reqStr, str, UUID_RE, uuidParam } from "../http.ts";
import { renderHtmlToPdf } from "../pdf.ts";
import { decodePngDataUrl, discardUnlessUsed, files, newKey } from "../storage.ts";
import { yardPdfHtml } from "../yard-pdf.ts";
import { YARD_SECTIONS } from "./checklist.ts";
import { attachFailed, UNATTACHED } from "../photo-owners.ts";
import { trashInfo } from "./trash.ts";

interface ItemIn { checklist_item_id: number; result: "ok" | "repair"; note: string | null }
interface PhotoIn { id: string; caption: string | null; checklist_item_id: number | null }

export interface YardSubmit {
  client_id: string;
  yard_id: number;
  inspection_date: string;
  inspector_name: string;
  comments: string | null;
  checklist_as_of: Date | null;
  items: ItemIn[];
  photos: PhotoIn[];
  signature: Buffer;
}

const list = (v: unknown, field: string, max: number): unknown[] => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad(`${field} must be a list.`);
  if (v.length > max) throw bad(`Too many ${field}.`);
  return v;
};

/** The server's date (TZ, set in .env for Docker), for "walked today". */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseYardSubmit(body: unknown): YardSubmit {
  const b = obj(body);
  const clientId = String(b.client_id ?? "").toLowerCase();
  if (!UUID_RE.test(clientId)) throw bad("client_id must be a uuid.");
  const date = String(b.inspection_date ?? "");
  if (!DATE_RE.test(date) || !isValidDate(date)) throw bad("Date is required.");
  const max = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  if (date > max || date < "2020-01-01") throw bad("Date looks wrong. Check the date of the walk.");
  const sig = decodePngDataUrl(b.signature);
  if (!sig) throw bad("Signature is required.");
  let asOf: Date | null = null;
  if (b.checklist_as_of != null) {
    asOf = new Date(String(b.checklist_as_of));
    if (Number.isNaN(asOf.getTime())) throw bad("checklist_as_of must be a date and time.");
  }
  const items = list(b.items, "checklist items", 200).map((x, i): ItemIn => {
    const o = obj(x, `item ${i + 1}`);
    if (o.result !== "ok" && o.result !== "repair") throw bad("Each checklist item must be OK or Repair.");
    return { checklist_item_id: int(o.checklist_item_id, "checklist_item_id", 1), result: o.result, note: str(o.note, "Repair note", 1000) };
  });
  const seen = new Set<string>();
  const photos = list(b.photos, "photos", 60).map((x): PhotoIn => {
    const o = obj(x, "photo");
    const id = String(o.id ?? "").toLowerCase();
    if (!UUID_RE.test(id) || seen.has(id)) throw bad("Each photo needs a unique id.");
    seen.add(id);
    return {
      id, caption: str(o.caption, "Photo caption", 300),
      checklist_item_id: o.checklist_item_id == null ? null : int(o.checklist_item_id, "checklist_item_id", 1),
    };
  });
  return {
    client_id: clientId, yard_id: int(b.yard_id, "yard_id", 1), inspection_date: date,
    inspector_name: reqStr(b.inspector_name, "Inspector name", 100), comments: str(b.comments, "Comments", 5000),
    checklist_as_of: asOf, items, photos, signature: sig,
  };
}

const byClientId = (clientId: string) =>
  one<{ id: string }>(`SELECT id FROM yard_inspections WHERE client_id = $1`, [clientId]);

class DuplicateSubmit extends Error {}

export async function submitYardInspection(input: YardSubmit, userId: number) {
  const dup = await byClientId(input.client_id);
  if (dup) return { id: dup.id, duplicate: true };
  if (!(await one(`SELECT 1 FROM yards WHERE id = $1 AND active`, [input.yard_id]))) throw bad("That yard isn't in use.");

  // Same rules as the truck checklist (011): answers to any item on the list (retired ones too), each once; every item
  // in use is required except ones added after the phone loaded the form (checklist_as_of, counted back 90 days at most).
  const checklist = await q<{ id: number; section: string; label: string; required: boolean }>(
    `SELECT id, section, label,
            active AND created_at <= GREATEST(LEAST(COALESCE($1::timestamptz, now()), now()), now() - interval '90 days') AS required
       FROM yard_checklist_items ORDER BY array_position($2::text[], section), sort_order, id`,
    [input.checklist_as_of, YARD_SECTIONS.map((s) => s.key)],
  );
  const known = new Set(checklist.map((c) => c.id));
  const answered = new Map<number, ItemIn>();
  for (const it of input.items) {
    if (!known.has(it.checklist_item_id)) {
      throw new HttpError(422, "The yard checklist changed since this form was opened. Reload the form and check the items again.", { code: "checklist_changed" });
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
    if (p.checklist_item_id != null && !answered.has(p.checklist_item_id)) throw bad("Photo points at a checklist item that isn't in this walk.");
  }
  if (input.photos.length) {
    const ids = input.photos.map((p) => p.id);
    const found = await q(
      `SELECT id FROM photos WHERE id = ANY($1::uuid[]) AND ${UNATTACHED}`,
      [ids],
    );
    const ok = new Set(found.map((f) => f.id));
    const notReady = ids.filter((id) => !ok.has(id));
    if (notReady.length) throw new HttpError(422, "Some photos haven't finished uploading yet.", { code: "photos_missing", photos: notReady });
  }

  const sigKey = newKey("png");
  await files.put(sigKey, input.signature);
  try {
    return await tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO yard_inspections (client_id, yard_id, inspection_date, inspector_user_id, inspector_name, comments, signature_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (client_id) DO NOTHING RETURNING id`,
        [input.client_id, input.yard_id, input.inspection_date, userId, input.inspector_name, input.comments, sigKey],
      );
      if (!ins.rows[0]) throw new DuplicateSubmit();
      const id: string = ins.rows[0].id;
      const itemIds = new Map<number, number>();
      for (const ci of checklist) {
        const a = answered.get(ci.id);
        if (!a) continue;
        const r = await c.query(
          `INSERT INTO yard_inspection_items (yard_inspection_id, checklist_item_id, section, label_snapshot, result, note)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [id, ci.id, ci.section, ci.label, a.result, a.result === "repair" ? a.note : null],
        );
        itemIds.set(ci.id, r.rows[0].id);
      }
      for (const p of input.photos) {
        const r = await c.query(
          `UPDATE photos SET yard_inspection_id = $2, yard_inspection_item_id = $3, caption = $4
            WHERE id = $1 AND ${UNATTACHED}`,
          [p.id, id, p.checklist_item_id ? itemIds.get(p.checklist_item_id) ?? null : null, p.caption],
        );
        if (r.rowCount !== 1) throw await attachFailed(c, p.id, "A photo was attached to something else. Remove it and try again.");
      }
      return { id, failed: input.items.filter((i) => i.result === "repair").length, duplicate: false };
    });
  } catch (e) {
    await discardUnlessUsed(sigKey, async () => !!(await one(`SELECT 1 FROM yard_inspections WHERE signature_path = $1`, [sigKey])));
    if (e instanceof DuplicateSubmit) {
      const d = await byClientId(input.client_id);
      if (d) return { id: d.id, duplicate: true };
    }
    throw e;
  }
}

/** One walk with its yard, items (each finding with whether and how it was resolved) and photos. */
export async function loadYardInspection(id: string) {
  const w = await one(
    `SELECT w.id, w.yard_id, y.code AS yard_code, y.name AS yard_name, w.inspection_date, w.inspector_name, w.comments,
            w.signature_path, w.created_at
       FROM yard_inspections w JOIN yards y ON y.id = w.yard_id WHERE w.id = $1`,
    [id],
  );
  if (!w) return null;
  const items = await q(
    `SELECT yi.id, yi.section, yi.label_snapshot AS label, yi.result, yi.note, yi.resolved_at, yi.resolution_note,
            ru.name AS resolved_by_name
       FROM yard_inspection_items yi LEFT JOIN users ru ON ru.id = yi.resolved_by
      WHERE yi.yard_inspection_id = $1
      ORDER BY array_position($2::text[], yi.section), yi.id`,
    [id, YARD_SECTIONS.map((s) => s.key)],
  );
  const photos = await q(
    `SELECT id, caption, yard_inspection_item_id AS item_id, file_path FROM photos
      WHERE yard_inspection_id = $1 ORDER BY created_at, id`,
    [id],
  );
  return { walk: w, items, photos };
}
export type YardWalk = NonNullable<Awaited<ReturnType<typeof loadYardInspection>>>;

export default async function yardRoutes(app: FastifyInstance) {
  const walkers = { preHandler: requireRole("supervisor") };
  const readers = { preHandler: requireRole("supervisor", "shop") };

  // Yards with today's status: walked today?, the last walk, and open findings.
  app.get("/yards", readers, async () =>
    q(
      `SELECT y.id, y.code, y.name,
              (SELECT max(inspection_date) FROM live_yard_inspections w WHERE w.yard_id = y.id) AS last_date,
              EXISTS (SELECT 1 FROM live_yard_inspections w WHERE w.yard_id = y.id AND w.inspection_date = $1::date) AS walked_today,
              (SELECT count(*) FROM yard_inspection_items yi JOIN live_yard_inspections w ON w.id = yi.yard_inspection_id
                WHERE w.yard_id = y.id AND yi.result = 'repair' AND yi.resolved_at IS NULL)::int AS open_findings
         FROM yards y WHERE y.active ORDER BY y.code`,
      [today()],
    ));

  // What the walk form needs. as_of goes back with the walk, so items added after this aren't demanded of it.
  app.get("/yard-config", walkers, async () => ({
    sections: YARD_SECTIONS,
    checklist: await q(
      `SELECT id, section, label, sort_order FROM yard_checklist_items WHERE active
        ORDER BY array_position($1::text[], section), sort_order, id`,
      [YARD_SECTIONS.map((s) => s.key)],
    ),
    as_of: new Date().toISOString(),
  }));

  app.post("/yard-inspections", { ...walkers, bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    const out = await submitYardInspection(parseYardSubmit(req.body), req.user!.id);
    return reply.code(out.duplicate ? 200 : 201).send(out);
  });

  // A yard's walks, newest first.
  app.get("/yards/:id/inspections", readers, async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string } | undefined)?.limit) || 60, 400);
    return q(
      `SELECT w.id, w.inspection_date, w.inspector_name, w.created_at,
              count(yi.*)::int AS items,
              count(yi.*) FILTER (WHERE yi.result = 'repair')::int AS failed,
              count(yi.*) FILTER (WHERE yi.result = 'repair' AND yi.resolved_at IS NULL)::int AS open
         FROM live_yard_inspections w LEFT JOIN yard_inspection_items yi ON yi.yard_inspection_id = w.id
        WHERE w.yard_id = $1
        GROUP BY w.id, w.inspection_date, w.inspector_name, w.created_at
        ORDER BY w.inspection_date DESC, w.created_at DESC LIMIT $2`,
      [idParam(req.params), limit],
    );
  });

  app.get("/yard-inspections/:id", readers, async (req) => {
    const d = await loadYardInspection(uuidParam(req.params));
    if (!d) throw notFound("Yard walk not found.");
    const { signature_path: _s, ...walk } = d.walk;
    return { walk, items: d.items, photos: d.photos.map(({ file_path: _f, ...p }) => p), trash: await trashInfo("yard_walk", walk.id) };
  });

  app.get("/yard-inspections/:id/signature", async (req, reply) => {
    requireUser(req);
    const r = await one(`SELECT signature_path AS path FROM yard_inspections WHERE id = $1`, [uuidParam(req.params)]);
    if (!r?.path) throw notFound();
    return reply.type("image/png").header("cache-control", "private, max-age=31536000, immutable").send(files.stream(r.path));
  });

  app.get("/yard-inspections/:id/pdf", walkers, async (req, reply) => {
    const d = await loadYardInspection(uuidParam(req.params));
    if (!d) throw notFound("Yard walk not found.");
    const pdf = await renderHtmlToPdf(await yardPdfHtml(d));
    const name = `${d.walk.yard_code}_yard_walk_${d.walk.inspection_date}.pdf`.replace(/[^\w.-]/g, "_");
    return reply.type("application/pdf").header("content-disposition", `attachment; filename="${name}"`)
      .header("cache-control", "no-store").send(pdf);
  });

  // Open findings across the yards in use, oldest first (repairs board, supervisors' home screen).
  app.get("/yard-findings", readers, async () =>
    q(
      `SELECT yi.id, yi.section, yi.label_snapshot AS label, yi.note, w.id AS yard_inspection_id, w.inspection_date,
              w.inspector_name, y.id AS yard_id, y.code AS yard_code, y.name AS yard_name,
              (current_date - w.inspection_date) AS days_open,
              ARRAY(SELECT p.id FROM photos p WHERE p.yard_inspection_item_id = yi.id ORDER BY p.created_at, p.id) AS photo_ids
         FROM yard_inspection_items yi
         JOIN live_yard_inspections w ON w.id = yi.yard_inspection_id
         JOIN yards y ON y.id = w.yard_id
        WHERE yi.result = 'repair' AND yi.resolved_at IS NULL AND y.active
        ORDER BY y.code, w.inspection_date, w.created_at, yi.id
        LIMIT 1000`,
    ));

  app.post("/yard-findings/:id/resolve", walkers, async (req) => {
    const note = reqStr(obj(req.body ?? {}).note, "Resolution note", 1000);
    const r = await one(
      `UPDATE yard_inspection_items SET resolved_at = now(), resolved_by = $2, resolution_note = $3
        WHERE id = $1 AND result = 'repair' AND resolved_at IS NULL
          AND yard_inspection_id IN (SELECT id FROM live_yard_inspections) RETURNING id`,
      [idParam(req.params), req.user!.id, note],
    );
    if (!r) throw conflict("That finding is already resolved, isn't a finding, or its walk is in the trash.");
    return { ok: true };
  });
}
