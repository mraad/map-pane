// Bridge tests: node --test web/
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18765
const OTHER_PORT = 18766
const SERVER = new URL('./server.mjs', import.meta.url).pathname
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let bridge

const startBridge = async (port, env = {}) => {
  const child = spawn(process.execPath, [SERVER, String(port)], {
    env: { ...process.env, CHROME: '/usr/bin/false', MAP_PANE_TOKEN: 'test-token', ...env },
  })
  child.lines = []
  child.stdout.on('data', chunk => child.lines.push(...String(chunk).split('\n').filter(Boolean)))
  while (!child.lines.some(line => line.startsWith('bridge:') || line.startsWith('BRIDGE down'))) await sleep(20)
  return child
}
const stopBridge = async child => {
  if (child.exitCode !== null) return
  child.kill()
  await once(child, 'exit')
}

before(async () => {
  bridge = await startBridge(PORT, { MAP_PANE_TIMEOUT_MS: '1000', MAP_PANE_JS_TIMEOUT_MS: '200' })
})
after(() => stopBridge(bridge))

// node:http, not fetch: fetch will not send a custom Host header.
const call = (method, path, { body, headers = {}, port = PORT } = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, 'x-map-pane-token': 'test-token', ...headers } }, res => {
      let text = ''
      res.on('data', c => (text += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
const cmd = (op, args = {}, port = PORT) => call('POST', '/cmd', { body: { op, args }, port }).then(res => ({ status: res.status, ...JSON.parse(res.text) }))

// A map page as the bridge sees it: an SSE reader that answers each command with `answer(message)`.
function page({ port = PORT, lastEventId, answer = () => ({ ok: true, result: {} }) } = {}) {
  const messages = []
  const ids = []
  let connected
  const ready = new Promise(resolve => { connected = resolve })
  const headers = { host: `127.0.0.1:${port}`, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }
  const req = request({ host: '127.0.0.1', port, path: '/events', headers }, res => {
    connected()
    let buffer = ''
    res.on('data', chunk => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = /^data: (.*)$/m.exec(block)
        if (!data || /^event: /m.test(block)) continue // only unnamed events are commands, as in EventSource.onmessage
        const message = JSON.parse(data[1])
        messages.push(message)
        ids.push(/^id: (.*)$/m.exec(block)?.[1])
        if (message.id != null && !message.replay) {
          Promise.resolve(answer(message)).then(reply => reply && call('POST', '/ack', { body: { id: message.id, tab: message.tab, ...reply }, port }))
        }
      }
    })
  })
  req.end()
  const until = async check => {
    for (let i = 0; i < 200 && !check(); i++) await sleep(10)
  }
  return { messages, ids, ready, until, close: () => req.destroy() }
}

// Runs first: no page is connected yet.
test('/cmd with no map page answers 503 with the map state', async () => {
  const res = await cmd('go_to', { zoom: 3 })
  assert.equal(res.status, 503)
  assert.equal(res.state.isConnected, false)
})

test('a foreign Host (DNS rebinding) or Origin (other web page) is refused', async () => {
  assert.equal((await call('GET', '/state', { headers: { host: 'evil.example:18765' } })).status, 403)
  const crossSite = await call('POST', '/cmd', {
    body: { op: 'add_layer', args: { type: 'geojson', path: '/etc/hosts' } },
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
  })
  assert.equal(crossSite.status, 403)
  // An <img src=".../events"> on another site sends no Origin: it must not count as a map page.
  assert.equal((await call('GET', '/events', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await call('GET', '/state', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200)
  assert.equal((await call('GET', '/state', { headers: { 'sec-fetch-site': 'none' } })).status, 200)
  // A link to the map on a web page still opens it.
  assert.equal((await call('GET', '/', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200)
  assert.equal((await call('GET', '/state', { headers: { origin: `http://127.0.0.1:${PORT}` } })).status, 200)
})

test('control endpoints need the token when MAP_PANE_TOKEN is set; pages need none', async () => {
  for (const path of ['/cmd', '/clear']) {
    const res = await call('POST', path, { body: {}, headers: { 'x-map-pane-token': 'wrong' } })
    assert.equal(res.status, 403, path)
    assert.match(JSON.parse(res.text).error, /wrong bridge token/)
  }
  assert.equal((await call('GET', '/state', { headers: { 'x-map-pane-token': '' } })).status, 200)
})

test('a local path is refused when it is no file, and served under a random URL with HEAD and ranges', async () => {
  const tab = page()
  await tab.until(() => tab.messages.length)
  assert.equal((await cmd('add_layer', { type: 'parquet', path: '/no/such/file.parquet' })).status, 400)
  assert.equal((await call('GET', '/files/999/x')).status, 404)

  const path = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'data.parquet')
  writeFileSync(path, '0123456789')
  assert.equal((await cmd('add_layer', { type: 'parquet', path })).status, 200)
  const { url } = tab.messages.at(-1).args
  assert.match(url, /^\/files\/[0-9a-f-]{36}\/data\.parquet$/)
  assert.equal(tab.messages.at(-1).args.path, undefined, 'the page never sees the local path')

  assert.equal((await call('GET', url)).text, '0123456789')
  const head = await call('HEAD', url)
  assert.equal(head.headers['content-length'], '10')
  assert.equal(head.text, '')
  const tail = await call('GET', url, { headers: { range: 'bytes=-3' } })
  assert.equal(tail.status, 206)
  assert.equal(tail.text, '789')
  assert.equal(tail.headers['content-range'], 'bytes 7-9/10')
  assert.equal((await call('GET', url, { headers: { range: 'bytes=2-4' } })).text, '234')
  assert.equal((await call('GET', url, { headers: { range: 'bytes=20-' } })).status, 416)
  tab.close()
})

test('inline GeoJSON becomes a served file; data on another type is refused', async () => {
  const tab = page()
  await tab.until(() => tab.messages.length)
  const data = { type: 'FeatureCollection', features: [] }
  assert.equal((await cmd('add_layer', { type: 'geojson', data })).status, 200)
  const { url, data: sent } = tab.messages.at(-1).args
  assert.equal(sent, undefined)
  assert.deepEqual(JSON.parse((await call('GET', url)).text), data)
  assert.equal((await cmd('add_layer', { type: 'feature', data })).status, 400)
  tab.close()
})

test('each page connect gets the version stamped on the served page, so a page with old code reloads', async () => {
  const html = (await call('GET', '/app.js')).text
  const version = /const PAGE_VERSION = '([0-9a-f]{12})'/.exec(html)?.[1]
  assert.ok(version, 'the page carries a 12-hex version')
  const stream = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path: '/events', headers: { host: `127.0.0.1:${PORT}` } }, res => {
      let text = ''
      res.on('data', chunk => {
        text += chunk
        if (/event: version\ndata: .*\n\n/.test(text)) { req.destroy(); resolve(text) } // the whole event, not a chunk of it
      })
    })
    req.on('error', reject)
    req.end()
  })
  assert.match(stream, new RegExp(`event: version\ndata: ${version}\n\n`))
})

test('a new page replays the map; a reconnecting page gets only what it missed; failures and go_to are not replayed', async () => {
  const first = page({ answer: m => (m.op === 'remove_layer' ? { ok: false, error: 'no layer' } : { ok: true, result: {} }) })
  await first.until(() => first.messages.length)
  await cmd('add_graphic', { geometry: { type: 'Point', coordinates: [1, 2] } })
  await cmd('go_to', { zoom: 4 })
  assert.equal((await cmd('remove_layer', { id: 'nope' })).status, 422)
  const lastId = first.ids.at(-1)
  first.close()

  const fresh = page()
  await fresh.until(() => fresh.messages.some(m => m.op === 'add_graphic'))
  await sleep(50)
  assert.equal(fresh.messages[0].op, 'reset')
  const replayed = fresh.messages.filter(m => m.replay && m.id != null)
  assert.ok(replayed.every(m => m.op === 'add_layer' || m.op === 'add_graphic'), replayed.map(m => m.op).join())
  const graphic = replayed.find(m => m.op === 'add_graphic')
  assert.equal(graphic.layerId, `L${graphic.id}`, 'the bridge names new layers, the same on every page')

  await cmd('add_graphic', { geometry: { type: 'Point', coordinates: [3, 4] } })
  const back = page({ lastEventId: lastId })
  await sleep(150)
  assert.deepEqual(back.messages.map(m => m.op), ['add_graphic'], 'only the command sent after it left')
  fresh.close()
  back.close()
})

test('run_js is saved and replayed with a layer id, except when it is readOnly', async () => {
  const first = page({ answer: m => ({ ok: true, result: { value: m.args.code } }) })
  await first.until(() => first.messages.length)
  assert.equal((await cmd('run_js', { code: 'map.add(x)' })).result.value, 'map.add(x)')
  await cmd('run_js', { code: 'return 1', readOnly: true })
  const fresh = page()
  await fresh.until(() => fresh.messages.some(m => m.op === 'run_js'))
  await sleep(50)
  const replayed = fresh.messages.filter(m => m.op === 'run_js')
  assert.deepEqual(replayed.map(m => [m.args.code, m.replay, m.layerId]), [['map.add(x)', true, `L${replayed[0].id}`]])
  first.close()
  fresh.close()
})

test('run_js code that froze its page is not saved: a later page does not run it', async () => {
  const frozen = page({ answer: () => undefined })
  await frozen.until(() => frozen.messages.length)
  const res = await cmd('run_js', { code: 'while (true) {}' })
  assert.equal(res.status, 422)
  assert.match(res.error, /blocks the page.*not saved/)
  frozen.close()
  const fresh = page()
  await fresh.until(() => fresh.messages.length)
  await sleep(50)
  assert.ok(!fresh.messages.some(m => m.args?.code === 'while (true) {}'), 'the frozen code is not replayed')
  fresh.close()
})

test('a page that opens while run_js is pending does not run it; other pending commands still replay', async () => {
  const busy = page({ answer: m => (m.op === 'run_js' ? sleep(150).then(() => ({ ok: true, result: {} })) : { ok: true, result: {} }) })
  await busy.until(() => busy.messages.length)
  const running = cmd('run_js', { code: 'slow()' })
  await busy.until(() => busy.messages.some(m => m.args?.code === 'slow()'))
  assert.ok(Number.isFinite(busy.messages.find(m => m.args?.code === 'slow()').expiresAt), 'a live command carries the bridge deadline')
  const fresh = page()
  try {
    await fresh.until(() => fresh.messages.length)
    await sleep(20)
    assert.ok(!fresh.messages.some(m => m.args?.code === 'slow()'), 'the pending run_js is not replayed')
    assert.equal((await running).status, 200)
  } finally {
    busy.close()
    fresh.close()
  }
})

test('the first page that succeeds answers, even when another page failed first', async () => {
  const failing = page({ answer: () => ({ ok: false, error: 'broken page' }) })
  const slow = page({ answer: () => sleep(100).then(() => ({ ok: true, result: { from: 'slow' } })) })
  await failing.until(() => failing.messages.length)
  await slow.until(() => slow.messages.length)
  const res = await cmd('clear_graphics')
  assert.equal(res.status, 200)
  assert.deepEqual(res.result, { from: 'slow' })
  slow.close()
  await sleep(100) // the bridge sees the close
  const alone = await cmd('clear_graphics')
  assert.equal(alone.error, 'broken page', 'with every page failed, the error answers')
  failing.close()
})

test('save_webmap runs on one page and never fails over after an error or disconnect', async t => {
  let outcome = 'success'
  const first = page({ answer: m => {
    if (m.op !== 'save_webmap') return { ok: true }
    if (outcome === 'disconnect') { first.close(); return undefined }
    return outcome === 'success' ? { ok: true, result: { id: 'one-item' } } : { ok: false, error: 'save failed' }
  } })
  const second = page()
  t.after(() => { first.close(); second.close() })
  await first.until(() => first.messages.length)
  await second.until(() => second.messages.length)
  const saved = await cmd('save_webmap', { title: 'One item' })
  assert.equal(saved.status, 200)
  assert.equal(saved.result.id, 'one-item')
  outcome = 'failure'
  assert.equal((await cmd('save_webmap', { title: 'Failed item' })).error, 'save failed')
  outcome = 'disconnect'
  const closed = await cmd('save_webmap', { title: 'Uncertain item' })
  assert.equal(closed.status, 422)
  assert.match(closed.error, /target map page closed/)
  await cmd('extent')
  await second.until(() => second.messages.some(m => m.op === 'extent'))
  assert.ok(second.messages.some(m => m.op === 'extent'), 'the other page remains connected')
  assert.equal(second.messages.filter(m => m.op === 'save_webmap').length, 0)
})

test('a slow GeoPackage and a quick command get increasing delivery ids and reconnect without duplicates', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-order-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'data.gpkg')
  const db = new DatabaseSync(file)
  try { db.exec(readFileSync(new URL('../test/fixtures/vector.sql', import.meta.url), 'utf8')) } finally { db.close() }
  let respond, accepted
  let arrived = new Promise(resolve => { accepted = resolve })
  const server = createServer((req, res) => {
    respond = () => res.end(readFileSync(file))
    accepted()
  })
  t.after(() => { server.closeAllConnections(); server.close() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const downloadUrl = `http://127.0.0.1:${server.address().port}/data.gpkg`
  const tab = page()
  t.after(() => tab.close())
  await tab.ready
  const slow = cmd('geopackage', { url: downloadUrl })
  await arrived
  const fast = await cmd('add_graphic', { geometry: { type: 'Point', coordinates: [1, 2] }, layer: 'During download' })
  assert.equal(fast.status, 200)
  respond()
  assert.equal((await slow).status, 200)
  const delivered = tab.messages.filter(m => m.id != null && !m.replay)
  assert.deepEqual(delivered.map(m => m.op), ['add_graphic', 'graphics'])
  assert.ok(delivered[0].id < delivered[1].id)
  const back = page({ lastEventId: tab.ids.at(-1) })
  t.after(() => back.close())
  await back.ready
  await cmd('extent')
  await back.until(() => back.messages.some(m => m.op === 'extent'))
  assert.deepEqual(back.messages.map(m => m.op), ['extent'])
  arrived = new Promise(resolve => { accepted = resolve })
  const abandoned = cmd('geopackage', { url: downloadUrl })
  await arrived
  back.close()
  tab.close()
  for (let i = 0; i < 100 && JSON.parse((await call('GET', '/state')).text).isConnected; i++) await sleep(10)
  respond()
  assert.equal((await abandoned).status, 503)
  const fresh = page()
  t.after(() => fresh.close())
  await fresh.ready
  await cmd('extent')
  await fresh.until(() => fresh.messages.some(m => m.op === 'extent'))
  assert.equal(fresh.messages.filter(m => m.op === 'graphics').length, 1)
})

test('a page that failed and then closed does not decide for a page that has not answered yet', async t => {
  const failing = page({ answer: () => { setTimeout(() => failing.close(), 20); return { ok: false, error: 'broken page' } } })
  const slow = page({ answer: () => sleep(200).then(() => ({ ok: true, result: { from: 'slow' } })) })
  t.after(() => { failing.close(); slow.close() })
  await failing.ready
  await slow.ready
  const res = await cmd('clear_graphics')
  assert.equal(res.status, 200)
  assert.deepEqual(res.result, { from: 'slow' })
})

test('a page that replayed a pending command keeps it in the log when the page it was sent to closes', async t => {
  const first = page({ answer: () => undefined })
  t.after(() => first.close())
  await first.ready
  const pending = cmd('add_graphic', { geometry: { type: 'Point', coordinates: [7, 8] }, layer: 'Replayed' })
  await first.until(() => first.messages.some(m => m.args?.layer === 'Replayed'))
  const joined = page({ answer: () => undefined })
  t.after(() => joined.close())
  await joined.until(() => joined.messages.some(m => m.replay && m.args?.layer === 'Replayed'))
  first.close()
  const res = await pending
  assert.equal(res.timedOut, true, 'the joined page holds it open until the timeout')
  joined.close()
  const later = page()
  t.after(() => later.close())
  await later.until(() => later.messages.some(m => m.args?.layer === 'Replayed'))
  assert.ok(later.messages.some(m => m.replay && m.args?.layer === 'Replayed'))
})

test('a pending command a page replayed stays in the log after that page disconnects and the target closes', async t => {
  const first = page({ answer: () => undefined })
  t.after(() => first.close())
  await first.ready
  const pending = cmd('add_graphic', { geometry: { type: 'Point', coordinates: [9, 9] }, layer: 'Dropped joiner' })
  await first.until(() => first.messages.some(m => m.args?.layer === 'Dropped joiner'))
  const joined = page()
  await joined.until(() => joined.messages.some(m => m.replay && m.args?.layer === 'Dropped joiner'))
  joined.close()
  await sleep(50) // the bridge sees the close
  first.close()
  const res = await pending
  assert.equal(res.status, 422)
  assert.match(res.error, /target map page closed/)
  const later = page()
  t.after(() => later.close())
  await later.until(() => later.messages.some(m => m.args?.layer === 'Dropped joiner'))
  assert.ok(later.messages.some(m => m.replay && m.args?.layer === 'Dropped joiner'))
})

test('a command no page answered in time stays in the log: it may still finish, so later pages replay it', async () => {
  const silent = page({ answer: () => undefined })
  await silent.until(() => silent.messages.length)
  const res = await cmd('add_graphic', { geometry: { type: 'Point', coordinates: [5, 6] }, layer: 'Slow' })
  assert.equal(res.status, 422)
  assert.match(res.error, /did not answer in 1000 ms/)
  silent.close()
  const later = page()
  await later.until(() => later.messages.some(m => m.args?.layer === 'Slow'))
  assert.ok(later.messages.some(m => m.replay && m.args?.layer === 'Slow'))
  later.close()
})

test('a command one page refused and another never answered stays in the log: the slow page may still finish it', async () => {
  const refusing = page({ answer: m => (m.args?.layer === 'Split' ? { ok: false, error: 'refused' } : { ok: true, result: {} }) })
  const silent = page({ answer: () => undefined })
  await refusing.until(() => refusing.messages.length)
  await silent.until(() => silent.messages.length)
  const res = await cmd('add_graphic', { geometry: { type: 'Point', coordinates: [7, 8] }, layer: 'Split' })
  assert.equal(res.status, 422)
  assert.match(res.error, /^refused; another map page did not answer in 1000 ms and may still finish it/, 'the first error answers, with the timeout')
  assert.equal(res.timedOut, true)
  refusing.close()
  silent.close()
  const later = page()
  await later.until(() => later.messages.some(m => m.args?.layer === 'Split'))
  assert.ok(later.messages.some(m => m.replay && m.args?.layer === 'Split'))
  later.close()
})

test('a page that opens after a login gets the login first, then the log', async t => {
  // Its own bridge: the login stays in memory and would reach every later test's pages.
  const own = await startBridge(OTHER_PORT)
  t.after(() => stopBridge(own))
  // Holds back its answer to T3 until `release`, so another page connects while that login is pending.
  let release
  const held = new Promise(resolve => { release = resolve })
  const first = page({ port: OTHER_PORT, answer: m => (m.args?.token === 'T3' ? held.then(() => ({ ok: true, result: {} })) : { ok: true, result: {} }) })
  t.after(() => first.close())
  await first.until(() => first.messages.length)
  assert.equal((await cmd('login', { token: 'T1', userId: 'u1' }, OTHER_PORT)).status, 200)
  assert.equal((await cmd('set_basemap', { basemap: 'arcgis/navigation' }, OTHER_PORT)).status, 200)
  const later = page({ port: OTHER_PORT })
  t.after(() => later.close())
  await later.until(() => later.messages.some(m => m.op === 'set_basemap'))
  const ops = later.messages.map(m => m.op)
  assert.equal(later.messages.find(m => m.op === 'login').args.token, 'T1')
  assert.ok(ops.indexOf('login') < ops.indexOf('set_basemap'), ops.join(' '))
  later.close()
  const cursor = later.ids.at(-1)
  assert.equal((await cmd('login', { token: 'T2' }, OTHER_PORT)).status, 200)
  await cmd('set_basemap', { basemap: 'osm' }, OTHER_PORT)
  const back = page({ port: OTHER_PORT, lastEventId: cursor })
  t.after(() => back.close())
  await back.until(() => back.messages.some(m => m.op === 'set_basemap'))
  assert.deepEqual(back.messages.map(m => m.op), ['login', 'set_basemap'])
  assert.equal(back.messages[0].args.token, 'T2')
  back.close()
  // A page that connects while T3 is pending is no target: it gets T2, then a command after T3.
  const login = cmd('login', { token: 'T3' }, OTHER_PORT)
  await first.until(() => first.messages.some(m => m.args?.token === 'T3'))
  const mid = page({ port: OTHER_PORT })
  t.after(() => mid.close())
  await mid.until(() => mid.messages.some(m => m.op === 'login'))
  release()
  assert.equal((await login).status, 200)
  await cmd('set_basemap', { basemap: 'topo' }, OTHER_PORT)
  await mid.until(() => mid.messages.some(m => m.args?.basemap === 'topo'))
  assert.deepEqual(mid.messages.filter(m => m.op === 'login').map(m => m.args.token), ['T2'])
  mid.close()
  const again = page({ port: OTHER_PORT, lastEventId: mid.ids.at(-1) })
  t.after(() => again.close())
  await again.until(() => again.messages.some(m => m.op === 'login'))
  assert.equal(again.messages.find(m => m.op === 'login')?.args.token, 'T3', 'a reconnecting page gets the login it missed')
})

test('a screenshot is written to a PNG file; its path answers, not the picture', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const tab = page({ answer: () => ({ ok: true, result: { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: 8, height: 4 } }) })
  await tab.until(() => tab.messages.length)
  const { result } = await cmd('screenshot')
  assert.match(result.path, /\.png$/)
  assert.deepEqual(readFileSync(result.path), png)
  assert.equal(result.width, 8)
  tab.close()
})

test('/clear empties the map: open pages reset, and a page that reconnects with an old id starts over too', async () => {
  const open = page()
  await open.until(() => open.messages.length)
  await cmd('add_graphic', { geometry: { type: 'Point', coordinates: [7, 8] } })
  await cmd('add_layer', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  const inline = open.messages.findLast(m => m.op === 'add_layer').args.url
  assert.equal((await call('GET', inline)).status, 200)
  const lastId = open.ids.at(-1)
  open.close()
  const watching = page()
  await watching.until(() => watching.messages.some(m => m.op === 'add_layer'))
  watching.messages.length = 0
  // The page reports its layers, as a real one does after a command.
  await call('POST', '/state', { body: { state: { layers: [{ id: 'L1', title: 'Graphics', type: 'graphics', count: 1 }], center: [7, 8], zoom: 6 } } })

  assert.equal((await call('POST', '/clear', { headers: { 'x-map-pane-token': '' } })).status, 403, 'the token is required')
  assert.equal(JSON.parse((await call('GET', '/state')).text).layers.length, 1, 'a refused clear changes nothing')
  const res = await call('POST', '/clear')
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.text).state, { layers: [], center: [7, 8], zoom: 6, isConnected: true }, 'layers gone, view kept')
  await watching.until(() => watching.messages.length)
  assert.deepEqual(watching.messages.map(m => m.op), ['reset'])
  assert.equal((await call('GET', inline)).status, 404, 'the inline GeoJSON file of a cleared layer is gone')

  const back = page({ lastEventId: lastId })
  await back.until(() => back.messages.length)
  await sleep(100)
  assert.deepEqual(back.messages.filter(m => m.op !== 'go_to').map(m => m.op), ['reset'], 'nothing from before the clear')
  watching.close()
  back.close()
})

test('a bridge that cannot get its port says so and exits', { timeout: 15000 }, async () => {
  const second = await startBridge(PORT)
  assert.match(second.lines.find(line => line.startsWith('BRIDGE down')), /port 18765 is held/)
  await stopBridge(second)
})

test('a timeout that is zero or not a number keeps the 15 s default', async () => {
  const odd = await startBridge(OTHER_PORT, { MAP_PANE_TIMEOUT_MS: 'abc' })
  const slow = page({ port: OTHER_PORT, answer: () => sleep(300).then(() => ({ ok: true, result: {} })) })
  await slow.until(() => slow.messages.length)
  assert.equal((await cmd('clear_graphics', {}, OTHER_PORT)).status, 200)
  slow.close()
  await stopBridge(odd)
})

test('a page that closes without answering does not hold up the others: the error answers at once', async () => {
  const failing = page({ answer: () => ({ ok: false, error: 'broken page' }) })
  const silent = page({ answer: () => undefined })
  await failing.until(() => failing.messages.length)
  await silent.until(() => silent.messages.length)
  const t0 = Date.now()
  setTimeout(() => silent.close(), 100)
  const res = await cmd('clear_graphics')
  assert.equal(res.error, 'broken page')
  assert.ok(Date.now() - t0 < 700, `answered in ${Date.now() - t0} ms, not at the 1000 ms timeout`)
  failing.close()

  const last = page({ answer: () => undefined })
  await last.until(() => last.messages.length)
  setTimeout(() => last.close(), 100)
  assert.equal((await cmd('clear_graphics')).error, 'every target map page closed before it answered')
})

test('inline GeoJSON of a layer every page refused is no longer served', async () => {
  const refusing = page({ answer: m => (m.op === 'add_layer' ? { ok: false, error: 'bad layer' } : { ok: true, result: {} }) })
  await refusing.until(() => refusing.messages.length)
  const res = await cmd('add_layer', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  assert.equal(res.error, 'bad layer')
  const url = refusing.messages.find(m => m.op === 'add_layer')?.args.url
  assert.match(url, /^\/files\/.+\.geojson$/)
  assert.equal((await call('GET', url)).status, 404)
  refusing.close()
})
