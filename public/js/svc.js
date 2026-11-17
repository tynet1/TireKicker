// Maintenance entry drafts live on the phone (IndexedDB "svc" store) until the server confirms them,
// the same way inspection drafts do. Kept separate from drafts.js so the inspection path is untouched.
//
// Draft keys: "new-<vehicleId>" for a new entry (one per truck), "edit-<entryId>" for an edit.
// A new entry is "queued" on save and the outbox retries it (photos first) until the server answers;
// its phone-generated client_id makes retries safe. Edits are sent while you wait, and the draft is
// kept until the server accepts it.

import { api, ApiError } from "./api.js";
import { uploadPhoto } from "./drafts.js";
import { idb, requestPersistence } from "./idb.js";

const subs = new Set();
const sentSubs = new Set();
export const onSvcChange = (fn) => (subs.add(fn), () => subs.delete(fn));
export const onSvcSent = (fn) => (sentSubs.add(fn), () => sentSubs.delete(fn));
const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

let active = null;
export function setActiveSvc(d) { active = d; }

export async function getSvcDraft(key) {
  if (active && active.key === key) return active;
  return idb.get("svc", key);
}

export async function saveSvcDraft(d) {
  d.updatedAt = Date.now();
  await idb.put("svc", d);
  requestPersistence();
  notify();
}

export async function deleteSvcDraft(d) {
  for (const p of d.photos || []) await idb.del("blobs", p.id).catch(() => {});
  await idb.del("svc", d.key);
  if (active && active.key === d.key) active = null;
  notify();
}

export const allSvcDrafts = () => idb.all("svc");

/** Upload the draft's photos that haven't reached the server. Returns false if signal dropped. */
export async function syncSvcPhotos(key) {
  const d0 = await getSvcDraft(key);
  if (!d0) return true;
  for (const ph of d0.photos.filter((p) => !p.uploaded)) {
    try {
      await uploadPhoto(ph.id);
    } catch (e) {
      if (e instanceof ApiError && (e.retryable || e.status === 401)) return false;
      throw e;
    }
    const d = await getSvcDraft(key);
    const cur = d?.photos.find((p) => p.id === ph.id);
    if (cur && !cur.uploaded) {
      cur.uploaded = true;
      await saveSvcDraft(d);
    }
  }
  return true;
}

// ---------- Outbox (new entries) ----------

let flushing = null;
let retryTimer = null;
let attempt = 0;

export function flushSvc() {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  clearTimeout(retryTimer);
  const queued = (await allSvcDrafts().catch(() => [])).filter((d) => d.status === "queued");
  let waiting = false;
  for (const d of queued) {
    const r = await sendSvc(d.key);
    if (r.state === "waiting") waiting = true;
  }
  if (waiting) {
    attempt++;
    retryTimer = setTimeout(flushSvc, Math.min(60000, 2000 * 2 ** attempt) + Math.random() * 1000);
  } else {
    attempt = 0;
  }
}

/**
 * Send a draft: a queued new entry (POST) or an edit (PATCH).
 * Returns { state: "sent" | "waiting" | "rejected" | "none", res?, error? }.
 */
export async function sendSvc(key) {
  let d = await getSvcDraft(key);
  if (!d || !d.payload) return { state: "none" };
  try {
    if (!(await syncSvcPhotos(key))) throw new ApiError(0, "Waiting for signal");
    d = await getSvcDraft(key);
    const res = d.entryId
      ? await api(`/service-logs/${d.entryId}`, { method: "PATCH", body: d.payload, timeout: 60000 })
      : await api("/service-logs", { method: "POST", body: d.payload, timeout: 60000 });
    await deleteSvcDraft(d);
    sentSubs.forEach((fn) => fn(d, res));
    return { state: "sent", res };
  } catch (e) {
    d = await getSvcDraft(key);
    if (!d) return { state: "none" };
    const err = e instanceof ApiError ? e : new ApiError(0, String(e?.message || e));
    if (err.details?.code === "photos_missing") {
      for (const p of d.photos) if (err.details.photos?.includes(p.id)) p.uploaded = false;
      d.lastError = "Re-sending photos";
      await saveSvcDraft(d);
      return { state: "waiting", error: err };
    }
    if ((err.retryable || err.status === 401) && !d.entryId) {
      d.lastError = err.status === 401 ? "Sign in to finish uploading" : err.details?.retry_later ? err.message : "Waiting for signal";
      d.attempts = (d.attempts || 0) + 1;
      await saveSvcDraft(d);
      return { state: "waiting", error: err };
    }
    // Rejected, or an edit that couldn't be sent: back to editing, nothing typed is lost.
    d.status = "editing";
    d.lastError = err.message;
    d.lastErrorDetails = err.details ?? null;
    delete d.payload;
    await saveSvcDraft(d);
    return { state: err.retryable || err.status === 401 ? "waiting" : "rejected", error: err };
  }
}

window.addEventListener("online", () => flushSvc());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushSvc(); });
