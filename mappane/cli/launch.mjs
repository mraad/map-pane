#!/usr/bin/env node
// The launcher in Node, for platforms where bin/map-pane (bash, perl, ps, osascript) does not run: Windows.
//   launch.mjs --browser   open the map in the default browser; start a detached bridge if none runs
//   launch.mjs --close     stop the bridge that --browser started
//   launch.mjs             show the map in this terminal (Kitty graphics; for example WezTerm)
// --split needs macOS and Ghostty. Prints the same JSON as bin/map-pane.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, request } from "./command.mjs";
import { openUrl, ownerId } from "./platform.mjs";

const SERVER = fileURLToPath(new URL("../web/server.mjs", import.meta.url));
const PANE = fileURLToPath(new URL("../pane/pane.mjs", import.meta.url));
// Bridge started by --browser: {pid, url, log, socket} as JSON.
const BROWSER_STATE = join(tmpdir(), `map-pane-browser-${ownerId()}`);
const START_TIMEOUT_MS = 15_000;

/** {url, pid, socket} of the running bridge (the one the CLI targets), or undefined. */
const runningBridge = () => connect().info().catch(() => undefined);

/**
 * Start a bridge and wait for its `bridge: <url>` line, then for its `SOCKET <path>` line (the CLI's door; null if
 * the bridge could not open one). detached: it outlives this launcher and the agent's shell.
 * stdio goes to a log file, which the launcher reads.
 */
async function startBridge({ detached }) {
  const log = join(tmpdir(), `map-pane-bridge-${process.pid}-${Date.now()}.log`);
  const fd = openSync(log, "w");
  let exited = false;
  const child = spawn(process.execPath, [SERVER, String(process.env.PORT ?? 0)], {
    detached, stdio: ["ignore", fd, fd], windowsHide: true, env: process.env,
  });
  child.on("exit", () => { exited = true; });
  closeSync(fd);
  const fail = (why) => {
    const output = readFileSync(log, "utf8");
    rmSync(log, { force: true });
    if (!exited) child.kill();
    throw new Error(`${why}${output ? `:\n${output.trim()}` : ""}`);
  };
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const output = readFileSync(log, "utf8");
    const url = /^bridge: (\S+)/m.exec(output)?.[1];
    if (url) {
      // The socket line follows the URL by a few milliseconds; "command socket:" is its failure line.
      for (let i = 0; i < 20 && !/^(SOCKET |command socket:)/m.test(readFileSync(log, "utf8")); i++) await sleep(100);
      const socket = /^SOCKET (.+)$/m.exec(readFileSync(log, "utf8"))?.[1] ?? null;
      if (detached) child.unref();
      return { child, url, log, socket };
    }
    if (/^BRIDGE down/m.test(output) || exited) fail("map-pane: bridge failed");
    if (Date.now() > deadline) fail("map-pane: bridge did not start in 15 s");
    await sleep(100);
  }
}

/** Ask a bridge to stop itself over its own socket or pipe; true when it answered. */
const stopBridge = (socket) => request(socket, "/shutdown", {}).then(() => true, () => false);

async function browser() {
  let info = await runningBridge();
  if (!info) {
    const { child, url, log, socket } = await startBridge({ detached: true });
    writeFileSync(BROWSER_STATE, JSON.stringify({ pid: child.pid, url, log, socket }));
    info = { url };
  }
  // A sandbox can block opening a browser; the map still runs at the URL.
  // MAP_PANE_OPEN=0 skips the opener, as it does for login.
  if (process.env.MAP_PANE_OPEN !== "0" && !(await openUrl(info.url))) console.error(`map-pane: could not open a browser; open ${info.url} yourself`);
  console.log(JSON.stringify({ url: info.url }));
}

async function close() {
  if (!existsSync(BROWSER_STATE)) {
    console.error("map-pane: no map was opened with --browser");
    process.exit(1);
  }
  const { url, log, socket } = JSON.parse(readFileSync(BROWSER_STATE, "utf8"));
  // Only our bridge answers on our pipe, so a reused pid can never be stopped by mistake.
  if (socket) {
    await stopBridge(socket);
    // Wait for it to go: its pipe stops answering.
    for (let i = 0; i < 50 && (await request(socket, "/api/info").then(() => true, () => false)); i++) await sleep(100);
  }
  rmSync(BROWSER_STATE, { force: true });
  rmSync(log, { force: true });
  // shortcut: a browser tab cannot be closed from here; it stays open and shows that the connection is lost.
  console.log(JSON.stringify({ closed: url }));
}

async function pane() {
  const found = await runningBridge();
  let started;
  const url = found?.url ?? (started = await startBridge({ detached: false })).url;
  const stop = async () => {
    if (!started) return;
    // The launcher's own bridge goes with the pane: ask it to clean up, else end it.
    if (!(started.socket && (await stopBridge(started.socket)))) started.child.kill();
    rmSync(started.log, { force: true });
  };
  const child = spawn(process.execPath, [PANE, `${url}?embedded=1`], { stdio: "inherit" });
  // Ctrl-C reaches the pane too (same console); wait for it to restore the terminal.
  process.on("SIGINT", () => {});
  const code = await new Promise((done) => child.on("exit", (status) => done(status ?? 1)));
  await stop();
  process.exit(code);
}

async function main() {
  const flag = process.argv[2];
  if (flag === "--browser") return browser();
  if (flag === "--close") return close();
  if (flag === "--split") throw new Error("--split needs macOS and Ghostty; use --browser");
  if (flag && flag !== "--pane") throw new Error(`unknown option ${flag}; use --browser, --close, or no option`);
  return pane();
}

if (import.meta.main) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
