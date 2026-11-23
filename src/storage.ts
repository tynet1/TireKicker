import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { config } from "./config.ts";

/**
 * Where photos, signatures and uploaded diagrams live. Keys look like "2026/11/<uuid>.jpg".
 * Only the local-disk implementation exists today; an S3 or Azure Blob version can implement
 * the same interface later without touching the routes.
 */
export interface FileStore {
  put(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  stream(key: string): Readable;
  remove(key: string): Promise<void>;
  /** Space left for new files, in bytes (null if the store can't tell). */
  freeBytes(): Promise<number | null>;
}

const KEY_RE = /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.(jpg|png)$/;

export function newKey(ext: "jpg" | "png", id: string = randomUUID()): string {
  const d = new Date();
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}.${ext}`;
}

export function isKey(key: string): boolean {
  return KEY_RE.test(key);
}

class LocalFileStore implements FileStore {
  private root: string;
  constructor(root: string) {
    this.root = root;
  }
  private path(key: string): string {
    if (!KEY_RE.test(key)) throw new Error(`Bad storage key: ${key}`);
    return join(this.root, key);
  }
  /** Write to a temp file, flush it to disk, then rename: a crash never leaves a half-written file. */
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    try {
      const fh = await open(tmp, "wx");
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, p);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    // Flush the folder too, so the new name itself survives a power cut (Linux; Windows can't open a folder this way).
    try {
      const dir = await open(dirname(p), "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { /* not supported here */ }
  }
  read(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
  stream(key: string): Readable {
    return createReadStream(this.path(key));
  }
  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
  async freeBytes(): Promise<number | null> {
    await mkdir(this.root, { recursive: true });
    const s = await statfs(this.root);
    return s.bavail * s.bsize;
  }
}

export const files: FileStore = new LocalFileStore(config.uploadDir);

/**
 * Remove a file written for a save that then failed, unless the save went through after all: the connection can drop
 * after the database committed but before it said so. `used` asks the database whether anything points at the file;
 * if that can't be answered (database down), the file stays. A spare file costs a few KB; a missing one loses a signature.
 */
export async function discardUnlessUsed(key: string, used: () => Promise<boolean>): Promise<void> {
  try {
    if (await used()) return;
  } catch {
    return;
  }
  await files.remove(key).catch(() => {});
}

/** Sniff the real image type from the first bytes; never trust the client's content-type. */
export function imageType(buf: Buffer): { ext: "jpg" | "png"; mime: string } | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", mime: "image/png" };
  }
  return null;
}

/** Decode a signature canvas data URL ("data:image/png;base64,...") into PNG bytes. */
export function decodePngDataUrl(s: unknown, maxBytes = 600_000): Buffer | null {
  if (typeof s !== "string") return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 100 || buf.length > maxBytes || imageType(buf)?.ext !== "png") return null;
  return buf;
}
