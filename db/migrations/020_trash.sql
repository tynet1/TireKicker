-- 020: the trash, and Delete forever (SPEC §4a).
-- Until now nothing recorded could ever be erased. Admins need test records, mistakes, personal information on request
-- and old records gone for good, by admins only, after a week in the trash. So:
--  * Delete puts a record in the trash. Inspections and incident reports keep using their state rows (005, 018);
--    yard walks, equipment checks, maintenance entries (truck and equipment), repair tickets, and retired trucks and
--    users with nothing on file get a row in `trash`. A record in the trash is out of every list and off the truck,
--    and Restore puts it back. Nothing is erased by putting it in the trash.
--  * After 7 days in the trash an admin can delete it forever: the record, everything that's only part of it, and its
--    photo and signature files. Every guard below still refuses a delete or a change, except inside that one admin
--    action, which starts with gc_begin_purge(): it checks the record has been in the trash for 7 days itself, so a bug
--    or a stray command can't erase anything sooner, or anything that isn't in the trash.
--  * Each permanent delete is written to purge_log: what kind of record, which truck, its date, why, who and when, and
--    how many rows and files went. Never the record's contents. The log itself can never be changed or erased.
-- Additive: no existing row changes.

-- ---------- The trash (for everything that has no state row of its own) ----------
CREATE TABLE trash (
  kind        text        NOT NULL CHECK (kind IN ('yard_walk', 'equipment_check', 'service_log', 'equipment_service',
                                                   'repair_ticket', 'vehicle', 'user')),
  record_id   text        NOT NULL,                         -- the record's id (a uuid or a number) as text
  reason      text        NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  deleted_at  timestamptz NOT NULL DEFAULT now(),
  deleted_by  integer     NOT NULL REFERENCES users(id),
  PRIMARY KEY (kind, record_id)
);
CREATE INDEX trash_deleted_at ON trash (deleted_at);

-- Every delete and restore, kept (a restore removes the trash row; this keeps that it was there).
CREATE TABLE trash_history (
  id          bigserial   PRIMARY KEY,
  kind        text        NOT NULL,
  record_id   text        NOT NULL,
  action      text        NOT NULL CHECK (action IN ('delete', 'restore')),
  reason      text,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  integer     NOT NULL REFERENCES users(id)
);
CREATE INDEX trash_history_record ON trash_history (kind, record_id, changed_at);

-- ---------- The log of permanent deletes ----------
CREATE TABLE purge_log (
  id               serial      PRIMARY KEY,
  kind             text        NOT NULL,                    -- inspection, incident, yard_walk, … (as in trash.kind)
  record_id        text        NOT NULL,
  title            text        NOT NULL,                    -- e.g. "Inspection · T101": what it was, not what it said
  truck_code       text,                                    -- the truck (or yard, trailer or equipment tag) it was about
  record_date      date,
  reason           text        NOT NULL,                    -- why it went in the trash
  deleted_at       timestamptz NOT NULL,                    -- when it went in the trash
  deleted_by_name  text,
  purged_at        timestamptz NOT NULL DEFAULT now(),
  purged_by        integer     NOT NULL,                    -- no foreign key: the log outlives the people in it
  purged_by_name   text        NOT NULL,
  removed          jsonb       NOT NULL DEFAULT '{}',       -- {"photos": 4, "checklist answers": 48, …}
  files            integer     NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX purge_log_once ON purge_log (kind, record_id);
CREATE INDEX purge_log_recent ON purge_log (purged_at DESC);

CREATE FUNCTION purge_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'purge_log rows can''t be % (the log of permanent deletes is kept for good)', lower(TG_OP) || 'd';
END $$;
CREATE TRIGGER purge_log_read_only BEFORE UPDATE OR DELETE ON purge_log FOR EACH ROW EXECUTE FUNCTION purge_log_guard();

-- ---------- The one way through the guards ----------
-- True only inside a transaction that called gc_begin_purge (set_config(…, true) ends with the transaction).
CREATE FUNCTION gc_purging() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('gc.purge', true), '') = 'on' $$;

-- Starts a permanent delete of one record: refuses unless it has been in the trash for 7 days. Locks the trash/state
-- row so a restore at the same moment waits. Returns when it went in the trash.
CREATE FUNCTION gc_begin_purge(p_kind text, p_id text) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE
  since timestamptz;
BEGIN
  IF p_kind = 'inspection' THEN
    SELECT changed_at INTO since FROM inspection_states
     WHERE inspection_id::text = p_id AND state = 'deleted' FOR UPDATE;
  ELSIF p_kind = 'incident' THEN
    SELECT changed_at INTO since FROM incident_states
     WHERE incident_id::text = p_id AND state = 'deleted' FOR UPDATE;
  ELSE
    SELECT deleted_at INTO since FROM trash WHERE kind = p_kind AND record_id = p_id FOR UPDATE;
  END IF;
  IF since IS NULL THEN
    RAISE EXCEPTION 'gc_not_in_trash: % % isn''t in the trash', p_kind, p_id USING ERRCODE = 'GC001';
  END IF;
  IF since > now() - interval '7 days' THEN
    RAISE EXCEPTION 'gc_not_ready: % % has been in the trash for less than 7 days', p_kind, p_id USING ERRCODE = 'GC002';
  END IF;
  PERFORM set_config('gc.purge', 'on', true);
  RETURN since;
END $$;

-- ---------- The guards, each now letting a permanent delete through (and nothing else) ----------
CREATE OR REPLACE FUNCTION refuse_erase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gc_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows can''t be % (only Delete forever, in Admin → Trash, erases a record)',
    TG_TABLE_NAME, lower(TG_OP) || 'd';
END $$;

CREATE OR REPLACE FUNCTION refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gc_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows can''t be % (maintenance entries are voided; only Delete forever erases one)',
    TG_TABLE_NAME, lower(TG_OP) || 'd';
END $$;

CREATE OR REPLACE FUNCTION photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gc_purging() THEN RETURN NEW; END IF;
  IF (OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
      OR OLD.registration_change_id IS NOT NULL OR OLD.yard_inspection_id IS NOT NULL OR OLD.equipment_check_id IS NOT NULL
      OR OLD.equipment_service_log_id IS NOT NULL OR OLD.incident_id IS NOT NULL)
     AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'photo % is read-only once attached', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION photos_no_erase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gc_purging() THEN RETURN OLD; END IF;
  IF OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
     OR OLD.registration_change_id IS NOT NULL OR OLD.yard_inspection_id IS NOT NULL OR OLD.equipment_check_id IS NOT NULL
     OR OLD.equipment_service_log_id IS NOT NULL OR OLD.incident_id IS NOT NULL THEN
    RAISE EXCEPTION 'photo % can''t be deleted once attached (only Delete forever, in Admin → Trash, erases it)', OLD.id;
  END IF;
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION damage_repairs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gc_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'damage_repairs rows can''t be deleted (only Delete forever erases a record)';
  END IF;
  IF NOT (OLD.active AND NOT NEW.active
          AND (to_jsonb(NEW) - 'active' - 'ended_at' - 'ended_by' - 'end_reason')
            = (to_jsonb(OLD) - 'active' - 'ended_at' - 'ended_by' - 'end_reason')) THEN
    RAISE EXCEPTION 'damage repair % is read-only (it can only be ended)', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION repair_tickets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gc_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'repair tickets can''t be deleted (void the ticket instead)';
  END IF;
  IF NOT (OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
          AND (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason')
            = (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason')) THEN
    RAISE EXCEPTION 'repair ticket % is read-only (it can only be voided)', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION yard_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gc_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'yard inspection items can''t be deleted (only Delete forever erases a record)';
  END IF;
  IF (to_jsonb(NEW) - 'resolved_at' - 'resolved_by' - 'resolution_note')
     <> (to_jsonb(OLD) - 'resolved_at' - 'resolved_by' - 'resolution_note') THEN
    RAISE EXCEPTION 'yard inspection item % is read-only (only its resolution can be recorded)', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION equipment_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gc_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'equipment check items can''t be deleted (only Delete forever erases a record)';
  END IF;
  IF (to_jsonb(NEW) - 'resolved_at' - 'resolved_by' - 'resolution_note')
     <> (to_jsonb(OLD) - 'resolved_at' - 'resolved_by' - 'resolution_note') THEN
    RAISE EXCEPTION 'equipment check item % is read-only (only its resolution can be recorded)', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION equipment_service_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gc_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'equipment maintenance entries can''t be deleted (void the entry instead)';
  END IF;
  IF NOT (OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
          AND (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason')
            = (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason')) THEN
    RAISE EXCEPTION 'equipment maintenance entry % is read-only (it can only be voided)', OLD.id;
  END IF;
  RETURN NEW;
END $$;

-- The trash history is kept like every other history (a permanent delete removes the record's own lines).
CREATE TRIGGER trash_history_read_only BEFORE UPDATE OR DELETE ON trash_history
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- ---------- Yard walks and equipment checks that count: not in the trash ----------
-- (`w.*` / `c.*` are fixed when the view is made; a later migration that adds a column must recreate the view.)
CREATE VIEW live_yard_inspections AS
SELECT w.* FROM yard_inspections w
 WHERE NOT EXISTS (SELECT 1 FROM trash t WHERE t.kind = 'yard_walk' AND t.record_id = w.id::text);

CREATE VIEW live_equipment_checks AS
SELECT c.* FROM equipment_checks c
 WHERE NOT EXISTS (SELECT 1 FROM trash t WHERE t.kind = 'equipment_check' AND t.record_id = c.id::text);
