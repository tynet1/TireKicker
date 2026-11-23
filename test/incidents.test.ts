// Incident reports (migration 018) against a real Postgres. Needs TEST_DATABASE_URL like test/api.test.ts; it drops and
// recreates the public schema, so never point it at real data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test("incident tests", { skip: "set TEST_DATABASE_URL to run" }, () => {});
} else {
  process.env.DATABASE_URL = url;
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "gc-uploads-"));
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
  const { cleanupOrphanPhotos } = await import("../src/routes/photos.ts");
  const { loadIncident } = await import("../src/routes/incidents.ts");
  const { incidentPdfHtml, injuryForms } = await import("../src/incident-pdf.ts");
  const { UNATTACHED } = await import("../src/photo-owners.ts");

  const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 1)]).toString("base64");
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]);
  const H = { "x-gc-app": "1" };
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0];

  let app: Awaited<ReturnType<typeof buildApp>>;
  let crew = "", sup = "", sup2 = "", shop = "", admin = "";
  let truck = 0;

  async function inject(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
    return app.inject({
      method: method as "GET", url: "/api" + path,
      headers: { ...H, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
  }

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function report(over: Record<string, unknown> = {}): Record<string, any> {
    return {
      client_id: randomUUID(), vehicle_id: truck, incident_date: "2026-11-17", incident_time: "14:35",
      weather: "Clear", location_name: "Oak Park HOA", on_job: true, site_name: "Oak Park",
      street: "Main St & 1st Ave", city: "Springfield", state: "CO", zip: "80000",
      latitude: 39.70512, longitude: -104.97803, location_accuracy_m: 9,
      police_present: true, police_department: "Springfield PD", officer_name: "Ofc. Ruiz", police_report_no: "PD-26-0042",
      citation_driver: false, citation_other: true,
      anyone_injured: false, driver_name: "Casey Crew", passengers: false, seatbelt_driver: true, drivable: true,
      damage_gc: "Rear bumper pushed in", description: "Stopped at the light; a sedan hit us from behind.",
      other_parties: [{ name: "Jordan Other", phone: "555-555-0100", make: "Honda", model: "Civic", plate_no: "ABC1234",
        insurance_company: "Acme Mutual", policy_no: "P-99" }],
      witnesses: [{ name: "Wes Witness", phone: "555-555-0111" }],
      damage: [{ key: "d1", diagram: "truck", x: 0.9, y: 0.5, note: "Rear bumper dented" },
        { key: "d2", diagram: "truck", x: 0.85, y: 0.4, note: "Tail light cracked" }],
      photos: [],
      reporter_name: "Sam Super", reporter_signature: PNG, driver_signature: PNG, sketch: PNG,
      ...over,
    };
  }

  before(async () => {
    await q("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(() => {});
    await ensureAdmin(() => {});
    await seedVehicles(() => {});
    await q(`INSERT INTO users (name, role, pin_hash) VALUES ('Casey Crew', 'crew', $1), ('Robin Shop', 'shop', $2)`,
      [await hashSecret("1234"), await hashSecret("1357")]);
    await q(`INSERT INTO users (name, role, email, password_hash) VALUES ('Sam Super', 'supervisor', 'sup@test.local', $1),
      ('Pat Super', 'supervisor', 'pat@test.local', $1)`, [await hashSecret("super-password-1")]);
    app = await buildApp({ logger: false });
    truck = (await one(`SELECT id FROM vehicles WHERE truck_code = 'T018'`)).id;
    const pin = async (name: string, p: string) =>
      cookieOf(await inject("POST", "/auth/pin", { body: { user_id: (await one(`SELECT id FROM users WHERE name = $1`, [name])).id, pin: p } }));
    const login = async (email: string, password: string) => cookieOf(await inject("POST", "/auth/login", { body: { email, password } }));
    crew = await pin("Casey Crew", "1234");
    shop = await pin("Robin Shop", "1357");
    sup = await login("sup@test.local", "super-password-1");
    sup2 = await login("pat@test.local", "super-password-1");
    admin = await login("admin@test.local", "admin-password-1");
  });

  after(async () => {
    await app?.close();
    await closePdfBrowser();
    await pool.end();
  });

  describe("incident reports", () => {
    let id = "";
    let markIds: number[] = [];
    let licensePhoto = "";
    let damagePhoto = "";

    test("only supervisors and admins can file or read reports", async () => {
      for (const cookie of [crew, shop]) {
        assert.equal((await inject("POST", "/incidents", { cookie, body: report() })).statusCode, 403);
        assert.equal((await inject("GET", "/incidents", { cookie })).statusCode, 403);
        assert.equal((await inject("GET", "/incident-config", { cookie })).statusCode, 403);
      }
    });

    test("required: date, driver, injuries yes/no, what happened, manager's name and signature", async () => {
      for (const [field, value] of [["incident_date", ""], ["driver_name", " "], ["anyone_injured", null], ["description", ""],
        ["reporter_name", ""], ["reporter_signature", null]] as const) {
        const res = await inject("POST", "/incidents", { cookie: sup, body: report({ [field]: value }) });
        assert.equal(res.statusCode, 400, `${field}: ${res.body}`);
      }
      const future = await inject("POST", "/incidents", { cookie: sup, body: report({ incident_date: "2031-01-01" }) });
      assert.equal(future.statusCode, 400);
      const trailerNoTrailer = await inject("POST", "/incidents", {
        cookie: sup, body: report({ damage: [{ key: "t", diagram: "trailer", x: 0.5, y: 0.5, note: "x" }] }) });
      assert.equal(trailerNoTrailer.statusCode, 400);
    });

    test("photos must be uploaded first (photos_missing), then the report files with its damage and photos", async () => {
      licensePhoto = randomUUID();
      damagePhoto = randomUUID();
      const mapPhoto = randomUUID();
      const body = report({ photos: [
        { id: licensePhoto, caption: "Other party 1: license" },
        { id: damagePhoto, caption: "Close up", damage_key: "d1" },
        { id: mapPhoto, caption: "Map", map: true },
      ] });
      const early = await inject("POST", "/incidents", { cookie: sup, body });
      assert.equal(early.statusCode, 422);
      assert.equal(early.json().details.code, "photos_missing");
      for (const p of [licensePhoto, damagePhoto, mapPhoto]) await uploadPhoto(sup, p);

      const res = await inject("POST", "/incidents", { cookie: sup, body });
      assert.equal(res.statusCode, 201, res.body);
      id = res.json().id;
      assert.equal(res.json().damage, 2);
      // A retry (the phone never heard back) gets the same report, not a second one.
      const again = await inject("POST", "/incidents", { cookie: sup, body });
      assert.equal(again.statusCode, 200);
      assert.equal(again.json().id, id);
      assert.equal((await one(`SELECT count(*)::int AS n FROM incidents WHERE client_id = $1`, [body.client_id])).n, 1);

      const n = await one(`SELECT * FROM incidents WHERE id = $1`, [id]);
      assert.equal(n.map_photo_id, mapPhoto);
      assert.equal(n.other_parties[0].insurance_company, "Acme Mutual");
      assert.ok(n.sketch_path && n.driver_signature_path && n.reporter_signature_path);
      markIds = (await q(`SELECT id FROM damage_marks WHERE incident_id = $1 ORDER BY seq`, [id])).map((r) => r.id);
      assert.equal(markIds.length, 2);
      const dp = await one(`SELECT incident_id, damage_mark_id FROM photos WHERE id = $1`, [damagePhoto]);
      assert.equal(dp.incident_id, id);
      assert.equal(dp.damage_mark_id, markIds[0]);
    });

    test("two phones sending the same report at once make one report", async () => {
      const body = report({ damage: [] });
      const [a, b] = await Promise.all([inject("POST", "/incidents", { cookie: sup, body }), inject("POST", "/incidents", { cookie: sup, body })]);
      assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 201]);
      assert.equal(a.json().id, b.json().id);
      await inject("POST", `/incidents/${a.json().id}/archive`, { cookie: sup, body: {} });
    });

    test("the damage goes on the truck's damage on file and its open repairs", async () => {
      const t = (await inject("GET", `/vehicles/${truck}`, { cookie: crew })).json();
      const fromIncident = t.damage.filter((m: { incident_id: string | null }) => m.incident_id === id);
      assert.equal(fromIncident.length, 2);
      assert.equal(fromIncident[0].inspection_date, "2026-11-17");
      assert.equal(t.vehicle.open_repairs, 2);
      // The inspection form shows it as grey dots, even on a truck that's never been inspected.
      const last = (await inject("GET", `/vehicles/${truck}/last`, { cookie: crew })).json();
      assert.equal(last.inspection, null);
      assert.equal(last.damage.filter((m: { incident_id: string | null }) => m.incident_id === id).length, 2);
      const v = (await inject("GET", "/vehicles", { cookie: crew })).json().find((x: { id: number }) => x.id === truck);
      assert.equal(v.open_repairs, 2);
      const board = (await inject("GET", "/incident-repairs", { cookie: shop })).json();
      assert.equal(board.length, 2);
      assert.equal(board[0].incident_id, null, "the shop sees the damage, not the report");
      assert.equal((await inject("GET", "/incident-repairs", { cookie: sup })).json()[0].incident_id, id);
      const csv = await inject("GET", "/export/repairs.csv", { cookie: sup });
      assert.match(csv.body, /Incident damage,Damage,Rear bumper dented/);
      assert.match(csv.body, new RegExp(`incident/${id}`));
    });

    test("the other party's photos are for supervisors only; damage photos show with the truck's damage", async () => {
      assert.equal((await inject("GET", `/photos/${licensePhoto}`, { cookie: crew })).statusCode, 404);
      assert.equal((await inject("GET", `/photos/${licensePhoto}`, { cookie: sup })).statusCode, 200);
      assert.equal((await inject("GET", `/photos/${damagePhoto}`, { cookie: crew })).statusCode, 200);
      assert.equal((await inject("GET", `/incidents/${id}/file/sketch`, { cookie: crew })).statusCode, 403);
      assert.equal((await inject("GET", `/incidents/${id}/file/sketch`, { cookie: sup })).statusCode, 200);
    });

    test("other supervisors are told: new until they open it; the filer isn't", async () => {
      assert.ok(!(await inject("GET", "/incidents/unread", { cookie: sup })).json().some((n: { id: string }) => n.id === id));
      const unread = (await inject("GET", "/incidents/unread", { cookie: sup2 })).json();
      assert.ok(unread.some((n: { id: string }) => n.id === id));
      assert.ok((await inject("GET", `/incidents/${id}`, { cookie: sup2 })).json().unread);
      assert.equal((await inject("POST", `/incidents/${id}/read`, { cookie: sup2, body: {} })).statusCode, 200);
      assert.equal((await inject("POST", `/incidents/${id}/read`, { cookie: sup2, body: {} })).statusCode, 200, "again is harmless");
      assert.ok(!(await inject("GET", "/incidents/unread", { cookie: sup2 })).json().some((n: { id: string }) => n.id === id));
      assert.ok((await inject("GET", "/incidents/unread", { cookie: admin })).json().some((n: { id: string }) => n.id === id));
    });

    test("filed reports can't be changed or erased, even in the database; corrections are notes", async () => {
      await assert.rejects(q(`UPDATE incidents SET description = 'x' WHERE id = $1`, [id]), /can't be updated/);
      await assert.rejects(q(`DELETE FROM incidents WHERE id = $1`, [id]), /can't be deleted/);
      await assert.rejects(q(`DELETE FROM damage_marks WHERE incident_id = $1`, [id]), /can't be deleted/);
      await assert.rejects(q(`UPDATE damage_marks SET note = 'x' WHERE incident_id = $1`, [id]), /read-only/);
      await assert.rejects(q(`DELETE FROM photos WHERE id = $1`, [licensePhoto]), /can't be deleted/);
      await assert.rejects(q(`DELETE FROM incident_reads WHERE incident_id = $1`, [id]), /can't be deleted/);
      // The week-old clean-up only looks at photos attached to nothing, and a report's photos are attached.
      assert.equal(await one(`SELECT 1 FROM photos WHERE id = $1 AND ${UNATTACHED}`, [licensePhoto]), undefined);
      await cleanupOrphanPhotos(() => {});
      assert.ok(await one(`SELECT 1 FROM photos WHERE id = $1`, [licensePhoto]));

      const clientId = randomUUID();
      const note = await inject("POST", `/incidents/${id}/notes`, { cookie: sup2, body: { client_id: clientId, note: "Claim AUTO-1234 opened" } });
      assert.equal(note.statusCode, 201, note.body);
      const again = await inject("POST", `/incidents/${id}/notes`, { cookie: sup2, body: { client_id: clientId, note: "Claim AUTO-1234 opened" } });
      assert.equal(again.json().duplicate, true);
      await assert.rejects(q(`UPDATE incident_notes SET note = 'x'`), /can't be updated/);
      const d = (await inject("GET", `/incidents/${id}`, { cookie: sup })).json();
      assert.equal(d.notes.length, 1);
      assert.equal(d.notes[0].created_by_name, "Pat Super");
      assert.equal(d.sketch_path, undefined, "no file paths go to the phone");
      assert.ok(d.photos.find((p: { id: string; map: boolean }) => p.map));
    });

    test("marking the damage repaired takes it off the repairs, keeps it on the report", async () => {
      const photo = await uploadPhoto(sup);
      const res = await inject("POST", `/damage-marks/${markIds[1]}/repair`, {
        cookie: sup, body: { client_id: randomUUID(), note: "New tail light", photo_ids: [photo] } });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal((await inject("GET", "/incident-repairs", { cookie: sup })).json().length, 1);
      const v = (await inject("GET", `/vehicles/${truck}`, { cookie: sup })).json().vehicle;
      assert.equal(v.open_repairs, 1);
      const d = (await inject("GET", `/incidents/${id}`, { cookie: sup })).json();
      assert.ok(d.damage.find((m: { id: number; repaired_at: string | null }) => m.id === markIds[1]).repaired_at);
      const list = (await inject("GET", `/incidents?vehicle_id=${truck}`, { cookie: sup })).json();
      assert.equal(list.find((n: { id: string }) => n.id === id).open_damage, 1);
    });

    test("the shop's Log fix closes incident damage too", async () => {
      const after = await uploadPhoto(shop);
      const res = await inject("POST", "/service-logs", { cookie: shop, body: {
        client_id: randomUUID(), vehicle_id: truck, service_date: "2026-11-18", mileage: 52000, category: "repair",
        description: "Replaced rear bumper", damage_mark_ids: [markIds[0]], photos: [{ id: after, caption: "New bumper", damage_mark_id: markIds[0] }],
      } });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal((await inject("GET", "/incident-repairs", { cookie: sup })).json().length, 0);
      const e = (await inject("GET", `/service-logs/${res.json().id}`, { cookie: sup })).json();
      assert.equal(e.damage_fixes[0].incident_id, id);
      assert.equal(e.damage_fixes[0].inspection_date, "2026-11-17");
    });

    test("archive takes its damage off the truck; un-archive brings it back; delete is admin-only and restorable", async () => {
      const fresh = await inject("POST", "/incidents", { cookie: sup, body: report({ damage: [{ key: "a", diagram: "truck", x: 0.2, y: 0.2, note: "Door" }] }) });
      const nid = fresh.json().id;
      const open = async () => (await inject("GET", `/vehicles/${truck}`, { cookie: sup })).json().vehicle.open_repairs;
      assert.equal(await open(), 1);
      assert.equal((await inject("POST", `/incidents/${nid}/archive`, { cookie: sup, body: { reason: "Duplicate" } })).statusCode, 200);
      assert.equal(await open(), 0);
      assert.ok(!(await inject("GET", "/incidents", { cookie: sup })).json().some((n: { id: string }) => n.id === nid));
      assert.ok((await inject("GET", "/incidents?archived=only", { cookie: sup })).json().some((n: { id: string }) => n.id === nid));
      await inject("POST", `/incidents/${nid}/unarchive`, { cookie: sup, body: {} });
      assert.equal(await open(), 1);

      assert.equal((await inject("POST", `/incidents/${nid}/delete`, { cookie: sup, body: { reason: "Test" } })).statusCode, 403);
      assert.equal((await inject("POST", `/incidents/${nid}/delete`, { cookie: admin, body: {} })).statusCode, 400, "a reason is required");
      assert.equal((await inject("POST", `/incidents/${nid}/delete`, { cookie: admin, body: { reason: "Test report" } })).statusCode, 200);
      assert.equal(await open(), 0);
      assert.ok((await inject("GET", "/admin/deleted-incidents", { cookie: admin })).json().some((n: { id: string }) => n.id === nid));
      assert.equal((await inject("POST", `/incidents/${nid}/notes`, { cookie: sup, body: { client_id: randomUUID(), note: "x" } })).statusCode, 409);
      await inject("POST", `/incidents/${nid}/restore`, { cookie: admin, body: {} });
      assert.equal(await open(), 1);
      await assert.rejects(q(`DELETE FROM incident_states WHERE incident_id = $1`, [nid]), /can't be deleted/);
      const hist = (await inject("GET", `/incidents/${nid}`, { cookie: sup })).json().state_history;
      assert.deepEqual(hist.map((h: { action: string }) => h.action), ["archive", "unarchive", "delete", "restore"]);
      await inject("POST", `/incidents/${nid}/archive`, { cookie: sup, body: {} });
    });

    test("the truck list's open repairs = open inspection repairs + incident damage not yet repaired", async () => {
      const rows = await q(`SELECT vs.id, vs.open_repairs,
          (SELECT count(*) FROM inspection_items ii JOIN live_inspections i ON i.id = ii.inspection_id
            WHERE i.vehicle_id = vs.id AND ii.result = 'repair' AND ii.resolved_at IS NULL)
          + (SELECT count(*) FROM damage_marks dm JOIN live_incidents n ON n.id = dm.incident_id
            WHERE n.vehicle_id = vs.id AND NOT EXISTS (SELECT 1 FROM damage_repairs dr WHERE dr.damage_mark_id = dm.id AND dr.active)) AS direct
          FROM vehicle_status vs`);
      for (const r of rows) assert.equal(Number(r.open_repairs), Number(r.direct), `truck ${r.id}`);
    });

    test("the PDF packet: manager's report, accident report, damage, photo log; injury forms only when our employee was hurt", async () => {
      const d = (await loadIncident(id))!;
      const html = await incidentPdfHtml(d);
      for (const s of ["Managers Incident Report", "Vehicle Accident Report", "PHOTOGRAPH LOG", "Damage to", "Notes Added After Filing",
        "Jordan Other", "Acme Mutual", "PD-26-0042", "Main St &amp; 1st Ave", "2:35", "Claim AUTO-1234 opened",
        "Rear bumper dented", "Wes Witness", "39.70512"]) assert.ok(html.includes(s), s);
      // The address's state, not the report's archive state (both are "state" in the database).
      assert.match(html, /State<\/span><span class="uv">CO</);
      assert.ok(!html.includes(`<span class="uv">active</span>`));
      assert.equal((await inject("GET", `/incidents/${id}`, { cookie: sup })).json().address_state, "CO");
      assert.ok(!html.includes("Employee Injury/Near Miss Report"));
      assert.ok(!html.includes("Refusal of Medical Treatment"));
      // The map prints on the diagram page, not in the photo log: two photos in the log, numbered 1 and 2.
      assert.equal((html.match(/Photograph No\.<\/b>/g) || []).length, 2);

      assert.deepEqual(injuryForms({ employee_injured: true, medical_evaluation: true }), { injury: true, refusal: false });
      assert.deepEqual(injuryForms({ employee_injured: true, medical_evaluation: null }), { injury: true, refusal: true });
      assert.deepEqual(injuryForms({ employee_injured: false, medical_evaluation: null }), { injury: false, refusal: false });
      const hurt = await inject("POST", "/incidents", { cookie: sup, body: report({
        anyone_injured: true, employee_injured: true, injury_description: "Sore neck", medical_evaluation: false, damage: [], driver_signature: null, sketch: null,
      }) });
      assert.equal(hurt.statusCode, 201, hurt.body);
      const h2 = await incidentPdfHtml((await loadIncident(hurt.json().id))!);
      assert.ok(h2.includes("Employee Injury/Near Miss Report"));
      assert.ok(h2.includes("Employee Refusal of Medical Treatment"));
      assert.ok(h2.includes("Sore neck"));
      await inject("POST", `/incidents/${hurt.json().id}/archive`, { cookie: sup, body: {} });
    });

    test("incident damage goes on a repair ticket only when it's picked (019)", async () => {
      const { loadTicket } = await import("../src/routes/tickets.ts");
      const { ticketPdfHtml } = await import("../src/ticket-pdf.ts");
      const filed = await inject("POST", "/incidents", { cookie: sup, body: report({ damage: [
        { key: "a", diagram: "truck", x: 0.3, y: 0.3, note: "Hood dented" }, { key: "b", diagram: "truck", x: 0.4, y: 0.4, note: "Grille cracked" }] }) });
      const marks = (await q(`SELECT id FROM damage_marks WHERE incident_id = $1 ORDER BY seq`, [filed.json().id])).map((r) => r.id);
      const ticket = (body: Record<string, unknown>) => inject("POST", "/repair-tickets", { cookie: shop, body: { client_id: randomUUID(), vehicle_id: truck, ...body } });

      assert.equal((await ticket({ item_ids: [], damage_ids: [] })).statusCode, 400, "something has to be picked");
      const other = (await one(`SELECT id FROM vehicles WHERE truck_code <> 'T018' AND active LIMIT 1`)).id;
      const wrongTruck = await inject("POST", "/repair-tickets", { cookie: shop, body: { client_id: randomUUID(), vehicle_id: other, damage_ids: [marks[0]] } });
      assert.equal(wrongTruck.statusCode, 422);
      assert.equal(wrongTruck.json().details.code, "bad_damage");
      assert.equal((await ticket({ damage_ids: [markIds[0]] })).statusCode, 422, "already repaired");

      // Only the picked piece goes on it.
      const made = await ticket({ damage_ids: [marks[1]], sent_to: "Body shop" });
      assert.equal(made.statusCode, 201, made.body);
      const t = (await loadTicket(made.json().id))!;
      assert.deepEqual(t.items.map((i) => [i.kind, i.id, i.position, i.label]), [["damage", marks[1], 1, "Damage"]]);
      assert.equal(t.items[0].incident_id, filed.json().id);
      const html = await ticketPdfHtml(t);
      assert.ok(html.includes("Incident damage") && html.includes("Grille cracked") && !html.includes("Hood dented"));
      const pills = (await inject("GET", "/incident-repairs", { cookie: sup })).json();
      assert.deepEqual(pills.find((m: { id: number }) => m.id === marks[1]).ticket_ids, [made.json().id]);
      assert.deepEqual(pills.find((m: { id: number }) => m.id === marks[0]).ticket_ids, []);
      const onTruck = (await inject("GET", `/vehicles/${truck}`, { cookie: sup })).json().damage.find((m: { id: number }) => m.id === marks[1]);
      assert.deepEqual(onTruck.ticket_ids, [made.json().id]);

      const listed = async () => (await inject("GET", `/vehicles/${truck}/repair-tickets`, { cookie: sup })).json().find((x: { id: number }) => x.id === made.json().id);
      assert.deepEqual([(await listed()).items, (await listed()).fixed], [1, 0]);
      const photo = await uploadPhoto(sup);
      await inject("POST", `/damage-marks/${marks[1]}/repair`, { cookie: sup, body: { client_id: randomUUID(), note: "New grille", photo_ids: [photo] } });
      assert.deepEqual([(await listed()).items, (await listed()).fixed], [1, 1]);
      assert.ok((await loadTicket(made.json().id))!.items[0].resolved_at);
      await assert.rejects(q(`DELETE FROM repair_ticket_damage WHERE ticket_id = $1`, [made.json().id]), /can't be deleted/);
      await inject("POST", `/incidents/${filed.json().id}/archive`, { cookie: sup, body: {} });
    });

    test("the PDF downloads (Chromium)", { timeout: 120_000 }, async () => {
      const res = await inject("GET", `/incidents/${id}/pdf`, { cookie: sup });
      assert.equal(res.statusCode, 200, res.body.slice(0, 300));
      assert.equal(res.headers["content-type"], "application/pdf");
      assert.ok(res.rawPayload.subarray(0, 5).toString() === "%PDF-");
      assert.equal((await inject("GET", `/incidents/${id}/pdf`, { cookie: crew })).statusCode, 403);
    });
  });
}
