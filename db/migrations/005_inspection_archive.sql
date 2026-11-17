-- 005: archive or delete inspections, without touching the read-only inspection rows (SPEC §9, §4a).
-- An inspection is "live" unless it's archived or deleted. Archived and deleted inspections drop out of the lists and
-- off the truck (open repairs, damage on file, last inspection, mileage checks) and come back when un-archived or
-- restored. Nothing here can be erased: the state row can't be deleted and every change is kept as history.
-- Also: the database now refuses to delete inspections (and their answers, damage marks and attached photos) outright.

CREATE TABLE inspection_states (
  inspection_id  uuid        PRIMARY KEY REFERENCES inspections(id),
  state          text        NOT NULL CHECK (state IN ('active', 'archived', 'deleted')),
  reason         text        CHECK (reason IS NULL OR length(reason) <= 500),
  changed_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     integer     NOT NULL REFERENCES users(id),
  CONSTRAINT deleted_needs_reason CHECK (state <> 'deleted' OR length(btrim(coalesce(reason, ''))) > 0)
);
CREATE INDEX inspection_states_not_active ON inspection_states (state) WHERE state <> 'active';

CREATE TABLE inspection_state_history (
  id             bigserial   PRIMARY KEY,
  inspection_id  uuid        NOT NULL REFERENCES inspections(id),
  action         text        NOT NULL CHECK (action IN ('archive', 'unarchive', 'delete', 'restore')),
  reason         text,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     integer     NOT NULL REFERENCES users(id)
);
CREATE INDEX inspection_state_history_inspection ON inspection_state_history (inspection_id, changed_at);

CREATE FUNCTION refuse_erase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows can''t be % (nothing recorded is ever erased; archive or delete the inspection in the app instead)',
    TG_TABLE_NAME, lower(TG_OP) || 'd';
END $$;
CREATE TRIGGER inspection_states_no_delete BEFORE DELETE ON inspection_states
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();
CREATE TRIGGER inspection_state_history_read_only BEFORE UPDATE OR DELETE ON inspection_state_history
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- Submitted inspections were already read-only (002), but a plain DELETE still worked and cascaded to the checklist
-- answers, damage marks and photo records. Refuse it at the database, so nothing is lost even by hand in SQL.
CREATE TRIGGER inspections_no_delete BEFORE DELETE ON inspections
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();
CREATE TRIGGER inspection_items_no_delete BEFORE DELETE ON inspection_items
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();
CREATE TRIGGER damage_marks_no_delete BEFORE DELETE ON damage_marks
  FOR EACH ROW EXECUTE FUNCTION refuse_erase();

-- Photos: attached ones (to an inspection or a maintenance entry) can't be deleted either. Uploads that were never
-- attached stay deletable, so the orphan clean-up keeps working.
CREATE FUNCTION photos_no_erase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.inspection_id IS NOT NULL OR OLD.service_log_id IS NOT NULL THEN
    RAISE EXCEPTION 'photo % can''t be deleted once attached (nothing recorded is ever erased)', OLD.id;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER photos_no_delete BEFORE DELETE ON photos
  FOR EACH ROW EXECUTE FUNCTION photos_no_erase();

-- Inspections that count: not archived, not deleted.
-- NOTE: `i.*` is fixed when the view is created. A later migration that adds a column to inspections must
-- CREATE OR REPLACE this view (appending the column) if live_inspections should have it.
CREATE VIEW live_inspections AS
SELECT i.* FROM inspections i
 WHERE NOT EXISTS (SELECT 1 FROM inspection_states s WHERE s.inspection_id = i.id AND s.state <> 'active');

-- Same columns as before (003), but only live inspections count for the last inspection and open repairs.
CREATE OR REPLACE VIEW vehicle_status AS
SELECT v.id, v.truck_code, v.year, v.make, v.model, v.plate, v.registration_expires,
       (v.registration_expires < current_date) AS registration_expired,
       li.id AS last_inspection_id, li.inspection_date AS last_inspection_date,
       (SELECT count(*) FROM inspection_items ii
          JOIN live_inspections i ON i.id = ii.inspection_id
         WHERE i.vehicle_id = v.id AND ii.result = 'repair' AND ii.resolved_at IS NULL) AS open_repairs,
       v.unit, v.vin, v.pulls_trailer, v.diagram_id,
       li.mileage AS last_mileage,
       li.status  AS last_status,
       v.trailer_diagram_id
FROM vehicles v
LEFT JOIN LATERAL (
  SELECT id, inspection_date, mileage, status FROM live_inspections
   WHERE vehicle_id = v.id ORDER BY inspection_date DESC, created_at DESC LIMIT 1
) li ON true
WHERE v.active;
