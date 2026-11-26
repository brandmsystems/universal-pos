-- Seat position within the session, not an entity: there is no guest table and
-- this is deliberately NOT a foreign key. Guest 3 is where someone is sitting.
--
-- Nullable, and the null case is real: a shared appetiser belongs to nobody.
-- A by_guest split therefore CANNOT cover null-guest lines -- they need explicit
-- assignment at split time. "Who's paying for the shared starter" is a question
-- the table answers, not the software.
ALTER TABLE app.order_line
  ADD COLUMN guest_no smallint CHECK (guest_no IS NULL OR guest_no > 0);

CREATE INDEX order_line_by_guest_idx ON app.order_line (tenant_id, order_id, guest_no)
  WHERE guest_no IS NOT NULL;

-- Optimistic concurrency for the bump. Two cooks bumping the same ticket is
-- normal, not an error -- the second one is told to re-read.
ALTER TABLE app.kot_line
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);


-- Recall is a NEW ROW, not a state rewind. The food exists; going back to
-- 'preparing' would erase the fact that it was made, and the stock is already
-- deducted. Same reasoning as void: SUM over history must stay true.
CREATE TABLE app.kot_recall (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL,
  kot_id             uuid        NOT NULL,
  reason_id          uuid        NOT NULL,
  kind               text        NOT NULL DEFAULT 'recall'
                     CONSTRAINT kot_recall_kind_fixed CHECK (kind = 'recall'),
  note               text,
  recalled_by_user_id uuid       NOT NULL,
  recalled_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kot_recall_kot_fk
  FOREIGN KEY (tenant_id, kot_id) REFERENCES app.kot (tenant_id, id) ON DELETE RESTRICT,
  -- Scoped: only a reason declared for 'recall' may be used.
  CONSTRAINT kot_recall_reason_fk
  FOREIGN KEY (tenant_id, reason_id, kind)
    REFERENCES app.adjustment_reason_kind (tenant_id, reason_id, kind) ON DELETE RESTRICT,
  CONSTRAINT kot_recall_user_fk
  FOREIGN KEY (tenant_id, recalled_by_user_id) REFERENCES app.app_user (tenant_id, id) ON DELETE RESTRICT,
  -- One recall per ticket; a second recall of an already-recalled ticket is a bug.
  CONSTRAINT kot_recall_once_per_kot UNIQUE (tenant_id, kot_id)
);


-- kot.state is DERIVED from its lines, and stored rather than computed on read:
-- KDS is the most read-heavy surface in the product and it runs on a cheap tablet.
--
-- Two writable state fields on parent and child WILL disagree within one shift and
-- nobody will know which one the kitchen believed -- the same reasoning that ruled
-- out a separate kds_ticket table.
--
-- PRECEDENCE: state derives from the lines UNLESS a kot_recall row exists, which
-- wins. `recalled` is a ticket-level fact and is not derivable from lines, so
-- without this rule the derivation would fight the recall.
CREATE FUNCTION app.derive_kot_state(target_tenant uuid, target_kot uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  derived text;
BEGIN
  IF EXISTS (SELECT 1 FROM app.kot_recall
              WHERE tenant_id = target_tenant AND kot_id = target_kot) THEN
    derived := 'recalled';
  ELSE
    SELECT CASE
             WHEN count(*) = 0 THEN 'queued'
             WHEN count(*) FILTER (WHERE state <> 'cancelled') = 0 THEN 'cancelled'
             WHEN count(*) FILTER (WHERE state NOT IN ('served', 'cancelled')) = 0 THEN 'served'
             -- 'ready' only when EVERY live line is ready or beyond.
             WHEN count(*) FILTER (WHERE state IN ('queued', 'preparing')) = 0 THEN 'ready'
             -- ANY line past queued means work has started. Testing only for
             -- 'preparing' reported a ticket as queued when its one started item
             -- was already plated -- the expo would think nothing had begun.
             WHEN count(*) FILTER (WHERE state IN ('preparing', 'ready', 'served')) > 0
               THEN 'preparing'
             ELSE 'queued'
           END
      INTO derived
      FROM app.kot_line
     WHERE tenant_id = target_tenant AND kot_id = target_kot;
  END IF;

  PERFORM set_config('app.kot_state_derivation', 'on', true);
  UPDATE app.kot
     SET state = derived, version = version + 1
   WHERE tenant_id = target_tenant AND id = target_kot AND state IS DISTINCT FROM derived;
  PERFORM set_config('app.kot_state_derivation', 'off', true);
END
$$;

CREATE FUNCTION app.derive_kot_state_from_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.derive_kot_state(
    COALESCE(NEW.tenant_id, OLD.tenant_id),
    COALESCE(NEW.kot_id, OLD.kot_id));
  RETURN NULL;
END
$$;

CREATE TRIGGER kot_line_derives_ticket_state
  AFTER INSERT OR UPDATE OR DELETE ON app.kot_line
  FOR EACH ROW EXECUTE FUNCTION app.derive_kot_state_from_line();

CREATE FUNCTION app.derive_kot_state_from_recall() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.derive_kot_state(NEW.tenant_id, NEW.kot_id);
  RETURN NULL;
END
$$;

CREATE TRIGGER kot_recall_derives_ticket_state
  AFTER INSERT ON app.kot_recall
  FOR EACH ROW EXECUTE FUNCTION app.derive_kot_state_from_recall();

-- Makes "derived" true rather than merely intended: nothing but the derivation
-- may write this column, so it cannot become the second writable state field.
CREATE FUNCTION app.deny_manual_kot_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state
     AND COALESCE(current_setting('app.kot_state_derivation', true), 'off') <> 'on' THEN
    RAISE EXCEPTION
      'kot.state is derived from its lines (and from kot_recall). Advance the lines instead.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER kot_state_is_derived
  BEFORE UPDATE ON app.kot
  FOR EACH ROW EXECUTE FUNCTION app.deny_manual_kot_state();

ALTER TABLE app.kot_recall ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.kot_recall
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
