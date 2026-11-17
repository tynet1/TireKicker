-- 006: mark damage on file as repaired (SPEC §9). Damage marks stay read-only; a repair is its own record.
-- Two ways in: the shop logs a fix in the maintenance log (service_log_id set), or a supervisor marks it repaired
-- with a note. Either way a photo of the fixed area is required (checked by the app; the photo points at the repair).
-- Nothing is erased: voiding the maintenance entry, or a supervisor undoing a mistake, only ends the repair
-- (active = false, with who, when and why), which puts the damage back on file.

CREATE TABLE damage_repairs (
  id              serial      PRIMARY KEY,
  client_id       uuid        UNIQUE,                         -- phone-made id: a retried "mark repaired" is a no-op
  damage_mark_id  integer     NOT NULL REFERENCES damage_marks(id),
  service_log_id  integer     REFERENCES service_logs(id),    -- set when fixed through the maintenance log
  note            text        CHECK (note IS NULL OR length(note) <= 1000),
  repaired_at     timestamptz NOT NULL DEFAULT now(),
  repaired_by     integer     NOT NULL REFERENCES users(id),
  active          boolean     NOT NULL DEFAULT true,
  ended_at        timestamptz,
  ended_by        integer     REFERENCES users(id),
  end_reason      text        CHECK (end_reason IS NULL OR length(end_reason) <= 600),
  CONSTRAINT damage_repair_says_how CHECK (service_log_id IS NOT NULL OR length(btrim(coalesce(note, ''))) > 0),
  CONSTRAINT damage_repair_end_recorded CHECK (active OR (ended_at IS NOT NULL AND ended_by IS NOT NULL AND end_reason IS NOT NULL))
);
-- At most one current repair per damage mark; ended ones stay as history.
CREATE UNIQUE INDEX damage_repairs_one_active ON damage_repairs (damage_mark_id) WHERE active;
CREATE INDEX damage_repairs_entry ON damage_repairs (service_log_id) WHERE service_log_id IS NOT NULL;

-- The only change allowed is ending a repair (active true -> false, filling in ended_*). No deletes.
CREATE FUNCTION damage_repairs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'damage_repairs rows can''t be deleted (nothing recorded is ever erased)';
  END IF;
  IF NOT (OLD.active AND NOT NEW.active
          AND (to_jsonb(NEW) - 'active' - 'ended_at' - 'ended_by' - 'end_reason')
            = (to_jsonb(OLD) - 'active' - 'ended_at' - 'ended_by' - 'end_reason')) THEN
    RAISE EXCEPTION 'damage repair % is read-only (it can only be ended)', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER damage_repairs_read_only BEFORE UPDATE OR DELETE ON damage_repairs
  FOR EACH ROW EXECUTE FUNCTION damage_repairs_guard();

-- Photos of the fix point at the repair. A Log-fix photo also belongs to its maintenance entry; a supervisor's
-- photo belongs to the repair alone. An inspection photo never has either.
ALTER TABLE photos ADD COLUMN damage_repair_id integer REFERENCES damage_repairs(id);
ALTER TABLE photos DROP CONSTRAINT photos_one_parent;
ALTER TABLE photos ADD CONSTRAINT photos_one_parent
  CHECK (inspection_id IS NULL OR (service_log_id IS NULL AND damage_repair_id IS NULL));
CREATE INDEX photos_damage_repair ON photos (damage_repair_id) WHERE damage_repair_id IS NOT NULL;

-- Read-only and undeletable once attached to anything, now including a damage repair.
CREATE OR REPLACE FUNCTION photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL)
     AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'photo % is read-only once attached', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION photos_no_erase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL THEN
    RAISE EXCEPTION 'photo % can''t be deleted once attached (nothing recorded is ever erased)', OLD.id;
  END IF;
  RETURN OLD;
END $$;

-- Orphan clean-up only ever looks at photos attached to nothing.
DROP INDEX photos_orphans;
CREATE INDEX photos_orphans ON photos (created_at)
  WHERE inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL;
