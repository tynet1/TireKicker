// Export PDFs (supervisor): tick the inspections you want and get one PDF per inspection,
// saved together in a .zip, or shared as separate files where the phone supports it.
// The PDFs are fetched one at a time (two in flight), so a weak signal only retries one PDF, not the batch.
import { api, apiFile, withRetry } from "../api.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { $, $$, DATE_RANGES as RANGES, dateRange as range, esc, fmtDate, modal, saveBlob, toast, today } from "../util.js";
import { makeZip, uniqueName } from "../zip.js";
import { inspectionPills, inspectionTitle } from "./common.js";

const MAX = 100;        // per export, to keep the phone's memory in check
const LIST_LIMIT = 200; // the most the server lists at once

let nav = 0;
let selected = new Map(); // id -> inspection row; kept while filters change, cleared on each visit
let filters = {};
let rows = [];
let loadSeq = 0;
let job = null; // the export that's running: { ctl }

export function leave() {
  job?.ctl.abort();
  job = null;
}

export async function render(app, truckId) {
  nav = state.nav;
  selected = new Map();
  rows = [];
  filters = { truck: truckId || "", from: "", to: "", range: "", archived: false };
  setHeader({ title: "Export PDFs", back: truckId ? `#/truck/${truckId}` : "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  const vehicles = await api("/vehicles").catch(() => []);
  if (stale(nav)) return;

  app.innerHTML = `
    <p class="small muted" style="margin:14px 4px 0">Tick the inspections to export. Each one becomes its own PDF, the same as Export PDF on an inspection.
      Want a spreadsheet instead? <a href="#/csv?what=inspections${truckId ? `&truck=${truckId}` : ""}">Download CSV</a></p>
    <div class="card" style="margin-top:10px">
      <label class="f" for="x-truck">Truck</label>
      <select class="t" id="x-truck"><option value="">All trucks</option>${vehicles.map((v) =>
        `<option value="${v.id}"${String(v.id) === filters.truck ? " selected" : ""}>${esc(v.truck_code)}</option>`).join("")}</select>
      <div class="dates">
        <div><label class="f" for="x-from">From</label><input class="t" type="date" id="x-from"></div>
        <div><label class="f" for="x-to">To</label><input class="t" type="date" id="x-to"></div>
      </div>
      <div class="chips" id="x-ranges" style="margin-top:12px">${RANGES.map(([k, l]) =>
        `<button type="button" data-range="${k}">${l}</button>`).join("")}</div>
      <label class="pick" style="border:0;margin-top:6px"><input type="checkbox" id="x-arch"><span>Include archived inspections</span></label>
    </div>
    <div class="h2row"><h2 id="x-count">Inspections</h2>
      <span class="row" style="flex-wrap:nowrap"><button class="link" id="x-all">Select all</button><button class="link" id="x-none">Clear</button></span></div>
    <div class="card list" id="x-list"><div class="empty">Loading…</div></div>
    <div class="bar"><div class="in"><span class="prog" id="x-prog"></span><button class="primary" id="x-go">Export</button></div></div>`;
  document.body.classList.add("has-bar");
  wire();
  drawRanges();
  load();
}

function wire() {
  $("#x-truck").onchange = (e) => { filters.truck = e.target.value; load(); };
  $("#x-arch").onchange = (e) => { filters.archived = e.target.checked; load(); };
  for (const key of ["from", "to"]) {
    $(`#x-${key}`).onchange = (e) => {
      filters[key] = e.target.value;
      filters.range = RANGES.find(([k]) => { const r = range(k); return r.from === filters.from && r.to === filters.to; })?.[0] ?? null;
      drawRanges();
      load();
    };
  }
  $("#x-ranges").onclick = (e) => {
    const b = e.target.closest("[data-range]");
    if (!b) return;
    filters.range = b.dataset.range;
    Object.assign(filters, range(filters.range));
    drawRanges();
    load();
  };
  $("#x-list").onchange = (e) => {
    const cb = e.target.closest("input[data-id]");
    if (!cb) return;
    const row = rows.find((r) => r.id === cb.dataset.id);
    if (cb.checked && row) selected.set(row.id, row);
    else selected.delete(cb.dataset.id);
    drawBar();
  };
  $("#x-all").onclick = () => {
    for (const r of rows) selected.set(r.id, r);
    $$("#x-list input[data-id]").forEach((cb) => (cb.checked = true));
    drawBar();
  };
  $("#x-none").onclick = () => {
    selected.clear();
    $$("#x-list input[data-id]").forEach((cb) => (cb.checked = false));
    drawBar();
  };
  $("#x-go").onclick = () => {
    if (job) return void job.ctl.abort();
    if (selected.size && selected.size <= MAX) runExport([...selected.keys()], new Map(selected));
  };
}

function drawRanges() {
  $("#x-from").value = filters.from;
  $("#x-to").value = filters.to;
  $$("#x-ranges [data-range]").forEach((b) => b.classList.toggle("on", b.dataset.range === filters.range));
}

async function load() {
  const seq = ++loadSeq;
  const p = new URLSearchParams({ limit: String(LIST_LIMIT) });
  if (filters.truck) p.set("vehicle_id", filters.truck);
  if (filters.from) p.set("from", filters.from);
  if (filters.to) p.set("to", filters.to);
  if (filters.archived) p.set("archived", "include");
  $("#x-list").innerHTML = `<div class="empty">Loading…</div>`;
  let res;
  try {
    res = await api(`/inspections?${p}`);
  } catch (e) {
    if (seq === loadSeq && !stale(nav)) { $("#x-list").innerHTML = errorHtml(e); rows = []; drawBar(); }
    return;
  }
  if (seq !== loadSeq || stale(nav)) return;
  rows = res;
  drawList();
}

function drawList() {
  const full = rows.length >= LIST_LIMIT;
  $("#x-count").textContent = full ? `Newest ${LIST_LIMIT} inspections` : `Inspections (${rows.length})`;
  const box = $("#x-list");
  if (!rows.length) {
    const backwards = filters.from && filters.to && filters.from > filters.to;
    box.innerHTML = `<div class="empty">${backwards ? "The From date is after the To date." : `No inspections${filters.from || filters.to ? " in these dates" : ""}.`}</div>`;
  } else {
    box.innerHTML = rows.map((i) => `<label class="pick"><input type="checkbox" data-id="${esc(i.id)}"${selected.has(i.id) ? " checked" : ""}>
        <span class="grow">${inspectionTitle(i)}<span class="row pills">${inspectionPills(i)}</span></span></label>`).join("")
      + (full ? `<p class="small muted" style="margin:10px 2px 0">Only the newest ${LIST_LIMIT} are listed. Pick dates to see older ones.</p>` : "");
  }
  drawBar();
}

function drawBar() {
  if (job) return; // the progress readout owns the bar while exporting
  const n = selected.size;
  const shown = new Set(rows.map((r) => r.id));
  const hidden = [...selected.keys()].filter((id) => !shown.has(id)).length;
  const go = $("#x-go");
  go.textContent = n ? `Export ${n} PDF${n > 1 ? "s" : ""}` : "Export";
  go.disabled = !n || n > MAX;
  $("#x-prog").innerHTML = n > MAX
    ? `<span class="danger">${n} ticked. Export up to ${MAX} at a time.</span>`
    : n ? `${n} ticked${hidden ? ` · ${hidden} not in this list` : ""}` : "Tick the inspections to export";
}

function setBusy(busy) {
  $$("#app select, #app input, #x-all, #x-none, #x-ranges button").forEach((el) => (el.disabled = busy));
  const go = $("#x-go");
  go.className = busy ? "secondary" : "primary";
  if (busy) { go.textContent = "Cancel"; go.disabled = false; } else drawBar();
}

/** Fetch each PDF (skipping ones already in `done`), then offer to save or share them. */
async function runExport(ids, info, done = new Map()) {
  const ctl = new AbortController();
  job = { ctl };
  const todo = ids.filter((id) => !done.has(id));
  const failed = [];
  let next = 0;
  let finished = 0;
  const progress = () => {
    if (stale(nav)) return;
    $("#x-prog").innerHTML = `Making PDFs… ${finished} of ${todo.length}
      <div class="track"><div class="fill" style="width:${Math.round((finished / todo.length) * 100)}%"></div></div>`;
  };
  setBusy(true);
  progress();
  const worker = async () => {
    while (next < todo.length && !ctl.signal.aborted) {
      const id = todo[next++];
      try {
        done.set(id, await withRetry(() => apiFile(`/inspections/${encodeURIComponent(id)}/pdf`, { signal: ctl.signal }), { tries: 3 }));
      } catch (e) {
        if (ctl.signal.aborted) return;
        failed.push({ id, message: e.message || String(e) });
      }
      finished++;
      progress();
    }
  };
  await Promise.all([worker(), worker()]);
  if (job?.ctl === ctl) job = null;
  if (stale(nav)) return;
  setBusy(false);
  if (ctl.signal.aborted) return void toast("Export cancelled");
  await showResult(ids, info, done, failed);
}

const size = (b) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);

async function showResult(ids, info, done, failed) {
  const used = new Set();
  const files = ids.filter((id) => done.has(id)).map((id) => {
    const f = done.get(id);
    return { name: uniqueName(f.filename, used), blob: f.blob };
  });
  const label = (id) => { const r = info.get(id); return r ? `${r.truck_code} ${fmtDate(r.inspection_date)}` : "Inspection"; };
  const one = files.length === 1;
  const zip = files.length > 1 ? await makeZip(files) : null;
  const zipName = `inspections_${today()}.zip`;
  const asFiles = files.map((f) => new File([f.blob], f.name, { type: "application/pdf" }));
  let canShare = false;
  try { canShare = asFiles.length > 0 && !!navigator.canShare?.({ files: asFiles }); } catch { /* not supported */ }
  if (stale(nav)) return;

  const m = modal(`<h3>${files.length ? `${files.length} PDF${one ? "" : "s"} ready` : "No PDFs were made"}</h3>
    ${files.length ? `<p class="muted" style="margin-top:-8px">${size(zip ? zip.size : files[0].blob.size)} · one PDF per inspection${one ? "" : `, together in ${esc(zipName)}`}</p>` : ""}
    ${failed.length ? `<div class="banner err"><b>${failed.length} couldn't be made:</b><ul>${failed.slice(0, 6).map((f) =>
      `<li>${esc(label(f.id))}: ${esc(f.message)}</li>`).join("")}${failed.length > 6 ? `<li>…and ${failed.length - 6} more</li>` : ""}</ul></div>` : ""}
    <div style="display:grid;gap:10px">
      ${files.length ? `<button class="primary" id="r-save">${one ? "Save PDF" : "Save .zip"}</button>` : ""}
      ${canShare ? `<button class="secondary" id="r-share">${one ? "Share PDF" : `Share as ${files.length} separate PDFs`}</button>` : ""}
      ${failed.length ? `<button class="secondary" id="r-retry">Try the ${failed.length} again</button>` : ""}
      <button class="secondary" data-close>Done</button>
    </div>`);
  m.querySelector("[data-close]").onclick = () => m.remove();
  const save = m.querySelector("#r-save");
  if (save) save.onclick = () => {
    if (zip) saveBlob(zip, zipName);
    else saveBlob(files[0].blob, files[0].name);
    toast(`Saving ${zip ? zipName : files[0].name}`);
  };
  const share = m.querySelector("#r-share");
  if (share) share.onclick = async () => {
    try {
      await navigator.share({ files: asFiles });
    } catch (e) {
      if (e?.name !== "AbortError") toast(`Couldn't share: ${e?.message || e}`);
    }
  };
  const retry = m.querySelector("#r-retry");
  if (retry) retry.onclick = () => { m.remove(); runExport(ids, info, done); };
}
