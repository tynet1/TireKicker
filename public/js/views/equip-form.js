// The equipment check form (shop, supervisors): every piece on one trailer, each on its checklist ("All equipment" plus
// its type's part) with OK / Repair, a note and photos for each problem, or marked "Not here". Saved to the phone as
// you go; Save queues it for upload, like the other forms.
import { api } from "../api.js";
import { deletePhotoBlob, photoBlob, storePhotoBlob } from "../drafts.js";
import { idb } from "../idb.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { $, $$, debounce, esc, shrinkImage, toast, today, uuid } from "../util.js";
import {
  deleteEquipDraft, equipKey, flushEquip, getEquipDraft, saveEquipDraft, sendEquip, setActiveEquip, syncEquipPhotos,
} from "../equipq.js";

let d = null;   // the draft
let ctx = null; // { app, trailerKey, title, pieces, checklist, sections, asOf, persistent }
let saving = false;
const blobUrls = new Map();
const persist = debounce(() => { if (d && d.touched) saveEquipDraft(d); }, 400);
const onVis = () => { if (document.visibilityState === "hidden") persist.flush(); };
const onOnline = () => uploadPhotos();

function changed() {
  if (!d) return;
  d.touched = true;
  persist();
  updateProgress();
}

export async function render(app, trailerKey) {
  const nav = state.nav;
  setHeader({ title: "Equipment check", back: "#/equipment" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let config;
  try {
    config = await api(`/equipment-config/${trailerKey}`);
  } catch (e) {
    if (stale(nav)) return;
    const msg = e.status === 0
      ? "Can't load this trailer's equipment without signal. Open it once while you have signal; after that it works offline."
      : e.message;
    app.innerHTML = errorHtml(new Error(msg)) + `<a class="secondary" href="#/equipment">Back</a>`;
    return;
  }
  if (stale(nav)) return;
  const title = config.trailer ? config.trailer.trailer_number : "Not on a trailer";
  const key = equipKey(trailerKey);
  let draft = await getEquipDraft(key);
  if (draft?.status === "queued") return void location.replace("#/equipment");
  if (!draft) {
    draft = {
      key, trailerKey, trailerId: config.trailer?.id ?? null, title, clientId: uuid(), status: "editing", startedAt: Date.now(),
      touched: false, date: today(), checker: state.user?.name || "", comments: "", pieces: {}, photos: [], lastError: null,
    };
  }
  // Pieces on the trailer now; a piece moved off it since the draft started drops out of the check.
  for (const p of config.pieces) if (!draft.pieces[p.id]) draft.pieces[p.id] = { status: "checked", note: "", answers: {} };
  d = draft;
  setActiveEquip(d);
  ctx = {
    app, trailerKey, title, pieces: config.pieces,
    sectionTitle: Object.fromEntries(config.sections.map((s) => [s.key, s.title])),
    itemsFor: (type) => config.checklist.filter((c) => c.section === "all" || c.section === type),
    asOf: config.as_of || null,
    persistent: await idb.isPersistent(),
  };
  setHeader({ title: d.touched ? "Equipment check draft" : "Equipment check", sub: title, back: "#/equipment" });
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
  setActiveEquip(null);
  d = null;
  ctx = null;
  saving = false;
}

const pieceById = (id) => ctx.pieces.find((p) => p.id === Number(id));

// ---------- Drawing ----------

function draw() {
  let h = "";
  if (d.lastError) h += `<div class="banner err"><b>The server didn't accept this check:</b> ${esc(d.lastError)}<br>Fix it below and tap Save again.</div>`;
  if (!ctx.persistent) h += `<div class="banner info">This browser can't keep drafts after it's closed (private browsing?). Finish and save before closing it.</div>`;
  h += `<div class="card" style="margin-top:14px"><div class="fields">
    <div><label class="f" for="e-date">Date</label><input class="t" type="date" id="e-date" value="${esc(d.date)}" max="${today()}"></div>
    <div><label class="f" for="e-by">Checked by</label><input class="t" id="e-by" value="${esc(d.checker)}" autocomplete="name"></div>
  </div></div>`;
  h += ctx.pieces.map(pieceHtml).join("");
  h += `<h2>Comments</h2><div class="card"><textarea class="t" id="e-com" aria-label="Comments" placeholder="Anything else">${esc(d.comments)}</textarea></div>`;
  h += `<div id="formErr"></div>`;
  h += `<div class="bar"><div class="in"><div class="prog"><span id="progTxt"></span><div class="track"><div class="fill" id="progFill"></div></div></div>
    <button class="primary" id="save" type="button">Save check</button></div></div>`;
  ctx.app.innerHTML = h;
  document.body.classList.add("has-bar");
  bind();
  updateProgress();
  loadThumbs();
}

function pieceHtml(p) {
  const st = d.pieces[p.id];
  const here = st.status === "checked";
  const items = ctx.itemsFor(p.type);
  return `<div class="card" id="pc-${p.id}"><div class="sechead"><h3>${esc(p.tag)} <span class="muted" style="font-weight:500">${esc(p.type_title)}</span></h3>
      ${here ? `<button type="button" class="link" data-allok="${p.id}">Mark rest OK</button>` : ""}</div>
    <div class="toggle" style="padding-top:0"><div><b>Here today?</b><div class="small muted">${esc([p.make, p.model].filter(Boolean).join(" "))}</div></div>
      <button type="button" class="sw ${here ? "on" : ""}" data-here="${p.id}" role="switch" aria-checked="${here}" aria-label="${esc(p.tag)} is here"></button></div>
    ${here ? items.map((it) => {
      const a = st.answers[it.id] || {};
      const n = d.photos.filter((ph) => ph.equipmentId === p.id && ph.itemId === it.id).length;
      return `<div class="check" id="row-${p.id}-${it.id}"><span class="lbl">${esc(it.label)}</span><span class="btns">
          <button type="button" class="okb ${a.r === "ok" ? "on" : ""}" data-set="${p.id}|${it.id}|ok" aria-pressed="${a.r === "ok"}">OK</button>
          <button type="button" class="rpb ${a.r === "repair" ? "on" : ""}" data-set="${p.id}|${it.id}|repair" aria-pressed="${a.r === "repair"}">Repair</button></span></div>
        ${a.r === "repair" ? `<div class="repairrow" id="rr-${p.id}-${it.id}"><input class="repairnote" data-rn="${p.id}|${it.id}" placeholder="What's wrong?" value="${esc(a.n || "")}" aria-label="Note for ${esc(it.label)}">
          <label class="cam" aria-label="Add photo">📷<input type="file" accept="image/*" data-icam="${p.id}|${it.id}">${n ? `<span class="cnt">${n}</span>` : ""}</label></div>
          ${photosFor(p.id, it.id)}` : ""}`;
    }).join("") : `<input class="t" data-pnote="${p.id}" placeholder="Where is it? (optional)" value="${esc(st.note || "")}" aria-label="Where ${esc(p.tag)} is">`}
  </div>`;
}

function photosFor(pieceId, itemId) {
  const list = d.photos.filter((ph) => ph.equipmentId === pieceId && ph.itemId === itemId);
  if (!list.length) return "";
  return `<div class="photos" style="margin:6px 0 4px">${list.map((ph) => `<div class="ph" data-ph="${ph.id}">
      <img alt="" data-pid="${ph.id}"${blobUrls.has(ph.id) ? ` src="${blobUrls.get(ph.id)}"` : ""}>
      ${ph.uploaded ? "" : `<div class="state">${navigator.onLine ? `<span class="spinner"></span>` : "Saved on phone"}</div>`}
      <button type="button" class="x" data-phx="${ph.id}" aria-label="Remove photo">×</button></div>`).join("")}</div>`;
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

const redrawPiece = (id) => {
  const el = $(`#pc-${id}`);
  const p = pieceById(id);
  if (el && p) { el.outerHTML = pieceHtml(p); loadThumbs(); }
};

// ---------- Input ----------

function bind() {
  const app = ctx.app;
  $("#e-date").oninput = (e) => { d.date = e.target.value; changed(); };
  $("#e-by").oninput = (e) => { d.checker = e.target.value; changed(); };
  $("#e-com").oninput = (e) => { d.comments = e.target.value; changed(); };
  $("#save").onclick = save;

  app.onclick = (e) => {
    const t = e.target;
    const here = t.closest("[data-here]");
    if (here) {
      const st = d.pieces[here.dataset.here];
      st.status = st.status === "checked" ? "not_here" : "checked";
      redrawPiece(here.dataset.here);
      return changed();
    }
    const set = t.closest("[data-set]");
    if (set) {
      const [pid, iid, val] = set.dataset.set.split("|");
      const answers = d.pieces[pid].answers;
      const cur = answers[iid] || {};
      if (cur.r === val) delete answers[iid];
      else answers[iid] = { r: val, n: cur.n || "" };
      if (val === "ok" || cur.r === val) {
        for (const ph of d.photos.filter((x) => x.equipmentId === Number(pid) && x.itemId === Number(iid))) removePhoto(ph.id);
      }
      redrawPiece(pid);
      if (answers[iid]?.r === "repair") $(`[data-rn="${pid}|${iid}"]`)?.focus({ preventScroll: true });
      return changed();
    }
    const all = t.closest("[data-allok]");
    if (all) {
      const p = pieceById(all.dataset.allok);
      const answers = d.pieces[p.id].answers;
      for (const it of ctx.itemsFor(p.type)) if (!answers[it.id]) answers[it.id] = { r: "ok", n: "" };
      redrawPiece(p.id);
      return changed();
    }
    const phx = t.closest("[data-phx]");
    if (phx) {
      const ph = d.photos.find((x) => x.id === phx.dataset.phx);
      removePhoto(phx.dataset.phx);
      if (ph) redrawPiece(ph.equipmentId);
      return changed();
    }
  };
  app.oninput = (e) => {
    const t = e.target;
    if (t.dataset.rn) {
      const [pid, iid] = t.dataset.rn.split("|");
      d.pieces[pid].answers[iid].n = t.value;
      return changed();
    }
    if (t.dataset.pnote) { d.pieces[t.dataset.pnote].note = t.value; return changed(); }
  };
  app.onchange = (e) => {
    const t = e.target;
    if (t.type !== "file" || !t.files?.length || !t.dataset.icam) return;
    const files = [...t.files];
    t.value = "";
    const [pid, iid] = t.dataset.icam.split("|").map(Number);
    addPhotos(files, pid, iid);
  };
}

function removePhoto(id) {
  d.photos = d.photos.filter((p) => p.id !== id);
  deletePhotoBlob(id).catch(() => {});
}

async function addPhotos(files, equipmentId, itemId) {
  for (const f of files) {
    const id = uuid();
    const blob = await shrinkImage(f);
    if (!d) return;
    await storePhotoBlob(id, blob);
    blobUrls.set(id, URL.createObjectURL(blob));
    d.photos.push({ id, caption: "", uploaded: false, equipmentId, itemId });
    changed();
  }
  redrawPiece(equipmentId);
  toast(files.length > 1 ? `${files.length} photos added` : "Photo added");
  uploadPhotos();
}

let uploadingNow = false;
async function uploadPhotos() {
  if (!d || uploadingNow || !d.photos.some((p) => !p.uploaded)) return;
  uploadingNow = true;
  try {
    persist.flush();
    await saveEquipDraft(d);
    await syncEquipPhotos(d.key);
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    uploadingNow = false;
  }
  if (d) for (const id of new Set(d.photos.map((p) => p.equipmentId))) redrawPiece(id);
}

// ---------- Checking and saving ----------

function missingList() {
  const miss = [];
  if (!d.date) miss.push({ label: "date", sel: "#e-date" });
  if (!d.checker.trim()) miss.push({ label: "who checked", sel: "#e-by" });
  for (const p of ctx.pieces) {
    const st = d.pieces[p.id];
    if (st.status !== "checked") continue;
    const open = ctx.itemsFor(p.type).filter((it) => !st.answers[it.id]);
    if (open.length) miss.push({ label: `${p.tag}: ${open.length} item${open.length > 1 ? "s" : ""}`, sel: open.map((it) => `#row-${p.id}-${it.id}`).join(",") });
    for (const it of ctx.itemsFor(p.type)) {
      const a = st.answers[it.id];
      if (a?.r === "repair" && !a.n?.trim()) miss.push({ label: `${p.tag}: note for “${it.label}”`, sel: `#rr-${p.id}-${it.id}` });
    }
  }
  return miss;
}

function updateProgress() {
  const t = $("#progTxt");
  if (!t || !d) return;
  let total = 0, done = 0, problems = 0;
  for (const p of ctx.pieces) {
    const st = d.pieces[p.id];
    if (st.status !== "checked") continue;
    const items = ctx.itemsFor(p.type);
    total += items.length;
    done += items.filter((it) => st.answers[it.id]).length;
    problems += items.filter((it) => st.answers[it.id]?.r === "repair").length;
  }
  t.textContent = `${done} of ${total} items${problems ? ` · ${problems} to fix` : ""}`;
  $("#progFill").style.width = `${total ? (done / total) * 100 : 100}%`;
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
  const pieces = ctx.pieces.map((p) => {
    const st = d.pieces[p.id];
    if (st.status !== "checked") return { equipment_id: p.id, status: "not_here", note: st.note?.trim() || null, items: [] };
    return {
      equipment_id: p.id, status: "checked", note: null,
      items: ctx.itemsFor(p.type).map((it) => {
        const a = st.answers[it.id];
        return { checklist_item_id: it.id, result: a.r, note: a.r === "repair" ? a.n.trim() : null };
      }),
    };
  });
  const checked = new Set(pieces.filter((p) => p.status === "checked").map((p) => p.equipment_id));
  return {
    client_id: d.clientId,
    trailer_id: d.trailerId,
    check_date: d.date,
    checker_name: d.checker.trim(),
    comments: d.comments,
    checklist_as_of: ctx.asOf,
    pieces,
    photos: d.photos.filter((ph) => checked.has(ph.equipmentId) && d.pieces[ph.equipmentId].answers[ph.itemId]?.r === "repair")
      .map((ph) => ({ id: ph.id, caption: ph.caption || null, equipment_id: ph.equipmentId, checklist_item_id: ph.itemId })),
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

  const { key, trailerKey } = d;
  d.payload = buildPayload();
  d.status = "queued";
  d.queuedAt = Date.now();
  d.lastError = null;
  d.touched = true;
  persist.flush();
  await saveEquipDraft(d);

  const app = ctx.app;
  const r = await sendEquip(key);
  saving = false;
  if (r.state === "sent") {
    setActiveEquip(null);
    d = null;
    toast(r.res.failed ? `Check saved ✓ ${r.res.failed === 1 ? "1 problem to fix is" : `${r.res.failed} problems to fix are`} on the repairs board.` : "Check saved ✓", 4500);
    location.hash = `#/equipment-check/${r.res.id}`;
  } else if (r.state === "waiting") {
    toast("Saved on phone, not yet uploaded. It will send by itself when signal returns.", 5000);
    flushEquip();
    location.hash = "#/equipment";
  } else if (r.state === "rejected" && d) {
    btn.disabled = false;
    btn.textContent = "Save check";
    const details = r.error.details || {};
    err.innerHTML = `<div class="banner err">${esc(r.error.message)}</div>`;
    if (details.code === "checklist_changed" || details.code === "unknown_equipment") {
      toast("The equipment list or checklist changed. Reloading the form…");
      const nav = state.nav;
      setTimeout(async () => {
        if (stale(nav)) return;
        await leave();
        render(app, trailerKey);
      }, 1200);
    } else if (details.missing) {
      highlight(details.missing.flatMap((m) => m.items.map((id) => ({ sel: `#row-${m.equipment_id}-${id}` }))));
    }
    err.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/** Throw away a draft check (from the equipment page). */
export async function discardEquipDraft(trailerKey) {
  const dr = await getEquipDraft(equipKey(trailerKey));
  if (dr && dr.status !== "queued") await deleteEquipDraft(dr);
}
