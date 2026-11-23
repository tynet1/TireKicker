// Reminders (supervisors, shop, admin): what needs doing now or soon across trucks, equipment and the yard.
import { api } from "../api.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { esc } from "../util.js";

const KIND = {
  registration: "Registration", inspection: "Inspection", service: "Truck maintenance", equipment: "Equipment check",
  equipment_service: "Equipment maintenance", yard: "Yard walk",
};

export async function render(app) {
  const nav = state.nav;
  setHeader({ title: "Reminders", back: "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let r;
  try {
    r = await api("/reminders");
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  const row = (i) => `<a class="item" href="${esc(i.link)}"><span class="grow">${esc(i.title)}
      <span class="small muted clip">${esc(KIND[i.kind] || i.kind)}${i.detail ? ` · ${esc(i.detail)}` : ""}</span></span>
    <span class="pill ${i.state === "due" ? "bad" : "warn"}">${i.state === "due" ? "Due" : "Soon"}</span></a>`;
  const due = r.items.filter((i) => i.state === "due");
  const soon = r.items.filter((i) => i.state === "soon");
  app.innerHTML = `<p class="small muted" style="margin:14px 4px 0">Registrations, inspections, maintenance and checks that are due now or within
      two weeks (registrations: 30 days). Each one opens the page where it's dealt with.</p>
    <h2>Due now (${due.length})</h2><div class="card list">${due.length ? due.map(row).join("") : `<div class="empty">Nothing due. ✓</div>`}</div>
    <h2>Coming up (${soon.length})</h2><div class="card list">${soon.length ? soon.map(row).join("") : `<div class="empty">Nothing coming up.</div>`}</div>`;
}
