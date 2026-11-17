-- 008: supervisors update a truck's registration expiration from an inspection, the sign-off screen or the truck page
-- (SPEC §9). Until now an admin edit just overwrote the old date. Every change is now kept, with who, when, where it
-- was made from and an optional photo of the new registration or sticker, so the date that was on file for any past
-- inspection can be shown on its PDF. Nothing here is ever edited or erased.

CREATE TABLE registration_changes (
  id             serial      PRIMARY KEY,
  client_id      uuid        UNIQUE,                          -- phone-made id: a retried update is a no-op
  vehicle_id     integer     NOT NULL REFERENCES vehicles(id),
  previous       date,                                        -- what was on file before (null = nothing)
  expires        date,                                        -- what it was changed to
  changed_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     integer     REFERENCES users(id),            -- null only for a change made outside the app
  source         text        NOT NULL CHECK (source IN ('form', 'sign-off', 'truck', 'admin', 'other')),
  inspection_id  uuid        REFERENCES inspections(id),      -- updated while signing off this inspection
  note           text        CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT registration_change_from_signoff CHECK ((source = 'sign-off') = (inspection_id IS NOT NULL))
);
CREATE INDEX registration_changes_vehicle ON registration_changes (vehicle_id, changed_at);
CREATE INDEX registration_changes_inspection ON registration_changes (inspection_id) WHERE inspection_id IS NOT NULL;

CREATE TRIGGER registration_changes_read_only BEFORE UPDATE OR DELETE ON registration_changes
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- Safety net: the app records each change itself (with who and why) in the same transaction, before updating the
-- truck. A change made any other way (by hand in SQL, a future import) is still recorded here, so the history
-- never has a gap.
CREATE FUNCTION vehicles_registration_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.registration_expires IS DISTINCT FROM OLD.registration_expires AND NOT EXISTS (
       SELECT 1 FROM registration_changes r
        WHERE r.vehicle_id = NEW.id AND r.changed_at = now()
          AND r.previous IS NOT DISTINCT FROM OLD.registration_expires
          AND r.expires IS NOT DISTINCT FROM NEW.registration_expires) THEN
    INSERT INTO registration_changes (vehicle_id, previous, expires, source)
    VALUES (NEW.id, OLD.registration_expires, NEW.registration_expires, 'other');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vehicles_registration_history AFTER UPDATE OF registration_expires ON vehicles
  FOR EACH ROW EXECUTE FUNCTION vehicles_registration_history();

-- An optional photo of the new registration or sticker belongs to the change alone.
ALTER TABLE photos ADD COLUMN registration_change_id integer REFERENCES registration_changes(id);
ALTER TABLE photos ADD CONSTRAINT photos_registration_alone
  CHECK (registration_change_id IS NULL OR (inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL));
CREATE INDEX photos_registration_change ON photos (registration_change_id) WHERE registration_change_id IS NOT NULL;

-- Read-only and undeletable once attached to anything, now including a registration change.
CREATE OR REPLACE FUNCTION photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
      OR OLD.registration_change_id IS NOT NULL)
     AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'photo % is read-only once attached', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION photos_no_erase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL OR OLD.damage_repair_id IS NOT NULL
     OR OLD.registration_change_id IS NOT NULL THEN
    RAISE EXCEPTION 'photo % can''t be deleted once attached (nothing recorded is ever erased)', OLD.id;
  END IF;
  RETURN OLD;
END $$;

-- Orphan clean-up only ever looks at photos attached to nothing.
DROP INDEX photos_orphans;
CREATE INDEX photos_orphans ON photos (created_at)
  WHERE inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL AND registration_change_id IS NULL;
