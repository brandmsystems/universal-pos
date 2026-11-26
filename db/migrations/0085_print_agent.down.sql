ALTER TABLE app.printer
  DROP CONSTRAINT printer_reach_error_when_unreachable,
  DROP CONSTRAINT printer_reach_observed,
  DROP COLUMN test_print_error,
  DROP COLUMN test_printed_at,
  DROP COLUMN test_print_requested_at,
  DROP COLUMN reach_error,
  DROP COLUMN reachable,
  DROP COLUMN reach_checked_at;

DROP TABLE app.print_agent;
