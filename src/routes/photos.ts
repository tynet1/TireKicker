import type { FastifyInstance } from "fastify";
import { atLeast, requireUser } from "../auth.ts";
import { config } from "../config.ts";
import { one, q } from "../db.ts";
import { bad, HttpError, notFound, UUID_RE, uuidParam } from "../http.ts";
import { discardUnlessUsed, files, imageType, newKey } from "../storage.ts";
import { UNATTACHED } from "../photo-owners.ts";

export default async function photoRoutes(app: FastifyInstance) {
  /**
   * Upload one photo before the inspection is submitted. The phone picks the photo's uuid,
   * so a retried upload of the same photo is a no-op instead of a duplicate.
   * multipart fields: id (uuid) first, then file.
   */
  app.post("/photos", async (req, reply) => {
    const user = requireUser(req);
    const part = await req.file({ limits: { fileSize: config.photo.maxBytes, files: 1 } });
    if (!part) throw bad("No photo was sent.");
    const idField = part.fields.id as { value?: unknown } | undefined;
    const id = typeof idField?.value === "string" ? idField.value.toLowerCase() : "";
    if (!UUID_RE.test(id)) throw bad("Photo id must be a uuid.");

    const data = await part.toBuffer();
    if (part.file.truncated) throw bad("Photo is too large.");
    const type = imageType(data);
    if (!type) throw bad("That file isn't a JPEG or PNG photo.");

    // Already here: a retry, or the same phone sending it again with someone else signed in (a shared phone whose
    // first user's session ended). The stored photo is never replaced. Photo ids are random and only ever known to
    // the phone that took the photo, so this hands nobody else's photo to anyone.
    if (await one(`SELECT 1 FROM photos WHERE id = $1`, [id])) return reply.code(200).send({ id });
    await assertRoomFor(user.id, data.length, req.log);
    // A new file name for every upload: a file is never shared by two rows or written over. (With the photo id as the
    // name, the orphan clean-up could remove an old upload's file just after the phone sent the photo again.)
    const key = newKey(type.ext);
    await files.put(key, data);
    const ins = await one(
      `INSERT INTO photos (id, file_path, content_type, bytes, uploaded_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, key, type.mime, data.length, user.id],
    ).catch(async (e) => {
      await discardUnlessUsed(key, async () => !!(await one(`SELECT 1 FROM photos WHERE file_path = $1`, [key])));
      throw e;
    });
    // The same photo arrived twice at once and the other upload stored it: this copy isn't needed.
    if (!ins) await discardUnlessUsed(key, async () => !!(await one(`SELECT 1 FROM photos WHERE file_path = $1`, [key])));
    return reply.code(ins ? 201 : 200).send({ id });
  });

  /**
   * Refuse a new photo if this person has uploaded a lot today, or the server disk is nearly full (the database is
   * on the same disk). Both answers tell the phone to keep the photo and try again later, so nothing is lost.
   */
  async function assertRoomFor(userId: number, bytes: number, log: { error: (o: object, m: string) => void }) {
    const free = await files.freeBytes().catch(() => null);
    if (free !== null && free - bytes < config.photo.minFreeBytes) {
      log.error({ freeMB: Math.round(free / 1048576) }, "photo uploads paused: the server disk is nearly full");
      throw new HttpError(503, "The server is nearly out of storage, so your photos are waiting on this phone. They'll upload once your admin frees up space", { code: "disk_low", retry_later: true });
    }
    const used = await one<{ bytes: string }>(
      `SELECT coalesce(sum(bytes), 0) AS bytes FROM photos WHERE uploaded_by = $1 AND created_at > now() - interval '24 hours'`,
      [userId],
    );
    if (Number(used?.bytes ?? 0) + bytes > config.photo.dailyBytesPerUser) {
      const mb = Math.round(config.photo.dailyBytesPerUser / 1048576);
      throw new HttpError(429, `You've reached the daily photo limit (${mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${mb} MB`}), so your photos are waiting on this phone. They'll upload later today or tomorrow`, { code: "upload_cap", retry_later: true });
    }
  }

  app.get("/photos/:id", async (req, reply) => {
    const u = requireUser(req);
    const p = await one(`SELECT file_path, content_type, incident_id, damage_mark_id FROM photos WHERE id = $1`, [uuidParam(req.params)]);
    if (!p) throw notFound("Photo not found.");
    // An incident's photos can show the other party's license or insurance card: supervisors and admins only. Its
    // damage photos are of our truck and show with the truck's damage on file, like any other.
    if (p.incident_id && !p.damage_mark_id && !atLeast(u, "supervisor")) throw notFound("Photo not found.");
    return reply
      .type(p.content_type)
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(files.stream(p.file_path));
  });
}

/**
 * Delete photos that were uploaded but never attached to an inspection or a maintenance entry.
 * (A phone that was offline longer than this still has the photo and uploads it again.)
 */
export async function cleanupOrphanPhotos(log: (m: string) => void): Promise<void> {
  const rows = await q(
    `DELETE FROM photos
      WHERE ${UNATTACHED}
        AND created_at < now() - make_interval(days => $1)
     RETURNING file_path`,
    [config.photo.orphanDays],
  );
  for (const r of rows) await files.remove(r.file_path).catch(() => {});
  if (rows.length) log(`removed ${rows.length} orphan photo(s)`);
}
