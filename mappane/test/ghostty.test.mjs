// Exercise the Linux launcher on any Unix host without opening a desktop window.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Linux tab launches the pane with intact environment arguments", { skip: process.platform === "win32" }, (t) => {
  const bin = mkdtempSync(join(tmpdir(), "ghostty-test-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Linux\n", { mode: 0o755 });
  writeFileSync(join(bin, "ghostty"), '#!/bin/sh\nprintf "%s\\0" "$@"\n', { mode: 0o755 });
  const launcher = fileURLToPath(new URL("../bin/map-pane", import.meta.url));
  const env = { PATH: bin + ":" + process.env.PATH, CHROME: "/a path/chrome" };
  const args = execFileSync(launcher, ["--tab"], { env, encoding: "utf8" }).split("\0");
  assert.deepEqual(args, ["+new-tab", "-e", "env", "PATH=" + env.PATH, "CHROME=" + env.CHROME, launcher, ""]);
});

test("macOS split preserves paths with spaces in the new shell", { skip: process.platform === "win32" }, (t) => {
  const bin = mkdtempSync(join(tmpdir(), "ghostty-test-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
  writeFileSync(join(bin, "ps"), "#!/bin/sh\necho ttys001\n", { mode: 0o755 });
  writeFileSync(join(bin, "osascript"), '#!/bin/sh\nprintf "%s" "$2"\n', { mode: 0o755 });
  writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf "%s" "$CHROME"\n', { mode: 0o755 });
  const launcher = fileURLToPath(new URL("../bin/map-pane", import.meta.url));
  const env = { PATH: bin + ":" + process.env.PATH, CHROME: "/a path/chrome" };
  const command = execFileSync(launcher, ["--split"], { env, encoding: "utf8" });
  assert.equal(execFileSync("bash", ["-c", command], { encoding: "utf8" }), env.CHROME);
});
