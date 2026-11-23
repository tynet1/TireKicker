// The yard walk PDF: branding, the yard, date and inspector, every checklist item with OK or Repair and its note
// (and how a finding was resolved), comments, the signature, and photos on the following pages.
import { getBranding } from "./branding.ts";
import { dataUrl, esc, fmtDate, safeRead } from "./pdf.ts";
import { YARD_SECTIONS } from "./routes/checklist.ts";
import type { YardWalk } from "./routes/yard.ts";

export function buildYardHtml(d: YardWalk, assets: {
  brand: { company: string; logo: string | null };
  signature: string | null;
  photos: { src: string; caption: string }[];
}): string {
  const w = d.walk;
  const failed = d.items.filter((i) => i.result === "repair");
  const sections = YARD_SECTIONS.map((s) => {
    const rows = d.items.filter((i) => i.section === s.key);
    if (!rows.length) return "";
    return `<tr class="sh"><th colspan="3">${esc(s.title)}</th></tr>${rows.map((i) => `<tr>
        <td>${esc(i.label)}</td>
        <td class="r ${i.result === "repair" ? "bad" : ""}">${i.result === "repair" ? "Repair" : "OK"}</td>
        <td>${esc(i.note)}${i.resolved_at ? `<div class="fixed">Resolved ${fmtDate(i.resolved_at)}${
          i.resolved_by_name ? ` by ${esc(i.resolved_by_name)}` : ""}: ${esc(i.resolution_note)}</div>` : ""}</td></tr>`).join("")}`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
  <div class="top">
    <div class="brand">${assets.brand.logo ? `<img src="${assets.brand.logo}" alt="">` : ""}
      <div><b>${esc(assets.brand.company)}</b><span>Yard Inspection</span></div></div>
    <div class="num"><b>${esc(w.yard_name)}</b><span>${fmtDate(w.inspection_date)}</span></div>
  </div>
  <table class="grid hdr">
    <tr><th>Yard</th><td>${esc(w.yard_name)} (${esc(w.yard_code)})</td><th>Date</th><td>${fmtDate(w.inspection_date)}</td></tr>
    <tr><th>Inspector</th><td>${esc(w.inspector_name)}</td><th>Problems</th><td>${failed.length ? `${failed.length}` : "None"}</td></tr>
  </table>
  <table class="grid items">
    <colgroup><col style="width:46%"><col style="width:10%"><col style="width:44%"></colgroup>
    <thead><tr><th class="l">Item</th><th>Result</th><th class="l">Note</th></tr></thead>
    <tbody>${sections}</tbody>
  </table>
  <table class="grid sign">
    <tr><th>Comments</th><td class="pre">${esc(w.comments)}</td></tr>
    <tr><th>Signature</th><td class="sig">${assets.signature ? `<img src="${assets.signature}" alt="">` : ""}<span class="who">${esc(w.inspector_name)}</span></td></tr>
  </table>
  ${assets.photos.length ? `<section class="photos"><h2>Photos · ${esc(w.yard_name)} · ${fmtDate(w.inspection_date)}</h2><div class="pgrid">${
    assets.photos.map((p) => `<figure><img src="${p.src}" alt=""><figcaption>${esc(p.caption)}</figcaption></figure>`).join("")}</div></section>` : ""}
  </body></html>`;
}

/** The walk's HTML with the logo, signature and photos inlined (separate from rendering so tests can check it). */
export async function yardPdfHtml(d: YardWalk): Promise<string> {
  const brand = await getBranding();
  const logo = await safeRead(brand.logo_key);
  const sig = await safeRead(d.walk.signature_path);
  const label = new Map(d.items.map((i) => [i.id, i.label as string]));
  const photos: { src: string; caption: string }[] = [];
  for (const p of d.photos) {
    const buf = await safeRead(p.file_path);
    if (!buf) continue;
    photos.push({
      src: dataUrl(buf, buf[0] === 0x89 ? "image/png" : "image/jpeg"),
      caption: [p.item_id ? `Repair: ${label.get(p.item_id) ?? ""}` : "", p.caption].filter(Boolean).join(" — "),
    });
  }
  return buildYardHtml(d, {
    brand: { company: brand.company_name, logo: logo ? dataUrl(logo, logo[0] === 0x89 ? "image/png" : "image/jpeg") : null },
    signature: sig ? dataUrl(sig, "image/png") : null,
    photos,
  });
}

const CSS = `
@page { size: Letter; margin: 0.45in 0.5in; }
* { box-sizing: border-box; }
body { margin: 0; font: 10pt/1.25 Calibri, Carlito, "Liberation Sans", Arial, sans-serif; color: #111; }
.top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8pt; }
.brand { display: flex; align-items: center; gap: 10pt; height: 0.42in; }
.brand img { max-height: 0.42in; max-width: 1.7in; object-fit: contain; }
.brand b { font-size: 13pt; margin-right: 8pt; }
.brand span { font-size: 11pt; color: #444; letter-spacing: 0.05em; text-transform: uppercase; }
.num { text-align: right; }
.num b { display: block; font-size: 16pt; }
.num span { font-size: 10pt; color: #444; }
table.grid { width: 100%; border-collapse: collapse; margin-bottom: 9pt; }
.grid th, .grid td { border: 0.8pt solid #222; padding: 3pt 5pt; vertical-align: top; }
.grid th { background: #d9d9d9; font-weight: 700; }
.grid th.l { text-align: left; }
.hdr th { width: 14%; text-align: left; }
.hdr td { font-weight: 700; }
.items thead { display: table-header-group; }
.items tr { break-inside: avoid; }
.items .sh th { text-align: left; background: #ececec; }
.items td.r { text-align: center; font-weight: 700; }
.items td.r.bad { color: #b4402a; background: #fff3c4; }
.fixed { font-size: 8pt; color: #2f6b3a; margin-top: 2pt; }
.sign { break-inside: avoid; }
.sign th { width: 14%; text-align: left; }
.sign td.pre { white-space: pre-wrap; height: 40pt; }
.sign td.sig { height: 46pt; position: relative; }
.sign td.sig img { height: 40pt; max-width: 70%; }
.sign .who { position: absolute; right: 6pt; bottom: 3pt; font-size: 8pt; color: #444; }
.photos { break-before: page; }
.photos h2 { font-size: 12pt; margin: 0 0 8pt; }
.pgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; }
.pgrid figure { margin: 0; break-inside: avoid; border: 0.8pt solid #bbb; padding: 4pt; }
.pgrid img { display: block; width: 100%; height: 3.3in; object-fit: contain; background: #f4f4f4; }
.pgrid figcaption { font-size: 8.5pt; padding-top: 3pt; min-height: 11pt; }
`;
