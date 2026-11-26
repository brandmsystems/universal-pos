-- The kitchen note: "no onions", "well done", "allergy - nuts".
--
-- ###########################################################################
-- THE PRINTER ALREADY RENDERED THIS COLUMN AND NOTHING EVER FILLED IT.
--
-- `kot_line.note` has existed since 0028 and `renderTicket` prints it under the
-- item. But there was nowhere for a waiter to put a note: `order_line` had no
-- note column, and `fireOrder` had nothing to copy. So the path from "no
-- onions" to the person holding the pan did not exist, end to end, while
-- looking complete from either end.
--
-- That failure is silent and it reaches the customer: the note is typed, the
-- ticket prints without it, and the dish arrives wrong. An allergy note makes
-- it worse than wrong.
-- ###########################################################################
ALTER TABLE app.order_line ADD COLUMN note text;

-- Bounded, because it prints on 80mm thermal paper and an unbounded note pushes
-- the item off the ticket -- the same reasoning as the audit payload cap.
ALTER TABLE app.order_line
  ADD CONSTRAINT order_line_note_length CHECK (note IS NULL OR length(note) <= 200);

-- An adjustment row carries `adjustment_note`, which is a different thing with a
-- different reader: the reason a manager voided, read by the exception report,
-- not an instruction to a cook. Keeping both and letting an adjustment carry a
-- kitchen note would make the exception report's note column ambiguous.
ALTER TABLE app.order_line
  ADD CONSTRAINT order_line_note_only_on_orderable
  CHECK (note IS NULL OR kind IN ('item', 'combo_parent', 'combo_component'));
