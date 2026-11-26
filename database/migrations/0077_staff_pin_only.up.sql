-- Staff sign in with a 4-digit PIN only; their passwords are revoked.
--
-- ###########################################################################
-- Staff tap their name on the restaurant's till and type a PIN the Sales
-- person set (modules/platform/tenantStaff.ts). They have no password sign-in
-- at all: the login routes refuse a staff account (`staff_use_pin`), and this
-- revokes any password a staff account still holds, so nothing is left that
-- the routes would have to refuse.
--
-- "Staff" is an account that does NOT manage the restaurant -- holds no active
-- membership whose role carries `user.view`. Managers (Restaurant Manager,
-- Restaurant Admin, Manager) keep their email and password.
--
-- Revoked, never deleted: a credential row is history, and
-- `credential_revocation_consistent` ties status and revoked_at together.
-- ###########################################################################
UPDATE app.credential c
   SET status = 'revoked', revoked_at = now()
 WHERE c.type = 'password' AND c.status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM app.membership m
       JOIN app.role_permission rp ON rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
      WHERE m.tenant_id = c.tenant_id AND m.user_id = c.user_id AND m.status = 'active'
        AND rp.permission_key = 'user.view');
