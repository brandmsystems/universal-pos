-- Settings, not records: a bill already printed is counted in `app.bill_print`,
-- which this does not touch. The till prints its built-in headings again.
ALTER TABLE app.branch
  DROP COLUMN bill_heading_paid,
  DROP COLUMN bill_heading_part_paid,
  DROP COLUMN bill_heading_unpaid;
