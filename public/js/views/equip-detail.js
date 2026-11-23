// One equipment check: who and when, each piece (checked or not here) with its problems first (with Resolve), then
// everything else it was checked on.
import { api } from "../api.js";
import { atLeast, errorHtml, setHeader, stale, state } from "../ui.js";
import { esc, fmtDate, lightbox } from "../util.js";
import { askTrash, resolveRepair, trashBanner, trashCard } from "./common.js";

export async function render(app, id) {
  const nav = state.nav;
  setHeader({ title: "Equipment check", back: "#/equipment" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try {
    data = await api(`/equipment-checks/${id}`);
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  const { check: c, pieces, photos } = data;
  const where = c.trailer_number || "Not on a trailer";
  setHeader({ title: where, sub: `Equipment check · ${fmtDate(c.check_date)}`, back: "#/equipment" });
  const problems = pieces.flatMap((p) => p.items.filter((i) => i.result === "repair"));
  const photoBox = (list) => list.length ? `<div class="row" style="margin-top:6px">${list.map((ph) =>
    `<img class="dmgthumb" src="/api/photos/${esc(ph.id)}" data-lb="${esc(ph.id)}" data-cap="${esc(ph.caption || "")}" alt="Photo">`).join("")}</div>` : "";

  const live = !data.trash;
  let h = `${trashBanner(data.trash)}<div class="card" style="margin-top:14px"><dl class="kv">
      <dt>Trailer</dt><dd>${esc(where)}</dd><dt>Date</dt><dd>${fmtDate(c.check_date)}</dd><dt>Checked by</dt><dd>${esc(c.checker_name)}</dd>
      <dt>Pieces</dt><dd>${pieces.filter((p) => p.status === "checked").length} checked${pieces.some((p) => p.status === "not_here")
        ? `, ${pieces.filter((p) => p.status === "not_here").length} not here` : ""}</dd>
      <dt>Problems</dt><dd>${problems.length ? `${problems.length} (${problems.filter((p) => !p.resolved_at).length} open)` : "None ✓"}</dd></dl>
    ${c.comments ? `<p style="white-space:pre-wrap;margin:12px 0 0">${esc(c.comments)}</p>` : ""}</div>`;
  for (const p of pieces) {
    const bad = p.items.filter((i) => i.result === "repair");
    const ok = p.items.filter((i) => i.result !== "repair");
    h += `<h2><a href="#/equipment/piece/${p.equipment_id}" style="color:inherit">${esc(p.tag)}</a> · ${esc(p.type_title)}</h2><div class="card">`;
    if (p.status === "not_here") {
      h += `<span class="pill grey">Not here</span>${p.note ? ` <span class="small">${esc(p.note)}</span>` : ""}`;
    } else {
      if (bad.length) {
        h += `<ul class="repairlist">${bad.map((i) => `<li><div class="spread" style="align-items:flex-start"><div class="grow">
            <b>${esc(i.label)}</b> ${i.resolved_at ? `<span class="pill okk">Resolved ${fmtDate(i.resolved_at)}</span>` : `<span class="pill bad">Open</span>`}
            ${i.note ? `<div>${esc(i.note)}</div>` : ""}
            ${i.resolved_at ? `<div class="small muted">${esc(i.resolved_by_name || "")}: ${esc(i.resolution_note || "")}</div>` : ""}
            ${photoBox(photos.filter((ph) => ph.item_id === i.id))}</div>
            ${i.resolved_at || !live ? "" : `<div class="btncol"><button class="secondary" data-eresolve="${i.id}" data-label="${esc(`${p.tag}: ${i.label}`)}">Resolve</button></div>`}
          </div></li>`).join("")}</ul>`;
      }
      h += `<div class="small muted" style="margin-top:${bad.length ? "8px" : "0"}">${bad.length ? "Also checked OK: " : "All OK: "}${ok.map((i) => esc(i.label)).join(" · ")}</div>`;
    }
    h += `</div>`;
  }
  const trashNote = "Its open problems come off the board, and it no longer counts as the pieces' last check. ";
  if (live && atLeast("admin")) h += trashCard("equipment check", trashNote);
  app.innerHTML = h;
  app.querySelector("[data-trash]")?.addEventListener("click", async () => {
    if (await askTrash("equipment_check", c.id, "equipment check", trashNote) && !stale(nav)) location.hash = "#/equipment";
  });
  app.querySelectorAll("[data-lb]").forEach((img) => (img.onclick = () => lightbox(img.src, img.dataset.cap)));
  app.querySelectorAll("[data-eresolve]").forEach((b) => (b.onclick = async () => {
    if (await resolveRepair(b.dataset.eresolve, b.dataset.label, `/equipment-findings/${b.dataset.eresolve}/resolve`) && !stale(nav)) render(app, id);
  }));
}
