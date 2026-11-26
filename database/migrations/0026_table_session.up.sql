-- A session is not a table. Table 4 has many sessions over a day; merging two
-- tables is one session over two tables; a party moving tables is one session.
-- So the relation carries validity, and neither side carries the other's id.

CREATE TABLE app.table_session (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id          uuid        NOT NULL,

  -- Stamped at open from the branch timezone and day start, so a session that
  -- runs past midnight belongs to the night it started.
  business_date      date        NOT NULL,
  -- Reporting only. A party of six at a four-top is not an error the POS argues
  -- about.
  guest_count        smallint    CHECK (guest_count IS NULL OR guest_count > 0),

  status             text        NOT NULL DEFAULT 'open'
                     CONSTRAINT table_session_status_known CHECK (status IN ('open', 'closed')),

  -- Optimistic concurrency, NOT a row lock. Two waiters on one table, a manager
  -- deciding whether to approve a discount, the cashier opening the bill -- a
  -- lock held across a human's thinking time is a wedged terminal mid-service,
  -- and the person who could unwedge it is the one holding it.
  version            integer     NOT NULL DEFAULT 1 CHECK (version > 0),

  opened_at          timestamptz NOT NULL DEFAULT now(),
  opened_by_user_id  uuid        NOT NULL,
  closed_at          timestamptz,
  closed_by_user_id  uuid,

  CONSTRAINT table_session_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT table_session_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT table_session_opened_by_fk
  FOREIGN KEY (tenant_id, opened_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT table_session_closed_by_fk
  FOREIGN KEY (tenant_id, closed_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT table_session_closure_consistent
  CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL))
);

CREATE INDEX table_session_open_idx
  ON app.table_session (tenant_id, branch_id, business_date)
  WHERE status = 'open';

CREATE TABLE app.table_session_table (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  session_id      uuid        NOT NULL,
  dining_table_id uuid        NOT NULL,
  attached_at     timestamptz NOT NULL DEFAULT now(),
  detached_at     timestamptz,

  CONSTRAINT table_session_table_session_fk
  FOREIGN KEY (tenant_id, session_id) REFERENCES app.table_session (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT table_session_table_table_fk
  FOREIGN KEY (tenant_id, dining_table_id) REFERENCES app.dining_table (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT table_session_table_validity CHECK (detached_at IS NULL OR detached_at >= attached_at)
);

-- "Exactly one open session per table" falls out of this one index: a table has
-- at most one live attachment, therefore at most one open session. Enforced, not
-- checked in application code.
CREATE UNIQUE INDEX table_session_one_live_attachment_per_table
  ON app.table_session_table (tenant_id, dining_table_id)
  WHERE detached_at IS NULL;

CREATE INDEX table_session_table_by_session_idx
  ON app.table_session_table (tenant_id, session_id);

ALTER TABLE app.table_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.table_session
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.table_session_table ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.table_session_table
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
