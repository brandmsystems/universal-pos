-- How a bill is laid out on paper, and which printer it is laid out for.
--
-- ###########################################################################
-- 1. A PRINTER STATES WHAT IT IS AND WHAT PAPER IT TAKES. TYPE IS NOT SIZE.
--
-- A 3-inch thermal roll and an A4 laser page are different printers before
-- they are different sizes, so the type is its own column and the paper is
-- checked against it: a roll belongs to a thermal printer and only to one,
-- and a roll has no landscape. A NETWORK printer is driven by the server's
-- print worker, which sends raw ESC/POS text -- only a thermal printer speaks
-- that, so a network printer is thermal by CHECK rather than by hope. A USB or
-- Bluetooth printer is reached through the till's own print dialog, which is
-- what lets it be any type.
--
-- Every existing row is a thermal 3-inch (80 mm) roll, which is what the
-- printed bill was laid out for until now, so nothing prints differently.
-- ###########################################################################
ALTER TABLE app.printer
  ADD COLUMN printer_type text NOT NULL DEFAULT 'thermal'
    CONSTRAINT printer_type_known CHECK (printer_type IN ('thermal', 'laser', 'inkjet')),
  ADD COLUMN paper_size text NOT NULL DEFAULT 'thermal_80'
    CONSTRAINT printer_paper_known
    CHECK (paper_size IN ('thermal_58', 'thermal_80', 'thermal_112', 'a5', 'a4')),
  ADD COLUMN orientation text NOT NULL DEFAULT 'portrait'
    CONSTRAINT printer_orientation_known CHECK (orientation IN ('portrait', 'landscape')),
  ADD COLUMN margin_mm smallint NOT NULL DEFAULT 3
    CONSTRAINT printer_margin_range CHECK (margin_mm BETWEEN 0 AND 20),
  ADD COLUMN font_size_px smallint NOT NULL DEFAULT 12
    CONSTRAINT printer_font_size_range CHECK (font_size_px BETWEEN 9 AND 18),
  ADD CONSTRAINT printer_paper_fits_type
    CHECK ((printer_type = 'thermal') = (paper_size IN ('thermal_58', 'thermal_80', 'thermal_112'))),
  ADD CONSTRAINT printer_roll_is_portrait
    CHECK (printer_type <> 'thermal' OR orientation = 'portrait'),
  ADD CONSTRAINT printer_network_is_thermal
    CHECK (connection_kind <> 'network' OR printer_type = 'thermal'),
  -- The target of the branch's bill-printer FK below: a printer of THAT branch.
  ADD CONSTRAINT printer_branch_id_key UNIQUE (tenant_id, branch_id, id);

-- ###########################################################################
-- 2. WHAT THE BILL SHOWS, WHICH COPIES PRINT, AND WHEN -- PER BRANCH.
--
-- Beside 0069's phone, address and footer, for the same reason: a bill is
-- printed at an outlet. `bill_printer_id` NULL is a stated choice, not an
-- absence read as a default: the till prints through its own dialog at the
-- 3-inch layout. The FK carries the branch, so a bill cannot be laid out for
-- another outlet's printer.
--
-- The copies are three booleans and at least one is on: a till set to print
-- nothing would confirm orders the kitchen never hears about.
-- ###########################################################################
ALTER TABLE app.branch
  ADD COLUMN bill_printer_id uuid,
  ADD COLUMN bill_show_logo boolean NOT NULL DEFAULT true,
  ADD COLUMN bill_show_details boolean NOT NULL DEFAULT true,
  ADD COLUMN bill_show_customer boolean NOT NULL DEFAULT true,
  ADD COLUMN bill_show_tax boolean NOT NULL DEFAULT true,
  ADD COLUMN bill_show_payments boolean NOT NULL DEFAULT true,
  ADD COLUMN bill_copy_customer boolean NOT NULL DEFAULT true,
  ADD COLUMN bill_copy_kitchen boolean NOT NULL DEFAULT true,
  ADD COLUMN bill_copy_counter boolean NOT NULL DEFAULT true,
  ADD COLUMN bill_auto_print boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT branch_bill_prints_a_copy
    CHECK (bill_copy_customer OR bill_copy_kitchen OR bill_copy_counter),
  ADD CONSTRAINT branch_bill_printer_fk
    FOREIGN KEY (tenant_id, id, bill_printer_id) REFERENCES app.printer (tenant_id, branch_id, id)
    ON DELETE RESTRICT;
