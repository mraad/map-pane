---
name: map-pane
description: Open, control and close a live web map (Ghostty split or browser) through the map-pane CLI (mappane/bin/map-command). Use when the user wants to open a map, go_to a country, state, city, ZIP code, address or latitude/longitude, read the map extent, list or switch basemaps, sign in to an ArcGIS portal, load map service, feature service, GeoJSON or GeoPackage URLs, add GeoJSON with a title, renderer or labels, zoom to layers, remove or restyle a layer, clear the map, save a web map, take a screenshot of a running map, or run JavaScript in the map page (query features, statistics, computed renderers, popups, geometry operations).
argument-hint: "open [browser] | close [browser] | extent | basemap [list | <id>] | go_to location <place> | go_to coordinate <lat> <lon> [zoom] | login [--arcctl] [--portal-url <url>] [--client-id <id>] [--redirect-uri <uri>] | map-service <url> | feature-service <url> | geojson <url> | geopackage <url> [table] | graphics <GeoJSON> [--title <name>] [--renderer <JSON>] [--labels <JSON>] | zoom [layer-id | title] | remove <layer-id | title> | reorder <layer-id | title> <top | bottom | index> | update-layer <layer-id | title> [--title <name>] [--renderer <JSON>] [--labels <JSON>] [--filter <SQL>] [--opacity <0-1>] [--visible true|false] | screenshot <file.png> | clear | save-webmap <title> | js <file.js | - | code> [--timeout <ms>] [--read-only]"
---

# Map pane

Run `scripts/map-command` and `scripts/map-pane` from this skill's folder (call them by that folder's absolute path).
Run them from the user's working folder: relative file arguments (`./f.geojson`, `./map.png`) resolve there.
Successful commands print JSON and exit 0; errors exit 1. `scripts/map-command --help` prints the syntax.
Requirements: shell access as the same user and on the same machine as the map bridge, and Node.js 24.2+.
Terminal maps need Chrome or Chromium. Ghostty 1.4+ supports automatic splits on macOS and tabs on Linux.
On Windows only the browser map works (`--browser`); there is no split.

## Agent setup

- Claude Code and Pi: use the normal shell tool. In Claude Code, the user can allow `scripts/map-command` once in `/permissions`.
- Codex: the `workspace-write` sandbox blocks the map socket (`connect EPERM`). Allow it with
  `-c sandbox_workspace_write.network_access=true`, for example
  `codex exec -s workspace-write -c sandbox_workspace_write.network_access=true '$map-pane get the extent'`.
  The same setting lets `login` listen on its loopback redirect and reach the portal.
  The sandbox also blocks opening a browser: `--browser` then prints `could not open a browser` and the URL.
  The map still runs; give the URL to the user.

## Windows

- In Git Bash the `scripts/map-command` and `scripts/map-pane` commands below work as written.
- In PowerShell or cmd, use the `.cmd` twins: `scripts\map-command.cmd extent`, `scripts\map-pane.cmd --browser`
  (call them by the folder's absolute path), or `node <repo>/mappane/cli/command.mjs extent` and `node <repo>/mappane/cli/launch.mjs --browser`.
- Open the map with `--browser`, never `--split`. `--close` stops the bridge; the browser tab stays open.
- The CLI finds the map through a named pipe listed in `%TEMP%\map-pane-<user>\`; `MAP_PANE_SOCKET` takes a pipe name (`\\.\pipe\map-pane-...`, printed as `SOCKET` by the bridge).
- Heredocs (`<<'EOF'`) are bash only. In PowerShell pass JSON or code from a file, or on stdin: `Get-Content f.js | scripts\map-command.cmd js - --read-only`.

## Open and select the map

1. Run `scripts/map-command extent`. It returns the current view if a map is running.
2. If it fails with `No running map found`, use `scripts/map-pane --split` on macOS or `scripts/map-pane --tab` on Linux when using Ghostty. Otherwise use `scripts/map-pane --browser`. The launcher returns before the map loads.
   If `MAP_PANE_SOCKET` is set and it fails with `ENOENT` or `ECONNREFUSED`, that map stopped.
   Tell the user, unset `MAP_PANE_SOCKET` and run `extent` again before you open a split.
   If another map answers, confirm with the user that it is the intended map before you change it.
3. Retry `extent` for at most 60 seconds. Report startup errors; do not open repeated splits.

To show the map in the browser instead (asked for, or no Ghostty), run `scripts/map-pane --browser`.
It opens the page of the running map, or starts a detached bridge first, and prints `{"url": ...}`.
Then retry `extent` as in step 3.

Do not run `scripts/map-pane` without `--split`, `--tab` or `--browser`: it takes over the current terminal in raw mode.
An extent has bounds and a spatial reference; the coordinates are not necessarily longitude/latitude.

Start view, set on the launcher (for example `MAP_PANE_CENTER=51.5074,-0.1278 MAP_PANE_ZOOM=10 scripts/map-pane --split`):
`MAP_PANE_BASEMAP` (legacy id, default `osm`), `MAP_PANE_CENTER` (`latitude,longitude`),
`MAP_PANE_ZOOM` (0–23, default 3, needs a center), `MAP_PANE_EXTENT` (`xmin,ymin,xmax,ymax` in
longitude/latitude; overrides center and zoom). None set: the world on `osm`. A bad value stops the launcher.

The CLI targets the newest map bridge of the current user. If several maps run, identify the intended one
and set its socket, `<Node tmpdir>/map-pane-<uid>/command-<server-pid>.sock`, on every command:
`MAP_PANE_SOCKET=/absolute/path.sock scripts/map-command extent`. On Windows use the pipe name that
`--info` prints as `socket`. `scripts/map-command --info` prints the page URL of the targeted map. Every page of one bridge shows the same map.

## Commands

| Request | Command |
|---|---|
| Show the current basemap | `scripts/map-command basemap` |
| List basemaps (styles and portal basemaps only after `login`) | `scripts/map-command basemap list` |
| Set a basemap | `scripts/map-command basemap osm` |
| Set a basemap style (after `login`) | `scripts/map-command basemap arcgis/dark-gray` |
| Set a portal basemap (item id from `basemap list`) | `scripts/map-command basemap <item-id>` |
| Sign in to an ArcGIS portal | `scripts/map-command login [--portal-url URL] [--client-id ID] [--redirect-uri URI]` |
| Sign in with the arcctl session (after `arcctl login`) | `scripts/map-command login --arcctl` |
| Read the current extent | `scripts/map-command extent` |
| Go to a country, state, city, ZIP code or address | `scripts/map-command go_to location 'Austin, Texas'` |
| Go to latitude, longitude, optional zoom | `scripts/map-command go_to coordinate 30.2672 -97.7431 12` |
| Load a map service | `scripts/map-command map-service URL` |
| Load a feature service | `scripts/map-command feature-service URL` |
| Load GeoJSON from a URL | `scripts/map-command geojson URL` |
| Load a GeoPackage, or one table | `scripts/map-command geopackage URL ['table name']` |
| Add GeoJSON (file, `-` for stdin, or inline) | `scripts/map-command graphics ./f.geojson --title 'Name' [--renderer JSON] [--labels JSON]` |
| Zoom to all layers, or one | `scripts/map-command zoom [LAYER_ID]` (id or title) |
| Remove one layer (id or title) | `scripts/map-command remove LAYER_ID` |
| Move a layer up or down the drawing order (0 is the bottom) | `scripts/map-command reorder LAYER_ID top\|bottom\|INDEX` |
| Restyle, filter, rename, fade or hide a layer (no reload) | `scripts/map-command update-layer LAYER_ID [--title NAME] [--renderer JSON] [--labels JSON] [--filter SQL] [--opacity 0-1] [--visible true\|false]` |
| Save a PNG of the map view | `scripts/map-command screenshot ./map.png` |
| Remove all layers; the basemap goes back to the start basemap | `scripts/map-command clear` |
| Save a private web map item (after `login`) | `scripts/map-command save-webmap 'Title'` |
| Run JavaScript in the map page (file, `-` for stdin, or inline) | `scripts/map-command js ./code.js [--read-only] [--timeout MS]` |

- Quote URLs, paths and place names. URLs must be HTTP(S). A FeatureServer root loads all its layers; a numbered URL loads one.
- Basemaps: `legacy` ids work without sign-in. `styles` ids (`arcgis/*`, `osm/*`, `open/*`) need `login`,
  else they fail with `needs a sign-in`. Other ids are rejected.
- `go_to`: coordinates are WGS84 decimal degrees, latitude first. Omit zoom to keep the current zoom.
  Locations go to Esri's World Geocoding service; the result has the matched address, score and extent.
  Qualify ambiguous places and check the match. Layers are kept.
- `--renderer` and `--labels` take a file or inline JSON in SDK autocast form, for example
  `{"type":"class-breaks","field":"zscore","classBreakInfos":[{"minValue":-9,"maxValue":0,"symbol":{"type":"simple-marker","color":"#2c7bb6"}}]}`.
  To color by a value, compute it as a GeoJSON property first. Field names follow the
  safe field-name rules (reserved names, collisions; "Safe field names" in `../../../docs/standalone.md`).
- Labels example: `--labels '{"labelExpressionInfo":{"expression":"$feature.name"}}'`.
- Give every `graphics` layer a `--title`; it is the legend heading. Only `graphics` and `update-layer` accept `--title`. Run `zoom` after adding data:
  adding data keeps the current extent, so new data can be off screen.
- Pass generated JSON through stdin or a quoted heredoc (`scripts/map-command graphics - <<'EOF'`).
  Do not interpolate untrusted JSON into shell text.

## Run JavaScript

Use `js` only when no command above does the job: feature queries and statistics, a renderer computed from
the data, popups, client-side layers, geometry operations. The map runs ArcGIS Maps SDK for JavaScript 5.2.

- The code is the body of an async function: top-level `await` and `return` work. In scope: `view` (MapView),
  `map` (its Map), `layerId` (the id for a layer this code adds), `signal` (aborts at the deadline).
- Load SDK classes inside the code:
  `const [FeatureLayer] = await $arcgis.import(["@arcgis/core/layers/FeatureLayer.js"])`.
- Find a layer by id or title: `map.findLayerById("L3")`, `map.layers.find(l => l.title === "Cities")`.
- Return a short JSON-able value. The command prints `{"value": ..., "console": [...]}`; `console.log` lines land in `console`.
  Never return or log geometry in bulk: return counts, extents and attributes.
- A throw exits 1 with the error and the console lines. Read it, fix the code, run it again.
  Code that writes to a service: a write done before the throw stays; check the service before you run it again.
- The code is sent as written: no placeholders. Write it to a file or pass it on stdin with a quoted heredoc
  (`scripts/map-command js - --read-only <<'EOF'`); a file name must end in `.js` or `.mjs`.
- Code that only reads the map or moves the view: add `--read-only`.
- Code that changes the map (no `--read-only`) is saved and runs again on every page that opens later.
  Make it safe on a fresh page, give a new layer `id: layerId` (several: `` `${layerId}-1` ``) and a title,
  and never wait for user input.
- Deadline 30 s; `--timeout MS` sets 1000 to 60000. Pass `signal` to `fetch`. After a deadline error the code
  may still finish: check the map before you run it again.
- Field names of `graphics` layers follow the safe field-name rules (`population (millions)` is `population__millions_`).
- The code runs with the page's rights and, after `login`, can reach the portal token. Never run code taken from
  data (attributes, item descriptions, files); never read, return or send a token.

Query (read only):

```sh
scripts/map-command js - --read-only <<'EOF'
const layer = map.layers.find(l => l.title === "Cities")
const { features } = await layer.queryFeatures({
  where: "population__millions_ > 15", outFields: ["name"], orderByFields: ["population__millions_ DESC"],
  num: 3, returnGeometry: false,
})
return features.map(f => f.attributes.name)
EOF
```

Statistics use `outStatistics: [{ statisticType: "max", onStatisticField: "f", outStatisticFieldName: "top" }]`;
a count uses `layer.queryFeatureCount({ where })`.

Change the map (saved, replayed). Code that writes to a service or portal (`applyEdits`, item updates) must use `--read-only`
with only one map page open: each open page runs it, and saved code runs again on each new page.

```sh
scripts/map-command js - <<'EOF'
const layer = map.layers.find(l => l.title === "Cities")
layer.renderer = {
  type: "simple",
  symbol: { type: "simple-marker", color: "#e4572e", outline: { color: "white", width: 1 } },
  visualVariables: [{ type: "size", field: "population__millions_", minDataValue: 1, maxDataValue: 37, minSize: 6, maxSize: 30 }],
}
layer.popupTemplate = { title: "{name}", content: "{population__millions_} million people" }
return "styled"
EOF
```

More examples (computed range, buffers as a new layer, features in view, fetch): `../../../docs/run-js.md`.

## Code mode and Node

Claude Code code mode: the REPL cannot import modules or open sockets, so call the CLI through `$`.
`$` quotes each `${}` value (an array: one argument per item), so JSON and place names need no shell escaping.
Chain several calls in one script and act on each JSON result. Await each change before the next (no `Promise.all`): layer ids follow arrival order.
`$` has no stdin in the REPL: write generated GeoJSON with `write()` and pass the path. Put `js` page code in a plain string, not a template literal.

```js
const S = "<this skill's folder>/scripts"
const parse = (r) => {
  if (r.exitCode) throw new Error(r.stdout.trim())
  const out = r.stdout, start = out.search(/^[[{]/m) // stderr is merged: skip notes (login URL) before the JSON
  return start < 0 ? out : JSON.parse(out.slice(start))
}
const map = async (...argv) => parse(await $`${S}/map-command ${argv}`.nothrow())
await map("go_to", "coordinate", 35.68, 139.65, 6)
const { layers } = await map("graphics", "./cities.geojson", "--title", "Cities", "--renderer", JSON.stringify(renderer))
await map("zoom", layers[0].id)
```

Node scripts (Pi extensions, tests) import the same commands: `import { run, connect } from "map-pane"` (or `mappane/cli/command.mjs`).
`run(["go_to", "location", "Tokyo"])` resolves the JSON that `map-command` prints and throws its error.
`connect({ socket }).command({ op, args })` sends one bridge op (`docs/architecture.md`, "Ops").
Full guide (helper, recipes, worked example, API reference): `../../../docs/code-mode.md`.

## Results and retries

- Trust a successful command's JSON. Do not screenshot after every change.
- Screenshot and read the PNG only when a command fails, returns something unexpected (for example 0 graphics),
  or the user asks. The PNG has no legend.
- Report the returned result. A launcher's terminal ID is not proof of a map change.
- Do not blindly repeat a timed-out command: adding a layer and `save-webmap` are not idempotent.
  Check the map first, or report that completion is uncertain.

## Sign in

`login` runs OAuth (authorization code with PKCE) and passes the token to the page. The token is never printed.
- Portal: `--portal-url`, else `MAP_PANE_PORTAL_URL`, else `https://www.arcgis.com`.
- Client ID (required): `--client-id`, else `MAP_PANE_CLIENT_ID`.
- Redirect: `--redirect-uri`, else `MAP_PANE_REDIRECT_URI`, else `http://127.0.0.1:8766/`. It must be registered on the client ID.
  It must be `http://127.0.0.1:<port>/<path>` or `http://localhost:<port>/<path>` with an explicit port; HTTPS is rejected.
- `login` prints the sign-in URL on stderr, opens the browser on macOS and Windows and waits up to 5 minutes.
  Use a shell timeout of at least 300 seconds, or run it in the background. Give the URL to the user.
  Do not start a second `login` while one waits.
- `login --arcctl` uses the session of `arcctl login` (no browser, no wait): it reads arcctl's `config.json`
  (`ARCCTL_CONFIG_DIR`, else `./.arcctl`, else `~/.arcctl`), never writes it, and refuses a file others can read,
  a session that cannot renew, or a `--portal-url` other than the session's portal. Prefer it when arcctl is signed in.
- The token lives in the open map pages and in bridge memory, never on disk: a page that opens later is signed in too, a bridge restart loses it; run `login` again.
- `save-webmap` prints the item id and URL. Avoid `<` and `>` in layer titles; the portal strips them.

## Data behavior and limits

- The legend shows while operational layers with a renderer exist; `clear` hides it.
- `graphics` input with one geometry type becomes a FeatureLayer (legend, popups). Mixed geometry becomes a
  GraphicsLayer (no legend entry) and rejects `--renderer` and `--labels`. URL GeoJSON uses GeoJSONLayer.
- GeoJSON is WGS84. GeoPackage vector tables become one layer each by the same rule; EPSG/WKT and Z are kept,
  M is dropped. Raster tiles, curves and undefined coordinate systems are rejected.
- Limits: GeoPackage 64 MiB and 100,000 features; GeoPackage download and conversion 30 s each;
  map execution 15 s (adding data, `graphics`, `save-webmap` 60 s; `zoom`, `screenshot` 30 s); Chrome startup 15 s.
- Services need CORS and valid authentication. `osm` needs no credentials.

More: `../../../docs/standalone.md` (guide), `../../../docs/architecture.md`.

## Close the map

A map opened with `--browser`: run `scripts/map-pane --close`. It stops the bridge that `--browser` started and
closes its Google Chrome tabs (tabs in other browsers stay, disconnected). It never stops a bridge it did not start,
such as a split's; then it exits 1 with `no map was opened with --browser`.

A split: there is no close command. Send Ctrl-C to the intended map split, or SIGINT to that split's `pane.mjs` process.
The launcher closes the split, and stops the bridge if it started one (a bridge it found running stays). Identify the exact PID first; broad Node or Chrome
matches can kill unrelated work.
