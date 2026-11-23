import type { Db } from "./db.ts";
import { conflict, HttpError } from "./http.ts";

// Every column that ties a photo to a record. A photo with all of them empty is unattached: uploaded from a phone but
// not yet part of a saved record (the orphan clean-up removes those after a week). Anything that checks or attaches
// photos uses these, so a new kind of record can't be missed in one place (which could let the clean-up erase its
// photos, or let a photo be attached twice). The database's photo guards (latest in migration 018) list the same columns.
export const PHOTO_OWNERS = [
  "inspection_id", "service_log_id", "damage_repair_id", "registration_change_id", "yard_inspection_id", "equipment_check_id",
  "equipment_service_log_id", "incident_id",
] as const;

/** SQL: the photo is attached to nothing. */
export const UNATTACHED = PHOTO_OWNERS.map((c) => `${c} IS NULL`).join(" AND ");

/** SQL column list for checking ownership in code with isUnattached / ownersExcept. */
export const OWNER_COLUMNS = PHOTO_OWNERS.join(", ");

/**
 * A photo couldn't be attached while saving a record. If the photo is gone (the week-old orphan clean-up removed it
 * while the save was on its way), answer photos_missing so the phone uploads it again by itself and resends; otherwise
 * it's on another record and the save is refused with `message`.
 */
export async function attachFailed(c: Db, id: string, message: string): Promise<HttpError> {
  const there = (await c.query(`SELECT 1 FROM photos WHERE id = $1`, [id])).rowCount;
  return there ? conflict(message) : new HttpError(422, "Some photos haven't finished uploading yet.", { code: "photos_missing", photos: [id] });
}

/** In code: the row (selected with OWNER_COLUMNS) is attached to nothing, ignoring `except`. */
export function isUnattached(row: Record<string, unknown>, except: readonly string[] = []): boolean {
  return PHOTO_OWNERS.every((c) => except.includes(c) || row[c] == null);
}
