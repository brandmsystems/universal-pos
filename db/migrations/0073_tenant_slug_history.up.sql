-- A restaurant's address can change, and the old one keeps working.
--
-- ###########################################################################
-- 1. EVERY ADDRESS A RESTAURANT HAS HAD, KEPT.
--
-- The slug is printed on menus and QR codes, typed into tablets as the first
-- half of every setup code, stored in each tablet's identity and used in every
-- sign-in URL. Renaming without remembering the old one would orphan all of
-- them at once. So the old slug is kept here, pointing at its restaurant, and
-- `tenant_id_for_slug` resolves it: links redirect, tablets sign in, codes
-- issued before the rename still redeem.
--
-- An old slug is NEVER free for another restaurant. Handing it on would hand
-- them every old link, QR code and stranded tablet of the first -- a sign-in
-- page for B at an address A's staff still type. Only the restaurant that had
-- it may take it back, which removes the history row.
-- ###########################################################################
CREATE TABLE platform.tenant_slug_history (
  slug        extensions.citext PRIMARY KEY
              CONSTRAINT tenant_slug_history_format CHECK (slug::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  tenant_id   uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  retired_at  timestamptz NOT NULL DEFAULT now(),
  retired_by_platform_user_id uuid NOT NULL REFERENCES platform.platform_user (id) ON DELETE RESTRICT
);
CREATE INDEX tenant_slug_history_by_tenant ON platform.tenant_slug_history (tenant_id);

GRANT SELECT, INSERT, DELETE ON platform.tenant_slug_history TO katkitchen_app;
GRANT SELECT ON platform.tenant_slug_history TO katkitchen_platform_readonly;

-- ###########################################################################
-- 2. ONE ADDRESS, ONE RESTAURANT -- ACROSS BOTH TABLES, UNDER A LOCK.
--
-- A unique index cannot span two tables, and a check in the application would
-- race: two transactions each see the slug free in the other table. So a
-- trigger on BOTH tables takes a transaction-scoped advisory lock on the slug
-- and then looks in the other table. The second writer waits for the first to
-- commit and then sees its row. The application checks first only to answer
-- with a sentence; this is the authority.
-- ###########################################################################
CREATE FUNCTION platform.assert_slug_unclaimed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('tenant-slug:' || lower(NEW.slug::text), 0));
  IF TG_TABLE_NAME = 'tenant' THEN
    IF EXISTS (SELECT 1 FROM platform.tenant_slug_history h
                WHERE h.slug = NEW.slug AND h.tenant_id <> NEW.id) THEN
      RAISE EXCEPTION 'slug % is a former address of another restaurant', NEW.slug
        USING ERRCODE = '23505', CONSTRAINT = 'tenant_slug_key';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM platform.tenant t
                WHERE t.slug = NEW.slug AND t.id <> NEW.tenant_id) THEN
      RAISE EXCEPTION 'slug % is the address of another restaurant', NEW.slug
        USING ERRCODE = '23505', CONSTRAINT = 'tenant_slug_key';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tenant_slug_unclaimed
  BEFORE INSERT OR UPDATE OF slug ON platform.tenant
  FOR EACH ROW EXECUTE FUNCTION platform.assert_slug_unclaimed();
CREATE TRIGGER tenant_slug_history_unclaimed
  BEFORE INSERT ON platform.tenant_slug_history
  FOR EACH ROW EXECUTE FUNCTION platform.assert_slug_unclaimed();

-- ###########################################################################
-- 3. ONE RESOLVER, USED BY EVERY READ THAT STARTS FROM A SLUG.
--
-- Sign-in, the public lookup and the logo all begin with a slug. The current
-- address wins; a former one resolves to the restaurant that had it. One
-- definition, so the three cannot disagree about whether an old link works.
-- ###########################################################################
CREATE FUNCTION platform.tenant_id_for_slug(given text) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT id FROM platform.tenant WHERE slug = given::extensions.citext),
    (SELECT tenant_id FROM platform.tenant_slug_history WHERE slug = given::extensions.citext))
$$;
GRANT EXECUTE ON FUNCTION platform.tenant_id_for_slug(text) TO katkitchen_app, katkitchen_platform_readonly;
