// Incident report drafts live on the phone (IndexedDB "incident" store) until the server confirms them, the same way
// yard walks do (yardq.js). One draft per truck: key "incident-<vehicleId>". Saving marks it "queued" with its payload,
// and the outbox retries it (photos first) until the server answers; the phone-made client_id makes retries safe.

import { api, ApiError } from "./api.js";
import { uploadPhoto } from "./drafts.js";
import { idb, requestPersistence } from "./idb.js";

const subs = new Set();
const sentSubs = new Set();
export const onIncChange = (fn) => (subs.add(fn), () => subs.delete(fn));
export const onIncSent = (fn) => (sentSubs.add(fn), () => sentSubs.delete(fn));
const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

let active = null;
export function setActiveInc(d) { active = d; }

export const incKey = (vehicleId) => `incident-${vehicleId}`;

export async function getIncDraft(key) {
  if (active && active.key === key) return active;
  return idb.get("incident", key);
}

export async function saveIncDraft(d) {
  d.updatedAt = Date.now();
  await idb.put("incident", d);
  requestPersistence();
  notify();
}

export async function deleteIncDraft(d) {
  for (const p of d.photos || []) await idb.del("blobs", p.id).catch(() => {});
  await idb.del("incident", d.key);
  if (active && active.key === d.key) active = null;
  notify();
}

export const allIncDrafts = () => idb.all("incident");

/** Upload the draft's photos that haven't reached the server. Returns false if signal dropped. */
export async function syncIncPhotos(key) {
  const d0 = await getIncDraft(key);
  if (!d0) return true;
  for (const ph of d0.photos.filter((p) => !p.uploaded)) {
    try {
      await uploadPhoto(ph.id);
    } catch (e) {
      if (e instanceof ApiError && (e.retryable || e.status === 401)) return false;
      throw e;
    }
    const d = await getIncDraft(key);
    const cur = d?.photos.find((p) => p.id === ph.id);
    if (cur && !cur.uploaded) {
      cur.uploaded = true;
      await saveIncDraft(d);
    }
  }
  return true;
}

// ---------- Outbox ----------

let flushing = null;
let retryTimer = null;
let attempt = 0;

export function flushInc() {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  clearTimeout(retryTimer);
  const queued = (await allIncDrafts().catch(() => [])).filter((d) => d.status === "queued");
  let waiting = false;
  for (const d of queued) {
    const r = await sendInc(d.key);
    if (r.state === "waiting") waiting = true;
  }
  if (waiting) {
    attempt++;
    retryTimer = setTimeout(flushInc, Math.min(60000, 2000 * 2 ** attempt) + Math.random() * 1000);
  } else {
    attempt = 0;
  }
}

/** Send one queued report. Returns { state: "sent" | "waiting" | "rejected" | "none", res?, error? }. */
export async function sendInc(key) {
  let d = await getIncDraft(key);
  if (!d || d.status !== "queued" || !d.payload) return { state: "none" };
  try {
    if (!(await syncIncPhotos(key))) throw new ApiError(0, "Waiting for signal");
    d = await getIncDraft(key);
    const res = await api("/incidents", { method: "POST", body: d.payload, timeout: 90000 });
    await deleteIncDraft(d);
    sentSubs.forEach((fn) => fn(d, res));
    return { state: "sent", res };
  } catch (e) {
    d = await getIncDraft(key);
    if (!d) return { state: "none" };
    const err = e instanceof ApiError ? e : new ApiError(0, String(e?.message || e));
    if (err.details?.code === "photos_missing") {
      for (const p of d.photos) if (err.details.photos?.includes(p.id)) p.uploaded = false;
      d.lastError = "Re-sending photos";
      await saveIncDraft(d);
      return { state: "waiting", error: err };
    }
    if (err.retryable || err.status === 401) {
      d.lastError = err.status === 401 ? "Sign in to finish uploading" : err.details?.retry_later ? err.message : "Waiting for signal";
      d.attempts = (d.attempts || 0) + 1;
      await saveIncDraft(d);
      return { state: "waiting", error: err };
    }
    // The server rejected it: back to editing so the supervisor can fix it. Nothing typed is lost.
    d.status = "editing";
    d.lastError = err.message;
    d.lastErrorDetails = err.details ?? null;
    delete d.payload;
    await saveIncDraft(d);
    return { state: "rejected", error: err };
  }
}

window.addEventListener("online", () => flushInc());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushInc(); });
