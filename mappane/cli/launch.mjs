#!/usr/bin/env node
// The launcher in Node: it finds or starts the bridge. bin/map-pane adds what needs macOS (--split, closing tabs)
// and hands the rest over; on Windows, where its tools (osascript, ps) do not run, it hands over everything.
//   launch.mjs --browser   open the map in the default browser; start a detached bridge if none runs
//   launch.mjs --close     stop the bridge that --browser started
//   launch.mjs             show the map in this terminal (Kitty graphics; for example WezTerm)
// --split needs macOS and Ghostty.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandSocket, connect, request, socketDir } from "./command.mjs";
import { IS_WINDOWS, openUrl, ownerId } from "./platform.mjs";

const SERVER = fileURLToPath(new URL("../web/server.mjs", import.meta.url));
const PANE = fileURLToPath(new URL("../pane/pane.mjs", import.meta.url));
// Bridge started by --browser: {pid, url, log, socket} as JSON.
const BROWSER_STATE = join(tmpdir(), `map-pane-browser-${ownerId()}`);
const START_TIMEOUT_MS = 15_000;
// Longer than one launcher can hold the lock.
const LOCK_TIMEOUT_MS = 30_000;

/**
 * Run fn while no other launcher of this user does, so "is a bridge running, start one, record it" is one step.
 * The lock is a SQLite exclusive transaction: every platform has it, and the OS drops it when the launcher dies.
 */
async function locked(fn) {
  process.removeAllListeners("warning"); // older Node prints that SQLite is experimental
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(socketDir(), "launch.lock"), { timeout: LOCK_TIMEOUT_MS });
  try {
    try {
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      throw error.errcode === 5 ? new Error("map-pane: another launcher is still at work; try again") : error; // SQLITE_BUSY
    }
    return await fn();
  } finally { db.close(); }
}

/** {url, pid, socket} of the running bridge (the one the CLI targets), or undefined. */
const runningBridge = () => connect().info().catch(() => undefined);

/**
 * Start a bridge and wait for its `bridge: <url>` line, then for its `SOCKET <path>` line (the CLI's door; null if
 * the bridge could not open one). detached: it outlives this launcher and the agent's shell; it must have a socket,
 * because --close has no other way to stop it.
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
      if (detached && !socket) fail("map-pane: the bridge has no command socket");
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
  const info = await locked(async () => {
    const running = await runningBridge();
    if (running) return running;
    const { child, url, log, socket } = await startBridge({ detached: true });
    writeFileSync(BROWSER_STATE, JSON.stringify({ pid: child.pid, url, log, socket }));
    return { url };
  });
  // A sandbox can block opening a browser; the map still runs at the URL.
  // MAP_PANE_OPEN=0 skips the opener, as it does for login.
  if (process.env.MAP_PANE_OPEN !== "0" && !(await openUrl(info.url))) console.error(`map-pane: could not open a browser; open ${info.url} yourself`);
  console.log(JSON.stringify({ url: info.url }));
}

function readState() {
  const text = readFileSync(BROWSER_STATE, "utf8");
  if (text.startsWith("{")) return JSON.parse(text);
  // bin/map-pane up to 0.6.1 wrote three lines.
  const [pid, url, log] = text.split("\n");
  return { pid, url, log, socket: commandSocket(pid) };
}

async function close() {
  if (!existsSync(BROWSER_STATE)) throw new Error("map-pane: no map was opened with --browser");
  const { pid, url, log, socket } = readState();
  // Only our bridge answers on our pipe, so a reused pid can never be stopped by mistake.
  if (socket) await stopBridge(socket);
  // Wait for it to go. Ask its TCP port: a bridge can run without its socket, and another bridge can reuse the port.
  // No answer by the deadline counts as running: the port may belong to another program that never answers.
  const signal = AbortSignal.timeout(5000);
  const runs = () => fetch(`${url}api/info`, { signal }).then((r) => r.json()).then((info) => info.pid === Number(pid), () => signal.aborted);
  while (await runs()) {
    if (signal.aborted) throw new Error(`map-pane: cannot confirm that the bridge at ${url} stopped; check process ${pid}`);
    await sleep(100);
  }
  rmSync(BROWSER_STATE, { force: true });
  rmSync(log, { force: true });
  // shortcut: a browser tab cannot be closed from here; it stays open and shows that the connection is lost.
  console.log(JSON.stringify({ closed: url }));
}

async function pane() {
  let child, ended = false;
  const end = (signal) => {
    ended = true;
    // Pass it on and wait: the pane restores the terminal. On Windows the console tells the pane, and a kill would skip that.
    if (!IS_WINDOWS) child?.kill(signal);
  };
  const { url, started } = await locked(async () => {
    // One map per user: show a running bridge's map. Its start view stays; MAP_PANE_* apply only to a bridge started here.
    const running = await runningBridge();
    // Only now: until here a signal leaves nothing behind, so it may end a launcher that waits for the lock or for a bridge.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, end);
    if (running) return { url: running.url };
    // Ctrl-C in the terminal reaches the bridge too: that is an end, not a failed start.
    const started = await startBridge({ detached: false }).catch((error) => { if (!ended) throw error; });
    return { url: started?.url, started };
  });
  let code = 0;
  if (!ended) {
    // embedded: the page hides its connection badge inside a pane.
    child = spawn(process.execPath, [PANE, `${url}?embedded=1`], { stdio: "inherit" });
    code = await new Promise((done) => child.on("exit", (status) => done(status ?? 1)));
  }
  if (started) {
    const { child: bridge, socket, log } = started;
    const gone = bridge.exitCode === null && bridge.signalCode === null && new Promise((done) => bridge.on("exit", done));
    // The launcher's own bridge goes with the pane: ask it to clean up, else end it.
    if (!(socket && (await stopBridge(socket)))) bridge.kill();
    await gone;
    rmSync(log, { force: true });
  }
  process.exit(code);
}

async function main() {
  const flag = process.argv[2];
  if (flag === "--browser") return browser();
  if (flag === "--close") return locked(close);
  if (flag === "--split") throw new Error("--split needs macOS and Ghostty; use --browser");
  if (flag && flag !== "--pane") throw new Error(`unknown option ${flag}; use --browser, --close, or no option`);
  return pane();
}

if (import.meta.main) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
