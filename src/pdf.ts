import type { Browser } from "playwright";
import { getBranding } from "./branding.ts";
import { readDiagram } from "./diagrams.ts";
import { CATEGORIES, maintenanceForInspection } from "./routes/service.ts";
import type { MaintenanceEntry } from "./routes/service.ts";
import { files } from "./storage.ts";

type Data = NonNullable<Awaited<ReturnType<typeof import("./routes/inspections.ts").loadInspection>>>;

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * "2026-11-10" -> "11/10/2026". Timestamps (sign-off, fixed, logged) print as the date in the server's time zone
 * (TZ, set in .env for Docker), not UTC, so evening work doesn't show as the next day.
 */
export const fmtDate = (d: unknown) => {
  if (!d) return "";
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split("-");
    return `${Number(m)}/${Number(day)}/${y}`;
  }
  const t = d instanceof Date ? d : new Date(String(d));
  if (Number.isNaN(t.getTime())) return String(d);
  return `${t.getMonth() + 1}/${t.getDate()}/${t.getFullYear()}`;
};

const CHECK = `<svg class="ck" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function dataUrl(buf: Buffer, mime: string) {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export async function safeRead(key: string | null | undefined): Promise<Buffer | null> {
  if (!key) return null;
  try {
    return await files.read(key);
  } catch {
    return null;
  }
}

const DIAGRAM_MAX_IN = 2.85;

function diagramBlock(src: string | null, marks: Data["damage"], maxIn = DIAGRAM_MAX_IN) {
  if (!src) return `<div class="nodia">No diagram on file for this truck.</div>`;
  const pins = marks
    .map((m) => `<span class="pin" style="left:${(Number(m.x) * 100).toFixed(2)}%;top:${(Number(m.y) * 100).toFixed(2)}%">${m.seq}</span>`)
    .join("");
  const legend = marks.length
    ? `<ol class="legend">${marks.map((m) => `<li value="${m.seq}">${esc(m.note || "(no description)")}</li>`).join("")}</ol>`
    : `<div class="legend none">No new damage marked.</div>`;
  return `<div class="dia"><img src="${src}" alt="" style="max-height:${maxIn.toFixed(2)}in">${pins}</div>${legend}`;
}

type Item = Data["items"][number];

/** Maintenance entry number (as printed in the maintenance section) for each repair item it fixed. */
type FixNumbers = Map<number, number>;

/** The small line under a checklist item: the repair note, and how the repair was closed. */
function itemSub(it: Item, fixNo: FixNumbers): string {
  const parts: string[] = [];
  if (it.result === "repair" && it.note) parts.push(`<span class="rnote">${esc(it.note)}</span>`);
  if (it.resolved_at) {
    parts.push(fixNo.has(it.id)
      ? `<span class="resolved">✓ Fixed ${fmtDate(it.resolved_at)} (maintenance entry ${fixNo.get(it.id)})</span>`
      : `<span class="resolved">✓ Resolved ${fmtDate(it.resolved_at)}${it.resolved_by_name ? ` by ${esc(it.resolved_by_name)}` : ""}: ${esc(it.resolution_note)}</span>`);
  }
  return parts.length ? `<div class="sub">${parts.join(" · ")}</div>` : "";
}

/** Rough number of printed lines a bit of HTML takes in a checklist column (about 52 characters a line). */
const linesOf = (html: string) => (html ? Math.ceil(html.replace(/<[^>]+>/g, "").replace(/&\w+;|&#\d+;/g, "x").length / 52) : 0);

function itemCells(it: Item | undefined, fixNo: FixNumbers) {
  if (!it) return `<td class="c"></td><td class="c"></td><td></td>`;
  return `<td class="c">${it.result === "ok" ? CHECK : ""}</td><td class="c">${it.result === "repair" ? CHECK : ""}</td><td>${esc(it.label)}${itemSub(it, fixNo)}</td>`;
}

/** Extra lines the checklist rows need beyond one line each (a row is as tall as its taller side). */
function checklistExtraLines(left: Item[], right: Item[], fixNo: FixNumbers) {
  let n = 0;
  for (let k = 0; k < Math.max(left.length, right.length); k++) {
    n += Math.max(left[k] ? linesOf(itemSub(left[k], fixNo)) : 0, right[k] ? linesOf(itemSub(right[k], fixNo)) : 0);
  }
  return n;
}

/** Two side-by-side OK | Repair | Item column groups, like the paper form. */
function checklistTable(left: Item[], right: Item[], leftTitle: string, rightTitle: string, fixNo: FixNumbers) {
  const n = Math.max(left.length, right.length);
  let rows = "";
  for (let k = 0; k < n; k++) rows += `<tr>${itemCells(left[k], fixNo)}${itemCells(right[k], fixNo)}</tr>`;
  return `<table class="grid cl">
    <colgroup><col class="cw"><col class="cw"><col><col class="cw"><col class="cw"><col></colgroup>
    <thead><tr class="sh"><th>OK</th><th>Repair</th><th class="l">${esc(leftTitle)}</th><th>OK</th><th>Repair</th><th class="l">${esc(rightTitle)}</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function buildInspectionHtml(d: Data, assets: {
  truckDiagram: string | null; trailerDiagram: string | null;
  employeeSig: string | null; supervisorSig: string | null;
  photos: { src: string; caption: string }[];
  brand: { company: string; logo: string | null };
  maintenance?: MaintenanceEntry[];
}): string {
  const i = d.inspection;
  const maint = assets.maintenance ?? [];
  const fixNo: FixNumbers = new Map(maint.flatMap((m, n) => m.repairs.map((r) => [r.id, n + 1] as [number, number])));
  const info = [i.year, i.make, i.model].filter(Boolean).join(" ");
  const brandBar = `<div class="brand">${assets.brand.logo ? `<img src="${assets.brand.logo}" alt="">` : ""}
    <div><b>${esc(assets.brand.company)}</b><span>Truck Inspection Sheet</span></div></div>`;
  const header = `<table class="grid hdr">
    <tr><th>Truck ID</th><td>${esc(i.truck_code)}</td><th>Unit</th><td>${esc(i.unit)}</td></tr>
    <tr><th>VIN #</th><td>${esc(i.vin)}</td><th>Plate</th><td>${esc(i.plate)}</td></tr>
    <tr><th>Info</th><td>${esc(info)}</td><th>Expiration</th><td>${fmtDate(i.registration_expires)}</td></tr></table>`;

  const ext = d.items.filter((x) => x.section === "exterior");
  const int = d.items.filter((x) => x.section === "interior");
  const trl = d.items.filter((x) => x.section === "trailer");
  const truckMarks = d.damage.filter((m) => m.diagram === "truck");
  const trailerMarks = d.damage.filter((m) => m.diagram === "trailer");
  const flagged = i.mileage_flagged
    ? `<div class="flag">Lower than last recorded (${Number(i.previous_mileage).toLocaleString("en-US")})</div>` : "";

  // Page 1 should hold the whole sheet. Repair notes, a long damage legend or long notes add lines, so shrink the
  // diagram a little for each line beyond what fits (about 0.14in a line), down to 1.9in so pins stay readable.
  const noteLines = (s: string | null) => (s ? s.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 60)), 0) : 0);
  const extraLines = checklistExtraLines(ext, int, fixNo)
    + Math.max(0, Math.ceil(truckMarks.length / 2) - 1)
    + Math.max(0, Math.max(noteLines(i.existing_notes), noteLines(i.new_observations)) - 4);
  const diagramIn = Math.max(1.9, DIAGRAM_MAX_IN - 0.14 * Math.max(0, extraLines - 3));

  const page1 = `<section class="p1">
    ${brandBar}
    ${header}
    <table class="grid meta">
      <tr class="sh"><th style="width:16%">Date</th><th>Name of Inspector</th><th colspan="2" style="width:17%">Oil Change Due</th><th style="width:27%">Current Mileage</th></tr>
      <tr><td class="v">${fmtDate(i.inspection_date)}</td><td class="v">${esc(i.inspector_name)}</td>
        <td class="yn${i.oil_change_due ? " on" : ""}">YES</td><td class="yn${i.oil_change_due ? "" : " on"}">NO</td>
        <td class="v">${i.mileage != null ? Number(i.mileage).toLocaleString("en-US") : ""}${flagged}</td></tr>
      <tr><td colspan="5" class="diacell">${diagramBlock(assets.truckDiagram, truckMarks, diagramIn)}</td></tr>
    </table>
    <table class="grid notes">
      <tr class="sh"><th class="l">Existing Notes:</th><th class="l">New Observations:</th></tr>
      <tr><td>${esc(i.existing_notes)}</td><td>${esc(i.new_observations)}</td></tr>
    </table>
    ${checklistTable(ext, int, "Inspection Item (Exterior)", "Inspection Items (Interior)", fixNo)}
  </section>`;

  const signoff = `<table class="grid sign">
    <tr class="sh"><th class="l">COMMENTS:</th></tr>
    <tr><td class="comments">${esc(i.comments)}</td></tr></table>
    <table class="grid sign">
      <tr class="sh"><th class="l">Employee Signature</th><th class="l" style="width:30%">Date</th></tr>
      <tr><td class="sig">${assets.employeeSig ? `<img src="${assets.employeeSig}" alt="">` : ""}<div class="who">${esc(i.inspector_name)}</div></td>
          <td class="v">${fmtDate(i.inspection_date)}</td></tr>
      <tr class="sh"><th class="l">Supervisor Signature</th><th class="l">Date</th></tr>
      <tr><td class="sig">${assets.supervisorSig ? `<img src="${assets.supervisorSig}" alt="">` : ""}<div class="who">${esc(i.supervisor_name ?? "")}</div></td>
          <td class="v">${fmtDate(i.supervisor_signed_at)}</td></tr>
      ${i.supervisor_note ? `<tr><td colspan="2"><b>Supervisor note:</b> ${esc(i.supervisor_note)}</td></tr>` : ""}
    </table>`;

  const page2 = i.trailer_inspected
    ? `<section class="trl">
        ${header}
        <table class="grid meta">
          <tr><th style="width:18%">Trailer Number</th><td class="v">${esc(i.trailer_number_text)}</td><th style="width:18%">Plate Number</th><td class="v">${esc(i.trailer_plate_text)}</td></tr>
          ${d.trailerDiagram?.name ? `<tr><th>Trailer Type</th><td colspan="3" class="v">${esc(d.trailerDiagram.name)}</td></tr>` : ""}
          <tr><td colspan="4" class="diacell">${diagramBlock(assets.trailerDiagram, trailerMarks)}</td></tr>
        </table>
        ${checklistTable(trl.slice(0, Math.ceil(trl.length / 2)), trl.slice(Math.ceil(trl.length / 2)), "Inspection Item", "Inspection Items", fixNo)}
        ${signoff}
      </section>`
    : `<section class="keep">${signoff}</section>`;

  const photoPages = assets.photos.length
    ? `<section class="photos"><h2>Photos — ${esc(i.truck_code)} · ${fmtDate(i.inspection_date)}</h2>
        <div class="pgrid">${assets.photos.map((p) => `<figure><img src="${p.src}" alt=""><figcaption>${esc(p.caption)}</figcaption></figure>`).join("")}</div></section>`
    : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(i.truck_code)} inspection</title><style>${CSS}</style></head>
  <body>${page1}${page2}${maintenanceSection(maint)}${photoPages}</body></html>`;
}

const money = (v: unknown) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The maintenance entries that closed this inspection's repairs, numbered to match the checklist. */
function maintenanceSection(list: MaintenanceEntry[]) {
  if (!list.length) return "";
  const row = (label: string, value: string) => (value ? `<tr><th>${label}</th><td colspan="3">${value}</td></tr>` : "");
  return `<section class="maint"><h2>Repairs fixed — maintenance log</h2>${list.map((m, n) => {
    const fixed = m.repairs.map((r) => `${esc(r.label)}${r.note ? ` <span class="rnote">(${esc(r.note)})</span>` : ""}`).join("<br>")
      + (m.other_repairs ? `<br><span class="muted">Also fixed ${m.other_repairs} repair${m.other_repairs > 1 ? "s" : ""} from other inspections.</span>` : "");
    const who = [m.performed_by ? esc(m.performed_by) : "", m.vendor ? `outside shop: ${esc(m.vendor)}` : ""].filter(Boolean).join(" · ");
    const nextDue = m.work.filter((w) => w.next_due_mileage != null || w.next_due_date).map((w) =>
      `${esc(CATEGORIES[w.type] ?? w.type)}: ${[w.next_due_mileage != null ? `${w.next_due_mileage.toLocaleString("en-US")} mi` : "",
        w.next_due_date ? fmtDate(w.next_due_date) : ""].filter(Boolean).join(" or ")}`).join("<br>");
    const logged = `${fmtDate(m.created_at)}${m.created_by_name ? ` by ${esc(m.created_by_name)}` : ""}${
      m.edits ? ` · changed ${m.edits} time${m.edits > 1 ? "s" : ""} after that (history in the app)` : ""}`;
    return `<table class="grid mt">
      <tr class="sh"><th colspan="4" class="l">Maintenance entry ${n + 1} · ${esc(m.category_label)}</th></tr>
      <tr><th>Date</th><td class="v">${fmtDate(m.service_date)}</td><th>Mileage</th><td class="v">${m.mileage != null ? Number(m.mileage).toLocaleString("en-US") : ""}</td></tr>
      <tr><th>Done by</th><td class="v">${who}</td><th>Cost</th><td class="v">${m.cost != null ? money(m.cost) : ""}</td></tr>
      ${row("Repairs fixed", fixed)}
      ${row("Work done", esc(m.description))}
      ${row("Parts", esc(m.parts ?? ""))}
      ${row("Notes", esc(m.notes ?? ""))}
      ${row("Next due", nextDue)}
      ${row("Logged", logged)}
    </table>`;
  }).join("")}</section>`;
}

const CSS = `
@page { size: Letter; margin: 0.4in 0.45in; }
* { box-sizing: border-box; }
body { margin: 0; font: 9pt/1.22 Calibri, Carlito, "Liberation Sans", Arial, sans-serif; color: #111; }
/* Page 1 is sized to fit (see diagramIn). If a very busy sheet still doesn't, the checklist carries on to the next page
   with its header repeated, followed by the sign-off; the trailer sheet always starts a page of its own. */
.trl { break-before: page; }
.cl thead { display: table-header-group; }
.cl tr { break-inside: avoid; }
.keep { break-inside: avoid; margin-top: 8pt; }
.brand { display: flex; align-items: center; gap: 10pt; margin-bottom: 5pt; height: 0.36in; }
.brand img { max-height: 0.36in; max-width: 1.6in; object-fit: contain; }
.brand b { font-size: 12pt; margin-right: 8pt; }
.brand span { font-size: 10pt; color: #444; letter-spacing: 0.04em; text-transform: uppercase; }
table.grid { width: 100%; border-collapse: collapse; margin-bottom: 7pt; }
.grid th, .grid td { border: 0.8pt solid #222; padding: 2.5pt 5pt; vertical-align: top; }
.grid th { background: #d9d9d9; font-weight: 700; text-align: center; }
.grid th.l { text-align: left; }
.grid .sh th { background: #d9d9d9; }
.hdr th { width: 13%; }
.hdr td { font-weight: 700; }
.meta td.v { font-size: 10.5pt; height: 22pt; vertical-align: middle; text-align: center; }
.meta td.yn { text-align: center; vertical-align: middle; width: 8.5%; color: #888; }
.meta td.yn.on { color: #111; font-weight: 700; background: #fff3c4; }
.flag { font-size: 7.5pt; color: #b4402a; font-weight: 700; }
.diacell { padding: 0 !important; text-align: center; }
/* The wrapper shrink-wraps the image so pin percentages line up with the picture. */
.dia { position: relative; display: inline-block; vertical-align: top; }
.dia img { display: block; max-width: 100%; max-height: 2.85in; }
.pin { position: absolute; transform: translate(-50%, -50%); width: 15pt; height: 15pt; border-radius: 50%;
  background: #c62828; color: #fff; font-weight: 700; font-size: 8pt; display: flex; align-items: center; justify-content: center;
  border: 1.2pt solid #fff; box-shadow: 0 0 0 0.6pt #c62828; }
.legend { margin: 0; padding: 3pt 6pt 4pt 24pt; columns: 2; column-gap: 18pt; font-size: 8.5pt; border-top: 0.8pt solid #222; text-align: left; }
.legend.none { padding-left: 6pt; color: #555; columns: 1; }
.legend li { break-inside: avoid; }
.nodia { padding: 30pt; text-align: center; color: #777; }
.notes td { height: 50pt; width: 50%; white-space: pre-wrap; font-size: 9pt; }
.cl col.cw { width: 5.5%; }
.cl td { padding: 1.2pt 4pt; }
.cl td.c { text-align: center; vertical-align: middle; }
.ck { width: 10pt; height: 10pt; vertical-align: middle; }
.sub { font-size: 7.8pt; line-height: 1.2; }
.rnote { font-size: 7.8pt; color: #b4402a; font-style: italic; }
.resolved { font-size: 7.6pt; color: #2f6b3a; }
.comments { height: 48pt; white-space: pre-wrap; }
.sign td.sig { height: 42pt; position: relative; }
.sign td.sig img { height: 36pt; max-width: 70%; }
.sign .who { position: absolute; right: 6pt; bottom: 3pt; font-size: 8pt; color: #444; }
.sign td.v { vertical-align: middle; }
.maint { margin-top: 10pt; }
.maint h2 { font-size: 12pt; margin: 0 0 6pt; break-after: avoid; }
.mt { break-inside: avoid; }
.mt th { width: 14%; text-align: left; }
.mt td { white-space: pre-wrap; }
.mt td.v { width: 36%; }
.mt .muted { color: #555; font-size: 8pt; }
.photos h2 { font-size: 12pt; margin: 0 0 8pt; }
.photos { break-before: page; }
.pgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; }
.pgrid figure { margin: 0; break-inside: avoid; border: 0.8pt solid #bbb; padding: 4pt; }
.pgrid img { display: block; width: 100%; height: 3.3in; object-fit: contain; background: #f4f4f4; }
.pgrid figcaption { font-size: 8.5pt; padding-top: 3pt; min-height: 11pt; }
`;

// ---------- Rendering ----------

let browserP: Promise<Browser> | null = null;

async function browser(): Promise<Browser> {
  if (!browserP) {
    browserP = import("playwright").then(({ chromium }) =>
      chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] }));
    browserP.catch(() => { browserP = null; });
  }
  const b = await browserP;
  if (!b.isConnected()) {
    browserP = null;
    return browser();
  }
  return b;
}

export async function closePdfBrowser(): Promise<void> {
  if (browserP) await (await browserP.catch(() => null))?.close().catch(() => {});
  browserP = null;
}

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const b = await browser();
  const ctx = await b.newContext({ javaScriptEnabled: false });
  try {
    const page = await ctx.newPage();
    // Only inline data: URLs are used; refuse any network access from the template.
    await page.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    return await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function renderInspectionPdf(d: Data): Promise<Buffer> {
  return renderHtmlToPdf(await inspectionPdfHtml(d));
}

/** The PDF's HTML with every image inlined (separate from rendering so tests can check it). */
export async function inspectionPdfHtml(d: Data): Promise<string> {
  const i = d.inspection;
  const truckDia = d.truckDiagram.file_path ? await readDiagram(d.truckDiagram.file_path).catch(() => null) : null;
  const trailerDia = d.trailerDiagram?.file_path ? await readDiagram(d.trailerDiagram.file_path).catch(() => null) : null;
  const emp = await safeRead(i.employee_signature_path);
  const sup = await safeRead(i.supervisor_signature_path);
  const brand = await getBranding();
  const logo = await safeRead(brand.logo_key);

  const markSeq = new Map(d.damage.map((m) => [m.id, `${m.diagram === "trailer" ? "Trailer damage" : "Damage"} ${m.seq}`]));
  const itemLabel = new Map(d.items.map((it) => [it.id, it.label]));
  const photos: { src: string; caption: string }[] = [];
  for (const p of d.photos) {
    const buf = await safeRead(p.file_path);
    if (!buf) continue;
    const ctx = p.damage_mark_id ? markSeq.get(p.damage_mark_id) : p.inspection_item_id ? `Repair: ${itemLabel.get(p.inspection_item_id)}` : "";
    photos.push({
      src: dataUrl(buf, buf[0] === 0x89 ? "image/png" : "image/jpeg"),
      caption: [ctx, p.caption].filter(Boolean).join(" — "),
    });
  }

  // Maintenance entries that closed this inspection's repairs; their photos go on the photo pages too.
  const maintenance = await maintenanceForInspection(i.id);
  for (const [n, m] of maintenance.entries()) {
    for (const p of m.photos) {
      const buf = await safeRead(p.file_path);
      if (!buf) continue;
      photos.push({
        src: dataUrl(buf, buf[0] === 0x89 ? "image/png" : "image/jpeg"),
        caption: [`Maintenance entry ${n + 1}`, p.caption].filter(Boolean).join(" — "),
      });
    }
  }

  return buildInspectionHtml(d, {
    truckDiagram: truckDia ? dataUrl(truckDia.data, truckDia.mime) : null,
    trailerDiagram: trailerDia ? dataUrl(trailerDia.data, trailerDia.mime) : null,
    employeeSig: emp ? dataUrl(emp, "image/png") : null,
    supervisorSig: sup ? dataUrl(sup, "image/png") : null,
    photos,
    brand: { company: brand.company_name, logo: logo ? dataUrl(logo, logo[0] === 0x89 ? "image/png" : "image/jpeg") : null },
    maintenance,
  });
}
