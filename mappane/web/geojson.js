const checkCrs = (object) => {
  if (Object.hasOwn(object, "crs")) throw new Error("Expected RFC 7946 GeoJSON (WGS84, no crs member)");
};

// GeoJSON coordinates are WGS84; GeoPackage callers supply their table's CRS.
export function toGraphics(data, spatialReference = { wkid: 4326 }) {
  if (!data || typeof data !== "object") throw new Error("Expected RFC 7946 GeoJSON");
  checkCrs(data);
  const features = data.type === "FeatureCollection" ? data.features : [data.type === "Feature" ? data : { geometry: data }];
  if (!Array.isArray(features)) throw new Error("GeoJSON features must be an array");
  const graphics = [];

  const position = (p) => {
    if (!Array.isArray(p) || p.length < 2 || p.length > 3 || !p.every(Number.isFinite)) {
      throw new Error("Coordinates must contain two or three finite numbers");
    }
    return [...p];
  };
  const line = (coords, ring = false) => {
    if (!Array.isArray(coords) || coords.length < (ring ? 4 : 2)) throw new Error("Invalid GeoJSON line or ring");
    const points = coords.map(position);
    if (points.some((p) => p.length !== points[0].length)) throw new Error("Coordinate dimensions must match");
    if (ring && points[0].some((v, i) => v !== points.at(-1)[i])) throw new Error("Polygon rings must be closed");
    return points;
  };
  const polygon = (coords) => {
    if (!Array.isArray(coords) || !coords.length) throw new Error("Polygon needs an exterior ring");
    return coords.map((coords, index) => {
      const ring = line(coords, true);
      let area = 0;
      for (let i = 1; i < ring.length; i++) {
        const [x, y] = ring[i - 1];
        area = area + x * ring[i][1] - ring[i][0] * y;
      }
      // ArcGIS expects clockwise exteriors and counterclockwise holes.
      return (area > 0) === (index === 0) ? ring.reverse() : ring;
    });
  };
  const list = (coords) => {
    if (!Array.isArray(coords) || !coords.length) throw new Error("Geometry coordinates must be a nonempty array");
    return coords;
  };
  const add = (geometry, attributes, depth = 0) => {
    if (geometry === null) return;
    if (!geometry || depth > 32) throw new Error("Invalid or excessively nested geometry");
    checkCrs(geometry);
    if (geometry.type === "GeometryCollection") {
      if (!Array.isArray(geometry.geometries)) throw new Error("GeometryCollection needs geometries");
      for (const part of geometry.geometries) add(part, attributes, depth + 1);
      return;
    }
    const c = geometry.coordinates;
    let shape;
    switch (geometry.type) {
      case "Point": {
        const [x, y, z] = position(c);
        shape = { type: "point", x, y, ...(z !== undefined && { z }) };
        break;
      }
      case "MultiPoint": shape = { type: "multipoint", points: list(c).map(position) }; break;
      case "LineString": shape = { type: "polyline", paths: [line(c)] }; break;
      case "MultiLineString": shape = { type: "polyline", paths: list(c).map((p) => line(p)) }; break;
      case "Polygon": shape = { type: "polygon", rings: polygon(c) }; break;
      case "MultiPolygon": shape = { type: "polygon", rings: list(c).flatMap(polygon) }; break;
      default: throw new Error(`Unsupported GeoJSON geometry: ${geometry.type}`);
    }
    // Each path and ring already has uniform dimensions. Compare their first positions.
    const points = shape.points ?? (shape.paths ?? shape.rings)?.map((part) => part[0]);
    if (points) {
      if (points.some((p) => p.length !== points[0].length)) throw new Error("Coordinate dimensions must match");
      shape.hasZ = points[0].length === 3;
    }
    const symbol = shape.type === "point" || shape.type === "multipoint"
      ? { type: "simple-marker", color: "#f5a623", size: 9, outline: { color: "#fff", width: 1 } }
      : shape.type === "polyline"
        ? { type: "simple-line", color: "#f5a623", width: 2 }
        : { type: "simple-fill", color: [245, 166, 35, 0.3], outline: { color: "#f5a623", width: 1.5 } };
    graphics.push({ geometry: { ...shape, spatialReference }, attributes, symbol });
  };
  for (const feature of features) {
    if (!feature || (data.type === "FeatureCollection" && feature.type !== "Feature")) throw new Error("Expected GeoJSON Features");
    checkCrs(feature);
    const attributes = feature.properties ?? {};
    if (typeof attributes !== "object" || Array.isArray(attributes)) throw new Error("Feature properties must be an object or null");
    add(feature.geometry, attributes);
  }
  return graphics;
}
