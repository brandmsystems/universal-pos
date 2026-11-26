-- What kind of business a tenant runs: the key of an entry in the business-type
-- registry (shared/src/constants/businessTypes.ts).
--
-- ###########################################################################
-- ONLY THE KEY IS STORED. The words, the navigation and the theme of each type
-- live in that registry, in code, read by the API and by every web client; a
-- table copy of them would be a second definition that agrees today. The CHECK
-- below lists the registry's keys and a test asserts the two are the same set.
--
-- text + CHECK, never a native enum (a CHECK can be altered in a migration, an
-- enum value cannot be removed). Every existing tenant is a restaurant, which
-- is what the DEFAULT says, so nothing changes for them. The default is NOT a
-- claim that a new tenant is a restaurant: the control plane states the type
-- when it creates one, and the Super Admin's form has no preselected answer.
--
-- Control plane only. `platform.tenant` is not reachable from the tenant plane
-- and no tenant request names this column.
-- ###########################################################################
ALTER TABLE platform.tenant
  ADD COLUMN business_type text NOT NULL DEFAULT 'restaurant'
    CONSTRAINT tenant_business_type_known
    CHECK (business_type IN ('restaurant', 'optical', 'clothing', 'supermarket',
                             'mobile', 'salon', 'general_retail'));
