// Log maintenance on a piece of equipment (shop, admin): types of work (each with an optional next-due date), what was
// done, parts, cost, who or which vendor, photos, notes, and which of the piece's open problems it fixed. Saved to the
// phone as you go; Save queues it for upload. Entries aren't edited later: a mistaken one is voided.
import { api } from "../api.js";
import { deletePhotoBlob, photoBlob, storePhotoBlob } from "../drafts.js";
import { esvcKey, flushEsvc, getEsvcDraft, saveEsvcDraft, sendEsvc, setActiveEsvc, syncEsvcPhotos } from "../esvcq.js";
import { idb } from "../idb.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { $, $$, debounce, esc, fmtDate, shrinkImage, toast, today, uuid } from "../util.js";

let d = null;
let ctx = null; // { app, piece, work, problems, persistent }
let saving = false;
const blobUrls = new Map();
const persist = debounce(() => { if (d && d.touched) saveEsvcDraft(d); }, 400);
const onVis = () => { if (document.visibilityState === "hidden") persist.flush(); };
const onOnline = () => uploadPhotos();

function changed() {
  if (!d) return;
  d.touched = true;
  persist();
}

export async function render(app, equipmentId, fixItemId) {
  const nav = state.nav;
  setHeader({ title: "Log maintenance", back: `#/equipment/piece/${equipmentId}` });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let piece, config, findings;
  try {
    [{ equipment: piece }, config, findings] = await Promise.all([
      api(`/equipment/${equipmentId}`), api("/equipment-service-config"), api("/equipment-findings"),
    ]);
  } catch (e) {
    if (stale(nav)) return;
    const msg = e.status === 0
      ? "Can't load this without signal. Open the piece once while you have signal; after that this form works offline."
      : e.message;
    app.innerHTML = errorHtml(new Error(msg)) + `<a class="secondary" href="#/equipment/piece/${equipmentId}">Back</a>`;
    return;
  }
  if (stale(nav)) return;
  const key = esvcKey(piece.id);
  let draft = await getEsvcDraft(key);
  if (draft?.status === "queued") return void location.replace(`#/equipment/piece/${piece.id}`);
  if (!draft) {
    draft = {
      key, equipmentId: piece.id, tag: piece.tag, clientId: uuid(), status: "editing", touched: false,
      date: today(), types: [], next: {}, description: "", parts: "", cost: "", by: state.user?.name || "", vendor: "",
      notes: "", fix: [], photos: [], lastError: null,
    };
  }
  d = draft;
  setActiveEsvc(d);
  ctx = {
    app, piece, work: config.work,
    problems: findings.filter((f) => f.equipment_id === piece.id),
    persistent: await idb.isPersistent(),
  };
  if (fixItemId && ctx.problems.some((p) => p.id === Number(fixItemId)) && !d.fix.includes(Number(fixItemId))) {
    d.fix.push(Number(fixItemId));
    if (!d.types.length) d.types = ["repair"];
    d.touched = true;
    saveEsvcDraft(d);
  }
  setHeader({ title: d.touched ? "Maintenance draft" : "Log maintenance", sub: `${piece.tag} · ${piece.type_title}`, back: `#/equipment/piece/${piece.id}` });
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
  setActiveEsvc(null);
  d = null;
  ctx = null;
  saving = false;
}

function draw() {
  let h = "";
  if (d.lastError) h += `<div class="banner err"><b>The server didn't accept this entry:</b> ${esc(d.lastError)}<br>Fix it below and tap Save again.</div>`;
  if (!ctx.persistent) h += `<div class="banner info">This browser can't keep drafts after it's closed (private browsing?). Finish and save before closing it.</div>`;
  h += `<div class="card" style="margin-top:14px"><div class="fields">
    <div><label class="f" for="m-date">Date</label><input class="t" type="date" id="m-date" value="${esc(d.date)}" max="${today()}"></div>
    <div><label class="f" for="m-by">Done by</label><input class="t" id="m-by" value="${esc(d.by)}"></div>
    <div><label class="f" for="m-vendor">Outside shop <span class="muted">(optional)</span></label><input class="t" id="m-vendor" value="${esc(d.vendor)}"></div>
    <div><label class="f" for="m-cost">Cost <span class="muted">(optional)</span></label><input class="t" id="m-cost" inputmode="decimal" value="${esc(d.cost)}" placeholder="e.g. 18.40"></div>
  </div></div>`;
  h += `<h2>Type of work</h2><div class="card"><div class="chips" id="m-types">${ctx.work.map((w) =>
      `<button type="button" data-type="${w.key}" class="${d.types.includes(w.key) ? "on" : ""}">${esc(w.title)}</button>`).join("")}</div>
    <div id="m-next">${nextHtml()}</div></div>`;
  h += `<h2>What was done</h2><div class="card"><textarea class="t" id="m-desc" placeholder="e.g. Sharpened the chain, new spark plug">${esc(d.description)}</textarea>
    <label class="f" for="m-parts">Parts <span class="muted">(optional)</span></label><input class="t" id="m-parts" value="${esc(d.parts)}"></div>`;
  if (ctx.problems.length) {
    h += `<h2>Problems this fixes</h2><div class="card">${ctx.problems.map((p) => `<label class="pick"><input type="checkbox" data-fix="${p.id}"${d.fix.includes(p.id) ? " checked" : ""}>
        <span class="grow"><b>${esc(p.label)}</b>${p.note ? `<div class="small">${esc(p.note)}</div>` : ""}<div class="small muted">Found ${fmtDate(p.check_date)}</div></span></label>`).join("")}</div>`;
  }
  h += `<h2>Photos</h2><div class="card"><div class="photos" id="photos">${photosHtml()}</div></div>`;
  h += `<h2>Notes</h2><div class="card"><textarea class="t" id="m-notes" placeholder="Optional">${esc(d.notes)}</textarea></div>`;
  h += `<div id="formErr"></div><div class="bar"><div class="in"><span class="prog" id="m-prog"></span><button class="primary" id="save" type="button">Save entry</button></div></div>`;
  ctx.app.innerHTML = h;
  document.body.classList.add("has-bar");
  bind();
  loadThumbs();
}

function nextHtml() {
  if (!d.types.length) return `<p class="small muted" style="margin:10px 2px 0">Pick the type of work. Each can have its own next-due date.</p>`;
  return `<div class="fields" style="margin-top:10px">${d.types.map((t) => `<div><label class="f" for="nx-${t}">${esc(ctx.work.find((w) => w.key === t)?.title || t)}: next due <span class="muted">(optional)</span></label>
    <input class="t" type="date" id="nx-${t}" data-next="${t}" value="${esc(d.next[t] || "")}" min="${esc(d.date)}"></div>`).join("")}</div>`;
}

function photosHtml() {
  return d.photos.map((p) => `<div class="ph" data-ph="${p.id}"><img alt="" data-pid="${p.id}"${blobUrls.has(p.id) ? ` src="${blobUrls.get(p.id)}"` : ""}>
      ${p.uploaded ? "" : `<div class="state">${navigator.onLine ? `<span class="spinner"></span>` : "Saved on phone"}</div>`}
      <button type="button" class="x" data-phx="${p.id}" aria-label="Remove photo">×</button>
      <input class="cap" data-phc="${p.id}" placeholder="Caption" value="${esc(p.caption || "")}"></div>`).join("")
    + `<label class="addph"><span style="font-size:28px">＋</span><span>Add photos</span><input type="file" accept="image/*" multiple id="phIn"></label>`;
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
const redrawPhotos = () => { const el = $("#photos"); if (el) { el.innerHTML = photosHtml(); loadThumbs(); } };

function bind() {
  const app = ctx.app;
  const text = (sel, key) => { $(sel).oninput = (e) => { d[key] = e.target.value; changed(); }; };
  text("#m-date", "date");
  text("#m-by", "by");
  text("#m-vendor", "vendor");
  text("#m-cost", "cost");
  text("#m-desc", "description");
  text("#m-parts", "parts");
  text("#m-notes", "notes");
  $("#save").onclick = save;
  app.onclick = (e) => {
    const t = e.target.closest("[data-type]");
    if (t) {
      const k = t.dataset.type;
      d.types = d.types.includes(k) ? d.types.filter((x) => x !== k) : [...d.types, k];
      t.classList.toggle("on", d.types.includes(k));
      $("#m-next").innerHTML = nextHtml();
      return changed();
    }
    const x = e.target.closest("[data-phx]");
    if (x) {
      d.photos = d.photos.filter((p) => p.id !== x.dataset.phx);
      deletePhotoBlob(x.dataset.phx).catch(() => {});
      redrawPhotos();
      return changed();
    }
  };
  app.oninput = (e) => {
    const t = e.target;
    if (t.dataset.next) { d.next[t.dataset.next] = t.value; return changed(); }
    if (t.dataset.phc) { d.photos.find((p) => p.id === t.dataset.phc).caption = t.value; return changed(); }
  };
  app.onchange = (e) => {
    const t = e.target;
    if (t.dataset.fix) {
      const id = Number(t.dataset.fix);
      d.fix = t.checked ? [...new Set([...d.fix, id])] : d.fix.filter((x) => x !== id);
      return changed();
    }
    if (t.id === "phIn" && t.files?.length) {
      const files = [...t.files];
      t.value = "";
      addPhotos(files);
    }
  };
}

async function addPhotos(files) {
  for (const f of files) {
    const id = uuid();
    const blob = await shrinkImage(f);
    if (!d) return;
    await storePhotoBlob(id, blob);
    blobUrls.set(id, URL.createObjectURL(blob));
    d.photos.push({ id, caption: "", uploaded: false });
    changed();
    redrawPhotos();
  }
  toast(files.length > 1 ? `${files.length} photos added` : "Photo added");
  uploadPhotos();
}

let uploadingNow = false;
async function uploadPhotos() {
  if (!d || uploadingNow || !d.photos.some((p) => !p.uploaded)) return;
  uploadingNow = true;
  try {
    persist.flush();
    await saveEsvcDraft(d);
    await syncEsvcPhotos(d.key);
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    uploadingNow = false;
  }
  if (d) redrawPhotos();
}

function missingList() {
  const miss = [];
  if (!d.date) miss.push({ label: "date", sel: "#m-date" });
  if (!d.types.length) miss.push({ label: "type of work", sel: "#m-types" });
  if (!d.description.trim()) miss.push({ label: "what was done", sel: "#m-desc" });
  if (d.cost.trim() && !/^\$?\s*[\d,]{1,9}(\.\d{1,2})?$/.test(d.cost.trim())) miss.push({ label: "a cost like 18.40", sel: "#m-cost" });
  for (const t of d.types) {
    if (d.next[t] && d.next[t] <= d.date) miss.push({ label: "next due after the date of the work", sel: `#nx-${t}` });
  }
  return miss;
}

async function save() {
  if (saving || !d) return;
  const err = $("#formErr");
  const miss = missingList();
  $$(".missing").forEach((el) => el.classList.remove("missing"));
  if (miss.length) {
    for (const m of miss) $(m.sel)?.classList.add("missing");
    err.innerHTML = `<div class="banner err"><b>Still needed:</b> ${esc(miss.map((m) => m.label).join(", "))}.</div>`;
    ($(miss[0].sel) || err).scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  saving = true;
  err.innerHTML = "";
  const btn = $("#save");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>&nbsp;Saving…`;
  const { key, equipmentId } = d;
  d.payload = {
    client_id: d.clientId, equipment_id: d.equipmentId, service_date: d.date,
    work: d.types.map((t) => ({ type: t, next_due_date: d.next[t] || null })),
    description: d.description.trim(), parts: d.parts.trim() || null, cost: d.cost.trim() || null,
    performed_by: d.by.trim() || null, vendor: d.vendor.trim() || null, notes: d.notes.trim() || null,
    fix_item_ids: d.fix.filter((id) => ctx.problems.some((p) => p.id === id)),
    photos: d.photos.map((p) => ({ id: p.id, caption: p.caption || null })),
  };
  d.status = "queued";
  d.lastError = null;
  d.touched = true;
  persist.flush();
  await saveEsvcDraft(d);
  const app = ctx.app;
  const r = await sendEsvc(key);
  saving = false;
  if (r.state === "sent") {
    setActiveEsvc(null);
    d = null;
    toast(r.res.fixed ? `Saved ✓ ${r.res.fixed === 1 ? "1 problem" : `${r.res.fixed} problems`} closed.` : "Maintenance saved ✓", 4000);
    location.hash = `#/equipment-service/${r.res.id}`;
  } else if (r.state === "waiting") {
    toast("Saved on phone, not yet uploaded. It will send by itself when signal returns.", 5000);
    flushEsvc();
    location.hash = `#/equipment/piece/${equipmentId}`;
  } else if (r.state === "rejected" && d) {
    btn.disabled = false;
    btn.textContent = "Save entry";
    err.innerHTML = `<div class="banner err">${esc(r.error.message)}</div>`;
    if (r.error.details?.code === "bad_problems") {
      const nav = state.nav;
      setTimeout(async () => { if (stale(nav)) return; await leave(); render(app, equipmentId); }, 1200);
    }
    err.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
