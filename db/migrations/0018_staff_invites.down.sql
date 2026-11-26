DROP POLICY IF EXISTS tenant_isolation ON app.staff_invite;
DROP TRIGGER IF EXISTS staff_invite_set_updated_at ON app.staff_invite;
DROP INDEX IF EXISTS app.staff_invite_by_role_idx;
DROP INDEX IF EXISTS app.staff_invite_one_pending_per_email;
DROP TABLE IF EXISTS app.staff_invite;
