// One yard walk: problems first (with Resolve), then every item, photos, comments, signature, and Export PDF.
import { api } from "../api.js";
import { atLeast, errorHtml, setHeader, stale, state } from "../ui.js";
import { esc, fmtDate, lightbox } from "../util.js";
import { askTrash, resolveRepair, trashBanner, trashCard } from "./common.js";

const SECTIONS = [["fire", "Fire safety"], ["fuel", "Fuel, oil & chemicals"], ["equipment", "Equipment & charging"], ["access", "Access & security"]];

export async function render(app, id) {
  const nav = state.nav;
  setHeader({ title: "Yard walk", back: "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try {
    data = await api(`/yard-inspections/${id}`);
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  const { walk: w, items, photos } = data;
  setHeader({ title: w.yard_name, sub: `Yard walk · ${fmtDate(w.inspection_date)}`, back: `#/yard/${w.yard_id}` });
  const problems = items.filter((i) => i.result === "repair");
  const photoBox = (list) => list.length ? `<div class="row" style="margin-top:6px">${list.map((p) =>
    `<img class="dmgthumb" src="/api/photos/${esc(p.id)}" data-lb="${esc(p.id)}" data-cap="${esc(p.caption || "")}" alt="Photo">`).join("")}</div>` : "";

  const live = !data.trash;
  let h = `${trashBanner(data.trash)}<div class="card" style="margin-top:14px"><dl class="kv">
      <dt>Yard</dt><dd>${esc(w.yard_name)}</dd><dt>Date</dt><dd>${fmtDate(w.inspection_date)}</dd>
      <dt>Inspector</dt><dd>${esc(w.inspector_name)}</dd>
      <dt>Problems</dt><dd>${problems.length ? `${problems.length} (${problems.filter((p) => !p.resolved_at).length} open)` : "None ✓"}</dd></dl>
    ${atLeast("supervisor") ? `<a class="secondary" style="width:100%;margin-top:12px" href="/api/yard-inspections/${esc(w.id)}/pdf" download>Export PDF</a>` : ""}</div>`;
  if (problems.length) {
    h += `<h2>Problems</h2><div class="card"><ul class="repairlist">${problems.map((p) => `<li><div class="spread" style="align-items:flex-start"><div class="grow">
        <b>${esc(p.label)}</b> ${p.resolved_at ? `<span class="pill okk">Resolved ${fmtDate(p.resolved_at)}</span>` : `<span class="pill bad">Open</span>`}
        ${p.note ? `<div>${esc(p.note)}</div>` : ""}
        ${p.resolved_at ? `<div class="small muted">${esc(p.resolved_by_name || "")}: ${esc(p.resolution_note || "")}</div>` : ""}
        ${photoBox(photos.filter((ph) => ph.item_id === p.id))}</div>
        ${!p.resolved_at && live && atLeast("supervisor") ? `<div class="btncol"><button class="secondary" data-yresolve="${p.id}" data-label="${esc(p.label)}">Resolve</button></div>` : ""}
      </div></li>`).join("")}</ul></div>`;
  }
  h += `<h2>Checklist</h2>${SECTIONS.map(([key, title]) => {
    const rows = items.filter((i) => i.section === key);
    if (!rows.length) return "";
    return `<div class="card"><h3 style="margin:0 0 6px">${title}</h3>${rows.map((i) => `<div class="spread" style="padding:6px 0;border-bottom:1px solid var(--line)">
        <span>${esc(i.label)}</span><span class="pill ${i.result === "repair" ? "bad" : "okk"}">${i.result === "repair" ? "Repair" : "OK"}</span></div>`).join("")}</div>`;
  }).join("")}`;
  const general = photos.filter((p) => !p.item_id);
  if (general.length) h += `<h2>Photos</h2><div class="card">${photoBox(general)}</div>`;
  if (w.comments) h += `<h2>Comments</h2><div class="card" style="white-space:pre-wrap">${esc(w.comments)}</div>`;
  h += `<h2>Signature</h2><div class="card"><img class="sigpic" src="/api/yard-inspections/${esc(w.id)}/signature" alt="Signature">
    <div class="small muted">${esc(w.inspector_name)}</div></div>`;
  const trashNote = "Its open problems come off the board. ";
  if (live && atLeast("admin")) h += trashCard("yard walk", trashNote);
  app.innerHTML = h;
  app.querySelector("[data-trash]")?.addEventListener("click", async () => {
    if (await askTrash("yard_walk", w.id, "yard walk", trashNote) && !stale(nav)) location.hash = `#/yard/${w.yard_id}`;
  });

  app.querySelectorAll("[data-lb]").forEach((img) => (img.onclick = () => lightbox(img.src, img.dataset.cap)));
  app.querySelectorAll("[data-yresolve]").forEach((b) => (b.onclick = async () => {
    if (await resolveRepair(b.dataset.yresolve, b.dataset.label, `/yard-findings/${b.dataset.yresolve}/resolve`) && !stale(nav)) render(app, id);
  }));
}
