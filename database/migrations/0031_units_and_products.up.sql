-- Units of measure. Done first because getting this wrong poisons every number
-- downstream, and it cannot be corrected once movements exist.

CREATE TABLE app.unit (
  tenant_id  uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  code       text        NOT NULL CONSTRAINT unit_code_format CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name       text        NOT NULL,
  -- Informational, for UI grouping and for seeding standard conversions. It is
  -- NOT an integrity rule: see product_unit.
  dimension  text        NOT NULL
             CONSTRAINT unit_dimension_known
             CHECK (dimension IN ('mass', 'volume', 'count', 'length')),
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, code)
);


CREATE TABLE app.product (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES platform.tenant (id) ON DELETE RESTRICT,
  key                text        NOT NULL CONSTRAINT product_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name               text        NOT NULL,

  -- Every quantity anywhere in the system is a bigint in units of
  -- 10^-base_scale base units. Exactly the money discipline, for exactly the same
  -- reason: float grams do not reconcile, and a variance report that disagrees
  -- with itself by 0.0001 is a report nobody trusts.
  --
  -- base_scale is per PRODUCT because the useful resolution differs by three
  -- orders of magnitude between rice and saffron.
  base_unit_code     text        NOT NULL,
  base_scale         smallint    NOT NULL DEFAULT 0
                     CONSTRAINT product_base_scale_range CHECK (base_scale BETWEEN 0 AND 6),

  -- Yield loss is a PRODUCT property. 1kg of onions purchased is ~850g usable.
  -- If yield lived on the recipe, every recipe using onion would carry its own
  -- copy of 0.85 and they would drift.
  --
  -- Minimum 1, never 0: it is a divisor.
  yield_bps          integer     NOT NULL DEFAULT 10000
                     CONSTRAINT product_yield_range CHECK (yield_bps BETWEEN 1 AND 10000),

  -- Role designations. The conversion itself lives in product_unit.
  purchase_unit_code text,
  stock_unit_code    text,
  recipe_unit_code   text,

  status             text        NOT NULL DEFAULT 'active'
                     CONSTRAINT product_status_known CHECK (status IN ('active', 'archived')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT product_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT product_key_unique UNIQUE (tenant_id, key),
  CONSTRAINT product_base_unit_fk
  FOREIGN KEY (tenant_id, base_unit_code) REFERENCES app.unit (tenant_id, code) ON DELETE RESTRICT
);

CREATE TRIGGER product_set_updated_at
  BEFORE UPDATE ON app.product
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();


-- Conversions are PER PRODUCT, expressed as RATIONALS.
--
-- Per product because a "bunch" of coriander is a weight that varies by supplier,
-- and a global `bunch = 80g` row is wrong for everyone the moment there is a
-- second supplier. The unit VOCABULARY is tenant-level; the conversion is not.
--
-- Rational rather than a float multiplier because 1 portion = 1/3 pack is a real
-- case, and a float reintroduces exactly the drift the integer base was chosen to
-- avoid.
--
-- ###########################################################################
-- CROSS-DIMENSION CONVERSION IS LEGITIMATE AND DELIBERATE.
--
-- `bunch` (count) -> `g` (mass) is the coriander case and the entire reason
-- conversions are per-product. Do NOT add a CHECK requiring unit.dimension to
-- match the product's base unit dimension: it looks like an integrity rule and
-- it is not one -- it would forbid the only interesting conversions.
-- ###########################################################################
CREATE TABLE app.product_unit (
  tenant_id          uuid        NOT NULL,
  product_id         uuid        NOT NULL,
  unit_code          text        NOT NULL,

  -- qty_in_base = qty * numerator / denominator, integer arithmetic,
  -- rounded half-up to the base scale. The ROUNDED INTEGER is what gets stored;
  -- the expression never is.
  factor_numerator   bigint      NOT NULL CHECK (factor_numerator > 0),
  factor_denominator bigint      NOT NULL DEFAULT 1 CHECK (factor_denominator > 0),

  created_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, product_id, unit_code),
  CONSTRAINT product_unit_product_fk
  FOREIGN KEY (tenant_id, product_id) REFERENCES app.product (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_unit_unit_fk
  FOREIGN KEY (tenant_id, unit_code) REFERENCES app.unit (tenant_id, code) ON DELETE RESTRICT
);

ALTER TABLE app.product
  ADD CONSTRAINT product_purchase_unit_fk
  FOREIGN KEY (tenant_id, id, purchase_unit_code)
    REFERENCES app.product_unit (tenant_id, product_id, unit_code) ON DELETE RESTRICT,
  ADD CONSTRAINT product_stock_unit_fk
  FOREIGN KEY (tenant_id, id, stock_unit_code)
    REFERENCES app.product_unit (tenant_id, product_id, unit_code) ON DELETE RESTRICT,
  ADD CONSTRAINT product_recipe_unit_fk
  FOREIGN KEY (tenant_id, id, recipe_unit_code)
    REFERENCES app.product_unit (tenant_id, product_id, unit_code) ON DELETE RESTRICT;


-- numeric input (exact decimal, never float), bigint output. The caller may type
-- "1.5 kg"; what is stored is an integer in the product's scaled base unit.
CREATE FUNCTION app.to_base(
  p_tenant uuid, p_product uuid, p_unit text, p_qty numeric
) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  num   bigint;
  den   bigint;
  scale smallint;
BEGIN
  SELECT pu.factor_numerator, pu.factor_denominator, p.base_scale
    INTO num, den, scale
    FROM app.product_unit pu
    JOIN app.product p ON p.tenant_id = pu.tenant_id AND p.id = pu.product_id
   WHERE pu.tenant_id = p_tenant AND pu.product_id = p_product AND pu.unit_code = p_unit;

  IF num IS NULL THEN
    RAISE EXCEPTION 'product % has no conversion for unit %', p_product, p_unit
      USING ERRCODE = '22023';
  END IF;

  -- round() on numeric is half-up and exact; no float anywhere in this path.
  RETURN round(p_qty * num / den * power(10::numeric, scale))::bigint;
END
$$;

CREATE FUNCTION app.from_base(
  p_tenant uuid, p_product uuid, p_unit text, p_base bigint
) RETURNS numeric
LANGUAGE plpgsql STABLE AS $$
DECLARE
  num   bigint;
  den   bigint;
  scale smallint;
BEGIN
  SELECT pu.factor_numerator, pu.factor_denominator, p.base_scale
    INTO num, den, scale
    FROM app.product_unit pu
    JOIN app.product p ON p.tenant_id = pu.tenant_id AND p.id = pu.product_id
   WHERE pu.tenant_id = p_tenant AND pu.product_id = p_product AND pu.unit_code = p_unit;

  IF num IS NULL THEN
    RAISE EXCEPTION 'product % has no conversion for unit %', p_product, p_unit
      USING ERRCODE = '22023';
  END IF;

  RETURN (p_base::numeric / power(10::numeric, scale)) * den / num;
END
$$;

ALTER TABLE app.unit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.unit
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.product ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.product
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.product_unit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.product_unit
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
