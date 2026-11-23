// Burn-in test (SPEC §9 phase 3): many simulated phones submit truck inspections, yard walks, equipment checks,
// maintenance and incident reports (with photos) through a deliberately bad connection, while the app crashes and the
// database restarts. At the end every record a phone made must exist exactly once, complete (all checklist answers,
// damage marks and photos).
//
// Never point it at real data: it needs an empty, throwaway database (the app migrates it on start).
//
//   node scripts/burnin.ts --db postgres://gc:gctest@localhost:54331/gc_burn --minutes 60 --phones 30 \
//     [--pg-container gc-burn-pg] [--port 3100] [--uploads <dir>]
//
// The bad connection is a TCP proxy between the phones and the app: it refuses some connections (no signal), stalls
// some (weak signal), and cuts some after the request reached the app (the app saved it, the phone never heard back;
// the retry must not make a second copy). Every so often the app is killed hard and restarted, and (with
// --pg-container) the database container is restarted. Phones also go "offline" and save several records before
// sending them. Exit code 0 means nothing was lost, duplicated or left incomplete.

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { UNATTACHED } from "../src/photo-owners.ts";

// ---------- Settings ----------

const argv = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const DB = opt("db");
if (!DB) throw new Error("--db postgres://… is required (an empty, throwaway database)");
const MINUTES = Number(opt("minutes", "30"));
const PHONES = Math.max(6, Number(opt("phones", "25")));
const APP_PORT = Number(opt("port", "3100"));
const PROXY_PORT = APP_PORT + 1;
const PG_CONTAINER = opt("pg-container");
const CRASH_EVERY = Number(opt("crash-every", "6")); // minutes between crashes, on average (every third one restarts the database)
const DOCKER = opt("docker", process.platform === "win32" ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe" : "docker");
const WORK = mkdtempSync(join(tmpdir(), "gc-burnin-"));
const UPLOADS = opt("uploads", join(WORK, "uploads"))!;
mkdirSync(UPLOADS, { recursive: true });
const ADMIN = { email: "burnin-admin@test.local", password: "burnin-admin-password" };

const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(a: T[]): T => a[rnd(a.length)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ymd = (days = 0) => {
  const d = new Date(Date.now() + days * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

// ---------- The app ----------

let appProc: ChildProcess | null = null;
const appLog = createWriteStream(join(WORK, "app.log"));
let appErrors = 0;

async function startApp() {
  appProc = spawn(process.execPath, ["src/server.ts"], {
    env: { ...process.env, DATABASE_URL: DB, PORT: String(APP_PORT), HOST: "127.0.0.1", UPLOAD_DIR: UPLOADS,
      ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ADMIN_NAME: "Burn-in Admin", LOG_LEVEL: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const s of [appProc.stdout!, appProc.stderr!]) {
    s.on("data", (b: Buffer) => {
      appLog.write(b);
      appErrors += (b.toString().match(/"level":50/g) || []).length;
    });
  }
  const me = appProc;
  me.on("exit", (code, signal) => {
    if (appProc !== me || stopping) return; // a planned crash
    unplannedExits.push(`${new Date().toISOString()} code ${code} signal ${signal}`);
    log(`APP STOPPED ON ITS OWN (code ${code}); restarting`);
    appProc = null;
    startApp().catch((e) => log(`restart failed: ${e}`));
  });
  for (let i = 0; i < 120; i++) {
    if ((await raw("GET", "/healthz", null, {}, APP_PORT)).status === 200) return;
    await sleep(500);
  }
  throw new Error("the app didn't start; see " + join(WORK, "app.log"));
}

const unplannedExits: string[] = [];
let stopping = false;

function killApp() {
  const p = appProc;
  appProc = null;
  if (p && p.exitCode === null) p.kill("SIGKILL");
}

// ---------- The bad connection ----------

const chaos = { on: true, refused: 0, cut: 0, stalled: 0, passed: 0 };
const proxy = net.createServer((client) => {
  client.on("error", () => {});
  const roll = Math.random();
  if (chaos.on && roll < 0.12) { chaos.refused++; client.destroy(); return; }               // no signal
  const cut = chaos.on && roll < 0.22;                                                      // answer lost on the way back
  const stall = chaos.on && !cut && roll < 0.37 ? 500 + rnd(4000) : 0;                     // weak signal
  if (cut) chaos.cut++; else if (stall) chaos.stalled++; else chaos.passed++;
  const go = () => {
    const server = net.connect(APP_PORT, "127.0.0.1");
    server.on("error", () => client.destroy());
    client.on("close", () => server.destroy());
    server.on("close", () => client.destroy());
    client.pipe(server);
    if (cut) server.once("data", () => { client.destroy(); server.destroy(); });
    else server.pipe(client);
  };
  // Paused bytes stay buffered until go() pipes them on.
  if (stall) { client.pause(); setTimeout(go, stall); } else go();
});

// ---------- HTTP ----------

interface Res { status: number; json: any; cookie?: string }

function raw(method: string, path: string, body: Buffer | string | null, headers: Record<string, string>, port = PROXY_PORT): Promise<Res> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: path.startsWith("/") ? path : `/${path}`, agent: false, timeout: 20_000,
      headers: { ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not json */ }
        const sc = res.headers["set-cookie"];
        resolve({ status: res.statusCode ?? 0, json, cookie: sc ? String(sc).split(";")[0] : undefined });
      });
      res.on("error", () => resolve({ status: 0, json: null }));
      res.on("aborted", () => resolve({ status: 0, json: null }));
      res.on("close", () => { if (!res.complete) resolve({ status: 0, json: null }); });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0, json: null }));
    if (body) req.write(body);
    req.end();
  });
}

// ---------- Phones ----------

type Kind = "inspection" | "yard" | "check" | "service" | "equipment_service" | "incident";
interface Op { kind: Kind; clientId: string; endpoint: string; body: any; photos: string[]; items: number; confirmed: boolean; tries: number }
const ledger: Op[] = [];
const stats = { retries: 0, signIns: 0, photoUploads: 0, rejected: [] as string[] };

const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(300)]).toString("base64");
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(15_000 + rnd(40_000))]);

class Phone {
  cookie = "";
  queue: Op[] = [];
  readonly ip: string;
  readonly login: { path: string; body: object };
  constructor(n: number, login: { path: string; body: object }) {
    this.ip = `198.51.100.${n + 1}`;
    this.login = login;
  }
  headers(extra: Record<string, string> = {}) {
    return { "x-gc-app": "1", "x-forwarded-for": this.ip, ...(this.cookie ? { cookie: this.cookie } : {}), ...extra };
  }
  async signIn() {
    for (;;) {
      const r = await raw("POST", this.login.path, JSON.stringify(this.login.body), this.headers({ "content-type": "application/json" }));
      if (r.status === 200 && r.cookie) { this.cookie = r.cookie; stats.signIns++; return; }
      await sleep(1000 + rnd(3000));
    }
  }
  async get(path: string): Promise<any> {
    for (;;) {
      const r = await raw("GET", `/api${path}`, null, this.headers());
      if (r.status === 200) return r.json;
      if (r.status === 401) await this.signIn(); else await sleep(500 + rnd(2000));
    }
  }
  /** Upload a photo until the server has it (201, or 200 for "already have it"). */
  async upload(id: string, data: Buffer) {
    const boundary = "----burnin" + randomUUID();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${id}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      data, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    for (;;) {
      const r = await raw("POST", "/api/photos", body, this.headers({ "content-type": `multipart/form-data; boundary=${boundary}` }));
      if (r.status === 200 || r.status === 201) { stats.photoUploads++; return; }
      if (r.status === 401) await this.signIn();
      else { stats.retries++; await sleep(500 + rnd(2500)); }
    }
  }
  /** Send one record until the server confirms it, the way the app's outbox does (same client_id every time). */
  async send(op: Op, photoData: Map<string, Buffer>) {
    for (const id of op.photos) await this.upload(id, photoData.get(id)!);
    for (;;) {
      op.tries++;
      const r = await raw("POST", `/api${op.endpoint}`, JSON.stringify(op.body), this.headers({ "content-type": "application/json" }));
      if (r.status === 200 || r.status === 201) { op.confirmed = true; return; }
      if (r.status === 401) { await this.signIn(); continue; }
      if (r.status === 422 && r.json?.details?.code === "photos_missing") {
        for (const id of r.json.details.photos) await this.upload(id, photoData.get(id)!);
        continue;
      }
      if (r.status === 0 || r.status >= 500 || r.status === 429) { stats.retries++; await sleep(800 + rnd(4000)); continue; }
      stats.rejected.push(`${op.kind} ${op.clientId}: ${r.status} ${JSON.stringify(r.json)}`);
      return;
    }
  }
}

// ---------- What phones make ----------

let vehicles: { id: number }[] = [];
let checklist: { id: number; section: string }[] = [];
let formAsOf = "";
let yardCfg: any = null;
let yardId = 0;
const equipCfg = new Map<number, any>();
let trailerIds: number[] = [];
const photoData = new Map<string, Buffer>();

function withPhotos(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    photoData.set(id, jpeg());
    ids.push(id);
  }
  return ids;
}

function inspectionOp(): Op {
  const items = checklist.filter((c) => c.section !== "trailer");
  const repairs = new Set(items.filter(() => Math.random() < 0.06).map((c) => c.id));
  const photos = withPhotos(rnd(4));
  const repairList = [...repairs];
  const body = {
    client_id: randomUUID(), vehicle_id: pick(vehicles).id, inspection_date: ymd(), inspector_name: "Burn-in", mileage: 10_000 + rnd(150_000),
    oil_change_due: Math.random() < 0.2, existing_notes: null, new_observations: Math.random() < 0.3 ? "Noise on the left" : null, comments: null,
    trailer: null, checklist_as_of: formAsOf,
    items: items.map((c) => repairs.has(c.id) ? { checklist_item_id: c.id, result: "repair", note: "Needs a look" } : { checklist_item_id: c.id, result: "ok" }),
    damage: Math.random() < 0.3 ? [{ key: "d1", diagram: "truck", x: Math.random(), y: Math.random(), note: "Scratch" }] : [],
    photos: photos.map((id, i) => ({ id, caption: `Photo ${i + 1}`, damage_key: null, checklist_item_id: repairList[i] ?? null })),
    signature: PNG,
  };
  return { kind: "inspection", clientId: body.client_id, endpoint: "/inspections", body, photos, items: items.length, confirmed: false, tries: 0 };
}

function yardOp(): Op {
  const photos = withPhotos(rnd(3));
  const fail = yardCfg.checklist.filter(() => Math.random() < 0.1).map((c: { id: number }) => c.id);
  const body = {
    client_id: randomUUID(), yard_id: yardId, inspection_date: ymd(), inspector_name: "Burn-in Sup", comments: null, checklist_as_of: yardCfg.as_of,
    items: yardCfg.checklist.map((c: { id: number }) => fail.includes(c.id) ? { checklist_item_id: c.id, result: "repair", note: "Fix it" } : { checklist_item_id: c.id, result: "ok" }),
    photos: photos.map((id, i) => ({ id, caption: null, checklist_item_id: fail[i] ?? null })),
    signature: PNG,
  };
  return { kind: "yard", clientId: body.client_id, endpoint: "/yard-inspections", body, photos, items: yardCfg.checklist.length, confirmed: false, tries: 0 };
}

function checkOp(): Op {
  const t = pick(trailerIds);
  const cfg = equipCfg.get(t);
  let items = 0;
  const pieces = cfg.pieces.map((p: { id: number; type: string }) => {
    if (Math.random() < 0.1) return { equipment_id: p.id, status: "not_here", note: "In the shop", items: [] };
    const mine = cfg.checklist.filter((c: { section: string }) => c.section === "all" || c.section === p.type);
    items += mine.length;
    return { equipment_id: p.id, status: "checked", items: mine.map((c: { id: number }) => ({ checklist_item_id: c.id, result: Math.random() < 0.05 ? "repair" : "ok", note: "Worn" })) };
  });
  const checked = pieces.filter((p: { status: string }) => p.status === "checked");
  const photos = checked.length ? withPhotos(rnd(3)) : [];
  const body = { client_id: randomUUID(), trailer_id: t, check_date: ymd(), checker_name: "Burn-in Shop", comments: null, checklist_as_of: cfg.as_of, pieces,
    photos: photos.map((id) => ({ id, caption: null, equipment_id: pick(checked as { equipment_id: number }[]).equipment_id, checklist_item_id: null })) };
  return { kind: "check", clientId: body.client_id, endpoint: "/equipment-checks", body, photos, items, confirmed: false, tries: 0 };
}

function serviceOp(): Op {
  const photos = withPhotos(rnd(3));
  const body = { client_id: randomUUID(), vehicle_id: pick(vehicles).id, service_date: ymd(), mileage: 20_000 + rnd(100_000), category: pick(["oil_change", "tires", "brakes", "repair"]),
    description: "Burn-in work", performed_by: "Shop", photos: photos.map((id) => ({ id, caption: "Receipt" })) };
  return { kind: "service", clientId: body.client_id, endpoint: "/service-logs", body, photos, items: 0, confirmed: false, tries: 0 };
}

function equipmentServiceOp(): Op {
  const t = pick(trailerIds);
  const piece = pick(equipCfg.get(t).pieces as { id: number }[]);
  const photos = withPhotos(rnd(2));
  const body = { client_id: randomUUID(), equipment_id: piece.id, service_date: ymd(), work: [{ type: pick(["sharpen", "air_filter", "tune_up"]) }],
    description: "Burn-in tune-up", photos: photos.map((id) => ({ id, caption: null })) };
  return { kind: "equipment_service", clientId: body.client_id, endpoint: "/equipment-service", body, photos, items: 0, confirmed: false, tries: 0 };
}

/** A supervisor's incident report (018): damage pins with photos, a map, other parties, a drawing and signatures. */
function incidentOp(): Op {
  const photos = withPhotos(1 + rnd(4));
  const marks = 1 + rnd(3);
  const damage = Array.from({ length: marks }, (_, i) => ({ key: `d${i}`, diagram: "truck", x: Math.random(), y: Math.random(), note: `Dent ${i + 1}` }));
  const hurt = Math.random() < 0.2;
  const body = {
    client_id: randomUUID(), vehicle_id: pick(vehicles).id, incident_date: ymd(), incident_time: "14:30", location_name: "Burn-in Rd",
    street: "Main St & 1st Ave", city: "Springfield", state: "CO", police_present: Math.random() < 0.5, anyone_injured: hurt, employee_injured: hurt,
    driver_name: "Burn-in Driver", description: "Rear-ended at a light.", reporter_name: "Burn-in Sup",
    other_parties: [{ name: "Other Driver", plate_no: "BURN1", insurance_company: "Acme" }], witnesses: Math.random() < 0.5 ? [{ name: "Witness" }] : [],
    damage,
    photos: photos.map((id, i) => ({ id, caption: `Photo ${i + 1}`, damage_key: i < marks ? `d${i}` : null, map: i === photos.length - 1 && i >= marks })),
    sketch: PNG, driver_signature: Math.random() < 0.7 ? PNG : null, reporter_signature: PNG,
  };
  return { kind: "incident", clientId: body.client_id, endpoint: "/incidents", body, photos, items: marks, confirmed: false, tries: 0 };
}

// ---------- Setup ----------

async function setup(): Promise<Phone[]> {
  const admin = new Phone(250, { path: "/api/auth/login", body: ADMIN });
  const adminPost = async (path: string, body: object) => {
    for (;;) {
      const r = await raw("POST", `/api${path}`, JSON.stringify(body), admin.headers({ "content-type": "application/json" }), APP_PORT);
      if (r.status === 201) return r.json;
      if (r.status === 401) { const s = await raw("POST", "/api/auth/login", JSON.stringify(ADMIN), admin.headers({ "content-type": "application/json" }), APP_PORT); admin.cookie = s.cookie!; continue; }
      throw new Error(`setup ${path}: ${r.status} ${JSON.stringify(r.json)}`);
    }
  };
  const phones: Phone[] = [];
  const crew = PHONES - 4;
  for (let i = 0; i < crew; i++) {
    const u = await adminPost("/admin/users", { name: `Burn Crew ${i + 1}`, role: "crew", pin: String(4000 + i) });
    phones.push(new Phone(i, { path: "/api/auth/pin", body: { user_id: u.id, pin: String(4000 + i) } }));
  }
  for (let i = 0; i < 2; i++) {
    const email = `burn-sup${i + 1}@test.local`;
    await adminPost("/admin/users", { name: `Burn Sup ${i + 1}`, role: "supervisor", email, password: "burnin-password-1" });
    phones.push(new Phone(crew + i, { path: "/api/auth/login", body: { email, password: "burnin-password-1" } }));
  }
  for (let i = 0; i < 2; i++) {
    const u = await adminPost("/admin/users", { name: `Burn Shop ${i + 1}`, role: "shop", pin: String(5000 + i) });
    phones.push(new Phone(crew + 2 + i, { path: "/api/auth/pin", body: { user_id: u.id, pin: String(5000 + i) } }));
  }
  for (const n of ["B-1", "B-2"]) {
    const t = await adminPost("/admin/trailers", { trailer_number: n });
    trailerIds.push(t.id);
    for (const type of ["string_trimmer", "blower", "hedge_trimmer", "chainsaw"]) {
      await adminPost("/admin/equipment", { tag: `${n}-${type}`, type, trailer_id: t.id });
    }
  }
  // Configs, read once through the bad connection like a phone would.
  const sup = phones[crew];
  await sup.signIn();
  vehicles = await sup.get("/vehicles");
  const form = await sup.get("/form-config");
  checklist = form.checklist;
  formAsOf = form.as_of;
  yardCfg = await sup.get("/yard-config");
  yardId = (await sup.get("/yards"))[0].id;
  for (const t of trailerIds) equipCfg.set(t, await sup.get(`/equipment-config/${t}`));
  return phones;
}

// ---------- One phone's day ----------

async function phoneLoop(p: Phone, role: "crew" | "sup" | "shop", until: number) {
  await p.signIn();
  while (Date.now() < until) {
    await sleep(2000 + rnd(12_000));
    const make = role === "crew" ? inspectionOp
      : role === "sup" ? pick([yardOp, yardOp, inspectionOp, incidentOp])
      : pick([checkOp, serviceOp, equipmentServiceOp]);
    const op = make();
    ledger.push(op);
    p.queue.push(op);
    // Sometimes the phone is offline for a while and saves a few before sending.
    if (Math.random() < 0.15 && p.queue.length < 4) continue;
    while (p.queue.length) await p.send(p.queue.shift()!, photoData);
  }
  while (p.queue.length) await p.send(p.queue.shift()!, photoData);
}

// ---------- Check ----------

async function verify() {
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  const problems: string[] = [];
  const tables: Record<Kind, { table: string; items?: string; photos: string }> = {
    inspection: { table: "inspections", items: "SELECT count(*) FROM inspection_items WHERE inspection_id = t.id", photos: "inspection_id" },
    yard: { table: "yard_inspections", items: "SELECT count(*) FROM yard_inspection_items WHERE yard_inspection_id = t.id", photos: "yard_inspection_id" },
    check: { table: "equipment_checks", items: "SELECT count(*) FROM equipment_check_items WHERE check_id = t.id", photos: "equipment_check_id" },
    service: { table: "service_logs", photos: "service_log_id" },
    equipment_service: { table: "equipment_service_logs", photos: "equipment_service_log_id" },
    incident: { table: "incidents", items: "SELECT count(*) FROM damage_marks WHERE incident_id = t.id", photos: "incident_id" },
  };
  const summary: Record<string, { made: number; found: number; extra: number }> = {};
  for (const [kind, t] of Object.entries(tables) as [Kind, typeof tables[Kind]][]) {
    const ops = ledger.filter((o) => o.kind === kind);
    const rows = (await db.query(
      `SELECT t.client_id::text AS client_id, ${t.items ? `(${t.items})::int` : "0"} AS items,
              (SELECT count(*) FROM photos ph WHERE ph.${t.photos} = t.id)::int AS photos
         FROM ${t.table} t WHERE t.client_id IS NOT NULL`)).rows;
    const byId = new Map(rows.map((r) => [r.client_id, r]));
    for (const o of ops) {
      const r = byId.get(o.clientId);
      if (!r) { problems.push(`LOST ${kind} ${o.clientId} (confirmed to the phone: ${o.confirmed})`); continue; }
      if (t.items && r.items !== o.items) problems.push(`INCOMPLETE ${kind} ${o.clientId}: ${r.items} answers, expected ${o.items}`);
      if (r.photos !== o.photos.length) problems.push(`PHOTOS ${kind} ${o.clientId}: ${r.photos} attached, expected ${o.photos.length}`);
    }
    const mine = new Set(ops.map((o) => o.clientId));
    const extra = rows.filter((r) => !mine.has(r.client_id)).length;
    if (extra) problems.push(`EXTRA ${extra} ${kind} record(s) no phone made`);
    summary[kind] = { made: ops.length, found: rows.filter((r) => mine.has(r.client_id)).length, extra };
  }
  // Every photo a phone took ended up on its record.
  const ids = ledger.flatMap((o) => o.photos);
  const attached = (await db.query(`SELECT count(*)::int AS n FROM photos WHERE id = ANY($1::uuid[]) AND NOT (${UNATTACHED})`, [ids])).rows[0].n;
  // Every photo file is on disk and whole.
  const files = (await db.query(`SELECT id::text, file_path, bytes FROM photos WHERE id = ANY($1::uuid[])`, [ids])).rows;
  for (const f of files) {
    const want = photoData.get(f.id)!;
    let got: Buffer | null = null;
    try { got = readFileSync(join(UPLOADS, f.file_path)); } catch { /* missing */ }
    if (!got || !got.equals(want)) problems.push(`PHOTO FILE ${f.id} ${got ? "differs from what the phone sent" : "is missing"}`);
  }
  if (attached !== ids.length) problems.push(`PHOTOS ${ids.length - attached} of ${ids.length} photos not attached to their record`);
  await db.end();
  return { problems, summary, photos: { taken: ids.length, attached } };
}

// ---------- Run ----------

async function main() {
  log(`burn-in: ${PHONES} phones, ${MINUTES} min, work dir ${WORK}`);
  await startApp();
  await new Promise<void>((r) => proxy.listen(PROXY_PORT, "127.0.0.1", () => r()));
  const phones = await setup();
  const until = Date.now() + MINUTES * 60_000;
  const crew = PHONES - 4;
  const loops = phones.map((p, i) => phoneLoop(p, i < crew ? "crew" : i < crew + 2 ? "sup" : "shop", until));

  // Crashes and database restarts while the phones work.
  let crashes = 0;
  let dbRestarts = 0;
  const chaosLoop = (async () => {
    let events = 0;
    while (Date.now() < until - 60_000) {
      await sleep(Math.min(CRASH_EVERY * 60_000 * (0.6 + Math.random() * 0.8), Math.max(0, until - 60_000 - Date.now())));
      if (Date.now() >= until - 60_000) break;
      if (PG_CONTAINER && ++events % 3 === 0) {
        log("restarting the database");
        execFileSync(DOCKER, ["restart", PG_CONTAINER], { stdio: "ignore" });
        dbRestarts++;
      } else {
        log("crashing the app");
        killApp();
        crashes++;
        await sleep(2000 + rnd(6000));
        await startApp();
        log("app back");
      }
    }
  })();
  const progress = setInterval(() => {
    const done = ledger.filter((o) => o.confirmed).length;
    log(`${ledger.length} made, ${done} confirmed, ${stats.retries} retries, proxy refused ${chaos.refused} / cut ${chaos.cut} / stalled ${chaos.stalled}`);
  }, 60_000);

  await chaosLoop;
  await sleep(Math.max(0, until - Date.now()));
  // Signal comes back for good: every phone sends what it still has.
  chaos.on = false;
  log("signal back; finishing uploads");
  await Promise.race([Promise.all(loops), sleep(15 * 60_000)]);
  clearInterval(progress);
  const unconfirmed = ledger.filter((o) => !o.confirmed);

  const result = await verify();
  if (unplannedExits.length) result.problems.push(`The app stopped on its own ${unplannedExits.length} time(s): ${unplannedExits.join("; ")}`);
  stopping = true;
  killApp();
  proxy.close();
  const tries = ledger.map((o) => o.tries);
  console.log(JSON.stringify({
    phones: PHONES, minutes: MINUTES, made: ledger.length, unconfirmed_at_end: unconfirmed.length,
    by_kind: result.summary, photos: result.photos, sign_ins: stats.signIns, photo_uploads: stats.photoUploads,
    retries: stats.retries, max_tries_for_one_record: Math.max(0, ...tries),
    proxy: { refused: chaos.refused, cut_after_sending: chaos.cut, stalled: chaos.stalled, passed: chaos.passed },
    app_crashes: crashes, db_restarts: dbRestarts, app_error_log_lines: appErrors,
    rejected: stats.rejected, problems: result.problems, work_dir: WORK,
  }, null, 2));
  process.exit(result.problems.length || stats.rejected.length || unconfirmed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); killApp(); process.exit(2); });
