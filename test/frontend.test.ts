// Every browser file must at least parse. A syntax error in one module (say, a name declared twice) stops the
// whole app from loading on the phone, and the TypeScript check doesn't look at public/.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../public", import.meta.url));
const jsFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : []);

test("every JavaScript file in public/ parses", () => {
  const files = jsFiles(root);
  assert.ok(files.length > 10, "found the app's files");
  for (const f of files) {
    try {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    } catch (e) {
      assert.fail(`${f} doesn't parse:\n${String((e as { stderr?: Buffer }).stderr ?? e)}`);
    }
  }
});

test("every app script is in the service worker's offline shell (SHELL_FILES)", async () => {
  const { readFileSync } = await import("node:fs");
  const sw = readFileSync(join(root, "sw.js"), "utf8");
  const listed = new Set([...sw.matchAll(/"(\/js\/[^"]+\.js)"/g)].map((m) => m[1]));
  const missing = jsFiles(join(root, "js")).map((f) => "/" + f.slice(root.length + 1).split("\\").join("/")).filter((p) => !listed.has(p));
  assert.deepEqual(missing, [], "add these to SHELL_FILES in public/sw.js so the app works offline");
});
