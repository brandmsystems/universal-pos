-- Suppliers, purchase orders, goods receipts.
--
-- The vendor master is the fake-vendor half of the second separation rule:
-- supplier.create/edit are financial-class CONFIGURATION keys precisely so a new
-- supplier appearing shortly before a large PO reaches the exception report.
-- Nothing in this migration should make that easier to route around.

CREATE TABLE app.supplier (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key           text        NOT NULL CONSTRAINT supplier_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name          text        NOT NULL,
  contact_name  text,
  phone         text,
  email         text,
  address       text,
  tax_reference text,

  -- Days. Informational for Phase 4; dunning and ageing are Phase 5.
  payment_terms_days smallint CHECK (payment_terms_days >= 0),

  status        text        NOT NULL DEFAULT 'active'
                CONSTRAINT supplier_status_known CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid   NOT NULL,

  CONSTRAINT supplier_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT supplier_creator_fk
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT
);

-- Partial, per rule 11: an archived supplier must not block re-creating the key.
CREATE UNIQUE INDEX supplier_key_unique
  ON app.supplier (tenant_id, key) WHERE status = 'active';

CREATE TRIGGER supplier_set_updated_at
  BEFORE UPDATE ON app.supplier
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Which products a supplier sells, in which unit, at what indicative price. The
-- price here is indicative ONLY: the PO line snapshots its own, and the receipt
-- values stock from the PO line. Same priced-document reasoning as the menu.
CREATE TABLE app.supplier_product (
  tenant_id        uuid   NOT NULL,
  supplier_id      uuid   NOT NULL,
  product_id       uuid   NOT NULL,
  supplier_sku     text,
  order_unit_code  text   NOT NULL,
  list_price_minor bigint CHECK (list_price_minor >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, supplier_id, product_id),
  CONSTRAINT supplier_product_supplier_fk
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES app.supplier (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_product_unit_fk
  FOREIGN KEY (tenant_id, product_id, order_unit_code)
    REFERENCES app.product_unit (tenant_id, product_id, unit_code) ON DELETE RESTRICT
);


CREATE TABLE app.purchase_order (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id     uuid        NOT NULL,
  supplier_id   uuid        NOT NULL,

  -- Display number. May gap, per the display-number rule: identity is the UUID,
  -- and a PO that fails to save must not burn a number a supplier has been read.
  po_number     text        NOT NULL,

  status        text        NOT NULL DEFAULT 'draft'
                CONSTRAINT purchase_order_status_known
                CHECK (status IN ('draft', 'approved', 'partially_received',
                                  'received', 'cancelled')),
  currency      text        NOT NULL
                CONSTRAINT purchase_order_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  expected_at   date,
  note          text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid  NOT NULL,
  approved_at   timestamptz,
  approved_by_user_id uuid,
  cancelled_at  timestamptz,

  CONSTRAINT purchase_order_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT purchase_order_number_unique UNIQUE (tenant_id, po_number),
  CONSTRAINT purchase_order_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_supplier_fk
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES app.supplier (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_creator_fk
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_approver_fk
  FOREIGN KEY (tenant_id, approved_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  -- Approval is the commitment of spend, so it must be attributable. Everything
  -- past draft has an approver; a draft has none. Absence is not the
  -- discriminator -- status is.
  CONSTRAINT purchase_order_approval_consistent
  CHECK (
    CASE status
      WHEN 'draft'     THEN approved_at IS NULL AND approved_by_user_id IS NULL
      WHEN 'cancelled' THEN true
      ELSE approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL
    END
  )
);

CREATE INDEX purchase_order_by_supplier_idx
  ON app.purchase_order (tenant_id, supplier_id, created_at DESC);

CREATE TABLE app.purchase_order_line (
  id                uuid   PRIMARY KEY,
  tenant_id         uuid   NOT NULL,
  purchase_order_id uuid   NOT NULL,
  product_id        uuid   NOT NULL,

  order_unit_code   text   NOT NULL,
  -- What was ordered, in the ORDER unit and in base units. Both, because the
  -- supplier reads "10 tins" on the paper and stock moves in millilitres.
  ordered_qty       numeric NOT NULL CHECK (ordered_qty > 0),
  ordered_qty_base  bigint  NOT NULL CHECK (ordered_qty_base > 0),

  -- Snapshotted at approval, never dereferenced afterwards: supplier_product
  -- list prices change and a historical PO must still reconcile to its receipt.
  unit_price_minor  bigint  NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor  bigint  NOT NULL CHECK (line_total_minor >= 0),

  CONSTRAINT purchase_order_line_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT purchase_order_line_po_fk
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES app.purchase_order (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT purchase_order_line_unit_fk
  FOREIGN KEY (tenant_id, product_id, order_unit_code)
    REFERENCES app.product_unit (tenant_id, product_id, unit_code) ON DELETE RESTRICT
);

CREATE INDEX purchase_order_line_by_po_idx
  ON app.purchase_order_line (tenant_id, purchase_order_id);


-- Partial receipt is the NORMAL case, not an exception: a supplier short-ships
-- and the kitchen still needs what did arrive. So a receipt is its own document
-- with its own lines, and a PO can have many.
CREATE TABLE app.goods_receipt (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  branch_id         uuid        NOT NULL,
  purchase_order_id uuid        NOT NULL,
  business_date     date        NOT NULL,

  status            text        NOT NULL DEFAULT 'draft'
                    CONSTRAINT goods_receipt_status_known
                    CHECK (status IN ('draft', 'posted')),
  supplier_note_ref text,
  note              text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  received_by_user_id uuid      NOT NULL,
  posted_at         timestamptz,

  CONSTRAINT goods_receipt_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT goods_receipt_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES app.branch (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT goods_receipt_po_fk
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES app.purchase_order (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT goods_receipt_receiver_fk
  FOREIGN KEY (tenant_id, received_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT goods_receipt_posting_consistent
  CHECK ((status = 'posted') = (posted_at IS NOT NULL))
);

CREATE INDEX goods_receipt_by_po_idx ON app.goods_receipt (tenant_id, purchase_order_id);

CREATE TABLE app.goods_receipt_line (
  id                     uuid   PRIMARY KEY,
  tenant_id              uuid   NOT NULL,
  goods_receipt_id       uuid   NOT NULL,
  purchase_order_line_id uuid   NOT NULL,
  product_id             uuid   NOT NULL,

  received_qty_base      bigint NOT NULL CHECK (received_qty_base > 0),

  -- What was actually invoiced, which is not always what was ordered. Stock is
  -- valued from THIS, not from the PO line: valuing a receipt at the ordered
  -- price hides every supplier price rise inside stock variance, which is the one
  -- report where nobody would think to look for it.
  --
  -- The TOTAL is the authority and the per-unit price is informational, not the
  -- other way round. An invoice states a line total; deriving it from a rounded
  -- per-unit price over a fractional quantity produces a figure that disagrees
  -- with the paper by a few paise on every line.
  unit_price_minor       bigint NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor       bigint NOT NULL CHECK (line_total_minor >= 0),

  -- Over-receipt is permitted, bounded, and must be explained. Refusing it
  -- outright means the goods are in the walk-in and not in the system, which is
  -- worse than a recorded exception.
  over_receipt_reason_id uuid,
  over_receipt_kind      text   NOT NULL DEFAULT 'adjustment'
                         CONSTRAINT goods_receipt_line_reason_kind_pinned
                         CHECK (over_receipt_kind = 'adjustment'),
  note                   text,

  CONSTRAINT goods_receipt_line_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT goods_receipt_line_unique UNIQUE (tenant_id, goods_receipt_id, purchase_order_line_id),
  CONSTRAINT goods_receipt_line_receipt_fk
  FOREIGN KEY (tenant_id, goods_receipt_id) REFERENCES app.goods_receipt (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT goods_receipt_line_po_line_fk
  FOREIGN KEY (tenant_id, purchase_order_line_id)
    REFERENCES app.purchase_order_line (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT goods_receipt_line_product_fk
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.product (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT goods_receipt_line_over_reason_fk
  FOREIGN KEY (tenant_id, over_receipt_reason_id, over_receipt_kind)
    REFERENCES app.stock_reason_kind (tenant_id, reason_id, kind) ON DELETE RESTRICT
);

CREATE INDEX goods_receipt_line_by_po_line_idx
  ON app.goods_receipt_line (tenant_id, purchase_order_line_id);

-- Tolerance is tenant policy, not a constant in code -- same reasoning as the
-- suspension ladder thresholds. A dairy supplier over-delivering by 2% is
-- routine; a 40% over-delivery is somebody's mistake or somebody's fraud.
ALTER TABLE app.branch
  ADD COLUMN over_receipt_tolerance_bps integer NOT NULL DEFAULT 500
  CONSTRAINT branch_over_receipt_tolerance_range CHECK (over_receipt_tolerance_bps BETWEEN 0 AND 10000);

ALTER TABLE app.supplier ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.supplier
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.supplier_product ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.supplier_product
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.purchase_order ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.purchase_order
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.purchase_order_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.purchase_order_line
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.goods_receipt ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.goods_receipt
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.goods_receipt_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.goods_receipt_line
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
