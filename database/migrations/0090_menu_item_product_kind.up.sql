-- A third kind of catalogue item: `product`, a thing sold over a counter that is
-- never cooked. Single dishes and combos are unchanged.
--
-- ###########################################################################
-- A NEW KIND, NOT A RELAXED CHECK.
--
-- `menu_item_routing_matches_kind` says a station is present exactly when the
-- kind is 'single'. A shop's goods have no kitchen, so the obvious change is to
-- let a single dish go without a station -- and that removes the guarantee for
-- every restaurant: a dish nobody can route would be accepted and then fail at
-- the first KOT. Instead the kind says what the item IS. `product` is a positive
-- discriminator: no station, never fired, and the routing CHECK still reads the
-- same, because (kind = 'single') is false for a product and so is
-- (station_code IS NOT NULL).
--
-- Nothing else changes shape. A product is priced, taxed, listed per branch and
-- snapshotted onto an order line like any item (the priced-document rule is
-- about the line, not the kind). It cannot be a combo component: that FK
-- requires component_kind = 'single', and fire refuses a line with no station by
-- name rather than silently skipping it.
-- ###########################################################################
ALTER TABLE app.menu_item DROP CONSTRAINT menu_item_kind_known;
ALTER TABLE app.menu_item
  ADD CONSTRAINT menu_item_kind_known CHECK (kind IN ('single', 'combo', 'product'));
