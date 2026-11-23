// Repair tickets (supervisor, shop, admin): pick open repairs on a truck and make a numbered PDF ticket for the shop
// or an outside vendor; see a truck's tickets; share, save or print a ticket's PDF; log its fix; void a mistaken one.
// Making or voiding a ticket needs signal (like a registration update): it isn't queued on the phone.
import { api, apiFile } from "../api.js";
import { atLeast, can } from "../ui.js";
import { esc, fmtDate, modal, saveBlob, toast, uuid } from "../util.js";
import { askTrash, SECTION_TITLES } from "./common.js";

export const ticketNumber = (id) => `RT-${String(id).padStart(4, "0")}`;
const noSignal = "No signal, so nothing was saved. Try again when you have signal.";

/** A small "RT-0012" pill for each live ticket a repair is on. */
export function ticketPills(r) {
  return (r.ticket_ids || []).map((id) => ` <span class="pill grey">${ticketNumber(id)}</span>`).join("");
}

/**
 * Pick repairs and make a ticket. `repairs` are the truck's open repairs; `picked` (ids) start ticked, else all do.
 * `damage` is its incident damage not yet repaired ({ id, diagram, seq or n, note, date, ticket_ids }): listed after the
 * repairs and never ticked unless it's in `pickedDamage` (a totaled truck mustn't go to the mechanic by accident).
 * Resolves the new ticket's id, or null if cancelled.
 */
export async function makeTicket(vehicle, repairs, { picked = null, damage = [], pickedDamage = [] } = {}) {
  const sentTo = await api("/repair-tickets/sent-to").catch(() => []);
  return new Promise((resolve) => {
    const on = new Set(picked ? picked : repairs.map((r) => r.id));
    const onDmg = new Set(pickedDamage);
    const dmgName = (m) => (m.diagram === "trailer" ? "Trailer damage" : "Damage");
    const clientId = uuid(); // one per dialog: a retry after a dropped answer can't make a second ticket
    const m = modal(`<h3>Repair ticket for ${esc(vehicle.truck_code)}</h3>
      <p class="muted small" style="margin-top:-8px">Tick the repairs to send. The ticket is a PDF you can print, share or email.</p>
      ${repairs.length ? `<div class="card list" style="margin:0 0 10px">${repairs.map((r) => `<label class="pick">
        <input type="checkbox" data-item="${r.id}"${on.has(r.id) ? " checked" : ""}>
        <span class="grow"><b>${esc(r.label)}</b> <span class="small muted">(${esc(SECTION_TITLES[r.section] || r.section)})</span>${ticketPills(r)}
          ${r.note ? `<div class="small">${esc(r.note)}</div>` : ""}
          <div class="small muted">Reported ${fmtDate(r.inspection_date)}</div></span></label>`).join("")}</div>` : ""}
      ${damage.length ? `<div class="small" style="font-weight:650;margin:4px 2px 2px">Incident damage</div>
      <p class="small muted" style="margin:0 2px 6px">Not ticked: tick it only if the truck is being repaired (not if it's totaled).</p>
      <div class="card list" style="margin:0 0 10px">${damage.map((m) => `<label class="pick">
        <input type="checkbox" data-dmg="${m.id}"${onDmg.has(m.id) ? " checked" : ""}>
        <span class="grow"><b>${esc(dmgName(m))}${m.note ? `: ${esc(m.note)}` : ""}</b>${ticketPills(m)}
          <div class="small muted">From the ${fmtDate(m.date)} incident</div></span></label>`).join("")}</div>` : ""}
      <label class="f" for="tk-to">Sent to <span class="muted">(optional)</span></label>
      <input class="t" id="tk-to" maxlength="120" list="tk-to-list" placeholder="e.g. Main St Garage, Corner Tire" autocomplete="off">
      <datalist id="tk-to-list">${sentTo.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>
      <label class="f" for="tk-note">Note for the shop <span class="muted">(optional)</span></label>
      <textarea class="t" id="tk-note" maxlength="1000" placeholder="e.g. Call before replacing anything over $300"></textarea>
      <div id="tk-err"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="secondary" data-c>Cancel</button><button class="primary" data-y>Make ticket</button></div>`);
    const go = m.querySelector("[data-y]");
    const err = (msg) => { m.querySelector("#tk-err").innerHTML = msg ? `<div class="banner err">${esc(msg)}</div>` : ""; };
    const ticked = () => [...m.querySelectorAll("[data-item]")].filter((c) => c.checked).map((c) => Number(c.dataset.item));
    const tickedDmg = () => [...m.querySelectorAll("[data-dmg]")].filter((c) => c.checked).map((c) => Number(c.dataset.dmg));
    const count = () => {
      const n = ticked().length + tickedDmg().length;
      go.textContent = n ? `Make ticket (${n})` : "Make ticket";
      go.disabled = !n;
    };
    m.addEventListener("change", count);
    count();
    m.querySelector("[data-c]").onclick = () => { m.remove(); resolve(null); };
    go.onclick = async () => {
      const items = ticked();
      const dmg = tickedDmg();
      if (!items.length && !dmg.length) return err("Tick at least one repair.");
      err("");
      go.disabled = true;
      go.innerHTML = `<span class="spinner"></span>`;
      try {
        const res = await api("/repair-tickets", {
          method: "POST",
          body: {
            client_id: clientId, vehicle_id: vehicle.id, item_ids: items, damage_ids: dmg,
            sent_to: m.querySelector("#tk-to").value.trim() || null, note: m.querySelector("#tk-note").value.trim() || null,
          },
        });
        m.remove();
        toast(`${res.number} made ✓`);
        resolve(res.id);
      } catch (e) {
        count();
        err(e.status === 0 ? noSignal : e.message);
      }
    };
  });
}

/** A truck's tickets, for its page (supervisor, shop, admin). */
export function ticketsSection(tickets) {
  if (!tickets.length) return "";
  return `<h2>Repair tickets (${tickets.length})</h2><div class="card list">${tickets.map((t) => `
    <button class="item${t.voided ? " voided" : ""}" data-ticket="${t.id}">
      <span class="grow"><b>${esc(t.number)}</b> · ${fmtDate(t.created_at)}${t.sent_to ? ` · ${esc(t.sent_to)}` : ""}
        <span class="small muted clip">${t.items} repair${t.items === 1 ? "" : "s"} · made by ${esc(t.created_by_name)}</span></span>
      <span class="row" style="justify-content:flex-end;flex-wrap:nowrap">${t.voided ? `<span class="pill grey">Voided</span>`
        : t.fixed === t.items ? `<span class="pill okk">All fixed</span>`
        : t.fixed ? `<span class="pill warn">${t.fixed} of ${t.items} fixed</span>` : `<span class="pill">Open</span>`}</span>
    </button>`).join("")}</div>`;
}

/**
 * One ticket: its repairs and where each stands, the PDF (share, save, print), Log fix and Void.
 * Resolves true if it changed (voided), so the screen can reload.
 */
export async function openTicket(id) {
  let t;
  try {
    t = await api(`/repair-tickets/${id}`);
  } catch (e) {
    toast(e.status === 0 ? "No signal. Open the ticket again when you have signal." : e.message, 4000);
    return false;
  }
  return new Promise((resolve) => {
    const open = t.items.filter((it) => !it.resolved_at);
    const m = modal(`<h3>${esc(t.number)} · ${esc(t.truck_code)}</h3>
      <p class="muted small" style="margin-top:-8px">Made ${fmtDate(t.created_at)} by ${esc(t.created_by_name)}${t.sent_to ? ` · sent to ${esc(t.sent_to)}` : ""}</p>
      ${t.voided ? `<div class="banner info"><b>Voided ${fmtDate(t.voided_at)}</b> by ${esc(t.voided_by_name)}: ${esc(t.void_reason)}</div>` : ""}
      ${t.note ? `<p class="small" style="white-space:pre-wrap">${esc(t.note)}</p>` : ""}
      <ul class="repairlist" style="margin-bottom:12px">${t.items.map((it) => `<li><b>${it.position}. ${esc(it.label)}</b>
        <span class="small muted">(${esc(SECTION_TITLES[it.section] || it.section)})</span>
        ${it.resolved_at ? `<span class="pill okk">Fixed ${fmtDate(it.resolved_at)}</span>` : `<span class="pill">Open</span>`}
        ${it.note ? `<div class="small">${esc(it.note)}</div>` : ""}
        ${it.resolved_at && it.resolution_note ? `<div class="small muted">${esc(it.resolution_note)}${it.service_log_id && can.seeService()
          ? ` · <a href="#/service/${it.service_log_id}" data-close>maintenance entry</a>` : ""}</div>` : ""}</li>`).join("")}</ul>
      <div id="tk-pdf" style="display:grid;gap:10px"><button class="secondary" disabled><span class="spinner"></span> Getting the PDF…</button></div>
      <div style="display:grid;gap:10px;margin-top:10px">
        ${!t.voided && open.length && can.logService() ? `<a class="secondary" href="#/service/new/${t.vehicle_id}?ticket=${t.id}" data-close>Log fix (${open.length} open)</a>` : ""}
        ${t.voided ? "" : `<button class="secondary danger" id="tk-void">Void this ticket</button>`}
        ${atLeast("admin") && !t.trash ? `<button class="secondary danger" id="tk-trash">Delete this ticket</button>` : ""}
        <button class="secondary" data-close>Close</button>
      </div>`);
    const close = (changed) => { m.remove(); resolve(changed); };
    m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => close(false)));
    const v = m.querySelector("#tk-void");
    if (v) v.onclick = async () => { if (await voidTicket(t)) close(true); };
    const del = m.querySelector("#tk-trash");
    if (del) del.onclick = async () => {
      if (await askTrash("repair_ticket", t.id, "ticket", t.voided ? "" : "It's voided first. ")) close(true);
    };
    pdfButtons(m.querySelector("#tk-pdf"), t);
  });
}

/** Fetch the PDF once, then offer Share (where the phone can), Save and Open to print. */
async function pdfButtons(box, t) {
  const path = `/repair-tickets/${t.id}/pdf`;
  let file;
  try {
    const { blob, filename } = await apiFile(path);
    file = new File([blob], filename, { type: "application/pdf" });
  } catch (e) {
    box.innerHTML = `<div class="banner err">${esc(e.status === 0 ? "No signal, so the PDF couldn't be made. Try again when you have signal." : e.message)}</div>
      <button class="secondary" id="tk-retry">Try again</button>`;
    box.querySelector("#tk-retry").onclick = () => {
      box.innerHTML = `<button class="secondary" disabled><span class="spinner"></span> Getting the PDF…</button>`;
      pdfButtons(box, t);
    };
    return;
  }
  let canShare = false;
  try { canShare = !!navigator.canShare?.({ files: [file] }); } catch { /* not supported */ }
  box.innerHTML = `${canShare ? `<button class="primary" id="tk-share">Share or email PDF</button>` : ""}
    <button class="${canShare ? "secondary" : "primary"}" id="tk-save">Save PDF</button>
    <a class="secondary" href="/api${path}?inline=1" target="_blank" rel="noopener">Open PDF to print</a>`;
  box.querySelector("#tk-save").onclick = () => { saveBlob(file, file.name); toast(`Saving ${file.name}`); };
  const share = box.querySelector("#tk-share");
  if (share) share.onclick = async () => {
    try {
      await navigator.share({ files: [file], title: `${t.number} · ${t.truck_code}` });
    } catch (e) {
      if (e?.name !== "AbortError") toast(`Couldn't share: ${e?.message || e}`);
    }
  };
}

function voidTicket(t) {
  return new Promise((resolve) => {
    const m = modal(`<h3>Void ${esc(t.number)}?</h3>
      <p class="muted small" style="margin-top:-8px">The ticket stays on the truck, marked voided, and its PDF says VOID.
        Its repairs stay open.</p>
      <label class="f" for="tv-why">Why?</label>
      <textarea class="t" id="tv-why" maxlength="600" placeholder="e.g. Wrong repairs ticked; made a new ticket"></textarea>
      <div id="tv-err"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="secondary" data-c>Cancel</button><button class="primary btn-danger" data-y>Void ticket</button></div>`);
    const why = m.querySelector("#tv-why");
    why.focus();
    m.querySelector("[data-c]").onclick = () => { m.remove(); resolve(false); };
    m.querySelector("[data-y]").onclick = async (e) => {
      const reason = why.value.trim();
      const err = (msg) => { m.querySelector("#tv-err").innerHTML = `<div class="banner err">${esc(msg)}</div>`; };
      if (!reason) return err("Add a short reason.");
      e.target.disabled = true;
      try {
        await api(`/repair-tickets/${t.id}/void`, { method: "POST", body: { reason } });
        m.remove();
        toast(`${t.number} voided`);
        resolve(true);
      } catch (ex) {
        e.target.disabled = false;
        err(ex.status === 0 ? noSignal : ex.message);
      }
    };
  });
}
