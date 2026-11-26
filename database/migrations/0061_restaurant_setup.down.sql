DROP INDEX app.menu_item_barcode_unique_active;
ALTER TABLE app.menu_item
  DROP COLUMN prep_minutes,
  DROP COLUMN barcode;

ALTER TABLE app.station_code DROP COLUMN kind;

ALTER TABLE app.dining_table DROP CONSTRAINT dining_table_floor_same_branch_fk;
ALTER TABLE app.floor DROP CONSTRAINT floor_branch_scoped_key;

ALTER TABLE app.floor DROP CONSTRAINT floor_type_fk;
ALTER TABLE app.floor DROP COLUMN floor_type_id;

DROP TABLE app.floor_type;
