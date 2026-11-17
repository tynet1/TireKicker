// Download CSV (supervisor, shop, admin): inspections, repairs, the maintenance log or trucks as a spreadsheet file,
// with the same truck and date filters as the screens. Every matching row is in the file, not just one screen's worth.
import { api, apiFile } from "../api.js";
import { atLeast, setHeader, stale, state } from "../ui.js";
import { $, $$, DATE_RANGES, dateRange, esc, modal, saveBlob, toast } from "../util.js";

const KINDS = {
  inspections: {
    label: "Inspections",
    about: "One row per inspection: date, truck, inspector, mileage, repairs needed, notes, registration on file and sign-off.",
    dates: "Inspection date",
    more: "Include archived inspections",
    supervisorOnly: true,
  },
  repairs: {
    label: "Repairs",
    about: "One row per repair item from inspections: truck, item, note, when it was reported, days open and how it was fixed.",
    dates: "Reported",
    more: "Include fixed repairs (not just open ones)",
  },
  maintenance: {
    label: "Maintenance log",
    about: "One row per maintenance entry: date, truck, mileage, work done, next due, cost, vendor and who entered it.",
    dates: "Service date",
    more: "Include voided entries",
  },
  trucks: {
    label: "Trucks",
    about: "One row per truck: VIN, plate, registration, trailer, last inspection and mileage, open repairs and damage on file.",
    dates: null,
    more: "Include retired trucks",
  },
};

let nav = 0;
let f = {};
let busy = false;

export async function render(app, query = "") {
  nav = state.nav;
  const qs = new URLSearchParams(query || "");
  const allowed = Object.keys(KINDS).filter((k) => !KINDS[k].supervisorOnly || atLeast("supervisor"));
  const what = allowed.includes(qs.get("what")) ? qs.get("what") : allowed[0];
  f = { what, truck: /^\d+$/.test(qs.get("truck") || "") ? qs.get("truck") : "", from: "", to: "", range: "", more: false };
  // Back goes to the screen whose "Download CSV" link opened this one (the menu's link has no "what").
  const t = f.truck ? `?truck=${f.truck}` : "";
  const back = {
    inspections: `#/export${t}`,
    repairs: `#/repairs${t}`,
    maintenance: f.truck ? `#/truck/${f.truck}` : "#/",
    trucks: atLeast("admin") ? "#/admin/trucks" : "#/",
  }[qs.get("what")] ?? "#/";
  setHeader({ title: "Download CSV", back });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  const vehicles = await api("/vehicles").catch(() => []);
  if (stale(nav)) return;

  app.innerHTML = `
    <p class="small muted" style="margin:14px 4px 0">A spreadsheet file for Excel, Google Sheets or Numbers, with every row that matches.</p>
    <div class="card" style="margin-top:10px">
      <label class="f">What to download</label>
      <div class="chips" id="c-what">${allowed.map((k) => `<button type="button" data-what="${k}">${esc(KINDS[k].label)}</button>`).join("")}</div>
      <p class="small muted" id="c-about" style="margin:10px 2px 0"></p>
      <div id="c-scope">
        <label class="f" for="c-truck">Truck</label>
        <select class="t" id="c-truck"><option value="">All trucks</option>${vehicles.map((v) =>
          `<option value="${v.id}"${String(v.id) === f.truck ? " selected" : ""}>${esc(v.truck_code)}</option>`).join("")}</select>
        <label class="f" id="c-dates-label"></label>
        <div class="dates">
          <div><label class="f" for="c-from">From</label><input class="t" type="date" id="c-from"></div>
          <div><label class="f" for="c-to">To</label><input class="t" type="date" id="c-to"></div>
        </div>
        <div class="chips" id="c-ranges" style="margin-top:12px">${DATE_RANGES.map(([k, l]) =>
          `<button type="button" data-range="${k}">${l}</button>`).join("")}</div>
      </div>
      <label class="pick" style="border:0;margin-top:6px"><input type="checkbox" id="c-more"><span id="c-more-label"></span></label>
    </div>
    <div class="bar"><div class="in"><span class="prog" id="c-prog"></span><button class="primary" id="c-go">Download CSV</button></div></div>`;
  document.body.classList.add("has-bar");
  wire();
  draw();
}

function wire() {
  $("#c-what").onclick = (e) => {
    const b = e.target.closest("[data-what]");
    if (!b || busy) return;
    f.what = b.dataset.what;
    f.more = false;
    draw();
  };
  $("#c-truck").onchange = (e) => { f.truck = e.target.value; draw(); };
  $("#c-more").onchange = (e) => { f.more = e.target.checked; };
  for (const key of ["from", "to"]) {
    $(`#c-${key}`).onchange = (e) => {
      f[key] = e.target.value;
      f.range = DATE_RANGES.find(([k]) => { const r = dateRange(k); return r.from === f.from && r.to === f.to; })?.[0] ?? null;
      draw();
    };
  }
  $("#c-ranges").onclick = (e) => {
    const b = e.target.closest("[data-range]");
    if (!b || busy) return;
    f.range = b.dataset.range;
    Object.assign(f, dateRange(f.range));
    draw();
  };
  $("#c-go").onclick = download;
}

function draw() {
  const k = KINDS[f.what];
  $$("#c-what [data-what]").forEach((b) => b.classList.toggle("on", b.dataset.what === f.what));
  $("#c-about").textContent = k.about;
  $("#c-scope").hidden = !k.dates;
  $("#c-dates-label").textContent = k.dates || "";
  $("#c-from").value = f.from;
  $("#c-to").value = f.to;
  $$("#c-ranges [data-range]").forEach((b) => b.classList.toggle("on", b.dataset.range === f.range));
  $("#c-more").checked = f.more;
  $("#c-more-label").textContent = k.more;
  const backwards = k.dates && f.from && f.to && f.from > f.to;
  $("#c-prog").innerHTML = backwards ? `<span class="danger">The From date is after the To date.</span>` : "";
  $("#c-go").disabled = busy || !!backwards;
}

async function download() {
  if (busy) return;
  const k = KINDS[f.what];
  const p = new URLSearchParams();
  if (k.dates) {
    if (f.truck) p.set("vehicle_id", f.truck);
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
  }
  if (f.more) p.set("include", "1");
  busy = true;
  $("#c-go").innerHTML = `<span class="spinner"></span>`;
  draw();
  try {
    const query = p.toString();
    const { blob, filename } = await apiFile(`/export/${f.what}.csv${query ? `?${query}` : ""}`);
    if (stale(nav)) return;
    const rows = Math.max(0, (await blob.text()).split("\r\n").length - 2); // minus the header and the final line break
    if (!rows) return void toast("Nothing matches these filters, so there's no file to save.", 4000);
    result(blob, filename, rows);
  } catch (e) {
    if (!stale(nav)) toast(e.message || String(e), 4000);
  } finally {
    busy = false;
    if (!stale(nav)) {
      $("#c-go").textContent = "Download CSV";
      draw();
    }
  }
}

function result(blob, filename, rows) {
  const file = new File([blob], filename, { type: "text/csv" });
  let canShare = false;
  try { canShare = !!navigator.canShare?.({ files: [file] }); } catch { /* not supported */ }
  const m = modal(`<h3>${rows} row${rows === 1 ? "" : "s"} ready</h3>
    <p class="muted" style="margin-top:-8px;word-break:break-all">${esc(filename)}</p>
    <div style="display:grid;gap:10px">
      <button class="primary" id="r-save">Save CSV</button>
      ${canShare ? `<button class="secondary" id="r-share">Share</button>` : ""}
      <button class="secondary" data-close>Done</button>
    </div>`);
  m.querySelector("[data-close]").onclick = () => m.remove();
  m.querySelector("#r-save").onclick = () => { saveBlob(blob, filename); toast(`Saving ${filename}`); };
  const share = m.querySelector("#r-share");
  if (share) share.onclick = async () => {
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      if (e?.name !== "AbortError") toast(`Couldn't share: ${e?.message || e}`);
    }
  };
}
