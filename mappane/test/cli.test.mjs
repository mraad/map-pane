// bin/map-command against a real bridge (web/server.mjs) and a fake map page. No Chrome, no network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { Readable } from "node:stream";
import { arcctlSession, connect, run, request, toOp } from "../cli/command.mjs";
import { BASEMAPS } from "../web/commands.js";

const ROOT = join(import.meta.dirname, "..");
const tmp = mkdtempSync("/tmp/map-command-test-");
let bridge, url, socket;

// Starts a bridge on a free port; resolves on its `bridge:` or `BRIDGE down` line.
function startBridge(env = {}) {
  const child = spawn(process.execPath, [join(ROOT, "web/server.mjs"), "0"], { env: {
    ...process.env, TMPDIR: tmp, CHROME: "/usr/bin/false", MAP_PANE_TOKEN: "test-token", MAP_PANE_EXTENT: "", ...env,
  } });
  child.out = "";
  return new Promise((ok, fail) => {
    child.stdout.on("data", (d) => {
      child.out += d;
      // Ready once the socket listens (after `bridge:`), or down.
      if (/^SOCKET .*\n|^BRIDGE down .*\n/m.test(child.out)) ok(child);
    });
    child.on("exit", () => ok(child));
    child.on("error", fail);
  });
}

before(async () => {
  bridge = await startBridge({ MAP_PANE_BASEMAP: "gray-vector", MAP_PANE_CENTER: "51.5,-0.12", MAP_PANE_ZOOM: "7" });
  url = bridge.out.match(/^bridge: (\S+)/m)[1];
  socket = bridge.out.match(/^SOCKET (\S+)/m)[1];
});
after(async () => {
  if (bridge?.exitCode === null) {
    const exited = once(bridge, "exit");
    bridge.kill();
    await exited;
  }
  try {
    assert.throws(() => statSync(socket), { code: "ENOENT" }, "the bridge removes its socket on exit");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// A map page as the bridge sees it: reads commands from SSE /events and answers each with POST /ack.
async function page(t) {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${url}events`, { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let text = "";
  const next = async () => {
    while (true) {
      // Commands only: skip the version event and the reset a new page gets first.
      const match = text.match(/(?:^|\n)(?:id: [^\n]+\n)?data: ([^\n]+)\n\n/);
      if (match) {
        text = text.slice(match.index + match[0].length);
        const message = JSON.parse(match[1]);
        if (message.id != null && !message.replay) return message;
        continue;
      }
      const { value, done } = await reader.read();
      assert.equal(done, false);
      text += new TextDecoder().decode(value).replace(/event: version\ndata: \w+\n\n/, "");
    }
  };
  const reply = async (message, result, error) => {
    const res = await fetch(`${url}ack`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(error ? { id: message.id, tab: message.tab, ok: false, error } : { id: message.id, tab: message.tab, ok: true, result }) });
    assert.equal(res.status, 200);
  };
  return { next, reply };
}

// Runs bin/map-command; the bridge's socket is found in TMPDIR unless MAP_PANE_SOCKET is set.
function cli(args, { env = {}, stdin } = {}) {
  const proc = spawn(join(ROOT, "bin/map-command"), args, { env: { ...process.env, TMPDIR: tmp, MAP_PANE_SOCKET: "", MAP_PANE_OPEN: "0", ...env } });
  let stdout = "", stderr = "";
  proc.stdout.on("data", (d) => { stdout += d; });
  proc.stderr.on("data", (d) => { stderr += d; });
  proc.stdin.end(stdin);
  return { proc, out: () => stdout, err: () => stderr, exited: once(proc, "exit").then(([code]) => code) };
}

test("the socket is owner-only and needs no token; TCP control needs MAP_PANE_TOKEN when set", async () => {
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  const info = await request(socket, "/api/info");
  assert.equal(info.url, url);
  assert.equal(info.socket, socket);
  // PORT 0: the Host check uses the bound port.
  assert.equal((await fetch(`${url}state`)).status, 200);
  const tcp = await fetch(`${url}clear`, { method: "POST", body: "{}" });
  assert.equal(tcp.status, 403, "no token over TCP");
  assert.match((await request(socket, "/cmd", { op: "extent" }).catch((e) => e)).message, /No map page is open/);
});

test("the page is served as fixed files under one version; other paths are not", async () => {
  const html = await (await fetch(url)).text();
  assert.match(html, /<arcgis-legend slot="bottom-right" hidden>/);
  const app = await (await fetch(`${url}app.js`)).text();
  assert.match(app, /const PAGE_VERSION = '[0-9a-f]{12}'/);
  for (const file of ["map-commands.js", "commands.js", "geojson.js"]) assert.equal((await fetch(`${url}${file}`)).status, 200, file);
  for (const path of ["server.mjs", "..%2fweb%2fserver.mjs", "..%2fcli%2fcommand.mjs"]) assert.equal((await fetch(`${url}${path}`)).status, 404, path);
});

test("the bridge serves the start view from MAP_PANE_* variables and refuses bad ones at startup", async () => {
  assert.deepEqual(await (await fetch(`${url}api/start`)).json(), { basemap: "gray-vector", center: [-0.12, 51.5], zoom: 7 });
  const bad = await startBridge({ MAP_PANE_ZOOM: "30", MAP_PANE_CENTER: "0,0" });
  if (bad.exitCode === null) await once(bad, "exit");
  assert.equal(bad.exitCode, 1);
  assert.match(bad.out, /^BRIDGE down MAP_PANE_ZOOM must be between 0 and 23$/m);
  assert.doesNotMatch(bad.out, /^bridge:/m);
});

test("run() and connect() are the CLI as calls: same ops, results returned, errors thrown", { timeout: 10_000 }, async (t) => {
  const map = await page(t);
  const calls = [
    [() => run(["go_to", "coordinate", 30.2672, -97.7431, 12], { socket }), { op: "go_to", args: { center: [-97.7431, 30.2672], zoom: 12 } }],
    [() => run(["js", "-", "--read-only"], { socket, stdin: Readable.from(["return 3"]) }), { op: "run_js", args: { code: "return 3", readOnly: true } }],
    [() => connect({ socket }).command({ op: "extent", args: {} }), { op: "extent", args: {} }],
  ];
  for (const [call, expected] of calls) {
    const pending = call();
    const message = await map.next();
    assert.deepEqual({ op: message.op, args: message.args }, expected);
    await map.reply(message, { echo: message.op });
    assert.deepEqual(await pending, { echo: message.op });
  }
  assert.equal((await connect({ socket }).info()).socket, socket);
  const failed = assert.rejects(run(["basemap", "osm"], { socket }), /basemap failed/); // handler attached before the reply
  await map.reply(await map.next(), undefined, "basemap failed");
  await failed;
  await assert.rejects(run(["extent"], { socket: join(tmp, "missing.sock") }), { code: "ENOENT", noMap: true });
});

test("CLI verbs become bridge ops; results and page errors come back", { timeout: 10_000 }, async (t) => {
  const map = await page(t);
  const data = { type: "Point", coordinates: [-77, 39] };
  const file = join(tmp, "point.geojson");
  writeFileSync(file, JSON.stringify(data));
  const script = join(tmp, "my scripts.js"); // a space in the name
  writeFileSync(script, "return 1");
  const cases = [
    [["extent"], { op: "extent", args: {} }],
    [["zoom", "L3"], { op: "zoom", args: { layer: "L3" } }],
    [["remove", "L3"], { op: "remove_layer", args: { id: "L3" } }],
    [["reorder", "My", "layer", "top"], { op: "reorder_layer", args: { id: "My layer", index: "top" } }],
    [["reorder", "L3", "2"], { op: "reorder_layer", args: { id: "L3", index: 2 } }],
    [["update-layer", "My", "layer", "--renderer", '{"type":"simple"}', "--labels", '{"labelPlacement":"above-center"}', "--opacity", "0", "--visible", "false", "--filter", "n > 1"],
      { op: "update_layer", args: { id: "My layer", renderer: { type: "simple" }, labelingInfo: [{ labelPlacement: "above-center" }], opacity: 0, visible: false, definitionExpression: "n > 1" } }],
    [["go_to", "location", "380 New York St, Redlands, CA 92373"], { op: "go_to", args: { location: "380 New York St, Redlands, CA 92373" } }],
    [["go_to", "coordinate", "30.2672", "-97.7431", "12"], { op: "go_to", args: { center: [-97.7431, 30.2672], zoom: 12 } }],
    [["basemap", "satellite"], { op: "set_basemap", args: { basemap: "satellite" } }],
    [["basemap"], { op: "get_basemap", args: {} }],
    [["basemap", "list"], { op: "list_basemaps", args: {} }],
    [["feature-service", "https://example.com/FeatureServer"], { op: "add_layer", args: { type: "feature", url: "https://example.com/FeatureServer", zoomTo: false } }],
    [["graphics", file, "--title", "Points"], { op: "graphics", args: { data, title: "Points" } }],
    [["graphics", "-", "--title", "Piped"], { op: "graphics", args: { data, title: "Piped" } }, JSON.stringify(data)],
    [["save-webmap", "My map"], { op: "save_webmap", args: { title: "My map" } }],
    [["js", "return view.zoom", "--read-only", "--timeout", "5000"], { op: "run_js", args: { code: "return view.zoom", timeoutMs: 5000, readOnly: true } }],
    [["js", "map.removeAll()"], { op: "run_js", args: { code: "map.removeAll()" } }],
    [["js", script, "--read-only"], { op: "run_js", args: { code: "return 1", readOnly: true } }],
    [["js", "-"], { op: "run_js", args: { code: "return 2" } }, "return 2"],
    [["js", "return a .js"], { op: "run_js", args: { code: "return a .js" } }],
  ];
  for (const [args, expected, stdin] of cases) {
    const run = cli(args, { stdin });
    const message = await map.next();
    assert.deepEqual({ op: message.op, args: message.args }, expected, args.join(" "));
    await map.reply(message, { echo: message.op });
    assert.equal(await run.exited, 0, run.err());
    assert.deepEqual(JSON.parse(run.out()), { echo: message.op });
  }
  const failed = cli(["basemap", "osm"]);
  await map.reply(await map.next(), undefined, "basemap failed");
  assert.equal(await failed.exited, 1);
  assert.match(failed.err(), /map-command: basemap failed/);
});

test("CLI screenshot copies the PNG the bridge saved to the file asked for", { timeout: 10_000 }, async (t) => {
  const map = await page(t);
  const file = join(tmp, "shot.png");
  const run = cli(["screenshot", file]);
  const message = await map.next();
  assert.deepEqual([message.op, message.args], ["screenshot", {}]);
  await map.reply(message, { dataUrl: `data:image/png;base64,${Buffer.from("PNG").toString("base64")}`, width: 2, height: 1 });
  assert.equal(await run.exited, 0, run.err());
  assert.deepEqual(JSON.parse(run.out()), { file, width: 2, height: 1 });
  assert.equal(readFileSync(file, "utf8"), "PNG");
  const data = readdirSync(tmp).filter((name) => name.startsWith("map-pane-data-"));
  assert.deepEqual(data.flatMap((dir) => readdirSync(join(tmp, dir))).filter((name) => name.endsWith(".png")), [], "the bridge's copy is removed");
});

test("the CLI skips a stale socket that a killed bridge left behind", { timeout: 10_000 }, async (t) => {
  const map = await page(t);
  // A newer socket file that refuses connections: its process was killed before it could remove it.
  const stale = join(tmp, `map-pane-${process.getuid()}`, "command-999999.sock");
  const holder = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(stale)}, () => console.log("up"))`]);
  await once(holder.stdout, "data");
  holder.kill("SIGKILL");
  await once(holder, "exit");
  t.after(() => rmSync(stale, { force: true }));
  assert.ok(statSync(stale).isSocket() && statSync(stale).mtimeMs >= statSync(socket).mtimeMs);
  const run = cli(["extent"]);
  const message = await map.next();
  await map.reply(message, { xmin: 0 });
  assert.equal(await run.exited, 0, run.err());
  assert.deepEqual(JSON.parse(run.out()), { xmin: 0 });
});

test("a GeoPackage URL reaches the page as decoded graphics layers and is logged for replay", { timeout: 10_000 }, async (t) => {
  const file = join(tmp, "v.gpkg");
  const db = new DatabaseSync(file);
  db.exec(readFileSync(join(ROOT, "test/fixtures/vector.sql"), "utf8"));
  db.close();
  const fixture = http.createServer((req, res) => res.end(readFileSync(file)));
  await new Promise((ok) => fixture.listen(0, "127.0.0.1", ok));
  t.after(() => fixture.close());
  const map = await page(t);
  const run = cli(["geopackage", `http://127.0.0.1:${fixture.address().port}/v.gpkg`]);
  const message = await map.next();
  assert.equal(message.op, "graphics");
  assert.ok(message.args.layers.length > 0 && message.args.layers.every((l) => l.title && l.data), "tables decoded in the bridge");
  await map.reply(message, { layers: [] });
  assert.equal(await run.exited, 0, run.err());
  // A page that connects later replays it with the same layer id.
  const late = await fetch(`${url}events`);
  const reader = late.body.getReader();
  let text = "";
  while (!text.includes(`"layerId":"${message.layerId}"`)) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(text, /"op":"graphics"/);
});

test("CLI clear empties the map through the bridge's /clear; --info names the map", async (t) => {
  const run = cli(["clear"]);
  assert.equal(await run.exited, 0, run.err());
  assert.deepEqual(JSON.parse(run.out()).layers, []);
  const info = cli(["--info"]);
  assert.equal(await info.exited, 0, info.err());
  assert.equal(JSON.parse(info.out()).url, url);
});

test("CLI login runs PKCE against the portal, hands the token to the page, never logs or prints it", { timeout: 10_000 }, async (t) => {
  const map = await page(t);
  let challenge;
  const portal = http.createServer(async (req, res) => {
    if (req.url !== "/sharing/rest/oauth2/token") return res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const valid = form.get("grant_type") === "authorization_code" && form.get("code") === "the-code" && form.get("client_id") === "cid"
      && createHash("sha256").update(form.get("code_verifier")).digest("base64url") === challenge;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(valid ? { access_token: "SECRET-TOKEN", expires_in: 1800, username: "u1", refresh_token: "R" } : { error: { message: "bad PKCE" } }));
  });
  await new Promise((ok) => portal.listen(0, "127.0.0.1", ok));
  t.after(() => portal.close());
  const free = http.createServer();
  await new Promise((ok) => free.listen(0, "127.0.0.1", ok));
  const redirect = `http://127.0.0.1:${free.address().port}/callback`;
  await new Promise((ok) => free.close(ok));

  const env = { MAP_PANE_PORTAL_URL: `http://127.0.0.1:${portal.address().port}/`, MAP_PANE_REDIRECT_URI: redirect };
  // A callback without the state the CLI sent (a forged sign-in) is refused before any token request.
  const forged = cli(["login", "--client-id", "cid"], { env });
  await map.reply(await map.next(), {});
  while (!/oauth2\/authorize/.test(forged.err())) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal((await fetch(`${redirect}?code=the-code&state=wrong`)).status, 200);
  assert.equal(await forged.exited, 1);
  assert.match(forged.err(), /Sign-in failed: invalid state or missing code/);

  const run = cli(["login", "--client-id", "cid"], { env });
  const probe = await map.next();
  assert.equal(probe.op, "extent", "login checks the map before the sign-in");
  await map.reply(probe, {});
  let authorize;
  while (!(authorize = run.err().match(/https?:\/\/\S+oauth2\/authorize\S+/)?.[0])) await new Promise((ok) => setTimeout(ok, 20));
  const params = new URL(authorize).searchParams;
  assert.deepEqual([params.get("client_id"), params.get("response_type"), params.get("redirect_uri"), params.get("code_challenge_method")],
    ["cid", "code", redirect, "S256"]);
  challenge = params.get("code_challenge");
  assert.equal((await fetch(`${redirect}?code=the-code&state=${params.get("state")}`)).status, 200);
  const login = await map.next();
  assert.equal(login.op, "login");
  assert.equal(login.args.token, "SECRET-TOKEN");
  assert.deepEqual([login.args.userId, login.args.clientId, login.args.refreshToken, login.args.portalUrl],
    ["u1", "cid", "R", `http://127.0.0.1:${portal.address().port}`]);
  await map.reply(login, { user: "u1" });
  assert.equal(await run.exited, 0, run.err());
  assert.equal(JSON.parse(run.out()).user, "u1");
  assert.doesNotMatch(run.out() + run.err(), /SECRET-TOKEN/);
  // Kept in bridge memory (not the log): a page that connects now is signed in by a login replay.
  const late = await fetch(`${url}events`);
  const reader = late.body.getReader();
  let text = "";
  while (!text.includes('"op":"login"')) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(text, /"op":"login","args":\{[^}]*"token":"SECRET-TOKEN"/);
});

// A fake portal for login --arcctl: renews with the refresh token and names the user; records each request.
async function arcctlPortal(t) {
  const requests = [];
  const portal = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    requests.push({ url: req.url, form });
    res.setHeader("content-type", "application/json");
    if (req.url === "/sharing/rest/oauth2/token" && form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "R" && form.get("client_id") === "cid") {
      return res.end(JSON.stringify({ access_token: "RENEWED-TOKEN", expires_in: 1800 }));
    }
    if (req.url === "/sharing/rest/community/self" && ["ARCCTL-TOKEN", "RENEWED-TOKEN"].includes(form.get("token"))) return res.end(JSON.stringify({ username: "u1" }));
    res.end(JSON.stringify({ error: { message: "bad request" } }));
  });
  await new Promise((ok) => portal.listen(0, "127.0.0.1", ok));
  t.after(() => portal.close());
  return { url: `http://127.0.0.1:${portal.address().port}`, requests };
}
// An arcctl config dir whose config.json holds `session` (mode 0600 unless given).
function arcctlDir(session, mode = 0o600) {
  const dir = mkdtempSync(join(tmp, "arcctl-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ portal_url: session?.portal, ...(session && { session }) }));
  chmodSync(join(dir, "config.json"), mode);
  return dir;
}
const hour = () => new Date(Date.now() + 3_600_000).toISOString();

test("CLI login --arcctl hands arcctl's saved session to the page, never prints it, never writes the file", { timeout: 10_000 }, async (t) => {
  const map = await page(t);
  const portal = await arcctlPortal(t);
  const dir = arcctlDir({ token: "ARCCTL-TOKEN", portal: `${portal.url}/`, expires_at: hour(), refresh_token: "R", refresh_expires_at: hour(), client_id: "cid" });
  const before = readFileSync(join(dir, "config.json"));
  const run = cli(["login", "--arcctl"], { env: { ARCCTL_CONFIG_DIR: dir, MAP_PANE_PORTAL_URL: "" } });
  await map.reply(await map.next(), {}); // the extent probe
  const login = await map.next();
  assert.equal(login.op, "login");
  assert.deepEqual([login.args.token, login.args.userId, login.args.clientId, login.args.refreshToken, login.args.portalUrl],
    ["ARCCTL-TOKEN", "u1", "cid", "R", portal.url]);
  await map.reply(login, { user: "u1" });
  assert.equal(await run.exited, 0, run.err());
  assert.doesNotMatch(run.out() + run.err(), /ARCCTL-TOKEN|"R"/);
  assert.deepEqual(portal.requests.map((r) => r.url), ["/sharing/rest/community/self"], "a fresh token is not renewed; the token is in the body, not the URL");
  assert.deepEqual(readFileSync(join(dir, "config.json")), before);
});

test("arcctlSession renews an expiring token in memory and refuses sessions it must not use", async (t) => {
  const portal = await arcctlPortal(t);
  const good = { token: "ARCCTL-TOKEN", portal: portal.url, expires_at: new Date(Date.now() + 30_000).toISOString(), refresh_token: "R", refresh_expires_at: hour(), client_id: "cid" };
  const previous = process.env.ARCCTL_CONFIG_DIR;
  t.after(() => { if (previous === undefined) delete process.env.ARCCTL_CONFIG_DIR; else process.env.ARCCTL_CONFIG_DIR = previous; });
  const use = (session, mode) => { process.env.ARCCTL_CONFIG_DIR = arcctlDir(session, mode); return process.env.ARCCTL_CONFIG_DIR; };
  const dir = use(good);
  const before = readFileSync(join(dir, "config.json"));
  const renewed = await arcctlSession();
  assert.equal(renewed.token, "RENEWED-TOKEN", "30 s left: renewed first");
  assert.ok(renewed.expires > Date.now() + 1_700_000);
  assert.deepEqual(readFileSync(join(dir, "config.json")), before, "renewed in memory only");
  assert.equal(await arcctlSession({ portalUrl: `${portal.url}/` }).then((s) => s.userId), "u1", "a trailing slash is the same portal");
  const count = portal.requests.length;
  use(good, 0o644);
  await assert.rejects(arcctlSession(), /must belong to you and be private/);
  use(undefined);
  await assert.rejects(arcctlSession(), /No arcctl session in/);
  process.env.ARCCTL_CONFIG_DIR = join(tmp, "no-such-arcctl");
  await assert.rejects(arcctlSession(), /does not exist/);
  use({ ...good, refresh_token: undefined, client_id: undefined });
  await assert.rejects(arcctlSession(), /cannot renew/);
  use({ ...good, refresh_expires_at: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(arcctlSession(), /has expired/);
  use(good);
  await assert.rejects(arcctlSession({ portalUrl: "https://www.arcgis.com" }), /is for http:\/\/127\.0\.0\.1:\d+, not https:\/\/www\.arcgis\.com/);
  assert.equal(portal.requests.length, count, "a refused session sends nothing");
});

test("CLI login fails clearly without a client ID", { timeout: 10_000 }, async (t) => {
  const map = await page(t);
  const run = cli(["login"], { env: { MAP_PANE_CLIENT_ID: "" } });
  await map.reply(await map.next(), {});
  assert.equal(await run.exited, 1);
  assert.match(run.err(), /--client-id or set MAP_PANE_CLIENT_ID/);
});

test("basemap list with no running map prints the built-in ids and says why", async () => {
  const run = cli(["basemap", "list"], { env: { TMPDIR: mkdtempSync(join(tmp, "no-map-")) } });
  assert.equal(await run.exited, 0, run.err());
  assert.deepEqual(JSON.parse(run.out()), JSON.parse(JSON.stringify(BASEMAPS)));
  assert.match(run.err(), /No running map: the sign-in status is unknown/);
  const explicit = cli(["basemap", "list"], { env: { MAP_PANE_SOCKET: join(tmp, "missing.sock") } });
  assert.equal(await explicit.exited, 0, explicit.err());
  const current = cli(["basemap"], { env: { TMPDIR: mkdtempSync(join(tmp, "no-map-")) } });
  assert.equal(await current.exited, 1);
  assert.match(current.err(), /No running map found/);
});

test("the CLI and the bridge refuse a socket folder that other users can open", async () => {
  const dir = mkdtempSync(join(tmp, "shared-"));
  mkdirSync(join(dir, `map-pane-${process.getuid()}`), { mode: 0o755 });
  chmodSync(join(dir, `map-pane-${process.getuid()}`), 0o755);
  const run = cli(["extent"], { env: { TMPDIR: dir } });
  assert.equal(await run.exited, 1);
  assert.match(run.err(), /must be a folder that only you own/);
  const other = spawn(process.execPath, [join(ROOT, "web/server.mjs"), "0"], { env: { ...process.env, TMPDIR: dir } });
  try {
    let err = "";
    other.stderr.on("data", (d) => { err += d; });
    await new Promise((ok) => other.stderr.on("data", () => /command socket:/.test(err) && ok()));
    assert.match(err, /command socket: .*must be a folder that only you own/);
  } finally { other.kill(); }
});

test("update-layer needs one valid change", () => {
  const op = (input) => toOp({ command: "update-layer", layer: "L1", ...input });
  assert.throws(() => op({}), /at least one of/);
  for (const opacity of ["", " ", "1.5", "-0.1", "half"]) assert.throws(() => op({ opacity }), /--opacity/, opacity);
  assert.throws(() => op({ visible: "yes" }), /--visible/);
  assert.deepEqual(op({ title: "New", opacity: "1" }), { op: "update_layer", args: { id: "L1", title: "New", opacity: 1 } });
});
