// Boot, routing and the "saved on phone" status bar.
import { api, onSignedOut } from "./api.js";
import { allDrafts, flush, onDraftsChange, onSent } from "./drafts.js";
import { loadBranding } from "./brand.js";
import { allSvcDrafts, flushSvc, onSvcChange, onSvcSent } from "./svc.js";
import { allYardDrafts, flushYard, onYardChange, onYardSent } from "./yardq.js";
import { allEquipDrafts, flushEquip, onEquipChange, onEquipSent } from "./equipq.js";
import { allEsvcDrafts, flushEsvc, onEsvcChange, onEsvcSent } from "./esvcq.js";
import { allIncDrafts, flushInc, onIncChange, onIncSent } from "./incq.js";
import { atLeast, can, homeHeader, state } from "./ui.js";
import { $, esc, modal, toast } from "./util.js";
import * as admin from "./views/admin.js";
import * as detail from "./views/detail.js";
import * as equipDetail from "./views/equip-detail.js";
import * as equipForm from "./views/equip-form.js";
import * as equipService from "./views/equip-service.js";
import * as equipServiceForm from "./views/equip-service-form.js";
import * as equipment from "./views/equipment.js";
import * as csvView from "./views/csv.js";
import * as exportView from "./views/export.js";
import * as form from "./views/form.js";
import * as incident from "./views/incident.js";
import * as incidentForm from "./views/incident-form.js";
import * as incidents from "./views/incidents.js";
import * as repairsBoard from "./views/repairs.js";
import * as reminders from "./views/reminders.js";
import * as home from "./views/home.js";
import * as serviceDetail from "./views/service-detail.js";
import * as serviceForm from "./views/service-form.js";
import * as signin from "./views/signin.js";
import * as truck from "./views/truck.js";
import * as yard from "./views/yard.js";
import * as yardDetail from "./views/yard-detail.js";
import * as yardForm from "./views/yard-form.js";

const routes = [
  { re: /^#?\/?$/, view: home },
  { re: /^#\/truck\/(\d+)$/, view: truck },
  { re: /^#\/inspect\/(\d+)$/, view: form },
  { re: /^#\/inspection\/([0-9a-f-]{36})$/i, view: detail },
  { re: /^#\/service\/(new|edit)\/(\d+)(?:\?(fix|fixdmg|ticket)=(\d+))?$/, view: serviceForm, allow: () => can.logService() },
  { re: /^#\/service\/(\d+)$/, view: serviceDetail, allow: () => can.seeService() },
  { re: /^#\/export(?:\?truck=(\d+))?$/, view: exportView, role: "supervisor" },
  { re: /^#\/csv(?:\?([\w=&-]*))?$/, view: csvView, allow: () => can.seeService() },
  { re: /^#\/repairs(?:\?truck=(\d+))?$/, view: repairsBoard, allow: () => can.seeService() },
  { re: /^#\/reminders$/, view: reminders, allow: () => can.seeService() },
  { re: /^#\/yard(?:\/(\d+))?$/, view: yard, allow: () => can.seeService() },
  { re: /^#\/yard\/(\d+)\/walk$/, view: yardForm, role: "supervisor" },
  { re: /^#\/yard-walk\/([0-9a-f-]{36})$/i, view: yardDetail, allow: () => can.seeService() },
  { re: /^#\/equipment(?:\/piece\/(\d+))?$/, view: equipment, allow: () => can.seeService() },
  { re: /^#\/equipment\/check\/(\d+|none)$/, view: equipForm, allow: () => can.seeService() },
  { re: /^#\/equipment-check\/([0-9a-f-]{36})$/i, view: equipDetail, allow: () => can.seeService() },
  { re: /^#\/equipment\/service\/new\/(\d+)(?:\?fix=(\d+))?$/, view: equipServiceForm, allow: () => can.logService() },
  { re: /^#\/equipment-service\/(\d+)$/, view: equipService, allow: () => can.seeService() },
  { re: /^#\/incidents$/, view: incidents, role: "supervisor" },
  { re: /^#\/incident\/new\/(\d+)$/, view: incidentForm, role: "supervisor" },
  { re: /^#\/incident\/([0-9a-f-]{36})$/i, view: incident, role: "supervisor" },
  { re: /^#\/admin(?:\/(users|trucks|equipment|checklist|branding|trash|deleted))?(?:\?edit=(\d+))?$/, view: admin, role: "admin" },
];

let current = null;

async function route() {
  const nav = ++state.nav;
  if (current?.leave) {
    try { await current.leave(); } catch (e) { console.error(e); }
  }
  current = null;
  document.body.classList.remove("has-bar");
  window.scrollTo(0, 0);
  const app = $("#app");
  if (!state.user) {
    current = signin;
    return signin.render(app, { onSignedIn });
  }
  const hash = location.hash || "#/";
  for (const r of routes) {
    const m = hash.match(r.re);
    if (!m) continue;
    if ((r.role && !atLeast(r.role)) || (r.allow && !r.allow())) break;
    current = r.view;
    try {
      await r.view.render(app, ...m.slice(1));
    } catch (e) {
      console.error(e);
      if (nav === state.nav) app.innerHTML = `<div class="banner err">${esc(e.message || e)}</div>`;
    }
    return;
  }
  location.replace("#/");
}

function onSignedIn(user) {
  state.user = user;
  try { localStorage.setItem("gc-user", JSON.stringify(user)); } catch { /* private mode */ }
  flush();
  flushSvc();
  flushYard();
  flushEquip();
  flushEsvc();
  flushInc();
  route();
}

/** Inspections, maintenance entries, yard walks, checks and incident reports saved on this phone but not yet uploaded. */
async function queuedCounts() {
  const [a, b, c, e, f, g] = await Promise.all([allDrafts().catch(() => []), allSvcDrafts().catch(() => []), allYardDrafts().catch(() => []),
    allEquipDrafts().catch(() => []), allEsvcDrafts().catch(() => []), allIncDrafts().catch(() => [])]);
  const queued = (list) => list.filter((d) => d.status === "queued").length;
  return { inspections: queued(a), service: queued(b) + queued(f), yard: queued(c), equipment: queued(e), incidents: queued(g) };
}

export async function signOut() {
  const q = await queuedCounts();
  if (q.inspections || q.service || q.yard || q.equipment || q.incidents) {
    toast("Wait until your saved work finishes uploading before signing out.", 4000);
    return;
  }
  try { await api("/auth/logout", { method: "POST" }); } catch { /* offline: still clear locally */ }
  try { await caches.delete("gc-runtime"); } catch { /* no cache API */ }
  try { localStorage.removeItem("gc-user"); } catch { /* ignore */ }
  state.user = null;
  location.hash = "#/";
  route();
}

export function openMenu() {
  const u = state.user;
  const m = modal(`<h3>${esc(u.name)}</h3><p class="muted small" style="margin-top:-8px">Signed in as ${esc(u.role)}</p>
    <div style="display:grid;gap:10px">
      ${can.seeService() ? `<a class="secondary" href="#/reminders" data-close>Reminders</a>` : ""}
      ${can.seeService() ? `<a class="secondary" href="#/repairs" data-close>Repairs board</a>` : ""}
      ${atLeast("supervisor") ? `<a class="secondary" href="#/incidents" data-close>Incident reports</a>` : ""}
      ${can.seeService() ? `<a class="secondary" href="#/yard" data-close>Yard walks</a>` : ""}
      ${can.seeService() ? `<a class="secondary" href="#/equipment" data-close>Equipment checks</a>` : ""}
      ${atLeast("supervisor") ? `<a class="secondary" href="#/export" data-close>Export PDFs</a>` : ""}
      ${can.seeService() ? `<a class="secondary" href="#/csv" data-close>Download CSV (spreadsheet)</a>` : ""}
      ${atLeast("admin") ? `<a class="secondary" href="#/admin/users" data-close>Admin: users, trucks, equipment, checklists, branding &amp; trash</a>` : ""}
      <div><label class="f">Appearance</label><div class="seg" id="mTheme">
        ${[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(([k, label]) =>
          `<button type="button" data-theme-pick="${k}">${label}</button>`).join("")}</div>
        <div class="small muted" style="margin-top:4px">Auto follows the phone's light or dark setting.</div></div>
      <button class="secondary danger" id="mSignOut">Sign out</button>
      <button class="secondary" data-close>Close</button>
    </div>`);
  m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => m.remove()));
  const marks = () => m.querySelectorAll("[data-theme-pick]").forEach((b) =>
    b.classList.toggle("on", b.dataset.themePick === (window.gcTheme?.get() || "auto")));
  marks();
  m.querySelectorAll("[data-theme-pick]").forEach((b) => (b.onclick = () => { window.gcTheme?.set(b.dataset.themePick); marks(); }));
  m.querySelector("#mSignOut").onclick = () => { m.remove(); signOut(); };
}

async function updateNetbar() {
  const bar = $("#netbar");
  const q = await queuedCounts();
  if ((q.inspections || q.service || q.yard || q.equipment || q.incidents) && state.user) {
    const parts = [];
    if (q.inspections) parts.push(q.inspections === 1 ? "1 inspection" : `${q.inspections} inspections`);
    if (q.service) parts.push(q.service === 1 ? "1 maintenance entry" : `${q.service} maintenance entries`);
    if (q.yard) parts.push(q.yard === 1 ? "1 yard walk" : `${q.yard} yard walks`);
    if (q.equipment) parts.push(q.equipment === 1 ? "1 equipment check" : `${q.equipment} equipment checks`);
    if (q.incidents) parts.push(q.incidents === 1 ? "1 incident report" : `${q.incidents} incident reports`);
    bar.innerHTML = `<div class="in"><span>${parts.join(" and ")} saved on phone, not yet uploaded</span><button id="retryNow">Retry now</button></div>`;
    bar.hidden = false;
    $("#retryNow").onclick = async () => {
      $("#retryNow").innerHTML = `<span class="spinner"></span>`;
      await Promise.all([flush(), flushSvc(), flushYard(), flushEquip(), flushEsvc(), flushInc()]);
      updateNetbar();
    };
  } else if (!navigator.onLine) {
    bar.innerHTML = `<div class="in"><span>No signal. Your work is saved on this phone.</span></div>`;
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }
}

async function boot() {
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker", e));
  }
  const branding = loadBranding();
  homeHeader();
  try {
    [state.user] = await Promise.all([api("/me"), branding]);
    localStorage.setItem("gc-user", JSON.stringify(state.user));
  } catch (e) {
    await branding;
    if (e.status === 401) {
      state.user = null;
      try { localStorage.removeItem("gc-user"); } catch { /* ignore */ }
    } else {
      // No signal: trust the last known sign-in so drafts can still be worked on.
      try { state.user = JSON.parse(localStorage.getItem("gc-user") || "null"); } catch { state.user = null; }
    }
  }

  onSignedOut(() => {
    if (!state.user) return;
    state.user = null;
    try { localStorage.removeItem("gc-user"); } catch { /* ignore */ }
    toast("Please sign in again.");
    route();
  });
  onDraftsChange(updateNetbar);
  onSvcChange(updateNetbar);
  onYardChange(updateNetbar);
  onEquipChange(updateNetbar);
  onEsvcChange(updateNetbar);
  onIncChange(updateNetbar);
  onSent((d, res) => {
    if (!res.duplicate) toast(`${d.truckCode} inspection uploaded ✓`);
    // Lists drawn before the upload finished are now out of date.
    if (current === home || current === truck) route();
  });
  onSvcSent((d, res) => {
    // Edits are sent while the form waits; only background uploads of new entries need a heads-up.
    if (d.entryId) return;
    if (!res.duplicate) toast(`${d.truckCode} maintenance uploaded ✓`);
    if (current === home || current === truck) route();
  });
  onYardSent((d, res) => {
    if (!res.duplicate) toast(`${d.yardName} walk uploaded ✓`);
    if (current === home || current === yard) route();
  });
  onEquipSent((d, res) => {
    if (!res.duplicate) toast(`${d.title} equipment check uploaded ✓`);
    if (current === home || current === equipment) route();
  });
  onEsvcSent((d, res) => {
    if (!res.duplicate) toast(`${d.tag} maintenance uploaded ✓`);
  });
  onIncSent((d, res) => {
    if (!res.duplicate) toast(`${d.truckCode} incident report uploaded ✓`);
    if (current === home || current === truck || current === incidents) route();
  });
  window.addEventListener("online", updateNetbar);
  window.addEventListener("offline", updateNetbar);
  window.addEventListener("hashchange", route);

  await route();
  updateNetbar();
  if (state.user) { flush(); flushSvc(); flushYard(); flushEquip(); flushEsvc(); flushInc(); }
}

boot();
