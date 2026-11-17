-- Phase 2: the shop's maintenance log, built on service_logs from 001.
-- Data safety (SPEC §4a): entries are never deleted (voided instead), every edit keeps the previous version,
-- and photos attached to an entry are read-only.

-- ---------- Shop manager role ----------
-- The new value isn't used anywhere in this migration (Postgres doesn't allow that in the same transaction).
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'shop' BEFORE 'supervisor';

-- ---------- Maintenance entries ----------
ALTER TABLE service_logs
  ADD COLUMN client_id        uuid UNIQUE,                    -- generated on the phone; makes retried saves idempotent
  ADD COLUMN category         text NOT NULL DEFAULT 'other',  -- oil_change, tires, brakes, repair, preventive, inspection, other
  ADD COLUMN parts            text,
  ADD COLUMN vendor           text,                           -- outside shop, when the work wasn't done in-house
  ADD COLUMN notes            text,
  ADD COLUMN next_due_mileage integer,
  ADD COLUMN next_due_date    date,
  ADD COLUMN created_by       integer REFERENCES users(id),
  ADD COLUMN updated_at       timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by       integer REFERENCES users(id),
  ADD COLUMN version          integer NOT NULL DEFAULT 1,     -- bumps on every edit; stale edits are refused
  ADD COLUMN voided_at        timestamptz,
  ADD COLUMN voided_by        integer REFERENCES users(id),
  ADD COLUMN void_reason      text,
  ADD CONSTRAINT service_logs_category_ok CHECK (category ~ '^[a-z_]{1,30}$'),
  ADD CONSTRAINT service_logs_mileage_ok CHECK (mileage IS NULL OR mileage >= 0),
  ADD CONSTRAINT service_logs_next_mileage_ok CHECK (next_due_mileage IS NULL OR next_due_mileage >= 0),
  ADD CONSTRAINT service_logs_cost_ok CHECK (cost IS NULL OR cost >= 0),
  ADD CONSTRAINT service_logs_void_has_reason CHECK (voided_at IS NULL OR void_reason IS NOT NULL);

COMMENT ON COLUMN service_logs.inspection_item_id IS 'Not used; repairs an entry fixed are in service_log_repairs.';

CREATE INDEX service_logs_vehicle ON service_logs (vehicle_id, service_date DESC, id DESC);
CREATE INDEX service_logs_recent ON service_logs (created_at DESC);

-- Repair items (from inspections) an entry fixed. An item is fixed by at most one active entry.
-- resolved_here: this entry closed the item, so voiding the entry reopens it (and the link goes inactive).
CREATE TABLE service_log_repairs (
  service_log_id     integer NOT NULL REFERENCES service_logs(id),
  inspection_item_id integer NOT NULL REFERENCES inspection_items(id),
  resolved_here      boolean NOT NULL DEFAULT false,
  active             boolean NOT NULL DEFAULT true,
  PRIMARY KEY (service_log_id, inspection_item_id)
);
CREATE UNIQUE INDEX service_log_repairs_one_fix ON service_log_repairs (inspection_item_id) WHERE active;

-- The previous version of an entry, saved on every edit.
CREATE TABLE service_log_history (
  id              bigserial   PRIMARY KEY,
  service_log_id  integer     NOT NULL REFERENCES service_logs(id),
  changed_at      timestamptz NOT NULL DEFAULT now(),
  changed_by      integer     REFERENCES users(id),
  old_row         jsonb       NOT NULL
);
CREATE INDEX service_log_history_log ON service_log_history (service_log_id, id);

CREATE FUNCTION service_logs_keep_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.vehicle_id <> OLD.vehicle_id OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'maintenance entry %: the truck, creator and client id can''t change', OLD.id;
  END IF;
  INSERT INTO service_log_history (service_log_id, changed_by, old_row) VALUES (OLD.id, NEW.updated_by, to_jsonb(OLD));
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER service_logs_history BEFORE UPDATE ON service_logs
  FOR EACH ROW EXECUTE FUNCTION service_logs_keep_history();

CREATE FUNCTION refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows can''t be % (maintenance entries are voided, never deleted)', TG_TABLE_NAME, lower(TG_OP) || 'd';
END $$;
CREATE TRIGGER service_logs_no_delete BEFORE DELETE ON service_logs
  FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER service_log_repairs_no_delete BEFORE DELETE ON service_log_repairs
  FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER service_log_history_read_only BEFORE UPDATE OR DELETE ON service_log_history
  FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- ---------- Photos on maintenance entries (receipts, parts, the finished work) ----------
ALTER TABLE photos
  ADD COLUMN service_log_id integer REFERENCES service_logs(id),
  ADD CONSTRAINT photos_one_parent CHECK (inspection_id IS NULL OR service_log_id IS NULL);
CREATE INDEX photos_service_log ON photos (service_log_id) WHERE service_log_id IS NOT NULL;

-- A photo is read-only once attached to an inspection or a maintenance entry.
CREATE OR REPLACE FUNCTION photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL)
     AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'photo % is read-only once attached', OLD.id;
  END IF;
  RETURN NEW;
END $$;

-- Orphan cleanup must never touch photos that belong to a maintenance entry.
DROP INDEX photos_orphans;
CREATE INDEX photos_orphans ON photos (created_at) WHERE inspection_id IS NULL AND service_log_id IS NULL;
