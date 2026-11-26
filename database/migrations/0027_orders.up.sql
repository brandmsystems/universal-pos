-- Typed, tenant-extensible, and SCOPED by kind: four free-text columns nobody can
-- aggregate is the outcome to avoid, and the exception report is worthless without
-- a groupable reason. Scoping is what stops "customer walked out" being selectable
-- for a discount.
CREATE TABLE app.adjustment_reason (
  id         uuid        PRIMARY KEY,
  tenant_id  uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key        text        NOT NULL CONSTRAINT adjustment_reason_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name       text        NOT NULL,
  status     text        NOT NULL DEFAULT 'active'
             CONSTRAINT adjustment_reason_status_known CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT adjustment_reason_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT adjustment_reason_key_unique UNIQUE (tenant_id, key)
);

CREATE TRIGGER adjustment_reason_set_updated_at
  BEFORE UPDATE ON app.adjustment_reason
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- The FK target that scopes a reason to the kinds it may be used for.
CREATE TABLE app.adjustment_reason_kind (
  tenant_id uuid NOT NULL,
  reason_id uuid NOT NULL,
  kind      text NOT NULL
            CONSTRAINT adjustment_reason_kind_known
            CHECK (kind IN ('void', 'comp', 'discount', 'recall')),

  PRIMARY KEY (tenant_id, reason_id, kind),
  CONSTRAINT adjustment_reason_kind_reason_fk
  FOREIGN KEY (tenant_id, reason_id) REFERENCES app.adjustment_reason (tenant_id, id) ON DELETE CASCADE
);


-- `order` is a reserved word; `sales_order` avoids quoting it everywhere, same
-- reasoning as app_user and dining_table.
CREATE TABLE app.sales_order (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id         uuid        NOT NULL,
  session_id        uuid        NOT NULL,
  business_date     date        NOT NULL,

  status            text        NOT NULL DEFAULT 'open'
                    CONSTRAINT sales_order_status_known
                    CHECK (status IN ('open', 'confirmed', 'closed', 'cancelled')),
  version           integer     NOT NULL DEFAULT 1 CHECK (version > 0),

  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid       NOT NULL,

  CONSTRAINT sales_order_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT sales_order_session_fk
  FOREIGN KEY (tenant_id, session_id) REFERENCES app.table_session (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_order_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_order_creator_fk
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX sales_order_by_session_idx ON app.sales_order (tenant_id, session_id);


-- Positive rows create obligation; negative rows reduce it; `kind` says which kind
-- of reduction. SUM(quantity) is the truth, and it is the truth BECAUSE the sign
-- is real -- the discriminator is what stops a void being mistaken for a sale, so
-- the sign does not have to carry that job too.
CREATE TABLE app.order_line (
  id                        uuid        PRIMARY KEY,
  tenant_id                 uuid        NOT NULL,
  branch_id                 uuid        NOT NULL,
  order_id                  uuid        NOT NULL,

  kind                      text        NOT NULL
                            CONSTRAINT order_line_kind_known
                            CHECK (kind IN ('item', 'combo_parent', 'combo_component',
                                            'void', 'comp', 'discount')),
  parent_line_id            uuid,

  -- Reference for reporting joins. NEVER read for a number.
  menu_item_id              uuid,

  -- The priced-document rule: everything that can appear on a bill is snapshotted
  -- here at order time. A bill never dereferences a catalogue row for a value.
  display_name              text        NOT NULL,
  unit_price_minor          bigint,
  quantity                  integer     NOT NULL,
  line_total_minor          bigint,
  -- combo_parent only: what the bill shows for the group.
  display_total_minor       bigint,
  tax_class_key             text,
  tax_rate_bps              integer,
  tax_components            jsonb,
  -- Selected modifier names AND their deltas. These are the ones that get
  -- forgotten, and they are prices too.
  modifiers                 jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Adjustment rows only.
  adjusts_line_id           uuid,
  adjusted_kind             text,
  adjusted_unit_price_minor bigint,
  adjustment_reason_id      uuid,
  adjustment_note           text,

  -- The pre-fire / post-fire boundary. NULL means the kitchen has not seen it.
  fired_at                  timestamptz,

  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by_user_id        uuid        NOT NULL,

  CONSTRAINT order_line_tenant_id_key UNIQUE (tenant_id, id),
  -- FK targets that pin an adjustment to the row it adjusts.
  CONSTRAINT order_line_tenant_id_price_key UNIQUE (tenant_id, id, unit_price_minor),
  CONSTRAINT order_line_tenant_id_kind_key UNIQUE (tenant_id, id, kind),

  CONSTRAINT order_line_order_fk
  FOREIGN KEY (tenant_id, order_id) REFERENCES app.sales_order (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT order_line_parent_fk
  FOREIGN KEY (tenant_id, parent_line_id) REFERENCES app.order_line (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT order_line_menu_item_fk
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES app.menu_item (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT order_line_creator_fk
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  -- The adjustment's money is PINNED to the row it adjusts, so it cannot be
  -- re-derived from a live catalogue price.
  CONSTRAINT order_line_adjusts_price_fk
  FOREIGN KEY (tenant_id, adjusts_line_id, adjusted_unit_price_minor)
    REFERENCES app.order_line (tenant_id, id, unit_price_minor) ON DELETE RESTRICT,
  -- ...and an adjustment may only target a priced line, never a combo parent.
  CONSTRAINT order_line_adjusts_kind_fk
  FOREIGN KEY (tenant_id, adjusts_line_id, adjusted_kind)
    REFERENCES app.order_line (tenant_id, id, kind) ON DELETE RESTRICT,
  CONSTRAINT order_line_adjusts_priced_kind
  CHECK (adjusted_kind IS NULL OR adjusted_kind IN ('item', 'combo_component')),

  -- The reason must be scoped to this kind of adjustment.
  CONSTRAINT order_line_reason_fk
  FOREIGN KEY (tenant_id, adjustment_reason_id, kind)
    REFERENCES app.adjustment_reason_kind (tenant_id, reason_id, kind) ON DELETE RESTRICT,

  CONSTRAINT order_line_shape_exact
  CHECK (
    CASE kind
      WHEN 'item' THEN
        quantity > 0 AND unit_price_minor IS NOT NULL AND line_total_minor > 0
        AND display_total_minor IS NULL AND parent_line_id IS NULL
        AND adjusts_line_id IS NULL AND adjustment_reason_id IS NULL
      WHEN 'combo_parent' THEN
        quantity > 0 AND unit_price_minor IS NULL AND line_total_minor IS NULL
        AND display_total_minor IS NOT NULL AND parent_line_id IS NULL
        AND adjusts_line_id IS NULL AND adjustment_reason_id IS NULL
      WHEN 'combo_component' THEN
        quantity > 0 AND unit_price_minor IS NOT NULL AND line_total_minor > 0
        AND display_total_minor IS NULL AND parent_line_id IS NOT NULL
        AND adjusts_line_id IS NULL AND adjustment_reason_id IS NULL
      -- The food was not delivered, or was binned: sales quantity falls.
      WHEN 'void' THEN
        quantity < 0 AND line_total_minor < 0
        AND adjusts_line_id IS NOT NULL AND adjusted_unit_price_minor IS NOT NULL
        AND adjustment_reason_id IS NOT NULL AND parent_line_id IS NULL
      -- The food WAS delivered, free: quantity stands, only money goes.
      WHEN 'comp' THEN
        quantity = 0 AND line_total_minor < 0
        AND adjusts_line_id IS NOT NULL AND adjusted_unit_price_minor IS NOT NULL
        AND adjustment_reason_id IS NOT NULL AND parent_line_id IS NULL
      WHEN 'discount' THEN
        quantity = 0 AND line_total_minor < 0
        AND adjusts_line_id IS NOT NULL AND adjusted_unit_price_minor IS NOT NULL
        AND adjustment_reason_id IS NOT NULL AND parent_line_id IS NULL
      ELSE false
    END
  )
);

CREATE INDEX order_line_by_order_idx ON app.order_line (tenant_id, order_id);
CREATE INDEX order_line_by_parent_idx ON app.order_line (tenant_id, parent_line_id)
  WHERE parent_line_id IS NOT NULL;
CREATE INDEX order_line_by_adjusts_idx ON app.order_line (tenant_id, adjusts_line_id)
  WHERE adjusts_line_id IS NOT NULL;
CREATE INDEX order_line_unfired_idx ON app.order_line (tenant_id, order_id)
  WHERE fired_at IS NULL;


-- Pre-fire correction MUTATES the line; post-fire does not. The justification is
-- not that a pre-fire edit is cheap -- it is that the exception report's value is
-- inversely proportional to the noise in it. Force typo corrections into void rows
-- and every waiter generates a dozen "voids" a shift, nobody reads the report
-- within a week, and the actual fraud sits in it unnoticed.
--
-- A trigger because no CHECK can reference OLD.
CREATE FUNCTION app.deny_fired_line_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.fired_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF (NEW.quantity, NEW.unit_price_minor, NEW.line_total_minor, NEW.display_total_minor,
      NEW.modifiers, NEW.menu_item_id, NEW.kind)
     IS DISTINCT FROM
     (OLD.quantity, OLD.unit_price_minor, OLD.line_total_minor, OLD.display_total_minor,
      OLD.modifiers, OLD.menu_item_id, OLD.kind) THEN
    RAISE EXCEPTION
      'order line % has fired: quantity and money are immutable. Use a void, comp or discount row.',
      OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER order_line_fired_is_immutable
  BEFORE UPDATE ON app.order_line
  FOR EACH ROW EXECUTE FUNCTION app.deny_fired_line_mutation();


-- Deferred constraint triggers: family member 1 (combo allocation balances) and
-- member 2 (adjustments do not exceed the original).
--
-- DEFERRABLE INITIALLY DEFERRED because the rows are written together, and by the
-- time a nightly check runs the bill is printed and the return is filed. Nightly
-- is too late for money.
CREATE FUNCTION app.assert_order_line_invariants() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  offending record;
BEGIN
  -- 1. Every combo parent's components sum to its display total, exactly.
  SELECT p.id, p.display_total_minor, COALESCE(sum(c.line_total_minor), 0) AS allocated
    INTO offending
    FROM app.order_line p
    LEFT JOIN app.order_line c
      ON c.tenant_id = p.tenant_id AND c.parent_line_id = p.id AND c.kind = 'combo_component'
   WHERE p.kind = 'combo_parent'
     AND p.id = COALESCE(NEW.parent_line_id, NEW.id, OLD.parent_line_id, OLD.id)
   GROUP BY p.id, p.display_total_minor
  HAVING p.display_total_minor <> COALESCE(sum(c.line_total_minor), 0);

  IF FOUND THEN
    RAISE EXCEPTION
      'combo % allocates % across components but displays %',
      offending.id, offending.allocated, offending.display_total_minor
      USING ERRCODE = '23514';
  END IF;

  -- 2. Adjustments never take a line below zero, in quantity or in money.
  SELECT base.id,
         base.quantity + COALESCE(sum(adj.quantity), 0) AS net_quantity,
         base.line_total_minor + COALESCE(sum(adj.line_total_minor), 0) AS net_money
    INTO offending
    FROM app.order_line base
    LEFT JOIN app.order_line adj
      ON adj.tenant_id = base.tenant_id AND adj.adjusts_line_id = base.id
   WHERE base.kind IN ('item', 'combo_component')
     AND base.id = COALESCE(NEW.adjusts_line_id, NEW.id, OLD.adjusts_line_id, OLD.id)
   GROUP BY base.id, base.quantity, base.line_total_minor
  HAVING base.quantity + COALESCE(sum(adj.quantity), 0) < 0
      OR base.line_total_minor + COALESCE(sum(adj.line_total_minor), 0) < 0;

  IF FOUND THEN
    RAISE EXCEPTION
      'adjustments to line % leave net quantity % and net total %, both must be >= 0',
      offending.id, offending.net_quantity, offending.net_money
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER order_line_invariants
  AFTER INSERT OR UPDATE ON app.order_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_order_line_invariants();


ALTER TABLE app.adjustment_reason ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.adjustment_reason
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.adjustment_reason_kind ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.adjustment_reason_kind
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.sales_order ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sales_order
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.order_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.order_line
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
