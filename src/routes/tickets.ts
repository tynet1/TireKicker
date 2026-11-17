// Repair tickets (SPEC §9): pick one or more open repairs on a truck and make a numbered ticket for the shop or an
// outside vendor, as a PDF to print, share or email. Tickets are kept for good; a mistaken one is voided with a reason.
// Fixing the repairs still goes through a maintenance entry (or a supervisor's Resolve), and the ticket shows it.
import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import { bad, conflict, HttpError, idParam, int, notFound, obj, reqStr, str, UUID_RE } from "../http.ts";
import { renderHtmlToPdf } from "../pdf.ts";
import { ticketPdfHtml } from "../ticket-pdf.ts";

export const ticketNumber = (id: number) => `RT-${String(id).padStart(4, "0")}`;
const MAX_ITEMS = 50;

export type TicketItem = {
  id: number;
  position: number;
  section: string;
  label: string;
  note: string | null;
  inspection_id: string;
  inspection_date: string;
  inspector_name: string;
  resolved_at: Date | null;
  resolved_by_name: string | null;
  resolution_note: string | null;
  service_log_id: number | null;
  photos: { id: string; file_path: string; caption: string | null }[];
};

type TicketRow = {
  id: number;
  vehicle_id: number;
  sent_to: string | null;
  note: string | null;
  created_at: Date;
  created_by_name: string;
  voided_at: Date | null;
  voided_by_name: string | null;
  void_reason: string | null;
  truck_code: string;
  unit: string | null;
  vin: string | null;
  plate: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  last_mileage: number | null;
};

/** One ticket with its truck and repairs (each with whether and how it has been fixed since). */
export async function loadTicket(id: number) {
  const t = await one<TicketRow>(
    `SELECT t.id, t.vehicle_id, t.sent_to, t.note, t.created_at, cu.name AS created_by_name,
            t.voided_at, vu.name AS voided_by_name, t.void_reason,
            v.truck_code, v.unit, v.vin, v.plate, v.year, v.make, v.model,
            GREATEST(
              (SELECT max(mileage) FROM live_inspections WHERE vehicle_id = v.id),
              (SELECT max(mileage) FROM service_logs WHERE vehicle_id = v.id AND voided_at IS NULL)) AS last_mileage
       FROM repair_tickets t
       JOIN vehicles v ON v.id = t.vehicle_id
       JOIN users cu ON cu.id = t.created_by
       LEFT JOIN users vu ON vu.id = t.voided_by
      WHERE t.id = $1`,
    [id],
  );
  if (!t) return null;
  const items = await q<TicketItem>(
    `SELECT ii.id, ti.position, ii.section, ii.label_snapshot AS label, ii.note,
            i.id AS inspection_id, i.inspection_date, i.inspector_name,
            ii.resolved_at, ru.name AS resolved_by_name, ii.resolution_note,
            (SELECT min(slr.service_log_id) FROM service_log_repairs slr JOIN service_logs sl ON sl.id = slr.service_log_id
              WHERE slr.inspection_item_id = ii.id AND slr.active AND slr.resolved_here AND sl.voided_at IS NULL) AS service_log_id,
            COALESCE((SELECT json_agg(json_build_object('id', p.id, 'file_path', p.file_path, 'caption', p.caption)
                                      ORDER BY p.created_at, p.id)
                        FROM photos p WHERE p.inspection_item_id = ii.id), '[]') AS photos
       FROM repair_ticket_items ti
       JOIN inspection_items ii ON ii.id = ti.inspection_item_id
       JOIN inspections i ON i.id = ii.inspection_id
       LEFT JOIN users ru ON ru.id = ii.resolved_by
      WHERE ti.ticket_id = $1
      ORDER BY ti.position`,
    [id],
  );
  return { ...t, number: ticketNumber(t.id), voided: !!t.voided_at, items };
}
export type Ticket = NonNullable<Awaited<ReturnType<typeof loadTicket>>>;

/** For the phone: the ticket without file paths. */
const forClient = (t: Ticket) => ({
  ...t,
  items: t.items.map(({ photos, ...it }) => ({ ...it, photo_ids: photos.map((p) => p.id) })),
});

export default async function ticketRoutes(app: FastifyInstance) {
  const allowed = { preHandler: requireRole("supervisor", "shop") };

  app.post("/repair-tickets", allowed, async (req, reply) => {
    const b = obj(req.body);
    const clientId = typeof b.client_id === "string" ? b.client_id.toLowerCase() : "";
    if (!UUID_RE.test(clientId)) throw bad("client_id must be a uuid.");
    const vehicleId = int(b.vehicle_id, "vehicle_id", 1);
    if (!Array.isArray(b.item_ids) || !b.item_ids.length) throw bad("Pick at least one repair for the ticket.");
    if (b.item_ids.length > MAX_ITEMS) throw bad(`A ticket can hold up to ${MAX_ITEMS} repairs.`);
    const itemIds = [...new Set(b.item_ids.map((v) => int(v, "item_ids", 1)))];
    const sentTo = str(b.sent_to, "Sent to", 120);
    const note = str(b.note, "Note", 1000);

    const dup = await one(`SELECT id FROM repair_tickets WHERE client_id = $1`, [clientId]);
    if (dup) return reply.code(200).send({ id: dup.id, number: ticketNumber(dup.id), duplicate: true });

    const made = await tx(async (c) => {
      if (!(await c.query(`SELECT 1 FROM vehicles WHERE id = $1`, [vehicleId])).rowCount) throw notFound("Truck not found.");
      // Only repairs still open on this truck's live inspections can go on a ticket.
      const ok = new Set((await c.query(
        `SELECT ii.id FROM inspection_items ii JOIN live_inspections i ON i.id = ii.inspection_id
          WHERE ii.id = ANY($1::int[]) AND i.vehicle_id = $2 AND ii.result = 'repair' AND ii.resolved_at IS NULL`,
        [itemIds, vehicleId],
      )).rows.map((r) => r.id as number));
      const wrong = itemIds.filter((id) => !ok.has(id));
      if (wrong.length) {
        throw new HttpError(422, "Some of these repairs were fixed meanwhile or aren't open on this truck. Reload and pick again.",
          { code: "bad_repairs", items: wrong });
      }
      const ins = await c.query(
        `INSERT INTO repair_tickets (client_id, vehicle_id, sent_to, note, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (client_id) DO NOTHING RETURNING id`,
        [clientId, vehicleId, sentTo, note, req.user!.id],
      );
      if (!ins.rowCount) {
        // The same ticket arrived twice at once; the other request made it.
        const other = (await c.query(`SELECT id FROM repair_tickets WHERE client_id = $1`, [clientId])).rows[0];
        return { id: other.id as number, duplicate: true };
      }
      const id = ins.rows[0].id as number;
      for (const [n, itemId] of itemIds.entries()) {
        await c.query(`INSERT INTO repair_ticket_items (ticket_id, inspection_item_id, position) VALUES ($1, $2, $3)`,
          [id, itemId, n + 1]);
      }
      return { id, duplicate: false };
    });
    // Answer only once the transaction has committed, so "made" always means saved.
    return reply.code(made.duplicate ? 200 : 201)
      .send({ id: made.id, number: ticketNumber(made.id), ...(made.duplicate ? { duplicate: true } : {}) });
  });

  app.get("/repair-tickets/:id", allowed, async (req) => {
    const t = await loadTicket(idParam(req.params));
    if (!t) throw notFound("Ticket not found.");
    return forClient(t);
  });

  // A truck's tickets, newest first, with how many of their repairs are fixed.
  app.get("/vehicles/:id/repair-tickets", allowed, async (req) =>
    (await q(
      `SELECT t.id, t.sent_to, t.created_at, u.name AS created_by_name, (t.voided_at IS NOT NULL) AS voided,
              count(ti.*)::int AS items, count(ti.*) FILTER (WHERE ii.resolved_at IS NOT NULL)::int AS fixed
         FROM repair_tickets t
         JOIN users u ON u.id = t.created_by
         JOIN repair_ticket_items ti ON ti.ticket_id = t.id
         JOIN inspection_items ii ON ii.id = ti.inspection_item_id
        WHERE t.vehicle_id = $1
        GROUP BY t.id, u.name
        ORDER BY t.created_at DESC, t.id DESC LIMIT 200`,
      [idParam(req.params)],
    )).map((t) => ({ ...t, number: ticketNumber(t.id) })));

  // Names used before, for the "Sent to" suggestions.
  app.get("/repair-tickets/sent-to", allowed, async () =>
    (await q(
      `SELECT sent_to FROM repair_tickets WHERE sent_to IS NOT NULL
        GROUP BY sent_to ORDER BY max(created_at) DESC LIMIT 30`,
    )).map((r) => r.sent_to as string));

  app.post("/repair-tickets/:id/void", allowed, async (req) => {
    const id = idParam(req.params);
    const reason = reqStr(obj(req.body ?? {}).reason, "Reason", 600);
    const r = await one(
      `UPDATE repair_tickets SET voided_at = now(), voided_by = $2, void_reason = $3
        WHERE id = $1 AND voided_at IS NULL RETURNING id`,
      [id, req.user!.id, reason],
    );
    if (!r) {
      if (!(await one(`SELECT 1 FROM repair_tickets WHERE id = $1`, [id]))) throw notFound("Ticket not found.");
      throw conflict("That ticket is already voided.");
    }
    return { ok: true };
  });

  app.get("/repair-tickets/:id/pdf", allowed, async (req, reply) => {
    const t = await loadTicket(idParam(req.params));
    if (!t) throw notFound("Ticket not found.");
    const pdf = await renderHtmlToPdf(await ticketPdfHtml(t));
    const name = `${t.truck_code}_repair_ticket_${t.number}.pdf`.replace(/[^\w.-]/g, "_");
    const inline = (req.query as { inline?: string } | undefined)?.inline === "1";
    return reply
      .type("application/pdf")
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${name}"`)
      .header("cache-control", "no-store")
      .send(pdf);
  });
}
