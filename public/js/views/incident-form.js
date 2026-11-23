// The incident report form (supervisors), in the order of the vehicle accident report: when and where, the driver,
// police, injuries, our truck (damage pinned on its picture), the other party, witnesses, what happened, a drawing of
// the scene and a map, photos, the manager's comments, and signatures. Everything typed is saved to the phone as you
// go; Save queues it for upload, like the inspection form. Only the date, driver, injuries yes/no, what happened and
// the reporting manager's name and signature are required: the rest is filled in as far as it's known.
import { api } from "../api.js";
import { deletePhotoBlob, photoBlob, storePhotoBlob } from "../drafts.js";
import { idb } from "../idb.js";
import {
  deleteIncDraft, flushInc, getIncDraft, incKey, saveIncDraft, sendInc, setActiveInc, syncIncPhotos,
} from "../incq.js";
import { setupSig } from "../sig.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { $, $$, debounce, esc, shrinkImage, toast, today, uuid, vehicleInfo } from "../util.js";

let d = null;   // the draft being edited
let ctx = null; // { app, vehicle, people, trailerDiagramUrl, onFile, persistent }
let pads = [];
let saving = false;
const blobUrls = new Map();
const persist = debounce(() => { if (d && d.touched) saveIncDraft(d); }, 400);
const onVis = () => { if (document.visibilityState === "hidden") persist.flush(); };
const onOnline = () => uploadPhotos();

const PARTY = [
  ["name", "Driver's name"], ["phone", "Phone"], ["address", "Address"], ["city", "City"], ["state", "State"], ["zip", "Zip"],
  ["license_no", "Driver's license no."], ["vehicle_year", "Vehicle year"], ["make", "Make"], ["model", "Model"],
  ["plate_state", "Plate state"], ["plate_no", "Plate no."], ["insurance_company", "Insurance company"], ["policy_no", "Policy no."],
  ["insurance_phone", "Insurance phone"],
];
const WITNESS = [["name", "Name"], ["phone", "Phone"], ["address", "Address"], ["city", "City"], ["state", "State"], ["zip", "Zip"]];
const WEATHER = ["Clear", "Cloudy", "Rain", "Wind", "Dust", "Dark"];

function changed() {
  if (!d) return;
  d.touched = true;
  persist();
  updateProgress();
}

export async function render(app, vehicleId) {
  const nav = state.nav;
  setHeader({ title: "Incident report", back: `#/truck/${vehicleId}` });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let data, config, formConfig;
  try {
    [data, config, formConfig] = await Promise.all([api(`/vehicles/${vehicleId}`), api("/incident-config"), api("/form-config")]);
  } catch (e) {
    if (stale(nav)) return;
    const msg = e.status === 0
      ? "Can't load this truck without signal. Open the truck once while you have signal; after that the form works offline."
      : e.message;
    app.innerHTML = errorHtml(new Error(msg)) + `<a class="secondary" href="#/truck/${vehicleId}">Back to truck</a>`;
    return;
  }
  if (stale(nav)) return;
  const v = data.vehicle;
  const key = incKey(v.id);
  let draft = await getIncDraft(key);
  if (draft?.status === "queued") return void location.replace(`#/truck/${v.id}`);
  if (!draft) draft = newDraft(v);
  d = draft;
  setActiveInc(d);
  ctx = {
    app,
    vehicle: v,
    people: config.people || [],
    trailerDiagramUrl: v.trailer_diagram_url || formConfig.trailer_diagram_url,
    // Damage already on file, as grey dots, so new damage isn't confused with old.
    onFile: (data.damage || []).filter((m) => m.on_current_diagram && !m.repair),
    persistent: await idb.isPersistent(),
  };
  setHeader({ title: d.touched ? "Incident report draft" : "Incident report", sub: `${v.truck_code} · ${vehicleInfo(v)}`, back: `#/truck/${v.id}` });
  draw();
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("online", onOnline);
  uploadPhotos();
}

export async function leave() {
  persist.flush();
  document.removeEventListener("visibilitychange", onVis);
  window.removeEventListener("online", onOnline);
  for (const p of pads) p.destroy();
  pads = [];
  if (ctx?.app) { ctx.app.onclick = null; ctx.app.oninput = null; ctx.app.onchange = null; }
  for (const u of blobUrls.values()) URL.revokeObjectURL(u);
  blobUrls.clear();
  setActiveInc(null);
  d = null;
  ctx = null;
  saving = false;
}

function newDraft(v) {
  return {
    key: incKey(v.id), vehicleId: v.id, truckCode: v.truck_code, clientId: uuid(), status: "editing", startedAt: Date.now(),
    touched: false, lastError: null,
    date: today(), time: "", propertyDamage: false, theft: false,
    locationName: "", onJob: null, siteName: "", street: "", city: "", state: "", zip: "", weather: "", gps: null,
    driverId: "", driverName: "", employeeManager: "", department: "",
    passengers: null, passengerNames: "", seatbelt: null, seatbeltPass: null,
    police: null, policeDept: "", policePhone: "", officer: "", reportNo: "", citeDriver: null, citeOther: null,
    injured: null, injuryDesc: "", empInjured: null, medEval: null, clinic: "", adTest: null, adClinic: "",
    drivable: null, towedTo: "",
    trailerOn: !!v.trailer, trailerNo: v.trailer?.trailer_number || "",
    damage: [], damageGc: "",
    parties: [], damageOther: "", otherMarks: "", otherAppearance: "",
    witnesses: [],
    description: "", sketch: null, photos: [],
    comments: "", preventive: "",
    driverSig: null, reporterName: state.user?.name || "", reporterSig: null,
  };
}

// ---------- Drawing ----------

const yn = (field, label, cur = d[field], attr = "data-yn") => `<div><label class="f">${label}</label>
  <div class="seg" id="yn-${field}" role="group" aria-label="${esc(label)}">
    <button type="button" ${attr}="${field}|yes" class="${cur === "yes" ? "on" : ""}" aria-pressed="${cur === "yes"}">Yes</button>
    <button type="button" ${attr}="${field}|no" class="${cur === "no" ? "on" : ""}" aria-pressed="${cur === "no"}">No</button></div></div>`;
const txt = (field, label, { ph = "", type = "text", mode = "", cap = "", full = false } = {}) =>
  `<div${full ? ` style="grid-column:1/-1"` : ""}><label class="f" for="i-${field}">${label}</label><input class="t" id="i-${field}" data-f="${field}" type="${type}"
    value="${esc(d[field])}"${ph ? ` placeholder="${esc(ph)}"` : ""}${mode ? ` inputmode="${mode}"` : ""}${cap ? ` autocapitalize="${cap}"` : ""}></div>`;
const area = (field, label, ph = "", rows = 3) => `<label class="f" for="i-${field}">${label}</label>
  <textarea class="t" id="i-${field}" data-f="${field}" rows="${rows}" placeholder="${esc(ph)}">${esc(d[field])}</textarea>`;

function draw() {
  const v = ctx.vehicle;
  let h = "";
  if (d.lastError) h += `<div class="banner err"><b>The server didn't accept this report:</b> ${esc(d.lastError)}<br>Fix it below and tap Save again.</div>`;
  if (!ctx.persistent) h += `<div class="banner info">This browser can't keep drafts after it's closed (private browsing?). Finish and save before closing it.</div>`;
  h += `<div class="card" style="margin-top:14px"><div class="hdr"><b>Truck</b><span>${esc(v.truck_code)}</span><b>Plate</b><span>${esc(v.plate || "—")}</span>
    <b>Info</b><span>${esc(vehicleInfo(v) || "—")}</span><b>Unit</b><span>${esc(v.unit || "—")}</span></div>
    <p class="small muted" style="margin:10px 0 0">Fill in what you know; the date, driver, injuries, what happened and your signature are required.
    Lines left empty print blank on the PDF to finish by hand.</p></div>`;
  h += `<h2>When</h2><div id="sec-when">${whenHtml()}</div>`;
  h += `<h2>Where</h2><div id="sec-where">${whereHtml()}</div>`;
  h += `<h2>Driver</h2><div id="sec-driver">${driverHtml()}</div>`;
  h += `<h2>Police</h2><div id="sec-police">${policeHtml()}</div>`;
  h += `<h2>Injuries</h2><div id="sec-injury">${injuryHtml()}</div>`;
  h += `<h2>Our truck</h2><div id="sec-truck">${truckHtml()}</div>`;
  h += `<h2>Other party</h2><div id="sec-parties">${partiesHtml()}</div>`;
  h += `<h2>Witnesses</h2><div id="sec-witnesses">${witnessesHtml()}</div>`;
  h += `<h2>What happened</h2><div class="card">${area("description", "Describe the accident", "What happened, in order: where each vehicle was going, what hit what…", 6)}</div>`;
  h += `<h2>Diagram of the accident</h2><div class="card">
    <p class="small muted" style="margin:0 0 8px">Draw the scene with your finger: streets, signals, our truck as 1, the other vehicle as 2.</p>
    <canvas class="sig sketch" id="sketch" aria-label="Drawing of the scene"></canvas>
    <div class="spread" style="margin-top:6px"><span class="small muted">Draw with your finger</span><button type="button" class="link" id="sketchClr">Clear</button></div>
    <div id="sec-map" style="margin-top:12px">${mapHtml()}</div></div>`;
  h += `<h2>Photos</h2><div class="card"><p class="small muted" style="margin:0 0 8px">The scene, both vehicles, the other driver's license, insurance card and plate.</p>
    <div class="photos" id="photos">${photosHtml()}</div></div>`;
  h += `<h2>Manager</h2><div class="card">${area("comments", "Manager incident comments")}
    <div style="margin-top:12px">${area("preventive", "Hazard resolution and preventive measures")}</div></div>`;
  h += `<h2>Signatures</h2><div class="card">
    <label class="f">Driver (employee certification)</label>
    <canvas class="sig" id="sigDriver" aria-label="Driver's signature"></canvas>
    <div class="spread" style="margin-top:6px"><span class="small muted">Optional: if the driver isn't here, they sign the printed form</span>
      <button type="button" class="link" id="sigDriverClr">Clear</button></div>
    <div style="margin-top:14px">${txt("reporterName", "Reporting manager")}</div>
    <label class="f" style="margin-top:12px">Manager signature</label>
    <canvas class="sig" id="sigRep" aria-label="Reporting manager's signature"></canvas>
    <div class="spread" style="margin-top:6px"><span class="small muted">Sign with your finger</span><button type="button" class="link" id="sigRepClr">Clear</button></div></div>`;
  h += `<div id="formErr"></div>`;
  h += `<div class="bar"><div class="in"><div class="prog"><span id="progTxt"></span><div class="track"><div class="fill" id="progFill"></div></div></div>
    <button class="primary" id="save" type="button">Save report</button></div></div>`;
  ctx.app.innerHTML = h;
  document.body.classList.add("has-bar");
  bind();
  updateProgress();
  loadThumbs();
}

function whenHtml() {
  return `<div class="card"><div class="fields">
      <div><label class="f" for="i-date">Date of incident</label><input class="t" type="date" id="i-date" data-f="date" value="${esc(d.date)}" max="${today()}"></div>
      <div><label class="f" for="i-time">Time</label><input class="t" type="time" id="i-time" data-f="time" value="${esc(d.time)}"></div></div>
    <label class="f" style="margin-top:12px">Also involved</label>
    <div class="chips"><button type="button" data-flag="propertyDamage" class="${d.propertyDamage ? "on" : ""}" aria-pressed="${d.propertyDamage}">Other property damaged</button>
      <button type="button" data-flag="theft" class="${d.theft ? "on" : ""}" aria-pressed="${d.theft}">Theft or vandalism</button></div></div>`;
}

function whereHtml() {
  const g = d.gps;
  return `<div class="card"><div class="fields">
      ${txt("locationName", "Incident location", { ph: "Job site, road, yard…", full: true })}
      ${yn("onJob", "On a job?")}
      ${d.onJob === "yes" ? txt("siteName", "Site name") : "<div></div>"}
      ${txt("street", "Street address or intersection", { full: true })}
      ${txt("city", "City")}
      <div class="fields" style="gap:8px">${txt("state", "State", { cap: "characters" })}${txt("zip", "Zip", { mode: "numeric" })}</div>
    </div>
    <div style="margin-top:12px">${g
      ? `<div class="spread"><span>📍 Location saved${g.acc != null ? ` (±${Math.round(g.acc)} m)` : ""} ·
          <a href="https://www.google.com/maps?q=${g.lat},${g.lng}" target="_blank" rel="noopener">Open map</a></span>
          <button type="button" class="link" id="gpsClr">Remove</button></div>`
      : `<button type="button" class="secondary wide" id="gpsBtn">📍 Use my location</button>
        <div class="small muted" style="margin-top:4px">Only if you're at the scene. Saved with the report and printed as a map link.</div>`}</div>
    <label class="f" style="margin-top:12px" for="i-weather">Weather</label>
    <input class="t" id="i-weather" data-f="weather" value="${esc(d.weather)}" placeholder="e.g. Clear, dry">
    <div class="chips" style="margin-top:8px">${WEATHER.map((w) => `<button type="button" data-weather="${w}">${w}</button>`).join("")}</div></div>`;
}

function driverHtml() {
  const other = d.driverId === "other";
  return `<div class="card"><label class="f" for="i-driver">Driver (our employee)</label>
    <select class="t" id="i-driver"><option value="">Pick the driver…</option>
      ${ctx.people.map((p) => `<option value="${p.id}"${String(d.driverId) === String(p.id) ? " selected" : ""}>${esc(p.name)}</option>`).join("")}
      <option value="other"${other ? " selected" : ""}>Someone else (type the name)</option></select>
    ${other ? `<div style="margin-top:10px">${txt("driverName", "Driver's name")}</div>` : ""}
    <div class="fields" style="margin-top:12px">${txt("employeeManager", "Employee's manager")}${txt("department", "Department")}</div>
    <p class="small muted" style="margin:10px 0 0">The driver's home address, birth date, license and employee ID aren't kept in the app; they print blank.</p>
    <div class="fields" style="margin-top:12px">${yn("passengers", "Passengers?")}${yn("seatbelt", "Driver wearing a seatbelt?")}</div>
    ${d.passengers === "yes" ? `<div class="fields" style="margin-top:12px">${txt("passengerNames", "Passenger names")}${yn("seatbeltPass", "Passengers wearing seatbelts?")}</div>` : ""}</div>`;
}

function policeHtml() {
  return `<div class="card">${yn("police", "Police at the scene?")}
    ${d.police === "yes" ? `<div class="fields" style="margin-top:12px">${txt("policeDept", "Police department")}${txt("policePhone", "Phone", { type: "tel" })}
      ${txt("officer", "Officer name")}${txt("reportNo", "Report number", { cap: "characters" })}
      ${yn("citeDriver", "Citation issued to our driver?")}${yn("citeOther", "Citation issued to the other party?")}</div>` : ""}</div>`;
}

function injuryHtml() {
  const emp = d.injured === "yes" && d.empInjured === "yes";
  return `<div class="card">${yn("injured", "Anyone injured?")}
    ${d.injured === "yes" ? `<div style="margin-top:12px">${area("injuryDesc", "Describe the injuries", "Who was hurt and how")}</div>
      <div class="fields" style="margin-top:12px">${yn("empInjured", "Was our employee hurt?")}${emp ? yn("medEval", "Taken to a clinic or hospital?") : "<div></div>"}
        ${emp && d.medEval === "yes" ? txt("clinic", "Clinic or hospital") : ""}</div>
      ${emp ? `<div class="banner info" style="margin:12px 0 0">The PDF will include the Employee Injury/Near Miss Report${d.medEval !== "yes"
        ? " and the Refusal of Medical Treatment" : ""} to fill in by hand.</div>` : ""}` : ""}
    <div class="fields" style="margin-top:12px">${yn("adTest", "Drug and alcohol test?")}${d.adTest === "yes" ? txt("adClinic", "Test clinic") : "<div></div>"}</div></div>`;
}

function truckHtml() {
  return `<div class="card"><div class="fields">${yn("drivable", "Truck drivable?")}${d.drivable === "no" ? txt("towedTo", "Towed to") : "<div></div>"}</div>
      <div class="toggle" style="margin-top:14px"><div><b>Trailer involved?</b><div class="small muted">Adds the trailer picture for its damage</div></div>
      <button type="button" class="sw ${d.trailerOn ? "on" : ""}" id="trlSw" role="switch" aria-checked="${d.trailerOn}" aria-label="Trailer involved"></button></div>
      ${d.trailerOn ? `<div style="margin-top:10px">${txt("trailerNo", "Trailer number", { cap: "characters" })}</div>` : ""}</div>
    <div class="card" id="dia-truck">${diagramHtml("truck")}</div>
    ${d.trailerOn ? `<div class="card" id="dia-trailer">${diagramHtml("trailer")}</div>` : ""}
    <div class="card">${area("damageGc", "Damage to our truck, in words", "e.g. Front bumper pushed in, headlight broken", 2)}</div>`;
}

function diagramHtml(kind) {
  const src = kind === "truck" ? ctx.vehicle.diagram_url : ctx.trailerDiagramUrl;
  if (!src) return `<div class="empty">No ${kind} picture on file. Describe the damage in words below.</div>`;
  const pins = d.damage.filter((m) => m.diagram === kind);
  const old = ctx.onFile.filter((m) => m.diagram === kind);
  return `<div class="small" style="font-weight:650;margin-bottom:6px">${kind === "truck" ? "Truck" : "Trailer"} damage</div>
    <div class="diagram" data-dia="${kind}"><img src="${esc(src)}" alt="${kind} diagram" draggable="false">
      ${old.map((p) => `<span class="pin old" style="left:${p.x * 100}%;top:${p.y * 100}%">${p.n}</span>`).join("")}
      ${pins.map((p, i) => `<span class="pin" style="left:${p.x * 100}%;top:${p.y * 100}%">${i + 1}</span>`).join("")}</div>
    <div class="small muted" style="margin-top:6px">Tap the picture where the accident damaged it.${old.length ? " Grey dots = damage already on file." : ""}
      Each mark goes on the truck's damage on file and repairs until it's fixed.</div>
    <div class="pinlist">${pins.map((p, i) => {
      const n = d.photos.filter((ph) => ph.damageKey === p.key).length;
      return `<div class="p"><span class="num">${i + 1}</span>
        <input class="t" data-pn="${p.key}" placeholder="Describe damage (e.g. bumper pushed in)" value="${esc(p.note)}">
        <label class="cam" aria-label="Add photo of damage ${i + 1}">📷<input type="file" accept="image/*" data-pcam="${p.key}">${n ? `<span class="cnt">${n}</span>` : ""}</label>
        <button type="button" class="x" data-px="${p.key}" aria-label="Remove mark ${i + 1}">×</button></div>`;
    }).join("")}</div>`;
}

function partiesHtml() {
  let h = d.parties.map((p, i) => {
    const n = d.photos.filter((ph) => ph.party === i).length;
    return `<div class="card"><div class="spread"><b>Other party ${i + 1}</b><button type="button" class="link danger" data-prm="${i}">Remove</button></div>
      <div class="fields" style="margin-top:8px">${PARTY.map(([k, label]) => `<div><label class="f" for="p${i}-${k}">${label}</label>
        <input class="t" id="p${i}-${k}" data-pf="${i}|${k}" value="${esc(p[k] || "")}"${["license_no", "plate_no", "plate_state", "state", "policy_no"].includes(k) ? ` autocapitalize="characters"` : ""}${
          k.endsWith("phone") ? ` type="tel"` : ""}${["zip", "vehicle_year"].includes(k) ? ` inputmode="numeric"` : ""}></div>`).join("")}
        ${yn(`p${i}`, "Passengers in their vehicle?", p.passengers, "data-pyn")}</div>
      <label class="secondary wide" style="margin-top:12px">📷 Photo of their license, insurance card or plate${n ? ` (${n})` : ""}
        <input type="file" accept="image/*" multiple data-partycam="${i}" hidden></label></div>`;
  }).join("");
  h += `<button type="button" class="secondary wide" id="addParty" style="margin-bottom:12px">+ Add ${d.parties.length ? "another" : "the other"} party</button>`;
  if (d.parties.length) {
    h += `<div class="card">${area("damageOther", "Damage to their vehicle", "", 2)}
      <div style="margin-top:12px">${area("otherMarks", "Distinguishable marks on their vehicle", "", 2)}</div>
      <div style="margin-top:12px">${area("otherAppearance", "Their appearance / concerns", "", 2)}</div></div>`;
  } else {
    h += `<p class="small muted" style="margin:0 4px 12px">No other vehicle? Leave this empty.</p>`;
  }
  return h;
}

function witnessesHtml() {
  return d.witnesses.map((w, i) => `<div class="card"><div class="spread"><b>Witness ${i + 1}</b><button type="button" class="link danger" data-wrm="${i}">Remove</button></div>
      <div class="fields" style="margin-top:8px">${WITNESS.map(([k, label]) => `<div><label class="f" for="w${i}-${k}">${label}</label>
        <input class="t" id="w${i}-${k}" data-wf="${i}|${k}" value="${esc(w[k] || "")}"${k === "phone" ? ` type="tel"` : ""}${k === "zip" ? ` inputmode="numeric"` : ""}></div>`).join("")}</div></div>`).join("")
    + `<button type="button" class="secondary wide" id="addWitness" style="margin-bottom:12px">+ Add ${d.witnesses.length ? "another" : "a"} witness</button>`;
}

function mapHtml() {
  const m = d.photos.find((p) => p.map);
  return m
    ? `<label class="f">Map</label><div class="photos"><div class="ph"><img alt="Map" data-pid="${m.id}"${blobUrls.has(m.id) ? ` src="${blobUrls.get(m.id)}"` : ""}>
        ${m.uploaded ? "" : `<div class="state">${navigator.onLine ? `<span class="spinner"></span>` : "Saved on phone"}</div>`}
        <button type="button" class="x" data-phx="${m.id}" aria-label="Remove map">×</button></div></div>`
    : `<label class="secondary wide">🗺️ Add a map screenshot<input type="file" accept="image/*" id="mapIn" hidden></label>
      <div class="small muted" style="margin-top:4px">Take a screenshot in Google Maps of where it happened, then add it here.</div>`;
}

function photoTag(p) {
  if (p.damageKey) {
    const m = d.damage.find((x) => x.key === p.damageKey);
    if (m) return `${m.diagram === "trailer" ? "Trailer damage" : "Damage"} ${d.damage.filter((x) => x.diagram === m.diagram).indexOf(m) + 1}`;
  }
  if (p.party != null && d.parties[p.party]) return `Other party ${p.party + 1}`;
  return "";
}

function photosHtml() {
  return d.photos.filter((p) => !p.map).map((p) => {
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

const SECTIONS = { when: whenHtml, where: whereHtml, driver: driverHtml, police: policeHtml, injury: injuryHtml, truck: truckHtml,
  parties: partiesHtml, witnesses: witnessesHtml, map: mapHtml };
function redraw(...names) {
  for (const n of names) {
    const el = $(`#sec-${n}`);
    if (el) el.innerHTML = SECTIONS[n]();
  }
  loadThumbs();
}
const redrawPhotos = () => {
  const el = $("#photos");
  if (el) el.innerHTML = photosHtml();
  redraw("map");
};

// ---------- Input ----------

function bind() {
  const app = ctx.app;
  $("#save").onclick = save;
  pads = [
    setupSig($("#sketch"), { get: () => d.sketch, set: (v) => { d.sketch = v; changed(); } }),
    setupSig($("#sigDriver"), { get: () => d.driverSig, set: (v) => { d.driverSig = v; changed(); } }),
    setupSig($("#sigRep"), { get: () => d.reporterSig, set: (v) => { d.reporterSig = v; changed(); } }),
  ];
  $("#sketchClr").onclick = () => pads[0].clear();
  $("#sigDriverClr").onclick = () => pads[1].clear();
  $("#sigRepClr").onclick = () => pads[2].clear();

  app.onclick = (e) => {
    const t = e.target;
    const ynb = t.closest("[data-yn]");
    if (ynb) {
      const [field, val] = ynb.dataset.yn.split("|");
      d[field] = d[field] === val ? null : val;
      const sec = { onJob: "where", passengers: "driver", seatbelt: "driver", seatbeltPass: "driver", police: "police", citeDriver: "police",
        citeOther: "police", injured: "injury", empInjured: "injury", medEval: "injury", adTest: "injury", drivable: "truck" }[field];
      redraw(sec);
      return changed();
    }
    const pyn = t.closest("[data-pyn]");
    if (pyn) {
      const [f, val] = pyn.dataset.pyn.split("|");
      const p = d.parties[Number(f.slice(1))];
      p.passengers = p.passengers === val ? null : val;
      redraw("parties");
      return changed();
    }
    const flag = t.closest("[data-flag]");
    if (flag) {
      d[flag.dataset.flag] = !d[flag.dataset.flag];
      redraw("when");
      return changed();
    }
    const w = t.closest("[data-weather]");
    if (w) {
      d.weather = d.weather ? `${d.weather}, ${w.dataset.weather.toLowerCase()}` : w.dataset.weather;
      $("#i-weather").value = d.weather;
      return changed();
    }
    if (t.closest("#gpsBtn")) return locate(t.closest("#gpsBtn"));
    if (t.closest("#gpsClr")) { d.gps = null; redraw("where"); return changed(); }
    if (t.closest("#trlSw")) { d.trailerOn = !d.trailerOn; redraw("truck"); return changed(); }
    if (t.closest("#addParty")) {
      d.parties.push({ passengers: null });
      redraw("parties");
      $(`#p${d.parties.length - 1}-name`)?.focus();
      return changed();
    }
    const prm = t.closest("[data-prm]");
    if (prm) {
      const i = Number(prm.dataset.prm);
      d.parties.splice(i, 1);
      d.photos.forEach((p) => { if (p.party === i) p.party = null; else if (p.party > i) p.party--; });
      redraw("parties");
      redrawPhotos();
      return changed();
    }
    if (t.closest("#addWitness")) {
      d.witnesses.push({});
      redraw("witnesses");
      $(`#w${d.witnesses.length - 1}-name`)?.focus();
      return changed();
    }
    const wrm = t.closest("[data-wrm]");
    if (wrm) { d.witnesses.splice(Number(wrm.dataset.wrm), 1); redraw("witnesses"); return changed(); }
    const px = t.closest("[data-px]");
    if (px) {
      const m = d.damage.find((x) => x.key === px.dataset.px);
      d.damage = d.damage.filter((x) => x !== m);
      d.photos.forEach((p) => { if (p.damageKey === m.key) p.damageKey = null; });
      redraw("truck");
      redrawPhotos();
      return changed();
    }
    const phx = t.closest("[data-phx]");
    if (phx) {
      const id = phx.dataset.phx;
      d.photos = d.photos.filter((p) => p.id !== id);
      deletePhotoBlob(id).catch(() => {});
      redrawPhotos();
      redraw("truck", "parties");
      return changed();
    }
    const dia = t.closest("[data-dia]");
    if (dia) {
      const r = dia.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      const key = uuid().slice(0, 8);
      d.damage.push({ key, diagram: dia.dataset.dia, x: +x.toFixed(4), y: +y.toFixed(4), note: "" });
      redraw("truck");
      $(`[data-pn="${key}"]`)?.focus({ preventScroll: true });
      return changed();
    }
  };

  app.oninput = (e) => {
    const t = e.target;
    if (t.dataset.f) { d[t.dataset.f] = t.value; return changed(); }
    if (t.dataset.pf) { const [i, k] = t.dataset.pf.split("|"); d.parties[i][k] = t.value; return changed(); }
    if (t.dataset.wf) { const [i, k] = t.dataset.wf.split("|"); d.witnesses[i][k] = t.value; return changed(); }
    if (t.dataset.pn) { d.damage.find((m) => m.key === t.dataset.pn).note = t.value; return changed(); }
    if (t.dataset.phc) { d.photos.find((p) => p.id === t.dataset.phc).caption = t.value; return changed(); }
  };

  app.onchange = (e) => {
    const t = e.target;
    if (t.id === "i-driver") {
      d.driverId = t.value;
      const p = ctx.people.find((x) => String(x.id) === t.value);
      d.driverName = p ? p.name : t.value === "other" ? "" : "";
      redraw("driver");
      if (t.value === "other") $("#i-driverName")?.focus();
      return changed();
    }
    if (t.type !== "file" || !t.files?.length) return;
    const files = [...t.files];
    t.value = "";
    if (t.id === "phIn") addPhotos(files, {});
    else if (t.id === "mapIn") addPhotos(files.slice(0, 1), { map: true, caption: "Map" });
    else if (t.dataset.pcam) addPhotos(files, { damageKey: t.dataset.pcam });
    else if (t.dataset.partycam) addPhotos(files, { party: Number(t.dataset.partycam) });
  };
}

function locate(btn) {
  if (!navigator.geolocation) return toast("This phone can't share its location.", 4000);
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>&nbsp;Finding you…`;
  navigator.geolocation.getCurrentPosition((pos) => {
    if (!d) return;
    d.gps = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), acc: pos.coords.accuracy ?? null };
    redraw("where");
    changed();
  }, (err) => {
    if (!d) return;
    redraw("where");
    toast(err.code === 1 ? "Location is turned off for this site. Type the address instead." : "Couldn't get a location. Type the address instead.", 4500);
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
}

async function addPhotos(files, link) {
  for (const f of files) {
    const id = uuid();
    const blob = await shrinkImage(f);
    if (!d) return;
    await storePhotoBlob(id, blob);
    blobUrls.set(id, URL.createObjectURL(blob));
    if (link.map) {
      for (const old of d.photos.filter((p) => p.map)) deletePhotoBlob(old.id).catch(() => {});
      d.photos = d.photos.filter((p) => !p.map);
    }
    d.photos.push({ id, caption: link.caption || "", uploaded: false, damageKey: link.damageKey || null, party: link.party ?? null, map: !!link.map });
    changed();
  }
  redrawPhotos();
  if (link.damageKey) redraw("truck");
  if (link.party != null) redraw("parties");
  toast(files.length > 1 ? `${files.length} photos added` : link.map ? "Map added" : "Photo added");
  uploadPhotos();
}

let uploadingNow = false;
async function uploadPhotos() {
  if (!d || uploadingNow || !d.photos.some((p) => !p.uploaded)) return;
  uploadingNow = true;
  try {
    persist.flush();
    await saveIncDraft(d);
    await syncIncPhotos(d.key);
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    uploadingNow = false;
  }
  if (d) redrawPhotos();
}

// ---------- Checking and saving ----------

function missingList() {
  const miss = [];
  if (!d.date) miss.push({ label: "date", sel: "#i-date" });
  if (!d.driverName.trim()) miss.push({ label: "driver", sel: d.driverId === "other" ? "#i-driverName" : "#i-driver" });
  if (!d.injured) miss.push({ label: "anyone injured?", sel: "#yn-injured" });
  if (!d.description.trim()) miss.push({ label: "what happened", sel: "#i-description" });
  if (!d.reporterName.trim()) miss.push({ label: "reporting manager", sel: "#i-reporterName" });
  if (!d.reporterSig) miss.push({ label: "manager signature", sel: "#sigRep" });
  return miss;
}

function updateProgress() {
  const t = $("#progTxt");
  if (!t || !d) return;
  const need = 6;
  const left = missingList().length;
  t.textContent = left ? `${need - left} of ${need} required` : `Ready to save${d.damage.length ? ` · ${d.damage.length} damage mark${d.damage.length === 1 ? "" : "s"}` : ""}`;
  $("#progFill").style.width = `${((need - left) / need) * 100}%`;
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

const b = (v) => (v === "yes" ? true : v === "no" ? false : null);
const clean = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? v.trim() || null : v]));

function buildPayload() {
  const damage = d.damage.filter((m) => m.diagram === "truck" || d.trailerOn);
  const keys = new Set(damage.map((m) => m.key));
  const injured = d.injured === "yes";
  const emp = injured && d.empInjured === "yes";
  return clean({
    client_id: d.clientId,
    vehicle_id: d.vehicleId,
    trailer: d.trailerOn ? { number: d.trailerNo.trim() || null } : null,
    truck_diagram_id: ctx.vehicle.diagram_id ?? null,
    trailer_diagram_id: d.trailerOn ? ctx.vehicle.trailer_diagram_id ?? null : null,
    incident_date: d.date,
    incident_time: d.time || null,
    property_damage: d.propertyDamage,
    theft_vandalism: d.theft,
    location_name: d.locationName, on_job: b(d.onJob), site_name: d.onJob === "yes" ? d.siteName : null,
    street: d.street, city: d.city, state: d.state, zip: d.zip, weather: d.weather,
    latitude: d.gps?.lat ?? null, longitude: d.gps?.lng ?? null, location_accuracy_m: d.gps?.acc != null ? Math.round(d.gps.acc) : null,
    driver_user_id: /^\d+$/.test(String(d.driverId)) ? Number(d.driverId) : null,
    driver_name: d.driverName,
    employee_manager: d.employeeManager, department: d.department,
    passengers: b(d.passengers), passenger_names: d.passengers === "yes" ? d.passengerNames : null,
    seatbelt_driver: b(d.seatbelt), seatbelt_passenger: d.passengers === "yes" ? b(d.seatbeltPass) : null,
    police_present: b(d.police),
    police_department: d.police === "yes" ? d.policeDept : null, police_phone: d.police === "yes" ? d.policePhone : null,
    officer_name: d.police === "yes" ? d.officer : null, police_report_no: d.police === "yes" ? d.reportNo : null,
    citation_driver: d.police === "yes" ? b(d.citeDriver) : null, citation_other: d.police === "yes" ? b(d.citeOther) : null,
    anyone_injured: b(d.injured),
    injury_description: injured ? d.injuryDesc : null,
    employee_injured: injured ? b(d.empInjured) : false,
    medical_evaluation: emp ? b(d.medEval) : null,
    medical_clinic: emp && d.medEval === "yes" ? d.clinic : null,
    ad_test: b(d.adTest), ad_clinic: d.adTest === "yes" ? d.adClinic : null,
    drivable: b(d.drivable), towed_to: d.drivable === "no" ? d.towedTo : null,
    damage_gc: d.damageGc,
    other_parties: d.parties.map((p) => clean({ ...Object.fromEntries(PARTY.map(([k]) => [k, p[k] || ""])), passengers: b(p.passengers) })),
    damage_other: d.parties.length ? d.damageOther : null,
    other_marks: d.parties.length ? d.otherMarks : null,
    other_appearance: d.parties.length ? d.otherAppearance : null,
    witnesses: d.witnesses.map((w) => clean(Object.fromEntries(WITNESS.map(([k]) => [k, w[k] || ""])))),
    description: d.description,
    manager_comments: d.comments, preventive_measures: d.preventive,
    damage: damage.map((m) => ({ key: m.key, diagram: m.diagram, x: m.x, y: m.y, note: m.note.trim() || null })),
    photos: d.photos.map((p) => ({
      id: p.id,
      caption: [p.party != null && d.parties[p.party] ? `Other party ${p.party + 1}` : "", p.caption.trim()].filter(Boolean).join(": ") || null,
      damage_key: p.damageKey && keys.has(p.damageKey) ? p.damageKey : null,
      map: !!p.map,
    })),
    sketch: d.sketch,
    driver_signature: d.driverSig,
    reporter_name: d.reporterName,
    reporter_signature: d.reporterSig,
  });
}

async function save() {
  if (saving || !d) return;
  const err = $("#formErr");
  const miss = missingList();
  highlight(miss);
  if (miss.length) {
    err.innerHTML = `<div class="banner err"><b>Still needed:</b> <span>${esc(miss.map((m) => m.label).join(", "))}.</span></div>`;
    err.dataset.missing = "1";
    ($(miss[0].sel.split(",")[0]) || err).scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  saving = true;
  err.innerHTML = "";
  delete err.dataset.missing;
  const btn = $("#save");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>&nbsp;Saving…`;

  const { key, vehicleId } = d;
  d.payload = buildPayload();
  d.status = "queued";
  d.queuedAt = Date.now();
  d.lastError = null;
  d.touched = true;
  persist.flush();
  await saveIncDraft(d);

  const r = await sendInc(key);
  saving = false;
  if (r.state === "sent") {
    setActiveInc(null);
    d = null;
    toast(`Incident report saved ✓${r.res.damage ? ` ${r.res.damage === 1 ? "Its damage is" : `Its ${r.res.damage} damage marks are`} on the truck's repairs.` : ""}`, 4500);
    location.hash = `#/incident/${r.res.id}`;
  } else if (r.state === "waiting") {
    toast("Saved on phone, not yet uploaded. It will send by itself when signal returns.", 5000);
    flushInc();
    location.hash = `#/truck/${vehicleId}`;
  } else if (r.state === "rejected" && d) {
    btn.disabled = false;
    btn.textContent = "Save report";
    err.innerHTML = `<div class="banner err">${esc(r.error.message)}</div>`;
    err.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/** Throw away a draft report (from the truck page). */
export async function discardIncDraft(vehicleId) {
  const dr = await getIncDraft(incKey(vehicleId));
  if (dr && dr.status !== "queued") await deleteIncDraft(dr);
}

