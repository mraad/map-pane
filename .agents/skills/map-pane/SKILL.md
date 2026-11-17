---
name: map-pane
description: Open, control and close a live web map (Ghostty split, browser, or the Claude Code mod's map) through the map-pane CLI (mappane/bin/map-command). Use when the user wants to open a map, go_to a country, state, city, ZIP code, address or latitude/longitude, read the map extent, list or switch basemaps, sign in to an ArcGIS portal, load map service, feature service, GeoJSON or GeoPackage URLs, add GeoJSON with a title, renderer or labels, zoom to layers, clear the map, save a web map, or take a screenshot of a running map.
argument-hint: "open | close | extent | basemaps | basemap <id> | go_to location <place> | go_to coordinate <lat> <lon> [zoom] | login [--portal-url <url>] [--client-id <id>] [--redirect-uri <uri>] | map-service <url> | feature-service <url> | geojson <url> | geopackage <url> [table] | graphics <GeoJSON> [--title <name>] [--renderer <JSON>] [--labels <JSON>] | zoom [layer-id] | screenshot <file.png> | clear | save-webmap <title>"
---

# Map pane

`<root>` is the map-pane folder: three directories above this SKILL.md (a repository clone, a Codex plugin
cache or a Pi package). Resolve it once to an absolute path and write every command below with it, for example
`/Users/me/map-pane/mappane/bin/map-command extent`. Run the commands from the user's working folder:
relative file arguments (`./f.geojson`, `./map.png`) resolve there.
In Claude Code with the `mappane` mod loaded, use the mod's `mcp__mappane__*` tools instead; the CLI drives the same map.
Successful commands print JSON and exit 0; errors exit 1. `<root>/mappane/bin/map-command --help` prints the syntax.
Requirements: shell access as the same user and on the same machine as the map bridge, and Node.js 24+.
Opening a split also needs macOS, Ghostty and Chrome.

## Agent setup

- Claude Code and Pi: use the normal shell tool.
- Codex: the `workspace-write` sandbox blocks the map socket (`connect EPERM`). Allow it with
  `-c sandbox_workspace_write.network_access=true`, for example
  `codex exec -s workspace-write -c sandbox_workspace_write.network_access=true '$map-pane get the extent'`.
  The same setting lets `login` listen on its loopback redirect and reach the portal.

## Open and select the map

1. Run `<root>/mappane/bin/map-command extent`. It returns the current view if a map is running.
2. If it fails with `No running map found`, run `<root>/mappane/bin/map-pane --split`. The launcher returns before the map loads.
   If `MAP_PANE_SOCKET` is set and it fails with `ENOENT` or `ECONNREFUSED`, that map stopped.
   Tell the user, unset `MAP_PANE_SOCKET` and run `extent` again before you open a split.
   If another map answers, confirm with the user that it is the intended map before you change it.
3. Retry `extent` for at most 60 seconds. Report startup errors; do not open repeated splits.

Do not run `<root>/mappane/bin/map-pane` without `--split`: it takes over the current terminal in raw mode.
An extent has bounds and a spatial reference; the coordinates are not necessarily longitude/latitude.

Start view, set on the launcher (for example `MAP_PANE_CENTER=51.5074,-0.1278 MAP_PANE_ZOOM=10 <root>/mappane/bin/map-pane --split`):
`MAP_PANE_BASEMAP` (legacy id, default `osm`), `MAP_PANE_CENTER` (`latitude,longitude`),
`MAP_PANE_ZOOM` (0–23, default 3, needs a center), `MAP_PANE_EXTENT` (`xmin,ymin,xmax,ymax` in
longitude/latitude; overrides center and zoom). None set: the world on `osm`. A bad value stops the launcher.

The CLI targets the newest map bridge of the current user. If several maps run, identify the intended one
and set its socket, `<Node tmpdir>/map-pane-command-<uid>-<server-pid>.sock`, on every command:
`MAP_PANE_SOCKET=/absolute/path.sock <root>/mappane/bin/map-command extent`. `<root>/mappane/bin/map-command --info` prints the
page URL of the targeted map. Every page of one bridge shows the same map.

## Commands

| Request | Command |
|---|---|
| List basemaps (no running map needed) | `<root>/mappane/bin/map-command basemaps` |
| Set a basemap | `<root>/mappane/bin/map-command basemap osm` |
| Set a basemap style (after `login`) | `<root>/mappane/bin/map-command basemap arcgis/dark-gray` |
| Sign in to an ArcGIS portal | `<root>/mappane/bin/map-command login [--portal-url URL] [--client-id ID] [--redirect-uri URI]` |
| Read the current extent | `<root>/mappane/bin/map-command extent` |
| Go to a country, state, city, ZIP code or address | `<root>/mappane/bin/map-command go_to location 'Austin, Texas'` |
| Go to latitude, longitude, optional zoom | `<root>/mappane/bin/map-command go_to coordinate 30.2672 -97.7431 12` |
| Load a map service | `<root>/mappane/bin/map-command map-service URL` |
| Load a feature service | `<root>/mappane/bin/map-command feature-service URL` |
| Load GeoJSON from a URL | `<root>/mappane/bin/map-command geojson URL` |
| Load a GeoPackage, or one table | `<root>/mappane/bin/map-command geopackage URL ['table name']` |
| Add GeoJSON (file, `-` for stdin, or inline) | `<root>/mappane/bin/map-command graphics ./f.geojson --title 'Name' [--renderer JSON] [--labels JSON]` |
| Zoom to all layers, or one | `<root>/mappane/bin/map-command zoom [LAYER_ID]` |
| Save a PNG of the map view | `<root>/mappane/bin/map-command screenshot ./map.png` |
| Remove all layers, keep the basemap | `<root>/mappane/bin/map-command clear` |
| Save a private web map item (after `login`) | `<root>/mappane/bin/map-command save-webmap 'Title'` |

- Quote URLs, paths and place names. URLs must be HTTP(S). A FeatureServer root loads all its layers; a numbered URL loads one.
- Basemaps: `legacy` ids work without sign-in. `styles` ids (`arcgis/*`, `osm/*`, `open/*`) need `login`,
  else they fail with `needs a sign-in`. Other ids are rejected.
- `go_to`: coordinates are WGS84 decimal degrees, latitude first. Omit zoom to keep the current zoom.
  Locations go to Esri's World Geocoding service; the result has the matched address, score and extent.
  Qualify ambiguous places and check the match. Layers are kept.
- `--renderer` and `--labels` take a file or inline JSON in SDK autocast form, for example
  `{"type":"class-breaks","field":"zscore","classBreakInfos":[{"minValue":-9,"maxValue":0,"symbol":{"type":"simple-marker","color":"#2c7bb6"}}]}`.
  To color by a value, compute it as a GeoJSON property first. Field names follow the
  safe field-name rules (`<root>/docs/standalone.md`, "Safe field names") (reserved names, collisions).
- Labels example: `--labels '{"labelExpressionInfo":{"expression":"$feature.name"}}'`.
- Give every `graphics` layer a `--title`; it is the legend heading. Only `graphics` accepts `--title`. Run `zoom` after adding data:
  adding data keeps the current extent, so new data can be off screen.
- Pass generated JSON through stdin or a quoted heredoc (`<root>/mappane/bin/map-command graphics - <<'EOF'`).
  Do not interpolate untrusted JSON into shell text.

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
- `login` prints the sign-in URL on stderr, opens the browser on macOS and waits up to 5 minutes.
  Use a shell timeout of at least 300 seconds, or run it in the background. Give the URL to the user.
  Do not start a second `login` while one waits.
- The token lives in the open map pages only, never in the saved map: a bridge restart or page reload loses it; run `login` again.
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

More: `<root>/docs/standalone.md` (guide), `<root>/docs/architecture.md`.

## Close the map

There is no close command. Send Ctrl-C to the intended map split, or SIGINT to that split's `pane.mjs` process.
The launcher closes the split, and stops the bridge if it started one (a running bridge, such as the Claude Code mod's, stays). Identify the exact PID first; broad Node or Chrome
matches can kill unrelated work.
