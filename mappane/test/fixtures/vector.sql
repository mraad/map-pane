PRAGMA application_id=1196444487;
CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT, srs_id INTEGER PRIMARY KEY, organization TEXT, organization_coordsys_id INTEGER, definition TEXT, description TEXT);
INSERT INTO gpkg_spatial_ref_sys VALUES ('WGS 84',4326,'EPSG',4326,'undefined','longitude/latitude');
CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, identifier TEXT, description TEXT, last_change TEXT, min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER);
INSERT INTO gpkg_contents VALUES ('places','features','Places','','2026-01-01T00:00:00Z',-77.03,38.9,-77.03,38.9,4326);
CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z INTEGER, m INTEGER);
INSERT INTO gpkg_geometry_columns VALUES ('places','geom','POINT',4326,0,0);
CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT, geom BLOB);
INSERT INTO places VALUES (1,'DC',X'47500001e6100000010100000052b81e85eb4153c03333333333734340');
