import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { httpUrl } from "../web/commands.js";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// OGC GeoPackageBinary header followed by ISO WKB (core simple features).
// shortcut: vector simple features only; add tile/curve decoding when those inputs are needed.
export function decodeGeometry(bytes, srsId) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes[0] !== 71 || bytes[1] !== 80 || bytes[2] !== 0) {
    throw new Error("Invalid GeoPackage geometry header");
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[3];
  const envelope = [0, 4, 6, 6, 8][(flags >> 1) & 7];
  if ((flags & 0xe0) || envelope === undefined) throw new Error("Unsupported GeoPackage geometry flags");
  if (data.getInt32(4, !!(flags & 1)) !== srsId) throw new Error("Geometry CRS differs from its table");
  let offset = 8 + envelope * 8;
  if (offset > bytes.length) throw new Error("Truncated GeoPackage envelope");
  if (flags & 16) return null;

  const geometry = (depth = 0) => {
    if (depth > 32) throw new Error("GeoPackage geometry nesting exceeds 32");
    const endian = data.getUint8(offset++);
    if (endian > 1) throw new Error("Invalid WKB byte order");
    const little = endian === 1;
    const uint = () => { const n = data.getUint32(offset, little); offset += 4; return n; };
    const code = uint();
    const type = code % 1000;
    const dimensions = Math.floor(code / 1000);
    if (dimensions > 3 || type < 1 || type > 7) throw new Error(`Unsupported WKB geometry type ${code} (curves are not supported)`);
    const hasZ = dimensions === 1 || dimensions === 3;
    const width = 2 + (hasZ ? 1 : 0) + (dimensions >= 2 ? 1 : 0);
    const point = (allowEmpty = false) => {
      const p = [];
      for (let i = 0; i < width; i++) {
        const n = data.getFloat64(offset, little);
        offset += 8;
        if (i < 2 || (i === 2 && hasZ)) {
          p.push(n);
        }
      }
      if (allowEmpty && p.every(Number.isNaN)) return [];
      if (!p.every(Number.isFinite)) throw new Error("Non-finite GeoPackage coordinate");
      return p;
    };
    const array = (read, minimumBytes) => {
      const count = uint();
      if (count > (bytes.length - offset) / minimumBytes) throw new Error("Truncated WKB geometry");
      return Array.from({ length: count }, () => read());
    };
    if (type === 1) return { type: "Point", coordinates: point(true) };
    if (type === 2) return { type: "LineString", coordinates: array(point, width * 8) };
    if (type === 3) return { type: "Polygon", coordinates: array(() => array(point, width * 8), 4) };
    const children = array(() => geometry(depth + 1), 5);
    if (type === 7) return { type: "GeometryCollection", geometries: children.filter((child) => (child.coordinates ?? child.geometries).length) };
    const childType = ["Point", "LineString", "Polygon"][type - 4];
    if (children.some((child) => child.type !== childType)) throw new Error("Invalid WKB multi-geometry member");
    return { type: `Multi${childType}`, coordinates: children.filter((child) => child.coordinates.length).map((child) => child.coordinates) };
  };
  const result = geometry();
  if (offset !== bytes.length) throw new Error("Unexpected bytes after WKB geometry");
  return (result.coordinates ?? result.geometries).length ? result : null;
}

const identifier = (name) => `"${name.replaceAll('"', '""')}"`;

export function readGeoPackage(file, table) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    if (!db.prepare("SELECT 1 FROM gpkg_contents WHERE data_type = 'features' LIMIT 1").get()) {
      throw new Error("No vector feature tables; tile-only GeoPackages are not supported");
    }
    const tables = db.prepare(`SELECT g.table_name, g.column_name, g.srs_id,
      s.organization, s.organization_coordsys_id, s.definition
      FROM gpkg_geometry_columns g
      JOIN gpkg_contents c ON c.table_name = g.table_name AND c.data_type = 'features'
      JOIN gpkg_spatial_ref_sys s ON s.srs_id = g.srs_id`).all();
    const selected = table ? tables.filter((t) => t.table_name === table) : tables;
    if (!selected.length) throw new Error(`No vector feature tables${table ? ` named ${table}` : ""}; available: ${tables.map((t) => t.table_name).join(", ") || "none (tile-only packages are not supported)"}`);
    let count = 0;
    return selected.map((t) => {
      let spatialReference;
      if (t.organization.toUpperCase() === "EPSG" && t.organization_coordsys_id > 0) {
        spatialReference = { wkid: t.organization_coordsys_id };
      } else if (t.definition && t.definition.toLowerCase() !== "undefined") {
        spatialReference = { wkt: t.definition };
      } else throw new Error(`Undefined CRS in GeoPackage table ${t.table_name}`);
      const statement = db.prepare(`SELECT * FROM ${identifier(t.table_name)}`);
      statement.setReadBigInts(true);
      const features = [];
      for (const row of statement.iterate()) {
        if (++count > 100_000) throw new Error("GeoPackage exceeds 100,000 features; export a smaller subset");
        const blob = row[t.column_name];
        const geometry = blob === null ? null : decodeGeometry(blob, t.srs_id);
        const properties = Object.fromEntries(Object.entries(row).filter(([key]) => key !== t.column_name).map(([key, value]) => [key,
          typeof value === "bigint" ? (Number.isSafeInteger(Number(value)) ? Number(value) : String(value))
            : value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value,
        ]));
        features.push({ type: "Feature", geometry, properties });
      }
      return { title: t.table_name, spatialReference, data: { type: "FeatureCollection", features } };
    });
  } finally {
    db.close();
  }
}

export function readGeoPackageIsolated(file, table, timeout = 30_000) {
  return new Promise((ok, fail) => {
    const child = execFile(process.execPath, [fileURLToPath(import.meta.url), file, table ?? ""], {
      timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      process.off("exit", stop);
      if (error) {
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return fail(new Error("Converted GeoPackage exceeds 64 MiB"));
        if (error.killed) return fail(new Error("GeoPackage conversion timed out"));
        return fail(new Error(stderr.trim() || error.message));
      }
      try { ok(JSON.parse(stdout)); } catch (error) { fail(error); }
    });
    const stop = () => child.kill("SIGKILL");
    process.once("exit", stop);
  });
}

export async function loadGeoPackage(url, table) {
  const dir = await mkdtemp(join(tmpdir(), "map-geopackage-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.once("exit", cleanup);
  try {
    const response = await fetch(httpUrl(url), { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GeoPackage download failed: HTTP ${response.status}`);
    }
    const file = join(dir, "data.gpkg");
    await pipeline(response.body, async function* (chunks) {
      let size = 0;
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) throw new Error("GeoPackage exceeds the 64 MiB download limit");
        yield chunk;
      }
    }, createWriteStream(file));
    return await readGeoPackageIsolated(file, table);
  } finally {
    await rm(dir, { recursive: true, force: true });
    process.off("exit", cleanup);
  }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(readGeoPackage(process.argv[2], process.argv[3]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
