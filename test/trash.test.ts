// The trash and Delete forever (migration 020) against a real Postgres. Needs TEST_DATABASE_URL like test/api.test.ts;
// it drops and recreates the public schema, so never point it at real data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test("trash tests", { skip: "set TEST_DATABASE_URL to run" }, () => {});
} else {
  process.env.DATABASE_URL = url;
  const uploadDir = mkdtempSync(join(tmpdir(), "gc-uploads-"));
  process.env.UPLOAD_DIR = uploadDir;
  process.env.ADMIN_EMAIL = "admin@test.local";
  process.env.ADMIN_PASSWORD = "admin-password-1";
  process.env.LOG_LEVEL = "silent";
  process.env.SEED_VEHICLES_CSV = "test/fixtures/vehicles.csv"; // the fake test fleet

  const { pool, q, one } = await import("../src/db.ts");
  const { migrate } = await import("../src/migrate.ts");
  const { ensureAdmin, seedVehicles } = await import("../src/seed.ts");
  const { buildApp } = await import("../src/server.ts");
  const { hashSecret } = await import("../src/auth.ts");
  const { closePdfBrowser } = await import("../src/pdf.ts");

  const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 1)]).toString("base64");
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]);
  const H = { "x-gc-app": "1" };
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0];
  const onDisk = (key: string) => existsSync(join(uploadDir, key));

  let app: Awaited<ReturnType<typeof buildApp>>;
  let crew = "", sup = "", shop = "", admin = "";
  let truck = 0;
  let adminId = 0;
  let checklist: { id: number; section: string }[] = [];

  async function inject(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
    return app.inject({
      method: method as "GET", url: "/api" + path,
      headers: { ...H, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
  }
  const ok = async (method: string, path: string, cookie: string, body?: unknown) => {
    const r = await inject(method, path, { cookie, body });
    assert.equal(r.statusCode < 300, true, `${method} ${path}: ${r.statusCode} ${r.body}`);
    return r.json();
  };

  async function uploadPhoto(cookie: string, id: string = randomUUID()) {
    const boundary = "----gc" + randomUUID();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${id}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      JPEG, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({ method: "POST", url: "/api/photos", payload: body,
      headers: { ...H, cookie, "content-type": `multipart/form-data; boundary=${boundary}` } });
    assert.equal(res.statusCode < 300, true, res.body);
    return id;
  }

  /** An inspection: everything OK except one repair (the first exterior item), with one damage mark. */
  function inspection(over: Record<string, unknown> = {}) {
    const items = checklist.filter((c) => c.section !== "trailer").map((c, n) => n === 0
      ? { checklist_item_id: c.id, result: "repair", note: "Left tail light out" }
      : { checklist_item_id: c.id, result: "ok" });
    return {
      client_id: randomUUID(), vehicle_id: truck, inspection_date: "2026-11-10", inspector_name: "Casey Crew", mileage: 48210,
      oil_change_due: false, existing_notes: null, new_observations: null, comments: null, trailer: null, items,
      damage: [{ key: "a1", diagram: "truck", x: 0.25, y: 0.5, note: "Dent, rear quarter" }], photos: [], signature: PNG, ...over,
    };
  }
  async function submitInspection(over: Record<string, unknown> = {}) {
    return (await ok("POST", "/inspections", crew, inspection(over))).id as string;
  }
  const trashList = async () => (await ok("GET", "/admin/trash", admin)) as {
    total: number; ready: number; items: { kind: string; id: string; title: string; ready: boolean; confirm: string; name: string | null }[];
  };
  const toTrash = (kind: string, id: string | number, reason = "Test record") => inject("POST", "/admin/trash", { cookie: admin, body: { kind, id, reason } });
  /** Pretend it went in the trash 8 days ago. */
  async function age(kind: string, id: string | number) {
    if (kind === "inspection") await q(`UPDATE inspection_states SET changed_at = now() - interval '8 days' WHERE inspection_id = $1`, [id]);
    else if (kind === "incident") await q(`UPDATE incident_states SET changed_at = now() - interval '8 days' WHERE incident_id = $1`, [id]);
    else await q(`UPDATE trash SET deleted_at = now() - interval '8 days' WHERE kind = $1 AND record_id = $2`, [kind, String(id)]);
  }
  const purge = (kind: string, id: string | number, confirm: string) =>
    inject("POST", "/admin/trash/purge", { cookie: admin, body: { kind, id, confirm } });

  before(async () => {
    await q("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(() => {});
    await ensureAdmin(() => {});
    await seedVehicles(() => {});
    await q(`INSERT INTO users (name, role, pin_hash) VALUES ('Casey Crew', 'crew', $1), ('Robin Shop', 'shop', $2)`,
      [await hashSecret("1234"), await hashSecret("1357")]);
    await q(`INSERT INTO users (name, role, email, password_hash) VALUES ('Sam Super', 'supervisor', 'sup@test.local', $1)`,
      [await hashSecret("super-password-1")]);
    app = await buildApp({ logger: false });
    truck = (await one(`SELECT id FROM vehicles WHERE truck_code = 'T018'`)).id;
    adminId = (await one(`SELECT id FROM users WHERE email = 'admin@test.local'`)).id;
    checklist = await q(`SELECT id, section FROM checklist_items WHERE active ORDER BY section, sort_order`);
    const pin = async (name: string, p: string) =>
      cookieOf(await inject("POST", "/auth/pin", { body: { user_id: (await one(`SELECT id FROM users WHERE name = $1`, [name])).id, pin: p } }));
    const login = async (email: string, password: string) => cookieOf(await inject("POST", "/auth/login", { body: { email, password } }));
    crew = await pin("Casey Crew", "1234");
    shop = await pin("Robin Shop", "1357");
    sup = await login("sup@test.local", "super-password-1");
    admin = await login("admin@test.local", "admin-password-1");
  });

  after(async () => {
    await app?.close();
    await closePdfBrowser();
    await pool.end();
  });

  describe("trash", () => {
    test("admins only", async () => {
      for (const cookie of [crew, shop, sup]) {
        assert.equal((await inject("GET", "/admin/trash", { cookie })).statusCode, 403);
        assert.equal((await inject("POST", "/admin/trash", { cookie, body: { kind: "inspection", id: randomUUID(), reason: "x" } })).statusCode, 403);
        assert.equal((await inject("POST", "/admin/trash/purge", { cookie, body: { kind: "inspection", id: randomUUID(), confirm: "T018" } })).statusCode, 403);
        assert.equal((await inject("POST", "/admin/trash/purge-ready", { cookie, body: { confirm: 0 } })).statusCode, 403);
        assert.equal((await inject("GET", "/admin/old-records?before=2026-01-01", { cookie })).statusCode, 403);
        assert.equal((await inject("GET", "/admin/purge-log", { cookie })).statusCode, 403);
      }
    });

    test("the database still refuses deletes outside Delete forever, and Delete forever only after 7 days in the trash", async () => {
      const id = await submitInspection();
      await assert.rejects(q(`DELETE FROM inspections WHERE id = $1`, [id]), /can't be deleted/);
      await assert.rejects(q(`DELETE FROM inspection_items WHERE inspection_id = $1`, [id]), /can't be deleted/);
      // Setting the flag by hand isn't enough to get through gc_begin_purge's checks.
      await assert.rejects(q(`SELECT gc_begin_purge('inspection', $1)`, [id]), /gc_not_in_trash/);
      assert.equal((await toTrash("inspection", id)).statusCode, 200);
      await assert.rejects(q(`SELECT gc_begin_purge('inspection', $1)`, [id]), /gc_not_ready/);
      const early = await purge("inspection", id, "T018");
      assert.equal(early.statusCode, 409, early.body);
      // The flag only lasts for its own transaction.
      await age("inspection", id);
      await q(`SELECT gc_begin_purge('inspection', $1)`, [id]);
      await assert.rejects(q(`DELETE FROM inspections WHERE id = $1`, [id]), /can't be deleted/);
      assert.equal((await one(`SELECT count(*)::int AS n FROM inspections WHERE id = $1`, [id])).n, 1);
      await ok("POST", "/admin/trash/restore", admin, { kind: "inspection", id });
    });

    test("an inspection: preview changes nothing; Delete forever erases it, its photos and files, and unhooks tickets and fixes", async () => {
      const itemPhoto = await uploadPhoto(crew);
      const dmgPhoto = await uploadPhoto(crew);
      const id = await submitInspection({
        photos: [{ id: itemPhoto, caption: "Tail light", checklist_item_id: checklist[0].id }, { id: dmgPhoto, caption: "Dent", damage_key: "a1" }],
      });
      const item = await one(`SELECT id FROM inspection_items WHERE inspection_id = $1 AND result = 'repair'`, [id]);
      const mark = await one(`SELECT id FROM damage_marks WHERE inspection_id = $1`, [id]);
      // A ticket for the repair, and the shop's entry fixing it.
      const ticket = (await ok("POST", "/repair-tickets", sup, { client_id: randomUUID(), vehicle_id: truck, item_ids: [item.id] })).id;
      const entry = await ok("POST", "/service-logs", shop, {
        client_id: randomUUID(), vehicle_id: truck, service_date: "2026-11-11", mileage: 61000, category: "repair", description: "New bulb",
        repair_item_ids: [item.id],
      });
      // A supervisor marks the dent repaired, with a photo.
      const fixPhoto = await uploadPhoto(sup);
      await ok("POST", `/damage-marks/${mark.id}/repair`, sup, { client_id: randomUUID(), note: "Body shop pulled it", photo_ids: [fixPhoto] });
      const paths = (await q(`SELECT file_path FROM photos WHERE id = ANY($1::uuid[])`, [[itemPhoto, dmgPhoto, fixPhoto]])).map((r) => r.file_path);
      const sig = (await one(`SELECT employee_signature_path AS p FROM inspections WHERE id = $1`, [id])).p;
      assert.ok([...paths, sig].every(onDisk));

      assert.equal((await toTrash("inspection", id, "Filed on the wrong truck")).statusCode, 200);
      let list = await trashList();
      const row = list.items.find((x) => x.id === id)!;
      assert.equal(row.title, "Inspection · T018");
      assert.equal(row.ready, false);
      assert.equal(row.confirm, "T018");
      assert.equal((await inject("POST", "/admin/trash/preview", { cookie: admin, body: { kind: "inspection", id } })).statusCode, 409);

      await age("inspection", id);
      list = await trashList();
      assert.equal(list.items.find((x) => x.id === id)!.ready, true);
      const counts = async () => (await one(`SELECT (SELECT count(*) FROM inspection_items)::int AS a, (SELECT count(*) FROM photos)::int AS b,
        (SELECT count(*) FROM damage_repairs)::int AS c, (SELECT count(*) FROM repair_ticket_items)::int AS d`));
      const beforePreview = await counts();
      const pv = await ok("POST", "/admin/trash/preview", admin, { kind: "inspection", id });
      assert.equal(pv.removed.photos, 3, JSON.stringify(pv));
      assert.equal(pv.removed["damage marks"], 1);
      assert.equal(pv.removed["damage repairs"], 1);
      assert.equal(pv.removed.signatures, 1);
      assert.ok(pv.notes.some((n: string) => n.includes("RT-")), JSON.stringify(pv.notes));
      assert.ok(pv.notes.some((n: string) => n.includes(`#${entry.id}`)), JSON.stringify(pv.notes));
      assert.deepEqual(await counts(), beforePreview, "a preview changes nothing");
      assert.ok(onDisk(paths[0]));

      assert.equal((await purge("inspection", id, "T019")).statusCode, 400);
      const res = await purge("inspection", id, "t018");
      assert.equal(res.statusCode, 200, res.body);
      for (const t of ["inspections WHERE id = $1", "inspection_items WHERE inspection_id = $1", "damage_marks WHERE inspection_id = $1",
        "photos WHERE inspection_id = $1", "inspection_states WHERE inspection_id = $1", "inspection_state_history WHERE inspection_id = $1"]) {
        assert.equal((await one(`SELECT count(*)::int AS n FROM ${t}`, [id])).n, 0, t);
      }
      assert.equal((await one(`SELECT count(*)::int AS n FROM photos WHERE id = ANY($1::uuid[])`, [[itemPhoto, dmgPhoto, fixPhoto]])).n, 0);
      assert.ok(![...paths, sig].some(onDisk), "the files are gone from the disk");
      // The ticket and the maintenance entry stay, without the repair that no longer exists.
      assert.equal((await one(`SELECT count(*)::int AS n FROM repair_tickets WHERE id = $1`, [ticket])).n, 1);
      assert.equal((await one(`SELECT count(*)::int AS n FROM repair_ticket_items WHERE ticket_id = $1`, [ticket])).n, 0);
      assert.equal((await ok("GET", `/repair-tickets/${ticket}`, sup)).items.length, 0);
      assert.equal((await ok("GET", `/service-logs/${entry.id}`, shop)).repairs.length, 0);
      // The log says what it was, not what it said; it can't be changed or erased.
      const log = await ok("GET", "/admin/purge-log", admin);
      const l = log.find((x: { title: string }) => x.title === "Inspection · T018");
      assert.equal(l.reason, "Filed on the wrong truck");
      assert.equal(l.purged_by_name, "Admin");
      assert.equal(l.files, 4);
      assert.ok(!JSON.stringify(l).includes("Casey"), "no names from the record in the log");
      await assert.rejects(q(`DELETE FROM purge_log`), /kept for good/);
      await assert.rejects(q(`UPDATE purge_log SET reason = 'x'`), /kept for good/);
      // A retry of the same delete is fine.
      assert.equal((await purge("inspection", id, "T018")).json().already, true);
      assert.equal((await trashList()).items.some((x) => x.id === id), false);
    });

    test("an incident report: photos, map, damage, notes and drawings all go", async () => {
      const general = await uploadPhoto(sup);
      const map = await uploadPhoto(sup);
      const filed = await ok("POST", "/incidents", sup, {
        client_id: randomUUID(), vehicle_id: truck, incident_date: "2026-11-17", anyone_injured: false, driver_name: "Casey Crew",
        description: "Backed into a post.", damage: [{ key: "d1", diagram: "truck", x: 0.9, y: 0.5, note: "Bumper" }],
        photos: [{ id: general, caption: "Post", damage_key: "d1" }, { id: map, caption: "Map", map: true }],
        reporter_name: "Sam Super", reporter_signature: PNG, driver_signature: PNG, sketch: PNG,
      });
      await ok("POST", `/incidents/${filed.id}/notes`, sup, { client_id: randomUUID(), note: "Claim opened" });
      const files = await one(`SELECT sketch_path, driver_signature_path, reporter_signature_path FROM incidents WHERE id = $1`, [filed.id]);
      assert.equal((await toTrash("incident", filed.id)).statusCode, 200);
      await age("incident", filed.id);
      const res = await purge("incident", filed.id, "T018");
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await one(`SELECT count(*)::int AS n FROM incidents WHERE id = $1`, [filed.id])).n, 0);
      assert.equal((await one(`SELECT count(*)::int AS n FROM photos WHERE id = ANY($1::uuid[])`, [[general, map]])).n, 0);
      assert.equal((await one(`SELECT count(*)::int AS n FROM damage_marks WHERE incident_id = $1`, [filed.id])).n, 0);
      assert.ok(!Object.values(files).some((p) => onDisk(p as string)));
    });

    test("a maintenance entry: Delete voids it first (its repair opens again), restore brings it back voided, Delete forever erases it", async () => {
      const insp = await submitInspection();
      const item = await one(`SELECT id FROM inspection_items WHERE inspection_id = $1 AND result = 'repair'`, [insp]);
      const photo = await uploadPhoto(shop);
      const entry = await ok("POST", "/service-logs", shop, {
        client_id: randomUUID(), vehicle_id: truck, service_date: "2026-11-12", mileage: 61100, category: "repair", description: "Bulb",
        repair_item_ids: [item.id], photos: [{ id: photo }],
      });
      assert.ok((await one(`SELECT resolved_at FROM inspection_items WHERE id = $1`, [item.id])).resolved_at);
      assert.equal((await inject("POST", "/admin/trash", { cookie: shop, body: { kind: "service_log", id: entry.id, reason: "x" } })).statusCode, 403);
      assert.equal((await toTrash("service_log", entry.id, "Wrong truck")).statusCode, 200);
      assert.equal((await toTrash("service_log", entry.id)).statusCode, 409, "already in the trash");
      assert.equal((await one(`SELECT resolved_at FROM inspection_items WHERE id = $1`, [item.id])).resolved_at, null, "voiding reopened it");
      const listed = async () => (await ok("GET", `/vehicles/${truck}/service`, shop)).entries.some((x: { id: number }) => x.id === entry.id);
      assert.equal(await listed(), false);
      const detail = await ok("GET", `/service-logs/${entry.id}`, shop);
      assert.equal(detail.trash.reason, "Wrong truck");
      assert.ok(detail.voided);

      await ok("POST", "/admin/trash/restore", admin, { kind: "service_log", id: entry.id });
      assert.equal(await listed(), true);
      assert.ok((await ok("GET", `/service-logs/${entry.id}`, shop)).voided, "comes back voided");
      assert.equal((await ok("POST", "/admin/trash/restore", admin, { kind: "service_log", id: entry.id }).catch(() => "409")), "409");

      assert.equal((await toTrash("service_log", entry.id)).statusCode, 200);
      await age("service_log", entry.id);
      const file = (await one(`SELECT file_path FROM photos WHERE id = $1`, [photo])).file_path;
      const res = await purge("service_log", entry.id, "T018");
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await one(`SELECT count(*)::int AS n FROM service_logs WHERE id = $1`, [entry.id])).n, 0);
      assert.equal((await one(`SELECT count(*)::int AS n FROM service_log_history WHERE service_log_id = $1`, [entry.id])).n, 0);
      assert.equal(onDisk(file), false);
    });

    test("a yard walk: out of the yard's walks and the findings while in the trash; back on restore; gone for good after", async () => {
      const yardId = (await one(`SELECT id FROM yards WHERE code = 'MAIN'`)).id;
      const items = await q(`SELECT id FROM yard_checklist_items WHERE active ORDER BY id`);
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const walk = await ok("POST", "/yard-inspections", sup, {
        client_id: randomUUID(), yard_id: yardId, inspection_date: today, inspector_name: "Sam Super", comments: null, signature: PNG,
        items: items.map((c, n) => n === 0 ? { checklist_item_id: c.id, result: "repair", note: "Extinguisher missing tag" }
          : { checklist_item_id: c.id, result: "ok" }), photos: [],
      });
      const findings = async () => (await ok("GET", "/yard-findings", sup)).filter((f: { yard_inspection_id: string }) => f.yard_inspection_id === walk.id).length;
      const walks = async () => (await ok("GET", `/yards/${yardId}/inspections`, sup)).some((w: { id: string }) => w.id === walk.id);
      assert.equal(await findings(), 1);
      assert.equal((await toTrash("yard_walk", walk.id)).statusCode, 200);
      assert.equal(await findings(), 0);
      assert.equal(await walks(), false);
      assert.equal((await ok("GET", "/yards", sup)).find((y: { id: number }) => y.id === yardId).walked_today, false);
      const f = await one(`SELECT id FROM yard_inspection_items WHERE yard_inspection_id = $1 AND result = 'repair'`, [walk.id]);
      assert.equal((await inject("POST", `/yard-findings/${f.id}/resolve`, { cookie: sup, body: { note: "x" } })).statusCode, 409);
      await ok("POST", "/admin/trash/restore", admin, { kind: "yard_walk", id: walk.id });
      assert.equal(await findings(), 1);
      assert.equal(await walks(), true);

      assert.equal((await toTrash("yard_walk", walk.id)).statusCode, 200);
      await age("yard_walk", walk.id);
      const sig = (await one(`SELECT signature_path AS p FROM yard_inspections WHERE id = $1`, [walk.id])).p;
      const res = await purge("yard_walk", walk.id, "MAIN");
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await one(`SELECT count(*)::int AS n FROM yard_inspections WHERE id = $1`, [walk.id])).n, 0);
      assert.equal((await one(`SELECT count(*)::int AS n FROM trash_history WHERE record_id = $1`, [walk.id])).n, 0);
      assert.equal(onDisk(sig), false);
    });

    test("an equipment check and an equipment entry", async () => {
      const trl = await ok("POST", "/admin/trailers", admin, { trailer_number: "T-9" });
      const piece = await ok("POST", "/admin/equipment", admin, { tag: "BL-9", type: "blower", trailer_id: trl.id });
      const cfg = await ok("GET", `/equipment-config/${trl.id}`, shop);
      const cl = cfg.checklist.filter((c: { section: string }) => c.section === "all" || c.section === "blower");
      const check = await ok("POST", "/equipment-checks", shop, {
        client_id: randomUUID(), trailer_id: trl.id, check_date: "2026-11-15", checker_name: "Robin Shop", comments: null, photos: [],
        pieces: [{ equipment_id: piece.id, status: "checked", items: cl.map((c: { id: number }, n: number) => n === 0
          ? { checklist_item_id: c.id, result: "repair", note: "Guard cracked" } : { checklist_item_id: c.id, result: "ok" }) }],
      });
      const problem = await one(`SELECT id FROM equipment_check_items WHERE check_id = $1 AND result = 'repair'`, [check.id]);
      const open = async () => (await ok("GET", "/equipment-findings", shop)).some((x: { id: number }) => x.id === problem.id);
      assert.equal(await open(), true);
      const fix = await ok("POST", "/equipment-service", shop, {
        client_id: randomUUID(), equipment_id: piece.id, service_date: "2026-11-16", work: [{ type: "repair" }], description: "New guard",
        fix_item_ids: [problem.id],
      });
      assert.equal(await open(), false);
      assert.equal((await toTrash("equipment_service", fix.id)).statusCode, 200);
      assert.equal(await open(), true, "voided first, so the problem is open again");
      assert.equal((await ok("GET", `/equipment/${piece.id}/service`, shop)).entries.length, 0);

      assert.equal((await toTrash("equipment_check", check.id)).statusCode, 200);
      assert.equal(await open(), false, "off the board while its check is in the trash");
      assert.equal((await ok("GET", `/equipment-config/${trl.id}`, shop)).pieces[0].last_checked, null);
      for (const [kind, id] of [["equipment_check", check.id], ["equipment_service", fix.id]]) await age(kind, id);
      // The entry first or the check first: either works (the link between them goes with whichever is first).
      assert.equal((await purge("equipment_check", check.id, "T-9")).statusCode, 200);
      assert.equal((await purge("equipment_service", fix.id, "BL-9")).statusCode, 200);
      assert.equal((await one(`SELECT count(*)::int AS n FROM equipment_checks WHERE id = $1`, [check.id])).n, 0);
      assert.equal((await one(`SELECT count(*)::int AS n FROM equipment_service_logs WHERE id = $1`, [fix.id])).n, 0);
    });

    test("a ticket is voided as it goes in, and drops off the truck's tickets", async () => {
      const insp = await submitInspection();
      const item = await one(`SELECT id FROM inspection_items WHERE inspection_id = $1 AND result = 'repair'`, [insp]);
      const t = await ok("POST", "/repair-tickets", sup, { client_id: randomUUID(), vehicle_id: truck, item_ids: [item.id] });
      assert.equal((await toTrash("repair_ticket", t.id)).statusCode, 200);
      assert.ok((await one(`SELECT voided_at FROM repair_tickets WHERE id = $1`, [t.id])).voided_at);
      assert.equal((await ok("GET", `/vehicles/${truck}/repair-tickets`, sup)).some((x: { id: number }) => x.id === t.id), false);
      await age("repair_ticket", t.id);
      assert.equal((await purge("repair_ticket", t.id, "T018")).statusCode, 200);
      assert.equal((await one(`SELECT count(*)::int AS n FROM repair_ticket_items WHERE ticket_id = $1`, [t.id])).n, 0);
    });

    test("trucks: only a retired one with nothing on file; it can't be changed while in the trash", async () => {
      assert.equal((await toTrash("vehicle", truck)).statusCode, 409, "in service");
      const az = await ok("POST", "/admin/vehicles", admin, { truck_code: "T900" });
      assert.equal((await toTrash("vehicle", az.id)).statusCode, 409, "retire it first");
      await ok("PATCH", `/admin/vehicles/${az.id}`, admin, { active: false });
      assert.equal((await toTrash("vehicle", az.id, "Added by mistake")).statusCode, 200);
      assert.equal((await ok("GET", "/admin/vehicles", admin)).some((v: { id: number }) => v.id === az.id), false);
      assert.equal((await inject("PATCH", `/admin/vehicles/${az.id}`, { cookie: admin, body: { active: true } })).statusCode, 409);
      assert.equal((await inject("POST", `/vehicles/${az.id}/status`, { cookie: sup, body: { status: "in_service" } })).statusCode, 409);
      await age("vehicle", az.id);
      const res = await purge("vehicle", az.id, "T900");
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await one(`SELECT count(*)::int AS n FROM vehicles WHERE id = $1`, [az.id])).n, 0);
      assert.equal((await one(`SELECT count(*)::int AS n FROM vehicle_status_changes WHERE vehicle_id = $1`, [az.id])).n, 0);

      // A retired truck with inspections stays retired.
      const used = await ok("POST", "/admin/vehicles", admin, { truck_code: "T901" });
      await submitInspection({ vehicle_id: used.id });
      await ok("PATCH", `/admin/vehicles/${used.id}`, admin, { active: false });
      const no = await toTrash("vehicle", used.id);
      assert.equal(no.statusCode, 409);
      assert.match(no.json().message, /has 1 inspection on file/);
    });

    test("users: only an inactive one who never did anything, and never yourself", async () => {
      assert.equal((await toTrash("user", adminId)).statusCode, 400);
      const crewId = (await one(`SELECT id FROM users WHERE name = 'Casey Crew'`)).id;
      await ok("PATCH", `/admin/users/${crewId}`, admin, { active: false });
      const no = await toTrash("user", crewId);
      assert.equal(no.statusCode, 409, "has inspections on file");
      await ok("PATCH", `/admin/users/${crewId}`, admin, { active: true });
      crew = cookieOf(await inject("POST", "/auth/pin", { body: { user_id: crewId, pin: "1234" } })); // inactive signed them out
      const u = await ok("POST", "/admin/users", admin, { name: "Test Person", role: "crew", pin: "9999" });
      assert.equal((await toTrash("user", u.id)).statusCode, 409, "make them inactive first");
      await ok("PATCH", `/admin/users/${u.id}`, admin, { active: false });
      assert.equal((await toTrash("user", u.id)).statusCode, 200);
      assert.equal((await ok("GET", "/admin/users", admin)).some((x: { id: number }) => x.id === u.id), false);
      assert.equal((await inject("PATCH", `/admin/users/${u.id}`, { cookie: admin, body: { active: true } })).statusCode, 409);
      const row = (await trashList()).items.find((x) => x.kind === "user")!;
      assert.equal(row.confirm, "Test Person");
      await age("user", u.id);
      assert.equal((await purge("user", u.id, "test person")).statusCode, 200);
      assert.equal((await one(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [u.id])).n, 0);
      const log = await ok("GET", "/admin/purge-log", admin);
      assert.ok(log.some((l: { title: string }) => l.title === `User #${u.id} (crew)`), "logged without the name");
    });

    test("old records: counted, moved in after the count is typed; old fixes stay fixed", async () => {
      const old = await submitInspection({ inspection_date: "2021-03-01" });
      const item = await one(`SELECT id FROM inspection_items WHERE inspection_id = $1 AND result = 'repair'`, [old]);
      const entry = await ok("POST", "/service-logs", shop, {
        client_id: randomUUID(), vehicle_id: truck, service_date: "2021-03-02", mileage: 20000, category: "repair", description: "Bulb",
        repair_item_ids: [item.id],
      });
      const preview = await ok("GET", "/admin/old-records?before=2022-01-01&kinds=inspection,service_log", admin);
      assert.deepEqual(preview.counts, { inspection: 1, service_log: 1 });
      const wrong = await inject("POST", "/admin/old-records/trash", { cookie: admin,
        body: { before: "2022-01-01", kinds: ["inspection", "service_log"], reason: "Over 3 years old", confirm: 5 } });
      assert.equal(wrong.statusCode, 409);
      const moved = await ok("POST", "/admin/old-records/trash", admin,
        { before: "2022-01-01", kinds: ["inspection", "service_log"], reason: "Over 3 years old", confirm: 2 });
      assert.equal(moved.total, 2);
      assert.ok((await one(`SELECT voided_at FROM service_logs WHERE id = $1`, [entry.id])).voided_at);
      assert.ok((await one(`SELECT resolved_at FROM inspection_items WHERE id = $1`, [item.id])).resolved_at, "the fix stays");
      assert.equal((await ok("GET", "/admin/old-records?before=2022-01-01", admin)).total, 0);
      assert.equal((await inject("GET", "/admin/old-records?before=2099-01-01", { cookie: admin })).statusCode, 400);
    });

    test("Delete forever all ready: the count must be typed; then everything old enough goes", async () => {
      const items = (await trashList()).items;
      for (const it of items) await age(it.kind, it.id);
      const list = await trashList();
      assert.equal(list.ready, list.total);
      assert.equal((await inject("POST", "/admin/trash/purge-ready", { cookie: admin, body: { confirm: list.ready + 1 } })).statusCode, 409);
      const r = await ok("POST", "/admin/trash/purge-ready", admin, { confirm: list.ready });
      assert.equal(r.purged, list.ready, JSON.stringify(r.failed));
      assert.equal(r.remaining, 0);
      assert.equal((await trashList()).total, 0);
    });
  });
}
