-- A restaurant's second brand colour, beside 0060's theme_color.
--
-- ###########################################################################
-- The primary colour stays what it was: buttons, focus rings and highlights.
-- The secondary is the colour of the tinted surfaces -- the band behind a name
-- on the staff login, card accents, the background glow -- so a brand with two
-- colours shows both. Optional: NULL keeps the tints derived from the primary,
-- which is what every restaurant had before.
--
-- Same shape as theme_color, for the same reason: '#rrggbb' lower-case only,
-- because a free-text colour is a CSS injection point on the restaurant's
-- own pages.
-- ###########################################################################
ALTER TABLE platform.tenant
  ADD COLUMN theme_color_secondary text
    CONSTRAINT tenant_theme_color_secondary_hex
    CHECK (theme_color_secondary IS NULL OR theme_color_secondary ~ '^#[0-9a-f]{6}$');
