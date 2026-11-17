# map-pane

A live web map that an agent drives from the terminal. The map is built on the ArcGIS Maps SDK for JavaScript 5.2.2.
Headless Chrome draws the map. A terminal pane shows it, and takes your mouse and keys.

You can use it in two ways. Both drive the same map:

| Use | Agent | Pane | Guide |
|---|---|---|---|
| Claude Code mod | Claude Code (tools `mcp__mappane__*`, command `/map`) | Claude Code side pane, or a browser window | [docs/mod.md](docs/mod.md) |
| Standalone | Codex, Pi, Claude Code, or you (the `map-pane` skill and `mappane/bin/map-command`) | Ghostty split (Kitty graphics), or any browser | [docs/standalone.md](docs/standalone.md) |

![The map in a Ghostty split](docs/img/ghostty-split.jpg)

## What the map does

- Adds data: GeoJSON (file, URL or inline), GeoPackage, GeoParquet, CSV, feature services, map services, tile, vector tile and imagery layers, and portal items.
- Styles data: renderers, labels and filters. GeoJSON with one geometry type gets a legend entry and popups.
- Moves the view: to a place or address (geocoded), to coordinates, or to a layer.
- Changes the basemap: keyless basemaps, all legacy ids, and basemap styles after a sign-in.
- Signs in to a portal (OAuth with PKCE) and saves the map as a private web map item.
- Saves a PNG screenshot.

The legend shows at the bottom right while the map has layers. It hides when the map is empty.

![World cities colored by population, with the legend](docs/img/cities-renderer.png)

## Requirements

- macOS, Node.js 24 or later, and Google Chrome. No npm packages.
- Network access to `js.arcgis.com` and to the basemap tile servers.
- Mod: Claude Code v2.1.287 or later.
- Ghostty split: Ghostty 1.4 or later.

## Quick start

Claude Code mod:

```
/plugin install mappane --marketplace mraad/map-pane
/map
```

Then ask Claude, for example: "go to Kuwait City and add examples/cities.geojson".

Standalone, from the repository folder:

```sh
mappane/bin/map-pane --split                       # open the map in a Ghostty split
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
Claude Code mod ──TCP + token──┐
                               ├──> bridge (mappane/web/server.mjs) ──SSE──> every open map page
bin/map-command ──Unix socket──┘          keeps a log, replays it              (mod pane, Ghostty pane, browser)
```

The bridge keeps a log of the map changes and replays it to each page that opens.
All pages show the same map. With the mod running, the CLI and the skill drive the mod's map.
Details: [docs/architecture.md](docs/architecture.md).

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
| `MAP_PANE_IDLE_MS` | `90000` | bridge | The pane's Chrome stops after this time with no pane input. |
| `MAP_PANE_FAILURE_WINDOW_MS` | `60000` | bridge | Chrome failures closer together than this count toward the limit of 3 restarts. |
| `MAP_PANE_TOKEN` | none | bridge | Token for the TCP control endpoints. The mod sets it. |
| `MAP_PANE_SESSION` | none | bridge | Saves the map log and view in `~/.claude/map-pane/sessions/<id>/`. The mod sets it. |

## Test

```sh
npm test                          # every suite (some need Chrome and network access)
claude plugin validate mappane
claude plugin test mappane        # the mod's hooks
```

## History

This repository replaces two repositories, which are now deprecated:
`mraad/claude-mod-map` (the Claude Code mod) and `mraad/ghostty-map-pane` (the Ghostty pane and CLI).

## License

MIT. ArcGIS is a trademark of Esri. This project is not affiliated with Esri.
