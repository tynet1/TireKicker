// Small DOM and formatting helpers shared by every screen.

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "2026-11-10" or an ISO timestamp -> "11/10/2026" */
export function fmtDate(s) {
  if (!s) return "";
  const str = String(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split("-");
    return `${+m}/${+d}/${y}`;
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? str : `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Quick date ranges for the export screens: [key, label]. */
export const DATE_RANGES = [["7", "Last 7 days"], ["month", "This month"], ["last", "Last month"], ["", "Any date"]];

/** { from, to } for a DATE_RANGES key ("" is any date). */
export function dateRange(key) {
  const n = new Date();
  if (key === "7") return { from: iso(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 6)), to: today() };
  if (key === "month") return { from: iso(new Date(n.getFullYear(), n.getMonth(), 1)), to: today() };
  if (key === "last") return { from: iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), to: iso(new Date(n.getFullYear(), n.getMonth(), 0)) };
  return { from: "", to: "" };
}

/** Hand a file to the browser to save (Downloads on a PC, Files on an iPhone). */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const fmtNum = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("en-US"));
export const fmtMoney = (n) => (n == null || n === ""
  ? "" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function daysAgo(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + "T12:00:00");
  return Math.round((Date.now() - d.getTime()) / 864e5);
}

/** RFC 4122 v4 uuid; works on plain-http LAN pages where crypto.randomUUID is missing. */
export function uuid() {
  if (crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch { /* insecure context */ }
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function toast(msg, ms = 2800) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), ms);
}

export function modal(html) {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  m.addEventListener("click", (e) => { if (e.target === m) m.remove(); });
  document.body.appendChild(m);
  return m;
}

export function confirmBox(msg, label = "OK", { danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal(`<p style="margin:4px 0 16px">${esc(msg)}</p>
      <div class="row" style="justify-content:flex-end"><button class="secondary" data-c>Cancel</button>
      <button class="primary ${danger ? "btn-danger" : ""}" data-y>${esc(label)}</button></div>`);
    m.querySelector("[data-c]").onclick = () => { m.remove(); resolve(false); };
    m.querySelector("[data-y]").onclick = () => { m.remove(); resolve(true); };
  });
}

/** Resize a photo on the phone before upload: max 1600px on the long side, JPEG ~80%. */
export function shrinkImage(file, max = 1600, quality = 0.8) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      const s = Math.min(1, max / Math.max(w, h));
      w = Math.round(w * s); h = Math.round(h * s);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      c.toBlob((b) => resolve(b || file), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export function vehicleInfo(v) {
  return [v.year, v.make, v.model].filter(Boolean).join(" ");
}

export function lightbox(src, caption = "") {
  const d = document.createElement("div");
  d.className = "lightbox";
  d.innerHTML = `<img src="${esc(src)}" alt="">${caption ? `<div>${esc(caption)}</div>` : ""}<div class="small" style="opacity:.7">Tap to close</div>`;
  d.onclick = () => d.remove();
  document.body.appendChild(d);
}
