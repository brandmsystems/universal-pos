-- The heading printed at the top of a bill, by how much of it is paid.
--
-- ###########################################################################
-- Three settings beside 0078's and 0080's, on the branch, because the bill is
-- printed at an outlet. Each has a default rather than a NULL meaning "use the
-- default": BILL and PART PAID as before, and INVOICE for a bill paid in full
-- (what the till has printed since 2026-11-23). Every existing branch takes the
-- defaults, so nothing prints differently until a manager changes it.
--
-- A heading is read when the bill is printed, as the footer is: a reprint uses
-- the heading saved now. It is wording, never a figure, so the priced-document
-- rule does not reach it; `kind` and the copy count stay the server's.
--
-- 1 to 20 printable ASCII characters, no space at either end. Twenty leaves
-- room for " · COPY 12" across a 2-inch roll; ASCII because a till's direct
-- ESC/POS print is code page 437, where anything else prints as '?'.
-- ###########################################################################
ALTER TABLE app.branch
  ADD COLUMN bill_heading_unpaid text NOT NULL DEFAULT 'BILL'
    CONSTRAINT branch_bill_heading_unpaid_text
    CHECK (bill_heading_unpaid ~ '^[!-~]([ -~]{0,18}[!-~])?$'),
  ADD COLUMN bill_heading_part_paid text NOT NULL DEFAULT 'PART PAID'
    CONSTRAINT branch_bill_heading_part_paid_text
    CHECK (bill_heading_part_paid ~ '^[!-~]([ -~]{0,18}[!-~])?$'),
  ADD COLUMN bill_heading_paid text NOT NULL DEFAULT 'INVOICE'
    CONSTRAINT branch_bill_heading_paid_text
    CHECK (bill_heading_paid ~ '^[!-~]([ -~]{0,18}[!-~])?$');
