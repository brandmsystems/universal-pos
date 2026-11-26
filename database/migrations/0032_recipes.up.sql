-- Recipe / BOM. menu_item -> recipe_line -> product, the link missing from the
-- original diagram.

-- Monotonic across the tenant. Same gapless counter mechanism as fire and bill
-- numbers, and here it carries a structural guarantee rather than a display one.
CREATE TABLE app.recipe_publication_sequence (
  tenant_id uuid   NOT NULL PRIMARY KEY REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  next_no   bigint NOT NULL DEFAULT 0 CHECK (next_no >= 0)
);


CREATE TABLE app.recipe (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,

  -- Modifier options consume stock too: "extra cheese" is 30g of cheese, and
  -- Phase 2 already routes modifiers independently.
  kind               text        NOT NULL
                     CONSTRAINT recipe_kind_known
                     CHECK (kind IN ('menu_item', 'modifier_option', 'sub_recipe')),
  menu_item_id       uuid,
  modifier_option_id uuid,
  name               text        NOT NULL,

  -- Sub-recipes produce a measurable batch: 2000ml of sauce.
  output_unit_code   text,
  status             text        NOT NULL DEFAULT 'active'
                     CONSTRAINT recipe_status_known CHECK (status IN ('active', 'archived')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT recipe_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT recipe_menu_item_fk
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES app.menu_item (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT recipe_modifier_option_fk
  FOREIGN KEY (tenant_id, modifier_option_id) REFERENCES app.modifier_option (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT recipe_unit_fk
  FOREIGN KEY (tenant_id, output_unit_code) REFERENCES app.unit (tenant_id, code) ON DELETE RESTRICT,

  CONSTRAINT recipe_shape_exact
  CHECK (
    CASE kind
      WHEN 'menu_item' THEN menu_item_id IS NOT NULL AND modifier_option_id IS NULL
      WHEN 'modifier_option' THEN modifier_option_id IS NOT NULL AND menu_item_id IS NULL
      WHEN 'sub_recipe' THEN menu_item_id IS NULL AND modifier_option_id IS NULL
                              AND output_unit_code IS NOT NULL
      ELSE false
    END
  )
);

CREATE UNIQUE INDEX recipe_one_per_menu_item
  ON app.recipe (tenant_id, menu_item_id)
  WHERE menu_item_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX recipe_one_per_modifier_option
  ON app.recipe (tenant_id, modifier_option_id)
  WHERE modifier_option_id IS NOT NULL AND status = 'active';

CREATE TRIGGER recipe_set_updated_at
  BEFORE UPDATE ON app.recipe
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- Versioned, and published versions are IMMUTABLE. A stock movement references
-- the version, so editing a recipe cannot retroactively change what last week's
-- sales consumed -- the priced-document rule running in reverse.
--
-- This is exactly why recipe.edit is financial-class and reaches the exception
-- report: reducing a recipe quantity makes variance vanish.
CREATE TABLE app.recipe_version (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL,
  recipe_id            uuid        NOT NULL,
  version              integer     NOT NULL CHECK (version >= 1),

  status               text        NOT NULL DEFAULT 'draft'
                       CONSTRAINT recipe_version_status_known
                       CHECK (status IN ('draft', 'published', 'superseded')),

  -- Assigned at publish from the tenant-wide counter. Monotonic, and that is
  -- what makes the BOM acyclic BY CONSTRUCTION.
  publication_seq      bigint,
  -- Batch size for a sub-recipe; 1 serving for a menu item or modifier.
  output_qty_base      bigint      NOT NULL DEFAULT 1 CHECK (output_qty_base > 0),

  published_at         timestamptz,
  published_by_user_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT recipe_version_tenant_id_key UNIQUE (tenant_id, id),
  -- FK target so a line can pin the exact published version it references.
  CONSTRAINT recipe_version_tenant_id_seq_key UNIQUE (tenant_id, id, publication_seq),
  CONSTRAINT recipe_version_unique UNIQUE (tenant_id, recipe_id, version),
  CONSTRAINT recipe_version_seq_unique UNIQUE (tenant_id, publication_seq),

  CONSTRAINT recipe_version_recipe_fk
  FOREIGN KEY (tenant_id, recipe_id) REFERENCES app.recipe (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT recipe_version_user_fk
  FOREIGN KEY (tenant_id, published_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT recipe_version_publication_consistent
  CHECK ((status = 'draft') = (publication_seq IS NULL AND published_at IS NULL))
);

CREATE INDEX recipe_version_published_idx
  ON app.recipe_version (tenant_id, recipe_id, publication_seq DESC)
  WHERE status = 'published';


CREATE TABLE app.recipe_line (
  id                     uuid        PRIMARY KEY,
  tenant_id              uuid        NOT NULL,
  recipe_version_id      uuid        NOT NULL,
  -- Denormalised copy of the OWNING version's publication_seq, pinned by FK.
  -- NULL while the version is a draft.
  parent_publication_seq bigint,

  component_kind         text        NOT NULL
                         CONSTRAINT recipe_line_component_kind_known
                         CHECK (component_kind IN ('product', 'sub_recipe')),

  product_id             uuid,
  -- SNAPSHOT of the product's yield at the moment consumed_base was computed.
  -- Without it you cannot tell which yield produced a given figure, and that
  -- figure is an input to the variance number.
  --
  -- Deliberately NOT pinned by composite FK to product(yield_bps). The branch
  -- price override pins its copy because that constraint is about the CURRENT
  -- relationship and cascades. This is a historical record of what the yield WAS;
  -- pinning it to what the yield IS defeats its purpose and -- as this design
  -- originally did -- makes product.yield_bps impossible to edit at all.
  product_yield_bps      integer,

  sub_recipe_version_id  uuid,
  sub_publication_seq    bigint,

  -- What the chef wrote, in PREPPED quantity. Chefs write "100g diced onion".
  quantity_base          bigint      NOT NULL CHECK (quantity_base > 0),
  -- quantity_base * 10000 / yield, computed ONCE at publish. Per-order deduction
  -- is then a pure integer multiply with no rounding drift accumulating into
  -- variance.
  consumed_base          bigint      NOT NULL CHECK (consumed_base > 0),
  entered_unit_code      text,
  note                   text,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT recipe_line_version_fk
  FOREIGN KEY (tenant_id, recipe_version_id, parent_publication_seq)
    REFERENCES app.recipe_version (tenant_id, id, publication_seq) ON DELETE RESTRICT,
  CONSTRAINT recipe_line_product_fk
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.product (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT recipe_line_sub_fk
  FOREIGN KEY (tenant_id, sub_recipe_version_id, sub_publication_seq)
    REFERENCES app.recipe_version (tenant_id, id, publication_seq) ON DELETE RESTRICT,

  CONSTRAINT recipe_line_shape_exact
  CHECK (
    CASE component_kind
      WHEN 'product' THEN product_id IS NOT NULL AND product_yield_bps IS NOT NULL
                          AND sub_recipe_version_id IS NULL
      WHEN 'sub_recipe' THEN sub_recipe_version_id IS NOT NULL AND sub_publication_seq IS NOT NULL
                          AND product_id IS NULL
      ELSE false
    END
  ),

  -- #########################################################################
  -- ACYCLIC BY CONSTRUCTION.
  --
  -- A line may only reference an ALREADY-PUBLISHED version, and published
  -- versions are immutable. A cycle would need A.v1 -> B.v1 AND B.v1 -> A.v1,
  -- but B.v1 must have been published before A.v1 could reference it, at which
  -- point A.v1 did not exist. References always point BACKWARDS in publication
  -- order, so the version graph is a DAG.
  --
  -- This CHECK is the whole cycle prevention: a monotonic comparison instead of
  -- a recursive search, which eliminates the bug class rather than testing for
  -- it. Draft rows are exempt because parent_publication_seq is not yet known.
  --
  -- NOTE: the RECIPE-level graph may legitimately cycle. A.v2 -> B.v1 -> A.v1 is
  -- valid and terminates, because versions are pinned. Do NOT add a
  -- recipe-level cycle check: it would reject correct data.
  -- #########################################################################
  CONSTRAINT recipe_line_references_backwards
  CHECK (
    parent_publication_seq IS NULL
    OR sub_publication_seq IS NULL
    OR sub_publication_seq < parent_publication_seq
  )
);

CREATE INDEX recipe_line_by_version_idx ON app.recipe_line (tenant_id, recipe_version_id);
CREATE INDEX recipe_line_by_product_idx ON app.recipe_line (tenant_id, product_id)
  WHERE product_id IS NOT NULL;
CREATE INDEX recipe_line_by_sub_idx ON app.recipe_line (tenant_id, sub_recipe_version_id)
  WHERE sub_recipe_version_id IS NOT NULL;


-- The FLATTENED bill of materials, computed once at publish. Sub-recipes are
-- expanded here so a deduction only ever sees products -- no runtime traversal,
-- no per-order rounding, and the same "compute at publish" discipline as yield.
CREATE TABLE app.recipe_version_expansion (
  tenant_id         uuid        NOT NULL,
  recipe_version_id uuid        NOT NULL,
  product_id        uuid        NOT NULL,
  consumed_base     bigint      NOT NULL CHECK (consumed_base > 0),
  depth             smallint    NOT NULL CHECK (depth BETWEEN 0 AND 8),
  created_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, recipe_version_id, product_id),
  CONSTRAINT recipe_version_expansion_version_fk
  FOREIGN KEY (tenant_id, recipe_version_id) REFERENCES app.recipe_version (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT recipe_version_expansion_product_fk
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.product (tenant_id, id) ON DELETE RESTRICT
);


-- Published versions are immutable, which is what the acyclicity argument rests
-- on. Only the one-way transition to 'superseded' is permitted.
CREATE FUNCTION app.deny_published_recipe_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'published' THEN RETURN NEW; END IF;

  IF NEW.status = 'superseded'
     AND (NEW.id, NEW.recipe_id, NEW.version, NEW.publication_seq, NEW.output_qty_base)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.recipe_id, OLD.version, OLD.publication_seq, OLD.output_qty_base) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'recipe version % is published and immutable; publish a new version instead', OLD.id
    USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER recipe_version_published_is_immutable
  BEFORE UPDATE ON app.recipe_version
  FOR EACH ROW EXECUTE FUNCTION app.deny_published_recipe_rewrite();

-- Immutability has to reach the LINES too. Without this, a line can be appended
-- to an already-published version with a NULL parent_publication_seq, which the
-- backwards-reference CHECK exempts -- and the cycle guarantee evaporates.
--
-- Guarded on a GUC the publisher sets, same shape as the kot_state derivation:
-- only the publish path may stamp parent_publication_seq.
CREATE FUNCTION app.deny_published_recipe_line_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid := COALESCE(NEW.recipe_version_id, OLD.recipe_version_id);
  target_tenant uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
BEGIN
  IF COALESCE(current_setting('app.recipe_publishing', true), 'off') = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF EXISTS (SELECT 1 FROM app.recipe_version
              WHERE tenant_id = target_tenant AND id = target AND status <> 'draft') THEN
    RAISE EXCEPTION
      'recipe version % is published; its lines are immutable. Publish a new version instead.',
      target USING ERRCODE = '42501';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER recipe_line_published_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON app.recipe_line
  FOR EACH ROW EXECUTE FUNCTION app.deny_published_recipe_line_rewrite();

ALTER TABLE app.recipe_publication_sequence ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.recipe_publication_sequence
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.recipe ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.recipe
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.recipe_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.recipe_version
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.recipe_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.recipe_line
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.recipe_version_expansion ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.recipe_version_expansion
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
