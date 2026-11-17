# Architecture

## Processes

```
Claude Code ── hooks/register.tsx ──$.http.fetch + token──┐
                                                          ├─> web/server.mjs (bridge, 127.0.0.1:<port>)
shell/agent ── bin/map-command (cli/command.mjs) ──socket─┘     │ SSE /events        ▲ POST /ack, /state
                                                                ▼                    │
                                   every open map page: web/index.html + app.js (SDK 5.2.2 from the CDN)
                                     ├─ mod pane: headless Chrome run by web/viewer.mjs (PNG file -> $.ui.blit)
                                     ├─ Kitty pane: headless Chrome run by pane/pane.mjs (Kitty graphics on stdout)
                                     └─ browser: /map browser (Chrome app window) or any tab
```

- **Bridge** (`web/server.mjs`): one process. The mod starts it on port 8765 at `session.start`, with `MAP_PANE_TOKEN` and `MAP_PANE_SESSION`. `bin/map-pane` starts one on port 0 when no bridge answers. It also listens on a Unix socket, `<tmpdir>/map-pane-command-<uid>-<pid>.sock`, mode 0600.
- **Pages**: any number. Each reads commands from `GET /events` (SSE) and runs them one at a time.
- **CLI** (`cli/command.mjs`): parses the ghostty-style verbs (`web/commands.js`), turns them into `{op, args}` (`toOp`), and posts them to the newest socket. `login` runs the PKCE flow in the CLI and sends the token as a `login` op.

## Bridge protocol

| Endpoint | Caller | Purpose |
|---|---|---|
| `GET /`, `/app.js`, `/map-commands.js`, `/commands.js`, `/geojson.js` | page | The page files, read once at start. No other path is served. |
| `GET /api/start` | page | The start view from `MAP_PANE_*` (`startView` in `web/commands.js`). |
| `GET /api/info` | CLI, launcher | `{url, pid, socket}` |
| `GET /events` | page | SSE: `event: version`, then `reset` + log replay + saved view for a new page, then live commands. Ids are `<epoch>:<n>`. |
| `POST /cmd {op, args, waitMs?}` | mod, CLI | Sends a command to every page, except `save_webmap`, which runs on one page only. The first `ok` ack answers. An error answers only when every connected target page failed. A page that connected later replayed a logged command and never answers it, so it holds the command until the timeout. A failed logged command leaves the log, except when a page already replayed it. `503 noPage` when no page is open. |
| `POST /ack`, `POST /state` | page | A command's answer (with the `tab` id the command carried), or a manual change, with the page's map state. |
| `POST /clear` | mod, CLI | Empties the log, takes a new epoch, sends `reset` to every page, deletes inline GeoJSON files. |
| `POST /input` | mod | Pane size and mouse/key events for `viewer.mjs`. |
| `GET/HEAD /files/<uuid>/<name>` | page | A local file registered by a `path` arg. Range support for GeoParquet. |

Stdout lines that the mod reads: `bridge: <url>`, `SOCKET <path>`, `STATE {...}`, `FRAME <png> <generation>`, `VIEWER down|idle|failed <why>`, `BRIDGE down <why>`.

## Ops

| Op | Logged | Notes |
|---|---|---|
| `add_graphic`, `add_layer`, `update_layer`, `remove_layer`, `reorder_layer`, `clear_graphics`, `set_basemap` | yes | From the mod. `set_basemap` also takes a portal basemap item id. `add_layer` `feature` uses `Layer.fromArcGISServerUrl` (a FeatureServer root becomes a group layer). |
| `graphics` | yes | GeoJSON (or decoded GeoPackage tables) as client-side layers (`runMapCommand` in `web/map-commands.js`). One geometry type: FeatureLayer with legend and popups. Mixed: GraphicsLayer. |
| `geopackage` | as `graphics` | Decoded in the bridge (`cli/geopackage.mjs`, isolated child, read-only SQLite) and logged as a `graphics` op with inline tables. |
| `go_to`, `screenshot`, `extent`, `zoom`, `save_webmap` | no | Read the map or move the view. `go_to {location}` geocodes. |
| `get_basemap`, `list_basemaps` | no | The current basemap; the basemaps usable now (styles and the portal gallery only after `login`). |
| `login` | no | Carries a token. Never logged, never saved; the last one is kept in memory and replayed first to each new page. |
| `reset` | n/a | Sent by the bridge. Removes all layers and restores the start basemap. |

The bridge names each logged layer `L<n>` (`L<n>-<i>` for a multi-table `graphics`), so ids match on every page.
Command ids are assigned after preparation finishes, in delivery order, so overlapping GeoPackage loads cannot make reconnects replay an already-applied command.
Inline `add_layer` GeoJSON (`data`) is written to a file in the data folder; the log holds the path.
A screenshot's data URL is written to a PNG in the data folder; the answer holds the path.
`save_webmap` runs on the first connected page and is never retried on another page after failure or disconnection, since the portal item may already exist.
Local feature collections keep their layer filters when saved. Layer updates validate all requested property names before applying any changes.

## Security

- TCP accepts only `Host: 127.0.0.1:<bound port>` and no foreign `Origin` (DNS rebinding, cross-site POST).
- TCP control endpoints (`/cmd`, `/input`, `/clear`) need `x-map-pane-token` when the bridge has `MAP_PANE_TOKEN` (the mod's per-load random value).
- The Unix socket skips both checks: only its owner can connect (mode 0600).
- File URLs use random UUID keys. Only files registered by a command are served.
- The `login` token stays in page and bridge memory, never in the log or on disk. The bridge replays the last login to each new page, so a logged basemap style or portal layer replays.
- Single-user machine assumed: `GET /events`, `/state` and `/files` need no token (browsers cannot send one), so another local user account could read the map and its served files over TCP. Only the Unix socket is owner-only.

## Persistence

With `MAP_PANE_SESSION` the log (`map.json`), view (`view.json`, rewritten on each pan), inline data and screenshots live in `~/.claude/map-pane/sessions/<id>/`.
Without it (standalone) they live in a temp folder that is deleted on exit.
Session folders untouched for 30 days are deleted at bridge start.

## Panes

- **Mod pane** (`web/viewer.mjs`): raw CDP over `--remote-debugging-pipe`, screencast to one PNG file (write + rename), input from `hooks/viewer-client.ts` through `POST /input`. Starts on the pane size, restarts after a crash (3 tries in 60 s), stops after 90 s with no heartbeat.
- **Kitty pane** (`pane/pane.mjs`, `pane/lib.mjs`): CDP over `--remote-debugging-port=0`, screencast frames as Kitty graphics (`q=2`), SGR pixel mouse and keys mapped to `Input.dispatch*`. Acks a frame in the `stdout.write` callback. `quit()` restores the terminal and removes Chrome and its profile on every exit path.
- Both open the page with `?embedded=1`, which hides the connection badge.

## Page version

The bridge hashes all page files into `__PAGE_VERSION__` (in `app.js`) and sends it as `event: version` on each connect.
A page with another version reloads itself, so an open page never runs old code against a new bridge.

## Accepted limits (`shortcut:` comments)

- The mod uses fixed port 8765: one mod map for each computer.
- The pane assumes 1:2 terminal cells.
- `/map browser` uses the right half of the focused screen.
- The log only grows.
- GeoPackage tables go into the log as inline data.
- GeoPackage: vector simple features only.
