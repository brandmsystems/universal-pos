-- Dual capacity is modelled as two memberships, never as one role holding both
-- sides. That is the right pattern, but it has a consequence: when the owner
-- collects a payment at Branch 2, the union of their memberships says they
-- could, and nothing says which capacity they were acting in.
--
-- Without this column, separation of duties is a comment. With it, "owner
-- collected cash at Branch 2 as that branch's cashier" is an auditable fact
-- rather than an inference -- and the accumulated-conflict report can move from
-- who *could* exercise both capacities to who actually *did*.
--
-- The permission check already knows which membership satisfied it; the
-- application returns that from effectiveAuthority rather than discarding it.
-- Where several memberships satisfy the same key the narrowest scope wins,
-- branch over tenant-wide, because that is the capacity the person was acting in.

-- FK target. membership was the one identity table without the composite key,
-- because nothing referenced it until now.
ALTER TABLE app.membership
  ADD CONSTRAINT membership_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE app.tenant_audit_log
  -- NULL only for system and scheduled-job actors, which hold no membership.
  ADD COLUMN authorising_membership_id uuid;

ALTER TABLE app.tenant_audit_log
  ADD CONSTRAINT tenant_audit_log_authorising_membership_fk
  FOREIGN KEY (tenant_id, authorising_membership_id)
    REFERENCES app.membership (tenant_id, id) ON DELETE RESTRICT;

-- Answers "what did this person do while wearing that hat", which is the query
-- the separation-of-duties report is built on.
CREATE INDEX tenant_audit_log_by_authorising_membership_idx
  ON app.tenant_audit_log (tenant_id, authorising_membership_id, occurred_at DESC);

COMMENT ON COLUMN app.tenant_audit_log.authorising_membership_id IS
  'The specific membership whose role held the permission that allowed this action. NULL only for system actors. Narrowest scope wins where several memberships qualify.';
