import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const PANE = join(ROOT, "pane/pane.mjs");
const LAUNCHER = join(ROOT, "bin/map-pane");

function slowChrome(t, args, command = process.execPath, extra = {}) {
  const tmp = mkdtempSync("/tmp/map-startup-test-");
  const chrome = join(tmp, "chrome.mjs");
  const marker = join(tmp, "chrome.pid");
  writeFileSync(chrome, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CHROME_TEST_PID, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const child = spawn(command, args, { env: { ...process.env, MAP_PANE_SOCKET: "", ...extra, CHROME: chrome, TMPDIR: tmp, CHROME_TEST_PID: marker } });
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

// bin/map-pane starts a bridge, then the pane. Each signal must end both, also when only the launcher gets it.
const bridgePid = (tmp) => {
  const dir = join(tmp, `map-pane-${process.getuid()}`);
  const sock = existsSync(dir) && readdirSync(dir).find((name) => name.startsWith("command-"));
  return sock ? Number(sock.match(/\d+/)[0]) : null;
};
const gone = (t, pid) => t.waitFor(() => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }), { timeout: 3000 });

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`${signal} to the launcher stops its pane and its bridge`, { timeout: 20000 }, async (t) => {
    const dir = mkdtempSync("/tmp/map-startup-test-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const preload = join(dir, "slow-exit.mjs"); // the bridge takes 500 ms to exit
    writeFileSync(preload, `if (process.argv[1]?.endsWith("server.mjs")) process.on("exit", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500));`);
    const launcher = slowChrome(t, [], LAUNCHER, { NODE_OPTIONS: `--import=${pathToFileURL(preload)}` });
    await t.waitFor(() => assert.ok(launcher.chromePid()), { timeout: 10000 });
    const chrome = launcher.chromePid();
    const bridge = bridgePid(launcher.tmp);
    assert.ok(bridge);
    t.after(() => { try { process.kill(bridge); } catch {} });
    launcher.child.kill(signal);
    assert.deepEqual(await launcher.exit, [0, null]);
    assert.throws(() => process.kill(bridge, 0), { code: "ESRCH" }, "the launcher waited for its bridge");
    await gone(t, chrome);
    assert.deepEqual(readdirSync(launcher.tmp).filter((name) => name.startsWith("map-pane-bridge")), [], "no log left");
  });
}

for (const [name, toBridge] of [["the launcher", false], ["the launcher and the bridge (Ctrl-C)", true]]) test(`SIGINT to ${name} while the bridge starts leaves no bridge`, { timeout: 20000 }, async (t) => {
  const dir = mkdtempSync("/tmp/map-startup-test-");
  const marker = join(dir, "server.pid");
  const preload = join(dir, "slow-server.mjs");
  writeFileSync(preload, `import { writeFileSync } from "node:fs";
if (process.argv[1]?.endsWith("server.mjs")) {
  writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  await new Promise((ok) => setTimeout(ok, 1500));
}`);
  const launcher = slowChrome(t, [], LAUNCHER, { NODE_OPTIONS: `--import=${pathToFileURL(preload)}` });
  const pid = () => existsSync(marker) ? Number(readFileSync(marker, "utf8")) : null;
  t.after(() => {
    if (pid()) { try { process.kill(pid(), "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  await t.waitFor(() => assert.ok(pid()), { timeout: 10000 });
  launcher.child.kill("SIGINT");
  if (toBridge) process.kill(pid(), "SIGINT");
  assert.deepEqual(await launcher.exit, [0, null]);
  assert.equal(launcher.stderr(), "");
  await gone(t, pid());
  assert.equal(launcher.chromePid(), null, "no pane was started");
});

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
