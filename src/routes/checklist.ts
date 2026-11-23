// Checklist editor (admin): add, rename, reorder, retire and restore checklist items, for the truck inspection checklist
// (/admin/checklist), the yard walk checklist (/admin/yard-checklist) and the equipment checklist (/admin/equipment-checklist). Changes apply to new inspections; submitted
// ones keep the items and wording they had. Items are never deleted, and every change is kept.
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

export const YARD_SECTIONS = [
  { key: "fire", title: "Fire safety" },
  { key: "fuel", title: "Fuel, oil & chemicals" },
  { key: "equipment", title: "Equipment & charging" },
  { key: "access", title: "Access & security" },
] as const;

/** Kinds of equipment (migration 013). Each has its own part of the equipment checklist, after the "All equipment" part. */
export const EQUIPMENT_TYPES = [
  { key: "string_trimmer", title: "String trimmer" },
  { key: "blower", title: "Blower" },
  { key: "hedge_trimmer", title: "Hedge trimmer" },
  { key: "edger", title: "Edger" },
  { key: "chainsaw", title: "Chainsaw" },
  { key: "pole_saw", title: "Pole saw" },
  { key: "mower", title: "Mower" },
  { key: "sprayer", title: "Sprayer" },
  { key: "other", title: "Other" },
] as const;
export const EQUIPMENT_SECTIONS = [{ key: "all", title: "All equipment" }, ...EQUIPMENT_TYPES] as const;

/** Where one checklist lives. Table names are fixed strings here, never from a request. */
interface Checklist {
  path: string;                                  // URL prefix under /api
  items: string;                                 // its items table
  changes: string;                               // its change-history table
  answers: string;                               // where submitted answers point at its items (checklist_item_id)
  cast: string;                                  // how a section parameter is typed in SQL
  sections: readonly { key: string; title: string }[];
}

const CHECKLISTS: Checklist[] = [
  { path: "/admin/checklist", items: "checklist_items", changes: "checklist_changes", answers: "inspection_items",
    cast: "::checklist_section", sections: SECTIONS },
  { path: "/admin/yard-checklist", items: "yard_checklist_items", changes: "yard_checklist_changes",
    answers: "yard_inspection_items", cast: "::text", sections: YARD_SECTIONS },
  { path: "/admin/equipment-checklist", items: "equipment_checklist_items", changes: "equipment_checklist_changes",
    answers: "equipment_check_items", cast: "::text", sections: EQUIPMENT_SECTIONS },
];

type ItemRow = { id: number; section: string; label: string; sort_order: number; active: boolean };

function label(v: unknown): string {
  const s = reqStr(v, "Item", 100).replace(/\s+/g, " ").trim();
  if (!s) throw bad("Type the checklist item.");
  return s;
}

function editor(cl: Checklist) {
  const { items: T, cast } = cl;

  /** One change at a time (only admins edit, rarely), so the order and the no-duplicates check stay simple. */
  const lock = (c: PoolClient) => c.query(`LOCK TABLE ${T} IN SHARE ROW EXCLUSIVE MODE`);

  async function lockItem(c: PoolClient, id: number): Promise<ItemRow> {
    await lock(c);
    const r = (await c.query(`SELECT id, section, label, sort_order, active FROM ${T} WHERE id = $1`, [id])).rows[0];
    if (!r) throw notFound("Checklist item not found.");
    return r;
  }

  /** The items in use in a section, in form order. */
  async function activeIds(c: PoolClient, section: string): Promise<number[]> {
    return (await c.query(`SELECT id FROM ${T} WHERE active AND section = $1${cast} ORDER BY sort_order, id`, [section]))
      .rows.map((r) => r.id as number);
  }

  /**
   * Number a section 1, 2, 3…: the items in use in the given order, then the retired ones in their old order. The
   * unique (section, sort_order) check is deferred to commit (migrations 011 and 012), so in-between states are fine.
   */
  async function renumber(c: PoolClient, section: string, active: number[]) {
    const retired = (await c.query(`SELECT id FROM ${T} WHERE NOT active AND section = $1${cast} ORDER BY sort_order, id`, [section]))
      .rows.map((r) => r.id as number);
    for (const [n, id] of [...active, ...retired].entries()) {
      await c.query(`UPDATE ${T} SET sort_order = $2 WHERE id = $1 AND sort_order <> $2`, [id, n + 1]);
    }
  }

  /** No two items in use in one section may read the same (ignoring case and spacing). */
  async function assertUnique(c: PoolClient, section: string, text: string, exceptId: number | null) {
    const clash = (await c.query(
      `SELECT id FROM ${T} WHERE active AND section = $1${cast} AND lower(label) = lower($2) AND id <> $3`,
      [section, text, exceptId ?? 0],
    )).rows[0];
    if (clash) throw conflict(`"${text}" is already on the list in that section.`);
  }

  async function log(c: PoolClient, item: { id: number; section: string }, action: string, userId: number,
    oldLabel: string | null, newLabel: string | null) {
    await c.query(
      `INSERT INTO ${cl.changes} (item_id, section, action, old_label, new_label, changed_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [item.id, item.section, action, oldLabel, newLabel, userId],
    );
  }

  return { lock, lockItem, activeIds, renumber, assertUnique, log };
}

export default async function checklistRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireRole("admin") };

  for (const cl of CHECKLISTS) {
    const { items: T, cast, path } = cl;
    const e = editor(cl);
    const keys: string[] = cl.sections.map((s) => s.key);

    // Everything the editor shows: the sections, every item (retired ones too, with how often each was answered),
    // and the latest changes.
    app.get(path, admin, async () => {
      const items = await q(
        `SELECT ci.id, ci.section, ci.label, ci.sort_order, ci.active, ci.created_at,
                (SELECT count(*) FROM ${cl.answers} a WHERE a.checklist_item_id = ci.id)::int AS answered
           FROM ${T} ci ORDER BY ci.section, ci.sort_order, ci.id`,
      );
      const changes = await q(
        `SELECT ch.id, ch.item_id, ch.section, ch.action, ch.old_label, ch.new_label, ch.changed_at, u.name AS changed_by_name
           FROM ${cl.changes} ch JOIN users u ON u.id = ch.changed_by
          ORDER BY ch.changed_at DESC, ch.id DESC LIMIT 50`,
      );
      return { sections: cl.sections, items, changes };
    });

    // Add an item at the end of a section.
    app.post(path, admin, async (req, reply) => {
      const b = obj(req.body);
      const section = String(b.section ?? "");
      if (!keys.includes(section)) throw bad("Pick the section for the new item.");
      const text = label(b.label);
      const item = await tx(async (c) => {
        await e.lock(c);
        await e.assertUnique(c, section, text, null);
        const before = await e.activeIds(c, section);
        const r = (await c.query(
          `INSERT INTO ${T} (section, label, sort_order)
           VALUES ($1${cast}, $2, (SELECT COALESCE(max(sort_order), 0) + 1 FROM ${T} WHERE section = $1${cast}))
           RETURNING id, section, label, active`,
          [section, text],
        )).rows[0];
        await e.renumber(c, section, [...before, r.id]);
        await e.log(c, r, "added", req.user!.id, null, text);
        return r;
      });
      return reply.code(201).send(item);
    });

    // Reword an item. Submitted inspections keep the words they had.
    app.patch(`${path}/:id`, admin, async (req) => {
      const id = idParam(req.params);
      const text = label(obj(req.body).label);
      return tx(async (c) => {
        const it = await e.lockItem(c, id);
        if (it.label === text) return it;
        if (it.active) await e.assertUnique(c, it.section, text, it.id);
        await c.query(`UPDATE ${T} SET label = $2 WHERE id = $1`, [id, text]);
        await e.log(c, it, "renamed", req.user!.id, it.label, text);
        return { ...it, label: text };
      });
    });

    // Move an item one place up or down among the items in use in its section.
    app.post(`${path}/:id/move`, admin, async (req) => {
      const id = idParam(req.params);
      const dir = obj(req.body).direction;
      if (dir !== "up" && dir !== "down") throw bad('direction must be "up" or "down".');
      return tx(async (c) => {
        const it = await e.lockItem(c, id);
        if (!it.active) throw bad("Restore the item before moving it.");
        const list = await e.activeIds(c, it.section);
        const at = list.indexOf(id);
        const to = dir === "up" ? at - 1 : at + 1;
        if (to < 0 || to >= list.length) return { ok: true, moved: false };
        [list[at], list[to]] = [list[to], list[at]];
        await e.renumber(c, it.section, list);
        await e.log(c, it, "moved", req.user!.id, it.label, it.label);
        return { ok: true, moved: true };
      });
    });

    // Take an item off the form for new inspections. It stays on every inspection that already has it.
    app.post(`${path}/:id/retire`, admin, async (req) => {
      const id = idParam(req.params);
      return tx(async (c) => {
        const it = await e.lockItem(c, id);
        if (!it.active) throw conflict("That item is already retired.");
        await c.query(`UPDATE ${T} SET active = false WHERE id = $1`, [id]);
        await e.renumber(c, it.section, await e.activeIds(c, it.section));
        await e.log(c, it, "retired", req.user!.id, it.label, null);
        return { ok: true };
      });
    });

    // Put a retired item back, at the end of its section.
    app.post(`${path}/:id/restore`, admin, async (req) => {
      const id = idParam(req.params);
      return tx(async (c) => {
        const it = await e.lockItem(c, id);
        if (it.active) throw conflict("That item is already on the form.");
        await e.assertUnique(c, it.section, it.label, it.id);
        const before = await e.activeIds(c, it.section);
        await c.query(`UPDATE ${T} SET active = true WHERE id = $1`, [id]);
        await e.renumber(c, it.section, [...before, id]);
        await e.log(c, it, "restored", req.user!.id, null, it.label);
        return { ok: true };
      });
    });
  }
}
