# Run JavaScript in the map (`js`)

`map-command js` (op `run_js`) runs code that an agent (or you) wrote inside the live map page.
Use it when no other command does the job: feature queries and statistics, a renderer calculated from the data,
popups, client-side layers, geometry operations.
For plain work (add a layer, set a filter, move the map) the other commands are shorter and safer.

| Caller | How |
|---|---|
| Shell, Claude Code, Codex, Pi | `mappane/bin/map-command js <file.js \| - \| inline code> [--timeout <ms>] [--read-only]` |
| Any program | `POST /cmd {"op":"run_js","args":{"code":"...","readOnly":true,"timeoutMs":30000}}` on the bridge. See [architecture](architecture.md). |

> **Security.** The code runs with the full rights of the page. It is not a sandbox.
> After `login`, the code can read the portal token and send it to any server.
> The answer has the token and the API key removed, but that only stops accidents.
> Text that the agent reads (feature attributes, item titles, file contents) can contain instructions.
> Run `js` only with data that you trust, or do not sign in.

## 1. The contract

The code is the body of an async function. `await` and `return` work at the top level.

| Name in scope | Value |
|---|---|
| `view` | The `MapView`. |
| `map` | The `Map` (`view.map`). `map.layers` holds the layers that the commands added. |
| `layerId` | The id that the bridge gives to a layer that this code adds, for example `L7`. |
| `signal` | An `AbortSignal`. It aborts at the deadline. Pass it to `fetch` and to SDK calls that take one. |
| `$arcgis.import` | A page global. It loads SDK modules: `const [FeatureLayer] = await $arcgis.import(["@arcgis/core/layers/FeatureLayer.js"])`. |

Rules:

- Return a short value that JSON can hold. It comes back as `value`.
- `console.log`, `console.warn` and `console.error` lines come back as `console` (at most 100 lines, 2,000 characters each).
- A value longer than 65,536 characters comes back as `{ "truncated": true, "preview": "..." }`.
- A throw fails the command. The error text and the console lines come back. Read them, correct the code and send it again.
- The code is sent as written. There are no placeholders and no templates.
- The deadline is 30 s. Change it with `timeoutMs` or `--timeout` (1,000 to 60,000 ms). Code that is late fails, but it can continue to run in the page.
- The deadline counts from the time the page gets the code. The page runs one command at a time, so code can wait behind a slow command. Code that waited longer than its deadline does not start.
- Do not return or log geometry in bulk. Return counts, extents and attributes.
- Find a layer by id (`map.findLayerById("L3")`) or by title (`map.layers.find(l => l.title === "Cities")`). `js` with `map.layers` and each command that adds data give the ids.

### Code that changes the map is saved

The bridge saves each command that changes the map. Each page that opens later runs the saved commands again, in order.
This is how a Ghostty split and a browser tab show the same map.

- **Default:** `js` code is saved. The code runs again on each new page, and after a reload.
  Write code that gives the same result on a new page: do not depend on the view, on a selection or on what an earlier read-only call did.
- **A new layer:** give it `id: layerId` and a title. For more than one layer use `` `${layerId}-1` ``, `` `${layerId}-2` ``.
  Then `remove`, `zoom` and `update-layer` find the layer on each page.
- **`readOnly: true` (`--read-only`):** for code that only reads the map or moves the view. It is not saved and not run again.
  Use it for each query. If you forget it, the query runs again on each new page. That is slow, but it is not an error.
- Code that fails is not saved. Code that passed the deadline is a failure, so it is not saved either.
  But it can still complete on the page that ran it, and then that page shows a change that new pages do not get.
  Examine the map (`extent`, or a read-only `js`) before you send the code again.
- Code that blocks the page (a loop that never ends) gets no answer. After 65 s the command fails and the code is not saved.
- When more than one page is open, each page runs the code. The first page that succeeds gives the answer.
- `clear` removes the saved commands and the layers.

## 2. Examples

The examples use the layer that this command adds. Run them in the given order.

```sh
mappane/bin/map-command graphics examples/cities.geojson --title Cities
```

The GeoJSON property `population (millions)` has the safe field name `population__millions_`.
See [safe field names](standalone.md#safe-field-names).

### 2.1 Statistics (read only)

```js
// readOnly
const layer = map.layers.find(l => l.title === "Cities")
const { features: [row] } = await layer.queryFeatures({
  where: "1=1",
  outStatistics: [
    { statisticType: "count", onStatisticField: "name", outStatisticFieldName: "cities" },
    { statisticType: "max", onStatisticField: "population__millions_", outStatisticFieldName: "largest" },
    { statisticType: "avg", onStatisticField: "population__millions_", outStatisticFieldName: "average" },
  ],
})
return row.attributes
```

Answer: `{ "value": { "cities": 20, "largest": 37, "average": ... } }`

### 2.2 The top rows of a query (read only)

```js
// readOnly
const layer = map.layers.find(l => l.title === "Cities")
const { features } = await layer.queryFeatures({
  where: "population__millions_ > 15",
  outFields: ["name", "population__millions_"],
  orderByFields: ["population__millions_ DESC"],
  num: 3,
  returnGeometry: false,
})
console.log(`${features.length} rows`)
return features.map(f => f.attributes)
```

The answer also has `"console": ["3 rows"]`.

### 2.3 A renderer calculated from the data

The symbol size follows the population. The code reads the range from the layer, so it also works on a new page.

```js
const layer = map.layers.find(l => l.title === "Cities")
const { features } = await layer.queryFeatures({ where: "1=1", outFields: ["population__millions_"], returnGeometry: false })
const values = features.map(f => f.attributes.population__millions_)
const range = { min: Math.min(...values), max: Math.max(...values) }
layer.renderer = {
  type: "simple",
  symbol: { type: "simple-marker", color: "#e4572e", outline: { color: "white", width: 1 } },
  visualVariables: [{
    type: "size", field: "population__millions_",
    minDataValue: range.min, maxDataValue: range.max, minSize: 6, maxSize: 30,
    legendOptions: { title: "Population (millions)" },
  }],
}
return range
```

### 2.4 A popup

```js
const layer = map.layers.find(l => l.title === "Cities")
layer.popupTemplate = { title: "{name}", content: "{population__millions_} million people" }
return "popup set"
```

### 2.5 A new layer from a geometry operation

A 300 km geodesic buffer around the three largest cities. The new layer gets `layerId`.

```js
const [GraphicsLayer, Graphic, buffer] = await $arcgis.import([
  "@arcgis/core/layers/GraphicsLayer.js",
  "@arcgis/core/Graphic.js",
  "@arcgis/core/geometry/operators/geodesicBufferOperator.js",
])
await buffer.load()
const cities = map.layers.find(l => l.title === "Cities")
const { features } = await cities.queryFeatures({
  where: "1=1", orderByFields: ["population__millions_ DESC"], num: 3, outFields: ["name"], returnGeometry: true,
})
const rings = new GraphicsLayer({ id: layerId, title: "300 km around the 3 largest cities" })
const symbol = { type: "simple-fill", color: [228, 87, 46, 0.2], outline: { color: "#e4572e", width: 1 } }
for (const f of features) {
  rings.add(new Graphic({ geometry: buffer.execute(f.geometry, 300, { unit: "kilometers" }), symbol, attributes: f.attributes }))
}
map.add(rings)
return { layerId, rings: rings.graphics.length, cities: features.map(f => f.attributes.name) }
```

### 2.6 Move the view, then read what it shows (read only)

```js
// readOnly
await view.goTo({ center: [139.69, 35.69], zoom: 5 }, { animate: false, signal })
const layer = map.layers.find(l => l.title === "Cities")
const { features } = await layer.queryFeatures({ geometry: view.extent, outFields: ["name"], returnGeometry: false })
return { zoom: view.zoom, inView: features.map(f => f.attributes.name) }
```

### 2.7 Data from a URL

Pass `signal`, so that the request stops at the deadline. The server must allow browser CORS access.

```js
// readOnly
const response = await fetch("https://sampleserver6.arcgisonline.com/arcgis/rest/services/Census/MapServer?f=json", { signal })
const service = await response.json()
return { layers: service.layers.map(l => l.name) }
```

## 3. Use from the shell

```sh
# Inline code. Use single quotes, so that the shell does not change the code.
mappane/bin/map-command js 'return map.layers.map(l => ({ id: l.id, title: l.title, type: l.type })).toArray()' --read-only

# A file. The name must end in .js or .mjs. Put a path with spaces in quotes.
mappane/bin/map-command js ./size-by-population.js

# Standard input, with a 60 s deadline.
cat query.js | mappane/bin/map-command js - --read-only --timeout 60000
```

The command prints the answer as JSON and exits with status 0:

```json
{
  "value": [{ "id": "L1", "title": "Cities", "type": "feature" }]
}
```

`console` is absent when the code logged nothing. `value` is absent when the code returned nothing.

A failure prints the error and the console lines, and exits with status 1:

```text
map-command: layer is not defined
console: looking for the layer
```

## 4. Use from Claude Code, Codex and Pi

The `map-pane` skill tells the agent to use `scripts/map-command js`. Ask in plain words, or with the skill prefix:

| Agent | Prompt |
|---|---|
| Claude Code | `/map-pane draw a 300 km ring around the three largest cities` |
| Codex | `$map-pane count the features of each layer` |
| Pi | `/skill:map-pane size the Cities layer by population` |

## 5. Failures

| Message | Cause | Correction |
|---|---|---|
| `code must be a non-empty string` | No code arrived. | Give the code, a `.js` file or `-`. |
| `the code did not finish in <n> ms` | The deadline passed. | Increase `--timeout`, make the query smaller, or pass `signal`. Examine the map first: the code can still complete. |
| `the code did not start: it waited <n> ms behind other map commands` | An earlier command was still running when the deadline passed. The code did not run. | Send it again, after the earlier command completes. |
| `the map page did not answer in 65000 ms: the code blocks the page ...` | The code never gave control back, for example a loop that never ends. The code is not saved. | Reload the browser tab: the bridge keeps running and replays the map. A split that started its own bridge stops that bridge when you close it, and the map is lost: rebuild the map in the new split. Correct the code. |
| `Unexpected token ...`, `... is not defined` | The code has an error. | Correct the code. Send it again. |
| `No map page is open` | No page shows the map. | Open the map: `mappane/bin/map-pane --split` or `--browser`. |

## 6. Limits

- The code is not isolated. See the security note at the top.
- A loop that never ends blocks the page. No deadline in the page can stop it.
- The answer shows the result of one page. Other open pages run the same code, but their results are not compared.
- SDK version: 5.2.2. Module paths are those of `@arcgis/core`.
