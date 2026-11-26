-- Recreates the Chef system role in every restaurant that has a KDS Staff role,
-- with the same keys KDS Staff holds (what Chef held after 0064). Custom roles
-- repointed to KDS Staff by the up are left there: which of them were cloned
-- from Chef is not recoverable, and pointing them back by guess would be worse.
INSERT INTO app.role (id, tenant_id, key, name, description, is_system, assignable_scope)
SELECT gen_random_uuid(), k.tenant_id, 'chef', 'Chef',
       'Runs the pass on the kitchen screen: moves dishes from new to preparing to ready.',
       true, 'branch_only'
  FROM app.role k
 WHERE k.key = 'kds' AND k.is_system
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO app.role_permission (tenant_id, role_id, permission_key)
SELECT ch.tenant_id, ch.id, rp.permission_key
  FROM app.role ch
  JOIN app.role k ON k.tenant_id = ch.tenant_id AND k.key = 'kds' AND k.is_system
  JOIN app.role_permission rp ON rp.tenant_id = k.tenant_id AND rp.role_id = k.id
 WHERE ch.key = 'chef' AND ch.is_system
ON CONFLICT DO NOTHING;
