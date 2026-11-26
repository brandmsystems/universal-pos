-- A new restaurant slug has hyphens only between letters or digits.
--
-- `tenant_slug_format` (0003) allowed `abc--cafe` and `abc-`: both are legal
-- URL paths and both are ugly, mistyped and easy to confuse with the slug
-- they nearly match. `slugify` never produces them; this holds anything else
-- that writes a slug -- the form's hand-edited field, a script -- to the same
-- shape (`slugProblem` in packages/shared refuses them first, with a sentence).
--
-- NOT VALID: it binds every INSERT and UPDATE from now on and leaves rows that
-- already exist alone. A restaurant already trading at such an address keeps
-- it -- its tablets, setup codes and printed links all carry the slug -- and
-- routing (SLUG_PATTERN) still accepts it. Validating would mean renaming a
-- live restaurant to satisfy a cosmetic rule.
ALTER TABLE platform.tenant
  ADD CONSTRAINT tenant_slug_clean
  CHECK (slug::text !~ '--' AND slug::text !~ '-$') NOT VALID;
