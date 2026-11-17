import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openPage } from "../pane/pane.mjs";

const PANE = join(import.meta.dirname, "..", "pane", "pane.mjs");

for (const [name, url, env, message] of [
  ["missing Chrome", "about:blank", { CHROME: "/nonexistent/map-pane-chrome" }, /cannot start Chrome/],
  ["invalid URL", "http://[", {}, /Cannot navigate to invalid URL/],
]) {
  test(`openPage cleans up after ${name}`, (t) => {
    const tmp = mkdtempSync(join(tmpdir(), "open-page-test-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [PANE, url], {
      env: { ...process.env, ...env, TMPDIR: tmp }, encoding: "utf8", timeout: 20_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.match(child.stderr, message);
    assert.deepEqual(readdirSync(tmp), [], "temporary Chrome profile was deleted");
  });
}

test("openPage reuses the initial tab and preserves URL fragments", { timeout: 20_000 }, async (t) => {
  const page = await openPage("data:text/html,<h1>test</h1>#fragment");
  t.after(() => page.close());
  const { targetInfos } = await page.send("Target.getTargets");
  assert.equal(targetInfos.filter(({ type }) => type === "page").length, 1);
  await t.waitFor(async () => {
    const { result } = await page.send("Runtime.evaluate", { expression: "location.hash" });
    assert.equal(result.value, "#fragment");
  }, { timeout: 5000 });
});

test("openPage rejects pending and future requests after disconnect", { timeout: 5000 }, async (t) => {
  const page = await openPage("about:blank");
  t.after(() => page.close());
  const pending = page.send("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true });
  const rejected = assert.rejects(pending, /Chrome closed/);
  page.close();
  await rejected;
  await assert.rejects(page.send("Runtime.evaluate", { expression: "1" }), /Chrome closed/);
});
