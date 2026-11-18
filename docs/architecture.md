# Architecture

## Processes

```
agent (skill) or shell ── bin/map-command (cli/command.mjs) ──socket──> web/server.mjs (bridge, 127.0.0.1:<port>)
                                                                          │ SSE /events        ▲ POST /ack, /state
                                                                          ▼                    │
                                   every open map page: web/index.html + app.js (SDK 5.2.2 from the CDN)
                                     ├─ Kitty pane: headless Chrome run by pane/pane.mjs (Kitty graphics on stdout)
                                     └─ browser: bin/map-pane --browser, or any tab
```

- **Bridge** (`web/server.mjs`): one process. `bin/map-pane` starts one on port 0 when no bridge answers (detached with `--browser`, stopped by `--close`). It also listens on a Unix socket, `<tmpdir>/map-pane-command-<uid>-<pid>.sock`, mode 0600.
- **Pages**: any number. Each reads commands from `GET /events` (SSE) and runs them one at a time.
- **CLI** (`cli/command.mjs`): parses the ghostty-style verbs (`web/commands.js`), turns them into `{op, args}` (`toOp`), and posts them to the newest socket. `login` runs the PKCE flow in the CLI and sends the token as a `login` op.

## Bridge protocol

| Endpoint | Caller | Purpose |
|---|---|---|
| `GET /`, `/app.js`, `/map-commands.js`, `/commands.js`, `/geojson.js` | page | The page files, read once at start. No other path is served. |
| `GET /api/start` | page | The start view from `MAP_PANE_*` (`startView` in `web/commands.js`). |
| `GET /api/info` | CLI, launcher | `{url, pid, socket}` |
| `GET /events` | page | SSE: `event: version`, then `reset` + log replay + last view for a new page, then live commands. Ids are `<epoch>:<n>:<login id>`; a reconnecting page gets the last login if its id is newer. |
| `POST /cmd {op, args}` | CLI | Sends a command to every page, except `save_webmap`, which runs on one page only. The first `ok` ack answers. An error answers only when every connected target page failed. A page that connected later replayed a logged command and never answers it, so it holds the command until the timeout. A failed logged command leaves the log, except when a page already replayed it. `503 noPage` when no page is open at intake or after preparation. A command discarded before dispatch is never logged. |
| `POST /ack`, `POST /state` | page | A command's answer (with the `tab` id the command carried), or a manual change, with the page's map state. |
| `POST /clear` | CLI | Empties the log, takes a new epoch, sends `reset` to every page, deletes inline GeoJSON files. |
| `GET/HEAD /files/<uuid>/<name>` | page | A local file registered by a `path` arg. Range support for GeoParquet. |

Stdout lines that the launcher and tests read: `bridge: <url>`, `SOCKET <path>`, `BRIDGE down <why>`.

## Ops

| Op | Logged | Notes |
|---|---|---|
| `add_graphic`, `add_layer`, `update_layer`, `remove_layer`, `reorder_layer`, `clear_graphics`, `set_basemap` | yes | `set_basemap` also takes a portal basemap item id. `add_layer` `feature` uses `Layer.fromArcGISServerUrl` (a FeatureServer root becomes a group layer). |
| `graphics` | yes | GeoJSON (or decoded GeoPackage tables) as client-side layers (`runMapCommand` in `web/map-commands.js`). One geometry type: FeatureLayer with legend and popups. Mixed: GraphicsLayer. |
| `geopackage` | as `graphics` | Decoded in the bridge (`cli/geopackage.mjs`, isolated child, read-only SQLite) and logged as a `graphics` op with inline tables. |
| `run_js` | yes, except with `readOnly: true` | `{code, readOnly?, timeoutMs?}`. The page runs `code` as the body of an async function with `view`, `map`, `layerId` and `signal` (`ops.run_js` in `web/app.js`) and answers `{value?, console?}`. Page deadline 30 s (1 to 60 s), counted from arrival, so code that waited past it in the page's queue does not start; bridge deadline 65 s. A replay captures no console. A `run_js` that no page answered froze its page: it leaves the log, unlike other timed-out commands. A live command carries `expiresAt` (the bridge deadline); the page caps the code's deadline 2 s before it. A page that connects while a `run_js` is pending does not get it in its replay. See [run-js.md](run-js.md). |
| `go_to`, `screenshot`, `extent`, `zoom`, `save_webmap` | no | Read the map or move the view. `go_to {location}` geocodes. Web map saves reject layers served by the temporary bridge file endpoint before creating the portal item. |
| `get_basemap`, `list_basemaps` | no | The current basemap; the basemaps usable now (styles and the portal gallery only after `login`). |
| `login` | no | Carries a token. Never logged, never saved; the last one is kept in memory and replayed first to each new page. |
| `reset` | n/a | Sent by the bridge. Removes all layers and restores the start basemap. |

The bridge names each logged layer `L<n>` (`L<n>-<i>` for a multi-table `graphics`), so ids match on every page.
Command ids are assigned after preparation finishes, in delivery order, so overlapping GeoPackage loads cannot make reconnects replay an already-applied command.
Inline `add_layer` GeoJSON (`data`) is written to a file in the data folder; the log holds the path.
A screenshot's data URL is written to a PNG in the data folder; the answer holds the path.
`save_webmap` runs on the first connected page and is never retried on another page after failure or disconnection, since the portal item may already exist.
`save-webmap` saves a WebMap with only the basemap, then writes each layer's `toJSON()` into the item data (most SDK 5.2 layers have no `clone()`). Local feature collections keep their layer filters when saved. Layer updates validate all requested property names before applying any changes.

## Security

- TCP accepts only `Host: 127.0.0.1:<bound port>`, no foreign `Origin` (DNS rebinding, cross-site POST) and no `Sec-Fetch-Site` other than `same-origin` or `none`, except for the page files (an `<img>` or `<iframe>` on another site sends no `Origin`, and would otherwise count as a map page that never answers; a link to the map must still open).
- TCP control endpoints (`/cmd`, `/clear`) need `x-map-pane-token` when the bridge has `MAP_PANE_TOKEN` (optional).
- The Unix socket skips both checks: only its owner can connect (mode 0600).
- File URLs use random UUID keys. Only files registered by a command are served.
- The `login` token stays in page and bridge memory, never in the log or on disk. The bridge replays the last successful login to each new page and to reconnecting pages that missed it, so a logged basemap style or portal layer replays. A replayed login whose token expires within 2 minutes is renewed by the page (refresh token) before the log runs. Login fails if the token has expired and renewal fails. Portal item lookups use the signed-in portal.
- `run_js` is not a sandbox: the code runs as the page and can read the `login` token and call any server (the page sets no Content-Security-Policy). The page cuts the registered tokens and the API key from the answer and the console lines, which stops accidental leaks only. Text the agent reads (attributes, item titles) can carry instructions, so a signed-in map with untrusted data is the risk case. Logged `run_js` code runs again on each replay.
- Single-user machine assumed: `GET /events`, `/state` and `/files` need no token (browsers cannot send one), so another local user account could read the map and its served files over TCP. After a `login`, a new `/events` connection also gets the last login, token included. Only the Unix socket is owner-only.

## Persistence

The log and the view live in bridge memory: a new bridge starts with an empty map.
Inline data and screenshots live in a temp folder that is deleted on exit.

## Panes

- **Kitty pane** (`pane/pane.mjs`, `pane/lib.mjs`): CDP over `--remote-debugging-port=0`, screencast frames as Kitty graphics (`q=2`), SGR pixel mouse and keys mapped to `Input.dispatch*`. Acks a frame in the `stdout.write` callback. `quit()` restores the terminal and removes Chrome and its profile on every exit path.
- It opens the page with `?embedded=1`, which hides the connection badge.

## Page version

The bridge hashes all page files into `__PAGE_VERSION__` (in `app.js`) and sends it as `event: version` on each connect.
A page with another version reloads itself, so an open page never runs old code against a new bridge.

## Accepted limits (`shortcut:` comments)

- `--close` closes tabs only in Google Chrome.
- The bridge serves `/events`, `/state` and `/files` to any local user (single-user machine).
- The log only grows.
- GeoPackage tables go into the log as inline data.
- GeoPackage: vector simple features only.
