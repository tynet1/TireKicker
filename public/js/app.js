// Boot, routing and the "saved on phone" status bar.
import { api, onSignedOut } from "./api.js";
import { allDrafts, flush, onDraftsChange, onSent } from "./drafts.js";
import { loadBranding } from "./brand.js";
import { allSvcDrafts, flushSvc, onSvcChange, onSvcSent } from "./svc.js";
import { atLeast, can, homeHeader, state } from "./ui.js";
import { $, esc, modal, toast } from "./util.js";
import * as admin from "./views/admin.js";
import * as detail from "./views/detail.js";
import * as csvView from "./views/csv.js";
import * as exportView from "./views/export.js";
import * as form from "./views/form.js";
import * as repairsBoard from "./views/repairs.js";
import * as home from "./views/home.js";
import * as serviceDetail from "./views/service-detail.js";
import * as serviceForm from "./views/service-form.js";
import * as signin from "./views/signin.js";
import * as truck from "./views/truck.js";

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
  { re: /^#\/admin(?:\/(users|trucks|checklist|branding|deleted))?(?:\?edit=(\d+))?$/, view: admin, role: "admin" },
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
  route();
}

/** Inspections and maintenance entries saved on this phone but not yet uploaded. */
async function queuedCounts() {
  const [a, b] = await Promise.all([allDrafts().catch(() => []), allSvcDrafts().catch(() => [])]);
  return { inspections: a.filter((d) => d.status === "queued").length, service: b.filter((d) => d.status === "queued").length };
}

export async function signOut() {
  const q = await queuedCounts();
  if (q.inspections || q.service) {
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
      ${can.seeService() ? `<a class="secondary" href="#/repairs" data-close>Repairs board</a>` : ""}
      ${atLeast("supervisor") ? `<a class="secondary" href="#/export" data-close>Export PDFs</a>` : ""}
      ${can.seeService() ? `<a class="secondary" href="#/csv" data-close>Download CSV (spreadsheet)</a>` : ""}
      ${atLeast("admin") ? `<a class="secondary" href="#/admin/users" data-close>Admin: users, trucks, checklist, branding &amp; deleted</a>` : ""}
      <button class="secondary danger" id="mSignOut">Sign out</button>
      <button class="secondary" data-close>Close</button>
    </div>`);
  m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => m.remove()));
  m.querySelector("#mSignOut").onclick = () => { m.remove(); signOut(); };
}

async function updateNetbar() {
  const bar = $("#netbar");
  const q = await queuedCounts();
  if ((q.inspections || q.service) && state.user) {
    const parts = [];
    if (q.inspections) parts.push(q.inspections === 1 ? "1 inspection" : `${q.inspections} inspections`);
    if (q.service) parts.push(q.service === 1 ? "1 maintenance entry" : `${q.service} maintenance entries`);
    bar.innerHTML = `<div class="in"><span>${parts.join(" and ")} saved on phone, not yet uploaded</span><button id="retryNow">Retry now</button></div>`;
    bar.hidden = false;
    $("#retryNow").onclick = async () => {
      $("#retryNow").innerHTML = `<span class="spinner"></span>`;
      await Promise.all([flush(), flushSvc()]);
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
  window.addEventListener("online", updateNetbar);
  window.addEventListener("offline", updateNetbar);
  window.addEventListener("hashchange", route);

  await route();
  updateNetbar();
  if (state.user) { flush(); flushSvc(); }
}

boot();
