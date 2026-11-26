-- Idempotency for order mutations. Same discipline as provisioning, at far higher
-- volume -- so the retention policy exists from day one rather than being added
-- after the table is 40 million rows.
--
-- PARTITION BY HASH, not by created_at, and that choice is load-bearing.
--
-- A partitioned table's PRIMARY KEY must contain the partition key. Partitioning
-- by created_at would make the PK (tenant_id, idempotency_key, created_at), which
-- lets two claims with the SAME key at different times both insert -- destroying
-- the uniqueness the entire mechanism rests on, while looking like a working
-- system for months. Hashing on the key keeps it in the PK, routes a given key
-- always to the same partition, and preserves global uniqueness.
--
-- The cost is that retention is a batched DELETE rather than a DROP. Worth it.
CREATE TABLE app.request_claim (
  tenant_id       uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  idempotency_key text        NOT NULL
                  CONSTRAINT request_claim_key_length CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  branch_id       uuid,
  operation       text        NOT NULL,
  request_digest  bytea       NOT NULL,
  -- Replayed verbatim on retry. A second tap must get the SAME kot number back,
  -- not merely "ok" -- otherwise the terminal shows two tickets.
  result          jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, idempotency_key)
) PARTITION BY HASH (idempotency_key);

DO $$
DECLARE
  i integer;
  part text;
BEGIN
  FOR i IN 0..15 LOOP
    part := format('request_claim_%s', lpad(i::text, 2, '0'));
    EXECUTE format(
      'CREATE TABLE app.%I PARTITION OF app.request_claim FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
      part, i);
    -- RLS does not propagate to partitions; a partition named directly enforces
    -- its own. Same rule as the audit partitions.
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', part);
  END LOOP;
END $$;

CREATE INDEX request_claim_created_at_idx ON app.request_claim (created_at);

ALTER TABLE app.request_claim ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.request_claim
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Batched so a retention run cannot hold a long transaction across service.
CREATE FUNCTION app.purge_request_claims(retain_days integer DEFAULT 7, batch integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  removed integer := 0;
  chunk   integer;
BEGIN
  LOOP
    WITH doomed AS (
      SELECT tenant_id, idempotency_key
        FROM app.request_claim
       WHERE created_at < now() - make_interval(days => retain_days)
       LIMIT batch
    )
    DELETE FROM app.request_claim c
     USING doomed d
     WHERE c.tenant_id = d.tenant_id AND c.idempotency_key = d.idempotency_key;

    GET DIAGNOSTICS chunk = ROW_COUNT;
    removed := removed + chunk;
    EXIT WHEN chunk = 0;
  END LOOP;

  RETURN removed;
END
$$;
