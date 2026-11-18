// Bridge between the agents and the pages that show the map (Kitty pane, browser window, any tab).
// Callers: bin/map-command over a private Unix socket (mode 0600), or TCP (with MAP_PANE_TOKEN when it is set).
// POST /cmd {op, args} -> waits for a page's answer. A local `path` (or inline GeoJSON `data`) is
// served here under a random URL; only such files are served, never an arbitrary path.
// Page: GET /events (SSE), POST /ack (a command's answer), POST /state (manual pan or layer change).
// POST /clear empties the map (every layer gone, default basemap, view kept), with or without a page open.
//
// Every page shows the same map: the bridge keeps a log of the commands that change it and replays the log
// to each page that connects (SSE ids `<epoch>:<n>`, so a reconnecting page gets only what it missed).
// The log lives in memory: a new bridge starts with an empty map.
import { createServer } from 'node:http'
import { chmodSync, createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { text } from 'node:stream/consumers'

import { startView } from './commands.js'
import { commandSocket } from '../cli/command.mjs'

// 0 lets the OS choose a free port.
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 0)
// The page's files, read once. An open page keeps its code across bridge restarts: each connect sends this
// version (a hash of every file), and a page with another one reloads.
const PAGE_FILES = ['index.html', 'app.js', 'map-commands.js', 'commands.js', 'geojson.js']
const SOURCES = Object.fromEntries(PAGE_FILES.map(name => [name, readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')]))
const PAGE_VERSION = createHash('sha256').update(PAGE_FILES.map(name => SOURCES[name]).join('\0')).digest('hex').slice(0, 12)
const PAGE = { ...SOURCES, 'app.js': SOURCES['app.js'].replace('__PAGE_VERSION__', PAGE_VERSION) }
// Bad MAP_PANE_* start variables stop the bridge before it listens.
let START
try {
  START = startView(process.env)
} catch (err) {
  process.stdout.write(`BRIDGE down ${err.message}\n`, () => {
    rmSync(DATA, { recursive: true, force: true })
    process.exit(1)
  })
}
// A large local file or a slow service can take a while to load; the rest is quick.
// A duration from the environment; zero, negative or not a number keeps the default (Node runs a NaN timer in 1 ms).
const msFromEnv = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback)
// run_js: above the page's own 60 s deadline, so a page that still runs answers first.
// MAP_PANE_JS_TIMEOUT_MS is for the tests only (a frozen page in 0.2 s, not 65 s): a value under 60 s breaks that rule.
const TIMEOUT_MS = { add_layer: 60000, graphics: 60000, save_webmap: 60000, zoom: 30000, screenshot: 30000, run_js: msFromEnv('MAP_PANE_JS_TIMEOUT_MS', 65000) }
const DEFAULT_TIMEOUT_MS = msFromEnv('MAP_PANE_TIMEOUT_MS', 15000)
// Commands that do not change what the map holds: never logged, never replayed.
// login carries a token: it never reaches the log or the disk (a reload needs a new login).
const READ_ONLY = new Set(['go_to', 'screenshot', 'extent', 'zoom', 'login', 'save_webmap', 'get_basemap', 'list_basemaps'])

// Inline GeoJSON and screenshots are written here; the folder goes when the bridge stops.
const DATA = mkdtempSync(join(tmpdir(), 'map-pane-data-'))
// shortcut: the log only grows (a removed layer stays as add + remove); compact it if replays get slow.
// A new epoch on /clear: a page that reconnects with an id from the old log starts over.
let epoch = randomUUID().slice(0, 8)
let log = []
let nextId = 1

const tabs = new Set()
// Each page's id: a command carries it to that page, and the page's /ack sends it back.
const tabIds = new WeakMap()
let nextTab = 1
// The last successful login's args (token included): memory only, replayed to each new page.
let lastLogin
const pending = new Map()
// Ids of pending commands a page already got in its replay: that page may show them, even after it disconnects.
const replayed = new Set()
let state = { layers: [] }
// Local files a command asked to show, by key and by path.
const files = new Map()
const fileKeys = new Map()
/** The URL a page reads a registered local file from; throws if it is not a readable file. */
function serve(path) {
  if (typeof path !== 'string' || !statSync(path).isFile()) throw new Error(`${path} is not a file`)
  let key = fileKeys.get(path)
  if (!key) {
    key = randomUUID() // unguessable: a file URL is its only key
    files.set(key, path)
    fileKeys.set(path, key)
  }
  return `/files/${key}/${encodeURIComponent(basename(path))}`
}

// An inline GeoJSON file (in DATA) whose layer is gone: stop serving it and delete it. Other paths are the user's.
function forget(path) {
  if (typeof path !== 'string' || dirname(path) !== DATA) return
  files.delete(fileKeys.get(path))
  fileKeys.delete(path)
  rmSync(path, { force: true })
}

// The log keeps local paths (file URLs change per bridge); a page gets URLs.
function toPage(entry, replay) {
  let { args } = entry
  if (typeof args.path === 'string') {
    const { path, ...rest } = args
    try {
      args = { ...rest, url: serve(path) }
    } catch (err) {
      args = { ...rest, missing: err.message } // the page reports it; a replay goes on without it
    }
  }
  return { id: entry.id, op: entry.op, args, layerId: `L${entry.id}`, ...(replay ? { replay: true } : {}) }
}

const sse = (res, message, withId = true) =>
  res.write(`${withId && message.id != null ? `id: ${epoch}:${message.id}\n` : ''}data: ${JSON.stringify(message)}\n\n`)

const body = async req => {
  const raw = await text(req)
  return raw ? JSON.parse(raw) : {}
}

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

const snapshot = () => ({ ...state, isConnected: tabs.size > 0 })

// Set once the port is bound (PORT 0 picks one).
let HOST = `127.0.0.1:${PORT}`
// shortcut: single-user machine. GET /events, /state and /files need no token (browsers cannot send one), so another
// local user account could read the map and its served files over TCP; only the Unix socket is owner-only.
// An optional secret: the Host/Origin guard stops web pages, not other local programs.
// Set, it is required on the TCP control endpoints (/cmd, /clear). The Unix socket needs none:
// only its owner can connect (mode 0600).
const TOKEN = process.env.MAP_PANE_TOKEN
const SOCKET = commandSocket(process.pid)
// Advertised (SOCKET line, /api/info) only once the socket listens: the CLI has no other way in.
let socketReady = false
const CONTROL = new Set(['/cmd', '/clear'])

// Inline GeoJSON becomes a file in the data folder, so the log stays small and holds a path like any other.
// A GeoPackage (URL or local path) becomes a graphics command with its tables decoded here.
async function prepare(cmd) {
  const args = { ...(cmd.args ?? {}) }
  if (cmd.op === 'geopackage') {
    const { loadGeoPackage, readGeoPackageIsolated } = await import('../cli/geopackage.mjs')
    const source = args.path ?? args.url
    if (typeof source !== 'string' || !source) throw new Error('geopackage needs url or path')
    // shortcut: the decoded tables go into the log as inline data; store them as files if logs get large.
    const layers = args.path ? await readGeoPackageIsolated(args.path, args.table) : await loadGeoPackage(args.url, args.table)
    return { op: 'graphics', args: { layers } }
  }
  // graphics keeps its GeoJSON inline: the page decodes it into client-side layers.
  if (args.data !== undefined && cmd.op !== 'graphics') {
    if (cmd.op !== 'add_layer' || args.type !== 'geojson') throw new Error('data is for add_layer with type "geojson", or graphics, only')
    const path = join(DATA, `layer-${randomUUID()}.geojson`)
    writeFileSync(path, typeof args.data === 'string' ? args.data : JSON.stringify(args.data))
    delete args.data
    args.path = path
  }
  if (args.path !== undefined) serve(args.path) // refuse a bad path now, not on the page
  return { op: cmd.op, args }
}

const handler = async (req, res) => {
  try {
    // A Unix socket request has no remote address: its caller is the socket's owner.
    const isSocket = !req.socket.remoteAddress
    // Any web page can reach 127.0.0.1: refuse a foreign Host (DNS rebinding) or Origin (cross-site POST).
    const file = req.url.split('?')[0].slice(1) || 'index.html'
    const isPageFile = req.method === 'GET' && Object.hasOwn(PAGE, file)
    // An <img> or <iframe> on another site sends no Origin; browsers mark it with Sec-Fetch-Site (absent from the
    // curl and old browsers). The page files stay open to it: a link to the map on a web page must work.
    const site = req.headers['sec-fetch-site']
    const isForeign = (req.headers.origin && req.headers.origin !== `http://${HOST}`) || (site && site !== 'same-origin' && site !== 'none' && !isPageFile)
    if (!isSocket && (req.headers.host !== HOST || isForeign)) {
      return json(res, 403, { ok: false, error: `only http://${HOST}/ may call the bridge` })
    }
    if (!isSocket && TOKEN && req.method === 'POST' && CONTROL.has(req.url) && req.headers['x-map-pane-token'] !== TOKEN) {
      return json(res, 403, {
        ok: false,
        error: `wrong bridge token (x-map-pane-token) for the map bridge on port ${PORT}`,
      })
    }
    if (isPageFile) {
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' })
      return res.end(PAGE[file])
    }
    if (req.method === 'GET' && req.url === '/api/start') return json(res, 200, START)
    // bin/map-pane asks a running bridge where its page is.
    if (req.method === 'GET' && req.url === '/api/info') return json(res, 200, { url: `http://${HOST}/`, pid: process.pid, socket: socketReady ? SOCKET : null })
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(`: connected\n\nevent: version\ndata: ${PAGE_VERSION}\n\n`)
      // A page that reconnects to this log gets only what it missed; any other page starts over.
      const [lastEpoch, lastN] = String(req.headers['last-event-id'] ?? '').split(':')
      const isKnown = lastEpoch === epoch && Number(lastN) < nextId
      if (!isKnown) sse(res, { op: 'reset' }, false)
      // Before the log: a logged basemap style or portal layer needs the token to replay.
      if (!isKnown && lastLogin) sse(res, { op: 'login', args: lastLogin, replay: true }, false)
      for (const entry of log) {
        if (isKnown && entry.id <= Number(lastN)) continue
        sse(res, toPage(entry, true))
        if (pending.has(entry.id)) replayed.add(entry.id)
      }
      if (!isKnown && state.center) sse(res, { op: 'go_to', args: { center: state.center, zoom: state.zoom }, replay: true }, false)
      tabs.add(res)
      tabIds.set(res, nextTab++)
      req.on('close', () => {
        tabs.delete(res)
        for (const recheck of [...pending.values()]) recheck()
      })
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url.startsWith('/files/')) {
      // Parquet readers send HEAD for the size, then Range GETs for the footer and row groups.
      const path = files.get(req.url.split('/')[2])
      if (!path) return json(res, 404, { ok: false, error: 'not found' })
      const size = statSync(path).size
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
        if (start > end) return res.writeHead(416, { 'content-range': `bytes */${size}` }).end()
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' })
        return createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res)
      }
      res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' })
      if (req.method === 'HEAD') return res.end()
      return createReadStream(path).on('error', () => res.destroy()).pipe(res)
    }
    if (req.method === 'GET' && req.url === '/state') return json(res, 200, snapshot())
    if (req.method === 'POST' && req.url === '/state') {
      state = (await body(req)).state ?? state
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/ack') {
      const ack = await body(req)
      if (ack.state) state = ack.state
      pending.get(ack.id)?.(ack)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/clear') {
      // Inline GeoJSON files belong to the cleared layers; screenshots in the same folder stay.
      for (const entry of log) forget(entry.args.path)
      log = []
      epoch = randomUUID().slice(0, 8)
      state = { ...state, layers: [] }
      // Sent as a replay: the page posts its state once the reset has run.
      for (const tab of tabs) sse(tab, { op: 'reset', replay: true }, false)
      return json(res, 200, { ok: true, state: snapshot() })
    }
    if (req.method === 'POST' && req.url === '/cmd') {
      const cmd = await body(req)
      if (typeof cmd.op !== 'string') return json(res, 400, { ok: false, error: 'op missing' })
      if (tabs.size === 0) {
        return json(res, 503, {
          ok: false,
          noPage: true,
          error: `No map page is open. Run bin/map-pane --split, or open http://${HOST}/.`,
          state: snapshot(),
        })
      }
      let entry
      try {
        entry = await prepare(cmd)
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message, state: snapshot() })
      }
      // Preparation can finish out of order: replay ids must follow delivery order.
      entry.id = nextId++
      // run_js code that only reads the map says so (readOnly): it is not replayed on later pages.
      const isLogged = !READ_ONLY.has(entry.op) && !(entry.op === 'run_js' && entry.args.readOnly === true)
      // Logged before it is sent, so a page that connects meanwhile gets it in its replay.
      if (isLogged) log.push(entry)
      // Saving writes to the portal: never run it on a second page, even if the first fails.
      const targets = entry.op === 'save_webmap' ? [...tabs].slice(0, 1) : [...tabs]
      const timeout = TIMEOUT_MS[entry.op] ?? DEFAULT_TIMEOUT_MS
      // The first page that succeeds answers; an error answers only when every page failed.
      const ack = await new Promise(resolve => {
        const failed = new Set()
        let firstError
        const settle = value => {
          clearTimeout(timer)
          pending.delete(entry.id)
          resolve(value)
        }
        // Called with a page's answer, or with none when a page closes: a closed page never answers,
        // so the pages still connected decide.
        pending.set(entry.id, answer => {
          if (answer?.ok) return settle(answer)
          if (answer) {
            firstError ??= answer
            failed.add(answer.tab)
          }
          // A page that connected later applied a logged command through its replay, which is never answered:
          // it keeps the command open until the timeout, so the log keeps what that page shows.
          const live = isLogged ? [...tabs] : targets.filter(tab => tabs.has(tab))
          if (live.length === 0) settle(firstError ?? { ok: false, error: 'every target map page closed before it answered' })
          else if (firstError && live.every(tab => failed.has(tabIds.get(tab)))) settle(firstError)
        })
        const timer = setTimeout(
          // Timed out: a page may still finish it, so it stays in the log even when another page failed.
          () => settle({
            ok: false,
            timedOut: true,
            error: firstError
              ? `${firstError.error}; another map page did not answer in ${timeout} ms and may still finish it, so read the map (extent) before retrying`
              : entry.op === 'run_js'
                ? `the map page did not answer in ${timeout} ms: the code blocks the page (a loop that never ends?). It is not saved; reload the map page`
                : `the map did not answer in ${timeout} ms; it may still finish, so read the map (extent) before retrying`,
          }),
          timeout,
        )
        const message = toPage(entry, false)
        for (const tab of targets) sse(tab, { ...message, tab: tabIds.get(tab) })
      })
      // A timed-out command may still finish on a page, and a replayed one may be on a page already:
      // keep both, so later pages replay the same map.
      // Not run_js: its page has its own deadline, so no answer means the code froze the page (a loop that
      // never ends). Kept, it would freeze every page that opens later.
      const wasReplayed = replayed.delete(entry.id)
      const keep = ack.ok || (ack.timedOut ? entry.op !== 'run_js' : wasReplayed)
      if (isLogged && !keep) {
        log = log.filter(e => e !== entry)
        forget(entry.args.path)
      }
      // Kept in memory only (never in the log or on disk), so a page that opens later is signed in too.
      if (ack.ok && entry.op === 'login') lastLogin = entry.args
      let { result } = ack
      if (ack.ok && cmd.op === 'screenshot' && typeof result?.dataUrl === 'string') {
        const path = join(DATA, `map-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
        writeFileSync(path, Buffer.from(result.dataUrl.split(',')[1] ?? '', 'base64'))
        result = { path, width: result.width, height: result.height }
      }
      return json(res, ack.ok ? 200 : 422, { ok: ack.ok, error: ack.error, ...(ack.timedOut ? { timedOut: true } : {}), result, state: snapshot() })
    }
    json(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    json(res, 400, { ok: false, error: String(err?.message ?? err) })
  }
}
const server = createServer(handler)

// The CLI's door: same handler, owner-only socket, removed on exit.
const commands = createServer(handler)
commands.on('error', err => console.error(`command socket: ${err.message}`))
// Listens after the TCP port, so `bridge:` stays the first stdout line (the launcher and tests read it).
function listenSocket() {
  rmSync(SOCKET, { force: true }) // left by a killed bridge with the same pid
  commands.listen(SOCKET, () => {
    chmodSync(SOCKET, 0o600)
    socketReady = true
    console.log(`SOCKET ${SOCKET}`)
  })
  process.on('exit', () => rmSync(SOCKET, { force: true }))
}

server.on('error', err => {
  const why = err.code === 'EADDRINUSE' ? `port ${PORT} is held by another program` : err.message
  // Exit after the write: a pipe write is asynchronous on macOS.
  rmSync(DATA, { recursive: true, force: true })
  process.stdout.write(`BRIDGE down ${why}\n`, () => process.exit(1))
})
if (START) server.listen(PORT, '127.0.0.1', () => {
  HOST = `127.0.0.1:${server.address().port}`
  console.log(`bridge: http://${HOST}/`)
  listenSocket()
})
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    rmSync(DATA, { recursive: true, force: true })
    process.exit(0)
  })
}
// Keep SSE connections alive through proxies and idle timeouts.
setInterval(() => tabs.forEach(tab => tab.write(': ping\n\n')), 20000)
