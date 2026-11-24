import { httpUrl, validateGoTo } from "./commands.js";
import { toGraphics } from "./geojson.js";


// The page owns the token: it registers it with the SDK and refreshes it before it expires.
// The refresh token stays in page memory only; a pane restart needs a new login.
let refreshTimer;
let activeLogin;
let signedInPortal;
async function login(IdentityManager, { portalUrl, clientId, token, expires, userId, refreshToken }) {
  if (![portalUrl, clientId, token, userId].every((v) => typeof v === "string" && v) || !Number.isFinite(expires)) {
    throw new Error("login needs portalUrl, clientId, token, expires and userId");
  }
  const portal = httpUrl(portalUrl).replace(/\/+$/, "");
  const server = `${portal}/sharing/rest`;
  const register = (token, expires) => IdentityManager.registerToken({ server, token, expires, userId, ssl: true });
  const renew = async () => {
    const response = await fetch(`${server}/oauth2/token`, { method: "POST", signal: AbortSignal.timeout(15_000), body: new URLSearchParams({
      grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, f: "json",
    }) });
    const result = await response.json();
    if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
      throw new Error(result.error?.message ?? "Token refresh returned no usable credential");
    }
    token = result.access_token;
    expires = Date.now() + result.expires_in * 1000;
  };
  const schedule = () => {
    if (refreshToken) refreshTimer = setTimeout(refresh, Math.max(expires - Date.now() - 120_000, 10_000));
  };
  const refresh = async () => {
    try {
      await renew();
      if (activeLogin !== refresh) return;
      register(token, expires);
      schedule();
    } catch (error) {
      console.error("map-pane: token refresh failed; retrying in 60 s", error.message);
      // A wake from sleep can fire the timer before the network is back: try again, not give up.
      if (activeLogin === refresh) refreshTimer = setTimeout(refresh, 60_000);
    }
  };
  if (refreshToken && expires - Date.now() < 120_000) {
    try { await renew(); } catch (error) {
      if (expires <= Date.now()) throw new Error(`Token refresh failed: ${error.message}. Run login again`);
    }
  }
  if (expires <= Date.now()) throw new Error("Token expired. Run login again");
  register(token, expires);
  clearTimeout(refreshTimer);
  activeLogin = refresh;
  schedule();
  signedInPortal = portal;
  return { user: userId, portal, expires: new Date(expires).toISOString() };
}

// Client-side FeatureLayer: listed in the legend, with popups. Field names are made SDK-safe; aliases keep the originals.
function featureLayer(FeatureLayer, { title, renderer, labels }, graphics) {
  const fields = new Map();
  const used = new Set(["__oid"]);
  for (const { attributes } of graphics) {
    for (const [key, value] of Object.entries(attributes)) {
      if (value === null || value === undefined) continue;
      const type = typeof value === "number" ? "double" : "string";
      const field = fields.get(key);
      if (field) {
        if (field.type !== type) field.type = "string";
        continue;
      }
      let name = key.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=\d)/, "_") || "field";
      while (used.has(name)) name += "_";
      used.add(name);
      fields.set(key, { name, alias: key, type });
    }
  }
  const source = graphics.map(({ geometry, attributes }, index) => {
    const values = { __oid: index + 1 };
    for (const [key, { name, type }] of fields) {
      const value = attributes[key] ?? null;
      values[name] = value === null || type === "double" || typeof value === "string" ? value : JSON.stringify(value);
    }
    return { geometry, attributes: values };
  });
  const [{ geometry, symbol }] = graphics;
  const layer = new FeatureLayer({
    title, source, objectIdField: "__oid", geometryType: geometry.type, spatialReference: geometry.spatialReference,
    hasZ: graphics.some((g) => g.geometry.hasZ || g.geometry.z !== undefined),
    fields: [{ name: "__oid", type: "oid" }, ...fields.values()],
    renderer: renderer ?? { type: "simple", symbol },
    ...(labels && { labelingInfo: [labels].flat() }),
  });
  layer.popupTemplate = layer.createPopupTemplate({ visibleFieldNames: new Set([...fields.values()].map((f) => f.name)) });
  return layer;
}

// WebMap.saveAs cannot save client-side layers (feature collections), so they are embedded in the item data.
function featureCollection(layer) {
  return {
    id: layer.id, title: layer.title, layerType: "ArcGISFeatureLayer", opacity: layer.opacity, visibility: layer.visible,
    featureCollection: { layers: [{
      layerDefinition: {
        name: layer.title, type: "Feature Layer", geometryType: GEOMETRY[layer.geometryType],
        objectIdField: layer.objectIdField, fields: layer.fields.map((field) => field.toJSON()),
        definitionExpression: layer.definitionExpression,
        drawingInfo: { renderer: layer.renderer.toJSON(), ...(layer.labelingInfo && { labelingInfo: layer.labelingInfo.map((l) => l.toJSON()) }) },
      },
      featureSet: { geometryType: GEOMETRY[layer.geometryType], features: layer.source.toArray().map((g) => ({ geometry: g.geometry.toJSON(), attributes: g.attributes })) },
      ...(layer.popupTemplate && { popupInfo: layer.popupTemplate.toJSON() }),
    }] },
  };
}
const GEOMETRY = { point: "esriGeometryPoint", multipoint: "esriGeometryMultipoint", polyline: "esriGeometryPolyline", polygon: "esriGeometryPolygon" };

const isBridgeFile = url => url && new URL(url, location.href).href.startsWith(`${location.origin}/files/`);
// A Parquet layer has no layer.url: its files are in data.urls (urls before SDK 5.1).
const list = urls => urls?.toArray?.() ?? urls ?? [];
const isBridgeLayer = layer => [layer.url, ...list(layer.data?.urls), ...list(layer.urls)].some(isBridgeFile);

async function saveWebMap(view, { title }) {
  if (typeof title !== "string" || !title.trim()) throw new Error("save-webmap needs a title");
  if (!signedInPortal) throw new Error("save-webmap needs a sign-in. Run bin/map-command login first");
  const layers = view.map.layers.toArray();
  const temporary = (view.map.allLayers ?? view.map.layers).toArray().filter(isBridgeLayer);
  if (temporary.length) throw new Error(`Cannot save layers served by the local bridge: ${temporary.map(layer => layer.title || layer.id).join(", ")}. Use a permanent URL, or import the data as GeoJSON with graphics and remove the local layer.`);
  const unsupported = layers.find((layer) => layer.type === "graphics");
  if (unsupported) throw new Error(`Layer ${unsupported.title} has mixed geometry and cannot be saved`);
  // Most SDK 5.2 layers have no clone(), and a layer added to the WebMap leaves the view's map: save their
  // web map JSON instead. Taken with the check above, before any await, so page code cannot slip a layer in.
  const operationalLayers = layers.map((layer) => (layer.type === "feature" && !layer.url ? featureCollection(layer) : layer.toJSON()));
  const [WebMap, Portal] = await Promise.all([
    $arcgis.import("@arcgis/core/WebMap.js"), $arcgis.import("@arcgis/core/portal/Portal.js"),
  ]);
  const webmap = new WebMap({ basemap: view.map.basemap.clone() });
  // Stores the view's viewpoint and a thumbnail in the item.
  await webmap.updateFrom(view);
  const portal = new Portal({ url: signedInPortal, authMode: "immediate" });
  await portal.load();
  // saveAs shares nothing: the new item is private to its owner.
  const item = await webmap.saveAs({ title: title.trim(), portal, snippet: "Saved by map-pane" });
  if (operationalLayers.length) {
    try {
      await item.update({ data: { ...(await item.fetchData()), operationalLayers } });
    } catch (error) {
      throw new Error(`Item ${item.id} was created, but adding its layers failed: ${error.message}`);
    }
  }
  return {
    id: item.id, title: item.title, owner: item.owner, access: item.access, layers: layers.length,
    url: `${portal.url}/home/item.html?id=${item.id}`,
  };
}

// The signed-in portal's basemap gallery as {id, title}, or undefined with no sign-in.
export async function portalBasemaps() {
  if (!signedInPortal) return undefined;
  const Portal = await $arcgis.import("@arcgis/core/portal/Portal.js");
  const portal = new Portal({ url: signedInPortal, authMode: "immediate" });
  await portal.load();
  return (await portal.fetchBasemaps()).map((basemap) => ({ id: basemap.portalItem?.id, title: basemap.title }));
}
export const portalUrl = () => signedInPortal;
export const portalItem = id => ({ id, ...(signedInPortal && { portal: { url: signedInPortal } }) });

// The ops that app.js delegates here: go_to location, extent, login, save-webmap, graphics.
// The bridge times commands out, so these take no AbortSignal.
export async function runMapCommand(view, input) {
  if (!input || typeof input !== "object") throw new Error("Expected a map command");
  const { command } = input;
  if (command === "extent") return view.extent.toJSON();
  if (command === "go_to") {
    // app.js moves to coordinates itself; only geocoding comes here.
    if (input.mode !== "location") throw new Error("go_to here takes a location");
    validateGoTo(input);
    const locator = await $arcgis.import("@arcgis/core/rest/locator.js");
    const [match] = await locator.addressToLocations("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer", {
      address: { SingleLine: input.location.trim() }, maxLocations: 1, outSpatialReference: { wkid: 4326 },
    });
    if (!match?.location) throw new Error(`No location found for: ${input.location}`);
    await view.goTo(match.extent ?? { target: match.location, zoom: 16 });
    return { address: match.address, score: match.score, extent: view.extent.toJSON() };
  }
  if (command === "login") {
    const IdentityManager = await $arcgis.import("@arcgis/core/identity/IdentityManager.js");
    return login(IdentityManager, input);
  }
  if (command === "save-webmap") return saveWebMap(view, input);
  if (command === "graphics") {
    const [GraphicsLayer, FeatureLayer] = await Promise.all([
      $arcgis.import("@arcgis/core/layers/GraphicsLayer.js"), $arcgis.import("@arcgis/core/layers/FeatureLayer.js"),
    ]);
    // Validate every table before changing the map.
    const items = input.layers ?? [{ data: input.data, title: input.title ?? "GeoJSON graphics", renderer: input.renderer, labels: input.labels }];
    const makeLayer = (item) => {
      const graphics = toGraphics(item.data, item.spatialReference);
      const type = graphics[0]?.geometry.type;
      if (type && graphics.every((g) => g.geometry.type === type)) return featureLayer(FeatureLayer, item, graphics);
      if (item.renderer) throw new Error("A renderer needs features of one geometry type");
      if (item.labels) throw new Error("Labels need features of one geometry type");
      // A FeatureLayer holds one geometry type; mixed input stays graphics (no legend entry).
      return new GraphicsLayer({ title: item.title, graphics });
    };
    const layers = [];
    try {
      for (const item of items) layers.push(makeLayer(item));
      // The bridge names layers, so every page that replays the log has the same ids.
      if (input.layerId) layers.forEach((layer, i) => { layer.id = layers.length > 1 ? `${input.layerId}-${i + 1}` : input.layerId; });
      await Promise.all(layers.map((layer) => layer.load()));
    } catch (error) {
      for (const layer of layers) layer.destroy();
      throw error;
    }
    view.map.addMany(layers);
    return { layers: layers.map((layer) => ({
      id: layer.id, title: layer.title, type: layer.type, graphics: (layer.source ?? layer.graphics).length,
    })) };
  }
  throw new Error(`Unknown command: ${command}`);
}
