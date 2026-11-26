-- Restores the two-kind CHECK for NEW rows and keeps every product already
-- written. A product is a catalogue record that orders and bills may point at;
-- deleting or rewriting it to fit the old list would destroy exactly what a
-- rollback must not, and there is no station to turn it into a single dish.
-- NOT VALID is what lets the old rule apply going forward while those rows
-- stand; migrating up again replaces it with the three-kind CHECK.
ALTER TABLE app.menu_item DROP CONSTRAINT menu_item_kind_known;
ALTER TABLE app.menu_item
  ADD CONSTRAINT menu_item_kind_known CHECK (kind IN ('single', 'combo')) NOT VALID;
