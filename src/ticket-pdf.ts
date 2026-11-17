// The repair ticket PDF: the company's branding, the ticket number, the truck, each repair with its note and photos,
// and blank lines for whoever does the work (work done, parts, hours, cost, date, signature). Printed or shared from
// the phone; it goes to the in-house shop or an outside vendor.
import { getBranding } from "./branding.ts";
import { dataUrl, esc, fmtDate, safeRead } from "./pdf.ts";
import type { Ticket } from "./routes/tickets.ts";

const SECTION: Record<string, string> = { exterior: "Exterior", interior: "Interior", trailer: "Trailer & crew" };

/** "Fixed 11/17/2026 by Robin (maintenance log): New bulb". A maintenance entry's note already starts "Fixed (…)". */
function fixedLine(it: Ticket["items"][number]): string {
  const how = (it.resolution_note ?? "").replace(/^Fixed /, "");
  return `Fixed ${fmtDate(it.resolved_at)}${it.resolved_by_name ? ` by ${esc(it.resolved_by_name)}` : ""}${
    how ? `${how.startsWith("(") ? " " : ": "}${esc(how)}` : ""}`;
}

export function buildTicketHtml(t: Ticket, assets: {
  brand: { company: string; logo: string | null };
  photos: { src: string; caption: string }[];
}): string {
  const info = [t.year, t.make, t.model].filter(Boolean).join(" ");
  const miles = t.last_mileage != null ? Number(t.last_mileage).toLocaleString("en-US") : "";
  const rows = t.items.map((it) => `<tr>
      <td class="n">${it.position}</td>
      <td><b>${esc(it.label)}</b><div class="sub">${esc(SECTION[it.section] ?? it.section)}</div></td>
      <td class="note">${esc(it.note)}${it.resolved_at ? `<div class="fixed">${fixedLine(it)}</div>` : ""}</td>
      <td class="rep">${fmtDate(it.inspection_date)}<div class="sub">${esc(it.inspector_name)}</div></td>
      <td class="done"></td>
    </tr>`).join("");
  const line = (label: string, cls = "") => `<tr><th>${label}</th><td colspan="3" class="${cls}"></td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
  ${t.voided ? `<div class="void">VOID</div>` : ""}
  <div class="top">
    <div class="brand">${assets.brand.logo ? `<img src="${assets.brand.logo}" alt="">` : ""}
      <div><b>${esc(assets.brand.company)}</b><span>Repair Ticket</span></div></div>
    <div class="num"><b>${esc(t.number)}</b><span>Made ${fmtDate(t.created_at)} by ${esc(t.created_by_name)}</span></div>
  </div>
  ${t.voided ? `<div class="voidnote">Voided ${fmtDate(t.voided_at)} by ${esc(t.voided_by_name)}: ${esc(t.void_reason)}</div>` : ""}
  <table class="grid hdr">
    <tr><th>Truck ID</th><td>${esc(t.truck_code)}</td><th>Unit</th><td>${esc(t.unit)}</td></tr>
    <tr><th>VIN #</th><td>${esc(t.vin)}</td><th>Plate</th><td>${esc(t.plate)}</td></tr>
    <tr><th>Info</th><td>${esc(info)}</td><th>Last mileage</th><td>${miles}</td></tr>
    <tr><th>Sent to</th><td colspan="3">${esc(t.sent_to)}</td></tr>
    ${t.note ? `<tr><th>Note</th><td colspan="3" class="pre">${esc(t.note)}</td></tr>` : ""}
  </table>
  <table class="grid items">
    <colgroup><col style="width:4%"><col style="width:22%"><col style="width:36%"><col style="width:14%"><col style="width:24%"></colgroup>
    <thead><tr><th>#</th><th class="l">Repair</th><th class="l">Problem</th><th class="l">Reported</th><th class="l">Work done (shop)</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table class="grid shop">
    ${line("Work done", "tall")}
    ${line("Parts used", "mid")}
    <tr><th>Labor hours</th><td></td><th>Total cost</th><td></td></tr>
    <tr><th>Date finished</th><td></td><th>Mileage</th><td></td></tr>
    <tr><th>Shop / mechanic</th><td></td><th>Signature</th><td class="sig"></td></tr>
  </table>
  <p class="foot">Please return this ticket with the invoice. ${esc(t.number)} · ${esc(t.truck_code)}</p>
  ${assets.photos.length ? `<section class="photos"><h2>Photos · ${esc(t.number)} · ${esc(t.truck_code)}</h2><div class="pgrid">${
    assets.photos.map((p) => `<figure><img src="${p.src}" alt=""><figcaption>${esc(p.caption)}</figcaption></figure>`).join("")}</div></section>` : ""}
  </body></html>`;
}

/** The ticket's HTML with the logo and photos inlined (separate from rendering so tests can check it). */
export async function ticketPdfHtml(t: Ticket): Promise<string> {
  const brand = await getBranding();
  const logo = await safeRead(brand.logo_key);
  const photos: { src: string; caption: string }[] = [];
  for (const it of t.items) {
    for (const p of it.photos) {
      const buf = await safeRead(p.file_path);
      if (!buf) continue;
      photos.push({
        src: dataUrl(buf, buf[0] === 0x89 ? "image/png" : "image/jpeg"),
        caption: [`${it.position}. ${it.label}`, p.caption].filter(Boolean).join(" — "),
      });
    }
  }
  return buildTicketHtml(t, {
    brand: { company: brand.company_name, logo: logo ? dataUrl(logo, logo[0] === 0x89 ? "image/png" : "image/jpeg") : null },
    photos,
  });
}

const CSS = `
@page { size: Letter; margin: 0.45in 0.5in; }
* { box-sizing: border-box; }
body { margin: 0; font: 10pt/1.25 Calibri, Carlito, "Liberation Sans", Arial, sans-serif; color: #111; position: relative; }
.top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8pt; }
.brand { display: flex; align-items: center; gap: 10pt; height: 0.42in; }
.brand img { max-height: 0.42in; max-width: 1.7in; object-fit: contain; }
.brand b { font-size: 13pt; margin-right: 8pt; }
.brand span { font-size: 11pt; color: #444; letter-spacing: 0.05em; text-transform: uppercase; }
.num { text-align: right; }
.num b { display: block; font-size: 20pt; letter-spacing: 0.02em; }
.num span { font-size: 8.5pt; color: #444; }
table.grid { width: 100%; border-collapse: collapse; margin-bottom: 9pt; }
.grid th, .grid td { border: 0.8pt solid #222; padding: 3pt 5pt; vertical-align: top; }
.grid th { background: #d9d9d9; font-weight: 700; text-align: left; }
.hdr th { width: 13%; }
.hdr td { font-weight: 700; }
.hdr td.pre { font-weight: 400; white-space: pre-wrap; }
.items thead { display: table-header-group; }
.items tr { break-inside: avoid; }
.items td.n { text-align: center; font-weight: 700; }
.items td.note { white-space: pre-wrap; }
.items td.done { min-height: 34pt; height: 34pt; }
.sub { font-size: 8pt; color: #555; }
.fixed { font-size: 8pt; color: #2f6b3a; margin-top: 2pt; }
.shop { break-inside: avoid; }
.shop th { width: 16%; }
.shop td.tall { height: 60pt; }
.shop td.mid { height: 30pt; }
.shop td.sig { height: 30pt; }
.foot { font-size: 8.5pt; color: #555; margin: 0; }
.void { position: fixed; top: 38%; left: 0; right: 0; text-align: center; font-size: 110pt; font-weight: 700;
  color: rgba(198, 40, 40, 0.18); transform: rotate(-24deg); z-index: 10; }
.voidnote { border: 1pt solid #c62828; color: #c62828; padding: 4pt 6pt; margin-bottom: 8pt; font-weight: 700; }
.photos { break-before: page; }
.photos h2 { font-size: 12pt; margin: 0 0 8pt; }
.pgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; }
.pgrid figure { margin: 0; break-inside: avoid; border: 0.8pt solid #bbb; padding: 4pt; }
.pgrid img { display: block; width: 100%; height: 3.3in; object-fit: contain; background: #f4f4f4; }
.pgrid figcaption { font-size: 8.5pt; padding-top: 3pt; min-height: 11pt; }
`;
