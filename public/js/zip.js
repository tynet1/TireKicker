// Minimal ZIP writer for the batch PDF export. Files are "stored" (not compressed): PDFs are
// already compressed, so deflating them again would only cost time on the phone.
// Plain ZIP (no ZIP64), so the whole archive has to stay under 4 GB; the export caps it far below that.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of a byte array (the checksum ZIP uses). */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** "T101_2026-11-10_inspection.pdf" twice -> the second becomes "T101_2026-11-10_inspection_2.pdf". */
export function uniqueName(name, used) {
  let out = name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; used.has(out.toLowerCase()); n++) out = `${base}_${n}${ext}`;
  used.add(out.toLowerCase());
  return out;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Build a .zip from [{ name, blob }]. Names are made unique. Resolves a Blob (application/zip).
 * Each file's bytes are read once for the checksum; the zip itself reuses the original blobs.
 */
export async function makeZip(files, when = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosTime(when);
  const used = new Set();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(uniqueName(f.name, used));
    const bytes = new Uint8Array(await f.blob.arrayBuffer());
    const crc = crc32(bytes);
    const size = bytes.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header
    local.setUint16(4, 20, true);         // version needed (2.0)
    local.setUint16(6, 0x0800, true);     // flags: names are UTF-8
    local.setUint16(8, 0, true);          // method: stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);      // compressed size
    local.setUint32(22, size, true);      // uncompressed size
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);         // extra field length
    parts.push(local.buffer, name, f.blob);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);    // central directory header
    cd.setUint16(4, 20, true);            // version made by
    cd.setUint16(6, 20, true);            // version needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    // 30 extra len, 32 comment len, 34 disk, 36 internal attrs, 38 external attrs: all 0
    cd.setUint32(42, offset, true);       // where this file's local header starts
    central.push(cd.buffer, name);

    offset += 30 + name.length + size;
  }

  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);     // end of central directory
  end.setUint16(8, files.length, true);   // entries on this disk
  end.setUint16(10, files.length, true);  // entries in total
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);        // central directory starts here
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}
