// A yard's page (supervisors; the shop can look): start or resume today's walk, open findings, and past walks.
import { api } from "../api.js";
import { atLeast, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, confirmBox, esc, fmtDate, lightbox, today, toast } from "../util.js";
import { flushYard, getYardDraft, sendYard, yardKey } from "../yardq.js";
import { resolveRepair } from "./common.js";
import { discardYardDraft } from "./yard-form.js";

const YARD_SECTIONS = { fire: "Fire safety", fuel: "Fuel, oil & chemicals", equipment: "Equipment & charging", access: "Access & security" };

/** One open finding, with Resolve for supervisors. */
export function findingItem(f, { showYard = false } = {}) {
  const age = f.days_open >= 7 ? "bad" : f.days_open >= 2 ? "warn" : "grey";
  return `<li><div class="spread" style="align-items:flex-start"><div class="grow">
      ${showYard ? `<a href="#/yard/${f.yard_id}"><b>${esc(f.yard_name)}</b></a> · ` : ""}<b>${esc(f.label)}</b>
      <span class="small muted">(${esc(YARD_SECTIONS[f.section] || f.section)})</span>
      <span class="pill ${age}">${f.days_open <= 0 ? "Today" : `${f.days_open} day${f.days_open === 1 ? "" : "s"} open`}</span>
      ${f.note ? `<div>${esc(f.note)}</div>` : ""}
      <div class="small muted">${esc(f.inspector_name)} · <a href="#/yard-walk/${esc(f.yard_inspection_id)}">From ${fmtDate(f.inspection_date)} walk</a></div>
      ${f.photo_ids?.length ? `<div class="row" style="margin-top:4px">${f.photo_ids.map((id) =>
        `<img class="dmgthumb" src="/api/photos/${esc(id)}" data-lb="${esc(id)}" data-cap="${esc(`${f.label}${f.note ? `: ${f.note}` : ""}`)}" alt="Photo of the problem">`).join("")}</div>` : ""}
    </div>${atLeast("supervisor") ? `<div class="btncol"><button class="secondary" data-yresolve="${f.id}" data-label="${esc(f.label)}">Resolve</button></div>` : ""}</div></li>`;
}

/** "#/yard": straight to the yard while there's only one, else a list to pick from. */
async function pickYard(app, nav) {
  let yards;
  try { yards = await api("/yards"); } catch (e) { if (!stale(nav)) app.innerHTML = errorHtml(e); return; }
  if (stale(nav)) return;
  if (yards.length === 1) return void location.replace(`#/yard/${yards[0].id}`);
  setHeader({ title: "Yards", back: "#/" });
  app.innerHTML = `<div class="card list" style="margin-top:14px">${yards.length ? yards.map((y) => `<a class="item" href="#/yard/${y.id}">
      <span class="grow"><b>${esc(y.name)}</b></span>${yardPills(y)}</a>`).join("") : `<div class="empty">No yards yet.</div>`}</div>`;
}

/** Today's status and open findings for a yard, as pills. */
export function yardPills(y) {
  return `<span class="row" style="justify-content:flex-end;flex-wrap:nowrap">${y.walked_today ? `<span class="pill okk">Walked today</span>`
    : `<span class="pill warn">Not walked today</span>`}${y.open_findings ? `<span class="pill bad">${y.open_findings} open</span>` : ""}</span>`;
}

/** Wire Resolve buttons and photo thumbnails inside `root`; `after` runs when a finding was resolved. */
export function wireFindings(root, after) {
  root.querySelectorAll("[data-lb]").forEach((img) => (img.onclick = () => lightbox(img.src, img.dataset.cap)));
  root.querySelectorAll("[data-yresolve]").forEach((b) => (b.onclick = async () => {
    if (await resolveRepair(b.dataset.yresolve, b.dataset.label, `/yard-findings/${b.dataset.yresolve}/resolve`)) after();
  }));
}

export async function render(app, yardId) {
  const nav = state.nav;
  setHeader({ title: "Yard", back: "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  if (!yardId) return pickYard(app, nav);
  let yards, findings, walks, draft;
  try {
    [yards, findings, walks, draft] = await Promise.all([
      api("/yards"), api("/yard-findings"), api(`/yards/${yardId}/inspections`), getYardDraft(yardKey(yardId)),
    ]);
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  const yard = yards.find((y) => String(y.id) === String(yardId));
  if (!yard) { app.innerHTML = errorHtml(new Error("That yard isn't in use.")); return; }
  setHeader({ title: yard.name, sub: "Daily yard walk", back: "#/" });
  const open = findings.filter((f) => String(f.yard_id) === String(yard.id));
  const reload = () => { if (!stale(nav)) render(app, yardId); };

  let h = `<div class="card" style="margin-top:14px">
    ${yard.walked_today ? `<div class="banner okk" style="margin:0 0 10px">Today's walk is done ✓</div>`
      : `<div class="banner info" style="margin:0 0 10px"><b>Today's walk isn't done yet.</b>${yard.last_date ? ` Last walk: ${fmtDate(yard.last_date)}.` : ""}</div>`}`;
  if (draft?.status === "queued") {
    h += `<div class="banner info"><b>Yard walk saved on phone, not yet uploaded.</b><br>${esc(draft.lastError || "Uploading…")}.
      It will send by itself when signal returns.<div style="margin-top:8px"><button class="secondary" id="sendNow">Try upload now</button></div></div>`;
  } else if (draft) {
    if (draft.lastError) h += `<div class="banner err"><b>The server didn't accept this walk:</b> ${esc(draft.lastError)} Open the draft to fix it.</div>`;
    h += atLeast("supervisor") ? `<a class="primary wide" href="#/yard/${yard.id}/walk">Resume draft walk</a>
      <button class="link danger" id="discard" style="width:100%">Discard draft</button>` : "";
  } else if (atLeast("supervisor")) {
    h += `<a class="primary wide" href="#/yard/${yard.id}/walk">${yard.walked_today ? "Start another walk" : "Start today's walk"}</a>`;
  }
  h += `</div>`;

  h += `<h2>Open findings (${open.length})</h2><div class="card">${open.length
    ? `<ul class="repairlist">${open.map((f) => findingItem(f)).join("")}</ul>` : `<span class="muted">Nothing open. ✓</span>`}</div>`;
  h += `<h2>Past walks</h2><div class="card list">${walks.length ? walks.map((w) => `<a class="item" href="#/yard-walk/${esc(w.id)}">
      <span class="grow">${fmtDate(w.inspection_date)}${w.inspection_date === today() ? " (today)" : ""}
        <span class="small muted clip">${esc(w.inspector_name)} · ${w.items} items</span></span>
      <span class="row" style="justify-content:flex-end;flex-wrap:nowrap">${w.failed
        ? `<span class="pill ${w.open ? "bad" : "okk"}">${w.open ? `${w.open} open` : "All fixed"}</span>` : `<span class="pill okk">All OK</span>`}</span></a>`).join("")
    : `<div class="empty">No walks yet.</div>`}</div>`;
  app.innerHTML = h;

  wireFindings(app, reload);
  const sn = $("#sendNow");
  if (sn) sn.onclick = async () => {
    sn.disabled = true;
    sn.innerHTML = `<span class="spinner"></span> Sending…`;
    const r = await sendYard(draft.key);
    if (r.state === "sent") { toast("Yard walk uploaded ✓"); location.hash = `#/yard-walk/${r.res.id}`; return; }
    if (r.state === "waiting") toast("Still no connection to the server. It will keep trying.");
    flushYard();
    reload();
  };
  const dc = $("#discard");
  if (dc) dc.onclick = async () => {
    if (!(await confirmBox(`Discard the draft walk for ${yard.name}? This can't be undone.`, "Discard", { danger: true }))) return;
    await discardYardDraft(yard.id);
    toast("Draft discarded");
    reload();
  };
}
