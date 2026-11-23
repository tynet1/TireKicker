// The yard walk form (supervisors): the yard's checklist with OK / Repair, a note and photos for each problem,
// comments and a signature. Everything typed is saved to the phone as you go; Save queues it for upload, like the
// truck inspection form.
import { api } from "../api.js";
import { deletePhotoBlob, photoBlob, storePhotoBlob } from "../drafts.js";
import { idb } from "../idb.js";
import { setupSig } from "../sig.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { $, $$, debounce, esc, shrinkImage, toast, today, uuid } from "../util.js";
import {
  deleteYardDraft, flushYard, getYardDraft, saveYardDraft, sendYard, setActiveYard, syncYardPhotos, yardKey,
} from "../yardq.js";

let d = null;   // the draft being edited
let ctx = null; // { app, yard, sections: [{key,title,items}], asOf, persistent }
let sigPad = null;
let saving = false;
const blobUrls = new Map();
const persist = debounce(() => { if (d && d.touched) saveYardDraft(d); }, 400);
const onVis = () => { if (document.visibilityState === "hidden") persist.flush(); };
const onOnline = () => uploadPhotos();

function changed() {
  if (!d) return;
  d.touched = true;
  persist();
  updateProgress();
}

export async function render(app, yardId) {
  const nav = state.nav;
  setHeader({ title: "Yard walk", back: `#/yard/${yardId}` });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let yards, config;
  try {
    [yards, config] = await Promise.all([api("/yards"), api("/yard-config")]);
  } catch (e) {
    if (stale(nav)) return;
    const msg = e.status === 0
      ? "Can't load the yard checklist without signal. Open it once while you have signal; after that it works offline."
      : e.message;
    app.innerHTML = errorHtml(new Error(msg)) + `<a class="secondary" href="#/yard/${yardId}">Back</a>`;
    return;
  }
  if (stale(nav)) return;
  const yard = yards.find((y) => String(y.id) === String(yardId));
  if (!yard) { app.innerHTML = errorHtml(new Error("That yard isn't in use.")); return; }

  const key = yardKey(yard.id);
  let draft = await getYardDraft(key);
  if (draft?.status === "queued") return void location.replace(`#/yard/${yard.id}`);
  if (!draft) {
    draft = {
      key, yardId: yard.id, yardName: yard.name, clientId: uuid(), status: "editing", startedAt: Date.now(), touched: false,
      date: today(), inspector: state.user?.name || "", answers: {}, comments: "", photos: [], sig: null, lastError: null,
    };
  }
  d = draft;
  setActiveYard(d);
  ctx = {
    app, yard,
    sections: config.sections.map((s) => ({ ...s, items: config.checklist.filter((c) => c.section === s.key) })).filter((s) => s.items.length),
    asOf: config.as_of || null,
    persistent: await idb.isPersistent(),
  };
  setHeader({ title: d.touched ? "Yard walk draft" : "Yard walk", sub: yard.name, back: `#/yard/${yard.id}` });
  draw();
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("online", onOnline);
  uploadPhotos();
}

export async function leave() {
  document.removeEventListener("visibilitychange", onVis);
  window.removeEventListener("online", onOnline);
  persist.flush();
  for (const u of blobUrls.values()) URL.revokeObjectURL(u);
  blobUrls.clear();
  setActiveYard(null);
  d = null;
  ctx = null;
  saving = false;
}

const allItems = () => ctx.sections.flatMap((s) => s.items);
const itemById = (id) => allItems().find((it) => it.id === Number(id));

// ---------- Drawing ----------

function draw() {
  let h = "";
  if (d.lastError) h += `<div class="banner err"><b>The server didn't accept this walk:</b> ${esc(d.lastError)}<br>Fix it below and tap Save again.</div>`;
  if (!ctx.persistent) h += `<div class="banner info">This browser can't keep drafts after it's closed (private browsing?). Finish and save before closing it.</div>`;
  h += `<div class="card" style="margin-top:14px"><div class="fields">
    <div><label class="f" for="y-date">Date</label><input class="t" type="date" id="y-date" value="${esc(d.date)}" max="${today()}"></div>
    <div><label class="f" for="y-insp">Inspector</label><input class="t" id="y-insp" value="${esc(d.inspector)}" autocomplete="name"></div>
  </div></div>`;
  h += `<h2>Checklist</h2>${ctx.sections.map(sectionHtml).join("")}`;
  h += `<h2>Photos</h2><div class="card"><div class="photos" id="photos">${photosHtml()}</div></div>`;
  h += `<h2>Comments</h2><div class="card"><textarea class="t" id="y-com" aria-label="Comments" placeholder="Anything else from the walk">${esc(d.comments)}</textarea></div>`;
  h += `<h2>Signature</h2><div class="card"><canvas class="sig" id="sig" aria-label="Signature pad"></canvas>
    <div class="spread" style="margin-top:6px"><span class="small muted">Sign with your finger</span><button type="button" class="link" id="sigClr">Clear</button></div></div>`;
  h += `<div id="formErr"></div>`;
  h += `<div class="bar"><div class="in"><div class="prog"><span id="progTxt"></span><div class="track"><div class="fill" id="progFill"></div></div></div>
    <button class="primary" id="save" type="button">Save yard walk</button></div></div>`;
  ctx.app.innerHTML = h;
  document.body.classList.add("has-bar");
  bind();
  updateProgress();
  loadThumbs();
}

function sectionHtml(sec) {
  return `<div class="card" id="sec-${sec.key}"><div class="sechead"><h3>${esc(sec.title)}</h3>
    <button type="button" class="link" data-allok="${sec.key}">Mark rest OK</button></div>
    ${sec.items.map((it) => {
      const a = d.answers[it.id] || {};
      const n = d.photos.filter((ph) => ph.itemId === it.id).length;
      return `<div class="check" id="row-${it.id}"><span class="lbl">${esc(it.label)}</span><span class="btns">
          <button type="button" class="okb ${a.r === "ok" ? "on" : ""}" data-set="${it.id}|ok" aria-pressed="${a.r === "ok"}">OK</button>
          <button type="button" class="rpb ${a.r === "repair" ? "on" : ""}" data-set="${it.id}|repair" aria-pressed="${a.r === "repair"}">Repair</button></span></div>
        ${a.r === "repair" ? `<div class="repairrow" id="rr-${it.id}"><input class="repairnote" data-rn="${it.id}" placeholder="What's wrong?" value="${esc(a.n || "")}" aria-label="Note for ${esc(it.label)}">
          <label class="cam" aria-label="Add photo">📷<input type="file" accept="image/*" data-icam="${it.id}">${n ? `<span class="cnt">${n}</span>` : ""}</label></div>` : ""}`;
    }).join("")}</div>`;
}

function photosHtml() {
  return d.photos.map((p) => {
    const tag = p.itemId ? `Repair: ${itemById(p.itemId)?.label || ""}` : "";
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

const redrawSection = (key) => {
  const el = $(`#sec-${key}`);
  const sec = ctx.sections.find((s) => s.key === key);
  if (el && sec) el.outerHTML = sectionHtml(sec);
};
const redrawPhotos = () => {
  const el = $("#photos");
  if (el) { el.innerHTML = photosHtml(); loadThumbs(); }
};

// ---------- Input ----------

function bind() {
  const app = ctx.app;
  $("#y-date").oninput = (e) => { d.date = e.target.value; changed(); };
  $("#y-insp").oninput = (e) => { d.inspector = e.target.value; changed(); };
  $("#y-com").oninput = (e) => { d.comments = e.target.value; changed(); };
  $("#save").onclick = save;
  sigPad = setupSig($("#sig"), { get: () => d.sig, set: (v) => { d.sig = v; changed(); } });
  $("#sigClr").onclick = () => sigPad.clear();

  app.onclick = (e) => {
    const t = e.target;
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
      const sec = ctx.sections.find((s) => s.key === all.dataset.allok);
      for (const it of sec.items) if (!d.answers[it.id]) d.answers[it.id] = { r: "ok", n: "" };
      redrawSection(sec.key);
      return changed();
    }
    const phx = t.closest("[data-phx]");
    if (phx) {
      const id = phx.dataset.phx;
      d.photos = d.photos.filter((p) => p.id !== id);
      deletePhotoBlob(id).catch(() => {});
      redrawPhotos();
      for (const s of ctx.sections) redrawSection(s.key);
      return changed();
    }
  };
  app.oninput = (e) => {
    const t = e.target;
    if (t.dataset.rn) { d.answers[t.dataset.rn].n = t.value; return changed(); }
    if (t.dataset.phc) { d.photos.find((p) => p.id === t.dataset.phc).caption = t.value; return changed(); }
  };
  app.onchange = (e) => {
    const t = e.target;
    if (t.type !== "file" || !t.files?.length) return;
    const files = [...t.files];
    t.value = "";
    addPhotos(files, t.dataset.icam ? Number(t.dataset.icam) : null);
  };
}

async function addPhotos(files, itemId) {
  for (const f of files) {
    const id = uuid();
    const blob = await shrinkImage(f);
    if (!d) return;
    await storePhotoBlob(id, blob);
    blobUrls.set(id, URL.createObjectURL(blob));
    d.photos.push({ id, caption: "", uploaded: false, itemId });
    changed();
    redrawPhotos();
  }
  if (itemId) redrawSection(itemById(itemId).section);
  toast(files.length > 1 ? `${files.length} photos added` : "Photo added");
  uploadPhotos();
}

let uploadingNow = false;
async function uploadPhotos() {
  if (!d || uploadingNow || !d.photos.some((p) => !p.uploaded)) return;
  uploadingNow = true;
  try {
    persist.flush();
    await saveYardDraft(d);
    await syncYardPhotos(d.key);
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
  if (!d.date) miss.push({ label: "date", sel: "#y-date" });
  if (!d.inspector.trim()) miss.push({ label: "inspector name", sel: "#y-insp" });
  const unanswered = allItems().filter((it) => !d.answers[it.id]);
  if (unanswered.length) {
    miss.push({ label: `${unanswered.length} checklist item${unanswered.length > 1 ? "s" : ""}`, sel: unanswered.map((it) => `#row-${it.id}`).join(",") });
  }
  for (const it of allItems()) {
    const a = d.answers[it.id];
    if (a?.r === "repair" && !a.n?.trim()) miss.push({ label: `note for “${it.label}”`, sel: `#rr-${it.id}` });
  }
  if (!d.sig) miss.push({ label: "signature", sel: "#sig" });
  return miss;
}

function updateProgress() {
  const t = $("#progTxt");
  if (!t || !d) return;
  const items = allItems();
  const done = items.filter((it) => d.answers[it.id]).length;
  const failed = items.filter((it) => d.answers[it.id]?.r === "repair").length;
  t.textContent = `${done} of ${items.length} items${failed ? ` · ${failed} to fix` : ""}`;
  $("#progFill").style.width = `${items.length ? (done / items.length) * 100 : 0}%`;
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
  const items = allItems();
  const repairIds = new Set(items.filter((it) => d.answers[it.id]?.r === "repair").map((it) => it.id));
  return {
    client_id: d.clientId,
    yard_id: d.yardId,
    inspection_date: d.date,
    inspector_name: d.inspector.trim(),
    comments: d.comments,
    checklist_as_of: ctx.asOf,
    items: items.map((it) => {
      const a = d.answers[it.id];
      return { checklist_item_id: it.id, result: a.r, note: a.r === "repair" ? a.n.trim() : null };
    }),
    photos: d.photos.map((p) => ({
      id: p.id, caption: p.caption || null, checklist_item_id: p.itemId && repairIds.has(p.itemId) ? p.itemId : null,
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
    ($(miss[0].sel.split(",")[0]) || err).scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  saving = true;
  err.innerHTML = "";
  delete err.dataset.missing;
  const btn = $("#save");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>&nbsp;Saving…`;

  const { key, yardId } = d;
  d.payload = buildPayload();
  d.status = "queued";
  d.queuedAt = Date.now();
  d.lastError = null;
  d.touched = true;
  persist.flush();
  await saveYardDraft(d);

  const app = ctx.app;
  const r = await sendYard(key);
  saving = false;
  if (r.state === "sent") {
    setActiveYard(null);
    d = null;
    toast(r.res.failed ? `Yard walk saved ✓ ${r.res.failed === 1 ? "1 item to fix is" : `${r.res.failed} items to fix are`} on the repairs board.` : "Yard walk saved ✓", 4500);
    location.hash = `#/yard-walk/${r.res.id}`;
  } else if (r.state === "waiting") {
    toast("Saved on phone, not yet uploaded. It will send by itself when signal returns.", 5000);
    flushYard();
    location.hash = `#/yard/${yardId}`;
  } else if (r.state === "rejected" && d) {
    btn.disabled = false;
    btn.textContent = "Save yard walk";
    const details = r.error.details || {};
    err.innerHTML = `<div class="banner err">${esc(r.error.message)}</div>`;
    if (details.code === "checklist_changed") {
      toast("The yard checklist was updated. Reloading the form…");
      const nav = state.nav;
      setTimeout(async () => {
        if (stale(nav)) return;
        await leave();
        render(app, yardId);
      }, 1200);
    } else if (details.missing) {
      highlight(details.missing.map((id) => ({ sel: `#row-${id}` })));
    }
    err.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/** Throw away a draft walk (from the yard page). */
export async function discardYardDraft(yardId) {
  const dr = await getYardDraft(yardKey(yardId));
  if (dr && dr.status !== "queued") await deleteYardDraft(dr);
}
