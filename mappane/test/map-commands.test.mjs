import assert from "node:assert/strict";
import { test } from "node:test";
import { portalBasemaps, runMapCommand } from "../web/map-commands.js";

test("portal basemaps need a sign-in", async () => {
  assert.equal(await portalBasemaps(), undefined);
});

test("go_to takes only a location here and validates it", async () => {
  const view = { goTo: async () => assert.fail("must not move"), extent: { toJSON: () => ({}) } };
  await assert.rejects(runMapCommand(view, { command: "go_to", mode: "coordinate", latitude: 30, longitude: -97 }), /takes a location/);
  await assert.rejects(runMapCommand(view, { command: "go_to", mode: "location", location: " " }), /go_to/);
});

test("go_to geocodes the best location, fits its extent, and reports no matches or service failures", async (t) => {
  const previous = globalThis.$arcgis;
  t.after(() => { globalThis.$arcgis = previous; });
  const extent = { xmin: -98, ymin: 30, xmax: -97, ymax: 31, spatialReference: { wkid: 4326 } };
  let candidates = [{ address: "Austin, Texas", score: 100, location: { x: -97.74, y: 30.27 }, extent }];
  let navigated = 0;
  globalThis.$arcgis = { import: async (name) => {
    assert.equal(name, "@arcgis/core/rest/locator.js");
    return { addressToLocations: async (url, params) => {
      assert.equal(url, "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer");
      assert.deepEqual(params, { address: { SingleLine: "Austin" }, maxLocations: 1, outSpatialReference: { wkid: 4326 } });
      if (candidates instanceof Error) throw candidates;
      return candidates;
    } };
  } };
  const view = { extent: { toJSON: () => extent }, goTo: async (target) => {
    assert.deepEqual(target, extent);
    navigated++;
  } };
  const input = { command: "go_to", mode: "location", location: " Austin " };
  assert.deepEqual(await runMapCommand(view, input), { address: "Austin, Texas", score: 100, extent });
  candidates = [];
  await assert.rejects(runMapCommand(view, input), /No location found/);
  candidates = new Error("Geocoder unavailable");
  await assert.rejects(runMapCommand(view, input), /Geocoder unavailable/);
  assert.equal(navigated, 1);
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

test("save-webmap needs a sign-in, saves service layers with saveAs and embeds client-side layers in map order", async (t) => {
  const previous = globalThis.$arcgis;
  t.after(() => { globalThis.$arcgis = previous; });
  const json = (value) => ({ toJSON: () => value, clone: () => value });
  const local = { id: "local", title: "Wells", type: "feature", opacity: 1, visible: true, geometryType: "point", objectIdField: "__oid",
    fields: [json({ name: "__oid", type: "esriFieldTypeOID" })], renderer: json({ type: "simple" }), definitionExpression: "__oid > 1",
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
  assert.equal(layerDefinition.definitionExpression, "__oid > 1");
  assert.deepEqual(featureSet.features, [{ geometry: { x: 1, y: 2 }, attributes: { __oid: 1 } }]);
});

test("a login that arrives expired renews the token before it answers; a renewal with no lifetime is refused", async (t) => {
  const previous = { arcgis: globalThis.$arcgis, fetch: globalThis.fetch, error: console.error };
  t.after(() => { globalThis.$arcgis = previous.arcgis; globalThis.fetch = previous.fetch; console.error = previous.error; });
  const registered = [];
  globalThis.$arcgis = { import: async () => ({ registerToken: ({ token }) => registered.push(token) }) };
  let answer = { access_token: "new", expires_in: 3600 };
  let calls = 0;
  globalThis.fetch = async (url, { body }) => {
    calls++;
    assert.equal(url, "https://portal.example.com/sharing/rest/oauth2/token");
    assert.equal(body.get("refresh_token"), "r");
    return { status: 200, json: async () => answer };
  };
  const login = { command: "login", portalUrl: "https://portal.example.com", clientId: "c", token: "old", userId: "u", refreshToken: "r", expires: Date.now() - 1000 };
  await runMapCommand({}, login);
  assert.deepEqual(registered, ["old", "new"]);
  // No expires_in: the old code set a NaN timer, which fires at once and repeats.
  const errors = [];
  console.error = (...parts) => errors.push(parts.join(" "));
  answer = { access_token: "newer" };
  await runMapCommand({}, login);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(registered, ["old", "new", "old"]);
  assert.equal(calls, 2, "one renewal for each login, no retry loop");
  assert.match(errors[0], /token refresh failed/);
  // Leaves no timer behind for the tests that follow.
  await runMapCommand({}, { ...login, refreshToken: undefined, expires: Date.now() + 3_600_000 });
});

// Runs after the save-webmap test signed in: the sign-in is module state.
test("after a sign-in, portal basemaps list the portal's gallery by item id", async (t) => {
  const previous = globalThis.$arcgis;
  t.after(() => { globalThis.$arcgis = previous; });
  let portalUrl;
  globalThis.$arcgis = { import: async (name) => {
    if (name.endsWith("IdentityManager.js")) return { registerToken: () => {} };
    assert.ok(name.endsWith("Portal.js"));
    return class {
      constructor({ url }) { portalUrl = url; }
      async load() {}
      async fetchBasemaps() { return [{ title: "Topographic", portalItem: { id: "a".repeat(32) } }]; }
    };
  } };
  await runMapCommand({}, { command: "login", portalUrl: "https://portal.example.com/portal/", clientId: "c", token: "t", expires: Date.now() + 3_600_000, userId: "u" });
  assert.deepEqual(await portalBasemaps(), [{ id: "a".repeat(32), title: "Topographic" }]);
  assert.equal(portalUrl, "https://portal.example.com/portal");
});
