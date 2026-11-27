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

// Agent Skills authoring rules (platform.claude.com, "Skill authoring best practices").
test("the skill follows the authoring rules", () => {
  const dir = new URL("../../.agents/skills/map-pane/", import.meta.url);
  const text = readFileSync(new URL("SKILL.md", dir), "utf8");
  const [, front, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const name = front.match(/^name: (.*)$/m)[1], description = front.match(/^description: (.*)$/m)[1];
  assert.match(name, /^[a-z0-9-]{1,64}$/);
  assert.doesNotMatch(name, /anthropic|claude/);
  assert.ok(description.length <= 1024, `description has ${description.length} characters`);
  assert.doesNotMatch(description, /<[a-z]/i, "no XML tags");
  assert.match(description, /^[A-Z][a-z]+s\b/, "third person: starts with a verb such as 'Opens'");
  assert.ok(body.split("\n").length < 500, "body under 500 lines");
  // Every referenced doc resolves from the skill folder and, past 100 lines, has a table of contents.
  for (const [, ref] of body.matchAll(/`((?:\.\.\/)+docs\/[\w-]+\.md)`/g)) {
    const doc = readFileSync(new URL(ref, dir), "utf8");
    if (doc.split("\n").length > 100) assert.match(doc, /^## Contents$/m, `${ref} has a table of contents`);
  }
  assert.doesNotMatch(body, /\((?:`)?docs\//, "doc references start with ../../../docs/");
});
