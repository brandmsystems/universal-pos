-- The printed bill: what the paper says about the place, and a record of every
-- copy printed.
--
-- ###########################################################################
-- 1. THE OUTLET'S PHONE, BILL ADDRESS AND FOOTER LIVE ON THE BRANCH.
--
-- A bill is printed at an outlet, and two outlets of one restaurant have two
-- phone numbers and two addresses. `platform.tenant.address` stays the
-- restaurant's own address and is what a branch with no bill address prints.
-- The footer has a default rather than a NULL meaning "use the default": an
-- owner who wants no footer clears it to '', which is a stated choice.
-- ###########################################################################
ALTER TABLE app.branch
  ADD COLUMN phone text
    CONSTRAINT branch_phone_format CHECK (phone ~ '^\+?[0-9][0-9 -]{4,18}[0-9]$'),
  ADD COLUMN bill_address text
    CONSTRAINT branch_bill_address_length CHECK (length(bill_address) BETWEEN 1 AND 300),
  ADD COLUMN bill_footer text NOT NULL DEFAULT 'Thank you! Visit again'
    CONSTRAINT branch_bill_footer_length CHECK (length(bill_footer) <= 200);

-- ###########################################################################
-- 2. EVERY COPY PRINTED IS A ROW, SO A SECOND COPY SAYS SO ON THE PAPER.
--
-- A reprinted receipt passed off as an original is how a refund gets claimed
-- twice, so the copy number is counted here rather than remembered by a
-- tablet. `kind` separates the bill handed to the table from the receipt
-- printed after payment: the first receipt is an original even if the bill
-- was printed three times. Append-only by grant -- a print cannot be unprinted.
-- ###########################################################################
CREATE TABLE app.bill_print (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  bill_id            uuid        NOT NULL,
  kind               text        NOT NULL
                     CONSTRAINT bill_print_kind_known CHECK (kind IN ('bill', 'receipt')),
  copy_no            integer     NOT NULL CHECK (copy_no > 0),
  printed_at         timestamptz NOT NULL DEFAULT now(),
  printed_by_user_id uuid        NOT NULL,

  CONSTRAINT bill_print_bill_fk
  FOREIGN KEY (tenant_id, bill_id) REFERENCES app.bill (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_print_user_fk
  FOREIGN KEY (tenant_id, printed_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bill_print_copy_unique UNIQUE (tenant_id, bill_id, kind, copy_no)
);

ALTER TABLE app.bill_print ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill_print
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE UPDATE, DELETE, TRUNCATE ON app.bill_print FROM katkitchen_app;
