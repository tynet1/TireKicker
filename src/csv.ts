// CSV files for Excel, Google Sheets or Numbers (RFC 4180: comma-separated, CRLF, double quotes doubled).

export type Cell = string | number | boolean | Date | null | undefined;

const pad = (n: number) => String(n).padStart(2, "0");

/** A timestamp in the server's time zone (TZ), as Excel reads it: 2026-11-17 14:05. */
export function stamp(d: Date | null | undefined): string {
  if (!d) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * One cell. Text a spreadsheet would run as a formula (starting with = + - @, a tab or a return) gets a leading
 * apostrophe, so a note typed on a phone can't turn into a formula on the office PC.
 */
export function cell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = v instanceof Date ? stamp(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The whole file. It starts with a byte-order mark so Excel opens it as UTF-8 (names with accents stay right). */
export function toCsv(header: string[], rows: Cell[][]): string {
  const lines = [header, ...rows].map((r) => r.map(cell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}
