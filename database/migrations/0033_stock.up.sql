-- Stock movements, balances, waste and physical counts.
--
-- ###########################################################################
-- WHY THIS TABLE IS NOT PARTITIONED.
--
-- The rule from request_claim applies here and produces the opposite answer,
-- which is exactly why it is asked rather than assumed. stock_movement's
-- correctness rests on UNIQUE (tenant_id, dedupe_key) -- that is what makes the
-- KOT deduction idempotent. Partitioning by occurred_at would make that
-- uniqueness per-partition, and a retry across a month boundary would
-- double-deduct.
--
-- Hash-partitioning by dedupe_key would preserve it, but dedupe_key is NULL for
-- manual adjustments and counts, so all of those land in one partition. And the
-- retention story differs in kind: audit partitions can be dropped because
-- nothing derives from them, whereas stock_balance IS the fold of this table and
-- dropping old movements destroys its provenance.
--
-- So: not partitioned, deliberately.
-- ###########################################################################

-- Typed and groupable, same shape as adjustment_reason. Four free-text columns
-- nobody can aggregate is the outcome to avoid: "how much went to spoilage last
-- month" must be one GROUP BY, not a text search.
CREATE TABLE app.stock_reason (
  id         uuid        PRIMARY KEY,
  tenant_id  uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key        text        NOT NULL CONSTRAINT stock_reason_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name       text        NOT NULL,

  -- Spoilage is a purchasing problem, a returned dish is a kitchen problem, a
  -- staff meal is a benefit and theft is a police matter. One "wastage" number
  -- covering all four tells an owner nothing they can act on.
  category   text        NOT NULL
             CONSTRAINT stock_reason_category_known
             CHECK (category IN ('spoilage', 'preparation_loss', 'returned_dish', 'staff_meal',
                                 'theft', 'breakage', 'count_variance', 'correction', 'transfer')),
  status     text        NOT NULL DEFAULT 'active'
             CONSTRAINT stock_reason_status_known CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stock_reason_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT stock_reason_key_unique UNIQUE (tenant_id, key)
);

CREATE TRIGGER stock_reason_set_updated_at
  BEFORE UPDATE ON app.stock_reason
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Scoped by movement kind via composite FK: "spoiled" must not be selectable for
-- a count variance.
CREATE TABLE app.stock_reason_kind (
  tenant_id uuid NOT NULL,
  reason_id uuid NOT NULL,
  kind      text NOT NULL
            CONSTRAINT stock_reason_kind_known
            CHECK (kind IN ('waste', 'adjustment', 'count_variance', 'transfer_out', 'transfer_in')),

  PRIMARY KEY (tenant_id, reason_id, kind),
  CONSTRAINT stock_reason_kind_reason_fk
  FOREIGN KEY (tenant_id, reason_id) REFERENCES app.stock_reason (tenant_id, id) ON DELETE CASCADE
);


-- The ledger. Append-only: the balance is its fold, and a ledger you can edit is
-- a balance nobody can defend at a stock take.
CREATE TABLE app.stock_movement (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id         uuid        NOT NULL,
  product_id        uuid        NOT NULL,
  business_date     date        NOT NULL,

  kind              text        NOT NULL
                    CONSTRAINT stock_movement_kind_known
                    CHECK (kind IN ('receipt', 'consumption', 'waste', 'adjustment',
                                    'count_variance', 'transfer_in', 'transfer_out',
                                    'cost_adjustment')),

  -- Signed, in the product's scaled base unit. The sign is real: SUM(qty_base)
  -- is the balance, and it is the balance BECAUSE the sign is real.
  qty_base          bigint      NOT NULL,

  -- Change in the value of stock on hand, in minor units x 10^6. The extra six
  -- digits exist because a per-unit cost is a division, and rounding it at every
  -- issue accumulates into precisely the variance the report is meant to
  -- explain. Rounding happens once, at presentation.
  value_micro       bigint      NOT NULL DEFAULT 0,

  reason_id         uuid,
  note              text,

  -- Idempotency. 'kot:<uuid>' for a deduction, 'receipt_line:<uuid>' for a goods
  -- receipt. NULL where the caller is a human clicking a button.
  dedupe_key        text,

  -- Provenance, as soft references. A hard FK to kot would make retention of
  -- operational data hostage to stock history, and this table must stay
  -- insertable when the source row is archived.
  source_kot_id     uuid,
  recipe_version_id uuid,

  occurred_at       timestamptz NOT NULL DEFAULT now(),
  actor_user_id     uuid,

  CONSTRAINT stock_movement_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT stock_movement_dedupe_unique UNIQUE (tenant_id, dedupe_key),
  CONSTRAINT stock_movement_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_movement_product_fk
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.product (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_movement_actor_fk
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  -- The reason must be scoped to this kind of movement.
  CONSTRAINT stock_movement_reason_fk
  FOREIGN KEY (tenant_id, reason_id, kind)
    REFERENCES app.stock_reason_kind (tenant_id, reason_id, kind) ON DELETE RESTRICT,

  -- ##########################################################################
  -- NO PATH REVERSES A DEDUCTION.
  --
  -- consumption and waste are STRUCTURALLY negative. There is no positive
  -- counterpart and no 'consumption_reversal' kind, so a reversal is not
  -- something a caller can express -- not merely something no caller currently
  -- does. A dish that comes back is `waste`: the ingredients were consumed, and
  -- the loss must appear on both sides rather than vanish from each.
  -- ##########################################################################
  CONSTRAINT stock_movement_shape_exact
  CHECK (
    CASE kind
      WHEN 'receipt'         THEN qty_base > 0 AND value_micro >= 0 AND reason_id IS NULL
      WHEN 'consumption'     THEN qty_base < 0 AND reason_id IS NULL
      WHEN 'waste'           THEN qty_base < 0 AND reason_id IS NOT NULL
      WHEN 'adjustment'      THEN qty_base <> 0 AND reason_id IS NOT NULL
      WHEN 'count_variance'  THEN qty_base <> 0 AND reason_id IS NOT NULL
      WHEN 'transfer_in'     THEN qty_base > 0 AND reason_id IS NOT NULL
      WHEN 'transfer_out'    THEN qty_base < 0 AND reason_id IS NOT NULL
      -- A pure COGS correction: the goods are already gone, so it moves no
      -- quantity and touches no balance.
      WHEN 'cost_adjustment' THEN qty_base = 0 AND value_micro <> 0 AND reason_id IS NULL
      ELSE false
    END
  )
);

CREATE INDEX stock_movement_by_product_idx
  ON app.stock_movement (tenant_id, branch_id, product_id, occurred_at DESC);
CREATE INDEX stock_movement_by_date_idx
  ON app.stock_movement (tenant_id, branch_id, business_date, kind);

CREATE FUNCTION app.deny_stock_movement_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION
    'stock_movement is append-only: the balance is its fold. Post a correcting movement.'
    USING ERRCODE = '42501';
END
$fn$;

CREATE TRIGGER stock_movement_append_only
  BEFORE UPDATE OR DELETE ON app.stock_movement
  FOR EACH ROW EXECUTE FUNCTION app.deny_stock_movement_rewrite();


-- The fold, maintained by trigger. It exists so the POS does not sum a million
-- rows to decide whether it can sell a dish. It is a CACHE, and the nightly
-- reconciliation is what proves it still agrees with the ledger.
CREATE TABLE app.stock_balance (
  tenant_id             uuid        NOT NULL,
  branch_id             uuid        NOT NULL,
  product_id            uuid        NOT NULL,

  qty_base              bigint      NOT NULL DEFAULT 0,
  value_micro           bigint      NOT NULL DEFAULT 0,

  -- Sticky, never cleared. The last price actually paid, used to value an issue
  -- made against an empty balance. Without it the issue is valued at zero and
  -- COGS is understated permanently -- see unbacked_qty_base.
  last_unit_cost_micro  bigint,

  -- Quantity issued with nothing to back it, awaiting a receipt to reveal what it
  -- really cost, plus the value provisionally charged for it. This pair is what
  -- makes the zero-clamp temporary instead of permanent.
  unbacked_qty_base     bigint      NOT NULL DEFAULT 0 CHECK (unbacked_qty_base >= 0),
  unbacked_value_micro  bigint      NOT NULL DEFAULT 0,

  updated_at            timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, branch_id, product_id),
  CONSTRAINT stock_balance_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_balance_product_fk
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.product (tenant_id, id) ON DELETE RESTRICT
);


-- Weighted average cost, maintained in the same transaction as the movement.
--
-- Naive WAC breaks in two places, both reachable in a real kitchen:
--   1. issuing against a zero or negative balance has no cost basis to average
--      against, and (old_qty * cost + new) / new_qty with old_qty negative
--      yields a unit cost outside the range of every price ever paid;
--   2. new_qty can be exactly zero, which is a division by zero rather than a
--      rounding question.
-- Both are handled explicitly below. Neither is clamped.
CREATE FUNCTION app.apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  bal          app.stock_balance;
  issue_qty    bigint;
  backed_qty   bigint;
  unbacked_qty bigint;
  unit_cost    bigint;
  issue_value  bigint;
  fill_qty     bigint;
  assumed_unit bigint;
  actual_unit  bigint;
  correction   bigint;
  consumed_now bigint := 0;
BEGIN
  -- A cost adjustment moves no goods; it corrects COGS already recognised.
  IF NEW.kind = 'cost_adjustment' THEN
    RETURN NEW;
  END IF;

  INSERT INTO app.stock_balance (tenant_id, branch_id, product_id)
  VALUES (NEW.tenant_id, NEW.branch_id, NEW.product_id)
  ON CONFLICT DO NOTHING;

  SELECT * INTO bal FROM app.stock_balance
   WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND product_id = NEW.product_id
   FOR UPDATE;

  IF NEW.qty_base > 0 THEN
    -------------------------------------------------------------------- inbound
    -- ONLY a receipt carries price information. Stock APPEARING at a count, or
    -- arriving on a transfer, is not a purchase: valuing it at zero would reset
    -- the cost basis to zero and understate COGS on everything issued after it.
    -- So a non-receipt inbound is valued at the running average and leaves
    -- last_unit_cost_micro alone.
    IF NEW.kind <> 'receipt' THEN
      unit_cost := CASE
                     WHEN bal.qty_base > 0 THEN bal.value_micro / bal.qty_base
                     ELSE COALESCE(bal.last_unit_cost_micro, 0)
                   END;
      NEW.value_micro := NEW.qty_base * unit_cost;

      UPDATE app.stock_balance
         SET qty_base    = qty_base + NEW.qty_base,
             value_micro = value_micro + NEW.value_micro,
             updated_at  = now()
       WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND product_id = NEW.product_id;

      RETURN NEW;
    END IF;

    -- qty_base > 0 is the branch condition, so this division is guarded.
    actual_unit := NEW.value_micro / NEW.qty_base;

    -- A receipt landing against previously unbacked issues reveals what those
    -- issues actually cost. Correct them retrospectively rather than leaving
    -- COGS understated for good.
    IF bal.unbacked_qty_base > 0 THEN
      fill_qty     := LEAST(NEW.qty_base, bal.unbacked_qty_base);
      assumed_unit := bal.unbacked_value_micro / bal.unbacked_qty_base;
      correction   := fill_qty * (actual_unit - assumed_unit);

      IF correction <> 0 THEN
        INSERT INTO app.stock_movement
          (id, tenant_id, branch_id, product_id, business_date, kind, qty_base,
           value_micro, note, occurred_at, actor_user_id)
        VALUES
          (gen_random_uuid(), NEW.tenant_id, NEW.branch_id, NEW.product_id, NEW.business_date,
           'cost_adjustment', 0, -correction,
           format('retrospective cost of %s issued against an empty balance', fill_qty),
           NEW.occurred_at, NEW.actor_user_id);
      END IF;

      -- The filled portion never becomes stock on hand: it was consumed before it
      -- arrived. Its value must leave with it, or the correction is counted
      -- TWICE -- once in COGS now, and again in the inflated unit cost of every
      -- subsequent issue.
      consumed_now := fill_qty * actual_unit;

      bal.unbacked_value_micro := bal.unbacked_value_micro - (fill_qty * assumed_unit);
      bal.unbacked_qty_base    := bal.unbacked_qty_base - fill_qty;
    END IF;

    UPDATE app.stock_balance
       SET qty_base             = qty_base + NEW.qty_base,
           value_micro          = value_micro + NEW.value_micro - consumed_now,
           last_unit_cost_micro = actual_unit,
           unbacked_qty_base    = bal.unbacked_qty_base,
           unbacked_value_micro = bal.unbacked_value_micro,
           updated_at           = now()
     WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND product_id = NEW.product_id;

  ELSE
    ------------------------------------------------------------------- outbound
    issue_qty := -NEW.qty_base;

    unit_cost := CASE
                   WHEN bal.qty_base > 0 THEN bal.value_micro / bal.qty_base
                   ELSE COALESCE(bal.last_unit_cost_micro, 0)
                 END;

    -- Split where the balance runs out. The backed part is valued at the running
    -- average; the remainder is a provisional estimate a later receipt corrects.
    backed_qty   := GREATEST(LEAST(issue_qty, GREATEST(bal.qty_base, 0)), 0);
    unbacked_qty := issue_qty - backed_qty;
    issue_value  := issue_qty * unit_cost;

    UPDATE app.stock_balance
       SET qty_base             = qty_base - issue_qty,
           value_micro          = value_micro - issue_value,
           unbacked_qty_base    = unbacked_qty_base + unbacked_qty,
           unbacked_value_micro = unbacked_value_micro + (unbacked_qty * unit_cost),
           updated_at           = now()
     WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND product_id = NEW.product_id;

    NEW.value_micro := -issue_value;
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER stock_movement_applies_to_balance
  BEFORE INSERT ON app.stock_movement
  FOR EACH ROW EXECUTE FUNCTION app.apply_stock_movement();


-- Physical counts. draft -> counted -> approved, and only approval posts.
CREATE TABLE app.stock_count (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id           uuid        NOT NULL,
  business_date       date        NOT NULL,
  status              text        NOT NULL DEFAULT 'draft'
                      CONSTRAINT stock_count_status_known
                      CHECK (status IN ('draft', 'counted', 'approved', 'abandoned')),
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid        NOT NULL,
  counted_at          timestamptz,
  approved_at         timestamptz,
  approved_by_user_id uuid,

  CONSTRAINT stock_count_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT stock_count_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_count_creator_fk
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_count_approver_fk
  FOREIGN KEY (tenant_id, approved_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  -- inventory.count.perform and inventory.count.approve are separate keys for a
  -- reason; recording who did which is what makes that control auditable rather
  -- than notional.
  CONSTRAINT stock_count_approval_consistent
  CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL))
);

CREATE TABLE app.stock_count_line (
  id                uuid   PRIMARY KEY,
  tenant_id         uuid   NOT NULL,
  stock_count_id    uuid   NOT NULL,
  product_id        uuid   NOT NULL,

  -- Snapshotted when the sheet is generated, NOT read at approval time. Service
  -- continues while someone counts the walk-in, so the balance moves underneath
  -- them; valuing the variance against a later balance charges the counter for
  -- sales that happened during the count.
  expected_qty_base bigint NOT NULL,
  counted_qty_base  bigint,
  reason_id         uuid,

  -- Pinned constant so the reason FK can be scoped: an FK column must be a
  -- column, and this is the same denormalise-and-pin shape as membership's
  -- role_assignable_scope.
  reason_kind       text   NOT NULL DEFAULT 'count_variance'
                    CONSTRAINT stock_count_line_reason_kind_pinned
                    CHECK (reason_kind = 'count_variance'),
  note              text,

  CONSTRAINT stock_count_line_unique UNIQUE (tenant_id, stock_count_id, product_id),
  CONSTRAINT stock_count_line_count_fk
  FOREIGN KEY (tenant_id, stock_count_id) REFERENCES app.stock_count (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT stock_count_line_product_fk
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.product (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_count_line_reason_fk
  FOREIGN KEY (tenant_id, reason_id, reason_kind)
    REFERENCES app.stock_reason_kind (tenant_id, reason_id, kind) ON DELETE RESTRICT
);

ALTER TABLE app.stock_reason ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.stock_reason
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.stock_reason_kind ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.stock_reason_kind
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.stock_movement ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.stock_movement
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.stock_balance ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.stock_balance
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.stock_count ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.stock_count
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.stock_count_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.stock_count_line
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE UPDATE, DELETE, TRUNCATE ON app.stock_movement FROM katkitchen_app;
