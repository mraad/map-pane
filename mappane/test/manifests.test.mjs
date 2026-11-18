// The Claude Code plugin, the Codex plugin and the Pi package ship one version; bump them together.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const version = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")).version;

test("every manifest has the same version", () => {
  const versions = ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"].map(version);
  assert.deepEqual(new Set(versions).size, 1, versions.join(", "));
});
