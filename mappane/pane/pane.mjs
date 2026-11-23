#!/usr/bin/env node
// Shows a web page in this terminal: headless Chrome renders it, frames go out
// as Kitty graphics, mouse and keys go back through the Chrome DevTools Protocol.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kittyFrame, parseInput, toCdp } from "./lib.mjs";
import { chromePath, gpuFlags, keychainFlags } from "../cli/platform.mjs";

const CHROME = chromePath();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
// Metal GPU (macOS only): 2.6x faster first draw than SwiftShader in the 2026-11-09 benchmark. The rest are puppeteer's quiet defaults.
const CHROME_FLAGS = [
  ...gpuFlags(),
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--metrics-recording-only",
  "--mute-audio",
  "--password-store=basic",
  ...keychainFlags(),
];

// Start headless Chrome on a throwaway profile and open url. Returns a small CDP client.
export async function openPage(url, { signal, timeout = 15_000 } = {}) {
  const startup = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  startup.throwIfAborted();
  const profile = mkdtempSync(join(tmpdir(), "map-pane-"));
  const chrome = spawn(
    CHROME,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, ...CHROME_FLAGS, "--hide-scrollbars", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let ws;
  const close = () => {
    ws?.close();
    // SIGKILL: a graceful shutdown still writes to the profile while it is deleted
    chrome.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  };
  let abort;
  const cancelled = new Promise((_, fail) => {
    abort = () => fail(startup.reason);
    startup.addEventListener("abort", abort, { once: true });
  });
  const wait = (promise) => Promise.race([promise, cancelled]);
  try {
    const port = await wait(new Promise((ok, fail) => {
      let log = "";
      const onData = (d) => {
        log += d;
        const m = log.match(/DevTools listening on ws:\/\/[^:]+:(\d+)/);
        if (!m) return;
        chrome.stderr.off("data", onData);
        chrome.stderr.resume(); // keep draining, or Chrome can block on a full pipe
        ok(m[1]);
      };
      chrome.stderr.on("data", onData);
      chrome.on("error", (e) => fail(new Error(`cannot start Chrome at ${CHROME}: ${e.message}`)));
      chrome.on("exit", (code) => fail(new Error(`Chrome exited with code ${code}: ${log}`)));
    }));
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: startup })).json();
    const target = targets.find(({ type }) => type === "page");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await wait(new Promise((ok, fail) => {
      ws.onopen = ok;
      ws.onerror = () => fail(new Error("cannot connect to Chrome DevTools"));
    }));

    let lastId = 0;
    const pending = new Map();
    const handlers = {};
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (!msg.id) return handlers[msg.method]?.(msg.params);
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message));
      else ok(msg.result);
    };
    ws.onclose = () => {
      for (const { fail } of pending.values()) fail(new Error("Chrome closed"));
      pending.clear();
      handlers.close?.();
    };
    const send = (method, params = {}) =>
      new Promise((ok, fail) => {
        if (ws.readyState !== WebSocket.OPEN) return fail(new Error("Chrome closed"));
        pending.set(++lastId, { ok, fail });
        ws.send(JSON.stringify({ id: lastId, method, params }));
      });
    // Navigate over CDP so the URL keeps its #fragment.
    await wait(send("Page.navigate", { url }));
    return {
      send,
      on: (method, fn) => { handlers[method] = fn; },
      close,
    };
  } catch (error) {
    close();
    if (startup.aborted) {
      throw startup.reason.name === "TimeoutError" ? new Error("Chrome startup timed out") : startup.reason;
    }
    throw error;
  } finally {
    startup.removeEventListener("abort", abort);
  }
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: pane.mjs <url>");
    process.exit(1);
  }
  // Terminal pixels per CSS pixel. 2 on a Retina display.
  const dpr = Number(process.env.MAP_PANE_DPR) || 2;
  const out = process.stdout;
  const inp = process.stdin;
  const cols = () => out.columns ?? 80;
  const rows = () => out.rows ?? 24;

  const startup = new AbortController();
  const cancelStartup = () => startup.abort();
  for (const sig of SIGNALS) process.on(sig, cancelStartup);
  let page;
  try {
    page = await openPage(url, { signal: startup.signal });
  } catch (error) {
    if (startup.signal.aborted) return;
    throw error;
  } finally {
    for (const sig of SIGNALS) process.off(sig, cancelStartup);
  }
  const setSize = (cssW, cssH) =>
    page.send("Emulation.setDeviceMetricsOverride", {
      width: Math.round(cssW),
      height: Math.round(cssH),
      deviceScaleFactor: 1, // screencast frames are always CSS size, a higher value gains nothing
      mobile: false,
    });

  let closed = false;
  const quit = (error) => {
    if (closed) return;
    closed = true;
    // delete the image, mouse off, show cursor, leave the alternate screen
    out.write("\x1b_Ga=d,d=I,i=1,q=2\x1b\\\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l");
    inp.setRawMode?.(false);
    try {
      page.close();
    } catch (e) {
      error ??= e; // the exit below must still run
    }
    if (error) console.error(error);
    process.exit(error ? 1 : 0);
  };
  page.on("close", () => quit(new Error("Chrome closed")));
  for (const sig of SIGNALS) process.on(sig, () => quit());
  process.on("uncaughtException", quit);
  process.on("unhandledRejection", quit);

  // alternate screen, hide cursor, mouse: any motion (1003) + SGR (1006) + pixel coordinates (1016)
  out.write("\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?1016h");
  await setSize(cols() * 8, rows() * 16); // estimate until the terminal reports its pixel size
  const askSize = () => out.write("\x1b[14t"); // reply: CSI 4 ; height ; width t
  out.on("resize", askSize);
  askSize();

  inp.setRawMode?.(true);
  inp.setEncoding("utf8");
  inp.on("data", (data) => {
    for (const ev of parseInput(data)) {
      if (ev.type === "quit") return quit();
      if (ev.type === "size") setSize(ev.w / dpr, ev.h / dpr);
      else for (const [method, params] of toCdp(ev, dpr)) page.send(method, params);
    }
  });
  inp.on("end", quit);

  // Chrome sends the next frame only after the ack. The ack waits for the
  // terminal to take the frame, so a slow terminal lowers the frame rate
  // and no queue builds up.
  page.on("Page.screencastFrame", ({ data, sessionId }) => {
    out.write(kittyFrame(data, cols(), rows()), () => page.send("Page.screencastFrameAck", { sessionId }));
  });
  await page.send("Page.startScreencast", { format: "png" });
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
