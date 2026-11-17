// pane.mjs in a pseudo-terminal: the "script" command gives it a tty and copies
// the terminal output to its stdout. "cat |" is there because script rejects
// the socket that Node uses for a child's stdin. Needs Chrome. Needs no network.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const PANE = join(import.meta.dirname, "..", "pane", "pane.mjs");

// Start the pane with its own temp folder and wait for the first frame.
async function startPane(t) {
  const tmp = mkdtempSync(join(tmpdir(), "pane-test-"));
  const child = spawn("sh", ["-c", 'cat | script -q /dev/null "$0" "$1" "data:text/html,<h1>pane test</h1>"', process.execPath, PANE], {
    env: { ...process.env, TMPDIR: tmp },
  });
  t.after(() => {
    child.kill();
    spawnSync("pkill", ["-KILL", "-f", tmp]); // Chrome, if a failed test left it running
    rmSync(tmp, { recursive: true, force: true });
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  const exit = new Promise((ok) => child.on("exit", ok));
  await t.waitFor(() => assert.match(output, /\x1b_Ga=T,f=100/), { interval: 100, timeout: 20_000 });
  const profiles = () => readdirSync(tmp).filter((name) => name.startsWith("map-pane-"));
  assert.equal(profiles().length, 1, "Chrome profile folder exists while running");
  return { tmp, child, exit, profiles, output: () => output };
}

test("Ctrl-C restores the terminal and deletes the Chrome profile", async (t) => {
  const pane = await startPane(t);
  pane.child.stdin.end("\x03"); // end: cat exits, so the shell can exit
  assert.equal(await pane.exit, 0);
  assert.ok(pane.output().includes("\x1b[?1049l"), "left the alternate screen");
  assert.deepEqual(pane.profiles(), []);
});

test("the pane exits with an error when Chrome dies", async (t) => {
  const pane = await startPane(t);
  spawnSync("pkill", ["-KILL", "-f", `user-data-dir=${pane.tmp}`]);
  await t.waitFor(() => assert.match(pane.output(), /Chrome closed/), { interval: 100, timeout: 10_000 });
  pane.child.stdin.end();
  assert.equal(await pane.exit, 1);
  assert.deepEqual(pane.profiles(), []);
});
