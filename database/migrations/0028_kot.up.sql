-- Gapless sequences use a counter row, never a SEQUENCE.
--
-- Sequences deliberately do not roll back, so every aborted fire would burn a
-- number. A counter row is gapless BECAUSE it is an ordinary row update: the
-- increment participates in the transaction, so an aborted fire aborts it too.
-- The counter value is the count of committed tickets, by construction.

-- Per branch per business date, allocated ONCE per fire and stamped on every KOT
-- in it. This is the number a dispute is traced by and the number the exception
-- report shows -- without it, "the thing the waiter sent at 20:14" is a four-way
-- join through order_id, because a fire touching four stations allocates four
-- independent station numbers and none of them identifies the fire.
CREATE TABLE app.fire_sequence (
  tenant_id     uuid    NOT NULL,
  branch_id     uuid    NOT NULL,
  business_date date    NOT NULL,
  next_no       integer NOT NULL DEFAULT 0 CHECK (next_no >= 0),

  PRIMARY KEY (tenant_id, branch_id, business_date),
  CONSTRAINT fire_sequence_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT
);

-- Per station per business date, for the kitchen's verbal use.
CREATE TABLE app.kot_sequence (
  tenant_id     uuid    NOT NULL,
  branch_id     uuid    NOT NULL,
  station_id    uuid    NOT NULL,
  business_date date    NOT NULL,
  next_no       integer NOT NULL DEFAULT 0 CHECK (next_no >= 0),

  PRIMARY KEY (tenant_id, branch_id, station_id, business_date),
  CONSTRAINT kot_sequence_station_fk
  FOREIGN KEY (tenant_id, station_id) REFERENCES app.kitchen_station (tenant_id, id) ON DELETE RESTRICT
);


CREATE TABLE app.kot_fire (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id         uuid        NOT NULL,
  order_id          uuid        NOT NULL,
  business_date     date        NOT NULL,
  fire_no           integer     NOT NULL CHECK (fire_no > 0),
  fired_at          timestamptz NOT NULL DEFAULT now(),
  fired_by_user_id  uuid        NOT NULL,

  CONSTRAINT kot_fire_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT kot_fire_no_unique UNIQUE (tenant_id, branch_id, business_date, fire_no),
  CONSTRAINT kot_fire_order_fk
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.sales_order (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT kot_fire_user_fk
  FOREIGN KEY (tenant_id, fired_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT
);


CREATE TABLE app.kot (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  branch_id      uuid        NOT NULL,
  fire_id        uuid        NOT NULL,
  station_id     uuid        NOT NULL,
  business_date  date        NOT NULL,

  -- NULLABLE, deliberately. A display number may gap and may be absent; an
  -- identity may not. If the sequence were the identity an offline terminal could
  -- not fire at all, because gaplessness is a global property a disconnected
  -- terminal cannot compute. The identity is the uuid.
  sequence_no    integer     CHECK (sequence_no IS NULL OR sequence_no > 0),

  state          text        NOT NULL DEFAULT 'queued'
                 CONSTRAINT kot_state_known
                 CHECK (state IN ('queued', 'preparing', 'ready', 'served', 'recalled', 'cancelled')),
  version        integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kot_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT kot_fire_fk
  FOREIGN KEY (tenant_id, fire_id) REFERENCES app.kot_fire (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT kot_station_fk
  FOREIGN KEY (tenant_id, station_id) REFERENCES app.kitchen_station (tenant_id, id) ON DELETE RESTRICT,
  -- One KOT per station per fire: a station receives one ticket, not three.
  CONSTRAINT kot_one_per_station_per_fire UNIQUE (tenant_id, fire_id, station_id)
);

-- Catches any bug in the allocator rather than trusting it.
CREATE UNIQUE INDEX kot_sequence_no_unique
  ON app.kot (tenant_id, branch_id, station_id, business_date, sequence_no)
  WHERE sequence_no IS NOT NULL;

CREATE INDEX kot_by_station_state_idx ON app.kot (tenant_id, branch_id, station_id, state);


-- A line whose modifier routes elsewhere produces entries on two KOTs, which is
-- why the KOT line says WHICH PART of the order line it represents.
CREATE TABLE app.kot_line (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL,
  kot_id             uuid        NOT NULL,
  order_line_id      uuid        NOT NULL,

  source             text        NOT NULL
                     CONSTRAINT kot_line_source_known CHECK (source IN ('item', 'modifier')),
  modifier_option_id uuid,

  quantity           integer     NOT NULL CHECK (quantity > 0),
  name_snapshot      text        NOT NULL,
  note               text,
  state              text        NOT NULL DEFAULT 'queued'
                     CONSTRAINT kot_line_state_known
                     CHECK (state IN ('queued', 'preparing', 'ready', 'served', 'cancelled')),
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kot_line_kot_fk
  FOREIGN KEY (tenant_id, kot_id) REFERENCES app.kot (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT kot_line_order_line_fk
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES app.order_line (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT kot_line_modifier_fk
  FOREIGN KEY (tenant_id, modifier_option_id) REFERENCES app.modifier_option (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT kot_line_source_shape
  CHECK ((source = 'modifier') = (modifier_option_id IS NOT NULL))
);

CREATE INDEX kot_line_by_kot_idx ON app.kot_line (tenant_id, kot_id);
CREATE INDEX kot_line_by_order_line_idx ON app.kot_line (tenant_id, order_line_id);


-- The print_job ROW is created inside the fire transaction. The print ATTEMPT is
-- not: printing is I/O against a device that fails constantly, and holding the
-- fire transaction open across it puts a paper jam in the critical path of the
-- till. Retry comes from the queue with backoff; on exhaustion the job moves to
-- the station's fallback printer.
CREATE TABLE app.print_job (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  branch_id           uuid        NOT NULL,
  kot_id              uuid        NOT NULL,
  printer_id          uuid        NOT NULL,
  fallback_printer_id uuid,

  status              text        NOT NULL DEFAULT 'pending'
                      CONSTRAINT print_job_status_known
                      CHECK (status IN ('pending', 'printing', 'printed', 'failed', 'abandoned')),
  attempts            integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  last_error          text,
  printed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT print_job_kot_fk
  FOREIGN KEY (tenant_id, kot_id) REFERENCES app.kot (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT print_job_printer_fk
  FOREIGN KEY (tenant_id, printer_id) REFERENCES app.printer (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT print_job_fallback_fk
  FOREIGN KEY (tenant_id, fallback_printer_id) REFERENCES app.printer (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT print_job_printed_consistent
  CHECK ((status = 'printed') = (printed_at IS NOT NULL))
);

-- The drain query, and the failure-rate widget's source.
CREATE INDEX print_job_pending_idx
  ON app.print_job (tenant_id, next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX print_job_by_kot_idx ON app.print_job (tenant_id, kot_id);


ALTER TABLE app.fire_sequence ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.fire_sequence
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.kot_sequence ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.kot_sequence
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.kot_fire ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.kot_fire
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.kot ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.kot
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.kot_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.kot_line
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.print_job ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.print_job
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
