// Platform differences in one place: who the user is, where Chrome lives, how to open a URL, and the
// command channel (a Unix socket on macOS and Linux, a named pipe on Windows).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/** A name for this user that is safe in a file name: the uid, or the Windows user name. */
export function ownerId() {
  if (process.getuid) return String(process.getuid());
  const name = process.env.USERNAME || userInfo().username || "user";
  return name.replace(/[^\w.-]/g, "_");
}

/**
 * The Chrome binary: CHROME, else the first browser found at the usual places.
 * Edge is a fallback on Windows: it is Chromium, and the same DevTools protocol drives it.
 * Pure over its arguments, so tests can ask for any platform. Returns the first existing candidate,
 * or the first candidate when none exists (the error message then names a real path).
 */
export function chromePath(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.CHROME) return env.CHROME;
  let candidates;
  if (platform === "darwin") {
    candidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  } else if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    candidates = [
      ...roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe")),
      ...roots.map((root) => join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
    ];
    if (!candidates.length) candidates = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"];
  } else {
    candidates = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  }
  return candidates.find((path) => exists(path)) ?? candidates[0];
}

/** Flags that only make sense on one platform. Metal is Apple's GPU API. */
export const gpuFlags = (platform = process.platform) => (platform === "darwin" ? ["--use-angle=metal", "--enable-gpu"] : []);
/** macOS keychain flag: other platforms have no mock keychain. */
export const keychainFlags = (platform = process.platform) => (platform === "darwin" ? ["--use-mock-keychain"] : []);

/**
 * The program and arguments that open url in the default browser. No shell: a URL with & stays one argument.
 * Windows uses rundll32's URL handler, which needs no `start` and no quoting.
 */
export function openerFor(url, platform = process.platform) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/** Open url in the default browser. Report early xdg-open failures while allowing a foreground browser to stay running. */
export function openUrl(url, platform = process.platform) {
  const [program, args] = openerFor(url, platform);
  return new Promise((done) => {
    // detached: Windows kills a non-detached child when its parent exits, and the launcher exits at once.
    const child = spawn(program, args, { stdio: "ignore", windowsHide: true, detached: true });
    child.on("error", () => done(false));
    // macOS: `open` ends at once, and its exit code tells that a sandbox blocked it.
    if (platform === "darwin") return child.on("exit", (code) => done(code === 0));
    if (platform === "linux") {
      // xdg-open may wait for the browser until its window closes.
      const timer = setTimeout(() => { child.unref(); done(true); }, 500);
      child.once("close", (code) => { clearTimeout(timer); done(code === 0); });
      return;
    }
    child.on("spawn", () => {
      child.unref();
      done(true);
    });
  });
}

/**
 * The named pipe of a bridge on Windows. The random part stops another program from creating the pipe first.
 * It is not a secret (Windows lists pipe names): the default access list lets only the user, administrators and SYSTEM write.
 * shortcut: the CLI does not check who owns the pipe, so a name left by a killed bridge could be reused by another user; add a check for shared machines.
 */
export const windowsPipe = (pid, secret) => `\\\\.\\pipe\\map-pane-${secret}-${pid}`;
