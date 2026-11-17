// Repairs board (supervisor, shop, admin): every open repair across the fleet, by truck or oldest first.
// Each repair has the same buttons as on the truck page: Log fix (shop/admin) and Resolve (supervisor/admin).
import { api } from "../api.js";
import { atLeast, can, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, $$, esc, fmtDate, lightbox, vehicleInfo } from "../util.js";
import { repairButtons, resolveRepair, SECTION_TITLES } from "./common.js";
import { makeTicket, openTicket, ticketPills } from "./tickets.js";

let view = { truck: "", order: "truck" };
let list = [];
let nav = 0;

export async function render(app, truckId) {
  nav = state.nav;
  view = { truck: truckId ? String(truckId) : "", order: view.order };
  setHeader({ title: "Repairs board", back: truckId ? `#/truck/${truckId}` : "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    list = await api("/repairs");
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  draw(app);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const age = (d) => {
  const cls = d >= 30 ? "bad" : d >= 14 ? "warn" : "grey";
  return `<span class="pill ${cls}">${d <= 0 ? "Today" : `${plural(d, "day")} open`}</span>`;
};

function item(r, showTruck) {
  const who = { canLog: can.logService(), canResolve: atLeast("supervisor") };
  return `<li><div class="spread" style="align-items:flex-start"><div class="grow">
      ${showTruck ? `<a href="#/truck/${r.vehicle_id}"><b>${esc(r.truck_code)}</b></a> · ` : ""}<b>${esc(r.label)}</b>
      <span class="small muted">(${esc(SECTION_TITLES[r.section] || r.section)})</span> ${age(r.days_open)}${ticketPills(r)}
      ${r.note ? `<div>${esc(r.note)}</div>` : ""}
      <div class="small muted">${r.inspector_name ? `${esc(r.inspector_name)} · ` : ""}<a href="#/inspection/${esc(r.inspection_id)}">From ${
        fmtDate(r.inspection_date)} inspection</a></div>
      ${r.photo_ids?.length ? `<div class="row" style="margin-top:4px">${r.photo_ids.map((id) =>
        `<img class="dmgthumb" src="/api/photos/${esc(id)}" data-lb="${esc(id)}" data-cap="${esc(`${r.truck_code} · ${r.label}${r.note ? `: ${r.note}` : ""}`)}" alt="Photo of the repair">`).join("")}</div>` : ""}
    </div>${repairButtons(r, r.vehicle_id, who)}</div></li>`;
}

function draw(app) {
  const trucks = [...new Map(list.map((r) => [String(r.vehicle_id), r])).values()];
  if (view.truck && !trucks.some((t) => String(t.vehicle_id) === view.truck)) view.truck = ""; // that truck has none open now
  const shown = view.truck ? list.filter((r) => String(r.vehicle_id) === view.truck) : list;
  const oldest = shown.reduce((m, r) => Math.max(m, r.days_open), 0);

  let h = `<div class="card" style="margin-top:14px">
      <div class="small muted" style="margin-bottom:10px"><b style="color:var(--ink)">${plural(shown.length, "open repair")}</b>${
        view.truck ? "" : ` on ${plural(trucks.length, "truck")}`}${shown.length ? ` · oldest ${plural(oldest, "day")}` : ""}</div>
      <label class="f" for="rb-truck">Truck</label>
      <select class="t" id="rb-truck"><option value="">All trucks (${list.length})</option>${trucks.map((t) =>
        `<option value="${t.vehicle_id}"${String(t.vehicle_id) === view.truck ? " selected" : ""}>${esc(t.truck_code)} (${
          list.filter((r) => r.vehicle_id === t.vehicle_id).length})</option>`).join("")}</select>
      <div class="chips" id="rb-order" style="margin-top:12px">
        <button type="button" data-order="truck" class="${view.order === "truck" ? "on" : ""}">By truck</button>
        <button type="button" data-order="oldest" class="${view.order === "oldest" ? "on" : ""}">Oldest first</button>
      </div>
      <a class="link" style="display:inline-flex;align-items:center;min-height:44px;margin-top:4px" href="#/csv?what=repairs${
        view.truck ? `&truck=${view.truck}` : ""}">Download CSV</a></div>`;

  if (!shown.length) {
    h += `<div class="card empty">No open repairs${view.truck ? " on this truck" : ""}. ✓</div>`;
  } else if (view.order === "oldest") {
    const sorted = [...shown].sort((a, b) => b.days_open - a.days_open || a.truck_code.localeCompare(b.truck_code));
    h += `<div class="card"><ul class="repairlist">${sorted.map((r) => item(r, true)).join("")}</ul></div>`;
  } else {
    for (const t of trucks.filter((x) => !view.truck || String(x.vehicle_id) === view.truck)) {
      const rs = shown.filter((r) => r.vehicle_id === t.vehicle_id);
      h += `<div class="h2row"><h2><a href="#/truck/${t.vehicle_id}" style="color:inherit;display:inline-flex;align-items:center;min-height:44px;min-width:48px">${
        esc(t.truck_code)}</a> · ${rs.length}</h2>
          <span class="row" style="flex-wrap:nowrap"><span class="small muted">${esc(vehicleInfo(t))}</span>
          <button class="link" data-ticket-truck="${t.vehicle_id}">Ticket</button></span></div>
        <div class="card"><ul class="repairlist">${rs.map((r) => item(r, false)).join("")}</ul></div>`;
    }
  }
  app.innerHTML = h;

  $("#rb-truck").onchange = (e) => { view.truck = e.target.value; draw(app); };
  $$("#rb-order [data-order]").forEach((b) => (b.onclick = () => { view.order = b.dataset.order; draw(app); }));
  app.querySelectorAll("[data-lb]").forEach((img) => (img.onclick = () => lightbox(img.src, img.dataset.cap)));
  app.querySelectorAll("[data-ticket-truck]").forEach((b) => (b.onclick = async () => {
    const rs = list.filter((r) => String(r.vehicle_id) === b.dataset.ticketTruck);
    const truck = { id: Number(b.dataset.ticketTruck), truck_code: rs[0]?.truck_code };
    const tid = await makeTicket(truck, rs);
    if (!tid || stale(nav)) return;
    try { list = await api("/repairs"); } catch { /* keep the old list */ }
    if (!stale(nav)) draw(app);
    openTicket(tid);
  }));
  app.querySelectorAll("[data-resolve]").forEach((b) => (b.onclick = async () => {
    if (!(await resolveRepair(b.dataset.resolve, b.dataset.label)) || stale(nav)) return;
    try {
      list = await api("/repairs");
    } catch {
      list = list.filter((r) => String(r.id) !== b.dataset.resolve);
    }
    if (!stale(nav)) draw(app);
  }));
}
