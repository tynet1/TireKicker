// CSV formatting, no database needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cell, toCsv } from "../src/csv.ts";

test("CSV cells: quotes, commas and line breaks are quoted; yes/no; blanks", () => {
  assert.equal(cell("Plain"), "Plain");
  assert.equal(cell('Says "hi", twice'), '"Says ""hi"", twice"');
  assert.equal(cell("Line one\nline two"), '"Line one\nline two"');
  assert.equal(cell(true), "Yes");
  assert.equal(cell(false), "No");
  assert.equal(cell(null), "");
  assert.equal(cell(undefined), "");
  assert.equal(cell(61000), "61000");
  assert.equal(cell(-5), "-5", "a real number stays a number");
  assert.equal(cell(new Date(2026, 10, 17, 9, 5)), "2026-11-17 09:05");
});

test("CSV cells: text that a spreadsheet would run as a formula gets an apostrophe", () => {
  assert.equal(cell("=HYPERLINK(\"http://x\",\"click\")"), `"'=HYPERLINK(""http://x"",""click"")"`);
  assert.equal(cell("+1 555"), "'+1 555");
  assert.equal(cell("- leaking oil"), "'- leaking oil");
  assert.equal(cell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(cell("2+2"), "2+2", "only a leading sign counts");
});

test("CSV file: byte-order mark, header first, CRLF line ends", () => {
  const s = toCsv(["A", "B"], [[1, "x,y"], [null, true]]);
  assert.equal(s, "﻿A,B\r\n1,\"x,y\"\r\n,Yes\r\n");
});
