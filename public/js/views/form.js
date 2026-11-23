// The inspection form, in the same order as the paper Truck Inspection Sheet.
// Everything typed is saved to the phone as you go; Save queues it for upload.
import { api } from "../api.js";
import {
  deletePhotoBlob, flush, getDraft, photoBlob, saveDraft, sendQueued, setActiveDraft, storePhotoBlob, syncPhotos,
} from "../drafts.js";
import { idb } from "../idb.js";
import { setupSig } from "../sig.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { $, $$, debounce, esc, fmtDate, fmtNum, shrinkImage, toast, today, uuid, vehicleInfo } from "../util.js";
import { SECTION_TITLES } from "./common.js";
import { regValue, updateRegistration } from "./registration.js";

let d = null;   // the draft being edited
let ctx = null; // { vehicle, sections, trailerDiagramUrl, prevDamage, prevMileage, app }
let sigPad = null;
let saving = false;
let onFileHl = null;         // "truck-3": the on-file damage mark picked in the list, shown dark on the picture
const onFileOpen = {};       // whether the "Damage already on file" list is open, per picture (kept across redraws)
const blobUrls = new Map();
const persist = debounce(() => { if (d && d.touched) saveDraft(d); }, 400);
const onVis = () => { if (document.visibilityState === "hidden") persist.flush(); };
const onOnline = () => uploadPhotos();

function changed() {
  if (!d) return;
  d.touched = true;
  persist();
  updateProgress();
}

export async function render(app, vehicleId) {
  const nav = state.nav;
  onFileHl = null;
  for (const k of Object.keys(onFileOpen)) delete onFileOpen[k];
  setHeader({ title: "New inspection", back: `#/truck/${vehicleId}` });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let vehicle, config, last;
  try {
    [{ vehicle }, config, last] = await Promise.all([
      api(`/vehicles/${vehicleId}`), api("/form-config"), api(`/vehicles/${vehicleId}/last`),
    ]);
  } catch (e) {
    if (stale(nav)) return;
    const msg = e.status === 0
      ? "Can't load this truck without signal. Open the truck once while you have signal; after that the form works offline."
      : e.message;
    app.innerHTML = errorHtml(new Error(msg)) + `<a class="secondary" href="#/truck/${vehicleId}">Back to truck</a>`;
    return;
  }
  if (stale(nav)) return;

  let draft = await getDraft(vehicleId);
  if (draft?.status === "queued") return void location.replace(`#/truck/${vehicleId}`);
  if (!draft) draft = newDraft(vehicle, last);
  d = draft;
  setActiveDraft(d);

  const sections = { exterior: [], interior: [], trailer: [] };
  for (const it of config.checklist) sections[it.section]?.push(it);
  ctx = {
    app,
    vehicle,
    sections,
    trailerDiagramUrl: vehicle.trailer_diagram_url || config.trailer_diagram_url,
    checklistAsOf: config.as_of || null, // when this checklist was loaded (older cached copies don't have it)
    prevDamage: last.damage || [],
    prevMileage: vehicle.last_mileage ?? last.inspection?.mileage ?? null,
    persistent: await idb.isPersistent(),
  };
  setHeader({ title: draft.touched ? "Draft inspection" : "New inspection", sub: `${vehicle.truck_code} · ${vehicleInfo(vehicle)}`, back: `#/truck/${vehicleId}` });
  draw();
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("online", onOnline);
  uploadPhotos();
}

export async function leave() {
  persist.flush();
  document.removeEventListener("visibilitychange", onVis);
  window.removeEventListener("online", onOnline);
  sigPad?.destroy();
  sigPad = null;
  if (ctx?.app) { ctx.app.onclick = null; ctx.app.oninput = null; ctx.app.onchange = null; }
  for (const u of blobUrls.values()) URL.revokeObjectURL(u);
  blobUrls.clear();
  setActiveDraft(null);
  d = null;
  ctx = null;
  saving = false;
}

function newDraft(v, last) {
  const li = last.inspection;
  return {
    vehicleId: v.id,
    truckCode: v.truck_code,
    clientId: uuid(),
    status: "editing",
    startedAt: Date.now(),
    touched: false,
    date: today(),
    inspector: state.user?.name || "",
    mileage: "",
    oil: null,
    existingNotes: li ? [li.existing_notes, li.new_observations].filter(Boolean).join("\n").trim() : "",
    newObs: "",
    comments: "",
    answers: {},
    // The trailer on the truck now (Fleet), else the one on the last inspection.
    trailerOn: !!v.pulls_trailer || !!v.trailer,
    trailerNo: v.trailer?.trailer_number || (li?.trailer_inspected ? li.trailer_number_text || "" : ""),
    trailerPlate: v.trailer ? v.trailer.plate || "" : li?.trailer_inspected ? li.trailer_plate_text || "" : "",
    damage: [],
    photos: [],
    sig: null,
    lastError: null,
  };
}

// ---------- Rendering ----------

function visibleSections() {
  return d.trailerOn ? ["exterior", "interior", "trailer"] : ["exterior", "interior"];
}
function visibleItems() {
  return visibleSections().flatMap((s) => ctx.sections[s]);
}
function itemById(id) {
  return [...ctx.sections.exterior, ...ctx.sections.interior, ...ctx.sections.trailer].find((x) => x.id === Number(id));
}

function draw() {
  const v = ctx.vehicle;
  const prev = ctx.prevMileage;
  let h = "";
  if (d.lastError) {
    h += `<div class="banner err"><b>The server didn't accept this inspection:</b> ${esc(d.lastError)}<br>Fix it below and tap Save again.</div>`;
  }
  if (!ctx.persistent) {
    h += `<div class="banner info">This browser can't keep drafts after it's closed (private browsing?). Finish and save before closing it.</div>`;
  }
  h += `<div class="card" style="margin-top:14px"><div class="hdr"><b>Truck</b><span>${esc(v.truck_code)}</span><b>Plate</b><span>${esc(v.plate || "—")}</span>
    <b>Info</b><span>${esc(vehicleInfo(v) || "—")}</span><b>Unit</b><span>${esc(v.unit || "—")}</span>
    <b>Reg exp.</b><span id="regBox">${regValue(v.registration_expires)}</span></div></div>`;
  h += `<h2>Inspection</h2><div class="card"><div class="fields">
    <div><label class="f" for="f-date">Date</label><input class="t" type="date" id="f-date" value="${esc(d.date)}" max="${today()}"></div>
    <div><label class="f" for="f-insp">Name of inspector</label><input class="t" id="f-insp" value="${esc(d.inspector)}" autocomplete="name"></div>
    <div><label class="f" for="f-mi">Current mileage</label>
      <input class="t" id="f-mi" inputmode="numeric" pattern="[0-9]*" autocomplete="off" value="${esc(d.mileage)}" placeholder="${prev != null ? `Last: ${fmtNum(prev)}` : "e.g. 48210"}">
      <div id="miWarn"></div></div>
    <div><label class="f">Oil change due?</label><div class="seg" id="oilSeg" role="group" aria-label="Oil change due">
      <button type="button" data-oil="yes" class="${d.oil === "yes" ? "on" : ""}">Yes</button><button type="button" data-oil="no" class="${d.oil === "no" ? "on" : ""}">No</button></div></div>
  </div></div>`;
  h += `<h2>Damage</h2><div class="card" id="dia-truck">${diagramHtml("truck")}</div>`;
  h += `<h2>Notes</h2><div class="card"><label class="f" for="f-ex">Existing notes</label><textarea class="t" id="f-ex">${esc(d.existingNotes)}</textarea>
    <label class="f" for="f-new" style="margin-top:12px">New observations</label><textarea class="t" id="f-new" placeholder="Anything new since last time">${esc(d.newObs)}</textarea></div>`;
  h += `<h2>Checklist</h2>${sectionHtml("exterior")}${sectionHtml("interior")}`;
  h += `<h2>Trailer</h2><div class="card"><div class="toggle"><div><b>Pulling a trailer?</b><div class="small muted">Adds the trailer &amp; crew checklist</div></div>
    <button type="button" class="sw ${d.trailerOn ? "on" : ""}" id="trlSw" role="switch" aria-checked="${d.trailerOn}" aria-label="Pulling a trailer"></button></div></div>
    <div id="trailerBlock">${trailerHtml()}</div>`;
  h += `<h2>Photos</h2><div class="card"><div class="photos" id="photos">${photosHtml()}</div></div>`;
  h += `<h2>Comments</h2><div class="card"><textarea class="t" id="f-com" aria-label="Comments">${esc(d.comments)}</textarea></div>`;
  h += `<h2>Employee signature</h2><div class="card"><canvas class="sig" id="sig" aria-label="Signature pad"></canvas>
    <div class="spread" style="margin-top:6px"><span class="small muted">Sign with your finger</span><button type="button" class="link" id="sigClr">Clear</button></div></div>`;
  h += `<div id="formErr"></div>`;
  h += `<div class="bar"><div class="in"><div class="prog"><span id="progTxt"></span><div class="track"><div class="fill" id="progFill"></div></div></div>
    <button class="primary" id="save" type="button">Save inspection</button></div></div>`;
  ctx.app.innerHTML = h;
  document.body.classList.add("has-bar");
  bind();
  mileageWarn();
  updateProgress();
  loadThumbs();
}

function diagramHtml(kind) {
  const src = kind === "truck" ? ctx.vehicle.diagram_url : ctx.trailerDiagramUrl;
  if (!src) return `<div class="empty">No diagram on file. Describe damage in the notes.</div>`;
  const pins = d.damage.filter((m) => m.diagram === kind);
  // `n` comes from the server; a copy cached by an older version of the app may not have it.
  const old = ctx.prevDamage.filter((m) => m.diagram === kind).map((m, i) => ({ ...m, n: m.n ?? i + 1 }));
  const key = (p) => `${kind}-${p.n}`;
  return `<div class="diagram" data-dia="${kind}"><img src="${esc(src)}" alt="${kind} diagram" draggable="false">
      ${old.map((p) => `<span class="pin old${onFileHl === key(p) ? " hl" : ""}" data-old="${key(p)}" style="left:${p.x * 100}%;top:${p.y * 100}%">${p.n}</span>`).join("")}
      ${pins.map((p, i) => `<span class="pin" style="left:${p.x * 100}%;top:${p.y * 100}%">${i + 1}</span>`).join("")}</div>
    <div class="small muted" style="margin-top:6px">Tap the picture where there's new damage.${old.length ? " Grey dots = damage already on file from earlier inspections." : ""}</div>
    ${old.length ? `<details class="onfile" data-onfile="${kind}"${onFileOpen[kind] ? " open" : ""}>
      <summary>Damage already on file (${old.length})</summary>
      <div class="small muted" style="margin:2px 0 4px">Tap one to find it on the picture. Don't mark it again unless it got worse.</div>
      ${[...old].reverse().map((p) => `<button type="button" class="ofrow${onFileHl === key(p) ? " on" : ""}" data-hl="${key(p)}">
        <span class="ofn">${p.n}</span><span class="grow">${esc(p.note || "(no description)")}
        ${p.inspection_date ? `<span class="small muted" style="display:block">Marked ${fmtDate(p.inspection_date)}</span>` : ""}</span></button>`).join("")}
    </details>` : ""}
    <div class="pinlist">${pins.map((p, i) => {
      const n = d.photos.filter((ph) => ph.damageKey === p.key).length;
      return `<div class="p"><span class="num">${i + 1}</span>
        <input class="t" data-pn="${p.key}" placeholder="Describe damage (e.g. dent, rear quarter)" value="${esc(p.note)}">
        <label class="cam" aria-label="Add photo of damage ${i + 1}">📷<input type="file" accept="image/*" data-pcam="${p.key}">${n ? `<span class="cnt">${n}</span>` : ""}</label>
        <button type="button" class="x" data-px="${p.key}" aria-label="Remove mark ${i + 1}">×</button></div>`;
    }).join("")}</div>`;
}

function sectionHtml(sec) {
  const items = ctx.sections[sec];
  return `<div class="card" id="sec-${sec}"><div class="sechead"><h3>${SECTION_TITLES[sec]}</h3>
    <button type="button" class="link" data-allok="${sec}">Mark rest OK</button></div>
    ${items.map((it) => {
      const a = d.answers[it.id] || {};
      const n = d.photos.filter((ph) => ph.itemId === it.id).length;
      return `<div class="check" id="row-${it.id}"><span class="lbl">${esc(it.label)}</span><span class="btns">
          <button type="button" class="okb ${a.r === "ok" ? "on" : ""}" data-set="${it.id}|ok" aria-pressed="${a.r === "ok"}">OK</button>
          <button type="button" class="rpb ${a.r === "repair" ? "on" : ""}" data-set="${it.id}|repair" aria-pressed="${a.r === "repair"}">Repair</button></span></div>
        ${a.r === "repair" ? `<div class="repairrow" id="rr-${it.id}"><input class="repairnote" data-rn="${it.id}" placeholder="What needs repair?" value="${esc(a.n || "")}" aria-label="Repair note for ${esc(it.label)}">
          <label class="cam" aria-label="Add photo">📷<input type="file" accept="image/*" data-icam="${it.id}">${n ? `<span class="cnt">${n}</span>` : ""}</label></div>` : ""}`;
    }).join("")}</div>`;
}

function trailerHtml() {
  if (!d.trailerOn) return "";
  return `<div class="card"><div class="fields">
      <div><label class="f" for="f-tn">Trailer number</label><input class="t" id="f-tn" value="${esc(d.trailerNo)}" autocapitalize="characters"></div>
      <div><label class="f" for="f-tp">Trailer plate</label><input class="t" id="f-tp" value="${esc(d.trailerPlate)}" autocapitalize="characters"></div></div></div>
    <div class="card" id="dia-trailer">${diagramHtml("trailer")}</div>${sectionHtml("trailer")}`;
}

function photoTag(p) {
  if (p.damageKey) {
    const m = d.damage.find((x) => x.key === p.damageKey);
    if (m) {
      const n = d.damage.filter((x) => x.diagram === m.diagram).indexOf(m) + 1;
      return `${m.diagram === "trailer" ? "Trailer " : ""}Damage ${n}`;
    }
  }
  if (p.itemId) return `Repair: ${itemById(p.itemId)?.label || ""}`;
  return "";
}

function photosHtml() {
  return d.photos.map((p) => {
    const tag = photoTag(p);
    return `<div class="ph" data-ph="${p.id}"><img alt="" data-pid="${p.id}"${blobUrls.has(p.id) ? ` src="${blobUrls.get(p.id)}"` : ""}>
      ${tag ? `<span class="tag">${esc(tag)}</span>` : ""}
      ${p.uploaded ? "" : `<div class="state">${navigator.onLine ? `<span class="spinner"></span>` : "Saved on phone"}</div>`}
      <button type="button" class="x" data-phx="${p.id}" aria-label="Remove photo">×</button>
      <input class="cap" data-phc="${p.id}" placeholder="Caption" value="${esc(p.caption || "")}"></div>`;
  }).join("") + `<label class="addph"><span style="font-size:28px">＋</span><span>Add photos</span><input type="file" accept="image/*" multiple id="phIn"></label>`;
}

async function loadThumbs() {
  for (const img of $$("img[data-pid]:not([src])", ctx?.app)) {
    const id = img.dataset.pid;
    const blob = await photoBlob(id).catch(() => null);
    if (!ctx) return;
    if (blob) {
      if (!blobUrls.has(id)) blobUrls.set(id, URL.createObjectURL(blob));
      img.src = blobUrls.get(id);
    } else {
      img.src = `/api/photos/${id}`;
    }
  }
}

const redrawSection = (sec) => {
  const el = $(`#sec-${sec}`);
  if (el) el.outerHTML = sectionHtml(sec);
};
const redrawDiagram = (kind) => {
  const el = $(`#dia-${kind}`);
  if (el) el.innerHTML = diagramHtml(kind);
};
const redrawPhotos = () => {
  const el = $("#photos");
  if (el) { el.innerHTML = photosHtml(); loadThumbs(); }
};
const redrawTrailer = () => {
  $("#trailerBlock").innerHTML = trailerHtml();
  const sw = $("#trlSw");
  sw.classList.toggle("on", d.trailerOn);
  sw.setAttribute("aria-checked", String(d.trailerOn));
};

function mileageWarn() {
  const el = $("#miWarn");
  if (!el) return;
  const prev = ctx.prevMileage;
  const lower = d.mileage !== "" && prev != null && Number(d.mileage) < prev;
  el.innerHTML = lower
    ? `<div class="hint warn">Lower than the last recorded mileage (${fmtNum(prev)}). Double-check the odometer. You can still save; it will be flagged for a supervisor.</div>`
    : "";
}

// ---------- Events ----------

function bind() {
  const app = ctx.app;
  const text = (sel, key) => {
    const el = $(sel);
    if (el) el.oninput = () => { d[key] = el.value; changed(); };
  };
  text("#f-date", "date");
  text("#f-insp", "inspector");
  text("#f-ex", "existingNotes");
  text("#f-new", "newObs");
  text("#f-com", "comments");
  const mi = $("#f-mi");
  mi.oninput = () => {
    const clean = mi.value.replace(/[^\d]/g, "").slice(0, 7);
    if (clean !== mi.value) mi.value = clean;
    d.mileage = clean;
    mileageWarn();
    changed();
  };
  $("#trlSw").onclick = () => {
    d.trailerOn = !d.trailerOn;
    redrawTrailer();
    changed();
  };
  $("#save").onclick = save;
  sigPad = setupSig($("#sig"), { get: () => d.sig, set: (v) => { d.sig = v; changed(); } });
  $("#sigClr").onclick = () => sigPad.clear();

  app.onclick = (e) => {
    const t = e.target;
    const sum = t.closest(".onfile > summary");
    if (sum) {
      // Fires before the browser toggles it, so the new state is the opposite of .open.
      const box = sum.parentElement;
      onFileOpen[box.dataset.onfile] = !box.open;
      return;
    }
    const hl = t.closest("[data-hl]");
    if (hl) {
      onFileHl = onFileHl === hl.dataset.hl ? null : hl.dataset.hl;
      $$("[data-old]").forEach((el) => el.classList.toggle("hl", el.dataset.old === onFileHl));
      $$("[data-hl]").forEach((el) => el.classList.toggle("on", el.dataset.hl === onFileHl));
      if (onFileHl) $(`[data-old="${onFileHl}"]`)?.closest(".diagram")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    if (t.closest("[data-regupd]")) {
      // Saved to the truck right away (needs signal); the inspection itself still saves on the phone as usual.
      const vehicle = ctx.vehicle;
      updateRegistration(vehicle, { from: "form" }).then((date) => {
        if (!date || ctx?.vehicle !== vehicle) return;
        vehicle.registration_expires = date;
        $("#regBox").innerHTML = regValue(date);
      });
      return;
    }
    const oil = t.closest("[data-oil]");
    if (oil) {
      d.oil = oil.dataset.oil;
      $$("[data-oil]").forEach((b) => b.classList.toggle("on", b === oil));
      return changed();
    }
    const set = t.closest("[data-set]");
    if (set) {
      const [id, val] = set.dataset.set.split("|");
      const cur = d.answers[id] || {};
      if (cur.r === val) delete d.answers[id];
      else d.answers[id] = { r: val, n: cur.n || "" };
      if (val === "ok" || cur.r === val) d.photos.forEach((p) => { if (p.itemId === Number(id)) p.itemId = null; });
      redrawSection(itemById(id).section);
      if (d.answers[id]?.r === "repair") $(`[data-rn="${id}"]`)?.focus({ preventScroll: true });
      return changed();
    }
    const all = t.closest("[data-allok]");
    if (all) {
      for (const it of ctx.sections[all.dataset.allok]) if (!d.answers[it.id]) d.answers[it.id] = { r: "ok", n: "" };
      redrawSection(all.dataset.allok);
      return changed();
    }
    const px = t.closest("[data-px]");
    if (px) {
      const m = d.damage.find((x) => x.key === px.dataset.px);
      d.damage = d.damage.filter((x) => x !== m);
      d.photos.forEach((p) => { if (p.damageKey === m.key) p.damageKey = null; });
      redrawDiagram(m.diagram);
      redrawPhotos();
      return changed();
    }
    const phx = t.closest("[data-phx]");
    if (phx) {
      const id = phx.dataset.phx;
      d.photos = d.photos.filter((p) => p.id !== id);
      deletePhotoBlob(id).catch(() => {});
      redrawPhotos();
      redrawCounts();
      return changed();
    }
    const dia = t.closest("[data-dia]");
    if (dia) {
      const r = dia.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      const kind = dia.dataset.dia;
      const key = uuid().slice(0, 8);
      d.damage.push({ key, diagram: kind, x: +x.toFixed(4), y: +y.toFixed(4), note: "" });
      redrawDiagram(kind);
      $(`[data-pn="${key}"]`)?.focus({ preventScroll: true });
      return changed();
    }
  };

  app.oninput = (e) => {
    const t = e.target;
    if (t.dataset.rn) { d.answers[t.dataset.rn].n = t.value; return changed(); }
    if (t.dataset.pn) { d.damage.find((m) => m.key === t.dataset.pn).note = t.value; return changed(); }
    if (t.dataset.phc) { d.photos.find((p) => p.id === t.dataset.phc).caption = t.value; return changed(); }
    if (t.id === "f-tn") { d.trailerNo = t.value; return changed(); }
    if (t.id === "f-tp") { d.trailerPlate = t.value; return changed(); }
  };

  app.onchange = (e) => {
    const t = e.target;
    if (t.type !== "file" || !t.files?.length) return;
    const files = [...t.files];
    t.value = "";
    if (t.id === "phIn") addPhotos(files, {});
    else if (t.dataset.pcam) addPhotos(files, { damageKey: t.dataset.pcam });
    else if (t.dataset.icam) addPhotos(files, { itemId: Number(t.dataset.icam) });
  };
}

function redrawCounts() {
  redrawDiagram("truck");
  if (d.trailerOn) redrawDiagram("trailer");
  for (const s of visibleSections()) redrawSection(s);
}

async function addPhotos(files, link) {
  for (const f of files) {
    const id = uuid();
    const blob = await shrinkImage(f);
    if (!d) return;
    await storePhotoBlob(id, blob);
    blobUrls.set(id, URL.createObjectURL(blob));
    d.photos.push({ id, caption: "", uploaded: false, damageKey: link.damageKey || null, itemId: link.itemId || null });
    changed();
    redrawPhotos();
  }
  if (link.damageKey || link.itemId) redrawCounts();
  toast(files.length > 1 ? `${files.length} photos added` : "Photo added");
  uploadPhotos();
}

let uploadingNow = false;
async function uploadPhotos() {
  if (!d || uploadingNow || !d.photos.some((p) => !p.uploaded)) return;
  uploadingNow = true;
  try {
    await syncPhotos(d.vehicleId);
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    uploadingNow = false;
  }
  if (d) redrawPhotos();
}

// ---------- Validation and save ----------

function missingList() {
  const miss = [];
  if (!d.date) miss.push({ label: "date", sel: "#f-date" });
  if (!d.inspector.trim()) miss.push({ label: "inspector name", sel: "#f-insp" });
  if (d.mileage === "") miss.push({ label: "mileage", sel: "#f-mi" });
  if (!d.oil) miss.push({ label: "oil change due", sel: "#oilSeg" });
  const unanswered = visibleItems().filter((it) => !d.answers[it.id]);
  if (unanswered.length) {
    miss.push({ label: `${unanswered.length} checklist item${unanswered.length > 1 ? "s" : ""}`, sel: unanswered.map((it) => `#row-${it.id}`).join(",") });
  }
  for (const it of visibleItems()) {
    const a = d.answers[it.id];
    if (a?.r === "repair" && !a.n?.trim()) miss.push({ label: `repair note for “${it.label}”`, sel: `#rr-${it.id}` });
  }
  if (!d.sig) miss.push({ label: "signature", sel: "#sig" });
  return miss;
}

function updateProgress() {
  const t = $("#progTxt");
  if (!t || !d) return;
  const items = visibleItems();
  const done = items.filter((it) => d.answers[it.id]).length;
  t.textContent = `${done} of ${items.length} items`;
  $("#progFill").style.width = `${items.length ? (done / items.length) * 100 : 0}%`;
  // Once Save has shown what's missing, keep that list and the red highlights current.
  const err = $("#formErr");
  if (err?.dataset.missing) {
    const miss = missingList();
    highlight(miss);
    if (miss.length) err.querySelector("span").textContent = `${miss.map((m) => m.label).join(", ")}.`;
    else { err.innerHTML = ""; delete err.dataset.missing; }
  }
}

function highlight(miss) {
  $$(".missing").forEach((el) => el.classList.remove("missing"));
  for (const m of miss) $$(m.sel).forEach((el) => el.classList.add("missing"));
}

function buildPayload() {
  const items = visibleItems();
  const repairIds = new Set(items.filter((it) => d.answers[it.id]?.r === "repair").map((it) => it.id));
  const damage = d.damage.filter((m) => m.diagram === "truck" || d.trailerOn);
  const keys = new Set(damage.map((m) => m.key));
  return {
    client_id: d.clientId,
    vehicle_id: d.vehicleId,
    inspection_date: d.date,
    inspector_name: d.inspector.trim(),
    mileage: Number(d.mileage),
    oil_change_due: d.oil === "yes",
    existing_notes: d.existingNotes,
    new_observations: d.newObs,
    comments: d.comments,
    trailer: d.trailerOn ? { number: d.trailerNo, plate: d.trailerPlate } : null,
    // The pictures the pins were placed on, so the record keeps them even if the truck is changed later.
    truck_diagram_id: ctx.vehicle.diagram_id ?? null,
    trailer_diagram_id: d.trailerOn ? ctx.vehicle.trailer_diagram_id ?? null : null,
    checklist_as_of: ctx.checklistAsOf,
    items: items.map((it) => {
      const a = d.answers[it.id];
      return { checklist_item_id: it.id, result: a.r, note: a.r === "repair" ? a.n.trim() : null };
    }),
    damage: damage.map((m) => ({ key: m.key, diagram: m.diagram, x: m.x, y: m.y, note: m.note })),
    photos: d.photos.map((p) => ({
      id: p.id,
      caption: p.caption || null,
      damage_key: p.damageKey && keys.has(p.damageKey) ? p.damageKey : null,
      checklist_item_id: p.itemId && repairIds.has(p.itemId) ? p.itemId : null,
    })),
    signature: d.sig,
  };
}

async function save() {
  if (saving || !d) return;
  const err = $("#formErr");
  const miss = missingList();
  highlight(miss);
  if (miss.length) {
    err.innerHTML = `<div class="banner err"><b>Still needed:</b> <span>${esc(miss.map((m) => m.label).join(", "))}.</span></div>`;
    err.dataset.missing = "1";
    const first = $(miss[0].sel.split(",")[0]);
    (first || err).scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  saving = true;
  err.innerHTML = "";
  delete err.dataset.missing;
  const btn = $("#save");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>&nbsp;Saving…`;

  const vehicleId = d.vehicleId;
  d.payload = buildPayload();
  d.status = "queued";
  d.queuedAt = Date.now();
  d.lastError = null;
  d.touched = true;
  persist.flush();
  await saveDraft(d);

  const app = ctx.app;
  const r = await sendQueued(vehicleId);
  saving = false;
  if (r.state === "sent") {
    // The draft is gone from the phone now; make sure nothing here saves it again.
    setActiveDraft(null);
    d = null;
    toast(r.res.mileage_flagged ? "Saved ✓ Mileage was lower than last time, so it's flagged for a supervisor." : "Inspection saved ✓", 4000);
    location.hash = `#/inspection/${r.res.id}`;
  } else if (r.state === "waiting") {
    toast("Saved on phone, not yet uploaded. It will send by itself when signal returns.", 5000);
    flush();
    location.hash = `#/truck/${vehicleId}`;
  } else if (r.state === "rejected" && d) {
    btn.disabled = false;
    btn.textContent = "Save inspection";
    const details = r.error.details || {};
    err.innerHTML = `<div class="banner err">${esc(r.error.message)}</div>`;
    if (details.code === "checklist_changed") {
      toast("The checklist was updated. Reloading the form…");
      const nav = state.nav;
      setTimeout(async () => {
        if (stale(nav)) return;
        await leave();
        render(app, vehicleId);
      }, 1200);
    } else if (details.missing) {
      highlight(details.missing.map((id) => ({ sel: `#row-${id}` })));
    }
    err.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
