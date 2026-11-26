-- "System roles are locked; customisation is clone-then-edit" was specified but
-- never enforced -- nothing stopped a tenant editing a seeded role's permission
-- set directly, which would then be silently overwritten by the next deploy's
-- reconciliation.
--
-- Locking app.role alone would not be enough: editing app.role_permission
-- directly reaches the same result by a different door.
--
-- Conditioned on current_user rather than a blanket denial, because the seed
-- reconciliation must still be able to push newly added permission keys into
-- system roles. Same shape as RLS not applying to the owner: the migration role
-- is the one that maintains this data, the application role is the one that must
-- not.
CREATE FUNCTION app.deny_system_role_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  locked boolean;
BEGIN
  IF current_user = 'katkitchen_owner' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_TABLE_NAME = 'role' THEN
    locked := COALESCE(OLD.is_system, false);
  ELSE
    SELECT r.is_system INTO locked
      FROM app.role r
     WHERE r.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
       AND r.id = COALESCE(NEW.role_id, OLD.role_id);
    locked := COALESCE(locked, false);
  END IF;

  IF locked THEN
    RAISE EXCEPTION 'system roles are locked: % on %.% is not permitted. Clone the role instead.',
      TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER role_system_locked
  BEFORE UPDATE OR DELETE ON app.role
  FOR EACH ROW EXECUTE FUNCTION app.deny_system_role_mutation();

CREATE TRIGGER role_permission_system_locked
  BEFORE INSERT OR UPDATE OR DELETE ON app.role_permission
  FOR EACH ROW EXECUTE FUNCTION app.deny_system_role_mutation();
