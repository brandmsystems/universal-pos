-- Cash handed over is not cash taken.
--
-- ###########################################################################
-- A customer settling ₹350 with a ₹500 note hands over ₹500, the bill takes
-- ₹350 and ₹150 goes back across the counter. Until now the till could record
-- only the amount, so the cashier either keyed ₹350 and the receipt said
-- nothing about the note, or keyed ₹500 and `tender_invariants` refused it as
-- an overpayment. Recording the ₹500 as the tender would have been worse: it
-- would put ₹150 of change into sales.
--
-- So `amount_minor` stays exactly what it was -- the part applied to the bill,
-- the only figure sales, the invariants and reconciliation read -- and the note
-- is recorded beside it. Change is DERIVED (received - amount), never stored:
-- a stored change column is a second opinion that can disagree with the two
-- numbers it came from.
--
-- NULL means "the note was not recorded", which is every cash tender before
-- this migration and every one taken without the field. It is not backfilled:
-- writing received = amount into history would assert a fact nobody recorded.
-- Change on such a row is reported as zero, which is what the receipt already
-- implied. Only a cash CAPTURE can carry it -- a card has no change, and a void
-- reverses the amount, not the note.
-- ###########################################################################
ALTER TABLE app.tender
  ADD COLUMN cash_received_minor bigint
    CONSTRAINT tender_cash_received_shape CHECK (
      cash_received_minor IS NULL
      OR (method = 'cash' AND kind = 'capture' AND cash_received_minor >= amount_minor)
    );
