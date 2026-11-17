#!/usr/bin/env node
import http from "node:http";
import { copyFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { text as readText } from "node:stream/consumers";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { BASEMAPS, HELP, httpUrl, parseCommand } from "../web/commands.js";

const PREFIX = `map-pane-command-${process.getuid()}-`;
export const commandSocket = (pid) => join(tmpdir(), `${PREFIX}${pid}.sock`);

// One request to the bridge over its socket. POST /cmd answers {ok, result, error, state}.
export function request(socketPath, path, body) {
  return new Promise((ok, fail) => {
    const req = http.request({ socketPath, path, method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" } }, (res) => {
      readText(res).then((text) => {
        const reply = JSON.parse(text);
        if (res.statusCode !== 200 || reply.ok === false) throw new Error(reply.error ?? `HTTP ${res.statusCode}`);
        ok(reply);
      }).catch(fail);
    });
    req.setTimeout(125_000, () => req.destroy(new Error("Map command timed out")));
    req.on("error", fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
export const sendCommand = async (socketPath, cmd) => (await request(socketPath, "/cmd", cmd)).result;

// A parsed CLI command (parseCommand) as the bridge's {op, args}. clear is the bridge's own /clear.
// Data commands keep the current extent (zoomTo false); run zoom afterwards.
export function toOp(command) {
  const { command: name, ...input } = command;
  switch (name) {
    case "extent": return { op: "extent", args: {} };
    case "zoom": return { op: "zoom", args: input.value ? { layer: input.value } : {} };
    case "go_to": return input.mode === "location"
      ? { op: "go_to", args: { location: input.location } }
      : { op: "go_to", args: { center: [input.longitude, input.latitude], ...(input.zoom !== undefined && { zoom: input.zoom }) } };
    case "remove": return { op: "remove_layer", args: { id: input.layer } };
    case "update-layer": {
      const { layer, title, renderer, labels, filter, opacity, visible } = input;
      const args = { id: layer, title, renderer, labelingInfo: labels && [labels].flat(), definitionExpression: filter };
      if (opacity !== undefined) {
        args.opacity = opacity.trim() ? Number(opacity) : NaN;
        if (!(args.opacity >= 0 && args.opacity <= 1)) throw new Error("--opacity must be between 0 and 1");
      }
      if (visible !== undefined) {
        if (!["true", "false"].includes(visible)) throw new Error("--visible must be true or false");
        args.visible = visible === "true";
      }
      if (Object.values(args).filter((value) => value !== undefined).length < 2) {
        throw new Error("update-layer needs at least one of --title, --renderer, --labels, --filter, --opacity, --visible");
      }
      return { op: "update_layer", args: JSON.parse(JSON.stringify(args)) };
    }
    case "screenshot": return { op: "screenshot", args: {} };
    case "basemap":
      if (input.list) return { op: "list_basemaps", args: {} };
      return input.value ? { op: "set_basemap", args: { basemap: input.value } } : { op: "get_basemap", args: {} };
    case "login": return { op: "login", args: input };
    case "save-webmap": return { op: "save_webmap", args: { title: input.title } };
    case "map-service": return { op: "add_layer", args: { type: "map-image", url: input.url, zoomTo: false } };
    case "feature-service": return { op: "add_layer", args: { type: "feature", url: input.url, zoomTo: false } };
    case "geojson": return { op: "add_layer", args: { type: "geojson", url: input.url, zoomTo: false } };
    case "geopackage": return { op: "geopackage", args: input };
    case "graphics": return { op: "graphics", args: input };
    default: throw new Error(`Unknown map command: ${name}`);
  }
}

const FLAGS = { graphics: ["title", "renderer", "labels"], "update-layer": ["title", "renderer", "labels", "filter", "opacity", "visible"], login: ["portal-url", "client-id", "redirect-uri"] };
const LOGIN_WAIT = 5 * 60_000;

// OAuth 2.0 authorization code with PKCE (public client, no secret) and a loopback redirect.
// Returns the token for the page; the CLI never prints it.
async function signIn({ portalUrl, clientId, redirectUri }) {
  if (!clientId) throw new Error("login needs a client ID: pass --client-id or set MAP_PANE_CLIENT_ID");
  const portal = httpUrl(portalUrl).replace(/\/+$/, "");
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(redirect.hostname) || !redirect.port) {
    throw new Error("The redirect URI must be http://127.0.0.1:<port>/<path> or http://localhost:<port>/<path>");
  }
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const authorize = `${portal}/sharing/rest/oauth2/authorize?${new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirectUri, state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  })}`;
  const code = await new Promise((ok, fail) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      server.close();
      if (error) fail(error); else ok(value);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== redirect.pathname) return res.writeHead(404).end();
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      const valid = url.searchParams.get("state") === state && url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", connection: "close" })
        .end(valid ? "Signed in. You can close this tab." : `Sign-in failed: ${error ?? "invalid response"}`);
      finish(valid ? null : new Error(`Sign-in failed: ${error ?? "invalid state or missing code"}`), url.searchParams.get("code"));
    });
    const timer = setTimeout(() => finish(new Error("Sign-in timed out after 5 minutes")), LOGIN_WAIT);
    server.on("error", (error) => finish(error.code === "EADDRINUSE"
      ? new Error(`Port ${redirect.port} is busy: another login is waiting, or set --redirect-uri`) : error));
    server.listen(Number(redirect.port), redirect.hostname, () => {
      console.error(`Open this URL to sign in:\n${authorize}`);
      if (process.platform === "darwin" && process.env.MAP_PANE_OPEN !== "0") {
        spawn("open", [authorize], { stdio: "ignore" }).on("error", () => {}).unref();
      }
    });
  });
  const response = await fetch(`${portal}/sharing/rest/oauth2/token`, { method: "POST", body: new URLSearchParams({
    grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, f: "json",
  }) });
  const token = await response.json().catch(() => ({}));
  if (!token.access_token) throw new Error(`Token request failed: ${token.error?.message ?? token.error_description ?? `HTTP ${response.status}`}`);
  // The page refuses a login without these; fail here with the reason, not after a confusing page error.
  if (!Number.isFinite(token.expires_in) || !token.username) throw new Error("Token response has no expires_in or username");
  return {
    portalUrl: portal, clientId, token: token.access_token, expires: Date.now() + token.expires_in * 1000,
    userId: token.username, refreshToken: token.refresh_token,
  };
}

async function main() {
  const [name, ...args] = process.argv.slice(2);
  if (!name || name === "--help") {
    console.log(`Usage: bin/map-command <command>\n${HELP.replace("<GeoJSON>", "<file | - | inline JSON>").replaceAll("<JSON>", "<file | inline JSON>")}\n\nTargets the newest map. Set MAP_PANE_SOCKET to choose another map.\nbin/map-command --info prints the page URL of the map it targets.`);
    return;
  }
  const options = {};
  for (const flag of FLAGS[name] ?? []) {
    const index = args.indexOf(`--${flag}`);
    if (index < 0) continue;
    const [, value] = args.splice(index, 2);
    if (!value) throw new Error(`--${flag} needs a value`);
    options[flag] = value;
  }
  for (const flag of ["renderer", "labels"]) {
    const value = options[flag];
    if (value) options[flag] = JSON.parse(/^\s*[[{]/.test(value) ? value : await readFile(value, "utf8"));
  }
  let text = args.join(" ");
  if (name === "graphics" && !text.trimStart().startsWith("{")) {
    if (!text || text === "-") {
      text = await readText(process.stdin);
    } else text = await readFile(text, "utf8");
  }
  // The page cannot write files: the CLI keeps the screenshot path and writes the PNG itself.
  // login flags configure the sign-in here; they are not sent to the page.
  const { file, ...command } = name === "--info" ? {} : { ...parseCommand(`${name} ${text}`), ...(name === "login" ? {} : options) };
  let sockets = [process.env.MAP_PANE_SOCKET];
  if (!sockets[0]) {
    const entries = await readdir(tmpdir());
    const candidates = await Promise.all(entries.filter((name) => name.startsWith(PREFIX) && name.endsWith(".sock")).map(async (name) => {
      const path = join(tmpdir(), name);
      const info = await stat(path).catch(() => null);
      return info?.isSocket() ? { path, time: info.mtimeMs } : null;
    }));
    sockets = candidates.filter(Boolean).sort((a, b) => b.time - a.time).map((c) => c.path);
  }
  const send = async (path, body) => {
    for (const socket of sockets) {
      try {
        return await request(socket, path, body);
      } catch (error) {
        if (process.env.MAP_PANE_SOCKET || !["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
      }
    }
    throw Object.assign(new Error("No running map found. Start bin/map-pane --split first (or /map in Claude Code)."), { noMap: true });
  };
  if (name === "--info") {
    console.log(JSON.stringify(await send("/api/info"), null, 2));
    return;
  }
  if (command.command === "clear") {
    console.log(JSON.stringify((await send("/clear", {})).state, null, 2));
    return;
  }
  if (command.command === "login") {
    await send("/cmd", toOp({ command: "extent" })); // Fail before the sign-in if no map is ready.
    Object.assign(command, await signIn({
      portalUrl: options["portal-url"] || process.env.MAP_PANE_PORTAL_URL || "https://www.arcgis.com",
      clientId: options["client-id"] || process.env.MAP_PANE_CLIENT_ID,
      redirectUri: options["redirect-uri"] || process.env.MAP_PANE_REDIRECT_URI || "http://127.0.0.1:8766/",
    }));
  }
  // Sign-in status lives in the map page: with no map, list the built-in ids only.
  if (command.list) {
    const reply = await send("/cmd", toOp(command)).catch((error) => {
      if (!error.noMap && !["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
      console.error("No running map: the sign-in status is unknown. Styles need login; portal basemaps need a running map.");
      return { result: BASEMAPS };
    });
    console.log(JSON.stringify(reply.result, null, 2));
    return;
  }
  let { result } = await send("/cmd", toOp(command));
  // The bridge saves the PNG in its data folder: copy it to the file asked for.
  if (file) {
    await copyFile(result.path, file);
    result = { file: resolve(file), width: result.width, height: result.height };
  }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) main().catch((error) => { console.error(`map-command: ${error.message}`); process.exitCode = 1; });
