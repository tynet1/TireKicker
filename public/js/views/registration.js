// Registration expiration (SPEC §9): the warning pill, the supervisor's "Update registration" box, and the history.
// Used by the truck page, the inspection form and the sign-off screen.
import { api } from "../api.js";
import { deletePhotoBlob, storePhotoBlob, uploadPhoto } from "../drafts.js";
import { atLeast } from "../ui.js";
import { esc, fmtDate, modal, shrinkImage, toast, today, uuid } from "../util.js";

const SOON_DAYS = 30;

/** Whole days from `from` (default today) to `date`; negative once it's past. null without a date. */
function daysLeft(date, from = today()) {
  if (!date) return null;
  const utc = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((utc(date) - utc(from)) / 86400000);
}

/** Red "Expired", or amber "Expires in N days" within 30 days; nothing otherwise. `asOf` = judge it on that date. */
export function regPill(date, asOf) {
  const n = daysLeft(date, asOf);
  if (n == null) return "";
  if (n < 0) return `<span class="pill bad">${asOf ? "Was expired" : "Expired"}</span>`;
  if (asOf) return "";
  if (n <= SOON_DAYS) return `<span class="pill warn">${n === 0 ? "Expires today" : `Expires in ${n} day${n === 1 ? "" : "s"}`}</span>`;
  return "";
}

/** The date with its pill and, for a supervisor, an Update button (data-regupd). */
export function regValue(date) {
  return `<span class="regval">${date ? fmtDate(date) : "—"} ${regPill(date)}${
    atLeast("supervisor") ? `<button type="button" class="link" data-regupd>Update</button>` : ""}</span>`;
}

/**
 * Supervisor: enter the truck's new registration expiration, with an optional photo of the new registration or
 * sticker. `from` is "form", "sign-off" or "truck" (sign-off also passes the inspection). It needs signal; nothing
 * is queued. Resolves the new date once saved, or null if cancelled.
 */
export function updateRegistration(v, { from, inspectionId = null }) {
  return new Promise((resolve) => {
    const clientId = uuid();
    let was = v.registration_expires ?? null;
    let photo = null; // { id, url }
    let pastOk = false;
    const md = modal(`<h3>Update registration</h3>
      <p class="muted" style="margin-top:-6px">${esc(v.truck_code)} · on file now: <b id="rgWas">${was ? fmtDate(was) : "no date"}</b></p>
      <label class="f" for="rgDate">New expiration date</label>
      <input class="t" type="date" id="rgDate">
      <label class="f" for="rgNote" style="margin-top:12px">Note (optional)</label>
      <input class="t" id="rgNote" maxlength="500" placeholder="e.g. Renewed online, new sticker on the plate">
      <label class="f" style="margin-top:12px">Photo of the new registration or sticker (optional)</label>
      <div id="rgPhoto"></div>
      <div id="rgErr"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="secondary" data-c>Cancel</button><button class="primary" data-y>Save</button></div>`);
    const err = (msg) => { md.querySelector("#rgErr").innerHTML = msg ? `<div class="banner err">${esc(msg)}</div>` : ""; };
    const drawPhoto = () => {
      md.querySelector("#rgPhoto").innerHTML = photo
        ? `<div class="photos"><div class="ph"><img alt="Photo of the registration" src="${photo.url}">
            <button type="button" class="x" data-rm aria-label="Remove photo">×</button></div></div>`
        : `<label class="addph" style="aspect-ratio:auto;min-height:88px"><span style="font-size:24px">📷</span><span>Take or pick a photo</span>
            <input type="file" accept="image/*" id="rgFile"></label>`;
      const rm = md.querySelector("[data-rm]");
      if (rm) rm.onclick = () => { deletePhotoBlob(photo.id).catch(() => {}); URL.revokeObjectURL(photo.url); photo = null; drawPhoto(); };
      const inp = md.querySelector("#rgFile");
      if (inp) inp.onchange = async () => {
        const file = inp.files?.[0];
        if (!file) return;
        const blob = await shrinkImage(file);
        const id = uuid();
        await storePhotoBlob(id, blob);
        photo = { id, url: URL.createObjectURL(blob) };
        drawPhoto();
      };
    };
    drawPhoto();
    md.querySelector("#rgDate").oninput = () => { pastOk = false; err(""); };
    const close = (out) => {
      if (photo) { URL.revokeObjectURL(photo.url); deletePhotoBlob(photo.id).catch(() => {}); }
      md.remove();
      resolve(out);
    };
    md.querySelector("[data-c]").onclick = () => close(null);
    md.querySelector("[data-y]").onclick = async (e) => {
      const expires = md.querySelector("#rgDate").value;
      if (!expires) return err("Pick the new expiration date.");
      if (expires === was) return err("That's already the date on file.");
      if (expires < today() && !pastOk) {
        pastOk = true;
        return err("That date has already passed, so the truck will show as expired. Tap Save again if it's right.");
      }
      const b = e.target;
      b.disabled = true;
      b.innerHTML = `<span class="spinner"></span>&nbsp;Saving…`;
      try {
        if (photo) await uploadPhoto(photo.id);
        const r = await api(`/vehicles/${v.id}/registration`, {
          method: "POST",
          body: {
            client_id: clientId, expires, was, from, inspection_id: inspectionId,
            note: md.querySelector("#rgNote").value.trim() || null, photo_ids: photo ? [photo.id] : [],
          },
        });
        toast("Registration updated ✓");
        close(r.registration_expires);
      } catch (ex) {
        b.disabled = false;
        b.textContent = "Save";
        if (ex.details?.code === "registration_changed") {
          was = ex.details.registration_expires ?? null;
          md.querySelector("#rgWas").textContent = was ? fmtDate(was) : "no date";
        }
        err(ex.status === 0 ? "No signal, so the new date wasn't saved. Try again when you have signal." : ex.message);
      }
    };
  });
}

const SOURCE = {
  form: "from an inspection form",
  "sign-off": "while signing off",
  truck: "on the truck page",
  admin: "in Admin → Trucks",
  other: "outside the app",
};

/** Every change, newest first (truck page). Thumbnails carry data-lb for the lightbox. */
export function regHistoryHtml(list) {
  if (!list?.length) return "";
  return `<details class="onfile"><summary>Registration history (${list.length})</summary><ul class="dmglist">${list.map((r) => `<li><div class="grow">
      <b>${r.expires ? fmtDate(r.expires) : "No date"}</b> <span class="small muted">was ${r.previous ? fmtDate(r.previous) : "no date"}</span>
      <div class="small muted">${fmtDate(r.changed_at)}${r.changed_by_name ? ` by ${esc(r.changed_by_name)}` : ""} · ${esc(SOURCE[r.source] || r.source)}${
        r.inspection_id ? ` · <a href="#/inspection/${esc(r.inspection_id)}">inspection</a>` : ""}</div>
      ${r.note ? `<div class="small">${esc(r.note)}</div>` : ""}
      ${r.photo_ids?.length ? `<div class="row" style="margin-top:4px">${r.photo_ids.map((id) =>
        `<img class="dmgthumb" src="/api/photos/${esc(id)}" data-lb="${esc(id)}" data-cap="${esc(`Registration ${fmtDate(r.expires)}`)}" alt="Photo of the registration">`).join("")}</div>` : ""}
    </div></li>`).join("")}</ul></details>`;
}
