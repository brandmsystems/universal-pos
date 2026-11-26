-- The local print agent: a program on a computer in the restaurant that prints
-- kitchen tickets to Wi-Fi and Ethernet printers the hosted server cannot reach.
--
-- ###########################################################################
-- 1. AN AGENT IS ITS OWN ROW, NOT A DEVICE.
--
-- `app.device` is a till people sign in on: PINs, leases, the tablet limit. An
-- agent has none of those, and sharing the row would make every device query
-- remember to exclude agents -- absence as a discriminator. It holds one secret,
-- stored only as its SHA-256; the token is shown once, when it is issued.
--
-- Revocation is a status, never a delete: print jobs name the agent that
-- claimed them, and the person who issued and revoked it is a record.
-- ###########################################################################
CREATE TABLE app.print_agent (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id           uuid        NOT NULL,
  name                text        NOT NULL
                      CONSTRAINT print_agent_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  token_hash          text        NOT NULL
                      CONSTRAINT print_agent_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status              text        NOT NULL DEFAULT 'active'
                      CONSTRAINT print_agent_status_known CHECK (status IN ('active', 'revoked')),
  issued_by_user_id   uuid        NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz,
  agent_version       text        CONSTRAINT print_agent_version_length CHECK (length(agent_version) <= 40),
  revoked_at          timestamptz,
  revoked_by_user_id  uuid,

  CONSTRAINT print_agent_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT print_agent_token_hash_key UNIQUE (token_hash),
  CONSTRAINT print_agent_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT print_agent_issuer_fk
  FOREIGN KEY (tenant_id, issued_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT print_agent_revoker_fk
  FOREIGN KEY (tenant_id, revoked_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  -- A revocation with no name against it is not something anyone can investigate.
  CONSTRAINT print_agent_revocation_consistent CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
    AND (revoked_at IS NULL) = (revoked_by_user_id IS NULL)
  )
);

CREATE INDEX print_agent_branch_live ON app.print_agent (tenant_id, branch_id) WHERE status = 'active';

ALTER TABLE app.print_agent ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.print_agent
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE DELETE, TRUNCATE ON app.print_agent FROM katkitchen_app;

-- ###########################################################################
-- 2. WHAT THE AGENT LAST SAW OF EACH PRINTER, AND A TEST PRINT ON REQUEST.
--
-- Only something on the restaurant's network can say whether 192.168.1.50:9100
-- answers, so the agent reports it. Each pair is tied together so a status
-- never appears without the time it was observed.
-- ###########################################################################
ALTER TABLE app.printer
  ADD COLUMN reach_checked_at        timestamptz,
  ADD COLUMN reachable               boolean,
  ADD COLUMN reach_error             text CONSTRAINT printer_reach_error_length CHECK (length(reach_error) <= 300),
  ADD COLUMN test_print_requested_at timestamptz,
  ADD COLUMN test_printed_at         timestamptz,
  ADD COLUMN test_print_error        text CONSTRAINT printer_test_print_error_length CHECK (length(test_print_error) <= 300),
  ADD CONSTRAINT printer_reach_observed CHECK ((reach_checked_at IS NULL) = (reachable IS NULL)),
  ADD CONSTRAINT printer_reach_error_when_unreachable CHECK (reach_error IS NULL OR reachable = false);
