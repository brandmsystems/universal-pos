-- Drops configuration, not a record of anything that happened: orders, bills and
-- payments are in app.* and untouched. Modules read as the type's defaults again
-- only once the column exists; without it no route is gated by module.
ALTER TABLE platform.entitlement_document DROP COLUMN modules;
DROP TABLE platform.tenant_module;
