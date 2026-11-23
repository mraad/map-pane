import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { request } from "../cli/command.mjs";

const run = promisify(execFile);
const LAUNCHER = join(import.meta.dirname, "../bin/map-pane");

test("--browser starts a detached bridge once, opens its page, and --close stops only that bridge", { timeout: 30000 }, async (t) => {
  const tmp = mkdtempSync("/tmp/map-browser-test-");
  // Fake open and osascript: record the calls, touch no real browser.
  for (const name of ["open", "osascript"]) {
    writeFileSync(join(tmp, name), `#!/bin/sh\necho "$@" >> "${tmp}/${name}.log"\n`, { mode: 0o700 });
  }
  const env = { ...process.env, TMPDIR: tmp, PATH: `${tmp}:${process.env.PATH}` };
  const launch = (flag) => run(LAUNCHER, [flag], { env });
  const state = join(tmp, `map-pane-browser-${process.getuid()}`);
  t.after(() => {
    if (existsSync(state)) { try { process.kill(JSON.parse(readFileSync(state, "utf8")).pid); } catch {} }
    rmSync(tmp, { recursive: true, force: true });
  });

  const first = JSON.parse((await launch("--browser")).stdout);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const { pid, log, socket } = JSON.parse(readFileSync(state, "utf8"));
  // The bridge outlives the launcher, and a second --browser reuses it.
  process.kill(pid, 0);
  assert.equal(JSON.parse((await launch("--browser")).stdout).url, first.url);
  assert.equal(JSON.parse(readFileSync(state, "utf8")).pid, pid);
  assert.deepEqual(readFileSync(join(tmp, "open.log"), "utf8").trim().split("\n"), [first.url, first.url]);

  // A sandbox blocks the opener: the map runs on, and the launcher says what to open.
  writeFileSync(join(tmp, "open"), "#!/bin/sh\nexit 1\n");
  const blocked = await launch("--browser");
  assert.equal(JSON.parse(blocked.stdout).url, first.url);
  assert.match(blocked.stderr, /could not open a browser; open http/);

  // The state file that bin/map-pane wrote up to 0.6.1 still closes its bridge.
  writeFileSync(state, `${pid}\n${first.url}\n${log}\n`);
  assert.equal(JSON.parse((await launch("--close")).stdout).closed, first.url);
  await assert.rejects(request(socket, "/api/info"));
  assert.ok(!existsSync(state));
  await assert.rejects(launch("--close"), (e) => e.code === 1 && /no map was opened with --browser/.test(e.stderr));
});
