// Fleet pieces shared by screens: a truck's status (show, change, history) and the trailer on it (show, change).
import { api } from "../api.js";
import { can, state } from "../ui.js";
import { esc, fmtDate, modal, toast } from "../util.js";

export const STATUS_TITLES = {
  in_service: "In service", in_shop: "In the shop", on_hold: "On hold", preparing_return: "Preparing for return",
  returned: "Returned", sold: "Sold", retired: "Retired",
};
const SHOP_STATUSES = ["in_service", "in_shop", "on_hold"];
const PILL = { in_service: "okk", in_shop: "warn", on_hold: "warn", preparing_return: "warn", returned: "grey", sold: "grey", retired: "grey" };

/** A status pill; nothing for "In service" when `quiet` (truck cards only flag the unusual). */
export function statusPill(status, { quiet = false } = {}) {
  if (!status || (quiet && status === "in_service")) return "";
  return `<span class="pill ${PILL[status] || "grey"}">${esc(STATUS_TITLES[status] || status)}</span>`;
}

/** The truck page's Status value, with Change for the shop and supervisors. */
export function statusValue(v) {
  return `<span class="regval">${statusPill(v.status)}${can.seeService() ? `<button type="button" class="link" data-status>Change</button>` : ""}</span>`;
}

/** Change a truck's status. Resolves the new status, or null if cancelled. */
export function changeStatus(v) {
  const shop = state.user?.role === "shop";
  const options = Object.entries(STATUS_TITLES).filter(([k]) => !shop || SHOP_STATUSES.includes(k));
  return new Promise((resolve) => {
    const m = modal(`<h3>Status of ${esc(v.truck_code)}</h3>
      <p class="muted small" style="margin-top:-8px">Now: ${esc(STATUS_TITLES[v.status] || v.status)}.
        Returned, Sold and Retired take the truck out of the fleet: crews no longer see it, and its history is kept.</p>
      <div class="card list" style="margin:0 0 10px">${options.map(([k, t]) => `<label class="pick">
        <input type="radio" name="st" value="${k}"${k === v.status ? " checked" : ""}><span class="grow">${esc(t)}</span></label>`).join("")}</div>
      ${shop ? `<p class="small muted">A supervisor sets the other statuses.</p>` : ""}
      <label class="f" for="st-note">Note <span class="muted">(optional)</span></label>
      <input class="t" id="st-note" maxlength="500" placeholder="e.g. At Corner Tire until Thursday">
      <div id="st-err"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="secondary" data-c>Cancel</button><button class="primary" data-y>Save</button></div>`);
    const err = (msg) => { m.querySelector("#st-err").innerHTML = `<div class="banner err">${esc(msg)}</div>`; };
    m.querySelector("[data-c]").onclick = () => { m.remove(); resolve(null); };
    m.querySelector("[data-y]").onclick = async (e) => {
      const status = m.querySelector("input[name=st]:checked")?.value;
      if (!status || status === v.status) return err("Pick a different status.");
      e.target.disabled = true;
      try {
        const r = await api(`/vehicles/${v.id}/status`, { method: "POST", body: { status, note: m.querySelector("#st-note").value.trim() || null } });
        m.remove();
        toast(`${v.truck_code}: ${r.title} ✓`);
        resolve(r.status);
      } catch (ex) {
        e.target.disabled = false;
        err(ex.status === 0 ? "No signal, so nothing changed." : ex.message);
      }
    };
  });
}

/** The status history, newest first, collapsed. */
export function statusHistoryHtml(list) {
  if (!list?.length) return "";
  return `<details class="onfile" style="margin-top:6px"><summary>Status history (${list.length})</summary><ul class="small" style="padding-left:18px;margin:0 0 8px">${
    list.map((c) => `<li>${fmtDate(c.changed_at)} · ${esc(c.previous_title || "—")} → <b>${esc(c.title)}</b>${c.changed_by_name ? ` · ${esc(c.changed_by_name)}` : ""}${
      c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ""}</li>`).join("")}</ul></details>`;
}

/** The truck page's Trailer value: the trailer on the truck (if any) and its type, with Change for staff. */
export function trailerValue(v) {
  const t = v.trailer;
  const what = t ? `${esc(t.trailer_number)}${t.name ? ` · ${esc(t.name)}` : ""}` : v.pulls_trailer ? esc(v.trailer_type || "Yes") : "None";
  return `<span class="regval">${what}${can.seeService() ? `<button type="button" class="link" data-trailer>Change</button>` : ""}</span>`;
}

/** Pick the trailer on this truck (or none). Resolves true when it changed. */
export async function changeTrailer(v) {
  let trailers;
  try {
    trailers = await api("/trailers");
  } catch (e) {
    toast(e.status === 0 ? "No signal. Try again when you have signal." : e.message, 4000);
    return false;
  }
  return new Promise((resolve) => {
    const cur = v.trailer?.id ?? null;
    const m = modal(`<h3>Trailer on ${esc(v.truck_code)}</h3>
      ${trailers.length ? "" : `<p class="muted">No trailers yet. An admin adds them under Admin → Equipment.</p>`}
      <div class="card list" style="margin:0 0 10px"><label class="pick"><input type="radio" name="tr" value=""${cur ? "" : " checked"}><span class="grow">No trailer</span></label>
        ${trailers.map((t) => `<label class="pick"><input type="radio" name="tr" value="${t.id}"${t.id === cur ? " checked" : ""}>
          <span class="grow"><b>${esc(t.trailer_number)}</b>${t.name ? ` ${esc(t.name)}` : ""}
            <span class="small muted" style="display:block">${t.truck_code ? (t.vehicle_id === v.id ? "On this truck" : `On ${esc(t.truck_code)} now; it moves here`) : "Not on a truck"}</span></span></label>`).join("")}</div>
      <div id="tr-err"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="secondary" data-c>Cancel</button><button class="primary" data-y>Save</button></div>`);
    const err = (msg) => { m.querySelector("#tr-err").innerHTML = `<div class="banner err">${esc(msg)}</div>`; };
    m.querySelector("[data-c]").onclick = () => { m.remove(); resolve(false); };
    m.querySelector("[data-y]").onclick = async (e) => {
      const pick = m.querySelector("input[name=tr]:checked")?.value || "";
      const next = pick ? Number(pick) : null;
      if (next === cur) { m.remove(); return resolve(false); }
      e.target.disabled = true;
      try {
        // Taking the trailer off: unassign the current one. Otherwise put the picked one on (any other comes off).
        if (next === null) await api(`/trailers/${cur}/assign`, { method: "POST", body: { vehicle_id: null } });
        else await api(`/trailers/${next}/assign`, { method: "POST", body: { vehicle_id: v.id } });
        m.remove();
        toast("Trailer updated ✓");
        resolve(true);
      } catch (ex) {
        e.target.disabled = false;
        err(ex.status === 0 ? "No signal, so nothing changed." : ex.message);
      }
    };
  });
}
