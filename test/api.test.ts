// End-to-end API tests against a real Postgres.
// Needs TEST_DATABASE_URL pointing at an empty, disposable database, e.g.
//   TEST_DATABASE_URL=postgres://gc:gcdev@localhost:54329/gc_test npm test
// The test drops and recreates the public schema, so never point it at real data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test("api tests", { skip: "set TEST_DATABASE_URL to run" }, () => {});
} else {
  process.env.DATABASE_URL = url;
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "gc-uploads-"));
  process.env.ADMIN_EMAIL = "admin@test.local";
  process.env.ADMIN_PASSWORD = "admin-password-1";
  process.env.LOG_LEVEL = "silent";
  // A fake fleet just for the tests (the API tests pick some trucks by position, so keep its order).
  process.env.SEED_VEHICLES_CSV = "test/fixtures/vehicles.csv";

  const { pool, q, one } = await import("../src/db.ts");
  const { migrate } = await import("../src/migrate.ts");
  const { ensureAdmin, seedVehicles } = await import("../src/seed.ts");
  const { buildApp } = await import("../src/server.ts");
  const { hashSecret } = await import("../src/auth.ts");
  const { config } = await import("../src/config.ts");
  const { closePdfBrowser } = await import("../src/pdf.ts");
  const { cleanupOrphanPhotos } = await import("../src/routes/photos.ts");
  const { loadInspection } = await import("../src/routes/inspections.ts");
  const { inspectionPdfHtml } = await import("../src/pdf.ts");
  const pdfHtmlFor = async (inspectionId: string) => inspectionPdfHtml((await loadInspection(inspectionId))!);
  const { fmtDate: pdfDate } = await import("../src/pdf.ts");

  test("PDF dates: plain dates as-is, timestamps in the server's time zone (not UTC)", () => {
    assert.equal(pdfDate("2026-11-10"), "11/10/2026");
    const evening = new Date(2026, 10, 10, 21, 30); // 9:30pm local on Nov 10, which is already Nov 11 in UTC
    assert.equal(pdfDate(evening), "11/10/2026");
    assert.equal(pdfDate(null), "");
  });

  // 1x1 PNG and a tiny JPEG header are enough for the type sniffing.
  const PNG = "data:image/png;base64," + Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 1),
  ]).toString("base64");
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]);

  let app: Awaited<ReturnType<typeof buildApp>>;
  let crewCookie = "";
  let supCookie = "";
  let vehicleId = 0;
  let checklist: { id: number; section: string }[] = [];

  const H = { "x-gc-app": "1" };
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0];

  async function inject(method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    return app.inject({
      method: method as "GET",
      url: "/api" + path,
      headers: { ...H, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function submitBody(over: Record<string, unknown> = {}): Record<string, any> {
    const items = checklist.filter((c) => c.section !== "trailer").map((c) => ({ checklist_item_id: c.id, result: "ok" }));
    return {
      client_id: randomUUID(),
      vehicle_id: vehicleId,
      inspection_date: "2026-11-10",
      inspector_name: "Casey Crew",
      mileage: 48210,
      oil_change_due: false,
      existing_notes: "Scratch on tailgate",
      new_observations: null,
      comments: "All good",
      trailer: null,
      items,
      damage: [{ key: "a1", diagram: "truck", x: 0.25, y: 0.5, note: "Dent, rear quarter" }],
      photos: [],
      signature: PNG,
      ...over,
    };
  }

  /** Multipart POST: text fields first, then the file (the order the server reads them in). */
  async function postFile(cookie: string, path: string, fields: Record<string, string>, file: Buffer, filename = "a.jpg") {
    const boundary = "----gc" + randomUUID();
    const parts = Object.entries(fields).map(([k, v]) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    const body = Buffer.concat([
      ...parts,
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: "POST", url: "/api" + path, payload: body,
      headers: { ...H, cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    });
  }

  async function uploadPhoto(cookie: string, id = randomUUID()) {
    const boundary = "----gc" + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${id}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      JPEG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST", url: "/api/photos", payload: body,
      headers: { ...H, cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    return { res, id };
  }

  before(async () => {
    await q("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(() => {});
    await ensureAdmin(() => {});
    await seedVehicles(() => {});
    await q(`INSERT INTO users (name, role, pin_hash) VALUES ('Casey Crew', 'crew', $1)`, [await hashSecret("1234")]);
    await q(`INSERT INTO users (name, role, email, password_hash) VALUES ('Sam Super', 'supervisor', 'sup@test.local', $1)`,
      [await hashSecret("super-password-1")]);
    app = await buildApp({ logger: false });
    const v = await one(`SELECT id FROM vehicles WHERE truck_code = 'T018'`);
    vehicleId = v.id;
    checklist = await q(`SELECT id, section FROM checklist_items WHERE active ORDER BY section, sort_order`);
  });

  after(async () => {
    await app?.close();
    await closePdfBrowser();
    await pool.end();
  });

  describe("auth", () => {
    test("crew list shows PIN users only", async () => {
      const res = await inject("GET", "/auth/crew");
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().map((u: { name: string }) => u.name), ["Casey Crew"]);
    });

    test("wrong PIN is refused, right PIN signs in", async () => {
      const crew = await one(`SELECT id FROM users WHERE name = 'Casey Crew'`);
      const bad = await inject("POST", "/auth/pin", { body: { user_id: crew.id, pin: "9999" } });
      assert.equal(bad.statusCode, 401);
      const ok = await inject("POST", "/auth/pin", { body: { user_id: crew.id, pin: "1234" } });
      assert.equal(ok.statusCode, 200);
      crewCookie = cookieOf(ok);
      const me = await inject("GET", "/me", { cookie: crewCookie });
      assert.equal(me.json().role, "crew");
    });

    test("supervisor signs in with email and password", async () => {
      const ok = await inject("POST", "/auth/login", { body: { email: "SUP@test.local", password: "super-password-1" } });
      assert.equal(ok.statusCode, 200);
      supCookie = cookieOf(ok);
    });

    test("five wrong PINs lock the account", async () => {
      await q(`INSERT INTO users (name, role, pin_hash) VALUES ('Lock Me', 'crew', $1)`, [await hashSecret("4321")]);
      const u = await one(`SELECT id FROM users WHERE name = 'Lock Me'`);
      for (let i = 0; i < 5; i++) await inject("POST", "/auth/pin", { body: { user_id: u.id, pin: "0000" } });
      const res = await inject("POST", "/auth/pin", { body: { user_id: u.id, pin: "4321" } });
      assert.equal(res.statusCode, 429);
    });

    test("API refuses writes without the app header (CSRF guard)", async () => {
      const res = await app.inject({ method: "POST", url: "/api/inspections", headers: { cookie: crewCookie }, payload: {} });
      assert.equal(res.statusCode, 403);
    });

    test("signed-out requests get 401", async () => {
      assert.equal((await inject("GET", "/vehicles")).statusCode, 401);
    });
  });

  describe("vehicles", () => {
    test("seeded fleet and diagrams", async () => {
      const res = await inject("GET", "/vehicles", { cookie: crewCookie });
      const list = res.json();
      assert.equal(list.length, 27, "the trucks in test/fixtures/vehicles.csv");
      const t018 = list.find((v: { truck_code: string }) => v.truck_code === "T018");
      assert.equal(t018.diagram_url, "/diagrams/pickup.jpg");
      const t053 = list.find((v: { truck_code: string }) => v.truck_code === "T053");
      assert.equal(t053.diagram_url, "/diagrams/dump-truck.jpg");
      assert.equal(t053.pulls_trailer, false);
    });

    test("form config has 16 + 16 + 17 checklist items", async () => {
      const cfg = (await inject("GET", "/form-config", { cookie: crewCookie })).json();
      const count = (s: string) => cfg.checklist.filter((c: { section: string }) => c.section === s).length;
      assert.deepEqual([count("exterior"), count("interior"), count("trailer")], [16, 16, 17]);
      assert.equal(cfg.trailer_diagram_url, "/diagrams/trailer.jpg");
    });
  });

  describe("inspections", () => {
    let firstId = "";

    test("submit with a photo on a damage pin and a repair item", async () => {
      const { res: up, id: photoId } = await uploadPhoto(crewCookie);
      assert.equal(up.statusCode, 201);
      const again = await uploadPhoto(crewCookie, photoId);
      assert.equal(again.res.statusCode, 200, "re-uploading the same photo id is a no-op");

      const body = submitBody();
      const repairId = checklist[3].id;
      body.items = (body.items as { checklist_item_id: number; result: string; note?: string }[]).map((i) =>
        i.checklist_item_id === repairId ? { ...i, result: "repair", note: "Left tail light out" } : i);
      body.photos = [{ id: photoId, caption: "Dent", damage_key: "a1" }];
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body });
      assert.equal(res.statusCode, 201, res.body);
      firstId = res.json().id;

      const detail = (await inject("GET", `/inspections/${firstId}`, { cookie: crewCookie })).json();
      assert.equal(detail.items.length, 32);
      assert.equal(detail.items.filter((i: { result: string }) => i.result === "repair").length, 1);
      assert.equal(detail.damage[0].seq, 1);
      assert.equal(detail.photos[0].damage_mark_id, detail.damage[0].id);
      assert.equal(detail.status, "submitted");
    });

    test("retrying the same client_id returns the same record", async () => {
      const body = submitBody({ mileage: 48300 });
      const a = await inject("POST", "/inspections", { cookie: crewCookie, body });
      const b = await inject("POST", "/inspections", { cookie: crewCookie, body });
      assert.equal(a.statusCode, 201);
      assert.equal(b.statusCode, 200);
      assert.equal(a.json().id, b.json().id);
      assert.equal(b.json().duplicate, true);
    });

    test("a double tap (two submits at once) creates one record", async () => {
      const body = submitBody({ mileage: 48400 });
      const [a, b] = await Promise.all([
        inject("POST", "/inspections", { cookie: crewCookie, body }),
        inject("POST", "/inspections", { cookie: crewCookie, body }),
      ]);
      assert.equal(a.json().id, b.json().id);
      const n = await one(`SELECT count(*)::int AS n FROM inspections WHERE client_id = $1`, [body.client_id]);
      assert.equal(n.n, 1);
    });

    test("unanswered checklist items are refused with the list", async () => {
      const body = submitBody();
      body.items = (body.items as unknown[]).slice(2);
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().details.missing.length, 2);
    });

    test("trailer on means the 17 trailer items are required too", async () => {
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body: submitBody({ trailer: { number: "T-12", plate: "ABC123" } }) });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().details.missing.length, 17);
    });

    test("a Repair without a note is refused", async () => {
      const body = submitBody();
      (body.items as { result: string }[])[0].result = "repair";
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body });
      assert.equal(res.statusCode, 422);
    });

    test("signature is required", async () => {
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body: submitBody({ signature: null }) });
      assert.equal(res.statusCode, 400);
    });

    test("photos that were never uploaded are reported", async () => {
      const res = await inject("POST", "/inspections", {
        cookie: crewCookie, body: submitBody({ photos: [{ id: randomUUID() }] }),
      });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().details.code, "photos_missing");
    });

    test("lower mileage is allowed but flagged", async () => {
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body: submitBody({ mileage: 1000 }) });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().mileage_flagged, true);
    });

    test("last inspection feeds the next form (notes and grey pins)", async () => {
      const last = (await inject("GET", `/vehicles/${vehicleId}/last`, { cookie: crewCookie })).json();
      assert.equal(last.inspection.existing_notes, "Scratch on tailgate");
      assert.ok(last.damage.length >= 1);
      assert.equal(last.damage[0].diagram, "truck");
    });

    test("grey pins are all damage on file from every earlier inspection, not just the last one", async () => {
      const truck = await one(`SELECT id FROM vehicles WHERE truck_code = 'T002'`);
      const submit = async (date: string, damage: unknown[], photos: unknown[] = []) => {
        const res = await inject("POST", "/inspections", {
          cookie: crewCookie, body: submitBody({ vehicle_id: truck.id, inspection_date: date, mileage: 30000, damage, photos }),
        });
        assert.equal(res.statusCode, 201, res.body);
        return res.json().id as string;
      };
      const { id: photoId } = await uploadPhoto(crewCookie);
      const first = await submit("2026-09-01",
        [{ key: "d1", diagram: "truck", x: 0.1, y: 0.2, note: "Cracked bumper" }],
        [{ id: photoId, caption: "Bumper", damage_key: "d1" }]);
      const second = await submit("2026-10-01", [{ key: "d2", diagram: "truck", x: 0.6, y: 0.7, note: "Door ding" }]);
      await submit("2026-11-01", []); // the latest inspection marked nothing new

      const last = (await inject("GET", `/vehicles/${truck.id}/last`, { cookie: crewCookie })).json();
      assert.deepEqual(
        last.damage.map((m: { n: number; note: string; inspection_id: string; inspection_date: string }) =>
          [m.n, m.note, m.inspection_id, m.inspection_date]),
        [[1, "Cracked bumper", first, "2026-09-01"], [2, "Door ding", second, "2026-10-01"]],
        "both earlier marks, numbered oldest first, even though the last inspection had none",
      );

      const page = (await inject("GET", `/vehicles/${truck.id}`, { cookie: crewCookie })).json();
      assert.equal(page.damage.length, 2);
      assert.equal(page.damage[0].on_current_diagram, true);
      assert.deepEqual(page.damage[0].photos.map((p: { id: string }) => p.id), [photoId]);
      assert.deepEqual(page.damage[1].photos, []);
    });

    test("crew can't sign off; supervisor can, once", async () => {
      const crew = await inject("POST", `/inspections/${firstId}/review`, { cookie: crewCookie, body: { signature: PNG } });
      assert.equal(crew.statusCode, 403);
      const sup = await inject("POST", `/inspections/${firstId}/review`, { cookie: supCookie, body: { signature: PNG, note: "Odometer checked" } });
      assert.equal(sup.statusCode, 200, sup.body);
      const again = await inject("POST", `/inspections/${firstId}/review`, { cookie: supCookie, body: { signature: PNG } });
      assert.equal(again.statusCode, 409);
      const d = (await inject("GET", `/inspections/${firstId}`, { cookie: crewCookie })).json();
      assert.equal(d.status, "reviewed");
      assert.equal(d.supervisor.name, "Sam Super");
      assert.equal(d.supervisor.note, "Odometer checked");
    });

    test("supervisor resolves a repair; it leaves the open list", async () => {
      const before = (await inject("GET", `/vehicles/${vehicleId}`, { cookie: crewCookie })).json();
      const open = before.openRepairs.length;
      assert.ok(open >= 1);
      const item = before.openRepairs[0];
      assert.equal((await inject("POST", `/inspection-items/${item.id}/resolve`, { cookie: crewCookie, body: { note: "x" } })).statusCode, 403);
      const r = await inject("POST", `/inspection-items/${item.id}/resolve`, { cookie: supCookie, body: { note: "Replaced bulb" } });
      assert.equal(r.statusCode, 200);
      const afterRes = (await inject("GET", `/vehicles/${vehicleId}`, { cookie: crewCookie })).json();
      assert.equal(afterRes.openRepairs.length, open - 1);
    });

    test("submitted inspections are read-only in the database", async () => {
      await assert.rejects(q(`UPDATE inspections SET mileage = 1 WHERE id = $1`, [firstId]), /read-only/);
      await assert.rejects(q(`UPDATE inspection_items SET result = 'ok' WHERE inspection_id = $1`, [firstId]), /read-only/);
      await assert.rejects(q(`UPDATE damage_marks SET note = 'x' WHERE inspection_id = $1`, [firstId]), /read-only/);
    });

    test("PDF export (supervisor only)", { timeout: 60000 }, async () => {
      assert.equal((await inject("GET", `/inspections/${firstId}/pdf`, { cookie: crewCookie })).statusCode, 403);
      const res = await inject("GET", `/inspections/${firstId}/pdf`, { cookie: supCookie });
      assert.equal(res.statusCode, 200, res.body.slice(0, 200));
      assert.equal(res.headers["content-type"], "application/pdf");
      assert.match(String(res.headers["content-disposition"]), /T018_2026-11-10_inspection\.pdf/);
      assert.equal(res.rawPayload.subarray(0, 4).toString(), "%PDF");
    });

    test("the list filters by inspection date for the export screen", async () => {
      const ids: string[] = [];
      for (const d of ["2026-10-15", "2026-10-31"]) {
        const res = await inject("POST", "/inspections", { cookie: crewCookie, body: submitBody({ inspection_date: d }) });
        assert.equal(res.statusCode, 201, res.body);
        ids.push(res.json().id);
      }
      const list = async (qs: string) => {
        const res = await inject("GET", `/inspections?limit=200&${qs}`, { cookie: supCookie });
        assert.equal(res.statusCode, 200, res.body);
        return res.json() as { id: string; inspection_date: string }[];
      };
      const oct = await list(`from=2026-10-01&to=2026-10-31&vehicle_id=${vehicleId}`);
      assert.deepEqual(oct.map((r) => r.id).sort(), [...ids].sort(), "both ends of the range are included");
      assert.deepEqual((await list("from=2026-10-20")).filter((r) => ids.includes(r.id)).map((r) => r.id), [ids[1]]);
      assert.deepEqual((await list(`to=2026-10-20&vehicle_id=${vehicleId}`)).map((r) => r.id), [ids[0]]);
      assert.equal((await inject("GET", "/inspections?from=2026-13-01", { cookie: supCookie })).statusCode, 400);
      assert.equal((await inject("GET", "/inspections?to=yesterday", { cookie: supCookie })).statusCode, 400);
    });
  });

  describe("admin", () => {
    let adminCookie = "";
    before(async () => {
      const login = await inject("POST", "/auth/login", { body: { email: "admin@test.local", password: "admin-password-1" } });
      adminCookie = cookieOf(login);
    });

    test("only admins reach admin routes", async () => {
      assert.equal((await inject("GET", "/admin/users", { cookie: supCookie })).statusCode, 403);
    });

    test("admin sets a truck's trailer type and diagram; old inspections keep the pictures they were drawn on", async () => {
      const trl = await postFile(adminCookie, "/admin/diagrams", { kind: "trailer", name: "16 ft dump trailer" }, JPEG);
      assert.equal(trl.statusCode, 201, trl.body);
      const body = await postFile(adminCookie, "/admin/diagrams", { kind: "truck", name: "Test body" }, JPEG);
      const trailerId = trl.json().id;
      const truckDiaId = body.json().id;
      const old = await one(`SELECT id, truck_diagram_id FROM inspections WHERE vehicle_id = $1 ORDER BY created_at LIMIT 1`, [vehicleId]);
      assert.ok(old.truck_diagram_id, "submit records the truck diagram");

      // A truck diagram can't be used as a trailer type.
      const wrong = await inject("PATCH", `/admin/vehicles/${vehicleId}`, { cookie: adminCookie, body: { trailer_diagram_id: truckDiaId } });
      assert.equal(wrong.statusCode, 400);

      const res = await inject("PATCH", `/admin/vehicles/${vehicleId}`, {
        cookie: adminCookie, body: { trailer_diagram_id: trailerId, diagram_id: truckDiaId, plate: "NEW123" },
      });
      assert.equal(res.statusCode, 200, res.body);
      const v = (await inject("GET", `/vehicles/${vehicleId}`, { cookie: crewCookie })).json().vehicle;
      assert.equal(v.pulls_trailer, true);
      assert.equal(v.trailer_type, "16 ft dump trailer");
      assert.equal(v.trailer_diagram_url, `/api/diagrams/${trailerId}/image`);
      assert.equal(v.diagram_url, `/api/diagrams/${truckDiaId}/image`);
      assert.equal(v.plate, "NEW123");

      const oldDetail = (await inject("GET", `/inspections/${old.id}`, { cookie: crewCookie })).json();
      assert.equal(oldDetail.truck_diagram_url, "/diagrams/pickup.jpg", "old pins stay on the old picture");
      const last = (await inject("GET", `/vehicles/${vehicleId}/last`, { cookie: crewCookie })).json();
      assert.equal(last.damage.length, 0, "grey pins from a different picture are not shown");
      const page = (await inject("GET", `/vehicles/${vehicleId}`, { cookie: crewCookie })).json();
      assert.ok(page.damage.length > 0, "the truck page still lists them");
      assert.ok(page.damage.every((m: { on_current_diagram: boolean }) => !m.on_current_diagram));

      // A new inspection with the trailer records the trailer type.
      const sub = submitBody({
        trailer: { number: "T-7", plate: "TRL7" },
        truck_diagram_id: truckDiaId,
        trailer_diagram_id: trailerId,
        items: checklist.map((c) => ({ checklist_item_id: c.id, result: "ok" })),
        damage: [{ key: "t1", diagram: "trailer", x: 0.5, y: 0.5, note: "Bent fender" }],
        mileage: 60000,
      });
      const ins = await inject("POST", "/inspections", { cookie: crewCookie, body: sub });
      assert.equal(ins.statusCode, 201, ins.body);
      const d = (await inject("GET", `/inspections/${ins.json().id}`, { cookie: crewCookie })).json();
      assert.equal(d.trailer.type, "16 ft dump trailer");
      assert.equal(d.trailer_diagram_url, `/api/diagrams/${trailerId}/image`);
      assert.equal(d.truck_diagram_url, `/api/diagrams/${truckDiaId}/image`);

      const none = await inject("PATCH", `/admin/vehicles/${vehicleId}`, { cookie: adminCookie, body: { trailer_diagram_id: "" } });
      assert.equal(none.json().pulls_trailer, false);
      assert.equal(none.json().trailer_type, null);
    });

    test("branding: anyone can read it, only admins change it", async () => {
      const def = (await inject("GET", "/branding")).json();
      assert.equal(def.company_name, "Your Company");
      assert.equal(def.logo_url, null);

      const notAdmin = await inject("PUT", "/admin/branding", { cookie: supCookie, body: { company_name: "X" } });
      assert.equal(notAdmin.statusCode, 403);
      const badColor = await inject("PUT", "/admin/branding", { cookie: adminCookie, body: { color: "green" } });
      assert.equal(badColor.statusCode, 400);
      const ok = await inject("PUT", "/admin/branding", {
        cookie: adminCookie, body: { company_name: "Acme Landscaping", app_name: "Truck Checks", color: "#1F5F8B" },
      });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.deepEqual(ok.json(), { company_name: "Acme Landscaping", app_name: "Truck Checks", color: "#1f5f8b", logo_url: null });
    });

    test("branding: logo upload, serve, PDF and remove", { timeout: 60000 }, async () => {
      const notImage = await postFile(adminCookie, "/admin/branding/logo", {}, Buffer.from("not an image at all"), "logo.svg");
      assert.equal(notImage.statusCode, 400);
      const png = Buffer.from(PNG.split(",")[1], "base64");
      const up = await postFile(adminCookie, "/admin/branding/logo", {}, png, "logo.png");
      assert.equal(up.statusCode, 200, up.body);
      const logoUrl: string = up.json().logo_url;
      assert.match(logoUrl, /^\/api\/branding\/logo\?v=[0-9a-f]{8}$/);
      assert.equal(up.json().company_name, "Acme Landscaping", "other settings are kept");

      const img = await app.inject({ method: "GET", url: logoUrl });
      assert.equal(img.statusCode, 200);
      assert.equal(img.headers["content-type"], "image/png");
      assert.match(String(img.headers["cache-control"]), /immutable/);

      const insp = await one(`SELECT id FROM inspections ORDER BY created_at LIMIT 1`);
      const pdf = await inject("GET", `/inspections/${insp.id}/pdf`, { cookie: supCookie });
      assert.equal(pdf.statusCode, 200, pdf.body.slice(0, 200));

      const del = await inject("DELETE", "/admin/branding/logo", { cookie: adminCookie });
      assert.equal(del.json().logo_url, null);
      assert.equal((await app.inject({ method: "GET", url: "/api/branding/logo" })).statusCode, 404);
    });

    test("admin can give someone the shop role", async () => {
      const add = await inject("POST", "/admin/users", { cookie: adminCookie, body: { name: "Shop Test", role: "shop", pin: "2468" } });
      assert.equal(add.statusCode, 201, add.body);
    });

    test("admin adds a crew user who can then sign in", async () => {
      const add = await inject("POST", "/admin/users", { cookie: adminCookie, body: { name: "New Crew", role: "crew", pin: "5555" } });
      assert.equal(add.statusCode, 201, add.body);
      const signin = await inject("POST", "/auth/pin", { body: { user_id: add.json().id, pin: "5555" } });
      assert.equal(signin.statusCode, 200);
      const bad = await inject("POST", "/admin/users", { cookie: adminCookie, body: { name: "x", role: "crew", pin: "12" } });
      assert.equal(bad.statusCode, 400);
    });
  });

  describe("maintenance log", () => {
    let shopCookie = "";
    let repairIds: number[] = [];
    let entryId = 0;
    let otherTruck = 0;

    function entryBody(over: Record<string, unknown> = {}) {
      return {
        client_id: randomUUID(),
        vehicle_id: vehicleId,
        service_date: "2026-11-10",
        mileage: 61000,
        category: "repair",
        description: "Replaced left tail light and brake light bulbs",
        parts: "2x 3157 bulbs",
        cost: "$18.40",
        performed_by: "Robin",
        ...over,
      };
    }

    before(async () => {
      await q(`INSERT INTO users (name, role, pin_hash) VALUES ('Robin Shop', 'shop', $1)`, [await hashSecret("1357")]);
      const u = await one(`SELECT id FROM users WHERE name = 'Robin Shop'`);
      shopCookie = cookieOf(await inject("POST", "/auth/pin", { body: { user_id: u.id, pin: "1357" } }));
      otherTruck = (await one(`SELECT id FROM vehicles WHERE truck_code = 'T053'`)).id;
      // A fresh inspection on T018 with two open repairs for the shop to fix.
      const body = submitBody({ mileage: 60500 });
      const [a, b] = [checklist[1].id, checklist[2].id];
      body.items = (body.items as { checklist_item_id: number; result: string; note?: string }[]).map((i) =>
        i.checklist_item_id === a || i.checklist_item_id === b ? { ...i, result: "repair", note: "Bulb out" } : i);
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body });
      assert.equal(res.statusCode, 201, res.body);
      repairIds = (await q(`SELECT id FROM inspection_items WHERE inspection_id = $1 AND result = 'repair' ORDER BY id`, [res.json().id]))
        .map((r) => r.id);
      assert.equal(repairIds.length, 2);
    });

    test("who can see and write the log", async () => {
      assert.equal((await inject("GET", `/vehicles/${vehicleId}/service`, { cookie: crewCookie })).statusCode, 403);
      assert.equal((await inject("GET", `/vehicles/${vehicleId}/service`, { cookie: supCookie })).statusCode, 200);
      assert.equal((await inject("POST", "/service-logs", { cookie: supCookie, body: entryBody() })).statusCode, 403);
      assert.equal((await inject("POST", "/service-logs", { cookie: crewCookie, body: entryBody() })).statusCode, 403);
    });

    test("shop logs work that fixes a repair, with a receipt photo; a retry doesn't duplicate it", async () => {
      const { res: up, id: photoId } = await uploadPhoto(shopCookie);
      assert.equal(up.statusCode, 201);
      const body = entryBody({ repair_item_ids: [repairIds[0]], photos: [{ id: photoId, caption: "Receipt" }] });
      const a = await inject("POST", "/service-logs", { cookie: shopCookie, body });
      assert.equal(a.statusCode, 201, a.body);
      const b = await inject("POST", "/service-logs", { cookie: shopCookie, body });
      assert.equal(b.statusCode, 200);
      assert.equal(b.json().id, a.json().id);
      entryId = a.json().id;

      const e = (await inject("GET", `/service-logs/${entryId}`, { cookie: supCookie })).json();
      assert.equal(e.cost, 18.4);
      assert.equal(e.category_label, "Repair");
      assert.equal(e.repairs.length, 1);
      assert.equal(e.photos[0].caption, "Receipt");
      const item = await one(`SELECT resolved_at, resolution_note FROM inspection_items WHERE id = $1`, [repairIds[0]]);
      assert.ok(item.resolved_at, "the repair is closed");
      assert.match(item.resolution_note, /maintenance log/);
      const v = (await inject("GET", `/vehicles/${vehicleId}`, { cookie: crewCookie })).json();
      assert.ok(!v.openRepairs.some((r: { id: number }) => r.id === repairIds[0]));
    });

    test("the inspection shows the repair as fixed, with a link to the entry", async () => {
      const { inspection_id: inspId } = await one(`SELECT inspection_id FROM inspection_items WHERE id = $1`, [repairIds[0]]);
      const d = (await inject("GET", `/inspections/${inspId}`, { cookie: crewCookie })).json();
      assert.equal(d.items.find((x: { id: number }) => x.id === repairIds[0]).service_log_id, entryId);
      assert.equal(d.items.find((x: { id: number }) => x.id === repairIds[1]).service_log_id, null);
      const row = (await inject("GET", `/vehicles/${vehicleId}`, { cookie: crewCookie })).json().history
        .find((x: { id: string }) => x.id === inspId);
      assert.equal(row.repair_count, 2);
      assert.equal(row.open_repair_count, 1);
      const recent = (await inject("GET", "/inspections?limit=50", { cookie: crewCookie })).json().find((x: { id: string }) => x.id === inspId);
      assert.equal(recent.open_repair_count, 1);
      const cfg = (await inject("GET", "/service-config", { cookie: shopCookie })).json();
      const tires = cfg.categories.find((c: { id: string }) => c.id === "tires");
      assert.ok(new RegExp(tires.auto.match, "i").test("Tires properly inflated"));
      const brakes = cfg.categories.find((c: { id: string }) => c.id === "brakes").auto;
      assert.ok(new RegExp(brakes.not, "i").test("Brake lights working"), "brake lights aren't brake work");
    });

    test("the inspection PDF includes the maintenance entry that fixed a repair", { timeout: 60000 }, async () => {
      const { inspection_id: inspId } = await one(`SELECT inspection_id FROM inspection_items WHERE id = $1`, [repairIds[0]]);
      const html = await pdfHtmlFor(inspId);
      assert.match(html, /Repairs fixed — maintenance log/);
      assert.match(html, /Maintenance entry 1 · Repair/);
      assert.match(html, /Replaced left tail light and brake light bulbs/);
      assert.match(html, /\$18\.40/);
      assert.match(html, /2x 3157 bulbs/);
      assert.match(html, /Fixed [\d/]+ \(maintenance entry 1\)/, "the checklist line points at the entry");
      assert.match(html, /Maintenance entry 1 — Receipt/, "the entry's photo is on the photo pages");
      const pdf = await inject("GET", `/inspections/${inspId}/pdf`, { cookie: supCookie });
      assert.equal(pdf.statusCode, 200);
      assert.equal(pdf.rawPayload.subarray(0, 4).toString(), "%PDF");
    });

    test("bad input is refused", async () => {
      const noWork = await inject("POST", "/service-logs", { cookie: shopCookie, body: entryBody({ description: " " }) });
      assert.equal(noWork.statusCode, 400);
      const badType = await inject("POST", "/service-logs", { cookie: shopCookie, body: entryBody({ category: "paint" }) });
      assert.equal(badType.statusCode, 400);
      const badCost = await inject("POST", "/service-logs", { cookie: shopCookie, body: entryBody({ cost: "lots" }) });
      assert.equal(badCost.statusCode, 400);
      const wrongTruck = await inject("POST", "/service-logs", {
        cookie: shopCookie, body: entryBody({ vehicle_id: otherTruck, repair_item_ids: [repairIds[1]] }),
      });
      assert.equal(wrongTruck.statusCode, 422);
      assert.equal(wrongTruck.json().details.code, "bad_repairs");
    });

    test("edits keep history; a stale edit is refused", async () => {
      const e = (await inject("GET", `/service-logs/${entryId}`, { cookie: shopCookie })).json();
      const ok = await inject("PATCH", `/service-logs/${entryId}`, {
        cookie: shopCookie, body: { version: e.version, cost: "21.90", repair_item_ids: [repairIds[1]] },
      });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json().cost, 21.9);
      assert.equal(ok.json().repairs.length, 2);
      assert.deepEqual(ok.json().history[0].changes, [{ field: "cost", from: 18.4, to: 21.9 }]);
      const stale = await inject("PATCH", `/service-logs/${entryId}`, { cookie: shopCookie, body: { version: e.version, cost: "1" } });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().details.code, "stale");
    });

    test("next due shows on the truck", async () => {
      const r = await inject("POST", "/service-logs", {
        cookie: shopCookie,
        body: entryBody({ category: "oil_change", description: "Oil and filter", next_due_mileage: 61200, next_due_date: "2027-05-10" }),
      });
      assert.equal(r.statusCode, 201, r.body);
      const s = (await inject("GET", `/vehicles/${vehicleId}/service`, { cookie: shopCookie })).json();
      const oil = s.next_due.find((d: { category: string }) => d.category === "oil_change");
      assert.equal(oil.mileage, 61200);
      assert.equal(oil.state, "soon", "within 500 miles of the due mileage");
      assert.ok(s.entries.length >= 2);
    });

    test("one entry can have several types of work, each with its own next-due", async () => {
      const truck = (await one(`SELECT id FROM vehicles WHERE truck_code NOT IN ('T018', 'T002') ORDER BY id OFFSET 2 LIMIT 1`)).id;
      const body = (work: unknown, over: Record<string, unknown> = {}) => ({
        client_id: randomUUID(), vehicle_id: truck, service_date: "2026-11-10", mileage: 30000,
        description: "Oil, filter and four new tires", work, ...over,
      });
      for (const [bad, why] of [
        [[], "none picked"],
        [[{ type: "oil_change" }, { type: "oil_change" }], "picked twice"],
        [[{ type: "paint" }], "unknown type"],
        [[{ type: "tires", next_due_mileage: "soon" }], "next due mileage not a number"],
        [[{ type: "tires", next_due_date: "2027-02-30" }], "next due date not a date"],
      ] as const) {
        assert.equal((await inject("POST", "/service-logs", { cookie: shopCookie, body: body(bad) })).statusCode, 400, why);
      }

      const res = await inject("POST", "/service-logs", {
        cookie: shopCookie,
        body: body([{ type: "oil_change", next_due_mileage: 35000 }, { type: "tires", next_due_date: "2028-11-10" }]),
      });
      assert.equal(res.statusCode, 201, res.body);
      const id = res.json().id;
      const e = (await inject("GET", `/service-logs/${id}`, { cookie: shopCookie })).json();
      assert.deepEqual(e.work.map((w: { type: string; label: string }) => [w.type, w.label]), [["oil_change", "Oil change"], ["tires", "Tires"]]);
      assert.equal(e.category_label, "Oil change, Tires");
      assert.equal(e.category, "oil_change", "the old single-type field mirrors the first type");
      assert.equal(e.next_due_mileage, 35000);

      const s = (await inject("GET", `/vehicles/${truck}/service`, { cookie: shopCookie })).json();
      const due = Object.fromEntries(s.next_due.map((d: { category: string; mileage: number | null; date: string | null; entry_id: number }) =>
        [d.category, [d.mileage, d.date, d.entry_id]]));
      assert.deepEqual(due, { oil_change: [35000, null, id], tires: [null, "2028-11-10", id] });
      assert.equal(s.entries.find((x: { id: number }) => x.id === id).category_label, "Oil change, Tires");

      // A newer oil change without a next-due replaces the old oil due date; tires keep theirs.
      const later = await inject("POST", "/service-logs", {
        cookie: shopCookie, body: body([{ type: "oil_change" }], { service_date: "2026-11-11", description: "Oil top-off" }),
      });
      assert.equal(later.statusCode, 201, later.body);
      const s2 = (await inject("GET", `/vehicles/${truck}/service`, { cookie: shopCookie })).json();
      assert.deepEqual(s2.next_due.map((d: { category: string }) => d.category), ["tires"]);

      // Editing the types is recorded in the history, readably.
      const edit = await inject("PATCH", `/service-logs/${id}`, {
        cookie: shopCookie,
        body: { version: e.version, work: [{ type: "oil_change", next_due_mileage: 35000 }, { type: "tires", next_due_date: "2028-11-10" }, { type: "brakes" }] },
      });
      assert.equal(edit.statusCode, 200, edit.body);
      assert.deepEqual(edit.json().history[0].changes, [{
        field: "work",
        from: "Oil change (next due 35,000 mi), Tires (next due 11/10/2028)",
        to: "Oil change (next due 35,000 mi), Tires (next due 11/10/2028), Brakes",
      }]);
      const same = await inject("PATCH", `/service-logs/${id}`, { cookie: shopCookie, body: { version: edit.json().version, work: edit.json().work } });
      assert.equal(same.json().version, edit.json().version, "saving the same types again isn't a change");
    });

    test("an older copy of the app (one category and one next-due) still saves", async () => {
      const res = await inject("POST", "/service-logs", {
        cookie: shopCookie, body: entryBody({ category: "brakes", description: "Front pads", next_due_mileage: 90000 }),
      });
      assert.equal(res.statusCode, 201, res.body);
      const e = (await inject("GET", `/service-logs/${res.json().id}`, { cookie: shopCookie })).json();
      assert.deepEqual(e.work.map((w: { type: string; next_due_mileage: number }) => [w.type, w.next_due_mileage]), [["brakes", 90000]]);
    });

    test("voiding reopens the repairs it closed; entries and photos can't be deleted or changed in the database", async () => {
      const v = await inject("POST", `/service-logs/${entryId}/void`, { cookie: shopCookie, body: { reason: "Logged on the wrong day" } });
      assert.equal(v.statusCode, 200, v.body);
      assert.equal(v.json().voided.reason, "Logged on the wrong day");
      assert.equal(v.json().history.at(-1).voided, true);
      const open = await q(`SELECT id FROM inspection_items WHERE id = ANY($1::int[]) AND resolved_at IS NULL`, [repairIds]);
      assert.equal(open.length, 2, "both repairs are open again");
      assert.equal((await inject("PATCH", `/service-logs/${entryId}`, { cookie: shopCookie, body: { version: v.json().version, cost: "1" } })).statusCode, 409);
      assert.equal((await inject("POST", `/service-logs/${entryId}/void`, { cookie: shopCookie, body: { reason: "again" } })).statusCode, 409);
      const { inspection_id: inspId } = await one(`SELECT inspection_id FROM inspection_items WHERE id = $1`, [repairIds[0]]);
      assert.doesNotMatch(await pdfHtmlFor(inspId), /maintenance log/, "a voided entry isn't on the PDF");

      // A reopened repair can be fixed by a new entry.
      const again = await inject("POST", "/service-logs", { cookie: shopCookie, body: entryBody({ repair_item_ids: [repairIds[0]] }) });
      assert.equal(again.statusCode, 201, again.body);

      await assert.rejects(q(`DELETE FROM service_logs WHERE id = $1`, [entryId]), /can't be deleted/);
      await assert.rejects(q(`UPDATE photos SET caption = 'x' WHERE service_log_id = $1`, [entryId]), /read-only/);
      await assert.rejects(q(`UPDATE service_log_history SET old_row = '{}'`), /can't be updated/);
    });

    test("orphan photo cleanup never removes maintenance photos", async () => {
      await pool.query(`ALTER TABLE photos DISABLE TRIGGER photos_immutable`);
      await q(`UPDATE photos SET created_at = now() - interval '30 days' WHERE service_log_id = $1`, [entryId]);
      await pool.query(`ALTER TABLE photos ENABLE TRIGGER photos_immutable`);
      await cleanupOrphanPhotos(() => {});
      const left = await q(`SELECT id FROM photos WHERE service_log_id = $1`, [entryId]);
      assert.equal(left.length, 1);
    });
  });

  describe("archive and delete inspections", () => {
    let adminCookie = "";
    let truckId = 0;
    let older = "";
    let newer = "";
    let newerRepairId = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = async (): Promise<any> => (await inject("GET", `/vehicles/${truckId}`, { cookie: supCookie })).json();
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

    before(async () => {
      adminCookie = cookieOf(await inject("POST", "/auth/login", { body: { email: "admin@test.local", password: "admin-password-1" } }));
      const t = await one(`SELECT id FROM vehicles WHERE truck_code NOT IN ('T018', 'T002') ORDER BY id LIMIT 1`);
      truckId = t.id;
      const submit = async (date: string, mileage: number, note: string, x: number) => {
        const body = submitBody({
          vehicle_id: truckId, inspection_date: date, mileage, existing_notes: note,
          damage: [{ key: "k", diagram: "truck", x, y: 0.5, note: `Dent ${date}` }],
        });
        body.items = (body.items as { checklist_item_id: number; result: string; note?: string }[]).map((it, n) =>
          n === 2 ? { ...it, result: "repair", note: `Repair ${date}` } : it);
        const res = await inject("POST", "/inspections", { cookie: crewCookie, body });
        assert.equal(res.statusCode, 201, res.body);
        return res.json().id as string;
      };
      older = await submit("2026-08-01", 40000, "Older notes", 0.2);
      newer = await submit("2026-08-15", 90000, "Newer notes (wrong truck)", 0.7);
      newerRepairId = (await one(`SELECT id FROM inspection_items WHERE inspection_id = $1 AND result = 'repair'`, [newer])).id;
    });

    test("who can do what", async () => {
      assert.equal((await inject("POST", `/inspections/${newer}/archive`, { cookie: crewCookie, body: {} })).statusCode, 403);
      assert.equal((await inject("POST", `/inspections/${newer}/delete`, { cookie: supCookie, body: { reason: "x" } })).statusCode, 403);
      assert.equal((await inject("POST", `/inspections/${newer}/delete`, { cookie: adminCookie, body: {} })).statusCode, 400, "delete needs a reason");
      assert.equal((await inject("GET", "/admin/deleted-inspections", { cookie: supCookie })).statusCode, 403);
      assert.equal((await inject("POST", `/inspections/${newer}/unarchive`, { cookie: supCookie, body: {} })).statusCode, 409, "not archived");
    });

    test("archiving takes it out of the lists and its repairs, damage and mileage off the truck; un-archiving brings them back", async () => {
      const before = await page();
      assert.equal(before.vehicle.last_inspection_date, "2026-08-15");
      assert.equal(before.openRepairs.length, 2);
      assert.equal(before.damage.length, 2);

      const res = await inject("POST", `/inspections/${newer}/archive`, { cookie: supCookie, body: { reason: "Old" } });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await inject("POST", `/inspections/${newer}/archive`, { cookie: supCookie, body: {} })).statusCode, 409);

      const p = await page();
      assert.deepEqual(ids(p.history), [older]);
      assert.equal(p.archived_count, 1);
      assert.equal(p.openRepairs.length, 1);
      assert.equal(p.vehicle.open_repairs, 1);
      assert.deepEqual(p.damage.map((m: { inspection_id: string }) => m.inspection_id), [older]);
      assert.equal(p.vehicle.last_inspection_date, "2026-08-01");
      assert.equal(p.vehicle.last_mileage, 40000);
      const last = (await inject("GET", `/vehicles/${truckId}/last`, { cookie: crewCookie })).json();
      assert.equal(last.inspection.existing_notes, "Older notes");

      const list = async (qs: string) => ids((await inject("GET", `/inspections?limit=200&vehicle_id=${truckId}${qs}`, { cookie: supCookie })).json());
      assert.deepEqual(await list(""), [older]);
      assert.deepEqual(await list("&archived=only"), [newer]);
      assert.deepEqual((await list("&archived=include")).sort(), [older, newer].sort());

      const d = (await inject("GET", `/inspections/${newer}`, { cookie: crewCookie })).json();
      assert.equal(d.state, "archived");
      assert.equal(d.state_info.reason, "Old");
      assert.equal(d.state_info.changed_by_name, "Sam Super");
      assert.equal((await inject("GET", `/inspections/${newer}/pdf`, { cookie: supCookie })).statusCode, 200, "still exports");

      // Its repair is off the truck, so it can't be closed through the maintenance log either.
      const fix = await inject("POST", "/service-logs", {
        cookie: adminCookie,
        body: { client_id: randomUUID(), vehicle_id: truckId, service_date: "2026-08-20", mileage: 41000, category: "repair", description: "x", repair_item_ids: [newerRepairId] },
      });
      assert.equal(fix.statusCode, 422, fix.body);
      assert.equal(fix.json().details.code, "bad_repairs");

      assert.equal((await inject("POST", `/inspections/${newer}/unarchive`, { cookie: supCookie, body: {} })).statusCode, 200);
      const back = await page();
      assert.equal(back.openRepairs.length, 2);
      assert.equal(back.damage.length, 2);
      assert.equal(back.vehicle.last_mileage, 90000);
      assert.equal(back.archived_count, 0);
    });

    test("delete (admin) moves it to Admin → Deleted; restore brings it back; the history keeps every step", async () => {
      const del = await inject("POST", `/inspections/${newer}/delete`, { cookie: adminCookie, body: { reason: "Wrong truck" } });
      assert.equal(del.statusCode, 200, del.body);
      const p = await page();
      assert.deepEqual(ids(p.history), [older]);
      assert.equal(p.archived_count, 0, "deleted isn't counted as archived");
      const all = ids((await inject("GET", `/inspections?limit=200&vehicle_id=${truckId}&archived=include`, { cookie: supCookie })).json());
      assert.deepEqual(all, [older], "deleted never shows in the normal lists");
      const bin = (await inject("GET", "/admin/deleted-inspections", { cookie: adminCookie })).json();
      assert.equal(bin.length, 1);
      assert.equal(bin[0].id, newer);
      assert.equal(bin[0].reason, "Wrong truck");

      const sig = await inject("POST", `/inspections/${newer}/review`, { cookie: supCookie, body: { signature: PNG } });
      assert.equal(sig.statusCode, 409, "a deleted inspection can't be signed off");
      assert.equal((await inject("POST", `/inspections/${newer}/archive`, { cookie: supCookie, body: {} })).statusCode, 409);

      assert.equal((await inject("POST", `/inspections/${newer}/restore`, { cookie: adminCookie, body: {} })).statusCode, 200);
      assert.equal((await inject("GET", "/admin/deleted-inspections", { cookie: adminCookie })).json().length, 0);
      assert.equal((await page()).openRepairs.length, 2);
      const d = (await inject("GET", `/inspections/${newer}`, { cookie: crewCookie })).json();
      assert.equal(d.state, "active");
      assert.deepEqual(d.state_history.map((h: { action: string }) => h.action), ["archive", "unarchive", "delete", "restore"]);
    });

    test("the database refuses to erase inspections, their records and attached photos", async () => {
      await assert.rejects(q(`DELETE FROM inspections WHERE id = $1`, [older]), /can't be deleted/);
      await assert.rejects(q(`DELETE FROM inspection_items WHERE inspection_id = $1`, [older]), /can't be deleted/);
      await assert.rejects(q(`DELETE FROM damage_marks WHERE inspection_id = $1`, [older]), /can't be deleted/);
      await assert.rejects(q(`DELETE FROM inspection_states WHERE inspection_id = $1`, [newer]), /can't be deleted/);
      await assert.rejects(q(`UPDATE inspection_state_history SET reason = 'x' WHERE inspection_id = $1`, [newer]), /can't be updated/);
      const attached = await one(`SELECT id FROM photos WHERE inspection_id IS NOT NULL LIMIT 1`);
      await assert.rejects(q(`DELETE FROM photos WHERE id = $1`, [attached.id]), /can't be deleted once attached/);
      const loose = await uploadPhoto(crewCookie);
      await q(`DELETE FROM photos WHERE id = $1`, [loose.id]); // a never-attached upload can still be cleaned up
    });
  });

  describe("damage repaired", () => {
    let truckId = 0;
    let shopCookie = "";
    let adminCookie = "";
    const marks: Record<string, number> = {};
    const onFile = async () =>
      ((await inject("GET", `/vehicles/${truckId}/last`, { cookie: crewCookie })).json().damage as { id: number }[]).map((m) => m.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markOf = async (id: number): Promise<any> =>
      (await inject("GET", `/vehicles/${truckId}`, { cookie: supCookie })).json().damage.find((m: { id: number }) => m.id === id);

    before(async () => {
      const t = await one(`SELECT id FROM vehicles WHERE truck_code NOT IN ('T018', 'T002') ORDER BY id OFFSET 1 LIMIT 1`);
      truckId = t.id;
      const shop = await one(`SELECT id FROM users WHERE name = 'Robin Shop'`);
      shopCookie = cookieOf(await inject("POST", "/auth/pin", { body: { user_id: shop.id, pin: "1357" } }));
      adminCookie = cookieOf(await inject("POST", "/auth/login", { body: { email: "admin@test.local", password: "admin-password-1" } }));
      const res = await inject("POST", "/inspections", {
        cookie: crewCookie,
        body: submitBody({
          vehicle_id: truckId, mileage: 20000,
          damage: [
            { key: "a", diagram: "truck", x: 0.2, y: 0.3, note: "Dented door" },
            { key: "b", diagram: "truck", x: 0.7, y: 0.6, note: "Cracked tail light lens" },
          ],
        }),
      });
      assert.equal(res.statusCode, 201, res.body);
      for (const m of await q(`SELECT id, note FROM damage_marks WHERE inspection_id = $1`, [res.json().id])) marks[m.note] = m.id;
    });

    test("a supervisor marks damage repaired with a note and a photo; it leaves the grey dots", async () => {
      const door = marks["Dented door"];
      const url = `/damage-marks/${door}/repair`;
      const body = (photoIds: string[], over: Record<string, unknown> = {}) => ({ client_id: randomUUID(), note: "Body shop pulled it", photo_ids: photoIds, ...over });
      assert.equal((await inject("POST", url, { cookie: crewCookie, body: body([randomUUID()]) })).statusCode, 403);
      assert.equal((await inject("POST", url, { cookie: shopCookie, body: body([randomUUID()]) })).statusCode, 403, "the shop uses Log fix");
      assert.equal((await inject("POST", url, { cookie: supCookie, body: body([]) })).statusCode, 400, "photo required");
      assert.equal((await inject("POST", url, { cookie: supCookie, body: body([randomUUID()], { note: " " }) })).statusCode, 400, "note required");
      const notUp = await inject("POST", url, { cookie: supCookie, body: body([randomUUID()]) });
      assert.equal(notUp.statusCode, 422);
      assert.equal(notUp.json().details.code, "photos_missing");

      const { id: photoId } = await uploadPhoto(supCookie);
      const ok = body([photoId]);
      const a = await inject("POST", url, { cookie: supCookie, body: ok });
      assert.equal(a.statusCode, 201, a.body);
      const again = await inject("POST", url, { cookie: supCookie, body: ok });
      assert.equal(again.statusCode, 200, "a retried save is a no-op");
      assert.equal(again.json().id, a.json().id);
      const { id: p2 } = await uploadPhoto(supCookie);
      assert.equal((await inject("POST", url, { cookie: supCookie, body: body([p2]) })).statusCode, 409, "already repaired");

      assert.deepEqual(await onFile(), [marks["Cracked tail light lens"]]);
      const m = await markOf(door);
      assert.equal(m.repair.note, "Body shop pulled it");
      assert.equal(m.repair.repaired_by_name, "Sam Super");
      assert.equal(m.repair.service_log_id, null);
      assert.deepEqual(m.repair.photos.map((p: { id: string }) => p.id), [photoId]);
    });

    test("undo puts it back on file; the repair and its photo are kept", async () => {
      const door = marks["Dented door"];
      const repairId = (await markOf(door)).repair.id;
      assert.equal((await inject("POST", `/damage-repairs/${repairId}/undo`, { cookie: crewCookie, body: { reason: "x" } })).statusCode, 403);
      assert.equal((await inject("POST", `/damage-repairs/${repairId}/undo`, { cookie: supCookie, body: {} })).statusCode, 400, "reason required");
      assert.equal((await inject("POST", `/damage-repairs/${repairId}/undo`, { cookie: supCookie, body: { reason: "Wrong dent" } })).statusCode, 200);
      assert.equal((await inject("POST", `/damage-repairs/${repairId}/undo`, { cookie: supCookie, body: { reason: "x" } })).statusCode, 409);
      assert.deepEqual((await onFile()).sort(), Object.values(marks).sort());
      const kept = await one(`SELECT active, end_reason, (SELECT count(*) FROM photos WHERE damage_repair_id = $1) AS photos FROM damage_repairs WHERE id = $1`, [repairId]);
      assert.equal(kept.active, false);
      assert.equal(kept.end_reason, "Undone: Wrong dent");
      assert.equal(kept.photos, 1);
    });

    test("the shop's Log fix needs a photo of the fixed area; voiding the entry puts the damage back on file", async () => {
      const lens = marks["Cracked tail light lens"];
      const entry = (over: Record<string, unknown>) => ({
        client_id: randomUUID(), vehicle_id: truckId, service_date: "2026-11-10", mileage: 20100, category: "repair",
        description: "Replaced tail light lens", damage_mark_ids: [lens], ...over,
      });
      const noPhoto = await inject("POST", "/service-logs", { cookie: shopCookie, body: entry({}) });
      assert.equal(noPhoto.statusCode, 422, noPhoto.body);
      assert.equal(noPhoto.json().details.code, "damage_photo_missing");
      const { id: receipt } = await uploadPhoto(shopCookie);
      const untagged = await inject("POST", "/service-logs", { cookie: shopCookie, body: entry({ photos: [{ id: receipt, caption: "Receipt" }] }) });
      assert.equal(untagged.statusCode, 422, "a receipt isn't a photo of the fix");
      const stray = await inject("POST", "/service-logs", {
        cookie: shopCookie, body: entry({ damage_mark_ids: [], photos: [{ id: receipt, damage_mark_id: lens }] }),
      });
      assert.equal(stray.statusCode, 400, "tagged to damage the entry doesn't fix");

      const { id: after } = await uploadPhoto(shopCookie);
      const res = await inject("POST", "/service-logs", {
        cookie: shopCookie,
        body: entry({ photos: [{ id: receipt, caption: "Receipt" }, { id: after, caption: "New lens", damage_mark_id: lens }] }),
      });
      assert.equal(res.statusCode, 201, res.body);
      const entryId = res.json().id;
      assert.ok(!(await onFile()).includes(lens));
      const m = await markOf(lens);
      assert.equal(m.repair.service_log_id, entryId);
      assert.deepEqual(m.repair.photos.map((p: { id: string }) => p.id), [after], "only the tagged photo is a photo of the fix");
      const e = (await inject("GET", `/service-logs/${entryId}`, { cookie: supCookie })).json();
      assert.equal(e.damage_fixes.length, 1);
      assert.equal(e.damage_fixes[0].active, true);
      assert.deepEqual(e.damage_fixes[0].photos.map((p: { id: string }) => p.id), [after]);
      assert.equal(e.photos.length, 2, "both photos are on the entry");
      assert.equal((await inject("POST", `/damage-repairs/${m.repair.id}/undo`, { cookie: supCookie, body: { reason: "x" } })).statusCode, 409,
        "a Log fix is undone by voiding the entry");

      const v = await inject("POST", `/service-logs/${entryId}/void`, { cookie: shopCookie, body: { reason: "Wrong truck" } });
      assert.equal(v.statusCode, 200, v.body);
      assert.ok((await onFile()).includes(lens), "back on file");
      assert.equal(v.json().damage_fixes[0].active, false);
    });

    test("the database keeps repairs and their photos: no edits except ending, no deletes", async () => {
      const r = await one(`SELECT id FROM damage_repairs ORDER BY id LIMIT 1`);
      await assert.rejects(q(`UPDATE damage_repairs SET note = 'x' WHERE id = $1`, [r.id]), /read-only/);
      await assert.rejects(q(`DELETE FROM damage_repairs WHERE id = $1`, [r.id]), /can't be deleted/);
      const p = await one(`SELECT id FROM photos WHERE damage_repair_id IS NOT NULL AND service_log_id IS NULL LIMIT 1`);
      await assert.rejects(q(`DELETE FROM photos WHERE id = $1`, [p.id]), /can't be deleted once attached/);
      await assert.rejects(q(`UPDATE photos SET caption = 'x' WHERE id = $1`, [p.id]), /read-only once attached/);
    });

    test("damage on an archived inspection can't be marked repaired", async () => {
      const insp = await one(`SELECT inspection_id FROM damage_marks WHERE id = $1`, [marks["Dented door"]]);
      assert.equal((await inject("POST", `/inspections/${insp.inspection_id}/archive`, { cookie: adminCookie, body: {} })).statusCode, 200);
      const { id: photoId } = await uploadPhoto(supCookie);
      const res = await inject("POST", `/damage-marks/${marks["Dented door"]}/repair`, {
        cookie: supCookie, body: { client_id: randomUUID(), note: "x", photo_ids: [photoId] },
      });
      assert.equal(res.statusCode, 404);
      await inject("POST", `/inspections/${insp.inspection_id}/unarchive`, { cookie: adminCookie, body: {} });
    });
  });

  describe("repairs board", () => {
    let adminCookie = "";
    let shopCookie = "";
    let truckA = 0;
    let truckB = 0;
    const ids: Record<string, number> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const board = async (qs = ""): Promise<any[]> => {
      const res = await inject("GET", `/repairs${qs}`, { cookie: supCookie });
      assert.equal(res.statusCode, 200, res.body);
      return res.json();
    };
    const mine = (rows: { id: number }[]) => rows.map((r) => r.id).filter((id) => Object.values(ids).includes(id));

    before(async () => {
      adminCookie = cookieOf(await inject("POST", "/auth/login", { body: { email: "admin@test.local", password: "admin-password-1" } }));
      const shop = await one(`SELECT id FROM users WHERE name = 'Robin Shop'`);
      shopCookie = cookieOf(await inject("POST", "/auth/pin", { body: { user_id: shop.id, pin: "1357" } }));
      const ts = await q(`SELECT id FROM vehicles WHERE truck_code NOT IN ('T018', 'T002') ORDER BY id OFFSET 4 LIMIT 2`);
      [truckA, truckB] = ts.map((t: { id: number }) => t.id);
      const submit = async (truck: number, date: string, notes: string[], photo?: string) => {
        const body = submitBody({ vehicle_id: truck, inspection_date: date, mileage: 50000, damage: [] });
        body.items = (body.items as { checklist_item_id: number; result: string; note?: string }[]).map((it, n) =>
          n < notes.length ? { ...it, result: "repair", note: notes[n] } : it);
        if (photo) body.photos = [{ id: photo, caption: "Leak", checklist_item_id: (body.items as { checklist_item_id: number }[])[0].checklist_item_id }];
        const res = await inject("POST", "/inspections", { cookie: crewCookie, body });
        assert.equal(res.statusCode, 201, res.body);
        const items = await q(`SELECT id, note FROM inspection_items WHERE inspection_id = $1 AND result = 'repair'`, [res.json().id]);
        for (const it of items) ids[it.note] = it.id;
        return res.json().id as string;
      };
      const { id: photoId } = await uploadPhoto(crewCookie);
      await submit(truckA, "2026-09-01", ["Oil leak", "Wiper torn"], photoId);
      await submit(truckB, "2026-11-01", ["Mirror cracked"]);
      const archived = await submit(truckB, "2026-11-05", ["On an archived inspection"]);
      await inject("POST", `/inspections/${archived}/archive`, { cookie: supCookie, body: {} });
    });

    test("supervisors and the shop see it; crew don't", async () => {
      assert.equal((await inject("GET", "/repairs", { cookie: crewCookie })).statusCode, 403);
      assert.equal((await inject("GET", "/repairs", { cookie: shopCookie })).statusCode, 200);
      assert.equal((await inject("GET", "/repairs?vehicle_id=x", { cookie: supCookie })).statusCode, 400);
    });

    test("every open repair across the fleet, oldest first per truck, with age and photos; archived ones left out", async () => {
      const rows = await board();
      assert.deepEqual(mine(rows).sort(), [ids["Oil leak"], ids["Wiper torn"], ids["Mirror cracked"]].sort());
      const leak = rows.find((r) => r.id === ids["Oil leak"]);
      assert.equal(leak.vehicle_id, truckA);
      assert.ok(leak.truck_code);
      assert.equal(leak.inspection_date, "2026-09-01");
      assert.ok(leak.days_open >= 60, "days since the inspection");
      assert.equal(leak.photo_ids.length, 1);
      assert.deepEqual(rows.find((r) => r.id === ids["Mirror cracked"]).photo_ids, []);
      assert.deepEqual(mine(await board(`?vehicle_id=${truckB}`)), [ids["Mirror cracked"]]);
    });

    test("resolved repairs and retired trucks drop off", async () => {
      await inject("POST", `/inspection-items/${ids["Wiper torn"]}/resolve`, { cookie: supCookie, body: { note: "New blade" } });
      assert.deepEqual(mine(await board()).sort(), [ids["Oil leak"], ids["Mirror cracked"]].sort());
      const retire = await inject("PATCH", `/admin/vehicles/${truckB}`, { cookie: adminCookie, body: { active: false } });
      assert.equal(retire.statusCode, 200, retire.body);
      assert.deepEqual(mine(await board()), [ids["Oil leak"]]);
      await inject("PATCH", `/admin/vehicles/${truckB}`, { cookie: adminCookie, body: { active: true } });
    });
  });

  describe("registration expiration", () => {
    let adminCookie = "";
    let truck = 0;
    let other = 0;
    const reg = (body: Record<string, unknown>, cookie = supCookie, id = truck) =>
      inject("POST", `/vehicles/${id}/registration`, { cookie, body: { client_id: randomUUID(), from: "truck", ...body } });
    const current = async (id = truck) => (await one(`SELECT registration_expires FROM vehicles WHERE id = $1`, [id])).registration_expires;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history = async (id = truck): Promise<any[]> => (await inject("GET", `/vehicles/${id}`, { cookie: supCookie })).json().registration;
    const submit = async () => {
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body: submitBody({ vehicle_id: truck, mileage: 60000, damage: [] }) });
      assert.equal(res.statusCode, 201, res.body);
      return res.json().id as string;
    };
    const onFile = async (inspectionId: string) => (await inject("GET", `/inspections/${inspectionId}`, { cookie: supCookie })).json().registration_expires;

    before(async () => {
      adminCookie = cookieOf(await inject("POST", "/auth/login", { body: { email: "admin@test.local", password: "admin-password-1" } }));
      const ts = await q(`SELECT id FROM vehicles WHERE truck_code NOT IN ('T018', 'T002', 'T053') ORDER BY id OFFSET 10 LIMIT 2`);
      [truck, other] = ts.map((t: { id: number }) => t.id);
      await q(`UPDATE vehicles SET registration_expires = '2026-12-31' WHERE id = ANY($1::int[])`, [[truck, other]]);
    });

    test("only supervisors and admins can update it", async () => {
      const crew = await reg({ expires: "2027-12-31", was: await current() }, crewCookie);
      assert.equal(crew.statusCode, 403);
      const shop = await one(`SELECT id FROM users WHERE name = 'Robin Shop'`);
      const shopCookie = cookieOf(await inject("POST", "/auth/pin", { body: { user_id: shop.id, pin: "1357" } }));
      assert.equal((await reg({ expires: "2027-12-31", was: await current() }, shopCookie)).statusCode, 403);
    });

    test("a supervisor updates it from the truck page; the change is kept with who, when and the old date", async () => {
      const before = await history();
      const res = await reg({ expires: "2027-11-30", was: "2026-12-31", note: "Renewed online" });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json().registration_expires, "2027-11-30");
      assert.equal(await current(), "2027-11-30");
      const h = await history();
      assert.equal(h.length, before.length + 1);
      assert.equal(h[0].previous, "2026-12-31");
      assert.equal(h[0].expires, "2027-11-30");
      assert.equal(h[0].source, "truck");
      assert.equal(h[0].changed_by_name, "Sam Super");
      assert.equal(h[0].note, "Renewed online");
      assert.deepEqual(h[0].photo_ids, []);
    });

    test("bad dates, the same date and a date changed meanwhile are refused without changing anything", async () => {
      const was = await current();
      const n = (await history()).length;
      assert.equal((await reg({ expires: "2027-02-30", was })).statusCode, 400);
      assert.equal((await reg({ expires: "2045-01-01", was })).statusCode, 400);
      assert.equal((await reg({ expires: "2019-06-01", was })).statusCode, 400);
      assert.equal((await reg({ expires: was, was })).statusCode, 400);
      assert.equal((await reg({ expires: "2028-01-31", was, from: "nowhere" })).statusCode, 400);
      const stale = await reg({ expires: "2028-01-31", was: "2026-12-31" });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().details.code, "registration_changed");
      assert.equal(stale.json().details.registration_expires, was);
      assert.equal(await current(), was);
      assert.equal((await history()).length, n);
    });

    test("a retried update (same client_id) is saved once", async () => {
      const clientId = randomUUID();
      const body = { client_id: clientId, expires: "2028-03-31", was: await current() };
      const a = await reg(body);
      const b = await reg(body);
      assert.equal(a.statusCode, 201, a.body);
      assert.equal(b.statusCode, 200, b.body);
      assert.equal(b.json().id, a.json().id);
      assert.equal((await q(`SELECT 1 FROM registration_changes WHERE client_id = $1`, [clientId])).length, 1);
    });

    test("an optional photo is kept with the change, can't be reused, and survives the orphan clean-up", async () => {
      const { id: photoId } = await uploadPhoto(supCookie);
      // Old enough that the clean-up would remove it if it still counted as unattached.
      await q(`UPDATE photos SET created_at = now() - interval '30 days' WHERE id = $1`, [photoId]);
      const res = await reg({ expires: "2028-04-30", was: await current(), photo_ids: [photoId] });
      assert.equal(res.statusCode, 201, res.body);
      assert.deepEqual((await history())[0].photo_ids, [photoId]);
      const reuse = await inject("POST", "/inspections", {
        cookie: supCookie,
        body: submitBody({ vehicle_id: truck, mileage: 60000, damage: [], photos: [{ id: photoId, caption: null }] }),
      });
      assert.equal(reuse.statusCode, 422);
      await cleanupOrphanPhotos(() => {});
      assert.ok(await one(`SELECT 1 FROM photos WHERE id = $1`, [photoId]));
      await assert.rejects(q(`DELETE FROM photos WHERE id = $1`, [photoId]));
      const notYet = await reg({ expires: "2028-05-31", was: await current(), photo_ids: [randomUUID()] });
      assert.equal(notYet.statusCode, 422);
      assert.equal(notYet.json().details.code, "photos_missing");
    });

    test("an inspection shows the date on file when it was done; one set while signing off shows on that inspection", async () => {
      await reg({ expires: "2028-06-30", was: await current() });
      const a = await submit();
      assert.equal(await onFile(a), "2028-06-30");
      await reg({ expires: "2029-06-30", was: "2028-06-30" });
      assert.equal(await onFile(a), "2028-06-30", "a later change doesn't rewrite an earlier inspection");
      const b = await submit();
      assert.equal(await onFile(b), "2029-06-30");
      const signoff = await reg({ expires: "2029-07-31", was: "2029-06-30", from: "sign-off", inspection_id: a });
      assert.equal(signoff.statusCode, 201, signoff.body);
      assert.equal(await onFile(a), "2029-07-31", "set while signing A off, so A shows it");
      assert.equal(await onFile(b), "2029-06-30", "B was done before that change");
      const detail = (await inject("GET", `/inspections/${b}`, { cookie: supCookie })).json();
      assert.equal(detail.vehicle.registration_expires, "2029-07-31", "the truck's date today");
      assert.match(await pdfHtmlFor(a), /<th>Expiration<\/th><td>7\/31\/2029<\/td>/);
      assert.match(await pdfHtmlFor(b), /<th>Expiration<\/th><td>6\/30\/2029<\/td>/);
      const h = await history();
      assert.equal(h[0].source, "sign-off");
      assert.equal(h[0].inspection_id, a);
    });

    test("sign-off needs an inspection of this truck", async () => {
      const was = await current();
      assert.equal((await reg({ expires: "2030-01-31", was, from: "sign-off" })).statusCode, 400);
      const theirs = (await one(`SELECT id FROM inspections WHERE vehicle_id <> $1 LIMIT 1`, [truck])).id;
      assert.equal((await reg({ expires: "2030-01-31", was, from: "sign-off", inspection_id: theirs })).statusCode, 400);
      assert.equal(await current(), was);
    });

    test("admin edits are recorded too; saving other fields records nothing", async () => {
      const n = (await history(other)).length;
      const same = await inject("PATCH", `/admin/vehicles/${other}`, { cookie: adminCookie, body: { unit: "U-77", registration_expires: "2026-12-31" } });
      assert.equal(same.statusCode, 200, same.body);
      assert.equal((await history(other)).length, n);
      const res = await inject("PATCH", `/admin/vehicles/${other}`, { cookie: adminCookie, body: { registration_expires: "2027-08-31" } });
      assert.equal(res.statusCode, 200, res.body);
      const h = await history(other);
      assert.equal(h.length, n + 1);
      assert.equal(h[0].source, "admin");
      assert.equal(h[0].previous, "2026-12-31");
      assert.equal(h[0].expires, "2027-08-31");
      assert.ok(h[0].changed_by_name);
      const cleared = await inject("PATCH", `/admin/vehicles/${other}`, { cookie: adminCookie, body: { registration_expires: "" } });
      assert.equal(cleared.statusCode, 200, cleared.body);
      assert.equal((await history(other))[0].expires, null);
    });

    test("a change made outside the app is still recorded, and the history can't be edited or erased", async () => {
      await q(`UPDATE vehicles SET registration_expires = '2031-01-31' WHERE id = $1`, [other]);
      const h = await history(other);
      assert.equal(h[0].source, "other");
      assert.equal(h[0].expires, "2031-01-31");
      assert.equal(h[0].changed_by_name, null);
      await assert.rejects(q(`UPDATE registration_changes SET expires = '2020-01-01' WHERE vehicle_id = $1`, [other]));
      await assert.rejects(q(`DELETE FROM registration_changes WHERE vehicle_id = $1`, [other]));
      assert.equal((await history(other)).length, h.length);
    });
  });

  describe("security limits", () => {
    // How requests reach the app in production: from Caddy on Docker's private network, with the client's real
    // address in X-Forwarded-For (Caddy replaces whatever the client sent there).
    async function pinFrom(clientIp: string, userId: number, pin: string, extra: Record<string, string> = {}) {
      return app.inject({
        method: "POST", url: "/api/auth/pin", remoteAddress: "172.18.0.5",
        headers: { ...H, "x-forwarded-for": clientIp, ...extra }, payload: { user_id: userId, pin },
      });
    }
    const lockMins = async (id: number) =>
      one(`SELECT round(extract(epoch FROM locked_until - now()) / 60)::int AS m, lockouts FROM users WHERE id = $1`, [id]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const limits = config.lockout as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const photoLimits = config.photo as any;

    test("the sign-in rate limit counts the real address; a faked CF-Connecting-IP or X-Forwarded-For doesn't dodge it", async () => {
      const codes = new Set<number>();
      for (let i = 0; i < 15; i++) {
        // Each try claims a different address, the way the old limit could be dodged.
        codes.add((await pinFrom("198.51.100.1, 203.0.113.7", 999999, "0000", { "cf-connecting-ip": `10.9.9.${i}` })).statusCode);
      }
      assert.deepEqual([...codes], [401]);
      assert.equal((await pinFrom("203.0.113.7", 999999, "0000", { "cf-connecting-ip": "10.9.9.99" })).statusCode, 429);
      assert.equal((await pinFrom("203.0.113.8", 999999, "0000")).statusCode, 401, "another address isn't affected");
    });

    test("through Cloudflare's proxy the limit counts each phone (CF-Connecting-IP), not Cloudflare's address", async () => {
      // Caddy hands the app the Cloudflare edge's address; Cloudflare puts the phone's in CF-Connecting-IP.
      const edge = "172.69.74.222";
      for (let i = 0; i < 15; i++) {
        assert.equal((await pinFrom(edge, 999999, "0000", { "cf-connecting-ip": "198.51.100.50" })).statusCode, 401);
      }
      assert.equal((await pinFrom(edge, 999999, "0000", { "cf-connecting-ip": "198.51.100.50" })).statusCode, 429);
      assert.equal((await pinFrom(edge, 999999, "0000", { "cf-connecting-ip": "198.51.100.51" })).statusCode, 401,
        "another phone behind the same Cloudflare edge isn't affected");
      assert.equal((await pinFrom("2606:4700:10::1", 999999, "0000", { "cf-connecting-ip": "198.51.100.52" })).statusCode, 401);
    });

    test("one network gets a set number of wrong tries across all accounts; your own typos stop counting once you get in", async () => {
      const crew = await one(`SELECT id FROM users WHERE name = 'Casey Crew'`);
      const before = limits.addressMaxFailures;
      limits.addressMaxFailures = 3;
      try {
        const net = "203.0.113.20";
        assert.equal((await pinFrom(net, crew.id, "1111")).statusCode, 401);
        assert.equal((await pinFrom(net, crew.id, "2222")).statusCode, 401);
        assert.equal((await pinFrom(net, crew.id, "1234")).statusCode, 200, "Casey's own typos are forgiven");
        for (const id of [999998, 999997, 999996]) assert.equal((await pinFrom(net, id, "0000")).statusCode, 401);
        const blocked = await pinFrom(net, crew.id, "1234");
        assert.equal(blocked.statusCode, 429);
        assert.match(blocked.json().message, /from this network/);
        assert.equal((await pinFrom("203.0.113.21", crew.id, "1234")).statusCode, 200, "other networks still sign in");
        // For IPv6 the whole /64 is one network (a phone can pick any address in it).
        assert.equal((await pinFrom("2001:db8:5:6::1", 999995, "0000")).statusCode, 401);
        assert.equal((await pinFrom("2001:db8:5:6::2", 999995, "0000")).statusCode, 401);
        assert.equal((await pinFrom("2001:db8:5:6:ffff::3", 999995, "0000")).statusCode, 401);
        assert.equal((await pinFrom("2001:db8:5:6::4", crew.id, "1234")).statusCode, 429);
        assert.equal((await pinFrom("2001:db8:5:7::1", crew.id, "1234")).statusCode, 200);
      } finally {
        limits.addressMaxFailures = before;
      }
    });

    test("an account locked again the same day stays locked longer; a day later it starts over", async () => {
      await q(`INSERT INTO users (name, role, pin_hash) VALUES ('Lock Twice', 'crew', $1)`, [await hashSecret("5555")]);
      const u = await one(`SELECT id FROM users WHERE name = 'Lock Twice'`);
      let net = 30;
      const fiveWrong = async () => {
        const from = `203.0.113.${net++}`;
        for (let i = 0; i < 5; i++) assert.equal((await pinFrom(from, u.id, "0000")).statusCode, 401);
      };
      const lockPasses = () => q(`UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1`, [u.id]);

      await fiveWrong();
      assert.deepEqual(await lockMins(u.id), { m: 15, lockouts: 1 });
      const locked = await pinFrom("203.0.113.60", u.id, "5555");
      assert.equal(locked.statusCode, 429, "the right PIN doesn't get in while locked");
      assert.match(locked.json().message, /15 minutes/);

      for (const m of [30, 60, 120, 240, 240]) {
        await lockPasses();
        await fiveWrong();
        assert.equal((await lockMins(u.id)).m, m);
      }
      assert.match((await pinFrom("203.0.113.61", u.id, "5555")).json().message, /4 hours/);

      await q(`UPDATE users SET locked_until = now() - interval '1 second', last_locked_at = now() - interval '25 hours' WHERE id = $1`, [u.id]);
      assert.equal((await pinFrom("203.0.113.62", u.id, "5555")).statusCode, 200, "the right PIN works once the lock is over");
      await fiveWrong();
      assert.deepEqual(await lockMins(u.id), { m: 15, lockouts: 1 }, "a day later it's back to 15 minutes");

      // An admin setting a new PIN unlocks it and starts the count over.
      const admin = await inject("POST", "/auth/login", { body: { email: "admin@test.local", password: "admin-password-1" } });
      const reset = await inject("PATCH", `/admin/users/${u.id}`, { cookie: cookieOf(admin), body: { pin: "6666" } });
      assert.equal(reset.statusCode, 200);
      assert.equal((await one(`SELECT lockouts FROM users WHERE id = $1`, [u.id])).lockouts, 0);
      assert.equal((await pinFrom("203.0.113.63", u.id, "6666")).statusCode, 200);
    });

    test("guesses sent all at once still get only five tries", async () => {
      await q(`INSERT INTO users (name, role, pin_hash) VALUES ('Rush', 'crew', $1)`, [await hashSecret("7777")]);
      const u = await one(`SELECT id FROM users WHERE name = 'Rush'`);
      const res = await Promise.all(Array.from({ length: 12 }, (_, i) => pinFrom(`203.0.114.${i}`, u.id, `00${10 + i}`)));
      const checked = res.filter((r) => r.statusCode === 401).length;
      assert.ok(checked >= 1 && checked <= 5, `only five guesses were checked (got ${checked})`);
      assert.equal(res.filter((r) => r.statusCode === 429).length, 12 - checked);
      assert.equal((await pinFrom("203.0.114.99", u.id, "7777")).statusCode, 429, "and the account is locked");
    });

    test("photo uploads stop at the daily limit and when the disk is nearly full; a retry of a stored photo still works", async () => {
      const used = Number((await one(
        `SELECT coalesce(sum(bytes), 0) AS b FROM photos
          WHERE uploaded_by = (SELECT id FROM users WHERE name = 'Casey Crew') AND created_at > now() - interval '24 hours'`)).b);
      const before = { ...photoLimits };
      photoLimits.dailyBytesPerUser = used + 2 * JPEG.length;
      try {
        const a = await uploadPhoto(crewCookie);
        assert.equal(a.res.statusCode, 201);
        assert.equal((await uploadPhoto(crewCookie)).res.statusCode, 201);
        const over = await uploadPhoto(crewCookie);
        assert.equal(over.res.statusCode, 429, "a retryable answer: the phone keeps the photo and tries later");
        assert.equal(over.res.json().details.code, "upload_cap");
        assert.equal(over.res.json().details.retry_later, true);
        assert.equal(await one(`SELECT id FROM photos WHERE id = $1`, [over.id]), undefined);
        assert.equal((await uploadPhoto(crewCookie, a.id)).res.statusCode, 200, "a photo already stored is still confirmed");
        assert.equal((await uploadPhoto(supCookie)).res.statusCode, 201, "the limit is per person");

        photoLimits.dailyBytesPerUser = before.dailyBytesPerUser;
        photoLimits.minFreeBytes = Number.MAX_SAFE_INTEGER;
        const full = await uploadPhoto(crewCookie);
        assert.equal(full.res.statusCode, 503);
        assert.equal(full.res.json().details.code, "disk_low");
        assert.match(full.res.json().message, /nearly out of storage/, "the phone shows why, not a generic error");
        assert.equal((await uploadPhoto(crewCookie, a.id)).res.statusCode, 200);
      } finally {
        Object.assign(photoLimits, before);
      }
      assert.equal((await uploadPhoto(crewCookie)).res.statusCode, 201);
    });

    test("HSTS is sent over HTTPS only, and only when our own proxy says it was HTTPS", async () => {
      const get = (remoteAddress: string, headers: Record<string, string>) =>
        app.inject({ method: "GET", url: "/api/branding", remoteAddress, headers });
      const https = await get("172.18.0.5", { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.40" });
      assert.equal(https.headers["strict-transport-security"], "max-age=31536000");
      assert.equal((await get("172.18.0.5", { "x-forwarded-proto": "http" })).headers["strict-transport-security"], undefined);
      assert.equal((await get("203.0.113.41", { "x-forwarded-proto": "https" })).headers["strict-transport-security"], undefined,
        "a client talking to the app directly can't claim HTTPS");
    });
  });

  describe("CSV export", () => {
    /** RFC 4180 parse, enough for these files: rows of cells, quotes undone. */
    function parseCsv(text: string): string[][] {
      assert.equal(text.charCodeAt(0), 0xfeff, "starts with a byte-order mark");
      const rows: string[][] = [];
      let row: string[] = [];
      let cur = "";
      let quoted = false;
      for (let i = 1; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
          if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") { row.push(cur); cur = ""; }
        else if (ch === "\r" && text[i + 1] === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; i++; }
        else cur += ch;
      }
      assert.equal(row.length + cur.length, 0, "ends with a line break");
      return rows;
    }
    async function csv(cookie: string, path: string) {
      const res = await inject("GET", `/export/${path}`, { cookie });
      assert.equal(res.statusCode, 200, res.body);
      assert.match(String(res.headers["content-type"]), /^text\/csv/);
      const name = /filename="([^"]+)"/.exec(String(res.headers["content-disposition"]))?.[1] ?? "";
      const [header, ...rows] = parseCsv(res.body);
      assert.equal(Number(res.headers["x-row-count"]), rows.length);
      for (const r of rows) assert.equal(r.length, header.length, "every row has every column");
      const objects = rows.map((r) => Object.fromEntries(header.map((h, n) => [h, r[n]])));
      return { name, header, rows: objects };
    }
    let shopCookie = "";
    let truck = 0;
    let inspectionId = "";

    before(async () => {
      const u = await one(`SELECT id FROM users WHERE name = 'Robin Shop'`);
      const res = await app.inject({
        method: "POST", url: "/api/auth/pin", remoteAddress: "172.18.0.5",
        headers: { ...H, "x-forwarded-for": "203.0.113.200" }, payload: { user_id: u.id, pin: "1357" },
      });
      assert.equal(res.statusCode, 200);
      shopCookie = cookieOf(res);
      truck = (await one(`SELECT id FROM vehicles WHERE truck_code = 'T040'`)).id;
      const body = submitBody({
        vehicle_id: truck, inspection_date: "2026-03-14", mileage: 77123, inspector_name: "Casey Crew",
        comments: 'Said "check it", then left\n=HYPERLINK("http://evil")', existing_notes: "- dent, rear", damage: [],
      });
      body.items = (body.items as { checklist_item_id: number; result: string; note?: string }[]).map((it, n) =>
        n === 0 ? { ...it, result: "repair", note: "Mirror cracked" } : n === 1 ? { ...it, result: "repair", note: "Wiper torn" } : it);
      const ins = await inject("POST", "/inspections", { cookie: crewCookie, body });
      assert.equal(ins.statusCode, 201, ins.body);
      inspectionId = ins.json().id;
    });

    test("who can download what", async () => {
      for (const kind of ["inspections", "repairs", "maintenance", "trucks"]) {
        assert.equal((await inject("GET", `/export/${kind}.csv`, { cookie: crewCookie })).statusCode, 403, kind);
        assert.equal((await inject("GET", `/export/${kind}.csv`, { cookie: supCookie })).statusCode, 200, kind);
        assert.equal((await inject("GET", `/export/${kind}.csv`)).statusCode, 401, kind);
      }
      assert.equal((await inject("GET", "/export/inspections.csv", { cookie: shopCookie })).statusCode, 403, "shop doesn't get inspections");
      for (const kind of ["repairs", "maintenance", "trucks"]) {
        assert.equal((await inject("GET", `/export/${kind}.csv`, { cookie: shopCookie })).statusCode, 200, kind);
      }
      assert.equal((await inject("GET", "/export/inspections.csv?from=2026-13-01", { cookie: supCookie })).statusCode, 400);
      assert.equal((await inject("GET", "/export/inspections.csv?from=2026-02-01&to=2026-01-01", { cookie: supCookie })).statusCode, 400);
      assert.equal((await inject("GET", "/export/repairs.csv?vehicle_id=abc", { cookie: supCookie })).statusCode, 400);
    });

    test("inspections: one row each, filtered by truck and date, notes kept exactly and formula-safe", async () => {
      const all = await csv(supCookie, "inspections.csv");
      assert.equal(all.rows.length, Number((await one(`SELECT count(*) AS n FROM live_inspections`)).n), "live inspections only");
      assert.match(all.name, /^inspections_\d{4}-\d{2}-\d{2}\.csv$/);
      const one1 = await csv(supCookie, `inspections.csv?vehicle_id=${truck}&from=2026-03-14&to=2026-03-14`);
      assert.equal(one1.name, "inspections_T040_2026-03-14_to_2026-03-14.csv");
      assert.equal(one1.rows.length, 1);
      const r = one1.rows[0];
      assert.equal(r["Date"], "2026-03-14");
      assert.equal(r["Truck"], "T040");
      assert.equal(r["Mileage"], "77123");
      assert.equal(r["Repairs"], "2");
      assert.equal(r["Repairs still open"], "2");
      assert.match(r["Repairs needed"], /: Mirror cracked; .+: Wiper torn$/);
      assert.equal(r["Comments"], `Said "check it", then left\n=HYPERLINK("http://evil")`, "a line break inside a cell survives");
      assert.equal(r["Existing damage noted"], "'- dent, rear", "a leading minus can't start a formula");
      assert.equal(r["Status"], "Submitted");
      assert.equal(r["Archived"], "No");
      assert.match(r["Link"], new RegExp(`/#/inspection/${inspectionId}$`));

      // Archived ones only when asked for.
      const sup = await inject("POST", `/inspections/${inspectionId}/archive`, { cookie: supCookie, body: { reason: "CSV test" } });
      assert.equal(sup.statusCode, 200, sup.body);
      assert.equal((await csv(supCookie, `inspections.csv?vehicle_id=${truck}&from=2026-03-14&to=2026-03-14`)).rows.length, 0);
      const withArchived = await csv(supCookie, `inspections.csv?vehicle_id=${truck}&from=2026-03-14&to=2026-03-14&include=1`);
      assert.equal(withArchived.rows[0]["Archived"], "Yes");
      assert.equal((await inject("POST", `/inspections/${inspectionId}/unarchive`, { cookie: supCookie, body: {} })).statusCode, 200);
    });

    test("repairs: the open ones match the repairs board; fixed ones only when asked for", async () => {
      const board = (await inject("GET", "/repairs", { cookie: supCookie })).json();
      const open = await csv(shopCookie, "repairs.csv");
      assert.equal(open.rows.length, board.length);
      assert.match(open.name, /^open_repairs_/);
      const mine = await csv(supCookie, `repairs.csv?vehicle_id=${truck}&from=2026-03-14&to=2026-03-14`);
      assert.deepEqual(mine.rows.map((r) => r["Note"]), ["Mirror cracked", "Wiper torn"]);
      assert.equal(mine.rows[0]["Status"], "Open");
      assert.equal(mine.rows[0]["Reported"], "2026-03-14");

      const item = await one(`SELECT id FROM inspection_items WHERE inspection_id = $1 AND note = 'Wiper torn'`, [inspectionId]);
      assert.equal((await inject("POST", `/inspection-items/${item.id}/resolve`, { cookie: supCookie, body: { note: "New blade" } })).statusCode, 200);
      const stillOpen = await csv(supCookie, `repairs.csv?vehicle_id=${truck}&from=2026-03-14&to=2026-03-14`);
      assert.deepEqual(stillOpen.rows.map((r) => r["Note"]), ["Mirror cracked"]);
      const both = await csv(supCookie, `repairs.csv?vehicle_id=${truck}&from=2026-03-14&to=2026-03-14&include=1`);
      const fixed = both.rows.find((r) => r["Note"] === "Wiper torn")!;
      assert.equal(fixed["Status"], "Fixed");
      assert.equal(fixed["Fixed by"], "Sam Super");
      assert.equal(fixed["How it was fixed"], "New blade");
      assert.match(fixed["Fixed at"], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    test("maintenance: live entries, every type of work with its next due; voided ones only when asked for", async () => {
      const live = Number((await one(`SELECT count(*) AS n FROM service_logs WHERE voided_at IS NULL`)).n);
      const all = Number((await one(`SELECT count(*) AS n FROM service_logs`)).n);
      assert.ok(all > live, "the suite has a voided entry by now");
      assert.equal((await csv(shopCookie, "maintenance.csv")).rows.length, live);
      const withVoided = await csv(shopCookie, "maintenance.csv?include=1");
      assert.equal(withVoided.rows.length, all);
      assert.ok(withVoided.rows.some((r) => r["Voided"] === "Yes" && r["Void reason"]));
      const multi = await one(`SELECT id FROM service_logs WHERE voided_at IS NULL AND jsonb_array_length(work) > 1 ORDER BY id LIMIT 1`);
      assert.ok(multi, "the suite logged an entry with several types of work");
      const row = (await csv(supCookie, "maintenance.csv")).rows.find((r) => r["Link"].endsWith(`/#/service/${multi.id}`))!;
      assert.match(row["Work"], /; /, "each type of work is listed");
    });

    test("trucks: the ones in service; retired ones only when asked for", async () => {
      const active = Number((await one(`SELECT count(*) AS n FROM vehicles WHERE active`)).n);
      const every = Number((await one(`SELECT count(*) AS n FROM vehicles`)).n);
      const list = await csv(shopCookie, "trucks.csv");
      assert.equal(list.rows.length, active);
      assert.equal((await csv(shopCookie, "trucks.csv?include=1")).rows.length, every);
      const t040 = list.rows.find((r) => r["Truck"] === "T040")!;
      assert.equal(t040["Open repairs"], "1");
      assert.equal(t040["Last inspection"] >= "2026-03-14", true);
      assert.equal(t040["In service"], "Yes");
    });
  });

  describe("repair tickets", () => {
    let shopCookie = "";
    let truckA = 0;
    let truckB = 0;
    const ids: Record<string, number> = {};
    let t1 = 0;
    let t2 = 0;
    const make = (cookie: string, body: Record<string, unknown>) =>
      inject("POST", "/repair-tickets", { cookie, body: { client_id: randomUUID(), vehicle_id: truckA, ...body } });

    before(async () => {
      const u = await one(`SELECT id FROM users WHERE name = 'Robin Shop'`);
      const res = await app.inject({
        method: "POST", url: "/api/auth/pin", remoteAddress: "172.18.0.5",
        headers: { ...H, "x-forwarded-for": "203.0.113.210" }, payload: { user_id: u.id, pin: "1357" },
      });
      shopCookie = cookieOf(res);
      truckA = (await one(`SELECT id FROM vehicles WHERE truck_code = 'T042'`)).id;
      truckB = (await one(`SELECT id FROM vehicles WHERE truck_code = 'T047'`)).id;
      const submit = async (truck: number, notes: string[], photo?: string) => {
        const body = submitBody({ vehicle_id: truck, inspection_date: "2026-11-12", mileage: 81234, damage: [] });
        body.items = (body.items as { checklist_item_id: number; result: string; note?: string }[]).map((it, n) =>
          n < notes.length ? { ...it, result: "repair", note: notes[n] } : it);
        if (photo) body.photos = [{ id: photo, caption: "Squeal", checklist_item_id: (body.items as { checklist_item_id: number }[])[0].checklist_item_id }];
        const r = await inject("POST", "/inspections", { cookie: crewCookie, body });
        assert.equal(r.statusCode, 201, r.body);
        for (const it of await q(`SELECT id, note FROM inspection_items WHERE inspection_id = $1 AND result = 'repair'`, [r.json().id])) {
          ids[it.note] = it.id;
        }
      };
      const { id: photoId } = await uploadPhoto(crewCookie);
      await submit(truckA, ["Brakes squeal", "Tail light out", "Seat torn"], photoId);
      await submit(truckB, ["Other truck's mirror"]);
    });

    test("who can make one, and only this truck's open repairs go on it; a retry doesn't make a second", async () => {
      assert.equal((await make(crewCookie, { item_ids: [ids["Brakes squeal"]] })).statusCode, 403);
      assert.equal((await make(supCookie, { item_ids: [] })).statusCode, 400);
      assert.equal((await make(supCookie, { client_id: "nope", item_ids: [ids["Brakes squeal"]] })).statusCode, 400);
      const other = await make(supCookie, { item_ids: [ids["Brakes squeal"], ids["Other truck's mirror"]] });
      assert.equal(other.statusCode, 422);
      assert.deepEqual(other.json().details, { code: "bad_repairs", items: [ids["Other truck's mirror"]] });
      assert.equal((await inject("POST", `/inspection-items/${ids["Seat torn"]}/resolve`, { cookie: supCookie, body: { note: "Patched" } })).statusCode, 200);
      assert.equal((await make(supCookie, { item_ids: [ids["Seat torn"]] })).statusCode, 422, "a fixed repair can't go on a ticket");

      const body = {
        client_id: randomUUID(), vehicle_id: truckA, item_ids: [ids["Brakes squeal"], ids["Tail light out"]],
        sent_to: "Robin's shop", note: "Call before\nanything over $300",
      };
      const a = await inject("POST", "/repair-tickets", { cookie: shopCookie, body });
      assert.equal(a.statusCode, 201, a.body);
      t1 = a.json().id;
      assert.equal(a.json().number, `RT-${String(t1).padStart(4, "0")}`);
      const again = await inject("POST", "/repair-tickets", { cookie: shopCookie, body });
      assert.equal(again.statusCode, 200);
      assert.deepEqual(again.json(), { id: t1, number: a.json().number, duplicate: true });
      const b = await make(supCookie, { item_ids: [ids["Brakes squeal"]], sent_to: "Corner Tire" });
      assert.equal(b.statusCode, 201);
      t2 = b.json().id;
      assert.equal(Number((await one(`SELECT count(*) AS n FROM repair_tickets WHERE vehicle_id = $1`, [truckA])).n), 2);
    });

    test("a ticket's repairs, the truck's list, and which repairs are on a ticket", async () => {
      const t = (await inject("GET", `/repair-tickets/${t1}`, { cookie: shopCookie })).json();
      assert.equal(t.truck_code, "T042");
      assert.equal(t.sent_to, "Robin's shop");
      assert.deepEqual(t.items.map((it: { position: number; note: string }) => [it.position, it.note]), [[1, "Brakes squeal"], [2, "Tail light out"]]);
      assert.equal(t.items[0].photo_ids.length, 1);
      assert.equal(JSON.stringify(t).includes("file_path"), false, "no storage paths sent to the phone");
      assert.equal((await inject("GET", `/repair-tickets/${t1}`, { cookie: crewCookie })).statusCode, 403);

      const list = (await inject("GET", `/vehicles/${truckA}/repair-tickets`, { cookie: supCookie })).json();
      assert.deepEqual(list.map((x: { id: number; items: number; fixed: number }) => [x.id, x.items, x.fixed]), [[t2, 1, 0], [t1, 2, 0]]);
      const board = (await inject("GET", `/repairs?vehicle_id=${truckA}`, { cookie: supCookie })).json();
      const on = (note: string) => board.find((r: { note: string }) => r.note === note).ticket_ids;
      assert.deepEqual(on("Brakes squeal"), [t1, t2]);
      assert.deepEqual(on("Tail light out"), [t1]);
      const truck = (await inject("GET", `/vehicles/${truckA}`, { cookie: crewCookie })).json();
      assert.deepEqual(truck.openRepairs.find((r: { note: string }) => r.note === "Tail light out").ticket_ids, [t1]);
      const names = (await inject("GET", "/repair-tickets/sent-to", { cookie: shopCookie })).json();
      assert.deepEqual(names.slice(0, 2), ["Corner Tire", "Robin's shop"]);
      const csvRes = await inject("GET", `/export/repairs.csv?vehicle_id=${truckA}`, { cookie: supCookie });
      assert.match(csvRes.body, new RegExp(`RT-${String(t1).padStart(4, "0")}; RT-${String(t2).padStart(4, "0")}`));
    });

    test("the ticket PDF: number, truck, problems, photos and blank lines for the shop", async () => {
      const { loadTicket } = await import("../src/routes/tickets.ts");
      const { ticketPdfHtml } = await import("../src/ticket-pdf.ts");
      const html = await ticketPdfHtml((await loadTicket(t1))!);
      const num = `RT-${String(t1).padStart(4, "0")}`;
      for (const s of [num, "T042", "Robin&#39;s shop", "Call before\nanything over $300", "Brakes squeal", "Tail light out",
        "Work done", "Parts used", "Signature", "11/12/2026"]) assert.ok(html.includes(s), s);
      assert.match(html, /<img src="data:image\/jpeg;base64,/, "the repair's photo is on it");
      assert.ok(!html.includes(">VOID<"));
      const pdf = await inject("GET", `/repair-tickets/${t1}/pdf`, { cookie: shopCookie });
      assert.equal(pdf.statusCode, 200);
      assert.equal(pdf.headers["content-type"], "application/pdf");
      assert.equal(pdf.rawPayload.subarray(0, 4).toString(), "%PDF");
      assert.match(String(pdf.headers["content-disposition"]), new RegExp(`^attachment; filename="T042_repair_ticket_${num}.pdf"`));
      const inline = await inject("GET", `/repair-tickets/${t1}/pdf?inline=1`, { cookie: shopCookie });
      assert.match(String(inline.headers["content-disposition"]), /^inline;/);
      assert.equal((await inject("GET", `/repair-tickets/${t1}/pdf`, { cookie: crewCookie })).statusCode, 403);
    });

    test("a repair fixed in the maintenance log shows as fixed on the ticket", async () => {
      const e = await inject("POST", "/service-logs", {
        cookie: shopCookie,
        body: { client_id: randomUUID(), vehicle_id: truckA, service_date: "2026-11-14", mileage: 81300, category: "repair",
          description: "New tail light bulb", repair_item_ids: [ids["Tail light out"]] },
      });
      assert.equal(e.statusCode, 201, e.body);
      const t = (await inject("GET", `/repair-tickets/${t1}`, { cookie: supCookie })).json();
      const tail = t.items.find((it: { note: string }) => it.note === "Tail light out");
      assert.ok(tail.resolved_at);
      assert.equal(tail.service_log_id, e.json().id);
      const list = (await inject("GET", `/vehicles/${truckA}/repair-tickets`, { cookie: supCookie })).json();
      assert.deepEqual(list.find((x: { id: number }) => x.id === t1).fixed, 1);
      assert.ok((await (await import("../src/ticket-pdf.ts")).ticketPdfHtml(
        (await (await import("../src/routes/tickets.ts")).loadTicket(t1))!)).includes("Fixed 11/"));
    });

    test("void: a reason, once; voided tickets drop off the repairs; nothing about a ticket can be changed or erased", async () => {
      assert.equal((await inject("POST", `/repair-tickets/${t2}/void`, { cookie: shopCookie, body: {} })).statusCode, 400);
      assert.equal((await inject("POST", `/repair-tickets/${t2}/void`, { cookie: crewCookie, body: { reason: "x" } })).statusCode, 403);
      assert.equal((await inject("POST", `/repair-tickets/${t2}/void`, { cookie: shopCookie, body: { reason: "Sent to the wrong shop" } })).statusCode, 200);
      assert.equal((await inject("POST", `/repair-tickets/${t2}/void`, { cookie: shopCookie, body: { reason: "again" } })).statusCode, 409);
      const t = (await inject("GET", `/repair-tickets/${t2}`, { cookie: supCookie })).json();
      assert.equal(t.voided, true);
      assert.equal(t.void_reason, "Sent to the wrong shop");
      assert.equal(t.voided_by_name, "Robin Shop");
      const board = (await inject("GET", `/repairs?vehicle_id=${truckA}`, { cookie: supCookie })).json();
      assert.deepEqual(board.find((r: { note: string }) => r.note === "Brakes squeal").ticket_ids, [t1]);
      const { loadTicket } = await import("../src/routes/tickets.ts");
      const { ticketPdfHtml } = await import("../src/ticket-pdf.ts");
      const html = await ticketPdfHtml((await loadTicket(t2))!);
      assert.ok(html.includes(">VOID<") && html.includes("Sent to the wrong shop"));

      await assert.rejects(q(`DELETE FROM repair_tickets WHERE id = $1`, [t1]));
      await assert.rejects(q(`UPDATE repair_tickets SET note = 'changed' WHERE id = $1`, [t1]));
      await assert.rejects(q(`UPDATE repair_tickets SET void_reason = 'changed' WHERE id = $1`, [t2]), "a void can't be edited");
      await assert.rejects(q(`DELETE FROM repair_ticket_items WHERE ticket_id = $1`, [t1]));
      await assert.rejects(q(`UPDATE repair_ticket_items SET position = 9 WHERE ticket_id = $1`, [t1]));
      assert.equal(Number((await one(`SELECT count(*) AS n FROM repair_ticket_items WHERE ticket_id = $1`, [t1])).n), 2);
    });
  });

  describe("checklist editor", () => {
    let adminCookie = "";
    type Ck = { id: number; section: string; label: string; active: boolean; answered: number };
    const editor = async () => (await inject("GET", "/admin/checklist", { cookie: adminCookie })).json() as
      { sections: { key: string }[]; items: Ck[]; changes: { action: string; old_label: string; new_label: string }[] };
    const formItems = async () => (await inject("GET", "/form-config", { cookie: crewCookie })).json() as
      { checklist: { id: number; section: string; label: string }[]; as_of: string };
    const add = (section: string, label: string) => inject("POST", "/admin/checklist", { cookie: adminCookie, body: { section, label } });
    const act = (id: number, what: string, body: unknown = {}) =>
      inject("POST", `/admin/checklist/${id}/${what}`, { cookie: adminCookie, body });
    /** A submit body answering exactly these items, all OK. */
    const bodyFor = (items: { id: number; section: string }[], over: Record<string, unknown> = {}) => submitBody({
      inspection_date: "2026-11-16", mileage: 61000, damage: [], ...over,
      items: items.filter((c) => c.section !== "trailer").map((c) => ({ checklist_item_id: c.id, result: "ok" })),
    });

    before(async () => {
      const res = await app.inject({
        method: "POST", url: "/api/auth/login", remoteAddress: "172.18.0.5",
        headers: { ...H, "x-forwarded-for": "203.0.113.220" }, payload: { email: "admin@test.local", password: "admin-password-1" },
      });
      assert.equal(res.statusCode, 200);
      adminCookie = cookieOf(res);
    });

    test("only admins can see or change it", async () => {
      assert.equal((await inject("GET", "/admin/checklist", { cookie: supCookie })).statusCode, 403);
      assert.equal((await inject("GET", "/admin/checklist", { cookie: crewCookie })).statusCode, 403);
      assert.equal((await add("exterior", "Nope")).statusCode, 201, "an admin can");
      assert.equal((await inject("POST", "/admin/checklist", { cookie: supCookie, body: { section: "exterior", label: "X" } })).statusCode, 403);
      const e = await editor();
      assert.deepEqual(e.sections.map((s) => s.key), ["exterior", "interior", "trailer"]);
      const nope = e.items.find((i) => i.label === "Nope")!;
      assert.equal((await act(nope.id, "retire")).statusCode, 200);
    });

    test("add, reword, reorder, retire and restore, each kept in the history; nothing can be deleted", async () => {
      const a = await add("exterior", "  Fire   extinguisher charged ");
      assert.equal(a.statusCode, 201, a.body);
      const fire = a.json();
      assert.equal(fire.label, "Fire extinguisher charged", "extra spaces are tidied");
      let form = await formItems();
      const ext = form.checklist.filter((c) => c.section === "exterior");
      assert.equal(ext.at(-1)!.id, fire.id, "a new item goes at the end of its section");
      assert.equal((await add("exterior", "FIRE EXTINGUISHER CHARGED")).statusCode, 409, "no duplicates in a section");
      assert.equal((await add("interior", "Fire extinguisher charged")).statusCode, 201, "the same words can be in another section");
      assert.equal((await add("exterior", "  ")).statusCode, 400);
      assert.equal((await add("roof", "Antenna")).statusCode, 400);

      assert.equal((await inject("PATCH", `/admin/checklist/${fire.id}`, { cookie: adminCookie, body: { label: "Fire extinguisher charged and tagged" } })).statusCode, 200);
      assert.equal((await act(fire.id, "move", { direction: "up" })).json().moved, true);
      form = await formItems();
      const ext2 = form.checklist.filter((c) => c.section === "exterior");
      assert.equal(ext2.at(-2)!.label, "Fire extinguisher charged and tagged", "moved up one place");
      assert.equal((await act(ext2[0].id, "move", { direction: "up" })).json().moved, false, "the first can't go higher");
      assert.equal((await act(fire.id, "move", { direction: "sideways" })).statusCode, 400);

      assert.equal((await act(fire.id, "retire")).statusCode, 200);
      assert.equal((await act(fire.id, "retire")).statusCode, 409);
      assert.ok(!(await formItems()).checklist.some((c) => c.id === fire.id), "a retired item is off the form");
      assert.equal((await act(fire.id, "restore")).statusCode, 200);
      assert.equal((await formItems()).checklist.filter((c) => c.section === "exterior").at(-1)!.id, fire.id, "restored at the end");

      const e = await editor();
      assert.deepEqual(e.changes.slice(0, 5).map((c) => c.action), ["restored", "retired", "moved", "renamed", "added"]);
      assert.deepEqual([e.changes[3].old_label, e.changes[3].new_label], ["Fire extinguisher charged", "Fire extinguisher charged and tagged"]);
      await assert.rejects(q(`DELETE FROM checklist_items WHERE id = $1`, [fire.id]));
      await assert.rejects(q(`DELETE FROM checklist_changes`));
      await assert.rejects(q(`UPDATE checklist_changes SET new_label = 'x'`));
    });

    test("a form opened before a change still sends; the original items can't be skipped", async () => {
      const before = await formItems();
      const visible = before.checklist.filter((c) => c.section !== "trailer");
      const added = (await add("exterior", "Added while a form was open")).json();
      const dropped = visible.find((c) => c.section === "interior")!;
      assert.equal((await act(dropped.id, "retire")).statusCode, 200);

      // The phone sends the checklist it showed: no answer for the new item, an answer for the one retired meanwhile.
      const ok = await inject("POST", "/inspections", { cookie: crewCookie, body: bodyFor(visible, { checklist_as_of: before.as_of }) });
      assert.equal(ok.statusCode, 201, ok.body);
      const saved = await q(`SELECT checklist_item_id FROM inspection_items WHERE inspection_id = $1`, [ok.json().id]);
      const ids = new Set(saved.map((r: { checklist_item_id: number }) => r.checklist_item_id));
      assert.ok(ids.has(dropped.id) && !ids.has(added.id));

      // Without saying which checklist it showed (an older draft), every current item is needed.
      const old = await inject("POST", "/inspections", { cookie: crewCookie, body: bodyFor(visible) });
      assert.equal(old.statusCode, 422);
      assert.deepEqual(old.json().details.missing, [added.id]);
      // Claiming a very old checklist doesn't get out of answering the original items.
      const sneaky = await inject("POST", "/inspections", { cookie: crewCookie, body: bodyFor([], { checklist_as_of: "1999-01-01T00:00:00Z" }) });
      assert.equal(sneaky.statusCode, 422);
      assert.ok(sneaky.json().details.missing.length >= 30);
      // A current form answers the new item and leaves out the retired one.
      const now = await formItems();
      const fresh = await inject("POST", "/inspections", { cookie: crewCookie, body: bodyFor(now.checklist, { checklist_as_of: now.as_of }) });
      assert.equal(fresh.statusCode, 201, fresh.body);
      assert.equal((await act(dropped.id, "restore")).statusCode, 200);
      assert.equal((await act(added.id, "retire")).statusCode, 200);
    });

    test("old inspections keep their wording and order after items are reworded or moved", async () => {
      const ins = await one(`SELECT id FROM inspections ORDER BY created_at LIMIT 1`);
      const before = (await inject("GET", `/inspections/${ins.id}`, { cookie: supCookie })).json().items
        .map((i: { label: string }) => i.label);
      const first = (await formItems()).checklist.find((c) => c.section === "exterior")!;
      await inject("PATCH", `/admin/checklist/${first.id}`, { cookie: adminCookie, body: { label: "Engine oil (dipstick)" } });
      await act(first.id, "move", { direction: "down" });
      const after = (await inject("GET", `/inspections/${ins.id}`, { cookie: supCookie })).json().items
        .map((i: { label: string }) => i.label);
      assert.deepEqual(after, before);
      const html = await pdfHtmlFor(ins.id);
      assert.ok(!html.includes("Engine oil (dipstick)"), "the PDF keeps the old wording");
      // Put it back as it was.
      await act(first.id, "move", { direction: "up" });
      await inject("PATCH", `/admin/checklist/${first.id}`, { cookie: adminCookie, body: { label: first.label } });
    });
  });

  describe("yard inspections", () => {
    let shopCookie = "";
    let adminCookie = "";
    let yardId = 0;
    let walkId = "";
    let oldPhoto = "";
    type Item = { id: number; section: string; label: string };
    const todayStr = () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const config = async () => (await inject("GET", "/yard-config", { cookie: supCookie })).json() as
      { sections: { key: string }[]; checklist: Item[]; as_of: string };
    /** A walk answering these items: OK, except notes given for problems. */
    const walkBody = (items: Item[], problems: Record<number, string> = {}, over: Record<string, unknown> = {}) => ({
      client_id: randomUUID(), yard_id: yardId, inspection_date: todayStr(), inspector_name: "Sam Super",
      comments: "Hot day, piles low", signature: PNG,
      items: items.map((c) => problems[c.id] !== undefined
        ? { checklist_item_id: c.id, result: "repair", note: problems[c.id] }
        : { checklist_item_id: c.id, result: "ok" }),
      photos: [], ...over,
    });
    const signIn = async (path: string, payload: object, ip: string) => cookieOf(await app.inject({
      method: "POST", url: `/api/auth/${path}`, remoteAddress: "172.18.0.5", headers: { ...H, "x-forwarded-for": ip }, payload,
    }));

    before(async () => {
      const shop = await one(`SELECT id FROM users WHERE name = 'Robin Shop'`);
      shopCookie = await signIn("pin", { user_id: shop.id, pin: "1357" }, "203.0.113.240");
      adminCookie = await signIn("login", { email: "admin@test.local", password: "admin-password-1" }, "203.0.113.241");
      yardId = (await one(`SELECT id FROM yards WHERE code = 'MAIN'`)).id;
    });

    test("supervisors walk the yard; the shop can look; crews can't", async () => {
      assert.equal((await inject("GET", "/yard-config", { cookie: crewCookie })).statusCode, 403);
      assert.equal((await inject("GET", "/yard-config", { cookie: shopCookie })).statusCode, 403);
      assert.equal((await inject("GET", "/yards", { cookie: crewCookie })).statusCode, 403);
      assert.equal((await inject("GET", "/yards", { cookie: shopCookie })).statusCode, 200);
      const cfg = await config();
      assert.deepEqual(cfg.sections.map((s) => s.key), ["fire", "fuel", "equipment", "access"]);
      assert.equal(cfg.checklist.length, 12);
      assert.ok(cfg.checklist.some((c) => c.label === "Fire extinguishers present, charged and tagged"));
      const yards = (await inject("GET", "/yards", { cookie: supCookie })).json();
      assert.deepEqual(yards.map((y: { code: string; walked_today: boolean; open_findings: number }) => [y.code, y.walked_today, y.open_findings]),
        [["MAIN", false, 0]]);
    });

    test("a walk needs every item, a note for each problem and a signature; a retry doesn't make a second", async () => {
      const cfg = await config();
      const [ext, rags] = [cfg.checklist[0], cfg.checklist.find((c) => c.label.startsWith("Oily rags"))!];
      assert.equal((await inject("POST", "/yard-inspections", { cookie: crewCookie, body: walkBody(cfg.checklist) })).statusCode, 403);
      const short = await inject("POST", "/yard-inspections", { cookie: supCookie, body: walkBody(cfg.checklist.slice(1)) });
      assert.equal(short.statusCode, 422);
      assert.deepEqual(short.json().details.missing, [ext.id]);
      const noNote = await inject("POST", "/yard-inspections", { cookie: supCookie, body: walkBody(cfg.checklist, { [ext.id]: "" }) });
      assert.equal(noNote.statusCode, 422);
      assert.equal((await inject("POST", "/yard-inspections", { cookie: supCookie, body: walkBody(cfg.checklist, {}, { signature: null }) })).statusCode, 400);

      // A photo uploaded a while ago (older than the orphan clean-up's 7 days) goes on the walk.
      const up = await uploadPhoto(supCookie);
      oldPhoto = up.id;
      await q(`UPDATE photos SET created_at = now() - interval '30 days' WHERE id = $1`, [oldPhoto]);
      const body = walkBody(cfg.checklist, { [ext.id]: "Shop extinguisher tag expired", [rags.id]: "Rags in an open bucket" },
        { photos: [{ id: oldPhoto, caption: "Bucket", checklist_item_id: rags.id }] });
      const res = await inject("POST", "/yard-inspections", { cookie: supCookie, body });
      assert.equal(res.statusCode, 201, res.body);
      walkId = res.json().id;
      assert.equal(res.json().failed, 2);
      const again = await inject("POST", "/yard-inspections", { cookie: supCookie, body });
      assert.equal(again.statusCode, 200);
      assert.deepEqual(again.json(), { id: walkId, duplicate: true });
      assert.equal(Number((await one(`SELECT count(*) AS n FROM yard_inspections`)).n), 1);

      const yards = (await inject("GET", "/yards", { cookie: supCookie })).json();
      assert.equal(yards[0].walked_today, true);
      assert.equal(yards[0].open_findings, 2);
      const detail = (await inject("GET", `/yard-inspections/${walkId}`, { cookie: shopCookie })).json();
      assert.equal(detail.items.length, 12);
      const rag = detail.items.find((i: { label: string }) => i.label.startsWith("Oily rags"));
      assert.equal(rag.result, "repair");
      assert.deepEqual(detail.photos.map((p: { id: string; item_id: number }) => [p.id, p.item_id]), [[oldPhoto, rag.id]]);
      assert.equal(JSON.stringify(detail).includes("signature_path"), false);
      const sig = await inject("GET", `/yard-inspections/${walkId}/signature`, { cookie: supCookie });
      assert.equal(sig.headers["content-type"], "image/png");
      const hist = (await inject("GET", `/yards/${yardId}/inspections`, { cookie: shopCookie })).json();
      assert.deepEqual(hist.map((w: { id: string; failed: number; open: number }) => [w.id, w.failed, w.open]), [[walkId, 2, 2]]);
    });

    test("a walk's photos are kept: never reused elsewhere, never cleaned up; the walk can't be changed or erased", async () => {
      await cleanupOrphanPhotos(() => {});
      assert.ok(await one(`SELECT 1 FROM photos WHERE id = $1`, [oldPhoto]), "the 30-day-old photo on the walk is kept");
      // A truck inspection answering today's checklist, trying to use the walk's photo.
      const truckForm = (await inject("GET", "/form-config", { cookie: crewCookie })).json();
      const reuse = await inject("POST", "/inspections", { cookie: supCookie, body: submitBody({
        checklist_as_of: truckForm.as_of, photos: [{ id: oldPhoto, caption: null }],
        items: truckForm.checklist.filter((c: { section: string }) => c.section !== "trailer")
          .map((c: { id: number }) => ({ checklist_item_id: c.id, result: "ok" })),
      }) });
      assert.equal(reuse.statusCode, 422);
      assert.equal(reuse.json().details.code, "photos_missing");
      await assert.rejects(q(`DELETE FROM photos WHERE id = $1`, [oldPhoto]));
      await assert.rejects(q(`UPDATE yard_inspections SET comments = 'changed' WHERE id = $1`, [walkId]));
      await assert.rejects(q(`DELETE FROM yard_inspections WHERE id = $1`, [walkId]));
      await assert.rejects(q(`UPDATE yard_inspection_items SET note = 'changed' WHERE yard_inspection_id = $1`, [walkId]));
      await assert.rejects(q(`DELETE FROM yard_inspection_items WHERE yard_inspection_id = $1`, [walkId]));
      await assert.rejects(q(`DELETE FROM yard_checklist_items`));
      await assert.rejects(q(`DELETE FROM yards`));
    });

    test("findings stay open, on the board and home screen, until a supervisor resolves them with a note", async () => {
      const findings = (await inject("GET", "/yard-findings", { cookie: shopCookie })).json();
      assert.deepEqual(findings.map((f: { note: string }) => f.note).sort(), ["Rags in an open bucket", "Shop extinguisher tag expired"]);
      assert.equal(findings[0].yard_name, "Main yard");
      assert.equal((await inject("GET", "/yard-findings", { cookie: crewCookie })).statusCode, 403);
      const rag = findings.find((f: { note: string }) => f.note === "Rags in an open bucket");
      assert.equal(rag.photo_ids.length, 1);
      assert.equal((await inject("POST", `/yard-findings/${rag.id}/resolve`, { cookie: shopCookie, body: { note: "x" } })).statusCode, 403);
      assert.equal((await inject("POST", `/yard-findings/${rag.id}/resolve`, { cookie: supCookie, body: { note: " " } })).statusCode, 400);
      assert.equal((await inject("POST", `/yard-findings/${rag.id}/resolve`, { cookie: supCookie, body: { note: "Metal can bought" } })).statusCode, 200);
      assert.equal((await inject("POST", `/yard-findings/${rag.id}/resolve`, { cookie: supCookie, body: { note: "again" } })).statusCode, 409);
      assert.equal((await inject("GET", "/yard-findings", { cookie: supCookie })).json().length, 1);
      assert.equal((await inject("GET", "/yards", { cookie: supCookie })).json()[0].open_findings, 1);
      const item = (await inject("GET", `/yard-inspections/${walkId}`, { cookie: supCookie })).json().items
        .find((i: { id: number }) => i.id === rag.id);
      assert.equal(item.resolution_note, "Metal can bought");
      assert.equal(item.resolved_by_name, "Sam Super");
    });

    test("the walk PDF: yard, date, every item with OK or Repair, notes, how findings were resolved, signature and photos", async () => {
      const { loadYardInspection } = await import("../src/routes/yard.ts");
      const { yardPdfHtml } = await import("../src/yard-pdf.ts");
      const html = await yardPdfHtml((await loadYardInspection(walkId))!);
      for (const s of ["Yard Inspection", "Main yard", "Fire safety", "Fire extinguishers present, charged and tagged",
        "Shop extinguisher tag expired", "Resolved", "Metal can bought", "Hot day, piles low", "Sam Super"]) assert.ok(html.includes(s), s);
      assert.equal((html.match(/<img src="data:image\/png;base64,/g) || []).length >= 1, true, "signature");
      assert.match(html, /<img src="data:image\/jpeg;base64,/, "the photo");
      const pdf = await inject("GET", `/yard-inspections/${walkId}/pdf`, { cookie: supCookie });
      assert.equal(pdf.statusCode, 200);
      assert.equal(pdf.rawPayload.subarray(0, 4).toString(), "%PDF");
      assert.equal((await inject("GET", `/yard-inspections/${walkId}/pdf`, { cookie: shopCookie })).statusCode, 403);
    });

    test("the yard checklist is edited like the truck one, without touching it; an open walk still sends", async () => {
      const truckBefore = (await inject("GET", "/form-config", { cookie: crewCookie })).json().checklist.length;
      const before = await config();
      const add = await inject("POST", "/admin/yard-checklist", { cookie: adminCookie, body: { section: "fire", label: "Hose reel reachable" } });
      assert.equal(add.statusCode, 201, add.body);
      assert.equal((await inject("POST", "/admin/yard-checklist", { cookie: adminCookie, body: { section: "exterior", label: "X" } })).statusCode, 400);
      assert.equal((await inject("GET", "/admin/yard-checklist", { cookie: supCookie })).statusCode, 403);
      const ed = (await inject("GET", "/admin/yard-checklist", { cookie: adminCookie })).json();
      assert.equal(ed.changes[0].new_label, "Hose reel reachable");
      assert.equal((await inject("GET", "/form-config", { cookie: crewCookie })).json().checklist.length, truckBefore, "the truck checklist is unchanged");

      const open = await inject("POST", "/yard-inspections", { cookie: supCookie,
        body: walkBody(before.checklist, {}, { checklist_as_of: before.as_of, inspection_date: "2026-11-16" }) });
      assert.equal(open.statusCode, 201, open.body);
      const old = await inject("POST", "/yard-inspections", { cookie: supCookie, body: walkBody(before.checklist) });
      assert.equal(old.statusCode, 422);
      assert.deepEqual(old.json().details.missing, [add.json().id]);
      assert.equal((await inject("POST", `/admin/yard-checklist/${add.json().id}/retire`, { cookie: adminCookie, body: {} })).statusCode, 200);
    });
  });

  describe("equipment inspections", () => {
    let shopCookie = "";
    let adminCookie = "";
    const t: Record<string, number> = {}; // trailers by number
    const e: Record<string, number> = {}; // equipment by tag
    let checkId = "";
    let oldPhoto = "";
    type Item = { id: number; section: string; label: string };
    const ymd = (daysBack = 0) => {
      const d = new Date(Date.now() - daysBack * 86400_000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const signIn = async (path: string, payload: object, ip: string) => cookieOf(await app.inject({
      method: "POST", url: `/api/auth/${path}`, remoteAddress: "172.18.0.5", headers: { ...H, "x-forwarded-for": ip }, payload,
    }));
    const adminPost = (path: string, body: object) => inject("POST", path, { cookie: adminCookie, body });
    const config = async (trailer: string | number) => (await inject("GET", `/equipment-config/${trailer}`, { cookie: shopCookie })).json() as
      { pieces: { id: number; tag: string; type: string; due: boolean }[]; checklist: Item[]; as_of: string; trailer: { id: number } | null };
    const itemsFor = (cl: Item[], type: string) => cl.filter((c) => c.section === "all" || c.section === type);
    /** A check: these pieces all OK, except the notes given (by "TAG:item label") and pieces listed as not here. */
    const checkBody = (trailerId: number | null, cl: Item[], pieces: { id: number; type: string; tag: string }[],
      over: { problems?: Record<string, string>; notHere?: string[]; extra?: Record<string, unknown> } = {}) => ({
      client_id: randomUUID(), trailer_id: trailerId, check_date: ymd(), checker_name: "Robin Shop", comments: null,
      pieces: pieces.map((p) => over.notHere?.includes(p.tag)
        ? { equipment_id: p.id, status: "not_here", note: "At the shop", items: [] }
        : { equipment_id: p.id, status: "checked", items: itemsFor(cl, p.type).map((c) => {
            const n = over.problems?.[`${p.tag}:${c.label}`];
            return n !== undefined ? { checklist_item_id: c.id, result: "repair", note: n } : { checklist_item_id: c.id, result: "ok" };
          }) }),
      photos: [], ...(over.extra ?? {}),
    });

    before(async () => {
      const shop = await one(`SELECT id FROM users WHERE name = 'Robin Shop'`);
      shopCookie = await signIn("pin", { user_id: shop.id, pin: "1357" }, "203.0.113.250");
      adminCookie = await signIn("login", { email: "admin@test.local", password: "admin-password-1" }, "203.0.113.251");
    });

    test("admins keep the trailers and equipment; moves and edits are kept; nothing is deleted", async () => {
      assert.equal((await inject("POST", "/admin/trailers", { cookie: shopCookie, body: { trailer_number: "T-1" } })).statusCode, 403);
      for (const n of ["T-1", "T-2"]) {
        const r = await adminPost("/admin/trailers", { trailer_number: n, name: "16 ft landscape", plate: `PL${n}` });
        assert.equal(r.statusCode, 201, r.body);
        t[n] = r.json().id;
      }
      assert.equal((await adminPost("/admin/trailers", { trailer_number: "t-1" })).statusCode, 409);
      for (const [tag, type, trl] of [["ST-01", "string_trimmer", "T-1"], ["BL-01", "blower", "T-1"], ["CS-01", "chainsaw", "T-2"]]) {
        const r = await adminPost("/admin/equipment", { tag, type, make: "Stihl", trailer_id: t[trl] });
        assert.equal(r.statusCode, 201, r.body);
        e[tag] = r.json().id;
      }
      assert.equal((await adminPost("/admin/equipment", { tag: "st-01", type: "blower" })).statusCode, 409);
      assert.equal((await adminPost("/admin/equipment", { tag: "X-1", type: "jetpack" })).statusCode, 400);

      const patch = (id: number, body: object) => inject("PATCH", `/admin/equipment/${id}`, { cookie: adminCookie, body });
      assert.equal((await patch(e["BL-01"], { trailer_id: t["T-2"], model: "BR 600" })).statusCode, 200);
      assert.equal((await inject("PATCH", `/admin/trailers/${t["T-2"]}`, { cookie: adminCookie, body: { active: false } })).statusCode, 409,
        "a trailer with equipment on it can't be retired");
      const piece = (await inject("GET", `/equipment/${e["BL-01"]}`, { cookie: shopCookie })).json();
      assert.equal(piece.equipment.trailer_number, "T-2");
      assert.deepEqual(piece.history.map((h: { action: string }) => h.action), ["edited", "moved", "added"], "newest first; a move and an edit saved together are two entries");
      assert.deepEqual([piece.history[1].before.trailer, piece.history[1].after.trailer], ["T-1", "T-2"]);
      assert.deepEqual(piece.history[0].after, { model: "BR 600" });

      await assert.rejects(q(`DELETE FROM equipment WHERE id = $1`, [e["ST-01"]]));
      await assert.rejects(q(`DELETE FROM trailers WHERE id = $1`, [t["T-1"]]));
      await assert.rejects(q(`UPDATE asset_changes SET action = 'added'`));
    });

    test("the check form gets the trailer's pieces and the checklist; the overview shows what's due", async () => {
      assert.equal((await inject("GET", `/equipment-config/${t["T-2"]}`, { cookie: crewCookie })).statusCode, 403);
      const cfg = await config(t["T-2"]);
      assert.deepEqual(cfg.pieces.map((p) => p.tag), ["BL-01", "CS-01"]);
      assert.equal(itemsFor(cfg.checklist, "chainsaw").length, 9, "6 for all equipment + 3 for chainsaws");
      assert.equal(itemsFor(cfg.checklist, "blower").length, 8);
      const all = (await inject("GET", "/equipment", { cookie: supCookie })).json();
      assert.equal(all.check_days, 30);
      assert.equal(all.due, 3, "never checked: all due");
      assert.deepEqual(all.trailers.map((x: { trailer_number: string; pieces: unknown[] }) => [x.trailer_number, x.pieces.length]), [["T-1", 1], ["T-2", 2]]);
    });

    test("a check: each piece on its own items, or not here; problems need a note; a retry doesn't make a second", async () => {
      const cfg = await config(t["T-2"]);
      const pieces = cfg.pieces;
      const short = checkBody(t["T-2"], cfg.checklist, pieces);
      short.pieces[1].items = short.pieces[1].items.slice(1);
      const r1 = await inject("POST", "/equipment-checks", { cookie: shopCookie, body: short });
      assert.equal(r1.statusCode, 422);
      assert.equal(r1.json().details.missing[0].equipment_id, e["CS-01"]);
      const wrong = checkBody(t["T-2"], cfg.checklist, pieces);
      const trimmerItem = cfg.checklist.find((c) => c.section === "string_trimmer")!;
      (wrong.pieces[1].items as unknown[]).push({ checklist_item_id: trimmerItem.id, result: "ok" });
      assert.equal((await inject("POST", "/equipment-checks", { cookie: shopCookie, body: wrong })).json().details?.code, "checklist_changed",
        "a chainsaw can't be checked on a string trimmer's item");
      const noNote = checkBody(t["T-2"], cfg.checklist, pieces, { problems: { "CS-01:Chain sharp and tensioned": "" } });
      assert.equal((await inject("POST", "/equipment-checks", { cookie: shopCookie, body: noNote })).statusCode, 422);
      assert.equal((await inject("POST", "/equipment-checks", { cookie: crewCookie, body: checkBody(t["T-2"], cfg.checklist, pieces) })).statusCode, 403);

      const up = await uploadPhoto(shopCookie);
      oldPhoto = up.id;
      await q(`UPDATE photos SET created_at = now() - interval '30 days' WHERE id = $1`, [oldPhoto]);
      const chain = cfg.checklist.find((c) => c.label === "Chain sharp and tensioned" && c.section === "chainsaw")!;
      const body = checkBody(t["T-2"], cfg.checklist, pieces, {
        problems: { "CS-01:Chain sharp and tensioned": "Chain dull" }, notHere: ["BL-01"],
        extra: { photos: [{ id: oldPhoto, caption: "Dull chain", equipment_id: e["CS-01"], checklist_item_id: chain.id }] },
      });
      const res = await inject("POST", "/equipment-checks", { cookie: shopCookie, body });
      assert.equal(res.statusCode, 201, res.body);
      checkId = res.json().id;
      assert.equal(res.json().failed, 1);
      const again = await inject("POST", "/equipment-checks", { cookie: shopCookie, body });
      assert.deepEqual([again.statusCode, again.json().id, again.json().duplicate], [200, checkId, true]);

      const detail = (await inject("GET", `/equipment-checks/${checkId}`, { cookie: supCookie })).json();
      const cs = detail.pieces.find((p: { tag: string }) => p.tag === "CS-01");
      const bl = detail.pieces.find((p: { tag: string }) => p.tag === "BL-01");
      assert.equal(cs.items.length, 9);
      assert.deepEqual([bl.status, bl.note, bl.items.length], ["not_here", "At the shop", 0]);
      assert.equal(detail.photos[0].id, oldPhoto);
      const all = (await inject("GET", "/equipment", { cookie: shopCookie })).json();
      const flat = [...all.trailers.flatMap((x: { pieces: unknown[] }) => x.pieces), ...all.unassigned] as { tag: string; due: boolean; open_problems: number; last_checked: string }[];
      const by = Object.fromEntries(flat.map((p) => [p.tag, p]));
      assert.deepEqual([by["CS-01"].due, by["CS-01"].last_checked, by["CS-01"].open_problems], [false, ymd(), 1]);
      assert.equal(by["BL-01"].due, true, "a piece that wasn't there still needs checking");
      const listed = (await inject("GET", `/equipment-checks?trailer=${t["T-2"]}`, { cookie: shopCookie })).json();
      assert.deepEqual(listed.map((c: { id: string; checked: number; not_here: number; open: number }) => [c.id, c.checked, c.not_here, c.open]),
        [[checkId, 1, 1, 1]]);
    });

    test("problems stay open until resolved; a check's photos are kept and it can't be changed", async () => {
      const open = (await inject("GET", "/equipment-findings", { cookie: shopCookie })).json();
      assert.deepEqual(open.map((f: { tag: string; note: string; trailer_number: string }) => [f.tag, f.note, f.trailer_number]), [["CS-01", "Chain dull", "T-2"]]);
      assert.equal(open[0].photo_ids.length, 1);
      assert.equal((await inject("GET", "/equipment-findings", { cookie: crewCookie })).statusCode, 403);
      assert.equal((await inject("POST", `/equipment-findings/${open[0].id}/resolve`, { cookie: shopCookie, body: { note: "" } })).statusCode, 400);
      assert.equal((await inject("POST", `/equipment-findings/${open[0].id}/resolve`, { cookie: shopCookie, body: { note: "Sharpened" } })).statusCode, 200);
      assert.equal((await inject("POST", `/equipment-findings/${open[0].id}/resolve`, { cookie: shopCookie, body: { note: "again" } })).statusCode, 409);
      assert.equal((await inject("GET", "/equipment-findings", { cookie: shopCookie })).json().length, 0);

      await cleanupOrphanPhotos(() => {});
      assert.ok(await one(`SELECT 1 FROM photos WHERE id = $1`, [oldPhoto]), "the old photo on the check is kept");
      await assert.rejects(q(`DELETE FROM photos WHERE id = $1`, [oldPhoto]));
      await assert.rejects(q(`UPDATE equipment_checks SET comments = 'x' WHERE id = $1`, [checkId]));
      await assert.rejects(q(`DELETE FROM equipment_check_pieces WHERE check_id = $1`, [checkId]));
      await assert.rejects(q(`UPDATE equipment_check_items SET note = 'x' WHERE check_id = $1`, [checkId]));
      await assert.rejects(q(`DELETE FROM equipment_check_items WHERE check_id = $1`, [checkId]));
      // The photo can't go on anything else either.
      const yard = (await inject("GET", "/yard-config", { cookie: supCookie })).json();
      const walk = await inject("POST", "/yard-inspections", { cookie: supCookie, body: {
        client_id: randomUUID(), yard_id: (await one(`SELECT id FROM yards LIMIT 1`)).id, inspection_date: ymd(), inspector_name: "Sam",
        signature: PNG, checklist_as_of: yard.as_of, items: yard.checklist.map((c: Item) => ({ checklist_item_id: c.id, result: "ok" })),
        photos: [{ id: oldPhoto, caption: null }] } });
      assert.equal(walk.json().details?.code, "photos_missing");
    });

    test("each piece is due every N days, set by an admin", async () => {
      const cfg = await config(t["T-1"]);
      const old = await inject("POST", "/equipment-checks", { cookie: supCookie,
        body: checkBody(t["T-1"], cfg.checklist, cfg.pieces, { extra: { check_date: ymd(5) } }) });
      assert.equal(old.statusCode, 201, old.body);
      const due = async () => (await inject("GET", "/equipment", { cookie: shopCookie })).json().trailers
        .find((x: { trailer_number: string }) => x.trailer_number === "T-1").pieces[0].due;
      assert.equal(await due(), false, "checked 5 days ago, due every 30");
      assert.equal((await inject("PUT", "/admin/equipment-settings", { cookie: shopCookie, body: { check_days: 3 } })).statusCode, 403);
      assert.equal((await inject("PUT", "/admin/equipment-settings", { cookie: adminCookie, body: { check_days: 0 } })).statusCode, 400);
      assert.equal((await inject("PUT", "/admin/equipment-settings", { cookie: adminCookie, body: { check_days: 3 } })).statusCode, 200);
      assert.equal(await due(), true, "now due every 3 days");
      await inject("PUT", "/admin/equipment-settings", { cookie: adminCookie, body: { check_days: 30 } });
    });

    test("the equipment checklist is edited like the others; an open check still sends", async () => {
      const before = await config(t["T-2"]);
      const add = await adminPost("/admin/equipment-checklist", { section: "chainsaw", label: "Chaps on the trailer" });
      assert.equal(add.statusCode, 201, add.body);
      assert.equal((await adminPost("/admin/equipment-checklist", { section: "fire", label: "X" })).statusCode, 400);
      const piece = before.pieces.filter((p) => p.tag === "CS-01");
      const open = await inject("POST", "/equipment-checks", { cookie: shopCookie,
        body: checkBody(t["T-2"], before.checklist, piece, { extra: { checklist_as_of: before.as_of } }) });
      assert.equal(open.statusCode, 201, open.body);
      const old = await inject("POST", "/equipment-checks", { cookie: shopCookie, body: checkBody(t["T-2"], before.checklist, piece) });
      assert.equal(old.statusCode, 422);
      assert.deepEqual(old.json().details.missing, [{ equipment_id: e["CS-01"], items: [add.json().id] }]);
      assert.equal((await inject("POST", `/admin/equipment-checklist/${add.json().id}/retire`, { cookie: adminCookie, body: {} })).statusCode, 200);
    });
  });

  describe("equipment maintenance", () => {
    let shopCookie = "";
    let blower = 0;
    let saw = 0;
    let problemId = 0;
    let entryId = 0;
    let entryPhoto = "";
    const ymd = (days = 0) => {
      const d = new Date(Date.now() + days * 86400_000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const entry = (over: Record<string, unknown> = {}) => ({
      client_id: randomUUID(), equipment_id: blower, service_date: ymd(), work: [{ type: "repair" }],
      description: "Replaced the cracked tube", cost: "$18.40", performed_by: "Robin", ...over,
    });
    const log = (cookie: string, body: object) => inject("POST", "/equipment-service", { cookie, body });

    before(async () => {
      const shop = await one(`SELECT id FROM users WHERE name = 'Robin Shop'`);
      shopCookie = cookieOf(await app.inject({
        method: "POST", url: "/api/auth/pin", remoteAddress: "172.18.0.5",
        headers: { ...H, "x-forwarded-for": "203.0.113.252" }, payload: { user_id: shop.id, pin: "1357" },
      }));
      blower = (await one(`SELECT id FROM equipment WHERE tag = 'BL-01'`)).id;
      saw = (await one(`SELECT id FROM equipment WHERE tag = 'CS-01'`)).id;
      // A check that finds a problem on the blower.
      const trailer = (await one(`SELECT trailer_id FROM equipment WHERE id = $1`, [blower])).trailer_id;
      const cfg = (await inject("GET", `/equipment-config/${trailer}`, { cookie: shopCookie })).json();
      const tube = cfg.checklist.find((c: { label: string }) => c.label === "Tubes and nozzle intact");
      const res = await inject("POST", "/equipment-checks", { cookie: shopCookie, body: {
        client_id: randomUUID(), trailer_id: trailer, check_date: ymd(), checker_name: "Robin", checklist_as_of: cfg.as_of,
        pieces: cfg.pieces.map((p: { id: number; type: string }) => ({
          equipment_id: p.id, status: "checked",
          items: cfg.checklist.filter((c: { section: string }) => c.section === "all" || c.section === p.type)
            .map((c: { id: number }) => c.id === tube.id && p.id === blower
              ? { checklist_item_id: c.id, result: "repair", note: "Cracked tube" } : { checklist_item_id: c.id, result: "ok" }),
        })),
      } });
      assert.equal(res.statusCode, 201, res.body);
      problemId = (await one(`SELECT id FROM equipment_check_items WHERE check_id = $1 AND result = 'repair'`, [res.json().id])).id;
    });

    test("the shop logs work on a piece and closes its problems; a retry doesn't make a second", async () => {
      assert.equal((await log(supCookie, entry())).statusCode, 403, "supervisors look; the shop logs");
      assert.equal((await log(crewCookie, entry())).statusCode, 403);
      assert.equal((await log(shopCookie, entry({ work: [] }))).statusCode, 400);
      assert.equal((await log(shopCookie, entry({ work: [{ type: "polish" }] }))).statusCode, 400);
      assert.equal((await log(shopCookie, entry({ work: [{ type: "air_filter", next_due_date: ymd() }] }))).statusCode, 400, "next due after the work");
      assert.equal((await log(shopCookie, entry({ description: " " }))).statusCode, 400);
      const other = await log(shopCookie, entry({ equipment_id: saw, fix_item_ids: [problemId] }));
      assert.equal(other.json().details?.code, "bad_problems", "a blower's problem can't be fixed on the chainsaw");

      const { id: photo } = await uploadPhoto(shopCookie);
      entryPhoto = photo;
      const body = entry({
        work: [{ type: "repair" }, { type: "air_filter", next_due_date: ymd(30) }],
        fix_item_ids: [problemId], photos: [{ id: photo, caption: "Receipt" }],
      });
      const a = await log(shopCookie, body);
      assert.equal(a.statusCode, 201, a.body);
      entryId = a.json().id;
      assert.equal(a.json().fixed, 1);
      const b = await log(shopCookie, body);
      assert.deepEqual([b.statusCode, b.json().id, b.json().duplicate], [200, entryId, true]);

      const open = (await inject("GET", "/equipment-findings", { cookie: shopCookie })).json();
      assert.ok(!open.some((f: { id: number }) => f.id === problemId), "the problem is closed");
      const item = await one(`SELECT resolution_note FROM equipment_check_items WHERE id = $1`, [problemId]);
      assert.equal(item.resolution_note, "Fixed (maintenance log): Replaced the cracked tube");

      const svc = (await inject("GET", `/equipment/${blower}/service`, { cookie: supCookie })).json();
      assert.deepEqual(svc.entries.map((e: { id: number; work_titles: string[]; fixed: number }) => [e.id, e.work_titles, e.fixed]),
        [[entryId, ["Repair", "Air filter"], 1]]);
      assert.deepEqual(svc.next_due.map((n: { type: string; state: string }) => [n.type, n.state]), [["air_filter", "ok"]]);
      const detail = (await inject("GET", `/equipment-service/${entryId}`, { cookie: supCookie })).json();
      assert.equal(Number(detail.cost), 18.4);
      assert.equal(detail.fixed[0].note, "Cracked tube");
      assert.equal(detail.photos[0].id, photo);
    });

    test("next due per type of work: overdue shows as Service due; a newer entry without a date clears it", async () => {
      const r = await log(shopCookie, entry({ equipment_id: saw, service_date: ymd(-10), work: [{ type: "sharpen", next_due_date: ymd(-2) }],
        description: "Sharpened the chain" }));
      assert.equal(r.statusCode, 201, r.body);
      const due = async () => {
        const all = (await inject("GET", "/equipment", { cookie: shopCookie })).json();
        return [...all.trailers.flatMap((x: { pieces: unknown[] }) => x.pieces), ...all.unassigned]
          .find((p: { id: number }) => (p as { id: number }).id === saw) as { service_due: number };
      };
      assert.equal((await due()).service_due, 1);
      assert.equal((await inject("GET", `/equipment/${saw}/service`, { cookie: shopCookie })).json().next_due[0].state, "due");
      assert.equal((await log(shopCookie, entry({ equipment_id: saw, work: [{ type: "sharpen" }], description: "Sharpened again" }))).statusCode, 201);
      assert.equal((await due()).service_due, 0, "the newest sharpening has no next date, so the old one is out of date");
    });

    test("void: a reason; it reopens the problems it closed; entries can't be changed or erased; photos are kept", async () => {
      assert.equal((await inject("POST", `/equipment-service/${entryId}/void`, { cookie: shopCookie, body: {} })).statusCode, 400);
      assert.equal((await inject("POST", `/equipment-service/${entryId}/void`, { cookie: supCookie, body: { reason: "x" } })).statusCode, 403);
      const v = await inject("POST", `/equipment-service/${entryId}/void`, { cookie: shopCookie, body: { reason: "Wrong piece" } });
      assert.deepEqual([v.statusCode, v.json().reopened], [200, 1]);
      assert.equal((await inject("POST", `/equipment-service/${entryId}/void`, { cookie: shopCookie, body: { reason: "again" } })).statusCode, 409);
      const open = (await inject("GET", "/equipment-findings", { cookie: shopCookie })).json();
      assert.ok(open.some((f: { id: number }) => f.id === problemId), "the problem is open again");
      const svc = (await inject("GET", `/equipment/${blower}/service`, { cookie: shopCookie })).json();
      assert.equal(svc.entries[0].voided, true);
      assert.deepEqual(svc.next_due, [], "a voided entry's next-due no longer counts");

      await assert.rejects(q(`DELETE FROM equipment_service_logs WHERE id = $1`, [entryId]));
      await assert.rejects(q(`UPDATE equipment_service_logs SET description = 'x' WHERE id = $1`, [entryId]));
      await assert.rejects(q(`UPDATE equipment_service_logs SET void_reason = 'changed' WHERE id = $1`, [entryId]));
      await assert.rejects(q(`DELETE FROM equipment_service_repairs WHERE service_log_id = $1`, [entryId]));
      await assert.rejects(q(`DELETE FROM photos WHERE id = $1`, [entryPhoto]));
      const reuse = await log(shopCookie, entry({ photos: [{ id: entryPhoto, caption: null }] }));
      assert.equal(reuse.json().details?.code, "photos_missing", "a photo on one entry can't go on another");
    });
  });

  describe("fleet", () => {
    let shopCookie = "";
    let adminCookie = "";
    const truck: Record<string, number> = {};
    const ymd = (days = 0) => {
      const d = new Date(Date.now() + days * 86400_000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const signIn = async (path: string, payload: object, ip: string) => cookieOf(await app.inject({
      method: "POST", url: `/api/auth/${path}`, remoteAddress: "172.18.0.5", headers: { ...H, "x-forwarded-for": ip }, payload,
    }));
    const setStatus = (cookie: string, code: string, status: string, note?: string) =>
      inject("POST", `/vehicles/${truck[code]}/status`, { cookie, body: { status, note } });
    const history = async (code: string) => (await inject("GET", `/vehicles/${truck[code]}/status-history`, { cookie: supCookie })).json() as
      { previous: string; status: string; note: string | null; changed_by_name: string | null }[];

    before(async () => {
      const shop = await one(`SELECT id FROM users WHERE name = 'Robin Shop'`);
      shopCookie = await signIn("pin", { user_id: shop.id, pin: "1357" }, "203.0.113.253");
      adminCookie = await signIn("login", { email: "admin@test.local", password: "admin-password-1" }, "203.0.113.254");
      for (const r of await q(`SELECT id, truck_code FROM vehicles WHERE truck_code IN ('T030', 'T032', 'T035', 'T036', 'T039', 'T043', 'T048')`)) {
        truck[r.truck_code] = r.id;
      }
    });

    test("a truck's status: who may set what, every change kept; out-of-fleet statuses take it off the lists", async () => {
      assert.equal((await setStatus(crewCookie, "T030", "in_shop")).statusCode, 403);
      assert.equal((await setStatus(shopCookie, "T030", "in_shop", "Brakes at Corner Tire")).statusCode, 200);
      assert.equal((await setStatus(shopCookie, "T030", "in_shop")).statusCode, 409, "already in the shop");
      assert.equal((await setStatus(shopCookie, "T030", "returned")).statusCode, 403, "the shop can't take a truck out of the fleet");
      assert.equal((await setStatus(supCookie, "T030", "flying")).statusCode, 400);
      const list = (await inject("GET", "/vehicles", { cookie: crewCookie })).json();
      assert.equal(list.find((v: { id: number }) => v.id === truck.T030).status, "in_shop");
      assert.deepEqual((await history("T030")).map((h) => [h.previous, h.status, h.note, h.changed_by_name]),
        [["in_service", "in_shop", "Brakes at Corner Tire", "Robin Shop"]]);

      assert.equal((await setStatus(supCookie, "T030", "returned", "Lease ended")).statusCode, 200);
      assert.equal((await one(`SELECT active FROM vehicles WHERE id = $1`, [truck.T030])).active, false);
      assert.ok(!(await inject("GET", "/vehicles", { cookie: crewCookie })).json().some((v: { id: number }) => v.id === truck.T030),
        "a returned truck is off the crews' list");
      assert.equal((await setStatus(shopCookie, "T030", "in_service")).statusCode, 403, "only a supervisor brings it back");
      assert.equal((await setStatus(supCookie, "T030", "in_service")).statusCode, 200);
      assert.equal((await one(`SELECT active FROM vehicles WHERE id = $1`, [truck.T030])).active, true);

      // Admin's Active switch keeps the status in step, and says who did it.
      assert.equal((await inject("PATCH", `/admin/vehicles/${truck.T032}`, { cookie: adminCookie, body: { active: false } })).statusCode, 200);
      assert.equal((await one(`SELECT status FROM vehicles WHERE id = $1`, [truck.T032])).status, "retired");
      const h32 = (await history("T032"))[0];
      assert.deepEqual([h32.previous, h32.status, h32.note, h32.changed_by_name], ["in_service", "retired", "Admin → Trucks", "Admin"]);
      await inject("PATCH", `/admin/vehicles/${truck.T032}`, { cookie: adminCookie, body: { active: true } });
      assert.equal((await one(`SELECT status FROM vehicles WHERE id = $1`, [truck.T032])).status, "in_service");
      // A change made outside the app is still recorded, without a user.
      await q(`UPDATE vehicles SET status = 'on_hold' WHERE id = $1`, [truck.T035]);
      assert.deepEqual((await history("T035")).map((h) => [h.status, h.changed_by_name]), [["on_hold", null]]);
      await q(`UPDATE vehicles SET status = 'in_service' WHERE id = $1`, [truck.T035]);
      await assert.rejects(q(`DELETE FROM vehicle_status_changes WHERE vehicle_id = $1`, [truck.T030]));
      await assert.rejects(q(`UPDATE vehicle_status_changes SET note = 'x' WHERE vehicle_id = $1`, [truck.T030]));
    });

    test("trailers sit on one truck at a time; moving one is kept; the form gets the truck's trailer", async () => {
      const t8 = (await inject("POST", "/admin/trailers", { cookie: adminCookie, body: { trailer_number: "T-8", plate: "TR8" } })).json().id;
      const t9 = (await inject("POST", "/admin/trailers", { cookie: adminCookie, body: { trailer_number: "T-9" } })).json().id;
      const assign = (cookie: string, id: number, vehicleId: number | null) =>
        inject("POST", `/trailers/${id}/assign`, { cookie, body: { vehicle_id: vehicleId } });
      assert.equal((await assign(crewCookie, t8, truck.T036)).statusCode, 403);
      assert.equal((await assign(supCookie, t8, truck.T036)).json().moved, true);
      const detail = (await inject("GET", `/vehicles/${truck.T036}`, { cookie: crewCookie })).json();
      assert.deepEqual([detail.vehicle.trailer.trailer_number, detail.vehicle.trailer.plate], ["T-8", "TR8"]);
      assert.equal((await assign(shopCookie, t9, truck.T036)).statusCode, 200, "a second trailer bumps the first off");
      assert.equal((await one(`SELECT vehicle_id FROM trailers WHERE id = $1`, [t8])).vehicle_id, null);
      assert.equal((await assign(supCookie, t9, truck.T039)).statusCode, 200);
      assert.equal((await inject("GET", `/vehicles/${truck.T036}`, { cookie: crewCookie })).json().vehicle.trailer, null);
      const moves = await q(`SELECT trailer_id, before->>'vehicle_id' AS f, after->>'vehicle_id' AS t FROM asset_changes
                              WHERE trailer_id IN ($1, $2) AND action = 'moved' ORDER BY id`, [t8, t9]);
      assert.deepEqual(moves.map((m: { trailer_id: number; f: string | null; t: string | null }) => [m.trailer_id, m.f, m.t]), [
        [t8, null, String(truck.T036)], [t8, String(truck.T036), null], [t9, null, String(truck.T036)], [t9, String(truck.T036), String(truck.T039)],
      ]);
      const listed = (await inject("GET", "/trailers", { cookie: shopCookie })).json();
      assert.equal(listed.find((x: { id: number }) => x.id === t9).truck_code, "T039");
      await inject("PATCH", `/admin/trailers/${t8}`, { cookie: adminCookie, body: { active: false } });
      assert.equal((await assign(supCookie, t8, truck.T036)).statusCode, 404, "a retired trailer can't be put on a truck");
      await setStatus(supCookie, "T043", "sold");
      assert.equal((await assign(supCookie, t9, truck.T043)).statusCode, 400, "nor go on a truck that's out of the fleet");
      await setStatus(supCookie, "T043", "in_service");
    });

    test("reminders: registrations, overdue inspections, truck and equipment maintenance, equipment checks", async () => {
      assert.equal((await inject("GET", "/reminders", { cookie: crewCookie })).statusCode, 403);
      await q(`UPDATE vehicles SET registration_expires = $2 WHERE id = $1`, [truck.T048, ymd(-1)]);
      await q(`UPDATE vehicles SET registration_expires = $2 WHERE id = $1`, [truck.T039, ymd(10)]);
      const oil = await inject("POST", "/service-logs", { cookie: shopCookie, body: {
        client_id: randomUUID(), vehicle_id: truck.T036, service_date: ymd(-20), mileage: 1000, category: "oil_change",
        description: "Oil and filter", next_due_date: ymd(-2) } });
      assert.equal(oil.statusCode, 201, oil.body);
      assert.equal((await inject("POST", "/admin/equipment", { cookie: adminCookie, body: { tag: "HT-01", type: "hedge_trimmer" } })).statusCode, 201);

      const r = (await inject("GET", "/reminders", { cookie: shopCookie })).json();
      const find = (re: RegExp) => r.items.find((i: { title: string }) => re.test(i.title));
      assert.equal(find(/^T048: registration expired/)?.state, "due");
      assert.equal(find(/^T039: registration expires/)?.state, "soon");
      assert.equal(find(/^T036: Oil change due by/)?.state, "due");
      const insp = find(/^\d+ trucks not inspected in 35 days$/);
      assert.ok(insp, "overdue inspections are one line");
      assert.match(insp.detail, /^T\d{3}(, T\d{3})*( and \d+ more)?$/, "the truck numbers, the first 12 and how many more");
      assert.equal(r.items.filter((i: { kind: string }) => i.kind === "inspection").length, 1);
      assert.match(find(/Not on a trailer: \d+ pieces? due for a check/)?.detail ?? "", /HT-01/);
      assert.equal(r.due, r.items.filter((i: { state: string }) => i.state === "due").length);
      assert.equal(r.items[r.items.length - 1].state === "soon" || r.soon === 0, true, "due ones come first");
    });
  });
  describe("phase 3 data safety", () => {
    test("a photo uploaded under one sign-in can be sent under the next (a shared phone's queue)", async () => {
      const { res: up, id } = await uploadPhoto(crewCookie);
      assert.equal(up.statusCode, 201);
      const before = await one(`SELECT file_path, uploaded_by FROM photos WHERE id = $1`, [id]);
      const again = await uploadPhoto(supCookie, id);
      assert.equal(again.res.statusCode, 200, "already here: not refused, not stored twice");
      const after = await one(`SELECT file_path, uploaded_by FROM photos WHERE id = $1`, [id]);
      assert.deepEqual(after, before, "the stored photo is never replaced");
      // The checklist as it is now (earlier tests added items).
      const items = (await q(`SELECT id FROM checklist_items WHERE active AND section IN ('exterior', 'interior')`))
        .map((c) => ({ checklist_item_id: c.id, result: "ok" }));
      const res = await inject("POST", "/inspections", { cookie: supCookie, body: submitBody({ items, photos: [{ id, caption: "From the crew's upload" }] }) });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal((await one(`SELECT inspection_id FROM photos WHERE id = $1`, [id])).inspection_id, res.json().id);
      // Still only once: an attached photo can't go on anything else, whoever asks.
      const reuse = await inject("POST", "/inspections", { cookie: crewCookie, body: submitBody({ items, photos: [{ id }] }) });
      assert.equal(reuse.json().details?.code, "photos_missing");
    });

    test("every upload gets its own file name", async () => {
      const { id } = await uploadPhoto(crewCookie);
      const p = await one(`SELECT file_path FROM photos WHERE id = $1`, [id]);
      assert.ok(!p.file_path.includes(id), "the photo id isn't the file name, so a re-upload never lands on an old file");
      const { files: store } = await import("../src/storage.ts");
      assert.ok((await store.read(p.file_path)).length > 0);
    });

    test("a file written for a failed save is removed only when nothing points at it", async () => {
      const { discardUnlessUsed, files: store, newKey } = await import("../src/storage.ts");
      const exists = async (k: string) => store.read(k).then(() => true, () => false);
      const [a, b, c] = [newKey("png"), newKey("png"), newKey("png")];
      for (const k of [a, b, c]) await store.put(k, JPEG);
      await discardUnlessUsed(a, async () => true);
      await discardUnlessUsed(b, async () => { throw new Error("database down"); });
      await discardUnlessUsed(c, async () => false);
      assert.equal(await exists(a), true, "the save went through after all: kept");
      assert.equal(await exists(b), true, "can't tell: kept");
      assert.equal(await exists(c), false, "nothing uses it: removed");
    });

    test("a photo that vanished mid-save makes the phone upload it again; one on another record is refused", async () => {
      const { attachFailed } = await import("../src/photo-owners.ts");
      const gone = await attachFailed(pool, randomUUID(), "taken");
      assert.equal(gone.statusCode, 422);
      assert.equal((gone.details as { code: string }).code, "photos_missing");
      const attached = await one(`SELECT id FROM photos WHERE inspection_id IS NOT NULL LIMIT 1`);
      const taken = await attachFailed(pool, attached.id, "taken");
      assert.equal(taken.statusCode, 409);
      assert.equal(taken.message, "taken");
    });

    test("trucks, users and truck pictures can't be deleted from the database either (017)", async () => {
      const v = await one(`INSERT INTO vehicles (truck_code, active) VALUES ('ZZ-DEL', false) RETURNING id`);
      await assert.rejects(q(`DELETE FROM vehicles WHERE id = $1`, [v.id]), /can't be deleted/);
      const u = await one(`INSERT INTO users (name, role, active, pin_hash) VALUES ('Never Deleted', 'crew', false, 'none') RETURNING id`);
      await assert.rejects(q(`DELETE FROM users WHERE id = $1`, [u.id]), /can't be deleted/);
      const d = await one(`SELECT id FROM diagrams LIMIT 1`);
      await assert.rejects(q(`DELETE FROM diagrams WHERE id = $1`, [d.id]), /can't be deleted/);
    });

    test("the truck list's open repair counts match a count truck by truck (016, 018)", async () => {
      const rows = await q(`SELECT vs.id, vs.open_repairs,
          (SELECT count(*) FROM inspection_items ii JOIN live_inspections i ON i.id = ii.inspection_id
            WHERE i.vehicle_id = vs.id AND ii.result = 'repair' AND ii.resolved_at IS NULL)
          + (SELECT count(*) FROM damage_marks dm JOIN live_incidents n ON n.id = dm.incident_id
            WHERE n.vehicle_id = vs.id AND NOT EXISTS (SELECT 1 FROM damage_repairs dr WHERE dr.damage_mark_id = dm.id AND dr.active)) AS direct
          FROM vehicle_status vs`);
      assert.ok(rows.some((r) => r.direct > 0), "some trucks have open repairs in the test data");
      for (const r of rows) assert.equal(r.open_repairs, r.direct, `truck ${r.id}`);
    });
  });
}
