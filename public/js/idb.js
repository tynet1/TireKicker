// IndexedDB wrapper for drafts and photo blobs. Falls back to memory if IndexedDB is unavailable
// (then drafts won't survive closing the browser, and the app says so).
//
// Version 2 adds the "svc" store (maintenance entry drafts), version 3 the "yard" store (yard walk drafts),
// version 4 the "equip" store (equipment check drafts), version 5 the "esvc" store (equipment maintenance drafts),
// version 6 the "incident" store (incident report drafts).
// Upgrading only creates missing stores, so drafts and photos saved by older versions are kept.

const DB_NAME = "tirekicker";
const DB_VERSION = 6;
const STORES = { drafts: "vehicleId", blobs: "id", svc: "key", yard: "key", equip: "key", esvc: "key", incident: "key" };

let dbp = null;
let memory = null; // { drafts: Map, blobs: Map, svc: Map } when IndexedDB can't be used

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no indexedDB"));
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, { keyPath });
      }
    };
    r.onsuccess = () => {
      // If a newer copy of the app opens a newer version in another tab, let it upgrade.
      r.result.onversionchange = () => { r.result.close(); dbp = null; };
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => console.warn("IndexedDB upgrade is waiting for another tab of this app to close");
  }).catch((e) => {
    console.warn("IndexedDB unavailable, keeping drafts in memory only", e);
    memory = { drafts: new Map(), blobs: new Map(), svc: new Map(), yard: new Map(), equip: new Map(), esvc: new Map(), incident: new Map() };
    return null;
  });
  return dbp;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    let out;
    req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export const idb = {
  async get(store, key) {
    const db = await open();
    if (!db) return memory[store].get(key) ?? null;
    return (await tx(db, store, "readonly", (s) => s.get(key))) ?? null;
  },
  async put(store, value) {
    const db = await open();
    if (!db) return void memory[store].set(value[STORES[store]], structuredClone(value));
    await tx(db, store, "readwrite", (s) => s.put(value));
  },
  async del(store, key) {
    const db = await open();
    if (!db) return void memory[store].delete(key);
    await tx(db, store, "readwrite", (s) => s.delete(key));
  },
  async all(store) {
    const db = await open();
    if (!db) return [...memory[store].values()];
    return (await tx(db, store, "readonly", (s) => s.getAll())) ?? [];
  },
  async isPersistent() {
    return !!(await open());
  },
};

// Ask the browser not to evict our drafts under storage pressure (best effort).
export function requestPersistence() {
  try { navigator.storage?.persist?.(); } catch { /* ignore */ }
}
