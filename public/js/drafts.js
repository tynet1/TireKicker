// Drafts live on the phone (IndexedDB) until the server confirms the submit.
//
// A draft is keyed by vehicleId and has status "editing" or "queued". Saving the form builds the
// API payload, marks the draft "queued", and the outbox keeps retrying (photos first, then the
// inspection) until the server answers. The phone-generated client_id makes retries safe.

import { api, ApiError } from "./api.js";
import { idb, requestPersistence } from "./idb.js";

const subs = new Set();
const sentSubs = new Set();
export const onDraftsChange = (fn) => (subs.add(fn), () => subs.delete(fn));
export const onSent = (fn) => (sentSubs.add(fn), () => sentSubs.delete(fn));
const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

// The open form owns its draft object; background uploads update that same object so
// nothing it changes is lost by the form saving an older copy.
let active = null;
export function setActiveDraft(d) { active = d; }

export async function getDraft(vehicleId) {
  const id = Number(vehicleId);
  if (active && active.vehicleId === id) return active;
  return idb.get("drafts", id);
}

export async function saveDraft(d) {
  d.updatedAt = Date.now();
  await idb.put("drafts", d);
  requestPersistence();
  notify();
}

export async function deleteDraft(d) {
  for (const p of d.photos || []) await idb.del("blobs", p.id).catch(() => {});
  await idb.del("drafts", d.vehicleId);
  if (active && active.vehicleId === d.vehicleId) active = null;
  notify();
}

export const allDrafts = () => idb.all("drafts");

// ---------- Photos ----------

export const storePhotoBlob = (id, blob) => idb.put("blobs", { id, blob });
export const deletePhotoBlob = (id) => idb.del("blobs", id);
export async function photoBlob(id) {
  return (await idb.get("blobs", id))?.blob ?? null;
}

const inflight = new Map();
/** Upload one photo from this phone's store (shared with maintenance entries). */
export function uploadPhoto(id) {
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const blob = await photoBlob(id);
    if (!blob) throw new ApiError(400, "A photo is missing from this phone. Remove it and add it again.");
    const fd = new FormData();
    fd.append("id", id);
    fd.append("file", blob, `${id}.jpg`);
    await api("/photos", { method: "POST", form: fd, timeout: 120000 });
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** Upload the draft's photos that haven't reached the server. Returns false if signal dropped. */
export async function syncPhotos(vehicleId) {
  const d0 = await getDraft(vehicleId);
  if (!d0) return true;
  for (const ph of d0.photos.filter((p) => !p.uploaded)) {
    try {
      await uploadPhoto(ph.id);
    } catch (e) {
      if (e instanceof ApiError && (e.retryable || e.status === 401)) return false;
      throw e;
    }
    const d = await getDraft(vehicleId);
    const cur = d?.photos.find((p) => p.id === ph.id);
    if (cur && !cur.uploaded) {
      cur.uploaded = true;
      await saveDraft(d);
    }
  }
  return true;
}

// ---------- Outbox ----------

let flushing = null;
let retryTimer = null;
let attempt = 0;

/** Try to send every queued draft. Safe to call often; schedules its own retries with backoff. */
export function flush() {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  clearTimeout(retryTimer);
  const queued = (await allDrafts()).filter((d) => d.status === "queued");
  let waiting = false;
  for (const d of queued) {
    const r = await sendQueued(d.vehicleId);
    if (r.state === "waiting") waiting = true;
  }
  if (waiting) {
    attempt++;
    retryTimer = setTimeout(flush, Math.min(60000, 2000 * 2 ** attempt) + Math.random() * 1000);
  } else {
    attempt = 0;
  }
}

/** Send one queued draft. Returns { state: "sent" | "waiting" | "rejected" | "none", res?, error? }. */
export async function sendQueued(vehicleId) {
  let d = await getDraft(vehicleId);
  if (!d || d.status !== "queued") return { state: "none" };
  try {
    if (!(await syncPhotos(vehicleId))) throw new ApiError(0, "Waiting for signal");
    d = await getDraft(vehicleId);
    const res = await api("/inspections", { method: "POST", body: d.payload, timeout: 60000 });
    await deleteDraft(d);
    sentSubs.forEach((fn) => fn(d, res));
    return { state: "sent", res };
  } catch (e) {
    d = await getDraft(vehicleId);
    if (!d) return { state: "none" };
    const err = e instanceof ApiError ? e : new ApiError(0, String(e?.message || e));
    if (err.details?.code === "photos_missing") {
      // Server lost track of some uploads (e.g. queued for over a week); upload them again.
      for (const p of d.photos) if (err.details.photos?.includes(p.id)) p.uploaded = false;
      d.lastError = "Re-sending photos";
      await saveDraft(d);
      return { state: "waiting", error: err };
    }
    if (err.retryable || err.status === 401) {
      d.lastError = err.status === 401 ? "Sign in to finish uploading" : err.details?.retry_later ? err.message : "Waiting for signal";
      d.attempts = (d.attempts || 0) + 1;
      await saveDraft(d);
      return { state: "waiting", error: err };
    }
    // The server rejected it: back to editing so the inspector can fix it.
    d.status = "editing";
    d.lastError = err.message;
    d.lastErrorDetails = err.details ?? null;
    delete d.payload;
    await saveDraft(d);
    return { state: "rejected", error: err };
  }
}

window.addEventListener("online", () => flush());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flush(); });
