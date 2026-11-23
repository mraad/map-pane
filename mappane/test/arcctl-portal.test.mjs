// login --arcctl against a real portal, a real bridge and headless Chrome. Opt-in: skips unless set up.
// Setup (one browser sign-in, in a private dir so ~/.arcctl stays as it is):
//   export MAP_PANE_ARCCTL_DIR=$(mktemp -d)
//   ARCCTL_CONFIG_DIR=$MAP_PANE_ARCCTL_DIR arcctl login --portal "$ARCGIS_PORTAL_URL" --client-id "$ARCGIS_CLIENT_ID"
// ARCGIS_PORTAL_URL and ARCGIS_CLIENT_ID are arcctl's variables; map-pane reads them only here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serverUrl } from "./helpers/server-url.mjs";
import { openPage } from "../pane/pane.mjs";
import { commandSocket } from "../cli/command.mjs";

const ROOT = join(import.meta.dirname, "..");
const { ARCGIS_PORTAL_URL: PORTAL, ARCGIS_CLIENT_ID: CLIENT, MAP_PANE_ARCCTL_DIR: DIR } = process.env;
const missing = ["ARCGIS_PORTAL_URL", "ARCGIS_CLIENT_ID", "MAP_PANE_ARCCTL_DIR"].filter((name) => !process.env[name]);
const skip = missing.length ? `set ${missing.join(", ")} (see the setup at the top of this file)` : false;
const portal = PORTAL?.replace(/\/+$/, "");
let server, page;

const evaluate = async (expression) =>
  (await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

// bin/map-command login --arcctl against this test's map; resolves to { code, out, err }.
async function login(dir, args = []) {
  const proc = spawn(join(ROOT, "bin/map-command"), ["login", "--arcctl", ...args], { env: {
    ...process.env, ARCCTL_CONFIG_DIR: dir, MAP_PANE_SOCKET: commandSocket(server.pid), MAP_PANE_PORTAL_URL: "",
  } });
  let out = "", err = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { err += d; });
  const [code] = await once(proc, "exit");
  return { code, out, err };
}
const session = () => JSON.parse(readFileSync(join(DIR, "config.json"), "utf8")).session;

before(async (t) => {
  if (skip) return;
  server = spawn(process.execPath, [join(ROOT, "web/server.mjs")], { env: {
    ...process.env, PORT: "0", MAP_PANE_BASEMAP: "osm", MAP_PANE_CENTER: "38.90,-77.03", MAP_PANE_ZOOM: "10", MAP_PANE_EXTENT: "",
  } });
  page = await openPage(`${await serverUrl(server)}#arcctl`);
  await t.waitFor(async () => assert.ok(await evaluate("window.view?.ready")), { interval: 200, timeout: 30_000 });
});
after(() => {
  page?.close();
  server?.kill();
});

test("the arcctl session is for the portal and client this test names", { skip }, () => {
  assert.equal(session().portal.replace(/\/+$/, ""), portal);
  assert.equal(session().client_id, CLIENT);
});

test("login --arcctl signs the page in to the real portal and never prints the token", { skip, timeout: 60_000 }, async () => {
  const before = readFileSync(join(DIR, "config.json"));
  const run = await login(DIR);
  assert.equal(run.code, 0, run.err);
  const result = JSON.parse(run.out);
  assert.equal(result.portal, portal);
  assert.ok(result.user);
  assert.ok(!(run.out + run.err).includes(session().token) && !(run.out + run.err).includes(session().refresh_token));
  // The real portal accepts the shared token from inside the page.
  const username = await evaluate(`(async () => {
    const Portal = await $arcgis.import("@arcgis/core/portal/Portal.js");
    const p = new Portal({ url: ${JSON.stringify(portal)}, authMode: "immediate" });
    await p.load();
    return p.user?.username;
  })()`);
  assert.equal(username, result.user);
  assert.deepEqual(readFileSync(join(DIR, "config.json")), before, "map-pane never writes arcctl's file");
});

test("an expired access token is renewed with arcctl's client id; arcctl's file stays as it is", { skip, timeout: 60_000 }, async (t) => {
  const copy = mkdtempSync(join(tmpdir(), "arcctl-copy-"));
  t.after(() => rmSync(copy, { recursive: true, force: true })); // it holds the session's tokens
  const config = JSON.parse(readFileSync(join(DIR, "config.json"), "utf8"));
  config.session.expires_at = new Date(Date.now() - 1000).toISOString();
  writeFileSync(join(copy, "config.json"), JSON.stringify(config));
  chmodSync(join(copy, "config.json"), 0o600);
  const before = readFileSync(join(copy, "config.json"));
  const run = await login(copy);
  assert.equal(run.code, 0, run.err);
  assert.ok(Date.parse(JSON.parse(run.out).expires) > Date.now() + 60_000, "a new token with time left");
  assert.deepEqual(readFileSync(join(copy, "config.json")), before);
});

test("login --arcctl refuses another portal", { skip, timeout: 30_000 }, async () => {
  const other = portal === "https://www.arcgis.com" ? "https://example.com/portal" : "https://www.arcgis.com";
  const run = await login(DIR, ["--portal-url", other]);
  assert.equal(run.code, 1);
  assert.match(run.err, new RegExp(`is for ${portal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, not ${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});
