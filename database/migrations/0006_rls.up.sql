-- RLS is the backstop; the base repository is the primary enforcement. Neither
-- alone is sufficient: RLS does not save you from a join to a non-RLS table,
-- and the repository does not save you from raw SQL.

-- Raises rather than returning NULL. current_setting(..., true) on an unset GUC
-- yields NULL, `tenant_id = NULL` is NULL, and the row is silently filtered --
-- so an unset GUC would return ZERO ROWS instead of an error, which is a
-- silent-wrong-answer failure rather than a loud one. This converts it into a
-- labelled failure.
--
-- STABLE, so the planner hoists it to an InitPlan and evaluates it once per
-- query rather than once per row.
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw text := current_setting('app.tenant_id', true);
BEGIN
  IF raw IS NULL OR raw = '' THEN
    RAISE EXCEPTION 'app.tenant_id is not set: no tenant context for this query'
      USING ERRCODE = '28000';
  END IF;
  RETURN raw::uuid;
END
$$;

-- FORCE ROW LEVEL SECURITY is deliberately NOT used. FORCE subjects the table
-- owner to the policies, and katkitchen_owner runs migrations, seeds and
-- backfills -- which would then need a tenant GUC to touch any table. Ordinary
-- RLS already applies fully to katkitchen_app because it is not the owner. The
-- risk FORCE was covering (running the app AS the owner in dev) is caught by
-- the startup check instead, which fails louder and earlier.
--
-- Policies are left at PUBLIC rather than TO katkitchen_app: a future role then
-- gets tenant isolation rather than a blanket deny that someone "fixes" by
-- granting BYPASSRLS.
--
-- WITH CHECK is not optional. USING alone lets a request write a row into a
-- tenant it cannot read.

ALTER TABLE app.branch ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.branch
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.app_user ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.app_user
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.credential ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.credential
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.role ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.role
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.role_permission ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.role_permission
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.membership
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
