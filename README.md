# map-pane

A live web map that an agent drives from the terminal. The map is built on the ArcGIS Maps SDK for JavaScript 5.2.2.
Headless Chrome draws the map. A terminal pane shows it, and takes your mouse and keys.

Claude Code, Codex and Pi use one skill, `map-pane`, which runs the CLI `mappane/bin/map-command`. You can run the CLI too.
The map shows in a Ghostty split (Kitty graphics) or in any browser. Guide: [docs/standalone.md](docs/standalone.md). Full manual (HTML, images inline): [docs/guide.html](docs/guide.html).

![The map in a Ghostty split](docs/img/ghostty-split.jpg)

## What the map does

- Adds data: GeoJSON (file, URL or inline), GeoPackage, GeoParquet, CSV, feature services, map services, tile, vector tile and imagery layers, and portal items.
- Styles data: renderers, labels and filters. GeoJSON with one geometry type gets a legend entry and popups.
- Moves the view: to a place or address (geocoded), to coordinates, or to a layer.
- Changes the basemap: keyless basemaps, all legacy ids, and basemap styles after a sign-in.
- Signs in to a portal (OAuth with PKCE) and saves the map as a private web map item.
- Saves a PNG screenshot.
- Runs JavaScript in the map page (`map-command js`), for queries, statistics, calculated renderers, popups and geometry operations: [docs/run-js.md](docs/run-js.md).

The legend shows at the bottom right while the map has layers. It hides when the map is empty.

![World cities colored by population, with the legend](docs/img/cities-renderer.png)

## Requirements

- macOS, Linux or Windows and Node.js 24.2 or later. Browser mode uses your default browser. Terminal mode needs Chrome or Chromium. No npm packages. Windows runs the browser map only: see [docs/windows.md](docs/windows.md).
- Network access to `js.arcgis.com` and to the basemap tile servers.
- Automatic Ghostty splits on macOS and tabs on Linux require Ghostty 1.4 or later. Start Ghostty before using `--tab` on Linux, or use `--browser`.

## Quick start

Claude Code, from any folder:

```
/plugin install map-pane --marketplace mraad/map-pane
/map-pane:map-pane go to Kuwait City and add examples/cities.geojson
```

In a clone of this repository, Claude Code finds the skill without an install: `/map-pane go to Kuwait City`.
Or ask in plain words.

The CLI, from the repository folder:

```sh
mappane/bin/map-pane --split                       # macOS Ghostty split
mappane/bin/map-pane --tab                         # Linux Ghostty tab (1.4+)
mappane/bin/map-pane --browser                     # or in the default browser (--close stops it)
mappane/bin/map-command go_to location 'Paris, France'
mappane/bin/map-command graphics examples/cities.geojson --title Cities --renderer examples/population-renderer.json
```

Codex, from any folder:

```sh
codex plugin marketplace add mraad/map-pane && codex plugin add map-pane@map-pane
codex exec -s workspace-write -c sandbox_workspace_write.network_access=true '$map-pane go to Austin, Texas'
```

Pi, from any folder:

```sh
pi install git:github.com/mraad/map-pane
pi -p '/skill:map-pane go to Austin, Texas'
```

## One map, many doors

```
skill ──> bin/map-command ──Unix socket──> bridge (mappane/web/server.mjs) ──SSE──> every open map page
                                                keeps a log, replays it              (Ghostty pane, browser)
```

The bridge keeps a log of the map changes and replays it to each page that opens.
All pages show the same map. The log lives in memory: a new bridge starts with an empty map.
Node code can call the same commands: `import { run } from "map-pane"`. Claude Code code mode chains them in one REPL script through `$`.
Both: [docs/code-mode.md](docs/code-mode.md).
Details: [docs/architecture.md](docs/architecture.md). JavaScript in the map: [docs/run-js.md](docs/run-js.md).

## Environment variables

All are optional, except `MAP_PANE_CLIENT_ID` for `login`.

| Variable | Default | Read by | Purpose |
|---|---|---|---|
| `MAP_PANE_BASEMAP` | `osm` | launcher | Start basemap. Legacy ids only. |
| `MAP_PANE_CENTER` | none | launcher | Start center, `latitude,longitude`. |
| `MAP_PANE_ZOOM` | `3` | launcher | Start zoom, 0 to 23. Needs `MAP_PANE_CENTER`. |
| `MAP_PANE_EXTENT` | the world | launcher | Start extent, `xmin,ymin,xmax,ymax` in longitude/latitude. Overrides center and zoom. |
| `MAP_PANE_DPR` | `2` | Ghostty pane | Terminal pixels for each CSS pixel. Use `1` on a display that is not Retina. |
| `CHROME` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | panes | Chrome binary. `chrome-headless-shell` also works. |
| `MAP_PANE_SOCKET` | the newest map | CLI | The bridge socket to send commands to. |
| `MAP_PANE_PORTAL_URL` | `https://www.arcgis.com` | `login` | Portal to sign in to. |
| `MAP_PANE_CLIENT_ID` | none | `login` | OAuth client ID. Required for `login`. |
| `MAP_PANE_REDIRECT_URI` | `http://127.0.0.1:8766/` | `login` | OAuth redirect URI. It must be registered on the client ID. |
| `MAP_PANE_OPEN` | on | `login` | `0` stops `login` from opening the browser on macOS. |
| `MAP_PANE_TIMEOUT_MS` | `15000` | bridge | Command timeout. Adding data waits 60 s. |
| `MAP_PANE_TOKEN` | none | bridge | When set, the TCP control endpoints (`/cmd`, `/clear`) need it in `x-map-pane-token`. The socket never does. |

## Test

```sh
npm test                          # every suite (some need Chrome and network access)
claude plugin validate .
```

## History

This repository replaces two repositories, which are now deprecated:
`mraad/claude-mod-map` (the Claude Code mod) and `mraad/ghostty-map-pane` (the Ghostty pane and CLI).
Version 0.5.0 removed the Claude Code mod (`mappane`, `/map`, tools `mcp__mappane__*`): Claude Code now uses the skill, like Codex and Pi.

## License

MIT. ArcGIS is a trademark of Esri. This project is not affiliated with Esri.
