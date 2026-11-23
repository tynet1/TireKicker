// Admin: users & PINs, trucks (with trailer type and diagrams), the inspection checklist, branding, and the trash
// (restore, delete forever, move old records in).
import { api } from "../api.js";
import { brandVars, rememberBranding } from "../brand.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { $, confirmBox, esc, fmtDate, modal, shrinkImage, toast, vehicleInfo } from "../util.js";
import { askTrash, TRASH_DAYS } from "./common.js";

const TABS = { users: "Users & PINs", trucks: "Trucks", equipment: "Equipment", checklist: "Checklist", branding: "Branding", trash: "Trash" };
const ROLE_LABELS = {
  crew: "crew (inspections)",
  shop: "shop (maintenance log)",
  supervisor: "supervisor (sign-off)",
  admin: "admin (everything)",
};

export async function render(app, tab = "users", editId = null) {
  const nav = state.nav;
  if (tab === "deleted") tab = "trash"; // the tab's old name, in links and bookmarks
  if (!TABS[tab]) tab = "users";
  setHeader({ title: "Admin", sub: TABS[tab], back: "#/" });
  app.innerHTML = `<div class="tabs">${Object.entries(TABS).map(([k, label]) =>
    `<a href="#/admin/${k}" class="${tab === k ? "on" : ""}">${esc(k === "users" ? "Users" : label)}</a>`).join("")}</div>
    <div id="adm"><div class="empty">Loading…</div></div>`;
  try {
    if (tab === "trucks") await trucksTab(nav, editId);
    else if (tab === "equipment") await equipmentTab(nav, editId);
    else if (tab === "checklist") await checklistTab(nav);
    else if (tab === "branding") await brandingTab(nav);
    else if (tab === "trash") await trashTab(nav);
    else await usersTab(nav);
  } catch (e) {
    if (!stale(nav)) $("#adm").innerHTML = errorHtml(e);
  }
}

// ---------- Checklist ----------

const CHANGE_WORDS = { added: "Added", renamed: "Reworded", moved: "Moved", retired: "Retired", restored: "Restored" };
// Which checklist the tab shows; both are edited the same way.
const CHECKLISTS = {
  truck: { label: "Truck inspection", api: "/admin/checklist", title: "Inspection checklist" },
  yard: { label: "Yard walk", api: "/admin/yard-checklist", title: "Yard walk checklist" },
  equipment: { label: "Equipment", api: "/admin/equipment-checklist", title: "Equipment checklist" },
};
let ckKind = "truck";

/** The inspection checklist: add, reword, reorder, retire and restore items. Changes apply to new inspections only. */
async function checklistTab(nav) {
  const cl = CHECKLISTS[ckKind];
  const data = await api(cl.api);
  if (stale(nav)) return;
  const reload = () => checklistTab(nav);
  const title = Object.fromEntries(data.sections.map((s) => [s.key, s.title]));
  const box = $("#adm");
  let h = `<div class="chips" id="ck-kind" style="margin-top:14px">${Object.entries(CHECKLISTS).map(([k, c]) =>
      `<button type="button" data-kind="${k}" class="${k === ckKind ? "on" : ""}">${esc(c.label)}</button>`).join("")}</div>
    <h2 style="margin:16px 4px 4px">${esc(cl.title)}</h2>
    <p class="small muted" style="margin:0 4px 6px">Changes apply to new inspections. Submitted inspections keep the items and
      wording they had, and a form already open on a phone still sends without the items added after it was opened.</p>`;
  for (const s of data.sections) {
    const live = data.items.filter((it) => it.section === s.key && it.active);
    const retired = data.items.filter((it) => it.section === s.key && !it.active);
    h += `<div class="h2row"><h2>${esc(s.title)} (${live.length})</h2><button class="link" data-add="${s.key}">+ Add item</button></div>
      <div class="card list">${live.length ? live.map((it, n) => `<div class="item ckrow">
          <span class="grow"><b>${n + 1}.</b> ${esc(it.label)}${it.answered ? "" : ` <span class="pill grey">New</span>`}</span>
          <span class="row" style="flex-wrap:nowrap;gap:6px">
            <button class="secondary mv" data-move="up" data-id="${it.id}" aria-label="Move up"${n === 0 ? " disabled" : ""}>↑</button>
            <button class="secondary mv" data-move="down" data-id="${it.id}" aria-label="Move down"${n === live.length - 1 ? " disabled" : ""}>↓</button>
            <button class="secondary" data-edit="${it.id}">Edit</button></span></div>`).join("")
        : `<div class="empty">No items. This section is skipped on the form.</div>`}
        ${retired.length ? `<details class="onfile"><summary>Retired (${retired.length})</summary>${retired.map((it) => `<div class="item ckrow">
            <span class="grow muted">${esc(it.label)}</span><button class="secondary" data-restore="${it.id}">Restore</button></div>`).join("")}</details>` : ""}
      </div>`;
  }
  if (data.changes.length) {
    h += `<details class="onfile" style="margin:6px 4px"><summary>Recent changes (${data.changes.length})</summary><ul class="small" style="padding-left:18px;margin:0 0 12px">${
      data.changes.map((c) => `<li>${fmtDate(c.changed_at)} · ${esc(c.changed_by_name)} · ${CHANGE_WORDS[c.action] || esc(c.action)}
        ${c.action === "renamed" ? `“${esc(c.old_label)}” → “${esc(c.new_label)}”` : `“${esc(c.new_label || c.old_label)}”`}
        <span class="muted">(${esc(title[c.section] || c.section)})</span></li>`).join("")}</ul></details>`;
  }
  box.innerHTML = h;
  box.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => {
    if (b.dataset.kind === ckKind) return;
    ckKind = b.dataset.kind;
    reload();
  }));

  const run = async (b, fn) => {
    b.disabled = true;
    try { await fn(); } catch (e) { toast(e.status === 0 ? "No signal, so nothing changed." : e.message, 4000); }
    if (!stale(nav)) reload();
  };
  box.querySelectorAll("[data-move]").forEach((b) => (b.onclick = () => run(b, () =>
    api(`${cl.api}/${b.dataset.id}/move`, { method: "POST", body: { direction: b.dataset.move } }))));
  box.querySelectorAll("[data-restore]").forEach((b) => (b.onclick = () => run(b, async () => {
    await api(`${cl.api}/${b.dataset.restore}/restore`, { method: "POST", body: {} });
    toast("Restored to the end of its section ✓");
  })));
  box.querySelectorAll("[data-add]").forEach((b) => (b.onclick = async () => {
    if (await checklistItemEditor(null, b.dataset.add, data.sections, cl.api) && !stale(nav)) reload();
  }));
  box.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = async () => {
    const it = data.items.find((x) => String(x.id) === b.dataset.edit);
    if (await checklistItemEditor(it, it.section, data.sections, cl.api) && !stale(nav)) reload();
  }));
}

/** Add an item (item null) or reword / retire one. Resolves true when something changed. */
function checklistItemEditor(item, section, sections, base) {
  return new Promise((resolve) => {
    const m = modal(`<h3>${item ? "Edit checklist item" : "Add checklist item"}</h3>
      ${item ? `<p class="small muted" style="margin-top:-8px">${esc(sections.find((s) => s.key === section)?.title)} · answered on
        ${item.answered} inspection${item.answered === 1 ? "" : "s"}. Those keep the old wording.</p>`
        : `<label class="f" for="ck-sec">Section</label><select class="t" id="ck-sec">${sections.map((s) =>
          `<option value="${s.key}"${s.key === section ? " selected" : ""}>${esc(s.title)}</option>`).join("")}</select>`}
      <label class="f" for="ck-label">Item</label>
      <input class="t" id="ck-label" maxlength="100" value="${esc(item?.label || "")}" placeholder="e.g. Fire extinguisher charged and tagged">
      <div id="ck-err"></div>
      <div class="row" style="justify-content:space-between;margin-top:14px">
        ${item ? `<button class="secondary danger" data-retire>Retire</button>` : "<span></span>"}
        <span class="row"><button class="secondary" data-c>Cancel</button><button class="primary" data-y>${item ? "Save" : "Add"}</button></span></div>`);
    const input = m.querySelector("#ck-label");
    input.focus();
    const err = (msg) => { m.querySelector("#ck-err").innerHTML = `<div class="banner err">${esc(msg)}</div>`; };
    const done = (changed) => { m.remove(); resolve(changed); };
    m.querySelector("[data-c]").onclick = () => done(false);
    m.querySelector("[data-y]").onclick = async (e) => {
      const label = input.value.trim();
      if (!label) return err("Type the checklist item.");
      if (item && label === item.label) return done(false);
      e.target.disabled = true;
      try {
        if (item) await api(`${base}/${item.id}`, { method: "PATCH", body: { label } });
        else await api(base, { method: "POST", body: { section: m.querySelector("#ck-sec").value, label } });
        toast(item ? "Saved ✓" : "Added at the end of the section ✓");
        done(true);
      } catch (ex) {
        e.target.disabled = false;
        err(ex.status === 0 ? "No signal, so nothing changed." : ex.message);
      }
    };
    const rt = m.querySelector("[data-retire]");
    if (rt) rt.onclick = async () => {
      if (!(await confirmBox(`Retire “${item.label}”? It comes off the form for new inspections. Inspections that already have it keep it, and you can restore it later.`, "Retire", { danger: true }))) return;
      try {
        await api(`${base}/${item.id}/retire`, { method: "POST", body: {} });
        toast("Retired ✓");
        done(true);
      } catch (ex) {
        err(ex.status === 0 ? "No signal, so nothing changed." : ex.message);
      }
    };
  });
}

// ---------- Equipment ----------

/** Trailers and the equipment on them: add, edit, move a piece to another trailer, retire; and how often to check. */
async function equipmentTab(nav, editId) {
  const data = await api("/admin/equipment");
  if (stale(nav)) return;
  const reload = () => equipmentTab(nav, null);
  const trailerName = new Map(data.trailers.map((t) => [t.id, t.trailer_number]));
  const box = $("#adm");
  const live = data.equipment.filter((e) => e.active);
  box.innerHTML = `<div class="card" style="margin-top:14px"><label class="f" for="eqDays">Check each piece every</label>
      <div class="row" style="flex-wrap:nowrap"><input class="t" id="eqDays" inputmode="numeric" pattern="[0-9]*" value="${data.check_days}" style="max-width:110px">
        <span>days</span><button class="secondary" id="eqDaysSave">Save</button></div></div>
    <div class="spread" style="margin:16px 4px 8px"><h2 style="margin:0">Trailers (${data.trailers.filter((t) => t.active).length})</h2>
      <button class="primary" id="addTrailer">+ Add trailer</button></div>
    <div class="card list">${data.trailers.length ? data.trailers.map((t) => `<button class="item" data-trl="${t.id}">
      <span class="grow"><b>${esc(t.trailer_number)}</b>${t.name ? ` ${esc(t.name)}` : ""}<span class="small muted clip">${esc(t.plate || "no plate")} ·
        ${((n) => `${n} piece${n === 1 ? "" : "s"}`)(live.filter((e) => e.trailer_id === t.id).length)}</span></span>${t.active ? "" : `<span class="pill bad">Retired</span>`}</button>`).join("")
      : `<div class="empty">No trailers yet.</div>`}</div>
    <div class="spread" style="margin:16px 4px 8px"><h2 style="margin:0">Equipment (${live.length})</h2>
      <button class="primary" id="addEquip">+ Add equipment</button></div>
    <p class="small muted" style="margin:0 4px 10px">Tap a piece to edit it, move it to another trailer or retire it. Every change is kept.</p>
    <div class="card list">${data.equipment.length ? data.equipment.map((e) => `<button class="item" data-eq="${e.id}">
      <span class="grow"><b>${esc(e.tag)}</b> ${esc(e.type_title)}<span class="small muted clip">${esc([e.make, e.model].filter(Boolean).join(" ") || "—")} ·
        ${esc(e.trailer_id ? trailerName.get(e.trailer_id) || "?" : "Not on a trailer")}</span></span>${e.active ? "" : `<span class="pill bad">Retired</span>`}</button>`).join("")
      : `<div class="empty">No equipment yet.</div>`}</div>`;

  $("#eqDaysSave").onclick = async (ev) => {
    ev.target.disabled = true;
    try {
      await api("/admin/equipment-settings", { method: "PUT", body: { check_days: Number($("#eqDays").value) } });
      toast("Saved ✓");
    } catch (e) {
      toast(e.message, 4000);
    }
    ev.target.disabled = false;
  };
  $("#addTrailer").onclick = () => trailerEditor(null, reload);
  $("#addEquip").onclick = () => equipmentEditor(null, data, reload);
  box.querySelectorAll("[data-trl]").forEach((b) => (b.onclick = () => trailerEditor(data.trailers.find((t) => String(t.id) === b.dataset.trl), reload)));
  box.querySelectorAll("[data-eq]").forEach((b) => (b.onclick = () => equipmentEditor(data.equipment.find((e) => String(e.id) === b.dataset.eq), data, reload)));
  if (editId) {
    const e = data.equipment.find((x) => String(x.id) === String(editId));
    if (e) equipmentEditor(e, data, reload);
  }
}

function trailerEditor(t, onSaved) {
  const isNew = !t;
  t = t || { trailer_number: "", name: "", plate: "", notes: "", active: true };
  const m = modal(`<h3>${isNew ? "Add trailer" : `Edit ${esc(t.trailer_number)}`}</h3>
    <div class="fields">
      <div><label class="f" for="tr-num">Trailer number</label><input class="t" id="tr-num" maxlength="30" value="${esc(t.trailer_number)}" autocapitalize="characters" placeholder="e.g. T-03"></div>
      <div><label class="f" for="tr-plate">Plate</label><input class="t" id="tr-plate" maxlength="20" value="${esc(t.plate || "")}" autocapitalize="characters"></div>
    </div>
    <label class="f" for="tr-name">Description <span class="muted">(optional)</span></label><input class="t" id="tr-name" maxlength="80" value="${esc(t.name || "")}" placeholder="e.g. 16 ft landscape trailer">
    <label class="f" for="tr-notes">Notes <span class="muted">(optional)</span></label><textarea class="t" id="tr-notes" maxlength="1000">${esc(t.notes || "")}</textarea>
    ${isNew ? "" : `<div class="toggle"><div><b>In use</b><div class="small muted">Retire a trailer once its equipment is moved off; its history is kept</div></div>
      <button type="button" class="sw ${t.active ? "on" : ""}" id="tr-active" role="switch" aria-label="In use"></button></div>`}
    <div id="tr-err"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="secondary" data-c>Cancel</button><button class="primary" data-y>Save</button></div>`);
  const act = m.querySelector("#tr-active");
  if (act) act.onclick = () => act.classList.toggle("on");
  m.querySelector("[data-c]").onclick = () => m.remove();
  m.querySelector("[data-y]").onclick = async (ev) => {
    const body = {
      trailer_number: m.querySelector("#tr-num").value.trim(), plate: m.querySelector("#tr-plate").value.trim() || null,
      name: m.querySelector("#tr-name").value.trim() || null, notes: m.querySelector("#tr-notes").value.trim() || null,
      ...(act ? { active: act.classList.contains("on") } : {}),
    };
    if (!body.trailer_number) return void (m.querySelector("#tr-err").innerHTML = `<div class="banner err">Type the trailer number.</div>`);
    ev.target.disabled = true;
    try {
      await api(isNew ? "/admin/trailers" : `/admin/trailers/${t.id}`, { method: isNew ? "POST" : "PATCH", body });
      m.remove();
      toast("Saved ✓");
      onSaved();
    } catch (e) {
      ev.target.disabled = false;
      m.querySelector("#tr-err").innerHTML = `<div class="banner err">${esc(e.status === 0 ? "No signal, so nothing changed." : e.message)}</div>`;
    }
  };
}

function equipmentEditor(e, data, onSaved) {
  const isNew = !e;
  e = e || { tag: "", type: "", make: "", model: "", serial: "", trailer_id: null, notes: "", active: true };
  const m = modal(`<h3>${isNew ? "Add equipment" : `Edit ${esc(e.tag)}`}</h3>
    <div class="fields">
      <div><label class="f" for="eq-tag">Tag</label><input class="t" id="eq-tag" maxlength="30" value="${esc(e.tag)}" autocapitalize="characters" placeholder="e.g. ST-07"></div>
      <div><label class="f" for="eq-type">Kind</label><select class="t" id="eq-type"><option value="">Pick…</option>${data.types.map((t) =>
        `<option value="${t.key}"${t.key === e.type ? " selected" : ""}>${esc(t.title)}</option>`).join("")}</select></div>
      <div><label class="f" for="eq-make">Make</label><input class="t" id="eq-make" maxlength="60" value="${esc(e.make || "")}" placeholder="e.g. Stihl"></div>
      <div><label class="f" for="eq-model">Model</label><input class="t" id="eq-model" maxlength="60" value="${esc(e.model || "")}" placeholder="e.g. FS 91 R"></div>
      <div><label class="f" for="eq-serial">Serial number</label><input class="t" id="eq-serial" maxlength="60" value="${esc(e.serial || "")}"></div>
      <div><label class="f" for="eq-trl">Trailer</label><select class="t" id="eq-trl"><option value="">Not on a trailer</option>${data.trailers.filter((t) => t.active || t.id === e.trailer_id).map((t) =>
        `<option value="${t.id}"${t.id === e.trailer_id ? " selected" : ""}>${esc(t.trailer_number)}${t.name ? ` · ${esc(t.name)}` : ""}</option>`).join("")}</select></div>
    </div>
    <label class="f" for="eq-notes">Notes <span class="muted">(optional)</span></label><textarea class="t" id="eq-notes" maxlength="1000">${esc(e.notes || "")}</textarea>
    ${isNew ? "" : `<div class="toggle"><div><b>In use</b><div class="small muted">Retired equipment drops off the trailers and checks; its history is kept</div></div>
      <button type="button" class="sw ${e.active ? "on" : ""}" id="eq-active" role="switch" aria-label="In use"></button></div>`}
    <div id="eq-err"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="secondary" data-c>Cancel</button><button class="primary" data-y>Save</button></div>`);
  const act = m.querySelector("#eq-active");
  if (act) act.onclick = () => act.classList.toggle("on");
  m.querySelector("[data-c]").onclick = () => m.remove();
  m.querySelector("[data-y]").onclick = async (ev) => {
    const val = (id) => m.querySelector(id).value.trim() || null;
    const body = {
      tag: m.querySelector("#eq-tag").value.trim(), type: m.querySelector("#eq-type").value,
      make: val("#eq-make"), model: val("#eq-model"), serial: val("#eq-serial"), notes: val("#eq-notes"),
      trailer_id: m.querySelector("#eq-trl").value ? Number(m.querySelector("#eq-trl").value) : null,
      ...(act ? { active: act.classList.contains("on") } : {}),
    };
    const err = (msg) => { m.querySelector("#eq-err").innerHTML = `<div class="banner err">${esc(msg)}</div>`; };
    if (!body.tag) return err("Type the tag on the piece.");
    if (!body.type) return err("Pick what kind of equipment it is.");
    ev.target.disabled = true;
    try {
      await api(isNew ? "/admin/equipment" : `/admin/equipment/${e.id}`, { method: isNew ? "POST" : "PATCH", body });
      m.remove();
      toast("Saved ✓");
      if (location.hash.includes("?edit=")) history.replaceState(null, "", "#/admin/equipment");
      onSaved();
    } catch (ex) {
      ev.target.disabled = false;
      err(ex.status === 0 ? "No signal, so nothing changed." : ex.message);
    }
  };
}

// ---------- Trash ----------

let trashKind = "all";
const KIND_PLURAL = {
  inspection: "Inspections", incident: "Incident reports", yard_walk: "Yard walks", equipment_check: "Equipment checks",
  service_log: "Maintenance", equipment_service: "Equipment maintenance", repair_ticket: "Tickets", vehicle: "Trucks", user: "Users",
};
const ONE = {
  photos: "photo", "damage marks": "damage mark", "checklist answers": "checklist answer", signatures: "signature", notes: "note",
  sketches: "sketch", "damage repairs": "damage repair", "repairs listed": "repair listed", "earlier versions": "earlier version",
  "problems listed": "problem listed", "pieces checked": "piece checked", "registration updates": "registration update",
  "status changes": "status change",
};
const counted = (removed) => Object.entries(removed || {}).map(([k, n]) => `${n} ${n === 1 ? ONE[k] || k : k}`);

/**
 * Everything deleted waits here: restore it, or once it has been here TRASH_DAYS days, delete it forever. Also moves
 * old records in by date, and lists what has been deleted forever.
 */
async function trashTab(nav) {
  const [data, log] = await Promise.all([api("/admin/trash"), api("/admin/purge-log").catch(() => [])]);
  if (stale(nav)) return;
  const reload = () => trashTab(nav);
  const byKind = new Map();
  for (const it of data.items) byKind.set(it.kind, (byKind.get(it.kind) || 0) + 1);
  if (trashKind !== "all" && !byKind.has(trashKind)) trashKind = "all";
  const shown = data.items.filter((it) => trashKind === "all" || it.kind === trashKind);
  const box = $("#adm");
  box.innerHTML = `<div class="card" style="margin-top:14px">
      <p class="small muted" style="margin:0">Deleted records wait here, out of every list. <b>Restore</b> puts one back as it was.
        After ${TRASH_DAYS} days in the trash an admin can <b>delete it forever</b>: the record, its photos and signatures are
        erased, and only a line in the log below says it existed. Nightly backups still hold it for up to 30 more days.</p>
      <div class="row" style="margin-top:12px">
        <button class="secondary" id="trOld">Move old records to the trash</button>
        ${data.ready ? `<button class="secondary danger" id="trAll">Delete forever all ready (${data.ready})</button>` : ""}</div></div>
    ${byKind.size > 1 ? `<div class="chips" id="trKinds">${[["all", `All (${data.items.length})`], ...[...byKind].map(([k, n]) => [k, `${KIND_PLURAL[k] || k} (${n})`])]
      .map(([k, label]) => `<button type="button" data-kind="${k}" class="${k === trashKind ? "on" : ""}">${esc(label)}</button>`).join("")}</div>` : ""}
    <h2>In the trash (${data.total})</h2>
    <div class="card list">${shown.length ? shown.map((it, n) => `<div class="item" style="align-items:flex-start">
      <span class="grow">${it.link ? `<a href="${esc(it.link)}" style="display:inline-flex;align-items:center;min-height:44px"><b>${esc(it.title)}</b></a>`
          : `<b style="display:inline-flex;align-items:center;min-height:44px">${esc(it.kind === "user" ? `${it.name} (user)` : it.title)}</b>`}
        <span class="small muted" style="display:block">${[it.record_date ? fmtDate(it.record_date) : "", it.who, it.about].filter(Boolean).map(esc).join(" · ")}</span>
        <span class="small muted" style="display:block">Deleted ${fmtDate(it.deleted_at)} by ${esc(it.deleted_by_name)}</span>
        <span class="small" style="display:block">${esc(it.reason)}</span></span>
      <span class="btncol"><button class="secondary" data-restore="${n}">Restore</button>
        ${it.ready ? `<button class="secondary danger" data-purge="${n}">Delete forever</button>`
          : `<span class="small muted" style="text-align:center;max-width:120px">Delete forever from ${fmtDate(it.ready_at)}</span>`}</span></div>`).join("")
      : `<div class="empty">The trash is empty.</div>`}</div>
    ${data.total > data.items.length ? `<p class="small muted">Showing the newest ${data.items.length} of ${data.total}.</p>` : ""}
    <details class="onfile" style="margin:6px 4px"><summary>Deleted forever (${log.length})</summary>
      ${log.length ? `<ul class="repairlist small">${log.map((l) => `<li><b>${esc(l.title)}</b>${l.record_date ? ` · ${fmtDate(l.record_date)}` : ""}
        <div class="muted">Deleted forever ${fmtDate(l.purged_at)} by ${esc(l.purged_by_name)} · in the trash since ${fmtDate(l.deleted_at)}${l.deleted_by_name ? ` (${esc(l.deleted_by_name)})` : ""}</div>
        <div>${esc(l.reason)}</div>${counted(l.removed).length ? `<div class="muted">Removed: ${esc(counted(l.removed).join(", "))}</div>` : ""}</li>`).join("")}</ul>`
        : `<p class="small muted">Nothing has been deleted forever.</p>`}</details>`;

  box.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => { trashKind = b.dataset.kind; reload(); }));
  box.querySelectorAll("[data-restore]").forEach((b) => (b.onclick = async () => {
    const it = shown[Number(b.dataset.restore)];
    const back = it.kind === "vehicle" ? " It comes back retired." : it.kind === "user" ? " They come back inactive."
      : ["service_log", "equipment_service", "repair_ticket"].includes(it.kind) ? " It comes back voided." : "";
    if (!(await confirmBox(`Restore ${it.kind === "user" ? it.name : it.title}? It goes back in the lists.${back}`, "Restore"))) return;
    b.disabled = true;
    try {
      await api("/admin/trash/restore", { method: "POST", body: { kind: it.kind, id: it.id } });
      toast("Restored ✓");
    } catch (e) {
      toast(e.status === 0 ? "No signal, so nothing changed." : e.message, 4000);
    }
    if (!stale(nav)) reload();
  }));
  box.querySelectorAll("[data-purge]").forEach((b) => (b.onclick = () => purgeOne(shown[Number(b.dataset.purge)], reload)));
  $("#trOld").onclick = () => oldRecords(reload);
  const all = $("#trAll");
  if (all) all.onclick = () => purgeReady(data.ready, reload);
}

/** Delete one record forever: shows what goes (worked out by the server), then asks for the truck number typed. */
async function purgeOne(it, onDone) {
  const m = modal(`<h3>Delete forever?</h3><p><span class="spinner"></span> Working out what goes…</p>`);
  const sheet = m.querySelector(".sheet");
  let pv;
  try {
    pv = await api("/admin/trash/preview", { method: "POST", body: { kind: it.kind, id: it.id } });
  } catch (e) {
    sheet.innerHTML = `<h3>Can't delete it forever</h3><div class="banner err">${esc(e.status === 0 ? "No signal. Try again when you have signal." : e.message)}</div>
      <div class="row" style="justify-content:flex-end"><button class="secondary" data-c>Close</button></div>`;
    sheet.querySelector("[data-c]").onclick = () => m.remove();
    return;
  }
  const name = it.kind === "user" ? `${it.name} (user)` : it.title;
  const gone = counted(pv.removed);
  sheet.innerHTML = `<h3>Delete ${esc(name)} forever?</h3>
    <p class="muted" style="margin-top:-6px">This can't be undone from the app.</p>
    <p style="margin:0 0 6px"><b>Erased for good:</b> the ${esc(it.label.toLowerCase())}${gone.length ? `, ${esc(gone.join(", "))}` : ""}${
      pv.files ? ` (${pv.files} file${pv.files === 1 ? "" : "s"})` : ""}.</p>
    ${pv.notes.map((x) => `<p class="small" style="margin:0 0 6px">${esc(x)}</p>`).join("")}
    <p class="small muted">Kept: a line in the log saying what it was, which truck, why, who and when, but none of what it said.
      Nightly backups still hold it for up to 30 days.</p>
    <label class="f" for="pvC">Type <b>${esc(it.confirm)}</b> to confirm</label>
    <input class="t" id="pvC" autocomplete="off" autocapitalize="characters" spellcheck="false">
    <div id="pvE"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="secondary" data-c>Cancel</button>
      <button class="primary btn-danger" data-y disabled>Delete forever</button></div>`;
  const input = sheet.querySelector("#pvC");
  const go = sheet.querySelector("[data-y]");
  input.focus();
  input.oninput = () => { go.disabled = input.value.trim().toUpperCase() !== it.confirm.toUpperCase(); };
  sheet.querySelector("[data-c]").onclick = () => m.remove();
  go.onclick = async () => {
    go.disabled = true;
    try {
      await api("/admin/trash/purge", { method: "POST", body: { kind: it.kind, id: it.id, confirm: input.value.trim() }, timeout: 60000 });
      m.remove();
      toast("Deleted forever");
      onDone();
    } catch (e) {
      go.disabled = false;
      sheet.querySelector("#pvE").innerHTML = `<div class="banner err">${esc(e.status === 0 ? "No signal, so nothing was deleted." : e.message)}</div>`;
    }
  };
}

/** Delete forever everything that has been in the trash long enough, a batch at a time, after the count is typed. */
function purgeReady(n, onDone) {
  const m = modal(`<h3>Delete forever all ${n} ready?</h3>
    <p class="muted" style="margin-top:-6px">Everything that has been in the trash ${TRASH_DAYS} days or more. Their records, photos
      and signatures are erased for good; the log keeps a line for each. This can't be undone from the app.</p>
    <label class="f" for="paC">Type <b>${n}</b> to confirm</label>
    <input class="t" id="paC" inputmode="numeric" pattern="[0-9]*" autocomplete="off">
    <div id="paE"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="secondary" data-c>Cancel</button>
      <button class="primary btn-danger" data-y disabled>Delete forever</button></div>`);
  const sheet = m.querySelector(".sheet");
  const input = sheet.querySelector("#paC");
  const go = sheet.querySelector("[data-y]");
  input.focus();
  input.oninput = () => { go.disabled = input.value.trim() !== String(n); };
  sheet.querySelector("[data-c]").onclick = () => m.remove();
  go.onclick = async () => {
    go.disabled = true;
    sheet.querySelector("[data-c]").disabled = true;
    const err = (msg) => { sheet.querySelector("#paE").innerHTML = `<div class="banner err">${esc(msg)}</div>`; };
    let done = 0;
    const failed = [];
    let first = true;
    try {
      for (;;) {
        go.innerHTML = `<span class="spinner"></span>&nbsp; ${done} of ${n}…`;
        const r = await api("/admin/trash/purge-ready", {
          method: "POST", timeout: 90000,
          body: first ? { confirm: n } : { more: true, skip: failed.map((f) => `${f.kind}:${f.id}`) },
        });
        first = false;
        done += r.purged;
        failed.push(...r.failed);
        if (!r.remaining || (!r.purged && !r.failed.length)) break;
      }
    } catch (e) {
      err(e.status === 0 ? `Signal lost after ${done} were deleted. Open the trash again to see what's left.` : e.message);
      sheet.querySelector("[data-c]").disabled = false;
      sheet.querySelector("[data-c]").textContent = "Close";
      sheet.querySelector("[data-c]").onclick = () => { m.remove(); onDone(); };
      go.hidden = true;
      return;
    }
    sheet.innerHTML = `<h3>${done} deleted forever</h3>${failed.length ? `<div class="banner err">${failed.length} couldn't be:
        <ul>${failed.map((f) => `<li>${esc(f.title)}: ${esc(f.error)}</li>`).join("")}</ul></div>` : ""}
      <div class="row" style="justify-content:flex-end"><button class="primary" data-c>Done</button></div>`;
    sheet.querySelector("[data-c]").onclick = () => { m.remove(); onDone(); };
  };
}

const OLD_KINDS = [["inspection", "Inspections"], ["incident", "Incident reports"], ["yard_walk", "Yard walks"],
  ["equipment_check", "Equipment checks"], ["service_log", "Maintenance entries"], ["equipment_service", "Equipment maintenance"],
  ["repair_ticket", "Repair tickets"]];

/** Move every record dated before a day to the trash (they can still be restored). */
function oldRecords(onDone) {
  const m = modal(`<h3>Move old records to the trash</h3>
    <p class="small muted" style="margin-top:-6px">Everything you tick that's dated before the day you pick goes in the trash, where it
      can still be restored. After ${TRASH_DAYS} days it can be deleted forever from here. Maintenance entries and tickets are voided
      as they go in, but repairs they fixed stay fixed.</p>
    <label class="f" for="odDate">Dated before</label><input class="t" id="odDate" type="date">
    <div id="odKinds" style="margin-top:8px">${OLD_KINDS.map(([k, label]) => `<label class="pick"><input type="checkbox" data-k="${k}" checked>
      <span class="grow">${esc(label)} <span class="muted" data-n="${k}"></span></span></label>`).join("")}</div>
    <label class="f" for="odWhy">Why?</label>
    <textarea class="t" id="odWhy" maxlength="500" placeholder="e.g. Older than we keep records (3 years)"></textarea>
    <label class="f" for="odC" style="margin-top:12px">Type how many (<b id="odTotal">0</b>) to confirm</label>
    <input class="t" id="odC" inputmode="numeric" pattern="[0-9]*" autocomplete="off">
    <div id="odE"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="secondary" data-c>Cancel</button>
      <button class="primary btn-danger" data-y disabled>Move to the trash</button></div>`);
  const $m = (s) => m.querySelector(s);
  let counts = null;
  const total = () => counts ? OLD_KINDS.filter(([k]) => $m(`[data-k="${k}"]`).checked).reduce((a, [k]) => a + (counts[k] || 0), 0) : 0;
  const refresh = () => {
    $m("#odTotal").textContent = String(total());
    $m("[data-y]").disabled = !counts || !total() || $m("#odC").value.trim() !== String(total());
  };
  $m("#odDate").onchange = async () => {
    const before = $m("#odDate").value;
    counts = null;
    m.querySelectorAll("[data-n]").forEach((s) => (s.textContent = before ? "…" : ""));
    refresh();
    if (!before) return;
    try {
      const r = await api(`/admin/old-records?before=${encodeURIComponent(before)}&kinds=${OLD_KINDS.map(([k]) => k).join(",")}`);
      if ($m("#odDate").value !== before) return;
      counts = r.counts;
      m.querySelectorAll("[data-n]").forEach((s) => (s.textContent = `(${counts[s.dataset.n] ?? 0})`));
      $m("#odE").innerHTML = "";
    } catch (e) {
      $m("#odE").innerHTML = `<div class="banner err">${esc(e.status === 0 ? "No signal." : e.message)}</div>`;
    }
    refresh();
  };
  m.querySelectorAll("[data-k]").forEach((c) => (c.onchange = refresh));
  $m("#odC").oninput = refresh;
  $m("[data-c]").onclick = () => m.remove();
  $m("[data-y]").onclick = async (e) => {
    const reason = $m("#odWhy").value.trim();
    if (!reason) return void ($m("#odE").innerHTML = `<div class="banner err">Say why they're being deleted.</div>`);
    e.target.disabled = true;
    try {
      const r = await api("/admin/old-records/trash", {
        method: "POST", timeout: 120000,
        body: { before: $m("#odDate").value, kinds: OLD_KINDS.map(([k]) => k).filter((k) => $m(`[data-k="${k}"]`).checked),
          reason, confirm: Number($m("#odC").value.trim()) },
      });
      m.remove();
      toast(`${r.total} moved to the trash ✓`);
      onDone();
    } catch (ex) {
      e.target.disabled = false;
      $m("#odE").innerHTML = `<div class="banner err">${esc(ex.status === 0 ? "No signal, so nothing changed." : ex.message)}</div>`;
    }
  };
}

// ---------- Users ----------

async function usersTab(nav) {
  const users = await api("/admin/users");
  if (stale(nav)) return;
  const box = $("#adm");
  box.innerHTML = `<div class="spread" style="margin:16px 4px 8px"><h2 style="margin:0">Users (${users.length})</h2>
      <button class="primary" id="addUser">+ Add user</button></div>
    <div class="card list">${users.map((u) => `<button class="item" data-user="${u.id}">
      <span><b>${esc(u.name)}</b>${u.email ? `<br><span class="small muted">${esc(u.email)}</span>` : ""}</span>
      <span class="row" style="justify-content:flex-end">
        <span class="pill ${u.role === "crew" ? "grey" : ""}">${esc(u.role)}</span>
        ${u.has_pin ? `<span class="pill grey">PIN</span>` : ""}
        ${u.locked ? `<span class="pill bad">Locked</span>` : ""}
        ${u.active ? "" : `<span class="pill bad">Inactive</span>`}
      </span></button>`).join("") || `<div class="empty">No users.</div>`}</div>
    <p class="small muted">Anyone with a PIN signs in by picking their name and entering it (crew, and usually the shop manager).
      Supervisors and admins sign in with email and password. The shop role can log maintenance and close repairs, but can't sign off inspections.
      Too many wrong tries locks an account for 15 minutes; setting a new PIN or password unlocks it.</p>`;
  $("#addUser").onclick = () => userEditor(null, () => usersTab(nav));
  box.querySelectorAll("[data-user]").forEach((b) => (b.onclick = () => userEditor(users.find((u) => u.id === Number(b.dataset.user)), () => usersTab(nav))));
}

function userEditor(u, onSaved) {
  const isNew = !u;
  u = u || { name: "", email: "", role: "crew", active: true };
  const m = modal(`<h3>${isNew ? "Add user" : `Edit ${esc(u.name)}`}</h3>
    <div class="fields">
      <div><label class="f" for="uName">Name (as crew will see it)</label><input class="t" id="uName" value="${esc(u.name)}" autocomplete="off"></div>
      <div><label class="f" for="uRole">Role</label><select class="t" id="uRole">
        ${Object.entries(ROLE_LABELS).map(([r, label]) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></div>
      <div><label class="f" for="uPin">${isNew ? "PIN (4–6 digits)" : `New PIN${u.has_pin ? " (blank = keep)" : ""}`}</label>
        <input class="t" id="uPin" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off"></div>
      <div><label class="f" for="uEmail">Email (supervisor/admin)</label><input class="t" id="uEmail" type="email" value="${esc(u.email || "")}" autocomplete="off" autocapitalize="off"></div>
      <div><label class="f" for="uPw">${isNew ? "Password (10+ characters)" : `New password${u.has_password ? " (blank = keep)" : ""}`}</label>
        <input class="t" id="uPw" type="password" autocomplete="new-password"></div>
    </div>
    ${isNew ? "" : `<div class="toggle" style="margin:14px 0"><div><b>Active</b><div class="small muted">Inactive users can't sign in</div></div>
      <button type="button" class="sw ${u.active ? "on" : ""}" id="uActive" role="switch" aria-label="Active"></button></div>`}
    ${u.locked ? `<div class="banner info">Locked after too many wrong tries. Set a new PIN or password to unlock now.</div>` : ""}
    ${!isNew && !u.active && u.id !== state.user?.id ? `<div class="small muted" style="margin-top:12px">Someone who never did anything in the app
      (a test user, one added by mistake) can be deleted. Anyone with records stays inactive, so their history is kept.</div>
      <button class="secondary danger" id="uDelete" style="margin-top:8px">Delete ${esc(u.name)}</button>` : ""}
    <div id="uErr"></div>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="secondary" id="uCancel">Cancel</button><button class="primary" id="uSave">Save</button></div>`);
  const act = m.querySelector("#uActive");
  if (act) act.onclick = () => act.classList.toggle("on");
  m.querySelector("#uCancel").onclick = () => m.remove();
  const del = m.querySelector("#uDelete");
  if (del) del.onclick = async () => {
    if (await askTrash("user", u.id, "user")) { m.remove(); onSaved(); }
  };
  m.querySelector("#uSave").onclick = async (e) => {
    const body = {
      name: m.querySelector("#uName").value,
      role: m.querySelector("#uRole").value,
      email: m.querySelector("#uEmail").value,
    };
    const pin = m.querySelector("#uPin").value.trim();
    const pw = m.querySelector("#uPw").value;
    if (pin) body.pin = pin;
    if (pw) body.password = pw;
    if (act) body.active = act.classList.contains("on");
    e.target.disabled = true;
    try {
      if (isNew) await api("/admin/users", { method: "POST", body });
      else await api(`/admin/users/${u.id}`, { method: "PATCH", body });
      m.remove();
      toast(`Saved ${body.name}`);
      onSaved();
    } catch (err) {
      e.target.disabled = false;
      m.querySelector("#uErr").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
    }
  };
}

// ---------- Trucks ----------

async function trucksTab(nav, editId) {
  const [vehicles, diagrams] = await Promise.all([api("/admin/vehicles"), api("/diagrams")]);
  if (stale(nav)) return;
  const box = $("#adm");
  box.innerHTML = `<div class="spread" style="margin:16px 4px 8px"><h2 style="margin:0">Trucks (${vehicles.filter((v) => v.active).length} active)</h2>
      <button class="primary" id="addTruck">+ Add truck</button></div>
    <p class="small muted" style="margin:0 4px 10px">Tap a truck to change its details, registration, trailer or diagram.
      <a href="#/csv?what=trucks">Download CSV</a></p>
    <div class="card list">${vehicles.map((v) => `<button class="item" data-veh="${v.id}">
      <span><b>${esc(v.truck_code)}</b> ${esc(vehicleInfo(v))}<br><span class="small muted">${esc(v.plate || "no plate")} ·
        ${v.pulls_trailer ? `Trailer: ${esc(v.trailer_type || "yes")}` : "No trailer"}</span></span>
      <span class="row" style="justify-content:flex-end">${v.active ? "" : `<span class="pill bad">Retired</span>`}
        ${v.registration_expires ? `<span class="pill ${v.registration_expires < new Date().toISOString().slice(0, 10) ? "bad" : "grey"}">Reg ${fmtDate(v.registration_expires)}</span>` : ""}</span></button>`).join("")}</div>`;
  const reload = () => trucksTab(nav, null);
  $("#addTruck").onclick = () => truckEditor(null, diagrams, reload);
  box.querySelectorAll("[data-veh]").forEach((b) => (b.onclick = () => truckEditor(vehicles.find((v) => v.id === Number(b.dataset.veh)), diagrams, reload)));
  if (editId) {
    const v = vehicles.find((x) => x.id === Number(editId));
    if (v) truckEditor(v, diagrams, reload);
  }
}

/** "Add a new …" block that uploads a diagram of `kind` and selects it. */
function uploadBlock(kind, label, placeholder) {
  return `<details style="margin-top:8px"><summary class="link" style="display:inline-block">${esc(label)}</summary>
    <div class="fields" style="margin-top:8px">
      <div><label class="f" for="${kind}UpName">Name</label><input class="t" id="${kind}UpName" placeholder="${esc(placeholder)}"></div>
      <div><label class="f" for="${kind}UpFile">Picture (top-down drawing or photo)</label><input class="t" id="${kind}UpFile" type="file" accept="image/*"></div>
    </div>
    <button class="secondary" id="${kind}UpGo" style="margin-top:8px">Upload</button></details>`;
}

function truckEditor(v, diagrams, onSaved) {
  const isNew = !v;
  v = v || { truck_code: "", active: true, pulls_trailer: false, diagram_id: null, trailer_diagram_id: null };
  const byKind = (k) => diagrams.filter((x) => x.kind === k);
  const urlOf = (id) => diagrams.find((x) => x.id === Number(id))?.url || "";
  const truckDefault = byKind("truck")[0];
  const m = modal(`<h3>${isNew ? "Add truck" : `Edit ${esc(v.truck_code)}`}</h3>
    <div class="subhead">Truck</div>
    <div class="fields">
      <div><label class="f" for="tCode">Truck ID</label><input class="t" id="tCode" value="${esc(v.truck_code)}" placeholder="T101" autocapitalize="characters"></div>
      <div><label class="f" for="tUnit">Unit</label><input class="t" id="tUnit" value="${esc(v.unit || "")}" autocapitalize="characters"></div>
      <div><label class="f" for="tVin">VIN</label><input class="t" id="tVin" value="${esc(v.vin || "")}" autocapitalize="characters" maxlength="17"></div>
      <div><label class="f" for="tPlate">Plate</label><input class="t" id="tPlate" value="${esc(v.plate || "")}" autocapitalize="characters"></div>
      <div><label class="f" for="tYear">Year</label><input class="t" id="tYear" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${esc(v.year || "")}"></div>
      <div><label class="f" for="tMake">Make</label><input class="t" id="tMake" value="${esc(v.make || "")}"></div>
      <div><label class="f" for="tModel">Model</label><input class="t" id="tModel" value="${esc(v.model || "")}"></div>
      <div><label class="f" for="tExp">Registration expires</label><input class="t" id="tExp" type="date" value="${esc(v.registration_expires || "")}"></div>
    </div>

    <div class="subhead">Trailer</div>
    <label class="f" for="tTrl">Trailer type</label>
    <select class="t" id="tTrl"><option value="">No trailer</option>
      ${byKind("trailer").map((x) => `<option value="${x.id}" ${v.pulls_trailer && x.id === (v.trailer_diagram_id ?? byKind("trailer")[0]?.id) ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
    <div class="small muted" style="margin-top:6px">Trucks with a trailer start each inspection with the trailer &amp; crew checklist on. The crew can still switch it off.</div>
    <img class="thumb" id="tTrlImg" alt="" style="margin-top:8px">
    ${uploadBlock("trailer", "Add a trailer type", "e.g. 16 ft dump trailer")}

    <div class="subhead">Damage diagram</div>
    <label class="f" for="tDia">Body style</label>
    <select class="t" id="tDia"><option value="">Default (${esc(truckDefault?.name || "none")})</option>
      ${byKind("truck").map((x) => `<option value="${x.id}" ${x.id === v.diagram_id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
    <img class="thumb" id="tDiaImg" alt="" style="margin-top:8px">
    ${uploadBlock("truck", "Add a truck diagram", "e.g. 2026 Ram 2500 8ft bed")}

    ${isNew ? "" : `<div class="subhead">Status</div>
      <div class="toggle"><div><b>Active</b><div class="small muted">Retired trucks are hidden from crews; their history is kept</div></div>
      <button type="button" class="sw ${v.active ? "on" : ""}" id="tActive" role="switch" aria-label="Active"></button></div>
      ${v.active ? "" : `<div class="small muted" style="margin-top:12px">A retired truck with nothing on file (no inspections, reports,
        maintenance or tickets), such as one added by mistake, can be deleted. Any other stays retired, with its history.</div>
        <button class="secondary danger" id="tDelete" style="margin-top:8px">Delete ${esc(v.truck_code)}</button>`}`}
    <div id="tErr"></div>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="secondary" id="tCancel">Cancel</button><button class="primary" id="tSave">Save</button></div>`);
  const $m = (s) => m.querySelector(s);
  const showErr = (msg, cls = "err") => { $m("#tErr").innerHTML = msg ? `<div class="banner ${cls}">${esc(msg)}</div>` : ""; };

  const previews = () => {
    const t = $m("#tTrl").value;
    $m("#tTrlImg").hidden = !t;
    if (t) $m("#tTrlImg").src = urlOf(t);
    $m("#tDiaImg").src = urlOf($m("#tDia").value) || truckDefault?.url || "";
  };
  previews();
  $m("#tTrl").onchange = previews;
  $m("#tDia").onchange = previews;

  const act = $m("#tActive");
  if (act) act.onclick = () => act.classList.toggle("on");
  $m("#tCancel").onclick = () => m.remove();
  const del = $m("#tDelete");
  if (del) del.onclick = async () => {
    if (await askTrash("vehicle", v.id, "truck")) {
      m.remove();
      if (location.hash.includes("?edit=")) history.replaceState(null, "", "#/admin/trucks");
      onSaved();
    }
  };

  for (const [kind, sel] of [["trailer", "#tTrl"], ["truck", "#tDia"]]) {
    $m(`#${kind}UpGo`).onclick = async (e) => {
      const f = $m(`#${kind}UpFile`).files[0];
      const name = $m(`#${kind}UpName`).value.trim();
      if (!f || !name) return showErr("Pick a picture and give it a name.");
      e.target.disabled = true;
      try {
        const fd = new FormData();
        fd.append("kind", kind);
        fd.append("name", name);
        fd.append("file", await shrinkImage(f, 2000, 0.85), "diagram.jpg");
        const dnew = await api("/admin/diagrams", { method: "POST", form: fd, timeout: 120000 });
        diagrams.push(dnew);
        $m(sel).insertAdjacentHTML("beforeend", `<option value="${dnew.id}">${esc(dnew.name)}</option>`);
        $m(sel).value = String(dnew.id);
        previews();
        $m(`#${kind}UpName`).value = "";
        $m(`#${kind}UpFile`).value = "";
        e.target.closest("details").open = false;
        showErr(`"${dnew.name}" added. Save the truck to use it.`, "okk");
      } catch (err) {
        showErr(err.message);
      } finally {
        e.target.disabled = false;
      }
    };
  }

  $m("#tSave").onclick = async (e) => {
    const body = {
      truck_code: $m("#tCode").value,
      unit: $m("#tUnit").value,
      vin: $m("#tVin").value,
      plate: $m("#tPlate").value,
      year: $m("#tYear").value,
      make: $m("#tMake").value,
      model: $m("#tModel").value,
      registration_expires: $m("#tExp").value,
      trailer_diagram_id: $m("#tTrl").value,
      diagram_id: $m("#tDia").value,
    };
    if (act) body.active = act.classList.contains("on");
    if (act && !body.active && v.active
      && !(await confirmBox(`Retire ${v.truck_code}? Crews won't see it any more. Its inspection history is kept.`, "Retire"))) return;
    e.target.disabled = true;
    try {
      if (isNew) await api("/admin/vehicles", { method: "POST", body });
      else await api(`/admin/vehicles/${v.id}`, { method: "PATCH", body });
      m.remove();
      toast(`Saved ${body.truck_code.trim().toUpperCase()}`);
      if (location.hash.includes("?edit=")) history.replaceState(null, "", "#/admin/trucks");
      onSaved();
    } catch (err) {
      e.target.disabled = false;
      showErr(err.message);
    }
  };
}

// ---------- Branding ----------

const SWATCHES = ["#2f6b3a", "#1f5f8b", "#1f3a5f", "#0f766e", "#9b2c2c", "#c05621", "#37474f", "#f2c230"];

async function brandingTab(nav) {
  const b = await api("/branding");
  if (stale(nav)) return;
  let color = b.color;
  let logo = b.logo_url;
  const box = $("#adm");
  box.innerHTML = `<div class="card" style="margin-top:14px">
    <div class="subhead">Names</div>
    <div class="fields">
      <div><label class="f" for="bCo">Company name</label><input class="t" id="bCo" maxlength="60" value="${esc(b.company_name)}"></div>
      <div><label class="f" for="bApp">App name</label><input class="t" id="bApp" maxlength="40" value="${esc(b.app_name)}"></div>
    </div>
    <div class="subhead">Header color</div>
    <div class="colorrow"><input type="color" id="bColor" value="${esc(color)}" aria-label="Pick a color">
      <input class="t" id="bHex" value="${esc(color)}" maxlength="7" autocapitalize="off" autocomplete="off" aria-label="Color as hex"></div>
    <div class="swatches">${SWATCHES.map((c) => `<button type="button" data-c="${c}" style="background:${c}" aria-label="Use ${c}"></button>`).join("")}</div>
    <div class="subhead">Logo</div>
    <div class="logobox" id="bLogoBox"></div>
    <div class="row" style="margin-top:10px"><label class="secondary filebtn">Upload logo<input type="file" id="bLogoFile" accept="image/png,image/jpeg"></label>
      <button class="secondary danger" id="bLogoDel">Remove logo</button></div>
    <p class="small muted">PNG or JPEG, under 2 MB. A PNG with a transparent background looks best. The logo saves as soon as you pick it,
      and shows in the header, on the sign-in screen and on the PDF.</p>
    <div class="subhead">Preview</div>
    <div class="preview" id="bPrev"><div class="ph-top"><img class="hdrlogo" id="bPrevLogo" alt=""><div style="min-width:0"><b id="bPrevApp"></b><span id="bPrevCo"></span></div></div>
      <div class="ph-body"><span class="primary">Start inspection</span><span class="pill">2 open repairs</span><span style="color:var(--brand-ink);text-decoration:underline">Link color</span></div></div>
    <div id="bErr"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="primary" id="bSave">Save names &amp; color</button></div>
  </div>`;

  const showErr = (msg) => { $("#bErr").innerHTML = msg ? `<div class="banner err">${esc(msg)}</div>` : ""; };
  const drawLogo = () => {
    $("#bLogoBox").innerHTML = logo ? `<img src="${esc(logo)}" alt="Current logo">` : `<span class="muted small">No logo yet</span>`;
    $("#bLogoDel").hidden = !logo;
    $("#bPrevLogo").hidden = !logo;
    if (logo) $("#bPrevLogo").src = logo;
  };
  const preview = () => {
    const prev = $("#bPrev");
    for (const [k, val] of Object.entries(brandVars(color))) prev.style.setProperty(k, val);
    $("#bPrevApp").textContent = $("#bApp").value || "App name";
    $("#bPrevCo").textContent = $("#bCo").value;
    box.querySelectorAll("[data-c]").forEach((s) => s.classList.toggle("on", s.dataset.c === color));
  };
  const setColor = (c, from) => {
    color = c.toLowerCase();
    if (from !== "picker") $("#bColor").value = color;
    if (from !== "hex") $("#bHex").value = color;
    preview();
  };
  drawLogo();
  preview();

  $("#bColor").oninput = (e) => setColor(e.target.value, "picker");
  $("#bHex").oninput = (e) => {
    let v = e.target.value.trim();
    if (v && !v.startsWith("#")) v = "#" + v;
    if (/^#[0-9a-f]{6}$/i.test(v)) setColor(v, "hex");
  };
  box.querySelectorAll("[data-c]").forEach((s) => (s.onclick = () => setColor(s.dataset.c)));
  $("#bApp").oninput = preview;
  $("#bCo").oninput = preview;

  $("#bLogoFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    showErr("");
    if (f.size > 2 * 1024 * 1024) { e.target.value = ""; return showErr("That image is over 2 MB. Use a smaller PNG or JPEG."); }
    $("#bLogoBox").innerHTML = `<span class="spinner"></span>`;
    try {
      const fd = new FormData();
      fd.append("file", f, f.name);
      const res = await api("/admin/branding/logo", { method: "POST", form: fd, timeout: 60000 });
      logo = res.logo_url;
      rememberBranding(res);
      toast("Logo saved");
    } catch (err) {
      showErr(err.message);
    }
    e.target.value = "";
    drawLogo();
  };
  $("#bLogoDel").onclick = async () => {
    if (!(await confirmBox("Remove the logo? You can upload one again any time.", "Remove", { danger: true }))) return;
    try {
      const res = await api("/admin/branding/logo", { method: "DELETE" });
      logo = null;
      rememberBranding(res);
      drawLogo();
      toast("Logo removed");
    } catch (err) {
      showErr(err.message);
    }
  };
  $("#bSave").onclick = async (e) => {
    showErr("");
    e.target.disabled = true;
    try {
      const res = await api("/admin/branding", {
        method: "PUT",
        body: { company_name: $("#bCo").value, app_name: $("#bApp").value, color },
      });
      rememberBranding(res);
      setHeader({ title: "Admin", sub: TABS.branding, back: "#/" });
      toast("Branding saved");
    } catch (err) {
      showErr(err.message);
    } finally {
      e.target.disabled = false;
    }
  };
}
