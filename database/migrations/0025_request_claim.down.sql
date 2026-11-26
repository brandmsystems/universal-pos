DROP FUNCTION IF EXISTS app.purge_request_claims(integer, integer);
DROP INDEX IF EXISTS app.request_claim_created_at_idx;
DROP TABLE IF EXISTS app.request_claim;
