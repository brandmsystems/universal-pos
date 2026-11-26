ALTER TABLE app.order_line DROP CONSTRAINT IF EXISTS order_line_note_only_on_orderable;
ALTER TABLE app.order_line DROP CONSTRAINT IF EXISTS order_line_note_length;
ALTER TABLE app.order_line DROP COLUMN IF EXISTS note;
