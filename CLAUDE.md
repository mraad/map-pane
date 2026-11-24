# CLAUDE.md

Guidance for agents working in this repository.

## What this is

A live web map (ArcGIS Maps SDK for JavaScript 5.2.2, vanilla JS, no build step) driven by agents.
`mappane/` is the runtime (`mappane/bin/map-pane` Kitty pane or browser, `mappane/bin/map-command` CLI, bridge `web/server.mjs`).
The CLI is a printer over `run()`/`connect()` exported by `mappane/cli/command.mjs` (package export `map-pane`); keep CLI behavior in `run`.
`mappane/cli/platform.mjs` (Chrome path, opener, Windows pipe name), `cli/launch.mjs` (Node launcher: pane, `--browser`, `--close` on every platform, under one lock, `launch.lock`; bash `bin/map-pane` hands these over to it and adds `--split` and closing Chrome tabs; under Git Bash/MSYS it hands over everything). `.cmd` files in `bin/` and the skill's `scripts/` are the cmd and PowerShell entry points.
One skill, `.agents/skills/map-pane`, serves Claude Code, Codex and Pi. Claude Code finds it through the link
`.claude/skills/map-pane` in a clone, or the skill-only plugin `.claude-plugin/plugin.json` (marketplace `.claude-plugin/marketplace.json`).
Codex: `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`. Pi: `package.json` `pi.skills`.
Public repo `github.com/mraad/map-pane`. Version 0.5.0 dropped the Claude Code mod (`mappane`, `/map`, `mcp__mappane__*`).
No npm dependencies: Node 24.2 stdlib, installed Chrome. Keep it that way.
It replaces `mraad/claude-mod-map` and `mraad/ghostty-map-pane` (deprecated).

Never put "arcgis" in a name we own (folders, plugin, tools, env vars, headers, paths, titles): it is a trademark.
SDK identifiers (`@arcgis/core`, `<arcgis-*>`, `$arcgis`, CDN and service URLs) and plain mentions of the SDK are fine.

Docs: `docs/guide.html` (STE100 HTML manual, images inline; rebuild it when behavior changes), `docs/standalone.md`, `docs/architecture.md` (protocol, ops, security), `docs/run-js.md` (`run_js` contract and examples), `docs/code-mode.md` (Claude Code code mode through `$`, Node library `run`/`connect`). Update them when behavior changes.

## Commands

```sh
npm test                                   # all node suites, one file at a time (Chrome + network suites included)
node --test mappane/test/cli.test.mjs      # one file
node --test --test-name-pattern="wheel" mappane/test/lib.test.mjs
claude plugin validate .                   # Claude marketplace + skill-only plugin
mappane/bin/map-pane --split               # Ghostty split (--browser: default browser)
```

Suites: `mappane/web/server.test.mjs` (bridge over TCP, ports 18765/18766), `mappane/test/cli.test.mjs` (CLI over the socket, free port),
`e2e.test.mjs` (Chrome + network), `lib`, `commands`, `geopackage`, `map-commands`, `server-url`, `manifests` (pure),
`open-page`, `startup`, `pane`, `browser` (Chrome). Chrome suites are timing-sensitive: run them one at a time (`npm test` does).

## Rules that are easy to break

- The bridge serves only the files in `PAGE_FILES` (`server.mjs`); a new page file must be added there.
- Bridge TCP: only `Host: 127.0.0.1:<bound port>`, no foreign `Origin`, no cross-site `Sec-Fetch-Site`; control endpoints need `x-map-pane-token`
  when `MAP_PANE_TOKEN` is set. The socket skips both (mode 0600). Keep all three.
- `login` is never logged or saved (`READ_ONLY` in `server.mjs`); the last one lives in bridge memory (`lastLogin`) and is replayed first to each new page. A new op that changes the map must be logged;
  one that only reads or moves the view goes in `READ_ONLY`.
- `run_js` (`ops.run_js` in `app.js`, CLI `js`): logged unless `readOnly: true`; the page deadline (60 s at most, counted from the command's arrival, not from its turn in the queue) must stay under the bridge's `TIMEOUT_MS.run_js`; a `run_js` that timed out at the bridge is dropped from the log (it froze its page). The e2e suite runs every `js` code block of `docs/run-js.md` in order (a first line `// readOnly` marks a read-only one) and checks the count: keep the blocks runnable. Keep `docs/run-js.md` and the skill's "Run JavaScript" section in step.
- The bridge names logged layers (`L<n>`); every op that adds layers must use the `layerId` it gets.
- The bridge reads page files once; a page change needs a bridge restart. `__PAGE_VERSION__` makes open pages reload.
- `web/app.js` sets `window.view`; e2e tests use it.
- Kitty pane: ack screencast frames in the `stdout.write` callback; frames use `q=2`; `quit()` cleans up on every exit path.
- `--split` uses `initial input` + `exec`, and targets the launcher's tty.
- Windows: no `process.getuid`, no Unix socket, no signals. Keep `ownerId()`, the named pipe + registry file, and `/shutdown` (socket only). `launch.test.mjs` runs on every platform; keep it free of bash.
- Zoom only through `extentOf` in `app.js` (`queryExtent()` honours `definitionExpression`; one match uses the feature's geometry, since SDK 5.2 pads a one-point extent wrongly). GeoParquet with no `crs` gets OGC:CRS84.
- One GeoJSON reader: `toGraphics` in `web/geojson.js` (ring order, checks) serves `add_graphic`, `graphics` and GeoPackage.
- `shortcut:` comments mark accepted limits (growing log, inline GeoPackage log).
- The SDK CDN at `5.2.2` reports `kernel.fullVersion = "5.2.1"`; tests check the load URL instead.
