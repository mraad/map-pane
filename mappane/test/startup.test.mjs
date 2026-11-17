import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const PANE = join(ROOT, "pane/pane.mjs");

function slowChrome(t, args) {
  const tmp = mkdtempSync("/tmp/map-startup-test-");
  const chrome = join(tmp, "chrome.mjs");
  const marker = join(tmp, "chrome.pid");
  writeFileSync(chrome, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CHROME_TEST_PID, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const child = spawn(process.execPath, args, { env: { ...process.env, CHROME: chrome, TMPDIR: tmp, CHROME_TEST_PID: marker } });
  const exit = once(child, "exit");
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const chromePid = () => existsSync(marker) ? Number(readFileSync(marker, "utf8")) : null;
  t.after(() => {
    child.kill("SIGKILL");
    const pid = chromePid();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(tmp, { recursive: true, force: true });
  });
  return { tmp, child, exit, chromePid, stderr: () => stderr };
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`${signal} during Chrome startup stops Chrome and removes its profile`, { timeout: 8000 }, async (t) => {
    const pane = slowChrome(t, [PANE, "about:blank"]);
    await t.waitFor(() => assert.ok(pane.chromePid()), { timeout: 5000 });
    const pid = pane.chromePid();
    pane.child.kill(signal);
    assert.deepEqual(await pane.exit, [0, null]);
    await t.waitFor(() => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }), { timeout: 3000 });
    assert.deepEqual(readdirSync(pane.tmp).filter((name) => name.startsWith("map-pane-")), []);
  });
}

test("Chrome startup has a deadline and cleans up a stalled child", { timeout: 8000 }, async (t) => {
  const source = `import { openPage } from ${JSON.stringify(pathToFileURL(PANE).href)};
    await openPage("about:blank", { timeout: 500 });`;
  const pane = slowChrome(t, ["--input-type=module", "-e", source]);
  assert.deepEqual(await pane.exit, [1, null]);
  assert.match(pane.stderr(), /Chrome startup timed out/);
  if (pane.chromePid()) {
    await t.waitFor(() => assert.throws(() => process.kill(pane.chromePid(), 0), { code: "ESRCH" }), { timeout: 3000 });
  }
  assert.deepEqual(readdirSync(pane.tmp).filter((name) => name.startsWith("map-pane-")), []);
});
