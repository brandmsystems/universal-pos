-- Whether a printed copy names itself at the top (CUSTOMER / KITCHEN / COUNTER).
--
-- ###########################################################################
-- One more show flag beside 0078's, on the branch, defaulting to what every
-- branch prints today (the name shown). It hides the NAME only: a reprint still
-- says REPRINT, because that word is what stops a second copy passing for the
-- first in a dispute, and a parcel still says PARCEL.
-- ###########################################################################
ALTER TABLE app.branch
  ADD COLUMN bill_show_copy_label boolean NOT NULL DEFAULT true;
