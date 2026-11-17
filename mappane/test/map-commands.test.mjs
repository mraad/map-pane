import assert from "node:assert/strict";
import { test } from "node:test";
import { runMapCommand } from "../web/map-commands.js";

test("go_to coordinates preserve zoom unless supplied and validate direct requests", async () => {
  const calls = [];
  const view = { goTo: async (...args) => calls.push(args), extent: { toJSON: () => ({ xmin: 1 }) } };
  const input = { command: "go_to", mode: "coordinate", latitude: 30, longitude: -97 };
  assert.deepEqual(await runMapCommand(view, input), { extent: { xmin: 1 } });
  await runMapCommand(view, { ...input, zoom: 0 });
  assert.deepEqual(calls.map(([target]) => target), [{ center: [-97, 30] }, { center: [-97, 30], zoom: 0 }]);
  for (const invalid of [{ latitude: 91 }, { longitude: "-97" }, { zoom: null }, { zoom: -1 }, { mode: "bad" }]) {
    await assert.rejects(runMapCommand(view, { ...input, ...invalid }), /go_to/);
  }
  await assert.rejects(runMapCommand(view, { command: "go_to", mode: "location", location: " " }), /go_to/);
  assert.equal(calls.length, 2);
});

test("go_to geocodes the best location, fits its extent, and reports no matches or service failures", async (t) => {
  const previous = globalThis.$arcgis;
  t.after(() => { globalThis.$arcgis = previous; });
  const controller = new AbortController();
  const extent = { xmin: -98, ymin: 30, xmax: -97, ymax: 31, spatialReference: { wkid: 4326 } };
  let candidates = [{ address: "Austin, Texas", score: 100, location: { x: -97.74, y: 30.27 }, extent }];
  let navigated = 0;
  globalThis.$arcgis = { import: async (name) => {
    assert.equal(name, "@arcgis/core/rest/locator.js");
    return { addressToLocations: async (url, params, options) => {
      assert.equal(url, "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer");
      assert.deepEqual(params, { address: { SingleLine: "Austin" }, maxLocations: 1, outSpatialReference: { wkid: 4326 } });
      assert.equal(options.signal, controller.signal);
      if (candidates instanceof Error) throw candidates;
      return candidates;
    } };
  } };
  const view = { extent: { toJSON: () => extent }, goTo: async (target, options) => {
    assert.deepEqual(target, extent);
    assert.equal(options.signal, controller.signal);
    navigated++;
  } };
  const input = { command: "go_to", mode: "location", location: " Austin " };
  assert.deepEqual(await runMapCommand(view, input, controller.signal), { address: "Austin, Texas", score: 100, extent });
  candidates = [];
  await assert.rejects(runMapCommand(view, input, controller.signal), /No location found/);
  candidates = new Error("Geocoder unavailable");
  await assert.rejects(runMapCommand(view, input, controller.signal), /Geocoder unavailable/);
  assert.equal(navigated, 1);
});

test("cancelled geocoding cannot navigate after a late response", async (t) => {
  const previous = globalThis.$arcgis;
  t.after(() => { globalThis.$arcgis = previous; });
  let resolveMatch, started;
  const ready = new Promise((ok) => { started = ok; });
  globalThis.$arcgis = { import: async () => ({ addressToLocations: () => {
    started();
    return new Promise((ok) => { resolveMatch = ok; });
  } }) };
  let navigated = false;
  const controller = new AbortController();
  const pending = runMapCommand({ goTo: () => { navigated = true; } }, {
    command: "go_to", mode: "location", location: "Texas",
  }, controller.signal);
  await ready;
  const rejected = assert.rejects(pending, /deadline/);
  controller.abort(new Error("deadline"));
  await rejected;
  resolveMatch([{ location: { x: 1, y: 2 } }]);
  await new Promise((ok) => setImmediate(ok));
  assert.equal(navigated, false);
});

test("graphics preserve properties while assigning unique safe field names", async (t) => {
  const previous = globalThis.$arcgis;
  t.after(() => { globalThis.$arcgis = previous; });
  class FeatureLayer {
    constructor(options) { Object.assign(this, options); }
    createPopupTemplate() { return {}; }
    async load() {}
  }
  globalThis.$arcgis = { import: async () => FeatureLayer };
  let layers;
  const properties = { "a-b": 1, "a b": 2, __oid: 3, "1st": 4, "": 5, absent: null };
  const original = structuredClone(properties);
  await runMapCommand({ map: { addMany: (value) => { layers = value; } } }, {
    command: "graphics", data: { type: "Feature", properties, geometry: { type: "Point", coordinates: [1, 2] } },
  });
  assert.deepEqual(layers[0].fields.map(({ name }) => name), ["__oid", "a_b", "a_b_", "__oid_", "_1st", "field"]);
  assert.deepEqual(layers[0].source[0].attributes, { __oid: 1, a_b: 1, a_b_: 2, __oid_: 3, _1st: 4, field: 5 });
  assert.deepEqual(properties, original);
});

test("a stalled service lookup releases the next command and cannot add a layer later", { timeout: 5000 }, async (t) => {
  const previous = globalThis.$arcgis;
  t.after(() => { globalThis.$arcgis = previous; });
  let resolveMetadata, destroyed = false, added = false;
  const metadata = new Promise((ok) => { resolveMetadata = ok; });
  globalThis.$arcgis = { import: async () => ({ fromArcGISServerUrl: () => metadata }) };
  const view = { extent: { toJSON: () => ({ xmin: 1 }) }, map: { add: () => { added = true; } } };
  const controller = new AbortController();
  const command = runMapCommand(view, { command: "feature-service", url: "https://example.com/FeatureServer" }, controller.signal);
  const next = command.catch(() => {}).then(() => runMapCommand(view, { command: "extent" }));
  const rejected = assert.rejects(command, /deadline/);
  controller.abort(new Error("deadline"));
  await rejected;
  assert.deepEqual(await next, { xmin: 1 });
  resolveMetadata({ load: async () => {}, destroy: () => { destroyed = true; } });
  await t.waitFor(() => assert.equal(destroyed, true));
  assert.equal(added, false);
});

test("a stalled SDK import respects cancellation and cannot replace the basemap later", { timeout: 5000 }, async (t) => {
  const previous = globalThis.$arcgis;
  t.after(() => { globalThis.$arcgis = previous; });
  let resolveImport;
  const imported = new Promise((ok) => { resolveImport = ok; });
  globalThis.$arcgis = { import: () => imported };
  const view = { map: { basemap: "original" } };
  const controller = new AbortController();
  const command = runMapCommand(view, { command: "basemap", value: "osm" }, controller.signal);
  const rejected = assert.rejects(command, /deadline/);
  controller.abort(new Error("deadline"));
  await rejected;
  resolveImport({ fromId: () => { throw new Error("Cancelled work reached the SDK"); } });
  await new Promise((ok) => setImmediate(ok));
  assert.equal(view.map.basemap, "original");
});

test("clear removes and destroys operational layers and keeps the basemap", async () => {
  const destroyed = [];
  const layers = ["a", "b"].map((id) => ({ id, destroy: () => destroyed.push(id) }));
  const map = { basemap: "osm", layers, removeAll: () => layers.splice(0) };
  assert.deepEqual(await runMapCommand({ map }, { command: "clear" }), { removed: 2 });
  assert.deepEqual(destroyed, ["a", "b"]);
  assert.equal(map.layers.length, 0);
  assert.equal(map.basemap, "osm");
});

test("save-webmap needs a sign-in, saves service layers with saveAs and embeds client-side layers in map order", async (t) => {
  const previous = globalThis.$arcgis;
  t.after(() => { globalThis.$arcgis = previous; });
  const json = (value) => ({ toJSON: () => value, clone: () => value });
  const local = { id: "local", title: "Wells", type: "feature", opacity: 1, visible: true, geometryType: "point", objectIdField: "__oid",
    fields: [json({ name: "__oid", type: "esriFieldTypeOID" })], renderer: json({ type: "simple" }),
    source: { toArray: () => [{ geometry: json({ x: 1, y: 2 }), attributes: { __oid: 1 } }] } };
  const service = { id: "service", type: "map-image", url: "https://example.com/MapServer", clone: () => "service-clone" };
  let layers = [local, service];
  const view = { map: { layers: { toArray: () => layers }, basemap: json("basemap") }, viewpoint: json("viewpoint"), spatialReference: json("sr") };
  let created, updated;
  globalThis.$arcgis = { import: async (name) => {
    if (name.endsWith("IdentityManager.js")) return { registerToken: () => {} };
    if (name.endsWith("Portal.js")) return class { constructor({ url }) { this.url = url; } async load() {} };
    return class WebMap {
      constructor(props) { created = props; }
      async updateFrom(target) { assert.equal(target, view); }
      async saveAs({ title, portal }) {
        return { id: "item1", title, owner: "me", access: "private", portal,
          fetchData: async () => ({ operationalLayers: [{ id: "service-saved" }] }), update: async ({ data }) => { updated = data; } };
      }
    };
  } };
  const input = { command: "save-webmap", title: "Wells" };
  await assert.rejects(runMapCommand(view, input), /needs a sign-in/);
  await runMapCommand(view, { command: "login", portalUrl: "https://portal.example.com/", clientId: "c", token: "t", expires: Date.now() + 3_600_000, userId: "me" });
  layers = [{ title: "Mixed", type: "graphics" }];
  await assert.rejects(runMapCommand(view, input), /Mixed has mixed geometry/);
  layers = [local, service];
  assert.deepEqual(await runMapCommand(view, input), {
    id: "item1", title: "Wells", owner: "me", access: "private", layers: 2, url: "https://portal.example.com/home/item.html?id=item1",
  });
  assert.deepEqual(created.layers, ["service-clone"]);
  assert.deepEqual(updated.operationalLayers.map((layer) => layer.id), ["local", "service-saved"]);
  const [{ layerDefinition, featureSet }] = updated.operationalLayers[0].featureCollection.layers;
  assert.equal(layerDefinition.geometryType, "esriGeometryPoint");
  assert.deepEqual(featureSet.features, [{ geometry: { x: 1, y: 2 }, attributes: { __oid: 1 } }]);
});
