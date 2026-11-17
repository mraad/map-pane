// End to end without a terminal: real server, real headless Chrome, real SDK from the CDN.
// Terminal input bytes go through parseInput and toCdp, the same path pane.mjs uses.
// Needs network access and Chrome.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { serverUrl } from "./helpers/server-url.mjs";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { join } from "node:path";
import { parseInput, toCdp } from "../pane/lib.mjs";
import { openPage } from "../pane/pane.mjs";
import { commandSocket, request, sendCommand, toOp } from "../cli/command.mjs";

const ROOT = join(import.meta.dirname, "..");
let server, page, firstFrame;
const acks = new Set();
const LEGEND_SHOWN = "document.querySelector('arcgis-legend').checkVisibility()";

const evaluate = async (expression) =>
  (await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

const until = (t, expression, what) =>
  t.waitFor(async () => assert.ok(await evaluate(expression), what), { interval: 200, timeout: 30_000 });

const type = async (bytes) => {
  for (const ev of parseInput(bytes)) for (const [method, params] of toCdp(ev, 1)) await page.send(method, params);
};

before(async (t) => {
  server = spawn(process.execPath, [join(ROOT, "web/server.mjs")], { env: {
    ...process.env, PORT: "0", MAP_PANE_BASEMAP: "osm", MAP_PANE_CENTER: "38.90,-77.03", MAP_PANE_ZOOM: "10", MAP_PANE_EXTENT: "",
  } });
  const url = await serverUrl(server);
  page = await openPage(`${url}#e2e`);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  page.on("Page.screencastFrame", ({ data, sessionId }) => {
    firstFrame ??= data;
    const ack = page.send("Page.screencastFrameAck", { sessionId });
    acks.add(ack);
    ack.then(() => acks.delete(ack), () => {});
  });
  await page.send("Page.startScreencast", { format: "png" });
  await until(t, "window.view?.ready && !window.view.updating", "map view ready");
});

after(async () => {
  try {
    await page?.send("Page.stopScreencast");
    await Promise.all(acks);
  } finally {
    page?.close();
    server?.kill();
  }
});

test("the page loads ArcGIS Maps SDK 5.2.2 with zoom and a hidden legend", async () => {
  // The 5.2.2 CDN release reports fullVersion "5.2.1" in its core kernel, so check the load URL.
  assert.ok(await evaluate("performance.getEntriesByType('resource').some((e) => e.name.startsWith('https://js.arcgis.com/5.2.2/core'))"));
  assert.equal(await evaluate("$arcgis.import('@arcgis/core/kernel.js').then((k) => k.version)"), "5.2");
  assert.equal(await evaluate("location.hash"), "#e2e");
  assert.deepEqual(await evaluate("[...document.querySelector('arcgis-map').children].map((e) => e.localName)"), ["arcgis-zoom", "arcgis-legend"]);
  assert.equal(await evaluate(LEGEND_SHOWN), false);
  // The start view follows MAP_PANE_BASEMAP, MAP_PANE_CENTER and MAP_PANE_ZOOM from the server environment.
  const [basemap, latitude, longitude, zoom] = await evaluate("[view.map.basemap.id, view.center.latitude, view.center.longitude, view.zoom]");
  assert.equal(basemap, "osm");
  assert.ok(Math.abs(latitude - 38.9) < 0.01 && Math.abs(longitude + 77.03) < 0.01 && zoom === 10, `${latitude},${longitude} z${zoom}`);
});

test("the screencast sends PNG frames", () => {
  assert.ok(firstFrame?.startsWith("iVBOR"), "first frame is a base64 PNG");
});

test("a terminal mouse drag pans the map", async (t) => {
  const before = await evaluate("view.center.longitude");
  let bytes = "\x1b[<0;300;300M";
  for (let x = 320; x <= 500; x += 20) bytes += `\x1b[<32;${x};300M`;
  await type(`${bytes}\x1b[<0;500;300m`);
  await until(t, `view.center.longitude < ${before} - 0.05`, "centre moved west");
});

test("a terminal wheel step zooms the map in", async (t) => {
  await type("\x1b[<64;400;300M");
  await until(t, "view.zoom > 10", "zoom increased");
});

test("a terminal click on the zoom-in button zooms the map in", async (t) => {
  // The wheel test's zoom animation may still run: a click during it is lost under load.
  await until(t, "view.stationary", "view settled");
  const before = await evaluate("view.zoom");
  const { x, y } = await evaluate(
    "(({ x, y, width, height }) => ({ x: x + width / 2, y: y + height / 4 }))(document.querySelector('arcgis-zoom').getBoundingClientRect())",
  );
  const at = `${Math.round(x)};${Math.round(y)}`;
  await type(`\x1b[<0;${at}M\x1b[<0;${at}m`);
  await until(t, `view.zoom > ${before} + 0.5`, `zoom increased from ${before}`);
});

// The CLI's path: a parsed command becomes a bridge op over the socket. Layer results carry layerId; tests read id.
const command = async (input) => {
  const socket = commandSocket(server.pid);
  if (input.command === "clear") return request(socket, "/clear", {});
  const result = await sendCommand(socket, toOp(input));
  return result?.layerId ? { ...result, id: result.layerId } : result;
};

test("shell commands return the current extent and change basemap", async () => {
  const extent = await command({ command: "extent" });
  assert.ok(extent.xmin < extent.xmax && extent.ymin < extent.ymax);
  assert.ok(extent.spatialReference.wkid);
  await command({ command: "basemap", value: "osm" });
  assert.equal(await evaluate("view.map.basemap.id"), "osm");
  await assert.rejects(command({ command: "basemap", value: "not-a-basemap" }), /unknown basemap/);
  assert.equal(await evaluate("view.map.basemap.id"), "osm");
});

test("mixed-geometry GeoJSON stays a GraphicsLayer with properties", async () => {
  const { layers: [layer] } = await command({ command: "graphics", data: {
    type: "FeatureCollection", features: [
      { type: "Feature", properties: { name: "DC" }, geometry: { type: "Point", coordinates: [-77.03, 38.9] } },
      { type: "Feature", geometry: { type: "LineString", coordinates: [[-77.03, 38.9], [-77, 39]] } },
    ],
  } });
  assert.equal(layer.type, "graphics");
  assert.equal(layer.graphics, 2);
  const graphics = await evaluate(`view.map.findLayerById(${JSON.stringify(layer.id)}).graphics.toArray().map(g => ({type:g.geometry.type, name:g.attributes.name, symbol:g.symbol.type}))`);
  assert.deepEqual(graphics.map((g) => g.type), ["point", "polyline"]);
  assert.equal(graphics[0].name, "DC");
  assert.equal(graphics[0].symbol, "simple-marker");
  const before = await evaluate("view.map.layers.length");
  await assert.rejects(command({ command: "graphics", data: { type: "Point", coordinates: [1] } }), /Coordinates/);
  assert.equal(await evaluate("view.map.layers.length"), before);
});

test("go_to navigates coordinates and geocoded extents through the real SDK", async (t) => {
  const layers = await evaluate("view.map.layers.length");
  await command({ command: "go_to", mode: "coordinate", latitude: 30.2672, longitude: -97.7431, zoom: 12 });
  const center = await evaluate("[view.center.latitude, view.center.longitude, view.zoom]");
  assert.ok(Math.abs(center[0] - 30.2672) < 0.001 && Math.abs(center[1] + 97.7431) < 0.001);
  assert.ok(Math.abs(center[2] - 12) < 0.01);
  await command({ command: "go_to", mode: "coordinate", latitude: 34.056, longitude: -117.195 });
  assert.ok(Math.abs(await evaluate("view.zoom") - 12) < 0.01);
  // Keep geocoding deterministic while exercising the SDK's candidate decoding and navigation.
  await evaluate(`(async () => {
    const config = await $arcgis.import('@arcgis/core/config.js');
    window.geocodeFixture = { urls: 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer', before: ({ requestOptions }) => ({
      spatialReference: { wkid: 4326 },
      candidates: requestOptions.query.SingleLine === 'No match' ? [] : [{
        address: requestOptions.query.SingleLine, score: 100, location: { x: -97.74, y: 30.27 },
        extent: { xmin: -98, ymin: 30, xmax: -97, ymax: 31 }, attributes: {},
      }],
    }) };
    config.request.interceptors.push(window.geocodeFixture);
  })()`);
  t.after(() => evaluate(`$arcgis.import('@arcgis/core/config.js').then(config => {
    config.request.interceptors.splice(config.request.interceptors.indexOf(window.geocodeFixture), 1);
    delete window.geocodeFixture;
  })`));
  for (const location of ["France", "Texas", "Austin, TX", "78701", "380 New York St, Redlands, CA 92373"]) {
    const result = await command({ command: "go_to", mode: "location", location });
    assert.equal(result.address, location);
    assert.equal(result.score, 100);
    assert.ok(result.extent.xmin < result.extent.xmax);
    assert.ok(await evaluate("Math.abs(view.center.longitude + 97.5) < 0.01 && Math.abs(view.center.latitude - 30.5) < 0.01"));
  }
  const before = await evaluate("view.extent.toJSON()");
  await assert.rejects(command({ command: "go_to", mode: "location", location: "No match" }), /No location found/);
  assert.deepEqual(await evaluate("view.extent.toJSON()"), before);
  assert.equal(await evaluate("view.map.layers.length"), layers);
});

test("MapServer and FeatureServer commands load real SDK layers", { timeout: 60_000 }, async () => {
  const map = await command({ command: "map-service", url: "https://sampleserver6.arcgisonline.com/arcgis/rest/services/Census/MapServer" });
  assert.equal(map.type, "map-image");
  const features = await command({ command: "feature-service", url: "https://sampleserver6.arcgisonline.com/arcgis/rest/services/Wildfire/FeatureServer" });
  assert.equal(features.type, "group");
  assert.ok(await evaluate(`view.map.findLayerById(${JSON.stringify(features.id)}).layers.length > 0`));
  const zoomed = await command({ command: "zoom", value: features.id });
  assert.ok(zoomed.xmin < zoomed.xmax, "zoom reaches a group layer through its sublayers");
});

test("URL commands load GeoJSON and GeoPackage into real map layers", async (t) => {
  const dir = mkdtempSync("/tmp/map-url-test-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "data.gpkg");
  const db = new DatabaseSync(file);
  db.exec(readFileSync(new URL("fixtures/vector.sql", import.meta.url), "utf8"));
  db.close();
  const fixture = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    if (req.url === "/data.gpkg") res.end(readFileSync(file));
    else if (req.url === "/data.geojson") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ type: "FeatureCollection", features: [
        { type: "Feature", properties: { name: "DC" }, geometry: { type: "Point", coordinates: [-77.03, 38.9] } },
      ] }));
    } else res.writeHead(404).end();
  });
  await new Promise((ok) => fixture.listen(0, "127.0.0.1", ok));
  t.after(() => fixture.close());
  const base = `http://127.0.0.1:${fixture.address().port}`;
  const geojson = await command({ command: "geojson", url: `${base}/data.geojson` });
  assert.equal(geojson.type, "geojson");
  assert.equal(await evaluate(`view.map.findLayerById(${JSON.stringify(geojson.id)}).queryFeatureCount()`), 1);
  const { layers: [gpkg] } = await command({ command: "geopackage", url: `${base}/data.gpkg` });
  assert.equal(gpkg.type, "feature");
  assert.equal(gpkg.title, "places");
  assert.equal(gpkg.graphics, 1);
  const point = await evaluate(`view.map.findLayerById(${JSON.stringify(gpkg.id)}).source.getItemAt(0).geometry.toJSON()`);
  assert.equal(point.x, -77.03);
  assert.equal(point.y, 38.9);
  assert.equal(point.spatialReference.wkid, 4326);
  await assert.rejects(command({ command: "geopackage", url: `${base}/missing.gpkg` }), /HTTP 404/);
});

test("the legend lists added layers and clear removes them but keeps the basemap", async (t) => {
  const basemap = await evaluate("view.map.basemap.id");
  assert.ok(await evaluate("view.map.layers.length") > 0, "earlier tests added layers");
  assert.equal(await evaluate(LEGEND_SHOWN), true);
  await until(t, "document.querySelector('arcgis-legend').activeLayerInfos?.some((info) => info.layer.type === 'geojson')", "GeoJSON layer in legend");
  const { layers: [added] } = await command({ command: "graphics", data: { type: "Point", coordinates: [-77, 39] } });
  assert.ok(await evaluate(`view.map.findLayerById(${JSON.stringify(added.id)})`));
  const count = await evaluate("view.map.layers.length");
  assert.ok(count > 0);
  assert.deepEqual((await command({ command: "clear" })).state.layers, []);
  assert.equal(await evaluate("view.map.layers.length"), 0);
  assert.equal(await evaluate("view.map.basemap.id"), basemap);
  assert.equal(await evaluate(LEGEND_SHOWN), false);
  await until(t, "document.querySelector('arcgis-legend').activeLayerInfos?.length === 0", "legend cleared");
  await command({ command: "graphics", data: { type: "Point", coordinates: [-77, 39] } });
  assert.equal(await evaluate(LEGEND_SHOWN), true);
});

test("single-type GeoJSON becomes a FeatureLayer with title, renderer, labels, legend entry and popups", async (t) => {
  const sym = (color) => ({ type: "simple-marker", color, size: 8 });
  const { layers: [layer] } = await command({ command: "graphics", title: "Depth", renderer: {
    type: "class-breaks", field: "depth_m", classBreakInfos: [
      { minValue: 0, maxValue: 100, symbol: sym("blue") }, { minValue: 100, maxValue: 1000, symbol: sym("red") },
    ] }, labels: { labelExpressionInfo: { expression: "$feature.depth_m" }, symbol: { type: "text", color: "white" } }, data: { type: "FeatureCollection", features: [
    { type: "Feature", properties: { "depth m": 50, tags: ["a"] }, geometry: { type: "Point", coordinates: [3, 61] } },
    { type: "Feature", properties: { "depth m": 400, tags: null }, geometry: { type: "Point", coordinates: [5, 64] } },
  ] } });
  assert.deepEqual([layer.type, layer.title, layer.graphics], ["feature", "Depth", 2]);
  const ref = `view.map.findLayerById(${JSON.stringify(layer.id)})`;
  assert.deepEqual(await evaluate(`${ref}.fields.map((f) => [f.name, f.alias, f.type])`),
    [["__oid", "__oid", "oid"], ["depth_m", "depth m", "double"], ["tags", "tags", "string"]]);
  assert.equal(await evaluate(`${ref}.renderer.type`), "class-breaks");
  assert.deepEqual(await evaluate(`${ref}.labelingInfo.map((l) => l.labelExpressionInfo.expression)`), ["$feature.depth_m"]);
  assert.equal(await evaluate(`${ref}.labelsVisible`), true);
  assert.ok(await evaluate(`${ref}.popupTemplate.fieldInfos.some((f) => f.fieldName === "depth_m")`));
  await until(t, `document.querySelector('arcgis-legend').activeLayerInfos?.some((info) => info.layer.id === ${JSON.stringify(layer.id)})`, "FeatureLayer in legend");
  await assert.rejects(command({ command: "graphics", renderer: { type: "simple" }, data: { type: "GeometryCollection", geometries: [
    { type: "Point", coordinates: [0, 0] }, { type: "LineString", coordinates: [[0, 0], [1, 1]] },
  ] } }), /one geometry type/);
  await assert.rejects(command({ command: "graphics", labels: [{}], data: { type: "GeometryCollection", geometries: [
    { type: "Point", coordinates: [0, 0] }, { type: "LineString", coordinates: [[0, 0], [1, 1]] },
  ] } }), /Labels need features of one geometry type/);

  const extent = await command({ command: "zoom", value: layer.id });
  const [xmin, ymin] = await evaluate("[view.toMap({x: 0, y: view.height}).longitude, view.toMap({x: 0, y: view.height}).latitude]");
  assert.ok(xmin <= 3 && ymin <= 61 && extent.xmin < extent.xmax, "zoom shows the layer");
  await assert.rejects(command({ command: "zoom", value: "missing" }), /no layer with id or title "missing"/);
  const shot = await command({ command: "screenshot" });
  // The bridge saves the PNG and answers its path.
  assert.deepEqual([...readFileSync(shot.path).subarray(1, 4)].map((c) => String.fromCharCode(c)).join(""), "PNG");
  assert.ok(shot.width > 0 && shot.height > 0);
});

test("every legacy basemap id is known to the SDK and a style id without a token leaves the basemap unchanged", { timeout: 90_000 }, async () => {
  const { BASEMAPS } = await import("../web/commands.js");
  const unknown = await evaluate(`(async () => {
    const Basemap = await $arcgis.import("@arcgis/core/Basemap.js");
    return ${JSON.stringify(BASEMAPS.legacy)}.filter((id) => !Basemap.fromId(id));
  })()`);
  assert.deepEqual(unknown, []);
  await command({ command: "basemap", value: "osm" });
  const started = Date.now();
  await assert.rejects(command({ command: "basemap", value: "arcgis/dark-gray" }), /needs a sign-in \(bin\/map-command login\)/);
  assert.ok(Date.now() - started < 5000, "fails at once instead of waiting for an interactive sign-in");
  assert.equal(await evaluate("view.map.basemap.id"), "osm");
});

test("login registers the token with the SDK for the portal", async () => {
  const portalUrl = "https://portal.example.com/portal";
  const result = await command({ command: "login", portalUrl, clientId: "cid", token: "T1", expires: Date.now() + 3_600_000, userId: "u1" });
  assert.deepEqual([result.user, result.portal], ["u1", portalUrl]);
  const credential = await evaluate(`(async () => {
    const im = await $arcgis.import("@arcgis/core/identity/IdentityManager.js");
    const c = im.findCredential("${portalUrl}/sharing/rest");
    return c && { token: c.token, userId: c.userId };
  })()`);
  assert.deepEqual(credential, { token: "T1", userId: "u1" });
  await assert.rejects(command({ command: "login", portalUrl, clientId: "cid" }), /login needs/);
});

test("zoom with no layer honours filters; add_graphic polygons get ArcGIS ring order", async () => {
  const op = (name, args = {}) => sendCommand(commandSocket(server.pid), { op: name, args });
  await request(commandSocket(server.pid), "/clear", {}); // only this test's layers count for zoom-all
  const { layers: [two] } = await op("graphics", { title: "Two", data: { type: "FeatureCollection", features: [
    { type: "Feature", properties: { name: "Paris" }, geometry: { type: "Point", coordinates: [2.35, 48.86] } },
    { type: "Feature", properties: { name: "Sydney" }, geometry: { type: "Point", coordinates: [151.2, -33.87] } },
  ] } });
  await op("update_layer", { id: two.id, definitionExpression: "name = 'Paris'" });
  await op("zoom");
  const [lon, lat] = await evaluate("[view.center.longitude, view.center.latitude]");
  assert.ok(Math.abs(lon - 2.35) < 1 && Math.abs(lat - 48.86) < 1, `zoom-all shows the filtered Paris, not both: ${lon}, ${lat}`);

  // RFC 7946 order: counterclockwise exterior, clockwise hole. ArcGIS wants the opposite.
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[2, 2], [2, 8], [8, 8], [8, 2], [2, 2]];
  const { layerId } = await op("add_graphic", { geometry: { type: "Polygon", coordinates: [outer, hole] }, layer: "Donut" });
  const areas = await evaluate(`view.map.findLayerById(${JSON.stringify(layerId)}).graphics.getItemAt(0).geometry.rings
    .map((r) => r.slice(1).reduce((a, p, i) => a + r[i][0] * p[1] - p[0] * r[i][1], 0))`);
  assert.ok(areas[0] < 0 && areas[1] > 0, `exterior clockwise, hole counterclockwise: ${areas}`);
});
