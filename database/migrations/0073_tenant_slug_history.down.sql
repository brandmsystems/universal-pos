-- Rolling back forgets former addresses: old links stop resolving. The current
-- slugs on platform.tenant are untouched.
DROP FUNCTION platform.tenant_id_for_slug(text);
DROP TRIGGER tenant_slug_history_unclaimed ON platform.tenant_slug_history;
DROP TRIGGER tenant_slug_unclaimed ON platform.tenant;
DROP FUNCTION platform.assert_slug_unclaimed();
DROP TABLE platform.tenant_slug_history;
