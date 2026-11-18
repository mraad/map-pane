// The map page: runs the bridge's commands one at a time (SSE /events -> POST /ack). No build step.
import { portalBasemaps, portalUrl, runMapCommand } from './map-commands.js'
import { BASEMAPS, ITEM_ID } from './commands.js'
import { toGraphics } from './geojson.js'

const [Graphic, GraphicsLayer, reactiveUtils, IdentityManager] = await Promise.all(
  ['Graphic', 'layers/GraphicsLayer', 'core/reactiveUtils', 'identity/IdentityManager'].map(m => $arcgis.import(`@arcgis/core/${m}.js`)),
)
// Layer classes load on first use: a map with only graphics never fetches them.
const use = m => $arcgis.import(`@arcgis/core/layers/${m}.js`)

// The bridge reads the start view from MAP_PANE_* variables; see startView in commands.js.
const start = await (await fetch('/api/start')).json()
const mapEl = document.querySelector('arcgis-map')
mapEl.basemap = start.basemap
if (start.extent) mapEl.extent = { ...start.extent, spatialReference: { wkid: 4326 } }
else Object.assign(mapEl, { center: start.center, zoom: start.zoom })
await mapEl.viewOnReady()
const view = mapEl.view
const map = mapEl.map
window.view = view // the end-to-end tests read the map state through this
const badge = document.getElementById('badge')
// Inside the Kitty pane the map stays clear of the badge.
if (new URLSearchParams(location.search).has('embedded')) badge.hidden = true

// The legend tracks map.layers itself; show it only while operational layers exist.
const legend = document.querySelector('arcgis-legend')
const showLegend = () => { legend.hidden = map.layers.length === 0 }
map.layers.on('change', showLegend)
showLegend()

// The bridge names each new layer (layerId), so every page that replays the log has the same ids.
function graphicsLayer(title, id) {
  let layer = map.layers.find(l => l.type === 'graphics' && l.title === title)
  if (!layer) {
    layer = new GraphicsLayer({ id, title })
    map.add(layer)
  }
  return layer
}

function snapshot() {
  return {
    layers: map.layers.toArray().map(l => ({
      id: l.id,
      title: l.title ?? l.id,
      type: l.type,
      ...(l.type === 'graphics' ? { count: l.graphics.length } : {}),
      ...(l.visible ? {} : { visible: false }),
    })),
    center: [+view.center.longitude.toFixed(5), +view.center.latitude.toFixed(5)],
    zoom: Math.round(view.zoom * 10) / 10,
  }
}

// Basemaps that need no API key: Esri raster tiles from services.arcgisonline.com, [base, labels].
const TILES = 'https://services.arcgisonline.com/arcgis/rest/services'
const KEYLESS = {
  'dark-gray': ['Canvas/World_Dark_Gray_Base', 'Canvas/World_Dark_Gray_Reference'],
  'light-gray': ['Canvas/World_Light_Gray_Base', 'Canvas/World_Light_Gray_Reference'],
  imagery: ['World_Imagery', 'Reference/World_Boundaries_and_Places'],
  topo: ['World_Topo_Map'],
  streets: ['World_Street_Map'],
}

const abs = u => new URL(u, location.href).href
const needUrl = a => {
  if (a.missing) throw new Error(a.missing)
  if (!a.url) throw new Error(`${a.type} layer needs url, path or data`)
  return abs(a.url)
}
const byUrl = m => async a => new (await use(m))({ url: needUrl(a) })
const LAYER_TYPES = {
  // A FeatureServer root becomes a group of all its layers; a numbered URL one layer.
  feature: async a => (await use('Layer')).fromArcGISServerUrl({ url: needUrl(a) }),
  geojson: byUrl('GeoJSONLayer'),
  csv: byUrl('CSVLayer'),
  tile: byUrl('TileLayer'),
  'vector-tile': byUrl('VectorTileLayer'),
  imagery: byUrl('ImageryLayer'),
  'map-image': byUrl('MapImageLayer'),
  parquet: async a => {
    if (a.missing) throw new Error(a.missing)
    const urls = [a.url, ...(a.urls ?? [])].filter(Boolean).map(abs)
    if (!urls.length) throw new Error('parquet layer needs url, urls or path')
    const [ParquetLayer, ParquetFilesData, parquetUtils] = await Promise.all([
      use('ParquetLayer'), use('support/ParquetFilesData'), use('support/parquetUtils'),
    ])
    const info = await parquetUtils.getParquetLayerInfo(new ParquetFilesData({ urls })).catch(err => {
      throw new Error(`layer failed to load: ${err.message}`)
    })
    // GeoParquet without a `crs` means OGC:CRS84 (GDAL writes none for WGS84), but SDK 5.2 then reads the geometry
    // with no spatial reference and every query fails ("reading 'toJSON'"). Default only a missing one: a layer-level
    // spatialReference would override a file's own `crs`.
    return new ParquetLayer({ ...info, spatialReference: info.spatialReference ?? { wkid: 4326 } })
  },
  'portal-item': async a => {
    if (!a.itemId) throw new Error('portal-item needs itemId')
    return (await use('Layer')).fromPortalItem({ portalItem: { id: a.itemId } })
  },
}

// Properties add_layer and update_layer set; one a layer does not have is an error, not a silent no-op.
const PROPERTIES = ['title', 'opacity', 'visible', 'renderer', 'definitionExpression', 'labelingInfo']
function setProperties(layer, args) {
  for (const key of PROPERTIES) {
    if (args[key] === undefined) continue
    if (!(key in layer)) throw new Error(`a ${layer.type} layer has no ${key}`)
  }
  for (const key of PROPERTIES) if (args[key] !== undefined) layer[key] = args[key]
  if (args.labelingInfo !== undefined && 'labelsVisible' in layer) layer.labelsVisible = true
}

// fullExtent is the whole service; queryExtent honours definitionExpression (feature, GeoJSON, CSV, Parquet).
async function extentOf(layer) {
  if (layer.type === 'graphics') return layer.graphics.toArray()
  // A FeatureServer root is a group: go to its sublayers (one without an extent is skipped).
  if (layer.type === 'group') {
    const parts = (await Promise.all(layer.layers.toArray().map(l => extentOf(l).catch(() => [])))).flat()
    if (!parts.length) throw new Error(`layer "${layer.title ?? layer.id}" has no extent to go to`)
    return parts
  }
  if (layer.queryExtent) {
    const { count, extent } = await layer.queryExtent()
    // The query honours the layer's filter: no match means nothing to show, not the whole service.
    if (count === 0) throw new Error(`layer "${layer.title ?? layer.id}" has no features to go to (check its filter)`)
    // SDK 5.2: one client-side point gets a padded extent in metres labelled WGS84 (spans the globe): use the feature.
    if (count === 1 && layer.queryFeatures) {
      const { features: [feature] } = await layer.queryFeatures(Object.assign(layer.createQuery(), { returnGeometry: true }))
      if (feature?.geometry) return feature.geometry
    }
    if (extent) return extent
  }
  if (!layer.fullExtent) throw new Error(`layer "${layer.title ?? layer.id}" has no extent to go to`)
  return layer.fullExtent
}

// A style basemap keeps its id in style, a portal basemap in its item; a legacy or keyless one in id.
const currentBasemap = () => ({ id: map.basemap?.style?.id ?? map.basemap?.portalItem?.id ?? map.basemap?.id, title: map.basemap?.title })

function findLayer(key) {
  const layer = map.findLayerById(key) ?? map.layers.find(l => l.title === key)
  if (!layer) throw new Error(`no layer with id or title "${key}"`)
  return layer
}

// run_js: agent-written code runs as the page (not a sandbox). The answer is bounded, and the
// sign-in token and API key are cut from it, so a returned credential or a logged request URL does not leak by accident.
const AsyncFunction = (async () => {}).constructor
const JS_MAX_CHARS = 64 * 1024
const JS_MAX_LINES = 100
const redact = text => [apiKey, ...IdentityManager.credentials.map(c => c.token)]
  .filter(Boolean).reduce((t, secret) => t.split(secret).join('[redacted]'), text)
const toJson = value => {
  try { return JSON.stringify(value) ?? JSON.stringify(String(value)) } catch { return JSON.stringify(String(value)) }
}

const ops = {
  // Sent first to a page that does not have this log yet.
  async reset() {
    map.removeAll()
    map.basemap = start.basemap
  },

  async add_graphic({ geometry, symbol, attributes, popupTitle, layer = 'Graphics' }, { layerId }) {
    // Same GeoJSON reader as the graphics op: input checks, ArcGIS ring order, Z, GeometryCollection.
    const graphics = toGraphics(geometry)
    if (!graphics.length) throw new Error('the geometry is empty')
    const target = graphicsLayer(layer, layerId)
    let popupTemplate
    if (popupTitle || attributes) {
      popupTemplate = { title: popupTitle ?? layer }
      if (attributes) popupTemplate.content = [{ type: 'fields', fieldInfos: Object.keys(attributes).map(fieldName => ({ fieldName })) }]
    }
    for (const g of graphics) target.add(new Graphic({ geometry: g.geometry, symbol: symbol ?? g.symbol, attributes, popupTemplate }))
    return { layerId: target.id, graphics: target.graphics.length }
  },

  async add_layer(args, { layerId, replay }) {
    const make = LAYER_TYPES[args.type]
    if (!make) throw new Error(`unknown layer type: ${args.type}`)
    const layer = await make(args)
    layer.id = layerId
    try {
      await layer.load().catch(err => {
        throw new Error(`layer failed to load: ${err.message}`)
      })
      if (layer.isTable) throw new Error('this URL is a table without geometry; use a spatial feature layer')
      setProperties(layer, args)
      // A GeoParquet file whose geometry the SDK still cannot decode loads, draws nothing and fails every
      // query: refuse it rather than add an empty layer.
      if (layer.type === 'parquet') {
        await layer.queryExtent().catch(err => {
          throw new Error(`the map cannot read the geometry of this GeoParquet file (${err.message}). Check its geo metadata.`)
        })
      }
    } catch (err) {
      layer.destroy() // a refused layer never reaches the map: free what it loaded
      throw err
    }
    // A click on a feature shows its attributes even when the agent gave no popup.
    if (!layer.popupTemplate && layer.createPopupTemplate) layer.popupTemplate = layer.createPopupTemplate()
    map.add(layer)
    // The layer is on the map: a failed zoom must not report it as failed (the bridge would drop it from the log).
    if (args.zoomTo !== false && !replay) await extentOf(layer).then(extent => view.goTo(extent)).catch(() => {})
    return { layerId: layer.id, title: layer.title, type: layer.type }
  },

  async update_layer({ id, ...args }) {
    const layer = findLayer(id)
    setProperties(layer, args)
    return { layerId: layer.id }
  },

  async remove_layer({ id }) {
    const layer = findLayer(id)
    map.remove(layer)
    return { removed: layer.id }
  },

  // index: "top", "bottom", or a position in map.layers (0 is drawn first, at the bottom).
  async reorder_layer({ id, index }) {
    const layer = findLayer(id)
    if (!map.layers.includes(layer)) throw new Error(`"${id}" is inside a group layer; reorder the group`)
    const top = map.layers.length - 1
    const to = index === 'top' ? top : index === 'bottom' ? 0 : index
    if (!Number.isInteger(to) || to < 0 || to > top) throw new Error(`index must be top, bottom or 0 to ${top} (0 is the bottom)`)
    map.reorder(layer, to)
    return { layerId: layer.id, index: to, order: map.layers.toArray().map(l => l.id) }
  },

  async clear_graphics({ layer }) {
    const targets = layer ? [findLayer(layer)] : map.layers.filter(l => l.type === 'graphics').toArray()
    const other = targets.find(l => l.type !== 'graphics')
    if (other) throw new Error(`"${other.title ?? other.id}" is a ${other.type} layer, not a graphics layer`)
    targets.forEach(l => l.removeAll())
    return { cleared: targets.length }
  },

  // A basemap that fails (unknown id, Esri style without a key, too slow) leaves the previous one in place.
  async set_basemap({ basemap }) {
    if (typeof basemap !== 'string' || !basemap) throw new Error('basemap must be a non-empty string')
    const tiles = Object.hasOwn(KEYLESS, basemap) ? KEYLESS[basemap] : undefined
    // Without a token the SDK waits for an interactive sign-in that a pane cannot show: fail now instead.
    if (!tiles && basemap.includes('/') && !apiKey && !IdentityManager.credentials.length) {
      throw new Error(`"${basemap}" is a basemap style and needs a sign-in (bin/map-command login) or the page opened with ?apiKey=. Without one use: osm, ${Object.keys(KEYLESS).join(', ')}, or another legacy id from bin/map-command basemap list.`)
    }
    const previous = map.basemap
    try {
      if (tiles) {
        const [Basemap, TileLayer] = await Promise.all([$arcgis.import('@arcgis/core/Basemap.js'), use('TileLayer')])
        const [base, labels] = tiles.map(name => name && new TileLayer({ url: `${TILES}/${name}/MapServer` }))
        map.basemap = new Basemap({ id: basemap, title: basemap, baseLayers: [base], referenceLayers: labels ? [labels] : [] })
      } else if (ITEM_ID.test(basemap)) {
        const Basemap = await $arcgis.import('@arcgis/core/Basemap.js')
        map.basemap = new Basemap({ portalItem: { id: basemap, ...(portalUrl() && { portal: { url: portalUrl() } }) } })
      } else {
        map.basemap = basemap
      }
      if (!map.basemap) throw new Error(`unknown basemap "${basemap}"`)
      // Fail before the bridge's 15 s timeout, so the command is reported as failed and left out of the log.
      // The view drops its zoom levels (zoom -1) until it has the new tiling: answer once they are back.
      await Promise.race([
        map.basemap.load().then(() => reactiveUtils.whenOnce(() => view.zoom >= 0)),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`basemap "${basemap}" did not load in 10 s`)), 10000)),
      ])
    } catch (err) {
      map.basemap = previous
      throw err
    }
    return { basemap }
  },

  async get_basemap() { return currentBasemap() },

  // Styles need a sign-in or an API key; the portal's gallery needs a sign-in.
  async list_basemaps() {
    // An expired token can leave the portal load waiting for an interactive sign-in: bound it, and keep the
    // built-in ids when the gallery fails.
    let portal, portalError
    try {
      portal = await Promise.race([
        portalBasemaps(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('the portal basemap gallery did not load in 10 s; run login again')), 10000)),
      ])
    } catch (err) {
      portalError = String(err?.message ?? err)
    }
    const styles = Boolean(apiKey || IdentityManager.credentials.length)
    return {
      current: currentBasemap(), signedIn: Boolean(portalUrl()),
      keyless: BASEMAPS.keyless, legacy: BASEMAPS.legacy,
      ...(styles && { styles: BASEMAPS.styles }), ...(portal && { portal }), ...(portalError && { portalError }),
    }
  },

  // location: a place or address, found by the World Geocoding service.
  async go_to({ center, zoom, layerId, location }, { replay }) {
    if (location !== undefined) return runMapCommand(view, { command: 'go_to', mode: 'location', location })
    const target = layerId ? await extentOf(findLayer(layerId)) : { ...(center ? { center } : {}), ...(zoom != null ? { zoom } : {}) }
    await view.goTo(target, { animate: !replay })
    return { extent: view.extent.toJSON() }
  },

  // GeoJSON (or GeoPackage tables, converted by the bridge) as client-side layers: one geometry type
  // gives a FeatureLayer (legend entry, popups, renderer, labels); mixed geometry stays graphics.
  async graphics(args, { layerId }) {
    return runMapCommand(view, { ...args, command: 'graphics', layerId })
  },
  async extent() { return runMapCommand(view, { command: 'extent' }) },
  // One layer by id or title (queryExtent honours its filter), or all layers.
  async zoom({ layer }) {
    const layers = layer ? [findLayer(layer)] : map.layers.toArray()
    if (!layers.length) throw new Error('no layers to zoom to')
    // All layers: one without an extent is skipped; one named layer must have one.
    const targets = (await Promise.all(layers.map(l => (layer ? extentOf(l) : extentOf(l).catch(() => []))))).flat()
    if (!targets.length) throw new Error('the layers have no extent')
    await view.goTo(targets)
    return view.extent.toJSON()
  },
  async login(args) { return runMapCommand(view, { ...args, command: 'login' }) },
  async save_webmap({ title }) { return runMapCommand(view, { command: 'save-webmap', title }) },

  // The body of an async function with view, map, layerId and signal in scope. Its return value and
  // console lines answer; a throw or the deadline fails the command (the bridge then drops it from the log).
  async run_js({ code, timeoutMs }, { layerId, replay, at }) {
    if (typeof code !== 'string' || !code.trim()) throw new Error('code must be a non-empty string')
    const ms = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 60000)
    // The deadline counts from arrival, like the bridge's own timer: code that waited too long behind other
    // commands does not start, so the bridge never drops code that then runs. A replay has no one waiting.
    const left = replay ? ms : ms - (performance.now() - at)
    if (left <= 0) throw new Error(`the code did not start: it waited ${ms} ms behind other map commands. Send it again`)
    const lines = []
    const real = { log: console.log, warn: console.warn, error: console.error }
    // A replay answers no one: its console stays the page's own.
    if (!replay) {
      console.log = console.warn = console.error = (...parts) => {
        if (lines.length < JS_MAX_LINES) lines.push(redact(parts.map(p => (typeof p === 'string' ? p : toJson(p))).join(' ')).slice(0, 2000))
      }
    }
    const stop = new AbortController()
    let timer
    try {
      const value = await Promise.race([
        new AsyncFunction('view', 'map', 'layerId', 'signal', code)(view, map, layerId, stop.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const late = new Error(`the code did not finish in ${ms} ms`)
            stop.abort(late) // code that passes `signal` to fetch or the SDK stops; other code runs on unseen
            reject(late)
          }, left)
        }),
      ])
      const result = {}
      if (value !== undefined) {
        const text = redact(toJson(value))
        result.value = text.length > JS_MAX_CHARS ? { truncated: true, preview: text.slice(0, JS_MAX_CHARS) } : JSON.parse(text)
      }
      if (lines.length) result.console = lines
      return result
    } catch (err) {
      // The console lines travel with the error: they often say why the code failed.
      throw new Error(redact([String(err?.message ?? err), ...lines.map(line => `console: ${line}`)].join('\n')).slice(0, 8000))
    } finally {
      clearTimeout(timer)
      Object.assign(console, real)
    }
  },

  // A fixed width and height give the same picture size from the pane and the browser.
  async screenshot({ width = view.width, height = view.height }) {
    const { dataUrl } = await view.takeScreenshot({ format: 'png', width, height })
    return { dataUrl, width, height }
  },
}

const post = (path, body) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, state: snapshot() }) })

// One command at a time, in the order sent: a replay must rebuild the map exactly.
let queue = Promise.resolve()
async function handle({ id, op, args, layerId, replay, tab }, at) {
  try {
    if (!ops[op]) throw new Error(`unknown op: ${op}`)
    const result = await ops[op](args ?? {}, { layerId, replay, at })
    // A replay is not answered: the bridge waits for no one, and one /state follows the whole replay.
    if (id != null && !replay) await post('/ack', { id, tab, ok: true, result })
  } catch (err) {
    if (replay) console.warn(`replay of ${op} failed:`, err)
    else if (id != null) await post('/ack', { id, tab, ok: false, error: String(err?.message ?? err) })
  }
}

const events = new EventSource('/events')
// The bridge serves a newer page after a restart: reload, or this page keeps running its old code.
const PAGE_VERSION = '__PAGE_VERSION__'
events.addEventListener('version', e => e.data !== PAGE_VERSION && location.reload())
events.onopen = () => { badge.className = 'live'; badge.textContent = 'map: connected' }
events.onerror = () => { badge.className = 'down'; badge.textContent = 'map: disconnected' }
// A failed /ack post (bridge restarting) must not stop the queue for every later command.
// While commands run, the page reports nothing by itself: a half-done replay is not the map state.
let busy = 0
events.onmessage = msg => {
  const command = JSON.parse(msg.data)
  const at = performance.now() // run_js counts its deadline from here
  busy++
  queue = queue
    .then(() => handle(command, at))
    .catch(err => console.warn(`${command.op} failed:`, err))
    .finally(() => { if (--busy === 0 && command.replay) report() })
}
// Tell the bridge when the user pans or changes layers by hand.
let timer
const report = () => { clearTimeout(timer); timer = setTimeout(() => busy || post('/state', {}), 500) }
reactiveUtils.watch(() => view.stationary, s => s && report())
map.layers.on('change', report)
