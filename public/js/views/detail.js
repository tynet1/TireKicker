// Inspection detail: everything submitted, repairs first, supervisor sign-off and PDF export.
import { api } from "../api.js";
import { setupSig } from "../sig.js";
import { atLeast, can, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, esc, fmtDate, fmtNum, lightbox, modal, toast, vehicleInfo } from "../util.js";
import { repairButtons, resolveRepair, SECTION_TITLES } from "./common.js";
import { regPill, regValue, updateRegistration } from "./registration.js";

let sigPad = null;

export function leave() {
  sigPad?.destroy();
  sigPad = null;
  const app = $("#app");
  app.onclick = null;
}

const ACTION_PAST = { archive: "Archived", unarchive: "Un-archived", delete: "Deleted", restore: "Restored" };

/** "Archive or delete" card: the buttons this user may use, plus every archive/delete/restore so far. */
function stateSection(i) {
  const isAdmin = atLeast("admin");
  const b = [];
  if (atLeast("supervisor")) {
    if (i.state === "active") b.push(`<button class="secondary" data-state="archive">Archive</button>`);
    if (i.state === "archived") b.push(`<button class="secondary" data-state="unarchive">Un-archive</button>`);
  }
  if (isAdmin && i.state !== "deleted") b.push(`<button class="secondary danger" data-state="delete">Delete</button>`);
  if (isAdmin && i.state === "deleted") b.push(`<button class="secondary" data-state="restore">Restore</button>`);
  const hist = i.state_history || [];
  if (!b.length && !hist.length) return "";
  return `<h2>Archive or delete</h2><div class="card">
    ${b.length ? `<div class="row">${b.join("")}</div>` : ""}
    ${i.state === "active" && b.length ? `<p class="small muted" style="margin:10px 0 0">Archive hides it from the lists and takes its repairs and damage off the truck; un-archive brings them back.${
      isAdmin ? " Delete is for inspections that should never have existed; it can be restored from Admin → Deleted." : ""}</p>` : ""}
    ${hist.length ? `<ul class="statehist">${hist.map((x) => `<li>${ACTION_PAST[x.action] || esc(x.action)} ${fmtDate(x.changed_at)} by ${esc(x.changed_by_name)}${
      x.reason ? `: ${esc(x.reason)}` : ""}</li>`).join("")}</ul>` : ""}</div>`;
}

/** Ask, then archive / un-archive / delete / restore. Resolves true once saved. */
function changeState(i, action) {
  const truck = i.vehicle.truck_code;
  const open = i.items.filter((it) => it.result === "repair" && !it.resolved_at).length;
  const marks = i.damage.length;
  const parts = [open ? `${open} open repair${open > 1 ? "s" : ""}` : "", marks ? `${marks} damage mark${marks > 1 ? "s" : ""}` : ""].filter(Boolean);
  const what = parts.join(" and ");
  const cfg = {
    archive: {
      title: "Archive this inspection?",
      body: `It's hidden from the lists but kept, and you can un-archive it any time.${what ? ` <b>${what} will come off ${esc(truck)}'s page</b> until then.` : ""}`,
      reason: "Why? (optional)", required: false, ok: "Archive",
    },
    unarchive: {
      title: "Un-archive this inspection?",
      body: `It goes back in the lists${what ? `, and its ${what} come back on ${esc(truck)}'s page` : ""}.`, ok: "Un-archive",
    },
    delete: {
      title: "Delete this inspection?",
      body: `For inspections that should never have existed (wrong truck, a duplicate, a test). Nothing is erased: it moves to
        Admin → Deleted and can be restored there.${what ? ` <b>${what} will come off ${esc(truck)}'s page.</b>` : ""}`,
      reason: "Why is it being deleted?", required: true, ok: "Delete", danger: true,
    },
    restore: {
      title: "Restore this inspection?",
      body: `It goes back in the lists${what ? `, and its ${what} come back on ${esc(truck)}'s page` : ""}.`, ok: "Restore",
    },
  }[action];
  return new Promise((resolve) => {
    const m = modal(`<h3>${cfg.title}</h3><p style="margin-top:-6px">${cfg.body}</p>
      ${cfg.reason ? `<label class="f" for="stReason">${cfg.reason}</label><textarea class="t" id="stReason" maxlength="500"></textarea>` : ""}
      <div id="stErr"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="secondary" data-c>Cancel</button>
        <button class="primary${cfg.danger ? " btn-danger" : ""}" data-y>${cfg.ok}</button></div>`);
    m.querySelector("[data-c]").onclick = () => { m.remove(); resolve(false); };
    m.querySelector("[data-y]").onclick = async (e) => {
      const reason = m.querySelector("#stReason")?.value.trim() || "";
      if (cfg.required && !reason) {
        m.querySelector("#stErr").innerHTML = `<div class="banner err">Add a short reason.</div>`;
        return;
      }
      e.target.disabled = true;
      try {
        await api(`/inspections/${i.id}/${action}`, { method: "POST", body: reason ? { reason } : {} });
        m.remove();
        toast(`${ACTION_PAST[action]} ✓`);
        resolve(true);
      } catch (err) {
        e.target.disabled = false;
        m.querySelector("#stErr").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
      }
    };
  });
}

/** The registration date on file for this inspection; "Was expired" if it had passed by the inspection date. */
const insReg = (i) => `${i.registration_expires ? fmtDate(i.registration_expires) : "—"} ${regPill(i.registration_expires, i.inspection_date)}`;

export async function render(app, id) {
  const nav = state.nav;
  setHeader({ title: "Inspection", back: "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let i;
  try {
    i = await api(`/inspections/${id}`);
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  const v = i.vehicle;
  const isSup = atLeast("supervisor");
  setHeader({ title: `${v.truck_code} · ${fmtDate(i.inspection_date)}`, sub: vehicleInfo(v), back: `#/truck/${v.id}` });

  const marks = new Map(i.damage.map((m) => [m.id, m]));
  const items = new Map(i.items.map((it) => [it.id, it]));
  const tagOf = (p) => {
    if (p.damage_mark_id && marks.get(p.damage_mark_id)) {
      const m = marks.get(p.damage_mark_id);
      return `${m.diagram === "trailer" ? "Trailer damage" : "Damage"} ${m.seq}`;
    }
    if (p.inspection_item_id && items.get(p.inspection_item_id)) return `Repair: ${items.get(p.inspection_item_id).label}`;
    return "";
  };
  const photoUrl = (p) => `/api/photos/${p.id}`;
  const thumbs = (list) => list.length
    ? `<div class="row" style="margin-top:6px">${list.map((p) => `<img src="${photoUrl(p)}" data-lb="${p.id}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px;cursor:zoom-in">`).join("")}</div>`
    : "";

  const repairs = i.items.filter((it) => it.result === "repair");
  const live = i.state === "active";
  const si = i.state_info;
  let h = "";
  if (i.state === "archived") {
    h += `<div class="banner info"><b>Archived</b> ${fmtDate(si?.changed_at)}${si?.changed_by_name ? ` by ${esc(si.changed_by_name)}` : ""}${si?.reason ? `: ${esc(si.reason)}` : ""}.
      It's hidden from the lists, and its repairs and damage are off ${esc(v.truck_code)}'s page. It still exports to PDF.</div>`;
  } else if (i.state === "deleted") {
    h += `<div class="banner err"><b>Deleted</b> ${fmtDate(si?.changed_at)}${si?.changed_by_name ? ` by ${esc(si.changed_by_name)}` : ""}${si?.reason ? `: ${esc(si.reason)}` : ""}.
      Nothing was erased: it's listed under Admin → Deleted and can be restored there.</div>`;
  }
  if (i.mileage_flagged) {
    h += `<div class="banner info"><b>Mileage check:</b> ${fmtNum(i.mileage)} is lower than the previous ${fmtNum(i.previous_mileage)}.
      Check with the inspector; put any correction in the supervisor note.</div>`;
  }
  h += `<div class="card" style="margin-top:14px"><dl class="kv">
    <dt>Truck</dt><dd><b>${esc(v.truck_code)}</b> ${esc(vehicleInfo(v))}${v.plate ? ` · ${esc(v.plate)}` : ""}</dd>
    <dt>Date</dt><dd>${fmtDate(i.inspection_date)}</dd>
    <dt>Inspector</dt><dd>${esc(i.inspector_name)}</dd>
    <dt>Mileage</dt><dd>${fmtNum(i.mileage)}${i.mileage_flagged ? ' <span class="pill warn">Lower than last</span>' : ""}</dd>
    <dt>Oil change due</dt><dd>${i.oil_change_due ? '<span class="pill warn">Yes</span>' : "No"}</dd>
    <dt>Registration expires</dt><dd id="insReg">${insReg(i)}</dd>
    ${i.trailer ? `<dt>Trailer</dt><dd>${esc(i.trailer.number || "—")} · plate ${esc(i.trailer.plate || "—")}${i.trailer.type ? `<br><span class="small muted">${esc(i.trailer.type)}</span>` : ""}</dd>` : ""}
    <dt>Status</dt><dd>${i.status === "reviewed" ? '<span class="pill okk">Signed off</span>' : '<span class="pill grey">Awaiting sign-off</span>'}</dd>
  </dl>${isSup ? `<a class="secondary" style="width:100%;margin-top:12px" href="/api/inspections/${esc(i.id)}/pdf" download>Export PDF</a>` : ""}</div>`;

  const openCount = repairs.filter((r) => !r.resolved_at).length;
  h += `<h2>${repairs.length && !openCount ? `Repairs (${repairs.length}, all fixed)` : `Repairs needed (${openCount})`}</h2><div class="card">${repairs.length
    ? `<ul class="repairlist">${repairs.map((r) => `<li><div class="spread" style="align-items:flex-start"><div>
        <b>${esc(r.label)}</b> <span class="small muted">(${esc(SECTION_TITLES[r.section] || r.section)})</span>
        ${r.note ? `<div>${esc(r.note)}</div>` : ""}
        ${r.resolved_at ? (r.service_log_id
          ? `<div class="small" style="color:var(--ok)">✓ Fixed ${fmtDate(r.resolved_at)}${r.resolved_by_name ? ` by ${esc(r.resolved_by_name)}` : ""}${
            can.seeService() ? ` · <a href="#/service/${esc(r.service_log_id)}">See maintenance entry</a>` : " (maintenance log)"}</div>`
          : `<div class="small" style="color:var(--ok)">✓ Resolved ${fmtDate(r.resolved_at)}${r.resolved_by_name ? ` by ${esc(r.resolved_by_name)}` : ""}: ${esc(r.resolution_note)}</div>`) : ""}
        ${thumbs(i.photos.filter((p) => p.inspection_item_id === r.id))}</div>
        ${r.resolved_at || !live ? "" : repairButtons(r, v.id, { canLog: can.logService(), canResolve: isSup })}</div></li>`).join("")}</ul>`
    : `<span class="muted">Everything marked OK.</span>`}</div>`;

  const dia = (url, list) => `<div class="diagram ro"><img src="${esc(url)}" alt="">${list.map((m) => `<span class="pin" style="left:${m.x * 100}%;top:${m.y * 100}%">${m.seq}</span>`).join("")}</div>
    <ol class="legend">${list.map((m) => `<li value="${m.seq}">${esc(m.note || "(no description)")}${thumbs(i.photos.filter((p) => p.damage_mark_id === m.id))}</li>`).join("")}</ol>`;
  const truckMarks = i.damage.filter((m) => m.diagram === "truck");
  const trailerMarks = i.damage.filter((m) => m.diagram === "trailer");
  if (truckMarks.length && i.truck_diagram_url) h += `<h2>Truck damage</h2><div class="card">${dia(i.truck_diagram_url, truckMarks)}</div>`;
  if (trailerMarks.length && i.trailer_diagram_url) h += `<h2>Trailer damage</h2><div class="card">${dia(i.trailer_diagram_url, trailerMarks)}</div>`;

  if (i.existing_notes || i.new_observations) {
    h += `<h2>Notes</h2><div class="card">
      ${i.existing_notes ? `<div class="small muted">Existing</div><div style="white-space:pre-wrap;margin-bottom:10px">${esc(i.existing_notes)}</div>` : ""}
      ${i.new_observations ? `<div class="small muted">New observations</div><div style="white-space:pre-wrap">${esc(i.new_observations)}</div>` : ""}</div>`;
  }
  if (i.photos.length) {
    h += `<h2>Photos (${i.photos.length})</h2><div class="card"><div class="photos">${i.photos.map((p) => {
      const tag = tagOf(p);
      return `<div class="ph" data-lb="${p.id}" style="cursor:zoom-in"><img src="${photoUrl(p)}" alt="" loading="lazy">
        ${tag ? `<span class="tag">${esc(tag)}</span>` : ""}${p.caption ? `<div class="cap">${esc(p.caption)}</div>` : ""}</div>`;
    }).join("")}</div></div>`;
  }
  if (i.comments) h += `<h2>Comments</h2><div class="card" style="white-space:pre-wrap">${esc(i.comments)}</div>`;

  const sections = ["exterior", "interior", "trailer"].filter((s) => i.items.some((it) => it.section === s));
  h += `<h2>Full checklist</h2><div class="card small">${sections.map((s) => `<b>${SECTION_TITLES[s]}</b><div style="margin:4px 0 12px">
    ${i.items.filter((it) => it.section === s).map((it) => `<div class="chk"><span>${esc(it.label)}</span>
      <span class="pill ${it.result === "repair" ? "bad" : "okk"}">${it.result === "repair" ? "Repair" : "OK"}</span></div>`).join("")}</div>`).join("")}</div>`;

  h += `<h2>Sign-off</h2><div class="card"><div class="small muted">Employee</div>
    <img class="sigimg" src="${esc(i.employee_signature_url)}" alt="Employee signature">
    <div class="small">${esc(i.inspector_name)} · ${fmtDate(i.inspection_date)}</div>
    <div style="border-top:1px solid var(--line);margin:12px 0"></div><div class="small muted">Supervisor</div>`;
  if (i.supervisor) {
    h += `<img class="sigimg" src="${esc(i.supervisor.signature_url)}" alt="Supervisor signature">
      <div class="small">${esc(i.supervisor.name)} · ${fmtDate(i.supervisor.signed_at)}</div>
      ${i.supervisor.note ? `<div style="margin-top:8px"><b>Supervisor note:</b> <span style="white-space:pre-wrap">${esc(i.supervisor.note)}</span></div>` : ""}`;
  } else if (isSup && i.state !== "deleted") {
    h += `<div style="margin-top:6px">
      <div class="regrow"><span class="small muted">Truck registration expires</span> <span id="regBox">${regValue(v.registration_expires)}</span></div>
      <label class="f" for="supName">Supervisor name</label><input class="t" id="supName" value="${esc(state.user.name)}">
      <label class="f" for="supNote" style="margin-top:10px">Note (optional; corrections go here)</label><textarea class="t" id="supNote"></textarea>
      <label class="f" style="margin-top:10px">Signature</label><canvas class="sig" id="supsig" aria-label="Supervisor signature pad"></canvas>
      <div id="supErr"></div>
      <div class="spread" style="margin-top:8px"><button class="link" id="supClr">Clear</button><button class="primary" id="supSave">Sign off</button></div></div>`;
  } else {
    h += `<span class="pill grey">Awaiting supervisor review</span>`;
  }
  h += `</div>`;
  h += stateSection(i);
  app.innerHTML = h;

  app.onclick = async (e) => {
    const lb = e.target.closest("[data-lb]");
    if (lb) {
      const p = i.photos.find((x) => x.id === lb.dataset.lb);
      if (p) lightbox(photoUrl(p), [tagOf(p), p.caption].filter(Boolean).join(" — "));
      return;
    }
    if (e.target.closest("[data-regupd]")) {
      // Updated in place, so a signature or note already started here isn't lost. Set while signing off,
      // it's also the date this inspection (and its PDF) shows.
      const date = await updateRegistration(v, { from: "sign-off", inspectionId: i.id });
      if (!date || stale(nav)) return;
      v.registration_expires = date;
      i.registration_expires = date;
      $("#regBox").innerHTML = regValue(date);
      $("#insReg").innerHTML = insReg(i);
      return;
    }
    const rs = e.target.closest("[data-resolve]");
    if (rs && (await resolveRepair(rs.dataset.resolve, rs.dataset.label)) && !stale(nav)) render(app, id);
    const act = e.target.closest("[data-state]");
    if (act && (await changeState(i, act.dataset.state)) && !stale(nav)) render(app, id);
  };

  if ($("#supsig")) {
    let sup = null;
    sigPad = setupSig($("#supsig"), { get: () => sup, set: (val) => { sup = val; } });
    $("#supClr").onclick = () => sigPad.clear();
    $("#supSave").onclick = async () => {
      const name = $("#supName").value.trim();
      if (!sup || !name) {
        $("#supErr").innerHTML = `<div class="banner err">Add your name and signature.</div>`;
        return;
      }
      const b = $("#supSave");
      b.disabled = true;
      b.innerHTML = `<span class="spinner"></span>&nbsp;Saving…`;
      try {
        await api(`/inspections/${i.id}/review`, { method: "POST", body: { signature: sup, name, note: $("#supNote").value } });
        toast("Signed off ✓");
        if (!stale(nav)) render(app, id);
      } catch (err) {
        b.disabled = false;
        b.textContent = "Sign off";
        $("#supErr").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
      }
    };
  }
}
