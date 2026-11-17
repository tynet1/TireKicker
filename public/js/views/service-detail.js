// One maintenance entry: the work, repairs it fixed, photos, and its edit history. Shop/admin can edit or void it.
import { api } from "../api.js";
import { can, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, esc, fmtDate, fmtMoney, fmtNum, lightbox, modal, toast } from "../util.js";
import { SECTION_TITLES } from "./common.js";

const LABELS = {
  service_date: "Date", mileage: "Mileage", work: "Type of work", category: "Type", description: "Work done", parts: "Parts", cost: "Cost",
  performed_by: "Done by", vendor: "Outside shop", notes: "Notes", next_due_mileage: "Next due mileage", next_due_date: "Next due date",
};

function show(field, v) {
  if (v == null || v === "") return "(blank)";
  if (field === "cost") return fmtMoney(v);
  if (field === "mileage" || field === "next_due_mileage") return `${fmtNum(v)} mi`;
  if (field === "service_date" || field === "next_due_date") return fmtDate(v);
  return String(v);
}

export async function render(app, id) {
  const nav = state.nav;
  setHeader({ title: "Maintenance", back: "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let e;
  try {
    e = await api(`/service-logs/${id}`);
  } catch (err) {
    if (!stale(nav)) app.innerHTML = errorHtml(err);
    return;
  }
  if (stale(nav)) return;
  const v = e.vehicle;
  const editable = can.logService() && !e.voided;
  setHeader({
    title: `${v.truck_code} · ${fmtDate(e.service_date)}`, sub: e.category_label, back: `#/truck/${v.id}`,
    actions: editable ? [{ label: "Edit", href: `#/service/edit/${e.id}` }] : [],
  });

  let h = "";
  if (e.voided) {
    h += `<div class="banner err"><b>Voided</b> ${fmtDate(e.voided.at)}${e.voided.by ? ` by ${esc(e.voided.by)}` : ""}: ${esc(e.voided.reason)}
      <div class="small" style="margin-top:4px">Kept for the record, but it no longer counts for next-due dates or mileage.</div></div>`;
  }
  h += `<div class="card" style="margin-top:14px"><dl class="kv">
      <dt>Type</dt><dd><span class="row">${e.work.map((w) => `<span class="pill">${esc(w.label)}</span>`).join("")}</span></dd>
      <dt>Date</dt><dd>${fmtDate(e.service_date)}</dd>
      <dt>Mileage</dt><dd>${e.mileage != null ? `${fmtNum(e.mileage)} mi` : "—"}</dd>
      <dt>Work done</dt><dd style="white-space:pre-wrap">${esc(e.description)}</dd>
      ${e.parts ? `<dt>Parts</dt><dd style="white-space:pre-wrap">${esc(e.parts)}</dd>` : ""}
      ${e.cost != null ? `<dt>Cost</dt><dd>${fmtMoney(e.cost)}</dd>` : ""}
      ${e.performed_by ? `<dt>Done by</dt><dd>${esc(e.performed_by)}</dd>` : ""}
      ${e.vendor ? `<dt>Outside shop</dt><dd>${esc(e.vendor)}</dd>` : ""}
      ${e.work.some((w) => w.next_due_mileage != null || w.next_due_date) ? `<dt>Next due</dt><dd>${e.work
        .filter((w) => w.next_due_mileage != null || w.next_due_date)
        .map((w) => `<div>${esc(w.label)}: ${[w.next_due_mileage != null ? `${fmtNum(w.next_due_mileage)} mi` : "",
          w.next_due_date ? fmtDate(w.next_due_date) : ""].filter(Boolean).join(" or ")}</div>`).join("")}</dd>` : ""}
      ${e.notes ? `<dt>Notes</dt><dd style="white-space:pre-wrap">${esc(e.notes)}</dd>` : ""}
    </dl></div>`;

  if (e.repairs.length) {
    h += `<h2>Repairs fixed (${e.repairs.filter((r) => r.active).length})</h2><div class="card"><ul class="repairlist">${e.repairs.map((r) => `<li>
        <b>${esc(r.label)}</b> <span class="small muted">(${esc(SECTION_TITLES[r.section] || r.section)})</span>
        ${r.active ? "" : `<span class="pill grey">Reopened when voided</span>`}
        ${r.note ? `<div>${esc(r.note)}</div>` : ""}
        <a class="small" href="#/inspection/${esc(r.inspection_id)}">From ${fmtDate(r.inspection_date)} inspection</a></li>`).join("")}</ul></div>`;
  }

  const fixes = e.damage_fixes || [];
  if (fixes.length) {
    h += `<h2>Damage fixed (${fixes.filter((f) => f.active).length})</h2><div class="card"><ul class="repairlist">${fixes.map((f) => `<li>
        <b>${esc(f.note || "(no description)")}</b>${f.diagram === "trailer" ? ` <span class="small muted">(trailer)</span>` : ""}
        ${f.active ? "" : `<span class="pill grey">Back on file</span>`}
        ${f.photos.length ? `<div class="row" style="margin-top:4px">${f.photos.map((p) =>
          `<img class="dmgthumb" src="/api/photos/${esc(p.id)}" data-photo="${esc(p.id)}" data-cap="${esc(["Fixed: " + (f.note || "damage"), p.caption].filter(Boolean).join(" — "))}" alt="Photo of the fix">`).join("")}</div>` : ""}
        <a class="small" href="#/inspection/${esc(f.inspection_id)}">Marked on the ${fmtDate(f.inspection_date)} inspection</a></li>`).join("")}</ul></div>`;
  }

  if (e.photos.length) {
    h += `<h2>Photos (${e.photos.length})</h2><div class="card"><div class="photos">${e.photos.map((p) => `<button type="button" class="ph" data-photo="${esc(p.id)}" data-cap="${esc(p.caption || "")}" style="border:0;padding:0">
        <img alt="${esc(p.caption || "Photo")}" src="/api/photos/${esc(p.id)}">${p.caption ? `<span class="tag">${esc(p.caption)}</span>` : ""}</button>`).join("")}</div></div>`;
  }

  h += `<h2>Record</h2><div class="card"><div class="small muted">Logged ${fmtDate(e.created_at)}${e.created_by_name ? ` by ${esc(e.created_by_name)}` : ""}${
    e.history.length ? ` · changed ${e.history.length} time${e.history.length > 1 ? "s" : ""}` : ""}</div>
    ${e.history.length ? `<details style="margin-top:8px"><summary class="link" style="display:inline-block">Show changes</summary><ul class="repairlist">${
      e.history.slice().reverse().map((c) => `<li><div class="small muted">${fmtDate(c.changed_at)}${c.changed_by_name ? ` · ${esc(c.changed_by_name)}` : ""}</div>${
        c.voided ? "<div>Voided</div>"
          : c.changes.length ? c.changes.map((x) => `<div><b>${esc(LABELS[x.field] || x.field)}:</b> ${esc(show(x.field, x.from))} → ${esc(show(x.field, x.to))}</div>`).join("")
            : "<div>Added photos or repairs</div>"}</li>`).join("")}</ul></details>` : ""}
    ${editable ? `<button class="link danger" id="voidBtn" style="display:block;margin-top:6px">Void this entry</button>` : ""}</div>`;

  app.innerHTML = h;
  app.querySelectorAll("[data-photo]").forEach((b) => (b.onclick = () => lightbox(`/api/photos/${b.dataset.photo}`, b.dataset.cap)));
  const vb = $("#voidBtn");
  if (vb) vb.onclick = () => voidEntry(e, () => render(app, id));
}

function voidEntry(e, onDone) {
  const fixed = e.repairs.filter((r) => r.active && r.resolved_here).length;
  const m = modal(`<h3>Void this entry?</h3>
    <p class="muted" style="margin-top:-6px">It stays on record, marked void, and no longer counts for next-due dates or mileage.
      ${fixed ? `The ${fixed} repair${fixed > 1 ? "s" : ""} it closed will be open again.` : ""}</p>
    <label class="f" for="vr">Why?</label>
    <textarea class="t" id="vr" placeholder="e.g. Logged on the wrong truck"></textarea>
    <div id="verr"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="secondary" data-c>Cancel</button><button class="primary btn-danger" data-y>Void entry</button></div>`);
  m.querySelector("#vr").focus();
  m.querySelector("[data-c]").onclick = () => m.remove();
  m.querySelector("[data-y]").onclick = async (ev) => {
    const reason = m.querySelector("#vr").value.trim();
    if (!reason) { m.querySelector("#verr").innerHTML = `<div class="banner err">Say why it's being voided.</div>`; return; }
    ev.target.disabled = true;
    try {
      await api(`/service-logs/${e.id}/void`, { method: "POST", body: { reason } });
      m.remove();
      toast("Entry voided");
      onDone();
    } catch (err) {
      ev.target.disabled = false;
      m.querySelector("#verr").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
    }
  };
}
