import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { request } from "../cli/command.mjs";

const run = promisify(execFile);
const LAUNCHER = join(import.meta.dirname, "../bin/map-pane");

test("--browser starts a detached bridge once, opens its page, and --close stops only that bridge", { timeout: 60000 }, async (t) => {
  const tmp = mkdtempSync("/tmp/map-browser-test-");
  // Fake open and osascript: record the calls, touch no real browser.
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  for (const name of [opener, "osascript"]) {
    writeFileSync(join(tmp, name), `#!/bin/sh\necho "$@" >> "${tmp}/${name}.log"\n`, { mode: 0o700 });
  }
  const env = { ...process.env, TMPDIR: tmp, PATH: `${tmp}:${process.env.PATH}` };
  const launch = (flag) => run(LAUNCHER, [flag], { env });
  const state = join(tmp, `map-pane-browser-${process.getuid()}`);
  t.after(() => {
    if (existsSync(state)) { try { const { pid } = JSON.parse(readFileSync(state, "utf8")); if (pid > 1) process.kill(pid); } catch {} }
    rmSync(tmp, { recursive: true, force: true });
  });

  const first = JSON.parse((await launch("--browser")).stdout);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const { pid, log, socket } = JSON.parse(readFileSync(state, "utf8"));
  // The bridge outlives the launcher, and a second --browser reuses it.
  process.kill(pid, 0);
  assert.equal(JSON.parse((await launch("--browser")).stdout).url, first.url);
  assert.equal(JSON.parse(readFileSync(state, "utf8")).pid, pid);
  assert.deepEqual(readFileSync(join(tmp, opener + ".log"), "utf8").trim().split("\n"), [first.url, first.url]);

  // A sandbox blocks the opener: the map runs on, and the launcher says what to open.
  writeFileSync(join(tmp, opener), "#!/bin/sh\nexit 1\n");
  const blocked = await launch("--browser");
  assert.equal(JSON.parse(blocked.stdout).url, first.url);
  assert.match(blocked.stderr, /could not open a browser; open http/);

  // The state file that bin/map-pane wrote up to 0.6.1 still closes its bridge.
  writeFileSync(state, `${pid}\n${first.url}\n${log}\n`);
  assert.equal(JSON.parse((await launch("--close")).stdout).closed, first.url);
  await assert.rejects(request(socket, "/api/info"));
  assert.ok(!existsSync(state));

  // A bridge that lost its socket cannot be asked to stop: --close says so and keeps the record.
  await launch("--browser");
  const lost = JSON.parse(readFileSync(state, "utf8"));
  rmSync(lost.socket);
  await assert.rejects(launch("--close"), (e) => e.code === 1 && e.stderr.includes(`stopped; check process ${lost.pid}`));
  assert.ok(existsSync(state));
  // Once it is gone, --close clears the record.
  process.kill(lost.pid);
  assert.equal(JSON.parse((await launch("--close")).stdout).closed, lost.url);
  assert.ok(!existsSync(state));

  // Another program took the port and never answers: --close gives up in time and keeps the record.
  const silent = net.createServer(() => {}).listen(0, "127.0.0.1");
  t.after(() => silent.close());
  await once(silent, "listening");
  writeFileSync(state, JSON.stringify({ pid: 1, url: `http://127.0.0.1:${silent.address().port}/`, log, socket: null }));
  await assert.rejects(run(LAUNCHER, ["--close"], { env, timeout: 10000 }), (e) => e.code === 1 && /check process 1\n/.test(e.stderr));
  assert.ok(existsSync(state));
  rmSync(state);

  await assert.rejects(launch("--close"), (e) => e.code === 1 && /no map was opened with --browser/.test(e.stderr));
});
