-- Deliberately does NOT re-activate the revoked staff passwords. Bringing a
-- revoked secret back to life on a rollback would re-open a sign-in somebody
-- decided to close, with nobody choosing to; a rolled-back deployment that
-- wants staff passwords again sets new ones. Same posture as 0042 and 0059: a
-- rollback does not rewrite what already happened. There is no schema change
-- to undo.
SELECT 1;
