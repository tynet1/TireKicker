// Fetch wrapper for /api. Every non-GET call carries the x-gc-app header (CSRF guard on the server).

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
  /** True when trying again later might work (no signal, server or tunnel briefly down). */
  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

const listeners = new Set();
export const onSignedOut = (fn) => listeners.add(fn);

export async function api(path, { method = "GET", body, form, timeout = 30000 } = {}) {
  const headers = { "x-gc-app": "1" };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch("/api" + path, { method, headers, body: payload, credentials: "same-origin", signal: ctl.signal });
  } catch {
    throw new ApiError(0, "No connection. Check your signal and try again.");
  } finally {
    clearTimeout(timer);
  }
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/pin" && path !== "/auth/login") listeners.forEach((fn) => fn());
    // A 502/504 page from the proxy or tunnel means the app is unreachable, same as no signal.
    throw new ApiError(res.status, data?.message || `Server error (${res.status}).`, data?.details);
  }
  return data;
}

/**
 * Download a file from /api (a PDF). Resolves { blob, filename }; the filename comes from the
 * server's Content-Disposition. `signal` cancels it (rejects with an AbortError, never retried).
 */
export async function apiFile(path, { timeout = 90000, signal } = {}) {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const cancel = () => ctl.abort();
  signal?.addEventListener("abort", cancel);
  try {
    let res;
    try {
      res = await fetch("/api" + path, { headers: { "x-gc-app": "1" }, credentials: "same-origin", signal: ctl.signal });
      if (res.ok) {
        const blob = await res.blob();
        const m = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "");
        return { blob, filename: m ? m[1] : path.split("/").filter(Boolean).join("_") };
      }
    } catch (e) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      throw new ApiError(0, "No connection. Check your signal and try again.");
    }
    const data = (res.headers.get("content-type") || "").includes("json") ? await res.json().catch(() => null) : null;
    if (res.status === 401) listeners.forEach((fn) => fn());
    throw new ApiError(res.status, data?.message || `Server error (${res.status}).`, data?.details);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

/** Retry a call with exponential backoff while the error is retryable. */
export async function withRetry(fn, { tries = 4, base = 1500 } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || !e.retryable || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, base * 2 ** i + Math.random() * 500));
    }
  }
}
