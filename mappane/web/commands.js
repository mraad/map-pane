export const HELP = `extent
clear
zoom [layer-id | title]
remove <layer-id | title>
reorder <layer-id | title> <top | bottom | index>
update-layer <layer-id | title> [--title <name>] [--renderer <JSON>] [--labels <JSON>] [--filter <SQL>] [--opacity <0-1>] [--visible true|false]
go_to location <country | state | city | zipcode | address>
go_to coordinate <latitude> <longitude> [zoom]
screenshot <file.png>
basemap [list | <id>]
login [--portal-url <url>] [--client-id <id>] [--redirect-uri <uri>]
map-service <url>
feature-service <url>
geojson <url>
geopackage <url> [table]
graphics <GeoJSON> [--title <name>] [--renderer <JSON>] [--labels <JSON>]
save-webmap <title>`;
export const COMMANDS = HELP.split("\n").map((line) => line.split(" ")[0]);

// All 2D basemap ids the SDK accepts. Legacy ids need no sign-in; keyless ids are Esri raster tiles (app.js KEYLESS).
// Style ids come from https://basemapstyles-api.arcgis.com/arcgis/rest/services/styles/v2/styles/self
// and need a token (bin/map-command login) or an API key.
export const BASEMAPS = Object.freeze({
  keyless: Object.freeze(["dark-gray", "light-gray", "imagery", "topo", "streets"]),
  legacy: Object.freeze(["satellite", "hybrid", "oceans", "osm", "terrain", "dark-gray", "dark-gray-vector", "gray",
    "gray-vector", "streets", "streets-vector", "streets-night-vector", "streets-navigation-vector", "topo", "topo-vector",
    "streets-relief-vector"]),
  styles: Object.freeze([
  "arcgis/imagery", "arcgis/imagery/standard", "arcgis/imagery/labels", "arcgis/light-gray",
  "arcgis/light-gray/base", "arcgis/light-gray/labels", "arcgis/dark-gray", "arcgis/dark-gray/base",
  "arcgis/dark-gray/labels", "arcgis/navigation", "arcgis/navigation-night", "arcgis/streets",
  "arcgis/streets-night", "arcgis/streets-relief", "arcgis/streets-relief/base", "arcgis/topographic",
  "arcgis/topographic/base", "arcgis/oceans", "arcgis/oceans/base", "arcgis/oceans/labels", "arcgis/terrain",
  "arcgis/terrain/base", "arcgis/terrain/detail", "arcgis/community", "arcgis/charted-territory",
  "arcgis/charted-territory/base", "arcgis/colored-pencil", "arcgis/nova", "arcgis/modern-antique",
  "arcgis/modern-antique/base", "arcgis/midcentury", "arcgis/newspaper", "arcgis/hillshade/light",
  "arcgis/hillshade/dark", "arcgis/human-geography", "arcgis/human-geography/base",
  "arcgis/human-geography/detail", "arcgis/human-geography/labels", "arcgis/human-geography-dark",
  "arcgis/human-geography-dark/base", "arcgis/human-geography-dark/detail",
  "arcgis/human-geography-dark/labels", "arcgis/outdoor", "osm/blueprint", "osm/hybrid", "osm/hybrid/detail",
  "osm/navigation", "osm/navigation-dark", "osm/standard", "osm/standard-relief", "osm/standard-relief/base",
  "osm/streets", "osm/streets-relief", "osm/streets-relief/base", "osm/light-gray", "osm/light-gray/base",
  "osm/light-gray/labels", "osm/dark-gray", "osm/dark-gray/base", "osm/dark-gray/labels", "open/blueprint",
  "open/dark-gray", "open/dark-gray/base", "open/dark-gray/labels", "open/hybrid", "open/hybrid/detail",
  "open/light-gray", "open/light-gray/base", "open/light-gray/labels", "open/navigation",
  "open/navigation-dark", "open/streets", "open/streets-night", "open/streets-relief",
  "open/streets-relief/base", "open/osm-style", "open/osm-style-relief", "open/osm-style-relief/base"
  ]),
});

// A portal basemap is its web map item id, as `basemap list` prints it after a sign-in.
export const ITEM_ID = /^[0-9a-f]{32}$/i;

export function httpUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP(S) URL without embedded credentials");
  }
  return url.href;
}

// Start view from MAP_PANE_BASEMAP, MAP_PANE_EXTENT, MAP_PANE_CENTER and MAP_PANE_ZOOM. Unset means the world on osm.
export const WORLD = Object.freeze({ xmin: -180, ymin: -85, xmax: 180, ymax: 85 });
export function startView(env) {
  const numbers = (name, count) => {
    const parts = env[name].split(",").map((part) => (part.trim() ? Number(part) : NaN));
    if (parts.length !== count || !parts.every(Number.isFinite)) throw new Error(`${name} needs ${count} comma-separated numbers`);
    return parts;
  };
  const basemap = env.MAP_PANE_BASEMAP || "osm";
  // The map has no sign-in at startup, so style ids would fail.
  if (!BASEMAPS.legacy.includes(basemap)) throw new Error(`MAP_PANE_BASEMAP must be a legacy id: ${BASEMAPS.legacy.join(", ")}`);
  if (env.MAP_PANE_EXTENT) {
    const [xmin, ymin, xmax, ymax] = numbers("MAP_PANE_EXTENT", 4);
    if (xmin < -180 || xmax > 180 || ymin < -90 || ymax > 90 || xmin >= xmax || ymin >= ymax) {
      throw new Error("MAP_PANE_EXTENT needs xmin,ymin,xmax,ymax in longitude/latitude with xmin < xmax and ymin < ymax");
    }
    return { basemap, extent: { xmin, ymin, xmax, ymax } };
  }
  if (env.MAP_PANE_CENTER) {
    const [latitude, longitude] = numbers("MAP_PANE_CENTER", 2);
    const zoom = env.MAP_PANE_ZOOM ? numbers("MAP_PANE_ZOOM", 1)[0] : 3;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error("MAP_PANE_CENTER needs latitude (-90 to 90),longitude (-180 to 180)");
    if (zoom < 0 || zoom > 23) throw new Error("MAP_PANE_ZOOM must be between 0 and 23");
    return { basemap, center: [longitude, latitude], zoom };
  }
  if (env.MAP_PANE_ZOOM) throw new Error("MAP_PANE_ZOOM needs MAP_PANE_CENTER");
  return { basemap, extent: { ...WORLD } };
}

export function validateGoTo(input) {
  if (input.mode === "location") {
    if (typeof input.location !== "string" || !input.location.trim()) throw new Error("go_to location needs a place or address");
  } else if (input.mode === "coordinate") {
    if (!Number.isFinite(input.latitude) || Math.abs(input.latitude) > 90 ||
        !Number.isFinite(input.longitude) || Math.abs(input.longitude) > 180) {
      throw new Error("go_to coordinate needs latitude (-90 to 90) and longitude (-180 to 180)");
    }
    if (input.zoom !== undefined && (!Number.isFinite(input.zoom) || input.zoom < 0 || input.zoom > 23)) {
      throw new Error("go_to zoom must be between 0 and 23");
    }
  } else throw new Error("go_to needs location or coordinate");
  return input;
}

export function parseCommand(text) {
  const [, command, value = ""] = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
  if (["extent", "clear", "basemap", "login"].includes(command) && !value) return { command };
  if (command === "zoom") return value.trim() ? { command, value: value.trim() } : { command };
  if (command === "go_to") {
    const [, mode, target = ""] = value.match(/^(?:--)?(location|coordinate)(?:\s+([\s\S]+))?$/) ?? [];
    if (mode === "location") return validateGoTo({ command, mode, location: target.trim() });
    if (mode === "coordinate") {
      const parts = target.trim().split(/\s+/);
      if (parts.length < 2 || parts.length > 3) throw new Error("go_to coordinate needs latitude longitude [zoom]");
      const [latitude, longitude, zoom] = parts.map(Number);
      return validateGoTo({ command, mode, latitude, longitude, ...(zoom !== undefined && { zoom }) });
    }
    throw new Error("go_to needs location or coordinate");
  }
  if (["remove", "update-layer"].includes(command) && value.trim()) return { command, layer: value.trim() };
  if (command === "reorder") {
    // The position comes last, so a title may contain spaces. Index 0 is the bottom layer.
    const [, layer, position] = value.trim().match(/^(.+?)\s+(top|bottom|\d+)$/) ?? [];
    if (!layer) throw new Error("reorder needs a layer id or title, then top, bottom or an index (0 is the bottom)");
    return { command, layer, position: /^\d+$/.test(position) ? Number(position) : position };
  }
  if (command === "screenshot" && value) return { command, file: value };
  if (command === "save-webmap" && value.trim()) return { command, title: value.trim() };
  if (command === "basemap" && value === "list") return { command, list: true };
  if (command === "basemap" && value && !/\s/.test(value)) {
    if (!Object.values(BASEMAPS).some((ids) => ids.includes(value)) && !ITEM_ID.test(value)) {
      throw new Error(`Unknown basemap: ${value}. Run bin/map-command basemap list`);
    }
    return { command, value };
  }
  if (["map-service", "feature-service", "geojson"].includes(command) && value && !/\s/.test(value)) {
    return { command, url: httpUrl(value) };
  }
  if (command === "geopackage" && value) {
    const [, url, table] = value.match(/^(\S+)(?:\s+([\s\S]+))?$/);
    return { command, url: httpUrl(url), ...(table && { table }) };
  }
  if (command === "graphics" && value) return { command, data: JSON.parse(value) };
  throw new Error(`Expected a command:\n${HELP}`);
}
