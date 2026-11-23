# Use map-pane: Ghostty, browser, Claude Code, Codex and Pi

`mappane/bin/map-pane` shows the map in a terminal with Kitty graphics, for example in a Ghostty split.
`mappane/bin/map-command` changes the map from any shell.
The `map-pane` skill tells Claude Code, Codex or Pi how to use the CLI.

![The map in a Ghostty split](img/ghostty-split.jpg)

All paths in this guide start at the repository folder.

## 1. Requirements

| Item | Requirement |
|---|---|
| Operating system | macOS. `--split` uses AppleScript. |
| Terminal | Ghostty 1.4 or later for `--split`. The pane works in any terminal with Kitty graphics and SGR pixel mouse. |
| Node.js | 24.2 or later. No npm packages. |
| Browser | Google Chrome, or `chrome-headless-shell`. Set `CHROME` if Chrome is not in `/Applications`. |
| Network | Access to `js.arcgis.com` and the basemap tile servers |

## 2. Start the map

1. Open a Ghostty terminal in the repository folder.
2. Type `mappane/bin/map-pane --split`.
3. On the first run, let macOS allow your terminal to control Ghostty.
4. Wait until the map shows in the new split. This takes approximately 5 seconds.
5. Type `mappane/bin/map-command extent`. The command prints the current view when the map is ready.

```sh
mappane/bin/map-pane --split   # open a split to the right of the terminal that ran it
mappane/bin/map-pane           # run in the current terminal
mappane/bin/map-pane --browser # open the map in the default browser
```

`mappane/bin/map-pane` first looks for a running map bridge of your user, for example the bridge of another pane or of `--browser`.
If one answers, the pane shows that map. If none answers, the launcher starts a bridge on a free port.

With `--browser`, the launcher opens the map page in the default browser and prints `{"url": ...}`.
If no bridge answers, it starts one in the background. That bridge continues after the launcher stops.

## 3. Use the pane

| Input | Result |
|---|---|
| Drag | The map pans. |
| Mouse wheel | The map zooms. |
| Click | The page receives a click: zoom buttons, popups. |
| Arrow keys, `+`, `-`, text | The page receives the keys. |
| Ctrl+C | The pane stops. |

A zoom widget shows at the top left. The legend shows at the bottom right while the map has layers.

## 4. Stop the map

1. Click in the map split.
2. Push Ctrl+C.

The pane restores the terminal and stops its Chrome. If the launcher started the bridge, it stops the bridge too.
A bridge that was already running continues. Ghostty closes the split.

To stop a map that you opened with `--browser`, type `mappane/bin/map-pane --close`.
The command stops the bridge that `--browser` started and closes the map tabs in Google Chrome.
Tabs in other browsers stay open and show that the connection is lost.
If `--browser` did not start a bridge (for example, it used the bridge of a split), the command stops nothing and exits with status 1.

## 5. Map commands

Type the commands in a terminal other than the map split.
Each command prints JSON. A failed command prints an error and exits with status 1.

| Command | Result |
|---|---|
| `extent` | Prints the bounds and spatial reference of the view. |
| `clear` | Removes all layers. The basemap goes back to the start basemap. The legend hides. |
| `zoom [layer-id \| title]` | Shows all layers, or one layer. |
| `remove <layer-id or title>` | Removes one layer. The other layers and the basemap stay. |
| `reorder <layer-id or title> <top \| bottom \| index>` | Moves one layer in the drawing order. Index 0 is the bottom layer. The answer lists the layer ids from bottom to top. |
| `update-layer <layer-id or title> [--title <name>] [--renderer <JSON>] [--labels <JSON>] [--filter <SQL>] [--opacity <0-1>] [--visible true\|false]` | Changes one layer without reloading its data. Give at least one option. `--labels` turns labels on. `--filter` sets the SQL where clause (feature, GeoJSON, CSV and GeoParquet layers). |
| `go_to location <place or address>` | Finds a country, state, city, ZIP code or address with the World Geocoding service. Prints the match, the score and the extent. |
| `go_to coordinate <lat> <lon> [zoom]` | Centers on WGS84 degrees, latitude first. Keeps the zoom unless you give one (0 to 23). |
| `screenshot <file.png>` | Writes a PNG of the map. The PNG has no legend. |
| `basemap` | Prints the current basemap: `id` and `title`. |
| `basemap list` | Prints the basemaps you can use now. See [Basemaps](#6-basemaps). |
| `basemap <id>` | Sets the basemap: a keyless, legacy or style id, or a portal basemap item id. |
| `login [--arcctl] [--portal-url <url>] [--client-id <id>] [--redirect-uri <uri>]` | Signs in to a portal. See [Sign in](#7-sign-in). |
| `save-webmap <title>` | Saves the map as a private web map item. Needs `login`. Use permanent data URLs, or import local GeoJSON with `graphics` and remove the local layer. The GeoJSON must have one geometry type: a mixed file makes a layer that cannot be saved. |
| `map-service <url>` | Adds a MapServer. |
| `feature-service <url>` | Adds a FeatureServer. A root URL adds all layers. A numbered URL adds one. |
| `geojson <url>` | Adds GeoJSON from a URL. |
| `geopackage <url> [table]` | Adds the vector tables of a GeoPackage, one layer each. |
| `graphics <file \| - \| JSON> [--title <name>] [--renderer <file \| JSON>] [--labels <file \| JSON>]` | Adds GeoJSON from a file, standard input or inline JSON. |
| `js <file.js \| - \| code> [--timeout <ms>] [--read-only]` | Runs JavaScript in the map page. Prints the returned `value` and the `console` lines. See [Run JavaScript](#run-javascript). |
| `--info` | Prints the page URL, process id and socket of the targeted map. |

Commands that add data do not move the view. Type `zoom` after them.

Examples:

```sh
mappane/bin/map-command basemap dark-gray-vector
mappane/bin/map-command go_to location "Austin, Texas"
mappane/bin/map-command go_to coordinate 30.2672 -97.7431 12
mappane/bin/map-command feature-service https://sampleserver6.arcgisonline.com/arcgis/rest/services/Wildfire/FeatureServer
mappane/bin/map-command geojson https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson
cat features.geojson | mappane/bin/map-command graphics - --title Features
mappane/bin/map-command graphics examples/cities.geojson --title "World cities" --renderer examples/population-renderer.json
mappane/bin/map-command zoom
mappane/bin/map-command screenshot map.png
mappane/bin/map-command js 'return map.layers.map(l => l.title).toArray()' --read-only
```

### The legend

- The legend lists layers that have a renderer.
- `graphics` and `geopackage` make a client-side FeatureLayer when all features have one geometry type. It has a legend entry and popups.
- Mixed geometry types make a GraphicsLayer. It has no legend entry, and it refuses `--renderer` and `--labels`.

### Color features by a value

1. Put the value in a GeoJSON property. You can calculate it first, for example in SQL.
2. Write a renderer in SDK autocast JSON (class-breaks or unique-value).
3. Set the renderer `field` to the safe field name. See the rule below.
4. Type `graphics` with `--title` and `--renderer`. The title is the legend heading.
5. Type `zoom`.

<a id="safe-field-names"></a>
**Safe field names.** Each property name becomes a safe field name.
Each character outside ASCII letters, digits and `_` becomes `_`.
For example, `population (millions)` becomes `population__millions_`.
A name that starts with a digit gets an initial `_`. An empty name becomes `field`.
The name `__oid` is reserved. Underscores are added until each name is unique.
Properties with only null values make no field. The alias keeps the original name.
A property with only numbers becomes a `double` field. Other properties become `string` fields.

### Run JavaScript

`js` runs code in the map page, for work that no other command does: feature queries, statistics,
a renderer calculated from the data, popups, geometry operations.

- The code is the body of an async function. `view`, `map`, `layerId` and `signal` are in scope. `await` and `return` work.
- Give the code inline (in single quotes), as a file whose name ends in `.js` or `.mjs`, or on standard input (`-`).
- The command prints `{ "value": <the returned value>, "console": [<the logged lines>] }`.
- Code that changes the map is saved and runs again on each page that opens later. Give a new layer `id: layerId`.
- Add `--read-only` when the code only reads the map or moves the view. It is then not saved.
- The deadline is 30 s. `--timeout <ms>` changes it (1,000 to 60,000).
- The code has the rights of the page. After `login` it can read the portal token. Run only code and data that you trust.

```sh
mappane/bin/map-command graphics examples/cities.geojson --title Cities
mappane/bin/map-command js --read-only '
  const layer = map.layers.find(l => l.title === "Cities")
  return await layer.queryFeatureCount({ where: "population__millions_ > 20" })'
```

All the rules and seven tested examples: [run-js.md](run-js.md).

### Use as a library

`mappane/cli/command.mjs` exports the CLI as calls (package export `map-pane`). The CLI only prints what `run` returns.

```js
import { connect, run } from "map-pane"
await run(["go_to", "location", "Austin, Texas"])          // the JSON map-command prints; errors throw
await run(["graphics", "-", "--title", "Points"], { stdin: process.stdin })
const map = connect()                                      // newest map; connect({ socket }) for another
await map.command({ op: "extent", args: {} })              // one bridge op
```

- `run(argv, { stdin, socket })` takes the same words as `map-command`. Relative paths resolve from the current folder.
- `connect({ socket })` gives `command({ op, args })`, `info()` and `clear()`.
- In the Claude Code code-mode REPL there is no `import`: call `map-command` through `$`.

Full guide, with the code-mode helper, recipes, a worked example and the API reference: [code-mode.md](code-mode.md).

## 6. Basemaps

`basemap list` asks the running map. The list depends on the sign-in:

- `current`: the basemap on the map now (`id`, `title`). `signedIn`: `true` after `login`.
- `keyless`: 5 Esri raster basemaps with no key: `dark-gray`, `light-gray`, `imagery`, `topo`, `streets`.
- `legacy`: 16 ids that work with no sign-in, for example `osm`, `satellite`, `dark-gray-vector`.
- `styles`: 78 basemap style ids, for example `arcgis/navigation`. Only after `login` (or with `?apiKey=`).
- `portal`: the basemap gallery of the portal you signed in to, as `id` (item id) and `title`. Only after `login`.
  If the gallery fails or takes more than 10 s (for example, an expired sign-in), `portalError` says why and the other lists stay.

With no running map, `basemap list` prints `keyless`, `legacy` and `styles` and a note on standard error.
`basemap <item-id>` sets a portal basemap. A basemap that fails leaves the current basemap in place.

## 7. Sign in

`login` uses OAuth 2.0 with an authorization code and PKCE. The client ID needs no secret.
The map pages keep the token and refresh it. The CLI never prints it, and the bridge never saves it.

1. In the portal, open the OAuth credentials of your app.
2. Add the redirect URI `http://127.0.0.1:8766/`.
3. Set `MAP_PANE_CLIENT_ID`, or use `--client-id`.
4. Set `MAP_PANE_PORTAL_URL`, or use `--portal-url`. The default is `https://www.arcgis.com`.
5. Start the map.
6. Type `mappane/bin/map-command login`.
7. Sign in on the page that opens. You have 5 minutes.

```sh
MAP_PANE_CLIENT_ID=<client-id> mappane/bin/map-command login
mappane/bin/map-command basemap arcgis/navigation
```

- `login` prints the sign-in URL on standard error. Open it yourself if no browser opens.
- Only one `login` can wait at a time, because it listens on port 8766. Use `--redirect-uri` or `MAP_PANE_REDIRECT_URI` for another loopback port.
- Pages that open later get the sign-in from the bridge. After a bridge restart, sign in again.
- A save runs on one page and keeps filters on local feature layers. If that page disconnects while saving, check the portal before retrying: the item may already exist.

### Use the arcctl sign-in

If you use [arcctl](https://github.com/EsriPS/arcctl), sign in one time with `arcctl login`. Then give that session to the map:

```sh
arcctl login --portal <portal-url> --client-id <client-id>
mappane/bin/map-command login --arcctl
```

- `--arcctl` reads the session from `config.json` in the arcctl folder: `ARCCTL_CONFIG_DIR`, else `./.arcctl` if it exists, else `~/.arcctl`.
- map-pane only reads that file. It never writes it, and it never prints the token. arcctl stays the owner of the session.
- The file must belong to you and be private (mode 600).
- The session must come from an OAuth `arcctl login`. A `--generate-token` session cannot renew, so `--arcctl` refuses it.
- The token goes only to the portal that issued it. With `--portal-url` or `MAP_PANE_PORTAL_URL` set to another portal, `--arcctl` refuses.
- The map pages renew the token with the arcctl refresh token, in memory. After `arcctl logout` or a new `arcctl login`, run `login --arcctl` again.
- The sign-in goes one way only: map-pane cannot give its token to arcctl.

## 8. Agents

The repository has one skill, `.agents/skills/map-pane/SKILL.md`. Install it once, and it works from any folder.
The skill runs the CLI by its absolute path, so the agent can work in your own project.

| Agent | Install |
|---|---|
| Claude Code | `/plugin install map-pane --marketplace mraad/map-pane` |
| Codex | `codex plugin marketplace add mraad/map-pane`, then `codex plugin add map-pane@map-pane` |
| Pi | `pi install git:github.com/mraad/map-pane` |

From a local clone, use its path instead: `claude plugin marketplace add /path/to/map-pane`, `codex plugin marketplace add /path/to/map-pane` or `pi install /path/to/map-pane`.
A local Pi install loads the clone in place. A local Codex install copies it: after a change, run `codex plugin add map-pane@map-pane` again.

Without an install, start the agent in the repository folder: Codex and Pi find `.agents/skills/`,
and Claude Code finds `.claude/skills/map-pane`, a link to the same folder.

Ask with the skill prefix, or in plain words:

| Agent | Example |
|---|---|
| Claude Code | `/map-pane go_to location Austin, Texas` (in the repository folder), `/map-pane:map-pane ...` (installed) |
| Codex | `$map-pane go_to location Austin, Texas` |
| Pi | `/skill:map-pane go_to location Austin, Texas` |

The agent needs shell access on the same computer, as the user who runs the map.
An agent can query data (for example with DuckDB), write GeoJSON and a renderer, and send them with `graphics`.
For questions about data that is already on the map, the agent writes code for `js` ([run-js.md](run-js.md)).

### Codex

The Codex `workspace-write` sandbox blocks the map socket with `connect EPERM`. Allow it:

```sh
codex exec -s workspace-write -c sandbox_workspace_write.network_access=true '$map-pane list the basemaps'
```

The same setting lets `login` listen on its loopback redirect and reach the portal.
`login` waits up to 5 minutes. Give the agent a shell timeout of at least 300 seconds.

### Pi

1. Start Pi in the repository folder.
2. Accept the trust prompt for the repository.
3. If Pi does not list the skill, type `/reload`.

Pi needs its provider credentials in its environment. Start it from a shell that has them.

### Claude Code

Claude runs the CLI with its shell tool and asks before each new command.
To stop the prompts, allow the CLI once in `/permissions`, for example `Bash(/path/to/map-pane/.agents/skills/map-pane/scripts/map-command:*)`.

With code mode on, Claude writes JavaScript for its REPL tool and calls the CLI through `$`.
One script then chains many map commands and checks each JSON result. Helper, recipes and a worked example: [code-mode.md](code-mode.md).

### Tested

On 2026-11-17, each agent ran the same task on a live map: geocode Austin, Texas, add `examples/cities.geojson`, save a screenshot.

| Agent | Path | Result |
|---|---|---|
| Codex CLI 0.169.0 | skill + CLI, `workspace-write` with network access | Austin matched (score 100), 20 features with the population renderer, [screenshot](img/proof-codex.png) |
| Pi 1.3.0 | skill + CLI | Same result, [screenshot](img/proof-pi.png) |
| Claude Code (mod, removed in 0.5.0) | `mcp__mappane__go_to`, `add_layer`, `screenshot` | Austin matched (score 100), layer added, [screenshot](img/proof-claude.png) |

Codex and Pi also ran the task from an unrelated folder after an install (plugin and package), each with the CLI from its install path.

## 9. Several maps

The CLI sends each command to the newest bridge of your user.
To choose another map, set its socket on each command:

```sh
MAP_PANE_SOCKET="$(node -p 'require("os").tmpdir()')/map-pane-$(id -u)/command-<bridge-pid>.sock" mappane/bin/map-command extent
```

Each bridge can have many pages open (panes, browsers). All pages of one bridge show the same map.

## 10. Options

| Variable | Default | Meaning |
|---|---|---|
| `CHROME` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | Chrome binary. `chrome-headless-shell` also works. |
| `MAP_PANE_DPR` | `2` | Terminal pixels for each CSS pixel. Use `1` on a display that is not Retina. |
| `MAP_PANE_BASEMAP` | `osm` | Start basemap. A legacy id only. |
| `MAP_PANE_CENTER` | none | Start center, `latitude,longitude` |
| `MAP_PANE_ZOOM` | `3` | Start zoom, 0 to 23. Needs `MAP_PANE_CENTER`. |
| `MAP_PANE_EXTENT` | the world | Start extent, `xmin,ymin,xmax,ymax` in longitude and latitude. Overrides center and zoom. |
| `MAP_PANE_SOCKET` | the newest bridge | The bridge that `map-command` uses |
| `MAP_PANE_PORTAL_URL` | `https://www.arcgis.com` | Portal for `login` |
| `MAP_PANE_CLIENT_ID` | none | OAuth client ID for `login` |
| `MAP_PANE_REDIRECT_URI` | `http://127.0.0.1:8766/` | Loopback redirect for `login` |
| `PORT` | `0` (a free port) | Port of a bridge that the launcher starts |

`--split` sends `CHROME`, `MAP_PANE_DPR` and the four start-view variables to the new split.
The start-view variables apply only to a bridge that the launcher starts. A bad value stops the launcher.

## 11. Data rules and limits

| Subject | Rule |
|---|---|
| GeoJSON | WGS84 (RFC 7946). A `crs` member is an error. Polygon ring order is corrected. |
| Failed layers | The page loads a layer before it adds it. A layer that fails does not change the map. |
| GeoPackage | Each vector table is a layer. EPSG or WKT and Z are kept; M is dropped. Raster tiles, curves and undefined coordinate systems are refused. URL downloads stream to a temporary file. 64 MiB and 100,000 features at most. |
| Deadlines | 15 s for each command; 60 s to add data, `graphics` and `save-webmap`; 30 s for `zoom` and `screenshot`; 30 s for `js` code (60 s at most); 30 s each for a GeoPackage download and conversion. |
| Services | A service must allow browser CORS access. |
| Repeats | Commands that add data are not idempotent. Examine the map before you repeat a command that timed out. |

## 12. Known limits

- Frames have CSS resolution. On a Retina display, map text is softer than in a browser.
- Each frame is a full PNG. This is correct for a local terminal, not for a slow SSH connection.
- The pane sends arrow keys, Enter, Backspace, Tab, Escape and printable text. It does not send function keys or Control and Alt combinations.
- Headless Chrome draws no pointer. Ghostty shows its own pointer.

## 13. Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `cannot start Chrome at …` | Chrome is not at the default path. | Set `CHROME`. |
| The pane is blank. | No access to `js.arcgis.com`. | Type `npm run serve`. Open the URL in a browser and examine the console. |
| `--split` does nothing. | macOS refused the automation permission. | System Settings, Privacy & Security, Automation: allow your terminal to control Ghostty. |
| `No running map found` | No bridge, or another `TMPDIR`. | Start `mappane/bin/map-pane --split`, or set `MAP_PANE_SOCKET`. |
| `No map page is open` | The bridge runs, but no page shows the map. | Start `mappane/bin/map-pane --split` or `mappane/bin/map-pane --browser`. |
| `needs a sign-in` | A basemap style or `save-webmap` with no token | Type `mappane/bin/map-command login`. |
| `Port 8766 is busy` | Another `login` waits. | Finish it, or use `--redirect-uri`. |
| `connect EPERM` in Codex | The sandbox blocks the socket. | Add `-c sandbox_workspace_write.network_access=true`. |
| `A renderer needs features of one geometry type` | Mixed geometry types | Split the GeoJSON by geometry type. |
| The terminal is incorrect after a crash. | The pane did not restore it. | Type `reset`. |
