import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { serverUrl } from "./helpers/server-url.mjs";

test("server URL waits for a complete line across stdout chunks", async (t) => {
  const child = spawn(process.execPath, ["-e", `
    process.stdout.write('http://127.0.');
    setTimeout(() => process.stdout.write('0.1:8765/\\nextra output\\n'), 50);
  `]);
  t.after(() => child.kill());
  assert.equal(await serverUrl(child), "http://127.0.0.1:8765/");
});

for (const [name, source, message, timeout] of [
  ["early exit", "console.error('port unavailable'); process.exitCode = 1", /exited.*1.*port unavailable/],
  ["invalid URL", "console.log('not a URL')", /invalid URL/],
  ["missing URL", "setInterval(() => {}, 1000)", /timed out/, 100],
]) {
  test(`server startup reports ${name}`, async (t) => {
    const child = spawn(process.execPath, ["-e", source]);
    t.after(() => child.kill());
    await assert.rejects(serverUrl(child, timeout), message);
  });
}

test("server startup reports spawn errors", async () => {
  const child = spawn("/nonexistent/map-pane-test-server");
  await assert.rejects(serverUrl(child), /ENOENT/);
});
