// Checklist editor (admin): add, rename, reorder, retire and restore inspection checklist items. Changes apply to new
// inspections; submitted ones keep the items and wording they had. Items are never deleted, and every change is kept.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { requireRole } from "../auth.ts";
import { q, tx } from "../db.ts";
import { bad, conflict, idParam, notFound, obj, reqStr } from "../http.ts";

export const SECTIONS = [
  { key: "exterior", title: "Exterior" },
  { key: "interior", title: "Interior" },
  { key: "trailer", title: "Trailer & crew" },
] as const;
const SECTION_KEYS: string[] = SECTIONS.map((s) => s.key);

type ItemRow = { id: number; section: string; label: string; sort_order: number; active: boolean };

function label(v: unknown): string {
  const s = reqStr(v, "Item", 100).replace(/\s+/g, " ").trim();
  if (!s) throw bad("Type the checklist item.");
  return s;
}

/** One change at a time (only admins edit, rarely), so the order and the no-duplicates check stay simple. */
async function lockChecklist(c: PoolClient) {
  await c.query(`LOCK TABLE checklist_items IN SHARE ROW EXCLUSIVE MODE`);
}

async function lockItem(c: PoolClient, id: number): Promise<ItemRow> {
  await lockChecklist(c);
  const r = (await c.query(`SELECT id, section, label, sort_order, active FROM checklist_items WHERE id = $1`, [id])).rows[0];
  if (!r) throw notFound("Checklist item not found.");
  return r;
}

/** The items in use in a section, in form order. */
async function activeIds(c: PoolClient, section: string): Promise<number[]> {
  return (await c.query(
    `SELECT id FROM checklist_items WHERE active AND section = $1::checklist_section ORDER BY sort_order, id`, [section],
  )).rows.map((r) => r.id as number);
}

/**
 * Number a section 1, 2, 3…: the items in use in the given order, then the retired ones in their old order. The
 * unique (section, sort_order) check is deferred to commit (migration 011), so the in-between states are fine.
 */
async function renumber(c: PoolClient, section: string, active: number[]) {
  const retired = (await c.query(
    `SELECT id FROM checklist_items WHERE NOT active AND section = $1::checklist_section ORDER BY sort_order, id`, [section],
  )).rows.map((r) => r.id as number);
  for (const [n, id] of [...active, ...retired].entries()) {
    await c.query(`UPDATE checklist_items SET sort_order = $2 WHERE id = $1 AND sort_order <> $2`, [id, n + 1]);
  }
}

/** No two items in use in one section may read the same (ignoring case and spacing). */
async function assertUnique(c: PoolClient, section: string, text: string, exceptId: number | null) {
  const clash = (await c.query(
    `SELECT id FROM checklist_items WHERE active AND section = $1::checklist_section AND lower(label) = lower($2) AND id <> $3`,
    [section, text, exceptId ?? 0],
  )).rows[0];
  if (clash) throw conflict(`"${text}" is already on the list in that section.`);
}

async function log(c: PoolClient, item: { id: number; section: string }, action: string, userId: number,
  oldLabel: string | null, newLabel: string | null) {
  await c.query(
    `INSERT INTO checklist_changes (item_id, section, action, old_label, new_label, changed_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [item.id, item.section, action, oldLabel, newLabel, userId],
  );
}

export default async function checklistRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireRole("admin") };

  // Everything the editor shows: the sections, every item (retired ones too, with how often each was answered), and
  // the latest changes.
  app.get("/admin/checklist", admin, async () => {
    const items = await q(
      `SELECT ci.id, ci.section, ci.label, ci.sort_order, ci.active, ci.created_at,
              (SELECT count(*) FROM inspection_items ii WHERE ii.checklist_item_id = ci.id)::int AS answered
         FROM checklist_items ci ORDER BY ci.section, ci.sort_order, ci.id`,
    );
    const changes = await q(
      `SELECT ch.id, ch.item_id, ch.section, ch.action, ch.old_label, ch.new_label, ch.changed_at, u.name AS changed_by_name
         FROM checklist_changes ch JOIN users u ON u.id = ch.changed_by
        ORDER BY ch.changed_at DESC, ch.id DESC LIMIT 50`,
    );
    return { sections: SECTIONS, items, changes };
  });

  // Add an item at the end of a section.
  app.post("/admin/checklist", admin, async (req, reply) => {
    const b = obj(req.body);
    const section = String(b.section ?? "");
    if (!SECTION_KEYS.includes(section)) throw bad("Pick the section for the new item.");
    const text = label(b.label);
    const item = await tx(async (c) => {
      await lockChecklist(c);
      await assertUnique(c, section, text, null);
      const before = await activeIds(c, section);
      const r = (await c.query(
        `INSERT INTO checklist_items (section, label, sort_order)
         VALUES ($1::checklist_section, $2, (SELECT COALESCE(max(sort_order), 0) + 1 FROM checklist_items WHERE section = $1::checklist_section))
         RETURNING id, section, label, active`,
        [section, text],
      )).rows[0];
      await renumber(c, section, [...before, r.id]);
      await log(c, r, "added", req.user!.id, null, text);
      return r;
    });
    return reply.code(201).send(item);
  });

  // Reword an item. Submitted inspections keep the words they had.
  app.patch("/admin/checklist/:id", admin, async (req) => {
    const id = idParam(req.params);
    const text = label(obj(req.body).label);
    return tx(async (c) => {
      const it = await lockItem(c, id);
      if (it.label === text) return it;
      if (it.active) await assertUnique(c, it.section, text, it.id);
      await c.query(`UPDATE checklist_items SET label = $2 WHERE id = $1`, [id, text]);
      await log(c, it, "renamed", req.user!.id, it.label, text);
      return { ...it, label: text };
    });
  });

  // Move an item one place up or down among the items in use in its section.
  app.post("/admin/checklist/:id/move", admin, async (req) => {
    const id = idParam(req.params);
    const dir = obj(req.body).direction;
    if (dir !== "up" && dir !== "down") throw bad('direction must be "up" or "down".');
    return tx(async (c) => {
      const it = await lockItem(c, id);
      if (!it.active) throw bad("Restore the item before moving it.");
      const list = await activeIds(c, it.section);
      const at = list.indexOf(id);
      const to = dir === "up" ? at - 1 : at + 1;
      if (to < 0 || to >= list.length) return { ok: true, moved: false };
      [list[at], list[to]] = [list[to], list[at]];
      await renumber(c, it.section, list);
      await log(c, it, "moved", req.user!.id, it.label, it.label);
      return { ok: true, moved: true };
    });
  });

  // Take an item off the form for new inspections. It stays on every inspection that already has it.
  app.post("/admin/checklist/:id/retire", admin, async (req) => {
    const id = idParam(req.params);
    return tx(async (c) => {
      const it = await lockItem(c, id);
      if (!it.active) throw conflict("That item is already retired.");
      await c.query(`UPDATE checklist_items SET active = false WHERE id = $1`, [id]);
      await renumber(c, it.section, await activeIds(c, it.section));
      await log(c, it, "retired", req.user!.id, it.label, null);
      return { ok: true };
    });
  });

  // Put a retired item back, at the end of its section.
  app.post("/admin/checklist/:id/restore", admin, async (req) => {
    const id = idParam(req.params);
    return tx(async (c) => {
      const it = await lockItem(c, id);
      if (it.active) throw conflict("That item is already on the form.");
      await assertUnique(c, it.section, it.label, it.id);
      const before = await activeIds(c, it.section);
      await c.query(`UPDATE checklist_items SET active = true WHERE id = $1`, [id]);
      await renumber(c, it.section, [...before, id]);
      await log(c, it, "restored", req.user!.id, null, it.label);
      return { ok: true };
    });
  });
}
