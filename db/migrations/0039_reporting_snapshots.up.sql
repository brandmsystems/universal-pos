-- The last snapshots reporting needs, and nothing else.
--
-- Everything here exists because a report must read what was true THEN. Each
-- column is written once, at the moment the document is raised, and never
-- dereferenced afterwards.

-- The branch's own GST identity. Place of supply for a restaurant meal is where
-- the meal was served, so this is the supplier side of the tenant's own outward
-- supply -- a different thing entirely from platform.supplier_gst_registration,
-- which is OUR registration for billing the tenant.
ALTER TABLE app.branch
  ADD COLUMN gstin text
  CONSTRAINT branch_gstin_format
  CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD COLUMN state_code text
  CONSTRAINT branch_state_code_format
  CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),
  ADD CONSTRAINT branch_gstin_matches_state
  CHECK (gstin IS NULL OR state_code IS NULL OR substring(gstin, 1, 2) = state_code);


-- The recipient's identity, SNAPSHOTTED onto the bill.
--
-- A corporate customer who gives their GSTIN at the till makes that bill a B2B
-- supply, and the outward-supply return reports B2B and B2C separately. It is
-- snapshotted rather than joined to a customer record because the customer may
-- update their GSTIN later and a filed return must not move.
ALTER TABLE app.bill
  ADD COLUMN recipient_gstin text
  CONSTRAINT bill_recipient_gstin_format
  CHECK (recipient_gstin IS NULL
      OR recipient_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD COLUMN recipient_legal_name text,
  -- Where the supply was made. For a meal served on the premises this is the
  -- branch's state, but it is stored rather than derived so a branch that later
  -- corrects its registration cannot rewrite last year's return.
  ADD COLUMN place_of_supply_state_code text
  CONSTRAINT bill_place_of_supply_format
  CHECK (place_of_supply_state_code IS NULL OR place_of_supply_state_code ~ '^[0-9]{2}$'),
  -- Snapshot of the branch GSTIN that made the supply.
  ADD COLUMN supplier_gstin text
  CONSTRAINT bill_supplier_gstin_format
  CHECK (supplier_gstin IS NULL
      OR supplier_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),

  -- A B2B supply must name the recipient. Absence is not the discriminator: the
  -- GSTIN and the name travel together or the bill is B2C.
  ADD CONSTRAINT bill_b2b_named
  CHECK (recipient_gstin IS NULL OR recipient_legal_name IS NOT NULL);

CREATE INDEX bill_b2b_idx ON app.bill (tenant_id, branch_id, business_date)
  WHERE recipient_gstin IS NOT NULL;


-- A refund reduces the taxable value of a supply already made, which is exactly
-- what Section 34 describes -- so unlike the platform's proration, this genuinely
-- IS a credit note and reports as one. The tax it reverses is snapshotted here
-- because it must match the bill it reverses, not today's rate.
ALTER TABLE app.refund
  ADD COLUMN taxable_minor bigint,
  ADD COLUMN tax_minor bigint,
  ADD COLUMN tax_rate_bps integer
  CONSTRAINT refund_tax_rate_range
  CHECK (tax_rate_bps IS NULL OR (tax_rate_bps >= 0 AND tax_rate_bps <= 10000)),
  ADD COLUMN tax_components jsonb,

  ADD CONSTRAINT refund_tax_snapshot_complete
  CHECK (
    (taxable_minor IS NULL AND tax_minor IS NULL AND tax_rate_bps IS NULL)
    OR (taxable_minor IS NOT NULL AND tax_minor IS NOT NULL AND tax_rate_bps IS NOT NULL
        AND taxable_minor + tax_minor = amount_minor)
  );


-- Per-record PII access, kept apart from the exception report ON PURPOSE.
--
-- The audience is the DPO, not loss prevention. An owner scanning for till fraud
-- must not have to page through customer lookups, and a privacy log joined into a
-- fraud report is a privacy log being used for the wrong thing.
--
-- One row per record revealed, which is what the API shape from Phase 2 makes
-- natural: list endpoints return masked projections and require no key, so only a
-- single-record reveal reaches here.
CREATE TABLE app.pii_access_log (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id      uuid,

  actor_user_id  uuid        NOT NULL,
  permission_key text        NOT NULL
                 CONSTRAINT pii_access_permission_known
                 CHECK (permission_key IN ('customer.pii.view', 'customer.pii.export')),

  -- Exactly one record for a reveal. For an export this is NULL and the query
  -- descriptor carries the shape instead -- an id list would defeat the purpose.
  customer_id    uuid,
  query_descriptor jsonb,
  result_count   integer     CHECK (result_count IS NULL OR result_count >= 0),
  reason         text,

  occurred_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pii_access_log_actor_fk
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT pii_access_shape_exact
  CHECK (
    CASE permission_key
      WHEN 'customer.pii.view' THEN customer_id IS NOT NULL AND query_descriptor IS NULL
      -- Bulk access carries a query descriptor and a COUNT, never an id list.
      WHEN 'customer.pii.export' THEN customer_id IS NULL AND query_descriptor IS NOT NULL
                                      AND result_count IS NOT NULL AND reason IS NOT NULL
      ELSE false
    END
  )
);

CREATE INDEX pii_access_log_by_actor_idx
  ON app.pii_access_log (tenant_id, actor_user_id, occurred_at DESC);

CREATE FUNCTION app.deny_pii_access_log_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'the PII access log is append-only' USING ERRCODE = '42501';
END
$fn$;

CREATE TRIGGER pii_access_log_append_only
  BEFORE UPDATE OR DELETE ON app.pii_access_log
  FOR EACH ROW EXECUTE FUNCTION app.deny_pii_access_log_rewrite();

ALTER TABLE app.pii_access_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.pii_access_log
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE UPDATE, DELETE, TRUNCATE ON app.pii_access_log FROM katkitchen_app;
