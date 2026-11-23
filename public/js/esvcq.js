// Equipment maintenance drafts live on the phone (IndexedDB "esvc" store) until the server confirms them, the same way truck
// inspection drafts do. Kept separate from the other queues so those paths are untouched.
//
// Draft key: "esvc-<equipmentId>" (one entry in progress per piece). Saving marks it "queued" with its payload, and the
// outbox retries it (photos first) until the server answers; the phone-made client_id makes retries safe.

import { api, ApiError } from "./api.js";
import { uploadPhoto } from "./drafts.js";
import { idb, requestPersistence } from "./idb.js";

const subs = new Set();
const sentSubs = new Set();
export const onEsvcChange = (fn) => (subs.add(fn), () => subs.delete(fn));
export const onEsvcSent = (fn) => (sentSubs.add(fn), () => sentSubs.delete(fn));
const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

let active = null;
export function setActiveEsvc(d) { active = d; }

export const esvcKey = (equipmentId) => `esvc-${equipmentId}`;

export async function getEsvcDraft(key) {
  if (active && active.key === key) return active;
  return idb.get("esvc", key);
}

export async function saveEsvcDraft(d) {
  d.updatedAt = Date.now();
  await idb.put("esvc", d);
  requestPersistence();
  notify();
}

export async function deleteEsvcDraft(d) {
  for (const p of d.photos || []) await idb.del("blobs", p.id).catch(() => {});
  await idb.del("esvc", d.key);
  if (active && active.key === d.key) active = null;
  notify();
}

export const allEsvcDrafts = () => idb.all("esvc");

/** Upload the draft's photos that haven't reached the server. Returns false if signal dropped. */
export async function syncEsvcPhotos(key) {
  const d0 = await getEsvcDraft(key);
  if (!d0) return true;
  for (const ph of d0.photos.filter((p) => !p.uploaded)) {
    try {
      await uploadPhoto(ph.id);
    } catch (e) {
      if (e instanceof ApiError && (e.retryable || e.status === 401)) return false;
      throw e;
    }
    const d = await getEsvcDraft(key);
    const cur = d?.photos.find((p) => p.id === ph.id);
    if (cur && !cur.uploaded) {
      cur.uploaded = true;
      await saveEsvcDraft(d);
    }
  }
  return true;
}

// ---------- Outbox ----------

let flushing = null;
let retryTimer = null;
let attempt = 0;

export function flushEsvc() {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  clearTimeout(retryTimer);
  const queued = (await allEsvcDrafts().catch(() => [])).filter((d) => d.status === "queued");
  let waiting = false;
  for (const d of queued) {
    const r = await sendEsvc(d.key);
    if (r.state === "waiting") waiting = true;
  }
  if (waiting) {
    attempt++;
    retryTimer = setTimeout(flushEsvc, Math.min(60000, 2000 * 2 ** attempt) + Math.random() * 1000);
  } else {
    attempt = 0;
  }
}

/** Send one queued entry. Returns { state: "sent" | "waiting" | "rejected" | "none", res?, error? }. */
export async function sendEsvc(key) {
  let d = await getEsvcDraft(key);
  if (!d || d.status !== "queued" || !d.payload) return { state: "none" };
  try {
    if (!(await syncEsvcPhotos(key))) throw new ApiError(0, "Waiting for signal");
    d = await getEsvcDraft(key);
    const res = await api("/equipment-service", { method: "POST", body: d.payload, timeout: 60000 });
    await deleteEsvcDraft(d);
    sentSubs.forEach((fn) => fn(d, res));
    return { state: "sent", res };
  } catch (e) {
    d = await getEsvcDraft(key);
    if (!d) return { state: "none" };
    const err = e instanceof ApiError ? e : new ApiError(0, String(e?.message || e));
    if (err.details?.code === "photos_missing") {
      for (const p of d.photos) if (err.details.photos?.includes(p.id)) p.uploaded = false;
      d.lastError = "Re-sending photos";
      await saveEsvcDraft(d);
      return { state: "waiting", error: err };
    }
    if (err.retryable || err.status === 401) {
      d.lastError = err.status === 401 ? "Sign in to finish uploading" : err.details?.retry_later ? err.message : "Waiting for signal";
      d.attempts = (d.attempts || 0) + 1;
      await saveEsvcDraft(d);
      return { state: "waiting", error: err };
    }
    // The server rejected it: back to editing so it can be fixed. Nothing typed is lost.
    d.status = "editing";
    d.lastError = err.message;
    d.lastErrorDetails = err.details ?? null;
    delete d.payload;
    await saveEsvcDraft(d);
    return { state: "rejected", error: err };
  }
}

window.addEventListener("online", () => flushEsvc());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushEsvc(); });
