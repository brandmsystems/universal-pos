DROP TABLE app.bill_print;

ALTER TABLE app.branch
  DROP COLUMN bill_footer,
  DROP COLUMN bill_address,
  DROP COLUMN phone;
