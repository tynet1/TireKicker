// Incident reports (supervisors and admins): every report, newest first, with the ones this user hasn't opened yet
// marked "New". Also the bits the home screen and truck page show.
import { api } from "../api.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { $, esc, fmtDate } from "../util.js";

/** One report in a list. */
export function incidentRow(n, { showTruck = true } = {}) {
  const where = n.location_name || n.city || "";
  return `<a class="item" href="#/incident/${esc(n.id)}"><span class="grow">
      <b>${showTruck ? `${esc(n.truck_code)} · ` : ""}${fmtDate(n.incident_date)}</b>${where ? ` <span class="muted">· ${esc(where)}</span>` : ""}
      <span class="small muted clip" style="display:block">Driver ${esc(n.driver_name)} · filed by ${esc(n.reporter_name)}</span></span>
    <span class="row" style="justify-content:flex-end;flex-wrap:nowrap">
      ${n.unread ? `<span class="pill bad">New</span>` : ""}
      ${n.employee_injured ? `<span class="pill bad">Injury</span>` : ""}
      ${n.open_damage ? `<span class="pill warn">${n.open_damage} to repair</span>` : n.damage_count ? `<span class="pill okk">Repaired</span>` : ""}
      ${n.state === "archived" ? `<span class="pill grey">Archived</span>` : ""}</span></a>`;
}

/** Home screen: new reports this user hasn't opened, so supervisors hear about them right away. */
export function unreadBanner(list) {
  if (!list?.length) return "";
  return `<div class="banner err" style="margin-top:12px"><b>New incident report${list.length > 1 ? "s" : ""}</b>
    <div class="card list" style="margin:8px 0 0">${list.map((n) => incidentRow(n)).join("")}</div></div>`;
}

let showArchived = false;

export async function render(app) {
  const nav = state.nav;
  setHeader({ title: "Incident reports", back: "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let list;
  try {
    list = await api(`/incidents?limit=300${showArchived ? "&archived=include" : ""}`);
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  app.innerHTML = `<p class="small muted" style="margin:14px 4px">To report a new one, open the truck and tap <b>Report incident</b>.</p>
    <div class="card list">${list.length ? list.map((n) => incidentRow(n)).join("") : `<div class="empty">No incident reports${showArchived ? "" : " (archived ones are hidden)"}.</div>`}</div>
    <button class="link" id="arch" style="width:100%">${showArchived ? "Hide archived" : "Show archived too"}</button>`;
  $("#arch").onclick = () => { showArchived = !showArchived; render(app); };
}
