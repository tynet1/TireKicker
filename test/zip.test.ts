// The browser-side ZIP writer used by the batch PDF export (public/js/zip.js).
// It is plain browser JavaScript; Node has the same Blob/TextEncoder, so it runs here as-is.
import assert from "node:assert/strict";
import { crc32 as nodeCrc32 } from "node:zlib";
import { test } from "node:test";

const zipPath = "../public/js/zip.js"; // untyped browser module
const { crc32, makeZip, uniqueName } = await import(zipPath);

/** Read a stored-only zip back: every entry's name and bytes, checked against both headers. */
function readZip(buf: Buffer) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, "end of central directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  assert.equal(p + buf.readUInt32LE(eocd + 12), eocd, "central directory ends where the end record starts");
  const out: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central directory header");
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lh = buf.readUInt32LE(p + 42);
    assert.equal(buf.readUInt32LE(lh), 0x04034b50, "local file header");
    assert.equal(buf.readUInt16LE(lh + 8), 0, "stored, not compressed");
    assert.equal(buf.readUInt32LE(lh + 14), crc);
    assert.equal(buf.readUInt16LE(lh + 26), nameLen);
    const start = lh + 30 + nameLen + buf.readUInt16LE(lh + 28);
    const data = buf.subarray(start, start + size);
    assert.equal(nodeCrc32(data), crc, `checksum of ${name}`);
    out.push({ name, data });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

test("crc32 matches Node's", () => {
  const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff);
  assert.equal(crc32(bytes), nodeCrc32(bytes));
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("duplicate file names get _2, _3 (ignoring case)", () => {
  const used = new Set<string>();
  assert.equal(uniqueName("T002_2026-11-10_inspection.pdf", used), "T002_2026-11-10_inspection.pdf");
  assert.equal(uniqueName("T002_2026-11-10_inspection.pdf", used), "T002_2026-11-10_inspection_2.pdf");
  assert.equal(uniqueName("t002_2026-11-10_inspection.PDF", used), "t002_2026-11-10_inspection_3.PDF");
  assert.equal(uniqueName("README", used), "README");
  assert.equal(uniqueName("README", used), "README_2");
});

test("makeZip writes one entry per file, byte for byte", async () => {
  const a = Buffer.from("%PDF-1.7 first inspection");
  const b = Buffer.alloc(300_000, 0x5a);
  const blob = await makeZip([
    { name: "T002_2026-11-10_inspection.pdf", blob: new Blob([a]) },
    { name: "T002_2026-11-10_inspection.pdf", blob: new Blob([b]) },
    { name: "T018_2026-11-09_inspection.pdf", blob: new Blob([]) },
  ], new Date(2026, 10, 10, 14, 30, 8));
  assert.equal(blob.type, "application/zip");
  const buf = Buffer.from(await blob.arrayBuffer());
  const entries = readZip(buf);
  assert.deepEqual(entries.map((e) => e.name), [
    "T002_2026-11-10_inspection.pdf", "T002_2026-11-10_inspection_2.pdf", "T018_2026-11-09_inspection.pdf",
  ]);
  assert.ok(entries[0].data.equals(a));
  assert.ok(entries[1].data.equals(b));
  assert.equal(entries[2].data.length, 0);
  // DOS date/time in the first local header: 2026-11-10 14:30:08
  assert.equal(buf.readUInt16LE(10), (14 << 11) | (30 << 5) | 4);
  assert.equal(buf.readUInt16LE(12), ((2026 - 1980) << 9) | (11 << 5) | 10);
});
