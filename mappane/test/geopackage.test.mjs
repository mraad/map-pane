import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { decodeGeometry, loadGeoPackage, readGeoPackage, readGeoPackageIsolated } from "../cli/geopackage.mjs";
import { toGraphics } from "../web/geojson.js";

const sql = readFileSync(new URL("fixtures/vector.sql", import.meta.url), "utf8");
function fixture(t) {
  const dir = mkdtempSync("/tmp/map-gpkg-test-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "vector.gpkg");
  const db = new DatabaseSync(file);
  db.exec(sql);
  t.after(() => db.close());
  return { file, db };
}

test("GeoPackage feature tables preserve coordinates, properties and CRS", (t) => {
  const { file, db } = fixture(t);
  db.exec("INSERT INTO places VALUES (9007199254740993, 'large id', NULL)");
  const [layer] = readGeoPackage(file);
  assert.equal(layer.title, "places");
  assert.deepEqual(layer.spatialReference, { wkid: 4326 });
  assert.deepEqual(layer.data.features[0], {
    type: "Feature", properties: { id: 1, name: "DC" }, geometry: { type: "Point", coordinates: [-77.03, 38.9] },
  });
  assert.equal(layer.data.features[1].properties.id, "9007199254740993");
  assert.equal(layer.data.features[1].geometry, null);
  assert.throws(() => readGeoPackage(file, "missing"), /available: places/);
});

test("GeoPackage supports multiple tables, quoted identifiers and explicit table selection", (t) => {
  const { file, db } = fixture(t);
  db.exec(`CREATE TABLE "other""places" AS SELECT * FROM places;
    INSERT INTO gpkg_contents (table_name, data_type) VALUES ('other"places', 'features');
    INSERT INTO gpkg_geometry_columns VALUES ('other"places', 'geom', 'POINT', 4326, 0, 0);`);
  assert.equal(readGeoPackage(file).length, 2);
  assert.equal(readGeoPackage(file, 'other"places')[0].title, 'other"places');
  db.exec("UPDATE gpkg_spatial_ref_sys SET organization='NONE'");
  assert.throws(() => readGeoPackage(file), /Undefined CRS/);
  db.exec("UPDATE gpkg_spatial_ref_sys SET definition='GEOGCS[test]'");
  assert.deepEqual(readGeoPackage(file)[0].spatialReference, { wkt: "GEOGCS[test]" });
});

test("independent GDAL fixture decodes all core geometry types, including holes and collections", (t) => {
  const dir = mkdtempSync("/tmp/map-gpkg-gdal-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "mixed.gpkg");
  const db = new DatabaseSync(file);
  db.exec(readFileSync(new URL("fixtures/mixed.sql", import.meta.url), "utf8"));
  db.close();
  const [layer] = readGeoPackage(file);
  assert.deepEqual(layer.data.features.map((f) => f.geometry.type), [
    "Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection",
  ]);
  const graphics = toGraphics(layer.data);
  assert.equal(graphics.length, 8);
  assert.equal(graphics[2].geometry.rings.length, 2);
  assert.equal(graphics[5].geometry.rings.length, 3);
  assert.equal(graphics[7].geometry.type, "polyline");
});

test("WKB decoder handles byte order, envelopes and optional Z/M values", () => {
  for (const little of [false, true]) {
    for (const [type, ordinates, expected] of [[1, [10, 20], [10, 20]], [1001, [10, 20, 30], [10, 20, 30]], [2001, [10, 20, 40], [10, 20]], [3001, [10, 20, 30, 40], [10, 20, 30]]]) {
      const data = Buffer.alloc(8 + 32 + 5 + ordinates.length * 8);
      data.write("GP");
      data[3] = 2 | Number(little); // XY envelope
      const view = new DataView(data.buffer, data.byteOffset, data.length);
      view.setInt32(4, 4326, little);
      data[40] = Number(!little); // WKB byte order is independent of the header
      view.setUint32(41, type, !little);
      ordinates.forEach((n, i) => view.setFloat64(45 + i * 8, n, !little));
      assert.deepEqual(decodeGeometry(data, 4326), { type: "Point", coordinates: expected });
    }
  }
});

test("WKB decoder rejects malformed, truncated and unsupported geometries", (t) => {
  const { db } = fixture(t);
  const good = Buffer.from(db.prepare("SELECT geom FROM places").get().geom);
  for (const length of [0, 7, 8, 12, good.length - 1]) assert.throws(() => decodeGeometry(good.subarray(0, length), 4326));
  assert.throws(() => decodeGeometry(good, 3857), /CRS/);
  for (const flags of [0x21, 0xc1, 0x0f]) {
    const invalid = Buffer.from(good);
    invalid[3] = flags;
    assert.throws(() => decodeGeometry(invalid, 4326), /flags/);
  }
  const curve = Buffer.from(good);
  curve.writeUInt32LE(8, 9);
  assert.throws(() => decodeGeometry(curve, 4326), /curves/);
  const empty = Buffer.from(good);
  empty[3] |= 16;
  assert.equal(decodeGeometry(empty, 4326), null);
});

test("GeoPackage URL download loads a real SQLite database and reports HTTP errors", async (t) => {
  const { file } = fixture(t);
  const server = http.createServer((req, res) => {
    if (req.url === "/vector.gpkg") res.end(readFileSync(file));
    else res.writeHead(404).end();
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await loadGeoPackage(`${url}/vector.gpkg`))[0].data.features.length, 1);
  await assert.rejects(loadGeoPackage(`${url}/missing.gpkg`), /HTTP 404/);
  await assert.rejects(loadGeoPackage("file:///tmp/private.gpkg"), /HTTP/);
});

test("expensive GeoPackage views time out without blocking the parent", { timeout: 5000 }, async (t) => {
  const { file, db } = fixture(t);
  const geometry = Buffer.from(db.prepare("SELECT geom FROM places").get().geom).toString("hex");
  db.exec(`DROP TABLE places;
    CREATE VIEW places AS WITH RECURSIVE r(x) AS
    (VALUES(0) UNION ALL SELECT x+1 FROM r WHERE x<1000000000)
    SELECT count(*) AS id, 'busy' AS name, X'${geometry}' AS geom FROM r;`);
  const conversion = assert.rejects(readGeoPackageIsolated(file, undefined, 500), /conversion timed out/);
  const responsive = await Promise.race([
    new Promise((ok) => setTimeout(() => ok(true), 20)),
    conversion.then(() => false),
  ]);
  assert.equal(responsive, true, "parent runs while the conversion is still pending");
  await conversion;
  await assert.rejects(readGeoPackageIsolated(file, "missing"), /available: places/);
});

test("empty members in core GeoPackage collections preserve populated members", (t) => {
  const { db, file } = fixture(t);
  db.exec("UPDATE gpkg_geometry_columns SET geometry_type_name='GEOMETRY'");
  const header = Buffer.from(db.prepare("SELECT geom FROM places").get().geom).subarray(0, 8);
  const point = Buffer.alloc(21);
  point[0] = 1;
  point.writeUInt32LE(1, 1);
  point.writeDoubleLE(1, 5);
  point.writeDoubleLE(2, 13);
  const empty = Buffer.from(point);
  empty.writeDoubleLE(NaN, 5);
  empty.writeDoubleLE(NaN, 13);
  const collection = (type, parts) => {
    const prefix = Buffer.alloc(9);
    prefix[0] = 1;
    prefix.writeUInt32LE(type, 1);
    prefix.writeUInt32LE(parts.length, 5);
    return Buffer.concat([prefix, ...parts]);
  };
  for (const type of [4, 7]) {
    const blob = Buffer.concat([header, collection(type, [empty, point])]);
    db.prepare("UPDATE places SET geom=?").run(blob);
    const graphics = toGraphics(readGeoPackage(file)[0].data);
    assert.equal(graphics.length, 1);
    if (type === 4) assert.deepEqual(graphics[0].geometry.points, [[1, 2]]);
    else assert.deepEqual([graphics[0].geometry.x, graphics[0].geometry.y], [1, 2]);
    assert.equal(decodeGeometry(Buffer.concat([header, collection(type, [empty])]), 4326), null);
  }
  const corrupt = Buffer.from(point);
  corrupt.writeDoubleLE(NaN, 5);
  assert.throws(() => decodeGeometry(Buffer.concat([header, corrupt]), 4326), /Non-finite/);
});
