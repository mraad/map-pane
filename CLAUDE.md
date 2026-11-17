# CLAUDE.md

Guidance for agents working in this repository.

## What this is

A live web map (ArcGIS Maps SDK for JavaScript 5.2.2, vanilla JS, no build step) driven by agents.
`mappane/` is both a Claude Code mod (plugin `mappane`, tools `mcp__mappane__*`, `/map`) and the standalone
runtime (`mappane/bin/map-pane` Kitty pane, `mappane/bin/map-command` CLI, skill `.agents/skills/map-pane`).
Public repo `github.com/mraad/map-pane`; marketplace file `.claude-plugin/marketplace.json`.
No npm dependencies: Node 24 stdlib, the mod API (`'claude-code'`), installed Chrome. Keep it that way.
It replaces `mraad/claude-mod-map` and `mraad/ghostty-map-pane` (deprecated).

Never put "arcgis" in a name we own (folders, plugin, tools, env vars, headers, paths, titles): it is a trademark.
SDK identifiers (`@arcgis/core`, `<arcgis-*>`, `$arcgis`, CDN and service URLs) and plain mentions of the SDK are fine.

Docs: `docs/mod.md`, `docs/standalone.md`, `docs/architecture.md` (protocol, ops, security). Update them when behavior changes.

## Commands

```sh
npm test                                   # all node suites, one file at a time (Chrome + network suites included)
node --test mappane/test/cli.test.mjs      # one file
node --test --test-name-pattern="wheel" mappane/test/lib.test.mjs
claude plugin validate mappane
claude plugin test mappane                 # hooks/*.test.tsx
claude --plugin-dir ./mappane              # run the mod from this folder
mappane/bin/map-pane --split               # standalone Ghostty split
```

- Type check: `npx -p typescript tsc -p mappane` needs engine types in `mappane/.claude-plugin/types/` (gitignored),
  written only into a loaded dev-mod copy. Refresh from `~/.claude/dev-mods/<session-id>/mappane/.claude-plugin/types/` first;
  stale types report unknown `mcp__mappane__*` tool names in the test file. Check tsc's exit code, not its tail.
- Dev-mod sync after edits: `rsync -a --exclude .claude-plugin/types mappane/ ~/.claude/dev-mods/<session-id>/mappane/`.

Suites: `mappane/web/server.test.mjs` (bridge over TCP, ports 18765/18766), `viewer.test.mjs`, `viewer.chrome.test.mjs`
(Chrome + network, port 18769/18770), `mappane/test/cli.test.mjs` (CLI over the socket, free port),
`e2e.test.mjs` (Chrome + network), `lib`, `commands`, `geopackage`, `map-commands`, `server-url` (pure),
`open-page`, `startup`, `pane` (Chrome). Chrome suites are timing-sensitive: run them one at a time (`npm test` does).

## Layout

- `mappane/web/server.mjs`: the bridge. One handler for TCP and the Unix socket.
- `mappane/web/index.html` + `app.js`: the page (layout, protocol loop, op table). `map-commands.js`
  (`runMapCommand`: graphics, geocoding, zoom, extent, login, save-webmap), `commands.js` (CLI syntax, `BASEMAPS`,
  `startView`), `geojson.js`. The bridge serves only the files in `PAGE_FILES`.
- `mappane/hooks/register.tsx`: the mod. `mappane/web/viewer.mjs`: mod pane Chrome.
- `mappane/cli/command.mjs` (`toOp`, `request`, `commandSocket`), `cli/geopackage.mjs`.
- `mappane/pane/pane.mjs`, `pane/lib.mjs`: Kitty pane.

## Rules that are easy to break

- Bridge TCP: only `Host: 127.0.0.1:<bound port>`, no foreign `Origin`; control endpoints need `x-map-pane-token`
  when `MAP_PANE_TOKEN` is set. The socket skips both (mode 0600). Keep all three.
- `login` is never logged or saved (`READ_ONLY` in `server.mjs`). A new op that changes the map must be logged;
  one that only reads or moves the view goes in `READ_ONLY`.
- The bridge names logged layers (`L<n>`); every op that adds layers must use the `layerId` it gets.
- `$.state` atoms carry `shape` tags (`status-2`, `frame-2`): bump them when `types/index.d.ts` changes.
- One `tool.call` hook serves all tools via `/^mcp__mappane__/`. Args come from each tool's `inputSchema.properties`:
  a new field must be in the schema. A tool whose op differs goes in `OPS`.
- The bridge reads page files once; a page change needs a bridge restart. `__PAGE_VERSION__` makes open pages reload.
- `web/app.js` sets `window.view`; e2e tests use it.
- Kitty pane: ack screencast frames in the `stdout.write` callback; frames use `q=2`; `quit()` cleans up on every exit path.
- `--split` uses `initial input` + `exec`, and targets the launcher's tty.
- Zoom to a layer with `queryExtent()` (honours `definitionExpression`). GeoParquet with no `crs` gets OGC:CRS84.
- `shortcut:` comments mark accepted limits (fixed mod port 8765, 1:2 cells, growing log, inline GeoPackage log).
- The SDK CDN at `5.2.2` reports `kernel.fullVersion = "5.2.1"`; tests check the load URL instead.
