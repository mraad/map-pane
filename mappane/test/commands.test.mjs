import assert from "node:assert/strict";
import { test } from "node:test";
import { BASEMAPS, WORLD, parseCommand, startView } from "../web/commands.js";
import { toGraphics } from "../web/geojson.js";

test("command parser accepts map operations and rejects invalid commands and URLs", () => {
  assert.deepEqual(parseCommand("extent"), { command: "extent" });
  assert.deepEqual(parseCommand("clear"), { command: "clear" });
  assert.deepEqual(parseCommand("zoom"), { command: "zoom" });
  assert.deepEqual(parseCommand("zoom layer-1"), { command: "zoom", value: "layer-1" });
  assert.deepEqual(parseCommand("remove  Route (geodesic) "), { command: "remove", layer: "Route (geodesic)" });
  assert.deepEqual(parseCommand("update-layer Cities"), { command: "update-layer", layer: "Cities" });
  assert.deepEqual(parseCommand("screenshot map.png"), { command: "screenshot", file: "map.png" });
  assert.deepEqual(parseCommand("basemap osm"), { command: "basemap", value: "osm" });
  assert.deepEqual(parseCommand("basemap arcgis/dark-gray"), { command: "basemap", value: "arcgis/dark-gray" });
  assert.deepEqual(parseCommand("basemap imagery"), { command: "basemap", value: "imagery" });
  assert.deepEqual(parseCommand("basemap 0123456789abcdef0123456789ABCDEF"), { command: "basemap", value: "0123456789abcdef0123456789ABCDEF" });
  assert.throws(() => parseCommand("basemap not-a-basemap"), /Unknown basemap: not-a-basemap\. Run bin\/map-command basemap list/);
  assert.deepEqual(parseCommand("basemap"), { command: "basemap" });
  assert.deepEqual(parseCommand("basemap list"), { command: "basemap", list: true });
  assert.deepEqual(parseCommand("login"), { command: "login" });
  assert.deepEqual(parseCommand("save-webmap  North Sea wells "), { command: "save-webmap", title: "North Sea wells" });
  assert.equal(new Set([...BASEMAPS.legacy, ...BASEMAPS.styles]).size, BASEMAPS.legacy.length + BASEMAPS.styles.length);
  assert.ok(BASEMAPS.styles.every((id) => /^(arcgis|osm|open)\//.test(id)) && !BASEMAPS.legacy.some((id) => id.includes("/")));
  for (const command of ["map-service", "feature-service", "geojson"]) {
    assert.deepEqual(parseCommand(`${command} https://example.com/data`), { command, url: "https://example.com/data" });
  }
  assert.deepEqual(parseCommand("geopackage https://example.com/data.gpkg my table"), {
    command: "geopackage", url: "https://example.com/data.gpkg", table: "my table",
  });
  assert.deepEqual(parseCommand('graphics {"type":"Point","coordinates":[0,1]}').data.coordinates, [0, 1]);
  for (const text of ["", "extent extra", "clear all", "zoom a b", "remove", "remove  ", "update-layer", "screenshot", "basemaps", "basemap list extra", "login extra", "save-webmap", "save-webmap  ", "geojson file:///etc/passwd", "geojson javascript:alert(1)", "geojson https://user:password@example.com", "nope", "graphics not-json"]) {
    assert.throws(() => parseCommand(text));
  }
});

test("go_to parses places and latitude-first coordinates and rejects invalid targets", () => {
  for (const location of ["France", "Texas", "Austin, TX", "78701", "380 New York St, Redlands, CA 92373"]) {
    for (const option of ["location", "--location"]) {
      assert.deepEqual(parseCommand(`go_to ${option} ${location}`), { command: "go_to", mode: "location", location });
    }
  }
  assert.deepEqual(parseCommand("go_to coordinate 30.2672 -97.7431"), {
    command: "go_to", mode: "coordinate", latitude: 30.2672, longitude: -97.7431,
  });
  assert.deepEqual(parseCommand("go_to --coordinate -90 180 0"), {
    command: "go_to", mode: "coordinate", latitude: -90, longitude: 180, zoom: 0,
  });
  for (const text of ["go_to", "go_to location", "go_to location   ", "go_to coordinate", "go_to coordinate 30",
    "go_to coordinate 30 -97 10 extra", "go_to coordinate 91 0", "go_to coordinate 0 -181",
    "go_to coordinate NaN 0", "go_to coordinate 0 Infinity", "go_to coordinate 0 0 nope",
    "go_to coordinate 0 0 -1", "go_to coordinate 0 0 24", "go_to coordinates 1 2"]) {
    assert.throws(() => parseCommand(text), /go_to/);
  }
});

test("GeoJSON becomes visible graphics with properties and 3D coordinates", () => {
  const graphics = toGraphics({ type: "FeatureCollection", features: [
    { type: "Feature", properties: { name: "DC" }, geometry: { type: "Point", coordinates: [-77.03, 38.9, 50] } },
    { type: "Feature", properties: null, geometry: null },
    { type: "Feature", geometry: { type: "GeometryCollection", geometries: [
      { type: "MultiPoint", coordinates: [[0, 0], [1, 1]] },
      { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      { type: "MultiLineString", coordinates: [[[2, 2], [3, 3]]] },
    ] } },
  ] });
  assert.equal(graphics.length, 4);
  assert.equal(graphics[0].attributes.name, "DC");
  assert.equal(graphics[0].geometry.z, 50);
  assert.deepEqual(graphics[0].geometry.spatialReference, { wkid: 4326 });
  assert.deepEqual(graphics.map((g) => g.geometry.type), ["point", "multipoint", "polyline", "polyline"]);
  assert.ok(graphics.every((g) => g.symbol));
});

test("polygon winding preserves holes and separate polygons without mutating input", () => {
  const exterior = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const hole = [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]];
  const input = { type: "MultiPolygon", coordinates: [[exterior, hole], [exterior]] };
  const copy = structuredClone(input);
  const [{ geometry }] = toGraphics(input, { wkid: 3857 });
  assert.deepEqual(geometry.rings, [[...exterior].reverse(), [...hole].reverse(), [...exterior].reverse()]);
  assert.deepEqual(geometry.spatialReference, { wkid: 3857 });
  assert.deepEqual(input, copy);
});

test("invalid GeoJSON is rejected before any graphics are added", () => {
  for (const data of [null, { type: "FeatureCollection", features: [null] },
    { type: "Point", coordinates: [NaN, 1] }, { type: "Point", coordinates: [1] },
    { type: "Point", coordinates: [0, 0], crs: {} },
    { type: "LineString", coordinates: [[0, 0]] },
    { type: "LineString", coordinates: [[0, 0], [1, 1, 1]] },
    { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
    { type: "CircularString", coordinates: [] }]) {
    assert.throws(() => toGraphics(data));
  }
});

test("legacy CRS declarations are rejected on features and nested geometries", () => {
  const crs = { type: "name", properties: { name: "EPSG:3857" } };
  const point = { type: "Point", coordinates: [500000, 4500000] };
  const feature = { type: "Feature", geometry: point };
  for (const data of [
    { ...feature, crs },
    { ...feature, geometry: { ...point, crs } },
    { type: "FeatureCollection", features: [{ ...feature, crs }] },
    { type: "FeatureCollection", features: [{ ...feature, geometry: { ...point, crs } }] },
    { type: "GeometryCollection", geometries: [{ type: "GeometryCollection", geometries: [{ ...point, crs }] }] },
    { ...point, crs: null },
  ]) assert.throws(() => toGraphics(data), /no crs member/);
  assert.deepEqual(toGraphics({ type: "Point", coordinates: [-77, 39] })[0].geometry.spatialReference, { wkid: 4326 });
});

test("start view comes from MAP_PANE_* variables and defaults to the world on osm", () => {
  assert.deepEqual(startView({}), { basemap: "osm", extent: WORLD });
  assert.deepEqual(startView({ MAP_PANE_BASEMAP: "dark-gray-vector", MAP_PANE_CENTER: "51.5, -0.12", MAP_PANE_ZOOM: "10" }),
    { basemap: "dark-gray-vector", center: [-0.12, 51.5], zoom: 10 });
  assert.equal(startView({ MAP_PANE_CENTER: "30,-97" }).zoom, 3);
  // The extent wins over the center and zoom.
  assert.deepEqual(startView({ MAP_PANE_EXTENT: "-10,35,30,60", MAP_PANE_CENTER: "0,0", MAP_PANE_ZOOM: "4" }),
    { basemap: "osm", extent: { xmin: -10, ymin: 35, xmax: 30, ymax: 60 } });
  for (const [env, message] of [
    [{ MAP_PANE_BASEMAP: "arcgis/dark-gray" }, /legacy id/],
    [{ MAP_PANE_BASEMAP: "nope" }, /legacy id/],
    [{ MAP_PANE_CENTER: "91,0" }, /latitude/],
    [{ MAP_PANE_CENTER: "0,181" }, /longitude/],
    [{ MAP_PANE_CENTER: "1" }, /2 comma-separated numbers/],
    [{ MAP_PANE_CENTER: "a,b" }, /2 comma-separated numbers/],
    [{ MAP_PANE_CENTER: "0,0", MAP_PANE_ZOOM: "24" }, /between 0 and 23/],
    [{ MAP_PANE_CENTER: "0,0", MAP_PANE_ZOOM: "" + "x" }, /1 comma-separated numbers/],
    [{ MAP_PANE_ZOOM: "5" }, /needs MAP_PANE_CENTER/],
    [{ MAP_PANE_EXTENT: "30,35,-10,60" }, /xmin < xmax/],
    [{ MAP_PANE_EXTENT: "-10,35,30" }, /4 comma-separated numbers/],
    [{ MAP_PANE_EXTENT: "-190,35,30,60" }, /longitude\/latitude/],
  ]) assert.throws(() => startView(env), message, JSON.stringify(env));
});
