// The Claude Code plugin, the Codex plugin and the Pi package ship one version; bump them together.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const version = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")).version;

// The code-mode helper is copied into the skill, the code-mode guide and the HTML manual: keep the three the same.
test("the three copies of the code-mode helper are the same", () => {
  const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const helper = (path) => read(path).match(/^const parse = \(r\) => \{\n[\s\S]*?\nconst map = async .*$/m)?.[0];
  const copies = [".agents/skills/map-pane/SKILL.md", "docs/code-mode.md", "docs/guide.html"].map(helper);
  assert.ok(copies[0], "the skill has the helper");
  for (const copy of copies) assert.equal(copy, copies[0]);
});

test("every manifest has the same version", () => {
  const versions = ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"].map(version);
  assert.deepEqual(new Set(versions).size, 1, versions.join(", "));
});
