// One incident report (supervisors and admins): everything filed, the damage and whether it's been repaired, notes
// added since, the PDF packet, and archive/delete. Opening it takes it off this user's "new incident" list.
import { api } from "../api.js";
import { atLeast, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, esc, fmtDate, lightbox, modal, toast, uuid, vehicleInfo } from "../util.js";

const ACTION_PAST = { archive: "Archived", unarchive: "Un-archived", delete: "Deleted", restore: "Restored" };
const YN = (v) => (v === true ? "Yes" : v === false ? "No" : "");

export function leave() {
  const app = $("#app");
  app.onclick = null;
}

/** Definition list of the rows that have a value. */
function kv(rows, empty = `<span class="muted">Nothing filled in.</span>`) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  return shown.length ? `<dl class="kv">${shown.map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd${raw ? "" : ` style="white-space:pre-wrap"`}>${raw ? v : esc(v)}</dd>`).join("")}</dl>`
    : empty;
}

/** "14:30" -> "2:30 PM". */
export function clock(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function stateSection(n) {
  const isAdmin = atLeast("admin");
  const b = [];
  if (n.state === "active") b.push(`<button class="secondary" data-state="archive">Archive</button>`);
  if (n.state === "archived") b.push(`<button class="secondary" data-state="unarchive">Un-archive</button>`);
  if (isAdmin && n.state !== "deleted") b.push(`<button class="secondary danger" data-state="delete">Delete</button>`);
  if (isAdmin && n.state === "deleted") b.push(`<button class="secondary" data-state="restore">Restore</button>`);
  const hist = n.state_history || [];
  return `<h2>Archive or delete</h2><div class="card">
    ${b.length ? `<div class="row">${b.join("")}</div>` : ""}
    ${n.state === "active" ? `<p class="small muted" style="margin:10px 0 0">Archive hides it from the lists and takes its damage off the truck; un-archive brings it back.${
      isAdmin ? " Delete is for reports that should never have existed; it goes in Admin → Trash, where it can be restored." : ""}</p>` : ""}
    ${hist.length ? `<ul class="statehist">${hist.map((x) => `<li>${ACTION_PAST[x.action] || esc(x.action)} ${fmtDate(x.changed_at)} by ${esc(x.changed_by_name)}${
      x.reason ? `: ${esc(x.reason)}` : ""}</li>`).join("")}</ul>` : ""}</div>`;
}

function changeState(n, action) {
  const marks = n.damage.filter((m) => !m.repair_id).length;
  const what = marks ? `${marks} damage mark${marks > 1 ? "s" : ""}` : "";
  const truck = esc(n.truck_code);
  const cfg = {
    archive: { title: "Archive this report?", body: `It's hidden from the lists but kept, and you can un-archive it any time.${what ? ` <b>Its ${what} will come off ${truck}'s page</b> until then.` : ""}`,
      reason: "Why? (optional)", ok: "Archive" },
    unarchive: { title: "Un-archive this report?", body: `It goes back in the lists${what ? `, and its ${what} come back on ${truck}'s page` : ""}.`, ok: "Un-archive" },
    delete: { title: "Delete this report?", body: `For reports that should never have existed (wrong truck, a duplicate, a test). Nothing is erased yet: it goes in
        Admin → Trash and can be restored there. After 7 days in the trash an admin can delete it forever.${what ? ` <b>Its ${what} will come off ${truck}'s page.</b>` : ""}`,
      reason: "Why is it being deleted?", required: true, ok: "Delete", danger: true },
    restore: { title: "Restore this report?", body: `It goes back in the lists${what ? `, and its ${what} come back on ${truck}'s page` : ""}.`, ok: "Restore" },
  }[action];
  return new Promise((resolve) => {
    const m = modal(`<h3>${cfg.title}</h3><p style="margin-top:-6px">${cfg.body}</p>
      ${cfg.reason ? `<label class="f" for="stReason">${cfg.reason}</label><textarea class="t" id="stReason" maxlength="500"></textarea>` : ""}
      <div id="stErr"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="secondary" data-c>Cancel</button><button class="primary${cfg.danger ? " btn-danger" : ""}" data-y>${cfg.ok}</button></div>`);
    m.querySelector("[data-c]").onclick = () => { m.remove(); resolve(false); };
    m.querySelector("[data-y]").onclick = async (e) => {
      const reason = m.querySelector("#stReason")?.value.trim() || "";
      if (cfg.required && !reason) { m.querySelector("#stErr").innerHTML = `<div class="banner err">Add a short reason.</div>`; return; }
      e.target.disabled = true;
      try {
        await api(`/incidents/${n.id}/${action}`, { method: "POST", body: reason ? { reason } : {} });
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

/** Add a note (a correction or a later fact). Needs signal; resolves true once saved. */
function addNote(n) {
  return new Promise((resolve) => {
    const clientId = uuid();
    const m = modal(`<h3>Add a note</h3><p class="muted" style="margin-top:-6px">The report itself can't be changed once filed. Corrections and later
        facts (a claim number, the repair estimate…) go here, with your name and the date. They print on the PDF.</p>
      <textarea class="t" id="ntText" maxlength="2000" rows="5"></textarea><div id="ntErr"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="secondary" data-c>Cancel</button><button class="primary" data-y>Add note</button></div>`);
    m.querySelector("[data-c]").onclick = () => { m.remove(); resolve(false); };
    m.querySelector("[data-y]").onclick = async (e) => {
      const note = m.querySelector("#ntText").value.trim();
      if (!note) { m.querySelector("#ntErr").innerHTML = `<div class="banner err">Write the note first.</div>`; return; }
      e.target.disabled = true;
      try {
        await api(`/incidents/${n.id}/notes`, { method: "POST", body: { client_id: clientId, note } });
        m.remove();
        toast("Note added ✓");
        resolve(true);
      } catch (err) {
        e.target.disabled = false;
        m.querySelector("#ntErr").innerHTML = `<div class="banner err">${esc(err.status === 0 ? "No signal, so the note wasn't saved. Try again with signal." : err.message)}</div>`;
      }
    };
  });
}

export async function render(app, id) {
  const nav = state.nav;
  setHeader({ title: "Incident report", back: "#/incidents" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let n;
  try {
    n = await api(`/incidents/${id}`);
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  if (n.unread) api(`/incidents/${n.id}/read`, { method: "POST", body: {} }).catch(() => {});
  setHeader({ title: `${n.truck_code} · ${fmtDate(n.incident_date)}`, sub: "Incident report", back: `#/truck/${n.vehicle_id}` });

  const si = n.state_info;
  const photo = (p, tag = "") => `<div class="ph" data-lb="${p.id}" data-cap="${esc([tag, p.caption].filter(Boolean).join(" — "))}" style="cursor:zoom-in">
    <img src="/api/photos/${esc(p.id)}" alt="" loading="lazy">${tag ? `<span class="tag">${esc(tag)}</span>` : ""}${p.caption ? `<div class="cap">${esc(p.caption)}</div>` : ""}</div>`;
  const markName = (m) => `${m.diagram === "trailer" ? "Trailer damage" : "Damage"} ${m.seq}`;
  const marks = new Map(n.damage.map((m) => [m.id, m]));
  let h = "";
  if (n.state === "archived") {
    h += `<div class="banner info"><b>Archived</b> ${fmtDate(si?.changed_at)}${si?.changed_by_name ? ` by ${esc(si.changed_by_name)}` : ""}${si?.reason ? `: ${esc(si.reason)}` : ""}.
      It's hidden from the lists, and its damage is off ${esc(n.truck_code)}'s page. It still exports to PDF.</div>`;
  } else if (n.state === "deleted") {
    h += `<div class="banner err"><b>Deleted</b> ${fmtDate(si?.changed_at)}${si?.changed_by_name ? ` by ${esc(si.changed_by_name)}` : ""}${si?.reason ? `: ${esc(si.reason)}` : ""}.
      It's in Admin → Trash: it can be restored there, or deleted forever ${fmtDate(new Date(new Date(si?.changed_at).getTime() + 7 * 864e5).toISOString())} or later.</div>`;
  }
  const where = [n.location_name, n.street, [n.city, n.address_state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  h += `<div class="card" style="margin-top:14px">${kv([
    ["Truck", `<a href="#/truck/${n.vehicle_id}"><b>${esc(n.truck_code)}</b></a> ${esc(vehicleInfo(n))}${n.plate ? ` · ${esc(n.plate)}` : ""}`, true],
    ["When", `${fmtDate(n.incident_date)}${n.incident_time ? ` · ${clock(n.incident_time)}` : ""}`],
    ["Where", where],
    ["Driver", n.driver_name],
    ["Also involved", [n.property_damage ? "Other property damaged" : "", n.theft_vandalism ? "Theft or vandalism" : ""].filter(Boolean).join(", ")],
    ["Injuries", n.anyone_injured ? `<span class="pill bad">Yes</span>${n.employee_injured ? ` <span class="pill bad">Our employee</span>` : ""}` : "None", true],
    ["Filed by", `${n.reporter_name} · ${fmtDate(n.created_at)}`],
  ])}
    <div class="row" style="margin-top:12px"><a class="primary" style="flex:1" href="/api/incidents/${esc(n.id)}/pdf" download>Download PDF</a>
      <button class="secondary" style="flex:1" id="addNote">Add a note</button></div>
    <p class="small muted" style="margin:8px 0 0">The PDF is the incident packet filled in${n.employee_injured ? ", with the injury forms to finish by hand" : ""}. Blank lines are for what the app doesn't keep.</p></div>`;

  if (n.notes.length) {
    h += `<h2>Notes added since (${n.notes.length})</h2><div class="card"><ul class="repairlist">${n.notes.map((x) => `<li>
      <div style="white-space:pre-wrap">${esc(x.note)}</div><div class="small muted">${esc(x.created_by_name)} · ${fmtDate(x.created_at)}</div></li>`).join("")}</ul></div>`;
  }

  h += `<h2>What happened</h2><div class="card" style="white-space:pre-wrap">${esc(n.description)}</div>`;

  // Damage: each mark, with its photos and whether it's been repaired.
  const dia = (url, list) => `<div class="diagram ro"><img src="${esc(url)}" alt="">${list.map((m) => `<span class="pin${m.repair_id ? " hist" : ""}" style="left:${m.x * 100}%;top:${m.y * 100}%">${m.seq}</span>`).join("")}</div>`;
  const legend = (list) => `<ul class="dmglist">${list.map((m) => `<li><span class="ofn">${m.seq}</span><div class="grow"><b>${esc(m.note || "(no description)")}</b>
      ${m.repair_id ? `<div class="small" style="color:var(--ok)">✓ Repaired ${fmtDate(m.repaired_at)}${m.repaired_by_name ? ` by ${esc(m.repaired_by_name)}` : ""}${
        m.service_log_id ? ` · <a href="#/service/${m.service_log_id}">maintenance entry</a>` : ""}</div>` : n.state === "active" ? `<div class="small muted">On ${esc(n.truck_code)}'s repairs until it's fixed</div>` : ""}
      ${n.photos.some((p) => p.damage_mark_id === m.id) ? `<div class="row" style="margin-top:4px">${n.photos.filter((p) => p.damage_mark_id === m.id).map((p) =>
        `<img class="dmgthumb" src="/api/photos/${esc(p.id)}" data-lb="${p.id}" data-cap="${esc([markName(m), p.caption].filter(Boolean).join(" — "))}" alt="">`).join("")}</div>` : ""}</div></li>`).join("")}</ul>`;
  const truckMarks = n.damage.filter((m) => m.diagram === "truck");
  const trailerMarks = n.damage.filter((m) => m.diagram === "trailer");
  h += `<h2>Our truck</h2><div class="card">${kv([
    ["Drivable", YN(n.drivable)], ["Towed to", n.towed_to], ["Damage", n.damage_gc],
    ["Trailer", n.trailer_number_text || (n.trailer_diagram_url && trailerMarks.length ? "Yes" : "")],
  ], n.damage.length ? "" : undefined)}
    ${truckMarks.length ? `<div class="subhead">Truck damage</div>${n.truck_diagram_url ? dia(n.truck_diagram_url, truckMarks) : ""}${legend(truckMarks)}` : ""}
    ${trailerMarks.length ? `<div class="subhead">Trailer damage${n.trailer_type ? ` (${esc(n.trailer_type)})` : ""}</div>${n.trailer_diagram_url ? dia(n.trailer_diagram_url, trailerMarks) : ""}${legend(trailerMarks)}` : ""}
    ${!n.damage.length ? `<p class="small muted" style="margin:10px 0 0">No damage marked on the picture.</p>` : ""}</div>`;

  h += `<h2>Where</h2><div class="card">${kv([
    ["Location", n.location_name], ["On a job", n.on_job === true ? `Yes${n.site_name ? `: ${n.site_name}` : ""}` : YN(n.on_job)],
    ["Street", n.street], ["City", [n.city, n.address_state, n.zip].filter(Boolean).join(" ")], ["Weather", n.weather],
    ["GPS", n.latitude != null ? `<a href="https://www.google.com/maps?q=${n.latitude},${n.longitude}" target="_blank" rel="noopener">${Number(n.latitude).toFixed(5)}, ${Number(n.longitude).toFixed(5)}</a>${
      n.location_accuracy_m != null ? ` <span class="small muted">±${n.location_accuracy_m} m</span>` : ""}` : "", true],
  ])}</div>`;

  h += `<h2>Driver</h2><div class="card">${kv([
    ["Driver", n.driver_name], ["Manager", n.employee_manager], ["Department", n.department],
    ["Passengers", n.passengers ? `Yes${n.passenger_names ? `: ${n.passenger_names}` : ""}` : YN(n.passengers)],
    ["Seatbelt", YN(n.seatbelt_driver)], ["Passenger seatbelts", YN(n.seatbelt_passenger)],
  ])}</div>`;

  h += `<h2>Police</h2><div class="card">${kv([
    ["At the scene", YN(n.police_present)], ["Department", n.police_department], ["Phone", n.police_phone], ["Officer", n.officer_name],
    ["Report no.", n.police_report_no], ["Our driver cited", YN(n.citation_driver)], ["Other party cited", YN(n.citation_other)],
  ])}</div>`;

  h += `<h2>Injuries</h2><div class="card">${kv([
    ["Anyone injured", YN(n.anyone_injured)], ["Injuries", n.injury_description], ["Our employee hurt", n.anyone_injured ? YN(n.employee_injured) : ""],
    ["Medical evaluation", n.medical_evaluation === true ? `Yes${n.medical_clinic ? `: ${n.medical_clinic}` : ""}` : YN(n.medical_evaluation)],
    ["Drug & alcohol test", n.ad_test === true ? `Yes${n.ad_clinic ? `: ${n.ad_clinic}` : ""}` : YN(n.ad_test)],
  ])}</div>`;

  const party = (p) => kv([
    ["Driver", p.name], ["Phone", p.phone], ["Address", [p.address, p.city, p.state, p.zip].filter(Boolean).join(", ")], ["License no.", p.license_no],
    ["Vehicle", [p.vehicle_year, p.make, p.model].filter(Boolean).join(" ")], ["Plate", [p.plate_state, p.plate_no].filter(Boolean).join(" ")],
    ["Insurance", [p.insurance_company, p.policy_no ? `policy ${p.policy_no}` : "", p.insurance_phone].filter(Boolean).join(" · ")],
    ["Passengers", YN(p.passengers)],
  ]);
  if (n.other_parties.length || n.damage_other || n.other_marks || n.other_appearance) {
    h += `<h2>Other party</h2>${n.other_parties.map((p, i) => `<div class="card">${n.other_parties.length > 1 ? `<div class="subhead" style="margin-top:0">Party ${i + 1}</div>` : ""}${party(p)}</div>`).join("")}
      ${n.damage_other || n.other_marks || n.other_appearance
        ? `<div class="card">${kv([["Their damage", n.damage_other], ["Marks on their vehicle", n.other_marks], ["Appearance / concerns", n.other_appearance]])}</div>` : ""}`;
  }
  if (n.witnesses.length) {
    h += `<h2>Witnesses</h2>${n.witnesses.map((w) => `<div class="card">${kv([
      ["Name", w.name], ["Phone", w.phone], ["Address", [w.address, w.city, w.state, w.zip].filter(Boolean).join(", ")]])}</div>`).join("")}`;
  }

  const map = n.photos.find((p) => p.map);
  if (n.sketch_url || map) {
    h += `<h2>Diagram of the accident</h2><div class="card">
      ${n.sketch_url ? `<img class="sketchimg" src="${esc(n.sketch_url)}" alt="Drawing of the scene" data-lb="sketch" data-src="${esc(n.sketch_url)}">` : ""}
      ${map ? `<div class="photos" style="margin-top:10px">${photo(map, "Map")}</div>` : ""}</div>`;
  }
  const others = n.photos.filter((p) => !p.map);
  if (others.length) {
    h += `<h2>Photos (${others.length})</h2><div class="card"><div class="photos">${others.map((p) =>
      photo(p, p.damage_mark_id && marks.get(p.damage_mark_id) ? markName(marks.get(p.damage_mark_id)) : "")).join("")}</div></div>`;
  }
  if (n.manager_comments || n.preventive_measures) {
    h += `<h2>Manager</h2><div class="card">${kv([["Comments", n.manager_comments], ["Preventive measures", n.preventive_measures]])}</div>`;
  }
  h += `<h2>Signatures</h2><div class="card"><div class="small muted">Driver</div>
    ${n.driver_signature_url ? `<img class="sigimg" src="${esc(n.driver_signature_url)}" alt="Driver signature">` : `<p class="small muted">Not signed in the app: the driver signs the printed form.</p>`}
    <div class="small">${esc(n.driver_name)}</div>
    <div style="border-top:1px solid var(--line);margin:12px 0"></div><div class="small muted">Reporting manager</div>
    <img class="sigimg" src="${esc(n.reporter_signature_url)}" alt="Manager signature"><div class="small">${esc(n.reporter_name)} · ${fmtDate(n.created_at)}</div></div>`;
  h += stateSection(n);
  app.innerHTML = h;

  app.onclick = async (e) => {
    const lb = e.target.closest("[data-lb]");
    if (lb) return lightbox(lb.dataset.src || `/api/photos/${lb.dataset.lb}`, lb.dataset.cap || "");
    if (e.target.closest("#addNote")) {
      if ((await addNote(n)) && !stale(nav)) render(app, id);
      return;
    }
    const st = e.target.closest("[data-state]");
    if (st && (await changeState(n, st.dataset.state)) && !stale(nav)) render(app, id);
  };
}
