-- 014: maintenance log for equipment (SPEC §9): equipment gets maintenance entries and next-due like trucks.
-- The shop logs work on a piece: types of work (each with an optional next-due date), what was done, parts, cost, who
-- or which vendor, notes, photos, and which open problems from equipment checks it fixed (those get resolved). An entry
-- is never edited or deleted: a mistaken one is voided with a reason, which reopens the problems it closed.

CREATE TABLE equipment_service_logs (
  id            serial        PRIMARY KEY,
  client_id     uuid          UNIQUE,                       -- generated on the phone; a retried save is a no-op
  equipment_id  integer       NOT NULL REFERENCES equipment(id),
  service_date  date          NOT NULL,
  work          jsonb         NOT NULL,                     -- [{type, next_due_date}], at least one
  description   text          NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  parts         text,
  cost          numeric(10,2) CHECK (cost IS NULL OR cost >= 0),
  performed_by  text,
  vendor        text,
  notes         text,
  created_by    integer       NOT NULL REFERENCES users(id),
  created_at    timestamptz   NOT NULL DEFAULT now(),
  voided_at     timestamptz,
  voided_by     integer       REFERENCES users(id),
  void_reason   text          CHECK (void_reason IS NULL OR length(void_reason) <= 600),
  CONSTRAINT equipment_service_work_list CHECK (jsonb_typeof(work) = 'array' AND jsonb_array_length(work) >= 1),
  CONSTRAINT equipment_service_void_recorded
    CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX equipment_service_logs_piece ON equipment_service_logs (equipment_id, service_date DESC);

-- An entry can only be voided, once; nothing else about it changes, and it can't be deleted.
CREATE FUNCTION equipment_service_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER equipment_service_logs_read_only BEFORE UPDATE OR DELETE ON equipment_service_logs
  FOR EACH ROW EXECUTE FUNCTION equipment_service_guard();

-- The open problems (from equipment checks) an entry fixed. resolved_here: this entry resolved it (so voiding the
-- entry reopens it); false when it was already resolved some other way.
CREATE TABLE equipment_service_repairs (
  service_log_id  integer NOT NULL REFERENCES equipment_service_logs(id),
  check_item_id   integer NOT NULL REFERENCES equipment_check_items(id),
  resolved_here   boolean NOT NULL,
  PRIMARY KEY (service_log_id, check_item_id)
);
CREATE INDEX equipment_service_repairs_item ON equipment_service_repairs (check_item_id);
CREATE TRIGGER equipment_service_repairs_read_only BEFORE UPDATE OR DELETE ON equipment_service_repairs
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- ---------- Photos on equipment maintenance entries ----------
ALTER TABLE photos ADD COLUMN equipment_service_log_id integer REFERENCES equipment_service_logs(id);
ALTER TABLE photos ADD CONSTRAINT photos_equipment_service_alone
  CHECK (equipment_service_log_id IS NULL OR (inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL
         AND registration_change_id IS NULL AND yard_inspection_id IS NULL AND equipment_check_id IS NULL));
CREATE INDEX photos_equipment_service ON photos (equipment_service_log_id) WHERE equipment_service_log_id IS NOT NULL;

-- Read-only and undeletable once attached to anything, now including an equipment maintenance entry. The same list of
-- owner columns is in src/photo-owners.ts.
CREATE OR REPLACE FUNCTION photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
      OR OLD.registration_change_id IS NOT NULL OR OLD.yard_inspection_id IS NOT NULL OR OLD.equipment_check_id IS NOT NULL
      OR OLD.equipment_service_log_id IS NOT NULL)
     AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'photo % is read-only once attached', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION photos_no_erase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
     OR OLD.registration_change_id IS NOT NULL OR OLD.yard_inspection_id IS NOT NULL OR OLD.equipment_check_id IS NOT NULL
     OR OLD.equipment_service_log_id IS NOT NULL THEN
    RAISE EXCEPTION 'photo % can''t be deleted once attached (nothing recorded is ever erased)', OLD.id;
  END IF;
  RETURN OLD;
END $$;
DROP INDEX photos_orphans;
CREATE INDEX photos_orphans ON photos (created_at)
  WHERE inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL AND registration_change_id IS NULL
    AND yard_inspection_id IS NULL AND equipment_check_id IS NULL AND equipment_service_log_id IS NULL;
