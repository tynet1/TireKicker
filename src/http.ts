/** Small helpers for request validation and HTTP errors. */

export class HttpError extends Error {
  statusCode: number;
  details?: unknown;
  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const bad = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const notFound = (msg = "Not found.") => new HttpError(404, msg);
export const forbidden = (msg = "You don't have permission to do that.") => new HttpError(403, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function obj(v: unknown, what = "body"): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`Expected an object for ${what}.`);
  return v as Record<string, unknown>;
}

/** Optional trimmed string with a max length; empty becomes null. */
export function str(v: unknown, field: string, max = 2000): string | null {
  if (v == null) return null;
  if (typeof v !== "string") throw bad(`${field} must be text.`);
  const s = v.trim();
  if (s.length > max) throw bad(`${field} is too long (max ${max} characters).`);
  return s || null;
}

export function reqStr(v: unknown, field: string, max = 2000): string {
  const s = str(v, field, max);
  if (!s) throw bad(`${field} is required.`);
  return s;
}

export function int(v: unknown, field: string, min = 0, max = 2_147_483_647): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw bad(`${field} must be a whole number.`);
  return n;
}

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function idParam(params: unknown): number {
  return int((params as { id?: unknown })?.id, "id", 1);
}

export function uuidParam(params: unknown): string {
  const id = (params as { id?: unknown })?.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) throw notFound();
  return id.toLowerCase();
}
