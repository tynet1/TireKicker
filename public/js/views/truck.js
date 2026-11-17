// Truck page: details, start/resume an inspection, open repairs, history.
import { api } from "../api.js";
import { deleteDraft, deletePhotoBlob, flush, getDraft, sendQueued, storePhotoBlob, uploadPhoto } from "../drafts.js";
import { flushSvc, getSvcDraft, sendSvc } from "../svc.js";
import { atLeast, can, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, confirmBox, esc, fmtDate, fmtNum, lightbox, modal, shrinkImage, toast, uuid, vehicleInfo } from "../util.js";
import { inspectionRow, repairButtons, resolveRepair, SECTION_TITLES, serviceRow } from "./common.js";
import { regHistoryHtml, regValue, updateRegistration } from "./registration.js";
import { makeTicket, openTicket, ticketPills, ticketsSection } from "./tickets.js";

let showAllService = false;
let showAllDamage = false;
let lastTruck = null;

export async function render(app, id) {
  const nav = state.nav;
  if (id !== lastTruck) { showAllService = false; showAllDamage = false; lastTruck = id; }
  setHeader({ title: "Truck", back: "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let data, draft, svc, svcDraft, tickets;
  try {
    [data, draft, svc, svcDraft, tickets] = await Promise.all([
      api(`/vehicles/${id}`),
      getDraft(id),
      can.seeService() ? api(`/vehicles/${id}/service`).catch((e) => e) : null,
      getSvcDraft(`new-${id}`).catch(() => null),
      can.seeService() ? api(`/vehicles/${id}/repair-tickets`).catch(() => []) : [],
    ]);
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  const { vehicle: v, openRepairs, history } = data;
  setHeader({
    title: v.truck_code, sub: vehicleInfo(v), back: "#/",
    actions: atLeast("admin") ? [{ label: "Edit", href: `#/admin/trucks?edit=${v.id}` }] : [],
  });

  let h = `<div class="card" style="margin-top:14px"><div class="hdr">
      <b>Truck ID</b><span>${esc(v.truck_code)}</span><b>Unit</b><span>${esc(v.unit || "—")}</span>
      <b>VIN</b><span style="word-break:break-all">${esc(v.vin || "—")}</span><b>Plate</b><span>${esc(v.plate || "—")}</span>
      <b>Info</b><span>${esc(vehicleInfo(v) || "—")}</span>
      <b>Reg exp.</b>${regValue(v.registration_expires)}
      <b>Last miles</b><span>${v.last_mileage != null ? fmtNum(v.last_mileage) : "—"}</span>
      <b>Trailer</b><span>${v.pulls_trailer ? esc(v.trailer_type || "Yes") : "None"}</span>
    </div>${regHistoryHtml(data.registration)}</div>`;

  if (draft?.status === "queued") {
    h += `<div class="banner info"><b>Saved on phone, not yet uploaded.</b><br>${esc(draft.lastError || "Uploading…")}.
      It will send by itself when signal returns.<div style="margin-top:8px"><button class="secondary" id="sendNow">Try upload now</button></div></div>`;
  } else if (draft) {
    if (draft.lastError) h += `<div class="banner err"><b>The server didn't accept this inspection:</b> ${esc(draft.lastError)} Open the draft to fix it.</div>`;
    h += `<a class="primary wide" style="margin:6px 0 4px" href="#/inspect/${v.id}">Resume draft inspection</a>
      <button class="link danger" id="discard" style="width:100%">Discard draft</button>`;
  } else {
    h += `<a class="primary wide" style="margin:6px 0 4px" href="#/inspect/${v.id}">Start inspection</a>`;
  }

  const who = { canLog: can.logService(), canResolve: atLeast("supervisor") };
  h += `${can.seeService() && openRepairs.length
    ? `<div class="h2row"><h2>Open repairs (${openRepairs.length})</h2><button class="link" id="mkTicket">Make repair ticket</button></div>`
    : `<h2>Open repairs (${openRepairs.length})</h2>`}<div class="card">${openRepairs.length
    ? `<ul class="repairlist">${openRepairs.map((r) => `<li><div class="spread"><div><b>${esc(r.label)}</b> <span class="small muted">(${esc(SECTION_TITLES[r.section] || r.section)})</span>${ticketPills(r)}
        ${r.note ? `<div>${esc(r.note)}</div>` : ""}<a class="small" href="#/inspection/${esc(r.inspection_id)}">From ${fmtDate(r.inspection_date)} inspection</a></div>
        ${repairButtons(r, v.id, who)}</div></li>`).join("")}</ul>`
    : `<span class="muted">No open repairs.</span>`}</div>`;
  h += ticketsSection(tickets || []);
  h += damageSection(v, data.damage || []);
  if (svc) h += serviceSection(v, svc, svcDraft);
  h += `${atLeast("supervisor") && history.length
    ? `<div class="h2row"><h2>Inspection history</h2><a class="link" href="#/export?truck=${v.id}">Export PDFs</a></div>`
    : `<h2>Inspection history</h2>`}<div class="card list">${history.length
    ? history.map((i) => inspectionRow(i, { showTruck: false })).join("")
    : `<div class="empty">No inspections yet.</div>`}
    ${data.archived_count ? `<div id="archivedBox"><button class="link" id="showArchived" style="width:100%">Show ${data.archived_count} archived</button></div>` : ""}</div>`;
  app.innerHTML = h;

  const sn = $("#sendNow");
  if (sn) sn.onclick = async () => {
    sn.disabled = true;
    sn.innerHTML = `<span class="spinner"></span> Sending…`;
    const r = await sendQueued(v.id);
    if (r.state === "sent") { toast("Inspection uploaded ✓"); location.hash = `#/inspection/${r.res.id}`; return; }
    if (r.state === "waiting") toast("Still no connection to the server. It will keep trying.");
    flush();
    if (!stale(nav)) render(app, id);
  };
  const ru = app.querySelector("[data-regupd]");
  if (ru) ru.onclick = async () => {
    if ((await updateRegistration(v, { from: "truck" })) && !stale(nav)) render(app, id);
  };
  const dc = $("#discard");
  if (dc) dc.onclick = async () => {
    if (!(await confirmBox(`Discard the draft inspection for ${v.truck_code}? This can't be undone.`, "Discard", { danger: true }))) return;
    await deleteDraft(draft);
    toast("Draft discarded");
    render(app, id);
  };
  app.querySelectorAll("[data-resolve]").forEach((b) => (b.onclick = async () => {
    if (await resolveRepair(b.dataset.resolve, b.dataset.label)) render(app, id);
  }));
  const mk = $("#mkTicket");
  if (mk) mk.onclick = async () => {
    const tid = await makeTicket(v, openRepairs);
    if (tid && !stale(nav)) { render(app, id); openTicket(tid); }
  };
  app.querySelectorAll("[data-ticket]").forEach((b) => (b.onclick = async () => {
    if ((await openTicket(b.dataset.ticket)) && !stale(nav)) render(app, id);
  }));
  const ma = $("#svcMore");
  if (ma) ma.onclick = () => { showAllService = true; render(app, id); };
  const sa = $("#showArchived");
  if (sa) sa.onclick = async () => {
    sa.disabled = true;
    sa.innerHTML = `<span class="spinner"></span>`;
    try {
      const list = await api(`/inspections?vehicle_id=${v.id}&archived=only&limit=200`);
      if (stale(nav)) return;
      $("#archivedBox").innerHTML = `<div class="small muted" style="padding:10px 2px 0">Archived: kept, but their repairs and damage are off this page.</div>
        ${list.map((i) => inspectionRow(i, { showTruck: false })).join("")}`;
    } catch (e) {
      if (!stale(nav)) $("#archivedBox").innerHTML = errorHtml(e);
    }
  };
  const dm = $("#dmgMore");
  if (dm) dm.onclick = () => { showAllDamage = true; render(app, id); };
  app.querySelectorAll("[data-lb]").forEach((img) => (img.onclick = () => lightbox(img.src, img.dataset.cap)));
  app.querySelectorAll("[data-dmgfix]").forEach((b) => (b.onclick = async () => {
    const m = data.damage.find((x) => x.id === Number(b.dataset.dmgfix));
    if (m && (await markRepaired(m)) && !stale(nav)) render(app, id);
  }));
  app.querySelectorAll("[data-dmgundo]").forEach((b) => (b.onclick = async () => {
    const m = data.damage.find((x) => x.repair?.id === Number(b.dataset.dmgundo));
    if (m && (await undoRepaired(m)) && !stale(nav)) render(app, id);
  }));
  const ss = $("#svcSend");
  if (ss) ss.onclick = async () => {
    ss.disabled = true;
    ss.innerHTML = `<span class="spinner"></span> Sending…`;
    const r = await sendSvc(`new-${v.id}`);
    if (r.state === "sent") { toast("Maintenance uploaded ✓"); location.hash = `#/service/${r.res.id}`; return; }
    if (r.state === "waiting") toast("Still no connection to the server. It will keep trying.");
    flushSvc();
    if (!stale(nav)) render(app, id);
  };
}

const thumb = (p, cap, alt) =>
  `<img class="dmgthumb" src="/api/photos/${esc(p.id)}" data-lb="${esc(p.id)}" data-cap="${esc([cap, p.caption].filter(Boolean).join(" — "))}" alt="${esc(alt)}">`;

/**
 * Every damage mark from every inspection of this truck. Still on file: the picture with each one numbered
 * (1 = oldest) and a list, newest first, with Log fix (shop/admin) and Mark repaired (supervisor/admin).
 * Repaired ones move to a "Repaired" list with before and after photos; nothing is removed.
 * Marks drawn on a picture the truck no longer uses are listed but not drawn.
 */
function damageSection(v, damage) {
  const canLog = can.logService();
  const canMark = atLeast("supervisor");
  const onFileAll = damage.filter((m) => !m.repair);
  const parts = [];
  for (const kind of ["truck", "trailer"]) {
    const all = damage.filter((m) => m.diagram === kind);
    if (!all.length) continue;
    const list = all.filter((m) => !m.repair);
    const repaired = all.filter((m) => m.repair).reverse();
    const url = kind === "truck" ? v.diagram_url : v.trailer_diagram_url;
    const drawn = list.filter((m) => m.on_current_diagram);
    const newest = [...list].reverse();
    const shown = showAllDamage ? newest : newest.slice(0, 5);
    const label = (m) => `${kind === "trailer" ? "Trailer damage" : "Damage"} ${m.n}${m.note ? `: ${m.note}` : ""}`;
    const marked = (m) => `<a href="#/inspection/${esc(m.inspection_id)}">Marked ${fmtDate(m.inspection_date)}</a>${
      kind === "trailer" && m.trailer_number ? ` · trailer ${esc(m.trailer_number)}` : ""}`;
    const btns = (m) => {
      const b = [];
      if (canLog) b.push(`<a class="secondary" href="#/service/new/${v.id}?fixdmg=${m.id}">Log fix</a>`);
      if (canMark) b.push(`<button class="secondary" data-dmgfix="${m.id}">Mark repaired</button>`);
      return b.length ? `<div class="btncol">${b.join("")}</div>` : "";
    };
    parts.push(`${kind === "trailer" ? `<div class="subhead">Trailer${v.trailer_type ? ` (${esc(v.trailer_type)})` : ""}</div>` : ""}
      ${url && drawn.length ? `<div class="diagram ro"><img src="${esc(url)}" alt="${kind} damage on file">${drawn.map((m) =>
        `<span class="pin hist" style="left:${m.x * 100}%;top:${m.y * 100}%">${m.n}</span>`).join("")}</div>` : ""}
      ${list.length ? `<ul class="dmglist">${shown.map((m) => `<li><span class="ofn">${m.n}</span><div class="grow">
        <b>${esc(m.note || "(no description)")}</b>
        <div class="small muted">${marked(m)}${m.on_current_diagram ? "" : " · drawn on an earlier picture, not shown above"}</div>
        ${m.photos.length ? `<div class="row" style="margin-top:4px">${m.photos.map((p) => thumb(p, label(m), `Photo of damage ${m.n}`)).join("")}</div>` : ""}
      </div>${btns(m)}</li>`).join("")}</ul>` : `<p class="muted" style="margin:10px 0 0">Nothing on file${repaired.length ? " (all repaired)" : ""}.</p>`}
      ${list.length > shown.length ? `<button class="link" id="dmgMore" style="width:100%">Show all ${list.length}</button>` : ""}
      ${repaired.length ? `<details class="onfile"><summary>Repaired (${repaired.length})</summary>
        <ul class="dmglist repaired">${repaired.map((m) => `<li><span class="ofn">${m.n}</span><div class="grow">
          <b>${esc(m.note || "(no description)")}</b>
          <div class="small" style="color:var(--ok)">✓ Repaired ${fmtDate(m.repair.repaired_at)} by ${esc(m.repair.repaired_by_name)}${
            m.repair.service_log_id && can.seeService() ? ` · <a href="#/service/${m.repair.service_log_id}">maintenance entry</a>` : ""}</div>
          ${!m.repair.service_log_id && m.repair.note ? `<div class="small">${esc(m.repair.note)}</div>` : ""}
          <div class="small muted">${marked(m)}</div>
          <div class="beforeafter">
            ${m.photos.length ? `<div><span class="small muted">Before</span><div class="row">${m.photos.map((p) => thumb(p, label(m), "Before")).join("")}</div></div>` : ""}
            ${m.repair.photos.length ? `<div><span class="small muted">After</span><div class="row">${m.repair.photos.map((p) => thumb(p, `Repaired: ${label(m)}`, "After")).join("")}</div></div>` : ""}
          </div>
        </div>${canMark && !m.repair.service_log_id ? `<button class="link" data-dmgundo="${m.repair.id}">Undo</button>` : ""}</li>`).join("")}</ul>
      </details>` : ""}`);
  }
  return `<h2>Damage on file (${onFileAll.length})</h2><div class="card">${parts.length
    ? parts.join("") : `<span class="muted">No damage marked on any inspection yet.</span>`}</div>`;
}

/** Supervisor: mark damage repaired. A note and a photo of the fixed area are required. Resolves true once saved. */
function markRepaired(m) {
  return new Promise((resolve) => {
    const clientId = uuid();
    let photo = null; // { id, url }
    const md = modal(`<h3>Mark damage repaired</h3>
      <p class="muted" style="margin-top:-6px">${esc(m.note || "Damage")} · marked ${fmtDate(m.inspection_date)}</p>
      <label class="f" for="drNote">What was done?</label>
      <textarea class="t" id="drNote" maxlength="1000" placeholder="e.g. Body shop pulled the dent and repainted"></textarea>
      <label class="f" style="margin-top:12px">Photo of the fixed area (required)</label>
      <div id="drPhoto"></div>
      <div id="drErr"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="secondary" data-c>Cancel</button><button class="primary" data-y>Mark repaired</button></div>`);
    const drawPhoto = () => {
      md.querySelector("#drPhoto").innerHTML = photo
        ? `<div class="photos"><div class="ph"><img alt="Photo of the fixed area" src="${photo.url}">
            <button type="button" class="x" data-rm aria-label="Remove photo">×</button></div></div>`
        : `<label class="addph" style="aspect-ratio:auto;min-height:88px"><span style="font-size:24px">📷</span><span>Take or pick a photo</span>
            <input type="file" accept="image/*" id="drFile"></label>`;
      const rm = md.querySelector("[data-rm]");
      if (rm) rm.onclick = () => { deletePhotoBlob(photo.id).catch(() => {}); URL.revokeObjectURL(photo.url); photo = null; drawPhoto(); };
      const inp = md.querySelector("#drFile");
      if (inp) inp.onchange = async () => {
        const file = inp.files?.[0];
        if (!file) return;
        const blob = await shrinkImage(file);
        const id = uuid();
        await storePhotoBlob(id, blob);
        photo = { id, url: URL.createObjectURL(blob) };
        drawPhoto();
      };
    };
    drawPhoto();
    const close = (ok) => { if (photo) URL.revokeObjectURL(photo.url); md.remove(); resolve(ok); };
    md.querySelector("[data-c]").onclick = () => { if (photo) deletePhotoBlob(photo.id).catch(() => {}); close(false); };
    md.querySelector("[data-y]").onclick = async (e) => {
      const note = md.querySelector("#drNote").value.trim();
      const err = md.querySelector("#drErr");
      if (!note || !photo) {
        err.innerHTML = `<div class="banner err">${!note && !photo ? "Add what was done and a photo of the fixed area." : !note ? "Add what was done." : "Add a photo of the fixed area."}</div>`;
        return;
      }
      const b = e.target;
      b.disabled = true;
      b.innerHTML = `<span class="spinner"></span>&nbsp;Saving…`;
      try {
        await uploadPhoto(photo.id);
        await api(`/damage-marks/${m.id}/repair`, { method: "POST", body: { client_id: clientId, note, photo_ids: [photo.id] } });
        deletePhotoBlob(photo.id).catch(() => {});
        toast("Marked repaired ✓");
        close(true);
      } catch (ex) {
        b.disabled = false;
        b.textContent = "Mark repaired";
        err.innerHTML = `<div class="banner err">${esc(ex.message)}</div>`;
      }
    };
  });
}

/** Undo a supervisor's "mark repaired" (a mistake): the damage goes back on file. Nothing is erased. */
function undoRepaired(m) {
  return new Promise((resolve) => {
    const md = modal(`<h3>Put this damage back on file?</h3>
      <p class="muted" style="margin-top:-6px">${esc(m.note || "Damage")}: marked repaired ${fmtDate(m.repair.repaired_at)} by ${esc(m.repair.repaired_by_name)}.
        The repair record and its photo are kept.</p>
      <label class="f" for="duReason">Why?</label><textarea class="t" id="duReason" maxlength="500" placeholder="e.g. Marked the wrong dent"></textarea>
      <div id="duErr"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="secondary" data-c>Cancel</button><button class="primary" data-y>Put back on file</button></div>`);
    md.querySelector("[data-c]").onclick = () => { md.remove(); resolve(false); };
    md.querySelector("[data-y]").onclick = async (e) => {
      const reason = md.querySelector("#duReason").value.trim();
      if (!reason) { md.querySelector("#duErr").innerHTML = `<div class="banner err">Add a short reason.</div>`; return; }
      e.target.disabled = true;
      try {
        await api(`/damage-repairs/${m.repair.id}/undo`, { method: "POST", body: { reason } });
        md.remove();
        toast("Back on file ✓");
        resolve(true);
      } catch (ex) {
        e.target.disabled = false;
        md.querySelector("#duErr").innerHTML = `<div class="banner err">${esc(ex.message)}</div>`;
      }
    };
  });
}

function serviceSection(v, svc, svcDraft) {
  let h = `<div class="h2row"><h2>Maintenance</h2><a class="link" href="#/csv?what=maintenance&truck=${v.id}">Download CSV</a></div>`;
  if (svcDraft?.status === "queued") {
    h += `<div class="banner info"><b>Maintenance entry saved on phone, not yet uploaded.</b><br>${esc(svcDraft.lastError || "Uploading…")}.
      It will send by itself when signal returns.<div style="margin-top:8px"><button class="secondary" id="svcSend">Try upload now</button></div></div>`;
  } else if (can.logService()) {
    if (svcDraft?.lastError) h += `<div class="banner err"><b>The server didn't accept this entry:</b> ${esc(svcDraft.lastError)} Open the draft to fix it.</div>`;
    h += `<a class="secondary wide" style="margin-bottom:10px" href="#/service/new/${v.id}">${svcDraft ? "Resume maintenance draft" : "+ Log maintenance"}</a>`;
  }
  if (svc instanceof Error) return h + errorHtml(svc);
  if (svc.next_due.length) {
    h += `<div class="card"><div class="small muted" style="font-weight:650;margin-bottom:4px">Next due</div>${svc.next_due.map((nd) => {
      const when = [nd.mileage != null ? `${fmtNum(nd.mileage)} mi` : "", nd.date ? fmtDate(nd.date) : ""].filter(Boolean).join(" or ");
      const cls = nd.state === "due" ? "bad" : nd.state === "soon" ? "warn" : "grey";
      return `<a class="spread" style="padding:8px 0;min-height:44px;text-decoration:none;color:inherit" href="#/service/${nd.entry_id}">
        <span>${esc(nd.category_label)}</span><span class="pill ${cls}">${nd.state === "due" ? "Due now · " : nd.state === "soon" ? "Soon · " : ""}${esc(when)}</span></a>`;
    }).join("")}${svc.current_mileage != null ? `<div class="small muted">Last recorded mileage ${fmtNum(svc.current_mileage)}</div>` : ""}</div>`;
  }
  const list = showAllService ? svc.entries : svc.entries.slice(0, 8);
  h += `<div class="card list">${list.length ? list.map((s) => serviceRow(s)).join("") : `<div class="empty">No maintenance logged yet.</div>`}
    ${svc.entries.length > list.length ? `<button class="link" id="svcMore" style="width:100%">Show all ${svc.entries.length}</button>` : ""}</div>`;
  return h;
}
