-- ###########################################################################
-- A RESTAURANT'S OWN LOOK: ADDRESS, THEME COLOUR AND LOGO.
--
-- On platform.tenant because that is the restaurant's row and the control plane
-- (the Sales Person) sets them. The tenant plane never reads them per request:
-- the admin app reads them from the PUBLIC restaurant lookup it already makes
-- for its own `/{slug}` page, which carries nothing the address does not.
--
-- The colour is stored lowercase `#rrggbb` only. A free-text colour is a CSS
-- injection point the moment it is written into a style attribute.
-- ###########################################################################
ALTER TABLE platform.tenant
  ADD COLUMN address text
    CONSTRAINT tenant_address_length
    CHECK (address IS NULL OR length(btrim(address)) BETWEEN 5 AND 500),
  ADD COLUMN theme_color text
    CONSTRAINT tenant_theme_color_hex
    CHECK (theme_color IS NULL OR theme_color ~ '^#[0-9a-f]{6}$');

-- ###########################################################################
-- THE LOGO LIVES IN THE DATABASE, BOUNDED.
--
-- There is no object store in this stack. A 256 KB cap and three raster types
-- keep it a row rather than a file server: SVG is deliberately excluded, because
-- an SVG is a document that can carry script and it is served from our origin.
-- The declared type is checked against the file's own first bytes before it is
-- stored; `sha256` versions the public URL so a replaced logo is not served
-- from a stale cache.
-- ###########################################################################
CREATE TABLE platform.tenant_logo (
  tenant_id     uuid        PRIMARY KEY REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  content_type  text        NOT NULL
                CONSTRAINT tenant_logo_type_known
                CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes         bytea       NOT NULL
                CONSTRAINT tenant_logo_size
                CHECK (octet_length(bytes) BETWEEN 1 AND 262144),
  sha256        bytea       NOT NULL CHECK (octet_length(sha256) = 32),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by_platform_user_id uuid NOT NULL REFERENCES platform.platform_user (id) ON DELETE RESTRICT
);

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.tenant_logo TO katkitchen_app;
GRANT SELECT ON platform.tenant_logo TO katkitchen_platform_readonly;

-- ###########################################################################
-- STAFF SET THEIR OWN PASSWORD OR PIN FROM A SETUP CODE.
--
-- app.staff_invite (0018) was built for this and never reached: it required an
-- email, and a waiter or cashier usually has none -- they sign in on the till
-- with a staff code and a PIN. So an invite now names EITHER an email or a
-- staff code (the same rule app_user has), and says which credential the
-- person will set, because a PIN and a password are set by different screens
-- and checked by different policies.
-- ###########################################################################
ALTER TABLE app.staff_invite
  ALTER COLUMN email DROP NOT NULL,
  ADD COLUMN employee_code text,
  ADD COLUMN phone text
    CONSTRAINT staff_invite_phone_format
    CHECK (phone IS NULL OR phone ~ '^\+?[0-9][0-9 ()-]{5,19}$'),
  ADD COLUMN credential_type text NOT NULL DEFAULT 'password'
    CONSTRAINT staff_invite_credential_type_known
    CHECK (credential_type IN ('password', 'pin')),
  ADD CONSTRAINT staff_invite_identified
    CHECK (email IS NOT NULL OR employee_code IS NOT NULL),
  -- A password is typed with an email; a PIN is typed after a staff code.
  ADD CONSTRAINT staff_invite_credential_needs_identifier
    CHECK ((credential_type = 'password' AND email IS NOT NULL)
        OR (credential_type = 'pin' AND employee_code IS NOT NULL));

ALTER TABLE app.staff_invite ALTER COLUMN credential_type DROP DEFAULT;

CREATE UNIQUE INDEX staff_invite_one_pending_per_code
  ON app.staff_invite (tenant_id, employee_code)
  WHERE status = 'pending' AND employee_code IS NOT NULL;

ALTER TABLE platform.auth_attempt DROP CONSTRAINT auth_attempt_method_known;
ALTER TABLE platform.auth_attempt ADD CONSTRAINT auth_attempt_method_known CHECK (
  method IN ('password', 'pin', 'refresh', 'device_enrol', 'owner_invite', 'staff_invite'));
