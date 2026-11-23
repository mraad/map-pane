import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { request } from "../cli/command.mjs";
import { chromePath, gpuFlags, IS_WINDOWS, keychainFlags, openerFor, ownerId, windowsPipe } from "../cli/platform.mjs";

const run = promisify(execFile);
const LAUNCH = join(import.meta.dirname, "../cli/launch.mjs");
const COMMAND = join(import.meta.dirname, "../cli/command.mjs");

test("chromePath: CHROME wins, Windows looks in Program Files, Local AppData, then Edge", () => {
  assert.equal(chromePath({ CHROME: "C:\\x\\chrome.exe" }, "win32", () => false), "C:\\x\\chrome.exe");
  const env = { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\j\\AppData\\Local" };
  const edge = join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
  assert.equal(chromePath(env, "win32", (p) => p === edge), edge);
  const user = join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe");
  assert.equal(chromePath(env, "win32", (p) => p === user || p === edge), user);
  // Nothing installed: the first candidate, so the error names a real path.
  assert.equal(chromePath(env, "win32", () => false), join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"));
  assert.equal(chromePath({}, "darwin", () => false), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(chromePath({}, "linux", (p) => p === "/usr/bin/chromium"), "/usr/bin/chromium");
});

test("platform flags and openers", () => {
  assert.deepEqual(gpuFlags("darwin"), ["--use-angle=metal", "--enable-gpu"]);
  assert.deepEqual(gpuFlags("win32"), []);
  assert.deepEqual(keychainFlags("darwin"), ["--use-mock-keychain"]);
  assert.deepEqual(keychainFlags("win32"), []);
  // A URL with & stays one argument: no shell is involved.
  const url = "https://x.test/a?b=1&c=2";
  assert.deepEqual(openerFor(url, "darwin"), ["open", [url]]);
  assert.deepEqual(openerFor(url, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
  assert.deepEqual(openerFor(url, "linux"), ["xdg-open", [url]]);
});

test("windowsPipe and ownerId make safe names", () => {
  assert.equal(windowsPipe(42, "abc123"), "\\\\.\\pipe\\map-pane-abc123-42");
  assert.match(ownerId(), /^[\w.-]+$/);
});

test("launch.mjs --browser starts one detached bridge, reuses it, and --close stops it", { timeout: 60000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "map-launch-test-"));
  // Every platform's temp variable; MAP_PANE_OPEN=0 opens no real browser.
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, MAP_PANE_SOCKET: "", MAP_PANE_OPEN: "0" };
  const launch = (flag) => run(process.execPath, [LAUNCH, flag], { env });
  const state = join(tmp, `map-pane-browser-${ownerId()}`);
  t.after(() => {
    if (existsSync(state)) { try { process.kill(JSON.parse(readFileSync(state, "utf8")).pid); } catch {} }
    rmSync(tmp, { recursive: true, force: true });
  });

  const first = JSON.parse((await launch("--browser")).stdout);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const { pid, socket } = JSON.parse(readFileSync(state, "utf8"));
  assert.ok(socket, "the bridge reported its command socket");
  process.kill(pid, 0); // the bridge outlives the launcher
  assert.equal(JSON.parse((await launch("--browser")).stdout).url, first.url);
  assert.equal(JSON.parse(readFileSync(state, "utf8")).pid, pid, "a second --browser reuses the bridge");

  // The CLI finds the bridge on its own (socket on macOS and Linux, registered pipe on Windows).
  const info = JSON.parse((await run(process.execPath, [COMMAND, "--info"], { env })).stdout);
  assert.equal(info.url, first.url);
  await assert.rejects(run(process.execPath, [COMMAND, "extent"], { env }), (e) => e.code === 1 && /No map page is open/.test(e.stderr));

  assert.equal(JSON.parse((await launch("--close")).stdout).closed, first.url);
  // Gone means its socket or pipe no longer answers (a zombie can still pass kill -0 in a container).
  await assert.rejects(request(socket, "/api/info"));
  assert.ok(!existsSync(state));
  await assert.rejects(launch("--close"), (e) => e.code === 1 && /no map was opened with --browser/.test(e.stderr));
});

test("the bridge refuses /shutdown and hides its socket over TCP", { timeout: 30000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "map-launch-test-"));
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, MAP_PANE_SOCKET: "", MAP_PANE_OPEN: "0" };
  const { url } = JSON.parse((await run(process.execPath, [LAUNCH, "--browser"], { env })).stdout);
  t.after(async () => {
    await run(process.execPath, [LAUNCH, "--close"], { env }).catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  });
  const response = await fetch(`${url}shutdown`, { method: "POST", body: "{}" });
  assert.equal(response.status, 403);
  const tcp = await fetch(`${url}api/info`);
  assert.equal(tcp.status, 200, "the bridge still runs");
  assert.equal((await tcp.json()).socket, null, "TCP callers do not learn the socket");
  assert.ok(JSON.parse((await run(process.execPath, [COMMAND, "--info"], { env })).stdout).socket, "socket callers do");
});

test("--browser fails and leaves no bridge when the bridge has no command socket", { timeout: 60000, skip: IS_WINDOWS && "Windows has no folder modes" }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "map-launch-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, MAP_PANE_SOCKET: "", MAP_PANE_OPEN: "0" };
  // A folder that others can open: the bridge refuses to put its socket there.
  const dir = join(tmp, `map-pane-${ownerId()}`);
  mkdirSync(dir);
  chmodSync(dir, 0o755);
  const error = await run(process.execPath, [LAUNCH, "--browser"], { env }).then(() => assert.fail("--browser succeeded"), (e) => e);
  assert.match(error.stderr, /the bridge has no command socket/);
  const url = /^bridge: (\S+)/m.exec(error.stderr)[1];
  await assert.rejects(fetch(url), "the bridge is stopped");
  assert.ok(!existsSync(join(tmp, `map-pane-browser-${ownerId()}`)), "nothing recorded");
});

test("the launcher drops a registry file only when its pipe is gone", { timeout: 60000, skip: !IS_WINDOWS && "Windows only" }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "map-launch-test-"));
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, MAP_PANE_SOCKET: "", MAP_PANE_OPEN: "0" };
  // A live pipe that drops each connection: an error, but not a bridge that is gone.
  const live = windowsPipe(1, `test-${process.pid}`);
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((ok) => server.listen(live, ok));
  t.after(async () => {
    server.close();
    await run(process.execPath, [LAUNCH, "--close"], { env }).catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  });
  const dir = join(tmp, `map-pane-${ownerId()}`);
  mkdirSync(dir);
  const file = join(dir, "command-1.pipe");
  writeFileSync(file, live);
  await run(process.execPath, [LAUNCH, "--browser"], { env });
  assert.ok(existsSync(file), "kept: the pipe answered with an error");
  await run(process.execPath, [LAUNCH, "--close"], { env });
  writeFileSync(file, windowsPipe(1, "gone"));
  await run(process.execPath, [LAUNCH, "--browser"], { env });
  assert.ok(!existsSync(file), "dropped: no such pipe");
});
