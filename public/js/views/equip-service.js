// One equipment maintenance entry: the work, next due, problems it fixed, photos, and Void (shop, admin).
import { api } from "../api.js";
import { atLeast, can, errorHtml, setHeader, stale, state } from "../ui.js";
import { esc, fmtDate, fmtMoney, lightbox, modal, toast } from "../util.js";
import { askTrash, trashBanner, trashCard } from "./common.js";

export async function render(app, id) {
  const nav = state.nav;
  setHeader({ title: "Maintenance", back: "#/equipment" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let e;
  try {
    e = await api(`/equipment-service/${id}`);
  } catch (ex) {
    if (!stale(nav)) app.innerHTML = errorHtml(ex);
    return;
  }
  if (stale(nav)) return;
  setHeader({ title: e.tag, sub: `Maintenance · ${fmtDate(e.service_date)}`, back: `#/equipment/piece/${e.equipment_id}` });
  let h = trashBanner(e.trash);
  if (e.voided) h += `<div class="banner info" style="margin-top:14px"><b>Voided ${fmtDate(e.voided_at)}</b> by ${esc(e.voided_by_name)}: ${esc(e.void_reason)}</div>`;
  h += `<div class="card" style="margin-top:14px"><dl class="kv">
      <dt>Date</dt><dd>${fmtDate(e.service_date)}</dd>
      <dt>Work</dt><dd>${e.work.map((w) => `${esc(w.title)}${w.next_due_date ? ` <span class="small muted">(next due ${fmtDate(w.next_due_date)})</span>` : ""}`).join("<br>")}</dd>
      <dt>What was done</dt><dd style="white-space:pre-wrap">${esc(e.description)}</dd>
      ${e.parts ? `<dt>Parts</dt><dd>${esc(e.parts)}</dd>` : ""}
      ${e.cost != null ? `<dt>Cost</dt><dd>${fmtMoney(e.cost)}</dd>` : ""}
      ${e.performed_by ? `<dt>Done by</dt><dd>${esc(e.performed_by)}</dd>` : ""}
      ${e.vendor ? `<dt>Outside shop</dt><dd>${esc(e.vendor)}</dd>` : ""}
      ${e.notes ? `<dt>Notes</dt><dd style="white-space:pre-wrap">${esc(e.notes)}</dd>` : ""}
      <dt>Logged</dt><dd>${fmtDate(e.created_at)} by ${esc(e.created_by_name)}</dd></dl></div>`;
  if (e.fixed.length) {
    h += `<h2>Problems this fixed</h2><div class="card"><ul class="repairlist">${e.fixed.map((f) => `<li><b>${esc(f.label)}</b>
      ${f.note ? `<div>${esc(f.note)}</div>` : ""}<div class="small muted">Found ${fmtDate(f.check_date)}</div></li>`).join("")}</ul></div>`;
  }
  if (e.photos.length) {
    h += `<h2>Photos</h2><div class="card"><div class="row">${e.photos.map((p) =>
      `<img class="dmgthumb" src="/api/photos/${esc(p.id)}" data-lb="${esc(p.id)}" data-cap="${esc(p.caption || "")}" alt="Photo">`).join("")}</div></div>`;
  }
  if (!e.voided && !e.trash && can.logService()) h += `<button class="secondary danger wide" id="void" style="margin-top:14px">Void this entry</button>`;
  const trashNote = e.voided ? "" : "It's voided first, so problems it fixed open again. ";
  if (!e.trash && atLeast("admin")) h += trashCard("maintenance entry", trashNote);
  app.innerHTML = h;
  app.querySelector("[data-trash]")?.addEventListener("click", async () => {
    if (await askTrash("equipment_service", e.id, "maintenance entry", trashNote) && !stale(nav)) location.hash = `#/equipment/piece/${e.equipment_id}`;
  });
  app.querySelectorAll("[data-lb]").forEach((img) => (img.onclick = () => lightbox(img.src, img.dataset.cap)));
  const v = app.querySelector("#void");
  if (v) v.onclick = () => {
    const m = modal(`<h3>Void this entry?</h3>
      <p class="muted small" style="margin-top:-8px">It stays listed, marked voided${e.fixed.length ? ", and the problems it closed are open again" : ""}.</p>
      <label class="f" for="vr">Why?</label><textarea class="t" id="vr" maxlength="600" placeholder="e.g. Logged on the wrong piece"></textarea>
      <div id="verr"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="secondary" data-c>Cancel</button><button class="primary btn-danger" data-y>Void entry</button></div>`);
    m.querySelector("[data-c]").onclick = () => m.remove();
    m.querySelector("[data-y]").onclick = async (ev) => {
      const reason = m.querySelector("#vr").value.trim();
      if (!reason) return void (m.querySelector("#verr").innerHTML = `<div class="banner err">Add a short reason.</div>`);
      ev.target.disabled = true;
      try {
        await api(`/equipment-service/${e.id}/void`, { method: "POST", body: { reason } });
        m.remove();
        toast("Entry voided");
        if (!stale(nav)) render(app, id);
      } catch (ex) {
        ev.target.disabled = false;
        m.querySelector("#verr").innerHTML = `<div class="banner err">${esc(ex.status === 0 ? "No signal, so nothing changed." : ex.message)}</div>`;
      }
    };
  };
}
