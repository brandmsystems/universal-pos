-- The entitlement document is the only thing that flows down across the plane
-- boundary. It carries a MONOTONIC VERSION, and that version is the whole point.
--
-- Without it: a tenant downgrades, the control plane publishes v5 with fewer
-- features, and a slow in-flight write of v4 lands afterwards -- silently
-- restoring the features the tenant no longer pays for, with nothing to notice.
-- The tenant plane rejects any document whose version is not strictly greater
-- than the one it already holds.
CREATE TABLE platform.entitlement_document (
  tenant_id     uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  version       bigint      NOT NULL CHECK (version >= 1),

  -- Denormalised on purpose: the tenant plane must be able to enforce without
  -- joining to plan tables it has no business reading.
  plan_key      text        NOT NULL,
  plan_version  integer     NOT NULL,
  status        text        NOT NULL
                CONSTRAINT entitlement_status_known
                CHECK (status IN ('active', 'past_due', 'soft_lock', 'hard_lock', 'suspended')),
  limits        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  features      jsonb       NOT NULL DEFAULT '{}'::jsonb,

  published_at  timestamptz NOT NULL DEFAULT now(),
  reason        text        NOT NULL,

  PRIMARY KEY (tenant_id, version)
);

CREATE INDEX entitlement_document_latest_idx
  ON platform.entitlement_document (tenant_id, version DESC);

/**
 * Allocates the next version for a tenant under a row lock, so two concurrent
 * publishes cannot both read the same maximum and produce two v6 documents --
 * which would make "strictly greater" unable to order them.
 */
CREATE FUNCTION platform.next_entitlement_version(target_tenant uuid)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  next_version bigint;
BEGIN
  -- Lock the tenant row: the serialisation point for version allocation.
  PERFORM 1 FROM platform.tenant WHERE id = target_tenant FOR UPDATE;

  SELECT COALESCE(max(version), 0) + 1 INTO next_version
    FROM platform.entitlement_document
   WHERE tenant_id = target_tenant;

  RETURN next_version;
END
$$;
