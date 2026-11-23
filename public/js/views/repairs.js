// Repairs board (supervisor, shop, admin): every open repair across the fleet, by truck or oldest first.
// Each repair has the same buttons as on the truck page: Log fix (shop/admin) and Resolve (supervisor/admin).
import { api } from "../api.js";
import { atLeast, can, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, $$, esc, fmtDate, lightbox, vehicleInfo } from "../util.js";
import { repairButtons, resolveRepair, SECTION_TITLES } from "./common.js";
import { makeTicket, openTicket, ticketPills } from "./tickets.js";
import { findingItem, wireFindings } from "./yard.js";
import { problemItem, wireProblems } from "./equipment.js";
import { markRepaired } from "./truck.js";

let view = { truck: "", order: "truck" };
let list = [];
let findings = [];
let equipProblems = [];
let incDmg = [];
let nav = 0;

export async function render(app, truckId) {
  nav = state.nav;
  view = { truck: truckId ? String(truckId) : "", order: view.order };
  setHeader({ title: "Repairs board", back: truckId ? `#/truck/${truckId}` : "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    [list, findings, equipProblems, incDmg] = await Promise.all([
      api("/repairs"), api("/yard-findings").catch(() => []), api("/equipment-findings").catch(() => []),
      api("/incident-repairs").catch(() => []),
    ]);
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

/** A truck's open incident damage, as the ticket picker wants it. */
const incDamageOf = (vehicleId) => incDmg.filter((m) => m.vehicle_id === vehicleId)
  .map((m) => ({ id: m.id, diagram: m.diagram, seq: m.seq, note: m.note, date: m.incident_date, ticket_ids: m.ticket_ids }));

/** Damage pinned on an incident report, open until it's marked repaired (018). */
function incidentItem(m) {
  const b = [];
  if (can.logService()) b.push(`<a class="secondary" href="#/service/new/${m.vehicle_id}?fixdmg=${m.id}">Log fix</a>`);
  if (atLeast("supervisor")) b.push(`<button class="secondary" data-incfix="${m.id}">Mark repaired</button>`);
  b.push(`<button class="secondary" data-incticket="${m.id}">Ticket</button>`);
  const name = m.diagram === "trailer" ? "Trailer damage" : "Damage";
  return `<li><div class="spread" style="align-items:flex-start"><div class="grow">
      <a href="#/truck/${m.vehicle_id}"><b>${esc(m.truck_code)}</b></a> · <b>${esc(name)}${m.note ? `: ${esc(m.note)}` : ""}</b> ${age(m.days_open)}${ticketPills(m)}
      <div class="small muted">${m.incident_id ? `<a href="#/incident/${esc(m.incident_id)}">From the ${fmtDate(m.incident_date)} incident</a>${
        m.reporter_name ? ` · ${esc(m.reporter_name)}` : ""}` : `From an incident on ${fmtDate(m.incident_date)}`}</div>
      ${m.photo_ids?.length ? `<div class="row" style="margin-top:4px">${m.photo_ids.map((id) =>
        `<img class="dmgthumb" src="/api/photos/${esc(id)}" data-lb="${esc(id)}" data-cap="${esc(`${m.truck_code} · ${name}${m.note ? `: ${m.note}` : ""}`)}" alt="Photo of the damage">`).join("")}</div>` : ""}
    </div>${b.length ? `<div class="btncol">${b.join("")}</div>` : ""}</div></li>`;
}

function draw(app) {
  const trucks = [...new Map([...list, ...incDmg].map((r) => [String(r.vehicle_id), r])).values()]
    .sort((a, b) => a.truck_code.localeCompare(b.truck_code));
  if (view.truck && !trucks.some((t) => String(t.vehicle_id) === view.truck)) view.truck = ""; // that truck has none open now
  const shown = view.truck ? list.filter((r) => String(r.vehicle_id) === view.truck) : list;
  const incShown = view.truck ? incDmg.filter((m) => String(m.vehicle_id) === view.truck) : incDmg;
  const oldest = [...shown, ...incShown].reduce((m, r) => Math.max(m, r.days_open), 0);
  const total = shown.length + incShown.length;

  let h = `<div class="card" style="margin-top:14px">
      <div class="small muted" style="margin-bottom:10px"><b style="color:var(--ink)">${plural(total, "open repair")}</b>${
        view.truck ? "" : ` on ${plural(trucks.length, "truck")}`}${total ? ` · oldest ${plural(oldest, "day")}` : ""}</div>
      <label class="f" for="rb-truck">Truck</label>
      <select class="t" id="rb-truck"><option value="">All trucks (${list.length + incDmg.length})</option>${trucks.map((t) =>
        `<option value="${t.vehicle_id}"${String(t.vehicle_id) === view.truck ? " selected" : ""}>${esc(t.truck_code)} (${
          [...list, ...incDmg].filter((r) => r.vehicle_id === t.vehicle_id).length})</option>`).join("")}</select>
      <div class="chips" id="rb-order" style="margin-top:12px">
        <button type="button" data-order="truck" class="${view.order === "truck" ? "on" : ""}">By truck</button>
        <button type="button" data-order="oldest" class="${view.order === "oldest" ? "on" : ""}">Oldest first</button>
      </div>
      <a class="link" style="display:inline-flex;align-items:center;min-height:44px;margin-top:4px" href="#/csv?what=repairs${
        view.truck ? `&truck=${view.truck}` : ""}">Download CSV</a></div>`;

  if (findings.length && !view.truck) {
    h += `<div class="h2row"><h2>Yard findings · ${findings.length}</h2><a class="link" href="#/yard">Yard walks</a></div>
      <div class="card"><ul class="repairlist">${findings.map((f) => findingItem(f, { showYard: true })).join("")}</ul></div>`;
  }
  if (equipProblems.length && !view.truck) {
    h += `<div class="h2row"><h2>Equipment problems · ${equipProblems.length}</h2><a class="link" href="#/equipment">Equipment</a></div>
      <div class="card"><ul class="repairlist">${equipProblems.map((f) => problemItem(f)).join("")}</ul></div>`;
  }
  if (incShown.length) {
    h += `<div class="h2row"><h2>Incident damage · ${incShown.length}</h2>${atLeast("supervisor") ? `<a class="link" href="#/incidents">Incident reports</a>` : ""}</div>
      <div class="card"><ul class="repairlist">${incShown.map(incidentItem).join("")}</ul></div>`;
  }
  if (!shown.length && !incShown.length) {
    h += `<div class="card empty">No open repairs${view.truck ? " on this truck" : ""}. ✓</div>`;
  } else if (!shown.length) {
    // Only incident damage open; shown above.
  } else if (view.order === "oldest") {
    const sorted = [...shown].sort((a, b) => b.days_open - a.days_open || a.truck_code.localeCompare(b.truck_code));
    h += `<div class="card"><ul class="repairlist">${sorted.map((r) => item(r, true)).join("")}</ul></div>`;
  } else {
    for (const t of trucks.filter((x) => !view.truck || String(x.vehicle_id) === view.truck)) {
      const rs = shown.filter((r) => r.vehicle_id === t.vehicle_id);
      if (!rs.length) continue; // only incident damage, listed above
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
  wireProblems(app, async () => {
    equipProblems = await api("/equipment-findings").catch(() => equipProblems);
    if (!stale(nav)) draw(app);
  });
  wireFindings(app, async () => {
    findings = await api("/yard-findings").catch(() => findings);
    if (!stale(nav)) draw(app);
  });
  app.querySelectorAll("[data-ticket-truck]").forEach((b) => (b.onclick = async () => {
    const rs = list.filter((r) => String(r.vehicle_id) === b.dataset.ticketTruck);
    const truck = { id: Number(b.dataset.ticketTruck), truck_code: rs[0]?.truck_code };
    const tid = await makeTicket(truck, rs, { damage: incDamageOf(truck.id) });
    if (!tid || stale(nav)) return;
    try { list = await api("/repairs"); } catch { /* keep the old list */ }
    if (!stale(nav)) draw(app);
    openTicket(tid);
  }));
  // Ticket from one piece of incident damage: just that piece ticked; the truck's other repairs listed, unticked.
  app.querySelectorAll("[data-incticket]").forEach((b) => (b.onclick = async () => {
    const m = incDmg.find((x) => String(x.id) === b.dataset.incticket);
    if (!m) return;
    const truck = { id: m.vehicle_id, truck_code: m.truck_code };
    const tid = await makeTicket(truck, list.filter((r) => r.vehicle_id === m.vehicle_id), { picked: [], damage: incDamageOf(m.vehicle_id), pickedDamage: [m.id] });
    if (!tid || stale(nav)) return;
    incDmg = await api("/incident-repairs").catch(() => incDmg);
    if (!stale(nav)) draw(app);
    openTicket(tid);
  }));
  app.querySelectorAll("[data-incfix]").forEach((b) => (b.onclick = async () => {
    const m = incDmg.find((x) => String(x.id) === b.dataset.incfix);
    if (!m || !(await markRepaired({ id: m.id, note: m.note, inspection_date: m.incident_date })) || stale(nav)) return;
    incDmg = await api("/incident-repairs").catch(() => incDmg.filter((x) => x !== m));
    if (!stale(nav)) draw(app);
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
