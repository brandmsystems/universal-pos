-- Chef is retired: every kitchen ticket and print goes to the kitchen, and the
-- kitchen screen is worked by KDS Staff. Since 0064 the Chef role held exactly
-- the kitchen screen's keys, so it was the same account under a second name --
-- two words for one job on the Create staff screen.
--
-- Nobody holds it and no invite names it (checked before this was written), so
-- nothing is lost. The guards below make that a precondition rather than an
-- assumption: a membership or pending invite on it refuses the migration, since
-- quietly moving a person to another role is a decision, not a cleanup.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.membership m JOIN app.role r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
              WHERE r.key = 'chef' AND r.is_system) THEN
    RAISE EXCEPTION 'chef role still held by a membership; move them to kds first';
  END IF;
  IF EXISTS (SELECT 1 FROM app.staff_invite i JOIN app.role r ON r.tenant_id = i.tenant_id AND r.id = i.role_id
              WHERE r.key = 'chef' AND r.is_system) THEN
    RAISE EXCEPTION 'chef role named by a staff invite; revoke or reissue it first';
  END IF;
END $$;

-- A custom role cloned from Chef keeps its provenance, pointed at KDS Staff --
-- the role Chef was identical to.
UPDATE app.role c
   SET cloned_from_role_id = k.id
  FROM app.role ch
  JOIN app.role k ON k.tenant_id = ch.tenant_id AND k.key = 'kds' AND k.is_system
 WHERE ch.key = 'chef' AND ch.is_system
   AND c.tenant_id = ch.tenant_id AND c.cloned_from_role_id = ch.id;

DELETE FROM app.role_permission rp
 USING app.role r
 WHERE r.tenant_id = rp.tenant_id AND r.id = rp.role_id AND r.key = 'chef' AND r.is_system;

DELETE FROM app.role WHERE key = 'chef' AND is_system;
